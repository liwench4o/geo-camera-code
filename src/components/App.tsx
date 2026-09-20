import 'antd/dist/reset.css';
import '../css/App.css';

import React from 'react';
import { ConfigProvider, Layout, Row, Col, Typography, Space, Modal, Table, Button, Tour, message } from 'antd';
import type { ThemeConfig, TourProps } from 'antd';
import { Resizable, type ResizeCallbackData } from 'react-resizable';
import PanelLibrary from './PanelLibrary';
import PanelMain from './PanelMain';
import PanelConfig, { type PanelConfigProps } from './PanelConfig';
import PanelTimeline from './PanelTimeline';
import { BsCameraReelsFill } from 'react-icons/bs';
import type {
  CameraMovement,
  CameraView,
  HomeViews,
  CustomObject,
  PlaybackRequest,
  PlaybackSegment,
  TargetCameras,
  TimelineEdit,
} from '../interfaces';
import _ from 'lodash';
import { GEO_TYPE_NONE } from '../constant';
import { getProgressElements } from '../util';
import type { IMultiProgressProps } from 'react-multi-progress';
import { QuestionCircleOutlined } from '@ant-design/icons';
import { createCameraBaseViewMode, createCameraMovement } from '../camera/planner';
import {
  getCameraOptionSelectionById,
  isTargetRequired,
  isTargetTypeAllowed,
  resolveCameraRecipe,
} from '../camera/recipes';
import {
  appendUniqueTargetHistory,
  createMultipleTarget,
  createTargetFromView,
  getLatestComparisonPair,
  isCameraTarget,
  normalizeCameraTarget,
} from '../camera/selection';
import type {
  CameraSelectionRequest,
  CameraTarget,
  NarrativePurpose,
  ViewportSize,
  CameraFramingTuning,
} from '../camera/types';
import type { CameraAuthoringSpec } from '../camera/authoring-types';
import {
  getCameraAuthoringSpec,
  prepareCameraAuthoring,
  preserveCameraMetadata,
  getCameraValidationMessages,
  normalizeCameraAuthoringView,
} from '../camera/authoring';
import { applyCameraCandidate } from './cameraCandidateModel';
import { digestCanonical } from '../camera/geometry/canonical-digest';
import { trajectoryV2Enabled } from '../camera/trajectory';
import { validateCommittedTrajectoryPlanForMovement } from '../camera/trajectory/validation';
import type { ShadowSceneIdentity } from '../camera/types';
import { visualizationCatalog, visualizationCatalogValidationErrors } from '../visualization/catalog';
import {
  createUploadedDatasetOverride,
  isLatestUploadedDatasetRevision,
  updateUploadedDatasetOverrides,
  getActiveDatasetId,
} from '../visualization/registry';
import {
  applyResolvedVisualizationParams,
  getManualVisualizationParameterKeys,
  updateManualVisualizationParameterKey,
  type ManualVisualizationParameterKeysById,
} from '../visualization/parameter-state';
import type {
  UploadedDatasetOverrides,
  VisualizationParameterValues,
  VisualizationParametersById,
} from '../visualization/types';
import {
  completeCurrentCameraPreviewSession,
  createCurrentCameraPreviewSegments,
  createCurrentCameraPreviewResetSegments,
  pauseCurrentCameraPreviewSession,
  resetCurrentCameraPreviewSession,
  startCurrentCameraPreviewSession,
  type CurrentCameraPreviewSession,
} from '../story/current-camera-preview';
import { derivePlaybackPlan, getSourceIndexAtTime } from '../story/playback';
import { getTimelineIndicesForSourceIndex, getTimelineMainContentHeightStyle } from '../story/timeline-layout';
import { applyTimelineResizeEdit } from '../story/timeline-edits';
import { createInitialAppVisualizationState } from './appInitialization';
import { copyHomeView, copyHomeViews } from '../story/home-view';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

const tutorialConfigTabs: Record<number, PanelConfigProps['tutorialTab']> = {
  4: 'vis-config',
  5: 'camera-config',
  6: 'annotation-config',
};

const squareCornerTheme: ThemeConfig = {
  token: {
    borderRadius: 0,
    borderRadiusXS: 0,
    borderRadiusSM: 0,
    borderRadiusLG: 0,
    borderRadiusOuter: 0,
  },
};
let playbackRequestId = 0;
let cameraIdentity = 0;

function arePlanningViewsEqual(firstView: CameraView | undefined, secondView: CameraView | undefined) {
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

function createPlaybackRequest(
  mode: PlaybackRequest['mode'],
  segments: PlaybackSegment[],
  startTimeMs: number,
): PlaybackRequest {
  return {
    id: ++playbackRequestId,
    mode,
    segments,
    startTimeMs,
  };
}

export interface AppProps {
  name?: string;
}

export interface AppState {
  cameraCandidate?: {
    camera: CameraMovement;
    spec: CameraAuthoringSpec;
    action: 'add' | 'replace';
    index: number;
    selectedCameraId: string | null;
    error?: string;
    returnPresentation?: ReturnType<PanelMain['capturePresentation']>;
  };
  cameraUndo?: {
    cameras: CameraMovement[];
    selectedCameraId: string | null;
    presentation?: ReturnType<PanelMain['capturePresentation']>;
  };
  cameraRequestError?: string;
  selectedCameraId: string | null;
  cameraPlayIndex: number;
  libraryCategory: string;
  sceneRevision?: string;
  siderWidth: number;
  panelTimelineHeight: number;
  panelConfigWidth: number;
  dataModalVisible: boolean;
  tutorialOpen: boolean;
  tutorialStep: number;
  visDatasetName: string;
  visDatasetTitle: string;
  visDatasetFileName: string;
  targetLocation: number[]; // TODO: change to [number, number] interface
  targetGeoType: string;
  allTargetLocations: number[][]; // TODO: get multiple selections
  selectedTarget?: CameraTarget;
  selectedTargets: CameraTarget[];
  comparisonPreview?: { targets: [CameraTarget, CameraTarget] };
  currentViewState: CameraView;
  homeViews: HomeViews;
  currentCameraName: string;
  cameraMovementFullList: CameraMovement[];
  playbackSegments: PlaybackSegment[];
  playbackPlanRevision: number;
  playbackRequest?: PlaybackRequest;
  currentCameraPreview?: CurrentCameraPreviewSession;
  cameraListIndex: number;
  activeVisualizationId: string;
  visualizationParams: VisualizationParametersById;
  manualVisualizationParameterKeys: ManualVisualizationParameterKeysById;
  uploadedDatasetOverrides: UploadedDatasetOverrides;
  visData: CustomObject[];
  viewStateModalVisible: boolean;
  cameraViewStateEditIndex: number;
  timelineTargetCameraData: TargetCameras[];
  totalTimeLength: number;
  isPlaying: boolean;
  timelineCurrentTimeMs: number;
  animationPlaybackControlled: boolean;
  timelineTargetIndex: number;
  timelineCameraIndex: number;
  timelineExpandedKeys: string[];
  progressElements: IMultiProgressProps<object>['elements'];
  mapViewportSize?: ViewportSize;
}

class App extends React.Component<AppProps, AppState> {
  private panelMainRef = React.createRef<PanelMain>();
  private libraryTourRef = React.createRef<HTMLDivElement>();
  private mapTourRef = React.createRef<HTMLDivElement>();
  private configTourRef = React.createRef<HTMLDivElement>();
  private timelineTourRef = React.createRef<HTMLDivElement>();
  private datasetUploadRevision = 0;
  private playbackTimeMs = 0;

  private handleShadowSceneIdentityChange(scene: ShadowSceneIdentity | undefined) {
    const sceneRevision = scene ? digestCanonical(scene) : undefined;
    if (sceneRevision !== this.state.sceneRevision) this.setState({ sceneRevision });
  }

  constructor(props: AppProps) {
    super(props);
    this.onSiderResize = this.onSiderResize.bind(this);
    this.onPanelConfigResize = this.onPanelConfigResize.bind(this);
    this.onPanelTimelineResize = this.onPanelTimelineResize.bind(this);
    this.handleDataModalVisibleChange = this.handleDataModalVisibleChange.bind(this);
    this.handleVisDataChange = this.handleVisDataChange.bind(this);
    this.handleVisDatasetNameChange = this.handleVisDatasetNameChange.bind(this);
    this.handleVisDatasetTitleChange = this.handleVisDatasetTitleChange.bind(this);
    this.handleVisDataFileNameChange = this.handleVisDataFileNameChange.bind(this);
    this.handleCameraLibraryCategoryClick = this.handleCameraLibraryCategoryClick.bind(this);
    this.handleCameraLibraryItemChange = this.handleCameraLibraryItemChange.bind(this);
    this.handleCanvasViewStateUpdate = this.handleCanvasViewStateUpdate.bind(this);
    this.handleTargetChange = this.handleTargetChange.bind(this);
    this.handleComparisonPreviewExit = this.handleComparisonPreviewExit.bind(this);
    this.handleTargetLocationChange = this.handleTargetLocationChange.bind(this);
    this.handleTargetGeoTypeChange = this.handleTargetGeoTypeChange.bind(this);
    this.handleVisSelectChange = this.handleVisSelectChange.bind(this);
    this.handleVisualizationParameterChange = this.handleVisualizationParameterChange.bind(this);
    this.handleVisualizationParameterAutoReset = this.handleVisualizationParameterAutoReset.bind(this);
    this.handleResolvedVisualizationParams = this.handleResolvedVisualizationParams.bind(this);
    this.handleExampleDatasetSelect = this.handleExampleDatasetSelect.bind(this);
    this.handleDatasetUpload = this.handleDatasetUpload.bind(this);
    this.handleCameraListItemDelete = this.handleCameraListItemDelete.bind(this);
    this.handleCameraListItemPlay = this.handleCameraListItemPlay.bind(this);
    this.handleCameraListItemReset = this.handleCameraListItemReset.bind(this);
    this.handleCameraItemViewStateEdit = this.handleCameraItemViewStateEdit.bind(this);
    this.handleViewStateModalVisibleChange = this.handleViewStateModalVisibleChange.bind(this);
    this.handleCameraMovementUpdate = this.handleCameraMovementUpdate.bind(this);
    this.handleTimelinePlay = this.handleTimelinePlay.bind(this);
    this.handleTimelinePause = this.handleTimelinePause.bind(this);
    this.handleTimelineSeek = this.handleTimelineSeek.bind(this);
    this.handleTimelineEdit = this.handleTimelineEdit.bind(this);
    this.handlePlayIndexChange = this.handlePlayIndexChange.bind(this);
    this.handlePlayingStatusChange = this.handlePlayingStatusChange.bind(this);
    this.handleTimelineTargetIndexChange = this.handleTimelineTargetIndexChange.bind(this);
    this.handleTimelineCameraIndexChange = this.handleTimelineCameraIndexChange.bind(this);
    this.handleTimelineExpandedKeyChange = this.handleTimelineExpandedKeyChange.bind(this);
    this.handleCameraMovementListChange = this.handleCameraMovementListChange.bind(this);
    this.handleConfigCameraItemIndexChange = this.handleConfigCameraItemIndexChange.bind(this);
    this.handleMapViewportSizeChange = this.handleMapViewportSizeChange.bind(this);
    this.handleShadowSceneIdentityChange = this.handleShadowSceneIdentityChange.bind(this);

    const initialVisualizationState = createInitialAppVisualizationState(visualizationCatalog);
    this.state = {
      siderWidth: 300,
      panelTimelineHeight: 300,
      panelConfigWidth: 330,
      dataModalVisible: false,
      tutorialOpen: false,
      tutorialStep: 0,
      visDatasetName: initialVisualizationState.visDatasetName,
      visDatasetTitle: initialVisualizationState.visDatasetTitle,
      visDatasetFileName: initialVisualizationState.visDatasetFileName,
      targetLocation: [],
      targetGeoType: GEO_TYPE_NONE,
      allTargetLocations: [],
      selectedTargets: [],
      currentViewState: initialVisualizationState.currentViewState,
      homeViews: {},
      currentCameraName: '',
      cameraMovementFullList: [],
      playbackSegments: [],
      playbackPlanRevision: 0,
      cameraListIndex: -1,
      selectedCameraId: null,
      cameraPlayIndex: -1,
      libraryCategory: 'none',
      activeVisualizationId: initialVisualizationState.activeVisualizationId,
      visualizationParams: initialVisualizationState.visualizationParams,
      manualVisualizationParameterKeys: {},
      uploadedDatasetOverrides: {},
      visData: [],
      viewStateModalVisible: false,
      cameraViewStateEditIndex: -1,
      timelineTargetCameraData: [],
      totalTimeLength: 0,
      isPlaying: false,
      timelineCurrentTimeMs: 0,
      animationPlaybackControlled: false,
      timelineTargetIndex: -1,
      timelineCameraIndex: -1,
      timelineExpandedKeys: [],
      progressElements: [],
      mapViewportSize: undefined,
    };
  }

  private getCurrentCameraPreviewCancellation(): {
    currentCameraPreview: undefined;
    playbackRequest?: PlaybackRequest;
  } {
    const session = this.state.currentCameraPreview;

    if (!session) {
      return { currentCameraPreview: undefined };
    }

    const currentTimeMs = this.playbackTimeMs;
    return {
      currentCameraPreview: undefined,
      ...(session.isPlaying ? { playbackRequest: createPlaybackRequest('stop', session.segments, currentTimeMs) } : {}),
    };
  }

  onSiderResize(_event: React.SyntheticEvent, { size }: ResizeCallbackData) {
    this.setState({ siderWidth: size.width });
  }

  onPanelConfigResize(_event: React.SyntheticEvent, { size }: ResizeCallbackData) {
    this.setState({ panelConfigWidth: size.width });
  }

  onPanelTimelineResize(_event: React.SyntheticEvent, { size }: ResizeCallbackData) {
    this.setState({ panelTimelineHeight: size.height });
  }

  handleDataModalVisibleChange(visible: boolean) {
    this.setState({ dataModalVisible: visible });
  }

  handleVisDataChange(data: CustomObject[]) {
    const editedData = data.map((object, objectIndex) => ({ ...object, key: objectIndex }));
    this.setState({ visData: editedData });
  }

  handleVisDatasetNameChange(name: string) {
    this.setState({ visDatasetName: name });
  }

  handleVisDatasetTitleChange(title: string) {
    this.setState({ visDatasetTitle: title });
  }

  handleMapViewportSizeChange(size: ViewportSize) {
    const currentSize = this.state.mapViewportSize;
    if (currentSize?.width === size.width && currentSize.height === size.height) {
      return;
    }

    if (trajectoryV2Enabled) {
      const playbackPlan = derivePlaybackPlan(this.state.cameraMovementFullList, {
        trajectoryEnabled: trajectoryV2Enabled,
        viewport: size,
      });
      const timelineTargetCameraData = playbackPlan.timelineData;
      const totalTimeLength = playbackPlan.totalTime;
      this.setState((state) => ({
        mapViewportSize: size,
        playbackSegments: playbackPlan.segments,
        playbackPlanRevision: state.playbackPlanRevision + 1,
        timelineTargetCameraData,
        totalTimeLength,
        timelineCurrentTimeMs: Math.min(state.timelineCurrentTimeMs, totalTimeLength),
        progressElements: getProgressElements(totalTimeLength, timelineTargetCameraData),
        timelineExpandedKeys: timelineTargetCameraData.map((target) => target.key),
        currentCameraPreview: undefined,
        isPlaying: false,
      }));
      return;
    }

    this.setState({ mapViewportSize: size });
  }

  updateCameraMovementState(cameraMovementList: CameraMovement[], selectedId = this.state.selectedCameraId) {
    const ids = new Set<string>();
    // The new plan revision cancels playback; a stop request for the obsolete preview
    // would restore its camera and annotation after PanelMain clears the old presentation.
    const nextCameraMovementList = _.cloneDeep(cameraMovementList).map((camera) => {
      // Legacy imports may not have an ID. Assign it once, then keep selection tied to that identity.
      if (!camera.id || ids.has(camera.id)) camera.id = `camera-${Date.now()}-${++cameraIdentity}`;
      ids.add(camera.id);
      const plan = camera.trajectoryPlan;
      if (!plan) return camera;
      const movementValidation = validateCommittedTrajectoryPlanForMovement(plan, camera);
      if (movementValidation.status !== 'ok')
        throw new Error('The camera changes need to be applied as a complete trajectory.');
      return camera;
    });
    const playbackPlan = derivePlaybackPlan(nextCameraMovementList, {
      trajectoryEnabled: trajectoryV2Enabled,
      viewport: this.state.mapViewportSize,
    });
    const timelineTargetCameraData = playbackPlan.timelineData;
    const totalTimeLength = playbackPlan.totalTime;
    const progressElements = getProgressElements(totalTimeLength, timelineTargetCameraData);
    const timelineExpandedKeys = timelineTargetCameraData.map((target) => target.key);
    const selectedCameraIndex = selectedId
      ? nextCameraMovementList.findIndex((camera) => camera.id === selectedId)
      : -1;
    const selectedCameraId = nextCameraMovementList[selectedCameraIndex]?.id ?? null;
    const { timelineTargetIndex, timelineCameraIndex } = getTimelineIndicesForSourceIndex(
      timelineTargetCameraData,
      selectedCameraIndex,
    );

    this.setState((state) => ({
      currentCameraPreview: undefined,
      cameraMovementFullList: nextCameraMovementList,
      playbackSegments: playbackPlan.segments,
      playbackPlanRevision: state.playbackPlanRevision + 1,
      totalTimeLength,
      timelineCurrentTimeMs: Math.min(state.timelineCurrentTimeMs, totalTimeLength),
      timelineTargetCameraData,
      progressElements,
      timelineExpandedKeys,
      cameraListIndex: selectedCameraIndex,
      selectedCameraId,
      cameraPlayIndex: Math.min(state.cameraPlayIndex, nextCameraMovementList.length - 1),
      timelineTargetIndex,
      timelineCameraIndex,
      currentCameraName: nextCameraMovementList[selectedCameraIndex]?.name ?? '',
      isPlaying: false,
      cameraCandidate: undefined,
      cameraUndo: undefined,
      cameraRequestError: undefined,
    }));
  }

  getComparisonPair() {
    return getLatestComparisonPair(this.state.selectedTargets);
  }

  getTargetForPurpose(purpose: NarrativePurpose) {
    const { selectedTarget, currentViewState } = this.state;

    if (purpose === 'dynamic') {
      return createTargetFromView(currentViewState, 'none');
    }

    if (purpose === 'comparison') {
      const pair = this.getComparisonPair();
      return pair ? createMultipleTarget(pair) : undefined;
    }

    // A visible place or previous selection is not a target selected for this shot.
    return selectedTarget ? normalizeCameraTarget(selectedTarget) : createTargetFromView(currentViewState, 'none');
  }

  getComparisonTargets(purpose: NarrativePurpose) {
    return purpose === 'comparison' ? this.getComparisonPair() : undefined;
  }

  handleCameraLibraryCategoryClick(categoryName: string) {
    this.cancelAuthoringDraft();
    this.setState({ libraryCategory: categoryName });
  }

  private resolveNewSuggestionTarget(target: CameraTarget): CameraTarget {
    if (target.children?.length)
      return {
        ...createMultipleTarget(target.children.map((child) => this.resolveNewSuggestionTarget(child))),
        id: target.id,
      };
    if (target.sourceLayerId && this.panelMainRef.current)
      return this.panelMainRef.current.resolveTargetSnapshot(target);
    return target;
  }

  handleComparisonPreviewExit() {
    this.setState({ comparisonPreview: undefined });
  }

  handleCameraLibraryItemChange(request: CameraSelectionRequest) {
    const { cameraMovementFullList, selectedCameraId } = this.state;
    const index = selectedCameraId ? cameraMovementFullList.findIndex((camera) => camera.id === selectedCameraId) : -1;
    const action = index >= 0 ? 'replace' : 'add';
    const savedCamera = cameraMovementFullList[index];
    const pending = this.state.cameraCandidate;
    const sameContext = pending?.selectedCameraId === selectedCameraId && pending.action === action;
    const sameDraft = sameContext && pending.camera.name === request.cameraName;
    const currentCamera = sameDraft ? pending.camera : savedCamera;
    const returnPresentation =
      (sameContext ? pending.returnPresentation : undefined) ?? this.panelMainRef.current?.capturePresentation();
    const recipe = resolveCameraRecipe(request.cameraName, request.optionSelection);
    const preservedWithoutTarget =
      savedCamera?.name === request.cameraName &&
      recipe.requiresTarget &&
      (!isCameraTarget(savedCamera.targetSnapshot) || savedCamera.targetSnapshot.type === 'none');
    const ignoresSelectedTarget =
      recipe.purpose === 'dynamic' ||
      (recipe.purpose === 'basic' && !recipe.requiresTarget) ||
      (recipe.targetTypes.length === 1 && recipe.targetTypes[0] === 'none');
    const target = ignoresSelectedTarget
      ? createTargetFromView(
          currentCamera?.recommendationBaseViewState ?? returnPresentation?.viewState ?? this.state.currentViewState,
          'none',
        )
      : preservedWithoutTarget
        ? createTargetFromView(savedCamera.initViewState, 'none')
        : action === 'replace' && isCameraTarget(savedCamera?.targetSnapshot)
          ? normalizeCameraTarget(savedCamera.targetSnapshot)
          : recipe.requiresComparison
            ? this.getTargetForPurpose(recipe.purpose)
            : (this.state.selectedTarget ?? this.getTargetForPurpose(recipe.purpose));
    try {
      if (!target)
        throw new Error(
          recipe.requiresComparison ? 'Select two different targets on the map.' : 'Select a target on the map.',
        );
      if (isTargetRequired(request.cameraName) && target.type === 'none' && !preservedWithoutTarget)
        throw new Error('Select a target on the map.');
      if (!isTargetTypeAllowed(request.cameraName, target.type) && !preservedWithoutTarget)
        throw new Error('This shot is unavailable for this target.');
      const latestTarget = this.resolveNewSuggestionTarget(target);
      const spec = currentCamera
        ? prepareCameraAuthoring(
            { ...currentCamera, authoring: sameDraft ? pending.spec : currentCamera.authoring },
            {
              mode: 'replace',
              recipeId: request.cameraName,
              optionSelection: request.optionSelection,
              viewport: this.state.mapViewportSize,
            },
          )
        : undefined;
      if (preservedWithoutTarget && (!spec?.manualViews?.initial || !spec.manualViews.final))
        throw new Error('Select a geographic target before returning this shot to Auto.');
      if (spec) {
        if (request.resetAdjustments) {
          spec.adjustments = {};
          if (spec.timing) {
            delete spec.timing.duration;
            // Split presets own the complete display time. An old extra hold
            // must not survive an explicit selection of Short/Medium/Long.
            if (recipe.presentation === 'split') delete spec.timing.stay;
          }
        }
        spec.sceneRevision = this.state.sceneRevision;
        spec.snapshotRevision = latestTarget.snapshotEnvelope?.revision;
      }
      const previousCamera = cameraMovementFullList[action === 'add' ? cameraMovementFullList.length - 1 : index - 1];
      let camera = createCameraMovement({
        cameraName: request.cameraName,
        authoring: spec,
        currentViewState:
          currentCamera?.recommendationBaseViewState ?? returnPresentation?.viewState ?? this.state.currentViewState,
        previousCamera,
        baseViewMode: currentCamera ? 'current-view' : createCameraBaseViewMode(recipe, previousCamera),
        target: latestTarget,
        comparisonTargets: latestTarget.children,
        optionSelection: request.optionSelection,
        viewportSize: this.state.mapViewportSize,
      }).cameraMovement;
      if (savedCamera) camera = preserveCameraMetadata(savedCamera, camera);
      const authoring = getCameraAuthoringSpec(camera, this.state.mapViewportSize);
      authoring.sceneRevision = this.state.sceneRevision;
      this.panelMainRef.current?.pausePresentation();
      this.setState({
        ...this.getCurrentCameraPreviewCancellation(),
        cameraCandidate: {
          camera: { ...camera, authoring },
          spec: authoring,
          action,
          index,
          selectedCameraId,
          returnPresentation,
        },
        cameraRequestError: undefined,
        isPlaying: false,
      });
    } catch (error) {
      if (returnPresentation) this.panelMainRef.current?.restorePresentation(returnPresentation);
      this.setState({
        cameraCandidate: undefined,
        cameraRequestError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  handleCanvasViewStateUpdate(viewState: CameraView) {
    if (arePlanningViewsEqual(this.state.currentViewState, viewState)) {
      return;
    }

    this.setState({ currentViewState: viewState });
  }

  handleHomeViewChange = (sceneKey: string, view?: CameraView) => {
    const home = view ? copyHomeView(view) : undefined;
    this.setState((state) => {
      const homeViews = { ...state.homeViews };
      if (home) homeViews[sceneKey] = home;
      else delete homeViews[sceneKey];
      return { homeViews };
    });
  };

  handleStoryImport = (cameras: CameraMovement[], homes?: HomeViews) => {
    const homeViews = copyHomeViews(homes ?? {});
    this.handleCameraMovementListChange(cameras);
    this.setState({ homeViews, comparisonPreview: undefined });
  };

  handleTargetChange(target: CameraTarget) {
    this.clearCameraSelection();
    this.panelMainRef.current?.leavePlaybackForSelection?.();
    this.setState((state) => ({
      selectedTarget: target,
      selectedTargets:
        target.type === 'none' ? state.selectedTargets : appendUniqueTargetHistory(state.selectedTargets, target, 2),
      comparisonPreview: undefined,
      targetLocation: target.center,
      targetGeoType: target.type === 'none' ? GEO_TYPE_NONE : target.type,
      allTargetLocations: [...state.allTargetLocations, target.center],
      timelineTargetIndex: -1,
      timelineCameraIndex: -1,
    }));
  }

  handleSelectionRemove = (id: string) => {
    this.clearCameraSelection();
    this.setState((state) => {
      const selectedTargets = state.selectedTargets.slice(-2).filter((target) => target.id !== id);
      const selectedTarget = selectedTargets[selectedTargets.length - 1];
      return {
        selectedTargets,
        selectedTarget,
        comparisonPreview: undefined,
        targetLocation: selectedTarget?.center ?? state.targetLocation,
        targetGeoType: selectedTarget?.type ?? GEO_TYPE_NONE,
      };
    });
  };

  handleSelectionClear = () => {
    this.clearCameraSelection();
    this.setState({
      selectedTargets: [],
      selectedTarget: undefined,
      comparisonPreview: undefined,
      targetGeoType: GEO_TYPE_NONE,
    });
  };

  handleTargetLocationChange(location: number[]) {
    const allLocations = this.state.allTargetLocations;
    allLocations.push(location);

    this.setState({
      targetLocation: location,
      allTargetLocations: allLocations,
      timelineTargetIndex: -1,
      timelineCameraIndex: -1,
    });
  }

  handleTargetGeoTypeChange(type: string) {
    this.setState({ targetGeoType: type });
  }

  handleVisSelectChange(visualizationId: string) {
    if (visualizationId !== this.state.activeVisualizationId) this.handleSelectionClear();
    this.setState({ activeVisualizationId: visualizationId });
  }

  handleVisualizationParameterChange(params: VisualizationParameterValues, changedKey?: string) {
    const activeVisualizationId = this.state.activeVisualizationId;
    const config = visualizationCatalog.visualizations.find((item) => item.id === activeVisualizationId);
    if (
      config &&
      getActiveDatasetId(config, params) !==
        getActiveDatasetId(config, this.state.visualizationParams[activeVisualizationId] ?? {})
    ) {
      this.handleSelectionClear();
    }
    this.setState((state) => ({
      visualizationParams: {
        ...state.visualizationParams,
        [activeVisualizationId]: params,
      },
      manualVisualizationParameterKeys: changedKey
        ? updateManualVisualizationParameterKey(
            state.manualVisualizationParameterKeys,
            activeVisualizationId,
            changedKey,
            true,
          )
        : state.manualVisualizationParameterKeys,
    }));
  }

  handleVisualizationParameterAutoReset(parameterKey: string) {
    const activeVisualizationId = this.state.activeVisualizationId;
    this.setState((state) => ({
      manualVisualizationParameterKeys: updateManualVisualizationParameterKey(
        state.manualVisualizationParameterKeys,
        activeVisualizationId,
        parameterKey,
        false,
      ),
    }));
  }

  handleResolvedVisualizationParams(visualizationId: string, effectiveParams: VisualizationParameterValues) {
    this.setState((state) => {
      const visualizationParams = applyResolvedVisualizationParams(
        state.visualizationParams,
        visualizationId,
        effectiveParams,
      );
      return visualizationParams === state.visualizationParams ? null : { visualizationParams };
    });
  }

  handleExampleDatasetSelect(params: VisualizationParameterValues) {
    const activeVisualizationId = this.state.activeVisualizationId;
    this.datasetUploadRevision += 1;
    this.handleSelectionClear();
    this.setState((state) => ({
      visualizationParams: {
        ...state.visualizationParams,
        [activeVisualizationId]: params,
      },
      uploadedDatasetOverrides: updateUploadedDatasetOverrides(
        state.uploadedDatasetOverrides,
        activeVisualizationId,
        undefined,
      ),
    }));
  }

  async handleDatasetUpload(file: File) {
    const visualizationId = this.state.activeVisualizationId;
    const params = this.state.visualizationParams[visualizationId] ?? {};
    const revision = ++this.datasetUploadRevision;
    const override = await createUploadedDatasetOverride(visualizationCatalog, visualizationId, params, file, revision);

    if (!isLatestUploadedDatasetRevision(this.datasetUploadRevision, override)) {
      return undefined;
    }

    this.handleSelectionClear();

    await new Promise<void>((resolve) => {
      this.setState(
        (state) => ({
          uploadedDatasetOverrides: updateUploadedDatasetOverrides(
            state.uploadedDatasetOverrides,
            visualizationId,
            override,
          ),
        }),
        resolve,
      );
    });
    return override;
  }

  handleVisDataFileNameChange(name: string) {
    this.setState({ visDatasetFileName: name });
  }

  handleConfigCameraItemIndexChange(index: number) {
    const camera = this.state.cameraMovementFullList[index];
    const selectedCameraId = camera?.id ?? null;
    if (selectedCameraId === this.state.selectedCameraId && !this.panelMainRef.current?.state?.replayCamera) return;
    this.cancelAuthoringDraft();
    this.panelMainRef.current?.leavePlaybackForSelection?.();
    this.setState({
      // The canvas already stopped its driver. Reissuing a stop request for
      // the old preview here would restore that shot after this batched update.
      currentCameraPreview: undefined,
      isPlaying: false,
      selectedCameraId,
      cameraListIndex: camera ? index : -1,
      currentCameraName: camera?.name ?? '',
      libraryCategory: camera?.category ?? this.state.libraryCategory,
      ...getTimelineIndicesForSourceIndex(this.state.timelineTargetCameraData, camera ? index : -1),
    });
  }

  private clearCameraSelection = () => {
    this.cancelAuthoringDraft();
    this.setState({
      selectedCameraId: null,
      cameraListIndex: -1,
      currentCameraName: '',
      timelineTargetIndex: -1,
      timelineCameraIndex: -1,
    });
  };

  handleCameraListItemDelete(index: number) {
    if (index >= 0 && this.state.cameraMovementFullList[index]) {
      this.cancelAuthoringDraft();
      const cameraList = [...this.state.cameraMovementFullList];
      cameraList.splice(index, 1);
      this.updateCameraMovementState(cameraList);
    }
  }

  handleCameraListItemPlay(cameraIndex: number) {
    const cameraItem = this.state.cameraMovementFullList[cameraIndex];
    if (!cameraItem) {
      return;
    }

    const currentSession = this.state.currentCameraPreview;
    if (currentSession?.cameraIndex === cameraIndex && currentSession.isPlaying) {
      const pausedSession = pauseCurrentCameraPreviewSession(currentSession, this.playbackTimeMs);
      this.setState({
        currentCameraPreview: pausedSession,
        playbackRequest: createPlaybackRequest('stop', pausedSession.segments, pausedSession.currentTimeMs),
      });
      return;
    }

    const canResume =
      currentSession?.cameraIndex === cameraIndex &&
      !currentSession.isPlaying &&
      currentSession.currentTimeMs < currentSession.totalTimeMs;
    // A paused preview is still the same session, including its manually explored camera.
    // Shot edits and viewport changes already invalidate currentCameraPreview.
    const previewSegments = canResume
      ? currentSession.segments
      : createCurrentCameraPreviewSegments(
          derivePlaybackPlan([cameraItem], {
            trajectoryEnabled: trajectoryV2Enabled,
            viewport: this.state.mapViewportSize,
          }).segments,
        );
    const previewSession = startCurrentCameraPreviewSession({
      cameraIndex,
      segments: previewSegments,
      previousSession: currentSession,
    });
    const playbackMode = previewSession.isPlaying ? 'play' : 'preview';

    this.playbackTimeMs = previewSession.currentTimeMs;
    this.setState({
      currentCameraPreview: previewSession,
      comparisonPreview: undefined,
      playbackRequest: createPlaybackRequest(playbackMode, previewSession.segments, previewSession.currentTimeMs),
      isPlaying: false,
    });
  }

  handleCameraListItemReset(cameraIndex: number) {
    const cameraItem = this.state.cameraMovementFullList[cameraIndex];
    if (!cameraItem) {
      return;
    }

    const playbackPlan = derivePlaybackPlan([cameraItem], {
      trajectoryEnabled: trajectoryV2Enabled,
      viewport: this.state.mapViewportSize,
    });
    const previewSegments = createCurrentCameraPreviewSegments(playbackPlan.segments);
    const previewSession = resetCurrentCameraPreviewSession(
      startCurrentCameraPreviewSession({
        cameraIndex,
        segments: previewSegments,
      }),
    );

    this.playbackTimeMs = 0;
    this.setState({
      currentCameraPreview: previewSession,
      comparisonPreview: undefined,
      playbackRequest: createPlaybackRequest(
        'preview',
        createCurrentCameraPreviewResetSegments(previewSession.segments),
        0,
      ),
      isPlaying: false,
    });
  }

  handleCameraItemViewStateEdit(index: number) {
    if (!this.state.cameraMovementFullList[index]) {
      return;
    }

    this.cancelAuthoringDraft();
    this.setState({
      ...this.getCurrentCameraPreviewCancellation(),
      cameraViewStateEditIndex: index,
      viewStateModalVisible: true,
      cameraRequestError: undefined,
    });
  }

  handleViewStateModalVisibleChange(isVisible: boolean) {
    this.setState({
      viewStateModalVisible: isVisible,
      cameraViewStateEditIndex: isVisible ? this.state.cameraViewStateEditIndex : -1,
    });
  }

  handleCameraMovementUpdate(index: number, camera: CameraMovement) {
    const errors = getCameraValidationMessages(camera);
    if (errors.length) {
      message.error(errors.join(' '));
      return false;
    }
    const current = this.state.cameraMovementFullList[index];
    if (!current || (camera.id && current.id !== camera.id)) return false;
    const spec = getCameraAuthoringSpec(camera, this.state.mapViewportSize);
    for (const field of ['duration', 'stay', 'startDelay'] as const) {
      if (camera[field] !== current[field]) spec.timing = { ...spec.timing, [field]: camera[field] ?? 0 };
    }
    const needsPlan =
      !camera.trajectoryPlan ||
      camera.duration !== current.duration ||
      !arePlanningViewsEqual(camera.initViewState, current.initViewState) ||
      !arePlanningViewsEqual(camera.finalViewState, current.finalViewState);
    try {
      const target =
        needsPlan && isCameraTarget(camera.targetSnapshot)
          ? this.resolveNewSuggestionTarget(camera.targetSnapshot)
          : undefined;
      const next = needsPlan ? this.generateFromAuthoring(camera, spec, target) : { ...camera, authoring: spec };
      const cameraList = [...this.state.cameraMovementFullList];
      cameraList[index] = next;
      const undo = this.captureCameraUndo();
      this.updateCameraMovementState(cameraList);
      this.setState({ cameraUndo: undo, viewStateModalVisible: false, cameraViewStateEditIndex: -1 });
      this.showCameraSaved(
        undo,
        next.framingReport?.status === 'warning' ? 'Saved. Part of the target is outside the frame.' : 'Camera saved.',
      );
      return true;
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private generateFromAuthoring(camera: CameraMovement, spec: CameraAuthoringSpec, targetOverride?: CameraTarget) {
    const target = targetOverride ?? (isCameraTarget(camera.targetSnapshot) ? camera.targetSnapshot : undefined);
    const generated = createCameraMovement({
      cameraName: spec.recipeId,
      authoring: spec,
      currentViewState: camera.recommendationBaseViewState ?? camera.initViewState,
      baseViewMode: 'current-view',
      target,
      comparisonTargets: target?.children ?? (camera.comparisonTargetSnapshots ?? []).filter(isCameraTarget),
      optionSelection:
        spec.optionSelection ??
        (camera.recommendation?.optionId
          ? getCameraOptionSelectionById(spec.recipeId, camera.recommendation.optionId)
          : undefined),
      framingTuning: spec.adjustments,
      viewportSize: spec.planningViewport,
    }).cameraMovement;
    return preserveCameraMetadata({ ...camera, authoring: spec }, generated);
  }

  private captureCameraUndo(
    presentation = this.panelMainRef.current?.capturePresentation(),
  ): NonNullable<AppState['cameraUndo']> {
    return {
      cameras: _.cloneDeep(this.state.cameraMovementFullList),
      selectedCameraId: this.state.selectedCameraId,
      presentation,
    };
  }

  private showCameraSaved(undo: NonNullable<AppState['cameraUndo']>, text: string) {
    message.success({
      key: 'camera-save',
      content: (
        <span>
          {text}{' '}
          <Button
            type="link"
            size="small"
            onClick={() => {
              if (this.state.cameraUndo === undo) this.undoAuthoringChange();
            }}>
            Undo
          </Button>
        </span>
      ),
      duration: 6,
    });
  }

  private updateAuthoringDraft = (patch: Partial<CameraFramingTuning>) => {
    const draft = this.state.cameraCandidate;
    if (!draft) return;
    const spec = _.cloneDeep(draft.spec);
    spec.adjustments = { ...spec.adjustments, ...patch };
    if (patch.speedScale !== undefined && spec.timing) delete spec.timing.duration;
    this.refreshCameraCandidate({ ...draft, spec });
  };

  private updateAuthoringIntent = (spec: CameraAuthoringSpec) => {
    const draft = this.state.cameraCandidate;
    if (!draft || spec.recipeId !== draft.spec.recipeId || spec.targetId !== draft.spec.targetId) return;
    this.refreshCameraCandidate({ ...draft, spec: { ..._.cloneDeep(spec), version: 2 } });
  };

  private getPreviousAuthoringCamera() {
    const draft = this.state.cameraCandidate;
    const index = draft?.action === 'replace' ? draft.index - 1 : this.state.cameraMovementFullList.length - 1;
    return this.state.cameraMovementFullList[index];
  }

  private captureAuthoringSource = (kind: NonNullable<CameraAuthoringSpec['source']>['kind']) => {
    const draft = this.state.cameraCandidate;
    if (!draft) return;
    const view =
      kind === 'previous-camera'
        ? this.getPreviousAuthoringCamera()?.finalViewState
        : (this.panelMainRef.current?.capturePresentation().viewState ?? this.state.currentViewState);
    if (!view) return;
    this.updateAuthoringIntent({
      ...draft.spec,
      source: { kind, view: normalizeCameraAuthoringView(view) },
    });
  };

  private captureAuthoringContext = () => {
    const draft = this.state.cameraCandidate;
    if (!draft) return;
    const view = this.panelMainRef.current?.capturePresentation().viewState ?? this.state.currentViewState;
    this.updateAuthoringIntent({
      ...draft.spec,
      composition: {
        ...draft.spec.composition,
        context: {
          kind: 'view',
          view: normalizeCameraAuthoringView(view),
          viewport: { ...(this.state.mapViewportSize ?? draft.spec.planningViewport) },
        },
      },
    });
  };

  /** Return the checked local value so Preview/Apply do not depend on asynchronous setState. */
  private refreshCameraCandidate(draft = this.state.cameraCandidate) {
    if (
      !draft ||
      draft.selectedCameraId !== this.state.selectedCameraId ||
      (draft.action === 'replace' && this.state.cameraMovementFullList[draft.index]?.id !== draft.selectedCameraId)
    )
      return undefined;
    this.panelMainRef.current?.pausePresentation();
    try {
      const spec = _.cloneDeep(draft.spec);
      let target = isCameraTarget(draft.camera.targetSnapshot)
        ? this.resolveNewSuggestionTarget(draft.camera.targetSnapshot)
        : undefined;
      if (isTargetRequired(spec.recipeId) && (!target || target.type === 'none')) {
        if (!spec.manualViews?.initial || !spec.manualViews.final)
          throw new Error('Select a geographic target before returning this shot to Auto.');
        target ??= createTargetFromView(draft.camera.initViewState, 'none');
      }
      spec.sceneRevision = this.state.sceneRevision;
      spec.snapshotRevision = target?.snapshotEnvelope?.revision;
      spec.planningViewport = this.state.mapViewportSize ?? spec.planningViewport;
      const camera = this.generateFromAuthoring(draft.camera, spec, target);
      const errors = getCameraValidationMessages(camera);
      if (errors.length) throw new Error(errors.join(' '));
      const next = { ...draft, camera, spec: camera.authoring ?? spec, error: undefined };
      this.setState({
        cameraCandidate: next,
        cameraRequestError: undefined,
        isPlaying: false,
        currentCameraPreview: undefined,
      });
      return next;
    } catch (error) {
      this.setState({ cameraCandidate: { ...draft, error: error instanceof Error ? error.message : String(error) } });
      return undefined;
    }
  }

  private previewAuthoringDraft = () => {
    const draft = this.refreshCameraCandidate();
    if (!draft) return;
    try {
      const plan = derivePlaybackPlan([draft.camera], {
        trajectoryEnabled: true,
        viewport: draft.spec.planningViewport,
      });
      const shotStart = plan.segments.find((segment) => !segment.generated)?.start ?? 0;
      this.setState({
        comparisonPreview: undefined,
        playbackRequest: createPlaybackRequest('play', plan.segments, shotStart),
      });
    } catch (error) {
      this.setState({ cameraCandidate: { ...draft, error: error instanceof Error ? error.message : String(error) } });
    }
  };

  private applyAuthoringDraft = () => {
    if (this.state.cameraRequestError) return false;
    const draft = this.refreshCameraCandidate();
    if (!draft) return false;
    try {
      const undo = this.captureCameraUndo(draft.returnPresentation);
      const result = applyCameraCandidate(this.state.cameraMovementFullList, draft.camera, draft);
      this.updateCameraMovementState(result.cameras, draft.action === 'replace' ? draft.selectedCameraId : null);
      const plan = derivePlaybackPlan([result.cameras[result.index]], { trajectoryEnabled: true });
      const shotStart = plan.segments.find((segment) => !segment.generated)?.start ?? 0;
      this.setState({ cameraUndo: undo, playbackRequest: createPlaybackRequest('preview', plan.segments, shotStart) });
      this.showCameraSaved(undo, draft.action === 'add' ? 'Shot added.' : 'Shot replaced.');
      return true;
    } catch (error) {
      this.setState({ cameraCandidate: { ...draft, error: error instanceof Error ? error.message : String(error) } });
      return false;
    }
  };

  private cancelAuthoringDraft = () => {
    const draft = this.state.cameraCandidate;
    if (!draft && !this.state.cameraRequestError) return;
    if (draft?.returnPresentation) this.panelMainRef.current?.restorePresentation(draft.returnPresentation);
    else this.panelMainRef.current?.pausePresentation();
    this.setState({
      cameraCandidate: undefined,
      cameraRequestError: undefined,
      isPlaying: false,
      currentCameraPreview: undefined,
    });
  };

  private undoAuthoringChange = () => {
    const undo = this.state.cameraUndo;
    if (!undo) return;
    this.updateCameraMovementState(undo.cameras, undo.selectedCameraId);
    this.setState({ cameraUndo: undefined, cameraCandidate: undefined }, () => {
      if (undo.presentation) this.panelMainRef.current?.restorePresentation(undo.presentation);
    });
  };

  handlePlaybackProgress = (timeMs: number, status: 'playing' | 'paused' | 'complete' | 'error') => {
    this.playbackTimeMs = timeMs;
    this.setState((state) => {
      const session = state.currentCameraPreview;
      if (session) {
        return {
          currentCameraPreview:
            status === 'complete'
              ? completeCurrentCameraPreviewSession(session)
              : { ...session, currentTimeMs: timeMs, isPlaying: status === 'playing' },
          timelineCurrentTimeMs: state.timelineCurrentTimeMs,
          cameraPlayIndex: state.cameraPlayIndex,
          isPlaying: state.isPlaying,
        };
      }
      if (state.playbackRequest?.segments !== state.playbackSegments) return null;
      return {
        currentCameraPreview: undefined,
        timelineCurrentTimeMs: timeMs,
        cameraPlayIndex: getSourceIndexAtTime(state.playbackSegments, timeMs),
        isPlaying: status === 'playing',
      };
    });
  };

  handleAnimationPlaybackControlChange = (controlled: boolean) => {
    this.setState((state) =>
      state.animationPlaybackControlled === controlled ? null : { animationPlaybackControlled: controlled },
    );
  };

  handleReleaseAnimationPlayback = () => {
    this.setState({
      isPlaying: false,
      currentCameraPreview: undefined,
      playbackRequest: createPlaybackRequest('stop', [], 0),
    });
  };

  handleTimelinePlay(startTimeMs: number) {
    this.playbackTimeMs = startTimeMs;
    this.setState({
      currentCameraPreview: undefined,
      comparisonPreview: undefined,
      timelineCurrentTimeMs: startTimeMs,
      playbackRequest: createPlaybackRequest('play', this.state.playbackSegments, startTimeMs),
      isPlaying: true,
    });
  }

  handleTimelinePause(timeMs = this.playbackTimeMs) {
    this.playbackTimeMs = timeMs;
    this.setState({
      timelineCurrentTimeMs: timeMs,
      playbackRequest: createPlaybackRequest('stop', this.state.playbackSegments, timeMs),
      isPlaying: false,
    });
  }

  handleTimelineSeek(timeMs: number) {
    const sourceIndex = getSourceIndexAtTime(this.state.playbackSegments, timeMs);
    this.playbackTimeMs = timeMs;
    this.setState({
      currentCameraPreview: undefined,
      comparisonPreview: undefined,
      timelineCurrentTimeMs: timeMs,
      playbackRequest: createPlaybackRequest('preview', this.state.playbackSegments, timeMs),
      isPlaying: false,
      cameraPlayIndex: sourceIndex,
    });
  }

  handlePlayIndexChange(index: number) {
    this.setState((state) => (state.cameraPlayIndex === index ? null : { cameraPlayIndex: index }));
  }

  handlePlayingStatusChange(isPlaying: boolean) {
    this.setState({ isPlaying: isPlaying });
  }

  private stopPlaybackForCanvasEdit = () => {
    this.setState({ isPlaying: false, currentCameraPreview: undefined });
  };

  handleTimelineTargetIndexChange(index: number) {
    this.setState({ timelineTargetIndex: index });
  }

  handleTimelineCameraIndexChange(timelineTargetIndex: number, timelineCameraIndex: number) {
    const camera = this.state.timelineTargetCameraData[timelineTargetIndex]?.cameras[timelineCameraIndex];
    if (!camera?.generated && camera?.sourceIndex !== undefined)
      this.handleConfigCameraItemIndexChange(camera.sourceIndex);
  }

  handleTimelineExpandedKeyChange(expandedKeys: string[]) {
    this.setState({ timelineExpandedKeys: expandedKeys });
  }

  handleCameraMovementListChange(cameraList: CameraMovement[]) {
    this.cancelAuthoringDraft();
    this.updateCameraMovementState(cameraList, null);
  }

  handleTimelineEdit(edit: TimelineEdit) {
    this.cancelAuthoringDraft();
    const cameraList = _.cloneDeep(this.state.cameraMovementFullList);

    if (edit.type === 'rename-target') {
      for (const camera of edit.target.cameras) {
        if (!camera.editable || camera.generated || camera.sourceIndex === undefined) continue;
        const source = cameraList[camera.sourceIndex];
        if (!source) continue;
        if (edit.name.length > 0) source.timelineTargetName = edit.name;
        else delete source.timelineTargetName;
      }
      this.updateCameraMovementState(cameraList);
      return;
    }

    if (edit.type === 'delete-camera') {
      if (edit.camera.sourceIndex !== undefined && !edit.camera.generated) {
        cameraList.splice(edit.camera.sourceIndex, 1);
        this.updateCameraMovementState(cameraList);
      }
      return;
    }

    if (edit.type === 'delete-target') {
      const sourceIndices = edit.target.cameras
        .filter((camera) => camera.editable && !camera.generated)
        .map((camera) => camera.sourceIndex)
        .filter((sourceIndex): sourceIndex is number => sourceIndex !== undefined)
        .sort((a, b) => b - a);

      for (const sourceIndex of sourceIndices) {
        cameraList.splice(sourceIndex, 1);
      }
      this.updateCameraMovementState(cameraList);
      return;
    }

    const sourceIndex = edit.camera.sourceIndex;
    if (sourceIndex === undefined || !cameraList[sourceIndex]) {
      return;
    }

    const resizeResult = applyTimelineResizeEdit({
      cameraList,
      timelineData: this.state.timelineTargetCameraData,
      edit,
      totalTimeLength: this.state.totalTimeLength,
    });
    if (resizeResult) {
      this.updateCameraMovementState(resizeResult.cameraList);
    }
  }

  render() {
    const selectedCamera = this.state.cameraMovementFullList.find(
      (camera) => camera.id === this.state.selectedCameraId,
    );
    const libraryTarget = isCameraTarget(selectedCamera?.targetSnapshot)
      ? selectedCamera.targetSnapshot
      : this.state.selectedTarget;
    let dataTable: CustomObject[] = [];
    const dataColumns = [];
    if (this.state.visData.length) {
      dataTable = this.state.visData;
      const dataKeys = Object.keys(this.state.visData[0]);
      for (const key of dataKeys) {
        if (key !== 'key') {
          const column = {
            title: key,
            dataIndex: key,
            key: key,
          };
          dataColumns.push(column);
        }
      }
    }

    const currentVisualizationParams = this.state.visualizationParams[this.state.activeVisualizationId] ?? {};
    const currentManualVisualizationParameterKeys = getManualVisualizationParameterKeys(
      this.state.manualVisualizationParameterKeys,
      this.state.activeVisualizationId,
    );
    const currentDatasetOverride = this.state.uploadedDatasetOverrides[this.state.activeVisualizationId];
    const tutorialSteps: TourProps['steps'] = [
      {
        title: 'Narrative Purpose',
        description:
          'Choose what you want to communicate: emphasize a target, give an overview, compare places, add context, or create movement.',
        target: () =>
          this.libraryTourRef.current?.querySelector<HTMLElement>('[data-tour="narrative-purpose"]') ??
          this.libraryTourRef.current!,
        placement: 'right',
      },
      {
        title: 'Camera Types',
        description:
          'Each narrative purpose offers matching camera types, such as push-in, pan, or arc shots. Select a purpose to see its shots, then preview and add one to your story.',
        target: () =>
          this.libraryTourRef.current?.querySelector<HTMLElement>('[data-tour="camera-types"]') ??
          this.libraryTourRef.current!,
        placement: 'right',
      },
      {
        title: 'Map Workspace',
        description: 'Explore your data, select objects or regions, and preview camera movements on the map.',
        target: () => this.mapTourRef.current!,
        placement: 'bottom',
      },
      {
        title: 'Map Tools',
        description:
          'Use these buttons to return to or save your home view, select a region by drawing a polygon, and clear drawn polygons.',
        target: () =>
          this.mapTourRef.current?.querySelector<HTMLElement>('[data-tour="map-tools"]') ?? this.mapTourRef.current!,
        placement: 'left',
      },
      {
        title: 'Visualization',
        description:
          'Choose a visualization and dataset, upload your own data, and adjust the map style and display settings.',
        target: () => this.configTourRef.current!,
        placement: 'left',
      },
      {
        title: 'Camera',
        description:
          'Manage your story shots, adjust camera views and timing, preview individual shots, and import or export a story.',
        target: () => this.configTourRef.current!,
        placement: 'left',
      },
      {
        title: 'Annotation',
        description: 'Select a camera to add annotation text and set when it appears and how long it stays on screen.',
        target: () => this.configTourRef.current!,
        placement: 'left',
      },
      {
        title: 'Timeline',
        description: 'Adjust camera timing and play your story from start to finish.',
        target: () => this.timelineTourRef.current!,
        placement: 'top',
      },
    ];

    return (
      <ConfigProvider warning={{ strict: false }} theme={squareCornerTheme}>
        <Layout className="h-screen overflow-hidden">
          <Header className="h-10! w-screen bg-slate-800! px-4! leading-10!">
            <Row justify="space-between">
              <Col>
                <Space size="small">
                  <BsCameraReelsFill className="relative -top-1 inline-block text-xl text-white" />
                  <Text className="relative top-0.5! px-1 text-2xl! font-bold text-white!">GeoCamera</Text>
                </Space>
              </Col>
              <Col>
                <Button
                  size="small"
                  type="dashed"
                  ghost={true}
                  className="text-white!"
                  onClick={() => this.setState({ tutorialOpen: true, tutorialStep: 0 })}
                  icon={<QuestionCircleOutlined />}>
                  Tutorial
                </Button>
              </Col>
            </Row>
          </Header>
          <Layout>
            <Resizable
              resizeHandles={['e']}
              height={0}
              width={this.state.siderWidth}
              handle={
                <span
                  className="resize-sider-handle hover:bg-gray-100"
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                />
              }
              minConstraints={[200, 0]}
              maxConstraints={[800, Infinity]}
              onResize={this.onSiderResize}>
              <Sider
                ref={this.libraryTourRef}
                className="overflow-y-auto border-r border-gray-200 bg-white! p-2"
                width={this.state.siderWidth}>
                <PanelLibrary
                  tutorialActive={this.state.tutorialOpen && this.state.tutorialStep < 2}
                  currentCategory={this.state.libraryCategory}
                  currentCamera={this.state.cameraCandidate?.camera.name ?? this.state.currentCameraName}
                  selectedCamera={selectedCamera}
                  selectionKey={this.state.selectedCameraId}
                  candidate={
                    this.state.cameraCandidate
                      ? {
                          camera: this.state.cameraCandidate.camera,
                          adjustments: this.state.cameraCandidate.spec.adjustments,
                          spec: this.state.cameraCandidate.spec,
                          action: this.state.cameraCandidate.action,
                          error: this.state.cameraCandidate.error,
                        }
                      : undefined
                  }
                  requestError={this.state.cameraRequestError}
                  onCameraAdjust={this.updateAuthoringDraft}
                  onCameraAuthoringChange={this.updateAuthoringIntent}
                  onCameraSourceCapture={this.captureAuthoringSource}
                  onCameraContextCapture={this.captureAuthoringContext}
                  hasPreviousCamera={!!this.getPreviousAuthoringCamera()}
                  onCameraPreview={this.previewAuthoringDraft}
                  onCameraApply={this.applyAuthoringDraft}
                  onCameraCancel={this.cancelAuthoringDraft}
                  currentLocation={this.state.targetLocation}
                  currentTarget={libraryTarget}
                  comparisonPair={selectedCamera ? (libraryTarget?.children ?? []) : (this.getComparisonPair() ?? [])}
                  onCameraCategoryClick={this.handleCameraLibraryCategoryClick}
                  onCameraMovementItemChange={this.handleCameraLibraryItemChange}
                />
              </Sider>
            </Resizable>
            <Content className="min-w-0 bg-white">
              <Row style={{ height: getTimelineMainContentHeightStyle(this.state.panelTimelineHeight) }}>
                <Row wrap={false} className="h-full w-full">
                  <Col ref={this.mapTourRef} flex="1 1 0" className="min-w-0 border-r border-gray-200">
                    <PanelMain
                      ref={this.panelMainRef}
                      activeVisualizationId={this.state.activeVisualizationId}
                      visualizationCatalog={visualizationCatalog}
                      catalogValidationErrors={visualizationCatalogValidationErrors}
                      visualizationParams={currentVisualizationParams}
                      manualParameterKeys={currentManualVisualizationParameterKeys}
                      datasetOverride={currentDatasetOverride}
                      visTitle={this.state.visDatasetTitle}
                      visData={this.state.visData}
                      viewportSize={this.state.mapViewportSize}
                      playbackRequest={this.state.playbackRequest}
                      playbackPlanRevision={this.state.playbackPlanRevision}
                      viewState={this.state.currentViewState}
                      homeViews={this.state.homeViews}
                      onHomeViewChange={this.handleHomeViewChange}
                      viewStateModalVisible={this.state.viewStateModalVisible}
                      cameraViewStateEditIndex={this.state.cameraViewStateEditIndex}
                      editingCameraMovement={this.state.cameraMovementFullList[this.state.cameraViewStateEditIndex]}
                      comparisonPreview={this.state.comparisonPreview}
                      selectionTargets={this.state.selectedTargets}
                      objectSelectionVisible={
                        !selectedCamera &&
                        !this.state.cameraCandidate &&
                        !this.state.currentCameraPreview &&
                        !this.state.isPlaying &&
                        !this.state.viewStateModalVisible
                      }
                      onSelectionRemove={this.handleSelectionRemove}
                      onSelectionClear={this.handleSelectionClear}
                      onComparisonPreviewExit={this.handleComparisonPreviewExit}
                      onVisDataChange={this.handleVisDataChange}
                      onVisDataNameChange={this.handleVisDatasetNameChange}
                      onVisDataTitleChange={this.handleVisDatasetTitleChange}
                      onVisDataFileNameChange={this.handleVisDataFileNameChange}
                      onCanvasViewStateUpdate={this.handleCanvasViewStateUpdate}
                      onPlaybackStop={this.stopPlaybackForCanvasEdit}
                      onPlaybackProgress={this.handlePlaybackProgress}
                      onAnimationPlaybackControlChange={this.handleAnimationPlaybackControlChange}
                      onTargetLocationChange={this.handleTargetLocationChange}
                      onTargetGeoTypeChange={this.handleTargetGeoTypeChange}
                      onTargetChange={this.handleTargetChange}
                      onViewportSizeChange={this.handleMapViewportSizeChange}
                      onVisualizationParamsResolved={this.handleResolvedVisualizationParams}
                      onShadowSceneIdentityChange={this.handleShadowSceneIdentityChange}
                      onViewStateModalVisibleChange={this.handleViewStateModalVisibleChange}
                      onCameraMovementUpdate={this.handleCameraMovementUpdate}
                    />
                  </Col>
                  <Resizable
                    resizeHandles={['w']}
                    height={0}
                    width={this.state.panelConfigWidth}
                    handle={
                      <span
                        className="resize-config-handle hover:bg-gray-100"
                        onClick={(e) => {
                          e.stopPropagation();
                        }}
                      />
                    }
                    minConstraints={[330, 0]}
                    maxConstraints={[500, Infinity]}
                    onResize={this.onPanelConfigResize}>
                    <Col
                      ref={this.configTourRef}
                      className="h-full min-w-0 p-2"
                      flex={`0 0 ${this.state.panelConfigWidth}px`}>
                      <PanelConfig
                        tutorialTab={this.state.tutorialOpen ? tutorialConfigTabs[this.state.tutorialStep] : undefined}
                        panelTimelineHeight={this.state.panelTimelineHeight}
                        cameraMovementList={this.state.cameraMovementFullList}
                        homeViews={this.state.homeViews}
                        onStoryImport={this.handleStoryImport}
                        viewportSize={this.state.mapViewportSize}
                        trajectoryEnabled={trajectoryV2Enabled}
                        currentCameraIndex={this.state.cameraListIndex}
                        currentCameraPreviewIndex={this.state.currentCameraPreview?.cameraIndex ?? -1}
                        isCurrentCameraPreviewPlaying={Boolean(this.state.currentCameraPreview?.isPlaying)}
                        animationPlaybackControlled={this.state.animationPlaybackControlled}
                        onReleaseAnimationPlayback={this.handleReleaseAnimationPlayback}
                        activeVisualizationId={this.state.activeVisualizationId}
                        visualizationCatalog={visualizationCatalog}
                        visualizationParams={currentVisualizationParams}
                        manualParameterKeys={currentManualVisualizationParameterKeys}
                        visDatasetName={this.state.visDatasetName}
                        visDatasetFileName={this.state.visDatasetFileName}
                        onCameraMovementListChange={this.handleCameraMovementListChange}
                        onVisNameChange={this.handleVisSelectChange}
                        onVisualizationParamsChange={this.handleVisualizationParameterChange}
                        onVisualizationParameterAutoReset={this.handleVisualizationParameterAutoReset}
                        onExampleDatasetSelect={this.handleExampleDatasetSelect}
                        onDatasetUpload={this.handleDatasetUpload}
                        onDataModalVisibleChange={this.handleDataModalVisibleChange}
                        onCameraIndexChange={this.handleConfigCameraItemIndexChange}
                        onCameraItemDelete={this.handleCameraListItemDelete}
                        onCameraItemPlay={this.handleCameraListItemPlay}
                        onCameraItemReset={this.handleCameraListItemReset}
                        onCameraItemEdit={this.handleCameraMovementUpdate}
                        onCameraItemViewStateEdit={this.handleCameraItemViewStateEdit}
                      />
                    </Col>
                  </Resizable>
                </Row>
                <Resizable
                  resizeHandles={['n']}
                  height={this.state.panelTimelineHeight}
                  width={0}
                  handle={
                    <span
                      className="resize-timeline-handle hover:bg-gray-100"
                      onClick={(e) => {
                        e.stopPropagation();
                      }}
                    />
                  }
                  minConstraints={[0, 40]}
                  maxConstraints={[Infinity, 450]}
                  onResize={this.onPanelTimelineResize}>
                  <Col
                    ref={this.timelineTourRef}
                    span={24}
                    className="border-t border-gray-200"
                    style={{ height: `${this.state.panelTimelineHeight}px` }}>
                    <PanelTimeline
                      timelineHeight={this.state.panelTimelineHeight}
                      cameraMovementList={this.state.cameraMovementFullList}
                      cameraPlayIndex={this.state.cameraPlayIndex}
                      selectedCameraId={this.state.selectedCameraId}
                      onClearCameraSelection={this.clearCameraSelection}
                      playbackSegments={this.state.playbackSegments}
                      timelineData={this.state.timelineTargetCameraData}
                      totalTimeLength={this.state.totalTimeLength}
                      isPlaying={this.state.isPlaying}
                      currentTimeMs={this.state.timelineCurrentTimeMs}
                      targetIndex={this.state.timelineTargetIndex}
                      cameraIndex={this.state.timelineCameraIndex}
                      expandedKeys={this.state.timelineExpandedKeys}
                      progressElement={this.state.progressElements}
                      onTimelinePlay={this.handleTimelinePlay}
                      onTimelinePause={this.handleTimelinePause}
                      onTimelineSeek={this.handleTimelineSeek}
                      onCameraPlayIndexChange={this.handlePlayIndexChange}
                      onPlayingStatusChange={this.handlePlayingStatusChange}
                      onTimelineTargetIndexChange={this.handleTimelineTargetIndexChange}
                      onTimelineCameraIndexChange={this.handleTimelineCameraIndexChange}
                      onTimelineExpandedKeyChange={this.handleTimelineExpandedKeyChange}
                      onTimelineEdit={this.handleTimelineEdit}
                    />
                  </Col>
                </Resizable>
              </Row>
              <Modal
                title="Data table"
                centered={false}
                open={this.state.dataModalVisible}
                width={1000}
                footer={null}
                onCancel={() => {
                  this.handleDataModalVisibleChange(false);
                }}>
                <Table
                  dataSource={dataTable}
                  columns={dataColumns}
                  pagination={{ pageSize: 100 }}
                  scroll={{ y: 500 }}
                  size="small"
                />
              </Modal>
            </Content>
          </Layout>
        </Layout>
        <Tour
          open={this.state.tutorialOpen}
          current={this.state.tutorialStep}
          steps={tutorialSteps}
          onChange={(tutorialStep) => this.setState({ tutorialStep })}
          onClose={() => this.setState({ tutorialOpen: false })}
          onFinish={() => this.setState({ tutorialOpen: false })}
          mask={true}
          disabledInteraction={true}
          gap={{ radius: 0 }}
        />
      </ConfigProvider>
    );
  }
}

export default App;
