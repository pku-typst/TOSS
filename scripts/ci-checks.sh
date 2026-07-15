#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
: "${DATABASE_URL:?DATABASE_URL must point to the disposable CI PostgreSQL database}"
DB_URL="$DATABASE_URL"
CORE_API_PORT="${CORE_API_PORT:-18080}"
CORE_API_URL="http://127.0.0.1:${CORE_API_PORT}"
REALTIME_URL="ws://127.0.0.1:${CORE_API_PORT}"
TMP_DIR="$(mktemp -d)"

export PROCESSING_WORKER_TOKEN="community-ci-processing-token-0123456789abcdef"
export PROCESSING_PROCESSOR_CONTRACT="sha256:1111111111111111111111111111111111111111111111111111111111111111"
export PROCESSING_WORKER_IDENTITIES_JSON='[{"id":"community-latex-ci","token":"community-ci-processing-token-0123456789abcdef","operations":[{"id":"latex.compile.pdf/v1","processor_contracts":["sha256:1111111111111111111111111111111111111111111111111111111111111111"]}]}]'

cd "$ROOT_DIR"

node -e 'if (process.versions.node.split(".")[0] !== "24") { throw new Error(`Node 24 is required, got ${process.version}`); }'
echo "[ci] install protocol tooling + validate docs and runtime provenance"
node scripts/fetch-runtime-artifacts.mjs
(cd protocol && npm ci)
node scripts/check-docs.mjs
node scripts/check-migration-baseline.mjs
node scripts/prebuilt-typst-compiler.mjs verify
node scripts/check-latex-worker-contract.mjs

cleanup() {
  if [[ -n "${CORE_PID:-}" ]]; then kill "$CORE_PID" >/dev/null 2>&1 || true; fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if [[ -d "/opt/homebrew/opt/rustup/bin" ]]; then
  export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
fi

echo "[ci] cargo fmt + clippy + check + test (backend)"
(cd backend && cargo fmt --all -- --check)
(cd backend && cargo clippy --locked --all-targets -- -D warnings)
(cd backend && cargo check --locked)
(cd backend && cargo test --locked)

echo "[ci] verify generated public and worker OpenAPI contracts"
(cd backend && cargo run --locked --quiet --example export_protocol "$TMP_DIR/openapi.json")
(cd backend && cargo run --locked --quiet --example export_worker_protocol "$TMP_DIR/worker-openapi.json")
cmp protocol/openapi.json "$TMP_DIR/openapi.json"
cmp protocol/worker-openapi.json "$TMP_DIR/worker-openapi.json"

echo "[ci] cargo fmt + clippy + test (processing workers)"
(cd workers && cargo fmt --all -- --check)
(cd workers && cargo clippy --locked --all-targets -- -D warnings)
(cd workers && cargo test --locked)

echo "[ci] npm ci + build (web)"
(cd web && npm ci)
(cd web && npm test)
(cd web && npm run build)
(cd web && TOSS_CONFIG="../distributions/community/toss.json" npm run check:typst-runtime)
test -d web/dist/busytex
if ! find web/dist/assets -maxdepth 1 -type f -name 'latex.worker-*' -print -quit | grep -q .; then
  echo "[ci] Community build is missing its LaTeX worker" >&2
  exit 1
fi

echo "[ci] start backend monolith"
(cd backend && TOSS_CONFIG="../distributions/community/toss.json" DATABASE_URL="$DB_URL" CORE_API_PORT="$CORE_API_PORT" GIT_STORAGE_PATH="/tmp/toss-git" AUTH_DEV_HEADER_ENABLED=1 WEB_STATIC_DIR="../web/dist" cargo run --locked >/tmp/toss-core.log 2>&1) &
CORE_PID=$!
for _ in $(seq 1 180); do
  if curl -fsS "$CORE_API_URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "$CORE_API_URL/health" >/dev/null

echo "[ci] run durable processing protocol checks"
CORE_API_URL="$CORE_API_URL" node scripts/processing-protocol-smoke.mjs

echo "[ci] run API-level collaboration and git checks"
CORE_API_URL="$CORE_API_URL" REALTIME_WS_URL="$REALTIME_URL" node web/scripts/realtime-multiuser-test.mjs
CORE_API_URL="$CORE_API_URL" bash web/scripts/git-multiuser-test.sh
CORE_API_URL="$CORE_API_URL" bash web/scripts/git-nonoverlap-merge-test.sh

echo "[ci] run headless browser checks"
WEB_BASE_URL="$CORE_API_URL" node web/scripts/headless-smoke.mjs
WEB_BASE_URL="$CORE_API_URL" CORE_API_URL="$CORE_API_URL" node web/scripts/headless-collab-git.mjs
WEB_BASE_URL="$CORE_API_URL" CORE_API_URL="$CORE_API_URL" node web/scripts/headless-revision-collab-regression.mjs
WEB_BASE_URL="$CORE_API_URL" CORE_API_URL="$CORE_API_URL" node web/scripts/headless-sync-cache-regression.mjs

echo "[ci] all checks passed"
