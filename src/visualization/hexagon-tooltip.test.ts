import assert from 'node:assert/strict';
import { WebMercatorViewport } from '@deck.gl/core';
import { tooltipRegistry } from './registry';

const projection = new WebMercatorViewport({ longitude: -2, latitude: 53, zoom: 7 });
const props = { radius: 0.01, hexOriginCommon: projection.projectFlat([-2, 53]) };
const layer = { getSubLayers: () => [{ props }] };
const object = { col: 0, row: 0, count: 12, position: [-177, -85] };
const tooltip = tooltipRegistry.hexagonCount({ object, layer } as unknown as Parameters<
  typeof tooltipRegistry.hexagonCount
>[0]);
assert.ok(
  tooltip?.includes('longitude: -2.000'),
  'tooltip uses the rendered shifted origin, not deck.gl picked position',
);
assert.ok(tooltip?.includes('latitude: 53.000'));
assert.ok(tooltip?.includes('12 Accidents'));
const unavailable = tooltipRegistry.hexagonCount({ object } as unknown as Parameters<
  typeof tooltipRegistry.hexagonCount
>[0]);
assert.ok(!unavailable?.includes('-177'), 'unavailable cell support must not display the known-wrong raw GPU position');
