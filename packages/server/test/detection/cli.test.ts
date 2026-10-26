import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseBenchArgs, parseReportArgs } from '../../src/detection/cli/args.js';
import { repoRoot } from '../../src/paths.js';

const serverRoot = fileURLToPath(new URL('../..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'centinela-cli-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function runCli(script: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ['--conditions=@centinela/source', '--import', 'tsx', script, ...args],
    {
      cwd: serverRoot,
      encoding: 'utf8',
      env: { ...process.env, INIT_CWD: scratch },
      timeout: 120_000,
    },
  );
}

describe('npm run rules:report', () => {
  it('prints counts by folder and writes the report', () => {
    const result = runCli('src/detection/cli/report.ts', ['--out', 'report.md']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('npm run rules:report');
    expect(result.stdout).toMatch(/sigma\/windows\/process_creation\s+1193 files/);
    expect(result.stdout).toMatch(/SigmaHQ rules compiled: \d+\/1231/);
    const report = readFileSync(join(scratch, 'report.md'), 'utf8');
    expect(report).toContain('# Rules report');
    expect(report).toContain('## Skipped rules by reason');
    expect(report).toContain('## SigmaHQ regression samples');
    expect(report).toContain('`centinela-ssh-bruteforce-success` | temporal_ordered');
  }, 120_000);

  it('exits 2 on unknown options', () => {
    const result = runCli('src/detection/cli/report.ts', ['--nope']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage: npm run rules:report');
  });
});

describe('npm run bench', () => {
  it('reports events per second for a mix', () => {
    const result = runCli('src/detection/cli/bench.ts', ['--events', '2000', '--mix', 'linux-web']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/linux\/web mix\s+2,000 events in [\d.]+ s = [\d,]+ events\/s/);
    expect(result.stdout).not.toContain('windows');
  }, 120_000);

  it('prints help and rejects bad values', () => {
    expect(runCli('src/detection/cli/bench.ts', ['--help']).stdout).toContain(
      'Usage: npm run bench',
    );
    expect(runCli('src/detection/cli/bench.ts', ['--events', '0']).status).toBe(2);
    expect(runCli('src/detection/cli/bench.ts', ['--mix', 'mainframe']).status).toBe(2);
  });
});

describe('argument parsing', () => {
  it('defaults to the repository rules and report path', () => {
    expect(parseReportArgs([])).toEqual({
      rulesDir: join(repoRoot, 'rules'),
      out: join(repoRoot, 'docs', 'rules-report.md'),
    });
    expect(parseBenchArgs([])).toEqual({
      events: 100_000,
      mix: 'all',
      rulesDir: join(repoRoot, 'rules'),
    });
  });

  it('validates values with zod', () => {
    expect(() => parseBenchArgs(['--events', 'many'])).toThrow('--events');
    expect(() => parseBenchArgs(['--events', '1.5'])).toThrow('--events');
    expect(parseBenchArgs(['--events', '500', '--mix', 'windows'])).toMatchObject({
      events: 500,
      mix: 'windows',
    });
    expect(parseReportArgs(['--help'])).toBe('help');
  });
});
