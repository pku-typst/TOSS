#!/usr/bin/env bash
set -euo pipefail

CORE_API_URL="${CORE_API_URL:-http://127.0.0.1:18080}"
RUN_ID="$(date +%s)"
OWNER_EMAIL="git-merge-owner-${RUN_ID}@example.com"
OWNER_USERNAME="gitmergeowner${RUN_ID}"
OWNER_PASSWORD="Owner1234!"
COLLAB_EMAIL="git-merge-collab-${RUN_ID}@example.com"
COLLAB_USERNAME="gitmergecollab${RUN_ID}"
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

OWNER_AUTH="$(register_or_login "$OWNER_EMAIL" "$OWNER_USERNAME" "$OWNER_PASSWORD" "Merge Owner")"
OWNER_ID="$(printf '%s' "$OWNER_AUTH" | extract_json_field user_id)"
OWNER_TOKEN="$(printf '%s' "$OWNER_AUTH" | extract_json_field session_token)"
COLLAB_AUTH="$(register_or_login "$COLLAB_EMAIL" "$COLLAB_USERNAME" "$COLLAB_PASSWORD" "Merge Collaborator")"
COLLAB_ID="$(printf '%s' "$COLLAB_AUTH" | extract_json_field user_id)"
COLLAB_TOKEN="$(printf '%s' "$COLLAB_AUTH" | extract_json_field session_token)"

PROJECT_JSON="$(api_json POST "/v1/projects" "$OWNER_TOKEN" "{\"name\":\"Git Nonoverlap QA ${RUN_ID}\"}")"
PROJECT_ID="$(printf '%s' "$PROJECT_JSON" | extract_json_field id)"
api_json POST "/v1/projects/$PROJECT_ID/roles" "$OWNER_TOKEN" "{\"user_id\":\"$COLLAB_ID\",\"role\":\"ReadWrite\"}" >/dev/null

owner_pat_json="$(api_json POST "/v1/profile/security/tokens" "$OWNER_TOKEN" '{"label":"qa-owner-token"}')"
OWNER_PAT="$(printf '%s' "$owner_pat_json" | extract_json_field token)"
REPO_LINK_JSON="$(api_json GET "/v1/git/repo-link/$PROJECT_ID" "$OWNER_TOKEN")"
REPO_URL="$(printf '%s' "$REPO_LINK_JSON" | extract_json_field repo_url)"

BASE_CONTENT=$'= Merge QA\n\npara A line 1\npara A line 2\npara A line 3\n\npara B line 1\npara B line 2\npara B line 3\n'
PROJECT_EPOCH="$(api_json GET "/v1/projects/$PROJECT_ID/tree" "$OWNER_TOKEN" | extract_json_field content_epoch)"
api_json PUT "/v1/projects/$PROJECT_ID/documents/by-path/main.typ" "$OWNER_TOKEN" \
  "$(node -e 'process.stdout.write(JSON.stringify({content: process.argv[1]}))' "$BASE_CONTENT")" "$PROJECT_EPOCH" >/dev/null
api_json POST "/v1/projects/$PROJECT_ID/revisions" "$OWNER_TOKEN" '{"summary":"init"}' >/dev/null

TMP_DIR="$(mktemp -d /tmp/typst-git-nonoverlap.XXXXXX)"
REPO="$TMP_DIR/clone"
REMOTE_OWNER="$(node -e '
const raw = process.argv[1];
const token = process.argv[2];
const fallbackUser = process.argv[3] || "git";
const u = new URL(raw);
if (!u.username) u.username = fallbackUser;
u.password = token;
console.log(u.toString());
' "$REPO_URL" "$OWNER_PAT" "$OWNER_USERNAME")"
git clone "$REMOTE_OWNER" "$REPO" >/dev/null 2>&1

cd "$REPO"
git config user.name "QA Owner"
git config user.email "owner@example.com"
python3 - <<'PY'
from pathlib import Path
p = Path("main.typ")
text = p.read_text(encoding="utf-8")
text = text.replace("para A line 2", "para A line 2 LOCAL")
p.write_text(text, encoding="utf-8")
PY
git add main.typ
git commit -m "Owner local paragraph A edit" >/dev/null

ONLINE_CONTENT=$'= Merge QA\n\npara A line 1\npara A line 2\npara A line 3\n\npara B line 1\npara B line 2 ONLINE\npara B line 3\n'
PROJECT_EPOCH="$(api_json GET "/v1/projects/$PROJECT_ID/tree" "$COLLAB_TOKEN" | extract_json_field content_epoch)"
api_json PUT "/v1/projects/$PROJECT_ID/documents/by-path/main.typ" "$COLLAB_TOKEN" \
  "$(node -e 'process.stdout.write(JSON.stringify({content: process.argv[1]}))' "$ONLINE_CONTENT")" "$PROJECT_EPOCH" >/dev/null

set +e
git push origin HEAD:main >/tmp/typst-git-nonoverlap-push.log 2>&1
PUSH_EXIT=$?
set -e

SERVER_DOCS="$(api_json GET "/v1/projects/$PROJECT_ID/documents?path=main.typ" "$OWNER_TOKEN")"
node -e '
const pushExit = Number(process.argv[1]);
const docs = JSON.parse(process.argv[2]).documents || [];
const doc = docs.find((d) => d.path === "main.typ");
const content = doc?.content || "";
const ok = pushExit === 0 &&
  content.includes("para A line 2 LOCAL") &&
  content.includes("para B line 2 ONLINE");
if (!ok) {
  console.error(JSON.stringify({ ok: false, pushExit, content }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, pushExit }, null, 2));
' "$PUSH_EXIT" "$SERVER_DOCS"
