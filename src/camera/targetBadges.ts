import { resolveCameraRecipe } from './recipes';

export type CameraTargetRequirementBadgeTone = 'comparison' | 'path' | 'optional' | 'required';

export interface CameraTargetRequirementBadge {
  label: string;
  tone: CameraTargetRequirementBadgeTone;
}

export interface CameraTargetRequirementTooltip {
  description: string;
  requirement: CameraTargetRequirementBadge;
}

export function getCameraTargetRequirementBadge(cameraId: string): CameraTargetRequirementBadge {
  const recipe = resolveCameraRecipe(cameraId);

  if (recipe.requiresComparison) {
    return { label: 'Requires 2 targets', tone: 'comparison' };
  }
  if (recipe.targetTypes.length === 1 && recipe.targetTypes[0] === 'path') {
    return { label: 'Path only', tone: 'path' };
  }
  if (!recipe.requiresTarget || recipe.targetTypes.includes('none')) {
    return { label: 'No target required', tone: 'optional' };
  }
  return { label: 'Requires target', tone: 'required' };
}

export function getCameraTargetRequirementTooltip(
  cameraId: string,
  description: string,
): CameraTargetRequirementTooltip {
  return {
    description,
    requirement: getCameraTargetRequirementBadge(cameraId),
  };
}
