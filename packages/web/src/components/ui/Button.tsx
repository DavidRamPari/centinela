/**
 * Buttons in four kinds with one height system (docs/decisions/S7b.md): primary (yellow:
 * the one thing to do here), secondary (blue outline), quiet (text only) and danger
 * (destructive, red). Every kind has hover, pressed, focus-visible, disabled and loading
 * states; loading keeps the colours, swaps the icon for a spinner and sets `aria-busy`.
 */
import { clsx } from 'clsx';
import { LoaderCircle, type LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary:
    'border-accent-edge bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-pressed',
  secondary: 'border-line-strong text-fg hover:border-line-hover hover:bg-hover active:bg-raised',
  quiet: 'border-transparent text-fg hover:bg-hover active:bg-raised',
  danger:
    'border-danger text-danger hover:bg-danger-fill hover:text-danger-fg active:bg-danger-fill active:text-danger-fg',
};

const DISABLED: Readonly<Record<ButtonVariant, string>> = {
  primary: 'border-transparent bg-disabled text-disabled-fg',
  secondary: 'border-transparent bg-disabled text-disabled-fg',
  quiet: 'border-transparent text-disabled-fg',
  danger: 'border-transparent bg-disabled text-disabled-fg',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  /** Leading icon; replaced by a spinner while `loading`. */
  icon?: LucideIcon;
  /** An action is running: the button keeps its look, ignores clicks and says it is busy. */
  loading?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  loading = false,
  disabled = false,
  className,
  type = 'button',
  children,
  ...props
}: ButtonProps) {
  const inactive = disabled && !loading;
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-control border font-semibold transition-colors duration-100',
        size === 'sm' ? 'h-8 px-2.5 text-small' : 'h-10 px-3.5 text-body',
        inactive
          ? clsx('cursor-not-allowed', DISABLED[variant])
          : clsx(VARIANTS[variant], loading ? 'cursor-progress' : 'active:translate-y-px'),
        className,
      )}
      {...props}
    >
      {loading ? (
        <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin" />
      ) : Icon ? (
        <Icon aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0" />
      ) : null}
      {children}
    </button>
  );
}
