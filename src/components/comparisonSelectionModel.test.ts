import assert from 'node:assert/strict';
import { createPathTarget, createPointTarget } from '../camera/selection';
import type { CameraTarget } from '../camera/types';
import { getSelectionObjectName } from './comparisonSelectionModel';

const point = createPointTarget([1.00011, 51.00011]);
for (const [target, expected] of [
  [
    {
      ...point,
      selectedRows: [{ id: 42, name: '  Central Station  ', station: 'Station fallback' }],
      label: 'Custom place',
    },
    'Central Station',
  ],
  [
    { ...point, selectedRows: [{ name: '  ', station: '  Harbour Station  ' }], label: 'Custom place' },
    'Harbour Station',
  ],
  [{ ...point, selectedRows: [{ id: 42 }], label: '  Custom place  ' }, 'Custom place'],
  [{ ...point, selectedRows: [{ id: 42 }], label: '  ' }, 'Object 42'],
  [point, '[1.00011, 51.00011]'],
] satisfies [CameraTarget, string][]) {
  assert.equal(getSelectionObjectName(target), expected, 'object names use trimmed metadata before labels and IDs');
}
const path = createPathTarget([
  [1, 51],
  [2, 52],
  [3, 51],
])!;
assert.equal(getSelectionObjectName(path), '[2, 51.5]', 'unnamed paths use their center instead of a geometry summary');
assert.equal(
  getSelectionObjectName({ ...path, selectedRows: [{ rid: 0, id: 42 }] }),
  'Path 0',
  'zero is a valid path reference and takes precedence over the row ID',
);
