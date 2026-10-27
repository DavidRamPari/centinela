/**
 * Writes the brand files in `public/brand/` from the same geometry the components draw
 * (`src/components/brand/`), so the files and the app can never drift apart:
 * `npx tsx packages/web/scripts/brand-assets.ts`. test/brand.test.ts checks the output.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { brandFiles } from '../src/components/brand/svg';

const dir = fileURLToPath(new URL('../public/brand/', import.meta.url));
for (const [name, svg] of Object.entries(brandFiles())) {
  writeFileSync(`${dir}${name}`, svg);
}
