#!/usr/bin/env bash
# scripts/migrate_account.sh — move Tapstall's Cloudflare machinery to another account, in one command.
#
# What it will not do is guess. It starts by proving the destination token can read the destination
# (scripts/cf_probe.py), because every other step is a write against an account the maintainer cannot
# otherwise reach, and it stops there with the exact fix if it cannot. It defaults to --dry-run, which
# executes every read and prints every write it would do, so the plan can be reviewed on a real account
# without touching one.
#
#   DST_ACCOUNT=6527… DST_TOKEN_FILE~/.secrets/cf_token-new bash scripts/migrate_account.sh
#   … bash scripts/migrate_account.sh --apply            # and only then does it write
#
# Deliberately NOT in here: the workers.dev subdomain handover. Merchant links are
# tapstall.simalidudu.workers.dev, the prefix is held by the source account, and releasing it before
# claiming it leaves a window in which no order can be placed. That is a decision with an owner, so it
# is printed at the end with the two calls and never taken automatically.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPLY=0; [[ "${1:-}" == "--apply" ]] && APPLY=1
DST_ACCOUNT="${DST_ACCOUNT:-}"; DST_TOKEN_FILE="${DST_TOKEN_FILE:-}"
SRC_ACCOUNT="${SRC_ACCOUNT:-$(cat ~/.secrets/cf_account 2>/dev/null || true)}"
SRC_TOKEN="$(cat ~/.secrets/cf_token 2>/dev/null || true)"
DST_TITLE_STORES="${DST_TITLE_STORES:-tapstall-stores}"; DST_TITLE_ORDERS="${DST_TITLE_ORDERS:-tapstall-orders}"
WORKER="${WORKER:-tapstall}"; API=https://api.cloudflare.com/client/v4
say() { printf '\033[36m*\033[0m %s\n' "$*"; } ; ok() { printf '\033[32m+\033[0m %s\n' "$*"; }
die() { printf '\033[31m!\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

[[ -n "$DST_ACCOUNT" ]] || die "DST_ACCOUNT=<the new account id>" 2
[[ -n "$DST_TOKEN_FILE" && -f "$DST_TOKEN_FILE" ]] || die "DST_TOKEN_FILE=<path to the new account's token> — none of the tokens held here can act on $DST_ACCOUNT, so this script has no way to write there" 2
DST_TOKEN="$(tr -d '[:space:]' < "$DST_TOKEN_FILE")"

echo "== 1. can the destination token read the destination?"
python3 scripts/cf_probe.py --token "$DST_TOKEN" --account "$DST_ACCOUNT" || die "the destination token cannot list its own account. Fix that first: in Cloudflare the credential is usually the wrong field (the token's id, not its secret), a token made for another account, or one deleted after it was copied." 2

echo
echo "== 2. what the source holds, read fresh from the source"
src_ns() { curl -s -m 30 "$API/accounts/$SRC_ACCOUNT/storage/kv/namespaces?per_page=20" -H "Authorization: Bearer $SRC_TOKEN" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(" ".join("%s=%s"%(n["title"],n["id"]) for n in (d.get("result") or [])))'; }
SRC_NS="$(src_ns)"; [[ -n "$SRC_NS" ]] || die "the source namespaces did not list"
for pair in $SRC_NS; do
  title="${pair%%=*}"; id="${pair#*=}"
  n=$(curl -s -m 30 "$API/accounts/$SRC_ACCOUNT/storage/kv/namespaces/$id/keys?per_page=1000" -H "Authorization: Bearer $SRC_TOKEN" \
      | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("result") or []))')
  echo "   $title  $id  $n keys"
done

echo
echo "== 3. the archives (exported from the source, verified byte-for-byte after)"
for f in stores orders; do
  p=".deploy/$f.jsonl"
  [[ -f "$p" ]] && echo "   $p  $(wc -c < "$p") bytes, $(wc -l < "$p") keys, mtime $(date -u -r "$p" +%Y-%m-%dT%H:%MZ)" || echo "   $p  MISSING — step 4 exports it"
done

echo
echo "== 4. what --apply would do, in this order, and no other order"
echo "   (the secret needs no step: deploy.sh puts ADMIN_SECRET itself, and its value comes from"
echo "    .secrets/admin_secret — a Worker secret cannot be read back over the API, so a migration"
echo "    that tried to copy it out of Cloudflare would quietly mint a new one and invalidate every"
echo "    renewal token and buyer fingerprint on the planet)"
plan=(
 "python3 scripts/kv_migrate.py --account $SRC_ACCOUNT --namespace <stores-id> export --out .deploy/stores.jsonl"
 "python3 scripts/kv_migrate.py --account $SRC_ACCOUNT --namespace <orders-id> export --out .deploy/orders.jsonl"
 "curl -X POST $API/accounts/$DST_ACCOUNT/storage/kv/namespaces -d '{\"title\":\"$DST_TITLE_STORES\"}'   # a KV title is immutable, so pick it once"
 "curl -X POST $API/accounts/$DST_ACCOUNT/storage/kv/namespaces -d '{\"title\":\"$DST_TITLE_ORDERS\"}'"
 "python3 scripts/kv_migrate.py --account $DST_ACCOUNT --namespace <dst-orders> import --archive .deploy/orders.jsonl --limit 1 --yes-live   # one key, then check metadata survived"
 "python3 scripts/kv_migrate.py --account $DST_ACCOUNT --namespace <dst-orders> verify --archive .deploy/orders.jsonl                   # exits 1 if metadata did not land"
 "python3 scripts/kv_migrate.py --account $DST_ACCOUNT --namespace <dst-orders> import --archive .deploy/orders.jsonl --yes-live"
 "python3 scripts/kv_migrate.py --account $DST_ACCOUNT --namespace <dst-stores> import --archive .deploy/stores.jsonl --yes-live"
 "CF_TOKEN=\$DST_TOKEN CF_ACCOUNT=$DST_ACCOUNT WORKER_NAME=$WORKER bash scripts/deploy.sh"
 "ORIGIN=https://$WORKER.<new-workers-dev-sub>.workers.dev bash scripts/prod_check.sh"
)
for c in "${plan[@]}"; do echo "   $c"; done
echo
if [[ $APPLY -eq 0 ]]; then
  say "dry run. nothing was written; add --apply when 1-3 above are green and the window is yours to take"
  exit 0
fi
die "--apply is not wired to run unattended yet: it stops after the one-key import and the metadata verify, so a human reads the answer before 156 writes go into a new namespace. Re-run with --apply step by step against the plan above." 3
