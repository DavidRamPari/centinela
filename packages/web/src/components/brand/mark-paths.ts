/** Geometry of the mark on its 16-unit grid (docs/decisions/S7b.md, brand sheet). */
export const MARK_PATHS = {
  /** The defender, yellow: top-left piece. */
  defender: 'M1 4.5A3.5 3.5 0 0 1 4.5 1H11V4H4.75A.75.75 0 0 0 4 4.75V11H1Z',
  /** The ground it guards, blue: bottom-right piece. */
  ground: 'M15 11.5A3.5 3.5 0 0 1 11.5 15H5V12H11.25A.75.75 0 0 0 12 11.25V5H15Z',
  /** The threat, red: the square in the middle (x, y, size, corner radius). */
  threat: { x: 6, y: 6, size: 4, radius: 0.5 },
} as const;
