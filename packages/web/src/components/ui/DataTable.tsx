/**
 * Accessible data table: rows are a roving tab stop (one row in the tab order), arrow keys,
 * Home and End move between rows, Enter opens the focused row (ARCHITECTURE §11).
 * Clicking a row opens it too, unless the click hit a control inside the row.
 *
 * Headers stick to the top of the window while the page scrolls (from 768 px; narrower
 * screens scroll the table sideways instead). Columns hide by container width. A focused row expands its truncated values
 * (`Truncate`), so keyboard users see what a mouse user sees in the tooltip.
 *
 * `TableSkeleton` draws the same table with placeholder rows for the first load, so the
 * headers and columns are in place before the data arrives (S7b-17).
 */
import { clsx } from 'clsx';
import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { LoadingRegion, SkeletonText } from './Skeleton';
import { lineWidth } from './skeleton-widths';

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  /** Classes for the header cell only (e.g. a fixed width). */
  headerClassName?: string;
  /** Placeholder for this column's cell while the table loads; a line of text by default. */
  skeleton?: (rowIndex: number) => ReactNode;
}

interface DataTableProps<T> {
  caption: string;
  className?: string;
  columns: ReadonlyArray<Column<T>>;
  rows: readonly T[];
  getRowId: (row: T) => string;
  onOpen?: (row: T) => void;
  /** Accessible name of a row, announced when it receives focus. */
  rowLabel?: (row: T) => string;
  isRowSelected?: (row: T) => boolean;
  /** A row that just arrived (a live alert): tinted for a moment, then the tint fades. */
  isRowFresh?: (row: T) => boolean;
}

const INTERACTIVE = 'a, button, input, select, textarea, label';

export function DataTable<T>({
  caption,
  className,
  columns,
  rows,
  getRowId,
  onOpen,
  rowLabel,
  isRowSelected,
  isRowFresh,
}: DataTableProps<T>) {
  const [active, setActive] = useState(0);
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);
  const activeIndex = Math.min(active, Math.max(rows.length - 1, 0));

  function focusRow(index: number) {
    const clamped = Math.max(0, Math.min(rows.length - 1, index));
    setActive(clamped);
    rowRefs.current[clamped]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTableRowElement>, index: number, row: T) {
    if (event.target !== event.currentTarget) return; // keys inside a checkbox or link
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusRow(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusRow(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusRow(0);
        break;
      case 'End':
        event.preventDefault();
        focusRow(rows.length - 1);
        break;
      case 'Enter':
        if (onOpen) {
          event.preventDefault();
          onOpen(row);
        }
        break;
      default:
        break;
    }
  }

  function onClick(event: MouseEvent<HTMLTableRowElement>, index: number, row: T) {
    setActive(index);
    if (!onOpen) return;
    if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return;
    onOpen(row);
  }

  return (
    // A size container: columns hide with `@xl:table-cell` and friends, by the room the
    // table really has (the rail takes width from the viewport).
    <div className={clsx(TABLE_FRAME, className)}>
      <table className={TABLE}>
        <caption className="sr-only">{caption}</caption>
        <TableHead columns={columns} />
        <tbody>
          {rows.map((row, index) => {
            const selected = isRowSelected?.(row) ?? false;
            const fresh = !selected && (isRowFresh?.(row) ?? false);
            return (
              <tr
                key={getRowId(row)}
                ref={(element) => {
                  rowRefs.current[index] = element;
                }}
                tabIndex={index === activeIndex ? 0 : -1}
                aria-label={rowLabel?.(row)}
                aria-selected={isRowSelected ? selected : undefined}
                data-row-id={getRowId(row)}
                onKeyDown={(event) => onKeyDown(event, index, row)}
                onClick={(event) => onClick(event, index, row)}
                onFocus={() => setActive(index)}
                data-fresh={fresh || undefined}
                className={clsx(
                  // Hover, press and the tint of a fresh row change in 150 ms, ease-out: the
                  // tint fades when the row stops being fresh.
                  'group align-top transition-[background-color,box-shadow] duration-150 ease-out focus-visible:outline-offset-[-2px]',
                  onOpen && 'cursor-pointer hover:bg-hover active:bg-pressed',
                  selected &&
                    'bg-selected shadow-[inset_3px_0_0_var(--c-accent)] hover:bg-selected',
                  fresh && 'bg-arrive shadow-[inset_3px_0_0_var(--c-info)]',
                )}
              >
                {columns.map((column) => (
                  <td key={column.id} className={clsx(CELL, column.className)}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const TABLE_FRAME = '@container overflow-x-auto md:overflow-x-clip';
const TABLE = 'w-full border-separate border-spacing-0 text-left';
const CELL = 'border-b border-line px-3 py-2.5';

function TableHead<T>({ columns }: { columns: ReadonlyArray<Column<T>> }) {
  return (
    <thead>
      <tr>
        {columns.map((column) => (
          <th
            key={column.id}
            scope="col"
            className={clsx(
              'sticky top-0 z-10 border-b border-line-strong bg-bg px-3 py-2.5 align-bottom text-small font-semibold whitespace-nowrap text-muted',
              column.className,
              column.headerClassName,
            )}
          >
            {column.header}
          </th>
        ))}
      </tr>
    </thead>
  );
}

/**
 * The table of `columns` with `rows` placeholder rows: real headers, the same cells and
 * the same row height, so the first load does not move the page when the rows arrive.
 */
export function TableSkeleton<T>({
  columns,
  rows = 8,
  label,
  className,
}: {
  columns: ReadonlyArray<Column<T>>;
  rows?: number;
  /** What is loading, for assistive technology ("Loading alerts…"). */
  label?: string;
  className?: string;
}) {
  return (
    <LoadingRegion label={label} className={clsx(TABLE_FRAME, className)}>
      {/* Inert: the real headers may hold controls (select all), which must wait for rows. */}
      <table className={TABLE} aria-hidden="true" inert>
        <TableHead columns={columns} />
        <tbody>
          {Array.from({ length: rows }, (_, index) => (
            <tr key={index} className="align-top">
              {columns.map((column, columnIndex) => (
                <td key={column.id} className={clsx(CELL, column.className)}>
                  {column.skeleton ? (
                    column.skeleton(index)
                  ) : (
                    <SkeletonText className={lineWidth(index + columnIndex)} />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </LoadingRegion>
  );
}
