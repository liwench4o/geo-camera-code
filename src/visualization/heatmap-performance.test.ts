import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import { getVisualizationDefaultParams, visualizationCatalog } from './catalog';
import { dataLoaderRegistry, resolveVisualizationRuntime } from './registry';
import type { ResolvedVisualizationRuntime, VisualizationParameterValues, VisualizationRuntimeContext } from './types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function getHeatmap(runtime: ResolvedVisualizationRuntime): HeatmapLayer {
  const layer = runtime.layers.find((candidate) => candidate instanceof HeatmapLayer);
  assert(layer instanceof HeatmapLayer, 'The mixed visualization must render a HeatmapLayer.');
  return layer;
}

async function run() {
  const config = visualizationCatalog.visualizations.find((candidate) => candidate.id === 'mix');
  assert(config, 'The mixed visualization must exist.');
  const previousLoader = dataLoaderRegistry.json;
  let loads = 0;
  dataLoaderRegistry.json = () => {
    loads += 1;
    return Promise.resolve([
      { longitude: -100, latitude: 35, n_killed: 1, n_injured: 2 },
      { longitude: -100, latitude: 35, n_killed: 2, n_injured: 4 },
      { longitude: -90, latitude: 40, n_killed: 0, n_injured: 2 },
    ]);
  };
  const context: VisualizationRuntimeContext = {
    params: getVisualizationDefaultParams(config),
    state: { animationTime: 0 },
    clickHandlers: { lonLatFields: () => true },
    viewportSize: { width: 1100, height: 700 },
  };

  try {
    const first = await resolveVisualizationRuntime(visualizationCatalog, 'mix', context);
    const heatmap = getHeatmap(first);
    const failures: string[] = [];
    function check(condition: unknown, message: string) {
      if (!condition) failures.push(message);
    }
    check(
      heatmap.props.debounceTimeout > 0 && heatmap.props.debounceTimeout <= 100,
      `Zoom refresh must settle within 100 ms without aggregating every frame; got ${heatmap.props.debounceTimeout} ms.`,
    );
    check(
      heatmap.props.weightsTextureSize === 1024,
      `Interactive heatmaps must limit the weight texture to 1024²; got ${heatmap.props.weightsTextureSize}².`,
    );

    const parameterEdits: VisualizationParameterValues[] = [
      { heatmapRadius: 50 },
      { heatmapRadius: 1 },
      { heatmapIntensity: 2, heatmapThreshold: 0.2 },
    ];
    for (const params of parameterEdits) {
      const next = await resolveVisualizationRuntime(visualizationCatalog, 'mix', {
        ...context,
        params: { ...context.params, ...params },
      });
      const nextHeatmap = getHeatmap(next);
      const analytics = next.analytics.layers.find((layer) => layer.kind === 'heatmap');
      assert(analytics, 'Heatmap analytics must remain available.');
      check(
        analytics.radiusMeters === undefined && analytics.maxClusterCount === undefined,
        'A pixel kernel must not trigger CPU geographic binning or report its radius in meters.',
      );
      assert(
        analytics.rowCount === 3 && analytics.maxWeightValue === 4,
        'Row and weight analytics must remain correct.',
      );
      assert(
        JSON.stringify(analytics.bbox) === JSON.stringify([-100, 35, -90, 40]),
        'Heatmap data bounds must remain available for camera planning.',
      );
      assert(nextHeatmap.props.data === heatmap.props.data, 'Parameter changes must reuse the uploaded GPU data.');
      assert(
        nextHeatmap.props.getPosition === heatmap.props.getPosition &&
          nextHeatmap.props.getWeight === heatmap.props.getWeight,
        'Parameter changes must retain stable accessors.',
      );
      assert(
        nextHeatmap.props.radiusPixels === (params.heatmapRadius ?? context.params.heatmapRadius),
        'Radius edits must still reach the GPU kernel.',
      );
      assert(
        nextHeatmap.props.intensity === (params.heatmapIntensity ?? context.params.heatmapIntensity) &&
          nextHeatmap.props.threshold === (params.heatmapThreshold ?? context.params.heatmapThreshold),
        'Appearance edits must still reach the renderer.',
      );
      const captureLayers = next.createLayers({ idPrefix: 'capture-', interactive: false, transitions: false });
      const captureHeatmap = captureLayers.find((layer) => layer instanceof HeatmapLayer);
      assert(captureHeatmap instanceof HeatmapLayer, 'Capture must use the same heatmap renderer.');
      assert(
        captureHeatmap.props.weightsTextureSize === nextHeatmap.props.weightsTextureSize &&
          captureHeatmap.props.data === nextHeatmap.props.data,
        'Capture and live views must share heatmap resolution and data.',
      );
    }
    assert(loads === 1, 'Slider changes must not reload the dataset.');
    assert(failures.length === 0, failures.join('\n'));
  } finally {
    dataLoaderRegistry.json = previousLoader;
  }
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
