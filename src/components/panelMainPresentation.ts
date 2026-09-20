export type PanelRuntimePhase =
  | 'initial-loading'
  | 'incompatible-loading'
  | 'refreshing'
  | 'ready'
  | 'initial-error'
  | 'refresh-error';

export type RuntimeLayerPolicy = 'empty' | 'previous' | 'current';

export function getOptionalPanelText(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

export function getRuntimeLayerPolicy(phase: PanelRuntimePhase): RuntimeLayerPolicy {
  if (phase === 'ready') {
    return 'current';
  }
  if (phase === 'refreshing' || phase === 'refresh-error') {
    return 'previous';
  }
  return 'empty';
}

export function getRuntimeStatusText(phase: PanelRuntimePhase): string | undefined {
  if (phase === 'initial-loading' || phase === 'incompatible-loading') {
    return 'Loading map data…';
  }
  if (phase === 'refreshing') {
    return 'Updating visualization…';
  }
  if (phase === 'refresh-error') {
    return 'Showing the previous valid result';
  }
  return undefined;
}
