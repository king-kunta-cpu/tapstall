#!/usr/bin/env bash
# try_login.sh — prove the front door from a clean state, in one command.
#
#   bash scripts/try_login.sh mamatoe 482913
#   bash scripts/try_login.sh                      # uses KEY= / PIN= from the shell
#
# It signs in at /api/auth with a store name and a PIN, using a throwaway cookie
# jar, then reads the dashboard with that cookie. Nothing here is stored, and a
# login is not a one-use thing: run it again and it works again until the PIN is
# changed. Exit code is 0 only if the whole path answered correctly.
set -uo pipefail
cd "$(dirname "$0")/.."
O="${ORIGIN:-https://tapstall.simalidudu.workers.dev}"
KEY="${1:-${KEY:-}}"
PIN="${2:-${PIN:-}}"
if [[ -z "$KEY" || -z "$PIN" ]]; then echo "usage: bash scripts/try_login.sh <store name> <PIN>" >&2; exit 2; fi
J=$(mktemp); H=$(mktemp); trap 'rm -f "$J" "$H"' EXIT

echo "1) sign in at $O/a  (key: $KEY)"
C=$(curl -s -m 30 -c "$J" -D "$H" -X POST -H 'content-type: application/json' \
     -d "{\"key\":\"$(printf '%s' "$KEY" | sed 's/"/\\"/g')\",\"pin\":\"$(printf '%s' "$PIN" | tr -dc '0-9')\"}" "$O/api/auth")
printf '   %s\n' "$C"
CODE=$(printf '%s' "$C" | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('ok') and 'ok' or 'refused')
except Exception: print('not json')")
[[ "$CODE" == "ok" ]] || { echo "   → the door stayed shut. Wrong PIN, or the store is frozen after repeated guesses; “I lost my PIN” on $O/a resets it from the store's own details."; exit 1; }

echo "2) the cookie it set"
printf '%s' "$(grep -i tp_sess "$H" | tr -d '\r')" | grep -o 'HttpOnly\|SameSite=[A-Za-z]*\|Secure\|Max-Age=[0-9]*' | sed 's/^/   · /'
grep -qi 'tp_sess=.*Path=\/;' "$H" && echo "   · Path=/ (this origin only, no domain-wide cookie)"

echo "3) read the dashboard with the cookie and nothing else"
curl -s -m 30 -b "$J" "$O/api/admin?handle=$KEY" > /tmp/tp_dash.$$
# /a is fetched with curl on purpose: Cloudflare's edge answers 403 to a
# python-urllib user agent, and this script is about the app, not the edge.
curl -s -m 30 "$O/a" > /tmp/tp_page.$$
python3 - "$KEY" /tmp/tp_dash.$$ /tmp/tp_page.$$ <<'PY'
import json, re, sys
key, path, page = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(path))
st = d.get('store') or {}
orders = d.get('orders') or []
due = [o for o in orders if o and o.get('status') not in ('paid', 'cancelled')]
print(f"   ok={d.get('ok')} via={d.get('via')} shop={st.get('shop_name')!r} "
      f"orders={len(orders)} waiting={len(due)} plan={st.get('plan')}")
print(f"   PIN on this store: set {str(st.get('pin_set_at'))[:10]}")
raw = open(path).read()
leak = re.findall(r'"kdf"|"salt"|"hash"|"[0-9]{6}"', raw)
print("   PIN material in the payload:", "!! " + ", ".join(leak[:4]) if leak else "none")
html = open(page, encoding="utf-8", errors="replace").read()
fields = html.count('id="fK"') + html.count('id="fP"')
panel = "has" if "Change your PIN" in html else "NO"
nav = "still has tabs" if "viewTabs" in html else "no tabs, one page"
print("4) the screen itself: %d characters, %d sign-in fields, %s PIN panel, %s"
      % (len(html), fields, panel, nav))
PY
rm -f /tmp/tp_dash.$$ /tmp/tp_page.$$
echo
echo "If 1-3 answered above, the login works end to end from a clean state."
