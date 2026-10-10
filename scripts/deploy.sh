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

say "templates → KV (hot-swappable: HTML edits need no redeploy)"
kv_put_tpl "$STORES_ID" store onboard admin fees index confirm renew ops sample-menu.csv

say "building bundle"
bash scripts/build_bundle.sh .build

NAME="$WORKER_NAME" STORES_ID="$STORES_ID" ORDERS_ID="$ORDERS_ID" WITH_CRON=1 REDIRECT_TO="" \
  python3 scripts/gen_wrangler_toml.py

say "publishing worker to Cloudflare"
if [[ -x node_modules/.bin/wrangler ]]; then
  # wrangler owns the multipart format, the workers_dev route and the schedule
  CLOUDFLARE_API_TOKEN="$CF_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT" \
    node_modules/.bin/wrangler deploy --config wrangler.toml 2>&1 | grep -Ev "^$" | tail -6
  ok "wrangler deploy"
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
else
  ADMIN_SECRET="$(admin_secret)"; warn "ADMIN_SECRET generated locally — in CI set the ADMIN_SECRET repo secret or every deploy rotates it"
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
    CF_TOKEN="$CF_TOKEN" CF_ACCOUNT="$CF_ACCOUNT" WORKER_NAME="$LEGACY_WORKER_NAME" \
      python3 scripts/cf_publish.py "$LEGACY_WORKER_NAME" .build "kv:STORES:$STORES_ID" "kv:ORDERS:$ORDERS_ID" \
      || warn "alias publish failed"
  fi
  WORKER_NAME="$LEGACY_WORKER_NAME" put_secret ADMIN_SECRET "$ADMIN_SECRET" || warn "alias secret not set"
  OLD="https://$LEGACY_WORKER_NAME.$(workers_subdomain | tail -1).workers.dev"
  say "alias answers $OLD/__ping -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$OLD/__ping")"
  say "alias redirects a saved store link: $(curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}' --max-time 20 "$OLD/s/mamatoe")"
  # the alias has no cron, so the schedule check is only meaningful for the main one
  CF_TOKEN="$CF_TOKEN" CF_ACCOUNT="$CF_ACCOUNT" python3 scripts/set_triggers.py "$WORKER_NAME" "15 6,12,18,0 * * *" >/dev/null 2>&1 || true
fi

[[ "$MODE" == "--push" ]] && push_github
echo
ok "done. Give merchants this one link: $BASE/onboard"
echo "    stores appear with no action from you; each edits its own Google Sheet."
