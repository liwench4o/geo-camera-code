import type { TargetCamera, TargetCameras, TimelineEdit, TimelineResizeEdge } from '../interfaces';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';
import type { PanelTimelineProps } from '../components/PanelTimeline';
import {
  createCameraTimingMarks,
  getCameraEndDefaultMs,
  getCameraEndMaxMs,
  getCameraTimingSliderConfig,
  getCameraTimingSliderEdit,
} from './timeline-controls';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function createCamera(overrides: Partial<TargetCamera> = {}): TargetCamera {
  return {
    id: 'camera-1',
    name: 'dynamic-pan',
    title: 'Dynamic pan',
    category: 'dynamic',
    start: 5000,
    duration: 2000,
    stay: 1000,
    sourceIndex: 0,
    editable: true,
    ...overrides,
  };
}

function assertEdit(edit: TimelineEdit | undefined, edge: TimelineResizeEdge, valueMs: number) {
  assert(edit?.type === 'ripple-resize', 'slider edit should emit a ripple resize edit');
  assert(edit.edge === edge, `expected ${edge} edge, received ${edit.edge}`);
  assert(edit.valueMs === valueMs, `expected absolute value ${valueMs}, received ${edit.valueMs}`);
}

function testDraggingCameraEndEmitsMotionEndAtAbsoluteTime() {
  const camera = createCamera();
  const edit = getCameraTimingSliderEdit(camera, [5000, 7500, 8000]);

  assertEdit(edit, 'motion-end', 7500);
}

function testDraggingStayEndEmitsEndAtAbsoluteTime() {
  const camera = createCamera();
  const edit = getCameraTimingSliderEdit(camera, [5000, 7000, 9500]);

  assertEdit(edit, 'end', 9500);
}

function testDraggingCameraStartEmitsStartAtAbsoluteTime() {
  const camera = createCamera({ sourceIndex: 1 });
  const edit = getCameraTimingSliderEdit(camera, [6200, 7000, 8000]);

  assertEdit(edit, 'start', 6200);
}

function testDraggingCameraStartClampsToMinimumAnchor() {
  const camera = createCamera({ sourceIndex: 1 });
  const edit = getCameraTimingSliderEdit(camera, [3000, 7000, 8000], {
    minStartMs: 4500,
  });

  assertEdit(edit, 'start', 4500);
}

function testLockedCameraStartDoesNotEmitEdit() {
  const camera = createCamera({ sourceIndex: 0 });
  const edit = getCameraTimingSliderEdit(camera, [1200, 7000, 8000], {
    startLocked: true,
  });

  assert(edit === undefined, 'locked camera start should not emit timeline edits');
}

function testGeneratedCamerasCannotEmitTimingEdits() {
  for (const generated of ['gap-transition', 'timeline-gap'] as const) {
    const camera = createCamera({ generated, editable: false, sourceIndex: 1 });
    assert(
      getCameraTimingSliderEdit(camera, [5000, 6800, 8000]) === undefined,
      'generated playback segments cannot emit authored timeline edits',
    );
  }
}

function testCameraEndCannotPassStayEnd() {
  const camera = createCamera();
  const config = getCameraTimingSliderConfig(camera, [5000, 10000, 8000]);

  assert(config.values[1] === 8000, `camera end should clamp to stay end, received ${config.values[1]}`);
  assert(config.values[2] === 8000, `stay end should remain at 8000, received ${config.values[2]}`);
}

function testCameraEndEditCannotPassStayEnd() {
  const camera = createCamera();
  const edit = getCameraTimingSliderEdit(camera, [5000, 10000, 8000]);

  assertEdit(edit, 'motion-end', 8000);
}

function testStayEndUsesTimelineMaxWithoutExtensionHeadroom() {
  const camera = createCamera({ duration: 2000, stay: 1500 });
  const config = getCameraTimingSliderConfig(camera, undefined, {
    timelineEndMs: 12000,
  });

  assert(config.max === 12000, `slider max should use timeline end without extension headroom, received ${config.max}`);
}

function testSliderMaxUsesTimelineScaleWhenExplicitEndBoundaryIsEarlier() {
  const camera = createCamera({ duration: 2000, stay: 1000 });
  const config = getCameraTimingSliderConfig(camera, undefined, {
    timelineEndMs: 12000,
    maxEndMs: 9000,
  });

  assert(config.max === 12000, `slider max should keep timeline scale, received ${config.max}`);
  assert(config.values[2] === 9000, `stay end should clamp to explicit end boundary, received ${config.values[2]}`);
}

function testStayEndCannotPassExplicitEndBoundary() {
  const camera = createCamera();
  const config = getCameraTimingSliderConfig(camera, [5000, 7000, 9500], {
    maxEndMs: 8500,
  });

  assert(config.values[2] === 8500, `stay end should clamp to max end, received ${config.values[2]}`);
}

function testStayEndDefaultsToDynamicEndBoundary() {
  const camera = createCamera({ duration: 2000, stay: 1000 });
  const config = getCameraTimingSliderConfig(camera, undefined, {
    maxEndMs: 9000,
  });

  assert(config.values[2] === 9000, `stay end should align to dynamic end boundary, received ${config.values[2]}`);
}

function testCameraEndCannotPassClampedStayEnd() {
  const camera = createCamera();
  const config = getCameraTimingSliderConfig(camera, [5000, 9000, 9500], {
    maxEndMs: 8500,
  });

  assert(config.values[1] === 8500, `camera end should clamp to clamped stay end, received ${config.values[1]}`);
  assert(config.values[2] === 8500, `stay end should clamp to max end, received ${config.values[2]}`);
}

function testCameraEndClampsAgainstDynamicEndBoundary() {
  const camera = createCamera({ duration: 5000, stay: 1000 });
  const config = getCameraTimingSliderConfig(camera, undefined, {
    maxEndMs: 8000,
  });

  assert(config.values[1] === 8000, `camera end should clamp to dynamic stay end, received ${config.values[1]}`);
  assert(config.values[2] === 8000, `stay end should align to dynamic end boundary, received ${config.values[2]}`);
}

function testLastCameraDefaultEndUsesCurrentObjectEndBeforeBlankGap() {
  const timelineData: TargetCameras[] = [
    {
      key: 'current-view-1',
      name: 'Current view',
      type: 'region',
      location: [0, 0],
      targetStart: 5000,
      targetEnd: 8000,
      cameras: [createCamera()],
    },
    {
      key: 'current-view-2',
      name: 'Current view',
      type: 'region',
      location: [1, 1],
      targetStart: 12000,
      targetEnd: 14000,
      cameras: [createCamera({ id: 'camera-2', start: 12000, duration: 2000, stay: 0, sourceIndex: 1 })],
    },
  ];

  const defaultEndMs = getCameraEndDefaultMs(timelineData, 0, 0);

  assert(defaultEndMs === 8000, `last camera stay end should stop at object end, received ${defaultEndMs}`);
}

function testCameraEndDefaultUsesOwnEndBeforeNextCameraGap() {
  const timelineData: TargetCameras[] = [
    {
      key: 'target-a',
      name: 'Target A',
      type: 'location',
      location: [0, 0],
      targetStart: 5000,
      targetEnd: 12000,
      cameras: [
        createCamera({ start: 5000, duration: 2000, stay: 1000, sourceIndex: 0 }),
        createCamera({ id: 'camera-2', start: 10000, duration: 1000, stay: 1000, sourceIndex: 1 }),
      ],
    },
  ];

  const defaultEndMs = getCameraEndDefaultMs(timelineData, 0, 0);
  const maxEndMs = getCameraEndMaxMs(timelineData, 0, 0, 12000);

  assert(defaultEndMs === 8000, `camera stay end should default to its own end, received ${defaultEndMs}`);
  assert(maxEndMs === 10000, `camera stay end should still extend up to next camera start, received ${maxEndMs}`);
}

function testLastCameraEndMaxStopsAtTimelineEndWithoutHeadroom() {
  const timelineData: TargetCameras[] = [
    {
      key: 'current-view-1',
      name: 'Current view',
      type: 'region',
      location: [0, 0],
      targetStart: 5000,
      targetEnd: 8000,
      cameras: [createCamera()],
    },
  ];

  const defaultEndMs = getCameraEndDefaultMs(timelineData, 0, 0);
  const maxEndMs = getCameraEndMaxMs(timelineData, 0, 0, 8000);

  assert(defaultEndMs === 8000, `last camera stay end should default to object end, received ${defaultEndMs}`);
  assert(maxEndMs === 8000, `last camera stay end should stop at timeline end, received max ${maxEndMs}`);
}

function testDefaultTimingValuesUseAbsoluteTime() {
  const camera = createCamera();
  const config = getCameraTimingSliderConfig(camera);

  assert(config.values[0] === 5000, `camera start should use absolute time, received ${config.values[0]}`);
  assert(config.values[1] === 7000, `camera end should use absolute time, received ${config.values[1]}`);
  assert(config.values[2] === 8000, `stay end should use absolute time, received ${config.values[2]}`);
}

function testOverlappingMarksAreMerged() {
  const marks = createCameraTimingMarks([5000, 7000, 7000]);
  const mark = marks[7000];

  assert(typeof mark === 'object' && mark !== null && 'label' in mark, 'merged mark should keep an AntD mark object');
  assert(
    mark.label === 'camera end',
    `overlapped camera/stay mark should only show camera end, received ${mark.label}`,
  );
}

function testPausedSliderAndCaptionUseTheSameMillisecondWithoutRoundingTheCamera() {
  interface ElementNode {
    type: unknown;
    props: { children?: unknown; [key: string]: unknown };
  }
  interface TimelineInstance {
    props: PanelTimelineProps;
    state: { currentTime: number };
    setState(value: { currentTime: number }): void;
    handleTimelinePlayButtonClick(): void;
    handleTimelineSliderChange(timeMs: number): void;
    handleTimelineBackButtonClick(): void;
    handleTimelineNextButtonClick(): void;
    handleTimelinePauseButtonClick(): void;
    render(): ElementNode;
  }
  const output = ts.transpileModule(readFileSync('src/components/PanelTimeline.tsx', 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const localRequire = (id: string): unknown => {
    if (id.endsWith('.css')) return {};
    if (id === 'antd') {
      return {
        ...Object.fromEntries(
          ['Badge', 'Button', 'Card', 'Col', 'Popconfirm', 'Row', 'Slider', 'Space', 'Table', 'Tag'].map((name) => [
            name,
            name,
          ]),
        ),
        Typography: { Text: 'Text' },
      };
    }
    if (id === '@ant-design/icons' || id.startsWith('react-icons/'))
      return new Proxy({}, { get: (_, key) => String(key) });
    if (id === 'react-multi-progress') return { __esModule: true, default: 'MultiProgress' };
    return id.startsWith('.') ? require(path.resolve('.cache/camera-tests/src/components', id)) : require(id);
  };
  const moduleValue: { exports: { default?: new (props: PanelTimelineProps) => TimelineInstance } } = { exports: {} };
  const execute = runInThisContext(`(function(require, module, exports, window, performance) {\n${output}\n})`) as (
    ...args: unknown[]
  ) => void;
  execute(
    localRequire,
    moduleValue,
    moduleValue.exports,
    {},
    {
      now: () => {
        throw new Error('Timeline must never advance its own clock');
      },
    },
  );
  assert(Boolean(moduleValue.exports.default), 'timeline must export its actual component');
  let pausedTime = -1;
  let soughtTime = -1;
  const noop = () => undefined;
  const panel = new moduleValue.exports.default!({
    timelineHeight: 300,
    cameraMovementList: [],
    cameraPlayIndex: -1,
    playbackSegments: [],
    timelineData: [],
    totalTimeLength: 3200,
    currentTimeMs: 399.875,
    isPlaying: false,
    targetIndex: -1,
    cameraIndex: -1,
    expandedKeys: [],
    progressElement: [],
    onTimelinePlay: (timeMs) => assert(timeMs === 399.875, 'play starts at authoritative progress'),
    onTimelinePause: (value) => {
      pausedTime = value ?? -1;
    },
    onTimelineSeek: (timeMs) => {
      soughtTime = timeMs;
    },
    onCameraPlayIndexChange: noop,
    onPlayingStatusChange: noop,
    onTimelineTargetIndexChange: noop,
    onTimelineCameraIndexChange: noop,
    onTimelineExpandedKeyChange: noop,
    onTimelineEdit: noop,
  });
  panel.setState = (value) => {
    panel.state = { ...panel.state, ...value };
  };
  panel.handleTimelinePlayButtonClick();
  panel.handleTimelinePauseButtonClick();
  assert(pausedTime === 399.875 && panel.state.currentTime === 399.875, 'pause keeps the exact fractional sample time');
  const nodes: ElementNode[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object' || !('props' in value)) return;
    const node = value as ElementNode;
    nodes.push(node);
    visit(node.props.children);
  };
  visit(panel.render());
  const slider = nodes.find((node) => node.type === 'Slider' && node.props.className === 'progress-slider');
  assert(Boolean(slider), 'playback seek slider exists');
  assert(slider!.props.step === 1, 'seek precision must be one millisecond rather than 100ms');
  assert(
    slider!.props.value === 399,
    'display floors fractional milliseconds so slider snapping cannot cross the caption boundary',
  );
  const formatter = (slider!.props.tooltip as { formatter(value: number): string }).formatter;
  const caption = nodes.find((node) => node.type === 'Text' && String(node.props.children).startsWith('['));
  assert(
    caption?.props.children === `[${formatter(Number(slider!.props.value))}/00:03.20]`,
    'slider tooltip and caption show the same paused time',
  );
  assert(panel.state.currentTime === pausedTime, 'rendering must not alter the paused camera time');
  panel.props = { ...panel.props, currentTimeMs: 1575.25 };
  panel.handleTimelineSliderChange(250.5);
  assert(Number(pausedTime) === 1575.25, 'seek pauses the latest controlled frame instead of stale local state');
  assert(Number(soughtTime) === 250.5, 'seek forwards the exact chosen time');
  panel.handleTimelineBackButtonClick();
  assert(Number(soughtTime) === 0, 'back requests the start frame');
  panel.handleTimelineNextButtonClick();
  assert(Number(soughtTime) === 3200, 'next requests the final frame');
}

testPausedSliderAndCaptionUseTheSameMillisecondWithoutRoundingTheCamera();
testDraggingCameraEndEmitsMotionEndAtAbsoluteTime();
testDraggingStayEndEmitsEndAtAbsoluteTime();
testDraggingCameraStartEmitsStartAtAbsoluteTime();
testDraggingCameraStartClampsToMinimumAnchor();
testLockedCameraStartDoesNotEmitEdit();
testGeneratedCamerasCannotEmitTimingEdits();
testCameraEndCannotPassStayEnd();
testCameraEndEditCannotPassStayEnd();
testStayEndUsesTimelineMaxWithoutExtensionHeadroom();
testSliderMaxUsesTimelineScaleWhenExplicitEndBoundaryIsEarlier();
testStayEndCannotPassExplicitEndBoundary();
testStayEndDefaultsToDynamicEndBoundary();
testCameraEndCannotPassClampedStayEnd();
testCameraEndClampsAgainstDynamicEndBoundary();
testLastCameraDefaultEndUsesCurrentObjectEndBeforeBlankGap();
testCameraEndDefaultUsesOwnEndBeforeNextCameraGap();
testLastCameraEndMaxStopsAtTimelineEndWithoutHeadroom();
testDefaultTimingValuesUseAbsoluteTime();
testOverlappingMarksAreMerged();
