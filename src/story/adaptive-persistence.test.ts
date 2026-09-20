import type { CameraMovement } from '../interfaces';
import type { CameraAuthoringSpec, CameraFramingReport } from '../camera/authoring-types';
import { compileLegacyMovementTrajectory } from '../camera/trajectory/legacy';
import { compileRuntimeTrajectory } from '../camera/trajectory/sampler';
import { computeTrajectoryDigest } from '../camera/trajectory/validation';
import { digestCanonical } from '../camera/geometry/canonical-digest';
import { derivePlaybackPlan, getStoppedPlaybackView, getViewAtPlaybackTime } from './playback';
import { createStoryJson, parseStoryJson } from './serialization';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const viewport = { width: 1440, height: 900 };
const view = (longitude: number, bearing = 0) => ({ longitude, latitude: 30, zoom: 10, pitch: 35, bearing });

function movement(): CameraMovement {
  return {
    id: 'authored',
    name: 'transition',
    title: 'Transition',
    category: 'transition',
    initViewState: view(0),
    finalViewState: view(40),
    duration: 1000,
    stay: 0,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
  };
}

function testDefaultPlaybackUsesFlySamplerForPauseAndSeek() {
  const camera = movement();
  const segments = derivePlaybackPlan([camera], { viewport }).segments;
  const expected = compileRuntimeTrajectory(compileLegacyMovementTrajectory(camera, viewport, 'fly'));
  assert(expected.status === 'ok', 'reference fly compiles');
  const halfway = expected.value.sample(500);
  assert(halfway.zoom < 8, 'long-distance fly should retreat from the endpoint zoom');
  assert(segments[0].trajectory, 'default playback must compile the shared trajectory');
  const sought = getViewAtPlaybackTime(segments, 500);
  for (const channel of ['longitude', 'latitude', 'zoom', 'pitch', 'bearing'] as const) {
    assert(sought?.[channel] === halfway[channel], `seek uses fly sample for ${channel}`);
  }
  assert(getStoppedPlaybackView(segments, 500, camera.finalViewState).zoom === halfway.zoom, 'pause uses same zoom');
}

function testAuthoredCropsAndUncheckedMotionRemainPlayableAndRoundTrip() {
  for (const certification of [
    { status: 'unsafe' as const, worstTimeMs: 500, slackPx: -20, violations: [] },
    { status: 'unknown' as const, reason: 'interval-bound-unavailable' as const },
  ]) {
    const camera = movement();
    const trajectory = {
      kind: 'keyframed' as const,
      sampler: 'linear-v1' as const,
      samplerVersion: '1' as const,
      durationMs: 1000,
      keyframes: [
        { timeMs: 0, view: view(0) },
        { timeMs: 500, view: view(20, 90) },
        { timeMs: 1000, view: view(40) },
      ],
    };
    camera.trajectoryPlan = {
      inputDigest: 'authored-input',
      trajectory,
      trajectoryDigest: computeTrajectoryDigest(trajectory),
      certification,
    };
    const plan = derivePlaybackPlan([camera], { viewport });
    assert(getViewAtPlaybackTime(plan.segments, 500)?.bearing === 90, 'author-approved path survives warning status');
    const story = createStoryJson([camera], { trajectoryEnabled: true, viewport });
    const parsed = parseStoryJson(JSON.parse(JSON.stringify(story)));
    assert(parsed.ok, 'authored warning trajectory round trips');
    assert(
      parsed.cameras[0].trajectoryPlan?.trajectoryDigest === camera.trajectoryPlan.trajectoryDigest,
      'trajectory is retained',
    );
  }
}

function authoredCamera(): CameraMovement {
  const camera = movement();
  const authoring: CameraAuthoringSpec = {
    version: 1,
    targetId: 'route-1',
    snapshotRevision: 'snapshot-2',
    sceneRevision: 'scene-3',
    recipeId: 'transition',
    adjustments: { framingTightness: -0.3, pitchTarget: 35, speedScale: 1.25, safetyMarginRatio: 0.1 },
    manualViews: { initial: camera.initViewState },
    timing: { duration: 1000, stay: 0 },
    planningViewport: viewport,
  };
  const framingReport: CameraFramingReport = {
    status: 'warning',
    scope: 'whole-shot',
    sampleCount: 10,
    minMarginPx: -20,
    worstTimeMs: 500,
    messages: ['The author kept this close-up.'],
    inputRevision: 'snapshot-2',
  };
  return { ...camera, authoring, framingReport };
}

function testAuthoringAndEngineeringReportRoundTripSeparately() {
  const source = authoredCamera();
  const story = createStoryJson([source]);
  assert(story.version === 2, 'default writer must save applied trajectories in Story V2');
  assert(story.cameras[0].movement.authoring?.manualViews?.initial?.longitude === 0, 'manual endpoint is saved');
  const imported = parseStoryJson(JSON.parse(JSON.stringify(story)));
  assert(imported.ok, 'authoring and observations are valid import data');
  assert(
    digestCanonical(imported.cameras[0].authoring) === digestCanonical(source.authoring),
    'author intent round trips',
  );
  assert(imported.cameras[0].framingReport?.status === 'warning', 'crop warning is retained separately');
  assert(
    imported.cameras[0].trajectoryPlan?.certification.status === 'legacy-unverified',
    'engineering report does not imply certification',
  );
  const roundTrip = JSON.stringify(createStoryJson(imported.cameras));
  assert(roundTrip === JSON.stringify(story), 're-export stays byte stable');
}

function testAuthoringImportRejectsMalformedRanges() {
  const valid = createStoryJson([authoredCamera()], { trajectoryEnabled: true, viewport });
  assert(valid.version === 2, 'fixture is Story V2');
  const cases: Array<(camera: CameraMovement) => void> = [
    (camera) => {
      camera.authoring!.adjustments.speedScale = 0;
    },
    (camera) => {
      camera.authoring!.adjustments.framingTightness = 2;
    },
    (camera) => {
      camera.authoring!.adjustments.safetyMarginRatio = 0.8;
    },
    (camera) => {
      camera.authoring!.planningViewport.width = 0;
    },
    (camera) => {
      camera.authoring!.manualViews!.initial!.latitude = 90;
    },
    (camera) => {
      camera.authoring!.manualViews!.initial!.zoom = 25;
    },
    (camera) => {
      camera.authoring!.timing!.duration = -1;
    },
    (camera) => {
      camera.framingReport!.sampleCount = -1;
    },
    (camera) => {
      camera.framingReport!.worstTimeMs = 1001;
    },
  ];
  for (const mutate of cases) {
    const copy = JSON.parse(JSON.stringify(valid)) as typeof valid;
    mutate(copy.cameras[0].movement);
    assert(!parseStoryJson(copy).ok, 'malformed authoring/report ranges must be rejected');
  }
}

testDefaultPlaybackUsesFlySamplerForPauseAndSeek();
testAuthoredCropsAndUncheckedMotionRemainPlayableAndRoundTrip();
testAuthoringAndEngineeringReportRoundTripSeparately();
testAuthoringImportRejectsMalformedRanges();
