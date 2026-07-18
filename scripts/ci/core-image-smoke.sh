#!/usr/bin/env bash

set -euo pipefail

: "${CONTAINER_IMAGE:?CONTAINER_IMAGE must name the exact image under test}"
: "${DATABASE_URL:?DATABASE_URL must point to a disposable PostgreSQL database}"

CORE_API_PORT="${CORE_API_PORT:-18080}"
CORE_API_URL="http://127.0.0.1:${CORE_API_PORT}"
CONTAINER_NAME="toss-core-image-smoke-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-0}"

cleanup() {
  docker stop --time 40 "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach \
  --name "$CONTAINER_NAME" \
  --network host \
  --tmpfs /data:size=1g,mode=0700 \
  --tmpfs /tmp:size=1g,mode=1777 \
  --env DATABASE_URL="$DATABASE_URL" \
  --env CORE_API_PORT="$CORE_API_PORT" \
  --env DATA_DIR=/data \
  --env GIT_STORAGE_PATH=/data/git \
  --env SESSION_SECRET=community-container-smoke-session-secret \
  --env COOKIE_SECURE=false \
  --env RUST_LOG=warn \
  "$CONTAINER_IMAGE" >/dev/null

for _ in $(seq 1 120); do
  if curl --fail --silent "$CORE_API_URL/ready" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl --fail --silent "$CORE_API_URL/ready" >/dev/null; then
  docker logs "$CONTAINER_NAME" >&2
  exit 1
fi

curl --fail --silent "$CORE_API_URL/health" >/dev/null
curl --fail --silent "$CORE_API_URL/v1/auth/config" \
  | jq --exit-status \
    '.distribution_id == "community" and (.enabled_project_types | index("typst") != null)' \
    >/dev/null

echo "Core image smoke passed: $CONTAINER_IMAGE"
