#!/usr/bin/env python3
"""scripts/cf_probe.py — is this token valid, and where does it stop? Read-only, by construction.

Why: a migration dies at the credential more often than anywhere else, and the API answers with five
different codes for three different problems. A `code 1000 Invalid API Token` from /user/tokens/verify
is even returned by a perfectly working account-scoped token, because that endpoint wants user-level
auth — which is exactly how one bad diagnosis got written down here on 2026-10-13 and had to be
undone. So this asks each surface separately and says which answer it got.

    python3 scripts/cf_probe.py --token-file ~/.secrets/cf_token
    python3 scripts/cf_probe.py --token cfut_… --account 6527…
    python3 scripts/cf_probe.py … --allow-write --namespace <id>   # the only way to tell "no
                                                                    # permission" from "no budget"

Nothing else here mutates anything; --allow-write puts one probe key and deletes it.
"""
import argparse, json, os, sys, urllib.error, urllib.request

API = os.environ.get("CF_API_BASE", "https://api.cloudflare.com/client/v4")


def call(tok, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={"Authorization": "Bearer " + tok,
                                          "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or b"{}"), 0
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return json.loads(raw or "{}"), e.code
        except Exception:
            return {"success": False, "errors": [{"code": None, "message": raw[:160]}]}, e.code
    except Exception as e:  # network, DNS, TLS
        return {"success": False, "errors": [{"code": None, "message": str(e)[:160]}]}, 0


def verdict(d, http):
    """Name the failure by its shape, because the shape is the whole difference between
    're-make the token', 'add a permission' and 'wait until midnight UTC'."""
    if d.get("success"):
        return "ok"
    errs = d.get("errors") or [{}]
    e = errs[0]
    code, msg = e.get("code"), (e.get("message") or "")
    if code == 9106 or "not allowed to perform this action" in msg:
        return "BLOCKED-BY-IP  the token is live but pinned to another source address"
    if code == 9109 and "Invalid access token" in msg:
        return "UNKNOWN-SECRET  Cloudflare does not know this string at all (wrong field, deleted, or truncated)"
    if code == 9109:
        return "NOT-SCOPED  valid token, this account is not in its Account Resources"
    if code == 1000 and "Invalid API Token" in msg:
        return "NO-USER-AUTH  (expected on /user/tokens/verify for an account-scoped token: it proves nothing)"
    if code == 10000:
        return "AUTH-LAYER  rejected at the resource layer: %s" % msg
    if code in (1003, 7003) or "exceeded" in msg.lower() or "quota" in msg.lower() or "not allowed" in msg.lower():
        return "QUOTA/PLAN  %s (%s)" % (msg, code)
    return "OTHER  HTTP %s code %s: %s" % (http, code, msg)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", default="")
    ap.add_argument("--token-file", default="")
    ap.add_argument("--account", default="")
    ap.add_argument("--allow-write", action="store_true")
    ap.add_argument("--namespace", default="")
    a = ap.parse_args()
    tok = a.token
    if not tok:
        f = os.path.expanduser(a.token_file or "~/.secrets/cf_token")
        if not os.path.exists(f):
            sys.exit("no token: --token or a readable --token-file (%s was not there)" % f)
        tok = open(f).read().strip()
    print("token  %s…%s  (%d chars)" % (tok[:5], tok[-4:], len(tok)))
    acct = a.account or os.environ.get("CF_ACCOUNT") or ""
    rows = [("account list", "/accounts"), ("old-or-named account", "/accounts/%s" % acct if acct else None),
            ("KV namespaces", "/accounts/%s/storage/kv/namespaces?per_page=5" % acct if acct else None),
            ("Workers", "/accounts/%s/workers/scripts" % acct if acct else None),
            ("Pages projects", "/accounts/%s/pages/projects" % acct if acct else None),
            ("user (not needed)", "/user")]
    # A token that can list *an* account is not a token that can act on *this* one, and a migration
    # script that treats those as the same answer is how a deploy walks into the wrong account. So the
    # verdict is held per row and the exit code is decided by the two surfaces the move needs.
    ok_rows, seen = {}, False
    for label, path in rows:
        if not path:
            print("  %-20s skipped — no --account given" % label)
            continue
        d, http = call(tok, "GET", path)
        v = verdict(d, http)
        if v == "ok":
            r = d.get("result")
            n = len(r) if isinstance(r, list) else 1
            print("  %-20s %s  (n=%d)" % (label, v, n))
            seen = True
            ok_rows[label] = True
        else:
            print("  %-20s %s" % (label, v))
            ok_rows[label] = False
    if a.allow_write and a.namespace and acct:
        key = "zz-probe:" + str(int(__import__("time").time()))
        d, http = call(tok, "PUT", "/accounts/%s/storage/kv/namespaces/%s/values/%s" % (acct, a.namespace, key), "1")
        v = verdict(d, http)
        print("  %-20s %s" % ("KV write (probe)", v))
        if v == "ok":
            call(tok, "DELETE", "/accounts/%s/storage/kv/namespaces/%s/values/%s" % (acct, a.namespace, key))
            print("       probe key written and deleted again")
    elif a.namespace:
        print("  %-20s not attempted: it writes, and --allow-write was not passed" % "KV write (probe)")
    need = [ok_rows.get("KV namespaces"), ok_rows.get("Workers")]
    if acct and not all(need):
        print("\n  → the credential may be alive, but it cannot act on %s:" % acct)
        print("    KV namespaces: %s | Workers: %s" % ("ok" if need[0] else "no", "ok" if need[1] else "no"))
        print("    Either its Account Resources do not include that account, or the scope list was")
        print("    never saved. Nothing else in this report changes that: /accounts working only means")
        print("    the string is a real token belonging to some account.")
        sys.exit(1)
    if not seen:
        print("\n  → this token cannot read anything it was asked about: the string is not a token")
        print("    Cloudflare knows. Fix the credential before running a migration.")
        sys.exit(1)


main()
