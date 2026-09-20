import type { CameraTarget, ViewportSize } from '../camera/types';
import type { CameraView } from '../interfaces';
import { ensureVisualTargetVisible, fitVisualTargetToView } from '../camera/viewport';
import { cleanNavigationView, interpolateNavigationView, type CameraNavigationState } from '../story/camera-navigation';

export type ComparisonPaneId = 'a' | 'b';

export interface ComparisonPaneView {
  id: ComparisonPaneId;
  target: CameraTarget;
  viewState: CameraView;
  framingStatus: 'fitted' | 'unresolved';
  framingReason?: string;
}

export interface ComparisonNavigationSnapshot {
  key: string;
  /** Authored framing captured when this split presentation opened. */
  baseView: CameraView;
  initialPanes: [ComparisonPaneView, ComparisonPaneView];
  manualPanes: [ComparisonPaneView, ComparisonPaneView];
  viewportSize: ViewportSize;
}

export function captureComparisonNavigationSnapshot(
  snapshot: ComparisonNavigationSnapshot | undefined,
  mode: CameraNavigationState['mode'],
  returnProgress: number,
): ComparisonNavigationSnapshot | undefined {
  if (!snapshot) return undefined;
  return {
    ...snapshot,
    manualPanes: resolveComparisonNavigationPanes(snapshot.initialPanes, snapshot.manualPanes, mode, returnProgress),
  };
}

export interface ComparisonSplitPresence<T> {
  content?: T;
  visible: boolean;
}

export function resolveComparisonNavigationPanes(
  initial: [ComparisonPaneView, ComparisonPaneView],
  manual: [ComparisonPaneView, ComparisonPaneView],
  mode: CameraNavigationState['mode'],
  returnProgress: number,
): [ComparisonPaneView, ComparisonPaneView] {
  if (mode === 'follow') return initial;
  if (mode === 'free') return manual;
  return manual.map((pane, index) => ({
    ...pane,
    viewState: interpolateNavigationView(pane.viewState, initial[index].viewState, returnProgress),
  })) as [ComparisonPaneView, ComparisonPaneView];
}

export function createComparisonSplitPresence<T>(): ComparisonSplitPresence<T> {
  return { visible: false };
}

export function updateComparisonSplitPresence<T>(
  presence: ComparisonSplitPresence<T>,
  content: T | undefined,
): ComparisonSplitPresence<T> {
  if (content !== undefined) {
    return { content, visible: true };
  }
  return presence.content === undefined ? presence : { content: presence.content, visible: false };
}

export function completeComparisonSplitExit<T>(presence: ComparisonSplitPresence<T>): ComparisonSplitPresence<T> {
  return presence.visible ? presence : createComparisonSplitPresence<T>();
}

export function getComparisonPaneViewportSize(viewportSize: ViewportSize): ViewportSize {
  return {
    width: Math.max(1, Math.floor(viewportSize.width / 2)),
    height: Math.max(1, viewportSize.height),
  };
}

export function computeComparisonPaneViews({
  targets,
  baseView,
  viewportSize,
}: {
  targets: [CameraTarget, CameraTarget];
  baseView: CameraView;
  viewportSize: ViewportSize;
}): [ComparisonPaneView, ComparisonPaneView] {
  const paneViewportSize = getComparisonPaneViewportSize(viewportSize);
  const framingView = cleanNavigationView(baseView);
  // A narrow ground footprint can exhaust the first bounded fit while its extrusion is still
  // behind the camera. Continue from that result before deriving the common presentation scale.
  const fits = targets.map((target) => {
    let fit = fitVisualTargetToView({ target, baseView: framingView, viewportSize: paneViewportSize });
    for (let attempt = 0; fit.status !== 'fitted' && attempt < 4; attempt++) {
      const next = ensureVisualTargetVisible({ target, viewState: fit.view, viewportSize: paneViewportSize });
      const unchanged = next.view.zoom === fit.view.zoom;
      fit = next;
      if (unchanged) break;
    }
    return fit;
  });
  // Equal scale is what makes the comparison fair: both panes take the smaller of the two fitted
  // zooms so each target stays fully framed inside its half-width pane.
  for (let attempt = 0; attempt < 4; attempt++) {
    const sharedZoom = Math.min(...fits.map((fit) => fit.view.zoom));
    for (let index = 0; index < fits.length; index++)
      fits[index] = ensureVisualTargetVisible({
        target: targets[index],
        viewState: { ...fits[index].view, zoom: sharedZoom },
        viewportSize: paneViewportSize,
      });
    if (fits.every((fit) => fit.view.zoom === sharedZoom)) break;
  }
  return fits.map((fit, index) => ({
    id: index === 0 ? 'a' : 'b',
    target: targets[index],
    viewState: fit.view,
    framingStatus: fit.status,
    framingReason: fit.reason,
  })) as [ComparisonPaneView, ComparisonPaneView];
}

export function applySyncedPaneViewChange(
  panes: [ComparisonPaneView, ComparisonPaneView],
  changedPaneId: ComparisonPaneId,
  nextView: CameraView,
): [ComparisonPaneView, ComparisonPaneView] {
  const syncPaneView = (pane: ComparisonPaneView): ComparisonPaneView => {
    if (pane.id === changedPaneId) {
      return { ...pane, viewState: cleanNavigationView({ ...pane.viewState, ...nextView }) };
    }

    return {
      ...pane,
      viewState: cleanNavigationView({
        ...pane.viewState,
        zoom: nextView.zoom,
        pitch: nextView.pitch,
        bearing: nextView.bearing,
      }),
    };
  };

  return [syncPaneView(panes[0]), syncPaneView(panes[1])];
}
