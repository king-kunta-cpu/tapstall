# Tapstall brand

One mark, one palette, everywhere — landing page, Whop store, socials, press. The system
extends what the product already wears (the UI kit's deep green + dark chrome) with a single
market colour, so the brand never disagrees with the software.

## The mark

A market stall: marigold awning with a scalloped edge, two posts, a counter — and at its
centre a **tap target**: the exact amount a customer taps to pay, which is the product in one
shape. Files:

| File | Use |
|---|---|
| `tapstall-mark.svg` | The mark alone (avatars, favicons, app icons) |
| `tapstall-logo.svg` | Lockup for light backgrounds |
| `tapstall-logo-dark.svg` | Lockup for dark backgrounds |
| `tapstall-avatar.png` (1024²) | Whop / social profile picture |
| `whop-cover.png` (1600×900) | Whop product cover / link preview |
| `social-card.png` (1080²) | Square social post base |
| `banner-1600x900.png` | Wide banner (README hero, Whop cover twin) |
| `banner-square.png` | Square banner (social post twin) |
| `og-banner.png` (1200×630) | Open Graph / Twitter card image for public pages |
| `favicon.svg` / `favicon.ico` | Browser tab icon (every page inlines the SVG as a data URI) |
| `favicon-16/32/48.png`, `apple-touch-icon.png` (180²), `icon-192.png`, `icon-512.png` | PNG icon set, generated from the avatar tile |

`pages/public/brand/` mirrors these files for the GitHub Pages host, which is
where public pages point their `og:image`/apple-touch-icon URLs. Product pages
themselves stay single-file: the favicon is an inlined SVG data URI and the
lockups are inline SVG, so branding costs no extra request and no KV read.
A shop with its own logo gets that logo as its storefront favicon; the mark
above is the platform fallback.

## Palette

| Name | Hex | Where it already lives |
|---|---|---|
| Stall Green | `#0B5B34` | `--accent` in `pages/kit.css` — primary |
| Marigold | `#FFB01E` | The awning — the one warm accent, use sparingly |
| Ink | `#0B0F14` | `--chrome` — dark surfaces, cover background |
| Paper | `#F4F6F8` | `--bg` — light surfaces |
| Mist | `#AEBBC7` | `--chrome-ink` — secondary text on dark |

## Type & voice

System sans everywhere (pages ship as single self-contained files; no webfonts on a 2G
handset). Headings tight and plain. Voice: exact about money, short sentences, no hype words —
the tagline is **"WhatsApp orders, paid properly."** Prices are always stated whole
($60/year, $7/month), never "from", never crossed-out theatre.

## Rules

- The mark never appears without its green tile at small sizes (the tile *is* the recognisable
  part in a feed).
- Don't recolour the awning; marigold is reserved for it and for the one call-to-action per surface.
- Seller/press material uses these files as-is — regenerate sizes from the SVGs rather than
  screenshotting the PNGs.
