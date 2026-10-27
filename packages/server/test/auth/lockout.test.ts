import { describe, expect, it } from 'vitest';
import { createLoginLockout } from '../../src/auth/lockout.js';

const MINUTE = 60_000;

function setup(options: { maxEntries?: number } = {}) {
  let now = 1_000_000;
  const lockout = createLoginLockout({
    maxFailures: 3,
    lockoutMs: 15 * MINUTE,
    now: () => now,
    ...options,
  });
  return { lockout, advance: (ms: number) => (now += ms) };
}

describe('login lockout', () => {
  it('locks a client at the limit for the lockout time, then lets it try again', () => {
    const { lockout, advance } = setup();
    expect(lockout.recordFailure('a')).toEqual({ locked: false });
    expect(lockout.recordFailure('a')).toEqual({ locked: false });
    expect(lockout.recordFailure('a')).toEqual({ locked: true, retryAfterMs: 15 * MINUTE });
    advance(10 * MINUTE);
    expect(lockout.check('a')).toEqual({ locked: true, retryAfterMs: 5 * MINUTE });
    expect(lockout.check('b')).toEqual({ locked: false });
    advance(5 * MINUTE);
    expect(lockout.check('a')).toEqual({ locked: false });
    // After a lockout the count starts again from zero.
    expect(lockout.recordFailure('a')).toEqual({ locked: false });
  });

  it('does not extend or reset a running lockout', () => {
    const { lockout, advance } = setup();
    for (let i = 0; i < 3; i += 1) lockout.recordFailure('a');
    advance(MINUTE);
    expect(lockout.recordFailure('a')).toEqual({ locked: true, retryAfterMs: 14 * MINUTE });
    lockout.recordSuccess('b');
    expect(lockout.check('a')).toEqual({ locked: true, retryAfterMs: 14 * MINUTE });
  });

  it('forgets failures older than the window', () => {
    const { lockout, advance } = setup();
    lockout.recordFailure('a');
    lockout.recordFailure('a');
    advance(15 * MINUTE + 1);
    expect(lockout.recordFailure('a')).toEqual({ locked: false });
    expect(lockout.recordFailure('a')).toEqual({ locked: false });
    expect(lockout.recordFailure('a').locked).toBe(true);
  });

  it('clears a client on success', () => {
    const { lockout } = setup();
    lockout.recordFailure('a');
    lockout.recordFailure('a');
    lockout.recordSuccess('a');
    expect(lockout.size).toBe(0);
    expect(lockout.recordFailure('a')).toEqual({ locked: false });
  });

  it('tracks a bounded number of clients, dropping the least recent first', () => {
    const { lockout } = setup({ maxEntries: 2 });
    lockout.recordFailure('a');
    lockout.recordFailure('b');
    lockout.recordFailure('a');
    lockout.recordFailure('c');
    expect(lockout.size).toBe(2);
    // `b` was dropped; `a` still has its two failures.
    expect(lockout.recordFailure('a').locked).toBe(true);
    expect(lockout.recordFailure('b')).toEqual({ locked: false });
  });
});
