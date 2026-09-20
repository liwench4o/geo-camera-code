import type { CameraView, CustomObject } from '../interfaces';
import { WebMercatorViewport } from '@deck.gl/core';
import {
  getRenderQueryContract,
  isKnownRenderQueryId,
  type CameraEnvelopeProducer,
  type SelectionMode,
} from '../visualization/camera-contract';
import { buildSceneMetricContext, deriveCameraCalibrationDigest } from '../visualization/envelope-producer-contract';
import { produceSnapshotEnvelope } from '../visualization/envelope-producers';
import { getAccessorById } from '../visualization/registry';
import type { ResolvedLayerRuntime } from '../visualization/types';
import { attachSnapshotEnvelope } from './geometry/camera-target-adapter';
import { digestCanonical } from './geometry/canonical-digest';
import { getWrappedExtent } from './geometry/geo-wrap';
import type { SnapshotEnvelope } from './geometry/types';
import {
  resolveSelectionSnapshot,
  type RenderQuerySnapshotInput,
  type ResolvedSelectionMarkInput,
  type SelectionResolutionRegistry,
} from './selection-query';
import type { SelectionMember } from './selection-state';
import type { CameraTarget, LngLat, ViewportSize } from './types';
import { isFiniteCameraView } from './viewport';

export type ShadowSelectionEnvelopeSkipReason =
  | 'renderer-evidence-required'
  | 'missing-layer'
  | 'ambiguous-layer'
  | 'missing-query-contract'
  | 'empty-selection'
  | 'invalid-selection'
  | 'envelope-unavailable';

export type ShadowSelectionEnvelopeResult =
  | { status: 'attached'; target: CameraTarget; envelope: SnapshotEnvelope; detail: string }
  | { status: 'skipped'; target: CameraTarget; reason: ShadowSelectionEnvelopeSkipReason; detail: string };

export interface ShadowSelectionEnvelopeInput {
  target: CameraTarget;
  resolvedLayers: readonly ResolvedLayerRuntime[];
  expectedProducer: CameraEnvelopeProducer;
  selectionMode: SelectionMode;
  marks: readonly CustomObject[];
  heatmapQueryPoint?: [number, number];
  referenceView: CameraView;
  viewport: ViewportSize;
}

function skipped(
  input: ShadowSelectionEnvelopeInput,
  reason: ShadowSelectionEnvelopeSkipReason,
  detail: string,
): ShadowSelectionEnvelopeResult {
  return { status: 'skipped', target: input.target, reason, detail };
}

function selectionSource(mode: SelectionMode): SelectionMember['source'] {
  if (mode === 'region') return 'drawn-region';
  if (mode === 'map-click') return 'heatmap-zone';
  if (mode === 'path') return 'data-path';
  return 'click-object';
}

function semanticView(view: CameraView) {
  return {
    longitude: view.longitude,
    latitude: view.latitude,
    zoom: view.zoom,
    pitch: view.pitch,
    bearing: view.bearing,
    ...(view.altitude === undefined ? {} : { altitude: view.altitude }),
  };
}

function fullTripMetricReference(input: ShadowSelectionEnvelopeInput, runtime: ResolvedLayerRuntime) {
  const support = runtime.descriptor.resolvedSupport;
  if (support.producer !== 'trip-path') return undefined;
  if (!isFiniteCameraView(input.referenceView, input.viewport))
    throw new Error('Trip selection requires a valid source camera projection.');
  const accessor = getAccessorById(support.pathAccessorId);
  if (!accessor) throw new Error('The rendered trip path accessor is unavailable.');
  const coordinates: LngLat[] = [];
  for (const mark of input.marks) {
    const path = accessor(mark);
    if (!Array.isArray(path) || path.length < 2) throw new Error('The rendered trip path is incomplete.');
    for (const point of path) {
      if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]))
        throw new Error('The rendered trip path contains invalid coordinates.');
      coordinates.push([point[0], point[1]]);
    }
  }
  const extent = getWrappedExtent(coordinates);
  // A trip envelope intentionally contains its entire route, even when picking sees only
  // the current trail. Compute reference metrics in a declared full-route plan view so
  // offscreen vertices are not rejected by the picked camera's pitched near/far planes.
  // The producer still validates and projects every original renderer support primitive.
  const fitted = new WebMercatorViewport({ ...input.viewport, pitch: 0, bearing: 0 }).fitBounds(
    [
      [extent.minLng, extent.minLat],
      [extent.maxLng, extent.maxLat],
    ],
    { padding: Math.min(input.viewport.width, input.viewport.height) * 0.15, maxZoom: 16 },
  );
  return { longitude: fitted.longitude, latitude: fitted.latitude, zoom: fitted.zoom, pitch: 0, bearing: 0 };
}

function certifyCompleteHeatmapHalo(
  input: ShadowSelectionEnvelopeInput,
  runtime: ResolvedLayerRuntime,
): { status: 'ok'; haloRadiusPixels: number } | { status: 'error'; detail: string } {
  if (input.selectionMode !== 'map-click' || !input.heatmapQueryPoint) {
    return { status: 'error', detail: 'heatmap shadow attachment requires an exact map-click query point' };
  }
  const support = runtime.descriptor.resolvedSupport;
  if (support.producer !== 'heatmap-kernel') {
    return { status: 'error', detail: 'resolved layer is not a heatmap producer' };
  }
  if (!input.heatmapQueryPoint.every(Number.isFinite)) {
    return { status: 'error', detail: 'heatmap query point must be finite' };
  }
  const positionAccessor = getAccessorById(support.positionAccessorId);
  if (!positionAccessor) {
    return { status: 'error', detail: 'heatmap position accessor is unavailable' };
  }
  const runtimeRows = new Set(runtime.data);
  if (input.marks.some((mark) => !runtimeRows.has(mark))) {
    return { status: 'error', detail: 'heatmap evidence contains a mark outside the resolved runtime data' };
  }
  try {
    const projection = new WebMercatorViewport({
      ...semanticView(input.referenceView),
      ...input.viewport,
    });
    const queryPixel = projection.project(input.heatmapQueryPoint);
    const selected = new Set(input.marks);
    for (const row of runtime.data) {
      const position = positionAccessor(row);
      if (
        !Array.isArray(position) ||
        position.length < 2 ||
        !Number.isFinite(Number(position[0])) ||
        !Number.isFinite(Number(position[1]))
      ) {
        return { status: 'error', detail: 'heatmap runtime data contains an unprojectable position' };
      }
      const pixel = projection.project([Number(position[0]), Number(position[1])]);
      if (Math.hypot(pixel[0] - queryPixel[0], pixel[1] - queryPixel[1]) <= support.radiusPixels + 1e-6) {
        if (!selected.has(row)) {
          return { status: 'error', detail: 'heatmap contributor halo is incomplete for the resolved renderer query' };
        }
      }
    }
    return { status: 'ok', haloRadiusPixels: support.radiusPixels };
  } catch (error) {
    return {
      status: 'error',
      detail: error instanceof Error ? error.message : 'heatmap contributor halo projection failed',
    };
  }
}

export function attachRendererSelectionEnvelope(input: ShadowSelectionEnvelopeInput): ShadowSelectionEnvelopeResult {
  if (input.expectedProducer === 'hexagon-cell') {
    return skipped(
      input,
      'renderer-evidence-required',
      'hexagon shadow snapshots require a renderer-captured common-space cell footprint',
    );
  }
  if (input.marks.length === 0) {
    return skipped(input, 'empty-selection', 'selection contains no renderer source objects');
  }

  const candidates = input.resolvedLayers.filter(
    (runtime) =>
      runtime.descriptor.resolvedSupport.producer === input.expectedProducer &&
      runtime.descriptor.selection?.supported.includes(input.selectionMode),
  );
  if (candidates.length === 0) {
    return skipped(
      input,
      'missing-layer',
      `no resolved ${input.expectedProducer} layer supports ${input.selectionMode}`,
    );
  }
  if (candidates.length !== 1) {
    return skipped(input, 'ambiguous-layer', `multiple resolved ${input.expectedProducer} layers match the selection`);
  }

  const runtime = candidates[0];
  const queryId = runtime.descriptor.selection?.renderQueryId;
  if (!isKnownRenderQueryId(queryId)) {
    return skipped(input, 'missing-query-contract', `${input.expectedProducer} selection has no registered query`);
  }
  const queryContract = getRenderQueryContract(queryId);
  if (
    !queryContract ||
    queryContract.producer !== input.expectedProducer ||
    !(queryContract.supported as readonly string[]).includes(input.selectionMode)
  ) {
    return skipped(input, 'missing-query-contract', `${queryId} does not certify this producer and selection mode`);
  }
  const heatmapCertification =
    input.expectedProducer === 'heatmap-kernel' ? certifyCompleteHeatmapHalo(input, runtime) : undefined;
  if (heatmapCertification?.status === 'error') {
    return skipped(input, 'renderer-evidence-required', heatmapCertification.detail);
  }

  try {
    const descriptor = runtime.descriptor;
    const tripMetricReference = fullTripMetricReference(input, runtime);
    const identity = {
      schema: 'shadow-selection-scene-v1',
      targetId: input.target.id,
      resolvedLayerDigest: descriptor.resolvedLayerDigest,
      referenceView: semanticView(input.referenceView),
      ...(tripMetricReference ? { metricReference: { kind: 'full-trip-route-v1', view: tripMetricReference } } : {}),
      viewport: input.viewport,
    };
    const sceneRevision = `shadow-scene:${digestCanonical(identity)}`;
    const selectionId = `shadow-selection:${digestCanonical({ ...identity, queryId, marks: input.marks })}`;
    const member: SelectionMember = {
      id: selectionId,
      pinned: false,
      source: selectionSource(input.selectionMode),
      status: 'current',
      operation: 'idle',
      provenance: {
        datasetId: descriptor.datasetId,
        visualizationId: descriptor.visualizationId,
        layerId: descriptor.layerId,
        dataRevision: descriptor.dataRevision,
        visualizationRevision: descriptor.visualizationRevision,
        producerId: descriptor.cameraEnvelope.producer,
        producerVersion: descriptor.cameraEnvelope.producerVersion,
      },
      binding: {
        kind: 'render-query',
        queryId,
        params: { targetId: input.target.id },
        rebindCapability: 'query',
      },
    };
    const resolvedMarks: ResolvedSelectionMarkInput[] = input.marks.map((object) => ({
      kind: 'source-object',
      object,
    }));
    const query: RenderQuerySnapshotInput = {
      schemaVersion: 1,
      queryId,
      sceneRevision,
      dataRevision: descriptor.dataRevision,
      resolvedLayerDigest: descriptor.resolvedLayerDigest,
      marks: resolvedMarks,
      ...(descriptor.resolvedSupport.producer === 'heatmap-kernel'
        ? {
            certification: {
              kind: 'heatmap-halo-complete-v1' as const,
              haloRadiusPixels: heatmapCertification?.haloRadiusPixels ?? 0,
              contributorSet: 'complete' as const,
            },
          }
        : {}),
    };
    const registry: SelectionResolutionRegistry = {
      resolveFeatureRefs: () => ({ status: 'unsupported', reason: 'shadow selection uses a render query' }),
      resolveRenderQuery: () => ({ status: 'ok', value: query }),
    };
    const selection = resolveSelectionSnapshot(
      member,
      { selectionSceneRevision: sceneRevision, expectedSceneRevision: sceneRevision },
      runtime,
      registry,
    );
    if (selection.status !== 'ok') {
      return skipped(input, 'invalid-selection', selection.reason);
    }

    const calibrationDigest = deriveCameraCalibrationDigest(descriptor.cameraCalibration);
    const sceneContext = buildSceneMetricContext({
      schemaVersion: 1,
      sceneRevision,
      sceneContextRevision: `shadow-scene-context:${digestCanonical(identity)}`,
      projectedFrameRevision: `shadow-projected-frame:${digestCanonical({ ...identity, viewport: input.viewport })}`,
      cameraCalibrationDigest: calibrationDigest,
      sceneSupportDigest: `shadow-viewport-support:${digestCanonical(input.viewport)}`,
      referenceView: tripMetricReference ?? semanticView(input.referenceView),
      referenceViewport: { ...input.viewport },
      projectionOptions: { meterSupportTolerancePx: 0.25, meterSupportIntervalBudget: 16_384 },
      sceneCertifiedFootprintBounds: [{ minX: 0, minY: 0, maxX: input.viewport.width, maxY: input.viewport.height }],
    });
    const envelope = produceSnapshotEnvelope({
      runtime,
      selection: selection.value,
      sceneMetricContext: sceneContext,
      productionPolicyId: 'strict-envelope-v1',
    });
    if (envelope.status !== 'ok') {
      return skipped(input, 'envelope-unavailable', envelope.reason);
    }
    if (envelope.value.supportGuarantee === 'legacy-approximation') {
      return skipped(input, 'envelope-unavailable', 'shadow selection refused a legacy approximation envelope');
    }
    return {
      status: 'attached',
      target: attachSnapshotEnvelope(input.target, envelope.value),
      envelope: envelope.value,
      detail: `${input.expectedProducer} renderer snapshot attached`,
    };
  } catch (error) {
    return skipped(
      input,
      'invalid-selection',
      error instanceof Error ? error.message : 'selection envelope attachment failed',
    );
  }
}
