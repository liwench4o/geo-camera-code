import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { CameraMovement } from '../interfaces';
import type { CameraTarget } from '../camera/types';
import { createPointTarget } from '../camera/selection';
import { createSnapshotEnvelope } from '../camera/geometry/envelope';
import { computeComparisonPaneViews } from '../components/comparisonSplitModel';
import { derivePlaybackPlan, getViewAtPlaybackTime } from './playback';
import { getCameraPlanningViewport } from './planning-viewport';
import { createStoryJson, parseStoryJson } from './serialization';
import { getSplitPresentationAtPlaybackTime } from './split-presentation';

const viewport = { width: 1000, height: 600 };
const playbackOptions = { trajectoryEnabled: true, content: 'playback' as const, viewport };
const view = { longitude: 0, latitude: 0, zoom: 8, pitch: 0, bearing: 0 };
const camera = (overrides: Partial<CameraMovement> = {}): CameraMovement => ({
  name: 'overview',
  title: 'Overview',
  category: 'static',
  initViewState: view,
  finalViewState: view,
  duration: 1000,
  stay: 200,
  isRotating: false,
  interpolationType: 'none',
  interpolationDuration: 0,
  ...overrides,
});

function heatmapTarget() {
  return {
    ...createPointTarget([0, 0]),
    source: 'heatmap-zone',
    label: 'Hotspot',
    count: 3993,
    coordinates: [
      [0, 0],
      [0.01, 0.01],
    ],
    selectedRows: Array.from({ length: 3993 }, (_, id) => ({ id, details: 'event'.repeat(20) })),
    snapshotEnvelope: { runtime: 'large rendered support' },
  };
}

void test('playback removes planning payload recursively while full and legacy formats remain compatible', () => {
  const heatmap = heatmapTarget();
  const geometry = { ...heatmapTarget(), source: 'draw', type: 'path', id: 'drawn-path' };
  const source = camera({
    targetSnapshot: { ...heatmap, children: [heatmap, geometry] },
    comparisonTargetSnapshots: [heatmap, geometry],
    debugInfo: { recipeId: 'overview', profileId: 'default', reasons: {} },
    recommendation: { recipeId: 'overview', source: 'resolved-recipe' },
    annotation: { text: 'Keep this caption', delay: 10, duration: 500 },
  });
  const original = JSON.stringify(source);
  for (const trajectoryEnabled of [false, true]) {
    const options = { ...playbackOptions, trajectoryEnabled };
    const full = createStoryJson([source], { ...options, content: 'full' });
    assert.deepEqual(createStoryJson([source], { trajectoryEnabled, viewport }), full);
    const fullMovement = full.version === 2 ? full.cameras[0].movement : full.cameras[0];
    assert.deepEqual(fullMovement.targetSnapshot, source.targetSnapshot);
    const story = createStoryJson([source], options);
    const movement = story.version === 2 ? story.cameras[0].movement : story.cameras[0];
    const target = movement.targetSnapshot as ReturnType<typeof heatmapTarget> & { children: (typeof geometry)[] };
    assert.equal(target.selectedRows, undefined);
    assert.equal(target.snapshotEnvelope, undefined);
    assert.equal(target.coordinates, undefined);
    assert.equal(target.count, 3993);
    assert.equal(target.label, 'Hotspot');
    assert.equal(target.children[0].coordinates, undefined);
    assert.equal(target.children[1].selectedRows, undefined);
    assert.equal(target.children[1].snapshotEnvelope, undefined);
    assert.deepEqual(target.children[1].coordinates, geometry.coordinates);
    assert.equal(movement.debugInfo, undefined);
    assert.equal(movement.recommendation, undefined);
    assert.deepEqual(movement.annotation, source.annotation);
    const comparisons = movement.comparisonTargetSnapshots as (typeof geometry)[];
    assert.equal(comparisons[0].snapshotEnvelope, undefined);
    assert.deepEqual(comparisons[1].coordinates, geometry.coordinates);
    const parsed = parseStoryJson(JSON.parse(JSON.stringify(story)));
    assert.ok(parsed.ok);
    assert.deepEqual(createStoryJson(parsed.cameras, options), story);
    assert.ok(parseStoryJson(full).ok);
    if (full.version === 1) assert.ok(parseStoryJson(full.cameras).ok);
  }
  assert.equal(JSON.stringify(source), original, 'export must not change the original targets');
});

void test('discarded payload is excluded before traversal; retained data still uses the safe serializer', () => {
  const discarded = {
    get expensive() {
      throw new Error('must not read runtime rows');
    },
  };
  const source = camera({
    targetSnapshot: {
      ...heatmapTarget(),
      selectedRows: discarded,
      snapshotEnvelope: discarded,
      coordinates: discarded,
    },
    debugInfo: discarded as never,
    recommendation: discarded as never,
    framingReport: discarded as never,
  });
  assert.doesNotThrow(() => createStoryJson([source], playbackOptions));
  assert.throws(() => createStoryJson([source]), /accessors/);
  assert.throws(
    () => createStoryJson([camera({ targetSnapshot: { ...heatmapTarget(), label: discarded } })], playbackOptions),
    /accessors/,
  );
  const cyclic: Record<string, unknown> = heatmapTarget();
  cyclic.children = [cyclic];
  assert.throws(() => createStoryJson([camera({ targetSnapshot: cyclic })], playbackOptions), /cyclic/);
});

void test('split playback retains envelopes and yields the same pane views after export and import', () => {
  const targets = [createPointTarget([0, 0]), createPointTarget([1, 1])];
  for (const target of targets) {
    const envelope = createSnapshotEnvelope({
      id: target.id,
      supportGuarantee: 'conservative',
      provenance: {
        datasetId: 'data',
        visualizationId: 'vis',
        layerId: 'points',
        dataRevision: '1',
        visualizationRevision: '1',
        producerId: 'test',
        producerVersion: 1,
        sceneRevision: '1',
        resolvedLayerDigest: '1',
      },
      anchor: [...target.center, 0],
      primitives: [{ kind: 'point-disc', position: [...target.center, 0], radius: { value: 40, unit: 'pixels' } }],
      metrics: {
        elevation: 0,
        density: 0,
        coverage: 0,
        dispersion: 0,
        elongation: 0,
        curvature: 0,
        calibrationVersion: 1,
        fallbackReasons: [],
      },
    });
    assert.equal(envelope.status, 'ok');
    if (envelope.status === 'ok') target.snapshotEnvelope = envelope.value;
    target.selectedRows = [{ raw: 'discard even for split' }];
  }
  const source = camera({ presentation: 'split', comparisonTargetSnapshots: targets });
  const originalPlan = derivePlaybackPlan([source], playbackOptions);
  const story = createStoryJson([source], playbackOptions);
  const parsed = parseStoryJson(story);
  assert.ok(parsed.ok);
  const importedPlan = derivePlaybackPlan(parsed.cameras, playbackOptions);
  const before = getSplitPresentationAtPlaybackTime(originalPlan.segments, 500);
  const after = getSplitPresentationAtPlaybackTime(importedPlan.segments, 500);
  assert.ok(before && after);
  assert.ok(after.targets.every((target) => !target.selectedRows?.length));
  assert.deepEqual(
    after.targets.map((target) => target.snapshotEnvelope),
    before.targets.map((target) => target.snapshotEnvelope),
  );
  const panes = (pair: [CameraTarget, CameraTarget]) =>
    computeComparisonPaneViews({ targets: pair, baseView: view, viewportSize: viewport }).map((pane) => pane.viewState);
  assert.deepEqual(panes(after.targets), panes(before.targets));
});

for (const name of ['story-uk-road-safety', 'story-us-gun-violence']) {
  void test(`${name}: compact sample stays below 64 KiB and preserves all playback samples`, () => {
    const wire = readFileSync(`assets/story/${name}.json`, 'utf8');
    assert.ok(Buffer.byteLength(wire) < 64 * 1024, 'checked-in sample must also stay compact');
    const parsed = parseStoryJson(JSON.parse(wire));
    assert.ok(parsed.ok);
    const options = { ...playbackOptions, homeViews: parsed.homeViews };
    const full = createStoryJson(parsed.cameras, { ...options, content: 'full' });
    const compact = createStoryJson(parsed.cameras, options);
    assert.equal(compact.version, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(compact, null, 2) + '\n') < 64 * 1024);
    const reimported = parseStoryJson(compact);
    assert.ok(reimported.ok);
    assert.equal(reimported.cameras.length, 6);
    assert.deepEqual(createStoryJson(reimported.cameras, options), compact);
    assert.deepEqual(reimported.homeViews, parsed.homeViews);
    assert.ok(full.version === 2 && compact.version === 2);
    compact.cameras.forEach((entry, index) => {
      const original = full.cameras[index];
      assert.deepEqual({ ...entry, movement: undefined }, { ...original, movement: undefined });
      for (const key of [
        'id',
        'name',
        'title',
        'duration',
        'stay',
        'startDelay',
        'annotation',
        'authoring',
        'initViewState',
        'finalViewState',
      ] as const) {
        assert.deepEqual(entry.movement[key], original.movement[key]);
      }
      assert.equal(entry.movement.framingReport, undefined);
      assert.deepEqual(
        getCameraPlanningViewport(reimported.cameras[index]),
        getCameraPlanningViewport(parsed.cameras[index]),
      );
    });
    const before = derivePlaybackPlan(parsed.cameras, options);
    const after = derivePlaybackPlan(reimported.cameras, options);
    assert.equal(before.totalTime, 46000);
    assert.equal(after.totalTime, before.totalTime);
    for (let time = 0; time <= before.totalTime; time += 125) {
      assert.deepEqual(
        getViewAtPlaybackTime(after.segments, time),
        getViewAtPlaybackTime(before.segments, time),
        `${name} at ${time}ms`,
      );
    }
  });
}
