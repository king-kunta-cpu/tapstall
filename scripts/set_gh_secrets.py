#!/usr/bin/env python3
"""Seed the GitHub repository secrets this project needs, from local files.

  python3 scripts/set_gh_secrets.py [owner/repo]

Reads (env first, then .secrets/ at the repo root):
  GH_TOKEN                repo-scoped PAT with `secrets` write (classic: repo scope)
  CF_TOKEN / .secrets/cf_token
  CF_ACCOUNT / .secrets/cf_account
  ADMIN_SECRET / .secrets/admin_secret

Why a script instead of clicking: the deploy must not need a human, and that
includes the one-time CI wiring. Needs `pip install pynacl` (build tooling only —
nothing in the shipped Worker depends on it).
"""
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

API = "https://api.github.com"


def gh(path, token, method="GET", body=None):
    req = urllib.request.Request(
        API + path, data=json.dumps(body).encode() if body is not None else None,
        method=method, headers={"Authorization": f"Bearer {token}",
                                "Accept": "application/vnd.github+json",
                                "X-GitHub-Api-Version": "2022-11-28"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"message": raw[:200]}


def val(name, fname):
    v = os.environ.get(name, "").strip()
    if v:
        return v
    for cand in (os.path.join(".secrets", fname), os.path.join("..", ".secrets", fname)):
        if os.path.isfile(cand):
            return open(cand).read().strip()
    return ""


def main():
    repo = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("GH_REPO", "king-kunta-cpu/tapstall")
    token = val("GH_TOKEN", "gh_token")
    if not token:
        sys.exit("GH_TOKEN not found (env or .secrets/gh_token)")
    try:
        from nacl import encoding, public
    except ImportError:
        sys.exit("needs pynacl:  python3 -m pip install pynacl")

    st, pk = gh(f"/repos/{repo}/actions/secrets/public-key", token)
    if st != 200:
        sys.exit(f"cannot read the public key ({st}): {pk.get('message')} — does the token have repo/admin scope?")

    wanted = {
        "CLOUDFLARE_API_TOKEN": val("CF_TOKEN", "cf_token"),
        "CLOUDFLARE_ACCOUNT_ID": val("CF_ACCOUNT", "cf_account"),
        "ADMIN_SECRET": val("ADMIN_SECRET", "admin_secret"),
    }
    key = public.PublicKey(pk["key"].encode(), encoding.Base64Encoder)
    for name, value in wanted.items():
        if not value:
            print(f"  skip {name}: not available locally")
            continue
        sealed = public.SealedBox(key).encrypt(value.encode())
        st, res = gh(f"/repos/{repo}/actions/secrets/{name}", token, "PUT",
                     {"key_id": pk["key_id"], "encrypted_value": base64.b64encode(sealed).decode()})
        print(f"  {name}: {'set' if st in (201, 204) else str(st) + ' ' + str(res.get('message'))[:60]}")

    st, res = gh(f"/repos/{repo}/actions/variables", token, "POST",
                 {"name": "WORKER_NAME", "value": os.environ.get("WORKER_NAME", "tapstall")})
    print("  WORKER_NAME variable:", "created" if st == 201 else ("exists" if st == 409 else st))
    # CI needs to be able to write Pages from a workflow
    st, res = gh(f"/repos/{repo}/pages", token, "PUT", {"build_type": "workflow"})
    print("  Pages build source:", "workflow" if st in (201, 204) else f"{st} {res.get('message', '')[:60]}")


main()
