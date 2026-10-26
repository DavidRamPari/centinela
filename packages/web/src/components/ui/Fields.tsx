import { clsx } from 'clsx';
import { useId, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';

export const controlClass =
  'w-full rounded-md border border-line bg-surface px-2 py-1.5 text-fg placeholder:text-muted';

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
}

export function TextField({ label, hint, className, id, ...props }: TextFieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = hint ? `${inputId}-hint` : undefined;
  return (
    <div className={clsx('flex flex-col gap-1', className)}>
      <label htmlFor={inputId} className="text-xs font-medium text-muted">
        {label}
      </label>
      <input id={inputId} aria-describedby={hintId} className={controlClass} {...props} />
      {hint ? (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}

export function SelectField({ label, options, className, id, ...props }: SelectFieldProps) {
  const generated = useId();
  const selectId = id ?? generated;
  return (
    <div className={clsx('flex flex-col gap-1', className)}>
      <label htmlFor={selectId} className="text-xs font-medium text-muted">
        {label}
      </label>
      <select id={selectId} className={controlClass} {...props}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

interface ToggleChipsProps<T extends string> {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  selected: readonly T[];
  onChange: (next: T[]) => void;
}

/** Multi-select as a group of toggle buttons (`aria-pressed`). */
export function ToggleChips<T extends string>({
  label,
  options,
  selected,
  onChange,
}: ToggleChipsProps<T>) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted" aria-hidden="true">
        {label}
      </span>
      <div role="group" aria-label={label} className="flex flex-wrap gap-1">
        {options.map((option) => {
          const pressed = selected.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={pressed}
              onClick={() =>
                onChange(
                  pressed
                    ? selected.filter((value) => value !== option.value)
                    : options
                        .map((o) => o.value)
                        .filter((value) => value === option.value || selected.includes(value)),
                )
              }
              className={clsx(
                'rounded-full border px-2.5 py-0.5 text-xs',
                pressed
                  ? 'border-accent bg-accent text-accent-fg'
                  : 'border-line bg-surface text-fg hover:bg-surface-2',
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
