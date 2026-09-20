import type { CustomObject } from '../interfaces';
import { createSnapshotEnvelope } from '../camera/geometry/envelope';
import { MERCATOR_LATITUDE_LIMIT, unwrapLongitude } from '../camera/geometry/geo-wrap';
import type {
  EnvelopeResult,
  LngLat,
  SnapshotEnvelope,
  SupportGuarantee,
  VisualPrimitive,
  WorldPosition,
} from '../camera/geometry/types';
import { computeContentMetrics } from '../camera/metrics/content-metrics';
import {
  validateResolvedSelectionSnapshot,
  type ResolvedSelectionMark,
  type ResolvedSelectionSnapshot,
} from '../camera/selection-query';
import type { GeoJsonGeometry } from '../camera/selection-state';
import {
  buildProducerMetricContext,
  deriveCameraCalibrationDigest,
  enforceEnvelopeProductionBudget,
  validateProducerMetricContext,
  validateSceneMetricContextProducerIdentity,
  type ProducerMetricContext,
  type ProducerSupportGroupInput,
  type SceneMetricContext,
} from './envelope-producer-contract';
import { getAccessorById } from './registry';
import { isCertifiedResolvedLayerDescriptor } from './resolved-layer';
import type {
  CameraEnvelopeConfig,
  ResolvedLayerDescriptor,
  ResolvedLayerRuntime,
  ResolvedLayerSupport,
} from './types';

export interface EnvelopeProducerInput {
  runtime: ResolvedLayerRuntime;
  selection: ResolvedSelectionSnapshot;
  sceneMetricContext: SceneMetricContext;
  productionPolicyId: 'strict-envelope-v1';
}

export type EnvelopeProducer = (input: EnvelopeProducerInput) => EnvelopeResult<SnapshotEnvelope>;

interface CertifiedProducerInput extends EnvelopeProducerInput {
  runtime: ResolvedLayerRuntime & { descriptor: ResolvedLayerDescriptor };
}

interface NormalizedProduction {
  primitives: VisualPrimitive[];
  supportGroups: ProducerSupportGroupInput[];
  glyphPrimitiveIndexes: number[];
  footprintPrimitiveIndexes: number[];
  requiresFullWorld: boolean;
}

interface ProductionEstimate {
  sourceItems: number;
  primitives: number;
  vertices: number;
}

type NonOkStatus = Exclude<EnvelopeResult<never>['status'], 'ok'>;

function nonOk<T>(status: NonOkStatus, reason: string): EnvelopeResult<T> {
  return { status, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw new TypeError(`envelope producer input.${key} must be an enumerable own data property`);
  }
  return descriptor.value;
}

function preflightInput(input: EnvelopeProducerInput): EnvelopeResult<CertifiedProducerInput> {
  try {
    if (!isRecord(input)) throw new TypeError('envelope producer input must be a plain object');
    const keys = Reflect.ownKeys(input);
    const expected = ['runtime', 'selection', 'sceneMetricContext', 'productionPolicyId'];
    if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) {
      throw new TypeError('envelope producer input must use the exact schema');
    }
    const runtimeValue = ownData(input, 'runtime');
    const selection = ownData(input, 'selection');
    const sceneMetricContext = ownData(input, 'sceneMetricContext');
    const productionPolicyId = ownData(input, 'productionPolicyId');
    if (!isRecord(runtimeValue)) throw new TypeError('envelope producer runtime must be a plain object');
    const runtimeKeys = Reflect.ownKeys(runtimeValue);
    if (
      runtimeKeys.length !== 2 ||
      runtimeKeys.some((key) => typeof key !== 'string' || (key !== 'descriptor' && key !== 'data'))
    ) {
      throw new TypeError('envelope producer runtime must use the exact schema');
    }
    const descriptor = ownData(runtimeValue, 'descriptor');
    const runtimeData = ownData(runtimeValue, 'data');
    if (!isCertifiedResolvedLayerDescriptor(descriptor)) {
      throw new TypeError('resolved layer descriptor is not a certified resolver-built descriptor');
    }
    const selectionValidation = validateResolvedSelectionSnapshot(selection as ResolvedSelectionSnapshot);
    if (selectionValidation.status !== 'ok') throw new TypeError(selectionValidation.reason);
    if (productionPolicyId !== 'strict-envelope-v1') {
      return nonOk('unsupported', `unsupported envelope production policy: ${String(productionPolicyId)}`);
    }
    const calibrationDigest = deriveCameraCalibrationDigest(descriptor.cameraCalibration);
    const sceneValidation = validateSceneMetricContextProducerIdentity(sceneMetricContext as SceneMetricContext, {
      sceneRevision: selectionValidation.value.sceneRevision,
      cameraCalibrationDigest: calibrationDigest,
    });
    if (sceneValidation.status !== 'ok') return sceneValidation;
    const certified: CertifiedProducerInput = {
      runtime: { descriptor, data: runtimeData as readonly CustomObject[] },
      selection: selectionValidation.value,
      sceneMetricContext: sceneValidation.value,
      productionPolicyId,
    };
    return { status: 'ok', value: certified };
  } catch (error) {
    return nonOk('error', error instanceof Error ? error.message : String(error));
  }
}

function validateProvenance(input: CertifiedProducerInput): EnvelopeResult<true> {
  const { descriptor } = input.runtime;
  const { selection } = input;
  const comparisons: Array<[string, unknown, unknown]> = [
    ['sceneRevision', selection.sceneRevision, input.sceneMetricContext.sceneRevision],
    ['resolvedLayerDigest', selection.resolvedLayerDigest, descriptor.resolvedLayerDigest],
    ['datasetId', selection.provenance.datasetId, descriptor.datasetId],
    ['visualizationId', selection.provenance.visualizationId, descriptor.visualizationId],
    ['layerId', selection.provenance.layerId, descriptor.layerId],
    ['dataRevision', selection.provenance.dataRevision, descriptor.dataRevision],
    ['visualizationRevision', selection.provenance.visualizationRevision, descriptor.visualizationRevision],
    ['producerId', selection.provenance.producerId, descriptor.cameraEnvelope.producer],
    ['producerVersion', selection.provenance.producerVersion, descriptor.cameraEnvelope.producerVersion],
  ];
  for (const [field, actual, expected] of comparisons) {
    if (actual !== expected) return nonOk('stale', `selection ${field} does not match the resolved producer input`);
  }
  return { status: 'ok', value: true };
}

function accessorValue(object: Readonly<CustomObject>, accessorId: string, label: string): EnvelopeResult<unknown> {
  const accessor = getAccessorById(accessorId);
  if (!accessor) return nonOk('unsupported', `${label} accessor ${accessorId} is not registered`);
  try {
    return { status: 'ok', value: accessor(object) };
  } catch (error) {
    return nonOk('error', `${label} accessor failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function worldPosition(value: unknown, label: string): EnvelopeResult<WorldPosition> {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) {
    return nonOk('unsupported', `${label} must be a renderer [longitude, latitude, height?] position`);
  }
  if (value.some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate))) {
    return nonOk('unsupported', `${label} contains a non-finite coordinate`);
  }
  if (Math.abs(value[1]) > MERCATOR_LATITUDE_LIMIT) {
    return nonOk('unsupported', `${label} exceeds the Mercator latitude limit`);
  }
  return {
    status: 'ok',
    value: value.length === 3 ? [value[0], value[1], value[2]] : [value[0], value[1]],
  };
}

function pathPositions(value: unknown, label: string, minimumDistinct: number): EnvelopeResult<WorldPosition[]> {
  if (!Array.isArray(value) || value.length === 0) return nonOk('unsupported', `${label} must be a nonempty path`);
  const positions: WorldPosition[] = [];
  const distinct = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const position = worldPosition(value[index], `${label}[${index}]`);
    if (position.status !== 'ok') return position;
    positions.push(position.value);
    distinct.add(position.value.join(':'));
  }
  if (distinct.size < minimumDistinct) {
    return nonOk('unsupported', `${label} requires at least ${minimumDistinct} distinct renderer vertices`);
  }
  return { status: 'ok', value: positions };
}

function polygonRings(value: unknown, label: string): EnvelopeResult<LngLat[][]> {
  if (!Array.isArray(value) || value.length === 0) return nonOk('unsupported', `${label} must be a nonempty polygon`);
  const rawRings = Array.isArray(value[0]) && typeof value[0][0] === 'number' ? [value] : value;
  const rings: LngLat[][] = [];
  for (let ringIndex = 0; ringIndex < rawRings.length; ringIndex += 1) {
    const path = pathPositions(rawRings[ringIndex], `${label}[${ringIndex}]`, 3);
    if (path.status !== 'ok') return path;
    rings.push(path.value.map(([longitude, latitude]): LngLat => [longitude, latitude]));
  }
  return { status: 'ok', value: rings };
}

function addSafe(total: number, amount: number, label: string): EnvelopeResult<number> {
  const next = total + amount;
  return Number.isSafeInteger(next)
    ? { status: 'ok', value: next }
    : nonOk('unavailable', `${label} estimate overflow`);
}

function geometryShapeEstimate(geometry: GeoJsonGeometry): EnvelopeResult<{ primitives: number; vertices: number }> {
  const coordinates = geometry.coordinates;
  switch (geometry.type) {
    case 'Point':
      return { status: 'ok', value: { primitives: 1, vertices: 1 } };
    case 'MultiPoint':
      return Array.isArray(coordinates)
        ? { status: 'ok', value: { primitives: coordinates.length, vertices: coordinates.length } }
        : nonOk('unsupported', 'drawn MultiPoint coordinates are invalid');
    case 'LineString':
      return Array.isArray(coordinates)
        ? { status: 'ok', value: { primitives: 1, vertices: coordinates.length } }
        : nonOk('unsupported', 'drawn LineString coordinates are invalid');
    case 'MultiLineString':
      if (!Array.isArray(coordinates)) return nonOk('unsupported', 'drawn MultiLineString coordinates are invalid');
      return {
        status: 'ok',
        value: {
          primitives: coordinates.length,
          vertices: coordinates.reduce((sum, line) => sum + (Array.isArray(line) ? line.length : 0), 0),
        },
      };
    case 'Polygon':
      if (!Array.isArray(coordinates)) return nonOk('unsupported', 'drawn Polygon coordinates are invalid');
      return {
        status: 'ok',
        value: {
          primitives: 1,
          vertices: coordinates.reduce((sum, ring) => sum + (Array.isArray(ring) ? ring.length : 0), 0),
        },
      };
    case 'MultiPolygon':
      if (!Array.isArray(coordinates)) return nonOk('unsupported', 'drawn MultiPolygon coordinates are invalid');
      return {
        status: 'ok',
        value: {
          primitives: coordinates.length,
          vertices: coordinates.reduce(
            (sum, polygon) =>
              sum +
              (Array.isArray(polygon)
                ? polygon.reduce((ringSum, ring) => ringSum + (Array.isArray(ring) ? ring.length : 0), 0)
                : 0),
            0,
          ),
        },
      };
  }
}

function estimateMark(
  mark: ResolvedSelectionMark,
  support: ResolvedLayerSupport,
  markIndex: number,
): EnvelopeResult<{ primitives: number; vertices: number }> {
  if (support.producer === 'hexagon-cell') {
    return mark.kind === 'hexagon-cell'
      ? { status: 'ok', value: { primitives: 1, vertices: mark.footprintRing.length } }
      : nonOk('unsupported', `hexagon mark ${markIndex} must be a renderer-captured cell`);
  }
  if (mark.kind !== 'source-object') {
    return nonOk('unsupported', `${support.producer} mark ${markIndex} must be a source object`);
  }
  if (support.producer === 'scatter-point' || support.producer === 'heatmap-kernel') {
    return { status: 'ok', value: { primitives: 1, vertices: 1 } };
  }
  if (support.producer === 'line-path') return { status: 'ok', value: { primitives: 1, vertices: 2 } };
  if (support.producer === 'trip-path') {
    const value = accessorValue(mark.object, support.pathAccessorId, `trip mark ${markIndex}`);
    if (value.status !== 'ok') return value;
    const path = pathPositions(value.value, `trip mark ${markIndex} path`, 2);
    return path.status === 'ok' ? { status: 'ok', value: { primitives: 1, vertices: path.value.length } } : path;
  }
  const value = accessorValue(mark.object, support.polygonAccessorId, `polygon mark ${markIndex}`);
  if (value.status !== 'ok') return value;
  const rings = polygonRings(value.value, `polygon mark ${markIndex}`);
  return rings.status === 'ok'
    ? {
        status: 'ok',
        value: { primitives: 1, vertices: rings.value.reduce((sum, ring) => sum + ring.length, 0) },
      }
    : rings;
}

function estimateProduction(input: CertifiedProducerInput): EnvelopeResult<ProductionEstimate> {
  let primitives = 0;
  let vertices = 0;
  for (let markIndex = 0; markIndex < input.selection.marks.length; markIndex += 1) {
    const estimate = estimateMark(
      input.selection.marks[markIndex],
      input.runtime.descriptor.resolvedSupport,
      markIndex,
    );
    if (estimate.status !== 'ok') return estimate;
    const nextPrimitives = addSafe(primitives, estimate.value.primitives, 'primitive');
    if (nextPrimitives.status !== 'ok') return nextPrimitives;
    const nextVertices = addSafe(vertices, estimate.value.vertices, 'vertex');
    if (nextVertices.status !== 'ok') return nextVertices;
    primitives = nextPrimitives.value;
    vertices = nextVertices.value;
  }
  if (input.selection.geometry !== undefined) {
    const geometryEstimate = geometryShapeEstimate(input.selection.geometry.geometry);
    if (geometryEstimate.status !== 'ok') return geometryEstimate;
    const nextPrimitives = addSafe(primitives, geometryEstimate.value.primitives, 'primitive');
    if (nextPrimitives.status !== 'ok') return nextPrimitives;
    const nextVertices = addSafe(vertices, geometryEstimate.value.vertices, 'vertex');
    if (nextVertices.status !== 'ok') return nextVertices;
    primitives = nextPrimitives.value;
    vertices = nextVertices.value;
  }
  return {
    status: 'ok',
    value: {
      sourceItems: input.selection.marks.length + (input.selection.geometry === undefined ? 0 : 1),
      primitives,
      vertices,
    },
  };
}

function normalizeHexagonMark(
  mark: ResolvedSelectionMark,
  support: Extract<ResolvedLayerSupport, { producer: 'hexagon-cell' }>,
): EnvelopeResult<VisualPrimitive> {
  if (mark.kind !== 'hexagon-cell') return nonOk('unsupported', 'hexagon producer requires hexagon-cell marks');
  const [domainMinimum, domainMaximum] = support.elevationDomain;
  const ratio =
    domainMinimum === domainMaximum
      ? 0
      : Math.min(1, Math.max(0, (mark.elevationValue - domainMinimum) / (domainMaximum - domainMinimum)));
  const height =
    (support.elevationRange[0] + (support.elevationRange[1] - support.elevationRange[0]) * ratio) *
    support.elevationScale;
  if (!Number.isFinite(height)) return nonOk('unsupported', 'hexagon renderer elevation is non-finite');
  return {
    status: 'ok',
    value: {
      kind: 'extruded-footprint',
      rings: [mark.footprintRing.map(([longitude, latitude]): LngLat => [longitude, latitude])],
      baseMeters: 0,
      topMeters: height,
      supportBufferPx: support.antialiasBufferPx,
    },
  };
}

function normalizeSourceMark(
  mark: ResolvedSelectionMark,
  support: Exclude<ResolvedLayerSupport, { producer: 'hexagon-cell' }>,
  markIndex: number,
): EnvelopeResult<VisualPrimitive> {
  if (mark.kind !== 'source-object') return nonOk('unsupported', `${support.producer} requires source-object marks`);
  if (support.producer === 'scatter-point' || support.producer === 'heatmap-kernel') {
    const positionId = support.positionAccessorId;
    const value = accessorValue(mark.object, positionId, `${support.producer} mark ${markIndex}`);
    if (value.status !== 'ok') return value;
    const position = worldPosition(value.value, `${support.producer} mark ${markIndex} position`);
    if (position.status !== 'ok') return position;
    if (support.producer === 'heatmap-kernel') {
      return {
        status: 'ok',
        value: {
          kind: 'point-disc',
          position: position.value,
          radius: { value: support.radiusPixels, unit: 'pixels' },
          pixelClamp: { supportBufferPx: support.antialiasBufferPx },
        },
      };
    }
    const radius = support.radius.value * support.radiusScale;
    if (!Number.isFinite(radius) || radius < 0) return nonOk('unsupported', 'scatter radius is invalid');
    return {
      status: 'ok',
      value: {
        kind: 'point-disc',
        position: position.value,
        radius: { value: radius, unit: support.radius.unit },
        pixelClamp: {
          ...(support.radiusMinPixels === undefined ? {} : { minPx: support.radiusMinPixels }),
          ...(support.radiusMaxPixels === undefined ? {} : { maxPx: support.radiusMaxPixels }),
          supportBufferPx: support.antialiasBufferPx,
        },
      },
    };
  }
  if (support.producer === 'line-path') {
    const sourceValue = accessorValue(mark.object, support.sourcePositionAccessorId, `line mark ${markIndex} source`);
    if (sourceValue.status !== 'ok') return sourceValue;
    const targetValue = accessorValue(mark.object, support.targetPositionAccessorId, `line mark ${markIndex} target`);
    if (targetValue.status !== 'ok') return targetValue;
    const source = worldPosition(sourceValue.value, `line mark ${markIndex} source`);
    if (source.status !== 'ok') return source;
    const target = worldPosition(targetValue.value, `line mark ${markIndex} target`);
    if (target.status !== 'ok') return target;
    const width =
      support.widthAccessorId === undefined
        ? { status: 'ok' as const, value: support.width.value }
        : accessorValue(mark.object, support.widthAccessorId, `line mark ${markIndex} width`);
    if (width.status !== 'ok') return width;
    if (typeof width.value !== 'number') return nonOk('unsupported', 'line width is not numeric');
    const halfWidth = (width.value * support.widthScale) / 2;
    if (!Number.isFinite(halfWidth) || halfWidth < 0) return nonOk('unsupported', 'line half-width is invalid');
    return {
      status: 'ok',
      value: {
        kind: 'path-corridor',
        positions: [source.value, target.value],
        halfWidth: { value: halfWidth, unit: support.width.unit },
        pixelClamp: {
          ...(support.widthMinPixels === undefined ? {} : { minPx: support.widthMinPixels / 2 }),
          ...(support.widthMaxPixels === undefined ? {} : { maxPx: support.widthMaxPixels / 2 }),
          supportBufferPx: support.antialiasBufferPx,
        },
      },
    };
  }
  if (support.producer === 'trip-path') {
    const value = accessorValue(mark.object, support.pathAccessorId, `trip mark ${markIndex}`);
    if (value.status !== 'ok') return value;
    const positions = pathPositions(value.value, `trip mark ${markIndex} path`, 2);
    if (positions.status !== 'ok') return positions;
    const halfWidth = (support.width.value * support.widthScale) / 2;
    if (!Number.isFinite(halfWidth) || halfWidth < 0) return nonOk('unsupported', 'trip half-width is invalid');
    return {
      status: 'ok',
      value: {
        kind: 'path-corridor',
        positions: positions.value,
        halfWidth: { value: halfWidth, unit: support.width.unit },
        pixelClamp: {
          ...(support.widthMinPixels === undefined ? {} : { minPx: support.widthMinPixels / 2 }),
          ...(support.widthMaxPixels === undefined ? {} : { maxPx: support.widthMaxPixels / 2 }),
          supportBufferPx: support.antialiasBufferPx,
        },
      },
    };
  }
  const polygonValue = accessorValue(mark.object, support.polygonAccessorId, `polygon mark ${markIndex}`);
  if (polygonValue.status !== 'ok') return polygonValue;
  const rings = polygonRings(polygonValue.value, `polygon mark ${markIndex}`);
  if (rings.status !== 'ok') return rings;
  let elevation = support.elevationDefaultMeters ?? 1000;
  if (support.elevationAccessorId !== undefined) {
    const elevationValue = accessorValue(
      mark.object,
      support.elevationAccessorId,
      `polygon mark ${markIndex} elevation`,
    );
    if (elevationValue.status !== 'ok') return elevationValue;
    if (elevationValue.value !== undefined && elevationValue.value !== null) {
      if (typeof elevationValue.value !== 'number' || !Number.isFinite(elevationValue.value)) {
        return nonOk('unsupported', `polygon mark ${markIndex} elevation must be finite`);
      }
      elevation = elevationValue.value;
    }
  }
  const topMeters = support.baseMeters + elevation * support.elevationScale;
  if (!Number.isFinite(topMeters)) return nonOk('unsupported', 'polygon renderer height is non-finite');
  return {
    status: 'ok',
    value: {
      kind: 'extruded-footprint',
      rings: rings.value,
      baseMeters: support.baseMeters,
      topMeters,
      supportBufferPx: support.antialiasBufferPx,
    },
  };
}

function normalizeGeometry(geometry: GeoJsonGeometry): EnvelopeResult<VisualPrimitive[]> {
  const coordinates = geometry.coordinates;
  const primitives: VisualPrimitive[] = [];
  const addPoint = (value: unknown, label: string): EnvelopeResult<true> => {
    const position = worldPosition(value, label);
    if (position.status !== 'ok') return position;
    primitives.push({ kind: 'point-disc', position: position.value, radius: { value: 0, unit: 'pixels' } });
    return { status: 'ok', value: true };
  };
  const addLine = (value: unknown, label: string): EnvelopeResult<true> => {
    const positions = pathPositions(value, label, 2);
    if (positions.status !== 'ok') return positions;
    primitives.push({ kind: 'path-corridor', positions: positions.value, halfWidth: { value: 0, unit: 'pixels' } });
    return { status: 'ok', value: true };
  };
  const addPolygon = (value: unknown, label: string): EnvelopeResult<true> => {
    const rings = polygonRings(value, label);
    if (rings.status !== 'ok') return rings;
    primitives.push({
      kind: 'polygon',
      rings: rings.value.map((ring) => ring.map(([longitude, latitude]): WorldPosition => [longitude, latitude])),
    });
    return { status: 'ok', value: true };
  };
  if (geometry.type === 'Point') {
    const result = addPoint(coordinates, 'drawn Point');
    return result.status === 'ok' ? { status: 'ok', value: primitives } : result;
  }
  if (!Array.isArray(coordinates)) return nonOk('unsupported', `drawn ${geometry.type} coordinates are invalid`);
  if (geometry.type === 'MultiPoint') {
    for (let index = 0; index < coordinates.length; index += 1) {
      const result = addPoint(coordinates[index], `drawn MultiPoint[${index}]`);
      if (result.status !== 'ok') return result;
    }
  } else if (geometry.type === 'LineString') {
    const result = addLine(coordinates, 'drawn LineString');
    if (result.status !== 'ok') return result;
  } else if (geometry.type === 'MultiLineString') {
    for (let index = 0; index < coordinates.length; index += 1) {
      const result = addLine(coordinates[index], `drawn MultiLineString[${index}]`);
      if (result.status !== 'ok') return result;
    }
  } else if (geometry.type === 'Polygon') {
    const result = addPolygon(coordinates, 'drawn Polygon');
    if (result.status !== 'ok') return result;
  } else {
    for (let index = 0; index < coordinates.length; index += 1) {
      const result = addPolygon(coordinates[index], `drawn MultiPolygon[${index}]`);
      if (result.status !== 'ok') return result;
    }
  }
  return { status: 'ok', value: primitives };
}

function normalizeProduction(input: CertifiedProducerInput): EnvelopeResult<NormalizedProduction> {
  const support = input.runtime.descriptor.resolvedSupport;
  const primitives: VisualPrimitive[] = [];
  const supportGroups: ProducerSupportGroupInput[] = [];
  for (let markIndex = 0; markIndex < input.selection.marks.length; markIndex += 1) {
    const primitive =
      support.producer === 'hexagon-cell'
        ? normalizeHexagonMark(input.selection.marks[markIndex], support)
        : normalizeSourceMark(input.selection.marks[markIndex], support, markIndex);
    if (primitive.status !== 'ok') return primitive;
    const primitiveIndex = primitives.length;
    primitives.push(primitive.value);
    supportGroups.push({ sourceId: `mark:${markIndex}`, primitiveIndexes: [primitiveIndex] });
  }
  if (input.selection.geometry !== undefined) {
    const geometryPrimitives = normalizeGeometry(input.selection.geometry.geometry);
    if (geometryPrimitives.status !== 'ok') return geometryPrimitives;
    const indexes: number[] = [];
    for (const primitive of geometryPrimitives.value) {
      indexes.push(primitives.length);
      primitives.push(primitive);
    }
    if (indexes.length > 0) supportGroups.push({ sourceId: 'drawn-geometry:0', primitiveIndexes: indexes });
  }
  if (primitives.length === 0) return nonOk('unavailable', 'selection has no visual support primitives');
  return {
    status: 'ok',
    value: {
      primitives,
      supportGroups,
      glyphPrimitiveIndexes: primitives.flatMap((primitive, index) =>
        primitive.kind === 'point-disc' || primitive.kind === 'screen-rect' ? [index] : [],
      ),
      footprintPrimitiveIndexes: primitives.map((_, index) => index),
      requiresFullWorld:
        input.selection.geometry?.wrapMode === 'full-world' ||
        (support.producer === 'polygon-extrusion' && support.wrapMode === 'full-world'),
    },
  };
}

function meanPositions(positions: readonly WorldPosition[]): [number, number, number] {
  const reference = positions[0][0];
  let longitude = 0;
  let latitude = 0;
  let height = 0;
  for (const position of positions) {
    longitude += unwrapLongitude(position[0], reference);
    latitude += position[1];
    height += position[2] ?? 0;
  }
  return [longitude / positions.length, latitude / positions.length, height / positions.length];
}

function primitiveCenter(primitive: VisualPrimitive): [number, number, number] {
  if (primitive.kind === 'point-disc' || primitive.kind === 'screen-rect') {
    return [primitive.position[0], primitive.position[1], primitive.position[2] ?? 0];
  }
  if (primitive.kind === 'path-corridor') return meanPositions(primitive.positions);
  if (primitive.kind === 'polygon') return meanPositions(primitive.rings.flat());
  if (primitive.kind === 'mesh-support') return meanPositions(primitive.vertices);
  const basePositions = primitive.rings
    .flat()
    .map(([longitude, latitude]): WorldPosition => [longitude, latitude, primitive.baseMeters]);
  const center = meanPositions(basePositions);
  const topValues = Array.isArray(primitive.topMeters)
    ? primitive.topMeters
    : basePositions.map(() => primitive.topMeters as number);
  const topMean = topValues.reduce((sum, value) => sum + value, 0) / topValues.length;
  center[2] = primitive.baseMeters + (topMean - primitive.baseMeters) * 0.5;
  return center;
}

function anchorFromContext(
  primitives: readonly VisualPrimitive[],
  context: ProducerMetricContext,
): EnvelopeResult<[number, number, number]> {
  const groupCenters = context.supportGroups.map((group) =>
    meanPositions(group.primitiveIndexes.map((primitiveIndex) => primitiveCenter(primitives[primitiveIndex]))),
  );
  let maximumWeight = 0;
  for (const group of context.supportGroups) maximumWeight = Math.max(maximumWeight, group.anchorWeight);
  if (maximumWeight <= 0 || !Number.isFinite(maximumWeight)) {
    return nonOk('error', 'producer metric context contains no positive finite anchor weight');
  }
  const firstPositive = context.supportGroups.findIndex((group) => group.anchorWeight > 0);
  const longitudeReference = groupCenters[firstPositive][0];
  let weightSum = 0;
  let longitude = 0;
  let latitude = 0;
  let height = 0;
  for (let index = 0; index < context.supportGroups.length; index += 1) {
    const normalizedWeight = context.supportGroups[index].anchorWeight / maximumWeight;
    if (normalizedWeight === 0) continue;
    weightSum += normalizedWeight;
    longitude += unwrapLongitude(groupCenters[index][0], longitudeReference) * normalizedWeight;
    latitude += groupCenters[index][1] * normalizedWeight;
    height += groupCenters[index][2] * normalizedWeight;
  }
  const anchor: [number, number, number] = [longitude / weightSum, latitude / weightSum, height / weightSum];
  return anchor.every(Number.isFinite)
    ? { status: 'ok', value: anchor }
    : nonOk('error', 'producer anchor is non-finite');
}

function actualHeights(primitives: readonly VisualPrimitive[]): number[] {
  const heights: number[] = [];
  for (const primitive of primitives) {
    if (primitive.kind === 'extruded-footprint') {
      const topValues = Array.isArray(primitive.topMeters) ? primitive.topMeters : [primitive.topMeters];
      for (const top of topValues) heights.push(Math.abs(top - primitive.baseMeters));
    } else if (
      primitive.kind === 'polygon' ||
      primitive.kind === 'mesh-support' ||
      primitive.kind === 'path-corridor'
    ) {
      const positions =
        primitive.kind === 'polygon'
          ? primitive.rings.flat()
          : primitive.kind === 'mesh-support'
            ? primitive.vertices
            : primitive.positions;
      let minimum = Number.POSITIVE_INFINITY;
      let maximum = Number.NEGATIVE_INFINITY;
      for (const position of positions) {
        minimum = Math.min(minimum, position[2] ?? 0);
        maximum = Math.max(maximum, position[2] ?? 0);
      }
      if (maximum > minimum) heights.push(maximum - minimum);
    }
  }
  return heights;
}

function deriveSupportGuarantee(
  descriptor: ResolvedLayerDescriptor,
  primitives: readonly VisualPrimitive[],
): SupportGuarantee {
  const hasInflation = primitives.some((primitive) => {
    if (primitive.kind === 'point-disc' || primitive.kind === 'path-corridor') {
      return primitive.pixelClamp?.supportBufferPx !== undefined && primitive.pixelClamp.supportBufferPx > 0;
    }
    return 'supportBufferPx' in primitive && primitive.supportBufferPx !== undefined && primitive.supportBufferPx > 0;
  });
  const hasMeterApproximation = primitives.some(
    (primitive) =>
      (primitive.kind === 'point-disc' && primitive.radius.unit === 'meters') ||
      (primitive.kind === 'path-corridor' && primitive.halfWidth.unit === 'meters'),
  );
  const producerSuperset =
    descriptor.resolvedSupport.producer === 'heatmap-kernel' || descriptor.resolvedSupport.producer === 'trip-path';
  const gpuNumericalMargin = descriptor.rendererVersion === 1;
  return hasInflation || hasMeterApproximation || producerSuperset || gpuNumericalMargin
    ? 'conservative'
    : 'renderer-exact';
}

function requireProducerSelectionContract(input: CertifiedProducerInput): EnvelopeResult<true> {
  const support = input.runtime.descriptor.resolvedSupport;
  const producer = support.producer;
  if (producer === 'hexagon-cell' && input.selection.query?.queryId !== 'select-hexagon-cell-v1') {
    return nonOk('unsupported', 'hexagon envelope requires select-hexagon-cell-v1 renderer query evidence');
  }
  if (support.producer === 'heatmap-kernel') {
    const weightSourceCount =
      (support.weightAccessorId === undefined ? 0 : 1) + (support.weightDefault === undefined ? 0 : 1);
    if (weightSourceCount !== 1) {
      return nonOk('unsupported', 'heatmap support requires exactly one resolved weight accessor or default');
    }
    const certification = input.selection.query?.certification ?? input.selection.association?.certification;
    if (
      certification?.kind !== 'heatmap-halo-complete-v1' ||
      certification.contributorSet !== 'complete' ||
      certification.haloRadiusPixels < support.radiusPixels
    ) {
      return nonOk('unsupported', 'heatmap envelope requires complete kernel-radius halo evidence');
    }
  }
  if (support.producer === 'polygon-extrusion') {
    const elevationSourceCount =
      (support.elevationAccessorId === undefined ? 0 : 1) + (support.elevationDefaultMeters === undefined ? 0 : 1);
    if (elevationSourceCount !== 1) {
      return nonOk('unsupported', 'polygon support requires exactly one resolved elevation accessor or default');
    }
  }
  return { status: 'ok', value: true };
}

function produceCertified(
  input: CertifiedProducerInput,
  expectedProducer: CameraEnvelopeConfig['producer'],
): EnvelopeResult<SnapshotEnvelope> {
  const descriptor = input.runtime.descriptor;
  if (
    descriptor.resolvedSupport.producer !== expectedProducer ||
    descriptor.cameraEnvelope.producer !== expectedProducer
  ) {
    return nonOk<SnapshotEnvelope>('unsupported', `resolved layer does not use the ${expectedProducer} producer`);
  }
  const provenance = validateProvenance(input);
  if (provenance.status !== 'ok') return provenance;
  const selectionContract = requireProducerSelectionContract(input);
  if (selectionContract.status !== 'ok') return selectionContract;
  const estimate = estimateProduction(input);
  if (estimate.status !== 'ok') return estimate;
  const budget = enforceEnvelopeProductionBudget({ schemaVersion: 1, ...estimate.value }, input.productionPolicyId);
  if (budget.status !== 'ok') return budget;
  const normalized = normalizeProduction(input);
  if (normalized.status !== 'ok') return normalized;
  let metricContext: ProducerMetricContext;
  try {
    metricContext = buildProducerMetricContext(
      {
        schemaVersion: 1,
        selectionRevision: input.selection.selectionRevision,
        resolvedLayerDigest: descriptor.resolvedLayerDigest,
        cameraCalibrationDigest: deriveCameraCalibrationDigest(descriptor.cameraCalibration),
        supportGroups: normalized.value.supportGroups,
        glyphPrimitiveIndexes: normalized.value.glyphPrimitiveIndexes,
        footprintPrimitiveIndexes: normalized.value.footprintPrimitiveIndexes,
        anchorWeightPolicy: 'projected-support-area-v1',
      },
      input.sceneMetricContext,
      normalized.value.primitives,
    );
  } catch (error) {
    return nonOk<SnapshotEnvelope>('unsupported', error instanceof Error ? error.message : String(error));
  }
  const contextValidation = validateProducerMetricContext(metricContext, {
    sceneRevision: input.sceneMetricContext.sceneRevision,
    sceneContextRevision: input.sceneMetricContext.sceneContextRevision,
    projectedFrameRevision: input.sceneMetricContext.projectedFrameRevision,
    sceneSupportDigest: input.sceneMetricContext.sceneSupportDigest,
    selectionRevision: input.selection.selectionRevision,
    resolvedLayerDigest: descriptor.resolvedLayerDigest,
    cameraCalibrationDigest: deriveCameraCalibrationDigest(descriptor.cameraCalibration),
  });
  if (contextValidation.status !== 'ok') return contextValidation;
  let metrics;
  try {
    metrics = computeContentMetrics({
      actualHeightsMeters: actualHeights(normalized.value.primitives),
      density: {
        hasAccessor: input.selection.marks.length > 0,
        count:
          descriptor.resolvedSupport.producer === 'hexagon-cell'
            ? input.selection.marks.reduce((sum, mark) => sum + (mark.kind === 'hexagon-cell' ? mark.count : 0), 0)
            : input.selection.marks.length,
        glyphSupportAreasAtReferenceZoomPx2: metricContext.glyphSupportAreasAtReferenceZoomPx2,
      },
      coverage: {
        targetProjectedArea: metricContext.targetProjectedSupportUnionArea,
        sceneContextProjectedArea: metricContext.sceneContext.sceneContextProjectedSupportUnionArea,
      },
      members: {
        count: metricContext.supportGroups.length,
        centroidsProjected: metricContext.supportGroups.map((group) => group.centroidProjected),
        projectedAreas: metricContext.supportGroups.map((group) => group.projectedSupportArea),
      },
      footprintProjectedPoints: metricContext.footprintProjectedPoints,
      pathsProjected: metricContext.pathsProjected,
      calibration: descriptor.cameraCalibration,
    });
  } catch (error) {
    return nonOk<SnapshotEnvelope>('error', error instanceof Error ? error.message : String(error));
  }
  const anchor = anchorFromContext(normalized.value.primitives, metricContext);
  if (anchor.status !== 'ok') return anchor;
  const calibrationDigest = deriveCameraCalibrationDigest(descriptor.cameraCalibration);
  const result = createSnapshotEnvelope({
    id: `snapshot:${input.selection.memberId}:${expectedProducer}`,
    supportGuarantee: deriveSupportGuarantee(descriptor, normalized.value.primitives),
    provenance: {
      datasetId: descriptor.datasetId,
      visualizationId: descriptor.visualizationId,
      layerId: descriptor.layerId,
      dataRevision: descriptor.dataRevision,
      visualizationRevision: descriptor.visualizationRevision,
      producerId: expectedProducer,
      producerVersion: descriptor.cameraEnvelope.producerVersion,
      sceneRevision: input.sceneMetricContext.sceneRevision,
      resolvedLayerDigest: descriptor.resolvedLayerDigest,
    },
    primitives: normalized.value.primitives,
    anchor: anchor.value,
    metrics,
    revisionDependencies: [
      `selection:${input.selection.selectionRevision}`,
      `producer-context:${metricContext.revision}`,
      `descriptor:${descriptor.resolvedLayerDigest}`,
      `calibration:${calibrationDigest}`,
      `scene-context:${input.sceneMetricContext.revision}`,
      `producer:${expectedProducer}:v${descriptor.cameraEnvelope.producerVersion}`,
    ],
  });
  if (result.status !== 'ok') return result;
  if (normalized.value.requiresFullWorld && result.value.frame.wrap.wrapMode !== 'full-world') {
    return nonOk('unsupported', 'full-world selection requires complete connected 360-degree geometry');
  }
  return result;
}

function produceFor(
  input: EnvelopeProducerInput,
  expectedProducer: CameraEnvelopeConfig['producer'],
): EnvelopeResult<SnapshotEnvelope> {
  const preflight = preflightInput(input);
  return preflight.status === 'ok' ? produceCertified(preflight.value, expectedProducer) : preflight;
}

export const envelopeProducerRegistry: Readonly<Record<CameraEnvelopeConfig['producer'], EnvelopeProducer>> =
  Object.freeze({
    'hexagon-cell': (input) => produceFor(input, 'hexagon-cell'),
    'heatmap-kernel': (input) => produceFor(input, 'heatmap-kernel'),
    'scatter-point': (input) => produceFor(input, 'scatter-point'),
    'line-path': (input) => produceFor(input, 'line-path'),
    'trip-path': (input) => produceFor(input, 'trip-path'),
    'polygon-extrusion': (input) => produceFor(input, 'polygon-extrusion'),
  });

export function produceSnapshotEnvelope(input: EnvelopeProducerInput): EnvelopeResult<SnapshotEnvelope> {
  const preflight = preflightInput(input);
  if (preflight.status !== 'ok') return preflight;
  const producer = preflight.value.runtime.descriptor.cameraEnvelope.producer;
  return produceCertified(preflight.value, producer);
}
