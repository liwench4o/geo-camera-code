import { getVisualizationDefaultParams, visualizationCatalog } from './catalog';
import {
  createUploadedDatasetOverride,
  dataLoaderRegistry,
  getActiveDatasetId,
  mapStyleRegistry,
  resolveVisualizationRuntime,
  validateVisualizationCatalog,
  viewStateRegistry,
} from './registry';
import {
  VISUALIZATION_MAP_STYLE_PARAM_KEY,
  type VisualizationCatalog,
  type VisualizationRuntimeContext,
} from './types';
import {
  applyResolvedVisualizationParams,
  getAdaptiveVisualizationParameterKeys,
  getManualVisualizationParameterKeys,
  updateManualVisualizationParameterKey,
} from './parameter-state';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function expectThrows(run: () => unknown, expectedMessage: string) {
  try {
    run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes(expectedMessage), `expected error containing "${expectedMessage}", received "${message}"`);
    return;
  }
  throw new Error(`expected error containing "${expectedMessage}"`);
}

async function expectRejects(run: () => Promise<unknown>, expectedMessage: string, expectedName?: string) {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes(expectedMessage), `expected error containing "${expectedMessage}", received "${message}"`);
    if (expectedName) {
      assert(
        error instanceof Error && error.name === expectedName,
        `expected ${expectedName}, received ${String(error)}`,
      );
    }
    return;
  }
  throw new Error(`expected rejection containing "${expectedMessage}"`);
}

function testDefaultParamsIncludeMapStyle() {
  const params = getVisualizationDefaultParams({
    revision: 'sample-v1',
    id: 'sample',
    title: 'Sample',
    datasetId: 'dataset',
    mapStyle: 'carto.darkNoLabels',
    initialViewState: 'worldPoint',
    layers: [],
    parameters: [
      {
        key: 'radius',
        label: 'Radius',
        control: 'slider',
        default: 30,
        min: 1,
        max: 50,
        step: 1,
      },
    ],
  });

  assert(
    params[VISUALIZATION_MAP_STYLE_PARAM_KEY] === 'carto.darkNoLabels',
    'default visualization params should include the visualization map style',
  );
  assert(params.radius === 30, 'default visualization params should preserve catalog parameters');
}

function testHexagonCatalogDefaultsMatchTheDeckGlReference() {
  const visualization = visualizationCatalog.visualizations.find((candidate) => candidate.id === 'hexagon');
  assert(Boolean(visualization), 'hexagon visualization should exist');
  const params = getVisualizationDefaultParams(visualization!);

  assert(params.hexagonRadius === 1000, 'hexagon catalog radius should match the deck.gl example default');
  assert(params.hexagonCoverage === 1, 'hexagon catalog coverage should match the deck.gl example default');
  assert(params.hexagonUpperPercentile === 100, 'hexagon upper percentile should match the deck.gl example default');
}

function testManualVisualizationParameterProvenance() {
  const empty = {};
  const withRadius = updateManualVisualizationParameterKey(empty, 'hexagon', 'hexagonRadius', true);
  const withCoverage = updateManualVisualizationParameterKey(withRadius, 'hexagon', 'hexagonCoverage', true);

  assert(
    getManualVisualizationParameterKeys(withCoverage, 'hexagon').join(',') === 'hexagonCoverage,hexagonRadius',
    'manual parameter keys should be unique and deterministic',
  );

  const resetRadius = updateManualVisualizationParameterKey(withCoverage, 'hexagon', 'hexagonRadius', false);
  assert(
    getManualVisualizationParameterKeys(resetRadius, 'hexagon').join(',') === 'hexagonCoverage',
    'restoring auto mode should remove only the requested manual key',
  );
}

function testResolvedVisualizationParamsDoNotChangeManualProvenance() {
  const paramsById = {
    hexagon: {
      hexagonDataset: 'road-safety',
      hexagonRadius: 1500,
      hexagonCoverage: 0.8,
    },
  };
  const next = applyResolvedVisualizationParams(paramsById, 'hexagon', {
    hexagonDataset: 'road-safety',
    hexagonRadius: 1000,
    hexagonCoverage: 1,
  });

  assert(next !== paramsById, 'a changed effective snapshot should create new parameter state');
  assert(next.hexagon.hexagonRadius === 1000, 'effective radius should update displayed parameters');
  assert(next.hexagon.hexagonCoverage === 1, 'effective coverage should update displayed parameters');
  assert(
    applyResolvedVisualizationParams(next, 'hexagon', next.hexagon) === next,
    'an equal effective snapshot should preserve state identity and prevent update loops',
  );
}

function testAdaptiveVisualizationParameterKeysComeFromTheHexagonContract() {
  const hexagon = visualizationCatalog.visualizations.find((visualization) => visualization.id === 'hexagon');
  const mix = visualizationCatalog.visualizations.find((visualization) => visualization.id === 'mix');
  assert(Boolean(hexagon), 'hexagon visualization should exist');
  assert(Boolean(mix), 'mix visualization should exist');

  assert(
    getAdaptiveVisualizationParameterKeys(hexagon!).join(',') ===
      'hexagonCoverage,hexagonRadius,hexagonUpperPercentile',
    'adaptive parameter keys should follow the declared hexagon layer parameter bindings',
  );
  assert(
    getAdaptiveVisualizationParameterKeys(mix!).length === 0,
    'visualizations without adaptive hexagon analytics should not expose auto controls',
  );
}

async function testRuntimeUsesSelectedMapStyleParam() {
  const previousJsonLoader = dataLoaderRegistry.json;
  dataLoaderRegistry.json = () => Promise.resolve([]);

  const catalog: VisualizationCatalog = {
    revision: 'catalog-v1',
    defaultVisualization: 'sample',
    datasets: [
      {
        revision: 'dataset-v1',
        id: 'dataset',
        title: 'Dataset',
        files: [{ revision: 'rows-v1', id: 'rows', url: 'unused.json', format: 'json' }],
        primaryDataRef: 'rows',
      },
    ],
    visualizations: [
      {
        revision: 'sample-v1',
        id: 'sample',
        title: 'Sample',
        datasetId: 'dataset',
        mapStyle: 'carto.darkNoLabels',
        initialViewState: 'worldPoint',
        layers: [],
        parameters: [],
      },
    ],
  };

  try {
    const runtime = await resolveVisualizationRuntime(catalog, 'sample', {
      params: {
        [VISUALIZATION_MAP_STYLE_PARAM_KEY]: 'carto.positron',
      },
      state: {},
      clickHandlers: {},
    });

    assert(
      runtime.mapStyle === mapStyleRegistry['carto.positron'],
      'runtime should use the selected map style parameter when it is registered',
    );
  } finally {
    dataLoaderRegistry.json = previousJsonLoader;
  }
}

function testGetActiveDatasetIdHonorsDatasetParam() {
  const visualization = {
    revision: 'sample-v1',
    id: 'sample',
    title: 'Sample',
    datasetId: 'default-dataset',
    datasetParam: 'pickedDataset',
    mapStyle: 'carto.darkNoLabels',
    initialViewState: 'worldPoint',
    layers: [],
    parameters: [
      {
        key: 'pickedDataset',
        label: 'Dataset',
        control: 'select' as const,
        default: 'default-dataset',
        options: [
          { label: 'Default', value: 'default-dataset' },
          { label: 'Alternate', value: 'alternate-dataset' },
        ],
      },
    ],
  };

  assert(
    getActiveDatasetId(visualization, { pickedDataset: 'alternate-dataset' }) === 'alternate-dataset',
    'getActiveDatasetId should prefer the dataset selected via datasetParam',
  );
  assert(
    getActiveDatasetId(visualization, {}) === 'default-dataset',
    'getActiveDatasetId should fall back to the visualization datasetId when the param is missing',
  );
  assert(
    getActiveDatasetId({ ...visualization, datasetParam: undefined }, { pickedDataset: 'alternate-dataset' }) ===
      'default-dataset',
    'getActiveDatasetId should ignore params when datasetParam is not configured',
  );
  expectThrows(() => getActiveDatasetId(visualization, { pickedDataset: 'not-allowed' }), 'not an allowed dataset');
}

async function testRuntimeSwitchesDatasetViaDatasetParam() {
  const previousJsonLoader = dataLoaderRegistry.json;
  const loadedUrls: string[] = [];
  dataLoaderRegistry.json = (file) => {
    loadedUrls.push(file.url);
    return Promise.resolve([]);
  };

  const catalog: VisualizationCatalog = {
    revision: 'catalog-v1',
    defaultVisualization: 'sample',
    datasets: [
      {
        revision: 'primary-v1',
        id: 'primary',
        title: 'Primary',
        files: [{ revision: 'primary-rows-v1', id: 'rows', url: 'primary.json', format: 'json' }],
        primaryDataRef: 'rows',
      },
      {
        revision: 'secondary-v1',
        id: 'secondary',
        title: 'Secondary',
        files: [{ revision: 'secondary-rows-v1', id: 'rows', url: 'secondary.json', format: 'json' }],
        primaryDataRef: 'rows',
        initialViewState: 'usMix',
      },
    ],
    visualizations: [
      {
        revision: 'sample-v1',
        id: 'sample',
        title: 'Sample',
        datasetId: 'primary',
        datasetParam: 'pickedDataset',
        mapStyle: 'carto.darkNoLabels',
        initialViewState: 'worldPoint',
        layers: [],
        parameters: [
          {
            key: 'pickedDataset',
            label: 'Dataset',
            control: 'select',
            default: 'primary',
            options: [
              { label: 'Primary', value: 'primary' },
              { label: 'Secondary', value: 'secondary' },
            ],
          },
        ],
      },
    ],
  };

  try {
    const runtime = await resolveVisualizationRuntime(catalog, 'sample', {
      params: { pickedDataset: 'secondary' },
      state: {},
      clickHandlers: {},
    });

    assert(runtime.dataset.id === 'secondary', 'runtime should resolve the dataset selected via datasetParam');
    assert(
      runtime.primaryFile?.url === 'secondary.json',
      'runtime primary file should follow the dataset selected via datasetParam',
    );
    assert(
      runtime.initialViewState.longitude === viewStateRegistry.usMix.longitude,
      'runtime should use the dataset-level initial view state when present',
    );
    assert(
      loadedUrls.includes('secondary.json'),
      'runtime should fetch the file from the dataset selected via datasetParam',
    );
  } finally {
    dataLoaderRegistry.json = previousJsonLoader;
  }
}

async function testRuntimeUsesDatasetParameterDefaultAndRejectsUnknownDatasets() {
  const previousJsonLoader = dataLoaderRegistry.json;
  dataLoaderRegistry.json = () => Promise.resolve([]);
  const catalog: VisualizationCatalog = {
    revision: 'catalog-v1',
    defaultVisualization: 'sample',
    datasets: [
      {
        revision: 'base-v1',
        id: 'base',
        title: 'Base',
        files: [{ revision: 'base-rows-v1', id: 'rows', url: 'base.json', format: 'json' }],
        primaryDataRef: 'rows',
      },
      {
        revision: 'default-v1',
        id: 'default-selection',
        title: 'Default selection',
        files: [{ revision: 'default-rows-v1', id: 'rows', url: 'default.json', format: 'json' }],
        primaryDataRef: 'rows',
      },
      {
        revision: 'known-v1',
        id: 'known-but-not-allowed',
        title: 'Known but not allowed',
        files: [{ revision: 'known-rows-v1', id: 'rows', url: 'known.json', format: 'json' }],
        primaryDataRef: 'rows',
      },
    ],
    visualizations: [
      {
        revision: 'sample-v1',
        id: 'sample',
        title: 'Sample',
        datasetId: 'base',
        datasetParam: 'pickedDataset',
        mapStyle: 'carto.darkNoLabels',
        initialViewState: 'worldPoint',
        layers: [],
        parameters: [
          {
            key: 'pickedDataset',
            label: 'Dataset',
            control: 'select',
            default: 'default-selection',
            options: [{ label: 'Default selection', value: 'default-selection' }],
          },
        ],
      },
    ],
  };

  try {
    const runtime = await resolveVisualizationRuntime(catalog, 'sample', {
      params: {},
      state: {},
      clickHandlers: {},
    });
    assert(runtime.dataset.id === 'default-selection', 'missing runtime param must use the declared dataset default');

    await expectRejects(
      () =>
        resolveVisualizationRuntime(catalog, 'sample', {
          params: { pickedDataset: 'known-but-not-allowed' },
          state: {},
          clickHandlers: {},
        }),
      'not an allowed dataset',
    );

    const catalogWithUnknownAllowedDataset: VisualizationCatalog = {
      ...catalog,
      visualizations: [
        {
          ...catalog.visualizations[0],
          parameters: [
            {
              key: 'pickedDataset',
              label: 'Dataset',
              control: 'select',
              default: 'default-selection',
              options: [
                { label: 'Default selection', value: 'default-selection' },
                { label: 'Ghost', value: 'ghost' },
              ],
            },
          ],
        },
      ],
    };
    await expectRejects(
      () =>
        resolveVisualizationRuntime(catalogWithUnknownAllowedDataset, 'sample', {
          params: { pickedDataset: 'ghost' },
          state: {},
          clickHandlers: {},
        }),
      'missing dataset "ghost"',
    );

    const uploadCatalog: VisualizationCatalog = {
      ...catalogWithUnknownAllowedDataset,
      defaultVisualization: 'hexagon',
      visualizations: [{ ...catalogWithUnknownAllowedDataset.visualizations[0], id: 'hexagon' }],
    };
    await expectRejects(
      () =>
        createUploadedDatasetOverride(
          uploadCatalog,
          'hexagon',
          { pickedDataset: 'ghost' },
          new File(['longitude,latitude\n0,0'], 'points.csv', { type: 'text/csv' }),
          1,
        ),
      'missing dataset "ghost"',
    );
  } finally {
    dataLoaderRegistry.json = previousJsonLoader;
  }
}

async function testRuntimeDescriptorsUseTheDatasetParameterDefault() {
  const previousJsonLoader = dataLoaderRegistry.json;
  dataLoaderRegistry.json = () => Promise.resolve([{ COORDINATES: [-122.4, 37.8] }]);
  const hexagon = visualizationCatalog.visualizations.find((candidate) => candidate.id === 'hexagon');
  assert(Boolean(hexagon), 'hexagon visualization must exist');
  const catalog: VisualizationCatalog = {
    ...visualizationCatalog,
    visualizations: visualizationCatalog.visualizations.map((visualization) =>
      visualization.id === 'hexagon'
        ? {
            ...visualization,
            parameters: visualization.parameters?.map((parameter) =>
              parameter.key === visualization.datasetParam ? { ...parameter, default: 'bike-parking' } : parameter,
            ),
          }
        : visualization,
    ),
  };
  const params = getVisualizationDefaultParams(catalog.visualizations.find((candidate) => candidate.id === 'hexagon')!);
  delete params.hexagonDataset;

  try {
    const runtime = await resolveVisualizationRuntime(catalog, 'hexagon', {
      params,
      state: {},
      clickHandlers: { hexagonPosition: () => true },
    });
    assert(runtime.dataset.id === 'bike-parking', 'descriptor runtime must retain the dataset parameter default');
    assert(
      runtime.resolvedLayers[0]?.descriptor.datasetId === 'bike-parking',
      'resolved descriptor must retain the default-selected dataset identity',
    );
  } finally {
    dataLoaderRegistry.json = previousJsonLoader;
  }
}

async function testDataCacheSeparatesRevisedFilesWithStableIds() {
  const previousJsonLoader = dataLoaderRegistry.json;
  const loadedUrls: string[] = [];
  dataLoaderRegistry.json = (file) => {
    loadedUrls.push(file.url);
    return Promise.resolve([{ sourceUrl: file.url }]);
  };

  const makeCatalog = (datasetRevision: string, fileRevision: string, url: string): VisualizationCatalog => ({
    revision: `catalog-${datasetRevision}`,
    defaultVisualization: 'cache-revision-visualization',
    datasets: [
      {
        revision: datasetRevision,
        id: 'cache-revision-dataset',
        title: 'Cache revision dataset',
        files: [{ revision: fileRevision, id: 'rows', url, format: 'json' }],
        primaryDataRef: 'rows',
      },
    ],
    visualizations: [
      {
        revision: 'cache-revision-visualization-v1',
        id: 'cache-revision-visualization',
        title: 'Cache revision visualization',
        datasetId: 'cache-revision-dataset',
        mapStyle: 'carto.darkNoLabels',
        initialViewState: 'worldPoint',
        layers: [],
      },
    ],
  });

  try {
    const first = await resolveVisualizationRuntime(
      makeCatalog('dataset-v1', 'rows-v1', 'cache-revision-first.json'),
      'cache-revision-visualization',
      { params: {}, state: {}, clickHandlers: {} },
    );
    const datasetRevised = await resolveVisualizationRuntime(
      makeCatalog('dataset-v2', 'rows-v1', 'cache-revision-first.json'),
      'cache-revision-visualization',
      { params: {}, state: {}, clickHandlers: {} },
    );
    const fileRevised = await resolveVisualizationRuntime(
      makeCatalog('dataset-v2', 'rows-v2', 'cache-revision-first.json'),
      'cache-revision-visualization',
      { params: {}, state: {}, clickHandlers: {} },
    );
    const urlRevised = await resolveVisualizationRuntime(
      makeCatalog('dataset-v2', 'rows-v2', 'cache-revision-second.json'),
      'cache-revision-visualization',
      { params: {}, state: {}, clickHandlers: {} },
    );

    assert(first.primaryData[0]?.sourceUrl === 'cache-revision-first.json', 'first catalog must load its own rows');
    assert(
      datasetRevised.primaryData[0]?.sourceUrl === 'cache-revision-first.json',
      'dataset revision must reload rows',
    );
    assert(fileRevised.primaryData[0]?.sourceUrl === 'cache-revision-first.json', 'file revision must reload rows');
    assert(urlRevised.primaryData[0]?.sourceUrl === 'cache-revision-second.json', 'URL revision must reload rows');
    assert(
      loadedUrls.join(',') ===
        [
          'cache-revision-first.json',
          'cache-revision-first.json',
          'cache-revision-first.json',
          'cache-revision-second.json',
        ].join(','),
      'stable dataset/file IDs must not reuse data across dataset revision, file revision, or URL changes',
    );
  } finally {
    dataLoaderRegistry.json = previousJsonLoader;
  }
}

function makeCacheCatalog(key: string): VisualizationCatalog {
  return {
    revision: `cache-catalog-${key}`,
    defaultVisualization: `cache-visualization-${key}`,
    datasets: [
      {
        revision: `cache-dataset-${key}`,
        id: `cache-dataset-${key}`,
        title: `Cache dataset ${key}`,
        files: [{ revision: `cache-file-${key}`, id: 'rows', url: `cache-${key}.json`, format: 'json' }],
        primaryDataRef: 'rows',
      },
    ],
    visualizations: [
      {
        revision: `cache-visualization-${key}`,
        id: `cache-visualization-${key}`,
        title: `Cache visualization ${key}`,
        datasetId: `cache-dataset-${key}`,
        mapStyle: 'carto.darkNoLabels',
        initialViewState: 'worldPoint',
        layers: [],
      },
    ],
  };
}

async function testDataCacheEvictsRejectedPromisesAndKeepsSingleFlight() {
  const previousJsonLoader = dataLoaderRegistry.json;
  let rejectionCalls = 0;
  const rejectionCatalog = makeCacheCatalog('rejection');
  dataLoaderRegistry.json = () => {
    rejectionCalls += 1;
    return rejectionCalls === 1
      ? Promise.reject(new Error('planned cache failure'))
      : Promise.resolve([{ source: 'retry-success' }]);
  };
  try {
    await expectRejects(
      () =>
        resolveVisualizationRuntime(rejectionCatalog, 'cache-visualization-rejection', {
          params: {},
          state: {},
          clickHandlers: {},
        }),
      'planned cache failure',
    );
    const retry = await resolveVisualizationRuntime(rejectionCatalog, 'cache-visualization-rejection', {
      params: {},
      state: {},
      clickHandlers: {},
    });
    assert(rejectionCalls === 2, 'a rejected cache entry must be evicted before retry');
    assert(retry.primaryData[0]?.source === 'retry-success', 'retry must publish the successful immutable rows');
    assert(
      Object.isFrozen(retry.primaryData) && Object.isFrozen(retry.primaryData[0]),
      'bundled loader results must be published as an owned immutable snapshot',
    );
  } finally {
    dataLoaderRegistry.json = previousJsonLoader;
  }

  let singleFlightCalls = 0;
  let resolveRows: ((rows: Array<{ source: string }>) => void) | undefined;
  const pendingRows = new Promise<Array<{ source: string }>>((resolve) => {
    resolveRows = resolve;
  });
  const singleFlightCatalog = makeCacheCatalog('single-flight');
  dataLoaderRegistry.json = () => {
    singleFlightCalls += 1;
    return pendingRows;
  };
  try {
    const context = { params: {}, state: {}, clickHandlers: {} };
    const first = resolveVisualizationRuntime(singleFlightCatalog, 'cache-visualization-single-flight', context);
    const second = resolveVisualizationRuntime(singleFlightCatalog, 'cache-visualization-single-flight', context);
    await Promise.resolve();
    assert(singleFlightCalls === 1, 'concurrent cache misses must invoke the loader exactly once');
    resolveRows?.([{ source: 'single-flight' }]);
    const [firstRuntime, secondRuntime] = await Promise.all([first, second]);
    assert(
      firstRuntime.primaryData === secondRuntime.primaryData,
      'single-flight callers must receive one shared immutable row snapshot',
    );
    assert(Object.isFrozen(firstRuntime.primaryData), 'single-flight cache result must remain immutable');
  } finally {
    dataLoaderRegistry.json = previousJsonLoader;
  }
}

async function testDataCacheUsesABoundedLru() {
  const previousJsonLoader = dataLoaderRegistry.json;
  let loaderCalls = 0;
  dataLoaderRegistry.json = (file) => {
    loaderCalls += 1;
    return Promise.resolve([{ source: file.url }]);
  };
  try {
    for (let index = 0; index < 40; index += 1) {
      const key = `bounded-${index}`;
      await resolveVisualizationRuntime(makeCacheCatalog(key), `cache-visualization-${key}`, {
        params: {},
        state: {},
        clickHandlers: {},
      });
    }
    await resolveVisualizationRuntime(makeCacheCatalog('bounded-0'), 'cache-visualization-bounded-0', {
      params: {},
      state: {},
      clickHandlers: {},
    });
    assert(loaderCalls === 41, 'bounded LRU cache must evict the oldest revision entry');

    let inFlightCalls = 0;
    const pendingResolvers = new Map<string, (rows: Array<{ source: string }>) => void>();
    dataLoaderRegistry.json = (file) => {
      inFlightCalls += 1;
      return new Promise((resolve) => pendingResolvers.set(file.url, resolve));
    };
    const inFlight = Array.from({ length: 33 }, (_, index) => {
      const key = `in-flight-${index}`;
      return resolveVisualizationRuntime(makeCacheCatalog(key), `cache-visualization-${key}`, {
        params: {},
        state: {},
        clickHandlers: {},
      });
    });
    await Promise.resolve();
    await Promise.resolve();
    const repeatedOldest = resolveVisualizationRuntime(
      makeCacheCatalog('in-flight-0'),
      'cache-visualization-in-flight-0',
      { params: {}, state: {}, clickHandlers: {} },
    );
    await Promise.resolve();
    assert(inFlightCalls === 33, 'capacity pressure must never evict an in-flight single-flight entry');
    for (const [url, resolve] of pendingResolvers) resolve([{ source: url }]);
    await Promise.all([...inFlight, repeatedOldest]);

    let saturationCalls = 0;
    const saturationResolvers = new Map<string, (rows: Array<{ source: string }>) => void>();
    dataLoaderRegistry.json = (file) => {
      saturationCalls += 1;
      if (saturationCalls > 64) return Promise.reject(new Error('saturation loader must not be invoked'));
      return new Promise((resolve) => saturationResolvers.set(file.url, resolve));
    };
    const saturated = Array.from({ length: 64 }, (_, index) => {
      const key = `saturation-${index}`;
      return resolveVisualizationRuntime(makeCacheCatalog(key), `cache-visualization-${key}`, {
        params: {},
        state: {},
        clickHandlers: {},
      });
    });
    await Promise.resolve();
    await Promise.resolve();
    const sameKeyAtCapacity = resolveVisualizationRuntime(
      makeCacheCatalog('saturation-0'),
      'cache-visualization-saturation-0',
      { params: {}, state: {}, clickHandlers: {} },
    );
    await expectRejects(
      () =>
        resolveVisualizationRuntime(
          makeCacheCatalog('saturation-overflow'),
          'cache-visualization-saturation-overflow',
          {
            params: {},
            state: {},
            clickHandlers: {},
          },
        ),
      'Async cache is saturated at 64 entries.',
      'AsyncCacheSaturatedError',
    );
    assert(saturationCalls === 64, 'saturation must reject a new key without invoking its loader');
    for (const [url, resolve] of saturationResolvers) resolve([{ source: url }]);
    await Promise.all([...saturated, sameKeyAtCapacity]);
  } finally {
    dataLoaderRegistry.json = previousJsonLoader;
  }
}

async function testBundledSnapshotPreservesOwnProtoDataWithoutPrototypePollution() {
  const previousJsonLoader = dataLoaderRegistry.json;
  const catalog = makeCacheCatalog('proto-snapshot');
  dataLoaderRegistry.json = () =>
    Promise.resolve(JSON.parse('[{"source":"bundled","__proto__":{"geometry":[[88,88]]}}]'));
  try {
    const runtime = await resolveVisualizationRuntime(catalog, 'cache-visualization-proto-snapshot', {
      params: {},
      state: {},
      clickHandlers: {},
    });
    const row = runtime.primaryData[0];
    assert(Object.prototype.hasOwnProperty.call(row, '__proto__'), 'bundled __proto__ must remain own data');
    assert(Object.getPrototypeOf(row) === Object.prototype, 'bundled __proto__ must not replace prototype');
    assert(row.geometry === undefined, 'inherited geometry from bundled __proto__ data must not be readable');
  } finally {
    dataLoaderRegistry.json = previousJsonLoader;
  }
}

function testValidationFlagsUnknownDatasetParamOptions() {
  const catalog: VisualizationCatalog = {
    revision: 'catalog-v1',
    defaultVisualization: 'sample',
    datasets: [
      {
        revision: 'primary-v1',
        id: 'primary',
        title: 'Primary',
        files: [{ revision: 'primary-rows-v1', id: 'rows', url: 'primary.json', format: 'json' }],
        primaryDataRef: 'rows',
      },
    ],
    visualizations: [
      {
        revision: 'sample-v1',
        id: 'sample',
        title: 'Sample',
        datasetId: 'primary',
        datasetParam: 'pickedDataset',
        mapStyle: 'carto.darkNoLabels',
        initialViewState: 'worldPoint',
        layers: [],
        parameters: [
          {
            key: 'pickedDataset',
            label: 'Dataset',
            control: 'select',
            default: 'primary',
            options: [
              { label: 'Primary', value: 'primary' },
              { label: 'Ghost', value: 'ghost' },
            ],
          },
        ],
      },
    ],
  };

  const errors = validateVisualizationCatalog(catalog);
  assert(
    errors.some((error) => error.includes('"ghost"')),
    'validation should report dataset parameter options that reference unknown datasets',
  );
}

async function testRuntimeCreateLayersReturnsIsolatedPreviewLayers() {
  const previousJsonLoader = dataLoaderRegistry.json;
  dataLoaderRegistry.json = () => Promise.resolve([{ longitude: -1, latitude: 52 }]);
  let clickCount = 0;

  const catalog: VisualizationCatalog = {
    revision: 'catalog-v1',
    defaultVisualization: 'sample',
    datasets: [
      {
        revision: 'dataset-v1',
        id: 'dataset',
        title: 'Dataset',
        files: [{ revision: 'rows-v1', id: 'rows', url: 'rows.json', format: 'json' }],
        primaryDataRef: 'rows',
      },
    ],
    visualizations: [
      {
        revision: 'sample-v1',
        id: 'sample',
        title: 'Sample',
        datasetId: 'dataset',
        mapStyle: 'carto.darkNoLabels',
        initialViewState: 'worldPoint',
        layers: [
          {
            id: 'preview-points',
            type: 'ScatterplotLayer',
            dataRef: 'rows',
            rendererVersion: 1,
            selection: { supported: ['click'], coordinateAccessor: 'lonLat' },
            cameraEnvelope: {
              producer: 'scatter-point',
              producerVersion: 1,
              positionAccessor: 'lonLat',
              radius: { prop: 'getRadius', unitProp: 'radiusUnits', scaleProp: 'radiusScale' },
              minPixelsProp: 'radiusMinPixels',
              maxPixelsProp: 'radiusMaxPixels',
              support: { antialiasBufferPx: 2 },
              capabilities: {
                supportsLive: false,
                supportsPrediction: false,
                maxPredictionHorizonMs: 0,
                nominalUpdateHz: 1,
                frameEvolution: 'revision-step',
              },
            },
            cameraCalibration: {
              version: 1,
              referenceZoom: 8,
              referenceSafeAreaPx: 921600,
              metrics: {
                elevation: { unit: 'meters', lo: 10, hi: 10000, source: 'global-fallback-v1' },
                density: { unit: 'count/km2', lo: 1, hi: 1000, source: 'global-fallback-v1' },
                aspect: { unit: 'ratio', lo: 1, hi: 8, source: 'catalog-v1' },
              },
            },
            onClick: 'points',
            props: {
              getRadius: 1,
              radiusUnits: 'meters',
              radiusScale: 1,
              radiusMinPixels: 2,
              billboard: true,
            },
            accessors: { getPosition: 'lonLat' },
          },
        ],
        parameters: [],
      },
    ],
  };

  try {
    const runtime = await resolveVisualizationRuntime(catalog, 'sample', {
      params: {},
      state: {},
      clickHandlers: {
        points: () => {
          clickCount += 1;
          return true;
        },
      },
    });

    const firstPreviewLayers = runtime.createLayers({
      idPrefix: 'view-state-initial-',
      interactive: false,
      transitions: false,
    });
    const secondPreviewLayers = runtime.createLayers({
      idPrefix: 'view-state-final-',
      interactive: false,
      transitions: false,
    });

    assert(firstPreviewLayers[0] !== secondPreviewLayers[0], 'preview layer calls should create fresh layer instances');
    assert(
      firstPreviewLayers[0].id === 'view-state-initial-preview-points',
      'initial preview layer id should include the requested prefix',
    );
    assert(
      secondPreviewLayers[0].id === 'view-state-final-preview-points',
      'final preview layer id should include the requested prefix',
    );
    assert(firstPreviewLayers[0].props.pickable === false, 'non-interactive preview layer should not be pickable');
    assert(
      firstPreviewLayers[0].props.onClick === undefined,
      'non-interactive preview layer should not carry a click handler',
    );
    assert(firstPreviewLayers[0].props.transitions == null, 'preview layer transitions should be disabled');
    assert(clickCount === 0, 'preview layer creation should not invoke click handlers');

    const withClickHandlerName = (onClick: string): VisualizationCatalog => ({
      ...catalog,
      revision: `${catalog.revision}-${onClick}`,
      visualizations: [
        {
          ...catalog.visualizations[0],
          layers: [{ ...catalog.visualizations[0].layers[0], onClick }],
        },
      ],
    });
    for (const inheritedName of ['toString', 'constructor', '__proto__']) {
      await expectRejects(
        () =>
          resolveVisualizationRuntime(withClickHandlerName(inheritedName), 'sample', {
            params: {},
            state: {},
            clickHandlers: {},
          }),
        `click handler "${inheritedName}" must be an own function`,
      );
    }
    await expectRejects(
      () =>
        resolveVisualizationRuntime(catalog, 'sample', {
          params: {},
          state: {},
          clickHandlers: {},
        }),
      'click handler "points" must be an own function',
    );
    await expectRejects(
      () =>
        resolveVisualizationRuntime(catalog, 'sample', {
          params: {},
          state: {},
          clickHandlers: { points: false } as unknown as VisualizationRuntimeContext['clickHandlers'],
        }),
      'click handler "points" must be an own function',
    );

    const layerWithoutClickHandler = { ...catalog.visualizations[0].layers[0] };
    delete layerWithoutClickHandler.onClick;
    const noClickCatalog: VisualizationCatalog = {
      ...catalog,
      revision: `${catalog.revision}-no-click`,
      visualizations: [
        {
          ...catalog.visualizations[0],
          layers: [layerWithoutClickHandler],
        },
      ],
    };
    const noClickRuntime = await resolveVisualizationRuntime(noClickCatalog, 'sample', {
      params: {},
      state: {},
      clickHandlers: {},
    });
    assert(noClickRuntime.layers[0].props.onClick === undefined, 'a layer without onClick must remain valid');
  } finally {
    dataLoaderRegistry.json = previousJsonLoader;
  }
}

async function run() {
  testDefaultParamsIncludeMapStyle();
  testHexagonCatalogDefaultsMatchTheDeckGlReference();
  testManualVisualizationParameterProvenance();
  testResolvedVisualizationParamsDoNotChangeManualProvenance();
  testAdaptiveVisualizationParameterKeysComeFromTheHexagonContract();
  await testRuntimeUsesSelectedMapStyleParam();
  testGetActiveDatasetIdHonorsDatasetParam();
  await testRuntimeSwitchesDatasetViaDatasetParam();
  await testRuntimeUsesDatasetParameterDefaultAndRejectsUnknownDatasets();
  await testRuntimeDescriptorsUseTheDatasetParameterDefault();
  await testDataCacheSeparatesRevisedFilesWithStableIds();
  await testDataCacheEvictsRejectedPromisesAndKeepsSingleFlight();
  await testDataCacheUsesABoundedLru();
  await testBundledSnapshotPreservesOwnProtoDataWithoutPrototypePollution();
  testValidationFlagsUnknownDatasetParamOptions();
  await testRuntimeCreateLayersReturnsIsolatedPreviewLayers();
}

void run();
