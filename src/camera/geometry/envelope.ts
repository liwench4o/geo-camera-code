import { digestCanonical } from './canonical-digest';
import {
  chooseWrapFrame,
  MERCATOR_LATITUDE_LIMIT,
  normalizeLongitude,
  shortestAngle,
  unwrapLongitude,
  validateMercatorSupport,
} from './geo-wrap';
import { validateVisualPrimitive } from './primitives';
import type {
  ContentMetrics,
  EnvelopeResult,
  LngLat,
  PixelClamp,
  SnapshotEnvelope,
  TargetProvenance,
  UnitValue,
  VisualPrimitive,
  VisualTargetFrame,
  WorldPosition,
  WrapMetadata,
} from './types';

const FULL_CIRCLE_DEGREES = 360;
const FULL_WORLD_EPSILON_DEGREES = 1e-10;
const UNION_SCHEMA = 'envelope-union-v1';
const UNION_PRODUCER_VERSION = 1;
const DIGEST_PATTERN = /^[0-9a-f]{16}$/;

interface ExactObjectSchema {
  required: readonly string[];
  allowed: ReadonlySet<PropertyKey>;
}

const SNAPSHOT_INPUT_SCHEMA = defineExactObjectSchema(
  ['id', 'supportGuarantee', 'provenance', 'primitives', 'anchor', 'metrics'],
  ['wrap', 'revisionDependencies'],
);
const SNAPSHOT_ENVELOPE_SCHEMA = defineExactObjectSchema(
  ['binding', 'id', 'supportGuarantee', 'provenance', 'revision', 'frame'],
  ['revisionDependencies'],
);
const UNION_INPUT_SCHEMA = defineExactObjectSchema(['id', 'envelopes', 'anchorWeights', 'metrics']);
const TARGET_FRAME_SCHEMA = defineExactObjectSchema(['primitives', 'anchor', 'metrics', 'wrap']);
const PROVENANCE_SCHEMA = defineExactObjectSchema([
  'datasetId',
  'visualizationId',
  'layerId',
  'dataRevision',
  'visualizationRevision',
  'producerId',
  'producerVersion',
  'sceneRevision',
  'resolvedLayerDigest',
]);
const METRICS_SCHEMA = defineExactObjectSchema(
  [
    'elevation',
    'density',
    'coverage',
    'dispersion',
    'elongation',
    'curvature',
    'calibrationVersion',
    'fallbackReasons',
  ],
  ['orientationDeg'],
);
const WRAP_SCHEMA = defineExactObjectSchema(['wrapReference', 'worldOffset', 'wrapMode']);
const UNIT_VALUE_SCHEMA = defineExactObjectSchema(['value', 'unit']);
const PIXEL_CLAMP_SCHEMA = defineExactObjectSchema([], ['minPx', 'maxPx', 'supportBufferPx']);
const POINT_DISC_SCHEMA = defineExactObjectSchema(['kind', 'position', 'radius'], ['pixelClamp']);
const SCREEN_RECT_SCHEMA = defineExactObjectSchema(['kind', 'position', 'widthPx', 'heightPx'], ['supportBufferPx']);
const EXTRUDED_FOOTPRINT_SCHEMA = defineExactObjectSchema(
  ['kind', 'rings', 'baseMeters', 'topMeters'],
  ['supportBufferPx'],
);
const PATH_CORRIDOR_SCHEMA = defineExactObjectSchema(['kind', 'positions', 'halfWidth'], ['pixelClamp']);
const POLYGON_SCHEMA = defineExactObjectSchema(['kind', 'rings'], ['supportBufferPx']);
const MESH_SUPPORT_SCHEMA = defineExactObjectSchema(['kind', 'vertices', 'conservative'], ['supportBufferPx']);

type SupportGuarantee = SnapshotEnvelope['supportGuarantee'];
type FailureStatus = Exclude<EnvelopeResult<never>['status'], 'ok'>;

export interface SnapshotEnvelopeInput {
  id: string;
  supportGuarantee: 'renderer-exact' | 'conservative' | 'legacy-approximation';
  provenance: TargetProvenance;
  primitives: VisualPrimitive[];
  anchor: [number, number, number];
  metrics: ContentMetrics;
  revisionDependencies?: string[];
  wrap?: WrapMetadata;
}

interface ReframedChild {
  primitives: VisualPrimitive[];
  anchor: [number, number, number];
}

interface LongitudeInterval {
  minimum: number;
  maximum: number;
}

interface FullWorldUnionFrame {
  interval: LongitudeInterval;
  childIntervals: Array<LongitudeInterval | undefined>;
}

function defineExactObjectSchema(required: readonly string[], optional: readonly string[] = []): ExactObjectSchema {
  return {
    required,
    allowed: new Set<PropertyKey>([...required, ...optional]),
  };
}

function failure(status: FailureStatus, reason: string): EnvelopeResult<never> {
  return { status, reason };
}

function validateExactObjectSchema(value: unknown, schema: ExactObjectSchema, label: string): EnvelopeResult<true> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return failure('error', `${label} must be an object`);
  }

  let prototype: object | null;
  let ownKeys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return failure('error', `${label} schema cannot be inspected`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return failure('error', `${label} must be a plain object`);
  }
  for (const key of ownKeys) {
    if (!schema.allowed.has(key)) {
      return failure('error', `${label} contains unknown key ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return failure('error', `${label} key ${String(key)} must be an enumerable own data property`);
    }
  }
  for (const key of schema.required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return failure('error', `${label} is missing required key ${key}`);
    }
  }
  return { status: 'ok', value: true };
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateId(id: unknown): EnvelopeResult<true> {
  return isNonBlankString(id)
    ? { status: 'ok', value: true }
    : failure('error', 'snapshot envelope id must be a non-blank string');
}

function validateSupportGuarantee(guarantee: unknown): EnvelopeResult<true> {
  if (guarantee !== 'renderer-exact' && guarantee !== 'conservative' && guarantee !== 'legacy-approximation') {
    return failure('error', 'snapshot envelope support guarantee is invalid');
  }
  return { status: 'ok', value: true };
}

function validateProvenance(provenance: unknown): EnvelopeResult<true> {
  const schemaValidation = validateExactObjectSchema(provenance, PROVENANCE_SCHEMA, 'snapshot envelope provenance');
  if (schemaValidation.status !== 'ok') {
    return schemaValidation;
  }

  const candidate = provenance as Partial<TargetProvenance>;
  const stringFields: Array<keyof Omit<TargetProvenance, 'producerVersion'>> = [
    'datasetId',
    'visualizationId',
    'layerId',
    'dataRevision',
    'visualizationRevision',
    'producerId',
    'sceneRevision',
    'resolvedLayerDigest',
  ];
  for (const field of stringFields) {
    if (!isNonBlankString(candidate[field])) {
      return failure('error', `snapshot envelope provenance ${field} must be a non-blank string`);
    }
  }
  if (typeof candidate.producerVersion !== 'number' || !Number.isFinite(candidate.producerVersion)) {
    return failure('error', 'snapshot envelope provenance producerVersion must be finite');
  }
  return { status: 'ok', value: true };
}

function validateMetricUnitInterval(value: unknown, label: string): EnvelopeResult<true> {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return failure('error', `${label} must be a finite number in [0, 1]`);
  }
  return { status: 'ok', value: true };
}

function validateMetrics(metrics: unknown): EnvelopeResult<true> {
  const schemaValidation = validateExactObjectSchema(metrics, METRICS_SCHEMA, 'snapshot envelope metrics');
  if (schemaValidation.status !== 'ok') {
    return schemaValidation;
  }

  const candidate = metrics as Partial<ContentMetrics>;
  const unitFields: Array<
    keyof Pick<ContentMetrics, 'elevation' | 'density' | 'coverage' | 'dispersion' | 'elongation' | 'curvature'>
  > = ['elevation', 'density', 'coverage', 'dispersion', 'elongation', 'curvature'];
  for (const field of unitFields) {
    const validation = validateMetricUnitInterval(candidate[field], `snapshot envelope metric ${field}`);
    if (validation.status !== 'ok') {
      return validation;
    }
  }

  if (candidate.orientationDeg !== undefined && !Number.isFinite(candidate.orientationDeg)) {
    return failure('error', 'snapshot envelope metric orientationDeg must be finite when present');
  }
  if (typeof candidate.calibrationVersion !== 'number' || !Number.isFinite(candidate.calibrationVersion)) {
    return failure('error', 'snapshot envelope metric calibrationVersion must be finite');
  }
  if (!Array.isArray(candidate.fallbackReasons)) {
    return failure('error', 'snapshot envelope metric fallbackReasons must be an array');
  }
  for (let index = 0; index < candidate.fallbackReasons.length; index += 1) {
    if (typeof candidate.fallbackReasons[index] !== 'string') {
      return failure('error', `snapshot envelope metric fallbackReasons ${index} must be a string`);
    }
  }
  return { status: 'ok', value: true };
}

function validateWrapMetadata(wrap: unknown): EnvelopeResult<true> {
  const schemaValidation = validateExactObjectSchema(wrap, WRAP_SCHEMA, 'snapshot envelope wrap metadata');
  if (schemaValidation.status !== 'ok') {
    return schemaValidation;
  }
  const candidate = wrap as Partial<WrapMetadata>;
  if (typeof candidate.wrapReference !== 'number' || !Number.isFinite(candidate.wrapReference)) {
    return failure('error', 'snapshot envelope wrapReference must be finite');
  }
  if (
    typeof candidate.worldOffset !== 'number' ||
    !Number.isFinite(candidate.worldOffset) ||
    !Number.isInteger(candidate.worldOffset)
  ) {
    return failure('error', 'snapshot envelope worldOffset must be a finite integer');
  }
  if (candidate.wrapMode !== 'minimum-arc' && candidate.wrapMode !== 'full-world') {
    return failure('error', 'snapshot envelope wrapMode is invalid');
  }
  const effectiveReference = candidate.wrapReference + candidate.worldOffset * FULL_CIRCLE_DEGREES;
  if (!Number.isFinite(effectiveReference)) {
    return failure('error', 'snapshot envelope effective wrap reference must be finite');
  }
  return { status: 'ok', value: true };
}

function validateAnchor(anchor: unknown): EnvelopeResult<true> {
  if (!Array.isArray(anchor) || anchor.length !== 3) {
    return failure('error', 'snapshot envelope anchor must be a three-number tuple');
  }
  for (let index = 0; index < anchor.length; index += 1) {
    if (typeof anchor[index] !== 'number' || !Number.isFinite(anchor[index])) {
      return failure('error', `snapshot envelope anchor component ${index} must be finite`);
    }
  }
  return validateMercatorSupport([[anchor[0], anchor[1]]]);
}

function cloneLngLat(position: LngLat): LngLat {
  const result: LngLat = [position[0], position[1]];
  Object.freeze(result);
  return result;
}

function cloneWorldPosition(position: WorldPosition): WorldPosition {
  const result: WorldPosition =
    position[2] === undefined ? [position[0], position[1]] : [position[0], position[1], position[2]];
  Object.freeze(result);
  return result;
}

function cloneUnitValue(value: UnitValue): UnitValue {
  const result: UnitValue = { value: value.value, unit: value.unit };
  Object.freeze(result);
  return result;
}

function clonePixelClamp(clamp: PixelClamp | undefined): PixelClamp | undefined {
  if (clamp === undefined) {
    return undefined;
  }
  const result: PixelClamp = {};
  if (clamp.minPx !== undefined) {
    result.minPx = clamp.minPx;
  }
  if (clamp.maxPx !== undefined) {
    result.maxPx = clamp.maxPx;
  }
  if (clamp.supportBufferPx !== undefined) {
    result.supportBufferPx = clamp.supportBufferPx;
  }
  Object.freeze(result);
  return result;
}

function cloneLngLatRings(rings: LngLat[][]): LngLat[][] {
  const copiedRings: LngLat[][] = new Array(rings.length);
  for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
    const ring = rings[ringIndex];
    const copiedRing: LngLat[] = new Array(ring.length);
    for (let vertexIndex = 0; vertexIndex < ring.length; vertexIndex += 1) {
      copiedRing[vertexIndex] = cloneLngLat(ring[vertexIndex]);
    }
    Object.freeze(copiedRing);
    copiedRings[ringIndex] = copiedRing;
  }
  Object.freeze(copiedRings);
  return copiedRings;
}

function cloneWorldRings(rings: WorldPosition[][]): WorldPosition[][] {
  const copiedRings: WorldPosition[][] = new Array(rings.length);
  for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
    const ring = rings[ringIndex];
    const copiedRing: WorldPosition[] = new Array(ring.length);
    for (let vertexIndex = 0; vertexIndex < ring.length; vertexIndex += 1) {
      copiedRing[vertexIndex] = cloneWorldPosition(ring[vertexIndex]);
    }
    Object.freeze(copiedRing);
    copiedRings[ringIndex] = copiedRing;
  }
  Object.freeze(copiedRings);
  return copiedRings;
}

function cloneWorldPositions(positions: WorldPosition[]): WorldPosition[] {
  const copied: WorldPosition[] = new Array(positions.length);
  for (let index = 0; index < positions.length; index += 1) {
    copied[index] = cloneWorldPosition(positions[index]);
  }
  Object.freeze(copied);
  return copied;
}

function clonePrimitive(primitive: VisualPrimitive): VisualPrimitive {
  let result: VisualPrimitive;
  switch (primitive.kind) {
    case 'point-disc': {
      const pixelClamp = clonePixelClamp(primitive.pixelClamp);
      result = {
        kind: 'point-disc',
        position: cloneWorldPosition(primitive.position),
        radius: cloneUnitValue(primitive.radius),
        ...(pixelClamp === undefined ? {} : { pixelClamp }),
      };
      break;
    }
    case 'screen-rect':
      result = {
        kind: 'screen-rect',
        position: cloneWorldPosition(primitive.position),
        widthPx: primitive.widthPx,
        heightPx: primitive.heightPx,
        ...(primitive.supportBufferPx === undefined ? {} : { supportBufferPx: primitive.supportBufferPx }),
      };
      break;
    case 'extruded-footprint': {
      let topMeters: number | number[] = primitive.topMeters;
      if (Array.isArray(primitive.topMeters)) {
        topMeters = primitive.topMeters.slice();
        Object.freeze(topMeters);
      }
      result = {
        kind: 'extruded-footprint',
        rings: cloneLngLatRings(primitive.rings),
        baseMeters: primitive.baseMeters,
        topMeters,
        ...(primitive.supportBufferPx === undefined ? {} : { supportBufferPx: primitive.supportBufferPx }),
      };
      break;
    }
    case 'path-corridor': {
      const pixelClamp = clonePixelClamp(primitive.pixelClamp);
      result = {
        kind: 'path-corridor',
        positions: cloneWorldPositions(primitive.positions),
        halfWidth: cloneUnitValue(primitive.halfWidth),
        ...(pixelClamp === undefined ? {} : { pixelClamp }),
      };
      break;
    }
    case 'polygon':
      result = {
        kind: 'polygon',
        rings: cloneWorldRings(primitive.rings),
        ...(primitive.supportBufferPx === undefined ? {} : { supportBufferPx: primitive.supportBufferPx }),
      };
      break;
    case 'mesh-support':
      result = {
        kind: 'mesh-support',
        vertices: cloneWorldPositions(primitive.vertices),
        conservative: true,
        ...(primitive.supportBufferPx === undefined ? {} : { supportBufferPx: primitive.supportBufferPx }),
      };
      break;
  }
  Object.freeze(result);
  return result;
}

function clonePrimitives(primitives: VisualPrimitive[]): VisualPrimitive[] {
  const copied: VisualPrimitive[] = new Array(primitives.length);
  for (let index = 0; index < primitives.length; index += 1) {
    copied[index] = clonePrimitive(primitives[index]);
  }
  Object.freeze(copied);
  return copied;
}

function cloneProvenance(provenance: TargetProvenance): TargetProvenance {
  const result: TargetProvenance = {
    datasetId: provenance.datasetId,
    visualizationId: provenance.visualizationId,
    layerId: provenance.layerId,
    dataRevision: provenance.dataRevision,
    visualizationRevision: provenance.visualizationRevision,
    producerId: provenance.producerId,
    producerVersion: provenance.producerVersion,
    sceneRevision: provenance.sceneRevision,
    resolvedLayerDigest: provenance.resolvedLayerDigest,
  };
  Object.freeze(result);
  return result;
}

function cloneMetrics(metrics: ContentMetrics): ContentMetrics {
  const fallbackReasons = metrics.fallbackReasons.slice();
  Object.freeze(fallbackReasons);
  const result: ContentMetrics = {
    elevation: metrics.elevation,
    density: metrics.density,
    coverage: metrics.coverage,
    dispersion: metrics.dispersion,
    elongation: metrics.elongation,
    ...(metrics.orientationDeg === undefined ? {} : { orientationDeg: metrics.orientationDeg }),
    curvature: metrics.curvature,
    calibrationVersion: metrics.calibrationVersion,
    fallbackReasons,
  };
  Object.freeze(result);
  return result;
}

function cloneWrap(wrap: WrapMetadata): WrapMetadata {
  const result: WrapMetadata = {
    wrapReference: wrap.wrapReference,
    worldOffset: wrap.worldOffset,
    wrapMode: wrap.wrapMode,
  };
  Object.freeze(result);
  return result;
}

function cloneAnchor(anchor: [number, number, number]): [number, number, number] {
  const result: [number, number, number] = [anchor[0], anchor[1], anchor[2]];
  Object.freeze(result);
  return result;
}

function appendPrimitiveLongitudes(primitive: VisualPrimitive, longitudes: number[]): void {
  switch (primitive.kind) {
    case 'point-disc':
    case 'screen-rect':
      longitudes.push(primitive.position[0]);
      return;
    case 'extruded-footprint':
      for (let ringIndex = 0; ringIndex < primitive.rings.length; ringIndex += 1) {
        const ring = primitive.rings[ringIndex];
        for (let index = 0; index < ring.length; index += 1) {
          longitudes.push(ring[index][0]);
        }
      }
      return;
    case 'path-corridor':
      for (let index = 0; index < primitive.positions.length; index += 1) {
        longitudes.push(primitive.positions[index][0]);
      }
      return;
    case 'polygon':
      for (let ringIndex = 0; ringIndex < primitive.rings.length; ringIndex += 1) {
        const ring = primitive.rings[ringIndex];
        for (let index = 0; index < ring.length; index += 1) {
          longitudes.push(ring[index][0]);
        }
      }
      return;
    case 'mesh-support':
      for (let index = 0; index < primitive.vertices.length; index += 1) {
        longitudes.push(primitive.vertices[index][0]);
      }
      return;
  }
}

function appendPrimitiveCoordinates(primitive: VisualPrimitive, coordinates: LngLat[]): void {
  switch (primitive.kind) {
    case 'point-disc':
    case 'screen-rect':
      coordinates.push([primitive.position[0], primitive.position[1]]);
      return;
    case 'extruded-footprint':
      for (let ringIndex = 0; ringIndex < primitive.rings.length; ringIndex += 1) {
        const ring = primitive.rings[ringIndex];
        for (let index = 0; index < ring.length; index += 1) {
          coordinates.push([ring[index][0], ring[index][1]]);
        }
      }
      return;
    case 'path-corridor':
      for (let index = 0; index < primitive.positions.length; index += 1) {
        coordinates.push([primitive.positions[index][0], primitive.positions[index][1]]);
      }
      return;
    case 'polygon':
      for (let ringIndex = 0; ringIndex < primitive.rings.length; ringIndex += 1) {
        const ring = primitive.rings[ringIndex];
        for (let index = 0; index < ring.length; index += 1) {
          coordinates.push([ring[index][0], ring[index][1]]);
        }
      }
      return;
    case 'mesh-support':
      for (let index = 0; index < primitive.vertices.length; index += 1) {
        coordinates.push([primitive.vertices[index][0], primitive.vertices[index][1]]);
      }
      return;
  }
}

function validateWorldPositionTuple(value: unknown, label: string): EnvelopeResult<true> {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) {
    return failure('error', `${label} must contain exactly two or three components`);
  }
  return { status: 'ok', value: true };
}

function validateLngLatTuple(value: unknown, label: string): EnvelopeResult<true> {
  if (!Array.isArray(value) || value.length !== 2) {
    return failure('error', `${label} must contain exactly two components`);
  }
  return { status: 'ok', value: true };
}

function validateWorldPositionList(value: unknown, label: string): EnvelopeResult<true> {
  if (!Array.isArray(value)) {
    return failure('error', `${label} must be an array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const validation = validateWorldPositionTuple(value[index], `${label} ${index}`);
    if (validation.status !== 'ok') {
      return validation;
    }
  }
  return { status: 'ok', value: true };
}

function validateRingTupleShapes(value: unknown, withHeights: boolean, label: string): EnvelopeResult<true> {
  if (!Array.isArray(value)) {
    return failure('error', `${label} must be an array`);
  }
  for (let ringIndex = 0; ringIndex < value.length; ringIndex += 1) {
    const ring = value[ringIndex];
    if (!Array.isArray(ring)) {
      return failure('error', `${label} ring ${ringIndex} must be an array`);
    }
    for (let vertexIndex = 0; vertexIndex < ring.length; vertexIndex += 1) {
      const validation = withHeights
        ? validateWorldPositionTuple(ring[vertexIndex], `${label} ring ${ringIndex} vertex ${vertexIndex}`)
        : validateLngLatTuple(ring[vertexIndex], `${label} ring ${ringIndex} vertex ${vertexIndex}`);
      if (validation.status !== 'ok') {
        return validation;
      }
    }
  }
  return { status: 'ok', value: true };
}

function validateUnitValueSchema(value: unknown, label: string): EnvelopeResult<true> {
  return validateExactObjectSchema(value, UNIT_VALUE_SCHEMA, label);
}

function validatePixelClampSchema(value: unknown, label: string): EnvelopeResult<true> {
  return value === undefined
    ? { status: 'ok', value: true }
    : validateExactObjectSchema(value, PIXEL_CLAMP_SCHEMA, label);
}

function validatePrimitiveSchema(primitive: unknown, index: number): EnvelopeResult<true> {
  if (!primitive || typeof primitive !== 'object' || Array.isArray(primitive)) {
    return failure('error', `visual primitive ${index} must be an object`);
  }
  const candidate = primitive as Partial<VisualPrimitive>;
  let objectSchema: ExactObjectSchema;
  switch (candidate.kind) {
    case 'point-disc':
      objectSchema = POINT_DISC_SCHEMA;
      break;
    case 'screen-rect':
      objectSchema = SCREEN_RECT_SCHEMA;
      break;
    case 'extruded-footprint':
      objectSchema = EXTRUDED_FOOTPRINT_SCHEMA;
      break;
    case 'path-corridor':
      objectSchema = PATH_CORRIDOR_SCHEMA;
      break;
    case 'polygon':
      objectSchema = POLYGON_SCHEMA;
      break;
    case 'mesh-support':
      objectSchema = MESH_SUPPORT_SCHEMA;
      break;
    default:
      return failure('error', `visual primitive ${index} has an unsupported kind`);
  }

  const objectValidation = validateExactObjectSchema(primitive, objectSchema, `visual primitive ${index}`);
  if (objectValidation.status !== 'ok') {
    return objectValidation;
  }

  const visualPrimitive = primitive as VisualPrimitive;
  switch (visualPrimitive.kind) {
    case 'point-disc': {
      const positionValidation = validateWorldPositionTuple(
        visualPrimitive.position,
        `visual primitive ${index} point-disc position`,
      );
      if (positionValidation.status !== 'ok') return positionValidation;
      const radiusValidation = validateUnitValueSchema(
        visualPrimitive.radius,
        `visual primitive ${index} point-disc radius`,
      );
      if (radiusValidation.status !== 'ok') return radiusValidation;
      return validatePixelClampSchema(visualPrimitive.pixelClamp, `visual primitive ${index} point-disc pixelClamp`);
    }
    case 'screen-rect':
      return validateWorldPositionTuple(visualPrimitive.position, `visual primitive ${index} screen-rect position`);
    case 'extruded-footprint':
      return validateRingTupleShapes(visualPrimitive.rings, false, `visual primitive ${index} extruded-footprint`);
    case 'path-corridor': {
      const positionsValidation = validateWorldPositionList(
        visualPrimitive.positions,
        `visual primitive ${index} path-corridor position`,
      );
      if (positionsValidation.status !== 'ok') return positionsValidation;
      const halfWidthValidation = validateUnitValueSchema(
        visualPrimitive.halfWidth,
        `visual primitive ${index} path-corridor halfWidth`,
      );
      if (halfWidthValidation.status !== 'ok') return halfWidthValidation;
      return validatePixelClampSchema(visualPrimitive.pixelClamp, `visual primitive ${index} path-corridor pixelClamp`);
    }
    case 'polygon':
      return validateRingTupleShapes(visualPrimitive.rings, true, `visual primitive ${index} polygon`);
    case 'mesh-support':
      return validateWorldPositionList(visualPrimitive.vertices, `visual primitive ${index} mesh-support vertex`);
  }
}

function validatePrimitives(primitives: unknown): EnvelopeResult<true> {
  if (!Array.isArray(primitives) || primitives.length === 0) {
    return failure('error', 'snapshot envelope requires at least one visual primitive');
  }

  const coordinates: LngLat[] = [];
  for (let index = 0; index < primitives.length; index += 1) {
    const schemaValidation = validatePrimitiveSchema(primitives[index], index);
    if (schemaValidation.status !== 'ok') {
      return schemaValidation;
    }
    const validation = validateVisualPrimitive(primitives[index] as VisualPrimitive);
    if (validation.status !== 'ok') {
      return failure(validation.status, `visual primitive ${index}: ${validation.reason}`);
    }
    appendPrimitiveCoordinates(primitives[index] as VisualPrimitive, coordinates);
  }
  return validateMercatorSupport(coordinates);
}

function validateRendererExactSupport(primitives: VisualPrimitive[]): EnvelopeResult<true> {
  for (let index = 0; index < primitives.length; index += 1) {
    const primitive = primitives[index];
    if (primitive.kind === 'mesh-support') {
      return failure('error', `visual primitive ${index}: mesh support cannot be renderer-exact`);
    }
    if (primitive.kind === 'point-disc' && primitive.radius.unit === 'meters') {
      return failure('error', `visual primitive ${index}: meter point support cannot be renderer-exact`);
    }
    if (primitive.kind === 'path-corridor' && primitive.halfWidth.unit === 'meters') {
      return failure('error', `visual primitive ${index}: meter path support cannot be renderer-exact`);
    }
    const supportBufferPx =
      primitive.kind === 'point-disc' || primitive.kind === 'path-corridor'
        ? primitive.pixelClamp?.supportBufferPx
        : primitive.supportBufferPx;
    if (supportBufferPx !== undefined && supportBufferPx > 0) {
      return failure('error', `visual primitive ${index}: positive support inflation cannot be renderer-exact`);
    }
  }
  return { status: 'ok', value: true };
}

function validateGuaranteeForPrimitives(
  supportGuarantee: SupportGuarantee,
  primitives: VisualPrimitive[],
): EnvelopeResult<true> {
  return supportGuarantee === 'renderer-exact'
    ? validateRendererExactSupport(primitives)
    : { status: 'ok', value: true };
}

function longitudeInterval(positions: ArrayLike<LngLat | WorldPosition>): LongitudeInterval {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < positions.length; index += 1) {
    minimum = Math.min(minimum, positions[index][0]);
    maximum = Math.max(maximum, positions[index][0]);
  }
  return { minimum, maximum };
}

function appendConnectedLongitudeIntervals(primitive: VisualPrimitive, intervals: LongitudeInterval[]): void {
  switch (primitive.kind) {
    case 'point-disc':
    case 'screen-rect':
      intervals.push({ minimum: primitive.position[0], maximum: primitive.position[0] });
      return;
    case 'extruded-footprint':
      for (let index = 0; index < primitive.rings.length; index += 1) {
        intervals.push(longitudeInterval(primitive.rings[index]));
      }
      return;
    case 'path-corridor':
      intervals.push(longitudeInterval(primitive.positions));
      return;
    case 'polygon':
      for (let index = 0; index < primitive.rings.length; index += 1) {
        intervals.push(longitudeInterval(primitive.rings[index]));
      }
      return;
    case 'mesh-support':
      intervals.push(longitudeInterval(primitive.vertices));
      return;
  }
}

function differenceAtLeastFullCircle(maximum: number, minimum: number): boolean {
  const difference = maximum - minimum;
  if (difference !== FULL_CIRCLE_DEGREES) {
    return difference > FULL_CIRCLE_DEGREES;
  }

  // TwoDiff recovers the exact rounding tail of maximum - minimum. When the
  // rounded difference lands on 360, the tail decides which side of the strict
  // boundary the represented input coordinates actually occupy.
  const minimumVirtual = maximum - difference;
  const maximumVirtual = difference + minimumVirtual;
  const minimumRoundoff = minimumVirtual - minimum;
  const maximumRoundoff = maximum - maximumVirtual;
  return maximumRoundoff + minimumRoundoff >= 0;
}

function explicitFullWorldInterval(primitives: VisualPrimitive[]): LongitudeInterval | undefined {
  const intervals: LongitudeInterval[] = [];
  for (let primitiveIndex = 0; primitiveIndex < primitives.length; primitiveIndex += 1) {
    appendConnectedLongitudeIntervals(primitives[primitiveIndex], intervals);
  }
  if (intervals.length === 0) {
    return undefined;
  }
  intervals.sort((first, second) => first.minimum - second.minimum || first.maximum - second.maximum);

  let mergedMinimum = intervals[0].minimum;
  let mergedMaximum = intervals[0].maximum;
  for (let index = 1; index < intervals.length; index += 1) {
    const interval = intervals[index];
    if (interval.minimum <= mergedMaximum) {
      mergedMaximum = Math.max(mergedMaximum, interval.maximum);
    } else {
      if (differenceAtLeastFullCircle(mergedMaximum, mergedMinimum)) {
        return { minimum: mergedMinimum, maximum: mergedMaximum };
      }
      mergedMinimum = interval.minimum;
      mergedMaximum = interval.maximum;
    }
  }
  return differenceAtLeastFullCircle(mergedMaximum, mergedMinimum)
    ? { minimum: mergedMinimum, maximum: mergedMaximum }
    : undefined;
}

function fullWorldWrapForInterval(interval: LongitudeInterval): WrapMetadata {
  return {
    wrapReference: interval.minimum + FULL_CIRCLE_DEGREES / 2,
    worldOffset: 0,
    wrapMode: 'full-world',
  };
}

function validateDeclaredWrap(primitives: VisualPrimitive[], wrap: WrapMetadata): EnvelopeResult<true> {
  const fullWorldInterval = explicitFullWorldInterval(primitives);
  if (wrap.wrapMode === 'full-world') {
    if (fullWorldInterval === undefined) {
      return failure('error', 'full-world metadata requires source geometry spanning a complete 360-degree world');
    }
    const declaredReference = effectiveReference(wrap);
    if (
      declaredReference < fullWorldInterval.minimum - FULL_CIRCLE_DEGREES / 2 - FULL_WORLD_EPSILON_DEGREES ||
      declaredReference > fullWorldInterval.maximum + FULL_CIRCLE_DEGREES / 2 + FULL_WORLD_EPSILON_DEGREES
    ) {
      return failure('error', 'full-world wrap reference must share the source geometry world copy');
    }
    return { status: 'ok', value: true };
  }
  if (fullWorldInterval !== undefined) {
    return failure('error', 'minimum-arc metadata cannot describe complete 360-degree source geometry');
  }

  const longitudes: number[] = [];
  for (let index = 0; index < primitives.length; index += 1) {
    appendPrimitiveLongitudes(primitives[index], longitudes);
  }
  const declaredReference = effectiveReference(wrap);
  const minimumArc = chooseWrapFrame(longitudes, { previousReference: declaredReference });
  if (Math.abs(shortestAngle(minimumArc.wrapReference, declaredReference)) > FULL_WORLD_EPSILON_DEGREES) {
    return failure('error', 'minimum-arc wrap reference does not describe the primitive support');
  }
  return { status: 'ok', value: true };
}

function effectiveReference(wrap: WrapMetadata): number {
  return wrap.wrapReference + wrap.worldOffset * FULL_CIRCLE_DEGREES;
}

function unwrapLongitudeIntoFullWorldInterval(
  longitude: number,
  reference: number,
  interval: LongitudeInterval,
): number {
  const unwrapped = unwrapLongitude(longitude, reference);
  const minimumShift = Math.ceil((interval.minimum - unwrapped) / FULL_CIRCLE_DEGREES);
  const maximumShift = Math.floor((interval.maximum - unwrapped) / FULL_CIRCLE_DEGREES);
  if (minimumShift > maximumShift) {
    throw new RangeError('full-world anchor has no world copy inside the source geometry');
  }
  const worldShift = minimumShift > 0 ? minimumShift : maximumShift < 0 ? maximumShift : 0;
  const result = unwrapped + worldShift * FULL_CIRCLE_DEGREES;
  if (
    !Number.isFinite(result) ||
    result < interval.minimum - FULL_WORLD_EPSILON_DEGREES ||
    result > interval.maximum + FULL_WORLD_EPSILON_DEGREES
  ) {
    throw new RangeError('full-world anchor could not be normalized into the source geometry world copy');
  }
  return result;
}

function validateAnchorWrapCoherence(
  primitives: VisualPrimitive[],
  anchor: [number, number, number],
  wrap: WrapMetadata,
): EnvelopeResult<true> {
  if (wrap.wrapMode !== 'full-world') {
    return { status: 'ok', value: true };
  }
  const interval = explicitFullWorldInterval(primitives);
  if (
    interval === undefined ||
    anchor[0] < interval.minimum - FULL_WORLD_EPSILON_DEGREES ||
    anchor[0] > interval.maximum + FULL_WORLD_EPSILON_DEGREES
  ) {
    return failure('error', 'full-world anchor must share the primitive geometry world copy');
  }
  return { status: 'ok', value: true };
}

function isClosedLngLatRing(ring: LngLat[]): boolean {
  if (ring.length < 2) {
    return false;
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  return normalizeLongitude(first[0]) === normalizeLongitude(last[0]) && first[1] === last[1];
}

function isClosedWorldRing(ring: WorldPosition[]): boolean {
  if (ring.length < 2) {
    return false;
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  return normalizeLongitude(first[0]) === normalizeLongitude(last[0]) && first[1] === last[1];
}

function closureSpansFullWorld(firstLongitude: number, lastLongitude: number): boolean {
  return differenceAtLeastFullCircle(Math.max(firstLongitude, lastLongitude), Math.min(firstLongitude, lastLongitude));
}

function reframeLngLatPath(path: LngLat[], reference: number, closeRing: boolean): LngLat[] {
  const result: LngLat[] = new Array(path.length);
  let runningReference = reference;
  for (let index = 0; index < path.length; index += 1) {
    const position = path[index];
    const longitude = unwrapLongitude(position[0], runningReference);
    result[index] = [longitude, position[1]];
    runningReference = longitude;
  }
  if (
    closeRing &&
    result.length > 1 &&
    isClosedLngLatRing(path) &&
    !closureSpansFullWorld(result[0][0], result[result.length - 1][0])
  ) {
    result[result.length - 1][0] = result[0][0];
  }
  return result;
}

function reframeWorldPath(path: WorldPosition[], reference: number, closeRing: boolean): WorldPosition[] {
  const result: WorldPosition[] = new Array(path.length);
  let runningReference = reference;
  for (let index = 0; index < path.length; index += 1) {
    const position = path[index];
    const longitude = unwrapLongitude(position[0], runningReference);
    result[index] = position[2] === undefined ? [longitude, position[1]] : [longitude, position[1], position[2]];
    runningReference = longitude;
  }
  if (
    closeRing &&
    result.length > 1 &&
    isClosedWorldRing(path) &&
    !closureSpansFullWorld(result[0][0], result[result.length - 1][0])
  ) {
    result[result.length - 1][0] = result[0][0];
  }
  return result;
}

function reframePrimitiveBounded(primitive: VisualPrimitive, reference: number): VisualPrimitive {
  switch (primitive.kind) {
    case 'point-disc':
      return {
        ...primitive,
        position:
          primitive.position[2] === undefined
            ? [unwrapLongitude(primitive.position[0], reference), primitive.position[1]]
            : [unwrapLongitude(primitive.position[0], reference), primitive.position[1], primitive.position[2]],
      };
    case 'screen-rect':
      return {
        ...primitive,
        position:
          primitive.position[2] === undefined
            ? [unwrapLongitude(primitive.position[0], reference), primitive.position[1]]
            : [unwrapLongitude(primitive.position[0], reference), primitive.position[1], primitive.position[2]],
      };
    case 'extruded-footprint': {
      const rings: LngLat[][] = new Array(primitive.rings.length);
      for (let index = 0; index < primitive.rings.length; index += 1) {
        rings[index] = reframeLngLatPath(primitive.rings[index], reference, true);
      }
      return { ...primitive, rings };
    }
    case 'path-corridor':
      return { ...primitive, positions: reframeWorldPath(primitive.positions, reference, false) };
    case 'polygon': {
      const rings: WorldPosition[][] = new Array(primitive.rings.length);
      for (let index = 0; index < primitive.rings.length; index += 1) {
        rings[index] = reframeWorldPath(primitive.rings[index], reference, true);
      }
      return { ...primitive, rings };
    }
    case 'mesh-support': {
      const vertices: WorldPosition[] = new Array(primitive.vertices.length);
      for (let index = 0; index < primitive.vertices.length; index += 1) {
        const position = primitive.vertices[index];
        const longitude = unwrapLongitude(position[0], reference);
        vertices[index] = position[2] === undefined ? [longitude, position[1]] : [longitude, position[1], position[2]];
      }
      return { ...primitive, vertices };
    }
  }
}

function translateWorldPosition(position: WorldPosition, longitudeDelta: number): WorldPosition {
  return position[2] === undefined
    ? [position[0] + longitudeDelta, position[1]]
    : [position[0] + longitudeDelta, position[1], position[2]];
}

function translatePrimitive(primitive: VisualPrimitive, longitudeDelta: number): VisualPrimitive {
  switch (primitive.kind) {
    case 'point-disc':
      return { ...primitive, position: translateWorldPosition(primitive.position, longitudeDelta) };
    case 'screen-rect':
      return { ...primitive, position: translateWorldPosition(primitive.position, longitudeDelta) };
    case 'extruded-footprint': {
      const rings: LngLat[][] = new Array(primitive.rings.length);
      for (let ringIndex = 0; ringIndex < primitive.rings.length; ringIndex += 1) {
        const ring = primitive.rings[ringIndex];
        const translatedRing: LngLat[] = new Array(ring.length);
        for (let index = 0; index < ring.length; index += 1) {
          translatedRing[index] = [ring[index][0] + longitudeDelta, ring[index][1]];
        }
        rings[ringIndex] = translatedRing;
      }
      return { ...primitive, rings };
    }
    case 'path-corridor': {
      const positions: WorldPosition[] = new Array(primitive.positions.length);
      for (let index = 0; index < primitive.positions.length; index += 1) {
        positions[index] = translateWorldPosition(primitive.positions[index], longitudeDelta);
      }
      return { ...primitive, positions };
    }
    case 'polygon': {
      const rings: WorldPosition[][] = new Array(primitive.rings.length);
      for (let ringIndex = 0; ringIndex < primitive.rings.length; ringIndex += 1) {
        const ring = primitive.rings[ringIndex];
        const translatedRing: WorldPosition[] = new Array(ring.length);
        for (let index = 0; index < ring.length; index += 1) {
          translatedRing[index] = translateWorldPosition(ring[index], longitudeDelta);
        }
        rings[ringIndex] = translatedRing;
      }
      return { ...primitive, rings };
    }
    case 'mesh-support': {
      const vertices: WorldPosition[] = new Array(primitive.vertices.length);
      for (let index = 0; index < primitive.vertices.length; index += 1) {
        vertices[index] = translateWorldPosition(primitive.vertices[index], longitudeDelta);
      }
      return { ...primitive, vertices };
    }
  }
}

function reframePrimitivesBounded(primitives: VisualPrimitive[], reference: number): VisualPrimitive[] {
  const result: VisualPrimitive[] = new Array(primitives.length);
  for (let index = 0; index < primitives.length; index += 1) {
    result[index] = reframePrimitiveBounded(primitives[index], reference);
  }
  return result;
}

function translatePrimitives(primitives: VisualPrimitive[], longitudeDelta: number): VisualPrimitive[] {
  const result: VisualPrimitive[] = new Array(primitives.length);
  for (let index = 0; index < primitives.length; index += 1) {
    result[index] = translatePrimitive(primitives[index], longitudeDelta);
  }
  return result;
}

function semanticRevision(input: {
  provenance: TargetProvenance;
  supportGuarantee: SupportGuarantee;
  wrap: WrapMetadata;
  primitives: VisualPrimitive[];
  anchor: [number, number, number];
  metrics: ContentMetrics;
  revisionDependencies?: readonly string[];
}): string {
  return digestCanonical({
    provenance: input.provenance,
    supportGuarantee: input.supportGuarantee,
    wrap: input.wrap,
    primitives: input.primitives,
    anchor: input.anchor,
    metrics: input.metrics,
    ...(input.revisionDependencies === undefined ? {} : { revisionDependencies: input.revisionDependencies }),
  });
}

function cloneRevisionDependencies(value: readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const result = value.slice();
  Object.freeze(result);
  return result;
}

function validateRevisionDependencies(value: unknown): EnvelopeResult<true> {
  if (value === undefined) return { status: 'ok', value: true };
  if (!Array.isArray(value) || value.length === 0) {
    return failure('error', 'snapshot envelope revisionDependencies must be a nonempty array');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (
      typeof key !== 'string' ||
      !Number.isInteger(Number(key)) ||
      Number(key) < 0 ||
      Number(key) >= value.length ||
      String(Number(key)) !== key
    ) {
      return failure('error', 'snapshot envelope revisionDependencies must be a dense data array');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return failure('error', 'snapshot envelope revisionDependencies must be a dense data array');
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return failure('error', 'snapshot envelope revisionDependencies must be a dense data array');
    }
    if (!isNonBlankString(descriptor.value)) {
      return failure('error', `snapshot envelope revisionDependencies ${index} must be a non-blank string`);
    }
  }
  return { status: 'ok', value: true };
}

function buildOwnedSnapshot(input: {
  id: string;
  supportGuarantee: SupportGuarantee;
  provenance: TargetProvenance;
  primitives: VisualPrimitive[];
  anchor: [number, number, number];
  metrics: ContentMetrics;
  wrap: WrapMetadata;
  revisionDependencies?: readonly string[];
}): SnapshotEnvelope {
  const provenance = cloneProvenance(input.provenance);
  const primitives = clonePrimitives(input.primitives);
  const anchor = cloneAnchor(input.anchor);
  const metrics = cloneMetrics(input.metrics);
  const wrap = cloneWrap(input.wrap);
  const revisionDependencies = cloneRevisionDependencies(input.revisionDependencies);
  const frame: VisualTargetFrame = { primitives, anchor, metrics, wrap };
  Object.freeze(frame);
  const revision = semanticRevision({
    provenance,
    supportGuarantee: input.supportGuarantee,
    wrap,
    primitives,
    anchor,
    metrics,
    revisionDependencies,
  });
  const envelope: SnapshotEnvelope = {
    binding: 'snapshot',
    id: input.id,
    supportGuarantee: input.supportGuarantee,
    provenance,
    ...(revisionDependencies === undefined ? {} : { revisionDependencies }),
    revision,
    frame,
  };
  Object.freeze(envelope);
  return envelope;
}

function validateEnvelopeMetadata(input: {
  id: unknown;
  supportGuarantee: unknown;
  provenance: unknown;
  anchor: unknown;
  metrics: unknown;
  wrap: unknown;
}): EnvelopeResult<true> {
  const validations: Array<() => EnvelopeResult<true>> = [
    () => validateId(input.id),
    () => validateSupportGuarantee(input.supportGuarantee),
    () => validateProvenance(input.provenance),
    () => validateAnchor(input.anchor),
    () => validateMetrics(input.metrics),
    () => validateWrapMetadata(input.wrap),
  ];
  for (const validate of validations) {
    const validation = validate();
    if (validation.status !== 'ok') {
      return validation;
    }
  }
  return { status: 'ok', value: true };
}

function validateEnvelopeSemantics(input: {
  id: unknown;
  supportGuarantee: unknown;
  provenance: unknown;
  primitives: unknown;
  anchor: unknown;
  metrics: unknown;
  wrap: unknown;
}): EnvelopeResult<true> {
  const metadataValidation = validateEnvelopeMetadata(input);
  if (metadataValidation.status !== 'ok') {
    return metadataValidation;
  }
  const primitiveValidation = validatePrimitives(input.primitives);
  if (primitiveValidation.status !== 'ok') {
    return primitiveValidation;
  }
  const guaranteeValidation = validateGuaranteeForPrimitives(
    input.supportGuarantee as SupportGuarantee,
    input.primitives as VisualPrimitive[],
  );
  if (guaranteeValidation.status !== 'ok') {
    return guaranteeValidation;
  }
  try {
    const wrapValidation = validateDeclaredWrap(input.primitives as VisualPrimitive[], input.wrap as WrapMetadata);
    if (wrapValidation.status !== 'ok') {
      return wrapValidation;
    }
    return validateAnchorWrapCoherence(
      input.primitives as VisualPrimitive[],
      input.anchor as [number, number, number],
      input.wrap as WrapMetadata,
    );
  } catch (error) {
    return failure('error', error instanceof Error ? error.message : 'failed to validate snapshot envelope wrap');
  }
}

export function createSnapshotEnvelope(input: SnapshotEnvelopeInput): EnvelopeResult<SnapshotEnvelope> {
  const inputSchemaValidation = validateExactObjectSchema(input, SNAPSHOT_INPUT_SCHEMA, 'snapshot envelope input');
  if (inputSchemaValidation.status !== 'ok') {
    return inputSchemaValidation;
  }

  const dependencyValidation = validateRevisionDependencies(input.revisionDependencies);
  if (dependencyValidation.status !== 'ok') {
    return dependencyValidation;
  }

  const primitiveValidation = validatePrimitives(input.primitives);
  if (primitiveValidation.status !== 'ok') {
    return primitiveValidation;
  }
  const longitudes: number[] = [];
  for (let index = 0; index < input.primitives.length; index += 1) {
    appendPrimitiveLongitudes(input.primitives[index], longitudes);
  }
  let wrap: WrapMetadata;
  try {
    if (input.wrap !== undefined) {
      wrap = input.wrap;
    } else {
      const fullWorldInterval = explicitFullWorldInterval(input.primitives);
      wrap =
        fullWorldInterval === undefined ? chooseWrapFrame(longitudes) : fullWorldWrapForInterval(fullWorldInterval);
    }
  } catch (error) {
    return failure('error', error instanceof Error ? error.message : 'failed to choose a wrap frame');
  }

  const validation = validateEnvelopeMetadata({
    id: input.id,
    supportGuarantee: input.supportGuarantee,
    provenance: input.provenance,
    anchor: input.anchor,
    metrics: input.metrics,
    wrap,
  });
  if (validation.status !== 'ok') {
    return validation;
  }
  const guaranteeValidation = validateGuaranteeForPrimitives(input.supportGuarantee, input.primitives);
  if (guaranteeValidation.status !== 'ok') {
    return guaranteeValidation;
  }
  if (input.wrap !== undefined) {
    try {
      const declaredWrapValidation = validateDeclaredWrap(input.primitives, wrap);
      if (declaredWrapValidation.status !== 'ok') {
        return declaredWrapValidation;
      }
    } catch (error) {
      return failure('error', error instanceof Error ? error.message : 'failed to validate snapshot envelope wrap');
    }
  }

  try {
    if (wrap.wrapMode === 'full-world') {
      const fullWorldInterval = explicitFullWorldInterval(input.primitives);
      if (fullWorldInterval === undefined) {
        return failure('error', 'full-world snapshot requires a complete connected longitude span');
      }
      const anchorLongitude = unwrapLongitudeIntoFullWorldInterval(
        input.anchor[0],
        effectiveReference(wrap),
        fullWorldInterval,
      );
      return {
        status: 'ok',
        value: buildOwnedSnapshot({
          ...input,
          wrap,
          primitives: input.primitives,
          anchor: [anchorLongitude, input.anchor[1], input.anchor[2]],
        }),
      };
    }
    const reference = effectiveReference(wrap);
    const primitives = reframePrimitivesBounded(input.primitives, reference);
    const sequentialFullWorldInterval = explicitFullWorldInterval(primitives);
    if (sequentialFullWorldInterval !== undefined) {
      if (input.wrap !== undefined) {
        return failure('error', 'minimum-arc metadata cannot describe complete 360-degree source geometry');
      }
      const promotedWrap = fullWorldWrapForInterval(sequentialFullWorldInterval);
      const anchorLongitude = unwrapLongitudeIntoFullWorldInterval(
        input.anchor[0],
        effectiveReference(promotedWrap),
        sequentialFullWorldInterval,
      );
      return {
        status: 'ok',
        value: buildOwnedSnapshot({
          ...input,
          wrap: promotedWrap,
          primitives,
          anchor: [anchorLongitude, input.anchor[1], input.anchor[2]],
        }),
      };
    }
    const anchorLongitude = unwrapLongitude(input.anchor[0], reference);
    return {
      status: 'ok',
      value: buildOwnedSnapshot({
        ...input,
        wrap,
        primitives,
        anchor: [anchorLongitude, input.anchor[1], input.anchor[2]],
      }),
    };
  } catch (error) {
    return failure('error', error instanceof Error ? error.message : 'failed to construct snapshot envelope');
  }
}

export function validateSnapshotEnvelope(envelope: SnapshotEnvelope): EnvelopeResult<true> {
  const envelopeSchemaValidation = validateExactObjectSchema(envelope, SNAPSHOT_ENVELOPE_SCHEMA, 'snapshot envelope');
  if (envelopeSchemaValidation.status !== 'ok') {
    return envelopeSchemaValidation;
  }
  if ((envelope as Partial<SnapshotEnvelope>).binding !== 'snapshot') {
    return failure('error', 'snapshot envelope binding must be snapshot');
  }
  const dependencyValidation = validateRevisionDependencies(envelope.revisionDependencies);
  if (dependencyValidation.status !== 'ok') {
    return dependencyValidation;
  }
  if (typeof envelope.revision !== 'string' || !DIGEST_PATTERN.test(envelope.revision)) {
    return failure('error', 'snapshot envelope revision must be a canonical digest');
  }
  const frameSchemaValidation = validateExactObjectSchema(
    envelope.frame,
    TARGET_FRAME_SCHEMA,
    'snapshot envelope frame',
  );
  if (frameSchemaValidation.status !== 'ok') {
    return frameSchemaValidation;
  }

  const validation = validateEnvelopeSemantics({
    id: envelope.id,
    supportGuarantee: envelope.supportGuarantee,
    provenance: envelope.provenance,
    primitives: envelope.frame.primitives,
    anchor: envelope.frame.anchor,
    metrics: envelope.frame.metrics,
    wrap: envelope.frame.wrap,
  });
  if (validation.status !== 'ok') {
    return validation;
  }

  let expectedRevision: string;
  try {
    expectedRevision = semanticRevision({
      provenance: envelope.provenance,
      supportGuarantee: envelope.supportGuarantee,
      wrap: envelope.frame.wrap,
      primitives: envelope.frame.primitives,
      anchor: envelope.frame.anchor,
      metrics: envelope.frame.metrics,
      revisionDependencies: envelope.revisionDependencies,
    });
  } catch (error) {
    return failure('error', error instanceof Error ? error.message : 'failed to validate snapshot envelope revision');
  }
  if (expectedRevision !== envelope.revision) {
    return failure('error', 'snapshot envelope revision does not match its semantic content');
  }
  return { status: 'ok', value: true };
}

function canonicalBoundedUnionWrap(longitudes: number[]): WrapMetadata {
  const initial = chooseWrapFrame(longitudes);
  const oppositeTieCandidate = chooseWrapFrame(longitudes, {
    previousReference: initial.wrapReference - FULL_CIRCLE_DEGREES / 2,
  });
  const base = oppositeTieCandidate.wrapReference < initial.wrapReference ? oppositeTieCandidate : initial;
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index < longitudes.length; index += 1) {
    minimum = Math.min(minimum, unwrapLongitude(longitudes[index], base.wrapReference));
  }
  // The minimum-arc helper canonically chooses the circular seam. Canonicalize
  // its integral world copy as well by placing the support's lower edge in
  // [-180, 180); this keeps antimeridian unions in [179..., 180...] without
  // making the result depend on child order or input world copies.
  const worldShift = -Math.floor((minimum + 180) / FULL_CIRCLE_DEGREES);
  return {
    wrapReference: base.wrapReference + worldShift * FULL_CIRCLE_DEGREES,
    worldOffset: 0,
    wrapMode: 'minimum-arc',
  };
}

function nearestIntegralShiftToZero(effectiveWrapReference: number): number {
  const ideal = -effectiveWrapReference / FULL_CIRCLE_DEGREES;
  const lower = Math.floor(ideal);
  const upper = Math.ceil(ideal);
  const lowerDistance = Math.abs(ideal - lower);
  const upperDistance = Math.abs(upper - ideal);
  return lowerDistance <= upperDistance ? lower : upper;
}

function canonicalFullWorldFrame(envelopes: SnapshotEnvelope[]): FullWorldUnionFrame {
  let selected: LongitudeInterval | undefined;
  const childIntervals: Array<LongitudeInterval | undefined> = new Array(envelopes.length);
  for (let index = 0; index < envelopes.length; index += 1) {
    const envelope = envelopes[index];
    if (envelope.frame.wrap.wrapMode !== 'full-world') {
      continue;
    }
    const sourceInterval = explicitFullWorldInterval(envelope.frame.primitives);
    if (sourceInterval === undefined) {
      throw new RangeError(`full-world child ${index} has no complete geometry interval`);
    }
    childIntervals[index] = sourceInterval;
    const worldShift = nearestIntegralShiftToZero(sourceInterval.minimum + FULL_CIRCLE_DEGREES / 2);
    const longitudeDelta = worldShift * FULL_CIRCLE_DEGREES;
    const candidate = {
      minimum: sourceInterval.minimum + longitudeDelta,
      maximum: sourceInterval.maximum + longitudeDelta,
    };
    if (
      selected === undefined ||
      candidate.minimum < selected.minimum ||
      (candidate.minimum === selected.minimum && candidate.maximum < selected.maximum)
    ) {
      selected = candidate;
    }
  }
  if (selected === undefined) {
    throw new RangeError('full-world union requires a complete geometry interval');
  }
  return { interval: selected, childIntervals };
}

function nearestIntegralShift(sourceLongitude: number, targetLongitude: number): number {
  const directDifference = targetLongitude - sourceLongitude;
  const idealShift = Number.isFinite(directDifference)
    ? directDifference / FULL_CIRCLE_DEGREES
    : targetLongitude / FULL_CIRCLE_DEGREES - sourceLongitude / FULL_CIRCLE_DEGREES;
  const lower = Math.floor(idealShift);
  const upper = Math.ceil(idealShift);
  const lowerDistance = idealShift - lower;
  const upperDistance = upper - idealShift;
  return lowerDistance <= upperDistance ? lower : upper;
}

function reframeChild(
  envelope: SnapshotEnvelope,
  unionWrap: WrapMetadata,
  fullWorldInterval?: LongitudeInterval,
  childFullWorldInterval?: LongitudeInterval,
): ReframedChild {
  if (unionWrap.wrapMode === 'full-world') {
    if (fullWorldInterval === undefined) {
      throw new RangeError('full-world union is missing its shared geometry interval');
    }
    if (envelope.frame.wrap.wrapMode !== 'full-world') {
      const reference = fullWorldInterval.minimum + FULL_CIRCLE_DEGREES / 2;
      return {
        primitives: reframePrimitivesBounded(envelope.frame.primitives, reference),
        anchor: [
          unwrapLongitude(envelope.frame.anchor[0], reference),
          envelope.frame.anchor[1],
          envelope.frame.anchor[2],
        ],
      };
    }
    if (childFullWorldInterval === undefined) {
      throw new RangeError('full-world child is missing its complete geometry interval');
    }
    const worldShift = nearestIntegralShift(childFullWorldInterval.minimum, fullWorldInterval.minimum);
    const longitudeDelta = worldShift * FULL_CIRCLE_DEGREES;
    return {
      primitives: translatePrimitives(envelope.frame.primitives, longitudeDelta),
      anchor: [envelope.frame.anchor[0] + longitudeDelta, envelope.frame.anchor[1], envelope.frame.anchor[2]],
    };
  }

  const reference = effectiveReference(unionWrap);
  return {
    primitives: reframePrimitivesBounded(envelope.frame.primitives, reference),
    anchor: [unwrapLongitude(envelope.frame.anchor[0], reference), envelope.frame.anchor[1], envelope.frame.anchor[2]],
  };
}

function reframeChildren(
  envelopes: SnapshotEnvelope[],
  unionWrap: WrapMetadata,
  fullWorldFrame?: FullWorldUnionFrame,
): { primitives: VisualPrimitive[]; anchors: Array<[number, number, number]> } {
  const primitives: VisualPrimitive[] = [];
  const anchors: Array<[number, number, number]> = new Array(envelopes.length);
  for (let index = 0; index < envelopes.length; index += 1) {
    const reframed = reframeChild(
      envelopes[index],
      unionWrap,
      fullWorldFrame?.interval,
      fullWorldFrame?.childIntervals[index],
    );
    anchors[index] = reframed.anchor;
    for (let primitiveIndex = 0; primitiveIndex < reframed.primitives.length; primitiveIndex += 1) {
      primitives.push(reframed.primitives[primitiveIndex]);
    }
  }
  return { primitives, anchors };
}

function translateReframedChildren(
  children: ReturnType<typeof reframeChildren>,
  longitudeDelta: number,
): ReturnType<typeof reframeChildren> {
  const anchors: Array<[number, number, number]> = new Array(children.anchors.length);
  for (let index = 0; index < children.anchors.length; index += 1) {
    const anchor = children.anchors[index];
    anchors[index] = [anchor[0] + longitudeDelta, anchor[1], anchor[2]];
  }
  return {
    primitives: translatePrimitives(children.primitives, longitudeDelta),
    anchors,
  };
}

const CANONICAL_WEIGHT_SIGNIFICAND_BITS = 40;
const CANONICAL_WEIGHT_MANTISSA_SCALE = 2 ** (CANONICAL_WEIGHT_SIGNIFICAND_BITS - 1);
const MIN_NORMAL_NUMBER = 2 ** -1022;
const WEIGHT_EXPONENT_BUFFER = new ArrayBuffer(8);
const WEIGHT_EXPONENT_VIEW = new DataView(WEIGHT_EXPONENT_BUFFER);

interface CompensatedSum {
  sum: number;
  correction: number;
}

function addCompensated(accumulator: CompensatedSum, value: number): void {
  const next = accumulator.sum + value;
  if (Math.abs(accumulator.sum) >= Math.abs(value)) {
    accumulator.correction += accumulator.sum - next + value;
  } else {
    accumulator.correction += value - next + accumulator.sum;
  }
  accumulator.sum = next;
}

function roundToNearestEven(value: number): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (fraction < 0.5) {
    return lower;
  }
  if (fraction > 0.5) {
    return lower + 1;
  }
  return lower % 2 === 0 ? lower : lower + 1;
}

function canonicalizeRelativeWeight(weight: number, maximumWeight: number): number {
  const normalized = weight / maximumWeight;
  if (normalized === 0 || normalized < MIN_NORMAL_NUMBER) {
    // A subnormal-relative quantization grid may itself underflow. Keeping the
    // representable ratio verbatim avoids introducing a positive-weight cutoff.
    return normalized;
  }

  WEIGHT_EXPONENT_VIEW.setFloat64(0, normalized, false);
  const high = WEIGHT_EXPONENT_VIEW.getUint32(0, false);
  const exponent = ((high >>> 20) & 0x7ff) - 1023;
  const exponentScale = 2 ** exponent;
  const mantissa = normalized / exponentScale;

  // A 40-significant-bit binary ratio leaves thirteen rounding guard bits beneath
  // the IEEE-754 significand. It absorbs ordinary final-bit scale/division
  // jitter without a fixed absolute cutoff: every representable positive ratio
  // stays positive. Normal-ratio relative error is strictly below 2^-39.
  // Non-negative ratios keep the centroid in the shared-frame anchor hull;
  // geometry and wrap selection are intentionally independent of them.
  const canonicalMantissa =
    roundToNearestEven(mantissa * CANONICAL_WEIGHT_MANTISSA_SCALE) / CANONICAL_WEIGHT_MANTISSA_SCALE;
  return canonicalMantissa * exponentScale;
}

function weightedComponent(
  anchors: Array<[number, number, number]>,
  normalizedWeights: number[],
  component: 0 | 1 | 2,
  denominator: number,
): number {
  let maximumMagnitude = 0;
  for (let index = 0; index < anchors.length; index += 1) {
    if (normalizedWeights[index] > 0) {
      maximumMagnitude = Math.max(maximumMagnitude, Math.abs(anchors[index][component]));
    }
  }
  if (maximumMagnitude === 0) {
    return 0;
  }

  const numerator: CompensatedSum = { sum: 0, correction: 0 };
  for (let index = 0; index < anchors.length; index += 1) {
    const weight = normalizedWeights[index];
    if (weight > 0) {
      addCompensated(numerator, weight * (anchors[index][component] / maximumMagnitude));
    }
  }
  const normalizedMean = (numerator.sum + numerator.correction) / denominator;
  return Math.max(-1, Math.min(1, normalizedMean)) * maximumMagnitude;
}

function weightedCentroid(
  anchors: Array<[number, number, number]>,
  weights: number[],
): EnvelopeResult<[number, number, number]> {
  let maximumWeight = 0;
  for (let index = 0; index < weights.length; index += 1) {
    const weight = weights[index];
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      return failure('error', `snapshot envelope anchor weight ${index} must be finite and non-negative`);
    }
    maximumWeight = Math.max(maximumWeight, weight);
  }
  if (maximumWeight <= 0) {
    return failure('error', 'snapshot envelope anchor weights must contain a positive value');
  }

  const normalizedWeights: number[] = new Array(weights.length);
  const denominatorAccumulator: CompensatedSum = { sum: 0, correction: 0 };
  for (let index = 0; index < weights.length; index += 1) {
    const normalized = canonicalizeRelativeWeight(weights[index], maximumWeight);
    normalizedWeights[index] = normalized;
    addCompensated(denominatorAccumulator, normalized);
  }
  const denominator = denominatorAccumulator.sum + denominatorAccumulator.correction;
  if (!Number.isFinite(denominator) || denominator <= 0) {
    return failure('error', 'snapshot envelope anchor weight sum is not finite and positive');
  }

  const result: [number, number, number] = [
    weightedComponent(anchors, normalizedWeights, 0, denominator),
    weightedComponent(anchors, normalizedWeights, 1, denominator),
    weightedComponent(anchors, normalizedWeights, 2, denominator),
  ];
  for (let index = 0; index < result.length; index += 1) {
    if (!Number.isFinite(result[index])) {
      return failure('error', `snapshot envelope weighted anchor component ${index} is not finite`);
    }
  }
  if (Math.abs(result[1]) > MERCATOR_LATITUDE_LIMIT) {
    return failure('unsupported', `Mercator latitude ${result[1]} exceeds ${MERCATOR_LATITUDE_LIMIT}`);
  }
  return { status: 'ok', value: result };
}

type UnionSourceField = 'datasetId' | 'visualizationId' | 'layerId' | 'dataRevision' | 'visualizationRevision';

function unionSourceField(envelopes: SnapshotEnvelope[], field: UnionSourceField): string {
  const first = envelopes[0].provenance[field];
  let allAgree = true;
  const valuesInChildOrder: string[] = new Array(envelopes.length);
  for (let index = 0; index < envelopes.length; index += 1) {
    const value = envelopes[index].provenance[field];
    valuesInChildOrder[index] = value;
    if (value !== first) {
      allAgree = false;
    }
  }
  return allAgree ? first : `union:${digestCanonical({ schema: UNION_SCHEMA, field, valuesInChildOrder })}`;
}

function unionProvenance(envelopes: SnapshotEnvelope[]): TargetProvenance {
  return {
    datasetId: unionSourceField(envelopes, 'datasetId'),
    visualizationId: unionSourceField(envelopes, 'visualizationId'),
    layerId: unionSourceField(envelopes, 'layerId'),
    dataRevision: unionSourceField(envelopes, 'dataRevision'),
    visualizationRevision: unionSourceField(envelopes, 'visualizationRevision'),
    producerId: 'envelope-union',
    producerVersion: UNION_PRODUCER_VERSION,
    sceneRevision: envelopes[0].provenance.sceneRevision,
    resolvedLayerDigest: `union:${digestCanonical({
      schema: UNION_SCHEMA,
      children: envelopes.map(({ provenance, revision }) => ({ provenance, revision })),
    })}`,
  };
}

function unionGuarantee(envelopes: SnapshotEnvelope[]): SupportGuarantee {
  let result: SupportGuarantee = 'renderer-exact';
  for (let index = 0; index < envelopes.length; index += 1) {
    const guarantee = envelopes[index].supportGuarantee;
    if (guarantee === 'legacy-approximation') {
      return 'legacy-approximation';
    }
    if (guarantee === 'conservative') {
      result = 'conservative';
    }
  }
  return result;
}

export function mergeSnapshotEnvelopes(input: {
  id: string;
  envelopes: SnapshotEnvelope[];
  anchorWeights: number[];
  metrics: ContentMetrics;
}): EnvelopeResult<SnapshotEnvelope> {
  const inputSchemaValidation = validateExactObjectSchema(input, UNION_INPUT_SCHEMA, 'snapshot envelope union input');
  if (inputSchemaValidation.status !== 'ok') {
    return inputSchemaValidation;
  }
  const idValidation = validateId(input.id);
  if (idValidation.status !== 'ok') {
    return idValidation;
  }
  if (!Array.isArray(input.envelopes) || input.envelopes.length === 0) {
    return failure('error', 'snapshot envelope union requires at least one child');
  }
  if (!Array.isArray(input.anchorWeights) || input.anchorWeights.length !== input.envelopes.length) {
    return failure('error', 'snapshot envelope union requires exactly one anchor weight per child');
  }
  const metricsValidation = validateMetrics(input.metrics);
  if (metricsValidation.status !== 'ok') {
    return metricsValidation;
  }

  const sceneRevision = input.envelopes[0]?.provenance?.sceneRevision;
  for (let index = 0; index < input.envelopes.length; index += 1) {
    const validation = validateSnapshotEnvelope(input.envelopes[index]);
    if (validation.status !== 'ok') {
      return failure(validation.status, `snapshot envelope child ${index}: ${validation.reason}`);
    }
    if (input.envelopes[index].provenance.sceneRevision !== sceneRevision) {
      return failure('error', 'snapshot envelope union children must share one sceneRevision');
    }
  }

  const hasFullWorldChild = input.envelopes.some((envelope) => envelope.frame.wrap.wrapMode === 'full-world');
  let unionWrap: WrapMetadata;
  let fullWorldFrame: FullWorldUnionFrame | undefined;
  if (hasFullWorldChild) {
    unionWrap = { wrapReference: 0, worldOffset: 0, wrapMode: 'full-world' };
    try {
      fullWorldFrame = canonicalFullWorldFrame(input.envelopes);
    } catch (error) {
      return failure('error', error instanceof Error ? error.message : 'failed to choose full-world union interval');
    }
  } else {
    const longitudes: number[] = [];
    for (let envelopeIndex = 0; envelopeIndex < input.envelopes.length; envelopeIndex += 1) {
      const primitives = input.envelopes[envelopeIndex].frame.primitives;
      for (let primitiveIndex = 0; primitiveIndex < primitives.length; primitiveIndex += 1) {
        appendPrimitiveLongitudes(primitives[primitiveIndex], longitudes);
      }
    }
    try {
      unionWrap = canonicalBoundedUnionWrap(longitudes);
    } catch (error) {
      return failure('error', error instanceof Error ? error.message : 'failed to choose union wrap frame');
    }
  }

  let reframedChildren: ReturnType<typeof reframeChildren>;
  try {
    reframedChildren = reframeChildren(input.envelopes, unionWrap, fullWorldFrame);
    const collectiveFullWorldInterval = explicitFullWorldInterval(reframedChildren.primitives);
    if (!hasFullWorldChild && collectiveFullWorldInterval !== undefined) {
      const collectiveReference = fullWorldWrapForInterval(collectiveFullWorldInterval).wrapReference;
      const collectiveWorldShift = nearestIntegralShiftToZero(collectiveReference);
      reframedChildren = translateReframedChildren(reframedChildren, collectiveWorldShift * FULL_CIRCLE_DEGREES);
      unionWrap = { wrapReference: 0, worldOffset: 0, wrapMode: 'full-world' };
      if (explicitFullWorldInterval(reframedChildren.primitives) === undefined) {
        return failure('error', 'failed to preserve collective full-world support in the canonical union frame');
      }
    }
  } catch (error) {
    return failure('error', error instanceof Error ? error.message : 'failed to reframe union support');
  }

  const centroid = weightedCentroid(reframedChildren.anchors, input.anchorWeights);
  if (centroid.status !== 'ok') {
    return centroid;
  }

  try {
    const envelope = buildOwnedSnapshot({
      id: input.id,
      supportGuarantee: unionGuarantee(input.envelopes),
      provenance: unionProvenance(input.envelopes),
      primitives: reframedChildren.primitives,
      anchor: centroid.value,
      metrics: input.metrics,
      wrap: unionWrap,
      revisionDependencies: input.envelopes.map((child) => `child-envelope:${child.revision}`),
    });
    const validation = validateSnapshotEnvelope(envelope);
    return validation.status === 'ok'
      ? { status: 'ok', value: envelope }
      : failure(validation.status, `constructed snapshot envelope union is invalid: ${validation.reason}`);
  } catch (error) {
    return failure('error', error instanceof Error ? error.message : 'failed to construct snapshot envelope union');
  }
}
