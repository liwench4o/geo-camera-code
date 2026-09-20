import { WebMercatorViewport } from '@deck.gl/core';
import type { CameraView } from '../interfaces';
import { normalizeTargetType } from './catalog';
import { centerOfBbox, normalizeBbox } from './selection';
import { projectEnvelopeFootprints, projectVisualPrimitiveFootprints } from './geometry/primitives';
import { unwrapLongitude, MERCATOR_LATITUDE_LIMIT } from './geometry/geo-wrap';
import type { ScreenRect } from './geometry/types';
import type { WorldPosition } from './geometry/types';
import type { BBox, CameraTarget, ViewportSize } from './types';

const DEFAULT_VIEWPORT_SIZE: ViewportSize = {
  width: 1280,
  height: 720,
};
const FIT_MAX_ITERATIONS = 16;
const FIT_ZOOM_STEP = 0.25;
const PITCH_RELAX_THRESHOLD_ZOOM = 0.75;
const PITCH_RELAX_STEP_DEG = 6;

export interface PitchRelaxOptions {
  /** Lowest pitch the relaxation may reach (use the recipe pitchRange minimum). */
  minPitch: number;
  /** Zoom-out budget (zoom levels) consumed before pitch starts relaxing. */
  thresholdZoomOut?: number;
  /** Degrees removed per relaxation step. */
  stepDeg?: number;
}

function clamp(value: number, min = -Infinity, max = Infinity) {
  return Math.min(max, Math.max(min, value));
}

function isFinitePoint(point: number[]) {
  return point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

export function getDefaultViewportSize() {
  return DEFAULT_VIEWPORT_SIZE;
}

export function clampViewState(viewState: CameraView): CameraView {
  return {
    ...viewState,
    zoom: clamp(viewState.zoom, viewState.minZoom, viewState.maxZoom),
    pitch: clamp(viewState.pitch, viewState.minPitch, viewState.maxPitch),
  };
}

export function getZoomOutView(viewState: CameraView, zoomDelta: number): CameraView {
  return clampViewState({
    ...viewState,
    zoom: viewState.zoom - zoomDelta,
  });
}

export function getZoomInView(viewState: CameraView, zoomDelta: number, maxZoom?: number): CameraView {
  return clampViewState({
    ...viewState,
    zoom: clamp(viewState.zoom + zoomDelta, viewState.minZoom, maxZoom ?? viewState.maxZoom),
  });
}

export function getViewWithCenter(viewState: CameraView, target: CameraTarget): CameraView {
  return {
    ...viewState,
    longitude: target.center[0],
    latitude: target.center[1],
  };
}

export function getViewOffsetByScreenPixels(
  viewState: CameraView,
  viewportSize: ViewportSize = DEFAULT_VIEWPORT_SIZE,
  offsetPx: [number, number],
): CameraView {
  const viewport = createViewport(viewState, viewportSize);
  const nextCenter = viewport.unproject([viewportSize.width / 2 + offsetPx[0], viewportSize.height / 2 + offsetPx[1]]);

  if (!isFinitePoint(nextCenter)) {
    return viewState;
  }

  return clampViewState({
    ...viewState,
    longitude: nextCenter[0],
    latitude: nextCenter[1],
  });
}

export function getTargetMaxZoom(target: CameraTarget, baseView: CameraView) {
  const baseMaxZoom = baseView.maxZoom ?? 16;
  const targetType = normalizeTargetType(target.type);
  if (targetType === 'location') {
    return Math.min(baseMaxZoom, 13);
  }
  if (targetType === 'region') {
    return Math.min(baseMaxZoom, 12);
  }
  if (targetType === 'multiple' || targetType === 'path') {
    return Math.min(baseMaxZoom, 11);
  }
  return baseMaxZoom;
}

export interface VisualFitMetrics {
  /** Anchor-to-desired-pixel distance (px); undefined when the anchor projection is unmeasurable at this view. */
  centerErrorPx?: number;
  /**
   * Smallest distance (px) from the projected content bounds to the VIEWPORT edges, not to the
   * anchor-centered safety window — the window only gates the fit loop, it is not measured here.
   */
  minMarginPx: number;
  fitIterations: number;
  viewportWidth: number;
  viewportHeight: number;
  paddingPx: number;
}

export interface VisualFitResult {
  status: 'fitted' | 'unresolved';
  reason?: string;
  view: CameraView;
  metrics: VisualFitMetrics;
}

export function getVisualFrameBbox(target: CameraTarget) {
  if (target.snapshotEnvelope) {
    const points: WorldPosition[] = target.snapshotEnvelope.frame.primitives.flatMap((primitive): WorldPosition[] => {
      switch (primitive.kind) {
        case 'point-disc':
        case 'screen-rect':
          return [primitive.position];
        case 'extruded-footprint':
        case 'polygon':
          return primitive.rings.flat();
        case 'path-corridor':
          return primitive.positions;
        case 'mesh-support':
          return primitive.vertices;
      }
    });
    if (points.length)
      return normalizeBbox([
        Math.min(...points.map((point) => point[0])),
        Math.min(...points.map((point) => point[1])),
        Math.max(...points.map((point) => point[0])),
        Math.max(...points.map((point) => point[1])),
      ]);
  }
  return normalizeBbox(target.visualFrame?.bbox ?? target.bbox);
}

function getVisualFrameAnchor(target: CameraTarget) {
  if (target.snapshotEnvelope) return target.snapshotEnvelope.frame.anchor.slice(0, 2) as [number, number];
  return target.visualFrame?.anchor ?? target.center ?? centerOfBbox(getVisualFrameBbox(target));
}

function getAnchorHeightMeters(target: CameraTarget, anchorHeightRatio?: number) {
  if (target.snapshotEnvelope) return anchorHeightRatio === 0 ? 0 : target.snapshotEnvelope.frame.anchor[2];
  const heightMeters = target.visualFrame?.heightMeters;
  if (!heightMeters || !Number.isFinite(heightMeters) || heightMeters <= 0) {
    return 0;
  }
  return clamp(anchorHeightRatio ?? 0, 0, 1) * heightMeters;
}

function getPaddingPx({
  viewportSize,
  paddingRatio,
  minPaddingPx = 48,
  maxPaddingRatio = 0.24,
  extraPaddingPx = 0,
}: {
  viewportSize: ViewportSize;
  paddingRatio: number;
  minPaddingPx?: number;
  maxPaddingRatio?: number;
  extraPaddingPx?: number;
}) {
  const minSide = Math.min(viewportSize.width, viewportSize.height);
  const requestedPadding = Math.round(minSide * paddingRatio + extraPaddingPx);
  const maxPadding = Math.round(minSide * maxPaddingRatio);
  const maxSafePadding = Math.max(0, Math.floor(minSide / 2 - 1));
  return Math.max(
    0,
    Math.min(maxSafePadding, Math.min(Math.max(minPaddingPx, maxPadding), Math.max(minPaddingPx, requestedPadding))),
  );
}

function createViewport(viewState: CameraView, viewportSize: ViewportSize) {
  return new WebMercatorViewport({
    width: viewportSize.width,
    height: viewportSize.height,
    longitude: viewState.longitude,
    latitude: viewState.latitude,
    zoom: viewState.zoom,
    pitch: viewState.pitch,
    bearing: viewState.bearing,
    altitude: viewState.altitude,
  });
}

function projectLngLat(viewState: CameraView, viewportSize: ViewportSize, coordinate: number[], heightMeters = 0) {
  const projected = createViewport(viewState, viewportSize).project([coordinate[0], coordinate[1], heightMeters]);
  return isFinitePoint(projected) ? projected : undefined;
}

function getDesiredAnchorPixel(viewportSize: ViewportSize, offsetRatio: [number, number] = [0, 0]) {
  return [viewportSize.width * (0.5 + offsetRatio[0]), viewportSize.height * (0.5 + offsetRatio[1])] satisfies [
    number,
    number,
  ];
}

const ALIGN_MAX_ITERATIONS = 3;
const ALIGN_TOLERANCE_PX = 0.5;

export function alignVisualAnchor({
  viewState,
  target,
  viewportSize,
  offsetRatio,
  anchorHeightRatio,
  maxIterations = ALIGN_MAX_ITERATIONS,
}: {
  viewState: CameraView;
  target: CameraTarget;
  viewportSize: ViewportSize;
  offsetRatio?: [number, number];
  anchorHeightRatio?: number;
  maxIterations?: number;
}) {
  const anchor = getVisualFrameAnchor(target);
  const anchorHeightMeters = getAnchorHeightMeters(target, anchorHeightRatio);
  const desiredAnchor = getDesiredAnchorPixel(viewportSize, offsetRatio);
  let view = viewState;
  let bestView = viewState;
  let bestErrorPx = Infinity;

  // Measure the incoming view and the result of every translation, keeping the lowest-error view so a
  // diverging step (e.g. tall anchors near the horizon) can never make the alignment worse than its input.
  for (let iteration = 0; iteration <= maxIterations; iteration++) {
    const anchorPixel = projectLngLat(view, viewportSize, anchor, anchorHeightMeters);
    if (!anchorPixel) {
      break;
    }
    const errorPx = Math.hypot(anchorPixel[0] - desiredAnchor[0], anchorPixel[1] - desiredAnchor[1]);
    if (errorPx < bestErrorPx) {
      bestErrorPx = errorPx;
      bestView = view;
    }
    if (errorPx <= ALIGN_TOLERANCE_PX || iteration === maxIterations) {
      break;
    }

    const viewport = createViewport(view, viewportSize);
    const centerPixel = [
      viewportSize.width / 2 + anchorPixel[0] - desiredAnchor[0],
      viewportSize.height / 2 + anchorPixel[1] - desiredAnchor[1],
    ];
    const nextCenter = viewport.unproject(centerPixel);
    if (!isFinitePoint(nextCenter)) {
      break;
    }

    view = clampViewState({
      ...view,
      longitude: nextCenter[0],
      latitude: nextCenter[1],
    });
  }

  return bestView;
}

function getVisualSampleCoordinates(target: CameraTarget) {
  const bbox = getVisualFrameBbox(target);
  const anchor = getVisualFrameAnchor(target);
  const visualSamples = (target.visualFrame?.sampleCoordinates ?? []).map(
    (coordinate) =>
      [Number(coordinate[0]), Number(coordinate[1]), Number(coordinate[2] ?? 0)] as [number, number, number],
  );
  const samples: Array<[number, number, number]> = [
    [bbox[0], bbox[1], 0],
    [bbox[0], bbox[3], 0],
    [bbox[2], bbox[1], 0],
    [bbox[2], bbox[3], 0],
    [anchor[0], anchor[1], 0],
    ...visualSamples,
  ];
  const heightMeters = target.visualFrame?.heightMeters;

  if (heightMeters && Number.isFinite(heightMeters) && heightMeters > 0) {
    samples.push(
      [bbox[0], bbox[1], heightMeters],
      [bbox[0], bbox[3], heightMeters],
      [bbox[2], bbox[1], heightMeters],
      [bbox[2], bbox[3], heightMeters],
      [anchor[0], anchor[1], heightMeters],
      ...visualSamples.map((coordinate) => [coordinate[0], coordinate[1], heightMeters] as [number, number, number]),
    );
  }

  return samples;
}

export function getProjectedVisualBounds(
  viewState: CameraView,
  target: CameraTarget,
  viewportSize: ViewportSize,
): ScreenRect | undefined {
  if (!isFiniteCameraView(viewState, viewportSize)) return undefined;
  if (target.children?.length && !target.snapshotEnvelope) {
    const children = target.children.map((child) => getProjectedVisualBounds(viewState, child, viewportSize));
    if (children.some((child) => !child)) return undefined;
    return {
      minX: Math.min(...children.map((child) => child!.minX)),
      minY: Math.min(...children.map((child) => child!.minY)),
      maxX: Math.max(...children.map((child) => child!.maxX)),
      maxY: Math.max(...children.map((child) => child!.maxY)),
    };
  }
  const options = { meterSupportTolerancePx: 0.5, meterSupportIntervalBudget: 256 };
  const projected = target.snapshotEnvelope
    ? projectEnvelopeFootprints(target.snapshotEnvelope.frame, viewState, viewportSize, options)
    : projectVisualPrimitiveFootprints(
        [
          {
            kind: 'mesh-support',
            conservative: true,
            vertices: getVisualSampleCoordinates(target).map((coordinate) => [
              unwrapLongitude(coordinate[0], viewState.longitude),
              coordinate[1],
              coordinate[2],
            ]),
          },
        ],
        viewState,
        viewportSize,
        options,
      );
  if (projected.status !== 'ok') return undefined;
  return {
    minX: Math.min(...projected.value.map((footprint) => footprint.bounds.minX)),
    minY: Math.min(...projected.value.map((footprint) => footprint.bounds.minY)),
    maxX: Math.max(...projected.value.map((footprint) => footprint.bounds.maxX)),
    maxY: Math.max(...projected.value.map((footprint) => footprint.bounds.maxY)),
  };
}

export function isFiniteCameraView(view: CameraView, viewport: ViewportSize = DEFAULT_VIEWPORT_SIZE) {
  return (
    (['longitude', 'latitude', 'zoom', 'pitch', 'bearing'] as const).every((key) => Number.isFinite(view[key])) &&
    Math.abs(view.latitude) <= MERCATOR_LATITUDE_LIMIT &&
    view.pitch >= 0 &&
    view.pitch < 89 &&
    (view.altitude === undefined || (Number.isFinite(view.altitude) && view.altitude > 0)) &&
    view.zoom >= Math.max(-2, view.minZoom ?? -2) &&
    view.zoom <= (view.maxZoom ?? 24) &&
    Number.isFinite(viewport.width) &&
    viewport.width > 0 &&
    Number.isFinite(viewport.height) &&
    viewport.height > 0
  );
}

function getVisualFitMetrics(
  viewState: CameraView,
  target: CameraTarget,
  viewportSize: ViewportSize,
  paddingPx: number,
  offsetRatio: [number, number] | undefined,
  fitIterations: number,
  anchorHeightRatio?: number,
): VisualFitMetrics {
  const bounds = getProjectedVisualBounds(viewState, target, viewportSize);
  const desiredAnchor = getDesiredAnchorPixel(viewportSize, offsetRatio);
  const anchor = getVisualFrameAnchor(target);
  const anchorPixel = projectLngLat(viewState, viewportSize, anchor, getAnchorHeightMeters(target, anchorHeightRatio));
  const minMarginPx = bounds
    ? Math.min(bounds.minX, bounds.minY, viewportSize.width - bounds.maxX, viewportSize.height - bounds.maxY)
    : Number.NEGATIVE_INFINITY;
  // Tall anchors near/behind the horizon project to non-finite or absurdly distant pixels; the raw
  // hypot is garbage there (hundreds of thousands of px), so the metric is reported as unmeasurable.
  const rawCenterErrorPx = anchorPixel
    ? Math.hypot(anchorPixel[0] - desiredAnchor[0], anchorPixel[1] - desiredAnchor[1])
    : undefined;
  const centerErrorPx =
    rawCenterErrorPx !== undefined && rawCenterErrorPx < 4 * Math.hypot(viewportSize.width, viewportSize.height)
      ? Number(rawCenterErrorPx.toFixed(2))
      : undefined;

  return {
    centerErrorPx,
    minMarginPx: Number(minMarginPx.toFixed(2)),
    fitIterations,
    viewportWidth: viewportSize.width,
    viewportHeight: viewportSize.height,
    paddingPx,
  };
}

function getSafetyWindowHalfExtents(viewportSize: ViewportSize, paddingPx: number, offsetRatio?: [number, number]) {
  const anchorPixel = getDesiredAnchorPixel(viewportSize, offsetRatio);
  return {
    halfWidth: Math.min(anchorPixel[0], viewportSize.width - anchorPixel[0]) - paddingPx,
    halfHeight: Math.min(anchorPixel[1], viewportSize.height - anchorPixel[1]) - paddingPx,
  };
}

function isVisualInsideSafetyWindow(
  viewState: CameraView,
  target: CameraTarget,
  viewportSize: ViewportSize,
  paddingPx: number,
  offsetRatio?: [number, number],
) {
  const bounds = getProjectedVisualBounds(viewState, target, viewportSize);
  if (!bounds) {
    return false;
  }

  // Safety window centered on the desired anchor: with offset [0,0] this is exactly the symmetric
  // padding frame, while an offset shrinks the window so the reserved band stays clear of content.
  const anchorPixel = getDesiredAnchorPixel(viewportSize, offsetRatio);
  const { halfWidth, halfHeight } = getSafetyWindowHalfExtents(viewportSize, paddingPx, offsetRatio);
  if (halfWidth <= 0 || halfHeight <= 0) {
    return false;
  }

  return (
    bounds.minX >= anchorPixel[0] - halfWidth &&
    bounds.maxX <= anchorPixel[0] + halfWidth &&
    bounds.minY >= anchorPixel[1] - halfHeight &&
    bounds.maxY <= anchorPixel[1] + halfHeight
  );
}

function runSafetyFitLoop({
  view,
  target,
  viewportSize,
  padding,
  offsetRatio,
  anchorHeightRatio,
  pitchRelax,
}: {
  view: CameraView;
  target: CameraTarget;
  viewportSize: ViewportSize;
  padding: number;
  offsetRatio?: [number, number];
  anchorHeightRatio?: number;
  pitchRelax?: PitchRelaxOptions;
}): { view: CameraView; fitIterations: number } {
  let fitIterations = 0;
  let zoomOutApplied = 0;

  // The window's half-extents are loop-invariant (only viewportSize/padding/offsetRatio), so a
  // degenerate window can never be satisfied — skip the shrink loop instead of burning iterations.
  const { halfWidth, halfHeight } = getSafetyWindowHalfExtents(viewportSize, padding, offsetRatio);
  const windowUsable = halfWidth > 0 && halfHeight > 0;

  for (; windowUsable && fitIterations < FIT_MAX_ITERATIONS; fitIterations++) {
    view = alignVisualAnchor({
      viewState: view,
      target,
      viewportSize,
      offsetRatio,
      anchorHeightRatio,
    });

    if (isVisualInsideSafetyWindow(view, target, viewportSize, padding, offsetRatio)) {
      break;
    }

    // Floor relaxation at view.minPitch as well: below it clampViewState would hold pitch constant
    // while this branch kept firing, starving the zoom-out fallback for the rest of the budget.
    const pitchFloor = pitchRelax ? Math.max(pitchRelax.minPitch, view.minPitch ?? -Infinity) : Infinity;
    if (
      pitchRelax &&
      zoomOutApplied >= (pitchRelax.thresholdZoomOut ?? PITCH_RELAX_THRESHOLD_ZOOM) &&
      view.pitch > pitchFloor
    ) {
      view = clampViewState({
        ...view,
        pitch: Math.max(pitchFloor, view.pitch - (pitchRelax.stepDeg ?? PITCH_RELAX_STEP_DEG)),
      });
      continue;
    }

    const nextZoom = Math.max(view.minZoom ?? -Infinity, view.zoom - FIT_ZOOM_STEP);
    if (nextZoom === view.zoom) {
      break;
    }

    zoomOutApplied += view.zoom - nextZoom;
    view = clampViewState({
      ...view,
      zoom: nextZoom,
    });
  }

  view = alignVisualAnchor({
    viewState: view,
    target,
    viewportSize,
    offsetRatio,
    anchorHeightRatio,
  });

  return { view, fitIterations };
}

export function measureVisualTargetFit({
  viewState,
  target,
  viewportSize = DEFAULT_VIEWPORT_SIZE,
  paddingRatio = 0.12,
  offsetRatio,
  minPaddingPx,
  maxPaddingRatio,
  fitIterations = 0,
  anchorHeightRatio,
}: {
  viewState: CameraView;
  target: CameraTarget;
  viewportSize?: ViewportSize;
  paddingRatio?: number;
  offsetRatio?: [number, number];
  minPaddingPx?: number;
  maxPaddingRatio?: number;
  fitIterations?: number;
  anchorHeightRatio?: number;
}): VisualFitMetrics {
  const padding = getPaddingPx({
    viewportSize,
    paddingRatio,
    minPaddingPx,
    maxPaddingRatio,
    extraPaddingPx: target.visualFrame?.extraPaddingPx,
  });
  return getVisualFitMetrics(viewState, target, viewportSize, padding, offsetRatio, fitIterations, anchorHeightRatio);
}

export function ensureVisualTargetVisible({
  viewState,
  target,
  viewportSize = DEFAULT_VIEWPORT_SIZE,
  paddingRatio = 0.12,
  offsetRatio,
  minPaddingPx,
  maxPaddingRatio,
  anchorHeightRatio,
  pitchRelax,
}: {
  viewState: CameraView;
  target: CameraTarget;
  viewportSize?: ViewportSize;
  paddingRatio?: number;
  offsetRatio?: [number, number];
  minPaddingPx?: number;
  maxPaddingRatio?: number;
  anchorHeightRatio?: number;
  pitchRelax?: PitchRelaxOptions;
}): VisualFitResult {
  const padding = getPaddingPx({
    viewportSize,
    paddingRatio,
    minPaddingPx,
    maxPaddingRatio,
    extraPaddingPx: target.visualFrame?.extraPaddingPx,
  });
  const { view, fitIterations } = runSafetyFitLoop({
    view: clampViewState(viewState),
    target,
    viewportSize,
    padding,
    offsetRatio,
    anchorHeightRatio,
    pitchRelax,
  });

  return {
    status: isVisualInsideSafetyWindow(view, target, viewportSize, padding, offsetRatio) ? 'fitted' : 'unresolved',
    reason: isVisualInsideSafetyWindow(view, target, viewportSize, padding, offsetRatio)
      ? undefined
      : 'The available zoom, angle, or checking budget could not produce complete framing.',
    view,
    metrics: getVisualFitMetrics(view, target, viewportSize, padding, offsetRatio, fitIterations, anchorHeightRatio),
  };
}

export function fitBboxToView({
  bbox,
  baseView,
  viewportSize = DEFAULT_VIEWPORT_SIZE,
  padding = 96,
  maxZoom,
  offset,
}: {
  bbox: BBox;
  baseView: CameraView;
  viewportSize?: ViewportSize;
  padding?: number;
  maxZoom?: number;
  offset?: number[];
}): CameraView {
  const normalizedBbox = normalizeBbox(bbox);
  const viewport = new WebMercatorViewport({
    width: viewportSize.width,
    height: viewportSize.height,
    longitude: baseView.longitude,
    latitude: baseView.latitude,
    zoom: baseView.zoom,
    pitch: baseView.pitch,
    bearing: baseView.bearing,
    altitude: baseView.altitude,
  });
  const fitted = viewport.fitBounds(
    [
      [normalizedBbox[0], normalizedBbox[1]],
      [normalizedBbox[2], normalizedBbox[3]],
    ],
    {
      padding,
      maxZoom,
      offset,
    },
  );

  return clampViewState({
    ...baseView,
    longitude: fitted.longitude,
    latitude: fitted.latitude,
    zoom: fitted.zoom,
  });
}

export function fitVisualTargetToView({
  target,
  baseView,
  viewportSize = DEFAULT_VIEWPORT_SIZE,
  paddingRatio = 0.12,
  zoomOffset = 0,
  maxZoom,
  pitch,
  bearing,
  offsetRatio,
  minPaddingPx,
  maxPaddingRatio,
  anchorHeightRatio,
  pitchRelax,
}: {
  target: CameraTarget;
  baseView: CameraView;
  viewportSize?: ViewportSize;
  paddingRatio?: number;
  zoomOffset?: number;
  maxZoom?: number;
  pitch?: number;
  bearing?: number;
  offsetRatio?: [number, number];
  minPaddingPx?: number;
  maxPaddingRatio?: number;
  anchorHeightRatio?: number;
  pitchRelax?: PitchRelaxOptions;
}): VisualFitResult {
  const targetPitch = pitch ?? baseView.pitch;
  const targetBearing = bearing ?? baseView.bearing;

  if (normalizeTargetType(target.type) === 'none') {
    const view = clampViewState({
      ...baseView,
      pitch: targetPitch,
      bearing: targetBearing,
    });
    return {
      status: isFiniteCameraView(view, viewportSize) ? 'fitted' : 'unresolved',
      view,
      metrics: getVisualFitMetrics(view, target, viewportSize, 0, offsetRatio, 0, anchorHeightRatio),
    };
  }

  const resolvedMaxZoom = maxZoom ?? getTargetMaxZoom(target, baseView);
  const padding = getPaddingPx({
    viewportSize,
    paddingRatio,
    minPaddingPx,
    maxPaddingRatio,
    extraPaddingPx: target.visualFrame?.extraPaddingPx,
  });
  const fitBaseView = {
    ...baseView,
    pitch: targetPitch,
    bearing: targetBearing,
  };
  const fittedView = fitBboxToView({
    bbox: getVisualFrameBbox(target),
    baseView: fitBaseView,
    viewportSize,
    padding,
    maxZoom: resolvedMaxZoom,
  });
  const { view, fitIterations } = runSafetyFitLoop({
    view: clampViewState({
      ...fittedView,
      zoom: clamp(fittedView.zoom + zoomOffset, fittedView.minZoom, resolvedMaxZoom),
      pitch: targetPitch,
      bearing: targetBearing,
    }),
    target,
    viewportSize,
    padding,
    offsetRatio,
    anchorHeightRatio,
    pitchRelax,
  });

  return {
    status: isVisualInsideSafetyWindow(view, target, viewportSize, padding, offsetRatio) ? 'fitted' : 'unresolved',
    reason: isVisualInsideSafetyWindow(view, target, viewportSize, padding, offsetRatio)
      ? undefined
      : 'The available zoom, angle, or checking budget could not produce complete framing.',
    view,
    metrics: getVisualFitMetrics(view, target, viewportSize, padding, offsetRatio, fitIterations, anchorHeightRatio),
  };
}
