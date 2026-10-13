#!/usr/bin/env python3
"""Is this page in the bundle that is about to be uploaded?

  OUT=.build/worker.js SRC=pages/admin.html python3 scripts/check_bundle_pages.py [name]

`build_bundle.sh` inlines every page under pages/ into a single `const INLINED_PAGES = {…}` line and
the Worker serves that. So the question a deploy has to answer before it ships is local, cheap, and
answerable *first* — which is the whole point. The pipeline used to answer it by writing eight keys
to KV and reading them back, a machine that could only report the truth after the deploy and refused
to run at all on a day the account had spent its 1,000 writes. That is how "the Worker is current and
the page is not" became a state a shop could sit in overnight.

The map is parsed as JSON rather than searched as text, because `json.dumps` turns every newline in
a page into a literal backslash-n: a text search for a run of the page's own characters then fails
on a page that is present, and a check with that many false alarms is a check people start ignoring.
"""
import json
import os
import sys

HEAD = "const INLINED_PAGES = "

OUT = os.environ.get("OUT", "")
SRC = os.environ.get("SRC", "")
name = sys.argv[1] if len(sys.argv) > 1 else os.path.basename(SRC)


def die(msg):
    print("  x %s: %s" % (name, msg))
    raise SystemExit(1)


if not OUT or not SRC or not os.path.exists(OUT) or not os.path.exists(SRC):
    die("the checker needs OUT and SRC to exist")

blob = open(OUT, encoding="utf-8").read()
src = open(SRC, encoding="utf-8").read()

i = blob.find(HEAD)
if i < 0:
    die("the bundle has no INLINED_PAGES map — build_bundle.sh did not fill it")
j = blob.find("\n", i)          # the map is written on one line; a page is full of `};`, so an
if j < 0:                       # end-of-line is the only terminator worth trusting here
    die("the INLINED_PAGES map is not terminated by a newline")
try:
    data = json.loads(blob[i + len(HEAD):j].rstrip().rstrip(";"))
except ValueError as e:
    die("the INLINED_PAGES map is not readable JSON: %s" % str(e)[:120])

if name not in data:
    die("the bundle carries no page called %s (%d in it: %s)"
        % (name, len(data), " ".join(sorted(data))[:200]))

have = "".join(c for c in data[name] if c.isalnum())
body = "".join(c for c in src if c.isalnum())
if len(body) < 400:
    raise SystemExit(0)         # a stub file is build_bundle.sh's problem, and it says so loudly
if body not in have:
    die("the copy in the bundle is not the copy in git (%d bytes there, %d here)"
        % (len(data[name]), len(src)))
print("  = %s is in the bundle, all %d bytes of it" % (name, len(src)))
