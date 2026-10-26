/**
 * Reading the `Cookie` header and the attributes of Centinela's two cookies.
 *
 * Both cookies use the `__Host-` prefix, which browsers only accept with `Secure`,
 * `Path=/` and no `Domain`: a sibling subdomain cannot set or overwrite them. Browsers
 * accept `Secure` cookies on `http://localhost`, so local development works without TLS.
 */
import type { CookieOptions } from 'express';

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

function baseOptions(maxAgeMs: number): CookieOptions {
  return { secure: true, sameSite: 'strict', path: '/', maxAge: maxAgeMs };
}

/** Session cookie: never readable from JavaScript. */
export function sessionCookieOptions(maxAgeMs: number): CookieOptions {
  return { ...baseOptions(maxAgeMs), httpOnly: true };
}

/** CSRF cookie: the dashboard reads it and repeats it in the `X-CSRF-Token` header. */
export function csrfCookieOptions(maxAgeMs: number): CookieOptions {
  return { ...baseOptions(maxAgeMs), httpOnly: false };
}

/** Options for `res.clearCookie`: the attributes must match the ones the cookie was set with. */
export function clearCookieOptions(httpOnly: boolean): CookieOptions {
  return { secure: true, sameSite: 'strict', path: '/', httpOnly };
}
