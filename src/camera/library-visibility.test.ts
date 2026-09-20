import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cameraCatalog,
  getCameraById,
  getManualCameraGroups,
  getRecommendedCamerasByPurpose,
  getRecommendedPurposes,
  loadCameraCatalog,
  validateCameraCatalog,
} from './catalog';
import { isCameraImplemented, resolveCameraRecipe } from './recipes';

const hiddenIds = ['overview-trucking', 'basic-trucking'];

void test('only the two legacy Trucking shots are hidden from new-shot lists', () => {
  const recommended = getRecommendedPurposes().flatMap((purpose) => getRecommendedCamerasByPurpose(purpose.id));
  const manual = getManualCameraGroups().flatMap((group) => group.cameras);
  const visibleIds = [...recommended, ...manual].map((camera) => camera.id);
  assert.deepEqual(
    cameraCatalog.cameras.filter((camera) => !visibleIds.includes(camera.id)).map((camera) => camera.id),
    hiddenIds,
  );
  for (const id of ['overview-pan', 'overview-tracking', 'basic-pan', 'basic-tracking']) {
    assert(visibleIds.includes(id), `${id} remains available`);
  }
  for (const id of hiddenIds) {
    assert(getCameraById(id), `${id} remains addressable by ID`);
    assert(isCameraImplemented(id), `${id} retains its implementation`);
    assert.equal(resolveCameraRecipe(id).strategy, 'trucking');
  }
});

void test('library visibility is optional boolean metadata and survives catalog loading', () => {
  const catalog = structuredClone(cameraCatalog);
  const camera = catalog.cameras[0] as (typeof catalog.cameras)[number] & { hiddenFromLibrary?: unknown };
  for (const value of [undefined, false, true]) {
    Object.assign(camera, { hiddenFromLibrary: value });
    assert.deepEqual(validateCameraCatalog(catalog), []);
    assert.equal(
      (loadCameraCatalog(catalog).cameras[0] as unknown as Record<string, unknown>).hiddenFromLibrary,
      value,
    );
  }
  for (const value of ['true', 1, null]) {
    Object.assign(camera, { hiddenFromLibrary: value });
    assert(validateCameraCatalog(catalog).some((error) => error.includes('hiddenFromLibrary')));
  }
});
