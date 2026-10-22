#!/usr/bin/env python3
"""
The page behind every card.

Clicking a book or a paper in the catalogue used to start a download. It now lands
here: the jacket at full size, what the work argues, what is inside it, every format
with the name the reader will actually find in their downloads folder, and one button
that opens the reading edition and starts the download at the same time.

Nothing is invented. A work with no public edition says so on its own page rather than
offering a button that goes nowhere, and a cover that does not exist is not mocked up.

Reads the catalogue from scripts/make_portfolio.py — there is one list of works in this
repository and this script does not keep a second copy of it.

Usage:  python3 scripts/make_work_pages.py
Writes: pages/public/portfolio/works/<id>.html for every work in the catalogue
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import make_portfolio as mp   # noqa: E402  (the single source of truth for the catalogue)

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "pages" / "public" / "portfolio"
WORKS_DIR = OUT / "works"

# Where a work's own source lives, when it lives in this repository. The contents list
# is read out of the source, so it cannot drift from the book.
SOURCES = {
    "ledger": "book/Garikai-2026-The-Ledger-and-the-Shopkeeper.md",
    "intelligence": "book/Garikai-2026-Intelligence-Data-and-Judgement.md",
    "custody": "papers/Garikai-2026-Order-Without-Custody-DCAI-Working-Paper-3.md",
    "sovereign": "papers/Garikai-2026-The-Sovereign-Micro-Enterprise.md",
    "cadence": "papers/Garikai-2026-Grounded-Cadence.md",
}

PRINT_LABEL = {"PDF": "PDF", "EPUB": "EPUB", "HTML": "HTML", "MD": "Markdown"}


def contents(work):
    """Parts and chapters, straight out of the Markdown the edition was typeset from."""
    rel = SOURCES.get(work["id"])
    if not rel or not (ROOT / rel).exists():
        return []
    parts = []
    for line in (ROOT / rel).read_text(encoding="utf-8").splitlines():
        m = re.match(r"^(#{1,2})\s+(.*\S)\s*$", line)
        if not m:
            continue
        depth, title = len(m.group(1)), m.group(2)
        if depth == 1:
            parts.append([title, []])
        elif parts:
            parts[-1][1].append(title)
    # a single flat run of h1s is a paper, not a book: keep it readable
    return parts


def filename(url):
    return url.rsplit("/", 1)[-1]


def fmt_class(kind):
    return {"PDF": "pdf", "EPUB": "epub", "HTML": "html", "MD": "md"}.get(kind, "")


def contents_block(work):
    parts = contents(work)
    if not parts:
        return ""
    rows = []
    for title, chapters in parts:
        if chapters:
            items = "".join(f"<li>{mp.esc(c)}</li>" for c in chapters)
            rows.append(f'<li class="toc-part"><b>{mp.esc(title)}</b><ol>{items}</ol></li>')
        else:
            rows.append(f'<li class="toc-part"><b>{mp.esc(title)}</b></li>')
    return f"""
    <section class="inside">
      <h2>What is inside</h2>
      <p class="lede">The contents exactly as they are set in the edition — the same
      headings the file is typeset from, not a description of them.</p>
      <ol class="toc">{"".join(rows)}</ol>
    </section>"""


def download_block(work):
    """The one place on the site where a click both reads and downloads."""
    formats = list(work["formats"].items())
    if not formats:
        cover_pdf = work.get("cover_pdf")
        if cover_pdf:
            return f"""
      <div class="dl">
        <a class="btn" href="{mp.esc(cover_pdf)}" download>
          Download the jacket <span>PDF · 6 × 9 in · print-ready</span>
        </a>
        <p class="hint">The interior of this book is not distributed publicly. The jacket
        is the part of the edition that is published, so it is the part offered here —
        prepared at trim size, so it drops straight onto a printer's proof.</p>
      </div>"""
        return """
      <div class="dl">
        <p class="hint"><b>No public edition.</b> This entry is a catalogue record: the
        work exists and its status is stated above, but no text is distributed from this
        page. <a href="../#contact">Write to the press</a> about permissions or a review
        copy.</p>
      </div>"""

    primary_label, primary_url = formats[0]
    # the reading edition, if this run of the generator produced one
    local_read = OUT / "read" / f"{work['id']}.html"
    read = f"../read/{work['id']}.html" if local_read.exists() else ""
    pair = (f"{read}?dl={mp.urllib.parse.quote(primary_url, safe='')}" if read
            else primary_url)
    others = "".join(
        f'<li><a class="fmt fmt-{fmt_class(k)}" href="{mp.esc(u)}">'
        f'<span class="fmt-k">{mp.esc(PRINT_LABEL.get(k, k))}</span>'
        f'<span class="fmt-v">{mp.esc(filename(u))}</span></a></li>'
        for k, u in formats)
    return f"""
      <div class="dl">
        <a class="btn" href="{mp.esc(pair)}" data-pair="{mp.esc(primary_url)}">
          Download the {mp.esc(PRINT_LABEL.get(primary_label, primary_label))}
          <span>and read it in the browser, in the same click</span>
        </a>
        <p class="hint">One click does both: the reading edition opens and the file
        starts downloading. If your browser blocks one of the two, the formats below
        each work on their own.</p>
      </div>
      <h3 class="fmt-head">Every format</h3>
      <ul class="fmts">{others}</ul>"""


def head(work, title, description, canonical):
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="../favicon.ico" sizes="16x16 32x32 48x48 64x64">
<link rel="icon" type="image/svg+xml" href="../favicon.svg">
<link rel="apple-touch-icon" href="../brand/icon-180.png">
<meta name="theme-color" content="#15171a">
<meta property="og:title" content="{mp.esc(title)}">
<meta property="og:description" content="{mp.esc(description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="{mp.esc(canonical)}">
<meta property="og:image" content="{mp.esc(mp.SITE)}/brand/icon-512.png">
<title>{mp.esc(title)}</title>
<meta name="description" content="{mp.esc(description)}">
<meta name="author" content="{mp.esc(mp.AUTHOR)}">
<style>{CSS}</style>
</head>"""


CSS = """
:root{
  --paper:#faf7f0; --ink:#15171a; --accent:#a8332c; --muted:#6d6f74;
  --rule:#e3ded2; --panel:#14181c; --panel-ink:#f2eee4;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;
  --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html{background:var(--paper);-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;color:var(--ink);font:17px/1.62 var(--serif);background:var(--paper);
  padding-bottom:96px}
a{color:inherit}
img{max-width:100%;height:auto;display:block}
.wrap{max-width:1000px;margin:0 auto;padding:0 30px}

/* the bar across the top of every work page */
.bar{position:sticky;top:0;z-index:20;background:rgba(250,247,240,.94);
  backdrop-filter:saturate(140%) blur(8px);border-bottom:1px solid var(--rule)}
.bar .wrap{display:flex;align-items:center;justify-content:space-between;gap:18px;
  min-height:56px;flex-wrap:wrap;padding-top:6px;padding-bottom:6px}
.bar a.back{font:600 10px/1 var(--sans);letter-spacing:.18em;text-transform:uppercase;
  text-decoration:none;color:var(--ink)}
.bar a.back:hover{color:var(--accent)}
.bar .share{margin:0}
.bar .share .sh-label{display:none}

/* the head of the work */
.head{display:grid;grid-template-columns:300px minmax(0,1fr);gap:44px;align-items:start;
  padding:46px 0 10px}
.art{position:relative}
.art img{width:100%;border:1px solid var(--rule);box-shadow:0 24px 44px -30px rgba(20,18,16,.6)}
.kicker{font:600 9.5px/1 var(--sans);letter-spacing:.2em;text-transform:uppercase;
  color:var(--accent);margin:0 0 14px}
h1{font-size:clamp(30px,4.4vw,46px);line-height:1.08;letter-spacing:-.02em;margin:0 0 12px;
  font-weight:400}
.sub{font-size:19px;line-height:1.45;font-style:italic;color:#4d4a45;margin:0 0 20px}
.status{display:inline-block;font:600 9.5px/1 var(--sans);letter-spacing:.16em;
  text-transform:uppercase;color:var(--muted);border:1px solid var(--rule);
  border-radius:2px;padding:7px 9px;margin:0 0 20px}
.blurb{font-size:17.5px;line-height:1.62;margin:0 0 18px}
.note{font-size:15px;color:var(--muted);margin:0 0 22px}
.facts{font:600 9.5px/1.6 var(--sans);letter-spacing:.14em;text-transform:uppercase;
  color:#7c756a;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);
  padding:12px 0;margin:0 0 24px}

/* the download */
.dl{margin:0 0 26px}
.btn{display:inline-flex;flex-direction:column;gap:5px;text-decoration:none;
  background:var(--ink);color:var(--paper);padding:15px 24px;border-radius:3px;
  font:600 11px/1.2 var(--sans);letter-spacing:.16em;text-transform:uppercase;
  transition:background .15s}
.btn span{display:block;font:400 10.5px/1.3 var(--sans);letter-spacing:.04em;
  text-transform:none;color:#cfc8bb}
.btn:hover{background:var(--accent)}
.hint{font-size:14px;line-height:1.55;color:#5f5c57;margin:14px 0 0;max-width:56ch}
.hint a{color:var(--accent)}
.fmt-head{font:600 9.5px/1 var(--sans);letter-spacing:.2em;text-transform:uppercase;
  color:var(--muted);margin:26px 0 10px}
.fmts{list-style:none;margin:0;padding:0;display:grid;gap:0;
  border-top:1px solid var(--rule)}
.fmts li{border-bottom:1px solid var(--rule)}
.fmt{display:flex;align-items:baseline;gap:14px;padding:11px 2px;text-decoration:none;
  font-size:14px}
.fmt:hover .fmt-v{color:var(--accent)}
.fmt-k{flex:0 0 74px;font:600 9.5px/1 var(--sans);letter-spacing:.16em;
  text-transform:uppercase;color:var(--muted)}
.fmt-v{font-family:var(--mono);font-size:12.5px;color:#3d3a36;overflow-wrap:anywhere}


/* the jacket: artwork where it exists, a typographic panel where it does not */
.cover-art{aspect-ratio:3/4.3;position:relative;overflow:hidden;background:var(--panel);
  color:var(--panel-ink);padding:22px 20px;display:flex;flex-direction:column;
  justify-content:space-between}
.cover-art.has-art{background:#fff;padding:0;display:block;border:1px solid #d8d3c6;
  box-shadow:0 24px 44px -30px rgba(20,18,16,.6)}
.cover-art.has-art img{width:100%;height:100%;object-fit:contain;background:#fff;
  border:0;box-shadow:none}
.cover-art::after{content:"";position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(160deg,rgba(255,255,255,.05),rgba(0,0,0,.28))}
.cover-art.has-art::after{display:none}
.cover-art .cov-top{display:flex;justify-content:space-between;align-items:baseline;
  font:600 9px/1 var(--sans);letter-spacing:.18em;text-transform:uppercase;color:#b9b2a5;
  position:relative;z-index:1}
.cover-art .cov-year{color:#8d877c}
.cover-art .cov-body{position:relative;z-index:1}
.cover-art .cov-rule{width:32px;height:2px;background:var(--accent);margin-bottom:14px}
.cover-art h3{font:400 23px/1.18 var(--serif);letter-spacing:-.012em;margin:0;
  overflow-wrap:break-word;hyphens:auto}
.cover-art .cov-foot{display:flex;justify-content:space-between;font:600 9px/1 var(--sans);
  letter-spacing:.14em;text-transform:uppercase;color:#9d968a;position:relative;z-index:1}

/* the contents */
.inside{border-top:1px solid var(--ink);margin-top:34px;padding:32px 0 8px}
.inside h2{font-size:13px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;
  font-family:var(--sans);margin:0 0 10px}
.inside .lede{font-size:15px;color:var(--muted);margin:0 0 24px;max-width:60ch}
.toc{list-style:none;margin:0;padding:0;columns:2;column-gap:46px}
.toc-part{break-inside:avoid;margin:0 0 22px}
.toc-part>b{display:block;font:600 11px/1.3 var(--sans);letter-spacing:.12em;
  text-transform:uppercase;color:var(--accent);margin-bottom:6px}
.toc-part ol{list-style:none;margin:0;padding:0}
.toc-part li{font-size:14.5px;line-height:1.5;padding:3px 0;border-bottom:1px dotted #ddd7c8}


/* more from the author: a rail, not a slideshow — it scrolls, it snaps, and it never
   hides a work behind an animation nobody can pause */
.more-from{border-top:1px solid var(--ink);margin-top:38px;padding:30px 0 6px}
.mf-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;
  margin:0 0 18px}
.mf-head>div:first-child{flex:1 1 auto;min-width:0}
.mf-head h2{font-size:13px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;
  font-family:var(--sans);margin:0}
.mf-head .mf-sub{font-size:13.5px;color:var(--muted);margin:5px 0 0;max-width:68ch}
.mf-nav{display:flex;gap:6px;flex:0 0 auto}
.mf-nav button{width:32px;height:32px;display:grid;place-items:center;padding:0;cursor:pointer;
  border:1px solid var(--rule);border-radius:50%;background:transparent;color:var(--ink);
  font:400 14px/1 var(--sans);transition:background .15s,color .15s,border-color .15s}
.mf-nav button:hover:not(:disabled){background:var(--ink);border-color:var(--ink);
  color:var(--paper)}
.mf-nav button:disabled{opacity:.3;cursor:default}
.rail{list-style:none;margin:0;padding:0 0 14px;display:flex;gap:20px;overflow-x:auto;
  scroll-snap-type:x mandatory;scroll-behavior:smooth;scrollbar-width:thin;
  -webkit-overflow-scrolling:touch}
.rail:focus-visible{outline:2px solid var(--accent);outline-offset:6px}
.rail::-webkit-scrollbar{height:6px}
.rail::-webkit-scrollbar-track{background:transparent}
.rail::-webkit-scrollbar-thumb{background:#d8d2c4;border-radius:999px}
.rail-card{scroll-snap-align:start;flex:0 0 226px;min-width:0;display:flex;
  flex-direction:column;border-top:1px solid var(--rule);padding-top:14px}
.rail-cover{display:block;text-decoration:none}
.rail-cover img{width:100%;aspect-ratio:3/4.3;object-fit:cover;
  border:1px solid #d8d3c6;background:#fff;box-shadow:0 12px 22px -18px rgba(20,18,16,.55)}
.mini-art{display:flex;flex-direction:column;justify-content:space-between;
  aspect-ratio:3/4.3;padding:14px 13px;background:var(--panel);color:var(--panel-ink);
  box-shadow:0 12px 22px -18px rgba(20,18,16,.55)}
.ma-k{font:600 7.5px/1 var(--sans);letter-spacing:.18em;text-transform:uppercase;
  color:#b9b2a5}
.ma-r{display:block;width:24px;height:2px;background:var(--accent);margin:8px 0 auto}
.ma-t{font:400 14px/1.24 var(--serif);letter-spacing:-.01em;overflow-wrap:break-word;
  hyphens:auto;margin:0 0 10px}
.ma-a{font:600 7.5px/1 var(--sans);letter-spacing:.16em;text-transform:uppercase;
  color:#9d968a}
.rail-kicker{font:600 8.5px/1 var(--sans);letter-spacing:.18em;text-transform:uppercase;
  color:var(--accent);margin:12px 0 6px}
.rail-title{display:block;text-decoration:none;font:400 16.5px/1.22 var(--serif);
  letter-spacing:-.01em;margin:0 0 7px}
.rail-title:hover{color:var(--accent)}
.rail-desc{font-size:13px;line-height:1.5;color:#57534d;margin:0 0 13px;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.rail-btn{align-self:flex-start;margin-top:auto;text-decoration:none;border:1px solid var(--ink);
  border-radius:2px;padding:8px 12px;font:600 9px/1 var(--sans);letter-spacing:.16em;
  text-transform:uppercase;color:var(--ink);transition:background .15s,color .15s}
.rail-btn:hover{background:var(--ink);color:var(--paper)}
@media (max-width:860px){
  .rail{gap:14px}
  .rail-card{flex:0 0 196px}
  .mf-head{margin-bottom:14px}
  .mf-sub{display:none}
}
@media print{.more-from{display:none}}

/* about + pager */
.about{border-top:1px solid var(--rule);margin-top:34px;padding:30px 0 0;
  display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:40px}
.about h2{font-size:13px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;
  font-family:var(--sans);margin:0 0 12px}
.about p{font-size:16px;line-height:1.62}
.about .side dl{margin:0;font-size:14px}
.about .side dt{font:600 9.5px/1 var(--sans);letter-spacing:.16em;text-transform:uppercase;
  color:var(--muted);margin:14px 0 4px}
.about .side dd{margin:0;color:#3d3a36}
.pager{display:flex;justify-content:space-between;gap:20px;border-top:1px solid var(--rule);
  margin-top:34px;padding:22px 0 0;font-size:14px}
.pager a{text-decoration:none}
.pager a:hover{color:var(--accent)}
.pager .k{display:block;font:600 9px/1 var(--sans);letter-spacing:.18em;
  text-transform:uppercase;color:var(--muted);margin-bottom:5px}
.pager .next{text-align:right}
footer.colophon{border-top:1px solid var(--rule);margin-top:44px;padding:24px 0 40px;
  font-size:13px;color:var(--muted)}

@media (max-width:860px){
  .head{grid-template-columns:1fr;gap:26px}
  .art{max-width:280px}
  .toc{columns:1}
  .about{grid-template-columns:1fr;gap:24px}
  .wrap{padding:0 20px}
}
@media print{.bar,.fly,.pager{display:none}body{padding:0}}
""" + mp.SHARE_CSS


def more_from(work, works):
    """The other twelve, one scroll away: jacket, three lines, and a way in. A rail
    rather than a carousel — nothing rotates on a timer, nothing is hidden behind an
    animation, and without JavaScript it is simply a sideways scroll."""
    cards = []
    for other in works:
        if other["id"] == work["id"]:
            continue
        href = f"{other['id']}.html"
        if other.get("cover"):
            art = (f'<img src="../{mp.esc(other["cover"])}" loading="lazy" decoding="async" '
                   f'alt="Cover of {mp.esc(other["title"])}">')
        else:
            # no artwork: the same typographic panel the catalogue uses, cut small
            art = (f'<span class="mini-art">'
                   f'<span class="ma-k">{mp.esc(mp.KIND_LABEL[other["kind"]])} · '
                   f'{mp.esc(other["year"])}</span>'
                   f'<span class="ma-r"></span>'
                   f'<span class="ma-t">{mp.esc(other["title"])}</span>'
                   f'<span class="ma-a">{mp.esc(mp.AUTHOR)}</span></span>')
        cards.append(f"""
        <li class="rail-card">
          <a class="rail-cover" href="{href}" tabindex="-1" aria-hidden="true">{art}</a>
          <p class="rail-kicker">{mp.esc(mp.KIND_LABEL[other['kind']])} · {
              mp.esc(other['year'])}</p>
          <a class="rail-title" href="{href}">{mp.esc(other['title'])}</a>
          <p class="rail-desc">{mp.esc(other['subtitle'])}. {mp.esc(other['blurb'])}</p>
          <a class="rail-btn" href="{href}">See the details</a>
        </li>""")
    return f"""
  <section class="more-from" aria-labelledby="mf-title">
    <div class="mf-head">
      <div>
        <h2 id="mf-title">More from the author</h2>
        <p class="mf-sub">{len(cards)} other works — books, working papers and field
        reports. Each has a page of its own: what it argues, what is inside it, and
        every format that is published.</p>
      </div>
      <div class="mf-nav" id="mf-nav"></div>
    </div>
    <ul class="rail" id="rail" tabindex="0" role="region"
        aria-label="More works by {mp.esc(mp.AUTHOR)}, scroll sideways">
      {"".join(cards)}
    </ul>
  </section>"""


RAIL_SCRIPT = """
<script>
/* The arrows are created here rather than written into the page, so a reader without
   JavaScript never meets a control that cannot work — the rail is an ordinary
   horizontal scroll either way, and the arrow keys work once it has focus. */
(function(){
  var rail = document.getElementById('rail');
  var nav = document.getElementById('mf-nav');
  if (!rail || !nav) return;
  function mk(label, glyph){
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = glyph;
    b.setAttribute('aria-label', label);
    b.title = label;
    nav.appendChild(b);
    return b;
  }
  var prev = mk('Earlier works', '\u2190');
  var next = mk('Later works', '\u2192');
  function step(){
    var card = rail.querySelector('.rail-card');
    return card ? Math.round(card.getBoundingClientRect().width) + 20 : 250;
  }
  function sync(){
    var max = rail.scrollWidth - rail.clientWidth - 2;
    prev.disabled = rail.scrollLeft <= 2;
    next.disabled = rail.scrollLeft >= max;
  }
  prev.addEventListener('click', function(){
    rail.scrollBy({left: -step() * 2, behavior: 'smooth'});
  });
  next.addEventListener('click', function(){
    rail.scrollBy({left: step() * 2, behavior: 'smooth'});
  });
  rail.addEventListener('scroll', sync, {passive: true});
  window.addEventListener('resize', sync);
  sync();
})();
</script>
"""


def page(work, prev_work, next_work):
    canonical = f"{mp.SITE}/works/{work['id']}.html"
    kind = mp.KIND_LABEL[work["kind"]]
    title = f"{work['title']} — {mp.AUTHOR}"
    description = work["subtitle"]
    toc = contents_block(work)
    side = f"""
      <div class="side">
        <dl>
          <dt>Publisher</dt><dd>{mp.esc(work['publisher'])}</dd>
          <dt>Edition</dt><dd>{mp.esc(work['status'])}</dd>
          <dt>Extent</dt><dd>{mp.esc(mp.extent(work))}</dd>
          <dt>Licence</dt><dd>{mp.esc(work['licence'])}</dd>
          <dt>Year</dt><dd>{mp.esc(work['year'])}</dd>
        </dl>
      </div>"""
    nav = '<nav class="pager">'
    if prev_work:
        nav += (f'<a href="{prev_work["id"]}.html"><span class="k">Previous</span>'
                f'{mp.esc(prev_work["title"])}</a>')
    else:
        nav += "<span></span>"
    if next_work:
        nav += (f'<a class="next" href="{next_work["id"]}.html"><span class="k">Next</span>'
                f'{mp.esc(next_work["title"])}</a>')
    nav += "</nav>"

    share = mp.share_bar(canonical, f"{work['title']} — {mp.AUTHOR}", "Share this page")
    more_from_block = more_from(work, mp.WORKS)
    return head(work, title, description, canonical) + f"""
<body>
<header class="bar">
  <div class="wrap">
    <a class="back" href="../">← All books &amp; papers</a>
    {mp.share_bar(canonical, f"{work['title']} — {mp.AUTHOR}", "Share")}
  </div>
</header>

<main class="wrap">
  <article class="head">
    <div class="art">{mp.cover(work, "cover-art").replace('src="covers/', 'src="../covers/')}</div>
    <div>
      <p class="kicker">{mp.esc(kind)} · {mp.esc(work['year'])}</p>
      <h1>{mp.esc(work['title'])}</h1>
      <p class="sub">{mp.esc(work['subtitle'])}</p>
      <span class="status">{mp.esc(work['status'])}</span>
      <p class="blurb">{mp.esc(work['blurb'])}</p>
      <p class="note">{mp.esc(work['note'])}</p>
      <p class="facts">{mp.facts(work)}</p>
      {download_block(work)}
    </div>
  </article>
  {toc}
  <section class="about">
    <div>
      <h2>About this page</h2>
      <p>This is the record for one work in the catalogue: what it argues, what is inside
      it, and every file that is actually published. Where a statement of extent or
      status is qualified in the catalogue, it is qualified here too — a working paper is
      not called peer-reviewed, and a bounded case study is not called a customer
      success.</p>
      <p><b>How the file is produced.</b> Text-native works are written in Markdown and
      typeset from that single source into PDF, EPUB, HTML and Markdown. The jacket is
      drawn from the work's own metadata by a script in the same repository, so it can be
      re-cut at another trim size without a designer in the loop.</p>
      {share}
    </div>
    {side}
  </section>
  {more_from_block}
  {nav}
</main>
<footer class="colophon"><div class="wrap">
  {mp.esc(mp.AUTHOR)} · {mp.esc(mp.PRESS)} · {mp.esc(mp.YEAR)} ·
  <a href="../">the full catalogue</a>
</div></footer>
{mp.float_contact("../")}
{RAIL_SCRIPT}
</body>
</html>
"""


def main():
    WORKS_DIR.mkdir(parents=True, exist_ok=True)
    works = mp.WORKS
    for i, w in enumerate(works):
        prev_w = works[i - 1] if i else None
        next_w = works[i + 1] if i + 1 < len(works) else None
        path = WORKS_DIR / f"{w['id']}.html"
        path.write_text(page(w, prev_w, next_w), encoding="utf-8")
        print(f"works/{w['id']}.html  {path.stat().st_size:>7,} B  "
              f"{'with contents' if contents(w) else 'no public contents'}")
    print(f"\n{len(works)} work pages written")


if __name__ == "__main__":
    main()
