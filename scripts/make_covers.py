#!/usr/bin/env python3
"""
Cover artwork for the four books that carried a typographic panel instead of art.

One design philosophy per book, because four books arguing four different things
should not wear the same jacket:

    emotional    weather          soft thermal fields, a thin signal trace
    governable   institutional    Swiss grid, weighted rules, a ruled ledger
    intelligence instrument       blueprint ground, exploded layers, plate marks
    ledger       vernacular       risograph sand, shutter band, a stamped seal

Everything is drawn deterministically from the book's own metadata — no stock
images, no network, no random seed that is not fixed. Print resolution is
1800x2700 (6x9 in at 300 dpi); the web copy is 1000x1500.

Usage:  python3 scripts/make_covers.py [--print-dir DIR]
Writes: pages/public/portfolio/covers/<id>.jpg           web, committed
        <print-dir>/<id>-300.jpg                        print, for binding into the PDF
        book/covers/<id>-cover.pdf                      print-ready cover page (unbound books)

Binding the cover into an interior PDF is scripts/bind_covers.py.
"""
import math
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "pages" / "public" / "portfolio" / "covers"
PRINT_COVERS = ROOT / "book" / "covers"

W, H = 1800, 2700                      # 6 x 9 in at 300 dpi
WEBW, WEBH = 1000, 1500

FONTS = Path("/usr/share/fonts/truetype/dejavu")

BOOKS = {
    "ledger": {
        "design": "vernacular",
        "title": "The Ledger and the Shopkeeper",
        "subtitle": "Building commerce for the markets the platforms forgot",
        "author": "Courage Garikai",
        "press": "Jacaranda Labs Press",
        "year": "2026",
        "note": "First edition",
    },
    "intelligence": {
        "design": "instrument",
        "title": "Intelligence, Data and Judgement",
        "subtitle": "An applied introduction to artificial intelligence, with a production case",
        "author": "Courage Garikai",
        "press": "Jacaranda Labs Press",
        "year": "2026",
        "note": "First edition",
    },
    "governable": {
        "design": "institutional",
        "title": "The Governable Enterprise",
        "subtitle": "A practical guide to evidence, authority and AI operations — lessons from DeskOS",
        "author": "Courage Garikai",
        "press": "Jacaranda Labs Think Tank",
        "year": "2026",
        "note": "Complete first edition · 24 chapters · 10 operating tools",
    },
    "emotional": {
        "design": "weather",
        "title": "Emotional Engineering for AI-Oriented Infrastructure Operators",
        "subtitle": "Trust, agency and ethical adoption in systems that act",
        "author": "Courage Garikai",
        "press": "Jacaranda Labs Think Tank",
        "year": "2026",
        "note": "Author-review edition",
    },
}


# --------------------------------------------------------------------------- type helpers

def font(name, size):
    return ImageFont.truetype(str(FONTS / name), size)


def tracked(draw, xy, text, f, fill, spacing=0, anchor_left=True):
    """Draw text with letter-spacing; PIL has none of its own."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=f, fill=fill, anchor="ls")
        x += draw.textlength(ch, font=f) + spacing
    return x


def tracked_w(draw, text, f, spacing=0):
    return sum(draw.textlength(c, font=f) for c in text) + spacing * max(0, len(text) - 1)


def wrap(draw, text, f, maxw):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=f) <= maxw:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def block(draw, xy, text, f, fill, maxw, leading, anchor="ls"):
    x, y = xy
    for line in wrap(draw, text, f, maxw):
        draw.text((x, y), line, font=f, fill=fill, anchor=anchor)
        y += leading
    return y


# --------------------------------------------------------------------------- ground helpers

def vertical_gradient(size, top, bottom):
    w, h = size
    img = Image.new("RGB", (1, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        d.point((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    return img.resize((w, h), Image.BICUBIC)


def glow(img, cx, cy, r, colour, strength=1.0):
    """A soft radial field, added as light rather than painted as a disc."""
    layer = Image.new("RGB", img.size, (0, 0, 0))
    d = ImageDraw.Draw(layer)
    steps = 12
    for i in range(steps, 0, -1):
        rr = int(r * i / steps)
        a = strength * (1 - i / steps) ** 1.6
        d.ellipse([cx - rr, cy - rr * 0.92, cx + rr, cy + rr * 0.92],
                  fill=tuple(int(c * a) for c in colour))
    layer = layer.filter(ImageFilter.GaussianBlur(r * 0.22))
    return Image.fromarray(_screen(img, layer))


def _screen(a, b):
    import numpy as np
    x = np.asarray(a, dtype="int16")
    y = np.asarray(b, dtype="int16")
    out = 255 - ((255 - x) * (255 - y)) // 255
    return out.clip(0, 255).astype("uint8")


def grain(img, amount=5, seed=7):
    import numpy as np
    rng = np.random.default_rng(seed)
    arr = np.asarray(img, dtype="int16")
    noise = rng.normal(0, amount, arr.shape[:2])[:, :, None]
    return Image.fromarray((arr + noise).clip(0, 255).astype("uint8"))


def halftone(size, step=16, dot=3, colour=(0, 0, 0), alpha=26):
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for y in range(0, size[1], step):
        for x in range(0, size[0], step):
            off = (step // 2) if (y // step) % 2 else 0
            d.ellipse([x + off - dot, y - dot, x + off + dot, y + dot],
                      fill=colour + (alpha,))
    return layer


# --------------------------------------------------------------------------- designs

def cover_ledger(b):
    """Vernacular: the printed ledger of a market shop."""
    ink, ver, sand = (27, 26, 23), (207, 75, 50), (238, 226, 205)
    img = vertical_gradient((W, H), (243, 233, 214), (226, 210, 182))
    img = Image.alpha_composite(img.convert("RGBA"), halftone((W, H), 18, 3, ink, 18)).convert("RGB")
    d = ImageDraw.Draw(img, "RGBA")

    # awning: scalloped band across the head, the shop's own signboard
    band_h, top = 200, 0
    d.rectangle([0, top, W, top + band_h], fill=ink + (255,))
    scallop_r = W / 14
    for i in range(14):
        cx = scallop_r * (2 * i + 1)
        d.ellipse([cx - scallop_r, top + band_h - scallop_r * 0.5,
                   cx + scallop_r, top + band_h + scallop_r * 1.5], fill=ink + (255,))
        d.ellipse([cx - scallop_r, top + band_h - scallop_r * 0.5,
                   cx + scallop_r, top + band_h + scallop_r * 1.5],
                  outline=sand + (255,), width=3)

    # shutter stripes: the rail the shop pulls down at night
    sy = 1740
    for i in range(9):
        y = sy + i * 78
        if i % 2 == 0:
            d.rectangle([0, y, W, y + 78], fill=ink + (255,))
    d.rectangle([0, sy - 14, W, sy - 4], fill=ver + (255,))
    d.rectangle([0, sy + 9 * 78 + 6, W, sy + 9 * 78 + 16], fill=ver + (255,))

    # the seal: a stamped ring, slightly off-square, as stamps are
    seal = Image.new("RGBA", (760, 760), (0, 0, 0, 0))
    sd = ImageDraw.Draw(seal)
    sd.ellipse([20, 20, 740, 740], outline=ver + (235,), width=16)
    sd.ellipse([86, 86, 674, 674], outline=ver + (200,), width=5)
    sf = font("DejaVuSerif-Bold.ttf", 128)
    s1 = "PAID"
    sd.text((380, 350), s1, font=sf, fill=ver + (240,), anchor="mm")
    sd.text((380, 470), "IN FULL", font=font("DejaVuSans.ttf", 54),
            fill=ver + (225,), anchor="mm")
    seal = seal.rotate(-13, resample=Image.BICUBIC, expand=False)
    img.paste(seal, (960, 1930), seal)

    f_press = font("DejaVuSans-Bold.ttf", 30)
    tracked(d, (110, 106), b["press"].upper(), f_press, sand + (240,), 8)
    d.rectangle([110, 132, 110 + 96, 138], fill=ver + (255,))
    tracked(d, (110, 440), f'HARARE · {b["year"]}', f_press, ink + (170,), 7)

    f_title = font("DejaVuSerif-Bold.ttf", 168)
    y = 760
    for line in ["The Ledger", "and the", "Shopkeeper"]:
        d.text((104, y), line, font=f_title, fill=ink + (255,), anchor="ls")
        y += 176

    f_sub = font("DejaVuSerif.ttf", 56)
    block(d, (108, 1258), b["subtitle"], f_sub, ink + (225,), 1380, 74)

    f_auth = font("DejaVuSans-Bold.ttf", 44)
    tracked(d, (110, 1486), b["author"].upper(), f_auth, ink + (255,), 7)

    d.rectangle([110, 1556, W - 110, 1560], fill=ink + (200,))
    tracked(d, (110, 1616), "JACARANDA LABS · FIRST EDITION", font("DejaVuSans.ttf", 28),
            ink + (200,), 6)
    return grain(img, 6, seed=11)


def cover_intelligence(b):
    """Instrument: a textbook that looks like a plate from a lab."""
    night, cyan, amber, white = (9, 22, 38), (86, 196, 224), (238, 178, 92), (238, 244, 250)
    img = vertical_gradient((W, H), (12, 30, 52), (6, 14, 26))
    d = ImageDraw.Draw(img, "RGBA")

    for x in range(0, W, 60):
        d.line([(x, 0), (x, H)], fill=cyan + (14,), width=1)
    for y in range(0, H, 60):
        d.line([(0, y), (W, y)], fill=cyan + (14,), width=1)
    for x in range(0, W, 300):
        d.line([(x, 0), (x, H)], fill=cyan + (26,), width=1)
        for y in range(0, H, 40):
            d.line([(x, y), (x + 14, y)], fill=cyan + (40,), width=2)
    for y in range(0, H, 300):
        d.line([(0, y), (W, y)], fill=cyan + (26,), width=1)
        for x in range(0, W, 40):
            d.line([(x, y), (x, y + 14)], fill=cyan + (40,), width=2)

    # the argument: three planes, each one a translation of the last
    def plane(cx, cy, w, h, col, alpha, label, sub):
        pts = [(cx, cy - h // 2), (cx + w, cy - h // 2 + h // 4),
               (cx, cy + h // 2), (cx - w, cy - h // 2 + h // 4)]
        d.polygon(pts, fill=col + (alpha,), outline=col + (min(255, alpha + 90),))
        d.line(pts + [pts[0]], fill=col + (min(255, alpha + 120),), width=3)
        tracked(d, (cx - w, cy + h // 2 + 46), label, font("DejaVuSansMono-Bold.ttf", 34),
                white + (255,), 6)
        tracked(d, (cx - w, cy + h // 2 + 92), sub, font("DejaVuSansMono.ttf", 26),
                (176, 226, 240, 240), 4)

    plane(900, 1280, 470, 250, cyan, 60, "01  DATA", "recorded, not yet true")
    plane(900, 1620, 470, 250, amber, 46, "02  MODEL", "a claim about the record")
    plane(900, 1960, 470, 250, white, 30, "03  JUDGEMENT", "a decision someone owns")

    for y0, y1 in ((1405, 1495), (1745, 1835)):
        d.line([(900, y0), (900, y1)], fill=white + (110,), width=3)

    f_title = font("DejaVuSerif-Bold.ttf", 150)
    y = 430
    for line in ["Intelligence,", "Data", "and Judgement"]:
        d.text((140, y), line, font=f_title, fill=white + (255,), anchor="ls")
        y += 158

    d.rectangle([144, 300, 144 + 150, 306], fill=amber + (255,))
    tracked(d, (144, 268), b["press"].upper() + " · HARARE", font("DejaVuSans-Bold.ttf", 28),
            cyan + (235,), 8)

    f_sub = font("DejaVuSerif.ttf", 48)
    block(d, (144, 900), b["subtitle"], f_sub, white + (215,), 1500, 64)

    tracked(d, (144, 2460), b["author"].upper(), font("DejaVuSans-Bold.ttf", 42), white + (255,), 8)
    tracked(d, (144, 2520), "FIRST EDITION · 2026", font("DejaVuSansMono.ttf", 28), amber + (220,), 5)
    tracked(d, (144, 2600), "FIG. 1 — RAW RECORD, MODEL, AND THE PERSON WHO SIGNS",
            font("DejaVuSansMono.ttf", 24), cyan + (170,), 3)
    return grain(img, 4, seed=23)


def cover_governable(b):
    """Institutional: a governable object is a ruled object."""
    paper, ink, navy, red = (245, 243, 237), (20, 22, 26), (22, 38, 60), (178, 46, 38)
    img = Image.new("RGB", (W, H), paper)
    d = ImageDraw.Draw(img, "RGBA")

    d.rectangle([0, 0, W, 34], fill=navy + (255,))
    d.rectangle([0, 34, W, 44], fill=red + (255,))

    # left column: the claim
    x = 150
    tracked(d, (x, 210), b["press"].upper(), font("DejaVuSans-Bold.ttf", 28), navy + (230,), 8)
    tracked(d, (x, 252), "HARARE · 2026", font("DejaVuSansMono.ttf", 26), (90, 96, 104, 255), 5)

    d.rectangle([x, 330, x + 210, 342], fill=navy + (255,))

    f_title = font("DejaVuSans-Bold.ttf", 134)
    y = 540
    for line in ["The", "Governable", "Enterprise"]:
        d.text((x, y), line, font=f_title, fill=ink + (255,), anchor="ls")
        y += 146

    f_sub = font("DejaVuSans.ttf", 50)
    block(d, (x, 1010), b["subtitle"], f_sub, (70, 74, 80, 255), 1010, 68)

    d.rectangle([x, 1260, x + 1080, 1266], fill=ink + (255,))

    # the rules: evidence, authority, resources — as a ruled table
    rows = [("EVIDENCE", "what the system can show"),
            ("AUTHORITY", "what the system may do"),
            ("RESOURCES", "what the run may spend"),
            ("RECOVERY", "what happens when it is wrong")]
    f_lab, f_desc = font("DejaVuSansMono-Bold.ttf", 30), font("DejaVuSans.ttf", 34)
    ry = 1380
    for i, (lab, desc) in enumerate(rows):
        tracked(d, (x, ry), lab, f_lab, navy + (255,), 4)
        d.text((x + 400, ry), desc, font=f_desc, fill=(58, 62, 68, 255), anchor="ls")
        d.line([(x, ry + 30), (x + 1080, ry + 30)], fill=(20, 22, 26, 46), width=2)
        ry += 118

    # right-hand block: the ledger of the book itself
    d.rectangle([1230, 330, W, 1150], fill=navy + (255,))
    mono = font("DejaVuSansMono-Bold.ttf", 30)
    tracked(d, (1290, 430), "THE RECORD", mono, (238, 242, 248, 255), 6)
    d.line([(1290, 462), (1710, 462)], fill=(238, 242, 248, 120), width=2)
    facts = ["24 CHAPTERS", "221 PAGES", "10 TOOLS", "1 CASE", "0 CLAIMS", "UNVERIFIED"]
    fy = 540
    for fact in facts:
        tracked(d, (1290, fy), fact, font("DejaVuSansMono.ttf", 28), (206, 216, 230, 255), 4)
        fy += 92
    d.rectangle([1290, 1058, 1710, 1064], fill=red + (255,))

    d.rectangle([0, H - 300, W, H - 296], fill=ink + (255,))
    tracked(d, (150, H - 230), b["author"].upper(), font("DejaVuSans-Bold.ttf", 40), ink + (255,), 8)
    tracked(d, (150, H - 176), b["note"].upper(), font("DejaVuSansMono.ttf", 26),
            (96, 100, 108, 255), 4)
    tracked(d, (W - 150 - tracked_w(d, "DCAI · 2026", font("DejaVuSansMono-Bold.ttf", 26), 5), H - 176),
            "DCAI · 2026", font("DejaVuSansMono-Bold.ttf", 26), red + (230,), 5)
    return grain(img, 3, seed=31)


def cover_emotional(b):
    """Weather: soft thermal fields and one thin signal trace."""
    img = vertical_gradient((W, H), (247, 236, 228), (232, 213, 206))
    img = glow(img, 480, 380, 1000, (226, 150, 116), 1.1)     # blush
    img = glow(img, 1520, 820, 900, (150, 116, 182), 0.75)    # violet
    img = glow(img, 760, 2180, 1200, (236, 168, 128), 0.85)   # warmth from below
    img = img.filter(ImageFilter.GaussianBlur(2))
    d = ImageDraw.Draw(img, "RGBA")
    ink, plum = (42, 34, 38), (88, 66, 96)

    # concentric weather rings — thin, almost gone
    for i, r in enumerate(range(300, 2100, 86)):
        d.ellipse([1380 - r, 2160 - r, 1380 + r, 2160 + r],
                  outline=(116, 84, 108, max(10, 52 - i * 2)), width=3)

    # the trace: a signal that steadies
    pts = []
    for i in range(0, W + 1, 6):
        t = i / W
        amp = 90 * (1 - t) ** 2 + 8
        y = 1600 + math.sin(t * 26) * amp + math.sin(t * 61) * amp * 0.25
        pts.append((i, y))
    d.line(pts, fill=plum + (150,), width=5, joint="curve")
    d.ellipse([960 - 13, pts[160][1] - 13, 960 + 13, pts[160][1] + 13], fill=plum + (210,))

    tracked(d, (150, 250), b["press"].upper() + " · HARARE", font("DejaVuSans.ttf", 28),
            (74, 60, 70, 235), 9)
    d.rectangle([152, 288, 152 + 120, 292], fill=plum + (170,))

    f_title = font("DejaVuSerif.ttf", 148)
    y = 560
    for line in ["Emotional", "Engineering"]:
        d.text((146, y), line, font=f_title, fill=ink + (255,), anchor="ls")
        y += 156
    f_small = font("DejaVuSerif.ttf", 74)
    y = block(d, (146, 880), "for AI-Oriented", f_small, plum + (245,), 1500, 92)
    block(d, (146, y + 16), "Infrastructure Operators", f_small, plum + (245,), 1500, 92)

    f_sub = font("DejaVuSerif.ttf", 58)
    block(d, (150, 1300), b["subtitle"], f_sub, (58, 46, 54, 235), 1300, 80)

    tracked(d, (152, 2460), b["author"].upper(), font("DejaVuSans-Bold.ttf", 40), ink + (255,), 9)
    tracked(d, (152, 2520), b["note"].upper(), font("DejaVuSans.ttf", 26), (96, 80, 90, 220), 6)
    tracked(d, (152, 2590), "2026", font("DejaVuSansMono.ttf", 26), (96, 80, 90, 200), 6)
    return grain(img, 5, seed=43)


DESIGNS = {
    "vernacular": cover_ledger,
    "instrument": cover_intelligence,
    "institutional": cover_governable,
    "weather": cover_emotional,
}


# --------------------------------------------------------------------------- output

def write_cover_page(pdf_path, jpg_path):
    """A single-page PDF that is exactly the cover, for books whose interior is not in
    this repository. 432x648 pt = 6x9 in, the trim size the interiors use."""
    from pypdf import PdfWriter
    from PIL import Image as I
    src = I.open(jpg_path)
    w, h = 432, 648
    img = src.convert("RGB")
    img.save(pdf_path.with_suffix(".tmp.jpg"), quality=92)
    w_pdf, h_pdf = w, h
    # pypdf cannot draw; build the page from the JPEG with a tiny hand-made XObject.
    page_pdf = _jpeg_page_pdf(pdf_path.with_suffix(".tmp.jpg"), w_pdf, h_pdf)
    tmp = pdf_path.with_suffix(".tmp.pdf")
    tmp.write_bytes(page_pdf)
    writer = PdfWriter()
    writer.append(str(tmp))
    writer.write(str(pdf_path))
    tmp.unlink()
    pdf_path.with_suffix(".tmp.jpg").unlink()


def _jpeg_page_pdf(jpeg_path, w, h):
    data = Path(jpeg_path).read_bytes()
    objs = []
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(f"<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 {w} {h}] >>".encode())
    objs.append(b"<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> "
                b"/Contents 5 0 R >>")
    objs.append((f"<< /Type /XObject /Subtype /Image /Width 1800 /Height 2700 /ColorSpace "
                 f"/DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {len(data)} >>"
                 .encode(), data))
    content = f"q {w} 0 0 {h} 0 0 cm /Im0 Do Q".encode()
    objs.append((f"<< /Length {len(content)} >>".encode(), content))
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objs, 1):
        parts = obj if isinstance(obj, tuple) else (obj,)
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode()
        for j, part in enumerate(parts):
            out += part
            if j == 0 and len(parts) > 1:
                out += b"\nstream\n"
            elif len(parts) > 1 and j == 1:
                out += b"\nendstream"
        out += b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs)+1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").encode()
    return bytes(out)


def main():
    print_dir = Path(sys.argv[sys.argv.index("--print-dir") + 1]) if "--print-dir" in sys.argv \
        else Path("/tmp/covers")
    print_dir.mkdir(parents=True, exist_ok=True)
    PRINT_COVERS.mkdir(parents=True, exist_ok=True)
    WEB.mkdir(parents=True, exist_ok=True)

    for wid, b in BOOKS.items():
        art = DESIGNS[b["design"]](b)
        full = print_dir / f"{wid}-300.jpg"
        art.save(full, quality=94, subsampling=0, optimize=True)
        web = art.resize((WEBW, WEBH), Image.LANCZOS)
        web.save(WEB / f"{wid}.jpg", quality=86, subsampling=0, optimize=True)
        print(f"cover  {wid:13s} {b['design']:14s} print {full.stat().st_size:>8,} B  "
              f"web {(WEB / (wid + '.jpg')).stat().st_size:>7,} B")
        if wid in ("governable", "emotional"):
            page = PRINT_COVERS / f"{wid}-cover.pdf"
            write_cover_page(page, full)
            print(f"       cover page  {page.relative_to(ROOT)}  {page.stat().st_size:,} B")


if __name__ == "__main__":
    main()
