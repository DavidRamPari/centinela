import { problemSchema } from '@centinela/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

// Every endpoint in ARCHITECTURE §9 except health and the two ingest endpoints.
// A session that implements an endpoint deletes its row here.
const pending: Array<{ method: 'get' | 'post' | 'patch'; path: string; session: string }> = [
  {
    method: 'get',
    path: '/api/rules/31545105-3444-4584-bebf-c466353230d2/playbook',
    session: 'S7',
  },
];

describe('endpoints not implemented yet', () => {
  // Signed in: since S6 every route behind the session guard needs a session row.
  let db: TestDatabase;
  let app: ReturnType<typeof createTestApp>['app'];
  beforeAll(async () => {
    db = await createTestDatabase();
    ({ app } = createTestApp({ pool: db.pool }));
  });
  afterAll(() => db.cleanup());

  it.each(pending)(
    '$method $path answers 501 problem+json ($session)',
    async ({ method, path, session }) => {
      const res = await request(app)[method](path).expect(501);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      const body = problemSchema.parse(res.body);
      expect(body).toMatchObject({ type: 'about:blank', title: 'Not Implemented', status: 501 });
      expect(body.detail).toContain(`session ${session}`);
      expect(body.detail).toContain(`${method.toUpperCase()} /api/`);
    },
  );
});
