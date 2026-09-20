import { project, VERSION, WebMercatorViewport } from '@deck.gl/core';
import type { ProjectUniforms } from '@deck.gl/core';

import type { CameraView } from '../../interfaces';
import type { ProjectionOptions, ScreenRect, ViewportSpec } from './types';
import {
  projectEnvelopeFootprints,
  projectMeterOffsetForTest,
  projectPrimitiveFootprint,
  validateVisualPrimitive,
} from './primitives';
import type { LngLat, VisualPrimitive, VisualTargetFrame, WorldPosition } from './types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertClose(actual: number, expected: number, tolerance: number, message: string): void {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, received ${actual}`);
}

function assertBoundsContain(bounds: ScreenRect, points: Array<[number, number]>, message: string): void {
  const epsilon = 1e-7;
  assert(Object.values(bounds).every(Number.isFinite), `${message}; bounds must be finite`);
  const outside = points.findIndex(
    ([x, y]) =>
      !(
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        x >= bounds.minX - epsilon &&
        x <= bounds.maxX + epsilon &&
        y >= bounds.minY - epsilon &&
        y <= bounds.maxY + epsilon
      ),
  );
  assert(outside === -1, `${message}; oracle point ${outside} fell outside ${JSON.stringify(bounds)}`);
}

function makeView(patch: Partial<CameraView> = {}): CameraView {
  return {
    longitude: 0,
    latitude: 0,
    zoom: 8,
    pitch: 0,
    bearing: 0,
    minZoom: 0,
    maxZoom: 20,
    minPitch: 0,
    maxPitch: 85,
    ...patch,
  };
}

const viewport: ViewportSpec = { width: 1000, height: 700 };
const projectionOptions: ProjectionOptions = {
  meterSupportTolerancePx: 0.25,
  meterSupportIntervalBudget: 4096,
};

const smallSquareAroundOrigin: LngLat[] = [
  [-0.01, -0.01],
  [0.01, -0.01],
  [0.01, 0.01],
  [-0.01, 0.01],
  [-0.01, -0.01],
];

function makeFrame(primitives: VisualPrimitive[]): VisualTargetFrame {
  return {
    primitives,
    anchor: [0, 0, 0],
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
    wrap: { wrapReference: 0, worldOffset: 0, wrapMode: 'minimum-arc' },
  };
}

function denseMeterCircle(
  view: CameraView,
  origin: WorldPosition,
  radiusMeters: number,
  sampleCount = 360,
): Array<[number, number]> {
  return Array.from({ length: sampleCount }, (_, degree) => {
    const radians = (degree * Math.PI * 2) / sampleCount;
    return projectMeterOffsetForTest(view, viewport, origin, [
      radiusMeters * Math.cos(radians),
      radiusMeters * Math.sin(radians),
      0,
    ]);
  });
}

function testInvalidPrimitiveContractsAreRejected(): void {
  const invalidPrimitives: Array<[string, VisualPrimitive]> = [
    ['negative radius', { kind: 'point-disc', position: [0, 0, 0], radius: { value: -1, unit: 'pixels' } }],
    ['non-finite radius', { kind: 'point-disc', position: [0, 0, 0], radius: { value: Number.NaN, unit: 'meters' } }],
    [
      'implicit radius unit',
      {
        kind: 'point-disc',
        position: [0, 0, 0],
        radius: { value: 1, unit: 'world' },
      } as unknown as VisualPrimitive,
    ],
    [
      'non-finite position height',
      {
        kind: 'point-disc',
        position: [0, 0, Number.POSITIVE_INFINITY],
        radius: { value: 1, unit: 'pixels' },
      },
    ],
    ['negative screen width', { kind: 'screen-rect', position: [0, 0, 0], widthPx: -1, heightPx: 10 }],
    ['non-finite screen height', { kind: 'screen-rect', position: [0, 0, 0], widthPx: 10, heightPx: Number.NaN }],
    [
      'non-finite extrusion top',
      {
        kind: 'extruded-footprint',
        rings: [smallSquareAroundOrigin],
        baseMeters: 0,
        topMeters: Number.POSITIVE_INFINITY,
      },
    ],
    ['empty extrusion rings', { kind: 'extruded-footprint', rings: [], baseMeters: 0, topMeters: 1 }],
    ['empty extrusion ring', { kind: 'extruded-footprint', rings: [[]], baseMeters: 0, topMeters: 1 }],
    ['empty path', { kind: 'path-corridor', positions: [], halfWidth: { value: 1, unit: 'pixels' } }],
    ['empty polygon', { kind: 'polygon', rings: [] }],
    ['empty mesh', { kind: 'mesh-support', vertices: [], conservative: true }],
    ['non-finite mesh coordinate', { kind: 'mesh-support', vertices: [[Number.NaN, 0, 0]], conservative: true }],
    [
      'negative buffer',
      {
        kind: 'point-disc',
        position: [0, 0, 0],
        radius: { value: 1, unit: 'pixels' },
        pixelClamp: { supportBufferPx: -1 },
      },
    ],
    [
      'non-finite clamp',
      {
        kind: 'path-corridor',
        positions: [[0, 0, 0]],
        halfWidth: { value: 1, unit: 'pixels' },
        pixelClamp: { minPx: Number.NaN },
      },
    ],
    [
      'reversed clamp',
      {
        kind: 'path-corridor',
        positions: [[0, 0, 0]],
        halfWidth: { value: 1, unit: 'pixels' },
        pixelClamp: { minPx: 5, maxPx: 2 },
      },
    ],
  ];

  for (const [label, primitive] of invalidPrimitives) {
    assert(validateVisualPrimitive(primitive).status === 'error', `${label} must fail validation`);
  }

  const mismatchedTops: VisualPrimitive = {
    kind: 'extruded-footprint',
    rings: [smallSquareAroundOrigin],
    baseMeters: 0,
    topMeters: [1, 2],
  };
  assert(validateVisualPrimitive(mismatchedTops).status === 'error', 'top array length mismatch must fail');

  const belowDatum: VisualPrimitive[] = [
    { kind: 'point-disc', position: [0, 0, -100], radius: { value: 1, unit: 'pixels' } },
    { kind: 'extruded-footprint', rings: [smallSquareAroundOrigin], baseMeters: -100, topMeters: -50 },
    {
      kind: 'polygon',
      rings: [smallSquareAroundOrigin.map(([longitude, latitude]) => [longitude, latitude, -25])],
    },
  ];
  assert(
    belowDatum.every((primitive) => validateVisualPrimitive(primitive).status === 'ok'),
    'finite below-datum heights must remain valid',
  );
}

function testProjectionInputContractsAreRejected(): void {
  const primitive: VisualPrimitive = {
    kind: 'point-disc',
    position: [0, 0, 0],
    radius: { value: 1, unit: 'pixels' },
  };
  const invalidView = projectPrimitiveFootprint(primitive, makeView({ zoom: Number.NaN }), viewport, projectionOptions);
  assert(invalidView.status === 'error', 'non-finite view projection must fail');

  const invalidViewports: ViewportSpec[] = [
    { width: 0, height: 100 },
    { width: 100, height: -1 },
    { width: Number.POSITIVE_INFINITY, height: 100 },
  ];
  for (const invalidViewport of invalidViewports) {
    assert(
      projectPrimitiveFootprint(primitive, makeView(), invalidViewport, projectionOptions).status === 'error',
      'viewport dimensions must be finite and positive',
    );
  }

  assert(
    projectPrimitiveFootprint(primitive, makeView(), viewport, {
      meterSupportTolerancePx: 0,
      meterSupportIntervalBudget: 16,
    }).status === 'error',
    'meter support tolerance must be finite and positive',
  );
  assert(
    projectPrimitiveFootprint(primitive, makeView(), viewport, {
      meterSupportTolerancePx: 0.25,
      meterSupportIntervalBudget: 0,
    }).status === 'error',
    'meter support interval budget must be a positive integer',
  );
}

function testPixelDiscAndScreenRectStayExactInCssPixels(): void {
  const view = makeView({ longitude: 0, latitude: 0, zoom: 8, pitch: 40, bearing: 25 });
  const center = projectMeterOffsetForTest(view, viewport, [0, 0, 0], [0, 0, 0]);
  const pixelDisc = projectPrimitiveFootprint(
    {
      kind: 'point-disc',
      position: [0, 0, 0],
      radius: { value: 30, unit: 'pixels' },
      pixelClamp: { supportBufferPx: 2 },
    },
    view,
    viewport,
    projectionOptions,
  );
  assert(pixelDisc.status === 'ok', 'pixel disc fixture must project');
  assertClose(pixelDisc.value.bounds.maxX - pixelDisc.value.bounds.minX, 64, 0.1, 'pixel disc width');
  assertClose(pixelDisc.value.bounds.minX, center[0] - 32, 1e-7, 'pixel disc minimum x');
  assertClose(pixelDisc.value.bounds.maxY, center[1] + 32, 1e-7, 'pixel disc maximum y');
  assertClose(pixelDisc.value.inflationPx, 32, 1e-12, 'pixel disc inflation');

  const screenRect = projectPrimitiveFootprint(
    {
      kind: 'screen-rect',
      position: [0, 0, 0],
      widthPx: 80,
      heightPx: 24,
      supportBufferPx: 3,
    },
    view,
    viewport,
    projectionOptions,
  );
  assert(screenRect.status === 'ok', 'screen rectangle fixture must project');
  assertClose(screenRect.value.bounds.minX, center[0] - 43, 1e-7, 'screen rectangle minimum x');
  assertClose(screenRect.value.bounds.maxX, center[0] + 43, 1e-7, 'screen rectangle maximum x');
  assertClose(screenRect.value.bounds.minY, center[1] - 15, 1e-7, 'screen rectangle minimum y');
  assertClose(screenRect.value.bounds.maxY, center[1] + 15, 1e-7, 'screen rectangle maximum y');
}

function testPixelClampOrderIsMinThenMaxThenBuffer(): void {
  const view = makeView({ pitch: 35, bearing: -20 });
  const clampedDisc = projectPrimitiveFootprint(
    {
      kind: 'point-disc',
      position: [0, 0, 0],
      radius: { value: 0.5, unit: 'pixels' },
      pixelClamp: { minPx: 2, maxPx: 5, supportBufferPx: 1 },
    },
    view,
    viewport,
    projectionOptions,
  );
  assert(clampedDisc.status === 'ok' && clampedDisc.value.inflationPx === 3, 'disc clamp order must be exact');

  const minimumClampedPath = projectPrimitiveFootprint(
    {
      kind: 'path-corridor',
      positions: [
        [0, 0, 0],
        [0.01, 0, 0],
      ],
      halfWidth: { value: 0.5, unit: 'pixels' },
      pixelClamp: { minPx: 2, maxPx: 5, supportBufferPx: 1 },
    },
    view,
    viewport,
    projectionOptions,
  );
  assert(
    minimumClampedPath.status === 'ok' && minimumClampedPath.value.inflationPx === 3,
    'path minimum clamp precedes buffer',
  );

  const maximumClampedPath = projectPrimitiveFootprint(
    {
      kind: 'path-corridor',
      positions: [
        [0, 0, 0],
        [0.01, 0, 0],
      ],
      halfWidth: { value: 20, unit: 'pixels' },
      pixelClamp: { minPx: 2, maxPx: 5, supportBufferPx: 1 },
    },
    view,
    viewport,
    projectionOptions,
  );
  assert(
    maximumClampedPath.status === 'ok' && maximumClampedPath.value.inflationPx === 6,
    'path maximum clamp precedes buffer',
  );

  const minimumClampedMeters = projectPrimitiveFootprint(
    {
      kind: 'point-disc',
      position: [0, 0, 0],
      radius: { value: 1, unit: 'meters' },
      pixelClamp: { minPx: 2, maxPx: 5, supportBufferPx: 1 },
    },
    view,
    viewport,
    projectionOptions,
  );
  assert(
    minimumClampedMeters.status === 'ok' && minimumClampedMeters.value.inflationPx === 3,
    'meter support must apply the minimum pixel clamp before the buffer',
  );

  const maximumClampedMeters = projectPrimitiveFootprint(
    {
      kind: 'point-disc',
      position: [0, 0, 0],
      radius: { value: 10_000, unit: 'meters' },
      pixelClamp: { minPx: 2, maxPx: 5, supportBufferPx: 1 },
    },
    view,
    viewport,
    projectionOptions,
  );
  assert(
    maximumClampedMeters.status === 'ok' && maximumClampedMeters.value.inflationPx === 6,
    'meter support must apply the maximum pixel clamp before the buffer',
  );
}

function testTallExtrusionProjectsEveryBaseAndTopVertexWithoutCapping(): void {
  const view = makeView({ longitude: 0, latitude: 0, zoom: 8, pitch: 40, bearing: 0 });
  const tall = projectPrimitiveFootprint(
    { kind: 'extruded-footprint', rings: [smallSquareAroundOrigin], baseMeters: 0, topMeters: 250000 },
    view,
    viewport,
    projectionOptions,
  );
  assert(tall.status === 'ok', 'tall extrusion must project');
  assert(tall.value.sourceHeights.includes(250000), '250 km top must not be capped');
  assert(tall.value.vertices.length === smallSquareAroundOrigin.length * 2, 'every base and top vertex must project');
  assert(tall.value.sourceHeights.length === smallSquareAroundOrigin.length * 2, 'source heights must match vertices');
  assert(
    tall.value.vertices.every(
      ([x, y, depth]: [number, number, number?]) => Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(depth),
    ),
    'projected extrusion coordinates and depths must be finite',
  );
  assertBoundsContain(
    tall.value.bounds,
    tall.value.vertices.map(([x, y]: [number, number, number?]) => [x, y]),
    'extrusion bounds must contain every projected vertex',
  );

  const perVertexTops = [-50, 10, 20, 30, 40];
  const varied = projectPrimitiveFootprint(
    {
      kind: 'extruded-footprint',
      rings: [smallSquareAroundOrigin],
      baseMeters: -100,
      topMeters: perVertexTops,
      supportBufferPx: 4,
    },
    view,
    viewport,
    projectionOptions,
  );
  assert(varied.status === 'ok', 'per-vertex top fixture must project');
  assert(
    varied.value.sourceHeights.slice(0, smallSquareAroundOrigin.length).every((height: number) => height === -100),
    'each flattened base vertex must preserve the base height',
  );
  assert(
    varied.value.sourceHeights.slice(smallSquareAroundOrigin.length).join(',') === perVertexTops.join(','),
    'topMeters array must map in flattened vertex order',
  );
  const unbuffered = projectPrimitiveFootprint(
    {
      kind: 'extruded-footprint',
      rings: [smallSquareAroundOrigin],
      baseMeters: -100,
      topMeters: perVertexTops,
    },
    view,
    viewport,
    projectionOptions,
  );
  assert(unbuffered.status === 'ok', 'unbuffered per-vertex fixture must project');
  assertClose(varied.value.bounds.minX, unbuffered.value.bounds.minX - 4, 1e-7, 'extrusion buffer minimum x');
  assertClose(varied.value.bounds.maxY, unbuffered.value.bounds.maxY + 4, 1e-7, 'extrusion buffer maximum y');
}

function testUnsupportedMercatorAndNonFiniteMeshNeverBecomeEmptySuccess(): void {
  const view = makeView();
  const invalidLatitude = projectPrimitiveFootprint(
    { kind: 'point-disc', position: [0, 89, 0], radius: { value: 1, unit: 'pixels' } },
    view,
    viewport,
    projectionOptions,
  );
  assert(invalidLatitude.status === 'unsupported', 'Mercator overflow must be unsupported');

  const invalidMesh = projectPrimitiveFootprint(
    { kind: 'mesh-support', vertices: [[Number.NaN, 0, 0]], conservative: true },
    view,
    viewport,
    projectionOptions,
  );
  assert(invalidMesh.status === 'error', 'non-finite mesh support must fail');
}

function assertMeterDiscContainsDenseOracle(
  label: string,
  view: CameraView,
  origin: WorldPosition,
  radiusMeters: number,
): void {
  const meterDisc = projectPrimitiveFootprint(
    { kind: 'point-disc', position: origin, radius: { value: radiusMeters, unit: 'meters' } },
    view,
    viewport,
    projectionOptions,
  );
  assert(meterDisc.status === 'ok', `${label} meter support fixture must project`);
  assert(meterDisc.value.bounds.maxX > meterDisc.value.bounds.minX, `${label} meter support must have width`);
  assert(meterDisc.value.bounds.maxY > meterDisc.value.bounds.minY, `${label} meter support must have height`);
  assertBoundsContain(meterDisc.value.bounds, denseMeterCircle(view, origin, radiusMeters), `${label} dense oracle`);
}

function testMeterDiscBoundsAreConservativeAcrossViews(): void {
  assertMeterDiscContainsDenseOracle('ordinary', makeView(), [0, 0, 0], 1000);
  assertMeterDiscContainsDenseOracle(
    'pitched and bearing',
    makeView({ longitude: 12, latitude: 35, zoom: 9, pitch: 65, bearing: 137 }),
    [12.02, 35.01, 300],
    1800,
  );
  assertMeterDiscContainsDenseOracle(
    'high latitude',
    makeView({ longitude: -45, latitude: 78, zoom: 7, pitch: 55, bearing: -72 }),
    [-44.95, 78.02, 150],
    1200,
  );
}

function testHighLatitudeIntervalContainsDirectPolynomialCorners(): void {
  const view = makeView({ longitude: 10, latitude: 72, zoom: 7, pitch: 60, bearing: 100 });
  const localViewport: ViewportSpec = { width: 1440, height: 900 };
  const origin: WorldPosition = [10.026, 71.968, 100];
  const radiusMeters = 5000;
  const result = projectPrimitiveFootprint(
    { kind: 'point-disc', position: origin, radius: { value: radiusMeters, unit: 'meters' } },
    view,
    localViewport,
    projectionOptions,
  );
  assert(result.status === 'ok', 'finite high-latitude support must not fail on interval/sample roundoff');
  const oracle = Array.from({ length: 360 }, (_, degree) => {
    const radians = (degree * Math.PI) / 180;
    return projectMeterOffsetForTest(view, localViewport, origin, [
      radiusMeters * Math.cos(radians),
      radiusMeters * Math.sin(radians),
      0,
    ]);
  });
  assertBoundsContain(result.value.bounds, oracle, 'high-latitude direct polynomial oracle');
}

function testDirectMeterPolynomialMatchesDeckReference(): void {
  const cases: Array<{
    view: CameraView;
    origin: WorldPosition;
    offset: [number, number, number];
  }> = [
    {
      view: makeView({ longitude: 12, latitude: 35, zoom: 9, pitch: 65, bearing: 137 }),
      origin: [12.02, 35.01, 300],
      offset: [1234, -567, 25],
    },
    {
      view: makeView({ longitude: -45, latitude: 78, zoom: 7, pitch: 55, bearing: -72 }),
      origin: [-44.95, 78.02, 150],
      offset: [750, 500, -20],
    },
  ];

  for (const { view, origin, offset } of cases) {
    const deckViewport = new WebMercatorViewport({
      width: viewport.width,
      height: viewport.height,
      longitude: view.longitude,
      latitude: view.latitude,
      zoom: view.zoom,
      pitch: view.pitch,
      bearing: view.bearing,
      altitude: view.altitude,
    });
    const offsetPosition = deckViewport.addMetersToLngLat([origin[0], origin[1], origin[2] ?? 0], offset);
    const deckProjection = deckViewport.project(offsetPosition);
    const directProjection = projectMeterOffsetForTest(view, viewport, origin, offset);
    assertClose(directProjection[0], deckProjection[0], 1e-8, 'direct meter polynomial x compatibility');
    assertClose(directProjection[1], deckProjection[1], 1e-8, 'direct meter polynomial y compatibility');
  }
}

function testMeterSupportContainsScreenFacingDeckSize(): void {
  assert(VERSION === '9.3.2', 'strict renderer v1 deck shader fixtures require deck.gl 9.3.2');
  const radiusMeters = 1000;
  const cases: Array<{ label: string; view: CameraView; origin: WorldPosition }> = [
    {
      label: 'low-zoom Web Mercator',
      view: makeView({ longitude: 0, latitude: 0, zoom: 8, pitch: 80, bearing: 35 }),
      origin: [0, 10, 0],
    },
    {
      label: 'high-zoom auto offset',
      view: makeView({ longitude: 0, latitude: 10, zoom: 13, pitch: 80, bearing: -20 }),
      origin: [0.001, 10.001, 50],
    },
  ];

  for (const { label, view, origin } of cases) {
    const deckViewport = new WebMercatorViewport({
      width: viewport.width,
      height: viewport.height,
      longitude: view.longitude,
      latitude: view.latitude,
      zoom: view.zoom,
      pitch: view.pitch,
      bearing: view.bearing,
    });
    const uniforms = project.getUniforms({
      viewport: deckViewport,
      coordinateSystem: 'lnglat',
    }) as ProjectUniforms;
    const latitudeFactor = uniforms.projectionMode === 1 ? 1 / Math.cos(origin[1] * (Math.PI / 180)) : 1;
    const shaderHalfWidthPx = radiusMeters * uniforms.commonUnitsPerMeter[2] * latitudeFactor * uniforms.scale;
    const center = projectMeterOffsetForTest(view, viewport, origin, [0, 0, 0]);
    const point = projectPrimitiveFootprint(
      { kind: 'point-disc', position: origin, radius: { value: radiusMeters, unit: 'meters' } },
      view,
      viewport,
      projectionOptions,
    );
    assert(point.status === 'ok', `${label} screen-facing meter point fixture must project`);
    assertBoundsContain(
      point.value.bounds,
      [
        [center[0] - shaderHalfWidthPx, center[1]],
        [center[0] + shaderHalfWidthPx, center[1]],
        [center[0], center[1] - shaderHalfWidthPx],
        [center[0], center[1] + shaderHalfWidthPx],
      ],
      `${label} meter point must contain the deck billboard size`,
    );
  }

  const view = cases[0].view;
  const origin = cases[0].origin;
  const deckViewport = new WebMercatorViewport({
    width: viewport.width,
    height: viewport.height,
    longitude: view.longitude,
    latitude: view.latitude,
    zoom: view.zoom,
    pitch: view.pitch,
    bearing: view.bearing,
  });
  const shaderHalfWidthPx =
    radiusMeters *
    deckViewport.getDistanceScales([origin[0], origin[1], origin[2] ?? 0]).unitsPerMeter[0] *
    deckViewport.scale;
  const center = projectMeterOffsetForTest(view, viewport, origin, [0, 0, 0]);

  const path = projectPrimitiveFootprint(
    {
      kind: 'path-corridor',
      positions: [origin, [0.2, 10.2, 100]],
      halfWidth: { value: radiusMeters, unit: 'meters' },
    },
    view,
    viewport,
    projectionOptions,
  );
  assert(path.status === 'ok', 'screen-facing meter path fixture must project');
  assertBoundsContain(
    path.value.bounds,
    [
      [center[0] - shaderHalfWidthPx, center[1]],
      [center[0] + shaderHalfWidthPx, center[1]],
      [center[0], center[1] - shaderHalfWidthPx],
      [center[0], center[1] + shaderHalfWidthPx],
    ],
    'meter path endpoint must contain the deck billboard size',
  );
}

function testClipDomainRejectsPartiallyClippedSupport(): void {
  const view = makeView({ longitude: 0, latitude: 0, zoom: 8, pitch: 40, bearing: 0 });
  const belowFarPlane = projectPrimitiveFootprint(
    { kind: 'extruded-footprint', rings: [smallSquareAroundOrigin], baseMeters: 0, topMeters: -200_000 },
    view,
    viewport,
    projectionOptions,
  );
  assert(belowFarPlane.status === 'unsupported', 'support beyond the far clip plane must be unsupported');

  const aboveNearPlane = projectPrimitiveFootprint(
    { kind: 'extruded-footprint', rings: [smallSquareAroundOrigin], baseMeters: 0, topMeters: 400_000 },
    view,
    viewport,
    projectionOptions,
  );
  assert(aboveNearPlane.status === 'unsupported', 'support beyond the near clip plane must be unsupported');
}

function testNearHorizonSupportIsContainedOrExplicitlyUnsupported(): void {
  const view = makeView({ longitude: 0, latitude: 50, zoom: 3, pitch: 85, bearing: 179 });
  const origin: WorldPosition = [0, 50, 0];
  const radiusMeters = 2_000_000;
  const result = projectPrimitiveFootprint(
    { kind: 'point-disc', position: origin, radius: { value: radiusMeters, unit: 'meters' } },
    view,
    viewport,
    { meterSupportTolerancePx: 0.25, meterSupportIntervalBudget: 16_384 },
  );
  if (result.status === 'unsupported') {
    return;
  }
  assert(result.status === 'ok', 'near-horizon support may only succeed or be explicitly unsupported');
  assertBoundsContain(result.value.bounds, denseMeterCircle(view, origin, radiusMeters, 720), 'near-horizon oracle');
}

function testMeterBudgetExhaustionIsUnsupportedRatherThanSampledSuccess(): void {
  const result = projectPrimitiveFootprint(
    { kind: 'point-disc', position: [0, 60, 0], radius: { value: 1_000_000, unit: 'meters' } },
    makeView({ latitude: 60, zoom: 8, pitch: 75, bearing: 43 }),
    viewport,
    { meterSupportTolerancePx: 1e-9, meterSupportIntervalBudget: 1 },
  );
  assert(result.status === 'unsupported', 'uncertified budget exhaustion must be unsupported');
}

function testNonBindingMaxClampDoesNotConsumeWitnessBudget(): void {
  const options: ProjectionOptions = { meterSupportTolerancePx: 0.25, meterSupportIntervalBudget: 1 };
  const primitive: VisualPrimitive = {
    kind: 'point-disc',
    position: [0, 0, 0],
    radius: { value: 1, unit: 'meters' },
  };
  const raw = projectPrimitiveFootprint(primitive, makeView(), viewport, options);
  const nonBinding = projectPrimitiveFootprint(
    { ...primitive, pixelClamp: { maxPx: 1000 } },
    makeView(),
    viewport,
    options,
  );
  assert(raw.status === 'ok' && nonBinding.status === 'ok', 'a no-op max clamp must not require witness budget');
  assertClose(nonBinding.value.inflationPx, raw.value.inflationPx, 1e-12, 'no-op max clamp inflation');

  const pathPositions: WorldPosition[] = Array.from({ length: 700 }, (_, index) => [index * 1e-6, 0, 0]);
  const pathOptions: ProjectionOptions = { meterSupportTolerancePx: 1000, meterSupportIntervalBudget: 4096 };
  const rawPath = projectPrimitiveFootprint(
    { kind: 'path-corridor', positions: pathPositions, halfWidth: { value: 1, unit: 'meters' } },
    makeView(),
    viewport,
    pathOptions,
  );
  const nonBindingPath = projectPrimitiveFootprint(
    {
      kind: 'path-corridor',
      positions: pathPositions,
      halfWidth: { value: 1, unit: 'meters' },
      pixelClamp: { maxPx: 1000 },
    },
    makeView(),
    viewport,
    pathOptions,
  );
  assert(rawPath.status === 'ok' && nonBindingPath.status === 'ok', 'no-op path clamp must preserve shared budget');
}

function testClampProofSkipsWhenSubdivisionHasTheOnlyRemainingBudget(): void {
  const options: ProjectionOptions = { meterSupportTolerancePx: 0.0001, meterSupportIntervalBudget: 5 };
  const view = makeView({ pitch: 40 });
  const primitive: VisualPrimitive = {
    kind: 'point-disc',
    position: [0, 0, 0],
    radius: { value: 100, unit: 'meters' },
  };
  const raw = projectPrimitiveFootprint(primitive, view, viewport, options);
  const clamped = projectPrimitiveFootprint({ ...primitive, pixelClamp: { maxPx: 0.1 } }, view, viewport, options);
  assert(raw.status === 'ok' && clamped.status === 'ok', 'clamp proof must yield to feasible subdivision budget');
  assertClose(clamped.value.inflationPx, 0.1, 1e-12, 'binding clamp after subdivision');
}

function testPathCorridorsProjectVerticesAndConservativelyInflateAtEverySupportPosition(): void {
  const view = makeView({ longitude: 10, latitude: 72, zoom: 7, pitch: 60, bearing: 100 });
  const positions: WorldPosition[] = [
    [9.9, 71.8, 100],
    [10.25, 72.0, 350],
    [10.1, 72.2, 200],
  ];
  const radiusMeters = 5000;
  const meterPath = projectPrimitiveFootprint(
    { kind: 'path-corridor', positions, halfWidth: { value: radiusMeters, unit: 'meters' } },
    view,
    viewport,
    projectionOptions,
  );
  assert(meterPath.status === 'ok', 'meter path fixture must project');
  assert(meterPath.value.vertices.length === positions.length, 'path must preserve every projected path vertex');
  assert(meterPath.value.sourceHeights.join(',') === '100,350,200', 'path must preserve source heights');
  const supportOracle = positions.flatMap((position) => denseMeterCircle(view, position, radiusMeters));
  assertBoundsContain(meterPath.value.bounds, supportOracle, 'meter corridor support at all vertices');

  const pixelPath = projectPrimitiveFootprint(
    {
      kind: 'path-corridor',
      positions,
      halfWidth: { value: 4, unit: 'pixels' },
      pixelClamp: { supportBufferPx: 2 },
    },
    view,
    viewport,
    projectionOptions,
  );
  assert(pixelPath.status === 'ok' && pixelPath.value.inflationPx === 6, 'pixel corridor inflation must be exact');
  const roundJoinOracle = pixelPath.value.vertices.flatMap(([x, y]) => [
    [x - 6, y] as [number, number],
    [x + 6, y] as [number, number],
    [x, y - 6] as [number, number],
    [x, y + 6] as [number, number],
  ]);
  assertBoundsContain(pixelPath.value.bounds, roundJoinOracle, 'acute round join/cap support');
}

function testPolygonAndMeshProjectEveryProducerVertex(): void {
  const view = makeView({ pitch: 45, bearing: 31 });
  const polygon: VisualPrimitive = {
    kind: 'polygon',
    rings: [
      [
        [-0.02, -0.01, 0],
        [0.03, -0.01, 100],
        [0.01, 0.04, 200],
        [-0.02, -0.01, 0],
      ],
    ],
    supportBufferPx: 2,
  };
  const mesh: VisualPrimitive = {
    kind: 'mesh-support',
    vertices: [
      [-0.05, 0.02, 10],
      [0.06, 0.03, 20],
      [0, -0.04, 30],
    ],
    conservative: true,
    supportBufferPx: 1,
  };
  const projectedPolygon = projectPrimitiveFootprint(polygon, view, viewport, projectionOptions);
  const projectedMesh = projectPrimitiveFootprint(mesh, view, viewport, projectionOptions);
  assert(projectedPolygon.status === 'ok' && projectedPolygon.value.vertices.length === 4, 'all polygon vertices');
  assert(projectedMesh.status === 'ok' && projectedMesh.value.vertices.length === 3, 'all mesh vertices');
  assert(projectedPolygon.value.sourceHeights.join(',') === '0,100,200,0', 'polygon source heights');
  assert(projectedMesh.value.sourceHeights.join(',') === '10,20,30', 'mesh source heights');
  assertBoundsContain(
    projectedPolygon.value.bounds,
    projectedPolygon.value.vertices.map(([x, y]: [number, number, number?]) => [x, y]),
    'polygon bounds must contain every projected vertex',
  );
  assertBoundsContain(
    projectedMesh.value.bounds,
    projectedMesh.value.vertices.map(([x, y]: [number, number, number?]) => [x, y]),
    'mesh bounds must contain every projected vertex',
  );

  const polygonWithoutBuffer = projectPrimitiveFootprint(
    { ...polygon, supportBufferPx: 0 },
    view,
    viewport,
    projectionOptions,
  );
  const meshWithoutBuffer = projectPrimitiveFootprint(
    { ...mesh, supportBufferPx: 0 },
    view,
    viewport,
    projectionOptions,
  );
  assert(polygonWithoutBuffer.status === 'ok' && meshWithoutBuffer.status === 'ok', 'buffer controls');
  assertClose(
    projectedPolygon.value.bounds.minX,
    polygonWithoutBuffer.value.bounds.minX - 2,
    1e-7,
    'polygon support buffer',
  );
  assertClose(projectedMesh.value.bounds.maxY, meshWithoutBuffer.value.bounds.maxY + 1, 1e-7, 'mesh support buffer');
}

function testLargeSupportArraysReturnStructuredResultsWithoutArgumentSpreadOverflow(): void {
  const ring: WorldPosition[] = Array.from({ length: 200_000 }, () => [0, 0, 0]);
  const result = projectPrimitiveFootprint({ kind: 'polygon', rings: [ring] }, makeView(), viewport, projectionOptions);
  assert(result.status === 'ok', 'large finite support must return a structured successful result');
  assert(result.value.vertices.length === ring.length, 'large support must preserve every producer vertex');
}

function testEnvelopeProjectionPreservesIndicesAndFailsAsAWhole(): void {
  const validFrame = makeFrame([
    { kind: 'screen-rect', position: [0, 0, 0], widthPx: 10, heightPx: 20 },
    { kind: 'point-disc', position: [0.01, 0, 0], radius: { value: 2, unit: 'pixels' } },
  ]);
  const projected = projectEnvelopeFootprints(validFrame, makeView(), viewport, projectionOptions);
  assert(projected.status === 'ok', 'valid frame must project');
  assert(projected.value.length === 2, 'frame must preserve every primitive');
  assert(
    projected.value[0].primitiveIndex === 0 && projected.value[1].primitiveIndex === 1,
    'frame projection must preserve primitive indices',
  );

  const invalidFrame = makeFrame([
    validFrame.primitives[0],
    { kind: 'point-disc', position: [0, 89, 0], radius: { value: 1, unit: 'pixels' } },
  ]);
  const failed = projectEnvelopeFootprints(invalidFrame, makeView(), viewport, projectionOptions);
  assert(failed.status === 'unsupported', 'one unsupported primitive must fail the entire frame');

  const empty = projectEnvelopeFootprints(makeFrame([]), makeView(), viewport, projectionOptions);
  assert(empty.status === 'error', 'an empty frame must fail rather than return an empty success');
}

testInvalidPrimitiveContractsAreRejected();
testProjectionInputContractsAreRejected();
testPixelDiscAndScreenRectStayExactInCssPixels();
testPixelClampOrderIsMinThenMaxThenBuffer();
testTallExtrusionProjectsEveryBaseAndTopVertexWithoutCapping();
testClipDomainRejectsPartiallyClippedSupport();
testUnsupportedMercatorAndNonFiniteMeshNeverBecomeEmptySuccess();
testMeterDiscBoundsAreConservativeAcrossViews();
testHighLatitudeIntervalContainsDirectPolynomialCorners();
testDirectMeterPolynomialMatchesDeckReference();
testMeterSupportContainsScreenFacingDeckSize();
testNearHorizonSupportIsContainedOrExplicitlyUnsupported();
testMeterBudgetExhaustionIsUnsupportedRatherThanSampledSuccess();
testNonBindingMaxClampDoesNotConsumeWitnessBudget();
testClampProofSkipsWhenSubdivisionHasTheOnlyRemainingBudget();
testPathCorridorsProjectVerticesAndConservativelyInflateAtEverySupportPosition();
testPolygonAndMeshProjectEveryProducerVertex();
testLargeSupportArraysReturnStructuredResultsWithoutArgumentSpreadOverflow();
testEnvelopeProjectionPreservesIndicesAndFailsAsAWhole();
