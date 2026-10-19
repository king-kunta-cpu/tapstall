#!/usr/bin/env python3
"""TapStall outreach runner — sends from the seller's own Gmail, reads replies back.

Design (inherited from the STPi stack, adapted to TapStall's roles):
  - Every seller sends from THEIR OWN Gmail mailbox, connected by a 16-character
    Gmail App Password (2-Step Verification must be on for that Google account).
    The mail lands in their Sent folder and replies land in their inbox — common
    ground with the prospect, and the Activity Ledger records the exact sender.
  - App passwords never live in this repo or in KV. They are Worker secrets named
        GMAIL_<TAG>_USER / GMAIL_<TAG>_APP_PASSWORD
    where TAG is the seller code uppercased with non-letters stripped
    (tino-sells -> TINOSELLS; the house mailbox is OWNER). This runner fetches
    them at runtime from GET /api/outreach/mailboxes behind the admin gate.
  - The Worker remains the judge and the only clock: its cron dispatches this
    workflow (dispatchTick). A lead is eligible only when the Worker's own facts
    say so — queued (2+ signals), or contacted with a follow-up due and fewer
    than 3 touches. DNC and terminal states are never touched, and a reply of
    STOP writes the do-not-contact ledger through the same door as the Sheets bot.
  - WhatsApp-only leads (phone, no email) are counted, never emailed and never
    auto-messaged: cold WhatsApp sending from shared numbers is how numbers die.
    They wait in the seller's queue for a human tap on wa.me.
  - Nothing personal is ever printed to the (public) Actions log: counts only.

Usage:
  python3 scripts/mail_outreach.py --selftest
  TAPSTALL_ORIGIN=... ADMIN_SECRET=... python3 scripts/mail_outreach.py --dry-run
  TAPSTALL_ORIGIN=... ADMIN_SECRET=... python3 scripts/mail_outreach.py --send [--per-mailbox-cap 20]
  ... --poll-only
"""
import argparse
import email
import email.policy
import email.utils
import imaplib
import json
import os
import re
import smtplib
import ssl
import sys
import urllib.parse
import urllib.request
from email.message import EmailMessage

ORIGIN_DEFAULT = "https://tapstall.zlnew.workers.dev"
TOUCH_FOLLOW_DAYS = [3, 5, 7]
MAX_TOUCHES = len(TOUCH_FOLLOW_DAYS)
STOP_RE = re.compile(r"\b(stop|unsubscribe|remove me|opt ?out|leave me alone|do not contact)\b", re.I)
SYSTEM_FROM_RE = re.compile(r"(mailer-daemon|postmaster|no-?reply|donotreply|notifications?)@", re.I)


def api(origin, secret, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        origin.rstrip("/") + path, data=data,
        headers={"Content-Type": "application/json", "x-tapstall-admin": secret,
                 "x-tapstall-confirm": "1", "User-Agent": "tapstall-mail-outreach/1.1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def tag_of(code):
    return re.sub(r"[^A-Z0-9]", "", str(code or "").upper())


def code_for_tag(tag, codes):
    if tag == "OWNER":
        return ""
    for c in codes:
        if re.sub(r"[^A-Z0-9]", "", str(c).upper()) == tag:
            return c
    return None


def fetch_mailboxes(origin, secret):
    try:
        res = api(origin, secret, "/api/outreach/mailboxes")
        return res.get("mailboxes") or []
    except Exception:
        if os.environ.get("GMAIL_OWNER_USER") and os.environ.get("GMAIL_OWNER_APP_PASSWORD"):
            return [{"tag": "OWNER", "user": os.environ["GMAIL_OWNER_USER"],
                     "app_password": os.environ["GMAIL_OWNER_APP_PASSWORD"]}]
        raise


def fetch_leads(origin, secret):
    q = urllib.parse.urlencode({"code": "owner", "key": secret})
    req = urllib.request.Request(origin.rstrip("/") + "/api/leads?" + q,
                                 headers={"User-Agent": "tapstall-mail-outreach/1.1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return (json.loads(r.read()).get("leads") or [])


def act(origin, secret, lead_id, action, seller_code="", sender="", follow_days=None):
    payload = {"code": "owner", "key": secret, "id": lead_id, "action": action}
    if seller_code:
        payload["as_seller"] = seller_code
    if sender:
        payload["sender"] = sender
    if follow_days:
        payload["follow_days"] = follow_days
    return api(origin, secret, "/api/leads/act", payload)


def eligible(lead, now_iso):
    if not lead.get("email"):
        return False
    if lead.get("status") == "queued":
        return len(lead.get("signals") or []) >= 2
    if lead.get("status") == "contacted":
        if int(lead.get("touches") or 0) >= MAX_TOUCHES:
            return False
        due = lead.get("next_follow_at") or ""
        return bool(due) and due <= now_iso
    return False


def evidence_line(lead):
    signals = set(lead.get("signals") or [])
    biz = lead.get("business") or "your business"
    if "whatsapp_selling" in signals:
        return f"I came across {biz} taking orders on WhatsApp."
    if "payment_friction" in signals:
        return f"I came across {biz} while looking at how shops here match payments to orders."
    return f"I came across {biz} online."


def compose(lead, origin, from_name):
    biz = lead.get("business") or "there"
    code = lead.get("seller_code") or ""
    link = origin.rstrip("/") + (("/r/" + code) if code else "/onboard")
    touch = min(int(lead.get("touches") or 0), MAX_TOUCHES - 1)
    subjects = [
        f"{biz} — orders that identify their own payment",
        f"Following up — {biz} on Tapstall",
        f"Last note from me — {biz}",
    ]
    bodies = [
        (f"Hi {biz} team,\n\n{evidence_line(lead)} Tapstall gives a shop like yours one "
         "link: customers pick from your menu, pay your own EcoCash/PayShap/bank account, and every "
         "order carries a unique amount down to the cent — so the money that lands identifies the "
         "order, no screenshots to argue about.\n\nIt is free for 60 days, then USD 60/year "
         "(or USD 7/month). No commission on your sales, no order cap.\n\n"
         f"Start here: {link}\n\n— {from_name}, Tapstall\n"
         "If this is not for you, reply STOP and we will not contact you again."),
        (f"Hi again,\n\nShort version: your menu on one link, payment straight to your own "
         "account, and an exact amount per order so fake proof-of-payment stops working. "
         f"Free for 60 days:\n{link}\n\n— {from_name}\nReply STOP to opt out."),
        (f"Hi — last note from me. If order-taking on WhatsApp ever starts costing you sales "
         f"or disputes, your shop link can be live in about two minutes:\n{link}\n\n— {from_name}"),
    ]
    return subjects[touch], bodies[touch]


def send_smtp(mailbox, to_addr, subject, body, from_name):
    msg = EmailMessage()
    msg["From"] = f"{from_name} <{mailbox['user']}>"
    msg["To"] = to_addr
    msg["Reply-To"] = mailbox["user"]
    msg["Subject"] = subject
    msg.set_content(body)
    password = str(mailbox["app_password"]).replace(" ", "")
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30, context=ssl.create_default_context()) as s:
        s.login(mailbox["user"], password)
        s.send_message(msg)


def classify_reply(from_addr, text):
    if SYSTEM_FROM_RE.search(from_addr or ""):
        return "ignore"
    if STOP_RE.search(text or ""):
        return "dnc"
    return "replied"   # any human answer stops the machine; a person takes it from here


def body_text(msg_bytes):
    msg = email.message_from_bytes(msg_bytes, policy=email.policy.default)
    try:
        body = msg.get_body(preferencelist=("plain", "html"))
        if body is not None:
            return body.get_content()[:4000]
    except Exception:
        pass
    return ""


def poll_mailbox(origin, secret, mailbox, leads_by_email, seller_code, counts, dry=False):
    password = str(mailbox["app_password"]).replace(" ", "")
    imap = imaplib.IMAP4_SSL("imap.gmail.com", 993, timeout=30)
    try:
        imap.login(mailbox["user"], password)
        imap.select("INBOX")
        typ, data = imap.search(None, "UNSEEN")
        ids = (data[0].split() if typ == "OK" and data and data[0] else [])[-50:]
        for mid in ids:
            typ, parts = imap.fetch(mid, "(BODY.PEEK[])")
            if typ != "OK" or not parts or not parts[0]:
                continue
            msg = email.message_from_bytes(parts[0][1], policy=email.policy.default)
            from_addr = email.utils.parseaddr(str(msg.get("From") or ""))[1].lower()
            lead = leads_by_email.get(from_addr)
            kind = classify_reply(from_addr, body_text(parts[0][1]))
            if lead and kind in ("dnc", "replied"):
                if not dry:
                    act(origin, secret, lead["id"], kind,
                        seller_code=lead.get("seller_code") or seller_code, sender=mailbox["user"])
                counts["replies_" + kind] = counts.get("replies_" + kind, 0) + 1
            else:
                counts["replies_unmatched"] = counts.get("replies_unmatched", 0) + 1
            if not dry:
                imap.store(mid, "+FLAGS", "\\Seen")
    finally:
        try:
            imap.logout()
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser(description="TapStall outreach runner (seller Gmail app passwords)")
    ap.add_argument("--origin", default=os.environ.get("TAPSTALL_ORIGIN", ORIGIN_DEFAULT))
    ap.add_argument("--send", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--poll-only", action="store_true")
    ap.add_argument("--send-only", action="store_true")
    ap.add_argument("--per-mailbox-cap", type=int, default=int(os.environ.get("OUTREACH_CAP", "20")))
    ap.add_argument("--from-name", default=os.environ.get("OUTREACH_FROM_NAME", "Tapstall"))
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest(a)
    secret = os.environ.get("ADMIN_SECRET", "")
    if not secret:
        print("ADMIN_SECRET env required", file=sys.stderr)
        return 2
    dry = a.dry_run or not a.send
    from datetime import datetime, timezone
    now_iso = datetime.now(timezone.utc).isoformat()
    counts = {"dry_run": dry, "sent": 0, "skipped_no_mailbox": 0, "whatsapp_only_waiting": 0}
    mailboxes = fetch_mailboxes(a.origin, secret)
    leads = fetch_leads(a.origin, secret)
    codes = sorted({l.get("seller_code") for l in leads if l.get("seller_code")})
    by_tag = {m["tag"]: m for m in mailboxes}
    mailbox_for = {}
    for m in mailboxes:
        code = code_for_tag(m["tag"], codes)
        if code is not None:
            mailbox_for[code] = m
    owner_box = by_tag.get("OWNER")
    fallback = os.environ.get("ALLOW_OWNER_FALLBACK") == "1"

    if not a.poll_only:
        sent_per_box = {}
        for lead in leads:
            if lead.get("status") in ("queued", "contacted") and not lead.get("email") and lead.get("phone"):
                counts["whatsapp_only_waiting"] += 1
            if not eligible(lead, now_iso):
                continue
            code = lead.get("seller_code") or ""
            box = mailbox_for.get(code) or (owner_box if (not code or fallback) else None)
            if not box:
                counts["skipped_no_mailbox"] += 1
                continue
            if sent_per_box.get(box["user"], 0) >= a.per_mailbox_cap:
                counts["skipped_cap"] = counts.get("skipped_cap", 0) + 1
                continue
            subject, body = compose(lead, a.origin, a.from_name)
            touches = int(lead.get("touches") or 0)
            if not dry:
                if lead["status"] == "queued":
                    act(a.origin, secret, lead["id"], "claim", seller_code=code)
                send_smtp(box, lead["email"], subject, body, a.from_name)
                act(a.origin, secret, lead["id"], "contacted", seller_code=code,
                    sender=box["user"], follow_days=TOUCH_FOLLOW_DAYS[min(touches, MAX_TOUCHES - 1)])
            counts["sent"] += 1
            sent_per_box[box["user"]] = sent_per_box.get(box["user"], 0) + 1

    if not a.send_only:
        by_email = {str(l["email"]).lower(): l for l in leads if l.get("email")
                    and l.get("status") in ("claimed", "contacted", "replied", "queued")}
        for m in mailboxes:
            code = code_for_tag(m["tag"], codes)
            try:
                poll_mailbox(a.origin, secret, m, by_email, code or "", counts, dry=dry)
            except Exception as e:  # one bad mailbox never sinks the run; it is counted, not hidden
                counts["mailbox_errors"] = counts.get("mailbox_errors", 0) + 1
                print(f"mailbox poll failed ({m['tag']}): {type(e).__name__}", file=sys.stderr)

    if not dry and owner_box:
        notify = os.environ.get("OWNER_NOTIFY_EMAIL") or owner_box["user"]
        due = sum(1 for l in leads if l.get("next_follow_at") and l["next_follow_at"] <= now_iso
                  and l.get("status") not in ("closed", "dnc"))
        digest = ("Tapstall outreach run\n\n" + json.dumps(counts, indent=1, sort_keys=True)
                  + f"\nleads_total: {len(leads)}\nfollowups_due_at_start: {due}\n"
                  + "\nFull pipeline state (refs to recognise, unmatched Whop payments, expiring shops): owner console → health.")
        try:
            send_smtp(owner_box, notify, f"[Tapstall] outreach {now_iso[:10]} — sent {counts['sent']}", digest, "Tapstall Bot")
            counts["digest_sent"] = 1
        except Exception as e:
            counts["digest_failed"] = type(e).__name__

    print(json.dumps(counts, sort_keys=True))
    return 0


def selftest(a):
    sample = {"id": "ld-test", "business": "Kota Queen", "email": "hi@example.com", "status": "queued",
              "signals": ["email", "whatsapp_selling", "payment_friction"], "seller_code": "tino-sells", "touches": 0}
    subject, body = compose(sample, a.origin, "Tino (Tapstall)")
    assert "Kota Queen" in subject and "/r/tino-sells" in body and "STOP" in body
    assert eligible(sample, "2999-01-01T00:00:00+00:00")
    assert not eligible({**sample, "status": "dnc"}, "2999-01-01T00:00:00+00:00")
    assert classify_reply("a@b.com", "Please stop emailing us") == "dnc"
    assert classify_reply("a@b.com", "Sounds good, how do I start?") == "replied"
    assert classify_reply("mailer-daemon@googlemail.com", "Delivery Status Notification") == "ignore"
    assert tag_of("tino-sells") == "TINOSELLS"
    assert code_for_tag("TINOSELLS", ["tino-sells"]) == "tino-sells"
    print("SELFTEST OK — compose, eligibility, reply classes, mailbox tags")
    return 0


if __name__ == "__main__":
    sys.exit(main())
