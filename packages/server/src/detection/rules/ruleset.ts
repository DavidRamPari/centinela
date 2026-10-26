/**
 * Build the rule set: parse each rule file, extract `RuleMeta`, compile Sigma rules,
 * resolve and order correlation rules, mark building blocks and index rules by
 * logsource. Everything here runs once at start-up; the result is immutable except for
 * the `enabled` flag of each rule.
 *
 * Files that are not rules at all (invalid YAML, no title, id or level, duplicate id) are
 * load errors. Rules that are valid but use unsupported constructs stay in `rules` with
 * `supported: false` and a machine-readable `unsupportedReason` (ARCHITECTURE §5.5).
 */
import type { AttackIndex, RuleMeta } from '@centinela/shared';
import { parseAllDocuments } from 'yaml';
import { UnsupportedRuleError } from '../errors.js';
import { parseCorrelationSettings } from '../correlation/settings.js';
import { createLogsourceRouter, type LogsourceRouter } from '../routing.js';
import { compileDetection, createCompileCache, type CompileCache } from '../sigma/compile.js';
import type {
  CompiledCorrelation,
  CompiledRule,
  CompiledSigmaRule,
  CorrelationSettings,
} from '../types.js';
import type { LiteralIndex } from '../sigma/literal-index.js';
import type { RuleSource } from './loader.js';
import { alertRuleInfo, buildRuleMeta } from './meta.js';
import { describeIssue, ruleHeaderSchema, type RuleHeader } from './schema.js';

export interface RuleRecord {
  readonly meta: RuleMeta;
  /** The YAML text of the rule file. */
  readonly source: string;
  /** The compiled rule, when supported. */
  compiled: CompiledRule | null;
}

export interface LoadError {
  /** Repository-relative path. */
  path: string;
  reason: string;
}

export interface RuleSet {
  /** Every rule, supported or not, in path order. */
  readonly rules: readonly RuleRecord[];
  /** Files that could not be read as rules. */
  readonly errors: readonly LoadError[];
  /** Supported Sigma rules in path order. */
  readonly sigma: readonly CompiledSigmaRule[];
  /** Supported correlation rules in dependency order (inner rules first). */
  readonly correlations: readonly CompiledCorrelation[];
  readonly router: LogsourceRouter<CompiledSigmaRule>;
  /** Size of `EventView.memo` for this rule set's shared predicates. */
  readonly memoSlots: number;
  /** Simple literal patterns of every Sigma rule (see `sigma/literal-index.ts`). */
  readonly literals: LiteralIndex;
  /** Rule by id (case-insensitive). */
  rule(id: string): RuleRecord | undefined;
}

export interface RuleSetOptions {
  sigmaCommit: string | null;
  attack: AttackIndex;
}

type ParsedYaml = { doc: unknown; multiDocument: boolean } | { error: string };

function firstLine(text: string): string {
  return text.split('\n')[0] ?? text;
}

/** One YAML document per file, unique keys (ARCHITECTURE §5.1). */
export function parseRuleYaml(text: string): ParsedYaml {
  const docs = parseAllDocuments(text, { uniqueKeys: true, prettyErrors: false });
  if (!Array.isArray(docs) || docs.length === 0) return { error: 'yaml:empty' };
  for (const doc of docs) {
    const [error] = doc.errors;
    if (error) {
      const code = error.code === 'DUPLICATE_KEY' ? 'yaml:duplicate-key' : 'yaml:invalid';
      return { error: `${code} (${firstLine(error.message)})` };
    }
  }
  const first = docs[0];
  if (!first) return { error: 'yaml:empty' };
  return { doc: first.toJS({ maxAliasCount: 100 }) as unknown, multiDocument: docs.length > 1 };
}

interface Pending {
  record: RuleRecord;
  header: RuleHeader;
  /** Reason found before compiling (status, multi-document file, duplicate name). */
  reason: string | null;
}

function markUnsupported(record: RuleRecord, reason: string): void {
  record.meta.supported = false;
  record.meta.unsupportedReason = reason;
  record.compiled = null;
}

function reasonOf(error: unknown): string {
  if (error instanceof UnsupportedRuleError) return error.reason;
  throw error;
}

export function buildRuleSet(sources: readonly RuleSource[], options: RuleSetOptions): RuleSet {
  const errors: LoadError[] = [];
  const pending: Pending[] = [];
  const byId = new Map<string, RuleRecord>();
  const byName = new Map<string, RuleRecord>();

  for (const source of sources) {
    const path = `rules/${source.relPath}`;
    if (source.error !== undefined) {
      errors.push({ path, reason: source.error });
      continue;
    }
    const parsed = parseRuleYaml(source.text);
    if ('error' in parsed) {
      errors.push({ path, reason: parsed.error });
      continue;
    }
    const header = ruleHeaderSchema.safeParse(parsed.doc);
    if (!header.success) {
      errors.push({ path, reason: `schema (${describeIssue(header.error)})` });
      continue;
    }
    const meta = buildRuleMeta(header.data, {
      relPath: source.relPath,
      sigmaCommit: options.sigmaCommit,
      attack: options.attack,
    });
    const idKey = meta.id.toLowerCase();
    const existing = byId.get(idKey);
    if (existing) {
      errors.push({ path, reason: `rule:duplicate-id (${meta.id} is ${existing.meta.path})` });
      continue;
    }
    const record: RuleRecord = { meta, source: source.text, compiled: null };
    byId.set(idKey, record);

    let reason: string | null = null;
    const status = meta.status?.toLowerCase();
    if (status === 'deprecated' || status === 'unsupported') reason = `status:${status}`;
    else if (parsed.multiDocument) reason = 'yaml:multi-document';
    if (meta.name !== null) {
      const named = byName.get(meta.name);
      if (named) reason ??= `rule:duplicate-name (${meta.name} is ${named.meta.path})`;
      else byName.set(meta.name, record);
    }
    pending.push({ record, header: header.data, reason });
  }

  const cache = createCompileCache();
  const sigma = compileSigmaRules(pending, cache);
  const correlations = compileCorrelations(pending, (ref) => byName.get(ref) ?? byId.get(ref.toLowerCase()));
  wireConsumers(correlations, (id) => byId.get(id.toLowerCase())?.compiled ?? null);
  for (const rule of sigma) {
    rule.meta.buildingBlock =
      rule.consumers.length > 0 && rule.consumers.every((consumer) => !consumer.generate);
  }

  return {
    rules: pending.map((p) => p.record),
    errors,
    sigma,
    correlations,
    router: createLogsourceRouter(sigma.map((rule) => ({ logsource: rule.logsource, rule }))),
    memoSlots: cache.slots,
    literals: cache.literals,
    rule: (id) => byId.get(id.toLowerCase()),
  };
}

function compileSigmaRules(pending: readonly Pending[], cache: CompileCache): CompiledSigmaRule[] {
  const compiled: CompiledSigmaRule[] = [];
  for (const { record, header, reason } of pending) {
    if (record.meta.type !== 'sigma') continue;
    if (reason !== null) {
      markUnsupported(record, reason);
      continue;
    }
    const logsource = record.meta.logsource;
    if (logsource === null) {
      markUnsupported(record, 'rule:missing-logsource');
      continue;
    }
    if (header.detection === undefined) {
      markUnsupported(record, 'rule:missing-detection');
      continue;
    }
    try {
      const rule: CompiledSigmaRule = {
        kind: 'sigma',
        meta: record.meta,
        info: alertRuleInfo(record.meta),
        logsource,
        detection: compileDetection(header.detection, cache),
        consumers: [],
      };
      record.compiled = rule;
      compiled.push(rule);
    } catch (error) {
      markUnsupported(record, reasonOf(error));
    }
  }
  return compiled;
}

/**
 * Resolve references and compile correlations depth-first, so a correlation is compiled
 * after the correlations it chains on. Unknown references, references to unsupported
 * rules, cycles and incompatible `group-by` make a correlation unsupported.
 */
function compileCorrelations(
  pending: readonly Pending[],
  resolve: (ref: string) => RuleRecord | undefined,
): CompiledCorrelation[] {
  const ordered: CompiledCorrelation[] = [];
  const byRecord = new Map(pending.map((p) => [p.record, p]));
  const done = new Set<RuleRecord>();
  const stack: RuleRecord[] = [];
  const inCycle = new Set<RuleRecord>();

  function compileOne(entry: Pending): void {
    const { record, header } = entry;
    if (entry.reason !== null) throw new UnsupportedRuleError(entry.reason);
    const settings: CorrelationSettings = parseCorrelationSettings(header.correlation);
    const targets = settings.ruleRefs.map((ref) => {
      const target = resolve(ref);
      if (!target) throw new UnsupportedRuleError('correlation:unknown-reference', ref);
      return { ref, target };
    });
    for (const { ref, target } of targets) {
      if (target.meta.type === 'correlation') visit(target);
      if (inCycle.has(record)) throw new UnsupportedRuleError('correlation:cycle', ref);
      if (!target.meta.supported) {
        throw new UnsupportedRuleError('correlation:unsupported-reference', ref);
      }
      if (target.compiled?.kind === 'correlation') {
        const inner = target.compiled.groupBy;
        const missing = settings.groupBy.filter((field) => !inner.includes(field));
        if (missing.length > 0) {
          throw new UnsupportedRuleError('correlation:group-by', `${ref} lacks ${missing.join(', ')}`);
        }
      }
    }
    const { ruleRefs: _refs, ...rest } = settings;
    const compiled: CompiledCorrelation = {
      ...rest,
      kind: 'correlation',
      meta: record.meta,
      info: alertRuleInfo(record.meta),
      refs: targets.map(({ target }) => target.meta.id),
      consumers: [],
      order: ordered.length,
    };
    record.compiled = compiled;
    ordered.push(compiled);
  }

  function visit(record: RuleRecord): void {
    if (done.has(record)) return;
    const position = stack.indexOf(record);
    if (position !== -1) {
      for (const member of stack.slice(position)) inCycle.add(member);
      return;
    }
    const entry = byRecord.get(record);
    if (!entry) return;
    stack.push(record);
    try {
      compileOne(entry);
    } catch (error) {
      markUnsupported(record, reasonOf(error));
    }
    stack.pop();
    done.add(record);
  }

  for (const entry of pending) {
    if (entry.record.meta.type === 'correlation') visit(entry.record);
  }
  return ordered;
}

function wireConsumers(
  correlations: readonly CompiledCorrelation[],
  compiledById: (id: string) => CompiledRule | null,
): void {
  for (const correlation of correlations) {
    for (const id of new Set(correlation.refs)) {
      compiledById(id)?.consumers.push(correlation);
    }
  }
}
