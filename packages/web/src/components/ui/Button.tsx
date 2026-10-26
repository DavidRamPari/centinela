import { clsx } from 'clsx';
import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Readonly<Record<Variant, string>> = {
  primary: 'bg-accent text-accent-fg hover:opacity-90',
  secondary: 'border border-line bg-surface-2 text-fg hover:bg-surface',
  ghost: 'text-fg hover:bg-surface-2',
  danger: 'border border-danger text-danger hover:bg-surface-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5',
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
