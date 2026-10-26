/**
 * zod compiles object parsers with `new Function` unless `jitless` is set, and probes for it
 * first. The dashboard's Content Security Policy has no `'unsafe-eval'`, so the probe would
 * only produce CSP violation reports (S6). Imported first by `main.tsx`, before any parse.
 */
import { z } from 'zod';

z.config({ jitless: true });
