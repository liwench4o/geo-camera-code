import assert from 'node:assert/strict';
import { WebMercatorViewport } from '@deck.gl/core';
import type { CustomObject } from '../interfaces';
import { getVisualizationDefaultParams, visualizationCatalog } from '../visualization/catalog';
import { resolveLayerDescriptor } from '../visualization/resolved-layer';
import type { ResolvedLayerRuntime } from '../visualization/types';
import { captureHeatmapTarget } from './heatmap-query';

const view = { longitude: 0, latitude: 0, zoom: 8, pitch: 25, bearing: 10 };
const viewport = { width: 1280, height: 720 };
const projection = new WebMercatorViewport({ ...view, ...viewport });
const queryPixel = projection.project([0, 0]);
function rowAt(id: string, offsetPx: number): CustomObject {
  const [longitude, latitude] = projection.unproject([queryPixel[0] + offsetPx, queryPixel[1]]);
  return { id, longitude, latitude, n_killed: 1, n_injured: 0 };
}
function runtime(rows: CustomObject[], radiusPixels: number, dataRevision = 'heat-data-1'): ResolvedLayerRuntime {
  const visualization = JSON.parse(
    JSON.stringify(visualizationCatalog.visualizations.find((item) => item.id === 'mix')),
  );
  const layer = visualization.layers.find((item: { id: string }) => item.id === 'heat');
  layer.props.radiusPixels = radiusPixels;
  const dataset = visualizationCatalog.datasets.find((item) => item.id === visualization.datasetId)!;
  const dataFile = dataset.files.find((item) => item.id === layer.dataRef)!;
  return {
    descriptor: resolveLayerDescriptor({
      catalogRevision: visualizationCatalog.revision,
      visualization,
      dataset,
      dataFile,
      dataRevision,
      layer,
      rowCount: rows.length,
      params: getVisualizationDefaultParams(visualization),
      state: { animationTime: 0 },
    }),
    data: rows,
  };
}

const rows = [rowAt('near', 15), rowAt('new-contributor', 35), rowAt('outside', 80)];
const initial = captureHeatmapTarget(undefined, runtime(rows, 20), [0, 0], view, viewport);
assert.equal(initial.status, 'ok', 'initial heatmap selection produces complete renderer evidence');
assert.equal(initial.value.selectedRows?.length, 1);
assert.equal(
  initial.value.selectedRows[0],
  rows[0],
  'selection retains actual renderer source objects, not table clones',
);
assert.deepEqual(initial.value.selectionAnchor, [0, 0], 'query anchor is stored independently of the target centroid');
assert.equal(initial.value.snapshotEnvelope!.frame.primitives.length, 1);

const enlarged = captureHeatmapTarget(initial.value, runtime(rows, 40), initial.value.selectionAnchor, view, viewport);
assert.equal(enlarged.status, 'ok', 'larger radius recomputes all current halo contributors');
assert.equal(enlarged.value.id, initial.value.id);
assert.equal(enlarged.value.snapshotEnvelope!.frame.primitives.length, 2);
assert.equal(enlarged.value.selectedRows![1], rows[1]);

const widenedView = captureHeatmapTarget(
  initial.value,
  runtime(rows, 20),
  initial.value.selectionAnchor,
  { ...view, zoom: 7 },
  viewport,
);
assert.equal(widenedView.status, 'ok', 'unchanged layer still resolves contributors in the current camera projection');
assert.equal(
  widenedView.value.selectedRows!.length,
  2,
  'zooming out includes new contributors inside the same pixel radius',
);

const newRows = [rowAt('near', 100), rowAt('replacement', 10)];
const changed = captureHeatmapTarget(
  enlarged.value,
  runtime(newRows, 40, 'heat-data-2'),
  enlarged.value.selectionAnchor!,
  view,
  viewport,
);
assert.equal(
  changed.status,
  'ok',
  'changed data re-executes the spatial query instead of retaining old stable-ID contributors',
);
assert.equal(changed.value.selectedRows![0], newRows[1]);
assert.equal(changed.value.selectedRows!.length, 1);
assert.equal(changed.value.snapshotEnvelope!.provenance.dataRevision, 'heat-data-2');
assert.deepEqual(changed.value.selectionAnchor, [0, 0]);
assert.equal(initial.value.selectedRows[0], rows[0], 'refresh never mutates the saved snapshot');

assert.equal(
  captureHeatmapTarget(undefined, runtime(rows, 40), [0, 0], view, viewport, { maxSourceRows: 2 }).status,
  'unavailable',
  'source-query budget never produces a partial successful halo',
);
assert.equal(
  captureHeatmapTarget(undefined, runtime(rows, 40), [0, 0], view, viewport, { maxContributors: 1 }).status,
  'unavailable',
  'contributor budget never produces a partial successful halo',
);
