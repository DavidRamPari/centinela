import { eventsQuerySchema, uuidParamsSchema } from '@centinela/shared';
import { Router } from 'express';
import { getEvent, listEvents } from '../db/events-read.js';
import type { AppDeps } from '../deps.js';
import { HttpError } from '../http/problem.js';
import { validate } from '../http/validate.js';
import { checkIp, parseCursor, resolveTimeRange } from './query.js';

/** `GET /api/events` (search, keyset pagination) and `GET /api/events/:id`. */
export function createEventsRouter({ pool }: Pick<AppDeps, 'pool'>): Router {
  const router = Router();

  router.get('/events', async (req, res) => {
    const query = validate(eventsQuerySchema, req.query, 'query');
    const page = await listEvents(pool, {
      ...resolveTimeRange(query),
      source: query.source,
      host: query.host,
      user: query.user,
      ip: checkIp(query.ip),
      action: query.action,
      outcome: query.outcome,
      q: query.q,
      after: parseCursor(query.cursor),
      limit: query.limit,
    });
    res.json(page);
  });

  router.get('/events/:id', async (req, res) => {
    const { id } = validate(uuidParamsSchema, req.params, 'path');
    const event = await getEvent(pool, id);
    if (!event) throw new HttpError(404, 'Event not found');
    res.json(event);
  });

  return router;
}
