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

[triggers]
crons = ["15 6,12,18,0 * * *", "5,25,45 * * * *"]

[observability]
# Quota-first: invocation logs are off; /__selftest + ops health are the witness.
enabled = false
'''
# v2.2.0: the Gmail lane (docs/GMAIL.md). It reads the GMAIL_OWNER_USER / GMAIL_OWNER_APP_PASSWORD Worker
# secrets, the same box the outreach runner sends from, so replies land in one inbox. 6/hour leaves the
# rest of Gmail's ~500/day to the runner and to manual sending (a gmail lane is clamped to 18/hour).
mailboxes = os.environ.get("MAILBOXES", "").strip() or '[{"id":"owner","provider":"gmail","fromName":"Tapstall","hourly":6}]'
out += "\n[vars]\n"
if origin:
    out += f'PUBLIC_ORIGIN = "{origin}"\n'
out += "MAILBOXES = '" + mailboxes.replace("'", "") + "'\n"

open("wrangler.toml", "w").write(out)
print("wrangler.toml regenerated for %s" % name)
