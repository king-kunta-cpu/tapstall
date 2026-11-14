#!/usr/bin/env python3
"""Tapstall per-post cards. The Worker notes a card for each queued post that would otherwise carry a stock topic card
(GET /api/press/cards/wanted), this renders them with mediakit (scripts/cards/mediakit.py, brand.json) and uploads each
PNG (PUT /api/press/cards/<key>); the Worker serves them at /m/<key>.png and swaps them into the post on its next tick.
A post whose card is not ready yet keeps its topic card, so it never goes out without an image.

  CARDS_TOKEN=... python3 scripts/cards/render.py [--url https://tapstall.tapstall.workers.dev] [--dry outdir]
Run by .github/workflows/cards.yml, which the Worker dispatches (at most every 6 hours, only when a card is wanted)."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mediakit  # noqa: E402

KEY = re.compile(r"^c[0-9a-f]{16}$")
UA = "tapstall-cards/1.0"


def req(method, url, token, data=None, ctype="application/json"):
    r = urllib.request.Request(url, data=data, method=method, headers={"Authorization": f"Bearer {token}", "User-Agent": UA, "Content-Type": ctype})
    with urllib.request.urlopen(r, timeout=30) as resp:
        return resp.status, json.loads(resp.read() or b"{}")


def render_spec(spec: dict) -> bytes:
    layout = spec.get("layout", "headline")
    if layout != "headline":
        raise ValueError(f"layout {layout!r} not drawn for Tapstall")
    return mediakit.render("headline", spec.get("shape", "wide"), {
        "kicker": str(spec.get("kicker", ""))[:24], "headline": str(spec.get("headline", ""))[:160],
        "body": str(spec.get("body", ""))[:260], "seed": str(spec.get("seed", spec.get("key", "x")))})


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.environ.get("TAPSTALL_URL", "https://tapstall.tapstall.workers.dev"))
    ap.add_argument("--dry", default="", help="write PNGs here instead of uploading")
    a = ap.parse_args(argv)
    token = os.environ.get("CARDS_TOKEN", "")
    if not token:
        print("CARDS_TOKEN missing")
        return 2
    base = a.url.rstrip("/")
    _, want = req("GET", base + "/api/press/cards/wanted", token)
    items = [s for s in (want.get("items") or []) if KEY.match(str(s.get("key", "")))][:40]
    done = failed = 0
    for spec in items:
        try:
            png = render_spec(spec)
            if a.dry:
                Path(a.dry).mkdir(parents=True, exist_ok=True)
                (Path(a.dry) / f"{spec['key']}.png").write_bytes(png)
            else:
                st, body = req("PUT", f"{base}/api/press/cards/{spec['key']}", token, data=png, ctype="image/png")
                if not body.get("ok"):
                    raise RuntimeError(body.get("error") or st)
            done += 1
            print(f"card {spec['key']} {len(png)} bytes: {spec.get('headline', '')[:60]}")
        except Exception as e:  # noqa: BLE001  one bad card never stops the rest
            failed += 1
            print(f"card {spec.get('key')} failed: {type(e).__name__}: {str(e)[:160]}")
    print(f"wanted={len(items)} rendered={done} failed={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
