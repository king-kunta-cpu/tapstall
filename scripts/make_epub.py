#!/usr/bin/env python3
"""
Build an EPUB 3 edition from a single Markdown source, so that each work ships in four
formats (Markdown · HTML · PDF · EPUB) from one source of truth.

No third-party dependencies: the container is assembled with zipfile, and every XHTML
document is parsed with xml.etree before it is written, so a malformed chapter fails the
build instead of producing an unreadable book.

Usage:  python3 scripts/make_epub.py <source.md> [more.md ...]
Writes: <source>.epub beside the source.
"""
import html
import re
import sys
import uuid
import zipfile
from pathlib import Path
from xml.etree import ElementTree

import markdown

MD = markdown.Markdown(extensions=["tables", "fenced_code", "sane_lists"])

CSS = """@charset "utf-8";
body { font-family: Georgia, serif; line-height: 1.55; margin: 0 5%; color: #17191c; }
h1, h2 { font-weight: normal; line-height: 1.2; }
h2.part { font-size: 1.6em; margin: 3em 0 1em; border-bottom: 2px solid #b3392f;
          padding-bottom: .4em; page-break-before: always; }
h2.ch { font-size: 1.35em; margin: 2.4em 0 .2em; page-break-before: always; }
p.chnum { font-family: sans-serif; font-size: .72em; letter-spacing: .18em;
          text-transform: uppercase; color: #b3392f; margin: 2.2em 0 0; }
h3 { font-family: sans-serif; font-size: .95em; margin: 1.6em 0 .35em; }
p { margin: 0 0 .75em; text-align: justify; }
ul, ol { margin: 0 0 .9em 1.2em; padding: 0; }
li { margin-bottom: .3em; }
blockquote { margin: 1em 0; padding-left: .9em; border-left: 2px solid #b3392f; }
blockquote p { margin: 0 0 .4em; }
table { border-collapse: collapse; width: 100%; font-family: sans-serif; font-size: .78em;
        margin: .6em 0 1.1em; }
th, td { border-bottom: 1px solid #d9d5cc; padding: .35em .45em; text-align: left;
         vertical-align: top; }
th { border-bottom: 2px solid #17191c; background: #f4f1ea; }
pre { font-family: monospace; font-size: .76em; background: #f4f1ea; padding: .7em;
      border-left: 2px solid #b3392f; white-space: pre-wrap; }
code { font-family: monospace; font-size: .88em; background: #f4f1ea; }
.title { text-align: center; margin-top: 22%; }
.title .pub { font-family: sans-serif; font-size: .7em; letter-spacing: .22em;
              text-transform: uppercase; color: #b3392f; }
.title h1 { font-size: 2.1em; margin: 1em 0 .3em; }
.title .sub { font-style: italic; color: #444; font-size: 1.1em; }
.title .author { margin-top: 3.5em; font-family: sans-serif; letter-spacing: .06em; }
.title .ed { font-family: sans-serif; font-size: .8em; color: #777; margin-top: .4em; }
"""

XHTML = ('<?xml version="1.0" encoding="utf-8"?>\n'
         '<!DOCTYPE html>\n'
         '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" '
         'lang="en" xml:lang="en"><head><meta charset="utf-8"/><title>{title}</title>'
         '<link rel="stylesheet" type="text/css" href="style.css"/></head><body>{body}</body></html>')


def parse(text):
    meta, body = {}, text
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip().strip('"')
        body = text[m.end():]

    parts = []
    cur_part, cur_ch = "Front Matter", {"title": None, "lines": []}
    chapters = []
    for line in body.splitlines():
        if line.startswith("# "):
            if cur_ch["title"] is not None:
                chapters.append((cur_part, cur_ch))
                cur_ch = {"title": None, "lines": []}
            cur_part = line[2:].strip()
        elif line.startswith("## "):
            if cur_ch["title"] is not None:
                chapters.append((cur_part, cur_ch))
            cur_ch = {"title": line[3:].strip(), "lines": []}
        else:
            cur_ch["lines"].append(line)
    if cur_ch["title"] is not None:
        chapters.append((cur_part, cur_ch))
    return meta, chapters


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:50] or "section"


def build(src: Path):
    meta, chapters = parse(src.read_text(encoding="utf-8"))
    title = meta.get("title", src.stem)
    author = meta.get("author", "Courage Garikai")
    bookid = "urn:uuid:" + str(uuid.uuid5(uuid.NAMESPACE_URL, f"jacandaralabs:{src.name}"))

    docs = []  # (filename, title, xhtml, is_part_opener)
    title_page = (
        '<div class="title">'
        f'<div class="pub">{html.escape(meta.get("publisher", ""))}</div>'
        f'<h1>{html.escape(title)}</h1>'
        f'<div class="sub">{html.escape(meta.get("subtitle", ""))}</div>'
        f'<div class="author">{html.escape(author)}</div>'
        f'<div class="ed">{html.escape(meta.get("edition", ""))}</div>'
        "</div>"
    )
    docs.append(("title.xhtml", "Title Page", title_page))

    nav_entries = []  # (part_title, [(file, label)])
    for part, ch in chapters:
        MD.reset()
        body = MD.convert("\n".join(ch["lines"]))
        num = re.match(r"^(\d+)\s*·\s*(.+)$", ch["title"])
        head = ""
        label = ch["title"]
        if num:
            head = f'<p class="chnum">Chapter {html.escape(num.group(1))}</p>'
            label = f"{num.group(1)}. {num.group(2)}"
            heading = f"<h2 class=\"ch\">{html.escape(num.group(2))}</h2>"
        else:
            heading = f'<h2 class="ch">{html.escape(ch["title"])}</h2>'
        fn = f"{slug(ch['title'])}.xhtml"
        n = 1
        while any(d[0] == fn for d in docs):
            fn = f"{slug(ch['title'])}-{n}.xhtml"
            n += 1
        docs.append((fn, label, head + heading + body))
        if not nav_entries or nav_entries[-1][0] != part:
            nav_entries.append((part, []))
        nav_entries[-1][1].append((fn, label))

    # wrap in XHTML and validate that every document parses as XML
    wrapped = []
    for fn, label, body in docs:
        x = XHTML.format(title=html.escape(title), body=body)
        try:
            ElementTree.fromstring(x)
        except ElementTree.ParseError as e:
            raise SystemExit(f"malformed XHTML in {fn}: {e}")
        wrapped.append((fn, label, x))
    docs = wrapped

    # nav
    items = []
    for part, entries in nav_entries:
        if part not in ("Front Matter", "Back Matter"):
            items.append(f"<li><span>{html.escape(part)}</span><ol>")
        else:
            items.append("<li><ol>")
        for fn, label in entries:
            items.append(f'<li><a href="{fn}">{html.escape(label)}</a></li>')
        items.append("</ol></li>")
    nav_body = '<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>' + "".join(items) + "</ol></nav>"
    nav_xhtml = XHTML.format(title="Contents", body=nav_body)
    ElementTree.fromstring(nav_xhtml)

    manifest = [
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
        '<item id="css" href="style.css" media-type="text/css"/>',
    ]
    spine = ['<itemref idref="nav"/>']
    for i, (fn, _, _) in enumerate(docs):
        manifest.append(f'<item id="d{i}" href="{fn}" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="d{i}"/>')

    opf = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">{bookid}</dc:identifier>
    <dc:title>{html.escape(title)}</dc:title>
    <dc:creator>{html.escape(author)}</dc:creator>
    <dc:language>en</dc:language>
    <dc:publisher>{html.escape(meta.get("publisher", "Jacaranda Labs Press"))}</dc:publisher>
    <dc:rights>{html.escape(meta.get("licence", ""))}</dc:rights>
    <dc:description>{html.escape(meta.get("subtitle", ""))}</dc:description>
    <meta property="dcterms:modified">2026-10-21T00:00:00Z</meta>
  </metadata>
  <manifest>
    {chr(10).join('    ' + m for m in manifest)}
  </manifest>
  <spine>
    {chr(10).join('    ' + s for s in spine)}
  </spine>
</package>
"""

    container = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf"
    media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""

    out = src.with_suffix(".epub")
    with zipfile.ZipFile(out, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", container, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", opf, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/nav.xhtml", nav_xhtml, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/style.css", CSS, zipfile.ZIP_DEFLATED)
        for fn, _, xhtml in docs:
            z.writestr(f"OEBPS/{fn}", xhtml, zipfile.ZIP_DEFLATED)
    return out, len(docs)


def verify(path: Path):
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        assert names[0] == "mimetype", "mimetype must be the first entry"
        info = z.getinfo("mimetype")
        assert info.compress_type == zipfile.ZIP_STORED, "mimetype must be stored uncompressed"
        assert z.read("mimetype") == b"application/epub+zip"
        opf = z.read("OEBPS/content.opf").decode()
        ElementTree.fromstring(opf)
        ElementTree.fromstring(z.read("OEBPS/nav.xhtml").decode())
        for n in names:
            if n.endswith(".xhtml"):
                ElementTree.fromstring(z.read(n).decode())
        # every manifest href exists
        import re as _re
        for href in _re.findall(r'href="([^"]+)"', opf):
            assert f"OEBPS/{href}" in names, f"missing manifest item {href}"
        return len([n for n in names if n.endswith(".xhtml")])


def main():
    args = sys.argv[1:] or ["book/Garikai-2026-The-Ledger-and-the-Shopkeeper.md",
                            "book/Garikai-2026-Intelligence-Data-and-Judgement.md",
                            "papers/Garikai-2026-Order-Without-Custody-DCAI-Working-Paper-3.md"]
    for a in args:
        src = Path(a)
        out, n = build(src)
        v = verify(out)
        print(f"epub  {out}  {out.stat().st_size:,} bytes  {v} documents")


if __name__ == "__main__":
    main()
