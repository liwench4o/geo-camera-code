import type { CustomObject } from '../interfaces';
import { createPointTarget, createRegionTarget } from './selection';
import { getVisualizationDefaultParams, visualizationCatalog } from '../visualization/catalog';
import { resolveLayerDescriptor } from '../visualization/resolved-layer';
import type { ResolvedLayerRuntime, VisualizationParameterValue } from '../visualization/types';
import { attachRendererSelectionEnvelope } from './renderer-selection-envelope';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function clone<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

function runtime(
  visualizationId: string,
  layerId: string,
  data: readonly CustomObject[],
  parameterPatch: Record<string, VisualizationParameterValue> = {},
): ResolvedLayerRuntime {
  const visualization = clone(
    visualizationCatalog.visualizations.find((candidate) => candidate.id === visualizationId),
  );
  assert(visualization, `missing visualization ${visualizationId}`);
  const layer = visualization.layers.find((candidate) => candidate.id === layerId);
  assert(layer, `missing layer ${visualizationId}:${layerId}`);
  const dataset = clone(visualizationCatalog.datasets.find((candidate) => candidate.id === visualization.datasetId));
  assert(dataset, `missing dataset ${visualization.datasetId}`);
  const dataFile = dataset.files.find((candidate) => candidate.id === layer.dataRef);
  assert(dataFile, `missing data file ${layer.dataRef}`);
  return {
    descriptor: resolveLayerDescriptor({
      catalogRevision: visualizationCatalog.revision,
      visualization,
      dataset,
      dataFile,
      dataRevision: dataFile.revision,
      layer,
      rowCount: data.length,
      params: { ...getVisualizationDefaultParams(visualization), ...parameterPatch },
      state: { animationTime: 0 },
    }),
    data,
  };
}

const referenceView = { longitude: 0, latitude: 0, zoom: 8, pitch: 0, bearing: 0 };
const viewport = { width: 1280, height: 720 };

function testScatterSourceObjectProducesCertifiedAttachedSnapshot(): void {
  const row = { id: 'airport-1', coordinates: [0, 0] };
  const target = createPointTarget([0, 0], [row]);
  const result = attachRendererSelectionEnvelope({
    target,
    resolvedLayers: [runtime('point', 'point-map', [row])],
    expectedProducer: 'scatter-point',
    selectionMode: 'click',
    marks: [row],
    referenceView,
    viewport,
  });

  assert(result.status === 'attached', `scatter snapshot should attach: ${result.detail}`);
  assert(result.target.snapshotEnvelope === result.envelope, 'attached target should retain the certified envelope');
  assert(
    result.envelope.supportGuarantee === 'renderer-exact' || result.envelope.supportGuarantee === 'conservative',
    'shadow attachment must never use legacy approximation support',
  );
}

function testHeatmapRequiresAndBuildsCompleteHaloEvidence(): void {
  const rows = [
    { id: 'gun-1', longitude: 0, latitude: 0, n_killed: 1, n_injured: 0 },
    { id: 'gun-2', longitude: 0.01, latitude: 0.01, n_killed: 0, n_injured: 1 },
  ];
  const target = createRegionTarget(
    [
      [-0.02, -0.02],
      [0.02, -0.02],
      [0.02, 0.02],
      [-0.02, 0.02],
    ],
    rows,
    'heatmap-zone',
  );
  const result = attachRendererSelectionEnvelope({
    target,
    resolvedLayers: [runtime('mix', 'heat', rows)],
    expectedProducer: 'heatmap-kernel',
    selectionMode: 'map-click',
    marks: rows,
    heatmapQueryPoint: [0, 0],
    referenceView,
    viewport,
  });

  assert(result.status === 'attached', `heatmap snapshot should attach with halo evidence: ${result.detail}`);
  assert(result.envelope.frame.primitives.length === rows.length, 'heatmap envelope should retain every contributor');

  const incomplete = attachRendererSelectionEnvelope({
    target,
    resolvedLayers: [runtime('mix', 'heat', rows)],
    expectedProducer: 'heatmap-kernel',
    selectionMode: 'map-click',
    marks: [rows[0]],
    heatmapQueryPoint: [0, 0],
    referenceView,
    viewport,
  });
  assert(
    incomplete.status === 'skipped' && incomplete.reason === 'renderer-evidence-required',
    'heatmap attachment must not self-certify an incomplete contributor halo',
  );
}

function testUnsupportedRendererEvidenceFailsClosed(): void {
  const row = { longitude: 0, latitude: 0 };
  const hexResult = attachRendererSelectionEnvelope({
    target: createPointTarget([0, 0], [row]),
    resolvedLayers: [],
    expectedProducer: 'hexagon-cell',
    selectionMode: 'click',
    marks: [row],
    referenceView,
    viewport,
  });
  assert(
    hexResult.status === 'skipped' && hexResult.reason === 'renderer-evidence-required',
    'hexagon selection without the renderer bridge must fail closed',
  );

  const scatterRuntime = runtime('point', 'point-map', [row]);
  const ambiguous = attachRendererSelectionEnvelope({
    target: createPointTarget([0, 0], [row]),
    resolvedLayers: [scatterRuntime, scatterRuntime],
    expectedProducer: 'scatter-point',
    selectionMode: 'click',
    marks: [row],
    referenceView,
    viewport,
  });
  assert(
    ambiguous.status === 'skipped' && ambiguous.reason === 'ambiguous-layer',
    'ambiguous resolved layer identity must not attach an envelope',
  );
}

testScatterSourceObjectProducesCertifiedAttachedSnapshot();
testHeatmapRequiresAndBuildsCompleteHaloEvidence();
testUnsupportedRendererEvidenceFailsClosed();
