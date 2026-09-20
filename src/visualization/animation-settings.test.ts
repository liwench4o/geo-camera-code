import assert from 'node:assert/strict';
import { visualizationCatalog } from './catalog';
import { validateVisualizationCatalog } from './registry';
import type { VisualizationCatalog } from './types';

function animationErrors(edit: (catalog: VisualizationCatalog) => void) {
  const catalog = structuredClone(visualizationCatalog);
  edit(catalog);
  return validateVisualizationCatalog(catalog).filter((error) => error.startsWith('[catalog.animation]'));
}
function animated(catalog: VisualizationCatalog) {
  return catalog.visualizations.find((item) => item.id === 'animated')!;
}
assert.deepEqual(
  animationErrors(() => {}),
  [],
);
assert.deepEqual(
  animationErrors((catalog) => {
    delete animated(catalog).animation!.speedParam;
  }),
  [],
  'legacy configs need no speed parameter',
);
for (const key of ['missing', 'isAnimated', 'trailLength']) {
  assert(
    animationErrors((catalog) => {
      animated(catalog).animation!.speedParam = key;
    }).length > 0,
    `reject invalid speed reference ${key}`,
  );
}
for (const value of [0, -1, NaN, Infinity, '2', true]) {
  assert(
    animationErrors((catalog) => {
      animated(catalog).parameters!.find((item) => item.key === 'animationSpeed')!.default = value;
    }).length > 0,
    `reject invalid default ${String(value)}`,
  );
  assert(
    animationErrors((catalog) => {
      animated(catalog).parameters!.find((item) => item.key === 'animationSpeed')!.options![0].value = value;
    }).length > 0,
    `reject invalid option ${String(value)}`,
  );
}
assert(
  animationErrors((catalog) => {
    animated(catalog).parameters!.find((item) => item.key === 'animationSpeed')!.default = 3;
  }).length > 0,
  'default must be an available speed',
);
assert(
  animationErrors((catalog) => {
    animated(catalog).parameters!.find((item) => item.key === 'animationSpeed')!.options = [];
  }).length > 0,
  'speed options cannot be empty',
);
console.log('Animation settings: optional speed contract and valid positive numeric presets passed.');
