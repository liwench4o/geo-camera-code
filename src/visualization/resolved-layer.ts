import { VERSION } from '@deck.gl/core';
import { canonicalJson, digestCanonical } from '../camera/geometry/canonical-digest';
import type { UnitValue } from '../camera/geometry/types';
import {
  HEXAGON_SELECTION_POSITION_ACCESSOR_ID,
  REQUIRED_CAMERA_CALIBRATION_METRIC_UNITS,
  STRICT_RENDERER_LIBRARY_VERSION,
  findRendererAdapterContract,
  getRenderQueryContract,
  isKnownAccessorId,
  resolveVisualizationDatasetId,
  validateLayerCameraContractShape,
} from './camera-contract';
import type {
  CameraCalibrationConfig,
  ResolveLayerDescriptorInput,
  ResolvedLayerDescriptor,
  ResolvedLayerSupport,
  VisualizationLayerValue,
} from './types';

const certifiedResolvedLayerDescriptors = new WeakSet<object>();

const MAX_RESOLVED_LAYER_INPUT_DEPTH = 64;
const RESOLVE_INPUT_REQUIRED_KEYS = Object.freeze([
  'catalogRevision',
  'visualization',
  'dataset',
  'dataFile',
  'dataRevision',
  'layer',
  'rowCount',
  'params',
  'state',
] as const);
const RESOLVE_INPUT_ALLOWED_KEYS = new Set<string>([
  ...RESOLVE_INPUT_REQUIRED_KEYS,
  'runtimeDerivedProps',
  'runtimeDerivedSupport',
]);

export type LayerValueReference =
  | { kind: 'literal' | 'object' }
  | { kind: 'param' | 'state'; key: string }
  | { kind: 'invalid'; reason: 'conflict' | 'param' | 'state' | 'schema' };

function hasOwn(record: object, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function getOwnEnumerableDataEntries(value: unknown, label: string): Array<[string, unknown]> {
  if (!isPlainDataRecord(value)) {
    throw new Error(`${label} must be a plain data object.`);
  }
  const entries: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error(`${label} must contain only own enumerable string plain data properties.`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function getPlainDataChildren(value: object, label: string): unknown[] {
  if (!Array.isArray(value)) {
    return getOwnEnumerableDataEntries(value, label).map((entry) => entry[1]);
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error(`${label} must be a plain data array with a valid length.`);
  }

  const children: unknown[] = [];
  let elementCount = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const numericKey = typeof key === 'string' ? Number(key) : Number.NaN;
    if (
      typeof key !== 'string' ||
      !Number.isSafeInteger(numericKey) ||
      numericKey < 0 ||
      numericKey >= length ||
      String(numericKey) !== key ||
      !descriptor ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      throw new Error(`${label} must contain only own enumerable indexed plain data properties.`);
    }
    elementCount += 1;
    children.push(descriptor.value);
  }
  if (elementCount !== length) {
    throw new Error(`${label} must be a dense plain data array.`);
  }
  return children;
}

export function requireBoundedPlainDataGraph(value: unknown, label: string) {
  const stack: Array<{ value: unknown; depth: number; path: string }> = [{ value, depth: 0, path: label }];
  const greatestVisitedDepth = new Map<object, number>();
  while (stack.length > 0) {
    const entry = stack.pop()!;
    const valueType = typeof entry.value;
    if (entry.value === null || valueType === 'string' || valueType === 'boolean' || valueType === 'undefined') {
      continue;
    }
    if (valueType === 'number') {
      if (!Number.isFinite(entry.value)) {
        throw new Error(`${entry.path} must contain only finite plain data numbers.`);
      }
      continue;
    }
    if (valueType !== 'object') {
      throw new Error(`${entry.path} must contain plain data values only.`);
    }
    if (entry.depth > MAX_RESOLVED_LAYER_INPUT_DEPTH) {
      throw new Error(`${label} exceeds maximum depth ${MAX_RESOLVED_LAYER_INPUT_DEPTH}.`);
    }
    const objectValue = entry.value as object;
    const visitedDepth = greatestVisitedDepth.get(objectValue);
    if (visitedDepth !== undefined && visitedDepth >= entry.depth) continue;
    greatestVisitedDepth.set(objectValue, entry.depth);
    const children = getPlainDataChildren(objectValue, entry.path);
    for (let index = 0; index < children.length; index += 1) {
      stack.push({ value: children[index], depth: entry.depth + 1, path: `${entry.path}[${index}]` });
    }
  }
}

function requireResolverContainerPreflight(input: ResolveLayerDescriptorInput) {
  const inputValues = new Map(getOwnEnumerableDataEntries(input, 'ResolveLayerDescriptorInput'));
  const layer = inputValues.get('layer');
  const layerValues = new Map(getOwnEnumerableDataEntries(layer, 'ResolveLayerDescriptorInput.layer'));
  const props = layerValues.get('props');
  const accessors = layerValues.get('accessors');

  if (props !== undefined) {
    requireBoundedPlainDataGraph(props, 'ResolveLayerDescriptorInput.layer.props');
    for (const [propName, value] of getOwnEnumerableDataEntries(props, 'ResolveLayerDescriptorInput.layer.props')) {
      const reference = parseLayerValueReference(value);
      if (reference.kind === 'invalid') {
        throw new Error(`Invalid layer value reference for prop "${propName}" (${reference.reason}).`);
      }
    }
  }
  if (accessors !== undefined) {
    getOwnEnumerableDataEntries(accessors, 'ResolveLayerDescriptorInput.layer.accessors');
    requireBoundedPlainDataGraph(accessors, 'ResolveLayerDescriptorInput.layer.accessors');
  }

  for (const key of ['params', 'state'] as const) {
    const container = inputValues.get(key);
    getOwnEnumerableDataEntries(container, `ResolveLayerDescriptorInput.${key}`);
    requireBoundedPlainDataGraph(container, `ResolveLayerDescriptorInput.${key}`);
  }
  const runtimeDerivedProps = inputValues.get('runtimeDerivedProps');
  if (runtimeDerivedProps !== undefined) {
    getOwnEnumerableDataEntries(runtimeDerivedProps, 'ResolveLayerDescriptorInput.runtimeDerivedProps');
    requireBoundedPlainDataGraph(runtimeDerivedProps, 'ResolveLayerDescriptorInput.runtimeDerivedProps');
  }
  const runtimeDerivedSupport = inputValues.get('runtimeDerivedSupport');
  if (runtimeDerivedSupport !== undefined) {
    getOwnEnumerableDataEntries(runtimeDerivedSupport, 'ResolveLayerDescriptorInput.runtimeDerivedSupport');
    requireBoundedPlainDataGraph(runtimeDerivedSupport, 'ResolveLayerDescriptorInput.runtimeDerivedSupport');
  }
}

export function parseLayerValueReference(value: unknown): LayerValueReference {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    return { kind: 'literal' };
  }
  let entries: Array<[string, unknown]>;
  try {
    entries = getOwnEnumerableDataEntries(value, 'Layer value');
  } catch {
    return { kind: 'invalid', reason: 'schema' };
  }
  const values = new Map(entries);
  const hasParam = values.has('param');
  const hasState = values.has('state');
  if (hasParam && hasState) return { kind: 'invalid', reason: 'conflict' };
  if (hasParam) {
    const param = values.get('param');
    if (entries.length !== 1) return { kind: 'invalid', reason: 'schema' };
    return typeof param === 'string' && param.trim().length > 0
      ? { kind: 'param', key: param }
      : { kind: 'invalid', reason: 'param' };
  }
  if (hasState) {
    const state = values.get('state');
    if (entries.length !== 1) return { kind: 'invalid', reason: 'schema' };
    return typeof state === 'string' && state.trim().length > 0
      ? { kind: 'state', key: state }
      : { kind: 'invalid', reason: 'state' };
  }
  return { kind: 'object' };
}

export function resolveLayerValue(
  value: VisualizationLayerValue,
  params: Record<string, unknown>,
  state: Record<string, unknown>,
): unknown {
  const reference = parseLayerValueReference(value);
  if (reference.kind === 'invalid') {
    throw new Error(`Invalid layer value reference (${reference.reason}).`);
  }
  if (reference.kind === 'param') return hasOwn(params, reference.key) ? params[reference.key] : undefined;
  if (reference.kind === 'state') return hasOwn(state, reference.key) ? state[reference.key] : undefined;
  return value;
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function describeValue(value: unknown) {
  try {
    return canonicalJson(value);
  } catch {
    return typeof value;
  }
}

function requireExactResolveInput(value: ResolveLayerDescriptorInput) {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('ResolveLayerDescriptorInput must be a plain object.');
  }
  for (const key of Object.keys(value)) {
    if (!RESOLVE_INPUT_ALLOWED_KEYS.has(key)) {
      throw new Error(`ResolveLayerDescriptorInput contains unexpected key "${key}".`);
    }
  }
  for (const key of RESOLVE_INPUT_REQUIRED_KEYS) {
    if (!hasOwn(value, key)) throw new Error(`ResolveLayerDescriptorInput is missing required key "${key}".`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const stack: object[] = [value];
  const seen = new Set<object>();
  const objects: object[] = [];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    objects.push(current);
    for (const child of Object.values(current as Record<string, unknown>)) {
      if (child !== null && typeof child === 'object') stack.push(child);
    }
  }
  for (let index = objects.length - 1; index >= 0; index -= 1) Object.freeze(objects[index]);
  return value;
}

function requireNonemptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string, minimum?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
    const suffix = minimum === undefined ? '' : ` and at least ${minimum}`;
    throw new Error(`${label} must be finite${suffix}.`);
  }
  return value;
}

function optionalFiniteNumber(value: unknown, label: string, minimum = 0): number | undefined {
  if (value === undefined) return undefined;
  return requireFiniteNumber(value, label, minimum);
}

function requireFiniteTuple(value: unknown, label: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`${label} must be a two-number tuple.`);
  }
  const first = requireFiniteNumber(value[0], `${label}[0]`);
  const second = requireFiniteNumber(value[1], `${label}[1]`);
  if (first > second) throw new Error(`${label} must be ordered.`);
  return [first, second];
}

function requireAccessor(value: unknown, label: string): string {
  if (!isKnownAccessorId(value)) throw new Error(`${label} references unknown accessor "${String(value)}".`);
  return value;
}

function requireUnit(value: unknown, label: string): UnitValue['unit'] {
  if (value !== 'meters' && value !== 'pixels') {
    throw new Error(`${label} has an unsupported unit "${String(value)}".`);
  }
  return value;
}

function requireAccessorMapping(
  accessorIds: Record<string, string>,
  rendererProp: string,
  expectedAccessor: string,
  layerLabel: string,
) {
  const actual = accessorIds[rendererProp];
  if (actual !== expectedAccessor) {
    throw new Error(
      `${layerLabel} ${rendererProp} accessor must match ${expectedAccessor}; received ${String(actual)}.`,
    );
  }
}

function validateClamp(minimum: number | undefined, maximum: number | undefined, label: string) {
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw new Error(`${label} minimum cannot exceed maximum.`);
  }
}

function validateCalibration(calibration: CameraCalibrationConfig) {
  if (!Number.isInteger(calibration.version) || calibration.version <= 0) {
    throw new Error('cameraCalibration.version must be a positive integer.');
  }
  requireFiniteNumber(calibration.referenceZoom, 'cameraCalibration.referenceZoom');
  const referenceSafeAreaPx = requireFiniteNumber(
    calibration.referenceSafeAreaPx,
    'cameraCalibration.referenceSafeAreaPx',
  );
  if (referenceSafeAreaPx <= 0) throw new Error('cameraCalibration.referenceSafeAreaPx must be positive.');
  for (const [name, unit] of Object.entries(REQUIRED_CAMERA_CALIBRATION_METRIC_UNITS)) {
    const metric = calibration.metrics[name];
    if (!metric) throw new Error(`cameraCalibration.metrics.${name} is required.`);
    if (metric.unit !== unit) throw new Error(`cameraCalibration.metrics.${name}.unit must be ${unit}.`);
  }
  for (const [name, metric] of Object.entries(calibration.metrics)) {
    requireNonemptyString(metric.unit, `cameraCalibration.metrics.${name}.unit`);
    const lo = requireFiniteNumber(metric.lo, `cameraCalibration.metrics.${name}.lo`);
    const hi = requireFiniteNumber(metric.hi, `cameraCalibration.metrics.${name}.hi`);
    if (lo >= hi) throw new Error(`cameraCalibration.metrics.${name} bounds must be strictly ordered (lo < hi).`);
    requireNonemptyString(metric.source, `cameraCalibration.metrics.${name}.source`);
  }
}

function validateInputAssociations(input: ResolveLayerDescriptorInput) {
  if (input.layer.dataRef !== input.dataFile.id) {
    throw new Error(
      `Layer "${input.layer.id}" dataRef "${input.layer.dataRef}" does not match dataFile "${input.dataFile.id}".`,
    );
  }
  const declaredFile = input.dataset.files.find((candidate) => candidate.id === input.dataFile.id);
  if (!declaredFile || canonicalJson(declaredFile) !== canonicalJson(input.dataFile)) {
    throw new Error(`dataFile "${input.dataFile.id}" does not exactly match dataset "${input.dataset.id}".`);
  }
  const declaredLayer = input.visualization.layers.find((candidate) => candidate.id === input.layer.id);
  if (!declaredLayer || canonicalJson(declaredLayer) !== canonicalJson(input.layer)) {
    throw new Error(`Layer "${input.layer.id}" does not exactly match visualization "${input.visualization.id}".`);
  }
  const selectedDatasetId = resolveVisualizationDatasetId(input.visualization, input.params);
  const isSelectedDataset = input.dataset.id === selectedDatasetId;
  const isUploadedDataset = input.dataset.id === `upload:${input.visualization.id}`;
  if (!isSelectedDataset && !isUploadedDataset) {
    throw new Error(
      `Dataset "${input.dataset.id}" is unrelated to visualization "${input.visualization.id}" selection.`,
    );
  }
}

function validateSelectionContract(input: ResolveLayerDescriptorInput) {
  const selection = input.layer.selection;
  const envelope = input.layer.cameraEnvelope;
  const label = `Layer "${input.layer.id}" selection`;
  if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) {
    throw new Error(`${label} is required.`);
  }

  if (!Array.isArray(selection.supported) || selection.supported.length === 0) {
    throw new Error(`${label}.supported must be a nonempty array.`);
  }
  for (const accessorField of ['stableIdAccessor', 'coordinateAccessor', 'pathAccessor'] as const) {
    if (selection[accessorField] !== undefined) {
      requireAccessor(selection[accessorField], `${label}.${accessorField}`);
    }
  }

  if (selection.renderQueryId === undefined) {
    if (envelope.producer !== 'scatter-point') {
      throw new Error(`${label} must declare a known render query for producer "${envelope.producer}".`);
    }
    if (selection.supported.length !== 1 || selection.supported[0] !== 'click') {
      throw new Error(`${label}.supported must exactly match the queryless scatter-point click contract.`);
    }
    if (selection.pathAccessor !== undefined) {
      throw new Error(`${label}.pathAccessor is not permitted by the queryless scatter-point contract.`);
    }
    const coordinateAccessor = requireAccessor(selection.coordinateAccessor, `${label}.coordinateAccessor`);
    if (coordinateAccessor !== envelope.positionAccessor) {
      throw new Error(`${label}.coordinateAccessor must match the camera envelope positionAccessor.`);
    }
    return;
  }

  const query = getRenderQueryContract(selection.renderQueryId);
  if (!query) {
    throw new Error(`${label} references unknown render query "${String(selection.renderQueryId)}".`);
  }
  if (query.producer !== envelope.producer) {
    throw new Error(
      `${label} render query producer "${query.producer}" does not match envelope producer "${envelope.producer}".`,
    );
  }
  if (
    new Set(selection.supported).size !== selection.supported.length ||
    selection.supported.some((mode) => !query.supported.some((supportedMode) => supportedMode === mode))
  ) {
    throw new Error(
      `${label}.supported contains a duplicate or mode unsupported by render query "${selection.renderQueryId}".`,
    );
  }

  const contractedSelectionAccessor = 'selectionAccessor' in query ? query.selectionAccessor : undefined;
  for (const accessorField of ['coordinateAccessor', 'pathAccessor'] as const) {
    if (selection[accessorField] !== undefined && contractedSelectionAccessor !== accessorField) {
      throw new Error(`${label}.${accessorField} is not permitted by render query "${selection.renderQueryId}".`);
    }
  }

  if ('selectionAccessor' in query && 'envelopeAccessor' in query) {
    const selectionAccessor = requireAccessor(
      selection[query.selectionAccessor],
      `${label}.${query.selectionAccessor}`,
    );
    const envelopeAccessor = requireAccessor(
      (envelope as unknown as Record<string, unknown>)[query.envelopeAccessor],
      `${label} envelope ${query.envelopeAccessor}`,
    );
    if (selectionAccessor !== envelopeAccessor) {
      throw new Error(`${label}.${query.selectionAccessor} must match the camera envelope accessor.`);
    }
  }

  if ('positionAccessorId' in query) {
    if (envelope.producer !== 'hexagon-cell' || envelope.positionAccessor !== query.positionAccessorId) {
      throw new Error(`${label} must use render query position accessor "${query.positionAccessorId}".`);
    }
  }
}

export function getRendererSupportDefaults(
  layerType: string,
  layerId: string,
  rowCount: number,
): Record<string, unknown> {
  if (!Number.isInteger(rowCount) || rowCount < 0) throw new Error('rowCount must be a non-negative integer.');

  if (layerType === 'HexagonLayer') {
    return { extruded: true, elevationRange: [0, 3000], elevationScale: rowCount ? 50 : 0 };
  }
  if (layerType === 'LineLayer') {
    return { getWidth: 1, widthUnits: 'pixels', widthScale: 1 };
  }
  if (layerType === 'ScatterplotLayer' && layerId === 'point-map') {
    return {
      getRadius: 100,
      radiusUnits: 'meters',
      radiusScale: 1,
      radiusMinPixels: 2,
      billboard: true,
    };
  }
  if (layerType === 'ScatterplotLayer' && layerId === 'scatter') {
    return {
      getRadius: 1,
      radiusUnits: 'meters',
      radiusScale: 1,
      radiusMinPixels: 2,
      radiusMaxPixels: 5,
      billboard: true,
    };
  }
  if (layerType === 'ScatterplotLayer') {
    return {
      getRadius: 1,
      radiusUnits: 'meters',
      radiusScale: 1,
      radiusMinPixels: 2,
      billboard: true,
    };
  }
  if (layerType === 'HeatmapLayer') return {};
  if (layerType === 'TripsLayer') {
    return {
      getWidth: 1,
      widthMinPixels: 2,
      widthUnits: 'pixels',
      widthScale: 1,
      billboard: true,
      jointRounded: true,
      capRounded: true,
    };
  }
  if (layerType === 'PolygonLayer') return { extruded: true, elevationScale: 1 };

  throw new Error(`No renderer support defaults exist for ${layerType} layer "${layerId}".`);
}

function requirePermittedProps(
  source: Record<string, unknown>,
  sourceName: string,
  permittedResolvedProps: Readonly<Record<string, true>>,
) {
  for (const key of Object.keys(source)) {
    if (!hasOwn(permittedResolvedProps, key)) {
      throw new Error(`${sourceName} prop "${key}" is not permitted by the closed renderer adapter.`);
    }
  }
}

function resolveProps(
  input: ResolveLayerDescriptorInput,
  permittedResolvedProps: Readonly<Record<string, true>>,
  sealedProps: Readonly<Record<string, true>>,
) {
  const declaredProps = input.layer.props ?? {};
  const declaredPropEntries = getOwnEnumerableDataEntries(declaredProps, `Layer "${input.layer.id}" props`);
  const runtimePropEntries = getOwnEnumerableDataEntries(
    input.runtimeDerivedProps ?? {},
    `Layer "${input.layer.id}" runtime-derived props`,
  );
  const runtimeProps = Object.fromEntries(runtimePropEntries);
  const defaults = getRendererSupportDefaults(input.layer.type, input.layer.id, input.rowCount);
  requirePermittedProps(declaredProps, 'Catalog/state', permittedResolvedProps);
  requirePermittedProps(runtimeProps, 'Runtime-derived', permittedResolvedProps);
  requirePermittedProps(defaults, 'Renderer default', permittedResolvedProps);

  const catalogProps: Record<string, unknown> = {};
  for (const [key, value] of declaredPropEntries) {
    const resolved = resolveLayerValue(value as VisualizationLayerValue, input.params, input.state);
    if (resolved !== undefined) catalogProps[key] = resolved;
  }

  for (const sealedProp of Object.keys(sealedProps)) {
    for (const [sourceName, source] of [
      ['renderer defaults', defaults],
      ['catalog/state props', catalogProps],
      ['runtime-derived props', runtimeProps],
    ] as const) {
      if (hasOwn(source, sealedProp) && source[sealedProp] !== undefined && source[sealedProp] !== true) {
        throw new Error(
          `${sealedProp} is sealed to true; ${sourceName} supplied ${describeValue(source[sealedProp])}.`,
        );
      }
    }
  }

  const resolvedProps = { ...defaults, ...catalogProps, ...runtimeProps };
  for (const sealedProp of Object.keys(sealedProps)) resolvedProps[sealedProp] = true;
  canonicalJson(resolvedProps);
  return resolvedProps;
}

function resolveAccessorIds(
  input: ResolveLayerDescriptorInput,
  permittedAccessorProps: Readonly<Record<string, true>>,
) {
  const accessorIds: Record<string, string> = {};
  for (const [propName, accessorId] of getOwnEnumerableDataEntries(
    input.layer.accessors ?? {},
    `Layer "${input.layer.id}" accessors`,
  )) {
    if (!hasOwn(permittedAccessorProps, propName)) {
      throw new Error(`Accessor prop "${propName}" is not permitted by the closed renderer adapter.`);
    }
    accessorIds[propName] = requireAccessor(accessorId, `${input.layer.id}.${propName}`);
  }
  return accessorIds;
}

function resolveSupport(
  input: ResolveLayerDescriptorInput,
  resolvedProps: Record<string, unknown>,
  accessorIds: Record<string, string>,
  accessorDefaults: Readonly<Record<string, number>>,
): ResolvedLayerSupport {
  const envelope = input.layer.cameraEnvelope;
  const label = `Layer "${input.layer.id}"`;
  const runtimeDerivedSupport = Object.fromEntries(
    getOwnEnumerableDataEntries(input.runtimeDerivedSupport ?? {}, `${label} runtime-derived support`),
  );
  const permittedRuntimeSupportKeys =
    envelope.producer === 'hexagon-cell' ? new Set([envelope.elevation.domainProp]) : new Set<string>();
  for (const key of Object.keys(runtimeDerivedSupport)) {
    if (!permittedRuntimeSupportKeys.has(key)) {
      throw new Error(`${label} runtime-derived support "${key}" is not permitted by its camera envelope.`);
    }
  }
  const antialiasBufferPx = requireFiniteNumber(envelope.support.antialiasBufferPx, `${label} antialiasBufferPx`, 0);
  if (
    (envelope.producer === 'hexagon-cell' || envelope.producer === 'polygon-extrusion') &&
    resolvedProps.extruded !== true
  ) {
    throw new Error(`${label} ${envelope.producer} support requires extruded true.`);
  }

  if (envelope.producer === 'hexagon-cell') {
    const positionAccessorId = requireAccessor(envelope.positionAccessor, `${label} positionAccessor`);
    requireAccessor(accessorIds.getPosition, `${label} renderer getPosition`);
    if (positionAccessorId !== HEXAGON_SELECTION_POSITION_ACCESSOR_ID) {
      throw new Error(`${label} strict hexagon support requires ${HEXAGON_SELECTION_POSITION_ACCESSOR_ID}.`);
    }
    if (envelope.radius.unit !== 'meters') throw new Error(`${label} hexagon radius unit must be meters.`);
    const radiusMeters = requireFiniteNumber(resolvedProps.radius, `${label} radius`, 0);
    const declaredRadius = requireFiniteNumber(input.params[envelope.radius.param], `${label} radius parameter`, 0);
    if (radiusMeters !== declaredRadius)
      throw new Error(`${label} resolved radius does not match its envelope parameter.`);
    const coverage = requireFiniteNumber(resolvedProps[envelope.coverage.prop], `${label} coverage`, 0);
    if (coverage > 1) throw new Error(`${label} coverage must not exceed 1.`);
    const rendererElevationDomain = resolvedProps[envelope.elevation.domainProp];
    const supportElevationDomain = runtimeDerivedSupport[envelope.elevation.domainProp];
    return {
      producer: envelope.producer,
      positionAccessorId,
      radiusMeters,
      coverage,
      elevationRange: requireFiniteTuple(resolvedProps[envelope.elevation.rangeProp], `${label} elevationRange`),
      elevationScale: requireFiniteNumber(resolvedProps[envelope.elevation.scaleProp], `${label} elevationScale`, 0),
      elevationDomain: requireFiniteTuple(
        supportElevationDomain ?? rendererElevationDomain,
        `${label} elevationDomain`,
      ),
      antialiasBufferPx,
    };
  }

  if (envelope.producer === 'heatmap-kernel') {
    const positionAccessorId = requireAccessor(envelope.positionAccessor, `${label} positionAccessor`);
    requireAccessorMapping(accessorIds, 'getPosition', positionAccessorId, label);
    if (envelope.radius.unit !== 'pixels') throw new Error(`${label} heatmap radius unit must be pixels.`);
    const alphaCutoff = requireFiniteNumber(envelope.support.alphaCutoff, `${label} alphaCutoff`);
    if (alphaCutoff <= 0 || alphaCutoff > 1) {
      throw new Error(`${label} alphaCutoff must be inside (0, 1].`);
    }
    const weightAccessorId = envelope.weightAccessor;
    if (weightAccessorId !== undefined) {
      const knownWeightAccessor = requireAccessor(weightAccessorId, `${label} weightAccessor`);
      requireAccessorMapping(accessorIds, 'getWeight', knownWeightAccessor, label);
      return {
        producer: envelope.producer,
        positionAccessorId,
        weightAccessorId: knownWeightAccessor,
        radiusPixels: requireFiniteNumber(resolvedProps[envelope.radius.prop], `${label} radiusPixels`, 0),
        alphaCutoff,
        antialiasBufferPx,
      };
    }
    if (accessorIds.getWeight !== undefined) {
      throw new Error(`${label} getWeight accessor must match the camera envelope.`);
    }
    const weightDefault = requireFiniteNumber(accessorDefaults.getWeight, `${label} weightDefault`);
    return {
      producer: envelope.producer,
      positionAccessorId,
      weightDefault,
      radiusPixels: requireFiniteNumber(resolvedProps[envelope.radius.prop], `${label} radiusPixels`, 0),
      alphaCutoff,
      antialiasBufferPx,
    };
  }

  if (envelope.producer === 'scatter-point') {
    const positionAccessorId = requireAccessor(envelope.positionAccessor, `${label} positionAccessor`);
    requireAccessorMapping(accessorIds, 'getPosition', positionAccessorId, label);
    const radius: UnitValue = {
      value: requireFiniteNumber(resolvedProps[envelope.radius.prop], `${label} radius`, 0),
      unit: requireUnit(resolvedProps[envelope.radius.unitProp], `${label} radius`),
    };
    const radiusMinPixels = optionalFiniteNumber(resolvedProps[envelope.minPixelsProp], `${label} radiusMinPixels`);
    const radiusMaxPixels = optionalFiniteNumber(resolvedProps[envelope.maxPixelsProp], `${label} radiusMaxPixels`);
    validateClamp(radiusMinPixels, radiusMaxPixels, `${label} radius clamp`);
    if (resolvedProps.billboard !== true) throw new Error(`${label} billboard is sealed to true.`);
    return {
      producer: envelope.producer,
      positionAccessorId,
      radius,
      radiusScale: requireFiniteNumber(resolvedProps[envelope.radius.scaleProp], `${label} radiusScale`, 0),
      ...(radiusMinPixels === undefined ? {} : { radiusMinPixels }),
      ...(radiusMaxPixels === undefined ? {} : { radiusMaxPixels }),
      antialiasBufferPx,
      billboard: true,
    };
  }

  if (envelope.producer === 'line-path') {
    const sourcePositionAccessorId = requireAccessor(
      envelope.sourcePositionAccessor,
      `${label} sourcePositionAccessor`,
    );
    const targetPositionAccessorId = requireAccessor(
      envelope.targetPositionAccessor,
      `${label} targetPositionAccessor`,
    );
    requireAccessorMapping(accessorIds, 'getSourcePosition', sourcePositionAccessorId, label);
    requireAccessorMapping(accessorIds, 'getTargetPosition', targetPositionAccessorId, label);
    const widthAccessorId =
      envelope.widthAccessor === undefined
        ? undefined
        : requireAccessor(envelope.widthAccessor, `${label} widthAccessor`);
    if (widthAccessorId !== undefined) requireAccessorMapping(accessorIds, 'getWidth', widthAccessorId, label);
    else if (accessorIds.getWidth !== undefined)
      throw new Error(`${label} getWidth requires a widthAccessor contract.`);
    const widthMinPixels = optionalFiniteNumber(resolvedProps[envelope.minPixelsProp], `${label} widthMinPixels`);
    const widthMaxPixels = optionalFiniteNumber(resolvedProps[envelope.maxPixelsProp], `${label} widthMaxPixels`);
    validateClamp(widthMinPixels, widthMaxPixels, `${label} width clamp`);
    const widthUnit = requireUnit(resolvedProps[envelope.width.unitProp], `${label} width`);
    if (widthUnit !== 'pixels') throw new Error(`${label} adapter v1 width unit must be pixels.`);
    return {
      producer: envelope.producer,
      sourcePositionAccessorId,
      targetPositionAccessorId,
      ...(widthAccessorId === undefined ? {} : { widthAccessorId }),
      width: {
        value: requireFiniteNumber(resolvedProps[envelope.width.prop], `${label} width`, 0),
        unit: widthUnit,
      },
      widthScale: requireFiniteNumber(resolvedProps[envelope.width.scaleProp], `${label} widthScale`, 0),
      ...(widthMinPixels === undefined ? {} : { widthMinPixels }),
      ...(widthMaxPixels === undefined ? {} : { widthMaxPixels }),
      antialiasBufferPx,
    };
  }

  if (envelope.producer === 'trip-path') {
    const pathAccessorId = requireAccessor(envelope.pathAccessor, `${label} pathAccessor`);
    requireAccessorMapping(accessorIds, 'getPath', pathAccessorId, label);
    const widthMinPixels = optionalFiniteNumber(resolvedProps[envelope.minPixelsProp], `${label} widthMinPixels`);
    const widthMaxPixels = optionalFiniteNumber(resolvedProps[envelope.maxPixelsProp], `${label} widthMaxPixels`);
    validateClamp(widthMinPixels, widthMaxPixels, `${label} width clamp`);
    for (const sealed of ['billboard', 'jointRounded', 'capRounded'] as const) {
      if (resolvedProps[sealed] !== true) throw new Error(`${label} ${sealed} is sealed to true.`);
    }
    const widthUnit = requireUnit(resolvedProps[envelope.width.unitProp], `${label} width`);
    if (widthUnit !== 'pixels') throw new Error(`${label} adapter v1 width unit must be pixels.`);
    return {
      producer: envelope.producer,
      pathAccessorId,
      width: {
        value: requireFiniteNumber(resolvedProps[envelope.width.prop], `${label} width`, 0),
        unit: widthUnit,
      },
      widthScale: requireFiniteNumber(resolvedProps[envelope.width.scaleProp], `${label} widthScale`, 0),
      ...(widthMinPixels === undefined ? {} : { widthMinPixels }),
      ...(widthMaxPixels === undefined ? {} : { widthMaxPixels }),
      antialiasBufferPx,
      billboard: true,
      jointRounded: true,
      capRounded: true,
    };
  }

  if (envelope.producer === 'polygon-extrusion') {
    const polygonAccessorId = requireAccessor(envelope.polygonAccessor, `${label} polygonAccessor`);
    requireAccessorMapping(accessorIds, 'getPolygon', polygonAccessorId, label);
    const resolvedElevationScale = requireFiniteNumber(resolvedProps.elevationScale, `${label} elevationScale`, 0);
    const envelopeElevationScale = requireFiniteNumber(envelope.elevationScale, `${label} envelope elevationScale`, 0);
    if (resolvedElevationScale !== envelopeElevationScale) {
      throw new Error(`${label} rendered and envelope elevationScale values must match.`);
    }
    if (envelope.elevationUnit !== 'meters') throw new Error(`${label} elevation unit must be meters.`);
    if (envelope.wrapMode !== 'geometry' && envelope.wrapMode !== 'full-world') {
      throw new Error(`${label} wrapMode is invalid.`);
    }
    const elevationAccessorId = envelope.elevationAccessor;
    if (elevationAccessorId !== undefined) {
      const knownElevationAccessor = requireAccessor(elevationAccessorId, `${label} elevationAccessor`);
      requireAccessorMapping(accessorIds, 'getElevation', knownElevationAccessor, label);
      return {
        producer: envelope.producer,
        polygonAccessorId,
        elevationAccessorId: knownElevationAccessor,
        baseMeters: requireFiniteNumber(envelope.baseMeters, `${label} baseMeters`),
        elevationScale: envelopeElevationScale,
        elevationUnit: 'meters',
        wrapMode: envelope.wrapMode,
        antialiasBufferPx,
      };
    }
    if (accessorIds.getElevation !== undefined) {
      throw new Error(`${label} getElevation accessor must match the camera envelope.`);
    }
    const elevationDefaultMeters = requireFiniteNumber(
      accessorDefaults.getElevation,
      `${label} elevationDefaultMeters`,
    );
    return {
      producer: envelope.producer,
      polygonAccessorId,
      elevationDefaultMeters,
      baseMeters: requireFiniteNumber(envelope.baseMeters, `${label} baseMeters`),
      elevationScale: envelopeElevationScale,
      elevationUnit: 'meters',
      wrapMode: envelope.wrapMode,
      antialiasBufferPx,
    };
  }

  throw new Error(`${label} has an unsupported envelope producer.`);
}

export function resolveLayerDescriptor(input: ResolveLayerDescriptorInput): ResolvedLayerDescriptor {
  requireExactResolveInput(input);
  requireResolverContainerPreflight(input);
  const shapeIssues = validateLayerCameraContractShape(input.layer);
  if (shapeIssues.length > 0) {
    const issue = shapeIssues[0];
    throw new Error(`[${issue.code}] ${issue.path}: ${issue.detail}`);
  }
  requireBoundedPlainDataGraph(input, 'ResolveLayerDescriptorInput');
  if (VERSION !== STRICT_RENDERER_LIBRARY_VERSION) {
    throw new Error(
      `Strict renderer adapters require deck.gl ${STRICT_RENDERER_LIBRARY_VERSION}; runtime is ${VERSION}.`,
    );
  }
  requireNonemptyString(input.catalogRevision, 'catalogRevision');
  requireNonemptyString(input.visualization.revision, 'visualization.revision');
  requireNonemptyString(input.dataset.id, 'dataset.id');
  requireNonemptyString(input.dataFile.id, 'dataFile.id');
  requireNonemptyString(input.dataRevision, 'dataRevision');
  validateInputAssociations(input);
  validateSelectionContract(input);
  if (!Number.isInteger(input.layer.rendererVersion) || input.layer.rendererVersion <= 0) {
    throw new Error('rendererVersion must be a positive integer.');
  }
  if (
    !Number.isInteger(input.layer.cameraEnvelope.producerVersion) ||
    input.layer.cameraEnvelope.producerVersion <= 0
  ) {
    throw new Error('producerVersion must be a positive integer.');
  }

  const adapter = findRendererAdapterContract(
    input.layer.type,
    input.layer.cameraEnvelope.producer,
    input.layer.rendererVersion,
  );
  if (!adapter || adapter.rendererLibraryVersion !== VERSION) {
    throw new Error(
      `No closed renderer adapter exists for ${input.layer.type}/${input.layer.cameraEnvelope.producer}/v${input.layer.rendererVersion}/${VERSION}.`,
    );
  }

  for (const [propName, requiredValue] of Object.entries(adapter.sealedEnvelopeProps)) {
    const actualValue = (input.layer.cameraEnvelope as unknown as Record<string, unknown>)[propName];
    if (actualValue !== requiredValue) {
      throw new Error(
        `[renderer-adapter.sealed-envelope] ${propName} is sealed to ${describeValue(requiredValue)}; received ${describeValue(actualValue)}.`,
      );
    }
  }

  validateCalibration(input.layer.cameraCalibration);
  canonicalJson(input.layer.cameraEnvelope);
  canonicalJson(input.layer.selection);
  const resolvedProps = resolveProps(input, adapter.permittedResolvedProps, adapter.sealedProps);
  const accessorIds = resolveAccessorIds(input, adapter.permittedAccessorProps);
  const resolvedSupport = resolveSupport(input, resolvedProps, accessorIds, adapter.accessorDefaults);

  const digestPayload = {
    schemaVersion: 1 as const,
    catalogRevision: input.catalogRevision,
    visualizationId: input.visualization.id,
    visualizationRevision: input.visualization.revision,
    datasetId: input.dataset.id,
    dataRevision: input.dataRevision,
    layerId: input.layer.id,
    layerType: input.layer.type,
    rendererVersion: input.layer.rendererVersion,
    rendererLibraryVersion: adapter.rendererLibraryVersion,
    declaredProps: cloneCanonical(input.layer.props ?? {}),
    resolvedProps: cloneCanonical(resolvedProps),
    accessorIds: cloneCanonical(accessorIds),
    resolvedSupport: cloneCanonical(resolvedSupport),
    selection: cloneCanonical(input.layer.selection),
    cameraEnvelope: cloneCanonical(input.layer.cameraEnvelope),
    cameraCalibration: cloneCanonical(input.layer.cameraCalibration),
  };
  const descriptor: ResolvedLayerDescriptor = {
    ...digestPayload,
    resolvedLayerDigest: digestCanonical(digestPayload),
  };
  const resolved = deepFreeze(descriptor);
  certifiedResolvedLayerDescriptors.add(resolved);
  return resolved;
}

export function isCertifiedResolvedLayerDescriptor(value: unknown): value is ResolvedLayerDescriptor {
  return typeof value === 'object' && value !== null && certifiedResolvedLayerDescriptors.has(value);
}
