import type { CameraMovement, CameraView } from '../interfaces';
import { digestCanonical } from './geometry/canonical-digest';
import { compileLegacyMovementTrajectory } from './trajectory/legacy';
import { computeTrajectoryDigest } from './trajectory/validation';
import {
  getCameraAuthoringSpec,
  getCameraValidationMessages,
  isCameraAuthoringStale,
  prepareCameraAuthoring,
  preserveCameraMetadata,
  recordCameraManualView,
} from './authoring';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const view = (longitude: number): CameraView => ({ longitude, latitude: 20, zoom: 6, pitch: 30, bearing: 10 });
function camera(): CameraMovement {
  return {
    id: 'authored-shot',
    name: 'overview-static',
    title: 'Overview',
    category: 'overview',
    targetId: 'target',
    recipeId: 'overview-static',
    initViewState: view(10),
    finalViewState: view(20),
    duration: 4000,
    stay: 1500,
    startDelay: 250,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
    annotation: { delay: 500, duration: 2000, text: 'Important detail' },
    authoring: {
      version: 1,
      targetId: 'target',
      recipeId: 'overview-static',
      snapshotRevision: 'data-1',
      sceneRevision: 'style-1',
      adjustments: { framingTightness: -0.4, speedScale: 0.75 },
      manualViews: { initial: view(12) },
      timing: { duration: 4000, stay: 1500, startDelay: 250 },
      planningViewport: { width: 800, height: 600 },
    },
  };
}

const current = camera();
const controllerView = {
  ...view(30),
  minZoom: 0,
  maxZoom: 20,
  minPitch: 0,
  maxPitch: 75,
  altitude: 1.5,
  maxBounds: [
    [-Infinity, -90],
    [Infinity, 90],
  ],
  position: [0, 0, 0],
  width: 600,
  height: 400,
  normalize: true,
};
const dragged = recordCameraManualView(current, 'final', controllerView);
assert(
  !('maxBounds' in dragged.authoring!.manualViews!.final!),
  'saved manual views must omit Deck controller maxBounds with infinite world limits',
);
assert(
  dragged.authoring!.manualViews!.final!.maxPitch === 75 && dragged.authoring!.manualViews!.final!.altitude === 1.5,
  'supported finite view limits and altitude remain available',
);
digestCanonical(dragged.authoring);
const restored = prepareCameraAuthoring(current, { mode: 'restore' });
assert(Object.keys(restored.adjustments).length === 0, 'restore clears camera adjustments');
assert(restored.manualViews === undefined, 'restore clears manual viewpoints');
assert(restored.timing?.duration === 4000 && restored.timing.stay === 1500, 'restore preserves explicit timing');
assert(current.authoring?.manualViews?.initial?.longitude === 12, 'restore does not mutate applied camera');

const readapted = prepareCameraAuthoring(current, { mode: 'readapt', viewport: { width: 1200, height: 600 } });
assert(readapted.manualViews?.initial?.longitude === 12, 'readapt preserves manual viewpoint');
assert(readapted.adjustments.framingTightness === -0.4, 'readapt preserves simple adjustment');
assert(readapted.planningViewport.width === 1200, 'explicit readapt accepts the latest planning canvas');

const replacement = prepareCameraAuthoring(current, { mode: 'replace', recipeId: 'overview-arc' });
assert(replacement.recipeId === 'overview-arc', 'replacement changes template');
assert(replacement.manualViews?.initial?.longitude === 12, 'replacement retains authored view');

const candidate = { ...camera(), id: 'generated', duration: 9000, annotation: undefined };
const merged = preserveCameraMetadata(current, candidate);
assert(merged.id === 'authored-shot', 'replacement keeps camera identity');
assert(merged.annotation?.text === 'Important detail', 'replacement keeps annotation');
assert(
  merged.duration === 4000 && merged.stay === 1500 && merged.startDelay === 250,
  'replacement keeps explicit time',
);

const automatic = camera();
automatic.authoring = { ...automatic.authoring!, timing: undefined };
assert(
  preserveCameraMetadata(automatic, { ...candidate, authoring: { ...candidate.authoring!, timing: undefined } })
    .duration === 9000,
  'unmodified automatic duration can follow new template',
);
assert(
  preserveCameraMetadata(current, { ...candidate, authoring: { ...candidate.authoring!, timing: { stay: 1500 } } })
    .duration === 9000,
  'an intentional pace change can release the old explicit duration',
);

const legacy = { ...camera(), authoring: undefined };
assert(getCameraAuthoringSpec(legacy).timing?.duration === 4000, 'legacy timing is conservatively retained');
assert(
  getCameraAuthoringSpec(legacy).manualViews?.initial?.longitude === 10,
  'legacy start view is conservatively retained',
);
assert(
  getCameraAuthoringSpec(legacy).manualViews?.final?.longitude === 20,
  'legacy end view is conservatively retained',
);

const edited = recordCameraManualView(current, 'final', {
  ...view(30),
  transitionDuration: 500,
  transitionEasing: (t: number) => t,
});
assert(edited.authoring?.manualViews?.initial?.longitude === 12, 'editing final retains initial override');
assert(edited.authoring?.manualViews?.final?.longitude === 30, 'edited final is explicitly recorded');
assert(edited.finalViewState.longitude === 30, 'manual edit updates applied endpoint');
assert(
  edited.authoring?.manualViews?.final?.transitionEasing === undefined,
  'recorded view contains no transition function',
);
assert(edited.framingReport?.status === 'incomplete', 'unchecked edit must not inherit passing framing report');

const tracking = Object.assign(camera(), {
  animationBinding: {
    version: 1 as const,
    visualizationId: 'trips',
    datasetId: 'vehicles',
    layerId: 'trips-layer',
    dataRevision: 'vehicles-v1',
    pathDigest: 'selected-trip',
    timeRange: [100, 200] as [number, number],
  },
});
const trackingTrajectory = compileLegacyMovementTrajectory(tracking, { width: 800, height: 600 }, 'linear');
tracking.trajectoryPlan = {
  inputDigest: 'bound-tracking-input',
  trajectory: trackingTrajectory,
  trajectoryDigest: computeTrajectoryDigest(trackingTrajectory),
  certification: { status: 'unknown', reason: 'interval-bound-unavailable' },
};
const detached = recordCameraManualView(tracking, 'final', view(35));
assert(!('animationBinding' in detached), 'a spatial endpoint edit explicitly detaches scene animation');
assert(detached.trajectoryPlan === undefined, 'detached camera releases its previously applied tracking trajectory');
assert(detached.finalViewState.longitude === 35, 'detached camera preserves the edited endpoint');
assert(tracking.animationBinding.timeRange[0] === 100, 'manual edits do not mutate the original animation binding');
assert(tracking.trajectoryPlan !== undefined, 'manual edits do not clear the source trajectory');

assert(
  !isCameraAuthoringStale(current, { snapshotRevision: 'data-1', sceneRevision: 'style-1' }),
  'matching target is fresh',
);
assert(isCameraAuthoringStale(current, { snapshotRevision: 'data-2' }), 'changed target requires explicit readapt');
assert(isCameraAuthoringStale(current, { sceneRevision: 'style-2' }), 'changed visual style requires explicit readapt');
assert(
  isCameraAuthoringStale(current, { viewport: { width: 1200, height: 600 } }),
  'changed aspect ratio requires explicit readapt',
);
assert(
  !isCameraAuthoringStale(current, { viewport: { width: 400, height: 300 } }),
  'same aspect ratio preserves framing',
);

const crop = {
  ...current,
  framingReport: { status: 'warning' as const, scope: 'whole-shot' as const, sampleCount: 5, messages: ['Cropped'] },
};
assert(getCameraValidationMessages(crop).length === 0, 'manual crop warning does not block use');
assert(
  getCameraValidationMessages({ ...current, initViewState: { ...view(10), longitude: NaN } }).length > 0,
  'non-finite camera blocks use',
);
assert(
  getCameraValidationMessages({ ...current, finalViewState: { ...view(10), latitude: 90 } }).length > 0,
  'invalid projection blocks use',
);
assert(getCameraValidationMessages({ ...current, duration: -1 }).length > 0, 'negative duration blocks use');
for (const zoom of [-2.01, 24.01]) {
  assert(
    getCameraValidationMessages({ ...current, initViewState: { ...view(0), zoom } }).length > 0,
    'camera zoom must stay within replay projection bounds',
  );
}
for (const zoom of [-2, 24]) {
  assert(
    getCameraValidationMessages({ ...current, initViewState: { ...view(0), zoom } }).length === 0,
    'replay zoom boundaries remain valid',
  );
}
