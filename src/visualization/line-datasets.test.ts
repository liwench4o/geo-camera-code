import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { PickingInfo } from '@deck.gl/core';
import { WebMercatorViewport } from '@deck.gl/core';
import type { CustomObject } from '../interfaces';
import { createPathTarget } from '../camera/selection';
import { attachRendererSelectionEnvelope } from '../camera/renderer-selection-envelope';
import { getVisualizationDefaultParams, visualizationCatalog } from './catalog';
import {
  createUploadedDatasetOverride,
  dataLoaderRegistry,
  getAccessorById,
  resolveVisualizationRuntime,
  resolveVisualizationShell,
  validateVisualizationCatalog,
  viewStateRegistry,
} from './registry';

async function run() {
  const config = visualizationCatalog.visualizations.find((item) => item.id === 'line')!;
  assert.equal(config.datasetParam, 'lineDataset', 'Line must enable the existing Dataset selector');
  const parameter = config.parameters!.find((item) => item.key === config.datasetParam)!;
  assert.equal(parameter.control, 'select');
  assert.deepEqual(
    parameter.options?.map((item) => item.value),
    ['commute', 'bart-ridership'],
  );
  assert.deepEqual(validateVisualizationCatalog(visualizationCatalog), []);
  const constantWidthCatalog = structuredClone(visualizationCatalog);
  const constantLine = constantWidthCatalog.visualizations.find((item) => item.id === 'line')!.layers[0];
  if (constantLine.cameraEnvelope.producer !== 'line-path') throw new Error('Expected Line support');
  delete constantLine.cameraEnvelope.widthAccessor;
  delete constantLine.accessors!.getWidth;
  assert.deepEqual(validateVisualizationCatalog(constantWidthCatalog), [], 'fixed-width Line contracts remain valid');

  const defaults = getVisualizationDefaultParams(config);
  assert.equal(defaults.lineDataset, 'commute');
  const params = { ...defaults, lineDataset: 'bart-ridership' };
  const shell = resolveVisualizationShell(visualizationCatalog, 'line', { params });
  assert.equal(shell.dataset.title, 'BART Ridership Flows');
  assert.equal(shell.primaryFile?.url, 'data/bart-ridership.json');
  assert.ok(Math.abs(shell.initialViewState.longitude + 122.25) < 0.2);
  assert.ok(Math.abs(shell.initialViewState.latitude - 37.8) < 0.2);
  assert.ok(shell.initialViewState.pitch <= 30, 'station connections should read clearly in plan view');

  const flows = JSON.parse(readFileSync('assets/data/bart-ridership.json', 'utf8')) as CustomObject[];
  const commute = {
    residence_lng: '-1',
    residence_lat: '51',
    workplace_lng: '0.5',
    workplace_lat: '52',
    all_flows: '1500',
  };
  const oldJson = dataLoaderRegistry.json;
  const oldCsv = dataLoaderRegistry.csv;
  dataLoaderRegistry.json = () => Promise.resolve(flows);
  dataLoaderRegistry.csv = () => Promise.resolve([commute]);
  const clickHandlers = { commutePath: () => true };
  try {
    const original = await resolveVisualizationRuntime(visualizationCatalog, 'line', {
      params: defaults,
      state: {},
      clickHandlers,
    });
    const fixedWidth = await resolveVisualizationRuntime(constantWidthCatalog, 'line', {
      params: defaults,
      state: {},
      clickHandlers,
    });
    assert.equal(fixedWidth.layers[0].props.getWidth, 1, 'legacy numeric width is rendered unchanged');
    const runtime = await resolveVisualizationRuntime(visualizationCatalog, 'line', {
      params,
      state: {},
      clickHandlers,
    });
    assert.equal(runtime.primaryData.length, 60, 'show the 60 busiest reciprocal station pairs');
    assert.equal(new Set(flows.map((row) => row.id)).size, 60);
    assert.equal(runtime.layers.length, 2, 'station context accompanies the flow layer');
    assert.equal(runtime.layers[1].props.pickable, false);
    assert.ok(runtime.createLayers({ interactive: false }).every((layer) => !layer.props.pickable));
    for (const viewportSize of [
      { width: 380, height: 630 },
      { width: 900, height: 620 },
      { width: 640, height: 360 },
    ]) {
      const fitted = await resolveVisualizationRuntime(visualizationCatalog, 'line', {
        params,
        state: {},
        clickHandlers,
        viewportSize,
      });
      const viewport = new WebMercatorViewport({ ...viewportSize, ...fitted.initialViewState });
      if (viewportSize.height === 360) {
        const top = Math.min(
          ...flows.flatMap((flow) => [flow.start, flow.end]).map((point) => viewport.project(point)[1]),
        );
        assert.ok(top < 120, 'the collapsed information panel must not reserve a large empty area');
      }
      for (const point of flows.flatMap((flow) => [flow.start, flow.end])) {
        const [x, y] = viewport.project(point);
        assert.ok(x >= 24 && x <= viewportSize.width - 24, 'all BART stations fit within the map width');
        assert.ok(y >= 56 && y <= viewportSize.height - 24, 'stations avoid the compact title and map edges');
      }
    }
    assert.equal(runtime.dataset.id, 'bart-ridership');
    assert.equal(runtime.layers[0].constructor.name, 'LineLayer');
    const resolved = runtime.resolvedLayers[0];
    const source = getAccessorById(resolved.descriptor.accessorIds.getSourcePosition)!;
    const destination = getAccessorById(resolved.descriptor.accessorIds.getTargetPosition)!;
    const color = getAccessorById(resolved.descriptor.accessorIds.getColor)!;
    for (const row of runtime.primaryData) {
      assert.deepEqual(source(row), row.start, 'source station coordinates stay intact');
      assert.deepEqual(destination(row), row.end, 'destination station coordinates stay intact');
      const rgba = color(row) as number[];
      assert.ok(rgba.every((value) => Number.isFinite(value) && value >= 0 && value <= 255));
      assert.ok(rgba[3] > 0, 'flow visibility must not depend on commute counts');
    }
    assert.ok(runtime.analytics.combinedBbox![0] > -123 && runtime.analytics.combinedBbox![2] < -121);
    assert.notDeepEqual(
      color(flows.find((row) => row.connection_type === 'transbay')!),
      color(flows.find((row) => row.connection_type === 'same-side')!),
    );
    const getWidth = runtime.layers[0].props.getWidth;
    assert.equal(typeof getWidth, 'function');
    assert.ok(getWidth(flows[0]) > getWidth(flows[59]), 'line width encodes volume');
    const focused = runtime.createLayers({ idPrefix: 'focus-', selectedLineIds: [flows[0].id] });
    const focusedColor = focused[0].props.getColor;
    assert.equal(focusedColor(flows[0])[3], 255);
    assert.equal(focusedColor(flows[1])[3], 25, 'selection fades other flows without changing geometry');
    assert.equal(focused[0].props.getWidth(flows[0]), getWidth(flows[0]));
    assert.equal(focused[1].id, 'focus-bart-stations');
    assert.equal((focused[1].props.data as unknown[]).length, 29);
    const staleSelection = runtime.createLayers({ selectedLineIds: ['missing-id'] });
    assert.deepEqual(staleSelection[0].props.getColor(flows[0]), color(flows[0]));
    flows.forEach((row, index) => {
      assert.ok(row.average_weekday_trips > 0);
      assert.ok(Math.abs(row.average_weekday_trips - row.forward_weekday_trips - row.reverse_weekday_trips) < 0.02);
      if (index) assert.ok(flows[index - 1].average_weekday_trips >= row.average_weekday_trips);
    });
    const row = runtime.primaryData[0];
    const tooltip = runtime.getTooltip!({ object: row } as PickingInfo<CustomObject>);
    assert.ok(tooltip?.includes(row.source_name));
    assert.ok(tooltip?.includes('Aug 2026'));
    assert.ok(tooltip?.includes('Average weekday'));
    assert.ok(tooltip?.includes('not rail routes'));
    assert.ok(!tooltip?.includes('all_flows'));
    assert.equal(runtime.getTooltip!({ object: undefined } as PickingInfo<CustomObject>), null);

    const target = createPathTarget([source(row), destination(row)] as number[][], [row])!;
    const envelope = attachRendererSelectionEnvelope({
      target,
      resolvedLayers: runtime.resolvedLayers,
      expectedProducer: 'line-path',
      selectionMode: 'click',
      marks: [row],
      referenceView: { ...runtime.initialViewState, longitude: row.start[0], latitude: row.start[1] },
      viewport: { width: 1000, height: 700 },
    });
    assert.equal(envelope.status, 'attached', envelope.detail);
    if (envelope.status === 'attached') {
      const path = envelope.envelope.frame.primitives.find((item) => item.kind === 'path-corridor');
      assert.ok(path?.kind === 'path-corridor');
      assert.equal(path.halfWidth.value * 2, getWidth(row), 'camera support matches rendered passenger-flow width');
    }

    const restored = await resolveVisualizationRuntime(visualizationCatalog, 'line', {
      params: defaults,
      state: {},
      clickHandlers,
    });
    assert.deepEqual(source(restored.primaryData[0]), [-1, 51]);
    assert.deepEqual(destination(restored.primaryData[0]), [0.5, 52]);
    assert.deepEqual(color(restored.primaryData[0]), [1, 152, 189, 76.5]);
    assert.equal(restored.layers.length, 1, 'commute has no BART station context');
    assert.equal(restored.layers[0].props.getWidth(restored.primaryData[0]), 1);
    assert.deepEqual(restored.initialViewState, viewStateRegistry.ukLine);
    assert.ok(
      restored.getTooltip!({ object: commute } as unknown as PickingInfo<CustomObject>)?.includes('all_flows: 1500'),
    );
    assert.equal(
      restored.resolvedLayers[0].descriptor.resolvedLayerDigest,
      original.resolvedLayers[0].descriptor.resolvedLayerDigest,
    );
    assert.notEqual(resolved.descriptor.resolvedLayerDigest, original.resolvedLayers[0].descriptor.resolvedLayerDigest);

    const override = await createUploadedDatasetOverride(
      visualizationCatalog,
      'line',
      params,
      new File([JSON.stringify([flows[0], { start: [null, 51, 2], end: [0, 52, 3] }])], 'flows.json'),
      1,
    );
    assert.equal(override.skippedRowCount, 1);
    const uploaded = await resolveVisualizationRuntime(visualizationCatalog, 'line', {
      params,
      state: {},
      clickHandlers,
      datasetOverride: override,
    });
    assert.deepEqual(source(uploaded.primaryData[0]), flows[0].start);
  } finally {
    dataLoaderRegistry.json = oldJson;
    dataLoaderRegistry.csv = oldCsv;
  }
  console.log('Line datasets: BART flows, per-row envelope width, stations, switching and upload passed.');
}

void run();
