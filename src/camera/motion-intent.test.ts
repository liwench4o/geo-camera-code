import { WebMercatorViewport } from '@deck.gl/core';
import type { CameraMovement, CameraView } from '../interfaces';
import { createStoryJson, parseStoryJson } from '../story/serialization';
import type { CameraAuthoringSpec } from './authoring-types';
import { createSnapshotEnvelope } from './geometry/envelope';
import { createCameraMovement, inspectCameraMovement, planAdaptiveCamera } from './planner';
import { resolveCameraRecipe } from './recipes';
import { createPathTarget, createPointTarget } from './selection';
import { computeViewDisplacement, resolveAdaptiveDuration } from './timing';
import { compileRuntimeTrajectory } from './trajectory/sampler';
import type { CameraTarget } from './types';
import { getProjectedVisualBounds } from './viewport';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function near(actual: number, expected: number, message: string, tolerance = 1e-6) {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, received ${actual}`);
}
const viewport = { width: 1000, height: 700 };
const view: CameraView = { longitude: 0, latitude: 0, zoom: 7, pitch: 35, bearing: 0, minZoom: -2, maxZoom: 20 };
const envelope = createSnapshotEnvelope({
  id: 'motion-target',
  supportGuarantee: 'conservative',
  provenance: {
    datasetId: 'test',
    visualizationId: 'test',
    layerId: 'test',
    dataRevision: '1',
    visualizationRevision: '1',
    producerId: 'test',
    producerVersion: 1,
    sceneRevision: '1',
    resolvedLayerDigest: '1',
  },
  primitives: [
    {
      kind: 'extruded-footprint',
      rings: [
        [
          [-0.02, -0.02],
          [0.02, -0.02],
          [0.02, 0.02],
          [-0.02, 0.02],
        ],
      ],
      baseMeters: 0,
      topMeters: 3000,
    },
  ],
  anchor: [0, 0, 1500],
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
assert(envelope.status === 'ok', 'renderer fixture is valid');
const target: CameraTarget = { ...createPointTarget([0, 0]), snapshotEnvelope: envelope.value };
function plan(cameraName: string, intent: Partial<CameraAuthoringSpec> = {}, selectedTarget = target, current = view) {
  return createCameraMovement({
    cameraName,
    currentViewState: current,
    target: selectedTarget,
    viewportSize: viewport,
    authoring: {
      version: 2,
      targetId: selectedTarget.id,
      recipeId: cameraName,
      adjustments: {},
      planningViewport: viewport,
      ...intent,
    },
  }).cameraMovement;
}
function sample(camera: CameraMovement, progress: number) {
  const runtime = compileRuntimeTrajectory(camera.trajectoryPlan!.trajectory);
  assert(runtime.status === 'ok', 'trajectory compiles');
  return runtime.value.sample(camera.duration * progress);
}
const failures: string[] = [];
function test(name: string, run: () => void) {
  try {
    run();
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

test('pitch endpoints are independent', () => {
  const camera = plan('emphasis-tilt', { motion: { startPitch: 0, endPitch: 60 } });
  near(camera.initViewState.pitch, 0, 'top-down start');
  near(camera.finalViewState.pitch, 60, 'tilted finish');
  assert(inspectCameraMovement(camera).fits, 'tilt keeps the full target at checked moments');
});
test('exact signed zoom requests survive fitting', () => {
  for (const [name, delta] of [
    ['emphasis-push-in', 2.12],
    ['overview-pull-out', -1.06],
  ] as const) {
    const camera = plan(name, { motion: { zoomDelta: delta, startPitch: 20, endPitch: 20 } });
    near(camera.finalViewState.zoom - camera.initViewState.zoom, delta, 'end minus start zoom');
    near(camera.initViewState.pitch, 20, 'independent constant pitch');
    near(camera.finalViewState.pitch, 20, 'independent constant pitch');
    assert(inspectCameraMovement(camera).fits, 'target remains framed');
  }
});
test('start bearing and signed sweep override arc presets', () => {
  const camera = plan('emphasis-arc', { motion: { startBearing: 0, bearingSweep: 120, startPitch: 20, endPitch: 20 } });
  near(camera.initViewState.bearing, 0, 'arc start');
  near(camera.finalViewState.bearing, 120, 'arc finish');
  near(sample(camera, 0.5).bearing, 60, 'arc midpoint');
  assert(
    !camera.framingReport?.messages.some((message) => message.includes('angle was lowered')),
    'an exact authored angle is not reported as a safety reduction',
  );
});
test('full negative turns work on a non-rotation template', () => {
  const camera = plan('emphasis-static', {
    motion: { startBearing: 20, bearingSweep: -720, startPitch: 20, endPitch: 20 },
  });
  near(sample(camera, 0.5).bearing, -340, 'negative double turn midpoint');
  near(camera.finalViewState.bearing, -700, 'negative double turn finish');
  assert(camera.framingReport?.requestedMotion?.bearingSweep === -720, 'report retains request');
  near(camera.framingReport.resolvedMotion!.bearingSweep!, -720, 'report gives actual signed sweep');
});
test('captured source is stable during replanning', () => {
  const source = { ...view, longitude: -5, latitude: 1, zoom: 6 };
  const intent: Partial<CameraAuthoringSpec> = {
    source: { kind: 'reference-view', view: source },
    motion: { zoomDelta: 1.06 },
  };
  const first = plan('emphasis-pan', intent);
  const next = plan('emphasis-pan', intent, target, { ...view, longitude: 80, zoom: 3 });
  near(first.initViewState.longitude, source.longitude, 'pan begins at captured source');
  near(next.initViewState.longitude, first.initViewState.longitude, 'ambient map change does not move source');
  near(next.finalViewState.zoom - next.initViewState.zoom, 1.06, 'pan accepts independent zoom');
});
test('a pan with explicit zoom starts at the captured source scale when the finish fits', () => {
  const source = { ...view, longitude: -0.2, zoom: 5.3 };
  const camera = plan('emphasis-pan', {
    source: { kind: 'reference-view', view: source },
    motion: { zoomDelta: 2.25586253 },
  });
  near(camera.initViewState.zoom, 5.3, 'pan keeps the captured source zoom');
  near(camera.finalViewState.zoom, 7.55586253, 'pan applies the signed delta from that source');
  assert(inspectCameraMovement(camera).fits, 'target fits at the requested endpoint scale');
});
test('an explicit pan zoom widens both endpoints together only when the target requires it', () => {
  const source = { ...view, longitude: -0.2, zoom: 11 };
  const wide: CameraTarget = { ...createPointTarget([0, 0]), visualFrame: { bbox: [-2, -2, 2, 2] } };
  const camera = plan(
    'emphasis-pan',
    { source: { kind: 'reference-view', view: source }, motion: { zoomDelta: 2.12 } },
    wide,
  );
  assert(camera.initViewState.zoom < source.zoom, 'fitting a large target widens the start');
  near(
    camera.finalViewState.zoom - camera.initViewState.zoom,
    2.12,
    'shared widening preserves the requested zoom movement',
  );
  near(camera.initViewState.longitude, source.longitude, 'shared widening retains source location');
  assert(inspectCameraMovement(camera).fits, 'widened automatic finish keeps target visible');
});
test('context bounds supplement renderer geometry', () => {
  const plain = plan('emphasis-static', { motion: { startPitch: 0, endPitch: 0 } });
  const camera = plan('emphasis-static', {
    motion: { startPitch: 0, endPitch: 0 },
    composition: { context: { kind: 'bounds', bounds: [-3, -2, 3, 2] } },
  });
  assert(camera.finalViewState.zoom < plain.finalViewState.zoom - 3, 'broad context widens framing');
  assert(camera.targetSnapshot === target, 'saved full target geometry is unchanged');
  const projected = new WebMercatorViewport({ ...camera.finalViewState, ...viewport });
  for (const coordinate of [
    [-3, -2],
    [3, 2],
  ]) {
    const point = projected.project(coordinate);
    assert(
      point[0] >= 69 && point[0] <= 931 && point[1] >= 69 && point[1] <= 631,
      'context corners keep safety margin',
    );
  }
  const bounds = getProjectedVisualBounds(camera.finalViewState, target, viewport);
  assert(bounds && bounds.minY >= 69, 'rendered target still fits');
});
test('captured view contributes geographic context', () => {
  const camera = plan('emphasis-static', {
    composition: { context: { kind: 'view', view: { ...view, zoom: 5, pitch: 0 }, viewport } },
  });
  assert(camera.finalViewState.zoom <= 5, 'captured surrounding area is included');
});
test('context cannot shrink a larger saved renderer envelope', () => {
  const baseline = plan('emphasis-static', { motion: { startPitch: 0, endPitch: 0 } });
  const camera = plan('emphasis-static', {
    motion: { startPitch: 0, endPitch: 0 },
    composition: { context: { kind: 'bounds', bounds: [-0.001, -0.001, 0.001, 0.001] } },
  });
  assert(
    camera.finalViewState.zoom <= baseline.finalViewState.zoom + 1e-6,
    'smaller geographic context cannot replace full target extent',
  );
  assert(inspectCameraMovement(camera).fits, 'original renderer primitives remain visible');
});
test('context accepts wide regions and the complete world', () => {
  for (const bounds of [
    [-170, -30, 170, 30],
    [-180, -70, 180, 70],
  ] as [number, number, number, number][]) {
    const camera = plan('emphasis-static', {
      motion: { startPitch: 0, endPitch: 0 },
      composition: { context: { kind: 'bounds', bounds } },
    });
    const projection = new WebMercatorViewport({ ...camera.finalViewState, ...viewport });
    for (const longitude of [bounds[0], 0, bounds[2]]) {
      const pixel = projection.project([longitude, 0]);
      assert(pixel[0] >= 69 && pixel[0] <= 931, 'wide context includes both edges and middle');
    }
  }
});
test('ground anchoring works with renderer snapshots and offsets', () => {
  const before = JSON.stringify(target.snapshotEnvelope);
  const camera = plan('emphasis-static', {
    motion: { startPitch: 60, endPitch: 60 },
    composition: { anchor: 'ground', offsetRatio: [0.12, 0.08] },
  });
  const projected = new WebMercatorViewport({ ...camera.finalViewState, ...viewport }).project([0, 0, 0]);
  near(projected[0], 620, 'ground horizontal placement', 0.6);
  near(projected[1], 406, 'ground vertical placement', 0.6);
  assert(JSON.stringify(target.snapshotEnvelope) === before, 'anchor choice does not mutate conservative primitives');
});
for (const heightMeters of [3000, 250000]) {
  for (const canvas of [
    { width: 1000, height: 600 },
    { width: 800, height: 600 },
  ]) {
    for (const anchor of ['ground', 'visual'] as const) {
      test(`${anchor} anchor at ${heightMeters}m in ${canvas.width}×${canvas.height}`, () => {
        const snapshot = createSnapshotEnvelope({
          id: `anchor-height-${heightMeters}`,
          supportGuarantee: 'conservative',
          provenance: envelope.value.provenance,
          metrics: envelope.value.frame.metrics,
          primitives: [
            {
              kind: 'extruded-footprint',
              rings: [
                [
                  [-0.02, -0.02],
                  [0.02, -0.02],
                  [0.02, 0.02],
                  [-0.02, 0.02],
                ],
              ],
              baseMeters: 0,
              topMeters: heightMeters,
            },
          ],
          anchor: [0, 0, heightMeters / 2],
        });
        assert(snapshot.status === 'ok', 'height-specific renderer snapshot is valid');
        const selected: CameraTarget = { ...createPointTarget([0, 0]), snapshotEnvelope: snapshot.value };
        const original = JSON.stringify(selected.snapshotEnvelope);
        const offsetRatio: [number, number] = [0.08, 0.05];
        const camera = createCameraMovement({
          cameraName: 'emphasis-static',
          currentViewState: view,
          target: selected,
          viewportSize: canvas,
          authoring: {
            version: 2,
            targetId: selected.id,
            recipeId: 'emphasis-static',
            adjustments: {},
            motion: { startPitch: 45, endPitch: 45, zoomDelta: 0 },
            composition: { anchor, offsetRatio },
            planningViewport: canvas,
          },
        }).cameraMovement;
        const projection = new WebMercatorViewport({ ...camera.finalViewState, ...canvas });
        const pixel = projection.project([0, 0, anchor === 'ground' ? 0 : heightMeters / 2]);
        near(pixel[0], canvas.width * (0.5 + offsetRatio[0]), 'requested horizontal anchor placement', 1);
        near(pixel[1], canvas.height * (0.5 + offsetRatio[1]), 'requested vertical anchor placement', 1);
        const bounds = getProjectedVisualBounds(camera.finalViewState, selected, canvas);
        const safety = Math.min(canvas.width, canvas.height) * 0.1;
        assert(
          bounds &&
            Math.min(bounds.minX, bounds.minY, canvas.width - bounds.maxX, canvas.height - bounds.maxY) >= safety - 0.5,
          'the complete rendered column retains the safety margin',
        );
        assert(inspectCameraMovement(camera, canvas).fits, 'committed trajectory fits at the checked moments');
        assert(
          camera.targetSnapshot === selected && JSON.stringify(selected.snapshotEnvelope) === original,
          'composition preserves all original conservative renderer geometry',
        );
      });
    }
  }
}
test('manual endpoints remain authoritative over motion and context', () => {
  const initial = { ...view, zoom: 10, pitch: 10, bearing: 13 };
  const final = { ...view, longitude: 0.1, zoom: 11, pitch: 15, bearing: 17 };
  const camera = plan('emphasis-push-in', {
    motion: { zoomDelta: 2.12, startPitch: 0, endPitch: 60, bearingSweep: -720 },
    composition: { context: { kind: 'bounds', bounds: [-0.1, -0.1, 0.1, 0.1] } },
    manualViews: { initial, final },
  });
  near(camera.initViewState.zoom, initial.zoom, 'manual start zoom');
  near(camera.finalViewState.pitch, final.pitch, 'manual finish pitch');
  near(camera.finalViewState.bearing, final.bearing, 'manual finish bearing');
  assert(camera.framingReport?.requestedMotion?.zoomDelta === 2.12, 'manual report preserves request separately');
  near(camera.framingReport.resolvedMotion!.zoomDelta!, 1, 'manual report describes actual zoom');
});
test('automatic duration uses final authored displacement', () => {
  const camera = plan('emphasis-push-in', { motion: { zoomDelta: 2.12, startPitch: 0, endPitch: 60 } });
  const expected = resolveAdaptiveDuration({
    recipe: resolveCameraRecipe('emphasis-push-in'),
    displacement: computeViewDisplacement(camera.initViewState, camera.finalViewState, viewport),
  });
  near(camera.duration, expected.durationMs, 'duration matches final resolved endpoints');
  near(camera.trajectoryPlan!.trajectory.durationMs, camera.duration, 'committed trajectory has final duration');
  near(camera.debugInfo!.resolvedParameters!.durationMs, camera.duration, 'debug timing is current');
  const manual = plan('emphasis-push-in', { motion: { zoomDelta: 2.12 }, timing: { duration: 8123 } });
  near(manual.duration, 8123, 'manual duration is retained');
});
test('automatic duration accounts for the route-generated endpoint headings', () => {
  const route = createPathTarget([
    [0, 0],
    [0.01, 0.1],
    [0.1, 0.1],
    [0.1, 0],
  ])!;
  const optionSelection = {
    id: 'motion-timing',
    label: 'Motion timing',
    adjustment: { timing: { pathDurationPerKmMs: 0 } },
  };
  const camera = plan('emphasis-tracking', { optionSelection }, route);
  const displacement = computeViewDisplacement(camera.initViewState, camera.finalViewState, viewport);
  const expected = resolveAdaptiveDuration({
    recipe: resolveCameraRecipe('emphasis-tracking', optionSelection),
    displacement,
    pathLengthKm: route.stats?.pathLengthKm,
  });
  near(camera.duration, expected.durationMs, 'duration includes final route headings');
  near(
    camera.debugInfo!.resolvedParameters!.displacement!,
    Number(displacement.toFixed(3)),
    'reported displacement uses committed endpoints',
  );
});
test('out-of-range motion requests fail explicitly', () => {
  for (const motion of [
    { zoomDelta: 8.01 },
    { startPitch: -1 },
    { endPitch: 75.01 },
    { startBearing: 361 },
    { bearingSweep: -721 },
  ]) {
    const result = planAdaptiveCamera({
      cameraName: 'emphasis-static',
      currentViewState: view,
      target,
      viewportSize: viewport,
      authoring: {
        version: 2,
        targetId: target.id,
        recipeId: 'emphasis-static',
        adjustments: {},
        motion,
        planningViewport: viewport,
      },
    });
    assert(result.status === 'no-suggestion', `invalid motion ${JSON.stringify(motion)} is rejected`);
  }
});
test('direct planning rejects unsupported composition and source kinds', () => {
  const invalidIntents = [
    { composition: { anchor: 'roof' } },
    { composition: { offsetRatio: [0.46, 0] } },
    { composition: { offsetRatio: [0] } },
    { composition: { context: { kind: 'automatic' } } },
    { source: { kind: 'live-view', view } },
    { transition: 'fade' },
  ];
  for (const intent of invalidIntents) {
    const result = planAdaptiveCamera({
      cameraName: 'emphasis-static',
      currentViewState: view,
      target,
      viewportSize: viewport,
      authoring: {
        version: 2,
        targetId: target.id,
        recipeId: 'emphasis-static',
        adjustments: {},
        planningViewport: viewport,
        ...intent,
      } as CameraAuthoringSpec,
    });
    assert(result.status === 'no-suggestion', `unsupported intent ${JSON.stringify(intent)} is rejected`);
  }
});
test('manual endpoints bypass impossible automatic zoom requests', () => {
  const fixed = { ...view, zoom: 8, minZoom: 8, maxZoom: 8, pitch: 0 };
  const camera = plan(
    'emphasis-static',
    { motion: { zoomDelta: 8 }, manualViews: { initial: fixed, final: fixed } },
    target,
    fixed,
  );
  near(camera.initViewState.zoom, 8, 'manual start is retained at fixed zoom');
  near(camera.finalViewState.zoom, 8, 'manual finish is retained at fixed zoom');
});
test('a manual start does not waive safety for the automatic finish', () => {
  const source = { ...view, zoom: 10, minZoom: 10 };
  const manual = { ...source, zoom: 5, minZoom: 0, pitch: 0 };
  const selected: CameraTarget = {
    ...createPointTarget([0, 0]),
    bbox: [-0.2, -0.2, 0.2, 0.2],
    visualFrame: { bbox: [-0.2, -0.2, 0.2, 0.2], anchor: [0, 0], heightMeters: 3000 },
  };
  const camera = plan(
    'emphasis-tilt',
    { motion: { endPitch: 75 }, manualViews: { initial: manual } },
    selected,
    source,
  );
  near(camera.initViewState.zoom, manual.zoom, 'locked manual zoom stays fixed');
  near(camera.initViewState.pitch, manual.pitch, 'locked manual pitch stays fixed');
  const bounds = getProjectedVisualBounds(camera.finalViewState, selected, viewport);
  assert(
    bounds && Math.min(bounds.minX, bounds.minY, viewport.width - bounds.maxX, viewport.height - bounds.maxY) >= 69.5,
    'unlocked endpoint is corrected to meet safety margin',
  );
  assert(
    camera.framingReport?.messages.some((message) => message.includes('angle was lowered')),
    'necessary angle relaxation is reported',
  );
});
test('v2 planning captures its source for subsequent replanning', () => {
  const first = plan('emphasis-pan', { motion: { zoomDelta: 1.06 } });
  assert(first.authoring?.source?.view.longitude === view.longitude, 'resolved source is persisted');
  const next = plan('emphasis-pan', first.authoring, target, { ...view, longitude: 50, latitude: 40 });
  near(next.initViewState.longitude, first.initViewState.longitude, 'replanning uses captured source');
});
test('automatic source capture precedes targetless pitch adjustments', () => {
  const camera = plan('dynamic-camera-roll', { adjustments: { pitchTarget: 60 }, motion: { bearingSweep: 20 } });
  near(camera.authoring!.source!.view.pitch, view.pitch, 'source retains the raw input pitch');
  near(camera.initViewState.pitch, 60, 'authored pitch still controls the resolved shot');
});
test('successful corrected cameras export without nonfinite initial-fit diagnostics', () => {
  const tall: CameraTarget = {
    ...createPointTarget([0, 0]),
    visualFrame: { bbox: [-0.02, -0.02, 0.02, 0.02], heightMeters: 250000 },
  };
  const camera = plan(
    'emphasis-push-in',
    { motion: { zoomDelta: 2.12, startPitch: 0, endPitch: 60 }, composition: { anchor: 'ground' } },
    tall,
  );
  const story = createStoryJson([camera], { trajectoryEnabled: true, viewport });
  const restored = parseStoryJson(JSON.parse(JSON.stringify(story)));
  assert(
    restored.ok && restored.cameras.length === 1,
    'successfully corrected camera survives Story V2 export and import',
  );
});
if (failures.length) throw new Error(failures.join('\n'));
console.log('motion intent tests passed');
