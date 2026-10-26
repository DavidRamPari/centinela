import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  auditEntrySchema,
  auditPageSchema,
  auditQuerySchema,
  ingestTokenCreateBodySchema,
  ingestTokenCreatedSchema,
  ingestTokenListSchema,
  ingestTokenSchema,
  loginBodySchema,
  sessionInfoSchema,
} from '../src/index.js';

const token = {
  id: '01930f6e-8a4b-7c2d-9e1f-0a1b2c3d4e5f',
  label: 'web-01 shipper',
  prefix: 'cnt_AbCd1234',
  createdAt: '2026-10-26T10:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
};
const entry = {
  id: '01930f6e-8a4b-7c2d-9e1f-0a1b2c3d4e60',
  at: '2026-10-26T10:00:00.000Z',
  actor: 'admin',
  action: 'alert.triage',
  target: '01930f6e-8a4b-7c2d-9e1f-0a1b2c3d4e5f',
  ip: '203.0.113.9',
  details: { status: 'closed', updated: ['a', 'b'], nested: { ok: true }, count: 2, note: null },
};

const cases: Array<{ name: string; schema: z.ZodType; valid: unknown; invalid: unknown[] }> = [
  {
    name: 'loginBodySchema',
    schema: loginBodySchema,
    valid: { username: 'admin', password: 'correct horse' },
    invalid: [
      {},
      { username: '', password: 'x' },
      { username: 'admin', password: '' },
      { username: 'admin', password: 'x', remember: true },
      { username: 'a'.repeat(129), password: 'x' },
    ],
  },
  {
    name: 'sessionInfoSchema',
    schema: sessionInfoSchema,
    valid: { username: 'admin', expiresAt: '2026-10-26T22:00:00.000Z' },
    invalid: [{ username: 'admin' }, { username: '', expiresAt: '2026-10-26T22:00:00.000Z' }],
  },
  {
    name: 'ingestTokenSchema',
    schema: ingestTokenSchema,
    valid: token,
    invalid: [
      { ...token, id: 'x' },
      { ...token, label: '' },
      { ...token, revokedAt: 'yesterday' },
    ],
  },
  {
    name: 'ingestTokenListSchema',
    schema: ingestTokenListSchema,
    valid: { items: [token] },
    invalid: [{ items: [{ ...token, prefix: '' }] }, [token]],
  },
  {
    name: 'ingestTokenCreateBodySchema',
    schema: ingestTokenCreateBodySchema,
    valid: { label: 'shipper' },
    invalid: [
      { label: '' },
      { label: '   ' },
      { label: 'x'.repeat(101) },
      { label: 'bell\u0007' },
      { label: 'rtl‮override' },
      { label: 'ok', extra: 1 },
    ],
  },
  {
    name: 'ingestTokenCreatedSchema',
    schema: ingestTokenCreatedSchema,
    valid: { token, secret: `cnt_${'a'.repeat(43)}` },
    invalid: [{ token, secret: 'short' }, { secret: `cnt_${'a'.repeat(43)}` }],
  },
  {
    name: 'auditEntrySchema',
    schema: auditEntrySchema,
    valid: entry,
    invalid: [
      { ...entry, action: 'alert.delete' },
      { ...entry, details: 'text' },
      { ...entry, at: 'now' },
    ],
  },
  {
    name: 'auditPageSchema',
    schema: auditPageSchema,
    valid: { items: [entry], nextCursor: null },
    invalid: [{ items: [entry] }, { items: [], nextCursor: 'not base64url!' }],
  },
];

describe('auth schemas', () => {
  it.each(cases)(
    '$name parses a valid sample and rejects invalid ones',
    ({ schema, valid, invalid }) => {
      expect(schema.safeParse(valid).success).toBe(true);
      for (const value of invalid)
        expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    },
  );

  it('trims token labels', () => {
    expect(ingestTokenCreateBodySchema.parse({ label: '  shipper ' }).label).toBe('shipper');
  });

  it('parses audit queries with action lists and defaults', () => {
    expect(auditQuerySchema.parse({ action: 'auth.login,auth.logout' })).toEqual({
      action: ['auth.login', 'auth.logout'],
      limit: 50,
    });
    expect(auditQuerySchema.safeParse({ action: 'auth.delete' }).success).toBe(false);
    expect(auditQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
  });
});
