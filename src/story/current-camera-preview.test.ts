import type { CameraMovement, CameraView } from '../interfaces';
import { sampleCameraTrajectory } from '../camera/trajectory/sampler';
import { derivePlaybackPlan, getViewAtPlaybackTime } from './playback';
import {
  completeCurrentCameraPreviewSession,
  createCurrentCameraPreviewSegments,
  createCurrentCameraPreviewResetSegments,
  pauseCurrentCameraPreviewSession,
  resetCurrentCameraPreviewSession,
  startCurrentCameraPreviewSession,
} from './current-camera-preview';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function createView(zoom: number): CameraView {
  return {
    longitude: 0,
    latitude: 0,
    zoom,
    pitch: 0,
    bearing: 0,
    minZoom: 0,
    maxZoom: 20,
    minPitch: 0,
    maxPitch: 85,
  };
}

function createSegments(duration = 1000, stay = 250) {
  const camera: CameraMovement = {
    name: 'preview-camera',
    title: 'Preview camera',
    category: 'dynamic',
    initViewState: createView(10),
    finalViewState: createView(12),
    duration,
    stay,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
  };

  return derivePlaybackPlan([camera]).segments;
}

function createPreviewSegments(duration = 1000, stay = 250) {
  return createCurrentCameraPreviewSegments(createSegments(duration, stay));
}

function testPreviewSegmentsRemoveStayWithoutMutatingTimelineSegments() {
  const timelineSegments = createSegments();

  const previewSegments = createCurrentCameraPreviewSegments(timelineSegments);

  assert(previewSegments[0] !== timelineSegments[0], 'expected preview segment to be cloned');
  assert(previewSegments[0].stay === 0, `expected preview stay 0, received ${previewSegments[0].stay}`);
  assert(previewSegments[0].end === 1000, `expected preview end 1000, received ${previewSegments[0].end}`);
  assert(
    timelineSegments[0].stay === 250,
    `expected timeline stay to remain 250, received ${timelineSegments[0].stay}`,
  );
  assert(timelineSegments[0].end === 1250, `expected timeline end to remain 1250, received ${timelineSegments[0].end}`);
}

function testPreviewSegmentsRebuildCumulativeTimes() {
  const firstSegment = createSegments()[0];
  const secondSegment = {
    ...firstSegment,
    id: 'second-preview-segment',
    start: firstSegment.end,
    duration: 500,
    stay: 200,
    end: firstSegment.end + 700,
  };

  const previewSegments = createCurrentCameraPreviewSegments([firstSegment, secondSegment]);

  assert(
    previewSegments[1].start === 1000,
    `expected compacted second start 1000, received ${previewSegments[1].start}`,
  );
  assert(previewSegments[1].end === 1500, `expected compacted second end 1500, received ${previewSegments[1].end}`);
}

function testPreviewStartsFromBeginning() {
  const session = startCurrentCameraPreviewSession({
    cameraIndex: 2,
    segments: createPreviewSegments(),
  });

  assert(session.cameraIndex === 2, `expected camera index 2, received ${session.cameraIndex}`);
  assert(session.currentTimeMs === 0, `expected preview to start at 0, received ${session.currentTimeMs}`);
  assert(session.totalTimeMs === 1000, `expected total time 1000, received ${session.totalTimeMs}`);
  assert(session.isPlaying, 'expected a new preview session to be playing');
}

function testPreviewPausesAtExactEmittedTime() {
  const playing = startCurrentCameraPreviewSession({
    cameraIndex: 2,
    segments: createPreviewSegments(),
  });

  const paused = pauseCurrentCameraPreviewSession(playing, 375);

  assert(paused.currentTimeMs === 375, `expected exact pause time 375, received ${paused.currentTimeMs}`);
  assert(!paused.isPlaying, 'expected paused preview not to be playing');
}

function testPreviewResumesFromPausedTime() {
  const segments = createPreviewSegments();
  const playing = startCurrentCameraPreviewSession({ cameraIndex: 2, segments });
  const paused = pauseCurrentCameraPreviewSession(playing, 375);

  const resumed = startCurrentCameraPreviewSession({
    cameraIndex: 2,
    segments,
    previousSession: paused,
  });

  assert(resumed.currentTimeMs === 375, `expected resume time 375, received ${resumed.currentTimeMs}`);
  assert(!('startedAtMs' in resumed), 'resuming must not start an independent preview clock');
  assert(resumed.isPlaying, 'expected resumed preview to be playing');
}

function testPreviewResetReturnsToBeginningAndStops() {
  const playing = startCurrentCameraPreviewSession({
    cameraIndex: 2,
    segments: createPreviewSegments(),
  });

  const reset = resetCurrentCameraPreviewSession(playing);

  assert(reset.currentTimeMs === 0, `expected reset time 0, received ${reset.currentTimeMs}`);
  assert(!reset.isPlaying, 'expected reset preview to be stopped');
}

function testCompletedPreviewRestartsFromBeginning() {
  const segments = createPreviewSegments();
  const playing = startCurrentCameraPreviewSession({ cameraIndex: 2, segments });
  const completed = completeCurrentCameraPreviewSession(playing);

  const restarted = startCurrentCameraPreviewSession({
    cameraIndex: 2,
    segments,
    previousSession: completed,
  });

  assert(
    restarted.currentTimeMs === 0,
    `expected completed preview to restart at 0, received ${restarted.currentTimeMs}`,
  );
  assert(restarted.isPlaying, 'expected restarted preview to be playing');
}

function testResetSegmentsReturnInitialViewForZeroDurationCamera() {
  const segments = createPreviewSegments(0, 250);

  const resetView = getViewAtPlaybackTime(createCurrentCameraPreviewResetSegments(segments), 0);

  assert(resetView?.zoom === 10, `expected zero-duration reset to return initial zoom 10, received ${resetView?.zoom}`);
}

function testZeroDurationPreviewReturnsFinalView() {
  const previewView = getViewAtPlaybackTime(createPreviewSegments(0, 250), 0);

  assert(
    previewView?.zoom === 12,
    `expected zero-duration preview to return final zoom 12, received ${previewView?.zoom}`,
  );
}

function testEnabledPauseResumeAndScrubShareTheSameSamplerTime() {
  const camera: CameraMovement = {
    name: 'enabled-preview',
    title: 'Enabled preview',
    category: 'dynamic',
    initViewState: createView(10),
    finalViewState: createView(12),
    duration: 1000,
    stay: 250,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
  };
  const timeline = derivePlaybackPlan([camera], {
    trajectoryEnabled: true,
    viewport: { width: 1440, height: 900 },
  }).segments;
  const segments = createCurrentCameraPreviewSegments(timeline);
  const playing = startCurrentCameraPreviewSession({ cameraIndex: 0, segments });
  const paused = pauseCurrentCameraPreviewSession(playing, 375);
  const trajectory = paused.segments[0].trajectory;
  assert(trajectory, 'enabled preview retains its compiled trajectory');
  const direct = sampleCameraTrajectory(trajectory, paused.currentTimeMs);
  const scrubbed = getViewAtPlaybackTime(paused.segments, paused.currentTimeMs);
  assert(scrubbed?.zoom === direct.zoom, 'paused preview and scrub use identical trajectory time');

  const resumed = startCurrentCameraPreviewSession({
    cameraIndex: 0,
    segments,
    previousSession: paused,
  });
  assert(
    getViewAtPlaybackTime(resumed.segments, resumed.currentTimeMs)?.zoom === direct.zoom,
    'resume begins at the exact paused sampler output',
  );

  const reset = createCurrentCameraPreviewResetSegments(segments);
  assert(getViewAtPlaybackTime(reset, 0)?.zoom === camera.initViewState.zoom, 'enabled reset samples initial view');
}

testPreviewSegmentsRemoveStayWithoutMutatingTimelineSegments();
testPreviewSegmentsRebuildCumulativeTimes();
testPreviewStartsFromBeginning();
testPreviewPausesAtExactEmittedTime();
testPreviewResumesFromPausedTime();
testPreviewResetReturnsToBeginningAndStops();
testCompletedPreviewRestartsFromBeginning();
testResetSegmentsReturnInitialViewForZeroDurationCamera();
testZeroDurationPreviewReturnsFinalView();
testEnabledPauseResumeAndScrubShareTheSameSamplerTime();
