import type { CameraView } from '../interfaces';
import { WebMercatorViewport } from '@deck.gl/core';
import { inspectCameraMovement, planAdaptiveCamera } from './planner';
import { createMultipleTarget, createPathTarget } from './selection';
import type { CameraPlanInput, CameraTarget, LngLat } from './types';
import { getTargetMaxZoom } from './viewport';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function near(actual: number, expected: number, message: string) {
  assert(Math.abs(actual - expected) < 1e-6, `${message}: expected ${expected}, received ${actual}`);
}
function path(coordinates: LngLat[]): CameraTarget {
  const target = createPathTarget(coordinates);
  assert(target, 'The fixture must contain a valid path.');
  return target;
}
const source: CameraView = {
  longitude: -74,
  latitude: 40.72,
  zoom: 13,
  pitch: 45,
  bearing: 0,
  minZoom: 0,
  maxZoom: 20,
  minPitch: 0,
  maxPitch: 60,
};
const first = path([
  [-74.00002, 40.71927],
  [-74.00142, 40.71993],
  [-74.00584, 40.7366],
]);
const second = path([
  [-73.98118, 40.7421],
  [-73.97225, 40.72973],
  [-73.98895, 40.69636],
]);
function input(cameraName: string, width = 1000, currentViewState = source): CameraPlanInput {
  return {
    cameraName,
    currentViewState,
    target: cameraName === 'comparison-pull-out' ? createMultipleTarget([first, second]) : first,
    comparisonTargets: cameraName === 'comparison-pull-out' ? [first, second] : undefined,
    viewportSize: { width, height: 600 },
  };
}
function planned(value: CameraPlanInput) {
  const result = planAdaptiveCamera(value);
  assert(
    result.status === 'planned',
    `The short path must be frameable: ${result.status === 'no-suggestion' ? result.reason : ''}`,
  );
  assert(
    inspectCameraMovement(result.cameraMovement, value.viewportSize).fits,
    'The committed movement must retain valid framing.',
  );
  return result.cameraMovement;
}
const failures: string[] = [];
function test(name: string, run: () => void) {
  try {
    run();
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

for (const width of [1000, 800]) {
  test(`tracking push-in retains its distance change at the path cap (${width})`, () => {
    const value = input('combination-tracking-push-in', width);
    near(getTargetMaxZoom(value.target!, source), 11, 'The existing path fit cap remains unchanged');
    const camera = planned(value);
    near(camera.finalViewState.zoom, 11, 'Keep the capped final framing');
    near(
      camera.finalViewState.zoom - camera.initViewState.zoom,
      0.45,
      'Retreat the start to retain the existing push-in',
    );
    for (const [cameraView, head] of [
      [camera.initViewState, first.start!],
      [camera.finalViewState, first.end!],
    ] as const) {
      const point = new WebMercatorViewport({ ...cameraView, width, height: 600 }).project(head);
      assert(Math.abs(point[0] - width * 0.5) < 0.5, 'Keep the route endpoint horizontally centered');
      assert(Math.abs(point[1] - 600 * 0.6) < 0.5, 'Keep space ahead of the route endpoint');
    }
  });
  test(`comparison pull-out retains recipe context when both fits hit the cap (${width})`, () => {
    const value = input('comparison-pull-out', width);
    const camera = planned(value);
    near(camera.initViewState.zoom, 10.75, 'Keep the first target framing and existing zoom bias');
    near(
      camera.finalViewState.zoom - camera.initViewState.zoom,
      -1.5,
      'Retreat the combined frame by the existing context request',
    );
    assert(camera.finalViewState.zoom <= 11, 'Do not raise the target fit cap to manufacture motion.');
  });
}

test('a real zoom floor can reduce the tracking push-in without being bypassed', () => {
  const camera = planned(input('combination-tracking-push-in', 1000, { ...source, minZoom: 10.9 }));
  near(camera.initViewState.zoom, 10.9, 'Honor the real zoom floor');
  near(camera.finalViewState.zoom, 11, 'Honor the path ceiling');
});
test('a real zoom floor can reduce the comparison pull-out without being bypassed', () => {
  const camera = planned(input('comparison-pull-out', 1000, { ...source, minZoom: 10.6 }));
  near(camera.initViewState.zoom, 10.75, 'Keep the fitted start');
  near(camera.finalViewState.zoom, 10.6, 'Honor the real zoom floor');
});

assert(failures.length === 0, failures.join('\n'));
console.log('Adaptive tracking and comparison preserve zoom motion at target caps without violating real limits.');
