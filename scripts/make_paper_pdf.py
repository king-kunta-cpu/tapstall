#!/usr/bin/env python3
"""
Render the paper's HTML reading edition to a print PDF, so the paper ships in the same
four formats as the books (Markdown · HTML · PDF · EPUB).

The reading edition is already typeset for the screen; this script only contributes the
print layer — A4 page, margins, running head taken from the document title, folio at the
foot — and leaves the body typography untouched.

Usage:  python3 scripts/make_paper_pdf.py [source.html]
Writes: <source>.pdf beside the source.
"""
import html as htmllib
import re
import sys
from pathlib import Path

from weasyprint import HTML

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "papers/Garikai-2026-Order-Without-Custody-DCAI-Working-Paper-3.html")
OUT = SRC.with_suffix(".pdf")

PRINT_CSS = """
@page {
  size: A4;
  margin: 22mm 20mm 20mm 20mm;
  @top-left  { content: "Order Without Custody"; font: 7.8pt "DejaVu Sans", sans-serif;
               letter-spacing: .1em; text-transform: uppercase; color: #8a8f94; }
  @top-right { content: "Garikai · 2026"; font: 7.8pt "DejaVu Sans", sans-serif;
               color: #8a8f94; }
  @bottom-center { content: counter(page); font: 8.4pt "DejaVu Sans", sans-serif; color: #6b7176; }
}
@page :first { @top-left { content: none } @top-right { content: none } }
html, body { background: #fff !important; box-shadow: none !important; }
body { margin: 0 !important; padding: 0 !important; max-width: none !important;
       font-size: 10.2pt !important; line-height: 1.5 !important; hyphens: auto; }
header.mast h1 { font-size: 20pt !important; }
h1 { font-size: 15pt !important; break-after: avoid; }
h2 { font-size: 12pt !important; break-after: avoid; }
h3 { break-after: avoid; }
table { break-inside: avoid; font-size: 8pt !important; }
pre { font-size: 8pt !important; white-space: pre-wrap; }
p, li { orphans: 3; widows: 3; }
"""


def main():
    doc = SRC.read_text(encoding="utf-8")
    title = re.search(r"<title>(.*?)</title>", doc, re.S)
    title = htmllib.unescape(title.group(1).strip()) if title else SRC.stem
    if "</head>" not in doc:
        raise SystemExit("expected a full HTML document with a </head>")
    doc = doc.replace("</head>", f"<style>{PRINT_CSS}</style></head>", 1)
    HTML(string=doc, base_url=str(SRC.parent)).write_pdf(str(OUT))

    from pypdf import PdfReader
    r = PdfReader(str(OUT))
    pages = len(r.pages)
    empty = [i + 1 for i, p in enumerate(r.pages) if len((p.extract_text() or "").strip()) < 15]
    print(f"pdf   {OUT}  {OUT.stat().st_size:,} bytes  {pages} pages  empty={empty}")
    print(f"      {title}")


if __name__ == "__main__":
    main()
