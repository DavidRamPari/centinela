import { clsx } from 'clsx';
import { CircleAlert, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';

export type StatusTone = 'ok' | 'warn' | 'pending';

/**
 * One line of system status: a shape plus text, never colour alone. OK is a cyan dot, a
 * problem an orange warning icon, a pending check a spinner.
 */
export function StatusLine({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-small text-fg">
      {tone === 'ok' ? (
        <span aria-hidden="true" className="mx-1 size-2 shrink-0 rounded-full bg-ok" />
      ) : tone === 'warn' ? (
        <CircleAlert aria-hidden="true" strokeWidth={2} className="size-4 shrink-0 text-warn" />
      ) : (
        <LoaderCircle
          aria-hidden="true"
          strokeWidth={2}
          className={clsx('size-4 shrink-0 animate-spin text-muted')}
        />
      )}
      <span className={tone === 'warn' ? 'text-warn' : undefined}>{children}</span>
    </span>
  );
}
