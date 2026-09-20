import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { CameraMovement, HomeViews } from '../interfaces';
import { createStoryJson, parseStoryJson } from '../story/serialization';
import { derivePlaybackPlan, getViewAtPlaybackTime } from '../story/playback';
import { createDraft, resetDraftView, updateDraftView } from './viewStateEditorModel';

const fileReads: Promise<void>[] = [];
const notices: { type: string; text: string }[] = [];
const downloads: { blob: Blob; name: string }[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Element = React.ReactElement<Record<string, unknown>>;

function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as React.ReactNode)];
}

interface RenderedControl {
  name: string;
  props: Record<string, unknown>;
}

function loadComponent(filename: string, renderedControls: RenderedControl[] = []): unknown {
  const control = (name: string) =>
    Object.assign(
      (props: { children?: React.ReactNode; footer?: React.ReactNode }) => {
        renderedControls.push({ name, props });
        return React.createElement('div', { 'data-control': name }, props.children, props.footer);
      },
      { displayName: name },
    );
  const controls = Object.fromEntries(
    [
      'Alert',
      'Button',
      'Card',
      'Col',
      'Collapse',
      'Divider',
      'Input',
      'InputNumber',
      'Modal',
      'Popconfirm',
      'Row',
      'Select',
      'Slider',
      'Space',
      'Switch',
      'Tabs',
      'Tag',
      'Tooltip',
      'Typography',
      'Upload',
    ].map((name) => [name, control(name)]),
  );
  Object.assign(controls.Collapse, { Panel: control('Panel') });
  Object.assign(controls.Typography, { Text: control('Text') });
  Object.assign(controls.Select, { Option: control('Option') });
  Object.assign(controls.Input, { TextArea: control('TextArea') });
  const output = ts.transpileModule(readFileSync(`src/components/${filename}.tsx`, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const localRequire = (id: string): unknown => {
    if (id.endsWith('.css')) return {};
    if (id === 'file-saver') return { saveAs: (blob: Blob, name: string) => downloads.push({ blob, name }) };
    if (id === '../util')
      return {
        getUploadResult: (file: Blob, callback: (text: string) => void) => {
          fileReads.push(file.text().then(callback));
        },
      };
    if (id === '@ant-design/icons') return new Proxy({}, { get: (_target, name) => control(String(name)) });
    if (id === 'antd')
      return {
        ...controls,
        message: Object.fromEntries(
          ['info', 'success', 'error'].map((type) => [type, (text: string) => notices.push({ type, text })]),
        ),
      };
    if (id === './ViewStatePreview') return loadComponent('ViewStatePreview', renderedControls);
    if (id === '@deck.gl/react') return { DeckGL: control('DeckGL') };
    if (id === 'react-map-gl/maplibre') return { Map: control('Map') };
    return id.startsWith('.') ? require(path.resolve('.cache/camera-tests/src/components', id)) : require(id);
  };
  const moduleValue = { exports: {} as { default?: unknown } };
  const execute = runInThisContext(`(function(require, module, exports) {\n${output}\n})`) as (
    require: (id: string) => unknown,
    module: typeof moduleValue,
    exports: object,
  ) => void;
  execute(localRequire, moduleValue, moduleValue.exports);
  return moduleValue.exports.default;
}

interface Panel {
  render(): React.ReactNode;
  handleDurationChange(value: number, index?: number): void;
  handleInitialZoomChange(index: number, value: number): void;
  handleFinalBearingChange(index: number, value: number): void;
  handleExportButtonClick(): void;
}

const PanelConfig = loadComponent('PanelConfig') as new (props: object) => Panel;

function camera(id: string): CameraMovement {
  const view = { longitude: 0, latitude: 0, zoom: 8, pitch: 30, bearing: 0 };
  return {
    id,
    name: 'emphasis-static',
    title: id,
    category: 'emphasis',
    initViewState: { ...view },
    finalViewState: { ...view },
    duration: 2000,
    stay: 100,
    isRotating: false,
    interpolationType: 'none',
    interpolationDuration: 0,
    authoring: {
      version: 1,
      targetId: id,
      recipeId: 'emphasis-static',
      adjustments: {},
      planningViewport: { width: 800, height: 600 },
    },
    annotation: { text: id, delay: 0, duration: 2000 },
  };
}

function harness(selectedIndex = 0, homeViews: HomeViews = {}, panelProps: Record<string, unknown> = {}) {
  const cameras = [camera('first'), camera('second')];
  const updates: { index: number; camera: CameraMovement }[] = [];
  const selections: number[] = [];
  const deletes: number[] = [];
  const imports: CameraMovement[][] = [];
  const homeImports: (HomeViews | undefined)[] = [];
  const panel = new PanelConfig({
    cameraMovementList: cameras,
    homeViews,
    currentCameraIndex: selectedIndex,
    currentCameraPreviewIndex: -1,
    isCurrentCameraPreviewPlaying: false,
    panelTimelineHeight: 200,
    visualizationCatalog: { visualizations: [], datasets: [] },
    visualizationParams: {},
    manualParameterKeys: [],
    onCameraItemEdit: (index: number, edited: CameraMovement) => updates.push({ index, camera: edited }),
    onCameraIndexChange: (index: number) => selections.push(index),
    onCameraItemDelete: (index: number) => deletes.push(index),
    onCameraMovementListChange: (cameras: CameraMovement[]) => imports.push(cameras),
    onStoryImport: (cameras: CameraMovement[], homes?: HomeViews) => {
      imports.push(cameras);
      homeImports.push(homes);
    },
    ...panelProps,
  });
  return { panel, cameras, updates, selections, deletes, imports, homeImports };
}

function named(node: Element, name: string) {
  return (node.type as { displayName?: string }).displayName === name;
}

const tests: [string, () => void | Promise<void>][] = [
  [
    'legacy Trucking shots remain editable in Camera and roundtrip through Story upload/export',
    async () => {
      const { panel, cameras, updates, imports } = harness();
      const legacy = ['overview-trucking', 'basic-trucking'].map((name, index) => ({
        ...camera(`legacy-trucking-${index}`),
        name,
        title: 'Trucking shot',
        category: index === 0 ? 'overview' : 'basic',
        authoring: undefined,
        finalViewState: { ...camera('fixture').finalViewState, longitude: 1 },
        duration: 5000,
        stay: 2000,
      }));
      const upload = elements(panel.render()).find((node) => named(node, 'Upload') && node.props.name === 'cameraFile');
      assert(upload, 'Story upload remains available');
      (upload.props.beforeUpload as (file: File) => boolean)(new File([JSON.stringify(legacy)], 'trucking.json'));
      await Promise.all(fileReads.splice(0));
      assert(imports.length === 1 && imports[0].length === 2, 'both legacy Trucking IDs import');
      cameras.splice(0, cameras.length, ...imports[0]);
      for (let index = 0; index < cameras.length; index += 1) {
        panel.handleInitialZoomChange(index, 9);
        cameras[index] = updates[updates.length - 1].camera;
        panel.handleFinalBearingChange(index, 45);
        cameras[index] = updates[updates.length - 1].camera;
        panel.handleDurationChange(7500, index);
        cameras[index] = updates[updates.length - 1].camera;
      }
      downloads.length = 0;
      panel.handleExportButtonClick();
      assert(downloads.length === 1, 'edited Trucking story exports');
      const contents = await downloads[0].blob.text();
      (upload.props.beforeUpload as (file: File) => boolean)(new File([contents], 'trucking-edited.json'));
      await Promise.all(fileReads.splice(0));
      assert(imports[1]?.length === 2, 'exported Trucking story reimports');
      for (const [index, restored] of imports[1].entries()) {
        assert(restored.name === legacy[index].name, 'Trucking ID is not converted');
        assert(
          restored.initViewState.zoom === 9 && restored.finalViewState.bearing === 45,
          'both endpoint edits persist',
        );
        assert(restored.duration === 7500 && restored.stay === 2000, 'duration and hold persist');
        const playback = derivePlaybackPlan([restored]);
        const middle = getViewAtPlaybackTime(playback.segments, 3750);
        assert(
          middle && middle.longitude > 0 && middle.longitude < 1,
          'reimported shot plays through its lateral path',
        );
      }
    },
  ],
  [
    'home-only Story files roundtrip through the actual export and upload handlers',
    async () => {
      const homeViews = { scene: { longitude: 12, latitude: 30, zoom: 7, pitch: 40, bearing: 5 } };
      const { panel, cameras, homeImports } = harness(-1, homeViews);
      cameras.length = 0;
      downloads.length = 0;
      panel.handleExportButtonClick();
      assert(downloads.length === 1, 'a home-only project can export without creating a shot');
      const contents = await downloads[0].blob.text();
      assert(
        JSON.stringify(JSON.parse(contents).homeViews) === JSON.stringify(homeViews),
        'export includes home views',
      );
      const upload = elements(panel.render()).find(
        (node) => named(node, 'Upload') && node.props.name === 'cameraFile',
      )!;
      (upload.props.beforeUpload as (file: File) => boolean)(new File([contents], 'homes.json'));
      await Promise.all(fileReads.splice(0));
      assert(
        JSON.stringify(homeImports[0]) === JSON.stringify(homeViews),
        'import metadata reaches App with the cameras',
      );
    },
  ],
  [
    'invalid export shows a recoverable error without downloading a broken story',
    () => {
      const { panel, cameras } = harness();
      cameras[0].duration = Number.NaN;
      downloads.length = 0;
      notices.length = 0;
      panel.handleExportButtonClick();
      assert(downloads.length === 0, 'invalid export produces no file');
      assert(
        notices.some((notice) => notice.type === 'error' && notice.text.includes('Could not export story')),
        'export explains the problem without throwing out of the click handler',
      );
    },
  ],
  [
    'Story export downloads an edited camera that can be imported again',
    async () => {
      const { panel, cameras, updates } = harness();
      panel.handleInitialZoomChange(1, 10);
      cameras[1] = updates[0].camera;
      downloads.length = 0;
      const log = console.log;
      try {
        console.log = () => undefined;
        panel.handleExportButtonClick();
      } finally {
        console.log = log;
      }
      assert(
        downloads.length === 1 && downloads[0].name === 'geo-camera-story.json',
        'Export Story downloads its JSON file',
      );
      assert(downloads[0].blob.type === 'application/json', 'export uses the JSON media type');
      const imported = parseStoryJson(JSON.parse(await downloads[0].blob.text()));
      assert(imported.ok, 'downloaded Story passes the real importer');
      assert(imported.cameras.length === cameras.length, 'automatic connections never become exported story items');
      assert(
        imported.cameras.every((camera) => camera.name !== 'gap-transition' && camera.name !== 'timeline-gap'),
        'Story contains only authored shots',
      );
      assert(imported.cameras[1].initViewState.zoom === 10, 'download includes the edited camera view');
      assert(
        imported.cameras[0].id === cameras[0].id && imported.cameras[1].id === cameras[1].id,
        'roundtrip retains both camera identities',
      );
    },
  ],
  [
    'Story export downloads compact playback content without authoring diagnostics',
    async () => {
      const { panel, cameras } = harness(
        0,
        {},
        {
          trajectoryEnabled: true,
          viewportSize: { width: 800, height: 600 },
        },
      );
      Object.assign(cameras[0], {
        targetSnapshot: {
          id: 'heatmap-zone-1',
          type: 'region',
          source: 'heatmap-zone',
          center: [24.7, 46.7],
          bbox: [24.6, 46.6, 24.8, 46.8],
          coordinates: [[24.7, 46.7]],
          selectedRows: [{ id: 'private-row', weight: 12 }],
          snapshotEnvelope: {
            binding: 'snapshot',
            id: 'heatmap-zone-1',
            revision: 'heatmap-v1',
            supportGuarantee: 'conservative',
            provenance: {
              visualizationId: 'heatmap',
              datasetId: 'private-dataset',
              layerId: 'heatmap-layer',
              dataRevision: 'data-v1',
              visualizationRevision: 'visual-v1',
              producerId: 'heatmap',
              producerVersion: 1,
              sceneRevision: 'scene-v1',
              resolvedLayerDigest: 'layer-v1',
            },
            frame: {
              primitives: [],
              anchor: [24.7, 46.7, 0],
              wrap: { wrapReference: 24.7, worldOffset: 0, wrapMode: 'minimum-arc' },
              metrics: {
                elevation: 0,
                density: 0,
                coverage: 0,
                dispersion: 0,
                elongation: 0,
                curvature: 0,
                calibrationVersion: 1,
                fallbackReasons: [],
              },
            },
          },
        },
        recommendation: { recipeId: 'emphasis-static', source: 'resolved-recipe' },
        debugInfo: { recipeId: 'emphasis-static', profileId: 'default', reasons: { profile: ['fixture'] } },
        framingReport: {
          status: 'passed',
          scope: 'whole-shot',
          sampleCount: 2,
          messages: [],
        },
      });
      const sourceBeforeExport = JSON.stringify(cameras[0]);
      downloads.length = 0;

      panel.handleExportButtonClick();

      assert(downloads.length === 1, 'playback export downloads one story');
      const contents = await downloads[0].blob.text();
      assert(contents.includes('\n  "version"'), 'downloaded JSON uses two-space indentation');
      for (const omitted of [
        'selectedRows',
        'snapshotEnvelope',
        'coordinates',
        'debugInfo',
        'recommendation',
        'framingReport',
      ]) {
        assert(!contents.includes(`"${omitted}"`), `playback export omits ${omitted}`);
      }
      assert(
        contents.includes('"annotation"') && contents.includes('"trajectory"'),
        'playback data remains in the story',
      );
      assert(JSON.stringify(cameras[0]) === sourceBeforeExport, 'playback export does not mutate the source camera');
    },
  ],
  [
    'Story import reads the local file without an upload request',
    async () => {
      const { panel, cameras, imports } = harness(-1);
      const upload = elements(panel.render()).find((node) => named(node, 'Upload') && node.props.name === 'cameraFile');
      assert(upload, 'Story import control exists');
      assert(!upload.props.action, 'Story import cannot have a remote upload action');
      assert(typeof upload.props.beforeUpload === 'function', 'Story import intercepts the local file');
      const file = new File([JSON.stringify(createStoryJson(cameras, { trajectoryEnabled: false }))], 'story.json', {
        type: 'application/json',
      });
      const result = (upload.props.beforeUpload as (file: File) => boolean)(file);
      assert(result === false, 'returning false prevents the upload network request');
      await Promise.all(fileReads.splice(0));
      assert(
        imports.length === 1 && imports[0].length === cameras.length,
        'validated Story cameras reach the application',
      );
      assert(imports[0][1].id === cameras[1].id, 'import preserves camera identity');
    },
  ],
  [
    'local Story import rejects malformed or invalid data without replacing cameras',
    async () => {
      const { panel, imports } = harness(-1);
      const upload = elements(panel.render()).find((node) => named(node, 'Upload') && node.props.name === 'cameraFile');
      assert(upload && typeof upload.props.beforeUpload === 'function', 'local import handler exists');
      for (const [contents, expected] of [
        ['{', 'Invalid JSON file.'],
        ['{"unrelated":true}', 'Invalid story/camera JSON file.'],
      ]) {
        notices.length = 0;
        assert(
          (upload.props.beforeUpload as (file: File) => boolean)(new File([contents], 'invalid.json')) === false,
          'invalid files also remain local',
        );
        await Promise.all(fileReads.splice(0));
        assert(
          notices.some((notice) => notice.type === 'error' && notice.text === expected),
          'existing validation feedback is retained',
        );
        assert(imports.length === 0, 'invalid data cannot replace cameras');
      }
    },
  ],
  [
    'local Story import still accepts legacy camera arrays',
    async () => {
      const { panel, cameras, imports } = harness(-1);
      const upload = elements(panel.render()).find((node) => named(node, 'Upload') && node.props.name === 'cameraFile');
      assert(upload && typeof upload.props.beforeUpload === 'function', 'local import handler exists');
      notices.length = 0;
      (upload.props.beforeUpload as (file: File) => boolean)(new File([JSON.stringify(cameras)], 'legacy.json'));
      await Promise.all(fileReads.splice(0));
      assert(imports.length === 1, 'legacy cameras remain supported');
      assert(
        notices.some((notice) => notice.text === 'Imported legacy camera array. Future exports use story JSON.'),
        'legacy import guidance is retained',
      );
    },
  ],
  [
    'numeric endpoint edits record only the changed manual view',
    () => {
      const { panel, cameras, updates } = harness();
      panel.handleInitialZoomChange(1, 10);
      panel.handleFinalBearingChange(1, 45);
      assert(
        updates[0].index === 1 && updates[0].camera.authoring?.manualViews?.initial?.zoom === 10,
        'numeric zoom must persist as manual initial ownership on its row',
      );
      assert(!updates[0].camera.authoring?.manualViews?.final, 'untouched endpoint remains adaptive');
      assert(
        updates[1].camera.authoring?.manualViews?.final?.bearing === 45,
        'numeric bearing records final ownership',
      );
      assert(
        cameras[1].initViewState.zoom === 8 && cameras[1].finalViewState.bearing === 0,
        'endpoint callbacks cannot mutate props',
      );
    },
  ],
  [
    'current duration changes preserve the old camera for comparison',
    () => {
      const { panel, cameras, updates } = harness();
      panel.handleDurationChange(4500);
      assert(
        cameras[0].duration === 2000,
        'duration handler must not mutate the applied camera before App compares it',
      );
      assert(
        updates[0].camera.duration === 4500 && updates[0].camera !== cameras[0],
        'callback receives the new camera',
      );
      assert(!updates[0].camera.authoring?.manualViews, 'timing changes do not take manual ownership of the views');
    },
  ],
  [
    'all camera row duration and deletion work with no selection',
    () => {
      const { panel, cameras, updates, deletes } = harness(-1);
      const row = elements(panel.render()).find(
        (node) => node.key === 'panel-1' && String(node.props.className).includes('camera-item-panel'),
      );
      assert(row, 'second camera row exists');
      const duration = elements(row.props.children as React.ReactNode).find(
        (node) => named(node, 'InputNumber') && node.props.value === 2000,
      );
      assert(duration, 'second row duration exists');
      (duration.props.onChange as (value: number) => void)(6000);
      assert(
        updates[0]?.index === 1 && updates[0].camera.duration === 6000,
        'row duration edits its camera despite no selection',
      );
      assert(cameras[1].duration === 2000, 'row edit leaves prior props intact');
      const confirm = row.props.extra as Element;
      assert(!confirm.props.disabled, 'row deletion is available without selecting a different camera');
      (confirm.props.onConfirm as () => void)();
      assert(deletes[0] === 1, 'delete acts on its own row');
    },
  ],
  [
    'only the explicit camera title button selects a camera',
    () => {
      const { panel, selections } = harness(-1);
      const tree = elements(panel.render());
      for (const collapse of tree.filter((node) => named(node, 'Collapse'))) {
        (collapse.props.onChange as ((keys: string[]) => void) | undefined)?.(['panel-0', 'panel-1']);
      }
      assert(selections.length === 0, 'expansion and annotation expansion cannot select cameras');
      const row = tree.find(
        (node) => node.key === 'panel-1' && String(node.props.className).includes('camera-item-panel'),
      );
      assert(row, 'second camera row exists');
      const title = elements(row.props.header as React.ReactNode).find((node) => node.props['aria-pressed'] === false);
      assert(title, 'camera title exposes unselected state');
      (title.props.onClick as (event: { stopPropagation(): void }) => void)({ stopPropagation() {} });
      assert(selections[0] === 1, 'explicit title click selects its camera');
      const selectedRow = elements(harness(1).panel.render()).find(
        (node) => node.key === 'panel-1' && String(node.props.className).includes('camera-item-panel'),
      );
      assert(selectedRow, 'selected camera row exists');
      assert(
        String(selectedRow.props.className).includes('camera-item-panel-selected'),
        'selected row has visual emphasis',
      );
      assert(
        elements(selectedRow.props.header as React.ReactNode).some((node) => node.props['aria-pressed'] === true),
        'explicit selection has an accessible pressed state',
      );
    },
  ],
  [
    'camera panels explain automatic connections without exposing transition controls',
    () => {
      const { panel, cameras } = harness(0);
      cameras[0].interpolationType = 'linear';
      cameras[0].interpolationDuration = 7777;
      const tree = elements(panel.render());
      const current = tree.find((node) => node.key === 'camera-current');
      const row = tree.find(
        (node) => node.key === 'panel-1' && String(node.props.className).includes('camera-item-panel'),
      );
      assert(current && row, 'current camera and all-camera editors are present');
      for (const editor of [current, row]) {
        const controls = elements(editor.props.children as React.ReactNode);
        assert(!controls.some((node) => named(node, 'Select')), 'camera editor has no transition type picker');
        assert(
          !controls.some((node) => named(node, 'InputNumber') && node.props.value === 7777),
          'legacy interpolation duration is not an editable shot control',
        );
        assert(
          controls.some((node) => named(node, 'Text') && node.props.children === 'Shots connect automatically.'),
          'camera editor briefly explains automatic connections',
        );
      }
      assert(
        cameras[0].interpolationType === 'linear' && cameras[0].interpolationDuration === 7777,
        'opening the editor does not rewrite imported compatibility fields',
      );
    },
  ],
  [
    'annotation edits use the row rather than the selected camera',
    () => {
      const { panel, cameras, updates } = harness(0);
      const tree = elements(panel.render());
      const annotation = tree.find(
        (node) => node.key === 'panel-1' && node.props.className === 'annotation-item-panel',
      );
      assert(annotation, 'second annotation exists');
      const annotationControls = elements(annotation.props.children as React.ReactNode);
      const text = annotationControls.find((node) => named(node, 'TextArea'));
      assert(text, 'second annotation text exists');
      (text.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'Revised' } });
      const timing = annotationControls.filter((node) => named(node, 'InputNumber'));
      assert(timing.length === 2, 'annotation has delay and duration');
      for (const control of timing) (control.props.onChange as (value: number) => void)(500);
      assert(
        updates.length === 3 && updates.every((update) => update.index === 1),
        'every callback targets its own row',
      );
      assert(
        cameras[0].annotation?.text === 'first' && cameras[1].annotation?.text === 'second',
        'annotation callbacks preserve applied props',
      );
      assert(
        cameras[0].interpolationType === 'none' && cameras[1].interpolationType === 'none',
        'annotation callbacks preserve imported compatibility fields',
      );
    },
  ],
  [
    'endpoint modal wires independent local resets, Save and Cancel to their controls',
    () => {
      const renderedControls: RenderedControl[] = [];
      const Modal = loadComponent('ViewStateEditorModal', renderedControls) as React.ComponentType<
        Record<string, unknown>
      >;
      const original = camera('modal');
      let draft = updateDraftView(createDraft(original), 'initial', { ...original.initViewState, zoom: 12 });
      draft = updateDraftView(draft, 'final', { ...original.finalViewState, bearing: 90 });
      const actions: string[] = [];
      const props = {
        open: true,
        canSave: true,
        draft,
        runtime: { createLayers: () => [], effects: [], mapStyle: 'fixture-style' },
        viewportSize: { width: 800, height: 600 },
        onInitialViewStateChange() {},
        onFinalViewStateChange() {},
        onInitialReset() {
          actions.push('reset-initial');
          draft = resetDraftView(draft, 'initial');
        },
        onFinalReset() {
          actions.push('reset-final');
          draft = resetDraftView(draft, 'final');
        },
        onSave() {
          actions.push('save');
        },
        onCancel() {
          actions.push('cancel');
        },
      };
      renderToStaticMarkup(React.createElement(Modal, props));
      function resetButton(title: string) {
        const tooltip = renderedControls.find((control) => control.name === 'Tooltip' && control.props.title === title);
        assert(tooltip, `${title} is available`);
        const button = elements(tooltip.props.children as React.ReactNode).find((node) => named(node, 'Button'));
        assert(button && typeof button.props.onClick === 'function', `${title} has a working button`);
        return button;
      }
      const initialReset = resetButton('Reset initial state');
      const finalReset = resetButton('Reset final state');
      (initialReset.props.onClick as () => void)();
      assert(
        draft.initialViewState.zoom === 8 && draft.finalViewState.bearing === 90,
        'initial reset preserves the final edit',
      );
      (finalReset.props.onClick as () => void)();
      assert(
        draft.finalViewState.bearing === original.finalViewState.bearing,
        'final reset restores its original view',
      );
      assert(actions.join(',') === 'reset-initial,reset-final', 'resets do not save or cancel');
      const save = renderedControls.find(
        (control) => control.name === 'Button' && control.props.children === 'Save changes',
      );
      const cancel = renderedControls.find(
        (control) => control.name === 'Button' && control.props.children === 'Cancel',
      );
      const modal = renderedControls.find((control) => control.name === 'Modal');
      assert(save && save.props.disabled === false && cancel && modal, 'ready modal exposes Save, Cancel and close');
      (save.props.onClick as () => void)();
      (cancel.props.onClick as () => void)();
      (modal.props.onCancel as () => void)();
      assert(
        actions.join(',') === 'reset-initial,reset-final,save,cancel,cancel',
        'each control invokes its intended callback',
      );
      renderedControls.length = 0;
      renderToStaticMarkup(React.createElement(Modal, { ...props, canSave: false }));
      assert(
        renderedControls.find((control) => control.name === 'Button' && control.props.children === 'Save changes')
          ?.props.disabled === true,
        'Save is disabled when the draft cannot be saved',
      );
    },
  ],
];

async function runTests() {
  const failures: string[] = [];
  for (const [name, test] of tests) {
    try {
      await test();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
}
void runTests();
