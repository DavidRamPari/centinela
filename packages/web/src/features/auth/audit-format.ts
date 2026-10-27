import type { AuditAction, AuditEntry } from '@centinela/shared';

type Underscored<S extends string> = S extends `${infer Head}.${infer Tail}`
  ? `${Head}_${Tail}`
  : S;

/** Translation key of an action (`alert.triage` → `alert_triage`; i18next nests on dots). */
export function actionKey<A extends AuditAction>(action: A): Underscored<A> {
  return action.replace('.', '_') as Underscored<A>;
}

/** `key=value` pairs; JSON for anything that is not a string. Rendered as text. */
export function formatDetails(details: AuditEntry['details']): string {
  return Object.entries(details)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
}

/** Alerts and rules link to their pages; other targets are plain ids. */
export function targetLink(entry: AuditEntry): string | undefined {
  if (!entry.target) return undefined;
  if (entry.action === 'alert.triage') return `/alerts/${encodeURIComponent(entry.target)}`;
  if (entry.action === 'rule.update') return `/rules/${encodeURIComponent(entry.target)}`;
  return undefined;
}
