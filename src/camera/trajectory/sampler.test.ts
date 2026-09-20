import { FlyToInterpolator } from '@deck.gl/core';
import type { CameraView } from '../../interfaces';
import { easeCameraProgress, interpolateCameraView } from '../interpolation';
import { compileRuntimeTrajectory, sampleCameraTrajectory } from './sampler';
import type { RuntimeCameraTrajectory, SerializedCameraTrajectory, SerializedCameraView } from './types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertClose(actual: number, expected: number, message: string, epsilon = 1e-9) {
  assert(Math.abs(actual - expected) <= epsilon, `${message}: expected ${expected}, received ${actual}`);
}

function assertViewClose(actual: CameraView, expected: SerializedCameraView, message: string, epsilon = 1e-9) {
  for (const channel of ['longitude', 'latitude', 'zoom', 'pitch', 'bearing'] as const) {
    assertClose(actual[channel], expected[channel], `${message} ${channel}`, epsilon);
  }
}

function view(overrides: Partial<SerializedCameraView> = {}): SerializedCameraView {
  return {
    longitude: 10,
    latitude: 20,
    zoom: 6,
    pitch: 30,
    bearing: 15,
    ...overrides,
  };
}

function compile(trajectory: SerializedCameraTrajectory): RuntimeCameraTrajectory {
  const result = compileRuntimeTrajectory(trajectory);
  assert(result.status === 'ok', `trajectory should compile: ${result.status === 'error' ? result.reason : ''}`);
  return result.value;
}

function testHoldClampsTimeAndReturnsFreshSemanticViews() {
  const heldView = view();
  const runtime = compile({
    kind: 'hold',
    sampler: 'hold-v1',
    samplerVersion: '1',
    durationMs: 1000,
    keyframes: [
      { timeMs: 0, view: heldView },
      { timeMs: 1000, view: { ...heldView } },
    ],
  });

  const samples = [-100, 0, 500, 1000, 5000].map((timeMs) => sampleCameraTrajectory(runtime, timeMs));
  for (const sample of samples) {
    assertViewClose(sample, heldView, 'hold sample');
    assert(Object.keys(sample).sort().join(',') === 'bearing,latitude,longitude,pitch,zoom', 'semantic fields only');
  }
  assert(samples[0] !== samples[1] && samples[1] !== samples[2], 'every sample must be a fresh object');
}

function testDeckFlyGoldenParity() {
  const initView = view({ longitude: -73.98, latitude: 40.72, zoom: 8, pitch: 20, bearing: -10 });
  const finalView = view({ longitude: -71.1, latitude: 42.3, zoom: 11, pitch: 55, bearing: 65 });
  const trajectory: SerializedCameraTrajectory = {
    kind: 'legacy-fly',
    sampler: 'deck-fly-v1',
    samplerVersion: '1',
    durationMs: 1000,
    viewport: { width: 1440, height: 900 },
    initView,
    finalView,
  };
  const runtime = compile(trajectory);
  const sampled = runtime.sample(250);

  const fly = new FlyToInterpolator();
  const initialized = fly.initializeProps(
    { ...initView, width: 1440, height: 900 },
    { ...finalView, width: 1440, height: 900 },
  );
  const oracle = fly.interpolateProps(initialized.start, initialized.end, easeCameraProgress(0.25));
  assertViewClose(sampled, oracle as SerializedCameraView, 'Deck fly golden parity');
}

function testLegacyLinearGoldenParityAndRawLinearDifference() {
  const initView = view({ longitude: 0, latitude: 0, zoom: 0, pitch: 0, bearing: 0 });
  const finalView = view({ longitude: 8, latitude: 12, zoom: 16, pitch: 20, bearing: 40 });
  const legacy = compile({
    kind: 'legacy-linear',
    sampler: 'legacy-linear-v1',
    samplerVersion: '1',
    durationMs: 1000,
    initView,
    finalView,
  });
  const oracle = interpolateCameraView(initView, finalView, 0.25);
  assertViewClose(legacy.sample(250), oracle, 'legacy linear golden parity');

  const linear = compile({
    kind: 'keyframed',
    sampler: 'linear-v1',
    samplerVersion: '1',
    durationMs: 1000,
    keyframes: [
      { timeMs: 0, view: initView },
      { timeMs: 1000, view: finalView },
    ],
  });
  assertClose(linear.sample(250).zoom, 4, 'linear-v1 uses raw segment progress');
  assertClose(legacy.sample(250).zoom, 1, 'legacy-linear-v1 keeps cubic playback easing');
}

function testMinimumJerkAndWrappedChannels() {
  const minimumJerk = compile({
    kind: 'keyframed',
    sampler: 'minimum-jerk-v1',
    samplerVersion: '1',
    durationMs: 1000,
    keyframes: [
      { timeMs: 0, view: view({ longitude: 0, zoom: 0 }) },
      { timeMs: 1000, view: view({ longitude: 10, zoom: 10 }) },
    ],
  });
  assertClose(minimumJerk.sample(250).zoom, 1.03515625, 'minimum jerk polynomial at u=0.25');

  const wrapped = compile({
    kind: 'keyframed',
    sampler: 'linear-v1',
    samplerVersion: '1',
    durationMs: 1000,
    keyframes: [
      { timeMs: 0, view: view({ longitude: 179, bearing: 170 }) },
      { timeMs: 1000, view: view({ longitude: -179, bearing: 190 }) },
    ],
  });
  assertClose(wrapped.sample(250).longitude, 179.5, 'longitude follows the short wrapped route');
  assertClose(wrapped.sample(500).longitude, -180, 'longitude normalizes only at the returned view');
  assertClose(wrapped.sample(500).bearing, 180, 'signed bearing keeps the short positive direction');
  assertClose(wrapped.sample(1000).bearing, 190, 'signed bearing endpoint remains stable');
}

function testBoundsAndCriticalTimesUseTheSamplerRepresentation() {
  const runtime = compile({
    kind: 'keyframed',
    sampler: 'linear-v1',
    samplerVersion: '1',
    durationMs: 1000,
    keyframes: [
      { timeMs: 0, view: view({ longitude: 0, zoom: 0, bearing: 0 }) },
      { timeMs: 500, view: view({ longitude: 10, zoom: 10, bearing: 20 }) },
      { timeMs: 1000, view: view({ longitude: 5, zoom: 5, bearing: 10 }) },
    ],
  });
  const bounds = runtime.bounds(250, 750);
  assert(bounds.status === 'bounded', 'keyframed channel bounds are available');
  assertClose(bounds.value.zoom[0], 5, 'bounds include sampled lower endpoint');
  assertClose(bounds.value.zoom[1], 10, 'bounds include interior keyframe maximum');
  assertClose(bounds.value.longitudeUnwrapped[0], 5, 'unwrapped longitude lower bound');
  assertClose(bounds.value.longitudeUnwrapped[1], 10, 'unwrapped longitude upper bound');
  assert(runtime.criticalTimes(200, 800).join(',') === '200,500,800', 'critical times are ordered and deduplicated');
  assert(runtime.criticalTimes(500, 500).join(',') === '500', 'equal range has one critical time');

  const hold = compile({
    kind: 'hold',
    sampler: 'hold-v1',
    samplerVersion: '1',
    durationMs: 10,
    keyframes: [
      { timeMs: 0, view: view({ zoom: 7 }) },
      { timeMs: 10, view: view({ zoom: 7 }) },
    ],
  });
  const holdBounds = hold.bounds(-5, 20);
  assert(holdBounds.status === 'bounded' && holdBounds.method === 'constant', 'hold bounds are exact');
  assert(holdBounds.status === 'bounded' && holdBounds.value.zoom[0] === 7, 'hold bound keeps its value');

  const fly = compile({
    kind: 'legacy-fly',
    sampler: 'deck-fly-v1',
    samplerVersion: '1',
    durationMs: 1000,
    viewport: { width: 1440, height: 900 },
    initView: view(),
    finalView: view({ longitude: 11 }),
  });
  assert(fly.bounds(0, 1000).status === 'unknown', 'compatibility fly bounds remain explicitly unknown');
}

function testCompilationCopiesInputAndContainsNonFiniteDeckOutput() {
  const source: Extract<SerializedCameraTrajectory, { kind: 'legacy-linear' }> = {
    kind: 'legacy-linear',
    sampler: 'legacy-linear-v1',
    samplerVersion: '1',
    durationMs: 1000,
    initView: view({ zoom: 1 }),
    finalView: view({ zoom: 9 }),
  };
  const runtime = compile(source);
  const originalDigest = runtime.digest;
  source.finalView.zoom = 99;
  assertClose(runtime.sample(1000).zoom, 9, 'compiled runtime is isolated from source mutation');
  assert(runtime.digest === originalDigest, 'source mutation cannot alter compiled digest');

  const unstable = compileRuntimeTrajectory({
    kind: 'legacy-fly',
    sampler: 'deck-fly-v1',
    samplerVersion: '1',
    durationMs: 1000,
    viewport: { width: 1440, height: 900 },
    initView: view({ latitude: 90 }),
    finalView: view({ latitude: -90 }),
  });
  assert(unstable.status === 'error', 'projection-illegal Deck input must be rejected before sampling');
}

testHoldClampsTimeAndReturnsFreshSemanticViews();
testDeckFlyGoldenParity();
testLegacyLinearGoldenParityAndRawLinearDifference();
testMinimumJerkAndWrappedChannels();
testBoundsAndCriticalTimesUseTheSamplerRepresentation();
testCompilationCopiesInputAndContainsNonFiniteDeckOutput();

function testFullTurnAndProjectionLimits() {
  const rotationView = (bearing: number) => ({ longitude: 0, latitude: 30, zoom: 8, pitch: 35, bearing });
  const path: SerializedCameraTrajectory = {
    kind: 'keyframed',
    sampler: 'linear-v1',
    samplerVersion: '1',
    durationMs: 4000,
    keyframes: [0, 90, 180, 270, 360].map((bearing, index) => ({ timeMs: index * 1000, view: rotationView(bearing) })),
  };
  const compiled = compileRuntimeTrajectory(path);
  assert(compiled.status === 'ok', 'signed rotation fixture compiles');
  assert(compiled.value.sample(3500).bearing === 315, 'a full turn keeps its signed intermediate route');
  assert(compiled.value.sample(4000).bearing === 360, 'full turn does not collapse onto zero');
  assert(
    Math.abs(compiled.value.sample(1001).bearing - compiled.value.sample(999).bearing - 0.18) < 1e-8,
    'linear auxiliary keys do not introduce a stop',
  );
  for (const illegalView of [
    { ...rotationView(0), latitude: 90 },
    { ...rotationView(0), pitch: 90 },
    { ...rotationView(0), pitch: -1 },
    { ...rotationView(0), zoom: 25 },
    { ...rotationView(0), zoom: -3 },
  ]) {
    const invalid = compileRuntimeTrajectory({
      kind: 'hold',
      sampler: 'hold-v1',
      samplerVersion: '1',
      durationMs: 1000,
      keyframes: [
        { timeMs: 0, view: illegalView },
        { timeMs: 1000, view: illegalView },
      ],
    });
    assert(invalid.status === 'error', 'projection-illegal views must fail before playback or save');
  }
}
testFullTurnAndProjectionLimits();
