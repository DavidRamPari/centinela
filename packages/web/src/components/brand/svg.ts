/**
 * The brand as standalone SVG text, for the files in `public/brand/` and the favicon
 * (docs/decisions/S7b.md, brand sheet). Same geometry as `Mark` and `Wordmark`.
 */
import { LETTERS, layout } from './corridor';
import { MARK_PATHS } from './mark-paths';

export const BRAND_COLORS = {
  black: '#000000',
  yellow: '#FFDE3D',
  red: '#FF453A',
  blue: '#3A3AF2',
  ink: '#0B0B14',
} as const;

interface Colors {
  defender: string;
  ground: string;
  threat: string;
  /** Wordmark letters. */
  letters: string;
  /** Thin outline around the yellow piece, for white backgrounds. */
  keyline?: string;
}

const ON_BLACK: Colors = {
  defender: BRAND_COLORS.yellow,
  ground: BRAND_COLORS.blue,
  threat: BRAND_COLORS.red,
  letters: BRAND_COLORS.yellow,
};
const ON_WHITE: Colors = { ...ON_BLACK, letters: BRAND_COLORS.ink, keyline: BRAND_COLORS.ink };
const MONO: Colors = {
  defender: 'currentColor',
  ground: 'currentColor',
  threat: 'currentColor',
  letters: 'currentColor',
};

function markShapes(colors: Colors, dx = 0, dy = 0, scale = 1): string {
  const { threat } = MARK_PATHS;
  const keyline = colors.keyline
    ? ` stroke="${colors.keyline}" stroke-width="0.4" paint-order="stroke"`
    : '';
  return [
    `<g transform="translate(${dx} ${dy}) scale(${scale})">`,
    `<path fill="${colors.defender}"${keyline} d="${MARK_PATHS.defender}"/>`,
    `<path fill="${colors.ground}" d="${MARK_PATHS.ground}"/>`,
    `<rect fill="${colors.threat}" x="${threat.x}" y="${threat.y}" width="${threat.size}" height="${threat.size}" rx="${threat.radius}"/>`,
    '</g>',
  ].join('');
}

/** The mark alone on its 16-unit grid; `background` adds a rounded tile (favicon). */
export function markSvg(colors: Colors = ON_BLACK, background?: string): string {
  const tile = background ? `<rect width="16" height="16" rx="3" fill="${background}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${tile}${markShapes(colors)}</svg>\n`;
}

/** Mark and wordmark side by side: 16 units of mark, a 4-unit gap, then the letters. */
export function lockupSvg(colors: Colors, background?: string): string {
  const { items, width } = layout('centinela', LETTERS);
  // Letters are 7 units tall; scale them to 11.5 of the mark's 16 and centre them.
  const letterScale = 11.5 / 7;
  const letterX = 20;
  const letterY = (16 - 7 * letterScale) / 2;
  const total = letterX + width * letterScale;
  const pad = 2;
  const letters = items
    .map(({ x, char }) => {
      const glyph = LETTERS[char];
      if (!glyph) return '';
      const dot = glyph.dot
        ? `<rect fill="${colors.threat}" x="${glyph.dot.x}" y="${glyph.dot.y}" width="1" height="1"/>`
        : '';
      return `<g transform="translate(${x} 0)"><path fill="none" stroke="${colors.letters}" stroke-width="1" d="${glyph.d}"/>${dot}</g>`;
    })
    .join('');
  const tile = background
    ? `<rect x="${-pad}" y="${-pad}" width="${total + 2 * pad}" height="${16 + 2 * pad}" fill="${background}"/>`
    : '';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${(total + 2 * pad).toFixed(2)} ${16 + 2 * pad}">`,
    tile,
    markShapes(colors),
    `<g transform="translate(${letterX} ${letterY.toFixed(3)}) scale(${letterScale.toFixed(4)})">${letters}</g>`,
    '</svg>\n',
  ].join('');
}

/** Every brand file, by name. */
export function brandFiles(): Record<string, string> {
  return {
    'centinela-mark.svg': markSvg(ON_BLACK),
    'centinela-mark-on-white.svg': markSvg(ON_WHITE),
    'centinela-mark-mono.svg': markSvg(MONO),
    'centinela-lockup-on-black.svg': lockupSvg(ON_BLACK, BRAND_COLORS.black),
    'centinela-lockup-on-white.svg': lockupSvg(ON_WHITE, '#FFFFFF'),
    'centinela-lockup-mono.svg': lockupSvg(MONO),
    'favicon.svg': markSvg(ON_BLACK, BRAND_COLORS.black),
  };
}
