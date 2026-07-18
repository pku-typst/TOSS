#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

cd "$CI_ROOT_DIR"
ci_require_node_24

export TOSS_BASE_URL="${TOSS_BASE_URL:-/TOSS/}"

echo "[ci:web-static] production build at $TOSS_BASE_URL"
(cd web && npm run build:browser)

if [[ -d web/dist/busytex ]]; then
  echo "[ci:web-static] Static Typst build unexpectedly contains BusyTeX" >&2
  exit 1
fi
if find web/dist/assets -maxdepth 1 -type f -name 'latex.worker-*' -print -quit | grep -q .; then
  echo "[ci:web-static] Static Typst build unexpectedly contains a LaTeX worker" >&2
  exit 1
fi
if [[ -e web/dist/sw.js ]]; then
  echo "[ci:web-static] Static build unexpectedly contains the Core service worker" >&2
  exit 1
fi
if find web/dist -type f -name 'typst_ts_web_compiler_bg.wasm*' -print -quit | grep -q .; then
  echo "[ci:web-static] Static build unexpectedly contains the CDN-hosted Typst compiler" >&2
  exit 1
fi

echo "[ci:web-static] Chromium behavior smoke"
(cd web && npm run test:browser-build)
