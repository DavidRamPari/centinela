/**
 * Authentication, ingest tokens and the audit log (session S6): request and response
 * schemas for `/api/auth/*`, `/api/tokens` and `/api/audit` (ARCHITECTURE §9).
 */
import { z } from 'zod';
import { cursorSchema, csvEnumSchema, limitSchema, pageSchema } from './api.js';
import { utcTimestampSchema } from './events.js';

// ---------------------------------------------------------------------------
// Cookies and headers shared by the server and the dashboard
// ---------------------------------------------------------------------------

/** httpOnly session cookie; the `__Host-` prefix forces `Secure`, `Path=/` and no `Domain`. */
export const SESSION_COOKIE = '__Host-centinela';
/** CSRF double-submit cookie, readable by the dashboard's JavaScript. */
export const CSRF_COOKIE = '__Host-centinela-csrf';
/**
 * The same two cookies without the prefix and without `Secure`, used only in development
 * over plain HTTP on `localhost`: WebKit (Safari) does not store `Secure` cookies from
 * `http://localhost`, and a `__Host-` cookie must be `Secure`. HTTPS and production always
 * use the `__Host-` names.
 */
export const LOCAL_SESSION_COOKIE = 'centinela-local';
export const LOCAL_CSRF_COOKIE = 'centinela-local-csrf';
/** Header that must repeat the CSRF cookie on every state-changing request. */
export const CSRF_HEADER = 'X-CSRF-Token';

// ---------------------------------------------------------------------------
// POST /api/auth/login, GET /api/auth/me, POST /api/auth/logout
// ---------------------------------------------------------------------------

export const MAX_USERNAME_LENGTH = 128;
export const MAX_PASSWORD_LENGTH = 1024;

export const loginBodySchema = z.strictObject({
  username: z.string().min(1).max(MAX_USERNAME_LENGTH),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

/** The signed-in analyst; answer of `POST /api/auth/login` and `GET /api/auth/me`. */
export const sessionInfoSchema = z.object({
  username: z.string().min(1),
  /** Absolute end of the session; idle sessions end earlier. */
  expiresAt: utcTimestampSchema,
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

// ---------------------------------------------------------------------------
// Ingest tokens: GET/POST /api/tokens, POST /api/tokens/:id/revoke
// ---------------------------------------------------------------------------

export const MAX_TOKEN_LABEL_LENGTH = 100;

/** A stored ingest token. The secret itself is shown once, when the token is created. */
export const ingestTokenSchema = z.object({
  id: z.uuid(),
  label: z.string().min(1).max(MAX_TOKEN_LABEL_LENGTH),
  /** First characters of the secret, so an operator can tell tokens apart. */
  prefix: z.string().min(1),
  createdAt: utcTimestampSchema,
  lastUsedAt: utcTimestampSchema.nullable(),
  revokedAt: utcTimestampSchema.nullable(),
});
export type IngestToken = z.infer<typeof ingestTokenSchema>;

export const ingestTokenListSchema = z.object({ items: z.array(ingestTokenSchema) });
export type IngestTokenList = z.infer<typeof ingestTokenListSchema>;

export const ingestTokenCreateBodySchema = z.strictObject({
  label: z
    .string()
    .trim()
    .min(1)
    .max(MAX_TOKEN_LABEL_LENGTH)
    // Printable text only: the label is shown in the dashboard and written to the audit log.
    .regex(/^[^\p{Cc}\p{Cf}]+$/u, 'label must not contain control characters'),
});
export type IngestTokenCreateBody = z.infer<typeof ingestTokenCreateBodySchema>;

export const ingestTokenCreatedSchema = z.object({
  token: ingestTokenSchema,
  /** The bearer token for `POST /api/ingest`; it cannot be shown again. */
  secret: z.string().min(32),
});
export type IngestTokenCreated = z.infer<typeof ingestTokenCreatedSchema>;

// ---------------------------------------------------------------------------
// Audit log: GET /api/audit
// ---------------------------------------------------------------------------

export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.lockout',
  'auth.logout',
  'alert.triage',
  'alert.bulk_triage',
  'rule.update',
  'token.create',
  'token.revoke',
  'ingest.upload',
] as const;
export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const auditEntrySchema = z.object({
  id: z.uuid(),
  at: utcTimestampSchema,
  /** Signed-in analyst, or the attempted user name for a failed login (attacker-chosen). */
  actor: z.string().nullable(),
  action: auditActionSchema,
  /** Alert, rule or token id the action applies to. */
  target: z.string().nullable(),
  ip: z.string().nullable(),
  details: z.record(z.string(), z.json()),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditQuerySchema = z.object({
  action: csvEnumSchema(AUDIT_ACTIONS).optional(),
  cursor: cursorSchema.optional(),
  limit: limitSchema,
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const auditPageSchema = pageSchema(auditEntrySchema);
export type AuditPage = z.infer<typeof auditPageSchema>;
