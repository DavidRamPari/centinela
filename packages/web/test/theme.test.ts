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

/** Text on a background: WCAG AA for normal text (4.5:1). */
const TEXT_PAIRS: Array<[fg: string, bg: string]> = [
  ...['bg', 'raised', 'hover', 'selected'].flatMap((bg): Array<[string, string]> => [
    ['fg', bg],
    ['muted', bg],
    ['link', bg],
  ]),
  ['faint', 'bg'],
  ['faint', 'raised'],
  ['accent-text', 'bg'],
  ['accent-fg', 'accent'],
  ['accent-fg', 'accent-hover'],
  ['accent-fg', 'accent-pressed'],
  ['danger', 'bg'],
  ['danger', 'raised'],
  ['danger-fg', 'danger-fill'],
  ['ok', 'bg'],
  ['ok', 'raised'],
  ['warn', 'bg'],
  ['warn', 'raised'],
  ['disabled-fg', 'disabled'],
  // The critical label is written in red; the other levels write their label in `fg`.
  ['sev-critical', 'bg'],
  ['sev-critical', 'raised'],
  ['frightened-fg', 'frightened'],
  ...['a', 'c'].flatMap((scale) =>
    [0, 1, 2, 3, 4].map((step): [string, string] => [
      `heat-${scale}-${step}-fg`,
      `heat-${scale}-${step}`,
    ]),
  ),
];

/** Graphical objects and control boundaries (WCAG 1.4.11, 3:1). */
const GRAPHIC_PAIRS: Array<[fg: string, bg: string]> = [
  ['line-strong', 'bg'],
  ['line-strong', 'raised'],
  ['focus', 'bg'],
  ['focus', 'raised'],
  // A yellow button's edge (yellow itself on black, dark gold on white).
  ['accent-edge', 'bg'],
  ['chart-events', 'bg'],
  ['chart-alerts', 'bg'],
  ...['informational', 'low', 'medium', 'high', 'critical'].map((level): [string, string] => [
    `sev-${level}`,
    'bg',
  ]),
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

    it(`meet 3:1 for controls, focus, pips and chart marks in the ${theme} theme`, () => {
      const palette = tokens(selector);
      for (const [fg, bg] of GRAPHIC_PAIRS) {
        const ratio = contrast(palette[fg] ?? '', palette[bg] ?? '');
        expect(ratio, `${theme}: ${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it('use true black as the dark base', () => {
    expect(tokens('.dark').bg).toBe('#000000');
  });

  it('define the same tokens in both themes', () => {
    expect(Object.keys(tokens('.dark')).sort()).toEqual(Object.keys(tokens(':root')).sort());
  });
});
