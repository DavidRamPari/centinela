# Centinela — build plan

Each session below is one Claude Code cloud session that ends with a pushed branch and a pull request. Sessions S1, S2 and S3 run in parallel; they own different paths so their pull requests merge without conflicts.

## Status

| Session | Title | Depends on | Status |
| --- | --- | --- | --- |
| S0 | Foundations | — | done (PR #1) |
| S1 | Ingestion, parsers and log generator | S0 | done (PR #2) |
| S2 | Detection engine (Sigma + correlation) | S0 | done (PR #4) |
| S3 | Dashboard on mocks | S0 | done (PR #5) |
| S4 | Integration, persistence and end-to-end detection | S1, S2, S3 | done (PR #6) |
| S5 | Windows Sysmon support | S4 | done (PR #7) |
| S6 | Authentication, hardening and threat model | S4 | done (PR #8) |
| S7 | Content pack in the product | S4 and `content/sigma/` | done (PRs #9 and #11) |
| S7b | Dashboard polish | S7 | done (PRs #10 and #12) |
| S8 | Documentation and local quick start | S5, S6, S7, S7b | done |

Status values: `todo`, `in progress`, `done (PR #n)`, `partial (see notes)`. David updates this table when he merges a session; sessions do not edit it (parallel edits to adjacent rows conflict).

## Prompt for any session

```text
Read CLAUDE.md and docs/PLAN.md, then run session S<N> end to end.
Stay inside the paths that session owns. Don't ask me questions: decide, record the decision in docs/decisions/S<N>.md and continue.
Before finishing, run lint, typecheck, test and build, push your branch and end with a summary that includes the exact commands I can run to verify it locally.
```

---

## S0 — Foundations

**Goal.** A monorepo skeleton with the contracts (types, interfaces, schema, API stubs) fixed, so S1–S3 only fill in their own modules.

**Owns.** Everything except `rules/`, `data/` and `tools/`.

**Build.**

1. npm workspaces `packages/shared`, `packages/server`, `packages/web`, `packages/loggen`. Root scripts: `dev`, `build`, `test`, `lint`, `typecheck`, `format`, `db:migrate`, `ingest`, `loggen`, `rules:report` and `bench` (forwarding to their packages), `demo` (prints "available after S4").
2. `tsconfig.base.json` (strict, ESM, `NodeNext` for Node packages, `Bundler` for web) extended by each package; `@centinela/shared` importable from server, web and loggen.
3. ESLint flat config (typescript-eslint, react-hooks, react-refresh) + Prettier, with `dangerouslySetInnerHTML` banned repo-wide through `no-restricted-syntax` (selector `JSXAttribute[name.name='dangerouslySetInnerHTML']`); Vitest configured so `npm test` at the root runs every package.
4. Install every dependency in ARCHITECTURE §14 in the right workspace now, so S1–S3 rarely touch `package-lock.json`.
5. `packages/shared`: zod schemas and inferred types for `NormalizedEvent`, `Alert`, `RuleMeta` and every API request/response in ARCHITECTURE §§3 and 9; an ATT&CK helper that loads `data/mitre-attack/enterprise-attack.min.json` and maps technique IDs to name, tactics and URL.
6. `packages/server`:
   - zod-validated config with development defaults (ARCHITECTURE §15); pino logger; Express app factory with `helmet`, body limits and a problem+json error handler; graceful shutdown.
   - `GET /api/health` that checks the database.
   - Router registry (`src/routes/index.ts`) mounted by `app.ts`, with a stub returning `501` problem+json for every endpoint in ARCHITECTURE §9 except `GET /api/health` and the two ingest endpoints. The ingest routes are mounted from `src/ingest/router.ts`, which S0 creates as a stub and S1 implements.
   - Pipeline interfaces, orchestrator and `createPipeline()` wiring exactly as in ARCHITECTURE §2.3, with stub modules `src/parsers/index.ts` and `src/db/events-write.ts` (S1), `src/detection/index.ts` (S2), an in-memory `AlertSink` and a no-op publisher.
   - CLI entry points as stubs that print which session implements them: `src/ingest/cli.ts` (S1), `src/detection/cli/report.ts` and `src/detection/cli/bench.ts` (S2), wired to the `ingest`, `rules:report` and `bench` scripts in `packages/server/package.json`.
   - Migration `001` creating the schema in ARCHITECTURE §8 with `node-pg-migrate`.
   - Test helper `test/helpers/db.ts`: creates a throwaway schema, runs the migrations into it, returns a pool plus a cleanup function. Every database test in every session uses it.
7. `packages/web`: Vite + React + TypeScript + Tailwind v4 shell — sidebar layout (Overview, Alerts, Events, ATT&CK, Rules, Ingest), placeholder pages, router, TanStack Query provider, i18n (`en`/`es`, toggle persisted in `localStorage` inside try/catch), typed API client, MSW enabled when `VITE_USE_MOCKS=true` and in tests, Vite proxy for `/api`.
8. `packages/loggen`: package with a CLI entry that prints help (implementation in S1).
9. `docker-compose.yml` with services named `postgres` (postgres:16, same credentials as the default `DATABASE_URL`, port 5432), `server` and `web`; multi-stage Dockerfiles running as a non-root user; `.env.example` extended. `docker compose up -d postgres` alone must be enough to run the tests locally.
10. Confirm `scripts/cloud-session-start.sh` works end to end in the cloud session (PostgreSQL up, `npm ci`, `npm run db:migrate`). Adjust it if needed.
11. `README.md`: quick start with and without Docker, scripts table, project status.

**Acceptance.**

- `npm ci && npm run lint && npm run typecheck && npm test && npm run build` passes from a clean clone.
- `npm run db:migrate` creates every table in ARCHITECTURE §8; running it twice is a no-op.
- `GET /api/health` returns `200 {"status":"ok","db":"ok"}` with the database up and `503 {"status":"degraded","db":"down"}` when it is unreachable (both tested).
- Every endpoint in ARCHITECTURE §9 except health and the two ingest endpoints exists and returns `501` problem+json (one table-driven test; later sessions delete rows as they implement endpoints).
- `npm run ingest`, `npm run rules:report` and `npm run bench` run and print their stub message.
- `npm run dev` serves the web shell; navigation works in English and Spanish; a test covers the language toggle.
- Every shared schema has a test that parses a valid sample and rejects an invalid one.

**Not in S0.** Real parsing, detection, real endpoints, authentication.

---

## S1 — Ingestion, parsers and log generator

**Goal.** Raw log lines in, validated `NormalizedEvent`s out and stored in PostgreSQL; plus a realistic, labeled demo-data generator.

**Owns.** `packages/server/src/parsers/**`, `packages/server/src/ingest/**`, `packages/server/src/db/events-write.ts`, `packages/loggen/**`, `samples/**`.

**Build.**

1. Parsers implementing `Parser` (ARCHITECTURE §2.3, §4):
   - `linux_auth`: RFC 3164 timestamps (`Oct 25 14:03:12 host prog[pid]: msg`, year and timezone from the ingest context, year rollover) and RFC 3339 timestamps (`2026-10-25T14:03:12.123456-05:00 host prog[pid]: msg`). Every message type in ARCHITECTURE §4.1 maps to action, outcome, user, source IP/port and `fields`. Unknown messages become `action: "other"`; nothing is dropped.
   - `nginx_access` and `apache_access`: combined log format, with an optional trailing request time. Split the request line into method, URI stem, query and version; map to the Sigma webserver fields and ECS-style fields in ARCHITECTURE §4.2. Unparseable request lines become `action: "http_malformed"`; lines that are not access-log lines at all are rejected with a reason.
   - Every event carries `logsources` as defined in ARCHITECTURE §4 so rule routing works.
2. Ingest:
   - `POST /api/ingest` (ARCHITECTURE §9): plain text lines or NDJSON, `source`/`host`/`tz` query parameters, bearer token `INGEST_TOKEN` compared in constant time, 5 MB limit, rate limit. Returns accepted/rejected counts and up to 20 rejection samples.
   - `POST /api/ingest/upload` for the dashboard (ARCHITECTURE §9): same pipeline and limits, no token, enabled only when `NODE_ENV` is not `production` (S6 adds session auth and CSRF).
   - CLI `npm run ingest -- --source <type> --host <name> --file <path> [--tz <IANA zone>]` (implement `src/ingest/cli.ts`) streaming large files in batches of 1,000 through `createPipeline()` and printing counts and lines per second.
3. `db/events-write.ts`: batched inserts (multi-row `INSERT` or `COPY`), at most one round trip per 1,000 events.
4. `packages/loggen`: seeded generator (own PRNG such as mulberry32, never `Math.random`) for the fictional company "Andes Retail":
   - Hosts `bastion-01`, `web-01`, `web-02`, `db-01`; default 3 days of background traffic plus every attack scenario in ARCHITECTURE §4.3, each tagged with its ATT&CK technique and expected detection.
   - Before writing a scenario that a SigmaHQ rule should catch, read that rule file in `rules/sigma/` and make sure the generated lines satisfy its detection logic.
   - Outputs `samples/<host>/auth.log`, `samples/<host>/access.log` and `samples/ground-truth.json` (scenario id, technique, host, start/end time, entities, expected rule names or ids).
   - Flags `--seed`, `--days`, `--start`, `--out`, `--small` (a few minutes of traffic around each scenario, for tests). Default run: about 200,000 lines in under 10 seconds.
   - `samples/` is generated, not committed (keep `samples/README.md`).

**Acceptance.**

- At least 40 parser tests covering every message type in ARCHITECTURE §4.1, both timestamp formats, year rollover, IPv6, malformed lines and very long lines (truncated to 8,192 characters).
- Same seed gives byte-identical output; different seeds differ (tested).
- Parsing the default sample stores 100% of lines (unknown ones as `other`) with zero exceptions; the CLI reports at least 20,000 lines/s parse-only on the cloud VM.
- `POST /api/ingest` answers `401` without or with a wrong token, `413` for an oversized body and `400` for an unknown source; `POST /api/ingest/upload` answers `404` when `NODE_ENV=production` (Supertest against a real database).
- `samples/ground-truth.json` uses the rule names from ARCHITECTURE §6.1 and the SigmaHQ file names from §4.3.

**Not in S1.** Detection, alert storage, UI.

---

## S2 — Detection engine (Sigma + correlation)

**Goal.** Compile Sigma rules into fast matchers and run correlation rules over event time.

**Owns.** `packages/server/src/detection/**`, `rules/centinela/**`, `rules/correlation/**`, `docs/rules-report.md`.

**Build.**

1. Loader for `rules/sigma/**` (excluding `rules/sigma/regression/`), `rules/centinela/**` and `rules/correlation/**`: one YAML document per file, zod validation, `RuleMeta` extraction as in ARCHITECTURE §3.3 (license `DRL-1.1` for `rules/sigma`, `MIT` for Centinela's own rules; SigmaHQ URL built from the commit in `rules/sigma/README.md`).
2. Compiler following ARCHITECTURE §5: selections (maps, lists of maps, keyword lists), every modifier in §5.3, the condition grammar in §5.4 (recursive descent, precedence `not` > `and` > `or`, parentheses, `1 of` / `all of` with wildcards and `them`, a list of conditions means OR). Unsupported constructs skip the rule with a machine-readable reason (§5.5).
3. Logsource routing (§5.2) with a precomputed index so each event is only tested against applicable rules.
4. Correlation engine (§6): `event_count`, `value_count`, `temporal`, `temporal_ordered`, chaining, `group-by`, `timespan`, `condition` (`gt`, `gte`, plus `field` for `value_count`), the `generate` flag, event-time sliding windows with eviction.
5. Alert candidates (`AlertCandidate` with its `rule` snapshot, §2.3) with deduplication and suppression (§7), returned by the `Detector` exported from `src/detection/index.ts` and consumed by the in-memory `AlertSink` from S0 (the PostgreSQL sink is S4).
6. Centinela's rules, exactly as listed in ARCHITECTURE §6.1 (names, logsources, detection, thresholds, levels, `generate`), each with `author: DavidRamPari`, ATT&CK tags, description and false positives.
7. `npm run rules:report` (implement `src/detection/cli/report.ts`): loaded and skipped counts by folder and reason, printed and written to `docs/rules-report.md`.
8. `npm run bench` (implement `src/detection/cli/bench.ts`): events per second through the engine for a Linux/web event mix and for a Windows process-creation mix.

**Acceptance.**

- At least 99% of the rules in `rules/sigma` compile; the report lists every skipped rule with its reason.
- Unit tests for each modifier (including `windash` variants, `base64offset`, `re` with `i`/`m`/`s`, wildcards and escapes, case-insensitivity, `null`, `exists`, `cidr`, numeric comparisons, `fieldref`) and each grammar construct: at least 60 tests.
- Golden tests: every event in `rules/sigma/regression/windows/process_creation/**` matches its rule, using `Event.EventData` as the field view (files are pretty-printed and some hold several objects; see ARCHITECTURE §4.4). At least 95% pass; failures are listed with reasons in the report.
- Correlation tests with hand-built event streams: thresholds at boundary values, window expiry, group isolation, ordered versus unordered temporal, chaining (`centinela-ssh-bruteforce-success` fires after `centinela-ssh-bruteforce` and a success, not after two failures and a success), `generate: false` suppressing only Sigma building blocks.
- Same input produces the same alerts in the same order (tested).
- `npm run bench` reports at least 5,000 events/s for the Linux/web mix.

**Not in S2.** Parsing real files, database writes, HTTP endpoints.

---

## S3 — Dashboard on mocks

**Goal.** The complete analyst UI, working against MSW mocks that follow the shared API contract.

**Owns.** `packages/web/**`.

**Build.**

1. Design system (ARCHITECTURE §11): dark-first SOC console with a light theme; severity tokens with WCAG AA contrast that never rely on color alone; monospace for raw logs; table, badge, card, drawer and empty/loading/error components.
2. Pages:
   - Overview: KPI cards, events and alerts over time, alerts by level, top source IPs and users, latest alerts.
   - Alerts: filterable table with bulk acknowledge; detail page with summary, ATT&CK techniques (linked to attack.mitre.org), entities, timeline of related events, rule panel showing author, rule link and license (DRL), status and resolution actions, and an empty "Playbook" panel reserved for S7.
   - Events: search by time range, source, host, user, IP, action, outcome and free text; keyset pagination; detail drawer with normalized fields and the raw message.
   - ATT&CK: tactic columns × technique cells colored by alert count, with a toggle for rule coverage; a cell links to the filtered alerts list.
   - Rules: table with level, techniques, status, origin, supported/unsupported with reason and match count; detail with the YAML source.
   - Ingest: upload a log file with source/host selection through `POST /api/ingest/upload`, a `curl` example for `POST /api/ingest` with a bearer token, results of the last uploads.
3. Live updates from `/api/stream` (Server-Sent Events): toast plus alerts list refresh; mocked in development with a fake event source.
4. i18n: every string in `en` and `es` (neutral Latin American Spanish); dates and numbers formatted with the selected locale; a test fails when a key is missing in either language.
5. MSW handlers and fixtures built from the shared schemas: at least 200 events and 30 alerts across levels, sources and techniques, including hostile strings (`<script>`, `' OR 1=1--`, very long lines).

**Acceptance.**

- Every page renders with mocks without console errors (tested); tables and the drawer are keyboard-navigable (tested).
- Layouts are responsive from 360 px to 1440 px with Tailwind breakpoints; jsdom cannot prove layout, so the summary lists the manual checks David should do at 360, 768 and 1440 px.
- Component tests for: alert filtering, alert status change, events filters synced with the URL, ATT&CK cell linking to filtered alerts, i18n key parity, SSE toast, hostile strings rendered as text.
- No `dangerouslySetInnerHTML` anywhere (a lint rule enforces it).
- `npm run build -w packages/web` emits no chunk above 500 kB (pages are code-split).

**Not in S3.** Real API calls; the typed client exists and S4 switches the mocks off.

---

## S4 — Integration, persistence and end-to-end detection

**Depends on.** S1, S2 and S3 merged.

**Owns.** `packages/server/src/routes/**`, `packages/server/src/db/**` (except `events-write.ts`), `packages/server/src/pipeline/**`, `packages/server/src/realtime/**`, `packages/web/src/api/**`, `scripts/demo.*`.

**Build.**

1. PostgreSQL `AlertSink` with transactional deduplication, queries for every endpoint in ARCHITECTURE §9 (keyset pagination, filters, full-text search on `message`, time buckets with `date_bin`), rule enable/disable.
2. Wire the pipeline: ingest → parse → sort by event time → store events → detect → upsert alerts → publish SSE.
3. Replace every `501` stub with a real handler validated with zod, with consistent problem+json errors.
4. `npm run demo`: generate data with loggen (fixed seed), migrate, ingest everything, print a detection summary.
5. End-to-end detection test: loggen `--small` through the real pipeline and a real database; every scenario in `samples/ground-truth.json` produces its expected alerts; prints `detected X/Y scenarios`.
6. Web uses the real API by default (mocks only in tests or with `VITE_USE_MOCKS=true`), with error and empty states.

**Acceptance.**

- End-to-end: 100% of ground-truth scenarios detected; background traffic produces at most 2 alerts of level `high` or `critical`.
- API tests for every endpoint: happy path, validation errors, pagination edges.
- `docker compose up -d` followed by `npm run demo` gives a populated dashboard; README lists the exact commands.

---

## S5 — Windows Sysmon support

**Depends on.** S4. Runs in parallel with S6.

**Owns.** `packages/server/src/parsers/sysmon/**`, Windows parts of `packages/loggen/**`, `rules/centinela/windows/**`.

**Build.** Sysmon ingestion as JSON lines, accepting both the nested `Event.EventData` shape used in `rules/sigma/regression/` and a flat shape (ARCHITECTURE §4.4; the regression files themselves are pretty-printed and some hold several objects, so the golden test reads them with a streaming decoder before feeding events one per line). Event IDs 1 (process creation), 3 (network connection) and 11 (file creation) with their Sigma logsources. Windows scenarios in loggen (encoded PowerShell, certutil download, rundll32/mshta/regsvr32 abuse, scheduled task creation, a credential-dumping tool command line, Office application spawning PowerShell) with ground truth. Golden tests that push the regression samples through parse → detect. The ATT&CK view shows the new techniques.

**Acceptance.** At least 95% of regression samples are detected through the full pipeline; every Windows scenario is detected in the end-to-end test.

---

## S6 — Authentication, hardening and threat model

**Depends on.** S4. Runs in parallel with S5.

**Owns.** `packages/server/src/auth/**`, `packages/server/src/security/**`, middleware wiring in `packages/server/src/app.ts`, `packages/web/src/features/auth/**`, `docs/THREAT_MODEL.md`, `docs/SECURITY.md`, new migrations for auth tables.

**Build.** Single admin login (argon2id, `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` from the environment, `npm run hash-password`), server-side sessions in PostgreSQL, `__Host-centinela` session cookie (httpOnly, `sameSite=strict`, and always `Secure`: browsers reject a `__Host-` cookie without it, and they accept `Secure` cookies on `http://localhost`), CSRF double-submit on state-changing requests including `POST /api/ingest/upload` (which now requires the session), login rate limiting with temporary lockout, ingest tokens stored hashed with create/revoke API and UI, audit log of analyst actions (alert status changes, token changes, logins), Content Security Policy and security headers, `npm run audit` (`npm audit --audit-level=high`). `docs/THREAT_MODEL.md` with a data-flow diagram, trust boundaries, a STRIDE table, the mitigations for attacker-controlled log content (XSS, SQL injection, ReDoS, log injection) and residual risks.

**Acceptance.** Tests for login, logout, lockout, CSRF rejection, token revocation, `401` on every protected route without a session (table-driven), CSP header present on HTML responses.

---

## S7 — Content pack in the product

**Depends on.** S4 and the files in `content/sigma/` produced by `tools/content-pack` (David runs it locally with his API key).

**Owns.** `content/**` (input; only pruning allowed), `packages/server/src/content/**`, `packages/web/src/features/alerts/playbook/**`, `docs/content-pack-report.md`.

**Build.** Load the content pack at startup; `GET /api/rules/:id/playbook?lang=es|en`; render the playbook (summary, what it detects, why it matters, triage steps, false positives, response steps) in the alert and rule detail pages with an "AI-generated — review before use" label and the DRL attribution. Validate every fixture through the engine: positives must match, negatives must not. Write `docs/content-pack-report.md`, move failing fixtures to `content/sigma-rejected/` with the reason, and turn passing fixtures into a regression suite that runs in `npm test`.

**Acceptance.** Playbooks visible for alerts whose rule has content, in both languages; the fixture pass rate is reported; the regression suite runs in under 30 seconds.

---

## S7b — Dashboard polish

**Depends on.** S7. Runs alone, before S8, because S8 takes the README screenshots and deploys the public demo.

**Owns.** `packages/web/**` (touch `src/api/**` only to fix a bug), `docs/screenshots/**`.

**Goal.** The dashboard works; make it look like a product a SOC team would choose. No new features and no API changes.

**Build.**

1. Start from the real thing: run `npm run demo`, sign in, and capture every page at 360, 768 and 1440 px, in both themes and both languages. Write down what looks weak.
2. Before coding, write a short design plan in `docs/decisions/S7b.md`: four to six named colours, the typefaces and their roles, the layout of the Overview, and the one element that should be memorable. Check it against the subject (a SOC console named Centinela, "sentinel", for analysts who triage alerts for hours) and revise whatever would fit any generic dashboard: identical rounded cards with the same shadow, gradient washes, all-caps labels above headings, monospace for ordinary labels, a near-black background with one neon accent.
3. Apply the plan through the design tokens in `src/index.css`: a type scale with tabular numbers, a spacing scale, radii that follow hierarchy, a severity palette that never relies on colour alone and passes WCAG AA in both themes, and chart colours that match. Fonts are self-hosted, with no requests to other origins, so S6's Content Security Policy stays strict. Monospace is for raw logs, ids and code only.
4. Brand: a simple Centinela mark as inline SVG, a matching favicon, and a sign-in page that looks finished.
5. The Overview is the demo's first screen: a clear reading order, KPI cards with a trend, charts whose axis labels fit (S4 found four-digit counts cut off), and latest alerts that invite a click.
6. Every other page: tables (density, sticky headers, right-aligned numbers, truncation that shows the full value on hover and focus), the alert detail page and its playbook panel, the ATT&CK matrix without ids flashing before the technique names, rules, the events drawer, ingest, security and sign-in. Empty, loading and error states say what to do next; focus is always visible; motion only answers an action and respects `prefers-reduced-motion`.
7. Known gaps: show Windows users as `DOMAIN\name` from `user.domain` and `user` (S5), and give the audit table's columns sensible widths (S6).
8. Copy: plain and in sentence case, with the same name for an action everywhere, in English and neutral Latin American Spanish.
9. Save the final screenshots as optimised PNGs in `docs/screenshots/` for S8: Overview, Alerts, an alert with its playbook, ATT&CK and sign-in at 1440 px in the dark theme, plus the Overview in the light theme and at 360 px.

**Acceptance.** Every page reviewed in a real browser against the demo data, with no console errors and no CSP violations, and the summary describes what changed on each page; the contrast, i18n parity, hostile-string and keyboard tests still pass; the largest chunk stays under 500 kB; the full check sequence passes in a fresh clone on two CPUs.

---

## S8 — Documentation and local quick start

**Depends on.** S5, S6, S7 and S7b. Runs alone, as the last session; David's instructions let it update the status table above.

**Owns.** `README.md`, `README.es.md`, `docs/**` (except other sessions' sections of PLAN and DECISIONS); `.env.example`, `docker-compose.yml` and `scripts/` where the quick start needs them; `packages/server` and `packages/shared` for the cookie fix and its tests; `packages/web` only where it reads the CSRF cookie.

**Goal.** Centinela is presented through its README and run locally. There is no public demo: no hosting configuration (Render, Fly.io or any other provider), no `docs/DEPLOY.md`, no demo mode. The blog post is David's.

**Build.**

1. The quick start is the acceptance test: from a fresh clone, with Node 22 and Docker on Windows (WSL), macOS or Linux, at most three commands lead to a dashboard full of demo alerts, then a sign-in with the documented development credentials. Nothing may race PostgreSQL's start-up (`docker compose up -d --build --wait`), and the README quotes what `npm run demo` prints (19/19 scenarios).
2. Safari sign-in over plain HTTP: `__Host-` cookies must be `Secure`, which WebKit refuses on `http://localhost` (S7b-18). Keep `__Host-` and `Secure` over HTTPS and always with `NODE_ENV=production`; relax them only for plain-HTTP development on localhost; the dashboard keeps finding the CSRF cookie in both modes. Tests for both modes, and a sign-in check in WebKit and Chromium.
3. `README.md` and `README.es.md` (neutral Latin American Spanish), for a recruiter with 30 seconds and an engineer who checks the claims: what Centinela is, the Overview screenshot and a GIF recorded from the real app (under 8 MB, 30 to 60 seconds), an honest scope, highlights with evidence and links (Sigma engine, detection quality, content pack, security by design, engineering practice), a Mermaid diagram from a log line to an alert on screen, the quick start, sign-in, scripts, ingest tokens, production refusals and running it on your own server (TLS, HSTS, `TRUST_PROXY`, secrets, no provider-specific files), testing, a roadmap with the known gaps from the decision files, and credits (SigmaHQ under DRL 1.1 with the rules the content pack could not cover, MITRE ATT&CK, the Atkinson Hyperlegible fonts under the SIL OFL, the AI-generated label on every playbook). An HTML comment marks where David adds the dataset repository later.
4. `docs/DETECTION.md`: the engine's design, supported and unsupported Sigma features, correlation semantics, the prefilter, benchmark numbers with the machine they came from, and how detection quality is measured.
5. Reuse `docs/screenshots` and retake only what no longer matches the UI.

**Acceptance.** The quick start run from a fresh clone, end to end, with its output quoted; every number in the docs comes from the repository and every link works; screenshots match the current UI; the full check sequence passes in a fresh clone on two CPUs.

---

## Phase 1 — real ingestion (version 0.2)

The path from version 0.1 to 1.0 is in [ROADMAP.md](ROADMAP.md). These sessions are its first phase and build against the contracts in [ARCHITECTURE.md](ARCHITECTURE.md) §16. S9 (the rule lint, `docs/decisions/S9.md`) and the sessions below enter the status table when David adds them.

| Session | Title | Depends on | Can run with | Reviewed |
| --- | --- | --- | --- | --- |
| S10 | Roadmap and phase 1 contracts | S9 | alone | — |
| S11 | Ingest v2 | S10 | S13, S15 (not S12) | yes |
| S12 | Live detection | S10 | S13, S15 (not S11) | yes |
| S13 | Windows event log | S10 | S11 or S12, S15 | — |
| S14 | Add a host with Fluent Bit | S11, S12, S13 | S16, S17 | yes |
| S15 | Sysmon for Linux and journald | S10 | S11 or S12, S13 | — |
| S16 | Syslog receiver | S11, S12 | S14, S17 | yes |
| S17 | Microsoft 365 connector | S11, S12 | S14, S16 | yes |

Rules for every session of this phase, on top of `CLAUDE.md`:

1. **The contract is ARCHITECTURE §16.** Build what it says. When you build a part, move it into the sections it belongs to (§2.3, §3, §4, §6, §8, §9, §12, §15) and delete it from §16 in the same pull request. If building shows a detail is wrong, change it, record why in your decision file and update §16.
2. **Migrations** take the next free number when you branch. If `main` gained a migration while you worked, renumber yours when you merge `main`.
3. **S11 and S12 run one after the other,** in either order: both change `packages/server/src/pipeline/types.ts`, `packages/server/src/ingest/router.ts` and `packages/shared`. The second one merges `main` first. Sessions that add a source type (S13, S15, S16, S17) each add one member to `SourceType` and one entry to the parser registry; the one that merges second resolves that line.
4. **Reviewed sessions** are checked by a second session, with the prompt below, before David merges them. Its findings are fixed on the same branch.
5. **Real captures.** A session that parses what a shipper or a device sends builds its samples from the documented format and says in its summary which captures David should record. David records them on his machines, sanitizes them with `npm run captures:sanitize` (S14 builds it) and adds them in a follow-up pull request. The repository is public: never commit a raw capture. User names, host names, SIDs, addresses and paths under a user's profile become stable placeholders first.
6. **Gates.** Every demo scenario is detected (19 today), the SigmaHQ regression samples keep their match rate, `npm run rules:lint` reports nothing new, and the full check sequence passes in a fresh clone on two CPUs. A session that changes rule or scenario counts updates the numbers in the READMEs and in `docs/DETECTION.md`; that is the only README change it makes.

### Prompt for a review session

```text
Read CLAUDE.md, docs/PLAN.md and docs/ARCHITECTURE.md, then review the branch of session S<N>. You did not write this code: look for flaws, do not add features.
Check it against its acceptance criteria and against the security requirements in CLAUDE.md. For input from the network, tokens, sessions or isolation between organizations, try to break it: write the failing test first.
Fix what you find on the same branch, each fix with its regression test, record it in docs/decisions/S<N>-review.md, run the full check sequence and push. End with the list of findings and what you could not check.
```

---

## S10 — Roadmap and phase 1 contracts

**Depends on.** S9. Runs alone.

**Owns.** `docs/ROADMAP.md`, this part of `docs/PLAN.md`, `docs/ARCHITECTURE.md` §16, `docs/decisions/S10.md`, one bullet in the known gaps of `docs/DETECTION.md` and one in the residual risks of `docs/THREAT_MODEL.md`, `LICENSE`, `NOTICE`, `CONTRIBUTING.md`, and the roadmap and license lines of the two READMEs.

**Build.** The roadmap from 0.1 to 1.0 by phase; the sessions of phase 1 in this file; the contracts they share (organizations, ingest v2, streams, ordering of live events, the detector checkpoint, the new sources, hosts and system alerts, configuration); `LICENSE` reduced to the MIT text so GitHub recognizes it, with the note about the vendored rules moved to `NOTICE`; a contribution guide.

**Acceptance.** The full check sequence passes; every number comes from the repository; every relative link resolves; `LICENSE` is the MIT text and nothing else.

---

## S11 — Ingest v2

**Depends on.** S10. Runs before or after S12, not with it. Reviewed.

**Owns.** `packages/server/src/ingest/**`, `packages/server/src/auth/ingest-tokens.ts` and the token routes, `packages/server/src/security/rate-limit.ts`, the `input` kind of each parser in `packages/server/src/parsers/`, `packages/server/src/detection/event-view.ts`, `packages/web/src/features/auth/IngestTokensCard.tsx`, the token schemas in `packages/shared`, one migration, the token and ingest parts of `docs/SECURITY.md`.

**Goal.** A shipper can send compressed batches all day, is told to wait when the server is behind, and can only write for the sources and hosts its token names.

**Build.** ARCHITECTURE §16.2:

1. `Parser.input` and NDJSON decoding by input kind. Remove gap S5-09.
2. `Content-Encoding: gzip` with the limit on the decoded size, and `413` without buffering past it.
3. Scoped tokens: the two columns, the check on the request and on each line's own host, the API, the form in the dashboard (English and Spanish), the audit entry.
4. Rate limits per token, per client address for requests without a valid token, and `503` with `Retry-After` when more than `INGEST_MAX_PENDING` requests wait.
5. Field names without regard to ASCII case in the matcher, with the bench before and after in the decision file. `npm run rules:lint` treats `Image` and `image` as one field.
6. Remove the two closed gaps from `docs/DETECTION.md` and the READMEs, and narrow "token holders write anything" in `docs/THREAT_MODEL.md`.

**Acceptance.**

- A table of tests for NDJSON decoding: each JSON value against a `line` and an `object` source; a Sysmon object with a `message` key is parsed.
- gzip: a valid body, a truncated one, one that inflates past the limit (refused without reading it whole), and an unsupported encoding (`415`).
- Tokens: a request or a line outside the scope is refused and counted; an unscoped token and `INGEST_TOKEN` behave as before; the prefix pattern is tested with hostile input and never reaches a regex.
- Limits: two tokens behind one address do not share a budget; the `503` carries `Retry-After` and is sent before the body is read.
- Field names: a Windows rule matches an event whose keys are lower-cased; with two keys that differ only by case the exact one wins; the SigmaHQ regression samples and the demo are unchanged; the Windows bench loses less than 5%.

**Not in S11.** Shipper configuration and the hosts page (S14), streams and `ack` (S12), the shapes shippers give to Windows events (S13).

---

## S12 — Live detection

**Depends on.** S10. Runs before or after S11, not with it. Reviewed.

**Owns.** `packages/server/src/pipeline/**`, `packages/server/src/detection/engine.ts`, `packages/server/src/detection/correlation/**`, new modules in `packages/server/src/db/` for streams and the checkpoint, the stream and `ack` wiring in `packages/server/src/ingest/router.ts` and the CLI, start-up and shutdown in `packages/server/src/index.ts` and `shutdown.ts`, the new variables in `packages/server/src/config.ts`, `IngestSummary` and `DEFAULT_TENANT_ID` in `packages/shared`, one migration, the correlation and known-gap parts of `docs/DETECTION.md`, the future-timestamp bullet of `docs/THREAT_MODEL.md`.

**Goal.** The same events produce the same alerts whatever order several machines deliver them in, a timestamp from the future cannot blind a correlation, and a restart loses no window.

**Build.** ARCHITECTURE §16.1 and §16.3 to §16.5:

1. The migration: `tenants` with its default row, `ingest_streams`, `events.stream_id`, `detector_checkpoints`.
2. Streams: the registry, the counters updated once per ingest call, the bound per token.
3. Detection time, the future bound and the reorder buffer with its horizon, idle release and size bound. The clock is injected; the engine itself still never reads it.
4. Late events: evaluated on arrival and counted.
5. `ack=evaluated` and `ack=stored`, `IngestSummary.pending` and `late`, `Pipeline.drain()` for the CLI and the demo.
6. The checkpoint: a versioned snapshot of correlation state and the buffer, written on clean shutdown and on a timer, restored at start, followed by the events after its position.
7. `docs/DETECTION.md` explains ordering, late events and restarts with the measured numbers; `docs/decisions/S12.md` records what D-003 means from now on.

**Acceptance.**

- **Order.** For the demo data, small and full, the reference run (ARCHITECTURE §16.4) gives a set of alerts. Each stream is then cut into batches of one to five seconds of event time and delivered in a seeded shuffle that keeps every stream's own order and delays no batch by more than the window. For at least 20 seeds the alerts are identical to the reference run: rule, dedup key, first and last seen, count and linked events.
- **Late events.** A batch delayed past the window is evaluated, counted in its stream and in the summary, and the run reports that it was not exact.
- **Future timestamps.** The two cases S10 reproduced become regression tests: an event dated years ahead is rejected, and one dated minutes ahead neither silences its group nor evicts open windows.
- **Idle release and the bound,** with fake timers: a quiet system evaluates within `REORDER_IDLE_MS`; a full buffer releases its oldest events and counts them.
- **Clean restart.** The demo stopped after a seeded number of batches, restored and continued gives the alerts of the uninterrupted run.
- **Crash.** Without the final checkpoint, every alert of the uninterrupted run exists and no alert is duplicated; only counts may be higher, by no more than the matches of one checkpoint interval.
- **A rule changed between runs** loses its own state and nothing else.
- `npm run demo` still detects every scenario, and its time is reported before and after.

**Not in S12.** Token scopes (S11), the hosts page (S14), several evaluating processes, absence conditions (S24).

---

## S13 — Windows event log

**Depends on.** S10. Can run with S11 or S12 and with S15.

**Owns.** `packages/server/src/parsers/windows/**` (the Sysmon parser moves here), its registry entry, `packages/server/src/db/logsources.ts`, `SourceType` in `packages/shared`, new folders under `rules/sigma/` with their regression samples and `rules/sigma/README.md` (never the rule files), `rules/centinela/windows/**`, new files in `rules/correlation/`, `rules/lint-baseline.json`, the Windows part of `packages/loggen`, `docs/rules-report.md`.

**Goal.** The Windows Security log and the rest of Sysmon's events reach the engine with the field names Sigma rules expect, so a much larger part of SigmaHQ applies.

**Build.** ARCHITECTURE §16.6:

1. `windows_event`: one parser that reads the provider and the event id and accepts the nested and flat shapes of §4.4 and Winlogbeat's. `sysmon` stays as a source type with today's behaviour.
2. Sysmon: every event id that has a category in the Sigma taxonomy, with its logsources. Check the table against the taxonomy in the Sigma specification and record any difference.
3. Security: sign-ins and their failures, explicit credentials, special privileges, process creation (4688, with the field names of pySigma's Windows audit pipeline), services and scheduled tasks, account and group changes, lockouts, audit policy changes and log clearing. Each gets an `action`, a `category` and an `outcome`.
4. Vendor the SigmaHQ folders for the categories now supported, from the commit already pinned in `rules/sigma/README.md`, with their regression samples. Run `npm run rules:lint` on them and add what it finds to the baseline with its upstream status; list the findings in the summary so David can decide what to send upstream.
5. Centinela's own rules for the Security log, mirroring the SSH family: failed sign-in (building block), brute force, brute force then success. Two more that alert on their own: the audit log was cleared, and an account was added to a local administrators group.
6. Demo scenarios with ground truth for each of them, and background Security events that fire none.

**Acceptance.**

- 95% or more of the regression samples match in every newly vendored folder that has them, reported by folder in `docs/rules-report.md`.
- Every SigmaHQ rule in the new folders loads; the ones the engine cannot compile are listed with their reason.
- The new scenarios are detected and the background fires nothing; the 19 earlier scenarios are unchanged.
- A Winlogbeat sample is parsed into the same event as its nested form.
- `npm run bench` for the Windows mix is reported before and after.

**Not in S13.** Fluent Bit's shape (S14), playbooks for the new rules (the content pack is David's to run), PowerShell beyond script block events.

---

## S14 — Add a host with Fluent Bit

**Depends on.** S11, S12 and S13. Can run with S16 and S17. Reviewed.

**Owns.** `packages/server/src/shippers/**`, `packages/server/src/monitors/**`, the hosts routes, `packages/web/src/features/hosts/**` and its page and navigation entry, the Fluent Bit shapes in the parsers, `scripts/captures/**`, the `Host` schemas and `Alert.ruleType` in `packages/shared`, one migration.

**Goal.** Connecting a machine takes one screen, and Centinela says when a machine stops sending.

**Build.** ARCHITECTURE §16.7:

1. The hosts page: each host with its sources, last signal, lag, events in the last 24 hours and status, in English and Spanish.
2. Add a host: choose the operating system and the sources, get a token scoped to that host and those sources, and a Fluent Bit configuration that sends NDJSON with gzip, `ack=stored` and TLS verification on. The screen links to Fluent Bit's official installation page and says how to verify the download. Centinela never downloads or runs an installer.
3. The configuration comes from one pure function with snapshot tests. Linux: the auth log and web access logs, with the raw line under `message`. Windows: the Security and Sysmon channels.
4. The shapes Fluent Bit gives to Windows events, from real captures.
5. The first monitor, `centinela-host-silent`, and the `system` rule type through the sink, the API and the alert pages.
6. `npm run captures:sanitize` and a short guide for recording a capture.

**Acceptance.**

- Sanitized captures from a real Fluent Bit on Linux and on Windows go from the ingest endpoint to stored events and, for the ones that should, to alerts.
- Snapshot tests of the configuration for each combination of system and sources; a hostile host name or URL is refused and never written into the file.
- The monitor, with an injected clock: a host past its limit raises one alert, a host with no limit never does, a host that returns stops being silent.
- The sanitizer replaces every user name, host name, SID and address in the samples with the same placeholder each time, and a test fails if a raw value survives.
- The new pages pass the i18n parity, hostile-string and keyboard tests.

**Not in S14.** journald (S15), syslog (S16), installing or updating the shipper for the user.

---

## S15 — Sysmon for Linux and journald

**Depends on.** S10. Can run with S11 or S12 and with S13.

**Owns.** `packages/server/src/parsers/sysmon-linux/**`, `packages/server/src/parsers/journald.ts`, their registry entries, `SourceType`, `rules/sigma/linux/process_creation`, `network_connection` and `file_event` with `rules/sigma/README.md`, `rules/lint-baseline.json`, the Linux part of `packages/loggen`, `docs/rules-report.md`.

**Goal.** Linux process, network and file events reach the engine, which opens SigmaHQ's Linux rules beyond the auth log.

**Build.** ARCHITECTURE §16.6:

1. `sysmon_linux`: the syslog line Sysmon for Linux writes, its XML read by a small parser for that one schema (no entities, no DOCTYPE, bounded depth and size), `EventData` names as Sigma fields.
2. `journald`: the JSON that `journalctl -o json` and Fluent Bit's systemd input produce, routed by `SYSLOG_IDENTIFIER` to the existing auth classification and to `sysmon_linux`.
3. Vendor SigmaHQ's Linux `process_creation`, `network_connection` and `file_event` folders from the pinned commit; lint them and extend the baseline.
4. The upstream bug in Sysmon for Linux (microsoft/Sysmon-Linux#253): a child of a thread other than the main one is logged with the thread id as its parent and no parent image or command line. `docs/DETECTION.md` explains it and `npm run rules:report` lists the vendored Linux rules that test `ParentImage` or `ParentCommandLine`, which that bug can keep from matching.
5. One demo scenario on a Linux server with ground truth.

**Acceptance.**

- Events from a real Sysmon for Linux, including a process started by a Java thread, are parsed; the parent fields of that one are empty, as logged.
- Hostile XML (entities, a DOCTYPE, deep nesting, a megabyte of attributes) is rejected in bounded time and memory.
- Every vendored Linux rule loads; the regression samples that exist match at 95% or more.
- journald lines for `sshd` and `sudo` give the same events as their auth.log form.

**Not in S15.** auditd, eBPF sources other than Sysmon, fixing the upstream bug.

---

## S16 — Syslog receiver

**Depends on.** S11 and S12. Can run with S14 and S17. Reviewed.

**Owns.** `packages/collector/**` (a new workspace: the root `package.json` gains one line), the `syslog` parser and one device parser in `packages/server/src/parsers/`, their registry entries, `SourceType`, a `collector` service in `docker-compose.yml`, `docs/SECURITY.md` and `docs/THREAT_MODEL.md` for the new boundary.

**Goal.** Firewalls, switches and anything else that only speaks syslog can send to Centinela, without that door becoming the weak point.

**Build.**

1. A collector that runs as its own process, possibly on another machine. It listens for syslog over TCP with TLS, plain TCP and UDP (the last two off by default), reads both framings of RFC 6587 and both header formats (RFC 3164 and RFC 5424), and forwards batches to `POST /api/ingest` with its own token and `ack=stored`.
2. Its configuration is one YAML file validated with zod: listeners with their allowed sender networks, and for each sender the source type, the time zone for timestamps without one, and the host name to use.
3. A bounded spool on disk: with the server down, lines wait and are sent in order when it returns; past the limit the oldest are dropped and counted.
4. Limits everywhere a sender chooses a size: line length, lines per second per sender, connections, idle time.
5. The `syslog` parser for any sender, and the parser of the firewall the first pilot uses. David names the device before the session; without a pilot, FortiGate.
6. The threat model for this boundary: UDP sources can be forged, so a UDP listener only accepts its configured networks and its events are marked as unauthenticated transport.

**Acceptance.**

- Framing: octet counting, line feeds, both in one connection, a frame cut in two packets, a length that lies, binary noise.
- TLS with certificates generated in the test: a valid client connects, a plain-text client is refused, a slow client is dropped.
- The spool: the server goes down and comes back, nothing is lost below the limit and nothing is sent twice; above it the loss is counted.
- End to end: an SSH brute force delivered through the collector raises the same alerts as the same lines from a file.
- A sender outside the allowed networks is ignored and counted.

**Not in S16.** Managing the collector from the dashboard, relays of relays, RELP.

---

## S17 — Microsoft 365 connector

**Depends on.** S11 and S12. Can run with S14 and S16. Reviewed.

**Owns.** `packages/server/src/connectors/**`, the `m365_audit` parser, the connector routes, `packages/web/src/features/connectors/**`, `rules/centinela/m365/**`, the connector schemas in `packages/shared`, one migration, `CONNECTOR_SECRET_KEY` in the configuration.

**Goal.** Sign-ins and administrative changes in Microsoft 365 reach Centinela without anyone exporting a file.

**Build.**

1. A connector framework: a `connectors` table (kind, name, settings, credentials encrypted with `CONNECTOR_SECRET_KEY`, position, last run, last error), a scheduler that polls on the wall clock with backoff, and a position saved in the same transaction as the events it covers.
2. The Microsoft 365 connector. Before building, read Microsoft's current documentation for the audit API, the permissions it needs and the licences that include it, and record what was chosen and why.
3. `m365_audit`: record types mapped to the logsources SigmaHQ's cloud rules use (ARCHITECTURE §16.6).
4. Centinela's rules for what small organizations are actually hit by: many failed sign-ins for one account, a sign-in after them, a mailbox rule that forwards mail outside, an administrator role granted, a second factor removed.
5. The dashboard: add a connector, test it, see its state and last error. Credentials are write-only.

**Acceptance.**

- Recorded pages of the API replayed through the connector: every record is stored once, across a restart in the middle and across a page that fails and is retried.
- Credentials never appear in an API response, a log line or the audit log; without `CONNECTOR_SECRET_KEY` connectors do not start, and production says why.
- Each rule has events that fire it and events that must not.
- A throttled or failing API backs off and shows its error; it never stops the rest of the pipeline.

**Not in S17.** Google Workspace, which follows as S17b on the same framework when a pilot uses it; AWS; writing anything back to Microsoft 365. This session needs a tenant where David is an administrator to record real pages. Without one it builds against the documented format and the connector stays marked experimental.
