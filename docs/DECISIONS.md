# Decisions

Short records of decisions that shape the code. This file holds the kit's decisions and whatever David folds in after merging. Build sessions never edit it: each session records its decisions in `docs/decisions/S<N>.md`, so parallel branches do not conflict.

Format: `## D-NNN — Title (date, session)` (sessions use `S<N>-NN` numbers) then context, decision and consequences in a few lines. Never rewrite an old entry; supersede it with a new one that says which entry it replaces.

## D-001 — Monorepo with npm workspaces (2026-10-25, kit)

One repository with `packages/shared`, `packages/server`, `packages/web` and `packages/loggen`. npm workspaces are built into npm, need no extra tooling and keep the shared zod schemas in one place for server, web and generator.

## D-002 — PostgreSQL with plain SQL, no ORM (2026-10-25, kit)

`pg` plus `node-pg-migrate` and hand-written, parameterized SQL in small query modules. Events keep normalized columns for common filters and a `jsonb` column for the rule-matching field view. Plain SQL keeps queries explicit, easy to review for injection, and easy to explain.

## D-003 — In-process detection on event time (2026-10-25, kit)

Rules are compiled once at startup and evaluated in memory as events arrive; correlation windows use event time, not wall-clock time. Replaying old log files therefore produces the same alerts as live ingestion, and tests are deterministic. Trade-off: a single process holds the correlation state; horizontal scaling is out of scope.

## D-004 — Sigma as the only rule format (2026-10-25, kit)

Single-event rules use the Sigma format; multi-event rules use the Sigma correlation specification (subset in ARCHITECTURE §6). A curated SigmaHQ subset is vendored under `rules/sigma/` (DRL 1.1, attribution shown in alerts). Centinela's own rules live in `rules/centinela/` and `rules/correlation/` under MIT. Using the community standard makes the coverage numbers meaningful and the rules portable.

## D-005 — Synthetic, seeded demo data with ground truth (2026-10-25, kit)

Demo and test data come from `packages/loggen`: deterministic for a given seed, free of licensing issues and personal data, and labeled with the scenario, technique and expected detections. This enables an end-to-end detection test ("detected X/Y scenarios") in CI.

## D-006 — English code and docs, bilingual UI (2026-10-25, kit)

Code, comments, commits and documentation are in English for a wider audience. The dashboard ships in English and Spanish (neutral Latin American Spanish), which is a differentiator for Spanish-speaking SOC teams.

## D-007 — Linear-time regex engine for rule regexes (2026-10-25, kit)

`|re` patterns run against attacker-controlled log content, so a backtracking engine is a ReDoS risk. Patterns compile with `re2-wasm`; rules whose regex RE2 cannot express are reported as unsupported. Fallback, if `re2-wasm` is unusable: native `RegExp` with a 4,096-character input cap and a static ReDoS check, recorded in a new entry.

## D-008 — Keyword lists are substring searches on the raw message (2026-10-25, kit)

Sigma keyword lists (values without a field) are matched case-insensitively as substrings of `message`, honoring wildcards inside the value. This matches how SigmaHQ's Linux and web keyword rules are written (for example `lnx_shell_susp_rev_shells.yml`).

## D-009 — Pull requests are squash-merged without AI attribution trailers (2026-10-25, kit)

`main` only changes through squash-merged pull requests with green CI. `.claude/settings.json` disables commit and PR attribution and the session link; sessions never force-push and update branches by merging `main`. Workflow files under `.github/workflows/` are changed only by David.

## D-010 — Correlation chaining; `generate` silences only Sigma building blocks (2026-10-25, kit)

"Brute force followed by a successful login" must not fire when a staff member mistypes a password and then logs in, so it chains on the brute-force correlation instead of on raw failures (Sigma correlation chaining, ARCHITECTURE §6). pySigma's `generate: false` silences every referenced rule, which would also silence the brute-force alert itself; Centinela applies `generate: false` only to referenced Sigma rules, so chained correlations keep alerting. Range conditions (`lt`, `lte`, `eq`) are out of scope for now.

## D-011 — Per-session decision files; David owns shared status (2026-10-25, kit)

Parallel sessions that append to the same file or edit adjacent table rows always conflict at merge time. Sessions therefore write `docs/decisions/S<N>.md`, never edit this file or the status table in `docs/PLAN.md`, and change `README.md` only when their build list says so (S0, S4, S8).
