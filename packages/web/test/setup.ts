import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { handlers, resetMockDb } from '../src/mocks/handlers';

/** MSW intercepts every API call in tests; an unmocked request fails the test. */
export const server = setupServer(...handlers);

// jsdom has no ResizeObserver; Recharts' responsive charts need one.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoopResizeObserver;

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  resetMockDb();
  if (typeof document === 'undefined') return; // a test file in the node environment
  cleanup();
  document.documentElement.classList.add('dark');
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
});
afterAll(() => server.close());
