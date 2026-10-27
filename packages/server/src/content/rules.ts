/**
 * Load the rules that content is validated against, in one of two shapes:
 *
 * - a folder of Sigma rules: Centinela's vendored subset (`rules/sigma`) or any rule folder
 *   of a SigmaHQ checkout (`rules`, `rules-emerging-threats`, `rules-threat-hunting`,
 *   `rules-compliance`, or a folder below one). Every `.yml`/`.yaml` file below it is
 *   compiled as a SigmaHQ rule. `regression/` at the top holds test data, not rules, and
 *   hidden folders (`.git`, `.github`) are skipped. The SigmaHQ folder it belongs to
 *   (`folder`) scopes validation when one content folder holds several of them;
 * - a Centinela rules root (the repository's `rules/`, recognized by its `centinela/` or
 *   `correlation/` folder), read with the detection engine's own loader, so correlation
 *   references resolve exactly as in the pipeline. Content for this shape is content for
 *   Centinela's own rules (`content/centinela`), so only those rules are expected to have
 *   a file.
 *
 * Both are compiled with the detection engine's own rule set builder (S2), so validation
 * uses exactly the semantics the pipeline uses. Symbolic links are not followed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { RuleMeta } from '@centinela/shared';
import { loadAttackIndexSync } from '@centinela/shared/node';
import { readRuleSources, readSigmaCommit, type RuleSource } from '../detection/rules/loader.js';
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
  /**
   * SigmaHQ top-level folder of these rules (`rules`, `rules-emerging-threats`, ...), or null
   * when unknown or for a Centinela rules root. Content files record theirs in `rule.folder`
   * (files without it come from `rules`).
   */
  folder: string | null;
  /** Path of a rule relative to the folder, from its `RuleMeta.path`. */
  relPath(metaPath: string): string;
  /** Rules expected to have a content file (deprecated and unsupported-status rules aside). */
  expectsContent(meta: RuleMeta): boolean;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const SIGMAHQ_FOLDER = /^rules(-[a-z0-9-]+)?$/;
const VENDORED_COMMIT = /^\s*-?\s*Source commit:\s*[0-9a-f]{40}\b/im;

/**
 * The SigmaHQ folder a Sigma rules folder belongs to: `rules` for Centinela's vendored
 * subset (its README records the source commit), else the nearest folder, itself included,
 * named `rules` or `rules-*` (`~/sigmahq/rules-threat-hunting/windows` →
 * `rules-threat-hunting`), else null.
 */
export function sigmaFolderOf(dir: string): string | null {
  try {
    if (VENDORED_COMMIT.test(readFileSync(join(dir, 'README.md'), 'utf8'))) return 'rules';
  } catch {
    // No README: not the vendored subset.
  }
  let current = resolve(dir);
  for (;;) {
    if (SIGMAHQ_FOLDER.test(basename(current))) return basename(current);
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** A Centinela rules root has the engine's `centinela/` or `correlation/` folder. */
export function isRulesRoot(dir: string): boolean {
  return isDirectory(join(dir, 'centinela')) || isDirectory(join(dir, 'correlation'));
}

/** The repository's `rules/` folder (or one shaped like it), with the engine's loader. */
export function loadRulesRoot(dir: string): SigmaFolder {
  const ruleSet = buildRuleSet(readRuleSources(dir), {
    sigmaCommit: readSigmaCommit(dir),
    attack: loadAttackIndexSync(),
  });
  return {
    ruleSet,
    folder: null,
    relPath: (metaPath) => (metaPath.startsWith('rules/') ? metaPath.slice('rules/'.length) : metaPath),
    expectsContent: (meta) => meta.origin === 'centinela',
  };
}

/** `loadRulesRoot` for a Centinela rules root, `loadSigmaFolder` for anything else. */
export function loadRuleFolder(dir: string): SigmaFolder {
  return isRulesRoot(dir) ? loadRulesRoot(dir) : loadSigmaFolder(dir);
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
    folder: sigmaFolderOf(dir),
    relPath: (metaPath) => (metaPath.startsWith(prefix) ? metaPath.slice(prefix.length) : metaPath),
    // The SigmaHQ generator writes content for detection rules only.
    expectsContent: (meta) => meta.type === 'sigma',
  };
}
