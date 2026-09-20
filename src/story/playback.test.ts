import type { CameraMovement, CameraView } from '../interfaces';
import { digestCanonical } from '../camera/geometry/canonical-digest';
import { sampleCameraTrajectory } from '../camera/trajectory/sampler';
import type { CommittedTrajectoryPlan, SerializedCameraTrajectory } from '../camera/trajectory/types';
import { computeTrajectoryDigest } from '../camera/trajectory/validation';
import { getProgressElements } from '../util';
import { derivePlaybackPlan, getViewAtPlaybackTime, getStoppedPlaybackView, isPlaybackComplete } from './playback';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertClose(actual: number, expected: number, message: string) {
  assert(Math.abs(actual - expected) < 1e-6, `${message}: expected ${expected}, received ${actual}`);
}

function createView(overrides: Partial<CameraView>): CameraView {
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

function createCamera(name: string, initViewState: CameraView, finalViewState: CameraView): CameraMovement {
  return {
    name,
    title: name,
    category: 'dynamic',
    initViewState,
    finalViewState,
    duration: 1000,
    stay: 0,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
  };
}

function setTarget(camera: CameraMovement, targetId: string) {
  camera.targetId = targetId;
  return camera;
}

function setStartDelay(camera: CameraMovement, startDelay: number) {
  (camera as CameraMovement & { startDelay?: number }).startDelay = startDelay;
  return camera;
}

function testPlaybackInsertsGapBeforeDynamicCurrentViewPullOut() {
  const previous = createCamera(
    'overview-pull-out',
    createView({ longitude: -74, latitude: 40.7, zoom: 10 }),
    createView({ longitude: -73.9, latitude: 40.8, zoom: 8 }),
  );
  const dynamic = createCamera(
    'dynamic-pull-out',
    createView({ longitude: 2.3522, latitude: 48.8566, zoom: 11.5 }),
    createView({ longitude: 2.3522, latitude: 48.8566, zoom: 10.4 }),
  );

  const plan = derivePlaybackPlan([previous, setStartDelay(dynamic, 1000)]);

  assert(plan.segments.length === 3, `expected previous, gap, dynamic segments; received ${plan.segments.length}`);
  assert(plan.segments[1].generated === 'gap-transition', 'expected generated gap before dynamic segment');
  assert(plan.segments[2].camera.name === 'dynamic-pull-out', 'expected dynamic segment after generated gap');
}

function testStoppedPlaybackViewFreezesAtPlaybackTimeAndCancelsTransition() {
  const camera = createCamera(
    'dynamic-pull-out',
    createView({ longitude: 2, latitude: 48, zoom: 12, pitch: 40, bearing: 10 }),
    createView({ longitude: 2, latitude: 48, zoom: 10, pitch: 40, bearing: 10 }),
  );
  const { segments } = derivePlaybackPlan([camera]);
  const fallbackView = {
    ...camera.finalViewState,
    transitionDuration: 2000,
    transitionEasing: () => 0.5,
    transitionInterpolator: { name: 'active-transition' },
    onTransitionEnd: () => undefined,
  };

  const stoppedView = getStoppedPlaybackView(segments, 500, fallbackView);

  assert(stoppedView.zoom > camera.finalViewState.zoom, 'stopped view should not keep pulling out to final zoom');
  assert(stoppedView.zoom < camera.initViewState.zoom, 'stopped view should reflect in-progress pull-out');
  assert(stoppedView.transitionDuration === 0, 'stopped view should cancel transition duration');
  assert(stoppedView.transitionEasing === undefined, 'stopped view should clear transition easing');
  assert(stoppedView.transitionInterpolator === undefined, 'stopped view should clear transition interpolator');
  assert(stoppedView.onTransitionEnd === undefined, 'stopped view should clear transition callback');
}

function testPlaybackCompleteIncludesExactEndTime() {
  assert(!isPlaybackComplete(999, 1000), 'playback should continue before the timeline end');
  assert(isPlaybackComplete(1000, 1000), 'playback should complete at the exact clamped timeline end');
  assert(isPlaybackComplete(1001, 1000), 'playback should complete after the timeline end');
}

function testPlaybackEndReturnsStrippedFinalViewAtTotalTime() {
  const finalView = createView({
    longitude: 12,
    latitude: 34,
    zoom: 9,
    pitch: 45,
    bearing: 90,
    transitionDuration: 1200,
    transitionEasing: () => 0.5,
    transitionInterpolator: { name: 'fly' },
    onTransitionEnd: () => undefined,
  });
  const camera = createCamera('dynamic-pull-out', createView({ longitude: 10, latitude: 30, zoom: 11 }), finalView);
  camera.duration = 1000;
  camera.stay = 250;
  const plan = derivePlaybackPlan([camera]);

  const viewAtEnd = getViewAtPlaybackTime(plan.segments, plan.totalTime);

  if (!viewAtEnd) {
    throw new Error('playback end should return a final view');
  }
  assertClose(viewAtEnd.longitude, finalView.longitude, 'end view longitude should equal final longitude');
  assertClose(viewAtEnd.latitude, finalView.latitude, 'end view latitude should equal final latitude');
  assertClose(viewAtEnd.zoom, finalView.zoom, 'end view zoom should equal final zoom');
  assertClose(viewAtEnd.pitch, finalView.pitch, 'end view pitch should equal final pitch');
  assertClose(viewAtEnd.bearing, finalView.bearing, 'end view bearing should equal final bearing');
  assert(viewAtEnd.transitionDuration === 0, 'end view should cancel transition duration');
  assert(viewAtEnd.transitionEasing === undefined, 'end view should clear transition easing');
  assert(viewAtEnd.transitionInterpolator === undefined, 'end view should clear transition interpolator');
  assert(viewAtEnd.onTransitionEnd === undefined, 'end view should clear transition callback');
}

function testStartDelayCreatesBlankGapBetweenObjects() {
  const firstStart = createView({ longitude: 0, latitude: 0, zoom: 10 });
  const sharedView = createView({ longitude: 1, latitude: 1, zoom: 11 });
  const secondEnd = createView({ longitude: 2, latitude: 2, zoom: 12 });
  const first = setTarget(createCamera('first', firstStart, sharedView), 'target-a');
  first.duration = 1000;
  first.stay = 500;
  const second = setStartDelay(setTarget(createCamera('second', sharedView, secondEnd), 'target-b'), 2000);

  const plan = derivePlaybackPlan([first, second]);

  assert(plan.segments.length === 3, `expected blank gap segment between objects; received ${plan.segments.length}`);
  assert(
    (plan.segments[1] as { generated?: string }).generated === 'timeline-gap',
    'expected startDelay to create an internal timeline gap',
  );
  assert(
    plan.timelineData.length === 2,
    `blank gap should not create a timeline row; received ${plan.timelineData.length}`,
  );
  assert(
    plan.timelineData[0].targetEnd === 1500,
    `first object end should remain 1500, received ${plan.timelineData[0].targetEnd}`,
  );
  assert(
    plan.timelineData[1].targetStart === 3500,
    `second object should start after blank gap, received ${plan.timelineData[1].targetStart}`,
  );
  assert(plan.totalTime === 4500, `blank gap should count toward total time, received ${plan.totalTime}`);
  assertClose(
    getViewAtPlaybackTime(plan.segments, 2500)?.longitude ?? NaN,
    sharedView.longitude,
    'blank gap should hold the previous final view',
  );
}

function testProgressElementsPreserveBlankGapPosition() {
  const firstStart = createView({ longitude: 0, latitude: 0, zoom: 10 });
  const sharedView = createView({ longitude: 1, latitude: 1, zoom: 11 });
  const secondEnd = createView({ longitude: 2, latitude: 2, zoom: 12 });
  const first = setTarget(createCamera('first', firstStart, sharedView), 'target-a');
  first.duration = 1000;
  first.stay = 500;
  const second = setStartDelay(setTarget(createCamera('second', sharedView, secondEnd), 'target-b'), 2000);
  const plan = derivePlaybackPlan([first, second]);

  const progressElements = getProgressElements(plan.totalTime, plan.timelineData);

  assert(
    progressElements.length === 3,
    `progress track should preserve first camera, blank gap, and second camera; received ${progressElements.length}`,
  );
  assertClose(
    progressElements[1].value,
    (2000 / plan.totalTime) * 100,
    'progress track should keep blank gap between object colors',
  );
}

function testStartDelayFillsAutomaticConnectionInterval() {
  const first = setTarget(
    createCamera('first', createView({ longitude: 0, latitude: 0 }), createView({ longitude: 1, latitude: 1 })),
    'target-a',
  );
  const second = setStartDelay(
    setTarget(
      createCamera('second', createView({ longitude: 10, latitude: 10 }), createView({ longitude: 11 })),
      'target-b',
    ),
    2000,
  );

  const plan = derivePlaybackPlan([first, second]);

  assert(
    plan.timelineData.length === 2,
    `expected only the two authored target rows; received ${plan.timelineData.length}`,
  );
  const transition = plan.segments.find((segment) => segment.generated === 'gap-transition');
  assert(transition, 'discontinuous objects retain an internal playback transition');
  assert(transition.duration === 2000, 'the connection uses exactly the authored interval between cameras');
  assert(
    plan.timelineData[1].targetStart === transition.end,
    `second object should start at the end of the continuous connection, received ${plan.timelineData[1].targetStart}`,
  );
}

function testSameObjectCameraStartsAfterPreviousStayEnd() {
  const first = setTarget(
    createCamera('first', createView({ longitude: 0 }), createView({ longitude: 1 })),
    'target-a',
  );
  first.duration = 1000;
  first.stay = 500;
  const second = setTarget(
    createCamera('second', createView({ longitude: 1 }), createView({ longitude: 2 })),
    'target-a',
  );

  const plan = derivePlaybackPlan([first, second]);

  assert(
    plan.timelineData.length === 1,
    `same target should remain one object row, received ${plan.timelineData.length}`,
  );
  assert(
    plan.timelineData[0].cameras[1].start === 1500,
    `same-object camera should start after previous stay end, received ${plan.timelineData[0].cameras[1].start}`,
  );
}

function testStartDelayCreatesBlankGapBetweenSameObjectCameras() {
  const first = setTarget(
    createCamera('first', createView({ longitude: 0 }), createView({ longitude: 1 })),
    'target-a',
  );
  first.duration = 1000;
  first.stay = 500;
  const second = setStartDelay(
    setTarget(createCamera('second', createView({ longitude: 1 }), createView({ longitude: 2 })), 'target-a'),
    2000,
  );

  const plan = derivePlaybackPlan([first, second]);

  assert(plan.segments.length === 3, `expected same-object blank gap segment; received ${plan.segments.length}`);
  assert(
    (plan.segments[1] as { generated?: string }).generated === 'timeline-gap',
    'expected same-object startDelay to create an internal timeline gap',
  );
  assert(
    plan.timelineData.length === 1,
    `same target should remain one object row with an internal gap; received ${plan.timelineData.length}`,
  );
  assert(
    plan.timelineData[0].cameras[1].start === 3500,
    `same-object camera should preserve delayed start, received ${plan.timelineData[0].cameras[1].start}`,
  );
  assert(plan.totalTime === 4500, `same-object gap should count toward total time, received ${plan.totalTime}`);
}

function testCurrentViewCamerasRemainSeparateObjectsEvenWithSameView() {
  const startView = createView({ longitude: 0, latitude: 0, zoom: 10 });
  const currentView = createView({ longitude: 1, latitude: 1, zoom: 11 });
  const first = createCamera('first-current-view', startView, currentView);
  first.duration = 1000;
  first.stay = 500;
  const second = createCamera('second-current-view', currentView, currentView);
  second.duration = 1000;
  second.stay = 250;

  const plan = derivePlaybackPlan([first, second]);

  assert(
    plan.timelineData.length === 2,
    `same Current view targets should create separate object rows; received ${plan.timelineData.length}`,
  );
  assert(
    plan.timelineData.every((target) => target.name === 'Current view'),
    `expected both object rows to keep Current view labels, received ${plan.timelineData
      .map((target) => target.name)
      .join(', ')}`,
  );
  assert(
    plan.timelineData.every((target) => target.type === 'none'),
    'Current view fallback cameras must not be presented as region targets',
  );
  assert(
    plan.timelineData[0].targetEnd === 1500,
    `first Current view object should end at its camera stay end, received ${plan.timelineData[0].targetEnd}`,
  );
  assert(
    plan.timelineData[1].targetStart === 1500,
    `next Current view object should start at the previous object end, received ${plan.timelineData[1].targetStart}`,
  );
  assert(
    plan.timelineData[1].targetEnd === 2750,
    `second Current view object should end at its camera stay end, received ${plan.timelineData[1].targetEnd}`,
  );
}

function assertSemanticViewEqual(actual: CameraView | undefined, expected: CameraView, message: string) {
  assert(actual !== undefined, `${message}: expected a camera view`);
  for (const channel of ['longitude', 'latitude', 'zoom', 'pitch', 'bearing'] as const) {
    assertClose(actual[channel], expected[channel], `${message} ${channel}`);
  }
}

function testEnabledPlaybackCompilesEverySegmentAndUsesOneSamplerLookup() {
  const camera = createCamera(
    'enabled-camera',
    createView({ longitude: -5, latitude: 10, zoom: 8, pitch: 20, bearing: 5 }),
    createView({ longitude: 4, latitude: 12, zoom: 11, pitch: 40, bearing: 55 }),
  );
  camera.stay = 250;
  const plan = derivePlaybackPlan([camera], {
    trajectoryEnabled: true,
    viewport: { width: 1440, height: 900 },
  });
  assert(
    plan.segments.every((segment) => segment.trajectory),
    'enabled plan compiles every segment',
  );
  const trajectory = plan.segments[0].trajectory;
  assert(trajectory, 'enabled source segment has a runtime trajectory');
  assertSemanticViewEqual(
    getViewAtPlaybackTime(plan.segments, 375),
    sampleCameraTrajectory(trajectory, 375),
    'scrub and direct sampler agree',
  );
  assertSemanticViewEqual(
    getViewAtPlaybackTime(plan.segments, plan.totalTime),
    sampleCameraTrajectory(trajectory, camera.duration),
    'exact story end and direct endpoint sampling agree',
  );

  const disabled = derivePlaybackPlan([camera], { trajectoryEnabled: false });
  assert(
    disabled.segments.every((segment) => segment.trajectory === undefined),
    'explicit legacy compatibility mode remains available',
  );
}

function testEnabledGeneratedFlyLinearAndTimelineHoldKindsRemainExplicit() {
  const first = setTarget(
    createCamera('first', createView({ longitude: 0 }), createView({ longitude: 1 })),
    'target-a',
  );
  const second = setStartDelay(
    setTarget(createCamera('second', createView({ longitude: 10 }), createView({ longitude: 12 })), 'target-b'),
    200,
  );
  second.interpolationType = 'linear';
  const plan = derivePlaybackPlan([first, second], {
    trajectoryEnabled: true,
    viewport: { width: 1440, height: 900 },
  });
  assert(plan.segments.length === 3, 'enabled plan uses one connection for the full interval between sources');
  assert(
    plan.segments[1].trajectory?.serialized.kind === 'legacy-linear',
    'linear discontinuity compiles to explicit legacy-linear trajectory',
  );
  const continuousPlan = derivePlaybackPlan([first, { ...second, initViewState: first.finalViewState }]);
  assert(continuousPlan.segments[1].trajectory?.serialized.kind === 'hold', 'continuous-view delay remains a hold');
  assert(
    plan.segments[0].trajectory?.serialized.kind === 'legacy-fly' &&
      plan.segments[0].trajectory.serialized.viewport.width === 1440,
    'source compatibility fly seals the measured viewport',
  );
}

function testEnabledPlanFailsClosedInsteadOfEscapingToEndpointInterpolation() {
  const camera = createCamera('invalid-enabled', createView({ zoom: 8 }), createView({ zoom: Number.NaN }));
  let threw = false;
  try {
    derivePlaybackPlan([camera], { trajectoryEnabled: true, viewport: { width: 1440, height: 900 } });
  } catch {
    threw = true;
  }
  assert(threw, 'enabled segment compilation error must fail plan derivation');

  const valid = createCamera('valid-enabled', createView({ zoom: 8 }), createView({ zoom: 9 }));
  const plan = derivePlaybackPlan([valid], {
    trajectoryEnabled: true,
    viewport: { width: 1440, height: 900 },
  });
  const missing = [{ ...plan.segments[0], trajectory: undefined }];
  threw = false;
  try {
    getViewAtPlaybackTime(missing, 500);
  } catch {
    threw = true;
  }
  assert(threw, 'enabled segment missing its runtime trajectory must throw instead of interpolating endpoints');
}

function testCertifiedPlanUsesOnlyItsSealedViewportContext() {
  const viewport = { width: 1440, height: 900 };
  const heldView = createView({ longitude: 5, latitude: 6, zoom: 9, pitch: 20, bearing: 30 });
  const serializedHeldView = {
    longitude: heldView.longitude,
    latitude: heldView.latitude,
    zoom: heldView.zoom,
    pitch: heldView.pitch,
    bearing: heldView.bearing,
  };
  const camera = createCamera('certified-viewport', heldView, { ...heldView });
  const frameCertificate = {
    kind: 'strict-frame-v1' as const,
    inputDigest: 'viewport-input-v1',
    envelopeDigest: 'viewport-envelope-v1',
    viewportDigest: digestCanonical({ schema: 'strict-frame-viewport-v1', viewport }),
    constraintDigest: 'viewport-constraint-v1',
    solverVersion: 'strict-v2',
    viewDigest: digestCanonical({ schema: 'strict-frame-view-v1', view: serializedHeldView }),
    slackPx: 7,
  };
  const trajectory: Extract<SerializedCameraTrajectory, { kind: 'hold' }> = {
    kind: 'hold',
    sampler: 'hold-v1',
    samplerVersion: '1',
    durationMs: camera.duration,
    keyframes: [
      { timeMs: 0, view: { ...serializedHeldView }, frameCertificate: { ...frameCertificate } },
      { timeMs: camera.duration, view: { ...serializedHeldView }, frameCertificate: { ...frameCertificate } },
    ],
  };
  const trajectoryDigest = computeTrajectoryDigest(trajectory);
  const plan: CommittedTrajectoryPlan = {
    inputDigest: frameCertificate.inputDigest,
    trajectory,
    trajectoryDigest,
    certification: {
      status: 'certified',
      certificate: {
        kind: 'visibility-v1',
        trajectoryDigest,
        envelopeDigest: frameCertificate.envelopeDigest,
        viewportDigest: frameCertificate.viewportDigest,
        constraintDigest: frameCertificate.constraintDigest,
        validity: { domain: 'story-local', startMs: 0, endMs: camera.duration },
        intervals: [
          {
            startMs: 0,
            endMs: camera.duration,
            slackLowerBoundPx: frameCertificate.slackPx,
            boundMethod: 'constant-frame',
          },
        ],
      },
    },
  };
  camera.trajectoryPlan = plan;

  const matching = derivePlaybackPlan([camera], { trajectoryEnabled: true, viewport });
  assert(
    matching.segments[0].trajectory?.digest === trajectoryDigest,
    'matching viewport retains the certified trajectory tuple',
  );
  const resized = derivePlaybackPlan([camera], {
    trajectoryEnabled: true,
    viewport: { width: 800, height: 600 },
  });
  assert(
    resized.segments[0].trajectory?.digest === trajectoryDigest &&
      resized.segments[0].trajectory?.serialized.kind === 'hold',
    'resized viewport preserves the applied trajectory and its original framing evidence',
  );
}

testPlaybackInsertsGapBeforeDynamicCurrentViewPullOut();
testStoppedPlaybackViewFreezesAtPlaybackTimeAndCancelsTransition();
testPlaybackCompleteIncludesExactEndTime();
testPlaybackEndReturnsStrippedFinalViewAtTotalTime();
testStartDelayCreatesBlankGapBetweenObjects();
testProgressElementsPreserveBlankGapPosition();
testStartDelayFillsAutomaticConnectionInterval();
testSameObjectCameraStartsAfterPreviousStayEnd();
testStartDelayCreatesBlankGapBetweenSameObjectCameras();
testCurrentViewCamerasRemainSeparateObjectsEvenWithSameView();
testEnabledPlaybackCompilesEverySegmentAndUsesOneSamplerLookup();
testEnabledGeneratedFlyLinearAndTimelineHoldKindsRemainExplicit();
testEnabledPlanFailsClosedInsteadOfEscapingToEndpointInterpolation();
testCertifiedPlanUsesOnlyItsSealedViewportContext();
