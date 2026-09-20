import { WebMercatorViewport } from '@deck.gl/core';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type { CustomObject } from '../interfaces';
import type { ResolvedLayerRuntime } from '../visualization/types';
import { getAccessorById } from '../visualization/registry';
import { getTripTimedPath } from '../visualization/trip-data';
import { getRenderedHexagonCellProps, getRenderedHexagonCellCenterCommon } from '../visualization/hexagon-cell';
import { createSnapshotEnvelope } from './geometry/envelope';
import { digestCanonical } from './geometry/canonical-digest';
import { attachSnapshotEnvelope } from './geometry/camera-target-adapter';
import {
  chooseWrapFrame,
  getWrappedExtent,
  MERCATOR_LATITUDE_LIMIT,
  shortestAngle,
  unwrapLongitude,
  unwrapRings,
} from './geometry/geo-wrap';
import type { EnvelopeResult, VisualPrimitive } from './geometry/types';
import { createPathTarget, getRowLngLat } from './selection';
import type { CameraTarget, LngLat } from './types';

const projection = new WebMercatorViewport({ longitude: 0, latitude: 0, zoom: 0 });

interface TargetRegion {
  rings: LngLat[][];
  reference: number;
}

function targetRings(target: CameraTarget): TargetRegion | undefined {
  if (target.type !== 'region' || !target.coordinates?.length) return undefined;
  const rings = (
    typeof target.coordinates[0][0] === 'number' ? [target.coordinates] : target.coordinates
  ) as LngLat[][];
  const closedRings = rings.map((ring) => {
    const closed = ring.map((point) => [...point] as LngLat);
    if (
      closed.length &&
      (closed[0][0] !== closed[closed.length - 1][0] || closed[0][1] !== closed[closed.length - 1][1])
    )
      closed.push([...closed[0]]);
    return closed;
  });
  const frame = chooseWrapFrame(closedRings.flatMap((ring) => ring.map(([longitude]) => longitude)));
  return { rings: unwrapRings(closedRings, frame), reference: frame.wrapReference };
}

function containsPosition(region: TargetRegion, position: LngLat): boolean {
  return booleanPointInPolygon([unwrapLongitude(position[0], region.reference), position[1]], {
    type: 'Polygon',
    coordinates: region.rings,
  });
}

function sourceReference(row: CustomObject) {
  const field = ['rid', 'id', 'key'].find((key) => typeof row[key] === 'string' || typeof row[key] === 'number');
  return field ? { field, value: row[field] as string | number } : undefined;
}

function samePosition(row: CustomObject, expected: LngLat): boolean {
  const position = getRowLngLat(row);
  return (
    !!position && Math.abs(shortestAngle(expected[0], position[0])) < 1e-7 && Math.abs(expected[1] - position[1]) < 1e-7
  );
}

export function rememberTargetSource(target: CameraTarget, runtime: ResolvedLayerRuntime): CameraTarget {
  const sourceFeatures = target.sourceFeatures?.length
    ? target.sourceFeatures.map((reference) => ({ ...reference }))
    : (target.selectedRows ?? []).flatMap((row) => {
        const reference = sourceReference(row);
        return reference ? [reference] : [];
      });
  return {
    ...target,
    sourceFeatures,
    sourceDatasetId: runtime.descriptor.datasetId,
    sourceLayerId: runtime.descriptor.layerId,
    sourceVisualizationId: runtime.descriptor.visualizationId,
    selectionAnchor: target.selectionAnchor ?? target.center,
  };
}

function ringEdges(ring: LngLat[]): [LngLat, LngLat][] {
  return ring.map((point, index) => [point, ring[(index + 1) % ring.length]]);
}

function segmentsIntersect([a, b]: [LngLat, LngLat], [c, d]: [LngLat, LngLat]): boolean {
  if (
    Math.max(a[0], b[0]) < Math.min(c[0], d[0]) ||
    Math.max(c[0], d[0]) < Math.min(a[0], b[0]) ||
    Math.max(a[1], b[1]) < Math.min(c[1], d[1]) ||
    Math.max(c[1], d[1]) < Math.min(a[1], b[1])
  )
    return false;
  const cross = (p: LngLat, q: LngLat, r: LngLat) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0;
}

function polygonIntersectsRegion(region: TargetRegion, polygon: unknown): boolean {
  if (!Array.isArray(polygon) || !polygon.length) return false;
  const sourceRings: unknown[][] = Array.isArray(polygon[0]?.[0]) ? polygon : [polygon];
  const rings = unwrapRings(
    sourceRings.map((ring) => ring.map(geometryPosition)),
    {
      wrapReference: region.reference,
      worldOffset: 0,
      wrapMode: 'minimum-arc',
    },
  ).map((positions) => {
    if (positions.length) positions.push([...positions[0]]);
    return positions;
  });
  if (!rings.length || rings.some((ring) => ring.length < 4)) return false;
  const footprint = { type: 'Polygon' as const, coordinates: rings };
  if (rings[0].some((point) => containsPosition(region, point))) return true;
  if (region.rings[0].some((point) => booleanPointInPolygon(point, footprint))) return true;
  const footprintEdges = rings.flatMap(ringEdges);
  return region.rings.flatMap(ringEdges).some((edge) => footprintEdges.some((other) => segmentsIntersect(edge, other)));
}

export function resolveCurrentTargetRows(
  target: CameraTarget,
  rows: readonly CustomObject[],
  runtime?: ResolvedLayerRuntime,
): CustomObject[] {
  if (target.timedPath) {
    const matches = rows.filter((row) => getTripTimedPath(row)?.digest === target.timedPath!.digest);
    return matches.length === 1 ? matches : [];
  }
  const rings = targetRings(target);
  if (target.source === 'drawn-region' && rings) {
    // A region belongs to its rendered layer. Building rows expose polygon
    // footprints, not point coordinates or the visualization's primary trips.
    if (runtime?.descriptor.resolvedSupport.producer === 'polygon-extrusion') {
      const getPolygon = getAccessorById(runtime.descriptor.accessorIds.getPolygon);
      if (!getPolygon) throw new Error("The current renderer's polygon geometry accessor is unavailable.");
      return rows.filter((row) => polygonIntersectsRegion(rings, getPolygon(row)));
    }
    return rows.filter((row) => {
      const position = getRowLngLat(row);
      return position && containsPosition(rings, position);
    });
  }
  const refs = target.sourceFeatures?.length
    ? target.sourceFeatures
    : (target.selectedRows ?? []).flatMap((row) => {
        const reference = sourceReference(row);
        return reference ? [reference] : [];
      });
  if (refs.length) {
    if (!refs.every(({ field, value }) => rows.some((row) => row[field] === value))) return [];
    const positionalMembers = (target.selectedRows ?? []).filter((row) => !sourceReference(row)).map(getRowLngLat);
    if (!positionalMembers.every((position) => position && rows.some((row) => samePosition(row, position)))) return [];
    return rows.filter(
      (row) =>
        refs.some(({ field, value }) => row[field] === value) ||
        positionalMembers.some((position) => position && samePosition(row, position)),
    );
  }
  const selectedPositions = (target.selectedRows ?? []).map(getRowLngLat).filter(Boolean) as LngLat[];
  const positions = selectedPositions.length ? selectedPositions : [target.selectionAnchor ?? target.center];
  const matchingRows = rows.filter((row) => positions.some((position) => samePosition(row, position)));
  return positions.every((position) => matchingRows.some((row) => samePosition(row, position))) ? matchingRows : [];
}

function geometryPosition(value: unknown): LngLat {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.length > 3 ||
    !value.every(Number.isFinite) ||
    Math.abs(value[1]) > MERCATOR_LATITUDE_LIMIT
  ) {
    throw new Error('The updated target geometry contains an invalid coordinate.');
  }
  return [value[0], value[1]];
}

/** Refresh only the selected object's geometry; renderer envelope capture follows this step. */
export function refreshTargetGeometry(
  target: CameraTarget,
  runtime: ResolvedLayerRuntime,
  rows: readonly CustomObject[],
): CameraTarget {
  if (!rows.length) throw new Error('The selected objects are no longer available.');
  const refreshed = {
    ...target,
    selectedRows: [...rows],
    snapshotEnvelope: undefined,
    visualFrame: undefined,
    stats: { ...target.stats, count: rows.length },
  };
  // The region or route drawn by an author remains their selection boundary.
  if (target.source === 'drawn-region' || target.source === 'drawn-path' || target.type === 'none') {
    return rememberTargetSource(refreshed, runtime);
  }
  const accessors = runtime.descriptor.accessorIds;
  const read = (prop: string, row: CustomObject): unknown => {
    const accessor = getAccessorById(accessors?.[prop]);
    if (!accessor) throw new Error(`The current renderer's ${prop} geometry accessor is unavailable.`);
    return accessor(row);
  };
  let positions: LngLat[];
  if (accessors?.getPath) {
    if (rows.length !== 1) throw new Error('Select one route before re-adapting a tracking camera.');
    const path = read('getPath', rows[0]);
    if (!Array.isArray(path) || path.length < 2)
      throw new Error('The updated route geometry needs at least two coordinates.');
    positions = path.map(geometryPosition);
  } else if (accessors?.getSourcePosition && accessors?.getTargetPosition) {
    if (target.type === 'path' && rows.length !== 1)
      throw new Error('Select one route before re-adapting a tracking camera.');
    positions = rows.flatMap((row) => [
      geometryPosition(read('getSourcePosition', row)),
      geometryPosition(read('getTargetPosition', row)),
    ]);
  } else if (accessors?.getPolygon) {
    positions = rows.flatMap((row) => {
      const polygon = read('getPolygon', row);
      if (!Array.isArray(polygon) || !polygon.length) throw new Error('The updated polygon geometry is unavailable.');
      const rings: unknown[] = Array.isArray(polygon[0]?.[0]) ? polygon.flat() : polygon;
      return rings.map(geometryPosition);
    });
  } else {
    positions = rows.map((row) => geometryPosition(read('getPosition', row)));
  }
  if (target.type === 'path') {
    const path = createPathTarget(positions, [...rows], target.source);
    if (!path) throw new Error('The updated route geometry needs at least two coordinates.');
    return rememberTargetSource(
      {
        ...refreshed,
        ...path,
        timedPath: accessors?.getTimestamps ? getTripTimedPath(rows[0]) : undefined,
        id: target.id,
        source: target.source,
        sourceFeatures: target.sourceFeatures,
        snapshotEnvelope: undefined,
        visualFrame: undefined,
      },
      runtime,
    );
  }
  const extent = getWrappedExtent(positions);
  const bbox: CameraTarget['bbox'] = [extent.minLng, extent.minLat, extent.maxLng, extent.maxLat];
  const center: LngLat = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  return rememberTargetSource(
    { ...refreshed, coordinates: positions, bbox, center, start: undefined, end: undefined },
    runtime,
  );
}

/** Capture deck.gl's rendered cell support, including its shifted common-space origin. */
export function captureHexagonTarget(
  target: CameraTarget,
  runtime: ResolvedLayerRuntime,
  layer: CustomObject,
  marks: readonly CustomObject[],
): EnvelopeResult<CameraTarget> {
  const props = getRenderedHexagonCellProps(layer);
  if (!props || !marks.length)
    return {
      status: 'unavailable',
      reason: 'Rendered hexagon cells are not ready. Select the target again after the map loads.',
    };
  for (const field of ['elevationScaleType', 'colorScaleType']) {
    const scale = layer.props?.[field] ?? layer.parent?.props?.[field] ?? runtime.descriptor.resolvedProps?.[field];
    if (scale === 'quantile' || scale === 'ordinal') {
      return {
        status: 'unsupported',
        reason: 'Automatic framing does not yet support quantile or ordinal hexagon scales.',
      };
    }
  }
  const radius = Number(props.radius) * Number(props.coverage);
  const origin = props.hexOriginCommon as number[];
  const domain = props.elevationDomain as number[];
  const colorDomain = props.colorDomain as number[];
  const range = props.elevationRange as number[];
  if (
    ![origin, domain, colorDomain, range].every(
      (tuple) => Array.isArray(tuple) && tuple.length === 2 && tuple.every(Number.isFinite),
    ) ||
    !Number.isFinite(radius) ||
    radius <= 0
  ) {
    return { status: 'unavailable', reason: 'Rendered hexagon dimensions are unavailable.' };
  }
  const low = Math.max(domain[0], props.elevationCutoff?.[0] ?? -Infinity);
  const high = Math.min(domain[1], props.elevationCutoff?.[1] ?? Infinity);
  const colorLow = Math.max(colorDomain[0], props.colorCutoff?.[0] ?? -Infinity);
  const colorHigh = Math.min(colorDomain[1], props.colorCutoff?.[1] ?? Infinity);
  if ((props.extruded && high <= low) || colorHigh <= colorLow) {
    return { status: 'unavailable', reason: 'Rendered hexagon domains are collapsed or reversed.' };
  }
  const primitives: VisualPrimitive[] = [];
  const centers: LngLat[] = [];
  for (const mark of marks) {
    const value = Number(mark.elevationValue);
    if (![mark.col, mark.row, value, mark.colorValue].every(Number.isFinite) || !(Number(mark.count) > 0)) continue;
    // These are the exact visibility cutoffs passed to deck.gl's hexagon vertex shader.
    if (
      value < Math.max(domain[0] - 1, props.elevationCutoff?.[0] ?? -Infinity) ||
      value > Math.min(domain[1] + 1, props.elevationCutoff?.[1] ?? Infinity)
    )
      continue;
    if (
      mark.colorValue < Math.max(colorDomain[0] - 1, props.colorCutoff?.[0] ?? -Infinity) ||
      mark.colorValue > Math.min(colorDomain[1] + 1, props.colorCutoff?.[1] ?? Infinity)
    )
      continue;
    const centerCommon = getRenderedHexagonCellCenterCommon(props, mark);
    if (!centerCommon) return { status: 'unavailable', reason: 'Rendered hexagon position is invalid.' };
    const center = projection.unprojectFlat(centerCommon);
    const ring: LngLat[] = Array.from({ length: 6 }, (_, index) => {
      const angle = (index * Math.PI) / 3;
      return projection.unprojectFlat([
        centerCommon[0] + Math.sin(angle) * radius,
        centerCommon[1] - Math.cos(angle) * radius,
      ]);
    });
    ring.push([...ring[0]]);
    const fraction = Math.max(0, Math.min(1, (value - low) / (high - low)));
    const height = props.extruded ? (range[0] + (range[1] - range[0]) * fraction) * Number(props.elevationScale) : 0;
    if (!Number.isFinite(height) || height < 0)
      return { status: 'unavailable', reason: 'Rendered column height is invalid.' };
    primitives.push({
      kind: 'extruded-footprint',
      rings: [ring],
      baseMeters: 0,
      topMeters: height,
      supportBufferPx: runtime.descriptor.cameraEnvelope.support.antialiasBufferPx,
    });
    centers.push(center);
  }
  if (!primitives.length) return { status: 'unavailable', reason: 'The selected cells are no longer visible.' };
  const descriptor = runtime.descriptor;
  const center = centers.length === 1 ? centers[0] : target.center;
  const locatedTarget: CameraTarget =
    target.type === 'location'
      ? {
          ...target,
          center,
          coordinates: [center],
          bbox: [center[0], center[1], center[0], center[1]],
          label:
            !target.label ||
            target.label === `[${target.center[0]}, ${target.center[1]}]` ||
            target.label === `[${target.center[0].toFixed(3)}, ${target.center[1].toFixed(3)}]`
              ? `[${center[0].toFixed(3)}, ${center[1].toFixed(3)}]`
              : target.label,
        }
      : { ...target, center };
  const result = createSnapshotEnvelope({
    id: target.id,
    supportGuarantee: 'conservative',
    provenance: {
      datasetId: descriptor.datasetId,
      visualizationId: descriptor.visualizationId,
      layerId: descriptor.layerId,
      dataRevision: descriptor.dataRevision,
      visualizationRevision: descriptor.visualizationRevision,
      resolvedLayerDigest: descriptor.resolvedLayerDigest,
      producerId: 'hexagon-cell',
      producerVersion: descriptor.cameraEnvelope.producerVersion,
      sceneRevision: digestCanonical({ layer: descriptor.resolvedLayerDigest, primitives }),
    },
    primitives,
    anchor: [center[0], center[1], 0],
    metrics: {
      elevation: 0,
      density: 0,
      coverage: 0,
      dispersion: 0,
      elongation: 0,
      curvature: 0,
      calibrationVersion: 1,
      fallbackReasons: [],
    },
  });
  return result.status === 'ok'
    ? {
        status: 'ok',
        value: attachSnapshotEnvelope(rememberTargetSource(locatedTarget, runtime), result.value),
      }
    : result;
}

const HEXAGON_QUERY_BUDGET = 20000;
const WORLD_COMMON_WIDTH = projection.projectFlat([180, 0])[0] - projection.projectFlat([-180, 0])[0];
type BinQuery = { index: number; expectedId?: [number, number] };

function currentHexagonQueries(
  target: CameraTarget,
  layer: CustomObject,
  props: CustomObject,
  region?: TargetRegion,
): EnvelopeResult<BinQuery[]> {
  const aggregator = layer.state.aggregator;
  const range =
    aggregator.props?.binIdRange ?? (layer.state.aggregatorType === 'gpu' ? layer.state.binIdRange : undefined);
  const overBudget = (): EnvelopeResult<BinQuery[]> => ({
    status: 'unavailable',
    reason: 'This selection needs more work than the interactive limit. Select fewer cells.',
  });
  const validGrid =
    Array.isArray(range) &&
    range.length === 2 &&
    range.every(
      (axis: unknown) => Array.isArray(axis) && axis.length === 2 && axis.every(Number.isInteger) && axis[1] > axis[0],
    );
  if (!validGrid) {
    if (!Number.isInteger(aggregator.binCount) || aggregator.binCount < 0)
      return { status: 'unavailable', reason: 'Rendered aggregation is not ready.' };
    if (aggregator.binCount > HEXAGON_QUERY_BUDGET) return overBudget();
    return { status: 'ok', value: Array.from({ length: aggregator.binCount }, (_, index) => ({ index })) };
  }
  const [[x0, x1], [y0, y1]] = range as [[number, number], [number, number]];
  const width = x1 - x0;
  if (width * (y1 - y0) !== aggregator.binCount)
    return { status: 'unavailable', reason: 'Rendered aggregation is updating. Try re-adapting again.' };
  const origin = getRenderedHexagonCellCenterCommon(props, { col: 0, row: 0 });
  if (!origin) return { status: 'unavailable', reason: 'Rendered hexagon position is invalid.' };
  const dx = props.radius * Math.sqrt(3);
  const dy = props.radius * 1.5;
  const gridMinX = origin[0] + x0 * dx;
  const gridMaxX = origin[0] + (x1 - 0.5) * dx;
  const queries = new Map<number, BinQuery>();
  const add = (col: number, row: number) => {
    if (col < x0 || col >= x1 || row < y0 || row >= y1) return;
    const index = (row - y0) * width + col - x0;
    queries.set(index, { index, expectedId: [col, row] });
  };
  if (!region) {
    const anchor = projection.projectFlat(target.selectionAnchor ?? target.center);
    const firstCopy = Math.ceil((gridMinX - props.radius - anchor[0]) / WORLD_COMMON_WIDTH);
    const lastCopy = Math.floor((gridMaxX + props.radius - anchor[0]) / WORLD_COMMON_WIDTH);
    if (lastCopy - firstCopy > HEXAGON_QUERY_BUDGET) return overBudget();
    const rowCenter = Math.round((anchor[1] - origin[1]) / dy);
    for (let copy = firstCopy; copy <= lastCopy; copy++) {
      const anchorX = anchor[0] + copy * WORLD_COMMON_WIDTH;
      for (let row = rowCenter - 1; row <= rowCenter + 1; row++) {
        const colCenter = Math.round((anchorX - origin[0]) / dx - (row & 1) / 2);
        for (let col = colCenter - 1; col <= colCenter + 1; col++) add(col, row);
      }
      if (queries.size > HEXAGON_QUERY_BUDGET) return overBudget();
    }
  } else {
    const points = region.rings.flatMap((ring) => ring.map((position) => projection.projectFlat(position)));
    const bounds = points.reduce(
      (bbox, point) => [
        Math.min(bbox[0], point[0]),
        Math.min(bbox[1], point[1]),
        Math.max(bbox[2], point[0]),
        Math.max(bbox[3], point[1]),
      ],
      [Infinity, Infinity, -Infinity, -Infinity],
    );
    const firstCopy = Math.ceil((gridMinX - bounds[2]) / WORLD_COMMON_WIDTH);
    const lastCopy = Math.floor((gridMaxX - bounds[0]) / WORLD_COMMON_WIDTH);
    const firstRow = Math.max(y0, Math.ceil((bounds[1] - origin[1]) / dy - 1e-9));
    const lastRow = Math.min(y1 - 1, Math.floor((bounds[3] - origin[1]) / dy + 1e-9));
    if ((lastCopy - firstCopy + 1) * (lastRow - firstRow + 1) > HEXAGON_QUERY_BUDGET) return overBudget();
    for (let copy = firstCopy; copy <= lastCopy; copy++) {
      for (let row = firstRow; row <= lastRow; row++) {
        const shift = copy * WORLD_COMMON_WIDTH - origin[0];
        const firstCol = Math.max(x0, Math.ceil((bounds[0] + shift) / dx - (row & 1) / 2 - 1e-9));
        const lastCol = Math.min(x1 - 1, Math.floor((bounds[2] + shift) / dx - (row & 1) / 2 + 1e-9));
        if (queries.size + lastCol - firstCol + 1 > HEXAGON_QUERY_BUDGET) return overBudget();
        for (let col = firstCol; col <= lastCol; col++) add(col, row);
      }
    }
  }
  return { status: 'ok', value: [...queries.values()] };
}

/** Query current grid coordinates before reading bins; never reuse a previous aggregation index. */
export function captureCurrentHexagonTarget(
  target: CameraTarget,
  runtime: ResolvedLayerRuntime,
  layer: CustomObject,
): EnvelopeResult<CameraTarget> {
  const aggregator = layer.state?.aggregator;
  const props = getRenderedHexagonCellProps(layer);
  if (!aggregator || !props || typeof aggregator.getBin !== 'function')
    return { status: 'unavailable', reason: 'Rendered aggregation is not ready.' };
  const marks: CustomObject[] = [];
  const anchor = target.selectionAnchor ?? target.center;
  const rings = targetRings(target);
  const queries = currentHexagonQueries(target, layer, props, rings);
  if (queries.status !== 'ok') return queries;
  let nearest: { distance: number; mark: CustomObject } | undefined;
  for (const query of queries.value) {
    const bin = aggregator.getBin(query.index);
    if (!bin || !(bin.count > 0)) continue;
    if (query.expectedId && (bin.id[0] !== query.expectedId[0] || bin.id[1] !== query.expectedId[1])) {
      return { status: 'unavailable', reason: 'Rendered aggregation changed during selection. Try re-adapting again.' };
    }
    const mark = {
      col: bin.id[0],
      row: bin.id[1],
      colorValue: bin.value[0],
      elevationValue: bin.value[1],
      count: bin.count,
    };
    const common = getRenderedHexagonCellCenterCommon(props, mark);
    if (!common) return { status: 'unavailable', reason: 'Rendered hexagon position is invalid.' };
    const position = projection.unprojectFlat(common);
    if (rings) {
      if (containsPosition(rings, position)) marks.push(mark);
    } else {
      const p = projection.projectFlat([unwrapLongitude(anchor[0], position[0]), anchor[1]]);
      const distance = Math.hypot(p[0] - common[0], p[1] - common[1]);
      if (distance <= props.radius && (!nearest || distance < nearest.distance)) nearest = { distance, mark };
    }
  }
  if (!rings && nearest) marks.push(nearest.mark);
  return captureHexagonTarget(target, runtime, layer, marks);
}
