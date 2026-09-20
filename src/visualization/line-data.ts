import type { Color } from '@deck.gl/core';
import type { CustomObject } from '../interfaces';

export function getLineSource(row: CustomObject): number[] {
  return Array.isArray(row.start) ? row.start : [Number(row.residence_lng), Number(row.residence_lat)];
}

export function getLineTarget(row: CustomObject): number[] {
  return Array.isArray(row.end) ? row.end : [Number(row.workplace_lng), Number(row.workplace_lat)];
}

export function getLineColor(row: CustomObject): Color {
  if (!Array.isArray(row.start) || !Array.isArray(row.end)) {
    return [1, 152, 189, 255 * (Number(row.all_flows) / 5000)];
  }
  return row.connection_type === 'same-side' ? [245, 183, 89, 155] : [68, 208, 224, 195];
}

export function getLineWidth(row: CustomObject): number {
  const trips = Number(row.average_weekday_trips);
  return Number.isFinite(trips) && trips > 0 ? 1.5 + 4.5 * Math.sqrt(Math.min(trips / 2500, 1)) : 1;
}

export function getLineTooltip(row: CustomObject): string {
  if (!Array.isArray(row.start) || !Array.isArray(row.end)) {
    return `all_flows: ${row.all_flows}\nsource: [${row.residence_lng}, ${row.residence_lat}]\ntarget: [${row.workplace_lng}, ${row.workplace_lat}]`;
  }
  if (row.period === '2026-08' && row.source_name && row.target_name) {
    const count = (value: unknown) => Math.round(Number(value)).toLocaleString('en-US');
    return `${row.name}\nAverage weekday · Aug 2026\n${count(row.average_weekday_trips)} trips / day · both directions\n${row.source_name} → ${row.target_name}: ${count(row.forward_weekday_trips)}\nReverse: ${count(row.reverse_weekday_trips)}\n${row.connection_type === 'transbay' ? 'Transbay' : 'Same-side'} connection\nStation-to-station demand, not rail routes`;
  }
  const position = (point: number[]) => `[${point[0].toFixed(4)}, ${point[1].toFixed(4)}]`;
  return `${row.name || 'Connection'}\nStart: ${position(row.start)}\nEnd: ${position(row.end)}`;
}
