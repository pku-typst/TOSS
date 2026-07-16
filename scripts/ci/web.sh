#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

cd "$CI_ROOT_DIR"
ci_require_node_24

echo "[ci:web] hydrate verified runtime artifacts + install workspaces"
node scripts/fetch-runtime-artifacts.mjs
(cd protocol && npm ci)
(cd web && npm ci)

echo "[ci:web] unit tests + production build"
(cd web && npm test)
(cd web && npm run build)
(cd web && TOSS_CONFIG="../distributions/community/toss.json" npm run check:typst-runtime)
test -d web/dist/busytex
if ! find web/dist/assets -maxdepth 1 -type f -name 'latex.worker-*' -print -quit | grep -q .; then
  echo "[ci:web] Community build is missing its LaTeX worker" >&2
  exit 1
fi
