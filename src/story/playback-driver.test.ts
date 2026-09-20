import type { CameraMovement, CameraView, PlaybackSegment } from '../interfaces';
import { derivePlaybackPlan, getViewAtPlaybackTime } from './playback';
import { startTrajectoryPlaybackDriver } from './playback-driver';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function view(zoom: number): CameraView {
  return { longitude: 0, latitude: 0, zoom, pitch: 0, bearing: 0 };
}

function plan() {
  const camera: CameraMovement = {
    name: 'driver-camera',
    title: 'Driver camera',
    category: 'test',
    initViewState: view(8),
    finalViewState: view(12),
    duration: 1000,
    stay: 0,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
  };
  return derivePlaybackPlan([camera], {
    trajectoryEnabled: true,
    viewport: { width: 1440, height: 900 },
  });
}

function scheduler(startMs = 1000) {
  let nowMs = startMs;
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  return {
    now: () => nowMs,
    requestFrame(callback: () => void) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancelFrame(id: number) {
      callbacks.delete(id);
    },
    advance(deltaMs: number) {
      nowMs += deltaMs;
      const pending = [...callbacks.entries()];
      callbacks.clear();
      pending.forEach(([, callback]) => callback());
    },
    get pendingCount() {
      return callbacks.size;
    },
  };
}

function assertSemanticEqual(actual: CameraView | undefined, expected: CameraView | undefined, message: string) {
  assert(actual && expected, `${message}: both views are required`);
  for (const channel of ['longitude', 'latitude', 'zoom', 'pitch', 'bearing'] as const) {
    assert(Math.abs(actual[channel] - expected[channel]) < 1e-9, `${message}: ${channel}`);
  }
}

function testDriverUsesTheSameTimelineSamplerAndCancels() {
  const playbackPlan = plan();
  const clock = scheduler();
  const frames: CameraView[] = [];
  let completions = 0;
  const driver = startTrajectoryPlaybackDriver({
    segments: playbackPlan.segments,
    startTimeMs: 250,
    totalTimeMs: playbackPlan.totalTime,
    now: clock.now,
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
    onFrame: (_time: number, sampled: CameraView) => frames.push(sampled),
    onComplete: () => completions++,
    onError: (error: unknown) => {
      throw error;
    },
  });
  clock.advance(75);
  assertSemanticEqual(
    frames[frames.length - 1],
    getViewAtPlaybackTime(playbackPlan.segments, 325),
    'driver uses sampler time',
  );
  assert(completions === 0 && clock.pendingCount === 1, 'incomplete playback schedules the next frame');
  driver.cancel();
  assert(clock.pendingCount < 1, 'cancel removes scheduled frame');
  clock.advance(125);
  assert(frames.length === 2, 'starting frame and last live frame are retained after cancellation');
}

function testExactEndCompletesOnceAndEmptyPlanCompletesSafely() {
  const playbackPlan = plan();
  const clock = scheduler();
  const times: number[] = [];
  let completions = 0;
  startTrajectoryPlaybackDriver({
    segments: playbackPlan.segments,
    startTimeMs: 900,
    totalTimeMs: playbackPlan.totalTime,
    now: clock.now,
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
    onFrame: (timeMs: number) => times.push(timeMs),
    onComplete: () => completions++,
    onError: (error: unknown) => {
      throw error;
    },
  });
  clock.advance(100);
  assert(times.join(',') === '900,1000', 'exact end frame is emitted');
  assert(completions === 1 && clock.pendingCount === 0, 'exact end completes once without another frame');
  clock.advance(100);
  assert(completions === 1, 'completion remains exactly once');

  let emptyCompletions = 0;
  startTrajectoryPlaybackDriver({
    segments: [],
    startTimeMs: 0,
    totalTimeMs: 0,
    now: clock.now,
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
    onFrame: () => {
      throw new Error('empty plan must not emit a frame');
    },
    onComplete: () => emptyCompletions++,
    onError: (error: unknown) => {
      throw error;
    },
  });
  assert(emptyCompletions === 1 && clock.pendingCount === 0, 'empty plan completes synchronously once');
}

function testDriverContainsNonFiniteSamplesAndReportsOneError() {
  const clock = scheduler();
  const badSegment: PlaybackSegment = {
    ...plan().segments[0],
    trajectory: {
      ...plan().segments[0].trajectory!,
      sample: () => ({ ...view(8), zoom: Number.NaN }),
    },
  };
  let errors = 0;
  let frames = 0;
  startTrajectoryPlaybackDriver({
    segments: [badSegment],
    startTimeMs: 0,
    totalTimeMs: 1000,
    now: clock.now,
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
    onFrame: () => frames++,
    onComplete: () => {
      throw new Error('invalid sample must not complete');
    },
    onError: () => errors++,
  });
  clock.advance(16);
  clock.advance(16);
  assert(errors === 1 && frames === 0, 'non-finite sample is contained and reported once');
  assert(clock.pendingCount === 0, 'errored driver leaves no scheduled frame');
}

testDriverUsesTheSameTimelineSamplerAndCancels();
testExactEndCompletesOnceAndEmptyPlanCompletesSafely();
testDriverContainsNonFiniteSamplesAndReportsOneError();

function testDriverPauseResumeAndSeekInsideAnExplicitGap() {
  const first = plan().segments[0].camera;
  const second: CameraMovement = {
    ...first,
    initViewState: { ...view(8), longitude: 30 },
    finalViewState: { ...view(10), longitude: 30 },
    startDelay: 2000,
  };
  const playbackPlan = derivePlaybackPlan([first, second]);
  assert(playbackPlan.segments[1].duration === 2000, 'fixture uses exactly the authored gap');
  const clock = scheduler();
  const frames: CameraView[] = [];
  let reportedError: unknown;
  const start = (startTimeMs: number) =>
    startTrajectoryPlaybackDriver({
      segments: playbackPlan.segments,
      startTimeMs,
      totalTimeMs: playbackPlan.totalTime,
      now: clock.now,
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
      onFrame: (_time, sampled) => frames.push(sampled),
      onComplete: () => undefined,
      onError: (error) => {
        reportedError = error;
      },
    });
  const playing = start(1000);
  for (let frame = 0; frame < 5; frame++) clock.advance(100);
  assertSemanticEqual(
    frames[frames.length - 1],
    getViewAtPlaybackTime(playbackPlan.segments, 1500),
    'pause inside gap',
  );
  playing.cancel();
  clock.advance(500);
  assert(frames.length === 6 && clock.pendingCount === 0, 'paused transition stays frozen');
  const resumed = start(1500);
  clock.advance(100);
  clock.advance(100);
  clock.advance(50);
  assertSemanticEqual(
    frames[frames.length - 1],
    getViewAtPlaybackTime(playbackPlan.segments, 1750),
    'resume retains curve',
  );
  resumed.cancel();
  const sought = start(2700);
  clock.advance(0);
  assertSemanticEqual(
    frames[frames.length - 1],
    getViewAtPlaybackTime(playbackPlan.segments, 2700),
    'seek samples exact gap time',
  );
  for (let frame = 0; frame < 3; frame++) clock.advance(100);
  assertSemanticEqual(frames[frames.length - 1], second.initViewState, 'exact gap end enters next shot');
  sought.cancel();
  assert(reportedError === undefined, 'gap playback produces no driver errors');
}

testDriverPauseResumeAndSeekInsideAnExplicitGap();

function testDriverUsesBoundedElapsedTimeAtEveryRefreshRate() {
  for (const fps of [30, 60, 120]) {
    const playbackPlan = plan();
    const clock = scheduler();
    const times: number[] = [];
    let completions = 0;
    const driver = startTrajectoryPlaybackDriver({
      segments: playbackPlan.segments,
      startTimeMs: 0,
      totalTimeMs: 1000,
      now: clock.now,
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame,
      onFrame: (time) => times.push(time),
      onComplete: () => completions++,
      onError: (error) => {
        throw error;
      },
    });
    assert(times.join(',') === '0', 'play immediately emits its exact starting frame');
    for (let frame = 0; frame < fps / 2; frame++) clock.advance(1000 / fps);
    assert(Math.abs(times[times.length - 1] - 500) < 1e-8, `${fps} Hz advances by elapsed time`);
    clock.advance(2000);
    assert(Math.abs(times[times.length - 1] - 600) < 1e-8, 'a long frame advances at most 100ms');
    driver.cancel();
    assert(completions === 0, 'cancellation cannot emit completion');
  }
}

function testDriverSuspendsAndResumesWithoutCatchingUp() {
  const clock = scheduler();
  const times: number[] = [];
  let completions = 0;
  const driver = startTrajectoryPlaybackDriver({
    segments: plan().segments,
    startTimeMs: 700,
    totalTimeMs: 1000,
    now: clock.now,
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
    onFrame: (time) => times.push(time),
    onComplete: () => completions++,
    onError: (error) => {
      throw error;
    },
  }) as ReturnType<typeof startTrajectoryPlaybackDriver> & { setSuspended(value: boolean): void };
  clock.advance(50);
  driver.setSuspended(true);
  assert(clock.pendingCount === 0, 'suspension cancels rendering work');
  clock.advance(20_000);
  assert(times.join(',') === '700,750', 'suspended playback remains at its rendered frame');
  driver.setSuspended(false);
  clock.advance(50);
  assert(times[times.length - 1] === 800, 'resume resets the elapsed-time baseline');
  clock.advance(100);
  clock.advance(100);
  assert(completions === 1 && times[times.length - 1] === 1000, 'resumed playback emits exact completion once');
  driver.setSuspended(true);
  driver.setSuspended(false);
  clock.advance(100);
  assert(completions === 1 && clock.pendingCount === 0, 'a terminal driver cannot resume');
}

testDriverUsesBoundedElapsedTimeAtEveryRefreshRate();
testDriverSuspendsAndResumesWithoutCatchingUp();
