import type { AlertStatus, Level } from '@centinela/shared';
import { levelWeight } from '../../lib/levels';
import { clsx } from 'clsx';
import { CircleCheck, Eye } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

const PIP_COLOR: Readonly<Record<Level, string>> = {
  informational: 'bg-sev-informational',
  low: 'bg-sev-low',
  medium: 'bg-sev-medium',
  high: 'bg-sev-high',
  critical: 'bg-sev-critical',
};

/**
 * Five pips, as many filled as the level's weight: severity reads as a quantity, so a
 * column of levels is a bar chart even without colour (docs/decisions/S7b.md).
 */
export function LevelPips({ level, size = 'md' }: { level: Level; size?: 'md' | 'lg' }) {
  const filled = levelWeight(level);
  return (
    <span aria-hidden="true" className={clsx('inline-flex', size === 'lg' ? 'gap-1' : 'gap-0.5')}>
      {[1, 2, 3, 4, 5].map((pip) => (
        <span
          key={pip}
          className={clsx(
            'rounded-[1px]',
            size === 'lg' ? 'h-3.5 w-1.5' : 'h-3 w-1',
            pip <= filled ? PIP_COLOR[level] : 'bg-sev-off',
          )}
        />
      ))}
    </span>
  );
}

/** Severity: pips plus the level's name; never colour alone (ARCHITECTURE §11). */
export function SeverityBadge({ level, size = 'md' }: { level: Level; size?: 'md' | 'lg' }) {
  const { t } = useTranslation();
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-2 whitespace-nowrap font-semibold',
        size === 'lg' ? 'text-body' : 'text-small',
        level === 'critical' ? 'text-sev-critical' : 'text-fg',
      )}
      data-level={level}
    >
      <LevelPips level={level} size={size} />
      {t(`levels.${level}`)}
    </span>
  );
}

/**
 * Alert status. New is bright and bold; acknowledged takes the deep "frightened" blue (the
 * one arcade touch, S7b-05); closed steps back.
 */
export function StatusBadge({ status }: { status: AlertStatus }) {
  const { t } = useTranslation();
  const label = t(`statuses.${status}`);
  if (status === 'new') {
    return (
      <span
        data-status={status}
        className="inline-flex items-center gap-1.5 whitespace-nowrap text-small font-semibold text-fg"
      >
        <span aria-hidden="true" className="size-2 rounded-full bg-fg" />
        {label}
      </span>
    );
  }
  if (status === 'acknowledged') {
    return (
      <span
        data-status={status}
        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-badge bg-frightened px-2 py-0.5 text-small font-semibold text-frightened-fg"
      >
        <Eye aria-hidden="true" strokeWidth={2} className="size-3.5 shrink-0" />
        {label}
      </span>
    );
  }
  return (
    <span
      data-status={status}
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-small text-muted"
    >
      <CircleCheck aria-hidden="true" strokeWidth={1.75} className="size-3.5 shrink-0" />
      {label}
    </span>
  );
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-badge border border-line-strong px-1.5 py-0.5 text-small text-fg',
        className,
      )}
    >
      {children}
    </span>
  );
}
