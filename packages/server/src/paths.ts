import { fileURLToPath } from 'node:url';

/**
 * Repository root. This module sits at `packages/server/{src,dist}/paths.*`, three levels
 * below the root, both in development (tsx) and in the built output.
 */
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Root of the server package (`packages/server/`). */
export const serverPackageRoot = fileURLToPath(new URL('../', import.meta.url));
