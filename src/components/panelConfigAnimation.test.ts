import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import React from 'react';
import { Select, Slider, Switch } from 'antd';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { VisualizationConfig, VisualizationParameterValues } from '../visualization/types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Element = React.ReactElement<Record<string, unknown>>;

function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as React.ReactNode)];
}

function loadPanelConfig(): unknown {
  const output = ts.transpileModule(readFileSync('src/components/PanelConfig.tsx', 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const localRequire = (id: string): unknown => {
    if (id.endsWith('.css') || id === 'file-saver' || id === '../util') return {};
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
}

const PanelConfig = loadPanelConfig() as new (props: object) => Panel;

function visualization(enabledKey = 'animated', speedKey = 'animationSpeed'): VisualizationConfig {
  const animation = { enabledParam: enabledKey, speedParam: speedKey, timeParam: 'time', frameModulo: 5000 };
  return {
    revision: 'test',
    id: 'custom-animation',
    title: 'Custom animation',
    datasetId: 'test',
    mapStyle: 'carto.darkNoLabels',
    initialViewState: 'test',
    layers: [],
    animation,
    parameters: [
      { key: enabledKey, label: 'Animated', control: 'switch', default: true },
      {
        key: speedKey,
        label: 'Speed',
        control: 'select',
        default: 1,
        options: [
          { value: 0.25, label: '0.25×', description: 'Detailed inspection' },
          { value: 0.5, label: '0.5×', description: 'Slow overview' },
          { value: 1, label: '1×', description: 'Normal flow' },
          { value: 2, label: '2×', description: 'Fast preview' },
          { value: 4, label: '4×', description: 'Quick scan' },
        ],
      },
      { key: 'trail', label: 'Trail', control: 'slider', default: 120, min: 0, max: 200 },
      {
        key: 'style',
        label: 'Style',
        control: 'select',
        default: 'line',
        options: [{ value: 'line', label: 'Line' }],
      },
      { key: 'visible', label: 'Visible', control: 'switch', default: true },
    ],
  };
}

function harness(config = visualization(), values: VisualizationParameterValues = {}) {
  const updates: { params: VisualizationParameterValues; key?: string }[] = [];
  const props = {
    cameraMovementList: [],
    currentCameraIndex: -1,
    currentCameraPreviewIndex: -1,
    isCurrentCameraPreviewPlaying: false,
    panelTimelineHeight: 200,
    activeVisualizationId: config.id,
    visualizationCatalog: { revision: 'test', defaultVisualization: config.id, datasets: [], visualizations: [config] },
    visualizationParams: values,
    manualParameterKeys: [],
    onVisualizationParamsChange: (params: VisualizationParameterValues, key?: string) => {
      updates.push({ params, key });
      props.visualizationParams = params;
    },
  };
  const panel = new PanelConfig(props);
  return { panel, updates, props };
}

function settingRows(panel: Panel) {
  return elements(panel.render()).filter((node) => node.props.className === 'visualization-setting-row');
}

function settingRow(panel: Panel, key: string) {
  const row = settingRows(panel).find((node) => node.key === key);
  assert(row, `${key} setting row is rendered`);
  return row;
}

function control(row: Element, type: unknown) {
  const result = elements(row).find((node) => node.type === type);
  assert(result, 'expected control is rendered in the setting row');
  return result;
}

function change(control: Element, value: boolean | number) {
  (control.props.onChange as (value: boolean | number) => void)(value);
}

const tests: [string, () => void][] = [
  [
    'animation speed has its own labelled row immediately below Animated',
    () => {
      for (const label of ['Speed', 'Pace']) {
        const config = visualization();
        config.parameters!.find((parameter) => parameter.key === 'animationSpeed')!.label = label;
        const { panel } = harness(config);
        const rows = settingRows(panel);
        const animatedIndex = rows.findIndex((row) => row.key === 'animated');
        assert(rows[animatedIndex + 1].key === 'animationSpeed', 'speed follows the Animated row');
        const row = settingRow(panel, 'animationSpeed');
        const speed = control(row, Select);
        assert(renderToStaticMarkup(row).includes(`${label}:`), 'row label follows configuration');
        assert(speed.props['aria-label'] === label, 'speed keeps its accessible name');
      }
    },
  ],
  [
    'animation exposes accessible controls with the enabled default speed',
    () => {
      const { panel } = harness();
      const row = settingRow(panel, 'animated');
      const toggle = control(row, Switch);
      const speedRow = settingRow(panel, 'animationSpeed');
      const speed = control(speedRow, Select);
      assert(toggle.props.checked === true, 'switch uses the enabled default');
      assert(speed.props.value === 1 && speed.props.disabled === false, 'default 1× speed is enabled');
      assert(!elements(row).some((node) => node.type === Select), 'Animated row contains only its switch');
      assert(settingRows(panel).filter((node) => node.key === 'animationSpeed').length === 1, 'speed appears once');
      assert(control(settingRow(panel, 'trail'), Slider).props.value === 120, 'Trail remains a separate slider');
      const markup = renderToStaticMarkup(row) + renderToStaticMarkup(speedRow);
      assert(
        markup.includes('role="switch"') && markup.includes('aria-label="Animated"'),
        'switch has an accessible name',
      );
      assert(
        markup.includes('role="combobox"') && markup.includes('aria-label="Speed"'),
        'speed has an accessible name',
      );
    },
  ],
  [
    'numeric speed changes survive disabling and re-enabling animation',
    () => {
      const { panel, updates } = harness(visualization(), { animated: true, animationSpeed: 0.5, trail: 85 });
      change(control(settingRow(panel, 'animationSpeed'), Select), 4);
      assert(updates[0].key === 'animationSpeed' && updates[0].params.animationSpeed === 4, 'speed stays numeric');
      change(control(settingRow(panel, 'animated'), Switch), false);
      const paused = control(settingRow(panel, 'animationSpeed'), Select);
      assert(paused.props.disabled === true && paused.props.value === 4, 'paused speed is disabled and retained');
      assert(updates[1].key === 'animated' && updates[1].params.trail === 85, 'toggle changes only its parameter');
      change(control(settingRow(panel, 'animated'), Switch), true);
      const resumed = control(settingRow(panel, 'animationSpeed'), Select);
      assert(resumed.props.disabled === false && resumed.props.value === 4, 'resuming preserves the selected speed');
      assert(control(settingRow(panel, 'trail'), Slider).props.value === 85, 'Trail is unchanged by animation edits');
    },
  ],
  [
    'selected speed shows only its multiplier while options expose scene hints',
    () => {
      const { panel } = harness();
      const speed = control(settingRow(panel, 'animationSpeed'), Select);
      assert(speed.props.optionLabelProp === 'label', 'selected speed uses the short label');
      const options = React.Children.toArray(speed.props.children as React.ReactNode) as Element[];
      assert(
        JSON.stringify(options.map((option) => option.props.value)) === '[0.25,0.5,1,2,4]',
        'all five numeric speeds are available',
      );
      for (const option of options) {
        assert(option.props.label === `${String(option.props.value)}×`, 'each selected label is a multiplier');
        const text = renderToStaticMarkup(
          React.createElement(React.Fragment, null, option.props.children as React.ReactNode),
        );
        assert(
          text.includes('×') && /inspection|overview|flow|preview|scan/.test(text),
          'expanded option includes a scene hint',
        );
      }
    },
  ],
  [
    'animation disabling follows metadata with renamed keys and preserves ordinary controls',
    () => {
      const { panel } = harness(visualization('running', 'pace'), { running: false, pace: 2 });
      const row = settingRow(panel, 'running');
      assert(control(row, Switch).props.checked === false, 'custom enabled key is respected');
      const speed = control(settingRow(panel, 'pace'), Select);
      assert(speed.props.disabled === true && speed.props.value === 2, 'custom speed key is respected');
      assert(settingRows(panel).filter((node) => node.key === 'pace').length === 1, 'custom speed appears once');
      assert(
        control(settingRow(panel, 'visible'), Switch).props['aria-label'] === 'Visible',
        'ordinary switch remains accessible',
      );
    },
  ],
  [
    'unconfigured animation parameters retain independent setting rows',
    () => {
      const config = visualization();
      config.animation = undefined;
      const { panel } = harness(config);
      assert(control(settingRow(panel, 'animated'), Switch).props.checked === true, 'ordinary switch keeps its value');
      assert(
        control(settingRow(panel, 'animationSpeed'), Select).props.value === 1,
        'unpaired speed remains a normal select with its default value',
      );
    },
  ],
];

const failures: string[] = [];
tests.push([
  'timeline control disables animation controls and preserves free choices',
  () => {
    const { panel, props } = harness(visualization(), { animated: false, animationSpeed: 4 });
    Object.assign(panel, { props: { ...props, animationPlaybackControlled: true } });
    assert(control(settingRow(panel, 'animated'), Switch).props.disabled === true, 'timeline owns animated');
    const speed = control(settingRow(panel, 'animationSpeed'), Select);
    assert(speed.props.disabled === true && speed.props.value === 4, 'timeline preserves free speed');
    const options = React.Children.toArray(speed.props.children as React.ReactNode).filter(
      React.isValidElement,
    ) as React.ReactElement<Record<string, unknown>>[];
    assert(
      renderToStaticMarkup(
        React.createElement(React.Fragment, null, options[2].props.children as React.ReactNode),
      ).includes('1× - Normal flow'),
      'hint uses hyphen',
    );
  },
]);
for (const [name, test] of tests) {
  try {
    test();
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failures.length) throw new Error(failures.join('\n'));
