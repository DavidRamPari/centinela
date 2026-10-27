/**
 * Sysmon event data → the field view rules match against (ARCHITECTURE §3.1, §4.4).
 * Event data keys become Sigma fields unchanged (`Image`, `CommandLine`, `ParentImage`,
 * `OriginalFileName`, ...): field names are matched case-sensitively, so they are never
 * renamed or re-cased. ECS-style keys (`process.*`, `destination.*`, `file.*`) are added
 * next to them for Centinela's own rules and the dashboard.
 */
import type { FieldValue } from '@centinela/shared';
import { sanitizeLine } from '../common.js';
import type { EventDataRecord } from './schema.js';

/**
 * Event data keys kept as fields: a letter followed by letters, digits or underscores, as
 * every Windows event field name is. Anything else (dotted ECS-style keys from shippers,
 * `@timestamp`, `__proto__`) is left out of the field view, so data can never overwrite
 * the ECS-style keys the parser sets. The raw line keeps everything.
 */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

/** At most this many event data fields per event (Sysmon events have about 25). */
export const MAX_DATA_FIELDS = 256;

/**
 * A JSON value as a field value: scalars as they are, objects and arrays as JSON text.
 * A value nested too deeply to serialize again (thousands of levels, only ever hostile)
 * becomes an empty string; the raw line still holds it.
 */
function toFieldValue(value: unknown): FieldValue {
  if (typeof value === 'string') return sanitizeLine(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  try {
    return sanitizeLine(JSON.stringify(value) ?? '');
  } catch {
    return '';
  }
}

export function dataFields(data: EventDataRecord): Record<string, FieldValue> {
  const fields: Record<string, FieldValue> = {};
  let count = 0;
  for (const [key, value] of Object.entries(data)) {
    if (count >= MAX_DATA_FIELDS) break;
    if (!FIELD_NAME.test(key) || value === undefined) continue;
    fields[key] = toFieldValue(value);
    count += 1;
  }
  return fields;
}

/** A field's text, or undefined when it is absent, null or empty. */
export function textOf(
  fields: Readonly<Record<string, FieldValue>>,
  key: string,
): string | undefined {
  const value = fields[key];
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value.trim() : String(value);
  return text === '' || text === '-' ? undefined : text;
}

/** Last component of a Windows (or POSIX) path: `C:\Windows\System32\cmd.exe` → `cmd.exe`. */
export function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return cut === -1 ? path : path.slice(cut + 1);
}

/** `DOMAIN\name` → `{ name, domain }`; a name without a domain has none. */
export function splitAccount(account: string): { name: string; domain?: string } {
  const cut = account.lastIndexOf('\\');
  if (cut === -1) return { name: account };
  const name = account.slice(cut + 1);
  const domain = account.slice(0, cut);
  return domain === '' ? { name } : { name, domain };
}

/** Non-negative integer from a number or digit string (process ids, ports). */
export function integerOf(
  fields: Readonly<Record<string, FieldValue>>,
  key: string,
): number | undefined {
  const value = fields[key];
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/** Sysmon writes booleans as `true`/`false` strings; JSON exports sometimes as booleans. */
export function booleanOf(
  fields: Readonly<Record<string, FieldValue>>,
  key: string,
): boolean | undefined {
  const value = fields[key];
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  return text === 'true' ? true : text === 'false' ? false : undefined;
}
