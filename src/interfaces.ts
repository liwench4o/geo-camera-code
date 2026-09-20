/* eslint-disable @typescript-eslint/no-explicit-any */

import type { MapViewState } from '@deck.gl/core';
import type { CameraAuthoringSpec, CameraFramingReport } from './camera/authoring-types';
import type { AnimationBinding } from './story/scene-time';
import type {
  CommittedTrajectoryPlan,
  RuntimeCameraTrajectory,
  SerializedCameraTrajectory,
  SerializedCameraView,
  TrajectoryCertificate,
  TrajectorySlackObservations,
} from './camera/trajectory/types';

export interface CustomObject {
  [key: string]: any;
}

export type DeckglLayer = any;

export interface CameraView extends MapViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
  minZoom?: number;
  maxZoom?: number;
  minPitch?: number;
  maxPitch?: number;
  altitude?: number;
  transitionDuration?: number;
  transitionEasing?: (time: number) => number;
  transitionInterpolator?: any;
  onTransitionEnd?: any;
}

export interface DataTableRow {
  rid?: number;
  [key: string]: number | string | undefined;
}

export interface PickingInfo<T> {
  layer: any;
  index: number;
  object: T;
  x: number;
  y: number;
  lngLat: [number, number];
}

export interface CameraAnnotation {
  delay: number;
  duration: number;
  text: string;
}

export interface CameraRecommendation {
  recipeId: string;
  source: 'resolved-recipe' | 'camera-option';
  optionId?: string;
  optionLabel?: string;
  mode?: string;
  purpose?: string;
  profileId?: string;
}

export type CameraBaseViewSource = 'current-view' | 'previous-camera';

export type CameraDebugReasonGroup = 'profile' | 'content' | 'strategy' | 'option' | 'baseView';

export interface CameraDebugInfo {
  recipeId: string;
  profileId: string;
  optionId?: string;
  baseViewSource?: CameraBaseViewSource;
  reasons: Partial<Record<CameraDebugReasonGroup, string[]>>;
  metrics?: Record<string, number | string | string[] | undefined>;
  resolvedParameters?: {
    durationMs: number;
    stayMs: number;
    paddingRatio: number;
    zoomBias: number;
    pitchTarget?: number;
    bearingDelta: number;
    anchorHeightRatio: number;
    offsetRatio?: [number, number];
    displacement?: number;
    speedTier?: number;
  };
}

export interface CameraMovement {
  animationBinding?: AnimationBinding;
  authoring?: CameraAuthoringSpec;
  framingReport?: CameraFramingReport;
  id?: string;
  name: string;
  title: string;
  category: string;
  purpose?: string;
  shot?: string;
  targetId?: string;
  /** User-authored display name for the Timeline target row. */
  timelineTargetName?: string;
  targetSnapshot?: unknown;
  recipeId?: string;
  recommendation?: CameraRecommendation;
  debugInfo?: CameraDebugInfo;
  recommendationBaseViewState?: CameraView;
  comparisonTargetSnapshots?: unknown[];
  presentation?: 'split';
  initViewState: CameraView;
  finalViewState: CameraView;
  duration: number;
  stay: number;
  startDelay?: number;
  isRotating: boolean;
  interpolationType: string;
  interpolationDuration: number;
  annotation?: CameraAnnotation;
  trajectoryPlan?: CommittedTrajectoryPlan;
}

export type GeneratedCameraKind = 'gap-transition' | 'timeline-gap';
export type PlaybackRequestMode = 'play' | 'preview' | 'stop';
export type PlaybackInterpolatorType = 'fly' | 'linear';

export interface PlaybackSegment {
  id: string;
  camera: CameraMovement;
  start: number;
  duration: number;
  stay: number;
  end: number;
  sourceIndex?: number;
  sourceCameraId?: string;
  generated?: GeneratedCameraKind;
  editable: boolean;
  interpolator: PlaybackInterpolatorType;
  trajectory?: RuntimeCameraTrajectory;
  trajectoryRequired?: boolean;
}

export interface PlaybackRequest {
  id: number;
  mode: PlaybackRequestMode;
  startTimeMs: number;
  segments: PlaybackSegment[];
}

export interface TargetCamera {
  id?: string;
  name?: string;
  title: string;
  category: string;
  start: number;
  duration: number;
  stay: number;
  sourceIndex?: number;
  sourceCameraId?: string;
  generated?: GeneratedCameraKind;
  editable: boolean;
}

export interface TargetCameras {
  name: string;
  key: string;
  type: string;
  location: number[];
  targetStart: number;
  targetEnd: number;
  cameras: TargetCamera[];
}

export type TimelineResizeEdge = 'start' | 'motion-end' | 'end';

export type TimelineEdit =
  | { type: 'rename-target'; target: TargetCameras; name: string }
  | { type: 'ripple-resize'; camera: TargetCamera; edge: TimelineResizeEdge; valueMs: number }
  | { type: 'delete-camera'; camera: TargetCamera }
  | { type: 'delete-target'; target: TargetCameras };

export type HomeViews = Record<string, CameraView>;

export interface StoryJsonV1 {
  type: 'geo-camera-story';
  version: 1;
  cameras: CameraMovement[];
  homeViews?: HomeViews;
}

export type CameraMovementCompatibilityFields = Omit<
  CameraMovement,
  'initViewState' | 'finalViewState' | 'trajectoryPlan'
> & {
  initViewState: SerializedCameraView;
  finalViewState: SerializedCameraView;
};

export type SerializedTrajectoryCertification =
  | { status: 'certified'; certificate: TrajectoryCertificate }
  | { status: 'unsafe'; worstTimeMs: number; slackPx: number }
  | { status: 'unknown'; reason: 'work-budget-exceeded' | 'interval-bound-unavailable' }
  | { status: 'legacy-unverified'; observations: TrajectorySlackObservations };

export interface StoryJsonV2Camera {
  movement: CameraMovementCompatibilityFields;
  inputDigest: string;
  trajectory: SerializedCameraTrajectory;
  trajectoryDigest: string;
  certification: SerializedTrajectoryCertification;
}

export interface StoryJsonV2 {
  type: 'geo-camera-story';
  version: 2;
  cameras: StoryJsonV2Camera[];
  homeViews?: HomeViews;
}

export interface HexagonParameter {
  hexagonCoverage: number;
  hexagonRadius: number;
  hexagonUpperPercentile: number;
}

export interface HeatmapParameter {
  heatmapIntensity: number;
  heatmapRadius: number;
  heatmapThreshold: number;
}

export interface AnimatedLineParameter {
  isAnimated: boolean;
  trailLength: number;
}
