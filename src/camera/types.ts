import type { CameraBaseViewSource, CameraMovement, CameraView, CustomObject } from '../interfaces';
import type { SnapshotEnvelope } from './geometry/types';
import type { CameraAuthoringSpec, CameraFramingReport } from './authoring-types';
import type { TimedPathSnapshot } from './timed-path';

export type LngLat = [number, number];
export type BBox = [number, number, number, number];

export type GeospatialTargetType = 'location' | 'region' | 'path' | 'multiple' | 'none';
export type NarrativePurpose = 'emphasis' | 'overview' | 'comparison' | 'supplement' | 'dynamic' | 'basic';
export type CameraMode = 'recommended' | 'manual';
export type CameraPresentation = 'split';
export type CameraTargetSource =
  | 'click-object'
  | 'drawn-region'
  | 'data-path'
  | 'drawn-path'
  | 'heatmap-zone'
  | 'combined-targets'
  | 'view-fallback';

export type CameraShot =
  | 'static'
  | 'push-in'
  | 'pull-out'
  | 'pan'
  | 'camera-roll'
  | 'arc'
  | 'tilt'
  | 'trucking'
  | 'tracking';

export type CameraRecipeStrategy =
  | CameraShot
  | 'push-in-tilt'
  | 'arc-tilt'
  | 'pan-tilt'
  | 'pan-push-in'
  | 'pull-out-roll'
  | 'arc-pull-out'
  | 'tracking-push-in';

export type PathFramingMode = 'fit-route' | 'follow-route';

/**
 * Algorithm-only framing overrides for a single camera planning request.
 *
 * These values are intentionally normalized and optional so callers can nudge
 * the resolved recipe without replacing the recipe defaults. Use catalog or
 * profile framing values for stable camera behavior, and use this tuning object
 * for scene-specific adjustments.
 */
export interface CameraFramingTuning {
  /** Independent geometric safety inset, as a ratio of the shorter viewport edge. */
  safetyMarginRatio?: number;
  /**
   * Normalized range [-1, 1]. Negative values produce a tighter, closer frame;
   * positive values preserve more context with more padding and zoom-out.
   */
  framingTightness?: number;
  /**
   * Screen-space target anchor offset, expressed as viewport ratios from center.
   * For example [-0.14, 0] reserves space on the right by placing the target
   * left of center, [0, 0] centers it, and [0.14, 0] reserves space on the left.
   */
  offsetRatio?: [number, number];
  /**
   * Normalized range [-1, 1]. Negative values calm rotation or bearing changes;
   * positive values increase motion energy while still respecting visibility.
   */
  motionStrength?: number;
  /**
   * Author angle in degrees. Simple authoring uses the global 0–75° range;
   * recipe ranges supply the recommended defaults.
   */
  pitchTarget?: number;
  /**
   * Normalized range [0, 1]. Screen-anchor height fraction for 3D targets:
   * 0 centers the ground base, 0.5 the visual centroid, 1 the extruded top.
   */
  anchorHeightRatio?: number;
  /**
   * Global speed multiplier (> 0). Values above 1 make all adaptive
   * durations shorter; values below 1 slow every movement down. The timing
   * module floors the effective value at 0.25, so movements slow down at
   * most 4x no matter how small the configured scale is.
   */
  speedScale?: number;
}

export interface CameraRecipeTiming {
  durationMs: number;
  stayMs: number;
  interpolationType?: string;
  interpolationDurationMs?: number;
  pathDurationPerKmMs?: number;
  maxDurationMs?: number;
  /** Perceived speed tier in viewport-normalized "screens per second". */
  speedTier?: number;
}

export type CameraRecipeTimingAdjustment = Partial<CameraRecipeTiming>;

export interface CameraRecipeFraming {
  paddingRatio: number;
  contextPaddingRatio: number;
  minPaddingPx?: number;
  maxPaddingRatio?: number;
  zoomBias: number;
  contextZoomOut: number;
  pitchRange: [number, number];
  pitchTarget?: number;
  bearingDelta: number;
  offsetRatio?: [number, number];
  pathFramingMode?: PathFramingMode;
}

export type CameraRecipeFramingAdjustment = Partial<CameraRecipeFraming>;

export interface CameraRecipeAdaptation {
  densityPaddingScale: number;
  densityZoomOutScale: number;
  elevationZoomOutScale: number;
  elevationPitchScale: number;
  largeAreaPaddingScale: number;
  largeAreaZoomOutScale: number;
  regionPaddingBonus: number;
  multiplePaddingBonus: number;
  pathPaddingBonus: number;
  rotationPaddingBonus: number;
  maxAdaptiveZoomOut: number;
  /**
   * Zoom-out applied per unit of stats.heightOverflowRatio when the rendered content height was
   * capped for framing. Applied after maxAdaptiveZoomOut so over-tall aggregated columns retreat
   * to regional context instead of being fit at full rendered height.
   */
  overflowZoomOutScale: number;
}

export type CameraRecipeAdaptationAdjustment = Partial<CameraRecipeAdaptation>;

export interface CameraRecipeTargetPolicy {
  requiresTarget: boolean;
  requiresComparison: boolean;
}

export type CameraRecipeTargetPolicyAdjustment = Partial<CameraRecipeTargetPolicy>;

export interface CameraRecipeAdjustment {
  timing?: CameraRecipeTimingAdjustment;
  framing?: CameraRecipeFramingAdjustment;
  adaptation?: CameraRecipeAdaptationAdjustment;
  targetPolicy?: CameraRecipeTargetPolicyAdjustment;
}

export interface CameraParameterProfile {
  id: NarrativePurpose;
  title: string;
  reason: string;
  timing: CameraRecipeTiming;
  framing: CameraRecipeFraming;
  adaptation: CameraRecipeAdaptation;
  targetPolicy: CameraRecipeTargetPolicy;
}

export interface CameraLibraryOption {
  id: string;
  label: string;
  adjustment: CameraRecipeAdjustment;
}

export interface CameraOptionSelection {
  id: string;
  label: string;
  adjustment: CameraRecipeAdjustment;
}

export interface CameraLibraryRecipe {
  strategy: CameraRecipeStrategy;
  isRotating?: boolean;
  timing?: CameraRecipeTimingAdjustment;
  framing?: CameraRecipeFramingAdjustment;
  adaptation?: CameraRecipeAdaptationAdjustment;
  targetPolicy?: CameraRecipeTargetPolicyAdjustment;
}

export interface CameraLibraryCamera {
  id: string;
  mode: CameraMode;
  /** Hide new-shot entry points while keeping saved stories and ID lookup compatible. */
  hiddenFromLibrary?: boolean;
  manualGroup?: string;
  purpose?: NarrativePurpose;
  presentation?: CameraPresentation;
  title: string;
  description: string;
  listDescription: string;
  shots: CameraShot[];
  targetTypes: GeospatialTargetType[];
  recipe: CameraLibraryRecipe;
  options?: CameraLibraryOption[];
  defaultOptionId?: string;
  optionKind?: 'duration' | 'pace' | 'angle';
}

export interface CameraLibraryTaxonomyItem {
  id: string;
  title: string;
  description?: string;
}

export interface CameraLibraryDefault {
  purpose: NarrativePurpose;
  targetType: GeospatialTargetType;
  cameraId: string;
}

export interface CameraLibraryTuning {
  global?: CameraFramingTuning;
  byPurpose?: Partial<Record<NarrativePurpose, CameraFramingTuning>>;
}

export type StrictFrameFallbackLevel = 'preferred' | 'occupancy' | 'pitch' | 'bearing' | 'anchor';

export interface StrictFrameLibraryConfig {
  version: 1;
  contentMapping: {
    occupancy: {
      elevation: number;
      density: number;
      coverage: number;
      dispersion: number;
    };
    pitch: {
      elevationDeg: number;
      curvatureDeg: number;
    };
    bearingOrientationWeight: number;
    motion: {
      coverage: number;
      density: number;
      dispersion: number;
      curvature: number;
    };
    speed: {
      curvature: number;
      dispersion: number;
      minScale: number;
      maxScale: number;
    };
    closerWiderOccupancy: [near: number, far: number];
  };
  solver: {
    pitchStepDeg: number;
    bearingStepDeg: number;
    zoomTolerance: number;
    meterSupportTolerancePx: number;
    meterSupportIntervalBudget: number;
    numericalBufferPx: number;
    anchorAlignmentMaxIterations: number;
    anchorTolerancePx: number;
    evaluationBudget: number;
    parameterBoxBudget: number;
    occupancyRelaxationFactors: number[];
    anchorCenterBlendFactors: number[];
  };
  fallbackLevels: StrictFrameFallbackLevel[];
  weights: CameraPreferenceWeights;
}

export interface CameraLibraryConfig {
  version: number;
  revision: string;
  strictFrame: StrictFrameLibraryConfig;
  taxonomy: {
    purposes: CameraLibraryTaxonomyItem[];
    targets: CameraLibraryTaxonomyItem[];
    shots: CameraLibraryTaxonomyItem[];
  };
  defaults: CameraLibraryDefault[];
  tuning?: CameraLibraryTuning;
  cameras: CameraLibraryCamera[];
}

export interface ManualCameraGroup {
  id: string;
  title: string;
  cameras: CameraLibraryCamera[];
}

export interface CameraTargetStats {
  count: number;
  maxElevationRatio?: number;
  elevationRatio?: number;
  density?: number;
  densityRatio?: number;
  pathLengthKm?: number;
  bboxAreaKm2?: number;
  bboxAreaRatio?: number;
  visualAreaKm2?: number;
  visualAreaRatio?: number;
  dispersionRatio?: number;
  referenceAreaKm2?: number;
  layerKinds?: string[];
  radiusMeters?: number;
  maxElevationValue?: number;
  selectedElevationValue?: number;
  maxElevationMeters?: number;
  selectedElevationMeters?: number;
  /**
   * Normalized [0, 1] measure of how far the rendered content height exceeds the framing height
   * cap (log2 scale). 0 when the rendered height fits the cap; grows with the overflow magnitude.
   */
  heightOverflowRatio?: number;
}

export interface CameraTargetVisualFrame {
  bbox: BBox;
  anchor?: LngLat;
  heightMeters?: number;
  extraPaddingPx?: number;
  sampleCoordinates?: Array<LngLat | [number, number, number]>;
}

export interface CameraTarget {
  sourceFeatures?: Array<{ field: string; value: string | number }>;
  sourceDatasetId?: string;
  sourceLayerId?: string;
  sourceVisualizationId?: string;
  selectionAnchor?: LngLat;
  id: string;
  type: GeospatialTargetType;
  source?: CameraTargetSource;
  center: LngLat;
  bbox: BBox;
  visualFrame?: CameraTargetVisualFrame;
  coordinates?: LngLat[] | LngLat[][];
  timedPath?: TimedPathSnapshot;
  start?: LngLat;
  end?: LngLat;
  selectedRows?: CustomObject[];
  stats?: CameraTargetStats;
  children?: CameraTarget[];
  snapshotEnvelope?: SnapshotEnvelope;
  label?: string;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface CameraSelectionRequest {
  /** A deliberate preset change resets tuning and releases an authored movement duration. */
  resetAdjustments?: boolean;
  action?: 'add' | 'replace';
  cameraName: string;
  optionSelection?: CameraOptionSelection;
}

export interface CameraRecipe {
  cameraName: string;
  profile: CameraParameterProfile;
  optionSelection?: CameraOptionSelection;
  purpose: NarrativePurpose;
  presentation?: CameraPresentation;
  shots: CameraShot[];
  primaryShot: CameraShot;
  strategy: CameraRecipeStrategy;
  timing: CameraRecipeTiming;
  framing: CameraRecipeFraming;
  adaptation: CameraRecipeAdaptation;
  targetPolicy: CameraRecipeTargetPolicy;
  /**
   * durationMs after the profile+recipe merge, before any option adjustment;
   * the option/base ratio expresses the option's speed intent.
   */
  baseDurationMs: number;
  duration: number;
  stay: number;
  isRotating: boolean;
  requiresTarget: boolean;
  requiresComparison: boolean;
  targetTypes: GeospatialTargetType[];
  interpolationType: string;
  interpolationDuration: number;
}

export interface CameraPlanInput {
  authoring?: CameraAuthoringSpec;
  cameraName: string;
  currentViewState: CameraView;
  previousCamera?: CameraMovement;
  baseViewMode?: CameraBaseViewSource;
  target?: CameraTarget;
  comparisonTargets?: CameraTarget[];
  optionSelection?: CameraOptionSelection;
  framingTuning?: CameraFramingTuning;
  viewportSize?: ViewportSize;
}

export interface CameraPlanResult {
  cameraMovement: CameraMovement;
  target: CameraTarget;
  report?: CameraFramingReport;
}

export interface CameraPreferenceWeights {
  occupancy: number;
  pitch: number;
  bearing: number;
  anchor: number;
  continuity: number;
}

export interface ShadowSceneLayerIdentity {
  datasetId: string;
  visualizationId: string;
  layerId: string;
  dataRevision: string;
  visualizationRevision: string;
  resolvedLayerDigest: string;
}

export interface ShadowSceneIdentity {
  layers: ShadowSceneLayerIdentity[];
}
