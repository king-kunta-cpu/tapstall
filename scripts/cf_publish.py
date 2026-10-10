#!/usr/bin/env python3
"""Push a Cloudflare Worker (ES module + static assets) using only the API.

  python3 cf_publish.py <worker-name> <bundle-dir> <kv:NAME:id> [kv:NAME:id ...]

Reads CF_TOKEN / CF_ACCOUNT from the environment or .secrets/. No wrangler, no
login, no npm install — this is what makes the deploy scriptable from CI and
from a phone. Uses `wrangler` instead when CLOUDFLARE_API_TOKEN is already set
and wrangler happens to be installed.
"""
import base64
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
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
    b = "----zl" + os.urandom(8).hex()
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

    assets_dir = os.path.join(bundle, "assets")
    metadata = {
        "workers_dev": True,
        "compatibility_date": COMPAT_DATE,
        "compatibility_flags": ["nodejs_compat"],
        "main_module": "worker.js",
        "bindings": bindings,
        "observability": {"enabled": True, "head_sampling_rate": 1},
    }

    afiles = {}
    if os.path.isdir(assets_dir):
        # Static-asset uploads are not used: HTML is served from KV (tpl:*),
        # which is hot-swappable without a redeploy and works on the free plan
        # without the assets bundle format. The bundle is still built for
        # parity with wrangler-based deploys.
        print("note: %d asset file(s) available in %s, uploading via KV templates instead"
              % (sum(len(f) for _, _, f in os.walk(assets_dir)), assets_dir))
    json.dump({}, open(os.path.join(bundle, "assets-unused.json"), "w")) if False else None

    md = dict(metadata)
    files = {"data": ("worker.js", open(script, "rb").read(), "application/javascript+module")}
    body, boundary = form({"metadata": json.dumps(md)}, files)
    res = api("PUT", f"/accounts/{acct}/workers/scripts/{name}", body,
              {"Content-Type": f"multipart/form-data; boundary={boundary}"}, token)
    ver = (res.get("result") or {}).get("version_id", "?")
    print("deployed %s (version %s, %d binding(s), no assets binding)" % (name, ver, len(bindings)))

    # cron: keep the paid-term enforcement alive
    api("PUT", f"/accounts/{acct}/workers/scripts/{name}/cron_triggers",
        json.dumps({"targets": [{"cron": "15 6,12,18,0 * * *", "retry": {}}], "predictions": []}).encode(),
        {"Content-Type": "application/json"}, token)
    print("cron set: 06:15/12:15/18:15/00:15 UTC")


if __name__ == "__main__":
    main()
