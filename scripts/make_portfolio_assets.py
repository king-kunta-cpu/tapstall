#!/usr/bin/env python3
"""Generate the portfolio's mark: favicon set, app icons, and the animated avatar.

The mark is a jacaranda blossom drawn from primitives - five petals in the
flower's own violet, a gold centre, on the ink ground the site uses. It is drawn
here rather than borrowed so it is ours, it scales, and it can be re-cut at any
size without a designer in the loop.

Avatar: the same blossom, breathing, with a caret blinking beside the initials -
a small animation that says "still running" without pretending to be a photograph.

Run: python3 scripts/make_portfolio_assets.py
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "pages" / "public" / "portfolio"

INK = (21, 23, 26)
INK_SOFT = (30, 33, 37)
VIOLET = (124, 92, 168)
VIOLET_DEEP = (86, 62, 124)
VIOLET_LIGHT = (166, 136, 206)
GOLD = (224, 185, 120)
CREAM = (247, 244, 236)

SERIF_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSerif.ttf",
]


def font(size: int):
    for path in SERIF_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def petals(draw, cx, cy, r, fill, outline=None, width=0, petal_r=None, tilt=0.0):
    """Five petals arranged as a jacaranda flower, rotated by `tilt` radians."""
    petal_r = petal_r or r * 0.62
    for i in range(5):
        a = tilt + i * (2 * math.pi / 5) - math.pi / 2
        px = cx + math.cos(a) * r * 0.52
        py = cy + math.sin(a) * r * 0.52
        box = [px - petal_r, py - petal_r, px + petal_r, py + petal_r]
        draw.ellipse(box, fill=fill, outline=outline, width=width)


def mark(size: int, *, ground: bool = True, padding: float = 0.0) -> Image.Image:
    """The square mark at any size. Supersampled 4x then reduced for clean curves."""
    ss = 4
    s = size * ss
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if ground:
        radius = int(s * 0.22)
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=INK)
        # a hairline of violet keeps the tile from reading as a black square
        d.rounded_rectangle([ss, ss, s - ss - 1, s - ss - 1], radius=radius,
                            outline=VIOLET_DEEP, width=ss * 2)
    inset = s * padding
    cx = cy = s / 2
    r = (s / 2) - inset - s * 0.10
    petals(d, cx, cy, r, VIOLET, outline=VIOLET_LIGHT, width=max(1, int(s * 0.012)))
    # the centre: gold, with a small ink core so it reads at 16px
    core = r * 0.30
    d.ellipse([cx - core, cy - core, cx + core, cy + core], fill=GOLD)
    d.ellipse([cx - core * 0.42, cy - core * 0.42, cx + core * 0.42, cy + core * 0.42], fill=INK)
    return img.resize((size, size), Image.LANCZOS)


def favicon_svg() -> str:
    """The same flower as vector, for browsers that take it (all modern ones do)."""
    pts = []
    for i in range(5):
        a = i * (2 * math.pi / 5) - math.pi / 2
        pts.append((50 + math.cos(a) * 21, 50 + math.sin(a) * 21))
    petal_shapes = "\n".join(
        f'  <circle cx="{x:.2f}" cy="{y:.2f}" r="19" fill="#7c5ca8" stroke="#a688ce" stroke-width="1.1"/>'
        for x, y in pts
    )
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="Courage Garikai">
  <rect width="100" height="100" rx="22" fill="#15171a"/>
  <rect x="1.2" y="1.2" width="97.6" height="97.6" rx="21" fill="none" stroke="#563e7c" stroke-width="1.6"/>
  <g>
{petal_shapes}
  </g>
  <circle cx="50" cy="50" r="10.4" fill="#e0b978"/>
  <circle cx="50" cy="50" r="4.4" fill="#15171a"/>
</svg>
"""


def avatar_frames(size: int = 320) -> list[Image.Image]:
    """20 frames: the flower breathes, the caret blinks, a ring traces the rim."""
    frames = []
    n = 20
    for i in range(n):
        t = i / n
        breathe = 1 + 0.045 * math.sin(t * 2 * math.pi)
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)

        # ground
        d.ellipse([0, 0, size - 1, size - 1], fill=INK)
        d.ellipse([size * 0.015, size * 0.015, size * 0.985, size * 0.985],
                  outline=INK_SOFT, width=int(size * 0.02))

        # orbiting arc, drawn as short segments around the rim
        arc_r = size * 0.455
        start = t * 360
        for k in range(28):
            ang = math.radians(start + k * 3.2)
            fade = 1 - k / 28
            col = (int(GOLD[0] * fade + INK[0] * (1 - fade)),
                   int(GOLD[1] * fade + INK[1] * (1 - fade)),
                   int(GOLD[2] * fade + INK[2] * (1 - fade)))
            x = size / 2 + math.cos(ang) * arc_r
            y = size / 2 + math.sin(ang) * arc_r
            rr = size * 0.011
            d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=col)

        # the flower, sitting high enough to leave the initials their own line
        cx, cy = size / 2, size * 0.41
        r = size * 0.255 * breathe
        petals(d, cx, cy, r, VIOLET, outline=VIOLET_LIGHT, width=max(1, int(size * 0.006)),
               tilt=math.radians(t * 8))
        core = r * 0.32
        d.ellipse([cx - core, cy - core, cx + core, cy + core], fill=GOLD)
        d.ellipse([cx - core * 0.44, cy - core * 0.44, cx + core * 0.44, cy + core * 0.44], fill=INK)

        # the initials, under the flower, with a caret that blinks every other beat
        f = font(int(size * 0.13))
        label = "C·G"
        tw = d.textlength(label, font=f)
        ty = size * 0.755
        d.text((size / 2 - tw / 2 - size * 0.02, ty), label, font=f, fill=CREAM)
        if (i // 5) % 2 == 0:
            cw = size * 0.012
            ch = size * 0.105
            x0 = size / 2 + tw / 2 - size * 0.01
            d.rectangle([x0, ty + size * 0.015, x0 + cw, ty + size * 0.015 + ch], fill=GOLD)
        frames.append(img)
    return frames


def contact_cta_frames(w: int = 360, h: int = 128) -> list[Image.Image]:
    """The floating button: a pill that reads CONTACT ME, with a live dot and a
    breathing rim. Deliberately a pill rather than a bare circle — the words are
    the point, and a GIF that has to be explained has failed."""
    ss = 3
    W, H = w * ss, h * ss
    frames = []
    n = 18
    sans = None
    for path in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                 "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"):
        if Path(path).exists():
            sans = path
            break

    def ttf(size):
        return ImageFont.truetype(sans, size) if sans else ImageFont.load_default()

    for i in range(n):
        t = i / n
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        pad = int(10 * ss)
        r = (H - 2 * pad) // 2

        # breathing rim, drawn first so the pill sits on top of it
        pulse = 0.5 + 0.5 * math.sin(t * 2 * math.pi)
        rim = int(pad * (0.55 + 0.45 * pulse))
        d.rounded_rectangle([pad - rim, pad - rim, W - pad + rim, H - pad + rim],
                            radius=r + rim, outline=(224, 185, 120, int(90 + 90 * pulse)),
                            width=int(2.4 * ss))

        d.rounded_rectangle([pad, pad, W - pad, H - pad], radius=r, fill=INK,
                            outline=(224, 185, 120, 235), width=int(1.6 * ss))

        # the mark, small, at the left
        bx, by = pad + int(r * 1.05), H // 2
        br = int(r * 0.42)
        petals(d, bx, by, br, VIOLET, outline=VIOLET_LIGHT, width=ss,
               tilt=math.radians(t * 14))
        d.ellipse([bx - br * 0.34, by - br * 0.34, bx + br * 0.34, by + br * 0.34], fill=GOLD)

        # the words — sized to the space left between the mark and the live dot
        gx, gy = W - pad - int(r * 0.55), H // 2
        gr = int(r * 0.17)
        label = "CONTACT ME"
        x0 = bx + br + int(15 * ss)
        avail = (gx - gr * 3) - x0
        size = int(26 * ss)
        while size > int(9 * ss):
            f = ttf(size)
            spacing = 0.1 * size
            tw = sum(d.textlength(c, font=f) for c in label) + spacing * (len(label) - 1)
            if tw <= avail:
                break
            size -= ss
        f = ttf(size)
        spacing = 0.1 * size
        tw = sum(d.textlength(c, font=f) for c in label) + spacing * (len(label) - 1)
        x = x0 + (avail - tw) / 2
        y = H / 2 - size * 0.36
        for k, ch in enumerate(label):
            lift = math.sin((t * 2 * math.pi) - k * 0.45) * (1.2 * ss)
            d.text((x, y + lift), ch, font=f, fill=CREAM)
            x += d.textlength(ch, font=f) + spacing

        # a live dot, blinking on the beat — the only green on the site
        glow = int(60 + 120 * pulse)
        d.ellipse([gx - gr * 2, gy - gr * 2, gx + gr * 2, gy + gr * 2],
                  fill=(37, 211, 102, glow))
        d.ellipse([gx - gr, gy - gr, gx + gr, gy + gr], fill=(37, 211, 102, 255))

        frames.append(img.resize((w, h), Image.LANCZOS).convert("RGB"))
    return frames


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    png_dir = OUT / "brand"
    png_dir.mkdir(exist_ok=True)

    # favicon: .ico with the sizes browsers actually ask for, plus a vector and a PNG
    ico_sizes = [16, 32, 48, 64]
    ico_images = [mark(s) for s in ico_sizes]
    ico_images[-1].save(OUT / "favicon.ico", format="ICO",
                        sizes=[(s, s) for s in ico_sizes])
    (OUT / "favicon.svg").write_text(favicon_svg(), encoding="utf-8")
    mark(180).save(png_dir / "icon-180.png")
    mark(512).save(png_dir / "icon-512.png")
    mark(32).save(png_dir / "icon-32.png")

    # avatar: animated, plus a still for clients that will not play a GIF
    frames = avatar_frames(320)
    frames[0].save(OUT / "avatar.gif", save_all=True, append_images=frames[1:],
                   duration=90, loop=0, disposal=2, optimize=True)
    frames[0].save(OUT / "avatar.png")

    # the floating contact button
    cta = contact_cta_frames()
    pal = cta[0].quantize(colors=64, method=Image.MEDIANCUT)
    cta_q = [f.quantize(palette=pal, dither=Image.NONE) for f in cta]
    cta_q[0].save(OUT / "contact-me.gif", save_all=True, append_images=cta_q[1:],
                  duration=85, loop=0, optimize=True)

    for p in ["favicon.ico", "favicon.svg", "avatar.gif", "avatar.png", "contact-me.gif",
              "brand/icon-180.png", "brand/icon-512.png", "brand/icon-32.png"]:
        f = OUT / p
        print(f"{p:26s} {f.stat().st_size / 1024:8.1f} KB")


if __name__ == "__main__":
    main()
