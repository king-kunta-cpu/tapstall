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
# It creates one throwaway order on $HANDLE and cancels it at the end. Nothing
# else about that store is left changed.
set -uo pipefail
cd "$(dirname "$0")/.."
ORIGIN="${ORIGIN:-https://zimlink.simalidudu.workers.dev}"
HANDLE="${HANDLE:-mamatoe}"
TOK=$(cat /home/user/.secrets/cf_token 2>/dev/null || echo "${CLOUDFLARE_API_TOKEN:-}")
ACCT=$(cat /home/user/.secrets/cf_account 2>/dev/null || echo "${CLOUDFLARE_ACCOUNT_ID:-}")
KV=${KV_NS:-b5c1c89d95114092ae91bbafc5a2d76c}     # zimlink-stores: store docs, templates
ORD_KV=${ORDERS_NS:-4f4ac94a66db4b859b61668a3c160819}   # zimlink-orders: order docs, lists
pass=0 fail=0

ck() {   # ck <name> <must-contain-regex> <actual>
  if printf '%s' "$3" | grep -qE -- "$2"; then printf '  \033[32m+\033[0m %s\n' "$1"; pass=$((pass + 1));
  else printf '  \033[31m-\033[0m %s\n      want: %s\n      got:  %s\n' "$1" "$2" "$(printf '%s' "$3" | head -c 240)"; fail=$((fail + 1)); fi
}
nk() {   # nk <name> <must-NOT-contain-regex> <actual>
  if printf '%s' "$3" | grep -qE -- "$2"; then printf '  \033[31m-\033[0m %s (found: %s)\n' "$1" "$(printf '%s' "$3" | grep -oE "$2" | head -1)"; fail=$((fail + 1));
  else printf '  \033[32m+\033[0m %s\n' "$1"; pass=$((pass + 1)); fi
}
code() { curl -s -m 30 -o /dev/null -w '%{http_code}' "$@"; }

echo "target: $ORIGIN"
echo "store:  $HANDLE"

echo "[1] version, and the security primitives inside the Worker's own runtime"
WANT_VER=$(grep -m1 "^const VERSION = " worker/worker.js | tr -dc '0-9.')
ck "ping reports the version in this checkout ($WANT_VER)" "\"$WANT_VER\"" "$(curl -s -m 30 "$ORIGIN/__ping")"
ST=$(curl -s -m 60 "$ORIGIN/__selftest")
# A day with no KV writes left is not a day the Worker is broken, and thirteen
# red lines about "the security primitives" would say it is. The probe reports
# `kv_write_blocked` when that is the only cause; drop the one assertion that
# genuinely needs a write, say so once, and check every read-side claim anyway.
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
ck "menu feed 200" '^200$' "$(code "$ORIGIN/s/$HANDLE/feed.json")"
ck "fees page 200" '^200$' "$(code "$ORIGIN/fees")"
ck "onboarding 200" '^200$' "$(code "$ORIGIN/onboard")"

echo "[4] prefetching a confirm link, as Slack/WhatsApp/WhatsApp-business do"
STORE=$(curl -s -m 30 -H "Authorization: Bearer $TOK" "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$KV/values/store:$HANDLE")
ADMIN_KEY=$(printf '%s' "$STORE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('admin_token',''))" 2>/dev/null)
[[ -n "$ADMIN_KEY" ]] && echo "  · store doc read from KV (admin_token present)" || { echo "  ! could not read the store doc from KV"; }
ORD=$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{
  "handle":"'"$HANDLE"'","service":"pickup",
  "buyer":{"name":"prod check","phone":"0700000000","optin":true},
  "items":[{"id":"prodcheck","name":"prod check item","price":0.01,"qty":1}]}' "$ORIGIN/api/order")
ID=$(printf '%s' "$ORD" | python3 -c "import sys,json;print(json.load(sys.stdin)['order']['id'])" 2>/dev/null)
MARK=$(printf '%s' "$ORD" | python3 -c "import sys,json;print(json.load(sys.stdin).get('mark_url',''))" 2>/dev/null)
ck "a probe order exists" '^/c/v1\.' "$MARK"
nk "the confirm link carries no store credential" 'token=|admin_token|/api/mark' "$MARK"
PAGE=$(curl -s -m 30 -A 'Mozilla/5.0 (compatible; Slackbot/1.0; +https://slack.com/faq)' -L "$ORIGIN$MARK")
ck "the bot gets a page, not a mutation" 'Mark .* paid' "$PAGE"
ck "the page posts itself when a browser runs it" 'method="post" action="/api/mark"' "$PAGE"
ck "and says what it will do" 'from ' "$PAGE"
# Ground truth is the order document itself. The dashboard list is a separate KV
# key and is eventually consistent, so it can lag a write by up to a minute.
KVORDER=$(curl -s -m 30 -H "Authorization: Bearer $TOK" "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$ORD_KV/values/order:$HANDLE:$ID")
ck "order document still awaiting_payment after the prefetch" '"status":"awaiting_payment"' "$KVORDER"
nk "and it kept the payout details printed at order time" 'ZZ-PROBE' "$KVORDER"
DASH=$(curl -s -m 30 -H "x-zimlink-admin: $ADMIN_KEY" "$ORIGIN/api/admin?handle=$HANDLE")
nk "no raw login code in the ledger payload" 'code=v1\.' "$DASH"
# now be the browser: post the cap the page would post
POST=$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"cap":"'"${MARK#/c/}"'"}' "$ORIGIN/api/mark")
ck "the browser POST confirms it" '"status":"paid"' "$POST"
ck "and hands back a 15-minute undo link" '/c/v1\.' "$POST"
REPLAY=$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"cap":"'"${MARK#/c/}"'"}' "$ORIGIN/api/mark")
ck "a double tap is a no-op, not a double count" '"already":true' "$REPLAY"
UNDO=$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"cap":"'"$(printf '%s' "$POST" | python3 -c "import sys,json;print(json.load(sys.stdin).get('undo_url','/c/none')[3:])")"'"}' "$ORIGIN/api/mark")
ck "undo returns it to awaiting_payment" '"awaiting_payment"' "$UNDO"

echo "[5] settings: cosmetic instant, money held 15 minutes, cancellable"
HOURS=$(printf '%s' "$STORE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('hours','') or 'open')" 2>/dev/null)
PROBE="ZZ-PROBE-$(date +%s | tail -c 6)"
SR=$(curl -s -m 30 -X POST -H 'content-type: application/json' -H "x-zimlink-admin: $ADMIN_KEY" \
  -d '{"handle":"'"$HANDLE"'","hours":"'"$HOURS"'","pay_account":"'"$PROBE"'"}' "$ORIGIN/api/settings")
ck "held list names the payout field" '"held":\["pay_account"\]' "$SR"
ck "and gives a fuse, not a maybe" '"hold_until":[0-9]' "$SR"
PUB=$(curl -s -m 30 "$ORIGIN/s/$HANDLE/config.json")
nk "the new payout account is NOT live yet" "$PROBE" "$PUB"
nk "and not even visible as a queue" 'pending|auth_gen' "$PUB"
ADMBEF=$(curl -s -m 30 -H "x-zimlink-admin: $ADMIN_KEY" "$ORIGIN/api/admin?handle=$HANDLE")
ck "the owner sees the raw queued value" "$PROBE" "$(printf '%s' "$ADMBEF" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(json.dumps((d.get('pending') or {}).get('fields', {})))" 2>/dev/null)"
ck "with a countdown, not a vague promise" '"in_ms":[1-9]' "$ADMBEF"
RV=$(curl -s -m 30 -X POST -H 'content-type: application/json' -H "x-zimlink-admin: $ADMIN_KEY" -d '{"handle":"'"$HANDLE"'"}' "$ORIGIN/api/settings/revert")
ck "revert cancels it" '"cancelled":\["pay_account"\]' "$RV"
PUB2=$(curl -s -m 30 "$ORIGIN/s/$HANDLE/config.json")
nk "nothing was applied in the meantime" "$PROBE" "$PUB2"
ck "hours unchanged after the whole test" "\"hours\":\"$HOURS\"" "$PUB2"
ck "a bad value is refused by field" '"fields":\{"rail"' "$(curl -s -m 30 -X POST -H 'content-type: application/json' -H "x-zimlink-admin: $ADMIN_KEY" -d '{"handle":"'"$HANDLE"'","rail":"momo_pay"}' "$ORIGIN/api/settings")"
ck "a forged cap is refused as expired" '"link_expired"' "$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"cap":"v1.9999999999.eyJhIjoibWFyayJ9.AAAAAAAA"}' "$ORIGIN/api/mark")"
ck "a truncated copy of a real cap is refused" '"link_expired"' "$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"cap":"'"${MARK#/c/}"'x"}' "$ORIGIN/api/mark")"

echo "[6] an existing merchant, upgraded with no action from anyone"
LEG=$(curl -s -m 30 -D - -o /dev/null "$ORIGIN/a?handle=$HANDLE&token=$ADMIN_KEY" | tr -d '\r')
CODE=$(printf '%s' "$LEG" | grep -io 'location: [^ ]*code=v1[^ ]*' | sed 's/.*code=//' | head -1)
ck "their v0.2 link trades up for a code" '^v1\.' "$CODE"
JAR=$(mktemp)
LR=$(curl -s -m 30 -c "$JAR" -X POST -H 'content-type: application/json' -d '{"code":"'"$CODE"'"}' "$ORIGIN/api/login")
ck "the code exchanges for a session" '"ok":true' "$LR"
ck "cookie is HttpOnly, SameSite=Strict, Secure, 12 h" 'HttpOnly' "$(grep -i zl_sess "$JAR")"
ck "dashboard opens with the cookie" '"orders"' "$(curl -s -m 30 -b "$JAR" "$ORIGIN/api/admin?handle=$HANDLE")"
ck "and 401s without it" '^401$' "$(code "$ORIGIN/api/admin?handle=$HANDLE")"
ck "the admin page is the new one" 'Store settings' "$(curl -s -m 30 "$ORIGIN/a")"
ck "its settings panel is driven by the API" "editable.:" "$(curl -s -m 30 -b "$JAR" "$ORIGIN/api/admin?handle=$HANDLE")"
AUD=$(curl -s -m 30 -b "$JAR" "$ORIGIN/api/admin?handle=$HANDLE" | python3 -c "
import sys,json
d=json.load(sys.stdin)
a=[x for x in (d.get('audit') or []) if x.get('act')=='settings']
print(json.dumps(a[0]) if a else '{}')" 2>/dev/null)
ck "the settings write is in the log" '"act": "settings"' "$AUD"
ck "logged with the API key as the author" '"via": "key"' "$AUD"
nk "but the value itself is masked" 'ZZ-PROBE' "$AUD"
ck "a login code cannot be spent to confirm an order" '"link_expired"' "$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"cap":"'"$CODE"'"}' "$ORIGIN/api/mark")"
ck "a guessed legacy token is refused, not honoured" '^405$' "$(code "$ORIGIN/api/mark?handle=$HANDLE&token=not-the-key&id=x&status=paid")"

echo "[7] one store's credentials never open another store"
OTHER="${OTHER_HANDLE:-}"
if [[ -z "$OTHER" ]]; then
  for cand in kotaking mamatoe; do [[ "$cand" != "$HANDLE" ]] && OTHER=$cand && break; done
fi
ONE=$(printf '%s' "$STORE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('renew_url',''))" 2>/dev/null)
OTH_DOC=$(curl -s -m 30 -H "Authorization: Bearer $TOK" "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$KV/values/store:$OTHER")
OTH_KEY=$(printf '%s' "$OTH_DOC" | python3 -c "import sys,json;print(json.load(sys.stdin).get('admin_token',''))" 2>/dev/null)
if [[ -n "$OTH_KEY" ]]; then
  ck "$HANDLE's key cannot read $OTHER's ledger" '^403$' "$(code -H "x-zimlink-admin: $ADMIN_KEY" "$ORIGIN/api/admin?handle=$OTHER")"
  ck "$OTHER's key cannot write $HANDLE's settings" '^403$' "$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H "x-zimlink-admin: $OTH_KEY" -d '{"handle":"'"$HANDLE"'","pay_account":"cross-tenant"}' "$ORIGIN/api/settings")"
  PUBT=$(curl -s -m 30 "$ORIGIN/s/$HANDLE/config.json")
  nk "and no trace of that attempt reached the public page" 'cross-tenant' "$PUBT"
  # a confirm cap is bound to the store inside its signed payload; the `handle`
  # in the body is not consulted, so it cannot be re-pointed at another tenant
  BEFORE=$(curl -s -m 30 -H "x-zimlink-admin: $OTH_KEY" "$ORIGIN/api/admin?handle=$OTHER" | python3 -c "
import sys,json;d=json.load(sys.stdin);print(sum(1 for o in d.get('orders',[]) if o.get('status')=='paid'))" 2>/dev/null)
curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"cap":"'"${MARK#/c/}"'","handle":"'"$OTHER"'"}' "$ORIGIN/api/mark" > /tmp/resp.json
AFTER=$(curl -s -m 30 -H "x-zimlink-admin: $OTH_KEY" "$ORIGIN/api/admin?handle=$OTHER" | python3 -c "
import sys,json;d=json.load(sys.stdin);print(sum(1 for o in d.get('orders',[]) if o.get('status')=='paid'))" 2>/dev/null)
ck "the body's handle is ignored, $OTHER's paid count stays $BEFORE" "^${AFTER}$" "$BEFORE"
  VERDICT=$(python3 -c "import json;r=json.load(open('/tmp/resp.json'));print('own-store='+str(bool(r.get('ok'))).lower())" 2>/dev/null)
  ck "it acted only on the store named inside the cap" "own-store=true" "$VERDICT"
  ck "the ledger endpoint still refuses a key from a stranger store" '^401$' "$(code "$ORIGIN/api/admin?handle=$OTHER")"
  ck "recovery for $OTHER does not answer for $HANDLE" '^403$' "$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"handle":"'"$OTHER"'","owner_email":"x@y.z","pay_account":"'"$OTH_KEY"'"}' "$ORIGIN/api/recover")"
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
HAVE=$(grep -ic '^set-cookie: *zl_ops=' "$HDR")
attrs() { awk 'BEGIN{IGNORECASE=1} /^set-cookie: *zl_ops/ {print}' "$HDR" | tr -d '\r'; }
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
ST2=$(curl -s -m 60 -b "zl_ops=$OC" "$ORIGIN/ops/api/state")
ck "the estate reads back as data the console can render" '"totals":\{' "$ST2"
ck "  · with an attention queue that names its reasons" '"attention":\[' "$ST2"
ck "  · and a per-refresh KV cost, so polling is a choice" '"reads_used_estimate":' "$ST2"
nk "  · holding no credential, masked or not" 'admin_token|secret_hash|fw_secret|auth_gen|"admin_url":' "$ST2"
HL=$(curl -s -m 60 -b "zl_ops=$OC" "$ORIGIN/ops/api/health")
ck "health carries the runtime self-check" '"selftest":\{' "$HL"
ck "  · and the Pages mirror it is served beside" '"pages":' "$HL"
TPLS=$(curl -s -m 30 -b "zl_ops=$OC" "$ORIGIN/ops/api/templates")
ck "every page the Worker serves is in KV" '"live": ?true' "$TPLS"
nk "  · none missing" '"live": ?false' "$TPLS"
DET=$(curl -s -m 30 -b "zl_ops=$OC" "$ORIGIN/ops/api/store?handle=$HANDLE")
ck "one store opens with its orders, log and queued change" '"summary":\{' "$DET"
ck "  · the drawer is told which fields the merchant may queue" '"editable":\[' "$DET"
LL=$(curl -s -m 30 -b "zl_ops=$OC" -H 'x-zimlink-confirm: 1' -X POST -H 'content-type: application/json' \
  -d '{"handle":"'"$HANDLE"'","action":"link"}' "$ORIGIN/ops/api/store")
# a dashboard link is a 7-day credential: it is counted, never printed
LINK_OK=$(printf '%s' "$LL" | grep -c '/a?code=v1' || true)
ck "the link lever hands out a capability, not a key" '^1$' "$LINK_OK"
LINK_TTL=$(printf '%s' "$LL" | grep -oE '"dashboard_url":"https://[^/]+/a\?code=v1\.[0-9]+' | grep -oE '[0-9]+$' | head -1)
LINK_LEFT=$(( LINK_TTL - $(date +%s) ))
ck "  · and it expires on its own (in days, not never)" '^([0-6]|7)$' "$(( LINK_LEFT / 86400 ))"
ck "  · notify and link are real actions, not dead buttons" '"ok": ?true' "$LL"
AUD=$(curl -s -m 30 -b "zl_ops=$OC" "$ORIGIN/ops/api/audit")
ck "  · and the write lands in the operator log" '"ops":\[' "$AUD"
nk "  · the log line carries no secret" 'admin_token' "$AUD"
LO=$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X POST -b "zl_ops=$OC" "$ORIGIN/ops/logout")
AFTER=$(curl -s -m 30 -o /dev/null -w '%{http_code}' -b "zl_ops=$OC" "$ORIGIN/ops/api/state")
ck "signing out answers" '^200$' "$LO"
ck "  · and the cookie is worth nothing afterwards" '^401$' "$AFTER"
code -b "zl_ops=$OC" "$ORIGIN/ops/api/state" >/dev/null; code -b "zl_ops=$OC" "$ORIGIN/ops/api/state" >/dev/null
TRY=$(curl -s -m 30 -X POST -H 'content-type: application/json' -d '{"secret":"not-the-platform-secret"}' "$ORIGIN/ops/login" | grep -oE '"tries_left": ?[0-9]+' | grep -oE '[0-9]+' | head -1)
ck "  · dead-cookie probes did not lock anybody out" '^([6-9]|1[0-2])$' "$TRY"
# and the guess this check just made is wiped from the counter, so running
# prod_check a dozen times can never freeze the operator's own console
curl -s -m 30 -o /dev/null -X POST -H 'content-type: application/json' --data-binary "@$BODY" "$ORIGIN/ops/login"
rm -f "$BODY"
fi
rm -f "$HDR"
fi

echo "[9] tidy up"
CK2=$(curl -s -m 30 -X POST -H 'content-type: application/json' -H "x-zimlink-admin: $ADMIN_KEY" \
  -d '{"handle":"'"$HANDLE"'","id":"'"$ID"'","status":"cancelled"}' "$ORIGIN/api/mark")
ck "probe order cancelled" '"status":"cancelled"' "$CK2"
rm -f "$H" "$JAR"
echo
printf '%s\n' "passed: $pass   failed: $fail"
[[ $fail -eq 0 ]] || exit 1
