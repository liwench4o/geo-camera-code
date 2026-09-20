import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';
import type App from './App';
import type { CameraMovement } from '../interfaces';

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
const localRequire = (id: string): unknown => {
  if (id.endsWith('.css') || uiImports.has(id)) return {};
  if (id === 'antd')
    return { Layout: {}, Typography: {}, Button: 'button', message: { error() {}, info() {}, success() {} } };
  return id.startsWith('.') ? require(path.resolve('.cache/camera-tests/src/components', id)) : require(id);
};
const loaded = { exports: {} as { default: typeof App } };
let completionTimers = 0;
runInThisContext(`(function(require,module,exports,window){${output}\n})`)(localRequire, loaded, loaded.exports, {
  setTimeout: () => ++completionTimers,
  clearTimeout() {},
});
const app = new loaded.exports.default({});
app.setState = ((patch: object | ((state: typeof app.state) => object), callback?: () => void) => {
  app.state = { ...app.state, ...(typeof patch === 'function' ? patch(app.state) : patch) };
  callback?.();
}) as typeof app.setState;
const view = { longitude: -2, latitude: 53, zoom: 7, pitch: 0, bearing: 0 };
const camera: CameraMovement = {
  id: 'preview-resume',
  name: 'preview',
  title: 'Preview',
  category: 'overview',
  initViewState: view,
  finalViewState: { ...view, zoom: 8 },
  duration: 10000,
  stay: 0,
  isRotating: false,
  interpolationType: 'none',
  interpolationDuration: 0,
};
app.updateCameraMovementState([camera]);
app.handleCameraListItemPlay(0);
const originalSegments = app.state.playbackRequest!.segments;
assert.equal(completionTimers, 0, 'preview completion has no independent timer');
const progressApp = app as typeof app & {
  handlePlaybackProgress(timeMs: number, status: 'playing' | 'paused' | 'complete' | 'error'): void;
  handleReleaseAnimationPlayback(): void;
  handleAnimationPlaybackControlChange(controlled: boolean): void;
};
progressApp.handlePlaybackProgress(375.125, 'playing');
app.handleCameraListItemPlay(0);
assert.equal(app.state.playbackRequest!.mode, 'stop');
assert.equal(app.state.playbackRequest!.startTimeMs, 375.125, 'preview pauses at the last emitted driver time');
app.handleCameraListItemPlay(0);
assert.equal(app.state.playbackRequest!.mode, 'play');
assert.equal(app.state.playbackRequest!.startTimeMs, 375.125, 'preview resumes at the same exact time');
assert.equal(
  app.state.playbackRequest!.segments,
  originalSegments,
  'resuming a shot keeps its navigation session instead of forcing camera follow',
);
progressApp.handlePlaybackProgress(10000, 'complete');
assert.equal(app.state.currentCameraPreview!.isPlaying, false, 'only driver completion ends preview');
app.handleCameraListItemPlay(0);
assert.equal(app.state.playbackRequest!.startTimeMs, 0, 'completed preview restarts from beginning');
app.updateCameraMovementState([{ ...camera, duration: 5000 }]);
app.handleCameraListItemPlay(0);
assert.notEqual(
  app.state.playbackRequest!.segments,
  originalSegments,
  'editing the shot creates a fresh navigation session',
);

const homeApp = app as unknown as {
  handleHomeViewChange: (key: string, next?: typeof view) => void;
  handleStoryImport: (cameras: CameraMovement[], homes?: Record<string, typeof view>) => void;
  state: typeof app.state & { homeViews: Record<string, typeof view> };
};
assert.equal(typeof homeApp.handleHomeViewChange, 'function', 'App owns saved scene homes');
const captured = { ...view };
homeApp.handleHomeViewChange('scene-a', captured);
captured.zoom = 10;
assert.equal(homeApp.state.homeViews['scene-a'].zoom, 7, 'saving detaches the view from the live map');
homeApp.handleHomeViewChange('scene-b', { ...view, longitude: 25 });
app.handleCanvasViewStateUpdate({ ...view, zoom: 12 });
assert.equal(homeApp.state.homeViews['scene-a'].zoom, 7, 'automatic sync does not overwrite home');
app.updateCameraMovementState([camera]);
assert.equal(homeApp.state.homeViews['scene-b'].longitude, 25, 'editing shots preserves all homes');
homeApp.handleHomeViewChange('scene-a');
assert.equal(homeApp.state.homeViews['scene-a'], undefined);
assert.equal(homeApp.state.homeViews['scene-b'].longitude, 25);
homeApp.handleStoryImport([], { imported: view });
assert.deepEqual(
  homeApp.state.homeViews,
  { imported: view },
  'Story import replaces homes, not merge with the previous project',
);
homeApp.handleStoryImport([]);
assert.deepEqual(homeApp.state.homeViews, {}, 'old Story imports clear unrelated home views');
console.log('App home persistence and shot-edit isolation passed.');

app.updateCameraMovementState([camera]);
app.handleTimelinePlay(100);
progressApp.handlePlaybackProgress(399.875, 'playing');
assert.equal((app.state as typeof app.state & { timelineCurrentTimeMs: number }).timelineCurrentTimeMs, 399.875);
app.handleTimelinePause();
assert.equal(app.state.playbackRequest!.startTimeMs, 399.875, 'story pause preserves the exact last driver frame');
app.handleTimelineSeek(275.25);
assert.equal((app.state as typeof app.state & { timelineCurrentTimeMs: number }).timelineCurrentTimeMs, 275.25);
app.handleTimelinePlay(275.25);
progressApp.handlePlaybackProgress(app.state.totalTimeLength, 'complete');
assert.equal(app.state.isPlaying, false, 'driver completion ends story UI');
const completedStoryTime = app.state.timelineCurrentTimeMs;
app.handleCameraListItemPlay(0);
progressApp.handlePlaybackProgress(75.125, 'playing');
assert.equal(app.state.timelineCurrentTimeMs, completedStoryTime, 'a shot preview does not move the story playhead');
assert.equal(app.state.currentCameraPreview!.currentTimeMs, 75.125);
progressApp.handlePlaybackProgress(75.125, 'error');
assert.equal(app.state.currentCameraPreview!.isPlaying, false, 'driver errors pause preview controls');
progressApp.handleAnimationPlaybackControlChange(true);
progressApp.handleReleaseAnimationPlayback();
assert.deepEqual(app.state.playbackRequest!.segments, [], 'free animation explicitly releases story control');
assert.equal(app.state.playbackRequest!.mode, 'stop');
assert.equal(app.state.currentCameraPreview, undefined);
