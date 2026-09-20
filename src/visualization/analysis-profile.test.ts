import { RuntimeAnalysisProfileCache } from './analysis-profile';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const cache = new RuntimeAnalysisProfileCache();
const rows = Object.freeze([{ longitude: 1, latitude: 2 }]);
let builds = 0;
const first = cache.getOrCreate(rows, 'coordinates:v1', () => ({ id: ++builds }));
const second = cache.getOrCreate(rows, 'coordinates:v1', () => ({ id: ++builds }));
assert(first === second && builds === 1, 'same rows and key must reuse a profile');

const changedKey = cache.getOrCreate(rows, 'cluster:500', () => ({ id: ++builds }));
assert(changedKey !== first, 'parameter-dependent key must not reuse invariant profile');

const uploadedRows = Object.freeze([{ longitude: 1, latitude: 2 }]);
const uploaded = cache.getOrCreate(uploadedRows, 'coordinates:v1', () => ({ id: ++builds }));
assert(uploaded !== first, 'different row identity must not reuse a profile');
