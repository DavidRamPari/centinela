# Contributing to Centinela

Thanks for looking. Centinela is a small SIEM with a strict bar: detection has to be correct and explainable, and a security tool must not become the weak point. This page says what helps most and what a change needs before it can be merged.

## What helps

- **A log line Centinela reads wrong.** Open an issue with the line (sanitized, see below), the source it came from and what you expected. A failing test is even better.
- **A rule that should match and does not, or matches when it should not.** Include the event. If the rule is one of SigmaHQ's, see the section on rules.
- **A parser for a format you use.** Bring real samples; the parser comes with tests for each of them and for hostile input.
- **Spanish and English.** Every string in the dashboard exists in both. Corrections to either are welcome.
- **Documentation** that was wrong or unclear when you followed it.

For anything larger than a fix, open an issue first. The [roadmap](docs/ROADMAP.md) says where the project is going, and [PLAN.md](docs/PLAN.md) says what is being built now, so you can see whether your idea is already on the way.

## Good places to start

These are small and self-contained. The first four are known gaps listed in the README:

- The alerts table shows Windows users without their domain; the alert page already shows it.
- The Overview stops counting at "200+" new alerts; an exact count needs a small API change.
- Chart axis width is estimated from the label length instead of measured.
- Firefox has not been reviewed; Chromium and WebKit have.
- More message patterns for the Linux auth log, each with its test.

## Setting up

You need Node 22 and Docker (for PostgreSQL).

```bash
git clone https://github.com/DavidRamPari/centinela.git
cd centinela
npm ci
docker compose up -d --wait postgres
npm run db:migrate
npm test
```

To see it running with demo data, follow the quick start in the [README](README.md#quick-start).

## Before you open a pull request

Run what CI runs, in this order:

```bash
npm run lint
npm run typecheck
npm run db:migrate
npm test
npm run build
```

A change is ready when:

- It has tests. A bug fix comes with a test that fails without the fix.
- Input from outside is validated with zod where it enters: request bodies and query strings, uploaded files, rule YAML, environment variables.
- Log content is treated as hostile. It is never rendered as HTML, never put into SQL except as a parameter, never passed to a shell and never used as a regular expression.
- Detection stays deterministic: it uses the time of the events, never the clock of the server, and the same input gives the same alerts in the same order.
- Code, comments, commit messages and documentation are in English. Text the user sees goes through i18n, in English and Spanish.
- Commits follow Conventional Commits, for example:

  ```text
  fix(parsers): accept sshd lines without a port
  ```

- The pull request is small enough to review in one sitting and says how you checked it.

The design is in [ARCHITECTURE.md](docs/ARCHITECTURE.md) and the reasons behind it in [DECISIONS.md](docs/DECISIONS.md). If your change alters a contract (a type, an endpoint, a table), update the architecture in the same pull request.

## Rules

The files under `rules/sigma/` are copied unchanged from SigmaHQ under the Detection Rule License 1.1. Do not edit them here. If one of them is wrong:

1. Check it with the lint, which finds conditions that can never match:

   ```bash
   npm run rules:lint
   ```

2. Send the fix to [SigmaHQ](https://github.com/SigmaHQ/sigma). It reaches Centinela with the next update of the vendored rules.

Centinela's own rules live in `rules/centinela/` and `rules/correlation/`. A new rule comes with an event that fires it and one that must not.

## Sample logs

The repository is public. Before you paste a log line into an issue or commit a sample, replace real user names, host names, addresses, tokens and anything else that identifies a person or a network. Use the documentation ranges for addresses (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`).

## Security problems

Do not open a public issue for a vulnerability. Report it privately through GitHub's "Report a vulnerability" on the repository, as [SECURITY.md](docs/SECURITY.md#reporting-a-vulnerability) says.

## License

Centinela's code is under the [MIT License](LICENSE), and contributions are accepted under that same license. Third-party material and its terms are listed in [NOTICE](NOTICE).
