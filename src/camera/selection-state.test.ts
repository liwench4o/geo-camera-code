import { validateSelectionState, type SelectionMember, type SelectionState } from './selection-state';
import { createSnapshotEnvelope } from './geometry/envelope';
import type { SnapshotEnvelope } from './geometry/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function makeMember(id: string, patch: Partial<SelectionMember> = {}): SelectionMember {
  return {
    id,
    pinned: false,
    source: 'click-object',
    status: 'current',
    operation: 'idle',
    provenance: {
      datasetId: 'dataset',
      visualizationId: 'visualization',
      layerId: 'layer',
      dataRevision: 'data-1',
      visualizationRevision: 'visualization-1',
      producerId: 'selection-fixture',
      producerVersion: 1,
    },
    binding: { kind: 'feature-refs', featureIds: [`feature-${id}`], rebindCapability: 'stable-id' },
    ...patch,
  };
}

function makeSnapshot(id: string, provenancePatch: Partial<SnapshotEnvelope['provenance']> = {}): SnapshotEnvelope {
  const result = createSnapshotEnvelope({
    id,
    supportGuarantee: 'renderer-exact',
    provenance: {
      datasetId: 'dataset',
      visualizationId: 'visualization',
      layerId: 'layer',
      dataRevision: 'data-1',
      visualizationRevision: 'visualization-1',
      producerId: 'selection-fixture',
      producerVersion: 1,
      sceneRevision: 'scene-1',
      resolvedLayerDigest: 'layer-digest-1',
      ...provenancePatch,
    },
    primitives: [{ kind: 'point-disc', position: [0, 0, 0], radius: { value: 4, unit: 'pixels' } }],
    anchor: [0, 0, 0],
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
  assert(result.status === 'ok', 'selection snapshot fixture must construct');
  return result.value;
}

function makeOrderedState(): SelectionState {
  return { sceneRevision: 'scene-1', members: ['a', 'b', 'c'].map((id) => makeMember(id)) };
}

function testStateValidation(): void {
  const state = makeOrderedState();
  assert(validateSelectionState(state).status === 'ok', 'valid selection state');

  assert(
    validateSelectionState({ ...state, members: [state.members[0], { ...state.members[0] }] }).status === 'error',
    'duplicate member IDs are invalid',
  );
  assert(validateSelectionState({ ...state, activeId: 'missing' }).status === 'error', 'dangling active is invalid');
  assert(
    validateSelectionState({ ...state, comparisonPair: ['a', 'a'] }).status === 'error',
    'comparison IDs must be distinct',
  );

  const duplicateFeatures = makeMember('bad-features', {
    binding: { kind: 'feature-refs', featureIds: ['same', 'same'], rebindCapability: 'stable-id' },
  });
  assert(
    validateSelectionState({ ...state, members: [duplicateFeatures], activeId: undefined }).status === 'error',
    'feature refs must be unique',
  );

  const invalidQuery = makeMember('bad-query', {
    binding: { kind: 'render-query', queryId: '', params: {}, rebindCapability: 'query' },
  });
  assert(
    validateSelectionState({ ...state, members: [invalidQuery], activeId: undefined }).status === 'error',
    'query IDs must be nonempty',
  );

  const cyclicParams: Record<string, unknown> = {};
  cyclicParams.self = cyclicParams;
  const cyclicQuery = makeMember('cyclic', {
    binding: { kind: 'render-query', queryId: 'query', params: cyclicParams, rebindCapability: 'query' },
  });
  assert(
    validateSelectionState({ ...state, members: [cyclicQuery], activeId: undefined }).status === 'error',
    'query params must be JSON-like and acyclic',
  );

  for (const member of [
    makeMember('current-rebinding', { operation: 'rebinding' }),
    makeMember('unresolved-rebinding', { status: 'unresolved', operation: 'rebinding' }),
  ]) {
    assert(
      validateSelectionState({ ...state, members: [member], activeId: undefined }).status === 'error',
      'only stale members may be rebinding',
    );
  }
  const staleRebinding = makeMember('stale-rebinding', { status: 'stale', operation: 'rebinding' });
  assert(
    validateSelectionState({ ...state, members: [staleRebinding], activeId: undefined }).status === 'ok',
    'stale members may be rebinding',
  );

  const invalidGeometry = makeMember('bad-geometry', {
    binding: {
      kind: 'drawn-geometry',
      geometry: { type: 'LineString', coordinates: [Number.NaN, 0] },
      wrapMode: 'minimum-arc',
      rebindCapability: 'query',
    },
  });
  assert(
    validateSelectionState({ ...state, members: [invalidGeometry], activeId: undefined }).status === 'error',
    'drawn geometry coordinates must be finite JSON data',
  );

  for (const [id, type, coordinates] of [
    ['bad-point-shape', 'Point', [[1, 2]]],
    ['bad-line-shape', 'LineString', [1, 2]],
    [
      'open-polygon',
      'Polygon',
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      ],
    ],
  ] as const) {
    const malformed = makeMember(id, {
      binding: {
        kind: 'drawn-geometry',
        geometry: { type, coordinates },
        wrapMode: 'minimum-arc',
        rebindCapability: 'query',
      },
    });
    assert(
      validateSelectionState({ ...state, members: [malformed], activeId: undefined }).status === 'error',
      `${id} must fail discriminant-specific GeoJSON validation`,
    );
  }
}

function testFrozenMembersRequireCompleteDeepFrozenSnapshots(): void {
  const forged = makeMember('forged-frozen', {
    status: 'frozen',
    lastSnapshot: { binding: 'snapshot' } as SnapshotEnvelope,
  });
  assert(
    validateSelectionState({ members: [forged], activeId: forged.id, sceneRevision: 'scene-1' }).status === 'error',
    'a snapshot-shaped object without a valid semantic envelope must fail',
  );

  const snapshot = makeSnapshot('valid-frozen');
  const frozen = makeMember('valid-frozen', { status: 'frozen', lastSnapshot: snapshot });
  const state: SelectionState = { members: [frozen], sceneRevision: 'scene-1' };
  assert(validateSelectionState(state).status === 'ok', 'complete immutable snapshots are accepted');
  assert(state.members[0].lastSnapshot === snapshot, 'validation preserves the original snapshot');

  const thawed = JSON.parse(JSON.stringify(snapshot)) as SnapshotEnvelope;
  assert(
    validateSelectionState({ members: [{ ...frozen, lastSnapshot: thawed }], sceneRevision: 'scene-1' }).status ===
      'error',
    'a semantically valid but mutable snapshot must fail the immutable selection-state contract',
  );

  const mismatchedSnapshot = makeSnapshot('mismatched-frozen', { datasetId: 'other-dataset' });
  assert(
    validateSelectionState({
      members: [{ ...frozen, lastSnapshot: mismatchedSnapshot }],
      sceneRevision: 'scene-1',
    }).status === 'error',
    'snapshot provenance must match the selection binding provenance',
  );
}

function testJsonBindingsAreIterativeAndPrototypeSafe(): void {
  const validateParams = (params: unknown) =>
    validateSelectionState({
      sceneRevision: 'scene-1',
      members: [
        makeMember('query', { binding: { kind: 'render-query', queryId: 'query', params, rebindCapability: 'query' } }),
      ],
    });
  let deep: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < 20000; index += 1) deep = { next: deep };
  assert(validateParams(deep).status === 'ok', 'deep acyclic params validate without recursion');
  let cursor = deep;
  for (let index = 0; index < 20000; index += 1) cursor = cursor.next as Record<string, unknown>;
  assert(cursor.leaf === true, 'validation does not change the deep input');
  const shared = { value: 1 };
  const dag = { first: shared, second: shared };
  assert(validateParams(dag).status === 'ok', 'shared DAG nodes are not mistaken for cycles');
  assert(dag.first === shared && dag.second === shared, 'validation preserves both references');
  const params = JSON.parse('{"__proto__":{"inherited":"yes"},"value":1}') as Record<string, unknown>;
  assert(validateParams(params).status === 'ok', 'an own prototype-named data key remains plain JSON');
  assert(Object.prototype.hasOwnProperty.call(params, '__proto__'), 'prototype-named key remains an own property');
  assert(
    Object.getPrototypeOf(params) === Object.prototype && !('inherited' in params),
    'validation never changes prototypes',
  );
  const sparse: unknown[] = [];
  sparse.length = 0xffffffff;
  assert(validateParams(sparse).status === 'error', 'maximum sparse arrays fail before length-sized allocation');
}

testStateValidation();
testFrozenMembersRequireCompleteDeepFrozenSnapshots();
testJsonBindingsAreIterativeAndPrototypeSafe();
