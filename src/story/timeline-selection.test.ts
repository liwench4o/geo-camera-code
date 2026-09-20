import { getClickOnlySelectionHandlers } from './timeline-selection';
import { derivePlaybackPlan } from './playback';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';
import type { PanelTimelineProps } from '../components/PanelTimeline';
import type { CameraMovement, TargetCameras } from '../interfaces';

interface ElementNode {
  type: unknown;
  props: { children?: unknown; [key: string]: unknown };
}

interface TimelineInstance {
  props: PanelTimelineProps;
  state: { currentTime: number };
  setState(value: { currentTime: number }): void;
  handleTimelineSliderChange(value: number): void;
  handleTimelinePauseButtonClick(): void;
  render(): ElementNode;
}

function loadTimeline() {
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
        throw new Error('Timeline cannot own a playback clock');
      },
    },
  );
  assert(Boolean(moduleValue.exports.default), 'timeline must export its actual component');
  return moduleValue.exports.default!;
}

function nodesIn(value: unknown): ElementNode[] {
  if (Array.isArray(value)) return value.flatMap(nodesIn);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as ElementNode;
  if (typeof node.type === 'function' && node.type.prototype?.render) {
    const Component = node.type as new (props: ElementNode['props']) => { render(): ElementNode };
    return [node, ...nodesIn(new Component(node.props).render())];
  }
  return [node, ...nodesIn(node.props.children), ...nodesIn(node.props.title)];
}

function cameraTableBoundary(panel: TimelineInstance): ElementNode {
  const table = nodesIn(panel.render()).find(
    (node) =>
      node.type === 'Table' ||
      (typeof node.type === 'function' && node.type.prototype?.isPureReactComponent && 'timelineData' in node.props),
  );
  assert(Boolean(table), 'timeline exposes the expensive camera table');
  return table!;
}

function shallowPropsEqual(first: ElementNode['props'], second: ElementNode['props']) {
  const keys = Object.keys(first);
  return keys.length === Object.keys(second).length && keys.every((key) => Object.is(first[key], second[key]));
}

function testPlaybackTimeDoesNotInvalidateCameraTable() {
  const panel = createTimeline({ selectedCameraId: 'source-0', isPlaying: true });
  const before = cameraTableBoundary(panel);
  panel.props = { ...panel.props, currentTimeMs: 1500 };
  const after = cameraTableBoundary(panel);
  assert(
    before.type === after.type && shallowPropsEqual(before.props, after.props),
    'advancing playback time must preserve the expensive camera table inputs',
  );
  assert(
    typeof after.type === 'function' && after.type.prototype?.isPureReactComponent,
    'the camera table must skip React rendering when its inputs are unchanged',
  );
  const progress = nodesIn(panel.render()).find(
    (node) => node.type === 'Slider' && node.props.className === 'progress-slider',
  );
  assert(progress?.props.value === 1500, 'the progress control keeps updating while the table is stable');

  panel.props = { ...panel.props, cameraPlayIndex: 0, isPlaying: false };
  const paused = cameraTableBoundary(panel);
  assert(shallowPropsEqual(after.props, paused.props), 'play/pause and playing-shot changes do not invalidate rows');
}

function testCameraTableStillReceivesEditingAndLayoutUpdates() {
  const edits: Partial<PanelTimelineProps>[] = [
    { selectedCameraId: 'source-1' },
    { timelineData: timelineData.map((target) => ({ ...target, name: 'Renamed target' })) },
    { totalTimeLength: 4000 },
    { timelineHeight: 400 },
    { expandedKeys: [] },
    { onTimelineEdit: () => undefined },
    { cameraMovementList: sourceCameras.map((camera) => ({ ...camera, title: 'Edited shot' })) },
  ];
  for (const edit of edits) {
    const panel = createTimeline({ selectedCameraId: 'source-0' });
    const before = cameraTableBoundary(panel);
    panel.props = { ...panel.props, ...edit };
    const after = cameraTableBoundary(panel);
    assert(!shallowPropsEqual(before.props, after.props), `table must update after ${Object.keys(edit).join(', ')}`);
  }
}

function textIn(value: unknown): string {
  if (Array.isArray(value)) return value.map(textIn).join('');
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (!value || typeof value !== 'object' || !('props' in value)) return '';
  return textIn((value as ElementNode).props.children);
}

const sourceCameras: CameraMovement[] = ['emphasis-static', 'emphasis-pan'].map((name, index) => ({
  id: `source-${index}`,
  name,
  title: name,
  category: 'emphasis',
  targetId: 'target-a',
  timelineTargetName: 'Target A',
  initViewState: { longitude: index * 10, latitude: 0, zoom: 4, bearing: 0, pitch: 0 },
  finalViewState: { longitude: index * 10, latitude: 0, zoom: 4, bearing: 0, pitch: 0 },
  duration: 1000,
  stay: 0,
  isRotating: false,
  interpolationType: 'linear',
  interpolationDuration: 1000,
}));

const playbackPlan = derivePlaybackPlan(sourceCameras);
const timelineData = playbackPlan.timelineData;

function createTimeline(overrides: Partial<PanelTimelineProps> = {}) {
  const Timeline = loadTimeline();
  const noop = () => undefined;
  const panel = new Timeline({
    timelineHeight: 300,
    cameraMovementList: sourceCameras,
    cameraPlayIndex: 1,
    playbackSegments: playbackPlan.segments,
    timelineData,
    totalTimeLength: playbackPlan.totalTime,
    isPlaying: false,
    targetIndex: 0,
    cameraIndex: 1,
    expandedKeys: timelineData.map((target) => target.key),
    progressElement: [],
    onTimelinePlay: noop,
    onTimelinePause: noop,
    onTimelineSeek: noop,
    onCameraPlayIndexChange: noop,
    onPlayingStatusChange: noop,
    onTimelineTargetIndexChange: noop,
    onTimelineCameraIndexChange: noop,
    onTimelineExpandedKeyChange: noop,
    onTimelineEdit: noop,
    ...overrides,
  });
  panel.setState = (value) => {
    panel.state = { ...panel.state, ...value };
  };
  return panel;
}

function renderTimeline(panel: TimelineInstance) {
  const nodes = nodesIn(panel.render());
  const table = nodes.find((node) => node.type === 'Table');
  assert(Boolean(table), 'timeline contains its camera table');
  const expandable = table!.props.expandable as {
    expandedRowRender(target: TargetCameras, targetIndex: number): ElementNode;
  };
  const rows = nodesIn(expandable.expandedRowRender(timelineData[0], 0)).filter((node) =>
    String(node.props.className).split(' ').includes('timeline-camera-row'),
  );
  return { nodes, rows };
}

function testExplicitSelectionStaysIndependentOfPlayback() {
  const panel = createTimeline({ selectedCameraId: 'source-0', isPlaying: true });
  const { nodes, rows } = renderTimeline(panel);
  const status = nodes.find((node) => node.props.role === 'status');
  assert(
    textIn(status) === 'Selected: #1 Static shot',
    'selection status uses the selected global source index and human catalog title',
  );
  assert(status!.props['aria-live'] === 'polite', 'selection status announces updates accessibly');
  assert(
    nodes.some((node) => textIn(node) === '#2 Pan shot'),
    'playback indicator continues to show source B with its human catalog title',
  );
  assert(
    String(rows[0].props.className).includes('timeline-camera-row-active'),
    'source A stays highlighted while source B is playing',
  );
  assert(
    !String(rows[1].props.className).includes('timeline-camera-row-active'),
    'playback source B does not become selected',
  );
  assert(
    rows[0].props['aria-pressed'] === true && rows[1].props['aria-pressed'] === false,
    'camera rows expose their explicit selection state',
  );
  panel.handleTimelineSliderChange(2500);
  panel.handleTimelinePauseButtonClick();
  assert(
    textIn(renderTimeline(panel).nodes.find((node) => node.props.role === 'status')) === textIn(status),
    'seeking and pausing keep the explicit selection',
  );
}

function testNoSelectionDoesNotFallBackToPlayback() {
  for (const selectedCameraId of [undefined, null, 'missing', playbackPlan.segments[1].id]) {
    const { nodes, rows } = renderTimeline(createTimeline({ selectedCameraId }));
    assert(
      textIn(nodes.find((node) => node.props.role === 'status')) === 'No camera selected',
      'missing or generated selection shows no selected camera',
    );
    assert(
      rows.every((row) => !String(row.props.className).includes('timeline-camera-row-active')),
      'playback and timeline indexes cannot supply a selection fallback',
    );
    assert(
      !nodes.some((node) => node.type === 'Button' && node.props['aria-label'] === 'Clear selection'),
      'clear is only available for an actual source selection',
    );
  }
}

function testSelectionUsesAuthoredSourceIndex() {
  const { nodes, rows } = renderTimeline(createTimeline({ selectedCameraId: 'source-1' }));
  assert(
    textIn(nodes.find((node) => node.props.role === 'status')) === 'Selected: #2 Pan shot',
    'selection uses the authored source index despite the generated playback connection',
  );
  assert(rows.length === 2, 'the playback connection contributes no timeline row');
  assert(!String(rows[0].props.className).includes('timeline-camera-row-active'), 'first source stays unselected');
  assert(String(rows[1].props.className).includes('timeline-camera-row-active'), 'exact source ID is selected');
}

function testClearSelectionStopsPropagation() {
  let clearCount = 0;
  let stopped = false;
  const { nodes } = renderTimeline(
    createTimeline({
      selectedCameraId: 'source-0',
      onClearCameraSelection: () => {
        clearCount += 1;
      },
    }),
  );
  const clear = nodes.find((node) => node.type === 'Button' && node.props['aria-label'] === 'Clear selection');
  assert(Boolean(clear), 'selected camera exposes a clearly named clear action');
  (clear!.props.onClick as (event: { stopPropagation(): void }) => void)({
    stopPropagation: () => {
      stopped = true;
    },
  });
  assert(clearCount === 1 && stopped, 'clear invokes its callback once without selecting a containing row');
}

function testKeyboardSelectionIgnoresNestedControlsAndDoesNotToggle() {
  const selectedRows: number[] = [];
  const { rows } = renderTimeline(
    createTimeline({
      selectedCameraId: 'source-0',
      onTimelineCameraIndexChange: (_targetIndex, cameraIndex) => {
        selectedRows.push(cameraIndex);
      },
    }),
  );
  const row = rows[0];
  assert(
    row.props.tabIndex === 0 && row.props.role === 'button',
    'camera row is keyboard focusable and named as an action',
  );
  assert(String(row.props['aria-label']).includes('Static shot'), 'camera selection action uses a human title');
  const onKeyDown = row.props.onKeyDown as (event: {
    key: string;
    target: object;
    currentTarget: object;
    preventDefault(): void;
  }) => void;
  const rowTarget = {};
  let prevented = 0;
  for (const key of ['Enter', ' '])
    onKeyDown({
      key,
      target: rowTarget,
      currentTarget: rowTarget,
      preventDefault: () => {
        prevented += 1;
      },
    });
  onKeyDown({
    key: 'Enter',
    target: {},
    currentTarget: rowTarget,
    preventDefault: () => {
      prevented += 1;
    },
  });
  onKeyDown({
    key: 'ArrowRight',
    target: rowTarget,
    currentTarget: rowTarget,
    preventDefault: () => {
      prevented += 1;
    },
  });
  assert(
    selectedRows.length === 2 && selectedRows.every((index) => index === 0),
    'Enter and Space explicitly reselect the row without toggling; nested controls and arrow keys do not select',
  );
  assert(prevented === 2, 'row selection only handles its own activation keys');
}

function testRowClicksRemainExplicitAndTimingControlsDoNotSelect() {
  const selectedRows: number[] = [];
  const { rows } = renderTimeline(
    createTimeline({
      selectedCameraId: 'source-0',
      onTimelineCameraIndexChange: (_targetIndex, cameraIndex) => {
        selectedRows.push(cameraIndex);
      },
    }),
  );
  (rows[0].props.onClick as () => void)();
  (rows[0].props.onClick as () => void)();
  assert(selectedRows.join(',') === '0,0', 'repeated row clicks explicitly select without toggling');
  const timingCell = nodesIn(rows[0]).find((node) => node.props.className === 'timeline-camera-time-cell');
  let stopped = false;
  (timingCell!.props.onClick as (event: { stopPropagation(): void }) => void)({
    stopPropagation: () => {
      stopped = true;
    },
  });
  assert(stopped && selectedRows.length === 2, 'timing controls stop their click before it reaches row selection');
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function testClickInvokesSelection() {
  let selected = false;
  const handlers = getClickOnlySelectionHandlers(() => {
    selected = true;
  });

  handlers.onClick();

  assert(selected, 'click should invoke the selection handler');
}

function testHoverDoesNotExposeSelectionHandler() {
  let selectionCount = 0;
  const handlers = getClickOnlySelectionHandlers(() => {
    selectionCount += 1;
  });

  assert(!('onMouseEnter' in handlers), 'hover should not expose a selection handler');
  assert(selectionCount === 0, `hover-only setup should not select a row, received ${selectionCount}`);
}

function testLegendOnlyListsAuthoredShotCategories() {
  const legend = nodesIn(createTimeline().render().props.extra)
    .filter((node) => node.type === 'Badge')
    .map((node) => textIn(node.props.text));
  assert(!legend.includes('Transition'), 'implicit connections do not appear as an authored shot category');
  assert(
    legend.includes('Overview') && legend.includes('Emphasis') && legend.includes('Comparison'),
    'authored shot categories keep their existing legend',
  );
}

function run() {
  testPlaybackTimeDoesNotInvalidateCameraTable();
  testCameraTableStillReceivesEditingAndLayoutUpdates();
  testLegendOnlyListsAuthoredShotCategories();
  testClickInvokesSelection();
  testHoverDoesNotExposeSelectionHandler();
  testExplicitSelectionStaysIndependentOfPlayback();
  testNoSelectionDoesNotFallBackToPlayback();
  testSelectionUsesAuthoredSourceIndex();
  testClearSelectionStopsPropagation();
  testKeyboardSelectionIgnoresNestedControlsAndDoesNotToggle();
  testRowClicksRemainExplicitAndTimingControlsDoNotSelect();
}

run();
