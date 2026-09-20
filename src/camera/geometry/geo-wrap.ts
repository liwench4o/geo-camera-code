import type { EnvelopeResult, LngLat, WrapMetadata } from './types';

export const MERCATOR_LATITUDE_LIMIT = 85.05112878;

const FULL_CIRCLE_DEGREES = 360;
const HALF_CIRCLE_DEGREES = 180;
const GAP_TIE_EPSILON = 1e-12;

interface WrapCandidate {
  seam: number;
  reference: number;
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
}

function canonicalLongitude(longitude: number): number {
  requireFinite(longitude, 'longitude');
  const canonical = ((longitude % FULL_CIRCLE_DEGREES) + FULL_CIRCLE_DEGREES) % FULL_CIRCLE_DEGREES;
  return canonical === 0 ? 0 : canonical;
}

function requireCoordinates(coordinates: LngLat[], label: string): void {
  for (let index = 0; index < coordinates.length; index += 1) {
    const coordinate = coordinates[index];
    if (
      !Array.isArray(coordinate) ||
      coordinate.length < 2 ||
      !Number.isFinite(coordinate[0]) ||
      !Number.isFinite(coordinate[1])
    ) {
      throw new TypeError(`${label} coordinate ${index} must contain finite longitude and latitude values`);
    }
  }
}

function effectiveWrapReference(frame: WrapMetadata): number {
  requireFinite(frame.wrapReference, 'wrap reference');
  requireFinite(frame.worldOffset, 'world offset');
  if (!Number.isInteger(frame.worldOffset)) {
    throw new TypeError('world offset must be an integer');
  }
  if (frame.wrapMode !== 'minimum-arc' && frame.wrapMode !== 'full-world') {
    throw new TypeError('wrap mode must be minimum-arc or full-world');
  }

  const reference = frame.wrapReference + frame.worldOffset * FULL_CIRCLE_DEGREES;
  requireFinite(reference, 'effective wrap reference');
  return reference;
}

function isGapTie(first: number, second: number): boolean {
  return Math.abs(first - second) <= GAP_TIE_EPSILON;
}

export function normalizeLongitude(longitude: number): number {
  const canonical = canonicalLongitude(longitude);
  const normalized = canonical >= HALF_CIRCLE_DEGREES ? canonical - FULL_CIRCLE_DEGREES : canonical;
  return normalized === 0 ? 0 : normalized;
}

export function shortestAngle(from: number, to: number, directedTie?: -1 | 1): number {
  requireFinite(from, 'from angle');
  requireFinite(to, 'to angle');
  if (directedTie !== undefined && directedTie !== -1 && directedTie !== 1) {
    throw new TypeError('directed tie must be -1 or 1');
  }

  const fromCanonical = canonicalLongitude(from);
  const toCanonical = canonicalLongitude(to);
  let difference = canonicalLongitude(toCanonical - fromCanonical);

  if (difference > HALF_CIRCLE_DEGREES) {
    difference -= FULL_CIRCLE_DEGREES;
  }
  if (difference === HALF_CIRCLE_DEGREES) {
    return directedTie === -1 ? -HALF_CIRCLE_DEGREES : HALF_CIRCLE_DEGREES;
  }
  return difference === 0 ? 0 : difference;
}

export function unwrapLongitude(longitude: number, reference: number): number {
  requireFinite(longitude, 'longitude');
  requireFinite(reference, 'reference longitude');
  const unwrapped = reference + shortestAngle(reference, longitude);
  requireFinite(unwrapped, 'unwrapped longitude');
  return unwrapped === 0 ? 0 : unwrapped;
}

export function chooseWrapFrame(
  longitudes: number[],
  options: { fullWorld?: boolean; previousReference?: number } = {},
): WrapMetadata {
  if (longitudes.length === 0) {
    throw new RangeError('cannot choose a wrap frame without longitudes');
  }

  const canonicalLongitudes = longitudes.map((longitude) => canonicalLongitude(longitude)).sort((a, b) => a - b);
  const uniqueLongitudes = canonicalLongitudes.filter(
    (longitude, index) => index === 0 || longitude !== canonicalLongitudes[index - 1],
  );

  if (options.fullWorld) {
    return {
      wrapReference: Number.isFinite(options.previousReference) ? (options.previousReference as number) : 0,
      worldOffset: 0,
      wrapMode: 'full-world',
    };
  }

  let largestGap = -1;
  const gaps: Array<{ gap: number; seam: number }> = [];

  for (let index = 0; index < uniqueLongitudes.length; index += 1) {
    const current = uniqueLongitudes[index];
    const next =
      index + 1 < uniqueLongitudes.length ? uniqueLongitudes[index + 1] : uniqueLongitudes[0] + FULL_CIRCLE_DEGREES;
    const gap = next - current;
    const seam = index + 1 < uniqueLongitudes.length ? uniqueLongitudes[index + 1] : uniqueLongitudes[0];

    gaps.push({ gap, seam });
    largestGap = Math.max(largestGap, gap);
  }

  const retainedWidth = FULL_CIRCLE_DEGREES - largestGap;
  const candidates: WrapCandidate[] = gaps
    .filter(({ gap }) => isGapTie(gap, largestGap))
    .map(({ seam }) => ({
      seam,
      reference: normalizeLongitude(seam + retainedWidth / 2),
    }))
    .sort((first, second) => first.seam - second.seam || first.reference - second.reference);

  let selected = candidates[0];
  if (candidates.length > 1 && Number.isFinite(options.previousReference)) {
    const previousReference = options.previousReference as number;
    let selectedDistance = Math.abs(shortestAngle(previousReference, selected.reference));

    for (let index = 1; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const candidateDistance = Math.abs(shortestAngle(previousReference, candidate.reference));
      if (candidateDistance < selectedDistance - GAP_TIE_EPSILON) {
        selected = candidate;
        selectedDistance = candidateDistance;
      }
    }
  }

  return {
    wrapReference: selected.reference,
    worldOffset: 0,
    wrapMode: 'minimum-arc',
  };
}

export function unwrapPath(path: LngLat[], frame?: WrapMetadata): LngLat[] {
  if (path.length === 0) {
    return [];
  }
  requireCoordinates(path, 'path');

  const resolvedFrame = frame ?? chooseWrapFrame(path.map(([longitude]) => longitude));
  const result: LngLat[] = [];
  let reference = effectiveWrapReference(resolvedFrame);

  for (const [longitude, latitude] of path) {
    const unwrappedLongitude = unwrapLongitude(longitude, reference);
    result.push([unwrappedLongitude, latitude]);
    reference = unwrappedLongitude;
  }

  return result;
}

export function unwrapRings(rings: LngLat[][], frame?: WrapMetadata): LngLat[][] {
  if (rings.length === 0) {
    return [];
  }

  const longitudes: number[] = [];
  for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
    const ring = rings[ringIndex];
    requireCoordinates(ring, `ring ${ringIndex}`);
    for (const [longitude] of ring) {
      longitudes.push(longitude);
    }
  }

  if (longitudes.length === 0) {
    return rings.map(() => []);
  }

  const resolvedFrame = frame ?? chooseWrapFrame(longitudes);
  return rings.map((ring) => {
    const unwrapped = unwrapPath(ring, resolvedFrame);
    if (ring.length < 2) {
      return unwrapped;
    }

    const first = ring[0];
    const last = ring[ring.length - 1];
    if (normalizeLongitude(first[0]) === normalizeLongitude(last[0]) && first[1] === last[1]) {
      unwrapped[unwrapped.length - 1] = [unwrapped[0][0], unwrapped[0][1]];
    }
    return unwrapped;
  });
}

export function getWrappedExtent(
  coordinates: LngLat[],
  frame?: WrapMetadata,
): {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
  wrap: WrapMetadata;
} {
  if (coordinates.length === 0) {
    throw new RangeError('cannot calculate an extent without coordinates');
  }
  requireCoordinates(coordinates, 'extent');

  const resolvedFrame = frame ?? chooseWrapFrame(coordinates.map(([longitude]) => longitude));
  const reference = effectiveWrapReference(resolvedFrame);
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  for (const [, latitude] of coordinates) {
    minLat = Math.min(minLat, latitude);
    maxLat = Math.max(maxLat, latitude);
  }

  if (resolvedFrame.wrapMode === 'full-world') {
    return {
      minLng: reference - HALF_CIRCLE_DEGREES,
      minLat,
      maxLng: reference + HALF_CIRCLE_DEGREES,
      maxLat,
      wrap: resolvedFrame,
    };
  }

  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  for (const [longitude] of coordinates) {
    const unwrapped = unwrapLongitude(longitude, reference);
    minLng = Math.min(minLng, unwrapped);
    maxLng = Math.max(maxLng, unwrapped);
  }

  return { minLng, minLat, maxLng, maxLat, wrap: resolvedFrame };
}

export function selectWorldOffset(unwrappedLongitude: number, previousCameraLongitude: number): number {
  requireFinite(unwrappedLongitude, 'unwrapped longitude');
  requireFinite(previousCameraLongitude, 'previous camera longitude');

  const directDifference = previousCameraLongitude - unwrappedLongitude;
  const idealOffset = Number.isFinite(directDifference)
    ? directDifference / FULL_CIRCLE_DEGREES
    : previousCameraLongitude / FULL_CIRCLE_DEGREES - unwrappedLongitude / FULL_CIRCLE_DEGREES;
  const lowerOffset = Math.floor(idealOffset);
  const upperOffset = Math.ceil(idealOffset);
  const lowerDistance = idealOffset - lowerOffset;
  const upperDistance = upperOffset - idealOffset;
  const selected = lowerDistance <= upperDistance ? lowerOffset : upperOffset;
  return selected === 0 ? 0 : selected;
}

export function validateMercatorSupport(coordinates: LngLat[]): EnvelopeResult<true> {
  if (coordinates.length === 0) {
    return { status: 'error', reason: 'Mercator support requires at least one coordinate' };
  }

  for (let index = 0; index < coordinates.length; index += 1) {
    const coordinate = coordinates[index];
    if (
      !Array.isArray(coordinate) ||
      coordinate.length < 2 ||
      !Number.isFinite(coordinate[0]) ||
      !Number.isFinite(coordinate[1])
    ) {
      return { status: 'error', reason: `Mercator support coordinate ${index} must be finite` };
    }
    if (Math.abs(coordinate[1]) > MERCATOR_LATITUDE_LIMIT) {
      return {
        status: 'unsupported',
        reason: `Mercator latitude ${coordinate[1]} exceeds ${MERCATOR_LATITUDE_LIMIT}`,
      };
    }
  }

  return { status: 'ok', value: true };
}
