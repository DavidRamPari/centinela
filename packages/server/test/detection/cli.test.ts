import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseBenchArgs, parseLintArgs, parseReportArgs } from '../../src/detection/cli/args.js';
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

describe('npm run rules:lint', () => {
  const lint = 'src/detection/cli/lint.ts';

  it('passes on the repository rules: every finding is in the baseline', () => {
    const result = runCli(lint, []);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('npm run rules:lint');
    expect(result.stdout).toMatch(/checked [\d,]+ rules in [\d,]+ YAML files under /);
    expect(result.stdout).toMatch(/findings: (\d+) \(known: \1, new: 0\)/);
    expect(result.stdout).toContain('stale baseline entries: 0');
    expect(result.stdout).toContain(
      "selection: CommandLine: 'RunWizard'  [unsatisfiable] no exact value of this key can also satisfy CommandLine|re (fixed in SigmaHQ/sigma#6546)",
    );
    expect(result.stdout).not.toContain('New:');
  }, 120_000);

  it('fails without the baseline: the vendored rules still have the bugs fixed upstream', () => {
    const result = runCli(lint, ['--no-baseline']);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/findings: (\d+) \(known: 0, new: \1\)/);
    expect(result.stdout).not.toContain('stale baseline entries');
    expect(result.stdout).toContain("selection_img: Image: '\\AgentExecutor.exe'  [partial-path]");
  }, 120_000);

  it('reports new findings, stale entries and invalid files in any folder of Sigma rules', () => {
    // Relative paths are relative to where npm was started (INIT_CWD is the scratch folder).
    const rules = join(scratch, 'lint-rules');
    mkdirSync(join(rules, 'windows'), { recursive: true });
    writeFileSync(
      join(rules, 'windows', 'broken.yml'),
      "title: Broken\ndetection:\n  selection:\n    Image: 'tool.exe'\n  condition: selection\n",
    );
    writeFileSync(
      join(scratch, 'known.json'),
      JSON.stringify({
        entries: [{ file: 'windows/fixed.yml', check: 'folder', key: 'Image', upstream: 'fixed' }],
      }),
    );
    const result = runCli(lint, ['--rules-dir', 'lint-rules', '--baseline', 'known.json']);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('checked 1 rule in 1 YAML file under lint-rules');
    expect(result.stdout).toContain('findings: 1 (known: 0, new: 1)');
    expect(result.stdout).toContain('stale baseline entries: 1');
    expect(result.stdout).toContain(
      "New:\n  windows/broken.yml (Broken)\n    selection: Image: 'tool.exe'  [partial-path]",
    );
    expect(result.stdout).toContain('  windows/fixed.yml: Image [folder] fixed');

    writeFileSync(join(rules, 'windows', 'broken.yml'), 'title: Fixed\n');
    writeFileSync(join(rules, 'invalid.yml'), 'title: [unclosed\n');
    const invalid = runCli(lint, ['--rules-dir', 'lint-rules', '--no-baseline']);
    expect(invalid.status, invalid.stderr).toBe(1);
    expect(invalid.stdout).toContain('findings: 0 (known: 0, new: 0)');
    expect(invalid.stdout).toContain('files not checked: 1');
    expect(invalid.stdout).toMatch(/Not checked .*\n {2}invalid\.yml: yaml:invalid/);

    rmSync(join(rules, 'invalid.yml'));
    const clean = runCli(lint, ['--rules-dir', 'lint-rules', '--no-baseline']);
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stdout).toContain('checked 0 rules in 1 YAML file under lint-rules');
  }, 120_000);

  it('rejects bad arguments, an invalid baseline and a missing folder', () => {
    const help = runCli(lint, ['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage: npm run rules:lint');
    const unknown = runCli(lint, ['--nope']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('Usage: npm run rules:lint');
    const both = runCli(lint, ['--baseline', 'known.json', '--no-baseline']);
    expect(both.status).toBe(2);
    expect(both.stderr).toContain('--baseline and --no-baseline cannot be used together');
    writeFileSync(join(scratch, 'bad-baseline.json'), '{"entries": [{"file": "a.yml"}]}');
    const bad = runCli(lint, ['--baseline', 'bad-baseline.json']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('rules:lint failed: baseline: entries.0.check');
    const missing = runCli(lint, ['--rules-dir', 'no-such-folder']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('rules:lint failed: ENOENT');
  }, 120_000);
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

  it('names options in kebab case in validation errors', () => {
    expect(() => parseReportArgs(['--rules-dir', ''])).toThrow('--rules-dir:');
    expect(() => parseLintArgs(['--rules-dir', ''])).toThrow('--rules-dir:');
  });

  it('uses the lint baseline next to the rules folder unless told otherwise', () => {
    const rules = join(repoRoot, 'rules');
    expect(parseLintArgs([])).toEqual({
      rulesDir: rules,
      baseline: join(rules, 'lint-baseline.json'),
    });
    expect(parseLintArgs(['--no-baseline'])).toEqual({ rulesDir: rules, baseline: null });
    const other = mkdtempSync(join(scratch, 'no-baseline-'));
    expect(parseLintArgs(['--rules-dir', other])).toEqual({ rulesDir: other, baseline: null });
    expect(parseLintArgs(['--rules-dir', other, '--baseline', join(other, 'b.json')])).toEqual({
      rulesDir: other,
      baseline: join(other, 'b.json'),
    });
    expect(() => parseLintArgs(['--baseline', 'b.json', '--no-baseline'])).toThrow(
      'cannot be used together',
    );
    expect(parseLintArgs(['-h'])).toBe('help');
  });
});
