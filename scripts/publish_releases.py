#!/usr/bin/env python3
"""
Publish the catalogue: push main, then attach the five long-form PDFs to a GitHub release.

Design rules, learned the hard way:
  * the token is read from the environment (GH_TOKEN) and never written to disk, to the
    remote URL, to git config, or to any log line this script prints
  * the remote is set without the token, and the push uses a one-shot authenticated URL
    that is scrubbed from every message
  * every step is idempotent: re-running updates an existing release asset rather than
    failing, so a partial run can simply be repeated
  * the script verifies its own work with *unauthenticated* GETs at the end — a release
    asset that cannot be downloaded by a stranger has not been published

Usage:
    GH_TOKEN=<token> python3 scripts/publish_releases.py [--dry-run]
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OWNER, REPO = "king-kunta-cpu", "tapstall"
TAG = "publications-2026-10"
NAME = "Publications — October 2026"
BODY = """Long-form PDF editions of the five books in the catalogue.

These are the same files catalogued at `site/index.html`; the two flagship titles and the
research paper are also held in the repository itself in Markdown, HTML, PDF and EPUB, and
are built from those sources by `scripts/make_book2.py`, `scripts/make_epub.py` and
`scripts/make_paper_pdf.py`.

Contents: The Musk Mirror · Traffic Is the New Oil · Pinterest Goldmine ·
The Rocket Man Reckoning · Unchained Blueprint (v1)."""

# The five long-form PDFs live outside the repository (they are release assets, not source),
# so they are resolved from an uploads directory beside the working tree by default.
UPLOADS = Path(os.environ.get("UPLOADS_DIR", str(ROOT.parents[1] / "uploads")))

ASSETS = [
    ("The Musk Mirror_ How One Billionaire Exposed the Cracks in China's Innovation Dream (2).pdf",
     "the-musk-mirror.pdf"),
    ("TRAFFIC IS THE NEW OIL_ The African Digital Wealth Formula (1) (1).pdf",
     "traffic-is-the-new-oil.pdf"),
    ("PINTEREST GOLDMINE.pdf", "pinterest-goldmine.pdf"),
    ("The Rocket Man Reckoning.pdf", "the-rocket-man-reckoning.pdf"),
    ("Unchained Blueprint v1.pdf", "unchained-blueprint-v1.pdf"),
]

TOKEN = os.environ.get("GH_TOKEN", "").strip()
DRY = "--dry-run" in sys.argv
API = "https://api.github.com"


def scrub(s):
    return s.replace(TOKEN, "***") if TOKEN else s


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        raise SystemExit(scrub(f"command failed: {' '.join(cmd)}\n{r.stdout}\n{r.stderr}"))
    return scrub(r.stdout)


def api(method, path, data=None, raw=None, ctype="application/json", accept="application/vnd.github+json"):
    url = path if path.startswith("http") else API + path
    body = None
    if data is not None:
        body = json.dumps(data).encode()
    elif raw is not None:
        body = raw
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Accept", accept)
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if body is not None:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        payload = e.read().decode()[:400]
        raise SystemExit(scrub(f"HTTP {e.code} on {method} {path}: {payload}"))


def main():
    if not TOKEN and not DRY:
        raise SystemExit("GH_TOKEN is not set")
    problems = []
    for src, _ in ASSETS:
        p = UPLOADS / src
        if not p.exists():
            problems.append(f"missing source file: {src}")
    if problems:
        raise SystemExit("\n".join(problems))
    for f in ["site/index.html", "site/catalogue.json",
              "book/intelligence-data-and-judgement.epub",
              "papers/tapstall-2026-order-without-custody.pdf"]:
        if not (ROOT / f).exists():
            raise SystemExit(f"not built: {f} — run the generators first")

    if DRY:
        print("dry run: would push main and upload", len(ASSETS), "assets to", TAG)
        return

    # ---------------------------------------------------------------- 1. push main
    remote_plain = f"https://github.com/{OWNER}/{REPO}.git"
    run(["git", "remote", "remove", "origin"], cwd=ROOT) if subprocess.run(
        ["git", "remote"], cwd=ROOT, capture_output=True, text=True).stdout.find("origin") >= 0 else None
    run(["git", "remote", "add", "origin", remote_plain], cwd=ROOT)
    head = run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT).strip()
    authed = f"https://x-access-token:{TOKEN}@github.com/{OWNER}/{REPO}.git"
    out = run(["git", "push", authed, "HEAD:main"], cwd=ROOT)
    print(f"pushed  {head} -> main")
    for line in out.splitlines():
        if "->" in line or "new branch" in line:
            print("        " + line.strip())

    # remote must not retain the token
    run(["git", "remote", "set-url", "origin", remote_plain], cwd=ROOT)

    # ---------------------------------------------------------------- 2. release
    try:
        rel = api("GET", f"/repos/{OWNER}/{REPO}/releases/tags/{TAG}")
        print(f"release exists: {rel['id']}")
    except SystemExit:
        rel = api("POST", f"/repos/{OWNER}/{REPO}/releases",
                  {"tag_name": TAG, "target_commitish": "main", "name": NAME,
                   "body": BODY, "draft": False, "prerelease": False})
        print(f"release created: {rel['id']}")

    existing = {a["name"]: a["id"] for a in rel.get("assets", [])}
    for src, name in ASSETS:
        data = (UPLOADS / src).read_bytes()
        if name in existing:
            api("DELETE", f"/repos/{OWNER}/{REPO}/releases/assets/{existing[name]}")
            print(f"  replaced {name}")
        upload = (f"https://uploads.github.com/repos/{OWNER}/{REPO}/releases/"
                  f"{rel['id']}/assets?name={name}")
        api("POST", upload, raw=data, ctype="application/pdf", accept="application/vnd.github+json")
        print(f"  uploaded {name}  {len(data):,} bytes")

    # ---------------------------------------------------------------- 3. pages
    try:
        pages = api("GET", f"/repos/{OWNER}/{REPO}/pages")
        print(f"pages already enabled: {pages.get('html_url')}")
    except SystemExit:
        try:
            pages = api("POST", f"/repos/{OWNER}/{REPO}/pages",
                        {"source": {"branch": "main", "path": "/site"}})
            print(f"pages enabled: {pages.get('html_url')}")
        except SystemExit as e:
            print(f"pages not enabled automatically ({e}); enable in repository settings")

    # ---------------------------------------------------------------- 4. verify
    print("verifying (unauthenticated):")
    for _, name in ASSETS:
        url = f"https://github.com/{OWNER}/{REPO}/releases/download/{TAG}/{name}"
        req = urllib.request.Request(url, method="HEAD")
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                size = r.headers.get("Content-Length")
                print(f"  {r.status}  {name}  {int(size):,} bytes")
        except urllib.error.HTTPError as e:
            raise SystemExit(f"  asset not downloadable: {name} ({e.code})")
    site_url = f"https://{OWNER}.github.io/{REPO}/"
    try:
        with urllib.request.urlopen(urllib.request.Request(site_url, method="GET"), timeout=90) as r:
            body = r.read().decode(errors="replace")
            ok = "Intelligence, Data and Judgement" in body
            print(f"  {r.status}  {site_url}  catalogue={'found' if ok else 'NOT FOUND'}")
    except Exception as e:  # noqa: BLE001 — first deploy can lag a few minutes
        print(f"  site not serving yet ({type(e).__name__}): {site_url} — Pages builds take a minute or two")

    for path in ["book/intelligence-data-and-judgement.pdf", "site/index.html"]:
        url = f"https://raw.githubusercontent.com/{OWNER}/{REPO}/main/{path}"
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=90) as r:
            print(f"  {r.status}  {path}")


if __name__ == "__main__":
    main()
