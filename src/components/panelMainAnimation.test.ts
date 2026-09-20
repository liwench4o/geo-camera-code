import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';
import type PanelMain from './PanelMain';
import type { PanelMainProps } from './PanelMain';
import { getVisualizationDefaultParams, visualizationCatalog } from '../visualization/catalog';
import * as visualizationRegistry from '../visualization/registry';
import type { ResolvedVisualizationRuntime, VisualizationParameterValues } from '../visualization/types';
import { normalizeTimedPath } from '../camera/timed-path';
import type { PlaybackSegment } from '../interfaces';

let now = 0;
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
const listeners = new Map<string, Set<() => void>>();
const pendingRuntimeResolutions: Array<(runtime: ResolvedVisualizationRuntime) => void> = [];
const documentMock = {
  hidden: false,
  addEventListener(name: string, callback: () => void) {
    const callbacks = listeners.get(name) ?? new Set();
    callbacks.add(callback);
    listeners.set(name, callbacks);
  },
  removeEventListener(name: string, callback: () => void) {
    listeners.get(name)?.delete(callback);
  },
};
const windowMock = {
  requestAnimationFrame(callback: FrameRequestCallback) {
    frames.set(++nextFrame, callback);
    return nextFrame;
  },
  cancelAnimationFrame(id: number) {
    frames.delete(id);
  },
  clearTimeout,
};
function tick(timestamp: number) {
  now = timestamp;
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((callback) => callback(timestamp));
}
function visibility(hidden: boolean) {
  documentMock.hidden = hidden;
  listeners.get('visibilitychange')?.forEach((callback) => callback());
}
function loadPanel(): typeof PanelMain {
  const output = ts.transpileModule(readFileSync('src/components/PanelMain.tsx', 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const localRequire = (id: string): unknown => {
    if (id.endsWith('.css')) return {};
    if (id === '../visualization/registry')
      return {
        ...visualizationRegistry,
        resolveVisualizationRuntime: () =>
          new Promise<ResolvedVisualizationRuntime>((resolve) => pendingRuntimeResolutions.push(resolve)),
      };
    if (id === '@deck.gl/react') return { DeckGL: 'DeckGL' };
    if (id === './ComparisonSplitView') return { __esModule: true, default: 'ComparisonSplitView' };
    if (['@ant-design/icons', 'react-map-gl/maplibre', './ViewStateEditorModal'].includes(id))
      return new Proxy({}, { get: () => 'div' });
    if (id === 'antd')
      return {
        Typography: { Paragraph: 'p', Title: 'h4', Text: 'span' },
        Card: 'div',
        Alert: 'div',
        Button: 'button',
        Space: 'div',
        Tooltip: 'div',
        message: { info() {}, success() {}, warning() {}, error() {} },
      };
    return id.startsWith('.') ? require(path.resolve('.cache/camera-tests/src/components', id)) : require(id);
  };
  const moduleValue = { exports: {} as { default: typeof PanelMain } };
  runInThisContext(`(function(require,module,exports,window,document,performance){${output}\n})`)(
    localRequire,
    moduleValue,
    moduleValue.exports,
    windowMock,
    documentMock,
    { now: () => now },
  );
  return moduleValue.exports.default;
}
const Panel = loadPanel();
const config = visualizationCatalog.visualizations.find((entry) => entry.id === 'animated')!;
type AnimationPanel = PanelMain;
function createPanel(params: VisualizationParameterValues = { isAnimated: true, animationSpeed: 1 }) {
  now = 0;
  frames.clear();
  listeners.clear();
  pendingRuntimeResolutions.length = 0;
  documentMock.hidden = false;
  const panel = new Panel({
    viewState: { longitude: -74, latitude: 40.7, zoom: 12, pitch: 45, bearing: 0 },
    activeVisualizationId: 'animated',
    visualizationParams: params,
    visualizationCatalog,
    manualParameterKeys: [],
    catalogValidationErrors: [],
    viewportSize: { width: 1000, height: 600 },
    onShadowSceneIdentityChange() {},
  } as unknown as PanelMainProps);
  panel.setState = ((patch: object | ((state: typeof panel.state) => object), callback?: () => void) => {
    panel.state = { ...panel.state, ...(typeof patch === 'function' ? patch(panel.state) : patch) };
    callback?.();
  }) as typeof panel.setState;
  // Keep real animation lifecycle while replacing unrelated map/data loading.
  Object.assign(panel, {
    markShellRender() {},
    measureMapViewportSize() {},
    updateVisualization() {
      (panel as unknown as { syncAnimationLoop(): void }).syncAnimationLoop();
    },
  });
  panel.state = {
    ...panel.state,
    visualizationRuntime: {
      config,
      animation: { ...config.animation, speedParam: 'animationSpeed' },
    } as unknown as ResolvedVisualizationRuntime,
  };
  panel.componentDidMount();
  return panel;
}
function changeParams(panel: AnimationPanel, patch: VisualizationParameterValues) {
  const previous = panel.props;
  Object.assign(panel, { props: { ...previous, visualizationParams: { ...previous.visualizationParams, ...patch } } });
  panel.componentDidUpdate(previous, panel.state);
}
function close(actual: number, expected: number) {
  assert(Math.abs(actual - expected) < 1e-8, `expected ${expected}, got ${actual}`);
}
let failures = 0;
function test(name: string, run: () => void) {
  try {
    run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}:`, (error as Error).message);
  }
}

test('Animated Lines defaults to enabled at 1x', () => {
  const defaults = getVisualizationDefaultParams(config);
  assert.equal(defaults.isAnimated, true);
  assert.equal(defaults.animationSpeed, 1);
});
test('all five speeds advance equally at 30, 60 and 120 Hz', () => {
  for (const speed of [0.25, 0.5, 1, 2, 4]) {
    for (const hz of [30, 60, 120]) {
      const panel = createPanel({ isAnimated: true, animationSpeed: speed });
      tick(0);
      for (let frame = 1; frame <= hz; frame++) tick((frame * 1000) / hz);
      close(panel.state.animationTime, 60 * speed);
      panel.componentWillUnmount();
    }
  }
});
test('speed changes preserve phase and the trail parameter', () => {
  const panel = createPanel({ isAnimated: true, animationSpeed: 1, trailLength: 180 });
  tick(0);
  tick(100);
  close(panel.state.animationTime, 6);
  changeParams(panel, { animationSpeed: 4 });
  close(panel.state.animationTime, 6);
  tick(200);
  close(panel.state.animationTime, 30);
  assert.equal(panel.props.visualizationParams.trailLength, 180);
});
test('pause and resume exclude paused time and retain speed', () => {
  const panel = createPanel();
  tick(0);
  tick(100);
  changeParams(panel, { isAnimated: false, animationSpeed: 2 });
  assert.equal(frames.size, 0);
  tick(5000);
  close(panel.state.animationTime, 6);
  changeParams(panel, { isAnimated: true });
  tick(5000);
  tick(5100);
  close(panel.state.animationTime, 18);
});
test('drawing and page visibility pause without catch-up or duplicate loops', () => {
  const panel = createPanel();
  tick(0);
  tick(100);
  const previous = panel.state;
  panel.state = { ...previous, mapDrawing: true };
  panel.componentDidUpdate(panel.props, previous);
  assert.equal(frames.size, 0);
  tick(4000);
  const drawing = panel.state;
  panel.state = { ...drawing, mapDrawing: false };
  panel.componentDidUpdate(panel.props, drawing);
  tick(4000);
  tick(4100);
  close(panel.state.animationTime, 12);
  visibility(true);
  assert.equal(frames.size, 0);
  tick(9000);
  visibility(false);
  visibility(false);
  assert.equal(frames.size, 1);
  tick(9000);
  tick(9100);
  close(panel.state.animationTime, 18);
});
test('large frame gaps cap at 100ms and wrap within the existing cycle', () => {
  const panel = createPanel({ isAnimated: true, animationSpeed: 4 });
  panel.state = { ...panel.state, animationTime: 1790 };
  tick(0);
  tick(2000);
  close(panel.state.animationTime, 14);
});
test('old animation configs and missing speed retain 1x behavior', () => {
  const panel = createPanel({ isAnimated: true });
  panel.state.visualizationRuntime!.animation = {
    enabledParam: 'isAnimated',
    timeParam: 'animationTime',
    frameModulo: 1800,
  };
  tick(0);
  tick(100);
  close(panel.state.animationTime, 6);
});
test('unmount cancels the animation and removes visibility listener', () => {
  const panel = createPanel();
  tick(0);
  tick(100);
  panel.componentWillUnmount();
  assert.equal(frames.size, 0);
  assert.equal(listeners.get('visibilitychange')?.size ?? 0, 0);
  tick(1000);
  visibility(false);
  close(panel.state.animationTime, 6);
  assert.equal(frames.size, 0);
});
test('animation-only refresh keeps the rendered scene ready without loading flicker', () => {
  const panel = createPanel();
  const shell = visualizationRegistry.resolveVisualizationShell(visualizationCatalog, 'animated', {
    params: panel.props.visualizationParams,
  });
  Object.assign(panel, {
    updateVisualization: (Panel.prototype as unknown as { updateVisualization: unknown }).updateVisualization,
  });
  panel.state = {
    ...panel.state,
    runtimePhase: 'ready',
    visualizationRuntimeSourceKey: JSON.stringify([config.id, shell.dataset.id, shell.dataset.revision]),
  };
  const previous = panel.state;
  panel.state = { ...previous, animationTime: 6 };
  panel.componentDidUpdate(panel.props, previous);
  assert.equal(panel.state.runtimePhase, 'ready', 'normal animation keeps scene selectable and loading status hidden');
  assert.equal(pendingRuntimeResolutions.length, 0, 'animation only updates synchronous layer props');
  changeParams(panel, { trailLength: 120 });
  assert.equal(panel.state.runtimePhase, 'refreshing', 'actual settings changes retain normal refresh feedback');
  panel.componentWillUnmount();
});
test('timeline samples camera and path together without replacing free-animation settings', () => {
  const panel = createPanel({ isAnimated: false, animationSpeed: 4 });
  const row = {
    path: [
      [-74, 40.7],
      [-73.9, 40.8],
    ],
    timestamps: [1000, 2000],
  };
  const binding = {
    version: 1 as const,
    visualizationId: 'animated',
    datasetId: 'cab-trips',
    layerId: 'trips',
    dataRevision: '1',
    pathDigest: normalizeTimedPath(row.path, row.timestamps)!.digest,
    timeRange: [1000, 2000] as [number, number],
  };
  panel.state = {
    ...panel.state,
    animationTime: 123,
    visualizationRuntime: {
      ...panel.state.visualizationRuntime!,
      dataset: { id: 'cab-trips' },
      resolvedLayers: [{ data: [row], descriptor: { layerId: 'trips', dataRevision: '1' } }],
    } as unknown as ResolvedVisualizationRuntime,
  };
  const camera = {
    name: 'tracking',
    animationBinding: binding,
    duration: 1000,
    stay: 0,
    initViewState: panel.state.viewState,
    finalViewState: { ...panel.state.viewState, longitude: -73.9 },
  };
  const segments = [{ camera, start: 0, duration: 1000, stay: 0, end: 1000 }] as unknown as PlaybackSegment[];
  panel.handlePlaybackRequest({ id: 1, mode: 'preview', startTimeMs: 500, segments });
  assert.equal(panel.state.sceneTime?.time, 1500);
  const saved = panel.capturePresentation();
  panel.handlePlaybackRequest({ id: 8, mode: 'preview', startTimeMs: 800, segments });
  panel.restorePresentation(saved);
  assert.equal(panel.state.sceneTime?.time, 1500, 'canceling a preview restores its data time too');
  assert.equal(panel.state.animationTime, 123, 'free phase is saved separately');
  assert.equal(frames.size, 0, 'no free animation loop while controlled');
  panel.handlePlaybackRequest({ id: 2, mode: 'stop', startTimeMs: 900, segments });
  assert.equal(panel.state.sceneTime?.time, 1900, 'seeking updates even when free Animated is off');
  panel.handlePlaybackRequest({ id: 3, mode: 'stop', startTimeMs: 0, segments: [] });
  assert.equal(JSON.stringify(panel.state.sceneTime), undefined);
  assert.equal(panel.state.animationTime, 123);
  assert.equal(panel.props.visualizationParams.animationSpeed, 4);
  panel.handlePlaybackRequest({ id: 4, mode: 'play', startTimeMs: 0, segments });
  assert.equal(frames.size, 1, 'only the story driver schedules frames');
  tick(100);
  assert.equal(panel.state.sceneTime?.time, 1100);
  visibility(true);
  assert.equal(frames.size, 0);
  tick(10000);
  visibility(false);
  tick(10100);
  assert.equal(panel.state.sceneTime?.time, 1200, 'background return does not catch up');
  const drawingStart = panel.state;
  panel.handleMapSelectionButtonClick();
  panel.componentDidUpdate(panel.props, drawingStart);
  assert.equal(frames.size, 0);
  tick(20000);
  const drawingEnd = panel.state;
  panel.handleCancelSelectionButtonClick();
  panel.componentDidUpdate(panel.props, drawingEnd);
  tick(20100);
  assert.equal(panel.state.sceneTime?.time, 1300, 'drawing return resumes the same data time');
  panel.componentWillUnmount();
  assert.equal(frames.size, 0, 'unmount cancels the story driver too');
});
async function testResolvedParameterWriteback() {
  const panel = createPanel();
  const shell = visualizationRegistry.resolveVisualizationShell(visualizationCatalog, 'animated', {
    params: panel.props.visualizationParams,
  });
  const completions: Array<() => void> = [];
  const writes: VisualizationParameterValues[] = [];
  const setState = panel.setState;
  panel.setState = (patch: Parameters<typeof panel.setState>[0], callback?: () => void) => {
    setState(patch);
    if (callback) completions.push(callback);
  };
  Object.assign(panel, {
    updateVisualization: (Panel.prototype as unknown as { updateVisualization: unknown }).updateVisualization,
    props: {
      ...panel.props,
      onVisualizationParamsResolved: (_id: string, params: VisualizationParameterValues) => writes.push(params),
    },
  });
  panel.state = {
    ...panel.state,
    runtimePhase: 'ready',
    visualizationRuntimeSourceKey: JSON.stringify([config.id, shell.dataset.id, shell.dataset.revision]),
  };
  changeParams(panel, { trailLength: 150 });
  const requestedParams = panel.props.visualizationParams;
  pendingRuntimeResolutions.shift()!({
    ...panel.state.visualizationRuntime!,
    effectiveParams: requestedParams,
    resolvedLayers: [],
  });
  await Promise.resolve();
  assert.equal(completions.length, 1, 'runtime commit callback is waiting for React');
  changeParams(panel, { isAnimated: false, animationSpeed: 2 });
  completions.shift()!();
  assert.equal(writes.length, 0, 'old animation frames must not echo parameters over newer user choices');
  assert.equal(panel.props.visualizationParams.animationSpeed, 2);
  assert.equal(panel.props.visualizationParams.isAnimated, false);
  assert.equal(frames.size, 0);

  // A real resolver adjustment still flows back through the existing callback.
  pendingRuntimeResolutions.shift()!({
    ...panel.state.visualizationRuntime!,
    effectiveParams: { ...panel.props.visualizationParams, trailLength: 100 },
    resolvedLayers: [],
  });
  await Promise.resolve();
  completions.shift()!();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].trailLength, 100);
  panel.componentWillUnmount();
  console.log('PASS stale frame writeback preserves new user choices while resolver adjustments still apply');
}
void testResolvedParameterWriteback().then(() => {
  assert.equal(failures, 0, `${failures} animation tests failed`);
});
