#!/usr/bin/env bash
# Onboard a seller from the shell — the same door the owner console uses, for bulk setup.
#   ADMIN_SECRET=... ./scripts/seller_add.sh tino-sells "tino mudzi" 30
# Prints the seller's single-use-shown key and both links. The key is shown ONCE (at
# registration and at rotation); hand it to the seller like a password, there is no
# "read it back" anywhere by design.
set -euo pipefail
ORIGIN="${TAPSTALL_ORIGIN:-https://tapstall.zlnew.workers.dev}"
CODE="${1:?usage: seller_add.sh <code> <name> [commission_pct]}"
NAME="${2:?seller full name required}"
PCT="${3:-30}"
: "${ADMIN_SECRET:?set ADMIN_SECRET}"
curl -s -m 30 -X POST "$ORIGIN/ops/api/sellers" \
  -H "x-tapstall-admin: $ADMIN_SECRET" -H "x-confirm: yes" -H 'Content-Type: application/json' \
  -d "$(printf '{"action":"register","code":"%s","name":"%s","commission_pct":%s}' "$CODE" "$NAME" "$PCT")" \
  | python3 -c 'import sys,json
d=json.load(sys.stdin)
if not d.get("ok"): sys.exit("failed: "+json.dumps(d))
print("seller:", d["seller"]["code"], "-", d["seller"]["name"])
print("KEY (shown once):", d.get("seller_key"))
print("short link:  ", d["links"]["short"])
print("guide link:  ", d["links"]["guide"])
print("long link:   ", d["links"]["long"])'
