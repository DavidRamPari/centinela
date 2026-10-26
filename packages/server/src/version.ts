import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { serverPackageRoot } from './paths.js';

const packageJsonSchema = z.object({ version: z.string().min(1) });

/** Version of `@centinela/server`, read once from its package.json. */
export const version: string = packageJsonSchema.parse(
  JSON.parse(readFileSync(join(serverPackageRoot, 'package.json'), 'utf8')),
).version;
