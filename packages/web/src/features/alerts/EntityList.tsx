import type { Entities } from '@centinela/shared';

/** Compact entity summary for tables: IPs first (monospace), then users. Text only. */
export function EntitySummary({ entities }: { entities: Entities }) {
  const items = [...entities.ips, ...entities.users];
  if (items.length === 0) return <span className="text-muted">—</span>;
  const shown = items.slice(0, 2);
  return (
    <span className="block max-w-[18rem] truncate font-mono text-xs" title={items.join(', ')}>
      {shown.join(', ')}
      {items.length > shown.length ? ` +${items.length - shown.length}` : ''}
    </span>
  );
}
