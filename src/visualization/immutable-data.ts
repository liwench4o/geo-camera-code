interface PlainDataSnapshotOptions {
  label: string;
  maxDepth: number;
  maxNodes: number;
  createError?: (message: string) => Error;
}

interface TraversalEntry {
  value: unknown;
  depth: number;
  exiting?: boolean;
}

interface AsyncCacheEntry<Value> {
  promise: Promise<Value>;
  settled: boolean;
}

function fail(options: PlainDataSnapshotOptions, message: string): never {
  throw options.createError?.(message) ?? new TypeError(message);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function getEnumerableDataProperties(value: object, options: PlainDataSnapshotOptions): string[] {
  if (Array.isArray(value)) {
    const keys: string[] = [];
    let indexCount = 0;
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') {
        continue;
      }
      if (
        typeof key !== 'string' ||
        !Number.isInteger(Number(key)) ||
        Number(key) < 0 ||
        Number(key) >= value.length ||
        String(Number(key)) !== key
      ) {
        fail(options, `${options.label} arrays must be dense and contain standard indices only.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        fail(options, `${options.label} arrays must be dense and contain standard indices only.`);
      }
      keys.push(key);
      indexCount += 1;
    }
    if (indexCount !== value.length) {
      fail(options, `${options.label} arrays must be dense and contain standard indices only.`);
    }
    return keys;
  }

  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      fail(options, `${options.label} must contain enumerable string data properties only.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      fail(options, `${options.label} must contain data properties only.`);
    }
    if (!descriptor.enumerable) {
      fail(options, `${options.label} must contain enumerable string data properties only.`);
    }
    keys.push(key);
  }

  return keys;
}

function assertPlainData(value: unknown, options: PlainDataSnapshotOptions): void {
  const stack: TraversalEntry[] = [{ value, depth: 0 }];
  const ancestors = new Set<object>();
  const greatestVisitedDepth = new Map<object, number>();
  let nodeCount = 0;

  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (entry.exiting) {
      ancestors.delete(entry.value as object);
      continue;
    }

    nodeCount += 1;
    if (nodeCount > options.maxNodes) {
      fail(options, `${options.label} exceed maximum node count ${options.maxNodes}.`);
    }
    if (entry.depth > options.maxDepth) {
      fail(options, `${options.label} exceed maximum depth ${options.maxDepth}.`);
    }

    const valueType = typeof entry.value;
    if (entry.value === null || valueType === 'string' || valueType === 'boolean' || valueType === 'undefined') {
      continue;
    }
    if (valueType === 'number') {
      if (!Number.isFinite(entry.value)) {
        fail(options, `${options.label} must not contain non-finite numbers.`);
      }
      continue;
    }
    if (valueType !== 'object') {
      fail(options, `${options.label} must contain plain data only.`);
    }

    const objectValue = entry.value as object;
    if (!Array.isArray(objectValue) && !isPlainObject(objectValue)) {
      fail(options, `${options.label} must contain plain objects and arrays only.`);
    }
    if (ancestors.has(objectValue)) {
      fail(options, `${options.label} must not contain cycles.`);
    }
    const previousDepth = greatestVisitedDepth.get(objectValue);
    if (previousDepth !== undefined && previousDepth >= entry.depth) {
      continue;
    }

    greatestVisitedDepth.set(objectValue, entry.depth);
    ancestors.add(objectValue);
    stack.push({ value: objectValue, depth: entry.depth, exiting: true });
    const keys = getEnumerableDataProperties(objectValue, options);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      stack.push({
        value: (objectValue as Record<string, unknown>)[key],
        depth: entry.depth + 1,
      });
    }
  }
}

function createContainer(value: object): Record<string, unknown> | unknown[] {
  if (Array.isArray(value)) {
    return new Array(value.length);
  }
  return Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
}

export function snapshotPlainData<Value>(value: Value, options: PlainDataSnapshotOptions): Value {
  assertPlainData(value, options);
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const sourceRoot = value as object;
  const cloneRoot = createContainer(sourceRoot);
  const clones = new WeakMap<object, Record<string, unknown> | unknown[]>();
  const created: Array<Record<string, unknown> | unknown[]> = [cloneRoot];
  const stack = [sourceRoot];
  clones.set(sourceRoot, cloneRoot);

  while (stack.length > 0) {
    const source = stack.pop()!;
    const target = clones.get(source)!;
    for (const key of Object.keys(source)) {
      const child = (source as Record<string, unknown>)[key];
      if (child !== null && typeof child === 'object') {
        let childClone = clones.get(child);
        if (!childClone) {
          childClone = createContainer(child);
          clones.set(child, childClone);
          created.push(childClone);
          stack.push(child);
        }
        Object.defineProperty(target, key, {
          value: childClone,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } else {
        Object.defineProperty(target, key, {
          value: child,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
  }

  for (let index = created.length - 1; index >= 0; index -= 1) {
    Object.freeze(created[index]);
  }
  return cloneRoot as Value;
}

export function createReadonlyMapSnapshot<Key, Value>(
  entries: Iterable<readonly [Key, Value]>,
): ReadonlyMap<Key, Value> {
  const values = new Map<Key, Value>(entries);
  const facade: ReadonlyMap<Key, Value> = {
    get size() {
      return values.size;
    },
    get: (key: Key) => values.get(key),
    has: (key: Key) => values.has(key),
    entries: () => values.entries(),
    keys: () => values.keys(),
    values: () => values.values(),
    forEach: (callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void, thisArg?: unknown) =>
      values.forEach((value, key) => callback.call(thisArg, value, key, facade)),
    [Symbol.iterator]: () => values[Symbol.iterator](),
  };
  return Object.freeze(facade);
}

export class BoundedAsyncCache<Key, Value> {
  private readonly entries = new Map<Key, AsyncCacheEntry<Value>>();

  constructor(
    private readonly capacity: number,
    private readonly maxEntries = capacity * 2,
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('Async cache capacity must be a positive integer.');
    }
    if (!Number.isInteger(maxEntries) || maxEntries < capacity) {
      throw new RangeError('Async cache maximum entries must be an integer no smaller than capacity.');
    }
  }

  getOrCreate(key: Key, loader: () => Promise<Value> | Value): Promise<Value> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.promise;
    }
    this.evictSettledEntries(Math.max(0, this.capacity - 1));
    if (this.entries.size >= this.maxEntries) {
      return Promise.reject(new AsyncCacheSaturatedError(this.maxEntries));
    }

    const entry = { promise: undefined as unknown as Promise<Value>, settled: false };
    const promise = Promise.resolve()
      .then(loader)
      .then(
        (value) => {
          entry.settled = true;
          this.evictSettledEntries(this.capacity);
          return value;
        },
        (error: unknown) => {
          if (this.entries.get(key) === entry) {
            this.entries.delete(key);
          }
          throw error;
        },
      );
    entry.promise = promise;
    this.entries.set(key, entry);
    return promise;
  }

  private evictSettledEntries(targetSize: number): void {
    while (this.entries.size > targetSize) {
      const settled = [...this.entries].find(([, entry]) => entry.settled);
      if (!settled) {
        return;
      }
      this.entries.delete(settled[0]);
    }
  }
}

export class AsyncCacheSaturatedError extends Error {
  constructor(maxEntries: number) {
    super(`Async cache is saturated at ${maxEntries} entries.`);
    this.name = 'AsyncCacheSaturatedError';
  }
}
