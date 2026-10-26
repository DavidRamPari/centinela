import {
  alertBulkResponseSchema,
  alertDetailResponseSchema,
  alertSchema,
  alertsPageSchema,
  problemSchema,
  type Alert,
} from '@centinela/shared';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { createPgAlertSink } from '../../src/db/alert-sink.js';
import { createEventStore } from '../../src/db/events-write.js';
import type { SseHub } from '../../src/realtime/hub.js';
import { createTestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { ago, HOUR, MINUTE, RULES, testCandidate, testEvent } from '../helpers/seed.js';

const T0 = Date.now();

describe('alerts API', () => {
  let db: TestDatabase;
  let app: ReturnType<typeof createTestApp>['app'];
  let deps: ReturnType<typeof createTestApp>['deps'];
  const timeline = [
    testEvent({ ts: ago(12 * MINUTE, T0) }),
    testEvent({ ts: ago(14 * MINUTE, T0) }),
    testEvent({ ts: ago(13 * MINUTE, T0) }),
  ];
  /** Alerts by name, as created. */
  const alerts: Record<string, Alert> = {};

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ app, deps } = createTestApp({ pool: db.pool }));
    await createEventStore(db.pool).insertMany(timeline);
    const sink = createPgAlertSink(db.pool);
    const seed = {
      bruteforce: testCandidate({
        rule: RULES.bruteforce,
        firstSeen: ago(14 * MINUTE, T0),
        lastSeen: ago(12 * MINUTE, T0),
        eventIds: timeline.map((e) => e.id),
        users: ['root', 'admin'],
      }),
      sudo: testCandidate({
        rule: RULES.notInSudoers,
        host: 'db-01',
        firstSeen: ago(2 * HOUR, T0),
        ips: [],
        users: ['intern'],
      }),
      recon: testCandidate({
        rule: RULES.suspiciousAgent,
        host: 'Web-01',
        firstSeen: ago(3 * HOUR, T0),
        ips: ['192.0.2.10'],
        users: [],
      }),
      removed: testCandidate({ rule: RULES.removed, firstSeen: ago(4 * HOUR, T0) }),
      old: testCandidate({ rule: RULES.notInSudoers, firstSeen: ago(30 * HOUR, T0) }),
    };
    for (const [name, candidate] of Object.entries(seed)) {
      const { created } = await sink.upsert([candidate]);
      if (!created[0]) throw new Error(`not created: ${name}`);
      alerts[name] = created[0];
    }
  });
  afterAll(() => db.cleanup());

  const id = (name: string) => alerts[name]?.id ?? '';

  async function list(query: string) {
    const res = await request(app).get(`/api/alerts?${query}`).expect(200);
    return alertsPageSchema.parse(res.body);
  }

  async function names(query: string) {
    const page = await list(query);
    return page.items.map((a) => Object.keys(alerts).find((name) => alerts[name]?.id === a.id));
  }

  function expectProblem(res: request.Response, status: number) {
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    return problemSchema.parse(res.body);
  }

  describe('GET /api/alerts', () => {
    it('lists the last 24 hours by lastSeen, newest first', async () => {
      expect(await names('')).toEqual(['bruteforce', 'sudo', 'recon', 'removed']);
    });

    it.each([
      ['status (list)', 'status=new,acknowledged', ['bruteforce', 'sudo', 'recon', 'removed']],
      ['level (list)', 'level=high,critical', ['bruteforce', 'removed']],
      ['level (repeated)', 'level=medium&level=high', ['bruteforce', 'sudo', 'recon']],
      ['ruleId', `ruleId=${RULES.suspiciousAgent.id}`, ['recon']],
      ['technique (exact id)', 'technique=T1110.001', ['bruteforce']],
      ['a parent technique (no sub-techniques)', 'technique=T1110', []],
      ['host (case-insensitive)', 'host=web-01', ['recon']],
      ['ip entity', 'ip=192.0.2.10', ['recon']],
      ['user entity', 'user=admin', ['bruteforce']],
      [
        'a range including older alerts',
        `from=${ago(40 * HOUR, T0)}&level=medium`,
        ['sudo', 'recon', 'old'],
      ],
    ])('filters by %s', async (_name, query, expected) => {
      expect(await names(query)).toEqual(expected);
    });

    it('paginates with a keyset cursor', async () => {
      const first = await list('limit=3');
      expect(first.items).toHaveLength(3);
      const second = await list(`limit=3&cursor=${first.nextCursor}`);
      expect(second.items.map((a) => a.id)).toEqual([id('removed')]);
      expect(second.nextCursor).toBeNull();
    });

    it.each([
      ['an unknown status', 'status=open'],
      ['an empty level list', 'level=,'],
      ['a malformed technique', 'technique=t1110'],
      ['an invalid IP', 'ip=not-an-ip'],
      ['limit above 200', 'limit=500'],
      [
        'a forged cursor',
        `cursor=${Buffer.from('2026-10-25T00:00:00Z|nope').toString('base64url')}`,
      ],
    ])('answers 400 for %s', async (_name, query) => {
      expectProblem(await request(app).get(`/api/alerts?${query}`), 400);
    });
  });

  describe('GET /api/alerts/:id', () => {
    it('returns the alert, its rule metadata and its events oldest first', async () => {
      const res = await request(app)
        .get(`/api/alerts/${id('bruteforce')}`)
        .expect(200);
      const detail = alertDetailResponseSchema.parse(res.body);
      expect(detail.alert).toEqual(alerts.bruteforce);
      expect(detail.rule).toMatchObject({
        id: RULES.bruteforce.id,
        name: 'centinela-ssh-bruteforce',
        type: 'correlation',
        author: 'DavidRamPari',
        license: 'MIT',
        enabled: true,
      });
      const sorted = [...timeline].sort((a, b) => a.ts.localeCompare(b.ts));
      expect(detail.events).toEqual(sorted);
    });

    it('carries the DRL attribution of a SigmaHQ rule', async () => {
      const res = await request(app)
        .get(`/api/alerts/${id('recon')}`)
        .expect(200);
      const { alert, rule } = alertDetailResponseSchema.parse(res.body);
      expect(alert).toMatchObject({ license: 'DRL-1.1', author: RULES.suspiciousAgent.author });
      expect(rule).toMatchObject({ origin: 'sigmahq', license: 'DRL-1.1' });
      expect(rule?.url).toMatch(
        /^https:\/\/github\.com\/SigmaHQ\/sigma\/blob\/[0-9a-f]{40}\/rules\//,
      );
    });

    it('returns rule: null when the rule is no longer loaded', async () => {
      const res = await request(app)
        .get(`/api/alerts/${id('removed')}`)
        .expect(200);
      expect(alertDetailResponseSchema.parse(res.body).rule).toBeNull();
    });

    it('answers 404 for an unknown alert and 400 for an invalid id', async () => {
      expectProblem(await request(app).get(`/api/alerts/${uuidv7()}`), 404);
      expectProblem(await request(app).get('/api/alerts/123'), 400);
    });
  });

  describe('PATCH /api/alerts/:id', () => {
    let publish: MockInstance<SseHub['publish']>;
    beforeEach(() => {
      publish = vi.spyOn(deps.hub, 'publish');
      publish.mockClear();
    });
    afterEach(() => publish.mockRestore());

    function patch(name: string, body: object | undefined) {
      return request(app)
        .patch(`/api/alerts/${id(name)}`)
        .send(body);
    }

    it('acknowledges, closes with a resolution and a note, then reopens', async () => {
      const ack = alertSchema.parse(
        (await patch('sudo', { status: 'acknowledged' }).expect(200)).body,
      );
      expect(ack).toMatchObject({ status: 'acknowledged', resolution: null });
      expect(Date.parse(ack.updatedAt)).toBeGreaterThan(Date.parse(alerts.sudo?.updatedAt ?? ''));

      const closed = await patch('sudo', {
        status: 'closed',
        resolution: 'false_positive',
        note: 'Intern onboarding <script>alert(1)</script>',
      }).expect(200);
      expect(closed.body).toMatchObject({
        status: 'closed',
        resolution: 'false_positive',
        note: 'Intern onboarding <script>alert(1)</script>',
      });

      const reopened = alertSchema.parse((await patch('sudo', { status: 'new' }).expect(200)).body);
      expect(reopened).toMatchObject({
        status: 'new',
        resolution: null,
        note: 'Intern onboarding <script>alert(1)</script>',
      });

      const cleared = alertSchema.parse(
        (await patch('sudo', { status: 'new', note: null }).expect(200)).body,
      );
      expect(cleared.note).toBeNull();
      expect(publish).toHaveBeenCalledTimes(4);
      expect(publish).toHaveBeenLastCalledWith({ type: 'alert.updated', alert: cleared });
    });

    it('closes straight from new', async () => {
      const res = await patch('old', { status: 'closed', resolution: 'benign' }).expect(200);
      expect(res.body).toMatchObject({ status: 'closed', resolution: 'benign' });
      await patch('old', { status: 'new' }).expect(200);
    });

    it.each([
      ['acknowledged', 'new', { status: 'acknowledged' }, { status: 'new' }],
      [
        'closed',
        'acknowledged',
        { status: 'closed', resolution: 'benign' },
        { status: 'acknowledged' },
      ],
    ])('answers 409 for %s → %s', async (_from, _to, setup, body) => {
      await patch('recon', setup).expect(200);
      const problem = expectProblem(await patch('recon', body), 409);
      expect(problem.detail).toContain('cannot go from');
      // Back to `new` for the next case: close (allowed from both), then reopen.
      await patch('recon', { status: 'closed', resolution: 'benign' }).expect(200);
      await patch('recon', { status: 'new' }).expect(200);
    });

    it.each([
      ['closing without a resolution', { status: 'closed' }],
      ['a resolution when not closing', { status: 'acknowledged', resolution: 'benign' }],
      ['an unknown status', { status: 'resolved' }],
      ['an unknown key', { status: 'new', assignee: 'me' }],
      ['a note over 4,000 characters', { status: 'new', note: 'x'.repeat(4001) }],
      ['a missing body', undefined],
    ])('answers 400 for %s', async (_name, body) => {
      const res = await patch('bruteforce', body);
      expectProblem(res, 400);
      expect(publish).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown alert', async () => {
      const res = await request(app).patch(`/api/alerts/${uuidv7()}`).send({ status: 'new' });
      expectProblem(res, 404);
    });
  });

  describe('POST /api/alerts/bulk', () => {
    it('updates the alerts whose status allows it and skips the rest', async () => {
      await request(app)
        .patch(`/api/alerts/${id('removed')}`)
        .send({ status: 'closed', resolution: 'true_positive' })
        .expect(200);
      const res = await request(app)
        .post('/api/alerts/bulk')
        .send({ ids: [id('bruteforce'), id('removed'), uuidv7()], status: 'acknowledged' })
        .expect(200);
      expect(alertBulkResponseSchema.parse(res.body)).toEqual({ updated: 1 });
      expect(await names('status=acknowledged')).toEqual(['bruteforce']);
      expect(await names('status=closed')).toEqual(['removed']);
    });

    it('closes many alerts with one resolution', async () => {
      const res = await request(app)
        .post('/api/alerts/bulk')
        .send({ ids: [id('bruteforce'), id('sudo')], status: 'closed', resolution: 'benign' })
        .expect(200);
      expect(res.body).toEqual({ updated: 2 });
    });

    it.each([
      ['no ids', { ids: [], status: 'new' }],
      ['more than 500 ids', { ids: Array.from({ length: 501 }, () => uuidv7()), status: 'new' }],
      ['an invalid id', { ids: ['x'], status: 'new' }],
      ['closing without a resolution', { ids: [uuidv7()], status: 'closed' }],
    ])('answers 400 for %s', async (_name, body) => {
      expectProblem(await request(app).post('/api/alerts/bulk').send(body), 400);
    });

    it('answers 413 for a JSON body over 100 kB', async () => {
      const res = await request(app)
        .post('/api/alerts/bulk')
        .send({ ids: [uuidv7()], status: 'new', padding: 'x'.repeat(110_000) });
      expectProblem(res, 413);
    });
  });
});
