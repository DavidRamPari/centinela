/**
 * End-to-end detection (PLAN S4, ARCHITECTURE §13): loggen's `--small` sample → the real
 * pipeline (parsers, PostgreSQL event store, detector with persisted rule flags, PostgreSQL
 * alert sink) → alerts in a throwaway schema, compared with the ground truth. Every
 * scenario must raise each of its expected alerts; background traffic alone may raise at
 * most two `high` or `critical` alerts.
 */
import { join } from 'node:path';
import { DEFAULT_SEED, DEFAULT_START, generate, type GenerationResult } from '@centinela/loggen';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkScenarios, type ScenarioResult } from '../../src/db/ground-truth.js';
import { createDetector } from '../../src/detection/index.js';
import { repoRoot } from '../../src/paths.js';
import { createPipeline } from '../../src/pipeline/index.js';
import { replayFiles, type ReplayResult } from '../../src/pipeline/replay.js';
import { createRuleCatalog } from '../../src/pipeline/rule-catalog.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

/** At most this many high/critical alerts may come from background traffic (PLAN S4). */
const MAX_BACKGROUND_HIGH = 2;

describe('end-to-end detection: loggen --small through the pipeline and PostgreSQL', () => {
  let db: TestDatabase;
  let sample: GenerationResult;
  let replay: ReplayResult;
  let results: ScenarioResult[];

  beforeAll(async () => {
    db = await createTestDatabase();
    sample = generate({
      seed: DEFAULT_SEED,
      days: 3,
      startMs: Date.parse(DEFAULT_START),
      small: true,
    });
    const engine = createDetector({ rulesDir: join(repoRoot, 'rules') });
    const rules = createRuleCatalog({ engine, pool: db.pool });
    const pipeline = createPipeline({ pool: db.pool, detector: engine, rules });
    replay = await replayFiles(
      pipeline,
      sample.files.map((file) => ({
        path: file.path,
        source: file.file === 'auth' ? 'linux_auth' : 'nginx_access',
        host: file.host,
        lines: file.content.split('\n'),
      })),
    );
    results = await checkScenarios(db.pool, sample.groundTruth.scenarios, rules.list());
  }, 120_000);
  afterAll(() => db.cleanup());

  it('stores every generated line as an event', async () => {
    expect(replay.rejected).toBe(0);
    expect(replay.accepted).toBe(sample.lines.length);
    const { rows } = await db.pool.query<{ count: string }>('SELECT count(*) FROM events');
    expect(Number(rows[0]?.count)).toBe(sample.lines.length);
  });

  it('detects every ground-truth scenario with each expected rule', () => {
    const detected = results.filter((r) => r.detected).length;
    console.log(`detected ${detected}/${results.length} scenarios`);
    const missing = results.flatMap((r) =>
      r.rules.filter((rule) => rule.alerts === 0).map((rule) => `${r.id} → ${rule.expected}`),
    );
    expect(missing).toEqual([]);
    expect(detected).toBe(sample.groundTruth.scenarios.length);
  });

  it(`raises at most ${MAX_BACKGROUND_HIGH} high or critical alerts from background traffic`, async () => {
    // Each line is stored verbatim as `message`; map it back to its scenario.
    const scenarioOf = new Map<string, string | null>();
    for (const line of sample.lines) scenarioOf.set(line.text, line.scenario);
    expect(scenarioOf.size).toBe(sample.lines.length);

    const { rows } = await db.pool.query<{ id: string; rule_title: string; messages: string[] }>(
      `SELECT a.id, a.rule_title, array_agg(e.message) AS messages
         FROM alerts a
         JOIN alert_events ae ON ae.alert_id = a.id
         JOIN events e ON e.id = ae.event_id
        WHERE a.level IN ('high', 'critical')
        GROUP BY a.id, a.rule_title`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const background = rows.filter((row) =>
      row.messages.every((message) => (scenarioOf.get(message) ?? null) === null),
    );
    console.log(`${background.length} high/critical alerts from background traffic`);
    const titles = background.map((row) => row.rule_title).join(', ');
    expect(background.length, titles).toBeLessThanOrEqual(MAX_BACKGROUND_HIGH);
  });

  it('links each alert to stored events', async () => {
    const { rows } = await db.pool.query<{ orphans: string }>(
      `SELECT count(*) AS orphans FROM alert_events ae
        WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id = ae.event_id)`,
    );
    expect(Number(rows[0]?.orphans)).toBe(0);
  });
});
