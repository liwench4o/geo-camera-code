import type {
  VisualizationConfig,
  VisualizationLayerValue,
  VisualizationParameterValues,
  VisualizationParametersById,
} from './types';

export type ManualVisualizationParameterKeysById = Record<string, readonly string[] | undefined>;

function getParameterReference(value: VisualizationLayerValue | undefined) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return undefined;
  const entries = Object.entries(value);
  return entries.length === 1 && entries[0][0] === 'param' && typeof entries[0][1] === 'string'
    ? entries[0][1]
    : undefined;
}

export function getAdaptiveVisualizationParameterKeys(visualization: VisualizationConfig) {
  const keys = new Set<string>();
  for (const layer of visualization.layers) {
    if (layer.analytics?.kind !== 'hexagon') continue;
    for (const propName of ['coverage', 'radius', 'upperPercentile'] as const) {
      const key = getParameterReference(layer.props?.[propName]);
      if (key) keys.add(key);
    }
    if (layer.analytics.radiusParam) keys.add(layer.analytics.radiusParam);
  }
  return [...keys].sort();
}

function areVisualizationParameterValuesEqual(
  left: VisualizationParameterValues | undefined,
  right: VisualizationParameterValues,
) {
  if (!left) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return rightKeys.every((key) => left[key] === right[key]);
}

export function getManualVisualizationParameterKeys(
  keysByVisualizationId: ManualVisualizationParameterKeysById,
  visualizationId: string,
) {
  return [...(keysByVisualizationId[visualizationId] ?? [])].sort();
}

export function updateManualVisualizationParameterKey(
  keysByVisualizationId: ManualVisualizationParameterKeysById,
  visualizationId: string,
  parameterKey: string,
  manual: boolean,
): ManualVisualizationParameterKeysById {
  const current = new Set(keysByVisualizationId[visualizationId] ?? []);
  if (manual) current.add(parameterKey);
  else current.delete(parameterKey);
  const nextKeys = [...current].sort();
  const currentKeys = getManualVisualizationParameterKeys(keysByVisualizationId, visualizationId);

  if (currentKeys.length === nextKeys.length && currentKeys.every((key, index) => key === nextKeys[index])) {
    return keysByVisualizationId;
  }

  if (nextKeys.length === 0) {
    const next = { ...keysByVisualizationId };
    delete next[visualizationId];
    return next;
  }

  return {
    ...keysByVisualizationId,
    [visualizationId]: nextKeys,
  };
}

export function applyResolvedVisualizationParams(
  paramsByVisualizationId: VisualizationParametersById,
  visualizationId: string,
  effectiveParams: VisualizationParameterValues,
): VisualizationParametersById {
  if (areVisualizationParameterValuesEqual(paramsByVisualizationId[visualizationId], effectiveParams)) {
    return paramsByVisualizationId;
  }

  return {
    ...paramsByVisualizationId,
    [visualizationId]: { ...effectiveParams },
  };
}
