export function resolveTrajectoryV2Enabled(value: unknown): boolean {
  return value === undefined || value === true;
}

export const trajectoryV2Enabled = resolveTrajectoryV2Enabled(
  typeof __GEO_CAMERA_TRAJECTORY_V2__ === 'undefined' ? undefined : __GEO_CAMERA_TRAJECTORY_V2__,
);
