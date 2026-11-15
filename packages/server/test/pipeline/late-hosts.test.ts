/**
 * A machine whose events arrive late for good: its clock is behind, or it sends what it
 * held back during an outage. Its events are evaluated on arrival and counted as late, and
 * its correlation windows must stay open between one request and the next. In version 0.1
 * they did not: a group was evicted one timespan after its newest match on the detector's
 * clock, which for these events had already passed (docs/decisions/S12.md).
 */
import type { IngestAck } from '@centinela/shared';
import { describe, expect, it } from 'vitest';
import { createLiveRun } from './live.js';

const T0 = Date.parse('2026-10-25T12:00:00Z');
const ATTACKER = '203.0.113.45';
const BRUTE_FORCE = `SSH brute force from a single source x1 [source.ip=${ATTACKER},host.name=db-01]`;

const iso = (ms: number) => new Date(ms).toISOString();
const failure = (ms: number, host: string, ip: string) =>
  `${iso(ms)} ${host} sshd[4242]: Failed password for root from ${ip} port 50022 ssh2`;

function run(ack: IngestAck) {
  const live = createLiveRun();
  const send = (host: string, lines: string[], now: number) =>
    live.pipeline.ingest(lines, {
      source: 'linux_auth',
      host,
      timezone: 'UTC',
      receivedAt: new Date(now),
      stream: { kind: 'token', tokenId: null },
      ack,
    });
  const titles = () =>
    live.sink.list().map((alert) => `${alert.ruleTitle} x${alert.count} [${alert.groupKey ?? ''}]`);
  return { live, send, titles };
}

describe('a machine whose events always arrive late', () => {
  it.each([
    ['30 seconds', 'evaluated', 30_000],
    ['30 minutes', 'evaluated', 30 * 60_000],
    ['30 minutes', 'stored', 30 * 60_000],
    ['a day', 'stored', 24 * 3_600_000],
  ] as const)(
    'clock %s behind (ack=%s): ten failures, one per request, still raise the alert',
    async (_, ack, behind) => {
      const { live, send, titles } = run(ack);
      for (let second = 0; second < 30; second += 1) {
        const now = T0 + second * 1000;
        // A machine with a good clock keeps the detector's clock at the present.
        await send('web-01', [failure(now - 500, 'web-01', '198.51.100.9')], now);
        if (second >= 12 && second < 22) {
          await send('db-01', [failure(now - behind - 500, 'db-01', ATTACKER)], now);
        }
      }
      await live.pipeline.drain();
      expect(titles()).toContain(BRUTE_FORCE);
      expect(live.pipeline.stats().late).toBeGreaterThanOrEqual(10);
    },
  );

  it('an outage: what was held back arrives in two requests and counts as one window', async () => {
    const { live, send, titles } = run('stored');
    await send('web-01', [failure(T0, 'web-01', '198.51.100.9')], T0 + 500);
    await live.pipeline.drain();
    // Twenty minutes old when the link comes back: six failures, then four.
    const then = T0 - 20 * 60_000;
    const first = await send(
      'db-01',
      Array.from({ length: 6 }, (_, i) => failure(then + i * 1000, 'db-01', ATTACKER)),
      T0 + 1000,
    );
    expect(first).toMatchObject({ accepted: 6, late: 6 });
    expect(titles()).not.toContain(BRUTE_FORCE);
    await send('web-01', [failure(T0 + 1500, 'web-01', '198.51.100.9')], T0 + 2000);
    await send(
      'db-01',
      Array.from({ length: 4 }, (_, i) => failure(then + (6 + i) * 1000, 'db-01', ATTACKER)),
      T0 + 3000,
    );
    await live.pipeline.drain();
    expect(titles()).toContain(BRUTE_FORCE);
    const alert = live.sink.list().find((a) => a.groupKey?.includes('db-01'));
    // The alert carries the time of the events, not the time they arrived.
    expect(alert).toMatchObject({ firstSeen: iso(then), lastSeen: iso(then + 9000) });
  });

  it('the window still closes: a pause longer than the timespan starts a new one', async () => {
    const { live, send, titles } = run('stored');
    const then = T0 - 20 * 60_000;
    await send('web-01', [failure(T0, 'web-01', '198.51.100.9')], T0 + 500);
    await live.pipeline.drain();
    await send(
      'db-01',
      Array.from({ length: 6 }, (_, i) => failure(then + i * 1000, 'db-01', ATTACKER)),
      T0 + 1000,
    );
    // Six minutes pass on the detector's clock (the rule's timespan is five).
    const later = T0 + 6 * 60_000;
    await send('web-01', [failure(later, 'web-01', '198.51.100.9')], later + 500);
    await live.pipeline.drain();
    await send(
      'db-01',
      Array.from({ length: 4 }, (_, i) => failure(then + (6 + i) * 1000, 'db-01', ATTACKER)),
      later + 1000,
    );
    await live.pipeline.drain();
    expect(titles()).not.toContain(BRUTE_FORCE);
  });
});
