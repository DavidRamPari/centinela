import type { ReactNode } from 'react';

export function DescriptionList({
  items,
}: {
  items: ReadonlyArray<{ term: string; value: ReactNode; key?: string }>;
}) {
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[minmax(8rem,auto)_1fr]">
      {items.map((item) => (
        <div key={item.key ?? item.term} className="contents">
          <dt className="text-xs font-medium text-muted sm:pt-0.5">{item.term}</dt>
          <dd className="min-w-0 break-words text-fg">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
