import type { VisualizationCameraConstraints } from '../visualization/types';

export function getViewStatePreviewMapProps(
  id: string,
  mapStyle?: string,
  cameraConstraints?: VisualizationCameraConstraints,
) {
  return {
    id: `map-${id}`,
    mapStyle,
    attributionControl: false as const,
    ...cameraConstraints,
  };
}
