/**
 * Detection engine entry point (ARCHITECTURE §5–§7). Session S2 implements the Sigma
 * loader, compiler and correlation engine behind this factory; until then the detector
 * returns no alert candidates.
 */
import type { Detector } from '../pipeline/types.js';

export interface DetectorOptions {
  /** Absolute path of the `rules/` folder. */
  rulesDir: string;
}

export function createDetector(_options: DetectorOptions): Detector {
  return {
    process: () => [],
    flush: () => [],
  };
}
