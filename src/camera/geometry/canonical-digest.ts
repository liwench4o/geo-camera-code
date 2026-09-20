const FNV_PRIME = 0x01000193;
const FNV_SEEDS = [0x811c9dc5, 0x9e3779b9] as const;

function unsupportedValue(type: string): never {
  throw new TypeError(`Cannot canonicalize ${type}`);
}

function unicodeEscape(codeUnit: number): string {
  return `\\u${`0000${codeUnit.toString(16)}`.slice(-4)}`;
}

function quoteJsonString(value: string): string {
  let quoted = '"';

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    switch (codeUnit) {
      case 0x08:
        quoted += '\\b';
        continue;
      case 0x09:
        quoted += '\\t';
        continue;
      case 0x0a:
        quoted += '\\n';
        continue;
      case 0x0c:
        quoted += '\\f';
        continue;
      case 0x0d:
        quoted += '\\r';
        continue;
      case 0x22:
        quoted += '\\"';
        continue;
      case 0x5c:
        quoted += '\\\\';
        continue;
      default:
        break;
    }

    if (codeUnit < 0x20) {
      quoted += unicodeEscape(codeUnit);
      continue;
    }

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        quoted += value[index] + value[index + 1];
        index += 1;
      } else {
        quoted += unicodeEscape(codeUnit);
      }
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      quoted += unicodeEscape(codeUnit);
      continue;
    }

    quoted += value[index];
  }

  return `${quoted}"`;
}

function serializeCanonical(value: unknown, ancestors: Set<object>, arrayItem: boolean): string | undefined {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'string':
      return quoteJsonString(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('Cannot canonicalize a non-finite number');
      }
      return JSON.stringify(value);
    case 'undefined':
      return arrayItem ? 'null' : undefined;
    case 'function':
    case 'symbol':
      return unsupportedValue(typeof value);
    case 'object':
      break;
    default:
      return unsupportedValue(typeof value);
  }

  if (ancestors.has(value)) {
    throw new TypeError('Cannot canonicalize a cyclic value');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        items.push(serializeCanonical(value[index], ancestors, true) as string);
      }
      return `[${items.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Cannot canonicalize a non-plain object');
    }

    const properties: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const propertyValue = (value as Record<string, unknown>)[key];
      const serializedValue = serializeCanonical(propertyValue, ancestors, false);
      if (serializedValue !== undefined) {
        properties.push(`${quoteJsonString(key)}:${serializedValue}`);
      }
    }
    return `{${properties.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function* utf8Bytes(value: string): IterableIterator<number> {
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);

    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (nextCodeUnit - 0xdc00);
        index += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }

    if (codePoint <= 0x7f) {
      yield codePoint;
    } else if (codePoint <= 0x7ff) {
      yield 0xc0 | (codePoint >>> 6);
      yield 0x80 | (codePoint & 0x3f);
    } else if (codePoint <= 0xffff) {
      yield 0xe0 | (codePoint >>> 12);
      yield 0x80 | ((codePoint >>> 6) & 0x3f);
      yield 0x80 | (codePoint & 0x3f);
    } else {
      yield 0xf0 | (codePoint >>> 18);
      yield 0x80 | ((codePoint >>> 12) & 0x3f);
      yield 0x80 | ((codePoint >>> 6) & 0x3f);
      yield 0x80 | (codePoint & 0x3f);
    }
  }
}

function updateFnv1a(hash: number, byte: number): number {
  return Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
}

function digestUtf8(value: string): [number, number] {
  let first = FNV_SEEDS[0] >>> 0;
  let second = FNV_SEEDS[1] >>> 0;

  for (const byte of utf8Bytes(value)) {
    first = updateFnv1a(first, byte);
    second = updateFnv1a(second, byte);
  }

  return [first, second];
}

function toHex32(value: number): string {
  return `00000000${value.toString(16)}`.slice(-8);
}

export function canonicalJson(value: unknown): string {
  const serialized = serializeCanonical(value, new Set<object>(), false);
  if (serialized === undefined) {
    throw new TypeError('Cannot canonicalize undefined as a top-level value');
  }
  return serialized;
}

export function digestCanonical(value: unknown): string {
  const serialized = canonicalJson(value);
  const [first, second] = digestUtf8(serialized);
  return `${toHex32(first)}${toHex32(second)}`;
}
