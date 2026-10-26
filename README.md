# Centinela

A lightweight, open-source SIEM for small teams and for learning detection engineering. Centinela ingests Linux auth logs and web server access logs (Windows Sysmon next), normalizes them, runs Sigma detection rules and correlation rules, and shows alerts mapped to MITRE ATT&CK in a bilingual (English/Spanish) dashboard.

> **Status:** under active development (October–November 2026). The foundations are in place: monorepo, shared contracts, database schema, API skeleton and dashboard shell. Parsing, detection and the real dashboard views arrive in the next sessions; see [docs/PLAN.md](docs/PLAN.md).

## What it will do

- Parse Linux `auth.log` (sshd, sudo, account changes) and nginx/Apache access logs into normalized events.
- Evaluate 1,200+ SigmaHQ rules with a purpose-built engine: field modifiers, wildcards and the full condition grammar.
- Correlate events over time with the Sigma correlation format: SSH brute force, password spraying, brute force followed by a successful login, privileged account creation, web scanning bursts.
- Deduplicate matches into alerts with a triage workflow (acknowledge, close as true/false positive) and ATT&CK mapping.
- Show it all in a dashboard: overview, alerts, event search, ATT&CK heatmap and rule coverage, in English and Spanish.
- Prove detections with a seeded attack-scenario generator and an end-to-end test that checks every scenario is detected.

## Quick start

Requirements: Node.js 22 (`.nvmrc`), npm 10, and either Docker or a local PostgreSQL 16.

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
| `npm run ingest -- …` | ingest a log file through the pipeline (stub until S1) |
| `npm run loggen -- …` | generate seeded demo logs with ground truth (stub until S1) |
| `npm run rules:report` | rule loading report (stub until S2) |
| `npm run bench` | detection engine benchmark (stub until S2) |
| `npm run demo` | end-to-end demo (available after S4) |

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
