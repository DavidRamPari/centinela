import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEV_DATABASE_URL, DEV_INGEST_TOKEN, loadConfig } from '../src/config.js';
import { repoRoot } from '../src/paths.js';

const strongToken = 'a'.repeat(64);
const productionDb = 'postgres://centinela:s3cret-pw@db.internal:5432/centinela';

describe('loadConfig', () => {
  it('uses development defaults for an empty environment', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      nodeEnv: 'development',
      isProduction: false,
      port: 3000,
      databaseUrl: DEV_DATABASE_URL,
      logLevel: 'info',
      ingestToken: DEV_INGEST_TOKEN,
      trustProxy: false,
    });
    expect(config.rulesDir).toBe(join(repoRoot, 'rules'));
    expect(config.contentDir).toBe(join(repoRoot, 'content'));
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ PORT: '', LOG_LEVEL: ' ' })).toMatchObject({
      port: 3000,
      logLevel: 'info',
    });
  });

  it('parses explicit values', () => {
    const config = loadConfig({
      PORT: '8080',
      LOG_LEVEL: 'debug',
      RULES_DIR: '/srv/rules',
      TRUST_PROXY: '1',
    });
    expect(config).toMatchObject({
      port: 8080,
      logLevel: 'debug',
      rulesDir: '/srv/rules',
      trustProxy: 1,
    });
    expect(isAbsolute(config.contentDir)).toBe(true);
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: 'loopback' }).trustProxy).toBe('loopback');
  });

  it.each([
    ['a non-numeric port', { PORT: 'http' }],
    ['an out-of-range port', { PORT: '70000' }],
    ['a non-PostgreSQL URL', { DATABASE_URL: 'mysql://user@localhost/db' }],
    ['an unknown log level', { LOG_LEVEL: 'verbose' }],
    ['an unknown NODE_ENV', { NODE_ENV: 'staging' }],
  ])('rejects %s', (_label, env) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it('accepts production with strong secrets', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      INGEST_TOKEN: strongToken,
      DATABASE_URL: productionDb,
    });
    expect(config.isProduction).toBe(true);
  });

  it.each([
    [
      'the development ingest token',
      { INGEST_TOKEN: DEV_INGEST_TOKEN, DATABASE_URL: productionDb },
      'INGEST_TOKEN',
    ],
    [
      'a short ingest token',
      { INGEST_TOKEN: 'short-token', DATABASE_URL: productionDb },
      'INGEST_TOKEN',
    ],
    ['the development database password', { INGEST_TOKEN: strongToken }, 'DATABASE_URL'],
  ])('refuses to start in production with %s', (_label, env, variable) => {
    expect(() => loadConfig({ NODE_ENV: 'production', ...env })).toThrow(variable);
  });

  it('never includes secret values in error messages', () => {
    const secret = 'short-but-secret';
    try {
      loadConfig({ NODE_ENV: 'production', INGEST_TOKEN: secret, DATABASE_URL: productionDb });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(String(err)).not.toContain(secret);
    }
  });
});
