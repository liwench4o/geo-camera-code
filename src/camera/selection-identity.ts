import { normalizeTargetType } from './catalog';
import type { CameraTarget } from './types';

function isSourceId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function sourceReferences(target: CameraTarget): string[] {
  const references = target.sourceFeatures?.length
    ? target.sourceFeatures
    : (target.selectedRows ?? []).flatMap((row) => {
        const field = ['rid', 'id', 'key'].find((key) => isSourceId(row[key]));
        return field ? [{ field, value: row[field] as string | number }] : [];
      });
  return [...new Set(references.map(({ field, value }) => JSON.stringify([field, value])))].sort();
}

/** Selection identity is independent of the coarse bbox key used by story/playback grouping. */
export function getSelectionIdentity(target: CameraTarget): string {
  const type = normalizeTargetType(target.type);
  const provenance = target.snapshotEnvelope?.provenance;
  const namespace = [
    target.sourceDatasetId ?? provenance?.datasetId ?? null,
    target.sourceVisualizationId ?? provenance?.visualizationId ?? null,
    target.sourceLayerId ?? provenance?.layerId ?? null,
  ];
  const isDrawnSelection = target.source === 'drawn-region' || target.source === 'drawn-path';
  const references = isDrawnSelection ? [] : sourceReferences(target);
  if (references.length) {
    // Revisions, heights, styles and generated target IDs can change while the source object stays the same.
    return JSON.stringify([type, namespace, 'source', references]);
  }

  // Preserve every available coordinate. A region/path's bbox loses its shape; a hex pick's
  // selectionAnchor can be the ground click behind the column, so use its captured center.
  const geometry =
    type === 'location' ? target.center : target.coordinates?.length ? target.coordinates : target.center;
  return JSON.stringify([type, namespace, 'geometry', geometry]);
}
