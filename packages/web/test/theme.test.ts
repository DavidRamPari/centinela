import { describe, expect, it } from 'vitest';
// vitest.config.ts enables CSS for index.css only, so this raw import is not empty.
import css from '../src/index.css?raw';

/** WCAG 2.x contrast ratio of two #rrggbb colors. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  const block = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries(
    [...block.matchAll(/--c-([a-z0-9-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [
      m[1] ?? '',
      m[2] ?? '',
    ]),
  );
}

const TEXT_PAIRS: Array<[fg: string, bg: string]> = [
  ['fg', 'bg'],
  ['fg', 'surface'],
  ['fg', 'surface-2'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['muted', 'surface-2'],
  ['accent', 'surface'],
  ['accent', 'bg'],
  ['accent-fg', 'accent'],
  ['danger', 'surface'],
  ['success', 'surface'],
  ['warn', 'surface'],
  ...['informational', 'low', 'medium', 'high', 'critical'].map((level): [string, string] => [
    `sev-${level}-fg`,
    `sev-${level}`,
  ]),
  ...[0, 1, 2, 3, 4].map((step): [string, string] => [`heat-${step}-fg`, `heat-${step}`]),
];

describe('design tokens', () => {
  for (const [theme, selector] of [
    ['light', ':root'],
    ['dark', '.dark'],
  ] as const) {
    it(`meet WCAG AA (4.5:1) for every text pair in the ${theme} theme`, () => {
      const palette = tokens(selector);
      for (const [fg, bg] of TEXT_PAIRS) {
        const ratio = contrast(palette[fg] ?? '', palette[bg] ?? '');
        expect(ratio, `${theme}: ${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('define the same tokens in both themes', () => {
    expect(Object.keys(tokens('.dark')).sort()).toEqual(Object.keys(tokens(':root')).sort());
  });
});
