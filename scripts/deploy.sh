#!/usr/bin/env bash
# ZimLink deploy — one command, no dashboard clicking, no wrangler, no npm install.
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
load_secrets

if [[ "$MODE" == "--check" ]]; then
  run_tests; ./scripts/build_bundle.sh /tmp/zl-dryrun >/dev/null && ok "dry run: tests pass, bundle builds"
  exit 0
fi

run_tests
say "KV namespaces"
STORES_ID=$(kv_id "$KV_STORES" STORES | tail -1 | tr -dc "a-f0-9")
ORDERS_ID=$(kv_id "$KV_ORDERS" ORDERS | tail -1 | tr -dc "a-f0-9")
say "stores=$STORES_ID  orders=$ORDERS_ID"

say "templates → KV (hot-swappable: HTML edits need no redeploy)"
kv_put_tpl "$STORES_ID" store onboard admin fees index sample-menu.csv

say "building bundle"
./scripts/build_bundle.sh .build

say "publishing worker to Cloudflare"
CF_TOKEN="$CF_TOKEN" CF_ACCOUNT="$CF_ACCOUNT" WORKER_NAME="$WORKER_NAME" \
  python3 scripts/cf_publish.py "$WORKER_NAME" .build "kv:STORES:$STORES_ID" "kv:ORDERS:$ORDERS_ID"

say "writing bindings/ids so nothing else has to be guessed"
mkdir -p .deploy && cat > .deploy/state.json <<JSON
{ "worker": "$WORKER_NAME", "account": "$CF_ACCOUNT",
  "kv_stores": "$STORES_ID", "kv_orders": "$ORDERS_ID",
  "stores_title": "$KV_STORES", "orders_title": "$KV_ORDERS",
  "updated": "$(date -u +%FT%TZ)" }
JSON
ok ".deploy/state.json"

put_secret ADMIN_SECRET "$(admin_secret)"
[[ -n "${FLUTTERWAVE_SECRET:-}" ]] && put_secret FW_SECRET "$FLUTTERWAVE_SECRET"

rm -rf .build

# cron → paid-term enforcement + renewal notices (uses the cf helper for correct headers)
if cf PUT "/workers/scripts/$WORKER_NAME/cron_triggers" '{"targets":[{"cron":"15 6,12,18,0 * * *","retry":{}}],"predictions":[]}' >/dev/null; then
  ok "cron: 4x daily"
else
  warn "cron not set — run: cf PUT /workers/scripts/$WORKER_NAME/cron_triggers"
fi

# ---------------------------------------------------------------- self-check
BASE="https://$WORKER_NAME.$(workers_subdomain | tail -1).workers.dev"
for i in 1 2 3 4 5; do
  curl -sf --max-time 15 "$BASE/__ping" >/dev/null 2>&1 && break; sleep 2
done
curl -sf --max-time 15 "$BASE/__ping" >/dev/null || die "worker did not answer /__ping"
ok "worker live: $BASE"
echo "--- /__selftest ---"
curl -s --max-time 30 "$BASE/__selftest" | jq '{version, kv_stores, kv_roundtrip, templates: {store: .tpl_store, onboard: .tpl_onboard, admin: .tpl_admin}, pricing_absorb: .pricing.fee_absorbed_by_merchant, products: (.csv|length), feed_url_ok: (.feed_url_sheet != null), secret_leak_check}'
echo "--- routes ---"
for r in / /onboard /fees /rails /data/sample-menu.csv; do
  printf '  %-9s %s\n' "$r" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE$r")"
done
[[ "$MODE" == "--push" ]] && push_github
echo
ok "done. Give merchants this one link: $BASE/onboard"
echo "    stores appear with no action from you; each edits its own Google Sheet."
