import type { CustomObject } from '../interfaces';
import type { VisualPrimitive } from '../camera/geometry/types';
import type { ResolvedSelectionMarkInput } from '../camera/selection-query';
import { resolveSelectionSnapshot, type SelectionResolutionRegistry } from '../camera/selection-query';
import type { GeoJsonGeometry, SelectionMember } from '../camera/selection-state';
import { getVisualizationDefaultParams, visualizationCatalog } from './catalog';
import type { RenderQueryId } from './camera-contract';
import {
  buildSceneMetricContext,
  deriveCameraCalibrationDigest,
  type SceneMetricContext,
} from './envelope-producer-contract';
import { envelopeProducerRegistry, produceSnapshotEnvelope } from './envelope-producers';
import { resolveLayerDescriptor } from './resolved-layer';
import type {
  ResolveLayerDescriptorInput,
  ResolvedLayerRuntime,
  VisualizationLayerValue,
  VisualizationParameterValue,
} from './types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function coordinatesAlmostEqual(
  actual: readonly (readonly [number, number])[],
  expected: readonly (readonly [number, number])[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every(
      (coordinate, index) =>
        Math.abs(coordinate[0] - expected[index][0]) <= 1e-12 && Math.abs(coordinate[1] - expected[index][1]) <= 1e-12,
    )
  );
}

function clone<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

interface RuntimeOptions {
  params?: Record<string, VisualizationParameterValue>;
  props?: Record<string, VisualizationLayerValue>;
  runtimeDerivedProps?: Record<string, unknown>;
}

function runtime(
  visualizationId: string,
  layerId: string,
  data: readonly CustomObject[],
  options: RuntimeOptions = {},
): ResolvedLayerRuntime {
  const visualization = clone(
    visualizationCatalog.visualizations.find((candidate) => candidate.id === visualizationId),
  );
  assert(visualization, `missing visualization ${visualizationId}`);
  const layer = visualization.layers.find((candidate) => candidate.id === layerId);
  assert(layer, `missing layer ${visualizationId}:${layerId}`);
  layer.props = { ...(layer.props ?? {}), ...(options.props ?? {}) };
  const dataset = clone(visualizationCatalog.datasets.find((candidate) => candidate.id === visualization.datasetId));
  assert(dataset, `missing dataset ${visualization.datasetId}`);
  const dataFile = dataset.files.find((candidate) => candidate.id === layer.dataRef);
  assert(dataFile, `missing data file ${layer.dataRef}`);
  const params = { ...getVisualizationDefaultParams(visualization), ...(options.params ?? {}) };
  const input: ResolveLayerDescriptorInput = {
    catalogRevision: visualizationCatalog.revision,
    visualization,
    dataset,
    dataFile,
    dataRevision: dataFile.revision,
    layer,
    rowCount: data.length,
    params,
    state: { animationTime: 25 },
    runtimeDerivedProps: options.runtimeDerivedProps,
  };
  return { descriptor: resolveLayerDescriptor(input), data };
}

function member(runtimeValue: ResolvedLayerRuntime, binding: SelectionMember['binding']): SelectionMember {
  const descriptor = runtimeValue.descriptor;
  return {
    id: 'selection-1',
    pinned: false,
    source: binding.kind === 'drawn-geometry' ? 'drawn-region' : 'click-object',
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
    binding,
  };
}

function querySelection(
  runtimeValue: ResolvedLayerRuntime,
  queryId: RenderQueryId,
  marks: ResolvedSelectionMarkInput[],
  certification?: {
    kind: 'heatmap-halo-complete-v1';
    haloRadiusPixels: number;
    contributorSet: 'complete';
  },
  params: unknown = {},
) {
  const selectionMember = member(runtimeValue, {
    kind: 'render-query',
    queryId,
    params,
    rebindCapability: 'query',
  });
  const query = {
    schemaVersion: 1 as const,
    queryId,
    sceneRevision: 'scene-1',
    dataRevision: runtimeValue.descriptor.dataRevision,
    resolvedLayerDigest: runtimeValue.descriptor.resolvedLayerDigest,
    marks,
    ...(certification === undefined ? {} : { certification }),
  };
  const registry: SelectionResolutionRegistry = {
    resolveFeatureRefs: () => ({ status: 'unsupported', reason: 'not a feature selection' }),
    resolveRenderQuery: () => ({ status: 'ok', value: query }),
  };
  const result = resolveSelectionSnapshot(
    selectionMember,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    runtimeValue,
    registry,
  );
  assert(result.status === 'ok', `query selection should resolve: ${result.status === 'ok' ? '' : result.reason}`);
  return result.value;
}

function featureSelection(runtimeValue: ResolvedLayerRuntime, objects: readonly CustomObject[]) {
  const selectionMember = member(runtimeValue, {
    kind: 'feature-refs',
    featureIds: objects.map((object, index) => String(object.id ?? `object-${index}`)),
    rebindCapability: 'stable-id',
  });
  const registry: SelectionResolutionRegistry = {
    resolveFeatureRefs: () => ({ status: 'ok', value: objects }),
    resolveRenderQuery: () => ({ status: 'unsupported', reason: 'not a query selection' }),
  };
  const result = resolveSelectionSnapshot(
    selectionMember,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    runtimeValue,
    registry,
  );
  assert(result.status === 'ok', `feature selection should resolve: ${result.status === 'ok' ? '' : result.reason}`);
  return result.value;
}

function drawnSelection(
  runtimeValue: ResolvedLayerRuntime,
  geometry: GeoJsonGeometry,
  marks: ResolvedSelectionMarkInput[],
  certification?: {
    kind: 'heatmap-halo-complete-v1';
    haloRadiusPixels: number;
    contributorSet: 'complete';
  },
  wrapMode: 'minimum-arc' | 'full-world' = 'minimum-arc',
) {
  const selectionMember = member(runtimeValue, {
    kind: 'drawn-geometry',
    geometry,
    wrapMode,
    rebindCapability: 'query',
  });
  const registry: SelectionResolutionRegistry = {
    resolveFeatureRefs: () => ({ status: 'unsupported', reason: 'not a feature selection' }),
    resolveRenderQuery: () => ({ status: 'unsupported', reason: 'not a render query' }),
    resolveDrawnGeometryMarks: () => ({
      status: 'ok',
      value: {
        schemaVersion: 1,
        resolverId: 'drawn-association-v1',
        sceneRevision: 'scene-1',
        dataRevision: runtimeValue.descriptor.dataRevision,
        resolvedLayerDigest: runtimeValue.descriptor.resolvedLayerDigest,
        marks,
        ...(certification === undefined ? {} : { certification }),
      },
    }),
  };
  const result = resolveSelectionSnapshot(
    selectionMember,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    runtimeValue,
    registry,
  );
  assert(result.status === 'ok', `drawn selection should resolve: ${result.status === 'ok' ? '' : result.reason}`);
  return result.value;
}

function scene(
  runtimeValue: ResolvedLayerRuntime,
  center: [number, number],
  sceneRevision = 'scene-1',
): SceneMetricContext {
  const descriptor = runtimeValue.descriptor;
  return buildSceneMetricContext({
    schemaVersion: 1,
    sceneRevision,
    sceneContextRevision: 'scene-context-1',
    projectedFrameRevision: 'projected-frame-1',
    cameraCalibrationDigest: deriveCameraCalibrationDigest(descriptor.cameraCalibration),
    sceneSupportDigest: 'scene-support-1',
    referenceView: {
      longitude: center[0],
      latitude: center[1],
      zoom: descriptor.cameraCalibration.referenceZoom,
      pitch: 0,
      bearing: 0,
    },
    referenceViewport: { width: 1280, height: 720 },
    projectionOptions: { meterSupportTolerancePx: 0.25, meterSupportIntervalBudget: 16_384 },
    sceneCertifiedFootprintBounds: [{ minX: 0, minY: 0, maxX: 1280, maxY: 720 }],
  });
}

function produce(
  runtimeValue: ResolvedLayerRuntime,
  selection: ReturnType<typeof featureSelection>,
  center: [number, number],
) {
  return produceSnapshotEnvelope({
    runtime: runtimeValue,
    selection,
    sceneMetricContext: scene(runtimeValue, center),
    productionPolicyId: 'strict-envelope-v1',
  });
}

function hexMark(
  cellId: string,
  longitude: number,
  elevationValue: number,
): Extract<ResolvedSelectionMarkInput, { kind: 'hexagon-cell' }> {
  return {
    kind: 'hexagon-cell',
    cellId,
    center: [longitude, 51],
    footprintRing: [
      [longitude, 50.99],
      [longitude + 0.01, 50.995],
      [longitude + 0.01, 51.005],
      [longitude, 51.01],
      [longitude - 0.01, 51.005],
      [longitude - 0.01, 50.995],
      [longitude, 50.99],
    ],
    elevationValue,
    count: 5,
  };
}

function testHexagonUsesCapturedRingAndUncappedPerCellHeights(): void {
  const sourceRows = [{ longitude: 0, latitude: 51 }];
  const runtimeValue = runtime('hexagon', 'hexagon-layer', sourceRows, {
    props: { elevationRange: [0, 5000], elevationScale: 50 },
    runtimeDerivedProps: { elevationDomain: [0, 5] },
  });
  const marks = [hexMark('cell-a', -0.1, 1), hexMark('cell-b', 0.1, 5)];
  const selection = querySelection(runtimeValue, 'select-hexagon-cell-v1', marks);
  const result = produce(runtimeValue, selection, [0, 51]);
  assert(result.status === 'ok', `hexagon envelope should resolve: ${result.status === 'ok' ? '' : result.reason}`);
  const primitives = result.value.frame.primitives as Array<Extract<VisualPrimitive, { kind: 'extruded-footprint' }>>;
  assert(primitives.length === 2, 'each selected aggregate cell retains one extrusion');
  assert(primitives[0].topMeters !== primitives[1].topMeters, 'cells retain independent renderer heights');
  assert(primitives[1].topMeters === 250_000, 'actual 250km renderer height is not capped');
  assert(coordinatesAlmostEqual(primitives[1].rings[0], marks[1].footprintRing), 'captured ring is reused');
  assert(primitives[1].supportBufferPx === 2, 'AA support is represented separately');
  assert(result.value.supportGuarantee === 'conservative', 'positive AA makes the snapshot conservative');
  assert(
    result.value.revisionDependencies?.some((entry) => entry.startsWith('selection:')),
    'selection revision is hashed',
  );

  const changedBindingSelection = querySelection(runtimeValue, 'select-hexagon-cell-v1', marks, undefined, {
    semanticFilter: 'changed-with-identical-marks',
  });
  const changedBinding = produce(runtimeValue, changedBindingSelection, [0, 51]);
  assert(changedBinding.status === 'ok', 'changed query binding with identical marks still produces');
  assert(
    changedBinding.value.revision !== result.value.revision,
    'selection binding revision changes envelope revision',
  );

  const changedRadiusRuntime = runtime('hexagon', 'hexagon-layer', sourceRows, {
    params: { hexagonRadius: 9990 },
    props: { elevationRange: [0, 5000], elevationScale: 50 },
    runtimeDerivedProps: { elevationDomain: [0, 5] },
  });
  const changedSelection = querySelection(changedRadiusRuntime, 'select-hexagon-cell-v1', marks);
  const changed = produce(changedRadiusRuntime, changedSelection, [0, 51]);
  assert(changed.status === 'ok', 'changed catalog radius still produces from a captured ring');
  const changedPrimitive = changed.value.frame.primitives[1] as Extract<
    VisualPrimitive,
    { kind: 'extruded-footprint' }
  >;
  assert(
    JSON.stringify(changedPrimitive.rings[0]) === JSON.stringify(primitives[1].rings[0]),
    'catalog radius cannot reconstruct or alter renderer-captured cell geometry',
  );
}

function testHeatmapRequiresHaloCompleteContributors(): void {
  const objects = [
    { id: 'incident-a', longitude: -77, latitude: 39, n_killed: 1, n_injured: 0 },
    { id: 'incident-b', longitude: -76.9, latitude: 39.1, n_killed: 0, n_injured: 2 },
  ];
  const runtimeValue = runtime('mix', 'heat', objects);
  const support = runtimeValue.descriptor.resolvedSupport;
  assert(support.producer === 'heatmap-kernel', 'expected heatmap support');
  const marks = objects.map((object) => ({ kind: 'source-object' as const, object }));

  const missingRegistry: SelectionResolutionRegistry = {
    resolveFeatureRefs: () => ({ status: 'unsupported', reason: 'not feature refs' }),
    resolveRenderQuery: () => ({
      status: 'ok',
      value: {
        schemaVersion: 1,
        queryId: 'select-heatmap-zone-v1',
        sceneRevision: 'scene-1',
        dataRevision: runtimeValue.descriptor.dataRevision,
        resolvedLayerDigest: runtimeValue.descriptor.resolvedLayerDigest,
        marks,
      },
    }),
  };
  const missing = resolveSelectionSnapshot(
    member(runtimeValue, {
      kind: 'render-query',
      queryId: 'select-heatmap-zone-v1',
      params: {},
      rebindCapability: 'query',
    }),
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    runtimeValue,
    missingRegistry,
  );
  assert(missing.status === 'error', 'unversioned heatmap contributor results fail closed');

  const insufficient = {
    kind: 'heatmap-halo-complete-v1' as const,
    haloRadiusPixels: support.radiusPixels - 1,
    contributorSet: 'complete' as const,
  };
  const insufficientMember = member(runtimeValue, {
    kind: 'render-query',
    queryId: 'select-heatmap-zone-v1',
    params: {},
    rebindCapability: 'query',
  });
  const insufficientResult = resolveSelectionSnapshot(
    insufficientMember,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    runtimeValue,
    {
      ...missingRegistry,
      resolveRenderQuery: () => ({
        status: 'ok',
        value: {
          schemaVersion: 1,
          queryId: 'select-heatmap-zone-v1',
          sceneRevision: 'scene-1',
          dataRevision: runtimeValue.descriptor.dataRevision,
          resolvedLayerDigest: runtimeValue.descriptor.resolvedLayerDigest,
          marks,
          certification: insufficient,
        },
      }),
    },
  );
  assert(insufficientResult.status === 'unsupported', 'incomplete kernel halo fails closed');

  const selection = querySelection(runtimeValue, 'select-heatmap-zone-v1', marks, {
    kind: 'heatmap-halo-complete-v1',
    haloRadiusPixels: support.radiusPixels,
    contributorSet: 'complete',
  });
  const result = produce(runtimeValue, selection, [-77, 39]);
  assert(result.status === 'ok', `heatmap envelope should resolve: ${result.status === 'ok' ? '' : result.reason}`);
  const primitive = result.value.frame.primitives[0] as Extract<VisualPrimitive, { kind: 'point-disc' }>;
  assert(
    primitive.radius.value === support.radiusPixels && primitive.radius.unit === 'pixels',
    'kernel radius stays CSS px',
  );
  assert(primitive.pixelClamp?.supportBufferPx === 2, 'AA buffer remains separate from the kernel radius');
  assert(result.value.supportGuarantee === 'conservative', 'kernel-radius support is conservative');
}

function testScatterAndDrawnGeometryUnion(): void {
  const pointObject = { id: 'airport', coordinates: [10, 20] };
  const pointRuntime = runtime('point', 'point-map', [pointObject]);
  const pointResult = produce(pointRuntime, featureSelection(pointRuntime, [pointObject]), [10, 20]);
  assert(pointResult.status === 'ok', 'point-map selection should produce an envelope');
  const point = pointResult.value.frame.primitives[0] as Extract<VisualPrimitive, { kind: 'point-disc' }>;
  assert(point.radius.value === 100 && point.radius.unit === 'meters', 'point-map keeps its 100m renderer radius');
  assert(point.pixelClamp?.minPx === 2 && point.pixelClamp.supportBufferPx === 2, 'point min and AA support survive');
  assert(pointResult.value.supportGuarantee === 'conservative', 'point-map AA support is conservative');

  const mixObject = { id: 'incident', longitude: -77, latitude: 39 };
  const mixRuntime = runtime('mix', 'scatter', [mixObject]);
  const mixResult = produce(mixRuntime, featureSelection(mixRuntime, [mixObject]), [-77, 39]);
  assert(mixResult.status === 'ok', 'mix scatter selection should produce an envelope');
  const mix = mixResult.value.frame.primitives[0] as Extract<VisualPrimitive, { kind: 'point-disc' }>;
  assert(mix.radius.value === 1 && mix.radius.unit === 'meters', 'mix scatter keeps one meter support');
  assert(mix.pixelClamp?.minPx === 2 && mix.pixelClamp.maxPx === 5, 'mix scatter keeps 2/5 px clamps');
  assert(mixResult.value.supportGuarantee === 'conservative', 'mix scatter AA support is conservative');

  const drawn = drawnSelection(
    mixRuntime,
    {
      type: 'Polygon',
      coordinates: [
        [
          [-77.1, 38.9],
          [-76.9, 38.9],
          [-77, 39.1],
          [-77.1, 38.9],
        ],
      ],
    },
    [{ kind: 'source-object', object: mixObject }],
  );
  const drawnResult = produce(mixRuntime, drawn, [-77, 39]);
  assert(drawnResult.status === 'ok', 'drawn region and associated scatter marks should produce');
  assert(
    drawnResult.value.frame.primitives.some((primitive) => primitive.kind === 'polygon') &&
      drawnResult.value.frame.primitives.some((primitive) => primitive.kind === 'point-disc'),
    'drawn geometry and associated visual marks are both retained',
  );
}

function testLineAndTripsUseRendererPathsAndHalfWidths(): void {
  const lineObject = {
    id: 'flow',
    residence_lng: -1,
    residence_lat: 51,
    workplace_lng: 0.5,
    workplace_lat: 52,
  };
  const lineRuntime = runtime('line', 'line-flight-paths', [lineObject], {
    props: { widthMinPixels: 4, widthMaxPixels: 10 },
  });
  const lineSelection = querySelection(lineRuntime, 'select-line-path-v1', [
    { kind: 'source-object', object: lineObject },
  ]);
  const lineResult = produce(lineRuntime, lineSelection, [0, 51]);
  assert(
    lineResult.status === 'ok',
    `line envelope should resolve: ${lineResult.status === 'ok' ? '' : lineResult.reason}`,
  );
  const line = lineResult.value.frame.primitives[0] as Extract<VisualPrimitive, { kind: 'path-corridor' }>;
  assert(line.positions.length === 2, 'LineLayer uses its two renderer positions');
  assert(line.halfWidth.value === 0.5 && line.halfWidth.unit === 'pixels', 'line width is converted to half-width');
  assert(line.pixelClamp?.minPx === 2 && line.pixelClamp.maxPx === 5, 'line min/max widths are halved');
  assert(line.pixelClamp.supportBufferPx === 2, 'line AA support remains separate');
  assert(lineResult.value.supportGuarantee === 'conservative', 'LineLayer AA support is conservative');

  const tripObject = {
    id: 'trip',
    path: [
      [-74, 40.7],
      [-73.99, 40.71],
      [-73.98, 40.72],
    ],
    timestamps: [0, 100, 200],
  };
  const tripRuntime = runtime('animated', 'trips', [tripObject]);
  const tripSelection = querySelection(tripRuntime, 'select-trip-path-v1', [
    { kind: 'source-object', object: tripObject },
  ]);
  const tripResult = produce(tripRuntime, tripSelection, [-74, 40.7]);
  assert(tripResult.status === 'ok', 'trip envelope should resolve');
  const trip = tripResult.value.frame.primitives[0] as Extract<VisualPrimitive, { kind: 'path-corridor' }>;
  assert(trip.positions.length === tripObject.path.length, 'whole renderer tessellation path is retained');
  assert(trip.halfWidth.value === 0.5 && trip.pixelClamp?.minPx === 1, 'trip width and min clamp are halved');
  assert(tripResult.value.supportGuarantee === 'conservative', 'unclipped whole-trip fallback is conservative');

  const invalidTripObject = {
    ...tripObject,
    id: 'invalid-trip',
    path: [
      [-74, 40.7],
      [-74, 40.7],
    ],
  };
  const invalidTripRuntime = runtime('animated', 'trips', [invalidTripObject]);
  const invalidTripSelection = querySelection(invalidTripRuntime, 'select-trip-path-v1', [
    { kind: 'source-object', object: invalidTripObject },
  ]);
  const invalidTrip = produce(invalidTripRuntime, invalidTripSelection, [-74, 40.7]);
  assert(invalidTrip.status === 'unsupported', 'a trip with fewer than two distinct renderer vertices fails closed');
}

function testPolygonPreservesHolesAndActualHeight(): void {
  const outer = [
    [-74.01, 40.7],
    [-73.99, 40.7],
    [-73.99, 40.72],
    [-74.01, 40.7],
  ];
  const hole = [
    [-74.005, 40.705],
    [-74, 40.705],
    [-74, 40.71],
    [-74.005, 40.705],
  ];
  const tallObject = { id: 'building-tall', polygon: [outer, hole], height: 250_000 };
  const defaultObject = { id: 'building-default', polygon: [outer, hole] };
  const runtimeValue = runtime('animated', 'buildings', [tallObject, defaultObject]);
  const selection = querySelection(runtimeValue, 'select-polygon-region-v1', [
    { kind: 'source-object', object: tallObject },
    { kind: 'source-object', object: defaultObject },
  ]);
  const result = produce(runtimeValue, selection, [-74, 40.71]);
  assert(result.status === 'ok', `polygon envelope should resolve: ${result.status === 'ok' ? '' : result.reason}`);
  const polygons = result.value.frame.primitives as Array<Extract<VisualPrimitive, { kind: 'extruded-footprint' }>>;
  assert(polygons[0].rings.length === 2, 'polygon holes are preserved');
  assert(polygons[0].topMeters === 250_000, 'actual tall building height is not capped');
  assert(polygons[1].topMeters === 1000, 'missing elevation uses the versioned 1000m default');
  assert(polygons[0].supportBufferPx === 2, 'polygon AA support is retained');
  assert(result.value.supportGuarantee === 'conservative', 'polygon AA support makes the result conservative');
}

function testClosedRegistryAndCertifiedInputsFailClosed(): void {
  assert(
    Object.keys(envelopeProducerRegistry).sort().join(',') ===
      ['heatmap-kernel', 'hexagon-cell', 'line-path', 'polygon-extrusion', 'scatter-point', 'trip-path']
        .sort()
        .join(','),
    'producer registry is closed over every current producer',
  );
  const object = { id: 'airport', coordinates: [10, 20] };
  const runtimeValue = runtime('point', 'point-map', [object]);
  const selection = featureSelection(runtimeValue, [object]);
  const forgedRuntime: ResolvedLayerRuntime = {
    ...runtimeValue,
    descriptor: { ...runtimeValue.descriptor },
  };
  const forged = produceSnapshotEnvelope({
    runtime: forgedRuntime,
    selection,
    sceneMetricContext: scene(runtimeValue, [10, 20]),
    productionPolicyId: 'strict-envelope-v1',
  });
  assert(forged.status === 'error', 'a structurally forged resolved descriptor fails closed');

  const forgedSelection = { ...selection };
  const forgedSelectionResult = produceSnapshotEnvelope({
    runtime: runtimeValue,
    selection: forgedSelection,
    sceneMetricContext: scene(runtimeValue, [10, 20]),
    productionPolicyId: 'strict-envelope-v1',
  });
  assert(forgedSelectionResult.status === 'error', 'a structurally forged selection snapshot fails closed');

  const staleSceneResult = produceSnapshotEnvelope({
    runtime: runtimeValue,
    selection,
    sceneMetricContext: scene(runtimeValue, [10, 20], 'scene-2'),
    productionPolicyId: 'strict-envelope-v1',
  });
  assert(staleSceneResult.status === 'stale', 'scene metric revision mismatch fails before production');

  const certifiedScene = scene(runtimeValue, [10, 20]);
  let getterReads = 0;
  const unsafeScene = { ...certifiedScene } as SceneMetricContext;
  Object.defineProperty(unsafeScene, 'sceneContextRevision', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'scene-context-1';
    },
  });
  const unsafeSceneResult = produceSnapshotEnvelope({
    runtime: runtimeValue,
    selection,
    sceneMetricContext: unsafeScene,
    productionPolicyId: 'strict-envelope-v1',
  });
  assert(unsafeSceneResult.status === 'error' && getterReads === 0, 'forged scene accessors are not executed');
}

function testFullWorldRequiresCompleteContinuousGeometry(): void {
  const runtimeValue = runtime('mix', 'scatter', []);
  const almostWorld = drawnSelection(
    runtimeValue,
    {
      type: 'Polygon',
      coordinates: [
        [
          [-180, -10],
          [179.999, -10],
          [179.999, 10],
          [-180, -10],
        ],
      ],
    },
    [],
    undefined,
    'full-world',
  );
  const rejected = produce(runtimeValue, almostWorld, [0, 0]);
  assert(rejected.status === 'unsupported', 'full-world metadata cannot promote an almost-world polygon');

  const completeWorld = drawnSelection(
    runtimeValue,
    {
      type: 'Polygon',
      coordinates: [
        [
          [-180, -10],
          [180, -10],
          [180, 10],
          [-180, -10],
        ],
      ],
    },
    [],
    undefined,
    'full-world',
  );
  const accepted = produce(runtimeValue, completeWorld, [0, 0]);
  assert(
    accepted.status === 'ok' && accepted.value.frame.wrap.wrapMode === 'full-world',
    'continuous complete-world geometry retains full-world topology',
  );
}

function testAdversarialSourceBudgetFailsBeforePrimitiveMaterialization(): void {
  const runtimeValue = runtime('mix', 'heat', []);
  const support = runtimeValue.descriptor.resolvedSupport;
  assert(support.producer === 'heatmap-kernel', 'expected heatmap support for budget fixture');
  const marks: ResolvedSelectionMarkInput[] = Array.from({ length: 200_000 }, (_, index) => ({
    kind: 'source-object',
    object: { id: `budget-${index}`, longitude: -77, latitude: 39 },
  }));
  const selection = querySelection(runtimeValue, 'select-heatmap-zone-v1', marks, {
    kind: 'heatmap-halo-complete-v1',
    haloRadiusPixels: support.radiusPixels,
    contributorSet: 'complete',
  });
  const result = produce(runtimeValue, selection, [-77, 39]);
  assert(
    result.status === 'unavailable' && result.reason === 'envelope-budget-exceeded:sourceItems:200000:100000',
    '200k adversarial marks fail at the closed source estimate without a partial envelope',
  );
}

function testStrictPolicyMaterializesOneHundredThousandSimplePoints(): void {
  const runtimeValue = runtime('mix', 'heat', []);
  const support = runtimeValue.descriptor.resolvedSupport;
  assert(support.producer === 'heatmap-kernel', 'expected heatmap support for boundary fixture');
  const marks: ResolvedSelectionMarkInput[] = Array.from({ length: 100_000 }, (_, index) => ({
    kind: 'source-object',
    object: { id: `boundary-${index}`, longitude: -77, latitude: 39 },
  }));
  const selection = querySelection(runtimeValue, 'select-heatmap-zone-v1', marks, {
    kind: 'heatmap-halo-complete-v1',
    haloRadiusPixels: support.radiusPixels,
    contributorSet: 'complete',
  });
  const result = produce(runtimeValue, selection, [-77, 39]);
  assert(
    result.status === 'ok',
    `100k simple points fit the strict policy: ${result.status === 'ok' ? '' : result.reason}`,
  );
  assert(result.value.frame.primitives.length === 100_000, 'the boundary case is complete rather than sampled');
}

function main(): void {
  testHexagonUsesCapturedRingAndUncappedPerCellHeights();
  testHeatmapRequiresHaloCompleteContributors();
  testScatterAndDrawnGeometryUnion();
  testLineAndTripsUseRendererPathsAndHalfWidths();
  testPolygonPreservesHolesAndActualHeight();
  testClosedRegistryAndCertifiedInputsFailClosed();
  testFullWorldRequiresCompleteContinuousGeometry();
  testStrictPolicyMaterializesOneHundredThousandSimplePoints();
  testAdversarialSourceBudgetFailsBeforePrimitiveMaterialization();
}

main();
