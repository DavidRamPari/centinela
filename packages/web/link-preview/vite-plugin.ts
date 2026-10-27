/**
 * Writes the link-preview tags of `meta.ts` into index.html, in development and in the
 * build. `VITE_PUBLIC_URL` comes from the environment or the repository's `.env`, like every
 * `VITE_*` setting, and is checked when the config is resolved.
 */
import type { HtmlTagDescriptor, Plugin } from 'vite';
import { linkPreviewTags, parsePublicUrl } from './meta.js';

export function linkPreview(): Plugin {
  let origin: string | undefined;
  return {
    name: 'centinela:link-preview',
    configResolved(config) {
      origin = parsePublicUrl(config.env.VITE_PUBLIC_URL);
    },
    transformIndexHtml(): HtmlTagDescriptor[] {
      return linkPreviewTags(origin).map((attrs) => ({ tag: 'meta', attrs, injectTo: 'head' }));
    },
  };
}
