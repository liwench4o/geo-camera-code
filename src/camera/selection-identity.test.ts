import assert from 'node:assert/strict';
import {
  appendUniqueTargetHistory,
  createPathTarget,
  createPointTarget,
  createRegionTarget,
  getLatestComparisonPair,
  getTargetIdentity,
} from './selection';
import type { CameraTarget, LngLat } from './types';
import type { SnapshotEnvelope, TargetProvenance } from './geometry/types';

function withSnapshot(target: CameraTarget, provenance: Partial<TargetProvenance> = {}): CameraTarget {
  const snapshotEnvelope: SnapshotEnvelope = {
    id: target.id,
    binding: 'snapshot',
    supportGuarantee: 'conservative',
    revision: 'snapshot-1',
    provenance: {
      datasetId: 'dataset-1',
      visualizationId: 'visualization-1',
      layerId: 'layer-1',
      dataRevision: 'data-1',
      visualizationRevision: 'visualization-revision-1',
      producerId: 'scatter-point',
      producerVersion: 1,
      sceneRevision: 'scene-1',
      resolvedLayerDigest: 'layer-digest-1',
      ...provenance,
    },
    frame: {
      primitives: [{ kind: 'point-disc', position: target.center, radius: { value: 5, unit: 'pixels' } }],
      anchor: [...target.center, 0],
      wrap: { wrapMode: 'minimum-arc', wrapReference: target.center[0], worldOffset: 0 },
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
  };
  return { ...target, snapshotEnvelope };
}

function expectDistinct(first: CameraTarget, second: CameraTarget, message: string) {
  assert.deepEqual(appendUniqueTargetHistory([first], second, 2), [first, second], message);
  assert.deepEqual(getLatestComparisonPair([first, second]), [first, second], message);
}

function expectSameObject(first: CameraTarget, updated: CameraTarget, message: string) {
  assert.notEqual(first.id, updated.id, 'fixtures model a new selection with a regenerated target ID');
  assert.deepEqual(appendUniqueTargetHistory([first], updated, 2), [updated], message);
  assert.equal(getLatestComparisonPair([first, updated]), undefined, message);
}

const tests: Array<[string, () => void]> = [
  [
    'nearby geographic points remain distinct while playback identity stays compatible',
    () => {
      const first = createPointTarget([114.10001, 22.30001]);
      const second = createPointTarget([114.10002, 22.30002]);
      assert.equal(getTargetIdentity(first), getTargetIdentity(second), 'legacy timeline grouping is unchanged');
      expectDistinct(first, second, 'nearby points must not collapse to a three-decimal bbox');
    },
  ],
  [
    'different source objects at the same coordinate remain distinct',
    () => {
      for (const field of ['rid', 'id', 'key']) {
        expectDistinct(
          createPointTarget([10, 20], [{ [field]: 1 }]),
          createPointTarget([10, 20], [{ [field]: 2 }]),
          `stable ${field} distinguishes overlapping objects`,
        );
      }
    },
  ],
  [
    'stable source ID survives coordinate and rendered height updates',
    () => {
      const first = withSnapshot(createPointTarget([10, 20], [{ rid: 0, height: 10 }]));
      const updated = withSnapshot(createPointTarget([11, 21], [{ rid: 0, height: 200 }]), {
        dataRevision: 'data-2',
        sceneRevision: 'scene-2',
        resolvedLayerDigest: 'layer-digest-2',
      });
      updated.visualFrame = { ...updated.visualFrame!, heightMeters: 200 };
      expectSameObject(first, updated, 'source identity must ignore changing geometry, data revisions and height');
    },
  ],
  [
    'explicit source feature references survive row removal and reordering',
    () => {
      const first = withSnapshot(createPointTarget([10, 20]));
      first.sourceFeatures = [
        { field: 'rid', value: 1 },
        { field: 'rid', value: 2 },
      ];
      const updated = withSnapshot(createPointTarget([11, 21]));
      updated.sourceFeatures = [
        { field: 'rid', value: 2 },
        { field: 'rid', value: 1 },
      ];
      expectSameObject(first, updated, 'snapshot source references are an unordered stable object set');
    },
  ],
  [
    'source references and row identities describe the same object',
    () => {
      const first = withSnapshot(createPointTarget([10, 20], [{ key: 'object-1' }]));
      const updated = withSnapshot(createPointTarget([11, 21]));
      updated.sourceFeatures = [{ field: 'key', value: 'object-1' }];
      expectSameObject(first, updated, 'remembering source references must not change selection identity');
    },
  ],
  [
    'dataset and layer namespaces disambiguate equal row IDs',
    () => {
      const first = withSnapshot(createPointTarget([10, 20], [{ id: 'same-id' }]));
      expectDistinct(
        first,
        withSnapshot(createPointTarget([10, 20], [{ id: 'same-id' }]), {
          datasetId: 'dataset-2',
        }),
        'row IDs are scoped to a dataset',
      );
      expectDistinct(
        first,
        withSnapshot(createPointTarget([10, 20], [{ id: 'same-id' }]), {
          layerId: 'layer-2',
        }),
        'row IDs are scoped to a layer',
      );
    },
  ],
  [
    'source layer metadata disambiguates selections without snapshots',
    () => {
      const first = { ...createPointTarget([10, 20], [{ id: 'same-id' }]), sourceLayerId: 'layer-1' };
      const second = { ...createPointTarget([10, 20], [{ id: 'same-id' }]), sourceLayerId: 'layer-2' };
      expectDistinct(first, second, 'available layer metadata must namespace source references');
    },
  ],
  [
    'source dataset metadata disambiguates selections without snapshots',
    () => {
      const first = { ...createPointTarget([10, 20], [{ id: 'same-id' }]), sourceDatasetId: 'dataset-1' };
      const second = { ...createPointTarget([10, 20], [{ id: 'same-id' }]), sourceDatasetId: 'dataset-2' };
      expectDistinct(first, second, 'dataset metadata must survive an unavailable renderer snapshot');
    },
  ],
  [
    'precise hex centers stay distinct despite matching old bbox keys',
    () => {
      const first = createPointTarget([10, 20]);
      const second = createPointTarget([10, 20]);
      first.center = [10.0000001, 20];
      first.coordinates = [first.center];
      second.center = [10.0000002, 20];
      second.coordinates = [second.center];
      expectDistinct(first, second, 'rendered hex centers must preserve their available precision');
    },
  ],
  [
    'full line paths distinguish objects with the same bounding box',
    () => {
      const first = createPathTarget([
        [0, 0],
        [1, 1],
        [2, 0],
      ])!;
      const second = createPathTarget([
        [0, 0],
        [1, 0.5],
        [2, 1],
      ])!;
      assert.deepEqual(first.bbox, second.bbox);
      expectDistinct(first, second, 'path vertices must participate in geometric identity');
    },
  ],
  [
    'drawn regions use their own rings even when they select the same rows',
    () => {
      const first = createRegionTarget(
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 0],
        ],
        [{ rid: 7 }],
      );
      const second = createRegionTarget(
        [
          [0, 0],
          [2, 0],
          [0, 2],
          [0, 0],
        ],
        [{ rid: 7 }],
      );
      first.sourceFeatures = [{ field: 'rid', value: 7 }];
      second.sourceFeatures = [{ field: 'rid', value: 7 }];
      assert.deepEqual(first.bbox, second.bbox);
      expectDistinct(first, second, 'equal selected row subsets do not make different drawn regions identical');
    },
  ],
  [
    'drawn routes use their own path even when their source rows match',
    () => {
      const first = createPathTarget(
        [
          [0, 0],
          [1, 1],
          [2, 0],
        ],
        [{ rid: 7 }],
        'drawn-path',
      )!;
      const second = createPathTarget(
        [
          [0, 0],
          [1, 0.5],
          [2, 1],
        ],
        [{ rid: 7 }],
        'drawn-path',
      )!;
      expectDistinct(first, second, 'a drawn route is identified by its selected geometry');
    },
  ],
  [
    'region holes remain part of fallback geographic identity',
    () => {
      const exterior: LngLat[] = [
        [0, 0],
        [2, 0],
        [2, 2],
        [0, 0],
      ];
      const first = createRegionTarget(exterior);
      const second = createRegionTarget(exterior);
      first.coordinates = [
        exterior,
        [
          [0.2, 0.2],
          [0.8, 0.2],
          [0.8, 0.8],
          [0.2, 0.2],
        ],
      ];
      second.coordinates = [
        exterior,
        [
          [0.3, 0.3],
          [0.8, 0.3],
          [0.8, 0.8],
          [0.3, 0.3],
        ],
      ];
      expectDistinct(first, second, 'regions with different holes must remain distinct');
    },
  ],
  [
    'latest two nearby objects replace the oldest and reselection moves to newest',
    () => {
      const first = createPointTarget([10.00001, 20], [{ rid: 1 }]);
      const second = createPointTarget([10.00002, 20], [{ rid: 2 }]);
      const third = createPointTarget([10.00003, 20], [{ rid: 3 }]);
      let history = [first, second, third].reduce<CameraTarget[]>(
        (previous, target) => appendUniqueTargetHistory(previous, target, 2),
        [],
      );
      assert.deepEqual(history, [second, third], 'selecting 1, 2, 3 must retain 2, 3');
      assert.deepEqual(getLatestComparisonPair(history), [second, third]);
      const secondAgain = createPointTarget([10.00002, 20], [{ rid: 2, height: 900 }]);
      history = appendUniqueTargetHistory(history, secondAgain, 2);
      assert.deepEqual(history, [third, secondAgain], 'reselecting 2 must retain 3, 2');
      assert.deepEqual(getLatestComparisonPair(history), [third, secondAgain]);
    },
  ],
];

let failures = 0;
for (const [name, run] of tests) {
  try {
    run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
}
assert.equal(failures, 0, `${failures} selection identity regressions failed`);
console.log(`${tests.length} selection identity regression cases passed.`);
