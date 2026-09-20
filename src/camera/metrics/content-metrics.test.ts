import type { CameraCalibrationConfig } from '../../visualization/types';
import { computeContentMetrics, normLog } from './content-metrics';
import type { ContentMetricInput } from './content-metrics';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertClose(actual: number, expected: number, tolerance: number, message: string): void {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, received ${actual}`);
}

function assertNamedFieldError(run: () => unknown, field: string): void {
  try {
    run();
  } catch (error) {
    assert(error instanceof Error, `${field} must throw an Error`);
    assert(error.name === 'ContentMetricInputError', `${field} must use the named metric input error`);
    assert(error.message.includes(field), `${field} must be present in ${JSON.stringify(error.message)}`);
    return;
  }
  throw new Error(`${field} must throw`);
}

function makeCalibration(
  patch: Partial<CameraCalibrationConfig> = {},
  metricPatch: Partial<CameraCalibrationConfig['metrics']> = {},
): CameraCalibrationConfig {
  return {
    version: 7,
    referenceZoom: 8,
    referenceSafeAreaPx: 100,
    metrics: {
      elevation: { unit: 'meters', lo: 10, hi: 10_000, source: 'test' },
      density: { unit: 'count/km2', lo: 1, hi: 1_000, source: 'test' },
      aspect: { unit: 'ratio', lo: 1, hi: 8, source: 'test' },
      ...metricPatch,
    },
    ...patch,
  };
}

function makeMetricInput(patch: Partial<ContentMetricInput> = {}): ContentMetricInput {
  return {
    actualHeightsMeters: [],
    density: { hasAccessor: false, count: 1 },
    members: { count: 1 },
    calibration: makeCalibration(),
    ...patch,
  };
}

function testStrictNormLog(): void {
  assert(normLog(10, 10, 10_000) === 0, 'lower calibration bound');
  assert(normLog(10_000, 10, 10_000) === 1, 'upper calibration bound');
  assertClose(
    normLog(100, 10, 10_000),
    (Math.log1p(100) - Math.log1p(10)) / (Math.log1p(10_000) - Math.log1p(10)),
    1e-15,
    'normLog must use log1p',
  );
  assert(normLog(0, 10, 10_000) === 0, 'normLog clamps below the lower bound');
  assert(normLog(100_000, 10, 10_000) === 1, 'normLog clamps above the upper bound');
  const hugeLo = 1e16;
  const hugeHi = hugeLo + 8;
  const hugeMid = hugeLo + 4;
  assertClose(
    normLog(hugeMid, hugeLo, hugeHi),
    Math.log1p((hugeMid - hugeLo) / (1 + hugeLo)) / Math.log1p((hugeHi - hugeLo) / (1 + hugeLo)),
    1e-14,
    'normLog remains stable for large close finite bounds',
  );

  assertNamedFieldError(() => normLog(Number.NaN, 0, 1), 'normLog.value');
  assertNamedFieldError(() => normLog(-1, 0, 1), 'normLog.value');
  assertNamedFieldError(() => normLog(1, -1, 2), 'normLog.lo');
  assertNamedFieldError(() => normLog(1, 1, 1), 'normLog.hi');
}

function testType7P95AndInputImmutability(): void {
  const heights = [19, 0, 5, 18, 1, 17, 2, 16, 3, 15, 4, 14, 6, 13, 7, 12, 8, 11, 9, 10];
  const input = makeMetricInput({
    actualHeightsMeters: heights,
    calibration: makeCalibration({}, { elevation: { unit: 'meters', lo: 0, hi: 100, source: 'test' } }),
  });
  const before = JSON.stringify(input);
  const metrics = computeContentMetrics(input);

  assertClose(metrics.elevation, normLog(18.05, 0, 100), 1e-14, 'P95 must use Hyndman-Fan Type 7 interpolation');
  assert(JSON.stringify(input) === before, 'metric computation must not mutate its input');
  assert(metrics.calibrationVersion === 7, 'calibrationVersion must preserve the numeric catalog version');
  assert(computeContentMetrics(makeMetricInput({ actualHeightsMeters: [] })).elevation === 0, '2D fallback');
}

function testIntroselectAvoidsPathologicalPartitionDepth(): void {
  const count = 50_000;
  const sorted = Array.from({ length: count }, (_, index) => index);
  const reverse = Array.from({ length: count }, (_, index) => count - 1 - index);
  const half = count / 2;
  const organPipe = [
    ...Array.from({ length: half }, (_, index) => index + 1),
    ...Array.from({ length: half }, (_, index) => half - index),
  ];
  const calibration = makeCalibration({}, { elevation: { unit: 'meters', lo: 0, hi: count, source: 'test' } });
  const sortedMetric = computeContentMetrics(makeMetricInput({ actualHeightsMeters: sorted, calibration }));
  const reverseMetric = computeContentMetrics(makeMetricInput({ actualHeightsMeters: reverse, calibration }));
  const organPipeMetric = computeContentMetrics(makeMetricInput({ actualHeightsMeters: organPipe, calibration }));
  assertClose(sortedMetric.elevation, normLog(47_499.05, 0, count), 1e-14, 'sorted Type-7 P95');
  assertClose(reverseMetric.elevation, sortedMetric.elevation, 1e-14, 'reverse Type-7 P95');
  assertClose(organPipeMetric.elevation, normLog(23_750.05, 0, count), 1e-14, 'median-of-three killer P95');
}

function testIndependentDensitySources(): void {
  const world = computeContentMetrics(
    makeMetricInput({ density: { hasAccessor: true, count: 100, targetWorldAreaKm2: 10 } }),
  );
  assertClose(world.density, normLog(10, 1, 1_000), 1e-15, 'world density uses count per square kilometre');

  const screen = computeContentMetrics(
    makeMetricInput({ density: { hasAccessor: true, count: 2, glyphSupportAreasAtReferenceZoomPx2: [30, 20] } }),
  );
  assertClose(screen.density, 0.5, 1e-15, 'screen density uses the calibration safe area');

  const maximum = computeContentMetrics(
    makeMetricInput({
      density: {
        hasAccessor: true,
        count: 1_000,
        targetWorldAreaKm2: 10,
        glyphSupportAreasAtReferenceZoomPx2: [60],
      },
    }),
  );
  assertClose(maximum.density, Math.max(normLog(100, 1, 1_000), 0.6), 1e-15, 'density uses the maximum source');

  const disabled = computeContentMetrics(
    makeMetricInput({
      density: {
        hasAccessor: false,
        count: 10_000,
        targetWorldAreaKm2: 1,
        glyphSupportAreasAtReferenceZoomPx2: [100],
      },
    }),
  );
  assert(disabled.density === 0, 'no density accessor forces zero density');
  assert(disabled.fallbackReasons.includes('no-density-accessor'), 'no density accessor is diagnosed');

  const missing = computeContentMetrics(makeMetricInput({ density: { hasAccessor: true, count: 5 } }));
  assert(missing.density === 0, 'missing independent density sources fall back to zero');
  assert(missing.fallbackReasons.includes('missing-density-support'), 'missing density support is diagnosed');

  const degenerate = computeContentMetrics(
    makeMetricInput({ density: { hasAccessor: true, count: 5, targetWorldAreaKm2: 0 } }),
  );
  assert(degenerate.fallbackReasons.includes('degenerate-density-area'), 'zero world area is diagnosed');

  const compensatedAreas = [1e16, 1, 1];
  const compensatedSafeArea = 1e16 + 4;
  const compensated = computeContentMetrics(
    makeMetricInput({
      density: {
        hasAccessor: true,
        count: 3,
        glyphSupportAreasAtReferenceZoomPx2: compensatedAreas,
      },
      calibration: makeCalibration({ referenceSafeAreaPx: compensatedSafeArea }),
    }),
  );
  const compensatedExpected = (1e16 + 2) / compensatedSafeArea;
  const naiveRatio = compensatedAreas.reduce((sum, area) => sum + area, 0) / compensatedSafeArea;
  assert(compensated.density === compensatedExpected, 'screen density uses compensated support-area summation');
  assert(compensated.density !== naiveRatio, 'compensated support sum must differ from naive loss of small areas');
}

function testCoverageUsesSameUnitSupportAreas(): void {
  const metrics = computeContentMetrics(
    makeMetricInput({ coverage: { targetProjectedArea: 25, sceneContextProjectedArea: 100 } }),
  );
  assertClose(metrics.coverage, 0.25, 1e-15, 'coverage is the same-projection support-union area ratio');

  const clamped = computeContentMetrics(
    makeMetricInput({ coverage: { targetProjectedArea: 120, sceneContextProjectedArea: 100 } }),
  );
  assert(clamped.coverage === 1, 'coverage clamps support ratios above one');

  const missing = computeContentMetrics(makeMetricInput());
  assert(missing.coverage === 0, 'missing scene context falls back to zero');
  assert(missing.fallbackReasons.includes('missing-scene-context'), 'missing scene context is diagnosed');

  const degenerate = computeContentMetrics(
    makeMetricInput({ coverage: { targetProjectedArea: 1, sceneContextProjectedArea: 0 } }),
  );
  assert(
    degenerate.coverage === 0 && degenerate.fallbackReasons.includes('degenerate-scene-context'),
    'degenerate scene fallback',
  );
}

function testNormalizedCentroidSpreadAndPopulationAreaCv(): void {
  const diagonal = computeContentMetrics(
    makeMetricInput({
      members: {
        count: 2,
        centroidsProjected: [
          [100, 200],
          [200, 300],
        ],
        projectedAreas: [5, 5],
      },
    }),
  );
  assertClose(diagonal.dispersion, 0.7, 1e-15, 'diagonal normalized-centroid RMS reaches unit spread');

  const degenerateAxis = computeContentMetrics(
    makeMetricInput({
      members: {
        count: 2,
        centroidsProjected: [
          [3, 0],
          [3, 10],
        ],
        projectedAreas: [1, 1],
      },
    }),
  );
  assertClose(degenerateAxis.dispersion, 0.7 / Math.sqrt(2), 1e-15, 'a degenerate centroid axis maps to 0.5');

  const areaCv = computeContentMetrics(
    makeMetricInput({
      members: {
        count: 2,
        centroidsProjected: [
          [0, 0],
          [0, 0],
        ],
        projectedAreas: [1, 3],
      },
    }),
  );
  assertClose(areaCv.dispersion, 0.15, 1e-15, 'population area CV contributes 30 percent');

  const hugeAreas = computeContentMetrics(
    makeMetricInput({
      members: {
        count: 2,
        centroidsProjected: [
          [0, 0],
          [0, 0],
        ],
        projectedAreas: [Number.MAX_VALUE / 2, Number.MAX_VALUE],
      },
    }),
  );
  assertClose(hugeAreas.dispersion, 0.1, 1e-14, 'area CV remains finite for very large finite areas');

  const tinyAreas = computeContentMetrics(
    makeMetricInput({
      members: {
        count: 2,
        centroidsProjected: [
          [0, 0],
          [0, 0],
        ],
        projectedAreas: [1e-300, 3e-300],
      },
    }),
  );
  assertClose(tinyAreas.dispersion, 0.15, 1e-15, 'positive area CV is scale-independent below absolute epsilon');

  const extremeCentroids = computeContentMetrics(
    makeMetricInput({
      members: {
        count: 2,
        centroidsProjected: [
          [-Number.MAX_VALUE, -Number.MAX_VALUE],
          [Number.MAX_VALUE, Number.MAX_VALUE],
        ],
        projectedAreas: [1, 1],
      },
    }),
  );
  assertClose(extremeCentroids.dispersion, 0.7, 1e-14, 'finite extreme centroid AABB normalization stays finite');

  const subnormalCentroids = computeContentMetrics(
    makeMetricInput({
      members: {
        count: 2,
        centroidsProjected: [
          [Number.MIN_VALUE, 0],
          [2 * Number.MIN_VALUE, 0],
        ],
        projectedAreas: [1, 1],
      },
    }),
  );
  assertClose(
    subnormalCentroids.dispersion,
    0.7 / Math.sqrt(2),
    1e-15,
    'same-sign subnormal centroid bounds retain their full normalized extent',
  );

  const adjacentLarge = 1e16;
  const adjacentLargeCentroids = computeContentMetrics(
    makeMetricInput({
      members: {
        count: 2,
        centroidsProjected: [
          [adjacentLarge, adjacentLarge],
          [adjacentLarge + 2, adjacentLarge + 2],
        ],
        projectedAreas: [1, 1],
      },
    }),
  );
  assertClose(
    adjacentLargeCentroids.dispersion,
    0.7,
    1e-14,
    'same-sign adjacent-ULP centroid bounds map exactly to zero and one',
  );

  const single = computeContentMetrics(
    makeMetricInput({ members: { count: 1, centroidsProjected: [[0, 0]], projectedAreas: [1] } }),
  );
  assert(single.dispersion === 0, 'single target fallback');
  assert(single.fallbackReasons.includes('single-target'), 'single target is diagnosed');
}

function testStablePcaOrientationAndOrientedExtents(): void {
  const north = computeContentMetrics(
    makeMetricInput({
      footprintProjectedPoints: [
        [0, -2],
        [0, 0],
        [0, 2],
      ],
    }),
  );
  assertClose(north.orientationDeg ?? Number.NaN, 0, 1e-12, 'north PCA bearing');
  assert(north.elongation === 1, 'zero-width north line uses the limiting maximum aspect');

  const east = computeContentMetrics(
    makeMetricInput({
      footprintProjectedPoints: [
        [-2, 0],
        [0, 0],
        [2, 0],
      ],
    }),
  );
  assertClose(east.orientationDeg ?? Number.NaN, 90, 1e-12, 'east PCA bearing is canonical at positive 90');

  const diagonal = computeContentMetrics(
    makeMetricInput({
      footprintProjectedPoints: [
        [-2, -2],
        [0, 0],
        [2, 2],
      ],
    }),
  );
  assertClose(diagonal.orientationDeg ?? Number.NaN, 45, 1e-12, 'diagonal PCA bearing');

  const rectangle = computeContentMetrics(
    makeMetricInput({
      footprintProjectedPoints: [
        [-4, -1],
        [4, -1],
        [4, 1],
        [-4, 1],
      ],
    }),
  );
  assertClose(rectangle.orientationDeg ?? Number.NaN, 90, 1e-12, 'east-west rectangle bearing');
  assertClose(rectangle.elongation, normLog(4, 1, 8), 1e-14, 'elongation uses exact PCA-oriented extents');

  const circleLike = computeContentMetrics(
    makeMetricInput({
      footprintProjectedPoints: [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ],
    }),
  );
  assert(circleLike.elongation === 0 && circleLike.orientationDeg === undefined, 'near-circle PCA is suppressed');
  assert(circleLike.fallbackReasons.includes('near-circular-footprint'), 'near-circle suppression is diagnosed');

  const rectangleForAnisotropy = (anisotropy: number): readonly (readonly [number, number])[] => {
    const halfWidth = Math.sqrt((1 + anisotropy) / (1 - anisotropy));
    return [
      [-halfWidth, -1],
      [halfWidth, -1],
      [halfWidth, 1],
      [-halfWidth, 1],
    ];
  };
  const belowThreshold = computeContentMetrics(
    makeMetricInput({ footprintProjectedPoints: rectangleForAnisotropy(0.05 - 1e-12) }),
  );
  assert(
    belowThreshold.elongation === 0 && belowThreshold.orientationDeg === undefined,
    'anisotropy below 0.05 is suppressed',
  );
  assert(
    belowThreshold.fallbackReasons.includes('near-circular-footprint'),
    'below-threshold anisotropy emits near-circle fallback',
  );
  const atThreshold = computeContentMetrics(
    makeMetricInput({ footprintProjectedPoints: rectangleForAnisotropy(0.05) }),
  );
  assert(
    atThreshold.elongation > 0 && atThreshold.orientationDeg !== undefined,
    'anisotropy equal to 0.05 is retained',
  );
  assert(
    !atThreshold.fallbackReasons.includes('near-circular-footprint'),
    'threshold anisotropy does not emit near-circle fallback',
  );

  const degenerate = computeContentMetrics(
    makeMetricInput({
      footprintProjectedPoints: [
        [5, 5],
        [5, 5],
        [5, 5],
      ],
    }),
  );
  assert(degenerate.elongation === 0 && degenerate.orientationDeg === undefined, 'degenerate PCA is suppressed');
  assert(degenerate.fallbackReasons.includes('degenerate-footprint'), 'degenerate footprint is diagnosed');

  const tinyLine = computeContentMetrics(
    makeMetricInput({
      footprintProjectedPoints: [
        [0, 0],
        [1e-300, 0],
        [2e-300, 0],
      ],
    }),
  );
  assertClose(tinyLine.orientationDeg ?? Number.NaN, 90, 1e-12, 'tiny positive-scale PCA remains oriented');
  assert(tinyLine.elongation === 1, 'tiny positive-scale line retains maximum elongation');
}

function testGroupedPathCurvature(): void {
  const open = computeContentMetrics(
    makeMetricInput({
      pathsProjected: [
        {
          points: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
          closed: false,
        },
      ],
    }),
  );
  assertClose(open.curvature, 0.5, 1e-15, 'one right-angle open turn');

  const grouped = computeContentMetrics(
    makeMetricInput({
      pathsProjected: [
        {
          points: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
          closed: false,
        },
        {
          points: [
            [100, 100],
            [100, 101],
            [99, 101],
          ],
          closed: false,
        },
      ],
    }),
  );
  assertClose(grouped.curvature, 0.5, 1e-15, 'separate paths do not create a tail-to-head turn');

  const closed = computeContentMetrics(
    makeMetricInput({
      pathsProjected: [
        {
          points: [
            [0, 0],
            [1, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
          closed: true,
        },
      ],
    }),
  );
  assertClose(closed.curvature, 0.5, 1e-15, 'closed path includes closure turns after zero-segment removal');

  const degrees = (value: number) => (value * Math.PI) / 180;
  const first: readonly [number, number] = [Math.cos(degrees(170)), Math.sin(degrees(170))];
  const second: readonly [number, number] = [first[0] + Math.cos(degrees(-170)), first[1] + Math.sin(degrees(-170))];
  const shortest = computeContentMetrics(
    makeMetricInput({ pathsProjected: [{ points: [[0, 0], first, second], closed: false }] }),
  );
  assertClose(shortest.curvature, 20 / 180, 1e-12, 'curvature uses the shortest signed turn');

  const short = computeContentMetrics(
    makeMetricInput({
      pathsProjected: [
        {
          points: [
            [0, 0],
            [1, 0],
          ],
          closed: false,
        },
      ],
    }),
  );
  assert(short.curvature === 0, 'short path fallback');
  assert(short.fallbackReasons.includes('short-path'), 'short path is diagnosed');

  const twoPointClosed = computeContentMetrics(
    makeMetricInput({
      pathsProjected: [
        {
          points: [
            [0, 0],
            [1, 0],
            [0, 0],
          ],
          closed: true,
        },
      ],
    }),
  );
  assert(twoPointClosed.curvature === 0, 'two-point closed path does not invent reciprocal U-turns');
  assert(twoPointClosed.fallbackReasons.includes('short-path'), 'two-point closed path is ranked as short');
}

function testPreprojectedAntimeridianFrameIsNotRewrapped(): void {
  const points: Array<[number, number]> = [
    [179, 0],
    [181, 1],
    [182, 3],
  ];
  const measure = (path: Array<[number, number]>) =>
    computeContentMetrics(
      makeMetricInput({
        footprintProjectedPoints: path,
        pathsProjected: [{ points: path, closed: false }],
      }),
    );
  const metrics = measure(points);
  const translated = measure(points.map(([x, y]) => [x - 179, y]));
  assertClose(metrics.curvature, Math.acos(0.8) / Math.PI, 1e-15, 'projected segments retain their actual turn angle');
  assertClose(metrics.curvature, translated.curvature, 1e-15, 'translation cannot change projected path curvature');
  assertClose(
    metrics.orientationDeg ?? NaN,
    translated.orientationDeg ?? NaN,
    1e-12,
    'projected orientation is independent of the date line',
  );
}

function testFallbackReasonsAreClosedRankedAndDeduplicated(): void {
  const metrics = computeContentMetrics(
    makeMetricInput({
      density: { hasAccessor: true, count: 2, targetWorldAreaKm2: 0 },
      coverage: { targetProjectedArea: 1, sceneContextProjectedArea: 0 },
      members: { count: 2, projectedAreas: [0, 0] },
      footprintProjectedPoints: [
        [1, 1],
        [1, 1],
      ],
      pathsProjected: [
        {
          points: [
            [0, 0],
            [1, 0],
          ],
          closed: false,
        },
        {
          points: [
            [5, 5],
            [6, 5],
          ],
          closed: false,
        },
      ],
    }),
  );
  assert(
    JSON.stringify(metrics.fallbackReasons) ===
      JSON.stringify([
        'no-elevation-data',
        'missing-density-support',
        'degenerate-density-area',
        'degenerate-scene-context',
        'missing-member-centroids',
        'degenerate-member-area',
        'degenerate-footprint',
        'short-path',
      ]),
    `fallback reasons must be closed, ranked, and deduplicated: ${JSON.stringify(metrics.fallbackReasons)}`,
  );

  const allMissing = computeContentMetrics(makeMetricInput());
  assert(
    JSON.stringify(allMissing.fallbackReasons) ===
      JSON.stringify([
        'no-elevation-data',
        'no-density-accessor',
        'missing-scene-context',
        'single-target',
        'missing-footprint',
        'short-path',
      ]),
    `valid missing inputs must have deterministic reasons: ${JSON.stringify(allMissing.fallbackReasons)}`,
  );

  const missingMemberAreas = computeContentMetrics(
    makeMetricInput({
      members: {
        count: 2,
        centroidsProjected: [
          [0, 0],
          [1, 1],
        ],
      },
    }),
  );
  assert(
    missingMemberAreas.fallbackReasons.includes('missing-member-areas'),
    'multi-target input without areas emits missing-member-areas',
  );
}

function testInvalidValuesUseFixedFieldOrder(): void {
  assertNamedFieldError(
    () =>
      computeContentMetrics(
        makeMetricInput({
          actualHeightsMeters: [Number.NaN],
          density: { hasAccessor: true, count: -1 },
          coverage: { targetProjectedArea: -1, sceneContextProjectedArea: -1 },
        }),
      ),
    'actualHeightsMeters[0]',
  );
  assertNamedFieldError(
    () =>
      computeContentMetrics(
        makeMetricInput({
          actualHeightsMeters: [1],
          density: { hasAccessor: true, count: -1 },
          coverage: { targetProjectedArea: -1, sceneContextProjectedArea: -1 },
        }),
      ),
    'density.count',
  );
  assertNamedFieldError(
    () =>
      computeContentMetrics(makeMetricInput({ coverage: { targetProjectedArea: -1, sceneContextProjectedArea: 1 } })),
    'coverage.targetProjectedArea',
  );
  assertNamedFieldError(
    () =>
      computeContentMetrics(
        makeMetricInput({
          members: {
            count: 2,
            centroidsProjected: [
              [0, Number.POSITIVE_INFINITY],
              [1, 1],
            ],
          },
        }),
      ),
    'members.centroidsProjected[0][1]',
  );
  assertNamedFieldError(
    () => computeContentMetrics(makeMetricInput({ members: { count: 2, centroidsProjected: [[0, 0]] } })),
    'members.centroidsProjected.length',
  );
  assertNamedFieldError(
    () => computeContentMetrics(makeMetricInput({ members: { count: 2, projectedAreas: [1] } })),
    'members.projectedAreas.length',
  );
  assertNamedFieldError(
    () => computeContentMetrics(makeMetricInput({ footprintProjectedPoints: [[0, Number.NaN]] })),
    'footprintProjectedPoints[0][1]',
  );
  assertNamedFieldError(
    () =>
      computeContentMetrics(
        makeMetricInput({
          pathsProjected: [
            {
              points: [
                [0, 0],
                [Number.NaN, 1],
              ],
              closed: false,
            },
          ],
        }),
      ),
    'pathsProjected[0].points[1][0]',
  );
  assertNamedFieldError(
    () =>
      computeContentMetrics(
        makeMetricInput({
          pathsProjected: [
            {
              points: [
                [0, 0],
                [1, 0],
              ],
              closed: 'yes',
            },
          ] as unknown as ContentMetricInput['pathsProjected'],
        }),
      ),
    'pathsProjected[0].closed',
  );
  assertNamedFieldError(
    () => computeContentMetrics(makeMetricInput({ calibration: makeCalibration({ version: 1.5 }) })),
    'calibration.version',
  );
  assertNamedFieldError(
    () => computeContentMetrics(makeMetricInput({ calibration: makeCalibration({ referenceSafeAreaPx: 0 }) })),
    'calibration.referenceSafeAreaPx',
  );
  assertNamedFieldError(
    () =>
      computeContentMetrics(
        makeMetricInput({
          calibration: makeCalibration({}, { elevation: { unit: 'feet', lo: 10, hi: 100, source: 'test' } }),
        }),
      ),
    'calibration.metrics.elevation.unit',
  );
  assertNamedFieldError(
    () =>
      computeContentMetrics(
        makeMetricInput({
          calibration: makeCalibration({}, { density: { unit: 'count/km2', lo: 1, hi: 10, source: '' } }),
        }),
      ),
    'calibration.metrics.density.source',
  );
  assertNamedFieldError(
    () =>
      computeContentMetrics(
        makeMetricInput({
          calibration: makeCalibration({}, { aspect: { unit: 'ratio', lo: 0.5, hi: 8, source: 'test' } }),
        }),
      ),
    'calibration.metrics.aspect.lo',
  );

  let getterReads = 0;
  const accessorDensity = Object.create(Object.prototype) as Record<string, unknown>;
  Object.defineProperty(accessorDensity, 'hasAccessor', {
    enumerable: true,
    get() {
      getterReads += 1;
      return false;
    },
  });
  Object.defineProperty(accessorDensity, 'count', { enumerable: true, value: 1 });
  assertNamedFieldError(
    () =>
      computeContentMetrics(makeMetricInput({ density: accessorDensity as unknown as ContentMetricInput['density'] })),
    'density.hasAccessor',
  );
  assert(getterReads === 0, 'input validation must reject accessor fields without executing them');

  let iteratorGetterReads = 0;
  const accessorHeights = [1, 2];
  Object.defineProperty(accessorHeights, Symbol.iterator, {
    configurable: true,
    get() {
      iteratorGetterReads += 1;
      return Array.prototype[Symbol.iterator];
    },
  });
  assertNamedFieldError(
    () => computeContentMetrics(makeMetricInput({ actualHeightsMeters: accessorHeights })),
    'actualHeightsMeters[Symbol(Symbol.iterator)]',
  );
  assert(iteratorGetterReads === 0, 'array iterator accessors are rejected without execution');

  const extraKeyHeights = [1, 2] as number[] & { extra?: number };
  extraKeyHeights.extra = 3;
  assertNamedFieldError(
    () => computeContentMetrics(makeMetricInput({ actualHeightsMeters: extraKeyHeights })),
    'actualHeightsMeters.extra',
  );
}

function testOwnedMetricResultIsDeepFrozen(): void {
  const metrics = computeContentMetrics(makeMetricInput());
  assert(Object.isFrozen(metrics), 'owned content metrics result must be frozen');
  assert(Object.isFrozen(metrics.fallbackReasons), 'owned fallback reasons must be frozen');
}

function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function testDeterministicFiniteFuzz(): void {
  const random = makeLcg(0x5eed1234);
  for (let index = 0; index < 200; index += 1) {
    const pointCount = 2 + Math.floor(random() * 8);
    const points = Array.from(
      { length: pointCount },
      () => [random() * 2_000 - 1_000, random() * 2_000 - 1_000] as const,
    );
    const areas = Array.from({ length: pointCount }, () => random() * 1e12);
    const heights = Array.from({ length: pointCount }, () => random() * 20_000);
    const metrics = computeContentMetrics(
      makeMetricInput({
        actualHeightsMeters: heights,
        density: {
          hasAccessor: true,
          count: pointCount,
          targetWorldAreaKm2: 0.1 + random() * 1_000,
          glyphSupportAreasAtReferenceZoomPx2: areas.map((area) => area / 1e10),
        },
        coverage: {
          targetProjectedArea: random() * 1_000,
          sceneContextProjectedArea: 0.1 + random() * 1_000,
        },
        members: { count: pointCount, centroidsProjected: points, projectedAreas: areas },
        footprintProjectedPoints: points,
        pathsProjected: [{ points, closed: random() >= 0.5 }],
      }),
    );
    const numericValues = [
      metrics.elevation,
      metrics.density,
      metrics.coverage,
      metrics.dispersion,
      metrics.elongation,
      metrics.curvature,
    ];
    if (metrics.orientationDeg !== undefined) {
      assert(
        Number.isFinite(metrics.orientationDeg) && metrics.orientationDeg > -90 && metrics.orientationDeg <= 90,
        `fuzz ${index}: orientation must use the canonical bearing range`,
      );
    }
    assert(
      numericValues.every((value) => Number.isFinite(value) && value >= 0 && value <= 1),
      `fuzz ${index}: all normalized outputs must be finite and inside [0,1]`,
    );
  }
}

function testTwoHundredThousandSampleIterativeStress(): void {
  const heights = Array.from({ length: 200_000 }, (_, index) => (index * 7_919) % 100_003);
  const beforeFirst = heights[0];
  const beforeLast = heights[heights.length - 1];
  const metrics = computeContentMetrics(
    makeMetricInput({
      actualHeightsMeters: heights,
      calibration: makeCalibration({}, { elevation: { unit: 'meters', lo: 0, hi: 100_003, source: 'test' } }),
    }),
  );
  assert(Number.isFinite(metrics.elevation), '200k height P95 remains finite');
  assert(heights[0] === beforeFirst && heights[heights.length - 1] === beforeLast, '200k input remains unchanged');
}

function testTwoHundredThousandCombinedSourceEntriesStayIterative(): void {
  const sourceLength = 50_000;
  const points = Array.from({ length: sourceLength }, (_, index) => [index, (index * 97) % 997] as const);
  const weights = Array.from({ length: sourceLength }, (_, index) => (index % 101) + 1);
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  const firstWeight = weights[0];
  const lastWeight = weights[weights.length - 1];
  const metrics = computeContentMetrics(
    makeMetricInput({
      density: {
        hasAccessor: true,
        count: sourceLength,
        glyphSupportAreasAtReferenceZoomPx2: weights,
      },
      members: {
        count: sourceLength,
        centroidsProjected: points,
        projectedAreas: weights,
      },
      footprintProjectedPoints: points,
      pathsProjected: [{ points, closed: false }],
    }),
  );
  assert(
    [metrics.density, metrics.dispersion, metrics.elongation, metrics.curvature, metrics.orientationDeg ?? 0].every(
      Number.isFinite,
    ),
    '200k combined logical source entries remain finite without recursion',
  );
  assert(points[0] === firstPoint && points[points.length - 1] === lastPoint, 'large point sources remain unchanged');
  assert(
    weights[0] === firstWeight && weights[weights.length - 1] === lastWeight,
    'large area/support sources remain unchanged',
  );
}

testStrictNormLog();
testType7P95AndInputImmutability();
testIntroselectAvoidsPathologicalPartitionDepth();
testIndependentDensitySources();
testCoverageUsesSameUnitSupportAreas();
testNormalizedCentroidSpreadAndPopulationAreaCv();
testStablePcaOrientationAndOrientedExtents();
testGroupedPathCurvature();
testPreprojectedAntimeridianFrameIsNotRewrapped();
testFallbackReasonsAreClosedRankedAndDeduplicated();
testInvalidValuesUseFixedFieldOrder();
testOwnedMetricResultIsDeepFrozen();
testDeterministicFiniteFuzz();
testTwoHundredThousandSampleIterativeStress();
testTwoHundredThousandCombinedSourceEntriesStayIterative();
