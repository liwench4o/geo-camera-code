import type { CameraMovement, CameraView, StoryJsonV2 } from '../interfaces';
import type {
  CertifiedFrameCertificate,
  CommittedTrajectoryPlan,
  SerializedCameraTrajectory,
} from '../camera/trajectory/types';
import { computeTrajectoryDigest } from '../camera/trajectory/validation';
import { digestCanonical } from '../camera/geometry/canonical-digest';
import { createStoryJson, parseStoryJson } from './serialization';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function semanticView(zoom: number): CameraView {
  return {
    longitude: 12,
    latitude: 34,
    zoom,
    pitch: 20,
    bearing: 15,
  };
}

function camera(name: string, initialZoom = 8, finalZoom = initialZoom): CameraMovement {
  return {
    id: `${name}-id`,
    name,
    title: name,
    category: 'test',
    initViewState: {
      ...semanticView(initialZoom),
      transitionEasing: (time: number) => time,
    },
    finalViewState: {
      ...semanticView(finalZoom),
      onTransitionEnd: () => undefined,
    },
    duration: 1000,
    stay: 125,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
    targetSnapshot: { id: 'target', callback: () => 'runtime-only' },
  };
}

function certifiedCamera(): CameraMovement {
  const movement = camera('certified');
  const frameCertificate: CertifiedFrameCertificate = {
    kind: 'strict-frame-v1',
    inputDigest: 'strict-input-v1',
    envelopeDigest: 'envelope-v1',
    viewportDigest: digestCanonical({ schema: 'strict-frame-viewport-v1', viewport: enabledOptions.viewport }),
    constraintDigest: 'constraint-v1',
    solverVersion: 'strict-solver-v2',
    viewDigest: digestCanonical({ schema: 'strict-frame-view-v1', view: semanticView(8) }),
    slackPx: 12,
  };
  const trajectory: SerializedCameraTrajectory = {
    kind: 'hold',
    sampler: 'hold-v1',
    samplerVersion: '1',
    durationMs: movement.duration,
    keyframes: [
      { timeMs: 0, view: semanticView(8), frameCertificate: { ...frameCertificate } },
      { timeMs: movement.duration, view: semanticView(8), frameCertificate: { ...frameCertificate } },
    ],
  };
  const trajectoryDigest = computeTrajectoryDigest(trajectory);
  const plan: CommittedTrajectoryPlan = {
    inputDigest: frameCertificate.inputDigest,
    trajectory,
    trajectoryDigest,
    certification: {
      status: 'certified',
      certificate: {
        kind: 'visibility-v1',
        trajectoryDigest,
        envelopeDigest: frameCertificate.envelopeDigest,
        viewportDigest: frameCertificate.viewportDigest,
        constraintDigest: frameCertificate.constraintDigest,
        validity: { domain: 'story-local', startMs: 0, endMs: movement.duration },
        intervals: [
          { startMs: 0, endMs: 500, slackLowerBoundPx: 12, boundMethod: 'constant-frame' },
          { startMs: 500, endMs: 1000, slackLowerBoundPx: 12, boundMethod: 'constant-frame' },
        ],
      },
    },
  };
  movement.trajectoryPlan = plan;
  return movement;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const enabledOptions = {
  trajectoryEnabled: true,
  viewport: { width: 1440, height: 900 },
} as const;

function expectInvalid(value: unknown, message: string) {
  const result = parseStoryJson(value, { viewport: enabledOptions.viewport });
  assert(!result.ok && result.reason === 'invalid-json', message);
}

function testEnabledV2RoundTripIsCanonicalAndDataOnly() {
  const source = certifiedCamera();
  const easing = source.initViewState.transitionEasing;
  const originalPlan = source.trajectoryPlan;
  const story = createStoryJson([source], enabledOptions);
  assert(story.version === 2, 'enabled writer emits Story v2');
  const exportedTarget = story.cameras[0].movement.targetSnapshot;
  assert(exportedTarget && typeof exportedTarget === 'object', 'writer retains the target snapshot');
  assert(!('callback' in exportedTarget), 'writer removes nested runtime functions before JSON serialization');
  assert(
    Object.keys(story.cameras[0].movement.initViewState).join(',') === 'longitude,latitude,zoom,pitch,bearing',
    'writer emits semantic view channels in canonical order',
  );
  assert(source.initViewState.transitionEasing === easing, 'writer does not mutate source views');
  assert(source.trajectoryPlan === originalPlan, 'writer does not replace the source committed plan');

  const wire = JSON.stringify(story);
  const parsed = parseStoryJson(story, { viewport: enabledOptions.viewport });
  assert(parsed.ok, 'valid Story v2 imports');
  assert(
    parsed.cameras[0].trajectoryPlan?.trajectoryDigest === story.cameras[0].trajectoryDigest,
    'round trip retains the trajectory digest',
  );
  assert(Object.isFrozen(parsed.cameras[0].trajectoryPlan), 'imported committed tuple is immutable');
  assert(
    JSON.stringify(createStoryJson(parsed.cameras, enabledOptions)) === wire,
    'v2 import/re-export is byte-stable',
  );
}

function testPlaybackExportPreservesCertifiedTrajectory() {
  const source = certifiedCamera();
  source.targetSnapshot = { id: 'target', selectedRows: [{ raw: 'event' }], snapshotEnvelope: { raw: 'support' } };
  const full = createStoryJson([source], enabledOptions);
  const compact = createStoryJson([source], { ...enabledOptions, content: 'playback' });
  assert(full.version === 2 && compact.version === 2, 'certified export uses V2');
  assert(
    JSON.stringify(compact.cameras[0].movement.targetSnapshot) === '{"id":"target"}',
    'static target payload is removed',
  );
  assert(
    JSON.stringify({ ...full.cameras[0], movement: undefined }) ===
      JSON.stringify({ ...compact.cameras[0], movement: undefined }),
    'trajectory, digests and certification are unchanged',
  );
  const imported = parseStoryJson(compact);
  assert(
    imported.ok && imported.cameras[0].trajectoryPlan?.certification.status === 'certified',
    'certification remains valid without raw snapshot data',
  );
}

testPlaybackExportPreservesCertifiedTrajectory();

function testLegacyCompilationAndV1MigrationRemainExplicit() {
  const moving = camera('legacy-moving', 8, 11);
  moving.interpolationType = 'linear';
  const v2 = createStoryJson([moving], enabledOptions);
  assert(v2.version === 2, 'enabled legacy export emits v2');
  assert(
    v2.cameras[0].trajectory.kind === 'legacy-fly',
    'source movement stays fly; interpolationType only selects a generated discontinuity gap',
  );
  assert(
    v2.cameras[0].trajectory.kind === 'legacy-fly' &&
      v2.cameras[0].trajectory.viewport.width === 1440 &&
      v2.cameras[0].certification.status === 'legacy-unverified',
    'legacy v2 export seals viewport and unverified status',
  );

  const v1 = createStoryJson([moving], { trajectoryEnabled: false });
  assert(v1.version === 1, 'disabled writer remains Story v1');
  assert(!('trajectoryPlan' in v1.cameras[0]), 'v1 writer does not leak a v2 committed plan');
  const importedV1 = parseStoryJson(jsonClone(v1), { viewport: enabledOptions.viewport });
  assert(importedV1.ok && !importedV1.legacy, 'Story v1 remains readable');
  assert(importedV1.cameras[0].trajectoryPlan === undefined, 'v1 stays unresolved until playback/export viewport');

  const importedArray = parseStoryJson(jsonClone(v1.cameras), { viewport: enabledOptions.viewport });
  assert(importedArray.ok && importedArray.legacy, 'legacy camera arrays remain readable');
  assert(createStoryJson([moving]).version === 2, 'default writer saves applied trajectories');
}

function testStaleCertifiedViewportExportsHonestCompatibilityData() {
  const source = certifiedCamera();
  const certifiedDigest = source.trajectoryPlan?.trajectoryDigest;
  const resized = createStoryJson([source], {
    trajectoryEnabled: true,
    viewport: { width: 800, height: 600 },
  });
  assert(resized.version === 2, 'resized export remains Story v2');
  assert(
    resized.cameras[0].certification.status === 'certified' && resized.cameras[0].trajectoryDigest === certifiedDigest,
    'viewport changes do not replace the authored path or its original certificate context',
  );
  assert(source.trajectoryPlan?.certification.status === 'certified', 'export does not mutate prior certified tuple');
}

function testV2TrajectoryAndDurationTamperingFailsClosed() {
  const certified = createStoryJson([certifiedCamera()], enabledOptions);
  assert(certified.version === 2, 'fixture is v2');

  const cases: Array<[string, (story: StoryJsonV2) => void]> = [
    ['unknown story version', (story) => ((story as { version: number }).version = 3)],
    ['unknown sampler', (story) => ((story.cameras[0].trajectory as { sampler: string }).sampler = 'unknown-v1')],
    ['unknown sampler version', (story) => (story.cameras[0].trajectory.samplerVersion = '2' as '1')],
    ['movement duration mismatch', (story) => (story.cameras[0].movement.duration = 999)],
    [
      'movement endpoint mismatch',
      (story) => (story.cameras[0].movement.finalViewState.zoom = story.cameras[0].movement.finalViewState.zoom + 1),
    ],
    ['trajectory digest tamper', (story) => (story.cameras[0].trajectoryDigest = 'tampered')],
    [
      'non-increasing keyframes',
      (story) => {
        story.cameras[0].trajectory = {
          kind: 'keyframed',
          sampler: 'linear-v1',
          samplerVersion: '1',
          durationMs: 1000,
          keyframes: [
            { timeMs: 0, view: semanticView(8) },
            { timeMs: 0, view: semanticView(8) },
            { timeMs: 1000, view: semanticView(8) },
          ],
        };
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    const tampered = jsonClone(certified);
    mutate(tampered);
    expectInvalid(tampered, `${label} must fail closed`);
  }

  const legacy = createStoryJson([camera('fly-corruption', 8, 9)], enabledOptions);
  assert(legacy.version === 2 && legacy.cameras[0].trajectory.kind === 'legacy-fly', 'fixture uses fly');
  const badViewport = jsonClone(legacy);
  assert(badViewport.cameras[0].trajectory.kind === 'legacy-fly', 'cloned fixture uses fly');
  badViewport.cameras[0].trajectory.viewport.width = 0;
  expectInvalid(badViewport, 'corrupted fly viewport must fail closed');
}

function testCertificateDigestContextAndCoverageTamperingFailsClosed() {
  const original = createStoryJson([certifiedCamera()], enabledOptions);
  assert(original.version === 2 && original.cameras[0].certification.status === 'certified', 'certified fixture');

  const mutateCertificate = (
    mutate: (
      certificate: Extract<StoryJsonV2['cameras'][number]['certification'], { status: 'certified' }>['certificate'],
    ) => void,
  ) => {
    const story = jsonClone(original);
    assert(story.cameras[0].certification.status === 'certified', 'cloned fixture remains certified');
    mutate(story.cameras[0].certification.certificate);
    return story;
  };

  expectInvalid(
    mutateCertificate((certificate) => (certificate.trajectoryDigest = 'tampered')),
    'certificate trajectory digest tamper must fail',
  );
  expectInvalid(
    mutateCertificate((certificate) => (certificate.envelopeDigest = 'other-envelope')),
    'certificate/frame context mismatch must fail',
  );
  expectInvalid(
    mutateCertificate((certificate) => (certificate.intervals[1].startMs = 600)),
    'certificate interval gap must fail',
  );
  expectInvalid(
    mutateCertificate((certificate) => (certificate.intervals[1].startMs = 400)),
    'certificate interval overlap must fail',
  );

  const forgedViewDigest = jsonClone(original);
  const forgedTrajectory = forgedViewDigest.cameras[0].trajectory;
  assert(forgedTrajectory.kind === 'hold', 'forged fixture remains a hold');
  forgedTrajectory.keyframes[0].frameCertificate!.viewDigest = 'forged-view';
  forgedTrajectory.keyframes[1].frameCertificate!.viewDigest = 'forged-view';
  forgedViewDigest.cameras[0].trajectoryDigest = computeTrajectoryDigest(forgedTrajectory);
  assert(forgedViewDigest.cameras[0].certification.status === 'certified', 'forged fixture remains certified');
  forgedViewDigest.cameras[0].certification.certificate.trajectoryDigest = forgedViewDigest.cameras[0].trajectoryDigest;
  expectInvalid(
    forgedViewDigest,
    'coherently rehashed frame certificate with a false view digest must fail authority validation',
  );

  const unauthorizedMoving = jsonClone(original);
  unauthorizedMoving.cameras[0].trajectory = {
    kind: 'keyframed',
    sampler: 'minimum-jerk-v1',
    samplerVersion: '1',
    durationMs: 1000,
    keyframes: [
      { timeMs: 0, view: semanticView(8) },
      { timeMs: 1000, view: semanticView(8) },
    ],
  };
  unauthorizedMoving.cameras[0].trajectoryDigest = computeTrajectoryDigest(unauthorizedMoving.cameras[0].trajectory);
  assert(unauthorizedMoving.cameras[0].certification.status === 'certified', 'moving fixture remains certified');
  unauthorizedMoving.cameras[0].certification.certificate.trajectoryDigest =
    unauthorizedMoving.cameras[0].trajectoryDigest;
  unauthorizedMoving.cameras[0].certification.certificate.intervals = [
    {
      startMs: 0,
      endMs: 1000,
      slackLowerBoundPx: 12,
      boundMethod: 'interval-arithmetic',
    },
  ];
  expectInvalid(unauthorizedMoving, 'future moving certificate methods remain unauthorized in this slice');
}

function testImporterRejectsNonJsonObjectsWithoutExecutingThem() {
  const story = createStoryJson([certifiedCamera()], enabledOptions);
  assert(story.version === 2, 'fixture is v2');

  const functionImpostor = jsonClone(story) as StoryJsonV2 & { toJSON?: () => unknown };
  functionImpostor.toJSON = () => story;
  expectInvalid(functionImpostor, 'function-like JSON impostor must fail');

  const customPrototype = Object.assign(Object.create({ inherited: true }) as StoryJsonV2, jsonClone(story));
  expectInvalid(customPrototype, 'custom-prototype story must fail');

  let invoked = false;
  const accessor = jsonClone(story) as unknown as Record<string, unknown>;
  Object.defineProperty(accessor, 'version', {
    enumerable: true,
    get() {
      invoked = true;
      return 2;
    },
  });
  expectInvalid(accessor, 'accessor-backed story must fail');
  assert(!invoked, 'import validation must not execute accessors');

  const source = jsonClone(story);
  const before = JSON.stringify(source);
  const parsed = parseStoryJson(source, { viewport: enabledOptions.viewport });
  assert(parsed.ok && JSON.stringify(source) === before, 'import does not mutate the source value');
}

type MutableMovement = Record<string, unknown>;

function rejectedMovementFormats(mutate: (movement: MutableMovement) => void): string[] {
  const v2 = createStoryJson([camera('validation')], enabledOptions);
  const v1 = createStoryJson([camera('validation')], { trajectoryEnabled: false });
  assert(v2.version === 2 && v1.version === 1, 'validation fixtures use both supported versions');
  const variants = [
    { name: 'V2', value: jsonClone(v2), movement: jsonClone(v2.cameras[0].movement) },
    { name: 'V1', value: jsonClone(v1), movement: jsonClone(v1.cameras[0]) },
    { name: 'legacy', value: jsonClone(v1.cameras), movement: jsonClone(v1.cameras[0]) },
  ];
  return variants.flatMap(({ name, value, movement }) => {
    mutate(movement as unknown as MutableMovement);
    if (Array.isArray(value)) value[0] = movement;
    else if (value.version === 1) value.cameras[0] = movement;
    else value.cameras[0].movement = movement;
    const result = parseStoryJson(value);
    return !result.ok && result.reason === 'invalid-json' ? [] : [name];
  });
}

function assertInvalidMovements(cases: Array<[string, (movement: MutableMovement) => void]>) {
  const accepted = cases.flatMap(([label, mutate]) =>
    rejectedMovementFormats(mutate).map((format) => `${format}: ${label}`),
  );
  assert(accepted.length === 0, `Malformed camera data was accepted:\n${accepted.join('\n')}`);
}

function testAnnotationImportValidatesContentAndTiming() {
  const cases: Array<[string, (movement: MutableMovement) => void]> = [
    ['annotation object text', (movement) => (movement.annotation = { text: {}, delay: 0, duration: 100 })],
    ['annotation numeric text', (movement) => (movement.annotation = { text: 7, delay: 0, duration: 100 })],
    ['annotation missing text', (movement) => (movement.annotation = { delay: 0, duration: 100 })],
    ['annotation missing delay', (movement) => (movement.annotation = { text: 'Caption', duration: 100 })],
    ['annotation missing duration', (movement) => (movement.annotation = { text: 'Caption', delay: 0 })],
    ['annotation array', (movement) => (movement.annotation = [])],
    ['annotation null', (movement) => (movement.annotation = null)],
  ];
  for (const field of ['delay', 'duration']) {
    for (const value of [-1, '100', null, Infinity, NaN]) {
      cases.push([
        `annotation ${field} ${String(value)}`,
        (movement) => (movement.annotation = { text: 'Caption', delay: 0, duration: 100, [field]: value }),
      ]);
    }
  }
  assertInvalidMovements(cases);
}

function testMovementImportValidatesTimingAndIds() {
  const cases: Array<[string, (movement: MutableMovement) => void]> = [];
  for (const field of ['duration', 'stay', 'startDelay', 'interpolationDuration']) {
    for (const value of [-1, '100', null, {}, Infinity, NaN]) {
      cases.push([`${field} (${typeof value}) ${JSON.stringify(value)}`, (movement) => (movement[field] = value)]);
    }
  }
  for (const field of ['id', 'targetId', 'recipeId']) {
    for (const value of [3, null, {}, '', '  ']) {
      cases.push([`${field} (${typeof value}) ${JSON.stringify(value)}`, (movement) => (movement[field] = value)]);
    }
  }
  assertInvalidMovements(cases);
}

function targetSnapshot(): MutableMovement {
  return { id: 'target', type: 'region', center: [12, 34], bbox: [11, 33, 13, 35], label: 'Target' };
}

function testRecognizedTargetImportRejectsMalformedGeometry() {
  const mutations: Array<[string, (target: MutableMovement) => void]> = [
    ['missing center', (target) => delete target.center],
    ['string center', (target) => (target.center = ['12', 34])],
    ['out-of-range center latitude', (target) => (target.center = [12, 91])],
    ['missing bbox', (target) => delete target.bbox],
    ['string bbox', (target) => (target.bbox = ['11', '33', '13', '35'])],
    ['short bbox', (target) => (target.bbox = [11, 33])],
    ['inverted latitude bbox', (target) => (target.bbox = [11, 35, 13, 33])],
    ['invalid bbox latitude', (target) => (target.bbox = [11, 33, 13, 91])],
    ['invalid target id', (target) => (target.id = 5)],
    ['invalid target label', (target) => (target.label = {})],
    ['invalid selection anchor', (target) => (target.selectionAnchor = [12])],
    [
      'invalid path coordinates',
      (target) =>
        (target.coordinates = [
          [12, 34],
          ['13', 35],
        ]),
    ],
    [
      'invalid polygon coordinates',
      (target) =>
        (target.coordinates = [
          [
            [12, 34],
            [13, '35'],
          ],
        ]),
    ],
    ['invalid path start', (target) => (target.start = [12, '34'])],
    ['invalid path end', (target) => (target.end = null)],
    ['invalid visual bbox', (target) => (target.visualFrame = { bbox: ['11', 33, 13, 35] })],
    ['invalid visual anchor', (target) => (target.visualFrame = { bbox: [11, 33, 13, 35], anchor: {} })],
    [
      'invalid visual samples',
      (target) => (target.visualFrame = { bbox: [11, 33, 13, 35], sampleCoordinates: [[12, 34, 'high']] }),
    ],
    ['invalid children container', (target) => (target.children = {})],
    ['invalid child target', (target) => (target.children = [{ ...targetSnapshot(), bbox: ['bad', 0, 0, 0] }])],
    ['null child target', (target) => (target.children = [null])],
  ];
  const cases = mutations.flatMap(
    ([label, mutate]): Array<[string, (movement: MutableMovement) => void]> =>
      ['targetSnapshot', 'comparisonTargetSnapshots'].map((field) => [
        `${field}: ${label}`,
        (movement) => {
          const target = targetSnapshot();
          mutate(target);
          movement[field] = field === 'targetSnapshot' ? target : [{ metadata: 'preserved' }, null, target];
        },
      ]),
  );
  cases.push(['comparison snapshot container', (movement) => (movement.comparisonTargetSnapshots = {})]);
  assertInvalidMovements(cases);
}

function testOptionalMetadataAndValidAnnotationRoundTripAcrossFormats() {
  const source = camera('metadata');
  source.annotation = { text: '  中文 👋\nSecond line\t  ', delay: 0, duration: 0 };
  Object.assign(source.annotation, { futureStyle: { color: 'blue' } });
  source.startDelay = 0;
  const target = {
    ...targetSnapshot(),
    type: 'point',
    center: [190, 89],
    bbox: [170, 88, -170, 90],
    coordinates: [
      [
        [190, 89],
        [191, 90],
      ],
    ],
    selectedRows: [{ arbitrary: { data: 'retained' } }],
    visualFrame: { bbox: [190, 89, 190, 89], sampleCoordinates: [[190, 89, 100]] },
    futureGeometryMetadata: { note: 'retained' },
  };
  source.targetSnapshot = target;
  source.comparisonTargetSnapshots = [{ id: 'metadata-only', arbitrary: [1, 2] }, null, target];
  for (const trajectoryEnabled of [false, true]) {
    const story = createStoryJson([source], { ...enabledOptions, trajectoryEnabled });
    const variants = story.version === 1 ? [story, story.cameras] : [story];
    for (const value of variants) {
      const imported = parseStoryJson(jsonClone(value));
      assert(imported.ok, 'valid target geometry and optional metadata remain readable in every format');
      const saved = imported.cameras[0];
      assert(saved.annotation?.text === source.annotation.text, 'annotation text is preserved exactly');
      assert(saved.annotation.delay === 0 && saved.annotation.duration === 0, 'zero annotation timings are valid');
      assert(
        JSON.stringify(createStoryJson(imported.cameras, { ...enabledOptions, trajectoryEnabled })) ===
          JSON.stringify(story),
        'recognized geometry and optional metadata remain stable on re-export',
      );
    }
  }
  source.targetSnapshot = { id: 'opaque-metadata', custom: { value: 1 } };
  assert(parseStoryJson(jsonClone(createStoryJson([source]))).ok, 'opaque target metadata remains compatible');
}

testEnabledV2RoundTripIsCanonicalAndDataOnly();
testLegacyCompilationAndV1MigrationRemainExplicit();
testStaleCertifiedViewportExportsHonestCompatibilityData();
testV2TrajectoryAndDurationTamperingFailsClosed();
testCertificateDigestContextAndCoverageTamperingFailsClosed();
testImporterRejectsNonJsonObjectsWithoutExecutingThem();
testOptionalMetadataAndValidAnnotationRoundTripAcrossFormats();
const validationFailures: string[] = [];
for (const test of [
  testAnnotationImportValidatesContentAndTiming,
  testMovementImportValidatesTimingAndIds,
  testRecognizedTargetImportRejectsMalformedGeometry,
]) {
  try {
    test();
  } catch (error) {
    validationFailures.push(error instanceof Error ? error.message : String(error));
  }
}
assert(validationFailures.length === 0, validationFailures.join('\n'));
