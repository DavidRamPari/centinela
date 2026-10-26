import { eventsPageSchema, normalizedEventSchema, problemSchema } from '@centinela/shared';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeCursor } from '../../src/db/cursor.js';
import { createEventStore } from '../../src/db/events-write.js';
import { createTestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { ago, HOUR, MINUTE, testEvent } from '../helpers/seed.js';

const T0 = Date.now();

const events = [
  testEvent({ ts: ago(10 * MINUTE, T0) }),
  testEvent({ ts: ago(20 * MINUTE, T0), user: 'admin', srcIp: '198.51.100.23' }),
  testEvent({ ts: ago(30 * MINUTE, T0), outcome: 'success', action: 'ssh_login', user: 'deploy' }),
  testEvent({
    ts: ago(40 * MINUTE, T0),
    source: 'nginx_access',
    host: 'Web-01',
    logsources: [{ category: 'webserver' }, { service: 'nginx' }],
    category: 'web',
    action: 'http_request',
    outcome: 'failure',
    user: undefined,
    srcIp: '2001:db8::10',
    message:
      '2001:db8::10 - - [25/Oct/2026:10:00:00 -0500] "GET /index.php?id=1%27%20UNION%20ALL%20SELECT HTTP/1.1" 500 0 "-" "sqlmap/1.8#stable"',
    fields: { 'cs-method': 'GET', 'sc-status': 500, 'source.ip': '2001:db8::10' },
  }),
  testEvent({
    ts: ago(50 * MINUTE, T0),
    host: 'db-01',
    action: 'sudo_not_in_sudoers',
    category: 'iam',
    user: 'intern',
    srcIp: undefined,
    srcPort: undefined,
    logsources: [
      { product: 'linux', service: 'sudo' },
      { product: 'linux', service: 'auth' },
    ],
    message:
      'intern : user NOT in sudoers ; TTY=pts/1 ; PWD=/home/intern ; USER=root ; COMMAND=/bin/cat /etc/shadow',
    fields: { 'process.name': 'sudo', 'event.action': 'sudo_not_in_sudoers' },
  }),
  // Outside the default 24-hour range.
  testEvent({ ts: ago(30 * HOUR, T0), user: 'old' }),
  // Same timestamp as another event: ties are ordered by id.
  ...Array.from({ length: 3 }, () => testEvent({ ts: ago(60 * MINUTE, T0), user: 'tie' })),
];

describe('GET /api/events and /api/events/:id', () => {
  let db: TestDatabase;
  let app: ReturnType<typeof createTestApp>['app'];

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ app } = createTestApp({ pool: db.pool }));
    await createEventStore(db.pool).insertMany(events);
  });
  afterAll(() => db.cleanup());

  async function list(query: string) {
    const res = await request(app).get(`/api/events?${query}`).expect(200);
    return eventsPageSchema.parse(res.body);
  }

  async function users(query: string) {
    return (await list(query)).items.map((e) => e.user ?? e.srcIp);
  }

  describe('happy path', () => {
    it('returns the last 24 hours newest first, as schema-valid events', async () => {
      const page = await list('');
      expect(page.items).toHaveLength(8);
      expect(page.nextCursor).toBeNull();
      const times = page.items.map((e) => e.ts);
      expect(times).toEqual([...times].sort().reverse());
      expect(page.items.some((e) => e.user === 'old')).toBe(false);
    });

    it('returns stored events exactly, rebuilding their logsources', async () => {
      const page = await list('source=nginx_access');
      expect(page.items).toEqual([events[3]]);
      const sudo = (await list('action=sudo_not_in_sudoers')).items[0];
      expect(sudo?.logsources).toEqual([
        { product: 'linux', service: 'sudo' },
        { product: 'linux', service: 'auth' },
      ]);
      expect(sudo?.srcIp).toBeUndefined();
    });

    it('defaults `to` to now when only `from` is given (S3-03)', async () => {
      const page = await list(`from=${encodeURIComponent(ago(35 * HOUR, T0))}`);
      expect(page.items).toHaveLength(9);
    });

    it('honours an explicit range', async () => {
      const from = encodeURIComponent(ago(45 * MINUTE, T0));
      const to = encodeURIComponent(ago(15 * MINUTE, T0));
      expect(await users(`from=${from}&to=${to}`)).toEqual(['admin', 'deploy', '2001:db8::10']);
    });

    it.each([
      ['source', 'source=nginx_access', ['2001:db8::10']],
      ['host (case-insensitive)', 'host=WEB-01', ['2001:db8::10']],
      ['user', 'user=deploy', ['deploy']],
      ['IPv4', 'ip=198.51.100.23', ['admin']],
      ['IPv6', 'ip=2001:db8::10', ['2001:db8::10']],
      ['action', 'action=sudo_not_in_sudoers', ['intern']],
      ['outcome', 'outcome=success', ['deploy']],
      ['combined filters', 'host=bastion-01&outcome=failure&user=admin', ['admin']],
    ])('filters by %s', async (_name, query, expected) => {
      expect(await users(query)).toEqual(expected);
    });

    it.each([
      ['a token prefix', 'sqlmap', ['2001:db8::10']],
      ['every word (AND), any case', 'FAILED password 198.51.100.23', ['admin']],
      ['a path token', '/etc/shadow', ['intern']],
      ['an IP address', '203.0.113.45', ['root', 'deploy', 'tie', 'tie', 'tie']],
      ['a word that is not there', 'mimikatz', []],
    ])('searches the message for %s', async (_name, q, expected) => {
      expect(await users(`q=${encodeURIComponent(q)}`)).toEqual(expected);
    });

    it.each(["' OR 1=1--", '&|!():*<->', '\\', "it's", 'a & b | !c'])(
      'treats search operators literally (%s)',
      async (q) => {
        await list(`q=${encodeURIComponent(q)}`);
      },
    );
  });

  describe('pagination', () => {
    it('walks every page exactly once, ties ordered by id', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await list(`limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((e) => e.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null);
      expect(pages).toBe(4);
      const all = (await list('limit=200')).items.map((e) => e.id);
      expect(seen).toEqual(all);
      const ties = events.filter((e) => e.user === 'tie').map((e) => e.id);
      expect(all.filter((id) => ties.includes(id))).toEqual([...ties].sort().reverse());
    });

    it('returns no cursor when the last page is exactly full', async () => {
      expect((await list('limit=8')).nextCursor).toBeNull();
      expect((await list('limit=7')).nextCursor).not.toBeNull();
    });

    it('returns an empty page after the last event', async () => {
      const last = (await list('limit=200')).items.at(-1);
      if (!last) throw new Error('no events');
      const page = await list(`cursor=${encodeCursor(last)}`);
      expect(page).toEqual({ items: [], nextCursor: null });
    });
  });

  describe('validation', () => {
    it.each([
      ['limit above 200', 'limit=201'],
      ['limit 0', 'limit=0'],
      ['a non-numeric limit', 'limit=ten'],
      ['a cursor that is not base64url', 'cursor=abc$'],
      ['a cursor the server did not produce', `cursor=${Buffer.from('x|y').toString('base64url')}`],
      ['`from` after `to`', `from=${ago(0, T0)}&to=${ago(HOUR, T0)}`],
      ['a date without an offset', 'from=2026-10-25T10:00:00'],
      ['an unknown source', 'source=windows'],
      ['an unknown outcome', 'outcome=maybe'],
      ['an invalid IP', 'ip=10.20'],
      ['a repeated filter', 'user=a&user=b'],
      ['an empty filter', 'host='],
    ])('answers 400 for %s', async (_name, query) => {
      const res = await request(app).get(`/api/events?${query}`).expect(400);
      expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(problemSchema.parse(res.body).errors?.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/events/:id', () => {
    it('returns one event', async () => {
      const res = await request(app).get(`/api/events/${events[1]?.id}`).expect(200);
      expect(normalizedEventSchema.parse(res.body)).toEqual(events[1]);
    });

    it('answers 404 for an unknown id and 400 for an invalid one', async () => {
      const missing = await request(app).get(`/api/events/${uuidv7()}`).expect(404);
      expect(problemSchema.parse(missing.body).detail).toBe('Event not found');
      await request(app).get('/api/events/not-a-uuid').expect(400);
    });
  });
});
