import type { CameraMovement } from '../interfaces';
import { derivePlaybackPlan } from './playback';
import {
  getTimelineFocusedRowScrollTop,
  getTimelineIndicesForSourceIndex,
  getTimelineMainContentHeightStyle,
  getTimelineTableScroll,
} from './timeline-layout';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function camera(targetId: string, index: number): CameraMovement {
  const view = { longitude: index, latitude: 20, zoom: 10, pitch: 35, bearing: 0 };
  return {
    id: `${targetId}-${index}`,
    targetId,
    name: 'overview-static',
    title: `Camera ${index}`,
    category: 'overview',
    initViewState: view,
    finalViewState: { ...view },
    duration: 1000,
    stay: 0,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 300,
  };
}

function createTarget(key: string, cameras = 1) {
  return derivePlaybackPlan(Array.from({ length: cameras }, (_, index) => camera(key, index))).timelineData[0];
}

function targetKeys(...names: string[]) {
  return names.map((name) => createTarget(name).key);
}

function testCollapsedCurrentViewDoesNotNeedScroll() {
  const scroll = getTimelineTableScroll(221, [createTarget('current-view')], []);

  assert(
    scroll === undefined,
    `collapsed current view should not force vertical scroll, received ${JSON.stringify(scroll)}`,
  );
}

function testExpandedCurrentViewDoesNotNeedScrollWhenItFits() {
  const scroll = getTimelineTableScroll(221, [createTarget('current-view')], targetKeys('current-view'));

  assert(
    scroll === undefined,
    `expanded current view should not force vertical scroll, received ${JSON.stringify(scroll)}`,
  );
}

function testExpandedTwoCameraRowsFitWhenContentFits() {
  const scroll = getTimelineTableScroll(221, [createTarget('current-view', 2)], targetKeys('current-view'));

  assert(
    scroll === undefined,
    `two compact camera rows should not force vertical scroll, received ${JSON.stringify(scroll)}`,
  );
}

function testOverflowingTimelineKeepsScroll() {
  const scroll = getTimelineTableScroll(221, [createTarget('a', 2), createTarget('b', 2)], targetKeys('a', 'b'));

  assert(
    scroll?.y === 125,
    `overflowing timeline should use available body height 125, received ${JSON.stringify(scroll)}`,
  );
}

function testFocusedCameraScrollsDownToNewestExpandedRow() {
  const scrollTop = getTimelineFocusedRowScrollTop({
    timelineData: [createTarget('a'), createTarget('b'), createTarget('c')],
    expandedKeys: targetKeys('a', 'b', 'c'),
    targetIndex: 2,
    cameraIndex: 0,
    currentScrollTop: 0,
    viewportHeight: 100,
  });

  assert(scrollTop === 124, `newest expanded camera row should scroll to 124, received ${scrollTop}`);
}

function testFocusedVisibleCameraKeepsScrollPosition() {
  const scrollTop = getTimelineFocusedRowScrollTop({
    timelineData: [createTarget('a'), createTarget('b')],
    expandedKeys: targetKeys('a', 'b'),
    targetIndex: 0,
    cameraIndex: 0,
    currentScrollTop: 0,
    viewportHeight: 100,
  });

  assert(scrollTop === 0, `visible focused camera row should keep scrollTop 0, received ${scrollTop}`);
}

function testFocusedCollapsedTargetIgnoresCameraOffset() {
  const scrollTop = getTimelineFocusedRowScrollTop({
    timelineData: [createTarget('a'), createTarget('b'), createTarget('c')],
    expandedKeys: targetKeys('a', 'b'),
    targetIndex: 2,
    cameraIndex: 0,
    currentScrollTop: 0,
    viewportHeight: 100,
  });

  assert(scrollTop === 87, `collapsed focused target should scroll to target row 87, received ${scrollTop}`);
}

function testInvalidFocusedTargetDoesNotScroll() {
  const scrollTop = getTimelineFocusedRowScrollTop({
    timelineData: [createTarget('a')],
    expandedKeys: targetKeys('a'),
    targetIndex: -1,
    cameraIndex: 0,
    currentScrollTop: 0,
    viewportHeight: 100,
  });

  assert(scrollTop === undefined, `invalid focused target should not scroll, received ${scrollTop}`);
}

function testFocusedLastCameraLeavesBottomBreathingRoom() {
  const scrollTop = getTimelineFocusedRowScrollTop({
    timelineData: [
      createTarget('camera-0'),
      createTarget('camera-1'),
      createTarget('camera-2'),
      createTarget('camera-3'),
      createTarget('camera-4'),
      createTarget('camera-5'),
    ],
    expandedKeys: targetKeys('camera-0', 'camera-1', 'camera-2', 'camera-3', 'camera-4', 'camera-5'),
    targetIndex: 5,
    cameraIndex: 0,
    currentScrollTop: 0,
    viewportHeight: 204,
  });

  assert(scrollTop === 236, `last focused camera should leave 8px bottom padding, received ${scrollTop}`);
}

function testSourceIndexFindsAuthoredRowsAcrossTargetGroups() {
  const plan = derivePlaybackPlan([camera('a', 0), camera('b', 1), camera('b', 2)]);
  assert(
    plan.segments.some((segment) => Boolean(segment.generated)),
    'fixture includes playback connections',
  );
  const indices = getTimelineIndicesForSourceIndex(plan.timelineData, 2);
  assert(
    indices.timelineTargetIndex === 1 && indices.timelineCameraIndex === 1,
    `source index resolves its authored row without counting playback connections, received ${JSON.stringify(indices)}`,
  );
}

function testMissingAndGeneratedSourceIndicesAreRejected() {
  const plan = derivePlaybackPlan([camera('a', 0), camera('b', 1)]);
  for (const sourceIndex of [-1, 99]) {
    const indices = getTimelineIndicesForSourceIndex(plan.timelineData, sourceIndex);
    assert(indices.timelineTargetIndex === -1 && indices.timelineCameraIndex === -1, 'missing source has no row');
  }
  const incoming = plan.timelineData[1];
  const malformed = [{ ...incoming, cameras: [{ ...incoming.cameras[0], generated: plan.segments[1].generated }] }];
  const indices = getTimelineIndicesForSourceIndex(malformed, 1);
  assert(
    indices.timelineTargetIndex === -1 && indices.timelineCameraIndex === -1,
    'an invalid generated row cannot stand in for an authored camera',
  );
}

function testMainContentHeightAccountsForExactTimelineHeight() {
  const heightStyle = getTimelineMainContentHeightStyle(300);

  assert(
    heightStyle === 'calc(100% - 300px)',
    `main content height should subtract the exact timeline height, received ${heightStyle}`,
  );
}

testCollapsedCurrentViewDoesNotNeedScroll();
testExpandedCurrentViewDoesNotNeedScrollWhenItFits();
testExpandedTwoCameraRowsFitWhenContentFits();
testOverflowingTimelineKeepsScroll();
testFocusedCameraScrollsDownToNewestExpandedRow();
testFocusedVisibleCameraKeepsScrollPosition();
testFocusedCollapsedTargetIgnoresCameraOffset();
testInvalidFocusedTargetDoesNotScroll();
testFocusedLastCameraLeavesBottomBreathingRoom();
testSourceIndexFindsAuthoredRowsAcrossTargetGroups();
testMissingAndGeneratedSourceIndicesAreRejected();
testMainContentHeightAccountsForExactTimelineHeight();
