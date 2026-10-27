/** Heat level 0–4 of a matrix cell: 0 means none, 1–4 split the range up to the maximum. */
export function heatLevel(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || max <= 0) return 0;
  const level = Math.ceil((Math.min(count, max) / max) * 4);
  return Math.max(1, Math.min(4, level)) as 1 | 2 | 3 | 4;
}

/**
 * Cell colours per view: alert counts on a pink scale ("where the threats showed up"),
 * rule coverage on a blue one ("the ground we guard"). Level 0 is plain text on the page.
 */
export const HEAT_CLASSES = {
  alerts: [
    'bg-heat-a-0 text-heat-a-0-fg',
    'bg-heat-a-1 text-heat-a-1-fg',
    'bg-heat-a-2 text-heat-a-2-fg',
    'bg-heat-a-3 text-heat-a-3-fg',
    'bg-heat-a-4 text-heat-a-4-fg',
  ],
  coverage: [
    'bg-heat-c-0 text-heat-c-0-fg',
    'bg-heat-c-1 text-heat-c-1-fg',
    'bg-heat-c-2 text-heat-c-2-fg',
    'bg-heat-c-3 text-heat-c-3-fg',
    'bg-heat-c-4 text-heat-c-4-fg',
  ],
} as const;
