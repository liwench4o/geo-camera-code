import type { CameraMovement, TargetCameras } from './interfaces';
import { getCameraById, getCameraCategory as getCatalogCameraCategory } from './camera/catalog';
import { getNarrativeProgressColor } from './theme/narrativeColors';

const TIMELINE_GAP_PROGRESS_COLOR = '#f0f0f0';

export function removeElement(elementId: string) {
  const node = document.getElementById(elementId);
  if (node) {
    const parent = node.parentNode;
    if (parent) {
      parent.removeChild(node);
    }
  }
}

export function removeChildren(elementId: string) {
  const node = document.getElementById(elementId);
  if (node) {
    while (node.lastChild) {
      node.removeChild(node.lastChild);
    }
  }
}

export function getUploadResult(json: Blob, callback: (result: string) => void) {
  const reader = new FileReader();
  reader.addEventListener('load', () => callback(reader.result as string));
  reader.readAsText(json);
}

export function getCameraListTotalTimeLength(cameraMovementList: CameraMovement[]) {
  let time = 0;
  for (const camera of cameraMovementList) {
    time += camera['duration'];
    time += camera['stay'];
  }
  return time;
}

export function getCameraTitle(name: string) {
  return getCameraById(name)?.title ?? 'undefined';
}

export function getCameraCategory(name: string) {
  return getCatalogCameraCategory(name);
}

export function refineTimelineTiming(targetCameraData: TargetCameras[]) {
  // Update timing
  for (let i = 0; i < targetCameraData.length; ++i) {
    // Adjust targets
    if (i === 0) {
      targetCameraData[i]['targetStart'] = 0;
      let cameraTime = 0;
      for (const camera of targetCameraData[i]['cameras']) {
        cameraTime += camera['duration'];
        cameraTime += camera['stay'];
      }
      targetCameraData[i]['targetEnd'] = cameraTime;
    } else {
      targetCameraData[i]['targetStart'] = targetCameraData[i - 1]['targetEnd'];
      let cameraTime = 0;
      for (const camera of targetCameraData[i]['cameras']) {
        cameraTime += camera['duration'];
        cameraTime += camera['stay'];
      }
      targetCameraData[i]['targetEnd'] = targetCameraData[i]['targetStart'] + cameraTime;
    }

    // Adjust cameras
    for (let j = 0; j < targetCameraData[i]['cameras'].length; ++j) {
      if (j === 0) {
        targetCameraData[i]['cameras'][j]['start'] = targetCameraData[i]['targetStart'];
      } else {
        const lastStart = targetCameraData[i]['cameras'][j - 1]['start'];
        const lastDuration = targetCameraData[i]['cameras'][j - 1]['duration'];
        const lastStay = targetCameraData[i]['cameras'][j - 1]['stay'];
        targetCameraData[i]['cameras'][j]['start'] = lastStart + lastDuration + lastStay;
      }
    }

    // Remove empty target
    targetCameraData = targetCameraData.filter((target) => target['cameras'].length > 0);
  }
  return targetCameraData;
}

export function getProgressElements(timeLength: number, targets: TargetCameras[]) {
  const elements = [];
  if (timeLength > 0) {
    let cursor = 0;
    for (const target of targets) {
      for (const camera of target['cameras']) {
        const cameraStart = Math.max(0, camera['start']);
        const cameraEnd = Math.max(cameraStart, cameraStart + camera['duration'] + camera['stay']);
        const gapDuration = Math.max(0, cameraStart - cursor);
        if (gapDuration > 0) {
          elements.push({
            value: (gapDuration / timeLength) * 100,
            color: TIMELINE_GAP_PROGRESS_COLOR,
          });
        }

        const elementColor = getNarrativeProgressColor(camera['category']);
        const percentValue = ((cameraEnd - cameraStart) / timeLength) * 100;
        const elementObject = {
          value: percentValue,
          color: elementColor,
        };
        elements.push(elementObject);
        cursor = Math.max(cursor, cameraEnd);
      }
    }

    const trailingGapDuration = Math.max(0, timeLength - cursor);
    if (trailingGapDuration > 0) {
      elements.push({
        value: (trailingGapDuration / timeLength) * 100,
        color: TIMELINE_GAP_PROGRESS_COLOR,
      });
    }
  }

  return elements;
}
