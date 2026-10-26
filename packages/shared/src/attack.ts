/**
 * MITRE ATT&CK helper. Pure functions over the compact data file in
 * `data/mitre-attack/enterprise-attack.min.json`; reading the file from disk lives in
 * `node.ts` so the browser bundle can use this module too.
 */
import { z } from 'zod';
import { techniqueIdSchema } from './alerts.js';

export const attackTacticSchema = z.object({
  id: z.string().regex(/^TA\d{4}$/),
  shortname: z.string().min(1),
  name: z.string().min(1),
  url: z.url(),
});
export type AttackTactic = z.infer<typeof attackTacticSchema>;

export const attackTechniqueSchema = z.object({
  id: techniqueIdSchema,
  name: z.string().min(1),
  tactics: z.array(z.string().min(1)),
  subtechnique: z.boolean(),
  platforms: z.array(z.string()),
  url: z.url(),
});
export type AttackTechnique = z.infer<typeof attackTechniqueSchema>;

export const attackDataSchema = z.object({
  source: z.string(),
  version: z.string(),
  generated: z.string(),
  tactics: z.array(attackTacticSchema).min(1),
  techniques: z.array(attackTechniqueSchema).min(1),
});
export type AttackData = z.infer<typeof attackDataSchema>;

/** Resolved technique: the data entry, or the parent's data for an unknown sub-technique. */
export interface TechniqueInfo {
  id: string;
  name: string;
  tactics: string[];
  url: string;
}

export interface AttackIndex {
  /** Tactics in matrix order. */
  readonly tactics: readonly AttackTactic[];
  readonly techniques: readonly AttackTechnique[];
  tactic(shortname: string): AttackTactic | undefined;
  /**
   * Technique by id (case-insensitive). An unknown sub-technique falls back to its parent's
   * tactics and URL, keeping its own id; an unknown technique returns undefined.
   */
  technique(id: string): TechniqueInfo | undefined;
  /** Tactic shortnames for the given technique ids, de-duplicated, in matrix order. */
  tacticsFor(techniqueIds: readonly string[]): string[];
}

const TECHNIQUE_TAG = /^attack\.(t\d{4}(?:\.\d{3})?)$/i;

/**
 * Technique ids from Sigma tags (`attack.t1110.001` → `T1110.001`), upper-cased,
 * de-duplicated, in tag order. Other tags (tactics, groups, software) are ignored.
 */
export function techniquesFromTags(tags: readonly string[]): string[] {
  const ids: string[] = [];
  for (const tag of tags) {
    const match = TECHNIQUE_TAG.exec(tag.trim());
    const id = match?.[1]?.toUpperCase();
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function createAttackIndex(input: unknown): AttackIndex {
  const data = attackDataSchema.parse(input);
  const tacticsByShortname = new Map(data.tactics.map((t) => [t.shortname, t]));
  const tacticOrder = new Map(data.tactics.map((t, i) => [t.shortname, i]));
  const techniquesById = new Map(data.techniques.map((t) => [t.id, t]));

  function technique(rawId: string): TechniqueInfo | undefined {
    const id = rawId.trim().toUpperCase();
    const exact = techniquesById.get(id);
    if (exact) return { id, name: exact.name, tactics: [...exact.tactics], url: exact.url };
    const parentId = id.split('.')[0];
    if (parentId === undefined || parentId === id) return undefined;
    const parent = techniquesById.get(parentId);
    if (!parent) return undefined;
    return { id, name: parent.name, tactics: [...parent.tactics], url: parent.url };
  }

  function tacticsFor(techniqueIds: readonly string[]): string[] {
    const found = new Set<string>();
    for (const id of techniqueIds) {
      for (const tactic of technique(id)?.tactics ?? []) {
        if (tacticOrder.has(tactic)) found.add(tactic);
      }
    }
    return [...found].sort((a, b) => (tacticOrder.get(a) ?? 0) - (tacticOrder.get(b) ?? 0));
  }

  return {
    tactics: data.tactics,
    techniques: data.techniques,
    tactic: (shortname) => tacticsByShortname.get(shortname),
    technique,
    tacticsFor,
  };
}
