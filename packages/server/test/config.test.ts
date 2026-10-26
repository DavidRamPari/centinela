import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEV_ADMIN_PASSWORD_HASH,
  DEV_ADMIN_USERNAME,
  DEV_DATABASE_URL,
  DEV_INGEST_TOKEN,
  DEV_SESSION_SECRET,
  loadConfig,
} from '../src/config.js';
import { repoRoot } from '../src/paths.js';

const strongToken = 'a'.repeat(64);
const productionDb = 'postgres://centinela:s3cret-pw@db.internal:5432/centinela';
/** argon2id with the production minimum cost (19 MiB, 2 iterations). */
const strongHash =
  '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g';
const productionAuth = {
  ADMIN_USERNAME: 'soc-admin',
  ADMIN_PASSWORD_HASH: strongHash,
  SESSION_SECRET: 's'.repeat(48),
};

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
      ...productionAuth,
    });
    expect(config.isProduction).toBe(true);
    expect(config.admin).toEqual({
      username: 'soc-admin',
      passwordHash: strongHash,
      usingDevPassword: false,
    });
  });

  it('uses the development sign-in and secret outside production', () => {
    const config = loadConfig({});
    expect(config.admin).toEqual({
      username: DEV_ADMIN_USERNAME,
      passwordHash: DEV_ADMIN_PASSWORD_HASH,
      usingDevPassword: true,
    });
    expect(config.sessionSecret).toBe(DEV_SESSION_SECRET);
  });

  it('reads rate limits, lockout and session lifetimes (S1 constants moved here)', () => {
    expect(loadConfig({})).toMatchObject({
      rateLimits: {
        ingest: { windowMs: 60_000, limit: 120 },
        upload: { windowMs: 60_000, limit: 30 },
        auth: { windowMs: 60_000, limit: 30 },
      },
      login: { maxFailures: 5, lockoutMs: 15 * 60_000 },
      session: { idleMs: 120 * 60_000, maxAgeMs: 12 * 3_600_000 },
    });
    expect(
      loadConfig({
        RATE_LIMIT_INGEST_PER_MINUTE: '600',
        RATE_LIMIT_UPLOAD_PER_MINUTE: '5',
        RATE_LIMIT_AUTH_PER_MINUTE: '10',
        LOGIN_MAX_FAILURES: '3',
        LOGIN_LOCKOUT_MINUTES: '60',
        SESSION_IDLE_MINUTES: '30',
        SESSION_MAX_HOURS: '8',
      }),
    ).toMatchObject({
      rateLimits: { ingest: { limit: 600 }, upload: { limit: 5 }, auth: { limit: 10 } },
      login: { maxFailures: 3, lockoutMs: 60 * 60_000 },
      session: { idleMs: 30 * 60_000, maxAgeMs: 8 * 3_600_000 },
    });
  });

  it.each([
    ['a zero rate limit', { RATE_LIMIT_INGEST_PER_MINUTE: '0' }],
    ['a fractional rate limit', { RATE_LIMIT_AUTH_PER_MINUTE: '1.5' }],
    ['a lockout threshold of zero', { LOGIN_MAX_FAILURES: '0' }],
    [
      'an idle timeout longer than the session',
      { SESSION_IDLE_MINUTES: '600', SESSION_MAX_HOURS: '2' },
    ],
    ['sessions longer than a week', { SESSION_MAX_HOURS: '169' }],
    [
      'a password hash that is not argon2id',
      { ADMIN_PASSWORD_HASH: '$2b$12$abcdefghijklmnopqrstuv' },
    ],
    ['a user name with spaces', { ADMIN_USERNAME: 'soc admin' }],
  ])('rejects %s', (_label, env) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
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
    ['the development database password', { DATABASE_URL: DEV_DATABASE_URL }, 'DATABASE_URL'],
    ['no admin user name', { ADMIN_USERNAME: '' }, 'ADMIN_USERNAME'],
    ['no admin password hash', { ADMIN_PASSWORD_HASH: '' }, 'ADMIN_PASSWORD_HASH'],
    [
      'the development password hash',
      { ADMIN_PASSWORD_HASH: DEV_ADMIN_PASSWORD_HASH },
      'ADMIN_PASSWORD_HASH',
    ],
    [
      'a cheap password hash',
      { ADMIN_PASSWORD_HASH: strongHash.replace('m=19456', 'm=1024') },
      'ADMIN_PASSWORD_HASH',
    ],
    ['no session secret', { SESSION_SECRET: '' }, 'SESSION_SECRET'],
    ['the development session secret', { SESSION_SECRET: DEV_SESSION_SECRET }, 'SESSION_SECRET'],
    ['a short session secret', { SESSION_SECRET: 'x'.repeat(31) }, 'SESSION_SECRET'],
  ])('refuses to start in production with %s', (_label, env, variable) => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        INGEST_TOKEN: strongToken,
        DATABASE_URL: productionDb,
        ...productionAuth,
        ...env,
      }),
    ).toThrow(variable);
  });

  it('accepts a hash with its parameters in any order', () => {
    const reordered = strongHash.replace('m=19456,t=2,p=1', 'p=1,t=2,m=19456');
    expect(
      loadConfig({
        NODE_ENV: 'production',
        INGEST_TOKEN: strongToken,
        DATABASE_URL: productionDb,
        ...productionAuth,
        ADMIN_PASSWORD_HASH: reordered,
      }).admin.passwordHash,
    ).toBe(reordered);
  });

  it('never includes secret values in error messages', () => {
    const secret = 'short-but-secret';
    try {
      loadConfig({
        NODE_ENV: 'production',
        INGEST_TOKEN: secret,
        DATABASE_URL: productionDb,
        ...productionAuth,
        SESSION_SECRET: `${secret}-session`,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect(String(err)).not.toContain(secret);
      expect(String(err)).toContain('SESSION_SECRET');
    }
  });
});
