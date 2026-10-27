/**
 * Placeholders shaped like the content they stand for (docs/decisions/S7b.md, S7b-17). A
 * page draws them only while a query has no data yet, so the layout is in place before the
 * data arrives and nothing jumps; a refetch keeps the data on screen instead. Static text
 * (headings, labels, column headers) stays real; only the values are placeholders.
 *
 * The pulse is slow and low-contrast, and stops under prefers-reduced-motion. The shapes are
 * hidden from assistive technology; `LoadingRegion` announces the load once instead.
 */
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * A block of placeholder: give it a size with classes. `inline` sits on the text baseline
 * like an inline SVG, so it takes the same line box as the figure it stands for.
 */
export function Skeleton({ className, inline = false }: { className?: string; inline?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        inline ? 'inline-block align-baseline' : 'block',
        'animate-skeleton bg-skeleton',
        className,
      )}
    />
  );
}

/**
 * One line of text: as tall as the surrounding line box (`1lh`), with a bar a little
 * shorter than the type, so a placeholder row is exactly as tall as the row it becomes.
 */
export function SkeletonText({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className="flex h-[1lh] w-full items-center">
      <Skeleton className={clsx('h-[0.75em] rounded-badge', className ?? 'w-2/3')} />
    </span>
  );
}

/** Several lines of text, the last one shorter, like a paragraph. */
export function SkeletonLines({ lines, className }: { lines: number; className?: string }) {
  return (
    <span aria-hidden="true" className={clsx('flex flex-col', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <SkeletonText key={index} className={index === lines - 1 ? 'w-2/5' : 'w-full'} />
      ))}
    </span>
  );
}

/**
 * Wraps the placeholders of one loading area: busy for assistive technology, which hears
 * "Loading…" once instead of a list of empty shapes.
 */
export function LoadingRegion({
  label,
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" data-skeleton="" className={className}>
      <span role="status" className="sr-only">
        {label ?? t('common.loading')}
      </span>
      {children}
    </div>
  );
}
