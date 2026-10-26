// @vitest-environment node
/**
 * Content Security Policy where the HTML is served (S6): nginx in Docker, `vite preview`
 * and the Vite dev server. The nginx files are checked against `security/headers.ts`; the
 * Vite servers are started for real and asked for a page.
 */
import { http, passthrough } from 'msw';
import { createServer, preview, type PreviewServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import template from '../nginx/default.conf.template?raw';
import snippet from '../nginx/security-headers.conf?raw';
import dockerfile from '../Dockerfile?raw';
import { contentSecurityPolicy, developmentHeaders, productionHeaders } from '../security/headers';
import { server as msw } from './setup';

const SNIPPET_PATH = '/etc/nginx/snippets/centinela-security-headers.conf';

// MSW intercepts fetch in every test; requests to the local Vite servers go through.
beforeEach(() => {
  msw.use(http.all(/^http:\/\/localhost:\d+\//, () => passthrough()));
});
const root = new URL('..', import.meta.url).pathname;
const configFile = new URL('../vite.config.ts', import.meta.url).pathname;

/** `directive → sources` of a policy string. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(';').map((part) => {
      const [name = '', ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

/** `add_header Name "value" always;` lines of an nginx file. */
function addHeaders(conf: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of conf.split('\n')) {
    const match = /^\s*add_header\s+(\S+)\s+"([^"]*)"\s+always;\s*$/.exec(line);
    if (match?.[1] && match[2] !== undefined) headers[match[1]] = match[2];
  }
  return headers;
}

/** Top-level `location <path> { ... }` blocks of the server block. */
function locations(conf: string): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const match of conf.matchAll(/location\s+(\S+)\s*\{/g)) {
    let depth = 1;
    let end = (match.index ?? 0) + match[0].length;
    while (depth > 0 && end < conf.length) {
      if (conf[end] === '{') depth += 1;
      if (conf[end] === '}') depth -= 1;
      end += 1;
    }
    blocks.set(match[1] ?? '', conf.slice((match.index ?? 0) + match[0].length, end - 1));
  }
  return blocks;
}

describe('production policy', () => {
  const policy = directives(contentSecurityPolicy());

  it('allows only same-origin files and nothing inline', () => {
    for (const name of ['default-src', 'script-src', 'style-src', 'img-src', 'connect-src']) {
      expect(policy.get(name), name).toEqual(["'self'"]);
    }
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'none'"]);
    expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
    const text = contentSecurityPolicy();
    for (const unsafe of ["'unsafe-inline'", "'unsafe-eval'", 'data:', '*', 'nonce-']) {
      expect(text).not.toContain(unsafe);
    }
    // It would upgrade http://localhost asset requests to https and break local use.
    expect(policy.has('upgrade-insecure-requests')).toBe(false);
  });

  it('adds the nonce and the HMR socket only in development', () => {
    const dev = directives(
      developmentHeaders('n0nceN0nceN0nceN0nce')['Content-Security-Policy'] ?? '',
    );
    expect(dev.get('script-src')).toEqual(["'self'", "'nonce-n0nceN0nceN0nceN0nce'"]);
    expect(dev.get('style-src')).toEqual(["'self'", "'nonce-n0nceN0nceN0nceN0nce'"]);
    expect(dev.get('connect-src')).toEqual(["'self'", 'ws://localhost:*', 'ws://127.0.0.1:*']);
    expect(dev.get('frame-ancestors')).toEqual(["'none'"]);
    expect(() => contentSecurityPolicy({ nonce: "x'; script-src *" })).toThrow('invalid CSP nonce');
  });
});

describe('nginx (Docker)', () => {
  it('sends exactly the production headers', () => {
    expect(addHeaders(snippet)).toEqual(productionHeaders);
  });

  it('includes them in every location that serves files, not on the proxied API', () => {
    const blocks = locations(template);
    expect([...blocks.keys()].sort()).toEqual(['/', '/api/', '/assets/']);
    for (const [path, body] of blocks) {
      const includes = body.includes(`include ${SNIPPET_PATH};`);
      expect(includes, path).toBe(path !== '/api/');
    }
    // HTML routes fall back to index.html inside the location that carries the headers.
    expect(blocks.get('/')).toContain('try_files $uri /index.html;');
    // No header set outside the snippet could silently replace it.
    expect(template).not.toMatch(/add_header\s+(Content-Security-Policy|X-Frame-Options)/);
  });

  it('copies the snippet to the path the template includes', () => {
    expect(dockerfile).toContain(`COPY packages/web/nginx/security-headers.conf ${SNIPPET_PATH}`);
  });
});

describe('Vite dev server', () => {
  let server: ViteDevServer;
  let base: string;

  beforeAll(async () => {
    server = await createServer({
      root,
      configFile,
      logLevel: 'silent',
      server: { port: 0, strictPort: false },
    });
    await server.listen();
    base = server.resolvedUrls?.local[0] ?? '';
  }, 30_000);
  afterAll(() => server.close());

  it('serves every dashboard route with the development policy', async () => {
    for (const path of ['/', '/alerts?status=new', '/login']) {
      const res = await fetch(new URL(path, base));
      expect(res.status).toBe(200);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      const policy = directives(res.headers.get('content-security-policy') ?? '');
      expect(policy.get('default-src')).toEqual(["'self'"]);
      expect(policy.get('script-src')?.[1]).toMatch(/^'nonce-[A-Za-z0-9_-]{24}'$/);
    }
  });

  it('puts the nonce on every script and style it injects, inline ones included', async () => {
    const res = await fetch(base);
    const html = await res.text();
    const nonce = /'nonce-([^']+)'/.exec(res.headers.get('content-security-policy') ?? '')?.[1];
    const tags = [...html.matchAll(/<(script|style)\b[^>]*>/g)].map((m) => m[0]);
    expect(tags.length).toBeGreaterThanOrEqual(3);
    // The React Refresh preamble is inline: only its nonce lets it run.
    expect(html).toMatch(/<script type="module" nonce="[^"]+">import/);
    for (const tag of tags) expect(tag).toContain(`nonce="${nonce}"`);
    // Vite's client reads this to nonce the <style> elements it adds while hot reloading.
    expect(html).toContain(`<meta property="csp-nonce" nonce="${nonce}">`);
  });

  it('uses a new nonce for every dev server process', async () => {
    const other = await createServer({
      root,
      configFile,
      logLevel: 'silent',
      server: { port: 0, strictPort: false },
    });
    expect(other.config.html?.cspNonce).toBeDefined();
    expect(other.config.html?.cspNonce).not.toBe(server.config.html?.cspNonce);
    await other.close();
  });
});

describe('vite preview', () => {
  let server: PreviewServer;

  beforeAll(async () => {
    // `dist/` may not exist (CI runs tests before the build): the headers do not depend on it.
    server = await preview({
      root,
      configFile,
      logLevel: 'silent',
      preview: { port: 0, strictPort: false },
    });
  }, 30_000);
  afterAll(() => new Promise<void>((resolve) => server.httpServer.close(() => resolve())));

  it('sends the production headers on every response', async () => {
    for (const path of ['/', '/alerts', '/assets/missing.js']) {
      const res = await fetch(new URL(path, server.resolvedUrls?.local[0] ?? ''));
      for (const [name, value] of Object.entries(productionHeaders)) {
        expect(res.headers.get(name), `${path} ${name}`).toBe(value);
      }
    }
  });
});
