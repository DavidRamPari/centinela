import type { Alert, NormalizedEvent } from '@centinela/shared';

/**
 * A user as an analyst expects to read it: Windows accounts as `DOMAIN\name` from the
 * Sysmon parser's `user.domain` field (S5), everything else as the bare name.
 */
export function displayUser(event: Pick<NormalizedEvent, 'user' | 'fields'>): string | undefined {
  if (!event.user) return undefined;
  const domain = event.fields['user.domain'];
  return typeof domain === 'string' && domain !== '' ? `${domain}\\${event.user}` : event.user;
}

/** `user → DOMAIN\user` for the users seen in a set of events. */
export function userDomains(events: readonly NormalizedEvent[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const event of events) {
    const shown = displayUser(event);
    if (event.user && shown && !names.has(event.user)) names.set(event.user, shown);
  }
  return names;
}

/** The entity that best identifies who or what is behind an alert: a user, else an IP. */
export function primaryEntity(alert: Pick<Alert, 'entities'>): string | undefined {
  return alert.entities.users[0] ?? alert.entities.ips[0];
}
