/**
 * `RuleMeta` extraction (ARCHITECTURE §3.3). SigmaHQ rules carry the DRL 1.1 license and a
 * link to the rule at the vendored commit; Centinela's own rules are MIT. Tactics come from
 * the ATT&CK data, never from tactic tags alone.
 */
import { techniquesFromTags, type AttackIndex, type LogSource, type RuleMeta } from '@centinela/shared';
import type { AlertRuleInfo } from '../../pipeline/types.js';
import type { RuleHeader } from './schema.js';

const SIGMA_FOLDER = 'sigma/';

export interface MetaContext {
  /** Path relative to the rules folder, with `/` separators. */
  relPath: string;
  /** SigmaHQ commit recorded in `rules/sigma/README.md`. */
  sigmaCommit: string | null;
  attack: AttackIndex;
}

export function sigmaRuleUrl(relPath: string, commit: string | null): string | null {
  if (commit === null || !relPath.startsWith(SIGMA_FOLDER)) return null;
  return `https://github.com/SigmaHQ/sigma/blob/${commit}/rules/${relPath.slice(SIGMA_FOLDER.length)}`;
}

function toLogsource(header: RuleHeader): LogSource | null {
  if (header.correlation !== undefined || header.logsource === undefined) return null;
  const { product, service, category } = header.logsource;
  return {
    ...(product !== undefined && { product }),
    ...(service !== undefined && { service }),
    ...(category !== undefined && { category }),
  };
}

export function buildRuleMeta(header: RuleHeader, ctx: MetaContext): RuleMeta {
  const sigmahq = ctx.relPath.startsWith(SIGMA_FOLDER);
  const techniques = techniquesFromTags(header.tags);
  return {
    id: header.id,
    name: header.name ?? null,
    title: header.title,
    description: header.description,
    type: header.correlation === undefined ? 'sigma' : 'correlation',
    level: header.level,
    status: header.status ?? null,
    author: header.author,
    references: header.references,
    date: header.date,
    modified: header.modified,
    tags: header.tags,
    techniques,
    tactics: ctx.attack.tacticsFor(techniques),
    logsource: toLogsource(header),
    falsepositives: header.falsepositives,
    origin: sigmahq ? 'sigmahq' : 'centinela',
    path: `rules/${ctx.relPath}`,
    url: sigmahq ? sigmaRuleUrl(ctx.relPath, ctx.sigmaCommit) : null,
    license: sigmahq ? 'DRL-1.1' : 'MIT',
    supported: true,
    unsupportedReason: null,
    buildingBlock: false,
    enabled: true,
  };
}

/** The rule snapshot an alert candidate carries (ARCHITECTURE §2.3). */
export function alertRuleInfo(meta: RuleMeta): AlertRuleInfo {
  return {
    id: meta.id,
    title: meta.title,
    type: meta.type,
    level: meta.level,
    techniques: [...meta.techniques],
    tactics: [...meta.tactics],
    author: meta.author,
    url: meta.url,
    license: meta.license,
  };
}
