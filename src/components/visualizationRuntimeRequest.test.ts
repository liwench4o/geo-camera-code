import {
  VisualizationRuntimeRequestCoordinator,
  createVisualizationRuntimeSignature,
} from './visualizationRuntimeRequest';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const missingViewport = createVisualizationRuntimeSignature({
  visualizationId: 'hexagon',
  datasetId: 'road-safety',
  params: {},
  manualParameterKeys: [],
  viewport: undefined,
});
assert(missingViewport === undefined, 'missing viewport must not create a request signature');

const signature = createVisualizationRuntimeSignature({
  visualizationId: 'hexagon',
  datasetId: 'road-safety',
  params: { radius: 1000 },
  manualParameterKeys: [],
  viewport: { width: 960, height: 640 },
});
assert(signature, 'valid viewport must create a signature');

const reorderedSignature = createVisualizationRuntimeSignature({
  visualizationId: 'hexagon',
  datasetId: 'road-safety',
  params: { coverage: 1, radius: 1000 },
  manualParameterKeys: ['radius', 'coverage'],
  viewport: { width: 960, height: 640 },
});
const canonicalSignature = createVisualizationRuntimeSignature({
  visualizationId: 'hexagon',
  datasetId: 'road-safety',
  params: { radius: 1000, coverage: 1 },
  manualParameterKeys: ['coverage', 'radius'],
  viewport: { width: 960, height: 640 },
});
assert(reorderedSignature === canonicalSignature, 'signature must canonicalize records and key arrays');

const coordinator = new VisualizationRuntimeRequestCoordinator();
const first = coordinator.begin(signature);
assert(first !== undefined, 'first signature must start');
assert(coordinator.begin(signature) === undefined, 'in-flight signature must deduplicate');
assert(coordinator.commit(first), 'current request must commit');
assert(coordinator.begin(signature) === undefined, 'committed signature must deduplicate');
assert(coordinator.isCommitted(signature), 'coordinator must identify the committed signature');

const revertedRequest = coordinator.begin(`${signature}:temporary`);
assert(revertedRequest !== undefined, 'temporary signature must start');
assert(coordinator.begin(signature) === undefined, 'reverting to the committed signature must reuse it');
assert(!coordinator.commit(revertedRequest), 'reverting must supersede the now-stale temporary request');

const adaptiveCoordinator = new VisualizationRuntimeRequestCoordinator();
const adaptiveRequest = adaptiveCoordinator.begin(signature);
assert(adaptiveRequest !== undefined, 'adaptive request must start');
const effectiveSignature = `${signature}:effective`;
assert(
  adaptiveCoordinator.commit(adaptiveRequest, effectiveSignature),
  'adaptive request must commit its effective signature',
);
assert(
  adaptiveCoordinator.begin(effectiveSignature) === undefined,
  'effective parameters written back by the runtime must not trigger a duplicate request',
);

const changed = coordinator.begin(`${signature}:changed`);
assert(changed !== undefined, 'changed signature must start');
const newer = coordinator.begin(`${signature}:newer`);
assert(newer !== undefined, 'newer signature must supersede old request');
assert(!coordinator.commit(changed), 'superseded request must not commit');
assert(coordinator.fail(newer), 'current failure must clear in-flight state');
assert(coordinator.begin(`${signature}:newer`) !== undefined, 'failed signature must be retryable');
coordinator.invalidate();
assert(!coordinator.isCommitted(signature), 'invalidation must clear the committed signature');
