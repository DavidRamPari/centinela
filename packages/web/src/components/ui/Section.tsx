import { clsx } from 'clsx';
import type { ReactNode } from 'react';

interface SectionProps {
  title?: ReactNode;
  /** One sentence under the title saying what the section is for. */
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Heading level; pages use h1, so sections default to h2. */
  as?: 'h2' | 'h3';
  /**
   * Frame the section (a quiet grey outline). Use it once per page, for the area that
   * answers the page's question (docs/decisions/S7b.md); other sections stay open.
   */
  framed?: boolean;
  /** A blue hairline above the section, to separate it from the one before. */
  divider?: boolean;
  id?: string;
}

/** A titled area of a page: structure from type, spacing and lines, not from a grey box. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  as: Heading = 'h2',
  framed = false,
  divider = false,
  id,
}: SectionProps) {
  return (
    <section
      id={id}
      className={clsx(
        'flex min-w-0 flex-col gap-4',
        framed && 'answer-frame p-4 md:p-6',
        divider && 'border-t border-line pt-6',
        className,
      )}
    >
      {title || actions ? (
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            {title ? <Heading className="text-lead font-semibold text-fg">{title}</Heading> : null}
            {description ? <p className="mt-0.5 text-muted">{description}</p> : null}
          </div>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}
