import { getVisualizationDefaultParams, visualizationCatalog } from './catalog';
import { dataLoaderRegistry, mapStyleRegistry, resolveVisualizationShell, viewStateRegistry } from './registry';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function testDefaultShellUsesCatalogMetadataWithoutLoadingRows() {
  const visualization = visualizationCatalog.visualizations.find((candidate) => candidate.id === 'hexagon');
  assert(visualization, 'hexagon visualization must exist');
  const previousLoader = dataLoaderRegistry.csv;
  dataLoaderRegistry.csv = () => Promise.reject(new Error('shell must not load rows'));

  try {
    const shell = resolveVisualizationShell(visualizationCatalog, 'hexagon', {
      params: getVisualizationDefaultParams(visualization),
    });
    assert(shell.dataset.id === 'road-safety', 'default shell must select road-safety');
    assert(shell.dataset.title.includes('UK Road Safety'), 'shell must expose the initial title');
    assert(shell.primaryFile?.url === 'data/uk-road-safety.csv', 'shell must expose the primary file');
    assert(shell.mapStyle === mapStyleRegistry['carto.darkNoLabels'], 'shell must resolve map style');
    assert(shell.initialViewState.longitude === viewStateRegistry.ukHexagon.longitude, 'shell must use catalog view');
    assert(shell.cameraConstraints.maxPitch === 70, 'shell must expose the expanded hexagon pitch limit');
  } finally {
    dataLoaderRegistry.csv = previousLoader;
  }
}

function testDatasetSelectionChangesShellSynchronously() {
  const visualization = visualizationCatalog.visualizations.find((candidate) => candidate.id === 'hexagon');
  assert(visualization, 'hexagon visualization must exist');
  const shell = resolveVisualizationShell(visualizationCatalog, 'hexagon', {
    params: { ...getVisualizationDefaultParams(visualization), hexagonDataset: 'bike-parking' },
  });
  assert(shell.dataset.id === 'bike-parking', 'dataset parameter must select bike-parking');
  assert(shell.initialViewState.longitude === viewStateRegistry.sfBikeParking.longitude, 'dataset view must win');
}

function testUploadedShellDoesNotInspectRows() {
  const visualization = visualizationCatalog.visualizations.find((candidate) => candidate.id === 'hexagon');
  assert(visualization, 'hexagon visualization must exist');
  const baseDataset = visualizationCatalog.datasets.find((candidate) => candidate.id === 'road-safety');
  assert(baseDataset, 'road-safety dataset must exist');
  const override = {
    revision: 1,
    contentDigest: 'uploaded-v1',
    dataset: { ...baseDataset, id: 'upload:hexagon', title: 'uploaded.csv', initialViewState: undefined },
    get loadedFiles(): never {
      throw new Error('shell must not inspect uploaded rows');
    },
    sourceFileName: 'uploaded.csv',
    totalRowCount: 1,
    skippedRowCount: 0,
  };
  const shell = resolveVisualizationShell(visualizationCatalog, 'hexagon', {
    params: getVisualizationDefaultParams(visualization),
    datasetOverride: override,
  });
  assert(shell.dataset.title === 'uploaded.csv', 'shell must use uploaded metadata');
}

function testInvalidShellReferencesFailDeterministically() {
  const invalid = structuredClone(visualizationCatalog);
  invalid.visualizations[0].mapStyle = 'missing-style';
  let message = '';
  try {
    resolveVisualizationShell(invalid, 'hexagon', { params: {} });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes('Unknown map style'), 'unknown map style must fail deterministically');
}

function run() {
  testDefaultShellUsesCatalogMetadataWithoutLoadingRows();
  testDatasetSelectionChangesShellSynchronously();
  testUploadedShellDoesNotInspectRows();
  testInvalidShellReferencesFailDeterministically();
}

run();
