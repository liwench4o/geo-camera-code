import cameraLibraryJson from '../../assets/camera-library.json';
import { digestCanonical } from './geometry/canonical-digest';
import type {
  CameraFramingTuning,
  CameraLibraryCamera,
  CameraLibraryConfig,
  CameraLibraryTuning,
  CameraRecipeAdjustment,
  CameraMode,
  CameraRecipeStrategy,
  CameraShot,
  GeospatialTargetType,
  ManualCameraGroup,
  NarrativePurpose,
  StrictFrameFallbackLevel,
  StrictFrameLibraryConfig,
} from './types';

const VALID_PURPOSES: NarrativePurpose[] = ['emphasis', 'overview', 'comparison', 'supplement', 'dynamic', 'basic'];
const VALID_RECOMMENDED_PURPOSES: NarrativePurpose[] = VALID_PURPOSES.filter((purpose) => purpose !== 'basic');
const VALID_TARGET_TYPES: GeospatialTargetType[] = ['location', 'region', 'path', 'multiple', 'none'];
const VALID_SHOTS: CameraShot[] = [
  'static',
  'push-in',
  'pull-out',
  'pan',
  'tilt',
  'camera-roll',
  'arc',
  'trucking',
  'tracking',
];
const VALID_STRATEGIES: CameraRecipeStrategy[] = [
  ...VALID_SHOTS,
  'push-in-tilt',
  'arc-tilt',
  'pan-tilt',
  'pan-push-in',
  'pull-out-roll',
  'arc-pull-out',
  'tracking-push-in',
];
const VALID_MODES: CameraMode[] = ['recommended', 'manual'];
const MANUAL_GROUP_TITLES: Record<string, string> = {
  basic: 'Basic Cameras',
  combination: 'Combinations',
};

const VALID_STRICT_FRAME_FALLBACK_LEVELS: StrictFrameFallbackLevel[] = [
  'preferred',
  'occupancy',
  'pitch',
  'bearing',
  'anchor',
];

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonValue(entry)) as T;
  }
  if (typeof value === 'object' && value !== null) {
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      clone[key] = cloneJsonValue(entry);
    }
    return clone as T;
  }
  return value;
}

const strictFrameCompatibilityDefaults = cloneJsonValue(
  (cameraLibraryJson as unknown as { strictFrame: StrictFrameLibraryConfig }).strictFrame,
);

export function loadCameraCatalog(source: unknown): CameraLibraryConfig {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError('Camera catalog source must be an object.');
  }
  const clone = cloneJsonValue(source) as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(clone, 'revision') || clone.revision === undefined) {
    const version = typeof clone.version === 'number' && Number.isFinite(clone.version) ? clone.version : 'unknown';
    clone.revision = `legacy-camera-library-v${version}-${digestCanonical(clone)}`;
  }
  if (!Object.prototype.hasOwnProperty.call(clone, 'strictFrame') || clone.strictFrame === undefined) {
    clone.strictFrame = cloneJsonValue(strictFrameCompatibilityDefaults);
  }
  return clone as unknown as CameraLibraryConfig;
}

export const cameraCatalog = loadCameraCatalog(cameraLibraryJson);

function hasDuplicates(values: string[]) {
  return new Set(values).size !== values.length;
}

function getDuplicates(values: string[]) {
  return Array.from(new Set(values.filter((value, index) => values.indexOf(value) !== index)));
}

function isValidPurpose(value: string): value is NarrativePurpose {
  return VALID_PURPOSES.includes(value as NarrativePurpose);
}

function isRecommendedPurpose(value: string): value is NarrativePurpose {
  return VALID_RECOMMENDED_PURPOSES.includes(value as NarrativePurpose);
}

function isValidTargetType(value: string): value is GeospatialTargetType {
  return VALID_TARGET_TYPES.includes(value as GeospatialTargetType);
}

function isValidShot(value: string): value is CameraShot {
  return VALID_SHOTS.includes(value as CameraShot);
}

function isValidStrategy(value: string): value is CameraRecipeStrategy {
  return VALID_STRATEGIES.includes(value as CameraRecipeStrategy);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateFiniteField(value: unknown, field: string, errors: string[], options?: { nonNegative?: boolean }) {
  if (!isFiniteNumber(value) || (options?.nonNegative && value < 0)) {
    errors.push(`strictFrame.${field} must be ${options?.nonNegative ? 'finite and non-negative' : 'finite'}.`);
  }
}

function validatePositiveField(value: unknown, field: string, errors: string[], integer = false) {
  if (!isFiniteNumber(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    errors.push(`strictFrame.${field} must be a positive${integer ? ' safe integer' : ' finite number'}.`);
  }
}

function validateStrictFrameConfig(config: StrictFrameLibraryConfig | undefined, errors: string[]) {
  if (!config) {
    errors.push('strictFrame is required for camera catalog v2.');
    return;
  }
  if (config.version !== 1) {
    errors.push(`Unsupported strictFrame version: ${String(config.version)}.`);
  }

  const mapping = config.contentMapping;
  if (!mapping) {
    errors.push('strictFrame.contentMapping is required.');
  } else {
    for (const field of ['elevation', 'density', 'coverage', 'dispersion'] as const) {
      validateFiniteField(mapping.occupancy?.[field], `contentMapping.occupancy.${field}`, errors, {
        nonNegative: true,
      });
    }
    validateFiniteField(mapping.pitch?.elevationDeg, 'contentMapping.pitch.elevationDeg', errors);
    validateFiniteField(mapping.pitch?.curvatureDeg, 'contentMapping.pitch.curvatureDeg', errors);
    validateFiniteField(mapping.bearingOrientationWeight, 'contentMapping.bearingOrientationWeight', errors);
    if (
      isFiniteNumber(mapping.bearingOrientationWeight) &&
      (mapping.bearingOrientationWeight < 0 || mapping.bearingOrientationWeight > 1)
    ) {
      errors.push('strictFrame.contentMapping.bearingOrientationWeight must be in [0, 1].');
    }
    for (const field of ['coverage', 'density', 'dispersion', 'curvature'] as const) {
      validateFiniteField(mapping.motion?.[field], `contentMapping.motion.${field}`, errors, { nonNegative: true });
    }
    for (const field of ['curvature', 'dispersion'] as const) {
      validateFiniteField(mapping.speed?.[field], `contentMapping.speed.${field}`, errors, { nonNegative: true });
    }
    validatePositiveField(mapping.speed?.minScale, 'contentMapping.speed.minScale', errors);
    validatePositiveField(mapping.speed?.maxScale, 'contentMapping.speed.maxScale', errors);
    if (
      isFiniteNumber(mapping.speed?.minScale) &&
      isFiniteNumber(mapping.speed?.maxScale) &&
      mapping.speed.minScale > mapping.speed.maxScale
    ) {
      errors.push('strictFrame.contentMapping.speed scales must be ordered minScale <= maxScale.');
    }

    const range = mapping.closerWiderOccupancy;
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      !range.every((value) => isFiniteNumber(value) && value > 0 && value <= 1) ||
      !(range[0] > range[1])
    ) {
      errors.push('strictFrame.contentMapping.closerWiderOccupancy must be [near, far] with 1 >= near > far > 0.');
    }
  }

  const solver = config.solver;
  if (!solver) {
    errors.push('strictFrame.solver is required.');
  } else {
    for (const field of [
      'pitchStepDeg',
      'bearingStepDeg',
      'zoomTolerance',
      'meterSupportTolerancePx',
      'anchorTolerancePx',
    ] as const) {
      validatePositiveField(solver[field], `solver.${field}`, errors);
    }
    for (const field of [
      'meterSupportIntervalBudget',
      'anchorAlignmentMaxIterations',
      'evaluationBudget',
      'parameterBoxBudget',
    ] as const) {
      validatePositiveField(solver[field], `solver.${field}`, errors, true);
    }
    validateFiniteField(solver.numericalBufferPx, 'solver.numericalBufferPx', errors, { nonNegative: true });

    const occupancyFactors = solver.occupancyRelaxationFactors;
    if (
      !Array.isArray(occupancyFactors) ||
      occupancyFactors.length === 0 ||
      occupancyFactors.some((value) => !isFiniteNumber(value) || value <= 0 || value > 1) ||
      occupancyFactors.some((value, index) => index > 0 && value >= occupancyFactors[index - 1])
    ) {
      errors.push('strictFrame.solver.occupancyRelaxationFactors must be strictly descending values in (0, 1].');
    }
    const anchorFactors = solver.anchorCenterBlendFactors;
    if (
      !Array.isArray(anchorFactors) ||
      anchorFactors.length === 0 ||
      anchorFactors.some((value) => !isFiniteNumber(value) || value <= 0 || value > 1) ||
      anchorFactors.some((value, index) => index > 0 && value <= anchorFactors[index - 1])
    ) {
      errors.push('strictFrame.solver.anchorCenterBlendFactors must be strictly ascending values in (0, 1].');
    }
  }

  if (
    !Array.isArray(config.fallbackLevels) ||
    config.fallbackLevels.length !== VALID_STRICT_FRAME_FALLBACK_LEVELS.length ||
    config.fallbackLevels.some((level, index) => level !== VALID_STRICT_FRAME_FALLBACK_LEVELS[index])
  ) {
    errors.push(`strictFrame.fallbackLevels must equal ${VALID_STRICT_FRAME_FALLBACK_LEVELS.join(' -> ')}.`);
  }

  const weights = config.weights;
  const weightFields = ['occupancy', 'pitch', 'bearing', 'anchor', 'continuity'] as const;
  if (!weights) {
    errors.push('strictFrame.weights is required.');
  } else {
    for (const field of weightFields) {
      validateFiniteField(weights[field], `weights.${field}`, errors, { nonNegative: true });
    }
    if (weightFields.every((field) => weights[field] === 0)) {
      errors.push('strictFrame.weights must include at least one positive weight.');
    }
  }
}

function validateRecipeAdjustment(
  cameraId: string,
  adjustment: CameraRecipeAdjustment | undefined,
  errors: string[],
  label: string,
) {
  if (!adjustment) {
    return;
  }

  if (adjustment.timing) {
    const { durationMs, stayMs, interpolationDurationMs, pathDurationPerKmMs, maxDurationMs, speedTier } =
      adjustment.timing;
    for (const [field, value] of Object.entries({
      durationMs,
      stayMs,
      interpolationDurationMs,
      pathDurationPerKmMs,
      maxDurationMs,
      speedTier,
    })) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        errors.push(`Camera ${cameraId} ${label} has invalid timing.${field}.`);
      }
    }
  }

  if (adjustment.framing) {
    const { paddingRatio, contextPaddingRatio, minPaddingPx, maxPaddingRatio, pitchRange, offsetRatio } =
      adjustment.framing;
    if (paddingRatio !== undefined && (paddingRatio < 0 || paddingRatio >= 0.5)) {
      errors.push(`Camera ${cameraId} ${label} has invalid framing.paddingRatio.`);
    }
    if (contextPaddingRatio !== undefined && (contextPaddingRatio < 0 || contextPaddingRatio >= 0.5)) {
      errors.push(`Camera ${cameraId} ${label} has invalid framing.contextPaddingRatio.`);
    }
    if (minPaddingPx !== undefined && (!Number.isFinite(minPaddingPx) || minPaddingPx < 0)) {
      errors.push(`Camera ${cameraId} ${label} has invalid framing.minPaddingPx.`);
    }
    if (maxPaddingRatio !== undefined && (maxPaddingRatio <= 0 || maxPaddingRatio >= 0.5)) {
      errors.push(`Camera ${cameraId} ${label} has invalid framing.maxPaddingRatio.`);
    }
    if (
      pitchRange !== undefined &&
      (!Array.isArray(pitchRange) ||
        pitchRange.length !== 2 ||
        !Number.isFinite(pitchRange[0]) ||
        !Number.isFinite(pitchRange[1]) ||
        pitchRange[0] > pitchRange[1])
    ) {
      errors.push(`Camera ${cameraId} ${label} has invalid framing.pitchRange.`);
    }
    // |offsetRatio| >= 0.5 puts the desired anchor on the viewport edge, degenerating the safety
    // window so the fit loop silently skips fitting — the bound is exclusive.
    if (
      offsetRatio !== undefined &&
      (!Array.isArray(offsetRatio) ||
        offsetRatio.length !== 2 ||
        offsetRatio.some((entry) => !Number.isFinite(entry) || Math.abs(entry) >= 0.5))
    ) {
      errors.push(
        `Camera ${cameraId} ${label} has invalid framing.offsetRatio (expected two values within (-0.5, 0.5)).`,
      );
    }
  }
}

function validateTuningConfig(tuning: CameraLibraryTuning | undefined, errors: string[]) {
  if (!tuning) {
    return;
  }

  const entries: Array<[string, CameraFramingTuning | undefined]> = [['tuning.global', tuning.global]];
  for (const [purpose, value] of Object.entries(tuning.byPurpose ?? {})) {
    if (!isValidPurpose(purpose)) {
      errors.push(`Invalid tuning purpose: ${purpose}.`);
    }
    entries.push([`tuning.byPurpose.${purpose}`, value]);
  }

  for (const [label, value] of entries) {
    if (!value) {
      continue;
    }
    if (
      value.framingTightness !== undefined &&
      (!Number.isFinite(value.framingTightness) || value.framingTightness < -1 || value.framingTightness > 1)
    ) {
      errors.push(`${label} has invalid framingTightness (expected [-1, 1]).`);
    }
    if (
      value.motionStrength !== undefined &&
      (!Number.isFinite(value.motionStrength) || value.motionStrength < -1 || value.motionStrength > 1)
    ) {
      errors.push(`${label} has invalid motionStrength (expected [-1, 1]).`);
    }
    if (
      value.anchorHeightRatio !== undefined &&
      (!Number.isFinite(value.anchorHeightRatio) || value.anchorHeightRatio < 0 || value.anchorHeightRatio > 1)
    ) {
      errors.push(`${label} has invalid anchorHeightRatio (expected [0, 1]).`);
    }
    if (value.speedScale !== undefined && (!(value.speedScale > 0) || value.speedScale > 4)) {
      errors.push(`${label} has invalid speedScale (expected (0, 4]).`);
    }
    // |offsetRatio| >= 0.5 puts the desired anchor on the viewport edge, degenerating the safety
    // window so the fit loop silently skips fitting — the bound is exclusive.
    if (
      value.offsetRatio !== undefined &&
      (!Array.isArray(value.offsetRatio) ||
        value.offsetRatio.length !== 2 ||
        value.offsetRatio.some((entry) => !Number.isFinite(entry) || entry <= -0.5 || entry >= 0.5))
    ) {
      errors.push(`${label} has invalid offsetRatio (expected (-0.5, 0.5)).`);
    }
    if (value.pitchTarget !== undefined && !Number.isFinite(value.pitchTarget)) {
      errors.push(`${label} has invalid pitchTarget (expected a finite number).`);
    }
  }
}

export function normalizeTargetType(targetType: string | undefined): GeospatialTargetType {
  if (targetType === 'point' || targetType === 'location') {
    return 'location';
  }

  return isValidTargetType(String(targetType)) ? (targetType as GeospatialTargetType) : 'none';
}

export function validateCameraCatalog(catalog: CameraLibraryConfig) {
  const errors: string[] = [];
  const cameraIds = catalog.cameras.map((camera) => camera.id);
  const cameraById = new Map(catalog.cameras.map((camera) => [camera.id, camera]));
  const defaultKeys = catalog.defaults.map((item) => `${item.purpose}:${item.targetType}`);

  if (catalog.version !== 2) {
    errors.push(`Unsupported camera catalog version: ${catalog.version}.`);
  }
  if (typeof catalog.revision !== 'string' || catalog.revision.trim().length === 0) {
    errors.push('Camera catalog revision must be a non-empty string.');
  }
  validateStrictFrameConfig(catalog.strictFrame, errors);

  if (hasDuplicates(cameraIds)) {
    errors.push(`Duplicate camera ids: ${getDuplicates(cameraIds).join(', ')}.`);
  }

  if (hasDuplicates(defaultKeys)) {
    errors.push(`Duplicate default camera rules: ${getDuplicates(defaultKeys).join(', ')}.`);
  }

  validateTuningConfig(catalog.tuning, errors);

  for (const purpose of catalog.taxonomy.purposes) {
    if (!isRecommendedPurpose(purpose.id)) {
      errors.push(`Invalid taxonomy purpose id: ${purpose.id}.`);
    }
  }

  for (const target of catalog.taxonomy.targets) {
    if (!isValidTargetType(target.id)) {
      errors.push(`Invalid taxonomy target id: ${target.id}.`);
    }
  }

  for (const shot of catalog.taxonomy.shots) {
    if (!isValidShot(shot.id)) {
      errors.push(`Invalid taxonomy shot id: ${shot.id}.`);
    }
  }

  for (const camera of catalog.cameras) {
    if (camera.hiddenFromLibrary !== undefined && typeof camera.hiddenFromLibrary !== 'boolean') {
      errors.push(`Camera ${camera.id} hiddenFromLibrary must be a boolean.`);
    }
    if (!VALID_MODES.includes(camera.mode)) {
      errors.push(`Camera ${camera.id} has invalid mode: ${camera.mode}.`);
    }
    if (camera.mode === 'recommended' && (!camera.purpose || !isRecommendedPurpose(camera.purpose))) {
      errors.push(`Recommended camera ${camera.id} must reference a recommended narrative purpose.`);
    }
    if (camera.mode === 'manual' && !camera.manualGroup) {
      errors.push(`Manual camera ${camera.id} must include a manualGroup.`);
    }
    if (camera.purpose && !isValidPurpose(camera.purpose)) {
      errors.push(`Camera ${camera.id} has invalid purpose: ${String(camera.purpose)}.`);
    }
    if (camera.presentation !== undefined && camera.presentation !== 'split') {
      errors.push(`Camera ${camera.id} has invalid presentation: ${String(camera.presentation)}.`);
    }
    if (camera.presentation === 'split') {
      if (camera.purpose !== 'comparison') {
        errors.push(`Camera ${camera.id} split presentation requires comparison purpose.`);
      }
      if (camera.targetTypes.length !== 1 || camera.targetTypes[0] !== 'multiple') {
        errors.push(`Camera ${camera.id} split presentation requires only multiple target type.`);
      }
      if (camera.recipe.targetPolicy?.requiresComparison !== true) {
        errors.push(`Camera ${camera.id} split presentation requires comparison target snapshots.`);
      }
    }
    if (camera.shots.length === 0) {
      errors.push(`Camera ${camera.id} must include at least one shot.`);
    }
    for (const shot of camera.shots) {
      if (!isValidShot(shot)) {
        errors.push(`Camera ${camera.id} has invalid shot: ${String(shot)}.`);
      }
    }
    if (camera.targetTypes.length === 0) {
      errors.push(`Camera ${camera.id} must include at least one target type.`);
    }
    if (!camera.listDescription || camera.listDescription.trim().length === 0) {
      errors.push(`Camera ${camera.id} must include a compact list description.`);
    } else if (camera.listDescription.length > 30) {
      errors.push(`Camera ${camera.id} compact list description is longer than 30 characters.`);
    }
    for (const targetType of camera.targetTypes) {
      if (!isValidTargetType(targetType)) {
        errors.push(`Camera ${camera.id} has invalid target type: ${String(targetType)}.`);
      }
    }
    if ('durationMs' in camera.recipe || 'stayMs' in camera.recipe || 'requiresTarget' in camera.recipe) {
      errors.push(`Camera ${camera.id} uses deprecated v1 recipe fields.`);
    }
    if (!isValidStrategy(camera.recipe.strategy)) {
      errors.push(`Camera ${camera.id} has invalid recipe strategy: ${String(camera.recipe.strategy)}.`);
    }
    validateRecipeAdjustment(camera.id, camera.recipe, errors, 'recipe');
    if (camera.options && hasDuplicates(camera.options.map((option) => option.id))) {
      errors.push(`Camera ${camera.id} has duplicate option ids.`);
    }
    if (
      camera.defaultOptionId !== undefined &&
      !camera.options?.some((option) => option.id === camera.defaultOptionId)
    ) {
      errors.push(`Camera ${camera.id} defaultOptionId must reference an existing option.`);
    }
    if (camera.optionKind !== undefined && !['duration', 'pace', 'angle'].includes(camera.optionKind)) {
      errors.push(`Camera ${camera.id} has invalid optionKind: ${String(camera.optionKind)}.`);
    }
    for (const option of camera.options ?? []) {
      if ('overrides' in option) {
        errors.push(`Camera ${camera.id} option ${option.id} uses deprecated overrides.`);
      }
      validateRecipeAdjustment(camera.id, option.adjustment, errors, `option ${option.id}`);
    }
  }

  for (const defaultRule of catalog.defaults) {
    const camera = cameraById.get(defaultRule.cameraId);
    if (!isRecommendedPurpose(defaultRule.purpose)) {
      errors.push(`Default rule has invalid purpose: ${String(defaultRule.purpose)}.`);
    }
    if (!isValidTargetType(defaultRule.targetType)) {
      errors.push(`Default rule has invalid target type: ${String(defaultRule.targetType)}.`);
    }
    if (!camera) {
      errors.push(`Default rule references missing camera: ${defaultRule.cameraId}.`);
      continue;
    }
    if (camera.purpose !== defaultRule.purpose) {
      errors.push(
        `Default rule ${defaultRule.purpose}:${defaultRule.targetType} references ${camera.id} from ${camera.purpose}.`,
      );
    }
    if (!camera.targetTypes.includes(defaultRule.targetType)) {
      errors.push(`Default rule ${defaultRule.purpose}:${defaultRule.targetType} references an incompatible camera.`);
    }
  }

  return errors;
}

export const cameraCatalogValidationErrors = validateCameraCatalog(cameraCatalog);

if (cameraCatalogValidationErrors.length > 0) {
  console.error('Camera catalog validation failed:', cameraCatalogValidationErrors);
}

export function getCameraById(cameraId: string) {
  return cameraCatalog.cameras.find((camera) => camera.id === cameraId);
}

export function getCameraCategory(cameraId: string) {
  const camera = getCameraById(cameraId);
  return camera?.purpose ?? camera?.manualGroup ?? 'basic';
}

export function getRecommendedPurposes() {
  return cameraCatalog.taxonomy.purposes.filter((purpose) => isRecommendedPurpose(purpose.id));
}

export function getRecommendedCamerasByPurpose(purpose: string) {
  return cameraCatalog.cameras.filter(
    (camera) => !camera.hiddenFromLibrary && camera.mode === 'recommended' && camera.purpose === purpose,
  );
}

export function getManualCameraGroups(): ManualCameraGroup[] {
  const groups = new Map<string, CameraLibraryCamera[]>();

  for (const camera of cameraCatalog.cameras) {
    if (camera.hiddenFromLibrary || camera.mode !== 'manual') {
      continue;
    }
    const groupId = camera.manualGroup ?? 'basic';
    groups.set(groupId, [...(groups.get(groupId) ?? []), camera]);
  }

  return Array.from(groups.entries()).map(([id, cameras]) => ({
    id,
    title: MANUAL_GROUP_TITLES[id] ?? id,
    cameras,
  }));
}
