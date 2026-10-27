/**
 * Scroll containers are positioned (S7b-18). Visually hidden text (`sr-only`) is absolutely
 * positioned; inside a scroll box that is not itself positioned, it escapes the box's
 * clipping and widens the whole page (the full ATT&CK matrix did, in every browser).
 * jsdom does no layout, so the rule is checked on the class names in the source.
 */
import { describe, expect, it } from 'vitest';

const sources = import.meta.glob<string>('../src/**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('scroll containers', () => {
  it('are positioned, so absolute descendants scroll and clip with them', () => {
    const offending: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      for (const [literal] of text.matchAll(
        /(['"`])[^'"`\n]*\boverflow-(?:x-|y-)?(?:auto|scroll)\b[^'"`\n]*\1/g,
      )) {
        if (!/\b(?:relative|absolute|fixed|sticky)\b/.test(literal))
          offending.push(`${file}: ${literal}`);
      }
    }
    expect(offending).toEqual([]);
  });
});
