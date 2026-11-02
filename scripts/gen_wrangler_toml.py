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
# 2026-11-02 owner: Gmail outreach paused in every business until the owner resumes it. The lane keeps
# all merchant/transactional mail (PIN resets, receipts, order notices) but takes no outreach, and
# OUTREACH_LV=off also stops the runner dispatch. To resume: drop "outreach":false and set OUTREACH_LV=on.
mailboxes = os.environ.get("MAILBOXES", "").strip() or '[{"id":"owner","provider":"gmail","fromName":"Tapstall","hourly":6,"outreach":false}]'
outreach_lv = os.environ.get("OUTREACH_LV", "").strip() or "off"
out += "\n[vars]\n"
if origin:
    out += f'PUBLIC_ORIGIN = "{origin}"\n'
out += "MAILBOXES = '" + mailboxes.replace("'", "") + "'\n"
out += 'OUTREACH_LV = "' + outreach_lv.replace('"', '') + '"\n'

open("wrangler.toml", "w").write(out)
print("wrangler.toml regenerated for %s" % name)
