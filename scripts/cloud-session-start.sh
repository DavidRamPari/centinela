#!/usr/bin/env bash
# Prepares a Claude Code cloud session for Centinela:
#   1. starts PostgreSQL and creates the `centinela` role and database,
#   2. exports DATABASE_URL for the session,
#   3. runs `npm ci` when package-lock.json changed since the last install.
# Runs as a SessionStart hook (see .claude/settings.json). On local machines it exits immediately.
# It never fails the session: problems are logged and the script exits 0.

set -u

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" || exit 0

LOG=/tmp/centinela-session-start.log
DB_URL="postgres://centinela:centinela@localhost:5432/centinela"
DB_STATUS="not ready"
NPM_STATUS="skipped (no package-lock.json yet)"

# Diagnostics go to stderr and the log file; stdout is reserved for the one-line
# summary at the end, which Claude Code adds to the session context.
log() { echo "[centinela session-start] $*" >>"$LOG"; echo "[centinela session-start] $*" >&2; }

# 1. PostgreSQL ---------------------------------------------------------------
if command -v pg_isready >/dev/null 2>&1; then
  if ! pg_isready -q 2>/dev/null; then
    service postgresql start >>"$LOG" 2>&1 || log "could not start postgresql (see $LOG)"
  fi
  for _ in $(seq 1 30); do
    pg_isready -q 2>/dev/null && break
    sleep 0.5
  done
  if pg_isready -q 2>/dev/null; then
    if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname = 'centinela'\"" 2>>"$LOG" | grep -q 1; then
      su postgres -c "psql -c \"CREATE ROLE centinela LOGIN SUPERUSER PASSWORD 'centinela'\"" >>"$LOG" 2>&1 \
        || log "could not create role centinela"
    fi
    if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname = 'centinela'\"" 2>>"$LOG" | grep -q 1; then
      su postgres -c "createdb -O centinela centinela" >>"$LOG" 2>&1 \
        || log "could not create database centinela"
    fi
    log "postgresql ready at $DB_URL"
    DB_STATUS="ready at $DB_URL"
  else
    log "postgresql is not ready; run 'service postgresql start' and re-run this script"
  fi
else
  log "pg_isready not found; is PostgreSQL installed in this environment?"
fi

# 2. Environment for the rest of the session ----------------------------------
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  if ! grep -q '^export DATABASE_URL=' "$CLAUDE_ENV_FILE" 2>/dev/null; then
    echo "export DATABASE_URL=$DB_URL" >> "$CLAUDE_ENV_FILE"
  fi
fi

# 3. Node dependencies --------------------------------------------------------
if [ -f package-lock.json ]; then
  HASH_FILE=node_modules/.centinela-lock.sha256
  if sha256sum --check --status "$HASH_FILE" 2>/dev/null; then
    NPM_STATUS="up to date"
  else
    rm -f "$HASH_FILE"
    log "installing npm dependencies (npm ci)"
    if npm ci --no-audit --no-fund >>"$LOG" 2>&1; then
      sha256sum package-lock.json > "$HASH_FILE" 2>/dev/null || true
      log "npm dependencies installed"
      NPM_STATUS="installed"
    else
      log "npm ci failed; see $LOG and run it manually"
      NPM_STATUS="npm ci FAILED (see $LOG)"
    fi
  fi
fi

echo "Centinela session setup: PostgreSQL ${DB_STATUS}; npm dependencies ${NPM_STATUS}. Re-run with: bash scripts/cloud-session-start.sh"
exit 0
