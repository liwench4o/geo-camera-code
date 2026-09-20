import type { CameraMovement, CameraView } from '../interfaces';
import { computeTrajectoryDigest } from '../camera/trajectory/validation';
import { preserveAppliedPathAfterTimingEdit } from './retiming';
import { derivePlaybackPlan, getViewAtPlaybackTime } from './playback';
import { getSceneTimeAtPlaybackTime, type AnimationBinding } from './scene-time';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const view = (longitude: number): CameraView => ({ longitude, latitude: 0, zoom: 10, pitch: 35, bearing: 20 });
const viewport = { width: 1200, height: 800 };
const binding: AnimationBinding = {
  version: 1,
  visualizationId: 'trips',
  datasetId: 'vehicles',
  layerId: 'trips-layer',
  dataRevision: 'data-v1',
  pathDigest: 'selected-trip',
  timeRange: [1191, 1868.948],
};
const trajectory = {
  kind: 'keyframed' as const,
  sampler: 'linear-v1' as const,
  samplerVersion: '1' as const,
  durationMs: 10000,
  keyframes: [
    { timeMs: 0, view: view(0) },
    { timeMs: 1000, view: view(1) },
    { timeMs: 7000, view: view(1) },
    { timeMs: 10000, view: view(2) },
  ],
};
const camera: CameraMovement = {
  id: 'tracking',
  name: 'emphasis-tracking',
  title: 'Tracking',
  category: 'dynamic',
  animationBinding: binding,
  initViewState: view(0),
  finalViewState: view(2),
  duration: 10000,
  stay: 500,
  startDelay: 100,
  isRotating: false,
  interpolationType: 'none',
  interpolationDuration: 0,
  trajectoryPlan: {
    inputDigest: 'tracking-input',
    trajectory,
    trajectoryDigest: computeTrajectoryDigest(trajectory),
    certification: { status: 'unknown', reason: 'interval-bound-unavailable' },
  },
  authoring: {
    version: 2,
    targetId: 'trip',
    recipeId: 'emphasis-tracking',
    adjustments: {},
    planningViewport: viewport,
    timing: { duration: 10000, stay: 500, startDelay: 100 },
  },
};
const source = derivePlaybackPlan([camera], { viewport }).segments;
const sourceMovement = source.find((segment) => !segment.generated)!;

for (const requestedDuration of [2000, 20000, 0]) {
  const retimed = preserveAppliedPathAfterTimingEdit(camera, { ...camera, duration: requestedDuration, stay: 1000 });
  assert(retimed.animationBinding === binding, 'duration edits retain the complete source range and identities');
  assert(retimed.duration === Math.max(1, requestedDuration), 'a moving path retains a nonzero interval');
  assert(retimed.authoring?.timing?.duration === retimed.duration, 'explicit author timing matches the applied path');
  const committed = retimed.trajectoryPlan!.trajectory;
  assert(committed.kind === 'keyframed', 'timing edits preserve the sampled route');
  assert(
    committed.keyframes.map((frame) => frame.timeMs / retimed.duration).join(',') === '0,0.1,0.7,1',
    'all route keys and the stop interval scale uniformly',
  );
  const segments = derivePlaybackPlan([retimed], { viewport }).segments;
  const active = segments.find((segment) => !segment.generated)!;
  for (const fraction of [0, 0.05, 0.1, 0.3, 0.7, 0.95, 1]) {
    const oldTime = sourceMovement.start + fraction * camera.duration;
    const newTime = active.start + fraction * retimed.duration;
    const expected = getViewAtPlaybackTime(source, oldTime)!;
    const actual = getViewAtPlaybackTime(segments, newTime)!;
    for (const channel of ['longitude', 'latitude', 'zoom', 'pitch', 'bearing'] as const) {
      assert(
        Math.abs(actual[channel] - expected[channel]) < 1e-8,
        'retiming preserves the camera at matching progress',
      );
    }
    assert(
      Math.abs(
        getSceneTimeAtPlaybackTime(segments, newTime)!.time - getSceneTimeAtPlaybackTime(source, oldTime)!.time,
      ) < 1e-8,
      'retiming preserves camera and renderer synchronization',
    );
  }
  assert(getSceneTimeAtPlaybackTime(segments, active.end)!.time === 1868.948, 'stay holds the full source end time');
}

const delayed = preserveAppliedPathAfterTimingEdit(camera, { ...camera, startDelay: 500, stay: 2000 });
assert(delayed.trajectoryPlan === camera.trajectoryPlan, 'delay and stay changes do not regenerate the camera path');
assert(delayed.animationBinding === binding, 'delay and stay changes retain scene binding');
const introduction: CameraMovement = {
  ...camera,
  id: 'introduction',
  finalViewState: view(0),
  duration: 1000,
  stay: 0,
  startDelay: 0,
  animationBinding: undefined,
  trajectoryPlan: undefined,
  authoring: undefined,
};
const delayedSegments = derivePlaybackPlan([introduction, delayed], { viewport }).segments;
assert(getSceneTimeAtPlaybackTime(delayedSegments, 1250)!.time === 1191, 'lead-in holds the source start');
assert(getSceneTimeAtPlaybackTime(delayedSegments, 12000)!.time === 1868.948, 'extended stay holds the source end');
assert(camera.duration === 10000 && trajectory.keyframes[1].timeMs === 1000, 'timing edits leave the source untouched');
