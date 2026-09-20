import { WebMercatorViewport } from '@deck.gl/core';
import { readFileSync } from 'node:fs';
import type { CameraView } from '../interfaces';
import { createCameraMovement, inspectCameraMovement } from './planner';
import { createPathTarget } from './selection';
import { compileRuntimeTrajectory } from './trajectory/sampler';
import { normalizeTimedPath, sampleTimedPath } from './timed-path';
import type { CameraTarget, LngLat } from './types';
import { createSnapshotEnvelope } from './geometry/envelope';
import { unwrapLongitude } from './geometry/geo-wrap';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const viewport = { width: 1200, height: 800 };
const view: CameraView = { longitude: 0, latitude: 0, zoom: 9, bearing: 0, pitch: 35, minZoom: 0, maxZoom: 20 };
const points: LngLat[] = [
  [0, 0],
  [0.1, 0],
  [0.1, 0],
  [0.1, 0.2],
  [0.2, 0.2],
];
const timedPath = normalizeTimedPath(points, [0, 10, 70, 90, 100]);
assert(timedPath, 'timed fixture is valid');
const target: CameraTarget = { ...createPathTarget(points)!, timedPath };
function plan(cameraName: string, selected = target, offsetRatio?: [number, number], explicitBearing = false) {
  return createCameraMovement({
    cameraName,
    target: selected,
    currentViewState: view,
    viewportSize: viewport,
    authoring: {
      version: 2,
      targetId: selected.id,
      recipeId: cameraName,
      adjustments: {},
      planningViewport: viewport,
      timing: { duration: 10000 },
      ...(offsetRatio ? { composition: { offsetRatio } } : {}),
      ...(explicitBearing ? { motion: { startBearing: 40, bearingSweep: 20 } } : {}),
    },
  }).cameraMovement;
}
function runtime(camera: ReturnType<typeof plan>) {
  assert(camera.trajectoryPlan, 'tracking commits the checked trajectory');
  const compiled = compileRuntimeTrajectory(camera.trajectoryPlan.trajectory);
  assert(compiled.status === 'ok', 'tracking trajectory compiles');
  return compiled.value;
}
function assertHead(view: CameraView, head: LngLat, offset: [number, number] = [0, 0.1]) {
  const point = new WebMercatorViewport({ ...view, ...viewport }).project([
    unwrapLongitude(head[0], view.longitude),
    head[1],
  ]);
  assert(Math.abs(point[0] / viewport.width - 0.5 - offset[0]) < 0.002, 'head keeps its horizontal screen composition');
  assert(Math.abs(point[1] / viewport.height - 0.5 - offset[1]) < 0.002, 'head stays below center with space ahead');
}
for (const name of ['emphasis-tracking', 'overview-tracking']) {
  const camera = plan(name);
  const path = runtime(camera);
  for (const time of [0, 537, 1000, 3000, 6000, 7000, 8123, 9000, 10000])
    assertHead(path.sample(time), sampleTimedPath(timedPath, time / 100));
  const stopStart = path.sample(2000);
  const stopEnd = path.sample(6000);
  assert(Math.abs(stopStart.bearing - stopEnd.bearing) < 1e-8, 'stops retain the last moving heading');
  assert(Math.abs(stopStart.longitude - stopEnd.longitude) < 1e-8, 'stops keep the camera stationary');
  assert(camera.framingReport?.scope === 'route-window', 'all automatic tracking uses route-window checks');
  assert(inspectCameraMovement(camera, viewport).fits, 'the same timestamp route window passes framing checks');
  const serialized = camera.trajectoryPlan!.trajectory;
  assert(serialized.kind === 'keyframed', 'timed moving route is keyframed');
  for (const time of [1000, 7000, 9000])
    assert(
      serialized.keyframes.some((frame) => frame.timeMs === time),
      'committed keys preserve original timestamps',
    );
}
const authored = plan('emphasis-tracking', target, [0.15, -0.1], true);
const authoredRuntime = runtime(authored);
assertHead(authoredRuntime.sample(5000), sampleTimedPath(timedPath, 50), [0.15, -0.1]);
assert(
  Math.abs(authoredRuntime.sample(5000).bearing - 50) < 1e-8,
  'an explicit bearing request overrides route heading',
);

const staticRoute = createPathTarget([
  [0, 0],
  [0, 2],
  [2, 2],
  [2, 0],
])!;
const overview = plan('overview-tracking', staticRoute);
assertHead(runtime(overview).sample(overview.duration / 2), [1, 2]);

const wrappedPath = normalizeTimedPath(
  [
    [179.8, 60],
    [-179.9, 60.1],
    [-179.7, 60.2],
  ],
  [0, 5, 100],
)!;
const wrappedTarget = { ...createPathTarget(wrappedPath.coordinates)!, timedPath: wrappedPath };
const wrappedCamera = plan('emphasis-tracking', wrappedTarget);
assertHead(runtime(wrappedCamera).sample(5000), sampleTimedPath(wrappedPath, 50));

function withRendererSnapshot(selected: CameraTarget): CameraTarget {
  const envelope = createSnapshotEnvelope({
    id: 'trip-snapshot',
    supportGuarantee: 'conservative',
    provenance: {
      datasetId: 'cab-trips',
      visualizationId: 'cab-trips',
      layerId: 'trips',
      dataRevision: 'trips-data-v1',
      visualizationRevision: 'cab-trips-v1',
      producerId: 'trip-test',
      producerVersion: 1,
      sceneRevision: 'scene-1',
      resolvedLayerDigest: 'trips-1',
    },
    primitives: [
      {
        kind: 'path-corridor',
        positions: selected.timedPath!.coordinates.map((point) => [...point, 0]),
        halfWidth: { value: 2, unit: 'pixels' },
      },
    ],
    anchor: [...selected.center, 0],
    metrics: {
      elevation: 0,
      density: 0,
      coverage: 0,
      dispersion: 0,
      elongation: 0,
      curvature: 0,
      calibrationVersion: 1,
      fallbackReasons: [],
    },
  });
  assert(envelope.status === 'ok', 'rendered trip fixture is valid');
  return {
    ...selected,
    sourceVisualizationId: 'cab-trips',
    sourceDatasetId: 'cab-trips',
    sourceLayerId: 'trips',
    snapshotEnvelope: envelope.value,
  };
}
const rows = JSON.parse(readFileSync('assets/data/trips-v7.json', 'utf8')) as {
  path: LngLat[];
  timestamps: number[];
}[];
const longestRow = rows.reduce((longest, row) => (row.path.length > longest.path.length ? row : longest));
const realPath = normalizeTimedPath(longestRow.path, longestRow.timestamps)!;
const realTarget = withRendererSnapshot({ ...createPathTarget(realPath.coordinates)!, timedPath: realPath });
const realCamera = plan('emphasis-tracking', realTarget);
assert(realCamera.animationBinding?.pathDigest === realPath.digest, 'real trips bind to the captured time/path digest');
assert(realCamera.animationBinding?.dataRevision === 'trips-data-v1', 'binding includes the renderer dataset revision');
assert(realCamera.framingReport?.scope === 'route-window', 'rendered route checks use its timed local corridor');
const realRuntime = runtime(realCamera);
for (const time of [111, 2525, 5067, 8501, 10000]) {
  const dataTime =
    realPath.timestamps[0] +
    (time / 10000) * (realPath.timestamps[realPath.timestamps.length - 1] - realPath.timestamps[0]);
  assertHead(realRuntime.sample(time), sampleTimedPath(realPath, dataTime));
}
const manualCamera = createCameraMovement({
  cameraName: 'emphasis-tracking',
  currentViewState: view,
  target: realTarget,
  viewportSize: viewport,
  authoring: { ...realCamera.authoring!, manualViews: { initial: realCamera.initViewState } },
}).cameraMovement;
assert(!manualCamera.animationBinding, 'manual endpoint framing detaches the automatic data-time binding');
