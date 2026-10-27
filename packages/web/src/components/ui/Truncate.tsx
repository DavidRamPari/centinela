import { clsx } from 'clsx';

/**
 * A value cut with an ellipsis to fit its column. The full value shows in a tooltip on
 * hover and, when the table row has keyboard focus, the row expands to show it inline
 * (DataTable rows are a `group`). Screen readers always get the full text.
 */
export function Truncate({
  text,
  className,
  mono = false,
}: {
  text: string;
  /** Width limit, for example `max-w-[16rem]`. */
  className?: string;
  mono?: boolean;
}) {
  return (
    <span
      title={text.length > 500 ? `${text.slice(0, 500)}…` : text}
      className={clsx(
        'block truncate group-focus-visible:whitespace-normal group-focus-visible:break-all',
        mono && 'font-mono text-small',
        className,
      )}
    >
      {text}
    </span>
  );
}
