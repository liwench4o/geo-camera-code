import type { CameraView, CustomObject } from '../interfaces';
import { normalizeTargetType } from './catalog';
import type { BBox, CameraTarget, CameraTargetSource, CameraTargetVisualFrame, LngLat } from './types';
import type { VisualizationAnalytics, VisualizationLayerAnalytics } from '../visualization/types';
import { unwrapPath } from './geometry/geo-wrap';
import { getSelectionIdentity } from './selection-identity';

const TARGET_COORDINATE_MIN_EXTENT = 0.01;
const EARTH_RADIUS_KM = 6371.0088;
const HEIGHT_OVERFLOW_LOG2_SPAN = 8;

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function roundCoordinate(value: number) {
  return Number(value.toFixed(6));
}

function normalizeLngLat(coordinate: number[]): LngLat {
  return [roundCoordinate(Number(coordinate[0])), roundCoordinate(Number(coordinate[1]))];
}

function degreesToRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

function getCoordinateDistanceKm(start: LngLat, end: LngLat) {
  const startLat = degreesToRadians(start[1]);
  const endLat = degreesToRadians(end[1]);
  const deltaLat = degreesToRadians(end[1] - start[1]);
  const deltaLng = degreesToRadians(end[0] - start[0]);
  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(startLat) * Math.cos(endLat) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
  const clampedA = Math.min(1, Math.max(0, a));
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(clampedA), Math.sqrt(1 - clampedA));
}

function getPathLengthKm(coordinates: LngLat[]) {
  return coordinates.reduce((total, coordinate, index) => {
    if (index === 0) {
      return total;
    }
    return total + getCoordinateDistanceKm(coordinates[index - 1], coordinate);
  }, 0);
}

function clamp01(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.min(1, Math.max(0, value));
}

function getBboxAreaKm2(bbox: BBox) {
  const midLat = (bbox[1] + bbox[3]) / 2;
  const widthKm = getCoordinateDistanceKm([bbox[0], midLat], [bbox[2], midLat]);
  const heightKm = getCoordinateDistanceKm([bbox[0], bbox[1]], [bbox[0], bbox[3]]);
  return Math.max(0.000001, widthKm * heightKm);
}

function metersToLatitudeDegrees(meters: number) {
  return meters / 111000;
}

function metersToLongitudeDegrees(meters: number, latitude: number) {
  return meters / (111000 * Math.max(0.1, Math.cos(degreesToRadians(latitude))));
}

function expandBboxByMeters(bbox: BBox, meters: number | undefined): BBox {
  if (!meters || !Number.isFinite(meters) || meters <= 0) {
    return normalizeBbox(bbox);
  }

  const center = centerOfBbox(bbox);
  const lngDelta = metersToLongitudeDegrees(meters, center[1]);
  const latDelta = metersToLatitudeDegrees(meters);
  return normalizeBbox([bbox[0] - lngDelta, bbox[1] - latDelta, bbox[2] + lngDelta, bbox[3] + latDelta]);
}

function createVisualFrame(
  bbox: BBox,
  anchor: LngLat,
  overrides: Partial<CameraTargetVisualFrame> = {},
): CameraTargetVisualFrame {
  return {
    bbox: normalizeBbox(bbox),
    anchor,
    ...overrides,
  };
}

function getTargetVisualBbox(target: CameraTarget) {
  return target.visualFrame?.bbox ?? target.bbox;
}

function getTargetVisualHeightMeters(target: CameraTarget) {
  return target.visualFrame?.heightMeters;
}

function getTargetExtraPaddingPx(target: CameraTarget) {
  return target.visualFrame?.extraPaddingPx;
}

function getTargetReferenceAreaKm2(target: CameraTarget) {
  return target.stats?.referenceAreaKm2;
}

function getTargetBboxAreaRatio(target: CameraTarget) {
  return target.stats?.bboxAreaRatio;
}

function getTargetVisualAreaRatio(target: CameraTarget) {
  return target.stats?.visualAreaRatio;
}

function getTargetDispersionRatio(target: CameraTarget) {
  return target.stats?.dispersionRatio;
}

function estimateVisualHeightMeters({
  layerKinds,
  selectedElevationValue,
  selectedElevationMeters,
  elevationRatio,
  radiusMeters,
}: {
  layerKinds: string[];
  selectedElevationValue?: number;
  selectedElevationMeters?: number;
  elevationRatio?: number;
  radiusMeters?: number;
}) {
  if (
    selectedElevationMeters !== undefined &&
    Number.isFinite(selectedElevationMeters) &&
    selectedElevationMeters > 0
  ) {
    return selectedElevationMeters;
  }

  if (selectedElevationValue === undefined || !Number.isFinite(selectedElevationValue) || selectedElevationValue <= 0) {
    return undefined;
  }

  if (layerKinds.includes('building') || layerKinds.includes('polygon')) {
    return selectedElevationValue;
  }

  if (layerKinds.includes('hexagon')) {
    const radiusFloor = radiusMeters ? radiusMeters * 2 : 0;
    const fallbackHeight = (elevationRatio !== undefined ? elevationRatio : 1) * 1000;
    return Math.max(fallbackHeight, radiusFloor);
  }

  if (elevationRatio !== undefined && elevationRatio > 0.2) {
    return Math.min(Math.max(selectedElevationValue, radiusMeters ?? 0), 5000);
  }

  return undefined;
}

function getHeightOverflowRatio(renderedHeightMeters: number | undefined, framingHeightMeters: number | undefined) {
  if (
    renderedHeightMeters === undefined ||
    framingHeightMeters === undefined ||
    !Number.isFinite(renderedHeightMeters) ||
    !Number.isFinite(framingHeightMeters) ||
    framingHeightMeters <= 0 ||
    renderedHeightMeters <= framingHeightMeters
  ) {
    return undefined;
  }

  return clamp01(Math.log2(renderedHeightMeters / framingHeightMeters) / HEIGHT_OVERFLOW_LOG2_SPAN);
}

function mapElevationValueToMeters(
  value: number | undefined,
  elevationRange: [number, number] | undefined,
  elevationScale: number | undefined,
  elevationDomain: [number, number] | undefined,
) {
  if (
    value === undefined ||
    !Number.isFinite(value) ||
    !elevationRange ||
    elevationScale === undefined ||
    !Number.isFinite(elevationScale)
  ) {
    return undefined;
  }

  const domain = elevationDomain ?? [0, Math.max(value, 1)];
  const domainSpan = Math.max(1e-9, domain[1] - domain[0]);
  const normalizedValue = Math.min(1, Math.max(0, (value - domain[0]) / domainSpan));
  return (elevationRange[0] + (elevationRange[1] - elevationRange[0]) * normalizedValue) * elevationScale;
}

function getLayerElevationMeters(layer: VisualizationLayerAnalytics, value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }

  const renderedMeters = mapElevationValueToMeters(
    value,
    layer.elevationRange,
    layer.elevationScale,
    layer.elevationDomain ??
      (layer.maxElevationValue !== undefined && Number.isFinite(layer.maxElevationValue)
        ? [0, layer.maxElevationValue]
        : undefined),
  );
  if (renderedMeters !== undefined) {
    return renderedMeters;
  }

  if (
    layer.maxElevationMeters !== undefined &&
    Number.isFinite(layer.maxElevationMeters) &&
    layer.maxElevationValue !== undefined &&
    Number.isFinite(layer.maxElevationValue) &&
    layer.maxElevationValue > 0
  ) {
    return (value / layer.maxElevationValue) * layer.maxElevationMeters;
  }

  if (layer.kind === 'building' || layer.kind === 'polygon') {
    return value;
  }

  return undefined;
}

function getSelectedElevationMeters(layers: VisualizationLayerAnalytics[], selectedElevationValue: number | undefined) {
  const meters = maxNumber(layers.map((layer) => getLayerElevationMeters(layer, selectedElevationValue) ?? 0));
  return meters || undefined;
}

function getMaxElevationMeters(layers: VisualizationLayerAnalytics[]) {
  const meters = maxNumber(
    layers.map((layer) => layer.maxElevationMeters ?? getLayerElevationMeters(layer, layer.maxElevationValue) ?? 0),
  );
  return meters || undefined;
}

function getUniqueValues(values: string[]) {
  return Array.from(new Set(values));
}

function maxNumber(values: number[]) {
  let maxValue = 0;
  for (const value of values) {
    if (Number.isFinite(value)) {
      maxValue = Math.max(maxValue, value);
    }
  }
  return maxValue;
}

function getPickedElevationValue(pickedObject: CustomObject | undefined) {
  if (!pickedObject) {
    return undefined;
  }

  const value = Number(pickedObject.elevationValue ?? pickedObject.count ?? pickedObject.points?.length);
  return Number.isFinite(value) ? value : undefined;
}

function getSelectedElevationValue(rows: CustomObject[]) {
  let maxValue: number | undefined;
  for (const row of rows) {
    const value = Number(row.height ?? row.elevationValue ?? row.count);
    if (!Number.isFinite(value)) {
      continue;
    }
    maxValue = maxValue === undefined ? value : Math.max(maxValue, value);
  }
  return maxValue;
}

export interface CameraTargetStatsContext {
  analytics?: VisualizationAnalytics;
  pickedObject?: CustomObject;
}

function formatPathLength(pathLengthKm: number) {
  if (pathLengthKm < 1) {
    return `${Math.round(pathLengthKm * 1000)} m`;
  }

  return `${pathLengthKm.toFixed(1)} km`;
}

export function isFiniteLngLat(coordinate: unknown): coordinate is number[] {
  if (!Array.isArray(coordinate) || coordinate.length < 2) {
    return false;
  }

  return Number.isFinite(Number(coordinate[0])) && Number.isFinite(Number(coordinate[1]));
}

export function getRowLngLat(row: CustomObject): LngLat | undefined {
  const directCoordinate = row.coordinates ?? row.position;
  if (isFiniteLngLat(directCoordinate)) {
    return normalizeLngLat(directCoordinate);
  }

  const longitude = Number(row.longitude ?? row.lng ?? row.lon);
  const latitude = Number(row.latitude ?? row.lat);
  if (Number.isFinite(longitude) && Number.isFinite(latitude)) {
    return normalizeLngLat([longitude, latitude]);
  }

  return undefined;
}

export function getPickedObjectRows(object: CustomObject) {
  const points = Array.isArray(object.points) ? object.points : [];
  if (points.length === 0) {
    return [object];
  }

  return points.map((point) => (point.source as CustomObject | undefined) ?? point);
}

export function centerOfBbox(bbox: BBox): LngLat {
  return [roundCoordinate((bbox[0] + bbox[2]) / 2), roundCoordinate((bbox[1] + bbox[3]) / 2)];
}

export function normalizeBbox(bbox: BBox, minExtent = TARGET_COORDINATE_MIN_EXTENT): BBox {
  let [minLng, minLat, maxLng, maxLat] = bbox;

  if (minLng > maxLng) {
    [minLng, maxLng] = [maxLng, minLng];
  }
  if (minLat > maxLat) {
    [minLat, maxLat] = [maxLat, minLat];
  }

  if (Math.abs(maxLng - minLng) < minExtent) {
    const center = (minLng + maxLng) / 2;
    minLng = center - minExtent / 2;
    maxLng = center + minExtent / 2;
  }
  if (Math.abs(maxLat - minLat) < minExtent) {
    const center = (minLat + maxLat) / 2;
    minLat = center - minExtent / 2;
    maxLat = center + minExtent / 2;
  }

  return [roundCoordinate(minLng), roundCoordinate(minLat), roundCoordinate(maxLng), roundCoordinate(maxLat)];
}

export function bboxFromCoordinates(coordinates: LngLat[], minExtent = TARGET_COORDINATE_MIN_EXTENT): BBox {
  if (coordinates.length === 0) {
    return normalizeBbox([0, 0, 0, 0], minExtent);
  }

  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  for (const [longitude, latitude] of coordinates) {
    minLng = Math.min(minLng, longitude);
    minLat = Math.min(minLat, latitude);
    maxLng = Math.max(maxLng, longitude);
    maxLat = Math.max(maxLat, latitude);
  }

  return normalizeBbox([minLng, minLat, maxLng, maxLat], minExtent);
}

export function mergeBboxes(bboxes: BBox[], minExtent = TARGET_COORDINATE_MIN_EXTENT): BBox {
  if (bboxes.length === 0) {
    return normalizeBbox([0, 0, 0, 0], minExtent);
  }

  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  for (const bbox of bboxes) {
    minLng = Math.min(minLng, bbox[0]);
    minLat = Math.min(minLat, bbox[1]);
    maxLng = Math.max(maxLng, bbox[2]);
    maxLat = Math.max(maxLat, bbox[3]);
  }

  return normalizeBbox([minLng, minLat, maxLng, maxLat], minExtent);
}

export function bboxFromRows(rows: CustomObject[]) {
  const coordinates = rows.map(getRowLngLat).filter(Boolean) as LngLat[];
  return coordinates.length ? bboxFromCoordinates(coordinates) : undefined;
}

function isCoordinateInsideBbox(coordinate: LngLat, bbox: BBox) {
  return coordinate[0] >= bbox[0] && coordinate[0] <= bbox[2] && coordinate[1] >= bbox[1] && coordinate[1] <= bbox[3];
}

export function getWeightedCentroidFromRows(
  rows: CustomObject[],
  getWeight?: (row: CustomObject) => number,
): LngLat | undefined {
  let weightedLongitude = 0;
  let weightedLatitude = 0;
  let totalWeight = 0;
  let fallbackLongitude = 0;
  let fallbackLatitude = 0;
  let fallbackCount = 0;

  for (const row of rows) {
    const coordinate = getRowLngLat(row);
    if (!coordinate) {
      continue;
    }

    fallbackLongitude += coordinate[0];
    fallbackLatitude += coordinate[1];
    fallbackCount += 1;

    const rawWeight = getWeight ? Number(getWeight(row)) : 1;
    const weight = Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : 0;
    if (weight <= 0) {
      continue;
    }

    weightedLongitude += coordinate[0] * weight;
    weightedLatitude += coordinate[1] * weight;
    totalWeight += weight;
  }

  if (totalWeight > 0) {
    return normalizeLngLat([weightedLongitude / totalWeight, weightedLatitude / totalWeight]);
  }

  if (fallbackCount > 0) {
    return normalizeLngLat([fallbackLongitude / fallbackCount, fallbackLatitude / fallbackCount]);
  }

  return undefined;
}

function getAnalyticsExpectedBbox(analytics?: VisualizationAnalytics) {
  if (!analytics?.combinedBbox) {
    return undefined;
  }

  const radiusMeters = maxNumber((analytics.layers ?? []).map((layer) => layer.radiusMeters ?? 0));
  return expandBboxByMeters(analytics.combinedBbox, radiusMeters ? radiusMeters * 2 : undefined);
}

export function getHexagonPickedCoordinate(
  object: CustomObject,
  analytics?: VisualizationAnalytics,
  clickedCoordinate?: number[],
) {
  const rows = getPickedObjectRows(object);
  const rowBbox = bboxFromRows(rows);
  const rowCenter = getWeightedCentroidFromRows(rows) ?? (rowBbox ? centerOfBbox(rowBbox) : undefined);
  const pickedPosition = isFiniteLngLat(object.position) ? normalizeLngLat(object.position) : undefined;
  const clicked =
    clickedCoordinate && isFiniteLngLat(clickedCoordinate) ? normalizeLngLat(clickedCoordinate) : undefined;
  const expectedBbox = getAnalyticsExpectedBbox(analytics);

  if (!expectedBbox) {
    return pickedPosition ?? rowCenter ?? clicked;
  }

  // GPU-aggregated hexagon picks can report a garbage position (and carry no source rows, so the
  // row centroid is equally bogus); every candidate is validated against the dataset bounds and the
  // raw click coordinate is the dependable fallback because it always lies on the picked column.
  for (const candidate of [pickedPosition, rowCenter, clicked]) {
    if (candidate && isCoordinateInsideBbox(candidate, expectedBbox)) {
      return candidate;
    }
  }

  return clicked ?? rowCenter ?? pickedPosition;
}

export function filterRowsInsideAnalyticsBounds(rows: CustomObject[], analytics?: VisualizationAnalytics) {
  const expectedBbox = getAnalyticsExpectedBbox(analytics);
  if (!expectedBbox) {
    return rows;
  }

  // Rows without coordinates stay (they cannot distort the visual bbox but may carry counts);
  // rows with coordinates outside the dataset bounds are picking artifacts and must not be merged
  // into the target's visual frame.
  return rows.filter((row) => {
    const coordinate = getRowLngLat(row);
    return !coordinate || isCoordinateInsideBbox(coordinate, expectedBbox);
  });
}

export function createPointTarget(
  coordinate: number[],
  selectedRows: CustomObject[] = [],
  source: CameraTargetSource = 'click-object',
): CameraTarget {
  const center = normalizeLngLat(coordinate);
  const bbox = normalizeBbox([center[0], center[1], center[0], center[1]]);
  const dataBbox = bboxFromRows(selectedRows);
  const visualBbox = dataBbox ? mergeBboxes([bbox, dataBbox]) : bbox;

  return {
    id: createId('target-location'),
    type: 'location',
    source,
    center,
    bbox,
    visualFrame: createVisualFrame(visualBbox, center, {
      extraPaddingPx: 16,
      sampleCoordinates: [center],
    }),
    coordinates: [center],
    selectedRows,
    stats: {
      count: Math.max(selectedRows.length, 1),
    },
    label: `[${center[0]}, ${center[1]}]`,
  };
}

export function createRegionTarget(
  coordinates: number[][],
  selectedRows: CustomObject[] = [],
  source: CameraTargetSource = 'drawn-region',
): CameraTarget {
  const normalizedCoordinates = coordinates.filter(isFiniteLngLat).map(normalizeLngLat);
  const geometryBbox = bboxFromCoordinates(normalizedCoordinates);
  const dataBbox = bboxFromRows(selectedRows);
  const bbox = dataBbox ? mergeBboxes([geometryBbox, dataBbox]) : geometryBbox;
  const center = centerOfBbox(bbox);
  const anchor = selectedRows.length >= 3 ? (getWeightedCentroidFromRows(selectedRows) ?? center) : center;

  return {
    id: createId('target-region'),
    type: 'region',
    source,
    center,
    bbox,
    visualFrame: createVisualFrame(bbox, anchor, {
      sampleCoordinates: normalizedCoordinates,
    }),
    coordinates: normalizedCoordinates,
    selectedRows,
    stats: {
      count: selectedRows.length,
    },
    label: `[${center[0]}, ${center[1]}]`,
  };
}

export interface HeatmapZoneTargetInput {
  clickedLngLat: number[];
  rows: CustomObject[];
  radiusMeters: number;
  getWeight?: (row: CustomObject) => number;
  radiusMultiplier?: number;
}

export function createHeatmapZoneTarget({
  clickedLngLat,
  rows,
  radiusMeters,
  getWeight,
  radiusMultiplier = 2,
}: HeatmapZoneTargetInput): CameraTarget {
  const center = normalizeLngLat(clickedLngLat);
  const pointBbox = normalizeBbox([center[0], center[1], center[0], center[1]]);
  const selectionRadiusMeters = Math.max(0, radiusMeters) * Math.max(1, radiusMultiplier);
  const zoneRows = rows.filter((row) => {
    const coordinate = getRowLngLat(row);
    return coordinate ? getCoordinateDistanceKm(coordinate, center) * 1000 <= selectionRadiusMeters : false;
  });
  const anchor = getWeightedCentroidFromRows(zoneRows, getWeight) ?? center;
  const dataBbox = bboxFromRows(zoneRows) ?? pointBbox;
  const bbox = mergeBboxes([pointBbox, dataBbox]);
  const visualBbox = expandBboxByMeters(bbox, radiusMeters);
  const sampleCoordinates = [center, ...zoneRows.map(getRowLngLat).filter(Boolean)] as LngLat[];

  return {
    id: createId('target-heatmap-zone'),
    type: 'region',
    source: 'heatmap-zone',
    center: centerOfBbox(bbox),
    bbox,
    visualFrame: createVisualFrame(visualBbox, anchor, {
      extraPaddingPx: 24,
      sampleCoordinates,
    }),
    coordinates: [anchor],
    selectedRows: zoneRows,
    stats: {
      count: Math.max(zoneRows.length, 1),
      radiusMeters,
    },
    label: `Heatmap zone (${zoneRows.length})`,
  };
}

export function createPathTarget(
  coordinates: number[][],
  selectedRows: CustomObject[] = [],
  source: CameraTargetSource = 'data-path',
) {
  const normalizedCoordinates = unwrapPath(coordinates.filter(isFiniteLngLat).map(normalizeLngLat));
  if (normalizedCoordinates.length < 2) {
    return undefined;
  }

  const bbox = bboxFromCoordinates(normalizedCoordinates);
  const center = centerOfBbox(bbox);
  const start = normalizedCoordinates[0];
  const end = normalizedCoordinates[normalizedCoordinates.length - 1];
  const pathLengthKm = getPathLengthKm(normalizedCoordinates);

  return {
    id: createId('target-path'),
    type: 'path',
    source,
    center,
    bbox,
    visualFrame: createVisualFrame(bbox, center, {
      extraPaddingPx: 12,
      sampleCoordinates: normalizedCoordinates,
    }),
    coordinates: normalizedCoordinates,
    start,
    end,
    selectedRows,
    stats: {
      count: selectedRows.length || normalizedCoordinates.length,
      pathLengthKm,
    },
    label: `Path (${formatPathLength(pathLengthKm)})`,
  } satisfies CameraTarget;
}

export function createMultipleTarget(targets: CameraTarget[]): CameraTarget {
  const usableTargets = targets.map(normalizeCameraTarget).filter((target) => target.type !== 'none');
  const bbox = mergeBboxes(usableTargets.map((target) => target.bbox));
  const visualBbox = mergeBboxes(usableTargets.map(getTargetVisualBbox));
  const center = centerOfBbox(bbox);
  const visualFrameAnchor = centerOfBbox(visualBbox);
  const bboxAreaKm2 = getBboxAreaKm2(bbox);
  const visualAreaKm2 = getBboxAreaKm2(visualBbox);
  const referenceAreaKm2 =
    maxNumber(usableTargets.map((target) => getTargetReferenceAreaKm2(target) ?? 0)) || undefined;
  const bboxAreaRatio = referenceAreaKm2
    ? clamp01(bboxAreaKm2 / referenceAreaKm2)
    : clamp01(maxNumber(usableTargets.map((target) => getTargetBboxAreaRatio(target) ?? 0)));
  const visualAreaRatio = referenceAreaKm2
    ? clamp01(visualAreaKm2 / referenceAreaKm2)
    : clamp01(maxNumber(usableTargets.map((target) => getTargetVisualAreaRatio(target) ?? 0)));
  const childVisualAreaKm2 = usableTargets.reduce(
    (sum, target) => sum + getBboxAreaKm2(getTargetVisualBbox(target)),
    0.000001,
  );
  const dispersionRatio =
    usableTargets.length > 1
      ? clamp01(Math.max(0, visualAreaKm2 / childVisualAreaKm2 - 1) / Math.max(1, usableTargets.length))
      : 0;

  return {
    id: createId('target-multiple'),
    type: 'multiple',
    source: 'combined-targets',
    children: usableTargets.slice(),
    center,
    bbox,
    visualFrame: createVisualFrame(visualBbox, visualFrameAnchor, {
      heightMeters: maxNumber(usableTargets.map((target) => getTargetVisualHeightMeters(target) ?? 0)) || undefined,
      extraPaddingPx: maxNumber(usableTargets.map((target) => getTargetExtraPaddingPx(target) ?? 0)) || undefined,
      sampleCoordinates: usableTargets.flatMap((target) => target.visualFrame?.sampleCoordinates ?? [target.center]),
    }),
    coordinates: usableTargets.map((target) => target.center),
    selectedRows: usableTargets.flatMap((target) => target.selectedRows ?? []),
    stats: {
      count: usableTargets.reduce((sum, target) => sum + (target.stats?.count ?? 1), 0),
      densityRatio: clamp01(maxNumber(usableTargets.map((target) => target.stats?.densityRatio ?? 0))),
      elevationRatio: clamp01(maxNumber(usableTargets.map((target) => target.stats?.elevationRatio ?? 0))),
      maxElevationRatio: clamp01(maxNumber(usableTargets.map((target) => target.stats?.maxElevationRatio ?? 0))),
      bboxAreaKm2,
      bboxAreaRatio,
      visualAreaKm2,
      visualAreaRatio,
      dispersionRatio:
        dispersionRatio || clamp01(maxNumber(usableTargets.map((target) => getTargetDispersionRatio(target) ?? 0))),
      referenceAreaKm2,
      layerKinds: getUniqueValues(usableTargets.flatMap((target) => target.stats?.layerKinds ?? [])),
      radiusMeters: maxNumber(usableTargets.map((target) => target.stats?.radiusMeters ?? 0)),
      selectedElevationValue: maxNumber(usableTargets.map((target) => target.stats?.selectedElevationValue ?? 0)),
      maxElevationValue: maxNumber(usableTargets.map((target) => target.stats?.maxElevationValue ?? 0)),
      selectedElevationMeters: maxNumber(usableTargets.map((target) => target.stats?.selectedElevationMeters ?? 0)),
      maxElevationMeters: maxNumber(usableTargets.map((target) => target.stats?.maxElevationMeters ?? 0)),
      heightOverflowRatio:
        maxNumber(usableTargets.map((target) => target.stats?.heightOverflowRatio ?? 0)) || undefined,
    },
    label: `Multiple targets (${usableTargets.length})`,
  };
}

export function createTargetFromView(viewState: CameraView, type: string = 'none'): CameraTarget {
  const center = normalizeLngLat([viewState.longitude, viewState.latitude]);
  const normalizedType = normalizeTargetType(type);
  const bbox = normalizeBbox([center[0], center[1], center[0], center[1]]);

  return {
    id: createId(`target-${normalizedType}`),
    type: normalizedType,
    source: 'view-fallback',
    center,
    bbox,
    visualFrame: normalizedType === 'none' ? undefined : createVisualFrame(bbox, center),
    coordinates: [center],
    stats: {
      count: normalizedType === 'none' ? 0 : 1,
    },
    label: normalizedType === 'none' ? 'Current view' : `[${center[0]}, ${center[1]}]`,
  };
}

export function isCameraTarget(value: unknown): value is CameraTarget {
  const maybeTarget = value as CameraTarget;
  return (
    Boolean(maybeTarget) &&
    typeof maybeTarget.id === 'string' &&
    isFiniteLngLat(maybeTarget.center) &&
    Array.isArray(maybeTarget.bbox) &&
    maybeTarget.bbox.length === 4
  );
}

export function normalizeCameraTarget(target: CameraTarget): CameraTarget {
  const normalizedType = normalizeTargetType(target.type);
  return normalizedType === target.type ? target : { ...target, type: normalizedType };
}

export function getTargetIdentity(target: CameraTarget) {
  const bboxKey = target.bbox.map((value) => value.toFixed(3)).join(',');
  return `${normalizeTargetType(target.type)}:${bboxKey}`;
}

export function appendUniqueTargetHistory(targets: CameraTarget[], target: CameraTarget, limit = 8): CameraTarget[] {
  const normalizedTarget = normalizeCameraTarget(target);
  if (normalizedTarget.type === 'none') {
    return targets;
  }

  const targetIdentity = getSelectionIdentity(normalizedTarget);
  const distinctHistory = targets.filter(
    (historyTarget) =>
      normalizeCameraTarget(historyTarget).type !== 'none' && getSelectionIdentity(historyTarget) !== targetIdentity,
  );
  const capacity = Math.max(0, Math.floor(limit));
  return capacity === 0 ? [] : [...distinctHistory, normalizedTarget].slice(-capacity);
}

export function getLatestComparisonPair(targets: CameraTarget[]): [CameraTarget, CameraTarget] | undefined {
  const usableTargets = targets.map(normalizeCameraTarget).filter((target) => target.type !== 'none');
  const latestTarget = usableTargets[usableTargets.length - 1];
  if (!latestTarget) {
    return undefined;
  }

  const latestIdentity = getSelectionIdentity(latestTarget);
  for (let index = usableTargets.length - 2; index >= 0; index -= 1) {
    if (getSelectionIdentity(usableTargets[index]) !== latestIdentity) {
      return [usableTargets[index], latestTarget];
    }
  }

  return undefined;
}

export function enrichCameraTargetStats(target: CameraTarget, context: CameraTargetStatsContext = {}): CameraTarget {
  const analytics = context.analytics;
  const layers = analytics?.layers ?? [];
  const primaryLayer = analytics?.primaryLayer ?? layers[0];
  const bboxAreaKm2 = getBboxAreaKm2(target.bbox);
  const dataAreaKm2 = analytics?.combinedBboxAreaKm2 ?? primaryLayer?.bboxAreaKm2;
  const areaFraction = dataAreaKm2 ? bboxAreaKm2 / dataAreaKm2 : undefined;
  const rowCount = primaryLayer?.rowCount ?? Math.max(target.selectedRows?.length ?? 0, target.stats?.count ?? 0);
  const count = Math.max(target.selectedRows?.length ?? 0, target.stats?.count ?? 0);
  const countFraction = rowCount > 0 ? count / rowCount : undefined;
  const densityRaw =
    areaFraction && countFraction !== undefined && areaFraction > 0
      ? Math.log2(countFraction / areaFraction + 1) / 3
      : undefined;
  const clusterDensity = primaryLayer?.maxClusterCount && count > 1 ? count / primaryLayer.maxClusterCount : undefined;
  const selectedElevationValue =
    getPickedElevationValue(context.pickedObject) ?? getSelectedElevationValue(target.selectedRows ?? []);
  const maxElevationValue = Math.max(...layers.map((layer) => layer.maxElevationValue ?? 0), 0);
  const selectedElevationMeters = getSelectedElevationMeters(layers, selectedElevationValue);
  const maxElevationMeters = getMaxElevationMeters(layers);
  const elevationRatio =
    maxElevationMeters && selectedElevationMeters !== undefined
      ? selectedElevationMeters / maxElevationMeters
      : maxElevationValue > 0 && selectedElevationValue !== undefined
        ? selectedElevationValue / maxElevationValue
        : clusterDensity;
  const radiusMeters = Math.max(...layers.map((layer) => layer.radiusMeters ?? 0), 0);
  const layerKinds = getUniqueValues(layers.map((layer) => layer.kind));
  const rowBbox = bboxFromRows(target.selectedRows ?? []);
  const visualBboxes = [target.visualFrame?.bbox ?? target.bbox, target.bbox, rowBbox].filter(Boolean) as BBox[];
  const visualBaseBbox = mergeBboxes(visualBboxes);
  const visualBbox = expandBboxByMeters(visualBaseBbox, radiusMeters || undefined);
  const visualAreaKm2 = getBboxAreaKm2(visualBbox);
  const referenceAreaKm2 = dataAreaKm2;
  const visualAreaRatio = referenceAreaKm2 ? visualAreaKm2 / referenceAreaKm2 : undefined;
  const visualHeightMeters = estimateVisualHeightMeters({
    layerKinds,
    selectedElevationValue,
    selectedElevationMeters,
    elevationRatio: clamp01(elevationRatio),
    radiusMeters: radiusMeters || undefined,
  });
  const extraPaddingPx =
    target.type === 'location'
      ? Math.max(target.visualFrame?.extraPaddingPx ?? 0, 20)
      : target.type === 'path'
        ? Math.max(target.visualFrame?.extraPaddingPx ?? 0, 14)
        : target.visualFrame?.extraPaddingPx;
  const framingHeightMeters = visualHeightMeters ?? target.visualFrame?.heightMeters;
  const heightOverflowRatio = getHeightOverflowRatio(selectedElevationMeters, framingHeightMeters);

  return {
    ...target,
    visualFrame: createVisualFrame(visualBbox, target.visualFrame?.anchor ?? target.center, {
      heightMeters: framingHeightMeters,
      extraPaddingPx,
      sampleCoordinates: target.visualFrame?.sampleCoordinates,
    }),
    stats: {
      ...target.stats,
      count,
      bboxAreaKm2,
      bboxAreaRatio: clamp01(areaFraction),
      visualAreaKm2,
      visualAreaRatio: clamp01(visualAreaRatio),
      referenceAreaKm2,
      densityRatio: clamp01(Math.max(densityRaw ?? 0, clusterDensity ?? 0)),
      density: clamp01(Math.max(densityRaw ?? 0, clusterDensity ?? 0)),
      elevationRatio: clamp01(elevationRatio),
      maxElevationRatio: clamp01(elevationRatio),
      layerKinds,
      radiusMeters: radiusMeters || undefined,
      selectedElevationValue,
      maxElevationValue: maxElevationValue || undefined,
      selectedElevationMeters,
      maxElevationMeters,
      heightOverflowRatio,
    },
  };
}
