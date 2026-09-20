import {
  createCameraOptionSelection,
  getCameraOptionSelectionById,
  getDefaultCameraOptionSelection,
  resolveCameraRecipe,
} from './recipes';
import { getAdaptiveCameraPaddingPx } from './strategies';
import type { CameraOptionSelection, ViewportSize } from './types';

export interface CameraParameterSummary {
  durationMs: number;
  stayMs: number;
  paddingRatio: number;
  paddingPx: number;
  speedMultiplier?: number;
  adjustmentLabels: string[];
}

/** Matches a newly opened shot in PanelLibrary, before any saved choice exists. */
export function getNewCameraDefaultOptionSelection(cameraName: string) {
  return getDefaultCameraOptionSelection(cameraName);
}

export function getCameraParameterSummary(
  cameraName: string,
  optionSelection?: CameraOptionSelection,
  viewportSize?: ViewportSize,
): CameraParameterSummary {
  const recipe = resolveCameraRecipe(cameraName, optionSelection);
  const baseRecipe = resolveCameraRecipe(cameraName);
  const durationMs = recipe.duration;
  const stayMs = recipe.stay;
  const paddingRatio = recipe.framing.paddingRatio;
  const speedMultiplier = baseRecipe.duration > 0 && durationMs > 0 ? baseRecipe.duration / durationMs : undefined;
  const adjustmentLabels: string[] = [];

  if (optionSelection?.adjustment.framing?.zoomBias !== undefined) {
    adjustmentLabels.push(`Zoom bias ${optionSelection.adjustment.framing.zoomBias}`);
  }
  if (optionSelection?.adjustment.framing?.pitchTarget !== undefined) {
    adjustmentLabels.push(`Pitch ${optionSelection.adjustment.framing.pitchTarget}`);
  }
  if (optionSelection?.adjustment.framing?.bearingDelta !== undefined) {
    adjustmentLabels.push(`Bearing ${optionSelection.adjustment.framing.bearingDelta}`);
  }

  return {
    durationMs,
    stayMs,
    paddingRatio,
    paddingPx: getAdaptiveCameraPaddingPx(recipe, viewportSize),
    speedMultiplier,
    adjustmentLabels,
  };
}

export function formatCameraDuration(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatCameraSpeed(speedMultiplier: number | undefined) {
  return speedMultiplier === undefined ? 'Static hold' : `${speedMultiplier.toFixed(1)}x`;
}

export { createCameraOptionSelection, getCameraOptionSelectionById, getDefaultCameraOptionSelection };
