/**
 * `npm run rules:lint` (S9): static checks for Sigma conditions that can never match.
 *
 * Windows logs (Sysmon, the security log) hold full paths in `Image`, `ParentImage` and
 * the other path fields, Linux and macOS logs hold absolute paths, and `OriginalFileName`
 * holds a bare file name. A value that contradicts that shape never matches a real event,
 * and the rule silently loses a selection or a filter. Each check comes from a class of
 * bugs fixed in SigmaHQ (docs/DETECTION.md#rule-lint):
 *
 * - `partial-path`: exact value on a path field that is not a full path, such as
 *   `'\AgentExecutor.exe'` or `'TeamViewer_Desktop.exe'`;
 * - `folder`: exact or `endswith` value on a path field that ends with a folder separator;
 * - `bad-start`: `startswith` value on a path field that no full path can begin with, such
 *   as `':\Program Files'`, `' C:\'` or `'\Logging\'`;
 * - `separator`: path value with another system's separator (`/` in a Windows rule, `\`
 *   in a Linux or macOS rule);
 * - `file-name`: `OriginalFileName` value with a folder separator;
 * - `cmd-space`: exact command line that begins or ends with a space;
 * - `dword`: registry `Details` value with a DWORD or QWORD number written without `0x`;
 * - `unsatisfiable`: exact value that another condition on the same field, in the same
 *   selection, rules out. This one runs the engine's own matchers on the exact values.
 *
 * Values are read with Sigma's escaping (`\\`, `\*` and `\?` are escapes). Items with a
 * modifier the engine does not support are skipped, so rules it cannot compile are still
 * checked.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { z } from 'zod';
import { UnsupportedRuleError } from './errors.js';
import { EventView } from './event-view.js';
import { listRuleFiles, RULE_FOLDERS } from './rules/loader.js';
import { parseRuleYaml } from './rules/ruleset.js';
import {
  compileDetectionItem,
  planModifiers,
  splitDetectionKey,
  toValueList,
  type DetectionItem,
  type RuleScalar,
} from './sigma/modifiers.js';
import { isPlain, parseSigmaString, plainText, type PatternToken } from './sigma/pattern.js';

export const LINT_CHECKS = [
  'partial-path',
  'folder',
  'bad-start',
  'separator',
  'file-name',
  'cmd-space',
  'dword',
  'unsatisfiable',
] as const;
export type LintCheck = (typeof LINT_CHECKS)[number];

export interface LintFinding {
  /** Path relative to the checked folder, with `/` separators. */
  file: string;
  ruleId: string | null;
  title: string | null;
  /** Selection name in `detection`. */
  selection: string;
  /** Detection key as written, for example `Image|startswith`. */
  key: string;
  /** The value as written in the rule. */
  value: string;
  check: LintCheck;
  /** What is wrong, in one sentence. */
  message: string;
}

/** Fields that hold a full file path (Sysmon, Windows security log, Linux and macOS). */
const PATH_FIELDS = new Set([
  'Image',
  'ParentImage',
  'ImageLoaded',
  'TargetFilename',
  'SourceImage',
  'TargetImage',
]);
const COMMAND_LINE_FIELDS = new Set(['CommandLine', 'ParentCommandLine']);
/** Values Windows logs instead of a path, for processes without an image file. */
const PSEUDO_PROCESSES = new Set([
  '',
  '-',
  'system',
  'registry',
  'idle',
  'memcompression',
  'secure system',
  'vmmem',
  'vmmemwsl',
  'unknown',
  '<unknown process>',
]);
/** Drive letter, UNC, NT object path, environment variable or a Unix path. */
const ABSOLUTE_PATH = /^(?:[a-z]:\\|\\\\|\\device\\|\\systemroot\\|\\\?\?\\|%|\/)/i;
/** Starts of full paths that a shorter text can be the beginning of. */
const FULL_PATH_STARTS = ['\\\\', '\\device\\', '\\systemroot\\', '\\??\\'];
/** The separator a path never contains, by `logsource.product`. */
const FOREIGN_SEPARATOR = new Map([
  ['windows', '/'],
  ['linux', '\\'],
  ['macos', '\\'],
]);
/** `DWORD (` or `QWORD (`: Sysmon writes the number after it as `0x...`. */
const REGISTRY_NUMBER = /[dq]word \(/gi;

const MESSAGES: Readonly<Record<LintCheck, string>> = {
  'partial-path': 'exact match on a value that is not a full path; use endswith or the full path',
  folder: 'a file path never ends with a folder separator; use startswith or contains',
  'bad-start': 'startswith value that no full path can begin with',
  separator:
    'path separator of another operating system: Windows paths use \\, Linux and macOS paths use /',
  'file-name': 'OriginalFileName holds a file name without folders; remove the separator',
  'cmd-space': 'exact command line with a leading or trailing space; use contains',
  dword: 'the registry value is logged in hexadecimal with 0x, as in DWORD (0x00000001)',
  unsatisfiable: 'no exact value of this key can also satisfy',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valuesOf(raw: unknown): RuleScalar[] {
  try {
    return toValueList(raw);
  } catch (error) {
    if (error instanceof UnsupportedRuleError) return [];
    throw error;
  }
}

/** The modifier plan, or null for a modifier the engine does not support. */
function planOf(modifiers: readonly string[]): ReturnType<typeof planModifiers> | null {
  try {
    return planModifiers(modifiers);
  } catch (error) {
    if (error instanceof UnsupportedRuleError) return null;
    throw error;
  }
}

interface ItemIssue {
  value: string;
  check: Exclude<LintCheck, 'unsatisfiable'>;
}

/** How an item compares values: equality, or one of the two anchored transforms. */
interface Comparison {
  exact: boolean;
  startswith: boolean;
  endswith: boolean;
}

/** Could a full path begin with `text`? More text or a wildcard may follow it. */
export function canBeginFullPath(text: string): boolean {
  if (ABSOLUTE_PATH.test(text)) return true;
  const lower = text.toLowerCase();
  return /^[a-z]:?$/.test(lower) || FULL_PATH_STARTS.some((start) => start.startsWith(lower));
}

function textsOf(tokens: readonly PatternToken[]): string[] {
  return tokens.flatMap((t) => (t.kind === 'text' ? [t.text] : []));
}

function checkPath(
  tokens: readonly PatternToken[],
  how: Comparison,
  product: string | null,
): ItemIssue['check'] | null {
  const foreign = product === null ? undefined : FOREIGN_SEPARATOR.get(product);
  if (foreign !== undefined && textsOf(tokens).some((t) => t.includes(foreign))) {
    return 'separator';
  }
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if ((how.exact || how.endswith) && last?.kind === 'text' && /[\\/]$/.test(last.text)) {
    return 'folder';
  }
  if (how.exact && isPlain(tokens)) {
    const text = plainText(tokens);
    if (PSEUDO_PROCESSES.has(text.toLowerCase()) || ABSOLUTE_PATH.test(text)) return null;
    return 'partial-path';
  }
  if (first?.kind === 'text' && !canBeginFullPath(first.text)) {
    if (how.exact) return 'partial-path';
    if (how.startswith) return 'bad-start';
  }
  return null;
}

/** A DWORD or QWORD number that does not start with `0x` where the text shows it. */
function hasDecimalRegistryNumber(tokens: readonly PatternToken[]): boolean {
  return textsOf(tokens).some((text) =>
    [...text.matchAll(REGISTRY_NUMBER)].some((match) => {
      const rest = text.slice(match.index + match[0].length, match.index + match[0].length + 2);
      return rest !== '' && !'0x'.startsWith(rest.toLowerCase());
    }),
  );
}

function checkValue(
  field: string,
  tokens: readonly PatternToken[],
  how: Comparison,
  product: string | null,
): ItemIssue['check'] | null {
  if (PATH_FIELDS.has(field)) return checkPath(tokens, how, product);
  if (field === 'OriginalFileName') {
    return textsOf(tokens).some((t) => /[\\/]/.test(t)) ? 'file-name' : null;
  }
  if (COMMAND_LINE_FIELDS.has(field) && how.exact && isPlain(tokens)) {
    const text = plainText(tokens);
    return text !== '' && text.trim() !== text ? 'cmd-space' : null;
  }
  if (field === 'Details' && hasDecimalRegistryNumber(tokens)) return 'dword';
  return null;
}

/**
 * The value checks of one detection item (`field|modifiers: values`). `product` is the
 * rule's `logsource.product` in lower case, for the separator check.
 */
export function checkDetectionItem(
  field: string,
  modifiers: readonly string[],
  raw: unknown,
  product: string | null = null,
): ItemIssue[] {
  const plan = planOf(modifiers);
  if (plan === null || plan.type !== 'string') return [];
  const only = (transform: string) =>
    plan.transforms.length === 1 && plan.transforms[0] === transform;
  const how: Comparison = {
    exact: plan.transforms.length === 0,
    startswith: only('startswith'),
    endswith: only('endswith'),
  };
  const issues: ItemIssue[] = [];
  for (const value of valuesOf(raw)) {
    if (typeof value !== 'string') continue;
    const check = checkValue(field, parseSigmaString(value), how, product);
    if (check !== null) issues.push({ value, check });
  }
  return issues;
}

interface KeyedItem {
  key: string;
  modifiers: string[];
  raw: unknown;
}

function compileOrNull(field: string, item: KeyedItem): DetectionItem | null {
  try {
    return compileDetectionItem(field, item.modifiers, item.raw);
  } catch (error) {
    if (error instanceof UnsupportedRuleError) return null;
    throw error;
  }
}

/**
 * Exact items that no other item on the same field can accept: for each exact item, is
 * there one of its values that every other item on that field matches? The engine's own
 * matchers decide, on an event that holds only that field.
 */
export function findUnsatisfiable(
  map: Record<string, unknown>,
): Array<{ key: string; value: string; others: string[] }> {
  const byField = new Map<string, KeyedItem[]>();
  for (const [key, raw] of Object.entries(map)) {
    const { field, modifiers } = splitDetectionKey(key);
    if (field === null) continue;
    const items = byField.get(field) ?? [];
    items.push({ key, modifiers, raw });
    byField.set(field, items);
  }
  const found: Array<{ key: string; value: string; others: string[] }> = [];
  for (const [field, items] of byField) {
    if (items.length < 2) continue;
    for (const exact of items) {
      if (exact.modifiers.some((m) => m !== 'cased')) continue;
      const candidates = valuesOf(exact.raw).filter(
        (v): v is string => typeof v === 'string' && isPlain(parseSigmaString(v)),
      );
      if (candidates.length === 0) continue;
      const others = items.filter((item) => item !== exact);
      const compiled = others.map((item) => compileOrNull(field, item));
      if (compiled.some((c) => c === null)) continue;
      const matchers = compiled.filter((c): c is DetectionItem => c !== null);
      const satisfiable = candidates.some((candidate) => {
        const text = plainText(parseSigmaString(candidate));
        const view = new EventView({ message: '', fields: { [field]: text } });
        return matchers.every((m) => m.test(view));
      });
      if (!satisfiable) {
        found.push({
          key: exact.key,
          value: candidates.join(', '),
          others: others.map((o) => o.key),
        });
      }
    }
  }
  return found;
}

/** Every finding in one parsed rule document; documents without `detection` have none. */
export function lintRuleDocument(doc: unknown, file: string): LintFinding[] {
  if (!isRecord(doc) || !isRecord(doc['detection'])) return [];
  const ruleId = typeof doc['id'] === 'string' ? doc['id'] : null;
  const title = typeof doc['title'] === 'string' ? doc['title'] : null;
  const logsource = isRecord(doc['logsource']) ? doc['logsource'] : {};
  const product =
    typeof logsource['product'] === 'string' ? logsource['product'].toLowerCase() : null;
  const findings: LintFinding[] = [];
  const add = (selection: string, key: string, value: string, check: LintCheck, extra = '') => {
    const message = `${MESSAGES[check]}${extra}`;
    findings.push({ file, ruleId, title, selection, key, value, check, message });
  };
  for (const [selection, body] of Object.entries(doc['detection'])) {
    if (selection === 'condition' || selection === 'timeframe') continue;
    const maps = Array.isArray(body) ? (body as unknown[]) : [body];
    for (const map of maps) {
      if (!isRecord(map)) continue;
      for (const [key, raw] of Object.entries(map)) {
        const { field, modifiers } = splitDetectionKey(key);
        if (field === null) continue;
        for (const issue of checkDetectionItem(field, modifiers, raw, product)) {
          add(selection, key, issue.value, issue.check);
        }
      }
      for (const issue of findUnsatisfiable(map)) {
        add(selection, issue.key, issue.value, 'unsatisfiable', ` ${issue.others.join(', ')}`);
      }
    }
  }
  return findings;
}

const YAML_FILE = /\.ya?ml$/i;
const MAX_FILE_BYTES = 1024 * 1024;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function walkYaml(root: string, relDir: string, out: string[]): void {
  const dir = relDir === '' ? root : join(root, relDir);
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
    const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
    if (entry.isDirectory()) walkYaml(root, relPath, out);
    else if (entry.isFile() && YAML_FILE.test(entry.name)) out.push(relPath);
  }
}

/**
 * The YAML files to check: Centinela's rule files when `dir` has its layout (`sigma/`,
 * `centinela/`, `correlation/`), otherwise every YAML file below `dir`, such as a SigmaHQ
 * checkout. Symbolic links are not followed.
 */
export function listLintFiles(dir: string): string[] {
  if (!statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);
  const centinelaLayout = RULE_FOLDERS.some((folder) => {
    try {
      return statSync(join(dir, folder)).isDirectory();
    } catch {
      return false;
    }
  });
  if (centinelaLayout) return listRuleFiles(dir);
  const files: string[] = [];
  walkYaml(dir, '', files);
  return files.sort(compare);
}

export interface LintResult {
  files: number;
  /** Documents with a `detection` mapping. */
  rules: number;
  findings: LintFinding[];
  /** Files that could not be read as YAML. */
  errors: Array<{ file: string; error: string }>;
}

function sortFindings(findings: LintFinding[]): LintFinding[] {
  const key = (f: LintFinding) => [f.file, f.selection, f.key, f.value, f.check].join('\u0000');
  return findings.sort((a, b) => compare(key(a), key(b)));
}

/**
 * Every document of a YAML file, parsed as the rule loader parses rules. The loader skips
 * multi-document files (old Sigma rule collections), but the lint checks each document.
 */
function parseDocuments(text: string): unknown[] | { error: string } {
  const parsed = parseRuleYaml(text);
  if ('error' in parsed) return parsed;
  if (!parsed.multiDocument) return [parsed.doc];
  return parseAllDocuments(text, { uniqueKeys: true, prettyErrors: false }).map(
    (doc) => doc.toJS({ maxAliasCount: 100 }) as unknown,
  );
}

export function lintFolder(dir: string): LintResult {
  const files = listLintFiles(dir);
  const result: LintResult = { files: files.length, rules: 0, findings: [], errors: [] };
  for (const file of files) {
    const path = join(dir, file);
    if (statSync(path).size > MAX_FILE_BYTES) {
      result.errors.push({ file, error: 'file:too-large' });
      continue;
    }
    const docs = parseDocuments(readFileSync(path, 'utf8'));
    if (!Array.isArray(docs)) {
      result.errors.push({ file, error: docs.error });
      continue;
    }
    for (const doc of docs) {
      if (isRecord(doc) && isRecord(doc['detection'])) result.rules += 1;
      result.findings.push(...lintRuleDocument(doc, file));
    }
  }
  sortFindings(result.findings);
  return result;
}

const baselineEntrySchema = z
  .object({
    file: z.string().min(1),
    check: z.enum(LINT_CHECKS),
    key: z.string().min(1),
    /** Where the problem stands upstream, for people reading the output. */
    upstream: z.string().min(1),
  })
  .strict();
export const lintBaselineSchema = z
  .object({ description: z.string().optional(), entries: z.array(baselineEntrySchema) })
  .strict();
export type LintBaseline = z.infer<typeof lintBaselineSchema>;
export type LintBaselineEntry = LintBaseline['entries'][number];

export function parseLintBaseline(text: string): LintBaseline {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`baseline is not JSON: ${reason}`, { cause: error });
  }
  const result = lintBaselineSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`baseline: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}`);
  }
  return result.data;
}

export interface BaselineComparison {
  known: Array<{ finding: LintFinding; entry: LintBaselineEntry }>;
  unknown: LintFinding[];
  /** Entries that no finding matches anymore: the rule was fixed or removed. */
  stale: LintBaselineEntry[];
}

/** A baseline entry covers every finding with its file, check and key. */
export function compareWithBaseline(
  findings: readonly LintFinding[],
  baseline: LintBaseline | null,
): BaselineComparison {
  const entries = baseline?.entries ?? [];
  const id = (e: { file: string; check: string; key: string }) =>
    `${e.file}\u0000${e.check}\u0000${e.key}`;
  const byId = new Map(entries.map((entry) => [id(entry), entry]));
  const used = new Set<string>();
  const comparison: BaselineComparison = { known: [], unknown: [], stale: [] };
  for (const finding of findings) {
    const entry = byId.get(id(finding));
    if (entry === undefined) {
      comparison.unknown.push(finding);
    } else {
      comparison.known.push({ finding, entry });
      used.add(id(entry));
    }
  }
  comparison.stale = entries.filter((entry) => !used.has(id(entry)));
  return comparison;
}
