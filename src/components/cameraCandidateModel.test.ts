import type { CameraMovement } from '../interfaces';
import { applyCameraCandidate } from './cameraCandidateModel';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function camera(id: string): CameraMovement {
  const view = { longitude: 0, latitude: 0, zoom: 5, bearing: 0, pitch: 30 };
  return {
    id,
    name: 'static',
    title: id,
    category: 'overview',
    duration: 1000,
    stay: 200,
    initViewState: view,
    finalViewState: view,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
    authoring: {
      version: 1,
      targetId: 't',
      recipeId: 'static',
      adjustments: {},
      planningViewport: { width: 800, height: 600 },
    },
  };
}

const original = camera('original');
original.annotation = { delay: 0, duration: 1000, text: 'Keep this' };
const other = camera('other');
const candidate = camera('candidate');
candidate.duration = 2500;
candidate.framingReport = { status: 'warning', scope: 'whole-shot', sampleCount: 9, messages: ['Close-up crop'] };
const before = [original, other];

const replaced = applyCameraCandidate(before, candidate, { action: 'replace', index: 0 });
assert(replaced.index === 0, 'replacement retains selected index');
assert(replaced.cameras[0].id === 'original', 'replacement retains stable shot identity');
assert(replaced.cameras[0].annotation?.text === 'Keep this', 'replacement retains annotation');
assert(replaced.cameras[0].duration === 2500, 'automatic timing updates with candidate');
assert(replaced.cameras[0].framingReport?.status === 'warning', 'crop warning is allowed and applied atomically');
assert(replaced.cameras[1] === other, 'unaffected shots retain object identity');
assert(before[0] === original && original.duration === 1000, 'original snapshot remains usable for cancel and undo');

const added = applyCameraCandidate(before, candidate, { action: 'add' });
assert(added.index === 2 && added.cameras.length === 3, 'add appends a new selected shot');
assert(added.cameras[2].id === 'candidate', 'add keeps candidate identity');
assert(added.cameras[2] !== candidate, 'applied snapshot cannot be changed by editing draft');

for (const index of [undefined, -1, 2, 0.5, NaN]) {
  let threw = false;
  try {
    applyCameraCandidate(before, candidate, { action: 'replace', index });
  } catch {
    threw = true;
  }
  assert(threw, 'an unavailable replacement must never overwrite another camera or append silently');
}

let invalidRejected = false;
try {
  applyCameraCandidate(
    before,
    { ...candidate, initViewState: { ...candidate.initViewState, zoom: NaN } },
    { action: 'add' },
  );
} catch {
  invalidRejected = true;
}
assert(invalidRejected, 'invalid camera values must never be committed');
