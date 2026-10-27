/**
 * Reading the `Cookie` header and the names and attributes of Centinela's two cookies.
 *
 * Both cookies normally use the `__Host-` prefix, which browsers only accept with `Secure`,
 * `Path=/` and no `Domain`: a sibling subdomain cannot set or overwrite them. Chromium and
 * Firefox accept `Secure` cookies on `http://localhost`, but WebKit (Safari) does not, so a
 * development server reached over plain HTTP on localhost uses unprefixed names without
 * `Secure` instead (`cookieMode`). Production and HTTPS requests always get the `__Host-`
 * cookies, and in that mode the unprefixed names are never read.
 */
import { isIP } from 'node:net';
import {
  CSRF_COOKIE,
  LOCAL_CSRF_COOKIE,
  LOCAL_SESSION_COOKIE,
  SESSION_COOKIE,
} from '@centinela/shared';
import type { CookieOptions, Request } from 'express';

/** The value of cookie `name` in a `Cookie` header, or undefined. Only the first occurrence counts. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

/** The cookie names a request uses, and whether its cookies are `Secure`. */
export interface CookieMode {
  readonly session: string;
  readonly csrf: string;
  readonly secure: boolean;
}

/** `__Host-` names, always `Secure`: production, HTTPS, and every host other than localhost. */
export const HOST_COOKIES: CookieMode = Object.freeze({
  session: SESSION_COOKIE,
  csrf: CSRF_COOKIE,
  secure: true,
});

/** Development over plain HTTP on localhost only. */
export const LOCAL_COOKIES: CookieMode = Object.freeze({
  session: LOCAL_SESSION_COOKIE,
  csrf: LOCAL_CSRF_COOKIE,
  secure: false,
});

/** `localhost`, `127.0.0.0/8` or `::1`, as `req.hostname` gives them (IPv6 in brackets). */
export function isLoopbackHost(hostname: string | undefined): boolean {
  if (!hostname) return false;
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host === '::1') return true;
  return isIP(host) === 4 && host.startsWith('127.');
}

/**
 * True when the request came over TLS, or when any `X-Forwarded-Proto` value says `https`.
 * The header is believed even without `TRUST_PROXY`: it can only make the cookies stricter.
 */
function arrivedOverHttps(req: Request): boolean {
  if (req.secure) return true;
  const forwarded = req.get('X-Forwarded-Proto') ?? '';
  return forwarded.split(',').some((proto) => proto.trim().toLowerCase() === 'https');
}

/** The relaxed names only for a plain-HTTP request to localhost outside production. */
export function cookieMode(req: Request, isProduction: boolean): CookieMode {
  if (isProduction || arrivedOverHttps(req) || !isLoopbackHost(req.hostname)) return HOST_COOKIES;
  return LOCAL_COOKIES;
}

function baseOptions(mode: CookieMode): CookieOptions {
  return { secure: mode.secure, sameSite: 'strict', path: '/' };
}

/** Session cookie: never readable from JavaScript. */
export function sessionCookieOptions(maxAgeMs: number, mode: CookieMode): CookieOptions {
  return { ...baseOptions(mode), maxAge: maxAgeMs, httpOnly: true };
}

/** CSRF cookie: the dashboard reads it and repeats it in the `X-CSRF-Token` header. */
export function csrfCookieOptions(maxAgeMs: number, mode: CookieMode): CookieOptions {
  return { ...baseOptions(mode), maxAge: maxAgeMs, httpOnly: false };
}

/** Options for `res.clearCookie`: the attributes must match the ones the cookie was set with. */
export function clearCookieOptions(httpOnly: boolean, mode: CookieMode): CookieOptions {
  return { ...baseOptions(mode), httpOnly };
}
