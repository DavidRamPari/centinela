import { defineProject, mergeConfig } from 'vitest/config';
import { nodeSourceResolve } from '../../vitest.shared.js';
import viteConfig from './vite.config.js';

export default mergeConfig(
  viteConfig,
  defineProject({
    // vite.config.ts resolves workspace sources for the browser (jsdom) environment only.
    // Test files that opt into `@vitest-environment node` are resolved by the SSR resolver,
    // which also needs the source condition; without it `@centinela/shared` resolves to
    // `dist/`, which does not exist before `npm run build` (fresh checkouts, CI).
    ssr: nodeSourceResolve.ssr,
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
