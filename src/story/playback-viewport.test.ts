import type { CameraMovement, CameraView } from '../interfaces';
import type { ViewportSpec } from '../camera/geometry/types';
import { derivePlaybackPlan, getViewAtPlaybackTime } from './playback';
import { getCameraPlanningViewport, getPlaybackViewportLayout } from './planning-viewport';
import { createStoryJson, parseStoryJson } from './serialization';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const savedViewport = { width: 1440, height: 900 };
const resizedViewport = { width: 400, height: 1000 };

function camera(id: string, longitude: number, planningViewport?: ViewportSpec): CameraMovement {
  const view: CameraView = { longitude, latitude: 20, zoom: 10, pitch: 35, bearing: 0 };
  return {
    id,
    name: 'overview-static',
    title: id,
    category: 'overview',
    initViewState: view,
    finalViewState: { ...view },
    duration: 1000,
    stay: 0,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 2000,
    ...(planningViewport
      ? {
          authoring: {
            version: 2,
            targetId: id,
            recipeId: 'overview-static',
            adjustments: {},
            planningViewport,
          },
        }
      : {}),
  };
}

function testImportedAutomaticGapKeepsSavedFlightAfterResize() {
  const cameras = [camera('previous', 0, { width: 800, height: 600 }), camera('incoming', 100, savedViewport)];
  const imported = parseStoryJson(
    JSON.parse(JSON.stringify(createStoryJson(cameras, { trajectoryEnabled: true, viewport: savedViewport }))),
  );
  assert(imported.ok, 'saved hold shots must import successfully');
  const before = JSON.stringify(imported.cameras);
  const original = derivePlaybackPlan(imported.cameras, { viewport: savedViewport });
  const resized = derivePlaybackPlan(imported.cameras, { viewport: resizedViewport });
  const gap = resized.segments[1];
  assert(gap.generated === 'gap-transition' && gap.duration === 2000, 'legacy none keeps its automatic fly gap');
  for (const offset of [0, 250, 1000, 1750, 1999]) {
    const expected = getViewAtPlaybackTime(original.segments, original.segments[1].start + offset);
    const actual = getViewAtPlaybackTime(resized.segments, gap.start + offset);
    assert(expected && actual, 'the gap must have a sampled view');
    for (const channel of ['longitude', 'latitude', 'zoom', 'pitch', 'bearing'] as const) {
      assert(
        Math.abs(actual[channel] - expected[channel]) < 1e-9,
        `resizing must preserve gap ${channel} at ${offset} ms: expected ${expected[channel]}, received ${actual[channel]}`,
      );
    }
  }
  assert(
    gap.trajectory?.serialized.kind === 'legacy-fly' &&
      gap.trajectory.serialized.viewport.width === savedViewport.width &&
      gap.trajectory.serialized.viewport.height === savedViewport.height,
    'automatic fly compilation uses the incoming saved projection',
  );
  const layout = getPlaybackViewportLayout({ ...gap.camera }, resizedViewport);
  assert(
    layout.viewport.width === savedViewport.width && layout.viewport.height === savedViewport.height,
    'the generated gap renders with the same saved projection used by its sampler',
  );
  assert(layout.width === 400 && layout.height === 250 && layout.top === 375, 'the gap scales into the resized frame');
  assert(gap.camera.authoring === undefined, 'generated projection metadata does not impersonate shot authoring');
  assert(JSON.stringify(imported.cameras) === before, 'deriving gaps does not modify imported camera data');
}

function testGapProjectionFallsBackToSavedTrajectoryOrPreviousShot() {
  for (const viewportSource of ['incoming-trajectory', 'previous-authoring'] as const) {
    for (const interpolationType of ['none', 'linear']) {
      const previous = camera('previous', 0, viewportSource === 'previous-authoring' ? savedViewport : undefined);
      const incoming = camera('incoming', 100);
      incoming.interpolationType = interpolationType;
      if (viewportSource === 'incoming-trajectory') incoming.finalViewState.longitude = 101;
      const imported = parseStoryJson(
        JSON.parse(
          JSON.stringify(createStoryJson([previous, incoming], { trajectoryEnabled: true, viewport: savedViewport })),
        ),
      );
      assert(imported.ok, 'legacy trajectory viewport fixture imports');
      const gap = derivePlaybackPlan(imported.cameras, { viewport: resizedViewport }).segments[1];
      const layout = getPlaybackViewportLayout(gap.camera, resizedViewport);
      assert(
        layout.viewport.width === savedViewport.width && layout.viewport.height === savedViewport.height,
        `${interpolationType} gap inherits projection from ${viewportSource}`,
      );
      assert(
        gap.trajectory?.serialized.kind === (interpolationType === 'linear' ? 'legacy-linear' : 'legacy-fly'),
        'viewport inheritance preserves the incoming interpolation policy',
      );
      if (gap.trajectory?.serialized.kind === 'legacy-fly') {
        assert(
          gap.trajectory.serialized.viewport.width === savedViewport.width,
          'fly sampling matches display projection',
        );
      }
    }
  }
}

function testGeneratedIntervalsKeepTheActiveProjection() {
  for (const transition of ['auto', 'cut'] as const) {
    const previous = camera('previous', 0, { width: 800, height: 600 });
    const incoming = camera('incoming', 100, savedViewport);
    incoming.authoring!.transition = transition;
    incoming.startDelay = 300;
    for (const trajectoryEnabled of [true, false]) {
      const plan = derivePlaybackPlan([previous, incoming], { viewport: resizedViewport, trajectoryEnabled });
      const interval = plan.segments.find((segment) => segment.generated);
      assert(interval, 'the time between cameras has an internal playback segment');
      const expected = savedViewport;
      const layout = getPlaybackViewportLayout(interval.camera, resizedViewport);
      assert(
        interval.generated === 'gap-transition',
        'the actual interval generates a connection regardless of legacy cut metadata',
      );
      assert(
        layout.viewport.width === expected.width && layout.viewport.height === expected.height,
        `${transition} delay preserves the held frame projection when trajectoryEnabled is ${trajectoryEnabled}`,
      );
      assert(plan.totalTime === 4300, 'preserving projection does not change explicit interval timing');
    }
  }
}

function testLegacyCamerasWithoutSavedProjectionKeepCurrentViewportFallback() {
  const previous = camera('previous', 0);
  const incoming = camera('incoming', 100);
  const plan = derivePlaybackPlan([previous, incoming], { viewport: resizedViewport });
  const gap = plan.segments[1];
  assert(gap.generated === 'gap-transition', 'old none interpolation still creates a gap');
  assert(
    gap.trajectory?.serialized.kind === 'legacy-fly' && gap.trajectory.serialized.viewport.width === 400,
    'unsaved legacy gap retains the supplied viewport fallback',
  );
  assert(getCameraPlanningViewport(gap.camera) === undefined, 'no persisted viewport is invented for old cameras');
}

testImportedAutomaticGapKeepsSavedFlightAfterResize();
testGapProjectionFallsBackToSavedTrajectoryOrPreviousShot();
testGeneratedIntervalsKeepTheActiveProjection();
testLegacyCamerasWithoutSavedProjectionKeepCurrentViewportFallback();
