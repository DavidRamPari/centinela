/**
 * Temporary lockout after repeated failed sign-ins, per client IP, in memory.
 *
 * `maxFailures` failures within `lockoutMs` lock the client for `lockoutMs` from the last
 * failure; a successful sign-in clears its record. Locked clients are refused before the
 * password is checked, so they cost no argon2 work. At most `maxEntries` clients are
 * tracked (oldest dropped first), so many source addresses cannot exhaust memory. State is
 * per process and resets on restart; the argon2 cost and the `/api/auth` rate limit still
 * bound guessing (docs/THREAT_MODEL.md).
 */

export interface LockoutOptions {
  maxFailures: number;
  lockoutMs: number;
  maxEntries?: number;
  now?: () => number;
}

export type LockoutState = { locked: false } | { locked: true; retryAfterMs: number };

export interface LoginLockout {
  check(key: string): LockoutState;
  /** Count a failure; returns the state after it (locked when this failure hit the limit). */
  recordFailure(key: string): LockoutState;
  recordSuccess(key: string): void;
  /** Number of tracked clients (for tests). */
  readonly size: number;
}

interface Entry {
  failures: number;
  /** Time of the first failure of the current series. */
  firstAt: number;
  lockedUntil: number;
}

export const DEFAULT_MAX_LOCKOUT_ENTRIES = 10_000;

export function createLoginLockout({
  maxFailures,
  lockoutMs,
  maxEntries = DEFAULT_MAX_LOCKOUT_ENTRIES,
  now = Date.now,
}: LockoutOptions): LoginLockout {
  const entries = new Map<string, Entry>();

  function current(key: string, at: number): Entry | undefined {
    const entry = entries.get(key);
    if (!entry) return undefined;
    // A series older than the window and no running lockout: forget it.
    if (entry.lockedUntil <= at && at - entry.firstAt > lockoutMs) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  function stateOf(entry: Entry | undefined, at: number): LockoutState {
    return entry && entry.lockedUntil > at
      ? { locked: true, retryAfterMs: entry.lockedUntil - at }
      : { locked: false };
  }

  return {
    check(key) {
      const at = now();
      return stateOf(current(key, at), at);
    },

    recordFailure(key) {
      const at = now();
      let entry = current(key, at);
      // Already locked: a failure cannot shorten or restart the lockout.
      if (entry && entry.lockedUntil > at) return stateOf(entry, at);
      if (!entry || entry.lockedUntil > 0) {
        // First failure, or the first one after a lockout ended: start a new series.
        entry = { failures: 0, firstAt: at, lockedUntil: 0 };
      }
      entry.failures += 1;
      if (entry.failures >= maxFailures) entry.lockedUntil = at + lockoutMs;
      // Re-insert so the Map's order is "least recently failed first".
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return stateOf(entry, at);
    },

    recordSuccess(key) {
      entries.delete(key);
    },

    get size() {
      return entries.size;
    },
  };
}
