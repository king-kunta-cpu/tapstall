#!/usr/bin/env python3
"""
Render a paper from its Markdown source into a reading edition (HTML) and a print edition
(PDF), with figures, tables and a title block.

This is the general form of the renderer used for the books, cut down to what a paper
needs: front matter, an abstract, numbered sections, figures resolved relative to the
source file, and a print layer with a running head and folio.

Usage:  python3 scripts/make_paper.py papers/<name>.md [more.md ...]
Writes: <name>.html and <name>.pdf beside the source.
"""
import html
import re
import sys
from pathlib import Path

import markdown
from weasyprint import HTML

MD = markdown.Markdown(extensions=["tables", "fenced_code", "sane_lists", "footnotes",
                                   "attr_list", "toc"])

READING_CSS = """
:root{--ink:#14171a;--muted:#5b6670;--rule:#dfe3e7;--accent:#7a1f1f;--paper:#fdfdfb;--panel:#f4f5f3}
*{box-sizing:border-box}
html{background:#eceae4}
body{margin:0 auto;background:var(--paper);color:var(--ink);
  font:16.5px/1.62 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
  max-width:820px;padding:64px 56px 96px;
  box-shadow:0 0 0 1px var(--rule),0 18px 60px rgba(0,0,0,.07)}
header.mast{border-bottom:2px solid var(--ink);padding-bottom:22px;margin-bottom:38px}
header.mast .series{font:600 11.5px/1.4 ui-sans-serif,system-ui,sans-serif;letter-spacing:.14em;
  text-transform:uppercase;color:var(--accent)}
header.mast h1{font-size:31px;line-height:1.2;margin:14px 0 10px;letter-spacing:-.01em;font-weight:400}
header.mast .byline{font:400 13.5px/1.5 ui-sans-serif,system-ui,sans-serif;color:var(--muted)}
header.mast .byline b{color:var(--ink);font-weight:600}
h1{font-size:23px;margin:44px 0 12px;padding-top:14px;border-top:1px solid var(--rule)}
h2{font-size:18.5px;margin:30px 0 8px;font-weight:400}
h3{font:600 15px/1.4 ui-sans-serif,system-ui,sans-serif;margin:22px 0 6px}
p{margin:0 0 13px}
ul,ol{margin:0 0 14px 22px;padding:0}
blockquote{margin:18px 0;padding:2px 0 2px 16px;border-left:3px solid var(--accent);color:#333a40}
table{width:100%;border-collapse:collapse;margin:10px 0 20px;font:13.5px/1.5 ui-sans-serif,system-ui,sans-serif}
th,td{border-bottom:1px solid var(--rule);padding:7px 8px;text-align:left;vertical-align:top}
th{font-weight:600;border-bottom:1.5px solid var(--ink);background:var(--panel)}
figure{margin:22px 0 26px}
figure img{width:100%;height:auto;border:1px solid var(--rule);background:#fff}
figcaption{font:12.5px/1.5 ui-sans-serif,system-ui,sans-serif;color:var(--muted);margin-top:8px}
code{font:.88em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--panel);padding:1px 4px}
pre{background:var(--panel);padding:13px 16px;overflow-x:auto;white-space:pre-wrap;font-size:13px}
hr{border:0;border-top:1px solid var(--rule);margin:32px 0}
footer.colophon{margin-top:44px;padding-top:16px;border-top:2px solid var(--ink);
  font:12.5px/1.6 ui-sans-serif,system-ui,sans-serif;color:var(--muted)}
@media (max-width:700px){body{padding:30px 22px 70px}header.mast h1{font-size:25px}}
"""

PRINT_CSS = """
@page { size: A4; margin: 20mm 18mm 18mm 18mm;
  @top-left { content: string(runhead); font: 7.6pt "DejaVu Sans", sans-serif;
              letter-spacing: .1em; text-transform: uppercase; color: #8a8f94; }
  @top-right { content: "Garikai · 2026"; font: 7.6pt "DejaVu Sans", sans-serif; color: #8a8f94; }
  @bottom-center { content: counter(page); font: 8.4pt "DejaVu Sans", sans-serif; color: #6b7176; }
}
@page :first { @top-left { content: none } @top-right { content: none } }
html, body { background: #fff !important; box-shadow: none !important; }
body { margin: 0 !important; padding: 0 !important; max-width: none !important;
       font-size: 10.1pt !important; line-height: 1.48 !important; hyphens: auto; }
header.mast h1 { font-size: 19pt !important; }
header.mast .series { string-set: runhead content(); }
h1 { font-size: 14.5pt !important; break-after: avoid; break-before: page; }
h1:first-of-type { break-before: auto; }
h2 { font-size: 11.8pt !important; break-after: avoid; }
h3 { break-after: avoid; }
figure { break-inside: avoid; }
table { break-inside: avoid; font-size: 8pt !important; }
pre { font-size: 7.8pt !important; white-space: pre-wrap; }
p, li { orphans: 3; widows: 3; }
"""


def parse_front_matter(text):
    meta, body = {}, text
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip().strip('"')
        body = text[m.end():]
    return meta, body


def build_figures(body):
    """Turn ![caption](path) into <figure><img><figcaption>, so captions read as captions."""
    def repl(m):
        cap, src = m.group(1), m.group(2)
        return (f'<figure><img src="{html.escape(src)}" alt="{html.escape(cap[:180])}"/>'
                f'<figcaption>{html.escape(cap)}</figcaption></figure>')
    return re.sub(r"!\[(.*?)\]\((.*?)\)", repl, body, flags=re.S)


def render(src: Path):
    text = src.read_text(encoding="utf-8")
    meta, body = parse_front_matter(text)
    title = meta.get("title", src.stem)
    author = meta.get("author", "Courage Garikai")
    affiliation = meta.get("affiliation", "Jacaranda Labs · Harare")
    date = meta.get("date", "2026")

    body = build_figures(body)
    MD.reset()
    inner = MD.convert(body)

    short = meta.get("short_title") or re.split(r"[:—]", title)[0].strip()
    short = short if len(short) <= 62 else short[:59].rstrip() + "…"
    mast = (
        '<header class="mast">'
        f'<div class="series">{html.escape(short)}</div>'
        f"<h1>{html.escape(title)}</h1>"
        f'<div class="byline"><b>{html.escape(author)}</b> · {html.escape(affiliation)}</div>'
        f'<div class="byline">{html.escape(date)}</div>'
        "</header>"
    )
    colophon = (
        '<footer class="colophon">'
        f"{html.escape(author)} · {html.escape(affiliation)} · {html.escape(date)}. "
        "Published by Jacaranda Labs Press, Harare. Figures and tables are reproduced "
        "from the source document."
        "</footer>"
    )
    article = mast + inner + colophon

    page = (f'<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            f"<title>{html.escape(title)}</title>"
            f"<style>{READING_CSS}</style><style media=\"print\">{PRINT_CSS}</style>"
            f"</head><body>{article}</body></html>")

    out_html = src.with_suffix(".html")
    out_html.write_text(page, encoding="utf-8")

    out_pdf = src.with_suffix(".pdf")
    HTML(string=page, base_url=str(src.parent)).write_pdf(str(out_pdf))
    return title, out_html, out_pdf


def main():
    args = sys.argv[1:]
    if not args:
        raise SystemExit("usage: make_paper.py <paper.md> [...]")
    for a in args:
        src = Path(a)
        title, h, p = render(src)
        from pypdf import PdfReader
        r = PdfReader(str(p))
        empty = [i + 1 for i, pg in enumerate(r.pages) if len((pg.extract_text() or "").strip()) < 12]
        print(f"html  {h}  {h.stat().st_size:,} bytes")
        print(f"pdf   {p}  {p.stat().st_size:,} bytes  {len(r.pages)} pages  empty={empty}")
        print(f"      {title}")


if __name__ == "__main__":
    main()
