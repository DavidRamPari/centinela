import { defineConfig } from 'vitest/config';

// `npm test` at the root runs every workspace; each package keeps its own config.
export default defineConfig({
  test: {
    projects: ['packages/*'],
  },
});
