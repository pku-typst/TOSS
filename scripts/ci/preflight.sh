#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

cd "$CI_ROOT_DIR"
ci_require_node_24

echo "[ci:preflight] install protocol tooling + validate docs and runtime provenance"
node scripts/fetch-runtime-artifacts.mjs
(cd protocol && npm ci)
node scripts/check-docs.mjs
node scripts/check-migration-baseline.mjs
