import type { PlaybackSegment } from '../interfaces';
import { compileLegacyMovementTrajectory } from '../camera/trajectory/legacy';
import { compileRuntimeTrajectory } from '../camera/trajectory/sampler';

export interface CurrentCameraPreviewSession {
  cameraIndex: number;
  segments: PlaybackSegment[];
  currentTimeMs: number;
  totalTimeMs: number;
  isPlaying: boolean;
}

interface StartCurrentCameraPreviewSessionInput {
  cameraIndex: number;
  segments: PlaybackSegment[];
  previousSession?: CurrentCameraPreviewSession;
}

function getTotalTimeMs(segments: PlaybackSegment[]) {
  return segments[segments.length - 1]?.end ?? 0;
}

export function createCurrentCameraPreviewSegments(segments: PlaybackSegment[]): PlaybackSegment[] {
  let currentTimeMs = 0;

  return segments.map((segment) => {
    const duration = Math.max(0, segment.duration);
    const previewSegment = {
      ...segment,
      start: currentTimeMs,
      duration,
      stay: 0,
      end: currentTimeMs + duration,
    };
    currentTimeMs = previewSegment.end;
    return previewSegment;
  });
}

export function createCurrentCameraPreviewResetSegments(segments: PlaybackSegment[]): PlaybackSegment[] {
  const firstSegment = segments[0];
  if (!firstSegment) {
    return [];
  }

  const camera = {
    ...firstSegment.camera,
    finalViewState: firstSegment.camera.initViewState,
    duration: 0,
    stay: 0,
  };
  const resetSegment: PlaybackSegment = {
    ...firstSegment,
    camera,
    start: 0,
    duration: 0,
    stay: 0,
    end: 0,
  };
  if (firstSegment.trajectoryRequired) {
    const compiled = compileRuntimeTrajectory(
      compileLegacyMovementTrajectory(camera, { width: 1, height: 1 }, firstSegment.interpolator),
    );
    if (compiled.status === 'error') throw new TypeError(compiled.reason);
    resetSegment.trajectory = compiled.value;
    resetSegment.trajectoryRequired = true;
  }
  return [resetSegment];
}

export function startCurrentCameraPreviewSession({
  cameraIndex,
  segments,
  previousSession,
}: StartCurrentCameraPreviewSessionInput): CurrentCameraPreviewSession {
  const totalTimeMs = getTotalTimeMs(segments);
  const canResume =
    previousSession?.cameraIndex === cameraIndex &&
    !previousSession.isPlaying &&
    previousSession.currentTimeMs < totalTimeMs;
  const currentTimeMs = canResume ? previousSession.currentTimeMs : 0;

  return {
    cameraIndex,
    segments,
    currentTimeMs,
    totalTimeMs,
    isPlaying: totalTimeMs > currentTimeMs,
  };
}

export function pauseCurrentCameraPreviewSession(
  session: CurrentCameraPreviewSession,
  timeMs = session.currentTimeMs,
): CurrentCameraPreviewSession {
  return {
    ...session,
    currentTimeMs: Math.max(0, Math.min(timeMs, session.totalTimeMs)),
    isPlaying: false,
  };
}

export function resetCurrentCameraPreviewSession(session: CurrentCameraPreviewSession): CurrentCameraPreviewSession {
  return {
    ...session,
    currentTimeMs: 0,
    isPlaying: false,
  };
}

export function completeCurrentCameraPreviewSession(session: CurrentCameraPreviewSession): CurrentCameraPreviewSession {
  return {
    ...session,
    currentTimeMs: session.totalTimeMs,
    isPlaying: false,
  };
}
