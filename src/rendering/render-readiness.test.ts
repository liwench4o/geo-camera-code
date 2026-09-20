import { heatmapAggregationReady } from './render-readiness';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function state(scale: number, dirty = false, timer: number | null = null) {
  return {
    isWeightMapDirty: dirty,
    updateTimer: timer,
    weightsTransform: { model: { shaderInputs: { moduleUniforms: { project: { scale } } } } },
  };
}
assert(!heatmapAggregationReady(undefined, 8), 'Missing GPU aggregation state must not be accepted.');
assert(!heatmapAggregationReady({}, 8), 'An unknown dependency state must fail closed.');
assert(!heatmapAggregationReady(state(4, false, 7), 8), 'Loaded layers may still contain a previous zoom weightmap.');
assert(!heatmapAggregationReady(state(8, true), 8), 'A dirty weightmap must finish its GPU update before capture.');
assert(heatmapAggregationReady(state(8), 8), 'A rendered weightmap at the current viewport scale is ready.');
assert(
  heatmapAggregationReady(state(8, false, 7), 8),
  'A cleared timer ID can remain in Deck state after an immediate bounds update.',
);
assert(!heatmapAggregationReady(state(Number.NaN), 8), 'Invalid aggregation scale must never count as ready.');
assert(!heatmapAggregationReady(state(8), Number.NaN), 'Invalid viewport scale must never count as ready.');
assert(!heatmapAggregationReady(state(8), 8.00001), 'Small real zoom changes must not bypass aggregation readiness.');
console.log('Heatmap readiness checks the actual GPU aggregation scale, not the loaded flag or timer ID.');
