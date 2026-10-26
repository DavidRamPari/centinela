/**
 * Line formatting and collection. Andes Retail runs its servers on Lima time (UTC−05:00,
 * no daylight saving), so timestamps carry a −05:00 offset; ground truth stays in UTC.
 *
 * - auth.log: RFC 3339 with microseconds (`2026-10-21T22:12:00.123456-05:00 bastion-01
 *   sshd[1234]: ...`), the default of rsyslog on current Ubuntu and Debian.
 * - access.log: nginx combined format (`[21/Oct/2026:22:12:00 -0500]`), optionally
 *   followed by `$request_time`.
 * - sysmon.jsonl: one Sysmon event per line as JSON, with UTC times as Sysmon writes them
 *   (see `windows.ts`).
 */
import type { GeneratedLine, Host, LogFile } from './model.js';

export const UTC_OFFSET_MINUTES = -300;
const OFFSET_MS = UTC_OFFSET_MINUTES * 60_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function offsetText(separator: string): string {
  const sign = UTC_OFFSET_MINUTES < 0 ? '-' : '+';
  const abs = Math.abs(UTC_OFFSET_MINUTES);
  return `${sign}${pad(Math.floor(abs / 60))}${separator}${pad(abs % 60)}`;
}

/** `2026-10-21T22:12:00.123456-05:00` */
export function formatSyslogTime(tsUs: number): string {
  const ms = Math.floor(tsUs / 1000);
  const local = new Date(ms + OFFSET_MS);
  const micros = pad(((tsUs % 1_000_000) + 1_000_000) % 1_000_000, 6);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `.${micros}${offsetText(':')}`
  );
}

/** `21/Oct/2026:22:12:00 -0500` */
export function formatAccessTime(ms: number): string {
  const local = new Date(ms + OFFSET_MS);
  return (
    `${pad(local.getUTCDate())}/${MONTHS[local.getUTCMonth()] ?? 'Jan'}/${local.getUTCFullYear()}` +
    `:${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    ` ${offsetText('')}`
  );
}

/** Local (Lima) hour of day, 0–23, for diurnal traffic patterns. */
export function localHour(ms: number): number {
  return new Date(ms + OFFSET_MS).getUTCHours();
}

export interface AccessEntry {
  ip: string;
  user?: string;
  method: string;
  target: string;
  status: number;
  bytes: number;
  referer?: string;
  userAgent: string;
  /** `$request_time` in seconds, appended when the host logs it. */
  requestTime?: number;
}

/** Hosts whose nginx `log_format` appends `$request_time`. */
const LOGS_REQUEST_TIME: ReadonlySet<Host> = new Set(['web-02']);

export class LineCollector {
  constructor(
    readonly lines: GeneratedLine[] = [],
    private readonly scenario: string | null = null,
  ) {}

  /** A collector that tags lines with a scenario id and shares this one's storage. */
  forScenario(id: string): LineCollector {
    return new LineCollector(this.lines, id);
  }

  private push(host: Host, file: LogFile, tsUs: number, text: string): void {
    this.lines.push({ host, file, tsUs, text, scenario: this.scenario });
  }

  /** `<time> <host> <program>[<pid>]: <message>` in `<host>/auth.log`. */
  auth(host: Host, tsUs: number, program: string, pid: number, message: string): void {
    const us = Math.round(tsUs);
    this.push(host, 'auth', us, `${formatSyslogTime(us)} ${host} ${program}[${pid}]: ${message}`);
  }

  /** One combined-format line in `<host>/access.log` (second precision). */
  access(host: Host, ms: number, e: AccessEntry): void {
    const time = Math.floor(ms);
    let text =
      `${e.ip} - ${e.user ?? '-'} [${formatAccessTime(time)}] "${e.method} ${e.target} HTTP/1.1" ` +
      `${e.status} ${e.bytes} "${e.referer ?? '-'}" "${e.userAgent}"`;
    if (LOGS_REQUEST_TIME.has(host)) text += ` ${(e.requestTime ?? 0.004).toFixed(3)}`;
    this.push(host, 'access', time * 1000, text);
  }

  /** One JSON line in `<host>/sysmon.jsonl`, already formatted. */
  sysmon(host: Host, tsUs: number, json: string): void {
    this.push(host, 'sysmon', Math.round(tsUs), json);
  }
}
