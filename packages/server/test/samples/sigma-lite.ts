/**
 * A deliberately small Sigma evaluator used only by the sample tests, to check the
 * generated demo data against the vendored SigmaHQ Linux and web rules before the real
 * engine (session S2) exists. It supports what those rules use: keyword lists, field maps
 * with `contains`/`startswith`/`endswith`/`all`, `null`, lists of maps, logsource routing
 * and conditions with `and`/`or`/`not`/parentheses/`1 of x*`/`all of x*`/`them`.
 *
 * It builds regexes from rule values, which is acceptable in a test: the values come from
 * the repository's rule files, never from log content.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { NormalizedEvent } from '@centinela/shared';
import { parse } from 'yaml';
import { z } from 'zod';

type Matcher = (event: NormalizedEvent, lowerMessage: string) => boolean;

export interface LiteRule {
  name: string;
  path: string;
  level: string;
  logsource: { product?: string; service?: string; category?: string };
  matches: Matcher;
}

const ruleSchema = z.object({
  title: z.string(),
  level: z.string(),
  logsource: z.object({
    product: z.string().optional(),
    service: z.string().optional(),
    category: z.string().optional(),
  }),
  detection: z.record(z.string(), z.unknown()),
});

/** Sigma wildcard value → predicate over a lower-cased string. */
function valuePredicate(value: unknown, mods: string[]): (text: string) => boolean {
  if (value === null) return (text) => text === '';
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new Error('sigma-lite: unsupported value');
  }
  let pattern = String(value).toLowerCase();
  if (mods.includes('contains')) pattern = `*${pattern}*`;
  else if (mods.includes('startswith')) pattern = `${pattern}*`;
  else if (mods.includes('endswith')) pattern = `*${pattern}`;
  const known = mods.filter((m) => !['contains', 'startswith', 'endswith', 'all'].includes(m));
  if (known.length > 0) throw new Error(`sigma-lite: unsupported modifier ${known.join('|')}`);
  if (!/[*?]/.test(pattern)) return (text) => text === pattern;
  const inner = pattern.slice(1, -1);
  if (pattern.startsWith('*') && pattern.endsWith('*') && !/[*?]/.test(inner)) {
    return (text) => text.includes(inner);
  }
  const source = pattern
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  const regex = new RegExp(`^${source}$`, 's');
  return (text) => regex.test(text);
}

function fieldText(event: NormalizedEvent, field: string): string | undefined {
  const value = event.fields[field];
  return value === undefined || value === null ? undefined : String(value).toLowerCase();
}

function compileSelection(selection: unknown): Matcher {
  if (Array.isArray(selection)) {
    if (selection.every((item) => typeof item !== 'object' || item === null)) {
      const preds = selection.map((v) => valuePredicate(v, ['contains']));
      return (_e, msg) => preds.some((p) => p(msg));
    }
    const maps = selection.map(compileSelection);
    return (e, msg) => maps.some((m) => m(e, msg));
  }
  if (typeof selection === 'object' && selection !== null) {
    const parts = Object.entries(selection).map(([key, raw]): Matcher => {
      const [field = '', ...mods] = key.split('|');
      const values = Array.isArray(raw) ? (raw as unknown[]) : [raw];
      if (field === '') {
        const preds = values.map((v) => valuePredicate(v, ['contains', ...mods]));
        const all = mods.includes('all');
        return (_e, msg) => (all ? preds.every((p) => p(msg)) : preds.some((p) => p(msg)));
      }
      const preds = values.map((v) => valuePredicate(v, mods));
      const all = mods.includes('all');
      return (e) => {
        const text = fieldText(e, field);
        if (text === undefined) return values.includes(null);
        return all ? preds.every((p) => p(text)) : preds.some((p) => p(text));
      };
    });
    return (e, msg) => parts.every((p) => p(e, msg));
  }
  throw new Error('sigma-lite: unsupported selection');
}

function compileCondition(condition: string, selections: Map<string, Matcher>): Matcher {
  const tokens = condition.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos]?.toLowerCase();
  const group = (pattern: string): Matcher[] => {
    const names =
      pattern === 'them'
        ? [...selections.keys()].filter((n) => !n.startsWith('_'))
        : [...selections.keys()].filter((n) =>
            new RegExp(`^${pattern.replaceAll('*', '.*')}$`).test(n),
          );
    if (names.length === 0) throw new Error(`sigma-lite: no selection matches ${pattern}`);
    return names.map((n) => selections.get(n) as Matcher);
  };
  const primary = (): Matcher => {
    const token = tokens[pos++];
    if (token === undefined) throw new Error('sigma-lite: unexpected end of condition');
    if (token === '(') {
      const inner = or();
      pos += 1; // ')'
      return inner;
    }
    const lower = token.toLowerCase();
    if ((lower === '1' || lower === 'any' || lower === 'all') && peek() === 'of') {
      pos += 1;
      const members = group(tokens[pos++] ?? '');
      return lower === 'all'
        ? (e, m) => members.every((s) => s(e, m))
        : (e, m) => members.some((s) => s(e, m));
    }
    const selection = selections.get(token);
    if (!selection) throw new Error(`sigma-lite: unknown identifier ${token}`);
    return selection;
  };
  const not = (): Matcher => {
    if (peek() === 'not') {
      pos += 1;
      const inner = not();
      return (e, m) => !inner(e, m);
    }
    return primary();
  };
  const and = (): Matcher => {
    let left = not();
    while (peek() === 'and') {
      pos += 1;
      const l = left;
      const r = not();
      left = (e, m) => l(e, m) && r(e, m);
    }
    return left;
  };
  const or = (): Matcher => {
    let left = and();
    while (peek() === 'or') {
      pos += 1;
      const l = left;
      const r = and();
      left = (e, m) => l(e, m) || r(e, m);
    }
    return left;
  };
  return or();
}

function* yamlFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* yamlFiles(path);
    else if (entry.endsWith('.yml')) yield path;
  }
}

/** Load every rule below `dirs` (paths relative to `root`). */
export function loadLiteRules(root: string, dirs: string[]): LiteRule[] {
  const rules: LiteRule[] = [];
  for (const dir of dirs) {
    for (const path of yamlFiles(join(root, dir))) {
      const rule = ruleSchema.parse(parse(readFileSync(path, 'utf8')));
      const { condition, ...rest } = rule.detection;
      const selections = new Map(
        Object.entries(rest).map(([name, value]) => [name, compileSelection(value)]),
      );
      const conditions = Array.isArray(condition) ? condition : [condition];
      const compiled = conditions.map((c) => compileCondition(String(c), selections));
      rules.push({
        name: path.split('/').at(-1)?.replace(/\.yml$/, '') ?? path,
        path: relative(root, path),
        level: rule.level,
        logsource: rule.logsource,
        matches: (e, m) => compiled.some((c) => c(e, m)),
      });
    }
  }
  return rules;
}

/** ARCHITECTURE §5.2 routing: every key the rule sets equals one logsource entry's value. */
export function applies(rule: LiteRule, event: NormalizedEvent): boolean {
  const keys = (['product', 'service', 'category'] as const).filter(
    (k) => rule.logsource[k] !== undefined,
  );
  return event.logsources.some((source) =>
    keys.every((k) => source[k]?.toLowerCase() === rule.logsource[k]?.toLowerCase()),
  );
}

export function matchingRules(rules: LiteRule[], event: NormalizedEvent): LiteRule[] {
  const message = event.message.toLowerCase();
  return rules.filter((rule) => applies(rule, event) && rule.matches(event, message));
}
