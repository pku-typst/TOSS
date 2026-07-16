#!/usr/bin/env bash

set -euo pipefail

CI_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

ci_require_node_24() {
  node -e 'if (process.versions.node.split(".")[0] !== "24") { throw new Error(`Node 24 is required, got ${process.version}`); }'
}

ci_enable_homebrew_rustup() {
  if [[ -d "/opt/homebrew/opt/rustup/bin" ]]; then
    export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
  fi
}
