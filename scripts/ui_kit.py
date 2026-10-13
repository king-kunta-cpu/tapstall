#!/usr/bin/env python3
"""Inline pages/kit.css into the pages that ask for it.

Each authored page lives in `pages/src/<name>.html` and carries the marker
`/*__KIT__*/` inside its single <style> block. This script writes the shippable
copy to `pages/<name>.html` with the kit pasted in, so:

  * what Cloudflare KV serves is one self-contained file — no stylesheet to
    fetch, which matters on a 2G handset, in a sandboxed viewer, and in a mail
    preview;
  * the shared language still has exactly one source of truth, `pages/kit.css`;
  * `./scripts/ui_kit.py check` fails the build when a shipped page has drifted
    from its source + the kit (someone hand-edited the wrong file, or edited the
    kit and forgot to regenerate). Run from the repo root.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARK = "/*__KIT__*/"


def render(src_text, kit):
    if MARK not in src_text:
        return None
    return src_text.replace(MARK, kit.strip(), 1)


def targets():
    d = os.path.join(ROOT, "pages", "src")
    if not os.path.isdir(d):
        return []
    return sorted(f for f in os.listdir(d) if f.endswith(".html"))


def main():
    check = len(sys.argv) > 1 and sys.argv[1] == "check"
    kit = open(os.path.join(ROOT, "pages", "kit.css"), encoding="utf-8").read()
    if MARK in kit:
        sys.exit("kit.css must not contain the marker")
    drift, built = [], []
    for name in targets():
        src = open(os.path.join(ROOT, "pages", "src", name), encoding="utf-8").read()
        out = render(src, kit)
        if out is None:
            sys.exit("pages/src/%s has no %s marker" % (name, MARK))
        dest = os.path.join(ROOT, "pages", name)
        have = open(dest, encoding="utf-8").read() if os.path.exists(dest) else None
        if have == out:
            continue
        if check:
            drift.append(name if have is not None else name + " (missing)")
        else:
            open(dest, "w", encoding="utf-8").write(out)
            built.append("%s %s bytes" % (name, format(len(out), ",")))
    if check:
        if drift:
            sys.exit("UI pages out of date with pages/src or kit.css: %s — run ./scripts/ui_kit.py"
                     % ", ".join(drift))
        print("ui kit: %d page(s) in sync with pages/kit.css" % len(targets()))
        return
    if built:
        print("ui kit inlined -> " + ", ".join(built))
    else:
        print("ui kit: nothing to do (already in sync)")


if __name__ == "__main__":
    main()
