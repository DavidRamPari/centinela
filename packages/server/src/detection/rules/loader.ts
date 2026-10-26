/**
 * Read rule files from the rules folder (ARCHITECTURE §5.1): `sigma/**` without
 * `sigma/regression/`, `centinela/**` and `correlation/**`, in path order. Symbolic links
 * are not followed, so rules only ever come from inside the folder.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface RuleSource {
  /** Path relative to the rules folder, with `/` separators. */
  relPath: string;
  text: string;
  /** Set when the file could not be used at all (for example, too large). */
  error?: string;
}

export const RULE_FOLDERS = ['sigma', 'centinela', 'correlation'] as const;
const EXCLUDED = new Set(['sigma/regression']);
const RULE_FILE = /\.ya?ml$/i;
/** Rule files are small; anything larger is not a rule. */
const MAX_RULE_FILE_BYTES = 1024 * 1024;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function walk(root: string, relDir: string, out: string[]): void {
  const entries = readdirSync(join(root, relDir), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
    const relPath = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!EXCLUDED.has(relPath)) walk(root, relPath, out);
    } else if (entry.isFile() && RULE_FILE.test(entry.name)) {
      out.push(relPath);
    }
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Every rule file below `rulesDir`, sorted by path. Missing folders are skipped. */
export function listRuleFiles(rulesDir: string): string[] {
  if (!statSync(rulesDir).isDirectory()) throw new Error(`not a directory: ${rulesDir}`);
  const files: string[] = [];
  for (const folder of RULE_FOLDERS) {
    if (isDirectory(join(rulesDir, folder))) walk(rulesDir, folder, files);
  }
  return files.sort(compare);
}

export function readRuleSources(rulesDir: string): RuleSource[] {
  return listRuleFiles(rulesDir).map((relPath) => {
    const file = join(rulesDir, relPath);
    if (statSync(file).size > MAX_RULE_FILE_BYTES) {
      return { relPath, text: '', error: 'file:too-large' };
    }
    return { relPath, text: readFileSync(file, 'utf8') };
  });
}

const COMMIT_LINE = /^\s*-?\s*Source commit:\s*([0-9a-f]{40})\b/im;

/** The SigmaHQ commit recorded in `rules/sigma/README.md`, or null. */
export function readSigmaCommit(rulesDir: string): string | null {
  try {
    const readme = readFileSync(join(rulesDir, 'sigma', 'README.md'), 'utf8');
    return COMMIT_LINE.exec(readme)?.[1] ?? null;
  } catch {
    return null;
  }
}
