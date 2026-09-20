import '../css/ComparisonSplitView.css';

import React from 'react';
import { Button, Tooltip } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import { DeckGL, type DeckGLRef } from '@deck.gl/react';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import { Map, type MapRef } from 'react-map-gl/maplibre';
import type { CameraTarget, ViewportSize } from '../camera/types';
import type { CameraView } from '../interfaces';
import type { ResolvedVisualizationRuntime } from '../visualization/types';
import { applyVisualizationCameraConstraints } from '../visualization/camera-constraints';
import { isCameraNavigationGesture, type CameraNavigationState } from '../story/camera-navigation';
import {
  applySyncedPaneViewChange,
  completeComparisonSplitExit,
  computeComparisonPaneViews,
  createComparisonSplitPresence,
  updateComparisonSplitPresence,
  resolveComparisonNavigationPanes,
  type ComparisonPaneId,
  type ComparisonNavigationSnapshot,
} from './comparisonSplitModel';
import { getViewStatePreviewMapProps } from './viewStatePreviewMap';
import { OwnedDeck } from '../rendering/owned-deck';
import { createOwnedEffects } from '../rendering/owned-effects';
import { heatmapAggregationReady } from '../rendering/render-readiness';

export interface ComparisonSplitViewProps {
  animationTime?: number;
  runtime: ResolvedVisualizationRuntime;
  presentationKey?: string;
  targets?: [CameraTarget, CameraTarget];
  baseView: CameraView;
  viewportSize?: ViewportSize;
  interactive?: boolean;
  navigation?: { mode: CameraNavigationState['mode']; returnProgress: number };
  onNavigationStart?: () => void;
  navigationSnapshot?: ComparisonNavigationSnapshot;
  onNavigationSnapshotChange?: (snapshot: ComparisonNavigationSnapshot) => void;
  onExit?: () => void;
}

interface ComparisonSplitContent {
  key: string;
  targets: [CameraTarget, CameraTarget];
  interactive: boolean;
}

interface ComparisonSplitPresenceState {
  desiredContent?: ComparisonSplitContent;
  content?: ComparisonSplitContent;
  visible: boolean;
}

const FALLBACK_VIEWPORT_SIZE: ViewportSize = { width: 800, height: 600 };
const EXIT_TRANSITION_MS = 300;

function viewsMatch(actual: Partial<CameraView>, expected: CameraView): boolean {
  return (['longitude', 'latitude', 'zoom', 'pitch', 'bearing'] as const).every((key) => {
    if (typeof actual[key] !== 'number') return false;
    const delta = actual[key] - expected[key];
    return (
      Math.abs(key === 'bearing' || key === 'longitude' ? ((((delta + 180) % 360) + 360) % 360) - 180 : delta) <
      0.000001
    );
  });
}

function ComparisonPaneRenderer({
  id,
  runtime,
  animationTime,
  viewState,
  viewportSize,
  interactive,
  revealed,
  failed,
  onReady,
  onFailure,
  onViewStateChange,
}: {
  id: ComparisonPaneId;
  runtime: ResolvedVisualizationRuntime;
  animationTime?: number;
  viewState: CameraView;
  viewportSize: ViewportSize;
  interactive: boolean;
  revealed: boolean;
  failed: boolean;
  onReady: (id: ComparisonPaneId, ready: boolean) => void;
  onFailure: () => void;
  onViewStateChange: (event: {
    viewState: unknown;
    interactionState?: Parameters<typeof isCameraNavigationGesture>[0];
  }) => void;
}) {
  const deck = React.useRef<DeckGLRef>(null);
  const map = React.useRef<MapRef>(null);
  const mounted = React.useRef(true);
  const drawnView = React.useRef<CameraView>();
  const view = React.useMemo(
    () => applyVisualizationCameraConstraints(viewState, runtime.cameraConstraints),
    [viewState, runtime.cameraConstraints],
  );
  const viewSignature = JSON.stringify([
    view.longitude,
    view.latitude,
    view.zoom,
    view.pitch,
    view.bearing,
    viewportSize.width,
    viewportSize.height,
  ]);
  const effects = React.useMemo(() => createOwnedEffects(runtime.effects), [runtime.effects]);
  const resources = React.useMemo(() => {
    try {
      return {
        layers: runtime.createLayers({
          idPrefix: `compare-${id}-`,
          interactive: false,
          transitions: false,
          animationTime,
        }),
        effects,
      };
    } catch (error) {
      return { layers: [], effects: [], error };
    }
  }, [runtime, id, animationTime, effects]);
  const fail = React.useCallback(() => {
    if (mounted.current) onFailure();
  }, [onFailure]);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  React.useEffect(() => {
    if (resources.error) fail();
  }, [resources.error, fail]);

  const checkReady = React.useCallback(
    (afterDraw = false) => {
      if (!mounted.current || revealed || failed) return;
      const instance = deck.current?.deck;
      const viewport = instance?.getViewports()[0];
      const layersReady = Boolean(
        viewport &&
          viewsMatch(viewport, view) &&
          resources.layers.every(
            (layer) =>
              layer.isLoaded &&
              (!(layer instanceof HeatmapLayer) || heatmapAggregationReady(layer.state, viewport.scale)),
          ),
      );
      if (afterDraw && layersReady) drawnView.current = view;
      const basemap = map.current?.getMap();
      const center = basemap?.getCenter();
      const mapReady = Boolean(
        basemap &&
          center &&
          basemap.isStyleLoaded() &&
          basemap.areTilesLoaded() &&
          !basemap.isMoving() &&
          viewsMatch(
            {
              longitude: center.lng,
              latitude: center.lat,
              zoom: basemap.getZoom(),
              pitch: basemap.getPitch(),
              bearing: basemap.getBearing(),
            },
            view,
          ),
      );
      onReady(id, mapReady && layersReady && Boolean(drawnView.current && viewsMatch(drawnView.current, view)));
    },
    [failed, id, onReady, resources.layers, revealed, view],
  );

  // A committed camera/size change needs an actual draw. This also covers a
  // resize while the other pane is still loading, without re-gating navigation.
  React.useLayoutEffect(() => {
    if (revealed || failed) return;
    drawnView.current = undefined;
    onReady(id, false);
    deck.current?.deck?.redraw('comparison-view-committed');
  }, [viewSignature, revealed, failed, id, onReady]);

  if (failed || resources.error) return null;
  return (
    <DeckGL
      Deck={OwnedDeck}
      ref={deck}
      id={`comparison-deck-${id}`}
      layers={resources.layers}
      effects={resources.effects}
      viewState={view}
      onAfterRender={() => checkReady(true)}
      onError={fail}
      onViewStateChange={interactive ? onViewStateChange : undefined}
      controller={interactive ? { doubleClickZoom: false } : false}>
      <Map
        {...getViewStatePreviewMapProps(`compare-${id}`, runtime.mapStyle, runtime.cameraConstraints)}
        ref={map}
        reuseMaps={false}
        onIdle={() => checkReady()}
        onError={fail}
      />
    </DeckGL>
  );
}

function ComparisonSplitPanes({
  runtime,
  animationTime,
  presentationKey,
  targets,
  baseView,
  viewportSize,
  interactive,
  onExit,
  visible,
  navigation,
  onNavigationStart,
  navigationSnapshot,
  onNavigationSnapshotChange,
}: Omit<ComparisonSplitViewProps, 'presentationKey' | 'targets' | 'interactive'> & {
  presentationKey: string;
  targets: [CameraTarget, CameraTarget];
  interactive: boolean;
  visible: boolean;
}) {
  // The framing is frozen at the view the overlay opened on; following the main view while it
  // animates underneath during playback would make the panes drift.
  const snapshot = navigationSnapshot?.key === presentationKey ? navigationSnapshot : undefined;
  const [frozenBaseView] = React.useState(snapshot?.baseView ?? baseView);
  const framingBaseView = snapshot?.baseView ?? frozenBaseView;
  const width = viewportSize?.width ?? FALLBACK_VIEWPORT_SIZE.width;
  const height = viewportSize?.height ?? FALLBACK_VIEWPORT_SIZE.height;
  const initialPanes = React.useMemo(() => {
    if (snapshot?.viewportSize.width === width && snapshot.viewportSize.height === height) {
      return snapshot.initialPanes;
    }
    return computeComparisonPaneViews({
      targets,
      baseView: framingBaseView,
      viewportSize: { width, height },
    });
  }, [
    targets,
    width,
    height,
    framingBaseView,
    snapshot?.initialPanes,
    snapshot?.viewportSize.width,
    snapshot?.viewportSize.height,
  ]);
  // Playback snapshots live in PanelMain so candidate previews can unmount and restore this overlay.
  // Authoring keeps its existing local interaction; resizing only changes the authored fit.
  const [paneState, setPaneState] = React.useState<
    { targets: typeof targets; panes: typeof initialPanes } | undefined
  >();
  const manualPanes = navigation
    ? (snapshot?.manualPanes ?? initialPanes)
    : paneState?.targets === targets
      ? paneState.panes
      : initialPanes;
  const panes = navigation
    ? resolveComparisonNavigationPanes(initialPanes, manualPanes, navigation.mode, navigation.returnProgress)
    : manualPanes;

  React.useEffect(() => {
    if (!navigation || !onNavigationSnapshotChange || snapshot?.initialPanes === initialPanes) return;
    onNavigationSnapshotChange({
      key: presentationKey,
      baseView: framingBaseView,
      initialPanes,
      manualPanes,
      viewportSize: { width, height },
    });
  }, [
    navigation,
    onNavigationSnapshotChange,
    snapshot?.initialPanes,
    initialPanes,
    presentationKey,
    framingBaseView,
    manualPanes,
    width,
    height,
  ]);

  const [readiness, setReadiness] = React.useState({ a: false, b: false, status: 'loading' });
  const paneReady = React.useCallback((id: ComparisonPaneId, ready: boolean) => {
    setReadiness((current) => {
      // Only initial presentation is gated. Normal navigation, runtime frames,
      // exit fading and re-entry during that fade must keep the existing pixels.
      if (current.status !== 'loading' || current[id] === ready) return current;
      const next = { ...current, [id]: ready };
      return next.a && next.b ? { ...next, status: 'ready' } : next;
    });
  }, []);
  const paneFailed = React.useCallback(() => {
    setReadiness((current) => (current.status === 'loading' ? { ...current, status: 'failed' } : current));
  }, []);

  const handlePaneViewStateChange =
    (paneId: ComparisonPaneId) =>
    (event: { viewState: unknown; interactionState?: Parameters<typeof isCameraNavigationGesture>[0] }) => {
      const isGesture = isCameraNavigationGesture(event.interactionState);
      const hasManualControl = navigation ? navigation.mode === 'free' : paneState?.targets === targets;
      if (!isGesture && !hasManualControl) return;
      if (isGesture) onNavigationStart?.();
      const nextPanes = applySyncedPaneViewChange(panes, paneId, event.viewState as CameraView);
      if (navigation && onNavigationSnapshotChange) {
        onNavigationSnapshotChange({
          key: presentationKey,
          baseView: framingBaseView,
          initialPanes,
          manualPanes: nextPanes,
          viewportSize: { width, height },
        });
      } else {
        setPaneState({ targets, panes: nextPanes });
      }
    };

  return (
    <div
      className={`comparison-split-view ${readiness.status === 'ready' && visible ? 'comparison-split-view-visible' : ''}`}
      data-readiness={readiness.status}
      aria-hidden={readiness.status !== 'ready' || !visible}>
      {panes.map((pane) => (
        <div key={pane.id} className="comparison-split-pane">
          <ComparisonPaneRenderer
            id={pane.id}
            runtime={runtime}
            animationTime={animationTime}
            viewState={pane.viewState}
            viewportSize={{ width, height }}
            interactive={interactive}
            revealed={readiness.status === 'ready'}
            failed={readiness.status === 'failed'}
            onReady={paneReady}
            onFailure={paneFailed}
            onViewStateChange={handlePaneViewStateChange(pane.id)}
          />
          <div className="comparison-split-pane-label">{pane.id.toUpperCase()}</div>
        </div>
      ))}
      {interactive && onExit && (
        <div className="comparison-split-exit">
          <Tooltip title="Exit comparison" placement="left">
            <Button
              size="large"
              className="rounded-none! border-0! bg-slate-800/75! hover:bg-slate-800!"
              icon={<CloseOutlined className="text-2xl! text-white/75! hover:text-white!" />}
              onClick={onExit}
            />
          </Tooltip>
        </div>
      )}
    </div>
  );
}

function ComparisonSplitView({
  runtime,
  animationTime,
  presentationKey,
  targets,
  baseView,
  viewportSize,
  interactive = false,
  navigation,
  onNavigationStart,
  navigationSnapshot,
  onNavigationSnapshotChange,
  onExit,
}: ComparisonSplitViewProps) {
  const desiredContent = React.useMemo<ComparisonSplitContent | undefined>(
    () => (presentationKey && targets ? { key: presentationKey, targets, interactive } : undefined),
    [interactive, presentationKey, targets],
  );
  const [presence, setPresence] = React.useState<ComparisonSplitPresenceState>(() => ({
    ...updateComparisonSplitPresence(createComparisonSplitPresence<ComparisonSplitContent>(), desiredContent),
    desiredContent,
  }));

  if (presence.desiredContent !== desiredContent) {
    setPresence({
      ...updateComparisonSplitPresence(presence, desiredContent),
      desiredContent,
    });
  }

  React.useEffect(() => {
    if (presence.visible || !presence.content) {
      return undefined;
    }

    const exitingContent = presence.content;
    const timeoutId = window.setTimeout(
      () =>
        setPresence((current) =>
          current.visible || current.content !== exitingContent
            ? current
            : {
                ...completeComparisonSplitExit(current),
                desiredContent: current.desiredContent,
              },
        ),
      EXIT_TRANSITION_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [presence.content, presence.visible]);

  if (!presence.content) {
    return null;
  }

  return (
    <ComparisonSplitPanes
      key={presence.content.key}
      presentationKey={presence.content.key}
      runtime={runtime}
      animationTime={animationTime}
      targets={presence.content.targets}
      baseView={baseView}
      viewportSize={viewportSize}
      interactive={presence.content.interactive}
      onExit={onExit}
      visible={presence.visible}
      navigation={navigation}
      onNavigationStart={onNavigationStart}
      navigationSnapshot={navigationSnapshot}
      onNavigationSnapshotChange={onNavigationSnapshotChange}
    />
  );
}

export default ComparisonSplitView;
