import { getViewStatePreviewMapProps } from './viewStatePreviewMap';
import {
  applyVisualizationCameraConstraints,
  getVisualizationCameraConstraints,
} from '../visualization/camera-constraints';
import { getVisualizationRefreshMode } from './visualizationRefresh';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function expectThrows(run: () => unknown, expectedMessage: string) {
  try {
    run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes(expectedMessage), `expected error containing "${expectedMessage}", received "${message}"`);
    return;
  }
  throw new Error(`expected error containing "${expectedMessage}"`);
}

function testPreviewMapHidesAttributionControl() {
  const constraints = {
    minZoom: 5,
    maxZoom: 15,
    minPitch: 0,
    maxPitch: 60,
  };
  const props = getViewStatePreviewMapProps('initial-view-state', 'carto.darkNoLabels', constraints);

  assert(props.id === 'map-initial-view-state', `expected preview map id, received ${props.id}`);
  assert(props.mapStyle === 'carto.darkNoLabels', `expected map style to pass through, received ${props.mapStyle}`);
  assert(props.attributionControl === false, 'edit view state preview map should hide attribution control');
  assert(props.minZoom === 5 && props.maxZoom === 15, 'preview map should receive the runtime zoom constraints');
  assert(props.minPitch === 0 && props.maxPitch === 60, 'preview map should receive the runtime pitch constraints');
}

function testCameraConstraintsResolveExplicitAndDefaultBounds() {
  const explicit = getVisualizationCameraConstraints({ minZoom: 5, maxZoom: 15, minPitch: 10, maxPitch: 55 });
  assert(explicit.minZoom === 5 && explicit.maxZoom === 15, 'explicit zoom bounds should be preserved');
  assert(explicit.minPitch === 10 && explicit.maxPitch === 55, 'explicit pitch bounds should be preserved');

  const defaults = getVisualizationCameraConstraints({});
  assert(defaults.minZoom === 0 && defaults.maxZoom === 20, 'Deck-compatible default zoom bounds should be explicit');
  assert(defaults.minPitch === 0 && defaults.maxPitch === 60, 'stable MapLibre pitch bounds should be explicit');
}

function testCameraConstraintsOverrideStaleViewBounds() {
  const constrained = applyVisualizationCameraConstraints(
    {
      longitude: -1,
      latitude: 52,
      zoom: 6,
      pitch: 40,
      bearing: 0,
      maxPitch: 85,
    },
    { minZoom: 5, maxZoom: 15, minPitch: 0, maxPitch: 60 },
  );

  assert(constrained.maxPitch === 60, 'runtime constraint should override a stale camera maxPitch');
}

function testCameraConstraintsRejectInvalidBounds() {
  expectThrows(() => getVisualizationCameraConstraints({ maxPitch: Number.NaN }), 'maxPitch');
  expectThrows(() => getVisualizationCameraConstraints({ minZoom: 8, maxZoom: 5 }), 'minZoom');
}

function testViewportChangesRefreshWithoutResettingTheView() {
  assert(
    getVisualizationRefreshMode({ viewportChanged: true, hasVisualizationRuntime: true }) === 'refresh',
    'viewport changes should refresh adaptive runtime data without resetting the current view',
  );
  assert(
    getVisualizationRefreshMode({ viewportChanged: true, hasVisualizationRuntime: false }) === 'none',
    'initial viewport resolution is owned by the runtime request coordinator',
  );
  assert(
    getVisualizationRefreshMode({ visualizationChanged: true, viewportChanged: true }) === 'reset',
    'a visualization change should still reset to the new visualization initial view',
  );
  assert(getVisualizationRefreshMode({}) === 'none', 'unrelated updates should not resolve the runtime again');
}

function run() {
  testPreviewMapHidesAttributionControl();
  testCameraConstraintsResolveExplicitAndDefaultBounds();
  testCameraConstraintsOverrideStaleViewBounds();
  testCameraConstraintsRejectInvalidBounds();
  testViewportChangesRefreshWithoutResettingTheView();
}

run();
