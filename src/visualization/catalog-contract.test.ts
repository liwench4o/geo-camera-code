import { visualizationCatalog } from './catalog';
import {
  HEXAGON_SELECTION_POSITION_ACCESSOR_ID,
  STRICT_RENDERER_LIBRARY_VERSION,
  findRendererAdapterContract,
  getRenderQueryContract,
  isKnownRenderQueryId,
  renderQueryContracts,
  rendererAdapterContracts,
} from './camera-contract';
import { accessorRegistry, validateVisualizationCatalog } from './registry';
import type { VisualizationCatalog } from './types';

type MutableRecord = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown, label: string): MutableRecord {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value as MutableRecord;
}

function records(value: unknown, label: string): MutableRecord[] {
  assert(Array.isArray(value), `${label} must be an array`);
  return value.map((item, index) => record(item, `${label}[${index}]`));
}

function cloneCatalog(): MutableRecord {
  return JSON.parse(JSON.stringify(visualizationCatalog)) as MutableRecord;
}

function findById(items: unknown, id: string, label: string): MutableRecord {
  const item = records(items, label).find((candidate) => candidate.id === id);
  assert(item, `${label} must contain ${id}`);
  return item;
}

function visualization(catalog: MutableRecord, id: string): MutableRecord {
  return findById(catalog.visualizations, id, 'visualizations');
}

function layer(catalog: MutableRecord, visualizationId: string, layerId: string): MutableRecord {
  return findById(visualization(catalog, visualizationId).layers, layerId, `${visualizationId}.layers`);
}

function parameter(catalog: MutableRecord, visualizationId: string, parameterKey: string): MutableRecord {
  const parameters = records(visualization(catalog, visualizationId).parameters, `${visualizationId}.parameters`);
  const result = parameters.find((candidate) => candidate.key === parameterKey);
  assert(result, `${visualizationId}.parameters must contain ${parameterKey}`);
  return result;
}

function errorsFor(catalog: MutableRecord): string[] {
  return validateVisualizationCatalog(catalog as unknown as VisualizationCatalog);
}

function expectNamedError(name: string, expectedCode: string, mutate: (catalog: MutableRecord) => void): void {
  const catalog = cloneCatalog();
  mutate(catalog);
  const errors = errorsFor(catalog);
  assert(
    errors.some((error) => error.includes(`[${expectedCode}]`)),
    `${name}: expected [${expectedCode}], received ${JSON.stringify(errors)}`,
  );
}

function expectNamedErrorCases(
  cases: Array<{ name: string; expectedCode: string; mutate: (catalog: MutableRecord) => void }>,
): void {
  const failures: string[] = [];
  for (const testCase of cases) {
    const catalog = cloneCatalog();
    testCase.mutate(catalog);
    let errors: string[];
    try {
      errors = errorsFor(catalog);
    } catch (error) {
      failures.push(`${testCase.name}: threw ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!errors.some((error) => error.includes(`[${testCase.expectedCode}]`))) {
      failures.push(`${testCase.name}: expected [${testCase.expectedCode}], received ${JSON.stringify(errors)}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join('\n'));
}

function testRealCatalogSatisfiesCameraContract(): void {
  const errors = validateVisualizationCatalog(visualizationCatalog);
  assert(errors.length === 0, `real visualization catalog must be valid: ${errors.join('\n')}`);
  assert(
    layer(record(visualizationCatalog, 'catalog'), 'point', 'point-map').onClick === 'lonLatFields',
    'real point-map must wire click selection through the coordinate-aware handler',
  );
}

function testCycleFreeContractRegistryIsClosedAndImmutable(): void {
  assert(STRICT_RENDERER_LIBRARY_VERSION === '9.3.2', 'strict adapter v1 must pin deck.gl 9.3.2');
  assert(rendererAdapterContracts.length === 6, 'strict adapter v1 must expose exactly six renderer tuples');
  assert(
    HEXAGON_SELECTION_POSITION_ACCESSOR_ID === 'hexagonSelectionPosition',
    'hexagon query and producer must share one accessor ID',
  );
  assert(Object.isFrozen(rendererAdapterContracts), 'renderer adapter registry must be frozen');
  assert(
    rendererAdapterContracts.every(
      (contract) =>
        Object.isFrozen(contract) &&
        Object.isFrozen(contract.permittedResolvedProps) &&
        Object.isFrozen(contract.permittedAccessorProps) &&
        Object.isFrozen(contract.sealedProps) &&
        Object.isFrozen(contract.sealedEnvelopeProps),
    ),
    'renderer adapter contracts, prop allowlists, and sealed props must be frozen',
  );
  assert(
    findRendererAdapterContract('ScatterplotLayer', 'scatter-point', 1)?.sealedProps.billboard === true,
    'Scatter adapter v1 must seal billboard=true',
  );
  const heatDefaults = findRendererAdapterContract('HeatmapLayer', 'heatmap-kernel', 1)?.accessorDefaults;
  const polygonDefaults = findRendererAdapterContract('PolygonLayer', 'polygon-extrusion', 1)?.accessorDefaults;
  assert(heatDefaults?.getWeight === 1, 'Heatmap optional getWeight must use the sealed deck default');
  assert(polygonDefaults?.getElevation === 1000, 'Polygon optional getElevation must use the sealed deck default');
  assert(isKnownRenderQueryId('select-hexagon-cell-v1'), 'hexagon query v1 must be registered');
  assert(
    getRenderQueryContract('select-hexagon-cell-v1')?.markKind === 'hexagon-cell' &&
      getRenderQueryContract('select-hexagon-cell-v1')?.snapshotSchemaVersion === 1,
    'hexagon query must seal its snapshot schema and mark kind',
  );
  assert(
    renderQueryContracts['select-heatmap-zone-v1'].certificationKind === 'heatmap-halo-complete-v1' &&
      renderQueryContracts['select-heatmap-zone-v1'].minimumHalo === 'resolved-kernel-radius-pixels',
    'heatmap query must seal complete resolved-kernel halo evidence',
  );
  assert(!isKnownRenderQueryId('select-hexagon-cell-v2'), 'unknown query versions must fail closed');
}

function testRequiredPlanMutationsHaveNamedErrors(): void {
  expectNamedError('Hexagon pixels', 'camera-envelope.unit', (catalog) => {
    const envelope = record(layer(catalog, 'hexagon', 'hexagon-layer').cameraEnvelope, 'hexagon cameraEnvelope');
    record(envelope.radius, 'hexagon radius').unit = 'pixels';
  });
  expectNamedError('Heatmap meters', 'camera-envelope.unit', (catalog) => {
    const envelope = record(layer(catalog, 'mix', 'heat').cameraEnvelope, 'heat cameraEnvelope');
    record(envelope.radius, 'heat radius').unit = 'meters';
  });
  expectNamedError('Point selection required', 'selection.required', (catalog) => {
    layer(catalog, 'point', 'point-map').selection = undefined;
  });
  expectNamedError('Producer must be registered', 'camera-envelope.producer', (catalog) => {
    record(layer(catalog, 'line', 'line-flight-paths').cameraEnvelope, 'line cameraEnvelope').producer =
      'missing-producer';
  });
  expectNamedError('Heat alpha cutoff', 'camera-envelope.alpha-cutoff', (catalog) => {
    const envelope = record(layer(catalog, 'mix', 'heat').cameraEnvelope, 'heat cameraEnvelope');
    record(envelope.support, 'heat support').alphaCutoff = 0;
  });
  expectNamedError('Calibration range', 'camera-calibration.range', (catalog) => {
    const calibration = record(layer(catalog, 'mix', 'heat').cameraCalibration, 'heat calibration');
    const elevation = record(record(calibration.metrics, 'heat metrics').elevation, 'heat elevation');
    elevation.lo = elevation.hi;
  });
  expectNamedError('Renderer version', 'renderer-adapter.version', (catalog) => {
    layer(catalog, 'point', 'point-map').rendererVersion = 999;
  });
  expectNamedError('Scatter billboard is sealed', 'renderer-adapter.sealed-prop', (catalog) => {
    record(layer(catalog, 'point', 'point-map').props, 'point props').billboard = false;
  });
  expectNamedError('Trips joins are sealed', 'renderer-adapter.sealed-prop', (catalog) => {
    record(layer(catalog, 'animated', 'trips').props, 'trip props').jointRounded = false;
  });
}

function testRevisionAndCalibrationFailuresAreNamed(): void {
  expectNamedError('Catalog revision', 'revision.required', (catalog) => {
    catalog.revision = '';
  });
  expectNamedError('Visualization revision', 'revision.required', (catalog) => {
    visualization(catalog, 'point').revision = undefined;
  });
  expectNamedError('Dataset revision', 'revision.required', (catalog) => {
    findById(catalog.datasets, 'airports', 'datasets').revision = '   ';
  });
  expectNamedError('File revision', 'revision.required', (catalog) => {
    const dataset = findById(catalog.datasets, 'airports', 'datasets');
    findById(dataset.files, 'points', 'airports.files').revision = undefined;
  });
  expectNamedError('Required density calibration', 'camera-calibration.metric', (catalog) => {
    const calibration = record(layer(catalog, 'point', 'point-map').cameraCalibration, 'point calibration');
    record(calibration.metrics, 'point metrics').density = undefined;
  });
  expectNamedError('Finite reference zoom', 'camera-calibration.number', (catalog) => {
    record(layer(catalog, 'point', 'point-map').cameraCalibration, 'point calibration').referenceZoom =
      Number.POSITIVE_INFINITY;
  });
}

function testSelectionAndAdapterFailuresAreNamed(): void {
  expectNamedError('Unknown query', 'selection.query', (catalog) => {
    record(layer(catalog, 'line', 'line-flight-paths').selection, 'line selection').renderQueryId = 'unknown-query';
  });
  expectNamedError('Unknown selection accessor', 'selection.accessor', (catalog) => {
    record(layer(catalog, 'point', 'point-map').selection, 'point selection').coordinateAccessor = 'missing-coordinate';
  });
  expectNamedError('Click requires a binding', 'selection.binding', (catalog) => {
    const selection = record(layer(catalog, 'point', 'point-map').selection, 'point selection');
    selection.coordinateAccessor = undefined;
    selection.pathAccessor = undefined;
    selection.renderQueryId = undefined;
  });
  expectNamedError('Duplicate selection mode', 'selection.supported', (catalog) => {
    record(layer(catalog, 'point', 'point-map').selection, 'point selection').supported = ['click', 'click'];
  });
  expectNamedError('Query modes are supported', 'selection.query', (catalog) => {
    record(layer(catalog, 'mix', 'heat').selection, 'heat selection').supported = ['click'];
  });
  expectNamedError('Unmodelled deck props are rejected', 'renderer-adapter.prop', (catalog) => {
    record(layer(catalog, 'point', 'point-map').props, 'point props').modelMatrix = [1, 0, 0, 1];
  });
  expectNamedError('Unmodelled deck accessors are rejected', 'renderer-adapter.accessor', (catalog) => {
    record(layer(catalog, 'point', 'point-map').accessors, 'point accessors').getLineWidth = 'constant1';
  });
  expectNamedError('Producer and layer type must match', 'renderer-adapter.tuple', (catalog) => {
    record(layer(catalog, 'point', 'point-map').cameraEnvelope, 'point cameraEnvelope').producer = 'heatmap-kernel';
  });
  expectNamedError('Sealed props cannot be dynamic', 'renderer-adapter.sealed-prop', (catalog) => {
    record(layer(catalog, 'point', 'point-map').props, 'point props').billboard = { param: 'billboard' };
  });
  expectNamedError('Point selection coordinate matches renderer support', 'selection.accessor-mismatch', (catalog) => {
    record(layer(catalog, 'point', 'point-map').selection, 'point selection').coordinateAccessor = 'lonLat';
  });
  expectNamedError('Trips selection path matches renderer support', 'selection.accessor-mismatch', (catalog) => {
    record(layer(catalog, 'animated', 'trips').selection, 'trip selection').pathAccessor = 'tripTimestamps';
  });
  expectNamedError('Point selection cannot declare a path accessor', 'selection.accessor-mismatch', (catalog) => {
    record(layer(catalog, 'point', 'point-map').selection, 'point selection').pathAccessor = 'tripPath';
  });
  expectNamedError('Trip selection cannot declare a coordinate accessor', 'selection.accessor-mismatch', (catalog) => {
    record(layer(catalog, 'animated', 'trips').selection, 'trip selection').coordinateAccessor = 'lonLat';
  });
  for (const inheritedAccessor of ['toString', '__proto__']) {
    expectNamedError(`Inherited accessor ${inheritedAccessor} is rejected`, 'selection.accessor', (catalog) => {
      const point = layer(catalog, 'point', 'point-map');
      record(point.accessors, 'point accessors').getPosition = inheritedAccessor;
      record(point.selection, 'point selection').coordinateAccessor = inheritedAccessor;
      record(point.cameraEnvelope, 'point envelope').positionAccessor = inheritedAccessor;
    });
  }
}

function testNestedCameraContractSchemasAreExact(): void {
  const cases: Array<{
    name: string;
    expectedCode: string;
    mutate: (catalog: MutableRecord) => void;
  }> = [
    {
      name: 'selection unknown key',
      expectedCode: 'selection.schema',
      mutate: (catalog) => {
        record(layer(catalog, 'point', 'point-map').selection, 'point selection').unexpectedTransform = true;
      },
    },
    {
      name: 'selection custom prototype',
      expectedCode: 'catalog.shape',
      mutate: (catalog) => {
        const point = layer(catalog, 'point', 'point-map');
        point.selection = Object.assign(Object.create({ inherited: true }), point.selection);
      },
    },
    {
      name: 'selection null',
      expectedCode: 'selection.schema',
      mutate: (catalog) => {
        layer(catalog, 'point', 'point-map').selection = null;
      },
    },
    {
      name: 'selection missing',
      expectedCode: 'selection.schema',
      mutate: (catalog) => {
        delete layer(catalog, 'point', 'point-map').selection;
      },
    },
    {
      name: 'envelope unknown key',
      expectedCode: 'camera-envelope.schema',
      mutate: (catalog) => {
        record(layer(catalog, 'point', 'point-map').cameraEnvelope, 'point envelope').unexpectedSupport = true;
      },
    },
    {
      name: 'polygon envelope unknown key',
      expectedCode: 'camera-envelope.schema',
      mutate: (catalog) => {
        record(layer(catalog, 'animated', 'buildings').cameraEnvelope, 'building envelope').unexpectedBase = 1;
      },
    },
    {
      name: 'envelope custom prototype',
      expectedCode: 'catalog.shape',
      mutate: (catalog) => {
        const point = layer(catalog, 'point', 'point-map');
        point.cameraEnvelope = Object.assign(Object.create({ inherited: true }), point.cameraEnvelope);
      },
    },
    {
      name: 'envelope null',
      expectedCode: 'camera-envelope.schema',
      mutate: (catalog) => {
        layer(catalog, 'point', 'point-map').cameraEnvelope = null;
      },
    },
    {
      name: 'envelope missing',
      expectedCode: 'camera-envelope.schema',
      mutate: (catalog) => {
        delete layer(catalog, 'point', 'point-map').cameraEnvelope;
      },
    },
    {
      name: 'support unknown key',
      expectedCode: 'camera-envelope.schema',
      mutate: (catalog) => {
        const envelope = record(layer(catalog, 'mix', 'heat').cameraEnvelope, 'heat envelope');
        record(envelope.support, 'heat support').unexpectedBuffer = 1;
      },
    },
    {
      name: 'capabilities unknown key',
      expectedCode: 'camera-envelope.schema',
      mutate: (catalog) => {
        const envelope = record(layer(catalog, 'mix', 'heat').cameraEnvelope, 'heat envelope');
        record(envelope.capabilities, 'heat capabilities').unexpectedPrediction = true;
      },
    },
    {
      name: 'hex radius unknown key',
      expectedCode: 'camera-envelope.schema',
      mutate: (catalog) => {
        const envelope = record(layer(catalog, 'hexagon', 'hexagon-layer').cameraEnvelope, 'hex envelope');
        record(envelope.radius, 'hex radius').unexpectedRadius = 1;
      },
    },
    {
      name: 'hex coverage unknown key',
      expectedCode: 'camera-envelope.schema',
      mutate: (catalog) => {
        const envelope = record(layer(catalog, 'hexagon', 'hexagon-layer').cameraEnvelope, 'hex envelope');
        record(envelope.coverage, 'hex coverage').unexpectedCoverage = 1;
      },
    },
    {
      name: 'hex elevation unknown key',
      expectedCode: 'camera-envelope.schema',
      mutate: (catalog) => {
        const envelope = record(layer(catalog, 'hexagon', 'hexagon-layer').cameraEnvelope, 'hex envelope');
        record(envelope.elevation, 'hex elevation').unexpectedElevation = 1;
      },
    },
    {
      name: 'heat radius unknown key',
      expectedCode: 'camera-envelope.schema',
      mutate: (catalog) => {
        const envelope = record(layer(catalog, 'mix', 'heat').cameraEnvelope, 'heat envelope');
        record(envelope.radius, 'heat radius').unexpectedRadius = 1;
      },
    },
    {
      name: 'scatter radius unknown key',
      expectedCode: 'camera-envelope.schema',
      mutate: (catalog) => {
        const envelope = record(layer(catalog, 'point', 'point-map').cameraEnvelope, 'point envelope');
        record(envelope.radius, 'point radius').unexpectedRadius = 1;
      },
    },
    {
      name: 'line width unknown key',
      expectedCode: 'camera-envelope.schema',
      mutate: (catalog) => {
        const envelope = record(layer(catalog, 'line', 'line-flight-paths').cameraEnvelope, 'line envelope');
        record(envelope.width, 'line width').unexpectedWidth = 1;
      },
    },
    {
      name: 'trip width unknown key',
      expectedCode: 'camera-envelope.schema',
      mutate: (catalog) => {
        const envelope = record(layer(catalog, 'animated', 'trips').cameraEnvelope, 'trip envelope');
        record(envelope.width, 'trip width').unexpectedWidth = 1;
      },
    },
    {
      name: 'calibration unknown key',
      expectedCode: 'camera-calibration.schema',
      mutate: (catalog) => {
        record(layer(catalog, 'point', 'point-map').cameraCalibration, 'point calibration').unexpected = true;
      },
    },
    {
      name: 'calibration custom prototype',
      expectedCode: 'catalog.shape',
      mutate: (catalog) => {
        const point = layer(catalog, 'point', 'point-map');
        point.cameraCalibration = Object.assign(Object.create({ inherited: true }), point.cameraCalibration);
      },
    },
    {
      name: 'calibration null',
      expectedCode: 'camera-calibration.schema',
      mutate: (catalog) => {
        layer(catalog, 'point', 'point-map').cameraCalibration = null;
      },
    },
    {
      name: 'calibration missing',
      expectedCode: 'camera-calibration.schema',
      mutate: (catalog) => {
        delete layer(catalog, 'point', 'point-map').cameraCalibration;
      },
    },
    {
      name: 'metrics container null',
      expectedCode: 'camera-calibration.schema',
      mutate: (catalog) => {
        const calibration = record(layer(catalog, 'point', 'point-map').cameraCalibration, 'point calibration');
        calibration.metrics = null;
      },
    },
    {
      name: 'metrics container custom prototype',
      expectedCode: 'catalog.shape',
      mutate: (catalog) => {
        const calibration = record(layer(catalog, 'point', 'point-map').cameraCalibration, 'point calibration');
        calibration.metrics = Object.assign(Object.create({ inherited: true }), calibration.metrics);
      },
    },
    {
      name: 'metric entry unknown key',
      expectedCode: 'camera-calibration.schema',
      mutate: (catalog) => {
        const calibration = record(layer(catalog, 'point', 'point-map').cameraCalibration, 'point calibration');
        const elevation = record(record(calibration.metrics, 'metrics').elevation, 'elevation metric');
        elevation.unexpectedMetric = true;
      },
    },
  ];

  expectNamedErrorCases(cases);
}

function testPolygonAdapterRejectsUnrenderedBaseOffset(): void {
  expectNamedError('Polygon base offset is sealed to ground', 'renderer-adapter.sealed-envelope', (catalog) => {
    record(layer(catalog, 'animated', 'buildings').cameraEnvelope, 'building envelope').baseMeters = 100;
  });
}

function testOptionalRendererDependenciesAreBidirectional(): void {
  expectNamedError('Heatmap renderer weight requires envelope weight', 'camera-envelope.dependency', (catalog) => {
    record(layer(catalog, 'mix', 'heat').cameraEnvelope, 'heat envelope').weightAccessor = undefined;
  });
  expectNamedError(
    'Polygon renderer elevation requires envelope elevation',
    'camera-envelope.dependency',
    (catalog) => {
      record(layer(catalog, 'animated', 'buildings').cameraEnvelope, 'building envelope').elevationAccessor = undefined;
    },
  );
}

function testCameraNumericParameterSchemasFailClosed(): void {
  expectNamedError('Hexagon coverage literal is bounded', 'camera-envelope.number', (catalog) => {
    record(layer(catalog, 'hexagon', 'hexagon-layer').props, 'hexagon props').coverage = 1.01;
  });
  expectNamedError('Hexagon coverage default is numeric', 'catalog.parameter-schema', (catalog) => {
    parameter(catalog, 'hexagon', 'hexagonCoverage').default = false;
  });
  expectNamedError('Hexagon radius default is numeric', 'catalog.parameter-schema', (catalog) => {
    parameter(catalog, 'hexagon', 'hexagonRadius').default = false;
  });
  expectNamedError('Hexagon radius default is finite', 'catalog.parameter-schema', (catalog) => {
    parameter(catalog, 'hexagon', 'hexagonRadius').default = Number.NaN;
  });
  expectNamedError('Heatmap intensity literal is finite', 'camera-envelope.number', (catalog) => {
    record(layer(catalog, 'mix', 'heat').props, 'heat props').intensity = Number.NaN;
  });
  expectNamedError('Heatmap intensity parameter is numeric', 'catalog.parameter-schema', (catalog) => {
    parameter(catalog, 'mix', 'heatmapIntensity').default = false;
  });
  expectNamedError('Heatmap threshold parameter stays in shader range', 'catalog.parameter-schema', (catalog) => {
    parameter(catalog, 'mix', 'heatmapThreshold').max = 2;
  });
  expectNamedError('Hexagon percentile parameter is numeric', 'catalog.parameter-schema', (catalog) => {
    parameter(catalog, 'hexagon', 'hexagonUpperPercentile').default = false;
  });
  expectNamedError('Param precedence rejects conflicting state', 'camera-envelope.reference-shape', (catalog) => {
    record(layer(catalog, 'mix', 'heat').props, 'heat props').radiusPixels = {
      param: 3,
      state: 'missing-runtime-state',
    };
  });
  expectNamedError('Numeric support rejects switch parameters', 'catalog.parameter-schema', (catalog) => {
    parameter(catalog, 'mix', 'heatmapRadius').control = 'switch';
  });
  expectNamedError('Numeric select options are all finite', 'catalog.parameter-schema', (catalog) => {
    const radius = parameter(catalog, 'mix', 'heatmapRadius');
    radius.control = 'select';
    radius.options = [
      { label: 'Thirty', value: 30 },
      { label: 'Invalid', value: 'wide' },
    ];
  });
  expectNamedError('Numeric select default exists in options', 'catalog.parameter-schema', (catalog) => {
    const radius = parameter(catalog, 'mix', 'heatmapRadius');
    radius.control = 'select';
    radius.options = [
      { label: 'Twenty', value: 20 },
      { label: 'Forty', value: 40 },
    ];
  });
}

function testParameterBackedPixelClampsStayOrdered(): void {
  expectNamedError('Parameter clamp defaults stay ordered', 'camera-envelope.range', (catalog) => {
    const props = record(layer(catalog, 'mix', 'scatter').props, 'scatter props');
    props.radiusMinPixels = { param: 'heatmapRadius' };
    props.radiusMaxPixels = { param: 'heatmapIntensity' };
  });
  expectNamedError('Parameter clamp domains cannot cross', 'camera-envelope.range', (catalog) => {
    const props = record(layer(catalog, 'mix', 'scatter').props, 'scatter props');
    props.radiusMinPixels = { param: 'heatmapIntensity' };
    props.radiusMaxPixels = { param: 'heatmapRadius' };
  });
}

function testEveryCalibrationMetricEntryIsValidated(): void {
  expectNamedError('Extra calibration metric is an object', 'camera-calibration.metric', (catalog) => {
    const calibration = record(layer(catalog, 'point', 'point-map').cameraCalibration, 'point calibration');
    record(calibration.metrics, 'point metrics').custom = 'not-a-metric';
  });
  expectNamedError('Extra calibration metric unit is nonempty', 'camera-calibration.metric', (catalog) => {
    const calibration = record(layer(catalog, 'point', 'point-map').cameraCalibration, 'point calibration');
    record(calibration.metrics, 'point metrics').custom = { unit: '', lo: 0, hi: 1, source: 'fixture' };
  });
  expectNamedError('Extra calibration metric source is nonempty', 'camera-calibration.metric', (catalog) => {
    const calibration = record(layer(catalog, 'point', 'point-map').cameraCalibration, 'point calibration');
    record(calibration.metrics, 'point metrics').custom = { unit: 'score', lo: 0, hi: 1, source: ' ' };
  });
  expectNamedError('Extra calibration metric range is finite', 'camera-calibration.range', (catalog) => {
    const calibration = record(layer(catalog, 'point', 'point-map').cameraCalibration, 'point calibration');
    record(calibration.metrics, 'point metrics').custom = {
      unit: 'score',
      lo: 0,
      hi: Number.POSITIVE_INFINITY,
      source: 'fixture',
    };
  });
}

function testSupportCapabilitiesAndReferencesFailClosed(): void {
  expectNamedError('AA buffer is non-negative', 'camera-envelope.support', (catalog) => {
    const envelope = record(layer(catalog, 'mix', 'heat').cameraEnvelope, 'heat cameraEnvelope');
    record(envelope.support, 'heat support').antialiasBufferPx = -1;
  });
  expectNamedError('Static producer cannot predict', 'camera-envelope.capability', (catalog) => {
    const envelope = record(layer(catalog, 'mix', 'heat').cameraEnvelope, 'heat cameraEnvelope');
    const capabilities = record(envelope.capabilities, 'heat capabilities');
    capabilities.supportsPrediction = true;
    capabilities.supportsLive = false;
    capabilities.maxPredictionHorizonMs = 0;
  });
  expectNamedError('Nominal update rate is positive', 'camera-envelope.capability', (catalog) => {
    const envelope = record(layer(catalog, 'mix', 'heat').cameraEnvelope, 'heat cameraEnvelope');
    record(envelope.capabilities, 'heat capabilities').nominalUpdateHz = 0;
  });
  expectNamedError('Envelope accessor is registered', 'camera-envelope.reference', (catalog) => {
    record(layer(catalog, 'hexagon', 'hexagon-layer').cameraEnvelope, 'hexagon cameraEnvelope').positionAccessor =
      'missing-position';
  });
  expectNamedError('Hexagon renderer radius matches envelope radius', 'camera-envelope.reference', (catalog) => {
    record(layer(catalog, 'hexagon', 'hexagon-layer').props, 'hexagon props').radius = {
      param: 'hexagonCoverage',
    };
  });
  expectNamedError(
    'Pixel clamp prop names are sealed by the producer schema',
    'camera-envelope.reference',
    (catalog) => {
      record(layer(catalog, 'point', 'point-map').cameraEnvelope, 'point cameraEnvelope').minPixelsProp =
        'missingMinPixels';
    },
  );
  expectNamedError('Line support stays in pixels', 'camera-envelope.unit', (catalog) => {
    record(layer(catalog, 'line', 'line-flight-paths').props, 'line props').widthUnits = 'meters';
  });
  expectNamedError('Pixel clamps remain ordered', 'camera-envelope.range', (catalog) => {
    const props = record(layer(catalog, 'mix', 'scatter').props, 'scatter props');
    props.radiusMinPixels = 6;
    props.radiusMaxPixels = 5;
  });
  expectNamedError('Polygon renderer scale matches envelope scale', 'camera-envelope.reference', (catalog) => {
    record(layer(catalog, 'animated', 'buildings').props, 'building props').elevationScale = 2;
  });
  expectNamedError('Layer parameter references are known', 'catalog.parameter', (catalog) => {
    record(layer(catalog, 'mix', 'heat').props, 'heat props').radiusPixels = { param: 'missing-parameter' };
  });
  expectNamedError('Hexagon elevation scale resolves to a number', 'camera-envelope.number', (catalog) => {
    record(layer(catalog, 'hexagon', 'hexagon-layer').props, 'hexagon props').elevationScale = 'bad';
  });
  expectNamedError('Hexagon elevation range is a finite tuple', 'camera-envelope.number', (catalog) => {
    record(layer(catalog, 'hexagon', 'hexagon-layer').props, 'hexagon props').elevationRange = ['bad', 3000];
  });
  expectNamedError('Hexagon elevation range is ordered', 'camera-envelope.range', (catalog) => {
    record(layer(catalog, 'hexagon', 'hexagon-layer').props, 'hexagon props').elevationRange = [3000, 0];
  });
  expectNamedError('Hexagon elevation domain is non-negative', 'camera-envelope.number', (catalog) => {
    record(layer(catalog, 'hexagon', 'hexagon-layer').props, 'hexagon props').elevationDomain = [-1, 10];
  });
}

function testHexagonSelectionAccessorOnlyReadsCanonicalPayload(): void {
  const accessor = accessorRegistry.hexagonSelectionPosition;
  assert(accessor, 'hexagonSelectionPosition accessor must be registered');
  assert(
    accessor({ longitude: -1, latitude: 52, position: [-1, 52] }) === undefined,
    'raw rows and aggregate object.position must fail closed',
  );
  assert(
    accessor({ cameraSelectionPosition: [Number.NaN, 52] }) === undefined,
    'non-finite canonical payload must fail closed',
  );
  assert(
    accessor({ cameraSelectionPosition: ['-1', 52] }) === undefined,
    'canonical payload must not coerce numeric strings',
  );
  assert(
    accessor({ cameraSelectionPosition: [-1, 52, 100] }) === undefined,
    'canonical click/cell payload must contain exactly one 2D coordinate',
  );
  const position = accessor({ cameraSelectionPosition: [-1, 52] });
  assert(Array.isArray(position) && position[0] === -1 && position[1] === 52, 'canonical payload must resolve');
}

function testMalformedCatalogShapesReturnNamedErrorsInsteadOfThrowing(): void {
  const malformedCatalogs: unknown[] = [null, {}, { datasets: null, visualizations: [] }];
  for (const malformed of malformedCatalogs) {
    let errors: string[];
    try {
      errors = validateVisualizationCatalog(malformed as VisualizationCatalog);
    } catch (error) {
      throw new Error(`malformed catalog must not throw: ${error instanceof Error ? error.message : String(error)}`);
    }
    assert(
      errors.some((error) => error.includes('[catalog.shape]')),
      `malformed catalog must return [catalog.shape], received ${JSON.stringify(errors)}`,
    );
  }
}

function testCatalogShapePreflightNeverExecutesAccessorsOrAcceptsHiddenKeys(): void {
  const validateShape = (catalog: MutableRecord, reads: () => number, label: string) => {
    let errors: string[];
    try {
      errors = errorsFor(catalog);
    } catch (error) {
      throw new Error(`${label} must not throw: ${error instanceof Error ? error.message : String(error)}`);
    }
    assert(reads() === 0, `${label} accessor must never execute`);
    assert(
      errors.some((error) => error.includes('[catalog.shape]')),
      `${label} must return [catalog.shape], received ${JSON.stringify(errors.slice(0, 5))}`,
    );
  };

  {
    const catalog = cloneCatalog();
    let reads = 0;
    Object.defineProperty(catalog, 'datasets', {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error('root getter executed');
      },
    });
    validateShape(catalog, () => reads, 'root datasets getter');
  }
  {
    const catalog = cloneCatalog();
    Object.defineProperty(catalog, 'defaultVisualization', {
      value: catalog.defaultVisualization,
      enumerable: false,
    });
    validateShape(catalog, () => 0, 'root non-enumerable property');
  }
  {
    const catalog = cloneCatalog();
    Object.defineProperty(catalog, Symbol('hidden'), { value: true, enumerable: true });
    validateShape(catalog, () => 0, 'root symbol property');
  }
  {
    const catalog = cloneCatalog();
    const datasets = catalog.datasets as MutableRecord[];
    let reads = 0;
    Object.defineProperty(datasets[0], 'files', {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error('dataset files getter executed');
      },
    });
    validateShape(catalog, () => reads, 'dataset files getter');
  }
  {
    const catalog = cloneCatalog();
    const datasets = catalog.datasets as MutableRecord[];
    let reads = 0;
    Object.defineProperty(datasets[0], 'id', {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error('dataset id getter executed');
      },
    });
    validateShape(catalog, () => reads, 'dataset id getter');
  }
  {
    const catalog = cloneCatalog();
    const visualizations = catalog.visualizations as MutableRecord[];
    let reads = 0;
    Object.defineProperty(visualizations[0], 'layers', {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error('visualization layers getter executed');
      },
    });
    validateShape(catalog, () => reads, 'visualization layers getter');
  }
  {
    const catalog = cloneCatalog();
    const datasets = catalog.datasets as MutableRecord[];
    let reads = 0;
    Object.defineProperty(datasets, '0', {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error('dataset collection getter executed');
      },
    });
    validateShape(catalog, () => reads, 'dataset collection getter');
  }
}

function testCatalogSharedDagCannotBypassDepthBudget(): void {
  const catalog = cloneCatalog();
  let shared: MutableRecord = { leaf: true };
  for (let depth = 0; depth < 10; depth += 1) shared = { child: shared };
  catalog.shallowShared = shared;
  let deepReference = shared;
  for (let depth = 0; depth < 58; depth += 1) deepReference = { next: deepReference };
  catalog.deepShared = deepReference;

  let errors: string[];
  try {
    errors = errorsFor(catalog);
  } catch (error) {
    throw new Error(`shared catalog DAG must not throw: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert(
    errors.some((error) => error.includes('[catalog.shape]') && error.includes('depth')),
    `deeper shared DAG path must return catalog.shape depth, received ${JSON.stringify(errors.slice(0, 5))}`,
  );
}

function testLayerValueAndContainerSchemasFailClosedWithoutExecutingGetters(): void {
  const expectLayerSchema = (name: string, expectedCode: string, mutate: (catalog: MutableRecord) => () => number) => {
    const catalog = cloneCatalog();
    const reads = mutate(catalog);
    let errors: string[];
    try {
      errors = errorsFor(catalog);
    } catch (error) {
      throw new Error(`${name} must not throw: ${error instanceof Error ? error.message : String(error)}`);
    }
    assert(reads() === 0, `${name} getter must never execute; received ${reads()} read(s)`);
    assert(
      errors.some((error) => error.includes(`[${expectedCode}]`)),
      `${name}: expected [${expectedCode}], received ${JSON.stringify(errors.slice(0, 8))}`,
    );
  };

  expectLayerSchema('parameter reference with an extra key', 'catalog.layer-value-schema', (catalog) => {
    record(layer(catalog, 'mix', 'heat').props, 'heat props').radiusPixels = {
      param: 'heatmapRadius',
      unexpected: true,
    };
    return () => 0;
  });

  expectLayerSchema('state reference with an extra key', 'catalog.layer-value-schema', (catalog) => {
    record(layer(catalog, 'animated', 'trips').props, 'trips props').currentTime = {
      state: 'animationTime',
      unexpected: true,
    };
    return () => 0;
  });

  expectLayerSchema('layer accessor getter', 'catalog.shape', (catalog) => {
    let reads = 0;
    const accessors: MutableRecord = {};
    Object.defineProperty(accessors, 'getPosition', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'coordinates';
      },
    });
    layer(catalog, 'point', 'point-map').accessors = accessors;
    return () => reads;
  });

  expectLayerSchema('layer prop getter', 'catalog.shape', (catalog) => {
    let reads = 0;
    const props: MutableRecord = {};
    Object.defineProperty(props, 'radiusPixels', {
      enumerable: true,
      get: () => {
        reads += 1;
        return { param: 'heatmapRadius' };
      },
    });
    layer(catalog, 'mix', 'heat').props = props;
    return () => reads;
  });

  expectLayerSchema('layer props custom prototype', 'catalog.shape', (catalog) => {
    const heat = layer(catalog, 'mix', 'heat');
    heat.props = Object.assign(Object.create({ inherited: true }), heat.props);
    return () => 0;
  });

  expectLayerSchema('layer accessors custom prototype', 'catalog.shape', (catalog) => {
    const point = layer(catalog, 'point', 'point-map');
    point.accessors = Object.assign(Object.create({ inherited: true }), point.accessors);
    return () => 0;
  });

  expectLayerSchema('nested literal getter', 'catalog.shape', (catalog) => {
    let reads = 0;
    const nested: MutableRecord = {};
    Object.defineProperty(nested, 'value', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 1;
      },
    });
    record(layer(catalog, 'mix', 'heat').props, 'heat props').radiusPixels = { literal: nested };
    return () => reads;
  });

  expectLayerSchema('nested literal symbol property', 'catalog.shape', (catalog) => {
    const nested: MutableRecord = { value: 1 };
    Object.defineProperty(nested, Symbol('hidden'), { value: true, enumerable: true });
    record(layer(catalog, 'mix', 'heat').props, 'heat props').radiusPixels = { literal: nested };
    return () => 0;
  });
}

function testEveryRegistryAndCriticalRecordUsesOwnProperties(): void {
  expectNamedError('Inherited data loader key', 'catalog.loader', (catalog) => {
    const dataset = findById(catalog.datasets, 'road-safety', 'datasets');
    findById(dataset.files, 'points', 'road-safety.files').format = 'toString';
  });
  expectNamedError('Inherited normalizer key', 'catalog.normalizer', (catalog) => {
    findById(catalog.datasets, 'road-safety', 'datasets').normalizers = ['constructor'];
  });
  expectNamedError('Inherited map style key', 'catalog.map-style', (catalog) => {
    visualization(catalog, 'point').mapStyle = 'toString';
  });
  expectNamedError('Inherited view-state key', 'catalog.view-state', (catalog) => {
    visualization(catalog, 'point').initialViewState = 'constructor';
  });
  expectNamedError('Inherited tooltip key', 'catalog.tooltip', (catalog) => {
    visualization(catalog, 'point').tooltip = 'toString';
  });
  expectNamedError('Inherited effect key', 'catalog.effect', (catalog) => {
    visualization(catalog, 'point').effects = ['constructor'];
  });
  expectNamedError('Inherited layer key', 'catalog.layer', (catalog) => {
    layer(catalog, 'point', 'point-map').type = 'toString';
  });
  expectNamedError('Inherited producer is not a declaration', 'catalog.shape', (catalog) => {
    const point = layer(catalog, 'point', 'point-map');
    const envelope = record(point.cameraEnvelope, 'point envelope');
    const inherited = Object.create({ producer: envelope.producer }) as MutableRecord;
    for (const [key, value] of Object.entries(envelope)) {
      if (key !== 'producer') inherited[key] = value;
    }
    point.cameraEnvelope = inherited;
  });
  expectNamedError('Inherited support is not declared support', 'catalog.shape', (catalog) => {
    const envelope = record(layer(catalog, 'point', 'point-map').cameraEnvelope, 'point envelope');
    envelope.support = Object.create({ antialiasBufferPx: 2 });
  });
  expectNamedError('Inherited sealed prop is not renderer topology', 'catalog.shape', (catalog) => {
    const point = layer(catalog, 'point', 'point-map');
    const props = record(point.props, 'point props');
    const inherited = Object.create({ billboard: true }) as MutableRecord;
    for (const [key, value] of Object.entries(props)) {
      if (key !== 'billboard') inherited[key] = value;
    }
    point.props = inherited;
  });
}

function testAnimationAndStateBackedNumericDomainsFailClosed(): void {
  expectNamedError('Animation modulo is positive', 'catalog.animation', (catalog) => {
    record(visualization(catalog, 'animated').animation, 'animated animation').frameModulo = 0;
  });
  expectNamedError('Animation enabled parameter exists', 'catalog.animation', (catalog) => {
    record(visualization(catalog, 'animated').animation, 'animated animation').enabledParam = 'missing-enabled';
  });
  expectNamedError('State-backed clamp domains stay ordered', 'camera-envelope.range', (catalog) => {
    const props = record(layer(catalog, 'animated', 'trips').props, 'trip props');
    props.widthMinPixels = { state: 'animationTime' };
    props.widthMaxPixels = 2;
  });
  expectNamedError('Camera parameters require a finite reachable domain', 'catalog.parameter-schema', (catalog) => {
    const radius = parameter(catalog, 'hexagon', 'hexagonRadius');
    radius.min = undefined;
    radius.max = undefined;
  });
}

function testDatasetAndLayerDataReferencesAreComplete(): void {
  expectNamedError('Dataset primaryDataRef exists', 'catalog.data-ref', (catalog) => {
    findById(catalog.datasets, 'road-safety', 'datasets').primaryDataRef = 'missing-primary';
  });
  expectNamedError('Layer dataRef exists in the base dataset', 'catalog.data-ref', (catalog) => {
    layer(catalog, 'point', 'point-map').dataRef = 'missing-points';
  });
  expectNamedError('Layer dataRef exists in every selectable dataset', 'catalog.data-ref', (catalog) => {
    findById(catalog.datasets, 'bike-parking', 'datasets').files = [
      { revision: 'different-v1', id: 'different', url: 'different.json', format: 'json' },
    ];
  });
}

function testDatasetParameterDefaultsAndReachabilityFailClosed(): void {
  expectNamedError('Dataset parameter default is a string', 'catalog.dataset-param', (catalog) => {
    parameter(catalog, 'hexagon', 'hexagonDataset').default = false;
  });
  expectNamedError('Dataset parameter default names a dataset', 'catalog.dataset-param', (catalog) => {
    parameter(catalog, 'hexagon', 'hexagonDataset').default = 'missing-dataset';
  });
  expectNamedError('Dataset parameter default is an allowed option', 'catalog.dataset-param', (catalog) => {
    parameter(catalog, 'hexagon', 'hexagonDataset').default = 'airports';
  });

  const catalog = cloneCatalog();
  parameter(catalog, 'hexagon', 'hexagonDataset').default = 'commute';
  const errors = errorsFor(catalog);
  assert(
    errors.some((error) => error.includes('[catalog.dataset-param]')),
    `dataset default outside options must fail: ${JSON.stringify(errors)}`,
  );
  assert(
    errors.some((error) => error.includes('[catalog.data-ref]') && error.includes('reachable dataset "commute"')),
    `dataset parameter default must still participate in reachability: ${JSON.stringify(errors)}`,
  );
}

function testAnalyticsElevationNumbersAndRangesFailClosed(): void {
  expectNamedError('Analytics elevation scale is finite', 'analytics.number', (catalog) => {
    record(layer(catalog, 'hexagon', 'hexagon-layer').analytics, 'hexagon analytics').elevationScale = Number.NaN;
  });
  expectNamedError('Analytics elevation scale is non-negative', 'analytics.number', (catalog) => {
    record(layer(catalog, 'hexagon', 'hexagon-layer').analytics, 'hexagon analytics').elevationScale = -1;
  });

  for (const field of ['elevationRange', 'elevationDomain'] as const) {
    expectNamedError(`Analytics ${field} has exactly two values`, 'analytics.range', (catalog) => {
      record(layer(catalog, 'hexagon', 'hexagon-layer').analytics, 'hexagon analytics')[field] = [0, 1, 2];
    });
    expectNamedError(`Analytics ${field} is finite`, 'analytics.number', (catalog) => {
      record(layer(catalog, 'hexagon', 'hexagon-layer').analytics, 'hexagon analytics')[field] = [0, Number.NaN];
    });
    expectNamedError(`Analytics ${field} is non-negative`, 'analytics.number', (catalog) => {
      record(layer(catalog, 'hexagon', 'hexagon-layer').analytics, 'hexagon analytics')[field] = [-1, 1];
    });
    expectNamedError(`Analytics ${field} is strictly increasing`, 'analytics.range', (catalog) => {
      record(layer(catalog, 'hexagon', 'hexagon-layer').analytics, 'hexagon analytics')[field] = [1, 1];
    });
    expectNamedError(`Analytics ${field} rejects reverse order`, 'analytics.range', (catalog) => {
      record(layer(catalog, 'hexagon', 'hexagon-layer').analytics, 'hexagon analytics')[field] = [2, 1];
    });
  }
}

function testAnalyticsElevationMatchesRendererAndEnvelopeSupport(): void {
  expectNamedError('Analytics elevation range matches renderer support', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'hexagon', 'hexagon-layer').analytics, 'hexagon analytics').elevationRange = [0, 2000];
  });
  expectNamedError('Catalog elevation range cannot bypass analytics', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'hexagon', 'hexagon-layer').props, 'hexagon props').elevationRange = [0, 2000];
  });
  expectNamedError('Analytics elevation scale matches renderer support', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'hexagon', 'hexagon-layer').analytics, 'hexagon analytics').elevationScale = 2;
  });
  expectNamedError('Catalog elevation scale cannot bypass analytics', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'hexagon', 'hexagon-layer').props, 'hexagon props').elevationScale = 2;
  });
  expectNamedError('Dynamic renderer scale cannot bypass static analytics', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'hexagon', 'hexagon-layer').props, 'hexagon props').elevationScale = {
      param: 'hexagonCoverage',
    };
  });
  expectNamedError('Polygon analytics scale matches extrusion support', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'animated', 'buildings').analytics, 'building analytics').elevationScale = 2;
  });
  expectNamedError('Non-hexagon analytics cannot invent a renderer range', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'animated', 'buildings').analytics, 'building analytics').elevationRange = [0, 1000];
  });

  const matching = cloneCatalog();
  const hexagon = layer(matching, 'hexagon', 'hexagon-layer');
  const analytics = record(hexagon.analytics, 'hexagon analytics');
  const props = record(hexagon.props, 'hexagon props');
  analytics.elevationRange = [0, 2000];
  analytics.elevationScale = 0;
  analytics.elevationDomain = [0, 10];
  props.elevationRange = [0, 2000];
  props.elevationScale = 0;
  props.elevationDomain = [0, 10];
  const errors = errorsFor(matching);
  assert(errors.length === 0, `matching analytics and renderer elevation support must be valid: ${errors.join('\n')}`);

  const decoupledDomains = cloneCatalog();
  const decoupledHexagon = layer(decoupledDomains, 'hexagon', 'hexagon-layer');
  record(decoupledHexagon.analytics, 'hexagon analytics').elevationDomain = [0, 10];
  record(decoupledHexagon.props, 'hexagon props').elevationDomain = [0, 20];
  const decoupledDomainErrors = errorsFor(decoupledDomains);
  assert(
    decoupledDomainErrors.length === 0,
    `analytics and renderer elevation domains may differ: ${decoupledDomainErrors.join('\n')}`,
  );

  const rendererDomainOnly = cloneCatalog();
  record(layer(rendererDomainOnly, 'hexagon', 'hexagon-layer').props, 'hexagon props').elevationDomain = [0, 20];
  const rendererDomainOnlyErrors = errorsFor(rendererDomainOnly);
  assert(
    rendererDomainOnlyErrors.length === 0,
    `a renderer elevation domain does not require a static analytics domain: ${rendererDomainOnlyErrors.join('\n')}`,
  );

  const runtimeDomain = cloneCatalog();
  record(layer(runtimeDomain, 'hexagon', 'hexagon-layer').analytics, 'hexagon analytics').elevationDomain = [0, 10];
  const runtimeDomainErrors = errorsFor(runtimeDomain);
  assert(
    runtimeDomainErrors.length === 0,
    `analytics may supply the runtime-derived elevation domain when catalog props omit it: ${runtimeDomainErrors.join(
      '\n',
    )}`,
  );
}

function testAnalyticsGeometryMatchesRendererAndEnvelopeSupport(): void {
  expectNamedError('Scatter analytics position matches renderer geometry', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'point', 'point-map').analytics, 'point analytics').positionAccessor = 'lonLat';
  });
  expectNamedError('Analytics kind matches its renderer producer', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'point', 'point-map').analytics, 'point analytics').kind = 'heatmap';
  });
  expectNamedError('Hexagon analytics radius matches renderer support', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'hexagon', 'hexagon-layer').analytics, 'hexagon analytics').radiusParam = 'hexagonCoverage';
  });
  expectNamedError('Hexagon renderer elevation weight is sealed to constant1', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'hexagon', 'hexagon-layer').accessors, 'hexagon accessors').getElevationWeight =
      'gunHeatWeight';
  });
  expectNamedError('Heatmap analytics weight matches renderer support', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'mix', 'heat').analytics, 'heat analytics').weightAccessor = 'constant1';
  });
  expectNamedError('Line analytics source matches renderer geometry', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'line', 'line-flight-paths').analytics, 'line analytics').sourcePositionAccessor =
      'commuteTarget';
  });
  expectNamedError('Line analytics target matches renderer geometry', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'line', 'line-flight-paths').analytics, 'line analytics').targetPositionAccessor =
      'commuteSource';
  });
  expectNamedError('Trip analytics path matches renderer geometry', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'animated', 'trips').analytics, 'trip analytics').pathAccessor = 'buildingPolygon';
  });
  expectNamedError('Polygon analytics footprint matches renderer geometry', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'animated', 'buildings').analytics, 'building analytics').polygonAccessor = 'tripPath';
  });
  expectNamedError('Polygon analytics height matches renderer geometry', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'animated', 'buildings').analytics, 'building analytics').elevationAccessor = 'constant1';
  });
  expectNamedError('Scatter analytics cannot inject an elevation accessor', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'point', 'point-map').analytics, 'point analytics').elevationAccessor = 'buildingHeight';
  });
  expectNamedError('Trips analytics cannot inject a radius parameter', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'animated', 'trips').analytics, 'trip analytics').radiusParam = 'trailLength';
  });
  expectNamedError('Polygon analytics cannot inject an unrelated weight', 'analytics.dependency', (catalog) => {
    record(layer(catalog, 'animated', 'buildings').analytics, 'building analytics').weightAccessor = 'constant1';
  });
}

function testLargeNumericOptionCatalogReturnsNamedBudgetError(): void {
  const catalog = cloneCatalog();
  const visualizationConfig = visualization(catalog, 'mix');
  assert(Array.isArray(visualizationConfig.parameters), 'mix.parameters must be an array');
  const parameters = visualizationConfig.parameters;
  parameters.push({
    key: 'largeClamp',
    label: 'Large clamp',
    control: 'select',
    default: 0,
    options: Array.from({ length: 150_000 }, (_, value) => ({ label: String(value), value })),
  });
  record(layer(catalog, 'mix', 'scatter').props, 'scatter props').radiusMinPixels = { param: 'largeClamp' };

  let errors: string[];
  try {
    errors = errorsFor(catalog);
  } catch (error) {
    throw new Error(
      `large numeric option catalog must not throw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assert(
    errors.some((error) => error.includes('[catalog.budget]')),
    `large numeric option catalog must return [catalog.budget], received ${JSON.stringify(errors.slice(0, 5))}`,
  );
}

function testEveryCatalogValidationFailureUsesANamedCode(): void {
  expectNamedError('Unknown default visualization is named', 'catalog.default', (catalog) => {
    catalog.defaultVisualization = 'missing-default';
  });
  expectNamedError('Unknown visualization dataset is named', 'catalog.dataset', (catalog) => {
    visualization(catalog, 'point').datasetId = 'missing-dataset';
  });
  expectNamedError('Unknown renderer accessor is named', 'catalog.accessor', (catalog) => {
    record(layer(catalog, 'mix', 'scatter').accessors, 'scatter accessors').getFillColor = 'missing-color';
  });
  expectNamedError('Unknown analytics accessor is named', 'analytics.accessor', (catalog) => {
    record(layer(catalog, 'mix', 'heat').analytics, 'heat analytics').weightAccessor = 'missing-weight';
  });
  expectNamedError('Unknown analytics radius parameter is named', 'analytics.parameter', (catalog) => {
    record(layer(catalog, 'hexagon', 'hexagon-layer').analytics, 'hexagon analytics').radiusParam = 'missing-radius';
  });
}

testMalformedCatalogShapesReturnNamedErrorsInsteadOfThrowing();
testCatalogShapePreflightNeverExecutesAccessorsOrAcceptsHiddenKeys();
testCatalogSharedDagCannotBypassDepthBudget();
testLayerValueAndContainerSchemasFailClosedWithoutExecutingGetters();
testRealCatalogSatisfiesCameraContract();
testCycleFreeContractRegistryIsClosedAndImmutable();
testRequiredPlanMutationsHaveNamedErrors();
testRevisionAndCalibrationFailuresAreNamed();
testSelectionAndAdapterFailuresAreNamed();
testPolygonAdapterRejectsUnrenderedBaseOffset();
testNestedCameraContractSchemasAreExact();
testOptionalRendererDependenciesAreBidirectional();
testCameraNumericParameterSchemasFailClosed();
testParameterBackedPixelClampsStayOrdered();
testEveryCalibrationMetricEntryIsValidated();
testSupportCapabilitiesAndReferencesFailClosed();
testHexagonSelectionAccessorOnlyReadsCanonicalPayload();
testEveryRegistryAndCriticalRecordUsesOwnProperties();
testAnimationAndStateBackedNumericDomainsFailClosed();
testDatasetAndLayerDataReferencesAreComplete();
testDatasetParameterDefaultsAndReachabilityFailClosed();
testAnalyticsElevationNumbersAndRangesFailClosed();
testAnalyticsElevationMatchesRendererAndEnvelopeSupport();
testAnalyticsGeometryMatchesRendererAndEnvelopeSupport();
testLargeNumericOptionCatalogReturnsNamedBudgetError();
testEveryCatalogValidationFailureUsesANamedCode();
