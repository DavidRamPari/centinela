import type { AlertPublisher } from './types.js';

/** Default publisher until S4 adds the SSE hub in `src/realtime/`. */
export const noopPublisher: AlertPublisher = {
  publish() {
    // Intentionally empty.
  },
};
