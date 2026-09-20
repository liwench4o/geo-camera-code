import React from 'react';
import { WebMercatorViewport } from '@deck.gl/core';
import type { CameraView } from '../interfaces';
import type { ViewportSize } from '../camera/types';

export enum MapDrawingMode {
  POLYGON = 'POLYGON',
}

export type MapDrawingFeature = {
  type: 'Feature';
  geometry: {
    type: 'Polygon';
    coordinates: number[][][];
  };
  properties: {
    renderType: 'Polygon' | 'Rectangle';
    bbox: { xmin: number; xmax: number; ymin: number; ymax: number };
    isClosed?: boolean;
  };
};

export interface MapDrawingEditorProps {
  viewState: CameraView;
  viewportSize: ViewportSize;
  onFeatureDrawn: (feature: MapDrawingFeature | undefined) => void;
}

type Pixel = [number, number];
interface DrawingState {
  coordinates: number[][];
  pointer?: Pixel;
}

const CLOSE_RADIUS = 12;

// Keep high-frequency drawing updates outside PanelMain and Deck's GPU picking.
export default class MapDrawingEditor extends React.PureComponent<MapDrawingEditorProps, DrawingState> {
  state: DrawingState = { coordinates: [] };
  private previewFrame?: number;
  private pendingPointer?: Pixel;
  private completed = false;
  private viewport?: WebMercatorViewport;
  private viewportView?: CameraView;

  private getViewport() {
    const { viewState, viewportSize } = this.props;
    if (
      !this.viewport ||
      this.viewportView !== viewState ||
      this.viewport.width !== viewportSize.width ||
      this.viewport.height !== viewportSize.height
    ) {
      this.viewport = new WebMercatorViewport({ ...viewState, ...viewportSize });
      this.viewportView = viewState;
    }
    return this.viewport;
  }

  private getPixel(event: React.MouseEvent<SVGSVGElement>): Pixel | undefined {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return undefined;
    const { width, height } = this.props.viewportSize;
    const pixel: Pixel = [
      ((event.clientX - bounds.left) / bounds.width) * width,
      ((event.clientY - bounds.top) / bounds.height) * height,
    ];
    return pixel.every(Number.isFinite) && pixel[0] >= 0 && pixel[0] <= width && pixel[1] >= 0 && pixel[1] <= height
      ? pixel
      : undefined;
  }

  private getGroundCoordinate(pixel: Pixel) {
    const viewport = this.getViewport();
    // Intersect the pointer ray with the map's ground, independent of column/building heights.
    const ground = viewport.unproject(pixel, { targetZ: 0 });
    const projected = viewport.project(ground);
    // At steep pitch, pixels above the horizon intersect the plane behind the camera.
    if (!ground.every(Number.isFinite) || !projected.every(Number.isFinite) || projected[2] < -1 || projected[2] > 1) {
      return undefined;
    }
    return ground.slice(0, 2);
  }

  private projectGround(coordinate: number[]) {
    return this.getViewport().project([coordinate[0], coordinate[1], 0]);
  }

  private isNearStart(pixel: Pixel) {
    const first = this.state.coordinates[0];
    if (!first) return false;
    const start = this.projectGround(first);
    return Math.hypot(pixel[0] - start[0], pixel[1] - start[1]) <= CLOSE_RADIUS;
  }

  private clearPreviewFrame() {
    if (this.previewFrame !== undefined) window.cancelAnimationFrame(this.previewFrame);
    this.previewFrame = undefined;
    this.pendingPointer = undefined;
  }

  componentWillUnmount() {
    this.clearPreviewFrame();
  }

  private handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    event.stopPropagation();
    if (this.completed || !this.state.coordinates.length) return;
    this.pendingPointer = this.getPixel(event);
    if (this.previewFrame !== undefined) return;
    this.previewFrame = window.requestAnimationFrame(() => {
      this.previewFrame = undefined;
      this.setState({ pointer: this.pendingPointer });
    });
  };

  private handlePointerLeave = () => {
    this.clearPreviewFrame();
    this.setState({ pointer: undefined });
  };

  private handleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (this.completed || event.button !== 0) return;
    const pixel = this.getPixel(event);
    if (!pixel) return;
    const { coordinates } = this.state;
    if (this.isNearStart(pixel)) {
      if (coordinates.length < 3) return;
      this.completed = true;
      this.clearPreviewFrame();
      const longitudes = coordinates.map(([longitude]) => longitude);
      const latitudes = coordinates.map(([, latitude]) => latitude);
      this.props.onFeatureDrawn({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[...coordinates, coordinates[0]]] },
        properties: {
          renderType: 'Polygon',
          isClosed: true,
          bbox: {
            xmin: Math.min(...longitudes),
            xmax: Math.max(...longitudes),
            ymin: Math.min(...latitudes),
            ymax: Math.max(...latitudes),
          },
        },
      });
      return;
    }
    const coordinate = this.getGroundCoordinate(pixel);
    if (!coordinate) return;
    // Ignore repeated clicks on the last vertex without ending the drawing.
    const last = coordinates[coordinates.length - 1];
    if (last) {
      const lastPixel = this.projectGround(last);
      if (Math.hypot(pixel[0] - lastPixel[0], pixel[1] - lastPixel[1]) < 2) return;
    }
    this.clearPreviewFrame();
    this.setState({ coordinates: [...coordinates, coordinate], pointer: pixel });
  };

  render() {
    const { coordinates, pointer } = this.state;
    const { width, height } = this.props.viewportSize;
    const points = coordinates.map((coordinate) => this.projectGround(coordinate));
    const closing = Boolean(pointer && coordinates.length >= 3 && this.isNearStart(pointer));
    const pointerGround = pointer && this.getGroundCoordinate(pointer);
    const preview = closing ? points[0] : pointerGround && this.projectGround(pointerGround);
    const last = points[points.length - 1];
    const fillPoints =
      preview && last && Math.hypot(preview[0] - last[0], preview[1] - last[1]) > 0.5 ? [...points, preview] : points;
    const hint = closing
      ? 'Click the first point to finish'
      : width < 500
        ? 'Click points · Close at start · Esc cancels'
        : 'Click to add points · Return to the first point to finish · Esc to cancel';

    return (
      <svg
        className="map-drawing-editor select-none"
        role="img"
        aria-label="Polygon drawing area"
        viewBox={`0 0 ${width} ${height}`}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={this.handlePointerMove}
        onPointerLeave={this.handlePointerLeave}
        onClick={this.handleClick}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onContextMenu={(event) => event.preventDefault()}>
        {fillPoints.length >= 3 && (
          <polygon
            data-drawing-fill="true"
            points={fillPoints.map((point) => `${point[0]},${point[1]}`).join(' ')}
            fill="#ffa940"
            fillOpacity={0.12}
            fillRule="evenodd"
            stroke="none"
            pointerEvents="none"
          />
        )}
        {points.length >= 2 && (
          <polyline
            points={points.map((point) => `${point[0]},${point[1]}`).join(' ')}
            fill="none"
            stroke="#ffa940"
            strokeWidth={2}
          />
        )}
        {last && preview && (
          <line
            data-drawing-preview="true"
            x1={last[0]}
            y1={last[1]}
            x2={preview[0]}
            y2={preview[1]}
            stroke="#ffd591"
            strokeWidth={2}
            strokeDasharray={closing ? undefined : '5 4'}
          />
        )}
        {points.map((point, index) => (
          <circle
            key={index}
            data-drawing-vertex={index}
            cx={point[0]}
            cy={point[1]}
            r={index === 0 && closing ? 6 : 4}
            fill={index === 0 && closing ? '#ffa940' : '#334155'}
            stroke="#fff"
            strokeWidth={2}
          />
        ))}
        <rect x={8} y={height - 34} width={Math.min(width - 16, 485)} height={26} fill="#0f172a" fillOpacity={0.88} />
        <text x={16} y={height - 17} fill="#f8fafc" fontSize={11}>
          {hint}
        </text>
      </svg>
    );
  }
}
