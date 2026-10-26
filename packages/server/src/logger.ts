import { pino, type Logger } from 'pino';
import type { Config } from './config.js';

export type { Logger };

/** Headers that carry credentials are never written to the logs. */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
];

export function createLogger(config: Pick<Config, 'logLevel'>): Logger {
  return pino({
    level: config.logLevel,
    base: { service: 'centinela-server' },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  });
}
