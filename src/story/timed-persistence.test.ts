import type { CameraMovement, CameraView, StoryJsonV2 } from '../interfaces';
import { digestCanonical } from '../camera/geometry/canonical-digest';
import { normalizeTimedPath } from '../camera/timed-path';
import type { CameraTarget } from '../camera/types';
import { computeTrajectoryDigest } from '../camera/trajectory/validation';
import { createAnimationBinding, getSceneTimeAtPlaybackTime } from './scene-time';
import { derivePlaybackPlan } from './playback';
import { createStoryJson, parseStoryJson } from './serialization';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const view = (longitude: number): CameraView => ({ longitude, latitude: 0, zoom: 10, pitch: 35, bearing: 0 });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function boundCamera(): CameraMovement {
  const timedPath = normalizeTimedPath(
    [
      [0, 0],
      [1, 0],
      [1, 0],
      [2, 0],
    ],
    [1191, 1200, 1800, 1868.948],
  );
  assert(timedPath, 'fixture contains valid timestamps and a stop');
  const target: CameraTarget = {
    id: 'trip',
    type: 'path',
    center: [1, 0],
    bbox: [0, 0, 2, 0],
    timedPath,
    sourceVisualizationId: 'trips',
    sourceDatasetId: 'vehicles',
    sourceLayerId: 'trips-layer',
    snapshotEnvelope: {
      binding: 'snapshot',
      id: 'trip',
      revision: 'trip-v1',
      supportGuarantee: 'conservative',
      provenance: {
        visualizationId: 'trips',
        datasetId: 'vehicles',
        layerId: 'trips-layer',
        dataRevision: 'data-v1',
        visualizationRevision: 'visual-v1',
        producerId: 'trips',
        producerVersion: 1,
        sceneRevision: 'scene-v1',
        resolvedLayerDigest: 'layer-v1',
      },
      frame: {
        primitives: [],
        anchor: [1, 0, 0],
        wrap: { wrapReference: 1, worldOffset: 0, wrapMode: 'minimum-arc' },
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
      },
    },
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
  return {
    id: 'tracking-shot',
    name: 'emphasis-tracking',
    title: 'Tracking',
    category: 'dynamic',
    targetId: target.id,
    targetSnapshot: target,
    animationBinding: createAnimationBinding(target),
    initViewState: view(0),
    finalViewState: view(2),
    duration: 10000,
    stay: 250,
    startDelay: 100,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
    trajectoryPlan: {
      inputDigest: digestCanonical({ target, animationBinding: createAnimationBinding(target) }),
      trajectory,
      trajectoryDigest: computeTrajectoryDigest(trajectory),
      certification: { status: 'unknown', reason: 'interval-bound-unavailable' },
    },
  };
}

function testBoundStoryRoundTripKeepsTheAppliedPath() {
  const camera = boundCamera();
  const story = createStoryJson([camera]);
  assert(story.version === 2, 'bound story uses applied-trajectory format');
  assert(story.cameras[0].movement.animationBinding, 'writer retains scene animation binding');
  const parsed = parseStoryJson(clone(story));
  assert(parsed.ok, 'valid timed target and matching binding import');
  assert(
    digestCanonical(parsed.cameras[0].animationBinding) === digestCanonical(camera.animationBinding),
    'binding identities and full source range round trip',
  );
  assert(
    digestCanonical(parsed.cameras[0].targetSnapshot) === digestCanonical(camera.targetSnapshot),
    'normalized timed path, stops and provenance round trip',
  );
  assert(
    parsed.cameras[0].trajectoryPlan?.trajectoryDigest === camera.trajectoryPlan?.trajectoryDigest,
    'import preserves the exact applied camera path without replanning',
  );
  assert(JSON.stringify(createStoryJson(parsed.cameras)) === JSON.stringify(story), 'bound re-export is byte stable');
}

function testPlaybackExportRetainsTimedPlaybackDependencies() {
  const source = boundCamera();
  const target = source.targetSnapshot as CameraTarget;
  target.selectedRows = [{ raw: 'planning data' }];
  const original = JSON.stringify(source);
  const options = { trajectoryEnabled: true, content: 'playback' as const };
  const story = createStoryJson([source], options);
  const parsed = parseStoryJson(clone(story));
  assert(parsed.ok, 'playback export imports with a matching timed path and binding');
  const exportedTarget = parsed.cameras[0].targetSnapshot as CameraTarget;
  assert(exportedTarget.selectedRows === undefined, 'raw rows are omitted from timed paths');
  const playbackTarget = { ...target };
  delete playbackTarget.selectedRows;
  assert(
    digestCanonical(exportedTarget) === digestCanonical(playbackTarget),
    'path geometry and envelope provenance remain intact',
  );
  const before = derivePlaybackPlan([source]);
  const after = derivePlaybackPlan(parsed.cameras);
  for (const time of [0, 100, 1000, 5000, 10000, 10350]) {
    assert(
      digestCanonical(getSceneTimeAtPlaybackTime(before.segments, time)) ===
        digestCanonical(getSceneTimeAtPlaybackTime(after.segments, time)),
      'animation clock survives export, import and seek',
    );
  }
  assert(
    JSON.stringify(createStoryJson(parsed.cameras, options)) === JSON.stringify(story),
    'timed playback export is stable',
  );
  assert(JSON.stringify(source) === original, 'timed source is not mutated');
}

testPlaybackExportRetainsTimedPlaybackDependencies();

function testMalformedBindingAndTimedSnapshotFailClosed() {
  const cases: Array<[string, (movement: CameraMovement) => void]> = [
    [
      'binding version',
      (movement) => {
        Object.assign(movement.animationBinding!, { version: 2 });
      },
    ],
    [
      'binding extra field',
      (movement) => {
        Object.assign(movement.animationBinding!, { clockRate: 2 });
      },
    ],
    [
      'missing source identity',
      (movement) => {
        movement.animationBinding!.layerId = '';
      },
    ],
    [
      'mismatched visualization',
      (movement) => {
        movement.animationBinding!.visualizationId = 'other';
      },
    ],
    [
      'mismatched dataset',
      (movement) => {
        movement.animationBinding!.datasetId = 'other';
      },
    ],
    [
      'mismatched layer',
      (movement) => {
        movement.animationBinding!.layerId = 'other';
      },
    ],
    [
      'mismatched revision',
      (movement) => {
        movement.animationBinding!.dataRevision = 'other';
      },
    ],
    ...(['datasetId', 'visualizationId', 'layerId'] as const).map(
      (field): [string, (movement: CameraMovement) => void] => [
        `mismatched target ${field} provenance`,
        (movement) => {
          (movement.targetSnapshot as CameraTarget).snapshotEnvelope!.provenance[field] = 'different-renderer';
        },
      ],
    ),
    ...[undefined, null, '', '   ', 0, 42, 'different-data-revision'].map(
      (dataRevision): [string, (movement: CameraMovement) => void] => [
        `invalid or mismatched provenance dataRevision ${String(dataRevision)}`,
        (movement) => {
          Object.assign((movement.targetSnapshot as CameraTarget).snapshotEnvelope!.provenance, { dataRevision });
        },
      ],
    ),
    [
      'mismatched path digest',
      (movement) => {
        movement.animationBinding!.pathDigest = 'other';
      },
    ],
    [
      'mismatched source range',
      (movement) => {
        movement.animationBinding!.timeRange = [1191, 1800];
      },
    ],
    [
      'inverted range',
      (movement) => {
        movement.animationBinding!.timeRange = [1900, 1191];
      },
    ],
    [
      'missing target',
      (movement) => {
        delete movement.targetSnapshot;
      },
    ],
    [
      'missing timed snapshot',
      (movement) => {
        delete (movement.targetSnapshot as CameraTarget).timedPath;
      },
    ],
    [
      'missing provenance',
      (movement) => {
        delete (movement.targetSnapshot as CameraTarget).snapshotEnvelope;
      },
    ],
    [
      'timed snapshot version',
      (movement) => {
        Object.assign((movement.targetSnapshot as CameraTarget).timedPath!, { version: 2 });
      },
    ],
    [
      'timed snapshot extra field',
      (movement) => {
        Object.assign((movement.targetSnapshot as CameraTarget).timedPath!, { rate: 2 });
      },
    ],
    [
      'timed snapshot digest',
      (movement) => {
        (movement.targetSnapshot as CameraTarget).timedPath!.digest = 'other';
      },
    ],
    [
      'changed timestamp',
      (movement) => {
        (movement.targetSnapshot as CameraTarget).timedPath!.timestamps[1] = 1300;
      },
    ],
    [
      'changed coordinate',
      (movement) => {
        (movement.targetSnapshot as CameraTarget).timedPath!.coordinates[1][0] = 1.5;
      },
    ],
    [
      'duplicate timestamp',
      (movement) => {
        (movement.targetSnapshot as CameraTarget).timedPath!.timestamps[1] = 1191;
      },
    ],
    [
      'mismatched array lengths',
      (movement) => {
        (movement.targetSnapshot as CameraTarget).timedPath!.timestamps.pop();
      },
    ],
  ];
  const failures: string[] = [];
  for (const [label, mutate] of cases) {
    const movement = clone(boundCamera());
    mutate(movement);
    const valid = createStoryJson([boundCamera()]) as StoryJsonV2;
    // Insert raw movement metadata after export, so importer validation is exercised independently.
    const rawMovement = clone(movement);
    delete rawMovement.trajectoryPlan;
    valid.cameras[0].movement = rawMovement;
    if (parseStoryJson(valid).ok) failures.push(`${label} import was accepted`);
    let rejected = false;
    try {
      createStoryJson([movement]);
    } catch {
      rejected = true;
    }
    if (!rejected) failures.push(`${label} export was accepted`);
  }
  assert(failures.length === 0, failures.join('\n'));
}

function testUnboundStoriesStayUnboundAndTimedSnapshotsStillValidate() {
  const camera = boundCamera();
  delete camera.animationBinding;
  for (const trajectoryEnabled of [false, true]) {
    const story = createStoryJson([camera], { trajectoryEnabled });
    const parsed = parseStoryJson(clone(story));
    assert(
      parsed.ok && parsed.cameras[0].animationBinding === undefined,
      'old stories do not gain an animation binding',
    );
    if (trajectoryEnabled)
      assert(
        parsed.cameras[0].trajectoryPlan?.trajectoryDigest === camera.trajectoryPlan?.trajectoryDigest,
        'unbound committed trajectories are not replanned',
      );
    else assert(parsed.cameras[0].trajectoryPlan === undefined, 'legacy endpoints remain unresolved');
  }
  const invalid = clone(createStoryJson([camera])) as StoryJsonV2;
  (invalid.cameras[0].movement.targetSnapshot as CameraTarget).timedPath!.digest = 'corrupted';
  assert(!parseStoryJson(invalid).ok, 'an unbound target cannot smuggle in a malformed timed snapshot');
}

const failures: string[] = [];
for (const test of [
  testBoundStoryRoundTripKeepsTheAppliedPath,
  testMalformedBindingAndTimedSnapshotFailClosed,
  testUnboundStoriesStayUnboundAndTimedSnapshotsStillValidate,
]) {
  try {
    test();
  } catch (error) {
    failures.push(`${test.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
assert(failures.length === 0, failures.join('\n'));

function testAnimationBindingRequiresConsistentProvenance() {
  for (const field of ['datasetId', 'visualizationId', 'layerId'] as const) {
    const target = clone(boundCamera().targetSnapshot) as CameraTarget;
    target.snapshotEnvelope!.provenance[field] = 'different-renderer';
    assert(createAnimationBinding(target) === undefined, `conflicting ${field} cannot create a binding`);
  }
  for (const dataRevision of [undefined, null, '', '   ', 0, 42]) {
    const target = clone(boundCamera().targetSnapshot) as CameraTarget;
    Object.assign(target.snapshotEnvelope!.provenance, { dataRevision });
    assert(createAnimationBinding(target) === undefined, 'data revision must be a nonempty string');
  }
}
testAnimationBindingRequiresConsistentProvenance();
