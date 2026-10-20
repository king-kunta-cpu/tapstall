#!/usr/bin/env bash
# scripts/quota.sh — what the KV write budget looks like right now, and what a pipeline run costs.
#
# Why this exists: on the free plan the binding limit is not CPU or memory, it is 1,000 KV writes a
# day across the whole account (and 1,000 deletes, 1,000 lists, 100k reads/requests). The default
# mode therefore asks Cloudflare's GraphQL analytics — the account's own counters — and spends
# **zero KV operations of any kind** to measure them. The old inventory (two namespace listings
# plus per-shop reads) still exists behind --inventory for the day you need to know what keys are
# held, and it says up front that it spends list/read quota to find out.
#
#   ./scripts/quota.sh                 # GraphQL usage vs the free budgets (zero KV ops)
#   ./scripts/quota.sh --inventory     # key-prefix inventory (spends KV lists/reads)
#   ./scripts/quota.sh mamatoe         # legacy spelling of --inventory for one shop
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; source "${SCRIPT_DIR}/lib.sh"
WORKER_NAME="${WORKER_NAME:-tapstall}"
CF_TOKEN="${CF_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}"
CF_ACCOUNT="${CF_ACCOUNT:-${CLOUDFLARE_ACCOUNT_ID:-}}"
for _d in ".secrets" "$HOME/.secrets"; do
  [[ -z "${CF_TOKEN:-}" && -f "$_d/cf_token" ]] && read -r CF_TOKEN < "$_d/cf_token" || true
  [[ -z "${CF_ACCOUNT:-}" && -f "$_d/cf_account" ]] && read -r CF_ACCOUNT < "$_d/cf_account" || true
done
export CF_TOKEN CF_ACCOUNT

MODE=usage
if [[ "${1:-}" == "--inventory" ]]; then MODE=inventory; shift;
elif [[ "${1:-}" == "--usage" ]]; then shift;
elif [[ -n "${1:-}" ]]; then MODE=inventory; fi
HANDLES=("$@"); ((${#HANDLES[@]})) || HANDLES=(${HANDLE:-})

api() { curl -s -m "${2:-30}" "https://api.cloudflare.com/client/v4${1}" -H "Authorization: Bearer ${CF_TOKEN}"; }

if [[ -n "${CF_TOKEN:-}" && -z "${CF_ACCOUNT:-}" ]]; then
  CF_ACCOUNT=$(api "/accounts?per_page=50" | jq -r '.result[0].id // empty' 2>/dev/null || true)
fi
if [[ -z "${CF_ACCOUNT:-}" ]]; then
  say "no Cloudflare token in env or ~/.secrets — this script prints nothing invented, so run it where one is readable"
  exit 2
fi

if [[ "$MODE" == "usage" ]]; then
  CF_TOKEN="$CF_TOKEN" CF_ACCOUNT="$CF_ACCOUNT" WORKER_NAME="$WORKER_NAME" python3 - <<'PYQ'
import datetime, json, os, urllib.request
tok, acct = os.environ["CF_TOKEN"], os.environ["CF_ACCOUNT"]
worker = os.environ.get("WORKER_NAME", "tapstall")
end = datetime.date.today(); start = end - datetime.timedelta(days=6)
def gql(q, vars):
    body = json.dumps({"query": q, "variables": vars}).encode()
    req = urllib.request.Request("https://api.cloudflare.com/client/v4/graphql", data=body, method="POST",
        headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json", "User-Agent": "tapstall-quota"})
    with urllib.request.urlopen(req, timeout=30) as r:
        out = json.load(r)
    if out.get("errors"):
        raise SystemExit("GraphQL refused: %s" % json.dumps(out["errors"])[:300])
    accts = ((out.get("data") or {}).get("viewer") or {}).get("accounts") or []
    return accts[0] if accts else {}
kvq = """query($a:string!,$s:Date,$e:Date){viewer{accounts(filter:{accountTag:$a}){
  kvOperationsAdaptiveGroups(limit:10000,filter:{date_geq:$s,date_leq:$e},orderBy:[date_DESC]){
    sum{requests} dimensions{date actionType namespaceId}}}}}"""
wq = """query($a:string!,$s:Date,$e:Date,$w:string){viewer{accounts(filter:{accountTag:$a}){
  workersInvocationsAdaptive(limit:10000,filter:{date_geq:$s,date_leq:$e,scriptName:$w},orderBy:[date_DESC]){
    sum{requests errors subrequests} dimensions{date status}}}}}"""
kv = gql(kvq, {"a": acct, "s": str(start), "e": str(end)}).get("kvOperationsAdaptiveGroups") or []
wk = gql(wq, {"a": acct, "s": str(start), "e": str(end), "w": worker}).get("workersInvocationsAdaptive") or []
LIM = {"read": 100000, "write": 1000, "delete": 1000, "list": 1000}
by_day, peak = {}, {}
for g in kv:
    d, a = g["dimensions"]["date"], g["dimensions"]["actionType"]
    by_day.setdefault(d, {})[a] = by_day.setdefault(d, {}).get(a, 0) + g["sum"]["requests"]
for d, acts in by_day.items():
    for a, n in acts.items(): peak[a] = max(peak.get(a, 0), n)
today = by_day.get(str(end), {})
print("== Cloudflare free budgets — today (%s, UTC) vs the ceiling" % end)
for a in ("write", "delete", "list", "read"):
    n = today.get(a, 0)
    print("   KV %-7s %6d / %-6d  (%4.1f%%)   7-day peak %d" % (a, n, LIM[a], 100.0 * n / LIM[a], peak.get(a, 0)))
req_today = sum((g["sum"]["requests"] or 0) for g in wk if g["dimensions"]["date"] == str(end))
req_peak = {}
for g in wk:
    d = g["dimensions"]["date"]; req_peak[d] = req_peak.get(d, 0) + (g["sum"]["requests"] or 0)
print("   Worker requests %6d / 100000  (%4.1f%%)   7-day peak %d" % (req_today, req_today / 1000.0, max(req_peak.values() or [0])))
print()
print("== last 7 days, KV operations by day")
for d in sorted(by_day):
    acts = by_day[d]
    print("   %s  write %-5d delete %-5d list %-5d read %-6d" % (d, acts.get("write", 0), acts.get("delete", 0), acts.get("list", 0), acts.get("read", 0)))
print()
print("Soft ceilings the Worker governs itself by (core QUOTA_RESERVE): automation stops at 800 writes,")
print("telemetry at 700, operator saves at 925, security at 975 — the last writes belong to orders.")
PYQ
  cat <<'TXT'

== what a pipeline run costs, from v1.3.0 on
   a warm order                                   1 write    (the document; sequence is block-leased 1/50, buyer counters coalesce)
   an unchanged feed refresh                      0 writes   (isolate memory; durable snapshot only on change / 6h)
   a warm storefront view                         0 writes   (~1 KV read: the template-override check)
   cron, healthy estate                           0 reads/shop (store metadata row) + 1 list/1000 shops per slot
   a deploy, pages included                       0 KV writes (pages ride in the bundle)
   this script (default mode)                     0 KV ops   (GraphQL analytics only)
TXT
  exit 0
fi

say "inventory mode: this spends KV list/read quota (two listings, then reads) — the default mode spends none"

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
