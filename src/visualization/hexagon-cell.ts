import { WebMercatorViewport } from '@deck.gl/core';
import type { CustomObject } from '../interfaces';
import { normalizeLongitude } from '../camera/geometry/geo-wrap';

const projection = new WebMercatorViewport({ longitude: 0, latitude: 0, zoom: 0 });

export function getRenderedHexagonCellProps(layer: CustomObject | undefined): CustomObject | undefined {
  if (!layer) return undefined;
  if (layer.props?.hexOriginCommon) return layer.props;
  const children = typeof layer.getSubLayers === 'function' ? layer.getSubLayers() : [];
  return children.find((child: CustomObject) => child.props?.hexOriginCommon)?.props;
}

/** deck.gl's pick position omits hexOriginCommon; use the shader's centroid calculation. */
export function getRenderedHexagonCellCenterCommon(
  props: CustomObject,
  mark: CustomObject,
): [number, number] | undefined {
  const origin = props.hexOriginCommon;
  if (
    !Array.isArray(origin) ||
    origin.length !== 2 ||
    !origin.every(Number.isFinite) ||
    !Number.isFinite(props.radius) ||
    props.radius <= 0 ||
    !Number.isInteger(mark.col) ||
    !Number.isInteger(mark.row)
  )
    return undefined;
  return [
    origin[0] + (mark.col + (mark.row & 1) / 2) * props.radius * Math.sqrt(3),
    origin[1] + mark.row * props.radius * 1.5,
  ];
}

export function getRenderedHexagonCellPosition(
  layer: CustomObject | undefined,
  mark: CustomObject,
): [number, number] | undefined {
  const props = getRenderedHexagonCellProps(layer);
  const center = props ? getRenderedHexagonCellCenterCommon(props, mark) : undefined;
  if (!center) return undefined;
  const position = projection.unprojectFlat(center);
  return position.every(Number.isFinite) ? [normalizeLongitude(position[0]), position[1]] : undefined;
}
