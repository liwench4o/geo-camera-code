import type { VisualPrimitive } from '../camera/geometry/types';
import {
  buildProducerMetricContext,
  buildSceneMetricContext,
  enforceEnvelopeProductionBudget,
  validateProducerMetricContext,
  type ProducerMetricContext,
  type ProducerMetricContextInput,
  type SceneMetricContext,
  type SceneMetricContextInput,
} from './envelope-producer-contract';

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

function sceneInput(): SceneMetricContextInput {
  return {
    schemaVersion: 1,
    sceneRevision: 'scene-1',
    sceneContextRevision: 'scene-context-1',
    projectedFrameRevision: 'projected-frame-1',
    cameraCalibrationDigest: 'calibration-1',
    sceneSupportDigest: 'scene-support-1',
    referenceView: { longitude: 0, latitude: 0, zoom: 8, pitch: 0, bearing: 0 },
    referenceViewport: { width: 800, height: 600 },
    projectionOptions: { meterSupportTolerancePx: 0.25, meterSupportIntervalBudget: 4096 },
    sceneCertifiedFootprintBounds: [
      { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      { minX: 5, minY: 5, maxX: 15, maxY: 15 },
    ],
  };
}

function primitives(): VisualPrimitive[] {
  return [
    { kind: 'screen-rect', position: [0, 0, 0], widthPx: 20, heightPx: 10 },
    { kind: 'screen-rect', position: [0, 0, 0], widthPx: 10, heightPx: 20 },
    { kind: 'point-disc', position: [1, 0, 0], radius: { value: 0, unit: 'pixels' } },
  ];
}

function producerInput(): ProducerMetricContextInput {
  return {
    schemaVersion: 1,
    selectionRevision: 'selection-1',
    resolvedLayerDigest: 'layer-1',
    cameraCalibrationDigest: 'calibration-1',
    targetWorldAreaKm2: 12,
    supportGroups: [
      { sourceId: 'source-a', primitiveIndexes: [0, 1] },
      { sourceId: 'source-b', primitiveIndexes: [2] },
    ],
    glyphPrimitiveIndexes: [0, 1, 2],
    footprintPrimitiveIndexes: [0, 1, 2],
    anchorWeightPolicy: 'projected-support-area-v1',
  };
}

function testSceneContextIsOwnedBrandedAndUsesRectangleUnion(): void {
  const input = sceneInput();
  const context = buildSceneMetricContext(input);
  assert(context.sceneContextProjectedSupportUnionArea === 175, 'overlapping scene rectangles are unioned once');
  assert(Object.isFrozen(context) && Object.isFrozen(context.referenceView), 'scene context is deeply frozen');

  input.sceneCertifiedFootprintBounds[0].maxX = 1000;
  assert(context.sceneContextProjectedSupportUnionArea === 175, 'scene context owns its input');

  const changed = buildSceneMetricContext({ ...sceneInput(), sceneSupportDigest: 'scene-support-2' });
  assert(changed.revision !== context.revision, 'scene support revision participates in the context revision');

  let getterReads = 0;
  const unsafe = sceneInput() as unknown as Record<string, unknown>;
  Object.defineProperty(unsafe, 'sceneRevision', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'scene-1';
    },
  });
  assertThrows(() => buildSceneMetricContext(unsafe as unknown as SceneMetricContextInput), 'data properties');
  assert(getterReads === 0, 'scene context rejects accessors without executing them');

  const invalidView = sceneInput();
  invalidView.referenceView.latitude = 90;
  assertThrows(() => buildSceneMetricContext(invalidView), 'reference projection is not certified');
}

function testProducerContextBuildsAlignedMetricStorage(): void {
  const scene = buildSceneMetricContext(sceneInput());
  const sourcePrimitives = primitives();
  const context = buildProducerMetricContext(producerInput(), scene, sourcePrimitives);

  assert(context.targetProjectedSupportUnionArea === 300, 'target rectangles use exact overlap-aware union');
  assert(context.supportGroups.length === 2, 'support groups retain source cardinality');
  assert(context.supportGroups[0].projectedSupportArea === 300, 'group area unions its primitive bounds');
  assert(context.supportGroups[0].anchorWeight === 300, 'default anchor weight uses projected support area');
  assert(context.supportGroups[1].anchorWeight === 0, 'zero-area support remains zero when another group has area');
  assert(context.glyphSupportAreasAtReferenceZoomPx2.length === 3, 'glyph areas have independent cardinality');
  assert(context.footprintProjectedPoints.length === 9, 'footprint points have independent support cardinality');
  assert(context.pathsProjected.length === 0, 'path metrics are independently empty');
  assert(Object.isFrozen(context) && Object.isFrozen(context.supportGroups), 'producer context is deeply frozen');

  sourcePrimitives[0] = { kind: 'point-disc', position: [30, 30], radius: { value: 50, unit: 'pixels' } };
  assert(context.targetProjectedSupportUnionArea === 300, 'producer context owns projected results');

  const valid = validateProducerMetricContext(context, {
    sceneRevision: 'scene-1',
    sceneContextRevision: 'scene-context-1',
    projectedFrameRevision: 'projected-frame-1',
    sceneSupportDigest: 'scene-support-1',
    selectionRevision: 'selection-1',
    resolvedLayerDigest: 'layer-1',
    cameraCalibrationDigest: 'calibration-1',
  });
  assert(valid.status === 'ok' && valid.value === context, 'branded context validates against exact revisions');

  const stale = validateProducerMetricContext(context, {
    sceneRevision: 'scene-1',
    sceneContextRevision: 'scene-context-1',
    projectedFrameRevision: 'projected-frame-1',
    sceneSupportDigest: 'scene-support-1',
    selectionRevision: 'selection-2',
    resolvedLayerDigest: 'layer-1',
    cameraCalibrationDigest: 'calibration-1',
  });
  assert(stale.status === 'stale', 'revision mismatch rejects the context as stale');

  const forged = { ...context } as ProducerMetricContext;
  const forgedResult = validateProducerMetricContext(forged, {
    sceneRevision: 'scene-1',
    sceneContextRevision: 'scene-context-1',
    projectedFrameRevision: 'projected-frame-1',
    sceneSupportDigest: 'scene-support-1',
    selectionRevision: 'selection-1',
    resolvedLayerDigest: 'layer-1',
    cameraCalibrationDigest: 'calibration-1',
  });
  assert(forgedResult.status === 'error', 'a structural copy cannot forge the module-private context brand');

  const forgedScene = { ...scene } as SceneMetricContext;
  assertThrows(
    () => buildProducerMetricContext(producerInput(), forgedScene, primitives()),
    'not a certified module-built context',
  );
}

function testSupportGroupsAndWeightsFailClosed(): void {
  const scene = buildSceneMetricContext(sceneInput());
  const sourcePrimitives = primitives();

  assertThrows(
    () =>
      buildProducerMetricContext(
        {
          ...producerInput(),
          supportGroups: [
            { sourceId: 'source-a', primitiveIndexes: [0, 1] },
            { sourceId: 'source-b', primitiveIndexes: [1, 2] },
          ],
        },
        scene,
        sourcePrimitives,
      ),
    'exactly one support group',
  );
  assertThrows(
    () =>
      buildProducerMetricContext(
        { ...producerInput(), supportGroups: [{ sourceId: 'source-a', primitiveIndexes: [1, 0, 2] }] },
        scene,
        sourcePrimitives,
      ),
    'strictly increasing',
  );
  assertThrows(
    () =>
      buildProducerMetricContext(
        {
          ...producerInput(),
          supportGroups: [
            { sourceId: 'same', primitiveIndexes: [0, 1] },
            { sourceId: 'same', primitiveIndexes: [2] },
          ],
        },
        scene,
        sourcePrimitives,
      ),
    'unique',
  );

  const zeroPrimitives: VisualPrimitive[] = [
    { kind: 'point-disc', position: [0, 0], radius: { value: 0, unit: 'pixels' } },
    { kind: 'point-disc', position: [1, 0], radius: { value: 0, unit: 'pixels' } },
  ];
  const zero = buildProducerMetricContext(
    {
      ...producerInput(),
      supportGroups: [
        { sourceId: 'zero-a', primitiveIndexes: [0] },
        { sourceId: 'zero-b', primitiveIndexes: [1] },
      ],
      glyphPrimitiveIndexes: [],
      footprintPrimitiveIndexes: [0, 1],
    },
    scene,
    zeroPrimitives,
  );
  assert(
    zero.supportGroups.every((group) => group.anchorWeight === 1),
    'all-zero projected areas deterministically fall back to equal weights',
  );

  const semantic = buildProducerMetricContext(
    {
      ...producerInput(),
      supportGroups: [
        { sourceId: 'source-a', primitiveIndexes: [0, 1], semanticWeight: 2 },
        { sourceId: 'source-b', primitiveIndexes: [2], semanticWeight: 3 },
      ],
      anchorWeightPolicy: 'explicit-semantic-v1',
    },
    scene,
    sourcePrimitives,
  );
  assert(
    semantic.supportGroups[0].anchorWeight === 2 && semantic.supportGroups[1].anchorWeight === 3,
    'versioned explicit semantic weights are retained',
  );

  const wrongCalibration = producerInput();
  wrongCalibration.cameraCalibrationDigest = 'other-calibration';
  assertThrows(
    () => buildProducerMetricContext(wrongCalibration, scene, sourcePrimitives),
    'camera calibration digest',
  );

  const withFacts = { ...producerInput(), facts: { rendererExact: true } } as ProducerMetricContextInput & {
    facts: object;
  };
  assertThrows(() => buildProducerMetricContext(withFacts, scene, sourcePrimitives), 'exact schema');
}

function testPathProjectionAndClosedProductionBudget(): void {
  const scene = buildSceneMetricContext(sceneInput());
  const path: VisualPrimitive = {
    kind: 'path-corridor',
    positions: [
      [0, 0, 0],
      [0.5, 0.25, 0],
      [1, 0, 0],
    ],
    halfWidth: { value: 2, unit: 'pixels' },
  };
  const context = buildProducerMetricContext(
    {
      ...producerInput(),
      supportGroups: [{ sourceId: 'path', primitiveIndexes: [0] }],
      glyphPrimitiveIndexes: [],
      footprintPrimitiveIndexes: [0],
    },
    scene,
    [path],
  );
  assert(context.pathsProjected.length === 1, 'path primitives create path metric storage');
  assert(context.pathsProjected[0].points.length === 3, 'path projection retains tessellation vertex cardinality');
  assert(context.pathsProjected[0].closed === false, 'path corridors remain open metric paths');

  const atLimit = enforceEnvelopeProductionBudget(
    { schemaVersion: 1, sourceItems: 100_000, primitives: 100_000, vertices: 1_000_000 },
    'strict-envelope-v1',
  );
  assert(atLimit.status === 'ok', 'the exact strict v1 ceilings are accepted');
  const sourceOverflow = enforceEnvelopeProductionBudget(
    { schemaVersion: 1, sourceItems: 200_000, primitives: 0, vertices: 0 },
    'strict-envelope-v1',
  );
  assert(
    sourceOverflow.status === 'unavailable' &&
      sourceOverflow.reason === 'envelope-budget-exceeded:sourceItems:200000:100000',
    '200k source items fail deterministically against the closed policy',
  );
  const primitiveOverflow = enforceEnvelopeProductionBudget(
    { schemaVersion: 1, sourceItems: 1, primitives: 100_001, vertices: 1 },
    'strict-envelope-v1',
  );
  assert(primitiveOverflow.status === 'unavailable', 'primitive ceiling is enforced');
  const vertexOverflow = enforceEnvelopeProductionBudget(
    { schemaVersion: 1, sourceItems: 1, primitives: 1, vertices: 1_000_001 },
    'strict-envelope-v1',
  );
  assert(vertexOverflow.status === 'unavailable', 'vertex ceiling is enforced');

  const callerLimits = {
    schemaVersion: 1,
    sourceItems: 1,
    primitives: 1,
    vertices: 1,
    maxPrimitives: 2,
  } as const;
  const rejected = enforceEnvelopeProductionBudget(callerLimits, 'strict-envelope-v1');
  assert(rejected.status === 'error', 'caller-supplied numeric limits are rejected');
  const unknownPolicy = enforceEnvelopeProductionBudget(
    { schemaVersion: 1, sourceItems: 1, primitives: 1, vertices: 1 },
    'strict-envelope-v2' as 'strict-envelope-v1',
  );
  assert(unknownPolicy.status === 'unsupported', 'unknown production policies fail closed');
}

function main(): void {
  testSceneContextIsOwnedBrandedAndUsesRectangleUnion();
  testProducerContextBuildsAlignedMetricStorage();
  testSupportGroupsAndWeightsFailClosed();
  testPathProjectionAndClosedProductionBudget();
}

main();
