import type { CameraCalibrationConfig } from '../../visualization/types';
import type { ContentMetrics } from '../geometry/types';

const EPSILON = 1e-12;
const SQRT_HALF = Math.sqrt(0.5);
const PCA_ANISOTROPY_THRESHOLD = 0.05;

const FALLBACK_REASON_RANK = [
  'no-elevation-data',
  'no-density-accessor',
  'missing-density-support',
  'degenerate-density-area',
  'missing-scene-context',
  'degenerate-scene-context',
  'single-target',
  'missing-member-centroids',
  'missing-member-areas',
  'degenerate-member-area',
  'missing-footprint',
  'degenerate-footprint',
  'near-circular-footprint',
  'short-path',
] as const;

type FallbackReason = (typeof FALLBACK_REASON_RANK)[number];
type ProjectedPoint = readonly [number, number];

export interface ContentMetricInput {
  actualHeightsMeters: readonly number[];
  density: {
    hasAccessor: boolean;
    count: number;
    targetWorldAreaKm2?: number;
    glyphSupportAreasAtReferenceZoomPx2?: readonly number[];
  };
  coverage?: { targetProjectedArea: number; sceneContextProjectedArea: number };
  members: {
    count: number;
    centroidsProjected?: readonly ProjectedPoint[];
    projectedAreas?: readonly number[];
  };
  footprintProjectedPoints?: readonly ProjectedPoint[];
  pathsProjected?: readonly {
    points: readonly ProjectedPoint[];
    closed: boolean;
  }[];
  calibration: CameraCalibrationConfig;
}

function fail(field: string, requirement: string): never {
  const error = new RangeError(`${field} ${requirement}`);
  error.name = 'ContentMetricInputError';
  throw error;
}

function requirePlainRecord(value: unknown, field: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    fail(field, 'must be a plain object.');
  }
  return value as Record<string, unknown>;
}

function getOwnData(record: Record<string, unknown>, key: string, field: string, required = true): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) {
    if (required) fail(field, 'must be present as an own data property.');
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    fail(field, 'must be an own data property.');
  }
  return descriptor.value;
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(field, 'must be a plain array.');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string') {
      fail(`${field}[${String(key)}]`, 'is not allowed on a plain dense array.');
    }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
      fail(`${field}.${key}`, 'is not allowed on a plain dense array.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(`${field}[${index}]`, 'must be an own data property.');
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(`${field}[${index}]`, 'must be an own data property.');
    }
  }
  return value;
}

function requireFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(field, 'must be finite.');
  }
  return value;
}

function requireNonNegative(value: unknown, field: string): number {
  const number = requireFinite(value, field);
  if (number < 0) {
    fail(field, 'must be non-negative.');
  }
  return number;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  const number = requireNonNegative(value, field);
  if (!Number.isSafeInteger(number)) {
    fail(field, 'must be a non-negative safe integer.');
  }
  return number;
}

function validatePoint(value: unknown, field: string): asserts value is ProjectedPoint {
  const point = requireArray(value, field);
  if (point.length !== 2) {
    fail(field, 'must be a projected [east, north] coordinate.');
  }
  requireFinite(point[0], `${field}[0]`);
  requireFinite(point[1], `${field}[1]`);
}

function validateNumberArray(value: unknown, field: string): readonly number[] {
  const values = requireArray(value, field);
  for (let index = 0; index < values.length; index += 1) {
    requireNonNegative(values[index], `${field}[${index}]`);
  }
  return values as readonly number[];
}

function validatePointArray(value: unknown, field: string): readonly ProjectedPoint[] {
  const points = requireArray(value, field);
  for (let index = 0; index < points.length; index += 1) {
    validatePoint(points[index], `${field}[${index}]`);
  }
  return points as readonly ProjectedPoint[];
}

function validateMetricCalibration(
  metrics: Record<string, unknown>,
  key: 'elevation' | 'density' | 'aspect',
  expectedUnit: string,
): void {
  const field = `calibration.metrics.${key}`;
  const value = requirePlainRecord(getOwnData(metrics, key, field), field);
  const unit = getOwnData(value, 'unit', `${field}.unit`);
  if (unit !== expectedUnit) {
    fail(`${field}.unit`, `must be ${JSON.stringify(expectedUnit)}.`);
  }
  const lo = requireNonNegative(getOwnData(value, 'lo', `${field}.lo`), `${field}.lo`);
  const hi = requireFinite(getOwnData(value, 'hi', `${field}.hi`), `${field}.hi`);
  if (hi <= lo) {
    fail(`${field}.hi`, 'must be greater than lo.');
  }
  if (key === 'aspect' && lo !== 1) {
    fail(`${field}.lo`, 'must equal 1.');
  }
  const source = getOwnData(value, 'source', `${field}.source`);
  if (typeof source !== 'string' || source.trim().length === 0) {
    fail(`${field}.source`, 'must be a non-empty string.');
  }
}

function validateInput(input: ContentMetricInput): void {
  const root = requirePlainRecord(input, 'input');
  validateNumberArray(getOwnData(root, 'actualHeightsMeters', 'actualHeightsMeters'), 'actualHeightsMeters');

  const density = requirePlainRecord(getOwnData(root, 'density', 'density'), 'density');
  const hasAccessor = getOwnData(density, 'hasAccessor', 'density.hasAccessor');
  if (typeof hasAccessor !== 'boolean') {
    fail('density.hasAccessor', 'must be boolean.');
  }
  requireNonNegativeInteger(getOwnData(density, 'count', 'density.count'), 'density.count');
  const targetWorldAreaKm2 = getOwnData(density, 'targetWorldAreaKm2', 'density.targetWorldAreaKm2', false);
  if (targetWorldAreaKm2 !== undefined) {
    requireNonNegative(targetWorldAreaKm2, 'density.targetWorldAreaKm2');
  }
  const glyphSupportAreas = getOwnData(
    density,
    'glyphSupportAreasAtReferenceZoomPx2',
    'density.glyphSupportAreasAtReferenceZoomPx2',
    false,
  );
  if (glyphSupportAreas !== undefined) {
    validateNumberArray(glyphSupportAreas, 'density.glyphSupportAreasAtReferenceZoomPx2');
  }

  const coverageValue = getOwnData(root, 'coverage', 'coverage', false);
  if (coverageValue !== undefined) {
    const coverage = requirePlainRecord(coverageValue, 'coverage');
    requireNonNegative(
      getOwnData(coverage, 'targetProjectedArea', 'coverage.targetProjectedArea'),
      'coverage.targetProjectedArea',
    );
    requireNonNegative(
      getOwnData(coverage, 'sceneContextProjectedArea', 'coverage.sceneContextProjectedArea'),
      'coverage.sceneContextProjectedArea',
    );
  }

  const members = requirePlainRecord(getOwnData(root, 'members', 'members'), 'members');
  const memberCount = requireNonNegativeInteger(getOwnData(members, 'count', 'members.count'), 'members.count');
  const centroidsValue = getOwnData(members, 'centroidsProjected', 'members.centroidsProjected', false);
  if (centroidsValue !== undefined) {
    const centroids = validatePointArray(centroidsValue, 'members.centroidsProjected');
    if (centroids.length !== memberCount) {
      fail('members.centroidsProjected.length', 'must equal members.count.');
    }
  }
  const projectedAreasValue = getOwnData(members, 'projectedAreas', 'members.projectedAreas', false);
  if (projectedAreasValue !== undefined) {
    const areas = validateNumberArray(projectedAreasValue, 'members.projectedAreas');
    if (areas.length !== memberCount) {
      fail('members.projectedAreas.length', 'must equal members.count.');
    }
  }

  const footprintPoints = getOwnData(root, 'footprintProjectedPoints', 'footprintProjectedPoints', false);
  if (footprintPoints !== undefined) {
    validatePointArray(footprintPoints, 'footprintProjectedPoints');
  }

  const pathsValue = getOwnData(root, 'pathsProjected', 'pathsProjected', false);
  if (pathsValue !== undefined) {
    const paths = requireArray(pathsValue, 'pathsProjected');
    for (let pathIndex = 0; pathIndex < paths.length; pathIndex += 1) {
      const pathField = `pathsProjected[${pathIndex}]`;
      const path = requirePlainRecord(paths[pathIndex], pathField);
      validatePointArray(getOwnData(path, 'points', `${pathField}.points`), `${pathField}.points`);
      if (typeof getOwnData(path, 'closed', `${pathField}.closed`) !== 'boolean') {
        fail(`${pathField}.closed`, 'must be boolean.');
      }
    }
  }

  const calibration = requirePlainRecord(getOwnData(root, 'calibration', 'calibration'), 'calibration');
  const calibrationVersion = requireFinite(
    getOwnData(calibration, 'version', 'calibration.version'),
    'calibration.version',
  );
  if (!Number.isSafeInteger(calibrationVersion) || calibrationVersion <= 0) {
    fail('calibration.version', 'must be a positive safe integer.');
  }
  requireFinite(getOwnData(calibration, 'referenceZoom', 'calibration.referenceZoom'), 'calibration.referenceZoom');
  const safeArea = requireFinite(
    getOwnData(calibration, 'referenceSafeAreaPx', 'calibration.referenceSafeAreaPx'),
    'calibration.referenceSafeAreaPx',
  );
  if (safeArea <= 0) {
    fail('calibration.referenceSafeAreaPx', 'must be positive.');
  }
  const metrics = requirePlainRecord(getOwnData(calibration, 'metrics', 'calibration.metrics'), 'calibration.metrics');
  validateMetricCalibration(metrics, 'elevation', 'meters');
  validateMetricCalibration(metrics, 'density', 'count/km2');
  validateMetricCalibration(metrics, 'aspect', 'ratio');
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function normLog(value: number, lo: number, hi: number): number {
  const validValue = requireNonNegative(value, 'normLog.value');
  const validLo = requireNonNegative(lo, 'normLog.lo');
  const validHi = requireFinite(hi, 'normLog.hi');
  if (validHi <= validLo) {
    fail('normLog.hi', 'must be greater than normLog.lo.');
  }
  if (validValue <= validLo) return 0;
  if (validValue >= validHi) return 1;
  const numerator = Math.log1p((validValue - validLo) / (1 + validLo));
  const denominator = Math.log1p((validHi - validLo) / (1 + validLo));
  return clamp01(numerator / denominator);
}

function swap(values: number[], left: number, right: number): void {
  const value = values[left];
  values[left] = values[right];
  values[right] = value;
}

function medianOfThree(first: number, second: number, third: number): number {
  if (first < second) {
    if (second < third) return second;
    return first < third ? third : first;
  }
  if (first < third) return first;
  return second < third ? third : second;
}

function selectKth(values: number[], targetIndex: number): number {
  let left = 0;
  let right = values.length - 1;
  let partitionBudget = 2 * Math.ceil(Math.log2(values.length + 1));
  while (left < right) {
    if (partitionBudget <= 0) {
      values.sort((first, second) => first - second);
      return values[targetIndex];
    }
    partitionBudget -= 1;
    const middle = left + Math.floor((right - left) / 2);
    const pivot = medianOfThree(values[left], values[middle], values[right]);
    let below = left;
    let current = left;
    let above = right;
    while (current <= above) {
      if (values[current] < pivot) {
        swap(values, below, current);
        below += 1;
        current += 1;
      } else if (values[current] > pivot) {
        swap(values, current, above);
        above -= 1;
      } else {
        current += 1;
      }
    }
    if (targetIndex < below) {
      right = below - 1;
    } else if (targetIndex > above) {
      left = above + 1;
    } else {
      return pivot;
    }
  }
  return values[left];
}

function type7P95(values: readonly number[]): number {
  if (values.length === 1) return values[0];
  const copy = Array.from(values);
  const position = (copy.length - 1) * 0.95;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = selectKth(copy, lowerIndex);
  if (lowerIndex === upperIndex) return lower;
  const upper = selectKth(copy, upperIndex);
  return lower + (upper - lower) * (position - lowerIndex);
}

function addFallback(reasons: Set<FallbackReason>, reason: FallbackReason): void {
  reasons.add(reason);
}

function computeElevation(input: ContentMetricInput, reasons: Set<FallbackReason>): number {
  if (input.actualHeightsMeters.length === 0) {
    addFallback(reasons, 'no-elevation-data');
    return 0;
  }
  const range = input.calibration.metrics.elevation;
  return normLog(type7P95(input.actualHeightsMeters), range.lo, range.hi);
}

function compensatedSupportRatio(areas: readonly number[], safeArea: number): number {
  let sum = 0;
  let compensation = 0;
  for (const area of areas) {
    const adjusted = area - compensation;
    const next = sum + adjusted;
    compensation = next - sum - adjusted;
    sum = next;
    if (sum >= safeArea) return 1;
  }
  return clamp01(sum / safeArea);
}

function computeDensity(input: ContentMetricInput, reasons: Set<FallbackReason>): number {
  if (!input.density.hasAccessor) {
    addFallback(reasons, 'no-density-accessor');
    return 0;
  }

  let worldDensity: number | undefined;
  if (input.density.targetWorldAreaKm2 !== undefined) {
    if (input.density.targetWorldAreaKm2 <= EPSILON) {
      addFallback(reasons, 'degenerate-density-area');
    } else {
      const range = input.calibration.metrics.density;
      worldDensity = normLog(input.density.count / input.density.targetWorldAreaKm2, range.lo, range.hi);
    }
  }

  let screenDensity: number | undefined;
  if (input.density.glyphSupportAreasAtReferenceZoomPx2 !== undefined) {
    screenDensity = compensatedSupportRatio(
      input.density.glyphSupportAreasAtReferenceZoomPx2,
      input.calibration.referenceSafeAreaPx,
    );
  }

  if (worldDensity === undefined && screenDensity === undefined) {
    addFallback(reasons, 'missing-density-support');
    return 0;
  }
  return Math.max(worldDensity ?? 0, screenDensity ?? 0);
}

function computeCoverage(input: ContentMetricInput, reasons: Set<FallbackReason>): number {
  if (input.coverage === undefined) {
    addFallback(reasons, 'missing-scene-context');
    return 0;
  }
  if (input.coverage.sceneContextProjectedArea <= EPSILON) {
    addFallback(reasons, 'degenerate-scene-context');
    return 0;
  }
  if (input.coverage.targetProjectedArea >= input.coverage.sceneContextProjectedArea) return 1;
  return input.coverage.targetProjectedArea / input.coverage.sceneContextProjectedArea;
}

function makeAabbAxisNormalizer(minimum: number, maximum: number): (value: number) => number {
  if (minimum === maximum) return () => 0.5;
  const scale = Math.max(Math.abs(minimum), Math.abs(maximum));
  const scaledMinimum = minimum / scale;
  const scaledRange = maximum / scale - scaledMinimum;
  return (value) => clamp01((value / scale - scaledMinimum) / scaledRange);
}

function normalizedCentroidSpread(centroids: readonly ProjectedPoint[]): number {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of centroids) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const normalizeX = makeAabbAxisNormalizer(minX, maxX);
  const normalizeY = makeAabbAxisNormalizer(minY, maxY);
  let count = 0;
  let meanX = 0;
  let meanY = 0;
  for (const [x, y] of centroids) {
    const normalizedX = normalizeX(x);
    const normalizedY = normalizeY(y);
    count += 1;
    meanX += (normalizedX - meanX) / count;
    meanY += (normalizedY - meanY) / count;
  }
  let squaredDistanceSum = 0;
  for (const [x, y] of centroids) {
    const normalizedX = normalizeX(x);
    const normalizedY = normalizeY(y);
    const dx = normalizedX - meanX;
    const dy = normalizedY - meanY;
    squaredDistanceSum += dx * dx + dy * dy;
  }
  return clamp01(Math.sqrt(squaredDistanceSum / centroids.length) / SQRT_HALF);
}

function populationAreaCv(areas: readonly number[], reasons: Set<FallbackReason>): number {
  let maximum = 0;
  for (const area of areas) {
    if (area > maximum) maximum = area;
  }
  if (maximum === 0) {
    addFallback(reasons, 'degenerate-member-area');
    return 0;
  }
  let count = 0;
  let mean = 0;
  let sumSquaredDeviation = 0;
  for (const area of areas) {
    const scaled = area / maximum;
    count += 1;
    const delta = scaled - mean;
    mean += delta / count;
    sumSquaredDeviation += delta * (scaled - mean);
  }
  if (mean === 0) {
    addFallback(reasons, 'degenerate-member-area');
    return 0;
  }
  return clamp01(Math.sqrt(Math.max(0, sumSquaredDeviation / count)) / mean);
}

function computeDispersion(input: ContentMetricInput, reasons: Set<FallbackReason>): number {
  if (input.members.count <= 1) {
    addFallback(reasons, 'single-target');
    return 0;
  }

  let spread = 0;
  const centroids = input.members.centroidsProjected;
  if (centroids === undefined || centroids.length === 0) {
    addFallback(reasons, 'missing-member-centroids');
  } else {
    spread = normalizedCentroidSpread(centroids);
  }

  let scaleCv = 0;
  const areas = input.members.projectedAreas;
  if (areas === undefined || areas.length === 0) {
    addFallback(reasons, 'missing-member-areas');
  } else {
    scaleCv = populationAreaCv(areas, reasons);
  }

  return clamp01(0.7 * spread + 0.3 * scaleCv);
}

interface PcaMetrics {
  elongation: number;
  orientationDeg?: number;
}

function canonicalAxisBearing(east: number, north: number): number {
  let bearing = (Math.atan2(east, north) * 180) / Math.PI;
  if (bearing <= -90) bearing += 180;
  if (bearing > 90) bearing -= 180;
  return Object.is(bearing, -0) ? 0 : bearing;
}

function computePcaMetrics(input: ContentMetricInput, reasons: Set<FallbackReason>): PcaMetrics {
  const points = input.footprintProjectedPoints;
  if (points === undefined || points.length === 0) {
    addFallback(reasons, 'missing-footprint');
    return { elongation: 0 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const centerX = minX / 2 + maxX / 2;
  const centerY = minY / 2 + maxY / 2;
  let scale = 0;
  for (const [x, y] of points) {
    scale = Math.max(scale, Math.abs(x - centerX), Math.abs(y - centerY));
  }
  if (scale === 0) {
    addFallback(reasons, 'degenerate-footprint');
    return { elongation: 0 };
  }

  let count = 0;
  let meanX = 0;
  let meanY = 0;
  let covarianceXXSum = 0;
  let covarianceXYSum = 0;
  let covarianceYYSum = 0;
  for (const [sourceX, sourceY] of points) {
    const x = (sourceX - centerX) / scale;
    const y = (sourceY - centerY) / scale;
    count += 1;
    const dx = x - meanX;
    const dy = y - meanY;
    meanX += dx / count;
    meanY += dy / count;
    covarianceXXSum += dx * (x - meanX);
    covarianceXYSum += dx * (y - meanY);
    covarianceYYSum += dy * (y - meanY);
  }

  const covarianceXX = covarianceXXSum / count;
  const covarianceXY = covarianceXYSum / count;
  const covarianceYY = covarianceYYSum / count;
  const trace = covarianceXX + covarianceYY;
  if (!Number.isFinite(trace) || trace <= EPSILON) {
    addFallback(reasons, 'degenerate-footprint');
    return { elongation: 0 };
  }

  const eigenGap = Math.hypot(covarianceXX - covarianceYY, 2 * covarianceXY);
  const majorEigenvalue = (trace + eigenGap) / 2;
  const minorEigenvalue = Math.max(0, (trace - eigenGap) / 2);
  const anisotropy = (majorEigenvalue - minorEigenvalue) / trace;
  if (anisotropy < PCA_ANISOTROPY_THRESHOLD) {
    addFallback(reasons, 'near-circular-footprint');
    return { elongation: 0 };
  }

  const majorAxisRadians = Math.atan2(2 * covarianceXY, covarianceXX - covarianceYY) / 2;
  const majorEast = Math.cos(majorAxisRadians);
  const majorNorth = Math.sin(majorAxisRadians);
  let majorMinimum = Number.POSITIVE_INFINITY;
  let majorMaximum = Number.NEGATIVE_INFINITY;
  let minorMinimum = Number.POSITIVE_INFINITY;
  let minorMaximum = Number.NEGATIVE_INFINITY;
  for (const [sourceX, sourceY] of points) {
    const x = (sourceX - centerX) / scale;
    const y = (sourceY - centerY) / scale;
    const majorProjection = x * majorEast + y * majorNorth;
    const minorProjection = -x * majorNorth + y * majorEast;
    if (majorProjection < majorMinimum) majorMinimum = majorProjection;
    if (majorProjection > majorMaximum) majorMaximum = majorProjection;
    if (minorProjection < minorMinimum) minorMinimum = minorProjection;
    if (minorProjection > minorMaximum) minorMaximum = minorProjection;
  }
  const majorExtent = majorMaximum - majorMinimum;
  const minorExtent = minorMaximum - minorMinimum;
  let elongation: number;
  if (Math.min(majorExtent, minorExtent) <= EPSILON) {
    elongation = 1;
  } else {
    const aspect = Math.max(majorExtent / minorExtent, minorExtent / majorExtent);
    const range = input.calibration.metrics.aspect;
    elongation = normLog(aspect, range.lo, range.hi);
  }
  return {
    elongation,
    orientationDeg: canonicalAxisBearing(majorEast, majorNorth),
  };
}

function samePoint(first: ProjectedPoint, second: ProjectedPoint): boolean {
  return first[0] === second[0] && first[1] === second[1];
}

function segmentHeadingDegrees(from: ProjectedPoint, to: ProjectedPoint): number {
  let dx = to[0] - from[0];
  let dy = to[1] - from[1];
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    const scale = Math.max(Math.abs(from[0]), Math.abs(from[1]), Math.abs(to[0]), Math.abs(to[1]));
    dx = to[0] / scale - from[0] / scale;
    dy = to[1] / scale - from[1] / scale;
  }
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    fail('pathsProjected.heading', 'must be finite for every non-zero segment.');
  }
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

function shortestTurnDegrees(firstHeading: number, secondHeading: number): number {
  const turn = ((((secondHeading - firstHeading + 180) % 360) + 360) % 360) - 180;
  return Math.abs(turn);
}

function computeCurvature(input: ContentMetricInput, reasons: Set<FallbackReason>): number {
  let totalTurnDegrees = 0;
  let totalTurnCount = 0;
  for (const path of input.pathsProjected ?? []) {
    const points: ProjectedPoint[] = [];
    for (const point of path.points) {
      if (points.length === 0 || !samePoint(points[points.length - 1], point)) {
        points.push(point);
      }
    }
    if (path.closed && points.length > 1 && samePoint(points[0], points[points.length - 1])) {
      points.pop();
    }

    const headings: number[] = [];
    for (let index = 1; index < points.length; index += 1) {
      headings.push(segmentHeadingDegrees(points[index - 1], points[index]));
    }
    if (path.closed && points.length > 1) {
      headings.push(segmentHeadingDegrees(points[points.length - 1], points[0]));
    }

    if (path.closed) {
      if (headings.length < 3) continue;
      for (let index = 0; index < headings.length; index += 1) {
        totalTurnDegrees += shortestTurnDegrees(headings[index], headings[(index + 1) % headings.length]);
        totalTurnCount += 1;
      }
    } else {
      for (let index = 1; index < headings.length; index += 1) {
        totalTurnDegrees += shortestTurnDegrees(headings[index - 1], headings[index]);
        totalTurnCount += 1;
      }
    }
  }

  if (totalTurnCount === 0) {
    addFallback(reasons, 'short-path');
    return 0;
  }
  return clamp01(totalTurnDegrees / (180 * totalTurnCount));
}

export function computeContentMetrics(input: ContentMetricInput): ContentMetrics {
  validateInput(input);
  const fallbackReasons = new Set<FallbackReason>();
  const elevation = computeElevation(input, fallbackReasons);
  const density = computeDensity(input, fallbackReasons);
  const coverage = computeCoverage(input, fallbackReasons);
  const dispersion = computeDispersion(input, fallbackReasons);
  const pca = computePcaMetrics(input, fallbackReasons);
  const curvature = computeCurvature(input, fallbackReasons);

  const rankedFallbackReasons = Object.freeze(
    FALLBACK_REASON_RANK.filter((reason) => fallbackReasons.has(reason)),
  ) as unknown as string[];
  return Object.freeze({
    elevation,
    density,
    coverage,
    dispersion,
    elongation: pca.elongation,
    ...(pca.orientationDeg === undefined ? {} : { orientationDeg: pca.orientationDeg }),
    curvature,
    calibrationVersion: input.calibration.version,
    fallbackReasons: rankedFallbackReasons,
  });
}
