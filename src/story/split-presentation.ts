import type { PlaybackSegment } from '../interfaces';
import { isCameraTarget, normalizeCameraTarget } from '../camera/selection';
import type { CameraTarget } from '../camera/types';
import { getPlaybackPositionAtTime } from './playback';

export interface PlaybackSplitPresentation {
  segmentId: string;
  targets: [CameraTarget, CameraTarget];
}

export function getSplitPresentationForPlaybackSegment(
  segment?: PlaybackSegment,
): PlaybackSplitPresentation | undefined {
  if (!segment || segment.generated || segment.camera.presentation !== 'split') {
    return undefined;
  }

  const targets = (segment.camera.comparisonTargetSnapshots ?? [])
    .filter(isCameraTarget)
    .map((target) => normalizeCameraTarget(target));

  return targets.length >= 2
    ? {
        segmentId: segment.id,
        targets: [targets[0], targets[targets.length - 1]],
      }
    : undefined;
}

export function getSplitPresentationAtPlaybackTime(
  segments: PlaybackSegment[],
  timeMs: number,
): PlaybackSplitPresentation | undefined {
  const position = getPlaybackPositionAtTime(segments, timeMs);
  const segment = position ? segments[position.segmentIndex] : undefined;
  // The segment end boundary counts as finished playback, not as inside the segment; otherwise
  // the auto-stop at the story end would leave the non-interactive overlay stuck on screen.
  if (!segment || timeMs >= segment.end) {
    return undefined;
  }

  return getSplitPresentationForPlaybackSegment(segment);
}

export function reconcileSplitPresentationForPlanRevision(
  presentation: PlaybackSplitPresentation | undefined,
  previousPlanRevision: number,
  nextPlanRevision: number,
): PlaybackSplitPresentation | undefined {
  return previousPlanRevision === nextPlanRevision ? presentation : undefined;
}
