export type VisualizationPerformanceMilestone =
  | 'shell-render'
  | 'runtime-start'
  | 'runtime-commit'
  | 'runtime-error'
  | 'map-load'
  | 'full-layer-render';

type MarkSink = (name: string) => void;

function browserMark(name: string): void {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    performance.mark(name);
  }
}

export function createVisualizationPerformanceRecorder(markSink: MarkSink = browserMark) {
  return {
    mark(milestone: VisualizationPerformanceMilestone): void {
      markSink(`geo-camera:${milestone}`);
    },
  };
}

export const visualizationPerformance = createVisualizationPerformanceRecorder();
