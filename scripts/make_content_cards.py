#!/usr/bin/env python3
"""Render Tapstall's social card + motion library from the brand mark.

The press pipeline must never send a bare text post: every social item
carries either the shop's own product photo or one of these pillar cards,
and the exact-amount motion loop rotates in "here and there" instead of a
still. Rendering is done here, once, with PIL — the Worker only ever
fetches a finished PNG/MP4 from the Pages mirror and uploads it, so a post
costs no image-generation quota at send time.

Run: python3 scripts/make_content_cards.py
Outputs: brand/cards/*.png, brand/motion/*.{gif,mp4} + pages/public mirrors.
"""
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "brand"
PUBLIC = ROOT / "pages" / "public" / "brand"
W, H = 1200, 630
INK = (11, 15, 20)
GREEN = (11, 91, 52)
MARIGOLD = (255, 176, 30)
MIST = (174, 187, 199)
WHITE = (255, 255, 255)

FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

CARDS = {
    "exact-amount": ("EXACT AMOUNT", "The amount is\nthe reference", "Unique cents turn one payment\ninto one order — no screenshots."),
    "shop-math": ("SHOP MATH", "Know the rail cost\nbefore you quote", "Fees are a pricing decision,\nnot a month-end surprise."),
    "till-tips": ("TILL TIPS", "Small till habits,\nfewer disputes", "Practical routines for\nWhatsApp shops that trade daily."),
    "buyer-trust": ("BUYER TRUST", "Proof is a code,\nnot a screenshot", "Match the payment to the order\nin five seconds."),
    "menu-craft": ("MENU CRAFT", "A menu buyers\ncan scan", "Clear names, honest stock,\nprices that match at the till."),
    "books": ("BOOKS", "Books from\nthe ledger", "VAT and totals without\nSunday-night spreadsheets."),
    "promo": ("TAPSTALL", "WhatsApp orders,\npaid properly", "Free for 60 days · $60/year or $7/month\nNo commission on your sales."),
    "launch": ("GET STARTED", "Your shop link,\nready today", "Menu, orders and payment\nreferences in one place."),
}


def font(size, bold=True):
    return ImageFont.truetype(FONT_BOLD if bold else FONT, size)


def wrap(draw, text, fnt, max_w):
    out = []
    for para in text.split("\n"):
        words, line = para.split(), ""
        for w in words:
            trial = (line + " " + w).strip()
            if draw.textlength(trial, font=fnt) <= max_w or not line:
                line = trial
            else:
                out.append(line)
                line = w
        out.append(line)
    return out


def tile(size=180):
    icon = Image.open(BRAND / "icon-512.png").convert("RGB").resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size, size], radius=size // 5, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(icon, (0, 0), mask)
    return out


def gradient(w, h, left=INK, right=GREEN):
    img = Image.new("RGB", (w, h), left)
    px = img.load()
    for x in range(w):
        t = x / max(1, w - 1)
        c = tuple(round(left[i] + (right[i] - left[i]) * t) for i in range(3))
        for y in range(h):
            px[x, y] = c
    return img


def card(slug, kicker, headline, sub):
    img = gradient(W, H)
    d = ImageDraw.Draw(img, "RGBA")
    d.ellipse([W - 330, -180, W + 140, 280], fill=(255, 255, 255, 18))
    d.ellipse([W - 170, H - 150, W + 180, H + 170], fill=(255, 176, 30, 26))
    img.paste(tile(176), (64, 58), tile(176))
    d.text((264, 96), "Tapstall", font=font(44), fill=WHITE)
    d.text((266, 150), "WhatsApp orders, paid properly.", font=font(24, False), fill=MIST)
    d.rounded_rectangle([64, 286, 64 + d.textlength(kicker, font=font(22)) + 34, 332], radius=23, fill=(255, 176, 30, 255))
    d.text((81, 297), kicker, font=font(22), fill=INK)
    y = 356
    for line in wrap(d, headline, font(58), W - 140):
        d.text((64, y), line, font=font(58), fill=WHITE)
        y += 66
    for line in wrap(d, sub, font(27, False), W - 170):
        d.text((64, y + 8), line, font=font(27, False), fill=(207, 224, 238))
        y += 36
    d.text((64, H - 52), "tapstall.zlnew.workers.dev", font=font(21, False), fill=(143, 160, 175))
    return img


def motion_frames():
    """48 frames, 960x540: total -> exact amount -> paid. The fingerprint idea in 4 seconds."""
    frames = []
    mark = tile(150)
    for i in range(48):
        img = gradient(960, 540)
        d = ImageDraw.Draw(img, "RGBA")
        img.paste(mark, (48, 42), mark)
        d.text((222, 78), "Tapstall", font=font(42), fill=WHITE)
        d.text((224, 126), "WhatsApp orders, paid properly.", font=font(21, False), fill=MIST)
        phase = i // 16
        if phase == 0:
            d.text((48, 250), "Order total", font=font(30, False), fill=MIST)
            d.text((48, 292), "$12.00", font=font(76), fill=WHITE)
            d.text((48, 390), "Every buyer owes the same round number…", font=font(26, False), fill=(207, 224, 238))
        elif phase == 1:
            cents = round(43 * (i - 15) / 16)
            d.text((48, 250), "This order pays exactly", font=font(30, False), fill=MIST)
            d.text((48, 292), f"$12.{cents:02d}", font=font(76), fill=(255, 214, 110))
            d.text((48, 390), "Odd cents make the amount a fingerprint.", font=font(26, False), fill=(207, 224, 238))
        else:
            d.ellipse([48, 244, 128, 324], fill=(232, 247, 239, 255))
            d.line([(68, 285), (84, 301), (112, 264)], fill=GREEN, width=9, joint="curve")
            d.text((150, 262), "Paid properly.", font=font(54), fill=WHITE)
            d.text((48, 356), "One amount. One order. No screenshot to argue about.", font=font(25, False), fill=(207, 224, 238))
        d.rounded_rectangle([48, 486, 912, 498], radius=6, fill=(255, 255, 255, 36))
        d.rounded_rectangle([48, 486, 48 + int(864 * (i + 1) / 48), 498], radius=6, fill=MARIGOLD)
        frames.append(img)
    return frames


def main():
    (BRAND / "cards").mkdir(exist_ok=True)
    (BRAND / "motion").mkdir(exist_ok=True)
    for slug, (kicker, headline, sub) in CARDS.items():
        card(slug, kicker, headline, sub).save(BRAND / "cards" / f"{slug}.png", optimize=True)
    frames = motion_frames()
    frames[0].save(BRAND / "motion" / "exact-amount.gif", save_all=True, append_images=frames[1:],
                   duration=83, loop=0, optimize=True)
    try:
        import imageio.v2 as imageio
        import numpy as np
        writer = imageio.get_writer(BRAND / "motion" / "exact-amount.mp4", fps=24, codec="libx264",
                                    quality=7, macro_block_size=16, ffmpeg_params=["-pix_fmt", "yuv420p"])
        for fr in frames:
            writer.append_data(np.asarray(fr))
            writer.append_data(np.asarray(fr))
        writer.close()
    except Exception as e:  # the GIF still ships; MP4 is regenerated wherever ffmpeg exists
        print(f"mp4 skipped: {type(e).__name__}: {e}")
    for src in list((BRAND / "cards").glob("*.png")) + list((BRAND / "motion").glob("*")):
        dst = PUBLIC / src.parent.name / src.name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
    print(f"cards={len(CARDS)} motion_frames={len(frames)}")


if __name__ == "__main__":
    main()
