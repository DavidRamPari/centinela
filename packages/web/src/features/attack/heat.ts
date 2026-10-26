/** Heat level 0–4 of a matrix cell: 0 means none, 1–4 split the range up to the maximum. */
export function heatLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0;
  const level = Math.ceil((Math.min(count, max) / max) * 4);
  return Math.max(1, Math.min(4, level)) as 1 | 2 | 3 | 4;
}

export const HEAT_CLASSES = [
  'bg-heat-0 text-heat-0-fg',
  'bg-heat-1 text-heat-1-fg',
  'bg-heat-2 text-heat-2-fg',
  'bg-heat-3 text-heat-3-fg',
  'bg-heat-4 text-heat-4-fg',
] as const;
