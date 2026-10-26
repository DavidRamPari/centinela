-- Migration 001: initial schema (docs/ARCHITECTURE.md §8).

-- Up Migration

CREATE TABLE events (
  id           uuid PRIMARY KEY,
  ts           timestamptz NOT NULL,
  ingested_at  timestamptz NOT NULL DEFAULT now(),
  source       text NOT NULL,
  host         text NOT NULL,
  category     text NOT NULL,
  action       text NOT NULL,
  outcome      text NOT NULL,
  user_name    text,
  src_ip       inet,
  src_port     integer,
  message      text NOT NULL,
  fields       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX events_ts_idx         ON events (ts DESC, id DESC);
CREATE INDEX events_source_ts_idx  ON events (source, ts DESC);
CREATE INDEX events_host_ts_idx    ON events (host, ts DESC);
CREATE INDEX events_src_ip_ts_idx  ON events (src_ip, ts DESC);
CREATE INDEX events_user_ts_idx    ON events (user_name, ts DESC);
CREATE INDEX events_action_ts_idx  ON events (action, ts DESC);
CREATE INDEX events_message_fts    ON events USING gin (to_tsvector('simple', message));

CREATE TABLE alerts (
  id          uuid PRIMARY KEY,
  rule_id     text NOT NULL,
  rule_title  text NOT NULL,
  rule_type   text NOT NULL CHECK (rule_type IN ('sigma', 'correlation')),
  level       text NOT NULL CHECK (level IN ('informational', 'low', 'medium', 'high', 'critical')),
  status      text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'acknowledged', 'closed')),
  resolution  text CHECK (resolution IN ('true_positive', 'false_positive', 'benign')),
  note        text,
  dedup_key   text NOT NULL,
  group_key   text,
  host        text,
  techniques  text[] NOT NULL DEFAULT '{}',
  tactics     text[] NOT NULL DEFAULT '{}',
  entities    jsonb NOT NULL DEFAULT '{"ips":[],"users":[],"hosts":[]}'::jsonb,
  first_seen  timestamptz NOT NULL,
  last_seen   timestamptz NOT NULL,
  count       integer NOT NULL DEFAULT 1,
  author      text,
  rule_url    text,
  license     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alerts_last_seen_idx    ON alerts (last_seen DESC, id DESC);
CREATE INDEX alerts_status_level_idx ON alerts (status, level);
CREATE INDEX alerts_rule_idx         ON alerts (rule_id);
CREATE INDEX alerts_dedup_open_idx   ON alerts (dedup_key) WHERE status <> 'closed';
CREATE INDEX alerts_techniques_idx   ON alerts USING gin (techniques);

CREATE TABLE alert_events (
  alert_id  uuid NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
  event_id  uuid NOT NULL,
  PRIMARY KEY (alert_id, event_id)
);

CREATE TABLE rule_state (
  rule_id     text PRIMARY KEY,
  enabled     boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE rule_state;
DROP TABLE alert_events;
DROP TABLE alerts;
DROP TABLE events;
