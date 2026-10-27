-- Up Migration

-- Audit rows are read in insertion order. `at` has millisecond precision and several rows
-- can share it (a failed sign-in and the lockout it triggers); a sequence gives every row a
-- strictly increasing position, used for ordering and keyset cursors (S6-17).
ALTER TABLE audit_log ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX audit_log_seq_idx ON audit_log (seq DESC);
CREATE INDEX audit_log_action_seq_idx ON audit_log (action, seq DESC);
DROP INDEX audit_log_at_idx;
DROP INDEX audit_log_action_at_idx;

-- Down Migration

CREATE INDEX audit_log_at_idx ON audit_log (at DESC, id DESC);
CREATE INDEX audit_log_action_at_idx ON audit_log (action, at DESC);
DROP INDEX audit_log_action_seq_idx;
DROP INDEX audit_log_seq_idx;
ALTER TABLE audit_log DROP COLUMN seq;
