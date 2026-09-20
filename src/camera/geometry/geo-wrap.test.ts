import {
  MERCATOR_LATITUDE_LIMIT,
  chooseWrapFrame,
  getWrappedExtent,
  normalizeLongitude,
  selectWorldOffset,
  shortestAngle,
  unwrapLongitude,
  unwrapPath,
  unwrapRings,
  validateMercatorSupport,
} from './geo-wrap';
import type { LngLat, WrapMetadata } from './types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertClose(actual: number, expected: number, message: string) {
  assert(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, received ${actual}`);
}

function assertThrows(action: () => unknown, message: string) {
  let threw = false;

  try {
    action();
  } catch {
    threw = true;
  }

  assert(threw, message);
}

function signedArea(ring: LngLat[]): number {
  let twiceArea = 0;

  for (let index = 1; index < ring.length; index += 1) {
    const previous = ring[index - 1];
    const current = ring[index];
    twiceArea += previous[0] * current[1] - current[0] * previous[1];
  }

  return twiceArea / 2;
}

function testAntimeridianUsesMinimumArc() {
  const frame = chooseWrapFrame([179.8, -179.7]);
  const extent = getWrappedExtent(
    [
      [179.8, 10],
      [-179.7, 11],
    ],
    frame,
  );

  assert(extent.wrap.wrapMode === 'minimum-arc', 'ordinary support should use a minimum-arc frame');
  assert(extent.maxLng - extent.minLng < 1, 'antimeridian support must stay local rather than span 360 degrees');
  assertClose(extent.maxLng - extent.minLng, 0.5, 'antimeridian extent should retain its true longitude span');
}

function testPathUsesShortestAdjacentLongitude() {
  const path = unwrapPath([
    [179, 0],
    [-179, 0],
    [178, 0],
  ]);

  assert(
    path.every((point: LngLat, index: number) => index === 0 || Math.abs(point[0] - path[index - 1][0]) <= 180),
    'path must unwrap every longitude relative to its predecessor',
  );
  assert(path[0][0] === 179 && path[1][0] === 181 && path[2][0] === 178, 'path order must be preserved');
}

function testCanonicalAngleTiesAreDirectedOnlyWhenRequested() {
  assert(shortestAngle(0, 180) === 180, 'undirected 180 degree tie must be positive');
  assert(shortestAngle(0, 180, 1) === 180, 'positive directed tie must be positive');
  assert(shortestAngle(0, 180, -1) === -180, 'negative directed tie must be negative');
  assert(shortestAngle(10, 350) === -20, 'ordinary negative shortest angle must be retained');
  assert(shortestAngle(350, 10) === 20, 'ordinary positive shortest angle must be retained');
}

function testLargestGapTiesAreDeterministic() {
  const canonical = chooseWrapFrame([0, 120, 240]);
  const reordered = chooseWrapFrame([240, 0, 120]);
  const previousTie = chooseWrapFrame([0, 120, 240], { previousReference: -100 });
  const uniqueGap = chooseWrapFrame([0, 10, 200], { previousReference: 90 });

  assert(canonical.wrapReference === 120, 'equal largest gaps must choose the smallest canonical seam');
  assert(reordered.wrapReference === canonical.wrapReference, 'input order must not affect a largest-gap tie');
  assert(previousTie.wrapReference === -120, 'previous reference may select among equally minimal frames');
  assert(uniqueGap.wrapReference === -75, 'previous reference must not override a uniquely minimal frame');
  assert(canonical.worldOffset === 0, 'new frames must begin in canonical world zero');
}

function testRingsShareOneFrameAndPreserveWindingAndClosure() {
  const rings: LngLat[][] = [
    [
      [179, 0],
      [-179, 0],
      [-179, 1],
      [179, 1],
      [179, 0],
    ],
    [
      [178, 0],
      [178, 1],
      [-178, 1],
      [-178, 0],
      [178, 0],
    ],
  ];
  const unwrapped = unwrapRings(rings);

  assert(unwrapped.length === rings.length, 'ring order must be preserved');
  assert(unwrapped[0].length === rings[0].length, 'outer ring vertex order must be preserved');
  assert(unwrapped[1].length === rings[1].length, 'inner ring vertex order must be preserved');
  assert(
    unwrapped.every(
      (ring: LngLat[]) => ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1],
    ),
    'closed rings must retain exact coordinate closure',
  );
  assert(signedArea(unwrapped[0]) > 0, 'counter-clockwise winding must be preserved across the antimeridian');
  assert(signedArea(unwrapped[1]) < 0, 'clockwise winding must be preserved across the antimeridian');
  assert(
    Math.max(...unwrapped.flat().map(([longitude]: LngLat) => longitude)) -
      Math.min(...unwrapped.flat().map(([longitude]: LngLat) => longitude)) <
      5,
    'all rings must use the same local world frame',
  );
}

function testExplicitWorldOffsetMovesAllGeometryIntoTheRequestedWorld() {
  const canonicalFrame: WrapMetadata = {
    wrapReference: 180,
    worldOffset: 0,
    wrapMode: 'minimum-arc',
  };
  const shiftedFrame: WrapMetadata = { ...canonicalFrame, worldOffset: 1 };
  const path: LngLat[] = [
    [179, 0],
    [-179, 1],
    [178, 2],
  ];
  const ring: LngLat[] = [
    [179, 0],
    [-179, 0],
    [-179, 1],
    [179, 0],
  ];
  const canonicalPath = unwrapPath(path, canonicalFrame);
  const shiftedPath = unwrapPath(path, shiftedFrame);
  const canonicalExtent = getWrappedExtent(path, canonicalFrame);
  const shiftedExtent = getWrappedExtent(path, shiftedFrame);
  const canonicalRing = unwrapRings([ring], canonicalFrame)[0];
  const shiftedRing = unwrapRings([ring], shiftedFrame)[0];

  for (let index = 0; index < path.length; index += 1) {
    assertClose(shiftedPath[index][0], canonicalPath[index][0] + 360, 'path must use the requested world copy');
    assert(shiftedPath[index][1] === canonicalPath[index][1], 'world offset must not change path latitude');
  }
  assertClose(shiftedExtent.minLng, canonicalExtent.minLng + 360, 'extent minimum must move one world');
  assertClose(shiftedExtent.maxLng, canonicalExtent.maxLng + 360, 'extent maximum must move one world');
  assertClose(
    shiftedExtent.maxLng - shiftedExtent.minLng,
    canonicalExtent.maxLng - canonicalExtent.minLng,
    'world offset must preserve the local extent span',
  );
  for (let index = 0; index < ring.length; index += 1) {
    assertClose(shiftedRing[index][0], canonicalRing[index][0] + 360, 'ring must use the requested world copy');
  }
  assert(
    shiftedRing[0][0] === shiftedRing[shiftedRing.length - 1][0] &&
      shiftedRing[0][1] === shiftedRing[shiftedRing.length - 1][1],
    'world-shifted closed rings must retain exact closure',
  );
}

function testFractionalWorldOffsetsAreRejected() {
  const fractionalFrame: WrapMetadata = {
    wrapReference: 180,
    worldOffset: 0.5,
    wrapMode: 'minimum-arc',
  };

  assertThrows(() => unwrapPath([[179, 0]], fractionalFrame), 'path must reject a fractional world offset');
  assertThrows(() => getWrappedExtent([[179, 0]], fractionalFrame), 'extent must reject a fractional world offset');
  assertThrows(() => unwrapRings([[[179, 0]]], fractionalFrame), 'rings must reject a fractional world offset');
}

function testFullWorldExtentNeverCollapses() {
  const frame = chooseWrapFrame([-180, -90, 0, 90, 180], {
    fullWorld: true,
    previousReference: 190,
  });
  const extent = getWrappedExtent(
    [
      [179.8, -10],
      [-179.7, 10],
    ],
    frame,
  );

  assert(frame.wrapMode === 'full-world', 'explicit full-world support must use full-world mode');
  assert(frame.wrapReference === 190, 'full-world reference should preserve the finite previous camera reference');
  assert(extent.maxLng - extent.minLng === 360, 'full-world support must have exactly 360 degrees of width');
  assert(extent.minLat === -10 && extent.maxLat === 10, 'full-world extent must retain its latitude bounds');
}

function testWorldCopySelectionUsesStableIntegerTies() {
  assert(selectWorldOffset(540, 179) === -1, 'nearest world copy must be selected');
  assert(selectWorldOffset(180, 0) === -1, 'equal-distance world copies must use the smaller integer offset');
  assert(selectWorldOffset(180.1, 0.1) === -1, 'translated equal-distance ties must use the smaller offset');
  assert(selectWorldOffset(-180, 0) === 0, 'the same tie rule must be stable from the negative world copy');
}

function testMercatorValidationRejectsInsteadOfClamping() {
  const valid = validateMercatorSupport([
    [0, MERCATOR_LATITUDE_LIMIT],
    [360, -MERCATOR_LATITUDE_LIMIT],
  ]);
  const unsupported = validateMercatorSupport([[0, MERCATOR_LATITUDE_LIMIT + 1e-8]]);
  const nonFinite = validateMercatorSupport([[Number.NaN, 0]]);
  const empty = validateMercatorSupport([]);

  assert(valid.status === 'ok' && valid.value, 'finite coordinates at the Mercator limit must remain supported');
  assert(unsupported.status === 'unsupported', 'latitude beyond the Mercator limit must be unsupported');
  assert(nonFinite.status === 'error', 'non-finite coordinates must return an error');
  assert(empty.status === 'error', 'empty coordinate support must return an error');
}

function testLongitudeOperationsAreInvariantToWholeWorldShifts() {
  const baseLongitudes = [179.8, -179.7, 178.25];
  const baseFrame = chooseWrapFrame(baseLongitudes);
  const baseCoordinates: LngLat[] = baseLongitudes.map((longitude, index) => [longitude, index]);
  const baseExtent = getWrappedExtent(baseCoordinates);

  for (let world = -4; world <= 4; world += 1) {
    const shift = world * 360;
    const shifted = baseLongitudes.map((longitude) => longitude + shift);
    const shiftedCoordinates: LngLat[] = shifted.map((longitude, index) => [longitude, index]);
    const frame = chooseWrapFrame(shifted);
    const extent = getWrappedExtent(shiftedCoordinates);

    assertClose(normalizeLongitude(12.5 + shift), 12.5, 'normalization must ignore whole-world shifts');
    assertClose(shortestAngle(170 + shift, -170 + shift), 20, 'shortest angle must ignore whole-world shifts');
    assertClose(unwrapLongitude(-179.7 + shift, 179.8), 180.3, 'longitude unwrap must ignore source world');
    assertClose(frame.wrapReference, baseFrame.wrapReference, 'frame reference must ignore whole-world shifts');
    assertClose(extent.minLng, baseExtent.minLng, 'extent minimum must ignore whole-world shifts');
    assertClose(extent.maxLng, baseExtent.maxLng, 'extent maximum must ignore whole-world shifts');
  }
}

function testInvalidGeometryInputsFailDeterministically() {
  assertThrows(() => normalizeLongitude(Number.POSITIVE_INFINITY), 'normalization must reject infinity');
  assertThrows(() => shortestAngle(Number.NaN, 0), 'shortest angle must reject NaN');
  assertThrows(() => unwrapLongitude(0, Number.NEGATIVE_INFINITY), 'unwrap must reject a non-finite reference');
  assertThrows(() => chooseWrapFrame([]), 'frame selection must reject an empty longitude set');
  assertThrows(() => chooseWrapFrame([0, Number.NaN]), 'frame selection must reject non-finite longitudes');
  assertThrows(() => getWrappedExtent([]), 'extent calculation must reject empty coordinates');
  assertThrows(() => getWrappedExtent([[0, Number.NaN]]), 'extent calculation must reject non-finite coordinates');
  assertThrows(() => unwrapPath([[0, Number.POSITIVE_INFINITY]]), 'path unwrapping must reject non-finite coordinates');
  assertThrows(() => unwrapRings([[[Number.NaN, 0]]]), 'ring unwrapping must reject non-finite coordinates');
  assertThrows(() => selectWorldOffset(0, Number.NaN), 'world-copy selection must reject non-finite coordinates');
  assert(unwrapPath([]).length === 0, 'an empty path must deterministically remain empty');
  assert(unwrapRings([]).length === 0, 'an empty ring collection must deterministically remain empty');
}

testAntimeridianUsesMinimumArc();
testPathUsesShortestAdjacentLongitude();
testCanonicalAngleTiesAreDirectedOnlyWhenRequested();
testLargestGapTiesAreDeterministic();
testRingsShareOneFrameAndPreserveWindingAndClosure();
testExplicitWorldOffsetMovesAllGeometryIntoTheRequestedWorld();
testFractionalWorldOffsetsAreRejected();
testFullWorldExtentNeverCollapses();
testWorldCopySelectionUsesStableIntegerTies();
testMercatorValidationRejectsInsteadOfClamping();
testLongitudeOperationsAreInvariantToWholeWorldShifts();
testInvalidGeometryInputsFailDeterministically();
