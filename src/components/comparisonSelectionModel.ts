import type { CameraTarget } from '../camera/types';

export const SELECTION_COLORS: [number, number, number][] = [
  [104, 177, 154],
  [119, 160, 211],
];

export function getSelectionObjectName(target: CameraTarget): string {
  const row = target.selectedRows?.length === 1 ? target.selectedRows[0] : undefined;
  for (const key of ['name', 'Name', 'NAME', 'title', 'Title', 'airport', 'station']) {
    if (typeof row?.[key] === 'string' && row[key].trim()) return row[key].trim();
  }
  // Generated labels contain geometry summaries, not an object's name.
  if (target.label?.trim() && !/^(\[|Path\b|Region\b|Heatmap\b|Multiple\b|Selected\b)/i.test(target.label)) {
    return target.label.trim();
  }
  const reference = target.sourceFeatures?.length === 1 ? target.sourceFeatures[0].value : (row?.rid ?? row?.id);
  if (reference !== undefined) return `${target.type === 'path' ? 'Path' : 'Object'} ${reference}`;
  return `[${target.center.map((coordinate) => Number(coordinate.toFixed(5))).join(', ')}]`;
}
