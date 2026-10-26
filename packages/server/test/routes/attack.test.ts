import { attackResponseSchema, type AttackResponse } from '@centinela/shared';
import { loadAttackIndexSync } from '@centinela/shared/node';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgAlertSink } from '../../src/db/alert-sink.js';
import { ruleCountsByTechnique } from '../../src/routes/attack.js';
import { createTestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { RULES, testCandidate } from '../helpers/seed.js';

const RANGE = 'from=2026-10-21T00:00:00Z&to=2026-10-21T23:59:59Z';

function technique(body: AttackResponse, tactic: string, id: string) {
  return body.tactics.find((t) => t.shortname === tactic)?.techniques.find((t) => t.id === id);
}

describe('GET /api/attack', () => {
  let db: TestDatabase;
  let app: ReturnType<typeof createTestApp>['app'];
  let deps: ReturnType<typeof createTestApp>['deps'];
  const attack = loadAttackIndexSync();

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ app, deps } = createTestApp({ pool: db.pool }));
    await createPgAlertSink(db.pool).upsert([
      testCandidate({ rule: RULES.bruteforce, firstSeen: '2026-10-21T03:00:00Z' }),
      testCandidate({
        rule: RULES.bruteforce,
        ips: ['192.0.2.7'],
        firstSeen: '2026-10-21T09:00:00Z',
      }),
      // Outside the range.
      testCandidate({
        rule: RULES.bruteforce,
        ips: ['192.0.2.8'],
        firstSeen: '2026-10-25T09:00:00Z',
      }),
    ]);
  });
  afterAll(() => db.cleanup());

  async function matrix(query: string) {
    const res = await request(app).get(`/api/attack?${query}`).expect(200);
    return attackResponseSchema.parse(res.body);
  }

  it('lists the tactics in ATT&CK order with every parent technique sorted by name', async () => {
    const body = await matrix(RANGE);
    expect(body.tactics.map((t) => t.id)).toEqual(attack.tactics.map((t) => t.id));
    for (const tactic of body.tactics) {
      const parents = tactic.techniques.filter((t) => !t.id.includes('.'));
      const expected = attack.techniques.filter(
        (t) => !t.subtechnique && t.tactics.includes(tactic.shortname),
      );
      expect(parents.map((t) => t.id).sort()).toEqual(expected.map((t) => t.id).sort());
      const names = parents.map((t) => t.name);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
    }
  });

  it('counts enabled rules and in-range alerts by exact technique id', async () => {
    const body = await matrix(RANGE);
    const ruleCounts = ruleCountsByTechnique(deps.rules.list());
    expect(technique(body, 'credential-access', 'T1110.001')).toMatchObject({
      name: 'Password Guessing',
      url: 'https://attack.mitre.org/techniques/T1110/001',
      rules: ruleCounts.get('T1110.001'),
      alerts: 2,
    });
    expect(technique(body, 'credential-access', 'T1110')).toMatchObject({
      rules: ruleCounts.get('T1110') ?? 0,
      alerts: 0,
    });
  });

  it('lists a sub-technique only when it has rules or alerts, right after its parent', async () => {
    const body = await matrix(RANGE);
    const ruleCounts = ruleCountsByTechnique(deps.rules.list());
    const credential = body.tactics.find((t) => t.shortname === 'credential-access');
    const ids = credential?.techniques.map((t) => t.id) ?? [];
    const subs = ids.filter((id) => id.startsWith('T1110.'));
    expect(subs.length).toBeGreaterThan(0);
    expect(subs.every((id) => (ruleCounts.get(id) ?? 0) > 0 || id === 'T1110.001')).toBe(true);
    expect(ids.indexOf(subs[0] ?? '')).toBe(ids.indexOf('T1110') + 1);
  });

  it('drops a disabled rule from the coverage counts', async () => {
    const before = technique(await matrix(RANGE), 'credential-access', 'T1110.001')?.rules ?? 0;
    await request(app)
      .patch(`/api/rules/${RULES.bruteforce.id}`)
      .send({ enabled: false })
      .expect(200);
    const after = technique(await matrix(RANGE), 'credential-access', 'T1110.001')?.rules;
    await request(app)
      .patch(`/api/rules/${RULES.bruteforce.id}`)
      .send({ enabled: true })
      .expect(200);
    expect(after).toBe(before - 1);
  });

  it('answers 400 for an invalid range', async () => {
    await request(app)
      .get('/api/attack?from=2026-10-22T00:00:00Z&to=2026-10-21T00:00:00Z')
      .expect(400);
  });
});
