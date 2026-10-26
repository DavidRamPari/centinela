import {
  problemSchema,
  ruleDetailResponseSchema,
  ruleMetaSchema,
  rulesPageSchema,
  type RuleListItem,
} from '@centinela/shared';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_INGEST_TOKEN } from '../../src/config.js';
import { createDetector } from '../../src/detection/index.js';
import { repoRoot } from '../../src/paths.js';
import { createRuleCatalog } from '../../src/pipeline/rule-catalog.js';
import { compareRules } from '../../src/routes/rules.js';
import { createTestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { RULES } from '../helpers/seed.js';

const NOT_IN_SUDOERS = RULES.notInSudoers.id;
const UNKNOWN_RULE = '00000000-0000-4000-8000-00000000abcd';

function sudoLine(second: number): string {
  const ts = `2026-10-25T14:03:${String(second).padStart(2, '0')}.000000+00:00`;
  return `${ts} db-01 sudo[4242]:   intern : user NOT in sudoers ; TTY=pts/1 ; PWD=/home/intern ; USER=root ; COMMAND=/bin/cat /etc/shadow`;
}

describe('rules API', () => {
  let db: TestDatabase;
  let app: ReturnType<typeof createTestApp>['app'];
  let deps: ReturnType<typeof createTestApp>['deps'];

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ app, deps } = createTestApp({ pool: db.pool }));
  });
  afterAll(() => db.cleanup());

  async function list(query: string) {
    const res = await request(app).get(`/api/rules?${query}`).expect(200);
    return rulesPageSchema.parse(res.body);
  }

  async function all(query: string): Promise<RuleListItem[]> {
    const items: RuleListItem[] = [];
    let cursor: string | null = null;
    do {
      const page = await list(`${query}&limit=200${cursor ? `&cursor=${cursor}` : ''}`);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return items;
  }

  async function ingest(lines: string[]) {
    const res = await request(app)
      .post('/api/ingest?source=linux_auth&host=db-01')
      .set('Authorization', `Bearer ${DEV_INGEST_TOKEN}`)
      .type('text/plain')
      .send(lines.join('\n'))
      .expect(200);
    return res.body as { accepted: number; alertsCreated: number };
  }

  async function alertsFor(ruleId: string): Promise<number> {
    const { rows } = await db.pool.query<{ count: string }>(
      'SELECT count(*) FROM alerts WHERE rule_id = $1',
      [ruleId],
    );
    return Number(rows[0]?.count);
  }

  describe('GET /api/rules', () => {
    it('returns the first 50 rules, critical first, with a cursor', async () => {
      const page = await list('');
      expect(page.items).toHaveLength(50);
      expect(page.nextCursor).not.toBeNull();
      expect(page.items[0]?.level).toBe('critical');
    });

    it('walks every rule exactly once in a stable order', async () => {
      const items = await all('');
      const expected = deps.rules.list().sort(compareRules);
      expect(items.map((r) => r.id)).toEqual(expected.map((r) => r.id));
      expect(new Set(items.map((r) => r.id)).size).toBe(items.length);
      expect(items.length).toBeGreaterThan(1000);
    });

    it.each([
      ['origin', 'origin=centinela', (r: RuleListItem) => r.origin === 'centinela'],
      [
        'level (list)',
        'level=critical,high',
        (r: RuleListItem) => ['critical', 'high'].includes(r.level),
      ],
      ['technique', 'technique=T1110.001', (r: RuleListItem) => r.techniques.includes('T1110.001')],
      [
        'supported=true',
        'supported=true',
        (r: RuleListItem) => r.supported && r.unsupportedReason === null,
      ],
      [
        'q (title, name, path…)',
        'q=BRUTEFORCE',
        (r: RuleListItem) =>
          /bruteforce/i.test(`${r.title} ${r.name ?? ''} ${r.path} ${r.description ?? ''}`),
      ],
    ])('filters by %s', async (_name, query, predicate) => {
      const items = await all(query);
      expect(items.length).toBeGreaterThan(0);
      expect(items.every(predicate)).toBe(true);
    });

    it('lists no unsupported rule (every vendored rule compiles, docs/rules-report.md)', async () => {
      expect(await all('supported=false')).toEqual([]);
    });

    it('lists the twelve Centinela rules with their names', async () => {
      const names = (await all('origin=centinela')).map((r) => r.name).sort();
      expect(names).toHaveLength(12);
      expect(names).toContain('centinela-ssh-bruteforce-success');
    });

    it.each([
      [
        'a cursor the server did not produce',
        `cursor=${Buffer.from(UNKNOWN_RULE).toString('base64url')}`,
      ],
      ['a garbage cursor', 'cursor=AAAA'],
      ['supported=yes', 'supported=yes'],
      ['an unknown origin', 'origin=elastic'],
      ['limit above 200', 'limit=201'],
    ])('answers 400 for %s', async (_name, query) => {
      const res = await request(app).get(`/api/rules?${query}`).expect(400);
      expect(problemSchema.parse(res.body).status).toBe(400);
    });
  });

  describe('GET /api/rules/:id', () => {
    it('returns the metadata and the YAML source', async () => {
      const res = await request(app).get(`/api/rules/${NOT_IN_SUDOERS}`).expect(200);
      const { rule, source } = ruleDetailResponseSchema.parse(res.body);
      expect(rule).toMatchObject({
        id: NOT_IN_SUDOERS,
        name: 'centinela-sudo-user-not-in-sudoers',
        origin: 'centinela',
        license: 'MIT',
        path: 'rules/centinela/linux/sudo_user_not_in_sudoers.yml',
      });
      expect(source).toContain(`id: ${NOT_IN_SUDOERS}`);
    });

    it('accepts the id in upper case', async () => {
      await request(app).get(`/api/rules/${NOT_IN_SUDOERS.toUpperCase()}`).expect(200);
    });

    it('answers 404 for an unknown id and 400 for an invalid one', async () => {
      await request(app).get(`/api/rules/${UNKNOWN_RULE}`).expect(404);
      await request(app).get('/api/rules/not-a-rule').expect(400);
    });
  });

  describe('PATCH /api/rules/:id', () => {
    it('disables a rule: persisted, listed, and no longer alerting', async () => {
      const res = await request(app)
        .patch(`/api/rules/${NOT_IN_SUDOERS}`)
        .send({ enabled: false })
        .expect(200);
      expect(ruleMetaSchema.parse(res.body)).toMatchObject({ id: NOT_IN_SUDOERS, enabled: false });

      const { rows } = await db.pool.query('SELECT rule_id, enabled FROM rule_state');
      expect(rows).toEqual([{ rule_id: NOT_IN_SUDOERS, enabled: false }]);
      expect((await all('enabled=false')).map((r) => r.id)).toEqual([NOT_IN_SUDOERS]);

      const summary = await ingest([sudoLine(1)]);
      expect(summary.accepted).toBe(1);
      expect(await alertsFor(NOT_IN_SUDOERS)).toBe(0);
    });

    it('keeps the flag across a restart (a new detector reads rule_state)', async () => {
      const engine = createDetector({ rulesDir: join(repoRoot, 'rules') });
      const catalog = createRuleCatalog({ engine, pool: db.pool });
      expect(catalog.get(NOT_IN_SUDOERS)?.meta.enabled).toBe(true);
      await catalog.ready();
      expect(catalog.get(NOT_IN_SUDOERS)?.meta.enabled).toBe(false);
    });

    it('enables it again; new matches alert and show up as matches', async () => {
      await request(app).patch(`/api/rules/${NOT_IN_SUDOERS}`).send({ enabled: true }).expect(200);
      await ingest([sudoLine(30)]);
      expect(await alertsFor(NOT_IN_SUDOERS)).toBe(1);
      const item = (await list('origin=centinela&q=sudoers')).items.find(
        (r) => r.id === NOT_IN_SUDOERS,
      );
      expect(item).toMatchObject({ enabled: true, matches: 1 });
    });

    it.each([
      ['a non-boolean flag', { enabled: 'no' }],
      ['an unknown key', { enabled: true, level: 'low' }],
      ['an empty body', {}],
    ])('answers 400 for %s', async (_name, body) => {
      await request(app).patch(`/api/rules/${NOT_IN_SUDOERS}`).send(body).expect(400);
    });

    it('answers 404 for an unknown rule', async () => {
      await request(app).patch(`/api/rules/${UNKNOWN_RULE}`).send({ enabled: false }).expect(404);
    });
  });
});
