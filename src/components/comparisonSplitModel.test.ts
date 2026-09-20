import assertStrict from 'node:assert/strict';
import type { CameraView } from '../interfaces';
import { createPointTarget, createRegionTarget } from '../camera/selection';
import { fitVisualTargetToView, getProjectedVisualBounds } from '../camera/viewport';
import {
  completeComparisonSplitExit,
  applySyncedPaneViewChange,
  computeComparisonPaneViews,
  createComparisonSplitPresence,
  getComparisonPaneViewportSize,
  updateComparisonSplitPresence,
  resolveComparisonNavigationPanes,
  type ComparisonPaneView,
} from './comparisonSplitModel';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertClose(actual: number, expected: number, tolerance: number, message: string) {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected} +/- ${tolerance}, received ${actual}`,
  );
}

function createBaseView(): CameraView {
  return {
    longitude: 114.2,
    latitude: 22.4,
    zoom: 10,
    pitch: 30,
    bearing: 0,
    minZoom: 0,
    maxZoom: 20,
    minPitch: 0,
    maxPitch: 85,
  };
}

function testPaneViewportIsHalfWidth() {
  const paneSize = getComparisonPaneViewportSize({ width: 999, height: 600 });
  assert(paneSize.width === 499, `odd widths should floor to the half pane, received ${paneSize.width}`);
  assert(paneSize.height === 600, 'pane height should keep the full viewport height');

  const degenerate = getComparisonPaneViewportSize({ width: 1, height: 1 });
  assert(degenerate.width >= 1 && degenerate.height >= 1, 'pane size should never collapse below 1px');
}

function testPaneViewsShareMinZoomWithIndependentCenters() {
  const smallTarget = createPointTarget([114.1, 22.3]);
  const largeTarget = createRegionTarget([
    [113.8, 22.0],
    [114.6, 22.0],
    [114.6, 22.8],
    [113.8, 22.8],
  ]);
  const baseView = createBaseView();
  const viewportSize = { width: 1200, height: 800 };
  const paneViewportSize = getComparisonPaneViewportSize(viewportSize);
  const smallFit = fitVisualTargetToView({ target: smallTarget, baseView, viewportSize: paneViewportSize }).view;
  const largeFit = fitVisualTargetToView({ target: largeTarget, baseView, viewportSize: paneViewportSize }).view;
  const expectedZoom = Math.min(smallFit.zoom, largeFit.zoom);

  const panes = computeComparisonPaneViews({ targets: [smallTarget, largeTarget], baseView, viewportSize });

  assert(panes[0].id === 'a' && panes[1].id === 'b', 'panes should be labeled a and b in target order');
  assertClose(panes[0].viewState.zoom, expectedZoom, 1e-6, 'pane A zoom should be the min of both fits');
  assertClose(panes[1].viewState.zoom, expectedZoom, 1e-6, 'pane B zoom should be the min of both fits');
  assert(expectedZoom < smallFit.zoom, 'the larger target should force the shared zoom below the point fit');
  assertClose(panes[0].viewState.longitude, smallFit.longitude, 0.05, 'pane A should keep its own fit center');
  assertClose(panes[1].viewState.longitude, largeFit.longitude, 0.05, 'pane B should keep its own fit center');
  assert(
    Math.abs(panes[0].viewState.longitude - panes[1].viewState.longitude) > 0.05,
    'pane centers should stay independent',
  );
  assertClose(panes[0].viewState.pitch, panes[1].viewState.pitch, 1e-6, 'pane pitches should match');
  assertClose(panes[0].viewState.bearing, panes[1].viewState.bearing, 1e-6, 'pane bearings should match');
}

function testSyncedPaneViewChangeSyncsZoomAndKeepsCenters() {
  const targets: [ReturnType<typeof createPointTarget>, ReturnType<typeof createPointTarget>] = [
    createPointTarget([114.1, 22.3]),
    createPointTarget([114.5, 22.7]),
  ];
  const panes = computeComparisonPaneViews({
    targets,
    baseView: createBaseView(),
    viewportSize: { width: 1200, height: 800 },
  });
  const originalPaneBCenter = [panes[1].viewState.longitude, panes[1].viewState.latitude];

  const zoomed = applySyncedPaneViewChange(panes, 'a', {
    ...panes[0].viewState,
    longitude: panes[0].viewState.longitude + 0.2,
    zoom: panes[0].viewState.zoom + 1.5,
    pitch: 45,
    bearing: 15,
  });

  assertClose(zoomed[0].viewState.longitude, panes[0].viewState.longitude + 0.2, 1e-9, 'pane A should take its pan');
  assertClose(zoomed[1].viewState.zoom, panes[0].viewState.zoom + 1.5, 1e-9, 'pane B zoom should follow pane A');
  assertClose(zoomed[1].viewState.pitch, 45, 1e-9, 'pane B pitch should follow pane A');
  assertClose(zoomed[1].viewState.bearing, 15, 1e-9, 'pane B bearing should follow pane A');
  assertClose(zoomed[1].viewState.longitude, originalPaneBCenter[0], 1e-9, 'pane B center should not move');
  assertClose(zoomed[1].viewState.latitude, originalPaneBCenter[1], 1e-9, 'pane B center should not move');

  const panned = applySyncedPaneViewChange(zoomed, 'b', {
    ...zoomed[1].viewState,
    latitude: zoomed[1].viewState.latitude - 0.3,
  });
  assertClose(panned[1].viewState.latitude, zoomed[1].viewState.latitude - 0.3, 1e-9, 'pane B should take its pan');
  assertClose(panned[0].viewState.longitude, zoomed[0].viewState.longitude, 1e-9, 'pane A center should not move');
  assertClose(panned[0].viewState.zoom, zoomed[0].viewState.zoom, 1e-9, 'equal zoom should stay unchanged');
}

function testTallColumnFitFinishesAtActualPaneSize() {
  const target = {
    ...createPointTarget([-0.1155, 51.5233]),
    visualFrame: {
      bbox: [-0.1293, 51.5134, -0.1017, 51.5332] as [number, number, number, number],
      anchor: [-0.1155, 51.5233] as [number, number],
      heightMeters: 117964.82412060302,
    },
  };
  for (const width of [800, 1000]) {
    const viewportSize = { width, height: 600 };
    const panes = computeComparisonPaneViews({
      targets: [target, createPointTarget([-0.4194, 51.8792])],
      baseView: {
        ...createBaseView(),
        longitude: -0.44,
        latitude: 51.91,
        zoom: 7,
        minZoom: 5,
        maxZoom: 15,
        pitch: 20,
        bearing: -27,
      },
      viewportSize,
    });
    for (const pane of panes) {
      const size = getComparisonPaneViewportSize(viewportSize);
      const bounds = getProjectedVisualBounds(pane.viewState, pane.target, size);
      assert(
        Boolean(bounds && Math.min(bounds.minX, bounds.minY, size.width - bounds.maxX, size.height - bounds.maxY) >= 0),
        `${width}px pane ${pane.id}: an unfinished ground-bbox fit must not return a cropped or unprojectable column`,
      );
    }
    assertClose(panes[0].viewState.zoom, panes[1].viewState.zoom, 1e-9, 'tall-column panes retain equal scale');
  }
}

function testSplitPresenceKeepsContentUntilExitCompletes() {
  const initial = createComparisonSplitPresence<string>();
  const visible = updateComparisonSplitPresence(initial, 'segment-a');
  const exiting = updateComparisonSplitPresence(visible, undefined);

  assert(visible.visible && visible.content === 'segment-a', 'activating should show the new split content');
  assert(!exiting.visible, 'removing the desired presentation should start the exit transition');
  assert(exiting.content === 'segment-a', 'exit transition should retain the last split content');

  const completed = completeComparisonSplitExit(exiting);
  assert(!completed.visible && completed.content === undefined, 'exit completion should release retained content');
}

function testSplitPresenceCancelsExitWhenContentReturns() {
  const visible = updateComparisonSplitPresence(createComparisonSplitPresence<string>(), 'segment-a');
  const exiting = updateComparisonSplitPresence(visible, undefined);
  const restored = updateComparisonSplitPresence(exiting, 'segment-b');
  const staleCompletion = completeComparisonSplitExit(restored);

  assert(restored.visible && restored.content === 'segment-b', 'new content should cancel an in-progress exit');
  assert(staleCompletion === restored, 'a stale exit completion should not remove visible content');
}

function createNavigationPanes(): [ComparisonPaneView, ComparisonPaneView] {
  return ['a', 'b'].map((id, index) => ({
    id,
    target: createPointTarget([index, 50]),
    framingStatus: 'fitted',
    viewState: { longitude: index, latitude: 50, zoom: 5, bearing: 179, pitch: 0 },
  })) as [ComparisonPaneView, ComparisonPaneView];
}

function testNavigationPreservesFreeFramingAndReturnsAlongShortestArc() {
  const initial = createNavigationPanes();
  const manual = initial.map((pane) => ({
    ...pane,
    viewState: {
      ...pane.viewState,
      longitude: pane.viewState.longitude + 2,
      zoom: 7,
      bearing: -179,
    },
  })) as [ComparisonPaneView, ComparisonPaneView];
  const before = JSON.stringify({ initial, manual });
  assertStrict.equal(
    resolveComparisonNavigationPanes(initial, manual, 'free', 0),
    manual,
    'free view preserves user pane framing',
  );
  assertStrict.equal(
    resolveComparisonNavigationPanes(initial, manual, 'follow', 1),
    initial,
    'following uses story framing',
  );
  const start = resolveComparisonNavigationPanes(initial, manual, 'returning', 0);
  assertStrict.equal(
    start[0].viewState.longitude,
    manual[0].viewState.longitude,
    'split return starts at the visible view',
  );
  const middle = resolveComparisonNavigationPanes(initial, manual, 'returning', 0.5);
  assertStrict.equal(middle[0].viewState.zoom, 6, 'both panes use the shared recovery progress');
  assertStrict.equal(middle[1].viewState.zoom, 6, 'both panes keep equal scale during recovery');
  assertStrict.equal(Math.abs(middle[0].viewState.bearing), 180, 'split recovery crosses the short angular arc');
  const end = resolveComparisonNavigationPanes(initial, manual, 'returning', 1);
  assertStrict.equal(
    end[1].viewState.longitude,
    initial[1].viewState.longitude,
    'recovery reaches current authored framing',
  );
  assertStrict.equal(
    JSON.stringify({ initial, manual }),
    before,
    'exploration never mutates targets or source framing',
  );
}

function testPaneNavigationStripsInheritedTransitions() {
  const initial = createNavigationPanes();
  const animatedView = {
    ...initial[0].viewState,
    transitionDuration: 500,
    onTransitionStart: () => undefined,
    onTransitionEnd: () => undefined,
    onTransitionInterrupt: () => undefined,
  };
  const independentPanes = computeComparisonPaneViews({
    targets: [initial[0].target, initial[1].target],
    baseView: animatedView,
    viewportSize: { width: 800, height: 600 },
  });
  const syncedPanes = applySyncedPaneViewChange(
    [
      { ...initial[0], viewState: animatedView },
      { ...initial[1], viewState: animatedView },
    ],
    'a',
    { ...animatedView, zoom: 8 },
  );
  for (const pane of [...independentPanes, ...syncedPanes]) {
    assertStrict.equal(pane.viewState.transitionDuration, 0, 'independent panes never replay a main-camera transition');
    assertStrict.equal(
      pane.viewState.onTransitionStart,
      undefined,
      'pane navigation drops inherited animation callbacks',
    );
    assertStrict.equal(pane.viewState.onTransitionEnd, undefined);
    assertStrict.equal(pane.viewState.onTransitionInterrupt, undefined);
  }
  assertStrict.equal(animatedView.transitionDuration, 500, 'clearing pane transitions does not mutate the source view');
}

testPaneViewportIsHalfWidth();
testPaneViewsShareMinZoomWithIndependentCenters();
testSyncedPaneViewChangeSyncsZoomAndKeepsCenters();
testSplitPresenceKeepsContentUntilExitCompletes();
testSplitPresenceCancelsExitWhenContentReturns();
testTallColumnFitFinishesAtActualPaneSize();
testNavigationPreservesFreeFramingAndReturnsAlongShortestArc();
testPaneNavigationStripsInheritedTransitions();
