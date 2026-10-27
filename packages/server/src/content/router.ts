/**
 * `GET /api/rules/:id/playbook?lang=en|es` (ARCHITECTURE §9, session S7): the content-pack
 * playbook of a rule in one language, with the rule's attribution (author, link, license,
 * as DRL 1.1 requires) and the generator's notice. `404` when the rule is unknown or has
 * no playbook (10 vendored rules have none, see content/README.md).
 */
import { playbookQuerySchema, ruleIdParamsSchema, type PlaybookResponse } from '@centinela/shared';
import { Router } from 'express';
import type { AppDeps } from '../deps.js';
import { HttpError } from '../http/problem.js';
import { validate } from '../http/validate.js';
import { loadContentPack } from './pack.js';

export function createPlaybookRouter({ config, rules }: Pick<AppDeps, 'config' | 'rules'>): Router {
  const router = Router();

  router.get('/rules/:id/playbook', (req, res) => {
    const { id } = validate(ruleIdParamsSchema, req.params, 'path');
    const { lang } = validate(playbookQuerySchema, req.query, 'query');
    const rule = rules.get(id);
    if (!rule) throw new HttpError(404, 'Rule not found');
    const stored = loadContentPack(config.contentDir).get(rule.meta.id);
    if (!stored) throw new HttpError(404, 'No playbook for this rule');
    const response: PlaybookResponse = {
      ruleId: rule.meta.id,
      lang,
      playbook: stored.playbooks[lang],
      rule: {
        title: rule.meta.title,
        author: rule.meta.author,
        url: rule.meta.url,
        license: rule.meta.license,
      },
      generated: stored.generated,
    };
    res.json(response);
  });

  return router;
}
