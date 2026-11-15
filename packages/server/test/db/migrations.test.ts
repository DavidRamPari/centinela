import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

describe('migrations', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(() => db.cleanup());

  async function columns(table: string): Promise<Record<string, string>> {
    const { rows } = await db.pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2`,
      [db.schema, table],
    );
    return Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
  }

  it('creates every table from ARCHITECTURE §8 (and S6) in the target schema', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [db.schema],
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'admin_sessions',
      'alert_events',
      'alerts',
      'audit_log',
      'detector_checkpoints',
      'events',
      'ingest_streams',
      'ingest_tokens',
      'pgmigrations',
      'rule_state',
      'tenants',
    ]);
  });

  it('creates the expected columns and types', async () => {
    expect(await columns('events')).toEqual({
      id: 'uuid',
      ts: 'timestamp with time zone',
      ingested_at: 'timestamp with time zone',
      source: 'text',
      host: 'text',
      category: 'text',
      action: 'text',
      outcome: 'text',
      user_name: 'text',
      src_ip: 'inet',
      src_port: 'integer',
      message: 'text',
      fields: 'jsonb',
      stream_id: 'uuid',
    });
    expect(Object.keys(await columns('alerts')).sort()).toEqual(
      [
        'id',
        'rule_id',
        'rule_title',
        'rule_type',
        'level',
        'status',
        'resolution',
        'note',
        'dedup_key',
        'group_key',
        'host',
        'techniques',
        'tactics',
        'entities',
        'first_seen',
        'last_seen',
        'count',
        'author',
        'rule_url',
        'license',
        'created_at',
        'updated_at',
      ].sort(),
    );
    expect(await columns('alert_events')).toEqual({ alert_id: 'uuid', event_id: 'uuid' });
    expect(await columns('rule_state')).toEqual({
      rule_id: 'text',
      enabled: 'boolean',
      updated_at: 'timestamp with time zone',
    });
  });

  it('creates the tables of live detection with one default organization (S12)', async () => {
    expect(await columns('tenants')).toEqual({
      id: 'uuid',
      slug: 'text',
      name: 'text',
      created_at: 'timestamp with time zone',
    });
    const { rows } = await db.pool.query<{ id: string; slug: string }>(
      'SELECT id, slug FROM tenants',
    );
    expect(rows).toEqual([{ id: '00000000-0000-7000-8000-000000000001', slug: 'default' }]);
    expect(await columns('ingest_streams')).toEqual({
      id: 'uuid',
      tenant_id: 'uuid',
      kind: 'text',
      token_id: 'uuid',
      source: 'text',
      host: 'text',
      first_seen_at: 'timestamp with time zone',
      last_seen_at: 'timestamp with time zone',
      last_event_ts: 'timestamp with time zone',
      accepted: 'bigint',
      rejected: 'bigint',
      late: 'bigint',
    });
    expect(await columns('detector_checkpoints')).toEqual({
      tenant_id: 'uuid',
      name: 'text',
      position: 'uuid',
      state: 'bytea',
      state_version: 'integer',
      updated_at: 'timestamp with time zone',
    });
  });

  it('keeps one stream per delivery path, also without a token', async () => {
    const insert = (id: string, kind: string) =>
      db.pool.query(
        `INSERT INTO ingest_streams (id, kind, source, host) VALUES ($1, $2, 'linux_auth', 'web-01')`,
        [id, kind],
      );
    await insert('01930f6e-8a4b-7c2d-9e1f-000000000001', 'token');
    // token_id is null in both rows: NULLS NOT DISTINCT makes them the same path.
    await expect(insert('01930f6e-8a4b-7c2d-9e1f-000000000002', 'token')).rejects.toThrow(
      /ingest_streams_path_idx/,
    );
    await insert('01930f6e-8a4b-7c2d-9e1f-000000000003', 'upload');
    await expect(insert('01930f6e-8a4b-7c2d-9e1f-000000000004', 'agent')).rejects.toThrow(
      /check constraint/,
    );
    await db.pool.query('DELETE FROM ingest_streams');
  });

  it('creates the indexes', async () => {
    const { rows } = await db.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1`,
      [db.schema],
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'events_ts_idx',
        'events_source_ts_idx',
        'events_host_ts_idx',
        'events_src_ip_ts_idx',
        'events_user_ts_idx',
        'events_action_ts_idx',
        'events_message_fts',
        'alerts_last_seen_idx',
        'alerts_status_level_idx',
        'alerts_rule_idx',
        'alerts_dedup_open_idx',
        'alerts_techniques_idx',
      ]),
    );
  });

  it('enforces the CHECK constraints', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO alerts (id, rule_id, rule_title, rule_type, level, dedup_key, first_seen, last_seen)
         VALUES ($1, 'r', 't', 'sigma', 'severe', 'k', now(), now())`,
        ['01930f6e-8a4b-7c2d-9e1f-0a1b2c3d4e5f'],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('is a no-op when run again', async () => {
    expect(await runMigrations({ databaseUrl: db.databaseUrl, schema: db.schema })).toEqual([]);
  });
});
