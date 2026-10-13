#!/usr/bin/env bash
# scripts/quota.sh — what the KV write budget looks like right now, and what a pipeline run costs.
#
# Why this exists: on the free plan the binding limit is not CPU or memory, it is 1,000 KV writes a
# day across the whole account, and nothing in the Cloudflare UI shows a maintainer both halves of the
# answer at once — what the account is holding, and what is spending it. Both halves here come from
# READS (two key listings and one value per shop), and reads are 100,000 a day, so this script is
# safe to run as often as you like, including on a day the writes are gone.
#
# It writes nothing and creates nothing — unlike /__selftest, which has to write a probe key to know
# it can. That distinction is the whole design of v0.9.1, so the script keeps it.
#
#   ./scripts/quota.sh
#   ./scripts/quota.sh mamatoe kotaking      # plus that shop's own order-writes today
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "${SCRIPT_DIR}/lib.sh"
WORKER_NAME="${WORKER_NAME:-tapstall}"
# a missing token costs you the account half of the answer, not the whole script
load_secrets >/dev/null 2>&1 || CF_ACCOUNT=""

HANDLES=("$@"); ((${#HANDLES[@]})) || HANDLES=(${HANDLE:-})

api() { curl -s -m "${2:-30}" "https://api.cloudflare.com/client/v4${1}" -H "Authorization: Bearer ${CF_TOKEN}"; }

if [[ -z "${CF_ACCOUNT:-}" ]]; then
  say "no Cloudflare token in env or ~/.secrets — this script prints nothing invented, so run it where one is readable"
  exit 2
fi

# The namespace ids are read off the Worker's own bindings rather than looked up by title: a title can
# be duplicated or renamed, and these ids are the ones the running Worker is pointed at. (lib.sh's
# kv_id resolves by title and *creates* on a miss — right for a deploy, wrong for a measurement.)
ids=$(api "/accounts/${CF_ACCOUNT}/workers/scripts/${WORKER_NAME}/settings" | python3 -c '
import json, sys
try: b = (json.load(sys.stdin).get("result") or {}).get("bindings") or []
except Exception: b = []
print(" ".join("%s:%s" % (x.get("binding") or x.get("name"), x.get("namespace_id") or x.get("id"))
              for x in b if x.get("type") == "kv_namespace"))')
# one colon per pair, because ${pair##*:} silently returns the whole string when there is none — the
# first draft of this line printed a namespace id and then could not find it again
declare -A NS=()
for pair in $ids; do NS["${pair%%:*}"]="${pair#*:}"; done
for want in STORES ORDERS; do
  [[ -n "${NS[$want]:-}" ]] || { say "nothing bound to ${want} on ${WORKER_NAME} — cannot measure"; exit 1; }
done

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# Both namespaces are listed once and the listing is reused below, because a script that measures the
# budget should not itself be a caller hitting the same keys three times for three different questions.
for pair in "stores:STORES" "orders:ORDERS"; do
  name="${pair%%:*}"; id="${NS[${pair##*:}]}"
  api "/accounts/${CF_ACCOUNT}/storage/kv/namespaces/${id}/keys?per_page=1000" > "${tmp}/${name}.json"
done

echo "== what the account holds, by key prefix"
for name in stores orders; do
  python3 - "$tmp/${name}.json" "$name" <<'PYX'
import json, sys, collections
d = json.load(open(sys.argv[1])).get("result") or []
buckets = collections.Counter(k["name"].split(":")[0] for k in d)
print("   %-6s %4d keys: %s" % (sys.argv[2], len(d), ", ".join("%s=%d" % kv for kv in sorted(buckets.items()))))
if len(d) >= 1000:
    print("   ^ the listing caps at 1,000 keys, so read that as a floor")
PYX
done

echo
echo "== what each shop's ledger looks like now"
# The line that matters after v0.9.1: order documents carry their own row, so `list:` stops growing,
# and the `list=2` above next to 100+ orders is not a bug in the listing — it is the design. A shop
# with orders but no list key of its own is a shop whose ledger is entirely in the documents.
python3 - "$tmp/orders.json" "$tmp/stores.json" "${HANDLES[@]}" <<'PYX'
import json, sys, collections
orders = [k["name"] for k in (json.load(open(sys.argv[1])).get("result") or [])]
stores = {k["name"] for k in (json.load(open(sys.argv[2])).get("result") or [])}
by_shop = collections.Counter(n.split(":")[1] for n in orders if n.startswith("order:") and n.count(":") >= 2)
listed = {n.split(":")[1] for n in orders if n.startswith("list:")}
want = sys.argv[3:] or sorted(by_shop)
print("   %-12s %8s %8s %10s" % ("shop", "orders", "list key", "newest id"))
for h in want:
    docs = sorted(n for n in orders if n.startswith("order:%s:" % h))
    print("   %-12s %8d %8s %10s" % (h, len(docs), "yes" if h in listed else "none",
                                      (docs[-1].split(":")[-1] if docs else "—")))
if not want:
    print("   no orders in the namespace at all — nothing to show, and nothing spending the budget")
extra = set(by_shop) - set(want)
if extra:
    print("   (%d more shop(s) hold orders; name them on the command line to see them)" % len(extra))
PYX

echo "== what a pipeline run costs, from v0.9.1 on"
cat <<'TXT'
   a merchant's order, correction-free            1 write   (the document; its ledger row rides on it)
   a correction to that order                     1 or 0     (a re-shape of the row, never a list write)
   a menu save                                    1
   a day of guide views, per shop                 0          (the seen tally lives in memory)
   the rate limiter, below half its ceiling       0          (an isolate-local door; KV only on a block)
   a deploy, pages included                       0          (git's bytes ARE the bundle; no page publish)
   a page emergency cover                         1          (deploy.sh --pages-override <name>)
   the nightly selftest                           1          (it has to write, to know that it can)
TXT
