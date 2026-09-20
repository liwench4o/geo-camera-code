import { cameraCatalog, loadCameraCatalog, validateCameraCatalog } from './catalog';
import { getCameraTargetRequirementBadge, getCameraTargetRequirementTooltip } from './targetBadges';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function cloneCatalog() {
  return JSON.parse(JSON.stringify(cameraCatalog)) as typeof cameraCatalog;
}

function testStrictFrameCatalogIsVersionedAndValid() {
  assert(cameraCatalog.revision.length > 0, 'camera catalog should declare a root revision.');
  assert(cameraCatalog.strictFrame.version === 1, 'strict frame configuration should declare version 1.');
  assert(validateCameraCatalog(cameraCatalog).length === 0, 'the real camera catalog should pass validation.');
}

function testCatalogRejectsNonFiniteStrictFrameCoefficients() {
  const coefficientCases: Array<[string, (catalog: typeof cameraCatalog) => void]> = [
    ['occupancy.elevation', (catalog) => (catalog.strictFrame.contentMapping.occupancy.elevation = Number.NaN)],
    ['pitch.elevationDeg', (catalog) => (catalog.strictFrame.contentMapping.pitch.elevationDeg = Infinity)],
    [
      'bearingOrientationWeight',
      (catalog) => (catalog.strictFrame.contentMapping.bearingOrientationWeight = Number.NEGATIVE_INFINITY),
    ],
    ['motion.coverage', (catalog) => (catalog.strictFrame.contentMapping.motion.coverage = Number.NaN)],
    ['speed.curvature', (catalog) => (catalog.strictFrame.contentMapping.speed.curvature = Infinity)],
    ['weights.occupancy', (catalog) => (catalog.strictFrame.weights.occupancy = Number.NaN)],
  ];

  for (const [field, mutate] of coefficientCases) {
    const catalog = cloneCatalog();
    mutate(catalog);
    assert(
      validateCameraCatalog(catalog).some((error) => error.includes(field)),
      `strict frame ${field} should reject non-finite values.`,
    );
  }
}

function testCatalogRejectsUnorderedCloserWiderRange() {
  const catalog = cloneCatalog();
  catalog.strictFrame.contentMapping.closerWiderOccupancy = [0.48, 0.78];

  assert(
    validateCameraCatalog(catalog).some((error) => error.includes('closerWiderOccupancy')),
    'Closer-Wider occupancy should require near occupancy to be greater than far occupancy.',
  );
}

function testCatalogRejectsNonPositiveStrictFrameSolverValues() {
  const fields = [
    'pitchStepDeg',
    'bearingStepDeg',
    'zoomTolerance',
    'meterSupportTolerancePx',
    'meterSupportIntervalBudget',
    'anchorAlignmentMaxIterations',
    'anchorTolerancePx',
    'evaluationBudget',
    'parameterBoxBudget',
  ] as const;

  for (const field of fields) {
    const catalog = cloneCatalog();
    catalog.strictFrame.solver[field] = 0;
    assert(
      validateCameraCatalog(catalog).some((error) => error.includes(field)),
      `strict frame solver.${field} should be positive.`,
    );
  }
}

function testCatalogRejectsUnknownFallbackLevelsAndMissingVersions() {
  const unknownFallback = cloneCatalog();
  unknownFallback.strictFrame.fallbackLevels = ['preferred', 'crop' as 'preferred'];
  assert(
    validateCameraCatalog(unknownFallback).some((error) => error.includes('fallbackLevels')),
    'strict frame fallback levels should be closed over the supported sequence.',
  );

  const missingRootRevision = cloneCatalog() as unknown as Record<string, unknown>;
  delete missingRootRevision.revision;
  assert(
    validateCameraCatalog(missingRootRevision as unknown as typeof cameraCatalog).some((error) =>
      error.includes('revision'),
    ),
    'strict-v2 catalog should require a root revision.',
  );

  const missingStrictVersion = cloneCatalog() as unknown as { strictFrame: Record<string, unknown> };
  delete missingStrictVersion.strictFrame.version;
  assert(
    validateCameraCatalog(missingStrictVersion as unknown as typeof cameraCatalog).some((error) =>
      error.includes('version'),
    ),
    'strict frame configuration should require its version.',
  );
}

function testLegacyCatalogMigrationIsVersionedAndDoesNotMutateSource() {
  const legacy = cloneCatalog() as Omit<typeof cameraCatalog, 'revision' | 'strictFrame'> & {
    revision?: string;
    strictFrame?: typeof cameraCatalog.strictFrame;
  };
  delete legacy.revision;
  delete legacy.strictFrame;
  legacy.cameras = legacy.cameras.filter((camera) => camera.id !== 'comparison-side-by-side');
  const comparisonDefault = legacy.defaults.find(
    (entry) => entry.purpose === 'comparison' && entry.targetType === 'multiple',
  );
  assert(comparisonDefault !== undefined, '5fa7f27 fixture should contain the comparison default');
  comparisonDefault!.cameraId = 'comparison-pull-out';
  const sourceBefore = JSON.stringify(legacy);

  const loaded = loadCameraCatalog(legacy);
  const loadedAgain = loadCameraCatalog(JSON.parse(sourceBefore));

  assert(loaded.strictFrame.version === 1, 'legacy catalog migration should install strict frame v1 defaults.');
  assert(
    loaded.revision.startsWith('legacy-camera-library-v2-') && loaded.revision === loadedAgain.revision,
    'the exact 5fa7f27 catalog shape should receive a deterministic source-derived revision',
  );
  assert(JSON.stringify(legacy) === sourceBefore, 'legacy catalog migration should not mutate its source object.');
  assert(
    loaded.strictFrame !== cameraCatalog.strictFrame,
    'legacy catalog migration should clone compatibility defaults instead of sharing mutable state.',
  );
  assert(
    validateCameraCatalog(loaded).length === 0,
    `the exact 5fa7f27 catalog shape should validate after migration: ${validateCameraCatalog(loaded).join('; ')}`,
  );
}

function testCatalogRejectsEdgeOffsetRatioInRecipeFraming() {
  // offsetRatio of exactly +-0.5 puts the desired anchor on the viewport edge, which degenerates the
  // safety window and silently disables fitting, so recipe validation must use the exclusive bound.
  const [firstCamera, ...restCameras] = cameraCatalog.cameras;
  const errors = validateCameraCatalog({
    ...cameraCatalog,
    cameras: [
      {
        ...firstCamera,
        recipe: {
          ...firstCamera.recipe,
          framing: {
            ...firstCamera.recipe.framing,
            offsetRatio: [0.5, 0],
          },
        },
      },
      ...restCameras,
    ],
  });

  assert(
    errors.some((error) => error.includes('offsetRatio')),
    'recipe framing.offsetRatio at the edge value 0.5 should fail catalog validation',
  );
}

function testCameraTargetRequirementBadges() {
  assert(
    getCameraTargetRequirementBadge('comparison-pull-out').label === 'Requires 2 targets',
    'comparison cameras should show the comparison badge label.',
  );
  assert(
    getCameraTargetRequirementBadge('overview-tracking').label === 'Path only',
    'path-only cameras should show the path-only badge label.',
  );
  assert(
    getCameraTargetRequirementBadge('dynamic-pan').label === 'No target required',
    'current-view cameras should show the optional-target badge label.',
  );
  assert(
    getCameraTargetRequirementBadge('emphasis-push-in').label === 'Requires target',
    'target-based cameras should show the required-target badge label.',
  );
}

function testCameraTargetRequirementTooltipKeepsDescriptionAndRequirement() {
  const tooltip = getCameraTargetRequirementTooltip('dynamic-pan', 'Subtly pan the current view to add continuity.');

  assert(
    tooltip.description === 'Subtly pan the current view to add continuity.',
    'camera tooltip should keep the detailed description.',
  );
  assert(
    tooltip.requirement.label === 'No target required',
    'camera tooltip should include the target requirement label.',
  );
}

function testSplitPresentationRequiresComparisonMultipleTargetPolicy() {
  const wrongPurpose = cloneCatalog();
  const wrongPurposeCamera = wrongPurpose.cameras.find((camera) => camera.id === 'comparison-side-by-side');
  assert(wrongPurposeCamera !== undefined, 'split camera fixture should exist');
  wrongPurposeCamera!.purpose = 'overview';
  assert(
    validateCameraCatalog(wrongPurpose).some((error) => error.includes('split presentation requires comparison')),
    'split presentation should reject a non-comparison purpose',
  );

  const wrongTargetType = cloneCatalog();
  const wrongTargetTypeCamera = wrongTargetType.cameras.find((camera) => camera.id === 'comparison-side-by-side');
  assert(wrongTargetTypeCamera !== undefined, 'split camera fixture should exist');
  wrongTargetTypeCamera!.targetTypes = ['location'];
  assert(
    validateCameraCatalog(wrongTargetType).some((error) => error.includes('split presentation requires only multiple')),
    'split presentation should reject target types that cannot carry the comparison pair',
  );

  const missingComparisonPolicy = cloneCatalog();
  const missingComparisonPolicyCamera = missingComparisonPolicy.cameras.find(
    (camera) => camera.id === 'comparison-side-by-side',
  );
  assert(missingComparisonPolicyCamera !== undefined, 'split camera fixture should exist');
  missingComparisonPolicyCamera!.recipe.targetPolicy = {
    ...missingComparisonPolicyCamera!.recipe.targetPolicy,
    requiresComparison: false,
  };
  assert(
    validateCameraCatalog(missingComparisonPolicy).some((error) =>
      error.includes('split presentation requires comparison target snapshots'),
    ),
    'split presentation should require comparison snapshots',
  );
}

testStrictFrameCatalogIsVersionedAndValid();
testCatalogRejectsNonFiniteStrictFrameCoefficients();
testCatalogRejectsUnorderedCloserWiderRange();
testCatalogRejectsNonPositiveStrictFrameSolverValues();
testCatalogRejectsUnknownFallbackLevelsAndMissingVersions();
testLegacyCatalogMigrationIsVersionedAndDoesNotMutateSource();

testCatalogRejectsEdgeOffsetRatioInRecipeFraming();
testCameraTargetRequirementBadges();
testCameraTargetRequirementTooltipKeepsDescriptionAndRequirement();
testSplitPresentationRequiresComparisonMultipleTargetPolicy();
