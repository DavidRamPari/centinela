import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { displayPath, parseValidateArgs, siblingOf } from '../../src/content/cli/args.js';
import { failuresFileSchema } from '../../src/content/failures.js';
import { repoRoot } from '../../src/paths.js';

const serverRoot = fileURLToPath(new URL('../..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'centinela-content-cli-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function runCli(args: string[]) {
  return spawnSync(
    process.execPath,
    ['--conditions=@centinela/source', '--import', 'tsx', 'src/content/cli/validate.ts', ...args],
    { cwd: serverRoot, encoding: 'utf8', env: { ...process.env, INIT_CWD: scratch }, timeout: 120_000 },
  );
}

describe('content:validate options', () => {
  it('defaults to the repository folders and derives the failures file and rejected folder', () => {
    const args = parseValidateArgs([]);
    expect(args).toEqual({
      contentDir: join(repoRoot, 'content', 'sigma'),
      rulesDir: join(repoRoot, 'rules', 'sigma'),
      out: join(repoRoot, 'content', 'sigma-failures.json'),
      report: join(repoRoot, 'docs', 'content-pack-report.md'),
      rejectedDir: join(repoRoot, 'content', 'sigma-rejected'),
      prune: false,
    });
  });

  it('accepts another content folder and a SigmaHQ checkout, with ~ expanded', () => {
    const args = parseValidateArgs(['--rules', '~/sigmahq/rules', '--content', '~/sigma-playbooks/content', '--prune']);
    expect(args).toMatchObject({
      rulesDir: join(homedir(), 'sigmahq', 'rules'),
      contentDir: join(homedir(), 'sigma-playbooks', 'content'),
      out: join(homedir(), 'sigma-playbooks', 'content-failures.json'),
      rejectedDir: join(homedir(), 'sigma-playbooks', 'content-rejected'),
      report: join(homedir(), 'sigma-playbooks', 'content-report.md'),
      prune: true,
    });
  });

  it('gives each SigmaHQ folder other than rules/ its own failures file and report', () => {
    const content = join(homedir(), 'sigma-playbooks', 'content');
    for (const folder of ['rules-emerging-threats', 'rules-threat-hunting', 'rules-compliance']) {
      expect(
        parseValidateArgs(['--rules', `~/sigmahq/${folder}`, '--content', '~/sigma-playbooks/content']),
      ).toMatchObject({
        rulesDir: join(homedir(), 'sigmahq', folder),
        out: `${content}-${folder}-failures.json`,
        report: `${content}-${folder}-report.md`,
        rejectedDir: `${content}-rejected`,
      });
    }
    expect(
      parseValidateArgs(['--rules', '~/sigmahq/rules', '--content', '~/sigma-playbooks/content']),
    ).toMatchObject({ out: `${content}-failures.json`, report: `${content}-report.md` });
  });

  it("defaults Centinela's own content to the full rules root and a report beside it", () => {
    expect(parseValidateArgs(['--content', join(repoRoot, 'content', 'centinela')])).toEqual({
      contentDir: join(repoRoot, 'content', 'centinela'),
      rulesDir: join(repoRoot, 'rules'),
      out: join(repoRoot, 'content', 'centinela-failures.json'),
      report: join(repoRoot, 'content', 'centinela-report.md'),
      rejectedDir: join(repoRoot, 'content', 'centinela-rejected'),
      prune: false,
    });
  });

  it('rejects unknown options, positionals and empty values', () => {
    expect(() => parseValidateArgs(['--nope'])).toThrow();
    expect(() => parseValidateArgs(['extra'])).toThrow();
    expect(() => parseValidateArgs(['--out', ' '])).toThrow(/--out/);
    expect(parseValidateArgs(['-h'])).toBe('help');
  });

  it('shows paths relative to the repository or the home folder', () => {
    expect(siblingOf('/a/content/sigma', '-rejected')).toBe('/a/content/sigma-rejected');
    expect(displayPath(join(repoRoot, 'content', 'sigma'))).toBe('content/sigma');
    expect(displayPath(join(homedir(), 'sigmahq', 'rules'))).toBe('~/sigmahq/rules');
  });
});

describe('npm run content:validate', () => {
  it('validates the vendored content and writes the report and failures file', () => {
    const result = runCli(['--out', 'failures.json', '--report', 'report.md']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/fixtures passing: [\d,]+ \/ [\d,]+ \(\d+\.\d%\)/);
    expect(readFileSync(join(scratch, 'report.md'), 'utf8')).toContain('# Content pack report');
    const failures = failuresFileSchema.parse(JSON.parse(readFileSync(join(scratch, 'failures.json'), 'utf8')) as unknown);
    expect(failures).toMatchObject({ rulesDir: 'rules/sigma', contentDir: 'content/sigma', pruned: false });
    // The committed failures file is what this run produces: it is up to date.
    expect(failures).toEqual(
      failuresFileSchema.parse(JSON.parse(readFileSync(join(repoRoot, 'content', 'sigma-failures.json'), 'utf8')) as unknown),
    );
  }, 120_000);

  it('prunes a copy of the content into the rejected folder', () => {
    const copy = join(scratch, 'pack', 'sigma');
    mkdirSync(join(scratch, 'pack'), { recursive: true });
    cpSync(join(repoRoot, 'content', 'sigma'), copy, { recursive: true });
    const result = runCli(['--content', copy, '--report', 'pruned.md', '--prune']);
    expect(result.status, result.stderr).toBe(0);
    const failures = failuresFileSchema.parse(JSON.parse(readFileSync(join(scratch, 'pack', 'sigma-failures.json'), 'utf8')) as unknown);
    expect(failures.pruned).toBe(true);
    expect(result.stdout).toContain(`Pruned ${failures.failures.length} fixtures`);
    if (failures.failures.length > 0) expect(existsSync(join(scratch, 'pack', 'sigma-rejected'))).toBe(true);
    // A second run finds nothing left to prune.
    const again = runCli(['--content', copy, '--report', 'pruned.md', '--prune']);
    expect(again.stdout).toContain('Pruned 0 fixtures from 0 files');
  }, 120_000);

  it('exits 2 on bad arguments and missing folders', () => {
    const bad = runCli(['--nope']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('Usage: npm run content:validate');
    expect(runCli(['--rules', 'does-not-exist']).status).toBe(2);
  });
});
