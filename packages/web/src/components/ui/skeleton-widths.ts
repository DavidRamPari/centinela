/** Widths for lines of placeholder text (`SkeletonText`), so a list of them looks like text. */
const LINE_WIDTHS = ['w-3/4', 'w-1/2', 'w-2/3', 'w-5/6', 'w-2/5', 'w-3/5'] as const;

/** A width class for the line at `index`, the same on every render. */
export function lineWidth(index: number): string {
  return LINE_WIDTHS[index % LINE_WIDTHS.length] ?? 'w-2/3';
}
