import assert from 'node:assert/strict';
import type { CameraView } from '../interfaces';
import { MERCATOR_LATITUDE_LIMIT, normalizeLongitude, shortestAngle } from '../camera/geometry/geo-wrap';
import {
  advanceCameraNavigation,
  createCameraNavigation,
  interpolateNavigationView,
  isCameraNavigationGesture,
  resumeCameraFollow,
  takeCameraControl,
  updateStoryView,
} from './camera-navigation';

const channels = ['longitude', 'latitude', 'zoom', 'pitch', 'bearing'] as const;

function view(overrides: Partial<CameraView> = {}): CameraView {
  return { longitude: 10, latitude: 25, zoom: 7, pitch: 30, bearing: 0, ...overrides };
}

function assertView(actual: CameraView, expected: CameraView, message: string) {
  for (const channel of channels) {
    const difference =
      channel === 'longitude' || channel === 'bearing'
        ? shortestAngle(actual[channel], expected[channel])
        : actual[channel] - expected[channel];
    assert(Math.abs(difference) < 1e-8, `${message}: ${channel} ${actual[channel]} !== ${expected[channel]}`);
  }
}

function assertCleanView(actual: CameraView) {
  assert.equal(actual.transitionDuration ?? 0, 0, 'navigation samples never start a deck transition');
  for (const property of [
    'transitionInterpolator',
    'transitionEasing',
    'transitionInterruption',
    'onTransitionStart',
    'onTransitionInterrupt',
    'onTransitionEnd',
  ] as const) {
    assert.equal(actual[property], undefined, `${property} is stripped from displayed and stored views`);
  }
}

function testStartsFollowingWithoutInventingAStoryTarget() {
  const initial = view({ transitionDuration: 1500, onTransitionEnd: () => undefined });
  const state = createCameraNavigation(initial);
  assert.equal(state.mode, 'follow');
  assertView(state.view, initial, 'initial camera stays in place');
  assertCleanView(state.view);
  assert.equal(state.storyView, undefined);
  assert.equal(state.transition, undefined);
  assert.notEqual(state.view, initial, 'navigation never retains the saved input object as its displayed view');
  assert.equal(resumeCameraFollow(state, 100), state, 'there is nothing to follow until a story sample arrives');
}

function testStoryKeepsAdvancingWhileManualViewStaysFixed() {
  const initial = createCameraNavigation(view());
  const following = updateStoryView(initial, view({ longitude: 20 }), 100);
  assertView(following.view, view({ longitude: 20 }), 'following displays story samples');
  const controlled = takeCameraControl(following);
  assert.equal(controlled.mode, 'free');
  assertView(controlled.view, following.view, 'first takeover starts from the exact displayed view');
  const dragged = takeCameraControl(controlled, view({ longitude: 22, zoom: 8, bearing: 15 }));
  const next = updateStoryView(dragged, view({ longitude: 40, zoom: 11 }), 500);
  assertView(next.view, dragged.view, 'new story time cannot overwrite the manual view');
  assertView(next.storyView!, view({ longitude: 40, zoom: 11 }), 'the live follow target still advances');
  assert.equal(next.mode, 'free');
  assert.equal(advanceCameraNavigation(next, 10000), next, 'free mode has no animation work');
}

function testReturnStartsWithoutAJumpAndChasesTheLiveStoryView() {
  const manual = takeCameraControl(
    updateStoryView(createCameraNavigation(view()), view({ longitude: 20, zoom: 9 }), 0),
    view({ longitude: 0, zoom: 6 }),
  );
  const returning = resumeCameraFollow(manual, 1000);
  assert.equal(returning.mode, 'returning');
  assert(returning.transition);
  assert(returning.transition.durationMs >= 450 && returning.transition.durationMs <= 1200);
  assertView(returning.view, manual.view, 'clicking resume leaves the current frame unchanged');
  assertView(returning.transition.from, manual.view, 'return captures the visible manual frame');
  const halfTime = 1000 + returning.transition.durationMs / 2;
  const movingTarget = view({ longitude: 40, zoom: 10 });
  const middle = updateStoryView(returning, movingTarget, halfTime);
  assert.equal(middle.mode, 'returning');
  assert(Math.abs(middle.view.longitude - 20) < 1e-8, 'halfway frame blends toward the live target');
  assert(Math.abs(middle.view.zoom - 8) < 1e-8);
  assert.equal(middle.transition!.startedAtMs, 1000, 'new story samples do not restart the return clock');
  const finalTarget = view({ longitude: 45, zoom: 10.5 });
  const completed = updateStoryView(middle, finalTarget, 1000 + returning.transition.durationMs);
  assert.equal(completed.mode, 'follow');
  assertView(completed.view, finalTarget, 'return reaches the current story frame instead of the old target');
  assert.equal(completed.transition, undefined);
  assertView(
    updateStoryView(completed, view({ longitude: 46 }), 3000).view,
    view({ longitude: 46 }),
    'new story samples continue normally after completion',
  );
}

function testPausedStoryReturnCanBeInterruptedAndResumedRepeatedly() {
  const story = view({ longitude: 60, zoom: 10 });
  let state = takeCameraControl(updateStoryView(createCameraNavigation(view()), story, 0));
  state = takeCameraControl(state, view({ longitude: -20, zoom: 5 }));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = 2000 * attempt;
    const returning = resumeCameraFollow(state, now);
    assert(returning.transition);
    const middle = advanceCameraNavigation(returning, now + returning.transition.durationMs / 2);
    assert.notEqual(middle.view.longitude, returning.view.longitude, 'return advances without another story sample');
    const interrupted = takeCameraControl(middle);
    assert.equal(interrupted.mode, 'free');
    assert.equal(interrupted.transition, undefined);
    assertView(interrupted.view, middle.view, 'interrupting return preserves the latest visible frame');
    assertView(advanceCameraNavigation(interrupted, now + 10000).view, middle.view, 'old return cannot resume itself');
    state = interrupted;
  }
  const lastReturn = resumeCameraFollow(state, 7000);
  assert(lastReturn.transition);
  const completed = advanceCameraNavigation(lastReturn, 7000 + lastReturn.transition.durationMs);
  assert.equal(completed.mode, 'follow');
  assertView(completed.view, story, 'a paused story can finish returning using wall-clock frames alone');
}

function testReducedMotionAndZeroDistanceFollowImmediately() {
  const story = view({ longitude: -170, bearing: -175 });
  const state = takeCameraControl(updateStoryView(createCameraNavigation(view()), story, 0), view());
  const reducedMotion = resumeCameraFollow(state, 100, true);
  assert.equal(reducedMotion.mode, 'follow');
  assert.equal(reducedMotion.transition, undefined);
  assertView(reducedMotion.view, story, 'reduced motion follows immediately');
  const equivalentView = view({ longitude: 190, bearing: 185 });
  const noDistance = resumeCameraFollow(takeCameraControl(reducedMotion, equivalentView), 200);
  assert.equal(noDistance.mode, 'follow', 'equivalent angular positions need no artificial wait');
  assert.equal(noDistance.transition, undefined);
}

function testReturnDurationScalesWithDistanceWithinTheBounds() {
  const manual = view({ longitude: 0, latitude: 0, zoom: 3, pitch: 0 });
  const duration = (target: CameraView) => {
    const state = takeCameraControl(updateStoryView(createCameraNavigation(manual), target, 0), manual);
    const returning = resumeCameraFollow(state, 0);
    assert(returning.transition);
    return returning.transition.durationMs;
  };
  const nearby = duration({ ...manual, longitude: 0.01 });
  const distant = duration({ ...manual, longitude: 120, zoom: 12, pitch: 60, bearing: 170 });
  assert(nearby >= 450 && distant <= 1200);
  assert(distant > nearby, 'a larger displacement gets more return time');
}

function testMovingTargetKeepsItsAngularBranchAcrossTheOppositeMeridian() {
  for (const direction of [-1, 1]) {
    const from = view({ longitude: 0, bearing: 0 });
    const target = (angle: number) =>
      view({ longitude: normalizeLongitude(direction * angle), bearing: normalizeLongitude(direction * angle) });
    const returning = resumeCameraFollow(
      takeCameraControl(updateStoryView(createCameraNavigation(from), target(179.9), 0), from),
      0,
    );
    assert(returning.transition);
    const duration = returning.transition.durationMs;
    const middle = advanceCameraNavigation(returning, duration / 2);
    const before = JSON.stringify(middle);
    const crossed = updateStoryView(middle, target(180.1), duration / 2 + 16);
    for (const channel of ['longitude', 'bearing'] as const) {
      const movement = crossed.view[channel] - middle.view[channel];
      assert(
        Math.abs(movement) < 15 && Math.sign(movement) === direction,
        `moving ${channel} must keep its return branch: ${middle.view[channel]} -> ${crossed.view[channel]}`,
      );
      assert.equal(crossed.storyView![channel], target(180.1)[channel], 'the saved story sample stays canonical');
      assert(
        Math.sign(interpolateNavigationView(from, target(180.1), 0.5)[channel]) === -direction,
        'standalone interpolation still chooses the shortest arc for a fixed pair',
      );
    }
    assert.equal(JSON.stringify(middle), before, 'tracking the target cannot mutate a previous navigation state');
    const nearEnd = updateStoryView(crossed, target(180.2), duration - 1);
    const completed = advanceCameraNavigation(nearEnd, duration);
    assert.equal(completed.mode, 'follow');
    assertView(completed.view, target(180.2), 'completion reaches the live target on an equivalent angular branch');
    for (const channel of ['longitude', 'bearing'] as const) {
      assert(
        Math.abs(shortestAngle(nearEnd.view[channel], completed.view[channel])) < 0.01,
        'completion is continuous',
      );
    }
  }
}

function testInterpolationUsesProjectedLatitudeAndShortestAngularTravel() {
  const from = view({ longitude: 179, latitude: 0, bearing: 350, zoom: 3, pitch: 0 });
  const to = view({ longitude: -179, latitude: 80, bearing: 10, zoom: 9, pitch: 60 });
  assertView(interpolateNavigationView(from, to, 0), from, 'interpolation preserves the exact starting frame');
  assertView(interpolateNavigationView(from, to, 1), to, 'interpolation reaches the exact target');
  const middle = interpolateNavigationView(from, to, 0.5);
  assert(Math.abs(shortestAngle(middle.longitude, 180)) < 1e-8, 'longitude crosses the nearby date line');
  assert(Math.abs(shortestAngle(middle.bearing, 0)) < 1e-8, 'bearing rotates by 20 degrees rather than 340');
  const projectY = (latitude: number) => Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360));
  assert(Math.abs(projectY(middle.latitude) - (projectY(0) + projectY(80)) / 2) < 1e-8);
  assert.equal(middle.zoom, 6);
  assert.equal(middle.pitch, 30);
  assert(interpolateNavigationView(from, to, 0.1).zoom < 3.6, 'return starts with easing');
  const nearEnd = interpolateNavigationView(from, to, 1 - 1e-6);
  assert(Math.abs(shortestAngle(nearEnd.longitude, to.longitude)) < 1e-6);
  assert(Math.abs(shortestAngle(nearEnd.bearing, to.bearing)) < 1e-6);
}

function testInterpolationStaysFiniteAtTheMercatorLimits() {
  const from = view({ longitude: 540, latitude: 90, bearing: -540 });
  const to = view({ longitude: -540, latitude: -90, bearing: 540 });
  for (const progress of [-1, 0, 0.01, 0.5, 0.99, 1, 2]) {
    const sample = interpolateNavigationView(from, to, progress);
    for (const channel of channels) assert(Number.isFinite(sample[channel]), `${channel} remains finite`);
    assert(Math.abs(sample.latitude) <= MERCATOR_LATITUDE_LIMIT);
    assertCleanView(sample);
  }
}

function testOptionalAltitudeReturnsSmoothly() {
  const from = view({ altitude: 1 });
  const to = view({ altitude: 4 });
  assert.equal(interpolateNavigationView(from, to, 0.5).altitude, 2.5, 'camera height cannot jump to the target');
  assert.equal(
    interpolateNavigationView(view(), view({ altitude: 3 }), 0.5).altitude,
    2.25,
    'an omitted altitude starts from the map default of 1.5',
  );
  const returning = resumeCameraFollow(
    takeCameraControl(updateStoryView(createCameraNavigation(from), to, 0), from),
    0,
  );
  assert.equal(returning.mode, 'returning', 'a change in altitude needs a return even with unchanged coordinates');
  assert(returning.transition);
  assert.equal(advanceCameraNavigation(returning, returning.transition.durationMs / 2).view.altitude, 2.5);
}

function testNavigationDoesNotMutateSavedViewsOrPriorStates() {
  const callback = () => undefined;
  const source = Object.freeze(
    view({
      transitionDuration: 1200,
      transitionInterpolator: { saved: true },
      transitionEasing: (progress: number) => progress,
      transitionInterruption: 1,
      onTransitionStart: callback,
      onTransitionInterrupt: callback,
      onTransitionEnd: callback,
    }),
  );
  const before = { ...source };
  const initial = Object.freeze(createCameraNavigation(source));
  Object.freeze(initial.view);
  const following = Object.freeze(updateStoryView(initial, source, 0));
  Object.freeze(following.storyView!);
  const manual = Object.freeze(takeCameraControl(following, view({ longitude: -50 })));
  Object.freeze(manual.view);
  const returning = Object.freeze(resumeCameraFollow(manual, 500));
  assert(returning.transition);
  Object.freeze(returning.transition);
  Object.freeze(returning.transition.from);
  const advanced = advanceCameraNavigation(returning, 800);
  updateStoryView(advanced, source, 900);
  assert.deepEqual(source, before, 'saved camera transition metadata and coordinates remain untouched');
  assert.equal(initial.mode, 'follow');
  assert.equal(manual.mode, 'free');
  assert.equal(returning.transition.startedAtMs, 500);
  for (const state of [initial, following, manual, returning, advanced]) {
    assertCleanView(state.view);
    if (state.storyView) assertCleanView(state.storyView);
  }
  const mutableSource = view();
  const sampled = updateStoryView(initial, mutableSource, 0);
  mutableSource.longitude = 999;
  assert.equal(sampled.storyView!.longitude, 10, 'later changes to the caller input do not alter the saved sample');
}

function testOnlyNavigationGesturesTakeCameraOwnership() {
  assert.equal(isCameraNavigationGesture(), false);
  assert.equal(isCameraNavigationGesture({}), false);
  assert.equal(isCameraNavigationGesture({ inTransition: true }), false);
  assert.equal(isCameraNavigationGesture({ isDragging: false, isZooming: false }), false);
  for (const gesture of ['isDragging', 'isPanning', 'isRotating', 'isZooming'] as const) {
    assert.equal(isCameraNavigationGesture({ [gesture]: true }), true, `${gesture} takes control`);
    assert.equal(
      isCameraNavigationGesture({ [gesture]: true, inTransition: true }),
      true,
      `${gesture} remains a gesture during deck wheel smoothing or inertia`,
    );
  }
}

testStartsFollowingWithoutInventingAStoryTarget();
testStoryKeepsAdvancingWhileManualViewStaysFixed();
testReturnStartsWithoutAJumpAndChasesTheLiveStoryView();
testPausedStoryReturnCanBeInterruptedAndResumedRepeatedly();
testReducedMotionAndZeroDistanceFollowImmediately();
testReturnDurationScalesWithDistanceWithinTheBounds();
testMovingTargetKeepsItsAngularBranchAcrossTheOppositeMeridian();
testInterpolationUsesProjectedLatitudeAndShortestAngularTravel();
testInterpolationStaysFiniteAtTheMercatorLimits();
testOptionalAltitudeReturnsSmoothly();
testNavigationDoesNotMutateSavedViewsOrPriorStates();
testOnlyNavigationGesturesTakeCameraOwnership();
