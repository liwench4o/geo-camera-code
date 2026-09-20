import type { CameraMovement, CameraView, PlaybackSegment, TargetCamera, TargetCameras } from '../interfaces';
import { interpolateCameraView } from '../camera/interpolation';
import { createTargetFromView, getTargetIdentity, isCameraTarget } from '../camera/selection';
import type { ViewportSpec } from '../camera/geometry/types';
import { compileLegacyMovementTrajectory, resolveTrajectoryViewport } from '../camera/trajectory/legacy';
import { compileRuntimeTrajectory, sampleCameraTrajectory } from '../camera/trajectory/sampler';
import {
  validateAuthorizedCertifiedTrajectoryPlan,
  validateCommittedTrajectoryPlan,
  validateCommittedTrajectoryPlanForMovement,
} from '../camera/trajectory/validation';
import type { CameraTarget } from '../camera/types';
import { getCameraPlanningViewport, withPlaybackPlanningViewport } from './planning-viewport';

const COORDINATE_EPSILON = 1e-6;
const VIEW_EPSILON = 1e-3;

export interface PlaybackPlan {
  segments: PlaybackSegment[];
  timelineData: TargetCameras[];
  totalTime: number;
}

export interface PlaybackPlanOptions {
  trajectoryEnabled?: boolean;
  viewport?: ViewportSpec;
}

export class PlaybackPlanError extends Error {
  readonly code: 'trajectory-plan-invalid' | 'trajectory-compilation-failed' | 'trajectory-missing';
  readonly segmentId: string;

  constructor(
    code: 'trajectory-plan-invalid' | 'trajectory-compilation-failed' | 'trajectory-missing',
    segmentId: string,
    detail: string,
  ) {
    super(`${code} for ${segmentId}: ${detail}`);
    this.name = 'PlaybackPlanError';
    this.code = code;
    this.segmentId = segmentId;
  }
}

export interface PlaybackPosition {
  segment: PlaybackSegment;
  segmentIndex: number;
  offsetMs: number;
}

function createId(prefix: string, index: number) {
  return `${prefix}-${index}`;
}

function getCameraTarget(cameraMovement: CameraMovement): CameraTarget {
  return isCameraTarget(cameraMovement.targetSnapshot)
    ? cameraMovement.targetSnapshot
    : createTargetFromView(cameraMovement.finalViewState, 'none');
}

function getTargetName(target: CameraTarget) {
  return target.label ?? `[${target.center[0]}, ${target.center[1]}]`;
}

function getTargetKey(cameraMovement: CameraMovement, target: CameraTarget, sourceIndex?: number) {
  if (cameraMovement.targetId) {
    return cameraMovement.targetId;
  }

  if (target.type === 'none') {
    return `current-view:${cameraMovement.id ?? sourceIndex ?? getTargetIdentity(target)}`;
  }

  return getTargetIdentity(target);
}

function isClose(a: number, b: number, epsilon: number) {
  return Math.abs(a - b) <= epsilon;
}

export function areViewsContinuous(previousView: CameraView, nextView: CameraView) {
  return (
    isClose(previousView.longitude, nextView.longitude, COORDINATE_EPSILON) &&
    isClose(previousView.latitude, nextView.latitude, COORDINATE_EPSILON) &&
    isClose(previousView.zoom, nextView.zoom, VIEW_EPSILON) &&
    isClose(previousView.pitch, nextView.pitch, VIEW_EPSILON) &&
    isClose(previousView.bearing, nextView.bearing, VIEW_EPSILON)
  );
}

function getGapDuration(nextCamera: CameraMovement) {
  // Preserve explicit legacy timing, but never invent an interval for a cut.
  return Math.max(0, nextCamera.interpolationDuration) + Math.max(0, nextCamera.startDelay ?? 0);
}

function getGapInterpolator(nextCamera: CameraMovement) {
  return nextCamera.interpolationType === 'linear' ? 'linear' : 'fly';
}

function createGapCamera(
  previousCamera: CameraMovement,
  nextCamera: CameraMovement,
  duration: number,
  index: number,
): CameraMovement {
  return {
    id: createId('gap-camera', index),
    name: 'gap-transition',
    title: 'Gap transition',
    category: 'transition',
    purpose: 'transition',
    shot: 'transition',
    initViewState: previousCamera.finalViewState,
    finalViewState: nextCamera.initViewState,
    duration,
    stay: 0,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
  };
}

function createTimelineGapCamera(viewState: CameraView, duration: number, index: number): CameraMovement {
  return {
    id: createId('timeline-gap', index),
    name: 'timeline-gap',
    title: 'Timeline gap',
    category: 'undefined',
    purpose: 'timeline-gap',
    shot: 'timeline-gap',
    initViewState: viewState,
    finalViewState: viewState,
    duration,
    stay: 0,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
  };
}

function createTargetCamera(segment: PlaybackSegment): TargetCamera {
  return {
    id: segment.id,
    name: segment.camera.name,
    title: segment.camera.title,
    category: segment.camera.category,
    start: segment.start,
    duration: segment.duration,
    stay: segment.stay,
    sourceIndex: segment.sourceIndex,
    sourceCameraId: segment.sourceCameraId,
    generated: segment.generated,
    editable: segment.editable,
  };
}

function addSegmentToTimeline(timelineData: TargetCameras[], segment: PlaybackSegment, previousTargetKey?: string) {
  if (segment.generated) {
    return;
  }

  const camera = createTargetCamera(segment);

  const target = getCameraTarget(segment.camera);
  const targetKey = getTargetKey(segment.camera, target, segment.sourceIndex);
  const lastTarget = timelineData[timelineData.length - 1];

  if (lastTarget && previousTargetKey === targetKey) {
    lastTarget.cameras.push(camera);
    lastTarget.targetEnd = segment.end;
    return targetKey;
  }

  timelineData.push({
    // A target may recur later in the story. Each contiguous group needs its
    // own row identity, independent of the target identity used for grouping.
    key: JSON.stringify([targetKey, segment.sourceIndex]),
    name: segment.camera.timelineTargetName || getTargetName(target),
    type: target.type,
    location: target.center,
    targetStart: segment.start,
    targetEnd: segment.end,
    cameras: [camera],
  });
  return targetKey;
}

function createSegment(camera: CameraMovement, start: number, index: number, sourceIndex?: number): PlaybackSegment {
  const generated =
    camera.name === 'gap-transition' ? 'gap-transition' : camera.name === 'timeline-gap' ? 'timeline-gap' : undefined;
  return {
    id: camera.id ?? createId(generated ? 'gap-segment' : 'camera-segment', index),
    camera,
    start,
    duration: Math.max(0, camera.duration),
    stay: Math.max(0, camera.stay),
    end: start + Math.max(0, camera.duration) + Math.max(0, camera.stay),
    sourceIndex,
    sourceCameraId: sourceIndex !== undefined ? camera.id : undefined,
    generated,
    editable: generated === undefined,
    interpolator: generated === 'gap-transition' ? getGapInterpolator(camera) : 'fly',
  };
}

function compileSegmentTrajectory(segment: PlaybackSegment, viewport: ViewportSpec) {
  const attached = segment.camera.trajectoryPlan;
  if (attached !== undefined) {
    const validated = validateCommittedTrajectoryPlan(attached);
    if (validated.status === 'error') {
      throw new PlaybackPlanError('trajectory-plan-invalid', segment.id, validated.reason);
    }
    const movementValidated = validateCommittedTrajectoryPlanForMovement(validated.value, segment.camera);
    if (movementValidated.status === 'error' || validated.value.trajectory.durationMs !== segment.duration) {
      throw new PlaybackPlanError(
        'trajectory-plan-invalid',
        segment.id,
        movementValidated.status === 'error'
          ? movementValidated.reason
          : 'committed trajectory duration does not match the segment',
      );
    }
    const authorized =
      validated.value.certification.status === 'certified'
        ? validateAuthorizedCertifiedTrajectoryPlan(validated.value)
        : validated;
    if (authorized.status === 'error') {
      throw new PlaybackPlanError('trajectory-plan-invalid', segment.id, authorized.reason);
    }
    // A viewport change may require a new framing check, but cannot change the
    // author's applied path. Certification is evidence, not permission to play.
    const compiled = compileRuntimeTrajectory(authorized.value.trajectory);
    if (compiled.status === 'error') {
      throw new PlaybackPlanError('trajectory-compilation-failed', segment.id, compiled.reason);
    }
    return compiled.value;
  }

  let serialized;
  try {
    serialized = compileLegacyMovementTrajectory(
      { ...segment.camera, duration: segment.duration, stay: segment.stay },
      viewport,
      segment.interpolator,
    );
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : String(caught);
    throw new PlaybackPlanError('trajectory-compilation-failed', segment.id, detail);
  }
  const compiled = compileRuntimeTrajectory(serialized);
  if (compiled.status === 'error') {
    throw new PlaybackPlanError('trajectory-compilation-failed', segment.id, compiled.reason);
  }
  return compiled.value;
}

export function derivePlaybackPlan(
  cameraMovementList: CameraMovement[],
  options: PlaybackPlanOptions = {},
): PlaybackPlan {
  const segments: PlaybackSegment[] = [];
  const timelineData: TargetCameras[] = [];
  let currentTime = 0;
  let previousTargetKey: string | undefined;

  for (let sourceIndex = 0; sourceIndex < cameraMovementList.length; sourceIndex++) {
    const camera = cameraMovementList[sourceIndex];
    const previousCamera = cameraMovementList[sourceIndex - 1];
    const gapDuration = previousCamera ? getGapDuration(camera) : 0;

    if (previousCamera && gapDuration > 0) {
      const continuous = areViewsContinuous(previousCamera.finalViewState, camera.initViewState);
      const gapCamera = withPlaybackPlanningViewport(
        continuous
          ? createTimelineGapCamera(previousCamera.finalViewState, gapDuration, sourceIndex)
          : createGapCamera(previousCamera, camera, gapDuration, sourceIndex),
        continuous
          ? getCameraPlanningViewport(previousCamera)
          : (getCameraPlanningViewport(camera) ?? getCameraPlanningViewport(previousCamera)),
      );
      const gapSegment = createSegment(gapCamera, currentTime, segments.length, sourceIndex);
      gapSegment.sourceCameraId = camera.id;
      gapSegment.interpolator = getGapInterpolator(camera);
      segments.push(gapSegment);
      currentTime = gapSegment.end;
    }

    const segment = createSegment(camera, currentTime, segments.length, sourceIndex);
    segments.push(segment);
    previousTargetKey = addSegmentToTimeline(timelineData, segment, previousTargetKey);
    currentTime = segment.end;
  }

  const plannedSegments =
    options.trajectoryEnabled !== false
      ? segments.map((segment) => ({
          ...segment,
          trajectory: compileSegmentTrajectory(
            segment,
            getCameraPlanningViewport(segment.camera) ?? resolveTrajectoryViewport(options.viewport),
          ),
          trajectoryRequired: true,
        }))
      : segments;

  return {
    segments: plannedSegments,
    timelineData,
    totalTime: currentTime,
  };
}

export function getPlaybackPositionAtTime(segments: PlaybackSegment[], timeMs: number): PlaybackPosition | undefined {
  if (segments.length === 0) {
    return undefined;
  }

  const clampedTime = Math.max(0, timeMs);
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (clampedTime >= segment.start && clampedTime < segment.end) {
      return {
        segment,
        segmentIndex: index,
        offsetMs: clampedTime - segment.start,
      };
    }
  }

  const lastSegment = segments[segments.length - 1];
  if (clampedTime >= lastSegment.end) {
    return {
      segment: lastSegment,
      segmentIndex: segments.length - 1,
      offsetMs: lastSegment.duration + lastSegment.stay,
    };
  }

  return {
    segment: segments[0],
    segmentIndex: 0,
    offsetMs: 0,
  };
}

export function getSourceIndexAtTime(segments: PlaybackSegment[], timeMs: number) {
  return getPlaybackPositionAtTime(segments, timeMs)?.segment.sourceIndex ?? -1;
}

export function isPlaybackComplete(currentTimeMs: number, totalTimeMs: number) {
  return currentTimeMs >= Math.max(0, totalTimeMs);
}

export function getViewAtPlaybackTime(segments: PlaybackSegment[], timeMs: number): CameraView | undefined {
  const position = getPlaybackPositionAtTime(segments, timeMs);
  if (!position) {
    return undefined;
  }

  const { segment, offsetMs } = position;
  if (segment.trajectory) {
    return stripCameraTransition(sampleCameraTrajectory(segment.trajectory, offsetMs));
  }
  if (segment.trajectoryRequired) {
    throw new PlaybackPlanError('trajectory-missing', segment.id, 'enabled segment has no compiled trajectory');
  }
  if (offsetMs >= segment.duration) {
    return stripCameraTransition(segment.camera.finalViewState);
  }

  return interpolateCameraView(
    segment.camera.initViewState,
    segment.camera.finalViewState,
    segment.duration > 0 ? offsetMs / segment.duration : 1,
  );
}

export function stripCameraTransition(viewState: CameraView): CameraView {
  return {
    ...viewState,
    transitionDuration: 0,
    transitionEasing: undefined,
    transitionInterpolator: undefined,
    onTransitionEnd: undefined,
  };
}

export function getStoppedPlaybackView(
  segments: PlaybackSegment[],
  timeMs: number,
  fallbackViewState: CameraView,
): CameraView {
  const timelineView = getViewAtPlaybackTime(segments, timeMs);
  return stripCameraTransition(timelineView ?? fallbackViewState);
}
