/** Help text for the generator CLI. */
export const HELP_TEXT = `centinela-loggen: seeded demo log generator for Centinela ("Andes Retail")

Usage:
  npm run loggen -- [options]

Options:
  --seed <n>        PRNG seed; the same seed gives byte-identical output (default 42)
  --days <n>        days of background traffic, 1 to 30 (default 3)
  --start <iso>     first timestamp, ISO 8601 (default 2026-10-20T00:00:00Z)
  --out <dir>       output folder (default samples)
  --small           a few minutes of traffic around each attack scenario (for tests)
  -h, --help        show this help

Output:
  <out>/<host>/auth.log, <out>/<host>/access.log and <out>/ground-truth.json
  (see docs/ARCHITECTURE.md §4.3). Hosts: bastion-01, web-01, web-02, db-01.
  auth.log uses RFC 3339 timestamps and access.log the nginx combined format, both in
  Lima time (UTC-05:00); ground truth is in UTC.

Ingest the output with, for example:
  npm run ingest -- --source linux_auth --host bastion-01 --file samples/bastion-01/auth.log
  npm run ingest -- --source nginx_access --host web-01 --file samples/web-01/access.log
`;
