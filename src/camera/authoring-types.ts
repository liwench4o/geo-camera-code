import type { CameraView } from '../interfaces';
import type { CameraFramingTuning, CameraOptionSelection, ViewportSize } from './types';

/** Independent movement requests; zoomDelta is final zoom minus initial zoom. */
export interface CameraMotionIntent {
  zoomDelta?: number;
  startPitch?: number;
  endPitch?: number;
  startBearing?: number;
  bearingSweep?: number;
}

export interface CameraCompositionIntent {
  context?:
    | { kind: 'bounds'; bounds: [number, number, number, number] }
    | { kind: 'view'; view: CameraView; viewport: ViewportSize };
  anchor?: 'ground' | 'visual';
  offsetRatio?: [number, number];
}

export interface CameraSourceIntent {
  kind: 'current-view' | 'previous-camera' | 'reference-view';
  view: CameraView;
}

/** Inputs the author owns; the committed trajectory remains the replay authority. */
export interface CameraAuthoringSpec {
  version: 1 | 2;
  targetId: string;
  snapshotRevision?: string;
  sceneRevision?: string;
  recipeId: string;
  optionSelection?: CameraOptionSelection;
  adjustments: CameraFramingTuning;
  motion?: CameraMotionIntent;
  composition?: CameraCompositionIntent;
  source?: CameraSourceIntent;
  /** Legacy metadata retained for round trips; the actual timeline gap controls transitions. */
  transition?: 'auto' | 'cut';
  manualViews?: { initial?: CameraView; final?: CameraView };
  timing?: { duration?: number; stay?: number; startDelay?: number };
  planningViewport: ViewportSize;
}

/** Engineering observations, deliberately separate from continuous certificates. */
export interface CameraFramingReport {
  status: 'passed' | 'warning' | 'incomplete';
  scope: 'whole-shot' | 'endpoints' | 'route-window' | 'targetless';
  sampleCount: number;
  minMarginPx?: number;
  worstTimeMs?: number;
  messages: string[];
  inputRevision?: string;
  requestedMotion?: CameraMotionIntent;
  resolvedMotion?: CameraMotionIntent;
}
