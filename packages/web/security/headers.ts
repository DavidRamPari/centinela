/**
 * Security headers for the dashboard's HTML (session S6), defined once and applied where the
 * HTML is served: nginx in Docker (`nginx/security-headers.conf`, checked against this file
 * by `test/csp.test.ts`), `vite preview` and the Vite dev server (`vite-plugin.ts`).
 *
 * The built app is static: every script and stylesheet is a same-origin file, so production
 * allows `'self'` only. No `'unsafe-inline'`, no `'unsafe-eval'`, no `data:`. Log content is
 * attacker-controlled; if markup from it ever reached the DOM, the policy still refuses to
 * run inline scripts, load foreign resources or send data to another origin.
 *
 * The dev server injects an inline React Refresh preamble and adds `<style>` elements for
 * hot reloading, so in development scripts and styles may also carry a per-process nonce,
 * and the HMR WebSocket may connect to localhost.
 *
 * This module is pure (no Node APIs) so tests typed for the browser can import it.
 */

type Directives = Record<string, string[]>;

function baseDirectives(): Directives {
  return {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'"],
    'font-src': ["'self'"],
    'connect-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
}

export interface CspOptions {
  /** Development only: allow scripts and styles carrying this nonce. */
  nonce?: string;
  /** Development only: allow the Vite HMR WebSocket on localhost. */
  devSocket?: boolean;
}

export function contentSecurityPolicy({ nonce, devSocket = false }: CspOptions = {}): string {
  const directives = baseDirectives();
  if (nonce !== undefined) {
    if (!/^[A-Za-z0-9+/=_-]{16,}$/.test(nonce)) throw new Error('invalid CSP nonce');
    directives['script-src']?.push(`'nonce-${nonce}'`);
    directives['style-src']?.push(`'nonce-${nonce}'`);
  }
  if (devSocket) directives['connect-src']?.push('ws://localhost:*', 'ws://127.0.0.1:*');
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

const OTHER_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // Legacy equivalent of frame-ancestors 'none', for old browsers.
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

/** Headers for the built app (nginx, `vite preview`). */
export const productionHeaders: Readonly<Record<string, string>> = {
  'Content-Security-Policy': contentSecurityPolicy(),
  ...OTHER_HEADERS,
};

/** Headers for the Vite dev server. */
export function developmentHeaders(nonce: string): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy({ nonce, devSocket: true }),
    ...OTHER_HEADERS,
  };
}
