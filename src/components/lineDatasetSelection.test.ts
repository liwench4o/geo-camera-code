import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';
import type { PickingInfo } from '@deck.gl/core';
import type PanelMain from './PanelMain';
import type { PanelMainProps } from './PanelMain';
import type { CustomObject } from '../interfaces';
import type { CameraTarget } from '../camera/types';
import { visualizationCatalog } from '../visualization/catalog';
import { dataLoaderRegistry, resolveVisualizationRuntime } from '../visualization/registry';

function loadPanelMain(): typeof PanelMain {
  const output = ts.transpileModule(readFileSync('src/components/PanelMain.tsx', 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const uiImports = new Set([
    'react-map-gl/maplibre',
    '@deck.gl/react',
    './ComparisonSplitView',
    './ViewStateEditorModal',
  ]);
  const localRequire = (id: string): unknown => {
    if (id === '@ant-design/icons') return { InfoCircleTwoTone: 'span' };
    if (id.endsWith('.css') || uiImports.has(id)) return {};
    if (id === 'antd') return { Typography: {}, message: { info() {}, warning() {} } };
    return id.startsWith('.') ? require(path.resolve('.cache/camera-tests/src/components', id)) : require(id);
  };
  const moduleValue = { exports: {} as { default: typeof PanelMain } };
  const execute = runInThisContext(`(function(require, module, exports) {\n${output}\n})`) as (
    ...args: unknown[]
  ) => void;
  execute(localRequire, moduleValue, moduleValue.exports);
  return moduleValue.exports.default;
}

async function run() {
  const old = dataLoaderRegistry.json;
  const flows = JSON.parse(readFileSync('assets/data/bart-ridership.json', 'utf8')) as CustomObject[];
  dataLoaderRegistry.json = () => Promise.resolve(flows);
  try {
    const runtime = await resolveVisualizationRuntime(visualizationCatalog, 'line', {
      params: { lineDataset: 'bart-ridership' },
      state: {},
      clickHandlers: { commutePath: () => true },
    });
    const selected: CameraTarget[] = [];
    const Panel = loadPanelMain();
    const panel = new Panel({
      viewState: runtime.initialViewState,
      viewportSize: { width: 1000, height: 700 },
      visData: runtime.primaryData,
      onTargetChange: (target: CameraTarget) => selected.push(target),
    } as unknown as PanelMainProps);
    panel.state = { ...panel.state, runtimePhase: 'ready', visualizationRuntime: runtime };
    const row = runtime.primaryData[0];
    assert.equal(
      panel.onLineLayerClick({ object: row } as PickingInfo<CustomObject>),
      true,
      'clicking a BART connection selects a path',
    );
    assert.equal(selected.length, 1);
    assert.equal(selected[0].type, 'path');
    assert.ok(selected[0].start?.every((value, index) => Math.abs(value - row.start[index]) < 1e-9));
    assert.ok(selected[0].end?.every((value, index) => Math.abs(value - row.end[index]) < 1e-9));
    assert.equal(selected[0].selectedRows?.[0].id, row.id);
    assert.equal(selected[0].sourceDatasetId, 'bart-ridership');
    assert.ok(selected[0].snapshotEnvelope, 'selection must attach the renderer envelope');
    assert.equal(panel.onLineLayerClick({ object: undefined } as PickingInfo<CustomObject>), false);
    panel.state = { ...panel.state, mapDrawing: true };
    assert.equal(panel.onLineLayerClick({ object: row } as PickingInfo<CustomObject>), false);
    assert.equal(selected.length, 1, 'drawing must not change selection');
  } finally {
    dataLoaderRegistry.json = old;
  }
  console.log('Line click selection supports BART paths and camera envelopes.');
}

void run();
