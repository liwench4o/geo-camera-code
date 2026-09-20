import { COORDINATE_SYSTEM, project, VERSION, WebMercatorViewport } from '@deck.gl/core';
import type { ProjectUniforms } from '@deck.gl/core';

import type { CameraView } from '../../interfaces';
import type { FootprintResult, ProjectedFootprint, ProjectionOptions, ScreenRect, ViewportSpec } from './types';
import { MERCATOR_LATITUDE_LIMIT, selectWorldOffset, validateMercatorSupport } from './geo-wrap';
import type {
  EnvelopeResult,
  LngLat,
  PixelClamp,
  UnitValue,
  VisualPrimitive,
  VisualTargetFrame,
  WorldPosition,
} from './types';

const TILE_SIZE = 512;
const EARTH_CIRCUMFERENCE_METERS = 40.03e6;
const DEGREES_TO_RADIANS = Math.PI / 180;
const WORLD_Y_SCALE = (2 * Math.PI) / TILE_SIZE;
const LIBM_RELATIVE_SAFETY_MARGIN = 1e-12;
const DECK_FLOAT_RELATIVE_SAFETY_MARGIN = 1e-5;
const DECK_FLOAT_ABSOLUTE_SAFETY_PX = 1e-6;
const PROJECTED_PIXEL_COMPUTATIONAL_MARGIN = 1e-6;
const PROJECTED_DEPTH_COMPUTATIONAL_MARGIN = 1e-12;
const DECK_LNGLAT_SHADER_COORDINATE_SYSTEM = 1;
const DECK_WEB_MERCATOR_MODE = 1;
const DECK_WEB_MERCATOR_AUTO_OFFSET_MODE = 4;
const SUPPORTED_DECK_RENDERER_VERSION = '9.3.2';
const MAX_CLAMP_WITNESS_INTERVAL_COST = 5;

type ProjectedVertex = [number, number, number];

interface ProjectionContext {
  viewport: WebMercatorViewport;
  pixelProjectionMatrix: number[];
  projectUniforms: ProjectUniforms;
}

interface Interval {
  min: number;
  max: number;
}

interface LocalMeterBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface IntervalProjection {
  x: Interval;
  y: Interval;
  depth: Interval;
}

interface MeterMapping {
  origin: WorldPosition;
  worldX: number;
  worldY: number;
  unitsPerMeter: number;
  unitsPerMeter2X: number;
}

interface RawCertifiedMeterBounds {
  resolution: 'raw-interval';
  bounds: ScreenRect;
  center: ProjectedVertex;
  billboardHalfWidthUpperPx: number;
}

interface MaxClampCertifiedMeterBounds {
  resolution: 'max-clamp-saturated';
  bounds: ScreenRect;
  center: ProjectedVertex;
  inflationPx: number;
}

type CertifiedMeterBounds = RawCertifiedMeterBounds | MaxClampCertifiedMeterBounds;

interface IntervalBudget {
  remaining: number;
}

const nextFloatBuffer = new ArrayBuffer(8);
const nextFloatView = new DataView(nextFloatBuffer);

function nextUp(value: number): number {
  if (Number.isNaN(value) || value === Number.POSITIVE_INFINITY) {
    return value;
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return -Number.MAX_VALUE;
  }
  if (value === 0) {
    return Number.MIN_VALUE;
  }

  nextFloatView.setFloat64(0, value, false);
  let high = nextFloatView.getUint32(0, false);
  let low = nextFloatView.getUint32(4, false);
  if (value > 0) {
    if (low === 0xffffffff) {
      low = 0;
      high += 1;
    } else {
      low += 1;
    }
  } else if (low === 0) {
    low = 0xffffffff;
    high -= 1;
  } else {
    low -= 1;
  }
  nextFloatView.setUint32(0, high, false);
  nextFloatView.setUint32(4, low, false);
  return nextFloatView.getFloat64(0, false);
}

function nextDown(value: number): number {
  return -nextUp(-value);
}

function expandInterval(value: Interval, margin: number): Interval {
  return {
    min: nextDown(value.min - margin),
    max: nextUp(value.max + margin),
  };
}

function pointInterval(value: number): Interval {
  return { min: value, max: value };
}

function intervalFromBounds(min: number, max: number): Interval {
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

function intervalAdd(first: Interval, second: Interval): Interval {
  return {
    min: nextDown(first.min + second.min),
    max: nextUp(first.max + second.max),
  };
}

function intervalMultiply(first: Interval, second: Interval): Interval {
  const products = [first.min * second.min, first.min * second.max, first.max * second.min, first.max * second.max];
  return {
    min: nextDown(Math.min(...products)),
    max: nextUp(Math.max(...products)),
  };
}

function intervalScale(value: Interval, scale: number): Interval {
  return intervalMultiply(value, pointInterval(scale));
}

function intervalDivide(numerator: Interval, denominator: Interval): Interval | null {
  if (denominator.min <= 0 || !isFiniteInterval(denominator)) {
    return null;
  }
  const reciprocal = {
    min: nextDown(1 / denominator.max),
    max: nextUp(1 / denominator.min),
  };
  return intervalMultiply(numerator, reciprocal);
}

function intervalCosh(value: Interval): Interval {
  const lowerMagnitude = value.min <= 0 && value.max >= 0 ? 0 : Math.min(Math.abs(value.min), Math.abs(value.max));
  const upperMagnitude = Math.max(Math.abs(value.min), Math.abs(value.max));
  const lower = Math.cosh(lowerMagnitude);
  const upper = Math.cosh(upperMagnitude);
  return {
    // ECMAScript does not mandate a correctly rounded libm. The projector and
    // interval evaluator share one runtime, and this explicit relative margin
    // is deliberately much wider than a few ULPs over the Mercator domain.
    min: nextDown(Math.max(0, lower * (1 - LIBM_RELATIVE_SAFETY_MARGIN) - LIBM_RELATIVE_SAFETY_MARGIN)),
    max: nextUp(upper * (1 + LIBM_RELATIVE_SAFETY_MARGIN) + LIBM_RELATIVE_SAFETY_MARGIN),
  };
}

function isFiniteInterval(value: Interval): boolean {
  return Number.isFinite(value.min) && Number.isFinite(value.max) && value.min <= value.max;
}

function failure(status: 'stale' | 'unavailable' | 'unsupported' | 'error', reason: string): EnvelopeResult<never> {
  return { status, reason };
}

function validateFiniteNonNegative(value: unknown, label: string): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return `${label} must be a finite non-negative number`;
  }
  return null;
}

function validateFiniteHeight(value: unknown, label: string): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${label} must be finite`;
  }
  return null;
}

function validateWorldPosition(position: unknown, label: string): string | null {
  if (!Array.isArray(position) || position.length < 2) {
    return `${label} must contain longitude and latitude`;
  }
  if (!Number.isFinite(position[0]) || !Number.isFinite(position[1])) {
    return `${label} longitude and latitude must be finite`;
  }
  if (position[2] !== undefined) {
    return validateFiniteHeight(position[2], `${label} height`);
  }
  return null;
}

function validateLngLat(position: unknown, label: string): string | null {
  if (!Array.isArray(position) || position.length < 2) {
    return `${label} must contain longitude and latitude`;
  }
  if (!Number.isFinite(position[0]) || !Number.isFinite(position[1])) {
    return `${label} longitude and latitude must be finite`;
  }
  return null;
}

function validateUnitValue(value: unknown, label: string): string | null {
  if (!value || typeof value !== 'object') {
    return `${label} must declare a value and unit`;
  }
  const unitValue = value as Partial<UnitValue>;
  const valueError = validateFiniteNonNegative(unitValue.value, `${label} value`);
  if (valueError) {
    return valueError;
  }
  if (unitValue.unit !== 'meters' && unitValue.unit !== 'pixels') {
    return `${label} unit must be meters or pixels`;
  }
  return null;
}

function validatePixelClamp(clamp: unknown, label: string): string | null {
  if (clamp === undefined) {
    return null;
  }
  if (!clamp || typeof clamp !== 'object') {
    return `${label} must be an object`;
  }
  const pixelClamp = clamp as PixelClamp;
  const entries: Array<[string, number | undefined]> = [
    ['minPx', pixelClamp.minPx],
    ['maxPx', pixelClamp.maxPx],
    ['supportBufferPx', pixelClamp.supportBufferPx],
  ];
  for (const [name, value] of entries) {
    if (value !== undefined) {
      const error = validateFiniteNonNegative(value, `${label}.${name}`);
      if (error) {
        return error;
      }
    }
  }
  if (pixelClamp.minPx !== undefined && pixelClamp.maxPx !== undefined && pixelClamp.minPx > pixelClamp.maxPx) {
    return `${label}.minPx must not exceed ${label}.maxPx`;
  }
  return null;
}

function validateSupportBuffer(value: unknown, label: string): string | null {
  return value === undefined ? null : validateFiniteNonNegative(value, label);
}

function validateRings(rings: unknown, withHeights: boolean, label: string): string | null {
  if (!Array.isArray(rings) || rings.length === 0) {
    return `${label} requires at least one ring`;
  }
  for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
    const ring = rings[ringIndex];
    if (!Array.isArray(ring) || ring.length === 0) {
      return `${label} ring ${ringIndex} must contain at least one vertex`;
    }
    for (let vertexIndex = 0; vertexIndex < ring.length; vertexIndex += 1) {
      const error = withHeights
        ? validateWorldPosition(ring[vertexIndex], `${label} ring ${ringIndex} vertex ${vertexIndex}`)
        : validateLngLat(ring[vertexIndex], `${label} ring ${ringIndex} vertex ${vertexIndex}`);
      if (error) {
        return error;
      }
    }
  }
  return null;
}

export function validateVisualPrimitive(primitive: VisualPrimitive): EnvelopeResult<true> {
  if (!primitive || typeof primitive !== 'object') {
    return failure('error', 'visual primitive must be an object');
  }

  let error: string | null = null;
  switch (primitive.kind) {
    case 'point-disc':
      error =
        validateWorldPosition(primitive.position, 'point-disc position') ??
        validateUnitValue(primitive.radius, 'point-disc radius') ??
        validatePixelClamp(primitive.pixelClamp, 'point-disc pixelClamp');
      break;
    case 'screen-rect':
      error =
        validateWorldPosition(primitive.position, 'screen-rect position') ??
        validateFiniteNonNegative(primitive.widthPx, 'screen-rect widthPx') ??
        validateFiniteNonNegative(primitive.heightPx, 'screen-rect heightPx') ??
        validateSupportBuffer(primitive.supportBufferPx, 'screen-rect supportBufferPx');
      break;
    case 'extruded-footprint': {
      error =
        validateRings(primitive.rings, false, 'extruded-footprint') ??
        validateFiniteHeight(primitive.baseMeters, 'extruded-footprint baseMeters') ??
        validateSupportBuffer(primitive.supportBufferPx, 'extruded-footprint supportBufferPx');
      if (error) {
        break;
      }
      const flattenedVertexCount = primitive.rings.reduce((count, ring) => count + ring.length, 0);
      if (Array.isArray(primitive.topMeters)) {
        if (primitive.topMeters.length !== flattenedVertexCount) {
          error = 'extruded-footprint topMeters array must match the flattened vertex count';
          break;
        }
        for (let index = 0; index < primitive.topMeters.length; index += 1) {
          error = validateFiniteHeight(primitive.topMeters[index], `extruded-footprint topMeters ${index}`);
          if (error) {
            break;
          }
        }
      } else {
        error = validateFiniteHeight(primitive.topMeters, 'extruded-footprint topMeters');
      }
      break;
    }
    case 'path-corridor':
      if (!Array.isArray(primitive.positions) || primitive.positions.length === 0) {
        error = 'path-corridor requires at least one position';
        break;
      }
      for (let index = 0; index < primitive.positions.length; index += 1) {
        error = validateWorldPosition(primitive.positions[index], `path-corridor position ${index}`);
        if (error) {
          break;
        }
      }
      error =
        error ??
        validateUnitValue(primitive.halfWidth, 'path-corridor halfWidth') ??
        validatePixelClamp(primitive.pixelClamp, 'path-corridor pixelClamp');
      break;
    case 'polygon':
      error =
        validateRings(primitive.rings, true, 'polygon') ??
        validateSupportBuffer(primitive.supportBufferPx, 'polygon supportBufferPx');
      break;
    case 'mesh-support':
      if (primitive.conservative !== true) {
        error = 'mesh-support must declare conservative: true';
        break;
      }
      if (!Array.isArray(primitive.vertices) || primitive.vertices.length === 0) {
        error = 'mesh-support requires at least one vertex';
        break;
      }
      for (let index = 0; index < primitive.vertices.length; index += 1) {
        error = validateWorldPosition(primitive.vertices[index], `mesh-support vertex ${index}`);
        if (error) {
          break;
        }
      }
      error = error ?? validateSupportBuffer(primitive.supportBufferPx, 'mesh-support supportBufferPx');
      break;
    default:
      error = 'unsupported visual primitive kind';
  }

  return error ? failure('error', error) : { status: 'ok', value: true };
}

function createProjectionContext(
  view: CameraView,
  viewport: ViewportSpec,
  options: ProjectionOptions,
): EnvelopeResult<ProjectionContext> {
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return failure('error', 'viewport width and height must be finite and positive');
  }
  const finiteViewEntries: Array<[string, number]> = [
    ['longitude', view.longitude],
    ['latitude', view.latitude],
    ['zoom', view.zoom],
    ['pitch', view.pitch],
    ['bearing', view.bearing],
  ];
  for (const [name, value] of finiteViewEntries) {
    if (!Number.isFinite(value)) {
      return failure('error', `view ${name} must be finite`);
    }
  }
  if (view.altitude !== undefined && (!Number.isFinite(view.altitude) || view.altitude <= 0)) {
    return failure('error', 'view altitude must be finite and positive');
  }
  const viewMercator = validateMercatorSupport([[view.longitude, view.latitude]]);
  if (viewMercator.status !== 'ok') {
    return viewMercator;
  }
  if (!Number.isFinite(options.meterSupportTolerancePx) || options.meterSupportTolerancePx <= 0) {
    return failure('error', 'meter support tolerance must be finite and positive');
  }
  if (!Number.isInteger(options.meterSupportIntervalBudget) || options.meterSupportIntervalBudget <= 0) {
    return failure('error', 'meter support interval budget must be a positive integer');
  }

  try {
    const deckViewport = new WebMercatorViewport({
      width: viewport.width,
      height: viewport.height,
      longitude: view.longitude,
      latitude: view.latitude,
      zoom: view.zoom,
      pitch: view.pitch,
      bearing: view.bearing,
      altitude: view.altitude,
    });
    const matrix = Array.from(deckViewport.pixelProjectionMatrix);
    if (matrix.length !== 16 || matrix.some((value) => !Number.isFinite(value))) {
      return failure('unsupported', 'viewport pixel projection matrix is non-finite');
    }
    const projectUniforms = project.getUniforms({
      viewport: deckViewport,
      coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
    }) as ProjectUniforms;
    return {
      status: 'ok',
      value: { viewport: deckViewport, pixelProjectionMatrix: matrix, projectUniforms },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failure('unsupported', `viewport projection could not be constructed: ${detail}`);
  }
}

function transformWorldToHomogeneous(
  matrix: number[],
  world: [number, number, number],
): [number, number, number, number] {
  const [x, y, z] = world;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15],
  ];
}

function projectWorldPosition(context: ProjectionContext, position: WorldPosition): EnvelopeResult<ProjectedVertex> {
  const mercator = validateMercatorSupport([[position[0], position[1]]]);
  if (mercator.status !== 'ok') {
    return mercator;
  }
  const height = position[2] ?? 0;
  if (!Number.isFinite(height)) {
    return failure('error', 'world position height must be finite');
  }

  try {
    const world = context.viewport.projectPosition([position[0], position[1], height]);
    if (world.length < 3 || world.some((value) => !Number.isFinite(value))) {
      return failure('unsupported', 'world projection produced a non-finite coordinate');
    }
    const homogeneous = transformWorldToHomogeneous(context.pixelProjectionMatrix, world);
    if (homogeneous.some((value) => !Number.isFinite(value)) || homogeneous[3] <= 0) {
      return failure('unsupported', 'homogeneous projection is non-finite or behind the camera');
    }
    const projected: ProjectedVertex = [
      homogeneous[0] / homogeneous[3],
      homogeneous[1] / homogeneous[3],
      homogeneous[2] / homogeneous[3],
    ];
    if (projected.some((value) => !Number.isFinite(value))) {
      return failure('unsupported', 'pixel projection produced a non-finite coordinate or depth');
    }
    if (projected[2] < -1 || projected[2] > 1) {
      return failure('unsupported', 'world position lies outside the near/far clip domain');
    }
    return { status: 'ok', value: projected };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failure('unsupported', `world position could not be projected: ${detail}`);
  }
}

function lngLatToWorld(longitude: number, latitude: number): [number, number] {
  const lambda = longitude * DEGREES_TO_RADIANS;
  const phi = latitude * DEGREES_TO_RADIANS;
  return [
    (TILE_SIZE * (lambda + Math.PI)) / (2 * Math.PI),
    (TILE_SIZE * (Math.PI + Math.log(Math.tan(Math.PI / 4 + phi / 2)))) / (2 * Math.PI),
  ];
}

const MERCATOR_WORLD_MIN_Y = lngLatToWorld(0, -MERCATOR_LATITUDE_LIMIT)[1];
const MERCATOR_WORLD_MAX_Y = lngLatToWorld(0, MERCATOR_LATITUDE_LIMIT)[1];

function buildMeterMapping(origin: WorldPosition): EnvelopeResult<MeterMapping> {
  const mercator = validateMercatorSupport([[origin[0], origin[1]]]);
  if (mercator.status !== 'ok') {
    return mercator;
  }
  const height = origin[2] ?? 0;
  if (!Number.isFinite(height)) {
    return failure('error', 'meter support origin height must be finite');
  }
  const [worldX, worldY] = lngLatToWorld(origin[0], origin[1]);
  const latitudeRadians = origin[1] * DEGREES_TO_RADIANS;
  const latitudeCosine = Math.cos(latitudeRadians);
  const unitsPerMeter = TILE_SIZE / EARTH_CIRCUMFERENCE_METERS / latitudeCosine;
  const latitudeCosine2 = (DEGREES_TO_RADIANS * Math.tan(latitudeRadians)) / latitudeCosine;
  const unitsPerDegreeY = TILE_SIZE / 360 / latitudeCosine;
  const altitudeUnitsPerDegree2 = (TILE_SIZE / EARTH_CIRCUMFERENCE_METERS) * latitudeCosine2;
  const unitsPerMeter2X = (altitudeUnitsPerDegree2 / unitsPerDegreeY) * unitsPerMeter;
  const values = [worldX, worldY, unitsPerMeter, unitsPerMeter2X];
  if (values.some((value) => !Number.isFinite(value))) {
    return failure('unsupported', 'meter support mapping is non-finite');
  }
  return {
    status: 'ok',
    value: { origin, worldX, worldY, unitsPerMeter, unitsPerMeter2X },
  };
}

function transformIntervalRow(
  matrix: number[],
  row: 0 | 1 | 2 | 3,
  worldX: Interval,
  worldY: Interval,
  worldZ: Interval,
): Interval {
  let result = pointInterval(matrix[12 + row]);
  result = intervalAdd(result, intervalScale(worldX, matrix[row]));
  result = intervalAdd(result, intervalScale(worldY, matrix[4 + row]));
  result = intervalAdd(result, intervalScale(worldZ, matrix[8 + row]));
  return result;
}

function transformIntervalRowAroundReference(
  matrix: number[],
  row: 0 | 1 | 2,
  referenceValue: number,
  worldX: Interval,
  worldY: Interval,
  worldZ: Interval,
): Interval {
  const coefficientDifference = (numeratorIndex: number, denominatorIndex: number): Interval =>
    intervalAdd(
      pointInterval(matrix[numeratorIndex]),
      intervalScale(pointInterval(matrix[denominatorIndex]), -referenceValue),
    );

  let result = coefficientDifference(12 + row, 15);
  result = intervalAdd(result, intervalMultiply(worldX, coefficientDifference(row, 3)));
  result = intervalAdd(result, intervalMultiply(worldY, coefficientDifference(4 + row, 7)));
  result = intervalAdd(result, intervalMultiply(worldZ, coefficientDifference(8 + row, 11)));
  return result;
}

function projectMeterBoxInterval(
  mapping: MeterMapping,
  box: LocalMeterBox,
  context: ProjectionContext,
): EnvelopeResult<IntervalProjection> {
  const x = intervalFromBounds(box.minX, box.maxX);
  const y = intervalFromBounds(box.minY, box.maxY);

  // This is the exact high-precision math.gl addMetersToLngLat polynomial in common world space:
  // X = X0 + x * (unitsPerMeter + unitsPerMeter2.x * y), Y = Y0 + unitsPerMeter * y.
  const worldX = intervalAdd(
    pointInterval(mapping.worldX),
    intervalMultiply(x, intervalAdd(pointInterval(mapping.unitsPerMeter), intervalScale(y, mapping.unitsPerMeter2X))),
  );
  const worldY = intervalAdd(pointInterval(mapping.worldY), intervalScale(y, mapping.unitsPerMeter));
  if (!isFiniteInterval(worldX) || !isFiniteInterval(worldY)) {
    return failure('unsupported', 'meter support world interval is non-finite');
  }
  if (worldY.min < MERCATOR_WORLD_MIN_Y || worldY.max > MERCATOR_WORLD_MAX_Y) {
    return failure('unsupported', 'meter support exceeds the Web Mercator latitude domain');
  }

  // worldToLngLat followed by unitsPerMeter(newLatitude) simplifies to cosh of Mercator Y.
  const mercatorArgument = intervalAdd(intervalScale(worldY, WORLD_Y_SCALE), pointInterval(-Math.PI));
  const unitsAtLatitude = intervalScale(intervalCosh(mercatorArgument), TILE_SIZE / EARTH_CIRCUMFERENCE_METERS);
  const worldZ = intervalScale(unitsAtLatitude, mapping.origin[2] ?? 0);
  if (!isFiniteInterval(worldZ)) {
    return failure('unsupported', 'meter support altitude interval is non-finite');
  }

  const homogeneousW = transformIntervalRow(context.pixelProjectionMatrix, 3, worldX, worldY, worldZ);
  if (!isFiniteInterval(homogeneousW)) {
    return failure('unsupported', 'meter support homogeneous interval is non-finite');
  }
  if (homogeneousW.min <= 0) {
    return failure('unsupported', 'meter support homogeneous w interval crosses zero or lies behind the camera');
  }

  const referenceOffset: [number, number, number] = [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, 0];
  const reference = projectMeterOffsetFromMapping(context, mapping, referenceOffset);
  if (reference.status !== 'ok') {
    return reference;
  }

  // For any finite reference r, H/W = r + (H - rW)/W. Form H - rW
  // symbolically at the matrix-coefficient level before interval evaluation;
  // subtracting already-independent H and W intervals would lose the shared
  // local-coordinate dependency that makes the quotient tight.
  const divideAroundReference = (row: 0 | 1 | 2, referenceValue: number): Interval | null => {
    const residual = transformIntervalRowAroundReference(
      context.pixelProjectionMatrix,
      row,
      referenceValue,
      worldX,
      worldY,
      worldZ,
    );
    if (!isFiniteInterval(residual)) {
      return null;
    }
    const quotient = intervalDivide(residual, homogeneousW);
    return quotient ? intervalAdd(pointInterval(referenceValue), quotient) : null;
  };
  const projectedXRaw = divideAroundReference(0, reference.value[0]);
  const projectedYRaw = divideAroundReference(1, reference.value[1]);
  const projectedDepthRaw = divideAroundReference(2, reference.value[2]);
  if (
    !projectedXRaw ||
    !projectedYRaw ||
    !projectedDepthRaw ||
    !isFiniteInterval(projectedXRaw) ||
    !isFiniteInterval(projectedYRaw) ||
    !isFiniteInterval(projectedDepthRaw)
  ) {
    return failure('unsupported', 'meter support projected interval is invalid');
  }
  // The interval path and the renderer-compatible point path associate a
  // cancellation-prone matrix quotient differently. A final-value ULP count is
  // not stable under that conditioning, so adapter v1 declares small absolute
  // forward-error envelopes in CSS pixels and NDC depth.
  const projectedX = expandInterval(projectedXRaw, PROJECTED_PIXEL_COMPUTATIONAL_MARGIN);
  const projectedY = expandInterval(projectedYRaw, PROJECTED_PIXEL_COMPUTATIONAL_MARGIN);
  const projectedDepth = expandInterval(projectedDepthRaw, PROJECTED_DEPTH_COMPUTATIONAL_MARGIN);
  if (projectedDepth.min < -1 || projectedDepth.max > 1) {
    return failure('unsupported', 'meter support interval crosses the near/far clip domain');
  }
  return { status: 'ok', value: { x: projectedX, y: projectedY, depth: projectedDepth } };
}

function projectMeterBoxIntervalWithinBudget(
  mapping: MeterMapping,
  box: LocalMeterBox,
  context: ProjectionContext,
  budget: IntervalBudget,
): EnvelopeResult<IntervalProjection> {
  if (budget.remaining <= 0) {
    return failure('unsupported', 'meter support interval budget exhausted before certification');
  }
  budget.remaining -= 1;
  return projectMeterBoxInterval(mapping, box, context);
}

function projectMeterOffsetFromMapping(
  context: ProjectionContext,
  mapping: MeterMapping,
  offset: [number, number, number],
): EnvelopeResult<ProjectedVertex> {
  if (offset.some((value) => !Number.isFinite(value))) {
    return failure('error', 'meter offset must be finite');
  }
  const [offsetX, offsetY, offsetZ] = offset;
  const worldX = mapping.worldX + offsetX * (mapping.unitsPerMeter + mapping.unitsPerMeter2X * offsetY);
  const worldY = mapping.worldY + offsetY * mapping.unitsPerMeter;
  if (
    !Number.isFinite(worldX) ||
    !Number.isFinite(worldY) ||
    worldY < MERCATOR_WORLD_MIN_Y ||
    worldY > MERCATOR_WORLD_MAX_Y
  ) {
    return failure('unsupported', 'meter offset exceeds the finite Web Mercator domain');
  }
  const height = (mapping.origin[2] ?? 0) + offsetZ;
  const unitsAtLatitude = (TILE_SIZE / EARTH_CIRCUMFERENCE_METERS) * Math.cosh(worldY * WORLD_Y_SCALE - Math.PI);
  const worldZ = height * unitsAtLatitude;
  const homogeneous = transformWorldToHomogeneous(context.pixelProjectionMatrix, [worldX, worldY, worldZ]);
  if (homogeneous.some((value) => !Number.isFinite(value)) || homogeneous[3] <= 0) {
    return failure('unsupported', 'meter offset homogeneous projection is non-finite or behind the camera');
  }
  const projected: ProjectedVertex = [
    homogeneous[0] / homogeneous[3],
    homogeneous[1] / homogeneous[3],
    homogeneous[2] / homogeneous[3],
  ];
  if (projected.some((value) => !Number.isFinite(value))) {
    return failure('unsupported', 'meter offset pixel projection is non-finite');
  }
  if (projected[2] < -1 || projected[2] > 1) {
    return failure('unsupported', 'meter offset lies outside the near/far clip domain');
  }
  return { status: 'ok', value: projected };
}

function projectMeterOffset(
  context: ProjectionContext,
  origin: WorldPosition,
  offset: [number, number, number],
): EnvelopeResult<ProjectedVertex> {
  const mapping = buildMeterMapping(origin);
  if (mapping.status !== 'ok') {
    return mapping;
  }
  return projectMeterOffsetFromMapping(context, mapping.value, offset);
}

function cornerBounds(corners: ProjectedVertex[]): ScreenRect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of corners) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

function intervalContains(value: Interval, point: number): boolean {
  return point >= value.min && point <= value.max;
}

function intervalSeparationLowerBound(first: Interval, second: Interval): number {
  if (first.min > second.max) {
    return Math.max(0, nextDown(first.min - second.max));
  }
  if (second.min > first.max) {
    return Math.max(0, nextDown(second.min - first.max));
  }
  return 0;
}

function certifyMaxClampSaturation(
  mapping: MeterMapping,
  halfWidthMeters: number,
  maxPx: number,
  supportBufferPx: number,
  context: ProjectionContext,
  center: ProjectedVertex,
  budget: IntervalBudget,
): EnvelopeResult<MaxClampCertifiedMeterBounds | null> {
  const centerInterval = projectMeterBoxIntervalWithinBudget(
    mapping,
    { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    context,
    budget,
  );
  if (centerInterval.status !== 'ok') {
    return centerInterval;
  }

  const cardinalOffsets: Array<[number, number]> = [
    [halfWidthMeters, 0],
    [-halfWidthMeters, 0],
    [0, halfWidthMeters],
    [0, -halfWidthMeters],
  ];
  let projectedHalfWidthLowerBound = 0;
  for (const [offsetX, offsetY] of cardinalOffsets) {
    const witness = projectMeterBoxIntervalWithinBudget(
      mapping,
      { minX: offsetX, maxX: offsetX, minY: offsetY, maxY: offsetY },
      context,
      budget,
    );
    if (witness.status !== 'ok') {
      return witness;
    }
    const xLowerBound = intervalSeparationLowerBound(witness.value.x, centerInterval.value.x);
    const yLowerBound = intervalSeparationLowerBound(witness.value.y, centerInterval.value.y);
    projectedHalfWidthLowerBound = Math.max(projectedHalfWidthLowerBound, xLowerBound, yLowerBound);
  }

  if (projectedHalfWidthLowerBound < maxPx) {
    return { status: 'ok', value: null };
  }

  // Every cardinal witness lies on the circular support. Once a certified lower
  // bound reaches maxPx, minPx -> maxPx resolves exactly to maxPx (validation
  // guarantees minPx <= maxPx). Bound the renderer-clamped glyph around the
  // outward-rounded center interval, then add the support buffer.
  const inflationPx = maxPx + supportBufferPx;
  return {
    status: 'ok',
    value: {
      resolution: 'max-clamp-saturated',
      center,
      inflationPx,
      bounds: {
        minX: nextDown(Math.min(centerInterval.value.x.min, center[0]) - inflationPx),
        minY: nextDown(Math.min(centerInterval.value.y.min, center[1]) - inflationPx),
        maxX: nextUp(Math.max(centerInterval.value.x.max, center[0]) + inflationPx),
        maxY: nextUp(Math.max(centerInterval.value.y.max, center[1]) + inflationPx),
      },
    },
  };
}

function splitMeterBox(box: LocalMeterBox): LocalMeterBox[] | null {
  const middleX = (box.minX + box.maxX) / 2;
  const middleY = (box.minY + box.maxY) / 2;
  if (middleX === box.minX || middleX === box.maxX || middleY === box.minY || middleY === box.maxY) {
    return null;
  }
  return [
    { minX: box.minX, maxX: middleX, minY: box.minY, maxY: middleY },
    { minX: middleX, maxX: box.maxX, minY: box.minY, maxY: middleY },
    { minX: box.minX, maxX: middleX, minY: middleY, maxY: box.maxY },
    { minX: middleX, maxX: box.maxX, minY: middleY, maxY: box.maxY },
  ];
}

function getBillboardMeterHalfWidthUpper(
  context: ProjectionContext,
  origin: WorldPosition,
  halfWidthMeters: number,
): EnvelopeResult<number> {
  try {
    if (VERSION !== SUPPORTED_DECK_RENDERER_VERSION) {
      return failure(
        'unsupported',
        `strict renderer v1 supports deck.gl ${SUPPORTED_DECK_RENDERER_VERSION}, received ${VERSION}`,
      );
    }
    const uniforms = context.projectUniforms;
    if (uniforms.coordinateSystem !== DECK_LNGLAT_SHADER_COORDINATE_SYSTEM || uniforms.pseudoMeters) {
      return failure('unsupported', 'strict renderer v1 requires lnglat, non-pseudo-meter projection uniforms');
    }
    let latitudeFactor: number;
    if (uniforms.projectionMode === DECK_WEB_MERCATOR_MODE) {
      const clampedLatitude = Math.max(-89.9, Math.min(89.9, origin[1]));
      latitudeFactor = 1 / Math.cos(clampedLatitude * DEGREES_TO_RADIANS);
    } else if (uniforms.projectionMode === DECK_WEB_MERCATOR_AUTO_OFFSET_MODE) {
      latitudeFactor = 1;
    } else {
      return failure('unsupported', 'strict renderer v1 requires a Web Mercator projection mode');
    }
    const rawPixels = halfWidthMeters * uniforms.commonUnitsPerMeter[2] * latitudeFactor * uniforms.scale;
    const upper = rawPixels * (1 + DECK_FLOAT_RELATIVE_SAFETY_MARGIN) + DECK_FLOAT_ABSOLUTE_SAFETY_PX;
    if (!Number.isFinite(upper) || upper < 0) {
      return failure('unsupported', 'screen-facing meter size upper bound is non-finite');
    }
    return { status: 'ok', value: nextUp(upper) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failure('unsupported', `screen-facing meter size could not be bounded: ${detail}`);
  }
}

function certifyMeterSquare(
  context: ProjectionContext,
  origin: WorldPosition,
  halfWidthMeters: number,
  tolerancePx: number,
  budget: IntervalBudget,
  pixelClamp?: PixelClamp,
): EnvelopeResult<CertifiedMeterBounds> {
  const center = projectWorldPosition(context, origin);
  if (center.status !== 'ok') {
    return center;
  }
  if (halfWidthMeters === 0) {
    return {
      status: 'ok',
      value: {
        resolution: 'raw-interval',
        center: center.value,
        bounds: { minX: center.value[0], minY: center.value[1], maxX: center.value[0], maxY: center.value[1] },
        billboardHalfWidthUpperPx: 0,
      },
    };
  }

  const billboardHalfWidth = getBillboardMeterHalfWidthUpper(context, origin, halfWidthMeters);
  if (billboardHalfWidth.status !== 'ok') {
    return billboardHalfWidth;
  }

  const mapping = buildMeterMapping(origin);
  if (mapping.status !== 'ok') {
    return mapping;
  }
  const pending: LocalMeterBox[] = [
    { minX: -halfWidthMeters, maxX: halfWidthMeters, minY: -halfWidthMeters, maxY: halfWidthMeters },
  ];
  let certified: ScreenRect | null = null;
  let isRootBox = true;

  while (pending.length > 0) {
    const box = pending.pop() as LocalMeterBox;
    const isRoot = isRootBox;
    isRootBox = false;
    const intervalProjection = projectMeterBoxIntervalWithinBudget(mapping.value, box, context, budget);
    if (intervalProjection.status !== 'ok') {
      return intervalProjection;
    }
    const offsets: Array<[number, number, number]> = [
      [box.minX, box.minY, 0],
      [box.minX, box.maxY, 0],
      [box.maxX, box.minY, 0],
      [box.maxX, box.maxY, 0],
    ];
    const corners: ProjectedVertex[] = [];
    for (const offset of offsets) {
      const projected = projectMeterOffsetFromMapping(context, mapping.value, offset);
      if (projected.status !== 'ok') {
        return projected;
      }
      corners.push(projected.value);
    }
    const samples = cornerBounds(corners);
    const outsideCorner = corners.find(
      ([x, y, depth]) =>
        !intervalContains(intervalProjection.value.x, x) ||
        !intervalContains(intervalProjection.value.y, y) ||
        !intervalContains(intervalProjection.value.depth, depth),
    );
    if (outsideCorner) {
      return failure(
        'unsupported',
        `meter support interval did not contain corner ${JSON.stringify(outsideCorner)} in ${JSON.stringify(
          intervalProjection.value,
        )}`,
      );
    }
    const interval = intervalProjection.value;
    const looseness = Math.max(
      samples.minX - interval.x.min,
      interval.x.max - samples.maxX,
      samples.minY - interval.y.min,
      interval.y.max - samples.maxY,
    );

    if (isRoot && looseness > tolerancePx && pixelClamp?.maxPx !== undefined) {
      const rootHalfWidthUpper = Math.max(
        center.value[0] - interval.x.min,
        interval.x.max - center.value[0],
        center.value[1] - interval.y.min,
        interval.y.max - center.value[1],
        billboardHalfWidth.value,
        0,
      );
      if (pixelClamp.maxPx < rootHalfWidthUpper && budget.remaining >= MAX_CLAMP_WITNESS_INTERVAL_COST) {
        const saturated = certifyMaxClampSaturation(
          mapping.value,
          halfWidthMeters,
          pixelClamp.maxPx,
          pixelClamp.supportBufferPx ?? 0,
          context,
          center.value,
          budget,
        );
        if (saturated.status !== 'ok') {
          return saturated;
        }
        if (saturated.value) {
          return { status: 'ok', value: saturated.value };
        }
      }
    }

    if (looseness <= tolerancePx) {
      const cellBounds = { minX: interval.x.min, minY: interval.y.min, maxX: interval.x.max, maxY: interval.y.max };
      certified = certified ? unionBounds(certified, cellBounds) : cellBounds;
      continue;
    }

    const children = splitMeterBox(box);
    if (!children || budget.remaining < children.length) {
      return failure('unsupported', 'meter support interval budget exhausted before certification');
    }
    pending.push(...children);
  }

  if (!certified || !isFiniteBounds(certified)) {
    return failure('unsupported', 'meter support did not produce certified finite bounds');
  }
  return {
    status: 'ok',
    value: {
      resolution: 'raw-interval',
      bounds: certified,
      center: center.value,
      billboardHalfWidthUpperPx: billboardHalfWidth.value,
    },
  };
}

function resolvePixelClamp(value: number, clamp: PixelClamp | undefined): number {
  let resolved = value;
  if (clamp?.minPx !== undefined) {
    resolved = Math.max(resolved, clamp.minPx);
  }
  if (clamp?.maxPx !== undefined) {
    resolved = Math.min(resolved, clamp.maxPx);
  }
  return resolved + (clamp?.supportBufferPx ?? 0);
}

function resolveCertifiedMeterSupport(
  certified: CertifiedMeterBounds,
  clamp: PixelClamp | undefined,
): { bounds: ScreenRect; inflationPx: number } {
  if (certified.resolution === 'max-clamp-saturated') {
    return { bounds: certified.bounds, inflationPx: certified.inflationPx };
  }
  const centerX = certified.center[0];
  const centerY = certified.center[1];
  // The interval bounds certify geographic support; the renderer-v1 uniform formula certifies the
  // screen-facing billboard size. Clamp their conservative union, then add the declared buffer.
  const certifiedHalfWidth = Math.max(
    centerX - certified.bounds.minX,
    certified.bounds.maxX - centerX,
    centerY - certified.bounds.minY,
    certified.bounds.maxY - centerY,
    certified.billboardHalfWidthUpperPx,
    0,
  );
  const inflationPx = resolvePixelClamp(certifiedHalfWidth, clamp);
  return {
    bounds: {
      minX: centerX - inflationPx,
      minY: centerY - inflationPx,
      maxX: centerX + inflationPx,
      maxY: centerY + inflationPx,
    },
    inflationPx,
  };
}

function heightOf(position: WorldPosition): number {
  return position[2] ?? 0;
}

function boundsFromVertices(vertices: ProjectedVertex[]): ScreenRect {
  return cornerBounds(vertices);
}

function isFiniteBounds(bounds: ScreenRect): boolean {
  return (
    Number.isFinite(bounds.minX) &&
    Number.isFinite(bounds.minY) &&
    Number.isFinite(bounds.maxX) &&
    Number.isFinite(bounds.maxY) &&
    bounds.minX <= bounds.maxX &&
    bounds.minY <= bounds.maxY
  );
}

function inflateBounds(bounds: ScreenRect, inflationPx: number): ScreenRect {
  return {
    minX: bounds.minX - inflationPx,
    minY: bounds.minY - inflationPx,
    maxX: bounds.maxX + inflationPx,
    maxY: bounds.maxY + inflationPx,
  };
}

function unionBounds(first: ScreenRect, second: ScreenRect): ScreenRect {
  return {
    minX: Math.min(first.minX, second.minX),
    minY: Math.min(first.minY, second.minY),
    maxX: Math.max(first.maxX, second.maxX),
    maxY: Math.max(first.maxY, second.maxY),
  };
}

function projectPositions(context: ProjectionContext, positions: WorldPosition[]): EnvelopeResult<ProjectedVertex[]> {
  const vertices: ProjectedVertex[] = [];
  for (const position of positions) {
    const projected = projectWorldPosition(context, position);
    if (projected.status !== 'ok') {
      return projected;
    }
    vertices.push(projected.value);
  }
  return { status: 'ok', value: vertices };
}

function primitiveCoordinates(primitive: VisualPrimitive): LngLat[] {
  switch (primitive.kind) {
    case 'point-disc':
    case 'screen-rect':
      return [[primitive.position[0], primitive.position[1]]];
    case 'extruded-footprint': {
      const result: LngLat[] = [];
      for (const ring of primitive.rings) {
        for (const coordinate of ring) {
          result.push(coordinate);
        }
      }
      return result;
    }
    case 'path-corridor':
      return primitive.positions.map(([longitude, latitude]) => [longitude, latitude]);
    case 'polygon': {
      const result: LngLat[] = [];
      for (const ring of primitive.rings) {
        for (const [longitude, latitude] of ring) {
          result.push([longitude, latitude]);
        }
      }
      return result;
    }
    case 'mesh-support':
      return primitive.vertices.map(([longitude, latitude]) => [longitude, latitude]);
  }
}

function translateWorldPosition(position: WorldPosition, longitudeDelta: number): WorldPosition {
  return position[2] === undefined
    ? [position[0] + longitudeDelta, position[1]]
    : [position[0] + longitudeDelta, position[1], position[2]];
}

function translatePrimitiveLongitude(primitive: VisualPrimitive, longitudeDelta: number): VisualPrimitive {
  switch (primitive.kind) {
    case 'point-disc':
    case 'screen-rect':
      return { ...primitive, position: translateWorldPosition(primitive.position, longitudeDelta) };
    case 'extruded-footprint':
      return {
        ...primitive,
        rings: primitive.rings.map((ring) =>
          ring.map(([longitude, latitude]) => [longitude + longitudeDelta, latitude] as LngLat),
        ),
      };
    case 'path-corridor':
      return {
        ...primitive,
        positions: primitive.positions.map((position) => translateWorldPosition(position, longitudeDelta)),
      };
    case 'polygon':
      return {
        ...primitive,
        rings: primitive.rings.map((ring) => ring.map((position) => translateWorldPosition(position, longitudeDelta))),
      };
    case 'mesh-support':
      return {
        ...primitive,
        vertices: primitive.vertices.map((position) => translateWorldPosition(position, longitudeDelta)),
      };
  }
}

export function selectFrameWorldOffset(frame: VisualTargetFrame, cameraLongitude: number): number {
  return selectWorldOffset(frame.anchor[0], cameraLongitude);
}

function makeFootprint(
  primitiveIndex: number,
  primitive: VisualPrimitive,
  bounds: ScreenRect,
  vertices: ProjectedVertex[],
  sourceHeights: number[],
  inflationPx: number,
): FootprintResult {
  if (vertices.length === 0 || sourceHeights.length !== vertices.length || !isFiniteBounds(bounds)) {
    return failure('unsupported', 'projected primitive footprint is empty or non-finite');
  }
  return {
    status: 'ok',
    value: {
      primitiveIndex,
      kind: primitive.kind,
      bounds,
      vertices,
      sourceHeights,
      inflationPx,
    },
  };
}

function projectPrimitiveWithContext(
  primitive: VisualPrimitive,
  primitiveIndex: number,
  context: ProjectionContext,
  options: ProjectionOptions,
): FootprintResult {
  const mercator = validateMercatorSupport(primitiveCoordinates(primitive));
  if (mercator.status !== 'ok') {
    return mercator;
  }

  switch (primitive.kind) {
    case 'point-disc': {
      const projected = projectWorldPosition(context, primitive.position);
      if (projected.status !== 'ok') {
        return projected;
      }
      if (primitive.radius.unit === 'pixels') {
        const inflationPx = resolvePixelClamp(primitive.radius.value, primitive.pixelClamp);
        const bounds = inflateBounds(
          { minX: projected.value[0], minY: projected.value[1], maxX: projected.value[0], maxY: projected.value[1] },
          inflationPx,
        );
        return makeFootprint(
          primitiveIndex,
          primitive,
          bounds,
          [projected.value],
          [heightOf(primitive.position)],
          inflationPx,
        );
      }
      const certified = certifyMeterSquare(
        context,
        primitive.position,
        primitive.radius.value,
        options.meterSupportTolerancePx,
        { remaining: options.meterSupportIntervalBudget },
        primitive.pixelClamp,
      );
      if (certified.status !== 'ok') {
        return certified;
      }
      const resolved = resolveCertifiedMeterSupport(certified.value, primitive.pixelClamp);
      return makeFootprint(
        primitiveIndex,
        primitive,
        resolved.bounds,
        [projected.value],
        [heightOf(primitive.position)],
        resolved.inflationPx,
      );
    }
    case 'screen-rect': {
      const projected = projectWorldPosition(context, primitive.position);
      if (projected.status !== 'ok') {
        return projected;
      }
      const supportBuffer = primitive.supportBufferPx ?? 0;
      const halfWidth = primitive.widthPx / 2 + supportBuffer;
      const halfHeight = primitive.heightPx / 2 + supportBuffer;
      return makeFootprint(
        primitiveIndex,
        primitive,
        {
          minX: projected.value[0] - halfWidth,
          minY: projected.value[1] - halfHeight,
          maxX: projected.value[0] + halfWidth,
          maxY: projected.value[1] + halfHeight,
        },
        [projected.value],
        [heightOf(primitive.position)],
        Math.max(halfWidth, halfHeight),
      );
    }
    case 'extruded-footprint': {
      const flattened: LngLat[] = [];
      for (const ring of primitive.rings) {
        for (const coordinate of ring) {
          flattened.push(coordinate);
        }
      }
      const topHeights = Array.isArray(primitive.topMeters)
        ? primitive.topMeters
        : flattened.map(() => primitive.topMeters as number);
      const positions: WorldPosition[] = [];
      for (const [longitude, latitude] of flattened) {
        positions.push([longitude, latitude, primitive.baseMeters]);
      }
      for (let index = 0; index < flattened.length; index += 1) {
        positions.push([flattened[index][0], flattened[index][1], topHeights[index]]);
      }
      const vertices = projectPositions(context, positions);
      if (vertices.status !== 'ok') {
        return vertices;
      }
      const sourceHeights = positions.map(heightOf);
      const supportBuffer = primitive.supportBufferPx ?? 0;
      return makeFootprint(
        primitiveIndex,
        primitive,
        inflateBounds(boundsFromVertices(vertices.value), supportBuffer),
        vertices.value,
        sourceHeights,
        supportBuffer,
      );
    }
    case 'path-corridor': {
      const vertices = projectPositions(context, primitive.positions);
      if (vertices.status !== 'ok') {
        return vertices;
      }
      const sourceHeights = primitive.positions.map(heightOf);
      if (primitive.halfWidth.unit === 'pixels') {
        const inflationPx = resolvePixelClamp(primitive.halfWidth.value, primitive.pixelClamp);
        return makeFootprint(
          primitiveIndex,
          primitive,
          inflateBounds(boundsFromVertices(vertices.value), inflationPx),
          vertices.value,
          sourceHeights,
          inflationPx,
        );
      }

      const budget: IntervalBudget = { remaining: options.meterSupportIntervalBudget };
      let bounds: ScreenRect | null = null;
      let inflationPx = 0;
      for (const position of primitive.positions) {
        const certified = certifyMeterSquare(
          context,
          position,
          primitive.halfWidth.value,
          options.meterSupportTolerancePx,
          budget,
          primitive.pixelClamp,
        );
        if (certified.status !== 'ok') {
          return certified;
        }
        const resolved = resolveCertifiedMeterSupport(certified.value, primitive.pixelClamp);
        bounds = bounds ? unionBounds(bounds, resolved.bounds) : resolved.bounds;
        inflationPx = Math.max(inflationPx, resolved.inflationPx);
      }
      if (!bounds) {
        return failure('error', 'path-corridor has no support positions');
      }
      return makeFootprint(primitiveIndex, primitive, bounds, vertices.value, sourceHeights, inflationPx);
    }
    case 'polygon': {
      const positions: WorldPosition[] = [];
      for (const ring of primitive.rings) {
        for (const position of ring) {
          positions.push(position);
        }
      }
      const vertices = projectPositions(context, positions);
      if (vertices.status !== 'ok') {
        return vertices;
      }
      const supportBuffer = primitive.supportBufferPx ?? 0;
      return makeFootprint(
        primitiveIndex,
        primitive,
        inflateBounds(boundsFromVertices(vertices.value), supportBuffer),
        vertices.value,
        positions.map(heightOf),
        supportBuffer,
      );
    }
    case 'mesh-support': {
      const vertices = projectPositions(context, primitive.vertices);
      if (vertices.status !== 'ok') {
        return vertices;
      }
      const supportBuffer = primitive.supportBufferPx ?? 0;
      return makeFootprint(
        primitiveIndex,
        primitive,
        inflateBounds(boundsFromVertices(vertices.value), supportBuffer),
        vertices.value,
        primitive.vertices.map(heightOf),
        supportBuffer,
      );
    }
  }
}

export function projectPrimitiveFootprint(
  primitive: VisualPrimitive,
  view: CameraView,
  viewport: ViewportSpec,
  options: ProjectionOptions,
): FootprintResult {
  const validation = validateVisualPrimitive(primitive);
  if (validation.status !== 'ok') {
    return validation;
  }
  const context = createProjectionContext(view, viewport, options);
  if (context.status !== 'ok') {
    return context;
  }
  return projectPrimitiveWithContext(primitive, 0, context.value, options);
}

export function projectEnvelopeFootprints(
  frame: VisualTargetFrame,
  view: CameraView,
  viewport: ViewportSpec,
  options: ProjectionOptions,
): EnvelopeResult<ProjectedFootprint[]> {
  if (!frame || !Array.isArray(frame.primitives) || frame.primitives.length === 0) {
    return failure('error', 'visual target frame requires at least one primitive');
  }
  let worldOffset: number;
  try {
    worldOffset = selectFrameWorldOffset(frame, view.longitude);
  } catch (error) {
    return failure('error', error instanceof Error ? error.message : 'failed to select a target world copy');
  }
  if (worldOffset === 0) {
    return projectVisualPrimitiveFootprints(frame.primitives, view, viewport, options);
  }
  const longitudeDelta = worldOffset * 360;
  return projectVisualPrimitiveFootprints(
    frame.primitives.map((primitive) => translatePrimitiveLongitude(primitive, longitudeDelta)),
    view,
    viewport,
    options,
  );
}

export function projectVisualPrimitiveFootprints(
  primitives: readonly VisualPrimitive[],
  view: CameraView,
  viewport: ViewportSpec,
  options: ProjectionOptions,
): EnvelopeResult<ProjectedFootprint[]> {
  if (!Array.isArray(primitives) || primitives.length === 0) {
    return failure('error', 'visual primitive projection requires at least one primitive');
  }
  const context = createProjectionContext(view, viewport, options);
  if (context.status !== 'ok') {
    return context;
  }
  const footprints: ProjectedFootprint[] = [];
  for (let primitiveIndex = 0; primitiveIndex < primitives.length; primitiveIndex += 1) {
    const primitive = primitives[primitiveIndex];
    const validation = validateVisualPrimitive(primitive);
    if (validation.status !== 'ok') {
      return validation;
    }
    const projected = projectPrimitiveWithContext(primitive, primitiveIndex, context.value, options);
    if (projected.status !== 'ok') {
      return projected;
    }
    footprints.push(projected.value);
  }
  return { status: 'ok', value: footprints };
}

export function projectMeterOffsetForTest(
  view: CameraView,
  viewport: ViewportSpec,
  origin: WorldPosition,
  offset: [number, number, number],
): [number, number] {
  const originError = validateWorldPosition(origin, 'meter offset origin');
  if (originError) {
    throw new TypeError(originError);
  }
  const context = createProjectionContext(view, viewport, {
    meterSupportTolerancePx: 1,
    meterSupportIntervalBudget: 1,
  });
  if (context.status !== 'ok') {
    throw new Error(context.reason);
  }
  const projected = projectMeterOffset(context.value, origin, offset);
  if (projected.status !== 'ok') {
    throw new Error(projected.reason);
  }
  return [projected.value[0], projected.value[1]];
}
