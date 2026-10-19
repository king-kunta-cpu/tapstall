#!/usr/bin/env python3
"""Push a Cloudflare Worker (ES module + static assets) using only the API.

  python3 cf_publish.py <worker-name> <bundle-dir> <kv:NAME:id> [kv:NAME:id ...]

Reads CF_TOKEN / CF_ACCOUNT from the environment or .secrets/. No wrangler, no
login, no npm install. scripts/deploy.sh prefers wrangler (it owns the upload
format and the schedule) and falls back to this when node_modules is absent.
"""
import base64
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
CRON = "15 6,12,18,0 * * *"
COMPAT_DATE = os.environ.get("COMPAT_DATE", "2025-06-01")
CT = {
    ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
    ".css": "text/css", ".json": "application/json", ".csv": "text/csv",
    ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
    ".txt": "text/plain", ".webp": "image/webp", ".woff2": "font/woff2",
}


def secret(name, fname):
    v = os.environ.get(name)
    if v:
        return v.strip()
    for cand in (os.path.join(".secrets", fname), os.path.join("..", ".secrets", fname)):
        if os.path.exists(cand):
            return open(cand).read().strip()
    sys.exit(f"missing {name} (env or .secrets/{fname})")


def api(method, path, data=None, headers=None, token=None):
    req = urllib.request.Request(
        API + path, data=data, method=method,
        headers={"Authorization": f"Bearer {token}", **(headers or {})})
    try:
        raw = urllib.request.urlopen(req, timeout=120).read().decode()
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:800]
        print(f"HTTP {e.code} on {method} {path}\n{body}")
        raise SystemExit(1)
    try:
        j = json.loads(raw)
    except json.JSONDecodeError:
        return {"raw": raw[:200]}
    if j.get("success") is False:
        print("Cloudflare errors:", json.dumps(j.get("errors"))[:900])
        raise SystemExit(1)
    return j


def form(fields, files):
    b = "----tapstall" + os.urandom(8).hex()
    out = b""
    for k, v in fields.items():
        out += f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    for k, (fn, blob, ctype) in files.items():
        out += f'--{b}\r\nContent-Disposition: form-data; name="{k}"; filename="{fn}"\r\n'.encode()
        out += f"Content-Type: {ctype}\r\n\r\n".encode() + blob + b"\r\n"
    out += f"--{b}--\r\n".encode()
    return out, b


def manifest_for(assets_dir):
    """Write .cf-worker-assets.json exactly as the runtime expects it."""
    entries, files = {}, {}
    for dp, _, fs in os.walk(assets_dir):
        for f in fs:
            if f.startswith("."):
                continue
            p = os.path.join(dp, f)
            rel = "/" + os.path.relpath(p, assets_dir).replace(os.sep, "/")
            blob = open(p, "rb").read()
            h = hashlib.sha256(blob).digest()
            entries[rel] = {
                "contentType": CT.get(os.path.splitext(f)[1], "application/octet-stream"),
                "etag": hashlib.sha1(blob).hexdigest(),
                "integrity": "sha256-" + base64.b64encode(h).decode(),
                "size": len(blob),
            }
            files[rel] = (os.path.basename(p), blob, entries[rel]["contentType"])
    ordered = {k: entries[k] for k in sorted(entries)}
    return ordered, files


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    name, bundle, *kvs = sys.argv[1:]
    token = secret("CF_TOKEN", "cf_token")
    acct = secret("CF_ACCOUNT", "cf_account")
    script = os.path.join(bundle, "worker.js")
    if not os.path.exists(script):
        sys.exit(f"no {script} — run scripts/build_bundle.sh first")

    bindings = []
    for spec in kvs:
        kind, binding, nsid = spec.split(":")
        if kind == "kv":
            bindings.append({"type": "kv_namespace", "name": binding, "namespace_id": nsid})
    # The canonical origin is a plain-text binding too: a publisher that only
    # knows KV bindings would silently drop it, and mail built from "today's"
    # host would lose the public URL.
    origin = os.environ.get("PUBLIC_ORIGIN", "").strip()
    if origin:
        bindings.append({"type": "plain_text", "name": "PUBLIC_ORIGIN", "text": origin})

    assets_dir = os.path.join(bundle, "assets")
    metadata = {
        "workers_dev": True,                     # the *.workers.dev route
        "compatibility_date": COMPAT_DATE,
        "compatibility_flags": ["nodejs_compat"],
        "main_module": "worker.js",
        "triggers": {"crons": [CRON]},
        "bindings": bindings,
        "observability": {"enabled": True, "head_sampling_rate": 1},
    }

    afiles = {}
    if os.path.isdir(assets_dir):
        # Those files are the GitHub Pages mirror, not the Worker's pages: since v0.9.1 every
        # page a merchant is served is a bundle constant (INLINED_PAGES), which costs no KV write
        # and cannot lag the deploy. The assets dir stays in the build because CI uploads it.
        print("note: %d asset file(s) in %s are the Pages mirror; the Worker's pages are inlined"
              % (sum(len(f) for _, _, f in os.walk(assets_dir)), assets_dir))
    md = dict(metadata)
    files = {"data": ("worker.js", open(script, "rb").read(), "application/javascript+module")}
    body, boundary = form({"metadata": json.dumps(md)}, files)
    res = api("PUT", f"/accounts/{acct}/workers/scripts/{name}", body,
              {"Content-Type": f"multipart/form-data; boundary={boundary}"}, token)
    ver = (res.get("result") or {}).get("version_id", "?")
    print("deployed %s (version %s, %d binding(s), no assets binding)" % (name, ver, len(bindings)))

    # The schedule ships inside the upload above: PUT .../cron_triggers rejects
    # both JSON and metadata-only multipart for an API-token deploy (it insists on
    # a script body), so a separate call is a dead end — verify instead:
    #   GET /__selftest -> cron_heartbeat.minutes_ago


if __name__ == "__main__":
    main()
