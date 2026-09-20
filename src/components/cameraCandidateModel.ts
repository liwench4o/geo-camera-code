import _ from 'lodash';
import type { CameraMovement } from '../interfaces';
import { getCameraValidationMessages, preserveCameraMetadata } from '../camera/authoring';

/** Applying creates one immutable snapshot; retaining the previous list implements cancel/undo. */
export function applyCameraCandidate(
  cameras: CameraMovement[],
  candidate: CameraMovement,
  request: { action: 'add' | 'replace'; index?: number },
): { cameras: CameraMovement[]; index: number } {
  const errors = getCameraValidationMessages(candidate);
  if (errors.length) throw new Error(errors.join(' '));
  if (request.action === 'add') {
    return { cameras: [...cameras, _.cloneDeep(candidate)], index: cameras.length };
  }

  const index = request.index;
  if (index === undefined || !Number.isInteger(index) || index < 0 || index >= cameras.length) {
    throw new Error('The camera to replace is no longer available.');
  }
  const applied = preserveCameraMetadata(cameras[index], candidate);
  return { cameras: cameras.map((camera, i) => (i === index ? applied : camera)), index };
}
