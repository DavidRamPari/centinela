import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  alertBulkBodySchema,
  alertBulkResponseSchema,
  alertChangeSchema,
  alertDetailResponseSchema,
  alertPatchBodySchema,
  alertsPageSchema,
  alertsQuerySchema,
  attackQuerySchema,
  attackResponseSchema,
  eventsPageSchema,
  eventsQuerySchema,
  healthResponseSchema,
  ingestQuerySchema,
  ingestSummarySchema,
  problemSchema,
  ruleDetailResponseSchema,
  ruleIdParamsSchema,
  ruleListItemSchema,
  rulePatchBodySchema,
  rulesPageSchema,
  rulesQuerySchema,
  statsOverviewQuerySchema,
  statsOverviewResponseSchema,
  uuidParamsSchema,
} from '../src/index.js';
import { validAlert, validEvent, validRule } from './fixtures.js';

interface SchemaCase {
  name: string;
  schema: z.ZodType;
  valid: unknown;
  invalid: unknown[];
}

const overview = {
  events: 1200,
  alerts: {
    total: 3,
    byLevel: { informational: 0, low: 1, medium: 0, high: 1, critical: 1 },
    byStatus: { new: 2, acknowledged: 1, closed: 0 },
  },
  eventsOverTime: [{ t: '2026-10-21T03:00:00Z', count: 1200 }],
  alertsOverTime: [{ t: '2026-10-21T03:00:00Z', count: 3 }],
  topSourceIps: [{ ip: '203.0.113.45', count: 300 }],
  topUsers: [{ user: 'root', count: 150 }],
  topRules: [{ ruleId: validAlert.ruleId, title: validAlert.ruleTitle, level: 'high', count: 1 }],
};

const cases: SchemaCase[] = [
  {
    name: 'problemSchema',
    schema: problemSchema,
    valid: {
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'Invalid query',
      errors: [{ path: 'limit', message: 'Too big' }],
    },
    invalid: [
      { type: 'about:blank', title: 'OK', status: 200 },
      { title: 'Missing type', status: 400 },
    ],
  },
  {
    name: 'healthResponseSchema',
    schema: healthResponseSchema,
    valid: { status: 'ok', db: 'ok', version: '0.1.0' },
    invalid: [
      { status: 'ok', db: 'unknown', version: '0.1.0' },
      { status: 'ok', db: 'ok' },
    ],
  },
  {
    name: 'ingestQuerySchema',
    schema: ingestQuerySchema,
    valid: { source: 'nginx_access', host: 'web-01', tz: 'America/Lima' },
    invalid: [
      { source: 'syslog' },
      { source: 'linux_auth', tz: 'Mars/Olympus_Mons' },
      { source: 'linux_auth', host: 'web 01; rm -rf /' },
    ],
  },
  {
    name: 'ingestSummarySchema',
    schema: ingestSummarySchema,
    valid: {
      accepted: 10,
      rejected: 1,
      rejections: [{ line: 3, reason: 'not an access log line' }],
      alertsCreated: 0,
      alertsUpdated: 0,
      durationMs: 12.5,
    },
    invalid: [
      {
        accepted: -1,
        rejected: 0,
        rejections: [],
        alertsCreated: 0,
        alertsUpdated: 0,
        durationMs: 1,
      },
      {
        accepted: 0,
        rejected: 21,
        rejections: Array.from({ length: 21 }, (_, i) => ({ line: i + 1, reason: 'x' })),
        alertsCreated: 0,
        alertsUpdated: 0,
        durationMs: 1,
      },
    ],
  },
  {
    name: 'eventsQuerySchema',
    schema: eventsQuerySchema,
    valid: {
      from: '2026-10-21T00:00:00Z',
      to: '2026-10-21T23:59:59-05:00',
      source: 'linux_auth',
      outcome: 'failure',
      q: 'Failed password',
      limit: '100',
    },
    invalid: [
      { limit: '201' },
      { limit: '0' },
      { from: 'yesterday' },
      { from: '2026-10-22T00:00:00Z', to: '2026-10-21T00:00:00Z' },
      { cursor: 'not base64url!' },
      { outcome: 'ok' },
    ],
  },
  {
    name: 'eventsPageSchema',
    schema: eventsPageSchema,
    valid: { items: [validEvent], nextCursor: 'MjAyNi0xMC0yMXwx' },
    invalid: [{ items: [validEvent] }, { items: [{ ...validEvent, id: 'x' }], nextCursor: null }],
  },
  {
    name: 'alertsQuerySchema',
    schema: alertsQuerySchema,
    valid: { status: 'new,acknowledged', level: ['high', 'critical'], technique: 'T1110.001' },
    invalid: [{ level: 'high,severe' }, { status: '' }, { technique: 'credential-access' }],
  },
  {
    name: 'alertsPageSchema',
    schema: alertsPageSchema,
    valid: { items: [validAlert], nextCursor: null },
    invalid: [{ items: [{ ...validAlert, level: 'severe' }], nextCursor: null }],
  },
  {
    name: 'alertDetailResponseSchema',
    schema: alertDetailResponseSchema,
    valid: { alert: validAlert, rule: validRule, events: [validEvent] },
    invalid: [
      { alert: validAlert, events: [validEvent] },
      { alert: validAlert, rule: null, events: Array.from({ length: 101 }, () => validEvent) },
    ],
  },
  {
    name: 'alertPatchBodySchema',
    schema: alertPatchBodySchema,
    valid: { status: 'closed', resolution: 'false_positive', note: 'Backup job' },
    invalid: [
      { status: 'closed' },
      { status: 'acknowledged', resolution: 'benign' },
      { status: 'new', extra: true },
      { status: 'new', note: 'x'.repeat(4001) },
    ],
  },
  {
    name: 'alertBulkBodySchema',
    schema: alertBulkBodySchema,
    valid: { ids: [validAlert.id], status: 'acknowledged' },
    invalid: [
      { ids: [], status: 'acknowledged' },
      { ids: ['not-a-uuid'], status: 'acknowledged' },
      { ids: [validAlert.id], status: 'closed' },
    ],
  },
  {
    name: 'alertBulkResponseSchema',
    schema: alertBulkResponseSchema,
    valid: { updated: 2 },
    invalid: [{ updated: -1 }, {}],
  },
  {
    name: 'rulesQuerySchema',
    schema: rulesQuerySchema,
    valid: { q: 'ssh', origin: 'centinela', supported: 'true', enabled: 'false' },
    invalid: [{ supported: 'yes' }, { origin: 'elastic' }],
  },
  {
    name: 'ruleListItemSchema',
    schema: ruleListItemSchema,
    valid: { ...validRule, matches: 4 },
    invalid: [validRule, { ...validRule, matches: -1 }],
  },
  {
    name: 'rulesPageSchema',
    schema: rulesPageSchema,
    valid: { items: [{ ...validRule, matches: 0 }], nextCursor: null },
    invalid: [{ items: [validRule], nextCursor: null }],
  },
  {
    name: 'ruleDetailResponseSchema',
    schema: ruleDetailResponseSchema,
    valid: { rule: validRule, source: 'title: Example\n' },
    invalid: [{ rule: validRule }],
  },
  {
    name: 'rulePatchBodySchema',
    schema: rulePatchBodySchema,
    valid: { enabled: false },
    invalid: [{ enabled: 'false' }, { enabled: true, level: 'low' }],
  },
  {
    name: 'statsOverviewQuerySchema',
    schema: statsOverviewQuerySchema,
    valid: { bucket: '5m', from: '2026-10-20T00:00:00Z' },
    invalid: [{ bucket: '15m' }],
  },
  {
    name: 'statsOverviewResponseSchema',
    schema: statsOverviewResponseSchema,
    valid: overview,
    invalid: [
      { ...overview, alerts: { ...overview.alerts, byLevel: { high: 1 } } },
      { ...overview, events: -5 },
    ],
  },
  {
    name: 'attackQuerySchema',
    schema: attackQuerySchema,
    valid: { from: '2026-10-20T00:00:00Z', to: '2026-10-21T00:00:00Z' },
    invalid: [{ to: 'tomorrow' }],
  },
  {
    name: 'attackResponseSchema',
    schema: attackResponseSchema,
    valid: {
      tactics: [
        {
          id: 'TA0006',
          shortname: 'credential-access',
          name: 'Credential Access',
          techniques: [
            {
              id: 'T1110.001',
              name: 'Password Guessing',
              url: 'https://attack.mitre.org/techniques/T1110/001',
              rules: 2,
              alerts: 1,
            },
          ],
        },
      ],
    },
    invalid: [
      { tactics: [{ id: 'credential-access', shortname: 'x', name: 'x', techniques: [] }] },
    ],
  },
  {
    name: 'alertChangeSchema',
    schema: alertChangeSchema,
    valid: { type: 'alert.created', alert: validAlert },
    invalid: [{ type: 'alert.deleted', alert: validAlert }],
  },
  {
    name: 'uuidParamsSchema',
    schema: uuidParamsSchema,
    valid: { id: validEvent.id },
    invalid: [{ id: '1' }, { id: "' OR 1=1--" }],
  },
  {
    name: 'ruleIdParamsSchema',
    schema: ruleIdParamsSchema,
    valid: { id: validRule.id },
    invalid: [{ id: '../../etc/passwd' }],
  },
];

describe.each(cases)('$name', ({ schema, valid, invalid }) => {
  it('parses a valid sample', () => {
    const result = schema.safeParse(valid);
    expect(result.error).toBeUndefined();
  });

  it.each(invalid.map((sample, index) => ({ sample, index })))(
    'rejects invalid sample #$index',
    ({ sample }) => {
      expect(schema.safeParse(sample).success).toBe(false);
    },
  );
});

describe('query coercion', () => {
  it('applies defaults and coerces strings', () => {
    expect(eventsQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(ingestQuerySchema.parse({ source: 'linux_auth' })).toEqual({
      source: 'linux_auth',
      host: 'unknown',
      tz: 'UTC',
    });
    expect(rulesQuerySchema.parse({ supported: 'false' }).supported).toBe(false);
    expect(statsOverviewQuerySchema.parse({}).bucket).toBe('1h');
  });

  it('splits, trims and de-duplicates comma-separated enum lists', () => {
    expect(alertsQuerySchema.parse({ level: 'high, critical,high' }).level).toEqual([
      'high',
      'critical',
    ]);
    expect(alertsQuerySchema.parse({ status: ['new', 'closed,new'] }).status).toEqual([
      'new',
      'closed',
    ]);
  });
});
