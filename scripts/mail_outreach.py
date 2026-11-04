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
import sys as _sys
import base64
import email
import hashlib
import hmac
import email.policy
import email.utils
import imaplib
import json
import os
import re
import smtplib
import time
import ssl
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

ORIGIN_DEFAULT = "https://tapstall.zlnew.workers.dev"
TOUCH_FOLLOW_DAYS = [7, 7, 7]   # outreach v2 (2026-11-04): T1 no link, T2 day 7 (link), T3 day 14, then stop
MAX_TOUCHES = len(TOUCH_FOLLOW_DAYS)
STOP_RE = re.compile(r"\b(stop|unsubscribe|remove me|opt ?out|leave me alone|do not contact)\b", re.I)
SYSTEM_FROM_RE = re.compile(r"(mailer-daemon|postmaster|no-?reply|donotreply|notifications?)@", re.I)
BOUNCE_FROM_RE = re.compile(r"(mailer-?daemon|postmaster|microsoftexchange[0-9a-f]*)@", re.I)
_sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from inbound import classify_inbound   # noqa: E402  shared rules (owner 2026-11-04): a delivery problem is never a stop
# v2.0.0: where the person's own words end. Everything below is the quoted original, which says
# "reply STOP" — reading it as their answer marked every polite reply do-not-contact.
QUOTE_START_RE = re.compile(r"^(>|On .{0,200}wrote:\s*$|-{2,} ?Original Message|From: .+|Sent from my |_{5,})", re.I | re.M)
AUTO_RE = re.compile(r"\b(out of (the )?office|automatic reply|auto-?reply|autoreply|away from (the |my )?(office|desk)|on (annual |parental |maternity )?leave|currently away)\b", re.I)
ADDR_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def unsub_url(origin, secret, lead_id):
    """The Worker's /u/<lead>/<tok> link, derived with the same HMAC (core.js hmacSig) so the
    runner's Gmail touches carry the same one-click unsubscribe as the Worker's own."""
    mac = hmac.new(secret.encode(), ("unsub:" + str(lead_id)).encode(), hashlib.sha256).digest()
    tok = re.sub(r"[^A-Za-z0-9]", "", base64.urlsafe_b64encode(mac).decode().rstrip("=")[:43])[:22]
    return origin.rstrip("/") + "/u/" + str(lead_id) + "/" + tok


def own_words(text):
    m = QUOTE_START_RE.search(text or "")
    return (text or "")[: m.start()] if m else (text or "")


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


def act(origin, secret, lead_id, action, seller_code="", sender="", follow_days=None, why="", msgid=""):
    payload = {"code": "owner", "key": secret, "id": lead_id, "action": action}
    if seller_code:
        payload["as_seller"] = seller_code
    if sender:
        payload["sender"] = sender
    if why:
        payload["why"] = why
    if msgid:
        payload["msgid"] = msgid
    if follow_days:
        payload["follow_days"] = follow_days
    return api(origin, secret, "/api/leads/act", payload)


def eligible(lead, now_iso, box_user=""):
    if not lead.get("email"):
        return False
    if lead.get("status") == "queued":
        return len(lead.get("signals") or []) >= 2
    if lead.get("status") == "contacted":
        if int(lead.get("touches") or 0) >= MAX_TOUCHES:
            return False
        # one voice per thread: a follow-up comes from the box the first touch came from
        last = str(lead.get("last_sender") or "").lower()
        if last and box_user and last != box_user.lower():
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


def compose(lead, origin, from_name, unsub="", kind=""):
    """Outreach v2: T1 carries NO link (the one-click unsubscribe is only in the List-Unsubscribe header);
    T2 (day 7) and T3 (day 14) carry the link; kind="link" is the answer to a real reply."""
    biz = lead.get("business") or "there"
    code = lead.get("seller_code") or ""
    link = origin.rstrip("/") + (("/r/" + code) if code else "/onboard")
    postal = os.environ.get("POSTAL_ADDRESS", "").strip()
    post = ("\n" + postal) if postal else ""
    stop = '\n\nIf you would rather not hear from me again, just reply "stop".'
    subj = f"{biz}: orders that identify their own payment"
    if kind == "link":
        return "Re: " + subj, (f"Thank you for writing back. Here is the link: {link}\n\nYour menu on one page, payment straight "
                               "to your own account, and an exact amount per order so the payment tells you which order it is. Free for "
                               f"60 days, then USD 60 a year. No commission on your sales.\n\nAny question, just reply here.\n\n{from_name}")
    touch = min(int(lead.get("touches") or 0), MAX_TOUCHES - 1)
    if touch == 0:
        return subj, (f"Hi {biz} team,\n\n{evidence_line(lead)} Can I ask about a moment most shops here know too well? A customer "
                      'sends a screenshot that says "paid", you hand over the order, and the money never arrives. Or twenty payments '
                      "land in one evening and you sit up late matching amounts to names.\n\nTapstall is built so that moment stops "
                      "happening. Customers pick from your menu on one page and pay your own EcoCash, PayShap or bank account, and every "
                      "order carries its own amount down to the cent, so the money that lands tells you exactly which order it is. A "
                      "screenshot proves nothing; the payment does.\n\nIt is free for 60 days, then USD 60 a year. No commission on your "
                      f"sales and no order cap.\n\nWould it help if I sent you the link to try it? Just reply and I will.\n\n{from_name}{post}{stop}")
    if touch == 1:
        return "Re: " + subj, (f"Hi again,\n\nRather than ask twice, I made something for {biz}: the attached one-page guide to "
                               "ending fake proof of payment. It shows how the fakes usually happen, five checks to make before you "
                               "hand over goods, and how to set up a shop page where every order carries its own exact amount. The "
                               "checks work even if you never use Tapstall.\n\nWhen you want the money to tell you which order it is, "
                               f"here is the link: {link}\n\nIt takes about two minutes to set up and is free for 60 days. No commission "
                               f"on your sales.\n\n{from_name}{post}{stop}")
    return "Re: " + subj, (f"Last note from me, and thank you for reading. If taking orders on WhatsApp ever starts costing {biz} "
                           f"sales or disputes, your shop page can be live in a few minutes: {link}\n\nI will not write again.\n\n{from_name}{post}")


def guide_pdf(lead, origin):
    """The T2 attachment (owner 2026-11-04): the same one-page guide the Worker attaches (worker/mail.js v2Guide)."""
    from jl_pdf import make_pdf
    biz = (lead.get("business") or "").strip() or "your shop"
    code = lead.get("seller_code") or ""
    link = origin.rstrip("/") + (("/r/" + code) if code else "/onboard")
    postal = os.environ.get("POSTAL_ADDRESS", "").strip()
    slug = re.sub(r"[^a-z0-9]+", "-", biz.lower()).strip("-")[:40] or "shop"
    day = time.strftime("%Y-%m-%d", time.gmtime())
    pdf = make_pdf(
        title=f"{biz}: ending fake proof of payment",
        subtitle=f"A one-page guide made for {biz}, {day}. From Tapstall, a Jacaranda Labs venture.",
        accent="#0b6e4f",
        sections=[
            {"heading": "How fake proof of payment happens", "bullets": [
                "An edited or recycled screenshot of a payment that never reached your account.",
                'A forwarded or typed-out "payment SMS" that did not come from your provider.',
                "A real payment for a smaller amount, or one already used for another order.",
                "Twenty payments landing in an hour, and no quick way to tell which one is whose."]},
            {"heading": "Five checks before you hand over goods", "bullets": [
                "Check your own account, or the SMS your provider sent you; never only the customer's screenshot.",
                "Match the exact amount, cents included.",
                "Match the sender name or reference, and the time.",
                "A payment you cannot find yet is not received, however urgent the customer sounds.",
                "Mark each payment as used for one order, so it cannot be claimed twice."]},
            {"heading": "How Tapstall makes the money tell you", "paras": [
                "Customers order from your menu on one page and pay straight into your own EcoCash, PayShap or bank account; "
                "Tapstall never holds your money. Every order gets its own exact amount, down to the cent, so the payment that "
                "lands tells you which order it is. A screenshot proves nothing; the payment does."]},
            {"heading": "Set up in about two minutes", "bullets": [
                "Add your menu: names and prices.", "Add the account your customers pay into.",
                "Share your one link on your WhatsApp status, your bio and your groups."]},
            {"paras": [f"Free for 60 days, then USD 60 a year (or USD 7 a month). No commission on your sales and no order cap. Start here: {link}"]},
        ],
        footer="Tapstall, Jacaranda Labs" + (f" - {postal}" if postal else ""))
    return f"tapstall-guide-{slug}.pdf", pdf


SOFT_REFUSAL_RE = re.compile(r"\b(5\.2\.2|4\.\d\.\d+)\b|mailbox (is )?full|over (the )?quota|quota exceeded|insufficient (storage|space)|temporar", re.I)


def refusal_why(exc):
    """A recipient refused at send: full / temporary is undeliverable (never a stop, never a bounce); else a bounce."""
    try:
        codes = [(int(c), (m.decode("utf-8", "replace") if isinstance(m, bytes) else str(m))) for c, m in exc.recipients.values()]
    except Exception:
        codes = []
    soft = any(c < 500 or SOFT_REFUSAL_RE.search(f"{c} {m}") for c, m in codes)
    return "undeliverable" if soft else "bounce"


def send_smtp(mailbox, to_addr, subject, body, from_name, unsub="", in_reply_to="", attachments=()):
    if mailbox.get("smtp") is False:
        raise RuntimeError("poll-only mailbox")     # a Worker-only lane is the Worker's to send on
    msg = EmailMessage()
    msg["From"] = f"{from_name} <{mailbox['user']}>"
    msg["To"] = to_addr
    msg["Reply-To"] = mailbox["user"]
    msg["Subject"] = subject
    msg["Message-ID"] = email.utils.make_msgid(domain=mailbox["user"].split("@")[-1])
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = in_reply_to
    if unsub:
        msg["List-Unsubscribe"] = f"<{unsub}>"
        msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
    msg.set_content(body)
    for name, data in attachments or ():          # the day-7 guide: multipart/mixed, the plain text first
        msg.add_attachment(data, maintype="application", subtype="pdf", filename=name)
    password = str(mailbox["app_password"]).replace(" ", "")
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30, context=ssl.create_default_context()) as s:
        s.login(mailbox["user"], password)
        s.send_message(msg)
    return msg["Message-ID"]


def classify_reply(from_addr, text, subject="", headers=None):
    """-> dnc (a person said stop) | undeliverable (full/unavailable/unmonitored/left: end quietly, counts as
    nothing) | ignore (robots, out-of-office) | replied. Delivery reports are never read for "stop"."""
    if SYSTEM_FROM_RE.search(from_addr or ""):
        return "ignore"
    kind, _ = classify_inbound(from_addr, subject, text, headers)
    if kind == "stop":
        return "dnc"
    if kind in ("soft", "gone"):
        return "undeliverable"
    if kind in ("auto", "bounce"):
        return "ignore"   # out-of-office: the sequence carries on
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


def bounced_addresses(msg, text):
    """Recipients a delivery-failure report names: the header if the server sets one, else
    every address in the report (matched against our leads by the caller)."""
    out = set()
    for h in ("X-Failed-Recipients", "Final-Recipient", "Original-Recipient"):
        for v in msg.get_all(h) or []:
            out.update(a.lower() for a in ADDR_RE.findall(str(v)))
    if not out:
        out.update(a.lower() for a in ADDR_RE.findall(text or ""))
    return out


def poll_mailbox(origin, secret, mailbox, leads_by_email, seller_code, counts, dry=False):
    """Read-only, always. The Gmail box is shared (the Worker's merchant mail and, while one test
    Gmail serves several businesses, other products), so this never marks anything read and
    never moves a message. Re-reading is harmless: a lead that already replied or was marked dnc
    is no longer in leads_by_email, so the same message cannot act twice."""
    password = str(mailbox["app_password"]).replace(" ", "")
    imap = imaplib.IMAP4_SSL(mailbox.get("imap_host") or "imap.gmail.com", 993, timeout=30)
    try:
        imap.login(mailbox["user"], password)
        imap.select("INBOX", readonly=True)
        since = (datetime.now(timezone.utc) - timedelta(days=4)).strftime("%d-%b-%Y")
        typ, data = imap.search(None, "SINCE", since)
        ids = (data[0].split() if typ == "OK" and data and data[0] else [])[-200:]
        for mid in ids:
            typ, hdr = imap.fetch(mid, "(BODY.PEEK[HEADER.FIELDS (FROM)])")
            if typ != "OK" or not hdr or not hdr[0]:
                continue
            from_addr = email.utils.parseaddr(email.message_from_bytes(hdr[0][1]).get("From") or "")[1].lower()
            is_bounce = bool(BOUNCE_FROM_RE.search(from_addr))
            if not is_bounce and from_addr not in leads_by_email:
                continue                     # not ours: a support ticket, another product's mail
            typ, parts = imap.fetch(mid, "(BODY.PEEK[])")
            if typ != "OK" or not parts or not parts[0]:
                continue
            raw = parts[0][1]
            msg = email.message_from_bytes(raw, policy=email.policy.default)
            text = body_text(raw)
            if is_bounce:
                hit = [leads_by_email[a] for a in bounced_addresses(msg, text) if a in leads_by_email]
                dsn_kind, _ = classify_inbound(from_addr, str(msg.get("Subject") or ""), text, msg)
                why = "bounce" if dsn_kind == "bounce" else "undeliverable"   # only a rejected address counts as a bounce
                for lead in hit:
                    if not dry:
                        try:
                            act(origin, secret, lead["id"], "dnc", seller_code=lead.get("seller_code") or seller_code, sender=mailbox["user"], why=why)
                        except Exception:
                            counts["act_errors"] = counts.get("act_errors", 0) + 1
                            continue
                    leads_by_email.pop(str(lead.get("email") or "").lower(), None)
                    counts["bounced_dnc" if why == "bounce" else "undeliverable"] = counts.get("bounced_dnc" if why == "bounce" else "undeliverable", 0) + 1
                continue
            lead = leads_by_email.get(from_addr)
            kind = classify_reply(from_addr, text, str(msg.get("Subject") or ""), msg)
            if lead and kind == "undeliverable":
                if not dry:
                    try:
                        act(origin, secret, lead["id"], "dnc", seller_code=lead.get("seller_code") or seller_code,
                            sender=mailbox["user"], why="undeliverable")
                    except Exception:
                        counts["act_errors"] = counts.get("act_errors", 0) + 1
                        continue
                leads_by_email.pop(from_addr, None)
                counts["undeliverable"] = counts.get("undeliverable", 0) + 1
                continue
            if lead and kind in ("dnc", "replied"):
                if not dry:
                    try:
                        act(origin, secret, lead["id"], kind,
                            seller_code=lead.get("seller_code") or seller_code, sender=mailbox["user"])
                    except Exception:
                        counts["act_errors"] = counts.get("act_errors", 0) + 1
                        continue
                leads_by_email.pop(from_addr, None)
                counts["replies_" + kind] = counts.get("replies_" + kind, 0) + 1
                # v2: a seller's lead that replied to the link-free first touch gets the link, once, in-thread,
                # from the seller's own box (house leads: the Worker sends it, flagged by the "replied" act)
                if (kind == "replied" and not dry and lead.get("seller_code") and int(lead.get("touches") or 0) == 1
                        and mailbox.get("smtp") is not False):
                    try:
                        subj, body = compose(lead, origin, os.environ.get("OUTREACH_FROM_NAME", "Tapstall"), kind="link")
                        send_smtp(mailbox, from_addr, subj, body, os.environ.get("OUTREACH_FROM_NAME", "Tapstall"),
                                  in_reply_to=lead.get("first_msgid") or "")
                        counts["link_replies"] = counts.get("link_replies", 0) + 1
                    except Exception:
                        counts["link_reply_errors"] = counts.get("link_reply_errors", 0) + 1
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
    now_iso = datetime.now(timezone.utc).isoformat()
    counts = {"dry_run": dry, "sent": 0, "skipped_no_mailbox": 0, "whatsapp_only_waiting": 0}
    mailboxes = fetch_mailboxes(a.origin, secret)
    leads = fetch_leads(a.origin, secret)
    codes = sorted({l.get("seller_code") for l in leads if l.get("seller_code")})
    by_tag = {m["tag"]: m for m in mailboxes}
    mailbox_for = {}
    for m in [x for x in mailboxes if x.get("smtp") is not False]:
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
            code = lead.get("seller_code") or ""
            if not code:
                continue   # outreach v2: house leads are the Worker's (two boxes, drip, threaded); the runner only reads their replies
            box = mailbox_for.get(code) or (owner_box if fallback else None)
            if not eligible(lead, now_iso, box["user"] if box else ""):
                continue
            if not box:
                counts["skipped_no_mailbox"] += 1
                continue
            if sent_per_box.get(box["user"], 0) >= a.per_mailbox_cap:
                counts["skipped_cap"] = counts.get("skipped_cap", 0) + 1
                continue
            unsub = unsub_url(a.origin, secret, lead["id"])
            subject, body = compose(lead, a.origin, a.from_name, unsub)
            touches = int(lead.get("touches") or 0)
            if not dry:
                # one lead never sinks the run: the Worker refuses junk at claim (422), a mailbox
                # can refuse one address — count it and move on
                try:
                    if lead["status"] == "queued":
                        act(a.origin, secret, lead["id"], "claim", seller_code=code)
                except Exception:
                    counts["refused_at_claim"] = counts.get("refused_at_claim", 0) + 1
                    continue
                try:
                    mid = send_smtp(box, lead["email"], subject, body, a.from_name, unsub,
                                    in_reply_to=(lead.get("first_msgid") or "") if touches else "",
                                    attachments=[guide_pdf(lead, a.origin)] if touches == 1 else ())
                except smtplib.SMTPRecipientsRefused as refused:
                    try:
                        act(a.origin, secret, lead["id"], "dnc", seller_code=code, sender=box["user"], why=refusal_why(refused))
                    except Exception:
                        pass
                    counts["refused_by_server"] = counts.get("refused_by_server", 0) + 1
                    continue
                except Exception as e:
                    counts["send_errors"] = counts.get("send_errors", 0) + 1
                    print(f"send failed ({box['tag']}): {type(e).__name__}", file=sys.stderr)
                    try:
                        act(a.origin, secret, lead["id"], "release", seller_code=code)
                    except Exception:
                        pass
                    continue
                act(a.origin, secret, lead["id"], "contacted", seller_code=code,
                    sender=box["user"], follow_days=TOUCH_FOLLOW_DAYS[min(touches, MAX_TOUCHES - 1)],
                    msgid=mid if not touches else "")
            counts["sent"] += 1
            sent_per_box[box["user"]] = sent_per_box.get(box["user"], 0) + 1

    if not a.send_only:
        by_email = {str(l["email"]).lower(): l for l in leads if l.get("email")
                    and l.get("status") in ("claimed", "contacted")}
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
    assert "Kota Queen" in subject and 'reply "stop"' in body
    assert "http" not in body and "/r/" not in body and "www." not in body, "v2: the first touch carries no link"
    _, b2 = compose({**sample, "touches": 1}, a.origin, "Tino")
    assert "/r/tino-sells" in b2
    _, bl = compose({**sample, "touches": 1}, a.origin, "Tino", kind="link")
    assert "/r/tino-sells" in bl
    assert classify_reply("a@b.com", "Automatic reply: I am out of the office until Monday") == "ignore"
    assert eligible(sample, "2999-01-01T00:00:00+00:00")
    assert not eligible({**sample, "status": "dnc"}, "2999-01-01T00:00:00+00:00")
    assert classify_reply("a@b.com", "Please stop emailing us") == "dnc"
    assert classify_reply("a@b.com", "Sounds good, how do I start?") == "replied"
    assert classify_reply("mailer-daemon@googlemail.com", "Delivery Status Notification") == "ignore"
    assert tag_of("tino-sells") == "TINOSELLS"
    assert code_for_tag("TINOSELLS", ["tino-sells"]) == "tino-sells"
    # v2.0.0: a polite reply that quotes our footer is a reply, not an opt-out
    quoted = "Yes please, send details.\n\nOn Mon, 27 Oct 2026, Tapstall <x@gmail.com> wrote:\n> Reply STOP and we will not write again."
    assert classify_reply("a@b.com", quoted) == "replied", own_words(quoted)
    assert classify_reply("a@b.com", "STOP\n\n> earlier text") == "dnc"
    # follow-ups stay in one voice
    c = {**sample, "status": "contacted", "touches": 1, "next_follow_at": "2000-01-01", "last_sender": "second.box@gmail.com"}
    assert not eligible(c, "2999-01-01T00:00:00+00:00", "me@gmail.com")
    assert eligible(c, "2999-01-01T00:00:00+00:00", "second.box@gmail.com")
    # the unsubscribe link matches the Worker's HMAC shape and is on every touch
    u = unsub_url("https://t.example", "test-secret", "ld-test")
    assert re.match(r"^https://t\.example/u/ld-test/[A-Za-z0-9]{22}$", u), u
    for t in range(3):
        _, b = compose({**sample, "touches": t}, a.origin, "Tino", u)
        assert u not in b, "v2: the unsubscribe URL rides in the List-Unsubscribe header, not the body"
    import email as _e
    rep = _e.message_from_string("From: mailer-daemon@googlemail.com\nX-Failed-Recipients: Gone@Shop.co.zw\n\nfailed")
    assert bounced_addresses(rep, "failed") == {"gone@shop.co.zw"}
    import json as _json
    _fx = _json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "inbound.fixtures.json")))
    for f in _fx:
        assert classify_inbound(f["from"], f["subject"], f["text"], f.get("headers"))[0] == f["kind"], f["name"]
    assert classify_reply("info@firm.co.zw", "No longer monitored. Write to accounts@firm.co.zw") == "undeliverable"
    # owner 2026-11-04: T1 link-free and attachment-free; T2 carries the guide; a full mailbox refused at send is not a stop
    _n, _pdf = guide_pdf({"business": "Kota Queen"}, "https://tapstall.example")
    assert _n == "tapstall-guide-kota-queen.pdf" and _pdf.startswith(b"%PDF-1.4") and b"Kota Queen: ending fake proof of payment" in _pdf
    _s1, _b1 = compose({"business": "Kota Queen", "touches": 0}, "https://tapstall.example", "Tino")
    assert "http" not in _b1 and 'screenshot that says "paid"' in _b1
    _s2, _b2 = compose({"business": "Kota Queen", "touches": 1}, "https://tapstall.example", "Tino")
    assert "attached one-page guide" in _b2
    _e = smtplib.SMTPRecipientsRefused({"a@b.co": (452, b"4.2.2 The email account that you tried to reach is over quota")})
    assert refusal_why(_e) == "undeliverable"
    assert refusal_why(smtplib.SMTPRecipientsRefused({"a@b.co": (550, b"5.1.1 The email account does not exist")})) == "bounce"
    assert refusal_why(smtplib.SMTPRecipientsRefused({"a@b.co": (552, b"5.2.2 mailbox full")})) == "undeliverable"
    print("SELFTEST OK — compose, eligibility, reply classes, mailbox tags, quotes, one voice, unsubscribe, bounces")
    return 0


if __name__ == "__main__":
    sys.exit(main())
