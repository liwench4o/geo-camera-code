import type { CameraMovement } from '../interfaces';
import { getCameraPlanningViewport, getPlaybackViewportLayout } from './planning-viewport';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const camera = {
  authoring: { planningViewport: { width: 1440, height: 900 } },
} as CameraMovement;
const available = { width: 800, height: 600 };
const layout = getPlaybackViewportLayout(camera, available);
assert(layout.viewport.width === 1440 && layout.viewport.height === 900, 'preserve original projection dimensions');
assert(layout.width === 800 && layout.height === 500, 'scale original frame into available area');
assert(layout.left === 0 && layout.top === 50 && layout.letterboxed, 'center frame with top and bottom bars');
assert(layout.scale === 800 / 1440, 'provide CSS scale for original pixel viewport');
assert(getCameraPlanningViewport(camera)?.height === 900, 'authoring owns the viewport');
const none = getPlaybackViewportLayout(undefined, available);
assert(
  none.width === 800 && none.height === 600 && !none.letterboxed && none.scale === 1,
  'legacy cameras use available space',
);
const legacy = {
  trajectoryPlan: { trajectory: { kind: 'legacy-fly', viewport: { width: 1200, height: 600 } } },
} as CameraMovement;
assert(getCameraPlanningViewport(legacy)?.width === 1200, 'imported legacy fly uses its sealed viewport');
assert(getPlaybackViewportLayout(legacy, available).top === 100, 'legacy fly keeps its original aspect');
