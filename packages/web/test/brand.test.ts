import { describe, expect, it } from 'vitest';
import { brandFiles } from '../src/components/brand/svg';

// The committed files, read as text (Vite raw imports).
const files = import.meta.glob<string>(['../public/brand/*.svg', '../public/favicon.svg'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('brand files', () => {
  it('match the geometry the app draws (regenerate with scripts/brand-assets.ts)', () => {
    const expected = brandFiles();
    expect(Object.keys(files).map((path) => path.split('/').pop()).sort()).toEqual(
      Object.keys(expected).sort(),
    );
    for (const [path, text] of Object.entries(files)) {
      const name = path.split('/').pop() ?? '';
      expect(text, name).toBe(expected[name]);
    }
  });

  it('contain no script, link or external reference', () => {
    for (const [path, text] of Object.entries(files)) {
      expect(text, path).not.toMatch(/<script|href=|url\(|https?:\/\/(?!www\.w3\.org)/i);
    }
  });
});
