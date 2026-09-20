import { canonicalJson, digestCanonical } from './canonical-digest';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertThrows(action: () => unknown, message: string) {
  let threw = false;

  try {
    action();
  } catch {
    threw = true;
  }

  assert(threw, message);
}

function testCanonicalJsonSortsObjectKeysRecursivelyAndPreservesArrayOrder() {
  const first = {
    z: [{ second: 2, first: 1 }, 'tail'],
    a: 'head',
  };
  const second = {
    a: 'head',
    z: [{ first: 1, second: 2 }, 'tail'],
  };

  assert(
    canonicalJson(first) === '{"a":"head","z":[{"first":1,"second":2},"tail"]}',
    'canonical JSON should recursively sort object keys while preserving array order',
  );
  assert(canonicalJson(first) === canonicalJson(second), 'object insertion order should not change canonical JSON');
  assert(digestCanonical(first) === digestCanonical(second), 'equal canonical values should have the same digest');
}

function testChangedValuesChangeTheDigest() {
  const original = digestCanonical({ value: 1, nested: ['stable'] });
  const changed = digestCanonical({ value: 2, nested: ['stable'] });

  assert(original !== changed, 'changing a serialized value should change the digest');
  assert(/^[0-9a-f]{16}$/.test(original), 'the digest should be exactly 16 lowercase hexadecimal characters');
}

function testUndefinedMatchesJsonObjectAndArraySemantics() {
  const sparse: unknown[] = [1, undefined];
  sparse.length = 3;

  assert(
    canonicalJson({ omit: undefined, keep: 1, nested: { omit: undefined, keep: true }, sparse }) ===
      '{"keep":1,"nested":{"keep":true},"sparse":[1,null,null]}',
    'undefined object properties should be omitted and undefined or empty array slots should become null',
  );
}

function testUnsupportedValuesAreRejected() {
  assertThrows(() => canonicalJson({ invalid: () => undefined }), 'functions should be rejected');
  assertThrows(() => canonicalJson({ invalid: Symbol('invalid') }), 'symbols should be rejected');
  assertThrows(() => canonicalJson({ invalid: Number.NaN }), 'NaN should be rejected');
  assertThrows(() => canonicalJson([Number.POSITIVE_INFINITY]), 'positive infinity should be rejected');
  assertThrows(() => canonicalJson(Number.NEGATIVE_INFINITY), 'negative infinity should be rejected');

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assertThrows(() => canonicalJson(cyclic), 'cyclic values should be rejected');
}

function testCanonicalizationNeverMutatesInput() {
  const input = {
    z: { second: 2, first: 1 },
    a: [{ beta: 'b', alpha: 'a' }, 3, 2, 1],
  };
  const topLevelKeyOrder = Object.keys(input).join(',');
  const nestedKeyOrder = Object.keys(input.z).join(',');
  const arrayBefore = JSON.stringify(input.a);

  canonicalJson(input);
  digestCanonical(input);

  assert(Object.keys(input).join(',') === topLevelKeyOrder, 'canonicalization should not reorder top-level keys');
  assert(Object.keys(input.z).join(',') === nestedKeyOrder, 'canonicalization should not reorder nested keys');
  assert(JSON.stringify(input.a) === arrayBefore, 'canonicalization should not alter array contents or order');
}

function testDigestUsesUtf8Bytes() {
  const vectors: Array<[value: string, expected: string]> = [
    ['hello', 'df47ee8b99d02c17'],
    ['é', '6dd86cf9a431ce6d'],
    ['😀', '9edc1cbe3eb3f6ea'],
  ];

  for (const [value, expected] of vectors) {
    const actual = digestCanonical(value);
    assert(actual === expected, `digest for ${JSON.stringify(value)}: expected ${expected}, received ${actual}`);
  }
}

function testDigestDoesNotRequireGlobalTextEncoder() {
  const textEncoderGlobal = globalThis as unknown as { TextEncoder: typeof TextEncoder | undefined };
  const originalTextEncoder = textEncoderGlobal.TextEncoder;

  try {
    textEncoderGlobal.TextEncoder = undefined;
    assert(digestCanonical('é') === '6dd86cf9a431ce6d', 'BMP Unicode digest should not require TextEncoder');
    assert(digestCanonical('😀') === '9edc1cbe3eb3f6ea', 'surrogate-pair digest should not require TextEncoder');
  } finally {
    textEncoderGlobal.TextEncoder = originalTextEncoder;
  }
}

function testCanonicalJsonRejectsNonPlainObjects() {
  class CustomInstance {}

  const unsupportedValues: Array<[label: string, value: object]> = [
    ['Date', new Date(0)],
    ['Map', new Map()],
    ['Set', new Set()],
    ['custom class', new CustomInstance()],
  ];
  const accepted: string[] = [];

  for (const [label, value] of unsupportedValues) {
    try {
      canonicalJson(value);
      accepted.push(label);
    } catch {
      // Expected: only arrays and plain objects are canonical JSON containers.
    }
  }

  assert(
    accepted.length === 0,
    `canonical JSON should reject non-plain object instances; accepted ${accepted.join(', ')}`,
  );

  const nullPrototype = Object.create(null) as Record<string, unknown>;
  nullPrototype.z = 2;
  nullPrototype.a = 1;
  assert(canonicalJson(nullPrototype) === '{"a":1,"z":2}', 'null-prototype plain objects should remain supported');
}

function testReviewRegressions() {
  const cases: Array<[name: string, action: () => void]> = [
    ['TextEncoder independence', testDigestDoesNotRequireGlobalTextEncoder],
    ['plain object restriction', testCanonicalJsonRejectsNonPlainObjects],
  ];
  const failures: string[] = [];

  for (const [name, action] of cases) {
    try {
      action();
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      failures.push(`${name}: ${detail}`);
    }
  }

  assert(failures.length === 0, `review regressions failed:\n${failures.join('\n')}`);
}

function getLoneSurrogateContractFailures(): string[] {
  const highSurrogate = '\ud800';
  const lowSurrogate = '\udc00';
  const cases: Array<[label: string, actual: string, expected: string]> = [
    ['high-surrogate value JSON', canonicalJson(highSurrogate), '"\\ud800"'],
    ['low-surrogate value JSON', canonicalJson(lowSurrogate), '"\\udc00"'],
    ['high-surrogate key JSON', canonicalJson({ [highSurrogate]: 1 }), '{"\\ud800":1}'],
    ['low-surrogate key JSON', canonicalJson({ [lowSurrogate]: 1 }), '{"\\udc00":1}'],
    ['high-surrogate value digest', digestCanonical(highSurrogate), '3ffd2a2cf76d1568'],
    ['low-surrogate value digest', digestCanonical(lowSurrogate), '1cf735d37313941f'],
    ['high-surrogate key digest', digestCanonical({ [highSurrogate]: 1 }), '0132f085b2180119'],
    ['low-surrogate key digest', digestCanonical({ [lowSurrogate]: 1 }), 'b4e01b986f4a612c'],
  ];

  return cases.filter(([, actual, expected]) => actual !== expected).map(([label]) => label);
}

function testCanonicalStringEscapes() {
  assert(canonicalJson('"') === '"\\\""', 'quotes should use the standard JSON escape');
  assert(canonicalJson('\\') === '"\\\\"', 'backslashes should use the standard JSON escape');
  assert(canonicalJson('\b') === '"\\b"', 'backspace should use the short JSON escape');
  assert(canonicalJson('\t') === '"\\t"', 'tab should use the short JSON escape');
  assert(canonicalJson('\n') === '"\\n"', 'newline should use the short JSON escape');
  assert(canonicalJson('\f') === '"\\f"', 'form feed should use the short JSON escape');
  assert(canonicalJson('\r') === '"\\r"', 'carriage return should use the short JSON escape');
  assert(canonicalJson('\u0000') === '"\\u0000"', 'NUL should use a lowercase four-digit JSON escape');
  assert(canonicalJson('\u001f') === '"\\u001f"', 'other controls should use lowercase four-digit JSON escapes');
  assert(canonicalJson('😀') === '"😀"', 'valid surrogate pairs should remain intact');
}

function testLoneSurrogateQuotingIsEngineIndependent() {
  assert(
    getLoneSurrogateContractFailures().length === 0,
    'modern JSON.stringify should satisfy the pinned lone-surrogate contract',
  );

  const originalStringify = JSON.stringify;
  try {
    JSON.stringify = ((value: unknown) => {
      const serialized = originalStringify(value);
      if (typeof value !== 'string' || serialized === undefined) {
        return serialized;
      }
      return serialized.split('\\ud800').join('\ud800').split('\\udc00').join('\udc00');
    }) as typeof JSON.stringify;

    const failures = getLoneSurrogateContractFailures();
    assert(
      failures.length === 0,
      `lone-surrogate canonicalization should not depend on JSON.stringify; failed ${failures.join(', ')}`,
    );
  } finally {
    JSON.stringify = originalStringify;
  }
}

testCanonicalJsonSortsObjectKeysRecursivelyAndPreservesArrayOrder();
testChangedValuesChangeTheDigest();
testUndefinedMatchesJsonObjectAndArraySemantics();
testUnsupportedValuesAreRejected();
testCanonicalizationNeverMutatesInput();
testDigestUsesUtf8Bytes();
testReviewRegressions();
testCanonicalStringEscapes();
testLoneSurrogateQuotingIsEngineIndependent();
