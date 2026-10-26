# Centinela

A lightweight, open-source SIEM for small teams and for learning detection engineering. Centinela ingests Linux auth logs and web server access logs (Windows Sysmon next), normalizes them, runs Sigma detection rules and correlation rules, and shows alerts mapped to MITRE ATT&CK in a bilingual (English/Spanish) dashboard.

> **Status:** under active development (October–November 2026). Ingestion, detection, storage, the REST API, live updates and the dashboard work end to end on Linux auth and web access logs. Windows Sysmon (S5), authentication (S6) and investigation playbooks (S7) are next; see [docs/PLAN.md](docs/PLAN.md).

## What it does

- Parse Linux `auth.log` (sshd, sudo, account changes) and nginx/Apache access logs into normalized events.
- Evaluate 1,200+ SigmaHQ rules with a purpose-built engine: field modifiers, wildcards and the full condition grammar.
- Correlate events over time with the Sigma correlation format: SSH brute force, password spraying, brute force followed by a successful login, privileged account creation, web scanning bursts.
- Deduplicate matches into alerts with a triage workflow (acknowledge, close as true/false positive) and ATT&CK mapping.
- Show it all in a dashboard: overview, alerts, event search, ATT&CK heatmap and rule coverage, in English and Spanish.
- Prove detections with a seeded attack-scenario generator and an end-to-end test that checks every scenario is detected.

## Quick start

Requirements: Node.js 22 (`.nvmrc`), npm 10, and either Docker or a local PostgreSQL 16.

### Demo in three commands

```bash
npm ci
docker compose up -d --build      # postgres, API server and dashboard on http://localhost:8080
npm run demo                      # generate, ingest and detect: prints "detected 11/11 scenarios"
```

`npm run demo` generates three days of logs for the fictional company "Andes Retail" (seed 42, ending at the current hour, about 200,000 lines with eleven attack scenarios), applies the migrations, ingests every file through the detection pipeline into `DATABASE_URL` (the compose PostgreSQL on 127.0.0.1:5432 by default) and checks the alerts against the generator's ground truth. Open http://localhost:8080 and pick **Last 7 days** to see every scenario; the default view shows the last 24 hours. Running it again refuses to load a second copy: `npm run demo -- --reset` empties events and alerts first (rule enable/disable flags are kept).

### With Docker for PostgreSQL (recommended)

```bash
npm ci
docker compose up -d postgres     # PostgreSQL 16 on 127.0.0.1:5432
npm run db:migrate                # create the schema
npm test                          # every package; database tests use a throwaway schema
npm run dev                       # API on :3000, dashboard on http://localhost:5173
```

The development defaults match `.env.example`; copy it to `.env` only to change something.

### Without Docker

Install PostgreSQL 16 and create the role and database the defaults expect:

```bash
sudo -u postgres psql -c "CREATE ROLE centinela LOGIN PASSWORD 'centinela'"
sudo -u postgres createdb -O centinela centinela
npm ci && npm run db:migrate && npm run dev
```

Or point `DATABASE_URL` (in `.env` or the environment) at any PostgreSQL 16 database. Tests need a role that can create schemas in that database (its owner can).

### Whole stack in containers

```bash
docker compose up -d --build      # postgres, server (runs migrations) and web
# then browse to http://localhost:8080 (nginx serves the dashboard and proxies /api)
```

All ports bind to 127.0.0.1; change them with `POSTGRES_PORT`, `SERVER_PORT` and `WEB_PORT`. This stack runs with development secrets and is meant for local use only.

### Dashboard on mocks

```bash
VITE_USE_MOCKS=true npm run dev -w packages/web   # no API or database needed
```

## Scripts

Run from the repository root.

| Script | What it does |
| --- | --- |
| `npm run dev` | API server (watch mode, pretty logs) and Vite dev server together |
| `npm run build` | build `shared`, then `server`, `web` and `loggen` |
| `npm test` | Vitest across every package (needs PostgreSQL) |
| `npm run lint` | ESLint (type-aware) and Prettier check |
| `npm run typecheck` | `tsc` for every package |
| `npm run format` | Prettier write |
| `npm run db:migrate` | apply pending migrations to `DATABASE_URL`; a no-op when up to date |
| `npm run ingest -- --source <type> --host <name> --file <path>` | ingest a log file through the pipeline (events, detection and alerts in `DATABASE_URL`) |
| `npm run loggen -- [--small] [--seed n] [--out dir]` | generate seeded demo logs with ground truth (default `samples/`) |
| `npm run rules:report` | rule loading report, also written to `docs/rules-report.md` |
| `npm run bench` | detection engine benchmark |
| `npm run demo [-- --reset]` | generate, ingest and detect the demo data set and print a detection summary |

## API

The dashboard talks to a JSON API under `/api` (contract in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §9, schemas in `packages/shared/src/api.ts`): event search with full-text search and keyset pagination, alerts with triage, rules with enable/disable, overview statistics, the ATT&CK matrix and a Server-Sent Events stream of alert changes (`/api/stream`). Agents and scripts send log lines to `POST /api/ingest` with a bearer token (`INGEST_TOKEN`; at most 5 MB per request, `npm run ingest` streams larger files):

```bash
curl -X POST 'http://localhost:3000/api/ingest?source=linux_auth&host=bastion-01' \
  -H "Authorization: Bearer $INGEST_TOKEN" -H 'Content-Type: text/plain' \
  --data-binary @/var/log/auth.log
```

## Configuration

Environment variables are validated at start-up (`packages/server/src/config.ts`) and documented in [`.env.example`](.env.example). With `NODE_ENV=production` the server refuses to start with the development ingest token, a token shorter than 32 characters or the development database password.

## Tech

TypeScript · Node.js · Express · PostgreSQL · React · Vite · Tailwind CSS · Vitest

## Repository guide

| Path | Contents |
| --- | --- |
| `packages/shared` | zod schemas and types for events, alerts, rules and the HTTP API; ATT&CK helper |
| `packages/server` | Express API, ingestion pipeline, detection engine, migrations |
| `packages/web` | React dashboard (English and Spanish) |
| `packages/loggen` | seeded demo data generator with ground truth |
| `docs/PLAN.md` | build plan and status |
| `docs/ARCHITECTURE.md` | data model, rule-engine semantics, schema, API |
| `docs/DECISIONS.md`, `docs/decisions/` | design decisions |
| `rules/sigma/` | vendored SigmaHQ rules (DRL 1.1) and regression samples |
| `data/mitre-attack/` | compact MITRE ATT&CK reference data |
| `tools/content-pack/` | generator for bilingual investigation playbooks and rule test fixtures |

## Credits

- Detection rules in `rules/sigma/` come from [SigmaHQ](https://github.com/SigmaHQ/sigma) and are licensed under the [Detection Rule License 1.1](rules/sigma/LICENSE.Detection.Rules.md). Alerts produced by those rules show their authors.
- MITRE ATT&CK® data from [mitre/cti](https://github.com/mitre/cti). © The MITRE Corporation. This work is reproduced and distributed with the permission of The MITRE Corporation.

## License

Code: [MIT](LICENSE). Vendored Sigma rules: DRL 1.1 (see `rules/sigma/`).
