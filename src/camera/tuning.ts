import type { CameraFramingTuning, CameraLibraryTuning, NarrativePurpose } from './types';

export const DEFAULT_FRAMING_TUNING: CameraFramingTuning = {
  framingTightness: 0,
  motionStrength: 0,
  anchorHeightRatio: 0.5,
  speedScale: 1,
};

function mergeTuning<T extends CameraFramingTuning>(base: T, override: Partial<T> | undefined): T {
  if (!override) {
    return { ...base };
  }

  const next = { ...base };
  for (const [key, value] of Object.entries(override) as [keyof T, T[keyof T]][]) {
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

/**
 * Resolves the effective framing tuning for one planning request by merging
 * module defaults, the camera-library global tuning, the per-purpose tuning,
 * and finally the caller-provided tuning (highest precedence).
 */
export function resolveFramingTuning(
  purpose: NarrativePurpose,
  inputTuning?: CameraFramingTuning,
  libraryTuning?: CameraLibraryTuning,
): CameraFramingTuning {
  const globalTuning = mergeTuning(DEFAULT_FRAMING_TUNING, libraryTuning?.global);
  const purposeTuning = mergeTuning(globalTuning, libraryTuning?.byPurpose?.[purpose]);
  return mergeTuning(purposeTuning, inputTuning);
}
