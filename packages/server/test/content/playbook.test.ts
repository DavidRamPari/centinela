import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { playbookResponseSchema, problemSchema } from '@centinela/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContentPack, readContentPack } from '../../src/content/pack.js';
import { repoRoot } from '../../src/paths.js';
import { createTestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

/** `proc_creation_win_discovery_via_reg_queries.yml`, which has content. */
const WITH_CONTENT = '0022869c-49f7-4ff2-ba03-85ac42ddac58';
/** `proc_creation_win_hktl_dinjector.yml`: the generator's safety filter refused it. */
const WITHOUT_CONTENT = 'd78b5d61-187d-44b6-bf02-93486a80de5a';
/** `centinela-ssh-auth-failure`, a Centinela base rule. */
const CENTINELA_RULE = '5ab518e4-b4bf-44a2-9874-a8e86a590287';

const playbook = {
  summary: 'Summary <script>alert(1)</script>.',
  what_it_detects: 'What.',
  why_it_matters: 'Why.',
  triage_steps: ['Step.'],
  false_positives: ['Admins.'],
  response_steps: ['Contain.'],
  severity_rationale: 'Because.',
};

function contentFile(id: string, overrides: Record<string, unknown> = {}) {
  return {
    rule: { id, title: 't' },
    playbook: { es: { ...playbook, summary: 'Resumen.' }, en: playbook },
    fixtures: { positive: [], negative: [] },
    generated: {
      tool: 'content-pack/1',
      model: 'm',
      at: '2026-10-25T00:00:00Z',
      review: 'unreviewed',
      notice: 'AI-generated.',
    },
    ...overrides,
  };
}

/** `centinela-ssh-bruteforce-success`, the demo's critical correlation. */
const CORRELATION_RULE = '1751f556-a4e2-493f-a475-ead6e0163909';

/** A correlation rule's content: a playbook and no fixtures. */
function playbookOnly(id: string) {
  const { fixtures: _fixtures, ...rest } = contentFile(id, {
    rule: { id, title: 't', license: 'MIT', url: null, author: 'DavidRamPari' },
  });
  return rest;
}

describe('GET /api/rules/:id/playbook', () => {
  // Since S6 the route sits behind the session guard, which needs a session row.
  let db: TestDatabase;
  let app: ReturnType<typeof createTestApp>['app'];
  let signedOut: ReturnType<typeof createTestApp>['app'];
  beforeAll(async () => {
    db = await createTestDatabase();
    ({ app } = createTestApp({ pool: db.pool }));
    ({ app: signedOut } = createTestApp({ pool: db.pool, signedIn: false }));
  });
  afterAll(() => db.cleanup());

  it('answers 401 without the dashboard session', async () => {
    const res = await request(signedOut)
      .get(`/api/rules/${WITH_CONTENT}/playbook?lang=en`)
      .expect(401);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).not.toHaveProperty('playbook');
  });

  it("serves a Centinela correlation's playbook-only content with MIT attribution", async () => {
    const contentDir = mkdtempSync(join(tmpdir(), 'centinela-content-dir-'));
    try {
      mkdirSync(join(contentDir, 'centinela'));
      writeFileSync(
        join(contentDir, 'centinela', `${CORRELATION_RULE}.json`),
        JSON.stringify(playbookOnly(CORRELATION_RULE)),
      );
      const { app: withCentinela } = createTestApp({
        pool: db.pool,
        env: { CONTENT_DIR: contentDir },
      });
      const res = await request(withCentinela)
        .get(`/api/rules/${CORRELATION_RULE}/playbook?lang=es`)
        .expect(200);
      const body = playbookResponseSchema.parse(res.body);
      expect(body.playbook.summary).toBe('Resumen.');
      // Attribution comes from the loaded rule: Centinela's rules are MIT, with no SigmaHQ link.
      expect(body.rule).toEqual({
        title: 'Successful SSH login after a brute force',
        author: 'DavidRamPari',
        url: null,
        license: 'MIT',
      });
      // A Centinela rule without a file in that folder has no playbook.
      const missing = await request(withCentinela)
        .get(`/api/rules/${CENTINELA_RULE}/playbook`)
        .expect(404);
      expect(problemSchema.parse(missing.body).detail).toBe('No playbook for this rule');
    } finally {
      rmSync(contentDir, { recursive: true, force: true });
    }
  });

  it('returns the English playbook with the rule attribution and the AI notice', async () => {
    const res = await request(app).get(`/api/rules/${WITH_CONTENT}/playbook?lang=en`).expect(200);
    const body = playbookResponseSchema.parse(res.body);
    expect(body.ruleId).toBe(WITH_CONTENT);
    expect(body.lang).toBe('en');
    expect(body.playbook.summary).toMatch(/^reg\.exe or PowerShell read/);
    expect(body.playbook.triageSteps.length).toBeGreaterThan(2);
    expect(body.rule).toEqual({
      title: 'System Information Discovery via Registry Queries',
      author: 'lazarg',
      url: expect.stringMatching(
        /^https:\/\/github\.com\/SigmaHQ\/sigma\/blob\/[0-9a-f]{40}\/rules\/windows\/process_creation\/proc_creation_win_discovery_via_reg_queries\.yml$/,
      ) as string,
      license: 'DRL-1.1',
    });
    expect(body.generated).toMatchObject({ tool: 'content-pack/1', review: 'unreviewed' });
    expect(body.generated.notice).toContain('AI-generated');
  });

  it('returns the Spanish playbook with lang=es and English by default', async () => {
    const es = playbookResponseSchema.parse(
      (await request(app).get(`/api/rules/${WITH_CONTENT}/playbook?lang=es`).expect(200)).body,
    );
    expect(es.lang).toBe('es');
    expect(es.playbook.summary).toMatch(/^reg\.exe o PowerShell leyeron/);
    const byDefault = playbookResponseSchema.parse(
      (await request(app).get(`/api/rules/${WITH_CONTENT.toUpperCase()}/playbook`).expect(200))
        .body,
    );
    expect(byDefault.lang).toBe('en');
    expect(byDefault.ruleId).toBe(WITH_CONTENT);
  });

  it.each([
    ['a rule without content', WITHOUT_CONTENT, 'No playbook for this rule'],
    ['an unknown rule', '00000000-0000-4000-8000-00000000abcd', 'Rule not found'],
  ])('answers 404 problem+json for %s', async (_label, id, detail) => {
    const res = await request(app).get(`/api/rules/${id}/playbook?lang=es`).expect(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(problemSchema.parse(res.body).detail).toBe(detail);
  });

  it.each([
    ['an unknown language', `/api/rules/${WITH_CONTENT}/playbook?lang=fr`, 'lang'],
    ['a repeated language', `/api/rules/${WITH_CONTENT}/playbook?lang=en&lang=es`, 'lang'],
    ['an invalid id', '/api/rules/not-a-guid/playbook', 'id'],
  ])('answers 400 for %s', async (_label, path, field) => {
    const res = await request(app).get(path).expect(400);
    expect(problemSchema.parse(res.body).errors?.[0]?.path).toBe(field);
  });
});

describe('content pack loading', () => {
  const root = mkdtempSync(join(tmpdir(), 'centinela-pack-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('loads every vendored playbook once per folder', () => {
    const pack = loadContentPack(join(repoRoot, 'content'));
    // 1,221 SigmaHQ rules, plus Centinela's own rules once content/centinela is generated.
    expect(pack.size).toBeGreaterThanOrEqual(1221);
    expect(pack.errors).toEqual([]);
    expect(loadContentPack(join(repoRoot, 'content'))).toBe(pack);
    expect(pack.get(WITH_CONTENT.toUpperCase())?.playbooks.es.summary).toMatch(/^reg\.exe/);
    expect(pack.get(WITHOUT_CONTENT)).toBeUndefined();
  });

  it('treats a missing folder as an empty pack', () => {
    const pack = readContentPack(join(root, 'nothing-here'));
    expect(pack.size).toBe(0);
    expect(pack.errors).toEqual([]);
  });

  it('skips files that are malformed, duplicated or do not fit the API schema, keeping text as text', () => {
    const dir = join(root, 'content', 'sigma');
    mkdirSync(dir, { recursive: true });
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    writeFileSync(join(dir, `${a}.json`), JSON.stringify(contentFile(a)));
    writeFileSync(join(dir, 'copy.json'), JSON.stringify(contentFile(a)));
    writeFileSync(
      join(dir, `${b}.json`),
      JSON.stringify(
        contentFile(b, {
          playbook: { es: playbook, en: { ...playbook, summary: 'x'.repeat(5000) } },
        }),
      ),
    );
    writeFileSync(join(dir, 'broken.json'), '{');
    const pack = readContentPack(join(root, 'content'));
    expect(pack.size).toBe(1);
    expect(pack.get(a)?.playbooks.en.summary).toBe('Summary <script>alert(1)</script>.');
    expect(pack.get(a)?.playbooks.es.summary).toBe('Resumen.');
    expect(pack.errors.map((e) => [e.file, e.reason])).toEqual([
      ['sigma/broken.json', 'invalid JSON'],
      [`sigma/${b}.json`, 'playbook does not fit the API schema'],
      ['sigma/copy.json', `duplicate content for rule ${a}`],
    ]);
  });

  it('reads Centinela content after SigmaHQ content and accepts playbook-only files', () => {
    const base = join(root, 'both');
    mkdirSync(join(base, 'sigma'), { recursive: true });
    mkdirSync(join(base, 'centinela'), { recursive: true });
    const a = '33333333-3333-4333-8333-333333333333';
    writeFileSync(join(base, 'sigma', `${a}.json`), JSON.stringify(contentFile(a)));
    writeFileSync(join(base, 'centinela', `${a}.json`), JSON.stringify(contentFile(a)));
    writeFileSync(
      join(base, 'centinela', `${CORRELATION_RULE}.json`),
      JSON.stringify(playbookOnly(CORRELATION_RULE)),
    );
    const pack = readContentPack(base);
    expect(pack.size).toBe(2);
    expect(pack.get(CORRELATION_RULE)?.playbooks.en.whatItDetects).toBe('What.');
    expect(pack.errors).toEqual([
      { file: `centinela/${a}.json`, reason: `duplicate content for rule ${a}` },
    ]);
  });
});
