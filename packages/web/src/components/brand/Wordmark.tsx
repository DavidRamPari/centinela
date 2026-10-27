import { clsx } from 'clsx';
import { LETTERS, layout } from './corridor';
import { Mark } from './Mark';

const WORD = 'centinela';
const HEIGHT_UNITS = 7;

/**
 * `centinela` in Corridor letters: yellow strokes, and the tittle of the i is the red square
 * of the mark (the threat). Decorative by default; the lockup carries the accessible name.
 */
export function Wordmark({ height = 20, className }: { height?: number; className?: string }) {
  const { items, width } = layout(WORD, LETTERS);
  const pad = 0.1;
  return (
    <svg
      height={height}
      width={(height * (width + 2 * pad)) / (HEIGHT_UNITS + 2 * pad)}
      viewBox={`${-pad} ${-pad} ${width + 2 * pad} ${HEIGHT_UNITS + 2 * pad}`}
      className={clsx('shrink-0', className)}
      aria-hidden="true"
      focusable="false"
    >
      {items.map(({ x, char }, index) => {
        const glyph = LETTERS[char];
        if (!glyph) return null;
        return (
          <g key={index} transform={`translate(${x} 0)`}>
            <path
              d={glyph.d}
              fill="none"
              stroke="var(--c-brand-wordmark, var(--c-brand-yellow))"
              strokeWidth={1}
            />
            {glyph.dot ? (
              <rect
                x={glyph.dot.x}
                y={glyph.dot.y}
                width={1}
                height={1}
                fill="var(--c-brand-red)"
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** Mark and wordmark together, the primary brand lockup, with the product name as text. */
export function Lockup({ size = 'md', className }: { size?: 'md' | 'lg'; className?: string }) {
  const markSize = size === 'lg' ? 56 : 28;
  const wordHeight = size === 'lg' ? 40 : 19;
  return (
    <span
      className={clsx('inline-flex items-center', size === 'lg' ? 'gap-4' : 'gap-2.5', className)}
    >
      <Mark size={markSize} />
      <Wordmark height={wordHeight} />
      <span className="sr-only">Centinela</span>
    </span>
  );
}
