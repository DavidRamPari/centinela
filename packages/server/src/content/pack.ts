/**
 * The content pack in the product (session S7): bilingual playbooks from
 * `<CONTENT_DIR>/sigma/<rule id>.json` (SigmaHQ rules) and `<CONTENT_DIR>/centinela/` (Centinela's
 * own rules, where correlation rules have a playbook and no fixtures), keyed by rule id. Files are validated with the same
 * schema as `npm run content:validate` and the playbooks again with the shared API schema;
 * a file that fails either is skipped and reported, never served half-parsed. Fixtures
 * are not kept in memory.
 *
 * The pack is read once per folder and process (about 1,200 small files) and shared by
 * every app instance; the server loads it at start-up, tests on first use.
 */
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { playbookSchema, type Playbook, type PlaybookLanguage, type PlaybookResponse } from '@centinela/shared';
import type { ContentPlaybook } from './schema.js';
import { readContentDir, type ContentIssue } from './validate.js';

export interface StoredPlaybook {
  ruleId: string;
  playbooks: Record<PlaybookLanguage, Playbook>;
  generated: PlaybookResponse['generated'];
}

export interface ContentPack {
  /** `CONTENT_DIR`, the folder the content folders were read from. */
  readonly dir: string;
  readonly size: number;
  /** Files that could not be used, with the reason. */
  readonly errors: readonly ContentIssue[];
  /** The playbooks of a rule (id compared case-insensitively). */
  get(ruleId: string): StoredPlaybook | undefined;
}

export function toPlaybook(content: ContentPlaybook): Playbook {
  return {
    summary: content.summary,
    whatItDetects: content.what_it_detects,
    whyItMatters: content.why_it_matters,
    triageSteps: content.triage_steps,
    falsePositives: content.false_positives,
    responseSteps: content.response_steps,
    severityRationale: content.severity_rationale,
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Content folders below `CONTENT_DIR`, in load order. */
export const CONTENT_FOLDERS = ['sigma', 'centinela'] as const;

/**
 * Read every folder of `CONTENT_FOLDERS`; missing folders are skipped (content is
 * optional). Errors name the file as `<folder>/<file>`.
 */
export function readContentPack(contentDir: string): ContentPack {
  const root = resolve(contentDir);
  const byId = new Map<string, StoredPlaybook>();
  const errors: ContentIssue[] = [];
  for (const folder of CONTENT_FOLDERS) {
    const dir = join(root, folder);
    if (!isDirectory(dir)) continue;
    const { entries, malformed } = readContentDir(dir);
    errors.push(...malformed.map((issue) => ({ ...issue, file: `${folder}/${issue.file}` })));
    for (const { file: name, content } of entries) {
      const file = `${folder}/${name}`;
      const en = playbookSchema.safeParse(toPlaybook(content.playbook.en));
      const es = playbookSchema.safeParse(toPlaybook(content.playbook.es));
      if (!en.success || !es.success) {
        errors.push({ file, reason: 'playbook does not fit the API schema' });
        continue;
      }
      const key = content.rule.id.toLowerCase();
      if (byId.has(key)) {
        errors.push({ file, reason: `duplicate content for rule ${content.rule.id}` });
        continue;
      }
      const { tool, model, at, review, notice } = content.generated;
      byId.set(key, {
        ruleId: content.rule.id,
        playbooks: { en: en.data, es: es.data },
        generated: { tool, model, at, review, notice },
      });
    }
  }
  return { dir: root, size: byId.size, errors, get: (ruleId) => byId.get(ruleId.toLowerCase()) };
}

const cache = new Map<string, ContentPack>();

/** `readContentPack`, memoized per folder. */
export function loadContentPack(contentDir: string): ContentPack {
  const key = resolve(contentDir);
  let pack = cache.get(key);
  if (!pack) {
    pack = readContentPack(key);
    cache.set(key, pack);
  }
  return pack;
}
