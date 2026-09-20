import type { Color, Layer } from '@deck.gl/core';
import { WebMercatorViewport } from '@deck.gl/core';
import { LineLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { CameraView, CustomObject } from '../interfaces';
import type { ViewportSize } from '../camera/types';
import { getLineColor } from './line-data';
import type { VisualizationLayerRenderOptions } from './types';

interface Station {
  code: string;
  position: number[];
}

export function fitBartInitialView(
  rows: readonly CustomObject[],
  baseView: CameraView,
  size: ViewportSize,
): CameraView {
  if (!rows.length || size.width <= 64 || size.height <= 64) return baseView;
  const positions = rows.flatMap((row) => [row.start, row.end] as number[][]);
  const longitudes = positions.map((position) => position[0]);
  const latitudes = positions.map((position) => position[1]);
  const fitted = new WebMercatorViewport({ ...baseView, ...size }).fitBounds(
    [
      [Math.min(...longitudes), Math.min(...latitudes)],
      [Math.max(...longitudes), Math.max(...latitudes)],
    ],
    { padding: { left: 32, right: 32, top: Math.min(64, Math.max(0, size.height - 96)), bottom: 32 } },
  );
  return { ...baseView, longitude: fitted.longitude, latitude: fitted.latitude, zoom: fitted.zoom };
}

/** Endpoint context is nonselectable, like the basemap. Flow widths remain untouched. */
export function createBartPresentation(
  layers: Layer[],
  rows: readonly CustomObject[],
  options?: VisualizationLayerRenderOptions,
): Layer[] {
  const selected = new Set(options?.selectedLineIds ?? []);
  const hasSelection = rows.some((row) => selected.has(row.id));
  const stations = new Map<string, Station>();
  for (const row of rows) {
    stations.set(row.source_code, { code: row.source_code, position: row.start });
    stations.set(row.target_code, { code: row.target_code, position: row.end });
  }
  return [
    ...layers.map((layer) =>
      layer instanceof LineLayer
        ? layer.clone({
            getColor: (row: CustomObject): Color => {
              const color = getLineColor(row);
              return hasSelection ? [color[0], color[1], color[2], selected.has(row.id) ? 255 : 25] : color;
            },
            updateTriggers: { getColor: [...selected].sort().join('|') },
          })
        : layer,
    ),
    new ScatterplotLayer<Station>({
      id: `${options?.idPrefix ?? ''}bart-stations`,
      data: [...stations.values()],
      pickable: false,
      getPosition: (station) => station.position as [number, number],
      getRadius: 2.5,
      radiusUnits: 'pixels',
      getFillColor: [225, 242, 245, 230],
      stroked: true,
      getLineColor: [18, 30, 42, 255],
      lineWidthUnits: 'pixels',
      getLineWidth: 1,
      parameters: { depthCompare: 'always' },
    }),
  ];
}
