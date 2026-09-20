import type { CameraMovement } from '../../interfaces';
import type { ViewportSpec } from '../geometry/types';
import { getDefaultViewportSize } from '../viewport';
import type { SerializedCameraTrajectory, SerializedCameraView } from './types';

const SEMANTIC_CHANNELS = ['longitude', 'latitude', 'zoom', 'pitch', 'bearing'] as const;

function copySemanticView(view: CameraMovement['initViewState']): SerializedCameraView {
  return {
    longitude: view.longitude,
    latitude: view.latitude,
    zoom: view.zoom,
    pitch: view.pitch,
    bearing: view.bearing,
  };
}

function sameView(first: SerializedCameraView, second: SerializedCameraView): boolean {
  return SEMANTIC_CHANNELS.every((channel) => first[channel] === second[channel]);
}

function resolveDuration(duration: number): number {
  if (!Number.isFinite(duration)) {
    throw new TypeError('legacy camera movement duration must be finite');
  }
  return Math.max(0, duration);
}

export function resolveTrajectoryViewport(viewport?: ViewportSpec): ViewportSpec {
  if (
    viewport &&
    Number.isFinite(viewport.width) &&
    viewport.width > 0 &&
    Number.isFinite(viewport.height) &&
    viewport.height > 0
  ) {
    return { width: viewport.width, height: viewport.height };
  }
  const fallback = getDefaultViewportSize();
  return { width: fallback.width, height: fallback.height };
}

export function compileLegacyMovementTrajectory(
  movement: CameraMovement,
  viewport: ViewportSpec,
  interpolation: 'fly' | 'linear',
): SerializedCameraTrajectory {
  const durationMs = resolveDuration(movement.duration);
  const initView = copySemanticView(movement.initViewState);
  const finalView = copySemanticView(movement.finalViewState);

  if (sameView(initView, finalView)) {
    return {
      kind: 'hold',
      sampler: 'hold-v1',
      samplerVersion: '1',
      durationMs,
      keyframes: [
        { timeMs: 0, view: { ...initView } },
        { timeMs: durationMs, view: { ...finalView } },
      ],
    };
  }

  if (interpolation === 'linear') {
    return {
      kind: 'legacy-linear',
      sampler: 'legacy-linear-v1',
      samplerVersion: '1',
      durationMs,
      initView,
      finalView,
    };
  }

  return {
    kind: 'legacy-fly',
    sampler: 'deck-fly-v1',
    samplerVersion: '1',
    durationMs,
    viewport: resolveTrajectoryViewport(viewport),
    initView,
    finalView,
  };
}
