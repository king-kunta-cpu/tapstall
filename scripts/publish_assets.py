#!/usr/bin/env python3
"""
Keep the public release assets in step with the repository, under names a reader can
keep on a shelf: Surname-Year-Title.pdf, not a working filename.

Two jobs:

  rename   assets that were uploaded under working names get re-uploaded under their
           published names, then the working names are removed
  upload   the books and papers held in this repository are published as release
           assets, so every PDF is served with a download disposition instead of
           opening inside the reader's tab

Needs a token with contents:write in GITHUB_TOKEN. Nothing here is written to disk
except a temporary download during a rename, which is removed afterwards.

Usage:  GITHUB_TOKEN=… python3 scripts/publish_assets.py [--dry-run]
"""
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "https://api.github.com/repos/king-kunta-cpu/tapstall"
TAG = "publications-2026-10"

# working name on the release -> published name
RENAMES = {
    "the-musk-mirror.pdf": "Garikai-2026-The-Musk-Mirror.pdf",
    "traffic-is-the-new-oil.pdf": "Garikai-2026-Traffic-Is-the-New-Oil.pdf",
    "pinterest-goldmine.pdf": "Garikai-2026-Pinterest-Goldmine.pdf",
    "the-rocket-man-reckoning.pdf": "Garikai-2026-The-Rocket-Man-Reckoning.pdf",
    "unchained-blueprint-v1.pdf": "Garikai-2026-Unchained-Blueprint-v1.pdf",
}

# repository file -> published asset name
UPLOADS = {
    "book/Garikai-2026-The-Ledger-and-the-Shopkeeper.pdf": "Garikai-2026-The-Ledger-and-the-Shopkeeper.pdf",
    "book/Garikai-2026-Intelligence-Data-and-Judgement.pdf": "Garikai-2026-Intelligence-Data-and-Judgement.pdf",
    "papers/Garikai-2026-Order-Without-Custody-DCAI-Working-Paper-3.pdf":
        "Garikai-2026-Order-Without-Custody-DCAI-Working-Paper-3.pdf",
    "papers/Garikai-2026-The-Sovereign-Micro-Enterprise.pdf":
        "Garikai-2026-The-Sovereign-Micro-Enterprise.pdf",
    "papers/Garikai-2026-Grounded-Cadence.pdf": "Garikai-2026-Grounded-Cadence.pdf",
    # the two books whose interiors are not public: the jacket is the deliverable
    "book/covers/governable-cover.pdf": "Garikai-2026-The-Governable-Enterprise-cover.pdf",
    "book/covers/emotional-cover.pdf": "Garikai-2026-Emotional-Engineering-cover.pdf",
}


def token():
    t = os.environ.get("GITHUB_TOKEN", "").strip()
    if not t:
        sys.exit("GITHUB_TOKEN is not set")
    return t


def api(path, method="GET", data=None, raw=False):
    req = urllib.request.Request(f"{API}{path}", method=method,
                                data=json.dumps(data).encode() if data else None,
                                headers={"Authorization": f"Bearer {token()}",
                                         "Accept": "application/vnd.github+json",
                                         "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        body = r.read()
        return body if raw else (json.loads(body) if body else None)


def release():
    return api(f"/releases/tags/{TAG}")


def assets(rel):
    return {a["name"]: a for a in rel["assets"]}


def upload(rel, path: Path, name: str):
    """Uploads go to uploads.github.com, which does not speak JSON body."""
    upload_url = rel["upload_url"].split("{")[0]
    req = urllib.request.Request(
        f"{upload_url}?name={urllib.request.quote(name)}", method="POST",
        data=path.read_bytes(),
        headers={"Authorization": f"Bearer {token()}",
                 "Accept": "application/vnd.github+json",
                 "Content-Type": "application/pdf",
                 "Content-Length": str(path.stat().st_size)})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def download(asset, dest: Path):
    req = urllib.request.Request(asset["url"], headers={
        "Authorization": f"Bearer {token()}",
        "Accept": "application/octet-stream"})
    with urllib.request.urlopen(req) as r, dest.open("wb") as f:
        f.write(r.read())


def delete(asset):
    api(f"/releases/assets/{asset['id']}", method="DELETE")


def main():
    dry = "--dry-run" in sys.argv
    rel = release()
    have = assets(rel)
    print(f"release {TAG}: {len(have)} assets")

    # 1. publish the repository's own books and papers
    for relpath, name in UPLOADS.items():
        f = ROOT / relpath
        if not f.exists():
            print(f"  ! missing {relpath}")
            continue
        if name in have:
            print(f"  = {name} already published ({have[name]['size']:,} B)")
            continue
        print(f"  + {name}  {f.stat().st_size:,} B")
        if not dry:
            upload(rel, f, name)

    # 2. rename the working names
    rel = release()
    have = assets(rel)
    for old, new in RENAMES.items():
        if old not in have or new in have:
            continue
        print(f"  → {old} becomes {new}  {have[old]['size']:,} B")
        if dry:
            continue
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td) / new
            download(have[old], tmp)
            upload(rel, tmp, new)
            tmp.unlink(missing_ok=True)
        delete(have[old])
        rel = release()
        have = assets(rel)

    print("\nfinal assets:")
    for a in sorted(release()["assets"], key=lambda a: a["name"]):
        print(f"  {a['name']:58s} {a['size']:>10,} B")


if __name__ == "__main__":
    main()
