import assert from 'node:assert/strict';
import { getTripTimedPath } from './trip-data';
import { getAccessorById, layerRegistry } from './registry';
import { resolveCurrentTargetRows } from '../camera/renderer-target';
import { createPathTarget } from '../camera/selection';
import type { ResolvedLayerRuntime, LayerConfig, VisualizationRuntimeContext } from './types';

const row = {
  path: [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
  ],
  timestamps: [10, 20, 20, 30],
};
const snapshot = getTripTimedPath(row)!;
assert.deepEqual(snapshot.coordinates, [
  [0, 0],
  [2, 0],
  [3, 0],
]);
assert.equal(getTripTimedPath(row), snapshot, 'normalization is cached per immutable source row');
assert.deepEqual(getAccessorById('tripPath')!(row), snapshot.coordinates, 'renderer geometry matches camera');
assert.deepEqual(getAccessorById('tripTimestamps')!(row), snapshot.timestamps, 'renderer times match camera');
const target = { ...createPathTarget(snapshot.coordinates, [row])!, timedPath: snapshot };
assert.deepEqual(
  resolveCurrentTargetRows(target, [
    { ...row },
    {
      path: [
        [0, 0],
        [1, 0],
      ],
      timestamps: [0, 1],
    },
  ]),
  [row],
  'digest identifies trips without source ids',
);
const runtime = {
  data: [row],
  descriptor: {
    resolvedProps: { currentTime: 10, trailLength: 180 },
    accessorIds: { getPath: 'tripPath', getTimestamps: 'tripTimestamps' },
    resolvedSupport: { producer: 'trip-path', width: { value: 1, unit: 'pixels' }, widthScale: 1, widthMinPixels: 2 },
  },
} as unknown as ResolvedLayerRuntime;
const config = { id: 'trips', type: 'TripsLayer' } as LayerConfig;
const context = { layerRenderOptions: { animationTime: 1900, interactive: false } } as VisualizationRuntimeContext;
const layer = layerRegistry.TripsLayer(runtime, config, context);
assert.equal(layer.props.currentTime, 1900, 'synchronous frame time bypasses old resolved time');
assert.equal(layer.props.trailLength, 180, 'time override keeps trail independent');
console.log('trip renderer, source identity and synchronous time tests passed');
