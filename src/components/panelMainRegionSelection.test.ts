import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';
import type PanelMain from './PanelMain';
import type { PanelMainProps } from './PanelMain';
import type { CameraTarget } from '../camera/types';
import { visualizationCatalog, getVisualizationDefaultParams } from '../visualization/catalog';
import { dataLoaderRegistry, resolveVisualizationRuntime } from '../visualization/registry';

/** Use the actual selection/snapshot handlers; only DOM components and toasts
 * are replaced, since no map needs to mount for a drawn geographic polygon. */
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
    '@ant-design/icons',
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
  const execute = runInThisContext(`(function(require, module, exports) {\n${output}\n})`, {
    filename: 'PanelMain.handlers.cjs',
  }) as (...args: unknown[]) => void;
  execute(localRequire, moduleValue, moduleValue.exports);
  return moduleValue.exports.default;
}

async function run() {
  const previous = dataLoaderRegistry.json;
  dataLoaderRegistry.json = (file) =>
    Promise.resolve(
      file.id === 'trips'
        ? [
            {
              id: 'trip',
              vendor: 0,
              path: [
                [-74, 40.72],
                [-73.99, 40.73],
              ],
              timestamps: [0, 10],
            },
          ]
        : [
            {
              id: 'building',
              height: 120,
              polygon: [
                [-74.001, 40.719],
                [-73.999, 40.719],
                [-73.999, 40.721],
                [-74.001, 40.721],
              ],
            },
          ],
    );
  try {
    const config = visualizationCatalog.visualizations.find((item) => item.id === 'animated')!;
    const runtime = await resolveVisualizationRuntime(visualizationCatalog, 'animated', {
      params: getVisualizationDefaultParams(config),
      state: { animationTime: 5 },
      clickHandlers: { tripPath: () => true },
    });
    const selected: CameraTarget[] = [];
    const Panel = loadPanelMain();
    const panel = new Panel({
      viewState: runtime.initialViewState,
      viewportSize: { width: 1000, height: 600 },
      visData: runtime.primaryData,
      onTargetChange: (target: CameraTarget) => selected.push(target),
    } as unknown as PanelMainProps);
    panel.state = { ...panel.state, runtimePhase: 'ready', visualizationRuntime: runtime };
    panel.setState = ((patch: object) => {
      panel.state = { ...panel.state, ...patch };
    }) as typeof panel.setState;
    const ring = [
      [-74.002, 40.718],
      [-73.998, 40.718],
      [-73.998, 40.722],
      [-74.002, 40.722],
    ];
    panel.handleMapFeatureDrawn({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        renderType: 'Polygon',
        isClosed: true,
        bbox: { xmin: -74.002, xmax: -73.998, ymin: 40.718, ymax: 40.722 },
      },
    });
    assert.equal(selected.length, 1);
    assert.equal(selected[0].sourceLayerId, 'buildings');
    assert.deepEqual(
      selected[0].selectedRows?.map((row) => row.id),
      ['building'],
      'region selection reads its renderer data, even when the visualization primary data are trips',
    );
    assert.equal(selected[0].snapshotEnvelope?.provenance.producerId, 'polygon-extrusion');
    assert.equal(selected[0].snapshotEnvelope?.frame.primitives[0].kind, 'extruded-footprint');
    const refreshed = panel.resolveTargetSnapshot({ ...selected[0], snapshotEnvelope: undefined });
    assert.deepEqual(
      refreshed.selectedRows?.map((row) => row.id),
      ['building'],
    );
    assert.equal(refreshed.snapshotEnvelope?.provenance.producerId, 'polygon-extrusion');
    assert.deepEqual(refreshed.coordinates, selected[0].coordinates, 'refresh retains the drawn boundary');
  } finally {
    dataLoaderRegistry.json = previous;
  }
}

void run();
