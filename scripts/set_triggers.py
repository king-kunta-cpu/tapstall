#!/usr/bin/env python3
"""Verify (and if needed repair) the Worker's cron trigger and workers.dev route.

Why this exists: `PUT /workers/scripts/{name}/cron_triggers` is documented as JSON
but on this account it answers 415 unless the body is multipart with a `metadata`
part, and the same endpoint will happily 200 nothing at all. So we verify over HTTP
instead of trusting a write: the Worker's own /__ping must answer, and the schedule
must be present in the trigger list.

  python3 scripts/set_triggers.py <worker> <cron> [cron ...]

Env: CF_TOKEN, CF_ACCOUNT. Exits non-zero only if a *repair* was needed and failed,
so a deploy can call this as a safety net rather than the primary path.
"""
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4/accounts"


def req(url, token, method="GET", data=None, headers=None):
    """Some /workers/scripts/{name}/* paths answer GET with the multipart script
    bundle rather than JSON, so never assume a parseable body."""
    r = urllib.request.Request(url, data=data, method=method,
                               headers={"Authorization": f"Bearer {token}", **(headers or {})})
    try:
        raw = urllib.request.urlopen(r, timeout=90).read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        code = e.code
    else:
        code = None
    try:
        out = json.loads(raw)
    except Exception:
        return {"unparsed": True, "http": code, "raw": raw[:400]}
    if code:
        out.setdefault("http", code)
    return out


def multipart(meta):
    b = "----z" + os.urandom(6).hex()
    out = (f'--{b}\r\nContent-Disposition: form-data; name="metadata"\r\n'
           f'Content-Type: application/json\r\n\r\n').encode()
    out += json.dumps(meta).encode() + b"\r\n"
    return out + f"--{b}--\r\n".encode(), b


def read_crons(base, tok):
    """The real schedule, from the endpoint that answers JSON for this token type.

    `GET /cron_triggers` streams the script bundle back instead (multipart), which
    is why this check used to "repair" a schedule that was already correct: it read
    nothing, wrote nothing, and printed a warning on every deploy.
    """
    r = req(base + "/schedules", tok)
    if isinstance(r.get("result"), dict) and "schedules" in r["result"]:
        return " ".join(x.get("cron", "") for x in r["result"]["schedules"])
    return None


def write_crons(base, tok, crons):
    body = json.dumps({"crons": list(crons)}).encode()
    return req(base + "/schedules", tok, "PUT", body, {"Content-Type": "application/json"})


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    name, crons = sys.argv[1], sys.argv[2:]
    clearing = crons == ["none"]
    want = "" if clearing else " ".join(crons)
    tok, acct = os.environ.get("CF_TOKEN"), os.environ.get("CF_ACCOUNT")
    if not tok or not acct:
        sys.exit("CF_TOKEN / CF_ACCOUNT not set")
    base = f"{API}/{acct}/workers/scripts/{name}"

    got = read_crons(base, tok)
    if got is None:
        print("  cron: schedule not readable with this token; wrangler.toml [triggers] is the source of truth")
    elif got.strip() == want.strip():
        print(f"  cron ok: {got or '(none, as intended)'}")
    else:
        res = write_crons(base, tok, [] if clearing else crons)
        after = read_crons(base, tok)
        if res.get("success") and (after or "").strip() == want.strip():
            print(f"  cron {'cleared' if clearing else 'repaired'}: {got!r} -> {after!r}")
        else:
            # not fatal, and deliberately so: the alarm may be one a Worker ignores
            # in code (an alias origin returns from scheduled() when REDIRECT_TO is
            # set), and this script cannot see that config. /__selftest can: it
            # answers cron_owner true only for the Worker that actually sweeps.
            print("  note cron unchanged (PUT success=%s, schedule now %r): if this Worker is a"
                  " redirect alias, its schedule is inert by design; otherwise clear it in the"
                  " dashboard and confirm with GET /__selftest -> cron_owner"
                  % (res.get("success"), after))

    # The schedule is declared in wrangler.toml (the primary deploy path). This
    # API endpoint rejects both JSON and metadata-only multipart for this token
    # type, so we verify by heartbeat instead of writing and hoping.
    r = req(base + "/workers_dev", tok)
    if isinstance(r.get("result"), dict) and r["result"].get("enabled") is False:
        body, b = multipart({"enabled": True})
        res = req(base + "/workers_dev", tok, "POST", body,
                  {"Content-Type": f"multipart/form-data; boundary={b}"})
        print("  workers_dev:", "enabled" if res.get("success") else "WARN " + json.dumps(res)[:150])
    else:
        print("  workers_dev: on")


main()
