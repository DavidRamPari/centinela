/**
 * Link previews (S7b-18): what LinkedIn, messaging apps, search engines and a CV's link
 * show for the demo. The dashboard is a single-page app, so every URL serves the same
 * index.html and unfurls as the same card.
 *
 * Open Graph and Twitter cards need absolute URLs, so they are written only when the build
 * knows its public origin (`VITE_PUBLIC_URL`, for example https://centinela.example.org).
 * Without it the page carries the plain description and no card tags at all.
 */
import { z } from 'zod';

export const PRODUCT_NAME = 'Centinela';

/** The preview image in `public/`: the real dashboard, dark theme, demo data. */
export const PREVIEW_IMAGE = { path: '/link-preview.png', width: 1200, height: 630 } as const;

export const LINK_PREVIEW = {
  title: 'Centinela · Open-source SIEM',
  description:
    'Lightweight open-source SIEM: Linux auth and web server logs, Sigma and correlation rules, and alerts mapped to MITRE ATT&CK, in English and Spanish.',
  imageAlt:
    'The Centinela dashboard in its dark theme: new alerts to start with, the most severe first, and activity over time.',
} as const;

const publicUrlSchema = z.string().transform((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'not a URL' });
    return z.NEVER;
  }
  const originOnly =
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === '';
  if (!originOnly) {
    ctx.addIssue({ code: 'custom', message: 'not an http(s) origin' });
    return z.NEVER;
  }
  return url.origin;
});

/**
 * The public origin from `VITE_PUBLIC_URL`, or undefined when it is unset or empty. Anything
 * else than a bare http(s) origin fails the build, rather than shipping broken cards.
 */
export function parsePublicUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return undefined;
  }
  const parsed = publicUrlSchema.safeParse(typeof value === 'string' ? value.trim() : value);
  if (!parsed.success) {
    throw new Error(
      `VITE_PUBLIC_URL must be the public origin of the dashboard, such as https://centinela.example.org, with no path, query or fragment (got ${JSON.stringify(value)}).`,
    );
  }
  return parsed.data;
}

/** One `<meta>` tag: `name` for the description and Twitter, `property` for Open Graph. */
export type MetaTag = { name: string; content: string } | { property: string; content: string };

/** The meta tags for the head: always the description; the cards only with an origin. */
export function linkPreviewTags(origin: string | undefined): MetaTag[] {
  const tags: MetaTag[] = [{ name: 'description', content: LINK_PREVIEW.description }];
  if (origin === undefined) return tags;
  const image = `${origin}${PREVIEW_IMAGE.path}`;
  return [
    ...tags,
    { property: 'og:type', content: 'website' },
    { property: 'og:site_name', content: PRODUCT_NAME },
    { property: 'og:title', content: LINK_PREVIEW.title },
    { property: 'og:description', content: LINK_PREVIEW.description },
    { property: 'og:url', content: `${origin}/` },
    { property: 'og:image', content: image },
    { property: 'og:image:type', content: 'image/png' },
    { property: 'og:image:width', content: String(PREVIEW_IMAGE.width) },
    { property: 'og:image:height', content: String(PREVIEW_IMAGE.height) },
    { property: 'og:image:alt', content: LINK_PREVIEW.imageAlt },
    { property: 'og:locale', content: 'en_US' },
    { property: 'og:locale:alternate', content: 'es_ES' },
    { name: 'twitter:card', content: 'summary_large_image' },
    { name: 'twitter:title', content: LINK_PREVIEW.title },
    { name: 'twitter:description', content: LINK_PREVIEW.description },
    { name: 'twitter:image', content: image },
    { name: 'twitter:image:alt', content: LINK_PREVIEW.imageAlt },
  ];
}
