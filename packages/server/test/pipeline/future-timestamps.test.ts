/**
 * Regression tests for S10-04 (docs/decisions/S10.md): in version 0.1 one event dated in
 * the future blinded correlation. Reproduced there against the engine; here the same
 * sequences go through the pipeline with the real parser and rules.
 */
import { describe, expect, it } from 'vitest';
import { createLiveRun, outcomes, type StreamBatch } from './live.js';

const RECEIVED_AT = new Date('2026-10-25T12:00:00Z');
const ATTACKER = '203.0.113.45';
const BRUTE_FORCE = 'SSH brute force from a single source';

const failure = (ts: string, ip = ATTACKER) =>
  `${ts} bastion-01 sshd[4242]: Failed password for root from ${ip} port 50022 ssh2`;
const second = (n: number) => `2026-10-25T11:00:${String(n).padStart(2, '0')}Z`;

function run() {
  const live = createLiveRun();
  const deliver = (lines: string[], receivedAt: Date = RECEIVED_AT) =>
    live.pipeline.ingest(lines, {
      source: 'linux_auth',
      host: 'bastion-01',
      timezone: 'UTC',
      receivedAt,
      stream: { kind: 'token', tokenId: null },
    });
  /** As a shipper does: one failure per request, received a second after it happened. */
  const ship = (ts: string, ip = ATTACKER, eventTs = ts) =>
    live.pipeline.ingest([failure(eventTs, ip)], {
      source: 'linux_auth',
      host: 'bastion-01',
      timezone: 'UTC',
      receivedAt: new Date(Date.parse(ts) + 1000),
      stream: { kind: 'token', tokenId: null },
      ack: 'stored',
    });
  const titles = () =>
    live.sink.list().map((alert) => `${alert.ruleTitle} x${alert.count} [${alert.groupKey ?? ''}]`);
  return { live, deliver, ship, titles };
}

describe('a timestamp from the future cannot blind correlation (S10-04)', () => {
  it('control: fifteen failures from one address raise the brute-force alert', async () => {
    const { deliver, titles } = run();
    await deliver(Array.from({ length: 15 }, (_, i) => failure(second(i))));
    expect(titles()).toContain(`${BRUTE_FORCE} x1 [source.ip=${ATTACKER},host.name=bastion-01]`);
  });

  it('same group: an event dated years ahead is rejected and the alert still fires', async () => {
    const { deliver, titles, live } = run();
    await deliver([0, 1, 2].map((i) => failure(second(i))));
    const poisoned = await deliver([failure('2030-01-01T00:00:00Z')]);
    expect(poisoned).toMatchObject({ accepted: 0, rejected: 1 });
    expect(poisoned.rejections[0]?.reason).toBe('timestamp too far in the future');
    await deliver(Array.from({ length: 12 }, (_, i) => failure(second(i + 3))));
    expect(titles()).toContain(`${BRUTE_FORCE} x1 [source.ip=${ATTACKER},host.name=bastion-01]`);
    expect(live.pipeline.stats().late).toBe(0);
  });

  it('same group: an event dated minutes ahead does not silence its group', async () => {
    const { ship, titles, live } = run();
    for (let i = 0; i < 3; i += 1) await ship(second(i));
    // Sent at 11:00:03 but dated 11:10: accepted, and detected at the time it was received.
    expect(await ship(second(3), ATTACKER, '2026-10-25T11:10:00Z')).toMatchObject({ accepted: 1 });
    // The attack continues at the server's present time.
    for (let i = 4; i < 10; i += 1) await ship(second(i));
    await live.pipeline.drain();
    expect(titles()).toContain(`${BRUTE_FORCE} x1 [source.ip=${ATTACKER},host.name=bastion-01]`);
    expect(live.pipeline.stats().late).toBe(0);
  });

  it('every group: one request per failure still fires after a far-future event from another address', async () => {
    const { deliver, titles } = run();
    await deliver([failure('2030-01-01T00:00:00Z', '198.51.100.7')]);
    for (let i = 0; i < 30; i += 1) await deliver([failure(second(i))]);
    // Thirty failures, a threshold of ten: three firings folded into one alert.
    expect(titles()).toContain(`${BRUTE_FORCE} x3 [source.ip=${ATTACKER},host.name=bastion-01]`);
  });

  it('every group: an event dated minutes ahead does not evict the open windows', async () => {
    const { ship, titles, live } = run();
    // Three failures open a window; then another address sends an event dated 11:10.
    for (let i = 0; i < 3; i += 1) await ship(second(i));
    await ship(second(3), '198.51.100.7', '2026-10-25T11:10:00Z');
    // Seven more make ten inside five minutes: the window must still hold the first three.
    for (let i = 4; i < 11; i += 1) await ship(second(i));
    await live.pipeline.drain();
    expect(titles()).toContain(`${BRUTE_FORCE} x1 [source.ip=${ATTACKER},host.name=bastion-01]`);
    const alert = outcomes(live.sink).find((a) => a.dedupKey.includes(ATTACKER));
    expect(alert?.events).toHaveLength(10);
    expect(alert?.firstSeen).toBe('2026-10-25T11:00:00.000Z');
    expect(live.pipeline.stats().late).toBe(0);
  });

  it('an alert never carries a time ahead of the receive time', async () => {
    const { deliver, live } = run();
    // Ten failures dated 12:05 to 12:14, received at 12:00.
    await deliver(
      Array.from({ length: 10 }, (_, i) =>
        failure(`2026-10-25T12:${String(i + 5).padStart(2, '0')}:00Z`),
      ),
    );
    const alert = outcomes(live.sink).find((a) => a.dedupKey.includes(ATTACKER));
    expect(alert).toMatchObject({
      firstSeen: RECEIVED_AT.toISOString(),
      lastSeen: RECEIVED_AT.toISOString(),
    });
  });
});

/** Password spraying across two hosts: the order decides which events make the alert. */
describe('a spray across two hosts', () => {
  const SPRAYER = '203.0.113.77';
  const SPRAY = 'SSH password spraying from a single source';
  const spray = (host: string, n: number, user: string) =>
    `2026-10-25T10:00:0${Math.floor(n)}.${n % 1 === 0 ? '000' : '500'}Z ${host} sshd[900]: Failed password for invalid user ${user} from ${SPRAYER} port 40000 ssh2`;
  // web-01: ten users, one per second from 0 s to 9 s. db-01: five users at 0.5 s to 4.5 s.
  const web: StreamBatch = {
    stream: 'web-01/auth',
    host: 'web-01',
    source: 'linux_auth',
    lines: Array.from({ length: 10 }, (_, i) => spray('web-01', i, `w${i}`)),
    fromMs: 0,
    toMs: 0,
  };
  const db: StreamBatch = {
    stream: 'db-01/auth',
    host: 'db-01',
    source: 'linux_auth',
    lines: Array.from({ length: 5 }, (_, i) => spray('db-01', i + 0.5, `d${i}`)),
    fromMs: 0,
    toMs: 0,
  };

  async function alertOf(windowMs: number, batches: StreamBatch[]) {
    const live = createLiveRun({ reorder: { windowMs, idleMs: Number.POSITIVE_INFINITY } });
    for (const batch of batches) await live.deliver(batch);
    await live.pipeline.drain();
    const alert = outcomes(live.sink).find((a) => a.dedupKey.endsWith(`|source.ip=${SPRAYER}`));
    const title = live.sink.list().find((a) => a.dedupKey === alert?.dedupKey)?.ruleTitle;
    return { alert, title, late: live.pipeline.stats().late };
  }

  it('in order of time the tenth user is on db-01 at 4.5 s', async () => {
    const { alert, title, late } = await alertOf(Number.POSITIVE_INFINITY, [web, db]);
    expect(title).toBe(SPRAY);
    expect(late).toBe(0);
    expect(alert).toMatchObject({
      firstSeen: '2026-10-25T10:00:00.000Z',
      lastSeen: '2026-10-25T10:00:04.500Z',
      count: 1,
    });
    expect(alert?.events).toEqual([
      'web-01/auth#00000000',
      'db-01/auth#00000000',
      'web-01/auth#00000001',
      'db-01/auth#00000001',
      'web-01/auth#00000002',
      'db-01/auth#00000002',
      'web-01/auth#00000003',
      'db-01/auth#00000003',
      'web-01/auth#00000004',
      'db-01/auth#00000004',
    ]);
  });

  it('with the window, either delivery order gives that same alert', async () => {
    const reference = await alertOf(Number.POSITIVE_INFINITY, [web, db]);
    for (const batches of [
      [web, db],
      [db, web],
    ]) {
      const live = await alertOf(10_000, batches);
      expect(live.late).toBe(0);
      expect(live.alert).toEqual(reference.alert);
    }
  });

  it('without the window the alert depends on who arrived first, and the run says so', async () => {
    const reference = await alertOf(Number.POSITIVE_INFINITY, [web, db]);
    const onArrival = await alertOf(0, [web, db]);
    // web-01 alone reaches ten users at 9 s; db-01 arrives late and adds nothing.
    expect(onArrival.alert).toMatchObject({ lastSeen: '2026-10-25T10:00:09.000Z', count: 1 });
    expect(onArrival.alert?.events.every((id) => id.startsWith('web-01/'))).toBe(true);
    expect(onArrival.alert).not.toEqual(reference.alert);
    expect(onArrival.late).toBe(5);
  });
});
