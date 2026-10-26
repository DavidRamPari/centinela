import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// CLI entry points that later sessions implement. Delete a row when its session replaces the stub.
const stubs = [
  { script: 'src/detection/cli/report.ts', session: 'S2', command: 'npm run rules:report' },
  { script: 'src/detection/cli/bench.ts', session: 'S2', command: 'npm run bench' },
];

const serverRoot = fileURLToPath(new URL('..', import.meta.url));

describe('CLI stubs', () => {
  it.each(stubs)('$command prints which session implements it', ({ script, session, command }) => {
    const result = spawnSync(
      process.execPath,
      ['--conditions=@centinela/source', '--import', 'tsx', script],
      {
        cwd: serverRoot,
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(command);
    expect(result.stdout).toContain(`session ${session}`);
  });
});
