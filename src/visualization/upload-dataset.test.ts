import { digestCanonical } from '../camera/geometry/canonical-digest';
import type { CustomObject } from '../interfaces';
import { getVisualizationDefaultParams, visualizationCatalog } from './catalog';
import {
  createUploadedDatasetOverride,
  dataLoaderRegistry,
  isLatestUploadedDatasetRevision,
  resolveVisualizationRuntime,
  updateUploadedDatasetOverrides,
} from './registry';
import type { CameraCalibrationConfig, UploadedDatasetOverride, VisualizationCatalog } from './types';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function createTextFile(name: string, contents: string, type: string) {
  return new File([contents], name, { type });
}

const testCameraCalibration: CameraCalibrationConfig = {
  version: 1,
  referenceZoom: 8,
  referenceSafeAreaPx: 921600,
  metrics: {
    elevation: { unit: 'meters', lo: 10, hi: 10000, source: 'global-fallback-v1' },
    density: { unit: 'count/km2', lo: 1, hi: 1000, source: 'global-fallback-v1' },
    aspect: { unit: 'ratio', lo: 1, hi: 8, source: 'catalog-v1' },
  },
};

async function testUploadFiltersInvalidRows() {
  const file = createTextFile(
    'mixed.csv',
    ['longitude,latitude', '-82.98,39.88', 'not-a-number,39.88', '10,100', ','].join('\n'),
    'text/csv',
  );
  const visualization = visualizationCatalog.visualizations.find((candidate) => candidate.id === 'hexagon')!;
  const override = await createUploadedDatasetOverride(
    visualizationCatalog,
    'hexagon',
    getVisualizationDefaultParams(visualization),
    file,
    1,
  );

  assert(override.totalRowCount === 4, 'all parsed rows should be counted');
  assert(override.skippedRowCount === 3, 'invalid and blank coordinate rows should be skipped');
  assert(override.loadedFiles.get('points')?.length === 1, 'only compatible rows should enter the runtime');
}

async function testJsonDataEnvelopeIsAccepted() {
  const file = createTextFile(
    'points.json',
    JSON.stringify({ data: [{ longitude: -82.98, latitude: 39.88 }] }),
    'application/json',
  );
  const visualization = visualizationCatalog.visualizations.find((candidate) => candidate.id === 'hexagon')!;
  const override = await createUploadedDatasetOverride(
    visualizationCatalog,
    'hexagon',
    getVisualizationDefaultParams(visualization),
    file,
    2,
  );

  assert(override.loadedFiles.get('points')?.length === 1, 'JSON data envelopes should load their rows');
}

async function testUploadRejectsUnsupportedOrEmptyData() {
  const visualization = visualizationCatalog.visualizations.find((candidate) => candidate.id === 'hexagon')!;
  const params = getVisualizationDefaultParams(visualization);

  await assertRejects(
    () =>
      createUploadedDatasetOverride(visualizationCatalog, 'hexagon', params, createTextFile('points.txt', '', ''), 1),
    'Only .csv and .json files are supported.',
  );
  await assertRejects(
    () =>
      createUploadedDatasetOverride(
        visualizationCatalog,
        'hexagon',
        params,
        createTextFile('points.json', '{broken', 'application/json'),
        1,
      ),
    'Could not parse points.json as JSON.',
  );
  await assertRejects(
    () =>
      createUploadedDatasetOverride(
        visualizationCatalog,
        'hexagon',
        params,
        createTextFile('points.csv', 'longitude,latitude\nnope,nope', 'text/csv'),
        1,
      ),
    'No rows in points.csv are compatible with Hexagon.',
  );
}

async function testCurrentVisualizationSchemasAcceptCompatibleRows() {
  const cases = [
    {
      visualizationId: 'line',
      row: {
        residence_lng: -3.01,
        residence_lat: 53.48,
        workplace_lng: -2.99,
        workplace_lat: 53.41,
        all_flows: 10,
      },
    },
    { visualizationId: 'point', row: { coordinates: [75.95, 30.85] } },
    {
      visualizationId: 'mix',
      row: { longitude: -73.58, latitude: 40.88, n_killed: 0, n_injured: 1 },
    },
  ];

  for (const testCase of cases) {
    const visualization = visualizationCatalog.visualizations.find(
      (candidate) => candidate.id === testCase.visualizationId,
    )!;
    const override = await createUploadedDatasetOverride(
      visualizationCatalog,
      testCase.visualizationId,
      getVisualizationDefaultParams(visualization),
      createTextFile(`${testCase.visualizationId}.json`, JSON.stringify([testCase.row]), 'application/json'),
      1,
    );

    assert(
      Array.from(override.loadedFiles.values())[0]?.length === 1,
      `${testCase.visualizationId} should accept rows matching its schema`,
    );
  }
}

async function testUploadedPrimaryKeepsAuxiliaryDatasetFiles() {
  const previousJsonLoader = dataLoaderRegistry.json;
  const loadedUrls: string[] = [];
  dataLoaderRegistry.json = (file) => {
    loadedUrls.push(file.url);
    return Promise.resolve([
      {
        height: 100,
        polygon: [
          [-74, 40.7],
          [-73.9, 40.8],
          [-74, 40.8],
        ],
      },
    ]);
  };

  const catalog: VisualizationCatalog = {
    revision: 'catalog-v1',
    defaultVisualization: 'animated',
    datasets: [
      {
        revision: 'cab-trips-v1',
        id: 'cab-trips',
        title: 'Cab Trips',
        files: [
          { revision: 'trips-v1', id: 'trips', url: 'trips.json', format: 'json' },
          { revision: 'buildings-v1', id: 'buildings', url: 'buildings.json', format: 'json' },
        ],
        primaryDataRef: 'trips',
      },
    ],
    visualizations: [
      {
        revision: 'animated-v1',
        id: 'animated',
        title: 'Animated Lines',
        datasetId: 'cab-trips',
        mapStyle: 'carto.darkNoLabels',
        initialViewState: 'manhattanAnimated',
        layers: [
          {
            id: 'trips',
            type: 'TripsLayer',
            dataRef: 'trips',
            rendererVersion: 1,
            props: {
              getWidth: 1,
              widthUnits: 'pixels',
              widthScale: 1,
              widthMinPixels: 2,
              billboard: true,
              jointRounded: true,
              capRounded: true,
            },
            accessors: { getPath: 'tripPath', getTimestamps: 'tripTimestamps', getColor: 'tripVendorColor' },
            selection: {
              supported: ['click', 'path'],
              pathAccessor: 'tripPath',
              renderQueryId: 'select-trip-path-v1',
            },
            cameraEnvelope: {
              producer: 'trip-path',
              producerVersion: 1,
              pathAccessor: 'tripPath',
              width: { prop: 'getWidth', unitProp: 'widthUnits', scaleProp: 'widthScale' },
              minPixelsProp: 'widthMinPixels',
              maxPixelsProp: 'widthMaxPixels',
              support: { antialiasBufferPx: 2 },
              capabilities: {
                supportsLive: false,
                supportsPrediction: false,
                maxPredictionHorizonMs: 0,
                nominalUpdateHz: 1,
                frameEvolution: 'revision-step',
              },
            },
            cameraCalibration: testCameraCalibration,
            analytics: { kind: 'path', pathAccessor: 'tripPath' },
          },
          {
            id: 'buildings',
            type: 'PolygonLayer',
            dataRef: 'buildings',
            rendererVersion: 1,
            props: { elevationScale: 1 },
            accessors: { getPolygon: 'buildingPolygon', getElevation: 'buildingHeight' },
            selection: { supported: ['region'], renderQueryId: 'select-polygon-region-v1' },
            cameraEnvelope: {
              producer: 'polygon-extrusion',
              producerVersion: 1,
              polygonAccessor: 'buildingPolygon',
              elevationAccessor: 'buildingHeight',
              baseMeters: 0,
              elevationScale: 1,
              elevationUnit: 'meters',
              wrapMode: 'geometry',
              support: { antialiasBufferPx: 2 },
              capabilities: {
                supportsLive: false,
                supportsPrediction: false,
                maxPredictionHorizonMs: 0,
                nominalUpdateHz: 1,
                frameEvolution: 'revision-step',
              },
            },
            cameraCalibration: testCameraCalibration,
            analytics: { kind: 'building', polygonAccessor: 'buildingPolygon' },
          },
        ],
      },
    ],
  };
  const file = createTextFile(
    'trips.json',
    JSON.stringify([
      {
        vendor: 0,
        path: [
          [-74, 40.7],
          [-73.9, 40.8],
        ],
        timestamps: [0, 10],
      },
    ]),
    'application/json',
  );

  try {
    const override = await createUploadedDatasetOverride(catalog, 'animated', {}, file, 3);
    const runtime = await resolveVisualizationRuntime(catalog, 'animated', {
      params: {},
      state: { animationTime: 0 },
      clickHandlers: {},
      datasetOverride: override,
    });

    assert(runtime.primaryData.length === 1, 'uploaded trips should replace primary data');
    assert(loadedUrls.includes('buildings.json'), 'catalog auxiliary files should still be loaded');
    assert(runtime.analytics.layers[1]?.rowCount === 1, 'auxiliary rows should participate in analytics');
  } finally {
    dataLoaderRegistry.json = previousJsonLoader;
  }
}

async function testUploadContentDigestTracksAcceptedNormalizedRows() {
  const visualization = visualizationCatalog.visualizations.find((candidate) => candidate.id === 'hexagon')!;
  const params = getVisualizationDefaultParams(visualization);
  const baseCsv = ['longitude,latitude', '-82.98,39.88', '-83,40'].join('\n');
  const first = await createUploadedDatasetOverride(
    visualizationCatalog,
    'hexagon',
    params,
    createTextFile('first.csv', baseCsv, 'text/csv'),
    1,
  );
  const renamedAndNewRequest = await createUploadedDatasetOverride(
    visualizationCatalog,
    'hexagon',
    params,
    createTextFile('renamed.csv', baseCsv, 'text/csv'),
    99,
  );
  const equivalentJson = await createUploadedDatasetOverride(
    visualizationCatalog,
    'hexagon',
    params,
    createTextFile(
      'equivalent.json',
      JSON.stringify([
        { longitude: -82.98, latitude: 39.88 },
        { longitude: -83, latitude: 40 },
      ]),
      'application/json',
    ),
    2,
  );
  const withRejectedRow = await createUploadedDatasetOverride(
    visualizationCatalog,
    'hexagon',
    params,
    createTextFile('with-invalid.csv', `${baseCsv}\nnot-a-number,39.88`, 'text/csv'),
    3,
  );
  const changedCoordinate = await createUploadedDatasetOverride(
    visualizationCatalog,
    'hexagon',
    params,
    createTextFile('changed.csv', ['longitude,latitude', '-82.97,39.88', '-83,40'].join('\n'), 'text/csv'),
    4,
  );
  const reversedRows = await createUploadedDatasetOverride(
    visualizationCatalog,
    'hexagon',
    params,
    createTextFile(
      'reversed.json',
      JSON.stringify([
        { longitude: -83, latitude: 40 },
        { longitude: -82.98, latitude: 39.88 },
      ]),
      'application/json',
    ),
    5,
  );

  assert(first.contentDigest.length > 0, 'uploaded data must expose a content digest');
  assert(
    first.contentDigest === renamedAndNewRequest.contentDigest,
    'file name and latest-request revision must not affect content identity',
  );
  assert(
    first.contentDigest === equivalentJson.contentDigest,
    'equivalent accepted CSV and JSON rows must normalize to one content identity',
  );
  assert(
    first.contentDigest === withRejectedRow.contentDigest,
    'rejected rows must not affect accepted content identity',
  );
  assert(first.contentDigest !== changedCoordinate.contentDigest, 'a coordinate change must change content identity');
  assert(first.contentDigest !== reversedRows.contentDigest, 'accepted row order must remain part of content identity');
}

async function testUploadedDataIsAnOwnedImmutableSnapshot() {
  const visualization = visualizationCatalog.visualizations.find((candidate) => candidate.id === 'point')!;
  const override = await createUploadedDatasetOverride(
    visualizationCatalog,
    'point',
    getVisualizationDefaultParams(visualization),
    createTextFile(
      'owned-point.json',
      JSON.stringify([
        {
          coordinates: [75.95, 30.85, 12],
          metadata: { tags: ['owned', { value: 1 }] },
        },
      ]),
      'application/json',
    ),
    11,
  );
  const rows = override.loadedFiles.get('points')!;
  const row = rows[0];
  const metadata = row.metadata as { tags: Array<string | { value: number }> };

  assert(Object.isFrozen(override), 'uploaded override must be frozen');
  assert(Object.isFrozen(override.dataset), 'uploaded dataset config must be frozen');
  assert(Object.isFrozen(override.dataset.files), 'uploaded dataset files must be frozen');
  assert(Object.isFrozen(rows) && Object.isFrozen(row), 'uploaded rows and records must be frozen');
  assert(
    Object.isFrozen(row.coordinates) && Object.isFrozen(metadata) && Object.isFrozen(metadata.tags),
    'uploaded nested arrays and objects must be frozen',
  );
  assert(
    !(override.loadedFiles as unknown as { set?: unknown }).set,
    'uploaded loadedFiles must not expose a mutable Map.set method',
  );

  const runtime = await resolveVisualizationRuntime(visualizationCatalog, 'point', {
    params: getVisualizationDefaultParams(visualization),
    state: {},
    clickHandlers: { lonLatFields: () => true },
    datasetOverride: override,
  });
  assert(Object.isFrozen(runtime.primaryData), 'runtime primaryData must be immutable');
  assert(Object.isFrozen(runtime.resolvedLayers[0].data), 'resolved layer data must be immutable');
  assert(runtime.primaryData === rows, 'runtime and upload override must share the same owned row snapshot');
  let mutationRejected = false;
  try {
    runtime.primaryData.push({ coordinates: [0, 0] });
  } catch {
    mutationRejected = true;
  }
  assert(mutationRejected, 'runtime primaryData mutation must fail at runtime');
}

async function testRuntimeOwnsAndAuthenticatesUnbrandedOverrides() {
  const visualization = visualizationCatalog.visualizations.find((candidate) => candidate.id === 'point')!;
  const baseDataset = visualizationCatalog.datasets.find((candidate) => candidate.id === visualization.datasetId)!;
  const primaryFile = baseDataset.files.find((candidate) => candidate.id === baseDataset.primaryDataRef)!;
  const sourceRows = [{ coordinates: [1, 2], metadata: { source: 'caller' } }];
  const sourceFiles = new Map([[primaryFile.id, sourceRows]]);
  const sourceDataset = {
    ...baseDataset,
    id: 'upload:point',
    title: 'caller-point.json',
    files: baseDataset.files.map((file) =>
      file.id === primaryFile.id ? { ...file, url: 'caller-point.json', format: 'json' as const } : { ...file },
    ),
    normalizers: undefined,
    initialViewState: undefined,
  };
  const forgedOverride = {
    revision: 44,
    contentDigest: 'caller-controlled-stale-digest',
    dataset: sourceDataset,
    loadedFiles: sourceFiles,
    sourceFileName: 'caller-point.json',
    totalRowCount: 1,
    skippedRowCount: 0,
  } satisfies UploadedDatasetOverride;
  const context = {
    params: getVisualizationDefaultParams(visualization),
    state: {},
    clickHandlers: { lonLatFields: () => true },
    datasetOverride: forgedOverride,
  };

  const first = await resolveVisualizationRuntime(visualizationCatalog, 'point', context);
  const firstDigest = digestCanonical({ schemaVersion: 1, rows: first.primaryData });
  assert(first.dataset !== sourceDataset, 'runtime must never retain an unbranded caller dataset identity');
  assert(Object.isFrozen(first.dataset) && Object.isFrozen(first.dataset.files), 'runtime must own a frozen dataset');
  assert(Object.isFrozen(first.primaryData) && Object.isFrozen(first.primaryData[0]), 'runtime must own frozen rows');
  assert(
    first.resolvedLayers[0].descriptor.dataRevision === firstDigest,
    'runtime descriptor must use the digest recomputed from owned rows',
  );
  assert(firstDigest !== forgedOverride.contentDigest, 'runtime must not trust a caller-provided content digest');

  sourceRows[0].coordinates[0] = 3;
  sourceRows[0].metadata.source = 'mutated';
  sourceDataset.title = 'mutated-title.json';
  const second = await resolveVisualizationRuntime(visualizationCatalog, 'point', context);
  assert(first.primaryData[0].coordinates[0] === 1, 'source row mutation must not affect a resolved runtime');
  assert(first.primaryData[0].metadata.source === 'caller', 'nested source mutation must not affect owned rows');
  assert(first.dataset.title === 'caller-point.json', 'source dataset mutation must not affect an owned dataset');
  assert(second.primaryData[0].coordinates[0] === 3, 'an unbranded override must be snapshotted on every call');
  assert(second.dataset.title === 'mutated-title.json', 'a later call must receive its own fresh caller snapshot');
  assert(
    second.resolvedLayers[0].descriptor.dataRevision !== first.resolvedLayers[0].descriptor.dataRevision,
    'fresh unbranded snapshots must derive fresh digests after content changes',
  );
  sourceFiles.set('caller-extra', []);
  assert(!first.primaryData.some((row) => row === sourceRows[0]), 'runtime rows must never retain caller identity');
}

async function testRuntimeRejectsMalformedUnbrandedOverrideRelationships() {
  const visualization = visualizationCatalog.visualizations.find((candidate) => candidate.id === 'point')!;
  const baseDataset = visualizationCatalog.datasets.find((candidate) => candidate.id === visualization.datasetId)!;
  const primaryFile = baseDataset.files.find((candidate) => candidate.id === baseDataset.primaryDataRef)!;
  const makeOverride = (
    datasetId: string,
    loadedFiles: ReadonlyMap<string, CustomObject[]>,
    files = baseDataset.files.map((file) => ({ ...file })),
  ) =>
    ({
      revision: 1,
      contentDigest: 'untrusted',
      dataset: {
        ...baseDataset,
        id: datasetId,
        files,
        normalizers: undefined,
        initialViewState: undefined,
      },
      loadedFiles,
      sourceFileName: 'untrusted.json',
      totalRowCount: 1,
      skippedRowCount: 0,
    }) satisfies UploadedDatasetOverride;
  const resolve = (override: UploadedDatasetOverride) =>
    resolveVisualizationRuntime(visualizationCatalog, 'point', {
      params: getVisualizationDefaultParams(visualization),
      state: {},
      clickHandlers: { lonLatFields: () => true },
      datasetOverride: override,
    });

  await assertRejects(
    () => resolve(makeOverride('upload:other', new Map([[primaryFile.id, [{ coordinates: [1, 2] }]]]))),
    'Uploaded override dataset id must be "upload:point".',
    'UploadDataError',
  );

  {
    const getterOverride = makeOverride(
      'upload:point',
      new Map([[primaryFile.id, [{ coordinates: [1, 2] }]]]),
    ) as UploadedDatasetOverride;
    let reads = 0;
    Object.defineProperty(getterOverride, 'dataset', {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error('override dataset getter executed');
      },
    });
    await assertRejects(
      () => resolve(getterOverride),
      'Uploaded override must be an exact plain own-data record.',
      'UploadDataError',
    );
    assert(reads === 0, 'override field getters must never execute');
  }
  {
    let iteratorCalls = 0;
    const customIterable = {
      [Symbol.iterator]: () => {
        iteratorCalls += 1;
        throw new Error('custom loadedFiles iterator executed');
      },
    };
    const iteratorOverride = makeOverride(
      'upload:point',
      customIterable as unknown as ReadonlyMap<string, CustomObject[]>,
    );
    await assertRejects(
      () => resolve(iteratorOverride),
      'Uploaded override loadedFiles must be a native Map.',
      'UploadDataError',
    );
    assert(iteratorCalls === 0, 'custom loadedFiles iterator must never execute');
  }
  {
    const mapWithAccessor = new Map([[primaryFile.id, [{ coordinates: [1, 2] }]]]);
    let reads = 0;
    Object.defineProperty(mapWithAccessor, 'poison', {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error('Map getter executed');
      },
    });
    await assertRejects(
      () => resolve(makeOverride('upload:point', mapWithAccessor)),
      'Uploaded override loadedFiles must not contain own properties.',
      'UploadDataError',
    );
    assert(reads === 0, 'loadedFiles own accessors must never execute');
  }
  await assertRejects(
    () => resolve(makeOverride('upload:point', new Map())),
    `Uploaded override is missing primary data "${primaryFile.id}".`,
    'UploadDataError',
  );
  const auxiliaryFile = { revision: 'aux-v1', id: 'auxiliary', url: 'auxiliary.json', format: 'json' as const };
  await assertRejects(
    () =>
      resolve(
        makeOverride(
          'upload:point',
          new Map([
            [primaryFile.id, [{ coordinates: [1, 2] }]],
            [auxiliaryFile.id, [{ coordinates: [3, 4] }]],
          ]),
          [...baseDataset.files.map((file) => ({ ...file })), auxiliaryFile],
        ),
      ),
    `Uploaded override must contain only primary data "${primaryFile.id}".`,
    'UploadDataError',
  );
  await assertRejects(
    () =>
      resolve(
        makeOverride('upload:point', new Map([[primaryFile.id, [{ coordinates: [1, 2] }]]]), [
          ...baseDataset.files.map((file) => ({ ...file })),
          auxiliaryFile,
        ]),
      ),
    'Uploaded override dataset schema must match the selected dataset.',
    'UploadDataError',
  );

  const animated = visualizationCatalog.visualizations.find((candidate) => candidate.id === 'animated')!;
  const animatedBase = visualizationCatalog.datasets.find((candidate) => candidate.id === animated.datasetId)!;
  const animatedPrimary = animatedBase.files.find((file) => file.id === animatedBase.primaryDataRef)!;
  const animatedFiles = animatedBase.files.map((file) =>
    file.id === animatedPrimary.id
      ? { ...file, url: 'trips-upload.json', format: 'json' as const }
      : { ...file, url: 'tampered-auxiliary.json' },
  );
  const animatedOverride = {
    revision: 1,
    contentDigest: 'untrusted',
    dataset: {
      ...animatedBase,
      id: 'upload:animated',
      title: 'trips-upload.json',
      files: animatedFiles,
      normalizers: undefined,
      initialViewState: undefined,
    },
    loadedFiles: new Map([
      [
        animatedPrimary.id,
        [
          {
            path: [
              [1, 2],
              [3, 4],
            ],
            timestamps: [0, 1],
            vendor: 0,
          },
        ],
      ],
    ]),
    sourceFileName: 'trips-upload.json',
    totalRowCount: 1,
    skippedRowCount: 0,
  } satisfies UploadedDatasetOverride;
  await assertRejects(
    () =>
      resolveVisualizationRuntime(visualizationCatalog, 'animated', {
        params: getVisualizationDefaultParams(animated),
        state: {},
        clickHandlers: {},
        datasetOverride: animatedOverride,
      }),
    'Uploaded override must preserve non-primary file metadata.',
    'UploadDataError',
  );
}

async function testUploadSnapshotPreservesOwnProtoDataWithoutPrototypePollution() {
  const visualization = visualizationCatalog.visualizations.find((candidate) => candidate.id === 'point')!;
  const override = await createUploadedDatasetOverride(
    visualizationCatalog,
    'point',
    getVisualizationDefaultParams(visualization),
    createTextFile('proto.json', '[{"coordinates":[1,2],"__proto__":{"geometry":[[99,99]]}}]', 'application/json'),
    1,
  );
  const row = override.loadedFiles.get('points')![0];
  assert(Object.prototype.hasOwnProperty.call(row, '__proto__'), '__proto__ must remain an own data property');
  assert(Object.getPrototypeOf(row) === Object.prototype, '__proto__ data must not replace the row prototype');
  assert(row.geometry === undefined, 'geometry from __proto__ data must never become an inherited geometry field');
}

async function testMalformedUploadRowsFailClosedWithStableErrors() {
  const point = visualizationCatalog.visualizations.find((candidate) => candidate.id === 'point')!;
  const params = getVisualizationDefaultParams(point);
  await assertRejects(
    () =>
      createUploadedDatasetOverride(
        visualizationCatalog,
        'point',
        params,
        new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'oversized.json', { type: 'application/json' }),
        1,
      ),
    'Upload file exceeds maximum size 8388608 bytes.',
    'UploadDataError',
  );
  await assertRejects(
    () =>
      createUploadedDatasetOverride(
        visualizationCatalog,
        'point',
        params,
        createTextFile(
          'too-many.json',
          JSON.stringify(Array.from({ length: 100_001 }, () => ({ coordinates: [0, 0] }))),
          'application/json',
        ),
        1,
      ),
    'Upload rows exceed maximum row count 100000.',
    'UploadDataError',
  );
  await assertRejects(
    () =>
      createUploadedDatasetOverride(
        visualizationCatalog,
        'point',
        params,
        createTextFile('null-row.json', '[null]', 'application/json'),
        1,
      ),
    'Upload row 0 must be a plain record.',
    'UploadDataError',
  );
  await assertRejects(
    () =>
      createUploadedDatasetOverride(
        visualizationCatalog,
        'point',
        params,
        createTextFile(
          'invalid-z.json',
          JSON.stringify([{ coordinates: [75.95, 30.85, 'not-finite'] }]),
          'application/json',
        ),
        1,
      ),
    /^No rows in invalid-z\.json are compatible with .+\.$/,
    'UploadDataError',
  );
  await assertRejects(
    () =>
      createUploadedDatasetOverride(
        visualizationCatalog,
        'point',
        params,
        createTextFile('mercator.json', JSON.stringify([{ coordinates: [0, 89] }]), 'application/json'),
        1,
      ),
    /^No rows in mercator\.json are compatible with .+\.$/,
    'UploadDataError',
  );
  await assertRejects(
    () =>
      createUploadedDatasetOverride(
        visualizationCatalog,
        'point',
        params,
        createTextFile('overflow.json', '[{"coordinates":[0,0],"value":1e999}]', 'application/json'),
        1,
      ),
    'Upload rows must not contain non-finite numbers.',
    'UploadDataError',
  );

  let deep: Record<string, unknown> = { value: true };
  for (let depth = 0; depth < 70; depth += 1) deep = { child: deep };
  await assertRejects(
    () =>
      createUploadedDatasetOverride(
        visualizationCatalog,
        'point',
        params,
        createTextFile(
          'deep.json',
          JSON.stringify([{ coordinates: [75.95, 30.85], irrelevant: deep }]),
          'application/json',
        ),
        1,
      ),
    'Upload rows exceed maximum depth 64.',
    'UploadDataError',
  );
}

function testUploadedDatasetOverridesAreScopedAndRevisionGuarded() {
  const mutableRows = [{ coordinates: [1, 2], nested: { value: 1 } }];
  const mutableLoadedFiles = new Map([['points', mutableRows]]);
  const hexagonOverride = {
    revision: 4,
    contentDigest: 'content-hexagon',
    dataset: {
      revision: 'upload-4',
      id: 'upload:hexagon',
      title: 'hex.csv',
      files: [{ revision: 'points-v1', id: 'points', url: 'hex.csv', format: 'json' }],
      primaryDataRef: 'points',
    },
    loadedFiles: mutableLoadedFiles,
    sourceFileName: 'hex.csv',
    totalRowCount: 1,
    skippedRowCount: 0,
  } satisfies UploadedDatasetOverride;
  const pointOverride = {
    ...hexagonOverride,
    revision: 8,
    contentDigest: 'content-point',
    dataset: {
      revision: 'upload-8',
      id: 'upload:point',
      title: 'points.json',
      files: [{ revision: 'points-v1', id: 'points', url: 'points.json', format: 'json' }],
      primaryDataRef: 'points',
    },
    sourceFileName: 'points.json',
  } satisfies UploadedDatasetOverride;

  const withHexagon = updateUploadedDatasetOverrides({}, 'hexagon', hexagonOverride);
  const withBoth = updateUploadedDatasetOverrides(withHexagon, 'point', pointOverride);
  const withoutHexagon = updateUploadedDatasetOverrides(withBoth, 'hexagon', undefined);

  assert(withBoth.hexagon !== hexagonOverride, 'override state must not retain caller-mutable identity');
  assert(withBoth.point !== pointOverride, 'each stored override must be an owned snapshot');
  assert(Object.isFrozen(withBoth.hexagon), 'stored override must be frozen');
  assert(
    !(withBoth.hexagon?.loadedFiles as unknown as { set?: unknown }).set,
    'stored override loadedFiles must not expose Map.set',
  );
  mutableRows[0].coordinates[0] = 999;
  mutableRows[0].nested.value = 999;
  mutableLoadedFiles.set('extra', []);
  const storedHexagon = withBoth.hexagon!;
  const storedRow = storedHexagon.loadedFiles.get('points')?.[0];
  assert(storedRow?.coordinates[0] === 1, 'stored rows must not drift with caller mutations');
  assert(storedRow?.nested.value === 1, 'stored nested values must be owned');
  assert(!storedHexagon.loadedFiles.has('extra'), 'stored map membership must be owned');
  assert(
    storedHexagon.contentDigest ===
      digestCanonical({ schemaVersion: 1, rows: storedHexagon.loadedFiles.get('points') }),
    'stored contentDigest must be recomputed from the owned primary rows',
  );
  assert(withoutHexagon.hexagon === undefined, 'clearing an example dataset should remove only its upload');
  assert(withoutHexagon.point === withBoth.point, 'clearing hexagon should preserve the owned point upload');
  assert(isLatestUploadedDatasetRevision(8, pointOverride), 'matching revisions should be committed');
  assert(!isLatestUploadedDatasetRevision(9, pointOverride), 'stale upload revisions should be ignored');
}

function testUploadedDatasetOverridesRejectHiddenOrAccessorData() {
  const makeOverride = (row: CustomObject) =>
    ({
      revision: 1,
      contentDigest: 'caller-stale-digest',
      dataset: {
        revision: 'upload-v1',
        id: 'upload:point',
        title: 'point.json',
        files: [{ revision: 'rows-v1', id: 'points', url: 'point.json', format: 'json' }],
        primaryDataRef: 'points',
      },
      loadedFiles: new Map([['points', [row]]]),
      sourceFileName: 'point.json',
      totalRowCount: 1,
      skippedRowCount: 0,
    }) satisfies UploadedDatasetOverride;

  assertThrows(
    () => updateUploadedDatasetOverrides({}, 'point', makeOverride(null as unknown as CustomObject)),
    'Uploaded file "points" row 0 must be a plain record.',
    'UploadDataError',
  );

  const hiddenRow = { coordinates: [1, 2] };
  Object.defineProperty(hiddenRow, 'hidden', { value: 'must-not-disappear', enumerable: false });
  assertThrows(
    () => updateUploadedDatasetOverrides({}, 'point', makeOverride(hiddenRow)),
    'Uploaded file "points" rows must contain enumerable string data properties only.',
    'UploadDataError',
  );

  const accessorRow = { coordinates: [1, 2] };
  Object.defineProperty(accessorRow, 'computed', { get: () => 42, enumerable: true });
  assertThrows(
    () => updateUploadedDatasetOverrides({}, 'point', makeOverride(accessorRow)),
    'Uploaded file "points" rows must contain data properties only.',
    'UploadDataError',
  );
}

function testUploadedSnapshotsRejectNoncanonicalArraysAndHandleSharedDags() {
  const makeOverride = (row: CustomObject) =>
    ({
      revision: 1,
      contentDigest: 'caller-digest',
      dataset: {
        revision: 'upload-v1',
        id: 'upload:point',
        title: 'point.json',
        files: [{ revision: 'rows-v1', id: 'points', url: 'point.json', format: 'json' }],
        primaryDataRef: 'points',
      },
      loadedFiles: new Map([['points', [row]]]),
      sourceFileName: 'point.json',
      totalRowCount: 1,
      skippedRowCount: 0,
    }) satisfies UploadedDatasetOverride;

  const sparseCoordinates = new Array<number>(2);
  sparseCoordinates[0] = 1;
  assertThrows(
    () => updateUploadedDatasetOverrides({}, 'point', makeOverride({ coordinates: sparseCoordinates })),
    'Uploaded file "points" rows arrays must be dense and contain standard indices only.',
    'UploadDataError',
  );
  const extraCoordinates = [1, 2];
  (extraCoordinates as unknown as Record<string, unknown>).extra = 'ignored-by-array-digest';
  assertThrows(
    () => updateUploadedDatasetOverrides({}, 'point', makeOverride({ coordinates: extraCoordinates })),
    'Uploaded file "points" rows arrays must be dense and contain standard indices only.',
    'UploadDataError',
  );

  let depthShared: CustomObject = { leaf: true };
  for (let depth = 0; depth < 10; depth += 1) depthShared = { child: depthShared };
  let deepReference = depthShared;
  for (let depth = 0; depth < 58; depth += 1) deepReference = { next: deepReference };
  assertThrows(
    () =>
      updateUploadedDatasetOverrides(
        {},
        'point',
        makeOverride({ coordinates: [1, 2], metadata: { shallowShared: depthShared, deepReference } }),
      ),
    'Uploaded file "points" rows exceed maximum depth 64.',
    'UploadDataError',
  );

  const shared = { values: Array.from({ length: 100 }, (_, value) => value) };
  const sharedRefs = Array.from({ length: 10_000 }, () => shared);
  const stored = updateUploadedDatasetOverrides(
    {},
    'point',
    makeOverride({ coordinates: [1, 2], metadata: { sharedRefs } }),
  ).point!;
  const storedRefs = stored.loadedFiles.get('points')![0].metadata.sharedRefs as CustomObject[];
  assert(storedRefs[0] === storedRefs[storedRefs.length - 1], 'shared DAG nodes must preserve shared clone identity');
}

async function assertRejects(action: () => Promise<unknown>, expectedMessage: string | RegExp, expectedName?: string) {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(
      typeof expectedMessage === 'string' ? message === expectedMessage : expectedMessage.test(message),
      `expected "${expectedMessage}", received "${message}"`,
    );
    if (expectedName) {
      assert(
        error instanceof Error && error.name === expectedName,
        `expected ${expectedName}, received ${String(error)}`,
      );
    }
    return;
  }

  throw new Error(`expected rejection: ${expectedMessage}`);
}

function assertThrows(action: () => unknown, expectedMessage: string, expectedName: string) {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message === expectedMessage, `expected "${expectedMessage}", received "${message}"`);
    assert(
      error instanceof Error && error.name === expectedName,
      `expected ${expectedName}, received ${String(error)}`,
    );
    return;
  }
  throw new Error(`expected rejection: ${expectedMessage}`);
}

async function run() {
  await testUploadFiltersInvalidRows();
  await testJsonDataEnvelopeIsAccepted();
  await testUploadRejectsUnsupportedOrEmptyData();
  await testCurrentVisualizationSchemasAcceptCompatibleRows();
  await testUploadedPrimaryKeepsAuxiliaryDatasetFiles();
  await testUploadContentDigestTracksAcceptedNormalizedRows();
  await testUploadedDataIsAnOwnedImmutableSnapshot();
  await testRuntimeOwnsAndAuthenticatesUnbrandedOverrides();
  await testRuntimeRejectsMalformedUnbrandedOverrideRelationships();
  await testUploadSnapshotPreservesOwnProtoDataWithoutPrototypePollution();
  await testMalformedUploadRowsFailClosedWithStableErrors();
  testUploadedDatasetOverridesAreScopedAndRevisionGuarded();
  testUploadedDatasetOverridesRejectHiddenOrAccessorData();
  testUploadedSnapshotsRejectNoncanonicalArraysAndHandleSharedDags();
}

void run();
