#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

: "${DATABASE_URL:?DATABASE_URL must point to a disposable PostgreSQL database}"

cd "$CI_ROOT_DIR"
ci_require_node_24

CORE_API_PORT="${CORE_API_PORT:-18080}"
CORE_API_URL="http://127.0.0.1:${CORE_API_PORT}"
REALTIME_URL="ws://127.0.0.1:${CORE_API_PORT}"
CORE_API_BIN="${CORE_API_BIN:-$CI_ROOT_DIR/backend/target/debug/core-api}"
WEB_STATIC_DIR="${WEB_STATIC_DIR:-$CI_ROOT_DIR/web/dist}"
TMP_DIR="$(mktemp -d)"
CORE_LOG="$TMP_DIR/core.log"

if [[ ! -x "$CORE_API_BIN" ]]; then
  echo "[ci:integration] Core executable is unavailable or not executable: $CORE_API_BIN" >&2
  exit 1
fi
if [[ ! -f "$WEB_STATIC_DIR/index.html" ]]; then
  echo "[ci:integration] Web build is unavailable: $WEB_STATIC_DIR" >&2
  exit 1
fi

export PROCESSING_WORKER_TOKEN="community-ci-processing-token-0123456789abcdef"
export PROCESSING_PROCESSOR_CONTRACT="sha256:1111111111111111111111111111111111111111111111111111111111111111"

printf '%s\n' "$PROCESSING_WORKER_TOKEN" >"$TMP_DIR/worker.token"
printf '%s\n' \
  'schema = 1' \
  '' \
  '[frontend]' \
  'enabled_features = ["ai_assistant"]' \
  '' \
  '[document_processing]' \
  '[[document_processing.worker_identities]]' \
  'id = "community-latex-ci"' \
  'token_file = "worker.token"' \
  '' \
  '[[document_processing.worker_identities.operations]]' \
  'id = "latex.compile.pdf/v1"' \
  'processor_contracts = ["sha256:1111111111111111111111111111111111111111111111111111111111111111"]' \
  >"$TMP_DIR/deployment.toml"

cleanup() {
  if [[ -n "${CORE_PID:-}" ]]; then
    kill "$CORE_PID" >/dev/null 2>&1 || true
    wait "$CORE_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "[ci:integration] start backend monolith"
(
  cd backend
  TOSS_CONFIG="$CI_ROOT_DIR/distributions/community/toss.json" \
    TOSS_DEPLOYMENT_CONFIG="$TMP_DIR/deployment.toml" \
    DATABASE_URL="$DATABASE_URL" \
    CORE_API_PORT="$CORE_API_PORT" \
    DATA_DIR="$TMP_DIR/data" \
    GIT_STORAGE_PATH="$TMP_DIR/git" \
    AUTH_DEV_HEADER_ENABLED=1 \
    WEB_STATIC_DIR="$WEB_STATIC_DIR" \
    exec "$CORE_API_BIN" >"$CORE_LOG" 2>&1
) &
CORE_PID=$!
for _ in $(seq 1 180); do
  if curl -fsS "$CORE_API_URL/ready" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! curl -fsS "$CORE_API_URL/ready" >/dev/null; then
  cat "$CORE_LOG" >&2
  exit 1
fi

echo "[ci:integration] run durable processing protocol checks"
CORE_API_URL="$CORE_API_URL" node scripts/processing-protocol-smoke.mjs

echo "[ci:integration] run API-level collaboration and Git checks"
CORE_API_URL="$CORE_API_URL" REALTIME_WS_URL="$REALTIME_URL" node web/scripts/realtime-multiuser-test.mjs
CORE_API_URL="$CORE_API_URL" bash web/scripts/git-multiuser-test.sh
CORE_API_URL="$CORE_API_URL" bash web/scripts/git-nonoverlap-merge-test.sh

echo "[ci:integration] run headless browser checks"
WEB_BASE_URL="$CORE_API_URL" node web/scripts/headless-smoke.mjs
WEB_BASE_URL="$CORE_API_URL" CORE_API_URL="$CORE_API_URL" node web/scripts/headless-ai-runtime.mjs
WEB_BASE_URL="$CORE_API_URL" CORE_API_URL="$CORE_API_URL" node web/scripts/headless-collab-git.mjs
WEB_BASE_URL="$CORE_API_URL" CORE_API_URL="$CORE_API_URL" node web/scripts/headless-revision-collab-regression.mjs
WEB_BASE_URL="$CORE_API_URL" CORE_API_URL="$CORE_API_URL" node web/scripts/headless-sync-cache-regression.mjs

echo "[ci:integration] run single-replica replacement checks"
kill "$CORE_PID"
wait "$CORE_PID" >/dev/null 2>&1 || true
CORE_PID=""
TOSS_CONFIG="$CI_ROOT_DIR/distributions/community/toss.json" \
  TOSS_DEPLOYMENT_CONFIG="$TMP_DIR/deployment.toml" \
  CORE_API_BIN="$CORE_API_BIN" \
  CORE_API_PORT="$CORE_API_PORT" \
  DATA_DIR="$TMP_DIR/data" \
  GIT_STORAGE_PATH="$TMP_DIR/git" \
  RELEASE_RESILIENCE_LOG_DIR="$TMP_DIR/release-resilience-logs" \
  WEB_STATIC_DIR="$WEB_STATIC_DIR" \
  npm --prefix web run test:release-resilience

echo "[ci:integration] all integration checks passed"
