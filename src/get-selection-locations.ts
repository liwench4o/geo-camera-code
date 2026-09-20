import KDBush from 'kdbush';

export function getLocationsTree(locations: number[][]) {
  if (locations) {
    return new KDBush(
      locations,
      (location: number[]) => lngX(location[0]),
      (location: number[]) => latY(location[1]),
    );
  } else {
    return undefined;
  }
}

// longitude/latitude to spherical mercator in [0..1] range
function lngX(lng: number) {
  return lng / 360 + 0.5;
}

function latY(lat: number) {
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI;
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

type LocationTree = KDBush<number[]>;

function _getLocationsInBboxIndices(tree: LocationTree | undefined, bbox: [number, number, number, number]) {
  if (!tree) {
    return undefined;
  }
  const [lon1, lat1, lon2, lat2] = bbox;
  const [x1, y1, x2, y2] = [lngX(lon1), latY(lat1), lngX(lon2), latY(lat2)];
  return tree.range(Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2));
}

export function getLocationsInBbox(tree: LocationTree | undefined, bbox: [number, number, number, number]) {
  if (!tree) {
    return undefined;
  }
  return _getLocationsInBboxIndices(tree, bbox)?.map((idx: number) => tree.points[idx]);
}
