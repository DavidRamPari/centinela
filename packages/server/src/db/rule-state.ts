/**
 * Persisted rule enable/disable flags (`rule_state`, ARCHITECTURE §8). Rules not listed
 * keep their default (enabled).
 */
import type { Pool } from 'pg';

export async function loadRuleState(pool: Pool): Promise<Map<string, boolean>> {
  const { rows } = await pool.query<{ rule_id: string; enabled: boolean }>(
    'SELECT rule_id, enabled FROM rule_state',
  );
  return new Map(rows.map((row) => [row.rule_id, row.enabled]));
}

export async function saveRuleState(
  pool: Pool,
  ruleId: string,
  enabled: boolean,
  now: Date = new Date(),
): Promise<void> {
  await pool.query(
    `INSERT INTO rule_state (rule_id, enabled, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (rule_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at`,
    [ruleId, enabled, now],
  );
}
