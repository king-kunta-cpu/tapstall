#!/usr/bin/env python3
"""Fail the build if private material reaches the published portfolio.

The portfolio is a public page. Everything it links to is public on purpose; a
console, a manual, a lead list or a token that was never meant to be public must
never appear in it, not even in a comment or a generated copy of a book.

Run directly, or let make_portfolio.py call it — a hit means the page does not
get written. Exit code 1 on any finding.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "pages" / "public" / "portfolio"

# Hosts that must never be named in public output: closed consoles, internal
# manuals, retired products. Substring match, case-insensitive.
PRIVATE_HOSTS = [
    "stpi-bible", "getstpi", "stpi-cloud", "stpi-deskos",
    "hunta-mint", "hunta-leads", "zimlink", "open-practice-school",
    "simalidudu.workers.dev/admin", "dash.cloudflare.com",
]

# Credentials. Any match is fatal: a published token is a revoked token.
SECRET_PATTERNS = [
    rb"ghp_[A-Za-z0-9]{20,}",
    rb"gho_[A-Za-z0-9]{20,}",
    rb"github_pat_[A-Za-z0-9_]{20,}",
    rb"cfut_[A-Za-z0-9]{20,}",
    rb"AKIA[0-9A-Z]{16}",
    rb"sk-[A-Za-z0-9]{20,}",
    rb"xox[baprs]-[A-Za-z0-9-]{10,}",
    rb"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    rb"(?i)\bbearer\s+[A-Za-z0-9._-]{20,}",
    rb"(?i)(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['\"]?[A-Za-z0-9._-]{12,}",
]

# Anything that reveals the machine the page was built on.
MACHINE_PATTERNS = [
    rb"/home/[A-Za-z0-9._-]+/",
    rb"/tmp/[A-Za-z0-9._-]+",
    rb"[A-Za-z]:\\\\Users\\\\",
    rb"\blocalhost(:[0-9]+)?\b",
    rb"\b127\.0\.0\.1\b",
    rb"\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b",
    rb"\b192\.168\.\d{1,3}\.\d{1,3}\b",
    rb"\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b",
]

# Google artefacts: a published spreadsheet id or Apps Script deployment is an
# open door to live data.
GOOGLE_PATTERNS = [
    rb"script\.google\.com/macros",
    rb"docs\.google\.com/[a-z/]*spreadsheets",
    rb"(?i)(drive|docs)\.google\.com/[^\s\"']{0,80}",   # a link to a live file
    rb"(?i)\b(?:spreadsheet|sheet|drive)[_-]?id\"?\s*[:=]\s*\"?[A-Za-z0-9_-]{20,}",
]

# Only the address the author chose to publish may appear.
ALLOWED_EMAILS = {"mawangochengetai@gmail.com"}
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

TEXT_SUFFIXES = {".html", ".htm", ".json", ".css", ".js", ".svg", ".md", ".txt", ".xml"}
SKIP_DIRS = {"node_modules", "__pycache__"}


def text_files(root: Path):
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.suffix.lower() not in TEXT_SUFFIXES:
            continue
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        yield p


def scan() -> list[str]:
    findings: list[str] = []
    if not SITE.exists():
        return [f"{SITE} does not exist — nothing to check"]

    for path in text_files(SITE):
        rel = path.relative_to(SITE)
        body = path.read_text(encoding="utf-8", errors="replace")
        low = body.lower()

        for host in PRIVATE_HOSTS:
            if host.lower() in low:
                findings.append(f"{rel}: private host named — {host}")

        for label, patterns in (("credential", SECRET_PATTERNS),
                                ("machine path", MACHINE_PATTERNS),
                                ("google artefact", GOOGLE_PATTERNS)):
            for pat in patterns:
                for m in re.finditer(pat, body.encode("utf-8")):
                    line = body.count("\n", 0, m.start()) + 1
                    snippet = m.group(0)[:40].decode("utf-8", "replace")
                    findings.append(f"{rel}:{line}: {label} — {snippet!r}")

        for m in EMAIL.finditer(body):
            addr = m.group(0)
            if addr.lower() not in ALLOWED_EMAILS:
                line = body.count("\n", 0, m.start()) + 1
                findings.append(f"{rel}:{line}: unapproved email — {addr}")

    return findings


def main() -> int:
    findings = scan()
    if not findings:
        print("privacy: clean — no credentials, private hosts, machine paths or stray emails")
        return 0
    print(f"privacy: {len(findings)} finding(s) — the portfolio must not ship:\n")
    for f in findings:
        print("  " + f)
    return 1


if __name__ == "__main__":
    sys.exit(main())
