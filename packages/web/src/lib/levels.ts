import { LEVELS, type Level } from '@centinela/shared';

/** 1 for informational up to 5 for critical (ARCHITECTURE §7 sorting weight). */
export function levelWeight(level: Level): number {
  return LEVELS.indexOf(level) + 1;
}
