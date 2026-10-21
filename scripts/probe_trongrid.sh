#!/usr/bin/env bash
# What the watcher's parsers expect, asked of the real endpoints, printed side by side.
# Run it before believing any change to tronUsdtTransfers / tronTxOk: the wire format is
# what the network answers, not what the docs show, and this repo has been wrong about a
# response shape twice (the list rows carry `block_timestamp`, not `timestamp`; the
# verification lives on the node endpoint as `receipt.result`, not `data[0].ret`).
# No key, no account: this is the free public read path, exactly what the cron uses —
# which throttles at 3 rps and answers the excess with an `Error` body at HTTP 200,
# so pace yourself.
set -u
API="${TRONGRID_API:-https://api.trongrid.io}"
USDT='TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'   # the real Tether contract on Tron mainnet
# A live, busy holder, seen on-chain when this script was written (2026-10-15). If it
# has emptied, step 1 just prints fewer rows; the format claims do not depend on it.
BUSY='TGbmcapEMW1XSRKCWPYPjsFG3LDNbu75Lo'

say() { printf '\n== %s\n' "$1"; }

say "1) the per-account list, exactly as the watcher calls it (rows must have transaction_id, block_timestamp, value as a digit-string, type, token_info.address)"
L1=$(curl -s --max-time 25 "$API/v1/accounts/$BUSY/transactions/trc20?only_confirmed=true&only_to=true&limit=3&contract_address=$USDT")
TX=$(printf '%s' "$L1" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit()
r=(d.get("data") or [{}])[0]
print(r.get("transaction_id",""))' 2>/dev/null)
python3 - "$L1" <<'PY'
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception as e:
    sys.exit('could not parse the list response: %s' % e)
if 'Error' in d:
    sys.exit('rate-limited (the 3 rps free tier answered HTTP 200 with an Error body — the worker must treat this as an error, which it does): %s' % str(d)[:160])
rows = d.get('data') or []
if not rows:
    sys.exit('endpoint answered with no rows: the shape below is unverified this run')
ok = lambda b: 'yes' if b else 'NO'
for i, row in enumerate(rows):
    print('row %d: transaction_id 64-hex %s | block_timestamp ms %s | value digit-string %s | type %r %s | token_info.address %s' % (
        i,
        ok(len(str(row.get('transaction_id', ''))) == 64),
        ok(isinstance(row.get('block_timestamp'), (int, float)) and row['block_timestamp'] > 1e12),
        ok(str(row.get('value', '')).isdigit()),
        row.get('type'), ok(row.get('type') == 'Transfer'),
        ok(bool((row.get('token_info') or {}).get('address')))))
    print('       from/to present %s' % ok(bool(row.get('from')) and bool(row.get('to'))))
PY

say "2) verification of $TX — the node endpoint; success is receipt.result==SUCCESS (or ret[].contractRet), an unknown txid answers {}"
[ -n "$TX" ] && curl -s --max-time 25 -X POST "$API/wallet/gettransactioninfobyid" -H "Content-Type: application/json" \
  -d "{\"value\":\"$TX\"}" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception as e: sys.exit("unparsable: %s" % e)
print("id echoes txid      :", "yes" if d.get("id") else "NO")
print("receipt.result      :", repr((d.get("receipt") or {}).get("result")))
print("ret[] present       :", "yes" if d.get("ret") else "no (the live shape does not carry one)")'
[ -n "$TX" ] && curl -s --max-time 25 "$API/v1/transactions/$TX" | head -c 120 | sed "s|^|   the /v1 detail endpoint now answers: |" ; [ -n "$TX" ] && echo "   (404 is expected — it is gone; do not write parsers against it)" 

say "3) the dead paths, kept here so nobody re-invents them: the global transfer list is 404"
curl -s --max-time 25 "$API/v1/transactions?only_confirmed=true&only_to=true&limit=1&contract_address=$USDT" | head -c 120; echo

say "done. The worker is green against 1+2 as printed; if any line says NO, fix worker/worker.js and the tronStub in tests/live.test.mjs together."
