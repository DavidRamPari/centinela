import { createHash } from 'node:crypto';
import {
  ingestTokenCreatedSchema,
  ingestTokenListSchema,
  ingestTokenSchema,
  problemSchema,
} from '@centinela/shared';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_INGEST_TOKEN } from '../../src/config.js';
import { MAX_ACTIVE_TOKENS } from '../../src/auth/ingest-tokens.js';
import { createTestApp } from '../helpers/app.js';
import { TEST_USERNAME } from '../helpers/auth.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const LINE = 'Oct 25 14:03:12 token-host sshd[1]: Invalid user x from 192.0.2.1 port 1';

describe('ingest tokens API', () => {
  let db: TestDatabase;
  let app: ReturnType<typeof createTestApp>['app'];

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ app } = createTestApp({ pool: db.pool }));
  });
  afterAll(() => db.cleanup());

  const ingest = (token: string) =>
    request(app)
      .post('/api/ingest?source=linux_auth&host=token-host')
      .set('Authorization', `Bearer ${token}`)
      .type('text/plain')
      .send(LINE);

  async function create(label: string) {
    const res = await request(app).post('/api/tokens').send({ label }).expect(201);
    return ingestTokenCreatedSchema.parse(res.body);
  }

  async function auditRows(action: string) {
    const { rows } = await db.pool.query<{ actor: string; target: string; details: unknown }>(
      'SELECT actor, target, details FROM audit_log WHERE action = $1 ORDER BY seq',
      [action],
    );
    return rows;
  }

  it('creates a token whose secret is shown once and only its hash is stored', async () => {
    const created = await create('  web-01 shipper  ');
    expect(created.secret).toMatch(/^cnt_[A-Za-z0-9_-]{43}$/);
    expect(created.token).toMatchObject({
      label: 'web-01 shipper',
      prefix: created.secret.slice(0, 12),
      lastUsedAt: null,
      revokedAt: null,
    });

    const { rows } = await db.pool.query<{ token_hash: Buffer; created_by: string }>(
      'SELECT token_hash, created_by FROM ingest_tokens WHERE id = $1',
      [created.token.id],
    );
    expect(rows[0]?.created_by).toBe(TEST_USERNAME);
    expect(rows[0]?.token_hash.equals(createHash('sha256').update(created.secret).digest())).toBe(
      true,
    );

    const list = await request(app).get('/api/tokens').expect(200);
    expect(JSON.stringify(list.body)).not.toContain(created.secret);
    expect(ingestTokenListSchema.parse(list.body).items[0]).toEqual(created.token);
    expect(await auditRows('token.create')).toContainEqual({
      actor: TEST_USERNAME,
      target: created.token.id,
      details: { label: 'web-01 shipper', prefix: created.token.prefix },
    });
  });

  it('accepts the secret on POST /api/ingest and records its last use', async () => {
    const created = await create('agent');
    await ingest(created.secret).expect(200);
    const list = ingestTokenListSchema.parse((await request(app).get('/api/tokens')).body);
    expect(list.items.find((t) => t.id === created.token.id)?.lastUsedAt).not.toBeNull();
    // The environment token keeps working next to stored tokens.
    await ingest(DEV_INGEST_TOKEN).expect(200);
  });

  it('refuses a revoked token; revoking twice is harmless and audited once', async () => {
    const created = await create('to revoke');
    await ingest(created.secret).expect(200);
    const res = await request(app).post(`/api/tokens/${created.token.id}/revoke`).expect(200);
    const revoked = ingestTokenSchema.parse(res.body);
    expect(revoked.revokedAt).not.toBeNull();
    const ingestRes = await ingest(created.secret).expect(401);
    expect(ingestRes.headers['www-authenticate']).toMatch(/^Bearer/);

    const again = ingestTokenSchema.parse(
      (await request(app).post(`/api/tokens/${created.token.id}/revoke`).expect(200)).body,
    );
    expect(again.revokedAt).toBe(revoked.revokedAt);
    expect(
      (await auditRows('token.revoke')).filter((r) => r.target === created.token.id),
    ).toHaveLength(1);
  });

  it('refuses secrets that only resemble a token', async () => {
    const created = await create('lookalike');
    const last = created.secret.at(-1) === 'A' ? 'B' : 'A';
    await ingest(`${created.secret.slice(0, -1)}${last}`).expect(401);
    await ingest(created.token.prefix).expect(401);
  });

  it.each([
    ['an empty label', { label: '   ' }],
    ['a label over 100 characters', { label: 'x'.repeat(101) }],
    ['a label with control characters', { label: 'evil\u001b[31m' }],
    ['an unknown key', { label: 'ok', secret: 'mine' }],
  ])('answers 400 for %s', async (_label, body) => {
    const res = await request(app).post('/api/tokens').send(body).expect(400);
    problemSchema.parse(res.body);
  });

  it('answers 404 for an unknown token and 400 for an invalid id', async () => {
    await request(app).post(`/api/tokens/${uuidv7()}/revoke`).expect(404);
    await request(app).post('/api/tokens/not-a-uuid/revoke').expect(400);
  });

  it(`allows at most ${MAX_ACTIVE_TOKENS} active tokens`, async () => {
    const { rows } = await db.pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM ingest_tokens WHERE revoked_at IS NULL',
    );
    const missing = MAX_ACTIVE_TOKENS - Number(rows[0]?.count);
    for (let i = 0; i < missing; i += 1) await create(`bulk ${i}`);
    const res = await request(app).post('/api/tokens').send({ label: 'one too many' }).expect(409);
    expect(problemSchema.parse(res.body).detail).toContain(String(MAX_ACTIVE_TOKENS));
  });
});
