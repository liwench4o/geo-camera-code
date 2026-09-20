import type { CameraView } from '../interfaces';
import { WebMercatorViewport } from '@deck.gl/core';
import { cameraCatalog } from './catalog';
import { validateCommittedTrajectoryPlanForMovement } from './trajectory/validation';
import { derivePlaybackPlan } from '../story/playback';
import { createCameraMovement, planAdaptiveCamera, inspectCameraMovement } from './planner';
import { createSnapshotEnvelope } from './geometry/envelope';
import type { VisualPrimitive } from './geometry/types';
import { createPathTarget, createPointTarget, enrichCameraTargetStats } from './selection';
import { compileRuntimeTrajectory } from './trajectory/sampler';
import { getProjectedVisualBounds } from './viewport';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const view: CameraView = {
  longitude: 0,
  latitude: 0,
  zoom: 8,
  pitch: 35,
  bearing: 0,
  minZoom: 0,
  maxZoom: 20,
  minPitch: 0,
  maxPitch: 85,
};
const viewport = { width: 1200, height: 800 };

const simple = createCameraMovement({
  cameraName: 'emphasis-static',
  currentViewState: view,
  target: createPointTarget([0, 0]),
  viewportSize: viewport,
});
assert(
  simple.cameraMovement.trajectoryPlan,
  'every new camera must commit the trajectory used by engineering checks and playback',
);
assert(
  simple.cameraMovement.authoring?.version === 1,
  'new cameras must save authoring intent separately from their trajectory',
);
assert(simple.report?.status !== undefined, 'new cameras must return an explicit engineering check report');

const route = createPathTarget([
  [0, 0],
  [0, 2],
  [2, 2],
  [2, 0],
]);
assert(route, 'fixture route should construct');
const tracking = createCameraMovement({
  cameraName: 'emphasis-tracking',
  currentViewState: view,
  target: route,
  viewportSize: viewport,
}).cameraMovement;
assert(tracking.trajectoryPlan, 'tracking must commit a route trajectory');
const runtime = compileRuntimeTrajectory(tracking.trajectoryPlan.trajectory);
assert(runtime.status === 'ok', 'route trajectory must compile');
const middle = runtime.value.sample(tracking.duration / 2);
const middleHead = new WebMercatorViewport({ ...middle, ...viewport }).project([1, 2]);
assert(
  Math.abs(middleHead[0] / viewport.width - 0.5) < 0.002 && Math.abs(middleHead[1] / viewport.height - 0.6) < 0.002,
  'U-shaped tracking must frame the route middle with space ahead instead of crossing between endpoints',
);
assert(tracking.framingReport?.scope === 'route-window', 'tracking checks the local route window');

const height = enrichCameraTargetStats(createPointTarget([0, 0]), {
  analytics: {
    layers: [
      {
        id: 'hex',
        kind: 'hexagon',
        rowCount: 1,
        elevationScale: 250,
        elevationRange: [0, 1000],
        elevationDomain: [0, 10],
        maxElevationValue: 10,
        maxElevationMeters: 250000,
      },
    ],
  },
  pickedObject: { count: 10 },
});
assert(height.visualFrame?.heightMeters === 250000, 'framing must retain the full rendered column height');

function rendererTarget(primitives: VisualPrimitive[], coordinate: [number, number] = [0, 0]) {
  const envelope = createSnapshotEnvelope({
    id: 'renderer-target',
    supportGuarantee: 'conservative',
    provenance: {
      datasetId: 'test',
      visualizationId: 'test',
      layerId: 'test',
      dataRevision: 'data-1',
      visualizationRevision: 'style-1',
      producerId: 'test',
      producerVersion: 1,
      sceneRevision: 'scene-1',
      resolvedLayerDigest: 'layer-1',
    },
    primitives,
    anchor: [...coordinate, 0],
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
  assert(envelope.status === 'ok', 'renderer fixture should construct');
  return { ...createPointTarget(coordinate), snapshotEnvelope: envelope.value };
}

// The rendered London cell is narrow on the ground but about 118 km tall. A ground-bbox
// fit must retreat substantially before projection becomes usable; that must not erase a tilt.
const tallColumn = rendererTarget(
  [
    {
      kind: 'extruded-footprint',
      rings: [
        [
          [-0.1293, 51.5134],
          [-0.1017, 51.5134],
          [-0.1017, 51.5332],
          [-0.1293, 51.5332],
        ],
      ],
      baseMeters: 0,
      topMeters: 117964.82412060302,
      supportBufferPx: 2,
    },
  ],
  [-0.1155, 51.5233],
);
const tallSource = {
  ...view,
  longitude: -1.415727,
  latitude: 52.232395,
  zoom: 6.432176,
  pitch: 40.5,
  bearing: -27,
  minZoom: 5,
  maxZoom: 15,
  maxPitch: 60,
};
const tallViewport = { width: 1000, height: 600 };
for (const cameraName of ['emphasis-tilt', 'combination-push-in-tilt', 'combination-arc-tilt']) {
  const planned = planAdaptiveCamera({
    cameraName,
    currentViewState: tallSource,
    target: tallColumn,
    viewportSize: tallViewport,
  });
  assert(planned.status === 'planned', `${cameraName}: the tall column has feasible framing`);
  const camera = planned.cameraMovement;
  assert(
    camera.finalViewState.pitch - camera.initViewState.pitch >= 10,
    `${cameraName}: fitting must retain the available tilt instead of collapsing to the recipe pitch floor`,
  );
  if (cameraName.includes('push-in'))
    assert(
      camera.finalViewState.zoom - camera.initViewState.zoom >= 0.45,
      'the tall-column push-in and tilt must retain both motion components',
    );
  assert(inspectCameraMovement(camera, tallViewport).fits, `${cameraName}: preserved tilt must still frame the column`);
}
for (const cameraName of ['combination-arc-pull-out', 'combination-pull-out-roll']) {
  const planned = planAdaptiveCamera({
    cameraName,
    currentViewState: tallSource,
    target: tallColumn,
    viewportSize: tallViewport,
  });
  assert(planned.status === 'planned', `${cameraName}: the tall column has feasible framing`);
  const camera = planned.cameraMovement;
  assert(
    camera.initViewState.zoom - camera.finalViewState.zoom >= 0.45,
    `${cameraName}: independently fitting the endpoints must not erase the available pull-out`,
  );
  assert(
    inspectCameraMovement(camera, tallViewport).fits,
    `${cameraName}: preserved pull-out must still frame the column`,
  );
}

const pixels = rendererTarget([{ kind: 'point-disc', position: [0, 0], radius: { value: 450, unit: 'pixels' } }]);
const noFit = planAdaptiveCamera({
  cameraName: 'emphasis-static',
  currentViewState: view,
  target: pixels,
  viewportSize: viewport,
});
assert(
  noFit.status === 'no-suggestion',
  'an oversized pixel marker must produce no suggestion even when zooming cannot help',
);
const manual = planAdaptiveCamera({
  cameraName: 'emphasis-static',
  currentViewState: view,
  target: pixels,
  viewportSize: viewport,
  authoring: {
    version: 1,
    targetId: pixels.id,
    recipeId: 'emphasis-static',
    adjustments: {},
    manualViews: { initial: view, final: view },
    planningViewport: viewport,
  },
});
assert(
  manual.status === 'planned' && manual.report?.status === 'warning',
  'a valid manually cropped close-up remains applicable with a warning',
);
if (manual.status === 'planned') {
  const invalid = planAdaptiveCamera({
    cameraName: 'emphasis-static',
    currentViewState: view,
    target: pixels,
    viewportSize: viewport,
    authoring: { ...manual.cameraMovement.authoring!, manualViews: { initial: { ...view, latitude: 89 } } },
  });
  assert(invalid.status === 'no-suggestion', 'invalid manual projections are never accepted as close-ups');
}

const roll = createCameraMovement({
  cameraName: 'dynamic-camera-roll',
  currentViewState: view,
  viewportSize: viewport,
  optionSelection: { id: 'full-turn', label: 'Full turn', adjustment: { framing: { bearingDelta: 360 } } },
}).cameraMovement;
const rollRuntime = compileRuntimeTrajectory(roll.trajectoryPlan!.trajectory);
assert(rollRuntime.status === 'ok', 'full turn compiles');
assert(
  Math.abs(rollRuntime.value.sample(roll.duration / 2).bearing - 180) < 1e-6,
  'a full rotation reaches 180 degrees at half time instead of collapsing to no movement',
);
assert(
  inspectCameraMovement(tracking, viewport, 1).report.status === 'incomplete',
  'exhausted sampling budget must never report passed',
);

const wrapped = createPathTarget([
  [179.5, 0],
  [-179.5, 0.5],
]);
assert(
  wrapped && wrapped.bbox[2] - wrapped.bbox[0] < 2,
  'a route crossing the date line must fit its short geographic extent',
);

const trueGeometry = rendererTarget([{ kind: 'point-disc', position: [0, 0], radius: { value: 8, unit: 'pixels' } }]);
trueGeometry.visualFrame = { bbox: [-20, -20, 20, 20], heightMeters: 250000 };
const bounds = getProjectedVisualBounds(view, trueGeometry, viewport);
assert(
  bounds && bounds.maxX - bounds.minX < 20,
  'renderer primitives must override the legacy bounding-box by maximum-height approximation',
);
const precise = createCameraMovement({
  cameraName: 'emphasis-static',
  currentViewState: view,
  target: trueGeometry,
  viewportSize: viewport,
}).cameraMovement;
assert(
  precise.initViewState.zoom > 8,
  'a loose legacy bbox must not force a renderer-backed small target into a distant frame',
);
const comparisons = [createPointTarget([0, 0]), createPointTarget([1, 1])];
const comparison = planAdaptiveCamera({
  cameraName: 'comparison-static',
  currentViewState: view,
  target: comparisons[0],
  comparisonTargets: comparisons,
  viewportSize: viewport,
});
assert(
  comparison.status === 'planned',
  'comparison static must fit the comparison group even when the current selected target is only one member',
);
for (const endpoint of [comparison.cameraMovement.initViewState, comparison.cameraMovement.finalViewState]) {
  for (const target of comparisons) {
    const [x, y] = new WebMercatorViewport({ ...endpoint, ...viewport }).project(target.center);
    assert(
      Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= viewport.width && y >= 0 && y <= viewport.height,
      'comparison must keep each independently projected target visible',
    );
  }
}
const scanTarget = {
  ...createPointTarget([0, 0]),
  type: 'region' as const,
  bbox: [-1, -0.1, 1, 0.1] as [number, number, number, number],
  visualFrame: undefined,
};
const scan = (density: number) =>
  createCameraMovement({
    cameraName: 'overview-trucking',
    currentViewState: view,
    target: {
      ...scanTarget,
      stats: { count: 1, densityRatio: density, visualAreaRatio: density, dispersionRatio: density },
    },
    viewportSize: viewport,
  }).cameraMovement;
const sparseScan = scan(0),
  denseScan = scan(1);
for (const endpoint of ['initViewState', 'finalViewState'] as const) {
  for (const channel of ['longitude', 'latitude', 'zoom', 'pitch', 'bearing'] as const) {
    assert(
      Math.abs(sparseScan[endpoint][channel] - denseScan[endpoint][channel]) < 1e-6,
      'scan geometry must not change through hidden density/dispersion coefficients',
    );
  }
}
assert(
  Math.abs(sparseScan.finalViewState.longitude - sparseScan.initViewState.longitude) > 0,
  'the scan must traverse the long horizontal axis',
);
const tall = createCameraMovement({
  cameraName: 'emphasis-push-in',
  currentViewState: view,
  target: { ...createPointTarget([0, 0]), visualFrame: { bbox: [-0.01, -0.01, 0.01, 0.01], heightMeters: 250000 } },
  viewportSize: { width: 400, height: 300 },
  framingTuning: { pitchTarget: 60 },
}).cameraMovement;
assert(
  tall.finalViewState.pitch >= 60 ||
    tall.framingReport?.messages.some((message) => message.includes('angle was lowered')),
  'automatic angle relaxation must be explained to the author',
);
const manualComparison = planAdaptiveCamera({
  cameraName: 'comparison-static',
  currentViewState: view,
  comparisonTargets: comparisons,
  viewportSize: viewport,
  authoring: {
    version: 1,
    targetId: 'pair',
    recipeId: 'comparison-static',
    adjustments: {},
    manualViews: {
      initial: { ...view, pitch: 0, zoom: 12 },
      final: { ...view, pitch: 0, longitude: 1, latitude: 1, zoom: 12 },
    },
    planningViewport: viewport,
  },
});
assert(
  manualComparison.status === 'planned' &&
    manualComparison.report?.status === 'warning' &&
    manualComparison.report.scope === 'whole-shot',
  'a comparison hold must check the whole comparison group, including manually cropped endpoints',
);
const authoredTurn = createCameraMovement({
  cameraName: 'dynamic-camera-roll',
  currentViewState: view,
  viewportSize: viewport,
  optionSelection: { id: 'full-turn', label: 'Full turn', adjustment: { framing: { bearingDelta: 360 } } },
  authoring: {
    version: 1,
    targetId: 'none',
    recipeId: 'dynamic-camera-roll',
    adjustments: {},
    manualViews: { initial: view, final: { ...view, zoom: 9, bearing: 0 } },
    planningViewport: viewport,
  },
}).cameraMovement;
const authoredTurnRuntime = compileRuntimeTrajectory(authoredTurn.trajectoryPlan!.trajectory);
assert(
  authoredTurnRuntime.status === 'ok' &&
    Math.abs(authoredTurnRuntime.value.sample(authoredTurn.duration / 2).bearing - 180) < 1e-6,
  'editing a full-turn endpoint with a map-normalized bearing must retain the complete turn',
);
const longerRoute = createPathTarget(
  Array.from({ length: 256 }, (_, index) => [index / 255, 0.1 * Math.sin(index / 32)]),
)!;
const longRouteResult = planAdaptiveCamera({
  cameraName: 'emphasis-tracking',
  currentViewState: view,
  target: longerRoute,
  viewportSize: viewport,
});
assert(
  longRouteResult.status === 'planned',
  'ordinary detailed routes should receive enough bounded samples to inspect their turn keys',
);
const markerRoute = { ...route, snapshotEnvelope: pixels.snapshotEnvelope };
const markerRoutePlan = planAdaptiveCamera({
  cameraName: 'emphasis-tracking',
  currentViewState: view,
  target: markerRoute,
  viewportSize: viewport,
});
assert(
  markerRoutePlan.status === 'no-suggestion',
  'route-window checks must not discard renderer markers when their geometry is not a route corridor',
);
const fractionalView = { ...view, longitude: -1.4, latitude: 52.23, zoom: 6, pitch: 40.5 };
const london = {
  ...createPointTarget([-0.10168834616032678, 51.4786278538686]),
  visualFrame: { bbox: [-0.12, 51.46, -0.08, 51.5] as [number, number, number, number], heightMeters: 250000 },
};
const londonCamera = createCameraMovement({
  cameraName: 'emphasis-static',
  currentViewState: fractionalView,
  target: london,
  viewportSize: { width: 592, height: 363 },
}).cameraMovement;
assert(
  validateCommittedTrajectoryPlanForMovement(londonCamera.trajectoryPlan, londonCamera).status === 'ok',
  'fractional projected endpoint coordinates must match the serialized trajectory exactly',
);
derivePlaybackPlan([londonCamera]);
for (const template of cameraCatalog.cameras) {
  const generated = createCameraMovement({
    cameraName: template.id,
    currentViewState: fractionalView,
    target: template.targetTypes.includes('path') ? route : createPointTarget([-0.11732316, 51.510005321]),
    comparisonTargets: comparisons,
    viewportSize: viewport,
  }).cameraMovement;
  assert(
    validateCommittedTrajectoryPlanForMovement(generated.trajectoryPlan, generated).status === 'ok',
    `${template.id}: generated endpoint metadata must match the committed trajectory`,
  );
  derivePlaybackPlan([generated]);
}
const editedHold = createCameraMovement({
  cameraName: 'emphasis-static',
  currentViewState: view,
  target: trueGeometry,
  viewportSize: viewport,
  authoring: {
    version: 1,
    targetId: trueGeometry.id,
    recipeId: 'emphasis-static',
    adjustments: {},
    manualViews: { initial: view, final: { ...view, zoom: view.zoom + 0.5 } },
    planningViewport: viewport,
  },
}).cameraMovement;
assert(
  editedHold.framingReport?.status === 'warning' &&
    editedHold.framingReport.messages.some((message) => message.includes('static template now moves')),
  'different manual endpoints retained on a static template must explicitly explain the resulting movement',
);
assert(
  editedHold.initViewState.zoom === view.zoom && editedHold.finalViewState.zoom === view.zoom + 0.5,
  'explaining an incompatible static edit must not discard either authored endpoint',
);
for (const cameraName of ['emphasis-static', 'basic-static']) {
  for (const pitchTarget of [0, 75]) {
    const angled = createCameraMovement({
      cameraName,
      currentViewState: view,
      target: trueGeometry,
      viewportSize: viewport,
      framingTuning: { pitchTarget },
    }).cameraMovement;
    assert(
      angled.initViewState.pitch === pitchTarget && angled.finalViewState.pitch === pitchTarget,
      `${cameraName}: explicit angle ${pitchTarget} must override the template's recommended range`,
    );
  }
}
const deckDrag = {
  ...view,
  longitude: 15,
  latitude: 0,
  pitch: 0,
  altitude: 1.5,
  maxBounds: [
    [-Infinity, -90],
    [Infinity, 90],
  ],
  position: [0, 0, 0],
  width: viewport.width,
  height: viewport.height,
  normalize: true,
};
const draggedPlan = planAdaptiveCamera({
  cameraName: 'emphasis-push-in',
  currentViewState: view,
  target: trueGeometry,
  viewportSize: viewport,
  authoring: {
    version: 1,
    targetId: trueGeometry.id,
    recipeId: 'emphasis-push-in',
    adjustments: {},
    manualViews: { initial: deckDrag, final: { ...deckDrag, longitude: 16 } },
    planningViewport: viewport,
  },
});
assert(
  draggedPlan.status === 'planned' && draggedPlan.report?.status === 'warning',
  'legitimate offscreen manual views from Deck interaction must yield a crop warning, not an infinite maxBounds canonicalization error',
);
if (draggedPlan.status === 'planned') derivePlaybackPlan([draggedPlan.cameraMovement]);
const invalidDrag = planAdaptiveCamera({
  cameraName: 'emphasis-push-in',
  currentViewState: view,
  target: trueGeometry,
  viewportSize: viewport,
  authoring: {
    version: 1,
    targetId: trueGeometry.id,
    recipeId: 'emphasis-push-in',
    adjustments: {},
    manualViews: { initial: { ...deckDrag, longitude: NaN } },
    planningViewport: viewport,
  },
});
assert(
  invalidDrag.status === 'no-suggestion',
  'normalization must preserve invalid semantic numbers so real camera errors are rejected',
);
console.log('adaptive planner tests passed');
