# Centinela — roadmap

Version 0.1 is a small SIEM that proves the core: it reads log files, normalizes them, runs 1,231 SigmaHQ rules plus its own rules and correlations, and shows deduplicated alerts mapped to MITRE ATT&CK in a bilingual dashboard. It works on files that someone uploads, for one account, on one machine.

Version 1.0 is a SIEM that a small organization, or the IT provider that looks after it, can install, connect to real machines and use every day. This document is the path between the two. The sessions of the phase in progress are specified in [PLAN.md](PLAN.md); the contracts they share are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Who it is for

Small and mid-sized organizations that have one or two IT people and no security team, and the IT providers that serve several of them. Centinela does not try to match the large platforms feature for feature. It aims to be the best choice for that group:

- Spanish first: dashboard, a response guide for each alert, and reports.
- Sigma rules that are checked before they run. The rule lint and the per-rule fixtures already found conditions that could never match, and SigmaHQ merged the fixes.
- One command to install it and one screen to connect a machine.
- Detection that can be explained: the same events always produce the same alerts.

## What does not change

- The quality bar in [CLAUDE.md](../CLAUDE.md): tests for every parser, rule-engine feature and endpoint, input validated at the boundary, no log content rendered as HTML, interpolated into SQL or used as a regex.
- Detection runs on event time and is deterministic (D-003). Phase 1 extends that guarantee to events that arrive out of order from several machines.
- Sigma is the only rule format (D-004).
- PostgreSQL is the only database (D-002) unless the measurements of phase 2 show it cannot hold the target load.

## How the work is organized

Each session is one branch and one pull request with its own paths, acceptance criteria and decision file, as in S0 to S9. Four rules are added for this stage:

1. **Contract before code.** A phase opens with a session that writes the data model, the endpoints and the decisions of that phase into the architecture. The other sessions build against that contract, so several can run in parallel.
2. **Independent review.** A session that touches authentication, isolation between organizations, input from the network or rules written by users is reviewed by a second session that did not write the code and only looks for flaws.
3. **Real data closes a phase.** Every phase ends with a run on real machines. A phase that only passes on generated data is not closed.
4. **Gates that cannot drop.** The 19 demo scenarios, the SigmaHQ regression samples, the rule lint without new findings, and the full check sequence in a fresh clone on two CPUs. The benchmark is measured again when a phase closes.

Each phase ends with a version tag and its release notes.

## Versions

| Version | Closed by | What someone can do with it |
| --- | --- | --- |
| 0.1 | S0 to S9 | Try the demo with generated data |
| 0.2 | Phase 1 | Connect their machines and see alerts as events arrive |
| 0.3 | Phase 2 | Keep months of history and search it |
| 0.4 | Phase 3 | Tune the noise, write their own rules and see their coverage |
| 0.5 | Phase 4 | Work incidents as a team, with notifications and reports |
| 0.8 | Phase 5 | Look after several organizations from one installation |
| 0.9 | Phase 6 | Install and operate it without help |
| 1.0 | Phase 6 and a stable pilot | Run it in production with backups, upgrades and a security review |

## Phase 1 — real ingestion (0.2)

**Goal.** Events arrive on their own, as they happen, from real machines, and detection gives the same result as it does with files.

Centinela does not ship its own agent. An agent is a privileged program on every machine of a customer: it has to be signed, updated and answered for. Centinela relies on Fluent Bit, which is open source and already reads the Windows event log and Linux files, and generates its configuration.

| Session | Builds | Checked by |
| --- | --- | --- |
| S10 | This roadmap and the contracts of phase 1 | Documents only; the check sequence stays green |
| S11 | Ingest v2: compressed batches, an answer that tells a shipper to retry later, tokens limited to their sources and hosts, field names matched without regard to case, JSON events delivered whole to their parser | One test per case; two documented gaps closed |
| S12 | Live detection: events out of order across machines, late events, a future-timestamp bound, correlation state that survives a restart | The demo with its arrival order shuffled gives the same alerts; a restart in the middle of a window still fires |
| S13 | The Windows event log: the Security log, more Sysmon events, and events as Winlogbeat ships them | 95% or more of the SigmaHQ regression samples of each new category |
| S14 | Add a host: a generated Fluent Bit configuration for Windows and Linux, each host with its last signal, an alert when one stops sending | Real captures from Windows and Linux go through the whole pipeline |
| S15 | Sysmon for Linux and journald, which open SigmaHQ's Linux process rules | Real events, including the parent-process bug reported upstream |
| S16 | Syslog over the network: TCP with TLS and UDP, in its own process, and the parser of the first pilot's firewall | Recorded traffic; hostile or oversized input does not bring it down |
| S17 | Microsoft 365 sign-in and audit events, then Google Workspace | The connector keeps its position and neither loses nor repeats events across a restart |

**Closes when** Centinela receives events for seven days in a row from a Windows machine, a Linux server and a third source (a firewall or Microsoft 365), the number of events sent equals the number stored, and alerts appear as the events arrive.

**Out of this phase.** An agent of its own, AWS and other clouds (they enter when a pilot needs them), and any response action on a host.

## Phase 2 — storage and search at scale (0.3)

**Goal.** Keep months of events from a real organization, search them in seconds, and delete or archive what is old. Measure first, change afterwards: a second storage engine enters only if the numbers ask for it.

| Session | Builds | Checked by |
| --- | --- | --- |
| S18 | Measurements: a generator at scale (10 and 100 million events), ingest rate, disk per million events, time of typical searches. The target of the phase comes from here | A capacity table with measured numbers and the machine they came from |
| S19 | Partitions by day, retention by policy, bulk loading, an index review, and the organization column on the remaining tables | Ingest is faster than today's 6,000 events/s; dropping a day is immediate; the migration runs on a database with data and loses nothing |
| S20 | A search language (field and value, and, or, not, wildcards, time range), saved searches, export, and the most frequent values of a field | Every query becomes parameterized SQL; hostile input tested; times measured on the database of S18 |
| S21 | Retro-hunt: run a Sigma rule over stored history | A rule gives the same matches live and over history |
| S22 | Archive: old days move to compressed files and come back by range | Archiving and restoring a day returns exactly the same events |
| S23 | Conditional: a second event store behind an interface | Only if S18 shows PostgreSQL cannot reach the target |

**Closes when**, with the database loaded to the target size, a search over the last 24 hours answers in under two seconds (S18 confirms or adjusts the figure), retention runs on its own and disk use is stable.

**Out of this phase.** High availability, replicas, free-text search over years.

## Phase 3 — stronger detection (0.4)

**Goal.** More rules that work, less noise, and context on every alert.

| Session | Builds | Checked by |
| --- | --- | --- |
| S24 | The whole Sigma correlation specification 2.1.0: `lt`, `lte`, `eq`, `neq`, sum, average and percentile, field aliases, and absence (a host that stops sending, a backup that did not run) | Tests at the boundary values of every operator and type; absence is evaluated on event time |
| S25 | Field mapping per source, as pySigma's processing pipelines do | More SigmaHQ rules apply without touching the parsers; the rules report says how many |
| S26 | Exceptions and tuning from the dashboard: exclusions with a reason, an author and an expiry date, severity overrides, a noise report | Every exception is audited; an expired one stops applying |
| S27 | Threat indicators: lists of addresses, domains and hashes matched during ingestion | A million indicators without slowing ingestion; the terms of each feed reviewed and recorded |
| S28 | Context: an inventory of hosts and users with their criticality, the country of an address, a risk score per entity | Each demo scenario groups under its entity |
| S29 | ATT&CK coverage by connected source: what can be detected today and which source is missing for the rest | The matrix changes when a source is connected or removed |
| S30 | Rules written in the dashboard: an editor with the lint, tested against sample events and history before they are enabled | A rule with an error cannot be enabled; the threat model is updated, because today rules only load from the repository |
| S31 | Updating SigmaHQ as a routine: one command brings the new version and runs the lint, the samples and the fixtures | The baseline empties of what upstream fixed; the subset grows to every category Centinela supports |

**Closes when** a pilot has run with the rules enabled for two weeks and a person can review the day's alerts in half an hour.

**Out of this phase.** Machine learning and behavioural anomaly detection, on purpose: rules that can be explained come first.

## Phase 4 — cases and response (0.5)

**Goal.** From looking at alerts to working them: who has it, what was done, who was told, what is kept as evidence.

| Session | Builds | Checked by |
| --- | --- | --- |
| S32 | Accounts per analyst and roles (administrator, analyst, read only) with a second factor | A table of tests: each role can do only its part on every endpoint; the audit log names the person |
| S33 | Cases: alerts grouped under a case with an owner, comments, a timeline and a classification on closing; time to acknowledge and to close | A demo scenario ends as a case with its full timeline |
| S34 | Notifications: email, Slack, Teams, Telegram and a signed webhook, with rules by severity and schedule, a queue with retries and a daily digest | With the destination down, a notification is retried and neither lost nor repeated |
| S35 | Reports: a weekly summary for management in Spanish and an incident report with its timeline and evidence | Generated from the demo data |
| S36 | Response: playbook steps as tasks of the case, and webhook actions approved by a person | No action runs without approval; each one is audited with who approved it |
| S37 | Optional: an AI summary of a case, with the customer's own key, off by default | Without a key nothing leaves the installation; the text carries the AI-generated label |

**Closes when** an incident, real or a drill, is handled from start to finish inside Centinela.

**Out of this phase.** Isolating hosts or stopping processes remotely, which needs a privileged agent.

## Phase 5 — several organizations and security (0.8)

**Goal.** An IT provider looks after several organizations from one installation and none can see another's data, and Centinela stands up to a serious security review.

| Session | Builds | Checked by |
| --- | --- | --- |
| S38 | Isolated organizations: every query filters by organization and PostgreSQL enforces it again with row-level security; tokens, rules, exceptions, retention and notifications per organization | A table of tests: no endpoint returns or changes another organization's data, even with guessed identifiers |
| S39 | The provider's console: one account sees several organizations and a single queue with their alerts | The provider role sees only the organizations assigned to it |
| S40 | Sign-in with Google and Microsoft, passkeys, recovery codes, session control | Tests of every flow, including attempts to skip the second factor |
| S41 | Hardening: the audit log written in the same transaction and chained so tampering shows, connector credentials encrypted, quotas per organization, API keys | Each residual risk of today's threat model is closed or explained |
| S42 | A full security review: a new threat model and a session that only attacks authentication, isolation and ingestion | A list of findings, each with its fix and regression test |

**Closes when** two test organizations share an installation, the review of S42 leaves no high finding open, and an outside person has run a penetration test before the first paying customer of a hosted version.

**Out of this phase.** Automatic billing and federation between installations.

## Phase 6 — packaging and operation (0.9 and 1.0)

**Goal.** Someone else installs it in an afternoon, upgrades it without fear and is told when something is wrong.

| Session | Builds | Checked by |
| --- | --- | --- |
| S43 | A production install in one command: containers with automatic TLS, a first-run wizard that creates the administrator, a configuration check | From a clean machine to the dashboard over HTTPS following only the guide |
| S44 | Versions and upgrades: release notes, an upgrade test from every earlier version, signed images, a bill of materials | An upgrade from 0.2 to the latest loses no data |
| S45 | Scheduled backups and an automatic restore test | A backup restored into an empty database has the same counts |
| S46 | Observability: metrics for ingest, lag, queue and rule time, a health page, and alerts about Centinela itself | Each failure is provoked and Centinela reports it |
| S47 | Documentation: install and user guides in Spanish and English, an API reference generated from the schemas | A person follows the guide alone and reaches the end |
| S48 | Sizing: hosts against CPU, memory and disk with the final measurements, and separate processes if needed | A load test at twice the target for 24 hours |

**Closes when** someone outside the project installs Centinela from the documentation alone, connects two machines and gets their first alert, and the pilot's installation has been upgraded twice without incident.

**Out of this phase.** Kubernetes, multi-node high availability and running a cloud service.

## Validation with users

In parallel with every phase: conversations with IT providers and people who run systems in mid-sized organizations, the author's own lab as the first installation once phase 1 closes, and one pilot organization during phases 2 and 3. What they ask for can reorder the sessions of phases 3 and 4.

## Left out on purpose

- An endpoint agent of Centinela's own.
- Machine learning and anomaly scores.
- Remote response on hosts.
- Kubernetes and multi-node deployments.
