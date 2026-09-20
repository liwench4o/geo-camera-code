import type { CameraMovement, CameraView } from '../interfaces';
import { applyDraftToCamera, createDraft, resetDraftView, updateDraftView } from './viewStateEditorModel';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertClose(actual: number, expected: number, message: string) {
  assert(Math.abs(actual - expected) < 1e-6, `${message}: expected ${expected}, received ${actual}`);
}

function createView(overrides: Partial<CameraView>): CameraView {
  return {
    longitude: 0,
    latitude: 0,
    zoom: 10,
    pitch: 35,
    bearing: 0,
    minZoom: 0,
    maxZoom: 20,
    minPitch: 0,
    maxPitch: 85,
    ...overrides,
  };
}

function createCamera(id: string, initViewState: CameraView, finalViewState: CameraView): CameraMovement {
  return {
    id,
    name: id,
    title: id,
    category: 'dynamic',
    initViewState,
    finalViewState,
    duration: 1000,
    stay: 0,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
  };
}

function testSavingInitialThenFinalDoesNotOverwriteEarlierSide() {
  const camera = createCamera('camera', createView({ longitude: 1 }), createView({ longitude: 2 }));
  const initialDraft = updateDraftView(createDraft(camera), 'initial', createView({ longitude: 11 }));
  const cameraWithInitial = applyDraftToCamera(camera, initialDraft, 'initial');
  const finalDraft = updateDraftView(createDraft(cameraWithInitial), 'final', createView({ longitude: 22 }));
  const cameraWithBoth = applyDraftToCamera(cameraWithInitial, finalDraft, 'final');

  assertClose(cameraWithBoth.initViewState.longitude, 11, 'saved initial longitude should be preserved');
  assertClose(cameraWithBoth.finalViewState.longitude, 22, 'saved final longitude should update');
  assertClose(
    cameraWithBoth.authoring!.manualViews!.initial!.longitude,
    11,
    'saved initial is a persistent author override',
  );
  assertClose(
    cameraWithBoth.authoring!.manualViews!.final!.longitude,
    22,
    'saved final is a persistent author override',
  );
  assert(cameraWithBoth.framingReport?.status === 'incomplete', 'edited views require a fresh framing check');
}

function testResetDraftViewDoesNotMutateOriginalCamera() {
  const camera = createCamera('camera', createView({ longitude: 1 }), createView({ longitude: 2 }));
  const editedDraft = updateDraftView(createDraft(camera), 'initial', createView({ longitude: 99 }));
  const resetDraft = resetDraftView(editedDraft, 'initial');

  assertClose(resetDraft.initialViewState.longitude, 1, 'reset initial longitude should return to original');
  assertClose(camera.initViewState.longitude, 1, 'original camera initial longitude should not mutate');
  assert(resetDraft !== editedDraft, 'reset should return a new draft object');
}

function testApplyDraftStripsTransitionFieldsBeforeSaving() {
  const camera = createCamera('camera', createView({ longitude: 1 }), createView({ longitude: 2 }));
  const draft = updateDraftView(createDraft(camera), 'final', {
    ...createView({ longitude: 42 }),
    transitionDuration: 1000,
    transitionEasing: () => 0.5,
    transitionInterpolator: { name: 'fly' },
    onTransitionEnd: () => undefined,
  });
  const nextCamera = applyDraftToCamera(camera, draft, 'final');

  assertClose(nextCamera.finalViewState.longitude, 42, 'final longitude should update');
  assert(nextCamera.finalViewState.transitionDuration === 0, 'saved view should cancel transition duration');
  assert(nextCamera.finalViewState.transitionEasing === undefined, 'saved view should clear transition easing');
  assert(
    nextCamera.finalViewState.transitionInterpolator === undefined,
    'saved view should clear transition interpolator',
  );
  assert(nextCamera.finalViewState.onTransitionEnd === undefined, 'saved view should clear transition callback');
}

testSavingInitialThenFinalDoesNotOverwriteEarlierSide();
testResetDraftViewDoesNotMutateOriginalCamera();
testApplyDraftStripsTransitionFieldsBeforeSaving();
