#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

"$ROOT_DIR/scripts/ci/preflight.sh"
"$ROOT_DIR/scripts/ci/backend.sh"
"$ROOT_DIR/scripts/ci/workers.sh"
"$ROOT_DIR/scripts/ci/web.sh"
CORE_API_BIN="$ROOT_DIR/backend/target/debug/core-api" \
  WEB_STATIC_DIR="$ROOT_DIR/web/dist" \
  "$ROOT_DIR/scripts/ci/integration.sh"

echo "[ci] all checks passed"
