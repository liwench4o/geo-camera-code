import type { CameraView } from '../interfaces';
import { getCameraOptionSelectionById, resolveCameraRecipe } from './recipes';
import {
  computeViewDisplacement,
  resolveAdaptiveDuration,
  TIMING_MAX_DURATION_MS,
  TIMING_MIN_DURATION_MS,
} from './timing';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function createView(overrides: Partial<CameraView>): CameraView {
  return {
    longitude: -1.5,
    latitude: 52.3,
    zoom: 8,
    pitch: 40,
    bearing: 0,
    minZoom: 0,
    maxZoom: 20,
    minPitch: 0,
    maxPitch: 85,
    ...overrides,
  };
}

function testDisplacementGrowsWithViewChange() {
  const base = createView({});
  const smallZoom = computeViewDisplacement(base, createView({ zoom: 9 }), { width: 1200, height: 800 });
  const largeZoom = computeViewDisplacement(base, createView({ zoom: 14 }), { width: 1200, height: 800 });
  const pan = computeViewDisplacement(base, createView({ longitude: 2.3, latitude: 48.8 }), {
    width: 1200,
    height: 800,
  });

  assert(largeZoom > smallZoom, 'displacement should grow with zoom delta');
  assert(pan > 0.2, 'a cross-country pan should register substantial displacement');
  assert(
    computeViewDisplacement(base, base, { width: 1200, height: 800 }) < 0.001,
    'identical views should have ~zero displacement',
  );
}

function testDurationScalesLinearlyWithDisplacement() {
  const recipe = resolveCameraRecipe('emphasis-push-in');
  const short = resolveAdaptiveDuration({ recipe, displacement: 1 });
  const long = resolveAdaptiveDuration({ recipe, displacement: 3 });

  assert(long.durationMs > short.durationMs, 'larger displacement should take longer');
  assert(
    Math.abs(long.durationMs / short.durationMs - 3) < 0.1,
    `inside the clamps duration should scale linearly with displacement, ratio ${(long.durationMs / short.durationMs).toFixed(2)}`,
  );
}

function testStaticDisplacementKeepsRecipeDuration() {
  const recipe = resolveCameraRecipe('emphasis-static');
  const result = resolveAdaptiveDuration({ recipe, displacement: 0 });

  assert(result.durationMs === recipe.timing.durationMs, 'negligible displacement should keep the recipe duration');
}

function testFastOptionResolvesShorterDuration() {
  const fastRecipe = resolveCameraRecipe('emphasis-push-in', getCameraOptionSelectionById('emphasis-push-in', 'fast'));
  const normalRecipe = resolveCameraRecipe(
    'emphasis-push-in',
    getCameraOptionSelectionById('emphasis-push-in', 'normal'),
  );
  const fast = resolveAdaptiveDuration({ recipe: fastRecipe, displacement: 2 });
  const normal = resolveAdaptiveDuration({ recipe: normalRecipe, displacement: 2 });

  assert(
    fast.durationMs < normal.durationMs,
    `the fast option should resolve a shorter duration (${fast.durationMs} vs ${normal.durationMs})`,
  );
}

function testSpeedScaleShortensDuration() {
  const recipe = resolveCameraRecipe('emphasis-push-in');
  const normal = resolveAdaptiveDuration({ recipe, displacement: 2 });
  const doubled = resolveAdaptiveDuration({ recipe, displacement: 2, speedScale: 2 });

  assert(doubled.durationMs < normal.durationMs, 'speedScale above 1 should shorten durations');
}

function testRecipeDurationBranchesApplyPaceOnceAfterThePreset() {
  for (const [cameraName, optionId, displacement] of [
    ['emphasis-static', 'short', 0],
    ['emphasis-camera-roll', 'slow', 2],
    ['emphasis-push-in', 'fast', 0.001],
    ['dynamic-pull-out', 'normal', 5],
  ] as const) {
    const option = getCameraOptionSelectionById(cameraName, optionId);
    assert(Boolean(option), `${cameraName} must have the ${optionId} preset`);
    const recipe = resolveCameraRecipe(cameraName, option);
    for (const speedScale of [0.5, 1, 2]) {
      const result = resolveAdaptiveDuration({ recipe, displacement, speedScale });
      // The neutral bound applies before preset and author pace; slowing a shot may exceed it.
      const expected = Math.round(recipe.timing.durationMs / speedScale);
      assert(
        result.durationMs === expected,
        `${cameraName}/${optionId} must apply ${speedScale}× pace once to its preset duration (expected ${expected}, got ${result.durationMs})`,
      );
    }
  }
}

function testAdaptiveMovementDoesNotApplyPaceTwice() {
  const recipe = resolveCameraRecipe('emphasis-push-in', getCameraOptionSelectionById('emphasis-push-in', 'normal'));
  const normal = resolveAdaptiveDuration({ recipe, displacement: 3 });
  const faster = resolveAdaptiveDuration({ recipe, displacement: 3, speedScale: 2 });
  assert(
    Math.abs(faster.durationMs - normal.durationMs / 2) <= 1,
    `adaptive movement applies pace only in its speed tier (expected ${normal.durationMs / 2}, got ${faster.durationMs})`,
  );
}

function testFastPresetRemainsFasterAtTheNeutralMinimum() {
  const normalRecipe = resolveCameraRecipe(
    'emphasis-push-in',
    getCameraOptionSelectionById('emphasis-push-in', 'normal'),
  );
  const fastRecipe = resolveCameraRecipe('emphasis-push-in', getCameraOptionSelectionById('emphasis-push-in', 'fast'));
  const normal = resolveAdaptiveDuration({ recipe: normalRecipe, displacement: 0.05 });
  const fast = resolveAdaptiveDuration({ recipe: fastRecipe, displacement: 0.05 });
  assert(normal.durationMs === TIMING_MIN_DURATION_MS, 'small neutral movement uses the default minimum');
  assert(
    fast.durationMs === normal.durationMs / 4,
    `Fast must remain 4× faster for a short movement (got ${fast.durationMs})`,
  );
}

function testPaceAppliesAfterNeutralBoundsAndPathFloor() {
  const pushIn = resolveCameraRecipe('emphasis-push-in');
  const tracking = resolveCameraRecipe('overview-tracking');
  for (const input of [
    { recipe: pushIn, displacement: 0.05 },
    { recipe: pushIn, displacement: 50 },
    { recipe: tracking, displacement: 0.5, pathLengthKm: 2 },
    { recipe: tracking, displacement: 0.5, pathLengthKm: 1000 },
  ]) {
    const neutral = resolveAdaptiveDuration(input);
    for (const speedScale of [0.5, 2]) {
      const adjusted = resolveAdaptiveDuration({ ...input, speedScale });
      assert(
        Math.abs(adjusted.durationMs - neutral.durationMs / speedScale) <= 1,
        `${input.recipe.cameraName} ${input.pathLengthKm ?? input.displacement} must apply ${speedScale}× pace after neutral limits (neutral ${neutral.durationMs}, got ${adjusted.durationMs})`,
      );
    }
  }
}

function testFastPresetAndPaceComposeOnceAtTheNeutralMaximum() {
  const neutralRecipe = resolveCameraRecipe('emphasis-push-in');
  const fastRecipe = resolveCameraRecipe('emphasis-push-in', getCameraOptionSelectionById('emphasis-push-in', 'fast'));
  const neutral = resolveAdaptiveDuration({ recipe: neutralRecipe, displacement: 50 });
  const fastWithPace = resolveAdaptiveDuration({ recipe: fastRecipe, displacement: 50, speedScale: 2 });
  assert(
    fastWithPace.durationMs === neutral.durationMs / 8,
    '4× preset and 2× Pace must compose once after the maximum',
  );
}

function testAbsolutePaceCanSlowDownAFastPreset() {
  const neutralRecipe = resolveCameraRecipe('emphasis-push-in');
  const fastRecipe = resolveCameraRecipe('emphasis-push-in', getCameraOptionSelectionById('emphasis-push-in', 'fast'));
  const neutral = resolveAdaptiveDuration({ recipe: neutralRecipe, displacement: 0.05 });
  const requestedPace = 0.25;
  const presetSpeed = fastRecipe.baseDurationMs / fastRecipe.timing.durationMs;
  const slow = resolveAdaptiveDuration({
    recipe: fastRecipe,
    displacement: 0.05,
    speedScale: requestedPace / presetSpeed,
  });
  assert(
    slow.durationMs === neutral.durationMs / requestedPace,
    'the 0.25× absolute Pace control must work with a 4× Fast preset',
  );
}

function testDurationRespectsClamps() {
  const recipe = resolveCameraRecipe('emphasis-push-in');
  const tiny = resolveAdaptiveDuration({ recipe, displacement: 0.05 });
  const huge = resolveAdaptiveDuration({ recipe, displacement: 50 });

  assert(tiny.durationMs >= TIMING_MIN_DURATION_MS, 'durations should respect the lower clamp');
  assert(
    huge.durationMs <= Math.min(TIMING_MAX_DURATION_MS, recipe.timing.maxDurationMs ?? Infinity),
    'durations should respect the upper clamps',
  );
}

function testRotationDominantShotsKeepRecipeDuration() {
  const slowRecipe = resolveCameraRecipe(
    'emphasis-camera-roll',
    getCameraOptionSelectionById('emphasis-camera-roll', 'slow'),
  );
  const normalRecipe = resolveCameraRecipe(
    'emphasis-camera-roll',
    getCameraOptionSelectionById('emphasis-camera-roll', 'normal'),
  );
  const slow = resolveAdaptiveDuration({ recipe: slowRecipe, displacement: 2 });
  const normal = resolveAdaptiveDuration({ recipe: normalRecipe, displacement: 2 });

  assert(
    slow.durationMs === slowRecipe.timing.durationMs && slow.durationMs === 10000,
    `rotation-dominant slow option should keep its 10000ms recipe duration (got ${slow.durationMs})`,
  );
  assert(
    normal.durationMs === normalRecipe.timing.durationMs && normal.durationMs === 6000,
    `rotation-dominant normal option should keep its 6000ms recipe duration (got ${normal.durationMs})`,
  );
}

function testRecipeLevelDurationIsNotASpeedMultiplier() {
  // overview-push-in overrides the profile durationMs at the recipe layer (3000 vs 5000);
  // that absolute override must not turn into a speed multiplier: D=0.8 / 0.35 -> ~2286ms.
  const recipe = resolveCameraRecipe('overview-push-in');
  const result = resolveAdaptiveDuration({ recipe, displacement: 0.8 });

  assert(
    Math.abs(result.durationMs - 2286) <= 2,
    `recipe-level durationMs must not act as a speed multiplier (expected ~2286ms, got ${result.durationMs})`,
  );
}

function testNoTierKeepsRecipeDurationForLargeDisplacement() {
  const recipe = resolveCameraRecipe('dynamic-pull-out');
  const result = resolveAdaptiveDuration({ recipe, displacement: 5 });

  assert(recipe.timing.speedTier === undefined, 'dynamic purpose must not configure a speed tier');
  assert(
    result.durationMs === recipe.timing.durationMs,
    `purposes without a speed tier should keep the recipe duration even for large displacement (expected ${recipe.timing.durationMs}ms, got ${result.durationMs}ms)`,
  );
}

function testMaxDurationCapBindsBeforeTimingMax() {
  const recipe = resolveCameraRecipe('emphasis-push-in');
  const result = resolveAdaptiveDuration({ recipe, displacement: 50 });

  assert(
    recipe.timing.maxDurationMs === 12000,
    `emphasis profile cap should be 12000ms (got ${recipe.timing.maxDurationMs})`,
  );
  assert(
    result.durationMs === recipe.timing.maxDurationMs,
    `the profile cap should bind below TIMING_MAX_DURATION_MS (expected ${recipe.timing.maxDurationMs}ms, got ${result.durationMs}ms)`,
  );
  assert(
    result.durationMs < TIMING_MAX_DURATION_MS,
    `the bound duration should sit below the global ${TIMING_MAX_DURATION_MS}ms ceiling (got ${result.durationMs}ms)`,
  );
}

function testTrackingKeepsPathBasedFloor() {
  const recipe = resolveCameraRecipe('overview-tracking');
  const pathLengthKm = 1000;
  const withPath = resolveAdaptiveDuration({ recipe, displacement: 0.5, pathLengthKm });
  const withoutPath = resolveAdaptiveDuration({ recipe, displacement: 0.5 });
  const expectedDuration = Math.min(
    recipe.timing.maxDurationMs ?? TIMING_MAX_DURATION_MS,
    recipe.timing.durationMs + pathLengthKm * Number(recipe.timing.pathDurationPerKmMs),
  );

  assert(withPath.durationMs > withoutPath.durationMs, 'long paths should extend tracking duration');
  assert(
    withPath.durationMs === expectedDuration,
    `tracking should use the uncapped path-based floor before maxDurationMs (expected ${expectedDuration}ms, got ${withPath.durationMs}ms)`,
  );
}

testDisplacementGrowsWithViewChange();
testDurationScalesLinearlyWithDisplacement();
testStaticDisplacementKeepsRecipeDuration();
testFastOptionResolvesShorterDuration();
testSpeedScaleShortensDuration();
testRecipeDurationBranchesApplyPaceOnceAfterThePreset();
testAdaptiveMovementDoesNotApplyPaceTwice();
testFastPresetRemainsFasterAtTheNeutralMinimum();
testPaceAppliesAfterNeutralBoundsAndPathFloor();
testFastPresetAndPaceComposeOnceAtTheNeutralMaximum();
testAbsolutePaceCanSlowDownAFastPreset();
testDurationRespectsClamps();
testRotationDominantShotsKeepRecipeDuration();
testRecipeLevelDurationIsNotASpeedMultiplier();
testNoTierKeepsRecipeDurationForLargeDisplacement();
testMaxDurationCapBindsBeforeTimingMax();
testTrackingKeepsPathBasedFloor();
