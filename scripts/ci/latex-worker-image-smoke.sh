#!/usr/bin/env bash

set -euo pipefail

: "${CONTAINER_IMAGE:?CONTAINER_IMAGE must name the exact image under test}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST="$ROOT_DIR/workers/latex/processor-contract.json"
EXPECTED_CONTRACT="sha256:$(sha256sum "$MANIFEST" | cut -d' ' -f1)"
ACTUAL_CONTRACT="$(docker run --rm "$CONTAINER_IMAGE" contract)"
ACTUAL_MANIFEST="$(mktemp)"

cleanup() {
  rm -f "$ACTUAL_MANIFEST"
}
trap cleanup EXIT

docker run --rm "$CONTAINER_IMAGE" manifest >"$ACTUAL_MANIFEST"
cmp "$MANIFEST" "$ACTUAL_MANIFEST"
test "$ACTUAL_CONTRACT" = "$EXPECTED_CONTRACT"

echo "LaTeX worker image contract verified: $ACTUAL_CONTRACT"
