/**
 * The server entry point refuses to start in production with missing or development
 * credentials. The process exits before it opens a database connection or a port.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { DEV_ADMIN_PASSWORD } from '../../src/config.js';

const serverRoot = fileURLToPath(new URL('../..', import.meta.url));

const PRODUCTION = {
  NODE_ENV: 'production',
  INGEST_TOKEN: 'i'.repeat(40),
  DATABASE_URL: 'postgres://centinela:prod-password@127.0.0.1:1/centinela',
  SESSION_SECRET: 's'.repeat(40),
  ADMIN_USERNAME: 'soc-admin',
  PORT: '1',
};

/** Variables set (even empty) in the environment win over a developer's `.env` file. */
const UNSET = { ADMIN_USERNAME: '', ADMIN_PASSWORD_HASH: '', SESSION_SECRET: '', INGEST_TOKEN: '' };

function start(env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ['--conditions=@centinela/source', '--import', 'tsx', 'src/index.ts'],
    {
      cwd: serverRoot,
      encoding: 'utf8',
      env: { ...process.env, ...UNSET, ...env },
      timeout: 20_000,
    },
  );
}

describe('production start-up', () => {
  it('exits with the missing variables named, and no secret values', () => {
    const result = start({ ...PRODUCTION, ADMIN_USERNAME: '', SESSION_SECRET: '' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ADMIN_USERNAME: is required in production');
    expect(result.stderr).toContain('ADMIN_PASSWORD_HASH: is required in production');
    expect(result.stderr).toContain('SESSION_SECRET: is required in production');
    expect(result.stderr).not.toContain('prod-password');
  });

  it('exits when the hash is the development password with a new salt', async () => {
    const resalted = await argon2.hash(DEV_ADMIN_PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    const result = start({ ...PRODUCTION, ADMIN_PASSWORD_HASH: resalted });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ADMIN_PASSWORD_HASH: must not hash the development password');
  });
});
