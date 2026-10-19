#!/usr/bin/env bash
# Tapstall — shared helpers for deploy.sh. bash + curl + jq + python3 only.
# No wrangler, no npm install, no interactive login: CI-scriptable and
# reproducible on a phone with termux if you ever need to.

WORKER_NAME="${WORKER_NAME:-tapstall}"
# One Worker, one pair of KV namespaces, Tapstall titles only. A title miss would
# create an empty namespace, so deploy.sh also refuses a resolved id that does
# not match the last recorded deploy.
KV_STORES="${KV_STORES:-tapstall-stores}"
KV_ORDERS="${KV_ORDERS:-tapstall-orders}"
GH_REPO="${GH_REPO:-tapstall}"
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
    # the repo's own .secrets first (it is where a checkout puts one), then the home
    # directory, because this repo is cloned and re-cloned more than it is configured
    # and a $HOME/.secrets that deploy.sh cannot see is a broken deploy for no reason
    if [[ -z "${!var:-}" ]]; then
      for d in ".secrets" "$HOME/.secrets"; do
        # `|| true`: a secret file with no trailing newline makes `read` return 1 at EOF,
        # and under set -e that kills the deploy after the value was already read — the
        # token is in the variable and the script is dead, which looks like a bad token
        if [[ -f "$d/$file" ]]; then read -r "$var" < "$d/$file" || true; break; fi
      done
    fi
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

kv_id() { # kv_id <title> <binding> -> namespace id (creates only when the title does not exist)
  local title="$1" binding="$2" id=""
  id=$(cf GET "/storage/kv/namespaces?per_page=100" | jq -r --arg t "$title" '.result[]|select(.title==$t)|.id' | head -1)
  if [[ -z "$id" || "$id" == "null" ]]; then
    id=$(cf POST "/storage/kv/namespaces" "{\"title\":\"$title\",\"binding\":\"$binding\"}" | jq -r '.result.id')
    [[ -n "$id" && "$id" != "null" ]] || die "could not create KV namespace '$title'"
    say "created KV '$title' -> $id"
  fi
  printf '%s\n' "$id"
}

# ---- pages are bundle bytes (v0.9.1) ---------------------------------------
# Every page under pages/ is inlined into .build/worker.js by build_bundle.sh and served by
# `tplPage` in the Worker, so publishing a page costs no KV write, cannot be refused by a spent
# budget, and cannot disagree with the tests that ran on the same bytes. This is the check that
# replaces the KV read-back: the answer is known locally, before anything leaves the machine, and it
# is the same answer a rollback would need.
check_pages_in_bundle() { # <bundle-dir> <names...>
  local out="$1"; shift; local n bad=""
  local file="$out/worker.js"
  [[ -f "$file" ]] || die "no $file — build_bundle.sh did not run"
  for n in "$@"; do
    local src="pages/$n.html"
    [[ "$n" == sample-menu ]] && src="pages/sample-menu.csv"
    [[ -f "$src" ]] || { bad="$bad $n(no file in git)"; continue; }
    # The middle of the file is compared, not its head: every page opens with the same doctype and
    # the same kit lines, so a head-only match would pass for a bundle holding a different page.
    if ! OUT="$file" SRC="$src" python3 "$ZBUNDLE_CHECK" "$n"; then bad="$bad $n"; fi
  done
  if [[ -n "$bad" ]]; then
    die "the bundle does not carry:${bad} — shipping this serves those pages from the KV fallback, which is a rollback copy and may be months old"
  fi
  ok "bundle carries $# pages, byte-checked against git"
}

# The checker as its own file, because this is the third time a page of Python inside a single
# quoted shell string inside a heredoc has cost an afternoon: an apostrophe in a comment ends the
# string, bash keeps going, and the failure is reported as "your page is missing".
ZBUNDLE_CHECK="${ZBUNDLE_CHECK:-$(dirname "${BASH_SOURCE[0]}")/check_bundle_pages.py}"

# The emergency door, and its opposite: one page in front of the bundle, or that override removed.
# Both are written through the namespace directly, because `tpl-ovr:` is not a key the Worker's own
# guarded lever accepts, and an emergency that needs four hands is not an emergency door.
kv_put_ovr() { # <namespace_id> <name> <file>
  CF_TOKEN="$CF_TOKEN" CF_ACCOUNT="$CF_ACCOUNT" KV_NS="$1" TPL="$2" FILE="$3" python3 - <<'PYOV'
import os, urllib.error, urllib.request
tok, acct = os.environ["CF_TOKEN"], os.environ["CF_ACCOUNT"]
ns, name, fn = os.environ["KV_NS"], os.environ["TPL"], os.environ["FILE"]
key = "tpl-ovr:" + (name[:-4] if name.endswith(".csv") else name)
body = open(fn, "rb").read()
api = os.environ.get("CF_API_BASE", "https://api.cloudflare.com/client/v4")
url = "%s/accounts/%s/storage/kv/namespaces/%s/values/%s" % (api, acct, ns, key)
try:
    req = urllib.request.Request(url, data=body, method="PUT", headers={"Authorization": "Bearer " + tok})
    with urllib.request.urlopen(req, timeout=90) as r:
        out = r.read().decode()
    assert '"success":true' in out.replace(" ", ""), out[:200]
    print("  ^ %s: %d bytes published as an override" % (name, len(body)))
except urllib.error.HTTPError as e:
    print("  x %s: HTTP %s %s" % (name, e.code, e.read().decode()[:300]))
    # An override that will not land is the emergency door standing shut. There is no graceful
    # version of this: the bundle copy stays live, which is fine for a shop and not fine for a fix,
    # so say it and stop rather than exit 0 and let somebody believe the page changed.
    raise SystemExit(1)
PYOV
}

verify_override() { # <namespace_id> <name> <file>
  CF_TOKEN="$CF_TOKEN" CF_ACCOUNT="$CF_ACCOUNT" KV_NS="$1" TPL="$2" FILE="$3" python3 - <<'PYOV'
import hashlib, os, time, urllib.error, urllib.request
tok, acct = os.environ["CF_TOKEN"], os.environ["CF_ACCOUNT"]
ns, name, fn = os.environ["KV_NS"], os.environ["TPL"], os.environ["FILE"]
key = "tpl-ovr:" + (name[:-4] if name.endswith(".csv") else name)
want = hashlib.sha256(open(fn, "rb").read()).hexdigest()
api = os.environ.get("CF_API_BASE", "https://api.cloudflare.com/client/v4")
url = "%s/accounts/%s/storage/kv/namespaces/%s/values/%s" % (api, acct, ns, key)
for try_no in (1, 2, 3, 4, 5):
    try:  # the read-your-write window on KV is seconds, not a defect; five reads cover it and then
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": "Bearer " + tok}), timeout=60) as r:
            got = hashlib.sha256(r.read()).hexdigest()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise SystemExit("  x %s: no override in KV — the write did not land" % name)
        raise SystemExit("  x %s: read refused (HTTP %s); the override may be there, check again in a minute" % (name, e.code))
    if got == want:
        print("  = %s: KV holds exactly the file it was given" % name)
        raise SystemExit(0)
    time.sleep(6 * try_no)
raise SystemExit("  x %s: KV holds different bytes than git, after five reads" % name)
PYOV
}

kv_del_ovr() { # <namespace_id> <name>
  local ns="$1" name="$2"
  curl -s --max-time 60 -X DELETE "$CF_API/accounts/$CF_ACCOUNT/storage/kv/namespaces/$ns/values/tpl-ovr:$name" \
    -H "Authorization: Bearer $CF_TOKEN" \
    | python3 -c 'import sys,json
try:
    j = json.load(sys.stdin)
    print("  v override removed" if j.get("success") else "  x " + json.dumps(j.get("errors"))[:200])
except Exception as e:
    print("  ? ", e)' >&2
}

# ---- templates into KV (hot-swap without redeploy) ------------------------
kv_put_tpl() { # <namespace_id> <names...>
  # Publishes a page only when KV does not already hold this exact file: a
  # deploy that changes no HTML then spends zero of the 1,000 free KV writes a
  # day, and a quota-exhausted day cannot turn CI red over a byte that is
  # already there. A refused write where KV *differs* from git is fatal, because
  # that is the one case where customers would be served a stale page.
  local ns="$1"; shift; local name
  for name in "$@"; do
    local file="pages/$name.html"
    [[ "$name" == *.csv ]] && file="pages/$name"
    [[ -f "$file" ]] || die "missing $file"
    CF_TOKEN="$CF_TOKEN" CF_ACCOUNT="$CF_ACCOUNT" KV_NS="$ns" TPL="$name" FILE="$file" python3 - <<'PYEOF'
import os, time, urllib.error, urllib.request
tok  = os.environ["CF_TOKEN"]; acct = os.environ["CF_ACCOUNT"]
ns   = os.environ["KV_NS"];    name = os.environ["TPL"]; fn = os.environ["FILE"]
key  = "tpl:" + (name[:-4] if name.endswith(".csv") else name)     # sample-menu.csv -> tpl:sample-menu
body = open(fn, "rb").read()
api  = os.environ.get("CF_API_BASE", "https://api.cloudflare.com/client/v4")
base = "%s/accounts/%s/storage/kv/namespaces/%s" % (api, acct, ns)

# Two failure shapes look identical in a log and must not be handled alike. A spent quota
# (429 / code 10048) cannot be retried into success, and hammering it spends patience for
# nothing; a 504 from the KV upstream (code 7009) is Cloudflare being itself for a few
# seconds, and it is the only reason a green release has gone red on this step. So one is
# fatal-on-sight and the other is waited out. `CF_API_BASE` exists so the difference can be
# tested against a stand-in origin instead of argued about; nothing in production sets it.
TRANSIENT = ("504", "502", "503", "7009", "timed out", "Upstream service unavailable",
             "Temporary Failure", "Service Unavailable")
QUOTA = ("429", "10048", "free usage limit", "limit exceeded")
def transient(t): return any(x in t for x in TRANSIENT)
def quota(t):     return any(x in t for x in QUOTA)
def why(e):
    # The quota refusal is a 429 whose *body* carries code 10048, and a 5xx from the upstream
    # says nothing in str(HTTPError) either: both live in the response body. Reading it once,
    # here, is what lets a spent budget stop on sight and an unavailable upstream be waited out.
    # (Learned by being wrong twice: CI died on run #22 reading only str(e), and on run #74
    # treating a 7009 as a defect in the page it was trying to publish.)
    parts = [str(e), repr(getattr(e, "reason", ""))]
    rd = getattr(e, "read", None)
    if callable(rd):
        try: parts.append(rd().decode("utf-8", "replace")[:400])
        except Exception: pass
    return " ".join(parts)

def read():
    for try_no in (1, 2, 3):
        try:
            req = urllib.request.Request(base + "/values/" + key, headers={"Authorization": "Bearer " + tok})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            if try_no == 3 or not transient(why(e)): raise
            time.sleep(2 * try_no)

cur = read()
if cur == body:
    print("  = %-14s already current in KV (%d bytes), no write spent" % (name, len(body)))
else:
    err = None
    for try_no in (1, 2, 3):
        try:
            req = urllib.request.Request(base + "/values/" + key, data=body, method="PUT",
                                        headers={"Authorization": "Bearer " + tok})
            with urllib.request.urlopen(req, timeout=90) as r:
                out = r.read().decode()
            assert '"success": true' in out or '"success":true' in out, out[:200]
            err = None
            break
        except Exception as e:
            err = e
            t = why(e)
            # a spent budget will not unspend itself; a 5xx from the upstream might
            if quota(t): break
            if try_no < 3: time.sleep(3 * try_no if transient(t) else 1)
    if err is None:
        print("  ^ %-14s %d -> %d bytes" % (name, len(cur or b""), len(body)))
    elif read() == body:
        print("  = %-14s write refused (%s) but KV already matches git: fine" % (name, str(err)[:60]))
    else:
        # A spent quota is the one reason to keep going without this page. The
        # Worker is forward-compatible with yesterday's HTML (the data hooks are
        # null-tolerant by construction), so shipping the new API and letting the
        # copy catch up on the next deploy beats shipping nothing for 12 hours.
        # Any other failure mode is still fatal: a stale page from a real bug is
        # exactly what this function exists to refuse.
        txt = why(err)
        if transient(txt):
            print("  ! %-14s NOT PUBLISHED — the KV upstream refused us (5xx) three times over 15 seconds, and git and KV still differ (%d bytes vs %d). This is Cloudflare, not this build: the next deploy repeats the put, and CI's 00:20 UTC job is that retry. The Worker is deployed regardless." % (name, len(body), len(cur or b"")))
        elif quota(txt):
            print("  ! %-14s NOT PUBLISHED — this account\'s KV write budget is spent (HTTP 429/10048). "
                  "The old copy stays live (%d bytes in git, %d in KV); the next deploy after 00:00 UTC "
                  "puts it right — that is CI\'s scheduled run or your next push, either of which, "
                  "and the Worker is deployed regardless." % (name, len(body), len(cur or b"")))
        else:
            raise SystemExit("  ! %-14s could not be published and KV differs from git: %s" % (name, txt[:160]))
PYEOF
    [[ $? -eq 0 ]] || die "template publish failed: $name"
  done
}

verify_templates() { # <namespace_id> <names...> — reads only, so it is free on a spent day
  # The question a deploy should answer and usually does not: is the page customers
  # are served the page in git? A KV write that was refused for budget reasons looks
  # like success in every log that does not read the value back.
  local ns="$1"; shift
  CF_TOKEN="$CF_TOKEN" CF_ACCOUNT="$CF_ACCOUNT" KV_NS="$ns" TPL_NAMES="$*" python3 - <<'PYEOF'
import os, urllib.request
tok, acct = os.environ["CF_TOKEN"], os.environ["CF_ACCOUNT"]
ns, names = os.environ["KV_NS"], os.environ["TPL_NAMES"].split()
base = "https://api.cloudflare.com/client/v4/accounts/%s/storage/kv/namespaces/%s" % (acct, ns)
bad = []
for name in names:
    fn = ("pages/%s.html" % name) if not name.endswith(".csv") else ("pages/%s" % name)
    key = "tpl:" + (name[:-4] if name.endswith(".csv") else name)
    want = open(fn, "rb").read() if os.path.exists(fn) else None
    if want is None:
        bad.append("%s: no %s in this checkout" % (name, fn)); continue
    try:
        req = urllib.request.Request(base + "/values/" + key, headers={"Authorization": "Bearer " + tok})
        with urllib.request.urlopen(req, timeout=60) as r: got = r.read()
    except Exception as e:
        got = b"" if getattr(e, "code", None) == 404 else None
        if got is None: bad.append("%s: KV read failed (%s)" % (name, e)); continue
    if got == want:
        print("  + %-14s %d bytes in git, same bytes in KV" % (name, len(want)))
    else:
        print("  ! %-14s git has %d bytes, KV has %d — customers are served the older page" % (name, len(want), len(got)))
        bad.append(name)
if bad:
    print("  ! not current: %s" % ", ".join(bad))
    print("    the fix is one command once the account can write again: ./scripts/deploy.sh --templates")
    raise SystemExit(3)
print("  all shipped pages are what git holds")
PYEOF
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
  CF_TOKEN="$CF_TOKEN" CF_ACCOUNT="$CF_ACCOUNT" WORKER_NAME="$WORKER_NAME" TP_KEY="$key" TP_VAL="$val" python3 - <<'PYEOF' || warn "secret $key not set"
import json, os, urllib.error, urllib.request
tok  = os.environ["CF_TOKEN"]; acct = os.environ["CF_ACCOUNT"]; w = os.environ["WORKER_NAME"]
key, val = os.environ["TP_KEY"], os.environ["TP_VAL"]
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
  if node --test tests/ >/tmp/tp_tests.log 2>&1; then
    grep -E '^# (tests|pass|fail)' /tmp/tp_tests.log | tr '\n' ' '; echo
  else
    tail -50 /tmp/tp_tests.log; die "tests failed — refusing to deploy"
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

  [[ -d .git ]] || { git init -q -b main; git config user.name tapstall; git config user.email tapstall@localhost; }
  git add -A >/dev/null 2>&1
  git -c commit.gpgsign=false commit -q -m "Tapstall $(worker_version): storefront worker, self-serve onboarding, fee math, QR poster" \
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
