"""Tiny dependency-free PDF writer (Python port of pdf.js) for outreach briefs (owner 2026-11-04: the day-7
email carries an attachment). A4, built-in Helvetica / Helvetica-Bold / Courier, word-wrapped, multi-page.
make_pdf(title=, subtitle=, accent="#1f3a5f", sections=[{"heading","paras","bullets","code"}], footer=) -> bytes"""
import re
import unicodedata

HW = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584]
HBW = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584]


def pdf_safe(s):
    s = str(s or "")
    for a, b in (("\u2018", "'"), ("\u2019", "'"), ("\u201a", "'"), ("\u2032", "'"), ("\u201c", '"'), ("\u201d", '"'),
                 ("\u201e", '"'), ("\u2033", '"'), ("\u2013", "-"), ("\u2014", "-"), ("\u2212", "-"), ("\u2026", "..."),
                 ("\u00a0", " "), ("\u2009", " "), ("\u202f", " "), ("\u2022", "-"), ("\u00d7", "x")):
        s = s.replace(a, b)
    s = "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))
    return re.sub(r"[^\x20-\x7e\n]", "", s)


def _esc(s):
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _width(s, size, bold):
    w = HBW if bold else HW
    return sum(w[ord(c) - 32] if 32 <= ord(c) < 127 else 556 for c in s) * size / 1000


def _wrap(text, size, bold, mx):
    out = []
    for para in pdf_safe(text).split("\n"):
        line = ""
        for word in para.split():
            nxt = (line + " " + word) if line else word
            if _width(nxt, size, bold) <= mx or not line:
                line = nxt
            else:
                out.append(line)
                line = word
        out.append(line)
    return out


def _rgb(hexs):
    m = re.match(r"^#?([0-9a-fA-F]{6})$", str(hexs or "")) or re.match(r"(1f3a5f)", "1f3a5f")
    n = int(m.group(1), 16)
    return " ".join(f"{((n >> k) & 255) / 255:.3f}" for k in (16, 8, 0))


def make_pdf(title="", subtitle="", accent="#1f3a5f", sections=(), footer=""):
    W, H, L, R, TOP, BOTTOM = 595, 842, 56, 56, 70, 64
    MAX = W - L - R
    pages, st = [], {"ops": [], "y": H - TOP}

    def new_page():
        if st["ops"]:
            pages.append(st["ops"])
        st["ops"] = [f"{_rgb(accent)} rg 0 {H - 18} {W} 18 re f 0 g"]
        st["y"] = H - TOP

    def need(h):
        if st["y"] - h < BOTTOM:
            new_page()

    def text(s, size, bold, x=L, color="0 g", font=None):
        f = font or ("F2" if bold else "F1")
        st["ops"].append(f"BT {color} /{f} {size} Tf {x} {st['y']:.1f} Td ({_esc(s)}) Tj ET")

    new_page()
    for line in _wrap(title, 20, True, MAX):
        need(26); text(line, 20, True, L, f"{_rgb(accent)} rg"); st["y"] -= 26
    if subtitle:
        st["y"] -= 2
        for line in _wrap(subtitle, 11, False, MAX):
            need(15); text(line, 11, False, L, "0.35 g"); st["y"] -= 15
    st["y"] -= 10
    for sec in sections:
        if sec.get("heading"):
            st["y"] -= 6; need(34)
            for line in _wrap(sec["heading"], 13, True, MAX):
                text(line, 13, True); st["y"] -= 18
        for p in sec.get("paras") or []:
            for line in _wrap(p, 10.5, False, MAX):
                need(14.5); text(line, 10.5, False); st["y"] -= 14.5
            st["y"] -= 6
        if sec.get("code"):
            st["y"] -= 2
            per = int(MAX / (0.6 * 8.5))
            for raw in sec["code"]:
                rest, first = pdf_safe(raw), True
                while True:
                    w = per - 2 if first else per - 6
                    piece = ("" if first else "    ") + rest[:w]
                    rest, first = rest[w:], False
                    need(11.5); text(piece, 8.5, False, L + 8, "0.12 g", "F3"); st["y"] -= 11.5
                    if not rest:
                        break
            st["y"] -= 8
        for b in sec.get("bullets") or []:
            for i, line in enumerate(_wrap(b, 10.5, False, MAX - 14)):
                need(14.5)
                if i == 0:
                    text("-", 10.5, True)
                text(line, 10.5, False, L + 14); st["y"] -= 14.5
            st["y"] -= 3
    pages.append(st["ops"])

    objs = []

    def add(s):
        objs.append(s)
        return len(objs)

    f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
    f3 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>")
    pages_id = len(objs) + 1
    objs.append(None)
    kids = []
    for i, p in enumerate(pages):
        foot = (f"BT 0.45 g /F1 8.5 Tf {L} 36 Td ({_esc(pdf_safe(footer))}) Tj ET "
                f"BT 0.45 g /F1 8.5 Tf {W - R - 30} 36 Td ({i + 1}/{len(pages)}) Tj ET")
        stream = "\n".join(p + [foot])
        c = add(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
        kids.append(add(f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {W} {H}] /Resources << /Font << /F1 {f1} 0 R /F2 {f2} 0 R /F3 {f3} 0 R >> >> /Contents {c} 0 R >>"))
    objs[pages_id - 1] = f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>"
    info = add(f"<< /Title ({_esc(pdf_safe(title))}) /Producer (Jacaranda Labs) >>")
    catalog = add(f"<< /Type /Catalog /Pages {pages_id} 0 R >>")
    out, offs = "%PDF-1.4\n", []
    for i, o in enumerate(objs):
        offs.append(len(out))
        out += f"{i + 1} 0 obj\n{o}\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offs)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root {catalog} 0 R /Info {info} 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    return out.encode("latin-1")
