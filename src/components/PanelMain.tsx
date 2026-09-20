import 'maplibre-gl/dist/maplibre-gl.css';
import '../css/PanelMain.css';

import React from 'react';
import { Alert, Button, Card, message, Space, Tooltip, Typography } from 'antd';
import { CameraOutlined, CloseOutlined, GatewayOutlined, InfoCircleTwoTone, ReloadOutlined } from '@ant-design/icons';
import { Map } from 'react-map-gl/maplibre';
import { FlyToInterpolator } from '@deck.gl/core';
import type { PickingInfo } from '@deck.gl/core';
import { DeckGL } from '@deck.gl/react';
import _ from 'lodash';
import type {
  CustomObject,
  CameraView,
  CameraMovement,
  HomeViews,
  PlaybackRequest,
  PlaybackSegment,
} from '../interfaces';
import { copyHomeView, includeHomeViewInConstraints } from '../story/home-view';
import MapDrawingEditor, { type MapDrawingFeature } from './MapDrawingEditor';
import {
  createPathTarget,
  createPointTarget,
  createRegionTarget,
  enrichCameraTargetStats,
  filterRowsInsideAnalyticsBounds,
  getHexagonPickedCoordinate,
  getPickedObjectRows,
  getRowLngLat,
  createMultipleTarget,
} from '../camera/selection';
import type { CameraTarget, ViewportSize } from '../camera/types';
import type { ShadowSceneIdentity } from '../camera/types';
import { attachRendererSelectionEnvelope } from '../camera/renderer-selection-envelope';
import {
  captureHexagonTarget,
  captureCurrentHexagonTarget,
  rememberTargetSource,
  resolveCurrentTargetRows,
  refreshTargetGeometry,
} from '../camera/renderer-target';
import { getPlaybackViewportLayout } from '../story/planning-viewport';
import { getCameraAnnotationAtTime } from '../story/annotation';
import { captureHeatmapTarget } from '../camera/heatmap-query';
import type { CameraEnvelopeProducer, SelectionMode } from '../visualization/camera-contract';
import {
  getActiveDatasetId,
  getFileName,
  resolveVisualizationShell,
  resolveVisualizationRuntime,
} from '../visualization/registry';
import type {
  ResolvedVisualizationShell,
  ResolvedVisualizationRuntime,
  UploadedDatasetOverride,
  VisualizationCatalog,
  VisualizationParameterValues,
} from '../visualization/types';
import {
  getPlaybackPositionAtTime,
  getStoppedPlaybackView,
  getViewAtPlaybackTime,
  stripCameraTransition,
} from '../story/playback';
import { startTrajectoryPlaybackDriver } from '../story/playback-driver';
import {
  advanceCameraNavigation,
  createCameraNavigation,
  isCameraNavigationGesture,
  resumeCameraFollow,
  takeCameraControl,
  updateStoryView,
  type CameraNavigationState,
} from '../story/camera-navigation';
import {
  getSplitPresentationAtPlaybackTime,
  reconcileSplitPresentationForPlanRevision,
  type PlaybackSplitPresentation,
} from '../story/split-presentation';
import ComparisonSplitView from './ComparisonSplitView';
import { captureComparisonNavigationSnapshot, type ComparisonNavigationSnapshot } from './comparisonSplitModel';
import ViewStateEditorModal from './ViewStateEditorModal';
import {
  applyDraftToCamera,
  createDraft,
  resetDraftView,
  updateDraftView,
  type ViewStateEditorDraft,
} from './viewStateEditorModel';
import { applyVisualizationCameraConstraints } from '../visualization/camera-constraints';
import { getVisualizationRefreshMode } from './visualizationRefresh';
import {
  getOptionalPanelText,
  getRuntimeLayerPolicy,
  getRuntimeStatusText,
  type PanelRuntimePhase,
} from './panelMainPresentation';
import {
  createVisualizationRuntimeSignature,
  VisualizationRuntimeRequestCoordinator,
} from './visualizationRuntimeRequest';
import { visualizationPerformance, type VisualizationPerformanceMilestone } from './visualizationPerformance';
import { fitVisualTargetToView } from '../camera/viewport';
import SelectionObjectBar from './SelectionObjectBar';
import VisualizationTitle from './VisualizationTitle';
import { getLineSource, getLineTarget } from '../visualization/line-data';
import { getTripTimedPath } from '../visualization/trip-data';
import { getSceneTimeAtPlaybackTime, type SceneTimeFrame } from '../story/scene-time';

const { Paragraph } = Typography;
const ANIMATION_UNITS_PER_SECOND = 60;
const MAX_ANIMATION_FRAME_MS = 100;

function round(number: number) {
  return number.toFixed(3);
}

function getTripPathCoordinates(object: CustomObject) {
  const path = object.path;
  if (!Array.isArray(path)) {
    return [];
  }

  return path
    .filter((coordinate) => Array.isArray(coordinate) && coordinate.length >= 2)
    .map((coordinate) => [Number(coordinate[0]), Number(coordinate[1])])
    .filter((coordinate) => Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1]));
}

export interface PanelMainProps {
  activeVisualizationId: string;
  visualizationCatalog: VisualizationCatalog;
  catalogValidationErrors: string[];
  visualizationParams: VisualizationParameterValues;
  manualParameterKeys: readonly string[];
  datasetOverride?: UploadedDatasetOverride;
  visTitle: string;
  visData: CustomObject[];
  viewportSize?: ViewportSize;
  playbackRequest?: PlaybackRequest;
  playbackPlanRevision: number;
  viewState: CameraView;
  homeViews?: HomeViews;
  onHomeViewChange?: (sceneKey: string, view?: CameraView) => void;
  viewStateModalVisible: boolean;
  cameraViewStateEditIndex: number;
  editingCameraMovement?: CameraMovement;
  comparisonPreview?: { targets: [CameraTarget, CameraTarget] };
  selectionTargets?: CameraTarget[];
  objectSelectionVisible?: boolean;
  onSelectionRemove?: (id: string) => void;
  onSelectionClear?: () => void;
  onComparisonPreviewExit: () => void;
  onVisDataChange: (data: CustomObject[]) => void;
  onVisDataNameChange: (name: string) => void;
  onVisDataTitleChange: (title: string) => void;
  onVisDataFileNameChange: (name: string) => void;
  onCanvasViewStateUpdate: (viewState: CameraView) => void;
  onPlaybackStop?: () => void;
  onPlaybackProgress?: (timeMs: number, status: 'playing' | 'paused' | 'complete' | 'error') => void;
  onAnimationPlaybackControlChange?: (controlled: boolean) => void;
  onTargetLocationChange: (location: number[]) => void;
  onTargetGeoTypeChange: (type: string) => void;
  onTargetChange: (target: CameraTarget) => void;
  onViewportSizeChange: (size: ViewportSize) => void;
  onVisualizationParamsResolved: (visualizationId: string, params: VisualizationParameterValues) => void;
  onShadowSceneIdentityChange: (scene: ShadowSceneIdentity | undefined) => void;
  onViewStateModalVisibleChange: (isVisible: boolean) => void;
  onCameraMovementUpdate: (index: number, cameraMovement: CameraMovement) => boolean;
}

export interface PanelMainState {
  sceneTime?: SceneTimeFrame;
  replayCamera?: CameraMovement;
  replayOffsetMs?: number;
  runtimePhase: PanelRuntimePhase;
  viewState: CameraView;
  cameraNavigationMode: CameraNavigationState['mode'];
  cameraReturnProgress: number;
  mapDrawing: boolean;
  viewStateDraft?: ViewStateEditorDraft;
  animationTime: number;
  visualizationRuntime?: ResolvedVisualizationRuntime;
  visualizationRuntimeSourceKey?: string;
  visualizationError?: string;
  playbackSplitPresentation?: PlaybackSplitPresentation;
  comparisonNavigationSnapshot?: ComparisonNavigationSnapshot;
}

class PanelMain extends React.Component<PanelMainProps, PanelMainState> {
  private trajectoryPlaybackDriver?: { cancel(): void; setSuspended(suspended: boolean): void };
  private animationPlaybackControlled = false;
  private cameraNavigation: CameraNavigationState;
  private navigationSegments?: PlaybackSegment[];
  private cameraReturnFrame?: number;
  private cachedSplitSegment?: PlaybackSegment;
  private cachedSplitPresentation?: PlaybackSplitPresentation;
  private latestEditCamera?: CameraMovement;
  private animationId = 0;
  private lastAnimationTimestamp?: number;
  private visualizationRequestCoordinator = new VisualizationRuntimeRequestCoordinator();
  private lastSyncedCanvasViewState?: CameraView;
  private performanceMilestonesBySource = new globalThis.Map<string, Set<VisualizationPerformanceMilestone>>();
  private mapContainerRef = React.createRef<HTMLDivElement>();
  private mapResizeObserver?: ResizeObserver;

  private attachShadowEnvelope(
    target: CameraTarget,
    expectedProducer: CameraEnvelopeProducer,
    selectionMode: SelectionMode,
    marks: readonly CustomObject[],
    heatmapQueryPoint?: [number, number],
  ): CameraTarget {
    const runtime = this.state.visualizationRuntime;
    const viewport = this.props.viewportSize;
    if (!runtime || !viewport) return target;
    const layer = runtime.resolvedLayers.find((item) => item.descriptor.resolvedSupport.producer === expectedProducer);
    const result = attachRendererSelectionEnvelope({
      target,
      resolvedLayers: runtime.resolvedLayers,
      expectedProducer,
      selectionMode,
      marks,
      heatmapQueryPoint,
      referenceView: this.state.viewState,
      viewport,
    });
    return layer ? rememberTargetSource(result.target, layer) : result.target;
  }

  resolveTargetSnapshot(target: CameraTarget): CameraTarget {
    if (target.type === 'none') return target;
    if (target.children?.length)
      return {
        ...createMultipleTarget(target.children.map((child) => this.resolveTargetSnapshot(child))),
        id: target.id,
      };
    const runtime = this.state.visualizationRuntime;
    if (!runtime || this.state.runtimePhase !== 'ready')
      throw new Error('Wait for the current visualization to finish loading before re-adapting.');
    if (target.sourceVisualizationId && target.sourceVisualizationId !== runtime.config.id)
      throw new Error('Switch back to this shot’s visualization before re-adapting.');
    const resolved = target.sourceLayerId
      ? runtime.resolvedLayers.find((layer) => layer.descriptor.layerId === target.sourceLayerId)
      : target.source === 'heatmap-zone'
        ? runtime.resolvedLayers.find((layer) => layer.descriptor.resolvedSupport.producer === 'heatmap-kernel')
        : (runtime.resolvedLayers.find((layer) => layer.descriptor.resolvedSupport.producer === 'hexagon-cell') ??
          runtime.resolvedLayers[0]);
    if (!resolved) throw new Error('The original visualization layer is unavailable. Select a new target.');
    const producer = resolved.descriptor.resolvedSupport.producer;
    if (producer === 'heatmap-kernel') {
      const viewport = getPlaybackViewportLayout(
        this.state.replayCamera,
        this.props.viewportSize ?? { width: 800, height: 600 },
      ).viewport;
      const captured = captureHeatmapTarget(
        target,
        resolved,
        target.selectionAnchor ?? target.center,
        this.state.viewState,
        viewport,
      );
      if (captured.status !== 'ok') throw new Error(captured.reason);
      return captured.value;
    }
    if (target.snapshotEnvelope?.provenance.resolvedLayerDigest === resolved.descriptor.resolvedLayerDigest) {
      return target;
    }
    if (producer === 'hexagon-cell') {
      const layer =
        runtime.layers.find((item) => item.id === resolved.descriptor.layerId) ??
        runtime.layers.find((item) => item.state?.aggregator);
      const result = captureCurrentHexagonTarget(target, resolved, layer ?? {});
      if (result.status !== 'ok') throw new Error(result.reason);
      return result.value;
    }
    const rows = resolveCurrentTargetRows(target, resolved.data, resolved);
    if (!rows.length) throw new Error('The selected objects are no longer available. Select the target again.');
    const refreshed = enrichCameraTargetStats(refreshTargetGeometry(target, resolved, rows), {
      analytics: runtime.analytics,
    });
    const mode: SelectionMode =
      target.source === 'heatmap-zone' ? 'map-click' : target.source === 'drawn-region' ? 'region' : 'click';
    const result = this.attachShadowEnvelope(
      refreshed,
      producer,
      mode,
      rows,
      mode === 'map-click' ? target.center : undefined,
    );
    if (!result.snapshotEnvelope)
      throw new Error('Current rendered geometry could not be captured. Select the target again.');
    return result;
  }

  capturePresentation() {
    return {
      sceneTime: this.state.sceneTime,
      viewState: { ...this.state.viewState },
      replayCamera: this.state.replayCamera,
      replayOffsetMs: this.state.replayOffsetMs,
      playbackSplitPresentation: this.state.playbackSplitPresentation,
      comparisonNavigationSnapshot: captureComparisonNavigationSnapshot(
        this.state.comparisonNavigationSnapshot,
        this.state.cameraNavigationMode,
        this.state.cameraReturnProgress,
      ),
      cameraNavigation: this.cameraNavigation,
      navigationSegments: this.navigationSegments,
      cameraReturnRemainingMs: this.cameraNavigation.transition
        ? Math.max(
            0,
            this.cameraNavigation.transition.durationMs -
              (performance.now() - this.cameraNavigation.transition.startedAtMs),
          )
        : undefined,
    };
  }

  pausePresentation() {
    this.clearPlaybackTimers();
    this.clearCameraReturn();
  }

  restorePresentation(presentation: ReturnType<PanelMain['capturePresentation']>) {
    this.pausePresentation();
    const { cameraNavigation, navigationSegments, cameraReturnRemainingMs, ...state } = presentation;
    this.cameraNavigation =
      cameraNavigation.mode === 'returning' && cameraNavigation.transition
        ? {
            ...cameraNavigation,
            transition: {
              ...cameraNavigation.transition,
              from: cameraNavigation.view,
              startedAtMs: performance.now(),
              durationMs: cameraReturnRemainingMs ?? cameraNavigation.transition.durationMs,
            },
          }
        : cameraNavigation;
    this.navigationSegments = navigationSegments;
    this.setAnimationPlaybackControl(Boolean(state.sceneTime));
    this.setState({ ...state, ...this.navigationStatePatch() });
    this.scheduleCameraReturn();
  }

  constructor(props: PanelMainProps) {
    super(props);
    this.handleCameraResetButtonClick = this.handleCameraResetButtonClick.bind(this);
    this.handleMapSelectionButtonClick = this.handleMapSelectionButtonClick.bind(this);
    this.handleCancelSelectionButtonClick = this.handleCancelSelectionButtonClick.bind(this);
    this.handleViewStateChange = this.handleViewStateChange.bind(this);
    this.handleDeckLoad = this.handleDeckLoad.bind(this);
    this.onHexagonLayerClick = this.onHexagonLayerClick.bind(this);
    this.onScatterLayerClick = this.onScatterLayerClick.bind(this);
    this.onLineLayerClick = this.onLineLayerClick.bind(this);
    this.onTripLayerClick = this.onTripLayerClick.bind(this);
    this.handleHeatmapMapClick = this.handleHeatmapMapClick.bind(this);
    this.handleMapFeatureDrawn = this.handleMapFeatureDrawn.bind(this);
    this.editCameraViewState = this.editCameraViewState.bind(this);
    this.handleInitialViewStateChange = this.handleInitialViewStateChange.bind(this);
    this.handleFinalViewStateChange = this.handleFinalViewStateChange.bind(this);
    this.handleDeckClick = this.handleDeckClick.bind(this);
    this.handleMapDrawingKeyDown = this.handleMapDrawingKeyDown.bind(this);
    this.handleEditInitialViewStateResetButtonClick = this.handleEditInitialViewStateResetButtonClick.bind(this);
    this.handleEditFinalViewStateResetButtonClick = this.handleEditFinalViewStateResetButtonClick.bind(this);
    this.measureMapViewportSize = this.measureMapViewportSize.bind(this);
    this.animate = this.animate.bind(this);

    this.cameraNavigation = createCameraNavigation(props.viewState);
    this.state = {
      runtimePhase: 'initial-loading',
      viewState: _.cloneDeep(props.viewState),
      cameraNavigationMode: 'follow',
      cameraReturnProgress: 1,
      mapDrawing: false,
      viewStateDraft: undefined,
      animationTime: 0,
    };
  }

  private isAnimationEnabled(runtime = this.state.visualizationRuntime) {
    const animation = runtime?.animation;
    if (
      !animation ||
      this.animationPlaybackControlled ||
      this.state.mapDrawing ||
      (typeof document !== 'undefined' && document.hidden)
    ) {
      return false;
    }

    return animation.enabledParam
      ? Boolean(
          this.props.visualizationParams[animation.enabledParam] ??
            runtime?.config.parameters?.find((parameter) => parameter.key === animation.enabledParam)?.default,
        )
      : true;
  }

  private syncAnimationLoop(runtime = this.state.visualizationRuntime) {
    if (this.isAnimationEnabled(runtime)) {
      if (!this.animationId) {
        this.animationId = window.requestAnimationFrame(this.animate);
      }
      return;
    }

    this.stopAnimationLoop();
  }

  private stopAnimationLoop() {
    if (this.animationId) {
      window.cancelAnimationFrame(this.animationId);
      this.animationId = 0;
    }
    this.lastAnimationTimestamp = undefined;
  }

  private handleAnimationVisibilityChange = () => {
    this.syncAnimationLoop();
    this.trajectoryPlaybackDriver?.setSuspended(
      this.state.mapDrawing || (typeof document !== 'undefined' && document.hidden),
    );
  };

  private setAnimationPlaybackControl(controlled: boolean) {
    if (controlled === this.animationPlaybackControlled) return;
    this.animationPlaybackControlled = controlled;
    this.props.onAnimationPlaybackControlChange?.(controlled);
    this.syncAnimationLoop();
  }

  private releaseAnimationPlayback() {
    this.setAnimationPlaybackControl(false);
    this.setState({ sceneTime: undefined });
  }

  private validatePlaybackScene(segments: PlaybackSegment[]) {
    const runtime = this.state.visualizationRuntime;
    for (const segment of segments) {
      const binding = segment.camera.animationBinding;
      if (!binding || segment.generated) continue;
      const layer = runtime?.resolvedLayers.find((candidate) => candidate.descriptor.layerId === binding.layerId);
      if (
        runtime?.config.id !== binding.visualizationId ||
        runtime?.dataset.id !== binding.datasetId ||
        layer?.descriptor.dataRevision !== binding.dataRevision ||
        !layer.data.some((row) => getTripTimedPath(row)?.digest === binding.pathDigest)
      ) {
        throw new Error(
          'This tracking shot uses a different dataset or version. Switch to its scene and re-adapt the shot.',
        );
      }
    }
  }

  private measureMapViewportSize() {
    const element = this.mapContainerRef.current;
    if (!element) {
      return;
    }

    const computedStyle = window.getComputedStyle(element);
    const horizontalPadding =
      Number.parseFloat(computedStyle.paddingLeft) + Number.parseFloat(computedStyle.paddingRight);
    const verticalPadding =
      Number.parseFloat(computedStyle.paddingTop) + Number.parseFloat(computedStyle.paddingBottom);
    const width = Math.max(1, Math.round(element.clientWidth - horizontalPadding));
    const height = Math.max(1, Math.round(element.clientHeight - verticalPadding));
    this.props.onViewportSizeChange({ width, height });
  }

  private resolveVisualizationShell() {
    return resolveVisualizationShell(this.props.visualizationCatalog, this.props.activeVisualizationId, {
      params: this.props.visualizationParams,
      datasetOverride: this.props.datasetOverride,
    });
  }

  private getVisualizationSourceKey(shell: ResolvedVisualizationShell) {
    const uploadedRevision =
      this.props.datasetOverride?.dataset.id === shell.dataset.id
        ? this.props.datasetOverride.contentDigest
        : undefined;
    return JSON.stringify([shell.config.id, shell.dataset.id, uploadedRevision ?? shell.dataset.revision]);
  }

  private createRuntimeSignature(
    shell: ResolvedVisualizationShell,
    params: VisualizationParameterValues = this.props.visualizationParams,
  ) {
    return createVisualizationRuntimeSignature({
      visualizationId: shell.config.id,
      datasetId: shell.dataset.id,
      datasetRevision:
        this.props.datasetOverride?.dataset.id === shell.dataset.id
          ? this.props.datasetOverride.contentDigest
          : shell.dataset.revision,
      params,
      manualParameterKeys: this.props.manualParameterKeys,
      viewport: this.props.viewportSize,
      animationTime: undefined,
    });
  }

  private markVisualizationMilestone(sourceKey: string, milestone: VisualizationPerformanceMilestone) {
    let milestones = this.performanceMilestonesBySource.get(sourceKey);
    if (!milestones) {
      milestones = new Set();
      this.performanceMilestonesBySource.set(sourceKey, milestones);
    }
    if (!milestones.has(milestone)) {
      milestones.add(milestone);
      visualizationPerformance.mark(milestone);
    }
  }

  private markShellRender() {
    try {
      const shell = this.resolveVisualizationShell();
      this.markVisualizationMilestone(this.getVisualizationSourceKey(shell), 'shell-render');
    } catch {
      // The visible configuration alert owns invalid-shell reporting.
    }
  }

  private updateVisualization(resetView: boolean, updateMetadata: boolean, animationFrame = false) {
    if (this.props.catalogValidationErrors.length > 0) {
      this.stopAnimationLoop();
      this.visualizationRequestCoordinator.invalidate();
      this.setState({
        runtimePhase: 'initial-error',
        visualizationRuntime: undefined,
        visualizationRuntimeSourceKey: undefined,
        visualizationError: this.props.catalogValidationErrors.join('\n'),
      });
      return;
    }

    let shell: ResolvedVisualizationShell;
    try {
      shell = this.resolveVisualizationShell();
    } catch (error: unknown) {
      this.stopAnimationLoop();
      this.visualizationRequestCoordinator.invalidate();
      const messageText = error instanceof Error ? error.message : String(error);
      this.setState({
        runtimePhase: 'initial-error',
        visualizationRuntime: undefined,
        visualizationRuntimeSourceKey: undefined,
        visualizationError: messageText,
      });
      return;
    }

    const sourceKey = this.getVisualizationSourceKey(shell);
    const requestParams = this.props.visualizationParams;
    const signature = this.createRuntimeSignature(shell, requestParams);
    const requestId = this.visualizationRequestCoordinator.begin(signature);
    if (requestId === undefined) {
      if (
        this.visualizationRequestCoordinator.isCommitted(signature) &&
        this.state.visualizationRuntime &&
        this.state.visualizationRuntimeSourceKey === sourceKey &&
        (this.state.runtimePhase !== 'ready' || this.state.visualizationError)
      ) {
        this.setState({ runtimePhase: 'ready', visualizationError: undefined });
      }
      return;
    }
    this.markVisualizationMilestone(sourceKey, 'runtime-start');

    const canPreserveRuntime =
      !resetView && Boolean(this.state.visualizationRuntime) && this.state.visualizationRuntimeSourceKey === sourceKey;
    if (!canPreserveRuntime) {
      this.stopAnimationLoop();
      this.props.onShadowSceneIdentityChange(undefined);
    }

    const loadingState: Pick<
      PanelMainState,
      'runtimePhase' | 'visualizationRuntime' | 'visualizationRuntimeSourceKey' | 'visualizationError'
    > &
      Partial<Pick<PanelMainState, 'viewState' | 'comparisonNavigationSnapshot'>> = {
      runtimePhase: canPreserveRuntime
        ? 'refreshing'
        : this.state.visualizationRuntime
          ? 'incompatible-loading'
          : 'initial-loading',
      visualizationRuntime: canPreserveRuntime ? this.state.visualizationRuntime : undefined,
      visualizationRuntimeSourceKey: canPreserveRuntime ? sourceKey : undefined,
      visualizationError: undefined,
    };
    if (resetView) {
      this.clearPlaybackTimers();
      this.releaseAnimationPlayback();
      this.clearCameraReturn();
      this.navigationSegments = undefined;
      const initialView = this.props.homeViews?.[sourceKey] ?? shell.initialViewState;
      this.cameraNavigation = createCameraNavigation(initialView);
      loadingState.viewState = _.cloneDeep(initialView);
      loadingState.comparisonNavigationSnapshot = undefined;
    }
    // Animation updates the existing scene continuously; keep its controls ready between frames.
    if (!animationFrame || !canPreserveRuntime) {
      this.setState(loadingState as Pick<PanelMainState, keyof typeof loadingState>);
    }

    resolveVisualizationRuntime(this.props.visualizationCatalog, this.props.activeVisualizationId, {
      params: requestParams,
      state: {
        animationTime: this.state.animationTime,
      },
      clickHandlers: {
        hexagonPosition: this.onHexagonLayerClick,
        lonLatFields: this.onScatterLayerClick,
        commutePath: this.onLineLayerClick,
        tripPath: this.onTripLayerClick,
      },
      viewportSize: this.props.viewportSize,
      datasetOverride: this.props.datasetOverride,
      manualParameterKeys: this.props.manualParameterKeys,
    })
      .then((runtime) => {
        const effectiveSignature = this.createRuntimeSignature(shell, runtime.effectiveParams);
        if (!this.visualizationRequestCoordinator.commit(requestId, effectiveSignature)) {
          return;
        }
        this.markVisualizationMilestone(sourceKey, 'runtime-commit');

        const nextState: Partial<PanelMainState> = {
          runtimePhase: 'ready',
          visualizationRuntime: runtime,
          visualizationRuntimeSourceKey: sourceKey,
          visualizationError: undefined,
        };

        {
          this.props.onShadowSceneIdentityChange({
            layers: runtime.resolvedLayers.map(({ descriptor }) => ({
              datasetId: descriptor.datasetId,
              visualizationId: descriptor.visualizationId,
              layerId: descriptor.layerId,
              dataRevision: descriptor.dataRevision,
              visualizationRevision: descriptor.visualizationRevision,
              resolvedLayerDigest: descriptor.resolvedLayerDigest,
            })),
          });
        }

        if (resetView) {
          const initialView = this.props.homeViews?.[sourceKey] ?? runtime.initialViewState;
          this.cameraNavigation = createCameraNavigation(initialView);
          nextState.viewState = _.cloneDeep(initialView);
          nextState.cameraNavigationMode = 'follow';
          nextState.cameraReturnProgress = 1;
          nextState.replayCamera = undefined;
          nextState.replayOffsetMs = undefined;
          nextState.playbackSplitPresentation = undefined;
          nextState.comparisonNavigationSnapshot = undefined;
        }

        this.setState(nextState as Pick<PanelMainState, keyof PanelMainState>, () => {
          this.markVisualizationMilestone(sourceKey, 'full-layer-render');
          // Echoing frame inputs can overwrite a newer user edit queued before this callback.
          if (!_.isEqual(runtime.effectiveParams, requestParams)) {
            this.props.onVisualizationParamsResolved(runtime.config.id, runtime.effectiveParams);
          }
          if (resetView) {
            this.syncCanvasViewState(this.state.viewState);
          }
          this.syncAnimationLoop(runtime);
        });

        if (updateMetadata) {
          this.props.onVisDataChange(runtime.primaryData);
          this.props.onVisDataNameChange(runtime.dataset.id);
          this.props.onVisDataTitleChange(runtime.dataset.title);
          this.props.onVisDataFileNameChange(runtime.primaryFile ? getFileName(runtime.primaryFile.url) : '');
        }
      })
      .catch((error: unknown) => {
        if (!this.visualizationRequestCoordinator.fail(requestId)) {
          return;
        }

        const messageText = error instanceof Error ? error.message : String(error);
        console.error('Visualization runtime failed:', error);
        this.markVisualizationMilestone(sourceKey, 'runtime-error');
        this.setState((state) => ({
          runtimePhase: state.visualizationRuntime ? 'refresh-error' : 'initial-error',
          visualizationError: messageText,
        }));
        if (!canPreserveRuntime) {
          this.props.onShadowSceneIdentityChange(undefined);
          this.stopAnimationLoop();
        }
      });
  }

  animate(timestamp: number) {
    if (!this.isAnimationEnabled()) {
      this.stopAnimationLoop();
      return;
    }

    const runtime = this.state.visualizationRuntime!;
    const { frameModulo, speedParam } = runtime.animation!;
    const configuredSpeed = speedParam
      ? (this.props.visualizationParams[speedParam] ??
        runtime.config.parameters?.find((parameter) => parameter.key === speedParam)?.default)
      : 1;
    const speed =
      typeof configuredSpeed === 'number' && Number.isFinite(configuredSpeed) && configuredSpeed > 0
        ? configuredSpeed
        : 1;
    const elapsedMs =
      this.lastAnimationTimestamp === undefined
        ? 0
        : Math.max(0, Math.min(timestamp - this.lastAnimationTimestamp, MAX_ANIMATION_FRAME_MS));
    this.lastAnimationTimestamp = timestamp;
    this.animationId = window.requestAnimationFrame(this.animate);
    if (elapsedMs > 0) {
      this.setState(({ animationTime }) => ({
        animationTime: (animationTime + (elapsedMs / 1000) * ANIMATION_UNITS_PER_SECOND * speed) % frameModulo,
      }));
    }
  }

  componentDidMount() {
    document.addEventListener('keydown', this.handleMapDrawingKeyDown);
    document.addEventListener('visibilitychange', this.handleAnimationVisibilityChange);
    if (typeof ResizeObserver !== 'undefined' && this.mapContainerRef.current) {
      this.mapResizeObserver = new ResizeObserver(this.measureMapViewportSize);
      this.mapResizeObserver.observe(this.mapContainerRef.current);
    }
    this.markShellRender();
    this.measureMapViewportSize();
    this.updateVisualization(true, true);
  }

  componentDidUpdate(prevProps: PanelMainProps, prevState: PanelMainState) {
    this.markShellRender();
    const visualizationChanged = this.props.activeVisualizationId !== prevProps.activeVisualizationId;
    const paramsChanged = !_.isEqual(this.props.visualizationParams, prevProps.visualizationParams);
    if (paramsChanged || this.state.mapDrawing !== prevState.mapDrawing) this.handleAnimationVisibilityChange();
    const manualParameterKeysChanged = !_.isEqual(this.props.manualParameterKeys, prevProps.manualParameterKeys);
    const datasetSourceChanged = this.props.datasetOverride?.revision !== prevProps.datasetOverride?.revision;
    const animationTimeChanged = this.state.animationTime !== prevState.animationTime;
    const viewportChanged = !_.isEqual(this.props.viewportSize, prevProps.viewportSize);
    const activeVisualization = this.props.visualizationCatalog.visualizations.find(
      (visualization) => visualization.id === this.props.activeVisualizationId,
    );
    const datasetChanged = activeVisualization
      ? getActiveDatasetId(activeVisualization, this.props.visualizationParams) !==
        getActiveDatasetId(activeVisualization, prevProps.visualizationParams)
      : false;

    const refreshMode = getVisualizationRefreshMode({
      hasVisualizationRuntime: Boolean(this.state.visualizationRuntime),
      visualizationChanged,
      datasetChanged,
      datasetSourceChanged,
      paramsChanged,
      manualParameterKeysChanged,
      viewportChanged,
      animationTimeChanged: false,
    });

    if (refreshMode === 'reset') {
      this.updateVisualization(true, true);
    } else if (refreshMode === 'refresh') {
      const animationFrame = animationTimeChanged && !paramsChanged && !manualParameterKeysChanged && !viewportChanged;
      this.updateVisualization(false, false, animationFrame);
    } else if (viewportChanged && !this.state.visualizationRuntime) {
      this.updateVisualization(true, true);
    }

    if (this.props.playbackPlanRevision !== prevProps.playbackPlanRevision) {
      this.clearPlaybackTimers();
      this.clearCameraReturn();
      if (!viewportChanged) {
        this.releaseAnimationPlayback();
        this.navigationSegments = undefined;
        this.cameraNavigation = createCameraNavigation(this.state.viewState);
      }
      this.setState((state) => ({
        ...state,
        ...(!viewportChanged
          ? {
              replayCamera: undefined,
              replayOffsetMs: undefined,
              comparisonNavigationSnapshot: undefined,
              ...this.navigationStatePatch(),
            }
          : {}),
        playbackSplitPresentation: viewportChanged
          ? state.playbackSplitPresentation
          : reconcileSplitPresentationForPlanRevision(
              state.playbackSplitPresentation,
              prevProps.playbackPlanRevision,
              this.props.playbackPlanRevision,
            ),
      }));
      if (viewportChanged) this.scheduleCameraReturn();
    }

    if (this.props.playbackRequest && this.props.playbackRequest.id !== prevProps.playbackRequest?.id) {
      this.handlePlaybackRequest(this.props.playbackRequest);
    }

    if (
      this.props.viewStateModalVisible &&
      (!prevProps.viewStateModalVisible || this.props.cameraViewStateEditIndex !== prevProps.cameraViewStateEditIndex)
    ) {
      this.editCameraViewState();
    }

    if (!this.props.viewStateModalVisible && prevProps.viewStateModalVisible) {
      this.latestEditCamera = undefined;
      this.setState({ viewStateDraft: undefined });
    }
  }

  componentWillUnmount() {
    document.removeEventListener('keydown', this.handleMapDrawingKeyDown);
    document.removeEventListener('visibilitychange', this.handleAnimationVisibilityChange);
    this.mapResizeObserver?.disconnect();
    this.visualizationRequestCoordinator.invalidate();
    this.clearPlaybackTimers();
    this.clearCameraReturn();
    this.stopAnimationLoop();
  }

  clearPlaybackTimers() {
    this.trajectoryPlaybackDriver?.cancel();
    this.trajectoryPlaybackDriver = undefined;
  }

  leavePlaybackForSelection() {
    this.clearPlaybackTimers();
    this.releaseAnimationPlayback();
    this.clearCameraReturn();
    this.navigationSegments = undefined;
    this.cameraNavigation = createCameraNavigation(stripCameraTransition(this.state.viewState));
    this.props.onPlaybackStop?.();
    this.setState({
      ...this.navigationStatePatch(),
      replayCamera: undefined,
      replayOffsetMs: undefined,
      playbackSplitPresentation: undefined,
      comparisonNavigationSnapshot: undefined,
    });
  }

  private locateSelectedObject = (target: CameraTarget) => {
    const fit = fitVisualTargetToView({
      target,
      baseView: this.state.viewState,
      viewportSize: this.props.viewportSize,
      paddingRatio: 0.2,
    });
    this.handleViewStateChange({
      viewState: { ...fit.view, transitionDuration: 0 },
      interactionState: { isPanning: true },
    });
  };

  private clearCameraReturn() {
    if (this.cameraReturnFrame !== undefined) window.cancelAnimationFrame(this.cameraReturnFrame);
    this.cameraReturnFrame = undefined;
  }

  private navigationStatePatch() {
    const navigation = this.cameraNavigation;
    const progress = navigation.transition
      ? navigation.transition.durationMs <= 0
        ? 1
        : Math.min(
            1,
            Math.max(0, (performance.now() - navigation.transition.startedAtMs) / navigation.transition.durationMs),
          )
      : navigation.mode === 'follow'
        ? 1
        : 0;
    return {
      viewState: navigation.view,
      cameraNavigationMode: navigation.mode,
      cameraReturnProgress: progress,
    };
  }

  private scheduleCameraReturn() {
    if (this.cameraNavigation.mode !== 'returning' || this.cameraReturnFrame !== undefined) return;
    this.cameraReturnFrame = window.requestAnimationFrame(() => {
      this.cameraReturnFrame = undefined;
      this.cameraNavigation = advanceCameraNavigation(this.cameraNavigation, performance.now());
      this.setState(this.navigationStatePatch());
      this.scheduleCameraReturn();
    });
  }

  handleCameraInteractionStateChange = (interactionState: Parameters<typeof isCameraNavigationGesture>[0]) => {
    if (!isCameraNavigationGesture(interactionState)) return;
    this.takeCameraOwnership();
  };

  private takeCameraOwnership = () => {
    this.clearCameraReturn();
    // Update ownership synchronously: a queued playback frame must not win over the first gesture.
    if (this.cameraNavigation.mode !== 'free') {
      const comparisonNavigationSnapshot = captureComparisonNavigationSnapshot(
        this.state.comparisonNavigationSnapshot,
        this.state.cameraNavigationMode,
        this.state.cameraReturnProgress,
      );
      this.cameraNavigation = takeCameraControl(this.cameraNavigation, this.state.viewState);
      this.setState({ ...this.navigationStatePatch(), comparisonNavigationSnapshot });
    }
  };

  private handleComparisonNavigationSnapshotChange = (snapshot: ComparisonNavigationSnapshot) => {
    if (this.props.comparisonPreview || snapshot.key !== `playback-${this.state.playbackSplitPresentation?.segmentId}`)
      return;
    this.setState({ comparisonNavigationSnapshot: snapshot });
  };

  handleResumeCameraFollow = () => {
    this.clearCameraReturn();
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.cameraNavigation = resumeCameraFollow(this.cameraNavigation, performance.now(), reducedMotion);
    // Split panes can be displaced even when the hidden main camera is already at its story view.
    if (!reducedMotion && this.state.playbackSplitPresentation && this.cameraNavigation.mode === 'follow') {
      this.cameraNavigation = {
        ...this.cameraNavigation,
        mode: 'returning',
        transition: { from: this.cameraNavigation.view, startedAtMs: performance.now(), durationMs: 600 },
      };
    }
    this.setState(this.navigationStatePatch());
    this.scheduleCameraReturn();
  };

  areCanvasViewsEqual(firstView: CameraView | undefined, secondView: CameraView | undefined) {
    if (!firstView || !secondView) {
      return false;
    }

    return (
      Math.abs(firstView.longitude - secondView.longitude) <= 1e-6 &&
      Math.abs(firstView.latitude - secondView.latitude) <= 1e-6 &&
      Math.abs(firstView.zoom - secondView.zoom) <= 1e-3 &&
      Math.abs(firstView.pitch - secondView.pitch) <= 1e-3 &&
      Math.abs(firstView.bearing - secondView.bearing) <= 1e-3
    );
  }

  syncCanvasViewState(viewState: CameraView) {
    const nextViewState = stripCameraTransition(viewState);
    if (this.areCanvasViewsEqual(this.lastSyncedCanvasViewState, nextViewState)) {
      return;
    }

    this.lastSyncedCanvasViewState = nextViewState;
    this.props.onCanvasViewStateUpdate(nextViewState);
  }

  getSplitPresentationAtTime(segments: PlaybackSegment[], timeMs: number): PlaybackSplitPresentation | undefined {
    const segment = getPlaybackPositionAtTime(segments, timeMs)?.segment;
    if (!segment || timeMs >= segment.end) return undefined;
    if (this.cachedSplitSegment !== segment) {
      this.cachedSplitSegment = segment;
      this.cachedSplitPresentation = getSplitPresentationAtPlaybackTime(segments, timeMs);
    }
    return this.cachedSplitPresentation;
  }

  handlePlaybackRequest(playbackRequest: PlaybackRequest) {
    this.clearPlaybackTimers();
    this.clearCameraReturn();
    try {
      this.validatePlaybackScene(playbackRequest.segments);
    } catch (error) {
      this.props.onPlaybackProgress?.(playbackRequest.startTimeMs, 'error');
      message.error(error instanceof Error ? error.message : String(error));
      return;
    }
    const sceneTime = getSceneTimeAtPlaybackTime(playbackRequest.segments, playbackRequest.startTimeMs);
    this.setAnimationPlaybackControl(Boolean(sceneTime));
    // A viewport resize recompiles trajectories without changing the authored story.
    const sameStory =
      this.navigationSegments === playbackRequest.segments ||
      (this.navigationSegments?.length === playbackRequest.segments.length &&
        playbackRequest.segments.every((segment, index) => {
          const previous = this.navigationSegments![index];
          return (
            segment.id === previous.id &&
            segment.start === previous.start &&
            segment.end === previous.end &&
            _.isEqual(segment.camera, previous.camera)
          );
        }));
    if (playbackRequest.mode === 'preview' || !sameStory) {
      this.cameraNavigation = createCameraNavigation(this.state.viewState);
      this.setState({ comparisonNavigationSnapshot: undefined });
    }
    this.navigationSegments = playbackRequest.segments;

    if (playbackRequest.mode === 'stop') {
      const segments = playbackRequest.segments;
      // Pause, seek and preview share the exact requested timeline position.
      const stopTimeMs = playbackRequest.startTimeMs;
      const splitTimeMs = stopTimeMs;
      const stoppedView = segments.length
        ? getStoppedPlaybackView(segments, stopTimeMs, this.state.viewState)
        : this.state.viewState;
      this.cameraNavigation = segments.length
        ? updateStoryView(this.cameraNavigation, stoppedView, performance.now())
        : createCameraNavigation(stoppedView);
      this.setState({
        sceneTime,
        ...this.navigationStatePatch(),
        replayCamera: playbackRequest.segments.length
          ? getPlaybackPositionAtTime(segments, splitTimeMs)?.segment.camera
          : undefined,
        replayOffsetMs: getPlaybackPositionAtTime(segments, splitTimeMs)?.offsetMs,
        playbackSplitPresentation: this.getSplitPresentationAtTime(segments, splitTimeMs),
      });
      this.scheduleCameraReturn();
      this.props.onPlaybackProgress?.(stopTimeMs, 'paused');
      return;
    }

    if (playbackRequest.mode === 'preview') {
      const viewState = getViewAtPlaybackTime(playbackRequest.segments, playbackRequest.startTimeMs);
      const playbackSplitPresentation = this.getSplitPresentationAtTime(
        playbackRequest.segments,
        playbackRequest.startTimeMs,
      );
      if (viewState) {
        this.cameraNavigation = updateStoryView(this.cameraNavigation, viewState, performance.now());
        this.setState({
          sceneTime,
          ...this.navigationStatePatch(),
          playbackSplitPresentation,
          replayCamera: getPlaybackPositionAtTime(playbackRequest.segments, playbackRequest.startTimeMs)?.segment
            .camera,
          replayOffsetMs: getPlaybackPositionAtTime(playbackRequest.segments, playbackRequest.startTimeMs)?.offsetMs,
        });
      } else {
        this.setState({ sceneTime, replayCamera: undefined, replayOffsetMs: undefined, playbackSplitPresentation });
      }
      this.props.onPlaybackProgress?.(playbackRequest.startTimeMs, 'paused');
      return;
    }

    {
      const totalTimeMs = playbackRequest.segments[playbackRequest.segments.length - 1]?.end ?? 0;
      if (playbackRequest.segments.length === 0) {
        this.cameraNavigation = createCameraNavigation(this.state.viewState);
        this.setState({
          sceneTime: undefined,
          ...this.navigationStatePatch(),
          replayCamera: undefined,
          replayOffsetMs: undefined,
          playbackSplitPresentation: undefined,
          comparisonNavigationSnapshot: undefined,
        });
        return;
      }
      this.trajectoryPlaybackDriver = startTrajectoryPlaybackDriver({
        segments: playbackRequest.segments,
        startTimeMs: playbackRequest.startTimeMs,
        totalTimeMs,
        now: () => performance.now(),
        requestFrame: (callback) => window.requestAnimationFrame(callback),
        cancelFrame: (id) => window.cancelAnimationFrame(id),
        onFrame: (timeMs, viewState) => {
          this.cameraNavigation = updateStoryView(this.cameraNavigation, viewState, performance.now());
          this.setState({
            sceneTime: getSceneTimeAtPlaybackTime(playbackRequest.segments, timeMs),
            ...this.navigationStatePatch(),
            replayCamera: getPlaybackPositionAtTime(playbackRequest.segments, timeMs)?.segment.camera,
            replayOffsetMs: getPlaybackPositionAtTime(playbackRequest.segments, timeMs)?.offsetMs,
            playbackSplitPresentation: this.getSplitPresentationAtTime(playbackRequest.segments, timeMs),
          });
          this.props.onPlaybackProgress?.(timeMs, 'playing');
        },
        onComplete: () => {
          this.trajectoryPlaybackDriver = undefined;
          this.props.onPlaybackProgress?.(totalTimeMs, 'complete');
        },
        onError: (error) => {
          this.trajectoryPlaybackDriver = undefined;
          this.props.onPlaybackProgress?.(playbackRequest.startTimeMs, 'error');
          console.error('Trajectory playback failed:', error);
          message.error('The camera could not be played. Open Edit View State and save changes before trying again.');
        },
      });
      this.trajectoryPlaybackDriver.setSuspended(
        this.state.mapDrawing || (typeof document !== 'undefined' && document.hidden),
      );
      this.scheduleCameraReturn();
      return;
    }
  }

  private getSceneHomeView() {
    try {
      return this.props.homeViews?.[this.getVisualizationSourceKey(this.resolveVisualizationShell())];
    } catch {
      return undefined;
    }
  }

  handleCameraResetButtonClick() {
    this.props.onPlaybackStop?.();
    this.releaseAnimationPlayback();
    if (this.props.comparisonPreview) this.props.onComparisonPreviewExit?.();
    let initView = this.props.viewState;
    try {
      const shell = this.resolveVisualizationShell();
      const sourceKey = this.getVisualizationSourceKey(shell);
      const runtime =
        this.state.visualizationRuntimeSourceKey === sourceKey ? this.state.visualizationRuntime : undefined;
      const systemView = runtime?.initialViewState ?? shell.initialViewState;
      initView = this.props.homeViews?.[sourceKey] ?? systemView;
    } catch {
      // Invalid configurations retain the current view until a valid scene loads.
    }
    const newView: CameraView = _.cloneDeep(initView);

    newView['transitionDuration'] = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 500;
    newView.transitionInterpolator = new FlyToInterpolator();

    this.clearPlaybackTimers();
    this.clearCameraReturn();
    this.navigationSegments = undefined;
    this.cameraNavigation = createCameraNavigation(newView);
    this.setState(
      {
        ...this.navigationStatePatch(),
        viewState: newView,
        mapDrawing: false,
        replayCamera: undefined,
        replayOffsetMs: undefined,
        playbackSplitPresentation: undefined,
        comparisonNavigationSnapshot: undefined,
      },
      () => {
        this.syncCanvasViewState(newView);
      },
    );
  }

  handleMapSelectionButtonClick() {
    if (this.state.mapDrawing) {
      this.handleCancelSelectionButtonClick();
      return;
    }
    if (this.animationPlaybackControlled) {
      this.clearCameraReturn();
      this.trajectoryPlaybackDriver?.setSuspended(true);
    } else {
      this.leavePlaybackForSelection();
    }
    if (this.props.comparisonPreview) this.props.onComparisonPreviewExit?.();
    this.setState({ mapDrawing: true }, this.handleAnimationVisibilityChange);
  }

  handleCancelSelectionButtonClick() {
    this.setState({ mapDrawing: false }, this.handleAnimationVisibilityChange);
  }

  private handleSaveHomeView = () => {
    if (this.props.comparisonPreview || this.state.playbackSplitPresentation || this.state.mapDrawing) return;
    try {
      const sourceKey = this.getVisualizationSourceKey(this.resolveVisualizationShell());
      if (
        !this.state.visualizationRuntime ||
        this.state.visualizationRuntimeSourceKey !== sourceKey ||
        !this.props.onHomeViewChange
      )
        return;
      this.props.onHomeViewChange(sourceKey, copyHomeView(this.state.viewState));
      message.success('Home view saved. Use Return to home view to come back.');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Could not save the home view.');
    }
  };

  handleViewStateChange({
    viewState,
    interactionState,
  }: {
    viewState: unknown;
    interactionState?: Record<string, unknown>;
  }) {
    const isGesture = isCameraNavigationGesture(interactionState);
    // Ignore stale controller inertia once the user explicitly resumes the story.
    if (this.state.replayCamera && !isGesture && this.cameraNavigation.mode !== 'free') return;
    if (isGesture) this.takeCameraOwnership();
    let constraints = this.state.visualizationRuntime?.cameraConstraints;
    if (!constraints) {
      try {
        constraints = this.resolveVisualizationShell().cameraConstraints;
      } catch {
        constraints = undefined;
      }
    }
    constraints = includeHomeViewInConstraints(constraints, this.getSceneHomeView());
    if (this.state.replayCamera) constraints = { minZoom: -2, maxZoom: 24, minPitch: 0, maxPitch: 85 };
    const nextViewState = constraints
      ? applyVisualizationCameraConstraints(viewState as CameraView, constraints)
      : (viewState as CameraView);
    this.cameraNavigation =
      this.cameraNavigation.mode === 'free'
        ? takeCameraControl(this.cameraNavigation, nextViewState)
        : createCameraNavigation(nextViewState);
    this.setState(this.navigationStatePatch());

    if (!interactionState?.inTransition) {
      this.syncCanvasViewState(nextViewState);
    }
  }

  handleDeckLoad() {
    try {
      const shell = this.resolveVisualizationShell();
      this.markVisualizationMilestone(this.getVisualizationSourceKey(shell), 'map-load');
    } catch {
      // Invalid shells do not mount DeckGL, so this is only a defensive fallback.
    }
    this.measureMapViewportSize();
  }

  handleInitialViewStateChange({ viewState }: { viewState: unknown }) {
    if (!this.state.viewStateDraft) {
      return;
    }

    this.setState({
      viewStateDraft: updateDraftView(this.state.viewStateDraft, 'initial', viewState as CameraView),
    });
  }

  handleFinalViewStateChange({ viewState }: { viewState: unknown }) {
    if (!this.state.viewStateDraft) {
      return;
    }

    this.setState({
      viewStateDraft: updateDraftView(this.state.viewStateDraft, 'final', viewState as CameraView),
    });
  }

  handleMapDrawingKeyDown(e: KeyboardEvent) {
    if (e.code === 'Escape' && this.state.mapDrawing) {
      this.handleCancelSelectionButtonClick();
    }
  }

  handleHeatmapMapClick(info: PickingInfo<CustomObject>) {
    if (info.object || !info.coordinate) return false;
    const runtime = this.state.visualizationRuntime;
    if (!runtime || this.state.runtimePhase !== 'ready') return false;
    const heatmapLayers = runtime.resolvedLayers.filter(
      (layer) =>
        layer.descriptor.resolvedSupport.producer === 'heatmap-kernel' &&
        layer.descriptor.selection?.supported.includes('map-click'),
    );
    if (!heatmapLayers.length) return false;
    if (heatmapLayers.length !== 1) {
      message.warning('Select a single heatmap layer before choosing a zone.');
      return false;
    }
    const coordinate: [number, number] = [Number(info.coordinate[0]), Number(info.coordinate[1])];
    const viewport = getPlaybackViewportLayout(
      this.state.replayCamera,
      this.props.viewportSize ?? { width: 800, height: 600 },
    ).viewport;
    const captured = captureHeatmapTarget(undefined, heatmapLayers[0], coordinate, this.state.viewState, viewport);
    if (captured.status !== 'ok') {
      message.warning(captured.reason);
      return false;
    }
    const target = captured.value;
    this.props.onTargetChange(target);
    message.info({
      key: 'message-heatmap-zone',
      duration: 4,
      content: `Selected heatmap zone: [${round(coordinate[0])}, ${round(coordinate[1])}], ${
        target.selectedRows?.length ?? 0
      } rows included.`,
      icon: <InfoCircleTwoTone className="relative -top-0.5!" />,
    });
    return true;
  }

  handleDeckClick(info: PickingInfo) {
    if (!this.state.mapDrawing) this.handleHeatmapMapClick(info);
  }

  onHexagonLayerClick(info: PickingInfo<CustomObject>) {
    if (this.state.mapDrawing) {
      return false;
    }

    const object = info.object;
    if (!object) {
      return false;
    }

    const analytics = this.state.visualizationRuntime?.analytics;
    const clickedCoordinate = Array.isArray(info.coordinate)
      ? [Number(info.coordinate[0]), Number(info.coordinate[1])]
      : undefined;
    const coordinate = getHexagonPickedCoordinate(object, analytics, clickedCoordinate);

    if (!coordinate) {
      return false;
    }

    const latitude = coordinate[1];
    const longitude = coordinate[0];
    // GPU-aggregated picks expose no source rows and may carry a garbage position on the object
    // itself; out-of-bounds rows must not leak into the target's visual frame.
    const selectedRows = filterRowsInsideAnalyticsBounds(getPickedObjectRows(object), analytics);
    const target = enrichCameraTargetStats(createPointTarget([Number(longitude), Number(latitude)], selectedRows), {
      analytics,
      pickedObject: object,
    });
    const runtime = this.state.visualizationRuntime;
    const resolved = runtime?.resolvedLayers.find(
      (item) => item.descriptor.resolvedSupport.producer === 'hexagon-cell',
    );
    const captured = resolved ? captureHexagonTarget(target, resolved, info.layer ?? {}, [object]) : undefined;
    if (captured?.status !== 'ok') {
      message.warning(captured?.reason ?? 'Wait for the rendered columns to finish loading, then select again.');
      return false;
    }
    this.props.onTargetChange(captured.value);
    message.info({
      key: 'message-location',
      duration: 4,
      content: `New location selected: [${round(captured.value.center[0])}, ${round(captured.value.center[1])}]. Please select a narrative purpose or a specific camera shot on the left.`,
      icon: <InfoCircleTwoTone className="relative" />,
    });
    return true;
  }

  onScatterLayerClick({ object }: PickingInfo<CustomObject>) {
    if (this.state.mapDrawing) {
      return false;
    }

    if (!object) {
      return false;
    }

    const coordinate = getRowLngLat(object);
    if (!coordinate) {
      return false;
    }
    const latitude = coordinate[1];
    const longitude = coordinate[0];
    const target = enrichCameraTargetStats(createPointTarget([Number(longitude), Number(latitude)], [object]), {
      analytics: this.state.visualizationRuntime?.analytics,
      pickedObject: object,
    });
    this.props.onTargetChange(this.attachShadowEnvelope(target, 'scatter-point', 'click', [object]));
    message.info({
      key: 'message-location',
      duration: 4,
      content: `New location selected: [${longitude}, ${latitude}]. Please select a narrative purpose or a specific camera shot on the left.`,
      icon: <InfoCircleTwoTone className="relative" />,
    });
    return true;
  }

  onLineLayerClick({ object }: PickingInfo<CustomObject>) {
    if (this.state.mapDrawing) {
      return false;
    }

    if (!object) {
      return false;
    }

    const target = createPathTarget([getLineSource(object), getLineTarget(object)], [object]);
    if (!target) {
      return false;
    }

    const enrichedTarget = enrichCameraTargetStats(target, {
      analytics: this.state.visualizationRuntime?.analytics,
      pickedObject: object,
    });
    this.props.onTargetChange(this.attachShadowEnvelope(enrichedTarget, 'line-path', 'click', [object]));
    message.info({
      key: 'message-path',
      duration: 4,
      content: `Selected path center: [${round(target.center[0])}, ${round(target.center[1])}]. Tracking camera movements are now available.`,
      icon: <InfoCircleTwoTone className="relative -top-0.5!" />,
    });
    return true;
  }

  onTripLayerClick({ object }: PickingInfo<CustomObject>) {
    if (this.state.mapDrawing) {
      return false;
    }

    if (!object) {
      return false;
    }

    const timedPath = getTripTimedPath(object);
    const target: CameraTarget | undefined = createPathTarget(
      timedPath?.coordinates ?? getTripPathCoordinates(object),
      [object],
    );
    if (!target) {
      return false;
    }
    target.timedPath = timedPath;
    if (!timedPath)
      message.info('This path has no valid timestamps. Tracking will follow its geometry without animation sync.');
    const enrichedTarget = enrichCameraTargetStats(target, {
      analytics: this.state.visualizationRuntime?.analytics,
      pickedObject: object,
    });
    this.props.onTargetChange(this.attachShadowEnvelope(enrichedTarget, 'trip-path', 'click', [object]));
    message.info({
      key: 'message-path',
      duration: 4,
      content: `Selected trip path center: [${round(target.center[0])}, ${round(target.center[1])}]. Tracking camera movements are now available.`,
      icon: <InfoCircleTwoTone className="relative -top-0.5!" />,
    });
    return true;
  }

  handleMapFeatureDrawn(feature: MapDrawingFeature | undefined) {
    if (feature != null) {
      if (this.animationPlaybackControlled) this.leavePlaybackForSelection();
      const polygonCoordinates = feature.geometry.coordinates[0] ?? [];
      const regionRuntime = this.state.visualizationRuntime?.resolvedLayers.find((runtime) =>
        runtime.descriptor.selection?.supported.includes('region'),
      );
      const selectedRows = resolveCurrentTargetRows(
        createRegionTarget(polygonCoordinates),
        regionRuntime?.data ?? this.props.visData,
        regionRuntime,
      );
      const target = enrichCameraTargetStats(createRegionTarget(polygonCoordinates, selectedRows), {
        analytics: this.state.visualizationRuntime?.analytics,
      });
      const longitude = round(target.center[0]);
      const latitude = round(target.center[1]);
      const producer = regionRuntime?.descriptor.resolvedSupport.producer;
      if (producer === 'hexagon-cell' && regionRuntime) {
        const renderedLayer = this.state.visualizationRuntime?.layers.find(
          (item) => item.id === regionRuntime.descriptor.layerId,
        );
        const captured = captureCurrentHexagonTarget(target, regionRuntime, renderedLayer ?? {});
        if (captured.status !== 'ok') {
          message.warning(captured.reason);
          this.setState({ mapDrawing: false });
          return;
        }
        this.props.onTargetChange(captured.value);
      } else {
        this.props.onTargetChange(
          producer ? this.attachShadowEnvelope(target, producer, 'region', target.selectedRows ?? []) : target,
        );
      }

      message.info({
        key: 'message-location',
        duration: 4,
        content: `Selected region center: [${longitude}, ${latitude}], ${selectedRows.length} rows included. Please select a [Narrative Purpose] on the left.`,
        icon: <InfoCircleTwoTone className="relative -top-0.5!" />,
      });
    }
    this.setState({ mapDrawing: false });

    // if (this.deckRef.current && this.deckRef.current.deck) {
    //     this.deckRef.current.deck._lastPointerDownInfo = null;
    // }
  }

  editCameraViewState() {
    const editCamera = this.props.editingCameraMovement;

    if (!editCamera) {
      this.latestEditCamera = undefined;
      this.setState({ viewStateDraft: undefined });
      return;
    }

    this.latestEditCamera = _.cloneDeep(editCamera);
    this.setState({
      viewStateDraft: createDraft(editCamera),
    });
  }

  handleEditInitialViewStateResetButtonClick() {
    if (!this.state.viewStateDraft) {
      return;
    }

    message.info('Reset the initial view state to the origin state');
    this.setState({ viewStateDraft: resetDraftView(this.state.viewStateDraft, 'initial') });
  }

  handleEditFinalViewStateResetButtonClick() {
    if (!this.state.viewStateDraft) {
      return;
    }

    message.info('Reset the final view state to the origin state');
    this.setState({ viewStateDraft: resetDraftView(this.state.viewStateDraft, 'final') });
  }

  handleSaveViewStateChanges = () => {
    const draft = this.state.viewStateDraft;
    const camera = this.latestEditCamera ?? this.props.editingCameraMovement;
    const index = this.props.cameraViewStateEditIndex;
    if (!camera || !draft || index < 0) return;
    if (this.props.onCameraMovementUpdate(index, applyDraftToCamera(camera, draft, 'both'))) {
    }
  };

  render() {
    const { mapDrawing, visualizationError, runtimePhase } = this.state;
    const { visTitle } = this.props;
    let shell: ResolvedVisualizationShell | undefined;
    let shellError: string | undefined;
    try {
      shell = this.resolveVisualizationShell();
    } catch (error: unknown) {
      shellError = error instanceof Error ? error.message : String(error);
    }
    const shellSourceKey = shell ? this.getVisualizationSourceKey(shell) : undefined;
    const visualizationRuntime =
      shellSourceKey && this.state.visualizationRuntimeSourceKey === shellSourceKey
        ? this.state.visualizationRuntime
        : undefined;
    const mapStyle = shell?.mapStyle;
    const runtimeLayerPolicy = getRuntimeLayerPolicy(runtimePhase);
    const selectedLineIds = (this.props.selectionTargets ?? [])
      .filter((target) => target.sourceDatasetId === 'bart-ridership')
      .flatMap((target) => target.selectedRows ?? [])
      .map((row) => String(row.id));
    const layers =
      runtimeLayerPolicy === 'empty'
        ? []
        : (visualizationRuntime?.createLayers({
            selectedLineIds,
            animationTime: this.state.sceneTime?.time ?? this.state.animationTime,
          }) ?? []);
    const deckEffects = visualizationRuntime?.effects ?? [];
    const pickingRadius = visualizationRuntime?.pickingRadius ?? 0;
    const deckTooltip = visualizationRuntime?.getTooltip;
    const sceneHomeView = shellSourceKey ? this.props.homeViews?.[shellSourceKey] : undefined;
    const cameraConstraints = includeHomeViewInConstraints(
      visualizationRuntime?.cameraConstraints ?? shell?.cameraConstraints,
      sceneHomeView,
    );
    const renderedViewState =
      !this.state.replayCamera && cameraConstraints
        ? applyVisualizationCameraConstraints(this.state.viewState, cameraConstraints)
        : this.state.viewState;
    const titleText = getOptionalPanelText(visualizationRuntime?.dataset.title ?? shell?.dataset.title ?? visTitle);
    const visibleAnnotationText = getCameraAnnotationAtTime(this.state.replayCamera, this.state.replayOffsetMs ?? 0);
    const runtimeStatusText = getRuntimeStatusText(runtimePhase);
    const visibleError = visualizationError ?? shellError;
    const replayLayout = getPlaybackViewportLayout(
      this.state.replayCamera,
      this.props.viewportSize ?? { width: 800, height: 600 },
    );
    const splitPresentation = this.props.comparisonPreview
      ? { key: 'authoring', targets: this.props.comparisonPreview.targets, interactive: true }
      : this.state.playbackSplitPresentation
        ? {
            key: `playback-${this.state.playbackSplitPresentation.segmentId}`,
            targets: this.state.playbackSplitPresentation.targets,
            interactive: true,
          }
        : undefined;
    const showObjectSelection =
      this.props.objectSelectionVisible && !mapDrawing && !this.state.replayCamera && !splitPresentation;

    return (
      <div
        id="map"
        ref={this.mapContainerRef}
        className={[
          'h-full w-full p-2',
          this.state.replayCamera && !this.props.comparisonPreview && 'map-has-playback',
          (this.props.viewportSize?.width ?? 800) <= 620 && 'map-compact',
          (this.props.viewportSize?.width ?? 800) <= 380 && 'map-narrow',
        ]
          .filter(Boolean)
          .join(' ')}>
        <Card
          className="h-full w-full"
          styles={{
            body: { position: 'relative', height: '100%', padding: 0, overflow: 'hidden', background: '#111827' },
          }}>
          {visibleError && (
            <Alert
              className="absolute! top-4 left-4 z-10 max-w-xl"
              type="error"
              message="Visualization configuration unavailable"
              description={visibleError}
              showIcon={true}
            />
          )}
          <div
            style={{
              position: 'absolute',
              left: replayLayout.left,
              top: replayLayout.top,
              width: replayLayout.viewport.width,
              height: replayLayout.viewport.height,
              transform: `scale(${replayLayout.scale})`,
              transformOrigin: 'top left',
            }}>
            {shell && (
              <DeckGL
                layers={layers}
                getCursor={({ isDragging }) => (isDragging ? 'grabbing' : mapDrawing ? 'crosshair' : 'grab')}
                effects={deckEffects}
                viewState={renderedViewState}
                onViewStateChange={this.handleViewStateChange}
                onInteractionStateChange={this.handleCameraInteractionStateChange}
                controller={mapDrawing ? false : { doubleClickZoom: false }}
                _pickable={!mapDrawing}
                pickingRadius={pickingRadius}
                onClick={this.handleDeckClick}
                getTooltip={mapDrawing ? undefined : deckTooltip}
                onLoad={this.handleDeckLoad}>
                <Map
                  reuseMaps={true}
                  mapStyle={mapStyle}
                  {...(this.state.replayCamera
                    ? { minZoom: -2, maxZoom: 24, minPitch: 0, maxPitch: 85 }
                    : cameraConstraints)}
                />
              </DeckGL>
            )}
            {mapDrawing && (
              <MapDrawingEditor
                viewState={renderedViewState}
                viewportSize={replayLayout.viewport}
                onFeatureDrawn={this.handleMapFeatureDrawn}
              />
            )}
            {visualizationRuntime && (
              <ComparisonSplitView
                runtime={visualizationRuntime}
                animationTime={this.state.sceneTime?.time ?? this.state.animationTime}
                presentationKey={splitPresentation?.key}
                targets={splitPresentation?.targets}
                baseView={
                  this.props.comparisonPreview
                    ? this.state.viewState
                    : (this.cameraNavigation.storyView ?? this.state.viewState)
                }
                viewportSize={replayLayout.viewport}
                interactive={splitPresentation?.interactive}
                onExit={this.props.comparisonPreview ? this.props.onComparisonPreviewExit : undefined}
                navigation={
                  this.props.comparisonPreview
                    ? undefined
                    : {
                        mode: this.state.cameraNavigationMode,
                        returnProgress: this.state.cameraReturnProgress,
                      }
                }
                onNavigationStart={this.props.comparisonPreview ? undefined : this.takeCameraOwnership}
                navigationSnapshot={this.props.comparisonPreview ? undefined : this.state.comparisonNavigationSnapshot}
                onNavigationSnapshotChange={
                  this.props.comparisonPreview ? undefined : this.handleComparisonNavigationSnapshotChange
                }
              />
            )}
          </div>
          {this.state.replayCamera && !this.props.comparisonPreview && (
            <div className="map-camera-navigation" data-mode={this.state.cameraNavigationMode}>
              <Tooltip
                title={
                  this.state.cameraNavigationMode === 'follow'
                    ? 'Drag, scroll or rotate to explore. Playback keeps running.'
                    : 'Your view is independent of playback. Resume follow returns to the current story camera.'
                }>
                <span className="map-camera-status" role="status" aria-live="polite">
                  <span className="map-camera-status-dot" aria-hidden="true" />
                  {this.state.cameraNavigationMode === 'follow'
                    ? 'Following camera'
                    : this.state.cameraNavigationMode === 'returning'
                      ? 'Returning…'
                      : 'Free view'}
                </span>
              </Tooltip>
              {this.state.cameraNavigationMode === 'free' ? (
                <button
                  type="button"
                  className="map-camera-resume"
                  aria-label="Resume camera follow"
                  onClick={this.handleResumeCameraFollow}>
                  Resume follow
                </button>
              ) : this.state.cameraNavigationMode === 'follow' ? (
                <span className="map-camera-hint">Drag to explore</span>
              ) : null}
            </div>
          )}
          <div className="map-tools" data-tour="map-tools">
            <Space direction="vertical" size={2}>
              <Tooltip title="Return to home view" placement="left">
                <Button
                  size="large"
                  className="rounded-none! border-0! bg-slate-800/75! hover:bg-slate-800!"
                  icon={<ReloadOutlined className="text-2xl! text-white/75! hover:text-white!" />}
                  aria-label="Return to home view"
                  disabled={!visualizationRuntime}
                  onClick={this.handleCameraResetButtonClick}
                />
              </Tooltip>
              <Tooltip
                title={
                  splitPresentation
                    ? 'Exit split view to save a home view'
                    : mapDrawing
                      ? 'Finish drawing to save a home view'
                      : 'Save as home view'
                }
                placement="left">
                <span>
                  <Button
                    size="large"
                    className="rounded-none! border-0! bg-slate-800/75! hover:bg-slate-800!"
                    icon={<CameraOutlined className="text-2xl! text-white/75! hover:text-white!" />}
                    aria-label="Save as home view"
                    data-home-saved={Boolean(sceneHomeView)}
                    disabled={!visualizationRuntime || Boolean(splitPresentation) || mapDrawing}
                    onClick={this.handleSaveHomeView}
                  />
                </span>
              </Tooltip>
              <Tooltip title="Select by drawing a polygon" placement="left">
                <Button
                  size="large"
                  className="rounded-none! border-0! bg-slate-800/75! hover:bg-slate-800!"
                  aria-label="Select by drawing a polygon"
                  aria-pressed={mapDrawing}
                  icon={<GatewayOutlined className="text-2xl! text-white/75! hover:text-white!" />}
                  onClick={this.handleMapSelectionButtonClick}
                />
              </Tooltip>
              <Tooltip title="Delete polygon(s)" placement="left">
                <Button
                  size="large"
                  className="rounded-none! border-0! bg-slate-800/75! hover:bg-slate-800!"
                  icon={<CloseOutlined className="text-2xl! text-white/75! hover:text-white!" />}
                  onClick={this.handleCancelSelectionButtonClick}
                />
              </Tooltip>
            </Space>
          </div>
          {runtimeStatusText ? (
            <div className="map-runtime-status" data-testid="map-runtime-status" role="status" aria-live="polite">
              {runtimeStatusText}
            </div>
          ) : null}
          {titleText ? (
            <VisualizationTitle
              key={shellSourceKey}
              title={titleText}
              datasetId={visualizationRuntime?.dataset.id ?? shell?.dataset.id}
              visualizationId={shell?.config.id}
            />
          ) : null}
          <div
            className="map-bottom-overlays"
            style={{
              left: replayLayout.left + (showObjectSelection ? 8 : 16),
              bottom: replayLayout.top + (showObjectSelection ? 8 : 24),
              maxWidth: showObjectSelection ? 'calc(100% - 16px)' : Math.max(0, replayLayout.width - 32),
            }}>
            {visibleAnnotationText ? (
              <Paragraph
                id="annotation"
                style={{
                  maxWidth: Math.min(replayLayout.width - 32, Math.max(240, replayLayout.width * 0.45)),
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                }}
                className="map-annotation bg-slate-800/75 px-2 py-1 text-white!">
                {visibleAnnotationText}
              </Paragraph>
            ) : null}
            {showObjectSelection && (
              <SelectionObjectBar
                targets={(this.props.selectionTargets ?? []).slice(-2)}
                onLocate={this.locateSelectedObject}
                onRemove={this.props.onSelectionRemove}
                onClear={this.props.onSelectionClear}
              />
            )}
          </div>
        </Card>
        <ViewStateEditorModal
          open={this.props.viewStateModalVisible}
          draft={this.state.viewStateDraft}
          runtime={visualizationRuntime}
          viewportSize={this.props.editingCameraMovement?.authoring?.planningViewport ?? this.props.viewportSize}
          canSave={Boolean(this.state.viewStateDraft && this.props.editingCameraMovement)}
          onCancel={() => {
            this.props.onViewStateModalVisibleChange(false);
          }}
          onInitialViewStateChange={this.handleInitialViewStateChange}
          onFinalViewStateChange={this.handleFinalViewStateChange}
          onInitialReset={this.handleEditInitialViewStateResetButtonClick}
          onFinalReset={this.handleEditFinalViewStateResetButtonClick}
          onSave={this.handleSaveViewStateChanges}
        />
      </div>
    );
  }
}

export default PanelMain;
