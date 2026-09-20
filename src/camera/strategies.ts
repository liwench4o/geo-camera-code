import _ from 'lodash';
import type { CameraDebugReasonGroup, CameraView } from '../interfaces';
import { createMultipleTarget, createPathTarget, createTargetFromView } from './selection';
import {
  ensureVisualTargetVisible,
  fitVisualTargetToView,
  getDefaultViewportSize,
  getTargetMaxZoom,
  getViewOffsetByScreenPixels,
  getViewWithCenter,
  getZoomInView,
  getZoomOutView,
  measureVisualTargetFit,
} from './viewport';
import type { CameraPlanInput, CameraRecipe, CameraRecipeStrategy, CameraTarget, LngLat, ViewportSize } from './types';

export interface CameraStrategyViews {
  initView: CameraView;
  finalView: CameraView;
  reasons: Partial<Record<CameraDebugReasonGroup, string[]>>;
  metrics: Record<string, number | string | string[] | undefined>;
  resolvedParameters: {
    paddingRatio: number;
    zoomBias: number;
    pitchTarget?: number;
    bearingDelta: number;
    anchorHeightRatio: number;
    offsetRatio?: [number, number];
  };
}

export interface CameraStrategyContext {
  input: CameraPlanInput;
  recipe: CameraRecipe;
  target: CameraTarget;
  baseView: CameraView;
}

export type CameraStrategyHandler = (context: CameraStrategyContext) => CameraStrategyViews;

interface AdaptiveFrame {
  targetView: CameraView;
  contextView: CameraView;
  paddingRatio: number;
  contextPaddingRatio: number;
  zoomBias: number;
  contextZoomOut: number;
  pitchTarget: number;
  bearingDelta: number;
  anchorHeightRatio: number;
  offsetRatio?: [number, number];
  reasons: string[];
  metrics: Record<string, number | string | string[] | undefined>;
}

interface FrameModifiers {
  paddingBonus?: number;
  zoomOutBonus?: number;
  pitchTarget?: number;
  bearingScale?: number;
  target?: CameraTarget;
}

interface StrategyViewSafety {
  init?: boolean;
  final?: boolean;
}

function clamp(value: number, min = -Infinity, max = Infinity) {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number | undefined) {
  return value === undefined || !Number.isFinite(value) ? 0 : clamp(value, 0, 1);
}

function addReason(
  reasons: Partial<Record<CameraDebugReasonGroup, string[]>>,
  group: CameraDebugReasonGroup,
  reason: string,
) {
  reasons[group] = Array.from(new Set([...(reasons[group] ?? []), reason]));
}

function mergeReasons(
  ...groups: Partial<Record<CameraDebugReasonGroup, string[]>>[]
): Partial<Record<CameraDebugReasonGroup, string[]>> {
  const merged: Partial<Record<CameraDebugReasonGroup, string[]>> = {};
  for (const group of groups) {
    for (const [key, values] of Object.entries(group) as [CameraDebugReasonGroup, string[]][]) {
      for (const value of values) {
        addReason(merged, key, value);
      }
    }
  }
  return merged;
}

function getPitchTarget(recipe: CameraRecipe, override?: number) {
  const [minPitch, maxPitch] = recipe.framing.pitchRange;
  if (override !== undefined) {
    return clamp(override, minPitch, maxPitch);
  }
  if (recipe.framing.pitchTarget !== undefined) {
    return clamp(recipe.framing.pitchTarget, minPitch, maxPitch);
  }

  const normalizedPitch = 0.35;
  return minPitch + (maxPitch - minPitch) * normalizedPitch;
}

function getFramingTuning(input: CameraPlanInput) {
  const tightness = clamp(input.framingTuning?.framingTightness ?? 0, -1, 1);
  const motionStrength = clamp(input.framingTuning?.motionStrength ?? 0, -1, 1);

  return {
    framingTightness: tightness,
    motionStrength,
    paddingDelta: 0.06 * tightness,
    zoomBiasDelta: -0.45 * tightness,
    contextZoomOutDelta: Math.max(0, tightness) * 0.25,
    bearingScale: 1 + motionStrength * 0.35,
    anchorHeightRatio: clamp(input.framingTuning?.anchorHeightRatio ?? 0.5, 0, 1),
    offsetRatio: input.framingTuning?.offsetRatio,
    pitchTarget: input.framingTuning?.pitchTarget,
  };
}

function resolveAdaptiveFrame(context: CameraStrategyContext, modifiers: FrameModifiers = {}): AdaptiveFrame {
  const recipe = context.recipe;
  const target = modifiers.target ?? context.target;
  const stats = target.stats ?? { count: 0 };
  const viewportSize = context.input.viewportSize ?? getDefaultViewportSize();
  const elevationRatio = clamp01(stats.elevationRatio ?? stats.maxElevationRatio);
  const tuning = getFramingTuning(context.input);
  const offsetRatio = tuning.offsetRatio ?? recipe.framing.offsetRatio;
  const contentPadding = modifiers.paddingBonus ?? 0;
  const adaptiveZoomOut = clamp(
    modifiers.zoomOutBonus ?? 0,
    0,
    recipe.adaptation.maxAdaptiveZoomOut + (modifiers.zoomOutBonus ?? 0),
  );
  const paddingRatio = clamp(
    (context.input.framingTuning?.safetyMarginRatio ?? recipe.framing.paddingRatio) +
      contentPadding +
      tuning.paddingDelta,
    0.04,
    0.46,
  );
  const contextPaddingRatio = clamp(
    recipe.framing.contextPaddingRatio + contentPadding + tuning.paddingDelta + tuning.contextZoomOutDelta * 0.04,
    paddingRatio,
    0.48,
  );
  const zoomBias = recipe.framing.zoomBias - adaptiveZoomOut + tuning.zoomBiasDelta;
  const contextZoomOut = recipe.framing.contextZoomOut + tuning.contextZoomOutDelta;
  const pitchTarget =
    tuning.pitchTarget !== undefined ? clamp(tuning.pitchTarget, 0, 75) : getPitchTarget(recipe, modifiers.pitchTarget);
  const anchorHeightRatio = tuning.anchorHeightRatio;
  const bearingDelta = recipe.framing.bearingDelta * ((modifiers.bearingScale ?? 1) * tuning.bearingScale);
  const reasons: string[] = [];

  if (target.type === 'region' || target.type === 'multiple') {
    reasons.push('Region and multiple-target selections use a wider frame to preserve spatial context.');
  }
  if (target.type === 'path') {
    reasons.push('Path selections keep extra margin around the route before following it.');
  }
  if (offsetRatio) {
    reasons.push('The frame is offset to reserve space for supplemental information.');
  }
  if (tuning.framingTightness !== 0 || tuning.motionStrength !== 0 || tuning.pitchTarget !== undefined) {
    reasons.push('Framing tuning adjusted spacing, target placement, or motion strength at planning time.');
  }

  const targetFit = fitVisualTargetToView({
    target,
    baseView: context.baseView,
    viewportSize,
    paddingRatio,
    zoomOffset: zoomBias,
    maxZoom: getTargetMaxZoom(target, context.baseView),
    pitch: pitchTarget,
    offsetRatio,
    minPaddingPx: recipe.framing.minPaddingPx,
    maxPaddingRatio: recipe.framing.maxPaddingRatio,
    anchorHeightRatio,
    pitchRelax: recipe.shots.includes('tilt') ? undefined : { minPitch: context.recipe.framing.pitchRange[0] },
  });
  const contextFit = fitVisualTargetToView({
    target,
    baseView: context.baseView,
    viewportSize,
    paddingRatio: contextPaddingRatio,
    zoomOffset: zoomBias - contextZoomOut,
    maxZoom: getTargetMaxZoom(target, context.baseView),
    pitch: pitchTarget,
    offsetRatio,
    minPaddingPx: recipe.framing.minPaddingPx,
    maxPaddingRatio: recipe.framing.maxPaddingRatio,
    anchorHeightRatio,
    pitchRelax: recipe.shots.includes('tilt') ? undefined : { minPitch: context.recipe.framing.pitchRange[0] },
  });

  return {
    targetView: targetFit.view,
    contextView: contextFit.view,
    paddingRatio,
    contextPaddingRatio,
    zoomBias,
    contextZoomOut,
    pitchTarget,
    bearingDelta,
    anchorHeightRatio,
    offsetRatio,
    reasons,
    metrics: {
      densityRatio: 0,
      elevationRatio: Number(elevationRatio.toFixed(3)),
      elevationNorm: Number(elevationRatio.toFixed(3)),
      dispersionRatio: 0,
      heightOverflowRatio: undefined,
      overflowZoomOut: undefined,
      selectedElevationMeters: stats.selectedElevationMeters
        ? Number(stats.selectedElevationMeters.toFixed(3))
        : undefined,
      maxElevationMeters: stats.maxElevationMeters ? Number(stats.maxElevationMeters.toFixed(3)) : undefined,
      bboxAreaKm2: stats.bboxAreaKm2 ? Number(stats.bboxAreaKm2.toFixed(3)) : undefined,
      bboxAreaRatio: stats.bboxAreaRatio ? Number(stats.bboxAreaRatio.toFixed(3)) : undefined,
      visualAreaKm2: stats.visualAreaKm2 ? Number(stats.visualAreaKm2.toFixed(3)) : undefined,
      visualAreaRatio: stats.visualAreaRatio ? Number(stats.visualAreaRatio.toFixed(3)) : undefined,
      referenceAreaKm2: stats.referenceAreaKm2 ? Number(stats.referenceAreaKm2.toFixed(3)) : undefined,
      pathLengthKm: stats.pathLengthKm ? Number(stats.pathLengthKm.toFixed(3)) : undefined,
      targetSource: target.source,
      layerKinds: stats.layerKinds,
      paddingRatio: Number(paddingRatio.toFixed(3)),
      zoomBias: Number(zoomBias.toFixed(3)),
      framingTightness: Number(tuning.framingTightness.toFixed(3)),
      motionStrength: Number(tuning.motionStrength.toFixed(3)),
      pitchTarget: Number(pitchTarget.toFixed(1)),
      bearingDelta: Number(bearingDelta.toFixed(1)),
      anchorHeightRatio: Number(anchorHeightRatio.toFixed(2)),
      targetCenterErrorPx: targetFit.metrics.centerErrorPx,
      targetMinMarginPx: targetFit.metrics.minMarginPx,
      contextMinMarginPx: contextFit.metrics.minMarginPx,
      fitIterations: targetFit.metrics.fitIterations,
      viewportWidth: targetFit.metrics.viewportWidth,
      viewportHeight: targetFit.metrics.viewportHeight,
      paddingPx: targetFit.metrics.paddingPx,
    },
  };
}

function getMeasuredStrategyView(context: CameraStrategyContext, frame: AdaptiveFrame, view: CameraView) {
  return measureVisualTargetFit({
    viewState: view,
    target: context.target,
    viewportSize: context.input.viewportSize ?? getDefaultViewportSize(),
    paddingRatio: frame.paddingRatio,
    offsetRatio: frame.offsetRatio,
    minPaddingPx: context.recipe.framing.minPaddingPx,
    maxPaddingRatio: context.recipe.framing.maxPaddingRatio,
    anchorHeightRatio: frame.anchorHeightRatio,
  });
}

function getSafeStrategyView(context: CameraStrategyContext, frame: AdaptiveFrame, view: CameraView) {
  if (context.target.type === 'none') {
    return {
      view,
      metrics: getMeasuredStrategyView(context, frame, view),
    };
  }

  return ensureVisualTargetVisible({
    viewState: view,
    target: context.target,
    viewportSize: context.input.viewportSize ?? getDefaultViewportSize(),
    paddingRatio: frame.paddingRatio,
    offsetRatio: frame.offsetRatio,
    minPaddingPx: context.recipe.framing.minPaddingPx,
    maxPaddingRatio: context.recipe.framing.maxPaddingRatio,
    anchorHeightRatio: frame.anchorHeightRatio,
    pitchRelax: context.recipe.shots.includes('tilt') ? undefined : { minPitch: context.recipe.framing.pitchRange[0] },
  });
}

function createStrategyResult(
  context: CameraStrategyContext,
  views: { initView: CameraView; finalView: CameraView },
  frame: AdaptiveFrame,
  strategyReason: string,
  extraReasons: Partial<Record<CameraDebugReasonGroup, string[]>> = {},
  safety: StrategyViewSafety = {},
): CameraStrategyViews {
  const defaultSafety = !isCurrentViewStrategy(context) && context.target.type !== 'none';
  const initSafety = safety.init ?? defaultSafety;
  const finalSafety = safety.final ?? defaultSafety;
  let initResult = initSafety
    ? getSafeStrategyView(context, frame, views.initView)
    : { view: views.initView, metrics: getMeasuredStrategyView(context, frame, views.initView) };
  let finalResult = finalSafety
    ? getSafeStrategyView(context, frame, views.finalView)
    : { view: views.finalView, metrics: getMeasuredStrategyView(context, frame, views.finalView) };
  if (
    initSafety &&
    finalSafety &&
    context.recipe.purpose !== 'comparison' &&
    context.recipe.shots.some((shot) => shot === 'push-in' || shot === 'pull-out' || shot === 'tilt')
  ) {
    // A safety fit is a shared retreat, so it cannot silently turn a push/pull into a hold.
    // The camera's real zoom floor can still reduce the requested distance change.
    const retreat = Math.max(
      0,
      views.initView.zoom - initResult.view.zoom,
      views.finalView.zoom - finalResult.view.zoom,
    );
    initResult = {
      ...initResult,
      view: { ...initResult.view, zoom: Math.max(initResult.view.minZoom ?? -Infinity, views.initView.zoom - retreat) },
    };
    finalResult = {
      ...finalResult,
      view: {
        ...finalResult.view,
        zoom: Math.max(finalResult.view.minZoom ?? -Infinity, views.finalView.zoom - retreat),
      },
    };
  }

  return {
    initView: initResult.view,
    finalView: finalResult.view,
    reasons: mergeReasons(
      {
        content: frame.reasons,
        strategy: [strategyReason],
      },
      extraReasons,
    ),
    metrics: {
      ...frame.metrics,
      initMinMarginPx: initResult.metrics.minMarginPx,
      finalMinMarginPx: finalResult.metrics.minMarginPx,
      motionEnvelopeMinMarginPx: undefined,
      initSafetyFitIterations: initResult.metrics.fitIterations,
      finalSafetyFitIterations: finalResult.metrics.fitIterations,
    },
    resolvedParameters: {
      paddingRatio: frame.paddingRatio,
      zoomBias: frame.zoomBias,
      pitchTarget: frame.pitchTarget,
      bearingDelta: frame.bearingDelta,
      anchorHeightRatio: frame.anchorHeightRatio,
      offsetRatio: frame.offsetRatio,
    },
  };
}

export function getAdaptiveCameraPaddingPx(
  recipe: CameraRecipe,
  viewportSize: ViewportSize = getDefaultViewportSize(),
) {
  const minSide = Math.min(viewportSize.width, viewportSize.height);
  const requestedPadding = Math.round(minSide * recipe.framing.paddingRatio);
  const minPadding = recipe.framing.minPaddingPx ?? 48;
  const maxPadding = Math.round(minSide * (recipe.framing.maxPaddingRatio ?? 0.24));
  const maxSafePadding = Math.max(0, Math.floor(minSide / 2 - 1));
  return Math.max(
    0,
    Math.min(maxSafePadding, Math.min(Math.max(minPadding, maxPadding), Math.max(minPadding, requestedPadding))),
  );
}

function isCurrentViewStrategy(context: CameraStrategyContext) {
  return context.recipe.purpose === 'dynamic' || (context.recipe.purpose === 'basic' && !context.recipe.requiresTarget);
}

function getComparisonTarget(input: CameraPlanInput, fallbackTarget: CameraTarget) {
  if ((input.comparisonTargets?.length ?? 0) >= 2) {
    return createMultipleTarget(input.comparisonTargets ?? []);
  }

  return fallbackTarget;
}

function getCurrentViewPullOutZoomDelta(view: CameraView, recipe: CameraRecipe) {
  const minZoom = view.minZoom ?? 0;
  const maxZoom = view.maxZoom ?? Math.max(view.zoom, 20);
  const zoomRange = Math.max(1, maxZoom - minZoom);
  const zoomRatio = clamp((view.zoom - minZoom) / zoomRange, 0, 1);
  const adaptiveDelta = clamp(
    recipe.framing.contextZoomOut + zoomRatio * 0.35,
    0.6,
    Math.max(0.6, recipe.framing.contextZoomOut + 0.35),
  );
  return Math.min(Math.max(0, view.zoom - minZoom), adaptiveDelta);
}

function getCurrentViewScanView(context: CameraStrategyContext, direction: 'horizontal' | 'vertical' = 'horizontal') {
  const viewportSize = context.input.viewportSize ?? getDefaultViewportSize();
  const offsetPx: [number, number] =
    direction === 'horizontal' ? [viewportSize.width * 0.3, 0] : [0, viewportSize.height * 0.28];

  return getViewOffsetByScreenPixels(context.baseView, viewportSize, offsetPx);
}

function fitFrameViewAtBearing({
  context,
  frame,
  bearing,
  pitch = frame.pitchTarget,
  viewKind = 'target',
  relaxPitch = true,
}: {
  context: CameraStrategyContext;
  frame: AdaptiveFrame;
  bearing: number;
  pitch?: number;
  viewKind?: 'target' | 'context';
  relaxPitch?: boolean;
}) {
  const target = context.target;
  const viewportSize = context.input.viewportSize ?? getDefaultViewportSize();
  const isContextView = viewKind === 'context';

  return fitVisualTargetToView({
    target,
    baseView: context.baseView,
    viewportSize,
    paddingRatio: isContextView ? frame.contextPaddingRatio : frame.paddingRatio,
    zoomOffset: isContextView ? frame.zoomBias - frame.contextZoomOut : frame.zoomBias,
    maxZoom: getTargetMaxZoom(target, context.baseView),
    pitch,
    bearing,
    offsetRatio: frame.offsetRatio,
    minPaddingPx: context.recipe.framing.minPaddingPx,
    maxPaddingRatio: context.recipe.framing.maxPaddingRatio,
    anchorHeightRatio: frame.anchorHeightRatio,
    pitchRelax:
      relaxPitch && !context.recipe.shots.includes('tilt')
        ? { minPitch: context.recipe.framing.pitchRange[0] }
        : undefined,
  }).view;
}

const ROTATION_ENVELOPE_STEP_DEG = 15;

function getEnvelopeBearings(startBearing: number, endBearing: number) {
  const span = endBearing - startBearing;
  const stepCount = Math.max(1, Math.ceil(Math.abs(span) / ROTATION_ENVELOPE_STEP_DEG));
  return Array.from({ length: stepCount + 1 }, (_, index) => startBearing + (span * index) / stepCount);
}

function getEnvelopeSharedZoom(
  context: CameraStrategyContext,
  frame: AdaptiveFrame,
  startBearing: number,
  endBearing: number,
  pitch?: number,
) {
  // Envelope samples must not relax pitch: each sample would relax to its own pitch, making the
  // shared zoom valid only at that sample's pitch while playback interpolates between the endpoint
  // pitches. Fitting at the styled pitch (>= any relaxed playback pitch) keeps the zoom conservative.
  return Math.min(
    ...getEnvelopeBearings(startBearing, endBearing).map(
      (bearing) => fitFrameViewAtBearing({ context, frame, bearing, pitch, relaxPitch: false }).zoom,
    ),
  );
}

// A rotated bbox's screen extent peaks at intermediate bearings, so the shared zoom samples the whole
// rotation span instead of only the endpoint bearings. `pull-out-roll` / `arc-pull-out` final frames use
// the wider context padding where the envelope gain is marginal, so they intentionally keep endpoint fits.
function fitFrameViewsAcrossBearings(context: CameraStrategyContext, frame: AdaptiveFrame, bearings: number[]) {
  const sharedZoom = getEnvelopeSharedZoom(context, frame, bearings[0], bearings[bearings.length - 1]);

  return bearings.map((bearing) => ({
    ...fitFrameViewAtBearing({ context, frame, bearing }),
    zoom: sharedZoom,
  }));
}

function getContextViewFromTargetFrame(frame: AdaptiveFrame, targetView: CameraView = frame.targetView) {
  return getZoomOutView(targetView, Math.max(0.45, frame.contextZoomOut));
}

export function getPanAcrossTarget(targetView: CameraView, target: CameraTarget, direction: 'horizontal' | 'vertical') {
  const bbox = target.visualFrame?.bbox ?? target.bbox;
  const center = target.visualFrame?.anchor ?? target.center;
  const spanLng = Math.max(Math.abs(bbox[2] - bbox[0]), 0.08);
  const spanLat = Math.max(Math.abs(bbox[3] - bbox[1]), 0.08);
  const scanScale = 0.35;
  const initView = _.cloneDeep(targetView);
  const finalView = _.cloneDeep(targetView);

  if (direction === 'horizontal') {
    initView.longitude = center[0] - spanLng * scanScale;
    finalView.longitude = center[0] + spanLng * scanScale;
  } else {
    initView.latitude = center[1] - spanLat * scanScale;
    finalView.latitude = center[1] + spanLat * scanScale;
  }

  return { initView, finalView };
}

function isLngLat(value: unknown): value is LngLat {
  return (
    Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))
  );
}

function getPathCoordinates(target: CameraTarget) {
  const coordinates = target.coordinates;
  if (!Array.isArray(coordinates)) {
    return [];
  }

  const path: LngLat[] = [];
  for (const coordinate of coordinates) {
    if (isLngLat(coordinate)) {
      path.push([Number(coordinate[0]), Number(coordinate[1])]);
      continue;
    }

    if (Array.isArray(coordinate)) {
      for (const nestedCoordinate of coordinate) {
        if (isLngLat(nestedCoordinate)) {
          path.push([Number(nestedCoordinate[0]), Number(nestedCoordinate[1])]);
        }
      }
    }
  }

  return path;
}

function getDefaultPathFramingMode(recipe: CameraRecipe) {
  return recipe.framing.pathFramingMode ?? (recipe.purpose === 'overview' ? 'fit-route' : 'follow-route');
}

function getPathSegmentCoordinates(path: LngLat[], position: 'start' | 'end') {
  if (path.length <= 3) {
    return path;
  }

  const segmentSize = clamp(Math.ceil(path.length * 0.35), 2, Math.min(path.length, 6));
  return position === 'start' ? path.slice(0, segmentSize) : path.slice(path.length - segmentSize);
}

function createPathSegmentTarget(target: CameraTarget, segment: LngLat[]) {
  const segmentTarget = createPathTarget(segment, [], target.source);
  if (!segmentTarget) {
    return undefined;
  }

  return {
    ...segmentTarget,
    selectedRows: target.selectedRows,
    stats: {
      ...segmentTarget.stats,
      densityRatio: target.stats?.densityRatio,
      density: target.stats?.density,
      elevationRatio: target.stats?.elevationRatio,
      maxElevationRatio: target.stats?.maxElevationRatio,
      layerKinds: target.stats?.layerKinds,
      radiusMeters: target.stats?.radiusMeters,
    },
  } satisfies CameraTarget;
}

function getPathTrackingViews(context: CameraStrategyContext, frame: AdaptiveFrame) {
  const target = context.target;
  const path = target.type === 'path' ? (target.timedPath?.coordinates ?? getPathCoordinates(target)) : [];
  const start = target.timedPath ? path[0] : isLngLat(target.start) ? target.start : path[0];
  const end = target.timedPath ? path[path.length - 1] : isLngLat(target.end) ? target.end : path[path.length - 1];

  if (!isLngLat(start) || !isLngLat(end)) {
    return undefined;
  }

  if (getDefaultPathFramingMode(context.recipe) === 'follow-route' && path.length >= 2) {
    const startTarget = createPathSegmentTarget(target, getPathSegmentCoordinates(path, 'start'));
    const endTarget = createPathSegmentTarget(target, getPathSegmentCoordinates(path, 'end'));

    if (startTarget && endTarget) {
      const startFrame = resolveAdaptiveFrame(context, { target: startTarget, paddingBonus: 0.02 });
      const endFrame = resolveAdaptiveFrame(context, { target: endTarget, paddingBonus: 0.02 });

      return {
        initView: {
          ...startFrame.targetView,
          longitude: start[0],
          latitude: start[1],
        },
        finalView: {
          ...endFrame.targetView,
          longitude: end[0],
          latitude: end[1],
        },
        safety: { init: false, final: false },
        reason: 'Tracking follows local path segments so the route endpoints stay closer and more readable.',
      };
    }
  }

  return {
    initView: {
      ...frame.targetView,
      longitude: start[0],
      latitude: start[1],
    },
    finalView: {
      ...frame.targetView,
      longitude: end[0],
      latitude: end[1],
    },
    // Endpoint views intentionally de-center the path anchor; safety re-centering would cancel the travel.
    safety: { init: false, final: false },
    reason: 'Tracking follows the complete path while retaining a wide overview scale.',
  };
}

function handleStatic(context: CameraStrategyContext) {
  const frame = resolveAdaptiveFrame(context);
  const view = isCurrentViewStrategy(context) ? context.baseView : frame.targetView;
  return createStrategyResult(
    context,
    { initView: view, finalView: view },
    frame,
    'Static holds the adapted frame so the selected target remains stable and readable.',
  );
}

function handlePushIn(context: CameraStrategyContext) {
  const frame = resolveAdaptiveFrame(context);
  if (isCurrentViewStrategy(context)) {
    return createStrategyResult(
      context,
      {
        initView: _.cloneDeep(context.baseView),
        finalView: getZoomInView(context.baseView, Math.max(0.4, context.recipe.framing.contextZoomOut * 0.5)),
      },
      frame,
      'Push-in adds subtle motion from the current view because no target is required.',
    );
  }

  return createStrategyResult(
    context,
    { initView: getContextViewFromTargetFrame(frame), finalView: frame.targetView },
    frame,
    'Push-in starts from a wider contextual frame and ends on the adapted target frame.',
  );
}

function handlePullOut(context: CameraStrategyContext) {
  const frame = resolveAdaptiveFrame(context);
  if (isCurrentViewStrategy(context)) {
    return createStrategyResult(
      context,
      {
        initView: _.cloneDeep(context.baseView),
        finalView: getZoomOutView(context.baseView, getCurrentViewPullOutZoomDelta(context.baseView, context.recipe)),
      },
      frame,
      'Pull-out adds motion by expanding the current view.',
    );
  }

  if (context.recipe.purpose === 'comparison') {
    const firstTarget = context.input.comparisonTargets?.[0] ?? context.target;
    const combinedTarget = getComparisonTarget(context.input, context.target);
    const firstFrame = resolveAdaptiveFrame(context, { target: firstTarget });
    const combinedFrame = resolveAdaptiveFrame(context, { target: combinedTarget });
    // Both target fits can reach the same type-specific zoom cap. Preserve the
    // requested pull-out by widening the shared frame, subject to the real floor.
    const finalView = getZoomOutView(
      combinedFrame.targetView,
      Math.max(
        0,
        combinedFrame.targetView.zoom - firstFrame.targetView.zoom + Math.max(0.45, combinedFrame.contextZoomOut),
      ),
    );
    return createStrategyResult(
      context,
      { initView: firstFrame.targetView, finalView },
      combinedFrame,
      'Pull-out begins on one comparison target and ends on the shared comparison frame.',
      { content: firstFrame.reasons },
      { init: false, final: true },
    );
  }

  return createStrategyResult(
    context,
    { initView: frame.targetView, finalView: getContextViewFromTargetFrame(frame) },
    frame,
    'Pull-out begins on the selected target and reveals surrounding spatial context.',
  );
}

function handlePan(context: CameraStrategyContext) {
  const frame = resolveAdaptiveFrame(context);
  if (isCurrentViewStrategy(context)) {
    return createStrategyResult(
      context,
      {
        initView: _.cloneDeep(context.baseView),
        finalView: getCurrentViewScanView(context, 'horizontal'),
      },
      frame,
      'Pan shifts the current view laterally to add continuity.',
    );
  }

  if (context.recipe.purpose === 'comparison' && (context.input.comparisonTargets?.length ?? 0) >= 2) {
    const comparisonTargets = context.input.comparisonTargets ?? [];
    const firstFrame = resolveAdaptiveFrame(context, { target: comparisonTargets[0] });
    const secondFrame = resolveAdaptiveFrame(context, { target: comparisonTargets[comparisonTargets.length - 1] });
    const sharedZoom = Math.min(firstFrame.targetView.zoom, secondFrame.targetView.zoom);
    return createStrategyResult(
      context,
      {
        initView: { ...firstFrame.targetView, zoom: sharedZoom },
        finalView: { ...secondFrame.targetView, zoom: sharedZoom },
      },
      secondFrame,
      'Pan moves between comparison targets while keeping a consistent zoom for fair comparison.',
      { content: firstFrame.reasons },
      { init: false, final: false },
    );
  }

  return createStrategyResult(
    context,
    {
      initView: getViewWithCenter(context.baseView, createTargetFromView(context.baseView)),
      finalView: frame.targetView,
    },
    frame,
    'Pan moves from the current viewpoint to the adapted target frame.',
    {},
    { init: false, final: true },
  );
}

function handleCameraRoll(context: CameraStrategyContext) {
  const frame = resolveAdaptiveFrame(context, {
    paddingBonus: context.recipe.adaptation.rotationPaddingBonus,
    zoomOutBonus: 0.15,
  });
  if (isCurrentViewStrategy(context)) {
    return createStrategyResult(
      context,
      {
        initView: _.cloneDeep(context.baseView),
        finalView: { ...context.baseView, bearing: context.baseView.bearing + frame.bearingDelta },
      },
      frame,
      'Camera roll rotates the current view because no target is required.',
    );
  }

  const [initView, finalView] = fitFrameViewsAcrossBearings(context, frame, [
    frame.targetView.bearing,
    frame.targetView.bearing + frame.bearingDelta,
  ]);

  return createStrategyResult(
    context,
    { initView, finalView },
    frame,
    'Camera roll keeps the target centered and widens the frame before rotating.',
  );
}

function handleArc(context: CameraStrategyContext) {
  const frame = resolveAdaptiveFrame(context, {
    paddingBonus: context.recipe.adaptation.rotationPaddingBonus,
    zoomOutBonus: 0.2,
  });
  if (isCurrentViewStrategy(context)) {
    return createStrategyResult(
      context,
      {
        initView: {
          ...context.baseView,
          pitch: Math.max(context.baseView.pitch, frame.pitchTarget),
          bearing: context.baseView.bearing - frame.bearingDelta,
        },
        finalView: {
          ...context.baseView,
          pitch: Math.max(context.baseView.pitch, frame.pitchTarget),
          bearing: context.baseView.bearing + frame.bearingDelta,
        },
      },
      frame,
      'Arc orbits the current view with the profile bearing range.',
    );
  }

  const [initView, finalView] = fitFrameViewsAcrossBearings(context, frame, [
    frame.targetView.bearing - frame.bearingDelta,
    frame.targetView.bearing + frame.bearingDelta,
  ]);

  return createStrategyResult(
    context,
    { initView, finalView },
    frame,
    'Arc orbits symmetrically around the adapted target frame.',
  );
}

function handleTilt(context: CameraStrategyContext) {
  const frame = resolveAdaptiveFrame(context, { zoomOutBonus: 0.1 });
  const view = isCurrentViewStrategy(context) ? context.baseView : frame.targetView;
  const [minPitch] = context.recipe.framing.pitchRange;
  return createStrategyResult(
    context,
    {
      initView: { ...view, pitch: Math.min(view.pitch, minPitch) },
      finalView: { ...view, pitch: frame.pitchTarget },
    },
    frame,
    'Tilt starts at a lower pitch and ends at a content-adapted pitch to reveal vertical structure.',
  );
}

function handleTrucking(context: CameraStrategyContext) {
  const frame = resolveAdaptiveFrame(context);
  if (isCurrentViewStrategy(context)) {
    return createStrategyResult(
      context,
      {
        initView: _.cloneDeep(context.baseView),
        finalView: getCurrentViewScanView(context, 'horizontal'),
      },
      frame,
      'Trucking moves laterally across the current view.',
    );
  }

  const bbox = context.target.visualFrame?.bbox ?? context.target.bbox;
  const spanLng = Math.abs(bbox[2] - bbox[0]);
  const spanLat = Math.abs(bbox[3] - bbox[1]);
  const direction = spanLng >= spanLat ? 'horizontal' : 'vertical';
  return createStrategyResult(
    context,
    getPanAcrossTarget(frame.targetView, context.target, direction),
    frame,
    `Trucking scans ${direction === 'horizontal' ? 'horizontally' : 'vertically'} across the selected visual frame.`,
    {},
    // Scan endpoints intentionally de-center the anchor; safety re-centering would cancel the scan motion.
    { init: false, final: false },
  );
}

function handleTracking(context: CameraStrategyContext) {
  const frame = resolveAdaptiveFrame(context, { paddingBonus: 0.02 });
  if (isCurrentViewStrategy(context)) {
    return handleTrucking(context);
  }

  const trackingViews = getPathTrackingViews(context, frame);
  if (trackingViews) {
    return createStrategyResult(context, trackingViews, frame, trackingViews.reason, {}, trackingViews.safety);
  }

  return createStrategyResult(
    context,
    getPanAcrossTarget(frame.targetView, context.target, 'horizontal'),
    frame,
    'Tracking fell back to a horizontal scan because the selected path geometry is incomplete.',
    {},
    // Scan endpoints intentionally de-center the anchor; safety re-centering would cancel the scan motion.
    { init: false, final: false },
  );
}

function handleArcTilt(context: CameraStrategyContext) {
  const frame = resolveAdaptiveFrame(context, {
    paddingBonus: context.recipe.adaptation.rotationPaddingBonus,
    zoomOutBonus: 0.2,
  });
  const [minPitch] = context.recipe.framing.pitchRange;
  const initView = fitFrameViewAtBearing({
    context,
    frame,
    bearing: frame.targetView.bearing - frame.bearingDelta,
    pitch: minPitch,
  });
  const finalView = fitFrameViewAtBearing({
    context,
    frame,
    bearing: frame.targetView.bearing + frame.bearingDelta,
    pitch: frame.pitchTarget,
  });
  const sharedZoom = Math.min(
    initView.zoom,
    finalView.zoom,
    getEnvelopeSharedZoom(
      context,
      frame,
      frame.targetView.bearing - frame.bearingDelta,
      frame.targetView.bearing + frame.bearingDelta,
      frame.pitchTarget,
    ),
  );
  return createStrategyResult(
    context,
    {
      initView: { ...initView, zoom: sharedZoom },
      finalView: { ...finalView, zoom: sharedZoom },
    },
    frame,
    'Arc & tilt combines a symmetric orbit with a pitch reveal around the adapted target frame.',
  );
}

function handlePullOutRoll(context: CameraStrategyContext) {
  const frame = resolveAdaptiveFrame(context, {
    paddingBonus: context.recipe.adaptation.rotationPaddingBonus,
    zoomOutBonus: 0.15,
  });
  const initView = fitFrameViewAtBearing({
    context,
    frame,
    bearing: frame.targetView.bearing,
  });
  const finalView = fitFrameViewAtBearing({
    context,
    frame,
    bearing: frame.contextView.bearing + frame.bearingDelta,
    viewKind: 'context',
  });
  finalView.zoom = Math.max(
    finalView.minZoom ?? -Infinity,
    Math.min(finalView.zoom, initView.zoom - Math.max(0.45, frame.contextZoomOut)),
  );
  return createStrategyResult(
    context,
    { initView, finalView },
    frame,
    'Pull-out & roll reveals context while rotating with the profile bearing delta.',
  );
}

function handleArcPullOut(context: CameraStrategyContext) {
  const frame = resolveAdaptiveFrame(context, {
    paddingBonus: context.recipe.adaptation.rotationPaddingBonus,
    zoomOutBonus: 0.2,
  });
  const initView = fitFrameViewAtBearing({
    context,
    frame,
    bearing: frame.targetView.bearing - frame.bearingDelta,
  });
  const finalView = fitFrameViewAtBearing({
    context,
    frame,
    bearing: frame.contextView.bearing + frame.bearingDelta,
    viewKind: 'context',
  });
  finalView.zoom = Math.max(
    finalView.minZoom ?? -Infinity,
    Math.min(finalView.zoom, initView.zoom - Math.max(0.45, frame.contextZoomOut)),
  );
  return createStrategyResult(
    context,
    { initView, finalView },
    frame,
    'Arc & pull-out starts near the target and ends on a wider contextual orbit frame.',
  );
}

function handlePushInTilt(context: CameraStrategyContext) {
  const frame = resolveAdaptiveFrame(context);
  const [minPitch] = context.recipe.framing.pitchRange;
  return createStrategyResult(
    context,
    {
      initView: { ...getContextViewFromTargetFrame(frame), pitch: minPitch },
      finalView: {
        ...frame.targetView,
        pitch: frame.pitchTarget,
      },
    },
    frame,
    'Push-in & tilt starts from context and finishes with a content-adapted pitch reveal.',
  );
}

function handlePanTilt(context: CameraStrategyContext) {
  const frame = resolveAdaptiveFrame(context);
  const [minPitch] = context.recipe.framing.pitchRange;
  return createStrategyResult(
    context,
    {
      initView: { ...context.baseView, pitch: minPitch },
      finalView: {
        ...frame.targetView,
        pitch: frame.pitchTarget,
      },
    },
    frame,
    'Pan & tilt moves to the target while changing pitch for emphasis or supplemental context.',
    {},
    { init: false, final: true },
  );
}

function handlePanPushIn(context: CameraStrategyContext) {
  if (context.recipe.purpose === 'comparison' && (context.input.comparisonTargets?.length ?? 0) >= 2) {
    const comparisonTargets = context.input.comparisonTargets ?? [];
    const firstFrame = resolveAdaptiveFrame(context, { target: comparisonTargets[0] });
    const secondFrame = resolveAdaptiveFrame(context, { target: comparisonTargets[comparisonTargets.length - 1] });
    const sharedZoom = Math.min(firstFrame.targetView.zoom, secondFrame.targetView.zoom);
    return createStrategyResult(
      context,
      {
        initView: { ...firstFrame.targetView, zoom: sharedZoom },
        finalView: getZoomInView(
          { ...secondFrame.targetView, zoom: sharedZoom },
          0.45,
          getTargetMaxZoom(comparisonTargets[comparisonTargets.length - 1], context.baseView),
        ),
      },
      secondFrame,
      'Pan & push-in first preserves comparison scale, then ends by moving closer to the comparison target.',
      { content: firstFrame.reasons },
      { init: false, final: false },
    );
  }

  return handlePan(context);
}

function handleTrackingPushIn(context: CameraStrategyContext) {
  const frame = resolveAdaptiveFrame(context, { paddingBonus: 0.02 });
  const trackingViews = getPathTrackingViews(context, frame);
  if (!trackingViews) {
    return handleTracking(context);
  }

  const finalView = getZoomInView(trackingViews.finalView, 0.45, getTargetMaxZoom(context.target, context.baseView));
  // A capped endpoint cannot zoom in further. Start wider instead; zooming out
  // retains the route window and still respects the camera's actual minZoom.
  const initView = getZoomOutView(
    trackingViews.initView,
    Math.max(0, trackingViews.initView.zoom - finalView.zoom + 0.45),
  );
  return createStrategyResult(
    context,
    { initView, finalView },
    frame,
    'Tracking & push-in follows the path and ends closer to the route endpoint.',
    {},
    trackingViews.safety,
  );
}

export const strategyHandlers: Record<CameraRecipeStrategy, CameraStrategyHandler> = {
  static: handleStatic,
  'push-in': handlePushIn,
  'pull-out': handlePullOut,
  pan: handlePan,
  'camera-roll': handleCameraRoll,
  arc: handleArc,
  tilt: handleTilt,
  trucking: handleTrucking,
  tracking: handleTracking,
  'push-in-tilt': handlePushInTilt,
  'arc-tilt': handleArcTilt,
  'pan-tilt': handlePanTilt,
  'pan-push-in': handlePanPushIn,
  'pull-out-roll': handlePullOutRoll,
  'arc-pull-out': handleArcPullOut,
  'tracking-push-in': handleTrackingPushIn,
};

export function planCameraViews(context: CameraStrategyContext) {
  return strategyHandlers[context.recipe.strategy](context);
}
