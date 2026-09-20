import type { CSSProperties } from 'react';
import type { TargetCamera, TargetCameras, TimelineEdit } from '../interfaces';

const MIN_SLIDER_MAX_MS = 100;

export interface CameraTimingMark {
  style: CSSProperties;
  label: string;
}

export interface CameraTimingSliderConfig {
  values: number[];
  max: number;
  marks: Record<number, CameraTimingMark>;
}

export interface CameraTimingSliderOptions {
  timelineEndMs?: number;
  minStartMs?: number;
  defaultEndMs?: number;
  maxEndMs?: number;
  startLocked?: boolean;
}

type CameraTimingSliderOptionsInput = number | CameraTimingSliderOptions;
type ResolvedCameraTimingSliderOptions = {
  timelineEndMs: number;
  minStartMs: number;
  defaultEndMs?: number;
  maxEndMs?: number;
  startLocked: boolean;
};

function resolveCameraTimingSliderOptions(
  options: CameraTimingSliderOptionsInput = {},
): ResolvedCameraTimingSliderOptions {
  if (typeof options === 'number') {
    return {
      timelineEndMs: options,
      minStartMs: 0,
      defaultEndMs: undefined,
      maxEndMs: undefined,
      startLocked: false,
    };
  }

  return {
    timelineEndMs: options.timelineEndMs ?? 0,
    minStartMs: options.minStartMs ?? 0,
    defaultEndMs: options.defaultEndMs,
    maxEndMs: options.maxEndMs,
    startLocked: options.startLocked ?? false,
  };
}

function getCameraDuration(camera: TargetCamera) {
  return Math.max(0, camera.duration);
}

function getCameraStart(camera: TargetCamera) {
  return Math.max(0, camera.start);
}

function getCameraMotionEnd(camera: TargetCamera) {
  return getCameraStart(camera) + getCameraDuration(camera);
}

function getCameraEnd(camera: TargetCamera) {
  return getCameraMotionEnd(camera) + Math.max(0, camera.stay);
}

function getDefaultCameraTimingValues(camera: TargetCamera) {
  const start = getCameraStart(camera);
  const motionEnd = getCameraMotionEnd(camera);

  return [start, motionEnd, getCameraEnd(camera)];
}

function normalizeCameraTimingValues(
  camera: TargetCamera,
  values: number[] | undefined,
  options: ResolvedCameraTimingSliderOptions,
) {
  const fallbackValues = getDefaultCameraTimingValues(camera);
  const minStart = Math.max(0, options.minStartMs);
  const maxEnd = options.maxEndMs === undefined ? undefined : Math.max(minStart, options.maxEndMs);
  const rawStart = Math.max(minStart, values?.[0] ?? fallbackValues[0]);
  const start = options.startLocked ? fallbackValues[0] : Math.min(rawStart, maxEnd ?? rawStart);

  const fallbackStayEnd = options.defaultEndMs ?? options.maxEndMs ?? fallbackValues[2];
  const rawStayEnd = Math.max(start, values?.[2] ?? fallbackStayEnd);
  const stayEnd = Math.min(rawStayEnd, maxEnd ?? rawStayEnd);
  const motionEnd = Math.max(start, Math.min(values?.[1] ?? fallbackValues[1], stayEnd));

  return [start, motionEnd, stayEnd];
}

function getChangedHandleIndex(currentValues: number[], nextValues: number[]) {
  let changedIndex: number | undefined;
  let changedDistance = 0;

  for (let index = 0; index < currentValues.length; index++) {
    const distance = Math.abs((nextValues[index] ?? currentValues[index]) - currentValues[index]);
    if (distance > changedDistance) {
      changedIndex = index;
      changedDistance = distance;
    }
  }

  return changedIndex;
}

function addMark(marks: Record<number, CameraTimingMark>, value: number, label: string) {
  const normalizedValue = Math.max(0, value);
  const existingMark = marks[normalizedValue];

  marks[normalizedValue] = {
    style: {
      textAlign: 'center',
      transform: 'translateX(-50%)',
      whiteSpace: 'nowrap',
    },
    label: existingMark ? existingMark.label : label,
  };
}

export function createCameraTimingMarks(values: number[]) {
  const marks: Record<number, CameraTimingMark> = {};

  addMark(marks, values[0] ?? 0, 'camera start');
  addMark(marks, values[1] ?? 0, 'camera end');

  if (values.length > 2) {
    addMark(marks, values[2] ?? 0, 'stay end');
  }

  return marks;
}

export function getCameraTimingSliderConfig(
  camera: TargetCamera,
  values?: number[],
  optionsInput: CameraTimingSliderOptionsInput = {},
): CameraTimingSliderConfig {
  const options = resolveCameraTimingSliderOptions(optionsInput);
  const normalizedValues = normalizeCameraTimingValues(camera, values, options);
  const absoluteEnd = normalizedValues[normalizedValues.length - 1] ?? 0;
  const timelineEnd = Math.max(0, options.timelineEndMs);
  const boundaryEnd = options.maxEndMs === undefined ? absoluteEnd : Math.max(0, options.maxEndMs);
  const sliderEnd = timelineEnd > 0 ? timelineEnd : boundaryEnd;
  const max = Math.max(MIN_SLIDER_MAX_MS, absoluteEnd, sliderEnd);

  return {
    values: normalizedValues,
    max,
    marks: createCameraTimingMarks(normalizedValues),
  };
}

export function getCameraTimingSliderEdit(
  camera: TargetCamera,
  values: number[],
  optionsInput: CameraTimingSliderOptionsInput = {},
): TimelineEdit | undefined {
  if (camera.generated || !camera.editable) {
    return undefined;
  }

  const options = resolveCameraTimingSliderOptions(optionsInput);
  const currentValues = getCameraTimingSliderConfig(camera, undefined, options).values;
  const changedIndex = getChangedHandleIndex(currentValues, values);

  if (changedIndex === undefined) {
    return undefined;
  }

  if (changedIndex === 0 && options.startLocked) {
    return undefined;
  }

  const nextValues = getCameraTimingSliderConfig(camera, values, options).values;
  if (nextValues[changedIndex] === currentValues[changedIndex]) {
    return undefined;
  }

  return {
    type: 'ripple-resize',
    camera,
    edge: changedIndex === 0 ? 'start' : changedIndex === 1 ? 'motion-end' : 'end',
    valueMs: nextValues[changedIndex],
  };
}

export function getCameraStartMinMs(timelineData: TargetCameras[], targetIndex: number, cameraIndex: number) {
  const target = timelineData[targetIndex];
  if (!target) {
    return 0;
  }

  if (cameraIndex > 0) {
    const previousCamera = target.cameras[cameraIndex - 1];
    return previousCamera
      ? Math.max(0, previousCamera.start + previousCamera.duration + previousCamera.stay)
      : Math.max(0, target.targetStart);
  }

  const previousTarget = timelineData[targetIndex - 1];
  return previousTarget ? Math.max(0, previousTarget.targetEnd) : 0;
}

export function getCameraEndDefaultMs(timelineData: TargetCameras[], targetIndex: number, cameraIndex: number) {
  const target = timelineData[targetIndex];
  if (!target) {
    return 0;
  }

  const camera = target.cameras[cameraIndex];
  if (camera) {
    return Math.max(0, camera.start + camera.duration + camera.stay);
  }

  return Math.max(0, target.targetEnd);
}

export function getCameraEndMaxMs(
  timelineData: TargetCameras[],
  targetIndex: number,
  cameraIndex: number,
  totalTimeLength: number,
) {
  const target = timelineData[targetIndex];
  if (!target) {
    return Math.max(0, totalTimeLength);
  }

  const nextCamera = target.cameras[cameraIndex + 1];
  if (nextCamera) {
    return Math.max(0, nextCamera.start);
  }

  const nextTarget = timelineData[targetIndex + 1];
  if (nextTarget) {
    return Math.max(0, nextTarget.targetStart);
  }

  return Math.max(0, target.targetEnd, totalTimeLength);
}
