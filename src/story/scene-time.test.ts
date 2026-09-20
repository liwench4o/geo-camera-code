import assert from 'node:assert/strict';
import type { PlaybackSegment } from '../interfaces';
import { getSceneTimeAtPlaybackTime, validateAnimationBinding, type AnimationBinding } from './scene-time';

const binding: AnimationBinding = {
  version: 1,
  visualizationId: 'animated',
  datasetId: 'cab-trips',
  layerId: 'trips',
  dataRevision: '1',
  pathDigest: 'path',
  timeRange: [1191, 1868.948],
};
function segment(start: number, duration: number, stay: number, animationBinding?: AnimationBinding): PlaybackSegment {
  return {
    start,
    duration,
    stay,
    end: start + duration + stay,
    camera: { animationBinding },
  } as unknown as PlaybackSegment;
}
const segments = [
  segment(0, 1000, 0),
  segment(1000, 4000, 1000, binding),
  segment(6000, 2000, 0),
  segment(8000, 2000, 0, { ...binding, pathDigest: 'next', timeRange: [200, 400] }),
];
assert.equal(getSceneTimeAtPlaybackTime(segments, 0)?.time, 1191, 'lead-in holds first data time');
assert.equal(getSceneTimeAtPlaybackTime(segments, 3000)?.time, (1191 + 1868.948) / 2);
assert.equal(getSceneTimeAtPlaybackTime(segments, 5500)?.time, 1868.948, 'stay never wraps at 1800');
assert.equal(getSceneTimeAtPlaybackTime(segments, 7500)?.time, 1868.948, 'ordinary shot holds preceding data time');
assert.equal(getSceneTimeAtPlaybackTime(segments, 8000)?.time, 200, 'new shot has explicit data start');
assert.equal(getSceneTimeAtPlaybackTime(segments, 20000)?.time, 400, 'completion holds last data end');
assert.equal(
  getSceneTimeAtPlaybackTime(segments, 3000)?.time,
  (1191 + 1868.948) / 2,
  'backward seeking is deterministic',
);
assert.equal(getSceneTimeAtPlaybackTime([segment(0, 1000, 0)], 500), undefined, 'legacy stories do not gain a clock');
assert.equal(
  getSceneTimeAtPlaybackTime([segment(0, 0, 0, binding)], 0)?.time,
  1191,
  'reset preview holds the initial data time',
);
assert(validateAnimationBinding(binding));
for (const invalid of [
  { ...binding, timeRange: [2, 1] },
  { ...binding, timeRange: [1, NaN] },
  { ...binding, datasetId: '' },
  { ...binding, version: 2 },
])
  assert.equal(validateAnimationBinding(invalid), false);
console.log('scene time mapping tests passed');
