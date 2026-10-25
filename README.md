# Centinela

A lightweight, open-source SIEM for small teams and for learning detection engineering. Centinela ingests Linux auth logs and web server access logs (Windows Sysmon next), normalizes them, runs Sigma detection rules and correlation rules, and shows alerts mapped to MITRE ATT&CK in a bilingual (English/Spanish) dashboard.

> **Status:** under active development (October–November 2026). The roadmap and progress live in [docs/PLAN.md](docs/PLAN.md).

## What it will do

- Parse Linux `auth.log` (sshd, sudo, account changes) and nginx/Apache access logs into normalized events.
- Evaluate 1,200+ SigmaHQ rules with a purpose-built engine: field modifiers, wildcards and the full condition grammar.
- Correlate events over time with the Sigma correlation format: SSH brute force, password spraying, brute force followed by a successful login, privileged account creation, web scanning bursts.
- Deduplicate matches into alerts with a triage workflow (acknowledge, close as true/false positive) and ATT&CK mapping.
- Show it all in a dashboard: overview, alerts, event search, ATT&CK heatmap and rule coverage, in English and Spanish.
- Prove detections with a seeded attack-scenario generator and an end-to-end test that checks every scenario is detected.

## Tech

TypeScript · Node.js · Express · PostgreSQL · React · Vite · Tailwind CSS · Vitest

## Repository guide

| Path | Contents |
| --- | --- |
| `docs/PLAN.md` | build plan and status |
| `docs/ARCHITECTURE.md` | data model, rule-engine semantics, schema, API |
| `docs/DECISIONS.md` | design decisions |
| `rules/sigma/` | vendored SigmaHQ rules (DRL 1.1) and regression samples |
| `data/mitre-attack/` | compact MITRE ATT&CK reference data |
| `tools/content-pack/` | generator for bilingual investigation playbooks and rule test fixtures |

## Credits

- Detection rules in `rules/sigma/` come from [SigmaHQ](https://github.com/SigmaHQ/sigma) and are licensed under the [Detection Rule License 1.1](rules/sigma/LICENSE.Detection.Rules.md). Alerts produced by those rules show their authors.
- MITRE ATT&CK® data from [mitre/cti](https://github.com/mitre/cti). © The MITRE Corporation. This work is reproduced and distributed with the permission of The MITRE Corporation.

## License

Code: [MIT](LICENSE). Vendored Sigma rules: DRL 1.1 (see `rules/sigma/`).
