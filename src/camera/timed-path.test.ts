import { normalizeTimedPath, sampleTimedPath } from './timed-path';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function near(actual: number, expected: number, message: string) {
  assert(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} != ${expected}`);
}

const coordinates = [
  [0, 60],
  [1, 61],
  [2, 62],
  [2, 62],
  [4, 70],
];
const times = [10, 20, 20, 80, 110];
const snapshot = normalizeTimedPath(coordinates, times);
assert(snapshot, 'a monotone route with positive span is a timed path');
assert(snapshot.version === 1 && snapshot.coordinates.length === 4, 'duplicate times retain only the last point');
assert(snapshot.coordinates[1][0] === 2, 'the last coordinate at a duplicate timestamp is authoritative');
assert(snapshot.timestamps[2] === 80, 'the same point at a later timestamp preserves its stop');
near(sampleTimedPath(snapshot, 50)[0], 2, 'the head remains stationary throughout a stop');
near(sampleTimedPath(snapshot, -10)[0], 0, 'sampling clamps to the first point');
near(sampleTimedPath(snapshot, 900)[0], 4, 'sampling clamps to the last point');
assert(coordinates.length === 5 && times.length === 5, 'normalizing never mutates dataset arrays');
coordinates[0][0] = 30;
assert(snapshot.coordinates[0][0] === 0, 'the snapshot owns an independent coordinate copy');
assert(normalizeTimedPath(snapshot.coordinates, snapshot.timestamps)?.digest === snapshot.digest, 'digest is stable');
assert(normalizeTimedPath(snapshot.coordinates, [10, 21, 80, 110])?.digest !== snapshot.digest, 'digest covers time');

for (const [path, timestamps] of [
  [[[0, 0]], [0]],
  [
    [
      [0, 0],
      [1, 1],
    ],
    [2, 1],
  ],
  [
    [
      [0, 0],
      [1, 1],
    ],
    [1, 1],
  ],
  [
    [
      [0, 0],
      [1, 1],
    ],
    [0],
  ],
  [
    [
      [0, 0],
      [1, 90],
    ],
    [0, 1],
  ],
  [
    [
      [0, 0],
      [NaN, 1],
    ],
    [0, 1],
  ],
  [
    [
      [0, 0],
      [1, 1],
    ],
    [0, Infinity],
  ],
  [
    [
      [0, 0],
      [1, 1],
    ],
    [0, '1'],
  ],
] as unknown[][])
  assert(!normalizeTimedPath(path, timestamps), 'invalid or untimed routes are not bound');

const wrapped = normalizeTimedPath(
  [
    [179, 60],
    [-179, 70],
  ],
  [0, 100],
);
assert(wrapped, 'date-line route is valid');
const midpoint = sampleTimedPath(wrapped, 50);
near(Math.abs(midpoint[0]), 180, 'date-line interpolation follows the short projected segment');
const mercator = (latitude: number) => Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360));
near(mercator(midpoint[1]), (mercator(60) + mercator(70)) / 2, 'head interpolates projected latitude like TripsLayer');
