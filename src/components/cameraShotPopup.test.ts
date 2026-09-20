import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';
import type { CameraMovement } from '../interfaces';
import type { CameraAuthoringSpec } from '../camera/authoring-types';
import type { CameraFramingTuning, CameraSelectionRequest, CameraTarget } from '../camera/types';
import { getCameraById } from '../camera/catalog';
import { getCameraOptionSelectionById, resolveCameraRecipe } from '../camera/recipes';
import type { PanelLibraryProps } from './PanelLibrary';

interface ElementNode {
  type: unknown;
  props: { children?: unknown; [key: string]: unknown };
}

interface PanelInstance {
  props: PanelLibraryProps;
  state: Record<string, unknown>;
  setState(update: unknown): void;
  componentDidUpdate(previous: PanelLibraryProps): void;
  handleCameraOptionChange(cameraName: string, optionId: string): void;
  applyCameraPopup(cameraName: string): void;
  render(): ElementNode;
}

/** Exercise the real component, substituting only its UI rendering boundaries. */
function loadPanel() {
  const output = ts.transpileModule(readFileSync('src/components/PanelLibrary.tsx', 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const localRequire = (id: string): unknown => {
    if (id.endsWith('.css')) return {};
    if (id === 'antd') {
      return {
        ...Object.fromEntries(
          [
            'Alert',
            'Button',
            'Card',
            'Collapse',
            'Divider',
            'Popover',
            'Popconfirm',
            'Slider',
            'InputNumber',
            'Select',
            'Space',
            'Tabs',
            'Tag',
            'Tooltip',
          ].map((name) => [name, name]),
        ),
        List: Object.assign(function List() {}, { Item: Object.assign(function Item() {}, { Meta: 'Meta' }) }),
        Radio: Object.assign(function Radio() {}, { Group: 'RadioGroup', Button: 'RadioButton' }),
        Typography: { Text: 'Text' },
      };
    }
    if (id === '@ant-design/icons' || id.startsWith('react-icons/'))
      return new Proxy({}, { get: (_, key) => String(key) });
    return id.startsWith('.') ? require(path.resolve('.cache/camera-tests/src/components', id)) : require(id);
  };
  const moduleValue: { exports: { default?: new (props: PanelLibraryProps) => PanelInstance } } = { exports: {} };
  const execute = runInThisContext(`(function(require, module, exports) {\n${output}\n})`) as (
    ...args: unknown[]
  ) => void;
  execute(localRequire, moduleValue, moduleValue.exports);
  assert(moduleValue.exports.default);
  return moduleValue.exports.default;
}

function nodes(value: unknown, includeAdvanced = false): ElementNode[] {
  if (Array.isArray(value)) return value.flatMap((item) => nodes(item, includeAdvanced));
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as ElementNode;
  const children: unknown[] = [element.props.children, element.props.title, element.props.content];
  if (typeof element.type === 'function' && element.type.name === 'List') {
    const renderItem = element.props.renderItem as (item: unknown) => unknown;
    children.push((element.props.dataSource as unknown[]).map(renderItem));
  }
  if (element.type === 'Meta') children.push(element.props.avatar, element.props.description);
  if (element.type === 'Tabs' || (element.type === 'Collapse' && includeAdvanced)) {
    children.push((element.props.items as { children: unknown }[]).map((item) => item.children));
  }
  return [element, ...children.flatMap((child) => nodes(child, includeAdvanced))];
}

const target: CameraTarget = { id: 'target-a', type: 'location', center: [0, 0], bbox: [0, 0, 0, 0] };

function camera(name = 'emphasis-push-in'): CameraMovement {
  return {
    id: 'shot-a',
    name,
    title: 'Push in shot',
    category: 'emphasis',
    targetId: target.id,
    initViewState: { longitude: 0, latitude: 0, zoom: 10, pitch: 30, bearing: 0 },
    finalViewState: { longitude: 0, latitude: 0, zoom: 11, pitch: 30, bearing: 0 },
    duration: 2000,
    stay: 0,
    isRotating: false,
    interpolationType: 'linear',
    interpolationDuration: 0,
  };
}

function setup(overrides: Partial<PanelLibraryProps> = {}) {
  const requests: CameraSelectionRequest[] = [];
  const patches: Partial<CameraFramingTuning>[] = [];
  const events: string[] = [];
  const intents: CameraAuthoringSpec[] = [];
  const props = {
    currentCategory: 'emphasis',
    currentCamera: 'none',
    currentLocation: [0, 0],
    currentTarget: target,
    comparisonPair: [],
    selectionKey: null,
    onCameraCategoryClick: (category: string) => events.push(`purpose:${category}`),
    onCameraMovementItemChange: (request: CameraSelectionRequest) => requests.push(request),
    onCameraAdjust: (patch: Partial<CameraFramingTuning>) => patches.push(patch),
    onCameraAuthoringChange: (spec: CameraAuthoringSpec) => intents.push(spec),
    onCameraSourceCapture: (kind: string) => events.push(`source:${kind}`),
    onCameraContextCapture: () => events.push('context:capture'),
    onCameraPreview: () => events.push('preview'),
    onCameraApply: () => {
      events.push('apply');
      return true;
    },
    onCameraCancel: () => events.push('cancel'),
    ...overrides,
  };
  const Panel = loadPanel();
  const panel = new Panel(props);
  panel.setState = (update) => {
    const next = typeof update === 'function' ? update(panel.state, panel.props) : update;
    panel.state = { ...panel.state, ...next };
  };
  const all = (advanced = false) => nodes(panel.render(), advanced);
  const popup = (name = 'emphasis-push-in') => {
    const found = all().find(
      (node) => node.type === 'Popover' && (node.props.children as ElementNode)?.props.value === name,
    );
    assert(found, 'available shot uses a controlled Popover');
    return found;
  };
  const open = (name = 'emphasis-push-in') => (popup(name).props.onOpenChange as (value: boolean) => void)(true);
  const changeProps = (patch: Partial<PanelLibraryProps>) => {
    const previous = panel.props;
    panel.props = { ...previous, ...patch };
    panel.componentDidUpdate?.(previous);
  };
  const button = (label: string) => {
    const found = nodes(popup().props.content, true).find(
      (node) => node.type === 'Button' && node.props.children === label,
    );
    assert(found, `${label} button exists`);
    return found;
  };
  return { panel, requests, patches, intents, events, all, popup, open, changeProps, button };
}

function testShotPopupUsesCompactDefaultsAndExplicitApply() {
  const h = setup();
  const purpose = h.all().find((node) => node.type === 'RadioButton' && node.props.value === 'overview');
  assert(purpose);
  (purpose.props.onClick as () => void)();
  assert.deepEqual(h.events, ['purpose:overview']);
  assert.equal(h.requests.length, 0, 'purpose selection never creates a draft');
  h.open();
  assert.equal(h.popup().props.open, true);
  const dialog = nodes(h.popup().props.content).find((node) => node.props.role === 'dialog');
  assert.equal(dialog?.props.tabIndex, -1, 'the dialog can receive focus when it opens');
  assert.equal((h.popup().props.children as ElementNode).props['aria-controls'], dialog?.props.id);
  assert.equal(h.requests[0].action, 'add');
  assert.equal(h.requests[0].optionSelection?.id, 'normal', 'Normal wins over catalog-first Fast');
  assert.equal(h.button('Add shot').props.disabled, true, 'unprepared draft cannot apply');
  h.changeProps({ candidate: { camera: camera(), adjustments: {}, action: 'add' } });
  const content = nodes(h.popup().props.content);
  const advanced = content.find((node) => node.type === 'Collapse');
  assert(advanced);
  assert.deepEqual(advanced.props.activeKey, []);
  assert.equal(
    content.filter((node) => node.type === 'Slider').length,
    0,
    'all numeric controls are inside collapsed Advanced',
  );
  assert.equal(content.filter((node) => node.type === 'Alert').length, 0, 'no routine framing report');
  const buttons = nodes(h.popup().props.content)
    .filter((node) => node.type === 'Button')
    .map((node) => node.props.children);
  assert.deepEqual(buttons, ['Preview', 'Add shot', 'Cancel']);
  (h.button('Preview').props.onClick as () => void)();
  assert.equal(h.popup().props.open, true, 'preview keeps the editor open');
  assert.deepEqual(h.events, ['purpose:overview', 'preview']);
  (h.button('Add shot').props.onClick as () => void)();
  assert.equal(h.popup().props.open, false);
  (h.popup().props.onOpenChange as (value: boolean) => void)(false);
  assert.deepEqual(h.events, ['purpose:overview', 'preview', 'apply'], 'apply closure never cancels committed state');
}

function testPresetSemanticsAndActualTimingAreVisible() {
  const moving = setup();
  moving.open();
  const shot = camera();
  shot.duration = 3200;
  shot.stay = 2000;
  moving.changeProps({ candidate: { camera: shot, adjustments: {}, action: 'add' } });
  const content = nodes(moving.popup().props.content);
  const timing = content.find((node) => node.props['aria-label'] === 'Shot timing');
  assert(timing, 'actual movement and hold are visible without opening Advanced');
  assert.equal(timing.props.children, 'Move: 3.2 s · Hold: 2.0 s · Total: 5.2 s');
  assert(content.some((node) => node.props.children === 'Pace'));

  const stationary = setup();
  stationary.open('emphasis-static');
  assert.equal(stationary.requests[0].optionSelection?.id, 'medium');
  const still = camera('emphasis-static');
  still.duration = 4000;
  still.stay = 0;
  stationary.changeProps({ candidate: { camera: still, adjustments: {}, action: 'add' } });
  const controls = nodes(stationary.popup('emphasis-static').props.content, true);
  assert(controls.some((node) => node.props.children === 'Display duration'));
  assert(!controls.some((node) => node.props.ariaLabelForHandle === 'Pace'), 'static shots have no movement pace');
  assert.equal(
    controls.find((node) => node.props['aria-label'] === 'Shot timing')?.props.children,
    'Total display: 4.0 s',
  );
}

testPresetSemanticsAndActualTimingAreVisible();

function testPresetDefaultsAndAdvancedPaceStayInSync() {
  const h = setup();
  h.open();
  h.changeProps({
    candidate: { camera: camera(), adjustments: { framingTightness: 0.2 }, action: 'add' },
  });
  const presets = nodes(h.popup().props.content).find((node) => node.type === 'RadioGroup');
  assert(presets);
  (presets.props.onChange as (event: unknown) => void)({ target: { value: 'fast' } });
  assert.equal(h.requests[1].optionSelection?.id, 'fast');
  assert.equal((h.requests[1] as CameraSelectionRequest & { resetAdjustments?: boolean }).resetAdjustments, true);
  const fast = getCameraOptionSelectionById('emphasis-push-in', 'fast');
  const draft = camera();
  draft.authoring = {
    version: 1,
    targetId: target.id,
    recipeId: draft.name,
    optionSelection: fast,
    adjustments: {},
    planningViewport: { width: 1200, height: 800 },
  };
  h.changeProps({ candidate: { camera: draft, adjustments: {}, action: 'add' } });
  const sliders = nodes(h.popup().props.content, true).filter((node) => node.type === 'Slider');
  assert(sliders.length >= 4);
  const slider = (label: string) => sliders.find((node) => node.props.ariaLabelForHandle === label)!;
  assert.equal(slider('Distance').props.value, 0);
  const recipe = resolveCameraRecipe(draft.name, fast);
  assert.equal(
    slider('Angle').props.value,
    recipe.framing.pitchTarget ??
      recipe.framing.pitchRange[0] + (recipe.framing.pitchRange[1] - recipe.framing.pitchRange[0]) * 0.35,
  );
  assert.equal(slider('Margin').props.value, recipe.framing.paddingRatio);
  assert.equal(slider('Pace').props.value, 4, 'Fast 0.5s / base 2s is shown as 4×');
  (slider('Pace').props.onChange as (value: number) => void)(2);
  assert.deepEqual(h.patches, [{ speedScale: 0.5 }], 'pace patch removes the preset multiplier');
}

function testSavedPresetAndReplacementAreRestored() {
  const selected = camera();
  selected.authoring = {
    version: 1,
    targetId: target.id,
    recipeId: selected.name,
    optionSelection: getCameraOptionSelectionById(selected.name, 'fast'),
    adjustments: { pitchTarget: 48, speedScale: 0.5 },
    planningViewport: { width: 1200, height: 800 },
  };
  const h = setup({ selectedCamera: selected, selectionKey: selected.id });
  h.open();
  assert.equal(h.requests[0].action, 'replace');
  assert.equal(h.requests[0].optionSelection?.id, 'fast');
  assert.equal((h.requests[0] as CameraSelectionRequest & { resetAdjustments?: boolean }).resetAdjustments, undefined);
  h.changeProps({
    candidate: { camera: selected, adjustments: selected.authoring.adjustments, action: 'replace' },
  });
  assert.equal(h.button('Replace').props.disabled, false);
  const angle = nodes(h.popup().props.content, true).find(
    (node) => node.type === 'Slider' && node.props.ariaLabelForHandle === 'Angle',
  );
  assert.equal(angle?.props.value, 48);
  (h.button('Cancel').props.onClick as () => void)();
  assert.equal(h.popup().props.open, false);
  assert.deepEqual(h.events, ['cancel']);
}

function testDismissalSelectionChangesAndFailuresCannotApplyStaleDrafts() {
  for (const patch of [{ selectionKey: 'other-shot' }, { currentTarget: { ...target, id: 'other-target' } }]) {
    const h = setup();
    h.open();
    h.changeProps(patch);
    assert.equal(h.popup().props.open, false);
    assert.deepEqual(h.events, ['cancel']);
    (h.button('Add shot').props.onClick as () => void)();
    assert.deepEqual(h.events, ['cancel'], 'closed handlers cannot apply stale drafts');
  }
  const h = setup();
  h.open();
  h.changeProps({
    candidate: { camera: camera('dynamic-pan'), adjustments: {}, action: 'add' },
  });
  assert.equal(h.button('Add shot').props.disabled, true);
  h.changeProps({
    candidate: { camera: camera(), adjustments: {}, action: 'add' },
    requestError: 'Select a valid target.',
  });
  assert.equal(h.button('Add shot').props.disabled, true);
  const error = nodes(h.popup().props.content).find((node) => node.type === 'Alert');
  assert.equal(error?.props.message, 'Select a valid target.');
  (h.popup().props.onOpenChange as (value: boolean) => void)(false);
  assert.deepEqual(h.events, ['cancel']);
  const unavailable = setup({ currentTarget: undefined });
  assert.equal(
    unavailable
      .all()
      .some(
        (node) => node.type === 'Popover' && (node.props.children as ElementNode)?.props.value === 'emphasis-push-in',
      ),
    false,
  );
  assert.equal(unavailable.requests.length, 0);
  assert(getCameraById('emphasis-push-in'));
}

function testFailedDraftRemainsEditableAndFailedApplyStaysOpen() {
  const h = setup({ onCameraApply: () => false });
  h.open();
  h.changeProps({ candidate: { camera: camera(), adjustments: {}, action: 'add' } });
  (h.button('Add shot').props.onClick as () => void)();
  assert.equal(h.popup().props.open, true, 'failed apply retains the draft');
  h.changeProps({
    candidate: { camera: camera(), adjustments: {}, action: 'add', error: 'Reduce the angle to fit this target.' },
  });
  assert.equal(h.button('Add shot').props.disabled, true);
  assert.equal(h.button('Preview').props.disabled, true);
  const angle = nodes(h.popup().props.content, true).find(
    (node) => node.type === 'Slider' && node.props.ariaLabelForHandle === 'Angle',
  );
  assert.equal(angle?.props.disabled, false, 'failed adjustment can be corrected');
  (angle.props.onChange as (value: number) => void)(20);
  assert.deepEqual(h.patches, [{ pitchTarget: 20 }]);
}

function testAdvancedCollapsesWhenTheSameShotReopens() {
  for (const dismissal of ['Cancel', 'Add shot', 'outside']) {
    const h = setup();
    const advanced = () => {
      const control = nodes(h.popup().props.content).find((node) => node.type === 'Collapse');
      assert(control);
      return control;
    };
    h.open();
    h.changeProps({ candidate: { camera: camera(), adjustments: {}, action: 'add' } });
    assert.equal(typeof advanced().props.onChange, 'function', 'Advanced controls its open state');
    (advanced().props.onChange as (keys: string[]) => void)(['advanced']);
    assert.deepEqual(advanced().props.activeKey, ['advanced']);
    const presets = nodes(h.popup().props.content).find((node) => node.type === 'RadioGroup');
    assert(presets);
    (presets.props.onChange as (event: unknown) => void)({ target: { value: 'fast' } });
    assert.deepEqual(advanced().props.activeKey, ['advanced'], 'preset changes keep the current section open');
    if (dismissal === 'outside') (h.popup().props.onOpenChange as (value: boolean) => void)(false);
    else (h.button(dismissal).props.onClick as () => void)();
    assert.equal(h.popup().props.open, false);
    h.open();
    assert.deepEqual(
      advanced().props.activeKey,
      [],
      `Advanced resets after ${dismissal} even when popup content is cached`,
    );
  }
}

testShotPopupUsesCompactDefaultsAndExplicitApply();
testPresetDefaultsAndAdvancedPaceStayInSync();
testSavedPresetAndReplacementAreRestored();
testDismissalSelectionChangesAndFailuresCannotApplyStaleDrafts();
testFailedDraftRemainsEditableAndFailedApplyStaysOpen();
testAdvancedCollapsesWhenTheSameShotReopens();

function testAdvancedExplainsAutomaticConnectionsWithoutTransitionSettings() {
  for (const legacyTransition of [undefined, 'cut'] as const) {
    const saved = camera();
    const spec: CameraAuthoringSpec = {
      version: 2,
      targetId: target.id,
      recipeId: saved.name,
      adjustments: {},
      planningViewport: { width: 1200, height: 800 },
      ...(legacyTransition ? { transition: legacyTransition } : {}),
    };
    saved.authoring = spec;
    const h = setup();
    h.open();
    h.changeProps({ candidate: { camera: saved, spec, adjustments: {}, action: 'add' } });
    const controls = nodes(h.popup().props.content, true);
    assert(
      !controls.some((node) => node.props['aria-label'] === 'Transition into shot'),
      'Advanced has no explicit connection setting for new or imported shots',
    );
    assert(
      controls.some((node) => node.type === 'Text' && node.props.children === 'Shots connect automatically.'),
      'Advanced briefly explains automatic connections',
    );
    const duration = controls.find((node) => node.props['aria-label'] === 'Duration seconds');
    assert(duration, 'shot timing remains editable');
    (duration.props.onChange as (value: number) => void)(3);
    assert.equal(h.intents[0].transition, legacyTransition, 'timing edits do not create a new transition setting');
  }
}

testAdvancedExplainsAutomaticConnectionsWithoutTransitionSettings();

function testMotionAndCompositionCallbacksKeepCompleteIntent() {
  const saved = camera();
  const spec: CameraAuthoringSpec = {
    version: 2,
    targetId: target.id,
    recipeId: saved.name,
    adjustments: { pitchTarget: 24 },
    planningViewport: { width: 1200, height: 800 },
    motion: { zoomDelta: 1.5 },
    source: { kind: 'reference-view', view: { ...saved.initViewState, longitude: 7 } },
    composition: { anchor: 'visual', offsetRatio: [0.12, -0.08] },
    manualViews: { initial: saved.initViewState },
    transition: 'cut',
  };
  saved.authoring = spec;
  const h = setup();
  h.open();
  h.changeProps({ candidate: { camera: saved, spec, adjustments: spec.adjustments, action: 'add' } });
  const control = (label: string) => {
    const found = nodes(h.popup().props.content, true).find((node) => node.props['aria-label'] === label);
    assert(found, `${label} exists`);
    return found;
  };
  const zoom = control('Zoom travel');
  assert.equal(zoom.props.value, 1.5, 'requested zoom travel wins over resolved endpoints');
  (zoom.props.onChange as (value: number) => void)(2);
  assert.equal(h.intents[0].motion?.zoomDelta, 2);
  assert.equal(h.intents[0].source?.view.longitude, 7, 'motion edit keeps the saved reference');
  assert.deepEqual(h.intents[0].composition?.offsetRatio, [0.12, -0.08]);
  assert.equal(spec.motion?.zoomDelta, 1.5, 'callback does not mutate existing draft');
  (h.button('Return initial to Auto').props.onClick as () => void)();
  assert.equal(h.intents[1].manualViews?.initial, undefined, 'release applies to initial ownership only');
  assert.equal(h.intents[1].motion?.zoomDelta, 1.5, 'release retains motion request');
  (control('Movement source').props.onChange as (value: string) => void)('previous-camera');
  assert(h.events.includes('source:previous-camera'), 'source choice delegates a fresh snapshot capture');
  (h.button('Capture map context').props.onClick as () => void)();
  assert(h.events.includes('context:capture'));
}

function testTargetlessControlsAndRotationRequests() {
  const h = setup({ currentCategory: 'dynamic', currentTarget: undefined });
  h.open('dynamic-arc');
  const saved = camera('dynamic-arc');
  saved.targetSnapshot = { ...target, type: 'none' };
  saved.authoring = {
    version: 2,
    targetId: target.id,
    recipeId: saved.name,
    adjustments: {},
    planningViewport: { width: 1200, height: 800 },
    motion: { startBearing: 40, bearingSweep: -120 },
  };
  h.changeProps({ candidate: { camera: saved, spec: saved.authoring, adjustments: {}, action: 'add' } });
  const controls = nodes(h.popup('dynamic-arc').props.content, true);
  assert(
    !controls.some(
      (node) => node.props.ariaLabelForHandle === 'Distance' || node.props.ariaLabelForHandle === 'Margin',
    ),
    'targetless distance and margin are hidden',
  );
  const sweep = controls.find((node) => node.props['aria-label'] === 'Bearing sweep');
  assert(sweep, 'arc exposes signed bearing sweep');
  assert.equal(sweep.props.value, -120);
  (sweep.props.onChange as (value: number) => void)(-200);
  assert.equal(h.intents[0].motion?.bearingSweep, -200);
  assert.equal(h.intents[0].motion?.startBearing, 40);
}

testMotionAndCompositionCallbacksKeepCompleteIntent();
testTargetlessControlsAndRotationRequests();

function testLegacyTargetlessPopupExplainsManualOwnership() {
  const saved = camera();
  saved.authoring = {
    version: 1,
    targetId: target.id,
    recipeId: saved.name,
    adjustments: {},
    planningViewport: { width: 1200, height: 800 },
    manualViews: { initial: saved.initViewState, final: saved.finalViewState },
  };
  const h = setup({ selectedCamera: saved, selectionKey: saved.id, currentTarget: undefined });
  h.open();
  h.changeProps({ candidate: { camera: saved, spec: saved.authoring, adjustments: {}, action: 'replace' } });
  const controls = nodes(h.popup().props.content, true);
  const angle = controls.find((node) => node.props.ariaLabelForHandle === 'Angle');
  assert.equal(angle?.props.disabled, true, 'manual preserved import cannot pretend automatic framing is active');
  assert.equal(
    h.button('Return initial to Auto').props.disabled,
    true,
    'required target must exist before releasing a manual endpoint',
  );
  assert.equal(h.button('Return final to Auto').props.disabled, true);
}

testLegacyTargetlessPopupExplainsManualOwnership();

function testSingleTargetPanExposesIndependentZoomTravel() {
  const h = setup();
  h.open('emphasis-pan');
  const saved = camera('emphasis-pan');
  const spec: CameraAuthoringSpec = {
    version: 2,
    targetId: target.id,
    recipeId: saved.name,
    adjustments: {},
    planningViewport: { width: 1200, height: 800 },
    source: { kind: 'reference-view', view: { ...saved.initViewState, zoom: 5 } },
    composition: { anchor: 'ground' },
    motion: { zoomDelta: 2.25 },
  };
  h.changeProps({ candidate: { camera: saved, spec, adjustments: {}, action: 'add' } });
  const zoom = nodes(h.popup('emphasis-pan').props.content, true).find(
    (node) => node.props['aria-label'] === 'Zoom travel',
  );
  assert(zoom, 'single-target pan can request context-to-target zoom travel');
  assert.equal(zoom.props.value, 2.25);
  assert.equal(zoom.props.disabled, false);
  (zoom.props.onChange as (value: number) => void)(3);
  assert.equal(h.intents[0].motion?.zoomDelta, 3);
  assert.equal(h.intents[0].source?.view.zoom, 5, 'pan zoom adjustment preserves its frozen context source');
  assert.equal(h.intents[0].composition?.anchor, 'ground');

  const pair = setup({
    currentCategory: 'comparison',
    comparisonPair: [target, { ...target, id: 'target-b', center: [1, 1] }],
  });
  pair.open('comparison-pan');
  const comparison = camera('comparison-pan');
  pair.changeProps({ candidate: { camera: comparison, adjustments: {}, action: 'add' } });
  assert(
    !nodes(pair.popup('comparison-pan').props.content, true).some((node) => node.props['aria-label'] === 'Zoom travel'),
    'two-target comparison pan retains equal-scale semantics',
  );
}

testSingleTargetPanExposesIndependentZoomTravel();

function testBasicPullOutHidesIneffectiveTargetFraming() {
  const h = setup({ currentTarget: undefined });
  h.open('basic-pull-out');
  const saved = camera('basic-pull-out');
  saved.targetSnapshot = { ...target, type: 'none' };
  saved.framingReport = { status: 'passed', scope: 'targetless', sampleCount: 2, messages: [] };
  h.changeProps({ candidate: { camera: saved, adjustments: {}, action: 'add' } });
  const controls = nodes(h.popup('basic-pull-out').props.content, true);
  for (const label of ['Distance', 'Margin'])
    assert(
      !controls.some((node) => node.props.ariaLabelForHandle === label),
      `${label} is hidden for current-view Basic Pull out`,
    );
  for (const label of ['Context framing', 'Target anchor', 'Screen offset X', 'Screen offset Y'])
    assert(
      !controls.some((node) => node.props['aria-label'] === label),
      `${label} is hidden when the strategy ignores geographic targets`,
    );
  assert(
    controls.some((node) => node.props['aria-label'] === 'Zoom travel'),
    'targetless pull-out retains effective motion controls',
  );

  const targetful = setup();
  targetful.open();
  targetful.changeProps({ candidate: { camera: camera(), adjustments: {}, action: 'add' } });
  const targetfulControls = nodes(targetful.popup().props.content, true);
  assert(
    targetfulControls.some((node) => node.props.ariaLabelForHandle === 'Distance'),
    'targetful emphasis retains Distance',
  );
  assert(
    targetfulControls.some((node) => node.props.ariaLabelForHandle === 'Margin'),
    'targetful emphasis retains Margin',
  );
  assert(
    targetfulControls.some((node) => node.props['aria-label'] === 'Context framing'),
    'targetful emphasis retains Context',
  );
  assert(
    targetfulControls.some((node) => node.props['aria-label'] === 'Target anchor'),
    'targetful emphasis retains Anchor',
  );
}

testBasicPullOutHidesIneffectiveTargetFraming();

function testMotionNumbersDisplayCleanlyWithoutChangingStoredIntent() {
  const h = setup();
  h.open();
  const saved = camera();
  const rawDelta = 2.119999999999999;
  const spec: CameraAuthoringSpec = {
    version: 2,
    targetId: target.id,
    recipeId: saved.name,
    adjustments: {},
    planningViewport: { width: 1200, height: 800 },
    motion: { zoomDelta: rawDelta },
  };
  h.changeProps({ candidate: { camera: saved, spec, adjustments: {}, action: 'add' } });
  const controls = nodes(h.popup().props.content, true);
  const zoom = controls.find((node) => node.props['aria-label'] === 'Zoom travel');
  assert.equal(zoom?.props.value, 2.12, 'numeric inputs omit floating-point artifacts');
  const requested = controls.find(
    (node) =>
      node.type === 'Text' &&
      Array.isArray(node.props.children) &&
      node.props.children.join('').startsWith('Requested:'),
  );
  assert.equal((requested?.props.children as unknown[]).join(''), 'Requested: zoom travel 2.12');
  assert.equal(spec.motion?.zoomDelta, rawDelta, 'rendering does not rewrite stored precision');
  assert.equal(h.intents.length, 0, 'formatting emits no edit callback');
  (zoom.props.onChange as (value: number) => void)(2.123456);
  assert.equal(h.intents[0].motion?.zoomDelta, 2.123456, 'six-place user values retain their requested precision');
}

testMotionNumbersDisplayCleanlyWithoutChangingStoredIntent();

function testSplitControlsDescribeDisplayTimeAndResetWholePresetTiming() {
  const pair: CameraTarget[] = [target, { ...target, id: 'target-b', center: [1, 1] }];
  const h = setup({ currentCategory: 'comparison', comparisonPair: pair });
  const name = 'comparison-side-by-side';
  h.open(name);
  const saved = { ...camera(name), presentation: 'split' as const, duration: 3000, stay: 6000 };
  const spec: CameraAuthoringSpec = {
    version: 2,
    targetId: target.id,
    recipeId: name,
    adjustments: { speedScale: 2 },
    timing: { duration: 3000, stay: 6000, startDelay: 250 },
    planningViewport: { width: 1000, height: 600 },
  };
  h.changeProps({ candidate: { camera: saved, spec, adjustments: spec.adjustments, action: 'add' } });
  const controls = nodes(h.popup(name).props.content, true);
  assert(
    controls.some((node) => node.props['aria-label'] === 'Display duration seconds'),
    'split duration is identified as display time',
  );
  assert(
    controls.some((node) => node.props['aria-label'] === 'Extra hold seconds'),
    'legacy extra hold is visible and editable',
  );
  assert(
    !controls.some((node) => node.props.ariaLabelForHandle === 'Pace'),
    'static split does not expose movement pace',
  );
  const reset = controls.find((node) => node.type === 'Button' && node.props.children === 'Use preset timing');
  assert(reset, 'split can restore both duration and stay to the selected preset');
  (reset.props.onClick as () => void)();
  assert.equal(h.intents[0].timing?.duration, undefined);
  assert.equal(h.intents[0].timing?.stay, undefined);
  assert.equal(h.intents[0].timing?.startDelay, 250);
  assert.equal(h.intents[0].adjustments.speedScale, undefined, 'restoring split preset removes legacy movement pace');
}

testSplitControlsDescribeDisplayTimeAndResetWholePresetTiming();

function testTruckingIsAbsentForEveryTargetType() {
  for (const type of ['none', 'location', 'region', 'path', 'multiple'] as const) {
    const h = setup({ currentCategory: 'overview', currentTarget: { ...target, type } });
    const values = h.all(true).map((node) => node.props.value);
    for (const id of ['overview-trucking', 'basic-trucking']) {
      assert(!values.includes(id), `${id} must be hidden for ${type} targets`);
    }
    for (const id of ['overview-pan', 'overview-tracking', 'basic-pan', 'basic-tracking']) {
      assert(values.includes(id), `${id} must remain visible for ${type} targets`);
    }
  }
  const h = setup({
    currentCategory: 'overview',
    currentTarget: undefined,
    selectedCamera: camera('overview-trucking'),
  });
  assert(
    !h.all(true).some((node) => ['overview-trucking', 'basic-trucking'].includes(String(node.props.value))),
    'selecting an existing Trucking shot does not add a legacy library entry',
  );
}

function testStaleTruckingLibraryEventsCannotCreateOrApplyShots() {
  for (const id of ['overview-trucking', 'basic-trucking']) {
    const item = getCameraById(id) as NonNullable<ReturnType<typeof getCameraById>> & { hiddenFromLibrary?: boolean };
    const previous = item.hiddenFromLibrary;
    try {
      // Capture real event handlers while visible, then retire the catalog entry.
      item.hiddenFromLibrary = false;
      const h = setup({ currentCategory: 'overview', currentTarget: { ...target, type: 'region' } });
      const open = h.popup(id).props.onOpenChange as (value: boolean) => void;
      item.hiddenFromLibrary = true;
      open(true);
      assert.equal(h.requests.length, 0, 'a stale open event cannot create a hidden shot');
      assert.equal(h.panel.state.openCameraName, null);

      item.hiddenFromLibrary = false;
      open(true);
      h.changeProps({ candidate: { camera: camera(id), adjustments: {}, action: 'add' } });
      const preview = nodes(h.popup(id).props.content).find(
        (node) => node.type === 'Button' && node.props.children === 'Preview',
      );
      assert(preview);
      const requestCount = h.requests.length;
      item.hiddenFromLibrary = true;
      h.panel.handleCameraOptionChange(id, 'fast');
      (preview.props.onClick as () => void)();
      h.panel.applyCameraPopup(id);
      assert.equal(h.requests.length, requestCount, 'a stale mode change cannot regenerate a hidden shot');
      assert(
        !h.events.includes('preview') && !h.events.includes('apply'),
        'stale candidate actions cannot commit a hidden shot',
      );
    } finally {
      if (previous === undefined) delete item.hiddenFromLibrary;
      else item.hiddenFromLibrary = previous;
    }
  }
}

testStaleTruckingLibraryEventsCannotCreateOrApplyShots();
testTruckingIsAbsentForEveryTargetType();
