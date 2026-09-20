import { digestCanonical } from './geometry/canonical-digest';
import { MERCATOR_LATITUDE_LIMIT, unwrapLongitude, unwrapPath } from './geometry/geo-wrap';
import type { LngLat } from './types';

export interface TimedPathSnapshot {
  version: 1;
  coordinates: LngLat[];
  timestamps: number[];
  digest: string;
}

/** Capture the time/position pairs that the rendered trip uses, retaining real stops. */
export function normalizeTimedPath(coordinates: unknown, timestamps: unknown): TimedPathSnapshot | undefined {
  if (!Array.isArray(coordinates) || !Array.isArray(timestamps) || coordinates.length !== timestamps.length)
    return undefined;
  const points: LngLat[] = [];
  const times: number[] = [];
  for (let index = 0; index < coordinates.length; index++) {
    const point = coordinates[index];
    const time = timestamps[index];
    if (
      !Array.isArray(point) ||
      point.length < 2 ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1]) ||
      Math.abs(point[1]) > MERCATOR_LATITUDE_LIMIT ||
      !Number.isFinite(time) ||
      (index > 0 && time < timestamps[index - 1])
    )
      return undefined;
    if (times.length && time === times[times.length - 1]) points[points.length - 1] = [point[0], point[1]];
    else {
      points.push([point[0], point[1]]);
      times.push(time);
    }
  }
  if (times.length < 2 || !(times[times.length - 1] > times[0])) return undefined;
  const path = unwrapPath(points);
  return {
    version: 1,
    coordinates: path,
    timestamps: times,
    digest: digestCanonical({ version: 1, coordinates: path, timestamps: times }),
  };
}

/** TripsLayer interpolates the projected path segment, not geographic latitude. */
export function interpolateProjectedPath(first: LngLat, last: LngLat, fraction: number): LngLat {
  if (fraction <= 0) return [...first];
  if (fraction >= 1) return [...last];
  const mercatorY = (latitude: number) => Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360));
  const y = mercatorY(first[1]) + (mercatorY(last[1]) - mercatorY(first[1])) * fraction;
  return [
    first[0] + (unwrapLongitude(last[0], first[0]) - first[0]) * fraction,
    ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI,
  ];
}

export function sampleTimedPath(snapshot: TimedPathSnapshot, time: number): LngLat {
  if (!Number.isFinite(time)) throw new Error('The trip time must be finite.');
  const { coordinates, timestamps } = snapshot;
  if (time <= timestamps[0]) return [...coordinates[0]];
  const last = timestamps.length - 1;
  if (time >= timestamps[last]) return [...coordinates[last]];
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (timestamps[middle] <= time) low = middle;
    else high = middle;
  }
  return interpolateProjectedPath(
    coordinates[low],
    coordinates[high],
    (time - timestamps[low]) / (timestamps[high] - timestamps[low]),
  );
}
