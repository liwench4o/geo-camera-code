import _ from 'lodash';
import { getCameraCategory, getCameraTitle } from '../util';
import type { CameraBaseViewSource, CameraDebugReasonGroup, CameraMovement } from '../interfaces';
import { createMultipleTarget, createTargetFromView } from './selection';
import { clampViewState, getDefaultViewportSize, isFiniteCameraView } from './viewport';
import { isCameraImplemented, resolveCameraRecipe } from './recipes';
import { cameraCatalog, getCameraById } from './catalog';
import { planCameraViews } from './strategies';
import { computeViewDisplacement, resolveAdaptiveDuration } from './timing';
import { resolveFramingTuning } from './tuning';
import type { CameraPlanInput, CameraPlanResult, CameraRecipe, CameraTarget } from './types';
import type { CameraFramingReport } from './authoring-types';
import { digestCanonical } from './geometry/canonical-digest';
import { buildShotTrajectory, isRouteFollowing } from './shot-trajectory';
import { createAnimationBinding } from '../story/scene-time';
import { compileRuntimeTrajectory } from './trajectory/sampler';
import { inspectCameraTrajectory } from './framing-report';
import { normalizeCameraAuthoringSpec, normalizeCameraAuthoringView } from './authoring';
import { alignMotionComposition, applyMotionIntent, resolvedMotion, updateMotionDuration } from './motion-intent';
export { inspectCameraMovement } from './framing-report';

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getCategory(cameraName: string) {
  return getCameraCategory(cameraName);
}

function isCurrentViewBaseRecipe(recipe: CameraRecipe) {
  return recipe.purpose === 'dynamic' || (recipe.purpose === 'basic' && !recipe.requiresTarget);
}

function getDefaultBaseViewMode(recipe: CameraRecipe) {
  return isCurrentViewBaseRecipe(recipe) ? 'current-view' : 'previous-camera';
}

export function createCameraBaseViewMode(recipe: CameraRecipe, previousCamera?: CameraMovement): CameraBaseViewSource {
  if (previousCamera?.finalViewState) {
    return 'previous-camera';
  }

  return getDefaultBaseViewMode(recipe);
}

function getBaseView(input: CameraPlanInput, recipe: CameraRecipe) {
  if (input.authoring?.source) {
    return {
      view: _.cloneDeep(input.authoring.source.view),
      source:
        input.authoring.source.kind === 'previous-camera' ? ('previous-camera' as const) : ('current-view' as const),
      reason: 'The camera starts from the saved source view; later map changes do not replace it.',
    };
  }
  const mode = input.baseViewMode ?? getDefaultBaseViewMode(recipe);

  if (mode === 'current-view') {
    return {
      view: _.cloneDeep(input.currentViewState),
      source: 'current-view' as const,
      reason:
        recipe.purpose === 'dynamic'
          ? 'Dynamic camera starts from the visible map view.'
          : 'Current-view camera starts from the visible map view.',
    };
  }

  if (input.previousCamera?.finalViewState) {
    return {
      view: _.cloneDeep(input.previousCamera.finalViewState),
      source: 'previous-camera' as const,
      reason: 'Target-based camera continues from the previous camera final view.',
    };
  }

  return {
    view: _.cloneDeep(input.currentViewState),
    source: 'current-view' as const,
    reason: 'No previous camera is available, so the camera starts from the visible map view.',
  };
}

function addReason(
  reasons: Partial<Record<CameraDebugReasonGroup, string[]>>,
  group: CameraDebugReasonGroup,
  reason: string,
) {
  reasons[group] = Array.from(new Set([...(reasons[group] ?? []), reason]));
}

function mergeReasons(
  ...groups: Partial<Record<CameraDebugReasonGroup, string[]>>[]
): Partial<Record<CameraDebugReasonGroup, string[]>> {
  const merged: Partial<Record<CameraDebugReasonGroup, string[]>> = {};
  for (const group of groups) {
    for (const [key, values] of Object.entries(group) as [CameraDebugReasonGroup, string[]][]) {
      for (const value of values) {
        addReason(merged, key, value);
      }
    }
  }
  return merged;
}

function getRecommendation(input: CameraPlanInput, recipe: CameraRecipe) {
  const camera = getCameraById(input.cameraName);

  return {
    recipeId: input.cameraName,
    source: recipe.optionSelection ? ('camera-option' as const) : ('resolved-recipe' as const),
    optionId: recipe.optionSelection?.id,
    optionLabel: recipe.optionSelection?.label,
    mode: camera?.mode,
    purpose: recipe.purpose,
    profileId: recipe.profile.id,
  };
}

function planViews(
  input: CameraPlanInput,
  target: CameraTarget,
  recipe: CameraRecipe,
  baseView: CameraPlanInput['currentViewState'],
) {
  return {
    plannedViews: planCameraViews({
      input,
      recipe,
      target,
      baseView,
    }),
  };
}

function createMovement(input: CameraPlanInput): CameraPlanResult {
  if (!isCameraImplemented(input.cameraName)) {
    throw new Error(`Camera movement "${input.cameraName}" is not implemented yet.`);
  }

  const recipe = resolveCameraRecipe(input.cameraName, input.optionSelection);
  const framingTuning = resolveFramingTuning(recipe.purpose, input.framingTuning, cameraCatalog.tuning);
  const planInput: CameraPlanInput = { ...input, framingTuning };
  const baseView = getBaseView(planInput, recipe);
  if (isCurrentViewBaseRecipe(recipe) && framingTuning.pitchTarget !== undefined) {
    baseView.view = clampViewState({ ...baseView.view, pitch: Math.min(75, Math.max(0, framingTuning.pitchTarget)) });
  }
  const inputTarget =
    recipe.purpose === 'dynamic' || isCurrentViewBaseRecipe(recipe)
      ? undefined
      : recipe.purpose === 'comparison' && (planInput.comparisonTargets?.length ?? 0) > 1
        ? createMultipleTarget(planInput.comparisonTargets!)
        : planInput.target;
  const target =
    inputTarget ??
    (recipe.purpose === 'comparison' && (planInput.comparisonTargets?.length ?? 0) > 1
      ? createMultipleTarget(planInput.comparisonTargets ?? [])
      : createTargetFromView(baseView.view, recipe.requiresTarget ? recipe.targetTypes[0] : 'none'));
  const { plannedViews } = planViews(planInput, target, recipe, baseView.view);
  const reasons = mergeReasons(
    {
      profile: [recipe.profile.reason],
      baseView: [baseView.reason],
      option: recipe.optionSelection
        ? [`Selected option "${recipe.optionSelection.label}" adjusted the structured recipe parameters.`]
        : ['No option selected; using the resolved profile and recipe defaults.'],
    },
    plannedViews.reasons,
  );
  const displacement = computeViewDisplacement(plannedViews.initView, plannedViews.finalView, planInput.viewportSize);
  const adaptiveDuration = resolveAdaptiveDuration({
    recipe,
    displacement,
    pathLengthKm: target.stats?.pathLengthKm,
    speedScale: framingTuning.speedScale,
  });
  addReason(reasons, 'content', adaptiveDuration.reason);
  const duration = adaptiveDuration.durationMs;

  const cameraMovement: CameraMovement = {
    id: createId('camera'),
    name: planInput.cameraName,
    title: getCameraTitle(planInput.cameraName),
    category: getCategory(planInput.cameraName),
    purpose: recipe.purpose,
    shot: recipe.shots.join('+'),
    targetId: target.id,
    targetSnapshot: target,
    recipeId: planInput.cameraName,
    recommendation: getRecommendation(planInput, recipe),
    debugInfo: {
      recipeId: planInput.cameraName,
      profileId: recipe.profile.id,
      optionId: recipe.optionSelection?.id,
      baseViewSource: baseView.source,
      reasons,
      metrics: plannedViews.metrics,
      resolvedParameters: {
        durationMs: duration,
        stayMs: recipe.stay,
        paddingRatio: plannedViews.resolvedParameters.paddingRatio,
        zoomBias: plannedViews.resolvedParameters.zoomBias,
        pitchTarget: plannedViews.resolvedParameters.pitchTarget,
        bearingDelta: plannedViews.resolvedParameters.bearingDelta,
        anchorHeightRatio: plannedViews.resolvedParameters.anchorHeightRatio,
        offsetRatio: plannedViews.resolvedParameters.offsetRatio,
        displacement: Number(displacement.toFixed(3)),
        speedTier: adaptiveDuration.speedTier,
      },
    },
    recommendationBaseViewState: _.cloneDeep(baseView.view),
    comparisonTargetSnapshots: planInput.comparisonTargets ? _.cloneDeep(planInput.comparisonTargets) : undefined,
    presentation: recipe.presentation,
    initViewState: clampViewState(plannedViews.initView),
    finalViewState: clampViewState(plannedViews.finalView),
    duration,
    stay: recipe.stay,
    isRotating: recipe.isRotating,
    interpolationType: recipe.interpolationType,
    interpolationDuration: recipe.interpolationDuration,
  };

  return {
    cameraMovement,
    target,
  };
}

export type AdaptiveCameraPlanResult =
  | ({ status: 'planned' } & CameraPlanResult)
  | { status: 'no-suggestion'; reason: string; report: CameraFramingReport };

export function planAdaptiveCamera(input: CameraPlanInput): AdaptiveCameraPlanResult {
  const viewport = input.viewportSize ?? input.authoring?.planningViewport ?? getDefaultViewportSize();
  try {
    const authoring = input.authoring ? normalizeCameraAuthoringSpec(input.authoring) : undefined;
    if (!isFiniteCameraView(authoring?.source?.view ?? input.currentViewState, viewport))
      throw new Error('The source camera view or planning canvas is invalid.');
    const adjustments = { ...authoring?.adjustments, ...input.framingTuning };
    const planInput = {
      ...input,
      authoring,
      optionSelection: input.optionSelection ?? authoring?.optionSelection,
      framingTuning: adjustments,
      viewportSize: viewport,
    };
    const result = createMovement(planInput);
    const camera = result.cameraMovement;
    const recipe = resolveCameraRecipe(input.cameraName, planInput.optionSelection);
    // Capture the actual chosen source, before recipe framing adjusts its pitch or distance.
    const sourceView = getBaseView(planInput, recipe);
    camera.authoring = {
      version: authoring?.version ?? 1,
      targetId: result.target.id,
      recipeId: input.cameraName,
      snapshotRevision: result.target.snapshotEnvelope?.revision,
      sceneRevision: authoring?.sceneRevision ?? result.target.snapshotEnvelope?.provenance.sceneRevision,
      optionSelection: planInput.optionSelection,
      adjustments: { ...adjustments },
      motion: _.cloneDeep(authoring?.motion),
      composition: _.cloneDeep(authoring?.composition),
      source: _.cloneDeep(
        authoring?.source ??
          (authoring?.version === 2
            ? {
                kind: sourceView.source,
                view: normalizeCameraAuthoringView(sourceView.view),
              }
            : undefined),
      ),
      transition: authoring?.transition,
      manualViews: _.cloneDeep(authoring?.manualViews),
      timing: _.cloneDeep(authoring?.timing),
      planningViewport: { ...viewport },
    };
    applyMotionIntent(camera, recipe, result.target, viewport);
    if (authoring?.manualViews?.initial) camera.initViewState = _.cloneDeep(authoring.manualViews.initial);
    if (authoring?.manualViews?.final) camera.finalViewState = _.cloneDeep(authoring.manualViews.final);
    if (authoring?.timing?.duration !== undefined) camera.duration = authoring.timing.duration;
    if (authoring?.timing?.stay !== undefined) camera.stay = authoring.timing.stay;
    if (authoring?.timing?.startDelay !== undefined) camera.startDelay = authoring.timing.startDelay;
    if (![camera.duration, camera.stay, camera.startDelay ?? 0].every((value) => Number.isFinite(value) && value >= 0))
      throw new Error('Camera timing must contain finite non-negative values.');
    if (![camera.initViewState, camera.finalViewState].every((view) => isFiniteCameraView(view, viewport)))
      throw new Error('A manual camera view has invalid values or an unsupported projection.');
    const manual = Boolean(authoring?.manualViews?.initial || authoring?.manualViews?.final);
    const corrections: string[] = [];
    const explainCorrection = (message: string) => {
      if (!corrections.includes(message)) corrections.push(message);
    };
    if (
      recipe.strategy.includes('pan') &&
      recipe.purpose !== 'comparison' &&
      authoring?.motion?.zoomDelta !== undefined &&
      !authoring.manualViews?.initial &&
      camera.initViewState.zoom < sourceView.view.zoom - 1e-6
    ) {
      explainCorrection('The source and target views were widened together to keep the target inside the frame.');
    }
    const requestedPitch =
      authoring?.motion?.endPitch ?? adjustments.pitchTarget ?? camera.debugInfo?.resolvedParameters?.pitchTarget ?? 0;
    if (!manual && camera.finalViewState.pitch < requestedPitch - 0.1) {
      explainCorrection('The viewing angle was lowered to keep the target inside the frame.');
    }
    for (let attempt = 0; attempt <= 28; attempt++) {
      updateMotionDuration(camera, recipe, result.target, viewport);
      let serialized = buildShotTrajectory(camera, recipe, result.target);
      // Route look-ahead/smoothing is measured in shot seconds. Resolve its endpoint headings
      // and automatic duration together before checking or committing that exact movement.
      for (let timingAttempt = 0; timingAttempt < 16; timingAttempt++) {
        const resolvedEndpoints =
          serialized.kind === 'hold' || serialized.kind === 'keyframed'
            ? [serialized.keyframes[0].view, serialized.keyframes[serialized.keyframes.length - 1].view]
            : [serialized.initView, serialized.finalView];
        camera.initViewState = { ...camera.initViewState, ...resolvedEndpoints[0] };
        camera.finalViewState = { ...camera.finalViewState, ...resolvedEndpoints[1] };
        updateMotionDuration(camera, recipe, result.target, viewport);
        if (serialized.durationMs === camera.duration) break;
        serialized = buildShotTrajectory(camera, recipe, result.target);
      }
      const compiled = compileRuntimeTrajectory(serialized);
      if (compiled.status !== 'ok') throw new Error(compiled.reason);
      const inspection = inspectCameraTrajectory(camera, compiled.value, viewport);
      const unsafeAutomaticEndpoint = inspection.samples.some(
        (sample) =>
          ((sample.timeMs === 0 && !authoring?.manualViews?.initial) ||
            (sample.timeMs === camera.duration && !authoring?.manualViews?.final)) &&
          (sample.slackPx === null || sample.slackPx < -0.5),
      );
      if (
        (inspection.complete && inspection.fits) ||
        (manual && !unsafeAutomaticEndpoint && inspection.valid && inspection.complete)
      ) {
        if (!manual && isRouteFollowing(recipe, result.target))
          camera.animationBinding = createAnimationBinding(result.target);
        // Persist exactly the trajectory's serialized endpoints. Sampling normalizes longitude
        // (and unwraps bearing), which may change a fractional coordinate by a few ULPs.
        const endpoints =
          serialized.kind === 'hold' || serialized.kind === 'keyframed'
            ? [serialized.keyframes[0].view, serialized.keyframes[serialized.keyframes.length - 1].view]
            : [serialized.initView, serialized.finalView];
        camera.initViewState = { ...camera.initViewState, ...endpoints[0] };
        camera.finalViewState = { ...camera.finalViewState, ...endpoints[1] };
        camera.framingReport = {
          ...inspection.report,
          resolvedMotion: resolvedMotion(camera),
          messages: [...inspection.report.messages, ...corrections],
        };
        // Preliminary fits can be unprojectable even when the corrected trajectory succeeds.
        // Keep those missing measurements out of persisted diagnostics; the report above owns final observations.
        if (camera.debugInfo?.metrics) {
          camera.debugInfo.metrics = Object.fromEntries(
            Object.entries(camera.debugInfo.metrics).filter(
              ([, value]) => typeof value !== 'number' || Number.isFinite(value),
            ),
          );
        }
        camera.trajectoryPlan = {
          inputDigest: digestCanonical({
            authoring: camera.authoring,
            targetRevision: result.target.snapshotEnvelope?.revision,
            ...(camera.animationBinding ? { animationBinding: camera.animationBinding } : {}),
            trajectory: serialized,
          }),
          trajectory: serialized,
          trajectoryDigest: compiled.value.digest,
          certification: {
            status: 'legacy-unverified',
            observations: {
              samples: inspection.samples,
              minimumSlackPx: inspection.samples.reduce<number | null>(
                (minimum, sample) =>
                  sample.slackPx === null
                    ? minimum
                    : minimum === null
                      ? sample.slackPx
                      : Math.min(minimum, sample.slackPx),
                null,
              ),
              evaluationCount: inspection.samples.length,
              intervalBoundCount: 0,
            },
          },
        };
        return { status: 'planned', ...result, report: camera.framingReport };
      }
      if ((manual && !unsafeAutomaticEndpoint) || attempt === 28 || (inspection.valid && !inspection.complete))
        return {
          status: 'no-suggestion',
          reason:
            manual && !unsafeAutomaticEndpoint
              ? 'This manual view cannot be projected reliably. Adjust it before applying.'
              : 'No complete automatic framing was found within the available zoom, angle, and checking budget. Try a wider view or select a static shot.',
          report: inspection.report,
        };
      const views = [
        ...(!authoring?.manualViews?.initial ? [camera.initViewState] : []),
        ...(!authoring?.manualViews?.final ? [camera.finalViewState] : []),
      ];
      const canWiden = views.some((view) => view.zoom > (view.minZoom ?? 0));
      if (attempt < 16 && canWiden) {
        if (!manual && authoring?.motion?.zoomDelta !== undefined) {
          const widening = Math.max(0, Math.min(0.25, ...views.map((view) => view.zoom - (view.minZoom ?? -2))));
          for (const view of views) view.zoom -= widening;
        } else for (const view of views) view.zoom = Math.max(view.minZoom ?? 0, view.zoom - 0.25);
        explainCorrection('The camera was moved farther away to keep the target inside the frame.');
      } else {
        for (const view of views) view.pitch = Math.max(view.minPitch ?? 0, view.pitch - 6);
        explainCorrection('The viewing angle was lowered because widening alone did not fit the target.');
      }
      alignMotionComposition(camera, recipe, result.target, viewport);
    }
    throw new Error('Camera planning did not finish.');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      status: 'no-suggestion',
      reason,
      report: { status: 'incomplete', scope: 'whole-shot', sampleCount: 0, messages: [reason] },
    };
  }
}

/** Compatible entry point; failed automatic plans are explicit errors rather than accepted cropped suggestions. */
export function createCameraMovement(input: CameraPlanInput): CameraPlanResult {
  const result = planAdaptiveCamera(input);
  if (result.status !== 'planned') throw new Error(result.reason);
  return { cameraMovement: result.cameraMovement, target: result.target, report: result.report };
}
