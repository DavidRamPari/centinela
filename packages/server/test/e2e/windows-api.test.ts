/**
 * Windows through the HTTP API (S5): loggen's small Sysmon sample is posted to
 * `POST /api/ingest?source=sysmon` as NDJSON with the bearer token, stored in PostgreSQL,
 * and read back through the events, alerts and ATT&CK endpoints the dashboard uses.
 */
import {
  alertSchema,
  attackResponseSchema,
  normalizedEventSchema,
  type Alert,
} from '@centinela/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generate, type GeneratedFile } from '@centinela/loggen';
import { DEV_INGEST_TOKEN } from '../../src/config.js';
import { createTestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const AUTH = `Bearer ${DEV_INGEST_TOKEN}`;
const RANGE = 'from=2026-10-20T00:00:00Z&to=2026-10-23T00:00:00Z';

/** Techniques of the rules the Windows scenarios are expected to raise. */
const WINDOWS_TECHNIQUES = [
  'T1003.001',
  'T1053.005',
  'T1059.001',
  'T1105',
  'T1204.002',
  'T1218.005',
  'T1218.010',
  'T1218.011',
];

describe('Sysmon through the HTTP API', () => {
  let db: TestDatabase;
  let app: ReturnType<typeof createTestApp>['app'];
  let files: GeneratedFile[];
  const summaries: Array<{ accepted: number; rejected: number; alertsCreated: number }> = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ app } = createTestApp({ pool: db.pool }));
    const sample = generate({
      seed: 42,
      days: 3,
      startMs: Date.parse('2026-10-20T00:00:00Z'),
      small: true,
    });
    files = sample.files.filter((file) => file.source === 'sysmon');
    for (const file of files) {
      const res = await request(app)
        .post(`/api/ingest?source=sysmon&host=${file.host}`)
        .set('Authorization', AUTH)
        .set('Content-Type', 'application/x-ndjson')
        .send(file.content)
        .expect(200);
      summaries.push(res.body as (typeof summaries)[number]);
    }
  }, 60_000);
  afterAll(() => db.cleanup());

  it('accepts every line of both workstations', () => {
    expect(files.map((f) => f.path)).toEqual(['ws-0142/sysmon.jsonl', 'ws-0187/sysmon.jsonl']);
    files.forEach((file, i) => {
      expect(summaries[i]).toMatchObject({ accepted: file.lineCount, rejected: 0 });
      expect(summaries[i]?.alertsCreated).toBeGreaterThan(0);
    });
  });

  it('returns Sysmon events with their Sigma fields and logsources', async () => {
    const res = await request(app)
      .get(`/api/events?source=sysmon&host=ws-0142&action=process_start&${RANGE}&limit=200`)
      .expect(200);
    const items = (res.body as { items: unknown[] }).items.map((e) =>
      normalizedEventSchema.parse(e),
    );
    expect(items.length).toBeGreaterThan(0);
    const word = items.find((e) => e.fields['process.parent.name'] === 'WINWORD.EXE');
    expect(word).toMatchObject({
      source: 'sysmon',
      host: 'ws-0142',
      category: 'process',
      user: 'm.condori',
      logsources: [{ product: 'windows', category: 'process_creation' }],
    });
    expect(word?.fields.Image).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );

    const detail = await request(app)
      .get(`/api/events/${word?.id ?? ''}`)
      .expect(200);
    expect(normalizedEventSchema.parse(detail.body).fields.ParentImage).toMatch(/WINWORD\.EXE$/);
  });

  it('lists the Windows alerts with DRL attribution for SigmaHQ rules', async () => {
    const res = await request(app).get(`/api/alerts?host=ws-0187&${RANGE}&limit=200`).expect(200);
    const alerts = (res.body as { items: unknown[] }).items.map((a) => alertSchema.parse(a));
    const mimikatz = alerts.find((a: Alert) => a.techniques.includes('T1003.001'));
    expect(mimikatz).toMatchObject({
      level: 'high',
      host: 'ws-0187',
      license: 'DRL-1.1',
      entities: { users: ['j.mamani'] },
    });
    expect(mimikatz?.author).toBeTruthy();
    expect(mimikatz?.ruleUrl).toMatch(/proc_creation_win_hktl_mimikatz_command_line\.yml$/);
    const own = alerts.find((a) => a.ruleTitle.startsWith('Outbound connection'));
    expect(own).toMatchObject({ license: 'MIT', author: 'DavidRamPari' });
  });

  it('shows the Windows techniques in the ATT&CK matrix', async () => {
    const res = await request(app).get(`/api/attack?${RANGE}`).expect(200);
    const body = attackResponseSchema.parse(res.body);
    const alerts = new Map<string, number>();
    for (const tactic of body.tactics) {
      for (const technique of tactic.techniques) {
        alerts.set(technique.id, Math.max(alerts.get(technique.id) ?? 0, technique.alerts));
      }
    }
    for (const id of WINDOWS_TECHNIQUES) expect(alerts.get(id), id).toBeGreaterThan(0);
  });
});
