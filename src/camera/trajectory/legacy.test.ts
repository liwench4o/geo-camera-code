import type { CameraMovement, CameraView } from '../../interfaces';
import { getDefaultViewportSize } from '../viewport';
import { compileLegacyMovementTrajectory, resolveTrajectoryViewport } from './legacy';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function view(overrides: Partial<CameraView> = {}): CameraView {
  return {
    longitude: 10,
    latitude: 20,
    zoom: 6,
    pitch: 30,
    bearing: 15,
    minZoom: 0,
    maxZoom: 20,
    minPitch: 0,
    maxPitch: 85,
    ...overrides,
  };
}

function movement(overrides: Partial<CameraMovement> = {}): CameraMovement {
  return {
    name: 'camera',
    title: 'Camera',
    category: 'test',
    initViewState: view(),
    finalViewState: view({ longitude: 12, zoom: 8 }),
    duration: 1000,
    stay: 0,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
    ...overrides,
  };
}

function testLegacyKindsRemainExplicit() {
  const camera = movement();
  const fly = compileLegacyMovementTrajectory(camera, { width: 1440, height: 900 }, 'fly');
  assert(fly.kind === 'legacy-fly' && fly.viewport.width === 1440, 'fly captures viewport');

  const linear = compileLegacyMovementTrajectory(camera, { width: 1440, height: 900 }, 'linear');
  assert(linear.kind === 'legacy-linear', 'linear compatibility remains explicit');

  const heldView = view({ longitude: 4 });
  const hold = compileLegacyMovementTrajectory(
    movement({ initViewState: heldView, finalViewState: { ...heldView } }),
    { width: 1440, height: 900 },
    'fly',
  );
  assert(hold.kind === 'hold', 'equal endpoints compile to hold');
  assert(hold.kind === 'hold' && hold.keyframes[0].view !== hold.keyframes[1].view, 'hold views are copied');
}

function testViewportResolutionIsFiniteCopiedAndDeterministic() {
  const requested = { width: 1440, height: 900 };
  const resolved = resolveTrajectoryViewport(requested);
  assert(resolved !== requested && resolved.width === 1440 && resolved.height === 900, 'valid viewport is copied');
  requested.width = 1;
  assert(resolved.width === 1440, 'resolved viewport is isolated from source mutation');

  const fallback = resolveTrajectoryViewport({ width: Number.NaN, height: -1 });
  const expected = getDefaultViewportSize();
  assert(fallback !== expected, 'default viewport is copied');
  assert(fallback.width === expected.width && fallback.height === expected.height, 'invalid viewport uses default');
}

function testCompilerCopiesOnlySemanticDataWithoutMutation() {
  const transitionInterpolator = { name: 'fly' };
  const initViewState = view({
    transitionDuration: 500,
    transitionEasing: () => 0.5,
    transitionInterpolator,
    onTransitionEnd: () => undefined,
  });
  const finalViewState = view({ longitude: 15, transitionDuration: 900, transitionInterpolator });
  const camera = movement({ initViewState, finalViewState });
  const before = {
    initLongitude: camera.initViewState.longitude,
    finalLongitude: camera.finalViewState.longitude,
    transitionInterpolator: camera.initViewState.transitionInterpolator,
  };

  const compiled = compileLegacyMovementTrajectory(camera, { width: 1440, height: 900 }, 'fly');
  const serialized = JSON.stringify(compiled);
  assert(!serialized.includes('transition'), 'serialized compatibility trajectory omits transition fields');
  assert(
    !serialized.includes('minZoom') && !serialized.includes('maxPitch'),
    'serialized views contain semantic fields only',
  );
  assert(camera.initViewState.longitude === before.initLongitude, 'compiler does not mutate initial view');
  assert(camera.finalViewState.longitude === before.finalLongitude, 'compiler does not mutate final view');
  assert(
    camera.initViewState.transitionInterpolator === before.transitionInterpolator,
    'compiler does not mutate transition objects',
  );
}

testLegacyKindsRemainExplicit();
testViewportResolutionIsFiniteCopiedAndDeterministic();
testCompilerCopiesOnlySemanticDataWithoutMutation();
