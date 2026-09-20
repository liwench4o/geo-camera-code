import _ from 'lodash';
import type { CameraMovement, CameraView } from '../interfaces';
import { recordCameraManualView } from '../camera/authoring';

export type ViewStateDraftKey = 'initial' | 'final';

export interface ViewStateEditorDraft {
  initialViewState: CameraView;
  finalViewState: CameraView;
  originalInitialViewState: CameraView;
  originalFinalViewState: CameraView;
}

export function stripEditableViewTransition(viewState: CameraView): CameraView {
  return {
    ..._.cloneDeep(viewState),
    transitionDuration: 0,
    transitionEasing: undefined,
    transitionInterpolator: undefined,
    onTransitionEnd: undefined,
  };
}

export function createDraft(camera: CameraMovement): ViewStateEditorDraft {
  const initialViewState = stripEditableViewTransition(camera.initViewState);
  const finalViewState = stripEditableViewTransition(camera.finalViewState);

  return {
    initialViewState,
    finalViewState,
    originalInitialViewState: _.cloneDeep(initialViewState),
    originalFinalViewState: _.cloneDeep(finalViewState),
  };
}

export function updateDraftView(
  draft: ViewStateEditorDraft,
  key: ViewStateDraftKey,
  viewState: CameraView,
): ViewStateEditorDraft {
  return {
    ...draft,
    [key === 'initial' ? 'initialViewState' : 'finalViewState']: stripEditableViewTransition(viewState),
  };
}

export function resetDraftView(draft: ViewStateEditorDraft, key: ViewStateDraftKey): ViewStateEditorDraft {
  return updateDraftView(draft, key, key === 'initial' ? draft.originalInitialViewState : draft.originalFinalViewState);
}

export function applyDraftToCamera(
  camera: CameraMovement,
  draft: ViewStateEditorDraft,
  key: ViewStateDraftKey | 'both' = 'both',
): CameraMovement {
  let next = _.cloneDeep(camera);
  if (key !== 'final') next = recordCameraManualView(next, 'initial', draft.initialViewState);
  if (key !== 'initial') next = recordCameraManualView(next, 'final', draft.finalViewState);
  next.initViewState = stripEditableViewTransition(next.initViewState);
  next.finalViewState = stripEditableViewTransition(next.finalViewState);
  return next;
}
