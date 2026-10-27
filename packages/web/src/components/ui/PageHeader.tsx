import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: ReactNode;
  /** The question the page answers, in one sentence. */
  description?: ReactNode;
  /** Small context above the title: a breadcrumb link, badges. */
  eyebrow?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, description, eyebrow, actions }: PageHeaderProps) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0 max-w-3xl">
        {eyebrow ? <div className="mb-2">{eyebrow}</div> : null}
        <h1 className="text-title font-semibold text-balance break-words text-fg">{title}</h1>
        {description ? <p className="mt-1.5 text-lead text-muted">{description}</p> : null}
      </div>
      {actions}
    </header>
  );
}
