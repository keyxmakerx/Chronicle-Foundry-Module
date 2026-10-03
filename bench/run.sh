#!/usr/bin/env bash
# Run the two-sided sync bench: a real Chronicle (built from CHRONICLE_DIR)
# and the module's real sync code in a fake Foundry world.
#
#   CHRONICLE_DIR=../Chronicle bench/run.sh            # all bench files
#   CHRONICLE_DIR=../Chronicle bench/run.sh journals   # one area
#
# DATABASE_URL / REDIS_URL point at a MariaDB / Redis you already run (CI
# services). Without them the script starts Chronicle's own no-Docker test
# MariaDB (port 13306) and a throwaway redis-server (port 16379).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
: "${CHRONICLE_DIR:?set CHRONICLE_DIR to a Chronicle checkout}"
CHRONICLE_DIR="$(cd "$CHRONICLE_DIR" && pwd)"
PORT="${BENCH_PORT:-18080}"
WORK="$(mktemp -d)"
DB_NAME="chronicle_bench_$$"

if [ -z "${DATABASE_URL:-}" ]; then
  "$CHRONICLE_DIR/tools/start-test-db.sh" >/dev/null
  DB_ROOT="root@tcp(127.0.0.1:13306)/"
else
  DB_ROOT="$DATABASE_URL"
fi
if [ -z "${REDIS_URL:-}" ]; then
  if ! redis-cli -p 16379 ping >/dev/null 2>&1; then
    redis-server --port 16379 --save '' --daemonize yes >/dev/null
    OWN_REDIS=1
  fi
  REDIS_URL="redis://127.0.0.1:16379"
fi

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "${DB_HOST:-}" ] && { mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" --protocol=tcp -e "DROP DATABASE IF EXISTS $DB_NAME" || true; }
  [ -n "${OWN_REDIS:-}" ] && redis-cli -p 16379 shutdown nosave >/dev/null 2>&1 || true
  [ "${BENCH_KEEP_LOG:-}" = "1" ] || rm -rf "$WORK"
}
trap cleanup EXIT

# A fresh database per run, so counts and key prefixes start clean.
DB_HOST="$(echo "$DB_ROOT" | sed -E 's/.*@tcp\(([^:]+):([0-9]+)\).*/\1/')"
DB_PORT="$(echo "$DB_ROOT" | sed -E 's/.*@tcp\(([^:]+):([0-9]+)\).*/\2/')"
DB_USER="$(echo "$DB_ROOT" | sed -E 's/^([^:@]+).*/\1/')"
mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" --protocol=tcp -e "CREATE DATABASE $DB_NAME"

echo "building Chronicle from $CHRONICLE_DIR"
( cd "$CHRONICLE_DIR" && go build -o "$WORK/chronicle" ./cmd/server )


( cd "$CHRONICLE_DIR" && \
  ENV=development PORT="$PORT" BASE_URL="http://127.0.0.1:$PORT" \
  DATABASE_URL="${DB_ROOT%/}/$DB_NAME?parseTime=true&multiStatements=true" \
  REDIS_URL="$REDIS_URL" SECRET_KEY="sync-bench-secret-key-not-for-production" \
  MEDIA_PATH="$WORK/media" MEDIA_SIGNING_SECRET_FILE="$WORK/.signing-secret" \
  BACKUP_DIR="$WORK/backups" LOG_LEVEL=info \
  exec "$WORK/chronicle" >"$WORK/server.log" 2>&1 ) &
SERVER_PID=$!

# Refuse to run against a server that was already listening: the bench must
# test the Chronicle it just built.
if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  sleep 1
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "port $PORT is already in use"; exit 1; }
fi
for _ in $(seq 1 120); do
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { tail -40 "$WORK/server.log"; exit 1; }
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null || { tail -40 "$WORK/server.log"; exit 1; }

FILES=("$HERE"/*.bench.mjs)
[ $# -gt 0 ] && FILES=("${@/#/$HERE/}") && FILES=("${FILES[@]/%/.bench.mjs}")

status=0
CHRONICLE_URL="http://127.0.0.1:$PORT" node --test --test-concurrency=1 --test-reporter=spec "${FILES[@]}" || status=$?
if [ "$status" -ne 0 ]; then
  echo "---- Chronicle errors during the run ----"
  grep -E 'level=(ERROR|WARN)' "$WORK/server.log" | tail -40 || true
fi
exit "$status"
