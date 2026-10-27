import type { Alert } from '@centinela/shared';
import { levelWeight } from '../../lib/levels';

/** Alerts most severe first, then most recent first: the Overview's "start with these". */
export function byUrgency(alerts: readonly Alert[]): Alert[] {
  return [...alerts].sort(
    (a, b) =>
      levelWeight(b.level) - levelWeight(a.level) ||
      Date.parse(b.lastSeen) - Date.parse(a.lastSeen),
  );
}
