import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cameraCatalog, getCameraById, validateCameraCatalog } from './catalog';
import { getNewCameraDefaultOptionSelection } from './parameters';
import { createCameraMovement } from './planner';
import { getDefaultCameraOptionSelection, getCameraOptionSelectionById, resolveCameraRecipe } from './recipes';
import { createMultipleTarget, createPointTarget } from './selection';
import { resolveAdaptiveDuration } from './timing';
import { derivePlaybackPlan } from '../story/playback';

const view = { longitude: 0, latitude: 0, zoom: 8, pitch: 30, bearing: 0 };
const pair = [createPointTarget([0, 0]), createPointTarget([0.5, 0.5])];

void test('static defaults allow reading and their preset is the entire display time', () => {
  for (const [name, expected] of [
    ['emphasis-static', 4000],
    ['overview-static', 5000],
    ['comparison-static', 5000],
    ['comparison-side-by-side', 5000],
  ] as const) {
    const option = getNewCameraDefaultOptionSelection(name);
    assert.equal(option?.id, 'medium', name);
    assert.deepEqual(getDefaultCameraOptionSelection(name), option);
    for (const preset of getCameraById(name)!.options!) {
      const camera = createCameraMovement({
        cameraName: name,
        currentViewState: view,
        target: name.startsWith('comparison') ? createMultipleTarget(pair) : pair[0],
        comparisonTargets: pair,
        viewportSize: { width: 1000, height: 600 },
        optionSelection: getCameraOptionSelectionById(name, preset.id),
      }).cameraMovement;
      assert.equal(camera.stay, 0, name);
      assert.equal(camera.duration, preset.adjustment.timing!.durationMs, name);
      assert.equal(derivePlaybackPlan([camera]).totalTime, camera.duration, name);
      assert.deepEqual(camera.initViewState, camera.finalViewState);
      if (preset.id === 'medium') assert.equal(camera.duration, expected);
    }
  }
});

void test('Normal preserves the neutral pace and every recommended movement has a deliberate preset', () => {
  for (const camera of cameraCatalog.cameras.filter((c) => c.mode === 'recommended')) {
    assert(camera.options?.length, camera.id);
    const normal = getCameraOptionSelectionById(camera.id, 'normal');
    if (!normal) continue;
    const base = resolveCameraRecipe(camera.id);
    const selected = resolveCameraRecipe(camera.id, normal);
    assert.equal(selected.duration, base.duration, `${camera.id}: Normal must be 1x`);
    for (const displacement of [0.05, 2, 50]) {
      const duration = resolveAdaptiveDuration({ recipe: selected, displacement, pathLengthKm: 100 }).durationMs;
      for (const option of camera.options) {
        const adjusted = resolveAdaptiveDuration({
          recipe: resolveCameraRecipe(camera.id, getCameraOptionSelectionById(camera.id, option.id)),
          displacement,
          pathLengthKm: 100,
        }).durationMs;
        if (option.id === 'fast') assert(adjusted < duration, camera.id);
        if (option.id === 'slow') assert(adjusted > duration, camera.id);
      }
    }
  }
});

void test('large emphasis orbit retains a readable 12-second neutral movement', () => {
  const recipe = resolveCameraRecipe('emphasis-arc', getNewCameraDefaultOptionSelection('emphasis-arc'));
  assert.equal(resolveAdaptiveDuration({ recipe, displacement: 1 }).durationMs, 12000);
});

void test('Tilt angle choices are distinct, attainable endpoints within the purpose range', () => {
  for (const name of ['emphasis-tilt', 'overview-tilt']) {
    let previous = -1;
    for (const option of getCameraById(name)!.options!) {
      const selected = getCameraOptionSelectionById(name, option.id)!;
      const recipe = resolveCameraRecipe(name, selected);
      const angle = selected.adjustment.framing!.pitchTarget!;
      assert(angle >= recipe.framing.pitchRange[0] && angle <= recipe.framing.pitchRange[1], name);
      const camera = createCameraMovement({
        cameraName: name,
        currentViewState: view,
        target: pair[0],
        viewportSize: { width: 1000, height: 600 },
        optionSelection: selected,
      }).cameraMovement;
      assert(Math.abs(camera.finalViewState.pitch - angle) < 0.1, `${name}/${option.id}`);
      assert(camera.finalViewState.pitch > previous, `${name}/${option.id} must produce a distinct angle`);
      previous = camera.finalViewState.pitch;
    }
  }
});

void test('catalog rejects an explicit default that does not exist', () => {
  const catalog = JSON.parse(JSON.stringify(cameraCatalog));
  catalog.cameras[0].defaultOptionId = 'missing';
  assert(validateCameraCatalog(catalog).some((error) => error.includes('defaultOptionId')));
});

void test('explicit default survives ordering and legacy catalogs retain a sensible fallback', () => {
  const camera = getCameraById('dynamic-pan')!;
  const originalOptions = camera.options;
  const originalDefault = camera.defaultOptionId;
  try {
    camera.options = [...originalOptions!].reverse();
    camera.defaultOptionId = 'slow';
    assert.equal(getNewCameraDefaultOptionSelection(camera.id)?.id, 'slow');
    assert.equal(getDefaultCameraOptionSelection(camera.id)?.id, 'slow');
    delete camera.defaultOptionId;
    assert.equal(getDefaultCameraOptionSelection(camera.id)?.id, 'normal');
  } finally {
    camera.options = originalOptions;
    camera.defaultOptionId = originalDefault;
  }
});

void test('stored preset snapshots retain their timing after catalog retuning', () => {
  const saved = { id: 'normal', label: 'Normal (2.0s)', adjustment: { timing: { durationMs: 2000 } } };
  const recipe = resolveCameraRecipe('emphasis-arc', saved);
  assert.equal(resolveAdaptiveDuration({ recipe, displacement: 1 }).durationMs, 2000);
  assert.deepEqual(recipe.optionSelection, saved);
});

void test('split presets preserve their complete display time and both selected targets', () => {
  const name = 'comparison-side-by-side';
  assert.equal(resolveCameraRecipe(name).duration, 5000);
  assert.equal(resolveCameraRecipe(name).stay, 0);
  assert.deepEqual(
    getCameraById(name)!
      .options!.map((option) => option.id)
      .sort(),
    ['long', 'medium', 'short'],
  );
  for (const [preset, milliseconds] of [
    ['short', 3000],
    ['medium', 5000],
    ['long', 8000],
  ] as const) {
    const camera = createCameraMovement({
      cameraName: name,
      currentViewState: view,
      target: createMultipleTarget(pair),
      comparisonTargets: pair,
      optionSelection: getCameraOptionSelectionById(name, preset),
      viewportSize: { width: 1000, height: 600 },
    }).cameraMovement;
    assert.equal(camera.duration, milliseconds);
    assert.equal(camera.presentation, 'split');
    assert.deepEqual(camera.comparisonTargetSnapshots, pair);
  }
});
