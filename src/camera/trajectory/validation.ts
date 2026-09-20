import { digestCanonical } from '../geometry/canonical-digest';
import type { CameraMovement } from '../../interfaces';
import { MERCATOR_LATITUDE_LIMIT } from '../geometry/geo-wrap';
import type {
  CameraTrajectoryKeyframe,
  CertifiedFrameCertificate,
  CommittedTrajectoryPlan,
  SerializedCameraTrajectory,
  SerializedCameraView,
  TrajectoryCertification,
  TrajectoryCertificate,
  TrajectorySlackObservations,
} from './types';

export type TrajectoryValidation<T> = { status: 'ok'; value: T } | { status: 'error'; reason: string };

type PlainRecord = Record<string, unknown>;

const SEMANTIC_VIEW_KEYS = ['longitude', 'latitude', 'zoom', 'pitch', 'bearing'] as const;
const FRAME_CERTIFICATE_KEYS = [
  'kind',
  'inputDigest',
  'envelopeDigest',
  'viewportDigest',
  'constraintDigest',
  'solverVersion',
  'viewDigest',
  'slackPx',
] as const;

function error<T>(reason: string): TrajectoryValidation<T> {
  return { status: 'error', reason };
}

function ok<T>(value: T): TrajectoryValidation<T> {
  return { status: 'ok', value };
}

function inspectPlainData(value: unknown): string | null {
  const ancestors = new Set<object>();

  const inspect = (current: unknown, path: string): string | null => {
    if (current === null) {
      return null;
    }

    const valueType = typeof current;
    if (valueType === 'string' || valueType === 'boolean') {
      return null;
    }
    if (valueType === 'number') {
      return Number.isFinite(current) ? null : `${path} contains a non-finite number`;
    }
    if (valueType !== 'object') {
      return `${path} contains unsupported ${valueType} data`;
    }

    const objectValue = current as object;
    if (ancestors.has(objectValue)) {
      return `${path} contains a cycle`;
    }

    let prototype: object | null;
    let ownKeys: PropertyKey[];
    let descriptors: PropertyDescriptorMap;
    try {
      prototype = Object.getPrototypeOf(objectValue) as object | null;
      ownKeys = Reflect.ownKeys(objectValue);
      descriptors = Object.getOwnPropertyDescriptors(objectValue);
    } catch {
      return `${path} could not be inspected safely`;
    }

    const isArray = Array.isArray(objectValue);
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      return `${path} must use a plain data prototype`;
    }

    ancestors.add(objectValue);
    try {
      for (const key of ownKeys) {
        if (typeof key !== 'string') {
          return `${path} must not contain symbol keys`;
        }
        if (isArray && key === 'length') {
          continue;
        }

        const descriptor = descriptors[key];
        if (!descriptor || !('value' in descriptor)) {
          return `${path}.${key} must be a data property`;
        }
        if (!descriptor.enumerable) {
          return `${path}.${key} must be enumerable`;
        }
        if (isArray && !/^(0|[1-9]\d*)$/.test(key)) {
          return `${path}.${key} is not an array index`;
        }

        const nestedError = inspect(descriptor.value, `${path}.${key}`);
        if (nestedError) {
          return nestedError;
        }
      }
    } finally {
      ancestors.delete(objectValue);
    }

    return null;
  };

  return inspect(value, 'value');
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateKeys(
  value: PlainRecord,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): string | null {
  const keys = Object.keys(value);
  const allowedSet = new Set(allowed);
  const unknown = keys.find((key) => !allowedSet.has(key));
  if (unknown !== undefined) {
    return `${path}.${unknown} is not allowed`;
  }
  const missing = required.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  return missing === undefined ? null : `${path}.${missing} is required`;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return finiteNumber(value) && Number.isInteger(value) && value >= 0;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function sameSerializedView(first: SerializedCameraView, second: SerializedCameraView): boolean {
  return SEMANTIC_VIEW_KEYS.every((key) => first[key] === second[key]);
}

function validateSerializedView(value: unknown, path: string): TrajectoryValidation<SerializedCameraView> {
  if (!isPlainRecord(value)) {
    return error(`${path} must be a plain object`);
  }
  const keyError = validateKeys(value, SEMANTIC_VIEW_KEYS, SEMANTIC_VIEW_KEYS, path);
  if (keyError) {
    return error(keyError);
  }
  for (const key of SEMANTIC_VIEW_KEYS) {
    if (!finiteNumber(value[key])) {
      return error(`${path}.${key} must be finite`);
    }
  }
  if (Math.abs(value.latitude as number) > MERCATOR_LATITUDE_LIMIT) {
    return error(`${path}.latitude must lie within the Mercator projection`);
  }
  if ((value.pitch as number) < 0 || (value.pitch as number) > 85) {
    return error(`${path}.pitch must lie between 0 and 85 degrees`);
  }
  if ((value.zoom as number) < -2 || (value.zoom as number) > 24) {
    return error(`${path}.zoom must lie between -2 and 24`);
  }
  return ok(value as unknown as SerializedCameraView);
}

function validateFrameCertificate(value: unknown, path: string): TrajectoryValidation<CertifiedFrameCertificate> {
  if (!isPlainRecord(value)) {
    return error(`${path} must be a plain object`);
  }
  const keyError = validateKeys(value, FRAME_CERTIFICATE_KEYS, FRAME_CERTIFICATE_KEYS, path);
  if (keyError) {
    return error(keyError);
  }
  if (value.kind !== 'strict-frame-v1') {
    return error(`${path}.kind is unsupported`);
  }
  for (const key of [
    'inputDigest',
    'envelopeDigest',
    'viewportDigest',
    'constraintDigest',
    'solverVersion',
    'viewDigest',
  ] as const) {
    if (!nonemptyString(value[key])) {
      return error(`${path}.${key} must be a non-empty string`);
    }
  }
  if (!finiteNumber(value.slackPx) || value.slackPx < 0) {
    return error(`${path}.slackPx must be finite and nonnegative`);
  }
  return ok(value as unknown as CertifiedFrameCertificate);
}

function validateKeyframe(value: unknown, path: string): TrajectoryValidation<CameraTrajectoryKeyframe> {
  if (!isPlainRecord(value)) {
    return error(`${path} must be a plain object`);
  }
  const keyError = validateKeys(value, ['timeMs', 'view', 'frameCertificate'], ['timeMs', 'view'], path);
  if (keyError) {
    return error(keyError);
  }
  if (!finiteNumber(value.timeMs) || value.timeMs < 0) {
    return error(`${path}.timeMs must be finite and nonnegative`);
  }
  const viewResult = validateSerializedView(value.view, `${path}.view`);
  if (viewResult.status === 'error') {
    return viewResult;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'frameCertificate')) {
    const certificateResult = validateFrameCertificate(value.frameCertificate, `${path}.frameCertificate`);
    if (certificateResult.status === 'error') {
      return certificateResult;
    }
  }
  return ok(value as unknown as CameraTrajectoryKeyframe);
}

function validateDuration(value: unknown): value is number {
  return finiteNumber(value) && value >= 0;
}

function validateKeyframeArray(
  value: unknown,
  durationMs: number,
  kind: 'hold' | 'keyframed',
): TrajectoryValidation<CameraTrajectoryKeyframe[]> {
  if (!Array.isArray(value)) {
    return error('trajectory.keyframes must be an array');
  }
  if (value.length !== 2 && kind === 'hold') {
    return error('hold trajectory must contain exactly two boundary keyframes');
  }
  if (value.length < 2 && kind === 'keyframed') {
    return error('keyframed trajectory must contain at least two keyframes');
  }

  const keyframes: CameraTrajectoryKeyframe[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      return error(`trajectory.keyframes[${index}] is required`);
    }
    const result = validateKeyframe(value[index], `trajectory.keyframes[${index}]`);
    if (result.status === 'error') {
      return result;
    }
    keyframes.push(result.value);
  }

  if (keyframes[0].timeMs !== 0 || keyframes[keyframes.length - 1].timeMs !== durationMs) {
    return error('trajectory keyframe boundaries must match [0, durationMs]');
  }

  if (kind === 'hold') {
    const [first, second] = keyframes;
    if (!sameSerializedView(first.view, second.view)) {
      return error('hold boundary views must be equal');
    }
    const firstCertificate = first.frameCertificate;
    const secondCertificate = second.frameCertificate;
    if ((firstCertificate === undefined) !== (secondCertificate === undefined)) {
      return error('hold boundary frame certificates must both be present or absent');
    }
    if (
      firstCertificate !== undefined &&
      secondCertificate !== undefined &&
      digestCanonical(firstCertificate) !== digestCanonical(secondCertificate)
    ) {
      return error('hold boundary frame certificates must be equal');
    }
  } else {
    if (durationMs === 0) {
      return error('keyframed trajectory duration must be positive');
    }
    for (let index = 1; index < keyframes.length; index += 1) {
      if (keyframes[index].timeMs <= keyframes[index - 1].timeMs) {
        return error('keyframe times must increase strictly');
      }
    }
  }

  return ok(keyframes);
}

function validateTrajectoryShape(value: PlainRecord): TrajectoryValidation<SerializedCameraTrajectory> {
  if (!validateDuration(value.durationMs)) {
    return error('trajectory.durationMs must be finite and nonnegative');
  }
  if (value.samplerVersion !== '1') {
    return error('trajectory.samplerVersion is unsupported');
  }

  if (value.kind === 'hold') {
    const keyError = validateKeys(
      value,
      ['kind', 'sampler', 'samplerVersion', 'durationMs', 'keyframes'],
      ['kind', 'sampler', 'samplerVersion', 'durationMs', 'keyframes'],
      'trajectory',
    );
    if (keyError) return error(keyError);
    if (value.sampler !== 'hold-v1') return error('hold trajectory must use hold-v1');
    const keyframes = validateKeyframeArray(value.keyframes, value.durationMs, 'hold');
    return keyframes.status === 'error' ? keyframes : ok(value as unknown as SerializedCameraTrajectory);
  }

  if (value.kind === 'keyframed') {
    const keyError = validateKeys(
      value,
      ['kind', 'sampler', 'samplerVersion', 'durationMs', 'keyframes'],
      ['kind', 'sampler', 'samplerVersion', 'durationMs', 'keyframes'],
      'trajectory',
    );
    if (keyError) return error(keyError);
    if (value.sampler !== 'linear-v1' && value.sampler !== 'minimum-jerk-v1') {
      return error('keyframed trajectory sampler is unsupported');
    }
    const keyframes = validateKeyframeArray(value.keyframes, value.durationMs, 'keyframed');
    return keyframes.status === 'error' ? keyframes : ok(value as unknown as SerializedCameraTrajectory);
  }

  if (value.kind === 'legacy-fly') {
    const keys = ['kind', 'sampler', 'samplerVersion', 'durationMs', 'viewport', 'initView', 'finalView'];
    const keyError = validateKeys(value, keys, keys, 'trajectory');
    if (keyError) return error(keyError);
    if (value.sampler !== 'deck-fly-v1') return error('legacy fly trajectory must use deck-fly-v1');
    if (!isPlainRecord(value.viewport)) return error('trajectory.viewport must be a plain object');
    const viewportKeyError = validateKeys(
      value.viewport,
      ['width', 'height'],
      ['width', 'height'],
      'trajectory.viewport',
    );
    if (viewportKeyError) return error(viewportKeyError);
    if (!finiteNumber(value.viewport.width) || value.viewport.width <= 0) {
      return error('trajectory.viewport.width must be finite and positive');
    }
    if (!finiteNumber(value.viewport.height) || value.viewport.height <= 0) {
      return error('trajectory.viewport.height must be finite and positive');
    }
    const initial = validateSerializedView(value.initView, 'trajectory.initView');
    if (initial.status === 'error') return initial;
    const final = validateSerializedView(value.finalView, 'trajectory.finalView');
    return final.status === 'error' ? final : ok(value as unknown as SerializedCameraTrajectory);
  }

  if (value.kind === 'legacy-linear') {
    const keys = ['kind', 'sampler', 'samplerVersion', 'durationMs', 'initView', 'finalView'];
    const keyError = validateKeys(value, keys, keys, 'trajectory');
    if (keyError) return error(keyError);
    if (value.sampler !== 'legacy-linear-v1') {
      return error('legacy linear trajectory must use legacy-linear-v1');
    }
    const initial = validateSerializedView(value.initView, 'trajectory.initView');
    if (initial.status === 'error') return initial;
    const final = validateSerializedView(value.finalView, 'trajectory.finalView');
    return final.status === 'error' ? final : ok(value as unknown as SerializedCameraTrajectory);
  }

  return error('trajectory.kind is unsupported');
}

export function computeTrajectoryDigest(trajectory: SerializedCameraTrajectory): string {
  return digestCanonical({ schema: 'camera-trajectory-v1', trajectory });
}

export function validateSerializedTrajectory(value: unknown): TrajectoryValidation<SerializedCameraTrajectory> {
  const plainDataError = inspectPlainData(value);
  if (plainDataError) {
    return error(plainDataError);
  }
  if (!isPlainRecord(value)) {
    return error('trajectory must be a plain object');
  }
  return validateTrajectoryShape(value);
}

function validateInterval(
  value: unknown,
  path: string,
): TrajectoryValidation<TrajectoryCertificate['intervals'][number]> {
  if (!isPlainRecord(value)) return error(`${path} must be a plain object`);
  const keys = ['startMs', 'endMs', 'slackLowerBoundPx', 'boundMethod'];
  const keyError = validateKeys(value, keys, keys, path);
  if (keyError) return error(keyError);
  if (!finiteNumber(value.startMs) || value.startMs < 0) return error(`${path}.startMs must be nonnegative`);
  if (!finiteNumber(value.endMs) || value.endMs < value.startMs) return error(`${path}.endMs is invalid`);
  if (!finiteNumber(value.slackLowerBoundPx) || value.slackLowerBoundPx < 0) {
    return error(`${path}.slackLowerBoundPx must be finite and nonnegative`);
  }
  if (
    value.boundMethod !== 'constant-frame' &&
    value.boundMethod !== 'interval-arithmetic' &&
    value.boundMethod !== 'conservative-swept-footprint'
  ) {
    return error(`${path}.boundMethod is unsupported`);
  }
  return ok(value as unknown as TrajectoryCertificate['intervals'][number]);
}

function validateCertificate(
  value: unknown,
  trajectory: SerializedCameraTrajectory,
  trajectoryDigest: string,
): TrajectoryValidation<TrajectoryCertificate> {
  if (!isPlainRecord(value)) return error('certification.certificate must be a plain object');
  const keys = [
    'kind',
    'trajectoryDigest',
    'envelopeDigest',
    'viewportDigest',
    'constraintDigest',
    'validity',
    'intervals',
  ];
  const keyError = validateKeys(value, keys, keys, 'certification.certificate');
  if (keyError) return error(keyError);
  if (value.kind !== 'visibility-v1') return error('certification.certificate.kind is unsupported');
  if (value.trajectoryDigest !== trajectoryDigest) return error('certificate trajectory digest does not match');
  for (const key of ['envelopeDigest', 'viewportDigest', 'constraintDigest'] as const) {
    if (!nonemptyString(value[key])) return error(`certification.certificate.${key} must be a non-empty string`);
  }

  if (!isPlainRecord(value.validity)) return error('certificate validity must be a plain object');
  const validityKeyError = validateKeys(
    value.validity,
    ['domain', 'startMs', 'endMs'],
    ['domain', 'startMs', 'endMs'],
    'certification.certificate.validity',
  );
  if (validityKeyError) return error(validityKeyError);
  if (
    value.validity.domain !== 'story-local' ||
    value.validity.startMs !== 0 ||
    value.validity.endMs !== trajectory.durationMs
  ) {
    return error('certificate validity must exactly cover trajectory duration');
  }

  if (!Array.isArray(value.intervals) || value.intervals.length === 0) {
    return error('certificate intervals must be a non-empty array');
  }
  let expectedStart = 0;
  for (let index = 0; index < value.intervals.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value.intervals, index)) {
      return error(`certificate interval ${index} is missing`);
    }
    const interval = validateInterval(value.intervals[index], `certification.certificate.intervals[${index}]`);
    if (interval.status === 'error') return interval;
    if (interval.value.startMs !== expectedStart) {
      return error('certificate intervals must meet without gaps or overlaps');
    }
    if (trajectory.durationMs > 0 && interval.value.endMs <= interval.value.startMs) {
      return error('positive-duration certificate intervals must have positive width');
    }
    expectedStart = interval.value.endMs;
  }
  if (expectedStart !== trajectory.durationMs) {
    return error('certificate intervals must end at trajectory duration');
  }

  const certificate = value as unknown as TrajectoryCertificate;
  for (const keyframe of getTrajectoryKeyframes(trajectory)) {
    const frame = keyframe.frameCertificate;
    if (
      frame &&
      (frame.envelopeDigest !== certificate.envelopeDigest ||
        frame.viewportDigest !== certificate.viewportDigest ||
        frame.constraintDigest !== certificate.constraintDigest)
    ) {
      return error('frame and trajectory certificate context digests must match');
    }
  }

  return ok(certificate);
}

function getTrajectoryKeyframes(trajectory: SerializedCameraTrajectory): CameraTrajectoryKeyframe[] {
  return trajectory.kind === 'hold' || trajectory.kind === 'keyframed' ? trajectory.keyframes : [];
}

function validateObservations(
  value: unknown,
  trajectory: SerializedCameraTrajectory,
): TrajectoryValidation<TrajectorySlackObservations> {
  if (!isPlainRecord(value)) return error('certification.observations must be a plain object');
  const keys = ['samples', 'minimumSlackPx', 'evaluationCount', 'intervalBoundCount'];
  const keyError = validateKeys(value, keys, keys, 'certification.observations');
  if (keyError) return error(keyError);
  if (!Array.isArray(value.samples)) return error('certification.observations.samples must be an array');

  let minimum: number | null = null;
  let previousTime = -1;
  for (let index = 0; index < value.samples.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value.samples, index)) {
      return error(`observation sample ${index} is missing`);
    }
    const sample = value.samples[index];
    if (!isPlainRecord(sample)) return error(`observation sample ${index} must be a plain object`);
    const sampleKeyError = validateKeys(sample, ['timeMs', 'slackPx'], ['timeMs', 'slackPx'], `sample[${index}]`);
    if (sampleKeyError) return error(sampleKeyError);
    if (
      !finiteNumber(sample.timeMs) ||
      sample.timeMs < 0 ||
      sample.timeMs > trajectory.durationMs ||
      sample.timeMs <= previousTime
    ) {
      return error(`observation sample ${index} time is invalid`);
    }
    if (sample.slackPx !== null && !finiteNumber(sample.slackPx)) {
      return error(`observation sample ${index} slack must be finite or null`);
    }
    if (finiteNumber(sample.slackPx)) minimum = minimum === null ? sample.slackPx : Math.min(minimum, sample.slackPx);
    previousTime = sample.timeMs;
  }

  if (value.minimumSlackPx !== null && !finiteNumber(value.minimumSlackPx)) {
    return error('minimum observed slack must be finite or null');
  }
  if (value.minimumSlackPx !== minimum) {
    return error('minimum observed slack does not match samples');
  }
  if (!nonnegativeInteger(value.evaluationCount) || value.evaluationCount !== value.samples.length) {
    return error('evaluation count must match observation samples');
  }
  if (!nonnegativeInteger(value.intervalBoundCount)) {
    return error('interval bound count must be a nonnegative integer');
  }
  return ok(value as unknown as TrajectorySlackObservations);
}

function validateConstraintViolations(value: unknown): string | null {
  if (!Array.isArray(value)) return 'unsafe violations must be an array';
  const reasons = new Set([
    'invalid-parameters',
    'unsupported-projection',
    'outer-safe-region',
    'blocking-occlusion',
    'non-finite-view',
  ]);
  const primitiveKinds = new Set([
    'point-disc',
    'screen-rect',
    'extruded-footprint',
    'path-corridor',
    'polygon',
    'mesh-support',
  ]);
  const allowed = ['reason', 'message', 'primitiveIndex', 'primitiveKind', 'slackPx', 'occlusionId'];
  for (let index = 0; index < value.length; index += 1) {
    const violation = value[index];
    if (!isPlainRecord(violation)) return `unsafe violation ${index} must be a plain object`;
    const keyError = validateKeys(violation, allowed, ['reason', 'message'], `unsafe.violations[${index}]`);
    if (keyError) return keyError;
    if (
      typeof violation.reason !== 'string' ||
      !reasons.has(violation.reason) ||
      typeof violation.message !== 'string'
    ) {
      return `unsafe violation ${index} has an invalid reason or message`;
    }
    if (violation.primitiveIndex !== undefined && !nonnegativeInteger(violation.primitiveIndex)) {
      return `unsafe violation ${index} has an invalid primitive index`;
    }
    if (
      violation.primitiveKind !== undefined &&
      (typeof violation.primitiveKind !== 'string' || !primitiveKinds.has(violation.primitiveKind))
    ) {
      return `unsafe violation ${index} has an invalid primitive kind`;
    }
    if (violation.slackPx !== undefined && !finiteNumber(violation.slackPx)) {
      return `unsafe violation ${index} has invalid slack`;
    }
    if (violation.occlusionId !== undefined && typeof violation.occlusionId !== 'string') {
      return `unsafe violation ${index} has an invalid occlusion id`;
    }
  }
  return null;
}

function validateCertificationShape(
  value: PlainRecord,
  trajectory: SerializedCameraTrajectory,
  trajectoryDigest: string,
): TrajectoryValidation<TrajectoryCertification> {
  if (value.status === 'certified') {
    const keyError = validateKeys(value, ['status', 'certificate'], ['status', 'certificate'], 'certification');
    if (keyError) return error(keyError);
    const certificate = validateCertificate(value.certificate, trajectory, trajectoryDigest);
    return certificate.status === 'error' ? certificate : ok(value as unknown as TrajectoryCertification);
  }
  if (value.status === 'unsafe') {
    const keys = ['status', 'worstTimeMs', 'slackPx', 'violations'];
    const keyError = validateKeys(value, keys, keys, 'certification');
    if (keyError) return error(keyError);
    if (!finiteNumber(value.worstTimeMs) || value.worstTimeMs < 0 || value.worstTimeMs > trajectory.durationMs) {
      return error('unsafe worst time must lie within trajectory duration');
    }
    if (!finiteNumber(value.slackPx) || value.slackPx >= 0) {
      return error('unsafe slack must be finite and negative');
    }
    const violationError = validateConstraintViolations(value.violations);
    return violationError ? error(violationError) : ok(value as unknown as TrajectoryCertification);
  }
  if (value.status === 'unknown') {
    const keyError = validateKeys(value, ['status', 'reason'], ['status', 'reason'], 'certification');
    if (keyError) return error(keyError);
    if (value.reason !== 'work-budget-exceeded' && value.reason !== 'interval-bound-unavailable') {
      return error('unknown certification reason is unsupported');
    }
    return ok(value as unknown as TrajectoryCertification);
  }
  if (value.status === 'legacy-unverified') {
    const keyError = validateKeys(value, ['status', 'observations'], ['status', 'observations'], 'certification');
    if (keyError) return error(keyError);
    const observations = validateObservations(value.observations, trajectory);
    return observations.status === 'error' ? observations : ok(value as unknown as TrajectoryCertification);
  }
  return error('certification.status is unsupported');
}

export function validateTrajectoryCertification(
  value: unknown,
  trajectory: SerializedCameraTrajectory,
  trajectoryDigest: string,
): TrajectoryValidation<TrajectoryCertification> {
  const plainDataError = inspectPlainData(value);
  if (plainDataError) return error(plainDataError);
  if (!isPlainRecord(value)) return error('certification must be a plain object');
  if (!nonemptyString(trajectoryDigest)) return error('trajectory digest must be a non-empty string');
  return validateCertificationShape(value, trajectory, trajectoryDigest);
}

export function validateCommittedTrajectoryPlan(value: unknown): TrajectoryValidation<CommittedTrajectoryPlan> {
  const plainDataError = inspectPlainData(value);
  if (plainDataError) return error(plainDataError);
  if (!isPlainRecord(value)) return error('committed trajectory plan must be a plain object');
  const keys = ['inputDigest', 'trajectory', 'trajectoryDigest', 'certification'];
  const keyError = validateKeys(value, keys, keys, 'plan');
  if (keyError) return error(keyError);
  if (!nonemptyString(value.inputDigest)) return error('plan.inputDigest must be a non-empty string');
  if (!nonemptyString(value.trajectoryDigest)) return error('plan.trajectoryDigest must be a non-empty string');

  if (!isPlainRecord(value.trajectory)) return error('plan.trajectory must be a plain object');
  const trajectory = validateTrajectoryShape(value.trajectory);
  if (trajectory.status === 'error') return trajectory;
  let expectedDigest: string;
  try {
    expectedDigest = computeTrajectoryDigest(trajectory.value);
  } catch {
    return error('trajectory digest could not be computed');
  }
  if (value.trajectoryDigest !== expectedDigest) return error('plan trajectory digest does not match');

  if (!isPlainRecord(value.certification)) return error('plan.certification must be a plain object');
  const certification = validateCertificationShape(value.certification, trajectory.value, expectedDigest);
  if (certification.status === 'error') return certification;
  for (const keyframe of getTrajectoryKeyframes(trajectory.value)) {
    if (keyframe.frameCertificate && keyframe.frameCertificate.inputDigest !== value.inputDigest) {
      return error('frame certificate input digest does not match plan');
    }
  }
  return ok(value as unknown as CommittedTrajectoryPlan);
}

function trajectoryEndpointViews(trajectory: SerializedCameraTrajectory): [SerializedCameraView, SerializedCameraView] {
  if (trajectory.kind === 'hold' || trajectory.kind === 'keyframed') {
    return [trajectory.keyframes[0].view, trajectory.keyframes[trajectory.keyframes.length - 1].view];
  }
  return [trajectory.initView, trajectory.finalView];
}

export function validateCommittedTrajectoryPlanForMovement(
  value: unknown,
  movement: CameraMovement,
): TrajectoryValidation<CommittedTrajectoryPlan> {
  const validated = validateCommittedTrajectoryPlan(value);
  if (validated.status === 'error') return validated;
  if (!finiteNumber(movement.duration) || movement.duration < 0) {
    return error('camera movement duration must be finite and nonnegative');
  }
  if (validated.value.trajectory.durationMs !== movement.duration) {
    return error('trajectory duration does not match camera movement');
  }
  const [initial, final] = trajectoryEndpointViews(validated.value.trajectory);
  if (!sameSerializedView(initial, movement.initViewState) || !sameSerializedView(final, movement.finalViewState)) {
    return error('trajectory endpoint views do not match camera movement');
  }
  return validated;
}

export function validateAuthorizedCertifiedTrajectoryPlan(
  value: unknown,
): TrajectoryValidation<CommittedTrajectoryPlan> {
  const validated = validateCommittedTrajectoryPlan(value);
  if (validated.status === 'error') return validated;
  const plan = validated.value;
  if (plan.certification.status !== 'certified') {
    return error('trajectory plan is not certified');
  }
  if (plan.trajectory.kind !== 'hold') {
    return error('only certified hold trajectories are authorized in trajectory v2');
  }
  const firstFrame = plan.trajectory.keyframes[0].frameCertificate;
  const secondFrame = plan.trajectory.keyframes[1].frameCertificate;
  if (!firstFrame || !secondFrame) {
    return error('authorized certified hold requires frame certificates at both boundaries');
  }
  if (
    firstFrame.viewDigest !==
      digestCanonical({ schema: 'strict-frame-view-v1', view: plan.trajectory.keyframes[0].view }) ||
    secondFrame.viewDigest !==
      digestCanonical({ schema: 'strict-frame-view-v1', view: plan.trajectory.keyframes[1].view })
  ) {
    return error('frame certificate view digest does not match the hold view');
  }
  if (
    plan.certification.certificate.intervals.some(
      (interval) => interval.boundMethod !== 'constant-frame' || interval.slackLowerBoundPx !== firstFrame.slackPx,
    )
  ) {
    return error('only exact constant-frame slack intervals are authorized in trajectory v2');
  }
  return validated;
}
