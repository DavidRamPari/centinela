/**
 * Compare stored alerts with a ground-truth file (`samples/ground-truth.json`, ARCHITECTURE
 * §4.3): for each scenario, every expected rule must have an alert whose time range meets
 * the scenario's and whose entities share an IP or a user with it (any alert, when the
 * scenario lists no entities). Used by `npm run demo` and the end-to-end detection test.
 * The types are structural so the server does not depend on the generator at run time.
 */
import type { RuleMeta } from '@centinela/shared';
import type { Pool } from 'pg';
import { toCount } from './sql.js';

export interface ExpectedScenario {
  id: string;
  /** ISO 8601 (UTC). */
  start: string;
  end: string;
  entities: { ips: readonly string[]; users: readonly string[] };
  /** `name` for Centinela rules, file name without `.yml` for SigmaHQ rules. */
  expected: readonly string[];
}

export interface ExpectedRuleResult {
  expected: string;
  /** Null when no loaded rule has that name. */
  ruleId: string | null;
  alerts: number;
}

export interface ScenarioResult {
  id: string;
  detected: boolean;
  rules: ExpectedRuleResult[];
}

/** Rule ids by `name` and by file name without `.yml`. */
export function ruleIdsByName(rules: readonly RuleMeta[]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const rule of rules) {
    const file = rule.path
      .split('/')
      .pop()
      ?.replace(/\.ya?ml$/i, '');
    if (file !== undefined && !ids.has(file)) ids.set(file, rule.id);
    if (rule.name !== null) ids.set(rule.name, rule.id);
  }
  return ids;
}

const MATCHING_ALERTS = `
SELECT count(*) AS count FROM alerts
 WHERE rule_id = $1 AND last_seen >= $2 AND first_seen <= $3
   AND ((cardinality($4::text[]) = 0 AND cardinality($5::text[]) = 0)
        OR entities -> 'ips' ?| $4::text[]
        OR entities -> 'users' ?| $5::text[])`;

export async function checkScenarios(
  pool: Pool,
  scenarios: readonly ExpectedScenario[],
  rules: readonly RuleMeta[],
): Promise<ScenarioResult[]> {
  const ids = ruleIdsByName(rules);
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const checks: ExpectedRuleResult[] = [];
    for (const expected of scenario.expected) {
      const ruleId = ids.get(expected) ?? null;
      let alerts = 0;
      if (ruleId !== null) {
        const { rows } = await pool.query<{ count: string }>(MATCHING_ALERTS, [
          ruleId,
          scenario.start,
          scenario.end,
          scenario.entities.ips,
          scenario.entities.users,
        ]);
        alerts = toCount(rows[0]?.count);
      }
      checks.push({ expected, ruleId, alerts });
    }
    results.push({
      id: scenario.id,
      detected: checks.every((check) => check.alerts > 0),
      rules: checks,
    });
  }
  return results;
}
