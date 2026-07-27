#!/usr/bin/env bash
# Stands up PgBouncer (transaction-pooling mode) in front of the existing
# robotx-bench-pg container, so the app can point DATABASE_URL at PgBouncer
# instead of Postgres directly. Idempotent — safe to re-run.
#
# Postgres max_connections in the bench container is 100 (checked via
# `docker exec robotx-bench-pg psql -tAc "SHOW max_connections;"`), so
# DEFAULT_POOL_SIZE below is kept comfortably under that even though the
# app-side pool (DATABASE_URL connection_limit) can be set much higher.
set -euo pipefail

NETWORK=robotx-bench-net
PG_CONTAINER=robotx-bench-pg
PGBOUNCER_CONTAINER=robotx-bench-pgbouncer
HOST_PORT=6433
DEFAULT_POOL_SIZE="${DEFAULT_POOL_SIZE:-25}"
MAX_CLIENT_CONN="${MAX_CLIENT_CONN:-2000}"

docker network create "$NETWORK" 2>/dev/null || true
docker network connect "$NETWORK" "$PG_CONTAINER" 2>/dev/null || true

docker rm -f "$PGBOUNCER_CONTAINER" 2>/dev/null || true

docker run -d --name "$PGBOUNCER_CONTAINER" \
  --network "$NETWORK" \
  -e DB_HOST="$PG_CONTAINER" \
  -e DB_PORT=5432 \
  -e DB_USER=bench \
  -e DB_PASSWORD=bench \
  -e DB_NAME=robotx_bench \
  -e POOL_MODE=transaction \
  -e MAX_CLIENT_CONN="$MAX_CLIENT_CONN" \
  -e DEFAULT_POOL_SIZE="$DEFAULT_POOL_SIZE" \
  -e AUTH_TYPE=scram-sha-256 \
  -p "${HOST_PORT}:5432" \
  edoburu/pgbouncer

echo "PgBouncer up on localhost:${HOST_PORT} -> ${PG_CONTAINER}:5432 (pool_mode=transaction, default_pool_size=${DEFAULT_POOL_SIZE})"
