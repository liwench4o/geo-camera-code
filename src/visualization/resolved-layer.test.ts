import { VERSION } from '@deck.gl/core';
import { getVisualizationDefaultParams, visualizationCatalog } from './catalog';
import { STRICT_RENDERER_LIBRARY_VERSION } from './camera-contract';
import {
  getRendererSupportDefaults,
  parseLayerValueReference,
  resolveLayerDescriptor,
  resolveLayerValue,
} from './resolved-layer';
import { dataLoaderRegistry, getAccessorById, layerRegistry, resolveVisualizationRuntime } from './registry';
import type { ResolveLayerDescriptorInput, ResolvedLayerDescriptor } from './types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert(typeof value === 'object' && value !== null && !Array.isArray(value), 'expected an object');
  return value as Record<string, unknown>;
}

function expectThrows(action: () => unknown, expectedFragment: string) {
  try {
    action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.toLowerCase().includes(expectedFragment.toLowerCase()),
      `expected error containing "${expectedFragment}", received "${message}"`,
    );
    return;
  }
  throw new Error(`expected an error containing "${expectedFragment}"`);
}

function expectNamedThrowCases(cases: Array<{ name: string; expectedFragment: string; action: () => unknown }>): void {
  const failures: string[] = [];
  for (const testCase of cases) {
    try {
      testCase.action();
      failures.push(`${testCase.name}: did not throw`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes(testCase.expectedFragment.toLowerCase())) {
        failures.push(`${testCase.name}: expected "${testCase.expectedFragment}", received "${message}"`);
      }
    }
  }
  if (failures.length > 0) throw new Error(failures.join('\n'));
}

function expectNamedNoReadThrowCases(
  cases: Array<{
    name: string;
    expectedFragment: string;
    action: () => unknown;
    reads: () => number;
  }>,
): void {
  const failures: string[] = [];
  for (const testCase of cases) {
    try {
      testCase.action();
      failures.push(`${testCase.name}: did not throw`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes(testCase.expectedFragment.toLowerCase())) {
        failures.push(`${testCase.name}: expected "${testCase.expectedFragment}", received "${message}"`);
      }
    }
    if (testCase.reads() !== 0) {
      failures.push(`${testCase.name}: getter executed ${testCase.reads()} time(s)`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join('\n'));
}

function createInput(visualizationId: string, layerId: string): ResolveLayerDescriptorInput {
  const visualization = clone(
    visualizationCatalog.visualizations.find((candidate) => candidate.id === visualizationId),
  );
  assert(visualization, `missing ${visualizationId} visualization`);
  const layer = visualization.layers.find((candidate) => candidate.id === layerId);
  assert(layer, `missing ${layerId} layer`);
  const dataset = clone(visualizationCatalog.datasets.find((candidate) => candidate.id === visualization.datasetId));
  assert(dataset, `missing ${visualization.datasetId} dataset`);
  const dataFile = dataset.files.find((candidate) => candidate.id === layer.dataRef);
  assert(dataFile, `missing ${layer.dataRef} data file`);

  return {
    catalogRevision: visualizationCatalog.revision,
    visualization,
    dataset,
    dataFile,
    dataRevision: dataFile.revision,
    layer,
    rowCount: 12,
    params: getVisualizationDefaultParams(visualization),
    state: { animationTime: 25 },
    runtimeDerivedSupport: layer.cameraEnvelope.producer === 'hexagon-cell' ? { elevationDomain: [0, 12] } : undefined,
  };
}

function assertDigestChanged(baseline: ResolvedLayerDescriptor, input: ResolveLayerDescriptorInput, label: string) {
  const layerIndex = input.visualization.layers.findIndex((candidate) => candidate.id === input.layer.id);
  assert(layerIndex >= 0, `${label} layer must remain associated with its visualization`);
  input.visualization.layers[layerIndex] = clone(input.layer);
  const changed = resolveLayerDescriptor(input);
  assert(changed.resolvedLayerDigest !== baseline.resolvedLayerDigest, `${label} must change resolvedLayerDigest`);
}

function testDeterministicDescriptorAndRevisionIdentity() {
  const firstInput = createInput('mix', 'scatter');
  const secondInput = clone(firstInput);
  const first = resolveLayerDescriptor(firstInput);
  const second = resolveLayerDescriptor(secondInput);

  assert(first.resolvedLayerDigest === second.resolvedLayerDigest, 'equal semantic inputs need equal digests');
  assert(first.catalogRevision === visualizationCatalog.revision, 'catalog revision must be persisted');
  assert(
    first.visualizationRevision === firstInput.visualization.revision,
    'visualization revision must be persisted independently',
  );
  assert(first.rendererVersion === 1, 'validated renderer version must be persisted');
  assert(first.rendererLibraryVersion === VERSION, 'descriptor must record the runtime deck.gl version');
  assert(
    first.rendererLibraryVersion === STRICT_RENDERER_LIBRARY_VERSION,
    'adapter and runtime deck.gl versions must agree',
  );
}

function testDeclaredPropBindingsArePublicCanonicalAndDigestSensitive() {
  const stateInput = createInput('animated', 'trips');
  const stateDescriptor = resolveLayerDescriptor(stateInput);
  const stateDeclaredProps = stateDescriptor.declaredProps;
  assert(stateDescriptor.resolvedProps.currentTime === 25, 'state binding must resolve currentTime to 25');
  assert(
    JSON.stringify(stateDeclaredProps.currentTime) === JSON.stringify({ state: 'animationTime' }),
    'descriptor must expose the canonical state binding',
  );

  const paramInput = createInput('animated', 'trips');
  paramInput.params.sameTime = 25;
  asRecord(paramInput.layer.props).currentTime = { param: 'sameTime' };
  const paramDescriptor = resolveLayerDescriptor(paramInput);
  const paramDeclaredProps = paramDescriptor.declaredProps;
  assert(paramDescriptor.resolvedProps.currentTime === 25, 'parameter binding must resolve currentTime to 25');
  assert(
    JSON.stringify(paramDeclaredProps.currentTime) === JSON.stringify({ param: 'sameTime' }),
    'descriptor must expose the canonical parameter binding',
  );
  assert(
    stateDescriptor.resolvedLayerDigest !== paramDescriptor.resolvedLayerDigest,
    'equal resolved values with different declared bindings must have different digests',
  );

  const sameBindingDescriptor = resolveLayerDescriptor(clone(paramInput));
  assert(
    sameBindingDescriptor.resolvedLayerDigest === paramDescriptor.resolvedLayerDigest,
    'the same declared binding and value must retain the same digest',
  );

  const reorderedInput = clone(paramInput);
  reorderedInput.layer.props = Object.fromEntries(Object.entries(reorderedInput.layer.props ?? {}).reverse());
  const reorderedDescriptor = resolveLayerDescriptor(reorderedInput);
  assert(
    reorderedDescriptor.resolvedLayerDigest === paramDescriptor.resolvedLayerDigest,
    'declared prop insertion order must be digest-neutral',
  );
  assert(
    JSON.stringify(reorderedDescriptor.declaredProps) === JSON.stringify(paramDeclaredProps),
    'declared prop metadata must use canonical key order',
  );

  const hexDescriptor = resolveLayerDescriptor(createInput('hexagon', 'hexagon-layer'));
  const hexDeclaredProps = hexDescriptor.declaredProps;
  assert(
    !Object.prototype.hasOwnProperty.call(hexDeclaredProps, 'elevationDomain'),
    'runtime-derived support must not be represented as declared bindings',
  );
  assert(
    !Object.prototype.hasOwnProperty.call(hexDescriptor.resolvedProps, 'elevationDomain'),
    'runtime-derived support must not be represented as renderer props',
  );
  assert(
    hexDescriptor.resolvedSupport.producer === 'hexagon-cell' &&
      JSON.stringify(hexDescriptor.resolvedSupport.elevationDomain) === JSON.stringify([0, 12]),
    'runtime-derived support must remain represented by resolved camera support',
  );
}

function testRuntimeSupportDoesNotBecomeRendererProps() {
  const input = createInput('hexagon', 'hexagon-layer');
  input.runtimeDerivedSupport = { elevationDomain: [0, 12] };

  const descriptor = resolveLayerDescriptor(input);
  assert(
    !Object.prototype.hasOwnProperty.call(descriptor.resolvedProps, 'elevationDomain'),
    'camera analytics support must not become a renderer elevationDomain',
  );
  assert(
    descriptor.resolvedSupport.producer === 'hexagon-cell' &&
      JSON.stringify(descriptor.resolvedSupport.elevationDomain) === JSON.stringify([0, 12]),
    'camera analytics support must remain available to the hexagon camera envelope',
  );

  const unknownSupport = createInput('hexagon', 'hexagon-layer');
  unknownSupport.runtimeDerivedSupport = { unexpectedDomain: [0, 12] };
  expectThrows(() => resolveLayerDescriptor(unknownSupport), 'not permitted');

  const unsupportedProducer = createInput('point', 'point-map');
  unsupportedProducer.runtimeDerivedSupport = { elevationDomain: [0, 12] };
  expectThrows(() => resolveLayerDescriptor(unsupportedProducer), 'not permitted');

  const independentRendererDomain = createInput('hexagon', 'hexagon-layer');
  asRecord(independentRendererDomain.layer.props).elevationDomain = [0, 10];
  const independentDescriptor = resolveLayerDescriptor(independentRendererDomain);
  assert(
    JSON.stringify(independentDescriptor.resolvedProps.elevationDomain) === JSON.stringify([0, 10]),
    'an explicit renderer domain must remain independent from camera analytics support',
  );
  assert(
    independentDescriptor.resolvedSupport.producer === 'hexagon-cell' &&
      JSON.stringify(independentDescriptor.resolvedSupport.elevationDomain) === JSON.stringify([0, 12]),
    'camera analytics support must take precedence for camera calculations',
  );

  const explicitRendererDomain = createInput('hexagon', 'hexagon-layer');
  asRecord(explicitRendererDomain.layer.props).elevationDomain = [0, 12];
  const explicitDescriptor = resolveLayerDescriptor(explicitRendererDomain);
  assert(
    JSON.stringify(explicitDescriptor.resolvedProps.elevationDomain) === JSON.stringify([0, 12]),
    'an explicit catalog renderer domain must remain available to deck.gl',
  );
}

function testDigestCommitsEverySupportDependency() {
  const baselineInput = createInput('mix', 'scatter');
  const baseline = resolveLayerDescriptor(baselineInput);

  const radius = clone(baselineInput);
  asRecord(radius.layer.props).getRadius = 2;
  assertDigestChanged(baseline, radius, 'radius');

  const accessor = clone(baselineInput);
  asRecord(accessor.layer.accessors).getPosition = 'coordinates';
  if (accessor.layer.cameraEnvelope.producer !== 'scatter-point') throw new Error('expected scatter envelope');
  accessor.layer.cameraEnvelope.positionAccessor = 'coordinates';
  accessor.layer.selection.coordinateAccessor = 'coordinates';
  assertDigestChanged(baseline, accessor, 'accessor ID');

  const dataRevision = clone(baselineInput);
  dataRevision.dataRevision = 'content-v2';
  assertDigestChanged(baseline, dataRevision, 'data revision');

  const catalogRevision = clone(baselineInput);
  catalogRevision.catalogRevision = 'catalog-v2';
  assertDigestChanged(baseline, catalogRevision, 'catalog revision');

  const visualizationRevision = clone(baselineInput);
  visualizationRevision.visualization.revision = 'mix-v2';
  assertDigestChanged(baseline, visualizationRevision, 'visualization revision');

  const producerVersion = clone(baselineInput);
  producerVersion.layer.cameraEnvelope.producerVersion = 2;
  assertDigestChanged(baseline, producerVersion, 'producer version');

  const supportBuffer = clone(baselineInput);
  supportBuffer.layer.cameraEnvelope.support.antialiasBufferPx += 1;
  assertDigestChanged(baseline, supportBuffer, 'support buffer');

  const calibration = clone(baselineInput);
  calibration.layer.cameraCalibration.metrics.elevation.hi += 1;
  assertDigestChanged(baseline, calibration, 'calibration');

  const hexInput = createInput('hexagon', 'hexagon-layer');
  const hexBaseline = resolveLayerDescriptor(hexInput);
  const coverage = clone(hexInput);
  coverage.params.hexagonCoverage = Number(coverage.params.hexagonCoverage) - 0.1;
  assertDigestChanged(hexBaseline, coverage, 'coverage');

  const heatInput = createInput('mix', 'heat');
  const heatBaseline = resolveLayerDescriptor(heatInput);
  const cutoff = clone(heatInput);
  cutoff.params.heatmapThreshold = Number(cutoff.params.heatmapThreshold) + 0.01;
  assertDigestChanged(heatBaseline, cutoff, 'heatmap cutoff');

  const alphaCutoff = clone(heatInput);
  if (alphaCutoff.layer.cameraEnvelope.producer !== 'heatmap-kernel') throw new Error('expected heat envelope');
  alphaCutoff.layer.cameraEnvelope.support.alphaCutoff = 0.02;
  assertDigestChanged(heatBaseline, alphaCutoff, 'heatmap alpha cutoff');
}

function testDescriptorIsDeeplyImmutable() {
  const descriptor = resolveLayerDescriptor(createInput('animated', 'trips'));
  const objects = [
    descriptor,
    descriptor.declaredProps,
    descriptor.declaredProps.currentTime,
    descriptor.resolvedProps,
    descriptor.accessorIds,
    descriptor.resolvedSupport,
    descriptor.selection,
    descriptor.cameraEnvelope,
    descriptor.cameraEnvelope.support,
    descriptor.cameraCalibration,
    descriptor.cameraCalibration.metrics,
  ];
  assert(
    objects.every((value) => value && Object.isFrozen(value)),
    'descriptor graph must be immutable',
  );
}

function testClosedAdapterAndSealedPropsFailClosed() {
  const unknownVersion = createInput('point', 'point-map');
  unknownVersion.layer.rendererVersion = 999;
  expectThrows(() => resolveLayerDescriptor(unknownVersion), 'adapter');

  const catalogConflict = createInput('point', 'point-map');
  asRecord(catalogConflict.layer.props).billboard = false;
  expectThrows(() => resolveLayerDescriptor(catalogConflict), 'sealed');

  const stateConflict = createInput('point', 'point-map');
  asRecord(stateConflict.layer.props).billboard = { state: 'billboard' };
  stateConflict.state.billboard = false;
  expectThrows(() => resolveLayerDescriptor(stateConflict), 'sealed');

  const runtimeConflict = createInput('point', 'point-map');
  runtimeConflict.runtimeDerivedProps = { billboard: false };
  expectThrows(() => resolveLayerDescriptor(runtimeConflict), 'sealed');

  for (const sealedProp of ['jointRounded', 'capRounded'] as const) {
    const tripsConflict = createInput('animated', 'trips');
    asRecord(tripsConflict.layer.props)[sealedProp] = false;
    expectThrows(() => resolveLayerDescriptor(tripsConflict), 'sealed');
  }
}

function testRenderQueryContractFailsClosed() {
  const unknownQuery = createInput('mix', 'heat');
  unknownQuery.layer.selection.renderQueryId = 'missing-query-v1';
  expectThrows(() => resolveLayerDescriptor(unknownQuery), 'render query');

  const producerMismatch = createInput('mix', 'heat');
  producerMismatch.layer.selection.renderQueryId = 'select-trip-path-v1';
  expectThrows(() => resolveLayerDescriptor(producerMismatch), 'producer');

  const supportedMismatch = createInput('mix', 'heat');
  supportedMismatch.layer.selection.supported = ['click'];
  expectThrows(() => resolveLayerDescriptor(supportedMismatch), 'supported');

  const coordinateAccessorMismatch = createInput('mix', 'heat');
  coordinateAccessorMismatch.layer.selection.coordinateAccessor = 'coordinates';
  expectThrows(() => resolveLayerDescriptor(coordinateAccessorMismatch), 'coordinateAccessor');

  const pathAccessorMismatch = createInput('animated', 'trips');
  pathAccessorMismatch.layer.selection.pathAccessor = 'buildingPolygon';
  expectThrows(() => resolveLayerDescriptor(pathAccessorMismatch), 'pathAccessor');

  const unknownStableAccessor = createInput('mix', 'heat');
  unknownStableAccessor.layer.selection.stableIdAccessor = 'missing-stable-id';
  expectThrows(() => resolveLayerDescriptor(unknownStableAccessor), 'stableIdAccessor');

  const unmodelledLineCoordinateAccessor = createInput('line', 'line-flight-paths');
  unmodelledLineCoordinateAccessor.layer.selection.coordinateAccessor = 'coordinates';
  expectThrows(() => resolveLayerDescriptor(unmodelledLineCoordinateAccessor), 'coordinateAccessor');

  const unmodelledPointPathAccessor = createInput('point', 'point-map');
  unmodelledPointPathAccessor.layer.selection.pathAccessor = 'tripPath';
  expectThrows(() => resolveLayerDescriptor(unmodelledPointPathAccessor), 'pathAccessor');

  const unmodelledTripCoordinateAccessor = createInput('animated', 'trips');
  unmodelledTripCoordinateAccessor.layer.selection.coordinateAccessor = 'lonLat';
  expectThrows(() => resolveLayerDescriptor(unmodelledTripCoordinateAccessor), 'coordinateAccessor');

  const querylessPoint = resolveLayerDescriptor(createInput('point', 'point-map'));
  assert(
    querylessPoint.resolvedSupport.producer === 'scatter-point',
    'scatter-point selection with a coordinate accessor does not require a render query',
  );
}

function testNestedCameraContractSchemasFailClosed() {
  const cases: Array<{ name: string; expectedFragment: string; action: () => unknown }> = [];
  const addCase = (
    name: string,
    expectedFragment: string,
    input: ResolveLayerDescriptorInput,
    mutate: (input: ResolveLayerDescriptorInput) => void,
  ) => {
    mutate(input);
    cases.push({ name, expectedFragment, action: () => resolveLayerDescriptor(input) });
  };

  addCase('selection unknown key', 'selection.schema', createInput('point', 'point-map'), (input) => {
    asRecord(input.layer.selection).unexpectedTransform = 'mercator-offset';
  });
  addCase('selection custom prototype', 'selection.schema', createInput('point', 'point-map'), (input) => {
    input.layer.selection = Object.assign(Object.create({ inherited: true }), input.layer.selection);
  });
  addCase('selection null', 'selection.schema', createInput('point', 'point-map'), (input) => {
    asRecord(input.layer).selection = null;
  });
  addCase('selection missing', 'selection.schema', createInput('point', 'point-map'), (input) => {
    delete asRecord(input.layer).selection;
  });

  addCase('envelope unknown key', 'camera-envelope.schema', createInput('point', 'point-map'), (input) => {
    asRecord(input.layer.cameraEnvelope).unexpectedSupport = true;
  });
  addCase('polygon envelope unknown key', 'camera-envelope.schema', createInput('animated', 'buildings'), (input) => {
    asRecord(input.layer.cameraEnvelope).unexpectedBase = 1;
  });
  addCase('envelope custom prototype', 'camera-envelope.schema', createInput('point', 'point-map'), (input) => {
    input.layer.cameraEnvelope = Object.assign(Object.create({ inherited: true }), input.layer.cameraEnvelope);
  });
  addCase('envelope null', 'camera-envelope.schema', createInput('point', 'point-map'), (input) => {
    asRecord(input.layer).cameraEnvelope = null;
  });
  addCase('envelope missing', 'camera-envelope.schema', createInput('point', 'point-map'), (input) => {
    delete asRecord(input.layer).cameraEnvelope;
  });
  addCase('support unknown key', 'camera-envelope.schema', createInput('mix', 'heat'), (input) => {
    asRecord(input.layer.cameraEnvelope.support).unexpectedBuffer = 1;
  });
  addCase('support custom prototype', 'camera-envelope.schema', createInput('mix', 'heat'), (input) => {
    input.layer.cameraEnvelope.support = Object.assign(
      Object.create({ inherited: true }),
      input.layer.cameraEnvelope.support,
    );
  });
  addCase('capabilities unknown key', 'camera-envelope.schema', createInput('mix', 'heat'), (input) => {
    asRecord(input.layer.cameraEnvelope.capabilities).unexpectedPrediction = true;
  });
  addCase('hex radius unknown key', 'camera-envelope.schema', createInput('hexagon', 'hexagon-layer'), (input) => {
    if (input.layer.cameraEnvelope.producer !== 'hexagon-cell') throw new Error('expected hexagon envelope');
    asRecord(input.layer.cameraEnvelope.radius).unexpectedRadius = 1;
  });
  addCase('hex coverage unknown key', 'camera-envelope.schema', createInput('hexagon', 'hexagon-layer'), (input) => {
    if (input.layer.cameraEnvelope.producer !== 'hexagon-cell') throw new Error('expected hexagon envelope');
    asRecord(input.layer.cameraEnvelope.coverage).unexpectedCoverage = 1;
  });
  addCase('hex elevation unknown key', 'camera-envelope.schema', createInput('hexagon', 'hexagon-layer'), (input) => {
    if (input.layer.cameraEnvelope.producer !== 'hexagon-cell') throw new Error('expected hexagon envelope');
    asRecord(input.layer.cameraEnvelope.elevation).unexpectedElevation = 1;
  });
  addCase('heat radius unknown key', 'camera-envelope.schema', createInput('mix', 'heat'), (input) => {
    if (input.layer.cameraEnvelope.producer !== 'heatmap-kernel') throw new Error('expected heat envelope');
    asRecord(input.layer.cameraEnvelope.radius).unexpectedRadius = 1;
  });
  addCase('scatter radius unknown key', 'camera-envelope.schema', createInput('point', 'point-map'), (input) => {
    if (input.layer.cameraEnvelope.producer !== 'scatter-point') throw new Error('expected scatter envelope');
    asRecord(input.layer.cameraEnvelope.radius).unexpectedRadius = 1;
  });
  addCase('line width unknown key', 'camera-envelope.schema', createInput('line', 'line-flight-paths'), (input) => {
    if (input.layer.cameraEnvelope.producer !== 'line-path') throw new Error('expected line envelope');
    asRecord(input.layer.cameraEnvelope.width).unexpectedWidth = 1;
  });
  addCase('trip width unknown key', 'camera-envelope.schema', createInput('animated', 'trips'), (input) => {
    if (input.layer.cameraEnvelope.producer !== 'trip-path') throw new Error('expected trip envelope');
    asRecord(input.layer.cameraEnvelope.width).unexpectedWidth = 1;
  });

  addCase('calibration unknown key', 'camera-calibration.schema', createInput('point', 'point-map'), (input) => {
    asRecord(input.layer.cameraCalibration).unexpectedCalibration = true;
  });
  addCase('calibration custom prototype', 'camera-calibration.schema', createInput('point', 'point-map'), (input) => {
    input.layer.cameraCalibration = Object.assign(Object.create({ inherited: true }), input.layer.cameraCalibration);
  });
  addCase('calibration null', 'camera-calibration.schema', createInput('point', 'point-map'), (input) => {
    asRecord(input.layer).cameraCalibration = null;
  });
  addCase('calibration missing', 'camera-calibration.schema', createInput('point', 'point-map'), (input) => {
    delete asRecord(input.layer).cameraCalibration;
  });
  addCase('metrics container null', 'camera-calibration.schema', createInput('point', 'point-map'), (input) => {
    asRecord(input.layer.cameraCalibration).metrics = null;
  });
  addCase(
    'metrics container custom prototype',
    'camera-calibration.schema',
    createInput('point', 'point-map'),
    (input) => {
      input.layer.cameraCalibration.metrics = Object.assign(
        Object.create({ inherited: true }),
        input.layer.cameraCalibration.metrics,
      );
    },
  );
  addCase('metric entry unknown key', 'camera-calibration.schema', createInput('point', 'point-map'), (input) => {
    asRecord(input.layer.cameraCalibration.metrics.elevation).unexpectedMetric = true;
  });
  addCase('metric entry custom prototype', 'camera-calibration.schema', createInput('point', 'point-map'), (input) => {
    input.layer.cameraCalibration.metrics.elevation = Object.assign(
      Object.create({ inherited: true }),
      input.layer.cameraCalibration.metrics.elevation,
    );
  });

  expectNamedThrowCases(cases);
}

function testPolygonAdapterRejectsUnrenderedBaseOffset() {
  const baseline = resolveLayerDescriptor(createInput('animated', 'buildings')).resolvedSupport;
  assert(baseline.producer === 'polygon-extrusion', 'expected polygon support');
  assert(baseline.baseMeters === 0, 'Polygon adapter v1 must describe ground-based extrusion.');

  const input = createInput('animated', 'buildings');
  if (input.layer.cameraEnvelope.producer !== 'polygon-extrusion') {
    throw new Error('expected polygon envelope');
  }
  input.layer.cameraEnvelope.baseMeters = 100;
  expectThrows(() => resolveLayerDescriptor(input), 'sealed');
}

function testClosedAdapterRejectsUnmodelledDeckProps() {
  for (const propName of ['modelMatrix', 'coordinateSystem', 'coordinateOrigin', 'diagnostic'] as const) {
    const catalogProp = createInput('point', 'point-map');
    asRecord(catalogProp.layer.props)[propName] =
      propName === 'modelMatrix' ? [1, 0, 0, 1] : propName === 'coordinateOrigin' ? [0, 0, 0] : 'unexpected';
    expectThrows(() => resolveLayerDescriptor(catalogProp), 'not permitted');

    const runtimeProp = createInput('point', 'point-map');
    runtimeProp.runtimeDerivedProps = {
      [propName]:
        propName === 'modelMatrix' ? [1, 0, 0, 1] : propName === 'coordinateOrigin' ? [0, 0, 0] : 'unexpected',
    };
    expectThrows(() => resolveLayerDescriptor(runtimeProp), 'not permitted');
  }

  const unknownAccessorProp = createInput('point', 'point-map');
  asRecord(unknownAccessorProp.layer.accessors).getLineWidth = 'constant1';
  expectThrows(() => resolveLayerDescriptor(unknownAccessorProp), 'not permitted');

  const wrongPositionAccessor = createInput('point', 'point-map');
  asRecord(wrongPositionAccessor.layer.accessors).getPosition = 'lonLat';
  expectThrows(() => resolveLayerDescriptor(wrongPositionAccessor), 'getPosition');

  const trips = resolveLayerDescriptor(createInput('animated', 'trips'));
  assert(trips.accessorIds.getTimestamps === 'tripTimestamps', 'Trips timestamp accessor must remain permitted');
  assert(trips.accessorIds.getColor === 'tripVendorColor', 'Trips color accessor must remain permitted');
}

function testLayerValueReferencesAreExactPlainDataRecords() {
  const invalidCases: Array<{ name: string; expectedFragment: string; action: () => unknown }> = [];

  const paramWithExtraKey = createInput('mix', 'heat');
  asRecord(paramWithExtraKey.layer.props).radiusPixels = {
    param: 'heatmapRadius',
    unexpected: 123,
  };
  invalidCases.push({
    name: 'param reference with extra key',
    expectedFragment: 'reference',
    action: () => resolveLayerDescriptor(paramWithExtraKey),
  });

  const stateWithExtraKey = createInput('animated', 'trips');
  asRecord(stateWithExtraKey.layer.props).currentTime = {
    state: 'animationTime',
    unexpected: true,
  };
  invalidCases.push({
    name: 'state reference with extra key',
    expectedFragment: 'reference',
    action: () => resolveLayerDescriptor(stateWithExtraKey),
  });

  const referenceWithHiddenKey = createInput('mix', 'heat');
  const hiddenReference: Record<string, unknown> = { param: 'heatmapRadius' };
  Object.defineProperty(hiddenReference, 'unexpected', { value: true, enumerable: false });
  asRecord(referenceWithHiddenKey.layer.props).radiusPixels = hiddenReference;
  invalidCases.push({
    name: 'param reference with non-enumerable key',
    expectedFragment: 'plain data',
    action: () => resolveLayerDescriptor(referenceWithHiddenKey),
  });

  const referenceWithSymbol = createInput('mix', 'heat');
  const symbolReference: Record<string, unknown> = { param: 'heatmapRadius' };
  Object.defineProperty(symbolReference, Symbol('unexpected'), { value: true, enumerable: true });
  asRecord(referenceWithSymbol.layer.props).radiusPixels = symbolReference;
  invalidCases.push({
    name: 'param reference with symbol key',
    expectedFragment: 'plain data',
    action: () => resolveLayerDescriptor(referenceWithSymbol),
  });

  const referenceWithCustomPrototype = createInput('mix', 'heat');
  asRecord(referenceWithCustomPrototype.layer.props).radiusPixels = Object.assign(Object.create({ inherited: true }), {
    param: 'heatmapRadius',
  });
  invalidCases.push({
    name: 'param reference with custom prototype',
    expectedFragment: 'plain data',
    action: () => resolveLayerDescriptor(referenceWithCustomPrototype),
  });

  expectNamedThrowCases(invalidCases);

  let referenceReads = 0;
  const referenceWithGetter: Record<string, unknown> = {};
  Object.defineProperty(referenceWithGetter, 'param', {
    enumerable: true,
    get: () => {
      referenceReads += 1;
      return 'heatmapRadius';
    },
  });
  const getterInput = createInput('mix', 'heat');
  asRecord(getterInput.layer.props).radiusPixels = referenceWithGetter;
  expectNamedNoReadThrowCases([
    {
      name: 'param reference getter',
      expectedFragment: 'plain data',
      action: () => resolveLayerDescriptor(getterInput),
      reads: () => referenceReads,
    },
  ]);

  const nullPrototypeReference = Object.assign(Object.create(null), { param: 'heatmapRadius' }) as {
    param: string;
  };
  const parsedReference = parseLayerValueReference(nullPrototypeReference);
  assert(
    parsedReference.kind === 'param' && parsedReference.key === 'heatmapRadius',
    'an exact null-prototype parameter reference must remain supported',
  );

  const literalObject = Object.assign(Object.create(null), { red: 1, green: 2 });
  assert(
    parseLayerValueReference(literalObject).kind === 'object',
    'a plain literal object must not become a reference',
  );
  assert(
    resolveLayerValue(literalObject, {}, {}) === literalObject,
    'a plain literal object must retain literal identity during value resolution',
  );
}

function testResolverPreflightRejectsUnsafeContainersWithoutExecutingGetters() {
  const getterCases: Array<{
    name: string;
    expectedFragment: string;
    action: () => unknown;
    reads: () => number;
  }> = [];

  const addGetterCase = (
    name: string,
    input: ResolveLayerDescriptorInput,
    target: Record<string, unknown>,
    key: string,
    value: unknown,
  ) => {
    let reads = 0;
    Object.defineProperty(target, key, {
      enumerable: true,
      get: () => {
        reads += 1;
        return value;
      },
    });
    getterCases.push({
      name,
      expectedFragment: 'plain data',
      action: () => resolveLayerDescriptor(input),
      reads: () => reads,
    });
  };

  {
    const input = createInput('point', 'point-map');
    const accessors: Record<string, unknown> = {};
    input.layer.accessors = accessors as Record<string, string>;
    addGetterCase('layer accessors getter', input, accessors, 'getPosition', 'coordinates');
  }
  {
    const input = createInput('mix', 'heat');
    const props: Record<string, unknown> = {};
    input.layer.props = props as never;
    addGetterCase('layer props getter', input, props, 'radiusPixels', { param: 'heatmapRadius' });
  }
  {
    const input = createInput('mix', 'heat');
    addGetterCase('params getter', input, input.params, 'heatmapRadius', 30);
  }
  {
    const input = createInput('animated', 'trips');
    addGetterCase('state getter', input, input.state, 'animationTime', 25);
  }
  {
    const input = createInput('hexagon', 'hexagon-layer');
    const runtimeDerivedProps: Record<string, unknown> = {};
    input.runtimeDerivedProps = runtimeDerivedProps;
    addGetterCase('runtime-derived getter', input, runtimeDerivedProps, 'elevationDomain', [0, 12]);
  }
  {
    const input = createInput('hexagon', 'hexagon-layer');
    const runtimeDerivedSupport: Record<string, unknown> = {};
    input.runtimeDerivedSupport = runtimeDerivedSupport;
    addGetterCase('runtime-derived support getter', input, runtimeDerivedSupport, 'elevationDomain', [0, 12]);
  }
  {
    const input = createInput('mix', 'heat');
    const nestedLiteral: Record<string, unknown> = {};
    let reads = 0;
    Object.defineProperty(nestedLiteral, 'nested', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 1;
      },
    });
    asRecord(input.layer.props).radiusPixels = { literal: nestedLiteral };
    getterCases.push({
      name: 'nested literal object getter',
      expectedFragment: 'plain data',
      action: () => resolveLayerDescriptor(input),
      reads: () => reads,
    });
  }

  expectNamedNoReadThrowCases(getterCases);

  const customPrototypeCases: Array<{ name: string; expectedFragment: string; action: () => unknown }> = [];
  const addCustomPrototypeCase = (
    name: string,
    input: ResolveLayerDescriptorInput,
    replace: (container: Record<string, unknown>) => void,
    source: Record<string, unknown>,
  ) => {
    replace(Object.assign(Object.create({ inherited: true }), source));
    customPrototypeCases.push({
      name,
      expectedFragment: 'plain data',
      action: () => resolveLayerDescriptor(input),
    });
  };

  {
    const input = createInput('point', 'point-map');
    addCustomPrototypeCase('layer props custom prototype', input, (value) => (input.layer.props = value as never), {
      ...input.layer.props,
    });
  }
  {
    const input = createInput('point', 'point-map');
    addCustomPrototypeCase(
      'layer accessors custom prototype',
      input,
      (value) => (input.layer.accessors = value as Record<string, string>),
      { ...input.layer.accessors },
    );
  }
  {
    const input = createInput('mix', 'heat');
    addCustomPrototypeCase('params custom prototype', input, (value) => (input.params = value as never), {
      ...input.params,
    });
  }
  {
    const input = createInput('animated', 'trips');
    addCustomPrototypeCase('state custom prototype', input, (value) => (input.state = value), { ...input.state });
  }
  {
    const input = createInput('hexagon', 'hexagon-layer');
    addCustomPrototypeCase('runtime-derived custom prototype', input, (value) => (input.runtimeDerivedProps = value), {
      ...input.runtimeDerivedProps,
    });
  }
  {
    const input = createInput('hexagon', 'hexagon-layer');
    addCustomPrototypeCase(
      'runtime-derived support custom prototype',
      input,
      (value) => (input.runtimeDerivedSupport = value),
      { ...input.runtimeDerivedSupport },
    );
  }

  const hiddenContainerKey = createInput('mix', 'heat');
  Object.defineProperty(hiddenContainerKey.params, 'hidden', { value: 1, enumerable: false });
  customPrototypeCases.push({
    name: 'params non-enumerable property',
    expectedFragment: 'plain data',
    action: () => resolveLayerDescriptor(hiddenContainerKey),
  });

  const symbolContainerKey = createInput('animated', 'trips');
  Object.defineProperty(symbolContainerKey.state, Symbol('hidden'), { value: 1, enumerable: true });
  customPrototypeCases.push({
    name: 'state symbol property',
    expectedFragment: 'plain data',
    action: () => resolveLayerDescriptor(symbolContainerKey),
  });

  const accessorArray = createInput('point', 'point-map');
  accessorArray.layer.accessors = [] as never;
  customPrototypeCases.push({
    name: 'layer accessors array',
    expectedFragment: 'ResolveLayerDescriptorInput.layer.accessors must be a plain data object',
    action: () => resolveLayerDescriptor(accessorArray),
  });

  const runtimeArray = createInput('hexagon', 'hexagon-layer');
  runtimeArray.runtimeDerivedProps = [] as never;
  customPrototypeCases.push({
    name: 'runtime-derived array',
    expectedFragment: 'ResolveLayerDescriptorInput.runtimeDerivedProps must be a plain data object',
    action: () => resolveLayerDescriptor(runtimeArray),
  });

  const runtimeSupportArray = createInput('hexagon', 'hexagon-layer');
  runtimeSupportArray.runtimeDerivedSupport = [] as never;
  customPrototypeCases.push({
    name: 'runtime-derived support array',
    expectedFragment: 'ResolveLayerDescriptorInput.runtimeDerivedSupport must be a plain data object',
    action: () => resolveLayerDescriptor(runtimeSupportArray),
  });

  const nestedLiteralSymbol = createInput('mix', 'heat');
  const nestedLiteralValue: Record<string, unknown> = { value: 1 };
  Object.defineProperty(nestedLiteralValue, Symbol('hidden'), { value: true, enumerable: true });
  asRecord(nestedLiteralSymbol.layer.props).radiusPixels = { literal: nestedLiteralValue };
  customPrototypeCases.push({
    name: 'nested literal object symbol property',
    expectedFragment: 'plain data',
    action: () => resolveLayerDescriptor(nestedLiteralSymbol),
  });

  const unusedParamFunction = createInput('point', 'point-map');
  asRecord(unusedParamFunction.params).unused = () => 1;
  customPrototypeCases.push({
    name: 'unused parameter function',
    expectedFragment: 'plain data',
    action: () => resolveLayerDescriptor(unusedParamFunction),
  });

  const unusedStateSymbol = createInput('point', 'point-map');
  unusedStateSymbol.state.diagnostic = Symbol('diagnostic');
  customPrototypeCases.push({
    name: 'unused state symbol',
    expectedFragment: 'plain data',
    action: () => resolveLayerDescriptor(unusedStateSymbol),
  });

  const unusedStateBigInt = createInput('point', 'point-map');
  unusedStateBigInt.state.diagnostic = BigInt(1);
  customPrototypeCases.push({
    name: 'unused state bigint',
    expectedFragment: 'plain data',
    action: () => resolveLayerDescriptor(unusedStateBigInt),
  });

  const unusedStateNonFinite = createInput('point', 'point-map');
  unusedStateNonFinite.state.diagnostic = Number.POSITIVE_INFINITY;
  customPrototypeCases.push({
    name: 'unused state non-finite number',
    expectedFragment: 'plain data',
    action: () => resolveLayerDescriptor(unusedStateNonFinite),
  });

  const nestedLiteralFunction = createInput('mix', 'heat');
  asRecord(nestedLiteralFunction.layer.props).radiusPixels = { literal: { value: () => 1 } };
  customPrototypeCases.push({
    name: 'nested literal object function',
    expectedFragment: 'plain data',
    action: () => resolveLayerDescriptor(nestedLiteralFunction),
  });

  expectNamedThrowCases(customPrototypeCases);
}

function testDatasetAssociationUsesDeclaredParameterDefault() {
  const defaulted = createInput('hexagon', 'hexagon-layer');
  defaulted.visualization.datasetId = 'bike-parking';
  delete defaulted.params.hexagonDataset;
  const descriptor = resolveLayerDescriptor(defaulted);
  assert(
    descriptor.datasetId === 'road-safety',
    'missing datasetParam input must select the declared parameter default',
  );

  const disallowed = createInput('hexagon', 'hexagon-layer');
  disallowed.params.hexagonDataset = 'unlisted-dataset';
  disallowed.dataset.id = 'unlisted-dataset';
  expectThrows(() => resolveLayerDescriptor(disallowed), 'allowed dataset');
}

function testOmittedRendererAccessorsBecomeExplicitDefaults() {
  const heatAccessor = resolveLayerDescriptor(createInput('mix', 'heat')).resolvedSupport;
  assert(heatAccessor.producer === 'heatmap-kernel', 'expected heatmap support');
  assert(heatAccessor.weightAccessorId === 'gunHeatWeight', 'explicit heat accessor must be preserved');
  assert(heatAccessor.weightDefault === undefined, 'heat support cannot contain both accessor and default');

  const heatDefaultInput = createInput('mix', 'heat');
  delete asRecord(heatDefaultInput.layer.accessors).getWeight;
  if (heatDefaultInput.layer.cameraEnvelope.producer !== 'heatmap-kernel') throw new Error('expected heat envelope');
  delete heatDefaultInput.layer.cameraEnvelope.weightAccessor;
  const heatDefault = resolveLayerDescriptor(heatDefaultInput).resolvedSupport;
  assert(heatDefault.producer === 'heatmap-kernel', 'expected heatmap support');
  assert(heatDefault.weightAccessorId === undefined, 'omitted heat accessor must stay omitted');
  assert(heatDefault.weightDefault === 1, 'deck.gl heat weight default must become explicit');

  const polygonAccessor = resolveLayerDescriptor(createInput('animated', 'buildings')).resolvedSupport;
  assert(polygonAccessor.producer === 'polygon-extrusion', 'expected polygon support');
  assert(polygonAccessor.elevationAccessorId === 'buildingHeight', 'explicit polygon accessor must be preserved');
  assert(
    polygonAccessor.elevationDefaultMeters === undefined,
    'polygon support cannot contain both accessor and default',
  );

  const polygonDefaultInput = createInput('animated', 'buildings');
  delete asRecord(polygonDefaultInput.layer.accessors).getElevation;
  if (polygonDefaultInput.layer.cameraEnvelope.producer !== 'polygon-extrusion') {
    throw new Error('expected polygon envelope');
  }
  delete polygonDefaultInput.layer.cameraEnvelope.elevationAccessor;
  const polygonDefault = resolveLayerDescriptor(polygonDefaultInput).resolvedSupport;
  assert(polygonDefault.producer === 'polygon-extrusion', 'expected polygon support');
  assert(polygonDefault.elevationAccessorId === undefined, 'omitted polygon accessor must stay omitted');
  assert(polygonDefault.elevationDefaultMeters === 1000, 'deck.gl polygon elevation default must become explicit');
}

function testRendererSupportDefaultsMatchCurrentGeometry() {
  assert(
    JSON.stringify(getRendererSupportDefaults('HexagonLayer', 'hexagon-layer', 4)) ===
      JSON.stringify({ extruded: true, elevationRange: [0, 3000], elevationScale: 50 }),
    'hexagon defaults must describe non-empty rendered geometry',
  );
  assert(
    JSON.stringify(getRendererSupportDefaults('HexagonLayer', 'hexagon-layer', 0)) ===
      JSON.stringify({ extruded: true, elevationRange: [0, 3000], elevationScale: 0 }),
    'empty hexagon data must resolve a zero elevation scale',
  );
  assert(
    JSON.stringify(getRendererSupportDefaults('LineLayer', 'line-flight-paths', 4)) ===
      JSON.stringify({ getWidth: 1, widthUnits: 'pixels', widthScale: 1 }),
    'line defaults must be explicit',
  );
  assert(
    JSON.stringify(getRendererSupportDefaults('ScatterplotLayer', 'point-map', 4)) ===
      JSON.stringify({
        getRadius: 100,
        radiusUnits: 'meters',
        radiusScale: 1,
        radiusMinPixels: 2,
        billboard: true,
      }),
    'point-map defaults must be explicit',
  );
  assert(
    JSON.stringify(getRendererSupportDefaults('ScatterplotLayer', 'scatter', 4)) ===
      JSON.stringify({
        getRadius: 1,
        radiusUnits: 'meters',
        radiusScale: 1,
        radiusMinPixels: 2,
        radiusMaxPixels: 5,
        billboard: true,
      }),
    'mix scatter defaults must be explicit',
  );
  assert(
    JSON.stringify(getRendererSupportDefaults('TripsLayer', 'trips', 4)) ===
      JSON.stringify({
        getWidth: 1,
        widthMinPixels: 2,
        widthUnits: 'pixels',
        widthScale: 1,
        billboard: true,
        jointRounded: true,
        capRounded: true,
      }),
    'trips defaults must seal its topology',
  );
  assert(
    JSON.stringify(getRendererSupportDefaults('PolygonLayer', 'buildings', 4)) ===
      JSON.stringify({ extruded: true, elevationScale: 1 }),
    'polygon defaults must be explicit',
  );
}

function testMissingOrInvalidSupportFailsClosed() {
  const missingAccessor = createInput('point', 'point-map');
  if (missingAccessor.layer.cameraEnvelope.producer !== 'scatter-point') throw new Error('expected scatter');
  missingAccessor.layer.cameraEnvelope.positionAccessor = 'missingAccessor';
  expectThrows(() => resolveLayerDescriptor(missingAccessor), 'accessor');

  const nonFinite = createInput('mix', 'heat');
  nonFinite.params.heatmapRadius = Number.NaN;
  expectThrows(() => resolveLayerDescriptor(nonFinite), 'finite');

  const invalidAlphaCutoff = createInput('mix', 'heat');
  if (invalidAlphaCutoff.layer.cameraEnvelope.producer !== 'heatmap-kernel') {
    throw new Error('expected heat envelope');
  }
  invalidAlphaCutoff.layer.cameraEnvelope.support.alphaCutoff = 0;
  expectThrows(() => resolveLayerDescriptor(invalidAlphaCutoff), 'alphaCutoff');

  const wrongUnit = createInput('line', 'line-flight-paths');
  asRecord(wrongUnit.layer.props).widthUnits = 'meters';
  expectThrows(() => resolveLayerDescriptor(wrongUnit), 'unit');

  const missingElevationDomain = createInput('hexagon', 'hexagon-layer');
  delete missingElevationDomain.runtimeDerivedSupport;
  expectThrows(() => resolveLayerDescriptor(missingElevationDomain), 'elevationDomain');
}

function testHexagonKeepsRendererAndAggregatePositionSemanticsSeparate() {
  const descriptor = resolveLayerDescriptor(createInput('hexagon', 'hexagon-layer'));
  const support = descriptor.resolvedSupport;
  assert(support.producer === 'hexagon-cell', 'expected hexagon support');
  assert(descriptor.accessorIds.getPosition === 'lonLat', 'renderer must keep its raw-row position accessor');
  assert(
    support.positionAccessorId === 'hexagonSelectionPosition',
    'strict aggregate support must use the canonical picked-cell accessor',
  );
  assert(
    String(descriptor.accessorIds.getPosition) !== String(support.positionAccessorId),
    'raw rows and aggregate picks deliberately use different position semantics',
  );
}

function testCalibrationRequiresStrictPositiveRanges() {
  const zeroSafeArea = createInput('point', 'point-map');
  zeroSafeArea.layer.cameraCalibration.referenceSafeAreaPx = 0;
  expectThrows(() => resolveLayerDescriptor(zeroSafeArea), 'positive');

  const equalBounds = createInput('point', 'point-map');
  equalBounds.layer.cameraCalibration.metrics.elevation.hi = equalBounds.layer.cameraCalibration.metrics.elevation.lo;
  expectThrows(() => resolveLayerDescriptor(equalBounds), 'strict');

  const missingMetric = createInput('point', 'point-map');
  delete missingMetric.layer.cameraCalibration.metrics.aspect;
  expectThrows(() => resolveLayerDescriptor(missingMetric), 'required');

  const wrongUnit = createInput('point', 'point-map');
  wrongUnit.layer.cameraCalibration.metrics.density.unit = 'meters';
  expectThrows(() => resolveLayerDescriptor(wrongUnit), 'count/km2');
}

function testResolverRejectsInexactOrUnrelatedInputs() {
  const extraKey = createInput('point', 'point-map') as ResolveLayerDescriptorInput & { unexpected?: boolean };
  extraKey.unexpected = true;
  expectThrows(() => resolveLayerDescriptor(extraKey), 'unexpected');

  const mismatchedDataRef = createInput('point', 'point-map');
  mismatchedDataRef.layer.dataRef = 'other-file';
  expectThrows(() => resolveLayerDescriptor(mismatchedDataRef), 'dataFile');

  const unrelatedDataFile = createInput('point', 'point-map');
  unrelatedDataFile.dataFile = { ...unrelatedDataFile.dataFile, url: 'not-the-dataset-file.json' };
  expectThrows(() => resolveLayerDescriptor(unrelatedDataFile), 'dataset');

  const unrelatedDataset = createInput('point', 'point-map');
  unrelatedDataset.dataset = { ...unrelatedDataset.dataset, id: 'unrelated-dataset' };
  expectThrows(() => resolveLayerDescriptor(unrelatedDataset), 'visualization');
}

function testDescriptorSchemaAndDepthBoundaryAreExplicit() {
  const descriptor = resolveLayerDescriptor(createInput('point', 'point-map'));
  const expectedKeys = [
    'accessorIds',
    'cameraCalibration',
    'cameraEnvelope',
    'catalogRevision',
    'dataRevision',
    'datasetId',
    'declaredProps',
    'layerId',
    'layerType',
    'rendererLibraryVersion',
    'rendererVersion',
    'resolvedLayerDigest',
    'resolvedProps',
    'resolvedSupport',
    'schemaVersion',
    'selection',
    'visualizationId',
    'visualizationRevision',
  ];
  assert(
    JSON.stringify(Object.keys(descriptor).sort()) === JSON.stringify(expectedKeys),
    'resolved descriptor must expose exactly the declared schema',
  );

  const withinDepth = createInput('point', 'point-map');
  let nestedWithinLimit: Record<string, unknown> = {};
  const withinLimitRoot = nestedWithinLimit;
  for (let depth = 0; depth < 40; depth += 1) {
    const child: Record<string, unknown> = {};
    nestedWithinLimit.child = child;
    nestedWithinLimit = child;
  }
  withinDepth.state = { diagnostic: withinLimitRoot };
  resolveLayerDescriptor(withinDepth);

  const overdeep = createInput('point', 'point-map');
  let nested: Record<string, unknown> = {};
  const root = nested;
  for (let depth = 0; depth < 80; depth += 1) {
    const child: Record<string, unknown> = {};
    nested.child = child;
    nested = child;
  }
  overdeep.state = { diagnostic: root };
  expectThrows(() => resolveLayerDescriptor(overdeep), 'depth');
}

async function testRendererConsumesDescriptorAndPreviewIsDigestNeutral() {
  const previousJsonLoader = dataLoaderRegistry.json;
  dataLoaderRegistry.json = () => Promise.resolve([{ coordinates: [75.95, 30.85] }]);

  try {
    const visualization = visualizationCatalog.visualizations.find((candidate) => candidate.id === 'point');
    assert(visualization, 'point visualization must exist');
    const runtime = await resolveVisualizationRuntime(visualizationCatalog, 'point', {
      params: getVisualizationDefaultParams(visualization),
      state: {},
      clickHandlers: { lonLatFields: () => true },
    });
    const resolved = runtime.resolvedLayers[0];
    assert(resolved, 'runtime must expose a resolved layer');
    const support = resolved.descriptor.resolvedSupport;
    assert(support.producer === 'scatter-point', 'point layer must resolve scatter support');
    const layer = runtime.layers[0];
    assert(
      layer.props.getPosition === getAccessorById(support.positionAccessorId),
      'renderer and descriptor accessor agree',
    );
    assert(layer.props.getRadius === support.radius.value, 'renderer and descriptor radius agree');
    assert(layer.props.radiusUnits === support.radius.unit, 'renderer and descriptor radius unit agree');
    assert(layer.props.radiusScale === support.radiusScale, 'renderer and descriptor radius scale agree');
    assert(layer.props.radiusMinPixels === support.radiusMinPixels, 'renderer and descriptor min clamp agree');
    assert(layer.props.billboard === support.billboard, 'renderer and descriptor billboard agree');
    assert(
      JSON.stringify(layer.props.getFillColor) === JSON.stringify([155, 40, 0, 255]),
      'point renderer should configure its color through the ScatterplotLayer fill accessor',
    );
    assert(
      JSON.stringify(layer.props.getLineColor) === JSON.stringify([0, 0, 0, 255]),
      'point renderer should leave the ScatterplotLayer line accessor at its default',
    );

    const digest = resolved.descriptor.resolvedLayerDigest;
    const preview = runtime.createLayers({ idPrefix: 'preview-', interactive: false, transitions: false })[0];
    assert(preview.id === 'preview-point-map', 'preview ID prefix should affect only the deck layer');
    assert(preview.props.pickable === false, 'preview interactivity should affect only the deck layer');
    assert(
      runtime.resolvedLayers[0].descriptor.resolvedLayerDigest === digest,
      'preview options must be digest-neutral',
    );
  } finally {
    dataLoaderRegistry.json = previousJsonLoader;
  }
}

function testOptionalRendererPropsPreserveDeckDefaults() {
  const failures: string[] = [];
  for (const [visualizationId, layerId, clamp] of [
    ['point', 'point-map', 'radiusMaxPixels'],
    ['line', 'line-flight-paths', 'widthMaxPixels'],
    ['animated', 'trips', 'widthMaxPixels'],
  ]) {
    const input = createInput(visualizationId, layerId);
    const descriptor = resolveLayerDescriptor(input);
    const context = {
      params: input.params,
      state: input.state,
      clickHandlers: { [input.layer.onClick!]: () => true },
    };
    const layer = layerRegistry[input.layer.type]({ descriptor, data: [] }, input.layer, context);
    if (layer.props[clamp] !== Number.MAX_SAFE_INTEGER)
      failures.push(`${layerId}: omitted ${clamp} must preserve Deck's finite default`);
    if (layerId === 'point-map' && layer.props.filled !== true)
      failures.push("point-map: omitted filled must preserve Deck's visible filled point default");

    input.layer.props = { ...input.layer.props, [clamp]: 12 };
    const clamped = layerRegistry[input.layer.type](
      { descriptor: resolveLayerDescriptor(input), data: [] },
      input.layer,
      context,
    );
    if (clamped.props[clamp] !== 12) failures.push(`${layerId}: explicit pixel clamp must be retained`);
  }
  assert(failures.length === 0, failures.join('\n'));
}

async function testTripsRendererConsumesSealedTopology() {
  const previousJsonLoader = dataLoaderRegistry.json;
  dataLoaderRegistry.json = (file) =>
    Promise.resolve(
      file.id === 'trips'
        ? [
            {
              vendor: 0,
              path: [
                [-74, 40.7],
                [-73.9, 40.8],
              ],
              timestamps: [0, 10],
            },
          ]
        : [
            {
              height: 100,
              polygon: [
                [-74, 40.7],
                [-73.9, 40.7],
                [-73.9, 40.8],
              ],
            },
          ],
    );

  try {
    const visualization = visualizationCatalog.visualizations.find((candidate) => candidate.id === 'animated');
    assert(visualization, 'animated visualization must exist');
    const runtime = await resolveVisualizationRuntime(visualizationCatalog, 'animated', {
      params: getVisualizationDefaultParams(visualization),
      state: { animationTime: 0 },
      clickHandlers: { tripPath: () => true },
    });
    const resolved = runtime.resolvedLayers.find((candidate) => candidate.descriptor.layerId === 'trips');
    assert(resolved, 'trips resolved layer must exist');
    const support = resolved.descriptor.resolvedSupport;
    assert(support.producer === 'trip-path', 'trips must resolve trip support');
    const layer = runtime.layers.find((candidate) => candidate.id === 'trips');
    assert(layer, 'trips deck layer must exist');
    assert(layer.props.billboard === support.billboard, 'trips billboard must come from resolved support');
    assert(layer.props.jointRounded === support.jointRounded, 'trips joins must come from resolved support');
    assert(layer.props.capRounded === support.capRounded, 'trips caps must come from resolved support');
    assert(layer.props.getWidth === support.width.value, 'trips width must come from resolved support');
    assert(layer.props.widthUnits === support.width.unit, 'trips width unit must come from resolved support');
  } finally {
    dataLoaderRegistry.json = previousJsonLoader;
  }
}

async function run() {
  testOptionalRendererPropsPreserveDeckDefaults();
  testDeterministicDescriptorAndRevisionIdentity();
  testDeclaredPropBindingsArePublicCanonicalAndDigestSensitive();
  testRuntimeSupportDoesNotBecomeRendererProps();
  testDigestCommitsEverySupportDependency();
  testDescriptorIsDeeplyImmutable();
  testClosedAdapterAndSealedPropsFailClosed();
  testRenderQueryContractFailsClosed();
  testPolygonAdapterRejectsUnrenderedBaseOffset();
  testLayerValueReferencesAreExactPlainDataRecords();
  testResolverPreflightRejectsUnsafeContainersWithoutExecutingGetters();
  testNestedCameraContractSchemasFailClosed();
  testClosedAdapterRejectsUnmodelledDeckProps();
  testDatasetAssociationUsesDeclaredParameterDefault();
  testOmittedRendererAccessorsBecomeExplicitDefaults();
  testRendererSupportDefaultsMatchCurrentGeometry();
  testMissingOrInvalidSupportFailsClosed();
  testHexagonKeepsRendererAndAggregatePositionSemanticsSeparate();
  testCalibrationRequiresStrictPositiveRanges();
  testResolverRejectsInexactOrUnrelatedInputs();
  testDescriptorSchemaAndDepthBoundaryAreExplicit();
  await testRendererConsumesDescriptorAndPreviewIsDigestNeutral();
  await testTripsRendererConsumesSealedTopology();
}

void run();
