/**
 * The rule loading report (`npm run rules:report`, `docs/rules-report.md`): loaded,
 * supported and skipped rules by folder and reason, the correlation rules, and the result
 * of the SigmaHQ regression samples. Pure: the same rule set gives the same text (no
 * timestamps), so the committed report only changes when the rules or the engine do.
 */
import type { RuleMeta } from '@centinela/shared';
import type { RegressionFileResult, RegressionResult } from './regression.js';
import type { RuleSet } from './rules/ruleset.js';

export interface FolderStats {
  folder: string;
  files: number;
  loaded: number;
  supported: number;
  unsupported: number;
  errors: number;
}

export interface ReportInput {
  ruleSet: RuleSet;
  sigmaCommit: string | null;
  regression: readonly RegressionResult[];
  regressionFiles: readonly RegressionFileResult[];
}

/** `rules/sigma/linux/builtin/sshd/x.yml` → `sigma/linux/builtin` (at most three levels). */
export function folderOf(path: string): string {
  const parts = path
    .replace(/^rules\//, '')
    .split('/')
    .slice(0, -1);
  return parts.slice(0, 3).join('/') || '.';
}

/** `modifier:unknown (foo)` → `modifier:unknown`. */
export function reasonCode(reason: string): string {
  const index = reason.indexOf(' (');
  return index === -1 ? reason : reason.slice(0, index);
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function percent(part: number, total: number): string {
  return total === 0 ? 'n/a' : `${((part / total) * 100).toFixed(2)}%`;
}

/** Markdown table cell: no pipes or line breaks from rule text. */
function cell(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
}

export function folderStats(ruleSet: RuleSet): FolderStats[] {
  const stats = new Map<string, FolderStats>();
  const get = (folder: string) => {
    let entry = stats.get(folder);
    if (!entry) {
      entry = { folder, files: 0, loaded: 0, supported: 0, unsupported: 0, errors: 0 };
      stats.set(folder, entry);
    }
    return entry;
  };
  for (const { meta } of ruleSet.rules) {
    const entry = get(folderOf(meta.path));
    entry.files += 1;
    entry.loaded += 1;
    if (meta.supported) entry.supported += 1;
    else entry.unsupported += 1;
  }
  for (const error of ruleSet.errors) {
    const entry = get(folderOf(error.path));
    entry.files += 1;
    entry.errors += 1;
  }
  return [...stats.values()].sort((a, b) => compare(a.folder, b.folder));
}

export function sigmaHqCompileRate(ruleSet: RuleSet): { supported: number; total: number } {
  const sigmahq = ruleSet.rules.filter((r) => r.meta.origin === 'sigmahq');
  const errors = ruleSet.errors.filter((e) => e.path.startsWith('rules/sigma/')).length;
  return {
    supported: sigmahq.filter((r) => r.meta.supported).length,
    total: sigmahq.length + errors,
  };
}

/** Short text summary for the console. */
export function reportSummary(input: ReportInput): string {
  const { ruleSet, regression, regressionFiles } = input;
  const lines: string[] = [];
  const rate = sigmaHqCompileRate(ruleSet);
  for (const s of folderStats(ruleSet)) {
    lines.push(
      `${s.folder.padEnd(32)} ${String(s.files).padStart(5)} files  ${String(s.supported).padStart(5)} supported  ${String(s.unsupported).padStart(3)} unsupported  ${String(s.errors).padStart(3)} errors`,
    );
  }
  const unsupported = ruleSet.rules.filter((r) => !r.meta.supported);
  lines.push(
    `SigmaHQ rules compiled: ${rate.supported}/${rate.total} (${percent(rate.supported, rate.total)})`,
    `Unsupported rules: ${unsupported.length}; load errors: ${ruleSet.errors.length}`,
    `Correlation rules: ${ruleSet.correlations.length} supported`,
    `Regression samples: ${regression.filter((r) => r.passed).length}/${regression.length} events matched (${percent(regression.filter((r) => r.passed).length, regression.length)}); ${regressionFiles.filter((f) => f.passed).length}/${regressionFiles.length} files`,
  );
  return lines.join('\n');
}

function correlationRow(meta: RuleMeta, ruleSet: RuleSet): string {
  const compiled = ruleSet.rule(meta.id)?.compiled;
  if (compiled?.kind !== 'correlation') return '';
  const refs = compiled.refs.map((id) => ruleSet.rule(id)?.meta.name ?? id).join(', ');
  const conditions = [
    compiled.gt === null ? null : `gt ${compiled.gt}`,
    compiled.gte === null ? null : `gte ${compiled.gte}`,
    compiled.valueField === null ? null : `field ${compiled.valueField}`,
  ].filter((c) => c !== null);
  const minutes = compiled.timespanMs / 60_000;
  const span = Number.isInteger(minutes) ? `${minutes}m` : `${compiled.timespanMs / 1000}s`;
  return `| \`${cell(meta.name ?? meta.id)}\` | ${compiled.type} | ${cell(refs)} | ${cell(compiled.groupBy.join(', ')) || '—'} | ${span} | ${cell(conditions.join(', ')) || '—'} | ${compiled.generate} | ${meta.level} |`;
}

export function buildRulesReport(input: ReportInput): string {
  const { ruleSet, sigmaCommit, regression, regressionFiles } = input;
  const out: string[] = [];
  const rate = sigmaHqCompileRate(ruleSet);
  const stats = folderStats(ruleSet);
  const total = stats.reduce(
    (acc, s) => ({
      files: acc.files + s.files,
      loaded: acc.loaded + s.loaded,
      supported: acc.supported + s.supported,
      unsupported: acc.unsupported + s.unsupported,
      errors: acc.errors + s.errors,
    }),
    { files: 0, loaded: 0, supported: 0, unsupported: 0, errors: 0 },
  );

  out.push(
    '# Rules report',
    '',
    'Generated by `npm run rules:report` from the rules in `rules/`. Do not edit by hand; re-run the command after changing rules or the engine.',
    '',
    `- SigmaHQ commit: ${sigmaCommit === null ? 'unknown' : `\`${sigmaCommit}\``}`,
    `- SigmaHQ rules compiled: **${rate.supported} of ${rate.total} (${percent(rate.supported, rate.total)})**`,
    `- Regression samples matched: **${regression.filter((r) => r.passed).length} of ${regression.length} events (${percent(regression.filter((r) => r.passed).length, regression.length)})**, ${regressionFiles.filter((f) => f.passed).length} of ${regressionFiles.length} files`,
    '',
    '## Rules by folder',
    '',
    '| Folder | Files | Loaded | Supported | Unsupported | Load errors |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...stats.map(
      (s) =>
        `| \`${s.folder}\` | ${s.files} | ${s.loaded} | ${s.supported} | ${s.unsupported} | ${s.errors} |`,
    ),
    `| **Total** | **${total.files}** | **${total.loaded}** | **${total.supported}** | **${total.unsupported}** | **${total.errors}** |`,
    '',
  );

  const unsupported = ruleSet.rules
    .filter((r) => !r.meta.supported)
    .map((r) => r.meta)
    .sort((a, b) => compare(a.path, b.path));
  const byReason = new Map<string, number>();
  for (const meta of unsupported) {
    const code = reasonCode(meta.unsupportedReason ?? 'unknown');
    byReason.set(code, (byReason.get(code) ?? 0) + 1);
  }
  out.push('## Skipped rules by reason', '');
  if (byReason.size === 0 && ruleSet.errors.length === 0) {
    out.push('None: every rule loaded and compiled.', '');
  } else {
    out.push('| Reason | Rules |', '| --- | ---: |');
    for (const [code, count] of [...byReason].sort((a, b) => compare(a[0], b[0]))) {
      out.push(`| \`${code}\` | ${count} |`);
    }
    const errorCodes = new Map<string, number>();
    for (const error of ruleSet.errors) {
      const code = reasonCode(error.reason);
      errorCodes.set(code, (errorCodes.get(code) ?? 0) + 1);
    }
    for (const [code, count] of [...errorCodes].sort((a, b) => compare(a[0], b[0]))) {
      out.push(`| \`${code}\` (load error) | ${count} |`);
    }
    out.push('');
  }

  out.push('## Unsupported rules', '');
  if (unsupported.length === 0) out.push('None.', '');
  else {
    out.push('| Rule | Title | Reason |', '| --- | --- | --- |');
    for (const meta of unsupported) {
      out.push(
        `| \`${cell(meta.path)}\` | ${cell(meta.title)} | \`${cell(meta.unsupportedReason ?? '')}\` |`,
      );
    }
    out.push('');
  }

  out.push('## Load errors', '');
  if (ruleSet.errors.length === 0) out.push('None.', '');
  else {
    out.push('| File | Reason |', '| --- | --- |');
    for (const error of [...ruleSet.errors].sort((a, b) => compare(a.path, b.path))) {
      out.push(`| \`${cell(error.path)}\` | \`${cell(error.reason)}\` |`);
    }
    out.push('');
  }

  const centinela = ruleSet.rules
    .filter((r) => r.meta.origin === 'centinela')
    .map((r) => r.meta)
    .sort((a, b) => compare(a.path, b.path));
  out.push(
    "## Centinela's rules",
    '',
    '| Name | Type | Level | Techniques | Building block | Supported |',
    '| --- | --- | --- | --- | --- | --- |',
    ...centinela.map(
      (m) =>
        `| \`${cell(m.name ?? m.id)}\` | ${m.type} | ${m.level} | ${m.techniques.join(', ') || '—'} | ${m.buildingBlock ? 'yes' : 'no'} | ${m.supported ? 'yes' : `no (\`${cell(m.unsupportedReason ?? '')}\`)`} |`,
    ),
    '',
    '### Correlations',
    '',
    '| Name | Type | Rules | Group-by | Timespan | Condition | `generate` | Level |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...ruleSet.correlations.map((c) => correlationRow(c.meta, ruleSet)),
    '',
  );

  const failures = regression.filter((r) => !r.passed);
  out.push(
    '## SigmaHQ regression samples',
    '',
    'Every event in `rules/sigma/regression/windows/process_creation/**` evaluated against its rule with `Event.EventData` as the field view (the golden test). A file passes when at least the number of events its `info.yml` expects (`match_count`, default 1) match; some files hold context events that are not meant to match.',
    '',
    `- Events: ${regression.length - failures.length} of ${regression.length} matched (${percent(regression.length - failures.length, regression.length)})`,
    `- Files: ${regressionFiles.filter((f) => f.passed).length} of ${regressionFiles.length} passed`,
    '',
    '### Events that did not match',
    '',
  );
  if (failures.length === 0) out.push('None.', '');
  else {
    const expectedOf = new Map(regressionFiles.map((f) => [f.path, f]));
    out.push('| Sample | Event | File passes | Reason |', '| --- | ---: | --- | --- |');
    for (const { sample, reason } of failures) {
      const file = expectedOf.get(sample.path);
      const filePasses = file
        ? `${file.passed ? 'yes' : 'no'} (${file.matched}/${file.events} matched, ${file.expected} expected)`
        : '—';
      out.push(
        `| \`${cell(sample.path.replace('rules/sigma/regression/windows/process_creation/', ''))}\` | ${sample.index} | ${filePasses} | ${cell(reason ?? '')} |`,
      );
    }
    out.push('');
  }
  return out.join('\n');
}
