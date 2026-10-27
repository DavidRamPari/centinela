/**
 * Security headers for every API response. The API only serves JSON, problem+json and
 * Server-Sent Events, so its Content Security Policy forbids everything: a response that a
 * browser renders by mistake (or an attacker frames) cannot load or run anything. The HTML
 * policy lives where the HTML is served (`packages/web/security/`, nginx and Vite).
 */
import type { RequestHandler } from 'express';
import helmet from 'helmet';

export const API_CSP_DIRECTIVES = {
  defaultSrc: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'none'"],
  frameAncestors: ["'none'"],
} as const;

export function apiSecurityHeaders(): RequestHandler[] {
  return [
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: API_CSP_DIRECTIVES },
      frameguard: { action: 'deny' },
    }),
    (_req, res, next) => {
      // Alerts, events and session answers are never cached by browsers or proxies.
      res.set('Cache-Control', 'no-store');
      next();
    },
  ];
}
