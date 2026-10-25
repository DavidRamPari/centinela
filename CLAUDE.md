# Centinela — instructions for Claude

Centinela is a lightweight, open-source SIEM. It ingests Linux auth logs and web server access logs (Windows Sysmon later), normalizes them, runs Sigma detection rules plus correlation rules, and shows alerts mapped to MITRE ATT&CK in a bilingual (English/Spanish) dashboard. It is a portfolio project: correctness, tests and security matter more than the number of features.

Read these before writing code:

- `docs/PLAN.md` — the session you were asked to run: goal, owned paths, build list, acceptance criteria.
- `docs/ARCHITECTURE.md` — data model, interfaces, rule-engine semantics, database schema, API contract.
- `docs/DECISIONS.md` and `docs/decisions/` — decisions already taken. Record yours in `docs/decisions/S<N>.md`; never silently reverse an earlier one.

## Stack

- Node 22, TypeScript (strict, ESM), npm workspaces: `packages/shared`, `packages/server`, `packages/web`, `packages/loggen`.
- Server: Express 5, `pg`, `node-pg-migrate`, `zod`, `yaml`, `pino`.
- Web: React 19, Vite, Tailwind CSS v4, React Router, TanStack Query, Recharts, i18next (`en`, `es`), MSW for mocks.
- Tests: Vitest everywhere, Supertest for HTTP, React Testing Library for UI.
- PostgreSQL 16: a local service in cloud sessions, Docker Compose on developer machines.
- `tools/content-pack` is a standalone Python tool. It is not part of the npm build; do not run it (it needs a paid API key).

## Commands (repo root)

- `npm ci` · `npm run lint` · `npm run typecheck` · `npm test` · `npm run build`
- `npm run db:migrate` (uses `DATABASE_URL`)
- `npm run dev` (server and web together)
- Cloud sessions: `scripts/cloud-session-start.sh` runs as a SessionStart hook. It starts PostgreSQL, creates the `centinela` role and database, and runs `npm ci` when the lockfile changed. If PostgreSQL is not running, run `bash scripts/cloud-session-start.sh`. Default `DATABASE_URL=postgres://centinela:centinela@localhost:5432/centinela`.

## Working rules

1. Stay inside the paths your session owns (`docs/PLAN.md`). If you must touch a shared file (root `package.json`, `package-lock.json`, `packages/shared`, `docs/ARCHITECTURE.md`), keep the change minimal and list it in your final summary.
2. Never push to `main` and never force-push. To bring `main` into your branch, merge it (no rebase). On a `package-lock.json` conflict: take `main`'s version, run `npm install`, commit.
3. Do not modify `.github/workflows/`. If CI needs a change, describe it in your summary.
4. Do not ask the user questions and do not stop to wait for approval. When something is ambiguous, pick the option most consistent with these docs, add a one-paragraph entry to `docs/decisions/S<N>.md` (your session's own file; create it), and keep going. Never edit `docs/DECISIONS.md` or the status table in `docs/PLAN.md`; parallel sessions editing the same lines conflict. David folds session decisions in and updates the table when he merges.
5. Commits: Conventional Commits in English (`feat(detection): ...`, `fix(parsers): ...`, `test(server): ...`), small and logical. No `Co-Authored-By`, `Generated with` or `Claude-Session` lines. Attribution is disabled in `.claude/settings.json`; never add it by hand, in commits or in PR descriptions.
6. Code, identifiers, comments, commit messages and docs in English. Every UI string goes through i18n with both `en` and `es`.
7. Add a dependency only to the workspace that uses it (`npm install <pkg> -w packages/<name>`). Prefer the libraries in `docs/ARCHITECTURE.md` §14; justify anything else in your `docs/decisions/S<N>.md`.

## Quality bar

- TypeScript strict. No `any`: parse unknown input with zod. No `@ts-ignore`/`@ts-expect-error` without a comment explaining why.
- Every parser, rule-engine feature and API endpoint has tests. Every bug fix comes with a regression test.
- Validate all external input at the boundary with zod: HTTP bodies and query strings, uploaded files, rule YAML, environment variables.
- The detection engine is deterministic: it uses event time, never the wall clock, and the same input produces the same alerts in the same order.
- Prefer small, pure functions and explicit types over clever abstractions. A reviewer should be able to explain every module in an interview.

## Security requirements

Centinela is a security tool; it must not become the weak point.

- Log content is attacker-controlled. Never render it as HTML (`dangerouslySetInnerHTML` is banned), never interpolate it into SQL (parameterized queries only), never pass it to a shell, never use it as a regex.
- Regexes from rules run against attacker-controlled input: use the linear-time engine described in `docs/ARCHITECTURE.md` §5.6, cap field length, and load rules only from the repository's `rules/` folder.
- HTTP: `helmet`, same-origin only (the Vite dev server proxies `/api`), JSON and text body limits, rate limiting on `/api/ingest` and `/api/auth/*`, bearer token for ingest, cookie session plus CSRF double-submit for the dashboard once auth exists (session S6).
- No secrets in the repository. Configuration comes from environment variables, documented in `.env.example`. Production refuses to start with development defaults for secrets.

## Sigma rules and licensing

- `rules/sigma/` is a vendored subset of SigmaHQ rules under the Detection Rule License 1.1 (`rules/sigma/LICENSE.Detection.Rules.md`). Never edit those files. Centinela's own rules go in `rules/centinela/` and `rules/correlation/`.
- DRL 1.1 requires that alerts produced by a SigmaHQ rule identify the rule's `author`. The rule metadata, the alert API and the alert UI must carry and show `author`, the link to the rule and the license.
- `data/mitre-attack/enterprise-attack.min.json` is the ATT&CK reference (tactics, techniques, names, URLs). Derive tactics from technique IDs with it; do not trust tactic tags alone.

## Definition of done (every session)

- `npm ci && npm run lint && npm run typecheck && npm test && npm run build` passes from a clean clone.
- Every acceptance criterion of your session in `docs/PLAN.md` is met and proven by tests or by a command whose output you quote in the summary.
- `README.md` changes only in the sessions whose build list mentions it (S0, S4, S8); other sessions put user-facing notes in their summary.
- Your branch is pushed. Your final message says: what you built, decisions you took, files outside your owned paths that you touched, exact commands David can run locally to verify, and known gaps.
