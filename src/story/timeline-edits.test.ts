import type { CameraMovement, CameraView, TargetCameras, TimelineEdit } from '../interfaces';
import { derivePlaybackPlan } from './playback';
import { applyTimelineResizeEdit } from './timeline-edits';
import { computeTrajectoryDigest } from '../camera/trajectory/validation';
import type { SerializedCameraTrajectory } from '../camera/trajectory/types';
import { getViewAtPlaybackTime } from './playback';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
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

function createCamera(id: string, overrides: Partial<CameraMovement> = {}): CameraMovement {
  return {
    id,
    name: id,
    title: id,
    category: 'dynamic',
    targetId: 'target-a',
    initViewState: createView({ longitude: 0 }),
    finalViewState: createView({ longitude: 1 }),
    duration: 1000,
    stay: 500,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
    ...overrides,
  };
}

function createTimelineData(): TargetCameras[] {
  return [
    {
      key: 'target-a',
      name: 'Target A',
      type: 'location',
      location: [0, 0],
      targetStart: 0,
      targetEnd: 2500,
      cameras: [
        {
          id: 'first',
          title: 'first',
          category: 'dynamic',
          start: 0,
          duration: 1000,
          stay: 500,
          sourceIndex: 0,
          editable: true,
        },
        {
          id: 'second',
          title: 'second',
          category: 'dynamic',
          start: 1500,
          duration: 1000,
          stay: 0,
          sourceIndex: 1,
          editable: true,
        },
      ],
    },
  ];
}

function createTimelineDataWithGap(): TargetCameras[] {
  return [
    {
      key: 'target-a',
      name: 'Target A',
      type: 'location',
      location: [0, 0],
      targetStart: 0,
      targetEnd: 2500,
      cameras: [
        {
          id: 'first',
          title: 'first',
          category: 'dynamic',
          start: 0,
          duration: 1000,
          stay: 0,
          sourceIndex: 0,
          editable: true,
        },
        {
          id: 'second',
          title: 'second',
          category: 'dynamic',
          start: 1500,
          duration: 1000,
          stay: 0,
          sourceIndex: 1,
          editable: true,
        },
      ],
    },
  ];
}

function createSplitTimelineData(): TargetCameras[] {
  return [
    {
      key: 'target-a',
      name: 'Target A',
      type: 'location',
      location: [0, 0],
      targetStart: 0,
      targetEnd: 1500,
      cameras: [
        {
          id: 'first',
          title: 'first',
          category: 'dynamic',
          start: 0,
          duration: 1000,
          stay: 500,
          sourceIndex: 0,
          editable: true,
        },
      ],
    },
    {
      key: 'target-b',
      name: 'Target B',
      type: 'location',
      location: [1, 1],
      targetStart: 1500,
      targetEnd: 2500,
      cameras: [
        {
          id: 'second',
          title: 'second',
          category: 'dynamic',
          start: 1500,
          duration: 1000,
          stay: 0,
          sourceIndex: 1,
          editable: true,
        },
      ],
    },
  ];
}

function testShorteningStayEndPreservesNextCameraStartWithGap() {
  const edit: TimelineEdit = {
    type: 'ripple-resize',
    camera: createTimelineData()[0].cameras[0],
    edge: 'end',
    valueMs: 1000,
  };

  const result = applyTimelineResizeEdit({
    cameraList: [
      createCamera('first'),
      createCamera('second', {
        initViewState: createView({ longitude: 1 }),
        finalViewState: createView({ longitude: 2 }),
        stay: 0,
      }),
    ],
    timelineData: createTimelineData(),
    edit,
    totalTimeLength: 2500,
  });

  assert(result !== undefined, 'stay end edit should return edited camera list');
  assert(result.cameraList[0].stay === 0, `first stay should shrink to 0, received ${result.cameraList[0].stay}`);
  assert(
    result.cameraList[1].startDelay === 500,
    `second camera should keep a 500ms start gap, received ${result.cameraList[1].startDelay}`,
  );

  const plan = derivePlaybackPlan(result.cameraList);
  assert(
    plan.timelineData[0].cameras[1].start === 1500,
    `second camera start should stay at 1500, received ${plan.timelineData[0].cameras[1].start}`,
  );
}

function testShorteningLastCameraStayEndPreservesNextObjectCameraStartWithGap() {
  const edit: TimelineEdit = {
    type: 'ripple-resize',
    camera: createSplitTimelineData()[0].cameras[0],
    edge: 'end',
    valueMs: 1000,
  };

  const result = applyTimelineResizeEdit({
    cameraList: [
      createCamera('first', { targetId: 'target-a' }),
      createCamera('second', {
        targetId: 'target-b',
        initViewState: createView({ longitude: 1 }),
        finalViewState: createView({ longitude: 2 }),
        stay: 0,
      }),
    ],
    timelineData: createSplitTimelineData(),
    edit,
    totalTimeLength: 2500,
  });

  assert(result !== undefined, 'cross-object stay end edit should return edited camera list');
  assert(
    result.cameraList[1].startDelay === 500,
    `next object camera should keep a 500ms start gap, received ${result.cameraList[1].startDelay}`,
  );

  const plan = derivePlaybackPlan(result.cameraList);
  assert(
    plan.timelineData[1].cameras[0].start === 1500,
    `next object camera start should stay at 1500, received ${plan.timelineData[1].cameras[0].start}`,
  );
}

function testDraggingNextCameraStartCreatesGapWithoutExtendingPreviousStay() {
  const edit: TimelineEdit = {
    type: 'ripple-resize',
    camera: createTimelineData()[0].cameras[1],
    edge: 'start',
    valueMs: 2500,
  };

  const result = applyTimelineResizeEdit({
    cameraList: [
      createCamera('first'),
      createCamera('second', {
        initViewState: createView({ longitude: 1 }),
        finalViewState: createView({ longitude: 2 }),
        stay: 0,
      }),
    ],
    timelineData: createTimelineData(),
    edit,
    totalTimeLength: 2500,
  });

  assert(result !== undefined, 'camera start edit should return edited camera list');
  assert(
    result.cameraList[0].stay === 500,
    `previous stay should not absorb the gap, received ${result.cameraList[0].stay}`,
  );
  assert(
    result.cameraList[1].startDelay === 1000,
    `second camera should keep a 1000ms start gap, received ${result.cameraList[1].startDelay}`,
  );
  assert(
    result.cameraList[1].duration === 0,
    `second camera duration should shrink from its fixed end, received ${result.cameraList[1].duration}`,
  );
}

function testDraggingCameraStartLeftExtendsDurationIntoGap() {
  const edit: TimelineEdit = {
    type: 'ripple-resize',
    camera: createTimelineDataWithGap()[0].cameras[1],
    edge: 'start',
    valueMs: 1200,
  };

  const result = applyTimelineResizeEdit({
    cameraList: [
      createCamera('first', { stay: 0 }),
      createCamera('second', {
        initViewState: createView({ longitude: 1 }),
        finalViewState: createView({ longitude: 2 }),
        stay: 0,
      }),
    ],
    timelineData: createTimelineDataWithGap(),
    edit,
    totalTimeLength: 2500,
  });

  assert(result !== undefined, 'left camera start edit should return edited camera list');
  assert(
    result.cameraList[1].startDelay === 200,
    `second camera gap should shrink to 200ms, received ${result.cameraList[1].startDelay}`,
  );
  assert(
    result.cameraList[1].duration === 1300,
    `second camera duration should extend to keep its end fixed, received ${result.cameraList[1].duration}`,
  );

  const plan = derivePlaybackPlan(result.cameraList);
  assert(
    plan.timelineData[0].cameras[1].start === 1200,
    `second camera should start at dragged time, received ${plan.timelineData[0].cameras[1].start}`,
  );
  assert(plan.totalTime === 2500, `dragging start left should keep total time fixed, received ${plan.totalTime}`);
}

testShorteningStayEndPreservesNextCameraStartWithGap();
testShorteningLastCameraStayEndPreservesNextObjectCameraStartWithGap();
testDraggingNextCameraStartCreatesGapWithoutExtendingPreviousStay();
testDraggingCameraStartLeftExtendsDurationIntoGap();

function testTimelineRetimePreservesIntermediateAuthoredPath() {
  const initial = { longitude: 0, latitude: 0, zoom: 10, pitch: 35, bearing: 0 };
  const final = { ...initial, longitude: 1 };
  const trajectory: SerializedCameraTrajectory = {
    kind: 'keyframed',
    sampler: 'linear-v1',
    samplerVersion: '1',
    durationMs: 1000,
    keyframes: [
      { timeMs: 0, view: initial },
      { timeMs: 500, view: { ...initial, latitude: 1 } },
      { timeMs: 1000, view: final },
    ],
  };
  const camera = createCamera('first', {
    initViewState: initial,
    finalViewState: final,
    authoring: {
      version: 1,
      targetId: 'target-a',
      recipeId: 'tracking',
      adjustments: {},
      planningViewport: { width: 1440, height: 900 },
    },
    trajectoryPlan: {
      inputDigest: 'original',
      trajectory,
      trajectoryDigest: computeTrajectoryDigest(trajectory),
      certification: { status: 'unknown', reason: 'interval-bound-unavailable' },
    },
    framingReport: {
      status: 'warning',
      scope: 'route-window',
      sampleCount: 3,
      worstTimeMs: 500,
      messages: ['Close-up'],
    },
  });
  const result = applyTimelineResizeEdit({
    cameraList: [camera],
    timelineData: createTimelineData(),
    totalTimeLength: 1500,
    edit: { type: 'ripple-resize', edge: 'motion-end', camera: createTimelineData()[0].cameras[0], valueMs: 750 },
  });
  assert(result !== undefined, 'timeline edit returns an authored movement');
  const resized = result.cameraList[0];
  assert(resized.trajectoryPlan?.trajectory.durationMs === 750, 'retime applied trajectory with movement');
  assert(resized.authoring?.timing?.duration === 750, 'keep explicit author timing');
  assert(resized.framingReport?.worstTimeMs === 375, 'retime report observations on the same path');
  assert(
    getViewAtPlaybackTime(derivePlaybackPlan([resized]).segments, 375)?.latitude === 1,
    'route middle survives timeline resize',
  );
  assert(camera.trajectoryPlan?.trajectory.durationMs === 1000, 'original applied plan remains immutable');
}

testTimelineRetimePreservesIntermediateAuthoredPath();
