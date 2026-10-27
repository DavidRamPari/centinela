-- Up Migration

-- Dashboard sessions (S6). The cookie holds a random token; only its HMAC (keyed with
-- SESSION_SECRET) is stored, so a copy of this table cannot be replayed as cookies.
CREATE TABLE admin_sessions (
  id_hash       bytea PRIMARY KEY,
  username      text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  ip            inet,
  user_agent    text
);
CREATE INDEX admin_sessions_expires_idx ON admin_sessions (expires_at);

-- Bearer tokens for POST /api/ingest. Only the SHA-256 of the secret is stored.
CREATE TABLE ingest_tokens (
  id            uuid PRIMARY KEY,
  label         text NOT NULL,
  token_hash    bytea NOT NULL UNIQUE,
  prefix        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    text
);
CREATE INDEX ingest_tokens_created_idx ON ingest_tokens (created_at DESC, id DESC);

-- Append-only record of analyst actions: logins, triage, rule and token changes, uploads.
CREATE TABLE audit_log (
  id       uuid PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  actor    text,
  action   text NOT NULL,
  target   text,
  ip       inet,
  details  jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC, id DESC);
CREATE INDEX audit_log_action_at_idx ON audit_log (action, at DESC);

-- Down Migration

DROP TABLE audit_log;
DROP TABLE ingest_tokens;
DROP TABLE admin_sessions;
