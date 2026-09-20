import type { ViewportSize } from '../camera/types';
import type { VisualizationParameterValues } from '../visualization/types';

interface VisualizationRuntimeSignatureInput {
  visualizationId: string;
  datasetId: string;
  datasetRevision?: string | number;
  params: VisualizationParameterValues;
  manualParameterKeys: readonly string[];
  viewport?: ViewportSize;
  animationTime?: number;
}

export function createVisualizationRuntimeSignature(input: VisualizationRuntimeSignatureInput): string | undefined {
  const { viewport } = input;
  if (
    !viewport ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return undefined;
  }

  return JSON.stringify([
    input.visualizationId,
    input.datasetId,
    input.datasetRevision,
    Object.entries(input.params).sort(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey)),
    [...input.manualParameterKeys].sort(),
    [viewport.width, viewport.height],
    input.animationTime,
  ]);
}

export class VisualizationRuntimeRequestCoordinator {
  private nextId = 0;
  private inFlight?: { id: number; signature: string };
  private committedSignature?: string;

  begin(signature: string | undefined): number | undefined {
    if (!signature || this.inFlight?.signature === signature) {
      return undefined;
    }
    if (this.committedSignature === signature) {
      this.inFlight = undefined;
      return undefined;
    }
    const id = ++this.nextId;
    this.inFlight = { id, signature };
    return id;
  }

  isCommitted(signature: string | undefined): boolean {
    return Boolean(signature && this.committedSignature === signature);
  }

  commit(id: number, effectiveSignature?: string): boolean {
    if (this.inFlight?.id !== id) {
      return false;
    }
    this.committedSignature = effectiveSignature ?? this.inFlight.signature;
    this.inFlight = undefined;
    return true;
  }

  fail(id: number): boolean {
    if (this.inFlight?.id !== id) {
      return false;
    }
    this.inFlight = undefined;
    return true;
  }

  invalidate(): void {
    this.inFlight = undefined;
    this.committedSignature = undefined;
  }
}
