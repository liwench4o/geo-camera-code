import '../css/PanelConfig.css';

import React from 'react';
import {
  Button,
  Card,
  Col,
  Collapse,
  Divider,
  Input,
  InputNumber,
  message,
  Popconfirm,
  Row,
  Select,
  Slider,
  Space,
  Switch,
  Tabs,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import {
  BlockOutlined,
  CaretRightOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  ExportOutlined,
  ImportOutlined,
  InfoCircleOutlined,
  PauseOutlined,
  QuestionCircleTwoTone,
  StepBackwardOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import type { CameraMovement, CameraView, HomeViews } from '../interfaces';
import _ from 'lodash';
import { getUploadResult } from '../util';
import FileSaver from 'file-saver';
import { createStoryJson, parseStoryJson } from '../story/serialization';
import { normalizeCameraAuthoringView, recordCameraManualView } from '../camera/authoring';
import { isCameraTarget } from '../camera/selection';
import type { ViewportSize } from '../camera/types';
import {
  VISUALIZATION_MAP_STYLE_PARAM_KEY,
  type UploadedDatasetOverride,
  type VisualizationCatalog,
  type VisualizationParameterConfig,
  type VisualizationParameterValue,
  type VisualizationParameterValues,
} from '../visualization/types';
import { getActiveDatasetId } from '../visualization/registry';
import { getAdaptiveVisualizationParameterKeys } from '../visualization/parameter-state';

const { Panel } = Collapse;
const { Text } = Typography;
const { Option } = Select;
const { TextArea } = Input;
const TEST_VISUALIZATION_IDS = new Set(['line', 'point', 'animated']);

interface CompatTabPaneProps {
  id?: string;
  tab: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  forceRender?: boolean;
}

function TabPane(props: CompatTabPaneProps) {
  return <>{props.children}</>;
}

function CompatTabs({
  children,
  items,
  defaultActiveKey,
  activeKey,
  onChange,
  itemOrder,
  ...props
}: React.ComponentProps<typeof Tabs> & { children?: React.ReactNode; itemOrder?: string[] }) {
  const generatedItems: NonNullable<React.ComponentProps<typeof Tabs>['items']> = [];
  React.Children.forEach(children, (child) => {
    if (React.isValidElement<CompatTabPaneProps>(child) && child.key !== null) {
      generatedItems.push({
        key: String(child.key),
        label: child.props.tab,
        children: child.props.children,
        className: child.props.className,
        style: child.props.style,
        disabled: child.props.disabled,
        forceRender: child.props.forceRender,
      });
    }
  });
  const resolvedItems = items ?? generatedItems;
  const itemOrderMap = new Map(itemOrder?.map((key, index) => [key, index]));
  const orderedItems = itemOrder?.length
    ? [...resolvedItems].sort((a, b) => {
        const fallbackIndex = itemOrder.length;
        const aIndex = itemOrderMap.get(String(a.key)) ?? fallbackIndex;
        const bIndex = itemOrderMap.get(String(b.key)) ?? fallbackIndex;
        return aIndex - bIndex;
      })
    : resolvedItems;
  const itemKeys = orderedItems.map((item) => String(item.key));
  const [internalActiveKey, setInternalActiveKey] = React.useState(
    String(activeKey ?? defaultActiveKey ?? itemKeys[0] ?? ''),
  );
  const fallbackKey = defaultActiveKey && itemKeys.includes(defaultActiveKey) ? defaultActiveKey : (itemKeys[0] ?? '');
  const resolvedActiveKey =
    activeKey !== undefined
      ? String(activeKey)
      : itemKeys.includes(internalActiveKey)
        ? internalActiveKey
        : fallbackKey;

  function handleChange(nextActiveKey: string) {
    if (activeKey === undefined) {
      setInternalActiveKey(nextActiveKey);
    }
    onChange?.(nextActiveKey);
  }

  const clickableItems = orderedItems.map((item) => {
    const key = String(item.key);
    const handleLabelMouseDown = (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      handleChange(key);
    };

    return {
      ...item,
      label: (
        <span onMouseDown={handleLabelMouseDown} onClick={handleLabelMouseDown}>
          {item.label}
        </span>
      ),
    };
  });

  return <Tabs {...props} activeKey={resolvedActiveKey} items={clickableItems} onChange={handleChange} />;
}

function normalizeNumberInput(value: number | null) {
  return value ?? 0;
}

function formatNumber(value: number) {
  return Number.isFinite(value) ? value.toFixed(3) : String(value);
}

function formatCoordinate(values: readonly number[]) {
  return `[${values.map(formatNumber).join(', ')}]`;
}

function renderInfoRow(label: string, value: React.ReactNode) {
  return (
    <Row wrap={false}>
      <Col flex="92px">
        <Text type="secondary">{label}:</Text>
      </Col>
      <Col flex="auto">
        {typeof value === 'string' || typeof value === 'number' ? <Text className="break-all">{value}</Text> : value}
      </Col>
    </Row>
  );
}

interface CameraSliderInputRowProps {
  label: string;
  min: number;
  max: number;
  step: number;
  precision?: number;
  value: number;
  onChange: (value: number | null) => void;
}

interface CameraNumberInputRowProps {
  label: string;
  min: number;
  max: number;
  step: number;
  precision: number;
  value: number;
  onChange: (value: number | null) => void;
}

function renderCameraNumberInputRow({ label, min, max, step, precision, value, onChange }: CameraNumberInputRowProps) {
  return (
    <div className="camera-view-control-row">
      <Text className="camera-view-control-label">{label}:</Text>
      <div className="camera-view-control-spacer" />
      <InputNumber<number>
        className="camera-view-control-input"
        size="small"
        precision={precision}
        min={min}
        max={max}
        value={value}
        step={step}
        keyboard={true}
        onChange={onChange}
      />
    </div>
  );
}

function renderCameraSliderInputRow({
  label,
  min,
  max,
  step,
  precision = 2,
  value,
  onChange,
}: CameraSliderInputRowProps) {
  return (
    <div className="camera-view-control-row">
      <Text className="camera-view-control-label">{label}:</Text>
      <Slider
        className="camera-view-control-slider"
        step={step}
        min={min}
        max={max}
        value={value}
        onChange={(nextValue) => onChange(nextValue)}
      />
      <InputNumber<number>
        className="camera-view-control-input"
        size="small"
        precision={precision}
        keyboard={true}
        step={step}
        min={min}
        max={max}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}

function getCameraZoomBounds(viewState: CameraView) {
  return {
    min: viewState.minZoom || 0,
    max: viewState.maxZoom || 15,
  };
}

function getCameraPitchBounds(viewState: CameraView) {
  return {
    min: viewState.minPitch || 0,
    max: viewState.maxPitch || 60,
  };
}

function getTargetInfo(camera: CameraMovement) {
  if (!isCameraTarget(camera.targetSnapshot)) {
    return {
      type: 'Legacy / unavailable',
      center: '-',
      bbox: '-',
    };
  }

  return {
    type: camera.targetSnapshot.type,
    center: formatCoordinate(camera.targetSnapshot.center),
    bbox: formatCoordinate(camera.targetSnapshot.bbox),
  };
}

function normalizeVisualizationParameterValue(
  parameter: VisualizationParameterConfig,
  value: VisualizationParameterValue | null,
) {
  if (parameter.control === 'switch') {
    return Boolean(value);
  }

  if (parameter.control === 'slider' || parameter.control === 'number') {
    return typeof value === 'number' ? value : Number(value ?? parameter.default);
  }

  return value ?? parameter.default;
}

export interface PanelConfigProps {
  animationPlaybackControlled?: boolean;
  onReleaseAnimationPlayback?: () => void;
  tutorialTab?: 'vis-config' | 'camera-config' | 'annotation-config';
  cameraMovementList: CameraMovement[];
  homeViews?: HomeViews;
  onStoryImport?: (cameras: CameraMovement[], homeViews?: HomeViews) => void;
  viewportSize?: ViewportSize;
  trajectoryEnabled?: boolean;
  currentCameraIndex: number;
  currentCameraPreviewIndex: number;
  isCurrentCameraPreviewPlaying: boolean;
  panelTimelineHeight: number;
  activeVisualizationId: string;
  visualizationCatalog: VisualizationCatalog;
  visualizationParams: VisualizationParameterValues;
  manualParameterKeys: readonly string[];
  visDatasetName: string;
  visDatasetFileName: string;
  onCameraMovementListChange: (cameraMovementList: CameraMovement[]) => void;
  onVisNameChange: (visName: string) => void;
  onVisualizationParamsChange: (params: VisualizationParameterValues, changedKey?: string) => void;
  onVisualizationParameterAutoReset: (parameterKey: string) => void;
  onExampleDatasetSelect: (params: VisualizationParameterValues) => void;
  onDatasetUpload: (file: File) => Promise<UploadedDatasetOverride | undefined>;
  onDataModalVisibleChange: (visible: boolean) => void;
  onCameraIndexChange: (index: number) => void;
  onCameraItemDelete: (index: number) => void;
  onCameraItemPlay: (cameraIndex: number) => void;
  onCameraItemReset: (cameraIndex: number) => void;
  onCameraItemEdit: (cameraIndex: number, cameraItem: CameraMovement) => void;
  onCameraItemViewStateEdit: (index: number) => void;
}

export interface PanelConfigState {
  cameraItemIndex: number;
  expandedCameraKeys: string[];
  isDatasetUploading: boolean;
}

class PanelConfig extends React.Component<PanelConfigProps, PanelConfigState> {
  constructor(props: PanelConfigProps) {
    super(props);
    this.handleVisNameSelectChange = this.handleVisNameSelectChange.bind(this);
    this.configTabCallback = this.configTabCallback.bind(this);
    this.handleVisualizationParameterChange = this.handleVisualizationParameterChange.bind(this);
    this.handleVisualizationMapStyleChange = this.handleVisualizationMapStyleChange.bind(this);
    this.handleDatasetSelectChange = this.handleDatasetSelectChange.bind(this);
    this.handleDatasetUpload = this.handleDatasetUpload.bind(this);
    this.popConfirm = this.popConfirm.bind(this);
    this.popCancel = this.popCancel.bind(this);
    this.handleCameraItemPlayButtonClick = this.handleCameraItemPlayButtonClick.bind(this);
    this.handleCameraItemResetButtonClick = this.handleCameraItemResetButtonClick.bind(this);
    this.handleEditViewStateButtonClick = this.handleEditViewStateButtonClick.bind(this);
    this.handleDurationChange = this.handleDurationChange.bind(this);
    this.handleStayChange = this.handleStayChange.bind(this);
    this.handleAnnotationDelayChange = this.handleAnnotationDelayChange.bind(this);
    this.handleAnnotationDurationChange = this.handleAnnotationDurationChange.bind(this);
    this.handleInitialLongitudeChange = this.handleInitialLongitudeChange.bind(this);
    this.handleInitialLatitudeChange = this.handleInitialLatitudeChange.bind(this);
    this.handleInitialZoomChange = this.handleInitialZoomChange.bind(this);
    this.handleInitialPitchChange = this.handleInitialPitchChange.bind(this);
    this.handleInitialBearingChange = this.handleInitialBearingChange.bind(this);
    this.handleFinalLongitudeChange = this.handleFinalLongitudeChange.bind(this);
    this.handleFinalLatitudeChange = this.handleFinalLatitudeChange.bind(this);
    this.handleFinalZoomChange = this.handleFinalZoomChange.bind(this);
    this.handleFinalPitchChange = this.handleFinalPitchChange.bind(this);
    this.handleFinalBearingChange = this.handleFinalBearingChange.bind(this);
    this.handleExportButtonClick = this.handleExportButtonClick.bind(this);
    this.handleCameraImport = this.handleCameraImport.bind(this);
    this.handleAnnotationChange = this.handleAnnotationChange.bind(this);

    this.state = {
      cameraItemIndex: -1,
      expandedCameraKeys: [],
      isDatasetUploading: false,
    };
  }

  handleVisNameSelectChange(value: string) {
    this.props.onVisNameChange(value);
  }

  configTabCallback(key: string) {
    if (key === 'example') {
      this.props.onExampleDatasetSelect({ ...this.props.visualizationParams });
    }
  }

  handleVisualizationParameterChange(
    parameter: VisualizationParameterConfig,
    value: VisualizationParameterValue | null,
  ) {
    this.props.onVisualizationParamsChange(
      {
        ...this.props.visualizationParams,
        [parameter.key]: normalizeVisualizationParameterValue(parameter, value),
      },
      parameter.key,
    );
  }

  handleVisualizationMapStyleChange(value: string) {
    this.props.onVisualizationParamsChange({
      ...this.props.visualizationParams,
      [VISUALIZATION_MAP_STYLE_PARAM_KEY]: value,
    });
  }

  handleDatasetSelectChange(value: string) {
    const visualization = this.getActiveVisualizationConfig();
    const datasetParamKey = visualization?.datasetParam;
    if (!visualization || !datasetParamKey) {
      return;
    }

    const datasetParameter = visualization.parameters?.find((parameter) => parameter.key === datasetParamKey);
    if (!datasetParameter) {
      return;
    }

    this.props.onExampleDatasetSelect({
      ...this.props.visualizationParams,
      [datasetParameter.key]: normalizeVisualizationParameterValue(datasetParameter, value),
    });
  }

  async handleDatasetUpload(file: File) {
    this.setState({ isDatasetUploading: true });
    try {
      const override = await this.props.onDatasetUpload(file);
      if (!override) {
        return;
      }

      const loadedRowCount = override.totalRowCount - override.skippedRowCount;
      if (override.skippedRowCount > 0) {
        message.warning(
          `Loaded ${loadedRowCount} rows from ${file.name}; skipped ${override.skippedRowCount} invalid rows.`,
        );
      } else {
        message.success(`Loaded ${loadedRowCount} rows from ${file.name}.`);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.setState({ isDatasetUploading: false });
    }
  }

  getActiveVisualizationConfig() {
    return this.props.visualizationCatalog.visualizations.find(
      (visualization) => visualization.id === this.props.activeVisualizationId,
    );
  }

  getActiveDatasetConfig() {
    const visualization = this.getActiveVisualizationConfig();
    if (!visualization) {
      return undefined;
    }
    const activeDatasetId = getActiveDatasetId(visualization, this.props.visualizationParams);
    return (
      this.props.visualizationCatalog.datasets.find((dataset) => dataset.id === activeDatasetId) ??
      this.props.visualizationCatalog.datasets.find((dataset) => dataset.id === visualization.datasetId)
    );
  }

  getVisualizationParameterValue(parameter: VisualizationParameterConfig) {
    return this.props.visualizationParams[parameter.key] ?? parameter.default;
  }

  getVisualizationMapStyleValue() {
    const value = this.props.visualizationParams[VISUALIZATION_MAP_STYLE_PARAM_KEY];
    const currentVisualization = this.getActiveVisualizationConfig();
    return typeof value === 'string' ? value : (currentVisualization?.mapStyle ?? '');
  }

  getVisualizationMapStyleOptions() {
    const options = new Set(
      this.props.visualizationCatalog.visualizations.map((visualization) => visualization.mapStyle),
    );
    const currentValue = this.getVisualizationMapStyleValue();
    if (currentValue) {
      options.add(currentValue);
    }
    return Array.from(options).sort(
      (a, b) => Number(b === 'carto.darkNoLabels') - Number(a === 'carto.darkNoLabels') || a.localeCompare(b),
    );
  }

  renderVisualizationSettingRow(label: string, control: React.ReactNode, key: string) {
    return (
      <div className="visualization-setting-row" key={key}>
        <Text className="visualization-setting-label">{label}:</Text>
        <div className="visualization-setting-control">{control}</div>
      </div>
    );
  }

  renderVisualizationMapStyleControl() {
    const currentVisualization = this.getActiveVisualizationConfig();
    const mapStyleValue = this.getVisualizationMapStyleValue();

    return (
      <Select
        size="small"
        className="w-full"
        placeholder="Select a map style"
        value={mapStyleValue || undefined}
        disabled={!currentVisualization}
        onChange={this.handleVisualizationMapStyleChange}>
        {this.getVisualizationMapStyleOptions().map((mapStyle) => (
          <Option key={mapStyle} value={mapStyle} title={mapStyle}>
            {mapStyle}
          </Option>
        ))}
      </Select>
    );
  }

  renderVisualizationParameterControl(parameter: VisualizationParameterConfig, { disabled = false } = {}) {
    const value = this.getVisualizationParameterValue(parameter);

    if (parameter.control === 'switch') {
      return (
        <Switch
          size="small"
          aria-label={parameter.label}
          disabled={disabled}
          checked={Boolean(value)}
          onChange={(checked) => this.handleVisualizationParameterChange(parameter, checked)}
        />
      );
    }

    if (parameter.control === 'select') {
      return (
        <Select
          size="small"
          className="w-full"
          aria-label={parameter.label}
          disabled={disabled}
          value={value}
          optionLabelProp="label"
          onChange={(nextValue) => this.handleVisualizationParameterChange(parameter, nextValue)}>
          {(parameter.options ?? []).map((option) => (
            <Option key={String(option.value)} value={option.value} label={option.label}>
              {option.label}
              {option.description && ` - ${option.description}`}
            </Option>
          ))}
        </Select>
      );
    }

    if (parameter.control === 'number') {
      return (
        <InputNumber<number>
          className="w-full"
          size="small"
          min={parameter.min}
          max={parameter.max}
          step={parameter.step}
          precision={parameter.precision}
          value={Number(value)}
          onChange={(nextValue) => this.handleVisualizationParameterChange(parameter, nextValue)}
        />
      );
    }

    return (
      <Slider
        className="visualization-parameter-slider"
        min={parameter.min}
        max={parameter.max}
        step={parameter.step}
        value={Number(value)}
        onChange={(nextValue) => this.handleVisualizationParameterChange(parameter, nextValue)}
      />
    );
  }

  renderVisualizationParameterSetting(
    parameter: VisualizationParameterConfig,
    adaptiveParameterKeys: Set<string>,
    disabled = false,
  ) {
    const canResetToAuto =
      adaptiveParameterKeys.has(parameter.key) && this.props.manualParameterKeys.includes(parameter.key);
    return this.renderVisualizationSettingRow(
      parameter.label,
      <div className="visualization-setting-control-with-action">
        {this.renderVisualizationParameterControl(parameter, { disabled })}
        {canResetToAuto && (
          <Button
            type="link"
            size="small"
            className="visualization-setting-auto"
            onClick={() => this.props.onVisualizationParameterAutoReset(parameter.key)}>
            Auto
          </Button>
        )}
      </div>,
      parameter.key,
    );
  }

  popConfirm(
    event: React.MouseEvent<HTMLElement, MouseEvent> | undefined,
    cameraIndex = this.props.currentCameraIndex,
  ) {
    if (event) {
      event.stopPropagation();
    }
    if (cameraIndex !== -1) {
      this.props.onCameraItemDelete(cameraIndex);
    }
  }

  popCancel(event: React.MouseEvent<HTMLElement, MouseEvent> | undefined) {
    if (event) {
      event.stopPropagation();
    }
  }

  handleCameraItemPlayButtonClick(event: React.MouseEvent<HTMLButtonElement>) {
    const cameraIndex = Number(event.currentTarget.value);
    this.props.onCameraItemPlay(cameraIndex);
  }

  handleCameraItemResetButtonClick(event: React.MouseEvent<HTMLButtonElement>) {
    const cameraIndex = Number(event.currentTarget.value);
    this.props.onCameraItemReset(cameraIndex);
  }

  handleEditViewStateButtonClick(cameraIndex: number) {
    this.props.onCameraItemViewStateEdit(cameraIndex);
  }

  updateCameraAtIndex(cameraIndex: number, updateCamera: (camera: CameraMovement) => void) {
    const current = this.props.cameraMovementList[cameraIndex];
    if (!current) {
      return;
    }

    let cameraMovement = _.cloneDeep(current);
    updateCamera(cameraMovement);
    for (const [key, field] of [
      ['initial', 'initViewState'],
      ['final', 'finalViewState'],
    ] as const) {
      if (
        !_.isEqual(normalizeCameraAuthoringView(current[field]), normalizeCameraAuthoringView(cameraMovement[field]))
      ) {
        cameraMovement = recordCameraManualView(cameraMovement, key, cameraMovement[field]);
      }
    }
    this.props.onCameraItemEdit(cameraIndex, cameraMovement);
  }

  handleDurationChange(value: number | null, cameraIndex = this.props.currentCameraIndex) {
    this.updateCameraAtIndex(cameraIndex, (camera) => {
      camera.duration = normalizeNumberInput(value);
    });
  }

  handleStayChange(value: number | null, cameraIndex = this.props.currentCameraIndex) {
    this.updateCameraAtIndex(cameraIndex, (camera) => {
      camera.stay = normalizeNumberInput(value);
    });
  }

  handleAnnotationDelayChange(value: number | null, cameraIndex = this.props.currentCameraIndex) {
    this.updateCameraAtIndex(cameraIndex, (camera) => {
      camera.annotation = {
        duration: camera.duration + camera.stay,
        text: '',
        ...camera.annotation,
        delay: normalizeNumberInput(value),
      };
    });
  }

  handleAnnotationDurationChange(value: number | null, cameraIndex = this.props.currentCameraIndex) {
    this.updateCameraAtIndex(cameraIndex, (camera) => {
      camera.annotation = {
        delay: 0,
        text: '',
        ...camera.annotation,
        duration: normalizeNumberInput(value),
      };
    });
  }

  handleInitialLongitudeChange(cameraIndex: number, value: number | null) {
    value = normalizeNumberInput(value);
    this.updateCameraAtIndex(cameraIndex, (cameraMovement) => {
      cameraMovement['initViewState']['longitude'] = value;
    });
  }

  handleInitialLatitudeChange(cameraIndex: number, value: number | null) {
    value = normalizeNumberInput(value);
    this.updateCameraAtIndex(cameraIndex, (cameraMovement) => {
      cameraMovement['initViewState']['latitude'] = value;
    });
  }

  handleInitialZoomChange(cameraIndex: number, value: number | null) {
    value = normalizeNumberInput(value);
    this.updateCameraAtIndex(cameraIndex, (cameraMovement) => {
      cameraMovement['initViewState']['zoom'] = value;
    });
  }

  handleInitialPitchChange(cameraIndex: number, value: number | null) {
    value = normalizeNumberInput(value);
    this.updateCameraAtIndex(cameraIndex, (cameraMovement) => {
      cameraMovement['initViewState']['pitch'] = value;
    });
  }

  handleInitialBearingChange(cameraIndex: number, value: number | null) {
    value = normalizeNumberInput(value);
    this.updateCameraAtIndex(cameraIndex, (cameraMovement) => {
      cameraMovement['initViewState']['bearing'] = value;
    });
  }

  handleFinalLongitudeChange(cameraIndex: number, value: number | null) {
    value = normalizeNumberInput(value);
    this.updateCameraAtIndex(cameraIndex, (cameraMovement) => {
      cameraMovement['finalViewState']['longitude'] = value;
    });
  }

  handleFinalLatitudeChange(cameraIndex: number, value: number | null) {
    value = normalizeNumberInput(value);
    this.updateCameraAtIndex(cameraIndex, (cameraMovement) => {
      cameraMovement['finalViewState']['latitude'] = value;
    });
  }

  handleFinalZoomChange(cameraIndex: number, value: number | null) {
    value = normalizeNumberInput(value);
    this.updateCameraAtIndex(cameraIndex, (cameraMovement) => {
      cameraMovement['finalViewState']['zoom'] = value;
    });
  }

  handleFinalPitchChange(cameraIndex: number, value: number | null) {
    value = normalizeNumberInput(value);
    this.updateCameraAtIndex(cameraIndex, (cameraMovement) => {
      cameraMovement['finalViewState']['pitch'] = value;
    });
  }

  handleFinalBearingChange(cameraIndex: number, value: number | null) {
    value = normalizeNumberInput(value);
    this.updateCameraAtIndex(cameraIndex, (cameraMovement) => {
      cameraMovement['finalViewState']['bearing'] = value;
    });
  }

  handleExportButtonClick() {
    const cameraList = this.props.cameraMovementList;
    if (_.isEmpty(cameraList) && _.isEmpty(this.props.homeViews)) return;
    try {
      const blob = new Blob(
        [
          JSON.stringify(
            createStoryJson(cameraList, {
              content: 'playback',
              trajectoryEnabled: this.props.trajectoryEnabled ?? false,
              viewport: this.props.viewportSize,
              homeViews: this.props.homeViews,
            }),
            null,
            2,
          ),
        ],
        {
          type: 'application/json',
        },
      );
      FileSaver.saveAs(blob, 'geo-camera-story.json');
    } catch (error: unknown) {
      message.error(`Could not export story: ${error instanceof Error ? error.message : 'Invalid camera data.'}`);
    }
  }

  handleCameraImport(file: File) {
    getUploadResult(file, (jsonStringResult: string) => {
      let importJson: unknown;
      try {
        importJson = JSON.parse(jsonStringResult);
      } catch {
        message.error('Invalid JSON file.');
        return;
      }
      const importResult = parseStoryJson(importJson, { viewport: this.props.viewportSize });
      if (importResult.ok) {
        if (this.props.onStoryImport) this.props.onStoryImport(importResult.cameras, importResult.homeViews);
        else this.props.onCameraMovementListChange(importResult.cameras);
        this.setState({ expandedCameraKeys: importResult.cameras.length > 0 ? ['panel-0'] : [] });
        message.success(`${file.name} imported successfully.`);
        if (importResult.legacy) {
          message.info('Imported legacy camera array. Future exports use story JSON.');
        }
        return;
      }

      if (importResult.reason === 'timeline-json') {
        message.error(
          'Location/timeline files do not contain complete camera views or annotation text. Import the matching camera export or Story JSON.',
        );
        return;
      }

      message.error('Invalid story/camera JSON file.');
    });
    return false;
  }

  handleAnnotationChange(e: React.ChangeEvent<HTMLTextAreaElement>, cameraIndex = this.props.currentCameraIndex) {
    const text = e.target.value;
    this.updateCameraAtIndex(cameraIndex, (camera) => {
      camera.annotation = {
        delay: 0,
        duration: camera.duration + camera.stay,
        ...camera.annotation,
        text,
      };
    });
  }

  render() {
    const { cameraMovementList: cameraList, activeVisualizationId, currentCameraIndex } = this.props;
    const currentCameraItem = cameraList[currentCameraIndex];
    const isCurrentCameraPreviewPlaying =
      this.props.currentCameraPreviewIndex === currentCameraIndex && this.props.isCurrentCameraPreviewPlaying;
    const currentVisualization = this.getActiveVisualizationConfig();
    const currentDataset = this.getActiveDatasetConfig();
    const datasetParameter =
      currentVisualization?.datasetParam && currentVisualization.parameters
        ? currentVisualization.parameters.find((parameter) => parameter.key === currentVisualization.datasetParam)
        : undefined;
    const datasetOptions = datasetParameter?.control === 'select' ? (datasetParameter.options ?? []) : [];
    const isDatasetSelectable = Boolean(currentVisualization?.datasetParam) && datasetOptions.length > 0;
    const animationEnabledParameter = currentVisualization?.parameters?.find(
      (parameter) => parameter.key === currentVisualization.animation?.enabledParam && parameter.control === 'switch',
    );
    const animationSpeedParameter = animationEnabledParameter
      ? currentVisualization?.parameters?.find(
          (parameter) => parameter.key === currentVisualization.animation?.speedParam && parameter.control === 'select',
        )
      : undefined;
    const visualizationParameters = (currentVisualization?.parameters ?? []).filter(
      (parameter) => parameter.key !== currentVisualization?.datasetParam,
    );
    const adaptiveParameterKeys = new Set(
      currentVisualization ? getAdaptiveVisualizationParameterKeys(currentVisualization) : [],
    );
    const targetInfo = currentCameraItem ? getTargetInfo(currentCameraItem) : undefined;

    return (
      <Card id="card-config" className="h-full" size="small">
        <CompatTabs
          id="tabs-config"
          type="card"
          className=""
          defaultActiveKey="vis-config"
          activeKey={this.props.tutorialTab}
          itemOrder={['camera-config', 'annotation-config', 'vis-config']}>
          <TabPane id="tab-camera-list" tab="Camera" key="camera-config">
            <CompatTabs className="-mt-4!" defaultActiveKey="camera-all">
              <TabPane
                tab="Current Camera"
                key="camera-current"
                className="overflow-y-auto"
                style={{ height: `calc(100vh - ${this.props.panelTimelineHeight}px - 192px)` }}>
                {currentCameraItem && targetInfo && (
                  <Space direction="vertical" size={4} className="w-full">
                    <Space>
                      <Tooltip title={isCurrentCameraPreviewPlaying ? 'Pause camera preview' : 'Play camera preview'}>
                        <Button
                          aria-label={
                            isCurrentCameraPreviewPlaying
                              ? 'Pause current camera preview'
                              : 'Play current camera preview'
                          }
                          size="small"
                          icon={isCurrentCameraPreviewPlaying ? <PauseOutlined /> : <CaretRightOutlined />}
                          value={currentCameraIndex}
                          onClick={this.handleCameraItemPlayButtonClick}
                        />
                      </Tooltip>
                      <Tooltip title="Reset preview to camera initial state">
                        <Button
                          aria-label="Reset current camera preview"
                          size="small"
                          icon={<StepBackwardOutlined />}
                          value={currentCameraIndex}
                          onClick={this.handleCameraItemResetButtonClick}
                        />
                      </Tooltip>
                      <Text>{`${currentCameraIndex + 1}:`}</Text>
                      <Text>{`[${currentCameraItem['title']}]`}</Text>
                    </Space>
                    <Divider className="my-0!" plain={true}>
                      <Text className="font-bold!">Timing</Text>
                    </Divider>
                    <Row wrap={false}>
                      <Col flex="75px">
                        <Text>Duration:</Text>
                      </Col>
                      <Col flex="auto">
                        <InputNumber<number>
                          className="float-right w-5/6"
                          size="small"
                          min={0}
                          value={currentCameraItem['duration']}
                          step={100}
                          keyboard={true}
                          formatter={(value) => `${value}ms`}
                          parser={(value) => {
                            if (value) {
                              return Number(value?.replace('ms', ''));
                            } else {
                              return 0;
                            }
                          }}
                          onChange={this.handleDurationChange}
                        />
                      </Col>
                    </Row>
                    <Row wrap={false}>
                      <Col flex="75px">
                        <Text>Stay:</Text>
                      </Col>
                      <Col flex="auto">
                        <InputNumber<number>
                          className="float-right w-5/6"
                          size="small"
                          min={0}
                          value={currentCameraItem['stay']}
                          step={100}
                          keyboard={true}
                          formatter={(value) => `${value}ms`}
                          parser={(value) => {
                            if (value) {
                              return Number(value?.replace('ms', ''));
                            } else {
                              return 0;
                            }
                          }}
                          onChange={this.handleStayChange}
                        />
                      </Col>
                    </Row>
                    <Text type="secondary">Shots connect automatically.</Text>
                    <Divider className="my-0!" plain={true}>
                      <Text className="font-bold!">View State</Text>
                    </Divider>
                    <Button
                      block={true}
                      size="small"
                      onClick={() => this.handleEditViewStateButtonClick(currentCameraIndex)}>
                      Edit View State
                    </Button>
                    <CompatTabs className="-mt-2!" key={`tabs-view-state`}>
                      <TabPane key={`tab-init`} tab="Initial State">
                        <Space direction="vertical" size={4} className="w-full">
                          {renderCameraNumberInputRow({
                            label: 'Longitude',
                            min: -180,
                            max: 180,
                            step: 0.1,
                            precision: 2,
                            value: currentCameraItem['initViewState']['longitude'],
                            onChange: (value) => this.handleInitialLongitudeChange(currentCameraIndex, value),
                          })}
                          {renderCameraNumberInputRow({
                            label: 'Latitude',
                            min: -90,
                            max: 90,
                            step: 0.1,
                            precision: 2,
                            value: currentCameraItem['initViewState']['latitude'],
                            onChange: (value) => this.handleInitialLatitudeChange(currentCameraIndex, value),
                          })}
                          {renderCameraSliderInputRow({
                            label: 'Zoom',
                            ...getCameraZoomBounds(currentCameraItem['initViewState']),
                            step: 0.1,
                            value: currentCameraItem['initViewState']['zoom'],
                            onChange: (value) => this.handleInitialZoomChange(currentCameraIndex, value),
                          })}
                          {renderCameraSliderInputRow({
                            label: 'Pitch',
                            ...getCameraPitchBounds(currentCameraItem['initViewState']),
                            step: 0.1,
                            value: currentCameraItem['initViewState']['pitch'],
                            onChange: (value) => this.handleInitialPitchChange(currentCameraIndex, value),
                          })}
                          {renderCameraSliderInputRow({
                            label: 'Bearing',
                            min: -360,
                            max: 360,
                            step: 1,
                            value: currentCameraItem['initViewState']['bearing'],
                            onChange: (value) => this.handleInitialBearingChange(currentCameraIndex, value),
                          })}
                        </Space>
                      </TabPane>
                      <TabPane key={`tab-final`} tab="Final State">
                        <Space direction="vertical" size={4} className="w-full">
                          {renderCameraNumberInputRow({
                            label: 'Longitude',
                            min: -180,
                            max: 180,
                            step: 0.1,
                            precision: 2,
                            value: currentCameraItem['finalViewState']['longitude'],
                            onChange: (value) => this.handleFinalLongitudeChange(currentCameraIndex, value),
                          })}
                          {renderCameraNumberInputRow({
                            label: 'Latitude',
                            min: -90,
                            max: 90,
                            step: 0.1,
                            precision: 2,
                            value: currentCameraItem['finalViewState']['latitude'],
                            onChange: (value) => this.handleFinalLatitudeChange(currentCameraIndex, value),
                          })}
                          {renderCameraSliderInputRow({
                            label: 'Zoom',
                            ...getCameraZoomBounds(currentCameraItem['finalViewState']),
                            step: 0.1,
                            value: currentCameraItem['finalViewState']['zoom'],
                            onChange: (value) => this.handleFinalZoomChange(currentCameraIndex, value),
                          })}
                          {renderCameraSliderInputRow({
                            label: 'Pitch',
                            ...getCameraPitchBounds(currentCameraItem['finalViewState']),
                            step: 0.1,
                            value: currentCameraItem['finalViewState']['pitch'],
                            onChange: (value) => this.handleFinalPitchChange(currentCameraIndex, value),
                          })}
                          {renderCameraSliderInputRow({
                            label: 'Bearing',
                            min: -360,
                            max: 360,
                            step: 1,
                            value: currentCameraItem['finalViewState']['bearing'],
                            onChange: (value) => this.handleFinalBearingChange(currentCameraIndex, value),
                          })}
                        </Space>
                      </TabPane>
                    </CompatTabs>
                    <Divider className="my-0!" plain={true}>
                      <Text className="font-bold!">Target</Text>
                    </Divider>
                    <Space direction="vertical" size={2} className="w-full">
                      {renderInfoRow('Type', targetInfo.type)}
                      {renderInfoRow('Center', targetInfo.center)}
                      {renderInfoRow('BBox', targetInfo.bbox)}
                    </Space>
                  </Space>
                )}
              </TabPane>
              <TabPane
                tab="All Cameras"
                key="camera-all"
                className="overflow-y-auto"
                style={{ height: `calc(100vh - ${this.props.panelTimelineHeight}px - 192px)` }}>
                <Space direction="vertical" className="w-full">
                  <div className="story-file-actions">
                    <div className="story-file-import">
                      <Upload
                        name="cameraFile"
                        accept=".json,application/json"
                        showUploadList={false}
                        beforeUpload={this.handleCameraImport}>
                        <Button block size="small" type="default" icon={<ImportOutlined className="text-xs" />}>
                          Import Story
                        </Button>
                      </Upload>
                    </div>
                    <Button
                      block
                      size="small"
                      type="default"
                      icon={<ExportOutlined className="text-xs" />}
                      onClick={this.handleExportButtonClick}>
                      Export Story
                    </Button>
                    <Tooltip
                      title="Story files include camera views, scene home views, saved targets and annotation text/timing. Playback uses the current visualization and dataset."
                      trigger={['hover', 'focus', 'click']}>
                      <Button size="small" type="text" aria-label="About story files" icon={<InfoCircleOutlined />} />
                    </Tooltip>
                  </div>
                  <Divider className="my-1!" />
                  {cameraList.length > 0 && (
                    <Collapse
                      bordered={true}
                      className="overflow-y-auto bg-white!"
                      activeKey={this.state.expandedCameraKeys}
                      onChange={(keys) => this.setState({ expandedCameraKeys: Array.isArray(keys) ? keys : [keys] })}>
                      {cameraList.map((cameraItem, cameraIndex) => {
                        return (
                          <Panel
                            className={`camera-item-panel${currentCameraIndex === cameraIndex ? 'camera-item-panel-selected' : ''}`}
                            collapsible="icon"
                            header={
                              <button
                                type="button"
                                className="camera-item-select"
                                aria-pressed={currentCameraIndex === cameraIndex}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  this.props.onCameraIndexChange(cameraIndex);
                                }}>
                                <span>{`C${cameraIndex + 1}: [${cameraItem['title']}]`}</span>
                                {currentCameraIndex === cameraIndex && (
                                  <span className="camera-item-selected-label">Selected</span>
                                )}
                              </button>
                            }
                            key={`panel-${cameraIndex}`}
                            forceRender={true}
                            extra={
                              <Popconfirm
                                placement="topRight"
                                title="Are you sure to delete this camera?"
                                onConfirm={(event) => this.popConfirm(event, cameraIndex)}
                                onCancel={this.popCancel}
                                okText="Yes"
                                cancelText="No"
                                icon={<QuestionCircleTwoTone />}>
                                <Button
                                  size="small"
                                  type="text"
                                  icon={<DeleteOutlined />}
                                  onClick={(event: React.MouseEvent<HTMLElement>) => {
                                    event.stopPropagation();
                                  }}
                                />
                              </Popconfirm>
                            }>
                            <Space direction="vertical" size={4} className="w-full">
                              <Space>
                                <Button
                                  size="small"
                                  icon={<CaretRightOutlined />}
                                  value={cameraIndex}
                                  onClick={this.handleCameraItemPlayButtonClick}
                                />
                                <Text className="w-full">{`[${cameraItem['name']}]`}</Text>
                              </Space>
                              <Divider className="my-0!" plain={true}>
                                <Text className="font-bold!">Timing</Text>
                              </Divider>
                              <Row wrap={false}>
                                <Col flex="75px">
                                  <Text>Duration:</Text>
                                </Col>
                                <Col flex="auto">
                                  <InputNumber<number>
                                    className="float-right w-5/6"
                                    size="small"
                                    min={0}
                                    value={cameraItem['duration']}
                                    step={100}
                                    keyboard={true}
                                    formatter={(value) => `${value}ms`}
                                    parser={(value) => {
                                      if (value) {
                                        return Number(value?.replace('ms', ''));
                                      } else {
                                        return 0;
                                      }
                                    }}
                                    onChange={(value) => this.handleDurationChange(value, cameraIndex)}
                                  />
                                </Col>
                              </Row>
                              <Row wrap={false}>
                                <Col flex="75px">
                                  <Text>Stay:</Text>
                                </Col>
                                <Col flex="auto">
                                  <InputNumber<number>
                                    className="float-right w-5/6"
                                    size="small"
                                    min={0}
                                    value={cameraItem['stay']}
                                    step={100}
                                    keyboard={true}
                                    formatter={(value) => `${value}ms`}
                                    parser={(value) => {
                                      if (value) {
                                        return Number(value?.replace('ms', ''));
                                      } else {
                                        return 0;
                                      }
                                    }}
                                    onChange={(value) => this.handleStayChange(value, cameraIndex)}
                                  />
                                </Col>
                              </Row>
                              <Text type="secondary">Shots connect automatically.</Text>
                              <Divider className="my-0!" plain={true}>
                                <Text className="font-bold!">View State</Text>
                              </Divider>
                              <Button
                                block={true}
                                size="small"
                                onClick={() => this.handleEditViewStateButtonClick(cameraIndex)}>
                                Edit View State
                              </Button>
                              <CompatTabs className="-mt-2!" key={`tabs-${cameraIndex}`}>
                                <TabPane key={`tab-init-${cameraIndex}`} tab="Initial State">
                                  <Space direction="vertical" size={4} className="w-full">
                                    {renderCameraNumberInputRow({
                                      label: 'Longitude',
                                      min: -180,
                                      max: 180,
                                      step: 0.1,
                                      precision: 2,
                                      value: cameraItem['initViewState']['longitude'],
                                      onChange: (value) => this.handleInitialLongitudeChange(cameraIndex, value),
                                    })}
                                    {renderCameraNumberInputRow({
                                      label: 'Latitude',
                                      min: -90,
                                      max: 90,
                                      step: 0.1,
                                      precision: 2,
                                      value: cameraItem['initViewState']['latitude'],
                                      onChange: (value) => this.handleInitialLatitudeChange(cameraIndex, value),
                                    })}
                                    {renderCameraSliderInputRow({
                                      label: 'Zoom',
                                      ...getCameraZoomBounds(cameraItem['initViewState']),
                                      step: 0.1,
                                      value: cameraItem['initViewState']['zoom'],
                                      onChange: (value) => this.handleInitialZoomChange(cameraIndex, value),
                                    })}
                                    {renderCameraSliderInputRow({
                                      label: 'Pitch',
                                      ...getCameraPitchBounds(cameraItem['initViewState']),
                                      step: 0.1,
                                      value: cameraItem['initViewState']['pitch'],
                                      onChange: (value) => this.handleInitialPitchChange(cameraIndex, value),
                                    })}
                                    {renderCameraSliderInputRow({
                                      label: 'Bearing',
                                      min: -360,
                                      max: 360,
                                      step: 1,
                                      value: cameraItem['initViewState']['bearing'],
                                      onChange: (value) => this.handleInitialBearingChange(cameraIndex, value),
                                    })}
                                  </Space>
                                </TabPane>
                                <TabPane key={`tab-final-${cameraIndex}`} tab="Final State">
                                  <Space direction="vertical" size={4} className="w-full">
                                    {renderCameraNumberInputRow({
                                      label: 'Longitude',
                                      min: -180,
                                      max: 180,
                                      step: 0.1,
                                      precision: 2,
                                      value: cameraItem['finalViewState']['longitude'],
                                      onChange: (value) => this.handleFinalLongitudeChange(cameraIndex, value),
                                    })}
                                    {renderCameraNumberInputRow({
                                      label: 'Latitude',
                                      min: -90,
                                      max: 90,
                                      step: 0.1,
                                      precision: 2,
                                      value: cameraItem['finalViewState']['latitude'],
                                      onChange: (value) => this.handleFinalLatitudeChange(cameraIndex, value),
                                    })}
                                    {renderCameraSliderInputRow({
                                      label: 'Zoom',
                                      ...getCameraZoomBounds(cameraItem['finalViewState']),
                                      step: 0.1,
                                      value: cameraItem['finalViewState']['zoom'],
                                      onChange: (value) => this.handleFinalZoomChange(cameraIndex, value),
                                    })}
                                    {renderCameraSliderInputRow({
                                      label: 'Pitch',
                                      ...getCameraPitchBounds(cameraItem['finalViewState']),
                                      step: 0.1,
                                      value: cameraItem['finalViewState']['pitch'],
                                      onChange: (value) => this.handleFinalPitchChange(cameraIndex, value),
                                    })}
                                    {renderCameraSliderInputRow({
                                      label: 'Bearing',
                                      min: -360,
                                      max: 360,
                                      step: 1,
                                      value: cameraItem['finalViewState']['bearing'],
                                      onChange: (value) => this.handleFinalBearingChange(cameraIndex, value),
                                    })}
                                  </Space>
                                </TabPane>
                              </CompatTabs>
                            </Space>
                          </Panel>
                        );
                      })}
                    </Collapse>
                  )}
                </Space>
              </TabPane>
            </CompatTabs>
          </TabPane>
          <TabPane tab="Annotation" key="annotation-config">
            <CompatTabs className="-mt-4!" defaultActiveKey="annotation-current">
              <TabPane
                tab="Current Annotation"
                key="annotation-current"
                className="overflow-y-auto"
                style={{ height: `calc(100vh - ${this.props.panelTimelineHeight}px - 192px)` }}>
                {currentCameraItem && (
                  <Space direction="vertical" size={4} className="w-full">
                    <Space>
                      <Text>{`Annotation-${currentCameraIndex + 1}:`}</Text>
                      <Text>{`[${currentCameraItem['title']}]`}</Text>
                    </Space>
                    <Divider className="my-0!" plain={true}>
                      <Text className="font-bold!">Timing</Text>
                    </Divider>
                    <Text type="secondary" className="text-xs!">
                      Delay starts with this camera. Text ends when its duration or the camera ends; 0 ms hides it.
                    </Text>
                    <Row wrap={false}>
                      <Col flex="75px">
                        <Text>Delay:</Text>
                      </Col>
                      <Col flex="auto">
                        <InputNumber<number>
                          className="float-right w-5/6"
                          size="small"
                          min={0}
                          max={currentCameraItem['stay'] + currentCameraItem['duration']}
                          value={currentCameraItem['annotation'] ? currentCameraItem['annotation']['delay'] : 0}
                          step={100}
                          keyboard={true}
                          formatter={(value) => `${value}ms`}
                          parser={(value) => {
                            if (value) {
                              return Number(value?.replace('ms', ''));
                            } else {
                              return 0;
                            }
                          }}
                          onChange={this.handleAnnotationDelayChange}
                        />
                      </Col>
                    </Row>
                    <Row wrap={false}>
                      <Col flex="75px">
                        <Text>Duration:</Text>
                      </Col>
                      <Col flex="auto">
                        <InputNumber<number>
                          className="float-right w-5/6"
                          size="small"
                          min={0}
                          max={currentCameraItem['stay'] + currentCameraItem['duration']}
                          value={
                            currentCameraItem['annotation']
                              ? currentCameraItem['annotation']['duration']
                              : currentCameraItem['stay'] + currentCameraItem['duration']
                          }
                          step={100}
                          keyboard={true}
                          formatter={(value) => `${value}ms`}
                          parser={(value) => {
                            if (value) {
                              return Number(value?.replace('ms', ''));
                            } else {
                              return 0;
                            }
                          }}
                          onChange={this.handleAnnotationDurationChange}
                        />
                      </Col>
                    </Row>
                    <Divider className="my-0!" plain={true}>
                      <Text className="font-bold!">Text</Text>
                    </Divider>
                    <TextArea
                      style={{
                        maxHeight: `calc(100vh - ${this.props.panelTimelineHeight}px - 155px)`,
                      }}
                      className="w-full"
                      rows={8}
                      value={currentCameraItem['annotation'] ? currentCameraItem['annotation']['text'] : ''}
                      onChange={this.handleAnnotationChange}
                    />
                    <Divider className="my-0!" plain={true}>
                      <Text className="font-bold!">Shape</Text>
                    </Divider>
                    <Button size="small" icon={<BlockOutlined className="relative -top-1! text-xs" />}>
                      Draw shapes
                    </Button>
                  </Space>
                )}
              </TabPane>
              <TabPane
                tab="All Annotations"
                key="annotation-all"
                className="overflow-y-auto"
                style={{ height: `calc(100vh - ${this.props.panelTimelineHeight}px - 192px)` }}>
                <Space direction="vertical" className="w-full">
                  {cameraList.length > 0 && (
                    <Collapse bordered={true} className="overflow-y-auto bg-white!">
                      {cameraList.map((cameraItem, cameraIndex) => {
                        return (
                          <Panel
                            className="annotation-item-panel"
                            header={`A${cameraIndex + 1}: [${cameraItem['title']}]`}
                            key={`panel-${cameraIndex}`}
                            forceRender={true}>
                            <Space direction="vertical" size={4} className="w-full">
                              <Space>
                                <Text className="w-full">{`Annotation of [${cameraItem['name']}]`}</Text>
                              </Space>
                              <Divider className="my-0!" plain={true}>
                                <Text className="font-bold!">Timing</Text>
                              </Divider>
                              <Row wrap={false}>
                                <Col flex="75px">
                                  <Text>Delay:</Text>
                                </Col>
                                <Col flex="auto">
                                  <InputNumber<number>
                                    className="float-right w-5/6"
                                    size="small"
                                    min={0}
                                    max={cameraItem['stay'] + cameraItem['duration']}
                                    value={cameraItem['annotation'] ? cameraItem['annotation']['delay'] : 0}
                                    step={100}
                                    keyboard={true}
                                    formatter={(value) => `${value}ms`}
                                    parser={(value) => {
                                      if (value) {
                                        return Number(value?.replace('ms', ''));
                                      } else {
                                        return 0;
                                      }
                                    }}
                                    onChange={(value) => this.handleAnnotationDelayChange(value, cameraIndex)}
                                  />
                                </Col>
                              </Row>
                              <Row wrap={false}>
                                <Col flex="75px">
                                  <Text>Duration:</Text>
                                </Col>
                                <Col flex="auto">
                                  <InputNumber<number>
                                    className="float-right w-5/6"
                                    size="small"
                                    min={0}
                                    max={cameraItem['stay'] + cameraItem['duration']}
                                    value={
                                      cameraItem['annotation']
                                        ? cameraItem['annotation']['duration']
                                        : cameraItem['stay'] + cameraItem['duration']
                                    }
                                    step={100}
                                    keyboard={true}
                                    formatter={(value) => `${value}ms`}
                                    parser={(value) => {
                                      if (value) {
                                        return Number(value?.replace('ms', ''));
                                      } else {
                                        return 0;
                                      }
                                    }}
                                    onChange={(value) => this.handleAnnotationDurationChange(value, cameraIndex)}
                                  />
                                </Col>
                              </Row>
                              <Divider className="my-0!" plain={true}>
                                <Text className="font-bold!">Text</Text>
                              </Divider>
                              <TextArea
                                style={{
                                  maxHeight: `calc(100vh - ${this.props.panelTimelineHeight}px - 155px)`,
                                }}
                                className="w-full"
                                rows={8}
                                value={cameraItem['annotation'] ? cameraItem['annotation']['text'] : ''}
                                onChange={(event) => this.handleAnnotationChange(event, cameraIndex)}
                              />
                            </Space>
                          </Panel>
                        );
                      })}
                    </Collapse>
                  )}
                </Space>
              </TabPane>
            </CompatTabs>
          </TabPane>
          <TabPane
            tab="Visualization"
            key="vis-config"
            className="overflow-y-auto"
            style={{ height: `calc(100vh - ${this.props.panelTimelineHeight}px - 134px)` }}>
            <Divider className="mt-0!" orientation="left">
              Visualization Types
            </Divider>
            <Select
              value={activeVisualizationId}
              className="w-full"
              size="small"
              onChange={this.handleVisNameSelectChange}>
              {this.props.visualizationCatalog.visualizations.map((visualization) => (
                <Option
                  key={visualization.id}
                  value={visualization.id}
                  aria-label={`${visualization.title}${TEST_VISUALIZATION_IDS.has(visualization.id) ? ' — Test' : ''}`}
                  title={`${visualization.title}${TEST_VISUALIZATION_IDS.has(visualization.id) ? ' — Test' : ''}`}>
                  <span
                    className={[
                      'visualization-option-label',
                      TEST_VISUALIZATION_IDS.has(visualization.id) ? 'visualization-option-test' : '',
                    ].join(' ')}>
                    <span className="visualization-option-title">{visualization.title}</span>
                    {TEST_VISUALIZATION_IDS.has(visualization.id) && (
                      <span className="visualization-test-badge">Test</span>
                    )}
                  </span>
                </Option>
              ))}
            </Select>
            <Divider orientation="left">Data</Divider>
            <CompatTabs id="tabs-data" className="-mt-4!" defaultActiveKey="example" onChange={this.configTabCallback}>
              <TabPane tab="Example Dataset" key="example">
                <Space direction="vertical" className="mt-2 w-full">
                  <Text>Select an example dataset:</Text>
                  <Space className="example-dataset-controls w-full" size={8}>
                    <Select
                      size="small"
                      className="w-full"
                      placeholder="Select a dataset"
                      value={currentDataset?.id || this.props.visDatasetName || undefined}
                      disabled={!isDatasetSelectable}
                      onChange={(value) => this.handleDatasetSelectChange(String(value))}>
                      {isDatasetSelectable
                        ? datasetOptions.map((option) => (
                            <Option key={String(option.value)} value={String(option.value)} title={option.label}>
                              {option.label}
                            </Option>
                          ))
                        : currentDataset && (
                            <Option key={currentDataset.id} value={currentDataset.id} title={currentDataset.title}>
                              {currentDataset.title}
                            </Option>
                          )}
                    </Select>
                    <Button
                      size="small"
                      type="primary"
                      ghost={true}
                      icon={<DatabaseOutlined className="text-xs" />}
                      onClick={() => {
                        this.props.onDataModalVisibleChange(true);
                      }}>
                      Show Data
                    </Button>
                  </Space>
                  <Space className="w-full">
                    <Text>Data file:</Text>
                    <Text strong={true}>{this.props.visDatasetFileName}</Text>
                  </Space>
                </Space>
              </TabPane>
              <TabPane tab="Upload Dataset" key="upload">
                <Space direction="vertical" className="mt-2 w-full">
                  <Text>Upload a .csv or .json file:</Text>
                  <Space className="w-full justify-between">
                    <Upload
                      accept=".csv,.json"
                      showUploadList={false}
                      maxCount={1}
                      beforeUpload={(file) => {
                        void this.handleDatasetUpload(file);
                        return Upload.LIST_IGNORE;
                      }}>
                      <Button
                        className="w-36"
                        size="small"
                        type="primary"
                        ghost={true}
                        loading={this.state.isDatasetUploading}
                        icon={<UploadOutlined />}>
                        Upload data
                      </Button>
                    </Upload>
                    <Button
                      size="small"
                      type="primary"
                      ghost={true}
                      icon={<DatabaseOutlined className="text-xs" />}
                      onClick={() => {
                        this.props.onDataModalVisibleChange(true);
                      }}>
                      Show Data
                    </Button>
                  </Space>
                  <Space className="w-full">
                    <Text>Data file:</Text>
                    <Text strong={true}>{this.props.visDatasetFileName}</Text>
                  </Space>
                </Space>
              </TabPane>
            </CompatTabs>
            <Divider orientation="left">Setting</Divider>
            <div className="visualization-settings-grid">
              {this.renderVisualizationSettingRow('Map style', this.renderVisualizationMapStyleControl(), 'map-style')}
              {visualizationParameters.map((parameter) =>
                this.renderVisualizationParameterSetting(
                  parameter,
                  adaptiveParameterKeys,
                  Boolean(
                    this.props.animationPlaybackControlled &&
                      (parameter.key === animationSpeedParameter?.key ||
                        parameter.key === animationEnabledParameter?.key),
                  ) ||
                    Boolean(
                      parameter.key === animationSpeedParameter?.key &&
                        animationEnabledParameter &&
                        !this.getVisualizationParameterValue(animationEnabledParameter),
                    ),
                ),
              )}
            </div>
            {this.props.animationPlaybackControlled && (
              <div className="mt-2 flex items-center justify-between gap-2" role="status">
                <Text type="secondary">Animation follows the timeline</Text>
                <Button size="small" type="link" onClick={this.props.onReleaseAnimationPlayback}>
                  Free animation
                </Button>
              </div>
            )}
          </TabPane>
        </CompatTabs>
      </Card>
    );
  }
}

export default PanelConfig;
