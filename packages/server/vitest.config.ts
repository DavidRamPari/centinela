import { defineProject } from 'vitest/config';
import { nodeSourceResolve } from '../../vitest.shared.js';

export default defineProject({
  ...nodeSourceResolve,
  test: {
    name: 'server',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Database tests create their own schema (test/helpers/db.ts) and may run in parallel.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
