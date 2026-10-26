import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { handlers } from '../src/mocks/handlers';

/** MSW intercepts every API call in tests; an unmocked request fails the test. */
export const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
});
afterAll(() => server.close());
