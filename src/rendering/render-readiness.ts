/** Deck HeatmapLayer's isLoaded flag does not cover its deferred aggregation.
 * Inspect the last GPU weightmap's actual project scale after a Deck draw. The
 * timer ID alone is insufficient: an immediate bounds update can cancel its
 * callback without clearing the ID in Deck state. Fail closed if a dependency
 * upgrade changes this state contract instead of accepting stale pixels. */
export function heatmapAggregationReady(state: unknown, viewportScale: number): boolean {
  const aggregation = state as
    | {
        isWeightMapDirty?: boolean;
        weightsTransform?: {
          model?: { shaderInputs?: { moduleUniforms?: { project?: { scale?: number } } } };
        };
      }
    | undefined;
  const weightmapScale = aggregation?.weightsTransform?.model?.shaderInputs?.moduleUniforms?.project?.scale;
  return (
    aggregation?.isWeightMapDirty === false &&
    typeof weightmapScale === 'number' &&
    Number.isFinite(weightmapScale) &&
    Number.isFinite(viewportScale) &&
    Math.abs(weightmapScale - viewportScale) <= Math.max(1, Math.abs(viewportScale)) * 1e-12
  );
}
