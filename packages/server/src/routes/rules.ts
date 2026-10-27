import {
  LEVEL_WEIGHT,
  ruleIdParamsSchema,
  rulePatchBodySchema,
  rulesQuerySchema,
  type RuleDetailResponse,
  type RuleListItem,
  type RuleMeta,
  type RulesPage,
  type RulesQuery,
} from '@centinela/shared';
import { Router } from 'express';
import { z } from 'zod';
import { recordAudit } from '../auth/audit.js';
import { authOf } from '../auth/guard.js';
import { alertCountsByRule } from '../db/alerts.js';
import type { AppDeps } from '../deps.js';
import { HttpError } from '../http/problem.js';
import { validate } from '../http/validate.js';
import { clientIp } from '../security/client-ip.js';
import { invalidQuery } from './query.js';

/**
 * Rules list order: level (critical first), then title, then id. The order is total and
 * does not depend on the filters, so a cursor (the last rule's id) stays valid when a rule
 * is enabled or disabled between pages.
 */
export function compareRules(a: RuleMeta, b: RuleMeta): number {
  const byLevel = LEVEL_WEIGHT[b.level] - LEVEL_WEIGHT[a.level];
  if (byLevel !== 0) return byLevel;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Filters of `GET /api/rules`; `q` is a case-insensitive substring of the rule's texts. */
export function ruleMatches(rule: RuleMeta, query: Omit<RulesQuery, 'cursor' | 'limit'>): boolean {
  const q = query.q?.toLowerCase();
  return (
    (q === undefined ||
      [rule.title, rule.name ?? '', rule.description ?? '', rule.id, rule.path].some((text) =>
        text.toLowerCase().includes(q),
      )) &&
    (query.level === undefined || query.level.includes(rule.level)) &&
    (query.technique === undefined || rule.techniques.includes(query.technique)) &&
    (query.origin === undefined || rule.origin === query.origin) &&
    (query.supported === undefined || rule.supported === query.supported) &&
    (query.enabled === undefined || rule.enabled === query.enabled)
  );
}

const ruleCursorSchema = z.guid();

const encodeRuleCursor = (id: string) => Buffer.from(id, 'utf8').toString('base64url');

function decodeRuleCursor(cursor: string): string | undefined {
  const parsed = ruleCursorSchema.safeParse(Buffer.from(cursor, 'base64url').toString('utf8'));
  return parsed.success ? parsed.data : undefined;
}

/** `GET /api/rules`, `GET /api/rules/:id` (with the YAML source), `PATCH /api/rules/:id`. */
export function createRulesRouter({ pool, rules }: Pick<AppDeps, 'pool' | 'rules'>): Router {
  const router = Router();

  router.get('/rules', async (req, res) => {
    const query = validate(rulesQuerySchema, req.query, 'query');
    await rules.ready();
    const sorted = rules.list().sort(compareRules);
    let start = 0;
    if (query.cursor !== undefined) {
      const id = decodeRuleCursor(query.cursor)?.toLowerCase();
      const position = sorted.findIndex((rule) => rule.id.toLowerCase() === id);
      if (position === -1) throw invalidQuery('cursor', 'invalid cursor');
      start = position + 1;
    }
    const matching = sorted.slice(start).filter((rule) => ruleMatches(rule, query));
    const page = matching.slice(0, query.limit);
    const counts = await alertCountsByRule(pool);
    const items: RuleListItem[] = page.map((rule) => ({
      ...rule,
      matches: counts.get(rule.id) ?? 0,
    }));
    const last = page[page.length - 1];
    const response: RulesPage = {
      items,
      nextCursor: matching.length > query.limit && last ? encodeRuleCursor(last.id) : null,
    };
    res.json(response);
  });

  router.get('/rules/:id', async (req, res) => {
    const { id } = validate(ruleIdParamsSchema, req.params, 'path');
    await rules.ready();
    const rule = rules.get(id);
    if (!rule) throw new HttpError(404, 'Rule not found');
    const response: RuleDetailResponse = { rule: rule.meta, source: rule.source };
    res.json(response);
  });

  router.patch('/rules/:id', async (req, res) => {
    const { id } = validate(ruleIdParamsSchema, req.params, 'path');
    const body = validate(rulePatchBodySchema, req.body, 'body');
    const rule = await rules.setEnabled(id, body.enabled);
    if (!rule) throw new HttpError(404, 'Rule not found');
    // Written after the change: the rule catalog owns the rule_state write (S6-07).
    await recordAudit(pool, {
      actor: authOf(res).session.username,
      action: 'rule.update',
      target: rule.id,
      ip: clientIp(req),
      details: { enabled: body.enabled, title: rule.title },
    });
    res.json(rule);
  });

  return router;
}
