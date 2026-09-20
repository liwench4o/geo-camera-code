import type { CameraMovement, CameraView } from '../interfaces';
import { shortestAngle, unwrapLongitude, unwrapPath } from './geometry/geo-wrap';
import type { CameraRecipe, CameraTarget, LngLat } from './types';
import type { CameraTrajectoryKeyframe, SerializedCameraTrajectory, SerializedCameraView } from './trajectory/types';
import { interpolateProjectedPath, sampleTimedPath } from './timed-path';
import { alignVisualAnchor, getDefaultViewportSize } from './viewport';

export function semanticView(view: CameraView): SerializedCameraView {
  return {
    longitude: view.longitude,
    latitude: view.latitude,
    zoom: view.zoom,
    pitch: view.pitch,
    bearing: view.bearing,
  };
}

function distance(first: LngLat, second: LngLat) {
  const radians = Math.PI / 180;
  const a =
    Math.sin(((second[1] - first[1]) * radians) / 2) ** 2 +
    Math.cos(first[1] * radians) *
      Math.cos(second[1] * radians) *
      Math.sin(((second[0] - first[0]) * radians) / 2) ** 2;
  return 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
}

export function routeGeometry(target: CameraTarget) {
  if (target.timedPath) {
    const timed = target.timedPath;
    const start = timed.timestamps[0];
    const span = timed.timestamps[timed.timestamps.length - 1] - start;
    return {
      path: timed.coordinates,
      progress: timed.timestamps.map((time) => (time - start) / span),
      pointAt: (progress: number): LngLat => sampleTimedPath(timed, start + Math.min(1, Math.max(0, progress)) * span),
    };
  }
  const source = target.coordinates ?? (target.start && target.end ? [target.start, target.end] : []);
  const coordinates: LngLat[] = [];
  for (const coordinate of source) {
    if (typeof coordinate[0] === 'number' && typeof coordinate[1] === 'number') coordinates.push(coordinate as LngLat);
    else for (const point of coordinate as LngLat[]) coordinates.push(point);
  }
  const path = unwrapPath(coordinates).filter(
    (point, index, list) => index === 0 || distance(list[index - 1], point) > 1e-10,
  );
  const cumulative = [0];
  for (let index = 1; index < path.length; index++)
    cumulative.push(cumulative[index - 1] + distance(path[index - 1], path[index]));
  const total = cumulative[cumulative.length - 1] ?? 0;
  const pointAt = (progress: number): LngLat => {
    const arc = Math.min(1, Math.max(0, progress)) * total;
    let index = 0;
    while (index + 1 < cumulative.length - 1 && arc > cumulative[index + 1]) index++;
    if (path.length < 2 || total === 0) return path[0] ?? target.center;
    const ratio = (arc - cumulative[index]) / (cumulative[index + 1] - cumulative[index]);
    return interpolateProjectedPath(path[index], path[index + 1], ratio);
  };
  const progress = total > 0 ? cumulative.map((arc) => arc / total) : [0, 1];
  return { path, progress, pointAt };
}

function interpolate(
  first: CameraView,
  last: CameraView,
  progress: number,
  directedBearing = false,
): SerializedCameraView {
  return {
    longitude: first.longitude + (unwrapLongitude(last.longitude, first.longitude) - first.longitude) * progress,
    latitude: first.latitude + (last.latitude - first.latitude) * progress,
    zoom: first.zoom + (last.zoom - first.zoom) * progress,
    pitch: first.pitch + (last.pitch - first.pitch) * progress,
    bearing:
      first.bearing +
      (directedBearing ? last.bearing - first.bearing : shortestAngle(first.bearing, last.bearing)) * progress,
  };
}

export function isRouteFollowing(recipe: CameraRecipe, target: CameraTarget) {
  return recipe.shots.includes('tracking') && target.type === 'path';
}

function projectedVector(first: LngLat, last: LngLat): [number, number] {
  const y = (latitude: number) => (Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360)) * 180) / Math.PI;
  return [unwrapLongitude(last[0], first[0]) - first[0], y(last[1]) - y(first[1])];
}

/** The heading is compiled once on a deterministic clock, never integrated during playback. */
function routeHeading(
  route: ReturnType<typeof routeGeometry>,
  progress: number,
  durationMs: number,
  viewportWidth: number,
  zoom: number,
  previous?: number,
) {
  let index = 0;
  while (index < route.path.length - 2 && route.progress[index + 1] <= progress) index++;
  const tangent = projectedVector(route.path[index], route.path[index + 1]);
  // A stationary interval freezes its incoming direction, including a stop at the route end.
  if (Math.hypot(...tangent) < 1e-12 || progress === 1) {
    if (previous !== undefined) return previous;
    const next = route.path.findIndex(
      (point, pointIndex) => pointIndex > index && distance(route.path[index], point) > 1e-10,
    );
    if (next < 0) return 0;
    const outgoing = projectedVector(route.path[index], route.path[next]);
    return (Math.atan2(outgoing[0], outgoing[1]) * 180) / Math.PI;
  }
  const head = route.pointAt(progress);
  const endProgress = Math.min(1, progress + 350 / Math.max(1, durationMs));
  // A Mercator pixel corresponds to a fixed projected ground distance at this zoom.
  const cap = (0.15 * viewportWidth * 360) / (512 * 2 ** zoom);
  let previousPoint = head;
  let remaining = cap;
  let ahead = head;
  const samples = [...route.progress.filter((value) => value > progress && value < endProgress), endProgress];
  for (const value of samples) {
    const point = route.pointAt(value);
    const length = Math.hypot(...projectedVector(previousPoint, point));
    if (length > remaining) {
      ahead = interpolateProjectedPath(previousPoint, point, remaining / length);
      break;
    }
    ahead = point;
    previousPoint = point;
    remaining -= length;
  }
  const direction = projectedVector(head, ahead);
  return (Math.atan2(...(Math.hypot(...direction) > 1e-12 ? direction : tangent)) * 180) / Math.PI;
}

/** Auxiliary keys preserve route turns and signed rotations in the shared shortest-angle sampler. */
export function buildShotTrajectory(
  camera: CameraMovement,
  recipe: CameraRecipe,
  target: CameraTarget,
): SerializedCameraTrajectory {
  const durationMs = camera.duration;
  const first = camera.initViewState;
  const last = camera.finalViewState;
  const manual = camera.authoring?.manualViews;
  let keyframes: CameraTrajectoryKeyframe[];
  let sampler: 'linear-v1' | 'minimum-jerk-v1' = 'minimum-jerk-v1';
  if (isRouteFollowing(recipe, target)) {
    const route = routeGeometry(target);
    if (route.path.length < 2)
      throw new Error('Route following requires at least two distinct finite route coordinates.');
    if (route.path.length > 2048)
      throw new Error('This route exceeds the planning budget; simplify it to at most 2,048 points.');
    const segments = Math.min(768, Math.max(32, Math.ceil(durationMs / 50)));
    const progresses = Array.from(
      new Set([...route.progress, ...Array.from({ length: segments + 1 }, (_, index) => index / segments)]),
    ).sort((a, b) => a - b);
    const viewport = camera.authoring?.planningViewport ?? getDefaultViewportSize();
    const offsetRatio: [number, number] = camera.authoring?.composition?.offsetRatio ?? [0, 0.1];
    let heading: number | undefined;
    keyframes = progresses.map((progress, index) => {
      const point = route.pointAt(progress);
      const explicitBearing =
        camera.authoring?.motion?.startBearing !== undefined || camera.authoring?.motion?.bearingSweep !== undefined;
      const interpolated = interpolate(first, last, progress, explicitBearing);
      const desired = routeHeading(route, progress, durationMs, viewport.width, interpolated.zoom, heading);
      const smoothing = index === 0 ? 1 : 1 - Math.exp((-(progress - progresses[index - 1]) * durationMs) / 400);
      heading = heading === undefined ? desired : heading + shortestAngle(heading, desired) * smoothing;
      const centered = {
        ...interpolated,
        longitude: point[0],
        latitude: point[1],
        bearing: explicitBearing ? interpolated.bearing : heading,
      };
      const view = semanticView(
        alignVisualAnchor({
          viewState: centered,
          target: { ...target, center: point, snapshotEnvelope: undefined, visualFrame: undefined },
          viewportSize: viewport,
          offsetRatio,
          maxIterations: 8,
        }),
      );
      view.longitude = unwrapLongitude(view.longitude, point[0]);
      if (manual?.initial && progress === 0) Object.assign(view, semanticView(manual.initial));
      if (manual?.final && progress === 1) Object.assign(view, semanticView(manual.final));
      return { timeMs: progress * durationMs, view };
    });
    sampler = 'linear-v1';
  } else {
    const directed =
      camera.authoring?.motion?.bearingSweep !== undefined ||
      recipe.shots.some((shot) => shot === 'arc' || shot === 'camera-roll');
    let finalView = last;
    const recipeSweep = recipe.framing.bearingDelta * (recipe.shots.includes('arc') ? 2 : 1);
    // Map interaction commonly normalizes 360° back to 0°. Keep a requested full turn when the
    // author changes distance/pitch at that endpoint; the endpoint orientation is still identical.
    if (
      camera.authoring?.motion?.bearingSweep === undefined &&
      directed &&
      Math.abs(recipeSweep) >= 360 &&
      Math.abs(last.bearing - first.bearing) < 1e-9
    ) {
      finalView = { ...last, bearing: first.bearing + recipeSweep };
    }
    const segments = directed ? Math.max(1, Math.ceil(Math.abs(finalView.bearing - first.bearing) / 90)) : 1;
    keyframes = Array.from({ length: segments + 1 }, (_, index) => ({
      timeMs: (durationMs * index) / segments,
      view: interpolate(first, finalView, index / segments, directed),
    }));
    if (segments > 1) sampler = 'linear-v1';
  }
  const same = keyframes.every((frame) =>
    (['longitude', 'latitude', 'zoom', 'pitch', 'bearing'] as const).every(
      (key) => frame.view[key] === keyframes[0].view[key],
    ),
  );
  if (same)
    return {
      kind: 'hold',
      sampler: 'hold-v1',
      samplerVersion: '1',
      durationMs,
      keyframes: [keyframes[0], { timeMs: durationMs, view: { ...keyframes[0].view } }],
    };
  if (durationMs <= 0) throw new Error('A moving camera needs a duration greater than zero.');
  return { kind: 'keyframed', sampler, samplerVersion: '1', durationMs, keyframes };
}
