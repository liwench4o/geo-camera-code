import { cameraCatalog, validateCameraCatalog } from './catalog';
import { DEFAULT_FRAMING_TUNING, resolveFramingTuning } from './tuning';
import type { CameraLibraryTuning } from './types';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertClose(actual: number, expected: number, message: string) {
  assert(Math.abs(actual - expected) < 1e-6, `${message}: expected ${expected}, received ${actual}`);
}

function testResolveFramingTuningMergesLayers() {
  const tuning = resolveFramingTuning(
    'overview',
    { motionStrength: -0.5 },
    {
      global: { framingTightness: 0.2, speedScale: 1.5 },
      byPurpose: { overview: { framingTightness: 0.4 } },
    },
  );

  assertClose(tuning.framingTightness ?? Number.NaN, 0.4, 'byPurpose tuning should override global tuning');
  assertClose(tuning.speedScale ?? Number.NaN, 1.5, 'global tuning should survive when byPurpose omits a field');
  assertClose(tuning.motionStrength ?? Number.NaN, -0.5, 'input tuning should override library tuning');
  assertClose(tuning.anchorHeightRatio ?? Number.NaN, 0.5, 'defaults should fill fields no layer provides');
}

function testResolveFramingTuningDefaultsWithoutLibraryConfig() {
  const tuning = resolveFramingTuning('emphasis', undefined, undefined);

  assertClose(
    tuning.anchorHeightRatio ?? Number.NaN,
    DEFAULT_FRAMING_TUNING.anchorHeightRatio ?? Number.NaN,
    'missing library tuning should fall back to module defaults',
  );
  assertClose(tuning.framingTightness ?? Number.NaN, 0, 'default framing tightness should be neutral');
  assertClose(tuning.speedScale ?? Number.NaN, 1, 'default speed scale should be neutral');
}

function testCatalogValidatesTuningRanges() {
  const errors = validateCameraCatalog({
    ...cameraCatalog,
    tuning: {
      global: { framingTightness: 2 },
      byPurpose: { emphasis: { anchorHeightRatio: 1.5 } },
    },
  });

  assert(
    errors.some((error) => error.includes('framingTightness')),
    'out-of-range framingTightness should fail catalog validation',
  );
  assert(
    errors.some((error) => error.includes('anchorHeightRatio')),
    'out-of-range anchorHeightRatio should fail catalog validation',
  );
}

function testCatalogValidatesTuningEdgeCases() {
  const errors = validateCameraCatalog({
    ...cameraCatalog,
    tuning: {
      global: { speedScale: 0, motionStrength: -2, offsetRatio: [0.5, 0] },
      byPurpose: { bogus: {} },
    } as unknown as CameraLibraryTuning,
  });

  assert(
    errors.some((error) => error.includes('Invalid tuning purpose')),
    'unknown byPurpose key should fail catalog validation',
  );
  assert(
    errors.some((error) => error.includes('speedScale')),
    'non-positive speedScale should fail catalog validation',
  );
  assert(
    errors.some((error) => error.includes('motionStrength')),
    'out-of-range motionStrength should fail catalog validation',
  );
  // offsetRatio of exactly +-0.5 puts the desired anchor on the viewport edge, which degenerates the
  // safety window and silently disables fitting, so the bound must be exclusive.
  assert(
    errors.some((error) => error.includes('offsetRatio')),
    'edge offsetRatio (+-0.5) should fail catalog validation',
  );
}

function testShippedCatalogTuningIsValid() {
  const errors = validateCameraCatalog(cameraCatalog).filter((error) => error.includes('tuning'));
  assert(errors.length === 0, `shipped camera-library tuning should validate, received: ${errors.join(' | ')}`);
}

testResolveFramingTuningMergesLayers();
testResolveFramingTuningDefaultsWithoutLibraryConfig();
testCatalogValidatesTuningRanges();
testCatalogValidatesTuningEdgeCases();
testShippedCatalogTuningIsValid();
