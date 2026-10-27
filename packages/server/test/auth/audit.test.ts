import { auditPageSchema, type Alert, type AuditEntry } from '@centinela/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAudit, recordAudit } from '../../src/auth/audit.js';
import { createPgAlertSink } from '../../src/db/alert-sink.js';
import { withTransaction } from '../../src/db/sql.js';
import { createTestApp } from '../helpers/app.js';
import { TEST_USERNAME } from '../helpers/auth.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { ago, HOUR, RULES, testCandidate } from '../helpers/seed.js';

describe('audit log', () => {
  let db: TestDatabase;
  let app: ReturnType<typeof createTestApp>['app'];
  let alerts: Alert[];

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ app } = createTestApp({ pool: db.pool }));
    const { created } = await createPgAlertSink(db.pool).upsert([
      testCandidate({ firstSeen: ago(HOUR), ips: ['203.0.113.1'] }),
      testCandidate({ firstSeen: ago(HOUR), ips: ['203.0.113.2'] }),
      testCandidate({ firstSeen: ago(HOUR), ips: ['203.0.113.3'] }),
    ]);
    alerts = created;
  });
  afterAll(() => db.cleanup());

  async function entries(action: string): Promise<AuditEntry[]> {
    const res = await request(app).get(`/api/audit?action=${action}`).expect(200);
    return auditPageSchema.parse(res.body).items;
  }

  it('records a triage change with its actor, target and outcome', async () => {
    const alert = alerts[0];
    if (!alert) throw new Error('seed failed');
    await request(app)
      .patch(`/api/alerts/${alert.id}`)
      .send({ status: 'closed', resolution: 'false_positive', note: 'lab scanner' })
      .expect(200);
    const [entry] = await entries('alert.triage');
    expect(entry).toMatchObject({
      actor: TEST_USERNAME,
      action: 'alert.triage',
      target: alert.id,
      details: { status: 'closed', resolution: 'false_positive', note: 'set' },
    });
  });

  it('writes nothing when the change is refused', async () => {
    const alert = alerts[0];
    if (!alert) throw new Error('seed failed');
    const before = (await entries('alert.triage')).length;
    // closed → acknowledged is not an allowed move (409).
    await request(app)
      .patch(`/api/alerts/${alert.id}`)
      .send({ status: 'acknowledged' })
      .expect(409);
    expect(await entries('alert.triage')).toHaveLength(before);
  });

  it('records a bulk change with the ids it updated', async () => {
    const ids = alerts.slice(1).map((alert) => alert.id);
    const unknown = '01930f6e-8a4b-7c2d-9e1f-0a1b2c3d4e5f';
    await request(app)
      .post('/api/alerts/bulk')
      .send({ ids: [...ids, unknown], status: 'acknowledged' })
      .expect(200);
    const [entry] = await entries('alert.bulk_triage');
    expect(entry?.details).toEqual({
      status: 'acknowledged',
      resolution: null,
      requested: 3,
      updated: expect.arrayContaining(ids) as unknown,
    });
    expect((entry?.details.updated as string[]).length).toBe(2);
  });

  it('records rule changes', async () => {
    const res = await request(app)
      .patch(`/api/rules/${RULES.notInSudoers.id}`)
      .send({ enabled: false })
      .expect(200);
    const [entry] = await entries('rule.update');
    expect(entry).toMatchObject({
      target: RULES.notInSudoers.id,
      details: { enabled: false, title: (res.body as { title: string }).title },
    });
  });

  it('pages newest first with a cursor and filters by action', async () => {
    // Same millisecond for every row: the order must come from the insertion sequence.
    const at = new Date();
    for (let i = 0; i < 5; i += 1) {
      await recordAudit(db.pool, { actor: `user-${i}`, action: 'auth.login_failed' }, at);
    }
    const seen: AuditEntry[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `/api/audit?action=auth.login_failed&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const page = auditPageSchema.parse((await request(app).get(query).expect(200)).body);
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen.map((entry) => entry.actor)).toEqual([
      'user-4',
      'user-3',
      'user-2',
      'user-1',
      'user-0',
    ]);

    const all = auditPageSchema.parse(
      (await request(app).get('/api/audit?limit=200').expect(200)).body,
    );
    const actions = new Set(all.items.map((entry) => entry.action));
    expect(actions).toEqual(
      new Set(['alert.triage', 'alert.bulk_triage', 'rule.update', 'auth.login_failed']),
    );
    const multi = await request(app).get('/api/audit?action=rule.update,alert.triage').expect(200);
    expect(
      auditPageSchema
        .parse(multi.body)
        .items.map((entry) => entry.action)
        .sort(),
    ).toEqual(['alert.triage', 'rule.update']);
  });

  it('reads rows written in the same millisecond in the order they were written', async () => {
    // Regression (CI on 2 vCPUs): ordering by (at, id) put a lockout row before the failed
    // sign-in written just before it, because UUIDs carry no order within a millisecond.
    const at = new Date('2026-10-27T10:00:00.000Z');
    const actors = Array.from({ length: 40 }, (_, i) => `same-ms-${i}`);
    await withTransaction(db.pool, async (client) => {
      for (const actor of actors) await recordAudit(client, { actor, action: 'auth.lockout' }, at);
    });
    const page = await listAudit(db.pool, { actions: ['auth.lockout'], limit: 200 });
    expect(page.items.map((entry) => entry.actor)).toEqual([...actors].reverse());
  });

  it('validates the query', async () => {
    await request(app).get('/api/audit?action=alert.delete').expect(400);
    await request(app).get('/api/audit?cursor=bm90LWEtY3Vyc29y').expect(400);
    // A cursor from the events API (`ts|id`) is not an audit cursor.
    const eventsCursor = Buffer.from(
      `${new Date().toISOString()}|${RULES.notInSudoers.id}`,
    ).toString('base64url');
    await request(app).get(`/api/audit?cursor=${eventsCursor}`).expect(400);
    await request(app).get('/api/audit?limit=500').expect(400);
  });

  it('keeps hostile text as data and cuts it at 256 characters', async () => {
    const hostile = `<script>alert(1)</script>' OR 1=1--${'x'.repeat(400)}`;
    await recordAudit(db.pool, { actor: hostile, action: 'auth.login_failed', ip: '2001:db8::1' });
    const page = await listAudit(db.pool, { actions: ['auth.login_failed'], limit: 1 });
    expect(page.items[0]?.actor).toBe(hostile.slice(0, 256));
    expect(page.items[0]?.ip).toBe('2001:db8::1');
  });
});
