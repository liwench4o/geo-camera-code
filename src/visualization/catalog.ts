import catalogJson from '../../assets/visualization-catalog.json';
import type {
  DatasetConfig,
  VisualizationCatalog,
  VisualizationConfig,
  VisualizationParameterValues,
  VisualizationParametersById,
} from './types';
import { VISUALIZATION_MAP_STYLE_PARAM_KEY } from './types';
import { getActiveDatasetId, validateVisualizationCatalog } from './registry';

export const visualizationCatalog = catalogJson as VisualizationCatalog;

export const visualizationCatalogValidationErrors = validateVisualizationCatalog(visualizationCatalog);

if (visualizationCatalogValidationErrors.length > 0) {
  console.error('Visualization catalog validation failed:', visualizationCatalogValidationErrors);
}

export function getDefaultVisualizationId() {
  return visualizationCatalog.defaultVisualization;
}

export function getVisualizationConfig(visualizationId: string) {
  return visualizationCatalog.visualizations.find((visualization) => visualization.id === visualizationId);
}

export function getDatasetConfig(datasetId: string) {
  return visualizationCatalog.datasets.find((dataset) => dataset.id === datasetId);
}

export function getDatasetForVisualization(visualizationId: string) {
  const visualization = getVisualizationConfig(visualizationId);
  return visualization ? getDatasetConfig(visualization.datasetId) : undefined;
}

export function getActiveDatasetForVisualization(
  visualization: VisualizationConfig,
  params: VisualizationParameterValues,
) {
  return getDatasetConfig(getActiveDatasetId(visualization, params)) ?? getDatasetConfig(visualization.datasetId);
}

export function getVisualizationDefaultParams(visualization: VisualizationConfig): VisualizationParameterValues {
  return (visualization.parameters ?? []).reduce<VisualizationParameterValues>(
    (params, parameter) => {
      params[parameter.key] = parameter.default;
      return params;
    },
    {
      [VISUALIZATION_MAP_STYLE_PARAM_KEY]: visualization.mapStyle,
    },
  );
}

export function getInitialVisualizationParams(catalog: VisualizationCatalog): VisualizationParametersById {
  return catalog.visualizations.reduce<VisualizationParametersById>((paramsById, visualization) => {
    paramsById[visualization.id] = getVisualizationDefaultParams(visualization);
    return paramsById;
  }, {});
}

export function getPrimaryDataFileName(dataset: DatasetConfig) {
  const primaryFile = dataset.files.find((file) => file.id === dataset.primaryDataRef) ?? dataset.files[0];
  return primaryFile?.url.split('/').pop() ?? '';
}
