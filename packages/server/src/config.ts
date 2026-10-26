/**
 * Server configuration from environment variables (ARCHITECTURE §15), validated with zod.
 * Development defaults let `npm run dev` work out of the box; production refuses to start
 * with the development secrets or without the admin credentials.
 */
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { MIN_PRODUCTION_ARGON2, parseArgon2idHash } from './auth/phc.js';
import { repoRoot } from './paths.js';

export const DEV_DATABASE_URL = 'postgres://centinela:centinela@localhost:5432/centinela';
export const DEV_INGEST_TOKEN = 'dev-ingest-token-change-me';
export const DEV_DATABASE_PASSWORD = 'centinela';
export const MIN_PRODUCTION_TOKEN_LENGTH = 32;

/** Development sign-in (`admin` / `centinela-dev`); production refuses both the hash and the password. */
export const DEV_ADMIN_USERNAME = 'admin';
export const DEV_ADMIN_PASSWORD = 'centinela-dev';
export const DEV_ADMIN_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$YhaR1/jbzCvM/0fnfvl7XQ$UCStiHN2Xq4nZZzKQc5nvLrr9HxSkIehlpNuQDkifzk';
export const DEV_SESSION_SECRET = 'dev-session-secret-change-me';
export const MIN_PRODUCTION_SECRET_LENGTH = 32;

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type TrustProxy = boolean | number | string;

/** Express `trust proxy` value: `true`/`false`, a hop count, or an address/subnet list. */
function parseTrustProxy(raw: string): TrustProxy {
  const value = raw.trim();
  if (value === '' || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

/** Empty strings count as unset, so `FOO=` in a .env file falls back to the default. */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));

/** A whole number in `[min, max]` with a default. */
const intVar = (min: number, max: number, fallback: number) =>
  optionalString.pipe(
    z.coerce.number<string | undefined>().int().min(min).max(max).default(fallback),
  );

const ADMIN_USERNAME_PATTERN = /^[\x21-\x7e]{1,128}$/;

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: optionalString.pipe(
      z.coerce.number<string | undefined>().int().min(1).max(65535).default(3000),
    ),
    DATABASE_URL: optionalString.pipe(
      z.url({ protocol: /^postgres(?:ql)?$/ }).default(DEV_DATABASE_URL),
    ),
    LOG_LEVEL: optionalString.pipe(z.enum(LOG_LEVELS).default('info')),
    INGEST_TOKEN: optionalString.pipe(z.string().default(DEV_INGEST_TOKEN)),
    RULES_DIR: optionalString.pipe(z.string().default('./rules')),
    CONTENT_DIR: optionalString.pipe(z.string().default('./content')),
    TRUST_PROXY: optionalString.pipe(z.string().default('false')),
    ADMIN_USERNAME: optionalString.pipe(
      z
        .string()
        .regex(ADMIN_USERNAME_PATTERN, 'must be 1-128 printable characters without spaces')
        .optional(),
    ),
    ADMIN_PASSWORD_HASH: optionalString.pipe(
      z
        .string()
        .refine((hash) => parseArgon2idHash(hash) !== undefined, {
          message: 'must be an argon2id hash (run `npm run hash-password`)',
        })
        .optional(),
    ),
    SESSION_SECRET: optionalString,
    RATE_LIMIT_INGEST_PER_MINUTE: intVar(1, 100_000, 120),
    RATE_LIMIT_UPLOAD_PER_MINUTE: intVar(1, 10_000, 30),
    RATE_LIMIT_AUTH_PER_MINUTE: intVar(1, 10_000, 30),
    LOGIN_MAX_FAILURES: intVar(1, 100, 5),
    LOGIN_LOCKOUT_MINUTES: intVar(1, 1_440, 15),
    SESSION_IDLE_MINUTES: intVar(1, 10_080, 120),
    SESSION_MAX_HOURS: intVar(1, 168, 12),
  })
  .superRefine((env, ctx) => {
    if (env.SESSION_IDLE_MINUTES > env.SESSION_MAX_HOURS * 60) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_IDLE_MINUTES'],
        message: 'must not be longer than SESSION_MAX_HOURS',
      });
    }
    if (env.NODE_ENV !== 'production') return;
    if (env.ADMIN_USERNAME === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_USERNAME'],
        message: 'is required in production',
      });
    }
    if (env.ADMIN_PASSWORD_HASH === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_PASSWORD_HASH'],
        message: 'is required in production (run `npm run hash-password`)',
      });
    } else if (env.ADMIN_PASSWORD_HASH === DEV_ADMIN_PASSWORD_HASH) {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_PASSWORD_HASH'],
        message: 'must not be the development password hash in production',
      });
    } else {
      const params = parseArgon2idHash(env.ADMIN_PASSWORD_HASH);
      if (params && (params.m < MIN_PRODUCTION_ARGON2.m || params.t < MIN_PRODUCTION_ARGON2.t)) {
        ctx.addIssue({
          code: 'custom',
          path: ['ADMIN_PASSWORD_HASH'],
          message: `must use at least m=${MIN_PRODUCTION_ARGON2.m} and t=${MIN_PRODUCTION_ARGON2.t} in production`,
        });
      }
    }
    if (env.SESSION_SECRET === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_SECRET'],
        message: 'is required in production',
      });
    } else if (env.SESSION_SECRET === DEV_SESSION_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_SECRET'],
        message: 'must be changed from the development default in production',
      });
    } else if (env.SESSION_SECRET.length < MIN_PRODUCTION_SECRET_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_SECRET'],
        message: `must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`,
      });
    }
    if (env.INGEST_TOKEN === DEV_INGEST_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['INGEST_TOKEN'],
        message: 'must be changed from the development default in production',
      });
    } else if (env.INGEST_TOKEN.length < MIN_PRODUCTION_TOKEN_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        path: ['INGEST_TOKEN'],
        message: `must be at least ${MIN_PRODUCTION_TOKEN_LENGTH} characters in production`,
      });
    }
    if (decodeURIComponent(new URL(env.DATABASE_URL).password) === DEV_DATABASE_PASSWORD) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'must not use the development database password in production',
      });
    }
  });

export interface RateLimitOptions {
  windowMs: number;
  /** Requests per client IP per window. */
  limit: number;
}

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  databaseUrl: string;
  logLevel: (typeof LOG_LEVELS)[number];
  ingestToken: string;
  /** Absolute path; relative values are resolved against the repository root. */
  rulesDir: string;
  /** Absolute path; relative values are resolved against the repository root. */
  contentDir: string;
  trustProxy: TrustProxy;
  admin: {
    username: string;
    /** argon2id PHC string. */
    passwordHash: string;
    /** True when the development password hash is in use (never in production). */
    usingDevPassword: boolean;
  };
  /** Keys the session id hashes and CSRF tokens; changing it signs everyone out. */
  sessionSecret: string;
  /** Per client IP, one-minute windows. */
  rateLimits: { ingest: RateLimitOptions; upload: RateLimitOptions; auth: RateLimitOptions };
  /** Temporary lockout: `maxFailures` failed sign-ins from one client lock it for `lockoutMs`. */
  login: { maxFailures: number; lockoutMs: number };
  /** Sessions end after `idleMs` without requests, and at the latest after `maxAgeMs`. */
  session: { idleMs: number; maxAgeMs: number };
}

const MINUTE_MS = 60_000;
const perMinute = (limit: number): RateLimitOptions => ({ windowMs: MINUTE_MS, limit });

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

function resolveDir(dir: string): string {
  return isAbsolute(dir) ? dir : resolve(repoRoot, dir);
}

/** Parse configuration from an environment object (defaults to `process.env`). */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    // Messages name the variable and the rule, never the value (it may be a secret).
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(env)'}: ${issue.message}`),
    );
  }
  const parsed = result.data;
  return {
    nodeEnv: parsed.NODE_ENV,
    isProduction: parsed.NODE_ENV === 'production',
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    logLevel: parsed.LOG_LEVEL,
    ingestToken: parsed.INGEST_TOKEN,
    rulesDir: resolveDir(parsed.RULES_DIR),
    contentDir: resolveDir(parsed.CONTENT_DIR),
    trustProxy: parseTrustProxy(parsed.TRUST_PROXY),
    admin: {
      username: parsed.ADMIN_USERNAME ?? DEV_ADMIN_USERNAME,
      passwordHash: parsed.ADMIN_PASSWORD_HASH ?? DEV_ADMIN_PASSWORD_HASH,
      usingDevPassword:
        (parsed.ADMIN_PASSWORD_HASH ?? DEV_ADMIN_PASSWORD_HASH) === DEV_ADMIN_PASSWORD_HASH,
    },
    sessionSecret: parsed.SESSION_SECRET ?? DEV_SESSION_SECRET,
    rateLimits: {
      ingest: perMinute(parsed.RATE_LIMIT_INGEST_PER_MINUTE),
      upload: perMinute(parsed.RATE_LIMIT_UPLOAD_PER_MINUTE),
      auth: perMinute(parsed.RATE_LIMIT_AUTH_PER_MINUTE),
    },
    login: {
      maxFailures: parsed.LOGIN_MAX_FAILURES,
      lockoutMs: parsed.LOGIN_LOCKOUT_MINUTES * MINUTE_MS,
    },
    session: {
      idleMs: parsed.SESSION_IDLE_MINUTES * MINUTE_MS,
      maxAgeMs: parsed.SESSION_MAX_HOURS * 60 * MINUTE_MS,
    },
  };
}
