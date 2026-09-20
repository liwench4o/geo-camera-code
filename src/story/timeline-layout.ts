const TIMELINE_TABLE_HEIGHT_OFFSET = 96;
const TIMELINE_TARGET_ROW_HEIGHT = 35;
const TIMELINE_CAMERA_ROW_HEIGHT = 37;
const TIMELINE_SCROLL_PADDING = 8;

interface TimelineLayoutCamera {
  id?: unknown;
  generated?: unknown;
  sourceIndex?: number;
}

interface TimelineLayoutTarget {
  key: string;
  cameras: TimelineLayoutCamera[];
}

export function getTimelineMainContentHeightStyle(timelineHeight: number) {
  return `calc(100% - ${timelineHeight}px)`;
}

export function getTimelineIndicesForSourceIndex(timelineData: TimelineLayoutTarget[], sourceIndex: number) {
  if (sourceIndex < 0) {
    return { timelineTargetIndex: -1, timelineCameraIndex: -1 };
  }

  for (let targetIndex = 0; targetIndex < timelineData.length; targetIndex++) {
    const cameraIndex = timelineData[targetIndex].cameras.findIndex(
      (camera) => camera.sourceIndex === sourceIndex && !camera.generated,
    );
    if (cameraIndex >= 0) {
      return {
        timelineTargetIndex: targetIndex,
        timelineCameraIndex: cameraIndex,
      };
    }
  }

  return { timelineTargetIndex: -1, timelineCameraIndex: -1 };
}

export function getTimelineTableScroll(
  timelineHeight: number,
  timelineData: TimelineLayoutTarget[],
  expandedKeys: string[],
): { y: number } | undefined {
  const availableBodyHeight = Math.max(1, timelineHeight - TIMELINE_TABLE_HEIGHT_OFFSET);
  const expandedKeySet = new Set(expandedKeys);
  const contentHeight = timelineData.reduce((height, target) => {
    const cameraRowsHeight = expandedKeySet.has(target.key) ? target.cameras.length * TIMELINE_CAMERA_ROW_HEIGHT : 0;

    return height + TIMELINE_TARGET_ROW_HEIGHT + cameraRowsHeight;
  }, TIMELINE_SCROLL_PADDING);

  return contentHeight > availableBodyHeight ? { y: availableBodyHeight } : undefined;
}

interface TimelineFocusedRowScrollInput {
  timelineData: TimelineLayoutTarget[];
  expandedKeys: string[];
  targetIndex: number;
  cameraIndex: number;
  currentScrollTop: number;
  viewportHeight: number;
}

function getTargetRowOffset(timelineData: TimelineLayoutTarget[], expandedKeySet: Set<string>, targetIndex: number) {
  let offset = 0;

  for (let index = 0; index < targetIndex; index++) {
    const target = timelineData[index];
    if (!target) {
      break;
    }

    offset += TIMELINE_TARGET_ROW_HEIGHT;
    if (expandedKeySet.has(target.key)) {
      offset += target.cameras.length * TIMELINE_CAMERA_ROW_HEIGHT;
    }
  }

  return offset;
}

export function getTimelineFocusedRowScrollTop({
  timelineData,
  expandedKeys,
  targetIndex,
  cameraIndex,
  currentScrollTop,
  viewportHeight,
}: TimelineFocusedRowScrollInput): number | undefined {
  const target = timelineData[targetIndex];
  if (!target || viewportHeight <= 0) {
    return undefined;
  }

  const expandedKeySet = new Set(expandedKeys);
  const isExpanded = expandedKeySet.has(target.key);
  let rowTop = getTargetRowOffset(timelineData, expandedKeySet, targetIndex);
  let rowHeight = TIMELINE_TARGET_ROW_HEIGHT;

  if (isExpanded && cameraIndex >= 0 && cameraIndex < target.cameras.length) {
    rowTop += TIMELINE_TARGET_ROW_HEIGHT + cameraIndex * TIMELINE_CAMERA_ROW_HEIGHT;
    rowHeight = TIMELINE_CAMERA_ROW_HEIGHT;
  }

  const rowBottom = rowTop + rowHeight;
  const visibleTop = currentScrollTop + TIMELINE_SCROLL_PADDING;
  const visibleBottom = currentScrollTop + viewportHeight - TIMELINE_SCROLL_PADDING;

  if (rowTop >= visibleTop && rowBottom <= visibleBottom) {
    return currentScrollTop;
  }

  if (rowBottom > visibleBottom) {
    return Math.max(0, rowBottom - viewportHeight + TIMELINE_SCROLL_PADDING);
  }

  return Math.max(0, rowTop - TIMELINE_SCROLL_PADDING);
}
