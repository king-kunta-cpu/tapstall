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

# --templates ships the pages and nothing else. It exists because the 1,000 free KV
# writes a day can be spent by the time a release gets to them: the Worker goes out,
# the HTML waits, and the only way to finish is to run something again after midnight.
# This is that something. It spends a write only where KV differs from git, so a
# nightly run on a quiet day costs nothing and proves the same fact every time.
# Everything in pages/ named guide-* is published and verified, without a human
# remembering to add it to a list. A written page that is never published is the
# orphan failure the COREMERCH bot spends a whole subsystem hunting: here it is
# impossible by construction, because the list is the directory.
TPL_NAMES="store onboard admin fees index confirm renew ops"
for f in pages/guide-*.html; do          # the script has already cd'd to the repo root
  [[ -e "$f" ]] && TPL_NAMES="$TPL_NAMES $(basename "$f" .html)"
done

if [[ "$MODE" == "--templates" ]]; then
  say "templates → KV only (no bundle, no worker publish)"
  kv_put_tpl "$STORES_ID" $TPL_NAMES sample-menu.csv
  # Read back, and fail on the difference. A step that prints a warning and exits 0
  # is how a stale page stayed stale: the log said the truth and the pipeline said
  # success, and the only reader of a green run is the person who was not there.
  verify_templates "$STORES_ID" $TPL_NAMES sample-menu.csv \
    || die "the pages above are not what customers are being served — the account could not write them today"
  exit 0
fi

say "templates → KV (hot-swappable: HTML edits need no redeploy)"
kv_put_tpl "$STORES_ID" $TPL_NAMES sample-menu.csv

# Read the served bytes back, on the main path too and not only in --templates mode.
# This is the failure that looks like success: the Worker version goes up, one page does
# not, and every log that does not compare git with KV says the deploy was fine — which
# is what happened to a storefront change on a day the free KV writes were spent. It
# warns rather than dies, because the Worker really did deploy and the nightly
# `pages-are-current` run at 00:20 UTC is the retry: after the reset it puts any page
# whose bytes differ and fails if the difference survives.
if verify_templates "$STORES_ID" $TPL_NAMES sample-menu.csv; then :
else
  warn "a page above is not what customers are being served — the Worker is current, the page is not"
  warn "it publishes itself at 00:20 UTC (the scheduled run), or now: ./scripts/deploy.sh --templates"
fi

say "building bundle"
bash scripts/build_bundle.sh .build

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
    warn "wrangler deploy failed, attempt $try of 3: $(grep -iE '504|Gateway Timeout|error code' "$publog" | head -1)"
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
for i in 1 2 3 4 5; do
  curl -sf -A "Mozilla/5.0" --max-time 15 "$BASE/__ping" >/dev/null 2>&1 && break; sleep 2
done
curl -sf -A "Mozilla/5.0" --max-time 15 "$BASE/__ping" >/dev/null || die "worker did not answer /__ping"
ok "worker live: $BASE"
echo "--- /__selftest ---"
curl -s -A "Mozilla/5.0" --max-time 30 "$BASE/__selftest" | jq '{version, kv_stores, kv_roundtrip, templates: {store: .tpl_store, onboard: .tpl_onboard, admin: .tpl_admin, fees: .tpl_fees, index: .tpl_index, confirm: .tpl_confirm, renew: .tpl_renew, ops: .tpl_ops}, pricing_absorb: .pricing.fee_absorbed_by_merchant, products: (.csv|length), feed_url_ok: (.feed_url_sheet != null), secret_leak_check}'
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
  say "alias cron is inert: $(curl -s --max-time 20 "$OLD/__selftest" | jq -c '{cron_owner, version}' 2>/dev/null)"
  CF_TOKEN="$CF_TOKEN" CF_ACCOUNT="$CF_ACCOUNT" python3 scripts/set_triggers.py "$WORKER_NAME" "15 6,12,18,0 * * *" || warn "cron check failed on $WORKER_NAME"
fi

[[ "$MODE" == "--push" ]] && push_github
echo
ok "done. Give merchants this one link: $BASE/onboard"
echo "    stores appear with no action from you; each edits its own Google Sheet."
