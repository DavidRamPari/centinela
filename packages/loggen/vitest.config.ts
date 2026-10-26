import { defineProject } from 'vitest/config';
import { nodeSourceResolve } from '../../vitest.shared.js';

export default defineProject({
  ...nodeSourceResolve,
  test: {
    name: 'loggen',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
