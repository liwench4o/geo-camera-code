import type { CameraMovement } from '../interfaces';

/** Annotation time is relative to the authored shot, including its final hold.
 * The end is exclusive so a caption cannot spill into a transition or next shot. */
export function getCameraAnnotationAtTime(camera: CameraMovement | undefined, offsetMs: number): string | undefined {
  const annotation = camera?.annotation;
  if (!camera || !annotation || typeof annotation.text !== 'string' || !Number.isFinite(offsetMs)) return undefined;
  const { delay, duration, text } = annotation;
  if (!Number.isFinite(delay) || !Number.isFinite(duration) || delay < 0 || duration <= 0) return undefined;
  const end = Math.min(camera.duration + camera.stay, delay + duration);
  return offsetMs >= delay && offsetMs < end && text.trim().length > 0 ? text : undefined;
}
