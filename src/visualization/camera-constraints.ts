import type { CameraView } from '../interfaces';
import type { VisualizationCameraConstraints } from './types';

const DEFAULT_CAMERA_CONSTRAINTS: VisualizationCameraConstraints = {
  minZoom: 0,
  maxZoom: 20,
  minPitch: 0,
  maxPitch: 60,
};

export function getVisualizationCameraConstraints(
  viewState: Partial<Pick<CameraView, 'minZoom' | 'maxZoom' | 'minPitch' | 'maxPitch'>>,
): VisualizationCameraConstraints {
  const constraints = {
    minZoom: viewState.minZoom ?? DEFAULT_CAMERA_CONSTRAINTS.minZoom,
    maxZoom: viewState.maxZoom ?? DEFAULT_CAMERA_CONSTRAINTS.maxZoom,
    minPitch: viewState.minPitch ?? DEFAULT_CAMERA_CONSTRAINTS.minPitch,
    maxPitch: viewState.maxPitch ?? DEFAULT_CAMERA_CONSTRAINTS.maxPitch,
  };
  for (const [key, value] of Object.entries(constraints)) {
    if (!Number.isFinite(value)) throw new Error(`Visualization camera constraint ${key} must be finite.`);
  }
  if (constraints.minZoom > constraints.maxZoom) {
    throw new Error('Visualization camera constraint minZoom must not exceed maxZoom.');
  }
  if (constraints.minPitch > constraints.maxPitch) {
    throw new Error('Visualization camera constraint minPitch must not exceed maxPitch.');
  }
  return constraints;
}

export function applyVisualizationCameraConstraints(
  viewState: CameraView,
  constraints: VisualizationCameraConstraints,
): CameraView {
  return {
    ...viewState,
    ...constraints,
  };
}
