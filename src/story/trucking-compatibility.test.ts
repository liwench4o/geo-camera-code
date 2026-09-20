import assert from 'node:assert/strict';
import test from 'node:test';
import type { CameraMovement } from '../interfaces';
import { prepareCameraAuthoring } from '../camera/authoring';
import { createCameraMovement } from '../camera/planner';
import { createRegionTarget } from '../camera/selection';
import { derivePlaybackPlan, getViewAtPlaybackTime } from './playback';
import { preserveAppliedPathAfterTimingEdit } from './retiming';
import { createStoryJson, parseStoryJson } from './serialization';

const viewport = { width: 1200, height: 800 };
const currentViewState = { longitude: -1.5, latitude: 52.5, zoom: 8, pitch: 35, bearing: 0 };
const target = createRegionTarget([
  [-2, 52.49],
  [-1, 52.49],
  [-1, 52.51],
  [-2, 52.51],
]);

// Saved endpoints from the historical Trucking implementation. Compatibility
// coverage must not regenerate its inputs through the current planner.
const historicalTruckingCameras: CameraMovement[] = [
  {
    id: 'historical-overview-trucking',
    name: 'overview-trucking',
    title: 'Trucking shot',
    category: 'overview',
    purpose: 'overview',
    shot: 'trucking',
    recipeId: 'overview-trucking',
    targetId: target.id,
    targetSnapshot: target,
    initViewState: {
      longitude: -1.85,
      latitude: 52.500001137278716,
      zoom: 9.044278438301177,
      pitch: 36.55,
      bearing: 0,
    },
    finalViewState: {
      longitude: -1.15,
      latitude: 52.500001137278716,
      zoom: 9.044278438301177,
      pitch: 36.55,
      bearing: 0,
    },
    duration: 1200,
    stay: 2000,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
  },
  {
    id: 'historical-basic-trucking',
    name: 'basic-trucking',
    title: 'Trucking shot',
    category: 'basic',
    purpose: 'basic',
    shot: 'trucking',
    recipeId: 'basic-trucking',
    targetId: target.id,
    targetSnapshot: target,
    initViewState: { longitude: -1.5, latitude: 52.5, zoom: 8, pitch: 35, bearing: 0 },
    finalViewState: { longitude: -0.5112304687500444, latitude: 52.49999999999984, zoom: 8, pitch: 35, bearing: 0 },
    duration: 1200,
    stay: 2000,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
  },
];

function samples(camera: CameraMovement) {
  const plan = derivePlaybackPlan([camera], { viewport });
  return [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
    const view = getViewAtPlaybackTime(plan.segments, camera.duration * fraction);
    assert(view);
    return [view.longitude, view.latitude, view.zoom, view.pitch, view.bearing];
  });
}

function assertMotionUnchanged(actual: CameraMovement, expected: CameraMovement) {
  assert.equal(actual.name, expected.name, 'never convert an existing Trucking shot to Pan');
  assert.equal(actual.duration, expected.duration);
  assert.equal(actual.stay, expected.stay);
  const expectedSamples = samples(expected);
  for (const [index, values] of samples(actual).entries()) {
    values.forEach((value, axis) => assert(Math.abs(value - expectedSamples[index][axis]) < 1e-8));
  }
}

for (const historical of historicalTruckingCameras) {
  const cameraName = historical.name;
  void test(`${cameraName}: old arrays, Story V1 and V2 retain playback and timing after re-export`, () => {
    const camera = historical;
    const formats = [
      [camera],
      createStoryJson([camera], { trajectoryEnabled: false, viewport }),
      createStoryJson([camera], { trajectoryEnabled: true, viewport }),
    ];
    assert.notDeepEqual(samples(camera)[0], samples(camera)[4], 'the fixture has real lateral motion');
    for (const format of formats) {
      const imported = parseStoryJson(JSON.parse(JSON.stringify(format)), { viewport });
      assert(imported.ok);
      assertMotionUnchanged(imported.cameras[0], camera);
      const restored = parseStoryJson(
        JSON.parse(JSON.stringify(createStoryJson(imported.cameras, { trajectoryEnabled: true, viewport }))),
      );
      assert(restored.ok);
      assertMotionUnchanged(restored.cameras[0], camera);
      const retimed = preserveAppliedPathAfterTimingEdit(restored.cameras[0], {
        ...restored.cameras[0],
        duration: 9000,
        stay: 750,
      });
      const editedImport = parseStoryJson(
        JSON.parse(JSON.stringify(createStoryJson([retimed], { trajectoryEnabled: true, viewport }))),
      );
      assert(editedImport.ok);
      assertMotionUnchanged(editedImport.cameras[0], retimed);
      assert.equal(editedImport.cameras[0].duration, 9000);
      assert.equal(editedImport.cameras[0].stay, 750);
    }
  });

  void test(`${cameraName}: existing shots can still be recalculated with saved endpoints and duration`, () => {
    const saved = { ...historical, duration: 7000 };
    const authoring = prepareCameraAuthoring(saved, { mode: 'readapt', viewport });
    const recalculated = createCameraMovement({
      cameraName: authoring.recipeId,
      currentViewState,
      target,
      authoring,
      viewportSize: viewport,
    }).cameraMovement;
    assert.equal(recalculated.name, cameraName);
    assert.equal(recalculated.authoring?.recipeId, cameraName);
    assert.equal(recalculated.duration, 7000);
    for (const field of ['initViewState', 'finalViewState'] as const) {
      for (const axis of ['longitude', 'latitude', 'zoom', 'pitch', 'bearing'] as const) {
        assert(
          Math.abs(recalculated[field][axis] - saved[field][axis]) < 1e-8,
          'saved endpoint survives longitude normalization',
        );
      }
    }
    assert(recalculated.trajectoryPlan, 'recalculation still produces a playable trajectory');
  });
}
