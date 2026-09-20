import type { PlaybackSegment } from '../interfaces';
import type { CameraTarget } from '../camera/types';

/** Data time is expressed in the source renderer's timestamp units, not milliseconds. */
export interface AnimationBinding {
  version: 1;
  visualizationId: string;
  datasetId: string;
  layerId: string;
  dataRevision: string;
  pathDigest: string;
  timeRange: [number, number];
}

export interface SceneTimeFrame {
  binding: AnimationBinding;
  time: number;
}

export function validateAnimationBinding(value: unknown): value is AnimationBinding {
  if (!value || typeof value !== 'object') return false;
  const binding = value as AnimationBinding;
  return (
    binding.version === 1 &&
    ['visualizationId', 'datasetId', 'layerId', 'dataRevision', 'pathDigest'].every(
      (key) =>
        typeof binding[key as keyof AnimationBinding] === 'string' &&
        (binding[key as keyof AnimationBinding] as string).trim().length > 0,
    ) &&
    Array.isArray(binding.timeRange) &&
    binding.timeRange.length === 2 &&
    binding.timeRange.every(Number.isFinite) &&
    binding.timeRange[1] > binding.timeRange[0]
  );
}

export function createAnimationBinding(target: CameraTarget): AnimationBinding | undefined {
  const path = target.timedPath;
  const provenance = target.snapshotEnvelope?.provenance;
  const dataRevision = provenance?.dataRevision;
  if (
    !path ||
    !target.sourceVisualizationId ||
    !target.sourceDatasetId ||
    !target.sourceLayerId ||
    typeof dataRevision !== 'string' ||
    !dataRevision.trim() ||
    target.sourceVisualizationId !== provenance?.visualizationId ||
    target.sourceDatasetId !== provenance?.datasetId ||
    target.sourceLayerId !== provenance?.layerId
  )
    return undefined;
  return {
    version: 1,
    visualizationId: target.sourceVisualizationId,
    datasetId: target.sourceDatasetId,
    layerId: target.sourceLayerId,
    dataRevision,
    pathDigest: path.digest,
    timeRange: [path.timestamps[0], path.timestamps[path.timestamps.length - 1]],
  };
}

/** Stateless sampling makes seeking, split views, replay and paused frames identical. */
export function getSceneTimeAtPlaybackTime(
  segments: readonly PlaybackSegment[],
  timeMs: number,
): SceneTimeFrame | undefined {
  let first: SceneTimeFrame | undefined;
  let preceding: SceneTimeFrame | undefined;
  for (const segment of segments) {
    const binding = segment.camera.animationBinding;
    if (!binding || segment.generated) continue;
    first ??= { binding, time: binding.timeRange[0] };
    if (timeMs < segment.start) break;
    const progress = segment.duration > 0 ? Math.min(1, Math.max(0, (timeMs - segment.start) / segment.duration)) : 0;
    preceding = { binding, time: binding.timeRange[0] + (binding.timeRange[1] - binding.timeRange[0]) * progress };
  }
  return preceding ?? first;
}
