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
if origin:
    out += f'''
[vars]
PUBLIC_ORIGIN = "{origin}"
'''
open("wrangler.toml", "w").write(out)
print("wrangler.toml regenerated for %s" % name)
