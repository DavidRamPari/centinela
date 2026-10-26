import { defineProject, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

export default mergeConfig(
  viteConfig,
  defineProject({
    test: {
      name: 'web',
      environment: 'jsdom',
      setupFiles: ['./test/setup.ts'],
      include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
      // Without this, CSS imports (also `?raw`) are empty; test/theme.test.ts reads the tokens.
      css: { include: [/index\.css/] },
    },
  }),
);
