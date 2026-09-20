import type { CameraView } from '../../interfaces';
import type { VisualPrimitive } from '../geometry/types';

export interface SerializedCameraView {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface CertifiedFrameCertificate {
  kind: 'strict-frame-v1';
  inputDigest: string;
  envelopeDigest: string;
  viewportDigest: string;
  constraintDigest: string;
  solverVersion: string;
  viewDigest: string;
  slackPx: number;
}

export interface CameraViewIntervalBounds {
  longitudeUnwrapped: [number, number];
  latitude: [number, number];
  zoom: [number, number];
  pitch: [number, number];
  bearingUnwrapped: [number, number];
}

export type TrajectoryBoundsResult =
  | { status: 'bounded'; value: CameraViewIntervalBounds; method: 'constant' | 'channel-monotone' }
  | { status: 'unknown'; reason: 'compatibility-fly-bound-unavailable' };

export interface CameraTrajectoryKeyframe {
  timeMs: number;
  view: SerializedCameraView;
  frameCertificate?: CertifiedFrameCertificate;
}

export type TrajectorySamplerId = 'hold-v1' | 'linear-v1' | 'minimum-jerk-v1' | 'deck-fly-v1' | 'legacy-linear-v1';

export type SerializedCameraTrajectory =
  | {
      kind: 'hold';
      sampler: 'hold-v1';
      samplerVersion: '1';
      durationMs: number;
      keyframes: [CameraTrajectoryKeyframe, CameraTrajectoryKeyframe];
    }
  | {
      kind: 'keyframed';
      sampler: 'linear-v1' | 'minimum-jerk-v1';
      samplerVersion: '1';
      durationMs: number;
      keyframes: CameraTrajectoryKeyframe[];
    }
  | {
      kind: 'legacy-fly';
      sampler: 'deck-fly-v1';
      samplerVersion: '1';
      durationMs: number;
      viewport: { width: number; height: number };
      initView: SerializedCameraView;
      finalView: SerializedCameraView;
    }
  | {
      kind: 'legacy-linear';
      sampler: 'legacy-linear-v1';
      samplerVersion: '1';
      durationMs: number;
      initView: SerializedCameraView;
      finalView: SerializedCameraView;
    };

export interface RuntimeCameraTrajectory {
  serialized: SerializedCameraTrajectory;
  digest: string;
  sample(localTimeMs: number): CameraView;
  bounds(startMs: number, endMs: number): TrajectoryBoundsResult;
  criticalTimes(startMs: number, endMs: number): number[];
}

export type TrajectoryCertificateBoundMethod =
  | 'constant-frame'
  | 'interval-arithmetic'
  | 'conservative-swept-footprint';

export interface TrajectoryCertificateInterval {
  startMs: number;
  endMs: number;
  slackLowerBoundPx: number;
  boundMethod: TrajectoryCertificateBoundMethod;
}

export interface TrajectoryCertificate {
  kind: 'visibility-v1';
  trajectoryDigest: string;
  envelopeDigest: string;
  viewportDigest: string;
  constraintDigest: string;
  validity: { domain: 'story-local'; startMs: 0; endMs: number };
  intervals: TrajectoryCertificateInterval[];
}

export interface TrajectorySlackSample {
  timeMs: number;
  slackPx: number | null;
}

export interface TrajectorySlackObservations {
  samples: TrajectorySlackSample[];
  minimumSlackPx: number | null;
  evaluationCount: number;
  intervalBoundCount: number;
}

export type TrajectoryCertification =
  | { status: 'certified'; certificate: TrajectoryCertificate }
  | { status: 'unsafe'; worstTimeMs: number; slackPx: number; violations: ConstraintViolation[] }
  | { status: 'unknown'; reason: 'work-budget-exceeded' | 'interval-bound-unavailable' }
  | { status: 'legacy-unverified'; observations: TrajectorySlackObservations };

export interface CommittedTrajectoryPlan {
  inputDigest: string;
  trajectory: SerializedCameraTrajectory;
  trajectoryDigest: string;
  certification: TrajectoryCertification;
}

export interface ConstraintViolation {
  reason:
    | 'invalid-parameters'
    | 'unsupported-projection'
    | 'outer-safe-region'
    | 'blocking-occlusion'
    | 'non-finite-view';
  message: string;
  primitiveIndex?: number;
  primitiveKind?: VisualPrimitive['kind'];
  slackPx?: number;
  occlusionId?: string;
}
