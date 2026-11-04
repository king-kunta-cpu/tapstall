#!/usr/bin/env python3
"""Generate wrangler.toml for the one Tapstall Worker.

Env: NAME, STORES_ID, ORDERS_ID, optional PUBLIC_ORIGIN. BUILD=0 is the manual
wrangler escape hatch (source instead of bundle); deploys use the bundle.
"""
import os

name = os.environ["NAME"]
sid, oid = os.environ["STORES_ID"], os.environ["ORDERS_ID"]
origin = os.environ.get("PUBLIC_ORIGIN", "").strip()
MAIN = "worker/worker.js" if os.environ.get("BUILD", "1") == "0" else ".build/worker.js"

out = f'''name = "{name}"
main = "{MAIN}"
compatibility_date = "2025-06-01"
workers_dev = true

# main points at the BUILT bundle, not the source: the suites run .build/worker.js,
# and production must ship the same bytes they just read.
[[kv_namespaces]]
binding = "STORES"
id = "{sid}"

[[kv_namespaces]]
binding = "ORDERS"
id = "{oid}"

# v2.3.0: the WhatsApp shop bot's conversations. One SQLite-backed Durable Object per buyer chat
# holds the cart and the step, so a chat costs no KV writes (the whole account has 1,000 a day and
# the shops' orders need them). Free plan: SQLite-backed classes only. The binding exists even
# before the WA_* secrets do; without them /wa/hook answers 503 and nothing runs.
[[durable_objects.bindings]]
name = "WA_BOT"
class_name = "WaBot"

[[migrations]]
tag = "wa-v1"
new_sqlite_classes = ["WaBot"]

[triggers]
crons = ["15 6,12,18,0 * * *", "5 * * * *"]

[observability]
# Quota-first: invocation logs are off; /__selftest + ops health are the witness.
enabled = false
'''
# v2.2.0: the Gmail lane (docs/GMAIL.md). It reads the GMAIL_OWNER_USER / GMAIL_OWNER_APP_PASSWORD Worker
# secrets, the same box the outreach runner sends from, so replies land in one inbox. 6/hour leaves the
# rest of Gmail's ~500/day to the runner and to manual sending (a gmail lane is clamped to 18/hour).
# 2026-11-04 owner: outreach v2 ON. The owner lane keeps merchant/transactional mail only; outreach goes
# out on two outreach-only lanes, gm1 (MAILBOX_GM1_*) and gm2 (MAILBOX_GM2_*), the two personal Gmail boxes,
# at most 6 an hour each (one slot kept back), the day capped by the ramp 10/25/50 (worker/mail.js, outreach v2).
mailboxes = os.environ.get("MAILBOXES", "").strip() or ('[{"id":"owner","provider":"gmail","fromName":"Tapstall","hourly":6,"outreach":false},'
    '{"id":"gm1","provider":"gmail","fromName":"Tapstall","hourly":6},{"id":"gm2","provider":"gmail","fromName":"Tapstall","hourly":6}]')
outreach_lv = os.environ.get("OUTREACH_LV", "").strip() or "on"
postal = os.environ.get("POSTAL_ADDRESS", "").strip() or "Jacaranda Labs, P.O. Box 900, Bulawayo, Zimbabwe"
out += "\n[vars]\n"
if origin:
    out += f'PUBLIC_ORIGIN = "{origin}"\n'
out += "MAILBOXES = '" + mailboxes.replace("'", "") + "'\n"
out += 'OUTREACH_LV = "' + outreach_lv.replace('"', '') + '"\n'
out += 'OUTREACH_DAILY = "50"\n'
out += 'POSTAL_ADDRESS = "' + postal.replace('"', '') + '"\n'

open("wrangler.toml", "w").write(out)
print("wrangler.toml regenerated for %s" % name)
