import { digestCanonical } from '../camera/geometry/canonical-digest';
import { projectVisualPrimitiveFootprints } from '../camera/geometry/primitives';
import type { EnvelopeResult, VisualPrimitive } from '../camera/geometry/types';
import type { ProjectionOptions, ScreenRect, ViewportSpec } from '../camera/geometry/types';
import type { CameraCalibrationConfig } from './types';
import { snapshotPlainData } from './immutable-data';

const MAX_CONTEXT_DEPTH = 64;
const MAX_CONTEXT_NODES = 4_000_000;
const COVERAGE_ALGORITHM = 'certified-bounds-union-v1' as const;

declare const SCENE_METRIC_CONTEXT_BRAND: unique symbol;
declare const PRODUCER_METRIC_CONTEXT_BRAND: unique symbol;

const certifiedSceneContexts = new WeakSet<object>();
const certifiedProducerContexts = new WeakSet<object>();

export interface ReferenceCameraView {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
  altitude?: number;
}

export interface SceneMetricContextInput {
  schemaVersion: 1;
  sceneRevision: string;
  sceneContextRevision: string;
  projectedFrameRevision: string;
  cameraCalibrationDigest: string;
  sceneSupportDigest: string;
  referenceView: ReferenceCameraView;
  referenceViewport: ViewportSpec;
  projectionOptions: ProjectionOptions;
  sceneCertifiedFootprintBounds: ScreenRect[];
}

export interface SceneMetricContext {
  readonly [SCENE_METRIC_CONTEXT_BRAND]: true;
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly sceneRevision: string;
  readonly sceneContextRevision: string;
  readonly projectedFrameRevision: string;
  readonly cameraCalibrationDigest: string;
  readonly sceneSupportDigest: string;
  readonly referenceView: Readonly<ReferenceCameraView>;
  readonly referenceViewport: Readonly<ViewportSpec>;
  readonly projectionOptions: Readonly<ProjectionOptions>;
  readonly coverageAlgorithm: typeof COVERAGE_ALGORITHM;
  readonly sceneContextProjectedSupportUnionArea: number;
}

export interface SceneMetricContextExpectedRevisions {
  sceneRevision: string;
  sceneContextRevision: string;
  projectedFrameRevision: string;
  sceneSupportDigest: string;
  cameraCalibrationDigest: string;
}

export interface SceneMetricContextProducerIdentity {
  sceneRevision: string;
  cameraCalibrationDigest: string;
}

export type AnchorWeightPolicy = 'projected-support-area-v1' | 'explicit-semantic-v1';

export interface ProducerSupportGroupInput {
  sourceId: string;
  primitiveIndexes: number[];
  semanticWeight?: number;
}

export interface ProducerMetricContextInput {
  schemaVersion: 1;
  selectionRevision: string;
  resolvedLayerDigest: string;
  cameraCalibrationDigest: string;
  targetWorldAreaKm2?: number;
  supportGroups: ProducerSupportGroupInput[];
  glyphPrimitiveIndexes: number[];
  footprintPrimitiveIndexes: number[];
  anchorWeightPolicy: AnchorWeightPolicy;
}

export interface ProducerSupportGroup {
  readonly sourceId: string;
  readonly primitiveIndexes: readonly number[];
  readonly centroidProjected: readonly [number, number];
  readonly projectedSupportArea: number;
  readonly anchorWeight: number;
}

export interface ProjectedMetricPath {
  readonly points: readonly (readonly [number, number])[];
  readonly closed: boolean;
}

export interface ProducerMetricContext {
  readonly [PRODUCER_METRIC_CONTEXT_BRAND]: true;
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly sceneContext: SceneMetricContext;
  readonly selectionRevision: string;
  readonly resolvedLayerDigest: string;
  readonly cameraCalibrationDigest: string;
  readonly targetWorldAreaKm2?: number;
  readonly targetProjectedSupportUnionArea: number;
  readonly supportGroups: readonly ProducerSupportGroup[];
  readonly glyphSupportAreasAtReferenceZoomPx2: readonly number[];
  readonly footprintProjectedPoints: readonly (readonly [number, number])[];
  readonly pathsProjected: readonly ProjectedMetricPath[];
  readonly anchorWeightPolicy: AnchorWeightPolicy;
}

export interface ProducerMetricContextExpectedRevisions {
  sceneRevision: string;
  sceneContextRevision: string;
  projectedFrameRevision: string;
  sceneSupportDigest: string;
  selectionRevision: string;
  resolvedLayerDigest: string;
  cameraCalibrationDigest: string;
}

export interface EnvelopeProductionEstimate {
  schemaVersion: 1;
  sourceItems: number;
  primitives: number;
  vertices: number;
}

interface RectangleUnionStats {
  area: number;
  centroidX?: number;
  centroidY?: number;
}

interface RectangleEvent {
  x: number;
  minY: number;
  maxY: number;
  delta: 1 | -1;
}

function inputError(message: string): Error {
  const error = new TypeError(`envelope-producer-contract: ${message}`);
  error.name = 'EnvelopeProducerContractInputError';
  return error;
}

function snapshot<Value>(value: Value, label: string): Value {
  return snapshotPlainData(value, {
    label,
    maxDepth: MAX_CONTEXT_DEPTH,
    maxNodes: MAX_CONTEXT_NODES,
    createError: inputError,
  });
}

export function deriveCameraCalibrationDigest(calibration: CameraCalibrationConfig): string {
  const owned = snapshot(calibration, 'camera calibration digest input');
  return `camera-calibration:${digestCanonical({ schema: 'camera-calibration-digest-v1', calibration: owned })}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const requiredSet = new Set(required);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw inputError(`${label} must use the exact schema; unexpected field ${key}.`);
  }
  for (const key of requiredSet) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw inputError(`${label} must use the exact schema; missing field ${key}.`);
    }
  }
}

function requireNonemptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw inputError(`${label} must be a nonempty string.`);
  }
}

function requireFinite(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw inputError(`${label} must be finite.`);
}

function requireNonNegative(value: unknown, label: string): asserts value is number {
  requireFinite(value, label);
  if (value < 0) throw inputError(`${label} must be non-negative.`);
}

function requireNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  requireNonNegative(value, label);
  if (!Number.isSafeInteger(value)) throw inputError(`${label} must be a non-negative safe integer.`);
}

function validateStrictIndexes(value: unknown, upperBound: number, label: string, allowEmpty: boolean): number[] {
  if (!Array.isArray(value)) throw inputError(`${label} must be a dense array.`);
  if (!allowEmpty && value.length === 0) throw inputError(`${label} must be nonempty.`);
  let previous = -1;
  for (let index = 0; index < value.length; index += 1) {
    const primitiveIndex = value[index];
    requireNonNegativeSafeInteger(primitiveIndex, `${label}[${index}]`);
    if (primitiveIndex >= upperBound) throw inputError(`${label}[${index}] is outside the primitive array.`);
    if (primitiveIndex <= previous) throw inputError(`${label} must be strictly increasing.`);
    previous = primitiveIndex;
  }
  return value;
}

function validateBounds(value: unknown, label: string): asserts value is ScreenRect {
  if (!isRecord(value)) throw inputError(`${label} must be a plain object.`);
  requireExactKeys(value, ['minX', 'minY', 'maxX', 'maxY'], [], label);
  requireFinite(value.minX, `${label}.minX`);
  requireFinite(value.minY, `${label}.minY`);
  requireFinite(value.maxX, `${label}.maxX`);
  requireFinite(value.maxY, `${label}.maxY`);
  if (value.maxX < value.minX || value.maxY < value.minY) {
    throw inputError(`${label} maximums must not be below minimums.`);
  }
}

function rectangleUnionStats(rectangles: readonly ScreenRect[]): RectangleUnionStats {
  const events: RectangleEvent[] = [];
  const yValues: number[] = [];
  for (const rectangle of rectangles) {
    if (rectangle.maxX === rectangle.minX || rectangle.maxY === rectangle.minY) continue;
    events.push({ x: rectangle.minX, minY: rectangle.minY, maxY: rectangle.maxY, delta: 1 });
    events.push({ x: rectangle.maxX, minY: rectangle.minY, maxY: rectangle.maxY, delta: -1 });
    yValues.push(rectangle.minY, rectangle.maxY);
  }
  if (events.length === 0) return { area: 0 };

  events.sort((left, right) => left.x - right.x || right.delta - left.delta || left.minY - right.minY);
  yValues.sort((left, right) => left - right);
  const uniqueY: number[] = [];
  for (const value of yValues) {
    if (uniqueY.length === 0 || value !== uniqueY[uniqueY.length - 1]) uniqueY.push(value);
  }
  const intervalCount = uniqueY.length - 1;
  const coverCount = new Int32Array(Math.max(1, intervalCount * 4));
  const coveredLength = new Float64Array(Math.max(1, intervalCount * 4));
  const coveredMomentY = new Float64Array(Math.max(1, intervalCount * 4));
  const yIndex = new Map(uniqueY.map((value, index) => [value, index]));

  function pull(node: number, left: number, right: number): void {
    if (coverCount[node] > 0) {
      const minY = uniqueY[left];
      const maxY = uniqueY[right + 1];
      coveredLength[node] = maxY - minY;
      coveredMomentY[node] = (minY / 2 + maxY / 2) * coveredLength[node];
      return;
    }
    if (left === right) {
      coveredLength[node] = 0;
      coveredMomentY[node] = 0;
      return;
    }
    coveredLength[node] = coveredLength[node * 2] + coveredLength[node * 2 + 1];
    coveredMomentY[node] = coveredMomentY[node * 2] + coveredMomentY[node * 2 + 1];
  }

  function update(
    node: number,
    left: number,
    right: number,
    updateLeft: number,
    updateRight: number,
    delta: 1 | -1,
  ): void {
    if (updateLeft <= left && right <= updateRight) {
      coverCount[node] += delta;
      pull(node, left, right);
      return;
    }
    const middle = Math.floor((left + right) / 2);
    if (updateLeft <= middle) update(node * 2, left, middle, updateLeft, updateRight, delta);
    if (updateRight > middle) update(node * 2 + 1, middle + 1, right, updateLeft, updateRight, delta);
    pull(node, left, right);
  }

  let area = 0;
  let momentX = 0;
  let momentY = 0;
  let previousX = events[0].x;
  let eventIndex = 0;
  while (eventIndex < events.length) {
    const x = events[eventIndex].x;
    const width = x - previousX;
    if (width > 0) {
      const slabArea = coveredLength[1] * width;
      area += slabArea;
      momentX += (previousX / 2 + x / 2) * slabArea;
      momentY += coveredMomentY[1] * width;
    }
    while (eventIndex < events.length && events[eventIndex].x === x) {
      const event = events[eventIndex];
      const minIndex = yIndex.get(event.minY);
      const maxIndex = yIndex.get(event.maxY);
      if (minIndex === undefined || maxIndex === undefined || maxIndex <= minIndex) {
        throw inputError('certified rectangle union received inconsistent coordinates.');
      }
      update(1, 0, intervalCount - 1, minIndex, maxIndex - 1, event.delta);
      eventIndex += 1;
    }
    previousX = x;
  }
  if (!Number.isFinite(area) || !Number.isFinite(momentX) || !Number.isFinite(momentY)) {
    throw inputError('certified rectangle union overflowed finite numeric storage.');
  }
  if (area === 0) return { area: 0 };
  return { area, centroidX: momentX / area, centroidY: momentY / area };
}

function meanFinite(values: readonly number[]): number {
  if (values.length === 0) throw inputError('cannot derive a centroid from empty projected support.');
  let scale = 0;
  for (const value of values) scale = Math.max(scale, Math.abs(value));
  if (scale === 0) return 0;
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const normalized = value / scale;
    const corrected = normalized - compensation;
    const next = sum + corrected;
    compensation = next - sum - corrected;
    sum = next;
  }
  const result = scale * (sum / values.length);
  if (!Number.isFinite(result)) throw inputError('projected centroid overflowed finite numeric storage.');
  return result;
}

function boundsArea(bounds: ScreenRect): number {
  const area = (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
  if (!Number.isFinite(area) || area < 0) throw inputError('projected support area must be finite and non-negative.');
  return area;
}

function validateSceneInput(input: unknown): asserts input is SceneMetricContextInput {
  if (!isRecord(input)) throw inputError('scene metric input must be a plain object.');
  requireExactKeys(
    input,
    [
      'schemaVersion',
      'sceneRevision',
      'sceneContextRevision',
      'projectedFrameRevision',
      'cameraCalibrationDigest',
      'sceneSupportDigest',
      'referenceView',
      'referenceViewport',
      'projectionOptions',
      'sceneCertifiedFootprintBounds',
    ],
    [],
    'scene metric input',
  );
  if (input.schemaVersion !== 1) throw inputError('scene metric input schemaVersion must equal 1.');
  for (const key of [
    'sceneRevision',
    'sceneContextRevision',
    'projectedFrameRevision',
    'cameraCalibrationDigest',
    'sceneSupportDigest',
  ] as const) {
    requireNonemptyString(input[key], `scene metric input.${key}`);
  }
  if (!isRecord(input.referenceView)) throw inputError('scene metric input.referenceView must be a plain object.');
  requireExactKeys(
    input.referenceView,
    ['longitude', 'latitude', 'zoom', 'pitch', 'bearing'],
    ['altitude'],
    'scene metric input.referenceView',
  );
  for (const key of ['longitude', 'latitude', 'zoom', 'pitch', 'bearing'] as const) {
    requireFinite(input.referenceView[key], `scene metric input.referenceView.${key}`);
  }
  if (input.referenceView.altitude !== undefined) {
    requireFinite(input.referenceView.altitude, 'scene metric input.referenceView.altitude');
    if (input.referenceView.altitude <= 0) {
      throw inputError('scene metric input.referenceView.altitude must be positive.');
    }
  }
  if (!isRecord(input.referenceViewport)) {
    throw inputError('scene metric input.referenceViewport must be a plain object.');
  }
  requireExactKeys(input.referenceViewport, ['width', 'height'], [], 'scene metric input.referenceViewport');
  requireFinite(input.referenceViewport.width, 'scene metric input.referenceViewport.width');
  requireFinite(input.referenceViewport.height, 'scene metric input.referenceViewport.height');
  if (input.referenceViewport.width <= 0 || input.referenceViewport.height <= 0) {
    throw inputError('scene metric input.referenceViewport dimensions must be positive.');
  }
  if (!isRecord(input.projectionOptions)) {
    throw inputError('scene metric input.projectionOptions must be a plain object.');
  }
  requireExactKeys(
    input.projectionOptions,
    ['meterSupportTolerancePx', 'meterSupportIntervalBudget'],
    [],
    'scene metric input.projectionOptions',
  );
  requireFinite(
    input.projectionOptions.meterSupportTolerancePx,
    'scene metric input.projectionOptions.meterSupportTolerancePx',
  );
  if (input.projectionOptions.meterSupportTolerancePx <= 0) {
    throw inputError('scene metric input.projectionOptions.meterSupportTolerancePx must be positive.');
  }
  requireNonNegativeSafeInteger(
    input.projectionOptions.meterSupportIntervalBudget,
    'scene metric input.projectionOptions.meterSupportIntervalBudget',
  );
  if (input.projectionOptions.meterSupportIntervalBudget === 0) {
    throw inputError('scene metric input.projectionOptions.meterSupportIntervalBudget must be positive.');
  }
  if (!Array.isArray(input.sceneCertifiedFootprintBounds)) {
    throw inputError('scene metric input.sceneCertifiedFootprintBounds must be a dense array.');
  }
  for (let index = 0; index < input.sceneCertifiedFootprintBounds.length; index += 1) {
    validateBounds(input.sceneCertifiedFootprintBounds[index], `sceneCertifiedFootprintBounds[${index}]`);
  }
}

export function buildSceneMetricContext(input: SceneMetricContextInput): SceneMetricContext {
  const owned = snapshot(input, 'scene metric input');
  validateSceneInput(owned);
  const projectionProbe = projectVisualPrimitiveFootprints(
    [
      {
        kind: 'point-disc',
        position: [owned.referenceView.longitude, owned.referenceView.latitude],
        radius: { value: 0, unit: 'pixels' },
      },
    ],
    owned.referenceView,
    owned.referenceViewport,
    owned.projectionOptions,
  );
  if (projectionProbe.status !== 'ok') {
    throw inputError(`scene reference projection is not certified: ${projectionProbe.reason}`);
  }
  const sceneContextProjectedSupportUnionArea = rectangleUnionStats(owned.sceneCertifiedFootprintBounds).area;
  const base = {
    schemaVersion: 1 as const,
    sceneRevision: owned.sceneRevision,
    sceneContextRevision: owned.sceneContextRevision,
    projectedFrameRevision: owned.projectedFrameRevision,
    cameraCalibrationDigest: owned.cameraCalibrationDigest,
    sceneSupportDigest: owned.sceneSupportDigest,
    referenceView: owned.referenceView,
    referenceViewport: owned.referenceViewport,
    projectionOptions: owned.projectionOptions,
    coverageAlgorithm: COVERAGE_ALGORITHM,
    sceneContextProjectedSupportUnionArea,
  };
  const revision = `scene-metric:${digestCanonical({ schema: 'scene-metric-context-v1', ...base })}`;
  const context = snapshot({ ...base, revision }, 'scene metric context') as unknown as SceneMetricContext;
  certifiedSceneContexts.add(context);
  return context;
}

export function validateSceneMetricContext(
  context: SceneMetricContext,
  expected: SceneMetricContextExpectedRevisions,
): EnvelopeResult<SceneMetricContext> {
  if (typeof context !== 'object' || context === null || !certifiedSceneContexts.has(context)) {
    return nonOk('error', 'scene metric context is not a certified module-built context');
  }
  let ownedExpected: SceneMetricContextExpectedRevisions;
  try {
    ownedExpected = snapshot(expected, 'scene metric expected revisions');
    if (!isRecord(ownedExpected)) throw inputError('scene metric expected revisions must be a plain object.');
    requireExactKeys(
      ownedExpected,
      [
        'sceneRevision',
        'sceneContextRevision',
        'projectedFrameRevision',
        'sceneSupportDigest',
        'cameraCalibrationDigest',
      ],
      [],
      'scene metric expected revisions',
    );
    for (const [key, value] of Object.entries(ownedExpected)) {
      requireNonemptyString(value, `scene metric expected revisions.${key}`);
    }
  } catch (error) {
    return nonOk('error', error instanceof Error ? error.message : String(error));
  }
  const comparisons: Array<[string, string, string]> = [
    ['sceneRevision', context.sceneRevision, ownedExpected.sceneRevision],
    ['sceneContextRevision', context.sceneContextRevision, ownedExpected.sceneContextRevision],
    ['projectedFrameRevision', context.projectedFrameRevision, ownedExpected.projectedFrameRevision],
    ['sceneSupportDigest', context.sceneSupportDigest, ownedExpected.sceneSupportDigest],
    ['cameraCalibrationDigest', context.cameraCalibrationDigest, ownedExpected.cameraCalibrationDigest],
  ];
  for (const [field, actual, wanted] of comparisons) {
    if (actual !== wanted) return nonOk('stale', `scene metric context ${field} is stale`);
  }
  return { status: 'ok', value: context };
}

export function validateSceneMetricContextProducerIdentity(
  context: SceneMetricContext,
  expected: SceneMetricContextProducerIdentity,
): EnvelopeResult<SceneMetricContext> {
  if (typeof context !== 'object' || context === null || !certifiedSceneContexts.has(context)) {
    return nonOk('error', 'scene metric context is not a certified module-built context');
  }
  let ownedExpected: SceneMetricContextProducerIdentity;
  try {
    ownedExpected = snapshot(expected, 'scene metric producer identity');
    if (!isRecord(ownedExpected)) throw inputError('scene metric producer identity must be a plain object.');
    requireExactKeys(ownedExpected, ['sceneRevision', 'cameraCalibrationDigest'], [], 'scene metric producer identity');
    requireNonemptyString(ownedExpected.sceneRevision, 'scene metric producer identity.sceneRevision');
    requireNonemptyString(
      ownedExpected.cameraCalibrationDigest,
      'scene metric producer identity.cameraCalibrationDigest',
    );
  } catch (error) {
    return nonOk('error', error instanceof Error ? error.message : String(error));
  }
  if (context.sceneRevision !== ownedExpected.sceneRevision) {
    return nonOk('stale', 'scene metric context sceneRevision is stale');
  }
  if (context.cameraCalibrationDigest !== ownedExpected.cameraCalibrationDigest) {
    return nonOk('stale', 'scene metric context cameraCalibrationDigest is stale');
  }
  return { status: 'ok', value: context };
}

function validateProducerInput(input: unknown, primitiveCount: number): asserts input is ProducerMetricContextInput {
  if (!isRecord(input)) throw inputError('producer metric input must be a plain object.');
  requireExactKeys(
    input,
    [
      'schemaVersion',
      'selectionRevision',
      'resolvedLayerDigest',
      'cameraCalibrationDigest',
      'supportGroups',
      'glyphPrimitiveIndexes',
      'footprintPrimitiveIndexes',
      'anchorWeightPolicy',
    ],
    ['targetWorldAreaKm2'],
    'producer metric input',
  );
  if (input.schemaVersion !== 1) throw inputError('producer metric input schemaVersion must equal 1.');
  requireNonemptyString(input.selectionRevision, 'producer metric input.selectionRevision');
  requireNonemptyString(input.resolvedLayerDigest, 'producer metric input.resolvedLayerDigest');
  requireNonemptyString(input.cameraCalibrationDigest, 'producer metric input.cameraCalibrationDigest');
  if (input.targetWorldAreaKm2 !== undefined) {
    requireNonNegative(input.targetWorldAreaKm2, 'producer metric input.targetWorldAreaKm2');
  }
  if (input.anchorWeightPolicy !== 'projected-support-area-v1' && input.anchorWeightPolicy !== 'explicit-semantic-v1') {
    throw inputError('producer metric input.anchorWeightPolicy is unsupported.');
  }
  if (!Array.isArray(input.supportGroups) || input.supportGroups.length === 0) {
    throw inputError('producer metric input.supportGroups must be a nonempty dense array.');
  }
  const sourceIds = new Set<string>();
  const memberships = new Uint8Array(primitiveCount);
  let positiveSemanticWeight = false;
  for (let groupIndex = 0; groupIndex < input.supportGroups.length; groupIndex += 1) {
    const group = input.supportGroups[groupIndex];
    const label = `producer metric input.supportGroups[${groupIndex}]`;
    if (!isRecord(group)) throw inputError(`${label} must be a plain object.`);
    requireExactKeys(group, ['sourceId', 'primitiveIndexes'], ['semanticWeight'], label);
    requireNonemptyString(group.sourceId, `${label}.sourceId`);
    if (sourceIds.has(group.sourceId)) throw inputError('producer metric input support source IDs must be unique.');
    sourceIds.add(group.sourceId);
    const indexes = validateStrictIndexes(group.primitiveIndexes, primitiveCount, `${label}.primitiveIndexes`, false);
    for (const primitiveIndex of indexes) {
      memberships[primitiveIndex] += 1;
      if (memberships[primitiveIndex] > 1) {
        throw inputError(`primitive ${primitiveIndex} must belong to exactly one support group.`);
      }
    }
    if (input.anchorWeightPolicy === 'explicit-semantic-v1') {
      if (group.semanticWeight === undefined) {
        throw inputError(`${label}.semanticWeight is required by explicit-semantic-v1.`);
      }
      requireNonNegative(group.semanticWeight, `${label}.semanticWeight`);
      positiveSemanticWeight ||= group.semanticWeight > 0;
    } else if (group.semanticWeight !== undefined) {
      throw inputError(`${label}.semanticWeight is only valid under explicit-semantic-v1.`);
    }
  }
  for (let primitiveIndex = 0; primitiveIndex < memberships.length; primitiveIndex += 1) {
    if (memberships[primitiveIndex] !== 1) {
      throw inputError(`primitive ${primitiveIndex} must belong to exactly one support group.`);
    }
  }
  if (input.anchorWeightPolicy === 'explicit-semantic-v1' && !positiveSemanticWeight) {
    throw inputError('explicit semantic anchor weights must contain at least one positive value.');
  }
  validateStrictIndexes(
    input.glyphPrimitiveIndexes,
    primitiveCount,
    'producer metric input.glyphPrimitiveIndexes',
    true,
  );
  validateStrictIndexes(
    input.footprintPrimitiveIndexes,
    primitiveCount,
    'producer metric input.footprintPrimitiveIndexes',
    true,
  );
}

function metricProjectionPrimitive(primitive: VisualPrimitive): VisualPrimitive {
  switch (primitive.kind) {
    case 'point-disc':
      return { ...primitive, position: [primitive.position[0], primitive.position[1], 0] };
    case 'screen-rect':
      return { ...primitive, position: [primitive.position[0], primitive.position[1], 0] };
    case 'extruded-footprint':
      return { ...primitive, baseMeters: 0, topMeters: 0 };
    case 'path-corridor':
      return {
        ...primitive,
        positions: primitive.positions.map(([longitude, latitude]): [number, number, number] => [
          longitude,
          latitude,
          0,
        ]),
      };
    case 'polygon':
      return {
        ...primitive,
        rings: primitive.rings.map((ring) =>
          ring.map(([longitude, latitude]): [number, number, number] => [longitude, latitude, 0]),
        ),
      };
    case 'mesh-support':
      return {
        ...primitive,
        vertices: primitive.vertices.map(([longitude, latitude]): [number, number, number] => [longitude, latitude, 0]),
      };
  }
}

export function buildProducerMetricContext(
  input: ProducerMetricContextInput,
  sceneContext: SceneMetricContext,
  primitives: readonly VisualPrimitive[],
): ProducerMetricContext {
  if (typeof sceneContext !== 'object' || sceneContext === null || !certifiedSceneContexts.has(sceneContext)) {
    throw inputError('scene metric context is not a certified module-built context.');
  }
  const ownedInput = snapshot(input, 'producer metric input');
  const ownedPrimitives = snapshot(primitives, 'normalized visual primitives');
  if (!Array.isArray(ownedPrimitives) || ownedPrimitives.length === 0) {
    throw inputError('normalized visual primitives must be a nonempty dense array.');
  }
  validateProducerInput(ownedInput, ownedPrimitives.length);
  if (ownedInput.cameraCalibrationDigest !== sceneContext.cameraCalibrationDigest) {
    throw inputError('producer and scene camera calibration digest must match.');
  }

  const projection = projectVisualPrimitiveFootprints(
    ownedPrimitives.map(metricProjectionPrimitive),
    sceneContext.referenceView,
    sceneContext.referenceViewport,
    sceneContext.projectionOptions,
  );
  if (projection.status !== 'ok') throw inputError(`reference projection failed: ${projection.reason}`);
  const footprints = projection.value;
  const targetProjectedSupportUnionArea = rectangleUnionStats(footprints.map((footprint) => footprint.bounds)).area;

  const groups: Array<{
    sourceId: string;
    primitiveIndexes: number[];
    centroidProjected: [number, number];
    projectedSupportArea: number;
    anchorWeight: number;
  }> = ownedInput.supportGroups.map((group) => {
    const groupFootprints = group.primitiveIndexes.map((primitiveIndex) => footprints[primitiveIndex]);
    const union = rectangleUnionStats(groupFootprints.map((footprint) => footprint.bounds));
    const projectedX = groupFootprints.flatMap((footprint) => footprint.vertices.map((vertex) => vertex[0]));
    const projectedY = groupFootprints.flatMap((footprint) => footprint.vertices.map((vertex) => vertex[1]));
    const centroidProjected: [number, number] = [
      union.centroidX ?? meanFinite(projectedX),
      union.centroidY ?? meanFinite(projectedY),
    ];
    return {
      sourceId: group.sourceId,
      primitiveIndexes: group.primitiveIndexes,
      centroidProjected,
      projectedSupportArea: union.area,
      anchorWeight:
        ownedInput.anchorWeightPolicy === 'explicit-semantic-v1' ? (group.semanticWeight as number) : union.area,
    };
  });
  if (
    ownedInput.anchorWeightPolicy === 'projected-support-area-v1' &&
    groups.every((group) => group.anchorWeight === 0)
  ) {
    for (const group of groups) group.anchorWeight = 1;
  }

  const glyphSupportAreasAtReferenceZoomPx2 = ownedInput.glyphPrimitiveIndexes.map((primitiveIndex) =>
    boundsArea(footprints[primitiveIndex].bounds),
  );
  const footprintProjectedPoints = ownedInput.footprintPrimitiveIndexes.flatMap((primitiveIndex) => {
    const footprint = footprints[primitiveIndex];
    if (footprint.inflationPx === 0) {
      return footprint.vertices.map((vertex): [number, number] => [vertex[0], vertex[1]]);
    }
    const { minX, minY, maxX, maxY } = footprint.bounds;
    return [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ] satisfies [number, number][];
  });
  const pathsProjected: ProjectedMetricPath[] = [];
  for (let primitiveIndex = 0; primitiveIndex < ownedPrimitives.length; primitiveIndex += 1) {
    if (ownedPrimitives[primitiveIndex].kind !== 'path-corridor') continue;
    pathsProjected.push({
      points: footprints[primitiveIndex].vertices.map((vertex): [number, number] => [vertex[0], vertex[1]]),
      closed: false,
    });
  }

  const derived = snapshot(
    {
      selectionRevision: ownedInput.selectionRevision,
      resolvedLayerDigest: ownedInput.resolvedLayerDigest,
      cameraCalibrationDigest: ownedInput.cameraCalibrationDigest,
      ...(ownedInput.targetWorldAreaKm2 === undefined ? {} : { targetWorldAreaKm2: ownedInput.targetWorldAreaKm2 }),
      targetProjectedSupportUnionArea,
      supportGroups: groups,
      glyphSupportAreasAtReferenceZoomPx2,
      footprintProjectedPoints,
      pathsProjected,
      anchorWeightPolicy: ownedInput.anchorWeightPolicy,
    },
    'producer metric derived storage',
  );
  const revisionPayload = {
    schemaVersion: 1 as const,
    sceneContext,
    ...derived,
  };
  const revision = `producer-metric:${digestCanonical({ schema: 'producer-metric-context-v1', ...revisionPayload })}`;
  const context = Object.freeze({
    ...revisionPayload,
    revision,
  }) as unknown as ProducerMetricContext;
  certifiedProducerContexts.add(context);
  return context;
}

function nonOk<T>(status: Exclude<EnvelopeResult<T>['status'], 'ok'>, reason: string): EnvelopeResult<T> {
  return { status, reason };
}

export function validateProducerMetricContext(
  context: ProducerMetricContext,
  expected: ProducerMetricContextExpectedRevisions,
): EnvelopeResult<ProducerMetricContext> {
  if (typeof context !== 'object' || context === null || !certifiedProducerContexts.has(context)) {
    return nonOk('error', 'producer metric context is not a certified module-built context');
  }
  let ownedExpected: ProducerMetricContextExpectedRevisions;
  try {
    ownedExpected = snapshot(expected, 'producer metric expected revisions');
    if (!isRecord(ownedExpected)) throw inputError('expected revisions must be a plain object.');
    requireExactKeys(
      ownedExpected,
      [
        'sceneRevision',
        'sceneContextRevision',
        'projectedFrameRevision',
        'sceneSupportDigest',
        'selectionRevision',
        'resolvedLayerDigest',
        'cameraCalibrationDigest',
      ],
      [],
      'producer metric expected revisions',
    );
    for (const [key, value] of Object.entries(ownedExpected)) {
      requireNonemptyString(value, `producer metric expected revisions.${key}`);
    }
  } catch (error) {
    return nonOk('error', error instanceof Error ? error.message : String(error));
  }
  const comparisons: Array<[string, string, string]> = [
    ['sceneRevision', context.sceneContext.sceneRevision, ownedExpected.sceneRevision],
    ['sceneContextRevision', context.sceneContext.sceneContextRevision, ownedExpected.sceneContextRevision],
    ['projectedFrameRevision', context.sceneContext.projectedFrameRevision, ownedExpected.projectedFrameRevision],
    ['sceneSupportDigest', context.sceneContext.sceneSupportDigest, ownedExpected.sceneSupportDigest],
    ['selectionRevision', context.selectionRevision, ownedExpected.selectionRevision],
    ['resolvedLayerDigest', context.resolvedLayerDigest, ownedExpected.resolvedLayerDigest],
    ['cameraCalibrationDigest', context.cameraCalibrationDigest, ownedExpected.cameraCalibrationDigest],
  ];
  for (const [field, actual, wanted] of comparisons) {
    if (actual !== wanted) return nonOk('stale', `producer metric context ${field} is stale`);
  }
  return { status: 'ok', value: context };
}

export function enforceEnvelopeProductionBudget(
  estimate: EnvelopeProductionEstimate,
  policyId: 'strict-envelope-v1',
): EnvelopeResult<true> {
  if (policyId !== 'strict-envelope-v1') {
    return nonOk('unsupported', `unsupported envelope production policy: ${String(policyId)}`);
  }
  let owned: EnvelopeProductionEstimate;
  try {
    owned = snapshot(estimate, 'envelope production estimate');
    if (!isRecord(owned)) throw inputError('envelope production estimate must be a plain object.');
    requireExactKeys(
      owned,
      ['schemaVersion', 'sourceItems', 'primitives', 'vertices'],
      [],
      'envelope production estimate',
    );
    if (owned.schemaVersion !== 1) throw inputError('envelope production estimate schemaVersion must equal 1.');
    requireNonNegativeSafeInteger(owned.sourceItems, 'envelope production estimate.sourceItems');
    requireNonNegativeSafeInteger(owned.primitives, 'envelope production estimate.primitives');
    requireNonNegativeSafeInteger(owned.vertices, 'envelope production estimate.vertices');
  } catch (error) {
    return nonOk('error', error instanceof Error ? error.message : String(error));
  }
  const limits = { sourceItems: 100_000, primitives: 100_000, vertices: 1_000_000 } as const;
  for (const dimension of ['sourceItems', 'primitives', 'vertices'] as const) {
    if (owned[dimension] > limits[dimension]) {
      return nonOk('unavailable', `envelope-budget-exceeded:${dimension}:${owned[dimension]}:${limits[dimension]}`);
    }
  }
  return { status: 'ok', value: true };
}
