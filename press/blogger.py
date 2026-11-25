#!/usr/bin/env python3
"""The Blogger lane, and the one place every venture sends email from.

Two jobs, one file, because they are the same pipe:

  * `email_pool` — a single sender for the whole estate. Every venture's email
    feature goes through `send()`, so a change of address or password happens
    once, not seven times. Credentials come from env, and default to the shared
    pool account.
  * `blogger` — posts the next unpublished article to a Blogger blog through
    Mail2Blogger (the blog's secret posting address). Blogger turns the email
    into an HTML post, which means the lane needs no OAuth app, no refresh
    token, and no per-blog API client.

Design rules, deliberately:
  * missing credentials are **soft skips**, never failures. If a venture has no
    Mail2Blogger address yet, this exits 0 and says so. Nothing gates on it.
  * it is safe to run on a schedule: an article is only sent once, and the
    record of what shipped lives in press/state/blogger_published.json.
  * no third-party packages. smtplib + stdlib only, so it runs anywhere.

    python3 press/blogger.py --dry-run     # what would go out
    python3 press/blogger.py --once        # send the next one
    python3 press/blogger.py --check       # is the pool configured and reachable
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import smtplib
import ssl
import sys
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
STATE = HERE / "state" / "blogger_published.json"
OUTBOX = [HERE / "auto" / "outbox", HERE / "articles"]

# The estate's shared sending account. Override with EMAIL_POOL_ADDRESS /
# EMAIL_POOL_APP_PASSWORD in the environment or in the repo's secrets.
POOL_ADDRESS = "simalidudu@gmail.com"
POOL_APP_PASSWORD = "mnlr snmq dlqg dsib"
POOL_NAME = "Coldcode SI Labs"
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465


# --------------------------------------------------------------------------- #
# the pool: every venture's email leaves from here
# --------------------------------------------------------------------------- #
class Pool:
    def __init__(self, address: str = "", password: str = "", name: str = "") -> None:
        self.address = (address or os.environ.get("EMAIL_POOL_ADDRESS") or POOL_ADDRESS).strip()
        self.password = (password or os.environ.get("EMAIL_POOL_APP_PASSWORD") or POOL_APP_PASSWORD).replace(" ", "")
        self.name = name or os.environ.get("EMAIL_POOL_NAME") or POOL_NAME

    def configured(self) -> bool:
        return bool(self.address and self.password)

    def send(self, to: str, subject: str, text: str, html_body: str = "") -> dict:
        """Send one message through the pool. Never raises on a missing pool."""
        if not self.configured():
            return {"status": "skipped", "reason": "email pool not configured"}
        if not to:
            return {"status": "skipped", "reason": "no recipient"}
        msg = EmailMessage()
        msg["From"] = f"{self.name} <{self.address}>"
        msg["To"] = to
        msg["Subject"] = subject
        msg.set_content(text)
        if html_body:
            msg.add_alternative(html_body, subtype="html")
        try:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ssl.create_default_context(), timeout=45) as s:
                s.login(self.address, self.password)
                s.send_message(msg)
            return {"status": "sent", "to": to, "from": self.address, "subject": subject}
        except Exception as exc:  # noqa: BLE001 - reported, not raised
            return {"status": "error", "reason": f"{type(exc).__name__}: {exc}", "to": to}


POOL = Pool()


def send(to: str, subject: str, text: str, html_body: str = "") -> dict:
    """The estate's only email sender. Import this; do not open your own SMTP."""
    return POOL.send(to, subject, text, html_body)


def check() -> dict:
    if not POOL.configured():
        return {"status": "unconfigured", "address": POOL.address or "(empty)"}
    try:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ssl.create_default_context(), timeout=30) as s:
            s.login(POOL.address, POOL.password)
        return {"status": "ok", "address": POOL.address}
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "address": POOL.address, "reason": f"{type(exc).__name__}: {exc}"}


# --------------------------------------------------------------------------- #
# the Blogger lane
# --------------------------------------------------------------------------- #
def post_address() -> str:
    return (os.environ.get("BLOGGER_POST_EMAIL") or "").strip()


def blog_url() -> str:
    return (os.environ.get("BLOGGER_BLOG_URL") or "").strip()


def published() -> dict:
    if STATE.exists():
        try:
            return json.loads(STATE.read_text())
        except Exception:  # noqa: BLE001
            return {}
    return {}


def remember(title: str, meta: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    data = published()
    data[title] = meta
    STATE.write_text(json.dumps(data, indent=1, sort_keys=True) + "\n")


def candidates() -> list[Path]:
    seen = published()
    out: list[Path] = []
    for folder in OUTBOX:
        if not folder.is_dir():
            continue
        for path in sorted(folder.glob("*.md")):
            title = title_of(path)
            if title and title not in seen:
                out.append(path)
    return out


def title_of(path: Path) -> str:
    head = path.read_text(encoding="utf-8", errors="replace").splitlines()
    for line in head[:12]:
        if line.startswith("# "):
            return line[2:].strip()
        m = re.match(r"^title:\s*(.+)$", line.strip(), re.I)
        if m:
            return m.group(1).strip().strip('"').strip("'")
    return path.stem.replace("-", " ").replace("_", " ").strip().title()


def to_html(md: str) -> str:
    """Small, dependency-free markdown: headings, bold, italic, links, lists, code, paragraphs."""
    lines = md.splitlines()
    out: list[str] = []
    in_list = False
    in_code = False
    for raw in lines:
        line = raw.rstrip()
        if line.startswith("```"):
            out.append("</pre>" if in_code else "<pre>")
            in_code = not in_code
            continue
        if in_code:
            out.append(html.escape(line))
            continue
        if not line.strip():
            if in_list:
                out.append("</ul>")
                in_list = False
            continue
        if line.startswith("#"):
            level = len(line) - len(line.lstrip("#"))
            text = html.escape(line[level:].strip())
            out.append(f"<h{min(level, 4)}>{text}</h{min(level, 4)}>")
            continue
        if re.match(r"^\s*[-*]\s+", line):
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{inline(line.split('-', 1)[-1].strip())}</li>")
            continue
        out.append(f"<p>{inline(line.strip())}</p>")
    if in_list:
        out.append("</ul>")
    return "\n".join(out)


def inline(text: str) -> str:
    text = html.escape(text)
    text = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2">\1</a>', text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", text)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    return text


def run(dry_run: bool = False, limit: int = 1) -> dict:
    to = post_address()
    if not to:
        return {
            "status": "skipped",
            "lane": "blogger",
            "reason": "no BLOGGER_POST_EMAIL set (Mail2Blogger address). Lane is off, not broken.",
            "blog": blog_url() or None,
        }
    todo = candidates()[:limit]
    if not todo:
        return {"status": "idle", "lane": "blogger", "reason": "nothing unpublished in the outbox"}
    results = []
    for path in todo:
        title = title_of(path)
        body_md = path.read_text(encoding="utf-8", errors="replace")
        body_html = to_html(body_md)
        if dry_run:
            results.append({"path": str(path.relative_to(REPO)), "title": title, "status": "dry-run"})
            continue
        res = POOL.send(to, title, body_md, body_html)
        if res["status"] == "sent":
            remember(title, {"sent_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                             "from": POOL.address, "to": to, "path": str(path.relative_to(REPO))})
        results.append({"path": str(path.relative_to(REPO)), "title": title, **res})
    statuses = {r["status"] for r in results}
    status = "sent" if statuses == {"sent"} else ("dry-run" if statuses == {"dry-run"} else "partial")
    return {"status": status, "lane": "blogger", "items": results}


def main() -> int:
    ap = argparse.ArgumentParser(description="Blogger lane + the estate's shared email pool")
    ap.add_argument("--once", action="store_true", help="send the next unpublished article")
    ap.add_argument("--dry-run", action="store_true", help="say what would go out, send nothing")
    ap.add_argument("--check", action="store_true", help="report whether the pool can log in")
    ap.add_argument("--limit", type=int, default=1)
    ap.add_argument("--send-test", metavar="ADDRESS", help="send one test message through the pool")
    args = ap.parse_args()

    if args.check:
        print(json.dumps(check(), indent=1))
        return 0
    if args.send_test:
        print(json.dumps(send(args.send_test, "Email pool test",
                             "This is a test from the estate's shared email pool.",
                             "<p>This is a test from the estate's shared email pool.</p>"), indent=1))
        return 0
    print(json.dumps(run(dry_run=args.dry_run, limit=args.limit), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
