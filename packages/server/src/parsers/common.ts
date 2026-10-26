/**
 * Helpers shared by the parsers: input sanitizing, length caps, IP normalization and the
 * construction of a `NormalizedEvent` with its ECS-style base fields (ARCHITECTURE §3.1).
 */
import {
  MAX_MESSAGE_LENGTH,
  type EventCategory,
  type FieldValue,
  type LogSource,
  type Outcome,
  type SourceType,
} from '@centinela/shared';
import ipaddr from 'ipaddr.js';
import type { ParseResult } from '../pipeline/types.js';

/**
 * Longest line a parser looks at. Longer input is cut before parsing, which bounds the
 * work per line; `message` and every string field are cut further, to 8,192 characters.
 */
export const MAX_LINE_LENGTH = 65_536;

/** Longest string stored in `message` or in any field (ARCHITECTURE §5.6). */
export const MAX_FIELD_LENGTH = MAX_MESSAGE_LENGTH;

/**
 * Make an attacker-controlled line safe to store: cap its length, replace NUL characters
 * (PostgreSQL `text` and `jsonb` reject them) and lone surrogates with U+FFFD.
 */
export function sanitizeLine(line: string): string {
  const capped = line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) : line;
  return toWellFormed(capped.replaceAll('\u0000', '\uFFFD'));
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `String.prototype.toWellFormed` (ES2024; the repository targets ES2023 typings). */
export function toWellFormed(value: string): string {
  return value.replace(LONE_SURROGATE, '\uFFFD');
}

/** Cut a string to `max` characters without leaving half a surrogate pair. */
export function truncate(value: string, max: number = MAX_FIELD_LENGTH): string {
  return value.length > max ? toWellFormed(value.slice(0, max)) : value;
}

/**
 * Normalize an IPv4 or IPv6 address: strip brackets and zone, convert IPv4-mapped IPv6 to
 * IPv4, compress IPv6 (RFC 5952). Returns undefined for anything that is not an address
 * (for example a host name in `rhost=`).
 */
export function normalizeIp(raw: string): string | undefined {
  let text = raw.trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (text === '' || text.length > 64) return undefined;
  if (ipaddr.IPv4.isValidFourPartDecimal(text)) return ipaddr.IPv4.parse(text).toString();
  if (!ipaddr.IPv6.isValid(text)) return undefined;
  const parsed = ipaddr.IPv6.parse(text);
  return parsed.isIPv4MappedAddress()
    ? parsed.toIPv4Address().toString()
    : parsed.toRFC5952String();
}

/** A TCP/UDP port number, or undefined. */
export function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d{1,5}$/.test(raw)) return undefined;
  const port = Number(raw);
  return port <= 65535 ? port : undefined;
}

/** Non-negative integer from a digit string, or undefined. */
export function parseCount(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return undefined;
  return Number(raw);
}

export interface EventDraft {
  ts: number;
  source: SourceType;
  host: string;
  logsources: LogSource[];
  category: EventCategory;
  action: string;
  outcome: Outcome;
  user?: string | undefined;
  srcIp?: string | undefined;
  srcPort?: number | undefined;
  /** The sanitized line; cut to 8,192 characters here. */
  message: string;
  /** Source-specific fields; `undefined` values are dropped, strings are cut. */
  fields: Record<string, FieldValue | undefined>;
}

/**
 * Build a successful parse result. Adds the ECS-style base fields (`event.*`, `host.name`,
 * `user.name`, `source.ip`, `source.port`) so rules can rely on them for every source.
 */
export function buildEvent(draft: EventDraft): ParseResult {
  const host = truncate(draft.host, 255);
  const user = draft.user === undefined || draft.user === '' ? undefined : truncate(draft.user);
  const fields: Record<string, FieldValue> = {
    'event.action': draft.action,
    'event.outcome': draft.outcome,
    'event.category': draft.category,
    'host.name': host,
  };
  if (user !== undefined) fields['user.name'] = user;
  if (draft.srcIp !== undefined) fields['source.ip'] = draft.srcIp;
  if (draft.srcPort !== undefined) fields['source.port'] = draft.srcPort;
  for (const [key, value] of Object.entries(draft.fields)) {
    if (value === undefined) continue;
    fields[key] = typeof value === 'string' ? truncate(value) : value;
  }
  return {
    ok: true,
    event: {
      ts: new Date(draft.ts).toISOString(),
      source: draft.source,
      host,
      logsources: draft.logsources,
      category: draft.category,
      action: draft.action,
      outcome: draft.outcome,
      ...(user === undefined ? {} : { user }),
      ...(draft.srcIp === undefined ? {} : { srcIp: draft.srcIp }),
      ...(draft.srcPort === undefined ? {} : { srcPort: draft.srcPort }),
      message: truncate(draft.message),
      fields,
    },
  };
}

export function reject(reason: string): ParseResult {
  return { ok: false, reason };
}
