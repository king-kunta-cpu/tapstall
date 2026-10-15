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
# BUILD=0 is for the one case that needs the source: no build has run and wrangler is being
# invoked by hand. A deploy that ships worker/worker.js by accident is the bug this flag exists
# to make impossible, so the default is the bundle and the exception has to be typed.
MAIN = "worker/worker.js" if os.environ.get("BUILD", "1") == "0" else ".build/worker.js"

out = f"""name = "{name}"
main = "{MAIN}"
compatibility_date = "2025-06-01"
workers_dev = true

# main points at the BUILT bundle, not the source, and that is the whole difference between a deploy
# and a lie. The suites run .build/worker.js; while this line said worker/worker.js, production was
# shipping a different file than the one 294 tests had just read - which is how v0.9.1 went out with
# INLINED_PAGES empty (pages_inlined: 0 in /__selftest) while the build log cheerfully reported eleven
# pages inlined. build_bundle.sh inlines core.js and fills the page map, so the artifact is
# self-contained and needs no module rules, and git's bytes are the deployed bytes.
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
PUBLIC_ORIGIN = "%s"
""" % (redir, os.environ.get("PUBLIC_ORIGIN", "").strip())
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
