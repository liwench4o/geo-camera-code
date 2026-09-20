import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import React from 'react';
import ts from 'typescript';
import type PanelMain from './PanelMain';
import type { PanelMainProps } from './PanelMain';
import type { CameraMovement } from '../interfaces';
import { derivePlaybackPlan } from '../story/playback';
import { createPointTarget } from '../camera/selection';

let frame: (() => void) | undefined;
let clock = 0;
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
    if (
      [
        '@ant-design/icons',
        'react-map-gl/maplibre',
        '@deck.gl/react',
        './ComparisonSplitView',
        './ViewStateEditorModal',
      ].includes(id)
    ) {
      return new Proxy({}, { get: () => 'div' });
    }
    if (id === 'antd')
      return {
        Typography: { Paragraph: 'p', Title: 'h4', Text: 'span' },
        Card: 'div',
        Alert: 'div',
        Button: 'button',
        Space: 'div',
        Tooltip: 'div',
        message: { info() {}, warning() {}, error() {} },
      };
    return id.startsWith('.') ? require(path.resolve('.cache/camera-tests/src/components', id)) : require(id);
  };
  const moduleValue = { exports: {} as { default: typeof PanelMain } };
  const execute = runInThisContext(`(function(require,module,exports,window,performance){${output}\n})`);
  execute(
    localRequire,
    moduleValue,
    moduleValue.exports,
    {
      requestAnimationFrame(callback: () => void) {
        frame = callback;
        return 1;
      },
      cancelAnimationFrame() {
        frame = undefined;
      },
      clearTimeout,
    },
    { now: () => clock },
  );
  return moduleValue.exports.default;
}
function elements(node: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  if (typeof node.type === 'function' && !node.type.prototype?.render) {
    return elements((node.type as (props: Record<string, unknown>) => React.ReactNode)(node.props));
  }
  return [node, ...elements(node.props.children as React.ReactNode)];
}
const view = { longitude: -2, latitude: 53.7, zoom: 5.3, pitch: 0, bearing: 0 };
const text = 'Birmingham 中文\n  Second line & <literal text>  ';
const camera: CameraMovement = {
  name: 'overview-static',
  title: 'Text timing',
  category: 'overview',
  initViewState: view,
  finalViewState: view,
  duration: 1000,
  stay: 1000,
  isRotating: false,
  interpolationType: 'none',
  interpolationDuration: 0,
  annotation: { delay: 500, duration: 1000, text },
};
const Panel = loadPanel();
const panel = new Panel({
  viewState: view,
  viewportSize: { width: 1000, height: 600 },
  visualizationParams: {},
  visualizationCatalog: { visualizations: [], datasets: [], version: 1 },
} as unknown as PanelMainProps);
panel.setState = ((patch: object | ((state: typeof panel.state) => object)) => {
  panel.state = { ...panel.state, ...(typeof patch === 'function' ? patch(panel.state) : patch) };
}) as typeof panel.setState;
const segments = derivePlaybackPlan([camera]).segments;
const caption = () => elements(panel.render()).find((node) => node.props.id === 'annotation');
for (const mode of ['preview', 'stop'] as const) {
  for (const [time, visible] of [
    [0, false],
    [499, false],
    [500, true],
    [1200, true],
    [1499, true],
    [1500, false],
    [2000, false],
  ] as const) {
    panel.handlePlaybackRequest({ id: 1, mode, startTimeMs: time, segments });
    assert.equal(
      caption()?.props.children,
      visible ? text : undefined,
      `${mode} at ${time} obeys the annotation window`,
    );
  }
}
clock = 0;
panel.handlePlaybackRequest({ id: 2, mode: 'play', startTimeMs: 0, segments });
for (const [time, visible] of [
  [0, false],
  [700, true],
  [1600, false],
] as const) {
  do {
    clock = Math.min(time, clock + 50);
    assert(frame, 'play schedules a frame');
    const pending = frame;
    frame = undefined;
    pending();
  } while (clock < time);
  assert.equal(caption()?.props.children, visible ? text : undefined, `play at ${time} shares seek timing`);
}
panel.handlePlaybackRequest({ id: 3, mode: 'stop', startTimeMs: 800, segments });
const saved = panel.capturePresentation();
panel.handlePlaybackRequest({ id: 4, mode: 'preview', startTimeMs: 1600, segments });
panel.restorePresentation(saved);
assert.equal(caption()?.props.children, text, 'canceling a preview restores the caption time');
assert.equal(
  (caption()?.props.style as React.CSSProperties)?.whiteSpace,
  'pre-wrap',
  'multiline text keeps line breaks',
);
const gap = derivePlaybackPlan([
  camera,
  { ...camera, startDelay: 1000, initViewState: { ...view, longitude: 0 } },
]).segments;
panel.handlePlaybackRequest({ id: 5, mode: 'preview', startTimeMs: 2500, segments: gap });
assert.equal(caption(), undefined, 'generated transition does not borrow another shot’s text');

// The object strip belongs only to object selection, never shot presentation.
const first = { ...createPointTarget([1.00011, 51.00011]), label: 'First object' };
const second = { ...createPointTarget([1.00021, 51.00021]), label: 'Second object' };
const selectionProgress: { timeMs: number; status: string }[] = [];
const selectionPanel = new Panel({
  ...panel.props,
  selectionTargets: [first, second],
  objectSelectionVisible: true,
  onPlaybackProgress: (timeMs: number, status: string) => selectionProgress.push({ timeMs, status }),
});
selectionPanel.state = { ...selectionPanel.state, replayCamera: undefined };
Object.assign(selectionPanel, {
  resolveVisualizationShell: () => ({ dataset: {}, mapStyle: {}, cameraConstraints: {} }),
  getVisualizationSourceKey: () => 'selection-test',
});
const selectionNodes = elements(selectionPanel.render());
const strip = selectionNodes.find((node) => node.props.className === 'map-selection-bar');
assert(strip, 'current objects are visible in the map selection strip');
assert.equal(strip.props['aria-label'], 'Selected objects');
const names = selectionNodes.filter((node) => node.props.className === 'map-selection-name');
assert.deepEqual(
  names.map((node) => node.props.children),
  ['First object', 'Second object'],
);
assert(!selectionNodes.some((node) => node.props.children === 'Latest'), 'no latest/status feature badge');
const renderedLayers = selectionNodes.flatMap((node) => (node.props.layers as { id: string }[]) ?? []);
assert(
  selectionNodes.some((node) => Array.isArray(node.props.layers)),
  'the actual map layer list is inspected',
);
assert(!renderedLayers.some((layer) => layer.id.startsWith('selection-')), 'selection adds no map decoration layers');

Object.assign(selectionPanel, { props: { ...selectionPanel.props, selectionTargets: [first] } });
const singleNodes = elements(selectionPanel.render());
assert.equal(singleNodes.filter((node) => node.props.className === 'map-selection-name').length, 1);
assert(
  !singleNodes.some((node) => node.props.className === 'map-selection-empty'),
  'one object needs no B placeholder',
);
assert(!singleNodes.some((node) => node.props.children === 'B · Select another object'));
Object.assign(selectionPanel, { props: { ...selectionPanel.props, objectSelectionVisible: false } });
assert(
  !elements(selectionPanel.render()).some((node) => node.props.className === 'map-selection-bar'),
  'App can hide the strip for configuration, saved shots and preview sessions',
);
Object.assign(selectionPanel, {
  props: { ...selectionPanel.props, objectSelectionVisible: true, selectionTargets: [first, second] },
});

selectionPanel.state = {
  ...selectionPanel.state,
  replayCamera: { ...camera, comparisonTargetSnapshots: [first, second], targetSnapshot: undefined },
  replayOffsetMs: 800,
};
const playbackNodes = elements(selectionPanel.render());
assert(
  playbackNodes.some((node) => node.props.id === 'annotation'),
  'caption remains visible during playback',
);
assert(
  !playbackNodes.some((node) => node.props.className === 'map-selection-bar'),
  'saved playback targets never create an object strip',
);
assert(
  !playbackNodes.some((node) => node.props['aria-label'] === 'Clear selected objects'),
  'selection actions are absent during playback',
);
const stack = playbackNodes.find((node) => node.props.className === 'map-bottom-overlays');
assert(stack, 'annotation and objects share a non-overlapping bottom stack');
const stackNodes = elements(stack.props.children as React.ReactNode);
assert(stackNodes.some((node) => node.props.id === 'annotation'));
assert(!stackNodes.some((node) => node.props.className === 'map-selection-bar'));
assert.equal(
  stackNodes.filter((node) => node.props.id === 'annotation').length,
  1,
  'annotation is the sole bottom overlay',
);
selectionPanel.setState = ((patch: object | ((state: typeof selectionPanel.state) => object)) => {
  selectionPanel.state = {
    ...selectionPanel.state,
    ...(typeof patch === 'function' ? patch(selectionPanel.state) : patch),
  };
}) as typeof selectionPanel.setState;
for (const mode of ['play', 'stop', 'preview'] as const) {
  clock = 0;
  selectionPanel.handlePlaybackRequest({ id: 20, mode, startTimeMs: 800, segments });
  assert(
    !elements(selectionPanel.render()).some((node) => node.props.className === 'map-selection-bar'),
    `${mode} hides current selections`,
  );
}
clock = 0;
selectionProgress.length = 0;
selectionPanel.handlePlaybackRequest({ id: 21, mode: 'play', startTimeMs: 0, segments });
const finalSegment = segments[segments.length - 1];
for (let elapsed = 0; elapsed < finalSegment.end; elapsed += 50) {
  clock += 50;
  assert(frame, 'playback keeps scheduling frames until the final shot ends');
  const pending = frame;
  frame = undefined;
  pending();
}
assert.deepEqual(selectionProgress[selectionProgress.length - 1], { timeMs: finalSegment.end, status: 'complete' });
assert.equal(frame, undefined, 'completed playback leaves no frame scheduled');
assert.equal(selectionPanel.state.replayCamera, finalSegment.camera, 'completion retains the final shot');
assert.equal(selectionPanel.state.replayOffsetMs, finalSegment.end - finalSegment.start, 'final shot reaches its end');
assert(
  !elements(selectionPanel.render()).some((node) => node.props.className === 'map-selection-bar'),
  'completed playback does not revive old selections',
);
selectionPanel.leavePlaybackForSelection();
assert(
  elements(selectionPanel.render()).some((node) => node.props.className === 'map-selection-bar'),
  'returning to object selection restores the strip',
);
for (const annotation of [
  { delay: 0, duration: 0, text },
  { delay: 1900, duration: 5000, text },
]) {
  const clipped = derivePlaybackPlan([{ ...camera, annotation }]).segments;
  panel.handlePlaybackRequest({ id: 6, mode: 'preview', startTimeMs: 2000, segments: clipped });
  assert.equal(caption(), undefined, 'zero duration and overflowing windows cannot outlive the shot');
}
panel.handlePlaybackRequest({ id: 7, mode: 'stop', startTimeMs: 800, segments });
const oldProps = panel.props;
const oldState = panel.state;
Object.assign(panel, { props: { ...panel.props, playbackPlanRevision: 1 } });
panel.componentDidUpdate(oldProps, oldState);
assert.equal(caption(), undefined, 'import or edit invalidates text from the previous playback plan');
panel.handlePlaybackRequest({ id: 8, mode: 'stop', startTimeMs: 800, segments });
const beforeResizeProps = panel.props;
const beforeResizeState = panel.state;
Object.assign(panel, {
  props: { ...panel.props, playbackPlanRevision: 2, viewportSize: { width: 800, height: 600 } },
  updateVisualization() {},
});
panel.componentDidUpdate(beforeResizeProps, beforeResizeState);
assert.equal(caption()?.props.children, text, 'resizing preserves the paused caption and saved projection');
