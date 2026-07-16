#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

cd "$CI_ROOT_DIR"
ci_enable_homebrew_rustup

echo "[ci:backend] cargo fmt + clippy + test"
(cd backend && cargo fmt --all -- --check)
(cd backend && cargo clippy --locked --all-targets -- -D warnings)
(cd backend && cargo test --locked)

echo "[ci:backend] verify generated public and worker OpenAPI contracts"
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT
(cd backend && cargo run --locked --quiet --example export_protocol "$TMP_DIR/openapi.json")
(cd backend && cargo run --locked --quiet --example export_worker_protocol "$TMP_DIR/worker-openapi.json")
cmp protocol/openapi.json "$TMP_DIR/openapi.json"
cmp protocol/worker-openapi.json "$TMP_DIR/worker-openapi.json"

echo "[ci:backend] build integration executable"
(cd backend && cargo build --locked --bin core-api)
