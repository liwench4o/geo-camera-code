import type { CameraView, HomeViews } from '../interfaces';
import type { VisualizationCameraConstraints } from '../visualization/types';
import { MERCATOR_LATITUDE_LIMIT } from '../camera/geometry/geo-wrap';

/** Retain framing only, never live controller state, callbacks or transitions. */
export function copyHomeView(value: unknown): CameraView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid home view.');
  const input = value as Record<string, unknown>;
  const view = {} as CameraView;
  for (const key of ['longitude', 'latitude', 'zoom', 'pitch', 'bearing'] as const) {
    const number = input[key];
    if (typeof number !== 'number' || !Number.isFinite(number)) throw new Error(`Invalid home view ${key}.`);
    view[key] = number;
  }
  if (
    Math.abs(view.latitude) > MERCATOR_LATITUDE_LIMIT ||
    view.zoom < -2 ||
    view.zoom > 24 ||
    view.pitch < 0 ||
    view.pitch > 85
  ) {
    throw new Error('Home view is outside the supported map range.');
  }
  if (input.altitude !== undefined) {
    if (typeof input.altitude !== 'number' || !Number.isFinite(input.altitude) || input.altitude <= 0) {
      throw new Error('Invalid home view altitude.');
    }
    view.altitude = input.altitude;
  }
  return view;
}

export function copyHomeViews(value: unknown): HomeViews {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid scene home views.');
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => {
        if (!key.trim()) throw new Error('Home view needs a scene identity.');
        return [key, copyHomeView((value as Record<string, unknown>)[key])];
      }),
  );
}

export function includeHomeViewInConstraints(
  constraints: VisualizationCameraConstraints | undefined,
  home: CameraView | undefined,
): VisualizationCameraConstraints | undefined {
  if (!constraints || !home) return constraints;
  return {
    minZoom: Math.min(constraints.minZoom, home.zoom),
    maxZoom: Math.max(constraints.maxZoom, home.zoom),
    minPitch: Math.min(constraints.minPitch, home.pitch),
    maxPitch: Math.max(constraints.maxPitch, home.pitch),
  };
}
