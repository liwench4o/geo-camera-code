import assert from 'node:assert/strict';
import { createPointTarget } from '../selection';
import { createSnapshotEnvelope } from './envelope';
import type { ContentMetrics, SnapshotEnvelope, VisualPrimitive } from './types';
import { attachSnapshotEnvelope } from './camera-target-adapter';

const METRICS: ContentMetrics = {
  elevation: 0.5,
  density: 0.25,
  coverage: 0.2,
  dispersion: 0.1,
  elongation: 0.3,
  curvature: 0,
  calibrationVersion: 1,
  fallbackReasons: [],
};

function envelope(
  id: string,
  primitive: VisualPrimitive,
  guarantee: SnapshotEnvelope['supportGuarantee'] = 'conservative',
  digest = 'layer-digest-1',
): SnapshotEnvelope {
  const result = createSnapshotEnvelope({
    id,
    supportGuarantee: guarantee,
    provenance: {
      datasetId: 'dataset-1',
      visualizationId: 'visualization-1',
      layerId: 'layer-1',
      dataRevision: 'data-1',
      visualizationRevision: 'visualization-revision-1',
      producerId: 'test-producer',
      producerVersion: 1,
      sceneRevision: 'scene-1',
      resolvedLayerDigest: digest,
    },
    primitives: [primitive],
    anchor:
      primitive.kind === 'point-disc'
        ? [primitive.position[0], primitive.position[1], primitive.position[2] ?? 0]
        : [0, 0, 0],
    metrics: METRICS,
    revisionDependencies: [`fixture:${id}`],
  });
  assert(result.status === 'ok', `fixture envelope should construct: ${result.status === 'ok' ? '' : result.reason}`);
  return result.value;
}

const snapshot = envelope('snapshot', { kind: 'point-disc', position: [10, 20], radius: { value: 5, unit: 'pixels' } });
const source = createPointTarget([10, 20]);
const before = structuredClone(source);
const attached = attachSnapshotEnvelope(source, snapshot);
assert.notEqual(attached, source, 'attaching a snapshot does not edit the saved target');
assert.equal(attached.snapshotEnvelope, snapshot, 'validated immutable snapshots retain their identity');
assert.deepEqual(source, before, 'the original target remains unchanged');
assert.deepEqual(
  { ...attached, snapshotEnvelope: undefined },
  { ...source, snapshotEnvelope: undefined },
  'attaching preserves all target metadata',
);
assert.throws(
  () => attachSnapshotEnvelope(source, { ...snapshot, revision: 'forged' }),
  /invalid snapshot envelope/,
  'forged snapshots must not be attached',
);
