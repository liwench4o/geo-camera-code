import assert from 'node:assert/strict';
import type { CameraView } from '../interfaces';
import { createStoryJson, parseStoryJson } from './serialization';

const view: CameraView = { longitude: 179, latitude: 35, zoom: 22, pitch: 75, bearing: -190, altitude: 1.7 };
const scene = JSON.stringify(['scatter', 'places', 'revision-1']);
for (const trajectoryEnabled of [false, true]) {
  const source = { ...view, transitionDuration: 500, transitionEasing: (t: number) => t };
  const homeViews = { [scene]: source, other: { ...view, longitude: -30 } };
  const options = { trajectoryEnabled, homeViews };
  const story = createStoryJson([], options);
  assert('homeViews' in story, 'home-only projects retain their bookmarks on export');
  assert.deepEqual(
    story.homeViews,
    { [scene]: view, other: { ...view, longitude: -30 } },
    'export stores semantic views only',
  );
  const parsed = parseStoryJson(JSON.parse(JSON.stringify(story)));
  assert(parsed.ok && 'homeViews' in parsed, 'Story import returns saved home views');
  assert.deepEqual(parsed.homeViews, story.homeViews);
  const exported = story.homeViews as Record<string, CameraView>;
  source.longitude = 0;
  assert.equal(exported[scene].longitude, 179, 'export does not retain live references');
  exported[scene].latitude = 0;
  assert.equal((parsed.homeViews as Record<string, CameraView>)[scene].latitude, 35, 'import is detached');
  for (const invalid of [
    null,
    [],
    { bad: {} },
    { bad: { ...view, latitude: 91 } },
    { bad: { ...view, zoom: 30 } },
    { bad: { ...view, altitude: 0 } },
    { bad: { ...view, pitch: -1 } },
  ]) {
    assert.equal(
      parseStoryJson({ ...story, homeViews: invalid }).ok,
      false,
      'invalid home metadata rejects the whole import',
    );
  }
  const old = createStoryJson([], { trajectoryEnabled });
  assert(!('homeViews' in old), 'old output remains unchanged without bookmarks');
  assert(parseStoryJson(old).ok, 'old stories remain readable');
}
assert(parseStoryJson([]).ok, 'legacy camera arrays remain readable');
console.log('Scene home view v1/v2 persistence and validation passed.');
