/**
 * Form controls sharing one system: 35 px tall, blue control border, yellow focus ring, red
 * error state. Labels are full-size text, not small grey captions.
 */
import { clsx } from 'clsx';
import { Check, ChevronDown, Minus } from 'lucide-react';
import {
  useId,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

export const controlClass =
  'w-full rounded-control border border-line-strong bg-bg px-3 text-body text-fg placeholder:text-faint hover:border-link focus-visible:border-focus disabled:cursor-not-allowed disabled:border-dashed disabled:text-disabled-fg aria-invalid:border-danger';

export const labelClass = 'text-small font-semibold text-fg';

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
}

export function TextField({ label, hint, className, id, ...props }: TextFieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = hint ? `${inputId}-hint` : undefined;
  return (
    <div className={clsx('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={inputId} className={labelClass}>
        {label}
      </label>
      <input
        id={inputId}
        aria-describedby={hintId}
        className={clsx(controlClass, 'h-10')}
        {...props}
      />
      {hint ? (
        <p id={hintId} className="text-small text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: string;
}

export function TextArea({ label, hint, className, id, ...props }: TextAreaProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = hint ? `${inputId}-hint` : undefined;
  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <label htmlFor={inputId} className={labelClass}>
        {label}
      </label>
      <textarea
        id={inputId}
        aria-describedby={hintId}
        className={clsx(controlClass, 'py-2')}
        {...props}
      />
      {hint ? (
        <p id={hintId} className="text-small text-muted">
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
    <div className={clsx('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={selectId} className={labelClass}>
        {label}
      </label>
      <div className="relative">
        <select
          id={selectId}
          className={clsx(controlClass, 'h-10 cursor-pointer appearance-none pr-9')}
          {...props}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          strokeWidth={1.75}
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted"
        />
      </div>
    </div>
  );
}

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Visible label; without it, pass `aria-label`. */
  label?: string;
  indeterminate?: boolean;
}

/** A drawn checkbox: blue box, yellow fill and black check when checked. */
export function Checkbox({ label, indeterminate = false, className, ...props }: CheckboxProps) {
  const box = (
    <span className="relative inline-grid size-[18px] shrink-0 place-items-center">
      <input
        type="checkbox"
        ref={(element) => {
          if (element) element.indeterminate = indeterminate;
        }}
        className="peer absolute inset-0 m-0 cursor-pointer appearance-none rounded-badge border border-line-strong bg-bg checked:border-accent-edge checked:bg-accent indeterminate:border-accent-edge indeterminate:bg-accent hover:border-link disabled:cursor-not-allowed disabled:border-dashed"
        {...props}
      />
      <Check
        aria-hidden="true"
        strokeWidth={3}
        className="pointer-events-none relative hidden size-3.5 text-accent-fg peer-checked:block peer-indeterminate:hidden"
      />
      <Minus
        aria-hidden="true"
        strokeWidth={3}
        className="pointer-events-none relative hidden size-3.5 text-accent-fg peer-indeterminate:block"
      />
    </span>
  );
  if (!label) return <span className={clsx('inline-flex', className)}>{box}</span>;
  return (
    <label className={clsx('inline-flex cursor-pointer items-center gap-2 text-body', className)}>
      {box}
      {label}
    </label>
  );
}

interface ToggleChipsProps<T extends string> {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  selected: readonly T[];
  onChange: (next: T[]) => void;
}

/** Multi-select as a group of toggle buttons (`aria-pressed`); pressed chips are yellow. */
export function ToggleChips<T extends string>({
  label,
  options,
  selected,
  onChange,
}: ToggleChipsProps<T>) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className={labelClass} aria-hidden="true">
        {label}
      </span>
      <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
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
                'inline-flex h-8 items-center gap-1.5 rounded-control border px-2.5 text-small font-semibold transition-colors duration-100 active:translate-y-px',
                pressed
                  ? 'border-accent-edge bg-accent text-accent-fg hover:bg-accent-hover'
                  : 'border-line-strong text-fg hover:border-link hover:bg-hover',
              )}
            >
              {pressed ? <Check aria-hidden="true" strokeWidth={2.5} className="size-3.5" /> : null}
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface SegmentedProps<T extends string> {
  label: string;
  /** Show the label above the control (default) or only to assistive technology. */
  showLabel?: boolean;
  options: ReadonlyArray<{ value: T; label: string; lang?: string; title?: string }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

/** One choice out of a few, as pressed buttons; the selected one is yellow. */
export function Segmented<T extends string>({
  label,
  showLabel = true,
  options,
  value,
  onChange,
  className,
}: SegmentedProps<T>) {
  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      {showLabel ? (
        <span className={labelClass} aria-hidden="true">
          {label}
        </span>
      ) : null}
      <div
        role="group"
        aria-label={label}
        className="inline-flex w-fit rounded-control border border-line-strong p-0.5"
      >
        {options.map((option) => {
          const pressed = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              lang={option.lang}
              title={option.title}
              aria-pressed={pressed}
              onClick={() => onChange(option.value)}
              className={clsx(
                'h-8 rounded-badge px-3 text-small font-semibold transition-colors duration-100',
                pressed
                  ? 'bg-selected text-fg ring-1 ring-accent-edge ring-inset'
                  : 'text-muted hover:bg-hover hover:text-fg',
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
