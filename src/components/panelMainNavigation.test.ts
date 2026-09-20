import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';
import type PanelMain from './PanelMain';
import type { PanelMainProps } from './PanelMain';
import type { CameraMovement, CameraView } from '../interfaces';
import { derivePlaybackPlan, getViewAtPlaybackTime } from '../story/playback';
import { visualizationCatalog } from '../visualization/catalog';
import { createPointTarget } from '../camera/selection';
import { computeComparisonPaneViews, resolveComparisonNavigationPanes } from './comparisonSplitModel';
import type { ComparisonSplitViewProps } from './ComparisonSplitView';

let clock = 0;
let nextFrame = 0;
const frames = new Map<number, () => void>();
const windowMock = {
  requestAnimationFrame(callback: () => void) {
    frames.set(++nextFrame, callback);
    return nextFrame;
  },
  cancelAnimationFrame(id: number) {
    frames.delete(id);
  },
  clearTimeout,
  matchMedia: () => ({ matches: false }),
};
function advance(time: number) {
  do {
    clock = Math.min(time, clock + 50);
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback());
  } while (clock < time);
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
  runInThisContext(`(function(require,module,exports,window,performance){${output}\n})`)(
    localRequire,
    moduleValue,
    moduleValue.exports,
    windowMock,
    { now: () => clock },
  );
  return moduleValue.exports.default;
}
function elements(node: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as React.ReactNode)];
}
function channels(view: CameraView) {
  return [view.longitude, view.latitude, view.zoom, view.pitch, view.bearing];
}
const view: CameraView = { longitude: -2, latitude: 53.7, zoom: 5.3, pitch: 0, bearing: 0 };
const camera: CameraMovement = {
  name: 'navigation',
  title: 'Navigation',
  category: 'overview',
  initViewState: view,
  finalViewState: { ...view, longitude: 4, zoom: 7 },
  duration: 2000,
  stay: 500,
  isRotating: false,
  interpolationType: 'none',
  interpolationDuration: 0,
  annotation: { delay: 0, duration: 2500, text: 'Story caption' },
};
const original = JSON.stringify(camera);
const segments = derivePlaybackPlan([camera]).segments;
let stopped = 0;
const synced: CameraView[] = [];
const Panel = loadPanel();
const panel = new Panel({
  viewState: view,
  viewportSize: { width: 1000, height: 600 },
  activeVisualizationId: 'scatter',
  visualizationParams: {},
  visualizationCatalog,
  onCanvasViewStateUpdate: (next: CameraView) => synced.push(next),
  onPlaybackStop: () => stopped++,
} as unknown as PanelMainProps);
panel.setState = ((patch: object | ((state: typeof panel.state) => object), callback?: () => void) => {
  panel.state = { ...panel.state, ...(typeof patch === 'function' ? patch(panel.state) : patch) };
  callback?.();
}) as typeof panel.setState;
// Only shell resolution is stubbed; playback and navigation handlers are real.
Object.assign(panel, {
  resolveVisualizationShell: () => ({ dataset: {}, mapStyle: {}, cameraConstraints: {} }),
  getVisualizationSourceKey: () => 'navigation-test',
});
const tree = () => elements(panel.render());
const deck = () => tree().find((node) => node.type === 'DeckGL')!;
const caption = () => tree().find((node) => node.props.id === 'annotation')?.props.children;
const resume = () => {
  const button = tree().find((node) => node.props['aria-label'] === 'Resume camera follow');
  assert(button, 'free view exposes one clearly named recovery action');
  (button.props.onClick as () => void)();
};

panel.handlePlaybackRequest({ id: 1, mode: 'play', startTimeMs: 0, segments });
advance(300);
assert.notEqual(deck().props.controller, false, 'playback accepts gestures without an Edit map unlock');
assert.equal(caption(), 'Story caption');
assert(!tree().some((node) => node.props.children === 'Edit map'), 'obsolete unlock button is gone');
const beforeClick = channels(panel.state.viewState);
(deck().props.onInteractionStateChange as (state: object) => void)({ isDragging: false });
assert.deepEqual(channels(panel.state.viewState), beforeClick, 'click/release alone does not move the camera');
const manual = { ...panel.state.viewState, longitude: -8, zoom: 8 };
panel.handleViewStateChange({ viewState: manual, interactionState: { isDragging: true } });
advance(700);
assert.deepEqual(channels(panel.state.viewState), channels(manual), 'story frames never overwrite a manual view');
assert.equal(panel.state.replayOffsetMs, 700, 'story time continues during exploration');
assert.equal(caption(), 'Story caption', 'takeover preserves the annotation');
assert.equal(stopped, 0, 'navigation does not pause the timeline');
panel.handlePlaybackRequest({ id: 2, mode: 'stop', startTimeMs: 700, segments });
assert.deepEqual(channels(panel.state.viewState), channels(manual), 'pause retains the explored view');
panel.handlePlaybackRequest({ id: 3, mode: 'play', startTimeMs: 700, segments });
advance(900);
assert.deepEqual(channels(panel.state.viewState), channels(manual), 'resume playback retains free view');
resume();
assert.deepEqual(channels(panel.state.viewState), channels(manual), 'return begins at the exact manual view');
advance(1050);
const interrupted = { ...panel.state.viewState, zoom: 9 };
panel.handleViewStateChange({ viewState: interrupted, interactionState: { isZooming: true } });
advance(1200);
assert.deepEqual(channels(panel.state.viewState), channels(interrupted), 'wheel interrupts the return immediately');
resume();
advance(2400);
const expected = getViewAtPlaybackTime(segments, 2400)!;
assert.deepEqual(channels(panel.state.viewState), channels(expected), 'return targets the current story time');
panel.handleViewStateChange({ viewState: manual, interactionState: { isRotating: true } });
advance(2600);
panel.handlePlaybackRequest({ id: 4, mode: 'stop', startTimeMs: 2500, segments });
assert.deepEqual(channels(panel.state.viewState), channels(manual), 'completion keeps manual ownership');
resume();
advance(4000);
assert.deepEqual(
  channels(panel.state.viewState),
  channels(getViewAtPlaybackTime(segments, 2500)!),
  'paused return reaches the final story view',
);
panel.handleViewStateChange({ viewState: manual, interactionState: { isDragging: true } });
panel.handlePlaybackRequest({ id: 5, mode: 'preview', startTimeMs: 500, segments });
assert.deepEqual(
  channels(panel.state.viewState),
  channels(getViewAtPlaybackTime(segments, 500)!),
  'explicit seek shows the requested story position',
);
assert.equal(JSON.stringify(camera), original, 'navigation never changes saved camera data');
assert(synced.length > 0, 'manual view remains available for explicit authoring actions');
panel.handleViewStateChange({ viewState: manual, interactionState: { isDragging: true } });
resume();
advance(4100);
const presentation = panel.capturePresentation();
panel.pausePresentation();
advance(5100);
panel.restorePresentation(presentation);
assert.deepEqual(
  channels(panel.state.viewState),
  channels(presentation.viewState),
  'canceling authoring restores the visible navigation frame',
);
advance(5101);
assert(
  Math.abs(panel.state.viewState.longitude - presentation.viewState.longitude) < 0.1,
  'time spent in a draft does not fast-forward the restored return',
);
const previousProps = panel.props;
const previousState = panel.state;
Object.assign(panel, {
  props: { ...panel.props, viewportSize: { width: 800, height: 600 }, playbackPlanRevision: 1 },
  markShellRender() {},
  updateVisualization() {},
});
panel.componentDidUpdate(previousProps, previousState);
advance(7000);
assert.equal(panel.state.cameraNavigationMode, 'follow', 'resizing cannot leave recovery stuck in Returning');
panel.clearPlaybackTimers();
// Exercise the real parent presentation boundary with independently explored split panes.
const splitCamera: CameraMovement = {
  ...camera,
  presentation: 'split',
  comparisonTargetSnapshots: [createPointTarget([-2, 53]), createPointTarget([2, 54])],
};
const splitSegments = derivePlaybackPlan([splitCamera]).segments;
panel.setState({
  visualizationRuntime: { dataset: {} } as typeof panel.state.visualizationRuntime,
  visualizationRuntimeSourceKey: 'navigation-test',
});
const split = () =>
  tree().find((node) => node.type === 'ComparisonSplitView')!.props as unknown as ComparisonSplitViewProps;
panel.handlePlaybackRequest({ id: 6, mode: 'play', startTimeMs: 0, segments: splitSegments });
advance(7001);
panel.handleViewStateChange({
  viewState: { ...manual, pitch: 65, bearing: 90 },
  interactionState: { isRotating: true },
});
assert.equal(
  split().baseView.pitch,
  view.pitch,
  'split framing uses the authored story camera after main-map rotation',
);
const initialPanes = computeComparisonPaneViews({
  targets: split().targets!,
  baseView: split().baseView,
  viewportSize: split().viewportSize!,
});
const manualPanes = initialPanes.map((pane, index) => ({
  ...pane,
  viewState: { ...pane.viewState, longitude: pane.viewState.longitude + index + 1, zoom: 9, pitch: 60, bearing: 45 },
})) as typeof initialPanes;
const snapshot = {
  key: split().presentationKey!,
  baseView: split().baseView,
  initialPanes,
  manualPanes,
  viewportSize: split().viewportSize!,
};
const reportSnapshot = split().onNavigationSnapshotChange;
assert(reportSnapshot, 'the parent receives actual split camera snapshots');
reportSnapshot(snapshot);
const splitPresentation = panel.capturePresentation();
panel.handlePlaybackRequest({ id: 7, mode: 'preview', startTimeMs: 0, segments });
assert.equal(split().navigationSnapshot, undefined, 'explicit seek clears the previous split exploration');
panel.restorePresentation(splitPresentation);
assert.deepEqual(
  split().navigationSnapshot?.manualPanes,
  manualPanes,
  'Cancel restores both independently explored pane views',
);
assert.deepEqual(
  split().navigationSnapshot?.initialPanes,
  initialPanes,
  'Cancel preserves the authored recovery framing',
);
resume();
advance(7150);
const progress = panel.state.cameraReturnProgress;
const visiblePanes = resolveComparisonNavigationPanes(initialPanes, manualPanes, 'returning', progress);
const returningSplit = panel.capturePresentation();
panel.pausePresentation();
advance(8150);
panel.handlePlaybackRequest({ id: 8, mode: 'preview', startTimeMs: 0, segments });
panel.restorePresentation(returningSplit);
assert.deepEqual(
  split().navigationSnapshot?.manualPanes,
  visiblePanes,
  'restoring an interrupted return starts from the visible split frame',
);
assert.equal(split().navigation?.returnProgress, 0, 'the restored split return starts at zero elapsed progress');
const resizeProps = panel.props;
const resizeState = panel.state;
Object.assign(panel, { props: { ...panel.props, viewportSize: { width: 600, height: 600 }, playbackPlanRevision: 2 } });
panel.componentDidUpdate(resizeProps, resizeState);
assert(panel.state.playbackSplitPresentation, 'a viewport-only plan revision preserves the visible split presentation');
assert.deepEqual(
  split().navigationSnapshot?.manualPanes,
  visiblePanes,
  'a viewport-only plan revision preserves manual pane cameras',
);
panel.restorePresentation({ ...returningSplit, cameraReturnRemainingMs: 0 });
assert.equal(
  panel.state.cameraReturnProgress,
  1,
  'an expired captured return has finite completed progress immediately',
);
panel.restorePresentation(splitPresentation);
const rebuiltSegments = derivePlaybackPlan([JSON.parse(JSON.stringify(splitCamera)) as CameraMovement]).segments;
panel.handlePlaybackRequest({ id: 9, mode: 'play', startTimeMs: 1, segments: rebuiltSegments });
advance(8200);
assert.equal(
  panel.state.cameraNavigationMode,
  'free',
  'resuming the same story after viewport recompilation retains manual ownership',
);
assert.deepEqual(
  split().navigationSnapshot?.manualPanes,
  manualPanes,
  'resuming a rebuilt equivalent plan retains split exploration',
);
const authoredProps = panel.props;
Object.assign(panel, { props: { ...panel.props, comparisonPreview: { targets: split().targets! } } });
assert.equal(split().navigation, undefined, 'authoring comparison keeps local camera interaction');
assert.equal(split().onNavigationStart, undefined, 'authoring comparison cannot take global story-camera ownership');
assert.equal(split().onNavigationSnapshotChange, undefined, 'authoring comparison cannot overwrite playback snapshots');
assert.deepEqual(
  channels(split().baseView),
  channels(panel.state.viewState),
  'authoring comparison starts at the displayed view',
);
Object.assign(panel, { props: authoredProps });
const changedSegments = derivePlaybackPlan([
  { ...splitCamera, finalViewState: { ...splitCamera.finalViewState, pitch: 40 } },
]).segments;
panel.handlePlaybackRequest({ id: 10, mode: 'play', startTimeMs: 1, segments: changedSegments });
advance(8201);
assert.equal(
  panel.state.cameraNavigationMode,
  'follow',
  'a genuinely changed story starts with authored camera ownership',
);
assert.equal(split().navigationSnapshot, undefined, 'a changed story clears the old split exploration');
const stopsBeforeDrawing = stopped;
panel.handleMapSelectionButtonClick();
assert.equal(stopped, stopsBeforeDrawing + 1, 'drawing pauses playback so the map stays fixed');
assert.equal(panel.state.replayCamera, undefined);
assert.equal(panel.state.playbackSplitPresentation, undefined);
assert.equal(deck().props._pickable, false, 'drawing disables expensive scene picking');
assert.equal(deck().props.getTooltip, undefined, 'data tooltips cannot obscure the drawing');
assert.equal(deck().props.controller, false, 'pointer gestures cannot move the map beneath a draft');
panel.handleMapDrawingKeyDown({ code: 'Escape' } as KeyboardEvent);
assert.equal(panel.state.mapDrawing, false, 'Escape cancels the draft');
assert.equal(deck().props._pickable, true, 'canceling restores normal data picking');
assert.notEqual(deck().props.controller, false, 'canceling restores map navigation');
panel.pausePresentation();
console.log('Canvas takeover, story continuity, pause/resume, interrupted return and seek passed.');

// A saved home is independent of automatic current-view updates and authored cameras.
const homes: Record<string, CameraView> = {};
let homeChanges = 0;
Object.assign(panel, {
  props: {
    ...panel.props,
    homeViews: homes,
    onHomeViewChange: (key: string, next?: CameraView) => {
      homeChanges++;
      if (next) homes[key] = next;
      else delete homes[key];
    },
    onComparisonPreviewExit: () => {},
  },
  resolveVisualizationShell: () => ({
    dataset: {},
    mapStyle: {},
    initialViewState: view,
    cameraConstraints: { minZoom: 0, maxZoom: 20, minPitch: 0, maxPitch: 60 },
  }),
});
panel.setState({
  visualizationRuntime: { dataset: {}, initialViewState: view } as typeof panel.state.visualizationRuntime,
});
panel.handlePlaybackRequest({ id: 11, mode: 'play', startTimeMs: 0, segments });
panel.handleViewStateChange({ viewState: { ...manual, pitch: 75, zoom: 22 }, interactionState: { isDragging: true } });
const savesBeforeStop = stopped;
const saveHome = tree().find((node) => node.props['aria-label'] === 'Save as home view');
assert(saveHome, 'camera button explicitly saves a home view');
assert(!saveHome.props.disabled, 'single map can save a home during playback');
(saveHome.props.onClick as () => void)();
assert.equal(stopped, savesBeforeStop, 'saving home does not pause the story');
assert.equal(homeChanges, 1);
const saved = { ...homes['navigation-test'] };
assert.deepEqual(channels(saved), channels(panel.state.viewState));
assert.notEqual(homes['navigation-test'], panel.state.viewState, 'home snapshots are detached');
panel.handleViewStateChange({ viewState: view, interactionState: { isDragging: true } });
panel.handleCameraResetButtonClick();
assert.deepEqual(
  channels(panel.state.viewState),
  channels(saved),
  'return goes home, not to last automatically synced view',
);
assert.equal(stopped, savesBeforeStop + 1);
assert.equal(panel.state.replayCamera, undefined);
assert.equal(panel.state.playbackSplitPresentation, undefined);
assert.equal((deck().props.viewState as CameraView).maxPitch, 75, 'a playback home survives normal-map pitch limits');
assert.equal((deck().props.viewState as CameraView).maxZoom, 22);
advance(9500);
assert.deepEqual(channels(panel.state.viewState), channels(saved), 'late playback frames cannot replace home');
homes['another-scene'] = saved;
assert.deepEqual(homes['navigation-test'], saved, 'returning home preserves the saved view');
delete homes['navigation-test'];
panel.handleCameraResetButtonClick();
assert.deepEqual(homes['another-scene'], saved, 'other scenes retain their home');
assert.deepEqual(channels(panel.state.viewState), channels(view));
assert.equal(JSON.stringify(camera), original, 'home actions never rewrite shots');
panel.handlePlaybackRequest({ id: 12, mode: 'preview', startTimeMs: 0, segments: splitSegments });
assert(
  tree().find((node) => node.props['aria-label'] === 'Save as home view')?.props.disabled,
  'split camera cannot save a hidden main view',
);
panel.pausePresentation();
console.log('Save home, return home, initial-view fallback, split guard and authored-camera isolation passed.');
