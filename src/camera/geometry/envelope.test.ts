import { digestCanonical } from './canonical-digest';
import {
  createSnapshotEnvelope,
  mergeSnapshotEnvelopes,
  type SnapshotEnvelopeInput,
  validateSnapshotEnvelope,
} from './envelope';
import type {
  ContentMetrics,
  EnvelopeResult,
  SnapshotEnvelope,
  TargetProvenance,
  VisualPrimitive,
  WrapMetadata,
} from './types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertClose(actual: number, expected: number, tolerance: number, message: string): void {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, received ${actual}`);
}

function expectOk<T>(result: EnvelopeResult<T>, message: string): T {
  assert(result.status === 'ok', `${message}: ${result.status === 'ok' ? '' : result.reason}`);
  return result.value;
}

function makeProvenance(patch: Partial<TargetProvenance> = {}): TargetProvenance {
  return {
    datasetId: 'dataset',
    visualizationId: 'visualization',
    layerId: 'layer',
    dataRevision: 'data-1',
    visualizationRevision: 'visualization-1',
    producerId: 'fixture',
    producerVersion: 1,
    sceneRevision: 'scene-1',
    resolvedLayerDigest: 'layer-digest-1',
    ...patch,
  };
}

function makeUnionMetrics(patch: Partial<ContentMetrics> = {}): ContentMetrics {
  return {
    elevation: 0,
    density: 0,
    coverage: 0,
    dispersion: 0,
    elongation: 0,
    curvature: 0,
    calibrationVersion: 1,
    fallbackReasons: [],
    ...patch,
  };
}

function makeEnvelopeInput(id: string, primitive: VisualPrimitive): SnapshotEnvelopeInput {
  return {
    id,
    supportGuarantee: 'conservative',
    provenance: makeProvenance(),
    primitives: [primitive],
    anchor: [179.85, 0.05, 125000],
    metrics: makeUnionMetrics({ elevation: 1 }),
  };
}

function makePointEnvelope(
  id: string,
  longitude: number,
  anchorHeight: number,
  provenance: Partial<TargetProvenance> = {},
  supportGuarantee: SnapshotEnvelopeInput['supportGuarantee'] = 'renderer-exact',
): SnapshotEnvelope {
  return expectOk(
    createSnapshotEnvelope({
      ...makeEnvelopeInput(id, {
        kind: 'point-disc',
        position: [longitude, 0, anchorHeight],
        radius: { value: 4, unit: 'pixels' },
      }),
      supportGuarantee,
      provenance: makeProvenance(provenance),
      anchor: [longitude, 0, anchorHeight],
    }),
    `point envelope ${id} should construct`,
  );
}

function primitiveLongitudes(primitive: VisualPrimitive): number[] {
  const longitudes: number[] = [];
  switch (primitive.kind) {
    case 'point-disc':
    case 'screen-rect':
      longitudes.push(primitive.position[0]);
      break;
    case 'extruded-footprint':
      for (const ring of primitive.rings) {
        for (const coordinate of ring) {
          longitudes.push(coordinate[0]);
        }
      }
      break;
    case 'path-corridor':
      for (const position of primitive.positions) {
        longitudes.push(position[0]);
      }
      break;
    case 'polygon':
      for (const ring of primitive.rings) {
        for (const position of ring) {
          longitudes.push(position[0]);
        }
      }
      break;
    case 'mesh-support':
      for (const vertex of primitive.vertices) {
        longitudes.push(vertex[0]);
      }
      break;
  }
  return longitudes;
}

function envelopeLongitudes(envelope: SnapshotEnvelope): number[] {
  const longitudes: number[] = [];
  for (const primitive of envelope.frame.primitives) {
    for (const longitude of primitiveLongitudes(primitive)) {
      longitudes.push(longitude);
    }
  }
  return longitudes;
}

function withSupportGuarantee(
  envelope: SnapshotEnvelope,
  supportGuarantee: SnapshotEnvelope['supportGuarantee'],
): SnapshotEnvelope {
  return {
    ...envelope,
    supportGuarantee,
    revision: digestCanonical({
      provenance: envelope.provenance,
      supportGuarantee,
      wrap: envelope.frame.wrap,
      primitives: envelope.frame.primitives,
      anchor: envelope.frame.anchor,
      metrics: envelope.frame.metrics,
    }),
  };
}

function numberSpan(values: number[]): number {
  assert(values.length > 0, 'span requires at least one number');
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return maximum - minimum;
}

function testPlannedSnapshotAndDatelineUnionContract(): void {
  const sourcePrimitive: VisualPrimitive = {
    kind: 'extruded-footprint',
    rings: [
      [
        [179.8, 0],
        [179.9, 0],
        [179.9, 0.1],
        [179.8, 0],
      ],
    ],
    baseMeters: 0,
    topMeters: 250000,
  };
  const left = createSnapshotEnvelope(makeEnvelopeInput('left', sourcePrimitive));
  assert(left.status === 'ok', 'valid snapshot must construct');
  sourcePrimitive.topMeters = 1;
  assert(
    (left.value.frame.primitives[0] as Extract<VisualPrimitive, { kind: 'extruded-footprint' }>).topMeters === 250000,
    'snapshot must own an immutable copy and preserve actual height',
  );

  const leftEnvelope = left.value;
  const rightResult = createSnapshotEnvelope({
    ...makeEnvelopeInput('right', {
      kind: 'extruded-footprint',
      rings: [
        [
          [-179.7, 0],
          [-179.6, 0],
          [-179.6, 0.1],
          [-179.7, 0],
        ],
      ],
      baseMeters: 0,
      topMeters: 125000,
    }),
    anchor: [-179.65, 0.05, 62500],
  });
  assert(rightResult.status === 'ok', 'second snapshot must construct');
  const rightEnvelope = rightResult.value;
  const union = mergeSnapshotEnvelopes({
    id: 'comparison',
    envelopes: [leftEnvelope, rightEnvelope],
    anchorWeights: [2, 1],
    metrics: makeUnionMetrics({ elevation: 1, dispersion: 0.4 }),
  });
  assert(union.status === 'ok', 'compatible envelopes must merge');
  assert(union.value.frame.primitives.length === 2, 'union must preserve child primitives');
  assert(union.value.frame.wrap.wrapMode === 'minimum-arc', 'union must share one wrap frame');
  assert(
    union.value.frame.primitives
      .map((primitive) => (primitive as Extract<VisualPrimitive, { kind: 'extruded-footprint' }>).topMeters)
      .join(',') === '250000,125000',
    'union must preserve per-object heights',
  );
  assertClose(
    union.value.frame.anchor[0],
    180.01666666666668,
    1e-9,
    'union longitude anchor must use caller-supplied visual-area weights in the shared wrap frame',
  );
  assertClose(
    union.value.frame.anchor[2],
    104166.66666666667,
    1e-6,
    'union height anchor must use caller-supplied visual-area weights',
  );
}

function testSnapshotOwnsAndFreezesEveryNestedInput(): void {
  const positions: Array<[number, number, number]> = [
    [10, 1, 3],
    [11, 2, 4],
  ];
  const halfWidth = { value: 7, unit: 'pixels' as const };
  const pixelClamp = { minPx: 2, maxPx: 12, supportBufferPx: 1 };
  const primitive: VisualPrimitive = { kind: 'path-corridor', positions, halfWidth, pixelClamp };
  const provenance = makeProvenance();
  const fallbackReasons = ['source-calibration'];
  const metrics = makeUnionMetrics({ fallbackReasons });
  const anchor: [number, number, number] = [10.5, 1.5, 3.5];
  const wrap: WrapMetadata = { wrapReference: 10.5, worldOffset: 0, wrapMode: 'minimum-arc' };
  const primitives: VisualPrimitive[] = [primitive];
  const input: SnapshotEnvelopeInput = {
    id: 'owned',
    supportGuarantee: 'conservative',
    provenance,
    primitives,
    anchor,
    metrics,
    wrap,
  };

  const envelope = expectOk(createSnapshotEnvelope(input), 'owned snapshot should construct');
  positions[0][0] = 70;
  halfWidth.value = 99;
  pixelClamp.supportBufferPx = 50;
  provenance.datasetId = 'mutated-dataset';
  fallbackReasons[0] = 'mutated-reason';
  fallbackReasons.push('new-reason');
  anchor[0] = 80;
  wrap.wrapReference = -80;
  primitives.push({ kind: 'screen-rect', position: [0, 0], widthPx: 1, heightPx: 1 });

  const ownedPrimitive = envelope.frame.primitives[0] as Extract<VisualPrimitive, { kind: 'path-corridor' }>;
  assert(ownedPrimitive.positions[0][0] === 10, 'snapshot must own source coordinates');
  assert(ownedPrimitive.halfWidth.value === 7, 'snapshot must own nested renderer support');
  assert(ownedPrimitive.pixelClamp?.supportBufferPx === 1, 'snapshot must own nested pixel clamp state');
  assert(envelope.provenance.datasetId === 'dataset', 'snapshot must own provenance');
  assert(
    envelope.frame.metrics.fallbackReasons.join(',') === 'source-calibration',
    'snapshot must own metric fallback reasons',
  );
  assert(envelope.frame.anchor[0] === 10.5, 'snapshot must own the anchor tuple');
  assert(envelope.frame.wrap.wrapReference === 10.5, 'snapshot must own wrap metadata');
  assert(envelope.frame.primitives.length === 1, 'snapshot must own the primitive array');

  const frozenValues: Array<[string, object]> = [
    ['envelope', envelope],
    ['provenance', envelope.provenance],
    ['frame', envelope.frame],
    ['primitive array', envelope.frame.primitives],
    ['primitive', ownedPrimitive],
    ['position array', ownedPrimitive.positions],
    ['position tuple', ownedPrimitive.positions[0]],
    ['half width', ownedPrimitive.halfWidth],
    ['pixel clamp', ownedPrimitive.pixelClamp],
    ['anchor', envelope.frame.anchor],
    ['metrics', envelope.frame.metrics],
    ['fallback reasons', envelope.frame.metrics.fallbackReasons],
    ['wrap', envelope.frame.wrap],
  ];
  for (const [label, value] of frozenValues) {
    assert(Object.isFrozen(value), `${label} must be frozen`);
  }
  assert(validateSnapshotEnvelope(envelope).status === 'ok', 'the owned frozen snapshot must validate');
}

function testRevisionCommitsCompleteSemanticContentButNotIdentityLabel(): void {
  const primitive: VisualPrimitive = {
    kind: 'point-disc',
    position: [12, 3, 4],
    radius: { value: 5, unit: 'pixels' },
    pixelClamp: { minPx: 2, maxPx: 10, supportBufferPx: 1 },
  };
  const base = makeEnvelopeInput('base', primitive);
  const original = expectOk(createSnapshotEnvelope(base), 'base snapshot should construct');
  const renamed = expectOk(createSnapshotEnvelope({ ...base, id: 'renamed' }), 'renamed snapshot should construct');
  const provenanceChanged = expectOk(
    createSnapshotEnvelope({ ...base, provenance: { ...base.provenance, producerVersion: 2 } }),
    'provenance-changed snapshot should construct',
  );
  const supportChanged = expectOk(
    createSnapshotEnvelope({
      ...base,
      supportGuarantee: 'legacy-approximation',
    }),
    'support-changed snapshot should construct',
  );
  const primitiveChanged = expectOk(
    createSnapshotEnvelope({
      ...base,
      primitives: [{ ...primitive, pixelClamp: { ...primitive.pixelClamp, supportBufferPx: 2 } }],
    }),
    'primitive-changed snapshot should construct',
  );
  const anchorChanged = expectOk(
    createSnapshotEnvelope({ ...base, anchor: [base.anchor[0], base.anchor[1], base.anchor[2] + 1] }),
    'anchor-changed snapshot should construct',
  );
  const metricsChanged = expectOk(
    createSnapshotEnvelope({ ...base, metrics: { ...base.metrics, fallbackReasons: ['changed'] } }),
    'metrics-changed snapshot should construct',
  );
  const wrapChanged = expectOk(
    createSnapshotEnvelope({
      ...base,
      wrap: { wrapReference: 12, worldOffset: 1, wrapMode: 'minimum-arc' },
    }),
    'wrap-changed snapshot should construct',
  );

  assert(original.revision === renamed.revision, 'the envelope label must not enter the semantic frame revision');
  const changedRevisions = [
    provenanceChanged.revision,
    supportChanged.revision,
    primitiveChanged.revision,
    anchorChanged.revision,
    metricsChanged.revision,
    wrapChanged.revision,
  ];
  assert(
    changedRevisions.every((revision) => revision !== original.revision),
    'provenance, guarantee, wrap, primitive, anchor, and metrics must all enter the revision',
  );

  const forged: SnapshotEnvelope = {
    ...original,
    frame: {
      ...original.frame,
      metrics: { ...original.frame.metrics, density: 0.5 },
    },
  };
  assert(validateSnapshotEnvelope(forged).status === 'error', 'validation must reject a semantic revision mismatch');
}

function testConstructionAndValidationFailClosed(): void {
  const base = makeEnvelopeInput('valid', {
    kind: 'point-disc',
    position: [0, 0],
    radius: { value: 1, unit: 'pixels' },
  });
  const cases: Array<[string, SnapshotEnvelopeInput, 'error' | 'unsupported']> = [
    ['blank ID', { ...base, id: '' }, 'error'],
    ['empty support', { ...base, primitives: [] }, 'error'],
    [
      'invalid primitive support',
      {
        ...base,
        primitives: [{ kind: 'point-disc', position: [0, 0], radius: { value: -1, unit: 'pixels' } }],
      },
      'error',
    ],
    ['non-finite anchor', { ...base, anchor: [0, 0, Number.NaN] }, 'error'],
    ['unsupported anchor latitude', { ...base, anchor: [0, 90, 0] }, 'unsupported'],
    ['out-of-range metric', { ...base, metrics: { ...base.metrics, density: 2 } }, 'error'],
    [
      'non-string metric reason',
      {
        ...base,
        metrics: { ...base.metrics, fallbackReasons: [3 as unknown as string] },
      },
      'error',
    ],
    ['blank provenance field', { ...base, provenance: { ...base.provenance, datasetId: '' } }, 'error'],
    [
      'non-finite producer version',
      { ...base, provenance: { ...base.provenance, producerVersion: Number.POSITIVE_INFINITY } },
      'error',
    ],
    [
      'fractional world offset',
      { ...base, wrap: { wrapReference: 0, worldOffset: 0.5, wrapMode: 'minimum-arc' } },
      'error',
    ],
    [
      'metadata-only full world',
      { ...base, wrap: { wrapReference: 0, worldOffset: 0, wrapMode: 'full-world' } },
      'error',
    ],
  ];

  for (const [label, input, status] of cases) {
    const result = createSnapshotEnvelope(input);
    assert(result.status === status, `${label} must return ${status}, received ${result.status}`);
  }

  const valid = expectOk(createSnapshotEnvelope(base), 'valid validation fixture should construct');
  assert(
    validateSnapshotEnvelope({ ...valid, binding: 'live' as 'snapshot' }).status === 'error',
    'validation must reject a non-snapshot binding',
  );
  assert(
    validateSnapshotEnvelope({ ...valid, revision: 'not-a-digest' }).status === 'error',
    'validation must reject a malformed revision',
  );
  assert(
    validateSnapshotEnvelope({
      ...valid,
      provenance: { ...valid.provenance, producerVersion: Number.NaN },
    }).status === 'error',
    'validation must reject invalid provenance before canonical hashing',
  );
}

function testFullWorldDetectionRequiresAnActualCompleteConnectedSpan(): void {
  const completePath: VisualPrimitive = {
    kind: 'path-corridor',
    positions: [
      [180, 0, 0],
      [540, 0, 0],
    ],
    halfWidth: { value: 4, unit: 'pixels' },
  };
  const base: SnapshotEnvelopeInput = {
    ...makeEnvelopeInput('auto-full-world', completePath),
    anchor: [0, 0, 0],
  };
  const automatic = expectOk(
    createSnapshotEnvelope(base),
    'an omitted wrap must infer full-world from a complete connected source span',
  );
  assert(automatic.frame.wrap.wrapMode === 'full-world', 'automatic wrap must preserve complete-world topology');
  assert(numberSpan(envelopeLongitudes(automatic)) === 360, 'automatic full-world construction must not collapse');

  const contradictory = createSnapshotEnvelope({
    ...base,
    id: 'contradictory-minimum-arc',
    wrap: { wrapReference: 360, worldOffset: 0, wrapMode: 'minimum-arc' },
  });
  assert(contradictory.status === 'error', 'minimum-arc metadata must reject complete-world source support');

  const almostComplete = createSnapshotEnvelope({
    ...base,
    id: 'almost-full-world',
    primitives: [
      {
        ...completePath,
        positions: [
          [180, 0, 0],
          [540 - 5e-11, 0, 0],
        ],
      },
    ],
    wrap: { wrapReference: 360, worldOffset: 0, wrapMode: 'full-world' },
  });
  assert(almostComplete.status === 'error', 'every real source span below 360 degrees must reject full-world');

  const roundedDifferenceMaximum = 180;
  const roundedDifferenceMinimum = -179.99999999999997;
  assert(
    roundedDifferenceMaximum - roundedDifferenceMinimum === 360,
    'rounding-boundary fixture must exercise a subtraction that rounds up to 360',
  );
  const roundedUpAlmostComplete = createSnapshotEnvelope({
    ...base,
    id: 'rounded-up-almost-full-world',
    primitives: [
      {
        ...completePath,
        positions: [
          [roundedDifferenceMinimum, 0, 0],
          [roundedDifferenceMaximum, 0, 0],
        ],
      },
    ],
    wrap: { wrapReference: 0, worldOffset: 0, wrapMode: 'full-world' },
  });
  assert(
    roundedUpAlmostComplete.status === 'error',
    'a rounded subtraction must not promote a represented span below 360 degrees to full-world',
  );
}

function testCreatePromotesSequentialWindingPathAndReturnsAValidSnapshot(): void {
  const result = expectOk(
    createSnapshotEnvelope({
      ...makeEnvelopeInput('winding-path-full-world', {
        kind: 'path-corridor',
        positions: [
          [0, 0, 0],
          [170, 0, 0],
          [-20, 0, 0],
          [150, 0, 0],
        ],
        halfWidth: { value: 2, unit: 'pixels' },
      }),
      supportGuarantee: 'renderer-exact',
      anchor: [75, 0, 0],
    }),
    'sequential winding path should construct',
  );
  assert(result.frame.wrap.wrapMode === 'full-world', 'sequential winding path must promote to full-world');
  assert(
    result.frame.primitives[0].kind === 'path-corridor' &&
      result.frame.primitives[0].positions.map((position) => position[0]).join(',') === '0,170,340,510',
    'winding path topology must retain every sequentially unwrapped world copy',
  );
  assert(validateSnapshotEnvelope(result).status === 'ok', 'every successful winding-path create must validate');
}

function testCreatePreservesAndPromotesCanonicalWindingRing(): void {
  const result = expectOk(
    createSnapshotEnvelope({
      ...makeEnvelopeInput('winding-ring-full-world', {
        kind: 'polygon',
        rings: [
          [
            [0, 0, 0],
            [90, 1, 0],
            [180, 0, 0],
            [-90, -1, 0],
            [0, 0, 0],
          ],
        ],
      }),
      supportGuarantee: 'renderer-exact',
      anchor: [0, 0, 0],
    }),
    'canonical winding ring should construct',
  );
  assert(result.frame.wrap.wrapMode === 'full-world', 'canonical winding ring must promote to full-world');
  assert(result.frame.primitives[0].kind === 'polygon', 'winding-ring fixture must remain a polygon');
  const ringLongitudes = result.frame.primitives[0].rings[0].map((position) => position[0]);
  assert(
    ringLongitudes.join(',') === '0,90,180,270,360',
    'representable full-world ring closure must not collapse its winding endpoint',
  );
  assert(numberSpan(ringLongitudes) === 360, 'canonical winding ring must retain a complete world span');
  assert(validateSnapshotEnvelope(result).status === 'ok', 'every successful winding-ring create must validate');
}

function testRendererExactRejectsSupportThatIsOnlyConservative(): void {
  const cases: Array<[string, VisualPrimitive]> = [
    [
      'mesh support',
      {
        kind: 'mesh-support',
        vertices: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
        conservative: true,
      },
    ],
    [
      'meter point disc',
      {
        kind: 'point-disc',
        position: [0, 0, 0],
        radius: { value: 10, unit: 'meters' },
      },
    ],
    [
      'meter path corridor',
      {
        kind: 'path-corridor',
        positions: [
          [0, 0, 0],
          [1, 1, 0],
        ],
        halfWidth: { value: 10, unit: 'meters' },
      },
    ],
  ];
  const exactPeer = makePointEnvelope('exact-peer', 2, 0);

  for (const [label, primitive] of cases) {
    const input = {
      ...makeEnvelopeInput(`conservative-${label}`, primitive),
      supportGuarantee: 'renderer-exact' as const,
      anchor: [0, 0, 0] as [number, number, number],
    };
    assert(createSnapshotEnvelope(input).status === 'error', `${label} cannot be constructed as renderer-exact`);

    const conservative = expectOk(
      createSnapshotEnvelope({ ...input, supportGuarantee: 'conservative' }),
      `${label} must remain valid as conservative support`,
    );
    const forgedExact = withSupportGuarantee(conservative, 'renderer-exact');
    assert(
      validateSnapshotEnvelope(forgedExact).status === 'error',
      `validation must reject a revision-consistent renderer-exact ${label}`,
    );
    assert(
      mergeSnapshotEnvelopes({
        id: `forged-${label}-union`,
        envelopes: [forgedExact, exactPeer],
        anchorWeights: [1, 1],
        metrics: makeUnionMetrics(),
      }).status === 'error',
      `a forged renderer-exact ${label} must not create a false exact union`,
    );
  }
}

function testRendererExactRejectsEveryPositiveSupportInflation(): void {
  const cases: Array<[string, VisualPrimitive]> = [
    [
      'pixel point clamp buffer',
      {
        kind: 'point-disc',
        position: [0, 0, 0],
        radius: { value: 4, unit: 'pixels' },
        pixelClamp: { supportBufferPx: 0.5 },
      },
    ],
    [
      'pixel path clamp buffer',
      {
        kind: 'path-corridor',
        positions: [
          [0, 0, 0],
          [1, 1, 0],
        ],
        halfWidth: { value: 4, unit: 'pixels' },
        pixelClamp: { supportBufferPx: 0.5 },
      },
    ],
    [
      'screen rectangle buffer',
      { kind: 'screen-rect', position: [0, 0, 0], widthPx: 8, heightPx: 4, supportBufferPx: 0.5 },
    ],
    [
      'extruded footprint buffer',
      {
        kind: 'extruded-footprint',
        rings: [
          [
            [0, 0],
            [1, 0],
            [0, 1],
            [0, 0],
          ],
        ],
        baseMeters: 0,
        topMeters: 10,
        supportBufferPx: 0.5,
      },
    ],
    [
      'polygon buffer',
      {
        kind: 'polygon',
        rings: [
          [
            [0, 0, 0],
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 0],
          ],
        ],
        supportBufferPx: 0.5,
      },
    ],
  ];

  for (const [label, primitive] of cases) {
    const input: SnapshotEnvelopeInput = {
      ...makeEnvelopeInput(`inflated-${label}`, primitive),
      supportGuarantee: 'renderer-exact',
      anchor: [0, 0, 0],
    };
    assert(createSnapshotEnvelope(input).status === 'error', `${label} cannot be renderer-exact`);

    const conservative = expectOk(
      createSnapshotEnvelope({ ...input, supportGuarantee: 'conservative' }),
      `${label} must construct as conservative support`,
    );
    assert(
      validateSnapshotEnvelope(withSupportGuarantee(conservative, 'renderer-exact')).status === 'error',
      `validation must reject a revision-consistent exact label for ${label}`,
    );
  }

  const zeroBuffer = createSnapshotEnvelope({
    ...makeEnvelopeInput('zero-buffer-exact', {
      kind: 'point-disc',
      position: [0, 0, 0],
      radius: { value: 4, unit: 'pixels' },
      pixelClamp: { supportBufferPx: 0 },
    }),
    supportGuarantee: 'renderer-exact',
    anchor: [0, 0, 0],
  });
  assert(zeroBuffer.status === 'ok', 'zero support inflation must remain eligible for renderer-exact');
}

function testUnionRequiresExactWeightsAndUsesOverflowSafeCompensatedCentroid(): void {
  const left = makePointEnvelope('left-weight', 10, Number.MAX_VALUE);
  const right = makePointEnvelope('right-weight', 20, Number.MAX_VALUE);
  const metrics = makeUnionMetrics();
  const invalidWeights: Array<[string, number[]]> = [
    ['missing child weight', [1]],
    ['extra child weight', [1, 1, 1]],
    ['negative weight', [1, -1]],
    ['NaN weight', [1, Number.NaN]],
    ['infinite weight', [1, Number.POSITIVE_INFINITY]],
    ['zero total weight', [0, 0]],
  ];
  for (const [label, anchorWeights] of invalidWeights) {
    const result = mergeSnapshotEnvelopes({ id: label, envelopes: [left, right], anchorWeights, metrics });
    assert(result.status === 'error', `${label} must fail`);
  }
  assert(
    mergeSnapshotEnvelopes({ id: 'empty', envelopes: [], anchorWeights: [], metrics }).status === 'error',
    'an empty union must fail',
  );

  const huge = expectOk(
    mergeSnapshotEnvelopes({
      id: 'huge',
      envelopes: [left, right],
      anchorWeights: [Number.MAX_VALUE, Number.MAX_VALUE / 2],
      metrics,
    }),
    'finite huge weights should merge without overflow',
  );
  assertClose(huge.frame.anchor[0], 13.333333333333334, 1e-12, 'max-scaled weights must retain their ratio');
  assert(
    huge.frame.anchor[2] === Number.MAX_VALUE && Number.isFinite(huge.frame.anchor[2]),
    'finite maximum heights must not overflow during the centroid',
  );

  const tiny = expectOk(
    mergeSnapshotEnvelopes({
      id: 'tiny',
      envelopes: [left, right],
      anchorWeights: [Number.MIN_VALUE, Number.MIN_VALUE],
      metrics,
    }),
    'positive subnormal weights should remain a valid equal weighting',
  );
  assertClose(tiny.frame.anchor[0], 15, 1e-12, 'subnormal weights must not underflow before max scaling');

  const zeroWeight = expectOk(
    mergeSnapshotEnvelopes({
      id: 'zero-weight',
      envelopes: [left, right],
      anchorWeights: [1, 0],
      metrics,
    }),
    'zero-weight support should remain mergeable',
  );
  assert(zeroWeight.frame.primitives.length === 2, 'zero-weight children must retain complete support');
  assert(zeroWeight.frame.anchor[0] === 10, 'a zero-weight child must not move the anchor');
}

function testUnionProvenanceIsOrderedDomainSeparatedAndRequiresOneScene(): void {
  const left = makePointEnvelope('provenance-left', 0, 10, { producerVersion: 91 });
  const right = makePointEnvelope('provenance-right', 1, 20, {
    datasetId: 'dataset-right',
    layerId: 'layer-right',
    dataRevision: 'data-right',
    visualizationRevision: 'visualization-right',
    producerVersion: 7,
    resolvedLayerDigest: 'right-layer-digest',
  });
  const metrics = makeUnionMetrics();
  const union = expectOk(
    mergeSnapshotEnvelopes({ id: 'provenance-union', envelopes: [left, right], anchorWeights: [2, 1], metrics }),
    'ordered provenance union should construct',
  );
  const expectedField = (field: string, valuesInChildOrder: string[]) =>
    `union:${digestCanonical({ schema: 'envelope-union-v1', field, valuesInChildOrder })}`;
  const expectedResolvedLayerDigest = `union:${digestCanonical({
    schema: 'envelope-union-v1',
    children: [left, right].map(({ provenance, revision }) => ({ provenance, revision })),
  })}`;

  assert(union.provenance.producerId === 'envelope-union', 'union provenance must identify the union producer');
  assert(union.provenance.producerVersion === 1, 'union must use the fixed union-algorithm version');
  assert(union.provenance.sceneRevision === 'scene-1', 'the shared scene revision must be copied verbatim');
  assert(
    union.provenance.visualizationId === 'visualization',
    'an agreed source provenance field must be preserved verbatim',
  );
  assert(
    union.provenance.datasetId === expectedField('datasetId', ['dataset', 'dataset-right']),
    'a differing dataset ID must use the ordered field-domain digest',
  );
  assert(
    union.provenance.layerId === expectedField('layerId', ['layer', 'layer-right']),
    'a differing layer ID must use the ordered field-domain digest',
  );
  assert(
    union.provenance.dataRevision === expectedField('dataRevision', ['data-1', 'data-right']),
    'a differing data revision must use the ordered field-domain digest',
  );
  assert(
    union.provenance.visualizationRevision ===
      expectedField('visualizationRevision', ['visualization-1', 'visualization-right']),
    'a differing visualization revision must use the ordered field-domain digest',
  );
  assert(
    union.provenance.resolvedLayerDigest === expectedResolvedLayerDigest,
    'resolved layer provenance must digest complete ordered child provenance and revisions',
  );

  const reversed = expectOk(
    mergeSnapshotEnvelopes({ id: 'reversed', envelopes: [right, left], anchorWeights: [1, 2], metrics }),
    'reversed ordered provenance union should construct',
  );
  assert(
    reversed.provenance.datasetId !== union.provenance.datasetId &&
      reversed.provenance.resolvedLayerDigest !== union.provenance.resolvedLayerDigest,
    'child order must remain part of differing-field and complete-child provenance',
  );

  const differentScene = makePointEnvelope('other-scene', 2, 30, { sceneRevision: 'scene-2' });
  assert(
    mergeSnapshotEnvelopes({
      id: 'different-scene',
      envelopes: [left, differentScene],
      anchorWeights: [1, 1],
      metrics,
    }).status === 'error',
    'children from different scenes must not merge',
  );
}

function testGuaranteeOrderingAndWeightRescalingSemantics(): void {
  const exact = makePointEnvelope('exact', 0, 0, {}, 'renderer-exact');
  const conservative = makePointEnvelope('conservative', 1, 10, {}, 'conservative');
  const legacy = makePointEnvelope('legacy', 2, 20, {}, 'legacy-approximation');
  const metrics = makeUnionMetrics();
  const exactUnion = expectOk(
    mergeSnapshotEnvelopes({ id: 'exact-union', envelopes: [exact, exact], anchorWeights: [1, 1], metrics }),
    'exact union should construct',
  );
  const conservativeUnion = expectOk(
    mergeSnapshotEnvelopes({
      id: 'conservative-union',
      envelopes: [exact, conservative],
      anchorWeights: [1, 1],
      metrics,
    }),
    'conservative union should construct',
  );
  const legacyUnion = expectOk(
    mergeSnapshotEnvelopes({ id: 'legacy-union', envelopes: [exact, legacy], anchorWeights: [1, 1], metrics }),
    'legacy union should construct',
  );
  assert(exactUnion.supportGuarantee === 'renderer-exact', 'all-exact support must remain renderer-exact');
  assert(conservativeUnion.supportGuarantee === 'conservative', 'a conservative child must weaken the union');
  assert(legacyUnion.supportGuarantee === 'legacy-approximation', 'a legacy child must weaken the union');

  const scaled = expectOk(
    mergeSnapshotEnvelopes({ id: 'scaled', envelopes: [exact, conservative], anchorWeights: [100, 100], metrics }),
    'uniformly scaled union weights should construct',
  );
  assert(
    scaled.frame.anchor.join(',') === conservativeUnion.frame.anchor.join(',') &&
      scaled.provenance.resolvedLayerDigest === conservativeUnion.provenance.resolvedLayerDigest &&
      scaled.revision === conservativeUnion.revision,
    'uniform weight rescaling must not create a distinct provenance identity or revision',
  );
  const differentlyWeighted = expectOk(
    mergeSnapshotEnvelopes({
      id: 'different-weights',
      envelopes: [exact, conservative],
      anchorWeights: [2, 1],
      metrics,
    }),
    'different relative union weights should construct',
  );
  assert(
    differentlyWeighted.provenance.resolvedLayerDigest === conservativeUnion.provenance.resolvedLayerDigest &&
      differentlyWeighted.revision !== conservativeUnion.revision,
    'relative weights must enter revision only through their committed anchor',
  );
}

function testCanonicalRelativeWeightsAbsorbRepresentativeScaleRoundingJitter(): void {
  const left = makePointEnvelope('scaled-finite-left', 0, 0);
  const right = makePointEnvelope('scaled-finite-right', 1, 10);
  const anchorWeights = [8.533566038758289e99, 2.601040124061e99];
  const scale = 6.314834875874128e-72;
  const scaledAnchorWeights = anchorWeights.map((weight) => weight * scale);
  const metrics = makeUnionMetrics();

  const original = expectOk(
    mergeSnapshotEnvelopes({
      id: 'finite-scale-original',
      envelopes: [left, right],
      anchorWeights,
      metrics,
    }),
    'the original finite weight vector should construct',
  );
  const scaled = expectOk(
    mergeSnapshotEnvelopes({
      id: 'finite-scale-scaled',
      envelopes: [left, right],
      anchorWeights: scaledAnchorWeights,
      metrics,
    }),
    'the proportionally scaled finite weight vector should construct',
  );

  assert(
    original.frame.anchor.join(',') === scaled.frame.anchor.join(','),
    'representative scale rounding inside one canonical cell must produce the same committed anchor',
  );
  assert(
    original.revision === scaled.revision,
    'representative scale rounding inside one canonical cell must produce the same semantic revision',
  );

  const equal = expectOk(
    mergeSnapshotEnvelopes({
      id: 'finite-scale-equal',
      envelopes: [left, right],
      anchorWeights: [1, 1],
      metrics,
    }),
    'the equal nearby weight vector should construct',
  );
  const nearbyDistinct = expectOk(
    mergeSnapshotEnvelopes({
      id: 'finite-scale-nearby-distinct',
      envelopes: [left, right],
      anchorWeights: [1, 1 - 2 ** -38],
      metrics,
    }),
    'a nearby but meaningfully different relative weight should construct',
  );
  assert(
    equal.frame.anchor.join(',') !== nearbyDistinct.frame.anchor.join(',') &&
      equal.revision !== nearbyDistinct.revision,
    'canonical scaling must retain relative-weight differences above its binary precision quantum',
  );

  const tinyPositive = expectOk(
    mergeSnapshotEnvelopes({
      id: 'finite-scale-tiny-positive',
      envelopes: [left, right],
      anchorWeights: [1, 2 ** -60],
      metrics,
    }),
    'a tiny positive relative weight should construct',
  );
  const largerPositive = expectOk(
    mergeSnapshotEnvelopes({
      id: 'finite-scale-larger-positive',
      envelopes: [left, right],
      anchorWeights: [1, 2 ** -59],
      metrics,
    }),
    'a larger tiny positive relative weight should construct',
  );
  assert(
    tinyPositive.frame.anchor[0] > 0 &&
      largerPositive.frame.anchor[0] > tinyPositive.frame.anchor[0] &&
      largerPositive.revision !== tinyPositive.revision,
    'canonical scaling must preserve positive representable ratios and their monotone anchor influence',
  );

  const evenTie = expectOk(
    mergeSnapshotEnvelopes({
      id: 'finite-scale-even-tie',
      envelopes: [left, right],
      anchorWeights: [1, 0.5 + 2 ** -41],
      metrics,
    }),
    'an even canonical half-way ratio should construct',
  );
  const evenTieBaseline = expectOk(
    mergeSnapshotEnvelopes({
      id: 'finite-scale-even-tie-baseline',
      envelopes: [left, right],
      anchorWeights: [1, 0.5],
      metrics,
    }),
    'the even canonical half-way baseline should construct',
  );
  const oddTie = expectOk(
    mergeSnapshotEnvelopes({
      id: 'finite-scale-odd-tie',
      envelopes: [left, right],
      anchorWeights: [1, 0.5 + 3 * 2 ** -41],
      metrics,
    }),
    'an odd canonical half-way ratio should construct',
  );
  const oddTieBaseline = expectOk(
    mergeSnapshotEnvelopes({
      id: 'finite-scale-odd-tie-baseline',
      envelopes: [left, right],
      anchorWeights: [1, 0.5 + 2 ** -39],
      metrics,
    }),
    'the odd canonical half-way baseline should construct',
  );
  assert(
    evenTie.revision === evenTieBaseline.revision && oddTie.revision === oddTieBaseline.revision,
    'canonical half-way ratios must use deterministic round-to-nearest-even ties',
  );
}

function testCanonicalBoundaryCanDistinguishIndependentlyRoundedRescales(): void {
  const left = makePointEnvelope('canonical-boundary-left', 0, 0);
  const right = makePointEnvelope('canonical-boundary-right', 1, 10);
  const weights = [1.531354143224227e186, 1.495463033276566e183];
  const scale = 2.7080334976923803e-127;
  const metrics = makeUnionMetrics();
  const original = expectOk(
    mergeSnapshotEnvelopes({
      id: 'canonical-boundary-original',
      envelopes: [left, right],
      anchorWeights: weights,
      metrics,
    }),
    'the original canonical-boundary weights should construct',
  );
  const independentlyRounded = expectOk(
    mergeSnapshotEnvelopes({
      id: 'canonical-boundary-scaled',
      envelopes: [left, right],
      anchorWeights: weights.map((weight) => weight * scale),
      metrics,
    }),
    'the independently rounded canonical-boundary weights should construct',
  );

  assert(
    original.provenance.resolvedLayerDigest === independentlyRounded.provenance.resolvedLayerDigest,
    'anchor weights must never enter ordered union provenance',
  );
  assert(
    original.frame.anchor.join(',') !== independentlyRounded.frame.anchor.join(',') &&
      original.revision !== independentlyRounded.revision,
    'independent binary64 rescaling may cross a canonical ratio cell and commit a distinct anchor revision',
  );
}

function testRepresentableSubnormalRatiosHaveNoApplicationZeroThreshold(): void {
  const left = makePointEnvelope('subnormal-ratio-left', 0, 0);
  const right = makePointEnvelope('subnormal-ratio-right', 1, 10);
  const union = expectOk(
    mergeSnapshotEnvelopes({
      id: 'subnormal-ratio-union',
      envelopes: [left, right],
      anchorWeights: [1, Number.MIN_VALUE],
      metrics: makeUnionMetrics(),
    }),
    'a representable positive subnormal relative weight should construct',
  );

  assert(
    union.frame.anchor[0] === Number.MIN_VALUE,
    'a representable positive subnormal ratio must retain its smallest monotone anchor influence',
  );
}

function makeAllPrimitiveBranches(baseLongitude: number): VisualPrimitive[] {
  return [
    {
      kind: 'point-disc',
      position: [baseLongitude, 1, 11],
      radius: { value: 5, unit: 'pixels' },
      pixelClamp: { minPx: 2, maxPx: 8, supportBufferPx: 1 },
    },
    {
      kind: 'screen-rect',
      position: [baseLongitude + 0.01, 2, 22],
      widthPx: 20,
      heightPx: 10,
      supportBufferPx: 2,
    },
    {
      kind: 'extruded-footprint',
      rings: [
        [
          [baseLongitude, 3],
          [baseLongitude + 0.02, 3],
          [baseLongitude + 0.02, 3.02],
          [baseLongitude, 3],
        ],
      ],
      baseMeters: -5,
      topMeters: [100, 200, 300, 400],
      supportBufferPx: 3,
    },
    {
      kind: 'path-corridor',
      positions: [
        [baseLongitude, 4, 1],
        [baseLongitude + 0.03, 4.01, 2],
        [baseLongitude + 0.06, 4.02, 3],
      ],
      halfWidth: { value: 10, unit: 'meters' },
      pixelClamp: { minPx: 1, supportBufferPx: 2 },
    },
    {
      kind: 'polygon',
      rings: [
        [
          [baseLongitude, 5, 7],
          [baseLongitude + 0.02, 5, 8],
          [baseLongitude + 0.02, 5.02, 9],
          [baseLongitude, 5, 7],
        ],
      ],
      supportBufferPx: 4,
    },
    {
      kind: 'mesh-support',
      vertices: [
        [baseLongitude, 6, 31],
        [baseLongitude + 0.04, 6.01, 32],
        [baseLongitude + 0.01, 6.03, 33],
      ],
      conservative: true,
      supportBufferPx: 5,
    },
  ];
}

function testBoundedUnionReframesAllSixBranchesWithoutTopologyLoss(): void {
  const left = makePointEnvelope('wrap-left', 179.8, 0);
  const right = expectOk(
    createSnapshotEnvelope({
      id: 'all-branches',
      supportGuarantee: 'conservative',
      provenance: makeProvenance(),
      primitives: makeAllPrimitiveBranches(-179.9),
      anchor: [-179.87, 3.5, 25],
      metrics: makeUnionMetrics(),
    }),
    'all-branch child should construct',
  );
  const union = expectOk(
    mergeSnapshotEnvelopes({
      id: 'all-branches-union',
      envelopes: [left, right],
      anchorWeights: [1, 1],
      metrics: makeUnionMetrics(),
    }),
    'bounded all-branch union should construct',
  );

  assert(union.frame.wrap.wrapMode === 'minimum-arc', 'bounded children must use a shared minimum-arc frame');
  assert(union.frame.wrap.worldOffset === 0, 'bounded union frame must use canonical world zero');
  assert(numberSpan(envelopeLongitudes(union)) < 1, 'all six branches must occupy the same local dateline frame');
  assert(
    union.frame.primitives.map((primitive) => primitive.kind).join(',') ===
      'point-disc,point-disc,screen-rect,extruded-footprint,path-corridor,polygon,mesh-support',
    'child and primitive order must be preserved',
  );

  const [, point, rect, extrusion, path, polygon, mesh] = union.frame.primitives;
  assert(point.kind === 'point-disc' && point.position[2] === 11, 'point height must survive reframing');
  assert(rect.kind === 'screen-rect' && rect.position[2] === 22, 'rect height must survive reframing');
  assert(
    extrusion.kind === 'extruded-footprint' &&
      Array.isArray(extrusion.topMeters) &&
      extrusion.topMeters.join(',') === '100,200,300,400' &&
      extrusion.rings[0][0][0] === extrusion.rings[0][extrusion.rings[0].length - 1][0],
    'extrusion per-vertex heights, order, and closure must survive reframing',
  );
  assert(
    path.kind === 'path-corridor' && path.positions.map((position) => position[2]).join(',') === '1,2,3',
    'path tessellation order and heights must survive reframing',
  );
  assert(
    polygon.kind === 'polygon' &&
      polygon.rings[0].map((position) => position[2]).join(',') === '7,8,9,7' &&
      polygon.rings[0][0][0] === polygon.rings[0][polygon.rings[0].length - 1][0],
    'polygon order, heights, and closure must survive reframing',
  );
  assert(
    mesh.kind === 'mesh-support' && mesh.vertices.map((position) => position[2]).join(',') === '31,32,33',
    'mesh vertex order and heights must survive reframing',
  );
}

function testFullWorldUnionPreservesGeometryAndUsesOneIntegralTranslation(): void {
  const sourcePrimitives = makeAllPrimitiveBranches(360);
  sourcePrimitives.push({
    kind: 'polygon',
    rings: [
      [
        [180, -10, 0],
        [270, -10, 0],
        [360, 10, 0],
        [450, 10, 0],
        [540, -10, 0],
      ],
    ],
  });
  const fullWorld = expectOk(
    createSnapshotEnvelope({
      id: 'full-world',
      supportGuarantee: 'conservative',
      provenance: makeProvenance(),
      primitives: sourcePrimitives,
      anchor: [360, 0, 100],
      metrics: makeUnionMetrics(),
      wrap: { wrapReference: 360, worldOffset: 0, wrapMode: 'full-world' },
    }),
    'continuous explicit full-world snapshot should construct',
  );
  assert(numberSpan(envelopeLongitudes(fullWorld)) === 360, 'snapshot construction must preserve explicit 360 degrees');
  const bounded = makePointEnvelope('bounded-child', -179, 0);
  const union = expectOk(
    mergeSnapshotEnvelopes({
      id: 'full-world-union',
      envelopes: [fullWorld, bounded],
      anchorWeights: [1, 0],
      metrics: makeUnionMetrics(),
    }),
    'a union with explicit full-world support should construct',
  );

  assert(
    union.frame.wrap.wrapMode === 'full-world' &&
      union.frame.wrap.wrapReference === 0 &&
      union.frame.wrap.worldOffset === 0,
    'a full-world union must use the canonical full-world frame',
  );
  const before = envelopeLongitudes(fullWorld);
  const translatedFullWorld: number[] = [];
  for (let index = 0; index < fullWorld.frame.primitives.length; index += 1) {
    for (const longitude of primitiveLongitudes(union.frame.primitives[index])) {
      translatedFullWorld.push(longitude);
    }
  }
  assert(before.length === translatedFullWorld.length, 'full-world topology must retain every coordinate');
  for (let index = 0; index < before.length; index += 1) {
    assert(
      translatedFullWorld[index] === before[index] - 360,
      `full-world coordinate ${index} must receive the same deterministic integral world shift`,
    );
  }
  assert(numberSpan(translatedFullWorld) === 360, 'full-world geometry must not collapse under shortest-angle logic');
  assert(union.frame.anchor[0] === 0, 'the full-world child anchor must receive the same integral shift');
}

function testFullWorldAnchorUsesTheSameSourceAndUnionWorldCopiesAsItsSupport(): void {
  const fullWorld = expectOk(
    createSnapshotEnvelope({
      id: 'full-world-anchor-copy',
      supportGuarantee: 'conservative',
      provenance: makeProvenance(),
      primitives: [
        {
          kind: 'path-corridor',
          positions: [
            [180, 0, 0],
            [540, 0, 0],
          ],
          halfWidth: { value: 2, unit: 'pixels' },
        },
      ],
      anchor: [0, 0, 10],
      metrics: makeUnionMetrics(),
      wrap: { wrapReference: 360, worldOffset: 0, wrapMode: 'full-world' },
    }),
    'explicit full-world source should construct',
  );
  assert(fullWorld.frame.anchor[0] === 360, 'snapshot anchor must normalize into the source geometry world copy');

  const union = expectOk(
    mergeSnapshotEnvelopes({
      id: 'full-world-anchor-copy-union',
      envelopes: [fullWorld, makePointEnvelope('full-world-anchor-bounded-peer', -179, 0)],
      anchorWeights: [1, 0],
      metrics: makeUnionMetrics(),
    }),
    'full-world anchor-copy union should construct',
  );
  const translatedSupport = primitiveLongitudes(union.frame.primitives[0]);
  assert(
    translatedSupport.join(',') === '-180,180',
    'union must translate complete-world support into the canonical world copy',
  );
  assert(
    union.frame.anchor[0] === 0 &&
      union.frame.anchor[0] >= Math.min(...translatedSupport) &&
      union.frame.anchor[0] <= Math.max(...translatedSupport),
    'union anchor must receive the identical integral shift and remain inside the translated support copy',
  );
}

function testFullWorldUnionDerivesCanonicalCopyFromGeometryInterval(): void {
  const fullWorld = expectOk(
    createSnapshotEnvelope({
      id: 'full-world-effective-reference-edge',
      supportGuarantee: 'renderer-exact',
      provenance: makeProvenance(),
      primitives: [
        {
          kind: 'path-corridor',
          positions: [
            [0, 0, 0],
            [360, 0, 0],
          ],
          halfWidth: { value: 1, unit: 'pixels' },
        },
      ],
      anchor: [0, 0, 0],
      metrics: makeUnionMetrics(),
      wrap: { wrapReference: 540, worldOffset: 0, wrapMode: 'full-world' },
    }),
    'a coherent upper-edge full-world reference should construct',
  );
  const union = expectOk(
    mergeSnapshotEnvelopes({
      id: 'full-world-effective-reference-edge-union',
      envelopes: [fullWorld],
      anchorWeights: [1],
      metrics: makeUnionMetrics(),
    }),
    'a coherent upper-edge full-world child should merge',
  );

  assert(
    union.frame.primitives[0].kind === 'path-corridor' &&
      union.frame.primitives[0].positions.map((position) => position[0]).join(',') === '-360,0',
    'the canonical union copy must come from the complete geometry interval, not the declared reference edge',
  );
  assert(union.frame.anchor[0] === 0, 'full-world geometry and anchor must receive the same canonical translation');
  assert(validateSnapshotEnvelope(union).status === 'ok', 'a successful full-world edge union must validate');
}

function testFullWorldUnionReframesBoundedChildrenIntoOneSharedInterval(): void {
  const fullWorld = expectOk(
    createSnapshotEnvelope({
      id: 'full-world-shared-interval',
      supportGuarantee: 'renderer-exact',
      provenance: makeProvenance(),
      primitives: [
        {
          kind: 'path-corridor',
          positions: [
            [100, 0, 0],
            [460, 0, 0],
          ],
          halfWidth: { value: 1, unit: 'pixels' },
        },
      ],
      anchor: [200, 0, 0],
      metrics: makeUnionMetrics(),
      wrap: { wrapReference: 100, worldOffset: 0, wrapMode: 'full-world' },
    }),
    'the shifted full-world source should construct',
  );
  const bounded = makePointEnvelope('full-world-shared-interval-bounded', -170, 0);

  for (const [label, anchorWeights, expectedAnchor] of [
    ['bounded-only anchor', [0, 1], -170],
    ['equal anchor', [1, 1], -165],
  ] as const) {
    const union = expectOk(
      mergeSnapshotEnvelopes({
        id: `full-world-shared-interval-${label}`,
        envelopes: [fullWorld, bounded],
        anchorWeights: [...anchorWeights],
        metrics: makeUnionMetrics(),
      }),
      `${label} full-world union should merge`,
    );
    assert(
      union.frame.primitives[0].kind === 'path-corridor' &&
        union.frame.primitives[0].positions.map((position) => position[0]).join(',') === '-260,100' &&
        union.frame.primitives[1].kind === 'point-disc' &&
        union.frame.primitives[1].position[0] === -170,
      `${label} must place full-world and bounded geometry in one canonical interval`,
    );
    assertClose(union.frame.anchor[0], expectedAnchor, 1e-12, `${label} must use shared-copy child anchors`);
    assert(validateSnapshotEnvelope(union).status === 'ok', `${label} successful union must validate`);
  }
}

function testBoundedChildrenPromoteACollectiveCompleteWorldUnion(): void {
  const makeHalfWorld = (
    id: string,
    positions: Array<[number, number, number]>,
    anchorLongitude: number,
    wrapReference: number,
  ): SnapshotEnvelope =>
    expectOk(
      createSnapshotEnvelope({
        id,
        supportGuarantee: 'renderer-exact',
        provenance: makeProvenance(),
        primitives: [{ kind: 'path-corridor', positions, halfWidth: { value: 2, unit: 'pixels' } }],
        anchor: [anchorLongitude, 0, 0],
        metrics: makeUnionMetrics(),
        wrap: { wrapReference, worldOffset: 0, wrapMode: 'minimum-arc' },
      }),
      `${id} bounded half-world child should construct`,
    );

  const first = makeHalfWorld(
    'collective-world-first',
    [
      [0, 0, 0],
      [180, 0, 0],
    ],
    90,
    90,
  );
  const second = makeHalfWorld(
    'collective-world-second',
    [
      [180, 0, 0],
      [360, 0, 0],
    ],
    270,
    270,
  );
  assert(
    validateSnapshotEnvelope(first).status === 'ok' && validateSnapshotEnvelope(second).status === 'ok',
    'both half-world children must be independently valid bounded snapshots',
  );

  const union = expectOk(
    mergeSnapshotEnvelopes({
      id: 'collective-complete-world',
      envelopes: [first, second],
      anchorWeights: [1, 1],
      metrics: makeUnionMetrics(),
    }),
    'collective complete-world support should merge',
  );
  assert(
    union.frame.wrap.wrapMode === 'full-world' &&
      union.frame.wrap.wrapReference === 0 &&
      union.frame.wrap.worldOffset === 0,
    'collective complete-world support must promote to the canonical full-world frame',
  );
  assert(
    union.frame.primitives.map((primitive) => primitiveLongitudes(primitive).join(',')).join('|') === '0,180|-180,0',
    'promotion must preserve child order, path order, and complete-world topology',
  );
  assert(union.frame.anchor[0] === 0, 'promotion must recompute bounded child anchor copies around longitude zero');
  assert(validateSnapshotEnvelope(union).status === 'ok', 'a successful collective full-world union must validate');

  const secondOnlyAnchor = expectOk(
    mergeSnapshotEnvelopes({
      id: 'collective-complete-world-second-anchor',
      envelopes: [first, second],
      anchorWeights: [0, 1],
      metrics: makeUnionMetrics(),
    }),
    'collective complete-world support should preserve a weighted child anchor copy',
  );
  const secondSupportLongitudes = primitiveLongitudes(secondOnlyAnchor.frame.primitives[1]);
  assert(
    secondOnlyAnchor.frame.anchor[0] >= Math.min(...secondSupportLongitudes) &&
      secondOnlyAnchor.frame.anchor[0] <= Math.max(...secondSupportLongitudes),
    'a bounded child anchor and its support must receive the same integral world translation',
  );
}

function testCollectivePromotionPreservesSharedFrameChildCopies(): void {
  const makeBoundedPath = (
    id: string,
    longitudes: number[],
    anchorLongitude: number,
    wrapReference: number,
  ): SnapshotEnvelope =>
    expectOk(
      createSnapshotEnvelope({
        id,
        supportGuarantee: 'renderer-exact',
        provenance: makeProvenance(),
        primitives: [
          {
            kind: 'path-corridor',
            positions: longitudes.map((longitude) => [longitude, 0, 0]),
            halfWidth: { value: 1, unit: 'pixels' },
          },
        ],
        anchor: [anchorLongitude, 0, 0],
        metrics: makeUnionMetrics(),
        wrap: { wrapReference, worldOffset: 0, wrapMode: 'minimum-arc' },
      }),
      `${id} bounded path should construct`,
    );

  const first = makeBoundedPath('promotion-copy-first', [-159, -234, -380], -159, -127);
  const second = makeBoundedPath('promotion-copy-second', [90, 124, 196, 354, 250], 90, 122);
  const union = expectOk(
    mergeSnapshotEnvelopes({
      id: 'promotion-copy-union',
      envelopes: [first, second],
      anchorWeights: [1, 1],
      metrics: makeUnionMetrics(),
    }),
    'collectively complete bounded paths should promote without losing their shared-frame copies',
  );

  assert(
    union.frame.wrap.wrapMode === 'full-world' &&
      union.frame.wrap.wrapReference === 0 &&
      union.frame.wrap.worldOffset === 0,
    'collective promotion must use the canonical full-world frame',
  );
  assert(
    union.frame.primitives.map((primitive) => primitiveLongitudes(primitive).join(',')).join('|') ===
      '201,126,-20|90,124,196,354,250',
    'promotion must retain the relative child copies selected in the initial shared bounded frame',
  );
  assertClose(union.frame.anchor[0], 145.5, 1e-12, 'each child anchor must receive its support translation');
  assert(validateSnapshotEnvelope(union).status === 'ok', 'promoted shared-copy union must validate');
}

function testDeclaredFullWorldRequiresOneCoherentGeometryCopy(): void {
  const incoherent = createSnapshotEnvelope({
    id: 'incoherent-full-world-copy',
    supportGuarantee: 'renderer-exact',
    provenance: makeProvenance(),
    primitives: [
      {
        kind: 'path-corridor',
        positions: [
          [0, 0, 0],
          [360, 0, 0],
        ],
        halfWidth: { value: 1, unit: 'pixels' },
      },
    ],
    anchor: [0, 0, 0],
    metrics: makeUnionMetrics(),
    wrap: { wrapReference: 1_000_000, worldOffset: 0, wrapMode: 'full-world' },
  });
  assert(incoherent.status === 'error', 'declared full-world reference must describe the geometry world copy');

  const coherent = expectOk(
    createSnapshotEnvelope({
      id: 'coherent-full-world-copy',
      supportGuarantee: 'renderer-exact',
      provenance: makeProvenance(),
      primitives: [
        {
          kind: 'path-corridor',
          positions: [
            [-180, 0, 0],
            [180, 0, 0],
          ],
          halfWidth: { value: 1, unit: 'pixels' },
        },
      ],
      anchor: [0, 0, 0],
      metrics: makeUnionMetrics(),
      wrap: { wrapReference: 0, worldOffset: 0, wrapMode: 'full-world' },
    }),
    'coherent declared full-world source should construct',
  );
  const union = expectOk(
    mergeSnapshotEnvelopes({
      id: 'coherent-full-world-single-child-union',
      envelopes: [coherent],
      anchorWeights: [1],
      metrics: makeUnionMetrics(),
    }),
    'one coherent full-world child should canonicalize',
  );
  assert(
    union.frame.wrap.wrapMode === 'full-world' &&
      union.frame.wrap.wrapReference === 0 &&
      primitiveLongitudes(union.frame.primitives[0]).join(',') === '-180,180' &&
      union.frame.anchor[0] === 0,
    'one-child full-world union must keep geometry, anchor, and effective reference in one canonical copy',
  );
  assert(validateSnapshotEnvelope(union).status === 'ok', 'canonical one-child full-world union must validate');

  const edgeReference = expectOk(
    createSnapshotEnvelope({
      id: 'coherent-full-world-edge-reference',
      supportGuarantee: 'renderer-exact',
      provenance: makeProvenance(),
      primitives: [
        {
          kind: 'path-corridor',
          positions: [
            [100, 0, 0],
            [460, 0, 0],
          ],
          halfWidth: { value: 1, unit: 'pixels' },
        },
      ],
      anchor: [200, 0, 0],
      metrics: makeUnionMetrics(),
      wrap: { wrapReference: 100, worldOffset: 0, wrapMode: 'full-world' },
    }),
    'a full-world reference on the source interval edge should remain coherent',
  );
  const edgeUnion = expectOk(
    mergeSnapshotEnvelopes({
      id: 'coherent-full-world-edge-reference-union',
      envelopes: [edgeReference],
      anchorWeights: [1],
      metrics: makeUnionMetrics(),
    }),
    'edge-reference full-world child should merge',
  );
  assert(
    validateSnapshotEnvelope(edgeUnion).status === 'ok',
    'nearest-copy full-world union must validate when canonical zero is within half a world of its support interval',
  );
}

function testEnvelopeSchemasRejectUnknownOwnKeysAndOversizedTuples(): void {
  const base = makeEnvelopeInput('closed-schema', {
    kind: 'point-disc',
    position: [0, 0, 0],
    radius: { value: 1, unit: 'pixels' },
  });
  base.anchor = [0, 0, 0];
  const valid = expectOk(createSnapshotEnvelope(base), 'closed-schema fixture should construct');
  const rejectedCreateCases: Array<[string, SnapshotEnvelopeInput]> = [
    ['input', { ...base, futureInput: true } as SnapshotEnvelopeInput],
    ['provenance', { ...base, provenance: { ...base.provenance, futureProvenance: true } as TargetProvenance }],
    ['metrics', { ...base, metrics: { ...base.metrics, futureMetric: true } as ContentMetrics }],
    [
      'wrap',
      {
        ...base,
        wrap: { wrapReference: 0, worldOffset: 0, wrapMode: 'minimum-arc', futureWrap: true } as WrapMetadata,
      },
    ],
    [
      'point-disc',
      {
        ...base,
        primitives: [
          {
            kind: 'point-disc',
            position: [0, 0],
            radius: { value: 1, unit: 'pixels' },
            futurePointSupportPx: 10,
          } as unknown as VisualPrimitive,
        ],
      },
    ],
    [
      'screen-rect',
      {
        ...base,
        primitives: [
          {
            kind: 'screen-rect',
            position: [0, 0],
            widthPx: 1,
            heightPx: 1,
            futureRectSupportPx: 10,
          } as unknown as VisualPrimitive,
        ],
      },
    ],
    [
      'extruded-footprint',
      {
        ...base,
        primitives: [
          {
            kind: 'extruded-footprint',
            rings: [
              [
                [0, 0],
                [1, 0],
                [0, 1],
                [0, 0],
              ],
            ],
            baseMeters: 0,
            topMeters: 1,
            futureExtrusionSupportPx: 10,
          } as unknown as VisualPrimitive,
        ],
      },
    ],
    [
      'path-corridor',
      {
        ...base,
        primitives: [
          {
            kind: 'path-corridor',
            positions: [
              [0, 0],
              [1, 0],
            ],
            halfWidth: { value: 1, unit: 'pixels' },
            futurePathSupportPx: 10,
          } as unknown as VisualPrimitive,
        ],
      },
    ],
    [
      'polygon',
      {
        ...base,
        primitives: [
          {
            kind: 'polygon',
            rings: [
              [
                [0, 0],
                [1, 0],
                [0, 1],
                [0, 0],
              ],
            ],
            futurePolygonSupportPx: 10,
          } as unknown as VisualPrimitive,
        ],
      },
    ],
    [
      'mesh-support',
      {
        ...base,
        primitives: [
          {
            kind: 'mesh-support',
            vertices: [
              [0, 0],
              [1, 0],
              [0, 1],
            ],
            conservative: true,
            futureMeshSupportPx: 10,
          } as unknown as VisualPrimitive,
        ],
      },
    ],
    [
      'nested radius',
      {
        ...base,
        primitives: [
          {
            kind: 'point-disc',
            position: [0, 0],
            radius: { value: 1, unit: 'pixels', futureRadiusScale: 10 },
          } as unknown as VisualPrimitive,
        ],
      },
    ],
    [
      'nested pixel clamp',
      {
        ...base,
        primitives: [
          {
            kind: 'point-disc',
            position: [0, 0],
            radius: { value: 1, unit: 'pixels' },
            pixelClamp: { minPx: 1, futureClampPx: 10 },
          } as unknown as VisualPrimitive,
        ],
      },
    ],
    [
      'four-component world position',
      {
        ...base,
        primitives: [
          {
            kind: 'point-disc',
            position: [0, 0, 0, 10],
            radius: { value: 1, unit: 'pixels' },
          } as unknown as VisualPrimitive,
        ],
      },
    ],
    [
      'three-component lng-lat',
      {
        ...base,
        primitives: [
          {
            kind: 'extruded-footprint',
            rings: [
              [
                [0, 0, 10],
                [1, 0],
                [0, 1],
                [0, 0],
              ],
            ],
            baseMeters: 0,
            topMeters: 1,
          } as unknown as VisualPrimitive,
        ],
      },
    ],
  ];
  const acceptedCreateCases: string[] = [];
  for (const [label, input] of rejectedCreateCases) {
    if (createSnapshotEnvelope(input).status !== 'error') {
      acceptedCreateCases.push(label);
    }
  }

  const unknownEnvelope = { ...valid, futureEnvelope: true } as SnapshotEnvelope;
  const unknownFrame = { ...valid, frame: { ...valid.frame, futureFrame: true } } as SnapshotEnvelope;
  const acceptedValidationCases: string[] = [];
  if (validateSnapshotEnvelope(unknownEnvelope).status !== 'error') acceptedValidationCases.push('envelope');
  if (validateSnapshotEnvelope(unknownFrame).status !== 'error') acceptedValidationCases.push('frame');
  if (
    mergeSnapshotEnvelopes({
      id: 'unknown-union-input',
      envelopes: [valid],
      anchorWeights: [1],
      metrics: makeUnionMetrics(),
      futureUnionInput: true,
    } as Parameters<typeof mergeSnapshotEnvelopes>[0]).status !== 'error'
  ) {
    acceptedValidationCases.push('union input');
  }

  assert(
    acceptedCreateCases.length === 0 && acceptedValidationCases.length === 0,
    `closed schemas accepted unknown fields: ${acceptedCreateCases.concat(acceptedValidationCases).join(', ')}`,
  );
}

function testBoundedPathAndPolygonHandleTwoHundredThousandVerticesIteratively(): void {
  const verticesPerPrimitive = 100_000;
  const pathPositions: Array<[number, number, number]> = new Array(verticesPerPrimitive);
  const polygonRing: Array<[number, number, number]> = new Array(verticesPerPrimitive);
  for (let index = 0; index < verticesPerPrimitive; index += 1) {
    const progress = index / (verticesPerPrimitive - 1);
    pathPositions[index] = [-40 + progress * 80, -1 + progress * 2, 0];
    const angle = progress * Math.PI * 2;
    polygonRing[index] = [10 + Math.cos(angle), Math.sin(angle), 0];
  }
  polygonRing[verticesPerPrimitive - 1] = [...polygonRing[0]];

  const envelope = expectOk(
    createSnapshotEnvelope({
      id: 'bounded-200k-path-polygon',
      supportGuarantee: 'renderer-exact',
      provenance: makeProvenance(),
      primitives: [
        { kind: 'path-corridor', positions: pathPositions, halfWidth: { value: 1, unit: 'pixels' } },
        { kind: 'polygon', rings: [polygonRing] },
      ],
      anchor: [0, 0, 0],
      metrics: makeUnionMetrics(),
    }),
    'bounded 200k path/polygon snapshot should construct without recursion failure',
  );
  assert(envelope.frame.wrap.wrapMode === 'minimum-arc', '200k bounded support must stay bounded');
  assert(
    envelope.frame.primitives[0].kind === 'path-corridor' &&
      envelope.frame.primitives[0].positions.length === verticesPerPrimitive &&
      envelope.frame.primitives[1].kind === 'polygon' &&
      envelope.frame.primitives[1].rings[0].length === verticesPerPrimitive,
    '200k stress must preserve every path and polygon vertex',
  );
  assert(validateSnapshotEnvelope(envelope).status === 'ok', '200k bounded path/polygon snapshot must validate');
}

function testMergeOwnsMetricsWeightsAndInputArrays(): void {
  const left = makePointEnvelope('merge-owned-left', 0, 0);
  const right = makePointEnvelope('merge-owned-right', 2, 2);
  const envelopes = [left, right];
  const weights = [1, 1];
  const fallbackReasons = ['union-calibration'];
  const metrics = makeUnionMetrics({ density: 0.25, fallbackReasons });
  const union = expectOk(
    mergeSnapshotEnvelopes({ id: 'merge-owned', envelopes, anchorWeights: weights, metrics }),
    'owned merge should construct',
  );
  weights[0] = 1000;
  weights.push(1);
  envelopes.reverse();
  fallbackReasons[0] = 'mutated';
  metrics.density = 1;

  assert(union.frame.anchor[0] === 1, 'mutating source weights must not change the committed anchor');
  assert(
    union.frame.primitives[0].kind === 'point-disc' &&
      union.frame.primitives[0].position[0] === 0 &&
      union.frame.primitives[1].kind === 'point-disc' &&
      union.frame.primitives[1].position[0] === 2,
    'mutating the source envelope order must not change union primitive order',
  );
  assert(
    union.frame.metrics.density === 0.25 && union.frame.metrics.fallbackReasons[0] === 'union-calibration',
    'union must own caller-supplied recomputed metrics',
  );
  assert(Object.isFrozen(union.frame.metrics.fallbackReasons), 'union metric reasons must be frozen');
  assert(validateSnapshotEnvelope(union).status === 'ok', 'owned union must retain a valid committed revision');
}

testPlannedSnapshotAndDatelineUnionContract();
testSnapshotOwnsAndFreezesEveryNestedInput();
testRevisionCommitsCompleteSemanticContentButNotIdentityLabel();
testConstructionAndValidationFailClosed();
testFullWorldDetectionRequiresAnActualCompleteConnectedSpan();
testCreatePromotesSequentialWindingPathAndReturnsAValidSnapshot();
testCreatePreservesAndPromotesCanonicalWindingRing();
testRendererExactRejectsSupportThatIsOnlyConservative();
testRendererExactRejectsEveryPositiveSupportInflation();
testUnionRequiresExactWeightsAndUsesOverflowSafeCompensatedCentroid();
testUnionProvenanceIsOrderedDomainSeparatedAndRequiresOneScene();
testGuaranteeOrderingAndWeightRescalingSemantics();
testCanonicalRelativeWeightsAbsorbRepresentativeScaleRoundingJitter();
testCanonicalBoundaryCanDistinguishIndependentlyRoundedRescales();
testRepresentableSubnormalRatiosHaveNoApplicationZeroThreshold();
testBoundedUnionReframesAllSixBranchesWithoutTopologyLoss();
testFullWorldUnionPreservesGeometryAndUsesOneIntegralTranslation();
testFullWorldAnchorUsesTheSameSourceAndUnionWorldCopiesAsItsSupport();
testBoundedChildrenPromoteACollectiveCompleteWorldUnion();
const task4QualityRegressions: Array<[string, () => void]> = [
  ['full-world geometry-derived copy', testFullWorldUnionDerivesCanonicalCopyFromGeometryInterval],
  ['full-world shared interval', testFullWorldUnionReframesBoundedChildrenIntoOneSharedInterval],
  ['collective shared copies', testCollectivePromotionPreservesSharedFrameChildCopies],
  ['declared full-world copy', testDeclaredFullWorldRequiresOneCoherentGeometryCopy],
  ['closed schemas', testEnvelopeSchemasRejectUnknownOwnKeysAndOversizedTuples],
  ['bounded 200k stress', testBoundedPathAndPolygonHandleTwoHundredThousandVerticesIteratively],
];
const task4QualityFailures: string[] = [];
for (const [label, regression] of task4QualityRegressions) {
  try {
    regression();
  } catch (error) {
    task4QualityFailures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
assert(task4QualityFailures.length === 0, task4QualityFailures.join('\n'));
testMergeOwnsMetricsWeightsAndInputArrays();
