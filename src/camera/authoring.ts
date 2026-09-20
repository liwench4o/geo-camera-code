import _ from 'lodash';
import type { CameraMovement, CameraView } from '../interfaces';
import type { CameraAuthoringSpec } from './authoring-types';
import type { CameraOptionSelection, CameraTarget, ViewportSize } from './types';

const DEFAULT_VIEWPORT: ViewportSize = { width: 800, height: 600 };

/** Save camera values, not the controller state (Deck's default world bounds contain Infinity). */
export function normalizeCameraAuthoringView(view: CameraView): CameraView {
  const next: CameraView = {
    longitude: view.longitude,
    latitude: view.latitude,
    zoom: view.zoom,
    pitch: view.pitch,
    bearing: view.bearing,
    transitionDuration: 0,
  };
  for (const key of ['minZoom', 'maxZoom', 'minPitch', 'maxPitch'] as const) {
    if (Number.isFinite(view[key])) next[key] = view[key];
  }
  // Keep explicit projection settings for validation; do not turn an invalid altitude into a valid one.
  if (view.altitude !== undefined) next.altitude = view.altitude;
  return next;
}

export function normalizeCameraAuthoringSpec(spec: CameraAuthoringSpec): CameraAuthoringSpec {
  const next = _.cloneDeep(spec);
  for (const key of ['initial', 'final'] as const) {
    if (next.manualViews?.[key]) next.manualViews[key] = normalizeCameraAuthoringView(next.manualViews[key]);
  }
  if (next.source) next.source.view = normalizeCameraAuthoringView(next.source.view);
  if (next.composition?.context?.kind === 'view') {
    next.composition.context.view = normalizeCameraAuthoringView(next.composition.context.view);
  }
  return next;
}

/** Old stories cannot distinguish generated values from edits, so retain saved views and timing. */
export function getCameraAuthoringSpec(
  camera: CameraMovement,
  fallbackViewport: ViewportSize = DEFAULT_VIEWPORT,
): CameraAuthoringSpec {
  if (camera.authoring) return normalizeCameraAuthoringSpec(camera.authoring);
  const target = camera.targetSnapshot as CameraTarget | undefined;
  const trajectory = camera.trajectoryPlan?.trajectory;
  return {
    version: 1,
    targetId: camera.targetId ?? target?.id ?? 'view-fallback',
    recipeId: camera.recipeId ?? camera.recommendation?.recipeId ?? camera.name,
    snapshotRevision: target?.snapshotEnvelope?.revision,
    sceneRevision: target?.snapshotEnvelope?.provenance.sceneRevision,
    adjustments: {},
    manualViews: { initial: editableView(camera.initViewState), final: editableView(camera.finalViewState) },
    timing: { duration: camera.duration, stay: camera.stay, startDelay: camera.startDelay },
    planningViewport: _.cloneDeep(trajectory?.kind === 'legacy-fly' ? trajectory.viewport : fallbackViewport),
  };
}

export interface PrepareCameraAuthoringOptions {
  mode: 'readapt' | 'restore' | 'replace';
  recipeId?: string;
  optionSelection?: CameraOptionSelection;
  viewport?: ViewportSize;
}

/** Prepare intent before planning; the planner owns regenerated views and trajectory. */
export function prepareCameraAuthoring(
  camera: CameraMovement,
  options: PrepareCameraAuthoringOptions,
): CameraAuthoringSpec {
  const spec = getCameraAuthoringSpec(camera, options.viewport);
  if (options.mode === 'restore') {
    spec.adjustments = {};
    delete spec.manualViews;
  }
  if (options.recipeId !== undefined) spec.recipeId = options.recipeId;
  if (options.mode === 'replace') spec.optionSelection = _.cloneDeep(options.optionSelection);
  if (options.viewport) spec.planningViewport = { ...options.viewport };
  return spec;
}

function uncheckedCamera(camera: CameraMovement): CameraMovement {
  return {
    ...camera,
    trajectoryPlan: undefined,
    framingReport: {
      status: 'incomplete',
      scope: camera.framingReport?.scope ?? 'whole-shot',
      sampleCount: 0,
      messages: ['Camera changes need a new framing check.'],
    },
  };
}

/** Merge only author-owned metadata after the candidate has been regenerated. */
export function preserveCameraMetadata(current: CameraMovement, candidate: CameraMovement): CameraMovement {
  // A prepared candidate includes deliberate changes such as releasing duration for a new pace.
  const timing = candidate.authoring
    ? candidate.authoring.timing
    : current.authoring
      ? current.authoring.timing
      : getCameraAuthoringSpec(current).timing;
  const result: CameraMovement = {
    ..._.cloneDeep(candidate),
    id: current.id ?? candidate.id,
    annotation: _.cloneDeep(current.annotation),
    timelineTargetName: current.timelineTargetName,
    duration: timing?.duration ?? candidate.duration,
    stay: timing?.stay ?? candidate.stay,
    startDelay: timing?.startDelay ?? candidate.startDelay,
  };
  if (result.authoring) result.authoring.timing = _.cloneDeep(timing);
  // A plan generated with a different duration cannot remain the playback authority.
  return result.duration === candidate.duration ? result : uncheckedCamera(result);
}

function editableView(view: CameraView): CameraView {
  return normalizeCameraAuthoringView(view);
}

/** Record just the edited endpoint; preserving the other side is essential for successive edits. */
export function recordCameraManualView(
  camera: CameraMovement,
  key: 'initial' | 'final',
  view: CameraView,
): CameraMovement {
  const authoring = getCameraAuthoringSpec(camera);
  const nextView = editableView(view);
  authoring.manualViews = { ...authoring.manualViews, [key]: _.cloneDeep(nextView) };
  const result = uncheckedCamera({
    ..._.cloneDeep(camera),
    authoring,
    [key === 'initial' ? 'initViewState' : 'finalViewState']: nextView,
  });
  // Endpoint edits become a manual camera path; the old renderer clock is no longer authoritative.
  delete result.animationBinding;
  return result;
}

export function isCameraAuthoringStale(
  camera: CameraMovement,
  current: { snapshotRevision?: string; sceneRevision?: string; viewport?: ViewportSize },
): boolean {
  const spec = camera.authoring;
  if (!spec) return false;
  if (current.snapshotRevision !== undefined && current.snapshotRevision !== spec.snapshotRevision) return true;
  if (current.sceneRevision !== undefined && current.sceneRevision !== spec.sceneRevision) return true;
  return (
    !!current.viewport &&
    Math.abs(
      current.viewport.width / current.viewport.height - spec.planningViewport.width / spec.planningViewport.height,
    ) > 1e-6
  );
}

/** Cropping is an author choice. Non-finite values and invalid projections are not usable cameras. */
export function getCameraValidationMessages(camera: CameraMovement): string[] {
  const errors: string[] = [];
  for (const [label, view] of [
    ['Start', camera.initViewState],
    ['End', camera.finalViewState],
  ] as const) {
    if (![view.longitude, view.latitude, view.zoom, view.pitch, view.bearing].every(Number.isFinite)) {
      errors.push(`${label} view contains an invalid number.`);
    } else if (
      Math.abs(view.latitude) > 85.05112878 ||
      view.pitch < 0 ||
      view.pitch > 85 ||
      view.zoom < -2 ||
      view.zoom > 24
    ) {
      errors.push(`${label} view is outside the map projection limits.`);
    }
  }
  if ([camera.duration, camera.stay, camera.startDelay ?? 0].some((value) => !Number.isFinite(value) || value < 0)) {
    errors.push('Camera timing must use finite, non-negative values.');
  }
  return errors;
}
