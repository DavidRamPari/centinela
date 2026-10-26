/**
 * Technique names for the alert and rule pages, from the bundled ATT&CK data. The data
 * (about 140 kB) is loaded on demand in its own chunk, only by pages that show names.
 */
import { createAttackIndex, type AttackIndex } from '@centinela/shared';
import { useQuery } from '@tanstack/react-query';

let cached: Promise<AttackIndex> | undefined;

export function loadAttackIndex(): Promise<AttackIndex> {
  cached ??= import('../../../../data/mitre-attack/enterprise-attack.min.json').then((module) =>
    createAttackIndex(module.default),
  );
  return cached;
}

export function useAttackIndex() {
  return useQuery({
    queryKey: ['attack-index'],
    queryFn: loadAttackIndex,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
