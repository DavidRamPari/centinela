/**
 * Width of a chart's y axis from its longest label (12 px tabular digits are about 7.2 px
 * wide), so four- and five-digit counts never clip (S4 found "1,500" cut to ",500").
 */
export function yAxisWidth(labels: readonly string[]): number {
  const longest = Math.max(1, ...labels.map((label) => label.length));
  return Math.ceil(longest * 7.2) + 12;
}
