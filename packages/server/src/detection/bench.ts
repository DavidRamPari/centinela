/**
 * Event mixes and the measurement loop for `npm run bench`. The Linux/web mix is made of
 * realistic auth.log and nginx lines run through the real parsers (mostly routine
 * traffic, some brute force, scanning and SQL injection). The Windows mix is Sysmon
 * process creation: routine processes plus the SigmaHQ regression samples (one in ten).
 * Both are deterministic: event `i` is always the same.
 */
import { performance } from 'node:perf_hooks';
import type { FieldValue, NormalizedEvent, SourceType } from '@centinela/shared';
import { createParserRegistry } from '../parsers/index.js';
import { createEngine } from './engine.js';
import type { RegressionSample } from './regression.js';
import { PROCESS_CREATION } from './regression.js';
import type { RuleSet } from './rules/ruleset.js';

const START_MS = Date.parse('2026-10-25T00:00:00Z');
const STEP_MS = 50;
const STAFF = ['alice', 'bruno', 'carla', 'diego', 'elena'];
const TARGETS = ['root', 'admin', 'oracle', 'test', 'ubuntu', 'postgres'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function pick<T>(list: readonly T[], i: number): T {
  return list[i % list.length] as T;
}

function benchId(mix: number, i: number): string {
  return `01930f6e-8a4b-7c2d-9e1${mix}-${i.toString(16).padStart(12, '0')}`;
}

function clfTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${MONTHS[d.getUTCMonth()] ?? 'Jan'}/${d.getUTCFullYear()}:${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

type Template = (
  i: number,
  ts: string,
  clf: string,
) => { source: SourceType; host: string; line: string };

const auth =
  (host: string, text: (i: number) => string): Template =>
  (i, ts) => ({
    source: 'linux_auth',
    host,
    line: `${ts} ${host} ${text(i)}`,
  });

const web =
  (host: string, text: (i: number, clf: string) => string): Template =>
  (i, _ts, clf) => ({
    source: 'nginx_access',
    host,
    line: text(i, clf),
  });

const customer = (i: number) => `198.18.${(i >> 8) & 255}.${i & 255}`;

/** Routine traffic dominates; the last templates are attacks. */
const LINUX_WEB_TEMPLATES: Template[] = [
  auth(
    'bastion-01',
    (i) =>
      `sshd[${2000 + (i % 3000)}]: Accepted publickey for ${pick(STAFF, i)} from 10.20.1.${i % 200} port ${40000 + (i % 20000)} ssh2: ED25519 SHA256:q1w2e3r4t5y6u7i8o9p0`,
  ),
  auth(
    'bastion-01',
    (i) =>
      `sshd[${2000 + (i % 3000)}]: pam_unix(sshd:session): session opened for user ${pick(STAFF, i)}(uid=1001) by (uid=0)`,
  ),
  auth(
    'bastion-01',
    (i) =>
      `sshd[${2000 + (i % 3000)}]: Disconnected from user ${pick(STAFF, i)} 10.20.1.${i % 200} port ${40000 + (i % 20000)}`,
  ),
  auth(
    'db-01',
    (i) =>
      `CRON[${5000 + (i % 1000)}]: pam_unix(cron:session): session opened for user root(uid=0) by (uid=0)`,
  ),
  auth(
    'db-01',
    (i) =>
      `sudo: ${pick(STAFF, i)} : TTY=pts/${i % 4} ; PWD=/home/${pick(STAFF, i)} ; USER=root ; COMMAND=/usr/bin/systemctl restart nginx`,
  ),
  auth('db-01', (i) => `systemd-logind[512]: New session ${i} of user ${pick(STAFF, i)}.`),
  web(
    'web-01',
    (i, clf) =>
      `${customer(i)} - - [${clf}] "GET /products/${i % 500} HTTP/1.1" 200 5123 "https://shop.andes-retail.example/" "${BROWSER}"`,
  ),
  web(
    'web-01',
    (i, clf) =>
      `${customer(i)} - - [${clf}] "GET /static/app.${i % 7}.js HTTP/1.1" 200 81234 "https://shop.andes-retail.example/" "${BROWSER}"`,
  ),
  web(
    'web-02',
    (i, clf) =>
      `${customer(i)} - - [${clf}] "GET /search?q=zapatillas+talla+${i % 45} HTTP/1.1" 200 2311 "-" "${BROWSER}"`,
  ),
  web(
    'web-02',
    (i, clf) =>
      `${customer(i)} - - [${clf}] "POST /cart HTTP/1.1" 302 0 "https://shop.andes-retail.example/cart" "${BROWSER}"`,
  ),
  web(
    'web-01',
    (i, clf) => `${customer(i)} - - [${clf}] "GET /favicon.ico HTTP/1.1" 404 162 "-" "${BROWSER}"`,
  ),
  auth(
    'bastion-01',
    (i) =>
      `sshd[${2000 + (i % 3000)}]: Failed password for ${pick(TARGETS, i)} from 203.0.113.${i % 50} port ${40000 + (i % 20000)} ssh2`,
  ),
  auth(
    'bastion-01',
    (i) =>
      `sshd[${2000 + (i % 3000)}]: Invalid user ${pick(TARGETS, i)} from 198.51.100.${i % 50} port ${40000 + (i % 20000)}`,
  ),
  web(
    'web-01',
    (i, clf) =>
      `192.0.2.${i % 20} - - [${clf}] "GET /admin/${i % 900}.php HTTP/1.1" 404 162 "-" "Nikto/2.5.0"`,
  ),
  web(
    'web-02',
    (i, clf) =>
      `192.0.2.${i % 20} - - [${clf}] "GET /items?id=${i % 90}%20UNION%20ALL%20SELECT%20NULL,NULL-- HTTP/1.1" 500 512 "-" "sqlmap/1.8"`,
  ),
];

/** `count` Linux auth and nginx events, parsed by the real parsers, in time order. */
export function linuxWebEvents(count: number): NormalizedEvent[] {
  const parsers = createParserRegistry();
  const events: NormalizedEvent[] = [];
  const receivedAt = new Date(START_MS + count * STEP_MS + 3_600_000);
  for (let i = 0; i < count; i += 1) {
    const ms = START_MS + i * STEP_MS;
    const template = pick(LINUX_WEB_TEMPLATES, i);
    const { source, host, line } = template(i, new Date(ms).toISOString(), clfTime(ms));
    const result = parsers.get(source)?.parse(line, { source, host, receivedAt, timezone: 'UTC' });
    if (!result?.ok) throw new Error(`bench template does not parse: ${line}`);
    events.push({ ...result.event, id: benchId(1, i), ingestedAt: receivedAt.toISOString() });
  }
  return events;
}

type ProcessFields = Record<string, FieldValue>;

const ROUTINE_PROCESSES: ProcessFields[] = [
  {
    Image: 'C:\\Windows\\System32\\svchost.exe',
    OriginalFileName: 'svchost.exe',
    CommandLine: 'C:\\Windows\\system32\\svchost.exe -k netsvcs -p -s Schedule',
    ParentImage: 'C:\\Windows\\System32\\services.exe',
    ParentCommandLine: 'C:\\Windows\\system32\\services.exe',
    User: 'NT AUTHORITY\\SYSTEM',
    IntegrityLevel: 'System',
    Company: 'Microsoft Corporation',
    Product: 'Microsoft® Windows® Operating System',
    Description: 'Host Process for Windows Services',
    CurrentDirectory: 'C:\\Windows\\system32\\',
  },
  {
    Image: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    OriginalFileName: 'chrome.exe',
    CommandLine:
      '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer --lang=es-419 --renderer-client-id=7 --mojo-platform-channel-handle=4120 /prefetch:1',
    ParentImage: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ParentCommandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"',
    User: 'ANDES\\carla',
    IntegrityLevel: 'Low',
    Company: 'Google LLC',
    Product: 'Google Chrome',
    Description: 'Google Chrome',
    CurrentDirectory: 'C:\\Program Files\\Google\\Chrome\\Application\\126.0.6478.127\\',
  },
  {
    Image: 'C:\\Windows\\explorer.exe',
    OriginalFileName: 'EXPLORER.EXE',
    CommandLine: 'C:\\Windows\\Explorer.EXE',
    ParentImage: 'C:\\Windows\\System32\\userinit.exe',
    ParentCommandLine: 'C:\\Windows\\system32\\userinit.exe',
    User: 'ANDES\\diego',
    IntegrityLevel: 'Medium',
    Company: 'Microsoft Corporation',
    Product: 'Microsoft® Windows® Operating System',
    Description: 'Windows Explorer',
    CurrentDirectory: 'C:\\Windows\\system32\\',
  },
  {
    Image: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE',
    OriginalFileName: 'Outlook.exe',
    CommandLine: '"C:\\Program Files\\Microsoft Office\\Root\\Office16\\OUTLOOK.EXE"',
    ParentImage: 'C:\\Windows\\explorer.exe',
    ParentCommandLine: 'C:\\Windows\\Explorer.EXE',
    User: 'ANDES\\elena',
    IntegrityLevel: 'Medium',
    Company: 'Microsoft Corporation',
    Product: 'Microsoft Outlook',
    Description: 'Microsoft Outlook',
    CurrentDirectory: 'C:\\Users\\elena\\',
  },
  {
    Image: 'C:\\Windows\\System32\\conhost.exe',
    OriginalFileName: 'CONHOST.EXE',
    CommandLine: '\\??\\C:\\Windows\\system32\\conhost.exe 0xffffffff -ForceV1',
    ParentImage: 'C:\\Windows\\System32\\cmd.exe',
    ParentCommandLine: '"C:\\Windows\\system32\\cmd.exe"',
    User: 'ANDES\\bruno',
    IntegrityLevel: 'Medium',
    Company: 'Microsoft Corporation',
    Product: 'Microsoft® Windows® Operating System',
    Description: 'Console Window Host',
    CurrentDirectory: 'C:\\Users\\bruno\\',
  },
];

/**
 * `count` Sysmon process-creation events: nine routine processes for each regression
 * sample, with `EventData` as `fields`.
 */
export function windowsEvents(
  count: number,
  samples: readonly RegressionSample[],
): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    const ms = START_MS + i * STEP_MS;
    const malicious = samples.length > 0 && i % 10 === 9;
    const base = malicious
      ? pick(samples, Math.floor(i / 10)).fields
      : { ...pick(ROUTINE_PROCESSES, i), ProcessId: 4000 + (i % 5000) };
    const fields: ProcessFields = { ...base, UtcTime: new Date(ms).toISOString() };
    events.push({
      id: benchId(2, i),
      ts: new Date(ms).toISOString(),
      ingestedAt: new Date(ms).toISOString(),
      source: 'sysmon',
      host: `WS-${String(100 + (i % 40)).padStart(4, '0')}`,
      logsources: [PROCESS_CREATION],
      category: 'process',
      action: 'process_start',
      outcome: 'success',
      message: JSON.stringify(fields).slice(0, 8192),
      fields,
    });
  }
  return events;
}

export interface BenchResult {
  events: number;
  durationMs: number;
  eventsPerSecond: number;
  candidates: number;
}

/** Run the events through a fresh engine over `ruleSet` and time it. */
export function measure(ruleSet: RuleSet, events: readonly NormalizedEvent[]): BenchResult {
  const engine = createEngine(ruleSet);
  let candidates = 0;
  const started = performance.now();
  for (const event of events) candidates += engine.process(event).length;
  const last = events[events.length - 1];
  if (last) candidates += engine.flush(new Date(last.ts)).length;
  const durationMs = performance.now() - started;
  return {
    events: events.length,
    durationMs,
    eventsPerSecond:
      durationMs > 0 ? Math.round((events.length / durationMs) * 1000) : events.length,
    candidates,
  };
}
