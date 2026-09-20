import assertStrict from 'node:assert/strict';
import { WebMercatorViewport } from '@deck.gl/core';
import type { CameraMovement, CameraView } from '../interfaces';
import { createCameraBaseViewMode, createCameraMovement } from './planner';
import { resolveCameraRecipe } from './recipes';
import { createPointTarget, createRegionTarget, createTargetFromView, enrichCameraTargetStats } from './selection';
import { compileRuntimeTrajectory } from './trajectory/sampler';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertClose(actual: number, expected: number, message: string) {
  assert(Math.abs(actual - expected) < 1e-6, `${message}: expected ${expected}, received ${actual}`);
}

function createView(overrides: Partial<CameraView>): CameraView {
  return {
    longitude: 0,
    latitude: 0,
    zoom: 10,
    pitch: 35,
    bearing: 0,
    minZoom: 0,
    maxZoom: 20,
    minPitch: 0,
    maxPitch: 85,
    ...overrides,
  };
}

function createPreviousCamera(finalViewState: CameraView): CameraMovement {
  return {
    name: 'previous-camera',
    title: 'Previous camera',
    category: 'emphasis',
    initViewState: createView({ longitude: finalViewState.longitude - 1, latitude: finalViewState.latitude - 1 }),
    finalViewState,
    duration: 1000,
    stay: 0,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
  };
}

function createHexagonAnalytics(maxClusterCount = 650) {
  return {
    layers: [
      {
        id: 'hexagon-layer',
        kind: 'hexagon' as const,
        rowCount: 100000,
        bbox: [-8, 49, 2, 61] as [number, number, number, number],
        bboxAreaKm2: 900000,
        radiusMeters: 1500,
        maxClusterCount,
        maxElevationValue: maxClusterCount,
        elevationScale: 250,
        elevationRange: [0, 1000] as [number, number],
        elevationDomain: [0, maxClusterCount] as [number, number],
        maxElevationMeters: 250000,
      },
    ],
    primaryLayer: {
      id: 'hexagon-layer',
      kind: 'hexagon' as const,
      rowCount: 100000,
      bbox: [-8, 49, 2, 61] as [number, number, number, number],
      bboxAreaKm2: 900000,
      radiusMeters: 1500,
      maxClusterCount,
      maxElevationValue: maxClusterCount,
      elevationScale: 250,
      elevationRange: [0, 1000] as [number, number],
      elevationDomain: [0, maxClusterCount] as [number, number],
      maxElevationMeters: 250000,
    },
    combinedBbox: [-8, 49, 2, 61] as [number, number, number, number],
    combinedBboxAreaKm2: 900000,
  };
}

function createHexagonTarget(longitude: number, latitude: number, count: number, maxClusterCount = 650) {
  return enrichCameraTargetStats(
    createPointTarget(
      [longitude, latitude],
      Array.from({ length: Math.max(1, Math.min(count, 20)) }, () => ({ longitude, latitude })),
    ),
    {
      analytics: createHexagonAnalytics(maxClusterCount),
      pickedObject: {
        position: [longitude, latitude],
        count,
      },
    },
  );
}

function testDynamicPullOutStartsFromVisibleCurrentView() {
  const previousFinalView = createView({ longitude: -73.9857, latitude: 40.7484, zoom: 13 });
  const currentView = createView({ longitude: 2.3522, latitude: 48.8566, zoom: 11.5, pitch: 42, bearing: 18 });
  const result = createCameraMovement({
    cameraName: 'dynamic-pull-out',
    currentViewState: currentView,
    previousCamera: createPreviousCamera(previousFinalView),
    target: createTargetFromView(currentView, 'none'),
    viewportSize: { width: 1200, height: 800 },
  }).cameraMovement;

  assertClose(result.initViewState.longitude, currentView.longitude, 'dynamic init longitude should use current view');
  assertClose(result.initViewState.latitude, currentView.latitude, 'dynamic init latitude should use current view');
  assertClose(result.initViewState.pitch, currentView.pitch, 'dynamic init pitch should use current view');
  assertClose(result.initViewState.bearing, currentView.bearing, 'dynamic init bearing should use current view');
  assertClose(
    result.finalViewState.longitude,
    currentView.longitude,
    'dynamic final longitude should preserve current center',
  );
  assertClose(
    result.finalViewState.latitude,
    currentView.latitude,
    'dynamic final latitude should preserve current center',
  );
  assert(result.finalViewState.zoom < currentView.zoom, 'dynamic pull-out should reduce zoom from current view');
  assert(result.debugInfo?.baseViewSource === 'current-view', 'dynamic debug info should record current-view base');
}

function testDynamicBaseModeUsesPreviousCameraWhenAppendingAfterExistingCamera() {
  const recipe = resolveCameraRecipe('dynamic-pull-out');
  const previousFinalView = createView({ longitude: -3.1, latitude: 54.2, zoom: 8.5, pitch: 48, bearing: 12 });
  const currentView = createView({ longitude: -1.4157, latitude: 52.2324, zoom: 6, pitch: 40.5, bearing: 0 });
  const previousCamera = createPreviousCamera(previousFinalView);
  const result = createCameraMovement({
    cameraName: 'dynamic-pull-out',
    currentViewState: currentView,
    previousCamera,
    baseViewMode: createCameraBaseViewMode(recipe, previousCamera),
    target: createTargetFromView(currentView, 'none'),
    viewportSize: { width: 1200, height: 800 },
  }).cameraMovement;

  assertClose(
    result.initViewState.longitude,
    previousFinalView.longitude,
    'appended dynamic init longitude should use previous camera',
  );
  assertClose(
    result.initViewState.latitude,
    previousFinalView.latitude,
    'appended dynamic init latitude should use previous camera',
  );
  assert(result.debugInfo?.baseViewSource === 'previous-camera', 'appended dynamic should record previous-camera base');
}

function testTargetPullOutKeepsPreviousCameraAsRecommendationBase() {
  const previousFinalView = createView({ longitude: -74, latitude: 40.7, zoom: 9 });
  const currentView = createView({ longitude: 2.3, latitude: 48.8, zoom: 12 });
  const result = createCameraMovement({
    cameraName: 'overview-pull-out',
    currentViewState: currentView,
    previousCamera: createPreviousCamera(previousFinalView),
    target: createTargetFromView(currentView, 'location'),
    viewportSize: { width: 1200, height: 800 },
  }).cameraMovement;

  assertClose(
    result.recommendationBaseViewState?.longitude ?? Number.NaN,
    previousFinalView.longitude,
    'target-based recommendation should keep previous camera as base longitude',
  );
  assertClose(
    result.recommendationBaseViewState?.latitude ?? Number.NaN,
    previousFinalView.latitude,
    'target-based recommendation should keep previous camera as base latitude',
  );
  assert(
    result.debugInfo?.baseViewSource === 'previous-camera',
    'target-based debug info should record previous-camera base',
  );
}

testDynamicPullOutStartsFromVisibleCurrentView();
testDynamicBaseModeUsesPreviousCameraWhenAppendingAfterExistingCamera();
testTargetPullOutKeepsPreviousCameraAsRecommendationBase();

// Assert the output consumed by playback, with Deck projection independent of planner reports.
const viewport = { width: 360, height: 240 };
const currentView = createView({ longitude: -1.5, latitude: 52.2, zoom: 8, pitch: 45 });
function assertInside(view: CameraView, points: number[][], size = viewport) {
  const projection = new WebMercatorViewport({ ...view, ...size });
  for (const point of points) {
    const [x, y] = projection.project(point);
    assert(Number.isFinite(x) && Number.isFinite(y), 'projected geometry must be finite');
    assert(x >= 0 && x <= size.width && y >= 0 && y <= size.height, `target clipped at ${x}, ${y}`);
  }
}
for (const name of ['dynamic-pan', 'basic-trucking']) {
  const movements = [6, 12].map((zoom) => {
    const view = { ...currentView, zoom };
    return createCameraMovement({
      cameraName: name,
      currentViewState: view,
      target: createTargetFromView(view, 'none'),
      viewportSize: viewport,
    }).cameraMovement;
  });
  const deltas = movements.map((camera) => camera.finalViewState.longitude - camera.initViewState.longitude);
  assert(deltas[0] > 0 && deltas[1] > 0, `${name} must move in the intended direction`);
  assert(deltas[1] < deltas[0], `${name} uses a smaller geographic displacement at higher zoom`);
}
for (const count of [1, 131, 650]) {
  const target = createHexagonTarget(-1.89, 52.479, count);
  const [west, south, east, north] = target.visualFrame!.bbox;
  const height = target.visualFrame!.heightMeters!;
  const points = [0, height].flatMap((z) => [
    [west, south, z],
    [east, south, z],
    [east, north, z],
    [west, north, z],
  ]);
  for (const cameraName of ['emphasis-push-in', 'overview-pull-out']) {
    const camera = createCameraMovement({
      cameraName,
      currentViewState: currentView,
      target,
      viewportSize: viewport,
    }).cameraMovement;
    assert(camera.targetId === target.id, 'planning must retain the selected target identity');
    assertStrict.deepEqual(camera.targetSnapshot, target, 'planning must retain the selected target');
    assert(
      cameraName === 'emphasis-push-in'
        ? camera.finalViewState.zoom > camera.initViewState.zoom
        : camera.finalViewState.zoom < camera.initViewState.zoom,
      `${cameraName} has the intended zoom direction`,
    );
    for (const view of [camera.initViewState, camera.finalViewState]) {
      assertInside(view, points);
      const [x, y] = new WebMercatorViewport({ ...view, ...viewport }).project([...target.center, height / 2]);
      assert(
        Math.hypot(x - viewport.width / 2, y - viewport.height / 2) < 2,
        'the visual centroid, including column height, stays centered',
      );
    }
  }
}
const polygon: [number, number][] = [
  [-3, 52.1],
  [-0.1, 52.1],
  [-0.1, 52.3],
  [-3, 52.3],
];
for (const height of [0, 120000]) {
  const base = createRegionTarget(polygon);
  const target = { ...base, visualFrame: { bbox: base.bbox, anchor: base.center, heightMeters: height } };
  const camera = createCameraMovement({
    cameraName: 'emphasis-arc',
    currentViewState: { ...currentView, bearing: 90 },
    target,
    viewportSize: viewport,
    framingTuning: { motionStrength: 1, framingTightness: -1 },
  }).cameraMovement;
  assert(camera.trajectoryPlan !== undefined, 'arc must commit its playback trajectory');
  const runtime = compileRuntimeTrajectory(camera.trajectoryPlan!.trajectory);
  if (runtime.status !== 'ok') throw new Error('arc trajectory must compile');
  assert(Math.abs(camera.finalViewState.bearing - camera.initViewState.bearing) > 5, 'arc must rotate');
  for (let step = 0; step <= 24; step++) {
    assertInside(
      runtime.value.sample((camera.duration * step) / 24),
      [0, height].flatMap((z) => polygon.map(([x, y]) => [x, y, z])),
    );
  }
}
const target = createPointTarget([-1.4, 52.2]);
const tuned = (value: number) =>
  createCameraMovement({
    cameraName: 'emphasis-arc',
    currentViewState: currentView,
    target,
    viewportSize: viewport,
    framingTuning: { framingTightness: value, motionStrength: value },
  }).cameraMovement;
const close = tuned(-1),
  loose = tuned(1);
assert(close.finalViewState.zoom > loose.finalViewState.zoom, 'tightness changes actual framing');
assert(
  Math.abs(close.finalViewState.bearing - close.initViewState.bearing) <
    Math.abs(loose.finalViewState.bearing - loose.initViewState.bearing),
  'strength changes actual sweep',
);
const anchors = [-0.14, 0.14].map((offset) => {
  const camera = createCameraMovement({
    cameraName: 'emphasis-push-in',
    currentViewState: currentView,
    target,
    viewportSize: viewport,
    framingTuning: { offsetRatio: [offset, 0] },
  }).cameraMovement;
  return new WebMercatorViewport({ ...camera.finalViewState, ...viewport }).project(target.center)[0];
});
assert(
  anchors[0] < viewport.width / 2 && anchors[1] > viewport.width / 2,
  'placement tuning moves the target to the requested side of the frame',
);
