/**
 * Copy buttons (S7b-17, S7b-18). `CopyButton` is a quiet icon button for a value someone
 * will paste into another tool (an IP address, a host, a user, a hash, an id).
 *
 * The confirmation never covers anything: "Copied" (or "Not copied") appears in a slot
 * next to the button that is always as wide as the longest message, so it neither overlaps
 * the page nor moves it. `CopyTextButton` swaps its own label in place the same way.
 */
import { clsx } from 'clsx';
import { Check, Copy, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCopy, type CopyState } from '../../lib/use-copy';
import { Button, type ButtonProps } from './Button';

const STACK = 'col-start-1 row-start-1';

export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  /** Accessible name; defaults to "Copy <value>". */
  label?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const { state, copy } = useCopy();
  const name = label ?? t('common.copyValue', { value });
  const Icon = state === 'copied' ? Check : state === 'failed' ? X : Copy;
  return (
    <span className={clsx('inline-flex shrink-0 items-center gap-1 align-middle', className)}>
      <button
        type="button"
        aria-label={name}
        title={name}
        onClick={() => void copy(value)}
        className="grid size-7 place-items-center rounded-control text-muted transition-colors duration-100 hover:bg-hover hover:text-fg active:translate-y-px active:bg-pressed"
      >
        <Icon
          aria-hidden="true"
          strokeWidth={2}
          className={clsx(
            'size-3.5',
            state === 'copied' && 'text-ok',
            state === 'failed' && 'text-danger',
          )}
        />
      </button>
      <CopyStatus state={state} />
    </span>
  );
}

/**
 * "Copied" or "Not copied" beside the button. Both messages sit in one grid cell, so the
 * slot is as wide as the longer one whether or not a message shows; the visible one is a
 * polite live region.
 */
function CopyStatus({ state }: { state: CopyState }) {
  const { t } = useTranslation();
  const copied = t('common.copied');
  const failed = t('common.copyFailed');
  return (
    <span className="inline-grid text-caption font-semibold whitespace-nowrap" data-copy-status="">
      <span aria-hidden="true" className={clsx(STACK, 'invisible')}>
        {copied}
      </span>
      <span aria-hidden="true" className={clsx(STACK, 'invisible')}>
        {failed}
      </span>
      <span role="status" className={clsx(STACK, state === 'failed' ? 'text-danger' : 'text-ok')}>
        {state === 'idle' ? null : (
          <span key={state} className="animate-fade-in">
            {state === 'copied' ? copied : failed}
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * A labelled button that copies a longer value (a token secret, a command). Its label turns
 * into "Copied" for a moment; the button is always as wide as its longest label, so the
 * swap moves nothing.
 */
export function CopyTextButton({
  value,
  label,
  ...props
}: { value: string; label: string } & Omit<
  ButtonProps,
  'onClick' | 'icon' | 'loading' | 'children'
>) {
  const { t } = useTranslation();
  const { state, copy } = useCopy();
  const labels: Record<CopyState, string> = {
    idle: label,
    copied: t('common.copied'),
    failed: t('common.copyFailed'),
  };
  return (
    <span className="inline-flex">
      <Button
        {...props}
        aria-label={label}
        icon={state === 'copied' ? Check : state === 'failed' ? X : Copy}
        onClick={() => void copy(value)}
      >
        <span aria-hidden="true" className="inline-grid">
          {(Object.keys(labels) as CopyState[]).map((key) => (
            <span key={key} className={clsx(STACK, key !== state && 'invisible')}>
              {labels[key]}
            </span>
          ))}
        </span>
      </Button>
      <span role="status" className="sr-only">
        {state === 'idle' ? '' : labels[state]}
      </span>
    </span>
  );
}
