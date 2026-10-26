/**
 * Server configuration from environment variables (ARCHITECTURE §15), validated with zod.
 * Development defaults let `npm run dev` work out of the box; production refuses to start
 * with the development secrets.
 */
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { repoRoot } from './paths.js';

export const DEV_DATABASE_URL = 'postgres://centinela:centinela@localhost:5432/centinela';
export const DEV_INGEST_TOKEN = 'dev-ingest-token-change-me';
export const DEV_DATABASE_PASSWORD = 'centinela';
export const MIN_PRODUCTION_TOKEN_LENGTH = 32;

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
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
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
}

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
  };
}
