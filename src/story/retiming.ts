import type { CameraMovement } from '../interfaces';
import type { SerializedCameraTrajectory, TrajectoryCertification } from '../camera/trajectory/types';
import { computeTrajectoryDigest, validateCommittedTrajectoryPlanForMovement } from '../camera/trajectory/validation';

/** Apply explicit timeline timing without replacing a route with its endpoints. */
export function preserveAppliedPathAfterTimingEdit(previous: CameraMovement, edited: CameraMovement): CameraMovement {
  const changed =
    previous.duration !== edited.duration ||
    previous.stay !== edited.stay ||
    previous.startDelay !== edited.startDelay ||
    previous.interpolationDuration !== edited.interpolationDuration;
  if (!changed) return edited;
  let result = { ...edited };
  const plan = previous.trajectoryPlan;
  if (plan && previous.duration !== edited.duration) {
    const valid = validateCommittedTrajectoryPlanForMovement(plan, previous);
    if (valid.status === 'error') throw new TypeError(`Cannot retime invalid applied trajectory: ${valid.reason}`);
    const source = valid.value.trajectory;
    // A moving keyframed shot needs an interval. Keep its keys editable even at
    // the smallest timeline width, instead of destructively collapsing the path.
    const duration = source.kind === 'keyframed' ? Math.max(1, edited.duration) : edited.duration;
    const scaleTime = (time: number) => (source.durationMs > 0 ? (time / source.durationMs) * duration : 0);
    const trajectory: SerializedCameraTrajectory =
      source.kind === 'hold'
        ? {
            ...source,
            durationMs: duration,
            keyframes: [
              { ...source.keyframes[0], timeMs: 0 },
              { ...source.keyframes[1], timeMs: duration },
            ],
          }
        : source.kind === 'keyframed'
          ? {
              ...source,
              durationMs: duration,
              keyframes: source.keyframes.map((frame, index) => ({
                ...frame,
                timeMs: index === source.keyframes.length - 1 ? duration : scaleTime(frame.timeMs),
              })),
            }
          : { ...source, durationMs: duration };
    const certification: TrajectoryCertification =
      plan.certification.status === 'unsafe'
        ? { ...plan.certification, worstTimeMs: scaleTime(plan.certification.worstTimeMs) }
        : plan.certification.status === 'legacy-unverified'
          ? {
              status: 'legacy-unverified',
              observations: { samples: [], minimumSlackPx: null, evaluationCount: 0, intervalBoundCount: 0 },
            }
          : { status: 'unknown', reason: 'interval-bound-unavailable' };
    result = {
      ...result,
      duration,
      stay: Math.max(0, edited.stay - (duration - edited.duration)),
      trajectoryPlan: { ...plan, trajectory, trajectoryDigest: computeTrajectoryDigest(trajectory), certification },
      ...(edited.framingReport
        ? {
            framingReport: {
              ...edited.framingReport,
              ...(edited.framingReport.worstTimeMs !== undefined
                ? { worstTimeMs: scaleTime(edited.framingReport.worstTimeMs) }
                : {}),
            },
          }
        : {}),
    };
  }
  if (result.authoring) {
    result.authoring = {
      ...result.authoring,
      timing: {
        ...result.authoring.timing,
        duration: result.duration,
        stay: result.stay,
        startDelay: result.startDelay ?? 0,
      },
    };
  }
  return result;
}
