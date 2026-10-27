import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export function DescriptionList({
  items,
  className,
}: {
  items: ReadonlyArray<{ term: string; value: ReactNode; key?: string }>;
  className?: string;
}) {
  return (
    <dl
      className={clsx(
        'grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-[minmax(8rem,max-content)_1fr] sm:gap-y-2.5',
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.key ?? item.term} className="contents">
          <dt className="text-muted">{item.term}</dt>
          <dd className="mb-2 min-w-0 break-words text-fg sm:mb-0">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
