/**
 * Applies `headers.ts` in Vite: `vite preview` sends the production headers; the dev server
 * sends the development policy and makes Vite put a nonce on the scripts and styles it
 * injects (`html.cspNonce`). Headers go on every response, 404s included, like nginx's
 * `always`. The nonce is random per dev-server process, so a page cannot guess it; the dev
 * server is a local tool, not a deployment.
 */
import { randomBytes } from 'node:crypto';
import type { Connect, Plugin } from 'vite';
import { developmentHeaders, productionHeaders } from './headers.js';

function setHeaders(headers: Readonly<Record<string, string>>): Connect.NextHandleFunction {
  return (_req, res, next) => {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    next();
  };
}

export function securityHeaders(): Plugin {
  const nonce = randomBytes(18).toString('base64url');
  return {
    name: 'centinela:security-headers',
    config(_config, { command, isPreview }) {
      return command === 'serve' && !isPreview ? { html: { cspNonce: nonce } } : undefined;
    },
    configureServer(server) {
      server.middlewares.use(setHeaders(developmentHeaders(nonce)));
    },
    configurePreviewServer(server) {
      server.middlewares.use(setHeaders(productionHeaders));
    },
  };
}
