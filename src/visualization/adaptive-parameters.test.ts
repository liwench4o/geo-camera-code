import {
  dataLoaderRegistry,
  resolveAdaptiveVisualizationDefaults,
  resolveVisualizationRuntime,
  shouldResolveAdaptiveVisualizationDefaults,
} from './registry';
import { getVisualizationConfig, getVisualizationDefaultParams, visualizationCatalog } from './catalog';
import type { DataFileConfig, VisualizationParameterValues } from './types';

declare const require: (moduleName: string) => {
  readFileSync: (path: string, encoding: BufferEncoding) => string;
};
type BufferEncoding = 'utf8';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertDefined<T>(value: T | undefined, message: string): asserts value is T {
  if (value === undefined) {
    throw new Error(message);
  }
}

function assertClose(actual: number, expected: number, tolerance: number, message: string) {
  if (
    ![actual, expected, tolerance].every(Number.isFinite) ||
    tolerance < 0 ||
    !(Math.abs(actual - expected) <= tolerance)
  ) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

function parseCsv(text: string) {
  const [headerLine, ...lines] = text.trim().split(/\r?\n/);
  const headers = headerLine.split(',');

  return lines
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const values = line.split(',');
      return headers.reduce<Record<string, string>>((row, header, index) => {
        row[header] = values[index] ?? '';
        return row;
      }, {});
    });
}

function loadAssetFile(file: DataFileConfig) {
  const fs = require('fs');
  const text = fs.readFileSync(`assets/${file.url}`, 'utf8');
  return file.format === 'json' ? JSON.parse(text) : parseCsv(text);
}

async function withAssetLoaders(testFn: () => Promise<void>) {
  const previousCsvLoader = dataLoaderRegistry.csv;
  const previousJsonLoader = dataLoaderRegistry.json;
  dataLoaderRegistry.csv = (file) => Promise.resolve(loadAssetFile(file));
  dataLoaderRegistry.json = (file) => Promise.resolve(loadAssetFile(file));

  try {
    await testFn();
  } finally {
    dataLoaderRegistry.csv = previousCsvLoader;
    dataLoaderRegistry.json = previousJsonLoader;
  }
}

function getHexagonDefaultParams(overrides: VisualizationParameterValues = {}) {
  const visualization = getVisualizationConfig('hexagon');
  if (!visualization) {
    throw new Error('hexagon visualization should exist in catalog');
  }
  return {
    ...getVisualizationDefaultParams(visualization),
    ...overrides,
  };
}

async function testBikeParkingAdaptiveDefaultsUseFullDatasetBounds() {
  await withAssetLoaders(async () => {
    const defaults = await resolveAdaptiveVisualizationDefaults(visualizationCatalog, 'hexagon', {
      params: getHexagonDefaultParams({ hexagonDataset: 'bike-parking' }),
      viewportSize: { width: 960, height: 640 },
    });

    assertDefined(defaults, 'bike parking should produce adaptive defaults');
    assert(defaults.parameterPatch.hexagonRadius === 500, 'bike parking radius should clamp to the slider minimum');
    assert(defaults.parameterPatch.hexagonCoverage === 0.8, 'bike parking coverage should separate crowded city bins');
    assert(
      defaults.parameterPatch.hexagonUpperPercentile === 100,
      'bike parking upper percentile should keep the full height domain',
    );
    assert(
      defaults.initialViewState.zoom > 10 && defaults.initialViewState.zoom < 13.5,
      `bike parking should use a city-scale initial zoom, received ${defaults.initialViewState.zoom}`,
    );
    assertClose(defaults.metrics.center[0], -122.443878, 0.000001, 'bike parking center longitude');
    assertClose(defaults.metrics.center[1], 37.757747, 0.000001, 'bike parking center latitude');
    assertClose(
      defaults.initialViewState.longitude,
      defaults.metrics.center[0],
      0.01,
      'bike parking initial longitude',
    );
    assertClose(defaults.initialViewState.latitude, defaults.metrics.center[1], 0.01, 'bike parking initial latitude');
    assert(defaults.metrics.rowCount === 2520, 'bike parking should use every normalized point');
  });
}

async function testRoadSafetyAdaptiveDefaultsMatchDeckGlReferenceStyle() {
  await withAssetLoaders(async () => {
    const defaults = await resolveAdaptiveVisualizationDefaults(visualizationCatalog, 'hexagon', {
      params: getHexagonDefaultParams({ hexagonDataset: 'road-safety' }),
      viewportSize: { width: 960, height: 640 },
    });

    assertDefined(defaults, 'road safety should produce adaptive defaults');
    assert(
      Number(defaults.parameterPatch.hexagonRadius) >= 990 && Number(defaults.parameterPatch.hexagonRadius) <= 1020,
      `road safety radius should stay near the deck.gl reference calibration, received ${String(
        defaults.parameterPatch.hexagonRadius,
      )}`,
    );
    assert(defaults.parameterPatch.hexagonCoverage === 1, 'road safety coverage should match the deck.gl reference');
    assert(
      defaults.parameterPatch.hexagonUpperPercentile === 100,
      'road safety upper percentile should match the deck.gl reference',
    );
    assert(
      defaults.initialViewState.zoom >= 6.45 && defaults.initialViewState.zoom <= 6.75,
      `road safety should use a deck.gl-style initial zoom, received ${defaults.initialViewState.zoom}`,
    );
    assertClose(defaults.initialViewState.longitude, -1.415727, 0.0001, 'road safety initial longitude');
    assertClose(defaults.initialViewState.latitude, 52.232395, 0.0001, 'road safety initial latitude');
    assertClose(defaults.initialViewState.pitch, 40.5, 0.000001, 'road safety initial pitch');
    assertClose(defaults.initialViewState.bearing, -27, 0.000001, 'road safety initial bearing');
    assertClose(defaults.metrics.bbox[0], -7.422915, 0.000001, 'road safety full bbox west edge');
    assertClose(defaults.metrics.bbox[1], 49.915618, 0.000001, 'road safety full bbox south edge');
    assertClose(defaults.metrics.bbox[2], 1.758443, 0.000001, 'road safety full bbox east edge');
    assertClose(defaults.metrics.bbox[3], 60.661117, 0.000001, 'road safety full bbox north edge');
    assert(defaults.metrics.rowCount === 140029, 'road safety should use every normalized point');
  });
}

async function testRoadSafetyReferenceViewPreventsWideViewportOverZoom() {
  await withAssetLoaders(async () => {
    const defaults = await resolveAdaptiveVisualizationDefaults(visualizationCatalog, 'hexagon', {
      params: getHexagonDefaultParams({ hexagonDataset: 'road-safety' }),
      viewportSize: { width: 1600, height: 900 },
    });

    assertDefined(defaults, 'road safety should produce adaptive defaults on wide viewports');
    assert(
      defaults.initialViewState.zoom <= 6.600001,
      `road safety should not zoom closer than the dataset reference view, received ${defaults.initialViewState.zoom}`,
    );
    assert(
      defaults.initialViewState.zoom >= 6.55,
      `road safety should stay close to the dataset reference view, received ${defaults.initialViewState.zoom}`,
    );
    assertClose(defaults.initialViewState.longitude, -1.415727, 0.0001, 'wide road safety initial longitude');
    assertClose(defaults.initialViewState.latitude, 52.232395, 0.0001, 'wide road safety initial latitude');
  });
}

async function testBikeParkingWideViewportKeepsDataDrivenCenter() {
  await withAssetLoaders(async () => {
    const defaults = await resolveAdaptiveVisualizationDefaults(visualizationCatalog, 'hexagon', {
      params: getHexagonDefaultParams({ hexagonDataset: 'bike-parking' }),
      viewportSize: { width: 1600, height: 900 },
    });

    assertDefined(defaults, 'bike parking should produce adaptive defaults on wide viewports');
    assertClose(
      defaults.initialViewState.longitude,
      defaults.metrics.center[0],
      0.01,
      'wide bike parking initial longitude',
    );
    assertClose(
      defaults.initialViewState.latitude,
      defaults.metrics.center[1],
      0.01,
      'wide bike parking initial latitude',
    );
  });
}

async function testRuntimeUsesAdaptiveInitialViewState() {
  await withAssetLoaders(async () => {
    const params = getHexagonDefaultParams({ hexagonDataset: 'bike-parking' });
    const runtime = await resolveVisualizationRuntime(visualizationCatalog, 'hexagon', {
      params,
      state: {},
      clickHandlers: { hexagonPosition: () => true },
      viewportSize: { width: 960, height: 640 },
    });

    assertDefined(runtime.adaptiveDefaults, 'runtime should expose adaptive defaults');
    assert(
      runtime.adaptiveDefaults.parameterPatch.hexagonRadius === 500,
      'runtime adaptive defaults should include the computed hexagon radius',
    );
    assertClose(
      runtime.initialViewState.longitude,
      runtime.adaptiveDefaults.initialViewState.longitude,
      0.000001,
      'runtime should use adaptive initial longitude',
    );
    assertClose(
      runtime.initialViewState.latitude,
      runtime.adaptiveDefaults.initialViewState.latitude,
      0.000001,
      'runtime should use adaptive initial latitude',
    );
  });
}

async function testRuntimeAppliesAdaptiveParametersBeforeCreatingLayers() {
  await withAssetLoaders(async () => {
    const params = getHexagonDefaultParams({ hexagonDataset: 'road-safety' });
    const runtime = await resolveVisualizationRuntime(visualizationCatalog, 'hexagon', {
      params,
      state: {},
      clickHandlers: { hexagonPosition: () => true },
      viewportSize: { width: 960, height: 640 },
    });
    const layer = runtime.layers[0];

    assert(
      Number(runtime.effectiveParams.hexagonRadius) >= 990 && Number(runtime.effectiveParams.hexagonRadius) <= 1020,
      'runtime effective radius should use the road-safety adaptive recommendation',
    );
    assert(
      runtime.effectiveParams.hexagonCoverage === 1,
      'runtime effective coverage should use the road-safety adaptive recommendation',
    );
    assert(
      layer.props.radius === runtime.effectiveParams.hexagonRadius,
      'the first rendered layer should use the effective adaptive radius',
    );
    assert(
      layer.props.coverage === runtime.effectiveParams.hexagonCoverage,
      'the first rendered layer should use the effective adaptive coverage',
    );
    const support = runtime.resolvedLayers[0].descriptor.resolvedSupport;
    if (support.producer !== 'hexagon-cell') {
      throw new Error('road-safety should resolve hexagon camera support');
    }
    assert(support.elevationDomain[1] > 0, 'camera analytics should retain its data-derived elevation domain');
    assert(
      layer.props.elevationDomain == null,
      'the rendered layer must let deck.gl derive its own aggregation elevation domain',
    );
    assert(layer.props.colorDomain == null, 'the rendered layer should keep deck.gl automatic color domain');
    assert(layer.props.colorScaleType === 'quantize', 'the rendered layer should retain deck.gl quantize colors');
    assert(layer.props.upperPercentile === 100, 'the rendered layer should keep the full aggregation percentile');
    const colorRange = layer.props.colorRange as number[][];
    assert(
      JSON.stringify(colorRange[colorRange.length - 1]) === JSON.stringify([209, 55, 78]),
      'the rendered layer should retain the deck.gl reference red endpoint',
    );
    assert(runtime.cameraConstraints.maxPitch === 70, 'hexagon runtime should expose the expanded pitch limit');
    assert(runtime.cameraConstraints.maxZoom === 15, 'hexagon runtime should expose the shared zoom limit');
  });
}

async function testRuntimePreservesManualAdaptiveParameter() {
  await withAssetLoaders(async () => {
    const params = getHexagonDefaultParams({
      hexagonDataset: 'road-safety',
      hexagonRadius: 2500,
    });
    const context = {
      params,
      state: {},
      clickHandlers: { hexagonPosition: () => true },
      viewportSize: { width: 960, height: 640 },
      manualParameterKeys: ['hexagonRadius'],
    };
    const runtime = await resolveVisualizationRuntime(visualizationCatalog, 'hexagon', context);

    assert(runtime.effectiveParams.hexagonRadius === 2500, 'manual radius should override the adaptive recommendation');
    assert(runtime.layers[0].props.radius === 2500, 'the rendered layer should preserve the manual radius');
    assert(
      runtime.effectiveParams.hexagonCoverage === 1,
      'non-manual adaptive parameters should still use their recommendation',
    );
  });
}

function testAdaptiveDefaultsResolveOnlyWhenDatasetParamChanges() {
  const visualization = getVisualizationConfig('hexagon');
  if (!visualization) {
    throw new Error('hexagon visualization should exist in catalog');
  }

  const roadParams = getHexagonDefaultParams({ hexagonDataset: 'road-safety', hexagonRadius: 1500 });
  const bikeParams = { ...roadParams, hexagonDataset: 'bike-parking' };
  const manualRadiusParams = { ...roadParams, hexagonRadius: 500 };

  assert(
    shouldResolveAdaptiveVisualizationDefaults(visualization, roadParams, bikeParams),
    'dataset changes should request adaptive defaults',
  );
  assert(
    !shouldResolveAdaptiveVisualizationDefaults(visualization, roadParams, manualRadiusParams),
    'manual radius edits should not request adaptive defaults',
  );
}

async function testBikeParkingZoomsCloserThanRoadSafety() {
  await withAssetLoaders(async () => {
    const roadDefaults = await resolveAdaptiveVisualizationDefaults(visualizationCatalog, 'hexagon', {
      params: getHexagonDefaultParams({ hexagonDataset: 'road-safety' }),
      viewportSize: { width: 960, height: 640 },
    });
    const bikeDefaults = await resolveAdaptiveVisualizationDefaults(visualizationCatalog, 'hexagon', {
      params: getHexagonDefaultParams({ hexagonDataset: 'bike-parking' }),
      viewportSize: { width: 960, height: 640 },
    });

    assertDefined(roadDefaults, 'road safety should resolve defaults');
    assertDefined(bikeDefaults, 'bike parking should resolve defaults');
    assert(
      bikeDefaults.initialViewState.zoom > roadDefaults.initialViewState.zoom + 4,
      `bike parking should zoom much closer than road safety (${bikeDefaults.initialViewState.zoom} vs ${roadDefaults.initialViewState.zoom})`,
    );
  });
}

async function run() {
  await testBikeParkingAdaptiveDefaultsUseFullDatasetBounds();
  await testRoadSafetyAdaptiveDefaultsMatchDeckGlReferenceStyle();
  await testRoadSafetyReferenceViewPreventsWideViewportOverZoom();
  await testBikeParkingWideViewportKeepsDataDrivenCenter();
  await testRuntimeUsesAdaptiveInitialViewState();
  await testRuntimeAppliesAdaptiveParametersBeforeCreatingLayers();
  await testRuntimePreservesManualAdaptiveParameter();
  testAdaptiveDefaultsResolveOnlyWhenDatasetParamChanges();
  await testBikeParkingZoomsCloserThanRoadSafety();
}

void run();
