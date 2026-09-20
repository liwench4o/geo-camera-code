import '../css/PanelLibrary.css';

import React from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Divider,
  List,
  InputNumber,
  Select,
  Popover,
  Radio,
  Slider,
  Space,
  Tabs,
  Tooltip,
  Typography,
} from 'antd';
import { DragOutlined, VideoCameraAddOutlined } from '@ant-design/icons';
import { VscDebugBreakpointData } from 'react-icons/vsc';
import { GiHorizontalFlip, GiVerticalFlip } from 'react-icons/gi';
import { BiExpand, BiCollapse } from 'react-icons/bi';
import { Md360, MdCropFree, MdFlipCameraAndroid } from 'react-icons/md';
import { RiCheckboxMultipleBlankLine } from 'react-icons/ri';
import { TbArrowsRandom } from 'react-icons/tb';
import {
  getCameraById,
  getManualCameraGroups,
  getRecommendedCamerasByPurpose,
  getRecommendedPurposes,
} from '../camera/catalog';
import type {
  CameraLibraryCamera,
  CameraFramingTuning,
  CameraRecipe,
  CameraOptionSelection,
  CameraSelectionRequest,
  CameraTarget,
  NarrativePurpose,
} from '../camera/types';
import type { CameraMovement } from '../interfaces';
import type { CameraAuthoringSpec } from '../camera/authoring-types';
import {
  getDefaultCameraName,
  resolveCameraRecipe,
  isCameraImplemented,
  isComparisonRequired,
  isTargetRequired,
  isTargetTypeAllowed,
} from '../camera/recipes';
import { getCameraOptionSelectionById, getNewCameraDefaultOptionSelection } from '../camera/parameters';
import { getCameraTargetRequirementTooltip, type CameraTargetRequirementBadge } from '../camera/targetBadges';
import { getNarrativeButtonClassName, getNarrativeColorStyle } from '../theme/narrativeColors';

const { Item } = List;
const { Text } = Typography;

// Adaptive planning ignores selected geometry for these current-view strategies,
// even when the catalog accepts multiple target types (for example Basic Pull out).
function isTargetlessAuthoringRecipe(recipe: CameraRecipe) {
  return (
    recipe.purpose === 'dynamic' ||
    (recipe.purpose === 'basic' && !recipe.requiresTarget) ||
    (recipe.targetTypes.length === 1 && recipe.targetTypes[0] === 'none')
  );
}

function displayAuthoringNumber(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : value;
}

function getCameraIcon(cameraName: string) {
  if (cameraName.includes('combination')) {
    return <RiCheckboxMultipleBlankLine className="relative top-1 text-base" />;
  } else if (cameraName.includes('pan') || cameraName.includes('tracking')) {
    return <DragOutlined className="relative text-base" />;
  } else if (cameraName.includes('push-in')) {
    return <BiCollapse className="relative top-1 text-lg" />;
  } else if (cameraName.includes('pull-out')) {
    return <BiExpand className="relative top-1 text-base" />;
  } else if (cameraName.includes('trucking')) {
    return <GiHorizontalFlip className="relative top-1 text-base" />;
  } else if (cameraName.includes('roll')) {
    return <MdFlipCameraAndroid className="relative top-1 text-base" />;
  } else if (cameraName.includes('arc')) {
    return <Md360 className="relative top-1 text-lg" />;
  } else if (cameraName.includes('tilt')) {
    return <GiVerticalFlip className="relative top-1 text-base" />;
  } else if (cameraName.includes('random')) {
    return <TbArrowsRandom className="relative top-1 text-base" />;
  } else if (cameraName.includes('static')) {
    return <MdCropFree className="relative top-1 text-lg" />;
  } else {
    return <VideoCameraAddOutlined className="text-base" />;
  }
}

function renderTargetRequirementTooltipBadge(badge: CameraTargetRequirementBadge) {
  return (
    <span className={`camera-tooltip-requirement-badge camera-tooltip-requirement-badge-${badge.tone}`}>
      {badge.label}
    </span>
  );
}

function renderCameraTooltipContent(cameraItem: CameraLibraryCamera) {
  const tooltip = getCameraTargetRequirementTooltip(cameraItem.id, cameraItem.description);

  return (
    <span className="camera-tooltip-content">
      <span className="camera-tooltip-description">{tooltip.description}</span>
      {renderTargetRequirementTooltipBadge(tooltip.requirement)}
    </span>
  );
}

export interface PanelLibraryProps {
  tutorialActive?: boolean;
  currentCategory: string;
  currentCamera: string;
  currentLocation: number[];
  currentTarget?: CameraTarget;
  comparisonPair: CameraTarget[];
  selectedCamera?: CameraMovement;
  selectionKey: string | null;
  candidate?: {
    camera: CameraMovement;
    adjustments: CameraFramingTuning;
    spec?: CameraAuthoringSpec;
    action: 'add' | 'replace';
    error?: string;
  };
  requestError?: string;
  onCameraCategoryClick: (categoryName: string) => void;
  onCameraMovementItemChange: (request: CameraSelectionRequest) => void;
  onCameraAdjust: (patch: Partial<CameraFramingTuning>) => void;
  onCameraAuthoringChange?: (spec: CameraAuthoringSpec) => void;
  onCameraSourceCapture?: (kind: NonNullable<CameraAuthoringSpec['source']>['kind']) => void;
  onCameraContextCapture?: () => void;
  hasPreviousCamera?: boolean;
  onCameraPreview: () => void;
  onCameraApply: () => boolean;
  onCameraCancel: () => void;
}

export interface PanelLibraryState {
  cameraTabKey: string;
  cameraOptionSelections: Record<string, CameraOptionSelection>;
  openCameraName: string | null;
  advancedOpen: boolean;
}

class PanelLibrary extends React.Component<PanelLibraryProps, PanelLibraryState> {
  private activeCameraName: string | null = null;
  private applying = false;

  constructor(props: PanelLibraryProps) {
    super(props);
    this.cameraTabCallback = this.cameraTabCallback.bind(this);
    this.handleCameraOptionChange = this.handleCameraOptionChange.bind(this);

    this.state = {
      cameraTabKey: '',
      cameraOptionSelections: {},
      openCameraName: null,
      advancedOpen: false,
    };
  }

  componentDidUpdate(previous: PanelLibraryProps) {
    if (
      previous.selectionKey !== this.props.selectionKey ||
      previous.selectedCamera?.name !== this.props.selectedCamera?.name ||
      previous.currentTarget?.id !== this.props.currentTarget?.id ||
      previous.currentTarget?.type !== this.props.currentTarget?.type ||
      previous.currentCategory !== this.props.currentCategory ||
      previous.comparisonPair.map((target) => target.id).join('|') !==
        this.props.comparisonPair.map((target) => target.id).join('|')
    ) {
      this.closeCameraPopup(!this.applying);
    }
  }

  cameraTabCallback(key: string) {
    this.closeCameraPopup();
    this.setState({ cameraTabKey: key });
  }

  getInitialCameraOptionSelection(cameraName: string) {
    const selected = this.props.selectedCamera;
    if (selected?.name === cameraName) {
      const saved = selected.authoring?.optionSelection;
      if (saved) return saved;
      const recommended = selected.recommendation?.optionId;
      if (recommended) {
        const option = getCameraOptionSelectionById(cameraName, recommended);
        if (option) return option;
      }
    }
    return getNewCameraDefaultOptionSelection(cameraName);
  }

  getCameraOptionSelection(cameraName: string) {
    return this.state.cameraOptionSelections[cameraName] ?? this.getInitialCameraOptionSelection(cameraName);
  }

  handleCameraOptionChange(cameraName: string, optionId: string) {
    const selection = getCameraOptionSelectionById(cameraName, optionId);
    if (!selection || this.activeCameraName !== cameraName || !this.canRequestCamera(cameraName)) {
      return;
    }

    this.setState(({ cameraOptionSelections }) => ({
      cameraOptionSelections: {
        ...cameraOptionSelections,
        [cameraName]: selection,
      },
    }));
    this.props.onCameraMovementItemChange({
      cameraName,
      action: this.props.selectedCamera ? 'replace' : 'add',
      optionSelection: selection,
      resetAdjustments: true,
    });
  }

  getCameraAvailability(cameraItem: CameraLibraryCamera) {
    if (!isCameraImplemented(cameraItem.id)) {
      return {
        disabled: true,
        reason: 'This camera movement is not implemented yet.',
      };
    }

    const recipe = resolveCameraRecipe(cameraItem.id);
    if (
      this.props.selectedCamera?.name === cameraItem.id &&
      (!this.props.currentTarget || this.props.currentTarget.type === 'none')
    ) {
      return { disabled: false, reason: undefined };
    }
    const needsComparison = isComparisonRequired(cameraItem.id);
    const ignoresSelectedTarget = isTargetlessAuthoringRecipe(recipe);
    const targetType = needsComparison ? 'multiple' : ignoresSelectedTarget ? 'none' : this.props.currentTarget?.type;

    if (needsComparison && this.props.comparisonPair.length < 2) {
      return {
        disabled: true,
        reason: 'Select two different geographic targets on the map.',
      };
    }

    if (isTargetRequired(cameraItem.id) && !targetType) {
      return {
        disabled: true,
        reason: 'Select a geographic target first.',
      };
    }

    if (targetType && !isTargetTypeAllowed(cameraItem.id, targetType)) {
      if (recipe.targetTypes.length === 1 && recipe.targetTypes[0] === 'path') {
        return {
          disabled: true,
          reason: 'This camera movement requires a path target.',
        };
      }
      return {
        disabled: true,
        reason: 'This camera movement is not available for the selected target type.',
      };
    }

    return {
      disabled: false,
      reason: undefined,
    };
  }

  getPurposeAvailability(purpose: NarrativePurpose) {
    const targetType =
      purpose === 'dynamic' ? 'none' : purpose === 'comparison' ? 'multiple' : this.props.currentTarget?.type;

    if (!targetType) {
      return {
        disabled: true,
        reason: 'Select a geographic target first.',
      };
    }

    const cameraName = getDefaultCameraName(purpose, targetType);
    if (!cameraName) {
      return {
        disabled: true,
        reason: 'No default camera movement is available for this target.',
      };
    }

    const cameraItem = getCameraById(cameraName);
    return cameraItem
      ? this.getCameraAvailability(cameraItem)
      : {
          disabled: true,
          reason: 'This camera movement is not implemented yet.',
        };
  }

  canRequestCamera(cameraName: string) {
    const cameraItem = getCameraById(cameraName);
    if (!cameraItem || cameraItem.hiddenFromLibrary) {
      return false;
    }

    const availability = this.getCameraAvailability(cameraItem);
    if (availability.disabled) {
      return false;
    }

    return true;
  }

  openCameraPopup(cameraName: string) {
    if (!this.canRequestCamera(cameraName) || this.activeCameraName === cameraName) return;
    this.closeCameraPopup();
    const optionSelection = this.getInitialCameraOptionSelection(cameraName);
    this.activeCameraName = cameraName;
    this.setState(({ cameraOptionSelections }) => ({
      openCameraName: cameraName,
      advancedOpen: false,
      cameraOptionSelections: optionSelection
        ? { ...cameraOptionSelections, [cameraName]: optionSelection }
        : cameraOptionSelections,
    }));
    this.props.onCameraMovementItemChange({
      cameraName,
      action: this.props.selectedCamera ? 'replace' : 'add',
      optionSelection,
    });
  }

  closeCameraPopup(cancel = true, restoreFocus = false) {
    if (!this.activeCameraName) return;
    const cameraName = this.activeCameraName;
    this.activeCameraName = null;
    this.setState({ openCameraName: null });
    if (cancel) this.props.onCameraCancel();
    if (restoreFocus && typeof document !== 'undefined') {
      document.getElementById(`camera-shot-trigger-${cameraName}`)?.focus();
    }
  }

  getMatchingCandidate(cameraName: string) {
    const candidate = this.props.candidate;
    const action = this.props.selectedCamera ? 'replace' : 'add';
    return candidate?.camera.name === cameraName && candidate.action === action ? candidate : undefined;
  }

  canAdjustCandidate(cameraName: string) {
    const candidate = this.getMatchingCandidate(cameraName);
    return !!(
      this.activeCameraName === cameraName &&
      this.canRequestCamera(cameraName) &&
      candidate &&
      !this.props.requestError
    );
  }

  canUseCandidate(cameraName: string) {
    return this.canAdjustCandidate(cameraName) && !this.getMatchingCandidate(cameraName)?.error;
  }

  applyCameraPopup(cameraName: string) {
    if (!this.canUseCandidate(cameraName)) return;
    this.applying = true;
    try {
      if (this.props.onCameraApply()) this.closeCameraPopup(false, true);
    } finally {
      this.applying = false;
    }
  }

  renderAuthoringIntent(cameraName: string, recipe: CameraRecipe, adjustable: boolean) {
    const candidate = this.getMatchingCandidate(cameraName);
    if (!candidate) return null;
    const camera = candidate.camera;
    const split = recipe.presentation === 'split';
    const timingFields = [
      {
        field: 'duration' as const,
        label: split ? 'Display duration (s)' : 'Duration (s)',
        ariaLabel: split ? 'Display duration seconds' : 'Duration seconds',
      },
      {
        field: 'stay' as const,
        label: split ? 'Extra hold (s)' : 'Stay (s)',
        ariaLabel: split ? 'Extra hold seconds' : 'Stay seconds',
      },
    ];
    const spec = candidate.spec ??
      camera.authoring ?? {
        version: 2 as const,
        targetId: camera.targetId ?? '',
        recipeId: cameraName,
        adjustments: candidate.adjustments,
        planningViewport: { width: 800, height: 600 },
      };
    const change = (patch: Partial<CameraAuthoringSpec>) => {
      if (this.canAdjustCandidate(cameraName)) this.props.onCameraAuthoringChange?.({ ...spec, ...patch, version: 2 });
    };
    const targetless = isTargetlessAuthoringRecipe(recipe);
    const missingTarget =
      recipe.requiresTarget && (!this.props.currentTarget || this.props.currentTarget.type === 'none');
    const bothManual = !!spec.manualViews?.initial && !!spec.manualViews.final;
    const automatic = adjustable && !bothManual && !missingTarget;
    const motion = spec.motion ?? {};
    const context = spec.composition?.context;
    const sourceKind =
      spec.source?.kind ??
      (camera.debugInfo?.baseViewSource === 'previous-camera' ? 'previous-camera' : 'current-view');
    const numberControl = (
      label: string,
      value: number,
      min: number,
      max: number,
      onChange: (value: number) => void,
      step = 1,
    ) => (
      <label className="camera-shot-number" key={label}>
        <span>{label}</span>
        <InputNumber
          size="small"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={displayAuthoringNumber(value)}
          disabled={!automatic}
          onChange={(next) => {
            if (next !== null && Number.isFinite(next) && next >= min && next <= max) onChange(next);
          }}
        />
      </label>
    );
    const motionControl = (
      label: string,
      key: keyof NonNullable<CameraAuthoringSpec['motion']>,
      fallback: number,
      min: number,
      max: number,
      step = 1,
    ) =>
      numberControl(
        label,
        motion[key] ?? fallback,
        min,
        max,
        (value) => change({ motion: { ...motion, [key]: value } }),
        step,
      );
    const offset = spec.composition?.offsetRatio ??
      spec.adjustments.offsetRatio ??
      recipe.framing.offsetRatio ?? [0, 0];
    const bounds = context?.kind === 'bounds' ? context.bounds : this.props.currentTarget?.bbox;
    return (
      <>
        {(recipe.strategy.includes('push-in') ||
          recipe.strategy.includes('pull-out') ||
          (recipe.strategy.includes('pan') && recipe.purpose !== 'comparison' && !recipe.requiresComparison)) &&
          motionControl('Zoom travel', 'zoomDelta', camera.finalViewState.zoom - camera.initViewState.zoom, -8, 8, 0.1)}
        {recipe.strategy.includes('tilt') && (
          <div className="camera-shot-number-grid">
            {motionControl('Start pitch', 'startPitch', camera.initViewState.pitch, 0, 75)}
            {motionControl('End pitch', 'endPitch', camera.finalViewState.pitch, 0, 75)}
          </div>
        )}
        {(recipe.strategy.includes('arc') || recipe.strategy.includes('roll')) && (
          <div className="camera-shot-number-grid">
            {motionControl('Start bearing', 'startBearing', camera.initViewState.bearing, -360, 360)}
            {motionControl(
              'Bearing sweep',
              'bearingSweep',
              camera.framingReport?.resolvedMotion?.bearingSweep ??
                camera.finalViewState.bearing - camera.initViewState.bearing,
              -720,
              720,
            )}
          </div>
        )}
        <div className="camera-shot-control camera-shot-stack">
          <span>Movement source</span>
          <Select
            size="small"
            aria-label="Movement source"
            value={sourceKind}
            disabled={!automatic}
            options={[
              { value: 'current-view', label: 'Current map snapshot' },
              { value: 'previous-camera', label: 'Previous camera end', disabled: !this.props.hasPreviousCamera },
              { value: 'reference-view', label: 'Saved reference view' },
            ]}
            onChange={(kind) => {
              if (this.canAdjustCandidate(cameraName)) this.props.onCameraSourceCapture?.(kind);
            }}
          />
          <Button
            size="small"
            disabled={!automatic || sourceKind === 'previous-camera'}
            onClick={() => {
              if (this.canAdjustCandidate(cameraName)) this.props.onCameraSourceCapture?.(sourceKind);
            }}>
            {sourceKind === 'reference-view' ? 'Capture reference from map' : 'Recapture current map'}
          </Button>
          <Text type="secondary" className="camera-shot-note">
            Source is a saved snapshot; moving the map does not change it.
          </Text>
        </div>
        {!targetless && (
          <div className="camera-shot-control camera-shot-stack">
            <span>Context framing</span>
            <Select
              size="small"
              aria-label="Context framing"
              value={context?.kind ?? 'reconstructed'}
              disabled={!automatic}
              options={[
                { value: 'reconstructed', label: 'Reconstructed around target' },
                { value: 'bounds', label: 'Geographic bounds', disabled: !bounds },
                { value: 'view', label: 'Captured map context' },
              ]}
              onChange={(kind) => {
                if (kind === 'view') {
                  if (this.canAdjustCandidate(cameraName)) this.props.onCameraContextCapture?.();
                } else
                  change({
                    composition: {
                      ...spec.composition,
                      context: kind === 'bounds' && bounds ? { kind: 'bounds', bounds: [...bounds] } : undefined,
                    },
                  });
              }}
            />
            <Button
              size="small"
              disabled={!automatic}
              onClick={() => {
                if (this.canAdjustCandidate(cameraName)) this.props.onCameraContextCapture?.();
              }}>
              Capture map context
            </Button>
            {context?.kind === 'view' && (
              <Text type="secondary" className="camera-shot-note">
                Saved context · {context.viewport.width} × {context.viewport.height} · zoom{' '}
                {context.view.zoom.toFixed(2)}
              </Text>
            )}
            {context?.kind === 'bounds' && (
              <div className="camera-shot-number-grid">
                {(['West', 'South', 'East', 'North'] as const).map((label, index) =>
                  numberControl(
                    label,
                    context.bounds[index],
                    index % 2 ? -85 : -360,
                    index % 2 ? 85 : 360,
                    (value) => {
                      const next: [number, number, number, number] = [...context.bounds];
                      next[index] = value;
                      change({ composition: { ...spec.composition, context: { kind: 'bounds', bounds: next } } });
                    },
                    0.01,
                  ),
                )}
              </div>
            )}
            <span>Target anchor</span>
            <Radio.Group
              size="small"
              aria-label="Target anchor"
              value={spec.composition?.anchor ?? 'visual'}
              disabled={!automatic}
              onChange={(event) => change({ composition: { ...spec.composition, anchor: event.target.value } })}>
              <Radio.Button value="ground">Ground</Radio.Button>
              <Radio.Button value="visual">Visual centre</Radio.Button>
            </Radio.Group>
            <div className="camera-shot-number-grid">
              {(['Screen offset X', 'Screen offset Y'] as const).map((label, index) =>
                numberControl(
                  label,
                  offset[index],
                  -0.45,
                  0.45,
                  (value) => {
                    const next: [number, number] = [offset[0], offset[1]];
                    next[index] = value;
                    change({ composition: { ...spec.composition, offsetRatio: next } });
                  },
                  0.01,
                ),
              )}
            </div>
          </div>
        )}
        <div className="camera-shot-control camera-shot-stack">
          <span>Timing</span>
          <div className="camera-shot-number-grid">
            {timingFields.map(({ field, label, ariaLabel }) => (
              <label className="camera-shot-number" key={field}>
                <span>{label}</span>
                <InputNumber
                  size="small"
                  aria-label={ariaLabel}
                  min={0}
                  step={0.1}
                  value={(spec.timing?.[field] ?? camera[field]) / 1000}
                  disabled={!adjustable}
                  onChange={(value) => {
                    if (value !== null && Number.isFinite(value) && value >= 0)
                      change({ timing: { ...spec.timing, [field]: value * 1000 } });
                  }}
                />
              </label>
            ))}
          </div>
          {(spec.timing?.duration !== undefined ||
            (split && (spec.timing?.stay !== undefined || spec.adjustments.speedScale !== undefined))) && (
            <Button
              size="small"
              disabled={!adjustable}
              onClick={() =>
                change(
                  split
                    ? {
                        timing: { ...spec.timing, duration: undefined, stay: undefined },
                        adjustments: { ...spec.adjustments, speedScale: undefined },
                      }
                    : { timing: { ...spec.timing, duration: undefined } },
                )
              }>
              {split ? 'Use preset timing' : 'Use automatic duration'}
            </Button>
          )}
          <Text type="secondary" className="camera-shot-note">
            {split
              ? 'The preset is the full display duration. Extra hold is optional and defaults to 0.'
              : 'Shots connect automatically.'}
          </Text>
        </div>
        <div className="camera-shot-control camera-shot-stack">
          <span>Endpoint ownership</span>
          {bothManual && (
            <Text type="secondary" className="camera-shot-note">
              Manual endpoints own the camera views. Return an endpoint to Auto to adjust framing and motion.
            </Text>
          )}
          {missingTarget && (
            <Alert
              type="info"
              showIcon
              message="This saved shot has no geographic target. Its manual views are preserved; select a target to create an automatic shot."
            />
          )}
          {(['initial', 'final'] as const).map((endpoint) => (
            <div className="camera-shot-ownership" key={endpoint}>
              <Text>
                {endpoint === 'initial' ? 'Initial' : 'Final'}: {spec.manualViews?.[endpoint] ? 'Manual' : 'Auto'}
              </Text>
              {spec.manualViews?.[endpoint] && (
                <Button
                  size="small"
                  disabled={!adjustable || missingTarget}
                  onClick={() =>
                    change({ manualViews: { ...spec.manualViews, [endpoint]: undefined } })
                  }>{`Return ${endpoint} to Auto`}</Button>
              )}
            </div>
          ))}
        </div>
        <div className="camera-shot-resolved">
          <Text strong>Resolved views</Text>
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Start</th>
                <th>End</th>
              </tr>
            </thead>
            <tbody>
              {(['zoom', 'pitch', 'bearing'] as const).map((field) => (
                <tr key={field}>
                  <th>{field}</th>
                  <td>
                    {camera.initViewState[field].toFixed(2)}
                    {field === 'zoom' ? '' : '°'}
                  </td>
                  <td>
                    {camera.finalViewState[field].toFixed(2)}
                    {field === 'zoom' ? '' : '°'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!!Object.keys(motion).length && (
            <Text type="secondary" className="camera-shot-note">
              Requested:{' '}
              {Object.entries(motion)
                .filter(([, value]) => value !== undefined)
                .map(
                  ([key, value]) =>
                    `${({ zoomDelta: 'zoom travel', startPitch: 'start pitch', endPitch: 'end pitch', startBearing: 'start bearing', bearingSweep: 'bearing sweep' } as Record<string, string>)[key]} ${displayAuthoringNumber(value)}`,
                )
                .join(' · ')}
            </Text>
          )}
          {!!camera.framingReport?.messages.length && (
            <Alert
              type={camera.framingReport.status === 'passed' ? 'info' : 'warning'}
              showIcon
              message={camera.framingReport.messages.join(' ')}
            />
          )}
        </div>
      </>
    );
  }

  renderCameraPopup(cameraItem: CameraLibraryCamera) {
    const selection = this.getCameraOptionSelection(cameraItem.id);
    const candidate = this.getMatchingCandidate(cameraItem.id);
    const adjustments = candidate?.adjustments ?? {};
    const recipe = resolveCameraRecipe(cameraItem.id, selection);
    const baseDuration = resolveCameraRecipe(cameraItem.id).duration;
    const presetSpeed = baseDuration > 0 && recipe.duration > 0 ? baseDuration / recipe.duration : 1;
    const pace = presetSpeed * (adjustments.speedScale ?? 1);
    const paceMax = Math.max(4, presetSpeed, pace);
    const angle =
      adjustments.pitchTarget ??
      recipe.framing.pitchTarget ??
      recipe.framing.pitchRange[0] + (recipe.framing.pitchRange[1] - recipe.framing.pitchRange[0]) * 0.35;
    const targetless = isTargetlessAuthoringRecipe(recipe);
    const error = this.props.requestError || candidate?.error;
    const ready = this.canUseCandidate(cameraItem.id);
    const adjustable = this.canAdjustCandidate(cameraItem.id);
    const spec = candidate?.spec ?? candidate?.camera.authoring;
    const automatic =
      adjustable &&
      !(spec?.manualViews?.initial && spec.manualViews.final) &&
      !(recipe.requiresTarget && (!this.props.currentTarget || this.props.currentTarget.type === 'none'));
    const adjust = (patch: Partial<CameraFramingTuning>) => {
      if (this.canAdjustCandidate(cameraItem.id)) this.props.onCameraAdjust(patch);
    };

    return (
      <section
        id={`camera-shot-popup-${cameraItem.id}`}
        className="camera-shot-popup"
        role="dialog"
        tabIndex={-1}
        aria-label={cameraItem.title}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            this.closeCameraPopup(true, true);
          }
        }}>
        {!!cameraItem.options?.length && (
          <Text className="camera-shot-note">
            {cameraItem.optionKind === 'duration'
              ? 'Display duration'
              : cameraItem.optionKind === 'angle'
                ? 'End angle'
                : 'Pace'}
          </Text>
        )}
        {!!cameraItem.options?.length && (
          <Radio.Group
            className="camera-shot-presets"
            aria-label="Shot preset"
            value={selection?.id}
            onChange={(event) => this.handleCameraOptionChange(cameraItem.id, event.target.value)}>
            {cameraItem.options.map((option) => (
              <Radio key={option.id} value={option.id}>
                {selection?.id === option.id ? selection.label : option.label}
              </Radio>
            ))}
          </Radio.Group>
        )}
        {cameraItem.optionKind === 'pace' && (
          <Text className="camera-shot-note">Pace sets movement speed. Planned time is shown below.</Text>
        )}
        {candidate && (
          <Text className="camera-shot-note" aria-label="Shot timing">
            {recipe.strategy === 'static'
              ? `Total display: ${((candidate.camera.duration + candidate.camera.stay) / 1000).toFixed(1)} s`
              : `Move: ${(candidate.camera.duration / 1000).toFixed(1)} s · Hold: ${(candidate.camera.stay / 1000).toFixed(1)} s · Total: ${((candidate.camera.duration + candidate.camera.stay) / 1000).toFixed(1)} s`}
          </Text>
        )}
        <Collapse
          className="camera-shot-advanced"
          ghost
          size="small"
          activeKey={this.state.advancedOpen ? ['advanced'] : []}
          onChange={(keys) => {
            if (this.activeCameraName === cameraItem.id) this.setState({ advancedOpen: keys.includes('advanced') });
          }}
          items={[
            {
              key: 'advanced',
              label: 'Advanced',
              children: (
                <div className="camera-shot-controls">
                  {!targetless && (
                    <div className="camera-shot-control">
                      <span>Distance</span>
                      <Slider
                        ariaLabelForHandle="Distance"
                        min={-1}
                        max={1}
                        step={0.05}
                        value={adjustments.framingTightness ?? 0}
                        marks={{ '-1': 'Closer', 0: 'Suggested', 1: 'Wider' }}
                        disabled={!automatic}
                        tooltip={{
                          formatter: (value) =>
                            value === 0 ? 'Suggested distance' : (value ?? 0) < 0 ? 'Closer' : 'Wider',
                        }}
                        onChange={(value) => adjust({ framingTightness: value })}
                      />
                    </div>
                  )}
                  {!recipe.strategy.includes('tilt') && (
                    <div className="camera-shot-control">
                      <span>Angle</span>
                      <Slider
                        ariaLabelForHandle="Angle"
                        min={0}
                        max={75}
                        step={1}
                        value={angle}
                        marks={{ 0: 'Top down', 75: 'Oblique' }}
                        disabled={!automatic}
                        tooltip={{ formatter: (value) => `${value}°` }}
                        onChange={(value) => adjust({ pitchTarget: value })}
                      />
                    </div>
                  )}
                  {recipe.strategy !== 'static' && (
                    <div className="camera-shot-control">
                      <span>Pace</span>
                      <Slider
                        ariaLabelForHandle="Pace"
                        min={0.25}
                        max={paceMax}
                        step={0.05}
                        value={pace}
                        marks={{ 0.25: '0.25×', 1: '1×', [paceMax]: `${Number(paceMax.toFixed(2))}×` }}
                        disabled={!adjustable}
                        tooltip={{ formatter: (value) => `${Number((value ?? 1).toFixed(2))}×` }}
                        onChange={(value) => adjust({ speedScale: value / presetSpeed })}
                      />
                    </div>
                  )}
                  {!targetless && (
                    <div className="camera-shot-control">
                      <span>Margin</span>
                      <Slider
                        ariaLabelForHandle="Margin"
                        min={0}
                        max={Math.max(0.3, adjustments.safetyMarginRatio ?? recipe.framing.paddingRatio)}
                        step={0.01}
                        value={adjustments.safetyMarginRatio ?? recipe.framing.paddingRatio}
                        marks={{ 0: '0%', 0.1: '10%', 0.3: '30%' }}
                        disabled={!automatic}
                        tooltip={{ formatter: (value) => `${Math.round((value ?? 0) * 100)}%` }}
                        onChange={(value) => adjust({ safetyMarginRatio: value })}
                      />
                    </div>
                  )}
                  {this.renderAuthoringIntent(cameraItem.id, recipe, adjustable)}
                </div>
              ),
            },
          ]}
        />
        {error && <Alert type="error" showIcon message={error} />}
        <div className="camera-shot-actions">
          <Button
            size="small"
            disabled={!ready}
            onClick={() => {
              if (this.canUseCandidate(cameraItem.id)) this.props.onCameraPreview();
            }}>
            Preview
          </Button>
          <Button size="small" type="primary" disabled={!ready} onClick={() => this.applyCameraPopup(cameraItem.id)}>
            {this.props.selectedCamera ? 'Replace' : 'Add shot'}
          </Button>
          <Button size="small" onClick={() => this.closeCameraPopup(true, true)}>
            Cancel
          </Button>
        </div>
      </section>
    );
  }

  renderCameraList(cameras: CameraLibraryCamera[]) {
    return (
      <List
        size="small"
        bordered={false}
        split={true}
        itemLayout="vertical"
        dataSource={cameras}
        renderItem={(cameraItem) => {
          const availability = this.getCameraAvailability(cameraItem);
          const button = (
            <Button
              id={`camera-shot-trigger-${cameraItem.id}`}
              className={getNarrativeButtonClassName(this.props.currentCamera === cameraItem.id)}
              style={getNarrativeColorStyle(cameraItem.purpose)}
              size="small"
              type="default"
              block={true}
              value={cameraItem.id}
              aria-haspopup="dialog"
              aria-controls={`camera-shot-popup-${cameraItem.id}`}
              aria-expanded={this.state.openCameraName === cameraItem.id}
              onKeyDown={(event) => {
                if (event.key === 'Escape') this.closeCameraPopup(true, true);
              }}
              disabled={availability.disabled}>
              {cameraItem.title}
            </Button>
          );
          const cameraButton = availability.disabled ? (
            <Tooltip title={availability.reason} placement="top">
              <span className="block">{button}</span>
            </Tooltip>
          ) : (
            <Tooltip
              title={this.state.openCameraName === cameraItem.id ? null : renderCameraTooltipContent(cameraItem)}
              placement="top">
              <Popover
                trigger="click"
                placement="right"
                title={cameraItem.title}
                open={this.state.openCameraName === cameraItem.id}
                afterOpenChange={(open) => {
                  if (open && this.activeCameraName === cameraItem.id && typeof document !== 'undefined') {
                    document.getElementById(`camera-shot-popup-${cameraItem.id}`)?.focus();
                  }
                }}
                onOpenChange={(open) => {
                  if (open) this.openCameraPopup(cameraItem.id);
                  else if (this.activeCameraName === cameraItem.id) this.closeCameraPopup();
                }}
                content={this.renderCameraPopup(cameraItem)}>
                {button}
              </Popover>
            </Tooltip>
          );

          return (
            <Item className="px-2! py-1!" key={`list-item-${cameraItem.id}`}>
              <Item.Meta
                className="my-0!"
                avatar={getCameraIcon(cameraItem.id)}
                title={cameraButton}
                description={
                  <div className="min-w-0 pt-px">
                    <Text ellipsis={true} className="text-xs text-slate-400!">
                      {cameraItem.listDescription}
                    </Text>
                  </div>
                }
              />
            </Item>
          );
        }}
      />
    );
  }

  render() {
    const { currentCategory } = this.props;
    const categoryCameras = getRecommendedCamerasByPurpose(currentCategory);
    const manualGroups = getManualCameraGroups();

    return (
      <Card
        id="panel-library"
        className="h-full"
        size="small"
        title="Camera Library"
        styles={{ body: { height: 'calc(100vh - 112px)', overflowX: 'hidden', overflowY: 'auto' } }}>
        <Tabs
          className="-mt-3!"
          onChange={this.cameraTabCallback}
          activeKey={this.props.tutorialActive ? 'default' : this.state.cameraTabKey || 'default'}
          tabBarStyle={{ marginBottom: 0 }}
          items={[
            {
              key: 'default',
              label: 'Default',
              children: (
                <>
                  <div data-tour="narrative-purpose">
                    <Divider className="mt-3! mb-1!" orientation="left">
                      Narrative Purpose
                    </Divider>
                    <Radio.Group className="grid w-full gap-1.5" value={currentCategory} optionType="button">
                      <div className="grid w-full gap-1.5">
                        <Radio.Button
                          key="category-none"
                          className={`narrative-purpose-option flex h-9 w-full items-center border bg-white px-3 text-left text-xs font-medium transition-all duration-150 ${
                            currentCategory === 'none' ? 'narrative-purpose-option-active' : ''
                          }`}
                          style={getNarrativeColorStyle('none')}
                          value="none"
                          onClick={() => this.props.onCameraCategoryClick('none')}>
                          <Space className="w-full" size={6}>
                            <VscDebugBreakpointData className="relative text-base" />
                            None
                          </Space>
                        </Radio.Button>
                        {getRecommendedPurposes().map((purpose) => {
                          const availability = this.getPurposeAvailability(purpose.id as NarrativePurpose);
                          const radioButton = (
                            <Radio.Button
                              key={`category-${purpose.id}`}
                              className={`narrative-purpose-option flex h-9 w-full items-center border bg-white px-3 text-left text-xs font-medium transition-all duration-150 ${
                                currentCategory === purpose.id ? 'narrative-purpose-option-active' : ''
                              }`}
                              style={getNarrativeColorStyle(purpose.id)}
                              value={purpose.id}
                              disabled={availability.disabled}
                              onClick={
                                availability.disabled ? undefined : () => this.props.onCameraCategoryClick(purpose.id)
                              }>
                              <Space className="w-full" size={6}>
                                <VscDebugBreakpointData className="relative text-base" />
                                {purpose.title}
                              </Space>
                            </Radio.Button>
                          );

                          const wrappedButton = availability.disabled ? (
                            <Tooltip
                              key={`category-disabled-${purpose.id}`}
                              placement="right"
                              title={availability.reason}>
                              <span className="block">{radioButton}</span>
                            </Tooltip>
                          ) : (
                            <Tooltip key={`category-${purpose.id}`} placement="right" title={purpose.description}>
                              {radioButton}
                            </Tooltip>
                          );

                          return wrappedButton;
                        })}
                      </div>
                    </Radio.Group>
                  </div>
                  <div data-tour="camera-types">
                    <Divider className="mt-2! mb-3!" orientation="left">
                      Camera Types
                    </Divider>
                    {this.renderCameraList(categoryCameras)}
                  </div>
                </>
              ),
            },
            {
              key: 'manual',
              label: 'Manual',
              children: (
                <>
                  {manualGroups.map((group) => (
                    <React.Fragment key={group.id}>
                      <Divider className="mt-3! mb-2!" orientation="left">
                        {group.title}
                      </Divider>
                      {this.renderCameraList(group.cameras)}
                    </React.Fragment>
                  ))}
                </>
              ),
            },
          ]}
        />
      </Card>
    );
  }
}

export default PanelLibrary;
