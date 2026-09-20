import type { CameraMovement, CameraView } from '../interfaces';
import type { CameraAuthoringSpec } from '../camera/authoring-types';
import { getCameraAuthoringSpec, normalizeCameraAuthoringSpec, prepareCameraAuthoring } from '../camera/authoring';
import { computeTrajectoryDigest } from '../camera/trajectory/validation';
import { derivePlaybackPlan, getViewAtPlaybackTime } from './playback';
import { preserveAppliedPathAfterTimingEdit } from './retiming';
import { createStoryJson, parseStoryJson } from './serialization';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const viewport = { width: 1440, height: 900 };
const view = (longitude = 10, bearing = 0): CameraView => ({ longitude, latitude: 20, zoom: 10, pitch: 35, bearing });

function intent(): CameraAuthoringSpec {
  return {
    version: 2,
    targetId: 'city',
    recipeId: 'overview-orbit',
    adjustments: { framingTightness: -0.2 },
    motion: { zoomDelta: 1.5, startPitch: 35, endPitch: 60, startBearing: 20, bearingSweep: 360 },
    composition: {
      context: { kind: 'view', view: view(12), viewport: { ...viewport } },
      anchor: 'visual',
      offsetRatio: [0.1, -0.2],
    },
    source: { kind: 'previous-camera', view: view(8) },
    transition: 'cut',
    manualViews: { final: view(15) },
    timing: { duration: 1000, stay: 250, startDelay: 100 },
    planningViewport: { ...viewport },
  };
}

function movement(): CameraMovement {
  const trajectory = {
    kind: 'keyframed' as const,
    sampler: 'linear-v1' as const,
    samplerVersion: '1' as const,
    durationMs: 1000,
    keyframes: [
      { timeMs: 0, view: view(10) },
      { timeMs: 500, view: view(12, 180) },
      { timeMs: 1000, view: view(15) },
    ],
  };
  return {
    id: 'intent-camera',
    name: 'overview-orbit',
    title: 'Orbit',
    category: 'overview',
    initViewState: view(10),
    finalViewState: view(15),
    duration: 1000,
    stay: 250,
    startDelay: 100,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
    authoring: intent(),
    trajectoryPlan: {
      inputDigest: 'committed-input',
      trajectory,
      trajectoryDigest: computeTrajectoryDigest(trajectory),
      certification: { status: 'unknown', reason: 'interval-bound-unavailable' },
    },
  };
}

function testNormalizesAllViewSnapshotsAndRestoreKeepsIntent() {
  const controllerView = {
    ...view(),
    minZoom: 0,
    maxZoom: 24,
    minPitch: 0,
    maxPitch: 75,
    altitude: 1.5,
    maxBounds: [
      [-Infinity, -90],
      [Infinity, 90],
    ],
    width: 400,
    transitionDuration: 1000,
    transitionEasing: (t: number) => t,
  };
  const source = intent();
  source.source!.view = controllerView;
  source.composition!.context = { kind: 'view', view: controllerView, viewport: { ...viewport } };
  source.manualViews = { final: controllerView };
  const normalized = normalizeCameraAuthoringSpec(source);
  assert(normalized.composition?.context?.kind === 'view', 'context keeps its reference-view shape');
  for (const snapshot of [
    normalized.source!.view,
    normalized.composition.context.view,
    normalized.manualViews!.final!,
  ]) {
    assert(!('maxBounds' in snapshot) && !('width' in snapshot), 'every snapshot strips transient controller state');
    assert(
      snapshot.transitionDuration === 0 && snapshot.transitionEasing === undefined,
      'snapshot cancels transition runtime state',
    );
    assert(
      snapshot.minZoom === 0 && snapshot.maxPitch === 75 && snapshot.altitude === 1.5,
      'snapshot retains semantic finite projection extras',
    );
  }
  const camera = { ...movement(), authoring: normalized };
  const restored = prepareCameraAuthoring(camera, { mode: 'restore', viewport: { width: 800, height: 600 } });
  assert(
    restored.manualViews === undefined && Object.keys(restored.adjustments).length === 0,
    'restore clears endpoint locks and old adjustments',
  );
  for (const key of ['motion', 'composition', 'source', 'transition'] as const) {
    assert(JSON.stringify(restored[key]) === JSON.stringify(normalized[key]), `restore keeps ${key}`);
  }
  assert(source.source!.view.transitionDuration === 1000, 'normalization leaves original snapshot untouched');
  const frozenLongitude = normalized.source!.view.longitude;
  controllerView.longitude = 40;
  assert(
    normalized.source!.view.longitude === frozenLongitude,
    'source is captured as values instead of a live camera reference',
  );
}

function testV2RoundTripKeepsIntentAndCommittedPathAuthoritative() {
  const camera = movement();
  camera.authoring!.source!.view = { ...view(8), minZoom: 0, maxPitch: 75, altitude: 1.5 };
  if (camera.authoring!.composition!.context?.kind === 'view')
    camera.authoring!.composition!.context.view = { ...view(12), maxZoom: 20, minPitch: 0, altitude: 1.5 };
  camera.authoring!.manualViews = { final: { ...view(15), minZoom: 1, maxPitch: 70, altitude: 1.5 } };
  const story = createStoryJson([camera]);
  assert(story.version === 2, 'new intent exports in Story V2');
  const imported = parseStoryJson(JSON.parse(JSON.stringify(story)));
  assert(imported.ok, 'new intent is readable');
  const restored = imported.cameras[0];
  assert(restored.authoring?.transition === 'cut', 'legacy cut metadata survives the Story V2 round trip');
  assert(
    JSON.stringify(createStoryJson(imported.cameras)) === JSON.stringify(story),
    'v2 authoring re-export is byte stable',
  );
  assert(
    restored.authoring?.source?.view.altitude === 1.5 && restored.authoring.manualViews?.final?.maxPitch === 70,
    'source and manual semantic extras survive persistence',
  );
  assert(
    restored.authoring?.composition?.context?.kind === 'view' &&
      restored.authoring.composition.context.view.maxZoom === 20,
    'reference view extras survive persistence',
  );
  assert(
    restored.trajectoryPlan?.trajectoryDigest === camera.trajectoryPlan?.trajectoryDigest,
    'import preserves the committed trajectory digest',
  );
  const playback = derivePlaybackPlan([restored], { viewport: { width: 400, height: 1000 } });
  assert(
    getViewAtPlaybackTime(playback.segments, 500)?.bearing === 180,
    'committed midpoint wins over intent or viewport replanning',
  );
  const originalSource = JSON.stringify(restored.authoring.source);
  const originalContext = JSON.stringify(restored.authoring.composition.context);
  const retimed = preserveAppliedPathAfterTimingEdit(restored, { ...restored, duration: 2000, startDelay: 700 });
  assert(JSON.stringify(retimed.authoring!.source) === originalSource, 'retiming preserves frozen source values');
  assert(
    JSON.stringify(retimed.authoring!.composition!.context) === originalContext,
    'retiming preserves frozen context values',
  );
  assert(
    getViewAtPlaybackTime(derivePlaybackPlan([retimed]).segments, 1000)?.bearing === 180,
    'retiming scales committed path timing',
  );
  const secondImport = parseStoryJson(JSON.parse(JSON.stringify(createStoryJson([retimed]))));
  assert(
    secondImport.ok && secondImport.cameras[0].authoring?.source?.view.longitude === 8,
    'retimed re-export retains original source snapshot',
  );
}

function testVersionAndIntentValidation() {
  const valid = createStoryJson([movement()]);
  assert(valid.version === 2, 'validation fixture uses Story V2');
  const change = (mutate: (authoring: CameraAuthoringSpec) => void) => {
    const copy = JSON.parse(JSON.stringify(valid)) as typeof valid;
    mutate(copy.cameras[0].movement.authoring!);
    return copy;
  };
  const invalid: Array<[string, (authoring: CameraAuthoringSpec) => void]> = [
    [
      'old version with new intent',
      (a) => {
        a.version = 1;
      },
    ],
    [
      'version',
      (a) => {
        (a as { version: number }).version = 3;
      },
    ],
    [
      'start pitch',
      (a) => {
        a.motion!.startPitch = -0.01;
      },
    ],
    [
      'end pitch',
      (a) => {
        a.motion!.endPitch = 75.01;
      },
    ],
    [
      'zoom change lower bound',
      (a) => {
        a.motion!.zoomDelta = -8.01;
      },
    ],
    [
      'zoom change upper bound',
      (a) => {
        a.motion!.zoomDelta = 8.01;
      },
    ],
    [
      'bearing lower bound',
      (a) => {
        a.motion!.startBearing = -360.01;
      },
    ],
    [
      'bearing upper bound',
      (a) => {
        a.motion!.startBearing = 360.01;
      },
    ],
    [
      'sweep lower bound',
      (a) => {
        a.motion!.bearingSweep = -720.01;
      },
    ],
    [
      'sweep upper bound',
      (a) => {
        a.motion!.bearingSweep = 720.01;
      },
    ],
    [
      'nonfinite intent',
      (a) => {
        a.motion!.zoomDelta = NaN;
      },
    ],
    [
      'anchor',
      (a) => {
        (a.composition as { anchor: string }).anchor = 'sky';
      },
    ],
    [
      'offset',
      (a) => {
        a.composition!.offsetRatio = [0.4501, 0];
      },
    ],
    [
      'offset shape',
      (a) => {
        (a.composition as { offsetRatio: number[] }).offsetRatio = [0];
      },
    ],
    [
      'transition',
      (a) => {
        (a as { transition: string }).transition = 'blend';
      },
    ],
    [
      'source kind',
      (a) => {
        (a.source as { kind: string }).kind = 'live-view';
      },
    ],
    [
      'source latitude',
      (a) => {
        a.source!.view.latitude = 90;
      },
    ],
    [
      'source zoom',
      (a) => {
        a.source!.view.zoom = 24.01;
      },
    ],
    [
      'source altitude',
      (a) => {
        a.source!.view.altitude = 0;
      },
    ],
    [
      'source nonfinite extra',
      (a) => {
        a.source!.view.maxPitch = Infinity;
      },
    ],
    [
      'reference pitch',
      (a) => {
        const context = a.composition!.context!;
        if (context.kind === 'view') context.view.pitch = 86;
      },
    ],
    [
      'reference viewport width',
      (a) => {
        const context = a.composition!.context!;
        if (context.kind === 'view') context.viewport.width = 0;
      },
    ],
    [
      'reference viewport height',
      (a) => {
        const context = a.composition!.context!;
        if (context.kind === 'view') context.viewport.height = -1;
      },
    ],
    [
      'zero-width bounds',
      (a) => {
        a.composition!.context = { kind: 'bounds', bounds: [10, 0, 10, 20] };
      },
    ],
    [
      'zero-height bounds',
      (a) => {
        a.composition!.context = { kind: 'bounds', bounds: [10, 0, 20, 0] };
      },
    ],
    [
      'inverted latitude bounds',
      (a) => {
        a.composition!.context = { kind: 'bounds', bounds: [10, 20, 20, 0] };
      },
    ],
    [
      'mercator bounds',
      (a) => {
        a.composition!.context = { kind: 'bounds', bounds: [10, 0, 20, 90] };
      },
    ],
    [
      'multiple-world bounds',
      (a) => {
        a.composition!.context = { kind: 'bounds', bounds: [-200, 0, 200, 20] };
      },
    ],
  ];
  for (const [label, mutate] of invalid) assert(!parseStoryJson(change(mutate)).ok, `${label} must be rejected`);
  for (const kind of ['current-view', 'previous-camera', 'reference-view'] as const) {
    assert(
      parseStoryJson(
        change((a) => {
          a.source!.kind = kind;
        }),
      ).ok,
      `${kind} is supported`,
    );
  }
  for (const bounds of [
    [170, -10, -170, 20],
    [-180, -85, 180, 85],
    [190, 10, 200, 20],
  ]) {
    assert(
      parseStoryJson(
        change((a) => {
          a.composition!.context = { kind: 'bounds', bounds: bounds as [number, number, number, number] };
        }),
      ).ok,
      'antimeridian and unwrapped context bounds are valid',
    );
  }
  for (const direction of [-1, 1]) {
    assert(
      parseStoryJson(
        change((a) => {
          a.motion = {
            zoomDelta: direction * 8,
            startPitch: 0,
            endPitch: 75,
            startBearing: direction * 360,
            bearingSweep: direction * 720,
          };
          a.composition!.offsetRatio = [direction * 0.45, -direction * 0.45];
        }),
      ).ok,
      'intent range boundaries are inclusive',
    );
  }
}

function testLegacySavedEndpointsStayLockedAndV1RangesStayReadable() {
  const camera = movement();
  delete camera.authoring;
  delete camera.trajectoryPlan;
  const imported = parseStoryJson([camera]);
  assert(imported.ok && imported.legacy, 'legacy array remains importable');
  const authoring = getCameraAuthoringSpec(imported.cameras[0]);
  assert(
    authoring.version === 1 &&
      authoring.manualViews?.initial?.longitude === 10 &&
      authoring.manualViews?.final?.longitude === 15,
    'legacy starts and ends remain manual locks',
  );
  assert(authoring.timing?.duration === 1000 && authoring.timing.startDelay === 100, 'legacy timing remains explicit');
  authoring.adjustments = { pitchTarget: 85, offsetRatio: [-1, 1] };
  camera.authoring = authoring;
  assert(parseStoryJson(JSON.parse(JSON.stringify(createStoryJson([camera])))).ok, 'v1 ranges remain accepted');
}

const failures: string[] = [];
for (const test of [
  testNormalizesAllViewSnapshotsAndRestoreKeepsIntent,
  testV2RoundTripKeepsIntentAndCommittedPathAuthoritative,
  testVersionAndIntentValidation,
  testLegacySavedEndpointsStayLockedAndV1RangesStayReadable,
]) {
  try {
    test();
  } catch (error) {
    failures.push(`${test.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
assert(failures.length === 0, failures.join('\n'));
