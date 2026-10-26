/** Help text for the generator CLI. Session S1 implements generation (docs/PLAN.md). */
export const HELP_TEXT = `centinela-loggen: seeded demo log generator for Centinela ("Andes Retail")

Usage:
  npm run loggen -- [options]

Options:
  --seed <n>        PRNG seed; the same seed gives byte-identical output (default 42)
  --days <n>        days of background traffic (default 3)
  --start <iso>     first timestamp, ISO 8601 (default 2026-10-20T00:00:00Z)
  --out <dir>       output folder (default samples)
  --small           a few minutes of traffic around each attack scenario (for tests)
  -h, --help        show this help

Output:
  <out>/<host>/auth.log, <out>/<host>/access.log and <out>/ground-truth.json
  (see docs/ARCHITECTURE.md §4.3).

Status: generation is not implemented yet; session S1 implements it.
`;
