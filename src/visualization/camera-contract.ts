import type {
  CameraEnvelopeConfig,
  SelectionProducerConfig,
  VisualizationConfig,
  VisualizationParameterValues,
} from './types';

export const STRICT_RENDERER_LIBRARY_VERSION = '9.3.2';
export const REQUIRED_CAMERA_CALIBRATION_METRIC_UNITS = Object.freeze({
  elevation: 'meters',
  density: 'count/km2',
  aspect: 'ratio',
} as const);

export type CameraEnvelopeProducer = CameraEnvelopeConfig['producer'];
export type SelectionMode = SelectionProducerConfig['supported'][number];

export interface RendererAdapterContract {
  layerType: string;
  producer: CameraEnvelopeProducer;
  rendererVersion: number;
  rendererLibraryVersion: typeof STRICT_RENDERER_LIBRARY_VERSION;
  permittedResolvedProps: Readonly<Record<string, true>>;
  permittedAccessorProps: Readonly<Record<string, true>>;
  sealedProps: Readonly<Record<string, true>>;
  sealedEnvelopeProps: Readonly<Record<string, boolean | number | string>>;
  accessorDefaults: Readonly<Record<string, number>>;
}

function defineRendererAdapterContract(contract: RendererAdapterContract): RendererAdapterContract {
  return Object.freeze({
    ...contract,
    permittedResolvedProps: Object.freeze({ ...contract.permittedResolvedProps }),
    permittedAccessorProps: Object.freeze({ ...contract.permittedAccessorProps }),
    sealedProps: Object.freeze({ ...contract.sealedProps }),
    sealedEnvelopeProps: Object.freeze({ ...contract.sealedEnvelopeProps }),
    accessorDefaults: Object.freeze({ ...contract.accessorDefaults }),
  });
}

export type CameraContractSchemaCode = 'selection.schema' | 'camera-envelope.schema' | 'camera-calibration.schema';

export interface CameraContractSchemaIssue {
  code: CameraContractSchemaCode;
  path: string;
  detail: string;
  unsafeToRead: boolean;
}

interface ExactRecordSchema {
  required: readonly string[];
  optional?: readonly string[];
}

const SELECTION_SCHEMA: ExactRecordSchema = Object.freeze({
  required: Object.freeze(['supported']),
  optional: Object.freeze(['stableIdAccessor', 'coordinateAccessor', 'pathAccessor', 'renderQueryId']),
});

const SUPPORT_SCHEMA: ExactRecordSchema = Object.freeze({
  required: Object.freeze(['antialiasBufferPx']),
  optional: Object.freeze(['alphaCutoff']),
});

const CAPABILITIES_SCHEMA: ExactRecordSchema = Object.freeze({
  required: Object.freeze([
    'supportsLive',
    'supportsPrediction',
    'maxPredictionHorizonMs',
    'nominalUpdateHz',
    'frameEvolution',
  ]),
});

const CAMERA_CALIBRATION_SCHEMA: ExactRecordSchema = Object.freeze({
  required: Object.freeze(['version', 'referenceZoom', 'referenceSafeAreaPx', 'metrics']),
});

const CALIBRATION_METRIC_SCHEMA: ExactRecordSchema = Object.freeze({
  required: Object.freeze(['unit', 'lo', 'hi', 'source']),
});

const ENVELOPE_COMMON_KEYS = Object.freeze(['producer', 'producerVersion', 'support', 'capabilities']);

const ENVELOPE_SCHEMAS: Readonly<Record<CameraEnvelopeProducer, ExactRecordSchema>> = Object.freeze({
  'hexagon-cell': Object.freeze({
    required: Object.freeze([...ENVELOPE_COMMON_KEYS, 'positionAccessor', 'radius', 'coverage', 'elevation']),
  }),
  'heatmap-kernel': Object.freeze({
    required: Object.freeze([...ENVELOPE_COMMON_KEYS, 'positionAccessor', 'radius']),
    optional: Object.freeze(['weightAccessor']),
  }),
  'scatter-point': Object.freeze({
    required: Object.freeze([...ENVELOPE_COMMON_KEYS, 'positionAccessor', 'radius', 'minPixelsProp', 'maxPixelsProp']),
  }),
  'line-path': Object.freeze({
    optional: Object.freeze(['widthAccessor']),
    required: Object.freeze([
      ...ENVELOPE_COMMON_KEYS,
      'sourcePositionAccessor',
      'targetPositionAccessor',
      'width',
      'minPixelsProp',
      'maxPixelsProp',
    ]),
  }),
  'trip-path': Object.freeze({
    required: Object.freeze([...ENVELOPE_COMMON_KEYS, 'pathAccessor', 'width', 'minPixelsProp', 'maxPixelsProp']),
  }),
  'polygon-extrusion': Object.freeze({
    required: Object.freeze([
      ...ENVELOPE_COMMON_KEYS,
      'polygonAccessor',
      'baseMeters',
      'elevationScale',
      'elevationUnit',
      'wrapMode',
    ]),
    optional: Object.freeze(['elevationAccessor']),
  }),
});

const HEXAGON_RADIUS_SCHEMA: ExactRecordSchema = Object.freeze({
  required: Object.freeze(['param', 'unit']),
});
const HEXAGON_COVERAGE_SCHEMA: ExactRecordSchema = Object.freeze({ required: Object.freeze(['prop']) });
const HEXAGON_ELEVATION_SCHEMA: ExactRecordSchema = Object.freeze({
  required: Object.freeze(['valueField', 'rangeProp', 'scaleProp', 'domainProp']),
});
const HEATMAP_RADIUS_SCHEMA: ExactRecordSchema = Object.freeze({
  required: Object.freeze(['prop', 'unit']),
});
const UNIT_SCALE_SCHEMA: ExactRecordSchema = Object.freeze({
  required: Object.freeze(['prop', 'unitProp', 'scaleProp']),
});

function isPlainContractRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function addShapeIssue(
  issues: CameraContractSchemaIssue[],
  code: CameraContractSchemaCode,
  path: string,
  detail: string,
  unsafeToRead = false,
) {
  issues.push({ code, path, detail, unsafeToRead });
}

function validateExactRecord(
  value: unknown,
  schema: ExactRecordSchema,
  code: CameraContractSchemaCode,
  path: string,
  issues: CameraContractSchemaIssue[],
): Record<string, unknown> | undefined {
  if (!isPlainContractRecord(value)) {
    addShapeIssue(issues, code, path, 'must be a plain object with own properties.');
    return undefined;
  }

  const allowedKeys = new Set([...(schema.required ?? []), ...(schema.optional ?? [])]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      addShapeIssue(issues, code, path, `contains unexpected key "${String(key)}".`);
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      addShapeIssue(issues, code, `${path}.${key}`, 'must be an enumerable own data property.', true);
    }
  }
  for (const key of schema.required) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      addShapeIssue(issues, code, path, `is missing required key "${key}".`);
    } else if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      addShapeIssue(issues, code, `${path}.${key}`, 'must be an enumerable own data property.', true);
    }
  }
  return value;
}

function getOwnDataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && descriptor.enumerable && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function getSchemaDataValue(
  record: Record<string, unknown>,
  key: string,
  code: CameraContractSchemaCode,
  path: string,
  issues: CameraContractSchemaIssue[],
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    addShapeIssue(issues, code, path, 'must be an enumerable own data property.', true);
    return undefined;
  }
  return descriptor.value;
}

function validateEnvelopeNestedRecords(
  envelope: Record<string, unknown>,
  producer: CameraEnvelopeProducer,
  issues: CameraContractSchemaIssue[],
) {
  validateExactRecord(
    getOwnDataValue(envelope, 'support'),
    SUPPORT_SCHEMA,
    'camera-envelope.schema',
    'cameraEnvelope.support',
    issues,
  );
  validateExactRecord(
    getOwnDataValue(envelope, 'capabilities'),
    CAPABILITIES_SCHEMA,
    'camera-envelope.schema',
    'cameraEnvelope.capabilities',
    issues,
  );

  if (producer === 'hexagon-cell') {
    validateExactRecord(
      getOwnDataValue(envelope, 'radius'),
      HEXAGON_RADIUS_SCHEMA,
      'camera-envelope.schema',
      'cameraEnvelope.radius',
      issues,
    );
    validateExactRecord(
      getOwnDataValue(envelope, 'coverage'),
      HEXAGON_COVERAGE_SCHEMA,
      'camera-envelope.schema',
      'cameraEnvelope.coverage',
      issues,
    );
    validateExactRecord(
      getOwnDataValue(envelope, 'elevation'),
      HEXAGON_ELEVATION_SCHEMA,
      'camera-envelope.schema',
      'cameraEnvelope.elevation',
      issues,
    );
  } else if (producer === 'heatmap-kernel') {
    validateExactRecord(
      getOwnDataValue(envelope, 'radius'),
      HEATMAP_RADIUS_SCHEMA,
      'camera-envelope.schema',
      'cameraEnvelope.radius',
      issues,
    );
  } else if (producer === 'scatter-point') {
    validateExactRecord(
      getOwnDataValue(envelope, 'radius'),
      UNIT_SCALE_SCHEMA,
      'camera-envelope.schema',
      'cameraEnvelope.radius',
      issues,
    );
  } else if (producer === 'line-path' || producer === 'trip-path') {
    validateExactRecord(
      getOwnDataValue(envelope, 'width'),
      UNIT_SCALE_SCHEMA,
      'camera-envelope.schema',
      'cameraEnvelope.width',
      issues,
    );
  }
}

export function validateLayerCameraContractShape(layerValue: unknown): CameraContractSchemaIssue[] {
  const issues: CameraContractSchemaIssue[] = [];
  if (!isPlainContractRecord(layerValue)) {
    addShapeIssue(issues, 'camera-envelope.schema', 'layer', 'must be a plain object with own properties.');
    return issues;
  }

  const selectionValue = getSchemaDataValue(layerValue, 'selection', 'selection.schema', 'selection', issues);
  validateExactRecord(selectionValue, SELECTION_SCHEMA, 'selection.schema', 'selection', issues);

  const envelopeValue = getSchemaDataValue(
    layerValue,
    'cameraEnvelope',
    'camera-envelope.schema',
    'cameraEnvelope',
    issues,
  );
  if (!isPlainContractRecord(envelopeValue)) {
    addShapeIssue(issues, 'camera-envelope.schema', 'cameraEnvelope', 'must be a plain object with own properties.');
  } else {
    const producer = getSchemaDataValue(
      envelopeValue,
      'producer',
      'camera-envelope.schema',
      'cameraEnvelope.producer',
      issues,
    );
    const schema =
      typeof producer === 'string' && Object.prototype.hasOwnProperty.call(ENVELOPE_SCHEMAS, producer)
        ? ENVELOPE_SCHEMAS[producer as CameraEnvelopeProducer]
        : undefined;
    if (schema) {
      validateExactRecord(envelopeValue, schema, 'camera-envelope.schema', 'cameraEnvelope', issues);
      validateEnvelopeNestedRecords(envelopeValue, producer as CameraEnvelopeProducer, issues);
    } else if (producer === undefined) {
      addShapeIssue(issues, 'camera-envelope.schema', 'cameraEnvelope', 'is missing required key "producer".');
    }
  }

  const calibrationValue = getSchemaDataValue(
    layerValue,
    'cameraCalibration',
    'camera-calibration.schema',
    'cameraCalibration',
    issues,
  );
  const calibration = validateExactRecord(
    calibrationValue,
    CAMERA_CALIBRATION_SCHEMA,
    'camera-calibration.schema',
    'cameraCalibration',
    issues,
  );
  if (calibration) {
    const metricsValue = getOwnDataValue(calibration, 'metrics');
    if (!isPlainContractRecord(metricsValue)) {
      addShapeIssue(
        issues,
        'camera-calibration.schema',
        'cameraCalibration.metrics',
        'must be a plain object with own metric entries.',
      );
    } else {
      for (const metricName of Reflect.ownKeys(metricsValue)) {
        if (typeof metricName !== 'string') {
          addShapeIssue(
            issues,
            'camera-calibration.schema',
            'cameraCalibration.metrics',
            `contains unexpected key "${String(metricName)}".`,
          );
          continue;
        }
        const metricDescriptor = Object.getOwnPropertyDescriptor(metricsValue, metricName);
        if (
          !metricDescriptor ||
          !metricDescriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(metricDescriptor, 'value')
        ) {
          addShapeIssue(
            issues,
            'camera-calibration.schema',
            `cameraCalibration.metrics.${metricName}`,
            'must be an enumerable own data property.',
            true,
          );
          continue;
        }
        validateExactRecord(
          metricDescriptor.value,
          CALIBRATION_METRIC_SCHEMA,
          'camera-calibration.schema',
          `cameraCalibration.metrics.${metricName}`,
          issues,
        );
      }
    }
  }

  return issues;
}

export const rendererAdapterContracts: readonly RendererAdapterContract[] = Object.freeze([
  defineRendererAdapterContract({
    layerType: 'HexagonLayer',
    producer: 'hexagon-cell',
    rendererVersion: 1,
    rendererLibraryVersion: STRICT_RENDERER_LIBRARY_VERSION,
    permittedResolvedProps: Object.freeze({
      extruded: true,
      elevationRange: true,
      elevationScale: true,
      elevationDomain: true,
      coverage: true,
      radius: true,
      upperPercentile: true,
    }),
    permittedAccessorProps: Object.freeze({
      getPosition: true,
      getColorWeight: true,
      getElevationWeight: true,
    }),
    sealedProps: Object.freeze({}),
    sealedEnvelopeProps: Object.freeze({}),
    accessorDefaults: Object.freeze({}),
  }),
  defineRendererAdapterContract({
    layerType: 'HeatmapLayer',
    producer: 'heatmap-kernel',
    rendererVersion: 1,
    rendererLibraryVersion: STRICT_RENDERER_LIBRARY_VERSION,
    permittedResolvedProps: Object.freeze({ radiusPixels: true, intensity: true, threshold: true }),
    permittedAccessorProps: Object.freeze({ getPosition: true, getWeight: true }),
    sealedProps: Object.freeze({}),
    sealedEnvelopeProps: Object.freeze({}),
    accessorDefaults: Object.freeze({ getWeight: 1 }),
  }),
  defineRendererAdapterContract({
    layerType: 'ScatterplotLayer',
    producer: 'scatter-point',
    rendererVersion: 1,
    rendererLibraryVersion: STRICT_RENDERER_LIBRARY_VERSION,
    permittedResolvedProps: Object.freeze({
      getRadius: true,
      radiusUnits: true,
      radiusScale: true,
      radiusMinPixels: true,
      radiusMaxPixels: true,
      billboard: true,
    }),
    permittedAccessorProps: Object.freeze({ getPosition: true, getFillColor: true }),
    sealedProps: Object.freeze({ billboard: true }),
    sealedEnvelopeProps: Object.freeze({}),
    accessorDefaults: Object.freeze({}),
  }),
  defineRendererAdapterContract({
    layerType: 'LineLayer',
    producer: 'line-path',
    rendererVersion: 1,
    rendererLibraryVersion: STRICT_RENDERER_LIBRARY_VERSION,
    permittedResolvedProps: Object.freeze({
      getWidth: true,
      widthUnits: true,
      widthScale: true,
      widthMinPixels: true,
      widthMaxPixels: true,
    }),
    permittedAccessorProps: Object.freeze({
      getSourcePosition: true,
      getTargetPosition: true,
      getColor: true,
      getWidth: true,
    }),
    sealedProps: Object.freeze({}),
    sealedEnvelopeProps: Object.freeze({}),
    accessorDefaults: Object.freeze({}),
  }),
  defineRendererAdapterContract({
    layerType: 'TripsLayer',
    producer: 'trip-path',
    rendererVersion: 1,
    rendererLibraryVersion: STRICT_RENDERER_LIBRARY_VERSION,
    permittedResolvedProps: Object.freeze({
      trailLength: true,
      currentTime: true,
      getWidth: true,
      widthUnits: true,
      widthScale: true,
      widthMinPixels: true,
      widthMaxPixels: true,
      billboard: true,
      jointRounded: true,
      capRounded: true,
    }),
    permittedAccessorProps: Object.freeze({ getPath: true, getTimestamps: true, getColor: true }),
    sealedProps: Object.freeze({ billboard: true, jointRounded: true, capRounded: true }),
    sealedEnvelopeProps: Object.freeze({}),
    accessorDefaults: Object.freeze({}),
  }),
  defineRendererAdapterContract({
    layerType: 'PolygonLayer',
    producer: 'polygon-extrusion',
    rendererVersion: 1,
    rendererLibraryVersion: STRICT_RENDERER_LIBRARY_VERSION,
    permittedResolvedProps: Object.freeze({ extruded: true, elevationScale: true }),
    permittedAccessorProps: Object.freeze({ getPolygon: true, getElevation: true }),
    sealedProps: Object.freeze({}),
    sealedEnvelopeProps: Object.freeze({ baseMeters: 0 }),
    accessorDefaults: Object.freeze({ getElevation: 1000 }),
  }),
]);

export function findRendererAdapterContract(
  layerType: unknown,
  producer: unknown,
  rendererVersion: unknown,
): RendererAdapterContract | undefined {
  return rendererAdapterContracts.find(
    (contract) =>
      contract.layerType === layerType &&
      contract.producer === producer &&
      contract.rendererVersion === rendererVersion,
  );
}

export function hasRendererAdapterTuple(layerType: unknown, producer: unknown): boolean {
  return rendererAdapterContracts.some(
    (contract) => contract.layerType === layerType && contract.producer === producer,
  );
}

export function isKnownCameraEnvelopeProducer(value: unknown): value is CameraEnvelopeProducer {
  return rendererAdapterContracts.some((contract) => contract.producer === value);
}

export const HEXAGON_SELECTION_POSITION_FIELD = 'cameraSelectionPosition';
export const HEXAGON_SELECTION_POSITION_ACCESSOR_ID = 'hexagonSelectionPosition';

export const knownAccessorIds = Object.freeze([
  'lonLat',
  HEXAGON_SELECTION_POSITION_ACCESSOR_ID,
  'constant1',
  'commuteSource',
  'commuteTarget',
  'commuteFlowColor',
  'lineSource',
  'lineTarget',
  'lineColor',
  'lineWidth',
  'coordinates',
  'gunSeverityColor',
  'gunHeatWeight',
  'tripPath',
  'tripTimestamps',
  'tripVendorColor',
  'buildingPolygon',
  'buildingHeight',
] as const);

export type KnownAccessorId = (typeof knownAccessorIds)[number];

const knownAccessorIdSet: ReadonlySet<string> = new Set(knownAccessorIds);

export function isKnownAccessorId(value: unknown): value is KnownAccessorId {
  return typeof value === 'string' && knownAccessorIdSet.has(value);
}

export const renderQueryContracts = Object.freeze({
  'select-scatter-point-v1': Object.freeze({
    snapshotSchemaVersion: 1 as const,
    producer: 'scatter-point' as const,
    markKind: 'source-object' as const,
    supported: Object.freeze(['click'] as const),
    selectionAccessor: 'coordinateAccessor' as const,
    envelopeAccessor: 'positionAccessor' as const,
  }),
  'select-hexagon-cell-v1': Object.freeze({
    snapshotSchemaVersion: 1 as const,
    producer: 'hexagon-cell' as const,
    markKind: 'hexagon-cell' as const,
    supported: Object.freeze(['click'] as const),
    canonicalPositionField: HEXAGON_SELECTION_POSITION_FIELD,
    positionAccessorId: HEXAGON_SELECTION_POSITION_ACCESSOR_ID,
  }),
  'select-line-path-v1': Object.freeze({
    snapshotSchemaVersion: 1 as const,
    producer: 'line-path' as const,
    markKind: 'source-object' as const,
    supported: Object.freeze(['click', 'path'] as const),
  }),
  'select-heatmap-zone-v1': Object.freeze({
    snapshotSchemaVersion: 1 as const,
    producer: 'heatmap-kernel' as const,
    markKind: 'source-object' as const,
    supported: Object.freeze(['map-click', 'region'] as const),
    selectionAccessor: 'coordinateAccessor' as const,
    envelopeAccessor: 'positionAccessor' as const,
    certificationKind: 'heatmap-halo-complete-v1' as const,
    contributorSet: 'complete' as const,
    minimumHalo: 'resolved-kernel-radius-pixels' as const,
  }),
  'select-trip-path-v1': Object.freeze({
    snapshotSchemaVersion: 1 as const,
    producer: 'trip-path' as const,
    markKind: 'source-object' as const,
    supported: Object.freeze(['click', 'path'] as const),
    selectionAccessor: 'pathAccessor' as const,
    envelopeAccessor: 'pathAccessor' as const,
  }),
  'select-polygon-region-v1': Object.freeze({
    snapshotSchemaVersion: 1 as const,
    producer: 'polygon-extrusion' as const,
    markKind: 'source-object' as const,
    supported: Object.freeze(['region'] as const),
  }),
});

export type RenderQueryId = keyof typeof renderQueryContracts;

export function isKnownRenderQueryId(value: unknown): value is RenderQueryId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(renderQueryContracts, value);
}

export function getRenderQueryContract(value: unknown) {
  return isKnownRenderQueryId(value) ? renderQueryContracts[value] : undefined;
}

export function resolveVisualizationDatasetId(
  visualization: VisualizationConfig,
  params: VisualizationParameterValues,
): string {
  if (!visualization.datasetParam) return visualization.datasetId;

  const datasetParam = visualization.datasetParam;
  const parameter = visualization.parameters?.find((candidate) => candidate.key === datasetParam);
  if (!parameter) {
    throw new Error(`Visualization "${visualization.id}" does not declare dataset parameter "${datasetParam}".`);
  }
  if (parameter.control !== 'select' || !Array.isArray(parameter.options) || parameter.options.length === 0) {
    throw new Error(
      `Visualization "${visualization.id}" dataset parameter "${datasetParam}" must be a nonempty select.`,
    );
  }

  const selected = Object.prototype.hasOwnProperty.call(params, datasetParam)
    ? params[datasetParam]
    : parameter.default;
  if (
    typeof selected !== 'string' ||
    selected.length === 0 ||
    !parameter.options.some((option) => option.value === selected)
  ) {
    throw new Error(
      `Value "${String(selected)}" is not an allowed dataset for visualization "${visualization.id}" parameter "${datasetParam}".`,
    );
  }
  return selected;
}
