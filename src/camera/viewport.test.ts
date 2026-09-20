import type { CameraView } from '../interfaces';
import { createPointTarget, createRegionTarget } from './selection';
import type { CameraTarget } from './types';
import { fitVisualTargetToView, getProjectedVisualBounds, measureVisualTargetFit } from './viewport';

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

function createWideRegionTarget() {
  return createRegionTarget([
    [-2.2, 52.0],
    [-0.8, 52.0],
    [-0.8, 52.6],
    [-2.2, 52.6],
  ]);
}

// Anchor near the left edge of the bbox, so most of the content extends to the right of the
// aligned anchor. This makes the offset tests discriminate the anchor-centered safety window
// from the old symmetric padding check (which only constrained the viewport edges).
function createAnchorOffsetRegionTarget(): CameraTarget {
  const target = createWideRegionTarget();
  return {
    ...target,
    visualFrame: {
      ...target.visualFrame,
      bbox: target.visualFrame?.bbox ?? target.bbox,
      anchor: [-2.05, 52.3],
    },
  };
}

function testOffsetFramingReservesScreenSpace() {
  const viewportSize = { width: 1200, height: 800 };
  const { view } = fitVisualTargetToView({
    target: createAnchorOffsetRegionTarget(),
    baseView: createView({}),
    viewportSize,
    paddingRatio: 0.12,
    offsetRatio: [-0.14, 0],
  });
  const bounds = getProjectedVisualBounds(view, createAnchorOffsetRegionTarget(), viewportSize);

  assert(bounds !== undefined, 'projected bounds should exist for the fitted view');
  // Safety window is centered on the desired anchor x = 0.36W = 432 with halfWidth = 432 − padding(96) = 336,
  // so the content's right edge must stay at or left of 432 + 336 = 768.
  assert(
    (bounds?.maxX ?? Infinity) <= 432 + 336 + 1,
    `offset framing should keep content clear of the reserved right band, maxX ${bounds?.maxX}`,
  );
  assert(
    (bounds?.minX ?? -Infinity) >= 432 - 336 - 1,
    `offset framing should keep content inside the window's left bound, minX ${bounds?.minX}`,
  );
}

function testVerticalOffsetFramingReservesScreenSpace() {
  const viewportSize = { width: 1200, height: 800 };
  const { view } = fitVisualTargetToView({
    target: createAnchorOffsetRegionTarget(),
    baseView: createView({}),
    viewportSize,
    paddingRatio: 0.12,
    offsetRatio: [0, -0.14],
  });
  const bounds = getProjectedVisualBounds(view, createAnchorOffsetRegionTarget(), viewportSize);

  assert(bounds !== undefined, 'projected bounds should exist for the vertically offset view');
  // Safety window is centered on the desired anchor y = 0.36H = 288 with halfHeight = 288 − padding(96) = 192,
  // so the content's bottom edge must stay at or above 288 + 192 = 480.
  assert(
    (bounds?.maxY ?? Infinity) <= 288 + 192 + 1,
    `vertical offset framing should keep content clear of the reserved bottom band, maxY ${bounds?.maxY}`,
  );
}

function createTallTarget() {
  const target = createPointTarget([-0.117, 51.511]);
  return {
    ...target,
    visualFrame: {
      bbox: [-0.2, 51.45, -0.05, 51.57] as [number, number, number, number],
      anchor: [-0.117, 51.511] as [number, number],
      heightMeters: 60000,
    },
  };
}

function testPitchRelaxationPrefersLowerPitchOverExtraZoomOut() {
  const viewportSize = { width: 800, height: 600 };
  const baseView = createView({ zoom: 9, pitch: 55 });
  const relaxed = fitVisualTargetToView({
    target: createTallTarget(),
    baseView,
    viewportSize,
    paddingRatio: 0.12,
    pitch: 55,
    pitchRelax: { minPitch: 25 },
  });
  const zoomOnly = fitVisualTargetToView({
    target: createTallTarget(),
    baseView,
    viewportSize,
    paddingRatio: 0.12,
    pitch: 55,
  });

  assert(
    relaxed.view.pitch < 55,
    `tall content should relax pitch below the stylistic target, received ${relaxed.view.pitch}`,
  );
  assert(relaxed.view.pitch >= 25, 'relaxed pitch should respect the profile minimum');
  assert(
    relaxed.view.zoom >= zoomOnly.view.zoom,
    `pitch relaxation should stay at least as close as pure zoom-out (${relaxed.view.zoom} vs ${zoomOnly.view.zoom})`,
  );
  assert(relaxed.metrics.minMarginPx >= 0, 'relaxed view should keep the content inside the viewport');
}

function testPitchRelaxationRespectsViewMinPitch() {
  const viewportSize = { width: 800, height: 600 };
  const baseView = createView({ zoom: 9, pitch: 55, minPitch: 40 });
  const { view, metrics } = fitVisualTargetToView({
    target: createTallTarget(),
    baseView,
    viewportSize,
    paddingRatio: 0.12,
    pitch: 55,
    pitchRelax: { minPitch: 25 },
  });

  assert(view.pitch >= 40, `relaxed pitch should respect the view minPitch, received ${view.pitch}`);
  assert(
    metrics.minMarginPx >= 0,
    `zoom-out fallback should still engage when the view minPitch floors relaxation, margin ${metrics.minMarginPx}`,
  );
}

function testCenterErrorIsUnmeasurableForDegenerateAnchorProjection() {
  // A 250km-tall target measured at a low, steep view can push the elevated anchor projection toward
  // (or behind) the horizon, where the raw pixel hypot is meaningless. The metric must then be either
  // guarded (undefined) or sane (within a few viewport diagonals) — never a garbage magnitude.
  const base = createPointTarget([-0.117, 51.511]);
  const bbox: [number, number, number, number] = [-0.2, 51.45, -0.05, 51.57];
  const target = {
    ...base,
    visualFrame: {
      bbox,
      anchor: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] as [number, number],
      heightMeters: 250000,
    },
  };
  const viewportSize = { width: 474, height: 382 };
  const metrics = measureVisualTargetFit({
    viewState: createView({ zoom: 4.5, pitch: 60 }),
    target,
    viewportSize,
    anchorHeightRatio: 0.5,
  });

  assert(
    metrics.centerErrorPx === undefined || metrics.centerErrorPx < 4 * Math.hypot(474, 382),
    `degenerate anchor projection should record an undefined or sane center error, received ${metrics.centerErrorPx}`,
  );
}

function testCenteredWindowMatchesSymmetricPadding() {
  const viewportSize = { width: 1200, height: 800 };
  const { view, metrics } = fitVisualTargetToView({
    target: createWideRegionTarget(),
    baseView: createView({}),
    viewportSize,
    paddingRatio: 0.12,
  });
  const bounds = getProjectedVisualBounds(view, createWideRegionTarget(), viewportSize);

  assert(bounds !== undefined, 'projected bounds should exist for the centered view');
  assert((bounds?.minX ?? -Infinity) >= metrics.paddingPx - 1, 'centered fit should keep left padding');
  assert(
    (bounds?.maxX ?? Infinity) <= viewportSize.width - metrics.paddingPx + 1,
    'centered fit should keep right padding',
  );
}

testOffsetFramingReservesScreenSpace();
testVerticalOffsetFramingReservesScreenSpace();
testPitchRelaxationPrefersLowerPitchOverExtraZoomOut();
testPitchRelaxationRespectsViewMinPitch();
testCenterErrorIsUnmeasurableForDegenerateAnchorProjection();
testCenteredWindowMatchesSymmetricPadding();
