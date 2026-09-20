import type { CameraView } from '../interfaces';
import { MERCATOR_LATITUDE_LIMIT, shortestAngle, unwrapLongitude } from '../camera/geometry/geo-wrap';
import { easeCameraProgress } from '../camera/interpolation';

export interface CameraNavigationState {
  mode: 'follow' | 'free' | 'returning';
  view: CameraView;
  storyView?: CameraView;
  transition?: {
    from: CameraView;
    startedAtMs: number;
    durationMs: number;
    /** Keep the live target on one angular branch while it moves past the return origin's antipode. */
    angularTarget?: Pick<CameraView, 'longitude' | 'bearing'>;
  };
}

interface NavigationInteractionState {
  isDragging?: boolean;
  isPanning?: boolean;
  isRotating?: boolean;
  isZooming?: boolean;
  inTransition?: boolean;
}

function clampLatitude(latitude: number): number {
  return Math.max(-MERCATOR_LATITUDE_LIMIT, Math.min(MERCATOR_LATITUDE_LIMIT, latitude));
}

/** Keep controller poses free of inherited animations and their callbacks. */
export function cleanNavigationView(view: CameraView): CameraView {
  return {
    ...view,
    latitude: clampLatitude(view.latitude),
    transitionDuration: 0,
    transitionInterpolator: undefined,
    transitionEasing: undefined,
    transitionInterruption: undefined,
    onTransitionStart: undefined,
    onTransitionInterrupt: undefined,
    onTransitionEnd: undefined,
  };
}

/** Mercator latitude in world units, matching longitude / 360. */
function projectLatitude(latitude: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (clampLatitude(latitude) * Math.PI) / 360)) / (2 * Math.PI);
}

function unprojectLatitude(projected: number): number {
  return clampLatitude((Math.atan(Math.sinh(projected * 2 * Math.PI)) * 180) / Math.PI);
}

function cameraDistance(from: CameraView, to: CameraView): number {
  const worldScale = 2 ** Math.max(0, Math.min(20, from.zoom, to.zoom));
  return Math.hypot(
    (shortestAngle(from.longitude, to.longitude) / 360) * worldScale,
    (projectLatitude(to.latitude) - projectLatitude(from.latitude)) * worldScale,
    (to.zoom - from.zoom) / 3,
    (to.pitch - from.pitch) / 45,
    shortestAngle(from.bearing, to.bearing) / 90,
    ((to.altitude ?? 1.5) - (from.altitude ?? 1.5)) / 1.5,
  );
}

function unwrapAngles(
  view: Pick<CameraView, 'longitude' | 'bearing'>,
  reference: Pick<CameraView, 'longitude' | 'bearing'>,
): Pick<CameraView, 'longitude' | 'bearing'> {
  return {
    longitude: unwrapLongitude(view.longitude, reference.longitude),
    bearing: unwrapLongitude(view.bearing, reference.bearing),
  };
}

function interpolateOnAngularBranch(
  from: CameraView,
  to: CameraView,
  progress: number,
  angularTarget: Pick<CameraView, 'longitude' | 'bearing'>,
): CameraView {
  const amount = easeCameraProgress(progress);
  if (amount === 0) return cleanNavigationView(from);
  if (amount === 1) return cleanNavigationView(to);
  const latitude = projectLatitude(from.latitude) * (1 - amount) + projectLatitude(to.latitude) * amount;
  return {
    ...cleanNavigationView(to),
    longitude: from.longitude * (1 - amount) + angularTarget.longitude * amount,
    latitude: unprojectLatitude(latitude),
    zoom: from.zoom * (1 - amount) + to.zoom * amount,
    pitch: from.pitch * (1 - amount) + to.pitch * amount,
    bearing: from.bearing * (1 - amount) + angularTarget.bearing * amount,
    ...(from.altitude !== undefined || to.altitude !== undefined
      ? { altitude: (from.altitude ?? 1.5) * (1 - amount) + (to.altitude ?? 1.5) * amount }
      : {}),
  };
}

/** Sample an eased return without asking deck.gl to run another camera animation. */
export function interpolateNavigationView(from: CameraView, to: CameraView, progress: number): CameraView {
  return interpolateOnAngularBranch(from, to, progress, unwrapAngles(to, from));
}

export function createCameraNavigation(view: CameraView): CameraNavigationState {
  return { mode: 'follow', view: cleanNavigationView(view) };
}

export function updateStoryView(state: CameraNavigationState, view: CameraView, nowMs: number): CameraNavigationState {
  const storyView = cleanNavigationView(view);
  if (state.mode === 'follow') return { mode: 'follow', view: cleanNavigationView(storyView), storyView };
  return advanceCameraNavigation({ ...state, storyView }, nowMs);
}

export function takeCameraControl(state: CameraNavigationState, view = state.view): CameraNavigationState {
  return { mode: 'free', view: cleanNavigationView(view), storyView: state.storyView };
}

export function resumeCameraFollow(
  state: CameraNavigationState,
  nowMs: number,
  reducedMotion = false,
): CameraNavigationState {
  if (!state.storyView) return state;
  const from = cleanNavigationView(state.view);
  const distance = cameraDistance(from, state.storyView);
  if (reducedMotion || distance < 1e-9) {
    return { mode: 'follow', view: cleanNavigationView(state.storyView), storyView: state.storyView };
  }
  return {
    mode: 'returning',
    view: from,
    storyView: state.storyView,
    transition: {
      from: cleanNavigationView(from),
      startedAtMs: nowMs,
      durationMs: Math.min(1200, 450 + 250 * Math.log2(1 + distance)),
      angularTarget: unwrapAngles(state.storyView, from),
    },
  };
}

export function advanceCameraNavigation(state: CameraNavigationState, nowMs: number): CameraNavigationState {
  if (state.mode !== 'returning' || !state.transition || !state.storyView) return state;
  const { from, startedAtMs, durationMs } = state.transition;
  const progress = durationMs > 0 ? Math.max(0, Math.min(1, (nowMs - startedAtMs) / durationMs)) : 1;
  const angularTarget = unwrapAngles(state.storyView, state.transition.angularTarget ?? from);
  const view = interpolateOnAngularBranch(from, state.storyView, progress, angularTarget);
  if (progress === 1) return { mode: 'follow', view, storyView: state.storyView };
  return { ...state, view, transition: { ...state.transition, angularTarget } };
}

export function isCameraNavigationGesture(interactionState?: NavigationInteractionState): boolean {
  return Boolean(
    interactionState?.isDragging ||
      interactionState?.isPanning ||
      interactionState?.isRotating ||
      interactionState?.isZooming,
  );
}
