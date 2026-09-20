import type { CameraView } from '../interfaces';
import {
  DEFAULT_MAX_BEARING_SAMPLE_STEP_DEG,
  easeCameraProgress,
  getCameraPathSampleCount,
  interpolateCameraView,
  sampleCameraViewPath,
} from './interpolation';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertClose(actual: number, expected: number, message: string) {
  assert(Math.abs(actual - expected) < 1e-6, `${message}: expected ${expected}, received ${actual}`);
}

function createView(overrides: Partial<CameraView>): CameraView {
  return {
    longitude: 0,
    latitude: 0,
    zoom: 10,
    pitch: 35,
    bearing: 0,
    minZoom: 0,
    maxZoom: 20,
    minPitch: 0,
    maxPitch: 85,
    ...overrides,
  };
}

function testEaseCameraProgressClampsAndKeepsCubicMidpoint() {
  assertClose(easeCameraProgress(-1), 0, 'easing should clamp negative progress to zero');
  assertClose(easeCameraProgress(2), 1, 'easing should clamp progress above one to one');
  assertClose(easeCameraProgress(0.5), 0.5, 'easing midpoint should remain centered');
  assertClose(easeCameraProgress(0.25), 0.0625, 'easing should keep cubic ease-in for the first half');
}

function testInterpolateCameraViewUsesEasedProgressAndClearsTransitionFields() {
  const transitionEasing = () => 0.5;
  const initView = createView({ longitude: 10, latitude: 20, zoom: 10, pitch: 30, bearing: 0 });
  const finalView = createView({
    longitude: 18,
    latitude: 12,
    zoom: 14,
    pitch: 50,
    bearing: 80,
    transitionDuration: 1200,
    transitionEasing,
    transitionInterpolator: { name: 'fly' },
    onTransitionEnd: () => undefined,
  });

  const result = interpolateCameraView(initView, finalView, 0.25);

  assertClose(result.longitude, 10.5, 'longitude should use eased progress');
  assertClose(result.latitude, 19.5, 'latitude should use eased progress');
  assertClose(result.zoom, 10.25, 'zoom should use eased progress');
  assertClose(result.pitch, 31.25, 'pitch should use eased progress');
  assertClose(result.bearing, 5, 'bearing should use eased progress');
  assert(result.transitionDuration === 0, 'interpolated view should cancel transition duration');
  assert(result.transitionInterpolator === undefined, 'interpolated view should clear transition interpolator');
  assert(result.onTransitionEnd === undefined, 'interpolated view should clear transition callback');
  assert(result.transitionEasing === transitionEasing, 'interpolated view should preserve existing transition easing');
}

function testCameraPathSampleCountUsesBearingSpan() {
  assert(
    DEFAULT_MAX_BEARING_SAMPLE_STEP_DEG === 15,
    `default bearing sample step should stay at 15 degrees, received ${DEFAULT_MAX_BEARING_SAMPLE_STEP_DEG}`,
  );
  assert(
    getCameraPathSampleCount(createView({ bearing: 0 }), createView({ bearing: 0 })) === 1,
    'non-rotating paths should still include one interval',
  );
  assert(
    getCameraPathSampleCount(createView({ bearing: 0 }), createView({ bearing: 44.9 })) === 3,
    'sample count should ceil bearing span over default step',
  );
  assert(
    getCameraPathSampleCount(createView({ bearing: 0 }), createView({ bearing: 46 })) === 4,
    'sample count should add an interval when bearing span exceeds the step multiple',
  );
  assert(
    getCameraPathSampleCount(createView({ bearing: 90 }), createView({ bearing: 30 }), {
      maxBearingStepDeg: 20,
    }) === 3,
    'sample count should use absolute bearing span and custom step',
  );
  assert(
    getCameraPathSampleCount(createView({ bearing: 0 }), createView({ bearing: 46 }), {
      maxBearingStepDeg: 0,
    }) === 4,
    'sample count should fall back to default step when custom step is invalid',
  );
}

function testSampleCameraViewPathIncludesEndpoints() {
  const initView = createView({ longitude: -2, latitude: 52, zoom: 8, pitch: 30, bearing: 0 });
  const finalView = createView({
    longitude: -1,
    latitude: 53,
    zoom: 9,
    pitch: 50,
    bearing: 45,
    transitionDuration: 1000,
    transitionInterpolator: { name: 'fly' },
    onTransitionEnd: () => undefined,
  });
  const samples = sampleCameraViewPath(initView, finalView);

  assert(samples.length === 4, `45 degrees at 15-degree steps should produce four samples, received ${samples.length}`);
  assertClose(samples[0].longitude, initView.longitude, 'first sample should use initial longitude');
  assertClose(samples[0].bearing, initView.bearing, 'first sample should use initial bearing');
  assertClose(samples[samples.length - 1].longitude, finalView.longitude, 'last sample should use final longitude');
  assertClose(samples[samples.length - 1].bearing, finalView.bearing, 'last sample should use final bearing');
  assert(samples[0].transitionDuration === 0, 'sampled path should strip transition duration from first sample');
  assert(
    samples[samples.length - 1].transitionInterpolator === undefined,
    'sampled path should clear transition interpolator from final sample',
  );
}

testEaseCameraProgressClampsAndKeepsCubicMidpoint();
testInterpolateCameraViewUsesEasedProgressAndClearsTransitionFields();
testCameraPathSampleCountUsesBearingSpan();
testSampleCameraViewPathIncludesEndpoints();
