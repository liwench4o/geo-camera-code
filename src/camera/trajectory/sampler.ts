import { FlyToInterpolator } from '@deck.gl/core';
import type { CameraView } from '../../interfaces';
import { normalizeLongitude, shortestAngle, unwrapLongitude } from '../geometry/geo-wrap';
import { easeCameraProgress } from '../interpolation';
import type {
  CameraTrajectoryKeyframe,
  CameraViewIntervalBounds,
  CertifiedFrameCertificate,
  RuntimeCameraTrajectory,
  SerializedCameraTrajectory,
  SerializedCameraView,
  TrajectoryBoundsResult,
} from './types';
import { computeTrajectoryDigest, type TrajectoryValidation, validateSerializedTrajectory } from './validation';

const SEMANTIC_CHANNELS = ['longitude', 'latitude', 'zoom', 'pitch', 'bearing'] as const;

type UnwrappedCameraView = SerializedCameraView;

interface PreparedKeyframe {
  timeMs: number;
  view: UnwrappedCameraView;
}

function validationError<T>(reason: string): TrajectoryValidation<T> {
  return { status: 'error', reason };
}

function copyView(view: SerializedCameraView): SerializedCameraView {
  return {
    longitude: view.longitude,
    latitude: view.latitude,
    zoom: view.zoom,
    pitch: view.pitch,
    bearing: view.bearing,
  };
}

function copyFrameCertificate(certificate: CertifiedFrameCertificate): CertifiedFrameCertificate {
  return {
    kind: certificate.kind,
    inputDigest: certificate.inputDigest,
    envelopeDigest: certificate.envelopeDigest,
    viewportDigest: certificate.viewportDigest,
    constraintDigest: certificate.constraintDigest,
    solverVersion: certificate.solverVersion,
    viewDigest: certificate.viewDigest,
    slackPx: certificate.slackPx,
  };
}

function copyKeyframe(keyframe: CameraTrajectoryKeyframe): CameraTrajectoryKeyframe {
  return {
    timeMs: keyframe.timeMs,
    view: copyView(keyframe.view),
    ...(keyframe.frameCertificate ? { frameCertificate: copyFrameCertificate(keyframe.frameCertificate) } : {}),
  };
}

function copyTrajectory(trajectory: SerializedCameraTrajectory): SerializedCameraTrajectory {
  switch (trajectory.kind) {
    case 'hold':
      return {
        kind: trajectory.kind,
        sampler: trajectory.sampler,
        samplerVersion: trajectory.samplerVersion,
        durationMs: trajectory.durationMs,
        keyframes: [copyKeyframe(trajectory.keyframes[0]), copyKeyframe(trajectory.keyframes[1])],
      };
    case 'keyframed':
      return {
        kind: trajectory.kind,
        sampler: trajectory.sampler,
        samplerVersion: trajectory.samplerVersion,
        durationMs: trajectory.durationMs,
        keyframes: trajectory.keyframes.map(copyKeyframe),
      };
    case 'legacy-fly':
      return {
        kind: trajectory.kind,
        sampler: trajectory.sampler,
        samplerVersion: trajectory.samplerVersion,
        durationMs: trajectory.durationMs,
        viewport: { width: trajectory.viewport.width, height: trajectory.viewport.height },
        initView: copyView(trajectory.initView),
        finalView: copyView(trajectory.finalView),
      };
    case 'legacy-linear':
      return {
        kind: trajectory.kind,
        sampler: trajectory.sampler,
        samplerVersion: trajectory.samplerVersion,
        durationMs: trajectory.durationMs,
        initView: copyView(trajectory.initView),
        finalView: copyView(trajectory.finalView),
      };
  }
}

function freezeFrameCertificate(certificate: CertifiedFrameCertificate | undefined) {
  if (certificate) Object.freeze(certificate);
}

function freezeKeyframe(keyframe: CameraTrajectoryKeyframe) {
  Object.freeze(keyframe.view);
  freezeFrameCertificate(keyframe.frameCertificate);
  Object.freeze(keyframe);
}

function freezeTrajectory(trajectory: SerializedCameraTrajectory): SerializedCameraTrajectory {
  if (trajectory.kind === 'hold' || trajectory.kind === 'keyframed') {
    trajectory.keyframes.forEach(freezeKeyframe);
    Object.freeze(trajectory.keyframes);
  } else {
    Object.freeze(trajectory.initView);
    Object.freeze(trajectory.finalView);
    if (trajectory.kind === 'legacy-fly') Object.freeze(trajectory.viewport);
  }
  return Object.freeze(trajectory);
}

function unwrapView(view: SerializedCameraView, previous?: UnwrappedCameraView): UnwrappedCameraView {
  if (!previous) return copyView(view);
  return {
    longitude: unwrapLongitude(view.longitude, previous.longitude),
    latitude: view.latitude,
    zoom: view.zoom,
    pitch: view.pitch,
    bearing: previous.bearing + shortestAngle(previous.bearing, view.bearing),
  };
}

function prepareKeyframes(keyframes: CameraTrajectoryKeyframe[]): PreparedKeyframe[] {
  const result: PreparedKeyframe[] = [];
  for (const keyframe of keyframes) {
    result.push({
      timeMs: keyframe.timeMs,
      view: unwrapView(keyframe.view, result[result.length - 1]?.view),
    });
  }
  return result;
}

function interpolateUnwrapped(
  initial: UnwrappedCameraView,
  final: UnwrappedCameraView,
  progress: number,
): UnwrappedCameraView {
  return {
    longitude: initial.longitude + (final.longitude - initial.longitude) * progress,
    latitude: initial.latitude + (final.latitude - initial.latitude) * progress,
    zoom: initial.zoom + (final.zoom - initial.zoom) * progress,
    pitch: initial.pitch + (final.pitch - initial.pitch) * progress,
    bearing: initial.bearing + (final.bearing - initial.bearing) * progress,
  };
}

function minimumJerk(progress: number): number {
  const squared = progress * progress;
  const cubed = squared * progress;
  return 10 * cubed - 15 * cubed * progress + 6 * cubed * squared;
}

function clampTime(localTimeMs: number, durationMs: number): number {
  if (typeof localTimeMs !== 'number' || Number.isNaN(localTimeMs)) {
    throw new TypeError('camera trajectory time must be a number');
  }
  return Math.min(durationMs, Math.max(0, localTimeMs));
}

function semanticView(view: UnwrappedCameraView): CameraView {
  for (const channel of SEMANTIC_CHANNELS) {
    if (!Number.isFinite(view[channel])) {
      throw new RangeError(`camera trajectory sampler produced non-finite ${channel}`);
    }
  }
  return {
    longitude: normalizeLongitude(view.longitude),
    latitude: view.latitude,
    zoom: view.zoom,
    pitch: view.pitch,
    bearing: view.bearing,
  };
}

function normalizedRange(startMs: number, endMs: number, durationMs: number): [number, number] {
  const first = clampTime(startMs, durationMs);
  const second = clampTime(endMs, durationMs);
  return first <= second ? [first, second] : [second, first];
}

function orderedTimes(startMs: number, endMs: number, durationMs: number, boundaries: number[]): number[] {
  const [start, end] = normalizedRange(startMs, endMs, durationMs);
  const times = [start, ...boundaries.filter((time) => time > start && time < end), end].sort((a, b) => a - b);
  return times.filter((time, index) => index === 0 || time !== times[index - 1]);
}

function boundsFromViews(
  views: UnwrappedCameraView[],
  method: 'constant' | 'channel-monotone',
): TrajectoryBoundsResult {
  const values = (channel: keyof UnwrappedCameraView): [number, number] => {
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (const view of views) {
      minimum = Math.min(minimum, view[channel]);
      maximum = Math.max(maximum, view[channel]);
    }
    return [minimum, maximum];
  };
  const value: CameraViewIntervalBounds = {
    longitudeUnwrapped: values('longitude'),
    latitude: values('latitude'),
    zoom: values('zoom'),
    pitch: values('pitch'),
    bearingUnwrapped: values('bearing'),
  };
  return { status: 'bounded', value, method };
}

function samplePreparedKeyframes(
  keyframes: PreparedKeyframe[],
  localTimeMs: number,
  durationMs: number,
  easing: (progress: number) => number,
): UnwrappedCameraView {
  const timeMs = clampTime(localTimeMs, durationMs);
  if (timeMs <= keyframes[0].timeMs) return copyView(keyframes[0].view);
  if (timeMs >= keyframes[keyframes.length - 1].timeMs) return copyView(keyframes[keyframes.length - 1].view);

  let index = 0;
  while (index + 1 < keyframes.length && timeMs > keyframes[index + 1].timeMs) index += 1;
  const initial = keyframes[index];
  const final = keyframes[index + 1];
  const progress = (timeMs - initial.timeMs) / (final.timeMs - initial.timeMs);
  return interpolateUnwrapped(initial.view, final.view, easing(progress));
}

function compileKeyframedRuntime(
  trajectory: Extract<SerializedCameraTrajectory, { kind: 'hold' | 'keyframed' }>,
): Pick<RuntimeCameraTrajectory, 'sample' | 'bounds' | 'criticalTimes'> {
  const keyframes = prepareKeyframes(trajectory.keyframes);
  const easing =
    trajectory.kind === 'hold' || trajectory.sampler === 'linear-v1' ? (progress: number) => progress : minimumJerk;
  const sampleUnwrapped = (timeMs: number) => samplePreparedKeyframes(keyframes, timeMs, trajectory.durationMs, easing);
  const boundaries = keyframes.map((keyframe) => keyframe.timeMs);

  return {
    sample: (timeMs) => semanticView(sampleUnwrapped(timeMs)),
    bounds: (startMs, endMs) => {
      const times = orderedTimes(startMs, endMs, trajectory.durationMs, boundaries);
      return boundsFromViews(times.map(sampleUnwrapped), trajectory.kind === 'hold' ? 'constant' : 'channel-monotone');
    },
    criticalTimes: (startMs, endMs) => orderedTimes(startMs, endMs, trajectory.durationMs, boundaries),
  };
}

function compileLegacyLinearRuntime(
  trajectory: Extract<SerializedCameraTrajectory, { kind: 'legacy-linear' }>,
): Pick<RuntimeCameraTrajectory, 'sample' | 'bounds' | 'criticalTimes'> {
  const initial = unwrapView(trajectory.initView);
  const final = unwrapView(trajectory.finalView, initial);
  const sampleUnwrapped = (localTimeMs: number) => {
    const timeMs = clampTime(localTimeMs, trajectory.durationMs);
    const progress = trajectory.durationMs > 0 ? timeMs / trajectory.durationMs : 1;
    return interpolateUnwrapped(initial, final, easeCameraProgress(progress));
  };
  return {
    sample: (timeMs) => semanticView(sampleUnwrapped(timeMs)),
    bounds: (startMs, endMs) => {
      const times = orderedTimes(startMs, endMs, trajectory.durationMs, []);
      return boundsFromViews(times.map(sampleUnwrapped), 'channel-monotone');
    },
    criticalTimes: (startMs, endMs) => orderedTimes(startMs, endMs, trajectory.durationMs, []),
  };
}

function compileLegacyFlyRuntime(
  trajectory: Extract<SerializedCameraTrajectory, { kind: 'legacy-fly' }>,
): Pick<RuntimeCameraTrajectory, 'sample' | 'bounds' | 'criticalTimes'> {
  const initial = unwrapView(trajectory.initView);
  const final = unwrapView(trajectory.finalView, initial);
  const fly = new FlyToInterpolator();
  const initialized = fly.initializeProps(
    { ...initial, width: trajectory.viewport.width, height: trajectory.viewport.height },
    { ...final, width: trajectory.viewport.width, height: trajectory.viewport.height },
  );
  return {
    sample: (localTimeMs) => {
      const timeMs = clampTime(localTimeMs, trajectory.durationMs);
      const progress = trajectory.durationMs > 0 ? timeMs / trajectory.durationMs : 1;
      const sampled = fly.interpolateProps(initialized.start, initialized.end, easeCameraProgress(progress));
      return semanticView(sampled as UnwrappedCameraView);
    },
    bounds: () => ({ status: 'unknown', reason: 'compatibility-fly-bound-unavailable' }),
    criticalTimes: (startMs, endMs) => orderedTimes(startMs, endMs, trajectory.durationMs, []),
  };
}

export function compileRuntimeTrajectory(
  value: SerializedCameraTrajectory,
): TrajectoryValidation<RuntimeCameraTrajectory> {
  const validated = validateSerializedTrajectory(value);
  if (validated.status === 'error') return validated;

  try {
    const serialized = freezeTrajectory(copyTrajectory(validated.value));
    const digest = computeTrajectoryDigest(serialized);
    const sampler =
      serialized.kind === 'hold' || serialized.kind === 'keyframed'
        ? compileKeyframedRuntime(serialized)
        : serialized.kind === 'legacy-linear'
          ? compileLegacyLinearRuntime(serialized)
          : compileLegacyFlyRuntime(serialized);
    return {
      status: 'ok',
      value: {
        serialized,
        digest,
        sample: sampler.sample,
        bounds: sampler.bounds,
        criticalTimes: sampler.criticalTimes,
      },
    };
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : String(caught);
    return validationError(`camera trajectory could not be compiled: ${detail}`);
  }
}

export function sampleCameraTrajectory(trajectory: RuntimeCameraTrajectory, localTimeMs: number): CameraView {
  return trajectory.sample(localTimeMs);
}
