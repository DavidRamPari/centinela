/**
 * `linux_auth` parser (ARCHITECTURE §4.1): syslog lines from /var/log/auth.log or
 * /var/log/secure, with RFC 3164 (`Oct 25 14:03:12 host prog[pid]: msg`) or RFC 3339
 * (`2026-10-25T14:03:12.123456-05:00 host prog[pid]: msg`) timestamps. Lines without a
 * recognizable timestamp and host are rejected; every other line becomes an event, with
 * `action: "other"` when the message is not one of the known shapes.
 */
import type { LogSource } from '@centinela/shared';
import type { IngestContext, Parser, ParseResult } from '../pipeline/types.js';
import { buildEvent, reject, sanitizeLine } from './common.js';
import { classifyAuthMessage, SSHD_PROGRAMS } from './linux-auth-messages.js';
import { parseRfc3164Time, parseRfc3339Time } from './time.js';

const RFC3164_HEADER = /^([A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2}) (\S+) (.*)$/;
const RFC3339_HEADER =
  /^(\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:[Zz]|[+-]\d{2}:\d{2})?) (\S+) (.*)$/;
/** `prog[pid]: message` or `prog: message`. */
const TAG = /^([^\s[\]:]{1,64})(?:\[(\d{1,10})\])?: ?(.*)$/;

const AUTH: LogSource = { product: 'linux', service: 'auth' };
const SSHD: LogSource = { product: 'linux', service: 'sshd' };
const SUDO: LogSource = { product: 'linux', service: 'sudo' };

/**
 * Sigma logsources of a `linux_auth` event, primary first (ARCHITECTURE §4). Exported so
 * code that reads events back from the database can rebuild them from `process.name`.
 */
export function linuxAuthLogsources(program: string | undefined): LogSource[] {
  const name = program?.toLowerCase();
  if (name !== undefined && SSHD_PROGRAMS.has(name)) return [SSHD, AUTH];
  if (name === 'sudo') return [SUDO, AUTH];
  return [AUTH];
}

export function parseLinuxAuth(raw: string, ctx: IngestContext): ParseResult {
  const line = sanitizeLine(raw);
  let ts: number | undefined;
  let host: string | undefined;
  let rest: string | undefined;

  const rfc3164 = RFC3164_HEADER.exec(line);
  if (rfc3164) {
    ts = parseRfc3164Time(rfc3164[1] ?? '', ctx.timezone, ctx.receivedAt, ctx.defaultYear);
    [, , host, rest] = rfc3164;
  } else {
    const rfc3339 = RFC3339_HEADER.exec(line);
    if (!rfc3339) return reject('not a syslog line');
    ts = parseRfc3339Time(rfc3339[1] ?? '', ctx.timezone);
    [, , host, rest] = rfc3339;
  }
  if (ts === undefined) return reject('invalid timestamp');

  const tag = TAG.exec(rest ?? '');
  const program = tag?.[1];
  const pid = tag?.[2];
  // sudo indents its lines (`sudo:    deploy : TTY=...`).
  const message = (tag ? (tag[3] ?? '') : (rest ?? '')).trimStart();

  const classified = classifyAuthMessage(program, message) ?? {
    action: 'other',
    outcome: 'unknown' as const,
    category: 'other' as const,
  };

  return buildEvent({
    ts,
    source: 'linux_auth',
    host: host ?? ctx.host,
    logsources: linuxAuthLogsources(program),
    category: classified.category,
    action: classified.action,
    outcome: classified.outcome,
    user: classified.user,
    srcIp: classified.srcIp,
    srcPort: classified.srcPort,
    message: line,
    fields: {
      'process.name': program,
      'process.pid': pid === undefined ? undefined : Number(pid),
      ...classified.fields,
    },
  });
}

export const linuxAuthParser: Parser = {
  source: 'linux_auth',
  parse: parseLinuxAuth,
};
