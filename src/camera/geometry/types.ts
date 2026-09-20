export type LngLat = [longitude: number, latitude: number];
export type WorldPosition = [longitude: number, latitude: number, heightMeters?: number];
/** `pixels` always denotes true screen-facing CSS-pixel support in strict adapter v1. */
export type UnitValue = { value: number; unit: 'meters' | 'pixels' };
export type WrapMode = 'minimum-arc' | 'full-world';
export type SupportGuarantee = 'renderer-exact' | 'conservative' | 'legacy-approximation';

export interface WrapMetadata {
  wrapReference: number;
  worldOffset: number;
  wrapMode: WrapMode;
}

export interface PixelClamp {
  minPx?: number;
  maxPx?: number;
  supportBufferPx?: number;
}

export type VisualPrimitive =
  /** Normalized finite disc support; a pixel disc is never a ground-plane glyph. */
  | { kind: 'point-disc'; position: WorldPosition; radius: UnitValue; pixelClamp?: PixelClamp }
  | {
      kind: 'screen-rect';
      position: WorldPosition;
      widthPx: number;
      heightPx: number;
      supportBufferPx?: number;
    }
  | {
      kind: 'extruded-footprint';
      rings: LngLat[][];
      baseMeters: number;
      topMeters: number | number[];
      supportBufferPx?: number;
    }
  | {
      /**
       * Complete renderer tessellation vertices for a corridor with round joins/caps.
       * Segments are the renderer's screen-space triangles; no implicit lng/lat curve is inferred.
       */
      kind: 'path-corridor';
      positions: WorldPosition[];
      halfWidth: UnitValue;
      pixelClamp?: PixelClamp;
    }
  | { kind: 'polygon'; rings: WorldPosition[][]; supportBufferPx?: number }
  | { kind: 'mesh-support'; vertices: WorldPosition[]; conservative: true; supportBufferPx?: number };

export interface ContentMetrics {
  elevation: number;
  density: number;
  coverage: number;
  dispersion: number;
  elongation: number;
  orientationDeg?: number;
  curvature: number;
  calibrationVersion: number;
  fallbackReasons: string[];
}

export interface TargetProvenance {
  datasetId: string;
  visualizationId: string;
  layerId: string;
  dataRevision: string;
  visualizationRevision: string;
  producerId: string;
  producerVersion: number;
  sceneRevision: string;
  resolvedLayerDigest: string;
}

export interface VisualTargetFrame {
  primitives: VisualPrimitive[];
  anchor: [longitude: number, latitude: number, heightMeters: number];
  metrics: ContentMetrics;
  wrap: WrapMetadata;
}

export interface SnapshotEnvelope {
  binding: 'snapshot';
  id: string;
  supportGuarantee: SupportGuarantee;
  provenance: TargetProvenance;
  revisionDependencies?: readonly string[];
  revision: string;
  frame: VisualTargetFrame;
}

export type EnvelopeResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'stale' | 'unavailable' | 'unsupported' | 'error'; reason: string };

export interface ViewportSpec {
  width: number;
  height: number;
}

export interface ProjectionOptions {
  meterSupportTolerancePx: number;
  meterSupportIntervalBudget: number;
}

export interface ScreenRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ProjectedFootprint {
  primitiveIndex: number;
  kind: VisualPrimitive['kind'];
  bounds: ScreenRect;
  vertices: Array<[number, number, number?]>;
  sourceHeights: number[];
  inflationPx: number;
}

export type FootprintResult = EnvelopeResult<ProjectedFootprint>;
