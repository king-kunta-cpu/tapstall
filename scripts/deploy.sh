#!/usr/bin/env bash
# Tapstall deploy — one command, no dashboard clicking, no manual per-customer step.
# (wrangler is used when installed; a dependency-free publisher is the fallback.)
#
#   ./scripts/deploy.sh            tests → bundle → KV → Worker → templates → cron → self-check
#   ./scripts/deploy.sh --check    tests + bundle only (dry run, nothing uploaded)
#   ./scripts/deploy.sh --push     everything, plus create/update the GitHub repo + Pages
#
# Secrets come from files or env, never from the command line:
#   .secrets/cf_token      Cloudflare API token
#   .secrets/cf_account    Cloudflare account id
#   .secrets/admin_secret  Worker ADMIN_SECRET (generated once, kept local)
#   .secrets/gh_token      GitHub token (--push only)
set -euo pipefail
cd "$(dirname "$0")/.."
. ./scripts/lib.sh

MODE="${1:-deploy}"
require_cmd curl jq python3 node

# --check must work with no credentials at all (that is what makes it usable as a
# pre-commit / editor check), so secrets are only demanded by a real deploy.
if [[ "$MODE" == "--check" ]]; then
  check_workflows
  run_tests
  python3 scripts/ui_kit.py check
  bash scripts/build_bundle.sh /tmp/zl-dryrun >/dev/null && ok "dry run: tests pass, ui kit inlined, bundle builds"
  exit 0
fi
load_secrets

# A workflow that does not parse fails as a jobless run with no readable logs,
# so catch it here where the error is legible.
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
        bad.append("%s: %s" % (f, str(e).split(chr(10))[0]))
if bad:
    print("  workflow YAML invalid:"); [print("   ", b) for b in bad]; sys.exit(1)
print("  CI workflow YAML validates")
PYEOF

say "KV namespaces"
STORES_ID=$(kv_id "$KV_STORES" STORES "$KV_STORES_LEGACY" | tail -1 | tr -dc "a-f0-9")
ORDERS_ID=$(kv_id "$KV_ORDERS" ORDERS "$KV_ORDERS_LEGACY" | tail -1 | tr -dc "a-f0-9")
say "stores=$STORES_ID  orders=$ORDERS_ID"

# The one accident a rename can cause that looks like success: kv_id creates an
# empty namespace when a title does not match, every deploy then "works", and the
# stores are simply gone from the point of view of the Worker. So the resolved id
# has to agree with the one recorded by the last deploy, and the namespace has to
# have keys in it. Both are reads, so this costs nothing on a quota day.
if [[ -f .deploy/state.json ]]; then
  PREVIOUS=$(jq -r '.kv_stores // empty' .deploy/state.json)
  if [[ -n "$PREVIOUS" && "$PREVIOUS" != "$STORES_ID" ]]; then
    die "STORES resolved to $STORES_ID but the last deploy used $PREVIOUS. Refusing to publish against a namespace that is not the one with the stores in it — check KV_STORES/KV_STORES_LEGACY before anything else."
  fi
fi
KEYS=$(cf GET "/storage/kv/namespaces/$STORES_ID/keys?per_page=1" | jq -r '.result_info.count // 0')
[[ "$KEYS" != "0" ]] || die "STORES namespace $STORES_ID reports zero keys. If that is a fresh account, delete .deploy/state.json and run again; otherwise the title lookup found the wrong namespace."

# the shipped pages must be the generated ones, or KV would publish a stale UI
python3 scripts/ui_kit.py check || die "pages/*.html are out of date with pages/src/ — run python3 scripts/ui_kit.py and commit"

# Pages stopped being KV keys in v0.9.1: build_bundle.sh puts git's bytes in the Worker, and
# `tplPage` serves them, so publishing a page spends no write, cannot be refused by a spent budget,
# and cannot lag the build that was tested. What is left here is the two things the KV route was
# actually for, kept on purpose:
#
#   --pages-override <name>   publish ONE page into `tpl-ovr:<name>`, which outranks the bundle.
#                             The emergency door: the copy is wrong at 22:00 and a deploy is not
#                             happening tonight. `--pages-clear <name>` takes it away again.
#   PAGES_KV=1                also write the legacy `tpl:<name>` copies, so a rollback to a
#                             pre-0.9.1 Worker still finds the current pages, not a stale month.
TPL_NAMES="store onboard admin fees index confirm renew ops"
for f in pages/guide-*.html; do          # the script has already cd'd to the repo root
  [[ -e "$f" ]] && TPL_NAMES="$TPL_NAMES $(basename "$f" .html)"
done

if [[ "$MODE" == "--pages-override" || "$MODE" == "--pages-clear" ]]; then
  PAGE_T="${2:-}"; [[ -n "$PAGE_T" ]] || die "which page? ./scripts/deploy.sh --pages-override admin"
  if [[ "$MODE" == "--pages-clear" ]]; then
    # deleting an override is a KV mutation, so it is said out loud rather than treated as free
    kv_del_ovr "$STORES_ID" "$PAGE_T"
    ok "tpl-ovr:$PAGE_T gone: the bundle's copy of $PAGE_T is what a merchant is served again"
    exit 0
  fi
  case " $TPL_NAMES sample-menu " in *" $PAGE_T "*) : ;; *) die "$PAGE_T is not a page this pipeline publishes ($TPL_NAMES sample-menu)" ;; esac
  FILE="pages/$PAGE_T.html"; [[ "$PAGE_T" == sample-menu ]] && FILE="pages/sample-menu.csv"
  [[ -f "$FILE" ]] || die "no $FILE to publish"
  kv_put_ovr "$STORES_ID" "$PAGE_T" "$FILE"
  verify_override "$STORES_ID" "$PAGE_T" "$FILE" || die "the override in KV is not the file in git — see above"
  ok "override published. It stays in front of the bundle until --pages-clear $PAGE_T: a page put there by hand has to be taken out by hand, which is the point of an override and the trap in one"
  exit 0
fi

if [[ "$MODE" == "--templates" ]]; then
  # Kept as a door, not as a mechanism. Since v0.9.1 there is nothing to publish: the answer a person
  # typing this wants is "is the page a customer sees the page in git?", and that is now a local
  # question — build, compare, report. No KV read, no KV write, and it works on a day the account
  # has spent its budget, which is the only day anyone ever reached for this command.
  say "templates: pages ride in the bundle now — checking the bundle instead of publishing to KV"
  bash scripts/build_bundle.sh /tmp/zl-pages-check >/dev/null
  check_pages_in_bundle /tmp/zl-pages-check $TPL_NAMES sample-menu
  ok "every page in git is in the bundle a deploy uploads: nothing to publish, nothing to retry tonight"
  exit 0
fi

say "building bundle"
bash scripts/build_bundle.sh .build
# The one fact a bundle has to get right, which used to be eight KV writes' worth of luck: every
# page in pages/ is *inside* the file about to be uploaded. Checked locally, before anything leaves
# the machine, because the answer is already known at that point — a read-back of KV could only
# report it after the deploy, which is how "the Worker is current and the page is not" became a state
# a shop could sit in for nine hours.
check_pages_in_bundle .build $TPL_NAMES sample-menu

if [[ "${PAGES_KV:-0}" == 1 ]]; then
  say "also publishing the legacy KV copies (PAGES_KV=1): a rollback target, one write per differing page"
  kv_put_tpl "$STORES_ID" $TPL_NAMES sample-menu.csv
  verify_templates "$STORES_ID" $TPL_NAMES sample-menu.csv \
    || warn "the rollback copies above are not current. The live pages are — they are in the bundle — so this costs a rollback, not a merchant"
fi

NAME="$WORKER_NAME" STORES_ID="$STORES_ID" ORDERS_ID="$ORDERS_ID" WITH_CRON=1 REDIRECT_TO="" \
  python3 scripts/gen_wrangler_toml.py

say "publishing worker to Cloudflare"
if [[ -x node_modules/.bin/wrangler ]]; then
  # wrangler owns the multipart format, the workers_dev route and the schedule.
  #
  # Three attempts, because Cloudflare answers `504 Gateway Timeout` at the subdomain
  # step for no reason this repo can affect — it cost run #65 on a day the tests were
  # green and the Worker was in fact fine, and a red run that means nothing is how a
  # real alarm gets ignored. No pipe into tail on the way: a pipeline's status is
  # tail's, so the retry loop checks wrangler's own exit, prints the tail afterwards,
  # and only dies when every attempt failed.
  publog=$(mktemp)
  pub=0
  for try in 1 2 3; do
    if CLOUDFLARE_API_TOKEN="$CF_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT" \
         node_modules/.bin/wrangler deploy --config wrangler.toml >"$publog" 2>&1; then
      grep -Ev "^$" "$publog" | tail -6
      if [[ $try -gt 1 ]]; then ok "wrangler deploy, on attempt $try (Cloudflare 504'd before that)"; else ok "wrangler deploy"; fi
      pub=1; break
    fi
    # the shape of the failure decides what to do with it: a 504 is Cloudflare timing out,
    # an HTML body is the edge answering the runner with a page instead of the API (an
    # outage, or a challenge aimed at this IP range), and neither is a deploy error that a
    # change in this repo could fix. Say which one, rather than leave a fragment to guess at.
    # `|| true` is not decoration: `fail=$(grep …)` inherits grep's status, and under
    # `set -euo pipefail` a deploy that failed for a reason this line does not recognise
    # would abort the script before it ever said what happened — which is the one job left.
    fail=$(grep -iE '504|Gateway Timeout|error code' "$publog" | head -1 || true)
    if [[ -z "$fail" ]] && head -c 400 "$publog" | grep -qiE '<!doctype|<html|<!--\[if'; then
      fail="Cloudflare answered HTML, not the API ($(wc -c < "$publog") bytes back) — an edge outage or a challenge, not something this deploy can fix"
    fi
    warn "wrangler deploy failed, attempt $try of 3: ${fail:-$(tail -1 "$publog")}"
    if [[ $try -lt 3 ]]; then sleep $((try * 8)); fi
  done
  rm -f "$publog"
  [[ $pub == 1 ]] || die "the Worker was not published in three attempts — nothing new is live, and this run is the proof"
else
  warn "wrangler not installed (npm i) — using the dependency-free publisher"
  CF_TOKEN="$CF_TOKEN" CF_ACCOUNT="$CF_ACCOUNT" WORKER_NAME="$WORKER_NAME" \
    python3 scripts/cf_publish.py "$WORKER_NAME" .build "kv:STORES:$STORES_ID" "kv:ORDERS:$ORDERS_ID"
fi

say "writing bindings/ids so nothing else has to be guessed"
mkdir -p .deploy && cat > .deploy/state.json <<JSON
{ "worker": "$WORKER_NAME", "account": "$CF_ACCOUNT",
  "kv_stores": "$STORES_ID", "kv_orders": "$ORDERS_ID",
  "stores_title": "$KV_STORES", "orders_title": "$KV_ORDERS",
  "updated": "$(date -u +%FT%TZ)" }
JSON
ok ".deploy/state.json"

# ADMIN_SECRET must survive across deploys (it salts buyer fingerprints and the
# renewal tokens already in merchants' inboxes). In CI, set it as a repo secret.
if [[ -n "${ADMIN_SECRET:-}" ]]; then
  ok "ADMIN_SECRET from environment"
elif [[ -s .secrets/admin_secret ]]; then
  # Reading the file is not the same as inventing one, and the log used to say it
  # was: a stable secret reported as "generated" is a false alarm about rotating
  # the fingerprint salt, which is the one thing this variable must not do.
  ADMIN_SECRET="$(admin_secret)"; ok "ADMIN_SECRET read from .secrets/admin_secret (stable across deploys)"
else
  ADMIN_SECRET="$(admin_secret)"; warn "ADMIN_SECRET generated into .secrets/admin_secret — in CI, set that same value as the repo secret, or a CI deploy rotates the salt and signs merchants out"
fi
put_secret ADMIN_SECRET "$ADMIN_SECRET"
[[ -n "${FLUTTERWAVE_SECRET:-}" ]] && put_secret FW_SECRET "$FLUTTERWAVE_SECRET"
# the slug of the Flutterwave payment link in the receiving account: a brand
# change must not silently break payouts, so it is configuration, not a literal
[[ -n "${FW_PAY_SLUG:-}" ]] && put_secret FW_PAY_SLUG "$FW_PAY_SLUG" || true

rm -rf .build

# verify the schedule and the workers.dev route over HTTP (writes are not trusted)
CF_TOKEN="$CF_TOKEN" CF_ACCOUNT="$CF_ACCOUNT" python3 scripts/set_triggers.py "$WORKER_NAME" "15 6,12,18,0 * * *" || warn "trigger check failed"

# ---------------------------------------------------------------- self-check
BASE="https://$WORKER_NAME.$(workers_subdomain | tail -1).workers.dev"
# The wait is for *this build*, not merely for a live Worker. The edge keeps serving the previous
# version for a few seconds after an upload, and a selftest printed inside that window shows
# yesterday's number under a green deploy: that false alarm has now cost two investigations
# (prod_check's "ping reports the version", and a 0.8.2 upload reporting 0.8.1 in the log). The
# loop asks /__ping which version it is holding and stops when the answer matches. A mismatch
# after the wait is a warning, not a failure — the upload is what it is, and propagation is not
# a defect in the build.
WANT="$(worker_version)"
GOT=""
for i in 1 2 3 4 5 6 7 8; do
  GOT=$(curl -sf -A "Mozilla/5.0" --max-time 15 "$BASE/__ping" 2>/dev/null | jq -r '.version // ""' 2>/dev/null || true)
  [[ "$GOT" == "$WANT" ]] && break
  sleep 3
done
curl -sf -A "Mozilla/5.0" --max-time 15 "$BASE/__ping" >/dev/null || die "worker did not answer /__ping"
ok "worker live: $BASE (${GOT:-version not readable yet})"
[[ "$GOT" == "$WANT" ]] || warn "edge still answers ${GOT:-nothing} while this deploy uploaded $WANT — still propagating; the upload itself succeeded"
echo "--- /__selftest ---"
# This print is a status line, not the deploy's verdict: the /__ping loop above is what
# proves the Worker serves. Cloudflare's edge answered one of today's hiccups with an
# HTML 504 page instead of JSON, and jq's exit code under pipefail turned a green release
# red twice for that reason alone. So show the truth in whichever shape it arrived, and
# let the publish decide the exit code.
ST_BODY=$(curl -s -A "Mozilla/5.0" --max-time 30 "$BASE/__selftest" || true)
if printf '%s' "$ST_BODY" | head -c 1 | grep -q '{'; then
  printf '%s' "$ST_BODY" | jq '{version, kv_stores, kv_roundtrip, templates: {store: .tpl_store, onboard: .tpl_onboard, admin: .tpl_admin, fees: .tpl_fees, index: .tpl_index, confirm: .tpl_confirm, renew: .tpl_renew, ops: .tpl_ops}, pricing_absorb: .pricing.fee_absorbed_by_merchant, products: (.csv|length), feed_url_ok: (.feed_url_sheet != null), secret_leak_check}' \
    || warn "selftest JSON did not parse — the raw bytes above are the report"
else
  warn "selftest answered no JSON (the edge is being itself): $(printf '%s' "$ST_BODY" | tr '\n' ' ' | head -c 140)"
fi
echo "--- routes ---"
for r in / /onboard /fees /rails /ops /data/sample-menu.csv; do
  printf '  %-9s %s\n' "$r" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE$r")"
done
# ------------------------------------------------- the old hostname, kept alive
# Links already sent to merchants are absolute and were minted on the previous
# brand's hostname. Deleting that Worker would 404 a storefront a buyer has saved
# in WhatsApp, so the old name is deployed too: same code, same KV, and the one
# env var that makes it answer redirects for page visits. A failure here is a
# warning, never a red release: the alias is what was already running until now.
if [[ -n "${LEGACY_WORKER_NAME:-}" && "$LEGACY_WORKER_NAME" != "$WORKER_NAME" ]]; then
  say "alias worker $LEGACY_WORKER_NAME -> redirects to $BASE"
  NAME="$LEGACY_WORKER_NAME" STORES_ID="$STORES_ID" ORDERS_ID="$ORDERS_ID" WITH_CRON=0 REDIRECT_TO="$BASE" \
    python3 scripts/gen_wrangler_toml.py || warn "alias config not written"
  if [[ -x node_modules/.bin/wrangler ]]; then
    CLOUDFLARE_API_TOKEN="$CF_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT" \
      node_modules/.bin/wrangler deploy --config wrangler.toml 2>&1 | grep -Ev "^$" | tail -3 || warn "alias deploy failed"
  else
    # the bundle is normally cleaned up above; the dependency-free publisher needs
    # it, so rebuild rather than "succeed" at publishing nothing
    [[ -d .build ]] || bash scripts/build_bundle.sh .build
    # TAPSTALL_CRON="" says "not scheduled", and REDIRECT_TO has to be passed here
    # too: this publisher builds its bindings from its arguments, and the day it
    # silently dropped that var the old hostname started serving the app itself and
    # running the sweep a second time — which is also how a $0 account burns half
    # its daily KV writes on nothing.
    CF_TOKEN="$CF_TOKEN" CF_ACCOUNT="$CF_ACCOUNT" WORKER_NAME="$LEGACY_WORKER_NAME" \
      REDIRECT_TO="$BASE" TAPSTALL_CRON="" \
      python3 scripts/cf_publish.py "$LEGACY_WORKER_NAME" .build "kv:STORES:$STORES_ID" "kv:ORDERS:$ORDERS_ID" \
      || warn "alias publish failed"
  fi
  WORKER_NAME="$LEGACY_WORKER_NAME" put_secret ADMIN_SECRET "$ADMIN_SECRET" || warn "alias secret not set"
  OLD="https://$LEGACY_WORKER_NAME.$(workers_subdomain | tail -1).workers.dev"
  say "alias answers $OLD/__ping -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$OLD/__ping")"
  # An assertion, not a log line: `200 ->` used to print here as a fact and the
  # regression it described went by twice.
  ALINK=$(curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}' --max-time 20 "$OLD/s/mamatoe")
  if [[ "$ALINK" == 301* ]]; then say "alias redirects a saved store link: $ALINK"
  else warn "alias is NOT redirecting (got: $ALINK) — the old hostname is serving the app itself, so it lost REDIRECT_TO and the daily sweep runs from two origins"; fi
  # The alias inherited a cron schedule from the day it was the only Worker, and
  # this token cannot delete it (PUT /schedules -> success:false). That is safe
  # rather than sloppy: a Worker deployed with REDIRECT_TO returns from
  # scheduled() without touching KV, which the alias's own selftest reports as
  # cron_owner:false — so the sweep still runs once a day, from one origin.
  # guarded for the same reason as the selftest print above: a 504 here is a shrug,
  # not a red release, and the alias is not what a merchant's money runs through
  say "alias cron is inert: $( { curl -s --max-time 20 "$OLD/__selftest" || true; } | jq -c '{cron_owner, version}' 2>/dev/null || printf 'not readable right now')"
  CF_TOKEN="$CF_TOKEN" CF_ACCOUNT="$CF_ACCOUNT" python3 scripts/set_triggers.py "$WORKER_NAME" "15 6,12,18,0 * * *" || warn "cron check failed on $WORKER_NAME"
fi

[[ "$MODE" == "--push" ]] && push_github
echo
ok "done. Give merchants this one link: $BASE/onboard"
echo "    stores appear with no action from you; each edits its own Google Sheet."
