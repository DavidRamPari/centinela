import { clsx } from 'clsx';

/** Raw, attacker-controlled text (log lines, YAML): monospace, wrapped, rendered as text. */
export function CodeBlock({
  text,
  className,
  label,
}: {
  text: string;
  className?: string;
  label?: string;
}) {
  return (
    <pre
      aria-label={label}
      tabIndex={0}
      className={clsx(
        'max-h-[32rem] overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-surface-2 p-3 font-mono text-xs text-fg',
        className,
      )}
    >
      {text}
    </pre>
  );
}
