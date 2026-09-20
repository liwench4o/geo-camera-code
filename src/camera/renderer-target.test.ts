import assert from 'node:assert/strict';
import { WebMercatorViewport } from '@deck.gl/core';
import {
  captureCurrentHexagonTarget,
  captureHexagonTarget,
  rememberTargetSource,
  refreshTargetGeometry,
  resolveCurrentTargetRows,
} from './renderer-target';
import { createPathTarget, createPointTarget, createRegionTarget } from './selection';
import type { ResolvedLayerRuntime } from '../visualization/types';

const projection = new WebMercatorViewport({ longitude: 10, latitude: 45, zoom: 10, width: 800, height: 600 });
const origin = projection.projectFlat([10, 45]);
const cellProps = {
  radius: 0.01,
  coverage: 0.8,
  hexOriginCommon: origin,
  extruded: true,
  elevationScale: 10,
  elevationRange: [0, 1000],
  elevationDomain: [0, 100],
  elevationCutoff: null,
  colorDomain: [0, 100],
  colorCutoff: null,
};
const layer = { getSubLayers: () => [{ props: cellProps }] };
const runtime = {
  descriptor: {
    datasetId: 'data',
    visualizationId: 'hexagon',
    layerId: 'cells',
    dataRevision: 'data-1',
    visualizationRevision: 'vis-1',
    resolvedLayerDigest: 'layer-1',
    cameraEnvelope: { producer: 'hexagon-cell', producerVersion: 1, support: { antialiasBufferPx: 1 } },
    resolvedSupport: { producer: 'hexagon-cell' },
  },
  data: [],
} as unknown as ResolvedLayerRuntime;

const result = captureHexagonTarget(createPointTarget([10, 45]), runtime, layer, [
  { col: 0, row: 0, elevationValue: 100, colorValue: 50, count: 2 },
]);
const elevatedPick = captureHexagonTarget(createPointTarget([12, 46]), runtime, layer, [
  { col: 0, row: 0, elevationValue: 100, colorValue: 50, count: 2 },
]);
assert.equal(elevatedPick.status, 'ok');
if (elevatedPick.status === 'ok') {
  assert.ok(
    Math.abs(elevatedPick.value.bbox[0] - 10) < 1e-6,
    'target identity uses the rendered cell, not the ground intersection behind a tall column',
  );
  assert.ok(Math.abs(elevatedPick.value.bbox[1] - 45) < 1e-6);
  assert.equal(
    elevatedPick.value.label,
    `[${elevatedPick.value.center[0].toFixed(3)}, ${elevatedPick.value.center[1].toFixed(3)}]`,
    'generated location label follows the rendered cell center, not the ground intersection',
  );
}
const roundedPick = captureHexagonTarget(
  { ...createPointTarget([12.34567, 46.78912]), label: '[12.346, 46.789]' },
  runtime,
  layer,
  [{ col: 0, row: 0, elevationValue: 100, colorValue: 50, count: 2 }],
);
assert.equal(roundedPick.status, 'ok');
assert.equal(roundedPick.value.label, '[10.000, 45.000]', 'refresh recognizes and updates a generated rounded label');
assert.equal(
  roundedPick.value.center[0],
  projection.unprojectFlat(origin)[0],
  'display rounding retains full geometry precision',
);
const namedPick = captureHexagonTarget({ ...createPointTarget([12, 46]), label: 'London focus' }, runtime, layer, [
  { col: 0, row: 0, elevationValue: 100, colorValue: 50, count: 2 },
]);
assert.equal(namedPick.status, 'ok');
assert.equal(namedPick.value.label, 'London focus', 'capturing the rendered center preserves an author label');
assert.equal(result.status, 'ok');
if (result.status === 'ok') {
  const envelope = result.value.snapshotEnvelope!;
  const primitive = envelope.frame.primitives[0];
  assert.equal(primitive.kind, 'extruded-footprint');
  if (primitive.kind === 'extruded-footprint') {
    assert.equal(primitive.topMeters, 10000, 'captured renderer height is never capped');
    assert.equal(primitive.rings[0].length, 7);
    const corner = projection.projectFlat(primitive.rings[0][0]);
    assert.ok(
      Math.abs(corner[1] - (origin[1] - 0.008)) < 1e-8,
      'uses renderer common-space origin, radius and coverage',
    );
  }
  assert.ok(Math.abs(envelope.frame.anchor[0] - 10) < 1e-6);
}
assert.equal(
  captureHexagonTarget(createPointTarget([0, 0]), runtime, {}, [{ col: 0, row: 0, elevationValue: 1, count: 1 }])
    .status,
  'unavailable',
);
const hidden = captureHexagonTarget(
  createPointTarget([10, 45]),
  runtime,
  {
    getSubLayers: () => [{ props: { ...cellProps, elevationCutoff: [0, 50] } }],
  },
  [{ col: 0, row: 0, elevationValue: 100, colorValue: 50, count: 1 }],
);
assert.equal(hidden.status, 'unavailable', 'hidden marks are not passed off as current rendered content');

const target = createPointTarget([1, 2], [{ rid: 7, longitude: 1, latitude: 2 }]);
assert.deepEqual(resolveCurrentTargetRows(target, [{ rid: 7, longitude: 1, latitude: 2, value: 99 }]), [
  { rid: 7, longitude: 1, latitude: 2, value: 99 },
]);
assert.deepEqual(
  resolveCurrentTargetRows(target, [{ rid: 8, longitude: 1, latitude: 2 }]),
  [],
  'missing stable object is not silently replaced by a neighbor',
);
assert.equal(
  resolveCurrentTargetRows(
    createRegionTarget([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ]),
    [
      { longitude: 1, latitude: 1 },
      { longitude: 3, latitude: 3 },
    ],
  ).length,
  1,
);

const datelineRegion = createRegionTarget([
  [179, 0],
  [-179, 0],
  [-179, 2],
  [179, 2],
]);

const buildingRuntime = {
  descriptor: {
    layerId: 'buildings',
    resolvedSupport: { producer: 'polygon-extrusion' },
    accessorIds: { getPolygon: 'buildingPolygon' },
  },
  data: [],
} as unknown as ResolvedLayerRuntime;
const buildingRegion = createRegionTarget([
  [0, 0],
  [2, 0],
  [2, 2],
  [0, 2],
]);
const buildingRows = [
  {
    id: 'inside',
    polygon: [
      [0.5, 0.5],
      [1, 0.5],
      [1, 1],
      [0.5, 1],
    ],
  },
  {
    id: 'crossing',
    polygon: [
      [-1, 0.5],
      [3, 0.5],
      [3, 1],
      [-1, 1],
    ],
  },
  {
    id: 'surrounding',
    polygon: [
      [-1, -1],
      [3, -1],
      [3, 3],
      [-1, 3],
    ],
  },
  {
    id: 'outside',
    polygon: [
      [3, 3],
      [4, 3],
      [4, 4],
      [3, 4],
    ],
  },
  {
    id: 'hole',
    polygon: [
      [
        [-1, -1],
        [3, -1],
        [3, 3],
        [-1, 3],
      ],
      [
        [-0.5, -0.5],
        [2.5, -0.5],
        [2.5, 2.5],
        [-0.5, 2.5],
      ],
    ],
  },
];
assert.deepEqual(
  resolveCurrentTargetRows(buildingRegion, buildingRows, buildingRuntime).map((row) => row.id),
  ['inside', 'crossing', 'surrounding'],
  'drawn regions select actual polygon footprints, including edge crossings and containment but excluding holes',
);
assert.deepEqual(
  resolveCurrentTargetRows(
    datelineRegion,
    [
      {
        id: 'wrapped-building',
        polygon: [
          [179.5, 0.5],
          [-179.5, 0.5],
          [-179.5, 1.5],
          [179.5, 1.5],
        ],
      },
      {
        id: 'distant-building',
        polygon: [
          [-1, 0.5],
          [1, 0.5],
          [1, 1.5],
          [-1, 1.5],
        ],
      },
    ],
    buildingRuntime,
  ).map((row) => row.id),
  ['wrapped-building'],
  'polygon region membership uses the same short longitude arc as point selection',
);
assert.deepEqual(
  resolveCurrentTargetRows(datelineRegion, [
    { id: 'east', longitude: 179.5, latitude: 1 },
    { id: 'west', longitude: -179.5, latitude: 1 },
    { id: 'outside', longitude: 0, latitude: 1 },
  ]).map((row) => row.id),
  ['east', 'west'],
  'region membership follows the short longitude arc across the date line',
);

const group = createPointTarget(
  [1, 2],
  [
    { rid: 7, longitude: 1, latitude: 2 },
    { rid: 8, longitude: 2, latitude: 2 },
  ],
);
assert.deepEqual(
  resolveCurrentTargetRows(group, [{ rid: 7, longitude: 1, latitude: 2 }]),
  [],
  'missing members must not silently turn a target into a subset',
);
const mixedRows = [
  { rid: 7, longitude: 1, latitude: 2 },
  { longitude: 2, latitude: 2 },
];
const mixedGroup = createPointTarget([1, 2], mixedRows);
assert.deepEqual(
  resolveCurrentTargetRows(mixedGroup, mixedRows),
  mixedRows,
  'mixed identity selections preserve positional members too',
);
assert.deepEqual(
  resolveCurrentTargetRows(mixedGroup, [mixedRows[0]]),
  [],
  'missing positional members do not silently shrink a mixed selection',
);
const remembered = rememberTargetSource(group, runtime);
assert.deepEqual(
  rememberTargetSource({ ...remembered, selectedRows: [] }, runtime).sourceFeatures,
  remembered.sourceFeatures,
  'refresh preserves stable identities even if the snapshot has no rows',
);

const mark = { col: 0, row: 0, elevationValue: 50, colorValue: 50, count: 2 };
for (const invisible of [{ colorValue: NaN }, { colorValue: 102 }, { elevationValue: 102 }]) {
  assert.equal(
    captureHexagonTarget(target, runtime, layer, [{ ...mark, ...invisible }]).status,
    'unavailable',
    'shader-hidden values must not be captured as rendered geometry',
  );
}
for (const props of [
  { ...cellProps, elevationDomain: [50, 50] },
  { ...cellProps, colorDomain: [50, 50] },
  { ...cellProps, elevationCutoff: [75, 25] },
]) {
  assert.equal(
    captureHexagonTarget(target, runtime, { getSubLayers: () => [{ props }] }, [mark]).status,
    'unavailable',
    'collapsed or reversed renderer ranges must not fabricate finite support',
  );
}
for (const scale of [{ elevationScaleType: 'quantile' }, { colorScaleType: 'ordinal' }]) {
  assert.equal(
    captureHexagonTarget(target, runtime, { ...layer, props: scale }, [mark]).status,
    'unsupported',
    'raw bins cannot stand in for transformed nonlinear renderer values',
  );
}

const wrapOrigin = projection.projectFlat([180.1, 1]);
const wrappedProps = { ...cellProps, hexOriginCommon: wrapOrigin };
const wrappedLayer = {
  getSubLayers: () => [{ props: wrappedProps }],
  state: { aggregator: { binCount: 1, getBin: () => ({ id: [0, 0], value: [50, 50], count: 2 }) } },
};
assert.equal(
  captureCurrentHexagonTarget(createPointTarget([-179.9, 1]), runtime, wrappedLayer).status,
  'ok',
  'refresh locates the same hexagon across a wrapped world copy',
);
assert.equal(
  captureCurrentHexagonTarget(datelineRegion, runtime, wrappedLayer).status,
  'ok',
  'rendered-bin membership uses the same wrapped polygon support as rows',
);

const oldRouteRow = {
  id: 'route',
  path: [
    [1, 2],
    [2, 3],
    [4, 2],
  ],
};
const newRouteRow = {
  id: 'route',
  path: [
    [10, 20],
    [12, 24],
    [14, 20],
  ],
};
const routeTarget = rememberTargetSource(createPathTarget(oldRouteRow.path, [oldRouteRow])!, runtime);
const pathRuntime = { ...runtime, descriptor: { ...runtime.descriptor, accessorIds: { getPath: 'tripPath' } } };
const refreshedRoute = refreshTargetGeometry(
  routeTarget,
  pathRuntime,
  resolveCurrentTargetRows(routeTarget, [newRouteRow]),
);
assert.equal(refreshedRoute.id, routeTarget.id, 'refresh preserves target identity');
assert.deepEqual(refreshedRoute.sourceFeatures, routeTarget.sourceFeatures, 'refresh preserves stable source identity');
assert.deepEqual(refreshedRoute.coordinates, newRouteRow.path, 'route geometry follows the latest stable-ID object');
assert.deepEqual(refreshedRoute.start, [10, 20]);
assert.deepEqual(refreshedRoute.end, [14, 20]);
assert.deepEqual(refreshedRoute.center, [12, 22]);
assert.deepEqual(refreshedRoute.bbox, [10, 20, 14, 24]);
assert.ok(refreshedRoute.stats!.pathLengthKm! > routeTarget.stats!.pathLengthKm!);
assert.deepEqual(routeTarget.coordinates, oldRouteRow.path, 'refresh does not mutate the saved target snapshot');

const lineRuntime = {
  ...runtime,
  descriptor: {
    ...runtime.descriptor,
    accessorIds: {
      getSourcePosition: 'commuteSource',
      getTargetPosition: 'commuteTarget',
    },
  },
};
const line = refreshTargetGeometry(routeTarget, lineRuntime, [
  { id: 'route', residence_lng: 30, residence_lat: 40, workplace_lng: 35, workplace_lat: 42 },
]);
assert.deepEqual(
  line.coordinates,
  [
    [30, 40],
    [35, 42],
  ],
  'line geometry uses renderer source and destination accessors',
);

const pointRuntime = { ...runtime, descriptor: { ...runtime.descriptor, accessorIds: { getPosition: 'coordinates' } } };
const movedPoint = refreshTargetGeometry(target, pointRuntime, [{ rid: 7, coordinates: [20, 30] }]);
assert.deepEqual(
  movedPoint.center,
  [20, 30],
  'point refresh reads configured accessor rather than stale longitude fields',
);
assert.deepEqual(movedPoint.coordinates, [[20, 30]]);
const preservedRegion = refreshTargetGeometry(datelineRegion, pointRuntime, [{ coordinates: [179.5, 1] }]);
assert.deepEqual(
  preservedRegion.coordinates,
  datelineRegion.coordinates,
  'region refresh retains author-drawn selection scope',
);
assert.throws(
  () =>
    refreshTargetGeometry(routeTarget, pathRuntime, [
      {
        id: 'route',
        path: [
          [10, 20],
          [NaN, 25],
        ],
      },
    ]),
  /coordinate|geometry/i,
  'invalid updated routes must not silently drop vertices',
);

function makeLargeGrid(radius = 0.01, useLayerRange = false) {
  const range = [
    [-500, 500],
    [-500, 500],
  ];
  const gridProps = { ...cellProps, radius };
  const reads: number[] = [];
  return {
    reads,
    layer: {
      getSubLayers: () => [{ props: gridProps }],
      state: {
        aggregatorType: 'gpu',
        binIdRange: range,
        aggregator: {
          props: useLayerRange ? {} : { binIdRange: range },
          binCount: 1_000_000,
          getBin: (index: number) => {
            assert.ok(index >= 0 && index < 1_000_000, 'query stays in the current GPU grid');
            reads.push(index);
            return { id: [(index % 1000) - 500, Math.floor(index / 1000) - 500], value: [50, 50], count: 2 };
          },
        },
      },
    },
  };
}
const largePointGrid = makeLargeGrid();
assert.equal(
  captureCurrentHexagonTarget(createPointTarget([10, 45]), runtime, largePointGrid.layer).status,
  'ok',
  'a single cell can be refreshed in a million-cell GPU grid',
);
assert.ok(largePointGrid.reads.length <= 9, 'point refresh reads only neighboring cells');
const regionCorners = [
  [origin[0] - 0.012, origin[1] - 0.012],
  [origin[0] + 0.012, origin[1] - 0.012],
  [origin[0] + 0.012, origin[1] + 0.012],
  [origin[0] - 0.012, origin[1] + 0.012],
].map((position) => projection.unprojectFlat(position));
const largeRegionGrid = makeLargeGrid();
const boundedRegion = captureCurrentHexagonTarget(createRegionTarget(regionCorners), runtime, largeRegionGrid.layer);
assert.equal(boundedRegion.status, 'ok', 'small region queries bound the current grid before applying the work budget');
assert.ok(largeRegionGrid.reads.length <= 25, 'region refresh reads a local grid subset');

const oldRadiusGrid = makeLargeGrid(0.01);
const movedAnchor = projection.unprojectFlat([origin[0] + 4 * 0.01 * Math.sqrt(3), origin[1]]);
const cellTarget = createPointTarget(movedAnchor);
assert.equal(captureCurrentHexagonTarget(cellTarget, runtime, oldRadiusGrid.layer).status, 'ok');
const newRadiusGrid = makeLargeGrid(0.02, true);
const resizedCell = captureCurrentHexagonTarget(cellTarget, runtime, newRadiusGrid.layer);
assert.equal(resizedCell.status, 'ok', 'radius changes recompute the query from the selection anchor');
assert.ok(
  newRadiusGrid.reads.includes(500 * 1000 + 502),
  'new radius resolves column 2 rather than retaining old column 4',
);
assert.ok(newRadiusGrid.reads.length <= 9);

const seamGrid = makeLargeGrid();
seamGrid.layer.getSubLayers = () => [{ props: { ...cellProps, hexOriginCommon: projection.projectFlat([180, 1]) } }];
const seamRegion = createRegionTarget([
  [179.99, 0.99],
  [-179.99, 0.99],
  [-179.99, 1.01],
  [179.99, 1.01],
]);
assert.equal(
  captureCurrentHexagonTarget(seamRegion, runtime, seamGrid.layer).status,
  'ok',
  'bounded grid queries retain polygons crossing the date line',
);
assert.ok(seamGrid.reads.length <= 25);

const changedGrid = makeLargeGrid();
changedGrid.layer.state.aggregator.getBin = () => ({ id: [9999, 9999], value: [50, 50], count: 2 });
assert.equal(
  captureCurrentHexagonTarget(createPointTarget([10, 45]), runtime, changedGrid.layer).status,
  'unavailable',
  'a mismatched returned bin ID is rejected rather than captured through a stale index',
);

const largeCpuGrid = {
  ...largePointGrid.layer,
  state: {
    aggregator: {
      binCount: 20001,
      getBin: () => {
        throw new Error('must not enumerate over budget');
      },
    },
  },
};
assert.equal(
  captureCurrentHexagonTarget(createPointTarget([10, 45]), runtime, largeCpuGrid).status,
  'unavailable',
  'unindexed CPU aggregation remains explicitly bounded',
);
