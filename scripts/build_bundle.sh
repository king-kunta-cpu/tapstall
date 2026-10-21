#!/usr/bin/env bash
# Build the deployable bundle:
#   1. inline worker/core.js into worker/worker.js -> one ES module (.build/worker.js)
#   2. mirror the HTML pages + data files as Worker static assets (.build/assets)
# core.js stays the single source of truth for pricing/parsing and unit tests.
#   ./scripts/build_bundle.sh [outdir]      default: .build
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-.build}"
rm -rf "$OUT"; mkdir -p "$OUT/assets"

python3 - "$OUT/worker.js" <<'PYEOF'
import re, sys, json as _json, os as _os

worker = open('worker/worker.js', encoding='utf-8').read()
core = open('worker/core.js', encoding='utf-8').read()
rail = open('worker/rail.js', encoding='utf-8').read()
discover = open('worker/discover.js', encoding='utf-8').read()

def inline(src, name, needs, target):
    """Replace `import { ... } from './<name>.js';` with the module body, exports stripped.

    Order matters and is asserted: the selling rail is inlined FIRST because the core import
    regex would otherwise swallow the rail import on its way to './core.js'."""
    # `[^;]*?` rather than `[\s\S]*?`: an import statement ends at its semicolon, and a lazy
    # match across statements swallows the import *above* it (that is how discover.js's import was
    # deleted by the rail inline, and how TARGET_SEGMENTS came to be undefined in a deploy that
    # passed every other test).
    m = re.search(r"import \{[^;]*?\} from '\./" + re.escape(name) + r"\.js';", target)
    assert m, "worker.js must import from './%s.js' (build inlines it)" % name
    body = re.sub(r"^export (const|function|async function)", r"\1", src, flags=re.M)
    body = re.sub(r"/\*[\s\S]*?\*/", "", body.strip(), count=1).strip()
    for need in needs:
        assert need in body, "%s.js lost %s during inlining" % (name, need)
    out = target.replace(m.group(0),
        "/* ---- %s.js, inlined by build_bundle.sh (source of truth: worker/%s.js) ---- */\n" % (name, name) + body)
    assert "from './%s.js'" % name not in out, "%s import survived inlining" % name
    return out

# v1.7.0: the selling rail rides in the same bundle as core, for the same reason — one module,
# tested directly, and no import a Worker deploy could silently drop.
worker = inline(rail, 'rail',
    ("function settlement", "function railCatalogue", "function allocateCents", "function paymentEvent",
     "function verifyWebhook", "function vettingPlan", "function collectSettlement", "async function hmacSha256Hex"),
    worker)
# v1.7.1: discovery rides in the same bundle for the same reason, and this is the module that
# proved the regex had to be tightened: left out, the routes answer 500 with a ReferenceError and
# nothing else on the platform notices.
worker = inline(discover, 'discover',
    ("const TARGET_SEGMENTS", "function discoveryPlan", "async function runDiscovery",
     "function candidateLead", "function hookFor", "function readPageEvidence"),
    worker)
worker = inline(core, 'core',
    ("function priceOrder", "function parseProducts", "const RAILS", "function publicStore",
     "function adminStore", "const PUBLIC_KEYS", "function issueCap", "function verifyCap", "async function sign"),
    worker)
out = worker

# The pages ride in the bundle. This is the part that used to be eight KV `put`s per release, and
# the reason a page could be current in git and stale for a customer for nine hours: a KV write is
# a budgeted thing, and a deploy is not. Inlined, a page costs no write to publish, no read to
# serve, and cannot disagree with the tests that ran on the same bytes. The operator console keeps
# its hand-publish door (it writes `tpl-ovr:<name>`, which outranks the bundle) precisely because
# the emergency case is "the deploy is not available at 22:00 and the page is wrong now".
pages = {}
for n in ('store', 'onboard', 'admin', 'confirm', 'renew', 'ops', 'index', 'fees', 'partners',
          'guide-whatsapp-shop-payments', 'guide-payment-reference-matching'):
    for cand in ('pages/%s.html', 'pages/public/%s.html', 'pages/public/guide/%s.html'):
        f = cand % n
        if _os.path.exists(f):
            pages[n] = open(f, encoding='utf-8').read()
            break
pages['sample-menu'] = open('pages/sample-menu.csv', encoding='utf-8').read() if _os.path.exists('pages/sample-menu.csv') else ''
missing = [n for n, v in pages.items() if len(v) < 200 and n != 'sample-menu']
assert not missing, "pages missing or stubby, and shipping a bundle without them is how a merchant gets a blank page: %s" % missing
decl = "const INLINED_PAGES = {};"
assert out.count(decl) == 1, "worker.js must declare `const INLINED_PAGES = {};` for the bundler to fill"
out = out.replace(decl, "const INLINED_PAGES = " + _json.dumps(pages, ensure_ascii=False, separators=(',', ':')) + ";")
print("pages inlined: %d files, %d bytes" % (len(pages), sum(len(v) for v in pages.values())))
open(sys.argv[1], "w", encoding="utf-8").write(out + "\n")
print("bundle: worker.js + discover.js + core.js + rail.js inlined (%d lines, %d bytes)" % (len(out.splitlines()), len(out)))
PYEOF

for f in store.html onboard.html admin.html confirm.html renew.html ops.html; do cp "pages/$f" "$OUT/assets/$f"; done
# The mirror's own set. `_redirects` used to live here as a Netlify convention
# that neither Pages nor this Worker implements, so it is gone; `onboard.html`
# is the handoff that makes the mirror's sign-up link land somewhere real.
for f in index.html fees.html _headers onboard.html; do [[ -f "pages/public/$f" ]] && cp "pages/public/$f" "$OUT/assets/$f" || true; done
if ls pages/public/data/*.csv >/dev/null 2>&1; then
  mkdir -p "$OUT/assets/data" && cp pages/public/data/*.csv "$OUT/assets/data/"
fi

node --input-type=module --check < "$OUT/worker.js"   # ESM-aware: catches what plain --check misses
# The free plan caps a bundle at 3 MB gzipped. The pages are the bulk of it, so the cap is checked
# here at build time rather than discovered by a 413 from the API in the middle of a release.
gzip -kf "$OUT/worker.js"
GZ=$(stat -c %s "$OUT/worker.js.gz" 2>/dev/null || stat -f %z "$OUT/worker.js.gz")
rm -f "$OUT/worker.js.gz"
LIMIT=$((3 * 1024 * 1024))
if [ "$GZ" -gt "$LIMIT" ]; then
  echo "bundle is $GZ gzipped bytes, over the 3 MB Worker limit — pages are the bulk of it, so a page is too big" >&2
  exit 1
fi
echo "bundle gzipped: $GZ of $LIMIT bytes"
echo "assets: $(cd "$OUT/assets" && ls -A | tr '\n' ' ')"
du -sh "$OUT" | awk '{print "bundle size:", $1}'
