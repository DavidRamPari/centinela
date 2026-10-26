import type { AlertPublisher } from './types.js';

/** Default publisher; the server passes its SSE hub (`src/realtime/hub.ts`) instead. */
export const noopPublisher: AlertPublisher = {
  publish() {
    // Intentionally empty.
  },
};
