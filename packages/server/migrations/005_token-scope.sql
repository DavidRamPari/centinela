-- Up Migration

-- Scoped ingest tokens (S11, ARCHITECTURE §9): the source types and hosts a token may send
-- for. An empty list allows everything, so tokens created before this migration keep
-- working. Hosts are lower-cased names, or the start of one followed by `*`; they are
-- compared in code and never compiled as a regex.
ALTER TABLE ingest_tokens
  ADD COLUMN allowed_sources text[] NOT NULL DEFAULT '{}',
  ADD COLUMN allowed_hosts text[] NOT NULL DEFAULT '{}';

-- Down Migration

ALTER TABLE ingest_tokens
  DROP COLUMN allowed_hosts,
  DROP COLUMN allowed_sources;
