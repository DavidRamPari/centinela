import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './paths.js';

/**
 * Load `<repo>/.env` into `process.env` when the file exists (local development).
 * Variables already set in the environment win, so containers and CI are unaffected.
 */
export function loadDotEnv(file: string = join(repoRoot, '.env')): void {
  if (existsSync(file)) process.loadEnvFile(file);
}
