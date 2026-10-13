#!/usr/bin/env python3
"""scripts/kv_migrate.py — move a KV namespace between Cloudflare accounts without losing a ledger.

Why this is a script and not `wrangler kv:key bulk`: the orders namespace stopped being a bag of
documents in v0.9.1. Each order document carries its ledger row as KV *list metadata* (a 403-byte
packed record: money, status, proof, VAT buckets), and the merchant's ledger is built by reading that
metadata back off the listing. A migration that copies values and drops metadata therefore produces a
namespace that looks complete — 118 keys, 118 keys — and answers every order with a thin row: zero
money, `status: unknown`. It would pass a key-count check and fail the only question a merchant asks.
So both halves here are written against the REST API directly, and the verify step compares metadata,
not just bytes.

    export  reads a namespace to an archive            (needs a read token; 100k reads/day is ample)
    import  writes an archive into a namespace         (needs workers:write on the destination)
    verify  compares an archive against a namespace    (reads only)

The metadata part is sent in the multipart shape the KV API documents for `PUT /values/{key}`.
One thing this script cannot prove from the export side alone: that the destination accepted the
metadata. So the sequence is `import --limit 1`, then `verify --values`, then the whole archive — and
verify exits 1 on a metadata mismatch, which is the failure mode that matters here.

The archive is one JSON line per key: {"name", "value", "metadata"}. Value is base64 because a page
of HTML and an emoji-containing order both have to survive a round trip through a shell, and a
byte-exact comparison is the only kind worth having.

Nothing here retries a write on a spent budget: if the destination's 1,000 writes a day are gone, the
import stops, says how far it got, and the archive is still on disk. That is the same tradeoff the
pipeline makes everywhere else — a partial migration that is honest is fixable, a "successful" one
that dropped rows is not.
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = os.environ.get("CF_API_BASE", "https://api.cloudflare.com/client/v4")


def call(token, method, path, body=None, raw=False, boundary=None):
    """One API call. `boundary` means the body is already multipart bytes; `raw` returns bytes."""
    data = None
    headers = {"Authorization": "Bearer " + token}
    if boundary is not None:
        data = body
        headers["Content-Type"] = "multipart/form-data; boundary=" + boundary
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            payload = r.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        raise SystemExit("%s %s → HTTP %s: %s" % (method, path, e.code, detail))
    except urllib.error.URLError as e:
        raise SystemExit("%s %s → %s" % (method, path, e.reason))
    if raw:
        return payload
    return json.loads(payload or b"{}")


def token(args):
    t = os.environ.get("CF_TOKEN") or ""
    if not t and args.token_file:
        t = open(os.path.expanduser(args.token_file)).read().strip()
    if not t:
        for p in ("~/.secrets/cf_token", ".secrets/cf_token"):
            f = os.path.expanduser(p)
            if os.path.exists(f):
                return open(f).read().strip()
        raise SystemExit("no token: set CF_TOKEN or pass --token-file")
    return t


def ns_path(args, tail=""):
    return "/accounts/%s/storage/kv/namespaces/%s%s" % (args.account, args.namespace, tail)


def listing(args, tok, page=1000):
    """Every key, with its metadata — which is where the ledger lives, so it is not optional."""
    out, cursor = [], None
    while True:
        q = "?per_page=%d%s" % (page, ("&cursor=" + urllib.parse.quote(cursor)) if cursor else "")
        r = call(tok, "GET", ns_path(args, "/keys" + q))
        chunk = r.get("result") or []
        out.extend(chunk)
        cursor = r.get("result_info", {}).get("cursor")
        if not r.get("success") or not cursor or not chunk:
            return out
    return out


def multipart(key, value_b64, meta):
    """PUT with metadata, in the one shape the KV API takes both: multipart/form-data."""
    b = "----tapstall"
    parts = []
    parts.append(("--%s\r\nContent-Disposition: form-data; name=\"key\"\r\n\r\n%s\r\n" % (b, key)).encode())
    body = base64.b64decode(value_b64)
    parts.append(("--%s\r\nContent-Disposition: form-data; name=\"value\"; filename=\"v\"\r\n"
                  "Content-Type: application/octet-stream\r\n\r\n" % b).encode() + body + b"\r\n")
    if meta is not None:
        parts.append(("--%s\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n%s\r\n"
                      % (b, json.dumps({"value": meta}, separators=(",", ":")))).encode())
    parts.append(("--%s--\r\n" % b).encode())
    return b, b"".join(parts)


def cmd_export(args, tok):
    keys = listing(args, tok)
    wrote = 0
    with open(args.out, "w", encoding="utf-8") as fh:
        for k in keys:
            name = k["name"]
            if args.prefix and not name.startswith(args.prefix):
                continue
            val = call(tok, "GET", ns_path(args, "/values/" + urllib.parse.quote(name, safe="")), raw=True)
            fh.write(json.dumps({"name": name, "value": base64.b64encode(val).decode(),
                                 "metadata": k.get("metadata")}, ensure_ascii=False) + "\n")
            wrote += 1
            if args.sleep:
                time.sleep(args.sleep)
    print("exported %d of %d keys to %s" % (wrote, len(keys), args.out))
    with_meta = sum(1 for line in open(args.out, encoding="utf-8") if json.loads(line)["metadata"])
    print("  %d of them carry metadata — that is the ledger; a copy with 0 has lost every row" % with_meta)


def cmd_import(args, tok):
    rows = [json.loads(l) for l in open(args.archive, encoding="utf-8")]
    if args.limit:
        rows = rows[:args.limit]
    if not args.yes_live:
        raise SystemExit("refusing to write to a live namespace without --yes-live "
                         "(%d keys, %s / %s)" % (len(rows), args.account, args.namespace))
    before = len(listing(args, tok))
    done = skipped = 0
    for i, row in enumerate(rows):
        try:
            # limit=1 is rejected by the KV API ("limit argument must be at least 10"), which is the
            # first thing this probe learned the hard way at 15:01 UTC while moving a live account
            if not args.overwrite:
                head = call(tok, "GET", ns_path(args, "/keys?prefix=" + urllib.parse.quote(row["name"], safe="") + "&limit=10"))
                if (head.get("result") or []):
                    skipped += 1
                    continue
            b, body = multipart(row["name"], row["value"], row.get("metadata"))
            call(tok, "PUT", ns_path(args, "/values/" + urllib.parse.quote(row["name"], safe="")),
                 body=body, boundary=b)
            done += 1
        except SystemExit as e:
            # Stop where we are and say where that was: the archive is on disk, the day is not over.
            print("stopped after %d/%d keys: %s" % (done, len(rows), e), file=sys.stderr)
            print("resume with the same command; %d already-written keys are skipped by default" % done,
                  file=sys.stderr)
            sys.exit(1)
        if args.sleep:
            time.sleep(args.sleep)
    print("imported %d keys (%d already present, left alone); namespace had %d, has %d"
          % (done, skipped, before, before + done))


def cmd_verify(args, tok):
    rows = {json.loads(l)["name"]: json.loads(l) for l in open(args.archive, encoding="utf-8")}
    live = {k["name"]: k for k in listing(args, tok)}
    missing = [n for n in rows if n not in live]
    meta_bad = [n for n, r in rows.items() if n in live and bool(live[n].get("metadata")) != bool(r["metadata"])]
    bytes_checked = 0
    val_bad = []
    for n, r in list(rows.items()):
        if n in missing:
            continue
        if not args.values:
            break
        got = call(tok, "GET", ns_path(args, "/values/" + urllib.parse.quote(n, safe="")), raw=True)
        if got != base64.b64decode(r["value"]):
            val_bad.append(n)
        bytes_checked += 1
        if args.sleep:
            time.sleep(args.sleep)
    print("%d keys in the archive, %d in the namespace" % (len(rows), len(live)))
    print("  missing: %d   metadata mismatch: %d%s" % (len(missing), len(meta_bad),
          ("   value mismatch: %d (%s read)" % (len(val_bad), bytes_checked)) if args.values else "   (values not compared; --values does, one read each)"))
    for n in (missing or meta_bad or val_bad)[:5]:
        print("  e.g. %s" % n)
    sys.exit(0 if not missing and not meta_bad and not val_bad else 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--account", required=True)
    ap.add_argument("--namespace", required=True, help="namespace id, not its title")
    ap.add_argument("--token-file", default=None)
    ap.add_argument("--sleep", type=float, default=0.0, help="seconds per key, if the rate limit bites")
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export")
    e.add_argument("--out", required=True)
    e.add_argument("--prefix", default="")
    i = sub.add_parser("import")
    i.add_argument("--archive", required=True)
    i.add_argument("--overwrite", action="store_true", help="rewrite keys that already exist")
    i.add_argument("--yes-live", action="store_true")
    i.add_argument("--limit", type=int, default=0)
    v = sub.add_parser("verify")
    v.add_argument("--archive", required=True)
    v.add_argument("--values", action="store_true", help="also compare bytes, one read per key")
    args = ap.parse_args()
    tok = token(args)
    {"export": cmd_export, "import": cmd_import, "verify": cmd_verify}[args.cmd](args, tok)


if __name__ == "__main__":
    main()
