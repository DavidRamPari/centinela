/**
 * Copy buttons (S7b-17). `CopyButton` is a quiet icon button for a value someone will paste
 * into another tool (an IP address, a host, a user, a hash, an id). "Copied" shows in a
 * small label above the button for a moment and is announced; the label sits over the
 * value, so nothing moves.
 */
import { clsx } from 'clsx';
import { Check, Copy, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCopy, type CopyState } from '../../lib/use-copy';
import { Button, type ButtonProps } from './Button';

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
    <span className={clsx('relative inline-flex shrink-0 align-middle', className)}>
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
      <CopiedLabel state={state} />
    </span>
  );
}

/**
 * A labelled button that copies a longer value (a token secret, a command). It keeps its
 * label and width; the check icon and the same small "Copied" label confirm the copy.
 */
export function CopyTextButton({
  value,
  children,
  ...props
}: { value: string } & Omit<ButtonProps, 'onClick' | 'icon' | 'loading'>) {
  const { state, copy } = useCopy();
  return (
    <span className="relative inline-flex">
      <Button
        {...props}
        icon={state === 'copied' ? Check : state === 'failed' ? X : Copy}
        onClick={() => void copy(value)}
      >
        {children}
      </Button>
      <CopiedLabel state={state} />
    </span>
  );
}

/** "Copied" (or "Could not copy") over the end of the value, announced politely. */
function CopiedLabel({ state }: { state: CopyState }) {
  const { t } = useTranslation();
  return (
    <span
      role="status"
      className={clsx(
        state === 'idle'
          ? 'sr-only'
          : 'pointer-events-none absolute right-0 bottom-full z-20 mb-1 animate-fade-in rounded-badge border border-line-strong bg-raised px-1.5 py-0.5 text-caption font-semibold whitespace-nowrap',
        state === 'failed' ? 'text-danger' : 'text-fg',
      )}
    >
      {state === 'copied' ? t('common.copied') : state === 'failed' ? t('common.copyFailed') : ''}
    </span>
  );
}
