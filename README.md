# Centinela

**English** | [Español](README.es.md)

Centinela is a small open-source SIEM: it ingests Linux auth logs, web server access logs and Windows Sysmon events, detects attacks with 1,245 Sigma rules and correlations, and shows each alert mapped to MITRE ATT&CK with a playbook in English or Spanish. You can run it on a laptop with three commands.

![The Overview: new alerts by severity and the ones to start with](docs/screenshots/overview.png)

![Demo: the Overview, the critical alert with its timeline and Spanish playbook, the ATT&CK matrix, and a live alert arriving](docs/screenshots/demo.gif)

<sub>Recorded from the real app with the demo data (41 s). More screenshots in [docs/screenshots](docs/screenshots).</sub>

## What it is, and what it is not

Centinela is a learning project that implements the core of a SIEM end to end: ingestion, parsing into normalized events, Sigma detection with correlation, alert triage, ATT&CK mapping and bilingual playbooks. It does not compete with Wazuh, Elastic or Splunk: there are no agents, no clustering and no per-analyst accounts, and it reads three log formats. What it tries to do well is be correct, explainable and safe with hostile input, and prove it with tests.

## Highlights

**A Sigma engine written from scratch.** It compiles all 1,231 vendored SigmaHQ rules and Centinela's 14 own rules ([rules report](docs/rules-report.md)): value modifiers from `contains` to `windash`, `base64offset`, `re`, `cidr`, `fieldref` and numeric comparisons, the full condition grammar, logsource routing, and Sigma correlations (`event_count`, `value_count`, `temporal`, `temporal_ordered`, chaining). It lacks the `expand` modifier, aggregation conditions, `near` and range or absence conditions in correlations, and reports any rule that uses them as unsupported. Rule regexes run on RE2, in linear time. With a literal index and a prefilter it evaluates **85,255 events/s** on a Linux/web mix and **5,956 events/s** on Windows process creation, where each event meets 1,193 rules (one thread, 4-vCPU Intel Xeon @ 2.10 GHz cloud VM, Node.js 22.22.0). Design, semantics and benchmark: [docs/DETECTION.md](docs/DETECTION.md).

**Detection quality measured against ground truth.** A seeded generator writes three days of logs for a fictional company with 19 labeled attack scenarios (brute force, password spraying, SQL injection, Log4Shell probes, a webshell, encoded PowerShell, LOLBins, credential dumping and more). The end-to-end test and `npm run demo` detect **19/19 scenarios**, and background traffic raises **no high or critical alert**. SigmaHQ's own regression samples: **272 of 276 events match, 267 of 267 files pass**, also through the full pipeline. How it is measured: [docs/DETECTION.md](docs/DETECTION.md#how-detection-quality-is-measured).

**A bilingual content pack.** Every vendored SigmaHQ rule except ten, and every Centinela rule, has an investigation playbook in English and Spanish (what it detects, why it matters, triage steps, false positives, response steps), shown next to the alert with an "AI-generated — review before use" label. The playbooks come with test events that the engine validates: **4,850 of 4,851 fixtures pass (99.9%)** for 1,221 SigmaHQ rules ([report](docs/content-pack-report.md)) and **36 of 36** for Centinela's rules ([report](content/centinela-report.md)); `npm test` keeps them as a regression suite.

**Security by design.** Log lines are written by the people Centinela watches, so the [threat model](docs/THREAT_MODEL.md) treats every field as hostile:

- _Hostile log content_ is rendered as text only (`dangerouslySetInnerHTML` is banned by a lint rule), under a strict Content Security Policy, and stored with parameterized SQL only.
- _ReDoS:_ rule regexes run on RE2 against values cut to 8,192 characters, parser regexes are anchored without nested quantifiers, and no regex is ever built from log content.
- _Brute force:_ argon2id passwords, a per-IP lockout after 5 failures for 15 minutes, rate limits on sign-in and ingest, and at most 4 password checks at once.
- _CSRF:_ a double-submit token bound to the session plus `SameSite=Strict` cookies.
- _Spoofed client addresses:_ `X-Forwarded-For` is believed only from the proxies `TRUST_PROXY` names, and `TRUST_PROXY=true` is refused.

The operator's guide is [docs/SECURITY.md](docs/SECURITY.md).

**Engineering practice.** TypeScript in strict mode with zod at every boundary; 1,342 tests in 96 files (Vitest, Supertest against a real PostgreSQL, React Testing Library); CI on every pull request (lint, typecheck, migrations, tests, build); and a decision record for every session ([docs/decisions](docs/decisions)).

**A public dataset.** The same generator covered every SigmaHQ rule folder (`rules`, `rules-emerging-threats`, `rules-threat-hunting` and `rules-compliance`): [DavidRamPari/sigma-playbooks](https://github.com/DavidRamPari/sigma-playbooks) holds bilingual playbooks for **3,759 of 3,779 rules**, with test events validated by Centinela's engine: **14,660 of 14,661 fixtures pass (99.9%)**.

## From a log line to an alert on screen

```mermaid
%%{init: {"flowchart": {"rankSpacing": 32, "nodeSpacing": 28}}}%%
flowchart TB
  I["Log lines → POST /api/ingest (bearer token, rate limit)"]
  I --> P["Parser: one normalized event per line"]
  P --> E[("PostgreSQL: events")]
  P --> S["Sigma rules: logsource routing, prefilter, matching"]
  S --> C["Correlation: windows on event time"]
  S --> A["Alert sink: deduplication, suppression"]
  C --> A
  A --> DB[("PostgreSQL: alerts")]
  A -->|"live stream (SSE)"| UI["Dashboard in English and Spanish"]
  DB -->|REST API| UI
  E -->|REST API| UI
```

The same pipeline serves `npm run ingest` (files) and the dashboard's upload. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/DETECTION.md](docs/DETECTION.md).

## Quick start

You need Node.js 22 ([`.nvmrc`](.nvmrc)) and Docker with Compose v2: Docker Desktop on macOS or on Windows (run the commands in a WSL 2 terminal with Docker Desktop's WSL integration on), or Docker Engine on Linux. Ports 5432, 3000 and 8080 must be free on 127.0.0.1.

```bash
git clone https://github.com/DavidRamPari/centinela.git && cd centinela
npm ci                                 # install the workspaces
docker compose up -d --build --wait    # PostgreSQL, API and dashboard; returns once they are healthy
npm run demo                           # three days of demo logs through the detection pipeline
```

`npm run demo` ends like this (from a fresh clone, 2026-10-27):

```text
  total: 200280 events, 0 rejected, 37 alerts created, 2 updated in 34.3 s (5847 events/s)
  alerts by level: critical 1, high 17, medium 16, low 3, informational 0
...
detected 19/19 scenarios

Open the dashboard: http://localhost:8080 (docker compose) or http://localhost:5173 (npm run dev).
The default view shows the last 24 hours; pick "Last 7 days" to see every scenario.
Sign in as admin / centinela-dev (development credentials).
```

Open <http://localhost:8080> and sign in as `admin` with the password `centinela-dev`. `--wait` returns only when PostgreSQL and the server are healthy (migrations applied), so nothing races the database start-up.

- Running the demo again refuses to load a second copy: `npm run demo -- --reset` replaces the data (rule on/off flags are kept).
- To watch a live alert arrive, keep the dashboard open and send twelve failed SSH sign-ins followed by a successful one from the same address:

  ```bash
  ts=$(date -u +%Y-%m-%dT%H:%M:%S)
  { for i in $(seq 10 21); do
      echo "$ts.${i}0000+00:00 bastion-01 sshd[70$i]: Failed password for root from 203.0.113.201 port 510$i ssh2"
    done
    echo "$ts.990000+00:00 bastion-01 sshd[7099]: Accepted password for deploy from 203.0.113.201 port 51099 ssh2"
  } | curl -sS -X POST 'http://localhost:8080/api/ingest?source=linux_auth&host=bastion-01' \
        -H 'Authorization: Bearer dev-ingest-token-change-me' -H 'Content-Type: text/plain' --data-binary @-
  ```

  The answer reports `"alertsCreated":2`: the brute force (high) and the successful sign-in after it (critical) pop up as notifications.

- Stop the stack with `docker compose down` (add `-v` to delete the database volume).
- If a port is taken, set `POSTGRES_PORT`, `SERVER_PORT` or `WEB_PORT` in a `.env` file (copy [`.env.example`](.env.example)); with another PostgreSQL port, set `DATABASE_URL` to match so `npm run demo` finds it.

### Developing

```bash
docker compose up -d --wait postgres   # PostgreSQL only
npm run db:migrate
npm run dev                            # API on :3000 (watch mode), dashboard on http://localhost:5173
```

`VITE_USE_MOCKS=true npm run dev -w packages/web` runs the dashboard on mock data, without the API or a database.

| Script | What it does |
| --- | --- |
| `npm run dev` | API server and Vite dev server together |
| `npm run build` | build `shared`, then `server`, `web` and `loggen` |
| `npm test` | Vitest across every package (needs PostgreSQL) |
| `npm run lint` · `npm run typecheck` · `npm run format` | ESLint and Prettier check · `tsc` for every package · Prettier write |
| `npm run db:migrate` | apply pending migrations to `DATABASE_URL` |
| `npm run demo [-- --reset]` | generate, ingest and detect the demo data set, then check it against the ground truth |
| `npm run ingest -- --source <type> --host <name> --file <path>` | ingest a log file through the pipeline (`linux_auth`, `nginx_access`, `apache_access`, `sysmon`) |
| `npm run loggen -- [--small] [--seed n] [--out dir]` | write the demo logs and `ground-truth.json` (default `samples/`) |
| `npm run rules:report` · `npm run bench` | rule loading report ([docs/rules-report.md](docs/rules-report.md)) · engine benchmark |
| `npm run content:validate` | run every content-pack fixture through the engine and write the report |
| `npm run hash-password` · `npm run audit` | argon2id hash for the admin password · `npm audit --audit-level=high` |

## Signing in, tokens and production

**Development sign-in.** Outside production, with `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` and `SESSION_SECRET` unset, the server uses the published development account `admin` / `centinela-dev` and logs a warning saying so. To use your own password locally, run `npm run hash-password --silent`, type it twice, and paste the printed line into `.env`:

```bash
ADMIN_PASSWORD_HASH='$argon2id$v=19$m=65536,p=4,t=3$…'
```

Keep the single quotes: the hash contains `$`, which the shell and Docker Compose would otherwise expand. The command never takes the password from its arguments, needs at least 12 characters and refuses the development password.

**Dependency audit.** `npm run audit` fails on high or critical advisories (`npm audit --audit-level=high`).

**Ingest tokens.** Log shippers and scripts send lines to `POST /api/ingest` with a bearer token: `INGEST_TOKEN` from the environment, or tokens created on the dashboard's Security page (shown once, stored as SHA-256, revocable, with their last use). Lines can be plain text or NDJSON, up to 5 MB per request; `npm run ingest` streams larger files.

```bash
curl -X POST 'http://localhost:8080/api/ingest?source=linux_auth&host=bastion-01' \
  -H "Authorization: Bearer $INGEST_TOKEN" -H 'Content-Type: text/plain' \
  --data-binary @/var/log/auth.log
```

**Production refusals.** With `NODE_ENV=production` the server refuses to start, naming the variable but never its value, when `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` or `SESSION_SECRET` is missing; when the hash is not argon2id, is weaker than OWASP's minimum (19 MiB, 2 iterations) or accepts the development password; when `SESSION_SECRET` or `INGEST_TOKEN` is shorter than 32 characters or a development value; or when `DATABASE_URL` uses the development database password. `TRUST_PROXY=true` is refused in every environment. Every variable is documented in [`.env.example`](.env.example).

### Running it on your own server

The Compose file is for local use: it runs with development secrets and binds every port to 127.0.0.1. On a server:

1. Build the two images (`docker build -f packages/server/Dockerfile .` and `docker build -f packages/web/Dockerfile .`) and run them next to a PostgreSQL 16 database of your own. Apply the migrations with `node packages/server/dist/db/cli/migrate.js` in the server image before starting it (the Compose file does this), and point the web container at the server with `API_UPSTREAM` (default `http://server:3000`).
2. Set `NODE_ENV=production`, `DATABASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` (from `npm run hash-password`), and `SESSION_SECRET` and `INGEST_TOKEN` from `openssl rand -hex 32`. Keep them in your secret store, not in the repository.
3. Put a TLS terminator in front of the web container, serve the dashboard and `/api` from one origin (the bundled nginx proxies `/api`), and send HSTS from the terminator. Over HTTPS, and always with `NODE_ENV=production`, the session and CSRF cookies are `__Host-` cookies with `Secure`.
4. Set `TRUST_PROXY` to the number of proxy hops in front of the API (`1` for the bundled nginx alone) or to the proxies' addresses or subnets, so rate limits, the sign-in lockout and the audit log see the real client IP. Without it every request seems to come from the proxy, and one lockout locks everyone out.
5. Optionally build the web image with `--build-arg VITE_PUBLIC_URL=https://your.host` for link previews.

The full guide, including the cookies used over plain HTTP on localhost, is [docs/SECURITY.md](docs/SECURITY.md).

## Testing

```bash
docker compose up -d --wait postgres
npm run lint && npm run typecheck && npm run db:migrate && npm test && npm run build
```

`npm test` runs 1,342 tests in 96 files across the four packages; database tests each create a throwaway schema. They cover every parser message type, every modifier and grammar construct, correlation windows at their boundaries, every API endpoint with its validation and pagination, authentication (lockout, CSRF, both cookie modes, a `401` for every protected route), the 19 scenarios end to end, the SigmaHQ regression samples, the content-pack fixtures, and the dashboard (i18n key parity, hostile strings rendered as text, keyboard navigation, contrast, the Content Security Policy). CI runs the same sequence on GitHub's two-CPU runner ([`ci.yml`](.github/workflows/ci.yml)).

## Roadmap and known gaps

Known gaps, from the session decision records:

- **Sigma:** `expand` and unknown modifiers, aggregation conditions, `near`, and `lt`/`lte`/`eq` correlation conditions are unsupported ([DETECTION.md](docs/DETECTION.md#not-supported)).
- **NDJSON ingest** turns an object with a `message` key into that message, so Sysmon events from a shipper that adds one (Winlogbeat does) are rejected; send them as plain text, one JSON object per line ([S5-09](docs/decisions/S5.md)).
- **Demo ingestion is bound by the database:** about 6,000 events/s through PostgreSQL against 85,255 events/s in the engine alone ([DETECTION.md](docs/DETECTION.md#benchmark)).
- **Upload history** on the Ingest page is kept per browser, in local storage ([S3](docs/decisions/S3.md)).
- **Overview counts** stop at "200+" new alerts; an exact count needs an API change ([S7b-15](docs/decisions/S7b.md)).
- **Chart axis width** is estimated from the label length, not measured ([S7b-15](docs/decisions/S7b.md)).
- **Windows users** appear without their domain in the alerts table; the alert page shows `DOMAIN\name` ([S7b-15](docs/decisions/S7b.md)).
- **Firefox** was not reviewed; Chromium and WebKit were ([S7b-18](docs/decisions/S7b.md)).
- One admin account without a second factor, and detection state in one process ([threat model](docs/THREAT_MODEL.md#residual-risks)).

Next steps: per-analyst accounts and roles, range conditions in correlations, Sysmon over NDJSON as shipped by Winlogbeat, and more Windows event types.

## Repository guide

| Path | Contents |
| --- | --- |
| `packages/shared` | zod schemas and types for events, alerts, rules and the HTTP API; ATT&CK helper |
| `packages/server` | Express API, parsers, ingestion pipeline, detection engine, migrations |
| `packages/web` | React dashboard (English and Spanish) |
| `packages/loggen` | seeded demo data generator with ground truth |
| `rules/` | vendored SigmaHQ rules (`sigma/`), Centinela's rules (`centinela/`, `correlation/`) |
| `content/` | bilingual playbooks and test fixtures per rule ([content/README.md](content/README.md)) |
| `data/mitre-attack/` | compact MITRE ATT&CK reference data |
| `docs/` | [architecture](docs/ARCHITECTURE.md), [detection](docs/DETECTION.md), [threat model](docs/THREAT_MODEL.md), [security guide](docs/SECURITY.md), [build plan](docs/PLAN.md), [decisions](docs/DECISIONS.md) |
| `tools/content-pack/` | the Python tool that generated the content pack |

## Credits

- **SigmaHQ.** The rules in [`rules/sigma/`](rules/sigma) come from [SigmaHQ](https://github.com/SigmaHQ/sigma) (commit `05d1031f`) under the [Detection Rule License 1.1](rules/sigma/LICENSE.Detection.Rules.md). Every alert, rule page and playbook shows the rule's author, a link to the rule and the license. Ten vendored rules have no playbook: they detect offensive techniques, their test events would have had to contain attack command lines, and the model's safety filter stopped both attempts. They are listed in [content/README.md](content/README.md#rules-without-content):

  <details><summary>The ten rules without a playbook</summary>

  - HackTool - DInjector PowerShell Cradle Execution
  - HKTL - SharpSuccessor Privilege Escalation Tool Execution
  - Suspicious Encoded And Obfuscated Reflection Assembly Load Function Call
  - Assembly Loading Via CL_LoadAssembly.ps1
  - Potential Powershell ReverseShell Connection
  - Potential Privilege Escalation via Service Permissions Weakness
  - Suspicious NTLM Authentication on the Printer Spooler Service
  - Registry Modification of MS-settings Protocol Handler
  - UAC Bypass Using Disk Cleanup
  - UAC Bypass Using Event Viewer RecentViews

  </details>

- **MITRE ATT&CK®.** Tactics and techniques from [mitre/cti](https://github.com/mitre/cti) (Enterprise matrix modified 2026-07-31). © The MITRE Corporation. This work is reproduced and distributed with the permission of The MITRE Corporation.
- **Fonts.** [Atkinson Hyperlegible Next and Atkinson Hyperlegible Mono](packages/web/src/assets/fonts) by the Braille Institute, under the SIL Open Font License 1.1, self-hosted.
- **Playbooks.** Every playbook in [`content/`](content) was written by Anthropic's Claude through the Message Batches API with [`tools/content-pack`](tools/content-pack) and is marked "AI-generated — review before use" in the dashboard and `"review": "unreviewed"` in its file until a person checks it.

## License

Code: [MIT](LICENSE). Vendored Sigma rules: [DRL 1.1](rules/sigma/LICENSE.Detection.Rules.md).
