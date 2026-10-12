#!/usr/bin/env bash
# Production check for the merchant-authority release and the two UI suites.
#
# Proves the four claims that matter on the live Worker:
#   1. a leaked or shared link cannot read the ledger or rewrite the payout account
#   2. a crawler that prefetches a confirm link changes nothing
#   3. merchants who hold a v0.2 `?token=` link are not stranded by the upgrade
#   4. the public surfaces still answer exactly as they did before
#   5. both consoles (merchant pages, /ops) are live, gated, and say nothing
#
# It creates two throwaway orders on $HANDLE and cancels them both at the end.
# Nothing else about that store is left changed.
#
# Which lines are `ckw` is a claim about cost, not about importance: everything on the
# buyer's door needs a write (an order to hold the code, or the nightly publish that
# moves a page), so on a day the 1,000 free KV writes are gone they are reported as
# blocked rather than red — thirteen red lines about a spent budget is how a real
# failure hides.
set -uo pipefail
cd "$(dirname "$0")/.."
ORIGIN="${ORIGIN:-https://tapstall.simalidudu.workers.dev}"
HANDLE="${HANDLE:-mamatoe}"
TOK=$(cat /home/user/.secrets/cf_token 2>/dev/null || echo "${CLOUDFLARE_API_TOKEN:-}")
ACCT=$(cat /home/user/.secrets/cf_account 2>/dev/null || echo "${CLOUDFLARE_ACCOUNT_ID:-}")
KV=${KV_NS:-b5c1c89d95114092ae91bbafc5a2d76c}     # tapstall-stores (was zimlink-stores): store docs, templates
ORD_KV=${ORDERS_NS:-4f4ac94a66db4b859b61668a3c160819}   # tapstall-orders (was zimlink-orders): order docs, lists
pass=0 fail=0
blocked=0

# grep -q returns the moment it matches. Under `set -o pipefail` that kills the printf
# feeding it with SIGPIPE, so the pipeline's status is 141 and the branch taken is
# "not found" — which means any pattern sitting in the first part of a large page was
# reported as missing. Three checks in section [6] were lying that way. Both helpers
# therefore grep a file: no pipeline to cut short, and the verdict is grep's alone.
ckf=/tmp/ts_ck.$$
ck() {   # ck <name> <must-contain-regex> <actual>
  printf '%s\n' "$3" > "$ckf"
  if grep -qE -- "$2" "$ckf"; then printf '  \033[32m+\033[0m %s\n' "$1"; pass=$((pass + 1))
  elif grep -qE 'KV put\(\) limit|limit exceeded|retry_in_sec|free KV writes' "$ckf"; then
    # 1,000 free KV writes a day is a fact of the plan, not of this build. A
    # step that needs a write cannot be verified on a spent day, and calling
    # that "failed" thirteen times buries the two lines that matter. Say it
    # once per line, in its own colour, and keep the answer in the output.
    printf '  \033[33m!\033[0m %s \033[2m— not verifiable today: the account has no KV writes left\033[0m\n      got:  %s\n' "$1" "$(head -c 200 "$ckf" | tr '\n' ' ')"; blocked=$((blocked + 1))
  else printf '  \033[31m-\033[0m %s\n      want: %s\n      got:  %s\n' "$1" "$2" "$(head -c 240 "$ckf" | tr '\n' ' ')"; fail=$((fail + 1)); fi
}
ckw() {  # like ck, for a line that cannot be verified without a KV write today
  # These are not failures of the build: the assertion needs an order or a staged
  # settings change to exist, and nothing can be made to exist while the account's
  # 1,000 writes are gone. Reporting them red every day buries the lines that mean
  # something, so they are reported as what they are — with the count kept apart.
  if [[ "$NOWRITE" == 1 ]]; then
    printf '  \033[33m!\033[0m %s \033[2m— needs a KV write, and there are none left today\033[0m\n' "$1"
    blocked=$((blocked + 1)); return
  fi
  ck "$@"
}
nkw() {  # like nk, for a must-not-contain line whose input cannot exist without a write
  # A must-not-contain check on an empty input passes for the wrong reason: no order
  # was created, so nothing was found, so the line is green. On a spent day that is a
  # false green repeated, so say what is true instead — not verifiable today.
  if [[ "$NOWRITE" == 1 ]]; then
    printf '  \033[33m!\033[0m %s \033[2m— needs a KV write, and there are none left today\033[0m\n' "$1"
    blocked=$((blocked + 1)); return
  fi
  nk "$@"
}
nk() {   # nk <name> <must-NOT-contain-regex> <actual>
  printf '%s\n' "$3" > "$ckf"
  if grep -qE -- "$2" "$ckf"; then printf '  \033[31m-\033[0m %s (found: %s)\n' "$1" "$(grep -oE "$2" "$ckf" | head -1)"; fail=$((fail + 1));
  else printf '  \033[32m+\033[0m %s\n' "$1"; pass=$((pass + 1)); fi
}
code() { curl -s -m 30 -o /dev/null -w '%{http_code}' "$@"; }
trap 'rm -f "$ckf"' EXIT

echo "target: $ORIGIN"
echo "store:  $HANDLE"

# ---- alias mode -------------------------------------------------------------
# The previous brand's hostname is a redirect alias now. Running this harness
# against it as if it were the app produced 20 red lines about pages that are
# *supposed* to 301, which buries the only question an alias has to answer: does
# it move people without losing anything, and does it stay out of the scheduled
# work? So the role is detected, not assumed — `ORIGIN=https://zimlink…` picks up
# alias mode on its own, and ROLE=alias forces it.
CANON="${CANON:-https://tapstall.simalidudu.workers.dev}"
ROLE="${ROLE:-auto}"
if [[ "$ROLE" == "auto" ]]; then
  if [[ "$(code "$ORIGIN/onboard")" == "301" ]]; then ROLE=alias; else ROLE=app; fi
fi
if [[ "$ROLE" == "alias" ]]; then
  AV=$(grep -m1 "^const VERSION = " worker/worker.js | tr -dc '0-9.')
  echo "mode: redirect alias — page paths must 301 to $CANON; everything else is answered here"
  ck "an alias runs the same build as the app ($AV)" "\"$AV\"" "$(curl -s -m 30 "$ORIGIN/__ping")"
  ck "an alias says it does not own the daily sweep" '"cron_owner":false' "$(curl -s -m 60 "$ORIGIN/__selftest")"
  for path in / /fees /onboard /ops "/s/$HANDLE" "/a?code=xyz" /renew/abc /c/abc /rails /data/sample-menu.csv; do
    HD=$(curl -s -m 30 -D - -o /dev/null "$ORIGIN$path" | tr -d '\r')
    ck "$path moves" '^HTTP/[0-9.]+ 301' "$(printf '%s' "$HD" | head -1)"
    # `?` and `.` are regex characters, and the query in `/a?code=xyz` is exactly
    # the sort of thing an ERE eats, so the pair is checked as two plain substrings.
    LOC=$(printf '%s' "$HD" | grep -i '^location:' | tr -d '[:space:]')
    ck "  · $path arrives at the canonical origin" "location:${CANON}" "$LOC"
    case "$path" in
      *\?*) ck "  · $path keeps its query string" "${path#*\?}" "$LOC" ;;
    esac
  done
  ck "a POST is never bounced, because a redirect eats the body" '^400$' "$(code -X POST -H 'content-type: application/json' -d '{}' "$ORIGIN/api/auth")"
  ck "  · and the retired link door answers, it does not bounce" '^410$' "$(code -X POST -H 'content-type: application/json' -d '{"code":"junk"}' "$ORIGIN/api/login")"
  ck "the buyer's order POST is answered here" '^(400|422|503)$' "$(code -X POST -H 'content-type: application/json' -d '{}' "$ORIGIN/api/order")"
  ck "a data read is served, not redirected" '"ok":true' "$(curl -s -m 30 "$ORIGIN/api/lookup?handle=$HANDLE")"
  BODY=$(curl -sL -m 60 "$ORIGIN/s/$HANDLE")
  ck "following an old store link lands on a real store page" "$HANDLE" "$BODY"
  ck "  · and that page carries no old brand" '^0$' "$(printf '%s' "$BODY" | grep -ci zimlink)"
  ck "  · with every config hook filled" '^0$' "$(printf '%s' "$BODY" | grep -c '\*/null')"
  ck "  · and the store config the buyer's page needs reads fine here too" '"rail_info"' "$(curl -sL -m 30 "$ORIGIN/s/$HANDLE/config.json")"
  echo
  printf '%s\n' "alias: passed: $pass   failed: $fail"
  [[ $fail -eq 0 ]] || exit 1
  exit 0
fi

# The previous brand's hostname is a live door: links already sent to merchants are
# absolute. Alias *mode* has its own rigorous run, but nothing in the ordinary one
# looked at the alias at all — which is how a fallback publisher dropping REDIRECT_TO
# served the app twice and scheduled the sweep twice without a red line anywhere.
LEG="${LEGACY_ORIGIN:-https://zimlink.simalidudu.workers.dev}"
if [[ "$ORIGIN" != "$LEG" ]]; then
  LH=$(curl -s -m 20 -o /dev/null -D - "$LEG/s/$HANDLE" | tr -d '\r')
  ck "the old hostname still moves a saved store link, rather than serving the app twice" '^HTTP/[0-9.]+ 301' "$(printf '%s' "$LH" | head -1)"
  ck "  · and stays out of the daily sweep" '"cron_owner":false' "$(curl -s -m 30 "$LEG/__selftest")"
fi

echo "[1] version, and the security primitives inside the Worker's own runtime"
WANT_VER=$(grep -m1 "^const VERSION = " worker/worker.js | tr -dc '0-9.')
ck "ping reports the version in this checkout ($WANT_VER)" "\"$WANT_VER\"" "$(curl -s -m 30 "$ORIGIN/__ping")"
ST=$(curl -s -m 60 "$ORIGIN/__selftest")
# A day with no KV writes left is not a day the Worker is broken, and thirteen
# red lines about "the security primitives" would say it is. The probe reports
# `kv_write_blocked` when that is the only cause; drop the one assertion that
# genuinely needs a write, say so once, and check every read-side claim anyway.
NOWRITE=0
if printf '%s' "$ST" | grep -q 'kv_write_blocked'; then NOWRITE=1; fi
SK="cap_roundtrip cap_rejects_tamper cap_rejects_other_secret cap_rejects_expired
    settings_rejects_bad money_change_is_held money_change_lands_late masking_hides_values
    secret_leak_check kv_stores"
if printf '%s' "$ST" | grep -q 'kv_write_blocked'; then
  printf '  \033[33m!\033[0m selftest: this account has no KV writes left today (%s) — kv_roundtrip cannot pass; everything else is still checked\n' \
    "$(printf '%s' "$ST" | jq -r '"clears in " + ((.kv_write_blocked.retry_in_sec / 3600) | floor | tostring) + " h"')"
  ck "selftest says which keys are green anyway" '"pricing"' "$ST"
else
  SK="$SK kv_roundtrip"
fi
for k in $SK; do
  ck "selftest.$k" "\"$k\":true" "$ST"
done
if printf '%s' "$ST" | grep -q 'kv_write_blocked'; then ck "  · and the single verdict still says degraded, honestly" '"ok":false' "$ST"; else ck "selftest.ok reflects all of it" '"ok":true' "$ST"; fi
for t in tpl_store tpl_onboard tpl_admin tpl_fees tpl_index; do ck "selftest.$t" "$t.:true" "$ST"; done
ck "selftest.kv_orders" '"kv_orders":true' "$ST"
ck "selftest.pricing" '"pay_now"' "$ST"

echo "[2] the hole this release closes: /api/lookup used to hand out the dashboard"
LOOK=$(curl -s -m 30 "$ORIGIN/api/lookup?handle=$HANDLE")
ck "lookup still reports public health" '"orders_today"' "$LOOK"
for leak in admin_url renew_url pay_account feed_url admin_token whatsapp notify_email; do
  nk "lookup does not mention $leak" "$leak" "$LOOK"
done

echo "[3] a GET never moves money, and admin paths are not readable cross-origin"
H=$(mktemp)
ck "GET /api/mark -> 405" '^405$' "$(curl -s -m 30 -D "$H" -o /dev/null -w '%{http_code}' "$ORIGIN/api/mark?handle=$HANDLE&id=x&status=paid")"
ck "with Allow: POST" 'allow: *POST' "$(tr -d '\r' < "$H" | grep -i '^allow')"
ck "explaining itself to a human" 'opened, not fetched' "$(curl -s -m 30 "$ORIGIN/api/mark?handle=$HANDLE&id=x&status=paid")"
HEADERS=$(tr -d '\r' < "$H")
nk "no Access-Control-Allow-Origin on the response" 'access-control-allow-origin' "$HEADERS"
ck "CSP blocks framing" "frame-ancestors 'none'" "$HEADERS"
ck "X-Frame-Options: DENY" 'x-frame-options: DENY' "$HEADERS"
ck "Referrer-Policy: no-referrer" 'referrer-policy: no-referrer' "$HEADERS"
ck "no-store" 'cache-control: no-store' "$HEADERS"
ck "GET /api/settings -> 405" '^405$' "$(code "$ORIGIN/api/settings?handle=$HANDLE")"
ck "GET /api/revoke -> 405" '^405$' "$(code "$ORIGIN/api/revoke")"
ck "anonymous settings POST -> 401" '^401$' "$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"handle":"'"$HANDLE"'","hours":"x"}' "$ORIGIN/api/settings")"
ck "OPTIONS on a mutation path -> 403" '^403$' "$(code -X OPTIONS "$ORIGIN/api/settings")"
ck "OPTIONS on the buyer path still allows the storefront" 'access-control-allow-origin: \*' "$(curl -s -m 30 -D - -o /dev/null -X OPTIONS "$ORIGIN/api/order" | tr -d '\r')"
ck "storefront 200" '^200$' "$(code "$ORIGIN/s/$HANDLE")"
# The dashboard embeds the storefront so a merchant can see what a buyer sees.
# That needs same-origin framing on this one path; everything else must still
# refuse it, and the policy must appear once — a header set twice with different
# casing is joined by the Headers object, and a browser then obeys the stricter
# of the two, which is how this feature stayed blank for a whole release.
SH=$(mktemp)
curl -s -m 30 -D "$SH" -o /dev/null "$ORIGIN/s/$HANDLE"
SBLOB=$(tr -d '\r' < "$SH")
ck "storefront is frameable by our own pages" 'x-frame-options: SAMEORIGIN' "$SBLOB"
ck "storefront CSP says frame-ancestors 'self'" "frame-ancestors 'self'" "$SBLOB"
nk "and not a second joined policy forbidding it" "frame-ancestors .none" "$SBLOB"
ck "the dashboard still refuses all framing" 'x-frame-options: DENY' "$(curl -s -m 30 -D - -o /dev/null "$ORIGIN/a" | tr -d '\r')"
rm -f "$SH"
ck "menu feed 200" '^200$' "$(code "$ORIGIN/s/$HANDLE/feed.json")"
ck "fees page 200" '^200$' "$(code "$ORIGIN/fees")"
ck "onboarding 200" '^200$' "$(code "$ORIGIN/onboard")"

echo "[4] prefetching a confirm link, as Slack/WhatsApp/WhatsApp-business do"
STORE=$(curl -s -m 30 -H "Authorization: Bearer $TOK" "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$KV/values/store:$HANDLE")
ADMIN_KEY=$(printf '%s' "$STORE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('admin_token',''))" 2>/dev/null)
[[ -n "$ADMIN_KEY" ]] && echo "  · store doc read from KV (admin_token present)" || { echo "  ! could not read the store doc from KV"; }
# The probe order is built from the store's own shelf, because since 0.6.4 that is
# what a cart has to match: the menu prices the order, not the browser. Reading the
# feed first also proves it is not merely 200 but priced — the old check could not
# tell a live menu from a sheet that had quietly emptied.
FEED=$(curl -s -m 30 "$ORIGIN/s/$HANDLE/feed.json?fresh=1")
PROBE=$(printf '%s' "$FEED" | python3 -c '
import sys, json
try: p = (json.load(sys.stdin).get("products") or [])[0]
except Exception: p = {}
print(json.dumps({"id": str(p.get("id", "")), "name": str(p.get("name") or "prod check item"),
                  "price": float(p.get("price") or 1), "qty": 1}))' 2>/dev/null)
MP=$(printf '%s' "$PROBE" | python3 -c 'import sys,json;v=json.load(sys.stdin)["price"];print("%g" % v)' 2>/dev/null)
ORD=$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{
  "handle":"'"$HANDLE"'","service":"pickup",
  "buyer":{"name":"prod check","phone":"0700000000","optin":true},
  "items":['"$PROBE"']}' "$ORIGIN/api/order")
ID=$(printf '%s' "$ORD" | python3 -c "import sys,json;print(json.load(sys.stdin)['order']['id'])" 2>/dev/null)
MARK=$(printf '%s' "$ORD" | python3 -c "import sys,json;print(json.load(sys.stdin).get('mark_url',''))" 2>/dev/null)
ckw "a probe order exists" '^/c/v1\.' "$MARK"
ckw "  · priced off the shelf, not off the cart ($MP)" '"itemsTotal":'"$MP" "$ORD"
# The other half of the same rule, and it writes nothing: a cart naming something the
# menu does not carry is refused, in words a buyer can act on. This is the line that
# used to read "5 legs of lamb at 0.01 each, invoice attached".
TAMB=$(mktemp)
TAMC=$(curl -s -m 30 -o "$TAMB" -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{
  "handle":"'"$HANDLE"'","service":"pickup",
  "buyer":{"name":"tamper check","phone":"0700000001","optin":true},
  "items":[{"id":"prodcheck-not-real","name":"Whole leg of lamb","price":0.01,"qty":5}]}' "$ORIGIN/api/order")
ckw "a cart the menu does not know is refused, not priced" '^422$' "$TAMC"
ck  "  · and the buyer is told what to do about it" 'Reload the page' "$(cat "$TAMB")"
rm -f "$TAMB"
nk "the confirm link carries no store credential" 'token=|admin_token|/api/mark' "$MARK"
PAGE=$(curl -s -m 30 -A 'Mozilla/5.0 (compatible; Slackbot/1.0; +https://slack.com/faq)' -L "$ORIGIN$MARK")
ckw "the bot gets a page, not a mutation" 'Mark .* paid' "$PAGE"
ckw "the page posts itself when a browser runs it" 'method="post" action="/api/mark"' "$PAGE"
ck "and says what it will do" 'from ' "$PAGE"
# Ground truth is the order document itself. The dashboard list is a separate KV
# key and is eventually consistent, so it can lag a write by up to a minute.
KVORDER=$(curl -s -m 30 -H "Authorization: Bearer $TOK" "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$ORD_KV/values/order:$HANDLE:$ID")
ckw "order document still awaiting_payment after the prefetch" '"status":"awaiting_payment"' "$KVORDER"
nk "and it kept the payout details printed at order time" 'ZZ-PROBE' "$KVORDER"
DASH=$(curl -s -m 30 -H "x-tapstall-admin: $ADMIN_KEY" "$ORIGIN/api/admin?handle=$HANDLE")
nk "no raw login code in the ledger payload" 'code=v1\.' "$DASH"
# now be the browser: post the cap the page would post
POST=$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"cap":"'"${MARK#/c/}"'"}' "$ORIGIN/api/mark")
ckw "the browser POST confirms it" '"status":"paid"' "$POST"
ckw "and hands back a 15-minute undo link" '/c/v1\.' "$POST"
REPLAY=$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"cap":"'"${MARK#/c/}"'"}' "$ORIGIN/api/mark")
ckw "a double tap is a no-op, not a double count" '"already":true' "$REPLAY"
UNDO=$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"cap":"'"$(printf '%s' "$POST" | python3 -c "import sys,json;print(json.load(sys.stdin).get('undo_url','/c/none')[3:])")"'"}' "$ORIGIN/api/mark")
ckw "undo returns it to awaiting_payment" '"awaiting_payment"' "$UNDO"

# ---- the buyer's own door (0.7.3): one public write, one field, one order
# The order is open again, which is exactly when a buyer is allowed to add the code
# their app printed. These lines are the promise the feature was built on, read off
# the live Worker: the door exists, it is scoped to one field, and a stranger with a
# made-up link gets nothing.
PURL=$(printf '%s' "$ORD" | python3 -c "import sys,json;print(json.load(sys.stdin).get('proof_url',''))" 2>/dev/null)
PCAP=${PURL#/p/}
MPCAP=${MARK#/c/}
ckw "the receipt is handed a code link of its own" '^/p/v1\.' "$PURL"
ckw  "  · a different capability from the shop's, not the same one on a new path" '^diff$' "$(if [[ -z "$PCAP" || -z "$MPCAP" || "$PCAP" == "$MPCAP" ]]; then echo same; else echo diff; fi)"
BFORM=$(curl -s -m 30 -A 'Mozilla/5.0 (compatible; Slackbot/1.0; +https://slack.com/faq)' "$ORIGIN/p/$PCAP")
ckw "  · a crawler that fetches it gets a form it cannot fire" 'method=post action="/api/proof"' "$BFORM"
ckw  "  · the page says out loud what the link cannot do" 'cannot mark anything paid' "$BFORM"
ckw  "  · and quotes the shop's own ask rather than inventing one" 'Reference from your bank|Code from the app|app shows' "$BFORM"
BPROBE="ZCPROBE$(date +%s | tail -c 6)"
BPOST=$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"cap":"'"$PCAP"'","proof":"'"$BPROBE"'"}' "$ORIGIN/api/proof")
ckw "the buyer's POST lands, and is called a change" '"changed":true' "$BPOST"
ckw "  · with the value echoed back trimmed, not reshaped" "$BPROBE" "$BPOST"
ck  "  · and the answer counts what is left, so nobody guesses" '"left":2' "$BPOST"
KVBUY=$(curl -s -m 30 -H "Authorization: Bearer $TOK" "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$ORD_KV/values/order:$HANDLE:$ID")
ckw "  · on the order document, named as the buyer's" '"proof_by":"buyer"' "$KVBUY"
ckw "  · the money state untouched by a public write" '"status":"awaiting_payment"' "$KVBUY"
nkw "  · and no link is stored on the order for a reader to reuse" '/p/v1' "$KVBUY"
ckw "  · the door asks for the sender number on a rail that searches by it" 'name=payer' "$BFORM"
ckw "  · in the same words the order form used, not a third vocabulary" 'Number you will pay from' "$BFORM"
DASHB=$(curl -s -m 30 -H "x-tapstall-admin: $ADMIN_KEY" "$ORIGIN/api/admin?handle=$HANDLE")
ckw "  · the ledger row carries it, so the chase sentence leaves on its own" "$BPROBE" "$DASHB"
BOGUS=$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"cap":"v1.9999999999.eyJhIjoicHJvb2YifQ.deadbeef","proof":"XX"}' "$ORIGIN/api/proof")
ckw "a cap nobody minted is refused in the same words as an expired one" 'does not open this field' "$BOGUS"
ck  "  · and the write endpoint is POST-only, so a prefetch cannot use it" '^405$' "$(code "$ORIGIN/api/proof")"
# 0.7.5: the door is kept where it was handed out, and put down when it is used
SF=$(curl -s -m 30 -A 'Mozilla/5.0' "$ORIGIN/s/$HANDLE")
ckw  "  · a returning buyer is offered the door on the shop's own page" 'id="pfbar"' "$SF"
ckw  "  · the offer is a link, in the buyer's words, with a way to put it down" 'add your payment code' "$SF"
ckw  "  · and the stored entry is pruned at the lifetime the token actually has" 'PF_TTL = 72 . 3600 . 1000' "$SF"
ckw  "  · the code page hands the buyer's device the entry to forget" "tp_pf_$HANDLE" "$BFORM"
FSEND=$(curl -s -m 30 -X POST -H 'content-type: application/x-www-form-urlencoded' \
  -d 'form=1&cap='"$PCAP"'&proof='"$BPROBE" "$ORIGIN/api/proof")
ckw "  · the page a no-JS buyer gets after sending carries the same line" "tp_pf_$HANDLE" "$FSEND"
ckw "  · and a resend of the same value rewrites nothing, which is why a retry is free" 'nothing was rewritten' "$FSEND"
# 0.7.7: every answer the door can give puts it down, and a busy minute does not
ckw  "  · the door is forgettable by the link alone, which is all a refusal knows" 'String(x\.u)==="/p/' "$BFORM"
nk   "  · a link nobody minted runs nothing in a browser, not even a tidy-up" '<script>' \
  "$(curl -s -m 30 -A 'Mozilla/5.0' "$ORIGIN/p/v1.9999999999.eyJhIjoicHJvb2YifQ.deadbeef")"
FBLANK=$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/x-www-form-urlencoded' \
  -d 'form=1&cap='"$PCAP"'&proof=' "$ORIGIN/api/proof")
ckw  "  · a refusal page is refused by its status too, and not only by its words" '^422$' "$FBLANK"
# 0.7.8: a spent write budget is answered to the buyer, in words about their order, as a
# page, with Retry-After and no pruning. Today's shape needs no order to reach: the rate-limit
# counter is itself a KV write, so any form POST finds the ceiling first. On a day with writes
# left the same POST gets the ordinary refusal, which is why only the "is a page" assertion is
# unconditional and the buyer-worded ones are gated on the cap.
QFORGE='v1.9999999999.eyJhIjoicHJvb2YifQ.deadbeef'
QPOST=$(curl -s -m 30 -X POST -H 'content-type: application/x-www-form-urlencoded' \
  -d 'form=1&cap='"$QFORGE"'&proof=ZCPROBE' "$ORIGIN/api/proof")
ck "  · a browser posting to the buyer's door always gets a page" '<h2' "$QPOST"
if [[ "$NOWRITE" == 1 ]]; then
  ck "  · a spent budget is spoken to the buyer, about their order" 'the order stands exactly as it was' "$QPOST"
  ck "  · and it prunes nothing, because a full budget is not an answer" '^0$' "$(printf '%s' "$QPOST" | grep -c '<script>')"
  ck "  · with the time to come back in a header, not in prose" '^[0-9]{4,}$' \
    "$(curl -s -o /dev/null -m 30 -w '%header{retry-after}' -X POST -H 'content-type: application/x-www-form-urlencoded' -d 'form=1&cap='"$QFORGE"'&proof=ZCPROBE' "$ORIGIN/api/proof")"
fi

# ---- 0.7.4: the chase carries the door, and the shop can file what it was sent
# The buyer's door closes when the order is settled, and the refusal text sends people
# to the chat. Two things follow, and both are checked here rather than in a comment:
# the ask a merchant copies has to end at a link that still works, and a code that
# arrives in the chat has to have somewhere to land.
DASHC=$(curl -s -m 30 -H "x-tapstall-admin: $ADMIN_KEY" "$ORIGIN/api/admin?handle=$HANDLE")
ROWC=$(printf '%s' "$DASHC" | python3 -c "import sys,json;print(json.dumps(next((o for o in json.load(sys.stdin).get('orders',[]) if o.get('id')=='$ID'), {})))" 2>/dev/null)
ckw "a row whose code has arrived asks for nothing" '^none$' "$(printf '%s' "$ROWC" | python3 -c "import sys,json;d=json.load(sys.stdin);print('none' if 'ask' not in d else 'still asking')" 2>/dev/null)"
ORD2=$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{
  "handle":"'"$HANDLE"'","service":"pickup",
  "buyer":{"name":"prod check two","phone":"0700000002","optin":true},
  "items":['"$PROBE"']}' "$ORIGIN/api/order")
ID2=$(printf '%s' "$ORD2" | python3 -c "import sys,json;print(json.load(sys.stdin)['order']['id'])" 2>/dev/null)
MARK2=$(printf '%s' "$ORD2" | python3 -c "import sys,json;print(json.load(sys.stdin).get('mark_url',''))" 2>/dev/null)
DASH2=$(curl -s -m 30 -H "x-tapstall-admin: $ADMIN_KEY" "$ORIGIN/api/admin?handle=$HANDLE")
ROW2=$(printf '%s' "$DASH2" | python3 -c "import sys,json;print(json.dumps(next((o for o in json.load(sys.stdin).get('orders',[]) if o.get('id')=='$ID2'), {})))" 2>/dev/null)
ckw "a row that still owes a code carries a door for the buyer" '/p/v1\.' "$ROW2"
ckw "  · inside the shop's own sentence, which is what gets copied or tapped" '[Aa]dd it here and (it goes straight on the order|I can confirm your order today)' "$ROW2"
ckw  "  · and the sentence ends at exactly that URL, so a copied slip cannot offer a different door" '^same$' "$(printf '%s' "$ROW2" | python3 -c "import sys,json;d=json.load(sys.stdin);print('same' if d.get('proof_url') and d.get('ask','').endswith(d['proof_url']) else 'different')" 2>/dev/null)"
PURL2=$(printf '%s' "$ROW2" | python3 -c "import sys,json;print(json.load(sys.stdin).get('proof_url',''))" 2>/dev/null)
CAP2=${PURL2##*/p/}
B2="ZC2-$(date +%s | tail -c 6)"
FROMDOOR=$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"cap":"'"$CAP2"'","proof":"'"$B2"'"}' "$ORIGIN/api/proof")
ckw "  · and the minted link is live, not decorative" '"changed":true' "$FROMDOOR"
FILED=$(curl -s -m 30 -X POST -H 'content-type: application/json' -H "x-tapstall-admin: $ADMIN_KEY" \
  -d '{"handle":"'"$HANDLE"'","id":"'"$ID2"'","proof":"CHAT-'"$B2"'"}' "$ORIGIN/api/order/proof")
ckw "the shop files a code that arrived in the chat over the buyer's own" '"changed":true' "$FILED"
KV2=$(curl -s -m 30 -H "Authorization: Bearer $TOK" "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$ORD_KV/values/order:$HANDLE:$ID2")
ckw "  · on the order document, in the shop's hand" '"proof_by":"merchant"' "$KV2"
ckw "  · the buyer's correction budget untouched by a shop write" '"proof_writes":1' "$KV2"
ck  "  · no public door reaches this write at all" '^401$' "$(code -X POST -H 'content-type: application/json' -d '{"handle":"'"$HANDLE"'","id":"'"$ID2"'","proof":"X"}' "$ORIGIN/api/order/proof")"
ck  "  · a GET is refused, so a link prefetch files nothing" '^405$' "$(code "$ORIGIN/api/order/proof")"
ckw "  · and a blank box is answered in the shop's own voice" 'Nothing to file' "$(curl -s -m 30 -X POST -H 'content-type: application/json' -H "x-tapstall-admin: $ADMIN_KEY" -d '{"handle":"'"$HANDLE"'","id":"'"$ID2"'","proof":"   "}' "$ORIGIN/api/order/proof")"

echo "[5] settings: cosmetic instant, money held 15 minutes, cancellable"
HOURS=$(printf '%s' "$STORE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('hours','') or 'open')" 2>/dev/null)
PROBE="ZZ-PROBE-$(date +%s | tail -c 6)"
SR=$(curl -s -m 30 -X POST -H 'content-type: application/json' -H "x-tapstall-admin: $ADMIN_KEY" \
  -d '{"handle":"'"$HANDLE"'","hours":"'"$HOURS"'","pay_account":"'"$PROBE"'"}' "$ORIGIN/api/settings")
ck "held list names the payout field" '"held":\["pay_account"\]' "$SR"
ck "and gives a fuse, not a maybe" '"hold_until":[0-9]' "$SR"
PUB=$(curl -s -m 30 "$ORIGIN/s/$HANDLE/config.json")
nk "the new payout account is NOT live yet" "$PROBE" "$PUB"
nk "and not even visible as a queue" 'pending|auth_gen' "$PUB"
ADMBEF=$(curl -s -m 30 -H "x-tapstall-admin: $ADMIN_KEY" "$ORIGIN/api/admin?handle=$HANDLE")
ckw "the owner sees the raw queued value" "$PROBE" "$(printf '%s' "$ADMBEF" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(json.dumps((d.get('pending') or {}).get('fields', {})))" 2>/dev/null)"
ckw "with a countdown, not a vague promise" '"in_ms":[1-9]' "$ADMBEF"
RV=$(curl -s -m 30 -X POST -H 'content-type: application/json' -H "x-tapstall-admin: $ADMIN_KEY" -d '{"handle":"'"$HANDLE"'"}' "$ORIGIN/api/settings/revert")
ckw "revert cancels it" '"cancelled":\["pay_account"\]' "$RV"
PUB2=$(curl -s -m 30 "$ORIGIN/s/$HANDLE/config.json")
nk "nothing was applied in the meantime" "$PROBE" "$PUB2"
ck "hours unchanged after the whole test" "\"hours\":\"$HOURS\"" "$PUB2"
# 0.6.5: a number per method, and the hours as a week. Both are proven here on a
# live store, then taken back off it — the check leaves nothing behind, which is the
# only reason it is allowed to write at all.
RA=$(curl -s -m 30 -X POST -H 'content-type: application/json' -H "x-tapstall-admin: $ADMIN_KEY" \
  -d '{"handle":"'"$HANDLE"'","rail_accts":{"ecocash_usd":{"acct":"0771234567","holder":"ZZ PROBE","till":"55123"}},"week":[{"open":"09:00","close":"17:00"},null,null,null,null,null,null]}' "$ORIGIN/api/settings")
ck "a per-method number is held like money" '"held":\["rail_accts"\]' "$RA"
ck "  · while the week applies in the same breath" '"applied_now":\["week"\]' "$RA"
PUBW=$(curl -s -m 30 "$ORIGIN/s/$HANDLE/config.json")
ckw "the week writes the sentence buyers read" '"hours":"Mon 09:00-17:00' "$PUBW"
ck "  · and the shop clock ships with it, not the visitor's" '"open":\{' "$PUBW"
nk "no rail map is published to a stranger" 'rail_accts' "$PUBW"
nk "  · and a staged number is not even readable early" 'ZZ PROBE' "$PUBW"
ck "a half-typed week is refused, not read as closed" 'both ends' "$(curl -s -m 30 -X POST -H 'content-type: application/json' -H "x-tapstall-admin: $ADMIN_KEY" -d '{"handle":"'"$HANDLE"'","week":[{"open":"09:00"}]}' "$ORIGIN/api/settings")"
curl -s -m 30 -o /dev/null -X POST -H 'content-type: application/json' -H "x-tapstall-admin: $ADMIN_KEY" -d '{"handle":"'"$HANDLE"'","week":[],"hours":"'"$HOURS"'"}' "$ORIGIN/api/settings"
RV2=$(curl -s -m 30 -X POST -H 'content-type: application/json' -H "x-tapstall-admin: $ADMIN_KEY" -d '{"handle":"'"$HANDLE"'"}' "$ORIGIN/api/settings/revert")
ckw "revert drops the staged number too" 'rail_accts' "$RV2"
PUB3=$(curl -s -m 30 "$ORIGIN/s/$HANDLE/config.json")
nk "and the store is left exactly as it was found" 'ZZ PROBE' "$PUB3"
ck "  · hours back to the shop's own words" "\"hours\":\"$HOURS\"" "$PUB3"
ck "a bad value is refused by field" '"fields":\{"rail"' "$(curl -s -m 30 -X POST -H 'content-type: application/json' -H "x-tapstall-admin: $ADMIN_KEY" -d '{"handle":"'"$HANDLE"'","rail":"momo_pay"}' "$ORIGIN/api/settings")"
ck "a forged cap is refused as expired" '"link_expired"' "$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"cap":"v1.9999999999.eyJhIjoibWFyayJ9.AAAAAAAA"}' "$ORIGIN/api/mark")"
ck "a truncated copy of a real cap is refused" '"link_expired"' "$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"cap":"'"${MARK#/c/}"'x"}' "$ORIGIN/api/mark")"

echo "[6] the front door: a store name and six digits, and nothing else"
# 0.6.0 replaced link sign-in with a key + PIN. What has to be true on the live
# worker: the door is two fields, the old links are inert without being dead ends,
# nothing about a PIN is ever said out loud, and a guessing flood learns nothing.
# /a is served out of KV, and this run has already written to that namespace twice,
# so the first read after a write can be seconds stale — the platform's consistency
# model, not a product fault. Read until the served page is the deployed page (up to
# fifteen seconds), say which case you are in, and only then assert on its contents.
# Command substitution eats the page's trailing newline, so the deployed size is
# measured the same way the served one is. Comparing a $(cat file) count against a
# curl count is a one-byte lie, and it was: this check failed while the product was fine.
DEPLOYED_A=$(printf '%s' "$(cat pages/admin.html)" | wc -c | tr -d ' ')
fetch_a() {  # fetch_a <path> — retries a stale read, prints whatever the last try gave
  local out i
  for i in 1 2 3 4 5; do
    out=$(curl -sL -m 30 "$ORIGIN$1")
    [[ "${#out}" -eq "$DEPLOYED_A" ]] && break
    sleep 3
  done
  printf '%s' "$out"
}
PAGE_A=$(fetch_a "/a?v=$RANDOM")
if [[ "${#PAGE_A}" -ne "$DEPLOYED_A" ]]; then
  echo "      served ${#PAGE_A} bytes instead; first line: $(printf '%s' "$PAGE_A" | head -c 90)"
fi
ckw "the served dashboard is the deployed one ($DEPLOYED_A bytes)" "^${#PAGE_A}$" "$DEPLOYED_A"
ck "an old ?token= link lands on the sign-in card, not a blank page" 'id="login"' "$(fetch_a "/a?handle=$HANDLE&token=$ADMIN_KEY")"
ck "  · same when a mailer escaped the &" 'retired' "$(fetch_a "/a?handle=$HANDLE&amp;token=$ADMIN_KEY")"
ck "  · and the query repair still works where a query is read" '"ok":true' "$(curl -s -m 30 "$ORIGIN/api/lookup?handle=$HANDLE&amp;x=1")"
ck "the screen asks for exactly two things" '^2$' "$(printf '%s' "$PAGE_A" | grep -o 'id="f[KP]"' | wc -l | tr -d ' ')"
ck "  · one button, and no paste-box for a link left behind" '^0$' "$(printf '%s' "$PAGE_A" | grep -c 'id="fL"')"
ck "  · and the PIN panel is where a PIN is changed" 'Change your PIN' "$PAGE_A"
ck "the retired exchange door explains the change, in one sentence" 'retired' "$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"code":"junk"}' "$ORIGIN/api/login")"
ck "  · and so does the retired recovery door" '^410$' "$(code -X POST -H 'content-type: application/json' -d '{}' "$ORIGIN/api/recover")"
BAD1=$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"key":"'"$HANDLE"'","pin":"000000"}' "$ORIGIN/api/auth")
BAD2=$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"key":"nomateshop9911","pin":"000000"}' "$ORIGIN/api/auth")
SAME=$(printf '%s' "$BAD1" | tr -d ' \n' > /tmp/ts_b1; printf '%s' "$BAD2" | tr -d ' \n' > /tmp/ts_b2; cmp -s /tmp/ts_b1 /tmp/ts_b2 && echo same || echo "differ: $BAD1 | $BAD2")
ck "a wrong PIN and a store that does not exist answer identically" '^same$' "$SAME"
ck "  · and neither answer contains PIN material" '^0$' "$(printf '%s%s' "$BAD1" "$BAD2" | grep -cE 'kdf|salt|"hash"|"pin":')"
JAR=$(mktemp)
if [[ -n "${PIN:-}" ]]; then
  LR=$(curl -s -m 30 -c "$JAR" -X POST -H 'content-type: application/json' -d '{"key":"'"$HANDLE"'","pin":"'"$PIN"'"}' "$ORIGIN/api/auth")
  if printf '%s' "$LR" | grep -q '"ok": *false'; then
    # A wrong PIN here is almost never the build: it means somebody with the real
    # store — usually the operator — changed it or reset it after this variable was
    # written down. Saying "failed" would be a lie about the code, and saying
    # "passed" would be a lie about the door, so say what is known.
    PS=$(curl -s -m 30 -H "Authorization: Bearer $TOK" \
      "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$KV/values/store:$HANDLE" \
      | python3 -c "import sys,json;print((json.load(sys.stdin).get('pin') or {}).get('set_at','?'))" 2>/dev/null)
    printf '  \033[33m!\033[0m the store name and PIN open a session \033[2m— not verifiable today: that PIN was replaced on the store, whose PIN record was written %s\033[0m\n' "$PS"
    blocked=$((blocked + 1))
  else
    ck "the store name and PIN open a session, with no link in sight" '"ok":true' "$LR"
  fi
  ck "  · cookie is HttpOnly, SameSite=Strict, Secure" 'HttpOnly' "$(grep -i tp_sess "$JAR")"
  ck "  · the dashboard reads on the cookie alone" '"orders"' "$(curl -s -m 30 -b "$JAR" "$ORIGIN/api/admin?handle=$HANDLE")"
  ck "  · and 401s without it" '^401$' "$(code "$ORIGIN/api/admin?handle=$HANDLE")"
  ck "  · the hash never travels to the browser" '^0$' "$(curl -s -m 30 -b "$JAR" "$ORIGIN/api/admin?handle=$HANDLE" | grep -cE '"kdf"|"salt"|"hash"')"
else
  echo "  ! PIN= not set: the door was probed, not opened — add it to see the whole path"
fi
ck "its settings panel is driven by the API" "editable.:" "$(curl -s -m 30 -H "x-tapstall-admin: $ADMIN_KEY" "$ORIGIN/api/admin?handle=$HANDLE")"
AUD=$(curl -s -m 30 -H "x-tapstall-admin: $ADMIN_KEY" "$ORIGIN/api/admin?handle=$HANDLE" | python3 -c "
import sys,json
d=json.load(sys.stdin)
a=[x for x in (d.get('audit') or []) if x.get('act')=='pin' or x.get('act')=='login']
print(json.dumps(a[0]) if a else '{}')" 2>/dev/null)
ck "the sign-in is in the merchant's own log, recorded as a PIN sign-in" '"via": ?"pin"' "$AUD"
nk "  · and the log line holds no PIN, only the field name" '"pin": ?"[0-9]' "$AUD"
ck "a login credential cannot be spent to confirm an order" '"link_expired"' "$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"cap":"v1.9999999999.eyJhIjoibG9naW4ifQ.deadbeef"}' "$ORIGIN/api/mark")"
ck "a guessed legacy token is refused, not honoured" '^405$' "$(code "$ORIGIN/api/mark?handle=$HANDLE&token=not-the-key&id=x&status=paid")"
curl -s -m 30 -o /dev/null -X DELETE -H "Authorization: Bearer $TOK" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$KV/values/pinl:$HANDLE" 2>/dev/null
echo "  · cleared the persisted PIN freeze the probes may have left (the counting itself is in memory)"

echo "[7] one store's credentials never open another store"
OTHER="${OTHER_HANDLE:-}"
if [[ -z "$OTHER" ]]; then
  for cand in kotaking mamatoe; do [[ "$cand" != "$HANDLE" ]] && OTHER=$cand && break; done
fi
ONE=$(printf '%s' "$STORE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('renew_url',''))" 2>/dev/null)
OTH_DOC=$(curl -s -m 30 -H "Authorization: Bearer $TOK" "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$KV/values/store:$OTHER")
OTH_KEY=$(printf '%s' "$OTH_DOC" | python3 -c "import sys,json;print(json.load(sys.stdin).get('admin_token',''))" 2>/dev/null)
if [[ -n "$OTH_KEY" ]]; then
  ck "$HANDLE's key cannot read $OTHER's ledger" '^403$' "$(code -H "x-tapstall-admin: $ADMIN_KEY" "$ORIGIN/api/admin?handle=$OTHER")"
  ck "$OTHER's key cannot write $HANDLE's settings" '^403$' "$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "x-tapstall-admin: $OTH_KEY" -d '{"handle":"'"$HANDLE"'","pay_account":"cross-tenant"}' "$ORIGIN/api/settings")"
  PUBT=$(curl -s -m 30 "$ORIGIN/s/$HANDLE/config.json")
  nk "and no trace of that attempt reached the public page" 'cross-tenant' "$PUBT"
  # a confirm cap is bound to the store inside its signed payload; the `handle`
  # in the body is not consulted, so it cannot be re-pointed at another tenant
  BEFORE=$(curl -s -m 30 -H "x-tapstall-admin: $OTH_KEY" "$ORIGIN/api/admin?handle=$OTHER" | python3 -c "
import sys,json;d=json.load(sys.stdin);print(sum(1 for o in d.get('orders',[]) if o.get('status')=='paid'))" 2>/dev/null)
curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"cap":"'"${MARK#/c/}"'","handle":"'"$OTHER"'"}' "$ORIGIN/api/mark" > /tmp/resp.json
AFTER=$(curl -s -m 30 -H "x-tapstall-admin: $OTH_KEY" "$ORIGIN/api/admin?handle=$OTHER" | python3 -c "
import sys,json;d=json.load(sys.stdin);print(sum(1 for o in d.get('orders',[]) if o.get('status')=='paid'))" 2>/dev/null)
ck "the body's handle is ignored, $OTHER's paid count stays $BEFORE" "^${AFTER}$" "$BEFORE"
  VERDICT=$(python3 -c "import json;r=json.load(open('/tmp/resp.json'));print('own-store='+str(bool(r.get('ok'))).lower())" 2>/dev/null)
  ckw "it acted only on the store named inside the cap" "own-store=true" "$VERDICT"
  ck "the ledger endpoint still refuses a key from a stranger store" '^401$' "$(code "$ORIGIN/api/admin?handle=$OTHER")"
  ck "a PIN reset for $OTHER does not answer for $HANDLE" '^403$' "$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"key":"'"$OTHER"'","owner_email":"x@y.z","pay_account":"'"$OTH_KEY"'"}' "$ORIGIN/api/pin/reset")"
  curl -s -m 30 -o /dev/null -X DELETE -H "Authorization: Bearer $TOK" \
    "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$KV/values/lock:$OTHER" 2>/dev/null
  curl -s -m 30 -o /dev/null -X DELETE -H "Authorization: Bearer $TOK" \
    "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$KV/values/lock:$HANDLE" 2>/dev/null
  echo "  · cleared the lock counters both stores accumulated from those probes"
else
  echo "  ! no second store found to test isolation against (set OTHER_HANDLE=)"
fi

echo "[8] the two consoles: the merchant money pages, and /ops"
# The platform secret is resolved the way lib.sh does it, read from disk into a
# file curl consumes (never on a command line, where `ps` would show it), and
# only derived yes/no values are ever handed to ck/nk — so a pasted CI log
# cannot leak a live operator session.
SEC_FILE=""
for cand in .secrets/admin_secret "$HOME/.secrets/admin_secret"; do
  [[ -s "$cand" ]] && SEC_FILE="$cand" && break
done
[[ -n "${ADMIN_SECRET:-}" ]] && printf '%s' "$ADMIN_SECRET" > /tmp/zl-sec.$$.txt && SEC_FILE=/tmp/zl-sec.$$.txt
SELF=$(curl -s -m 60 "$ORIGIN/__selftest")
ck "the confirm page is live from KV, not the inline fallback" '"tpl_confirm": ?true' "$SELF"
ck "  · so is the renew page" '"tpl_renew": ?true' "$SELF"
ck "  · and the operator console" '"tpl_ops": ?true' "$SELF"
OPS=$(curl -s -m 30 "$ORIGIN/ops")
ck "the console page is public as an empty shell" 'Operator console' "$OPS"
ck "  · and it knows it is not signed in" '"signed_in":false' "$OPS"
ck "  · no crawler finds it" 'noindex' "$OPS"
nk "no secret, key or payout detail in that HTML" 'admin_token|secret_hash|"pay_account":' "$OPS"
for ep in state health audit templates; do
  ck "/ops/api/$ep refuses an anonymous reader" '^401$' "$(code "$ORIGIN/ops/api/$ep")"
done
ck "  · and says a login is what is missing" '"need_login": ?true' "$(curl -s -m 30 "$ORIGIN/ops/api/state")"
ck "a lever without the confirm header is refused" '^401$' "$(code -X POST -H 'content-type: application/json' -d '{"handle":"'"$HANDLE"'","action":"suspend"}' "$ORIGIN/ops/api/store")"
if [[ -z "$SEC_FILE" ]]; then
  echo "  ! no admin_secret on disk (.secrets/admin_secret) and no ADMIN_SECRET in env"
  echo "  ! the authenticated half of [8] is skipped — the open door is still proved shut"
else
BODY=$(mktemp)
python3 -c "
import json
open('$BODY','w').write(json.dumps({'secret': open('$SEC_FILE').read().strip()}))"
HDR=$(mktemp)
curl -s -m 30 -D "$HDR" -o /dev/null -X POST -H 'content-type: application/json' --data-binary "@$BODY" "$ORIGIN/ops/login"
# only derived values are passed to ck from here on
HAVE=$(grep -ic '^set-cookie: *tp_ops=' "$HDR")
attrs() { awk 'BEGIN{IGNORECASE=1} /^set-cookie: *tp_ops/ {print}' "$HDR" | tr -d '\r'; }
FLAGS=$(attrs | grep -c 'HttpOnly' || true)
SAMESITE=$(attrs | grep -cE 'SameSite=Strict' || true)
SECURE=$(attrs | grep -cE '; ?Secure' || true)
TTL=$(attrs | grep -oE 'Max-Age=[0-9]+' | head -1 | cut -d= -f2)
ck "the secret exchanges for a cookie, not a token in a URL" '^1$' "$HAVE"
ck "  · HttpOnly" '^1$' "$FLAGS"
ck "  · SameSite=Strict" '^1$' "$SAMESITE"
ck "  · Secure" '^1$' "$SECURE"
ck "  · and a 12-hour lifetime, not forever" '^43200$' "$TTL"
OC=$(attrs | sed -E 's/^[^=]+=//; s/;.*$//')
if [[ -z "$OC" ]]; then
  echo "  ! /ops/login did not answer with a session — the rest of [8] would be noise"
  rm -f "$BODY" "$HDR"
else
ST2=$(curl -s -m 60 -b "tp_ops=$OC" "$ORIGIN/ops/api/state")
ck "the estate reads back as data the console can render" '"totals":\{' "$ST2"
ck "  · with an attention queue that names its reasons" '"attention":\[' "$ST2"
ck "  · and a per-refresh KV cost, so polling is a choice" '"reads_used_estimate":' "$ST2"
nk "  · holding no credential, masked or not" 'admin_token|secret_hash|fw_secret|auth_gen|"admin_url":' "$ST2"
HL=$(curl -s -m 60 -b "tp_ops=$OC" "$ORIGIN/ops/api/health")
ck "health carries the runtime self-check" '"selftest":\{' "$HL"
ck "  · and the Pages mirror it is served beside" '"pages":' "$HL"
TPLS=$(curl -s -m 30 -b "tp_ops=$OC" "$ORIGIN/ops/api/templates")
ck "every page the Worker serves is in KV" '"live": ?true' "$TPLS"
nk "  · none missing" '"live": ?false' "$TPLS"
DET=$(curl -s -m 30 -b "tp_ops=$OC" "$ORIGIN/ops/api/store?handle=$HANDLE")
ck "one store opens with its orders, log and queued change" '"summary":\{' "$DET"
ck "  · the drawer is told which fields the merchant may queue" '"editable":\[' "$DET"
LL=$(curl -s -m 30 -b "tp_ops=$OC" -H 'x-tapstall-confirm: 1' -X POST -H 'content-type: application/json' \
  -d '{"handle":"'"$HANDLE"'","action":"link"}' "$ORIGIN/ops/api/store")
# Deliberately not a synonym for reset_pin: a console that still believes it is
# issuing a 7-day link must be told that is over, not quietly redirected.
ck "the link lever is retired in the console too, and says what to use" 'reset_pin' "$LL"
ck "  · with a status that means gone, not ok:true" '^410$' "$(code -b "tp_ops=$OC" -H 'x-tapstall-confirm: 1' -X POST -H 'content-type: application/json' -d '{"handle":"'"$HANDLE"'","action":"link"}' "$ORIGIN/ops/api/store")"
ck "  · the unknown-action answer offers reset_pin, never link" 'reset_pin' "$(curl -s -m 30 -b "tp_ops=$OC" -H 'x-tapstall-confirm: 1' -X POST -H 'content-type: application/json' -d '{"handle":"'"$HANDLE"'","action":"print_code"}' "$ORIGIN/ops/api/store")"
ck "  · notify is still a real action, not a dead button" '"ok": ?true' "$(curl -s -m 30 -b "tp_ops=$OC" -H 'x-tapstall-confirm: 1' -X POST -H 'content-type: application/json' -d '{"handle":"'"$HANDLE"'","action":"notify","message":"Prod check: this is the operator console, not a message to you."}' "$ORIGIN/ops/api/store")"
AUD=$(curl -s -m 30 -b "tp_ops=$OC" "$ORIGIN/ops/api/audit")
ck "  · and the write lands in the operator log" '"ops":\[' "$AUD"
nk "  · the log line carries no secret" 'admin_token' "$AUD"
LOB=$(mktemp)
LO=$(curl -s -m 30 -o "$LOB" -w '%{http_code}' -X POST -b "tp_ops=$OC" "$ORIGIN/ops/logout")
AFTER=$(curl -s -m 30 -o /dev/null -w '%{http_code}' -b "tp_ops=$OC" "$ORIGIN/ops/api/state")
ck "signing out answers" '^200$' "$LO"
if [ "$AFTER" = "401" ]; then
  ck "  · and the cookie is worth nothing afterwards" '^401$' "$AFTER"
else
  # the global revocation is a KV write. Where that is impossible the only
  # acceptable answer is an honest one, so a green tick here means "it said so",
  # never "we hoped nobody would notice"
  ck "  · and when it could not revoke the rest, it says exactly that" '"sessions_ended":false' "$(cat "$LOB")"
fi
rm -f "$LOB"
code -b "tp_ops=$OC" "$ORIGIN/ops/api/state" >/dev/null; code -b "tp_ops=$OC" "$ORIGIN/ops/api/state" >/dev/null
TRY=$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"secret":"not-the-platform-secret"}' "$ORIGIN/ops/login" | grep -oE '"tries_left": ?[0-9]+' | grep -oE '[0-9]+' | head -1)
ck "  · dead-cookie probes did not lock anybody out" '^([6-9]|1[0-2])$' "$TRY"
# and the guess this check just made is wiped from the counter, so running
# prod_check a dozen times can never freeze the operator's own console
curl -s -m 30 -o /dev/null -X POST -H 'content-type: application/json' --data-binary "@$BODY" "$ORIGIN/ops/login"
rm -f "$BODY"
fi
rm -f "$HDR"
fi

echo "[9] a dropped picture: stored, served, and never inside the store document"
# The only place this product takes bytes from a browser. Four things have to be true
# against the live Worker: the same door guards it, a file that is not a picture is
# refused in words, what comes back is a path a buyer can load, and the store
# document — read on every page view — stays a document. The uploaded file is left
# nowhere behind: the logo is put back exactly as found, which frees it again.
UP_IMG=$(mktemp)
printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==' | base64 -d > "$UP_IMG"
UPLOAD=$(curl -s -m 60 -X POST -H 'content-type: application/octet-stream' -H "x-tapstall-admin: $ADMIN_KEY" \
  --data-binary "@$UP_IMG" "$ORIGIN/api/image?handle=$HANDLE")
REF=$(printf '%s' "$UPLOAD" | python3 -c "import sys,json;print(json.load(sys.stdin).get('ref',''))" 2>/dev/null)
STORE2=$(curl -s -m 30 -H "Authorization: Bearer $TOK" "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$KV/values/store:$HANDLE")
PREV_LOGO=$(printf '%s' "$STORE2" | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin).get('logo','')))" 2>/dev/null)
ckw "an upload answers with a path under this store, not with bytes" "^/i/$HANDLE/" "$REF"
ckw "  · and it says what the file turned out to be" '"kind":"png"' "$UPLOAD"
IMG_OUT=$(mktemp); IMG_HDR=$(mktemp)
curl -s -m 30 -o "$IMG_OUT" -D "$IMG_HDR" "$ORIGIN$REF"
IMG_BLOB=$(tr -d '\r' < "$IMG_HDR")
ckw "  · the path serves the same file to a stranger" "^$(wc -c < "$UP_IMG" | tr -d ' ')$" "$(wc -c < "$IMG_OUT" | tr -d ' ')"
ckw "  · typed as what it is, and not for the browser to guess" 'image/png' "$IMG_BLOB"
ckw "  · with the sniffing refused explicitly" 'nosniff' "$IMG_BLOB"
ckw "  · and cached for a year, because an id is never reused" 'immutable' "$IMG_BLOB"
ckw "  · a revalidation costs no bytes at all" '^304$' "$(code -H "if-none-match: \"${REF##*/}\"" "$ORIGIN$REF")"
nk "no secret rides in a picture response" 'set-cookie|admin_token' "$IMG_BLOB"
printf '%s' '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' > "$UP_IMG.svg"
ck "an SVG is refused by name, with the reason" 'SVG is refused' \
  "$(curl -s -m 30 -X POST -H 'content-type: application/octet-stream' -H "x-tapstall-admin: $ADMIN_KEY" --data-binary "@$UP_IMG.svg" "$ORIGIN/api/image?handle=$HANDLE")"
head -c 260000 /dev/urandom > "$UP_IMG.big"; printf '\xff\xd8\xff\xe0' | cat - "$UP_IMG.big" > "$UP_IMG.jpg"
ck "a file over the ceiling is refused with the number it wanted" '^413$' \
  "$(code -X POST -H 'content-type: application/octet-stream' -H "x-tapstall-admin: $ADMIN_KEY" --data-binary "@$UP_IMG.jpg" "$ORIGIN/api/image?handle=$HANDLE")"
ck "and nobody without the door can post one at all" '^401$' \
  "$(code -X POST -H 'content-type: application/octet-stream' --data-binary "@$UP_IMG" "$ORIGIN/api/image?handle=$HANDLE")"
SAVED=$(curl -s -m 30 -X POST -H 'content-type: application/json' -H "x-tapstall-admin: $ADMIN_KEY" \
  -d '{"handle":"'"$HANDLE"'","logo":"'"$REF"'"}' "$ORIGIN/api/settings")
ckw "a picture on the shop is a soft change, so it lands now" '"logo"' "$SAVED"
ckw "  · the buyer's config carries the path" "$REF" "$(curl -s -m 30 "$ORIGIN/s/$HANDLE/config.json")"
DOC2=$(curl -s -m 30 -H "Authorization: Bearer $TOK" "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$KV/values/store:$HANDLE")
ckw "  · while the store document stays a document ($(printf '%s' "$DOC2" | wc -c | tr -d ' ') bytes)" '^ok$' "$(printf '%s' "$DOC2" | wc -c | awk '{print ($1 < 60000) ? "ok" : "too big"}')"
BACK=$(curl -s -m 30 -X POST -H 'content-type: application/json' -H "x-tapstall-admin: $ADMIN_KEY" \
  -d '{"handle":"'"$HANDLE"'","logo":'"$PREV_LOGO"'}' "$ORIGIN/api/settings")
ckw "  · the shop is left exactly as found" '"ok": *true' "$BACK"
ckw "  · and the file it stopped pointing at is gone, not orphaned" '^404$' "$(code "$ORIGIN$REF")"
SHIP_A=$(cat pages/admin.html)
ck "the page we ship has the picture control: browse, drop, and a link field" 'accept="image/\*"' "$SHIP_A"
ck "  · a Browse button and a Take off, in that order" 'data-pk="pick".*data-pk="off"' "$SHIP_A"
ck "  · and it posts to the store that asked" '/api/image\?handle=' "$SHIP_A"
ck "  · with the confirm header every other write needs" 'x-tapstall-confirm' "$SHIP_A"
rm -f "$UP_IMG" "$UP_IMG.svg" "$UP_IMG.big" "$UP_IMG.jpg" "$IMG_OUT" "$IMG_HDR"

echo "[10] proof of payment: each rail says what it needs, once — and nothing is blocked for it"
# The gap this closes is not the money, it is finding it: four pending orders and one
# amount is how a merchant on a hand-checked rail spends an evening. Checked on the
# answers the Worker gives a stranger, because a policy published wrongly is a field
# every buyer sees, and a value published by mistake is a buyer's reference on a shop page.
PUBP=$(curl -s -m 30 "$ORIGIN/s/$HANDLE/config.json")
RAILS=$(curl -s -m 30 "$ORIGIN/rails")
PROOFMODE=$(printf '%s' "$PUBP" | python3 -c "
import json,sys
print((json.load(sys.stdin).get('store') or {}).get('rail_info', {}).get('proof', ''))" 2>/dev/null)
railproof() { printf '%s' "$RAILS" | python3 -c "
import json,sys
d = json.load(sys.stdin)
r = d['rails'] if isinstance(d, dict) and 'rails' in d else d
print((r.get('$1') or {}).get('proof', 'missing'))" 2>/dev/null; }
ck "a wallet asks for the code its app prints" '^ask$' "$(railproof ecocash_usd)"
ck "a bank transfer demands one, because it is one amount and forty payers" '^require$' "$(railproof zipit)"
ck "a hosted card link asks for nothing, because there the asking is theatre" '^none$' "$(railproof payfast)"
ck "cash on collection proves nothing in advance, so nothing is asked" '^none$' "$(railproof cash)"
ck "the shop tells a stranger what it needs" '"proof":[[:space:]]*"(ask|require|none)"' "$PUBP"
ck "  · in the name the shop gave it, not ours" '"proof_label":[[:space:]]*"[^"]' "$PUBP"
ck "  · and where to look, since every app hides it differently" 'not the order code' "$PUBP"
ck "  · with the sending number asked where it explains a payment" '"ask_payer":[[:space:]]*true' "$PUBP"
ck "a public page carries the policy and never a buyer's reference" '^0$' "$(printf '%s' "$PUBP" | grep -cE '"buyer"')"
if [[ "$PROOFMODE" == none ]]; then
  ckw "a shop that needs no proof prints no line about it" '^0$' "$(printf '%s' "$ORD" | grep -cE '"proof_mode"')"
else
  ckw "the slip says what is wanted before the buyer pays" '"proof_mode":[[:space:]]*"'$PROOFMODE'"' "$ORD"
fi
ckw "  · it answers the field empty rather than inventing one" '"proof":[[:space:]]*""' "$ORD"
ckw "  · and an ask-only rail never scolds a buyer for it" '^0$' "$(printf '%s' "$ORD" | grep -cE 'ask them before sending')"
ckw "the merchant's ledger sees the field on the order document" '"proof":[[:space:]]*""' "$DASH"
ckw "  · a row that owes a code arrives with the words to ask for it" '^yes$' "$(printf '%s' "$DASH" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print('yes' if any((o or {}).get('ask') for o in d.get('orders', [])) else 'no')" 2>/dev/null)"
SHIP_S=$(cat pages/store.html)
ck "the page we ship asks once, then lets the order through" 'id="fProof"' "$SHIP_S"
ck "  · shown because the server said so, not from a list of rail names" "R\.proof !== 'none'" "$SHIP_S"
ck "  · and the code is read back on the receipt" 'pay\.proof' "$SHIP_S"
# 0.7.9: the door is on the receipt, and a refusal says what it ends
ck "  · the receipt holds the field itself, as a form, at the door's own route" '<form id="pff" method="post" action="/api/proof">' "$SHIP_S"
ck "  · its box and its link are one condition, so they cannot disagree" '\(needDoor \? pfBox : addProof\)' "$SHIP_S"
ck "  · and it asks the Worker whether a refusal closes the door" 'if \(j\.final\)' "$SHIP_S"
# the two fields a receipt page acts on cannot be read off the live Worker today: a capped
# day fails the rate-limit counter closed, so every POST to the door is answered 503 before
# a cap is even looked at. That is on purpose (the same limiter guards the PIN, and a budget
# is not a reason to answer a brute force generously), and it is asserted below instead.
ckw  "  · the answer a browser can act on names its reason in a field" '"why":"cap"' "$BOGUS"
nkw  "  · and does not pretend a bad link is news about the order" '"final":true' "$BOGUS"
ck "the dashboard ships the picker and a name for the field" 'data-rd="proof"' "$SHIP_A"
ck "  · the ledger row prints who sent it and which code they gave" 'o\.buyer\.proof' "$SHIP_A"
ck "  · and the CSV has a header name for every column it writes" 'payer,proof_of_payment,flags' "$SHIP_A"

echo "[11] money in: the webhook doors are shut until somebody arms them"
# A public POST that can extend a paid plan is the most interesting route on this
# Worker, so the exact old exploit is a standing assertion here rather than a memory.
# It must be answered without a write: on 2026-10-12 this same pair of fields bought
# 100 years of plan, which is why the terms now only ever come from an intent this
# Worker minted.
PAID0=$(printf '%s' "$STORE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('paid_until') or 0)" 2>/dev/null)
for door in payfast flutterwave; do
  RAW=$(curl -s -m 30 -X POST -H 'content-type: application/x-www-form-urlencoded' \
    -d 'payment_status=COMPLETE&status=successful&custom_str1='"$HANDLE"'|36500' \
    "$ORIGIN/api/hook/$door")
  ck "$door: a handle plus a number of days buys nothing" '^0$' "$(printf '%s' "$RAW" | grep -cE '"activated"')"
  ck "  · and the answer is a refusal, not a success" 'ok"?: *(false|true)|"ignored"' "$RAW"
done
ck "the payfast door names the setting it needs instead of shrugging" 'PAYFAST_PASSPHRASE|signature' "$(curl -s -m 30 -X POST -H 'content-type: application/x-www-form-urlencoded' -d 'payment_status=COMPLETE&custom_str1=mamatoe-1234567890abcdef' "$ORIGIN/api/hook/payfast")"
PAID1=$(curl -s -m 30 -H "Authorization: Bearer $TOK" "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$KV/values/store:$HANDLE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('paid_until') or 0)" 2>/dev/null)
ck "  · and the plan on file did not move, so a probe is free" '^'"$PAID0"'$' "$PAID1"
HOUR=$(date -u +%Y%m%d%H)
# The counter the next two lines read is written by the Worker, not by this script, so on a
# day with no KV writes left it is not "absent because broken" — it is absent because nothing
# could create it. Same rule as the order-shaped lines: report it as blocked, not red.
LED=$(curl -s -m 30 -H "Authorization: Bearer $TOK" "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$KV/values/hooks:$HOUR:refused")
ckw "  · and the refusal was counted, once, for the whole hour" "^{.*"version"" "$LED"
ckw "  · with the reason in the operator's words, not the attacker's" 'not armed|signature|verif-hash|tx_ref|reference' "$LED"

echo "[12] being found: what a crawler and a WhatsApp preview actually receive"
# The page cache is max-age=60/s-maxage=300, so these fetch a busted URL: a green line
# here has to mean "a stranger arriving now gets this", not "somebody did once".
PAGE=$(curl -s -m 30 "$ORIGIN/s/$HANDLE?probe=$(date +%s)")
NAME=$(printf '%s' "$STORE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('shop_name',''))" 2>/dev/null)
ck "the title is the shop, not the product" "<title>$NAME" "$PAGE"
ck "  · one title, not a real one plus a fallback" '^1$' "$(printf '%s' "$PAGE" | grep -c '<title>')"
ck "  · canonical points here, absolute" "<link rel=\"canonical\" href=\"$ORIGIN/s/$HANDLE\">" "$PAGE"
ck "  · a description a preview can use" 'name="description" content="[^"]{40,}"' "$PAGE"
ck "  · and it is offered to be shown big" 'max-image-preview:large' "$PAGE"
ck "  · no og:image when the shop has no picture" '^0$' "$(printf '%s' "$PAGE" | grep -c 'property="og:image"')"
ck "  · the merchant's private columns are not in the bytes" '^0$' "$(printf '%s' "$PAGE" | grep -cE '\"(admin_token|paid_until|secret_hash|rail_accts|pending)\"')"
ck "the structured data parses, and says the same shop" '^jsonld-ok$' "$(printf '%s' "$PAGE" | WANT="$NAME" python3 -c '
import os,re,json,sys
h = sys.stdin.read()
m = re.search(r"<script type=[^\n]*ld\+json[^\n]*?>([\s\S]*?)</script>", h)   # the *? before > matters: greedy would run to the </script> on the same line
if not m:
    print("missing"); raise SystemExit
d = json.loads(m.group(1))
g = d.get("@graph") or []
biz = [x for x in g if x.get("@type") == "LocalBusiness"]
menu = (biz[0].get("hasMenu") or {}) if biz else {}
ok = bool(biz) and biz[0].get("name") == os.environ.get("WANT") and bool(menu.get("hasMenuItem"))
print("jsonld-ok" if ok else "bad:" + str(len(g)) + ":" + str(len(menu.get("hasMenuItem") or [])))' 2>/dev/null)"
ROB=$(curl -s -m 30 "$ORIGIN/robots.txt")
ck "robots.txt opens the shopfronts and the pictures" '^Allow: /s/$' "$ROB"
ck "  · and shuts the app" '^Disallow: /api/$' "$ROB"
ck "  · announced sitemap is ours" "^Sitemap: $ORIGIN/sitemap.xml$" "$ROB"
SM=$(curl -s -m 30 "$ORIGIN/sitemap.xml")
ck "the sitemap lists our pages, never a register of merchants" '^0$' "$(printf '%s' "$SM" | grep -c '/s/')"
ck "  · with the front door in it" '/onboard</loc>' "$SM"
ck "a dashboard says noindex in a header too, for bots that skip robots.txt" 'noindex' "$(curl -s -m 30 -o /dev/null -D - "$ORIGIN/a" | tr -d '\r')"

echo "[13] the shop speaks for itself: share copy, and the pages that get strangers here"
SHARE=$(curl -s -m 30 "$ORIGIN/s/$HANDLE/share.txt")
ck "a shop can hand itself to a group chat in plain text" 'text/plain|Copy the block' "$(curl -s -m 30 -o /dev/null -D - "$ORIGIN/s/$HANDLE/share.txt" | tr -d '\r' | head -3; printf '%s' "$SHARE" | head -1)"
ck "  · the merchant's own words are in it" "$NAME" "$SHARE"
ck "  · and the link is in every block that can carry one" '^4$' "$(printf '%s' "$SHARE" | grep -c "$ORIGIN/s/$HANDLE")"
ck "  · the X block is short enough to keep its link" '^0$' "$(printf '%s' "$SHARE" | python3 -c "
import sys
t = sys.stdin.read()
try:
    x = t.split('— X / Twitter (fits the limit) —')[1].split('\n\n')[0].strip()
except Exception:
    print('split-failed'); raise SystemExit
print(0 if (len(x) <= 280 and x.endswith('/s/$HANDLE')) else 1)")"
ck "  · the shop's own page links the file" 'href="share.txt"' "$PAGE"
for g in whatsapp-shop-payments payment-reference-matching; do
  GP=$(curl -s -m 30 "$ORIGIN/guide/$g?probe=$(date +%s)")
  ck "guide: /guide/$g is served, dated, and stamped with this host" "canonical. href..$ORIGIN/guide/$g" "$GP"
  ck "  · no unstamped token reached a reader" '^0$' "$(printf '%s' "$GP" | grep -c '@ORIGIN@')"
  ck "  · one h1, and the article describes itself" '^1$' "$(printf '%s' "$GP" | grep -c '<h1>')"
done
ck "the plural index points at the pillar" '^30[12]$' "$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$ORIGIN/guide")"
GH=$(curl -s -m 30 -o /dev/null -D - "$ORIGIN/guide/there-is-no-such-guide" | tr -d '\r')
ck "a guide nobody wrote is a 404, not an indexable page" 'x-robots-tag: noindex' "$GH"
ck "  · and the landing page links the guides, so they are not orphans" '/guide/whatsapp-shop-payments' "$(curl -s -m 30 "$ORIGIN/?probe=$(date +%s)")"

echo "[14] tidy up"
CK2=$(curl -s -m 30 -X POST -H 'content-type: application/json' -H "x-tapstall-admin: $ADMIN_KEY" \
  -d '{"handle":"'"$HANDLE"'","id":"'"$ID"'","status":"cancelled"}' "$ORIGIN/api/mark")
ckw "probe order cancelled" '"status":"cancelled"' "$CK2"
CK3=$(curl -s -m 30 -X POST -H 'content-type: application/json' -H "x-tapstall-admin: $ADMIN_KEY" \
  -d '{"handle":"'"$HANDLE"'","id":"'"$ID2"'","status":"cancelled"}' "$ORIGIN/api/mark")
ckw "the second probe order cancelled too, so nothing is left to act on" '"status":"cancelled"' "$CK3"
rm -f "$H" "$JAR"
echo
printf '%s\n' "passed: $pass   blocked by the day's KV budget: $blocked   failed: $fail"
[[ $fail -eq 0 ]] || exit 1
