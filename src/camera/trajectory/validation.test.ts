import { digestCanonical } from '../geometry/canonical-digest';
import {
  computeTrajectoryDigest,
  validateAuthorizedCertifiedTrajectoryPlan,
  validateCommittedTrajectoryPlan,
  validateCommittedTrajectoryPlanForMovement,
  validateSerializedTrajectory,
  validateTrajectoryCertification,
} from './validation';
import type { CameraMovement } from '../../interfaces';
import type { CommittedTrajectoryPlan, SerializedCameraTrajectory, TrajectoryCertification } from './types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertError(result: { status: string; reason?: string }, message: string) {
  assert(result.status === 'error', `${message}: expected an error, received ${result.status}`);
  assert(typeof result.reason === 'string' && result.reason.length > 0, `${message}: expected a structured reason`);
}

const view = {
  longitude: 1,
  latitude: 2,
  zoom: 3,
  pitch: 4,
  bearing: 5,
};

const hold: Extract<SerializedCameraTrajectory, { kind: 'hold' }> = {
  kind: 'hold',
  sampler: 'hold-v1',
  samplerVersion: '1',
  durationMs: 1000,
  keyframes: [
    { timeMs: 0, view: { ...view } },
    { timeMs: 1000, view: { ...view } },
  ],
};

function createLegacyPlan(trajectory: SerializedCameraTrajectory = hold): CommittedTrajectoryPlan {
  return {
    inputDigest: 'input-v1',
    trajectory,
    trajectoryDigest: computeTrajectoryDigest(trajectory),
    certification: {
      status: 'legacy-unverified',
      observations: {
        samples: [],
        minimumSlackPx: null,
        evaluationCount: 0,
        intervalBoundCount: 0,
      },
    },
  };
}

function createCertifiedCertification(
  trajectory: SerializedCameraTrajectory = hold,
): Extract<TrajectoryCertification, { status: 'certified' }> {
  const trajectoryDigest = computeTrajectoryDigest(trajectory);
  return {
    status: 'certified',
    certificate: {
      kind: 'visibility-v1',
      trajectoryDigest,
      envelopeDigest: 'envelope-v1',
      viewportDigest: 'viewport-v1',
      constraintDigest: 'constraint-v1',
      validity: { domain: 'story-local', startMs: 0, endMs: trajectory.durationMs },
      intervals: [
        {
          startMs: 0,
          endMs: trajectory.durationMs,
          slackLowerBoundPx: 8,
          boundMethod: 'constant-frame',
        },
      ],
    },
  };
}

function testCanonicalDigestAndValidContracts() {
  const firstDigest = computeTrajectoryDigest(hold);
  const reordered: SerializedCameraTrajectory = {
    keyframes: [
      { view: { bearing: 5, pitch: 4, zoom: 3, latitude: 2, longitude: 1 }, timeMs: 0 },
      { view: { bearing: 5, pitch: 4, zoom: 3, latitude: 2, longitude: 1 }, timeMs: 1000 },
    ],
    durationMs: 1000,
    samplerVersion: '1',
    sampler: 'hold-v1',
    kind: 'hold',
  };

  assert(firstDigest === computeTrajectoryDigest(reordered), 'trajectory digest must be canonical');
  assert(
    firstDigest === digestCanonical({ schema: 'camera-trajectory-v1', trajectory: hold }),
    'trajectory digest input must remain sealed',
  );
  assert(validateSerializedTrajectory(hold).status === 'ok', 'valid hold trajectory');

  const plan = createLegacyPlan();
  assert(validateCommittedTrajectoryPlan(plan).status === 'ok', 'matching committed plan');
  assertError(validateCommittedTrajectoryPlan({ ...plan, trajectoryDigest: 'tampered' }), 'digest tampering must fail');
}

function testSamplerShapeAndFiniteNumberValidation() {
  assertError(validateSerializedTrajectory({ ...hold, sampler: 'unknown-v1' }), 'unknown sampler must fail closed');
  assertError(
    validateSerializedTrajectory({ ...hold, samplerVersion: '2' }),
    'unknown sampler version must fail closed',
  );
  assertError(
    validateSerializedTrajectory({ ...hold, durationMs: Number.NaN }),
    'non-finite duration must fail closed',
  );
  assertError(
    validateSerializedTrajectory({
      ...hold,
      keyframes: [hold.keyframes[0], { ...hold.keyframes[1], timeMs: 999 }],
    }),
    'hold boundaries must match duration',
  );
  assertError(
    validateSerializedTrajectory({
      kind: 'keyframed',
      sampler: 'linear-v1',
      samplerVersion: '1',
      durationMs: 1000,
      keyframes: [
        { timeMs: 0, view },
        { timeMs: 0, view },
        { timeMs: 1000, view },
      ],
    }),
    'keyframe times must increase strictly',
  );
  assertError(
    validateSerializedTrajectory({
      kind: 'legacy-fly',
      sampler: 'deck-fly-v1',
      samplerVersion: '1',
      durationMs: 1000,
      viewport: { width: 0, height: 900 },
      initView: view,
      finalView: view,
    }),
    'legacy fly viewport must be finite and positive',
  );
}

function testZeroDurationHoldContract() {
  const validZero: Extract<SerializedCameraTrajectory, { kind: 'hold' }> = {
    ...hold,
    durationMs: 0,
    keyframes: [
      { timeMs: 0, view: { ...view } },
      { timeMs: 0, view: { ...view } },
    ],
  };
  assert(validateSerializedTrajectory(validZero).status === 'ok', 'equal zero-duration hold boundaries are valid');
  assertError(
    validateSerializedTrajectory({
      ...validZero,
      keyframes: [validZero.keyframes[0], { timeMs: 0, view: { ...view, zoom: 4 } }],
    }),
    'zero-duration hold views must be equal',
  );
}

function testPlainDataGuardNeverInvokesAccessors() {
  const customPrototype = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, hold);
  assertError(validateSerializedTrajectory(customPrototype), 'custom prototypes must fail closed');

  let accessorInvoked = false;
  const accessorTrajectory = { ...hold } as Record<string, unknown>;
  Object.defineProperty(accessorTrajectory, 'durationMs', {
    enumerable: true,
    get() {
      accessorInvoked = true;
      return 1000;
    },
  });
  assertError(validateSerializedTrajectory(accessorTrajectory), 'accessor properties must fail closed');
  assert(!accessorInvoked, 'validation must never invoke an accessor');

  const symbolTrajectory = { ...hold } as Record<PropertyKey, unknown>;
  symbolTrajectory[Symbol('hidden')] = true;
  assertError(validateSerializedTrajectory(symbolTrajectory), 'symbol keys must fail closed');

  const cyclicTrajectory = { ...hold, metadata: {} } as Record<string, unknown>;
  (cyclicTrajectory.metadata as Record<string, unknown>).owner = cyclicTrajectory;
  assertError(validateSerializedTrajectory(cyclicTrajectory), 'cyclic values must fail closed');
}

function testCertificateCoverageAndSlackValidation() {
  const digest = computeTrajectoryDigest(hold);
  const valid = createCertifiedCertification();
  assert(
    validateTrajectoryCertification(valid, hold, digest).status === 'ok',
    'complete nonnegative certificate is valid',
  );

  const firstInterval = valid.certificate.intervals[0];
  const withIntervals = (
    intervals: typeof valid.certificate.intervals,
  ): Extract<TrajectoryCertification, { status: 'certified' }> => ({
    ...valid,
    certificate: { ...valid.certificate, intervals },
  });

  assertError(
    validateTrajectoryCertification(
      withIntervals([
        { ...firstInterval, endMs: 400 },
        { ...firstInterval, startMs: 500 },
      ]),
      hold,
      digest,
    ),
    'certificate gaps must fail',
  );
  assertError(
    validateTrajectoryCertification(
      withIntervals([
        { ...firstInterval, endMs: 600 },
        { ...firstInterval, startMs: 500 },
      ]),
      hold,
      digest,
    ),
    'certificate overlaps must fail',
  );
  assertError(
    validateTrajectoryCertification(withIntervals([{ ...firstInterval, slackLowerBoundPx: -0.001 }]), hold, digest),
    'negative certified slack must fail',
  );
  assertError(
    validateTrajectoryCertification(
      {
        ...valid,
        certificate: { ...valid.certificate, trajectoryDigest: 'tampered' },
      },
      hold,
      digest,
    ),
    'certificate trajectory digest must match',
  );
}

function testValidationDoesNotMutateSources() {
  const plan = createLegacyPlan();
  const before = JSON.stringify(plan);
  const keyOrder = Object.keys(plan.trajectory).join(',');

  validateSerializedTrajectory(plan.trajectory);
  validateCommittedTrajectoryPlan(plan);

  assert(JSON.stringify(plan) === before, 'validation must not mutate values');
  assert(Object.keys(plan.trajectory).join(',') === keyOrder, 'validation must not reorder source keys');
}

function createAuthorizedPlan(): { movement: CameraMovement; plan: CommittedTrajectoryPlan } {
  const inputDigest = 'authorized-input-v1';
  const frameCertificate = {
    kind: 'strict-frame-v1' as const,
    inputDigest,
    envelopeDigest: 'authorized-envelope-v1',
    viewportDigest: 'authorized-viewport-v1',
    constraintDigest: 'authorized-constraint-v1',
    solverVersion: 'strict-v2',
    viewDigest: digestCanonical({ schema: 'strict-frame-view-v1', view }),
    slackPx: 8,
  };
  const trajectory: Extract<SerializedCameraTrajectory, { kind: 'hold' }> = {
    ...hold,
    keyframes: [
      { timeMs: 0, view: { ...view }, frameCertificate: { ...frameCertificate } },
      { timeMs: 1000, view: { ...view }, frameCertificate: { ...frameCertificate } },
    ],
  };
  const trajectoryDigest = computeTrajectoryDigest(trajectory);
  const plan: CommittedTrajectoryPlan = {
    inputDigest,
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
        validity: { domain: 'story-local', startMs: 0, endMs: 1000 },
        intervals: [{ startMs: 0, endMs: 1000, slackLowerBoundPx: 8, boundMethod: 'constant-frame' }],
      },
    },
  };
  const movement: CameraMovement = {
    name: 'authorized',
    title: 'Authorized',
    category: 'test',
    initViewState: { ...view },
    finalViewState: { ...view },
    duration: 1000,
    stay: 0,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
    trajectoryPlan: plan,
  };
  return { movement, plan };
}

function testMovementConsistencyAndCurrentCertifiedAuthority() {
  const { movement, plan } = createAuthorizedPlan();
  assert(validateCommittedTrajectoryPlanForMovement(plan, movement).status === 'ok', 'matching endpoints are valid');
  assert(
    validateAuthorizedCertifiedTrajectoryPlan(plan).status === 'ok',
    'constant-frame certified hold is authorized',
  );
  assertError(
    validateCommittedTrajectoryPlanForMovement(plan, {
      ...movement,
      finalViewState: { ...movement.finalViewState, zoom: movement.finalViewState.zoom + 1 },
    }),
    'movement endpoints cannot disagree with the committed trajectory',
  );

  const forged = jsonClone(plan);
  assert(forged.trajectory.kind === 'hold', 'fixture is a hold');
  forged.trajectory.keyframes[0].frameCertificate!.viewDigest = 'forged-view';
  forged.trajectory.keyframes[1].frameCertificate!.viewDigest = 'forged-view';
  forged.trajectoryDigest = computeTrajectoryDigest(forged.trajectory);
  assert(forged.certification.status === 'certified', 'fixture is certified');
  forged.certification.certificate.trajectoryDigest = forged.trajectoryDigest;
  assertError(
    validateAuthorizedCertifiedTrajectoryPlan(forged),
    'coherently rehashed but false frame view digests cannot become authoritative',
  );

  const movingTrajectory: SerializedCameraTrajectory = {
    kind: 'keyframed',
    sampler: 'minimum-jerk-v1',
    samplerVersion: '1',
    durationMs: 1000,
    keyframes: [
      { timeMs: 0, view: { ...view } },
      { timeMs: 1000, view: { ...view } },
    ],
  };
  const movingDigest = computeTrajectoryDigest(movingTrajectory);
  const movingPlan: CommittedTrajectoryPlan = {
    inputDigest: 'moving-input-v1',
    trajectory: movingTrajectory,
    trajectoryDigest: movingDigest,
    certification: {
      status: 'certified',
      certificate: {
        kind: 'visibility-v1',
        trajectoryDigest: movingDigest,
        envelopeDigest: 'envelope-v1',
        viewportDigest: 'viewport-v1',
        constraintDigest: 'constraint-v1',
        validity: { domain: 'story-local', startMs: 0, endMs: 1000 },
        intervals: [{ startMs: 0, endMs: 1000, slackLowerBoundPx: 8, boundMethod: 'interval-arithmetic' }],
      },
    },
  };
  assert(validateCommittedTrajectoryPlan(movingPlan).status === 'ok', 'future certificate remains shape-valid');
  assertError(
    validateAuthorizedCertifiedTrajectoryPlan(movingPlan),
    'moving interval certificates are not authorized in the first production slice',
  );
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

testCanonicalDigestAndValidContracts();
testSamplerShapeAndFiniteNumberValidation();
testZeroDurationHoldContract();
testPlainDataGuardNeverInvokesAccessors();
testCertificateCoverageAndSlackValidation();
testValidationDoesNotMutateSources();
testMovementConsistencyAndCurrentCertifiedAuthority();
