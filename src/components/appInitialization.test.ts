import assert from 'node:assert/strict';
import { viewStateRegistry } from '../visualization/registry';
import type { VisualizationCatalog } from '../visualization/types';
import { createInitialAppVisualizationState } from './appInitialization';

const catalog: VisualizationCatalog = {
  revision: 'test',
  defaultVisualization: 'selected-view',
  datasets: [
    { revision: 'test', id: 'base-data', title: 'Base data', files: [] },
    {
      revision: 'test',
      id: 'selected-data',
      title: 'Selected dataset',
      initialViewState: 'columbusHexagon',
      primaryDataRef: 'primary',
      files: [
        { revision: 'test', id: 'secondary', url: '/fixtures/secondary.csv', format: 'csv' },
        { revision: 'test', id: 'primary', url: '/fixtures/selected.csv', format: 'csv' },
      ],
    },
  ],
  visualizations: [
    {
      revision: 'test',
      id: 'first-view',
      title: 'First view',
      datasetId: 'base-data',
      mapStyle: 'carto.dark',
      initialViewState: 'worldPoint',
      layers: [],
    },
    {
      revision: 'test',
      id: 'selected-view',
      title: 'Selected view',
      datasetId: 'base-data',
      datasetParam: 'dataset',
      mapStyle: 'carto.positron',
      initialViewState: 'worldPoint',
      layers: [],
      parameters: [
        {
          key: 'dataset',
          label: 'Dataset',
          control: 'select',
          default: 'selected-data',
          options: [
            { value: 'base-data', label: 'Base data' },
            { value: 'selected-data', label: 'Selected dataset' },
          ],
        },
      ],
    },
  ],
};
const initial = createInitialAppVisualizationState(catalog);
assert.equal(initial.activeVisualizationId, 'selected-view', 'catalog default wins over visualization order');
assert.deepEqual(initial.visualizationParams, {
  'first-view': { __mapStyle: 'carto.dark' },
  'selected-view': { __mapStyle: 'carto.positron', dataset: 'selected-data' },
});
assert.equal(initial.visDatasetName, 'selected-data', 'default dataset parameter selects the active dataset');
assert.equal(initial.visDatasetTitle, 'Selected dataset');
assert.equal(initial.visDatasetFileName, 'selected.csv', 'primary file selection wins over file order');
assert.deepEqual(initial.currentViewState, viewStateRegistry.columbusHexagon, 'selected dataset supplies its camera');
assert.notEqual(
  initial.currentViewState,
  viewStateRegistry.columbusHexagon,
  'initial camera is a separate editable view',
);

const alternate = createInitialAppVisualizationState({ ...catalog, defaultVisualization: 'first-view' });
assert.equal(alternate.activeVisualizationId, 'first-view', 'changing the catalog default changes initialization');
assert.equal(alternate.visDatasetName, 'base-data');
assert.equal(alternate.visDatasetFileName, '', 'datasets without files have no primary filename');
assert.deepEqual(
  alternate.currentViewState,
  viewStateRegistry.worldPoint,
  'visualization supplies its camera when the dataset has no override',
);
