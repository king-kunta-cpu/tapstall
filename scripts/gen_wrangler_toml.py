#!/usr/bin/env python3
"""Generate wrangler.toml. Never hand-edited: this is the only place the KV ids
and the cron schedule are written down, so a rename or a second Worker cannot
leave the two configs disagreeing about which namespace holds the stores.

Env: NAME (required), STORES_ID, ORDERS_ID, and optionally
  REDIRECT_TO  — page GETs answer 301 to this origin instead of serving (used for
                 the previous brand's hostname, so saved links keep working)
  WITH_CRON=0  — no [triggers]: two Workers on one KV must not both run the
                 daily sweep, which would double the writes and the notices
"""
import os

name = os.environ["NAME"]
sid, oid = os.environ["STORES_ID"], os.environ["ORDERS_ID"]
redir = os.environ.get("REDIRECT_TO", "").strip()
cron = os.environ.get("WITH_CRON", "1") != "0"

out = f"""name = "{name}"
main = "worker/worker.js"
compatibility_date = "2025-06-01"
workers_dev = true

# Templates are served from KV (keys tpl:*) so an HTML fix is one PUT, not a
# redeploy: no git push, no dashboard, no build step. That is why there is no
# [assets] block here - Cloudflare's static-asset upload format is the one part
# of this stack that is not pleasant to script, and KV does the job for free.
[[kv_namespaces]]
binding = "STORES"
id = "{sid}"

[[kv_namespaces]]
binding = "ORDERS"
id = "{oid}"
"""
if redir:
    out += """
# The previous brand's hostname. It answers redirects for pages and keeps serving
# anything with a body, so a browser mid-order is never told "go somewhere else".
[vars]
REDIRECT_TO = "%s"
""" % redir
if cron:
    out += """
[triggers]
crons = ["15 6,12,18,0 * * *"]
"""
out += """
[observability]
enabled = true
"""
open("wrangler.toml", "w").write(out)
print("wrangler.toml regenerated for %s%s" % (name, " (alias, redirects)" if redir else ""))
