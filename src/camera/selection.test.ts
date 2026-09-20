import {
  appendUniqueTargetHistory,
  createHeatmapZoneTarget,
  createMultipleTarget,
  createRegionTarget,
  enrichCameraTargetStats,
  getHexagonPickedCoordinate,
  filterRowsInsideAnalyticsBounds,
  createPointTarget,
  createTargetFromView,
  getLatestComparisonPair,
  getTargetIdentity,
} from './selection';
import type { CustomObject, CameraView } from '../interfaces';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

const VIEW: CameraView = {
  longitude: 114.2,
  latitude: 22.4,
  zoom: 10,
  pitch: 0,
  bearing: 0,
};

function testReturnsUndefinedForFewerThanTwoDistinctTargets() {
  const a = createPointTarget([114.1, 22.3]);
  assert(getLatestComparisonPair([]) === undefined, 'empty history should have no pair');
  assert(getLatestComparisonPair([a]) === undefined, 'single selection should have no pair');

  const aAgain = createPointTarget([114.1, 22.3]);
  assert(
    getLatestComparisonPair([a, aAgain]) === undefined,
    'selecting the same target twice should collapse to one distinct target',
  );
}

function testPairIsLatestTwoDistinctSelectionsInOrder() {
  const a = createPointTarget([114.1, 22.3]);
  const b = createPointTarget([114.3, 22.5]);
  const c = createPointTarget([114.5, 22.7]);
  const pair = getLatestComparisonPair([a, b, c]);

  assert(pair !== undefined, 'three distinct selections should produce a pair');
  assert(getTargetIdentity(pair![0]) === getTargetIdentity(b), 'slot A should be the earlier of the latest two');
  assert(getTargetIdentity(pair![1]) === getTargetIdentity(c), 'slot B should be the newest selection');
}

function testReselectingSameTargetKeepsNearestDistinctPartner() {
  const a = createPointTarget([114.1, 22.3]);
  const b = createPointTarget([114.3, 22.5]);
  const aAgain = createPointTarget([114.1, 22.3]);
  const pair = getLatestComparisonPair([a, b, aAgain]);

  assert(pair !== undefined, 're-selection should still produce a pair');
  assert(
    getTargetIdentity(pair![0]) === getTargetIdentity(b),
    'slot A should be the nearest earlier target with a different identity',
  );
  assert(getTargetIdentity(pair![1]) === getTargetIdentity(aAgain), 'slot B should stay the newest selection');
}

function testNoneTargetsAreSkipped() {
  const a = createPointTarget([114.1, 22.3]);
  const none = createTargetFromView(VIEW, 'none');
  const b = createPointTarget([114.3, 22.5]);
  const pair = getLatestComparisonPair([a, none, b]);

  assert(pair !== undefined, 'none entries should not block the pair');
  assert(getTargetIdentity(pair![0]) === getTargetIdentity(a), 'slot A should skip none targets');
  assert(getTargetIdentity(pair![1]) === getTargetIdentity(b), 'slot B should be the newest non-none selection');

  const trailingNone = getLatestComparisonPair([a, b, none]);
  assert(trailingNone !== undefined, 'a trailing none entry should not block the pair');
  assert(
    getTargetIdentity(trailingNone![1]) === getTargetIdentity(b),
    'slot B should be the newest non-none selection even when none is last',
  );
}

function testUniqueHistoryKeepsDistinctPartnerAcrossRepeatedSelections() {
  const a = createPointTarget([114.1, 22.3]);
  const b = createPointTarget([114.3, 22.5]);
  let history = appendUniqueTargetHistory([], a, 8);
  history = appendUniqueTargetHistory(history, b, 8);

  for (let index = 0; index < 10; index += 1) {
    history = appendUniqueTargetHistory(history, createPointTarget([114.3, 22.5]), 8);
  }

  const pair = getLatestComparisonPair(history);
  assert(history.length === 2, 'repeated identities should replace their previous history entry');
  assert(pair !== undefined, 'repeating the newest selection should not evict its distinct partner');
  assert(getTargetIdentity(pair![0]) === getTargetIdentity(a), 'slot A should keep the earlier distinct target');
  assert(getTargetIdentity(pair![1]) === getTargetIdentity(b), 'slot B should keep the latest target identity');
}

function testUniqueHistoryMovesReselectedIdentityToNewestSlotAndSkipsNone() {
  const a = createPointTarget([114.1, 22.3]);
  const b = createPointTarget([114.3, 22.5]);
  const none = createTargetFromView(VIEW, 'none');
  let history = appendUniqueTargetHistory([a, b], none, 8);
  history = appendUniqueTargetHistory(history, createPointTarget([114.1, 22.3]), 8);

  const pair = getLatestComparisonPair(history);
  assert(history.length === 2, 'none targets should not enter selection history');
  assert(pair !== undefined, 'two distinct identities should remain available');
  assert(getTargetIdentity(pair![0]) === getTargetIdentity(b), 'the untouched target should become slot A');
  assert(getTargetIdentity(pair![1]) === getTargetIdentity(a), 'the reselected identity should move to slot B');
}

function testUniqueHistoryHonorsZeroCapacity() {
  const history = appendUniqueTargetHistory([], createPointTarget([114.1, 22.3]), 0);
  assert(history.length === 0, 'a zero-capacity history should remain empty');
}

testReturnsUndefinedForFewerThanTwoDistinctTargets();
testPairIsLatestTwoDistinctSelectionsInOrder();
testReselectingSameTargetKeepsNearestDistinctPartner();
testNoneTargetsAreSkipped();
testUniqueHistoryKeepsDistinctPartnerAcrossRepeatedSelections();
testUniqueHistoryMovesReselectedIdentityToNewestSlotAndSkipsNone();
testUniqueHistoryHonorsZeroCapacity();

function assertClose(actual: number, expected: number, message: string) {
  assert(Math.abs(actual - expected) < 1e-6, `${message}: expected ${expected}, received ${actual}`);
}

function assertCloseWithin(actual: number, expected: number, tolerance: number, message: string) {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected.toFixed(2)} +/- ${tolerance.toFixed(2)}, received ${actual.toFixed(2)}`,
  );
}

function createHexagonAnalytics(maxClusterCount = 650) {
  return {
    layers: [
      {
        id: 'hexagon-layer',
        kind: 'hexagon' as const,
        rowCount: 100000,
        bbox: [-8, 49, 2, 61] as [number, number, number, number],
        bboxAreaKm2: 900000,
        radiusMeters: 1500,
        maxClusterCount,
        maxElevationValue: maxClusterCount,
        elevationScale: 250,
        elevationRange: [0, 1000] as [number, number],
        elevationDomain: [0, maxClusterCount] as [number, number],
        maxElevationMeters: 250000,
      },
    ],
    primaryLayer: {
      id: 'hexagon-layer',
      kind: 'hexagon' as const,
      rowCount: 100000,
      bbox: [-8, 49, 2, 61] as [number, number, number, number],
      bboxAreaKm2: 900000,
      radiusMeters: 1500,
      maxClusterCount,
      maxElevationValue: maxClusterCount,
      elevationScale: 250,
      elevationRange: [0, 1000] as [number, number],
      elevationDomain: [0, maxClusterCount] as [number, number],
      maxElevationMeters: 250000,
    },
    combinedBbox: [-8, 49, 2, 61] as [number, number, number, number],
    combinedBboxAreaKm2: 900000,
  };
}

function createHexagonTarget(longitude: number, latitude: number, count: number, maxClusterCount = 650) {
  return enrichCameraTargetStats(
    createPointTarget(
      [longitude, latitude],
      Array.from({ length: Math.max(1, Math.min(count, 20)) }, () => ({ longitude, latitude })),
    ),
    {
      analytics: createHexagonAnalytics(maxClusterCount),
      pickedObject: {
        position: [longitude, latitude],
        count,
      },
    },
  );
}

function testVisualFrameAreaRatioUsesExpandedVisualFrame() {
  const target = enrichCameraTargetStats(createPointTarget([-1.4, 52.2]), {
    analytics: {
      layers: [
        {
          id: 'hexagon',
          kind: 'hexagon',
          rowCount: 100,
          bbox: [-2, 51.5, -1, 52.8],
          bboxAreaKm2: 10000,
          radiusMeters: 25000,
          maxClusterCount: 20,
          maxElevationValue: 20,
        },
      ],
      combinedBbox: [-2, 51.5, -1, 52.8],
      combinedBboxAreaKm2: 10000,
    },
    pickedObject: {
      position: [-1.4, 52.2],
      count: 10,
    },
  });
  const stats = target.stats as unknown as Record<string, number | undefined>;

  assert(
    Number(stats.visualAreaRatio) > Number(stats.bboxAreaRatio),
    'visual area ratio should reflect the expanded visual frame, not just the raw point bbox',
  );
  assert(
    Number(stats.referenceAreaKm2) === 10000,
    'visual area ratio should record the dataset reference area used for adaptation',
  );
}

function testMultipleTargetAreaRatioUsesMergedVisualExtent() {
  const firstTarget = {
    ...createPointTarget([-1.4, 52.2]),
    stats: {
      count: 1,
      bboxAreaRatio: 0.01,
      visualAreaRatio: 0.01,
      referenceAreaKm2: 10000,
    },
  };
  const secondTarget = {
    ...createPointTarget([1.4, 55.2]),
    stats: {
      count: 1,
      bboxAreaRatio: 0.01,
      visualAreaRatio: 0.01,
      referenceAreaKm2: 10000,
    },
  };
  const combinedTarget = createMultipleTarget([firstTarget, secondTarget]);
  const stats = combinedTarget.stats as unknown as Record<string, number | undefined>;

  assert(
    Number(stats.visualAreaRatio) > 0.01,
    'multiple target visual area ratio should be based on the merged visual extent',
  );
}

function testMultipleTargetRecordsDispersionRatio() {
  const firstTarget = createPointTarget([-1.4, 52.2]);
  const secondTarget = createPointTarget([1.4, 55.2]);
  const combinedTarget = createMultipleTarget([firstTarget, secondTarget]);
  const stats = combinedTarget.stats as unknown as Record<string, number | undefined>;

  assert(Number(stats.dispersionRatio) > 0, 'multiple target should record dispersion ratio from merged extent');
}

function testRegionTargetUsesDataAnchorWithoutShrinkingVisualBbox() {
  const target = createRegionTarget(
    [
      [-2, 52],
      [-1, 52],
      [-1, 53],
      [-2, 53],
    ],
    [
      { longitude: -1.95, latitude: 52.9, weight: 1 },
      { longitude: -1.93, latitude: 52.92, weight: 1 },
      { longitude: -1.91, latitude: 52.94, weight: 1 },
    ],
  );

  assertClose(target.center[0], -1.5, 'region center should remain the full geometry/data bbox center longitude');
  assertClose(target.center[1], 52.5, 'region center should remain the full geometry/data bbox center latitude');
  assert(
    target.visualFrame?.anchor?.[0] !== target.center[0],
    'region visual anchor should move to selected data centroid when enough rows are selected',
  );
  assert(
    (target.visualFrame?.bbox[0] ?? 0) <= -2 && (target.visualFrame?.bbox[2] ?? 0) >= -1,
    'region visual bbox should preserve the full drawn geometry extent',
  );
}

function testHeatmapZoneTargetUsesRadiusAndWeightedAnchor() {
  const target = createHeatmapZoneTarget({
    clickedLngLat: [-1.5, 52.5],
    rows: [
      { longitude: -1.5, latitude: 52.5, weight: 1 },
      { longitude: -1.49, latitude: 52.5, weight: 10 },
      { longitude: -1.0, latitude: 52.5, weight: 100 },
    ],
    radiusMeters: 1200,
    getWeight: (row: CustomObject) => Number(row.weight),
  });

  assert(target.type === 'region', 'heatmap zone target should reuse region camera behavior');
  assert(target.selectedRows?.length === 2, 'heatmap zone should select rows inside the radius window');
  assert(
    (target.visualFrame?.anchor?.[0] ?? -Infinity) > -1.5,
    'heatmap zone anchor should move toward higher weighted nearby rows',
  );
  assert(
    (target.visualFrame?.bbox[0] ?? 0) < -1.5 && (target.visualFrame?.bbox[2] ?? 0) > -1.49,
    'heatmap zone visual bbox should expand by the heat radius',
  );
}

function testHexagonFramingRetainsActualRenderedHeight() {
  const tallTarget = createHexagonTarget(-0.117, 51.511, 650, 650);
  const midTarget = createHexagonTarget(-1.89, 52.479, 131, 650);
  const lowTarget = createHexagonTarget(-2.5, 53.0, 5, 650);

  // Framing now describes the rendered geometry even when this requires a very wide view.
  assertClose(
    tallTarget.visualFrame?.heightMeters ?? Number.NaN,
    250000,
    'tall hexagon framing height should retain rendered height',
  );
  assertCloseWithin(
    tallTarget.visualFrame?.heightMeters ?? Number.NaN,
    tallTarget.stats?.selectedElevationMeters ?? Number.NaN,
    0.01,
    'tall hexagon should use the actual height',
  );
  assertCloseWithin(
    midTarget.visualFrame?.heightMeters ?? Number.NaN,
    midTarget.stats?.selectedElevationMeters ?? Number.NaN,
    0.01,
    'mid hexagon should use the actual height',
  );
  assert(
    (lowTarget.visualFrame?.heightMeters ?? Infinity) < 3000,
    'low hexagon rendering should retain its natural height',
  );
  assert(lowTarget.stats?.heightOverflowRatio === undefined, 'low hexagon should not record an overflow ratio');
}

function testHexagonPickedCoordinateFallsBackWhenLayerPositionIsOutsideDataBounds() {
  const coordinate = getHexagonPickedCoordinate(
    {
      position: [-179.036, -85.448],
      count: 2,
      points: [
        { longitude: -1.9, latitude: 52.47 },
        { longitude: -1.88, latitude: 52.49 },
      ],
    },
    createHexagonAnalytics(),
  );

  if (!coordinate) {
    throw new Error('hexagon coordinate should be resolved from picked rows');
  }
  assertClose(coordinate[0], -1.89, 'invalid hexagon layer longitude should fall back to picked row centroid');
  assertClose(coordinate[1], 52.48, 'invalid hexagon layer latitude should fall back to picked row centroid');
}

function testHexagonPickedCoordinateUsesClickCoordinateForGpuAggregatedPicks() {
  // GPU-aggregated hexagon picks carry no source points and can report a garbage position at the
  // Mercator world corner; without the click-coordinate fallback every selection collapsed onto the
  // same bogus location, so every emphasis camera stared at the same place.
  const coordinate = getHexagonPickedCoordinate(
    {
      position: [-179.918, -85.524],
      count: 131,
    },
    createHexagonAnalytics(),
    [-1.8901, 52.4791],
  );

  if (!coordinate) {
    throw new Error('hexagon coordinate should be resolved from the click coordinate');
  }
  assertClose(coordinate[0], -1.8901, 'garbage GPU pick should fall back to the clicked longitude');
  assertClose(coordinate[1], 52.4791, 'garbage GPU pick should fall back to the clicked latitude');
}

function testFilterRowsInsideAnalyticsBoundsDropsPickingArtifacts() {
  const rows = [{ position: [-179.918, -85.524], count: 131 }, { longitude: -1.89, latitude: 52.479 }, { count: 5 }];
  const filtered = filterRowsInsideAnalyticsBounds(rows, createHexagonAnalytics());

  assert(filtered.length === 2, `out-of-bounds picking artifacts should be dropped, kept ${filtered.length} rows`);
  assert(
    filtered.every((row) => row.position === undefined),
    'the garbage-position row should be removed while coordinate-less rows are kept',
  );
  assert(
    filterRowsInsideAnalyticsBounds(rows, undefined).length === 3,
    'rows should pass through unchanged when analytics bounds are unavailable',
  );
}

testVisualFrameAreaRatioUsesExpandedVisualFrame();
testMultipleTargetAreaRatioUsesMergedVisualExtent();
testMultipleTargetRecordsDispersionRatio();
testRegionTargetUsesDataAnchorWithoutShrinkingVisualBbox();
testHeatmapZoneTargetUsesRadiusAndWeightedAnchor();
testHexagonFramingRetainsActualRenderedHeight();
testHexagonPickedCoordinateFallsBackWhenLayerPositionIsOutsideDataBounds();
testHexagonPickedCoordinateUsesClickCoordinateForGpuAggregatedPicks();
testFilterRowsInsideAnalyticsBoundsDropsPickingArtifacts();
