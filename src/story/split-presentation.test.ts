import type { CameraMovement, CameraView, PlaybackSegment } from '../interfaces';
import { createPointTarget, getTargetIdentity } from '../camera/selection';
import type { CameraTarget } from '../camera/types';
import {
  getSplitPresentationAtPlaybackTime,
  getSplitPresentationForPlaybackSegment,
  reconcileSplitPresentationForPlanRevision,
} from './split-presentation';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertSameTarget(actual: CameraTarget | undefined, expected: CameraTarget, message: string) {
  assert(actual !== undefined, `${message}: received undefined`);
  assert(
    getTargetIdentity(actual!) === getTargetIdentity(expected),
    `${message}: expected ${getTargetIdentity(expected)}, received ${actual ? getTargetIdentity(actual) : 'undefined'}`,
  );
}

function createView(overrides: Partial<CameraView> = {}): CameraView {
  return {
    longitude: 0,
    latitude: 0,
    zoom: 10,
    pitch: 35,
    bearing: 0,
    minZoom: 0,
    maxZoom: 20,
    minPitch: 0,
    maxPitch: 85,
    ...overrides,
  };
}

function createCamera(overrides: Partial<CameraMovement> = {}): CameraMovement {
  return {
    name: 'comparison-side-by-side',
    title: 'Side-by-side split',
    category: 'comparison',
    purpose: 'comparison',
    presentation: 'split',
    initViewState: createView(),
    finalViewState: createView({ zoom: 9 }),
    duration: 1000,
    stay: 500,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
    ...overrides,
  };
}

function createSegment(camera: CameraMovement, overrides: Partial<PlaybackSegment> = {}): PlaybackSegment {
  const start = overrides.start ?? 0;
  const duration = overrides.duration ?? camera.duration;
  const stay = overrides.stay ?? camera.stay;

  return {
    id: 'segment',
    camera,
    start,
    duration,
    stay,
    end: start + duration + stay,
    editable: true,
    interpolator: 'fly',
    ...overrides,
  };
}

function testSplitSegmentUsesFirstAndLastValidSnapshots() {
  const first = createPointTarget([114.1, 22.3]);
  const middle = createPointTarget([114.2, 22.4]);
  const last = createPointTarget([114.3, 22.5]);
  const segment = createSegment(
    createCamera({
      comparisonTargetSnapshots: [first, middle, last],
    }),
  );

  const targets = getSplitPresentationForPlaybackSegment(segment)?.targets;

  assert(targets !== undefined, 'split segment should return targets');
  assertSameTarget(targets![0], first, 'slot A should use the first snapshot');
  assertSameTarget(targets![1], last, 'slot B should use the latest snapshot');
}

function testSplitTargetsAppearOnlyInsideSegmentTimeRange() {
  const first = createPointTarget([114.1, 22.3]);
  const last = createPointTarget([114.3, 22.5]);
  const segment = createSegment(
    createCamera({
      comparisonTargetSnapshots: [first, last],
    }),
    { start: 100, duration: 1000, stay: 500 },
  );

  const activeTargets = getSplitPresentationAtPlaybackTime([segment], 1599)?.targets;
  const endBoundaryTargets = getSplitPresentationAtPlaybackTime([segment], 1600)?.targets;

  assert(activeTargets !== undefined, 'split overlay should be active before the segment end');
  assertSameTarget(activeTargets![0], first, 'active slot A should match the first snapshot');
  assertSameTarget(activeTargets![1], last, 'active slot B should match the latest snapshot');
  assert(endBoundaryTargets === undefined, 'split overlay should clear at the exact segment end');
}

function testGeneratedAndNonSplitSegmentsDoNotRenderSplitTargets() {
  const first = createPointTarget([114.1, 22.3]);
  const last = createPointTarget([114.3, 22.5]);
  const generatedSegment = createSegment(
    createCamera({
      comparisonTargetSnapshots: [first, last],
    }),
    { generated: 'gap-transition' },
  );
  const normalSegment = createSegment(
    createCamera({
      presentation: undefined,
      comparisonTargetSnapshots: [first, last],
    }),
  );

  assert(
    getSplitPresentationForPlaybackSegment(generatedSegment) === undefined,
    'generated segments should be ignored',
  );
  assert(getSplitPresentationForPlaybackSegment(normalSegment) === undefined, 'non-split cameras should be ignored');
}

function testInvalidOrIncompleteSnapshotsDoNotRenderSplitTargets() {
  const first = createPointTarget([114.1, 22.3]);
  const last = createPointTarget([114.3, 22.5]);
  const oneTarget = createSegment(
    createCamera({
      comparisonTargetSnapshots: [first],
    }),
  );
  const invalidEntries = createSegment(
    createCamera({
      comparisonTargetSnapshots: [{}, first, null, last],
    }),
  );

  const targets = getSplitPresentationForPlaybackSegment(invalidEntries)?.targets;

  assert(getSplitPresentationForPlaybackSegment(oneTarget) === undefined, 'one valid target is not enough for split');
  assert(targets !== undefined, 'invalid snapshot entries should be filtered');
  assertSameTarget(targets![0], first, 'slot A should use the first valid snapshot');
  assertSameTarget(targets![1], last, 'slot B should use the last valid snapshot');
}

function testSplitPresentationCarriesSegmentIdentity() {
  const first = createPointTarget([114.1, 22.3]);
  const last = createPointTarget([114.3, 22.5]);
  const segment = createSegment(
    createCamera({
      comparisonTargetSnapshots: [first, last],
    }),
    { id: 'comparison-segment-42', start: 100, duration: 1000, stay: 500 },
  );

  const directPresentation = getSplitPresentationForPlaybackSegment(segment);
  const timedPresentation = getSplitPresentationAtPlaybackTime([segment], 500);

  assert(directPresentation?.segmentId === segment.id, 'direct presentation should retain its segment id');
  assert(timedPresentation?.segmentId === segment.id, 'timed presentation should retain its segment id');
  assertSameTarget(timedPresentation?.targets[0], first, 'timed presentation slot A should match the first target');
  assertSameTarget(timedPresentation?.targets[1], last, 'timed presentation slot B should match the last target');
}

function testPlanRevisionChangeInvalidatesPlaybackPresentation() {
  const first = createPointTarget([114.1, 22.3]);
  const last = createPointTarget([114.3, 22.5]);
  const presentation = getSplitPresentationForPlaybackSegment(
    createSegment(
      createCamera({
        comparisonTargetSnapshots: [first, last],
      }),
    ),
  );

  assert(presentation !== undefined, 'test setup should produce a split presentation');
  assert(
    reconcileSplitPresentationForPlanRevision(presentation, 7, 7) === presentation,
    'an unchanged plan revision should retain the active split presentation',
  );
  assert(
    reconcileSplitPresentationForPlanRevision(presentation, 7, 8) === undefined,
    'a new playback plan revision should invalidate the old split presentation',
  );
}

testSplitSegmentUsesFirstAndLastValidSnapshots();
testSplitTargetsAppearOnlyInsideSegmentTimeRange();
testGeneratedAndNonSplitSegmentsDoNotRenderSplitTargets();
testInvalidOrIncompleteSnapshotsDoNotRenderSplitTargets();
testSplitPresentationCarriesSegmentIdentity();
testPlanRevisionChangeInvalidatesPlaybackPresentation();
