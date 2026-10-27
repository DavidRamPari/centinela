/**
 * The Centinela mark, "Containment" (docs/decisions/S7b.md): the defender (yellow) and the
 * ground it guards (blue) close in from opposite corners around a threat (red). Drawn on a
 * 16-unit grid so the 16 px favicon is pixel-aligned; the pieces never touch, so the mark
 * also works in one colour.
 */
import { clsx } from 'clsx';
import { MARK_PATHS } from './mark-paths';

interface MarkProps {
  /** Rendered size in pixels (the mark is square). */
  size?: number;
  /** One-colour version in `currentColor`. */
  mono?: boolean;
  className?: string;
  /** Accessible name; without it the mark is decorative. */
  title?: string;
}

export function Mark({ size = 24, mono = false, className, title }: MarkProps) {
  const fill = (color: string) => (mono ? 'currentColor' : `var(${color})`);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={clsx('shrink-0', className)}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path
        d={MARK_PATHS.defender}
        fill={fill('--c-brand-yellow')}
        // Light theme: a dark keyline keeps the yellow piece visible on white.
        stroke={mono ? undefined : 'var(--c-brand-keyline)'}
        strokeWidth={mono ? undefined : 0.4}
        paintOrder="stroke"
      />
      <path d={MARK_PATHS.ground} fill={fill('--c-brand-blue')} />
      <rect
        x={MARK_PATHS.threat.x}
        y={MARK_PATHS.threat.y}
        width={MARK_PATHS.threat.size}
        height={MARK_PATHS.threat.size}
        rx={MARK_PATHS.threat.radius}
        fill={fill('--c-brand-red')}
      />
    </svg>
  );
}
