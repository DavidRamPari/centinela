import { clsx } from 'clsx';
import { DIGITS, MARKS, layout } from './corridor';

const HEIGHT_UNITS = 8; // 7 for the digits plus room for the comma's tail

/**
 * A number drawn in Corridor numerals, for the Overview scoreboard only. The formatted text
 * is in the DOM for screen readers and copy; the drawing is decorative.
 */
export function CorridorNumber({
  text,
  height = 48,
  className,
}: {
  /** Already formatted for the locale, e.g. "64,213". */
  text: string;
  height?: number;
  className?: string;
}) {
  const { items, width } = layout(text, DIGITS);
  const pad = 0.1;
  return (
    <span className={clsx('inline-flex', className)}>
      <span className="sr-only">{text}</span>
      <svg
        height={height}
        width={(height * (width + 2 * pad)) / (HEIGHT_UNITS + 2 * pad)}
        viewBox={`${-pad} ${-pad} ${width + 2 * pad} ${HEIGHT_UNITS + 2 * pad}`}
        aria-hidden="true"
        focusable="false"
        className="overflow-visible"
      >
        {items.map(({ x, char }, index) => {
          const digit = DIGITS[char];
          if (digit) {
            return (
              <path
                key={index}
                transform={`translate(${x} 0)`}
                d={digit.d}
                fill="none"
                stroke="currentColor"
                strokeWidth={1}
              />
            );
          }
          const mark = MARKS[char];
          if (!mark) return null;
          const [rx, ry, rw, rh] = mark.rect;
          return <rect key={index} x={x + rx} y={ry} width={rw} height={rh} fill="currentColor" />;
        })}
      </svg>
    </span>
  );
}
