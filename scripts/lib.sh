#!/usr/bin/env bash
# ZimLink — shared helpers for deploy.sh. bash + curl + jq + python3 only.
# No wrangler, no npm install, no interactive login: CI-scriptable and
# reproducible on a phone with termux if you ever need to.

WORKER_NAME="${WORKER_NAME:-zimlink}"
KV_STORES="${KV_STORES:-zimlink-stores}"
KV_ORDERS="${KV_ORDERS:-zimlink-orders}"
GH_REPO="${GH_REPO:-zimlink}"
GH_OWNER="${GH_OWNER:-}"
CF_API="https://api.cloudflare.com/client/v4"

# IMPORTANT: log helpers go to stderr. Anything printed to stdout inside a
# $(...) helper would be captured as the function's return value.
say() { printf '\033[36m*\033[0m %s\n' "$*" >&2; }
ok()  { printf '\033[32m+\033[0m %s\n' "$*" >&2; }
warn(){ printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31mx\033[0m %s\n' "$*" >&2; exit 1; }

require_cmd() { local c; for c in "$@"; do command -v "$c" >/dev/null 2>&1 || die "missing command: $c"; done; }

load_secrets() {
  local var file alt
  # CI supplies CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (the conventional
  # secret names); locally they live in .secrets/. Either is fine, and the
  # names must not be a reason for a deploy to stop.
  : "${CF_TOKEN:=${CLOUDFLARE_API_TOKEN:-}}" "${CF_ACCOUNT:=${CLOUDFLARE_ACCOUNT_ID:-}}"
  export CF_TOKEN CF_ACCOUNT
  for pair in "CF_TOKEN:cf_token" "CF_ACCOUNT:cf_account"; do
    var="${pair%%:*}"; file="${pair##*:}"
    if [[ -z "${!var:-}" && -f ".secrets/$file" ]]; then read -r "$var" < ".secrets/$file"; fi
    export "$var"
    [[ -n "${!var:-}" ]] || die "set $var (env or .secrets/$file)"
  done
  local probe
  probe=$(curl -s --max-time 25 "$CF_API/accounts/$CF_ACCOUNT" -H "Authorization: Bearer $CF_TOKEN" || true)
  [[ "$(printf '%s' "$probe" | jq -r '.success // false' 2>/dev/null)" == "true" ]] \
    || die "Cloudflare token/account rejected: $(printf '%s' "$probe" | jq -c '.errors' 2>/dev/null)"
}

# ---- generic CF API -------------------------------------------------------
cf() { # cf GET|POST|PUT|DELETE /accounts-relative-path [json]
  local method="$1" path="$2" body="${3:-}" out args
  args=(-s --max-time 60 -X "$method" "$CF_API/accounts/$CF_ACCOUNT$path" -H "Authorization: Bearer $CF_TOKEN")
  [[ -n "$body" ]] && args+=(-H "Content-Type: application/json" -d "$body")
  out=$(curl "${args[@]}") || true
  if [[ -n "$out" ]] && [[ "$(printf '%s' "$out" | jq -r '.success // "true"' 2>/dev/null)" == "false" ]]; then
    printf '%s\n' "$out" | jq -c '.errors' >&2 || true
    return 1
  fi
  printf '%s\n' "$out"
}

workers_subdomain() { cf GET "/workers/subdomain" | jq -r '.result.subdomain // "main"'; }

kv_id() { # kv_id <title> <binding> -> namespace id (creates when missing)
  local title="$1" binding="$2" id
  id=$(cf GET "/storage/kv/namespaces?per_page=100" | jq -r --arg t "$title" '.result[]|select(.title==$t)|.id' | head -1)
  if [[ -z "$id" || "$id" == "null" ]]; then
    id=$(cf POST "/storage/kv/namespaces" "{\"title\":\"$title\",\"binding\":\"$binding\"}" | jq -r '.result.id')
    [[ -n "$id" && "$id" != "null" ]] || die "could not create KV namespace '$title'"
    say "created KV '$title' -> $id"
  fi
  printf '%s\n' "$id"
}

# ---- templates into KV (hot-swap without redeploy) ------------------------
kv_put_tpl() { # <namespace_id> <names...>
  local ns="$1"; shift; local name
  for name in "$@"; do
    local file="pages/$name.html"
    [[ "$name" == *.csv ]] && file="pages/$name"
    [[ -f "$file" ]] || die "missing $file"
    CF_TOKEN="$CF_TOKEN" CF_ACCOUNT="$CF_ACCOUNT" KV_NS="$ns" TPL="$name" python3 - <<'PYEOF'
import os, urllib.request
tok  = os.environ["CF_TOKEN"]; acct = os.environ["CF_ACCOUNT"]
ns   = os.environ["KV_NS"];     name = os.environ["TPL"]
fn = "pages/%s.html" % name
if name.endswith(".csv"): fn = "pages/%s" % name
body = open(fn, encoding="utf-8").read().encode()
url  = ("https://api.cloudflare.com/client/v4/accounts/%s/storage/kv/namespaces/%s/values/tpl:%s"
        % (acct, ns, name.replace(".csv", "-menu") if name.endswith(".csv") else name))
req  = urllib.request.Request(url, data=body, method="PUT",
                              headers={"Authorization": "Bearer " + tok})
out = urllib.request.urlopen(req, timeout=90).read().decode()
assert '"success": true' in out or '"success":true' in out, out[:200]
print("  tpl:%s  %s bytes" % (name, format(len(body), ",")))
PYEOF
  done
}

# ---- secrets --------------------------------------------------------------
admin_secret() {
  if [[ -s .secrets/admin_secret ]]; then cat .secrets/admin_secret; return; fi
  mkdir -p .secrets && chmod 700 .secrets
  openssl rand -hex 24 > .secrets/admin_secret && chmod 600 .secrets/admin_secret
  cat .secrets/admin_secret
}

put_secret() { # <KEY> <value>
  local key="$1" val="$2"
  CF_TOKEN="$CF_TOKEN" CF_ACCOUNT="$CF_ACCOUNT" WORKER_NAME="$WORKER_NAME" ZL_KEY="$key" ZL_VAL="$val" python3 - <<'PYEOF' || warn "secret $key not set"
import json, os, urllib.error, urllib.request
tok  = os.environ["CF_TOKEN"]; acct = os.environ["CF_ACCOUNT"]; w = os.environ["WORKER_NAME"]
key, val = os.environ["ZL_KEY"], os.environ["ZL_VAL"]
url = "https://api.cloudflare.com/client/v4/accounts/%s/workers/scripts/%s/secrets" % (acct, w)
# Cloudflare rejects a body without an explicit type:
#   400 code 100145 "Secret 'X' has unsupported type ''"
data = json.dumps({"name": key, "text": val, "type": "secret_text"}).encode()
req = urllib.request.Request(url, data=data, method="PUT",
        headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
try:
    res = json.loads(urllib.request.urlopen(req, timeout=60).read())
except urllib.error.HTTPError as e:
    raise SystemExit("HTTP %s: %s" % (e.code, e.read().decode()[:200]))
assert res.get("success"), res
print("  secret %s set" % key)
PYEOF
}

# ---- tests ----------------------------------------------------------------
check_workflows() {
  # A workflow that does not parse fails as a jobless run with no readable logs.
  python3 - <<'PYEOF' || die "fix .github/workflows/*.yml"
import glob, sys
try:
    import yaml
except ImportError:
    print("  (pyyaml absent — skipping workflow parse check)"); sys.exit(0)
bad = []
for f in glob.glob(".github/workflows/*.yml"):
    try:
        yaml.safe_load(open(f))
    except Exception as e:
        bad.append("%s: %s" % (f, str(e).splitlines()[0]))
if bad:
    print("  workflow YAML invalid:")
    for b in bad:
        print("   ", b)
    sys.exit(1)
print("  CI workflow YAML validates")
PYEOF
}

run_tests() {
  command -v node >/dev/null || die "node required for tests"
  say "unit tests"
  if node --test tests/ >/tmp/zl_tests.log 2>&1; then
    grep -E '^# (tests|pass|fail)' /tmp/zl_tests.log | tr '\n' ' '; echo
  else
    tail -50 /tmp/zl_tests.log; die "tests failed — refusing to deploy"
  fi
}

worker_version() { grep -o "VERSION = '[^']*'" worker/worker.js | head -1 | cut -d"'" -f2; }

# ---- github ---------------------------------------------------------------
push_github() {
  local tok="${GH_TOKEN:-}"
  [[ -z "$tok" && -f .secrets/gh_token ]] && read -r tok < .secrets/gh_token
  [[ -n "$tok" ]] || { warn "no GitHub token — skipping push"; return 0; }
  local owner="${GH_OWNER:-}"
  [[ -z "$owner" ]] && owner=$(curl -s --max-time 30 -H "Authorization: Bearer $tok" https://api.github.com/user | jq -r '.login')
  [[ -n "$owner" && "$owner" != "null" ]] || die "could not resolve GitHub user for this token"
  GH_OWNER="$owner"
  say "github.com/$owner/$GH_REPO"
  local code
  code=$(curl -s -o /tmp/gh_create.json -w '%{http_code}' --max-time 30 -X POST https://api.github.com/user/repos \
    -H "Authorization: Bearer $tok" -H "Content-Type: application/json" \
    -d "{\"name\":\"$GH_REPO\",\"description\":\"Zero-touch WhatsApp storefront for Zim/SA micro-merchants — free tier, no order cap, no USD subscription\",\"private\":false,\"has_issues\":false,\"has_wiki\":false,\"auto_init\":false}")
  case "$code" in
    201) ok "repo created" ;;
    422) warn "repo already exists — updating it" ;;
    *)   warn "repo create returned $code: $(jq -c '.message' /tmp/gh_create.json 2>/dev/null)" ;;
  esac

  [[ -d .git ]] || { git init -q -b main; git config user.name zimlink; git config user.email zimlink@localhost; }
  git add -A >/dev/null 2>&1
  git -c commit.gpgsign=false commit -q -m "ZimLink $(worker_version): storefront worker, self-serve onboarding, fee math, QR poster" \
    || say "nothing new to commit"
  local url="https://x-access-token:${tok}@github.com/${owner}/${GH_REPO}.git"
  git remote get-url origin >/dev/null 2>&1 && git remote set-url origin "$url" || git remote add origin "$url"
  git push -q --force origin main 2>&1 | sed "s/${tok}/***/g"
  ok "pushed to $owner/$GH_REPO"
  git remote set-url origin "https://github.com/${owner}/${GH_REPO}.git"   # never leave the token in .git/config

  curl -s -o /tmp/gh_pages.json --max-time 30 -X POST "https://api.github.com/repos/${owner}/${GH_REPO}/pages" \
    -H "Authorization: Bearer $tok" -H "Content-Type: application/json" -d '{"build_type":"workflow"}' >/dev/null
  if grep -q 'already exists\|409' /tmp/gh_pages.json 2>/dev/null; then say "Pages already enabled"
  else ok "Pages set to Actions build"; fi
  echo "    site: https://${owner}.github.io/${GH_REPO}/"
}
