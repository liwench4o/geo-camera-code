import type { CameraMovement, TargetCamera, TargetCameras, TimelineEdit } from '../interfaces';
import { getCameraEndMaxMs, getCameraStartMinMs } from './timeline-controls';
import { preserveAppliedPathAfterTimingEdit } from './retiming';

interface ApplyTimelineResizeEditInput {
  cameraList: CameraMovement[];
  timelineData: TargetCameras[];
  edit: Extract<TimelineEdit, { type: 'ripple-resize' }>;
  totalTimeLength: number;
}

interface ApplyTimelineResizeEditResult {
  cameraList: CameraMovement[];
  selectedSourceIndex: number;
}

function cloneCameraList(cameraList: CameraMovement[]) {
  return cameraList.map((camera) => ({ ...camera }));
}

function getTimelineCameraPosition(timelineData: TargetCameras[], targetCamera: TargetCamera) {
  if (targetCamera.sourceIndex === undefined) {
    return undefined;
  }

  for (let targetIndex = 0; targetIndex < timelineData.length; targetIndex++) {
    const target = timelineData[targetIndex];
    const cameraIndex = target.cameras.findIndex(
      (camera) => !camera.generated && camera.sourceIndex === targetCamera.sourceIndex,
    );

    if (cameraIndex >= 0) {
      return { targetIndex, cameraIndex };
    }
  }

  return undefined;
}

function getNextEditableTimelineCamera(
  timelineData: TargetCameras[],
  position: { targetIndex: number; cameraIndex: number } | undefined,
) {
  if (!position) {
    return undefined;
  }

  for (let targetIndex = position.targetIndex; targetIndex < timelineData.length; targetIndex++) {
    const target = timelineData[targetIndex];
    const firstCameraIndex = targetIndex === position.targetIndex ? position.cameraIndex + 1 : 0;

    for (let cameraIndex = firstCameraIndex; cameraIndex < target.cameras.length; cameraIndex++) {
      const camera = target.cameras[cameraIndex];
      if (camera.generated) {
        continue;
      }

      return camera;
    }
  }

  return undefined;
}

function setIncomingGap(camera: CameraMovement, delayMs: number) {
  camera.startDelay = Math.max(0, delayMs);
  // An edited interval has one timing source, including time imported from the
  // legacy interpolation field. Otherwise it would be added a second time.
  camera.interpolationDuration = 0;
}

export function applyTimelineResizeEdit(
  input: ApplyTimelineResizeEditInput,
): ApplyTimelineResizeEditResult | undefined {
  const sourceIndex = input.edit.camera.sourceIndex;
  if (sourceIndex === undefined || !input.cameraList[sourceIndex]) {
    return undefined;
  }

  const cameraList = cloneCameraList(input.cameraList);
  const result = () => ({
    cameraList: cameraList.map((camera, index) => preserveAppliedPathAfterTimingEdit(input.cameraList[index], camera)),
    selectedSourceIndex: sourceIndex,
  });

  if (input.edit.camera.generated) {
    return undefined;
  }

  const camera = cameraList[sourceIndex];
  const timelinePosition = getTimelineCameraPosition(input.timelineData, input.edit.camera);

  if (input.edit.edge === 'start') {
    if (!timelinePosition || sourceIndex === 0) {
      return undefined;
    }

    const minStartMs = getCameraStartMinMs(
      input.timelineData,
      timelinePosition.targetIndex,
      timelinePosition.cameraIndex,
    );
    const currentMotionEnd = input.edit.camera.start + input.edit.camera.duration;
    const currentStayEnd = currentMotionEnd + input.edit.camera.stay;
    const nextStart = Math.max(minStartMs, Math.min(input.edit.valueMs, currentStayEnd));
    const nextDuration = Math.max(0, currentMotionEnd - nextStart);
    const nextTotalDuration = Math.max(0, currentStayEnd - nextStart);

    setIncomingGap(camera, nextStart - minStartMs);
    camera.duration = nextDuration;
    camera.stay = Math.max(0, nextTotalDuration - nextDuration);

    return result();
  }

  const maxEndMs = timelinePosition
    ? getCameraEndMaxMs(
        input.timelineData,
        timelinePosition.targetIndex,
        timelinePosition.cameraIndex,
        input.totalTimeLength,
      )
    : input.totalTimeLength;

  if (input.edit.edge === 'motion-end') {
    const totalDuration = Math.max(0, Math.min(camera.duration + camera.stay, maxEndMs - input.edit.camera.start));
    const nextDuration = Math.min(totalDuration, Math.max(0, input.edit.valueMs - input.edit.camera.start));
    camera.duration = nextDuration;
    camera.stay = totalDuration - nextDuration;

    return result();
  }

  const nextTotalDuration = Math.max(0, Math.min(input.edit.valueMs, maxEndMs) - input.edit.camera.start);
  camera.duration = Math.min(camera.duration, nextTotalDuration);
  camera.stay = Math.max(0, nextTotalDuration - camera.duration);

  const editedEndMs = input.edit.camera.start + camera.duration + camera.stay;
  const nextTimelineCamera = getNextEditableTimelineCamera(input.timelineData, timelinePosition);
  const nextSourceIndex = nextTimelineCamera?.sourceIndex;
  const nextCamera = nextSourceIndex !== undefined ? cameraList[nextSourceIndex] : undefined;
  if (nextTimelineCamera && nextCamera) {
    const nextCameraStart = Math.max(0, nextTimelineCamera.start);
    const nextCameraGap = nextCameraStart - editedEndMs;
    setIncomingGap(nextCamera, nextCameraGap);
  }

  return result();
}
