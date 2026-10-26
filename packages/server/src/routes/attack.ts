import {
  attackQuerySchema,
  type AttackIndex,
  type AttackResponse,
  type AttackTechnique,
  type RuleMeta,
} from '@centinela/shared';
import { loadAttackIndexSync } from '@centinela/shared/node';
import { Router } from 'express';
import { alertCountsByTechnique } from '../db/alerts.js';
import type { AppDeps } from '../deps.js';
import { validate } from '../http/validate.js';
import { resolveTimeRange } from './query.js';

/** Supported, enabled rules per technique id (exact ids). */
export function ruleCountsByTechnique(rules: readonly RuleMeta[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rule of rules) {
    if (!rule.supported || !rule.enabled) continue;
    for (const id of rule.techniques) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

const byName = (a: AttackTechnique, b: AttackTechnique) => a.name.localeCompare(b.name, 'en');

/**
 * The matrix (S3-07): per tactic in ATT&CK order, every parent technique sorted by name,
 * each followed by those of its sub-techniques that have rules or alerts. Counts use the
 * exact technique id, so a rule tagged `T1110.001` counts for the sub-technique only.
 */
export function buildAttackMatrix(
  attack: AttackIndex,
  ruleCounts: ReadonlyMap<string, number>,
  alertCounts: ReadonlyMap<string, number>,
): AttackResponse {
  const entry = (technique: AttackTechnique) => ({
    id: technique.id,
    name: technique.name,
    url: technique.url,
    rules: ruleCounts.get(technique.id) ?? 0,
    alerts: alertCounts.get(technique.id) ?? 0,
  });
  const hasActivity = (technique: AttackTechnique) =>
    ruleCounts.has(technique.id) || alertCounts.has(technique.id);

  return {
    tactics: attack.tactics.map((tactic) => {
      const inTactic = attack.techniques.filter((t) => t.tactics.includes(tactic.shortname));
      const techniques = inTactic
        .filter((t) => !t.subtechnique)
        .sort(byName)
        .flatMap((parent) => [
          entry(parent),
          ...inTactic
            .filter((t) => t.subtechnique && t.id.startsWith(`${parent.id}.`) && hasActivity(t))
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .map(entry),
        ]);
      return { id: tactic.id, shortname: tactic.shortname, name: tactic.name, techniques };
    }),
  };
}

let attackIndex: AttackIndex | undefined;

/** `GET /api/attack`: the ATT&CK matrix with rule coverage and alert counts. */
export function createAttackRouter({ pool, rules }: Pick<AppDeps, 'pool' | 'rules'>): Router {
  const router = Router();
  router.get('/attack', async (req, res) => {
    const query = validate(attackQuerySchema, req.query, 'query');
    await rules.ready();
    const alertCounts = await alertCountsByTechnique(pool, resolveTimeRange(query));
    attackIndex ??= loadAttackIndexSync();
    res.json(buildAttackMatrix(attackIndex, ruleCountsByTechnique(rules.list()), alertCounts));
  });
  return router;
}
