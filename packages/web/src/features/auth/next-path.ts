/**
 * Where to go after signing in. Only paths inside the dashboard are allowed: `//evil.example`
 * or `https://evil.example` in `?next=` would turn the sign-in page into an open redirect.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || raw.length > 2048) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  // Control characters and backslashes (browsers treat `\` like `/`).
  if (raw.includes('\\') || [...raw].some((ch) => ch.charCodeAt(0) < 0x20)) return '/';
  if (raw === '/login' || raw.startsWith('/login?')) return '/';
  return raw;
}

/** Sign-in page URL that returns to `path` afterwards. */
export function loginPath(path: string): string {
  const next = safeNextPath(path);
  return next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`;
}
