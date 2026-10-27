import type { Outcome } from '@centinela/shared';
import { clsx } from 'clsx';
import { CircleCheck, CircleHelp, CircleX } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const ICONS = { success: CircleCheck, failure: CircleX, unknown: CircleHelp } as const;

/** Outcome shape: a check, a cross or a question mark; the label carries the meaning. */
export function OutcomeIcon({ outcome, className }: { outcome: Outcome; className?: string }) {
  const Icon = ICONS[outcome];
  return (
    <Icon
      aria-hidden="true"
      strokeWidth={2}
      className={clsx(
        'size-4 shrink-0',
        className ?? 'self-center',
        outcome === 'success' && 'text-ok',
        outcome === 'failure' && 'text-warn',
        outcome === 'unknown' && 'text-muted',
      )}
    />
  );
}

export function OutcomeLabel({ outcome }: { outcome: Outcome }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-fg">
      <OutcomeIcon outcome={outcome} />
      {t(`outcomes.${outcome}`)}
    </span>
  );
}
