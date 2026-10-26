import { clsx } from 'clsx';
import type { ReactNode } from 'react';

interface CardProps {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Heading level of the title; pages use h1, so cards default to h2. */
  as?: 'h2' | 'h3';
}

export function Card({ title, actions, children, className, as: Heading = 'h2' }: CardProps) {
  return (
    <section className={clsx('rounded-lg border border-line bg-surface p-4', className)}>
      {title || actions ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title ? <Heading className="font-semibold text-fg">{title}</Heading> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function KpiCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-fg">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
