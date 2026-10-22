#!/usr/bin/env python3
"""
Render the textbook (Book 2) from its single Markdown source into (a) a self-contained HTML reading edition and
(b) a print-ready PDF, using WeasyPrint.

One source, two artefacts, one pagination model: chapter openers on a fresh page, running heads,
a table of contents whose page numbers are resolved by the PDF engine (target-counter), and a
cover. Deliberately no external assets — the HTML edition must survive being opened offline, and
the PDF must not need a network at build time.

Usage:  python3 scripts/make_book.py [source.md]
Writes: book/<name>.html and book/<name>.pdf beside the source.
"""
import html
import re
import sys
from pathlib import Path

import markdown

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "book/Garikai-2026-Intelligence-Data-and-Judgement.md")
OUT_HTML = SRC.with_suffix(".html")
OUT_PDF = SRC.with_suffix(".pdf")


# ----------------------------------------------------------------- source parsing

def parse_source(text):
    meta, body = {}, text
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip().strip('"')
        body = text[m.end():]

    # Split into blocks on h1 (# Part One — The Gap / # Front Matter), then chapters on h2.
    blocks, cur = [], {"title": None, "lines": []}
    for line in body.splitlines():
        if line.startswith("# "):
            if cur["title"] is not None:
                blocks.append(cur)
            cur = {"title": line[2:].strip(), "lines": []}
        else:
            cur["lines"].append(line)
    if cur["title"] is not None:
        blocks.append(cur)

    chapters = []
    for b in blocks:
        buf = {"title": None, "lines": []}
        parts = []
        for line in b["lines"]:
            if line.startswith("## "):
                if buf["title"] is not None:
                    parts.append(buf)
                buf = {"title": line[3:].strip(), "lines": []}
            else:
                buf["lines"].append(line)
        if buf["title"] is not None:
            parts.append(buf)
        chapters.append({"part": b["title"], "sections": parts})
    return meta, chapters


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60]


def chapter_number(title):
    m = re.match(r"^(\d+)\s*·\s*(.+)$", title)
    return (m.group(1), m.group(2)) if m else (None, title)


# ----------------------------------------------------------------- markdown → html

MD = markdown.Markdown(extensions=["tables", "fenced_code", "sane_lists", "attr_list"])


def render_md(text):
    MD.reset()
    out = MD.convert(text)
    # keep the source honest: no raw html injection from the md beyond what we generate
    return out


# ----------------------------------------------------------------- CSS

BOOK_CSS = """
@page {
  size: 6in 9in;
  margin: 0.85in 0.78in 0.8in 0.78in;
  @top-center { content: string(runhead); font: 8.2pt "DejaVu Sans", sans-serif;
                letter-spacing: .13em; text-transform: uppercase; color: #8a8f94; }
  @bottom-center { content: counter(page); font: 8.6pt "DejaVu Sans", sans-serif; color: #6b7176; }
}
@page :first { margin: 0; @top-center { content: none } @bottom-center { content: none } }
@page blank { @top-center { content: none } }
@page part { @top-center { content: none } @bottom-center { content: none } }

html { font-family: "DejaVu Serif", Georgia, serif; font-size: 10.6pt; line-height: 1.52; color: #17191c; }
body { margin: 0; hyphens: auto; }

.cover { hyphens: none; page: first; height: 9in; width: 6in; box-sizing: border-box; padding: 1.35in 0.8in 0.9in;
         background: #14181c; color: #f4f1ea; display: block; page-break-after: always; }
.cover .rule { width: 1.1in; height: 3px; background: #b3392f; margin-bottom: 26px; }
.cover .pub { font: 600 7.8pt "DejaVu Sans", sans-serif; letter-spacing: .22em; text-transform: uppercase;
              color: #b9b2a5; }
.cover h1 { font-size: 34pt; line-height: 1.06; margin: 30px 0 14px; font-weight: 400; letter-spacing: -.015em; }
.cover .sub { font-size: 13pt; line-height: 1.4; color: #d8d2c6; font-style: italic; max-width: 4.1in;
              margin-bottom: 0; }
.cover .spacer { height: 1.55in; }
.cover .author { margin-top: 1.55in; font: 600 10.5pt "DejaVu Sans", sans-serif; letter-spacing: .05em; color: #f4f1ea; }
.cover .ed { font: 400 8.6pt "DejaVu Sans", sans-serif; color: #9d968a; margin-top: 6px; }

.toc { break-before: page; break-after: page; page-break-before: always; page-break-after: always; }
.toc h2 { font: 600 10pt "DejaVu Sans", sans-serif; letter-spacing: .18em; text-transform: uppercase;
          color: #b3392f; margin: 0 0 26px; }
.toc .part { margin: 19px 0 2px; padding-bottom: 5px; }
.toc .part a { font: 600 9.2pt "DejaVu Sans", sans-serif; letter-spacing: .05em; }
.toc a { display: block; text-decoration: none; color: #17191c; font-size: 10pt; margin: 0;
         padding: 3.1px 0; page-break-inside: avoid; }
.toc a::after { content: leader(". ") target-counter(attr(href), page);
                color: #6b7176; font-size: 9pt; font-family: "DejaVu Sans", sans-serif; }
.toc a .n { color: #b3392f; font-family: "DejaVu Sans", sans-serif; font-size: 8.6pt;
            display: inline-block; width: 20px; }

body > .part { page: part; break-before: page; break-after: page; page-break-before: always;
        page-break-after: always; break-inside: avoid; padding-top: 2.3in; }
body > .part .kicker { font: 600 8pt "DejaVu Sans", sans-serif; letter-spacing: .22em; text-transform: uppercase;
                color: #b3392f; }
body > .part h1 { font-size: 24pt; font-weight: 400; line-height: 1.15; margin: 10px 0 0; letter-spacing: -.01em; }
body > .part .rule { width: 1.4in; height: 2px; background: #17191c; margin-top: 22px; }

section.ch { break-before: page; page-break-before: always; }
section.ch > h2 { string-set: runhead content(); font-size: 17pt; font-weight: 400; line-height: 1.18;
                  margin: 0 0 4px; letter-spacing: -.01em; }
.ch .chnum { font: 600 8.4pt "DejaVu Sans", sans-serif; letter-spacing: .2em; color: #b3392f;
             text-transform: uppercase; margin-bottom: 9px; }
.ch .chrule { width: .9in; height: 1.5px; background: #b3392f; margin: 12px 0 20px; }

h3 { font: 600 10.2pt "DejaVu Sans", sans-serif; margin: 20px 0 6px; page-break-after: avoid; }
p { margin: 0 0 9.5px; text-align: justify; }
p + p { text-indent: 0; }
ul, ol { margin: 0 0 11px 17px; padding: 0; }
li { margin-bottom: 4.5px; text-align: left; }
strong { font-weight: 700; }
em { font-style: italic; }

blockquote { margin: 14px 0; padding: 2px 0 2px 14px; border-left: 2.5px solid #b3392f; color: #3a3f45;
             font-size: 10pt; page-break-inside: avoid; }
blockquote p { margin: 0 0 6px; text-align: left; }
blockquote p:last-child { margin-bottom: 0; }

table { width: 100%; border-collapse: collapse; margin: 8px 0 14px; font-size: 8.8pt;
        font-family: "DejaVu Sans", sans-serif; page-break-inside: avoid; hyphens: manual; }
th, td { border-bottom: .5px solid #d9d5cc; padding: 5px 6px; text-align: left; vertical-align: top;
         hyphens: manual; word-break: normal; overflow-wrap: break-word; }
th:first-child, td:first-child { min-width: 0.82in; }
th { font-weight: 700; border-bottom: 1px solid #17191c; background: #f4f1ea; }

code, pre { font-family: "DejaVu Sans Mono", monospace; font-size: 8.4pt; }
pre { background: #f4f1ea; padding: 9px 11px; border-left: 2.5px solid #b3392f; overflow-wrap: break-word;
      white-space: pre-wrap; margin: 0 0 12px; }
code { background: #f4f1ea; padding: 0 2px; }

hr { border: 0; border-top: 1px solid #e3dfd6; margin: 20px 0; }
"""

WEB_CSS = """
:root { --ink:#14181c; --soft:#5b6369; --rule:#dcd8cf; --accent:#b3392f; --paper:#fdfcf8; }
* { box-sizing: border-box; }
html { background:#e9e6df; }
body { margin:0 auto; max-width:760px; padding:64px 54px 110px; background:var(--paper); color:var(--ink);
       font:17.2px/1.62 "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
       box-shadow: 0 0 0 1px var(--rule), 0 22px 70px rgba(0,0,0,.08); }
.cover { background:#14181c; color:#f4f1ea; padding:64px 48px 56px; margin:-64px -54px 54px; }
.cover .rule { width:96px; height:3px; background:var(--accent); margin-bottom:22px; }
.cover .pub { font:600 10.5px/1.4 ui-sans-serif,system-ui,sans-serif; letter-spacing:.22em; text-transform:uppercase; color:#b9b2a5; }
.cover h1 { font-size:44px; line-height:1.05; margin:26px 0 14px; font-weight:400; letter-spacing:-.02em; }
.cover .sub { font-size:20px; line-height:1.35; color:#d8d2c6; font-style:italic; max-width:30em; }
.cover .author { margin-top:44px; font:600 14px ui-sans-serif,system-ui,sans-serif; letter-spacing:.04em; }
.cover .ed { font:13px ui-sans-serif,system-ui,sans-serif; color:#9d968a; margin-top:6px; }
.toc { border-top:2px solid var(--ink); padding-top:22px; margin-bottom:52px; }
.toc h2 { font:600 12px ui-sans-serif,system-ui,sans-serif; letter-spacing:.2em; text-transform:uppercase; color:var(--accent); margin:0 0 18px; }
.toc .part { font:600 13px ui-sans-serif,system-ui,sans-serif; margin:20px 0 6px; padding-bottom:5px; border-bottom:1px solid var(--rule); }
.toc a { display:block; text-decoration:none; color:var(--ink); padding:3px 0; font-size:15.5px; }
.toc a:hover { color:var(--accent); }
.toc a .n { color:var(--accent); font-family:ui-sans-serif,system-ui,sans-serif; font-size:12px; margin-right:8px; }
.part { margin:70px 0 0; padding-top:26px; border-top:2px solid var(--ink); }
.part .kicker { font:600 11px ui-sans-serif,system-ui,sans-serif; letter-spacing:.2em; text-transform:uppercase; color:var(--accent); }
.part h1 { font-size:31px; font-weight:400; margin:10px 0 0; }
section.ch { margin-top:46px; }
.ch .chnum { font:600 11px ui-sans-serif,system-ui,sans-serif; letter-spacing:.2em; color:var(--accent); text-transform:uppercase; }
section.ch > h2 { font-size:27px; font-weight:400; line-height:1.2; margin:8px 0 0; }
.ch .chrule { width:84px; height:2px; background:var(--accent); margin:16px 0 24px; }
h3 { font:600 14.5px ui-sans-serif,system-ui,sans-serif; margin:26px 0 8px; }
p { margin:0 0 15px; }
ul,ol { margin:0 0 16px 24px; padding:0; }
li { margin-bottom:7px; }
blockquote { margin:22px 0; padding:4px 0 4px 20px; border-left:3px solid var(--accent); color:#333a40; font-style:italic; }
blockquote p { margin:0 0 8px; }
table { width:100%; border-collapse:collapse; margin:6px 0 22px; font:14px/1.5 ui-sans-serif,system-ui,sans-serif; }
th,td { border-bottom:1px solid var(--rule); padding:8px 9px; text-align:left; vertical-align:top; }
th { font-weight:600; border-bottom:1.5px solid var(--ink); background:#f5f2ea; }
pre { background:#f5f2ea; border-left:3px solid var(--accent); padding:13px 16px; overflow-x:auto; white-space:pre-wrap; }
code { font:.88em ui-monospace,SFMono-Regular,Menlo,monospace; background:#f5f2ea; padding:1px 4px; }
pre code { background:none; padding:0; }
hr { border:0; border-top:1px solid var(--rule); margin:38px 0; }
@media (max-width:700px) { body { padding:30px 22px 70px; } .cover { margin:-30px -22px 36px; padding:44px 22px; }
  .cover h1 { font-size:32px; } section.ch > h2 { font-size:22px; } }
@media print { html { background:#fff } body { box-shadow:none; padding:0; max-width:none; } }
"""


# ----------------------------------------------------------------- assembly

def build(meta, chapters):
    cover_title = meta.get("title", "Untitled")
    cover_sub = meta.get("subtitle", "")
    author = meta.get("author", "")
    edition = meta.get("edition", "")

    cover = (
        '<div class="cover">'
        '<div class="rule"></div>'
        f'<div class="pub">{html.escape(meta.get("publisher", ""))}</div>'
        f"<h1>{html.escape(cover_title)}</h1>"
        f'<div class="sub">{html.escape(cover_sub)}</div>'
        f'<div class="author">{html.escape(author)}</div>'
        f'<div class="ed">{html.escape(edition)}</div>'
        "</div>"
    )

    # TOC: parts and their chapters, with stable ids
    toc = ['<nav class="toc"><h2>Contents</h2>']
    seen_parts = set()
    chans = []
    for blk in chapters:
        ptitle = blk["part"]
        pid = "part-" + slug(ptitle)
        if blk["sections"] and ptitle not in ("Front Matter", "Back Matter"):
            toc.append(f'<div class="part"><a href="#{pid}">{html.escape(ptitle)}</a></div>')
        for sec in blk["sections"]:
            num, name = chapter_number(sec["title"])
            cid = "ch-" + slug(sec["title"])
            label = f'<span class="n">{html.escape(num)}</span>' if num else ""
            toc.append(f'<a href="#{cid}">{label}{html.escape(name)}</a>')
            chans.append((pid, ptitle, cid, num, name, sec["lines"]))
    toc.append("</nav>")

    body_parts = []
    cur_part = None
    for pid, ptitle, cid, num, name, lines in chans:
        if ptitle != cur_part:
            if cur_part is not None:
                body_parts.append("</div>")
            if ptitle not in ("Front Matter", "Back Matter") and any(
                s["title"] for b in chapters if b["part"] == ptitle for s in b["sections"]
            ):
                kicker = "Part " + ptitle.split("—")[0].replace("Part ", "").strip() if ptitle.startswith("Part") else ptitle
                heading = ptitle.split("—", 1)[1].strip() if "—" in ptitle else ptitle
                body_parts.append(
                    f'<div class="part" id="{pid}"><div class="kicker">{html.escape(kicker)}</div>'
                    f'<h1>{html.escape(heading)}</h1><div class="rule"></div></div>'
                )
                body_parts.append('<div class="division">')
            else:
                body_parts.append(f'<div class="division" id="{pid}">')
            cur_part = ptitle
        chnum = f'<div class="chnum">Chapter {html.escape(num)}</div>' if num else ""
        body_parts.append(
            f'<section class="ch" id="{cid}">{chnum}<h2>{html.escape(name)}</h2>'
            f'<div class="chrule"></div>{render_md("\n".join(lines))}</section>'
        )
    if cur_part is not None:
        body_parts.append("</div>")

    article = cover + "".join(toc) + "".join(body_parts)

    web = (
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{html.escape(cover_title)} — {html.escape(cover_sub)}</title>"
        f"<style>{WEB_CSS}</style></head><body>{article}</body></html>"
    )
    pdf = (
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
        f"<title>{html.escape(cover_title)}</title><style>{BOOK_CSS}</style></head>"
        f"<body>{article}</body></html>"
    )
    return web, pdf


def main():
    src_text = SRC.read_text(encoding="utf-8")
    meta, chapters = parse_source(src_text)
    web, pdfdoc = build(meta, chapters)
    OUT_HTML.write_text(web, encoding="utf-8")
    print(f"html  {OUT_HTML}  {len(web):,} bytes")

    try:
        from weasyprint import HTML
    except ImportError:
        print("weasyprint not installed — html only")
        return
    HTML(string=pdfdoc, base_url=str(SRC.parent)).write_pdf(str(OUT_PDF))
    print(f"pdf   {OUT_PDF}  {OUT_PDF.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
