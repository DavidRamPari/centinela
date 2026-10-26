import type { Outcome } from '@centinela/shared';
import { clsx } from 'clsx';
import { CircleCheck, CircleHelp, CircleX } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const ICONS = { success: CircleCheck, failure: CircleX, unknown: CircleHelp } as const;

export function OutcomeLabel({ outcome }: { outcome: Outcome }) {
  const { t } = useTranslation();
  const Icon = ICONS[outcome];
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 whitespace-nowrap text-xs',
        outcome === 'failure'
          ? 'text-danger'
          : outcome === 'success'
            ? 'text-success'
            : 'text-muted',
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {t(`outcomes.${outcome}`)}
    </span>
  );
}
