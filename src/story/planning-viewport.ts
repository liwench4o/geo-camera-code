import type { CameraMovement } from '../interfaces';
import type { ViewportSpec } from '../camera/geometry/types';
import { resolveTrajectoryViewport } from '../camera/trajectory/legacy';

type PlaybackViewportCamera = CameraMovement & { playbackPlanningViewport?: ViewportSpec };

/** Generated segments inherit projection context without copying shot authoring intent. */
export function withPlaybackPlanningViewport(
  camera: CameraMovement,
  viewport: ViewportSpec | undefined,
): PlaybackViewportCamera {
  return viewport
    ? { ...camera, playbackPlanningViewport: { width: viewport.width, height: viewport.height } }
    : camera;
}

/** The projection size belongs to the applied shot, not to the current window. */
export function getCameraPlanningViewport(camera?: PlaybackViewportCamera): ViewportSpec | undefined {
  const planned = camera?.playbackPlanningViewport ?? camera?.authoring?.planningViewport;
  if (
    planned &&
    Number.isFinite(planned.width) &&
    planned.width > 0 &&
    Number.isFinite(planned.height) &&
    planned.height > 0
  ) {
    return { width: planned.width, height: planned.height };
  }
  const trajectory = camera?.trajectoryPlan?.trajectory;
  if (trajectory?.kind === 'legacy-fly') return resolveTrajectoryViewport(trajectory.viewport);
  return undefined;
}

/** Render at `viewport`, then scale the map into this centered display rectangle. */
export function getPlaybackViewportLayout(camera: CameraMovement | undefined, available: ViewportSpec) {
  const container = resolveTrajectoryViewport(available);
  const viewport = getCameraPlanningViewport(camera) ?? container;
  const scale = Math.min(container.width / viewport.width, container.height / viewport.height);
  const width = viewport.width * scale;
  const height = viewport.height * scale;
  const left = Math.max(0, (container.width - width) / 2);
  const top = Math.max(0, (container.height - height) / 2);
  return { viewport, scale, width, height, left, top, letterboxed: left > 0.5 || top > 0.5 };
}
