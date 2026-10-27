import {
  MAX_ALERT_DETAIL_EVENTS,
  alertBulkBodySchema,
  alertPatchBodySchema,
  alertsQuerySchema,
  uuidParamsSchema,
  type AlertBulkResponse,
  type AlertDetailResponse,
} from '@centinela/shared';
import { Router } from 'express';
import { recordAudit } from '../auth/audit.js';
import { authOf } from '../auth/guard.js';
import { getAlert, listAlerts, triageAlert, triageAlerts } from '../db/alerts.js';
import { eventsForAlert } from '../db/events-read.js';
import { withTransaction } from '../db/sql.js';
import type { AppDeps } from '../deps.js';
import { HttpError } from '../http/problem.js';
import { validate } from '../http/validate.js';
import { clientIp } from '../security/client-ip.js';
import { checkIp, parseCursor, resolveTimeRange } from './query.js';

/**
 * Alerts (ARCHITECTURE §7, §9): list, detail with rule and timeline, triage of one alert
 * and bulk triage. Triage changes are published on the live stream as `alert.updated` and
 * written to the audit log in the same transaction as the change.
 */
export function createAlertsRouter({ pool, rules, hub }: Pick<AppDeps, 'pool' | 'rules' | 'hub'>) {
  const router = Router();

  router.get('/alerts', async (req, res) => {
    const query = validate(alertsQuerySchema, req.query, 'query');
    const page = await listAlerts(pool, {
      ...resolveTimeRange(query),
      status: query.status,
      level: query.level,
      ruleId: query.ruleId,
      technique: query.technique,
      host: query.host,
      ip: checkIp(query.ip),
      user: query.user,
      after: parseCursor(query.cursor),
      limit: query.limit,
    });
    res.json(page);
  });

  router.post('/alerts/bulk', async (req, res) => {
    const body = validate(alertBulkBodySchema, req.body, 'body');
    const actor = authOf(res).session.username;
    const updated = await withTransaction(pool, async (client) => {
      const alerts = await triageAlerts(client, body.ids, body);
      await recordAudit(client, {
        actor,
        action: 'alert.bulk_triage',
        ip: clientIp(req),
        details: {
          status: body.status,
          resolution: body.resolution ?? null,
          requested: body.ids.length,
          updated: alerts.map((alert) => alert.id),
        },
      });
      return alerts;
    });
    for (const alert of updated) hub.publish({ type: 'alert.updated', alert });
    const response: AlertBulkResponse = { updated: updated.length };
    res.json(response);
  });

  router.get('/alerts/:id', async (req, res) => {
    const { id } = validate(uuidParamsSchema, req.params, 'path');
    const alert = await getAlert(pool, id);
    if (!alert) throw new HttpError(404, 'Alert not found');
    const events = await eventsForAlert(pool, id, MAX_ALERT_DETAIL_EVENTS);
    await rules.ready();
    const response: AlertDetailResponse = {
      alert,
      rule: rules.get(alert.ruleId)?.meta ?? null,
      events,
    };
    res.json(response);
  });

  router.patch('/alerts/:id', async (req, res) => {
    const { id } = validate(uuidParamsSchema, req.params, 'path');
    const body = validate(alertPatchBodySchema, req.body, 'body');
    const actor = authOf(res).session.username;
    const result = await withTransaction(pool, async (client) => {
      const triaged = await triageAlert(client, id, body);
      if (triaged.ok) {
        await recordAudit(client, {
          actor,
          action: 'alert.triage',
          target: id,
          ip: clientIp(req),
          details: {
            status: body.status,
            resolution: body.resolution ?? null,
            note: body.note === undefined ? 'kept' : body.note === null ? 'cleared' : 'set',
          },
        });
      }
      return triaged;
    });
    if (!result.ok) {
      if (result.reason === 'not-found') throw new HttpError(404, 'Alert not found');
      throw new HttpError(409, `An alert cannot go from ${result.current} to ${body.status}`);
    }
    hub.publish({ type: 'alert.updated', alert: result.alert });
    res.json(result.alert);
  });

  return router;
}
