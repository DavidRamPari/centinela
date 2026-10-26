import type { AlertStatus, Level } from '@centinela/shared';
import { clsx } from 'clsx';
import {
  CircleArrowDown,
  CircleCheck,
  CircleDot,
  Eye,
  Info,
  OctagonAlert,
  ShieldAlert,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

const LEVEL_STYLE: Readonly<Record<Level, { className: string; icon: LucideIcon }>> = {
  informational: { className: 'bg-sev-informational text-sev-informational-fg', icon: Info },
  low: { className: 'bg-sev-low text-sev-low-fg', icon: CircleArrowDown },
  medium: { className: 'bg-sev-medium text-sev-medium-fg', icon: TriangleAlert },
  high: { className: 'bg-sev-high text-sev-high-fg', icon: ShieldAlert },
  critical: { className: 'bg-sev-critical text-sev-critical-fg', icon: OctagonAlert },
};

const badgeBase =
  'inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium';

/** Severity: icon plus text label, so it never relies on color alone (ARCHITECTURE §11). */
export function SeverityBadge({ level }: { level: Level }) {
  const { t } = useTranslation();
  const { className, icon: Icon } = LEVEL_STYLE[level];
  return (
    <span className={clsx(badgeBase, className)} data-level={level}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {t(`levels.${level}`)}
    </span>
  );
}

const STATUS_ICON: Readonly<Record<AlertStatus, LucideIcon>> = {
  new: CircleDot,
  acknowledged: Eye,
  closed: CircleCheck,
};

export function StatusBadge({ status }: { status: AlertStatus }) {
  const { t } = useTranslation();
  const Icon = STATUS_ICON[status];
  return (
    <span
      className={clsx(
        badgeBase,
        'border border-line',
        status === 'new' ? 'font-semibold text-fg' : 'text-muted',
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {t(`statuses.${status}`)}
    </span>
  );
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={clsx(badgeBase, 'border border-line bg-surface-2 text-fg', className)}>
      {children}
    </span>
  );
}
