import { WebMercatorViewport } from '@deck.gl/core';
import type { CameraView, CustomObject } from '../interfaces';
import { getAccessorById } from '../visualization/registry';
import type { ResolvedLayerRuntime } from '../visualization/types';
import type { EnvelopeResult } from './geometry/types';
import { MERCATOR_LATITUDE_LIMIT, getWrappedExtent } from './geometry/geo-wrap';
import { createPointTarget } from './selection';
import { attachRendererSelectionEnvelope } from './renderer-selection-envelope';
import { rememberTargetSource } from './renderer-target';
import type { CameraTarget, LngLat, ViewportSize } from './types';

/** A heatmap target owns a spatial query, so every refresh resolves its current complete contributor halo. */
export function captureHeatmapTarget(
  previous: CameraTarget | undefined,
  runtime: ResolvedLayerRuntime,
  queryAnchor: LngLat,
  referenceView: CameraView,
  viewport: ViewportSize,
  budget: { maxSourceRows?: number; maxContributors?: number } = {},
): EnvelopeResult<CameraTarget> {
  const support = runtime.descriptor.resolvedSupport;
  if (support.producer !== 'heatmap-kernel') return { status: 'unsupported', reason: 'This layer is not a heatmap.' };
  if (runtime.data.length > (budget.maxSourceRows ?? 200000)) {
    return {
      status: 'unavailable',
      reason: 'The heatmap query exceeds the interactive source limit. Use a smaller dataset.',
    };
  }
  const accessor = getAccessorById(support.positionAccessorId);
  if (!accessor) return { status: 'unavailable', reason: 'The current heatmap position accessor is unavailable.' };
  try {
    if (!queryAnchor.every(Number.isFinite) || Math.abs(queryAnchor[1]) > MERCATOR_LATITUDE_LIMIT)
      throw new Error('The heatmap query position is invalid.');
    const projection = new WebMercatorViewport({ ...referenceView, ...viewport });
    const queryPixel = projection.project(queryAnchor);
    if (!queryPixel.every(Number.isFinite)) throw new Error('The heatmap query cannot be projected.');
    const rows: CustomObject[] = [];
    const positions: LngLat[] = [];
    for (const row of runtime.data) {
      const raw = accessor(row);
      if (
        !Array.isArray(raw) ||
        raw.length < 2 ||
        !Number.isFinite(Number(raw[0])) ||
        !Number.isFinite(Number(raw[1])) ||
        Math.abs(Number(raw[1])) > MERCATOR_LATITUDE_LIMIT
      ) {
        throw new Error('The current heatmap contains an invalid position.');
      }
      const position: LngLat = [Number(raw[0]), Number(raw[1])];
      const pixel = projection.project(position);
      if (!pixel.every(Number.isFinite)) throw new Error('The current heatmap contains an unprojectable position.');
      if (Math.hypot(pixel[0] - queryPixel[0], pixel[1] - queryPixel[1]) <= support.radiusPixels + 1e-6) {
        rows.push(row);
        positions.push(position);
        if (rows.length > (budget.maxContributors ?? 5000)) {
          return {
            status: 'unavailable',
            reason: 'This heatmap zone contains too many contributors. Reduce the heatmap radius.',
          };
        }
      }
    }
    if (!rows.length)
      return { status: 'unavailable', reason: 'No current heatmap contributors are visible at this position.' };
    const extent = getWrappedExtent([queryAnchor, ...positions]);
    const target: CameraTarget = {
      ...previous,
      ...createPointTarget(queryAnchor, rows),
      ...(previous ? { id: previous.id } : {}),
      type: 'region',
      source: 'heatmap-zone',
      sourceFeatures: undefined,
      selectionAnchor: [...queryAnchor],
      center: [(extent.minLng + extent.maxLng) / 2, (extent.minLat + extent.maxLat) / 2],
      bbox: [extent.minLng, extent.minLat, extent.maxLng, extent.maxLat],
      coordinates: positions,
      selectedRows: rows,
      snapshotEnvelope: undefined,
      visualFrame: undefined,
      stats: { count: rows.length },
      label: `Heatmap zone (${rows.length})`,
    };
    const captured = attachRendererSelectionEnvelope({
      target,
      resolvedLayers: [runtime],
      expectedProducer: 'heatmap-kernel',
      selectionMode: 'map-click',
      marks: rows,
      heatmapQueryPoint: queryAnchor,
      referenceView,
      viewport,
    });
    return captured.status === 'attached'
      ? { status: 'ok', value: rememberTargetSource(captured.target, runtime) }
      : { status: 'unavailable', reason: captured.detail };
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}
