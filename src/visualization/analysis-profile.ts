export class RuntimeAnalysisProfileCache {
  private entries = new WeakMap<object, Map<string, unknown>>();

  getOrCreate<Value>(owner: object, key: string, create: () => Value): Value {
    let keyedEntries = this.entries.get(owner);
    if (!keyedEntries) {
      keyedEntries = new Map();
      this.entries.set(owner, keyedEntries);
    }

    if (keyedEntries.has(key)) {
      return keyedEntries.get(key) as Value;
    }

    const value = create();
    keyedEntries.set(key, value);
    return value;
  }
}

export const runtimeAnalysisProfileCache = new RuntimeAnalysisProfileCache();
