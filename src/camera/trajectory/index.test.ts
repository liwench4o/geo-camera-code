import { resolveTrajectoryV2Enabled, trajectoryV2Enabled } from './index';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(resolveTrajectoryV2Enabled(true), 'the literal boolean true enables trajectory v2');
assert(resolveTrajectoryV2Enabled(undefined), 'omitted runtime flag enables the default shared sampler');
for (const value of [false, null, 1, 'true', {}, []]) {
  assert(!resolveTrajectoryV2Enabled(value), 'trajectory v2 rejects truthy or string-like runtime values');
}
assert(trajectoryV2Enabled === true, 'default builds use the shared sampler');
