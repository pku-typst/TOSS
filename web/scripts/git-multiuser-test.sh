#!/usr/bin/env bash
set -euo pipefail

CORE_API_URL="${CORE_API_URL:-http://127.0.0.1:18080}"
RUN_ID="$(date +%s)"
OWNER_EMAIL="git-owner-${RUN_ID}@example.com"
OWNER_PASSWORD="Owner1234!"
COLLAB_EMAIL="git-collab-${RUN_ID}@example.com"
COLLAB_PASSWORD="Collab1234!"

api_json() {
  local method="$1"
  local path="$2"
  local session_token="$3"
  local body="${4:-}"
  local content_epoch="${5:-}"
  local -a epoch_header=()
  if [[ -n "$content_epoch" ]]; then
    epoch_header=(-H "x-project-content-epoch: $content_epoch")
  fi
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" \
      -H "content-type: application/json" \
      -H "authorization: Bearer $session_token" \
      "${epoch_header[@]}" \
      --data "$body" \
      "$CORE_API_URL$path"
  else
    curl -sS -X "$method" \
      -H "authorization: Bearer $session_token" \
      "${epoch_header[@]}" \
      "$CORE_API_URL$path"
  fi
}

auth_json() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -w "\n%{http_code}" -X "$method" \
      -H "content-type: application/json" \
      --data "$body" \
      "$CORE_API_URL$path"
  else
    curl -sS -w "\n%{http_code}" -X "$method" "$CORE_API_URL$path"
  fi
}

extract_json_field() {
  local field="$1"
  node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log(j['$field'] ?? '');});"
}

register_or_login() {
  local email="$1"
  local username="$2"
  local password="$3"
  local display_name="$4"

  local reg_resp
  reg_resp="$(auth_json POST "/v1/auth/local/register" "{\"email\":\"$email\",\"username\":\"$username\",\"password\":\"$password\",\"display_name\":\"$display_name\"}")"
  local reg_body reg_status
  reg_body="$(printf '%s' "$reg_resp" | head -n 1)"
  reg_status="$(printf '%s' "$reg_resp" | tail -n 1)"
  if [[ "$reg_status" == "200" || "$reg_status" == "201" ]]; then
    printf '%s' "$reg_body"
    return 0
  fi
  if [[ "$reg_status" != "403" && "$reg_status" != "409" ]]; then
    echo "{\"ok\":false,\"error\":\"register failed\",\"status\":$reg_status,\"body\":$reg_body}" >&2
    exit 1
  fi

  local login_resp
  login_resp="$(auth_json POST "/v1/auth/local/login" "{\"email\":\"$email\",\"password\":\"$password\"}")"
  local login_body login_status
  login_body="$(printf '%s' "$login_resp" | head -n 1)"
  login_status="$(printf '%s' "$login_resp" | tail -n 1)"
  if [[ "$login_status" != "200" ]]; then
    echo "{\"ok\":false,\"error\":\"login failed\",\"status\":$login_status,\"body\":$login_body}" >&2
    exit 1
  fi
  printf '%s' "$login_body"
}

OWNER_USERNAME="${OWNER_EMAIL%@*}"
OWNER_AUTH="$(register_or_login "$OWNER_EMAIL" "$OWNER_USERNAME" "$OWNER_PASSWORD" "Git Owner")"
OWNER_ID="$(printf '%s' "$OWNER_AUTH" | extract_json_field user_id)"
OWNER_TOKEN="$(printf '%s' "$OWNER_AUTH" | extract_json_field session_token)"
COLLAB_USERNAME="${COLLAB_EMAIL%@*}"
COLLAB_AUTH="$(register_or_login "$COLLAB_EMAIL" "$COLLAB_USERNAME" "$COLLAB_PASSWORD" "Git Collaborator")"
COLLAB_ID="$(printf '%s' "$COLLAB_AUTH" | extract_json_field user_id)"
COLLAB_TOKEN="$(printf '%s' "$COLLAB_AUTH" | extract_json_field session_token)"

PROJECT_JSON="$(api_json POST "/v1/projects" "$OWNER_TOKEN" "{\"name\":\"Git QA ${RUN_ID}\"}")"
PROJECT_ID="$(printf '%s' "$PROJECT_JSON" | extract_json_field id)"
api_json POST "/v1/projects/$PROJECT_ID/roles" "$OWNER_TOKEN" "{\"user_id\":\"$COLLAB_ID\",\"role\":\"ReadWrite\"}" >/dev/null

owner_pat_json="$(api_json POST "/v1/profile/security/tokens" "$OWNER_TOKEN" '{"label":"qa-owner-token"}')"
collab_pat_json="$(api_json POST "/v1/profile/security/tokens" "$COLLAB_TOKEN" '{"label":"qa-collab-token"}')"
OWNER_PAT="$(printf '%s' "$owner_pat_json" | extract_json_field token)"
COLLAB_PAT="$(printf '%s' "$collab_pat_json" | extract_json_field token)"
REPO_LINK_JSON="$(api_json GET "/v1/git/repo-link/$PROJECT_ID" "$OWNER_TOKEN")"
REPO_URL="$(printf '%s' "$REPO_LINK_JSON" | extract_json_field repo_url)"

PROJECT_EPOCH="$(api_json GET "/v1/projects/$PROJECT_ID/tree" "$OWNER_TOKEN" | extract_json_field content_epoch)"
api_json PUT "/v1/projects/$PROJECT_ID/documents/by-path/main.typ" "$OWNER_TOKEN" '{"content":"= Git QA\n\nInitial from API.\n"}' "$PROJECT_EPOCH" >/dev/null

TMP_DIR="$(mktemp -d /tmp/typst-git-qa.XXXXXX)"
REPO_A="$TMP_DIR/owner-clone"
REPO_B="$TMP_DIR/collab-clone"

REMOTE_OWNER="$(node -e '
const raw = process.argv[1];
const token = process.argv[2];
const u = new URL(raw);
if (!u.username) u.username = "git";
u.password = token;
console.log(u.toString());
' "$REPO_URL" "$OWNER_PAT")"
REMOTE_COLLAB="$(node -e '
const raw = process.argv[1];
const token = process.argv[2];
const u = new URL(raw);
if (!u.username) u.username = "git";
u.password = token;
console.log(u.toString());
' "$REPO_URL" "$COLLAB_PAT")"

git clone "$REMOTE_OWNER" "$REPO_A" >/dev/null 2>&1 || true
git clone "$REMOTE_COLLAB" "$REPO_B" >/dev/null 2>&1 || true

if [[ ! -d "$REPO_A/.git" ]]; then
  echo '{"ok":false,"error":"owner clone failed"}'
  exit 1
fi

cd "$REPO_A"
git config user.name "QA Owner"
git config user.email "owner@example.com"

if [[ ! -f main.typ ]]; then
  git pull origin main >/dev/null 2>&1 || true
fi

printf '\nOffline edit by owner.\n' >> main.typ
git add main.typ
git commit -m "Owner offline change" >/dev/null

PROJECT_EPOCH="$(api_json GET "/v1/projects/$PROJECT_ID/tree" "$COLLAB_TOKEN" | extract_json_field content_epoch)"
api_json PUT "/v1/projects/$PROJECT_ID/documents/by-path/main.typ" "$COLLAB_TOKEN" '{"content":"= Git QA\n\nInitial from API.\n\nCollaborative update by collaborator.\n"}' "$PROJECT_EPOCH" >/dev/null

set +e
git push origin HEAD:main >/tmp/typst-git-push1.log 2>&1
PUSH1_EXIT=$?
set -e

set +e
git pull --rebase origin main >/tmp/typst-git-rebase.log 2>&1
REBASE_EXIT=$?
set -e

if [[ "$REBASE_EXIT" -ne 0 ]]; then
  git rebase --abort >/dev/null 2>&1 || true
  set +e
  git pull --no-rebase origin main >/tmp/typst-git-merge.log 2>&1
  MERGE_EXIT=$?
  set -e
  if [[ "$MERGE_EXIT" -ne 0 ]]; then
    cat > main.typ <<'EOF'
= Git QA

Initial from API.

Collaborative update by collaborator.
Offline edit by owner.
EOF
    git add main.typ
    git commit -m "Resolve server/offline merge conflict" >/dev/null
  fi
fi

SERVER_COMMIT_MSG="$(git log --max-count=3 --pretty=%B | tr '\n' ' ' | sed 's/  */ /g')"

git push origin HEAD:main >/dev/null

printf '\nCommit for force push test.\n' >> main.typ
git add main.typ
git commit -m "Force push candidate" >/dev/null
git push origin HEAD:main >/dev/null
git reset --hard HEAD~1 >/dev/null

set +e
git push --force origin HEAD:main >/tmp/typst-git-force.log 2>&1
FORCE_EXIT=$?
set -e

STATUS_JSON="$(api_json GET "/v1/git/status/$PROJECT_ID" "$OWNER_TOKEN")"

node -e "
const status = JSON.parse(process.argv[1]);
const out = {
  ok: true,
  project_id: process.argv[6],
  push_rejected_when_server_advanced: Number(process.argv[2]) !== 0,
  rebase_or_merge_needed: Number(process.argv[5]) !== 0,
  force_push_rejected: Number(process.argv[3]) !== 0,
  server_commit_message_contains_marker: process.argv[4].includes('Online updates'),
  status
};
console.log(JSON.stringify(out, null, 2));
" "$STATUS_JSON" "$PUSH1_EXIT" "$FORCE_EXIT" "$SERVER_COMMIT_MSG" "$REBASE_EXIT" "$PROJECT_ID"
