import { HexagonLayer, HeatmapLayer } from '@deck.gl/aggregation-layers';
import { WebMercatorViewport } from '@deck.gl/core';
import type { Color, Effect, PickingInfo } from '@deck.gl/core';
import { LineLayer, PolygonLayer, ScatterplotLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import { CSVLoader } from '@loaders.gl/csv';
import { load } from '@loaders.gl/core';
import * as d3 from 'd3';
import _ from 'lodash';
import { getTripTimedPath } from './trip-data';
import {
  ANIMATED_LAYER_INITIAL_VIEW_STATE,
  ANIMATED_LAYER_MAP_STYLE,
  ANIMATED_LAYER_THEME,
  COLUMBUS_HEXAGON_INITIAL_VIEW_STATE,
  BART_RIDERSHIP_INITIAL_VIEW_STATE,
  HEXAGON_LAYER_COLOR_RANGE,
  HEXAGON_LAYER_INITIAL_VIEW_STATE,
  HEXAGON_LAYER_LIGHTING_EFFECT,
  HEXAGON_LAYER_MAP_STYLE,
  HEXAGON_LAYER_MATERIAL,
  LINE_LAYER_INITIAL_VIEW_STATE,
  LINE_LAYER_MAP_STYLE,
  MIX_LAYER_INITIAL_VIEW_STATE,
  MIX_LAYER_MAP_STYLE,
  POINT_LAYER_INITIAL_VIEW_STATE,
  POINT_LAYER_MAP_STYLE,
  SF_BIKE_PARKING_INITIAL_VIEW_STATE,
} from '../constant';
import type { CameraView, CustomObject, DeckglLayer } from '../interfaces';
import { fitBboxToView, getDefaultViewportSize } from '../camera/viewport';
import type {
  AdaptiveVisualizationDefaults,
  AdaptiveVisualizationMetrics,
  DataFileConfig,
  DatasetConfig,
  LayerConfig,
  ResolvedLayerRuntime,
  ResolvedVisualizationShell,
  ResolvedVisualizationRuntime,
  UploadedDatasetOverride,
  UploadedDatasetOverrides,
  VisualizationCatalog,
  VisualizationAnalytics,
  VisualizationConfig,
  VisualizationLayerAnalytics,
  VisualizationLayerValue,
  VisualizationLayerRenderOptions,
  VisualizationParameterConfig,
  VisualizationParameterValues,
  VisualizationRuntimeContext,
} from './types';
import { getVisualizationCameraConstraints } from './camera-constraints';
import { VISUALIZATION_MAP_STYLE_PARAM_KEY } from './types';
import {
  HEXAGON_SELECTION_POSITION_ACCESSOR_ID,
  HEXAGON_SELECTION_POSITION_FIELD,
  REQUIRED_CAMERA_CALIBRATION_METRIC_UNITS,
  findRendererAdapterContract,
  getRenderQueryContract,
  hasRendererAdapterTuple,
  isKnownCameraEnvelopeProducer,
  isKnownAccessorId,
  isKnownRenderQueryId,
  resolveVisualizationDatasetId,
  validateLayerCameraContractShape,
  type KnownAccessorId,
  type SelectionMode,
} from './camera-contract';
import { digestCanonical } from '../camera/geometry/canonical-digest';
import { MERCATOR_LATITUDE_LIMIT } from '../camera/geometry/geo-wrap';
import { parseLayerValueReference, resolveLayerDescriptor } from './resolved-layer';
import { BoundedAsyncCache, createReadonlyMapSnapshot, snapshotPlainData } from './immutable-data';
import { runtimeAnalysisProfileCache } from './analysis-profile';
import { getRenderedHexagonCellPosition } from './hexagon-cell';
import { createBartPresentation, fitBartInitialView } from './bart-presentation';
import { getLineColor, getLineWidth, getLineSource, getLineTarget, getLineTooltip } from './line-data';

type DataLoader = (file: DataFileConfig) => Promise<CustomObject[]>;
type DataNormalizer = (rows: readonly CustomObject[]) => CustomObject[];
type Accessor = (object: CustomObject) => unknown;
type Tooltip = (info: PickingInfo<CustomObject>) => string | null;
type LayerFactory = (
  runtime: ResolvedLayerRuntime,
  config: LayerConfig,
  context: VisualizationRuntimeContext,
) => DeckglLayer;

function getOwnRegistryValue<T>(registry: Record<string, T>, key: unknown): T | undefined {
  if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(registry, key)) {
    return undefined;
  }
  return registry[key];
}

const UK_HEXAGON_DATA_BOUNDS = {
  minLongitude: -8,
  maxLongitude: 2,
  minLatitude: 49,
  maxLatitude: 61,
};
const HEXAGON_ELEVATION_RANGE: [number, number] = [0, 3000];
const HEXAGON_ELEVATION_SCALE = 50;
const CONSTANT_ONE_ACCESSOR_ID = 'constant1';
const ADAPTIVE_RADIUS_SCALE = 0.65;
const ADAPTIVE_FOCUS_MAX_QUANTILE = 0.18;
const ADAPTIVE_FOCUS_MIN_QUANTILE = 0.02;
const ADAPTIVE_FOCUS_SHORT_SIDE_MIN_KM = 20;
const ADAPTIVE_FOCUS_SHORT_SIDE_MAX_KM = 300;
const ADAPTIVE_VIEW_PADDING_PX = 64;
const DATA_CACHE_CAPACITY = 32;
const DATA_CACHE_MAX_ENTRIES = 64;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_ROWS = 100_000;
const MAX_UPLOAD_DEPTH = 64;
const MAX_UPLOAD_NODES = 1_000_000;
const MAX_BUNDLED_DATA_DEPTH = 64;
const MAX_BUNDLED_DATA_NODES = 5_000_000;
const EMPTY_DATA: readonly CustomObject[] = Object.freeze([]);
const OWNED_UPLOADED_DATASET_OVERRIDES = new WeakSet<UploadedDatasetOverride>();
const HEXAGON_DECK_MATERIAL = {
  ...HEXAGON_LAYER_MATERIAL,
  specularColor: HEXAGON_LAYER_MATERIAL.specularColor as [number, number, number],
};

type LngLat = [number, number];
const ANIMATED_DECK_MATERIAL = {
  ...ANIMATED_LAYER_THEME.material,
  specularColor: ANIMATED_LAYER_THEME.material.specularColor as [number, number, number],
};
const ANIMATED_BUILDING_COLOR = ANIMATED_LAYER_THEME.buildingColor as unknown as Color;

function parseFiniteCoordinate(value: unknown) {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }

  const normalizedValue = typeof value === 'string' ? value.trim() : value;

  if (normalizedValue === '') {
    return undefined;
  }

  const coordinate = Number(normalizedValue);
  return Number.isFinite(coordinate) ? coordinate : undefined;
}

function toDataArray(data: unknown) {
  const maybeLoaderResult = data as { data?: unknown };
  const rows = maybeLoaderResult?.data ?? data;
  return Array.isArray(rows) ? (rows as CustomObject[]) : [];
}

class UploadDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadDataError';
  }
}

function getFileName(url: string) {
  return url.split('/').pop() ?? url;
}

function isPresentFiniteNumber(value: unknown) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return false;
  }
  return Number.isFinite(Number(value));
}

function isFiniteLngLat(value: unknown) {
  return (
    Array.isArray(value) &&
    (value.length === 2 || value.length === 3) &&
    value.every(isPresentFiniteNumber) &&
    Number(value[0]) >= -180 &&
    Number(value[0]) <= 180 &&
    Number(value[1]) >= -MERCATOR_LATITUDE_LIMIT &&
    Number(value[1]) <= MERCATOR_LATITUDE_LIMIT
  );
}

function isCanonicalSelectionLngLat(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1]) &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

function hasFiniteFields(row: CustomObject, fields: string[]) {
  return fields.every((field) => isPresentFiniteNumber(row[field]));
}

function isUploadedRowCompatible(visualizationId: string, row: CustomObject) {
  if (visualizationId === 'hexagon') {
    return isFiniteLngLat([row.longitude, row.latitude]);
  }

  if (visualizationId === 'line') {
    if ('start' in row || 'end' in row) {
      return isFiniteLngLat(row.start) && isFiniteLngLat(row.end);
    }
    return (
      isFiniteLngLat([row.residence_lng, row.residence_lat]) &&
      isFiniteLngLat([row.workplace_lng, row.workplace_lat]) &&
      hasFiniteFields(row, ['all_flows'])
    );
  }

  if (visualizationId === 'point') {
    return isFiniteLngLat(row.coordinates);
  }

  if (visualizationId === 'mix') {
    return isFiniteLngLat([row.longitude, row.latitude]) && hasFiniteFields(row, ['n_killed', 'n_injured']);
  }

  if (visualizationId === 'animated') {
    const path = row.path;
    const timestamps = row.timestamps;
    return (
      Array.isArray(path) &&
      path.length >= 2 &&
      path.every(isFiniteLngLat) &&
      Array.isArray(timestamps) &&
      timestamps.length === path.length &&
      timestamps.every(isPresentFiniteNumber) &&
      isPresentFiniteNumber(row.vendor)
    );
  }

  return false;
}

function normalizeUploadedCoordinate(value: unknown) {
  if (!Array.isArray(value)) return value;
  return value.map((coordinate) => Number(coordinate));
}

function normalizeUploadedRow(visualizationId: string, row: CustomObject): CustomObject {
  const normalized = { ...row };
  if (visualizationId === 'hexagon') {
    normalized.longitude = Number(row.longitude);
    normalized.latitude = Number(row.latitude);
  } else if (visualizationId === 'line') {
    if (Array.isArray(row.start) && Array.isArray(row.end)) {
      normalized.start = normalizeUploadedCoordinate(row.start);
      normalized.end = normalizeUploadedCoordinate(row.end);
    } else {
      normalized.residence_lng = Number(row.residence_lng);
      normalized.residence_lat = Number(row.residence_lat);
      normalized.workplace_lng = Number(row.workplace_lng);
      normalized.workplace_lat = Number(row.workplace_lat);
      normalized.all_flows = Number(row.all_flows);
    }
  } else if (visualizationId === 'point') {
    normalized.coordinates = normalizeUploadedCoordinate(row.coordinates);
  } else if (visualizationId === 'mix') {
    normalized.longitude = Number(row.longitude);
    normalized.latitude = Number(row.latitude);
    normalized.n_killed = Number(row.n_killed);
    normalized.n_injured = Number(row.n_injured);
  } else if (visualizationId === 'animated') {
    normalized.path = Array.isArray(row.path) ? row.path.map(normalizeUploadedCoordinate) : row.path;
    normalized.timestamps = Array.isArray(row.timestamps)
      ? row.timestamps.map((timestamp) => Number(timestamp))
      : row.timestamps;
    normalized.vendor = Number(row.vendor);
  }
  return normalized;
}

async function parseUploadedRows(file: File) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new UploadDataError(`Upload file exceeds maximum size ${MAX_UPLOAD_BYTES} bytes.`);
  }
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension !== 'csv' && extension !== 'json') {
    throw new UploadDataError('Only .csv and .json files are supported.');
  }

  if (extension === 'csv') {
    try {
      return { format: extension, rows: toDataArray(await load(await file.arrayBuffer(), CSVLoader)) } as const;
    } catch {
      throw new UploadDataError(`Could not parse ${file.name} as CSV.`);
    }
  }

  try {
    return { format: extension, rows: toDataArray(JSON.parse(await file.text())) } as const;
  } catch {
    throw new UploadDataError(`Could not parse ${file.name} as JSON.`);
  }
}

function isPlainRecord(value: unknown): value is CustomObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotUploadedRows(
  rows: readonly CustomObject[],
  collectionLabel = 'Upload rows',
  rowLabel = 'Upload row',
): readonly CustomObject[] {
  if (rows.length > MAX_UPLOAD_ROWS) {
    throw new UploadDataError(`${collectionLabel} exceed maximum row count ${MAX_UPLOAD_ROWS}.`);
  }
  for (let index = 0; index < rows.length; index += 1) {
    if (!isPlainRecord(rows[index])) {
      throw new UploadDataError(`${rowLabel} ${index} must be a plain record.`);
    }
  }
  return snapshotPlainData(rows, {
    label: collectionLabel,
    maxDepth: MAX_UPLOAD_DEPTH,
    maxNodes: MAX_UPLOAD_NODES,
    createError: (message) => new UploadDataError(message),
  });
}

function isInHexagonDataBounds(longitude: number, latitude: number) {
  return (
    longitude >= UK_HEXAGON_DATA_BOUNDS.minLongitude &&
    longitude <= UK_HEXAGON_DATA_BOUNDS.maxLongitude &&
    latitude >= UK_HEXAGON_DATA_BOUNDS.minLatitude &&
    latitude <= UK_HEXAGON_DATA_BOUNDS.maxLatitude
  );
}

function getHexagonCount(object: CustomObject) {
  const count = object.count ?? object.elevationValue ?? object.points?.length;
  const numericCount = Number(count);

  return Number.isFinite(numericCount) ? numericCount : 0;
}

function degreesToRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

function getCoordinateDistanceKm(start: LngLat, end: LngLat) {
  const earthRadiusKm = 6371.0088;
  const startLat = degreesToRadians(start[1]);
  const endLat = degreesToRadians(end[1]);
  const deltaLat = degreesToRadians(end[1] - start[1]);
  const deltaLng = degreesToRadians(end[0] - start[0]);
  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(startLat) * Math.cos(endLat) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
  const clampedA = Math.min(1, Math.max(0, a));
  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(clampedA), Math.sqrt(1 - clampedA));
}

function getBboxAreaKm2(bbox: [number, number, number, number]) {
  const midLat = (bbox[1] + bbox[3]) / 2;
  const widthKm = getCoordinateDistanceKm([bbox[0], midLat], [bbox[2], midLat]);
  const heightKm = getCoordinateDistanceKm([bbox[0], bbox[1]], [bbox[0], bbox[3]]);
  return Math.max(0.000001, widthKm * heightKm);
}

function isLngLat(value: unknown): value is LngLat {
  return (
    Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))
  );
}

function normalizeLngLat(value: unknown): LngLat | undefined {
  return isLngLat(value) ? [Number(value[0]), Number(value[1])] : undefined;
}

function flattenCoordinates(value: unknown): LngLat[] {
  const coordinate = normalizeLngLat(value);
  if (coordinate) {
    return [coordinate];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => flattenCoordinates(item));
}

function bboxFromCoordinates(coordinates: LngLat[]): [number, number, number, number] | undefined {
  if (coordinates.length === 0) {
    return undefined;
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

  return [minLng, minLat, maxLng, maxLat];
}

function mergeBboxes(bboxes: [number, number, number, number][]) {
  if (bboxes.length === 0) {
    return undefined;
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

  return [minLng, minLat, maxLng, maxLat] satisfies [number, number, number, number];
}

function centerOfBbox(bbox: [number, number, number, number]): LngLat {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

function metersToLatitudeDegrees(meters: number) {
  return meters / 111000;
}

function metersToLongitudeDegrees(meters: number, latitude: number) {
  return meters / (111000 * Math.max(0.1, Math.cos(degreesToRadians(latitude))));
}

function expandBboxByMeters(bbox: [number, number, number, number], meters: number): [number, number, number, number] {
  if (!Number.isFinite(meters) || meters <= 0) {
    return bbox;
  }

  const center = centerOfBbox(bbox);
  const lngDelta = metersToLongitudeDegrees(meters, center[1]);
  const latDelta = metersToLatitudeDegrees(meters);
  return [bbox[0] - lngDelta, bbox[1] - latDelta, bbox[2] + lngDelta, bbox[3] + latDelta];
}

function getParameterReference(value: VisualizationLayerValue | undefined) {
  const reference = parseLayerValueReference(value);
  return reference.kind === 'param' ? reference.key : undefined;
}

function getVisualizationParameter(config: VisualizationConfig, key: string | undefined) {
  return key ? config.parameters?.find((parameter) => parameter.key === key) : undefined;
}

function getStepPrecision(step: number | undefined) {
  if (!step || !Number.isFinite(step)) {
    return 6;
  }

  const stepText = String(step);
  return stepText.includes('.') ? stepText.split('.')[1].length : 0;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0: number, edge1: number, value: number) {
  if (edge0 === edge1) {
    return value < edge0 ? 0 : 1;
  }

  const t = clampNumber((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function snapParameterValue(value: number, config: VisualizationConfig, key: string | undefined) {
  const parameter = getVisualizationParameter(config, key);
  const min = typeof parameter?.min === 'number' ? parameter.min : -Infinity;
  const max = typeof parameter?.max === 'number' ? parameter.max : Infinity;
  const step = typeof parameter?.step === 'number' && parameter.step > 0 ? parameter.step : undefined;
  const boundedValue = clampNumber(value, min, max);
  const snappedValue = step
    ? (Number.isFinite(min) ? min : 0) + Math.round((boundedValue - (Number.isFinite(min) ? min : 0)) / step) * step
    : boundedValue;
  const roundedValue = Number(snappedValue.toFixed(getStepPrecision(step)));

  return clampNumber(roundedValue, min, max);
}

function getSortedCoordinateValues(coordinates: LngLat[], coordinateIndex: 0 | 1) {
  return coordinates.map((coordinate) => coordinate[coordinateIndex]).sort((a, b) => a - b);
}

function getQuantileValue(sortedValues: number[], quantile: number) {
  if (sortedValues.length === 0) {
    return undefined;
  }

  const index = Math.floor((sortedValues.length - 1) * clampNumber(quantile, 0, 1));
  return sortedValues[index];
}

function getPercentileBbox(
  coordinates: LngLat[],
  lowerQuantile: number,
  upperQuantile: number,
): [number, number, number, number] | undefined {
  if (coordinates.length === 0) {
    return undefined;
  }

  const sortedLongitudes = getSortedCoordinateValues(coordinates, 0);
  const sortedLatitudes = getSortedCoordinateValues(coordinates, 1);
  const minLng = getQuantileValue(sortedLongitudes, lowerQuantile);
  const minLat = getQuantileValue(sortedLatitudes, lowerQuantile);
  const maxLng = getQuantileValue(sortedLongitudes, upperQuantile);
  const maxLat = getQuantileValue(sortedLatitudes, upperQuantile);

  if (
    minLng === undefined ||
    minLat === undefined ||
    maxLng === undefined ||
    maxLat === undefined ||
    minLng > maxLng ||
    minLat > maxLat
  ) {
    return undefined;
  }

  return [minLng, minLat, maxLng, maxLat];
}

function getClusterBinCounts(coordinates: LngLat[], radiusMeters: number) {
  if (coordinates.length === 0 || !Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    return [];
  }

  const meanLat = coordinates.reduce((sum, coordinate) => sum + coordinate[1], 0) / coordinates.length;
  const latStep = Math.max(radiusMeters / 111000, 0.0001);
  const lngStep = Math.max(radiusMeters / (111000 * Math.max(0.1, Math.cos(degreesToRadians(meanLat)))), 0.0001);
  const bins = new Map<string, number>();

  for (const [longitude, latitude] of coordinates) {
    const key = `${Math.floor(longitude / lngStep)}:${Math.floor(latitude / latStep)}`;
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }

  return [...bins.values()].sort((a, b) => a - b);
}

function getPercentile(sortedValues: number[], percentile: number) {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor((sortedValues.length - 1) * percentile)));
  return sortedValues[index];
}

function getAdaptiveHexagonParameterKeys(layerConfig: LayerConfig) {
  return {
    coverageParam: getParameterReference(layerConfig.props?.coverage),
    radiusParam: layerConfig.analytics?.radiusParam ?? getParameterReference(layerConfig.props?.radius),
    upperPercentileParam: getParameterReference(layerConfig.props?.upperPercentile),
  };
}

function getAdaptiveCoverage(meanBinCount: number, config: VisualizationConfig, coverageParam: string | undefined) {
  const crowdingCoverageReduction = clampNumber((meanBinCount - 4) / 30, 0, 0.2);
  return snapParameterValue(1 - crowdingCoverageReduction, config, coverageParam);
}

function getAdaptiveUpperPercentile(sortedBinCounts: number[], config: VisualizationConfig, key: string | undefined) {
  const p99BinCount = getPercentile(sortedBinCounts, 0.99);
  const maxBinCount = sortedBinCounts[sortedBinCounts.length - 1] ?? 0;
  const skewRatio = p99BinCount > 0 ? maxBinCount / p99BinCount : 1;
  const upperPercentile = skewRatio >= 20 ? 98 : skewRatio >= 10 ? 99 : 100;

  return snapParameterValue(upperPercentile, config, key);
}

function getRadiusAreaKm2(areaKm2: number, widthKm: number, heightKm: number) {
  const shortSideKm = Math.min(widthKm, heightKm);
  return Math.min(areaKm2, shortSideKm * shortSideKm);
}

function getAdaptiveFocusQuantile(widthKm: number, heightKm: number) {
  const shortSideKm = Math.min(widthKm, heightKm);
  const focusStrength = smoothstep(ADAPTIVE_FOCUS_SHORT_SIDE_MIN_KM, ADAPTIVE_FOCUS_SHORT_SIDE_MAX_KM, shortSideKm);

  return clampNumber(
    ADAPTIVE_FOCUS_MAX_QUANTILE * focusStrength,
    ADAPTIVE_FOCUS_MIN_QUANTILE,
    ADAPTIVE_FOCUS_MAX_QUANTILE,
  );
}

function getDatasetReferenceView(dataset: DatasetConfig) {
  return dataset.initialViewState ? getOwnRegistryValue(viewStateRegistry, dataset.initialViewState) : undefined;
}

function getReferenceZoomCeiling(dataset: DatasetConfig, baseView: CameraView) {
  const referenceView = getDatasetReferenceView(dataset);
  if (!referenceView || !Number.isFinite(referenceView.zoom)) {
    return undefined;
  }

  return clampNumber(referenceView.zoom, baseView.minZoom ?? -Infinity, baseView.maxZoom ?? Infinity);
}

function getFocusBboxForQuantile(coordinates: LngLat[], quantile: number) {
  return getPercentileBbox(coordinates, quantile, 1 - quantile) ?? bboxFromCoordinates(coordinates);
}

function getViewportForView(view: CameraView, viewportSize: { width: number; height: number }) {
  return new WebMercatorViewport({
    width: viewportSize.width,
    height: viewportSize.height,
    longitude: view.longitude,
    latitude: view.latitude,
    zoom: view.zoom,
    pitch: view.pitch,
    bearing: view.bearing,
    altitude: view.altitude,
  });
}

function isBboxVisibleInView({
  bbox,
  view,
  viewportSize,
  padding,
}: {
  bbox: [number, number, number, number];
  view: CameraView;
  viewportSize: { width: number; height: number };
  padding: number;
}) {
  const viewport = getViewportForView(view, viewportSize);
  const corners: LngLat[] = [
    [bbox[0], bbox[1]],
    [bbox[0], bbox[3]],
    [bbox[2], bbox[1]],
    [bbox[2], bbox[3]],
  ];

  return corners.every((corner) => {
    const projected = viewport.project(corner);
    return (
      Array.isArray(projected) &&
      projected.length >= 2 &&
      Number.isFinite(projected[0]) &&
      Number.isFinite(projected[1]) &&
      projected[0] >= padding &&
      projected[0] <= viewportSize.width - padding &&
      projected[1] >= padding &&
      projected[1] <= viewportSize.height - padding
    );
  });
}

function applyReferenceCenterIfSafe({
  view,
  viewBbox,
  referenceView,
  viewportSize,
  padding,
}: {
  view: CameraView;
  viewBbox: [number, number, number, number];
  referenceView: CameraView | undefined;
  viewportSize: { width: number; height: number };
  padding: number;
}) {
  if (!referenceView || !Number.isFinite(referenceView.longitude) || !Number.isFinite(referenceView.latitude)) {
    return view;
  }

  const referenceCenteredView = {
    ...view,
    longitude: referenceView.longitude,
    latitude: referenceView.latitude,
  };

  return isBboxVisibleInView({
    bbox: viewBbox,
    view: referenceCenteredView,
    viewportSize,
    padding,
  })
    ? referenceCenteredView
    : view;
}

function fitAdaptiveFocusBbox({
  coordinates,
  widthKm,
  heightKm,
  radiusMeters,
  baseView,
  viewportSize,
  zoomCeiling,
}: {
  coordinates: LngLat[];
  widthKm: number;
  heightKm: number;
  radiusMeters: number;
  baseView: CameraView;
  viewportSize: { width: number; height: number };
  zoomCeiling: number | undefined;
}) {
  const maxQuantile = getAdaptiveFocusQuantile(widthKm, heightKm);
  const minQuantile = Math.min(ADAPTIVE_FOCUS_MIN_QUANTILE, maxQuantile);

  const fitAtQuantile = (quantile: number) => {
    const focusBbox = getFocusBboxForQuantile(coordinates, quantile) ?? bboxFromCoordinates(coordinates);
    const expandedBbox = focusBbox ? expandBboxByMeters(focusBbox, radiusMeters) : undefined;
    const view = expandedBbox
      ? fitBboxToView({
          bbox: expandedBbox,
          baseView,
          viewportSize,
          padding: ADAPTIVE_VIEW_PADDING_PX,
          maxZoom: baseView.maxZoom,
        })
      : baseView;

    return { view, expandedBbox };
  };

  let bestFit = fitAtQuantile(maxQuantile);
  if (zoomCeiling === undefined || bestFit.view.zoom <= zoomCeiling) {
    return bestFit;
  }

  const widestFit = fitAtQuantile(minQuantile);
  if (widestFit.view.zoom > zoomCeiling) {
    return {
      ...widestFit,
      view: {
        ...widestFit.view,
        zoom: zoomCeiling,
      },
    };
  }

  bestFit = widestFit;
  let lowQuantile = minQuantile;
  let highQuantile = maxQuantile;

  for (let iteration = 0; iteration < 16; iteration++) {
    const midQuantile = (lowQuantile + highQuantile) / 2;
    const midFit = fitAtQuantile(midQuantile);

    if (midFit.view.zoom <= zoomCeiling) {
      bestFit = midFit;
      lowQuantile = midQuantile;
    } else {
      highQuantile = midQuantile;
    }
  }

  return bestFit;
}

function getAdaptiveInitialViewState({
  config,
  dataset,
  coordinates,
  widthKm,
  heightKm,
  radiusMeters,
  context,
}: {
  config: VisualizationConfig;
  dataset: DatasetConfig;
  coordinates: LngLat[];
  widthKm: number;
  heightKm: number;
  radiusMeters: number;
  context: Pick<VisualizationRuntimeContext, 'viewportSize'>;
}) {
  const initialViewStateKey = resolveInitialViewStateKey(config, dataset);
  const registeredBaseView = getOwnRegistryValue(viewStateRegistry, initialViewStateKey);
  if (!registeredBaseView) {
    throw new Error(`Unknown view state "${String(initialViewStateKey)}".`);
  }
  const baseView = _.cloneDeep(registeredBaseView);
  const viewportSize = context.viewportSize ?? getDefaultViewportSize();
  const referenceView = getDatasetReferenceView(dataset);
  const referenceCenterView = dataset.initialViewState === config.initialViewState ? referenceView : undefined;
  const zoomCeiling = getReferenceZoomCeiling(dataset, baseView);
  const { view, expandedBbox } = fitAdaptiveFocusBbox({
    coordinates,
    widthKm,
    heightKm,
    radiusMeters,
    baseView,
    viewportSize,
    zoomCeiling,
  });

  return applyReferenceCenterIfSafe({
    view,
    viewBbox: expandedBbox ??
      bboxFromCoordinates(coordinates) ?? [
        baseView.longitude,
        baseView.latitude,
        baseView.longitude,
        baseView.latitude,
      ],
    referenceView: referenceCenterView,
    viewportSize,
    padding: ADAPTIVE_VIEW_PADDING_PX,
  });
}

function resolveAdaptiveVisualizationDefaultsFromLoadedFiles(
  config: VisualizationConfig,
  dataset: DatasetConfig,
  loadedFiles: ReadonlyMap<string, readonly CustomObject[]>,
  context: Pick<VisualizationRuntimeContext, 'params' | 'viewportSize'>,
): AdaptiveVisualizationDefaults | undefined {
  const layerConfig = config.layers.find((layer) => layer.analytics?.kind === 'hexagon');
  if (!layerConfig) {
    return undefined;
  }

  const { coverageParam, radiusParam, upperPercentileParam } = getAdaptiveHexagonParameterKeys(layerConfig);
  if (!coverageParam || !radiusParam || !upperPercentileParam) {
    return undefined;
  }

  const data = loadedFiles.get(layerConfig.dataRef) ?? EMPTY_DATA;
  const profile = getLayerAnalysisProfile(layerConfig, data);
  const { coordinates, bbox } = profile;
  if (!bbox || coordinates.length === 0) {
    return undefined;
  }

  const center = centerOfBbox(bbox);
  const widthKm = getCoordinateDistanceKm([bbox[0], center[1]], [bbox[2], center[1]]);
  const heightKm = getCoordinateDistanceKm([center[0], bbox[1]], [center[0], bbox[3]]);
  const areaKm2 = profile.bboxAreaKm2 ?? getBboxAreaKm2(bbox);
  const densityRadiusMeters =
    Math.sqrt(getRadiusAreaKm2(areaKm2, widthKm, heightKm) / coordinates.length) * 1000 * ADAPTIVE_RADIUS_SCALE;
  const radiusMeters = snapParameterValue(densityRadiusMeters, config, radiusParam);
  const sortedBinCounts = getLayerClusterBinCounts(layerConfig, data, profile, radiusMeters);
  const occupiedBinCount = sortedBinCounts.length;
  const meanBinCount = occupiedBinCount > 0 ? coordinates.length / occupiedBinCount : 0;
  const p99BinCount = getPercentile(sortedBinCounts, 0.99);
  const maxBinCount = sortedBinCounts[sortedBinCounts.length - 1] ?? 0;
  const parameterPatch: VisualizationParameterValues = {
    [coverageParam]: getAdaptiveCoverage(meanBinCount, config, coverageParam),
    [radiusParam]: radiusMeters,
    [upperPercentileParam]: getAdaptiveUpperPercentile(sortedBinCounts, config, upperPercentileParam),
  };
  const metrics: AdaptiveVisualizationMetrics = {
    rowCount: coordinates.length,
    bbox,
    center,
    widthKm,
    heightKm,
    areaKm2,
    densityPerKm2: coordinates.length / areaKm2,
    radiusMeters,
    occupiedBinCount,
    meanBinCount,
    p99BinCount,
    maxBinCount,
  };

  return {
    parameterPatch,
    initialViewState: getAdaptiveInitialViewState({
      config,
      dataset,
      coordinates,
      widthKm,
      heightKm,
      radiusMeters,
      context,
    }),
    metrics,
  };
}

function getResolvedAccessors(accessorIds: Record<string, string>) {
  const accessors: Record<string, unknown> = {};
  for (const [propName, accessorName] of Object.entries(accessorIds)) {
    const accessor = getAccessorById(accessorName);
    if (!accessor) throw new Error(`Resolved descriptor references unknown accessor "${accessorName}".`);
    accessors[propName] = accessor;
  }
  return accessors;
}

function getDescriptorRenderProps(runtime: ResolvedLayerRuntime, context: VisualizationRuntimeContext) {
  const props = { ...runtime.descriptor.resolvedProps };
  if (context.layerRenderOptions?.transitions === false) delete props.transitions;
  return props;
}

function getClickHandler(config: LayerConfig, context: VisualizationRuntimeContext) {
  if (!config.onClick) {
    return undefined;
  }
  const handler = getOwnRegistryValue(context.clickHandlers, config.onClick);
  if (typeof handler !== 'function') {
    throw new Error(`Layer "${config.id}" click handler "${config.onClick}" must be an own function.`);
  }
  return context.layerRenderOptions?.interactive === false ? undefined : handler;
}

function getLayerId(config: LayerConfig, context: VisualizationRuntimeContext) {
  return `${context.layerRenderOptions?.idPrefix ?? ''}${config.id}`;
}

function isLayerInteractive(context: VisualizationRuntimeContext) {
  return context.layerRenderOptions?.interactive !== false;
}

function getLayerTransitions<T>(context: VisualizationRuntimeContext, transitions: T): T | undefined {
  return context.layerRenderOptions?.transitions === false ? undefined : transitions;
}

export const dataLoaderRegistry: Record<string, DataLoader> = {
  csv: async (file) => toDataArray(await load(file.url, CSVLoader)),
  json: async (file) => toDataArray(await d3.json(file.url)),
};

export const normalizerRegistry: Record<string, DataNormalizer> = {
  finiteLonLat: (rows) =>
    rows.reduce<CustomObject[]>((data, row) => {
      const longitude = parseFiniteCoordinate(row.longitude);
      const latitude = parseFiniteCoordinate(row.latitude);

      if (longitude === undefined || latitude === undefined) {
        return data;
      }

      data.push({
        ...row,
        longitude,
        latitude,
      });
      return data;
    }, []),
  ukRoadSafetyBounds: (rows) =>
    rows.filter((row) => isInHexagonDataBounds(Number(row.longitude), Number(row.latitude))),
  bikeParkingCoordinates: (rows) =>
    rows.reduce<CustomObject[]>((data, row) => {
      const coordinates = Array.isArray(row.COORDINATES) ? row.COORDINATES : row.coordinates;
      const longitude = parseFiniteCoordinate(Array.isArray(coordinates) ? coordinates[0] : undefined);
      const latitude = parseFiniteCoordinate(Array.isArray(coordinates) ? coordinates[1] : undefined);

      if (longitude === undefined || latitude === undefined) {
        return data;
      }

      data.push({
        ...row,
        longitude,
        latitude,
      });
      return data;
    }, []),
};

export const accessorRegistry: Readonly<Record<string, Accessor>> = Object.freeze(
  Object.assign(Object.create(null) as Record<KnownAccessorId, Accessor>, {
    lonLat: (d) => [Number(d.longitude), Number(d.latitude)],
    [HEXAGON_SELECTION_POSITION_ACCESSOR_ID]: (d) => {
      const position = d[HEXAGON_SELECTION_POSITION_FIELD];
      return isCanonicalSelectionLngLat(position) ? [position[0], position[1]] : undefined;
    },
    constant1: () => 1,
    commuteSource: (d) => [Number(d.residence_lng), Number(d.residence_lat)],
    commuteTarget: (d) => [Number(d.workplace_lng), Number(d.workplace_lat)],
    commuteFlowColor: (d) => [1, 152, 189, 255 * (Number(d.all_flows) / 5000)] as Color,
    lineSource: getLineSource,
    lineTarget: getLineTarget,
    lineColor: getLineColor,
    lineWidth: getLineWidth,
    coordinates: (d) => d.coordinates,
    gunSeverityColor: (d) => (Number(d.n_killed) > 0 ? [200, 0, 40, 150] : [255, 140, 0, 100]),
    gunHeatWeight: (d) => Number(d.n_killed) + Number(d.n_injured) * 0.5,
    tripPath: (d) => getTripTimedPath(d)?.coordinates ?? d.path,
    tripTimestamps: (d) => getTripTimedPath(d)?.timestamps ?? d.timestamps,
    tripVendorColor: (d) =>
      Number(d.vendor) === 0 ? ANIMATED_LAYER_THEME.trailColor0 : ANIMATED_LAYER_THEME.trailColor1,
    buildingPolygon: (d) => d.polygon,
    buildingHeight: (d) => d.height,
  } satisfies Record<KnownAccessorId, Accessor>),
);

export function getAccessorById(value: unknown): Accessor | undefined {
  if (!isKnownAccessorId(value) || !Object.prototype.hasOwnProperty.call(accessorRegistry, value)) {
    return undefined;
  }
  const accessor = accessorRegistry[value];
  return typeof accessor === 'function' ? accessor : undefined;
}

export const tooltipRegistry: Record<string, Tooltip> = {
  lineDetails: ({ object }) => (object ? getLineTooltip(object) : null),
  hexagonCount: ({ object, layer }) => {
    if (!object) {
      return null;
    }

    const position =
      getRenderedHexagonCellPosition(layer ?? undefined, object) ??
      (Number.isFinite(object.col) && Number.isFinite(object.row) ? undefined : object.position);
    const lng = Number(position?.[0]);
    const lat = Number(position?.[1]);
    const count = getHexagonCount(object);

    return `\
      longitude: ${Number.isFinite(lng) ? lng.toFixed(3) : ''}
      latitude: ${Number.isFinite(lat) ? lat.toFixed(3) : ''}
      ${count} Accidents`;
  },
  commuteFlow: ({ object }) => {
    if (!object) {
      return null;
    }

    return `\
    all_flows: ${object.all_flows}
    source: [${object.residence_lng}, ${object.residence_lat}] 
    target: [${object.workplace_lng}, ${object.workplace_lat}]`;
  },
  gunIncident: ({ object }) => {
    if (!object) {
      return null;
    }

    const lng = Number(object.longitude);
    const lat = Number(object.latitude);

    return `\
      ID: ${object.incident_id}
      ${object.n_killed} Dead
      ${object.n_injured} Injured
      longitude: ${Number.isFinite(lng) ? lng.toFixed(3) : ''}
      latitude: ${Number.isFinite(lat) ? lat.toFixed(3) : ''}
      Went down on ${object.date}. ${object.notes}`;
  },
};

export const mapStyleRegistry: Record<string, string> = {
  'carto.darkNoLabels': HEXAGON_LAYER_MAP_STYLE,
  'carto.dark': MIX_LAYER_MAP_STYLE,
  'carto.positron': POINT_LAYER_MAP_STYLE,
  lineDarkNoLabels: LINE_LAYER_MAP_STYLE,
  animatedDarkNoLabels: ANIMATED_LAYER_MAP_STYLE,
};

export const viewStateRegistry: Record<string, CameraView> = {
  ukHexagon: HEXAGON_LAYER_INITIAL_VIEW_STATE,
  columbusHexagon: COLUMBUS_HEXAGON_INITIAL_VIEW_STATE,
  sfBikeParking: SF_BIKE_PARKING_INITIAL_VIEW_STATE,
  ukLine: LINE_LAYER_INITIAL_VIEW_STATE,
  bartRidership: BART_RIDERSHIP_INITIAL_VIEW_STATE,
  worldPoint: POINT_LAYER_INITIAL_VIEW_STATE,
  usMix: MIX_LAYER_INITIAL_VIEW_STATE,
  manhattanAnimated: ANIMATED_LAYER_INITIAL_VIEW_STATE,
};

export const effectRegistry: Record<string, Effect[]> = {
  ukHexagonLighting: [HEXAGON_LAYER_LIGHTING_EFFECT],
  animatedLighting: ANIMATED_LAYER_THEME.effects,
};

export const layerRegistry: Record<string, LayerFactory> = {
  HexagonLayer: (runtime, config, context) => {
    const support = runtime.descriptor.resolvedSupport;
    if (support.producer !== 'hexagon-cell') throw new Error('HexagonLayer requires hexagon-cell support.');
    return new HexagonLayer({
      id: getLayerId(config, context),
      gpuAggregation: true,
      colorRange: HEXAGON_LAYER_COLOR_RANGE as unknown as Color[],
      data: runtime.data,
      colorAggregation: 'SUM',
      elevationAggregation: 'SUM',
      getColorWeight: () => 1,
      getElevationWeight: () => 1,
      pickable: isLayerInteractive(context),
      autoHighlight: isLayerInteractive(context),
      material: HEXAGON_DECK_MATERIAL,
      transitions: getLayerTransitions(context, {
        elevationScale: 3000,
      }),
      ...getDescriptorRenderProps(runtime, context),
      ...getResolvedAccessors(runtime.descriptor.accessorIds),
      radius: support.radiusMeters,
      coverage: support.coverage,
      elevationRange: support.elevationRange,
      elevationScale: support.elevationScale,
      onClick: getClickHandler(config, context),
    });
  },
  LineLayer: (runtime, config, context) => {
    const support = runtime.descriptor.resolvedSupport;
    if (support.producer !== 'line-path') throw new Error('LineLayer requires line-path support.');
    return new LineLayer({
      id: getLayerId(config, context),
      data: runtime.data,
      opacity: 0.8,
      pickable: isLayerInteractive(context),
      autoHighlight: isLayerInteractive(context),
      ...getDescriptorRenderProps(runtime, context),
      ...getResolvedAccessors(runtime.descriptor.accessorIds),
      getWidth:
        support.producer === 'line-path' && support.widthAccessorId
          ? (getAccessorById(support.widthAccessorId) as (row: CustomObject) => number)
          : support.width.value,
      widthUnits: support.width.unit,
      widthScale: support.widthScale,
      widthMinPixels: support.widthMinPixels,
      ...(support.widthMaxPixels === undefined ? {} : { widthMaxPixels: support.widthMaxPixels }),
      onClick: getClickHandler(config, context),
    });
  },
  ScatterplotLayer: (runtime, config, context) => {
    const support = runtime.descriptor.resolvedSupport;
    if (support.producer !== 'scatter-point') throw new Error('ScatterplotLayer requires scatter-point support.');
    return new ScatterplotLayer({
      id: getLayerId(config, context),
      data: runtime.data,
      opacity: 0.8,
      ...(config.id === 'scatter' ? { filled: true } : {}),
      ...(config.id === 'point-map' ? { getFillColor: [155, 40, 0, 255] as Color } : {}),
      pickable: isLayerInteractive(context),
      autoHighlight: config.id !== 'scatter' && isLayerInteractive(context),
      ...getDescriptorRenderProps(runtime, context),
      ...getResolvedAccessors(runtime.descriptor.accessorIds),
      getRadius: support.radius.value,
      radiusUnits: support.radius.unit,
      radiusScale: support.radiusScale,
      radiusMinPixels: support.radiusMinPixels,
      ...(support.radiusMaxPixels === undefined ? {} : { radiusMaxPixels: support.radiusMaxPixels }),
      billboard: support.billboard,
      onClick: getClickHandler(config, context),
    });
  },
  HeatmapLayer: (runtime, config, context) => {
    const support = runtime.descriptor.resolvedSupport;
    if (support.producer !== 'heatmap-kernel') throw new Error('HeatmapLayer requires heatmap-kernel support.');
    return new HeatmapLayer({
      id: getLayerId(config, context),
      data: runtime.data,
      // Deck's 2048² default scans 4M texels to find the maximum on every
      // aggregation. Use a quarter of that work for live and preview maps.
      weightsTextureSize: 1024,
      // Keep zoom aggregation coalesced without the default half-second lag.
      debounceTimeout: 100,
      ...getDescriptorRenderProps(runtime, context),
      ...getResolvedAccessors(runtime.descriptor.accessorIds),
      ...(support.weightAccessorId === undefined ? { getWeight: support.weightDefault } : {}),
      radiusPixels: support.radiusPixels,
    });
  },
  TripsLayer: (runtime, config, context) => {
    const support = runtime.descriptor.resolvedSupport;
    if (support.producer !== 'trip-path') throw new Error('TripsLayer requires trip-path support.');
    return new TripsLayer({
      id: getLayerId(config, context),
      data: runtime.data,
      opacity: 0.3,
      pickable: isLayerInteractive(context),
      autoHighlight: isLayerInteractive(context),
      ...getDescriptorRenderProps(runtime, context),
      ...getResolvedAccessors(runtime.descriptor.accessorIds),
      getWidth: support.width.value,
      widthUnits: support.width.unit,
      widthScale: support.widthScale,
      widthMinPixels: support.widthMinPixels,
      ...(support.widthMaxPixels === undefined ? {} : { widthMaxPixels: support.widthMaxPixels }),
      billboard: support.billboard,
      jointRounded: support.jointRounded,
      capRounded: support.capRounded,
      ...(context.layerRenderOptions?.animationTime === undefined
        ? {}
        : { currentTime: context.layerRenderOptions.animationTime }),
      onClick: getClickHandler(config, context),
    });
  },
  PolygonLayer: (runtime, config, context) => {
    const support = runtime.descriptor.resolvedSupport;
    if (support.producer !== 'polygon-extrusion') {
      throw new Error('PolygonLayer requires polygon-extrusion support.');
    }
    return new PolygonLayer({
      id: getLayerId(config, context),
      data: runtime.data,
      wireframe: false,
      opacity: 0.5,
      getFillColor: ANIMATED_BUILDING_COLOR,
      material: ANIMATED_DECK_MATERIAL,
      ...getDescriptorRenderProps(runtime, context),
      ...getResolvedAccessors(runtime.descriptor.accessorIds),
      ...(support.elevationAccessorId === undefined ? { getElevation: support.elevationDefaultMeters } : {}),
      elevationScale: support.elevationScale,
    });
  },
};

function getNumericAccessorValue(accessorName: string | undefined, row: CustomObject) {
  if (!accessorName) {
    return undefined;
  }

  const value = Number(getAccessorById(accessorName)?.(row));
  return Number.isFinite(value) ? value : undefined;
}

function getLayerCoordinates(config: LayerConfig, data: readonly CustomObject[]) {
  const analytics = config.analytics;
  if (!analytics) {
    return [];
  }

  if (analytics.positionAccessor) {
    return data
      .map((row) => normalizeLngLat(getAccessorById(analytics.positionAccessor)?.(row)))
      .filter(Boolean) as LngLat[];
  }

  if (analytics.sourcePositionAccessor || analytics.targetPositionAccessor) {
    return data.flatMap(
      (row) =>
        [analytics.sourcePositionAccessor, analytics.targetPositionAccessor]
          .map((accessorName) => normalizeLngLat(getAccessorById(accessorName)?.(row)))
          .filter(Boolean) as LngLat[],
    );
  }

  if (analytics.pathAccessor || analytics.polygonAccessor) {
    const accessorName = analytics.pathAccessor ?? analytics.polygonAccessor;
    return data.flatMap((row) => flattenCoordinates(getAccessorById(accessorName)?.(row)));
  }

  return [];
}

interface LayerAnalysisProfile {
  coordinates: LngLat[];
  bbox?: [number, number, number, number];
  bboxAreaKm2?: number;
  maxElevationAccessorValue?: number;
  maxWeightValue?: number;
}

function getLayerAnalysisProfileKey(config: LayerConfig) {
  const analytics = config.analytics;
  return JSON.stringify([
    'layer-analysis:v1',
    config.id,
    analytics?.kind,
    analytics?.positionAccessor,
    analytics?.sourcePositionAccessor,
    analytics?.targetPositionAccessor,
    analytics?.pathAccessor,
    analytics?.polygonAccessor,
    analytics?.elevationAccessor,
    analytics?.weightAccessor,
  ]);
}

function getLayerAnalysisProfile(config: LayerConfig, data: readonly CustomObject[]): LayerAnalysisProfile {
  const profileKey = getLayerAnalysisProfileKey(config);
  return runtimeAnalysisProfileCache.getOrCreate(data, profileKey, () => {
    const coordinates = getLayerCoordinates(config, data);
    const bbox = bboxFromCoordinates(coordinates);
    let maxElevationAccessorValue: number | undefined;
    let maxWeightValue: number | undefined;
    const elevationAccessor = config.analytics?.elevationAccessor;
    const weightAccessor = config.analytics?.weightAccessor;

    if (elevationAccessor || weightAccessor) {
      for (const row of data) {
        const elevationValue = getNumericAccessorValue(elevationAccessor, row);
        const weightValue = getNumericAccessorValue(weightAccessor, row);
        if (elevationValue !== undefined) {
          maxElevationAccessorValue =
            maxElevationAccessorValue === undefined
              ? elevationValue
              : Math.max(maxElevationAccessorValue, elevationValue);
        }
        if (weightValue !== undefined) {
          maxWeightValue = maxWeightValue === undefined ? weightValue : Math.max(maxWeightValue, weightValue);
        }
      }
    }

    return {
      coordinates,
      bbox,
      bboxAreaKm2: bbox ? getBboxAreaKm2(bbox) : undefined,
      maxElevationAccessorValue,
      maxWeightValue,
    };
  });
}

function getLayerClusterBinCounts(
  config: LayerConfig,
  data: readonly CustomObject[],
  profile: LayerAnalysisProfile,
  radiusMeters: number | undefined,
) {
  if (!Number.isFinite(radiusMeters) || Number(radiusMeters) <= 0 || profile.coordinates.length === 0) {
    return [];
  }

  const finiteRadius = Number(radiusMeters);
  const key = `${getLayerAnalysisProfileKey(config)}:cluster:${finiteRadius}`;
  return runtimeAnalysisProfileCache.getOrCreate(data, key, () =>
    getClusterBinCounts(profile.coordinates, finiteRadius),
  );
}

function getLayerElevationRange(config: LayerConfig): [number, number] | undefined {
  if (config.analytics?.elevationRange) {
    return config.analytics.elevationRange;
  }

  return config.analytics?.kind === 'hexagon' ? HEXAGON_ELEVATION_RANGE : undefined;
}

function getLayerElevationScale(config: LayerConfig) {
  if (config.analytics?.elevationScale !== undefined) {
    return config.analytics.elevationScale;
  }

  return config.analytics?.kind === 'hexagon' ? HEXAGON_ELEVATION_SCALE : undefined;
}

function getLayerElevationDomain(
  config: LayerConfig,
  maxElevationValue: number | undefined,
): [number, number] | undefined {
  if (config.analytics?.elevationDomain) {
    return config.analytics.elevationDomain;
  }
  if (maxElevationValue !== undefined) {
    return [0, maxElevationValue];
  }
  return undefined;
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

function getLayerAnalytics(
  config: LayerConfig,
  data: readonly CustomObject[],
  context: VisualizationRuntimeContext,
): VisualizationLayerAnalytics | undefined {
  if (!config.analytics) {
    return undefined;
  }

  const profile = getLayerAnalysisProfile(config, data);
  const { bbox } = profile;
  // Heatmap kernels use screen pixels, not meters. Geographic binning here
  // both misreports their support and rescans/sorts all rows on radius edits.
  // The renderer-backed heatmap query resolves support in the current view.
  const radiusMeters =
    config.analytics.kind === 'heatmap'
      ? undefined
      : (config.analytics.radiusMeters ??
        (config.analytics.radiusParam ? Number(context.params[config.analytics.radiusParam]) : undefined));
  const sortedBinCounts =
    config.analytics.kind === 'hexagon' ? getLayerClusterBinCounts(config, data, profile, radiusMeters) : [];
  const maxClusterCount = config.analytics.kind === 'hexagon' ? sortedBinCounts[sortedBinCounts.length - 1] : undefined;
  const maxElevationValue = profile.maxElevationAccessorValue ?? maxClusterCount;
  const elevationRange = getLayerElevationRange(config);
  const elevationScale = getLayerElevationScale(config);
  const elevationDomain = getLayerElevationDomain(config, maxElevationValue);

  return {
    id: config.id,
    kind: config.analytics.kind,
    rowCount: data.length,
    bbox,
    bboxAreaKm2: profile.bboxAreaKm2,
    radiusMeters,
    maxClusterCount,
    maxElevationValue,
    elevationScale,
    elevationRange,
    elevationDomain,
    maxElevationMeters: mapElevationValueToMeters(maxElevationValue, elevationRange, elevationScale, elevationDomain),
    maxWeightValue: profile.maxWeightValue,
  };
}

function buildVisualizationAnalytics(
  config: ResolvedVisualizationRuntime['config'],
  loadedFiles: ReadonlyMap<string, readonly CustomObject[]>,
  context: VisualizationRuntimeContext,
): VisualizationAnalytics {
  const layers = config.layers
    .map((layerConfig) => {
      const layerData = loadedFiles.get(layerConfig.dataRef) ?? EMPTY_DATA;
      return getLayerAnalytics(layerConfig, layerData, context);
    })
    .filter(Boolean) as VisualizationLayerAnalytics[];
  const layerBboxes = layers.map((layer) => layer.bbox).filter(Boolean) as [number, number, number, number][];
  const combinedBbox = mergeBboxes(layerBboxes);

  return {
    layers,
    primaryLayer: layers[0],
    combinedBbox,
    combinedBboxAreaKm2: combinedBbox ? getBboxAreaKm2(combinedBbox) : undefined,
  };
}

const dataCache = new BoundedAsyncCache<string, readonly CustomObject[]>(DATA_CACHE_CAPACITY, DATA_CACHE_MAX_ENTRIES);

async function loadDataFile(dataset: DatasetConfig, file: DataFileConfig) {
  const cacheKey = JSON.stringify([
    dataset.id,
    dataset.revision,
    dataset.normalizers ?? [],
    file.id,
    file.revision,
    file.url,
    file.format,
  ]);
  return dataCache.getOrCreate(cacheKey, async () => {
    const loader = getOwnRegistryValue(dataLoaderRegistry, file.format);
    if (!loader) {
      throw new Error(`Dataset "${dataset.id}" file "${file.id}" uses unknown loader "${String(file.format)}".`);
    }
    let rows: readonly CustomObject[] = await loader(file);
    for (const normalizerName of dataset.normalizers ?? []) {
      const normalizer = getOwnRegistryValue(normalizerRegistry, normalizerName);
      if (!normalizer) {
        throw new Error(`Dataset "${dataset.id}" uses unknown normalizer "${String(normalizerName)}".`);
      }
      rows = normalizer(rows);
    }
    return snapshotPlainData(rows, {
      label: `Dataset "${dataset.id}" file "${file.id}" rows`,
      maxDepth: MAX_BUNDLED_DATA_DEPTH,
      maxNodes: MAX_BUNDLED_DATA_NODES,
    });
  });
}

function getPrimaryFile(dataset: DatasetConfig) {
  return dataset.files.find((file) => file.id === dataset.primaryDataRef) ?? dataset.files[0];
}

async function loadDatasetFiles(dataset: DatasetConfig, override?: UploadedDatasetOverride) {
  const loadedFiles = new Map<string, readonly CustomObject[]>();
  await Promise.all(
    dataset.files.map(async (file) => {
      const uploadedRows = override?.loadedFiles.get(file.id);
      loadedFiles.set(file.id, uploadedRows ?? (await loadDataFile(dataset, file)));
    }),
  );
  return loadedFiles;
}

export async function createUploadedDatasetOverride(
  catalog: VisualizationCatalog,
  visualizationId: string,
  params: VisualizationParameterValues,
  file: File,
  revision: number,
): Promise<UploadedDatasetOverride> {
  const visualization = catalog.visualizations.find((candidate) => candidate.id === visualizationId);
  if (!visualization) {
    throw new Error(`Visualization "${visualizationId}" is not declared.`);
  }

  const activeDatasetId = getActiveDatasetId(visualization, params);
  const baseDataset = catalog.datasets.find((candidate) => candidate.id === activeDatasetId);
  if (!baseDataset) {
    throw new Error(`Visualization "${visualizationId}" references missing dataset "${activeDatasetId}".`);
  }

  const primaryFile = getPrimaryFile(baseDataset);
  if (!primaryFile) {
    throw new Error(`Dataset "${baseDataset.id}" does not declare a primary data file.`);
  }

  const { format, rows: parsedRows } = await parseUploadedRows(file);
  const rows = snapshotUploadedRows(parsedRows);
  const normalizedRows = rows
    .filter((row) => isUploadedRowCompatible(visualizationId, row))
    .map((row) => normalizeUploadedRow(visualizationId, row));
  if (normalizedRows.length === 0) {
    throw new UploadDataError(`No rows in ${file.name} are compatible with ${visualization.title}.`);
  }
  const validRows = snapshotUploadedRows(normalizedRows);

  const dataset = snapshotPlainData<DatasetConfig>(
    {
      ...baseDataset,
      id: `upload:${visualizationId}`,
      title: file.name,
      files: baseDataset.files.map((candidate) =>
        candidate.id === primaryFile.id ? { ...candidate, url: file.name, format } : candidate,
      ),
      normalizers: undefined,
      initialViewState: undefined,
    },
    {
      label: 'Uploaded dataset',
      maxDepth: MAX_UPLOAD_DEPTH,
      maxNodes: MAX_UPLOAD_NODES,
      createError: (message) => new UploadDataError(message),
    },
  );

  const override = Object.freeze({
    revision,
    contentDigest: digestCanonical({ schemaVersion: 1, rows: validRows }),
    dataset,
    loadedFiles: createReadonlyMapSnapshot([[primaryFile.id, validRows]]),
    sourceFileName: file.name,
    totalRowCount: rows.length,
    skippedRowCount: rows.length - validRows.length,
  });
  validateUploadedDatasetOverrideRelationships(override, visualizationId);
  validateUploadedDatasetOverrideAgainstBase(override, visualizationId, baseDataset);
  OWNED_UPLOADED_DATASET_OVERRIDES.add(override);
  return override;
}

function validateUploadedDatasetOverrideRelationships(
  override: UploadedDatasetOverride,
  visualizationId: string,
): void {
  const expectedDatasetId = `upload:${visualizationId}`;
  if (override.dataset.id !== expectedDatasetId) {
    throw new UploadDataError(`Uploaded override dataset id must be "${expectedDatasetId}".`);
  }
  if (override.dataset.files.length === 0) {
    throw new UploadDataError('Uploaded override dataset must declare at least one data file.');
  }
  const fileIds = new Set<string>();
  for (const file of override.dataset.files) {
    if (fileIds.has(file.id)) {
      throw new UploadDataError(`Uploaded override dataset contains duplicate file id "${file.id}".`);
    }
    fileIds.add(file.id);
  }
  const primaryFile = override.dataset.primaryDataRef
    ? override.dataset.files.find((file) => file.id === override.dataset.primaryDataRef)
    : override.dataset.files[0];
  if (!primaryFile) {
    throw new UploadDataError(
      `Uploaded override primaryDataRef "${String(override.dataset.primaryDataRef)}" does not name a data file.`,
    );
  }
  if (!override.loadedFiles.has(primaryFile.id)) {
    throw new UploadDataError(`Uploaded override is missing primary data "${primaryFile.id}".`);
  }
  if (override.loadedFiles.size !== 1) {
    throw new UploadDataError(`Uploaded override must contain only primary data "${primaryFile.id}".`);
  }
  const loadedFileId = override.loadedFiles.keys().next().value;
  if (loadedFileId !== primaryFile.id) {
    throw new UploadDataError(`Uploaded override must contain only primary data "${primaryFile.id}".`);
  }
}

function validateUploadedDatasetOverrideAgainstBase(
  override: UploadedDatasetOverride,
  visualizationId: string,
  baseDataset: DatasetConfig,
): void {
  validateUploadedDatasetOverrideRelationships(override, visualizationId);
  const dataset = override.dataset;
  if (dataset.revision !== baseDataset.revision) {
    throw new UploadDataError('Uploaded override must preserve the selected dataset revision.');
  }
  if (dataset.primaryDataRef !== baseDataset.primaryDataRef) {
    throw new UploadDataError('Uploaded override must preserve the selected dataset primaryDataRef.');
  }
  if (dataset.normalizers !== undefined || dataset.initialViewState !== undefined) {
    throw new UploadDataError('Uploaded override must clear normalizers and initialViewState.');
  }
  if (
    typeof dataset.title !== 'string' ||
    dataset.title.length === 0 ||
    dataset.files.length !== baseDataset.files.length
  ) {
    throw new UploadDataError('Uploaded override dataset schema must match the selected dataset.');
  }
  const primaryFile = getPrimaryFile(baseDataset);
  for (let index = 0; index < baseDataset.files.length; index += 1) {
    const baseFile = baseDataset.files[index];
    const uploadedFile = dataset.files[index];
    if (!uploadedFile || uploadedFile.id !== baseFile.id || uploadedFile.revision !== baseFile.revision) {
      throw new UploadDataError('Uploaded override dataset schema must match the selected dataset.');
    }
    if (baseFile.id === primaryFile?.id) {
      if (
        typeof uploadedFile.url !== 'string' ||
        uploadedFile.url.length === 0 ||
        (uploadedFile.format !== 'csv' && uploadedFile.format !== 'json')
      ) {
        throw new UploadDataError('Uploaded override primary file metadata is invalid.');
      }
    } else if (uploadedFile.url !== baseFile.url || uploadedFile.format !== baseFile.format) {
      throw new UploadDataError('Uploaded override must preserve non-primary file metadata.');
    }
  }
}

const UPLOADED_OVERRIDE_KEYS = [
  'revision',
  'contentDigest',
  'dataset',
  'loadedFiles',
  'sourceFileName',
  'totalRowCount',
  'skippedRowCount',
] as const;

function getUnbrandedUploadedOverrideFields(value: unknown): Record<(typeof UPLOADED_OVERRIDE_KEYS)[number], unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UploadDataError('Uploaded override must be an exact plain own-data record.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new UploadDataError('Uploaded override must be an exact plain own-data record.');
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== UPLOADED_OVERRIDE_KEYS.length ||
    ownKeys.some(
      (key) =>
        typeof key !== 'string' || !UPLOADED_OVERRIDE_KEYS.includes(key as (typeof UPLOADED_OVERRIDE_KEYS)[number]),
    )
  ) {
    throw new UploadDataError('Uploaded override must be an exact plain own-data record.');
  }

  const fields = {} as Record<(typeof UPLOADED_OVERRIDE_KEYS)[number], unknown>;
  for (const key of UPLOADED_OVERRIDE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new UploadDataError('Uploaded override must be an exact plain own-data record.');
    }
    fields[key] = descriptor.value;
  }
  return fields;
}

function snapshotUploadedDatasetOverride(
  override: UploadedDatasetOverride,
  visualizationId: string,
): UploadedDatasetOverride {
  const fields = getUnbrandedUploadedOverrideFields(override);
  const createError = (message: string) => new UploadDataError(message);
  const dataset = snapshotPlainData(fields.dataset as DatasetConfig, {
    label: 'Uploaded dataset',
    maxDepth: MAX_UPLOAD_DEPTH,
    maxNodes: MAX_UPLOAD_NODES,
    createError,
  });
  const callerLoadedFiles = fields.loadedFiles;
  if (
    callerLoadedFiles === null ||
    typeof callerLoadedFiles !== 'object' ||
    Object.getPrototypeOf(callerLoadedFiles) !== Map.prototype
  ) {
    throw new UploadDataError('Uploaded override loadedFiles must be a native Map.');
  }
  if (Reflect.ownKeys(callerLoadedFiles).length > 0) {
    throw new UploadDataError('Uploaded override loadedFiles must not contain own properties.');
  }
  let callerEntries: IterableIterator<[unknown, unknown]>;
  try {
    callerEntries = Map.prototype.entries.call(callerLoadedFiles) as IterableIterator<[unknown, unknown]>;
  } catch {
    throw new UploadDataError('Uploaded override loadedFiles must be a native Map.');
  }
  const loadedFiles: Array<readonly [string, readonly CustomObject[]]> = [];
  for (const [fileId, rows] of callerEntries) {
    if (typeof fileId !== 'string' || !Array.isArray(rows)) {
      throw new UploadDataError('Uploaded override loadedFiles must contain string keys and row arrays.');
    }
    loadedFiles.push([
      fileId,
      snapshotUploadedRows(rows, `Uploaded file "${fileId}" rows`, `Uploaded file "${fileId}" row`),
    ]);
  }
  const primaryFile = dataset.primaryDataRef
    ? dataset.files.find((file) => file.id === dataset.primaryDataRef)
    : dataset.files[0];
  if (!primaryFile) {
    if (dataset.files.length === 0) {
      throw new UploadDataError('Uploaded override dataset must declare at least one data file.');
    }
    throw new UploadDataError(
      `Uploaded override primaryDataRef "${String(dataset.primaryDataRef)}" does not name a data file.`,
    );
  }
  const primaryFileId = primaryFile.id;
  const primaryRows = loadedFiles.find(([fileId]) => fileId === primaryFileId)?.[1];
  if (!primaryRows) {
    throw new UploadDataError(`Uploaded override is missing primary data "${primaryFileId}".`);
  }

  const snapshot = Object.freeze({
    revision: fields.revision as number,
    contentDigest: digestCanonical({ schemaVersion: 1, rows: primaryRows }),
    dataset,
    loadedFiles: createReadonlyMapSnapshot(loadedFiles),
    sourceFileName: fields.sourceFileName as string,
    totalRowCount: fields.totalRowCount as number,
    skippedRowCount: fields.skippedRowCount as number,
  });
  validateUploadedDatasetOverrideRelationships(snapshot, visualizationId);
  OWNED_UPLOADED_DATASET_OVERRIDES.add(snapshot);
  return snapshot;
}

function authenticateUploadedDatasetOverride(
  override: UploadedDatasetOverride | undefined,
  visualizationId: string,
  baseDataset: DatasetConfig,
): UploadedDatasetOverride | undefined {
  if (!override) return undefined;
  const owned = OWNED_UPLOADED_DATASET_OVERRIDES.has(override)
    ? override
    : snapshotUploadedDatasetOverride(override, visualizationId);
  validateUploadedDatasetOverrideAgainstBase(owned, visualizationId, baseDataset);
  return owned;
}

export function updateUploadedDatasetOverrides(
  overrides: UploadedDatasetOverrides,
  visualizationId: string,
  override: UploadedDatasetOverride | undefined,
): UploadedDatasetOverrides {
  if (!override) {
    const nextOverrides = { ...overrides };
    delete nextOverrides[visualizationId];
    return nextOverrides;
  }

  const owned = OWNED_UPLOADED_DATASET_OVERRIDES.has(override)
    ? override
    : snapshotUploadedDatasetOverride(override, visualizationId);
  return { ...overrides, [visualizationId]: owned };
}

export function isLatestUploadedDatasetRevision(latestRevision: number, override: UploadedDatasetOverride) {
  return latestRevision === override.revision;
}

function resolveMapStyle(configMapStyle: string, context: Pick<VisualizationRuntimeContext, 'params'>) {
  const selectedMapStyle = context.params[VISUALIZATION_MAP_STYLE_PARAM_KEY];
  const mapStyleId = typeof selectedMapStyle === 'string' ? selectedMapStyle : configMapStyle;
  const mapStyle =
    getOwnRegistryValue(mapStyleRegistry, mapStyleId) ?? getOwnRegistryValue(mapStyleRegistry, configMapStyle);
  if (!mapStyle) {
    throw new Error(`Unknown map style "${String(mapStyleId)}".`);
  }
  return mapStyle;
}

export function getActiveDatasetId(visualization: VisualizationConfig, params: VisualizationParameterValues) {
  return resolveVisualizationDatasetId(visualization, params);
}

export function shouldResolveAdaptiveVisualizationDefaults(
  visualization: VisualizationConfig,
  previousParams: VisualizationParameterValues,
  nextParams: VisualizationParameterValues,
) {
  if (!visualization.datasetParam) {
    return false;
  }

  return getActiveDatasetId(visualization, previousParams) !== getActiveDatasetId(visualization, nextParams);
}

export async function resolveAdaptiveVisualizationDefaults(
  catalog: VisualizationCatalog,
  visualizationId: string,
  context: Pick<VisualizationRuntimeContext, 'params' | 'viewportSize' | 'datasetOverride'>,
): Promise<AdaptiveVisualizationDefaults | undefined> {
  const config = catalog.visualizations.find((visualization) => visualization.id === visualizationId);
  if (!config) {
    return undefined;
  }

  const activeDatasetId = getActiveDatasetId(config, context.params);
  const selectedDataset = catalog.datasets.find((candidate) => candidate.id === activeDatasetId);
  if (!selectedDataset) {
    throw new Error(`Visualization "${visualizationId}" references missing dataset "${activeDatasetId}".`);
  }
  const datasetOverride = authenticateUploadedDatasetOverride(
    context.datasetOverride,
    visualizationId,
    selectedDataset,
  );
  const dataset = datasetOverride?.dataset ?? selectedDataset;

  const loadedFiles = await loadDatasetFiles(dataset, datasetOverride);

  return resolveAdaptiveVisualizationDefaultsFromLoadedFiles(config, dataset, loadedFiles, context);
}

type CatalogRecord = Record<string, unknown>;

const SELECTION_MODES = new Set<SelectionMode>(['click', 'region', 'path', 'map-click']);
const CATALOG_COLLECTION_ITEM_BUDGET = 100_000;
const CATALOG_SHAPE_NODE_BUDGET = 1_000_000;
const CATALOG_SHAPE_DEPTH_BUDGET = 64;
function isCatalogRecord(value: unknown): value is CatalogRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function preflightCatalogPlainDataShape(value: unknown, errors: string[]): boolean {
  const stack: Array<{ value: unknown; depth: number; exiting?: boolean }> = [{ value, depth: 0 }];
  const ancestors = new Set<object>();
  const greatestVisitedDepth = new Map<object, number>();
  let nodeCount = 0;
  const reject = (detail: string) => {
    addContractError(errors, 'catalog.shape', 'Visualization catalog', detail);
    return false;
  };

  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (entry.exiting) {
      ancestors.delete(entry.value as object);
      continue;
    }
    nodeCount += 1;
    if (nodeCount > CATALOG_SHAPE_NODE_BUDGET) return reject('plain-data shape exceeds the node budget.');
    if (entry.depth > CATALOG_SHAPE_DEPTH_BUDGET) return reject('plain-data shape exceeds the depth budget.');

    const valueType = typeof entry.value;
    if (
      entry.value === null ||
      valueType === 'string' ||
      valueType === 'number' ||
      valueType === 'boolean' ||
      valueType === 'undefined'
    ) {
      continue;
    }
    if (valueType !== 'object') return reject('catalog must contain plain data only.');

    const objectValue = entry.value as object;
    if (!Array.isArray(objectValue) && !isCatalogRecord(objectValue)) {
      return reject('catalog must contain plain objects and arrays only.');
    }
    if (ancestors.has(objectValue)) return reject('catalog must not contain cycles.');
    const previousDepth = greatestVisitedDepth.get(objectValue);
    if (previousDepth !== undefined && previousDepth >= entry.depth) continue;
    greatestVisitedDepth.set(objectValue, entry.depth);
    ancestors.add(objectValue);
    stack.push({ value: objectValue, depth: entry.depth, exiting: true });

    const childValues: unknown[] = [];
    if (Array.isArray(objectValue)) {
      let indexCount = 0;
      for (const key of Reflect.ownKeys(objectValue)) {
        if (key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
        if (
          typeof key !== 'string' ||
          !Number.isInteger(Number(key)) ||
          Number(key) < 0 ||
          Number(key) >= objectValue.length ||
          String(Number(key)) !== key ||
          !descriptor ||
          !descriptor.enumerable ||
          !('value' in descriptor)
        ) {
          return reject('catalog arrays must be dense own enumerable data properties.');
        }
        indexCount += 1;
        childValues.push(descriptor.value);
      }
      if (indexCount !== objectValue.length) return reject('catalog arrays must be dense.');
    } else {
      for (const key of Reflect.ownKeys(objectValue)) {
        const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
        if (typeof key !== 'string' || !descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          return reject('catalog properties must be own enumerable string data properties.');
        }
        childValues.push(descriptor.value);
      }
    }
    for (let index = childValues.length - 1; index >= 0; index -= 1) {
      stack.push({ value: childValues[index], depth: entry.depth + 1 });
    }
  }
  return true;
}

function isNonemptyCatalogString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteCatalogNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isFiniteCatalogNumber(value) && Number.isInteger(value) && value > 0;
}

function addContractError(errors: string[], code: string, context: string, detail: string) {
  errors.push(`[${code}] ${context}: ${detail}`);
}

function validateCatalogCollectionBudget(items: unknown[], context: string, errors: string[]) {
  if (items.length <= CATALOG_COLLECTION_ITEM_BUDGET) return true;
  addContractError(
    errors,
    'catalog.budget',
    context,
    `collection length ${items.length} exceeds ${CATALOG_COLLECTION_ITEM_BUDGET}.`,
  );
  return false;
}

function validateRevision(value: unknown, context: string, errors: string[]) {
  if (!isNonemptyCatalogString(value)) {
    addContractError(errors, 'revision.required', context, 'revision must be a nonempty string.');
  }
}

function validateAnimationContract(visualization: VisualizationConfig, errors: string[]) {
  const animation = visualization.animation as unknown;
  if (animation === undefined) {
    return;
  }
  const context = `Visualization "${visualization.id}" animation`;
  if (!isCatalogRecord(animation)) {
    addContractError(errors, 'catalog.animation', context, 'animation must be an object.');
    return;
  }
  if (!isNonemptyCatalogString(animation.timeParam)) {
    addContractError(errors, 'catalog.animation', context, 'timeParam must be a nonempty string.');
  }
  if (!isFiniteCatalogNumber(animation.frameModulo) || animation.frameModulo <= 0) {
    addContractError(errors, 'catalog.animation', context, 'frameModulo must be finite and positive.');
  }
  if (animation.enabledParam !== undefined) {
    const parameter = (visualization.parameters ?? []).find((candidate) => candidate.key === animation.enabledParam);
    if (!parameter || parameter.control !== 'switch' || typeof parameter.default !== 'boolean') {
      addContractError(errors, 'catalog.animation', context, 'enabledParam must reference a boolean switch parameter.');
    }
  }
  if (animation.speedParam !== undefined) {
    const parameter = (visualization.parameters ?? []).find((candidate) => candidate.key === animation.speedParam);
    if (
      !parameter ||
      parameter.control !== 'select' ||
      !isFiniteCatalogNumber(parameter.default) ||
      parameter.default <= 0 ||
      !parameter.options?.length ||
      parameter.options.some((option) => !isFiniteCatalogNumber(option.value) || option.value <= 0) ||
      !parameter.options.some((option) => option.value === parameter.default)
    ) {
      addContractError(
        errors,
        'catalog.animation',
        context,
        'speedParam must reference a select parameter with positive finite numeric options and a matching default.',
      );
    }
  }
}

function validateUniqueIds(items: Array<{ id?: unknown }>, context: string, errors: string[]) {
  const ids = new Set<string>();
  for (const item of items) {
    if (!isNonemptyCatalogString(item.id)) {
      addContractError(errors, 'catalog.id', context, 'IDs must be nonempty strings.');
      continue;
    }
    if (ids.has(item.id)) {
      addContractError(errors, 'catalog.id', context, `duplicate ID "${item.id}".`);
    }
    ids.add(item.id);
  }
}

function validateAccessorReference(value: unknown, code: string, context: string, errors: string[]) {
  if (!isNonemptyCatalogString(value) || !getAccessorById(value)) {
    addContractError(errors, code, context, `unknown accessor "${String(value)}".`);
    return false;
  }
  return true;
}

function validateSelectionContract(layer: LayerConfig, producer: unknown, context: string, errors: string[]) {
  const selection = layer.selection as unknown;
  if (!isCatalogRecord(selection)) {
    addContractError(errors, 'selection.required', context, 'selection contract is required.');
    return;
  }

  const supported = selection.supported;
  const modes: SelectionMode[] = [];
  if (!Array.isArray(supported) || supported.length === 0) {
    addContractError(errors, 'selection.supported', context, 'supported selections must be a nonempty array.');
  } else {
    const seen = new Set<string>();
    for (const mode of supported) {
      if (typeof mode !== 'string' || !SELECTION_MODES.has(mode as SelectionMode) || seen.has(mode)) {
        addContractError(errors, 'selection.supported', context, `invalid or duplicate mode "${String(mode)}".`);
        continue;
      }
      seen.add(mode);
      modes.push(mode as SelectionMode);
    }
  }

  for (const field of ['stableIdAccessor', 'coordinateAccessor', 'pathAccessor'] as const) {
    const value = selection[field];
    if (value !== undefined) validateAccessorReference(value, 'selection.accessor', `${context}.${field}`, errors);
  }

  const envelope = isCatalogRecord(layer.cameraEnvelope) ? layer.cameraEnvelope : undefined;
  if (
    selection.coordinateAccessor !== undefined &&
    (!envelope || selection.coordinateAccessor !== envelope.positionAccessor)
  ) {
    addContractError(
      errors,
      'selection.accessor-mismatch',
      context,
      'coordinateAccessor must match the envelope positionAccessor.',
    );
  }
  if (selection.pathAccessor !== undefined && (!envelope || selection.pathAccessor !== envelope.pathAccessor)) {
    addContractError(
      errors,
      'selection.accessor-mismatch',
      context,
      'pathAccessor must match the envelope pathAccessor.',
    );
  }

  const queryId = selection.renderQueryId;
  const queryLabel = typeof queryId === 'string' ? queryId : typeof queryId;
  const query = queryId === undefined ? undefined : getRenderQueryContract(queryId);
  if (queryId !== undefined && !isKnownRenderQueryId(queryId)) {
    addContractError(errors, 'selection.query', context, `unknown render query "${queryLabel}".`);
  } else if (query) {
    if (query.producer !== producer) {
      addContractError(
        errors,
        'selection.query',
        context,
        `query "${queryLabel}" is registered for ${query.producer}, not ${String(producer)}.`,
      );
    }
    const queryModes = query.supported as readonly SelectionMode[];
    for (const mode of modes) {
      if (!queryModes.includes(mode)) {
        addContractError(errors, 'selection.query', context, `query "${queryLabel}" does not support ${mode}.`);
      }
    }
    if ('selectionAccessor' in query && 'envelopeAccessor' in query) {
      if (!envelope || selection[query.selectionAccessor] !== envelope[query.envelopeAccessor]) {
        addContractError(
          errors,
          'selection.query',
          context,
          `${query.selectionAccessor} must match the query envelope accessor ${query.envelopeAccessor}.`,
        );
      }
    }
    if ('positionAccessorId' in query && (!envelope || envelope.positionAccessor !== query.positionAccessorId)) {
      addContractError(
        errors,
        'selection.query',
        context,
        `query "${queryLabel}" requires envelope position accessor ${query.positionAccessorId}.`,
      );
    }
  }

  const hasCoordinate = isNonemptyCatalogString(selection.coordinateAccessor);
  const hasPath = isNonemptyCatalogString(selection.pathAccessor);
  const hasQuery = query !== undefined;
  for (const mode of modes) {
    const complete =
      (mode === 'click' && (hasCoordinate || hasPath || hasQuery)) ||
      (mode === 'path' && (hasPath || hasQuery)) ||
      (mode === 'map-click' && (hasCoordinate || hasQuery)) ||
      (mode === 'region' && hasQuery);
    if (!complete) {
      addContractError(errors, 'selection.binding', context, `${mode} selection lacks a usable binding.`);
    }
  }
}

function validateSupportAndCapabilities(envelope: CatalogRecord, producer: unknown, context: string, errors: string[]) {
  if (!isPositiveInteger(envelope.producerVersion)) {
    addContractError(errors, 'camera-envelope.version', context, 'producerVersion must be a positive integer.');
  }

  const support = envelope.support;
  if (!isCatalogRecord(support)) {
    addContractError(errors, 'camera-envelope.support', context, 'support contract is required.');
  } else {
    if (!isFiniteCatalogNumber(support.antialiasBufferPx) || support.antialiasBufferPx < 0) {
      addContractError(
        errors,
        'camera-envelope.support',
        context,
        'antialiasBufferPx must be finite and non-negative.',
      );
    }
    if (producer === 'heatmap-kernel') {
      if (!isFiniteCatalogNumber(support.alphaCutoff) || support.alphaCutoff <= 0 || support.alphaCutoff > 1) {
        addContractError(errors, 'camera-envelope.alpha-cutoff', context, 'Heatmap alphaCutoff must be in (0, 1].');
      }
    } else if (support.alphaCutoff !== undefined) {
      addContractError(
        errors,
        'camera-envelope.alpha-cutoff',
        context,
        'alphaCutoff is only supported by an adapter with a cutoff shader contract.',
      );
    }
  }

  const capabilities = envelope.capabilities;
  if (!isCatalogRecord(capabilities)) {
    addContractError(errors, 'camera-envelope.capability', context, 'capabilities are required.');
    return;
  }
  const supportsLive = capabilities.supportsLive;
  const supportsPrediction = capabilities.supportsPrediction;
  const horizon = capabilities.maxPredictionHorizonMs;
  const updateHz = capabilities.nominalUpdateHz;
  const frameEvolution = capabilities.frameEvolution;
  if (typeof supportsLive !== 'boolean' || typeof supportsPrediction !== 'boolean') {
    addContractError(errors, 'camera-envelope.capability', context, 'live and prediction flags must be boolean.');
  }
  if (!isFiniteCatalogNumber(horizon) || horizon < 0) {
    addContractError(
      errors,
      'camera-envelope.capability',
      context,
      'prediction horizon must be finite and non-negative.',
    );
  }
  if (!isFiniteCatalogNumber(updateHz) || updateHz <= 0) {
    addContractError(errors, 'camera-envelope.capability', context, 'nominalUpdateHz must be finite and positive.');
  }
  if (frameEvolution !== 'revision-step' && frameEvolution !== 'continuous') {
    addContractError(errors, 'camera-envelope.capability', context, 'frameEvolution is invalid.');
  }
  if (supportsPrediction === true && (supportsLive !== true || !isFiniteCatalogNumber(horizon) || horizon <= 0)) {
    addContractError(
      errors,
      'camera-envelope.capability',
      context,
      'prediction requires live support and positive horizon.',
    );
  }
  if (supportsPrediction === false && horizon !== 0) {
    addContractError(errors, 'camera-envelope.capability', context, 'non-predictive producers must use zero horizon.');
  }
  if (supportsLive === false && frameEvolution !== 'revision-step') {
    addContractError(
      errors,
      'camera-envelope.capability',
      context,
      'static producers must use revision-step evolution.',
    );
  }
}

interface NumericSchemaConstraints {
  min?: number;
  max?: number;
}

interface NumericReferenceContext {
  parameters: Map<string, VisualizationParameterConfig>;
  stateDomains: Map<string, { defaultValue: number; min: number; max: number }>;
}

function isNumberWithinConstraints(value: number, constraints: NumericSchemaConstraints) {
  return (
    (constraints.min === undefined || value >= constraints.min) &&
    (constraints.max === undefined || value <= constraints.max)
  );
}

function validateNumericParameterSchema(
  parameter: VisualizationParameterConfig,
  constraints: NumericSchemaConstraints,
  context: string,
  errors: string[],
) {
  const defaultValue = parameter.default;
  if (parameter.control === 'switch') {
    addContractError(errors, 'catalog.parameter-schema', context, 'switch controls cannot drive numeric support.');
  } else if (parameter.control === 'select') {
    const options = parameter.options;
    if (!Array.isArray(options) || options.length === 0) {
      addContractError(errors, 'catalog.parameter-schema', context, 'numeric select requires finite options.');
    } else {
      for (const option of options) {
        if (!isFiniteCatalogNumber(option.value) || !isNumberWithinConstraints(option.value, constraints)) {
          addContractError(
            errors,
            'catalog.parameter-schema',
            context,
            'every numeric select option must be finite and inside the support range.',
          );
        }
      }
      if (!options.some((option) => option.value === defaultValue)) {
        addContractError(errors, 'catalog.parameter-schema', context, 'numeric select default must match an option.');
      }
    }
  } else if (parameter.control !== 'slider' && parameter.control !== 'number') {
    addContractError(errors, 'catalog.parameter-schema', context, 'numeric support requires a numeric control.');
  } else if (!isFiniteCatalogNumber(parameter.min) || !isFiniteCatalogNumber(parameter.max)) {
    addContractError(
      errors,
      'catalog.parameter-schema',
      context,
      'numeric camera parameters require finite min and max bounds.',
    );
  }
  if (!isFiniteCatalogNumber(defaultValue) || !isNumberWithinConstraints(defaultValue, constraints)) {
    addContractError(
      errors,
      'catalog.parameter-schema',
      context,
      'default must be a finite number inside the camera support range.',
    );
  }

  const min = parameter.min;
  const max = parameter.max;
  if (min !== undefined && (!isFiniteCatalogNumber(min) || !isNumberWithinConstraints(min, constraints))) {
    addContractError(errors, 'catalog.parameter-schema', context, 'min must be finite and inside the support range.');
  }
  if (max !== undefined && (!isFiniteCatalogNumber(max) || !isNumberWithinConstraints(max, constraints))) {
    addContractError(errors, 'catalog.parameter-schema', context, 'max must be finite and inside the support range.');
  }
  if (isFiniteCatalogNumber(min) && isFiniteCatalogNumber(max) && min > max) {
    addContractError(errors, 'catalog.parameter-schema', context, 'min must not exceed max.');
  }
  if (
    isFiniteCatalogNumber(defaultValue) &&
    ((isFiniteCatalogNumber(min) && defaultValue < min) || (isFiniteCatalogNumber(max) && defaultValue > max))
  ) {
    addContractError(errors, 'catalog.parameter-schema', context, 'default must be inside the declared min/max range.');
  }
  if (parameter.step !== undefined && (!isFiniteCatalogNumber(parameter.step) || parameter.step <= 0)) {
    addContractError(errors, 'catalog.parameter-schema', context, 'step must be finite and positive.');
  }
}

function validateNumericLayerProp(
  value: unknown,
  references: NumericReferenceContext,
  context: string,
  errors: string[],
  required: boolean,
  constraints: NumericSchemaConstraints = { min: 0 },
) {
  if (value === undefined) {
    if (required) addContractError(errors, 'camera-envelope.reference', context, 'required support prop is missing.');
    return;
  }
  if (isFiniteCatalogNumber(value)) {
    if (!isNumberWithinConstraints(value, constraints)) {
      addContractError(errors, 'camera-envelope.number', context, 'support value is outside the contracted range.');
    }
    return;
  }
  const reference = parseLayerValueReference(value);
  if (reference.kind === 'param') {
    const parameter = references.parameters.get(reference.key);
    if (parameter) {
      validateNumericParameterSchema(parameter, constraints, `${context} parameter "${reference.key}"`, errors);
      return;
    }
    addContractError(errors, 'camera-envelope.reference', context, `unknown parameter "${reference.key}".`);
    return;
  }
  if (reference.kind === 'state') {
    const domain = references.stateDomains.get(reference.key);
    if (!domain) {
      addContractError(errors, 'camera-envelope.reference', context, `unknown or unbounded state "${reference.key}".`);
      return;
    }
    if (!isNumberWithinConstraints(domain.min, constraints) || !isNumberWithinConstraints(domain.max, constraints)) {
      addContractError(
        errors,
        'camera-envelope.reference',
        context,
        `state "${reference.key}" can resolve outside the contracted numeric range.`,
      );
    }
    return;
  }
  if (reference.kind === 'invalid') {
    addContractError(
      errors,
      'camera-envelope.reference-shape',
      context,
      reference.reason === 'conflict'
        ? 'param and state references are mutually exclusive.'
        : reference.reason === 'schema'
          ? 'references must be exact plain objects with one own enumerable data property.'
          : `${reference.reason} reference must be a nonempty string.`,
    );
    return;
  }
  addContractError(
    errors,
    'camera-envelope.number',
    context,
    'support prop must be a finite number or a known numeric reference.',
  );
}

function validateNumericTupleLayerProp(
  value: unknown,
  context: string,
  errors: string[],
  required: boolean,
  constraints: NumericSchemaConstraints = { min: 0 },
) {
  if (value === undefined) {
    if (required) addContractError(errors, 'camera-envelope.reference', context, 'required tuple prop is missing.');
    return;
  }
  if (!Array.isArray(value) || value.length !== 2) {
    addContractError(errors, 'camera-envelope.range', context, 'support range must be a two-number tuple.');
    return;
  }
  const [minimum, maximum] = value;
  if (!isFiniteCatalogNumber(minimum) || !isFiniteCatalogNumber(maximum)) {
    addContractError(errors, 'camera-envelope.number', context, 'support range values must be finite numbers.');
    return;
  }
  if (!isNumberWithinConstraints(minimum, constraints) || !isNumberWithinConstraints(maximum, constraints)) {
    addContractError(errors, 'camera-envelope.number', context, 'support range is outside the contracted bounds.');
  }
  if (minimum > maximum) {
    addContractError(errors, 'camera-envelope.range', context, 'support range must be ordered.');
  }
}

function validatePixelClampRange(
  props: CatalogRecord,
  minProp: string,
  maxProp: string,
  references: NumericReferenceContext,
  context: string,
  errors: string[],
) {
  const minValue = props[minProp];
  const maxValue = props[maxProp];
  const resolveDomain = (value: unknown) => {
    if (isFiniteCatalogNumber(value)) return { defaultValue: value, min: value, max: value };
    const reference = parseLayerValueReference(value);
    if (reference.kind === 'state') {
      const domain = references.stateDomains.get(reference.key);
      return domain ? { ...domain, referenceKey: `state:${reference.key}` } : undefined;
    }
    if (reference.kind !== 'param') return undefined;
    const parameter = references.parameters.get(reference.key);
    if (!parameter || !isFiniteCatalogNumber(parameter.default)) return undefined;
    let numericOptionMinimum: number | undefined;
    let numericOptionMaximum: number | undefined;
    if (parameter.control === 'select') {
      for (const option of parameter.options ?? []) {
        if (!isFiniteCatalogNumber(option.value)) continue;
        numericOptionMinimum =
          numericOptionMinimum === undefined ? option.value : Math.min(numericOptionMinimum, option.value);
        numericOptionMaximum =
          numericOptionMaximum === undefined ? option.value : Math.max(numericOptionMaximum, option.value);
      }
    }
    return {
      defaultValue: parameter.default,
      min:
        numericOptionMinimum !== undefined
          ? numericOptionMinimum
          : isFiniteCatalogNumber(parameter.min)
            ? parameter.min
            : undefined,
      max:
        numericOptionMaximum !== undefined
          ? numericOptionMaximum
          : isFiniteCatalogNumber(parameter.max)
            ? parameter.max
            : undefined,
      referenceKey: `param:${reference.key}`,
    };
  };
  const minDomain = resolveDomain(minValue);
  const maxDomain = resolveDomain(maxValue);
  if (minDomain && maxDomain && minDomain.defaultValue > maxDomain.defaultValue) {
    addContractError(errors, 'camera-envelope.range', context, `${minProp} must not exceed ${maxProp}.`);
  }
  if (
    minDomain &&
    maxDomain &&
    minDomain.referenceKey !== maxDomain.referenceKey &&
    isFiniteCatalogNumber(minDomain.max) &&
    isFiniteCatalogNumber(maxDomain.min) &&
    minDomain.max > maxDomain.min
  ) {
    addContractError(
      errors,
      'camera-envelope.range',
      context,
      `${minProp}/${maxProp} parameter domains can resolve in reverse order.`,
    );
  }
}

function validateEnvelopeReferences(
  visualization: VisualizationConfig,
  layer: LayerConfig,
  envelope: CatalogRecord,
  context: string,
  errors: string[],
) {
  const producer = envelope.producer;
  const props = (isCatalogRecord(layer.props) ? layer.props : {}) as CatalogRecord;
  const layerAccessors = (isCatalogRecord(layer.accessors) ? layer.accessors : {}) as CatalogRecord;
  const adapter = findRendererAdapterContract(layer.type, producer, layer.rendererVersion);
  const parameters = new Map((visualization.parameters ?? []).map((parameter) => [parameter.key, parameter]));
  const stateDomains = new Map<string, { defaultValue: number; min: number; max: number }>();
  const animation = visualization.animation as unknown;
  if (
    isCatalogRecord(animation) &&
    isNonemptyCatalogString(animation.timeParam) &&
    isFiniteCatalogNumber(animation.frameModulo) &&
    animation.frameModulo > 0
  ) {
    stateDomains.set(animation.timeParam, { defaultValue: 0, min: 0, max: animation.frameModulo });
  }
  const references: NumericReferenceContext = {
    parameters,
    stateDomains,
  };
  const requireAccessor = (value: unknown, label: string, rendererProp?: string) => {
    const valid = validateAccessorReference(value, 'camera-envelope.reference', `${context}.${label}`, errors);
    if (valid && rendererProp && layerAccessors[rendererProp] !== value) {
      addContractError(
        errors,
        'camera-envelope.reference',
        `${context}.${label}`,
        `must match layer accessor ${rendererProp}.`,
      );
    }
  };
  const requireOptionalAccessor = (value: unknown, label: string, rendererProp: string) => {
    const rendererValue = layerAccessors[rendererProp];
    if (value === undefined && rendererValue === undefined) {
      if (!adapter || !Object.prototype.hasOwnProperty.call(adapter.accessorDefaults, rendererProp)) {
        addContractError(
          errors,
          'camera-envelope.dependency',
          `${context}.${label}`,
          `omission requires an explicit ${rendererProp} adapter default.`,
        );
      }
      return;
    }
    if (value !== rendererValue) {
      addContractError(
        errors,
        'camera-envelope.dependency',
        `${context}.${label}`,
        `must match layer accessor ${rendererProp}.`,
      );
      return;
    }
    validateAccessorReference(value, 'camera-envelope.reference', `${context}.${label}`, errors);
  };

  switch (producer) {
    case 'hexagon-cell': {
      requireAccessor(envelope.positionAccessor, 'positionAccessor');
      if (envelope.positionAccessor !== HEXAGON_SELECTION_POSITION_ACCESSOR_ID) {
        addContractError(
          errors,
          'camera-envelope.reference',
          context,
          'Hexagon strict support requires hexagonSelectionPosition.',
        );
      }
      const radius = envelope.radius;
      if (!isCatalogRecord(radius) || radius.unit !== 'meters') {
        addContractError(errors, 'camera-envelope.unit', context, 'Hexagon radius must use meters.');
      } else if (!isNonemptyCatalogString(radius.param) || !parameters.has(radius.param)) {
        addContractError(errors, 'camera-envelope.reference', context, 'Hexagon radius parameter is unknown.');
      } else {
        const rendererRadius = props.radius;
        if (!isCatalogRecord(rendererRadius) || rendererRadius.param !== radius.param) {
          addContractError(
            errors,
            'camera-envelope.reference',
            context,
            'Hexagon renderer radius must use the envelope radius parameter.',
          );
        }
        validateNumericParameterSchema(
          parameters.get(radius.param)!,
          { min: 0 },
          `${context}.radius parameter "${radius.param}"`,
          errors,
        );
      }
      const coverage = envelope.coverage;
      if (!isCatalogRecord(coverage) || coverage.prop !== 'coverage' || props.coverage === undefined) {
        addContractError(errors, 'camera-envelope.reference', context, 'Hexagon coverage prop is incomplete.');
      } else {
        validateNumericLayerProp(props.coverage, references, `${context}.coverage`, errors, true, {
          min: 0,
          max: 1,
        });
      }
      validateNumericLayerProp(props.upperPercentile, references, `${context}.upperPercentile`, errors, true, {
        min: 0,
        max: 100,
      });
      const elevation = envelope.elevation;
      if (
        !isCatalogRecord(elevation) ||
        elevation.valueField !== 'elevationValue' ||
        elevation.rangeProp !== 'elevationRange' ||
        elevation.scaleProp !== 'elevationScale' ||
        elevation.domainProp !== 'elevationDomain'
      ) {
        addContractError(errors, 'camera-envelope.reference', context, 'Hexagon elevation contract is incomplete.');
      } else {
        const rangeValue =
          props[elevation.rangeProp] === undefined ? HEXAGON_ELEVATION_RANGE : props[elevation.rangeProp];
        const scaleValue =
          props[elevation.scaleProp] === undefined ? HEXAGON_ELEVATION_SCALE : props[elevation.scaleProp];
        validateNumericTupleLayerProp(rangeValue, `${context}.${elevation.rangeProp}`, errors, true);
        validateNumericLayerProp(scaleValue, references, `${context}.${elevation.scaleProp}`, errors, true);
        validateNumericTupleLayerProp(props[elevation.domainProp], `${context}.${elevation.domainProp}`, errors, false);
      }
      break;
    }
    case 'heatmap-kernel': {
      requireAccessor(envelope.positionAccessor, 'positionAccessor', 'getPosition');
      requireOptionalAccessor(envelope.weightAccessor, 'weightAccessor', 'getWeight');
      const radius = envelope.radius;
      if (!isCatalogRecord(radius) || radius.prop !== 'radiusPixels' || radius.unit !== 'pixels') {
        addContractError(errors, 'camera-envelope.unit', context, 'Heatmap radius must use radiusPixels in pixels.');
      }
      validateNumericLayerProp(props.radiusPixels, references, `${context}.radiusPixels`, errors, true);
      validateNumericLayerProp(props.intensity, references, `${context}.intensity`, errors, true);
      validateNumericLayerProp(props.threshold, references, `${context}.threshold`, errors, true, {
        min: 0,
        max: 1,
      });
      break;
    }
    case 'scatter-point': {
      requireAccessor(envelope.positionAccessor, 'positionAccessor', 'getPosition');
      const radius = envelope.radius;
      if (
        !isCatalogRecord(radius) ||
        radius.prop !== 'getRadius' ||
        radius.unitProp !== 'radiusUnits' ||
        radius.scaleProp !== 'radiusScale'
      ) {
        addContractError(errors, 'camera-envelope.reference', context, 'Scatter radius contract is incomplete.');
      }
      if (envelope.minPixelsProp !== 'radiusMinPixels' || envelope.maxPixelsProp !== 'radiusMaxPixels') {
        addContractError(errors, 'camera-envelope.reference', context, 'Scatter pixel clamp props are incomplete.');
      }
      if (props.radiusUnits !== 'meters' && props.radiusUnits !== 'pixels') {
        addContractError(
          errors,
          'camera-envelope.unit',
          context,
          'Scatter radiusUnits must be explicit meters or pixels.',
        );
      }
      validateNumericLayerProp(props.getRadius, references, `${context}.getRadius`, errors, true);
      validateNumericLayerProp(props.radiusScale, references, `${context}.radiusScale`, errors, true);
      validateNumericLayerProp(props.radiusMinPixels, references, `${context}.radiusMinPixels`, errors, false);
      validateNumericLayerProp(props.radiusMaxPixels, references, `${context}.radiusMaxPixels`, errors, false);
      validatePixelClampRange(props, 'radiusMinPixels', 'radiusMaxPixels', references, context, errors);
      break;
    }
    case 'line-path':
    case 'trip-path': {
      if (producer === 'line-path') {
        requireAccessor(envelope.sourcePositionAccessor, 'sourcePositionAccessor', 'getSourcePosition');
        requireAccessor(envelope.targetPositionAccessor, 'targetPositionAccessor', 'getTargetPosition');
        if (envelope.widthAccessor !== undefined || layerAccessors.getWidth !== undefined) {
          requireOptionalAccessor(envelope.widthAccessor, 'widthAccessor', 'getWidth');
        }
      } else {
        requireAccessor(envelope.pathAccessor, 'pathAccessor', 'getPath');
      }
      const width = envelope.width;
      if (
        !isCatalogRecord(width) ||
        width.prop !== 'getWidth' ||
        width.unitProp !== 'widthUnits' ||
        width.scaleProp !== 'widthScale'
      ) {
        addContractError(errors, 'camera-envelope.reference', context, 'Path width contract is incomplete.');
      }
      if (envelope.minPixelsProp !== 'widthMinPixels' || envelope.maxPixelsProp !== 'widthMaxPixels') {
        addContractError(errors, 'camera-envelope.reference', context, 'Path pixel clamp props are incomplete.');
      }
      if (props.widthUnits !== 'pixels') {
        addContractError(errors, 'camera-envelope.unit', context, 'Adapter v1 path width must use pixels.');
      }
      validateNumericLayerProp(props.getWidth, references, `${context}.getWidth`, errors, true);
      validateNumericLayerProp(props.widthScale, references, `${context}.widthScale`, errors, true);
      validateNumericLayerProp(props.widthMinPixels, references, `${context}.widthMinPixels`, errors, false);
      validateNumericLayerProp(props.widthMaxPixels, references, `${context}.widthMaxPixels`, errors, false);
      validatePixelClampRange(props, 'widthMinPixels', 'widthMaxPixels', references, context, errors);
      if (producer === 'trip-path') {
        validateNumericLayerProp(props.trailLength, references, `${context}.trailLength`, errors, true);
        validateNumericLayerProp(props.currentTime, references, `${context}.currentTime`, errors, true);
      }
      break;
    }
    case 'polygon-extrusion': {
      requireAccessor(envelope.polygonAccessor, 'polygonAccessor', 'getPolygon');
      requireOptionalAccessor(envelope.elevationAccessor, 'elevationAccessor', 'getElevation');
      if (envelope.elevationUnit !== 'meters') {
        addContractError(errors, 'camera-envelope.unit', context, 'Polygon elevation must use meters.');
      }
      if (!isFiniteCatalogNumber(envelope.baseMeters) || !isFiniteCatalogNumber(envelope.elevationScale)) {
        addContractError(errors, 'camera-envelope.number', context, 'Polygon base and scale must be finite.');
      } else if (props.elevationScale !== envelope.elevationScale) {
        addContractError(
          errors,
          'camera-envelope.reference',
          context,
          'Polygon renderer elevationScale must match the envelope scale.',
        );
      }
      if (envelope.wrapMode !== 'geometry' && envelope.wrapMode !== 'full-world') {
        addContractError(errors, 'camera-envelope.reference', context, 'Polygon wrapMode is invalid.');
      }
      break;
    }
  }
}

function validateCalibration(calibrationValue: unknown, context: string, errors: string[]) {
  if (!isCatalogRecord(calibrationValue)) {
    addContractError(errors, 'camera-calibration.required', context, 'camera calibration is required.');
    return;
  }
  const calibration = calibrationValue;
  if (!isPositiveInteger(calibration.version)) {
    addContractError(errors, 'camera-calibration.version', context, 'version must be a positive integer.');
  }
  if (!isFiniteCatalogNumber(calibration.referenceZoom)) {
    addContractError(errors, 'camera-calibration.number', context, 'referenceZoom must be finite.');
  }
  if (!isFiniteCatalogNumber(calibration.referenceSafeAreaPx) || calibration.referenceSafeAreaPx <= 0) {
    addContractError(errors, 'camera-calibration.number', context, 'referenceSafeAreaPx must be finite and positive.');
  }
  const metrics = calibration.metrics;
  if (!isCatalogRecord(metrics)) {
    addContractError(errors, 'camera-calibration.metric', context, 'metrics are required.');
    return;
  }
  for (const [metricName, expectedUnit] of Object.entries(REQUIRED_CAMERA_CALIBRATION_METRIC_UNITS)) {
    const metric = metrics[metricName];
    if (!isCatalogRecord(metric)) {
      addContractError(errors, 'camera-calibration.metric', context, `required metric ${metricName} is missing.`);
      continue;
    }
    if (metric.unit !== expectedUnit) {
      addContractError(errors, 'camera-calibration.metric', context, `${metricName} must use unit ${expectedUnit}.`);
    }
  }
  for (const [metricName, metricValue] of Object.entries(metrics)) {
    if (!isCatalogRecord(metricValue)) {
      addContractError(errors, 'camera-calibration.metric', context, `${metricName} must be a metric object.`);
      continue;
    }
    if (!isNonemptyCatalogString(metricValue.unit)) {
      addContractError(errors, 'camera-calibration.metric', context, `${metricName} unit must be nonempty.`);
    }
    if (
      !isFiniteCatalogNumber(metricValue.lo) ||
      !isFiniteCatalogNumber(metricValue.hi) ||
      metricValue.lo >= metricValue.hi
    ) {
      addContractError(errors, 'camera-calibration.range', context, `${metricName} must have finite lo < hi.`);
    }
    if (!isNonemptyCatalogString(metricValue.source)) {
      addContractError(errors, 'camera-calibration.metric', context, `${metricName} source must be nonempty.`);
    }
  }
}

function validateAnalyticsElevationTuple(
  value: unknown,
  context: string,
  errors: string[],
): [number, number] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 2) {
    addContractError(errors, 'analytics.range', context, 'value must be an exact two-number tuple.');
    return undefined;
  }
  const [minimum, maximum] = value;
  if (!isFiniteCatalogNumber(minimum) || !isFiniteCatalogNumber(maximum)) {
    addContractError(errors, 'analytics.number', context, 'tuple values must be finite numbers.');
    return undefined;
  }
  if (minimum < 0 || maximum < 0) {
    addContractError(errors, 'analytics.number', context, 'tuple values must be non-negative.');
    return undefined;
  }
  if (minimum >= maximum) {
    addContractError(errors, 'analytics.range', context, 'tuple values must be strictly increasing.');
    return undefined;
  }
  return [minimum, maximum];
}

function isFiniteNonnegativeTuple(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isFiniteCatalogNumber(value[0]) &&
    isFiniteCatalogNumber(value[1]) &&
    value[0] >= 0 &&
    value[1] >= 0
  );
}

function tuplesMatch(left: readonly [number, number], right: readonly [number, number]) {
  return left[0] === right[0] && left[1] === right[1];
}

function validateLayerAnalyticsContract(layer: LayerConfig, context: string, errors: string[]) {
  const analytics = layer.analytics as unknown;
  if (!isCatalogRecord(analytics)) return;

  const envelope = isCatalogRecord(layer.cameraEnvelope) ? layer.cameraEnvelope : undefined;
  const props = isCatalogRecord(layer.props) ? layer.props : {};
  const accessors = isCatalogRecord(layer.accessors) ? layer.accessors : {};
  const requireAnalyticsValue = (field: string, expected: unknown) => {
    if (analytics[field] !== expected) {
      addContractError(
        errors,
        'analytics.dependency',
        `${context}.analytics.${field}`,
        `must match the renderer/envelope value ${String(expected)}.`,
      );
    }
  };
  const requireGeometryAccessors = (expected: {
    positionAccessor?: unknown;
    sourcePositionAccessor?: unknown;
    targetPositionAccessor?: unknown;
    pathAccessor?: unknown;
    polygonAccessor?: unknown;
  }) => {
    for (const field of [
      'positionAccessor',
      'sourcePositionAccessor',
      'targetPositionAccessor',
      'pathAccessor',
      'polygonAccessor',
    ] as const) {
      requireAnalyticsValue(field, expected[field]);
    }
  };
  const requireSupportAnalytics = (expected: {
    elevationAccessor?: unknown;
    weightAccessor?: unknown;
    radiusParam?: unknown;
    radiusMeters?: unknown;
  }) => {
    for (const field of ['elevationAccessor', 'weightAccessor', 'radiusParam', 'radiusMeters'] as const) {
      requireAnalyticsValue(field, expected[field]);
    }
  };

  switch (envelope?.producer) {
    case 'hexagon-cell': {
      requireAnalyticsValue('kind', 'hexagon');
      requireGeometryAccessors({ positionAccessor: accessors.getPosition });
      const radius = isCatalogRecord(envelope.radius) ? envelope.radius.param : undefined;
      requireSupportAnalytics({ radiusParam: radius, weightAccessor: CONSTANT_ONE_ACCESSOR_ID });
      if (accessors.getElevationWeight !== CONSTANT_ONE_ACCESSOR_ID) {
        addContractError(
          errors,
          'analytics.dependency',
          `${context}.accessors.getElevationWeight`,
          `must use the sealed ${CONSTANT_ONE_ACCESSOR_ID} aggregation weight.`,
        );
      }
      break;
    }
    case 'heatmap-kernel': {
      requireAnalyticsValue('kind', 'heatmap');
      requireGeometryAccessors({ positionAccessor: envelope.positionAccessor });
      const radiusReference = parseLayerValueReference(props.radiusPixels);
      requireSupportAnalytics({
        weightAccessor: envelope.weightAccessor,
        radiusParam: radiusReference.kind === 'param' ? radiusReference.key : undefined,
      });
      break;
    }
    case 'scatter-point':
      requireAnalyticsValue('kind', 'point');
      requireGeometryAccessors({ positionAccessor: envelope.positionAccessor });
      requireSupportAnalytics({});
      break;
    case 'line-path':
      requireAnalyticsValue('kind', 'path');
      requireGeometryAccessors({
        sourcePositionAccessor: envelope.sourcePositionAccessor,
        targetPositionAccessor: envelope.targetPositionAccessor,
      });
      requireSupportAnalytics({ weightAccessor: CONSTANT_ONE_ACCESSOR_ID });
      break;
    case 'trip-path':
      requireAnalyticsValue('kind', 'path');
      requireGeometryAccessors({ pathAccessor: envelope.pathAccessor });
      requireSupportAnalytics({});
      break;
    case 'polygon-extrusion':
      requireAnalyticsValue('kind', 'building');
      requireGeometryAccessors({ polygonAccessor: envelope.polygonAccessor });
      requireSupportAnalytics({ elevationAccessor: envelope.elevationAccessor });
      break;
    default:
      break;
  }

  const scaleIsPresent = analytics.elevationScale !== undefined;
  const scaleIsValid = isFiniteCatalogNumber(analytics.elevationScale) && analytics.elevationScale >= 0;
  if (scaleIsPresent && !scaleIsValid) {
    addContractError(
      errors,
      'analytics.number',
      `${context}.analytics.elevationScale`,
      'elevationScale must be finite and non-negative.',
    );
  }

  const range = validateAnalyticsElevationTuple(
    analytics.elevationRange,
    `${context}.analytics.elevationRange`,
    errors,
  );
  const domain = validateAnalyticsElevationTuple(
    analytics.elevationDomain,
    `${context}.analytics.elevationDomain`,
    errors,
  );
  if (envelope?.producer === 'hexagon-cell') {
    const rendererRange = props.elevationRange ?? HEXAGON_ELEVATION_RANGE;
    const analyticsRange = range ?? (analytics.elevationRange === undefined ? HEXAGON_ELEVATION_RANGE : undefined);
    if (analyticsRange && isFiniteNonnegativeTuple(rendererRange) && !tuplesMatch(analyticsRange, rendererRange)) {
      addContractError(
        errors,
        'analytics.dependency',
        `${context}.analytics.elevationRange`,
        'analytics and renderer elevationRange values must match.',
      );
    }

    const rendererScale = props.elevationScale ?? HEXAGON_ELEVATION_SCALE;
    const analyticsScale = scaleIsPresent
      ? scaleIsValid
        ? analytics.elevationScale
        : undefined
      : HEXAGON_ELEVATION_SCALE;
    if (analyticsScale !== undefined) {
      if (!isFiniteCatalogNumber(rendererScale)) {
        addContractError(
          errors,
          'analytics.dependency',
          `${context}.analytics.elevationScale`,
          'renderer elevationScale must be a static finite number so analytics cannot diverge.',
        );
      } else if (analyticsScale !== rendererScale) {
        addContractError(
          errors,
          'analytics.dependency',
          `${context}.analytics.elevationScale`,
          'analytics and renderer elevationScale values must match.',
        );
      }
    }

    return;
  }

  if (range) {
    addContractError(
      errors,
      'analytics.dependency',
      `${context}.analytics.elevationRange`,
      'elevationRange requires hexagon renderer support.',
    );
  }
  if (domain) {
    addContractError(
      errors,
      'analytics.dependency',
      `${context}.analytics.elevationDomain`,
      'elevationDomain requires hexagon renderer support.',
    );
  }
  if (scaleIsPresent && scaleIsValid) {
    if (envelope?.producer !== 'polygon-extrusion') {
      addContractError(
        errors,
        'analytics.dependency',
        `${context}.analytics.elevationScale`,
        'elevationScale requires an elevation renderer support contract.',
      );
    } else if (analytics.elevationScale !== envelope.elevationScale) {
      addContractError(
        errors,
        'analytics.dependency',
        `${context}.analytics.elevationScale`,
        'analytics and polygon extrusion elevationScale values must match.',
      );
    }
  }
}

function validateLayerCameraContract(visualization: VisualizationConfig, layer: LayerConfig, errors: string[]) {
  const context = `Visualization "${visualization.id}" layer "${layer.id}"`;
  const shapeIssues = validateLayerCameraContractShape(layer);
  for (const issue of shapeIssues) {
    addContractError(errors, issue.code, `${context}.${issue.path}`, issue.detail);
  }
  if (shapeIssues.some((issue) => issue.unsafeToRead)) return;
  validateLayerAnalyticsContract(layer, context, errors);
  const envelopeValue = layer.cameraEnvelope as unknown;
  if (!isCatalogRecord(envelopeValue)) {
    addContractError(errors, 'camera-envelope.required', context, 'cameraEnvelope contract is required.');
    validateSelectionContract(layer, undefined, context, errors);
    validateCalibration(layer.cameraCalibration, context, errors);
    return;
  }
  const envelope = envelopeValue;
  const producer = envelope.producer;
  if (!isKnownCameraEnvelopeProducer(producer)) {
    addContractError(errors, 'camera-envelope.producer', context, `unknown producer "${String(producer)}".`);
  }

  const rendererVersion = layer.rendererVersion as unknown;
  if (!isPositiveInteger(rendererVersion)) {
    addContractError(errors, 'renderer-adapter.version', context, 'rendererVersion must be a positive integer.');
  } else if (isKnownCameraEnvelopeProducer(producer)) {
    if (!hasRendererAdapterTuple(layer.type, producer)) {
      addContractError(
        errors,
        'renderer-adapter.tuple',
        context,
        `no adapter exists for (${layer.type}, ${producer}).`,
      );
    } else if (!findRendererAdapterContract(layer.type, producer, rendererVersion)) {
      addContractError(
        errors,
        'renderer-adapter.version',
        context,
        `renderer version ${rendererVersion} is not registered for (${layer.type}, ${producer}).`,
      );
    }
  }

  const adapter = findRendererAdapterContract(layer.type, producer, rendererVersion);
  if (adapter) {
    const props = isCatalogRecord(layer.props) ? layer.props : {};
    const accessors = isCatalogRecord(layer.accessors) ? layer.accessors : {};
    for (const propName of Object.keys(props)) {
      if (!Object.prototype.hasOwnProperty.call(adapter.permittedResolvedProps, propName)) {
        addContractError(
          errors,
          'renderer-adapter.prop',
          context,
          `${propName} is not permitted by renderer adapter v${adapter.rendererVersion}.`,
        );
      }
    }
    for (const accessorPropName of Object.keys(accessors)) {
      if (!Object.prototype.hasOwnProperty.call(adapter.permittedAccessorProps, accessorPropName)) {
        addContractError(
          errors,
          'renderer-adapter.accessor',
          context,
          `${accessorPropName} is not permitted by renderer adapter v${adapter.rendererVersion}.`,
        );
      }
    }
    for (const [propName, requiredValue] of Object.entries(adapter.sealedProps)) {
      if (props[propName] !== requiredValue) {
        addContractError(
          errors,
          'renderer-adapter.sealed-prop',
          context,
          `${propName} is sealed to ${String(requiredValue)}.`,
        );
      }
    }
    for (const [propName, requiredValue] of Object.entries(adapter.sealedEnvelopeProps)) {
      if ((envelope as Record<string, unknown>)[propName] !== requiredValue) {
        addContractError(
          errors,
          'renderer-adapter.sealed-envelope',
          context,
          `${propName} is sealed to ${String(requiredValue)}.`,
        );
      }
    }
  }

  validateSelectionContract(layer, producer, context, errors);
  validateSupportAndCapabilities(envelope, producer, context, errors);
  if (isKnownCameraEnvelopeProducer(producer)) {
    validateEnvelopeReferences(visualization, layer, envelope, context, errors);
  }
  validateCalibration(layer.cameraCalibration, context, errors);
}

function validateCatalogShape(value: unknown, errors: string[]): value is VisualizationCatalog {
  if (!preflightCatalogPlainDataShape(value, errors)) {
    return false;
  }
  if (!isCatalogRecord(value)) {
    addContractError(errors, 'catalog.shape', 'Visualization catalog', 'catalog must be a plain object.');
    return false;
  }
  if (!Array.isArray(value.datasets) || !Array.isArray(value.visualizations)) {
    addContractError(errors, 'catalog.shape', 'Visualization catalog', 'datasets and visualizations must be arrays.');
    return false;
  }
  if (
    !validateCatalogCollectionBudget(value.datasets, 'Visualization catalog datasets', errors) ||
    !validateCatalogCollectionBudget(value.visualizations, 'Visualization catalog visualizations', errors)
  ) {
    return false;
  }

  let valid = true;
  for (let index = 0; index < value.datasets.length; index += 1) {
    const dataset = value.datasets[index];
    if (!isCatalogRecord(dataset) || !Array.isArray(dataset.files)) {
      addContractError(errors, 'catalog.shape', `Dataset ${index}`, 'dataset must be an object with a files array.');
      valid = false;
      continue;
    }
    if (!validateCatalogCollectionBudget(dataset.files, `Dataset ${index} files`, errors)) {
      valid = false;
      continue;
    }
    if (dataset.normalizers !== undefined && !Array.isArray(dataset.normalizers)) {
      addContractError(errors, 'catalog.shape', `Dataset ${index}`, 'normalizers must be an array when present.');
      valid = false;
    } else if (
      Array.isArray(dataset.normalizers) &&
      !validateCatalogCollectionBudget(dataset.normalizers, `Dataset ${index} normalizers`, errors)
    ) {
      valid = false;
    }
    for (let fileIndex = 0; fileIndex < dataset.files.length; fileIndex += 1) {
      if (!isCatalogRecord(dataset.files[fileIndex])) {
        addContractError(errors, 'catalog.shape', `Dataset ${index} file ${fileIndex}`, 'file must be an object.');
        valid = false;
      }
    }
  }
  for (let index = 0; index < value.visualizations.length; index += 1) {
    const visualization = value.visualizations[index];
    if (!isCatalogRecord(visualization) || !Array.isArray(visualization.layers)) {
      addContractError(
        errors,
        'catalog.shape',
        `Visualization ${index}`,
        'visualization must be an object with a layers array.',
      );
      valid = false;
      continue;
    }
    if (!validateCatalogCollectionBudget(visualization.layers, `Visualization ${index} layers`, errors)) {
      valid = false;
      continue;
    }
    if (visualization.parameters !== undefined && !Array.isArray(visualization.parameters)) {
      addContractError(errors, 'catalog.shape', `Visualization ${index}`, 'parameters must be an array when present.');
      valid = false;
    } else if (
      Array.isArray(visualization.parameters) &&
      !validateCatalogCollectionBudget(visualization.parameters, `Visualization ${index} parameters`, errors)
    ) {
      valid = false;
    } else {
      for (const parameter of visualization.parameters ?? []) {
        if (!isCatalogRecord(parameter) || (parameter.options !== undefined && !Array.isArray(parameter.options))) {
          addContractError(
            errors,
            'catalog.shape',
            `Visualization ${index}`,
            'parameters and their options must be arrays of objects.',
          );
          valid = false;
          continue;
        }
        if (
          Array.isArray(parameter.options) &&
          !validateCatalogCollectionBudget(parameter.options, `Visualization ${index} parameter options`, errors)
        ) {
          valid = false;
          continue;
        }
        for (const option of parameter.options ?? []) {
          if (!isCatalogRecord(option)) {
            addContractError(errors, 'catalog.shape', `Visualization ${index}`, 'parameter options must be objects.');
            valid = false;
          }
        }
      }
    }
    if (visualization.effects !== undefined && !Array.isArray(visualization.effects)) {
      addContractError(errors, 'catalog.shape', `Visualization ${index}`, 'effects must be an array when present.');
      valid = false;
    } else if (
      Array.isArray(visualization.effects) &&
      !validateCatalogCollectionBudget(visualization.effects, `Visualization ${index} effects`, errors)
    ) {
      valid = false;
    }
    for (let layerIndex = 0; layerIndex < visualization.layers.length; layerIndex += 1) {
      if (!isCatalogRecord(visualization.layers[layerIndex])) {
        addContractError(
          errors,
          'catalog.shape',
          `Visualization ${index} layer ${layerIndex}`,
          'layer must be an object.',
        );
        valid = false;
      }
    }
  }
  return valid;
}

export function validateVisualizationCatalog(catalog: VisualizationCatalog) {
  const errors: string[] = [];
  if (!validateCatalogShape(catalog, errors)) {
    return errors;
  }
  const datasetIds = new Set(catalog.datasets.map((dataset) => dataset.id));
  const visualizationIds = new Set(catalog.visualizations.map((visualization) => visualization.id));

  validateRevision(catalog.revision, 'Visualization catalog', errors);
  validateUniqueIds(catalog.datasets, 'Visualization catalog datasets', errors);
  validateUniqueIds(catalog.visualizations, 'Visualization catalog visualizations', errors);

  if (!visualizationIds.has(catalog.defaultVisualization)) {
    addContractError(
      errors,
      'catalog.default',
      'Visualization catalog',
      `default visualization "${String(catalog.defaultVisualization)}" is not declared.`,
    );
  }

  for (const dataset of catalog.datasets) {
    validateRevision(dataset.revision, `Dataset "${dataset.id}"`, errors);
    validateUniqueIds(dataset.files, `Dataset "${dataset.id}" files`, errors);
    if (dataset.files.length === 0) {
      addContractError(errors, 'catalog.data-ref', `Dataset "${dataset.id}"`, 'at least one data file is required.');
    }
    if (dataset.primaryDataRef !== undefined && !dataset.files.some((file) => file.id === dataset.primaryDataRef)) {
      addContractError(
        errors,
        'catalog.data-ref',
        `Dataset "${dataset.id}"`,
        `primaryDataRef "${String(dataset.primaryDataRef)}" does not name a file.`,
      );
    }
    for (const file of dataset.files) {
      validateRevision(file.revision, `Dataset "${dataset.id}" file "${file.id}"`, errors);
      if (!getOwnRegistryValue(dataLoaderRegistry, file.format)) {
        addContractError(
          errors,
          'catalog.loader',
          `Dataset "${dataset.id}" file "${file.id}"`,
          `unknown loader "${String(file.format)}".`,
        );
      }
    }
    for (const normalizerName of dataset.normalizers ?? []) {
      if (!getOwnRegistryValue(normalizerRegistry, normalizerName)) {
        addContractError(
          errors,
          'catalog.normalizer',
          `Dataset "${dataset.id}"`,
          `unknown normalizer "${String(normalizerName)}".`,
        );
      }
    }
    if (dataset.initialViewState && !getOwnRegistryValue(viewStateRegistry, dataset.initialViewState)) {
      addContractError(
        errors,
        'catalog.view-state',
        `Dataset "${dataset.id}"`,
        `unknown view state "${String(dataset.initialViewState)}".`,
      );
    }
  }

  for (const visualization of catalog.visualizations) {
    validateRevision(visualization.revision, `Visualization "${visualization.id}"`, errors);
    validateAnimationContract(visualization, errors);
    validateUniqueIds(visualization.layers, `Visualization "${visualization.id}" layers`, errors);
    validateUniqueIds(
      (visualization.parameters ?? []).map((parameter) => ({ id: parameter.key })),
      `Visualization "${visualization.id}" parameters`,
      errors,
    );
    if (!datasetIds.has(visualization.datasetId)) {
      addContractError(
        errors,
        'catalog.dataset',
        `Visualization "${visualization.id}"`,
        `references unknown dataset "${String(visualization.datasetId)}".`,
      );
    }
    if (visualization.datasetParam) {
      const datasetParameter = visualization.parameters?.find(
        (parameter) => parameter.key === visualization.datasetParam,
      );
      if (!datasetParameter) {
        addContractError(
          errors,
          'catalog.dataset-param',
          `Visualization "${visualization.id}"`,
          `references unknown dataset parameter "${visualization.datasetParam}".`,
        );
      } else {
        const datasetParameterContext = `Visualization "${visualization.id}" dataset parameter "${visualization.datasetParam}"`;
        if (datasetParameter.control !== 'select') {
          addContractError(errors, 'catalog.dataset-param', datasetParameterContext, 'must use a select control.');
        }
        if (!Array.isArray(datasetParameter.options) || datasetParameter.options.length === 0) {
          addContractError(errors, 'catalog.dataset-param', datasetParameterContext, 'must declare allowed options.');
        }
        for (const option of datasetParameter.options ?? []) {
          if (typeof option.value !== 'string' || !datasetIds.has(option.value)) {
            addContractError(
              errors,
              'catalog.dataset-param',
              datasetParameterContext,
              `references unknown dataset "${String(option.value)}".`,
            );
          }
        }
        if (typeof datasetParameter.default !== 'string' || !datasetIds.has(datasetParameter.default)) {
          addContractError(
            errors,
            'catalog.dataset-param',
            datasetParameterContext,
            `default references unknown dataset "${String(datasetParameter.default)}".`,
          );
        } else if (!datasetParameter.options?.some((option) => option.value === datasetParameter.default)) {
          addContractError(
            errors,
            'catalog.dataset-param',
            datasetParameterContext,
            'default must be one of the allowed options.',
          );
        }
      }
    }
    const reachableDatasetIds = new Set<string>([visualization.datasetId]);
    const datasetParameter = visualization.datasetParam
      ? visualization.parameters?.find((parameter) => parameter.key === visualization.datasetParam)
      : undefined;
    if (typeof datasetParameter?.default === 'string') {
      reachableDatasetIds.add(datasetParameter.default);
    }
    for (const option of datasetParameter?.options ?? []) {
      if (typeof option.value === 'string') reachableDatasetIds.add(option.value);
    }
    const reachableDatasets = catalog.datasets.filter((dataset) => reachableDatasetIds.has(dataset.id));

    if (!getOwnRegistryValue(mapStyleRegistry, visualization.mapStyle)) {
      addContractError(
        errors,
        'catalog.map-style',
        `Visualization "${visualization.id}"`,
        `unknown map style "${String(visualization.mapStyle)}".`,
      );
    }
    if (!getOwnRegistryValue(viewStateRegistry, visualization.initialViewState)) {
      addContractError(
        errors,
        'catalog.view-state',
        `Visualization "${visualization.id}"`,
        `unknown view state "${String(visualization.initialViewState)}".`,
      );
    }
    if (visualization.tooltip && !getOwnRegistryValue(tooltipRegistry, visualization.tooltip)) {
      addContractError(
        errors,
        'catalog.tooltip',
        `Visualization "${visualization.id}"`,
        `unknown tooltip "${String(visualization.tooltip)}".`,
      );
    }
    for (const effectName of visualization.effects ?? []) {
      if (!getOwnRegistryValue(effectRegistry, effectName)) {
        addContractError(
          errors,
          'catalog.effect',
          `Visualization "${visualization.id}"`,
          `unknown effect "${String(effectName)}".`,
        );
      }
    }
    for (const layer of visualization.layers) {
      const layerContext = `Visualization "${visualization.id}" layer "${layer.id}"`;
      if (!getOwnRegistryValue(layerRegistry, layer.type)) {
        addContractError(errors, 'catalog.layer', layerContext, `unknown layer "${String(layer.type)}".`);
      }
      for (const dataset of reachableDatasets) {
        if (!dataset.files.some((file) => file.id === layer.dataRef)) {
          addContractError(
            errors,
            'catalog.data-ref',
            layerContext,
            `dataRef "${String(layer.dataRef)}" is missing from reachable dataset "${dataset.id}".`,
          );
        }
      }
      for (const accessorName of Object.values(layer.accessors ?? {})) {
        if (!getAccessorById(accessorName)) {
          addContractError(
            errors,
            'catalog.accessor',
            layerContext,
            `references unknown accessor "${String(accessorName)}".`,
          );
        }
      }
      for (const [propName, propValue] of Object.entries(layer.props ?? {})) {
        const reference = parseLayerValueReference(propValue);
        if (reference.kind === 'invalid') {
          addContractError(
            errors,
            'catalog.layer-value-schema',
            layerContext,
            `prop "${propName}" must be a literal or an exact one-key param/state reference.`,
          );
        } else if (
          reference.kind === 'param' &&
          !visualization.parameters?.some((parameter) => parameter.key === reference.key)
        ) {
          addContractError(
            errors,
            'catalog.parameter',
            `Visualization "${visualization.id}" layer "${layer.id}"`,
            `prop "${propName}" references unknown parameter "${reference.key}".`,
          );
        }
      }
      for (const accessorName of [
        layer.analytics?.positionAccessor,
        layer.analytics?.sourcePositionAccessor,
        layer.analytics?.targetPositionAccessor,
        layer.analytics?.pathAccessor,
        layer.analytics?.polygonAccessor,
        layer.analytics?.elevationAccessor,
        layer.analytics?.weightAccessor,
      ]) {
        if (accessorName && !getAccessorById(accessorName)) {
          addContractError(
            errors,
            'analytics.accessor',
            layerContext,
            `references unknown analytics accessor "${String(accessorName)}".`,
          );
        }
      }
      if (
        layer.analytics?.radiusParam &&
        !visualization.parameters?.some((parameter) => parameter.key === layer.analytics?.radiusParam)
      ) {
        addContractError(
          errors,
          'analytics.parameter',
          layerContext,
          `references unknown analytics radius parameter "${String(layer.analytics.radiusParam)}".`,
        );
      }
      validateLayerCameraContract(visualization, layer, errors);
    }
  }

  return errors;
}

function resolveInitialViewStateKey(visualization: VisualizationConfig, dataset: DatasetConfig) {
  const datasetViewStateKey = dataset.initialViewState;
  if (datasetViewStateKey && getOwnRegistryValue(viewStateRegistry, datasetViewStateKey)) {
    return datasetViewStateKey;
  }
  return visualization.initialViewState;
}

export function resolveVisualizationShell(
  catalog: VisualizationCatalog,
  visualizationId: string,
  context: Pick<VisualizationRuntimeContext, 'params' | 'datasetOverride'>,
): ResolvedVisualizationShell {
  const config = catalog.visualizations.find((candidate) => candidate.id === visualizationId);
  if (!config) {
    throw new Error(`Visualization "${visualizationId}" is not declared.`);
  }

  const activeDatasetId = getActiveDatasetId(config, context.params);
  const selectedDataset = catalog.datasets.find((candidate) => candidate.id === activeDatasetId);
  if (!selectedDataset) {
    throw new Error(`Visualization "${visualizationId}" references missing dataset "${activeDatasetId}".`);
  }

  const uploadedDataset =
    context.datasetOverride?.dataset.id === `upload:${visualizationId}` ? context.datasetOverride.dataset : undefined;
  const dataset = uploadedDataset ?? selectedDataset;
  const initialViewStateKey = resolveInitialViewStateKey(config, dataset);
  const registeredView = getOwnRegistryValue(viewStateRegistry, initialViewStateKey);
  if (!registeredView) {
    throw new Error(`Unknown view state "${String(initialViewStateKey)}".`);
  }
  const initialViewState = _.cloneDeep(registeredView);

  return {
    config,
    dataset,
    primaryFile: getPrimaryFile(dataset),
    mapStyle: resolveMapStyle(config.mapStyle, context),
    initialViewState,
    cameraConstraints: getVisualizationCameraConstraints(initialViewState),
  };
}

export async function resolveVisualizationRuntime(
  catalog: VisualizationCatalog,
  visualizationId: string,
  context: VisualizationRuntimeContext,
): Promise<ResolvedVisualizationRuntime> {
  const config = catalog.visualizations.find((visualization) => visualization.id === visualizationId);
  if (!config) {
    throw new Error(`Visualization "${visualizationId}" is not declared.`);
  }

  const activeDatasetId = getActiveDatasetId(config, context.params);
  const selectedDataset = catalog.datasets.find((candidate) => candidate.id === activeDatasetId);
  if (!selectedDataset) {
    throw new Error(`Visualization "${visualizationId}" references missing dataset "${activeDatasetId}".`);
  }
  const datasetOverride = authenticateUploadedDatasetOverride(
    context.datasetOverride,
    visualizationId,
    selectedDataset,
  );
  const dataset = datasetOverride?.dataset ?? selectedDataset;
  const runtimeContext = datasetOverride === context.datasetOverride ? context : { ...context, datasetOverride };
  const descriptorParams =
    config.datasetParam && !Object.prototype.hasOwnProperty.call(context.params, config.datasetParam)
      ? { ...context.params, [config.datasetParam]: activeDatasetId }
      : context.params;

  const loadedFiles = await loadDatasetFiles(dataset, datasetOverride);
  const adaptiveDefaults = resolveAdaptiveVisualizationDefaultsFromLoadedFiles(
    config,
    dataset,
    loadedFiles,
    runtimeContext,
  );
  const manualParameterKeys = new Set(runtimeContext.manualParameterKeys ?? []);
  const effectiveParams: VisualizationParameterValues = { ...descriptorParams };
  for (const [key, value] of Object.entries(adaptiveDefaults?.parameterPatch ?? {})) {
    if (!manualParameterKeys.has(key)) effectiveParams[key] = value;
  }
  const effectiveRuntimeContext: VisualizationRuntimeContext = {
    ...runtimeContext,
    params: effectiveParams,
  };
  const analytics = buildVisualizationAnalytics(config, loadedFiles, effectiveRuntimeContext);
  const analyticsByLayerId = new Map(analytics.layers.map((layer) => [layer.id, layer]));
  const resolvedLayers = config.layers.map((layer) => {
    const dataFile = dataset.files.find((candidate) => candidate.id === layer.dataRef);
    if (!dataFile) {
      throw new Error(`Dataset "${dataset.id}" does not declare layer "${layer.id}" dataRef "${layer.dataRef}".`);
    }
    const data = loadedFiles.get(layer.dataRef);
    if (!data) throw new Error(`Layer "${layer.id}" data was not loaded.`);
    const layerAnalytics = analyticsByLayerId.get(layer.id);
    const runtimeDerivedSupport =
      layer.cameraEnvelope.producer === 'hexagon-cell' && layerAnalytics?.elevationDomain
        ? { elevationDomain: layerAnalytics.elevationDomain }
        : undefined;
    const dataRevision = datasetOverride?.loadedFiles.has(dataFile.id)
      ? datasetOverride.contentDigest
      : dataFile.revision;
    return {
      descriptor: resolveLayerDescriptor({
        catalogRevision: catalog.revision,
        visualization: config,
        dataset,
        dataFile,
        dataRevision,
        layer,
        rowCount: data.length,
        params: effectiveParams,
        state: effectiveRuntimeContext.state,
        runtimeDerivedSupport,
      }),
      data,
    } satisfies ResolvedLayerRuntime;
  });
  const createLayers = (options?: VisualizationLayerRenderOptions) => {
    const layerContext = options
      ? { ...effectiveRuntimeContext, layerRenderOptions: options }
      : effectiveRuntimeContext;
    const renderedLayers = resolvedLayers.map((runtime, index) => {
      const layerConfig = config.layers[index];
      const layerFactory = getOwnRegistryValue(layerRegistry, layerConfig.type);
      if (!layerFactory) throw new Error(`Layer "${layerConfig.id}" uses unknown renderer "${layerConfig.type}".`);
      return layerFactory(runtime, layerConfig, layerContext);
    });
    return dataset.id === 'bart-ridership'
      ? createBartPresentation(renderedLayers, resolvedLayers[0].data, layerContext.layerRenderOptions)
      : renderedLayers;
  };
  const layers = createLayers();

  const primaryFile = getPrimaryFile(dataset);
  const initialViewStateKey = resolveInitialViewStateKey(config, dataset);
  const registeredInitialViewState = getOwnRegistryValue(viewStateRegistry, initialViewStateKey);
  if (!adaptiveDefaults?.initialViewState && !registeredInitialViewState) {
    throw new Error(`Unknown view state "${String(initialViewStateKey)}".`);
  }
  const baseInitialViewState = adaptiveDefaults?.initialViewState ?? _.cloneDeep(registeredInitialViewState!);
  const initialViewState =
    dataset.id === 'bart-ridership'
      ? fitBartInitialView(
          resolvedLayers[0].data,
          baseInitialViewState,
          context.viewportSize ?? getDefaultViewportSize(),
        )
      : baseInitialViewState;

  return {
    config,
    dataset,
    primaryFile,
    primaryData: (primaryFile ? (loadedFiles.get(primaryFile.id) ?? EMPTY_DATA) : EMPTY_DATA) as CustomObject[],
    layers,
    resolvedLayers,
    createLayers,
    mapStyle: resolveMapStyle(config.mapStyle, effectiveRuntimeContext),
    initialViewState,
    cameraConstraints: getVisualizationCameraConstraints(initialViewState),
    effects: (config.effects ?? []).flatMap((effectName) => getOwnRegistryValue(effectRegistry, effectName) ?? []),
    getTooltip: config.tooltip ? getOwnRegistryValue(tooltipRegistry, config.tooltip) : undefined,
    pickingRadius: config.pickingRadius ?? 0,
    animation: config.animation,
    analytics,
    effectiveParams,
    adaptiveDefaults,
  };
}

export { getFileName };
