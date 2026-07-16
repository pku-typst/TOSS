#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

cd "$CI_ROOT_DIR"
ci_require_node_24
ci_enable_homebrew_rustup

echo "[ci:workers] validate the LaTeX worker contract"
node scripts/check-latex-worker-contract.mjs

echo "[ci:workers] cargo fmt + clippy + test"
(cd workers && cargo fmt --all -- --check)
(cd workers && cargo clippy --locked --all-targets -- -D warnings)
(cd workers && cargo test --locked)
