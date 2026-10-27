// @vitest-environment node
/**
 * Link previews (S7b-18): the description always; Open Graph and Twitter cards with
 * absolute URLs only when VITE_PUBLIC_URL gives the public origin; and the preview image.
 */
import { readFileSync } from 'node:fs';
import type { HtmlTagDescriptor, ResolvedConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';
import {
  LINK_PREVIEW,
  PREVIEW_IMAGE,
  linkPreviewTags,
  parsePublicUrl,
  type MetaTag,
} from '../link-preview/meta';
import { linkPreview } from '../link-preview/vite-plugin';

const ORIGIN = 'https://centinela.example.org';

function find(tags: MetaTag[], key: string): string | undefined {
  return tags.find((tag) => ('property' in tag ? tag.property : tag.name) === key)?.content;
}

describe('VITE_PUBLIC_URL', () => {
  it('is optional', () => {
    for (const value of [undefined, null, '', '   ']) expect(parsePublicUrl(value)).toBeUndefined();
  });

  it('keeps the origin of an http(s) URL', () => {
    expect(parsePublicUrl(`${ORIGIN}/`)).toBe(ORIGIN);
    expect(parsePublicUrl(` ${ORIGIN} `)).toBe(ORIGIN);
    expect(parsePublicUrl('http://localhost:4173')).toBe('http://localhost:4173');
  });

  it('fails the build for anything but a bare origin', () => {
    for (const value of [
      'centinela.example.org',
      `${ORIGIN}/demo`,
      `${ORIGIN}/?utm=1`,
      `${ORIGIN}/#top`,
      'ftp://centinela.example.org',
      'javascript:alert(1)',
      'https://user:pass@centinela.example.org',
      42,
    ]) {
      expect(() => parsePublicUrl(value), String(value)).toThrow(/VITE_PUBLIC_URL must be/);
    }
  });
});

describe('link preview tags', () => {
  it('carry only the description without a public origin', () => {
    expect(linkPreviewTags(undefined)).toEqual([
      { name: 'description', content: LINK_PREVIEW.description },
    ]);
  });

  it('make a large-image card with absolute URLs when the origin is known', () => {
    const tags = linkPreviewTags(ORIGIN);
    const image = `${ORIGIN}${PREVIEW_IMAGE.path}`;
    expect(find(tags, 'og:url')).toBe(`${ORIGIN}/`);
    expect(find(tags, 'og:image')).toBe(image);
    expect(find(tags, 'twitter:image')).toBe(image);
    expect(find(tags, 'og:image:width')).toBe('1200');
    expect(find(tags, 'og:image:height')).toBe('630');
    expect(find(tags, 'twitter:card')).toBe('summary_large_image');
    expect(find(tags, 'og:title')).toBe(LINK_PREVIEW.title);
    expect(find(tags, 'og:description')).toBe(LINK_PREVIEW.description);
    expect(find(tags, 'og:image:alt')).toBe(LINK_PREVIEW.imageAlt);
    for (const tag of tags) expect(tag.content.trim()).not.toBe('');
  });

  it('keeps the description short enough for search results and cards', () => {
    expect(LINK_PREVIEW.description.length).toBeLessThanOrEqual(160);
  });

  it('are written by the Vite plugin from the resolved environment', () => {
    const html = (env: Record<string, string>) => {
      const plugin = linkPreview();
      const configResolved = plugin.configResolved;
      const transform = plugin.transformIndexHtml;
      if (typeof configResolved !== 'function' || typeof transform !== 'function') {
        throw new Error('unexpected plugin shape');
      }
      // The hooks only read `config.env` and return tags; a minimal context is enough.
      const context = {} as ThisParameterType<typeof configResolved>;
      void configResolved.call(context, { env } as unknown as ResolvedConfig);
      const transformContext = {} as ThisParameterType<typeof transform>;
      return transform.call(transformContext, '', {
        path: '/index.html',
        filename: 'index.html',
      }) as HtmlTagDescriptor[];
    };
    const without = html({});
    expect(without).toHaveLength(1);
    const withOrigin = html({ VITE_PUBLIC_URL: ORIGIN });
    expect(withOrigin.every((tag) => tag.tag === 'meta' && tag.injectTo === 'head')).toBe(true);
    expect(withOrigin.map((tag) => tag.attrs)).toContainEqual({
      property: 'og:image',
      content: `${ORIGIN}${PREVIEW_IMAGE.path}`,
    });
  });

  it('are never hard-coded in index.html', () => {
    expect(indexHtml).not.toMatch(/og:|twitter:|name="description"/);
  });
});

describe('preview image', () => {
  const png = readFileSync(new URL(`../public${PREVIEW_IMAGE.path}`, import.meta.url));

  it('is a 1200 x 630 PNG', () => {
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(PREVIEW_IMAGE.width);
    expect(png.readUInt32BE(20)).toBe(PREVIEW_IMAGE.height);
  });

  it('is small enough for messaging apps', () => {
    expect(png.length).toBeLessThan(300 * 1024);
  });
});
