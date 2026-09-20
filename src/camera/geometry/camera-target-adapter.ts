import type { CameraTarget } from '../types';
import { validateSnapshotEnvelope } from './envelope';
import type { SnapshotEnvelope } from './types';

export function attachSnapshotEnvelope(target: CameraTarget, envelope: SnapshotEnvelope): CameraTarget {
  const validation = validateSnapshotEnvelope(envelope);
  if (validation.status !== 'ok') {
    throw new TypeError(`cannot attach invalid snapshot envelope: ${validation.reason}`);
  }
  return { ...target, snapshotEnvelope: envelope };
}
