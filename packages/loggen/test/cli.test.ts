import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { HELP_TEXT } from '../src/help.js';
import { parseCliOptions } from '../src/options.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'centinela-loggen-'));
  tempDirs.push(dir);
  return dir;
}

function run(args: string[]) {
  return spawnSync(
    process.execPath,
    ['--conditions=@centinela/source', '--import', 'tsx', 'src/cli.ts', ...args],
    {
      cwd: packageRoot,
      encoding: 'utf8',
    },
  );
}

function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      out[path.slice(dir.length + 1)] = readFileSync(path, 'utf8');
    }
  }
  return out;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('loggen options', () => {
  it('uses the documented defaults', () => {
    expect(parseCliOptions([])).toEqual({
      seed: 42,
      days: 3,
      startMs: Date.parse('2026-10-20T00:00:00Z'),
      small: false,
      out: 'samples',
    });
  });

  it('parses every flag', () => {
    expect(
      parseCliOptions([
        '--seed',
        '7',
        '--days',
        '2',
        '--start',
        '2027-01-01T00:00:00-05:00',
        '--out',
        'x',
        '--small',
      ]),
    ).toEqual({
      seed: 7,
      days: 2,
      startMs: Date.parse('2027-01-01T05:00:00Z'),
      small: true,
      out: 'x',
    });
    expect(parseCliOptions(['-h'])).toBe('help');
  });

  it.each([
    [['--seed', 'abc'], /--seed/],
    [['--seed', '-1'], /--seed/],
    [['--seed', '4294967296'], /--seed/],
    [['--days', '0'], /--days/],
    [['--days', '31'], /--days/],
    [['--start', 'yesterday'], /--start/],
    [['--start', '2026-10-20'], /--start/],
    [['--out', ' '], /--out/],
  ])('rejects %j', (args, message) => {
    expect(() => parseCliOptions(args)).toThrow(message);
  });

  it('documents every flag in the help text', () => {
    for (const flag of ['--seed', '--days', '--start', '--out', '--small', '--help']) {
      expect(HELP_TEXT).toContain(flag);
    }
  });
});

describe('loggen CLI', () => {
  it('prints the help text and exits 0', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(HELP_TEXT);
  });

  it('exits 2 with a message for bad flags', () => {
    const result = run(['--days', 'many']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--days must be');
  });

  it('writes the logs and the ground truth, byte-identical for the same seed', () => {
    const first = tempDir();
    const second = tempDir();
    const a = run(['--small', '--seed', '9', '--out', first]);
    const b = run(['--small', '--seed', '9', '--out', second]);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(a.stdout).toContain('19 scenarios');
    const treeA = readTree(first);
    const treeB = readTree(second);
    expect(Object.keys(treeA).sort()).toEqual([
      'bastion-01/auth.log',
      'db-01/auth.log',
      'ground-truth.json',
      'web-01/access.log',
      'web-01/auth.log',
      'web-02/access.log',
      'web-02/auth.log',
      'ws-0142/sysmon.jsonl',
      'ws-0187/sysmon.jsonl',
    ]);
    expect(treeA).toEqual(treeB);
    const truth = JSON.parse(treeA['ground-truth.json'] ?? '{}') as {
      seed: number;
      small: boolean;
    };
    expect(truth).toMatchObject({ seed: 9, small: true });
  });

  it('differs for a different seed', () => {
    const first = tempDir();
    const second = tempDir();
    run(['--small', '--seed', '1', '--out', first]);
    run(['--small', '--seed', '2', '--out', second]);
    expect(readTree(first)['web-01/access.log']).not.toBe(readTree(second)['web-01/access.log']);
  });
});
