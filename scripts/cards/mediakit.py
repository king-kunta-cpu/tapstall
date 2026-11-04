#!/usr/bin/env python3
"""mediakit: the press's image engine. Every post on every rail ships with an image rendered here, in the runner, for $0.

Brand-agnostic: colours, wordmark, tagline, footer and fonts come from a brand file (press/brand.json), so the same
engine serves any Jacaranda Labs business. It draws only what it is given (real counts, real notice titles and
deadlines, the post's own headline), so a card can never say something the post doesn't.

Layouts
  stat      a big real number + what it counts, a source line, and up to N rows (title + date chip). Data posts.
  headline  a headline + a short body. Announcements and owner-queued posts.
Shapes
  square 1080x1080   Mastodon, Nostr, Facebook, Tumblr, Discord
  wide   1200x630    Bluesky link card, blog header (the 1.91:1 link-preview shape)
  pin    1000x1500   Pinterest (2:3)
  story  1080x1920   stories / reels covers

  python3 press/mediakit.py demo [outdir]      render every layout x shape with sample data
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
SHAPES = {"square": (1080, 1080), "wide": (1200, 630), "pin": (1000, 1500), "story": (1080, 1920)}
_FONT_CACHE: dict = {}


def load_brand(path: str | Path | None = None) -> dict:
    return json.loads(Path(path or HERE / "brand.json").read_text())


def font(brand: dict, size: int, bold: bool = False):
    name = brand.get("font_bold" if bold else "font", "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf")
    key = (name, size)
    if key not in _FONT_CACHE:
        for d in (HERE / "fonts", Path("/usr/share/fonts/truetype/dejavu")):
            if (d / name).is_file():
                _FONT_CACHE[key] = ImageFont.truetype(str(d / name), size)
                break
        else:
            raise FileNotFoundError(f"font {name} (put it in press/fonts)")
    return _FONT_CACHE[key]


def palette(brand: dict, seed: str) -> dict:
    """Same seed, same colours on every rail; different posts rotate so a feed doesn't look stamped."""
    pals = brand["palettes"]
    return pals[int(hashlib.sha1(seed.encode()).hexdigest(), 16) % len(pals)]


def wrap(d: ImageDraw.ImageDraw, text: str, f, width: int, max_lines: int = 99) -> list[str]:
    words, lines, cur = str(text).split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if d.textlength(t, font=f) <= width or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while last and d.textlength(last + "…", font=f) > width:
            last = last[:-1]
        lines[-1] = last.rstrip(" ,.;:-") + "…"
    for i, ln in enumerate(lines):  # a single unbreakable word wider than the box
        while d.textlength(ln, font=f) > width and len(ln) > 2:
            ln = ln[:-2] + "…"
        lines[i] = ln
    return lines


def fit_size(d, text: str, brand: dict, width: int, start: int, floor: int, bold=True, max_lines=1) -> int:
    s = start
    while s > floor and len(wrap(d, text, font(brand, s, bold), width)) > max_lines:
        s -= 4
    return s


class Canvas:
    def __init__(self, brand: dict, shape: str, seed: str):
        self.b, self.shape = brand, shape
        self.W, self.H = SHAPES[shape]
        self.p = palette(brand, seed)
        self.im = Image.new("RGB", (self.W, self.H), self.p["bg"])
        self.d = ImageDraw.Draw(self.im)
        self.k = self.W / 1080  # scale
        self.m = round(72 * self.k) if shape != "wide" else 60

    def s(self, v: float) -> int:
        return max(1, round(v * self.k))

    def text(self, xy, t, size, bold=False, fill="ink"):
        self.d.text(xy, t, font=font(self.b, size, bold), fill=self.p.get(fill, fill))

    def block(self, x, y, t, size, width, bold=False, fill="ink", max_lines=99, lh=1.22) -> int:
        f = font(self.b, size, bold)
        for ln in wrap(self.d, t, f, width, max_lines):
            self.d.text((x, y), ln, font=f, fill=self.p.get(fill, fill))
            y += round(size * lh)
        return y

    def header(self, kicker: str = "") -> int:
        m, s = self.m, self.s
        hs = 34 if self.shape == "wide" else s(40)
        logo = self.b.get("logo")
        if logo and (HERE / logo).is_file():  # optional brand mark (a square PNG) before the wordmark
            ls = round(hs * 1.9)
            mark = Image.open(HERE / logo).convert("RGBA").resize((ls, ls), Image.LANCZOS)
            self.im.paste(mark, (m, m), mark)
            self.text((m + ls + s(22), m + (ls - hs) // 2 - s(4)), self.b["name"], hs, True)
            if self.b.get("tagline"):
                self.text((m + ls + s(22), m + (ls - hs) // 2 + hs + s(4)), self.b["tagline"], round(hs * 0.55), False, "mut")
            hs_block = ls
        else:
            self.d.rectangle([m, m, m + s(110), m + s(10)], fill=self.p["acc"])
            self.text((m, m + s(26)), self.b["name"], hs, True)
            hs_block = s(26) + hs
        if kicker:
            f = font(self.b, round(hs * 0.62), True)
            tw = self.d.textlength(kicker, font=f)
            x0, y0 = self.W - m - tw - s(36), m + s(22)
            self.d.rounded_rectangle([x0, y0, self.W - m, y0 + round(hs * 0.62) + s(24)], radius=s(18), outline=self.p["mut"], width=2)
            self.d.text((x0 + s(18), y0 + s(10)), kicker, font=f, fill=self.p["mut"])
        return m + hs_block + s(30)

    def footer(self, left: str, right: str = "") -> int:
        m, s = self.m, self.s
        fh = s(118) if self.shape != "wide" else 74
        top = self.H - fh
        self.d.rectangle([0, top, self.W, self.H], fill=self.p["bg2"])
        size = s(30) if self.shape != "wide" else 26
        y = top + (fh - size) // 2 - 2
        if right:
            fr = font(self.b, size, True)
            rw = self.d.textlength(right, font=fr)
            self.d.text((self.W - m - rw, y), right, font=fr, fill=self.p["acc"])
            room = self.W - 2 * m - rw - s(30)
        else:
            room = self.W - 2 * m
        fl = font(self.b, size)
        self.d.text((m, y), wrap(self.d, left, fl, room, 1)[0], font=fl, fill=self.p["ink"])
        return top

    def png(self) -> bytes:
        buf = io.BytesIO()
        self.im.convert("P", palette=Image.ADAPTIVE, colors=128).save(buf, "PNG", optimize=True)
        return buf.getvalue()


def _rows(c: Canvas, x: int, y: int, width: int, bottom: int, rows: list, title: str, size: int, max_rows: int, dry: bool = False) -> int:
    """A panel of rows: date chip + title (2 lines max). Stops before `bottom`."""
    s, pad = c.s, c.s(28)
    if not rows:
        return y
    if not dry:  # measure first, so the panel hugs its rows
        end = _rows(c, x, y, width, bottom, rows, title, size, max_rows, dry=True)
        c.d.rounded_rectangle([x, y, x + width, min(bottom, end + pad - c.s(18))], radius=s(26), fill=c.p["bg2"])
    yy = y + pad
    if not dry:
        c.text((x + pad, yy), title.upper(), round(size * 0.78), True, "acc")
    yy += round(size * 0.78) + s(22)
    fchip = font(c.b, round(size * 0.8), True)
    chip_w = max(c.d.textlength(r.get("chip", ""), font=fchip) for r in rows[:max_rows]) + s(28)
    for r in rows[:max_rows]:
        lines = wrap(c.d, r["title"], font(c.b, size), width - 3 * pad - chip_w, 2)
        need = len(lines) * round(size * 1.22) + s(18)
        if yy + need > bottom - pad // 2:
            break
        ty = yy
        if not dry:
            c.d.rounded_rectangle([x + pad, yy - s(2), x + pad + chip_w, yy + round(size * 0.8) + s(16)], radius=s(12), fill=c.p["acc"])
            c.d.text((x + pad + s(14), yy + s(5)), r.get("chip", ""), font=fchip, fill=c.p["bg"])
            for ln in lines:
                c.d.text((x + 2 * pad + chip_w, ty), ln, font=font(c.b, size), fill=c.p["ink"])
                ty += round(size * 1.22)
        else:
            ty += len(lines) * round(size * 1.22)
        yy = ty + s(18)
    return yy


def render(layout: str, shape: str, data: dict, brand: dict | None = None) -> bytes:
    """data keys. stat: kicker, number, label, sub, rows[{chip, title}], rows_title, footer_left, footer_right, seed.
    headline: kicker, headline, body, footer_left, footer_right, seed."""
    brand = brand or load_brand()
    c = Canvas(brand, shape, data.get("seed") or data.get("headline") or data.get("label") or "x")
    W, H, m, s = c.W, c.H, c.m, c.s
    top = c.header(data.get("kicker", ""))
    right = data.get("footer_right") or (brand.get("footer_right", "") if shape == "wide" else brand.get("footer_right_short", brand.get("footer_right", "")))
    bottom = c.footer(data.get("footer_left") or brand.get("url", ""), right)
    gap = s(34)
    if layout == "stat":
        num, label, sub = str(data["number"]), data.get("label", ""), data.get("sub", "")
        if shape == "wide":
            colw = 520
            ns = fit_size(c.d, num, brand, colw, 170, 80)
            y = top - 6
            c.text((m, y), num, ns, True)
            y += round(ns * 1.08)
            ls = fit_size(c.d, label, brand, colw, 38, 28, max_lines=2)  # shrink a long label before cutting it
            y = c.block(m, y, label, ls, colw, True, max_lines=2, lh=1.15) + 10
            c.block(m, y, sub, 24, colw, False, "mut", max_lines=3)
            _rows(c, m + colw + 40, top - 4, W - m - (m + colw + 40), bottom - 26, data.get("rows", []), data.get("rows_title", ""), 23, 3)
        else:
            big = {"square": 190, "pin": 270, "story": 300}[shape]
            ns = fit_size(c.d, num, brand, W - 2 * m, s(big), s(110))
            y = top + s(10)
            c.text((m, y - s(10)), num, ns, True)
            y += round(ns * 1.02)
            y = c.block(m, y, label, s({"square": 54, "pin": 66, "story": 70}[shape]), W - 2 * m, True, max_lines=2, lh=1.12) + s(14)
            y = c.block(m, y, sub, s(32 if shape != "story" else 38), W - 2 * m, False, "mut", max_lines=2) + gap
            nrows = {"square": 3, "pin": 5, "story": 6}[shape]
            _rows(c, m, y, W - 2 * m, bottom - s(40), data.get("rows", []), data.get("rows_title", ""), s({"square": 28, "pin": 37, "story": 36}[shape]), nrows)
    elif layout == "headline":
        head, body = data.get("headline", ""), data.get("body", "")
        if shape == "wide":
            hs = fit_size(c.d, head, brand, W - 2 * m, 64, 40, max_lines=3)
            y = c.block(m, top + 4, head, hs, W - 2 * m, True, max_lines=3, lh=1.12) + 16
            c.block(m, y, body, 26, W - 2 * m, False, "mut", max_lines=max(1, (bottom - 20 - y) // 32))
        else:
            hs = fit_size(c.d, head, brand, W - 2 * m, s({"square": 84, "pin": 92, "story": 100}[shape]), s(54), max_lines=5)
            y = c.block(m, top + s(30), head, hs, W - 2 * m, True, max_lines=6, lh=1.12) + s(44)
            c.d.rectangle([m, y - s(22), m + s(80), y - s(16)], fill=c.p["acc"])
            bs = s(38 if shape != "story" else 44)
            c.block(m, y, body, bs, W - 2 * m, False, "ink", max_lines=max(1, (bottom - s(50) - y) // round(bs * 1.22)))
    else:
        raise ValueError(f"unknown layout {layout}")
    return c.png()


def alt_text(layout: str, data: dict, brand: dict | None = None) -> str:
    """Screen-reader and search text that says what the card shows, nothing more."""
    brand = brand or load_brand()
    if layout == "stat":
        rows = "; ".join(f"{r['title']} ({r.get('chip', '')})" for r in data.get("rows", [])[:3])
        t = f"{brand['name']} card: {data['number']} {data.get('label', '')}. {data.get('sub', '')}"
        if rows:
            t += f" {data.get('rows_title', 'Rows')}: {rows}."
    else:
        t = f"{brand['name']} card: {data.get('headline', '')}. {data.get('body', '')}"
    return re.sub(r"\s+", " ", t).strip()[:900]


SAMPLE_STAT = {"kicker": "4 NOV 2026", "number": "32", "label": "open public tenders in India today",
               "sub": "from UN agencies, the World Bank and UNDP", "rows_title": "Closing soonest", "seed": "IN",
               "rows": [{"chip": "6 Nov", "title": "Hiring consultancy firm for filing GST, VAT, IGST refund claims, ILO New Delhi"},
                        {"chip": "6 Nov", "title": "LTAs for Integrated Facilities Management Services at UN House, New Delhi"},
                        {"chip": "10 Nov", "title": "Civil works for rehabilitation of Mirzapur Dam, Punjab (DRIP)"},
                        {"chip": "11 Nov", "title": "Agency for DMP and DPR development for Uttar Pradesh"},
                        {"chip": "12 Nov", "title": "Dam rehabilitation civil works, Perch Dam, Punjab (DRIP-II)"},
                        {"chip": "14 Nov", "title": "Water supply consultancy"}]}
SAMPLE_HEAD = {"kicker": "NEW", "headline": "Open public tenders from 13 sources, by country, every morning",
               "body": "The World Bank, UN agencies, the EBRD, EU TED and national portals in one calm list. Soonest deadline first, each linked to the original.",
               "seed": "launch"}

if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "demo":
        out = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/mediakit-demo")
        out.mkdir(parents=True, exist_ok=True)
        for lay, dat in (("stat", SAMPLE_STAT), ("headline", SAMPLE_HEAD)):
            for sh in SHAPES:
                png = render(lay, sh, dat)
                (out / f"{lay}-{sh}.png").write_bytes(png)
                print(lay, sh, len(png))
    else:
        print(__doc__)
