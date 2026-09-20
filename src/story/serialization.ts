import type {
  CameraMovement,
  CameraMovementCompatibilityFields,
  CameraView,
  HomeViews,
  SerializedTrajectoryCertification,
  StoryJsonV1,
  StoryJsonV2,
  StoryJsonV2Camera,
} from '../interfaces';
import { digestCanonical } from '../camera/geometry/canonical-digest';
import { MERCATOR_LATITUDE_LIMIT } from '../camera/geometry/geo-wrap';
import { normalizeTimedPath } from '../camera/timed-path';
import type { CameraTarget } from '../camera/types';
import type { ViewportSpec } from '../camera/geometry/types';
import { compileLegacyMovementTrajectory, resolveTrajectoryViewport } from '../camera/trajectory/legacy';
import type {
  CameraTrajectoryKeyframe,
  CertifiedFrameCertificate,
  CommittedTrajectoryPlan,
  SerializedCameraTrajectory,
  SerializedCameraView,
  TrajectoryCertification,
  TrajectorySlackObservations,
} from '../camera/trajectory/types';
import {
  computeTrajectoryDigest,
  validateAuthorizedCertifiedTrajectoryPlan,
  validateCommittedTrajectoryPlan,
  validateCommittedTrajectoryPlanForMovement,
  validateSerializedTrajectory,
  validateTrajectoryCertification,
} from '../camera/trajectory/validation';
import { copyHomeViews } from './home-view';
import { createAnimationBinding, validateAnimationBinding } from './scene-time';

export type StoryImportResult =
  | { ok: true; cameras: CameraMovement[]; legacy: boolean; homeViews?: HomeViews }
  | { ok: false; reason: 'timeline-json' | 'invalid-json' };

export interface StorySerializationOptions {
  trajectoryEnabled: boolean;
  /** Playback omits runtime snapshots and planning diagnostics; full preserves them for existing callers. */
  content?: 'full' | 'playback';
  viewport?: ViewportSpec;
  homeViews?: HomeViews;
}

export interface StoryParseOptions {
  viewport?: ViewportSpec;
}

type PlainRecord = Record<string, unknown>;
type JsonData = null | boolean | number | string | JsonData[] | { [key: string]: JsonData };

const OMIT = Symbol('omit-json-value');
const MOVEMENT_OPTIONAL_DATA_KEYS = [
  'id',
  'purpose',
  'shot',
  'targetId',
  'timelineTargetName',
  'targetSnapshot',
  'animationBinding',
  'recipeId',
  'recommendation',
  'debugInfo',
  'comparisonTargetSnapshots',
  'presentation',
  'startDelay',
  'annotation',
] as const;

function isPlainRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inspectPlainData(value: unknown): string | null {
  const ancestors = new Set<object>();

  const inspect = (current: unknown, path: string): string | null => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return null;
    if (typeof current === 'number') return Number.isFinite(current) ? null : `${path} is non-finite`;
    if (typeof current !== 'object') return `${path} contains unsupported ${typeof current} data`;
    if (ancestors.has(current)) return `${path} contains a cycle`;

    let prototype: object | null;
    let keys: PropertyKey[];
    let descriptors: PropertyDescriptorMap;
    try {
      prototype = Object.getPrototypeOf(current) as object | null;
      keys = Reflect.ownKeys(current);
      descriptors = Object.getOwnPropertyDescriptors(current);
    } catch {
      return `${path} cannot be inspected safely`;
    }
    const isArray = Array.isArray(current);
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      return `${path} must use a plain data prototype`;
    }

    ancestors.add(current);
    try {
      if (isArray) {
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(current, index)) return `${path}[${index}] is missing`;
        }
      }
      for (const key of keys) {
        if (typeof key !== 'string') return `${path} contains a symbol key`;
        if (isArray && key === 'length') continue;
        const descriptor = descriptors[key];
        if (!descriptor || !('value' in descriptor)) return `${path}.${key} must be a data property`;
        if (!descriptor.enumerable) return `${path}.${key} must be enumerable`;
        if (isArray && !/^(0|[1-9]\d*)$/.test(key)) return `${path}.${key} is not an array index`;
        const nestedError = inspect(descriptor.value, `${path}.${key}`);
        if (nestedError) return nestedError;
      }
    } finally {
      ancestors.delete(current);
    }
    return null;
  };

  return inspect(value, 'story');
}

interface PlaybackTargetCopy {
  preserveEnvelope: boolean;
}

function cloneSanitizedData(
  value: unknown,
  ancestors = new Set<object>(),
  arrayItem = false,
  playbackTarget?: PlaybackTargetCopy,
): JsonData | typeof OMIT {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('story contains a non-finite number');
    return value;
  }
  if (value === undefined || typeof value === 'function') return arrayItem ? null : OMIT;
  if (typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError(`story contains unsupported ${typeof value} data`);
  }
  if (ancestors.has(value)) throw new TypeError('story contains cyclic data');

  const prototype = Object.getPrototypeOf(value) as object | null;
  const isArray = Array.isArray(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('story export only supports plain data objects');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) {
    throw new TypeError('story export does not support symbol keys');
  }

  ancestors.add(value);
  try {
    if (isArray) {
      const output: JsonData[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[index];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          throw new TypeError('story export does not support sparse or accessor arrays');
        }
        output.push(cloneSanitizedData(descriptor.value, ancestors, true, playbackTarget) as JsonData);
      }
      return output;
    }

    const output: Record<string, JsonData> = {};
    // Filter before descending into large runtime snapshots. Split framing and timed
    // animation still consume envelopes, while drawn/path coordinates are geometry.
    const preserveEnvelope =
      playbackTarget?.preserveEnvelope || descriptorValue(descriptors, 'timedPath') !== undefined;
    for (const key of Object.keys(descriptors).sort()) {
      if (
        playbackTarget &&
        (key === 'selectedRows' ||
          (key === 'snapshotEnvelope' && !preserveEnvelope) ||
          (key === 'coordinates' && descriptorValue(descriptors, 'source') === 'heatmap-zone'))
      )
        continue;
      const descriptor = descriptors[key];
      if (!('value' in descriptor) || !descriptor.enumerable) {
        throw new TypeError('story export does not support accessors or hidden data');
      }
      const copied = cloneSanitizedData(
        descriptor.value,
        ancestors,
        false,
        key === 'children' ? playbackTarget : undefined,
      );
      if (copied !== OMIT) output[key] = copied;
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function getDataDescriptors(value: unknown, path: string): PropertyDescriptorMap {
  if (!isPlainRecord(value)) throw new TypeError(`${path} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== 'string' || !('value' in descriptors[key]) || !descriptors[key].enumerable,
    )
  ) {
    throw new TypeError(`${path} must contain enumerable data properties only`);
  }
  return descriptors;
}

function descriptorValue(descriptors: PropertyDescriptorMap, key: string): unknown {
  const descriptor = descriptors[key];
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new TypeError(`${path} must be a string`);
  return value;
}

function requiredFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${path} must be finite`);
  return value;
}

function copySemanticView(value: unknown, path: string): SerializedCameraView {
  const descriptors = getDataDescriptors(value, path);
  return {
    longitude: requiredFiniteNumber(descriptorValue(descriptors, 'longitude'), `${path}.longitude`),
    latitude: requiredFiniteNumber(descriptorValue(descriptors, 'latitude'), `${path}.latitude`),
    zoom: requiredFiniteNumber(descriptorValue(descriptors, 'zoom'), `${path}.zoom`),
    pitch: requiredFiniteNumber(descriptorValue(descriptors, 'pitch'), `${path}.pitch`),
    bearing: requiredFiniteNumber(descriptorValue(descriptors, 'bearing'), `${path}.bearing`),
  };
}

function requireRange(value: unknown, minimum: number, maximum: number, path: string): number {
  const number = requiredFiniteNumber(value, path);
  if (number < minimum || number > maximum) throw new TypeError(`${path} is outside its supported range`);
  return number;
}

function requireLegalView(value: unknown, path: string): SerializedCameraView {
  const view = copySemanticView(value, path);
  requireRange(view.latitude, -MERCATOR_LATITUDE_LIMIT, MERCATOR_LATITUDE_LIMIT, `${path}.latitude`);
  requireRange(view.pitch, 0, 85, `${path}.pitch`);
  requireRange(view.zoom, -2, 24, `${path}.zoom`);
  return view;
}

function requireRecord(value: unknown, path: string): PlainRecord {
  if (!isPlainRecord(value)) throw new TypeError(`${path} must be a plain object`);
  return value;
}

function requireNonemptyString(value: unknown, path: string): string {
  const text = requiredString(value, path);
  if (!text.trim()) throw new TypeError(`${path} must not be empty`);
  return text;
}

function optionalRanges(value: PlainRecord, ranges: Record<string, [number, number]>, path: string) {
  for (const [key, range] of Object.entries(ranges)) {
    if (value[key] !== undefined) requireRange(value[key], range[0], range[1], `${path}.${key}`);
  }
}

function requireOnlyKeys(value: PlainRecord, keys: readonly string[], path: string) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError(`${path} has unsupported fields`);
}

/** Intent snapshots retain useful view limits without persisting controller or transition state. */
function copyIntentView(value: unknown, path: string): CameraView {
  const view: CameraView = requireLegalView(value, path);
  const source = requireRecord(value, path);
  for (const key of ['minZoom', 'maxZoom', 'minPitch', 'maxPitch'] as const) {
    if (source[key] !== undefined) view[key] = requiredFiniteNumber(source[key], `${path}.${key}`);
  }
  if (source.altitude !== undefined) {
    view.altitude = requireRange(source.altitude, Number.MIN_VALUE, Number.MAX_VALUE, `${path}.altitude`);
  }
  return view;
}

function requireViewport(value: unknown, path: string) {
  const viewport = requireRecord(value, path);
  for (const key of ['width', 'height']) {
    requireRange(viewport[key], Number.MIN_VALUE, Number.MAX_VALUE, `${path}.${key}`);
  }
}

function validateCompositionContext(value: unknown, path: string) {
  const context = requireRecord(value, path);
  if (context.kind === 'view') {
    requireOnlyKeys(context, ['kind', 'view', 'viewport'], path);
    context.view = copyIntentView(context.view, `${path}.view`);
    requireViewport(context.viewport, `${path}.viewport`);
    return;
  }
  if (context.kind !== 'bounds') throw new TypeError(`${path}.kind is unsupported`);
  requireOnlyKeys(context, ['kind', 'bounds'], path);
  if (!Array.isArray(context.bounds) || context.bounds.length !== 4) {
    throw new TypeError(`${path}.bounds must contain west, south, east and north`);
  }
  const [west, south, east, north] = context.bounds.map((coordinate, index) =>
    requiredFiniteNumber(coordinate, `${path}.bounds[${index}]`),
  );
  requireRange(south, -MERCATOR_LATITUDE_LIMIT, MERCATOR_LATITUDE_LIMIT, `${path}.bounds[1]`);
  requireRange(north, -MERCATOR_LATITUDE_LIMIT, MERCATOR_LATITUDE_LIMIT, `${path}.bounds[3]`);
  // West > east crosses the antimeridian; shifted world copies may use unwrapped longitudes.
  const rawWidth = east - west;
  const width = rawWidth < 0 ? rawWidth + 360 : rawWidth;
  if (north <= south || width <= 0 || width > 360) {
    throw new TypeError(`${path}.bounds must have nonzero geometry within one world`);
  }
}

function validateV2Intent(result: PlainRecord, path: string) {
  if (result.motion !== undefined) {
    const motion = requireRecord(result.motion, `${path}.motion`);
    requireOnlyKeys(motion, ['zoomDelta', 'startPitch', 'endPitch', 'startBearing', 'bearingSweep'], `${path}.motion`);
    optionalRanges(
      motion,
      {
        zoomDelta: [-8, 8],
        startPitch: [0, 75],
        endPitch: [0, 75],
        startBearing: [-360, 360],
        bearingSweep: [-720, 720],
      },
      `${path}.motion`,
    );
  }
  if (result.composition !== undefined) {
    const composition = requireRecord(result.composition, `${path}.composition`);
    requireOnlyKeys(composition, ['context', 'anchor', 'offsetRatio'], `${path}.composition`);
    if (composition.anchor !== undefined && composition.anchor !== 'ground' && composition.anchor !== 'visual') {
      throw new TypeError(`${path}.composition.anchor is unsupported`);
    }
    if (composition.offsetRatio !== undefined) {
      if (!Array.isArray(composition.offsetRatio) || composition.offsetRatio.length !== 2) {
        throw new TypeError(`${path}.composition.offsetRatio must have two coordinates`);
      }
      composition.offsetRatio.forEach((coordinate, index) =>
        requireRange(coordinate, -0.45, 0.45, `${path}.composition.offsetRatio[${index}]`),
      );
    }
    if (composition.context !== undefined) {
      validateCompositionContext(composition.context, `${path}.composition.context`);
    }
  }
  if (result.source !== undefined) {
    const source = requireRecord(result.source, `${path}.source`);
    requireOnlyKeys(source, ['kind', 'view'], `${path}.source`);
    if (!['current-view', 'previous-camera', 'reference-view'].includes(source.kind as string)) {
      throw new TypeError(`${path}.source.kind is unsupported`);
    }
    source.view = copyIntentView(source.view, `${path}.source.view`);
  }
  if (result.transition !== undefined && result.transition !== 'auto' && result.transition !== 'cut') {
    throw new TypeError(`${path}.transition is unsupported`);
  }
}

function copyAuthoring(value: unknown, path: string): JsonData {
  const source = requireRecord(value, path);
  const result = cloneSanitizedData(source) as PlainRecord;
  if (result.version !== 1 && result.version !== 2) throw new TypeError(`${path}.version is unsupported`);
  if (result.version === 2) {
    validateV2Intent(result, path);
  } else if (['motion', 'composition', 'source', 'transition'].some((key) => result[key] !== undefined)) {
    throw new TypeError(`${path} requires version 2 for motion, composition, source or transition intent`);
  }
  for (const key of ['targetId', 'recipeId']) requireNonemptyString(result[key], `${path}.${key}`);
  for (const key of ['snapshotRevision', 'sceneRevision']) {
    if (result[key] !== undefined) requireNonemptyString(result[key], `${path}.${key}`);
  }
  const adjustments = requireRecord(result.adjustments, `${path}.adjustments`);
  optionalRanges(
    adjustments,
    {
      framingTightness: [-1, 1],
      motionStrength: [-1, 1],
      safetyMarginRatio: [0, 0.45],
      pitchTarget: [0, 85],
      anchorHeightRatio: [0, 1],
      speedScale: [Number.MIN_VALUE, Number.MAX_VALUE],
    },
    `${path}.adjustments`,
  );
  if (adjustments.offsetRatio !== undefined) {
    if (!Array.isArray(adjustments.offsetRatio) || adjustments.offsetRatio.length !== 2) {
      throw new TypeError(`${path}.adjustments.offsetRatio must have two coordinates`);
    }
    adjustments.offsetRatio.forEach((coordinate, index) =>
      requireRange(coordinate, -1, 1, `${path}.adjustments.offsetRatio[${index}]`),
    );
  }
  requireViewport(result.planningViewport, `${path}.planningViewport`);
  if (result.manualViews !== undefined) {
    const manualViews = requireRecord(result.manualViews, `${path}.manualViews`);
    for (const key of ['initial', 'final']) {
      if (manualViews[key] !== undefined) {
        manualViews[key] =
          result.version === 2
            ? copyIntentView(manualViews[key], `${path}.manualViews.${key}`)
            : requireLegalView(manualViews[key], `${path}.manualViews.${key}`);
      }
    }
  }
  if (result.timing !== undefined) {
    optionalRanges(
      requireRecord(result.timing, `${path}.timing`),
      {
        duration: [0, Number.MAX_VALUE],
        stay: [0, Number.MAX_VALUE],
        startDelay: [0, Number.MAX_VALUE],
      },
      `${path}.timing`,
    );
  }
  if (result.optionSelection !== undefined) {
    const option = requireRecord(result.optionSelection, `${path}.optionSelection`);
    requireNonemptyString(option.id, `${path}.optionSelection.id`);
    requiredString(option.label, `${path}.optionSelection.label`);
    const adjustment = requireRecord(option.adjustment, `${path}.optionSelection.adjustment`);
    if (adjustment.timing !== undefined) {
      optionalRanges(
        requireRecord(adjustment.timing, `${path}.optionSelection.adjustment.timing`),
        {
          durationMs: [0, Number.MAX_VALUE],
          stayMs: [0, Number.MAX_VALUE],
          interpolationDurationMs: [0, Number.MAX_VALUE],
          pathDurationPerKmMs: [0, Number.MAX_VALUE],
          maxDurationMs: [0, Number.MAX_VALUE],
          speedTier: [Number.MIN_VALUE, Number.MAX_VALUE],
        },
        `${path}.optionSelection.adjustment.timing`,
      );
    }
    for (const key of ['framing', 'adaptation', 'targetPolicy']) {
      if (adjustment[key] !== undefined) requireRecord(adjustment[key], `${path}.optionSelection.adjustment.${key}`);
    }
  }
  return result as JsonData;
}

function copyFramingReport(value: unknown, duration: number, path: string): JsonData {
  const result = cloneSanitizedData(requireRecord(value, path)) as PlainRecord;
  if (!['passed', 'warning', 'incomplete'].includes(result.status as string))
    throw new TypeError(`${path}.status is unsupported`);
  if (!['whole-shot', 'endpoints', 'route-window', 'targetless'].includes(result.scope as string))
    throw new TypeError(`${path}.scope is unsupported`);
  const count = requireRange(result.sampleCount, 0, Number.MAX_SAFE_INTEGER, `${path}.sampleCount`);
  if (!Number.isInteger(count)) throw new TypeError(`${path}.sampleCount must be an integer`);
  if (result.minMarginPx !== undefined) requiredFiniteNumber(result.minMarginPx, `${path}.minMarginPx`);
  if (result.worstTimeMs !== undefined) requireRange(result.worstTimeMs, 0, duration, `${path}.worstTimeMs`);
  if (!Array.isArray(result.messages) || result.messages.some((message) => typeof message !== 'string')) {
    throw new TypeError(`${path}.messages must contain strings`);
  }
  if (result.inputRevision !== undefined) requireNonemptyString(result.inputRevision, `${path}.inputRevision`);
  return result as JsonData;
}

function requireTargetPosition(value: unknown, path: string, allowAltitude = false) {
  if (!Array.isArray(value) || (value.length !== 2 && !(allowAltitude && value.length === 3))) {
    throw new TypeError(`${path} must contain longitude and latitude`);
  }
  value.forEach((coordinate, index) => requiredFiniteNumber(coordinate, `${path}[${index}]`));
  requireRange(value[1], -90, 90, `${path}[1]`);
}

function requireTargetBounds(value: unknown, path: string) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new TypeError(`${path} must contain west, south, east and north`);
  }
  value.forEach((coordinate, index) => requiredFiniteNumber(coordinate, `${path}[${index}]`));
  requireRange(value[1], -90, 90, `${path}[1]`);
  requireRange(value[3], -90, 90, `${path}[3]`);
  // Point bounds and antimeridian/unwrapped longitudes are valid saved target geometry.
  if (value[1] > value[3]) throw new TypeError(`${path} has inverted latitude bounds`);
}

function requireTargetCoordinates(value: unknown, path: string, allowRings = false) {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  value.forEach((coordinate, index) => {
    const coordinatePath = `${path}[${index}]`;
    if (allowRings && Array.isArray(coordinate) && Array.isArray(coordinate[0])) {
      requireTargetCoordinates(coordinate, coordinatePath);
    } else {
      requireTargetPosition(coordinate, coordinatePath, true);
    }
  });
}

function validateTargetSnapshot(value: unknown, path: string, required = false) {
  const recognized =
    isPlainRecord(value) &&
    (['point', 'location', 'region', 'path', 'multiple', 'none'].includes(value.type as string) ||
      'center' in value ||
      'bbox' in value ||
      'timedPath' in value);
  // Older files may store opaque metadata here; validate objects that claim target geometry.
  if (!recognized && !required) return;
  const target = requireRecord(value, path);
  requireNonemptyString(target.id, `${path}.id`);
  requireTargetPosition(target.center, `${path}.center`);
  requireTargetBounds(target.bbox, `${path}.bbox`);
  for (const key of ['type', 'label']) {
    if (target[key] !== undefined) requiredString(target[key], `${path}.${key}`);
  }
  for (const key of ['selectionAnchor', 'start', 'end']) {
    if (target[key] !== undefined) requireTargetPosition(target[key], `${path}.${key}`);
  }
  if (target.coordinates !== undefined) requireTargetCoordinates(target.coordinates, `${path}.coordinates`, true);
  if (target.timedPath !== undefined) {
    const snapshotPath = `${path}.timedPath`;
    const snapshot = requireRecord(target.timedPath, snapshotPath);
    requireOnlyKeys(snapshot, ['version', 'coordinates', 'timestamps', 'digest'], snapshotPath);
    const normalized = normalizeTimedPath(snapshot.coordinates, snapshot.timestamps);
    if (!normalized || digestCanonical(snapshot) !== digestCanonical(normalized)) {
      throw new TypeError(`${snapshotPath} must be a normalized timed path with a matching digest`);
    }
  }
  if (target.visualFrame !== undefined) {
    const frame = requireRecord(target.visualFrame, `${path}.visualFrame`);
    requireTargetBounds(frame.bbox, `${path}.visualFrame.bbox`);
    if (frame.anchor !== undefined) requireTargetPosition(frame.anchor, `${path}.visualFrame.anchor`);
    if (frame.sampleCoordinates !== undefined) {
      requireTargetCoordinates(frame.sampleCoordinates, `${path}.visualFrame.sampleCoordinates`);
    }
  }
  if (target.children !== undefined) {
    if (!Array.isArray(target.children)) throw new TypeError(`${path}.children must be an array`);
    target.children.forEach((child, index) => validateTargetSnapshot(child, `${path}.children[${index}]`, true));
  }
}

function validateMovementMetadata(movement: PlainRecord, path: string) {
  if (movement.timelineTargetName !== undefined) {
    requiredString(movement.timelineTargetName, `${path}.timelineTargetName`);
  }
  for (const key of ['id', 'targetId', 'recipeId']) {
    if (movement[key] !== undefined) requireNonemptyString(movement[key], `${path}.${key}`);
  }
  if (movement.startDelay !== undefined) {
    requireRange(movement.startDelay, 0, Number.MAX_VALUE, `${path}.startDelay`);
  }
  if (movement.annotation !== undefined) {
    const annotation = requireRecord(movement.annotation, `${path}.annotation`);
    requiredString(annotation.text, `${path}.annotation.text`);
    for (const key of ['delay', 'duration']) {
      requireRange(annotation[key], 0, Number.MAX_VALUE, `${path}.annotation.${key}`);
    }
  }
  validateTargetSnapshot(movement.targetSnapshot, `${path}.targetSnapshot`);
  if (movement.animationBinding !== undefined) {
    if (!validateAnimationBinding(movement.animationBinding)) {
      throw new TypeError(`${path}.animationBinding is invalid`);
    }
    const target = requireRecord(movement.targetSnapshot, `${path}.targetSnapshot`);
    const expected = createAnimationBinding(target as unknown as CameraTarget);
    if (!expected || digestCanonical(expected) !== digestCanonical(movement.animationBinding)) {
      throw new TypeError(`${path}.animationBinding must match the target provenance, timed path and range`);
    }
  }
  if (movement.comparisonTargetSnapshots !== undefined) {
    if (!Array.isArray(movement.comparisonTargetSnapshots)) {
      throw new TypeError(`${path}.comparisonTargetSnapshots must be an array`);
    }
    movement.comparisonTargetSnapshots.forEach((target, index) =>
      validateTargetSnapshot(target, `${path}.comparisonTargetSnapshots[${index}]`),
    );
  }
}

function copyMovement(
  value: unknown,
  path: string,
  content: StorySerializationOptions['content'] = 'full',
): CameraMovementCompatibilityFields {
  const descriptors = getDataDescriptors(value, path);
  const output: PlainRecord = {};
  for (const key of MOVEMENT_OPTIONAL_DATA_KEYS) {
    if (content === 'playback' && (key === 'debugInfo' || key === 'recommendation')) continue;
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) continue;
    const playbackTarget =
      content === 'playback' && (key === 'targetSnapshot' || key === 'comparisonTargetSnapshots')
        ? {
            preserveEnvelope:
              key === 'comparisonTargetSnapshots' && descriptorValue(descriptors, 'presentation') === 'split',
          }
        : undefined;
    const copied = cloneSanitizedData(descriptor.value, undefined, false, playbackTarget);
    if (copied !== OMIT) output[key] = copied;
  }
  validateMovementMetadata(output, path);

  const recommendationBaseView = descriptorValue(descriptors, 'recommendationBaseViewState');
  if (recommendationBaseView !== undefined) {
    output.recommendationBaseViewState = copySemanticView(
      recommendationBaseView,
      `${path}.recommendationBaseViewState`,
    );
  }
  output.name = requiredString(descriptorValue(descriptors, 'name'), `${path}.name`);
  output.title = requiredString(descriptorValue(descriptors, 'title'), `${path}.title`);
  output.category = requiredString(descriptorValue(descriptors, 'category'), `${path}.category`);
  output.initViewState = copySemanticView(descriptorValue(descriptors, 'initViewState'), `${path}.initViewState`);
  output.finalViewState = copySemanticView(descriptorValue(descriptors, 'finalViewState'), `${path}.finalViewState`);
  output.duration = requireRange(descriptorValue(descriptors, 'duration'), 0, Number.MAX_VALUE, `${path}.duration`);
  const authoring = descriptorValue(descriptors, 'authoring');
  if (authoring !== undefined) output.authoring = copyAuthoring(authoring, `${path}.authoring`);
  const framingReport = descriptorValue(descriptors, 'framingReport');
  if (framingReport !== undefined && content !== 'playback')
    output.framingReport = copyFramingReport(framingReport, output.duration as number, `${path}.framingReport`);
  output.stay = requireRange(descriptorValue(descriptors, 'stay'), 0, Number.MAX_VALUE, `${path}.stay`);
  const isRotating = descriptorValue(descriptors, 'isRotating');
  if (typeof isRotating !== 'boolean') throw new TypeError(`${path}.isRotating must be boolean`);
  output.isRotating = isRotating;
  output.interpolationType = requiredString(
    descriptorValue(descriptors, 'interpolationType'),
    `${path}.interpolationType`,
  );
  output.interpolationDuration = requireRange(
    descriptorValue(descriptors, 'interpolationDuration'),
    0,
    Number.MAX_VALUE,
    `${path}.interpolationDuration`,
  );
  return output as unknown as CameraMovementCompatibilityFields;
}

function copyFrameCertificate(certificate: CertifiedFrameCertificate): CertifiedFrameCertificate {
  return {
    kind: certificate.kind,
    inputDigest: certificate.inputDigest,
    envelopeDigest: certificate.envelopeDigest,
    viewportDigest: certificate.viewportDigest,
    constraintDigest: certificate.constraintDigest,
    solverVersion: certificate.solverVersion,
    viewDigest: certificate.viewDigest,
    slackPx: certificate.slackPx,
  };
}

function copyKeyframe(keyframe: CameraTrajectoryKeyframe): CameraTrajectoryKeyframe {
  return {
    timeMs: keyframe.timeMs,
    view: copySemanticView(keyframe.view, 'trajectory keyframe view'),
    ...(keyframe.frameCertificate ? { frameCertificate: copyFrameCertificate(keyframe.frameCertificate) } : {}),
  };
}

function copyTrajectory(trajectory: SerializedCameraTrajectory): SerializedCameraTrajectory {
  if (trajectory.kind === 'hold') {
    return {
      kind: 'hold',
      sampler: 'hold-v1',
      samplerVersion: '1',
      durationMs: trajectory.durationMs,
      keyframes: [copyKeyframe(trajectory.keyframes[0]), copyKeyframe(trajectory.keyframes[1])],
    };
  }
  if (trajectory.kind === 'keyframed') {
    return {
      kind: 'keyframed',
      sampler: trajectory.sampler,
      samplerVersion: '1',
      durationMs: trajectory.durationMs,
      keyframes: trajectory.keyframes.map(copyKeyframe),
    };
  }
  if (trajectory.kind === 'legacy-fly') {
    return {
      kind: 'legacy-fly',
      sampler: 'deck-fly-v1',
      samplerVersion: '1',
      durationMs: trajectory.durationMs,
      viewport: { width: trajectory.viewport.width, height: trajectory.viewport.height },
      initView: copySemanticView(trajectory.initView, 'trajectory initial view'),
      finalView: copySemanticView(trajectory.finalView, 'trajectory final view'),
    };
  }
  return {
    kind: 'legacy-linear',
    sampler: 'legacy-linear-v1',
    samplerVersion: '1',
    durationMs: trajectory.durationMs,
    initView: copySemanticView(trajectory.initView, 'trajectory initial view'),
    finalView: copySemanticView(trajectory.finalView, 'trajectory final view'),
  };
}

function copyObservations(observations: TrajectorySlackObservations): TrajectorySlackObservations {
  return {
    samples: observations.samples.map((sample) => ({ timeMs: sample.timeMs, slackPx: sample.slackPx })),
    minimumSlackPx: observations.minimumSlackPx,
    evaluationCount: observations.evaluationCount,
    intervalBoundCount: observations.intervalBoundCount,
  };
}

function copyCertificationForStory(certification: TrajectoryCertification): SerializedTrajectoryCertification {
  if (certification.status === 'certified') {
    const certificate = certification.certificate;
    return {
      status: 'certified',
      certificate: {
        kind: 'visibility-v1',
        trajectoryDigest: certificate.trajectoryDigest,
        envelopeDigest: certificate.envelopeDigest,
        viewportDigest: certificate.viewportDigest,
        constraintDigest: certificate.constraintDigest,
        validity: {
          domain: 'story-local',
          startMs: 0,
          endMs: certificate.validity.endMs,
        },
        intervals: certificate.intervals.map((interval) => ({
          startMs: interval.startMs,
          endMs: interval.endMs,
          slackLowerBoundPx: interval.slackLowerBoundPx,
          boundMethod: interval.boundMethod,
        })),
      },
    };
  }
  if (certification.status === 'unsafe') {
    return {
      status: 'unsafe',
      worstTimeMs: certification.worstTimeMs,
      slackPx: certification.slackPx,
    };
  }
  if (certification.status === 'unknown') {
    return { status: 'unknown', reason: certification.reason };
  }
  return { status: 'legacy-unverified', observations: copyObservations(certification.observations) };
}

function copyCertificationForPlan(certification: TrajectoryCertification): TrajectoryCertification {
  if (certification.status === 'unsafe') {
    return {
      status: 'unsafe',
      worstTimeMs: certification.worstTimeMs,
      slackPx: certification.slackPx,
      violations: certification.violations.map((violation) => ({ ...violation })),
    };
  }
  return copyCertificationForStory(certification) as TrajectoryCertification;
}

function legacyPlan(movement: CameraMovementCompatibilityFields, viewport?: ViewportSpec): CommittedTrajectoryPlan {
  const resolvedViewport = resolveTrajectoryViewport(viewport);
  const trajectory = compileLegacyMovementTrajectory(movement, resolvedViewport, 'fly');
  const trajectoryDigest = computeTrajectoryDigest(trajectory);
  return {
    inputDigest: digestCanonical({
      schema: 'story-legacy-trajectory-input-v1',
      movement,
      viewport: resolvedViewport,
      trajectoryDigest,
    }),
    trajectory,
    trajectoryDigest,
    certification: {
      status: 'legacy-unverified',
      observations: { samples: [], minimumSlackPx: null, evaluationCount: 0, intervalBoundCount: 0 },
    },
  };
}

function resolveExportPlan(
  source: CameraMovement,
  movement: CameraMovementCompatibilityFields,
  viewport?: ViewportSpec,
): CommittedTrajectoryPlan {
  if (source.trajectoryPlan === undefined) return legacyPlan(movement, viewport);
  const validated = validateCommittedTrajectoryPlan(source.trajectoryPlan);
  if (validated.status === 'error') throw new TypeError(`invalid committed trajectory plan: ${validated.reason}`);
  const movementValidated = validateCommittedTrajectoryPlanForMovement(validated.value, movement);
  if (movementValidated.status === 'error') {
    throw new TypeError(`committed trajectory does not match movement: ${movementValidated.reason}`);
  }
  if (validated.value.certification.status === 'certified') {
    const authorized = validateAuthorizedCertifiedTrajectoryPlan(validated.value);
    if (authorized.status === 'error') {
      throw new TypeError(`committed trajectory is not authorized: ${authorized.reason}`);
    }
  }
  return validated.value;
}

function createV2Entry(
  source: CameraMovement,
  viewport?: ViewportSpec,
  content?: StorySerializationOptions['content'],
): StoryJsonV2Camera {
  const movement = copyMovement(source, 'camera movement', content);
  if (movement.duration < 0) throw new TypeError('Story v2 camera duration must be nonnegative');
  const plan = resolveExportPlan(source, movement, viewport);
  return {
    movement,
    inputDigest: plan.inputDigest,
    trajectory: copyTrajectory(plan.trajectory),
    trajectoryDigest: plan.trajectoryDigest,
    certification: copyCertificationForStory(plan.certification),
  };
}

export function createStoryJson(
  cameras: CameraMovement[],
  options?: StorySerializationOptions,
): StoryJsonV1 | StoryJsonV2 {
  const homeViews = options?.homeViews ? copyHomeViews(options.homeViews) : {};
  const homeMetadata = Object.keys(homeViews).length ? { homeViews } : {};
  if (options?.trajectoryEnabled !== false) {
    return {
      type: 'geo-camera-story',
      version: 2,
      cameras: cameras.map((camera) => createV2Entry(camera, options?.viewport, options?.content)),
      ...homeMetadata,
    };
  }
  return {
    type: 'geo-camera-story',
    version: 1,
    cameras: cameras.map((camera) => copyMovement(camera, 'camera movement', options?.content) as CameraMovement),
    ...homeMetadata,
  };
}

function exactKeys(value: PlainRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function normalizeSerializedCertification(value: unknown): unknown {
  if (!isPlainRecord(value)) return value;
  if (value.status !== 'unsafe') return value;
  if (!exactKeys(value, ['status', 'worstTimeMs', 'slackPx'])) return value;
  return {
    status: 'unsafe',
    worstTimeMs: value.worstTimeMs,
    slackPx: value.slackPx,
    violations: [],
  };
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function parseV2(value: PlainRecord): StoryImportResult {
  if (!exactKeys(value, ['type', 'version', 'cameras']) || !Array.isArray(value.cameras)) {
    return { ok: false, reason: 'invalid-json' };
  }
  const cameras: CameraMovement[] = [];
  try {
    for (const entryValue of value.cameras) {
      if (
        !isPlainRecord(entryValue) ||
        !exactKeys(entryValue, ['movement', 'inputDigest', 'trajectory', 'trajectoryDigest', 'certification']) ||
        !isPlainRecord(entryValue.movement) ||
        Object.prototype.hasOwnProperty.call(entryValue.movement, 'trajectoryPlan') ||
        typeof entryValue.inputDigest !== 'string' ||
        entryValue.inputDigest.length === 0 ||
        typeof entryValue.trajectoryDigest !== 'string' ||
        entryValue.trajectoryDigest.length === 0
      ) {
        return { ok: false, reason: 'invalid-json' };
      }
      if (
        isPlainRecord(entryValue.certification) &&
        entryValue.certification.status === 'unsafe' &&
        !exactKeys(entryValue.certification, ['status', 'worstTimeMs', 'slackPx'])
      ) {
        return { ok: false, reason: 'invalid-json' };
      }
      const movement = copyMovement(entryValue.movement, 'story camera movement');
      if (movement.duration < 0) return { ok: false, reason: 'invalid-json' };
      const trajectoryResult = validateSerializedTrajectory(entryValue.trajectory);
      if (trajectoryResult.status === 'error') return { ok: false, reason: 'invalid-json' };
      const expectedDigest = computeTrajectoryDigest(trajectoryResult.value);
      if (entryValue.trajectoryDigest !== expectedDigest || trajectoryResult.value.durationMs !== movement.duration) {
        return { ok: false, reason: 'invalid-json' };
      }
      const certificationResult = validateTrajectoryCertification(
        normalizeSerializedCertification(entryValue.certification),
        trajectoryResult.value,
        expectedDigest,
      );
      if (certificationResult.status === 'error') return { ok: false, reason: 'invalid-json' };
      const plan: CommittedTrajectoryPlan = {
        inputDigest: entryValue.inputDigest,
        trajectory: copyTrajectory(trajectoryResult.value),
        trajectoryDigest: expectedDigest,
        certification: copyCertificationForPlan(certificationResult.value),
      };
      const planResult = validateCommittedTrajectoryPlan(plan);
      if (planResult.status === 'error') return { ok: false, reason: 'invalid-json' };
      const movementPlanResult = validateCommittedTrajectoryPlanForMovement(planResult.value, movement);
      if (movementPlanResult.status === 'error') return { ok: false, reason: 'invalid-json' };
      if (
        planResult.value.certification.status === 'certified' &&
        validateAuthorizedCertifiedTrajectoryPlan(planResult.value).status === 'error'
      ) {
        return { ok: false, reason: 'invalid-json' };
      }
      cameras.push({ ...(movement as CameraMovement), trajectoryPlan: deepFreeze(plan) });
    }
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  return { ok: true, cameras, legacy: false };
}

function parseMovementArray(value: unknown): CameraMovement[] | undefined {
  if (!Array.isArray(value)) return undefined;
  try {
    return value.map((camera, index) => copyMovement(camera, `camera[${index}]`) as CameraMovement);
  } catch {
    return undefined;
  }
}

function isTimelineJsonArray(value: unknown) {
  return (
    Array.isArray(value) &&
    value.some((item) => {
      if (!isPlainRecord(item)) return false;
      return typeof item.targetStart === 'number' && typeof item.targetEnd === 'number' && Array.isArray(item.cameras);
    })
  );
}

export function parseStoryJson(value: unknown, options: StoryParseOptions = {}): StoryImportResult {
  // V1 remains unresolved until a later playback/export boundary uses the active viewport.
  void options.viewport;
  if (inspectPlainData(value)) return { ok: false, reason: 'invalid-json' };
  if (
    isPlainRecord(value) &&
    value.type === 'geo-camera-story' &&
    Object.prototype.hasOwnProperty.call(value, 'homeViews')
  ) {
    try {
      const homeViews = copyHomeViews(value.homeViews);
      const story = { ...value };
      delete story.homeViews;
      const parsed = parseStoryJson(story, options);
      return parsed.ok ? { ...parsed, homeViews } : parsed;
    } catch {
      return { ok: false, reason: 'invalid-json' };
    }
  }
  if (isPlainRecord(value) && value.type === 'geo-camera-story' && value.version === 2) {
    return parseV2(value);
  }
  if (isPlainRecord(value) && value.type === 'geo-camera-story' && value.version === 1) {
    const cameras = parseMovementArray(value.cameras);
    return cameras ? { ok: true, cameras, legacy: false } : { ok: false, reason: 'invalid-json' };
  }

  const cameras = parseMovementArray(value);
  if (cameras) return { ok: true, cameras, legacy: true };
  if (isTimelineJsonArray(value)) return { ok: false, reason: 'timeline-json' };
  return { ok: false, reason: 'invalid-json' };
}
