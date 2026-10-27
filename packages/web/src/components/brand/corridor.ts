/**
 * "Corridor", Centinela's drawn letters (docs/decisions/S7b.md, brand sheet): one-unit
 * monoline strokes on an orthogonal grid that turn corners with a one-unit radius, like a
 * corridor of a maze. Paths are stroke centrelines; the glyph box is 7 units tall (ascender
 * at 0, x-height at 2, baseline at 7). Used for the wordmark and the Overview numbers only.
 */

export interface Glyph {
  /** Advance width without tracking, in units. */
  width: number;
  /** Stroke centreline path. */
  d: string;
  /** Square drawn in the threat colour (the tittle of the i). */
  dot?: { x: number; y: number };
}

/** Letters of the wordmark, lowercase. */
export const LETTERS: Readonly<Record<string, Glyph>> = {
  c: { width: 4, d: 'M3.5 2.5H1.5A1 1 0 0 0 0.5 3.5V5.5A1 1 0 0 0 1.5 6.5H3.5' },
  e: {
    width: 4,
    d: 'M0.5 4.6H3.5V3.5A1 1 0 0 0 2.5 2.5H1.5A1 1 0 0 0 0.5 3.5V5.5A1 1 0 0 0 1.5 6.5H3.5',
  },
  n: { width: 4, d: 'M0.5 7V3.5A1 1 0 0 1 1.5 2.5H2.5A1 1 0 0 1 3.5 3.5V7' },
  t: { width: 3, d: 'M1 0.6V5.5A1 1 0 0 0 2 6.5H2.8M0 2.5H2.8' },
  i: { width: 1, d: 'M0.5 2V7', dot: { x: 0, y: 0 } },
  l: { width: 2, d: 'M0.5 0V5.5A1 1 0 0 0 1.5 6.5H1.8' },
  a: { width: 4, d: 'M3.5 2.5H1.5A1 1 0 0 0 0.5 3.5V5.5A1 1 0 0 0 1.5 6.5H3.5M3.5 2V7' },
};

/** Digits, as tall as the ascender (0 to 7). */
export const DIGITS: Readonly<Record<string, Glyph>> = {
  '0': {
    width: 4,
    d: 'M0.5 1.5A1 1 0 0 1 1.5 0.5H2.5A1 1 0 0 1 3.5 1.5V5.5A1 1 0 0 1 2.5 6.5H1.5A1 1 0 0 1 0.5 5.5Z',
  },
  '1': { width: 4, d: 'M0.9 0.5H2.1V7' },
  '2': {
    width: 4,
    d: 'M0.5 0.5H2.5A1 1 0 0 1 3.5 1.5V2.5A1 1 0 0 1 2.5 3.5H1.5A1 1 0 0 0 0.5 4.5V6.5H3.6',
  },
  '3': {
    width: 4,
    d: 'M0.4 0.5H2.5A1 1 0 0 1 3.5 1.5V2.5A1 1 0 0 1 2.5 3.5H1.2M2.5 3.5A1 1 0 0 1 3.5 4.5V5.5A1 1 0 0 1 2.5 6.5H0.4',
  },
  '4': { width: 4, d: 'M0.5 0V4.5H3.8M2.6 2.2V7' },
  '5': { width: 4, d: 'M3.6 0.5H0.5V3.5H2.5A1 1 0 0 1 3.5 4.5V5.5A1 1 0 0 1 2.5 6.5H0.4' },
  '6': {
    width: 4,
    d: 'M3.4 0.5H1.5A1 1 0 0 0 0.5 1.5V5.5A1 1 0 0 0 1.5 6.5H2.5A1 1 0 0 0 3.5 5.5V4.5A1 1 0 0 0 2.5 3.5H0.5',
  },
  '7': { width: 4, d: 'M0.4 0.5H2.5A1 1 0 0 1 3.5 1.5V7' },
  '8': {
    width: 4,
    d: 'M1.5 0.5H2.5A1 1 0 0 1 3.5 1.5V2.5A1 1 0 0 1 2.5 3.5H1.5A1 1 0 0 1 0.5 2.5V1.5A1 1 0 0 1 1.5 0.5ZM1.5 3.5H2.5A1 1 0 0 1 3.5 4.5V5.5A1 1 0 0 1 2.5 6.5H1.5A1 1 0 0 1 0.5 5.5V4.5A1 1 0 0 1 1.5 3.5Z',
  },
  '9': {
    width: 4,
    d: 'M0.6 6.5H2.5A1 1 0 0 0 3.5 5.5V1.5A1 1 0 0 0 2.5 0.5H1.5A1 1 0 0 0 0.5 1.5V2.5A1 1 0 0 0 1.5 3.5H3.5',
  },
};

/** Separators drawn as filled rectangles (x, y, width, height), not strokes. */
export const MARKS: Readonly<
  Record<string, { width: number; rect: [number, number, number, number] }>
> = {
  ',': { width: 1, rect: [0, 6, 1, 1.8] },
  '.': { width: 1, rect: [0, 6, 1, 1] },
};

export const TRACKING = 0.9;

export interface LaidOutGlyph {
  x: number;
  char: string;
}

/**
 * Positions of each character, in units, and the total width. Characters without a glyph
 * (a narrow no-break space in some locales) become a one-unit gap.
 */
export function layout(
  text: string,
  glyphs: Readonly<Record<string, Glyph>>,
): { items: LaidOutGlyph[]; width: number } {
  const items: LaidOutGlyph[] = [];
  let x = 0;
  for (const char of text) {
    items.push({ x, char });
    const advance = glyphs[char]?.width ?? MARKS[char]?.width ?? 1;
    x += advance + TRACKING;
  }
  return { items, width: Math.max(0, x - TRACKING) };
}
