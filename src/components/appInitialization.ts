import type { CameraView } from '../interfaces';
import { getInitialVisualizationParams } from '../visualization/catalog';
import { getFileName, resolveVisualizationShell } from '../visualization/registry';
import type { VisualizationCatalog, VisualizationParametersById } from '../visualization/types';

export interface InitialAppVisualizationState {
  activeVisualizationId: string;
  visualizationParams: VisualizationParametersById;
  currentViewState: CameraView;
  visDatasetName: string;
  visDatasetTitle: string;
  visDatasetFileName: string;
}

export function createInitialAppVisualizationState(catalog: VisualizationCatalog): InitialAppVisualizationState {
  const activeVisualizationId = catalog.defaultVisualization;
  const visualizationParams = getInitialVisualizationParams(catalog);
  const shell = resolveVisualizationShell(catalog, activeVisualizationId, {
    params: visualizationParams[activeVisualizationId] ?? {},
  });

  return {
    activeVisualizationId,
    visualizationParams,
    currentViewState: { ...shell.initialViewState },
    visDatasetName: shell.dataset.id,
    visDatasetTitle: shell.dataset.title,
    visDatasetFileName: shell.primaryFile ? getFileName(shell.primaryFile.url) : '',
  };
}
