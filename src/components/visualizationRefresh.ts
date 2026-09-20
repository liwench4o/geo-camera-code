export interface VisualizationRefreshSignals {
  hasVisualizationRuntime?: boolean;
  visualizationChanged?: boolean;
  datasetChanged?: boolean;
  datasetSourceChanged?: boolean;
  paramsChanged?: boolean;
  manualParameterKeysChanged?: boolean;
  viewportChanged?: boolean;
  animationTimeChanged?: boolean;
}

export type VisualizationRefreshMode = 'none' | 'refresh' | 'reset';

export function getVisualizationRefreshMode(signals: VisualizationRefreshSignals): VisualizationRefreshMode {
  if (signals.visualizationChanged || signals.datasetChanged || signals.datasetSourceChanged) {
    return 'reset';
  }
  if (
    signals.paramsChanged ||
    signals.manualParameterKeysChanged ||
    (signals.viewportChanged && signals.hasVisualizationRuntime !== false) ||
    signals.animationTimeChanged
  ) {
    return 'refresh';
  }
  return 'none';
}
