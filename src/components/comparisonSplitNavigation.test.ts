import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type ComparisonSplitView from './ComparisonSplitView';
import type { ComparisonSplitViewProps } from './ComparisonSplitView';
import type { CameraView } from '../interfaces';
import { createPointTarget, createRegionTarget } from '../camera/selection';
import { computeComparisonPaneViews } from './comparisonSplitModel';

type PaneDeck = {
  viewState: CameraView;
  onViewStateChange: (event: {
    viewState: CameraView;
    interactionState: { isDragging?: boolean; inTransition?: boolean };
  }) => void;
};
let decks: PaneDeck[] = [];
// Preserve the component's state slots across server renders for resize regressions.
// The normal cases below still run with React's own hooks.
let mountedHookState: unknown[] | undefined;
let mountedHookIndex = 0;
const source = ts.transpileModule(readFileSync('src/components/ComparisonSplitView.tsx', 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText;
const localRequire = (id: string): unknown => {
  if (id.endsWith('.css')) return {};
  if (id === 'react')
    return {
      ...React,
      // Readiness is exercised in the real browser regression, not server markup.
      useLayoutEffect: () => {},
      useState: (initial: unknown) => {
        // eslint-disable-next-line react-hooks/rules-of-hooks -- Test adapter selects one hook implementation per render.
        if (!mountedHookState) return React.useState(initial);
        const state = mountedHookState;
        const index = mountedHookIndex++;
        if (index === state.length) state.push(typeof initial === 'function' ? initial() : initial);
        return [
          state[index],
          (next: unknown) => {
            state[index] = typeof next === 'function' ? next(state[index]) : next;
          },
        ];
      },
    };
  if (id === '@deck.gl/react')
    return {
      DeckGL: (props: PaneDeck) => {
        decks.push(props);
        return null;
      },
    };
  if (['antd', '@ant-design/icons', 'react-map-gl/maplibre'].includes(id)) return new Proxy({}, { get: () => 'div' });
  return id.startsWith('.') ? require(path.resolve(__dirname, id)) : require(id);
};
const loaded = { exports: {} as { default: typeof ComparisonSplitView } };
runInThisContext(`(function(require,module,exports){${source}\n})`)(localRequire, loaded, loaded.exports);
const render = (props: ComparisonSplitViewProps) => {
  decks = [];
  mountedHookIndex = 0;
  renderToStaticMarkup(React.createElement(loaded.exports.default, props));
  assert.equal(decks.length, 2);
  return decks;
};
const baseView: CameraView = { longitude: 0, latitude: 51, zoom: 6, pitch: 20, bearing: 15 };
const targets: NonNullable<ComparisonSplitViewProps['targets']> = [
  createPointTarget([-1, 51]),
  createPointTarget([2, 52]),
];
const viewportSize = { width: 1000, height: 600 };
const initialPanes = computeComparisonPaneViews({ targets, baseView, viewportSize });
const manualPanes = initialPanes.map((pane, index) => ({
  ...pane,
  viewState: { ...pane.viewState, longitude: pane.viewState.longitude + index + 3, zoom: 10, pitch: 50, bearing: 75 },
})) as typeof initialPanes;
const snapshot = { key: 'playback-split', baseView, initialPanes, manualPanes, viewportSize };
const reported: (typeof snapshot)[] = [];
const props: ComparisonSplitViewProps = {
  runtime: {
    createLayers: () => [],
    effects: [],
    cameraConstraints: {},
  } as unknown as ComparisonSplitViewProps['runtime'],
  presentationKey: snapshot.key,
  targets,
  // Restoring after another candidate must use the captured original framing, not this unrelated view.
  baseView: { ...baseView, pitch: 65, bearing: 120 },
  viewportSize,
  navigation: { mode: 'free', returnProgress: 0 },
  navigationSnapshot: snapshot,
  onNavigationSnapshotChange: (next) => reported.push(next),
  interactive: true,
};
const frameTimes: Array<number | undefined> = [];
render({
  ...props,
  animationTime: 1900,
  runtime: {
    ...props.runtime,
    createLayers: (options) => {
      frameTimes.push(options?.animationTime);
      return [];
    },
  },
});
assert.deepEqual(frameTimes, [1900, 1900], 'both split panes receive the exact same source time');
assert.deepEqual(
  render(props).map((pane) => pane.viewState),
  manualPanes.map((pane) => pane.viewState),
  'remounted panes restore their independently explored cameras',
);
assert.deepEqual(
  render({ ...props, navigation: { mode: 'follow', returnProgress: 1 } }).map((pane) => pane.viewState),
  initialPanes.map((pane) => pane.viewState),
  'recovery restores original authored framing after remount',
);
const resized = { width: 600, height: 600 };
assert.deepEqual(
  render({ ...props, viewportSize: resized }).map((pane) => pane.viewState),
  manualPanes.map((pane) => pane.viewState),
  'resize does not erase manual split navigation',
);
const reframed = computeComparisonPaneViews({ targets, baseView, viewportSize: resized });
assert.deepEqual(
  render({ ...props, viewportSize: resized, navigation: { mode: 'follow', returnProgress: 1 } }).map(
    (pane) => pane.viewState,
  ),
  reframed.map((pane) => pane.viewState),
  'resized recovery uses authored framing fitted to the current viewport',
);
const displayed = render(props);
displayed[0].onViewStateChange({
  viewState: { ...displayed[0].viewState, longitude: -8, zoom: 8 },
  interactionState: { isDragging: true },
});
assert.equal(
  reported[reported.length - 1]?.manualPanes[0].viewState.longitude,
  -8,
  'real pane gestures publish the changed view to the parent snapshot',
);
assert.equal(
  reported[reported.length - 1]?.manualPanes[1].viewState.zoom,
  8,
  'snapshot includes the synchronized companion pane',
);
assert.equal(
  reported[reported.length - 1]?.manualPanes[1].viewState.longitude,
  manualPanes[1].viewState.longitude,
  'companion pane retains its independent center',
);
const different = render({ ...props, presentationKey: 'playback-other' });
assert.notEqual(
  different[0].viewState.longitude,
  manualPanes[0].viewState.longitude,
  'a different story segment never inherits stale manual panes',
);

const authoringTargets: NonNullable<ComparisonSplitViewProps['targets']> = [
  createRegionTarget([
    [-4, 50],
    [-1, 50],
    [-1, 53],
    [-4, 53],
  ]),
  createRegionTarget([
    [1, 51],
    [4, 51],
    [4, 54],
    [1, 54],
  ]),
];
const authoring: ComparisonSplitViewProps = {
  ...props,
  presentationKey: 'authoring',
  targets: authoringTargets,
  baseView,
  viewportSize: { width: 1200, height: 600 },
  navigation: undefined,
  navigationSnapshot: undefined,
  onNavigationSnapshotChange: undefined,
};
mountedHookState = [];
const wideAuthoringDecks = render(authoring);
const wideAuthoring = wideAuthoringDecks.map((pane) => pane.viewState);
wideAuthoringDecks[0].onViewStateChange({
  viewState: wideAuthoring[0],
  interactionState: { inTransition: true },
});
const narrowAuthoring = { ...authoring, viewportSize: { width: 400, height: 600 } };
const fittedAuthoring = computeComparisonPaneViews({
  targets: authoringTargets,
  baseView,
  viewportSize: narrowAuthoring.viewportSize,
}).map((pane) => pane.viewState);
assert.notEqual(wideAuthoring[0].zoom, fittedAuthoring[0].zoom, 'fixture requires refitting after resize');
const untouched = render(narrowAuthoring);
assert.deepEqual(
  untouched.map((pane) => pane.viewState),
  fittedAuthoring,
  'untouched authoring panes refit to a resized viewport',
);
untouched[0].onViewStateChange({
  viewState: { ...untouched[0].viewState, longitude: -8, zoom: 8 },
  interactionState: { isDragging: true },
});
const exploredAuthoring = render(narrowAuthoring).map((pane) => pane.viewState);
assert.equal(exploredAuthoring[0].longitude, -8, 'authoring gesture updates the mounted local state');
assert.deepEqual(
  render(authoring).map((pane) => pane.viewState),
  exploredAuthoring,
  'explored authoring panes retain geographic views after resizing',
);
mountedHookState = undefined;
console.log('Split remount, authored framing, resize and real gesture snapshot regressions passed.');
