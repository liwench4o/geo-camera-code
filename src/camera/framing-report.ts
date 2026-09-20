import type { CameraMovement } from '../interfaces';
import type { CameraFramingReport } from './authoring-types';
import { shortestAngle } from './geometry/geo-wrap';
import type { WorldPosition } from './geometry/types';
import { resolveCameraRecipe } from './recipes';
import { createPathTarget } from './selection';
import { isRouteFollowing, routeGeometry } from './shot-trajectory';
import { compileRuntimeTrajectory } from './trajectory/sampler';
import type { RuntimeCameraTrajectory, TrajectorySlackSample } from './trajectory/types';
import type { CameraRecipe, CameraTarget, ViewportSize } from './types';
import { getDefaultViewportSize, getProjectedVisualBounds, isFiniteCameraView } from './viewport';
import { compositionTarget, resolvedMotion } from './motion-intent';

export interface CameraInspection {
  report: CameraFramingReport;
  samples: TrajectorySlackSample[];
  complete: boolean;
  fits: boolean;
  valid: boolean;
}

function routeWindowPrimitive(target: CameraTarget) {
  const primitives = target.snapshotEnvelope?.frame.primitives;
  if (primitives?.length !== 1 || primitives[0].kind !== 'path-corridor') return undefined;
  const primitive = primitives[0];
  const route = routeGeometry(target);
  return primitive.positions.length === route.path.length &&
    primitive.positions.every(
      (point, index) =>
        Math.abs(shortestAngle(point[0], route.path[index][0])) < 1e-5 &&
        Math.abs(point[1] - route.path[index][1]) < 1e-5,
    )
    ? primitive
    : undefined;
}

function scopeFor(recipe: CameraRecipe, target?: CameraTarget): CameraFramingReport['scope'] {
  if (!target || target.type === 'none') return 'targetless';
  if (isRouteFollowing(recipe, target))
    return target.snapshotEnvelope && !routeWindowPrimitive(target) ? 'whole-shot' : 'route-window';
  if (
    (recipe.purpose === 'comparison' && recipe.strategy === 'pull-out') ||
    recipe.strategy === 'pan' ||
    recipe.strategy === 'pan-tilt' ||
    recipe.strategy === 'pan-push-in'
  )
    return 'endpoints';
  return 'whole-shot';
}

function localRouteTarget(target: CameraTarget, progress: number, route = routeGeometry(target)): CameraTarget {
  // Elapsed shot progress has the same meaning as the committed route: source timestamp
  // progress for trips (including stops), and traveled arc distance for untimed routes.
  const start = Math.max(0, progress - 0.08);
  const end = Math.min(1, progress + 0.08);
  const points = [
    route.pointAt(start),
    ...route.progress.filter((value) => value > start && value < end).map(route.pointAt),
    route.pointAt(end),
  ];
  const local: CameraTarget = createPathTarget(points)!;
  if (target.snapshotEnvelope) {
    const corridor = routeWindowPrimitive(target);
    if (corridor) {
      const positionAt = (value: number): WorldPosition => {
        let index = 0;
        while (index < route.progress.length - 2 && route.progress[index + 1] < value) index++;
        const fraction = (value - route.progress[index]) / (route.progress[index + 1] - route.progress[index]);
        const first = corridor.positions[index];
        const last = corridor.positions[index + 1];
        return [...route.pointAt(value), (first[2] ?? 0) + ((last[2] ?? 0) - (first[2] ?? 0)) * fraction];
      };
      const positions = [
        positionAt(start),
        ...route.progress.filter((value) => value > start && value < end).map(positionAt),
        positionAt(end),
      ];
      local.snapshotEnvelope = {
        ...target.snapshotEnvelope,
        frame: {
          ...target.snapshotEnvelope.frame,
          primitives: [{ ...corridor, positions }],
          anchor: [...route.pointAt(progress), 0],
        },
      };
    }
  }
  return local;
}

/** Bounded engineering sampling. It never produces a continuous visibility certificate. */
export function inspectCameraTrajectory(
  camera: CameraMovement,
  runtime: RuntimeCameraTrajectory,
  viewport: ViewportSize,
  sampleBudget?: number,
): CameraInspection {
  const recipe = resolveCameraRecipe(camera.recipeId ?? camera.name, camera.authoring?.optionSelection);
  const target = camera.targetSnapshot as CameraTarget | undefined;
  const scope = scopeFor(recipe, target);
  const report: CameraFramingReport = {
    status: 'passed',
    scope,
    sampleCount: 0,
    messages: [],
    inputRevision: target?.snapshotEnvelope?.revision,
    requestedMotion: camera.authoring?.motion ? { ...camera.authoring.motion } : undefined,
    resolvedMotion: resolvedMotion(camera),
  };
  const duration = runtime.serialized.durationMs;
  const critical = runtime.criticalTimes(0, duration);
  const budget = sampleBudget ?? Math.min(4097, Math.max(193, critical.length * 2 + 17));
  const route = target && scope === 'route-window' ? routeGeometry(target) : undefined;
  const padding = Math.min(viewport.width, viewport.height) * (camera.authoring?.adjustments.safetyMarginRatio ?? 0.1);
  const observations = new Map<number, { slack: number | null; bearing: number; pitch: number }>();
  let complete = true;
  let valid = true;
  let fits = true;
  const comparison = camera.comparisonTargetSnapshots as CameraTarget[] | undefined;
  const compositionTargets = new Map<CameraTarget, CameraTarget>();
  const evaluate = (time: number) => {
    if (observations.has(time)) return;
    if (observations.size >= budget) {
      complete = false;
      return;
    }
    const view = runtime.sample(time);
    if (!isFiniteCameraView(view, viewport)) {
      valid = false;
      fits = false;
      observations.set(time, { slack: null, bearing: view.bearing, pitch: view.pitch });
      return;
    }
    let checkedTarget = target;
    if (target && scope === 'route-window')
      checkedTarget = localRouteTarget(target, duration > 0 ? time / duration : 1, route);
    else if (scope === 'endpoints' && recipe.purpose === 'comparison' && comparison?.length)
      checkedTarget =
        time === 0 ? comparison[0] : recipe.strategy === 'pull-out' ? target : comparison[comparison.length - 1];
    else if (scope === 'endpoints' && time === 0 && recipe.purpose !== 'comparison') checkedTarget = undefined;
    if (checkedTarget && camera.authoring?.composition?.context) {
      if (!compositionTargets.has(checkedTarget))
        compositionTargets.set(checkedTarget, compositionTarget(checkedTarget, camera.authoring.composition));
      checkedTarget = compositionTargets.get(checkedTarget)!;
    }
    const bounds =
      checkedTarget && checkedTarget.type !== 'none'
        ? getProjectedVisualBounds(view, checkedTarget, viewport)
        : undefined;
    const slack =
      checkedTarget && checkedTarget.type !== 'none'
        ? bounds
          ? Math.min(bounds.minX, bounds.minY, viewport.width - bounds.maxX, viewport.height - bounds.maxY) - padding
          : null
        : 0;
    if (slack === null) {
      complete = false;
      valid = false;
      fits = false;
    } else if (slack < -0.5) fits = false;
    observations.set(time, { slack, bearing: view.bearing, pitch: view.pitch });
  };
  const times =
    scope === 'endpoints'
      ? [0, duration]
      : Array.from(
          new Set([
            ...critical,
            ...Array.from({ length: duration === 0 ? 1 : 17 }, (_, index) => (duration * index) / 16),
          ]),
        ).sort((a, b) => a - b);
  times.forEach(evaluate);
  if (scope !== 'endpoints' && scope !== 'targetless') {
    for (let depth = 0; depth < 3 && complete; depth++) {
      const ordered = [...observations.keys()].sort((a, b) => a - b);
      for (let index = 1; index < ordered.length; index++) {
        const start = ordered[index - 1];
        const end = ordered[index];
        const first = observations.get(start)!;
        const last = observations.get(end)!;
        if (
          end - start > 60 &&
          (Math.abs(last.bearing - first.bearing) > 12 ||
            Math.abs(last.pitch - first.pitch) > 8 ||
            Math.min(first.slack ?? -Infinity, last.slack ?? -Infinity) < padding * 0.5)
        )
          evaluate((start + end) / 2);
      }
    }
  }
  const samples = [...observations.entries()]
    .sort(([a], [b]) => a - b)
    .map(([timeMs, entry]) => ({ timeMs, slackPx: entry.slack }));
  const finite = samples.filter((sample): sample is { timeMs: number; slackPx: number } => sample.slackPx !== null);
  const worst = finite.reduce<{ timeMs: number; slackPx: number } | undefined>(
    (result, sample) => (!result || sample.slackPx < result.slackPx ? sample : result),
    undefined,
  );
  report.sampleCount = samples.length;
  if (worst && scope !== 'targetless') {
    report.minMarginPx = worst.slackPx + padding;
    report.worstTimeMs = worst.timeMs;
  }
  if (!complete) {
    report.status = 'incomplete';
    report.messages.push(
      valid
        ? 'Framing checks could not finish. Full visibility has not been confirmed.'
        : 'Some camera positions or target projections are invalid; correct the view before applying.',
    );
  } else if (!fits) {
    report.status = 'warning';
    report.messages.push(
      'The selected framing crops content or leaves less than the requested safety margin. You can keep this close-up or fit the whole target.',
    );
  }
  if (
    target &&
    scope !== 'targetless' &&
    !target.snapshotEnvelope &&
    !target.children?.every((child) => child.snapshotEnvelope)
  ) {
    if (report.status === 'passed') report.status = 'warning';
    report.messages.push('Framing was checked against the saved geometry estimate; renderer geometry was unavailable.');
  } else if (target?.snapshotEnvelope?.supportGuarantee === 'legacy-approximation') {
    if (report.status === 'passed') report.status = 'warning';
    report.messages.push('This snapshot contains approximate geometry.');
  }
  if (scope === 'route-window')
    report.messages.push(
      target?.timedPath
        ? 'Checks cover the local time window while the camera follows the animated route.'
        : 'Checks cover the local route window while the camera follows the route.',
    );
  else if (target && isRouteFollowing(recipe, target))
    report.messages.push(
      'The renderer geometry could not be separated into a local route window, so the complete rendered target was checked.',
    );
  else if (scope === 'endpoints')
    report.messages.push(
      'Checks cover each target at its endpoint presentation; the transition may pass between targets.',
    );
  if (recipe.strategy === 'static' && runtime.serialized.kind !== 'hold' && camera.authoring?.manualViews) {
    if (report.status === 'passed') report.status = 'warning';
    report.messages.push(
      'Your different start and end views were retained; this static template now moves between them.',
    );
  }
  if (!report.messages.length)
    report.messages.push(
      scope === 'targetless'
        ? 'Camera values and trajectory are valid.'
        : 'The target fits at the checked moments in this shot.',
    );
  return { report, samples, complete, fits, valid };
}

export function inspectCameraMovement(
  camera: CameraMovement,
  viewport = camera.authoring?.planningViewport ?? getDefaultViewportSize(),
  sampleBudget?: number,
): CameraInspection {
  if (!camera.trajectoryPlan) throw new Error('This camera has no committed trajectory to inspect.');
  const compiled = compileRuntimeTrajectory(camera.trajectoryPlan.trajectory);
  if (compiled.status !== 'ok') throw new Error(compiled.reason);
  return inspectCameraTrajectory(camera, compiled.value, viewport, sampleBudget);
}
