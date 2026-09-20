import type { CustomObject } from '../interfaces';
import type { ResolvedLayerRuntime } from '../visualization/types';
import type { SelectionMember } from './selection-state';
import {
  createRenderQuerySnapshot,
  resolveSelectionSnapshot,
  type RenderQuerySnapshotInput,
  type SelectionResolutionRegistry,
} from './selection-query';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertThrows(action: () => unknown, expected: string): void {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes(expected), `expected ${JSON.stringify(expected)}, received ${JSON.stringify(message)}`);
    return;
  }
  throw new Error(`expected an error containing ${JSON.stringify(expected)}`);
}

function runtime(): ResolvedLayerRuntime {
  return {
    descriptor: {
      schemaVersion: 1,
      catalogRevision: 'catalog-1',
      visualizationId: 'point',
      visualizationRevision: 'point-v1',
      datasetId: 'airports',
      dataRevision: 'airports-v1',
      layerId: 'point-map',
      layerType: 'ScatterplotLayer',
      rendererVersion: 1,
      rendererLibraryVersion: '9.3.2',
      declaredProps: {},
      resolvedProps: {},
      accessorIds: { getPosition: 'coordinates' },
      resolvedSupport: {
        producer: 'scatter-point',
        positionAccessorId: 'coordinates',
        radius: { value: 100, unit: 'meters' },
        radiusScale: 1,
        radiusMinPixels: 2,
        antialiasBufferPx: 2,
        billboard: true,
      },
      selection: { supported: ['click'], coordinateAccessor: 'coordinates' },
      cameraEnvelope: {
        producer: 'scatter-point',
        producerVersion: 1,
        positionAccessor: 'coordinates',
        radius: { prop: 'getRadius', unitProp: 'radiusUnits', scaleProp: 'radiusScale' },
        minPixelsProp: 'radiusMinPixels',
        maxPixelsProp: 'radiusMaxPixels',
        support: { antialiasBufferPx: 2 },
        capabilities: {
          supportsLive: false,
          supportsPrediction: false,
          maxPredictionHorizonMs: 0,
          nominalUpdateHz: 1,
          frameEvolution: 'revision-step',
        },
      },
      cameraCalibration: {
        version: 1,
        referenceZoom: 8,
        referenceSafeAreaPx: 921600,
        metrics: {
          elevation: { unit: 'meters', lo: 10, hi: 10000, source: 'catalog' },
          density: { unit: 'count/km2', lo: 1, hi: 1000, source: 'catalog' },
          aspect: { unit: 'ratio', lo: 1, hi: 8, source: 'catalog' },
        },
      },
      resolvedLayerDigest: 'descriptor-digest-1',
    },
    data: [],
  };
}

function lineRuntime(): ResolvedLayerRuntime {
  const base = runtime();
  return {
    ...base,
    descriptor: {
      ...base.descriptor,
      layerId: 'line-flight-paths',
      layerType: 'LineLayer',
      accessorIds: { getSourcePosition: 'commuteSource', getTargetPosition: 'commuteTarget' },
      resolvedSupport: {
        producer: 'line-path',
        sourcePositionAccessorId: 'commuteSource',
        targetPositionAccessorId: 'commuteTarget',
        width: { value: 1, unit: 'pixels' },
        widthScale: 1,
        antialiasBufferPx: 2,
      },
      selection: {
        supported: ['click', 'path'],
        pathAccessor: 'commutePath',
        renderQueryId: 'select-line-path-v1',
      },
      cameraEnvelope: {
        producer: 'line-path',
        producerVersion: 1,
        sourcePositionAccessor: 'commuteSource',
        targetPositionAccessor: 'commuteTarget',
        width: { prop: 'getWidth', unitProp: 'widthUnits', scaleProp: 'widthScale' },
        minPixelsProp: 'widthMinPixels',
        maxPixelsProp: 'widthMaxPixels',
        support: { antialiasBufferPx: 2 },
        capabilities: {
          supportsLive: false,
          supportsPrediction: false,
          maxPredictionHorizonMs: 0,
          nominalUpdateHz: 1,
          frameEvolution: 'revision-step',
        },
      },
    },
  };
}

function member(
  binding: SelectionMember['binding'],
  provenancePatch: Partial<SelectionMember['provenance']> = {},
): SelectionMember {
  return {
    id: 'member-1',
    pinned: false,
    source: binding.kind === 'drawn-geometry' ? 'drawn-region' : 'click-object',
    status: 'current',
    operation: 'idle',
    provenance: {
      datasetId: 'airports',
      visualizationId: 'point',
      layerId: 'point-map',
      dataRevision: 'airports-v1',
      visualizationRevision: 'point-v1',
      producerId: 'scatter-point',
      producerVersion: 1,
      ...provenancePatch,
    },
    binding,
  };
}

function queryInput(object: CustomObject = { id: 'airport-1', coordinates: [10, 20] }): RenderQuerySnapshotInput {
  return {
    schemaVersion: 1,
    queryId: 'select-line-path-v1',
    sceneRevision: 'scene-1',
    dataRevision: 'airports-v1',
    resolvedLayerDigest: 'descriptor-digest-1',
    marks: [{ kind: 'source-object', object }],
  };
}

function registry(query: RenderQuerySnapshotInput): SelectionResolutionRegistry {
  return {
    resolveFeatureRefs: () => ({
      status: 'ok',
      value: query.marks.flatMap((mark: RenderQuerySnapshotInput['marks'][number]) =>
        mark.kind === 'source-object' ? [mark.object] : [],
      ),
    }),
    resolveRenderQuery: () => ({ status: 'ok', value: query }),
    resolveDrawnGeometryMarks: () => ({
      status: 'ok',
      value: {
        schemaVersion: 1,
        resolverId: 'drawn-geometry-association-v1',
        sceneRevision: query.sceneRevision,
        dataRevision: query.dataRevision,
        resolvedLayerDigest: query.resolvedLayerDigest,
        marks: query.marks,
      },
    }),
  };
}

function testOwnedExactQuerySnapshots(): void {
  const input = queryInput();
  const snapshot = createRenderQuerySnapshot(input);
  assert(snapshot !== input, 'query snapshot owns the root');
  assert(snapshot.marks !== input.marks, 'query snapshot owns mark arrays');
  assert(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.marks), 'query snapshot is deeply frozen');
  const source = snapshot.marks[0];
  assert(source.kind === 'source-object' && Object.isFrozen(source.object), 'source object is frozen');

  (input.marks[0] as { object: CustomObject }).object.coordinates[0] = 99;
  assert(
    source.kind === 'source-object' && source.object.coordinates[0] === 10,
    'source mutation cannot alter the owned query snapshot',
  );

  const extra = { ...queryInput(), unexpected: true } as RenderQuerySnapshotInput & { unexpected: boolean };
  assertThrows(() => createRenderQuerySnapshot(extra), 'exact schema');

  let getterReads = 0;
  const getter = queryInput() as unknown as Record<string, unknown>;
  Object.defineProperty(getter, 'queryId', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'select-line-path-v1';
    },
  });
  assertThrows(() => createRenderQuerySnapshot(getter as unknown as RenderQuerySnapshotInput), 'data properties');
  assert(getterReads === 0, 'query accessors are rejected without execution');

  const symbolArray = queryInput();
  let iteratorReads = 0;
  Object.defineProperty(symbolArray.marks, Symbol.iterator, {
    configurable: true,
    get() {
      iteratorReads += 1;
      return Array.prototype[Symbol.iterator];
    },
  });
  assertThrows(() => createRenderQuerySnapshot(symbolArray), 'dense');
  assert(iteratorReads === 0, 'array symbol accessors are rejected without execution');
}

function testQueryContractsFailClosed(): void {
  const wrongKind = queryInput();
  wrongKind.queryId = 'select-hexagon-cell-v1';
  assertThrows(() => createRenderQuerySnapshot(wrongKind), 'hexagon-cell');

  const unknown = queryInput() as unknown as { queryId: string };
  unknown.queryId = 'select-line-path-v999';
  assertThrows(() => createRenderQuerySnapshot(unknown as unknown as RenderQuerySnapshotInput), 'not registered');

  const customPrototype = Object.assign(Object.create({ inherited: true }), queryInput());
  assertThrows(() => createRenderQuerySnapshot(customPrototype as RenderQuerySnapshotInput), 'plain objects');

  const hex: RenderQuerySnapshotInput = {
    schemaVersion: 1,
    queryId: 'select-hexagon-cell-v1',
    sceneRevision: 'scene-1',
    dataRevision: 'airports-v1',
    resolvedLayerDigest: 'descriptor-digest-1',
    marks: [
      {
        kind: 'hexagon-cell',
        cellId: '2:3',
        center: [10, 20],
        footprintRing: [
          [10, 19.9],
          [10.1, 19.95],
          [10.1, 20.05],
          [10, 20.1],
          [9.9, 20.05],
          [9.9, 19.95],
          [10, 19.9],
        ],
        elevationValue: 250,
        count: 4,
      },
    ],
  };
  assert(createRenderQuerySnapshot(hex).marks[0].kind === 'hexagon-cell', 'valid hex cell snapshot');
  const open = queryInput();
  Object.assign(open, hex);
  const mark = open.marks[0] as Extract<(typeof open.marks)[number], { kind: 'hexagon-cell' }>;
  mark.footprintRing = mark.footprintRing.slice(0, 6);
  assertThrows(() => createRenderQuerySnapshot(open), 'closed');
}

function testResolveVersionedSelection(): void {
  const renderMember = member(
    {
      kind: 'render-query',
      queryId: 'select-line-path-v1',
      params: { b: 2, a: 1 },
      rebindCapability: 'query',
    },
    {
      layerId: 'line-flight-paths',
      producerId: 'line-path',
    },
  );
  const input = queryInput();
  const resolved = resolveSelectionSnapshot(
    renderMember,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    lineRuntime(),
    registry(input),
  );
  assert(resolved.status === 'ok', 'current render query resolves');
  assert(resolved.value.marks.length === 1, 'resolved query retains marks');
  assert(resolved.value.resolvedLayerDigest === 'descriptor-digest-1', 'resolved layer digest is retained');
  assert(Object.isFrozen(resolved.value), 'resolved selection is frozen');

  const reorderedBindingMember: SelectionMember = {
    ...renderMember,
    binding: {
      kind: 'render-query',
      queryId: 'select-line-path-v1',
      rebindCapability: 'query',
      params: { a: 1, b: 2 },
    },
  };
  const reordered = resolveSelectionSnapshot(
    reorderedBindingMember,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    lineRuntime(),
    registry(input),
  );
  assert(
    reordered.status === 'ok' && reordered.value.selectionRevision === resolved.value.selectionRevision,
    'canonical-equivalent binding key order keeps selection revision stable',
  );

  const changedBindingMember: SelectionMember = {
    ...renderMember,
    binding: {
      kind: 'render-query',
      queryId: 'select-line-path-v1',
      rebindCapability: 'query',
      params: { a: 1, b: 3 },
    },
  };
  const changedBinding = resolveSelectionSnapshot(
    changedBindingMember,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    lineRuntime(),
    registry(input),
  );
  assert(
    changedBinding.status === 'ok' && changedBinding.value.selectionRevision !== resolved.value.selectionRevision,
    'binding parameter changes selection revision',
  );

  const secondInput = queryInput({ id: 'airport-2', coordinates: [10, 20] });
  const changed = resolveSelectionSnapshot(
    renderMember,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    lineRuntime(),
    registry(secondInput),
  );
  assert(changed.status === 'ok', 'changed query resolves');
  assert(
    changed.status === 'ok' && changed.value.selectionRevision !== resolved.value.selectionRevision,
    'mark identity changes selection revision',
  );

  const orderedMarks = queryInput();
  orderedMarks.marks = [
    { kind: 'source-object', object: { id: 'airport-1', coordinates: [10, 20] } },
    { kind: 'source-object', object: { id: 'airport-2', coordinates: [11, 21] } },
  ];
  const reversedMarks: RenderQuerySnapshotInput = {
    ...orderedMarks,
    marks: [...orderedMarks.marks].reverse(),
  };
  const ordered = resolveSelectionSnapshot(
    renderMember,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    lineRuntime(),
    registry(orderedMarks),
  );
  const reversed = resolveSelectionSnapshot(
    renderMember,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    lineRuntime(),
    registry(reversedMarks),
  );
  assert(ordered.status === 'ok' && reversed.status === 'ok', 'ordered mark fixtures resolve');
  assert(ordered.value.selectionRevision !== reversed.value.selectionRevision, 'mark order changes selection revision');

  const sceneTwoInput = queryInput();
  sceneTwoInput.sceneRevision = 'scene-2';
  const sceneTwo = resolveSelectionSnapshot(
    renderMember,
    { selectionSceneRevision: 'scene-2', expectedSceneRevision: 'scene-2' },
    lineRuntime(),
    registry(sceneTwoInput),
  );
  assert(sceneTwo.status === 'ok', 'matching updated scene revision resolves');
  assert(
    sceneTwo.value.selectionRevision !== resolved.value.selectionRevision,
    'scene revision changes selection revision',
  );

  const dataTwoRuntime = lineRuntime();
  dataTwoRuntime.descriptor = { ...dataTwoRuntime.descriptor, dataRevision: 'airports-v2' };
  const dataTwoInput = queryInput();
  dataTwoInput.dataRevision = 'airports-v2';
  const dataTwoMember: SelectionMember = {
    ...renderMember,
    provenance: { ...renderMember.provenance, dataRevision: 'airports-v2' },
  };
  const dataTwo = resolveSelectionSnapshot(
    dataTwoMember,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    dataTwoRuntime,
    registry(dataTwoInput),
  );
  assert(dataTwo.status === 'ok', 'matching updated data revision resolves');
  assert(
    dataTwo.value.selectionRevision !== resolved.value.selectionRevision,
    'data revision changes selection revision',
  );

  const secondRuntime = lineRuntime();
  secondRuntime.descriptor = {
    ...secondRuntime.descriptor,
    resolvedLayerDigest: 'descriptor-digest-2',
  };
  const secondDigestInput = queryInput();
  secondDigestInput.resolvedLayerDigest = 'descriptor-digest-2';
  const changedDigest = resolveSelectionSnapshot(
    renderMember,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    secondRuntime,
    registry(secondDigestInput),
  );
  assert(changedDigest.status === 'ok', 'matching updated resolved layer digest resolves');
  assert(changedDigest.value.resolvedLayerDigest === 'descriptor-digest-2', 'updated digest is retained');
  assert(
    changedDigest.value.selectionRevision !== resolved.value.selectionRevision,
    'resolved layer digest changes selection revision',
  );

  const stale = resolveSelectionSnapshot(
    renderMember,
    { selectionSceneRevision: 'scene-old', expectedSceneRevision: 'scene-1' },
    lineRuntime(),
    registry(input),
  );
  assert(stale.status === 'stale', 'scene mismatch is stale');

  let revisionGetterReads = 0;
  const getterRevisions = { expectedSceneRevision: 'scene-1' } as {
    selectionSceneRevision: string;
    expectedSceneRevision: string;
  };
  Object.defineProperty(getterRevisions, 'selectionSceneRevision', {
    enumerable: true,
    get() {
      revisionGetterReads += 1;
      return 'scene-1';
    },
  });
  const unsafeRevision = resolveSelectionSnapshot(renderMember, getterRevisions, lineRuntime(), registry(input));
  assert(unsafeRevision.status === 'error', 'revision accessors fail closed');
  assert(revisionGetterReads === 0, 'revision accessors are rejected without execution');

  const badRevision = queryInput();
  badRevision.resolvedLayerDigest = 'wrong';
  const mismatch = resolveSelectionSnapshot(
    renderMember,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    lineRuntime(),
    registry(badRevision),
  );
  assert(mismatch.status === 'stale', 'descriptor mismatch is stale');

  const unsafeRuntime = lineRuntime();
  let digestGetterReads = 0;
  Object.defineProperty(unsafeRuntime.descriptor, 'resolvedLayerDigest', {
    enumerable: true,
    get() {
      digestGetterReads += 1;
      return 'descriptor-digest-1';
    },
  });
  const malformedRuntime = resolveSelectionSnapshot(
    renderMember,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    unsafeRuntime,
    registry(input),
  );
  assert(malformedRuntime.status === 'error', 'runtime descriptor accessors fail closed');
  assert(digestGetterReads === 0, 'runtime descriptor accessors are rejected without execution');

  const wrongProducerMember = member({
    kind: 'render-query',
    queryId: 'select-line-path-v1',
    params: {},
    rebindCapability: 'query',
  });
  const wrongProducer = resolveSelectionSnapshot(
    wrongProducerMember,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    runtime(),
    registry(input),
  );
  assert(wrongProducer.status === 'unsupported', 'query and runtime producer mismatch fails closed');
}

function testFeatureRefsRequireCurrentProvenance(): void {
  const featureMember = member({
    kind: 'feature-refs',
    featureIds: ['airport-1'],
    rebindCapability: 'stable-id',
  });
  const current = resolveSelectionSnapshot(
    featureMember,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    runtime(),
    registry(queryInput()),
  );
  assert(current.status === 'ok' && current.value.marks.length === 1, 'current feature refs resolve');

  const rebinding: SelectionMember = { ...featureMember, status: 'stale', operation: 'rebinding' };
  const stale = resolveSelectionSnapshot(
    rebinding,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    runtime(),
    registry(queryInput()),
  );
  assert(stale.status === 'stale', 'rebinding feature refs cannot resolve as current');

  const mismatched = resolveSelectionSnapshot(
    member(
      { kind: 'feature-refs', featureIds: ['airport-1'], rebindCapability: 'stable-id' },
      { visualizationRevision: 'point-v0' },
    ),
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    runtime(),
    registry(queryInput()),
  );
  assert(mismatched.status === 'stale', 'feature refs require matching descriptor provenance');
}

function testDrawnGeometryAndMarksAreBothRetained(): void {
  const drawn = member({
    kind: 'drawn-geometry',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    },
    wrapMode: 'minimum-arc',
    rebindCapability: 'query',
  });
  const resolved = resolveSelectionSnapshot(
    drawn,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    runtime(),
    registry(queryInput()),
  );
  assert(resolved.status === 'ok', 'drawn selection resolves');
  assert(resolved.value.geometry?.geometry.type === 'Polygon', 'drawn geometry is retained');
  assert(resolved.value.marks.length === 1, 'associated marks are retained with drawn geometry');
  assert(
    resolved.value.association?.resolverId === 'drawn-geometry-association-v1',
    'versioned geometry association metadata is retained',
  );

  const changedGeometryMember: SelectionMember = {
    ...drawn,
    binding: {
      kind: 'drawn-geometry',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [2, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      wrapMode: 'minimum-arc',
      rebindCapability: 'query',
    },
  };
  const changedGeometry = resolveSelectionSnapshot(
    changedGeometryMember,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    runtime(),
    registry(queryInput()),
  );
  assert(changedGeometry.status === 'ok', 'changed drawn geometry resolves');
  assert(
    changedGeometry.value.selectionRevision !== resolved.value.selectionRevision,
    'drawn geometry changes selection revision',
  );

  const invalidResolverRegistry = registry(queryInput());
  invalidResolverRegistry.resolveDrawnGeometryMarks = (selectionMember, resolvedRuntime) => {
    const result = registry(queryInput()).resolveDrawnGeometryMarks!(selectionMember, resolvedRuntime);
    if (result.status !== 'ok') return result;
    return { status: 'ok', value: { ...result.value, resolverId: 'unversioned-resolver' } };
  };
  const invalidResolver = resolveSelectionSnapshot(
    drawn,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    runtime(),
    invalidResolverRegistry,
  );
  assert(invalidResolver.status === 'error', 'unversioned geometry association resolver fails closed');

  const staleAssociationRegistry = registry(queryInput());
  staleAssociationRegistry.resolveDrawnGeometryMarks = (selectionMember, resolvedRuntime) => {
    const result = registry(queryInput()).resolveDrawnGeometryMarks!(selectionMember, resolvedRuntime);
    if (result.status !== 'ok') return result;
    return { status: 'ok', value: { ...result.value, resolvedLayerDigest: 'wrong' } };
  };
  const staleAssociation = resolveSelectionSnapshot(
    drawn,
    { selectionSceneRevision: 'scene-1', expectedSceneRevision: 'scene-1' },
    runtime(),
    staleAssociationRegistry,
  );
  assert(staleAssociation.status === 'stale', 'stale geometry association digest fails closed');
}

function main(): void {
  testOwnedExactQuerySnapshots();
  testQueryContractsFailClosed();
  testResolveVersionedSelection();
  testFeatureRefsRequireCurrentProvenance();
  testDrawnGeometryAndMarksAreBothRetained();
}

main();
