import { WebMercatorViewport } from '@deck.gl/core';
import type { CameraMovement, CameraView } from '../interfaces';
import type { CameraCompositionIntent, CameraMotionIntent } from './authoring-types';
import { createSnapshotEnvelope } from './geometry/envelope';
import { MERCATOR_LATITUDE_LIMIT, unwrapLongitude } from './geometry/geo-wrap';
import { computeViewDisplacement, resolveAdaptiveDuration } from './timing';
import type { BBox, CameraRecipe, CameraTarget, ViewportSize } from './types';
import { alignVisualAnchor, fitVisualTargetToView, getVisualFrameBbox, isFiniteCameraView } from './viewport';

/** Measured from the committed endpoints, including signed turns rather than normalized headings. */
export function resolvedMotion(camera: CameraMovement): CameraMotionIntent {
  const first = camera.initViewState;
  const last = camera.finalViewState;
  return {
    zoomDelta: last.zoom - first.zoom,
    startPitch: first.pitch,
    endPitch: last.pitch,
    startBearing: first.bearing,
    bearingSweep: last.bearing - first.bearing,
  };
}

function contextBounds(context: NonNullable<CameraCompositionIntent['context']>): BBox {
  if (context.kind === 'bounds') {
    const [west, south, east, north] = context.bounds;
    return [west, south, east < west ? east + 360 : east, north];
  }
  if (!isFiniteCameraView(context.view, context.viewport)) throw new Error('The captured context view is invalid.');
  const projection = new WebMercatorViewport({ ...context.view, ...context.viewport });
  const corners = [
    [0, 0],
    [context.viewport.width, 0],
    [context.viewport.width, context.viewport.height],
    [0, context.viewport.height],
  ].map((point) => projection.unproject(point));
  if (
    corners.some((point) => !point.slice(0, 2).every(Number.isFinite) || Math.abs(point[1]) > MERCATOR_LATITUDE_LIMIT)
  )
    throw new Error('The captured context extends beyond the map projection; capture a less tilted view.');
  return [
    Math.min(...corners.map((point) => point[0])),
    Math.min(...corners.map((point) => point[1])),
    Math.max(...corners.map((point) => point[0])),
    Math.max(...corners.map((point) => point[1])),
  ];
}

/** Supplement the complete rendered target with geographic context without changing its snapshot. */
export function compositionTarget(target: CameraTarget, composition?: CameraCompositionIntent): CameraTarget {
  if (!composition?.context) return target;
  const bounds = contextBounds(composition.context);
  if (
    !bounds.every(Number.isFinite) ||
    bounds[3] <= bounds[1] ||
    bounds[2] <= bounds[0] ||
    bounds[2] - bounds[0] > 360 ||
    Math.abs(bounds[1]) > MERCATOR_LATITUDE_LIMIT ||
    Math.abs(bounds[3]) > MERCATOR_LATITUDE_LIMIT
  )
    throw new Error('Context bounds must contain a finite geographic area.');
  const originalBounds = getVisualFrameBbox(target);
  const centerLng = (bounds[0] + bounds[2]) / 2;
  const shift = unwrapLongitude(centerLng, target.center[0]) - centerLng;
  bounds[0] += shift;
  bounds[2] += shift;
  const anchor = target.snapshotEnvelope?.frame.anchor ?? [...(target.visualFrame?.anchor ?? target.center), 0];
  // Split broad regions so ring unwrapping cannot replace a >180° area with its short complement.
  const width = bounds[2] - bounds[0];
  const segments = width >= 180 && width < 360 ? 3 : 1;
  const contexts: CameraTarget[] = Array.from({ length: segments }, (_, index) => {
    const part: BBox = [
      bounds[0] + (width * index) / segments,
      bounds[1],
      bounds[0] + (width * (index + 1)) / segments,
      bounds[3],
    ];
    const ring: [number, number][] = [
      [part[0], part[1]],
      [part[2], part[1]],
      [part[2], part[3]],
      [part[0], part[3]],
    ];
    const envelope = createSnapshotEnvelope({
      id: 'authored-context',
      supportGuarantee: 'conservative',
      provenance: {
        datasetId: 'authoring',
        visualizationId: 'context',
        layerId: 'context',
        dataRevision: '1',
        visualizationRevision: '1',
        producerId: 'camera-composition',
        producerVersion: 1,
        sceneRevision: '1',
        resolvedLayerDigest: 'context',
      },
      primitives: [{ kind: 'polygon', rings: [ring] }],
      anchor: [(part[0] + part[2]) / 2, (part[1] + part[3]) / 2, 0],
      metrics: {
        elevation: 0,
        density: 0,
        coverage: 0,
        dispersion: 0,
        elongation: 0,
        curvature: 0,
        calibrationVersion: 1,
        fallbackReasons: [],
      },
      wrap: {
        wrapReference: (part[0] + part[2]) / 2,
        worldOffset: 0,
        wrapMode: width === 360 ? 'full-world' : 'minimum-arc',
      },
    });
    if (envelope.status !== 'ok') throw new Error(envelope.reason);
    return {
      id: 'authored-context',
      type: 'region',
      source: 'drawn-region',
      bbox: part,
      center: [(part[0] + part[2]) / 2, (part[1] + part[3]) / 2],
      snapshotEnvelope: envelope.value,
    };
  });
  const bbox: BBox = [
    Math.min(originalBounds[0], bounds[0]),
    Math.min(originalBounds[1], bounds[1]),
    Math.max(originalBounds[2], bounds[2]),
    Math.max(originalBounds[3], bounds[3]),
  ];
  return {
    ...target,
    snapshotEnvelope: undefined,
    bbox,
    children: [target, ...contexts],
    visualFrame: {
      ...target.visualFrame,
      bbox,
      anchor: [anchor[0], anchor[1]],
      heightMeters: target.snapshotEnvelope ? (anchor[2] ?? 0) * 2 : target.visualFrame?.heightMeters,
    },
  };
}

function endpointTarget(camera: CameraMovement, recipe: CameraRecipe, target: CameraTarget, initial: boolean) {
  const comparison = camera.comparisonTargetSnapshots as CameraTarget[] | undefined;
  if (
    recipe.purpose === 'comparison' &&
    comparison?.length &&
    (recipe.strategy.includes('pan') || recipe.strategy === 'pull-out')
  )
    return initial ? comparison[0] : recipe.strategy === 'pull-out' ? target : comparison[comparison.length - 1];
  return target;
}

function shouldAnchor(camera: CameraMovement, recipe: CameraRecipe, target: CameraTarget, initial: boolean) {
  if (target.type === 'none' || recipe.purpose === 'dynamic' || (recipe.purpose === 'basic' && !recipe.requiresTarget))
    return false;
  if (recipe.strategy.includes('tracking') || recipe.strategy === 'trucking') return false;
  if (initial && recipe.strategy.includes('pan') && recipe.purpose !== 'comparison') return false;
  return !(initial ? camera.authoring?.manualViews?.initial : camera.authoring?.manualViews?.final);
}

/** Re-align after a shared zoom or angle correction, without changing either zoom independently. */
export function alignMotionComposition(
  camera: CameraMovement,
  recipe: CameraRecipe,
  target: CameraTarget,
  viewport: ViewportSize,
) {
  if (!camera.authoring?.motion && !camera.authoring?.composition) return;
  for (const initial of [true, false]) {
    if (!shouldAnchor(camera, recipe, target, initial)) continue;
    const key = initial ? 'initViewState' : 'finalViewState';
    camera[key] = alignVisualAnchor({
      viewState: camera[key],
      target: endpointTarget(camera, recipe, target, initial),
      viewportSize: viewport,
      offsetRatio:
        camera.authoring.composition?.offsetRatio ??
        camera.authoring.adjustments.offsetRatio ??
        recipe.framing.offsetRatio,
      anchorHeightRatio:
        camera.authoring.composition?.anchor === 'ground' ? 0 : (camera.authoring.adjustments.anchorHeightRatio ?? 0.5),
      maxIterations: 8,
    });
  }
}

/** Apply independent requests after template generation, then fit their common zoom level. */
export function applyMotionIntent(
  camera: CameraMovement,
  recipe: CameraRecipe,
  target: CameraTarget,
  viewport: ViewportSize,
) {
  const spec = camera.authoring;
  if (!spec) return;
  if (spec.version !== 1 && spec.version !== 2) throw new Error('The camera authoring version is unsupported.');
  if (spec.source && !['current-view', 'previous-camera', 'reference-view'].includes(spec.source.kind))
    throw new Error('The camera source kind is unsupported.');
  if (spec.transition !== undefined && spec.transition !== 'auto' && spec.transition !== 'cut')
    throw new Error('The camera transition kind is unsupported.');
  if (spec.composition?.anchor !== undefined && !['ground', 'visual'].includes(spec.composition.anchor))
    throw new Error('The target anchor must be ground or visual.');
  if (spec.composition?.context && !['bounds', 'view'].includes(spec.composition.context.kind))
    throw new Error('The context kind must be bounds or view.');
  if (
    spec.composition?.context?.kind === 'bounds' &&
    (!Array.isArray(spec.composition.context.bounds) || spec.composition.context.bounds.length !== 4)
  )
    throw new Error('Context bounds must have west, south, east, and north coordinates.');
  const motion = spec.motion ?? {};
  const ranges: Record<keyof CameraMotionIntent, [number, number]> = {
    zoomDelta: [-8, 8],
    startPitch: [0, 75],
    endPitch: [0, 75],
    startBearing: [-360, 360],
    bearingSweep: [-720, 720],
  };
  for (const key of Object.keys(ranges) as (keyof CameraMotionIntent)[]) {
    const value = motion[key];
    if (value !== undefined && (!Number.isFinite(value) || value < ranges[key][0] || value > ranges[key][1]))
      throw new Error(`The requested ${key} must be between ${ranges[key][0]} and ${ranges[key][1]}.`);
  }
  if (
    spec.composition?.offsetRatio !== undefined &&
    (!Array.isArray(spec.composition.offsetRatio) ||
      spec.composition.offsetRatio.length !== 2 ||
      spec.composition.offsetRatio.some((value) => !Number.isFinite(value) || Math.abs(value) > 0.45))
  )
    throw new Error('The target screen offset must be between -0.45 and 0.45.');
  if (spec.composition?.context) compositionTarget(target, spec.composition);
  if (!spec.motion && !spec.composition) return;
  if (spec.manualViews?.initial && spec.manualViews.final) return;
  const first = { ...camera.initViewState };
  const last = { ...camera.finalViewState };
  const defaultSweep = last.bearing - first.bearing;
  const delta = motion.zoomDelta ?? last.zoom - first.zoom;
  first.pitch = motion.startPitch ?? first.pitch;
  last.pitch = motion.endPitch ?? last.pitch;
  first.bearing = motion.startBearing ?? first.bearing;
  last.bearing = first.bearing + (motion.bearingSweep ?? defaultSweep);
  const fit = (candidate: CameraView, initial: boolean) => {
    if (!shouldAnchor(camera, recipe, target, initial)) return candidate;
    return fitVisualTargetToView({
      target: compositionTarget(endpointTarget(camera, recipe, target, initial), spec.composition),
      baseView: candidate,
      viewportSize: viewport,
      pitch: candidate.pitch,
      bearing: candidate.bearing,
      paddingRatio: camera.debugInfo?.resolvedParameters?.paddingRatio ?? recipe.framing.paddingRatio,
      zoomOffset: camera.debugInfo?.resolvedParameters?.zoomBias ?? recipe.framing.zoomBias,
      offsetRatio: spec.composition?.offsetRatio ?? spec.adjustments.offsetRatio ?? recipe.framing.offsetRatio,
      anchorHeightRatio: spec.composition?.anchor === 'ground' ? 0 : (spec.adjustments.anchorHeightRatio ?? 0.5),
      minPaddingPx: recipe.framing.minPaddingPx,
      maxPaddingRatio: recipe.framing.maxPaddingRatio,
    }).view;
  };
  const firstFit = fit(first, true);
  const lastFit = fit(last, false);
  const anchoredFirst = shouldAnchor(camera, recipe, target, true);
  const anchoredLast = shouldAnchor(camera, recipe, target, false);
  const panWithoutDelta = recipe.strategy.includes('pan') && motion.zoomDelta === undefined;
  let initialZoom: number;
  let finalZoom: number;
  if (panWithoutDelta) {
    initialZoom = firstFit.zoom;
    finalZoom = lastFit.zoom;
    if (recipe.purpose === 'comparison' && recipe.strategy === 'pan')
      initialZoom = finalZoom = Math.min(initialZoom, finalZoom);
  } else if (
    recipe.strategy.includes('pan') &&
    recipe.purpose !== 'comparison' &&
    anchoredLast &&
    motion.zoomDelta !== undefined
  ) {
    // A pan begins at the saved source scale. The target fit is a safety ceiling,
    // not a request to zoom closer before the movement starts.
    initialZoom = first.zoom;
    finalZoom = initialZoom + delta;
    const widen = Math.max(0, finalZoom - lastFit.zoom);
    initialZoom -= widen;
    finalZoom -= widen;
  } else if (!anchoredFirst && !anchoredLast) {
    initialZoom = first.zoom;
    finalZoom = initialZoom + delta;
  } else {
    const endAnchored = delta >= 0 || !anchoredFirst;
    initialZoom = endAnchored ? lastFit.zoom - delta : firstFit.zoom;
    finalZoom = initialZoom + delta;
    const widen = Math.max(
      0,
      anchoredFirst ? initialZoom - firstFit.zoom : 0,
      anchoredLast ? finalZoom - lastFit.zoom : 0,
    );
    initialZoom -= widen;
    finalZoom -= widen;
  }
  const lower = Math.max((first.minZoom ?? -2) - initialZoom, (last.minZoom ?? -2) - finalZoom);
  const upper = Math.min((first.maxZoom ?? 24) - initialZoom, (last.maxZoom ?? 24) - finalZoom);
  if (lower > upper) throw new Error('The requested zoom change exceeds the available camera zoom range.');
  const shift = Math.max(lower, Math.min(upper, 0));
  camera.initViewState = { ...firstFit, pitch: first.pitch, bearing: first.bearing, zoom: initialZoom + shift };
  camera.finalViewState = { ...lastFit, pitch: last.pitch, bearing: last.bearing, zoom: finalZoom + shift };
  alignMotionComposition(camera, recipe, target, viewport);
}

/** Automatic timing is based on the final resolved movement, after all geometric corrections. */
export function updateMotionDuration(
  camera: CameraMovement,
  recipe: CameraRecipe,
  target: CameraTarget,
  viewport: ViewportSize,
) {
  const displacement = computeViewDisplacement(camera.initViewState, camera.finalViewState, viewport);
  // Explicit angular requests no longer have the fixed profile span assumed by legacy rotation timing.
  const variableMotion = Object.values(camera.authoring?.motion ?? {}).some((value) => value !== undefined);
  const duration = resolveAdaptiveDuration({
    recipe: variableMotion && !recipe.strategy.includes('tracking') ? { ...recipe, strategy: 'pan' } : recipe,
    displacement,
    pathLengthKm: target.stats?.pathLengthKm,
    speedScale: camera.authoring?.adjustments.speedScale,
  });
  camera.duration = camera.authoring?.timing?.duration ?? duration.durationMs;
  if (camera.debugInfo?.resolvedParameters) {
    camera.debugInfo.resolvedParameters.durationMs = camera.duration;
    camera.debugInfo.resolvedParameters.displacement = Number(displacement.toFixed(3));
  }
}
