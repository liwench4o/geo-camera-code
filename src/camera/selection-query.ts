import type { CustomObject } from '../interfaces';
import { getRenderQueryContract, isKnownRenderQueryId, type RenderQueryId } from '../visualization/camera-contract';
import { snapshotPlainData } from '../visualization/immutable-data';
import type { ResolvedLayerRuntime } from '../visualization/types';
import { digestCanonical } from './geometry/canonical-digest';
import type { EnvelopeResult, LngLat } from './geometry/types';
import {
  validateSelectionState,
  type GeoJsonGeometry,
  type SelectionBinding,
  type SelectionMember,
} from './selection-state';

const MAX_SNAPSHOT_DEPTH = 64;
const MAX_SNAPSHOT_NODES = 2_000_000;
const MERCATOR_LATITUDE_LIMIT = 85.051129;
const certifiedSelectionSnapshots = new WeakSet<object>();

export interface HeatmapHaloCertification {
  readonly kind: 'heatmap-halo-complete-v1';
  readonly haloRadiusPixels: number;
  readonly contributorSet: 'complete';
}

export interface SourceObjectSelectionMarkInput {
  kind: 'source-object';
  object: CustomObject;
}

export interface HexagonCellSelectionMarkInput {
  kind: 'hexagon-cell';
  cellId: string;
  center: [number, number];
  footprintRing: LngLat[];
  elevationValue: number;
  count: number;
}

export type ResolvedSelectionMarkInput = SourceObjectSelectionMarkInput | HexagonCellSelectionMarkInput;

export type ResolvedSelectionMark =
  | { readonly kind: 'source-object'; readonly object: Readonly<CustomObject> }
  | {
      readonly kind: 'hexagon-cell';
      readonly cellId: string;
      readonly center: readonly [number, number];
      readonly footprintRing: readonly (readonly [number, number])[];
      readonly elevationValue: number;
      readonly count: number;
    };

export interface RenderQuerySnapshotInput {
  schemaVersion: 1;
  queryId: RenderQueryId;
  sceneRevision: string;
  dataRevision: string;
  resolvedLayerDigest: string;
  marks: ResolvedSelectionMarkInput[];
  certification?: HeatmapHaloCertification;
}

export interface RenderQuerySnapshot {
  readonly schemaVersion: 1;
  readonly queryId: RenderQueryId;
  readonly sceneRevision: string;
  readonly dataRevision: string;
  readonly resolvedLayerDigest: string;
  readonly marks: readonly ResolvedSelectionMark[];
  readonly certification?: HeatmapHaloCertification;
}

export interface GeometryAssociationSnapshotInput {
  schemaVersion: 1;
  resolverId: string;
  sceneRevision: string;
  dataRevision: string;
  resolvedLayerDigest: string;
  marks: ResolvedSelectionMarkInput[];
  certification?: HeatmapHaloCertification;
}

export interface GeometryAssociationSnapshot {
  readonly schemaVersion: 1;
  readonly resolverId: string;
  readonly sceneRevision: string;
  readonly dataRevision: string;
  readonly resolvedLayerDigest: string;
  readonly marks: readonly ResolvedSelectionMark[];
  readonly certification?: HeatmapHaloCertification;
}

export interface ResolvedSelectionSnapshot {
  readonly schemaVersion: 1;
  readonly memberId: string;
  readonly sceneRevision: string;
  readonly selectionRevision: string;
  readonly resolvedLayerDigest: string;
  readonly provenance: Readonly<SelectionMember['provenance']>;
  readonly bindingKind: SelectionBinding['kind'];
  readonly binding: Readonly<SelectionBinding>;
  readonly query?: RenderQuerySnapshot;
  readonly association?: GeometryAssociationSnapshot;
  readonly geometry?: {
    readonly geometry: Readonly<GeoJsonGeometry>;
    readonly wrapMode: 'minimum-arc' | 'full-world';
  };
  readonly marks: readonly ResolvedSelectionMark[];
}

export interface SelectionResolutionRegistry {
  resolveFeatureRefs(member: SelectionMember, runtime: ResolvedLayerRuntime): EnvelopeResult<readonly CustomObject[]>;
  resolveRenderQuery(member: SelectionMember, runtime: ResolvedLayerRuntime): EnvelopeResult<RenderQuerySnapshotInput>;
  resolveDrawnGeometryMarks?(
    member: SelectionMember,
    runtime: ResolvedLayerRuntime,
  ): EnvelopeResult<GeometryAssociationSnapshotInput>;
}

function inputError(message: string): Error {
  const error = new TypeError(`selection-query: ${message}`);
  error.name = 'SelectionQueryInputError';
  return error;
}

function snapshot<Value>(value: Value, label: string): Value {
  return snapshotPlainData(value, {
    label,
    maxDepth: MAX_SNAPSHOT_DEPTH,
    maxNodes: MAX_SNAPSHOT_NODES,
    createError: inputError,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw inputError(`${label} must use the exact schema [${sortedExpected.join(', ')}].`);
  }
}

function requireNonemptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw inputError(`${label} must be a nonempty string.`);
  }
}

function requireFinite(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw inputError(`${label} must be finite.`);
  }
}

function requireCoordinate(
  value: unknown,
  label: string,
  canonicalLongitude: boolean,
): asserts value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw inputError(`${label} must be a two-number coordinate.`);
  }
  requireFinite(value[0], `${label}[0]`);
  requireFinite(value[1], `${label}[1]`);
  if (canonicalLongitude && (value[0] < -180 || value[0] > 180)) {
    throw inputError(`${label}[0] must be a canonical longitude.`);
  }
  if (value[1] < -MERCATOR_LATITUDE_LIMIT || value[1] > MERCATOR_LATITUDE_LIMIT) {
    throw inputError(`${label}[1] exceeds the Mercator latitude limit.`);
  }
}

function assertJsonValue(value: unknown, label: string): void {
  const pending: Array<{ value: unknown; label: string }> = [{ value, label }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (
      current.value === null ||
      typeof current.value === 'string' ||
      typeof current.value === 'boolean' ||
      (typeof current.value === 'number' && Number.isFinite(current.value))
    ) {
      continue;
    }
    if (typeof current.value !== 'object' || current.value === null) {
      throw inputError(`${current.label} must contain JSON data only.`);
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: current.value[index], label: `${current.label}[${index}]` });
      }
      continue;
    }
    if (!isRecord(current.value)) {
      throw inputError(`${current.label} must contain plain JSON objects only.`);
    }
    for (const key of Object.keys(current.value)) {
      pending.push({ value: current.value[key], label: `${current.label}.${key}` });
    }
  }
}

function validateSourceObjectMark(mark: Record<string, unknown>, label: string): void {
  requireExactKeys(mark, ['kind', 'object'], label);
  if (!isRecord(mark.object)) throw inputError(`${label}.object must be a plain object.`);
  assertJsonValue(mark.object, `${label}.object`);
}

function validateHexagonCellMark(mark: Record<string, unknown>, label: string): void {
  requireExactKeys(mark, ['kind', 'cellId', 'center', 'footprintRing', 'elevationValue', 'count'], label);
  requireNonemptyString(mark.cellId, `${label}.cellId`);
  requireCoordinate(mark.center, `${label}.center`, true);
  if (!Array.isArray(mark.footprintRing) || mark.footprintRing.length !== 7) {
    throw inputError(`${label}.footprintRing must contain six vertices plus a closed seventh vertex.`);
  }
  for (let index = 0; index < mark.footprintRing.length; index += 1) {
    requireCoordinate(mark.footprintRing[index], `${label}.footprintRing[${index}]`, false);
  }
  const first = mark.footprintRing[0] as [number, number];
  const last = mark.footprintRing[6] as [number, number];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    throw inputError(`${label}.footprintRing must be closed.`);
  }
  const unique = new Set(mark.footprintRing.slice(0, 6).map((coordinate) => `${coordinate[0]}:${coordinate[1]}`));
  if (unique.size !== 6) throw inputError(`${label}.footprintRing must have six distinct renderer vertices.`);
  requireFinite(mark.elevationValue, `${label}.elevationValue`);
  if (typeof mark.count !== 'number' || !Number.isSafeInteger(mark.count) || mark.count < 0) {
    throw inputError(`${label}.count must be a non-negative safe integer.`);
  }
}

function validateMarks(marks: unknown, label: string, expectedKind?: ResolvedSelectionMark['kind']): void {
  if (!Array.isArray(marks)) throw inputError(`${label} must be a dense array.`);
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    if (!isRecord(mark)) throw inputError(`${label}[${index}] must be a plain object.`);
    if (mark.kind !== 'source-object' && mark.kind !== 'hexagon-cell') {
      throw inputError(`${label}[${index}].kind is unsupported.`);
    }
    if (expectedKind !== undefined && mark.kind !== expectedKind) {
      throw inputError(`${label}[${index}] must be ${expectedKind}.`);
    }
    if (mark.kind === 'source-object') validateSourceObjectMark(mark, `${label}[${index}]`);
    else validateHexagonCellMark(mark, `${label}[${index}]`);
  }
}

function validateHeatmapHaloCertification(value: unknown, label: string): asserts value is HeatmapHaloCertification {
  if (!isRecord(value)) throw inputError(`${label} must be a plain object.`);
  requireExactKeys(value, ['kind', 'haloRadiusPixels', 'contributorSet'], label);
  if (value.kind !== 'heatmap-halo-complete-v1') {
    throw inputError(`${label}.kind must equal heatmap-halo-complete-v1.`);
  }
  requireFinite(value.haloRadiusPixels, `${label}.haloRadiusPixels`);
  if (value.haloRadiusPixels < 0) throw inputError(`${label}.haloRadiusPixels must be non-negative.`);
  if (value.contributorSet !== 'complete') throw inputError(`${label}.contributorSet must equal complete.`);
}

function validateRenderQuerySnapshot(snapshotValue: unknown): asserts snapshotValue is RenderQuerySnapshot {
  if (!isRecord(snapshotValue)) throw inputError('snapshot must be a plain object.');
  requireExactKeys(
    snapshotValue,
    [
      'schemaVersion',
      'queryId',
      'sceneRevision',
      'dataRevision',
      'resolvedLayerDigest',
      'marks',
      ...(snapshotValue.certification === undefined ? [] : ['certification']),
    ],
    'snapshot',
  );
  if (snapshotValue.schemaVersion !== 1) throw inputError('snapshot.schemaVersion must equal 1.');
  if (!isKnownRenderQueryId(snapshotValue.queryId)) throw inputError('snapshot.queryId is not registered.');
  requireNonemptyString(snapshotValue.sceneRevision, 'snapshot.sceneRevision');
  requireNonemptyString(snapshotValue.dataRevision, 'snapshot.dataRevision');
  requireNonemptyString(snapshotValue.resolvedLayerDigest, 'snapshot.resolvedLayerDigest');
  const contract = getRenderQueryContract(snapshotValue.queryId);
  if (!contract || contract.snapshotSchemaVersion !== snapshotValue.schemaVersion) {
    throw inputError('snapshot schema version does not match the registered query contract.');
  }
  validateMarks(snapshotValue.marks, 'snapshot.marks', contract.markKind);
  if (snapshotValue.queryId === 'select-heatmap-zone-v1') {
    validateHeatmapHaloCertification(snapshotValue.certification, 'snapshot.certification');
  } else if (snapshotValue.certification !== undefined) {
    throw inputError('snapshot.certification is only valid for a heatmap zone query.');
  }
}

export function createRenderQuerySnapshot(input: RenderQuerySnapshotInput): RenderQuerySnapshot {
  const owned = snapshot(input, 'render query snapshot');
  validateRenderQuerySnapshot(owned);
  return owned;
}

function createGeometryAssociationSnapshot(input: GeometryAssociationSnapshotInput): GeometryAssociationSnapshot {
  const owned = snapshot(input, 'geometry association snapshot');
  if (!isRecord(owned)) throw inputError('geometry association snapshot must be a plain object.');
  requireExactKeys(
    owned,
    [
      'schemaVersion',
      'resolverId',
      'sceneRevision',
      'dataRevision',
      'resolvedLayerDigest',
      'marks',
      ...(owned.certification === undefined ? [] : ['certification']),
    ],
    'geometry association snapshot',
  );
  if (owned.schemaVersion !== 1) throw inputError('geometry association snapshot schemaVersion must equal 1.');
  requireNonemptyString(owned.resolverId, 'geometry association snapshot.resolverId');
  if (!/-v[1-9]\d*$/.test(owned.resolverId)) {
    throw inputError('geometry association snapshot.resolverId must end in a positive version suffix.');
  }
  requireNonemptyString(owned.sceneRevision, 'geometry association snapshot.sceneRevision');
  requireNonemptyString(owned.dataRevision, 'geometry association snapshot.dataRevision');
  requireNonemptyString(owned.resolvedLayerDigest, 'geometry association snapshot.resolvedLayerDigest');
  validateMarks(owned.marks, 'geometry association snapshot.marks');
  if (owned.certification !== undefined) {
    validateHeatmapHaloCertification(owned.certification, 'geometry association snapshot.certification');
  }
  return owned;
}

function nonOk<T>(status: Exclude<EnvelopeResult<T>['status'], 'ok'>, reason: string): EnvelopeResult<T> {
  return { status, reason };
}

function runtimeField(runtime: ResolvedLayerRuntime, key: string): unknown {
  const descriptor = runtime?.descriptor as unknown;
  if (!isRecord(descriptor)) throw inputError('runtime descriptor must be a plain object.');
  const property = Object.getOwnPropertyDescriptor(descriptor, key);
  if (!property || !Object.prototype.hasOwnProperty.call(property, 'value')) {
    throw inputError(`runtime descriptor ${key} must be an own data property.`);
  }
  return property.value;
}

function validateMemberAgainstRuntime(member: SelectionMember, runtime: ResolvedLayerRuntime): string | null {
  const comparisons = [
    ['datasetId', 'datasetId'],
    ['visualizationId', 'visualizationId'],
    ['layerId', 'layerId'],
    ['dataRevision', 'dataRevision'],
    ['visualizationRevision', 'visualizationRevision'],
  ] as const;
  for (const [memberField, runtimeKey] of comparisons) {
    if (member.provenance[memberField] !== runtimeField(runtime, runtimeKey)) {
      return `${memberField} does not match the resolved layer descriptor`;
    }
  }
  const cameraEnvelope = runtimeField(runtime, 'cameraEnvelope');
  if (!isRecord(cameraEnvelope)) return 'cameraEnvelope is invalid';
  if (member.provenance.producerId !== cameraEnvelope.producer) return 'producerId does not match cameraEnvelope';
  if (member.provenance.producerVersion !== cameraEnvelope.producerVersion) {
    return 'producerVersion does not match cameraEnvelope';
  }
  return null;
}

function snapshotMember(member: SelectionMember, sceneRevision: string): SelectionMember {
  const owned = snapshot(member, 'selection member');
  const validation = validateSelectionState({ members: [owned], activeId: owned.id, sceneRevision });
  if (validation.status !== 'ok') throw inputError(validation.reason);
  return owned;
}

function callRegistry<T>(action: () => EnvelopeResult<T>, label: string): EnvelopeResult<T> {
  try {
    return action();
  } catch (error) {
    return nonOk('error', `${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createSourceMarks(objects: readonly CustomObject[]): readonly ResolvedSelectionMark[] {
  const input = objects.map((object) => ({ kind: 'source-object' as const, object }));
  const owned = snapshot(input, 'feature-ref marks');
  validateMarks(owned, 'feature-ref marks', 'source-object');
  return owned;
}

export function resolveSelectionSnapshot(
  memberInput: SelectionMember,
  revisions: { selectionSceneRevision: string; expectedSceneRevision: string },
  runtime: ResolvedLayerRuntime,
  registry: SelectionResolutionRegistry,
): EnvelopeResult<ResolvedSelectionSnapshot> {
  let ownedRevisions: { selectionSceneRevision: string; expectedSceneRevision: string };
  try {
    ownedRevisions = snapshot(revisions, 'selection revisions');
    if (!isRecord(ownedRevisions)) throw inputError('selection revisions must be a plain object.');
    requireExactKeys(ownedRevisions, ['selectionSceneRevision', 'expectedSceneRevision'], 'selection revisions');
    requireNonemptyString(ownedRevisions.selectionSceneRevision, 'selection revisions.selectionSceneRevision');
    requireNonemptyString(ownedRevisions.expectedSceneRevision, 'selection revisions.expectedSceneRevision');
  } catch (error) {
    return nonOk('error', error instanceof Error ? error.message : String(error));
  }
  if (ownedRevisions.selectionSceneRevision !== ownedRevisions.expectedSceneRevision) {
    return nonOk('stale', 'selection scene revision does not match the expected scene revision');
  }

  let member: SelectionMember;
  try {
    member = snapshotMember(memberInput, ownedRevisions.selectionSceneRevision);
  } catch (error) {
    return nonOk('error', error instanceof Error ? error.message : String(error));
  }
  if (member.status !== 'current' || member.operation !== 'idle') {
    return nonOk('stale', `selection member ${member.id} is ${member.status}/${member.operation}`);
  }

  let runtimeIdentity: {
    dataRevision: string;
    resolvedLayerDigest: string;
    resolvedSupportProducer: string;
    heatmapRadiusPixels?: number;
  };
  try {
    const mismatch = validateMemberAgainstRuntime(member, runtime);
    if (mismatch) return nonOk('stale', mismatch);
    const dataRevision = runtimeField(runtime, 'dataRevision');
    const resolvedLayerDigest = runtimeField(runtime, 'resolvedLayerDigest');
    const resolvedSupport = runtimeField(runtime, 'resolvedSupport');
    requireNonemptyString(dataRevision, 'runtime descriptor dataRevision');
    requireNonemptyString(resolvedLayerDigest, 'runtime descriptor resolvedLayerDigest');
    if (!isRecord(resolvedSupport)) throw inputError('runtime descriptor resolvedSupport must be a plain object.');
    requireNonemptyString(resolvedSupport.producer, 'runtime descriptor resolvedSupport.producer');
    const heatmapRadiusPixels =
      resolvedSupport.producer === 'heatmap-kernel' ? resolvedSupport.radiusPixels : undefined;
    if (heatmapRadiusPixels !== undefined) {
      requireFinite(heatmapRadiusPixels, 'runtime descriptor resolvedSupport.radiusPixels');
      if (heatmapRadiusPixels < 0) {
        throw inputError('runtime descriptor resolvedSupport.radiusPixels must be non-negative.');
      }
    }
    runtimeIdentity = {
      dataRevision,
      resolvedLayerDigest,
      resolvedSupportProducer: resolvedSupport.producer,
      ...(heatmapRadiusPixels === undefined ? {} : { heatmapRadiusPixels }),
    };
  } catch (error) {
    return nonOk('error', error instanceof Error ? error.message : String(error));
  }

  let marks: readonly ResolvedSelectionMark[] = [];
  let query: RenderQuerySnapshot | undefined;
  let association: GeometryAssociationSnapshot | undefined;
  let geometry: ResolvedSelectionSnapshot['geometry'];

  if (member.binding.kind === 'feature-refs') {
    const result = callRegistry(() => registry.resolveFeatureRefs(member, runtime), 'feature-ref resolution');
    if (result.status !== 'ok') return result;
    try {
      marks = createSourceMarks(result.value);
    } catch (error) {
      return nonOk('error', error instanceof Error ? error.message : String(error));
    }
  } else if (member.binding.kind === 'render-query') {
    const result = callRegistry(() => registry.resolveRenderQuery(member, runtime), 'render-query resolution');
    if (result.status !== 'ok') return result;
    try {
      query = createRenderQuerySnapshot(result.value);
    } catch (error) {
      return nonOk('error', error instanceof Error ? error.message : String(error));
    }
    try {
      if (query.queryId !== member.binding.queryId)
        return nonOk('stale', 'query ID does not match the selection binding');
      if (query.sceneRevision !== ownedRevisions.expectedSceneRevision)
        return nonOk('stale', 'query scene revision is stale');
      if (query.dataRevision !== runtimeIdentity.dataRevision) return nonOk('stale', 'query data revision is stale');
      if (query.resolvedLayerDigest !== runtimeIdentity.resolvedLayerDigest) {
        return nonOk('stale', 'query resolved layer digest is stale');
      }
      const contract = getRenderQueryContract(query.queryId);
      if (!contract || contract.producer !== runtimeIdentity.resolvedSupportProducer) {
        return nonOk('unsupported', 'query producer does not match the resolved layer producer');
      }
      if (
        query.queryId === 'select-heatmap-zone-v1' &&
        (runtimeIdentity.heatmapRadiusPixels === undefined ||
          query.certification === undefined ||
          query.certification.haloRadiusPixels < runtimeIdentity.heatmapRadiusPixels)
      ) {
        return nonOk('unsupported', 'heatmap query does not certify a complete kernel-radius contributor halo');
      }
    } catch (error) {
      return nonOk('error', error instanceof Error ? error.message : String(error));
    }
    marks = query.marks;
  } else {
    geometry = snapshot(
      { geometry: member.binding.geometry, wrapMode: member.binding.wrapMode },
      'drawn selection geometry',
    );
    if (member.binding.rebindCapability === 'query') {
      if (!registry.resolveDrawnGeometryMarks) {
        return nonOk('unavailable', 'drawn geometry query binding has no associated-mark resolver');
      }
      const result = callRegistry(
        () => registry.resolveDrawnGeometryMarks!(member, runtime),
        'drawn-geometry associated-mark resolution',
      );
      if (result.status !== 'ok') return result;
      try {
        association = createGeometryAssociationSnapshot(result.value);
      } catch (error) {
        return nonOk('error', error instanceof Error ? error.message : String(error));
      }
      try {
        if (association.sceneRevision !== ownedRevisions.expectedSceneRevision)
          return nonOk('stale', 'geometry association scene revision is stale');
        if (association.dataRevision !== runtimeIdentity.dataRevision)
          return nonOk('stale', 'geometry association data revision is stale');
        if (association.resolvedLayerDigest !== runtimeIdentity.resolvedLayerDigest) {
          return nonOk('stale', 'geometry association resolved layer digest is stale');
        }
        if (
          runtimeIdentity.resolvedSupportProducer === 'heatmap-kernel' &&
          (runtimeIdentity.heatmapRadiusPixels === undefined ||
            association.certification === undefined ||
            association.certification.haloRadiusPixels < runtimeIdentity.heatmapRadiusPixels)
        ) {
          return nonOk('unsupported', 'heatmap geometry association does not certify a complete contributor halo');
        }
        if (runtimeIdentity.resolvedSupportProducer !== 'heatmap-kernel' && association.certification !== undefined) {
          return nonOk('unsupported', 'heatmap halo certification is invalid for this geometry association producer');
        }
      } catch (error) {
        return nonOk('error', error instanceof Error ? error.message : String(error));
      }
      marks = association.marks;
    }
  }

  if (geometry === undefined && marks.length === 0) {
    return nonOk('unavailable', 'resolved selection contains no geometry or marks');
  }

  const base = {
    schemaVersion: 1 as const,
    memberId: member.id,
    sceneRevision: ownedRevisions.expectedSceneRevision,
    resolvedLayerDigest: runtimeIdentity.resolvedLayerDigest,
    provenance: member.provenance,
    bindingKind: member.binding.kind,
    binding: member.binding,
    ...(query === undefined ? {} : { query }),
    ...(association === undefined ? {} : { association }),
    ...(geometry === undefined ? {} : { geometry }),
    marks,
  };
  const selectionRevision = `selection:${digestCanonical({ schema: 'resolved-selection-v1', ...base })}`;
  try {
    const value = snapshot({ ...base, selectionRevision }, 'resolved selection snapshot');
    certifiedSelectionSnapshots.add(value);
    return {
      status: 'ok',
      value,
    };
  } catch (error) {
    return nonOk('error', error instanceof Error ? error.message : String(error));
  }
}

export function validateResolvedSelectionSnapshot(
  value: ResolvedSelectionSnapshot,
): EnvelopeResult<ResolvedSelectionSnapshot> {
  return typeof value === 'object' && value !== null && certifiedSelectionSnapshots.has(value)
    ? { status: 'ok', value }
    : nonOk('error', 'resolved selection snapshot is not a certified module-built snapshot');
}
