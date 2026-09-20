import type { CameraView, PlaybackSegment } from '../interfaces';
import { getViewAtPlaybackTime, isPlaybackComplete, stripCameraTransition } from './playback';

export interface TrajectoryPlaybackDriverOptions {
  segments: PlaybackSegment[];
  startTimeMs: number;
  totalTimeMs: number;
  now: () => number;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  onFrame: (timeMs: number, view: CameraView) => void;
  onComplete: () => void;
  onError: (error: unknown) => void;
}

function finiteSemanticView(view: CameraView): boolean {
  return [view.longitude, view.latitude, view.zoom, view.pitch, view.bearing].every(Number.isFinite);
}

export interface TrajectoryPlaybackDriver {
  cancel(): void;
  setSuspended(suspended: boolean): void;
}

export function startTrajectoryPlaybackDriver(options: TrajectoryPlaybackDriverOptions): TrajectoryPlaybackDriver {
  let frameId: number | undefined;
  let terminal = false;
  let errorReported = false;
  let suspended = false;
  let previousFrameTimeMs = 0;
  let currentTimeMs = Math.max(0, Math.min(options.startTimeMs, options.totalTimeMs));

  const cancelScheduledFrame = () => {
    if (frameId === undefined) return;
    const pending = frameId;
    frameId = undefined;
    try {
      options.cancelFrame(pending);
    } catch {
      // Scheduler cleanup must not escape playback containment.
    }
  };

  const reportError = (error: unknown) => {
    if (errorReported) return;
    errorReported = true;
    terminal = true;
    cancelScheduledFrame();
    try {
      options.onError(error);
    } catch {
      // Error observers cannot restart or escape a failed driver.
    }
  };

  const complete = () => {
    if (terminal) return;
    cancelScheduledFrame();
    try {
      terminal = true;
      options.onComplete();
    } catch (error) {
      reportError(error);
    }
  };

  const cancel = () => {
    if (terminal) return;
    terminal = true;
    cancelScheduledFrame();
  };

  const setSuspended = (nextSuspended: boolean) => {
    if (terminal || nextSuspended === suspended) return;
    suspended = nextSuspended;
    cancelScheduledFrame();
    if (suspended) return;
    try {
      previousFrameTimeMs = readClock();
      schedule();
    } catch (error) {
      reportError(error);
    }
  };
  const handle = { cancel, setSuspended };
  const readClock = () => {
    const timeMs = options.now();
    if (!Number.isFinite(timeMs)) throw new TypeError('trajectory playback clock must be finite');
    return timeMs;
  };

  if (!Number.isFinite(options.startTimeMs) || !Number.isFinite(options.totalTimeMs) || options.totalTimeMs < 0) {
    reportError(new TypeError('trajectory playback times must be finite and total time nonnegative'));
    return handle;
  }
  if (options.segments.length === 0) {
    complete();
    return handle;
  }

  try {
    previousFrameTimeMs = readClock();
  } catch (error) {
    reportError(error);
    return handle;
  }

  const schedule = () => {
    if (terminal || suspended) return;
    try {
      frameId = options.requestFrame(tick);
      if (!Number.isFinite(frameId)) throw new TypeError('trajectory frame scheduler returned an invalid id');
    } catch (error) {
      reportError(error);
    }
  };

  const emitFrame = () => {
    const sampled = getViewAtPlaybackTime(options.segments, currentTimeMs);
    if (!sampled) throw new TypeError('trajectory playback produced no camera view');
    const view = stripCameraTransition(sampled);
    if (!finiteSemanticView(view)) throw new RangeError('trajectory playback produced a non-finite camera view');
    options.onFrame(currentTimeMs, view);
    if (isPlaybackComplete(currentTimeMs, options.totalTimeMs)) complete();
    else schedule();
  };

  const tick = () => {
    frameId = undefined;
    if (terminal || suspended) return;
    try {
      const nowMs = readClock();
      // A slow frame must not skip large portions of the story or replay hidden time.
      const elapsedMs = Math.max(0, Math.min(100, nowMs - previousFrameTimeMs));
      previousFrameTimeMs = nowMs;
      currentTimeMs = Math.min(options.totalTimeMs, currentTimeMs + elapsedMs);
      emitFrame();
    } catch (error) {
      reportError(error);
    }
  };

  try {
    emitFrame();
  } catch (error) {
    reportError(error);
  }
  return handle;
}
