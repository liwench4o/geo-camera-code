import { validateSnapshotEnvelope } from './geometry/envelope';
import type { EnvelopeResult, SnapshotEnvelope, TargetProvenance } from './geometry/types';

export interface SelectionState {
  activeId?: string;
  members: SelectionMember[];
  comparisonPair?: [string, string];
  sceneRevision: string;
}

export interface SelectionMember {
  id: string;
  pinned: boolean;
  source: 'click-object' | 'drawn-region' | 'heatmap-zone' | 'data-path' | 'drawn-path';
  status: 'current' | 'stale' | 'frozen' | 'unresolved';
  operation: 'idle' | 'rebinding';
  provenance: Omit<TargetProvenance, 'sceneRevision' | 'resolvedLayerDigest'>;
  binding: SelectionBinding;
  lastSnapshot?: SnapshotEnvelope;
}

export interface GeoJsonGeometry {
  type: 'Point' | 'MultiPoint' | 'LineString' | 'MultiLineString' | 'Polygon' | 'MultiPolygon';
  coordinates: unknown;
}

export type SelectionBinding =
  | { kind: 'feature-refs'; featureIds: string[]; rebindCapability: 'stable-id' }
  | { kind: 'render-query'; queryId: string; params: unknown; rebindCapability: 'query' }
  | {
      kind: 'drawn-geometry';
      geometry: GeoJsonGeometry;
      wrapMode: 'minimum-arc' | 'full-world';
      rebindCapability: 'query' | 'none';
    };

const SOURCES = new Set<SelectionMember['source']>([
  'click-object',
  'drawn-region',
  'heatmap-zone',
  'data-path',
  'drawn-path',
]);
const STATUSES = new Set<SelectionMember['status']>(['current', 'stale', 'frozen', 'unresolved']);
const OPERATIONS = new Set<SelectionMember['operation']>(['idle', 'rebinding']);
const GEOMETRY_TYPES = new Set<GeoJsonGeometry['type']>([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
]);

function failure(status: 'stale' | 'unavailable' | 'unsupported' | 'error', reason: string): EnvelopeResult<never> {
  return { status, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateJsonPrimitive(value: unknown): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'contains a non-finite number';
  return typeof value === 'object' ? null : `contains unsupported ${typeof value}`;
}

interface JsonTraversalFrame {
  source: object;
  keys?: string[];
  length: number;
  index: number;
  label: string;
}

function jsonChild(
  source: object,
  key: string,
): { status: 'ok'; value: unknown } | { status: 'error'; reason: string } {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    return { status: 'error', reason: `property ${key} must be a plain data property` };
  }
  return { status: 'ok', value: descriptor.value };
}

function createJsonTraversalFrame(source: object, label: string): JsonTraversalFrame {
  if (Array.isArray(source)) return { source, length: source.length, index: 0, label };
  const keys = Object.keys(source);
  return { source, keys, length: keys.length, index: 0, label };
}

function jsonFrameKey(frame: JsonTraversalFrame, index: number): string {
  return frame.keys === undefined ? String(index) : frame.keys[index];
}

function validateJsonLike(value: unknown): string | null {
  const primitiveError = validateJsonPrimitive(value);
  if (primitiveError) return primitiveError;
  if (value === null || typeof value !== 'object') return null;

  const states = new Map<object, 'visiting' | 'complete'>();
  const pending: JsonTraversalFrame[] = [];
  const enter = (source: object, label: string): string | null => {
    const state = states.get(source);
    if (state === 'visiting') return `${label} contains a cycle`;
    if (state === 'complete') return null;
    if (!Array.isArray(source)) {
      const prototype = Object.getPrototypeOf(source);
      if (prototype !== Object.prototype && prototype !== null) return `${label} contains a non-plain object`;
    }
    states.set(source, 'visiting');
    pending.push(createJsonTraversalFrame(source, label));
    return null;
  };

  const rootError = enter(value, 'value');
  if (rootError) return rootError;
  while (pending.length > 0) {
    const frame = pending[pending.length - 1];
    if (frame.index >= frame.length) {
      states.set(frame.source, 'complete');
      pending.pop();
      continue;
    }
    const key = jsonFrameKey(frame, frame.index);
    frame.index += 1;
    const child = jsonChild(frame.source, key);
    if (child.status === 'error') return `${frame.label} ${child.reason}`;
    const childLabel = Array.isArray(frame.source) ? `${frame.label} item ${key}` : `${frame.label} property ${key}`;
    const childPrimitiveError = validateJsonPrimitive(child.value);
    if (childPrimitiveError) return `${childLabel} ${childPrimitiveError}`;
    if (child.value !== null && typeof child.value === 'object') {
      const childError = enter(child.value, childLabel);
      if (childError) return childError;
    }
  }
  return null;
}

function validatePosition(value: unknown, label: string): string | null {
  if (!Array.isArray(value) || value.length < 2) return `${label} must contain at least longitude and latitude`;
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== 'number' || !Number.isFinite(value[index])) {
      return `${label}[${index}] must be a finite number`;
    }
  }
  return null;
}

function validatePositionArray(value: unknown, minimumLength: number, label: string): string | null {
  if (!Array.isArray(value) || value.length < minimumLength) {
    return `${label} must contain at least ${minimumLength} positions`;
  }
  for (let index = 0; index < value.length; index += 1) {
    const error = validatePosition(value[index], `${label}[${index}]`);
    if (error) return error;
  }
  return null;
}

function positionsEqual(first: unknown, second: unknown): boolean {
  if (!Array.isArray(first) || !Array.isArray(second) || first.length !== second.length) return false;
  for (let index = 0; index < first.length; index += 1) {
    if (first[index] !== second[index]) return false;
  }
  return true;
}

function hasConsecutiveDuplicate(positions: unknown[]): boolean {
  for (let index = 1; index < positions.length; index += 1) {
    if (positionsEqual(positions[index - 1], positions[index])) return true;
  }
  return false;
}

function validateLinearRing(value: unknown, label: string): string | null {
  const error = validatePositionArray(value, 4, label);
  if (error) return error;
  const ring = value as unknown[];
  return positionsEqual(ring[0], ring[ring.length - 1]) ? null : `${label} must be closed`;
}

function validateGeometryCoordinates(geometry: GeoJsonGeometry): string | null {
  const coordinates = geometry.coordinates;
  switch (geometry.type) {
    case 'Point':
      return validatePosition(coordinates, 'Point coordinates');
    case 'MultiPoint':
      return validatePositionArray(coordinates, 1, 'MultiPoint coordinates');
    case 'LineString': {
      const error = validatePositionArray(coordinates, 2, 'LineString coordinates');
      if (error) return error;
      return hasConsecutiveDuplicate(coordinates as unknown[])
        ? 'LineString coordinates must be normalized without consecutive duplicates'
        : null;
    }
    case 'MultiLineString':
      if (!Array.isArray(coordinates) || coordinates.length === 0) {
        return 'MultiLineString coordinates must contain at least one line';
      }
      for (let index = 0; index < coordinates.length; index += 1) {
        const error = validatePositionArray(coordinates[index], 2, `MultiLineString coordinates[${index}]`);
        if (error) return error;
        if (hasConsecutiveDuplicate(coordinates[index] as unknown[])) {
          return `MultiLineString coordinates[${index}] must be normalized without consecutive duplicates`;
        }
      }
      return null;
    case 'Polygon':
      if (!Array.isArray(coordinates) || coordinates.length === 0) {
        return 'Polygon coordinates must contain at least one ring';
      }
      for (let index = 0; index < coordinates.length; index += 1) {
        const error = validateLinearRing(coordinates[index], `Polygon coordinates[${index}]`);
        if (error) return error;
      }
      return null;
    case 'MultiPolygon':
      if (!Array.isArray(coordinates) || coordinates.length === 0) {
        return 'MultiPolygon coordinates must contain at least one polygon';
      }
      for (let polygonIndex = 0; polygonIndex < coordinates.length; polygonIndex += 1) {
        const polygon = coordinates[polygonIndex];
        if (!Array.isArray(polygon) || polygon.length === 0) {
          return `MultiPolygon coordinates[${polygonIndex}] must contain at least one ring`;
        }
        for (let ringIndex = 0; ringIndex < polygon.length; ringIndex += 1) {
          const error = validateLinearRing(
            polygon[ringIndex],
            `MultiPolygon coordinates[${polygonIndex}][${ringIndex}]`,
          );
          if (error) return error;
        }
      }
      return null;
  }
}

function validateProvenance(provenance: unknown): string | null {
  if (!isRecord(provenance)) return 'member provenance must be an object';
  for (const field of [
    'datasetId',
    'visualizationId',
    'layerId',
    'dataRevision',
    'visualizationRevision',
    'producerId',
  ] as const) {
    if (!isNonemptyString(provenance[field])) return `member provenance ${field} must be a nonempty string`;
  }
  if (
    typeof provenance.producerVersion !== 'number' ||
    !Number.isInteger(provenance.producerVersion) ||
    provenance.producerVersion < 0
  ) {
    return 'member provenance producerVersion must be a non-negative integer';
  }
  return null;
}

function validateBinding(binding: unknown): string | null {
  if (!isRecord(binding)) return 'member binding must be an object';
  switch (binding.kind) {
    case 'feature-refs': {
      if (binding.rebindCapability !== 'stable-id') return 'feature refs require stable-id rebinding';
      if (!Array.isArray(binding.featureIds) || binding.featureIds.length === 0) {
        return 'feature refs require at least one ID';
      }
      const ids = new Set<string>();
      for (let index = 0; index < binding.featureIds.length; index += 1) {
        const id = binding.featureIds[index];
        if (!isNonemptyString(id)) return `feature ref ${index} must be a nonempty string`;
        if (ids.has(id)) return `feature ref ${id} is duplicate`;
        ids.add(id);
      }
      return null;
    }
    case 'render-query': {
      if (binding.rebindCapability !== 'query') return 'render query requires query rebinding';
      if (!isNonemptyString(binding.queryId)) return 'render query ID must be a nonempty string';
      const paramsError = validateJsonLike(binding.params);
      return paramsError ? `render query params ${paramsError}` : null;
    }
    case 'drawn-geometry': {
      if (binding.rebindCapability !== 'query' && binding.rebindCapability !== 'none') {
        return 'drawn geometry rebind capability must be query or none';
      }
      if (binding.wrapMode !== 'minimum-arc' && binding.wrapMode !== 'full-world') {
        return 'drawn geometry wrap mode is invalid';
      }
      if (!isRecord(binding.geometry) || !GEOMETRY_TYPES.has(binding.geometry.type as GeoJsonGeometry['type'])) {
        return 'drawn geometry type is invalid';
      }
      return validateGeometryCoordinates(binding.geometry as unknown as GeoJsonGeometry);
    }
    default:
      return 'member binding kind is invalid';
  }
}

function isDeepFrozenValue(value: object): boolean {
  const pending: object[] = [value];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    if (!Object.isFrozen(current)) return false;
    for (const key of Object.keys(current)) {
      const child = (current as Record<string, unknown>)[key];
      if (child !== null && typeof child === 'object') pending.push(child);
    }
  }
  return true;
}

function validateOwnedSnapshot(snapshot: unknown, label: string): string | null {
  if (!isRecord(snapshot) || snapshot.binding !== 'snapshot') return `${label} must be a snapshot envelope`;
  try {
    const validation = validateSnapshotEnvelope(snapshot as unknown as SnapshotEnvelope);
    if (validation.status !== 'ok') return `${label} is invalid: ${validation.reason}`;
  } catch (error) {
    return `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
  return isDeepFrozenValue(snapshot) ? null : `${label} must be deeply frozen`;
}

function validateSnapshotProvenance(
  snapshot: SnapshotEnvelope,
  provenance: SelectionMember['provenance'],
  label: string,
): string | null {
  for (const field of [
    'datasetId',
    'visualizationId',
    'layerId',
    'dataRevision',
    'visualizationRevision',
    'producerId',
    'producerVersion',
  ] as const) {
    if (snapshot.provenance[field] !== provenance[field]) {
      return `${label} provenance ${field} does not match the selection member`;
    }
  }
  return null;
}

function validateMember(member: unknown, index: number): string | null {
  if (!isRecord(member)) return `member ${index} must be an object`;
  if (!isNonemptyString(member.id)) return `member ${index} ID must be a nonempty string`;
  if (typeof member.pinned !== 'boolean') return `member ${member.id} pinned must be boolean`;
  if (!SOURCES.has(member.source as SelectionMember['source'])) return `member ${member.id} source is invalid`;
  if (!STATUSES.has(member.status as SelectionMember['status'])) return `member ${member.id} status is invalid`;
  if (!OPERATIONS.has(member.operation as SelectionMember['operation']))
    return `member ${member.id} operation is invalid`;
  if (member.operation === 'rebinding' && member.status !== 'stale') {
    return `member ${member.id} may rebind only while stale`;
  }
  if (member.status === 'frozen' && member.operation !== 'idle') {
    return `member ${member.id} frozen status requires idle operation`;
  }
  const provenanceError = validateProvenance(member.provenance);
  if (provenanceError) return `${member.id}: ${provenanceError}`;
  const bindingError = validateBinding(member.binding);
  if (bindingError) return `${member.id}: ${bindingError}`;
  if (member.status === 'frozen' && member.lastSnapshot === undefined) {
    return `member ${member.id} frozen status requires a snapshot`;
  }
  if (member.lastSnapshot !== undefined) {
    const snapshotError = validateOwnedSnapshot(member.lastSnapshot, `member ${member.id} lastSnapshot`);
    if (snapshotError) return snapshotError;
    const provenanceMismatch = validateSnapshotProvenance(
      member.lastSnapshot as SnapshotEnvelope,
      member.provenance as SelectionMember['provenance'],
      `member ${member.id} lastSnapshot`,
    );
    if (provenanceMismatch) return provenanceMismatch;
  }
  return null;
}

export function validateSelectionState(state: SelectionState): EnvelopeResult<true> {
  if (!isRecord(state)) return failure('error', 'selection state must be an object');
  if (!isNonemptyString(state.sceneRevision)) return failure('error', 'scene revision must be a nonempty string');
  if (!Array.isArray(state.members)) return failure('error', 'selection members must be an array');

  const ids = new Set<string>();
  for (let index = 0; index < state.members.length; index += 1) {
    const memberError = validateMember(state.members[index], index);
    if (memberError) return failure('error', memberError);
    const id = state.members[index].id;
    if (ids.has(id)) return failure('error', `duplicate member ID ${id}`);
    ids.add(id);
  }

  if (state.activeId !== undefined && !ids.has(state.activeId)) {
    return failure('error', `active member ${state.activeId} is unknown`);
  }
  if (state.comparisonPair !== undefined) {
    if (!Array.isArray(state.comparisonPair) || state.comparisonPair.length !== 2) {
      return failure('error', 'comparison pair must contain exactly two member IDs');
    }
    const [first, second] = state.comparisonPair;
    if (first === second) return failure('error', 'comparison pair member IDs must be distinct');
    if (!ids.has(first) || !ids.has(second)) return failure('error', 'comparison pair references an unknown member');
  }
  return { status: 'ok', value: true };
}
