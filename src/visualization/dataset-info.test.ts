import assert from 'node:assert/strict';
import { visualizationCatalog } from './catalog';
import { getDatasetInformation } from './dataset-info';

for (const visualization of visualizationCatalog.visualizations) {
  const ids = visualization.datasetParam
    ? visualization
        .parameters!.find((parameter) => parameter.key === visualization.datasetParam)!
        .options!.map((option) => String(option.value))
    : [visualization.datasetId];
  for (const id of ids) {
    const info = getDatasetInformation(id, visualization.id);
    assert.ok(info.description.trim().length > 0, `${id} has a dataset introduction`);
    assert.ok(info.visualization.trim().length > 0, `${id} explains the current visual encoding`);
    assert.ok(info.sources.length > 0, `${id} links to source material`);
    for (const source of info.sources) assert.equal(new URL(source.url).protocol, 'https:');
  }
}
const bart = getDatasetInformation('bart-ridership', 'line');
assert.match(bart.description, /60/);
assert.match(bart.description, /August 2026/);
assert.match(bart.visualization, /width|thicker/i);
assert.deepEqual(
  bart.legend?.map((entry) => entry.label),
  ['Transbay', 'Same-side'],
);
assert.match(getDatasetInformation('commute', 'line').visualization, /brighter/i);
assert.match(getDatasetInformation('bike-parking', 'hexagon').visualization, /locations.*not.*spaces/i);
for (const id of ['upload:line', 'upload:hexagon', 'unlisted-dataset', undefined]) {
  const info = getDatasetInformation(id, 'line');
  assert.deepEqual(info.sources, [], 'unverified data must not borrow example source attribution');
  assert.equal(info.legend, undefined, 'uploads must not inherit BART connection categories');
  assert.doesNotMatch(info.visualization, /BART|commuter|Transbay/i);
  assert.ok(info.description.length > 0 && info.visualization.length > 0);
}
console.log('Dataset information covers all examples, visual encodings, and isolated upload fallback.');
