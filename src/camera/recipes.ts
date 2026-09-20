import { cameraCatalog, getCameraById, normalizeTargetType } from './catalog';
import { getCameraParameterProfile } from './profiles';
import type {
  CameraLibraryOption,
  CameraRecipe,
  CameraRecipeAdaptation,
  CameraRecipeAdjustment,
  CameraRecipeFraming,
  CameraRecipeTargetPolicy,
  CameraRecipeTiming,
  CameraOptionSelection,
  NarrativePurpose,
} from './types';

function mergeDefined<T extends object>(base: T, adjustment: Partial<T> | undefined): T {
  if (!adjustment) {
    return { ...base };
  }

  const next = { ...base };
  for (const [key, value] of Object.entries(adjustment) as [keyof T, T[keyof T]][]) {
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

function mergeAdjustment(
  base: {
    timing: CameraRecipeTiming;
    framing: CameraRecipeFraming;
    adaptation: CameraRecipeAdaptation;
    targetPolicy: CameraRecipeTargetPolicy;
  },
  adjustment: CameraRecipeAdjustment | undefined,
) {
  return {
    timing: mergeDefined(base.timing, adjustment?.timing),
    framing: mergeDefined(base.framing, adjustment?.framing),
    adaptation: mergeDefined(base.adaptation, adjustment?.adaptation),
    targetPolicy: mergeDefined(base.targetPolicy, adjustment?.targetPolicy),
  };
}

export function createCameraOptionSelection(option: CameraLibraryOption): CameraOptionSelection {
  return {
    id: option.id,
    label: option.label,
    adjustment: option.adjustment,
  };
}

export function getDefaultCameraOptionSelection(cameraName: string) {
  const camera = getCameraById(cameraName);
  const option =
    camera?.options?.find((candidate) => candidate.id === camera.defaultOptionId) ??
    camera?.options?.find((candidate) => candidate.id === 'normal') ??
    camera?.options?.[0];
  return option ? createCameraOptionSelection(option) : undefined;
}

export function getCameraOptionSelectionById(cameraName: string, optionId: string) {
  const option = getCameraById(cameraName)?.options?.find((candidate) => candidate.id === optionId);
  return option ? createCameraOptionSelection(option) : undefined;
}

export function resolveCameraRecipe(cameraName: string, optionSelection?: CameraOptionSelection): CameraRecipe {
  const camera = getCameraById(cameraName);

  if (!camera) {
    throw new Error(`Camera movement "${cameraName}" is not configured.`);
  }

  const primaryShot = camera.shots[0] ?? 'static';
  const purpose = camera.purpose ?? 'basic';
  const profile = getCameraParameterProfile(purpose);
  const recipeAdjusted = mergeAdjustment(profile, camera.recipe);
  const optionAdjusted = mergeAdjustment(recipeAdjusted, optionSelection?.adjustment);

  return {
    cameraName,
    profile,
    optionSelection,
    purpose,
    presentation: camera.presentation,
    shots: camera.shots,
    primaryShot,
    strategy: camera.recipe.strategy,
    timing: optionAdjusted.timing,
    framing: optionAdjusted.framing,
    adaptation: optionAdjusted.adaptation,
    targetPolicy: optionAdjusted.targetPolicy,
    baseDurationMs: recipeAdjusted.timing.durationMs,
    duration: optionAdjusted.timing.durationMs,
    stay: optionAdjusted.timing.stayMs,
    isRotating: camera.recipe.isRotating ?? false,
    requiresTarget:
      optionAdjusted.targetPolicy.requiresTarget ??
      (purpose !== 'dynamic' && purpose !== 'basic' && !camera.targetTypes.includes('none')),
    requiresComparison: optionAdjusted.targetPolicy.requiresComparison ?? false,
    targetTypes: camera.targetTypes,
    interpolationType: optionAdjusted.timing.interpolationType ?? 'none',
    interpolationDuration: optionAdjusted.timing.interpolationDurationMs ?? 0,
  };
}

export function getDefaultCameraName(purpose: NarrativePurpose, targetType: string | undefined) {
  const normalizedTargetType = normalizeTargetType(targetType);
  return cameraCatalog.defaults.find(
    (defaultRule) => defaultRule.purpose === purpose && defaultRule.targetType === normalizedTargetType,
  )?.cameraId;
}

export function isCameraImplemented(cameraName: string) {
  return Boolean(getCameraById(cameraName));
}

export function isTargetRequired(cameraName: string) {
  return resolveCameraRecipe(cameraName).requiresTarget;
}

export function isComparisonRequired(cameraName: string) {
  return resolveCameraRecipe(cameraName).requiresComparison;
}

export function isTargetTypeAllowed(cameraName: string, targetType: string | undefined) {
  const normalizedTargetType = normalizeTargetType(targetType);
  return resolveCameraRecipe(cameraName).targetTypes.includes(normalizedTargetType);
}
