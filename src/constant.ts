import { AmbientLight, LightingEffect, PointLight } from '@deck.gl/core';
import { blue, red, grey, orange } from '@ant-design/colors';

// export const HEXAGON_LAYER_MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
export const HEXAGON_LAYER_MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';

export const HEXAGON_LAYER_AMBIENT_LIGHT = new AmbientLight({
  color: [255, 255, 255],
  intensity: 1.0,
});

export const HEXAGON_LAYER_POINT_LIGHT_1 = new PointLight({
  color: [255, 255, 255],
  intensity: 0.8,
  position: [-0.144528, 49.739968, 80000],
});

export const HEXAGON_LAYER_POINT_LIGHT_2 = new PointLight({
  color: [255, 255, 255],
  intensity: 0.8,
  position: [-3.807751, 54.104682, 8000],
});

export const HEXAGON_LAYER_LIGHTING_EFFECT = new LightingEffect({
  ambientLight: HEXAGON_LAYER_AMBIENT_LIGHT,
  pointLight1: HEXAGON_LAYER_POINT_LIGHT_1,
  pointLight2: HEXAGON_LAYER_POINT_LIGHT_2,
});

export const HEXAGON_LAYER_MATERIAL = {
  ambient: 0.64,
  diffuse: 0.6,
  shininess: 32,
  specularColor: [51, 51, 51],
};

export const HEXAGON_LAYER_INITIAL_VIEW_STATE = {
  longitude: -1.415727,
  latitude: 52.232395,
  zoom: 6.6,
  minZoom: 5,
  maxZoom: 15,
  pitch: 40.5,
  bearing: -27,
  minPitch: 0,
  maxPitch: 70,
};

export const COLUMBUS_HEXAGON_INITIAL_VIEW_STATE = {
  longitude: -82.977,
  latitude: 39.883,
  zoom: 14.5,
  minZoom: 5,
  maxZoom: 18,
  pitch: 40.5,
  bearing: 0,
  minPitch: 0,
  maxPitch: 70,
};

export const SF_BIKE_PARKING_INITIAL_VIEW_STATE = {
  longitude: -122.43,
  latitude: 37.77,
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
  pitch: 40.5,
  bearing: 0,
  minPitch: 0,
  maxPitch: 70,
};

export const HEXAGON_LAYER_COLOR_RANGE: number[][] = [
  [1, 152, 189],
  [73, 227, 206],
  [216, 254, 181],
  [254, 237, 177],
  [254, 173, 84],
  [209, 55, 78],
];

export const LINE_LAYER_INITIAL_VIEW_STATE = {
  longitude: -2,
  latitude: 53.7,
  zoom: 5.3,
  minZoom: 3,
  maxZoom: 16,
  pitch: 0,
  bearing: 0,
  maxPitch: 85,
};

export const LINE_LAYER_MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';

export const BART_RIDERSHIP_INITIAL_VIEW_STATE = {
  ...LINE_LAYER_INITIAL_VIEW_STATE,
  longitude: -122.27,
  latitude: 37.78,
  zoom: 8.4,
  pitch: 0,
  bearing: 0,
  maxPitch: 60,
};

export const POINT_LAYER_INITIAL_VIEW_STATE = {
  longitude: 0,
  latitude: 10,
  zoom: 1,
  pitch: 0,
  bearing: 0,
  minZoom: 0,
  maxZoom: 20,
  minPitch: 0,
  maxPitch: 60,
};

export const POINT_LAYER_MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

export const HEATMAP_LAYER_MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

export const MIX_LAYER_MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

export const MIX_LAYER_INITIAL_VIEW_STATE = {
  longitude: -97.7,
  latitude: 39,
  zoom: 2.5,
  pitch: 0,
  bearing: 0,
  minZoom: 0,
  maxZoom: 20,
  minPitch: 0,
  maxPitch: 60,
};

export const ANIMATED_LAYER_AMBIENT_LIGHT = new AmbientLight({
  color: [255, 255, 255],
  intensity: 1.0,
});

export const ANIMATED_LAYER_POINT_LIGHT = new PointLight({
  color: [255, 255, 255],
  intensity: 2.0,
  position: [-74.05, 40.7, 8000],
});

export const ANIMATED_LAYER_LIGHTING_EFFECT = new LightingEffect({
  ANIMATED_LAYER_AMBIENT_LIGHT,
  ANIMATED_LAYER_POINT_LIGHT,
});

export const ANIMATED_LAYER_MATERIAL = {
  ambient: 0.1,
  diffuse: 0.6,
  shininess: 32,
  specularColor: [60, 64, 70],
};

export const ANIMATED_LAYER_THEME = {
  buildingColor: [74, 80, 87],
  trailColor0: [253, 128, 93],
  trailColor1: [23, 184, 190],
  material: ANIMATED_LAYER_MATERIAL,
  effects: [ANIMATED_LAYER_LIGHTING_EFFECT],
};

export const ANIMATED_LAYER_MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';

export const ANIMATED_LAYER_INITIAL_VIEW_STATE = {
  longitude: -74,
  latitude: 40.72,
  zoom: 13,
  pitch: 45,
  bearing: 0,
  minZoom: 0,
  maxZoom: 20,
  minPitch: 0,
  maxPitch: 60,
};

export const HANDLE_RADIUS = 4;
export const HANDLE_STROKE = {
  DEFAULT: '#fff',
  SELECTED: blue[5],
  HOVERED: red[3],
};
export const HANDLE_FILL = {
  DEFAULT: grey[2],
  SELECTED: blue[3],
  HOVERED: blue[5],
  INACTIVE: grey[6],
  UNCOMMITTED: grey[6],
};
export const FEATURE_STROKE = {
  DEFAULT: orange[4],
  INACTIVE: orange[4],
  UNCOMMITTED: orange[3],
  CLOSING: orange[3],
  SELECTED: orange[4],
  HOVERED: orange[4],
};
export const FEATURE_FILL = {
  DEFAULT: orange[5],
  INACTIVE: orange[5],
  HOVERED: orange[4],
  SELECTED: orange[5],
  UNCOMMITTED: orange[4],
  CLOSING: grey[2],
};

export const GEO_TYPE_REGION = 'region';
export const GEO_TYPE_POINT = 'location';
export const GEO_TYPE_PATH = 'path';
export const GEO_TYPE_MULTIPLE = 'multiple';
export const GEO_TYPE_NONE = 'null';
