import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatSummary, parseCliArgs } from '../../src/ingest/cli-options.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const serverRoot = fileURLToPath(new URL('../..', import.meta.url));

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    ['--conditions=@centinela/source', '--import', 'tsx', 'src/ingest/cli.ts', ...args],
    {
      cwd: serverRoot,
      encoding: 'utf8',
      env: { ...process.env, LOG_LEVEL: 'silent', ...env },
    },
  );
}

describe('ingest CLI options', () => {
  it('parses and validates the flags', () => {
    expect(
      parseCliArgs([
        '--source',
        'nginx_access',
        '--host',
        'web-01',
        '--file',
        'a.log',
        '--tz',
        'America/Lima',
        '--year',
        '2025',
        '--parse-only',
      ]),
    ).toEqual({
      source: 'nginx_access',
      host: 'web-01',
      file: 'a.log',
      tz: 'America/Lima',
      year: 2025,
      parseOnly: true,
    });
    expect(parseCliArgs(['--source', 'linux_auth', '--file', 'a.log'])).toMatchObject({
      host: 'unknown',
      tz: 'UTC',
      parseOnly: false,
    });
    expect(parseCliArgs(['--help'])).toBe('help');
  });

  it.each([
    [['--file', 'a.log'], /--source/],
    [['--source', 'linux_auth'], /--file is required/],
    [['--source', 'sysmonx', '--file', 'a'], /--source/],
    [['--source', 'linux_auth', '--file', 'a', '--tz', 'Nowhere/City'], /time zone/],
    [['--source', 'linux_auth', '--file', 'a', '--host', 'bad host'], /--host/],
    [['--source', 'linux_auth', '--file', 'a', '--year', '12'], /--year/],
  ])('rejects %j', (args, message) => {
    expect(() => parseCliArgs(args)).toThrow(message);
  });

  it('rejects unknown flags', () => {
    expect(() => parseCliArgs(['--source', 'linux_auth', '--file', 'a', '--bogus'])).toThrow();
  });

  it('formats counts and throughput', () => {
    const text = formatSummary(
      'auth.log',
      {
        accepted: 9,
        rejected: 1,
        rejections: [{ line: 4, reason: 'not a syslog line' }],
        alertsCreated: 2,
        alertsUpdated: 1,
        durationMs: 500,
      },
      false,
    );
    expect(text).toContain('lines:     10');
    expect(text).toContain('alerts:    2 created, 1 updated');
    expect(text).toContain('speed:     20 lines/s');
    expect(text).toContain('rejected line 4: not a syslog line');
  });
});

describe('npm run ingest', () => {
  let dir: string;
  let file: string;
  let db: TestDatabase;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'centinela-ingest-'));
    file = join(dir, 'auth.log');
    const lines = Array.from(
      { length: 2500 },
      (_, i) =>
        `2026-10-21T03:12:${String(i % 60).padStart(2, '0')}.000000-05:00 cli-host sshd[${i}]: Failed password for root from 203.0.113.45 port ${40000 + i} ssh2`,
    );
    writeFileSync(file, `${lines.join('\n')}\nnot a syslog line\n`);
    db = await createTestDatabase();
  });
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db.cleanup();
  });

  it('parses a file with --parse-only and prints counts and lines per second', () => {
    const result = runCli([
      '--source',
      'linux_auth',
      '--host',
      'x',
      '--file',
      file,
      '--parse-only',
    ]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('accepted:  2500');
    expect(result.stdout).toContain('rejected:  1');
    expect(result.stdout).toMatch(/speed: +\d+ lines\/s/);
    expect(result.stdout).toContain('rejected line 2501: not a syslog line');
  });

  it('stores the events in PostgreSQL', async () => {
    const url = new URL(db.databaseUrl);
    url.searchParams.set('options', `-c search_path=${db.schema}`);
    const result = runCli(['--source', 'linux_auth', '--file', file], {
      DATABASE_URL: url.toString(),
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Ingested');
    const { rows } = await db.pool.query<{ count: string }>(
      "SELECT count(*) FROM events WHERE host = 'cli-host'",
    );
    expect(Number(rows[0]?.count)).toBe(2500);
  });

  it('exits 1 for a missing file and 2 for bad arguments', () => {
    const missing = runCli([
      '--source',
      'linux_auth',
      '--file',
      join(dir, 'nope.log'),
      '--parse-only',
    ]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('Cannot read');
    const bad = runCli(['--source', 'nope', '--file', file]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('Usage: npm run ingest');
  });

  it('prints usage with --help', () => {
    const help = runCli(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--parse-only');
  });
});
