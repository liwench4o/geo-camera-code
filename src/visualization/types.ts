import type { Effect, PickingInfo } from '@deck.gl/core';
import type { CameraView, CustomObject, DeckglLayer } from '../interfaces';
import type { UnitValue } from '../camera/geometry/types';
import type { ViewportSize } from '../camera/types';

export type DataFileFormat = 'csv' | 'json';

export type VisualizationParameterValue = boolean | number | string;

export type VisualizationParameterValues = Record<string, VisualizationParameterValue>;

export type VisualizationParametersById = Record<string, VisualizationParameterValues>;

export const VISUALIZATION_MAP_STYLE_PARAM_KEY = '__mapStyle';

export interface VisualizationCatalog {
  revision: string;
  defaultVisualization: string;
  datasets: DatasetConfig[];
  visualizations: VisualizationConfig[];
}

export interface DatasetConfig {
  revision: string;
  id: string;
  title: string;
  files: DataFileConfig[];
  normalizers?: string[];
  primaryDataRef?: string;
  initialViewState?: string;
}

export interface DataFileConfig {
  revision: string;
  id: string;
  url: string;
  format: DataFileFormat;
}

export interface UploadedDatasetOverride {
  revision: number;
  contentDigest: string;
  dataset: DatasetConfig;
  loadedFiles: ReadonlyMap<string, readonly CustomObject[]>;
  sourceFileName: string;
  totalRowCount: number;
  skippedRowCount: number;
}

export type UploadedDatasetOverrides = Record<string, UploadedDatasetOverride | undefined>;

export interface VisualizationConfig {
  revision: string;
  id: string;
  title: string;
  datasetId: string;
  datasetParam?: string;
  mapStyle: string;
  initialViewState: string;
  effects?: string[];
  tooltip?: string;
  pickingRadius?: number;
  layers: LayerConfig[];
  parameters?: VisualizationParameterConfig[];
  animation?: VisualizationAnimationConfig;
}

export type VisualizationLayerKind = 'point' | 'hexagon' | 'heatmap' | 'path' | 'polygon' | 'building';

export interface VisualizationLayerAnalyticsConfig {
  kind: VisualizationLayerKind;
  radiusParam?: string;
  radiusMeters?: number;
  elevationScale?: number;
  elevationRange?: [number, number];
  elevationDomain?: [number, number];
  elevationAccessor?: string;
  weightAccessor?: string;
  positionAccessor?: string;
  sourcePositionAccessor?: string;
  targetPositionAccessor?: string;
  pathAccessor?: string;
  polygonAccessor?: string;
}

export interface VisualizationAnimationConfig {
  enabledParam?: string;
  speedParam?: string;
  timeParam: string;
  frameModulo: number;
}

export type LayerUnit = 'meters' | 'pixels';

export interface SelectionProducerConfig {
  supported: Array<'click' | 'region' | 'path' | 'map-click'>;
  stableIdAccessor?: string;
  coordinateAccessor?: string;
  pathAccessor?: string;
  renderQueryId?: string;
}

export interface CameraEnvelopeCommon {
  producerVersion: number;
  support: { alphaCutoff?: number; antialiasBufferPx: number };
  capabilities: {
    supportsLive: boolean;
    supportsPrediction: boolean;
    maxPredictionHorizonMs: number;
    nominalUpdateHz: number;
    frameEvolution: 'revision-step' | 'continuous';
  };
}

export type CameraEnvelopeConfig =
  | (CameraEnvelopeCommon & {
      producer: 'hexagon-cell';
      positionAccessor: string;
      radius: { param: string; unit: 'meters' };
      coverage: { prop: 'coverage' };
      elevation: {
        valueField: 'elevationValue';
        rangeProp: 'elevationRange';
        scaleProp: 'elevationScale';
        domainProp: 'elevationDomain';
      };
    })
  | (CameraEnvelopeCommon & {
      producer: 'heatmap-kernel';
      positionAccessor: string;
      weightAccessor?: string;
      radius: { prop: 'radiusPixels'; unit: 'pixels' };
    })
  | (CameraEnvelopeCommon & {
      producer: 'scatter-point';
      positionAccessor: string;
      radius: { prop: 'getRadius'; unitProp: 'radiusUnits'; scaleProp: 'radiusScale' };
      minPixelsProp: 'radiusMinPixels';
      maxPixelsProp: 'radiusMaxPixels';
    })
  | (CameraEnvelopeCommon & {
      producer: 'line-path';
      sourcePositionAccessor: string;
      targetPositionAccessor: string;
      widthAccessor?: string;
      width: { prop: 'getWidth'; unitProp: 'widthUnits'; scaleProp: 'widthScale' };
      minPixelsProp: 'widthMinPixels';
      maxPixelsProp: 'widthMaxPixels';
    })
  | (CameraEnvelopeCommon & {
      producer: 'trip-path';
      pathAccessor: string;
      width: { prop: 'getWidth'; unitProp: 'widthUnits'; scaleProp: 'widthScale' };
      minPixelsProp: 'widthMinPixels';
      maxPixelsProp: 'widthMaxPixels';
    })
  | (CameraEnvelopeCommon & {
      producer: 'polygon-extrusion';
      polygonAccessor: string;
      elevationAccessor?: string;
      baseMeters: number;
      elevationScale: number;
      elevationUnit: 'meters';
      wrapMode: 'geometry' | 'full-world';
    });

export interface CameraCalibrationConfig {
  version: number;
  referenceZoom: number;
  referenceSafeAreaPx: number;
  metrics: Record<string, { unit: string; lo: number; hi: number; source: string }>;
}

export interface LayerConfig {
  id: string;
  type: string;
  dataRef: string;
  props?: Record<string, VisualizationLayerValue>;
  accessors?: Record<string, string>;
  rendererVersion: number;
  selection: SelectionProducerConfig;
  cameraEnvelope: CameraEnvelopeConfig;
  cameraCalibration: CameraCalibrationConfig;
  onClick?: string;
  analytics?: VisualizationLayerAnalyticsConfig;
}

export type VisualizationLayerValue =
  | VisualizationParameterValue
  | number[]
  | Record<string, VisualizationParameterValue>;

export interface VisualizationParameterConfig {
  key: string;
  label: string;
  control: 'slider' | 'switch' | 'select' | 'number';
  default: VisualizationParameterValue;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  options?: VisualizationParameterOption[];
}

export interface VisualizationParameterOption {
  label: string;
  value: VisualizationParameterValue;
  description?: string;
}

export interface VisualizationLayerRenderOptions {
  /** Frame-local source time; does not resolve data or change authored parameters. */
  animationTime?: number;
  selectedLineIds?: readonly string[];
  idPrefix?: string;
  interactive?: boolean;
  transitions?: boolean;
}

export type ResolvedLayerSupport =
  | {
      producer: 'hexagon-cell';
      positionAccessorId: string;
      radiusMeters: number;
      coverage: number;
      elevationRange: [number, number];
      elevationScale: number;
      elevationDomain: [number, number];
      antialiasBufferPx: number;
    }
  | {
      producer: 'heatmap-kernel';
      positionAccessorId: string;
      weightAccessorId?: string;
      weightDefault?: number;
      radiusPixels: number;
      alphaCutoff: number;
      antialiasBufferPx: number;
    }
  | {
      producer: 'scatter-point';
      positionAccessorId: string;
      radius: UnitValue;
      radiusScale: number;
      radiusMinPixels?: number;
      radiusMaxPixels?: number;
      antialiasBufferPx: number;
      billboard: true;
    }
  | {
      producer: 'line-path';
      sourcePositionAccessorId: string;
      targetPositionAccessorId: string;
      widthAccessorId?: string;
      width: UnitValue;
      widthScale: number;
      widthMinPixels?: number;
      widthMaxPixels?: number;
      antialiasBufferPx: number;
    }
  | {
      producer: 'trip-path';
      pathAccessorId: string;
      width: UnitValue;
      widthScale: number;
      widthMinPixels?: number;
      widthMaxPixels?: number;
      antialiasBufferPx: number;
      billboard: true;
      jointRounded: true;
      capRounded: true;
    }
  | {
      producer: 'polygon-extrusion';
      polygonAccessorId: string;
      elevationAccessorId?: string;
      elevationDefaultMeters?: number;
      baseMeters: number;
      elevationScale: number;
      elevationUnit: 'meters';
      wrapMode: 'geometry' | 'full-world';
      antialiasBufferPx: number;
    };

export interface ResolvedLayerDescriptor {
  schemaVersion: 1;
  catalogRevision: string;
  visualizationId: string;
  visualizationRevision: string;
  datasetId: string;
  dataRevision: string;
  layerId: string;
  layerType: string;
  rendererVersion: number;
  rendererLibraryVersion: string;
  declaredProps: Readonly<Record<string, VisualizationLayerValue>>;
  resolvedProps: Record<string, unknown>;
  accessorIds: Record<string, string>;
  resolvedSupport: ResolvedLayerSupport;
  selection?: SelectionProducerConfig;
  cameraEnvelope: CameraEnvelopeConfig;
  cameraCalibration: CameraCalibrationConfig;
  resolvedLayerDigest: string;
}

export interface ResolvedLayerRuntime {
  descriptor: ResolvedLayerDescriptor;
  data: readonly CustomObject[];
}

export interface ResolveLayerDescriptorInput {
  catalogRevision: string;
  visualization: VisualizationConfig;
  dataset: DatasetConfig;
  dataFile: DataFileConfig;
  dataRevision: string;
  layer: LayerConfig;
  rowCount: number;
  params: VisualizationParameterValues;
  state: Record<string, unknown>;
  runtimeDerivedProps?: Record<string, unknown>;
  runtimeDerivedSupport?: Record<string, unknown>;
}

export interface ResolvedVisualizationRuntime {
  config: VisualizationConfig;
  dataset: DatasetConfig;
  primaryFile?: DataFileConfig;
  primaryData: CustomObject[];
  layers: DeckglLayer[];
  resolvedLayers: ResolvedLayerRuntime[];
  createLayers: (options?: VisualizationLayerRenderOptions) => DeckglLayer[];
  mapStyle: string;
  initialViewState: CameraView;
  cameraConstraints: VisualizationCameraConstraints;
  effects: Effect[];
  getTooltip?: (info: PickingInfo<CustomObject>) => string | null;
  pickingRadius: number;
  animation?: VisualizationAnimationConfig;
  analytics: VisualizationAnalytics;
  effectiveParams: VisualizationParameterValues;
  adaptiveDefaults?: AdaptiveVisualizationDefaults;
}

export interface ResolvedVisualizationShell {
  config: VisualizationConfig;
  dataset: DatasetConfig;
  primaryFile?: DataFileConfig;
  mapStyle: string;
  initialViewState: CameraView;
  cameraConstraints: VisualizationCameraConstraints;
}

export interface VisualizationCameraConstraints {
  minZoom: number;
  maxZoom: number;
  minPitch: number;
  maxPitch: number;
}

export interface VisualizationRuntimeContext {
  params: VisualizationParameterValues;
  manualParameterKeys?: readonly string[];
  state: Record<string, unknown>;
  clickHandlers: Record<string, (info: PickingInfo<CustomObject>) => boolean>;
  viewportSize?: ViewportSize;
  layerRenderOptions?: VisualizationLayerRenderOptions;
  datasetOverride?: UploadedDatasetOverride;
}

export interface VisualizationLayerAnalytics {
  id: string;
  kind: VisualizationLayerKind;
  rowCount: number;
  bbox?: [number, number, number, number];
  bboxAreaKm2?: number;
  radiusMeters?: number;
  maxClusterCount?: number;
  maxElevationValue?: number;
  elevationScale?: number;
  elevationRange?: [number, number];
  elevationDomain?: [number, number];
  maxElevationMeters?: number;
  maxWeightValue?: number;
}

export interface VisualizationAnalytics {
  layers: VisualizationLayerAnalytics[];
  primaryLayer?: VisualizationLayerAnalytics;
  combinedBbox?: [number, number, number, number];
  combinedBboxAreaKm2?: number;
}

export interface AdaptiveVisualizationMetrics {
  rowCount: number;
  bbox: [number, number, number, number];
  center: [number, number];
  widthKm: number;
  heightKm: number;
  areaKm2: number;
  densityPerKm2: number;
  radiusMeters: number;
  occupiedBinCount: number;
  meanBinCount: number;
  p99BinCount: number;
  maxBinCount: number;
}

export interface AdaptiveVisualizationDefaults {
  parameterPatch: VisualizationParameterValues;
  initialViewState: CameraView;
  metrics: AdaptiveVisualizationMetrics;
}
