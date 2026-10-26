import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compare two secrets in constant time. Hashing first gives equal-length inputs to
 * `timingSafeEqual`, so neither the content nor the length of a secret leaks.
 */
export function safeEqual(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}
