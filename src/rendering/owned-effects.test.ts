import assert from 'node:assert/strict';
import { AmbientLight, DirectionalLight, LightingEffect, PointLight, type Effect } from '@deck.gl/core';
import { createOwnedEffects } from './owned-effects';

const original = new LightingEffect({
  ambient: new AmbientLight({ color: [10, 20, 30], intensity: 0.5 }),
  point: new PointLight({ color: [40, 50, 60], position: [1, 2, 3], attenuation: [1, 2, 3] }),
  directional: new DirectionalLight({ direction: [1, 2, -3], _shadow: true }),
});
original.shadowColor = [0.1, 0.2, 0.3, 0.4];
const [a] = createOwnedEffects([original]) as LightingEffect[];
const [b] = createOwnedEffects([original]) as LightingEffect[];
assert.notEqual(a, original, 'A pane cannot borrow the main Deck effect GPU owner.');
assert.notEqual(a, b, 'Each simultaneous pane must own its own effect instance.');
for (const name of Object.keys(original.props)) {
  assert.notEqual(a.props[name], original.props[name], 'Owned lights cannot alias registry descriptor objects.');
  assert.notEqual(a.props[name], b.props[name], 'Lights belong to one pane.');
  assert.deepEqual(a.props[name].color, original.props[name].color);
  assert.notEqual(a.props[name].color, original.props[name].color);
}
assert.deepEqual(a.shadowColor, original.shadowColor);
assert.notEqual(a.shadowColor, original.shadowColor);
const originalPoint = original.props.point as PointLight;
const ownedPoint = a.props.point as PointLight;
assert.deepEqual(ownedPoint.position, originalPoint.position);
assert.notEqual(ownedPoint.position, originalPoint.position);
assert.deepEqual(ownedPoint.attenuation, originalPoint.attenuation);
assert.notEqual(ownedPoint.attenuation, originalPoint.attenuation);
const originalDirection = original.props.directional as DirectionalLight;
const ownedDirection = a.props.directional as DirectionalLight;
assert.deepEqual(ownedDirection.direction, originalDirection.direction);
assert.notEqual(ownedDirection.direction, originalDirection.direction);
assert.equal(ownedDirection.shadow, originalDirection.shadow);
a.props.ambient.color[0] = 255;
assert.equal(original.props.ambient.color[0], 10, 'Mutating A cannot change the main effect.');
assert.equal(b.props.ambient.color[0], 10, 'Mutating A cannot change B.');
assert.throws(
  () => createOwnedEffects([{ id: 'unsupported' } as Effect]),
  /Cannot safely clone/,
  'Unknown GPU effects fail closed instead of sharing ownership.',
);
console.log('Independent pane effects preserve descriptors without sharing effect, light, or vector ownership.');
