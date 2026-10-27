/**
 * The motion rules of S7b-17, checked on the source: motion answers an action or explains
 * a change, takes 100 to 200 ms with ease-out and never bounces; the only ambient motion is
 * the slow loading pulse (and the busy spinner); and prefers-reduced-motion turns it all
 * off. jsdom applies no CSS, so these rules are read from the stylesheet and the classes.
 */
import { describe, expect, it } from 'vitest';
import css from '../src/index.css?raw';

const sources = import.meta.glob<string>('../src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function block(selectorPattern: RegExp): string {
  const match = selectorPattern.exec(css);
  if (!match) throw new Error(`no block for ${String(selectorPattern)}`);
  // Up to the matching closing brace.
  let depth = 0;
  for (let i = match.index; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(match.index, i + 1);
    }
  }
  throw new Error('unbalanced CSS');
}

/** `--animate-name: keyframes 160ms ease-out` declarations of the theme. */
const animations = [...css.matchAll(/--animate-([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => ({
  name: name ?? '',
  value: value ?? '',
}));

/** Ambient animations allowed to loop: the loading pulse (S7b-17). */
const AMBIENT = new Set(['skeleton']);

describe('motion rules (S7b-17)', () => {
  it('declares the animations it uses', () => {
    expect(animations.map((a) => a.name).sort()).toEqual(
      ['drawer-in', 'expand-in', 'fade-in', 'sheet-in', 'skeleton', 'toast-in'].sort(),
    );
  });

  it('keeps every answer to an action at 100 to 200 ms, ease-out, played once', () => {
    for (const { name, value } of animations.filter((a) => !AMBIENT.has(a.name))) {
      const ms = Number(/(\d+)ms/.exec(value)?.[1]);
      expect(ms, name).toBeGreaterThanOrEqual(100);
      expect(ms, name).toBeLessThanOrEqual(200);
      expect(value, name).toMatch(/\bease-out\b/);
      expect(value, name).not.toMatch(/infinite|alternate|cubic-bezier/);
    }
  });

  it('makes the loading pulse slow, and only between the two skeleton greys', () => {
    const pulse = animations.find((a) => a.name === 'skeleton')?.value ?? '';
    const seconds = Number(/([\d.]+)s\b/.exec(pulse)?.[1]);
    expect(seconds).toBeGreaterThanOrEqual(1.2);
    const keyframes = block(/@keyframes skeleton\s*\{/);
    expect(keyframes).toContain('var(--c-skeleton)');
    expect(keyframes).toContain('var(--c-skeleton-hi)');
    expect(keyframes).not.toMatch(/transform|opacity/);
  });

  it('gives transitions an ease-out default of 150 ms', () => {
    expect(css).toMatch(/--default-transition-duration:\s*150ms/);
    expect(css).toMatch(/--default-transition-timing-function:\s*cubic-bezier\(0, 0, 0\.2, 1\)/);
  });

  it('turns every animation and transition off under prefers-reduced-motion', () => {
    const reduced = block(/@media \(prefers-reduced-motion: reduce\)\s*\{/);
    expect(reduced).toMatch(/\*,\s*\*::before,\s*\*::after/);
    expect(reduced).toMatch(/animation-duration:\s*0\.01ms !important/);
    expect(reduced).toMatch(/animation-iteration-count:\s*1 !important/);
    expect(reduced).toMatch(/transition-duration:\s*0\.01ms !important/);
  });

  it('uses only 100 to 200 ms durations and no bouncing or easing-in classes', () => {
    const offending: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      for (const [, ms] of text.matchAll(/\bduration-(\d+)\b/g)) {
        const value = Number(ms);
        if (value < 100 || value > 200) offending.push(`${file}: duration-${ms}`);
      }
      for (const [match] of text.matchAll(
        /\b(?:animate-(?:bounce|ping|pulse)|ease-in-out|ease-in|ease-linear)\b/g,
      )) {
        offending.push(`${file}: ${match}`);
      }
      // Smooth scrolling ignores the reduced-motion rule above.
      if (/behavior:\s*['"]smooth['"]|scroll-smooth/.test(text)) offending.push(`${file}: smooth`);
    }
    expect(offending).toEqual([]);
  });

  it('draws charts without entry animations', () => {
    const chart = sources['../src/features/overview/TimeSeriesChart.tsx'] ?? '';
    const series = [...chart.matchAll(/<(Area|Bar)\s[^>]*>/gs)].map(([tag]) => tag);
    expect(series.length).toBeGreaterThan(0);
    for (const tag of series) expect(tag).toContain('isAnimationActive={false}');
  });
});
