-- Up Migration

-- Live detection (S12, ARCHITECTURE §8.1): organizations, delivery streams, the stream of
-- every event and the detector checkpoint.

-- Centinela has one organization until several are supported. Tables created from this
-- migration on carry tenant_id, so separating organizations later needs no rewrite of
-- these tables. It is a column, not yet a security boundary.
CREATE TABLE tenants (
  id          uuid PRIMARY KEY,
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tenants (id, slug, name)
VALUES ('00000000-0000-7000-8000-000000000001', 'default', 'Default organization');

-- One row per delivery path: who sent events, for which source and host.
CREATE TABLE ingest_streams (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL DEFAULT '00000000-0000-7000-8000-000000000001' REFERENCES tenants (id),
  kind           text NOT NULL CHECK (kind IN ('token', 'upload', 'cli', 'collector', 'connector')),
  -- null for the INGEST_TOKEN variable and for kinds without a token
  token_id       uuid REFERENCES ingest_tokens (id),
  source         text NOT NULL,
  host           text NOT NULL,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_event_ts  timestamptz,
  accepted       bigint NOT NULL DEFAULT 0,
  rejected       bigint NOT NULL DEFAULT 0,
  late           bigint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX ingest_streams_path_idx
  ON ingest_streams (tenant_id, kind, token_id, source, host) NULLS NOT DISTINCT;

-- Which stream delivered each event; null for events stored before this migration.
ALTER TABLE events ADD COLUMN stream_id uuid;

-- Correlation windows and the reorder buffer live in memory (D-003); the server saves
-- them here so a restart does not lose them.
CREATE TABLE detector_checkpoints (
  tenant_id      uuid NOT NULL DEFAULT '00000000-0000-7000-8000-000000000001' REFERENCES tenants (id),
  name           text NOT NULL DEFAULT 'live',
  -- id of the last event handed to the reorder buffer
  position       uuid,
  -- gzip of the JSON snapshot
  state          bytea NOT NULL,
  state_version  integer NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, name)
);

-- Down Migration

DROP TABLE detector_checkpoints;
ALTER TABLE events DROP COLUMN stream_id;
DROP TABLE ingest_streams;
DROP TABLE tenants;
