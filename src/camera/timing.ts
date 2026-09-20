import { WebMercatorViewport } from '@deck.gl/core';
import type { CameraView } from '../interfaces';
import { getDefaultViewportSize } from './viewport';
import type { CameraRecipe, CameraRecipeStrategy, ViewportSize } from './types';

export const TIMING_MIN_DURATION_MS = 1200;
export const TIMING_MAX_DURATION_MS = 14000;

const STATIC_DISPLACEMENT_EPSILON = 0.02;
const ZOOM_WEIGHT = 0.6;
const PITCH_WEIGHT = 0.5;
const BEARING_WEIGHT = 0.7;
const MIN_SPEED_SCALE = 0.25;

/**
 * Strategies whose angular span is fixed by the profile regardless of the
 * geographic scene: their fixed recipe durations are already perceived-speed
 * calibrated, and endpoint displacement under-weights angular motion, so
 * displacement normalization is skipped for them. Translation-dominant combos
 * (push-in-tilt, pan-tilt, pan-push-in, tracking-push-in) stay normalized.
 */
const ROTATION_DOMINANT_STRATEGIES = new Set<CameraRecipeStrategy>([
  'camera-roll',
  'arc',
  'tilt',
  'arc-tilt',
  'pull-out-roll',
  'arc-pull-out',
]);

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Normalized perceived displacement between two view states, measured in
 * "screens": ground-center travel at the coarser zoom plus weighted zoom,
 * pitch, and bearing changes (spec §7.1). Center travel is measured in flat
 * Mercator pixels, so movements crossing the antimeridian are measured the
 * long way around rather than across the seam.
 */
export function computeViewDisplacement(
  initView: CameraView,
  finalView: CameraView,
  viewportSize: ViewportSize = getDefaultViewportSize(),
): number {
  const coarseZoom = Math.min(initView.zoom, finalView.zoom);
  const viewport = new WebMercatorViewport({
    width: viewportSize.width,
    height: viewportSize.height,
    longitude: initView.longitude,
    latitude: initView.latitude,
    zoom: coarseZoom,
    pitch: 0,
    bearing: 0,
  });
  const initPixel = viewport.project([initView.longitude, initView.latitude]);
  const finalPixel = viewport.project([finalView.longitude, finalView.latitude]);
  const centerTravelPx =
    Number.isFinite(initPixel[0]) &&
    Number.isFinite(initPixel[1]) &&
    Number.isFinite(finalPixel[0]) &&
    Number.isFinite(finalPixel[1])
      ? Math.hypot(finalPixel[0] - initPixel[0], finalPixel[1] - initPixel[1])
      : 0;
  const diagonalPx = Math.hypot(viewportSize.width, viewportSize.height);

  return (
    centerTravelPx / diagonalPx +
    ZOOM_WEIGHT * Math.abs(finalView.zoom - initView.zoom) +
    PITCH_WEIGHT * (Math.abs(finalView.pitch - initView.pitch) / 90) +
    BEARING_WEIGHT * (Math.abs(finalView.bearing - initView.bearing) / 180)
  );
}

export interface AdaptiveDurationResult {
  durationMs: number;
  displacement: number;
  speedTier?: number;
  reason: string;
}

/**
 * Bounds the neutral movement duration before applying preset and author pace.
 * Preset durationMs relative to the merged profile+recipe base is a speed
 * multiplier. Applying that multiplier after the neutral bounds and tracking
 * floor keeps Fast/Normal and Pace effective for both short and long movements.
 */
export function resolveAdaptiveDuration({
  recipe,
  displacement,
  pathLengthKm,
  speedScale = 1,
}: {
  recipe: CameraRecipe;
  displacement: number;
  pathLengthKm?: number;
  speedScale?: number;
}): AdaptiveDurationResult {
  const optionSpeedMultiplier =
    recipe.baseDurationMs > 0 && recipe.timing.durationMs > 0 ? recipe.baseDurationMs / recipe.timing.durationMs : 1;
  const fallbackDurationMs = optionSpeedMultiplier === 1 ? recipe.timing.durationMs : recipe.baseDurationMs;
  const speedTier = recipe.timing.speedTier;
  let durationMs = fallbackDurationMs;
  let reason: string;

  if (ROTATION_DOMINANT_STRATEGIES.has(recipe.strategy)) {
    reason = 'Rotation-dominant shot uses its recipe duration; its angular span is fixed by the profile.';
  } else if (!speedTier || speedTier <= 0) {
    reason = 'Recipe duration used because no speed tier is configured for this purpose.';
  } else if (displacement < STATIC_DISPLACEMENT_EPSILON) {
    reason = 'Recipe duration used because the perceived displacement is negligible.';
  } else {
    durationMs = clamp((displacement / speedTier) * 1000, TIMING_MIN_DURATION_MS, TIMING_MAX_DURATION_MS);
    reason = `Duration normalized by perceived displacement (${displacement.toFixed(2)} screens at ${speedTier.toFixed(2)} screens/s).`;
  }

  if (recipe.strategy.includes('tracking') && pathLengthKm && recipe.timing.pathDurationPerKmMs) {
    const pathBasedMs = fallbackDurationMs + pathLengthKm * recipe.timing.pathDurationPerKmMs;
    if (pathBasedMs > durationMs) {
      durationMs = pathBasedMs;
      reason = `Path length (${pathLengthKm.toFixed(1)} km) increased tracking duration so the route can be followed.`;
    }
  }

  if (recipe.timing.maxDurationMs !== undefined) {
    durationMs = Math.min(durationMs, recipe.timing.maxDurationMs);
  }

  const effectiveSpeed = Math.max(MIN_SPEED_SCALE, optionSpeedMultiplier * speedScale);
  durationMs /= effectiveSpeed;
  if (effectiveSpeed !== 1) reason += ` Preset and pace apply ${Number(effectiveSpeed.toFixed(3))}× speed.`;

  return { durationMs: Math.round(durationMs), displacement, speedTier, reason };
}
