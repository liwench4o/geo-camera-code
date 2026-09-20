import assert from 'node:assert/strict';
import type { CameraMovement, TimelineResizeEdge } from '../interfaces';
import { derivePlaybackPlan, getViewAtPlaybackTime } from './playback';
import { getCameraEndMaxMs, getCameraStartMinMs } from './timeline-controls';
import { applyTimelineResizeEdit } from './timeline-edits';
import { createStoryJson, parseStoryJson } from './serialization';

function camera(id: string, longitude: number, overrides: Partial<CameraMovement> = {}): CameraMovement {
  const view = { longitude, latitude: 20, zoom: 10, pitch: 35, bearing: 0 };
  return {
    id,
    name: 'overview-static',
    title: id,
    category: 'overview',
    targetId: id,
    initViewState: view,
    finalViewState: { ...view },
    duration: 4000,
    stay: 3000,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
    annotation: { delay: 0, duration: 1000, text: `Caption ${id}` },
    authoring: {
      version: 2,
      targetId: id,
      recipeId: 'overview-static',
      adjustments: {},
      timing: { duration: 4000, stay: 3000, startDelay: overrides.startDelay ?? 0 },
      planningViewport: { width: 1000, height: 600 },
    },
    ...overrides,
  };
}

function sourceRow(plan: ReturnType<typeof derivePlaybackPlan>, sourceIndex: number) {
  const row = plan.timelineData.flatMap((target) => target.cameras).find((item) => item.sourceIndex === sourceIndex);
  assert(row && !row.generated);
  return row;
}

function resize(cameras: CameraMovement[], sourceIndex: number, edge: TimelineResizeEdge, valueMs: number) {
  const before = derivePlaybackPlan(cameras);
  const result = applyTimelineResizeEdit({
    cameraList: cameras,
    timelineData: before.timelineData,
    totalTimeLength: before.totalTime,
    edit: { type: 'ripple-resize', camera: sourceRow(before, sourceIndex), edge, valueMs },
  });
  assert(result);
  return { cameras: result.cameraList, plan: derivePlaybackPlan(result.cameraList) };
}

function checkGap(plan: ReturnType<typeof derivePlaybackPlan>, expected: number) {
  const first = sourceRow(plan, 0);
  const next = sourceRow(plan, 1);
  const end = first.start + first.duration + first.stay;
  assert.equal(next.start - end, expected, 'the actual interval must equal the requested gap');
  const generated = plan.segments.filter((segment) => segment.generated);
  assert.equal(generated.length, expected > 0 ? 1 : 0, 'zero gap must not insert a transition');
  if (expected > 0) {
    assert.equal(generated[0].start, end);
    assert.equal(generated[0].end, next.start);
    assert.equal(generated[0].duration, expected);
  }
  assert.equal(getViewAtPlaybackTime(plan.segments, next.start)?.longitude, 100, 'exact boundary enters next shot');
  assert.equal(getViewAtPlaybackTime(plan.segments, end - 1)?.longitude, 0, 'stay remains a hold');
  assert(plan.timelineData.every((target) => target.cameras.every((row) => !row.generated)));
}

function testRepeatedTargetsHaveUniqueGroupKeys() {
  const cameras = [
    camera('opening', 0, { targetId: 'UK', timelineTargetName: 'UK · overview' }),
    camera('middle', 100),
    camera('closing', 0, { targetId: 'UK', timelineTargetName: 'UK · closing overview' }),
    camera('closing-detail', 0, { targetId: 'UK' }),
  ];
  const { timelineData } = derivePlaybackPlan(cameras);
  assert.equal(timelineData.length, 3, 'only consecutive occurrences of a target are merged');
  assert.equal(new Set(timelineData.map((row) => row.key)).size, 3, 'nonconsecutive UK groups need distinct keys');
  assert.deepEqual(
    timelineData.map((row) => row.cameras.map((shot) => shot.sourceIndex)),
    [[0], [1], [2, 3]],
  );
  assert.equal(timelineData[2].name, 'UK · closing overview');
  const changed = derivePlaybackPlan(cameras.map((shot) => ({ ...shot, stay: shot.stay + 100 })));
  assert.deepEqual(
    changed.timelineData.map((row) => row.key),
    timelineData.map((row) => row.key),
  );
}

function testGapControlsPlaybackIncludingOldCut() {
  for (const gap of [0, 100, 2000]) {
    for (const policy of [undefined, 'auto', 'cut'] as const) {
      const first = camera('first', 0);
      const next = camera('next', 100, { startDelay: gap });
      next.authoring!.transition = policy;
      const plan = derivePlaybackPlan([first, next]);
      checkGap(plan, gap);
      assert.equal(plan.totalTime, 14000 + gap);
      if (gap > 0) {
        const middle = getViewAtPlaybackTime(plan.segments, 7000 + gap / 2)!;
        assert(middle.longitude > 0 && middle.longitude < 100, 'the whole interval is a moving transition');
      }
    }
  }
}

function testEitherHandleControlsTheWholeGap() {
  for (const sameTarget of [false, true]) {
    for (const gap of [0, 100, 2000]) {
      const cameras = [camera('first', 0), camera('next', 100, { startDelay: 2000 })];
      if (sameTarget) cameras[1].targetId = cameras[0].targetId;
      const before = derivePlaybackPlan(cameras);
      assert.equal(getCameraStartMinMs(before.timelineData, sameTarget ? 0 : 1, sameTarget ? 1 : 0), 7000);
      assert.equal(getCameraEndMaxMs(before.timelineData, 0, 0, before.totalTime), 9000);
      for (const edge of ['start', 'end'] as const) {
        const edited = edge === 'start' ? resize(cameras, 1, edge, 7000 + gap) : resize(cameras, 0, edge, 9000 - gap);
        checkGap(edited.plan, gap);
        assert.equal(edited.plan.totalTime, before.totalTime, 'dragging either edge preserves downstream timing');
        if (edge === 'end') assert.equal(sourceRow(edited.plan, 1).start, 9000);
        assert.equal(edited.cameras[1].startDelay, gap);
        assert.equal(edited.cameras[1].interpolationDuration, 0);
        assert.equal(edited.cameras[1].authoring!.timing!.startDelay, gap);
        assert.deepEqual(
          edited.cameras.map((shot) => shot.annotation),
          cameras.map((shot) => shot.annotation),
        );
        const imported = parseStoryJson(JSON.parse(JSON.stringify(createStoryJson(edited.cameras))));
        assert(imported.ok);
        checkGap(derivePlaybackPlan(imported.cameras), gap);
        assert.equal(derivePlaybackPlan(imported.cameras).totalTime, before.totalTime);
      }
    }
  }
}

function testExplicitLegacyDurationIsEditableAndCountedOnce() {
  const cameras = [camera('first', 0), camera('next', 100, { interpolationDuration: 700, startDelay: 300 })];
  const before = derivePlaybackPlan(cameras);
  checkGap(before, 1000);
  assert.equal(getCameraStartMinMs(before.timelineData, 1, 0), 7000, 'legacy duration must not reserve a minimum');
  assert.equal(getCameraEndMaxMs(before.timelineData, 0, 0, before.totalTime), 8000);
  for (const gap of [0, 100, 2000]) {
    const edited = resize(cameras, 1, 'start', 7000 + gap);
    checkGap(edited.plan, gap);
    assert.equal(edited.cameras[1].interpolationDuration, 0, 'editing folds old timing into the editable delay');
    assert.equal(edited.cameras[1].startDelay, gap);
    assert.equal(edited.plan.totalTime, before.totalTime);
  }
  const edited = resize(cameras, 0, 'end', 8000);
  checkGap(edited.plan, 0);
  assert.equal(sourceRow(edited.plan, 1).start, 8000);
  assert.equal(edited.cameras[1].interpolationDuration, 0);
  assert.equal(cameras[1].interpolationDuration, 700, 'source input is not mutated');
}

function testContinuousViewsRetainOnlyTheExplicitInterval() {
  const first = camera('first', 0);
  const next = camera('next', 0, { interpolationDuration: 700, startDelay: 300 });
  const plan = derivePlaybackPlan([first, next]);
  assert.equal(plan.totalTime, 15000);
  assert.equal(plan.segments[1].generated, 'timeline-gap');
  assert.equal(plan.segments[1].duration, 1000);
  assert.equal(getViewAtPlaybackTime(plan.segments, 7500)?.longitude, 0);
  const zero = resize([first, next], 1, 'start', 7000);
  assert.equal(zero.plan.segments.length, 2);
}

function legacyGapCameras(sameTarget: boolean) {
  return [
    camera('first', 0, {
      targetId: 'target-a',
      duration: 1000,
      stay: 500,
      interpolationDuration: 700,
      authoring: undefined,
    }),
    camera('second', 100, {
      targetId: sameTarget ? 'target-a' : 'target-b',
      duration: 1000,
      stay: 500,
      interpolationDuration: 700,
      startDelay: 300,
      authoring: undefined,
    }),
  ];
}

function testAutomaticConnectionsAppearOnlyInPlayback() {
  for (const sameTarget of [true, false]) {
    for (const policy of [undefined, 'auto', 'cut'] as const) {
      const cameras = legacyGapCameras(sameTarget);
      if (policy) {
        cameras[1].authoring = {
          version: 2,
          targetId: cameras[1].targetId!,
          recipeId: 'overview-static',
          adjustments: {},
          planningViewport: { width: 1000, height: 600 },
          transition: policy,
        };
      }
      const plan = derivePlaybackPlan(cameras);
      assert.equal(plan.segments.length, 3, 'one continuous connection occupies the entire interval');
      const transition = plan.segments[1];
      assert(
        transition.generated === 'gap-transition' && transition.duration === 1000 && transition.end === 2500,
        'legacy duration 700 and delay 300 form one 1000 ms automatic transition regardless of old policy',
      );
      assert(
        plan.timelineData.every((target) => target.cameras.every((item) => !item.generated && item.editable)),
        'automatic connections must not appear as timeline rows',
      );
      assert.equal(plan.timelineData.length, sameTarget ? 1 : 2, 'connections do not split same-target groups');
      assert(sourceRow(plan, 1).start === 2500 && plan.totalTime === 4000, 'connection retains absolute timing');
      for (const timeMs of [1850, 2300]) {
        const duringGap = getViewAtPlaybackTime(plan.segments, timeMs);
        assert(
          duringGap && duringGap.longitude > 0 && duringGap.longitude < 100,
          'the connection keeps moving, including offset 800 beyond the old 700 ms flight',
        );
      }
      assert.equal(getViewAtPlaybackTime(plan.segments, 2500)?.longitude, 100, 'exact boundary enters the next shot');
      const story = createStoryJson(cameras);
      assert.equal(story.cameras.length, 2, 'automatic connection is not a standalone saved story record');
      assert(
        !JSON.stringify(story).includes('incomingTransitionDuration'),
        'internal timeline boundaries are not saved to story',
      );
      const imported = parseStoryJson(JSON.parse(JSON.stringify(story)));
      assert(imported.ok && derivePlaybackPlan(imported.cameras).totalTime === 4000, 'story replay retains timing');
    }
  }
}

function testIncomingStartEditsDoNotCountTransitionTwice() {
  for (const sameTarget of [true, false]) {
    for (const [requested, expectedStart, expectedDelay] of [
      [2700, 2700, 1200],
      [0, 1500, 0],
    ]) {
      const changed = resize(legacyGapCameras(sameTarget), 1, 'start', requested);
      assert(sourceRow(changed.plan, 1).start === expectedStart, 'incoming start lands on the requested bounded time');
      assert(changed.cameras[1].startDelay === expectedDelay, 'only explicit delay is saved to the incoming camera');
      assert(changed.plan.totalTime === 4000, 'moving start keeps motion/stay endpoint fixed');
      assert(changed.cameras[1].interpolationDuration === 0, 'timing edit folds legacy duration into startDelay');
    }
  }
}

function testOutgoingEndEditsPreserveNextCameraStart() {
  for (const sameTarget of [true, false]) {
    for (const [requested, expectedEnd, expectedDelay] of [
      [1200, 1200, 1300],
      [1700, 1700, 800],
      [4000, 2500, 0],
    ]) {
      const changed = resize(legacyGapCameras(sameTarget), 0, 'end', requested);
      assert(
        changed.cameras[0].duration + changed.cameras[0].stay === expectedEnd,
        'outgoing end respects the next camera start',
      );
      assert(changed.cameras[1].startDelay === expectedDelay, 'resizing leaves only remaining explicit delay');
      assert(sourceRow(changed.plan, 1).start === 2500, 'incoming start stays fixed after outgoing end resize');
      assert(changed.plan.totalTime === 4000, 'outgoing end edit does not stretch the story by a hidden connection');
    }
    const changed = resize(legacyGapCameras(sameTarget), 0, 'motion-end', 800);
    assert(
      changed.cameras[0].duration === 800 && changed.cameras[0].stay === 700,
      'motion end trades duration for stay',
    );
    assert(
      sourceRow(changed.plan, 1).start === 2500 && changed.plan.totalTime === 4000,
      'motion edit preserves later timing',
    );
  }
}

function testContinuousAndLegacyCutCamerasReserveNoConnectionTime() {
  for (const cut of [true, false]) {
    const cameras = legacyGapCameras(false);
    if (cut) {
      cameras[1].authoring = {
        version: 2,
        targetId: 'target-b',
        recipeId: 'overview-static',
        adjustments: {},
        planningViewport: { width: 1440, height: 900 },
        transition: 'cut',
      };
    } else {
      cameras[1].initViewState = { ...cameras[0].finalViewState };
      cameras[1].finalViewState = { ...cameras[0].finalViewState };
    }
    const plan = derivePlaybackPlan(cameras);
    assert(
      plan.segments[1].generated === (cut ? 'gap-transition' : 'timeline-gap'),
      'only equal views hold the interval; legacy cut no longer overrides the gap',
    );
    assert(getCameraStartMinMs(plan.timelineData, 1, 0) === 1500, 'no hidden connection is reserved');
    const changed = resize(cameras, 0, 'end', 1000);
    assert(changed.cameras[1].startDelay === 1500, 'cut or continuous edit preserves the full explicit interval');
    assert(
      sourceRow(changed.plan, 1).start === 2500 && changed.plan.totalTime === 4000,
      'both views and cut metadata use the authored interval',
    );
  }
}

function testZeroLegacyDurationAddsNoDefaultConnection() {
  const cameras = legacyGapCameras(false);
  cameras[1].interpolationDuration = 0;
  const plan = derivePlaybackPlan(cameras);
  assert(
    sourceRow(plan, 1).start === 1800 && plan.totalTime === 3300,
    'zero incoming duration leaves only the explicit 300 ms delay',
  );
  assert(getCameraStartMinMs(plan.timelineData, 1, 0) === 1500, 'no minimum connection duration is reserved');
  assert(
    getCameraEndMaxMs(plan.timelineData, 0, 0, plan.totalTime) === 1800,
    'the next camera start limits the outgoing end',
  );
  const changed = resize(cameras, 0, 'end', 1000);
  assert(changed.cameras[1].startDelay === 800, 'only the actual interval is saved');
  assert(sourceRow(changed.plan, 1).start === 1800 && changed.plan.totalTime === 3300, 'editing adds no implicit time');
}

function testReorderUsesIncomingIntervalAndDoesNotMoveSourceSnapshot() {
  const movingCamera = (id: string, longitude: number, transition: 'auto' | 'cut') => {
    const shot = camera(id, longitude, {
      finalViewState: { longitude: longitude + 1, latitude: 20, zoom: 10, pitch: 35, bearing: 0 },
      duration: 1000,
      stay: 250,
      interpolationDuration: 700,
    });
    shot.authoring!.transition = transition;
    shot.authoring!.timing = { duration: 1000, stay: 250 };
    return shot;
  };
  const first = movingCamera('first', 0, 'auto');
  const second = { ...movingCamera('second', 10, 'cut'), startDelay: 300 };
  second.authoring!.source = { kind: 'previous-camera', view: { ...first.finalViewState } };
  const third = movingCamera('third', 20, 'auto');
  const originalSource = JSON.stringify(second.authoring!.source);
  const original = derivePlaybackPlan([first, second, third]);
  assert(original.totalTime === 5450, 'original order includes both explicit incoming intervals');
  const reordered = derivePlaybackPlan([third, second, first]);
  assert(
    reordered.segments.filter((segment) => segment.generated === 'gap-transition').length === 2,
    'reorder retains the incoming intervals regardless of old policy metadata',
  );
  assert(
    reordered.totalTime === 5450 && reordered.segments[2].camera.id === 'second',
    'reorder keeps explicit timing at the receiving shot',
  );
  assert(
    JSON.stringify(second.authoring!.source) === originalSource,
    'reorder never replaces captured source with the new previous camera',
  );
  const firstCut = derivePlaybackPlan([second, first]);
  assert(
    firstCut.segments[0].start === 0 && firstCut.totalTime === 3200,
    'first shot ignores its own incoming delay as before',
  );
}

const tests = [
  testAutomaticConnectionsAppearOnlyInPlayback,
  testIncomingStartEditsDoNotCountTransitionTwice,
  testOutgoingEndEditsPreserveNextCameraStart,
  testContinuousAndLegacyCutCamerasReserveNoConnectionTime,
  testZeroLegacyDurationAddsNoDefaultConnection,
  testReorderUsesIncomingIntervalAndDoesNotMoveSourceSnapshot,
  testRepeatedTargetsHaveUniqueGroupKeys,
  testGapControlsPlaybackIncludingOldCut,
  testEitherHandleControlsTheWholeGap,
  testExplicitLegacyDurationIsEditableAndCountedOnce,
  testContinuousViewsRetainOnlyTheExplicitInterval,
];
let failures = 0;
for (const test of tests) {
  try {
    test();
  } catch (error) {
    failures++;
    console.error(test.name, error);
  }
}
assert.equal(failures, 0, `${failures} Story gap/import regressions failed`);
