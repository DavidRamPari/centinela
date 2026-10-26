/**
 * Load a folder of Sigma rules for fixture validation: Centinela's vendored subset
 * (`rules/sigma`, the default) or the `rules/` folder of a full SigmaHQ checkout. Every
 * `.yml`/`.yaml` file below the folder is compiled with the detection engine's own rule
 * set builder (S2), so validation uses exactly the semantics the pipeline uses.
 *
 * `regression/` at the top of the folder holds test data, not rules, and hidden folders
 * (`.git`, `.github`) are skipped. Symbolic links are not followed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadAttackIndexSync } from '@centinela/shared/node';
import type { RuleSource } from '../detection/rules/loader.js';
import { buildRuleSet, type RuleSet } from '../detection/rules/ruleset.js';

const RULE_FILE = /\.ya?ml$/i;
const MAX_RULE_FILE_BYTES = 1024 * 1024;
const SKIPPED_TOP_LEVEL = new Set(['regression']);
/** The rule set builder treats paths below `sigma/` as SigmaHQ rules (DRL 1.1). */
const SIGMA_PREFIX = 'sigma/';

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function walk(root: string, relDir: string, out: string[]): void {
  const entries = readdirSync(join(root, relDir), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => byName(a.name, b.name))) {
    if (entry.name.startsWith('.')) continue;
    const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (relDir !== '' || !SKIPPED_TOP_LEVEL.has(entry.name)) walk(root, relPath, out);
    } else if (entry.isFile() && RULE_FILE.test(entry.name)) {
      out.push(relPath);
    }
  }
}

/** Rule files below `dir`, relative to it, sorted by path. */
export function listSigmaRuleFiles(dir: string): string[] {
  if (!statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);
  const files: string[] = [];
  walk(dir, '', files);
  return files.sort(byName);
}

export interface SigmaFolder {
  ruleSet: RuleSet;
  /** Path of a rule relative to the folder, from its `RuleMeta.path`. */
  relPath(metaPath: string): string;
}

export function loadSigmaFolder(dir: string): SigmaFolder {
  const sources: RuleSource[] = listSigmaRuleFiles(dir).map((relPath) => {
    const file = join(dir, relPath);
    const source = { relPath: `${SIGMA_PREFIX}${relPath}` };
    if (statSync(file).size > MAX_RULE_FILE_BYTES) {
      return { ...source, text: '', error: 'file:too-large' };
    }
    return { ...source, text: readFileSync(file, 'utf8') };
  });
  const ruleSet = buildRuleSet(sources, { sigmaCommit: null, attack: loadAttackIndexSync() });
  const prefix = `rules/${SIGMA_PREFIX}`;
  return {
    ruleSet,
    relPath: (metaPath) => (metaPath.startsWith(prefix) ? metaPath.slice(prefix.length) : metaPath),
  };
}
