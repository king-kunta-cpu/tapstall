#!/usr/bin/env bash
# ZimLink deploy — one command, no dashboard clicking, no manual per-customer step.
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
  ./scripts/ui_kit.py check
  ./scripts/build_bundle.sh /tmp/zl-dryrun >/dev/null && ok "dry run: tests pass, ui kit inlined, bundle builds"
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
STORES_ID=$(kv_id "$KV_STORES" STORES | tail -1 | tr -dc "a-f0-9")
ORDERS_ID=$(kv_id "$KV_ORDERS" ORDERS | tail -1 | tr -dc "a-f0-9")
say "stores=$STORES_ID  orders=$ORDERS_ID"

# the shipped pages must be the generated ones, or KV would publish a stale UI
./scripts/ui_kit.py check || die "pages/*.html are out of date with pages/src/ — run ./scripts/ui_kit.py and commit"

say "templates → KV (hot-swappable: HTML edits need no redeploy)"
kv_put_tpl "$STORES_ID" store onboard admin fees index confirm renew ops sample-menu.csv

say "building bundle"
./scripts/build_bundle.sh .build

# wrangler.toml is generated, never hand-edited, so the KV ids can not drift
WORKER_NAME="$WORKER_NAME" STORES_ID="$STORES_ID" ORDERS_ID="$ORDERS_ID" python3 - <<'PYEOF'
import os
w, sid, oid = os.environ["WORKER_NAME"], os.environ["STORES_ID"], os.environ["ORDERS_ID"]
open("wrangler.toml", "w").write(f"""name = "{w}"
main = "worker/worker.js"
compatibility_date = "2025-06-01"
workers_dev = true

# Templates are served from KV (keys tpl:*) so an HTML fix is one PUT, not a
# redeploy: no git push, no dashboard, no build step. That is why there is no
# [assets] block here — Cloudflare's static-asset upload format is the one part
# of this stack that is not pleasant to script, and KV does the job for free.
[[kv_namespaces]]
binding = "STORES"
id = "{sid}"

[[kv_namespaces]]
binding = "ORDERS"
id = "{oid}"

[triggers]
crons = ["15 6,12,18,0 * * *"]

[observability]
enabled = true
""")
print("wrangler.toml regenerated")
PYEOF

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
[[ "$MODE" == "--push" ]] && push_github
echo
ok "done. Give merchants this one link: $BASE/onboard"
echo "    stores appear with no action from you; each edits its own Google Sheet."
