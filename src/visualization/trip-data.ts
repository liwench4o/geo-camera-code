import type { CustomObject } from '../interfaces';
import { normalizeTimedPath, type TimedPathSnapshot } from '../camera/timed-path';

const snapshots = new WeakMap<CustomObject, TimedPathSnapshot | undefined>();

/** Loaded rows are immutable; share one normalization between picking and rendering. */
export function getTripTimedPath(row: CustomObject): TimedPathSnapshot | undefined {
  if (!snapshots.has(row)) snapshots.set(row, normalizeTimedPath(row.path, row.timestamps));
  return snapshots.get(row);
}
