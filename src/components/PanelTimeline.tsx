import '../css/PanelTimeline.css';

import React from 'react';
import { Badge, Button, Card, Col, Popconfirm, Row, Slider, Space, Table, Tag, Typography } from 'antd';
import {
  CaretRightOutlined,
  DeleteOutlined,
  EditOutlined,
  MinusOutlined,
  NodeIndexOutlined,
  PauseOutlined,
  StepBackwardOutlined,
  StepForwardOutlined,
  SwapRightOutlined,
} from '@ant-design/icons';
import type {
  CameraMovement,
  CustomObject,
  PlaybackSegment,
  TargetCamera,
  TargetCameras,
  TimelineEdit,
} from '../interfaces';
import { VscCircle } from 'react-icons/vsc';
import { MdWorkspacesOutline } from 'react-icons/md';
import { BiShapePolygon } from 'react-icons/bi';
import MultiProgress, { type IMultiProgressProps } from 'react-multi-progress';
import type { CameraTimingMark, CameraTimingSliderOptions } from '../story/timeline-controls';
import {
  getCameraEndDefaultMs,
  getCameraEndMaxMs,
  getCameraStartMinMs,
  getCameraTimingSliderConfig,
  getCameraTimingSliderEdit,
} from '../story/timeline-controls';
import { getTimelineFocusedRowScrollTop, getTimelineTableScroll } from '../story/timeline-layout';
import { getClickOnlySelectionHandlers } from '../story/timeline-selection';
import { getSourceIndexAtTime } from '../story/playback';
import { getCameraById } from '../camera/catalog';
import {
  NARRATIVE_COLOR_LEGEND_ITEMS,
  getNarrativeColorStyle,
  getNarrativeLabel,
  getNarrativeProgressColor,
  getNarrativeSliderClassName,
  getNarrativeTagColor,
} from '../theme/narrativeColors';

const { Text } = Typography;

const TIMELINE_LAYOUT = {
  expandColumn: 48,
  typeColumn: 128,
  nameColumn: 172,
  actionColumn: 120,
} as const;

function px(value: number) {
  return `${value}px`;
}

function getGeoTypeText(type: string) {
  if (type === 'point' || type === 'location') {
    return (
      <Space className="timeline-geo-type" size={4}>
        <VscCircle className="shrink-0" />
        <Text className="timeline-geo-type-label text-xs">LOCATION</Text>
      </Space>
    );
  } else if (type === 'path') {
    return (
      <Space className="timeline-geo-type" size={4}>
        <NodeIndexOutlined className="shrink-0" />
        <Text className="timeline-geo-type-label text-xs">PATH</Text>
      </Space>
    );
  } else if (type === 'transition') {
    return (
      <Space className="timeline-geo-type" size={4}>
        <SwapRightOutlined className="shrink-0" />
        <Text className="timeline-geo-type-label text-xs">TRANSITION</Text>
      </Space>
    );
  } else if (type === 'region') {
    return (
      <Space className="timeline-geo-type" size={4}>
        <BiShapePolygon className="shrink-0" />
        <Text className="timeline-geo-type-label text-xs">REGION</Text>
      </Space>
    );
  } else if (type === 'multiple') {
    return (
      <Space className="timeline-geo-type" size={4}>
        <MdWorkspacesOutline className="shrink-0" />
        <Text className="timeline-geo-type-label text-xs">MULTIPLE</Text>
      </Space>
    );
  } else if (type === 'none' || type === 'null') {
    return (
      <Space className="timeline-geo-type" size={4}>
        <MinusOutlined className="shrink-0" />
        <Text className="timeline-geo-type-label text-xs">NONE</Text>
      </Space>
    );
  } else {
    return;
  }
}

function msToTime(duration: number) {
  const milliseconds = Math.floor((duration % 1000) / 100);
  const seconds = Math.floor((duration / 1000) % 60);
  const minutes = Math.floor((duration / (1000 * 60)) % 60);
  const minuteString = minutes < 10 ? '0' + minutes : minutes;
  const secondString = seconds < 10 ? '0' + seconds : seconds;
  const millisecondString = milliseconds + '0';

  return `${minuteString}:${secondString}.${millisecondString}`;
}

function tipFormatter(value: number | undefined) {
  return value ? `${msToTime(value)}` : `00:00.0`;
}

function getTargetDisplayName(target: TargetCameras) {
  if (target.name?.length) {
    return target.name;
  }

  return typeof target.location[0] === 'undefined' || typeof target.location[1] === 'undefined'
    ? 'overview'
    : `[${target.location[0]}, ${target.location[1]}]`;
}

function getCameraTimingMarks(marks: Record<number, CameraTimingMark>) {
  const hasStay = Object.values(marks).some((mark) => mark.label === 'stay end');
  return Object.fromEntries(
    Object.entries(marks).map(([value, mark]) => [
      value,
      {
        ...mark,
        style: {
          ...mark.style,
          ...(mark.label === 'camera start' || mark.label === 'stay end'
            ? { transform: 'none', paddingInlineStart: 2 }
            : hasStay && mark.label === 'camera end'
              ? { transform: 'translateX(-100%)', paddingInlineEnd: 2 }
              : {}),
        },
        label: (
          <span
            className={`timeline-mark-label camera-timing-mark-label ${mark.label === 'camera start' ? 'camera-timing-mark-start' : ''}`}
            title={mark.label}>
            {mark.label === 'camera start' ? 'cam. start' : mark.label === 'camera end' ? 'cam. end' : 'stay'}
          </span>
        ),
      },
    ]),
  );
}

interface TimelineCameraTableProps {
  selectedCamera?: CameraMovement;
  timelineData: TargetCameras[];
  totalTimeLength: number;
  timelineHeight: number;
  expandedKeys: string[];
  onTargetDelete: (target: TargetCameras) => void;
  onTargetRowClick: (target: TargetCameras, index: number | undefined) => void;
  onTargetExpand: (expanded: boolean, target: TargetCameras) => void;
  onCameraRowClick: (targetIndex: number, cameraIndex: number) => void;
  onTimelineEdit: PanelTimelineProps['onTimelineEdit'];
  renderCameraTimingSlider: (camera: TargetCamera, targetIndex: number, cameraIndex: number) => React.ReactNode;
}

// Playback time belongs to the controls; only editing, selection and layout invalidate these rows.
export class TimelineCameraTable extends React.PureComponent<TimelineCameraTableProps> {
  render() {
    const { timelineData, totalTimeLength, selectedCamera } = this.props;
    const timelineTableScroll = getTimelineTableScroll(
      this.props.timelineHeight,
      timelineData,
      this.props.expandedKeys,
    );

    const columns = [
      {
        title: 'Type',
        key: 'type',
        width: TIMELINE_LAYOUT.typeColumn,
        render: (target: TargetCameras) => {
          const typeLabel = getGeoTypeText(target.type);
          return typeLabel ? (
            <Tag className="timeline-tag timeline-geo-tag" bordered={false}>
              {typeLabel}
            </Tag>
          ) : null;
        },
      },
      {
        title: 'Name',
        key: 'name',
        width: TIMELINE_LAYOUT.nameColumn,
        render: (target: TargetCameras) => {
          const displayName = getTargetDisplayName(target);

          return (
            <div onClick={(event) => event.stopPropagation()}>
              <Text
                className="timeline-target-name text-xs"
                editable={{
                  icon: <EditOutlined aria-label="Edit target name" />,
                  tooltip: 'Edit name',
                  text: displayName,
                  autoSize: { minRows: 1, maxRows: 1 },
                  onChange: (name) => this.props.onTimelineEdit({ type: 'rename-target', target, name }),
                }}>
                <span className="min-w-0 truncate" title={displayName}>
                  {displayName}
                </span>
              </Text>
            </div>
          );
        },
      },
      {
        title: 'Time',
        key: 'time',
        onCell: () => ({ className: 'timeline-time-cell' }),
        render: (target: TargetCameras) => {
          const targetMarks = {
            [String(target.targetStart)]: {
              style: { transform: 'translateX(-50%)', whiteSpace: 'nowrap' },
              label: <span className="timeline-mark-label text-xs">start</span>,
            },
            [String(target.targetEnd)]: {
              style: { transform: 'translateX(-50%)', whiteSpace: 'nowrap' },
              label: <span className="timeline-mark-label text-xs">end</span>,
            },
          };

          return (
            <Slider
              className="target-slider"
              tooltip={{ formatter: tipFormatter }}
              marks={targetMarks}
              step={100}
              range={{ draggableTrack: false }}
              min={0}
              max={totalTimeLength}
              disabled={true}
              value={[target.targetStart, target.targetEnd]}
            />
          );
        },
      },
      {
        title: 'Action',
        key: 'action',
        width: TIMELINE_LAYOUT.actionColumn,
        render: (_: CustomObject, target: TargetCameras) => {
          const hasEditableCamera = target.cameras.some((camera) => camera.editable && !camera.generated);
          return (
            <Popconfirm
              title="Sure to delete?"
              onConfirm={() => this.props.onTargetDelete(target)}
              disabled={!hasEditableCamera}>
              <Button
                className="float-right"
                size="small"
                type="default"
                disabled={!hasEditableCamera}
                onClick={(event) => event.stopPropagation()}
                icon={<DeleteOutlined className="text-xs" />}>
                Delete
              </Button>
            </Popconfirm>
          );
        },
      },
    ];

    return (
      <Table
        pagination={false}
        showHeader={false}
        footer={undefined}
        columns={columns}
        dataSource={timelineData}
        scroll={timelineTableScroll}
        bordered={false}
        size="small"
        rowClassName={(targetItem) =>
          selectedCamera && targetItem.cameras.some((camera) => !camera.generated && camera.id === selectedCamera.id)
            ? 'timeline-target-row timeline-target-row-active cursor-pointer'
            : 'timeline-target-row cursor-pointer'
        }
        onRow={(targetItem, targetIndex) => {
          return {
            'data-timeline-target-index': targetIndex,
            ...getClickOnlySelectionHandlers(() => {
              this.props.onTargetRowClick(targetItem, targetIndex);
            }),
          };
        }}
        expandable={{
          columnWidth: TIMELINE_LAYOUT.expandColumn,
          expandedRowKeys: this.props.expandedKeys,
          onExpand: this.props.onTargetExpand,
          expandRowByClick: true,
          expandedRowRender: (target, targetIndex) => (
            <Row key={`target-${targetIndex}`} className="h-full w-full">
              {target.cameras.map((camera, cameraIndex) => {
                const tagCategory = camera.category;
                const isSelected = Boolean(selectedCamera && !camera.generated && camera.id === selectedCamera.id);
                const cameraTitle = getCameraById(camera.name ?? '')?.title ?? camera.title;
                const tagLabel = camera.category ? getNarrativeLabel(tagCategory) : 'Manual';

                return (
                  <Col key={`${camera.id ?? cameraIndex}-${cameraIndex}`} span={24}>
                    <Row
                      gutter={0}
                      data-timeline-target-index={targetIndex}
                      data-timeline-camera-index={cameraIndex}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isSelected}
                      aria-label={`Select camera ${cameraTitle}`}
                      className={`timeline-camera-row cursor-pointer border-t border-gray-200 hover:bg-sky-50 ${
                        isSelected ? 'timeline-camera-row-active' : ''
                      }`}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' '))
                          return;
                        event.preventDefault();
                        this.props.onCameraRowClick(targetIndex, cameraIndex);
                      }}
                      {...getClickOnlySelectionHandlers(() => {
                        this.props.onCameraRowClick(targetIndex, cameraIndex);
                      })}>
                      <Col flex={px(TIMELINE_LAYOUT.expandColumn)}>
                        <Text className="timeline-camera-meta text-xs">{`${cameraIndex + 1}:`}</Text>
                      </Col>
                      <Col flex={px(TIMELINE_LAYOUT.typeColumn)} className="timeline-camera-type-cell">
                        <Tag
                          className="timeline-tag timeline-camera-meta-tag max-w-full text-xs whitespace-nowrap"
                          color={getNarrativeTagColor(tagCategory)}
                          key={`tag-camera-${cameraIndex}`}>
                          {tagLabel}
                        </Tag>
                      </Col>
                      <Col flex={px(TIMELINE_LAYOUT.nameColumn)}>
                        <Text
                          className="timeline-camera-title block max-w-full truncate text-xs font-medium"
                          title={cameraTitle}>
                          {cameraTitle}
                        </Text>
                      </Col>
                      <Col
                        flex="auto"
                        className="timeline-camera-time-cell"
                        onClick={(event) => event.stopPropagation()}>
                        {this.props.renderCameraTimingSlider(camera, targetIndex, cameraIndex)}
                      </Col>
                      <Col flex={px(TIMELINE_LAYOUT.actionColumn)} className="timeline-camera-action-cell">
                        <Popconfirm
                          title="Sure to delete?"
                          disabled={!camera.editable}
                          onConfirm={() => this.props.onTimelineEdit({ type: 'delete-camera', camera })}>
                          <Button
                            className="mt-0"
                            size="small"
                            type="default"
                            disabled={!camera.editable}
                            onClick={(event) => event.stopPropagation()}
                            icon={<DeleteOutlined className="text-xs!" />}
                          />
                        </Popconfirm>
                      </Col>
                    </Row>
                  </Col>
                );
              })}
            </Row>
          ),
          rowExpandable: (record) => record.cameras.length > 0,
        }}
      />
    );
  }
}

export interface PanelTimelineProps {
  timelineHeight: number;
  cameraMovementList: CameraMovement[];
  cameraPlayIndex: number;
  selectedCameraId?: string | null;
  playbackSegments: PlaybackSegment[];
  timelineData: TargetCameras[];
  totalTimeLength: number;
  isPlaying: boolean;
  currentTimeMs?: number;
  targetIndex: number;
  cameraIndex: number;
  expandedKeys: string[];
  progressElement: IMultiProgressProps<object>['elements'];
  onTimelinePlay: (startTimeMs: number) => void;
  onTimelinePause: (timeMs?: number) => void;
  onTimelineSeek: (timeMs: number) => void;
  onCameraPlayIndexChange: (playIndex: number) => void;
  onPlayingStatusChange: (isPlaying: boolean) => void;
  onTimelineTargetIndexChange: (index: number) => void;
  onTimelineCameraIndexChange: (targetIndex: number, cameraIndex: number) => void;
  onClearCameraSelection?: () => void;
  onTimelineExpandedKeyChange: (expandedKeys: string[]) => void;
  onTimelineEdit: (edit: TimelineEdit) => void;
}

export interface PanelTimelineState {
  currentTime: number;
}

class PanelTimeline extends React.Component<PanelTimelineProps, PanelTimelineState> {
  private focusedScrollFrameId: number | undefined;

  constructor(props: PanelTimelineProps) {
    super(props);
    this.handleTimelinePlayButtonClick = this.handleTimelinePlayButtonClick.bind(this);
    this.handleTimelinePauseButtonClick = this.handleTimelinePauseButtonClick.bind(this);
    this.handleTimelineBackButtonClick = this.handleTimelineBackButtonClick.bind(this);
    this.handleTimelineNextButtonClick = this.handleTimelineNextButtonClick.bind(this);
    this.handleTimelineSliderChange = this.handleTimelineSliderChange.bind(this);
    this.handleTargetExpand = this.handleTargetExpand.bind(this);
    this.handleTargetRowClick = this.handleTargetRowClick.bind(this);
    this.handleTargetDeleteClick = this.handleTargetDeleteClick.bind(this);
    this.handleCameraRowClick = this.handleCameraRowClick.bind(this);
    this.renderCameraTimingSlider = this.renderCameraTimingSlider.bind(this);

    this.state = {
      currentTime: props.currentTimeMs ?? 0,
    };
  }

  componentDidUpdate(previousProps: PanelTimelineProps) {
    if (
      previousProps.totalTimeLength !== this.props.totalTimeLength &&
      this.state.currentTime > this.props.totalTimeLength
    ) {
      this.setState({ currentTime: this.props.totalTimeLength });
    }

    if (
      this.props.targetIndex > -1 &&
      (previousProps.timelineData !== this.props.timelineData ||
        previousProps.expandedKeys !== this.props.expandedKeys ||
        previousProps.timelineHeight !== this.props.timelineHeight)
    ) {
      this.requestFocusedTimelineRowScroll();
    }
  }

  componentWillUnmount() {
    if (this.focusedScrollFrameId !== undefined) {
      window.cancelAnimationFrame(this.focusedScrollFrameId);
    }
  }

  private getCurrentTime() {
    return Math.max(0, Math.min(this.props.currentTimeMs ?? this.state.currentTime, this.props.totalTimeLength));
  }

  handleTimelinePlayButtonClick() {
    const currentTime = this.getCurrentTime();
    if (currentTime < this.props.totalTimeLength) {
      this.props.onTimelinePlay(currentTime);
      this.props.onPlayingStatusChange(true);
    } else {
      this.handleTimelinePauseButtonClick();
    }
  }

  handleTimelinePauseButtonClick() {
    const pauseTime = this.getCurrentTime();
    this.setState({ currentTime: pauseTime });
    this.props.onTimelinePause(pauseTime);
    this.props.onPlayingStatusChange(false);
  }

  handleTimelineBackButtonClick() {
    this.handleTimelineSliderChange(0);
  }

  handleTimelineNextButtonClick() {
    this.handleTimelineSliderChange(this.props.totalTimeLength);
  }

  handleTimelineSliderChange(value: number) {
    this.props.onTimelinePause(this.getCurrentTime());
    this.props.onPlayingStatusChange(false);
    this.setState({ currentTime: value });
    this.props.onTimelineSeek(value);
    this.props.onCameraPlayIndexChange(getSourceIndexAtTime(this.props.playbackSegments, value));
  }

  handleTargetExpand(expanded: boolean, record: TargetCameras) {
    let expandedKeys = this.props.expandedKeys;
    if (expanded) {
      if (!expandedKeys.includes(record.key)) {
        expandedKeys = [...expandedKeys, record.key];
      }
    } else {
      expandedKeys = expandedKeys.filter((key) => key !== record.key);
    }
    this.props.onTimelineExpandedKeyChange(expandedKeys);
  }

  handleTargetRowClick(_targetItem: TargetCameras, targetIndex: number | undefined) {
    if (typeof targetIndex !== 'undefined') {
      this.props.onTimelineTargetIndexChange(targetIndex);
    }
  }

  handleTargetDeleteClick(target: TargetCameras) {
    this.props.onTimelineEdit({ type: 'delete-target', target });
  }

  handleCameraRowClick(timelineTargetIndex: number, timelineCameraIndex: number) {
    const camera = this.props.timelineData[timelineTargetIndex]?.cameras[timelineCameraIndex];
    if (!camera || camera.generated) {
      return;
    }
    this.props.onTimelineCameraIndexChange(timelineTargetIndex, timelineCameraIndex);
  }

  handleCameraTimingSliderChange(camera: TargetCamera, value: number[], options: CameraTimingSliderOptions) {
    const edit = getCameraTimingSliderEdit(camera, value, options);
    if (edit) {
      this.props.onTimelineEdit(edit);
    }
  }

  requestFocusedTimelineRowScroll() {
    if (this.focusedScrollFrameId !== undefined) {
      window.cancelAnimationFrame(this.focusedScrollFrameId);
    }

    this.focusedScrollFrameId = window.requestAnimationFrame(() => {
      this.focusedScrollFrameId = undefined;
      this.scrollFocusedTimelineRow();
    });
  }

  scrollFocusedTimelineRow() {
    const scrollBody = document.querySelector<HTMLElement>('#panel-timeline .ant-table-body');
    if (!scrollBody) {
      return;
    }

    const nextScrollTop = getTimelineFocusedRowScrollTop({
      timelineData: this.props.timelineData,
      expandedKeys: this.props.expandedKeys,
      targetIndex: this.props.targetIndex,
      cameraIndex: this.props.cameraIndex,
      currentScrollTop: scrollBody.scrollTop,
      viewportHeight: scrollBody.clientHeight,
    });

    if (typeof nextScrollTop === 'number' && Math.abs(scrollBody.scrollTop - nextScrollTop) > 1) {
      scrollBody.scrollTop = nextScrollTop;
    }
  }

  renderCameraTimingSlider(camera: TargetCamera, targetIndex: number, cameraIndex: number) {
    const startLocked = targetIndex === 0 && cameraIndex === 0;
    const timingOptions: CameraTimingSliderOptions = {
      timelineEndMs: this.props.totalTimeLength,
      minStartMs: getCameraStartMinMs(this.props.timelineData, targetIndex, cameraIndex),
      defaultEndMs: getCameraEndDefaultMs(this.props.timelineData, targetIndex, cameraIndex),
      maxEndMs: getCameraEndMaxMs(this.props.timelineData, targetIndex, cameraIndex, this.props.totalTimeLength),
      startLocked,
    };
    const config = getCameraTimingSliderConfig(camera, undefined, timingOptions);
    const canEditTiming = camera.editable && !camera.generated;
    const handleTabIndex = config.values.map((_, index) => (startLocked && index === 0 ? -1 : 0));

    return (
      <div className="w-full min-w-0 p-0">
        <Slider
          tooltip={{ formatter: tipFormatter }}
          range={{ draggableTrack: false }}
          {...({ allowCross: false } as { allowCross: boolean })}
          min={0}
          max={config.max}
          step={100}
          disabled={!canEditTiming}
          marks={getCameraTimingMarks(config.marks)}
          tabIndex={handleTabIndex}
          ariaLabelForHandle={['camera start', 'camera end', 'stay end']}
          className={`camera-slider camera-timing-slider ${
            startLocked ? 'camera-start-locked' : ''
          } ${getNarrativeSliderClassName(camera.category)}`}
          style={getNarrativeColorStyle(camera.category)}
          value={config.values}
          onChange={(value: number[]) => this.handleCameraTimingSliderChange(camera, value, timingOptions)}
        />
      </div>
    );
  }

  render() {
    const { cameraMovementList, cameraPlayIndex, totalTimeLength, isPlaying } = this.props;
    const currentTime = this.getCurrentTime();
    const selectedCameraIndex = this.props.selectedCameraId
      ? cameraMovementList.findIndex((camera) => camera.id === this.props.selectedCameraId)
      : -1;
    const selectedCamera = cameraMovementList[selectedCameraIndex];
    const selectionLabel = selectedCamera
      ? `Selected: #${selectedCameraIndex + 1} ${getCameraById(selectedCamera.name)?.title ?? selectedCamera.title}`
      : 'No camera selected';
    const playingCamera = cameraMovementList[cameraPlayIndex];
    const playbackLabel = playingCamera
      ? `#${cameraPlayIndex + 1} ${getCameraById(playingCamera.name)?.title ?? playingCamera.title}`
      : '';
    // The axis has 8px cell padding plus 5px slider margin; the card header has 12px padding.
    const playbackHeaderOffset =
      TIMELINE_LAYOUT.expandColumn + TIMELINE_LAYOUT.typeColumn + TIMELINE_LAYOUT.nameColumn + 8 + 5 - 12;

    return (
      <Card
        variant="borderless"
        id="panel-timeline"
        className="h-full w-full"
        size="small"
        title={
          <div
            className="timeline-header"
            style={{ gridTemplateColumns: `${px(playbackHeaderOffset)} minmax(0, 1fr)` }}>
            <div className="timeline-selection-header">
              <Text>Timeline</Text>
              {selectedCamera && (
                <Button
                  className="timeline-clear-selection"
                  size="small"
                  aria-label="Clear selection"
                  title="Clear selection"
                  onClick={(event) => {
                    event.stopPropagation();
                    this.props.onClearCameraSelection?.();
                  }}>
                  Clear
                </Button>
              )}
              <span className="timeline-selection-status" role="status" aria-live="polite" title={selectionLabel}>
                {selectionLabel}
              </span>
            </div>
            {playingCamera && (
              <div className="timeline-playback-status" title={playbackLabel}>
                <Badge color={getNarrativeProgressColor(playingCamera.category)} />
                <Text className="timeline-playback-label">{playbackLabel}</Text>
              </div>
            )}
          </div>
        }
        extra={
          <Space size="small">
            {NARRATIVE_COLOR_LEGEND_ITEMS.filter((item) => item.category !== 'transition').map((item) => (
              <Badge key={item.category} color={item.swatch} text={<span className="text-xs">{item.label}</span>} />
            ))}
          </Space>
        }>
        <Space className="h-full w-full" direction="vertical" size={0}>
          <Row className="timeline-playback-bar bg-gray-50 leading-8">
            <Col flex={px(TIMELINE_LAYOUT.expandColumn + TIMELINE_LAYOUT.typeColumn)} className="pl-4">
              <Space size="small">
                <Button size="small" icon={<StepBackwardOutlined />} onClick={this.handleTimelineBackButtonClick} />
                {isPlaying ? (
                  <Button size="small" icon={<PauseOutlined />} onClick={this.handleTimelinePauseButtonClick} />
                ) : (
                  <Button size="small" icon={<CaretRightOutlined />} onClick={this.handleTimelinePlayButtonClick} />
                )}
                <Button size="small" icon={<StepForwardOutlined />} onClick={this.handleTimelineNextButtonClick} />
              </Space>
            </Col>
            <Col flex={px(TIMELINE_LAYOUT.nameColumn)}>
              <Text className="text-xs">{`[${msToTime(currentTime)}/${msToTime(totalTimeLength)}]`}</Text>
            </Col>
            <Col flex="auto" className="min-w-0 pr-3.5 pl-2">
              <div className="relative top-[-8px] h-2 px-[5px]">
                <MultiProgress
                  transitionTime={0.5}
                  round={false}
                  roundLastElement={false}
                  elements={this.props.progressElement}
                  height={4}
                  backgroundColor="#f0f0f0"
                />
              </div>
              <Slider
                className="progress-slider"
                tooltip={{ open: currentTime > 0, formatter: tipFormatter }}
                step={1}
                // Display whole milliseconds without rounding the actual paused sample.
                value={Math.floor(currentTime)}
                min={0}
                max={totalTimeLength}
                onChange={this.handleTimelineSliderChange}
              />
            </Col>
            <Col flex={px(TIMELINE_LAYOUT.actionColumn)} />
          </Row>
          <TimelineCameraTable
            selectedCamera={selectedCamera}
            timelineData={this.props.timelineData}
            totalTimeLength={totalTimeLength}
            timelineHeight={this.props.timelineHeight}
            expandedKeys={this.props.expandedKeys}
            onTargetDelete={this.handleTargetDeleteClick}
            onTargetRowClick={this.handleTargetRowClick}
            onTargetExpand={this.handleTargetExpand}
            onCameraRowClick={this.handleCameraRowClick}
            onTimelineEdit={this.props.onTimelineEdit}
            renderCameraTimingSlider={this.renderCameraTimingSlider}
          />
        </Space>
      </Card>
    );
  }
}

export default PanelTimeline;
