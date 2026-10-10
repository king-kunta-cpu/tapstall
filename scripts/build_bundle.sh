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
import re, sys
worker = open('worker/worker.js', encoding='utf-8').read()
core = open('worker/core.js', encoding='utf-8').read()

m = re.search(r"import \{[\s\S]*?\} from './core\.js';", worker)
assert m, "worker.js must import from './core.js' (build inlines it)"

body = re.sub(r"^export (const|function|async function)", r"\1", core, flags=re.M)
body = re.sub(r"/\*[\s\S]*?\*/", "", body.strip(), count=1).strip()
for need in ("function priceOrder", "function parseProducts", "const RAILS", "function publicStore"):
    assert need in body, "core.js lost %s during inlining" % need

out = worker.replace(m.group(0), "/* ---- core.js, inlined by build_bundle.sh (source of truth: worker/core.js) ---- */\n" + body)
assert "from './core.js'" not in out, "import survived inlining"
open(sys.argv[1], "w", encoding="utf-8").write(out + "\n")
print("bundle: worker.js + core.js inlined (%d lines, %d bytes)" % (len(out.splitlines()), len(out)))
PYEOF

for f in store.html onboard.html admin.html; do cp "pages/$f" "$OUT/assets/$f"; done
for f in index.html fees.html _headers; do [[ -f "pages/public/$f" ]] && cp "pages/public/$f" "$OUT/assets/$f" || true; done
if ls pages/public/data/*.csv >/dev/null 2>&1; then
  mkdir -p "$OUT/assets/data" && cp pages/public/data/*.csv "$OUT/assets/data/"
fi

node --input-type=module --check < "$OUT/worker.js"   # ESM-aware: catches what plain --check misses
echo "assets: $(cd "$OUT/assets" && ls -A | tr '\n' ' ')"
du -sh "$OUT" | awk '{print "bundle size:", $1}'
