/**
 * Fake `/api/stream` for development with mocks: every `intervalMs` a new alert is added to
 * the mock database and announced as `alert.created`, as the server's SSE hub would.
 */
import type { Alert } from '@centinela/shared';
import type { LiveSource } from '../features/live/live-source';
import type { MockDb } from './fixtures/build';
import { mulberry32, pick, uuidv7 } from './prng';

export function createMockLiveSource(
  getDb: () => MockDb,
  { intervalMs = 45_000, seed = 7 }: { intervalMs?: number; seed?: number } = {},
): LiveSource {
  const rng = mulberry32(seed);
  return (handlers) => {
    const opened = setTimeout(() => handlers.onOpen(), 0);
    const timer = setInterval(() => {
      const db = getDb();
      const template = pick(
        rng,
        db.alerts.filter((alert) => alert.level !== 'informational'),
      );
      const now = Date.now();
      const iso = new Date(now).toISOString();
      const alert: Alert = {
        ...template,
        id: uuidv7(now, rng),
        status: 'new',
        resolution: null,
        note: null,
        count: 1,
        firstSeen: iso,
        lastSeen: iso,
        createdAt: iso,
        updatedAt: iso,
      };
      db.alerts.unshift(alert);
      db.alertEvents.set(alert.id, db.alertEvents.get(template.id) ?? []);
      handlers.onMessage('alert.created', JSON.stringify(alert));
    }, intervalMs);
    return {
      close: () => {
        clearTimeout(opened);
        clearInterval(timer);
      },
    };
  };
}
