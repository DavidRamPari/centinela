import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { msw } from 'msw/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { browserSourceResolve } from '../../vitest.shared.js';

/** One `.env` for the whole repository (see .env.example). */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** Where the dev server forwards `/api` (same-origin for the browser, CLAUDE.md). */
const apiTarget =
  process.env.API_PROXY_TARGET ??
  loadEnv('', repoRoot, 'API_').API_PROXY_TARGET ??
  'http://localhost:3000';

export default defineConfig({
  // `worker-only` serves mockServiceWorker.js on the dev server only (never in a production
  // build); src/main.tsx starts the worker when VITE_USE_MOCKS=true.
  plugins: [react(), tailwindcss(), { ...msw({ mode: 'worker-only' }), apply: 'serve' }],
  ...browserSourceResolve,
  // Only VITE_* variables reach the browser bundle.
  envDir: repoRoot,
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: apiTarget },
    },
  },
  build: {
    sourcemap: true,
    rolldownOptions: {
      output: {
        // Stable vendor chunks: better caching and every chunk below the 500 kB budget.
        codeSplitting: {
          groups: [
            {
              name: 'react',
              test: /node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/,
              priority: 3,
            },
            {
              name: 'charts',
              test: /node_modules[\\/](recharts|d3-[a-z-]+|victory-vendor)[\\/]/,
              priority: 2,
            },
            { name: 'vendor', test: /node_modules[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
});
