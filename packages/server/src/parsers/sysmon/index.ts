/**
 * `sysmon` parser (ARCHITECTURE §4.4): one Windows Sysmon event per line, as JSON, in the
 * nested `Event.System` / `Event.EventData` shape or the flat shape (see `schema.ts`).
 *
 * | Event ID | action               | category  | Sigma logsource                          |
 * | -------- | -------------------- | --------- | ---------------------------------------- |
 * | 1        | `process_start`      | `process` | `product: windows, category: process_creation`   |
 * | 3        | `network_connection` | `network` | `product: windows, category: network_connection` |
 * | 11       | `file_create`        | `file`    | `product: windows, category: file_event`         |
 * | other    | `other`              | `other`   | `product: windows`                       |
 *
 * Event data keys become fields unchanged; `EventID` and `Computer` are added from the
 * envelope. An event whose provider or channel names something other than Sysmon keeps its
 * data but becomes `other`, so another provider's event 1 is never read as a process start.
 */
import type { EventCategory, FieldValue, LogSource, Outcome } from '@centinela/shared';
import type { IngestContext, Parser, ParseResult } from '../../pipeline/types.js';
import {
  buildEvent,
  MAX_LINE_LENGTH,
  normalizeIp,
  parsePort,
  reject,
  sanitizeLine,
} from '../common.js';
import { parseRfc3339Time } from '../time.js';
import { baseName, booleanOf, dataFields, integerOf, splitAccount, textOf } from './fields.js';
import { dataSchema, flatEnvelopeSchema, nestedEventSchema } from './schema.js';

interface SysmonKind {
  action: string;
  category: EventCategory;
  outcome: Outcome;
  /** Sigma `category` of the event's logsource. */
  logsource?: string;
}

const KINDS: Readonly<Record<number, SysmonKind>> = {
  1: {
    action: 'process_start',
    category: 'process',
    outcome: 'success',
    logsource: 'process_creation',
  },
  3: {
    action: 'network_connection',
    category: 'network',
    outcome: 'success',
    logsource: 'network_connection',
  },
  11: { action: 'file_create', category: 'file', outcome: 'success', logsource: 'file_event' },
};
const OTHER: SysmonKind = { action: 'other', category: 'other', outcome: 'unknown' };

/** Sigma logsources of a Sysmon event with this action (ARCHITECTURE §4). */
export function sysmonLogsources(action: string): LogSource[] {
  const kind = Object.values(KINDS).find((k) => k.action === action);
  return [
    kind?.logsource === undefined
      ? { product: 'windows' }
      : { product: 'windows', category: kind.logsource },
  ];
}

/** The parts of a line both shapes reduce to. */
interface SysmonRecord {
  eventId: number;
  computer: string | undefined;
  /** Timestamps in order of preference: event data `UtcTime`, then the envelope's. */
  times: string[];
  /** Provider or channel name, when the line carries one. */
  provider: string | undefined;
  fields: Record<string, FieldValue>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty envelope string, made storable (JSON escapes can produce NUL characters). */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? sanitizeLine(value.trim()) : undefined;
}

function readNested(value: Record<string, unknown>): SysmonRecord | string {
  const parsed = nestedEventSchema.safeParse(value);
  if (!parsed.success) return 'not a Sysmon event (invalid Event.System or Event.EventData)';
  const { System, EventData } = parsed.data.Event;
  const fields = dataFields(EventData ?? {});
  const times = [textOf(fields, 'UtcTime'), System.TimeCreated?.['#attributes']?.SystemTime];
  return {
    eventId: System.EventID,
    computer: stringOf(System.Computer),
    times: times.filter((t): t is string => t !== undefined),
    provider: stringOf(System.Provider?.['#attributes']?.Name),
    fields,
  };
}

function readFlat(value: Record<string, unknown>): SysmonRecord | string {
  const envelope = flatEnvelopeSchema.safeParse(value);
  if (!envelope.success) return 'not a Sysmon event (EventID missing or invalid)';
  const fields = dataFields(dataSchema.parse(value));
  const { EventID, Computer, TimeCreated, ProviderName, Channel } = envelope.data;
  const times = [textOf(fields, 'UtcTime'), TimeCreated];
  return {
    eventId: EventID,
    computer: stringOf(Computer),
    times: times.filter((t): t is string => t !== undefined),
    provider: stringOf(ProviderName) ?? stringOf(Channel),
    fields,
  };
}

/**
 * Sysmon's `UtcTime` (`2026-10-21 14:03:12.123`, always UTC) or an ISO 8601 time such as
 * `SystemTime` (`2026-10-21T14:03:12.1234567Z`). Times without an offset are UTC.
 */
export function parseSysmonTime(text: string): number | undefined {
  return parseRfc3339Time(text.trim().replace(' ', 'T'), 'UTC');
}

function isSysmonProvider(provider: string | undefined): boolean {
  return provider === undefined || provider.toLowerCase().includes('sysmon');
}

/** ECS-style keys for the process, network and file parts of the event. */
function ecsFields(
  action: string,
  fields: Readonly<Record<string, FieldValue>>,
): Record<string, FieldValue | undefined> {
  const image = textOf(fields, 'Image');
  const parentImage = textOf(fields, 'ParentImage');
  const target = textOf(fields, 'TargetFilename');
  const ecs: Record<string, FieldValue | undefined> = {
    'process.executable': image,
    'process.name': image === undefined ? undefined : baseName(image),
    'process.pid': integerOf(fields, 'ProcessId'),
  };
  if (action === 'process_start') {
    Object.assign(ecs, {
      'process.command_line': textOf(fields, 'CommandLine'),
      'process.parent.executable': parentImage,
      'process.parent.name': parentImage === undefined ? undefined : baseName(parentImage),
      'process.parent.pid': integerOf(fields, 'ParentProcessId'),
      'process.parent.command_line': textOf(fields, 'ParentCommandLine'),
    });
  } else if (action === 'network_connection') {
    const destination = textOf(fields, 'DestinationIp');
    const initiated = booleanOf(fields, 'Initiated');
    Object.assign(ecs, {
      'destination.ip': destination === undefined ? undefined : normalizeIp(destination),
      'destination.port': parsePort(textOf(fields, 'DestinationPort')),
      'destination.domain': textOf(fields, 'DestinationHostname'),
      'network.transport': textOf(fields, 'Protocol')?.toLowerCase(),
      'network.direction': initiated === undefined ? undefined : initiated ? 'egress' : 'ingress',
    });
  } else if (action === 'file_create') {
    Object.assign(ecs, {
      'file.path': target,
      'file.name': target === undefined ? undefined : baseName(target),
    });
  }
  return ecs;
}

export function parseSysmon(raw: string, ctx: IngestContext): ParseResult {
  if (raw.length > MAX_LINE_LENGTH) return reject('line too long');
  const line = sanitizeLine(raw);
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return reject('invalid JSON');
  }
  if (!isRecord(value)) return reject('not a JSON object');

  const record = isRecord(value.Event) ? readNested(value) : readFlat(value);
  if (typeof record === 'string') return reject(record);

  if (record.times.length === 0) return reject('missing timestamp');
  const ts = record.times.map(parseSysmonTime).find((t) => t !== undefined);
  if (ts === undefined) return reject('invalid timestamp');

  const kind = (isSysmonProvider(record.provider) && KINDS[record.eventId]) || OTHER;
  const fields: Record<string, FieldValue | undefined> = {
    ...ecsFields(kind.action, record.fields),
    ...record.fields,
  };
  fields.EventID ??= record.eventId;
  if (record.computer !== undefined) fields.Computer ??= record.computer;

  const account = textOf(record.fields, 'User');
  const user = account === undefined ? undefined : splitAccount(account);
  if (user?.domain !== undefined) fields['user.domain'] = user.domain;

  const sourceIp = textOf(record.fields, 'SourceIp');
  const network = kind.action === 'network_connection';
  return buildEvent({
    ts,
    source: 'sysmon',
    host: record.computer ?? ctx.host,
    logsources: sysmonLogsources(kind.action),
    category: kind.category,
    action: kind.action,
    outcome: kind.outcome,
    user: user?.name,
    srcIp: network && sourceIp !== undefined ? normalizeIp(sourceIp) : undefined,
    srcPort: network ? parsePort(textOf(record.fields, 'SourcePort')) : undefined,
    message: line,
    fields,
  });
}

export const sysmonParser: Parser = { source: 'sysmon', parse: parseSysmon };
