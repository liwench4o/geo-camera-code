import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { CameraView, CustomObject } from '../interfaces';
import { getVisualizationDefaultParams, visualizationCatalog } from '../visualization/catalog';
import { dataLoaderRegistry, resolveVisualizationRuntime } from '../visualization/registry';
import { getTripTimedPath } from '../visualization/trip-data';
import { attachRendererSelectionEnvelope } from './renderer-selection-envelope';
import { rememberTargetSource } from './renderer-target';
import { createPathTarget } from './selection';
import { planAdaptiveCamera } from './planner';
import { projectVisualPrimitiveFootprints } from './geometry/primitives';
import { validateSnapshotEnvelope } from './geometry/envelope';
import type { CameraTarget } from './types';

async function run() {
  const oldJson = dataLoaderRegistry.json;
  dataLoaderRegistry.json = (file) =>
    Promise.resolve(JSON.parse(readFileSync(`assets/${file.url}`, 'utf8')) as CustomObject[]);
  try {
    const viewport = { width: 591, height: 362 };
    const view: CameraView = { longitude: -74, latitude: 40.72, zoom: 13, pitch: 45, bearing: 0 };
    const config = visualizationCatalog.visualizations.find((item) => item.id === 'animated')!;
    const runtime = await resolveVisualizationRuntime(visualizationCatalog, 'animated', {
      params: getVisualizationDefaultParams(config),
      state: { animationTime: 0 },
      viewportSize: viewport,
      clickHandlers: { tripPath: () => true },
    });
    const layer = runtime.resolvedLayers.find((candidate) => candidate.descriptor.layerId === 'trips')!;
    const row = layer.data[928];
    const timedPath = getTripTimedPath(row)!;
    assert.equal(timedPath.coordinates.length, 104, 'fixture is the selected browser trip');
    const target: CameraTarget = { ...createPathTarget(timedPath.coordinates, [row])!, timedPath };
    assert.deepEqual(target.center, [-73.990895, 40.726935]);
    const input = {
      target,
      resolvedLayers: runtime.resolvedLayers,
      expectedProducer: 'trip-path' as const,
      selectionMode: 'click' as const,
      marks: [row],
      referenceView: view,
      viewport,
    };
    const captured = attachRendererSelectionEnvelope(input);
    assert.equal(captured.status, 'attached', captured.detail);
    if (captured.status !== 'attached') return;
    assert.equal(validateSnapshotEnvelope(captured.envelope).status, 'ok');
    assert.equal(captured.envelope.supportGuarantee, 'conservative');
    const corridor = captured.envelope.frame.primitives[0];
    assert.equal(corridor.kind, 'path-corridor');
    if (corridor.kind !== 'path-corridor') return;
    assert.deepEqual(
      corridor.positions.map((position) => position.slice(0, 2)),
      timedPath.coordinates,
      'capture keeps every renderer coordinate, including the offscreen route',
    );
    const originalProjection = projectVisualPrimitiveFootprints([corridor], view, viewport, {
      meterSupportTolerancePx: 0.25,
      meterSupportIntervalBudget: 16_384,
    });
    assert.notEqual(
      originalProjection.status,
      'ok',
      'the full route still fails the original pitched clip-domain check',
    );
    const planned = planAdaptiveCamera({
      cameraName: 'emphasis-tracking',
      target: rememberTargetSource(captured.target, layer),
      currentViewState: view,
      viewportSize: viewport,
    });
    assert.equal(planned.status, 'planned', planned.status === 'no-suggestion' ? planned.reason : '');
    if (planned.status === 'planned') {
      assert.equal(planned.cameraMovement.animationBinding?.pathDigest, timedPath.digest);
      assert.equal(planned.cameraMovement.framingReport?.scope, 'route-window');
      assert.ok(planned.cameraMovement.trajectoryPlan, 'actual renderer capture reaches committed Tracking');
    }
    const shifted = attachRendererSelectionEnvelope({
      ...input,
      referenceView: { ...view, longitude: -73.98, pitch: 60 },
    });
    assert.equal(shifted.status, 'attached', shifted.detail);
    if (shifted.status === 'attached') {
      assert.deepEqual(shifted.envelope.frame.primitives, captured.envelope.frame.primitives);
      assert.deepEqual(
        shifted.envelope.frame.metrics,
        captured.envelope.frame.metrics,
        'full-route reference metrics are independent of the clicked camera crop',
      );
    }
    const illegal = attachRendererSelectionEnvelope({ ...input, referenceView: { ...view, altitude: -1 } });
    assert.equal(illegal.status, 'skipped', 'illegal source camera projections remain rejected');
  } finally {
    dataLoaderRegistry.json = oldJson;
  }
}
void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
