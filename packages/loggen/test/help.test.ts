import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELP_TEXT } from '../src/help.js';

describe('loggen CLI (stub)', () => {
  it('documents every planned flag', () => {
    for (const flag of ['--seed', '--days', '--start', '--out', '--small', '--help']) {
      expect(HELP_TEXT).toContain(flag);
    }
  });

  it('prints the help text and exits 0', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--help'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(HELP_TEXT);
  });
});
