import type { CameraView } from '../interfaces';

export const DEFAULT_MAX_BEARING_SAMPLE_STEP_DEG = 15;

export interface CameraPathSamplingOptions {
  maxBearingStepDeg?: number;
}

function clampProgress(progress: number) {
  return Math.min(1, Math.max(0, progress));
}

export function interpolateNumber(start: number, end: number, progress: number) {
  return start + (end - start) * progress;
}

export function easeCameraProgress(progress: number) {
  const clampedProgress = clampProgress(progress);
  return clampedProgress < 0.5
    ? 4 * clampedProgress * clampedProgress * clampedProgress
    : 1 - Math.pow(-2 * clampedProgress + 2, 3) / 2;
}

export function interpolateCameraView(initView: CameraView, finalView: CameraView, progress: number): CameraView {
  const easedProgress = easeCameraProgress(progress);
  return {
    ...finalView,
    longitude: interpolateNumber(initView.longitude, finalView.longitude, easedProgress),
    latitude: interpolateNumber(initView.latitude, finalView.latitude, easedProgress),
    zoom: interpolateNumber(initView.zoom, finalView.zoom, easedProgress),
    pitch: interpolateNumber(initView.pitch, finalView.pitch, easedProgress),
    bearing: interpolateNumber(initView.bearing, finalView.bearing, easedProgress),
    transitionDuration: 0,
    transitionInterpolator: undefined,
    onTransitionEnd: undefined,
  };
}

export function getCameraPathSampleCount(
  initView: CameraView,
  finalView: CameraView,
  { maxBearingStepDeg = DEFAULT_MAX_BEARING_SAMPLE_STEP_DEG }: CameraPathSamplingOptions = {},
) {
  const sampleStepDeg =
    Number.isFinite(maxBearingStepDeg) && maxBearingStepDeg > 0
      ? maxBearingStepDeg
      : DEFAULT_MAX_BEARING_SAMPLE_STEP_DEG;
  const bearingSpan = Math.abs(finalView.bearing - initView.bearing);
  return Math.max(1, Math.ceil(bearingSpan / sampleStepDeg));
}

export function sampleCameraViewPath(
  initView: CameraView,
  finalView: CameraView,
  options: CameraPathSamplingOptions = {},
) {
  const sampleCount = getCameraPathSampleCount(initView, finalView, options);
  return Array.from({ length: sampleCount + 1 }, (_, step) =>
    interpolateCameraView(initView, finalView, step / sampleCount),
  );
}
