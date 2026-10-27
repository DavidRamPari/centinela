/**
 * Ingest tokens and the audit log, behind the dashboard session (and CSRF for changes):
 *
 * - `GET /api/tokens`: the newest tokens, revoked ones included; never their secrets.
 * - `POST /api/tokens` `{ label }`: create a token; the answer carries the secret once.
 * - `POST /api/tokens/:id/revoke`: revoke a token (idempotent).
 * - `GET /api/audit`: audit log, newest first, keyset-paginated, optional `action` filter.
 */
import {
  auditQuerySchema,
  ingestTokenCreateBodySchema,
  uuidParamsSchema,
  type IngestTokenCreated,
  type IngestTokenList,
} from '@centinela/shared';
import { Router } from 'express';
import type { Pool } from 'pg';
import { withTransaction } from '../db/sql.js';
import { HttpError } from '../http/problem.js';
import { validate } from '../http/validate.js';
import { invalidQuery } from '../routes/query.js';
import { clientIp } from '../security/client-ip.js';
import { decodeAuditCursor, listAudit, recordAudit } from './audit.js';
import { authOf } from './guard.js';
import { MAX_ACTIVE_TOKENS, createToken, listTokens, revokeToken } from './ingest-tokens.js';

export function createAdminRouter({ pool }: { pool: Pool }): Router {
  const router = Router();

  router.get('/tokens', async (_req, res) => {
    const response: IngestTokenList = { items: await listTokens(pool) };
    res.json(response);
  });

  router.post('/tokens', async (req, res) => {
    const { label } = validate(ingestTokenCreateBodySchema, req.body, 'body');
    const actor = authOf(res).session.username;
    const result = await withTransaction(pool, async (client) => {
      const created = await createToken(client, { label, createdBy: actor });
      if (created.ok) {
        await recordAudit(client, {
          actor,
          action: 'token.create',
          target: created.token.id,
          ip: clientIp(req),
          details: { label, prefix: created.token.prefix },
        });
      }
      return created;
    });
    if (!result.ok) {
      throw new HttpError(409, `At most ${MAX_ACTIVE_TOKENS} active tokens; revoke one first`);
    }
    const response: IngestTokenCreated = { token: result.token, secret: result.secret };
    res.status(201).json(response);
  });

  router.post('/tokens/:id/revoke', async (req, res) => {
    const { id } = validate(uuidParamsSchema, req.params, 'path');
    const actor = authOf(res).session.username;
    const result = await withTransaction(pool, async (client) => {
      const revoked = await revokeToken(client, id, actor);
      if (revoked.ok && revoked.changed) {
        await recordAudit(client, {
          actor,
          action: 'token.revoke',
          target: id,
          ip: clientIp(req),
          details: { label: revoked.token.label, prefix: revoked.token.prefix },
        });
      }
      return revoked;
    });
    if (!result.ok) throw new HttpError(404, 'Token not found');
    res.json(result.token);
  });

  router.get('/audit', async (req, res) => {
    const query = validate(auditQuerySchema, req.query, 'query');
    const afterSeq = query.cursor === undefined ? undefined : decodeAuditCursor(query.cursor);
    if (query.cursor !== undefined && afterSeq === undefined) {
      throw invalidQuery('cursor', 'invalid cursor');
    }
    res.json(await listAudit(pool, { actions: query.action, afterSeq, limit: query.limit }));
  });

  return router;
}
