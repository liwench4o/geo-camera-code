import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';
import type { CameraMovement, CameraView, PlaybackRequest, TargetCameras } from '../interfaces';
import type { CameraAuthoringSpec } from '../camera/authoring-types';
import type { CameraFramingTuning, CameraSelectionRequest, CameraTarget } from '../camera/types';
import { createCameraMovement } from '../camera/planner';
import { createPointTarget, createRegionTarget } from '../camera/selection';
import { getCameraOptionSelectionById } from '../camera/recipes';
import { createStoryJson, parseStoryJson } from './serialization';
import { derivePlaybackPlan } from './playback';
import { compileRuntimeTrajectory } from '../camera/trajectory/sampler';
import { applyDraftToCamera, createDraft, updateDraftView } from '../components/viewStateEditorModel';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function testPlanMutationDoesNotReplayCancelledPreviewSegments() {
  for (const mutation of ['edit', 'import'] as const) {
    const { app } = harness([makeCamera()]);
    const source = app.state.cameraMovementFullList[0];
    const segments = derivePlaybackPlan([source], { viewport }).segments;
    const previousRequest: PlaybackRequest = { id: 700, mode: 'play', startTimeMs: 600, segments };
    app.state.playbackRequest = previousRequest;
    app.state.currentCameraPreview = {
      cameraIndex: 0,
      segments,
      currentTimeMs: 600,
      totalTimeMs: segments[segments.length - 1].end,
      isPlaying: true,
    };
    const previousRevision = Number(app.state.playbackPlanRevision);
    const changed = { ...source, annotation: { ...source.annotation!, text: 'Updated story caption' } };
    if (mutation === 'import') app.handleCameraMovementListChange([changed]);
    else app.updateCameraMovementState([changed]);
    assert(app.state.currentCameraPreview === undefined, `${mutation} cancels the obsolete current-camera preview`);
    assert(
      app.state.playbackPlanRevision === previousRevision + 1,
      `${mutation} invalidates the previous presentation with a new plan revision`,
    );
    assert(
      app.state.playbackRequest === previousRequest,
      `${mutation} must not publish a new stop request that replays obsolete preview segments`,
    );
    assert(
      app.state.cameraMovementFullList[0].annotation?.text === 'Updated story caption',
      `${mutation} retains the new annotation`,
    );
  }
}

interface Presentation {
  viewState: CameraView;
  replayCamera?: CameraMovement;
}

interface Draft {
  camera: CameraMovement;
  spec: CameraAuthoringSpec;
  action: 'add' | 'replace';
  index: number;
  selectedCameraId?: string | null;
  error?: string;
  returnPresentation?: Presentation;
}

interface TestState {
  cameraMovementFullList: CameraMovement[];
  cameraListIndex: number;
  cameraPlayIndex: number;
  selectedCameraId: string | null;
  libraryCategory: string;
  cameraRequestError?: string;
  cameraCandidate?: Draft;
  cameraUndo?: { cameras: CameraMovement[]; index: number };
  currentViewState: CameraView;
  mapViewportSize?: { width: number; height: number };
  selectedTarget?: CameraTarget;
  selectedTargets: CameraTarget[];
  timelineTargetCameraData: TargetCameras[];
  playbackRequest?: PlaybackRequest;
  editingCandidate?: boolean;
  cameraViewStateEditIndex: number;
  [key: string]: unknown;
}

interface AppInstance {
  state: TestState;
  setState: (
    update: Partial<TestState> | ((state: TestState) => Partial<TestState> | null),
    callback?: () => void,
  ) => void;
  panelMainRef: {
    current: {
      capturePresentation(): Presentation;
      pausePresentation(): void;
      restorePresentation(presentation: Presentation): void;
      resolveTargetSnapshot(target: CameraTarget): CameraTarget;
      leavePlaybackForSelection?(): void;
    } | null;
  };
  updateCameraMovementState(cameras: CameraMovement[], selectedId?: string | null): void;
  handleCameraLibraryCategoryClick(category: string): void;
  handleConfigCameraItemIndexChange(index: number): void;
  clearCameraSelection(): void;
  handlePlayIndexChange(index: number): void;
  handleTimelineSeek(time: number): void;
  handleTimelineCameraIndexChange(targetIndex: number, cameraIndex: number): void;
  handleTimelineEdit(edit: { type: 'rename-target'; target: TargetCameras; name: string }): void;
  handleTargetChange(target: CameraTarget): void;
  handleSelectionRemove(id: string): void;
  handleSelectionClear(): void;
  handleCameraListItemDelete(index: number): void;
  handleCameraMovementListChange(cameras: CameraMovement[]): void;
  handleCameraMovementUpdate(index: number, camera: CameraMovement): boolean;
  handleCameraLibraryItemChange(request: CameraSelectionRequest): void;
  handleViewStateModalVisibleChange(visible: boolean): void;
  updateAuthoringDraft(patch: Partial<CameraFramingTuning>): void;
  updateAuthoringIntent(spec: CameraAuthoringSpec): void;
  captureAuthoringSource(kind: 'current-view' | 'previous-camera' | 'reference-view'): void;
  captureAuthoringContext(): void;
  previewAuthoringDraft(timeMs?: number): void;
  applyAuthoringDraft(): boolean;
  cancelAuthoringDraft(): void;
  undoAuthoringChange(): void;
}

/** Execute the actual App handlers. Only UI imports, React scheduling, and the
 * map presentation boundary are replaced; planning and persistence stay real. */
function loadApp(): new (props: object) => AppInstance {
  const compiledRoot = path.resolve('.cache/camera-tests/src/components');
  const output = ts.transpileModule(readFileSync('src/components/App.tsx', 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const uiImports = new Set([
    './PanelLibrary',
    './PanelMain',
    './PanelConfig',
    './PanelTimeline',
    './CameraAuthoringPanel',
    'react-resizable',
    'react-icons/bs',
    '@ant-design/icons',
  ]);
  const messages = { error: () => undefined, info: () => undefined, success: () => undefined };
  const localRequire = (id: string): unknown => {
    if (id.endsWith('.css') || uiImports.has(id)) return {};
    if (id === 'antd') return { Layout: {}, Typography: {}, Button: 'button', message: messages };
    return id.startsWith('.') ? require(path.resolve(compiledRoot, id)) : require(id);
  };
  const moduleValue: { exports: { default?: new (props: object) => AppInstance } } = { exports: {} };
  // A normal CommonJS wrapper keeps domain objects in the same JS realm.
  const execute = runInThisContext(`(function(require, module, exports, window, performance) {\n${output}\n})`, {
    filename: 'App.handlers.cjs',
  }) as (...args: unknown[]) => void;
  execute(localRequire, moduleValue, moduleValue.exports, { clearTimeout, setTimeout }, performance);
  assert(moduleValue.exports.default, 'App must export its real component class');
  return moduleValue.exports.default;
}

const App = loadApp();
const viewport = { width: 1200, height: 800 };
const view: CameraView = { longitude: 0, latitude: 0, zoom: 8, pitch: 35, bearing: 0 };

function makeCamera(manual = false): CameraMovement {
  const target = { ...createPointTarget([0, 0]), sourceLayerId: 'fixture-layer' };
  const camera = createCameraMovement({
    cameraName: 'emphasis-static',
    currentViewState: view,
    target,
    viewportSize: viewport,
    authoring: {
      version: 1,
      targetId: target.id,
      recipeId: 'emphasis-static',
      adjustments: { framingTightness: 0.2 },
      timing: { duration: 1800, stay: 500, startDelay: 250 },
      planningViewport: viewport,
      ...(manual ? { manualViews: { initial: { ...view, zoom: 9 }, final: { ...view, zoom: 9 } } } : {}),
    },
  }).cameraMovement;
  return { ...camera, id: 'author-owned-id', annotation: { text: 'Keep this annotation', delay: 0, duration: 900 } };
}

function harness(cameras: CameraMovement[], selectedIndex = 0) {
  const app = new App({});
  app.setState = (update, callback) => {
    const patch = typeof update === 'function' ? update(app.state) : update;
    if (patch) app.state = { ...app.state, ...patch };
    callback?.();
  };
  const target = cameras[selectedIndex]?.targetSnapshot as CameraTarget | undefined;
  app.state = {
    ...app.state,
    mapViewportSize: viewport,
    currentViewState: { ...view, longitude: -80 },
    selectedTarget: target,
  };
  let displayed: Presentation = { viewState: { ...view, longitude: 12 }, replayCamera: cameras[selectedIndex] };
  let restored: Presentation | undefined;
  let pauses = 0;
  let latestTarget: CameraTarget | undefined;
  let resolutionFailure = false;
  app.panelMainRef.current = {
    resolveTargetSnapshot: (target) => {
      if (resolutionFailure) throw new Error('Current target unavailable');
      return latestTarget ?? target;
    },
    capturePresentation: () => ({ ...displayed, viewState: { ...displayed.viewState } }),
    pausePresentation: () => {
      pauses += 1;
    },
    restorePresentation: (presentation) => {
      restored = presentation;
      displayed = presentation;
    },
  };
  app.updateCameraMovementState(cameras);
  if (selectedIndex >= 0 && cameras[selectedIndex]) app.handleConfigCameraItemIndexChange(selectedIndex);
  return {
    app,
    getDisplayed: () => displayed,
    setDisplayed: (value: Presentation) => {
      displayed = value;
    },
    getRestored: () => restored,
    getPauseCount: () => pauses,
    setLatestTarget: (target: CameraTarget) => {
      latestTarget = target;
    },
    setResolutionFailure: (fail: boolean) => {
      resolutionFailure = fail;
    },
  };
}

function testPlaybackIndexOnlyCommitsWhenTheShotChanges() {
  const { app } = harness([makeCamera()]);
  const selectedCameraId = app.state.selectedCameraId;
  app.handlePlayIndexChange(0);
  const playingState = app.state;
  for (let tick = 0; tick < 10; tick++) app.handlePlayIndexChange(0);
  assert(app.state === playingState, 'unchanged playback index must not commit App state on every timeline tick');

  app.handlePlayIndexChange(1);
  assert(app.state.cameraPlayIndex === 1, 'entering the next shot still updates the playback indicator');
  app.handlePlayIndexChange(-1);
  assert(Number(app.state.cameraPlayIndex) === -1, 'clearing the playback index still updates the indicator');
  assert(app.state.selectedCameraId === selectedCameraId, 'playback index changes never change explicit selection');
}

testPlaybackIndexOnlyCommitsWhenTheShotChanges();

function request(app: AppInstance, cameraName = 'emphasis-push-in') {
  app.handleCameraLibraryItemChange({
    cameraName,
    optionSelection: getCameraOptionSelectionById(cameraName, 'normal'),
  });
}

function testCategoryOnlyFilters() {
  const { app } = harness([makeCamera()], -1);
  app.handleCameraLibraryCategoryClick('emphasis');
  assert(app.state.libraryCategory === 'emphasis', 'purpose selection filters the camera library');
  assert(!app.state.cameraCandidate, 'purpose selection cannot create a hidden draft');
  assert(app.state.selectedCameraId === null, 'category filtering cannot select a saved shot');
}

function testExplicitSelectionIsIndependentOfPlayback() {
  const first = makeCamera();
  const second = { ...makeCamera(), id: 'second-id' };
  const { app } = harness([first, second]);
  const selection = app.state.selectedCameraId;
  app.handlePlayIndexChange(1);
  app.handleTimelineSeek(2500);
  assert(
    selection === first.id && app.state.selectedCameraId === selection,
    'playing or seeking never selects another camera',
  );
  assert(app.state.cameraListIndex === 0, 'right editor remains on the explicitly selected shot');
  request(app);
  assert(
    app.state.cameraCandidate?.action === 'replace' && app.state.cameraCandidate.index === 0,
    'Replace targets the explicit selection',
  );
  app.clearCameraSelection();
  assert(
    app.state.selectedCameraId === null && !app.state.cameraCandidate,
    'clear selection discards the old replacement',
  );
  request(app);
  assert((app.state.cameraCandidate as Draft | undefined)?.action === 'add', 'no explicit selection always means Add');
}

function testContinuousAddLeavesNoSelection() {
  const { app } = harness([makeCamera()], -1);
  app.handleTargetChange(createPointTarget([0, 0]));
  request(app);
  assert(app.applyAuthoringDraft(), 'first Add succeeds');
  assert(app.state.cameraMovementFullList.length === 2, 'Add appends one shot');
  assert(app.state.selectedCameraId === null && Number(app.state.cameraListIndex) === -1, 'Add stays unselected');
  request(app);
  assert(app.applyAuthoringDraft(), 'second Add succeeds without clearing selection');
  assert(app.state.cameraMovementFullList.slice().length === 3, 'second Add appends, not replaces');
}

function testGeographicSelectionCanBeReplacedWithTargetlessMotion() {
  for (const cameraName of ['dynamic-pan', 'basic-pull-out']) {
    const context = harness([makeCamera()]);
    const { app } = context;
    const saved = app.state.cameraMovementFullList[0];
    context.setResolutionFailure(true);
    request(app, cameraName);
    const candidate = app.state.cameraCandidate;
    assert(
      candidate && !candidate.error && !app.state.cameraRequestError,
      'targetless motion does not resolve the old geographic target',
    );
    assert(
      candidate.action === 'replace' && candidate.selectedCameraId === saved.id,
      'targetless choice still replaces the explicit source selection',
    );
    assert(
      (candidate.camera.targetSnapshot as CameraTarget).type === 'none',
      'targetless candidate receives a current-view target',
    );
    assert(app.applyAuthoringDraft(), 'targetless replacement can commit while the old target is unavailable');
    const applied = app.state.cameraMovementFullList[0];
    assert(
      app.state.cameraMovementFullList.length === 1 && applied.name === cameraName,
      'targetless replacement changes the existing shot without appending',
    );
    assert(
      applied.id === saved.id && app.state.selectedCameraId === saved.id,
      'targetless replacement retains source identity and selection',
    );
    assert(applied.framingReport?.scope === 'targetless', 'replacement reports targetless framing');
  }
}

function testGeneratedTransitionCannotEnterSourceSelectionCallback() {
  const { app } = harness([makeCamera(), { ...makeCamera(true), id: 'second-id', startDelay: 1000 }]);
  request(app);
  const selectedId = app.state.selectedCameraId;
  const candidate = app.state.cameraCandidate;
  const gap = derivePlaybackPlan(app.state.cameraMovementFullList).segments.find(
    (segment) => segment.generated === 'gap-transition',
  );
  assert(gap, 'fixture has an automatic connection between distinct saved views');
  assert(
    app.state.timelineTargetCameraData.flatMap((target) => target.cameras).every((camera) => !camera.generated),
    'automatic connections have no timeline row that can enter source selection',
  );
  app.handleTimelineSeek(gap.start + gap.duration / 2);
  assert(
    app.state.selectedCameraId === selectedId && app.state.cameraListIndex === 0,
    'seeking an automatic connection cannot replace or clear the explicit selection',
  );
  assert(
    app.state.cameraCandidate === candidate && candidate?.index === 0,
    'seeking the connection leaves the replacement attached to the original selected source',
  );
  app.clearCameraSelection();
  app.handleTimelineSeek(gap.start + gap.duration / 2);
  assert(
    app.state.selectedCameraId === null && Number(app.state.cameraListIndex) === -1,
    'seeking the connection also leaves an unselected story unselected',
  );
}

function testReplacementPreservesMetadataAndManualIntent() {
  const context = harness([makeCamera(true)]);
  const { app } = context;
  const before = JSON.stringify(app.state.cameraMovementFullList);
  const originalPresentation = context.getDisplayed();
  request(app, 'overview-static');
  const candidate = app.state.cameraCandidate;
  assert(candidate && !candidate.error, 'replacement has a usable candidate');
  app.previewAuthoringDraft();
  context.setDisplayed({ viewState: { ...view, longitude: 70 }, replayCamera: candidate.camera });
  assert(JSON.stringify(app.state.cameraMovementFullList) === before, 'Preview does not change the saved story');
  assert(app.applyAuthoringDraft(), 'Replace commits');
  const applied = app.state.cameraMovementFullList[0];
  assert(
    applied.id === 'author-owned-id' && app.state.selectedCameraId === applied.id,
    'Replace retains identity and selection',
  );
  assert(applied.annotation?.text === 'Keep this annotation', 'annotation survives');
  assert(
    applied.duration === 1800 && applied.stay === 500 && applied.startDelay === 250,
    'unchanged explicit timing survives',
  );
  assert(
    applied.authoring?.manualViews?.initial?.zoom === 9 && applied.authoring.manualViews.final?.zoom === 9,
    'manual endpoints survive',
  );
  assert(
    applied.trajectoryPlan?.trajectoryDigest === candidate.camera.trajectoryPlan?.trajectoryDigest,
    'same inputs commit the previewed path',
  );
  assert(!app.state.cameraCandidate && app.state.cameraUndo, 'commit consumes candidate and offers Undo');
  app.undoAuthoringChange();
  assert(JSON.stringify(app.state.cameraMovementFullList) === before, 'Undo restores the whole saved snapshot');
  assert(
    context.getRestored()?.viewState.longitude === originalPresentation.viewState.longitude,
    'Undo restores pre-preview presentation',
  );
}

function testPresetChangeReleasesDurationButRetainsOtherEdits() {
  const { app } = harness([makeCamera(true)]);
  request(app);
  app.updateAuthoringDraft({ framingTightness: 0.6, pitchTarget: 20, speedScale: 0.75 });
  const requestWithReset: CameraSelectionRequest & { resetAdjustments: boolean } = {
    cameraName: 'emphasis-push-in',
    optionSelection: getCameraOptionSelectionById('emphasis-push-in', 'fast'),
    resetAdjustments: true,
  };
  app.handleCameraLibraryItemChange(requestWithReset);
  const candidate = app.state.cameraCandidate;
  assert(candidate && !candidate.error, 'Fast preset produces a candidate');
  assert(Object.keys(candidate.spec.adjustments).length === 0, 'preset resets Advanced overrides');
  assert(candidate.spec.timing?.duration === undefined, 'preset releases explicit movement duration');
  assert(candidate.camera.duration !== 1800, 'Fast changes the actual duration');
  assert(candidate.camera.stay === 500 && candidate.camera.startDelay === 250, 'unrelated time settings stay');
  assert(candidate.spec.manualViews?.initial?.zoom === 9, 'preset does not discard manual endpoints');
}

function testPresetDurationSurvivesSavingAndReopening() {
  const { app } = harness([makeCamera(true)]);
  app.handleCameraLibraryItemChange({
    cameraName: 'emphasis-push-in',
    optionSelection: getCameraOptionSelectionById('emphasis-push-in', 'fast'),
    resetAdjustments: true,
  });
  const fast = app.state.cameraCandidate;
  assert(fast && !fast.error && fast.camera.duration !== 1800, 'Fast replaces the prior explicit movement duration');
  const fastDuration = fast.camera.duration;
  assert(app.applyAuthoringDraft(), 'Fast preset commits');
  const saved = app.state.cameraMovementFullList[0];
  assert(
    saved.duration === fastDuration && saved.authoring?.timing?.duration === undefined,
    'saving retains the generated duration without turning it into an explicit override',
  );
  const story = parseStoryJson(JSON.parse(JSON.stringify(createStoryJson([saved]))));
  assert(story.ok, 'saved preset exports and imports');
  assert(
    story.cameras[0].authoring?.optionSelection?.id === 'fast' &&
      story.cameras[0].authoring?.timing?.duration === undefined,
    'roundtrip keeps the preset and automatic duration intent',
  );
  const reopened = harness(story.cameras).app;
  reopened.handleCameraLibraryItemChange({
    cameraName: 'emphasis-push-in',
    optionSelection: getCameraOptionSelectionById('emphasis-push-in', 'fast'),
  });
  assert(
    reopened.state.cameraCandidate?.camera.duration === fastDuration,
    'reopening the same preset retains its duration',
  );
  reopened.handleCameraLibraryItemChange({
    cameraName: 'emphasis-push-in',
    optionSelection: getCameraOptionSelectionById('emphasis-push-in', 'slow'),
    resetAdjustments: true,
  });
  const slow = reopened.state.cameraCandidate;
  assert(
    slow && !slow.error && slow.camera.duration > fastDuration,
    'a later Slow preset still changes duration after save and reopen',
  );
  assert(
    slow.spec.timing?.duration === undefined && slow.camera.stay === 500 && slow.camera.startDelay === 250,
    'later preset keeps automatic duration and unrelated timing',
  );
}

function testCancelAndSelectionChangesDiscardOldCandidate() {
  const context = harness([makeCamera(), { ...makeCamera(), id: 'second-id' }]);
  const { app } = context;
  const before = context.getDisplayed();
  request(app);
  app.updateAuthoringDraft({ framingTightness: 0.4 });
  app.previewAuthoringDraft();
  context.setDisplayed({ viewState: { ...view, longitude: 70 } });
  app.handleConfigCameraItemIndexChange(1);
  assert(!app.state.cameraCandidate && app.state.selectedCameraId === 'second-id', 'selection change discards draft');
  assert(
    context.getRestored()?.viewState.longitude === before.viewState.longitude,
    'selection change restores old preview',
  );
  assert(!app.applyAuthoringDraft(), 'old candidate cannot be applied to the new selection');
  request(app);
  app.cancelAuthoringDraft();
  assert(
    !app.state.cameraCandidate && app.state.cameraMovementFullList.length === 2,
    'Cancel changes no saved cameras',
  );
}

function testMapSelectionAndImportClearCameraSelection() {
  const { app } = harness([makeCamera()]);
  request(app);
  const target = createPointTarget([12, 14]);
  app.handleTargetChange(target);
  assert(
    app.state.selectedCameraId === null && !app.state.cameraCandidate,
    'new map target clears old camera selection/draft',
  );
  request(app);
  assert(
    (app.state.cameraCandidate as Draft | undefined)?.action === 'add' &&
      (app.state.cameraCandidate as Draft | undefined)?.spec.targetId === target.id,
    'new map target adds a shot',
  );
  app.handleConfigCameraItemIndexChange(0);
  app.handleCameraMovementListChange([{ ...makeCamera(), id: undefined }]);
  assert(app.state.selectedCameraId === null && !app.state.cameraCandidate, 'import starts unselected');
  assert(typeof app.state.cameraMovementFullList[0].id === 'string', 'legacy stories receive stable shot identity');
}

function testDeletionKeepsSelectionByIdentity() {
  const { app } = harness([makeCamera(), { ...makeCamera(), id: 'second-id' }], 1);
  app.handleCameraListItemDelete(0);
  assert(
    app.state.selectedCameraId === 'second-id' && app.state.cameraListIndex === 0,
    'deleting earlier shot preserves the selected identity',
  );
  app.handleCameraListItemDelete(0);
  assert(
    app.state.selectedCameraId === null && Number(app.state.cameraListIndex) === -1,
    'deleting selected shot clears selection',
  );
}

function testLatestTargetIsCheckedWithoutChangingSavedShot() {
  const context = harness([makeCamera()]);
  const { app } = context;
  const saved = JSON.stringify(app.state.cameraMovementFullList);
  request(app);
  const latest = {
    ...createPointTarget([3, 4]),
    id: app.state.cameraCandidate!.spec.targetId,
    sourceLayerId: 'fixture-layer',
  };
  context.setLatestTarget(latest);
  app.state.sceneRevision = 'new-renderer-revision';
  app.previewAuthoringDraft();
  assert(
    (app.state.cameraCandidate?.camera.targetSnapshot as CameraTarget).center[0] === 3,
    'Preview refreshes current geometry automatically',
  );
  assert(
    JSON.stringify(app.state.cameraMovementFullList) === saved,
    'latest content cannot rewrite saved shots during Preview',
  );
  context.setResolutionFailure(true);
  assert(!app.applyAuthoringDraft(), 'Apply rechecks target and rejects unavailable geometry');
  assert(JSON.stringify(app.state.cameraMovementFullList) === saved, 'failed Apply leaves saved story intact');
  assert(app.state.cameraCandidate?.error, 'failure has visible actionable message');
}

function testFailedNewRequestCannotReuseOldSuggestion() {
  const context = harness([makeCamera()]);
  request(context.app);
  context.setResolutionFailure(true);
  request(context.app, 'overview-static');
  assert(!context.app.applyAuthoringDraft(), 'a failed shot choice cannot apply the previously valid draft');
  assert(
    context.app.state.cameraRequestError || context.app.state.cameraCandidate?.error,
    'request failure is exposed',
  );
}

function testRightEditorSavesBothEndpointsDirectlyAndRoundtrips() {
  const { app } = harness([makeCamera()], -1);
  const original = app.state.cameraMovementFullList[0];
  const edited = applyDraftToCamera(
    original,
    updateDraftView(
      updateDraftView(createDraft(original), 'initial', { ...view, longitude: 3, zoom: 9, pitch: 0, bearing: 20 }),
      'final',
      { ...view, longitude: 5, zoom: 10, pitch: 0, bearing: 40 },
    ),
  );
  app.state.viewStateModalVisible = true;
  assert(app.handleCameraMovementUpdate(0, edited), 'valid cropped edit saves directly');
  const applied = app.state.cameraMovementFullList[0];
  assert(!app.state.cameraCandidate && !app.state.viewStateModalVisible, 'right save needs no second confirmation');
  assert(applied.initViewState.zoom === 9 && applied.finalViewState.zoom === 10, 'both manual endpoints are committed');
  assert(applied.framingReport?.status === 'warning', 'intentional crop gets honest warning');
  const runtime = compileRuntimeTrajectory(applied.trajectoryPlan!.trajectory);
  assert(
    runtime.status === 'ok' && runtime.value.sample(applied.duration).bearing === 40,
    'saved trajectory matches the edited endpoint',
  );
  const story = parseStoryJson(JSON.parse(JSON.stringify(createStoryJson([applied]))));
  assert(
    story.ok && story.cameras[0].authoring?.manualViews?.final?.zoom === 10,
    'manual edit survives Story export/import',
  );
  const prior = JSON.stringify(app.state.cameraMovementFullList);
  app.state.viewStateModalVisible = true;
  assert(
    !app.handleCameraMovementUpdate(0, { ...applied, finalViewState: { ...applied.finalViewState, zoom: NaN } }),
    'invalid edit rejected',
  );
  assert(
    app.state.viewStateModalVisible && JSON.stringify(app.state.cameraMovementFullList) === prior,
    'invalid save keeps editor and story intact',
  );
}

function testRightTimingEditRegeneratesAndUndoRestoresOnlyLatestChange() {
  const { app } = harness([makeCamera()], -1);
  const original = app.state.cameraMovementFullList[0];
  assert(app.handleCameraMovementUpdate(0, { ...original, duration: 2400 }), 'right duration update commits directly');
  assert(
    app.state.cameraMovementFullList[0].duration === 2400 && !app.state.cameraCandidate,
    'duration not stranded in a hidden candidate',
  );
  const changed = app.state.cameraMovementFullList[0];
  assert(
    app.handleCameraMovementUpdate(0, { ...changed, annotation: { text: 'Later edit', delay: 0, duration: 900 } }),
    'metadata edit saved',
  );
  app.undoAuthoringChange();
  assert(
    app.state.cameraMovementFullList[0].duration === 2400,
    'Undo only reverses latest save, retaining earlier timing edit',
  );
  assert(
    app.state.cameraMovementFullList[0].annotation?.text === original.annotation?.text,
    'Undo restores previous annotation',
  );
}

function testMetadataOnlySaveDoesNotNeedCurrentTargetGeometry() {
  const context = harness([makeCamera()]);
  const { app } = context;
  const original = app.state.cameraMovementFullList[0];
  context.setResolutionFailure(true);
  assert(
    app.handleCameraMovementUpdate(0, {
      ...original,
      annotation: { text: 'Edited while layer is unavailable', delay: 100, duration: 900 },
    }),
    'annotation-only edit saves even when current target geometry is unavailable',
  );
  const saved = app.state.cameraMovementFullList[0];
  assert(saved.annotation?.text === 'Edited while layer is unavailable', 'metadata change reaches the saved shot');
  assert(
    saved.trajectoryPlan?.trajectoryDigest === original.trajectoryPlan?.trajectoryDigest,
    'metadata-only save retains the committed camera path',
  );
  const beforeTimingEdit = JSON.stringify(app.state.cameraMovementFullList);
  assert(
    !app.handleCameraMovementUpdate(0, { ...saved, duration: saved.duration + 200 }),
    'movement-duration edit still requires current target geometry',
  );
  assert(
    JSON.stringify(app.state.cameraMovementFullList) === beforeTimingEdit,
    'failed replanning preserves the prior metadata save and path',
  );
}

testCategoryOnlyFilters();
testExplicitSelectionIsIndependentOfPlayback();
testContinuousAddLeavesNoSelection();
testGeographicSelectionCanBeReplacedWithTargetlessMotion();
testGeneratedTransitionCannotEnterSourceSelectionCallback();
testReplacementPreservesMetadataAndManualIntent();
testPresetChangeReleasesDurationButRetainsOtherEdits();
testPresetDurationSurvivesSavingAndReopening();
testCancelAndSelectionChangesDiscardOldCandidate();
testMapSelectionAndImportClearCameraSelection();
testDeletionKeepsSelectionByIdentity();
testLatestTargetIsCheckedWithoutChangingSavedShot();
testFailedNewRequestCannotReuseOldSuggestion();
testRightEditorSavesBothEndpointsDirectlyAndRoundtrips();
testRightTimingEditRegeneratesAndUndoRestoresOnlyLatestChange();
testMetadataOnlySaveDoesNotNeedCurrentTargetGeometry();

function testSnapshotSourcesAndContextStayFrozenDuringPreview() {
  const first = makeCamera();
  const context = harness([first, { ...makeCamera(), id: 'second-shot' }], 1);
  const { app } = context;
  request(app, 'dynamic-pan');
  context.setDisplayed({ viewState: { ...view, longitude: 14, bearing: 35 } });
  app.captureAuthoringSource('reference-view');
  assert(app.state.cameraCandidate?.spec.source?.view.longitude === 14, 'reference captures the visible map');
  context.setDisplayed({ viewState: { ...view, longitude: 22, bearing: -40 } });
  app.previewAuthoringDraft();
  assert(app.state.cameraCandidate?.spec.source?.view.longitude === 14, 'preview never recaptures a saved reference');
  app.captureAuthoringSource('previous-camera');
  assert(
    app.state.cameraCandidate?.spec.source?.view.longitude === first.finalViewState.longitude,
    'previous source snapshots the preceding saved endpoint',
  );
  request(app, 'emphasis-static');
  context.setDisplayed({ viewState: { ...view, longitude: 1 } });
  app.captureAuthoringContext();
  const captured = app.state.cameraCandidate?.spec.composition?.context;
  assert(captured?.kind === 'view' && captured.view.longitude === 1, 'context captures the visible map');
  assert(captured.viewport.width === viewport.width, 'context stores its capture viewport');
  context.setDisplayed({ viewState: { ...view, longitude: 50 } });
  app.previewAuthoringDraft();
  const afterPreview = app.state.cameraCandidate?.spec.composition?.context;
  assert(afterPreview?.kind === 'view', 'preview retains context kind');
  assert(afterPreview.view.longitude === 1, 'preview retains the captured longitude in the current candidate');
  assert(
    afterPreview.viewport.width === viewport.width && afterPreview.viewport.height === viewport.height,
    'preview retains the capture viewport in the current candidate',
  );
  assert(captured.view.longitude === 1, 'later presentation does not mutate the original context');
}

function testCompleteIntentDraftSurvivesPresetSaveReopenAndUndo() {
  const { app } = harness([makeCamera()]);
  const before = JSON.stringify(app.state.cameraMovementFullList);
  request(app, 'emphasis-push-in');
  const spec = app.state.cameraCandidate!.spec;
  app.updateAuthoringIntent({
    ...spec,
    version: 2,
    motion: { zoomDelta: 1.4 },
    transition: 'cut',
    composition: { anchor: 'ground', offsetRatio: [0.1, -0.1] },
  });
  app.handleCameraLibraryItemChange({
    cameraName: 'emphasis-push-in',
    optionSelection: getCameraOptionSelectionById('emphasis-push-in', 'fast'),
  });
  assert(
    app.state.cameraCandidate?.spec.motion?.zoomDelta === 1.4,
    'preset selection preserves explicit motion intent',
  );
  assert(app.applyAuthoringDraft(), 'complete intent can be committed');
  request(app, 'emphasis-push-in');
  assert(
    app.state.cameraCandidate?.spec.transition === 'cut' &&
      app.state.cameraCandidate.spec.composition?.anchor === 'ground',
    'reopen retains complete author intent',
  );
  app.cancelAuthoringDraft();
  app.undoAuthoringChange();
  assert(JSON.stringify(app.state.cameraMovementFullList) === before, 'Undo restores the previous intent and camera');
}

testSnapshotSourcesAndContextStayFrozenDuringPreview();
testCompleteIntentDraftSurvivesPresetSaveReopenAndUndo();

function testLegacyTargetlessDraftKeepsManualViewsAndRejectsAutomaticRelease() {
  const legacy = makeCamera();
  delete legacy.authoring;
  delete legacy.targetSnapshot;
  const { app } = harness([legacy]);
  request(app, legacy.name);
  const candidate = app.state.cameraCandidate;
  assert(candidate && !candidate.error, 'legacy shot can reopen for inspection');
  assert(
    (candidate.camera.targetSnapshot as CameraTarget)?.type === 'none',
    'reopen does not manufacture a geographic target',
  );
  assert(candidate.camera.initViewState.zoom === legacy.initViewState.zoom, 'reopen preserves original endpoint');
  app.updateAuthoringIntent({ ...candidate.spec, manualViews: { ...candidate.spec.manualViews, initial: undefined } });
  assert(
    app.state.cameraCandidate?.error?.includes('target'),
    'return to Auto requires a geographic target for this recipe',
  );
  assert(!app.applyAuthoringDraft(), 'cannot commit automatic release without the required target');
  assert(
    app.state.cameraMovementFullList[0].initViewState.zoom === legacy.initViewState.zoom,
    'failed release preserves the saved camera',
  );
}

testLegacyTargetlessDraftKeepsManualViewsAndRejectsAutomaticRelease();
testPlanMutationDoesNotReplayCancelledPreviewSegments();

function testTimelineTargetRenamePersistsForEveryCameraInTheRow() {
  const first = makeCamera();
  const second = { ...first, id: 'second' };
  const third = { ...makeCamera(), id: 'third', targetId: 'another-target' };
  const { app } = harness([first, second, third]);
  const target = app.state.timelineTargetCameraData[0];
  assert(target.cameras.length === 2, 'fixture groups the first two shots in one target row');
  const geometry = JSON.stringify(first.targetSnapshot);
  const name = '开场 <Location> & 详情';
  app.handleTimelineEdit({ type: 'rename-target', target, name });
  assert(app.state.timelineTargetCameraData[0].name === name, 'the real App handler updates the target row');
  assert(app.state.timelineTargetCameraData[1].name !== name, 'other target rows retain their names');
  assert(
    JSON.stringify(app.state.cameraMovementFullList[0].targetSnapshot) === geometry,
    'renaming does not modify target geometry',
  );
  const saved = createStoryJson(app.state.cameraMovementFullList, { trajectoryEnabled: true, viewport });
  const imported = parseStoryJson(JSON.parse(JSON.stringify(saved)));
  assert(imported.ok, 'renamed camera list can be imported');
  app.handleCameraMovementListChange(imported.cameras);
  assert(app.state.timelineTargetCameraData[0].name === name, 'import restores the edited name');
  app.handleCameraListItemDelete(0);
  assert(
    app.state.timelineTargetCameraData[0].name === name,
    'deleting the first grouped shot does not lose the row name',
  );
  app.handleTimelineEdit({ type: 'rename-target', target: app.state.timelineTargetCameraData[0], name: '' });
  assert(app.state.timelineTargetCameraData[0].name !== name, 'clearing the name restores its default');
}

testTimelineTargetRenamePersistsForEveryCameraInTheRow();

function testAddingWithoutSelectionCannotInventAGeographicTarget() {
  for (const history of [[], [createPointTarget([1, 2]), createPointTarget([3, 4])]]) {
    const { app } = harness([]);
    app.state.selectedTarget = undefined;
    app.state.selectedTargets = history;
    request(app, 'overview-static');
    assert(!app.state.cameraCandidate, 'a target-required shot cannot invent a target from the map or history');
    assert(app.state.cameraRequestError?.includes('Select a target'), 'missing selection requires a real target');
  }
}

function testAddedTargetSnapshotsSurviveLaterSelectionsAndStoryRoundTrip() {
  const { app } = harness([]);
  app.state.selectedTarget = undefined;
  request(app, 'basic-static');
  assert(app.applyAuthoringDraft(), 'a current-view static shot can be added without a region');

  const region = createRegionTarget([
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
    [-1, -1],
  ]);
  app.handleTargetChange(region);
  request(app, 'overview-static');
  assert(app.applyAuthoringDraft(), 'an overview of an explicitly selected region can be added');

  app.clearCameraSelection();
  app.state.selectedTarget = undefined;
  request(app, 'basic-pull-out');
  assert(app.applyAuthoringDraft(), 'a current-view pull out can be added without a region');

  app.handleTargetChange(createPointTarget([10, 20]));
  const story = createStoryJson(app.state.cameraMovementFullList, { trajectoryEnabled: true, viewport });
  const imported = parseStoryJson(JSON.parse(JSON.stringify(story)));
  assert(imported.ok, 'the story with explicit creation targets imports');
  assert(
    imported.cameras.map((camera) => (camera.targetSnapshot as CameraTarget).type).join(',') === 'none,region,none',
    'export preserves the target used at creation, independently of the later map selection',
  );
  for (const camera of imported.cameras) {
    assert(camera.targetId === (camera.targetSnapshot as CameraTarget).id, 'target identity matches its snapshot');
    assert(camera.authoring?.targetId === camera.targetId, 'authoring retains the same target identity');
  }
  assert(
    (imported.cameras[1].targetSnapshot as CameraTarget).id === region.id,
    'a region selected for a static shot remains a region',
  );
  assert(
    JSON.stringify(createStoryJson(imported.cameras, { trajectoryEnabled: true, viewport })) === JSON.stringify(story),
    'the selection metadata survives a complete story round trip',
  );
}

testAddingWithoutSelectionCannotInventAGeographicTarget();
testAddedTargetSnapshotsSurviveLaterSelectionsAndStoryRoundTrip();

function testSplitPresetReplacesBothTimingFieldsWithoutChangingSavedStoryOnOpen() {
  const pair = [createPointTarget([-1, 52]), createPointTarget([0, 53])];
  const original = createCameraMovement({
    cameraName: 'comparison-side-by-side',
    currentViewState: view,
    comparisonTargets: pair,
    viewportSize: viewport,
  }).cameraMovement;
  original.authoring!.timing = { duration: 3000, stay: 6000, startDelay: 250 };
  original.duration = 3000;
  original.stay = 6000;
  original.startDelay = 250;
  // These fields represent an existing user's saved explicit timing.
  original.trajectoryPlan = undefined;
  const { app } = harness([original]);
  app.handleCameraLibraryItemChange({
    cameraName: original.name,
    optionSelection: getCameraOptionSelectionById(original.name, 'short'),
  });
  assert(app.state.cameraCandidate?.camera.stay === 6000, 'opening a saved split retains its explicit stay');
  assert(app.state.cameraMovementFullList[0].stay === 6000, 'opening does not rewrite the applied story');
  for (const [id, duration] of [
    ['medium', 5000],
    ['long', 8000],
    ['short', 3000],
  ] as const) {
    app.handleCameraLibraryItemChange({
      cameraName: original.name,
      optionSelection: getCameraOptionSelectionById(original.name, id),
      resetAdjustments: true,
    });
    const draft = app.state.cameraCandidate;
    assert(draft && !draft.error, `${id} creates a valid split candidate`);
    assert(draft.spec.timing?.duration === undefined, 'preset releases stale duration override');
    assert(draft.spec.timing?.stay === undefined, 'split preset releases stale stay override');
    assert(draft.camera.duration === duration && draft.camera.stay === 0, `${id} controls the entire split display`);
    assert(draft.camera.startDelay === 250, 'preset preserves an explicitly authored timeline delay');
  }
  assert(app.applyAuthoringDraft(), 'split timing replacement applies');
  const saved = app.state.cameraMovementFullList[0];
  const parsed = parseStoryJson(createStoryJson([saved]));
  assert(
    parsed.ok && parsed.cameras[0].duration === 3000 && parsed.cameras[0].stay === 0,
    'split preset timing survives serialization',
  );
}

testSplitPresetReplacesBothTimingFieldsWithoutChangingSavedStoryOnOpen();

function testRemovingCurrentObjectsNeverRevivesHiddenHistory() {
  const { app } = harness([]);
  const objects = [0, 1, 2].map((x) => createPointTarget([x, 51]));
  objects.forEach((target) => app.handleTargetChange(target));
  assert(typeof app.handleSelectionRemove === 'function', 'map strip can remove a current object');
  app.handleSelectionRemove(objects[2].id);
  assert(app.state.selectedTargets.length === 1, 'removal does not restore an older hidden object');
  assert(app.state.selectedTargets[0].id === objects[1].id, 'only the displayed partner remains');
  assert(app.state.selectedTarget?.id === objects[1].id, 'active target follows the remaining object');
  app.handleSelectionClear();
  assert(
    Number(app.state.selectedTargets.length) === 0 && !app.state.selectedTarget,
    'clear removes all current selection',
  );
}
testRemovingCurrentObjectsNeverRevivesHiddenHistory();

function testExplicitSavedShotSelectionReleasesPreviousPlaybackObjects() {
  const first = makeCamera();
  const second = { ...makeCamera(), id: 'second-shot' };
  const { app } = harness([first, second]);
  const segments = derivePlaybackPlan([first]).segments;
  const previousRequest: PlaybackRequest = { id: 900, mode: 'play', segments, startTimeMs: 100 };
  app.state.playbackRequest = previousRequest;
  app.state.currentCameraPreview = {
    cameraIndex: 0,
    segments,
    currentTimeMs: 100,
    totalTimeMs: 6000,
    isPlaying: true,
  };
  let released = false;
  app.panelMainRef.current!.leavePlaybackForSelection = () => {
    released = true;
  };
  app.handleConfigCameraItemIndexChange(1);
  assert(released, 'selecting another saved shot releases the previous replay object presentation');
  assert(app.state.selectedCameraId === 'second-shot', 'the new saved shot owns the strip');
  assert(
    app.state.playbackRequest === previousRequest,
    'switching shot never reissues the old preview as a stop request',
  );
  assert(app.state.currentCameraPreview === undefined, 'the previous preview session is cleared');
}
testExplicitSavedShotSelectionReleasesPreviousPlaybackObjects();
