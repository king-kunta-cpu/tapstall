#!/usr/bin/env python3
"""
The pages a site is expected to have, and the files machines read before they read
anything else.

Seven pages: privacy, FAQ, permissions and press, accessibility, how the site is
built, terms, and contact. They are generated from the same catalogue the rest of
the site is built from, so a page count, a licence or a work title cannot go stale.

And the layer that decides whether anyone finds them:

  robots.txt        at the site root, with the AI crawlers allowed by name — being
                    readable by the engines that answer questions is the point
  sitemap.xml       every public URL, with a lastmod
  llms.txt          the same catalogue written for language models: what this site
                    is, who wrote it, what each work is, and where the primary
                    sources are
  feed.xml          an Atom feed, so a reader or a crawler can subscribe
  og/*.jpg          a 1200x630 share card per work, drawn from the cover and the
                    metadata — the picture that shows up when a link is pasted

Usage:  python3 scripts/make_site_pages.py [--no-og]
"""
import datetime
import html
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
import make_portfolio as mp          # noqa: E402  the catalogue, the constants
import make_portfolio_assets as mpa  # noqa: E402  the mark, for the share cards

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "pages" / "public"
OUT = PUBLIC / "portfolio"
OG_DIR = OUT / "og"
TODAY = datetime.date.today().isoformat()
SITE = mp.SITE

FONTS = Path("/usr/share/fonts/truetype/dejavu")
INK, PAPER, ACCENT, MUTED = "#15171a", "#faf7f0", "#a8332c", "#6d6f74"
PANEL = "#14181c"


# --------------------------------------------------------------------------- colour maths
def _lin(c):
    c = c / 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def contrast(fg, bg):
    def lum(h):
        h = h.lstrip("#")
        r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
        return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)
    a, b = sorted((lum(fg), lum(bg)), reverse=True)
    return (a + 0.05) / (b + 0.05)


R_BODY = contrast(INK, PAPER)
R_MUTED = contrast(MUTED, PAPER)
R_ACCENT = contrast(ACCENT, PAPER)
R_PANEL = contrast("#cfc8bb", PANEL)


def ratio(r):
    return f"{r:.1f}:1"


# --------------------------------------------------------------------------- shared shell
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
body{margin:0;color:var(--ink);font:17px/1.66 var(--serif);background:var(--paper);
  padding-bottom:96px}
a{color:inherit}
.wrap{max-width:760px;margin:0 auto;padding:0 30px}
.wide{max-width:1000px}
.bar{position:sticky;top:0;z-index:20;background:rgba(250,247,240,.94);
  backdrop-filter:saturate(140%) blur(8px);border-bottom:1px solid var(--rule)}
.bar .wrap{display:flex;align-items:center;justify-content:space-between;gap:18px;
  min-height:56px;flex-wrap:wrap;padding-top:6px;padding-bottom:6px}
.bar a.back{font:600 10px/1 var(--sans);letter-spacing:.18em;text-transform:uppercase;
  text-decoration:none}
.bar a.back:hover{color:var(--accent)}
.bar .share{margin:0}
.bar .share .sh-label{display:none}

header.page{padding:52px 0 8px}
.kicker{font:600 9.5px/1 var(--sans);letter-spacing:.2em;text-transform:uppercase;
  color:var(--accent);margin:0 0 16px}
h1{font-size:clamp(30px,4.6vw,44px);line-height:1.1;letter-spacing:-.02em;margin:0 0 16px;
  font-weight:400}
.lede{font-size:19.5px;line-height:1.55;color:#4b4843;margin:0 0 30px;max-width:34em}
.prose h2{font-size:20px;line-height:1.3;margin:38px 0 10px;letter-spacing:-.01em;
  font-weight:400;padding-top:20px;border-top:1px solid var(--rule)}
.prose h2:first-child{border-top:0;padding-top:0;margin-top:26px}
.prose h3{font:600 11px/1.4 var(--sans);letter-spacing:.16em;text-transform:uppercase;
  margin:26px 0 8px;color:var(--muted)}
.prose p{margin:0 0 16px}
.prose ul,.prose ol{margin:0 0 18px;padding-left:22px}
.prose li{margin:0 0 8px}
.prose li::marker{color:var(--accent)}
.prose a{color:var(--accent);text-decoration:underline;text-decoration-thickness:1px;
  text-underline-offset:2px}
.prose strong{font-weight:600}
.prose code{font-family:var(--mono);font-size:.86em;background:#f1ece0;padding:1px 5px;
  border-radius:2px;overflow-wrap:anywhere;word-break:break-word}
.prose pre code{display:block;padding:12px 14px;white-space:pre-wrap}
.note{border-left:2px solid var(--accent);padding:2px 0 2px 16px;margin:24px 0;
  font-size:15.5px;color:#4b4843}
.small{font-size:13.5px;color:var(--muted)}
dl.facts{margin:0 0 22px;border-top:1px solid var(--rule)}
dl.facts div{display:flex;gap:18px;padding:11px 0;border-bottom:1px solid var(--rule)}
dl.facts dt{flex:0 0 150px;font:600 9.5px/1.6 var(--sans);letter-spacing:.16em;
  text-transform:uppercase;color:var(--muted)}
dl.facts dd{margin:0;flex:1 1 auto;min-width:0}
table.lic{width:100%;border-collapse:collapse;font-size:14px;margin:0 0 22px;
  table-layout:fixed}
table.lic td,table.lic th{overflow-wrap:anywhere;hyphens:auto}
table.lic th{text-align:left;font:600 9px/1 var(--sans);letter-spacing:.16em;
  text-transform:uppercase;color:var(--muted);padding:0 10px 8px 0;border-bottom:1px solid var(--ink)}
table.lic td{padding:10px 10px 10px 0;border-bottom:1px solid var(--rule);vertical-align:top}
table.lic td:last-child,table.lic th:last-child{padding-right:0}
.qa{border-top:1px solid var(--rule);padding:22px 0 4px}
.qa h2{color:var(--ink);border:0;padding:0;margin:0 0 8px;font-size:21px}
.qa p{margin:0 0 14px}
.qa p:last-child{margin-bottom:0}
.toc{list-style:none;padding:0;margin:0 0 34px;columns:2;column-gap:34px;font-size:14.5px}
.toc li{margin:0 0 7px;break-inside:avoid}
.toc a{text-decoration:none;border-bottom:1px solid var(--rule)}
.toc a:hover{color:var(--accent);border-color:var(--accent)}
.panel{background:var(--panel);color:var(--panel-ink);padding:26px 28px;margin:30px 0;
  border-radius:3px}
.panel h2{margin:0 0 10px;font-size:19px;border:0;padding:0;color:var(--panel-ink)}
.panel p{color:#cfc8bb;margin:0 0 12px;font-size:15.5px}
.panel a{color:#e0b978}
footer.colophon{border-top:1px solid var(--rule);margin-top:52px;padding:26px 0 44px;
  font-size:13px;color:var(--muted)}
footer.colophon .site-nav{display:flex;flex-wrap:wrap;gap:8px 18px;margin:0 0 14px;
  font:600 9.5px/1.6 var(--sans);letter-spacing:.16em;text-transform:uppercase}
footer.colophon .site-nav a{text-decoration:none;color:var(--ink)}
footer.colophon .site-nav a:hover{color:var(--accent)}
@media (max-width:640px){
  .toc{columns:1}
  table.lic{font-size:12.5px}
  table.lic th:nth-child(3),table.lic td:nth-child(3){display:none}
  dl.facts div{flex-direction:column;gap:2px}
  dl.facts dt{flex:none}
  .wrap{padding:0 20px}
  .panel{padding:22px}
}
@media print{.bar,.fly,footer.colophon .site-nav{display:none}body{padding:0}}
""" + mp.SHARE_CSS

SITE_NAV = [
    ("Index", "../"),
    ("Books &amp; papers", "../#books"),
    ("Research", "../#research"),
    ("Built", "../#built"),
    ("Consulting", "../#consult"),
    ("FAQ", "../faq/"),
    ("Permissions", "../permissions/"),
    ("Contact", "../contact/"),
    ("How it is built", "../how-it-is-built/"),
    ("Accessibility", "../accessibility/"),
    ("Privacy", "../privacy/"),
    ("Terms", "../terms/"),
]


def site_nav(prefix="../"):
    links = "".join(
        f'<a href="{href.replace("../", prefix, 1)}">{label}</a>'
        for label, href in SITE_NAV)
    return f'<nav class="site-nav" aria-label="Site">{links}</nav>'


def jsonld(obj):
    return ('<script type="application/ld+json">'
            + json.dumps(obj, ensure_ascii=False, indent=None) + "</script>")


def person_ref():
    return {"@type": "Person", "name": mp.AUTHOR, "url": SITE + "/"}


def page_shell(slug, title, description, kicker, lede, body, structured=None,
               prefix="../"):
    url = f"{SITE}/{slug}/"
    head_ld = jsonld(structured) if structured else ""
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="{prefix}favicon.ico" sizes="16x16 32x32 48x48 64x64">
<link rel="icon" type="image/svg+xml" href="{prefix}favicon.svg">
<link rel="apple-touch-icon" href="{prefix}brand/icon-180.png">
<meta name="theme-color" content="#15171a">
<title>{mp.esc(title)}</title>
<meta name="description" content="{mp.esc(description)}">
<meta name="author" content="{mp.esc(mp.AUTHOR)}">
<link rel="canonical" href="{url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="{mp.esc(mp.AUTHOR)}">
<meta property="og:title" content="{mp.esc(title)}">
<meta property="og:description" content="{mp.esc(description)}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{SITE}/og/home.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{mp.esc(title)}">
<meta name="twitter:description" content="{mp.esc(description)}">
<meta name="twitter:image" content="{SITE}/og/home.jpg">
{head_ld}
<style>{CSS}</style>
</head>
<body>
<header class="bar">
  <div class="wrap">
    <a class="back" href="{prefix}">← Books &amp; papers</a>
    {mp.share_bar(url, title, "Share")}
  </div>
</header>
<main class="wrap">
  <header class="page">
    <p class="kicker">{kicker}</p>
    <h1>{mp.esc(title)}</h1>
    <p class="lede">{lede}</p>
  </header>
  <div class="prose">
{body}
  </div>
</main>
<footer class="colophon"><div class="wrap">
  {site_nav(prefix)}
  {mp.esc(mp.AUTHOR)} · {mp.esc(mp.PRESS)} · {mp.TEAR if hasattr(mp, "TEAR") else mp.YEAR} ·
  <a href="{prefix}">the full catalogue</a>
</div></footer>
{mp.float_contact(prefix)}
</body>
</html>
"""


# --------------------------------------------------------------------------- the pages
def privacy_page():
    body = f"""
    <h2 id="short">The short version</h2>
    <p>This site is a folder of HTML files. It sets no cookies, runs no analytics, loads
    no scripts, fonts or images from anyone else's server, and has no advertising on it.
    Nothing about you is collected by the site itself. That is not a promise bolted on at
    the end — it is the reason the site can be checked: view the source of any page and
    there is nothing to find.</p>

    <h2 id="host">What the host sees</h2>
    <p>The pages are served by <strong>GitHub Pages</strong>. Like any web server, it
    receives the request: your IP address, the page asked for, the time, your browser's
    user-agent, and any referrer. GitHub holds that in its own logs under
    <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement"
    rel="noopener" target="_blank">GitHub's privacy statement</a>, not under this site's
    control. Downloads are served from GitHub's release hosting for the same reason —
    the file transfer is GitHub's, and it sees the request that fetches it.</p>
    <p>No IP address, referrer or user-agent from those logs is copied into this
    repository, and nothing here can read them.</p>

    <h2 id="contact">If you write</h2>
    <p>Email goes to <a href="mailto:couragegarikai@atomicmail.io">couragegarikai@atomicmail.io</a>.
    Calls, WhatsApp and Telegram go to the two numbers on the
    <a href="../contact/">contact page</a> — those conversations are held by your phone
    network and by those applications, under their terms as well as mine.</p>
    <p>What is kept: the message, so it can be answered, and the thread afterwards, so a
    second conversation does not start from nothing. What is not done: no address is
    added to a mailing list, there is no newsletter to unsubscribe from, and no message
    is sold, rented or handed to a marketing tool.</p>

    <h2 id="button">The contact button</h2>
    <p>The floating button at the bottom of the page is an animated image. It links to
    WhatsApp; nothing is sent, and WhatsApp is not opened, until you click it. The small
    circle beside it starts a phone call in the same way.</p>

    <h2 id="not">What this site does not do</h2>
    <ul>
      <li>No analytics, tag manager, session recording, heat map or A/B test.</li>
      <li>No cookies — first-party or third-party. There is no consent banner because
      there is nothing to consent to.</li>
      <li>No advertising, sponsorships, affiliate links or retargeting pixels.</li>
      <li>No fingerprinting, and no attempt to identify a reader from their device.</li>
      <li>No embedded video, map, font or widget that would phone home on load.</li>
      <li>No email capture, pop-up, exit-intent modal or chat widget.</li>
    </ul>

    <h2 id="products">The products have their own pages</h2>
    <p>Tapstall, Open Practice, ContentOps, DeskOS, STPi and the Bluesky Growth Audit are
    separate systems with their own statements about what they collect. This page covers
    this site only, and it does not speak for them.</p>

    <h2 id="rights">Your rights, in plain terms</h2>
    <p>Because this site holds nothing, there is nothing here to export or erase. If you
    have written to me, you can ask what is held and ask for it to be deleted; a reply
    saying what was done is enough, and no form is needed. If you are in a jurisdiction
    that gives you a formal right of access or erasure, write and cite it — it will be
    honoured the same way.</p>

    <h2 id="children">Children</h2>
    <p>The site is written for adults working on systems. It is not directed at children
    under 13 and does not knowingly collect anything from anyone.</p>

    <h2 id="changes">Changes</h2>
    <p>This page is generated from the repository with the rest of the site, so its
    wording is versioned. Last generated <strong>{TODAY}</strong>. If tracking is ever
    added — it is not planned — it will be added to this page before it is added to the
    site.</p>
    """
    return page_shell(
        "privacy",
        "Privacy",
        "This site sets no cookies, runs no analytics and loads nothing from third parties. "
        "What the host sees, what happens when you write, and what the products do separately.",
        "Privacy · no cookies, no analytics",
        "Nothing here profiles you. This page says exactly what happens to a visit, what "
        "happens to a message, and where the site's responsibility stops and the host's begins.",
        body,
        structured={
            "@context": "https://schema.org",
            "@type": "WebPage",
            "name": "Privacy",
            "url": f"{SITE}/privacy/",
            "isPartOf": {"@type": "WebSite", "url": SITE + "/"},
            "publisher": person_ref(),
            "dateModified": TODAY,
        })


def faq_items():
    """Question and answer, as data — the page and the FAQPage markup read the same list."""
    return [
        ("What is autonomous cognitive infrastructure?",
         f"""It is the layer above an application: the part that decides what to do next,
         records why, and can be audited afterwards. An app waits for a person to press a
         button; this layer hunts, drafts, checks, files and escalates — and writes down
         every step so a human can disagree with it later. {mp.AUTHOR} builds it for
         markets where bandwidth, power and trust are all constrained, and writes about it
         in the working papers in the <a href="../#research">research section</a>."""),
        ("Who is behind this?",
         f"""{mp.AUTHOR} — autonomous cognitive infrastructure engineer, operator and
         writer, working from Harare, Zimbabwe. Fifteen years of techno-preneurship,
         including the failures; a BSc in Entrepreneurship and Business Management
         (Creativity) and an MSc in Applied Entrepreneurship (Innovation and Technology)
         from Chinhoyi University of Technology. The <a href="../#about">about section</a>
         is the long version, and the <a href="../contact/">contact page</a> is the short
         one."""),
        ("What is Jacaranda Labs?",
         """The company. It owns the products on this site — Tapstall, STPi, DeskOS,
         ContentOps, Open Practice and the Bluesky Growth Audit — and it owns Jacaranda
         Labs Think Tank, which funds the research, the books and the papers. Editions are
         published under Jacaranda Labs Press. See <a href="../#company">the company
         section</a>."""),
        ("Are the books free?",
         """Where a work is marked <strong>CC BY 4.0</strong> it is free to read, download
         and reuse with attribution. Where it is marked <strong>all rights reserved</strong>
         it is free to read here but not to republish. Two works are catalogued without a
         public edition, and their pages say so rather than offering a link that goes
         nowhere. <a href="../permissions/">Permissions</a> lists every work and its
         licence in one table."""),
        ("What formats do the works come in?",
         """PDF, EPUB, HTML and Markdown for every text-native work — one Markdown source,
         typeset four ways, so a reader needs no particular app and can read offline. The
         HTML edition is also served as a reading page here, so a work can be read in the
         browser without downloading anything."""),
        ("Are the research papers peer reviewed?",
         """No, and no page says they are. They are working papers and a field report in
         the DCAI series: bounded, single-case, and explicit about what has not been
         proven, who the sample was, and what would falsify the claim. A working paper is
         not dressed as a journal article here."""),
        ("Can I quote, teach from, or republish a work?",
         """Quote briefly with attribution and a link — always fine. Teaching: CC BY 4.0
         works may be used in a course with attribution. Republishing a whole work,
         translating it, or printing it for sale: write first, whether the licence strictly
         requires it or not. <a href="../permissions/">Permissions</a> has the details and a
         citation format."""),
        ("Do you hold merchant money?",
         """No. The commerce rail is built so that money moves directly between a buyer and
         the merchant's own account; the system records and reconciles, it does not hold.
         That is a design rule, not a policy that could quietly change — the platform's
         tests fail if custody is introduced."""),
        ("Do you use AI to build the systems, or write the books?",
         """Both answers are yes and neither is a secret. The systems are agentic by
         design — that is the subject. The production of the books and this site is partly
         scripted: the catalogue, the jacket artwork, the share cards and these pages are
         generated from one repository, and the pages say which. The arguments, the cases
         and the failures come from systems that were run, and the parts that were
         constructed rather than observed are labelled as such in the work itself. A
         reader is entitled to know which is which, and the works are written to make that
         possible."""),
        ("How is this site built?",
         """One repository, one Python script per artefact, no framework and no database.
         <a href="../how-it-is-built/">How it is built</a> walks through it, including what
         it costs to run and what breaks the build on purpose."""),
        ("How does a consulting engagement start?",
         """With a message that says what the system has to do, who uses it, and what
         happens today when it fails. That is enough for a first conversation. If it is not
         a fit, that is said in the first call rather than in a proposal nobody believes.
         There is no scarcity clock and no availability theatre on this site —
         <a href="../#consult">the consulting section</a> says why."""),
        ("Is the site accessible?",
         """It is built to be: semantic headings, keyboard paths, visible focus, no
         autoplay that cannot be stopped, and text contrast measured rather than eyeballed.
         The <a href="../accessibility/">accessibility statement</a> states what was tested,
         what the numbers are, and what is known to fall short."""),
    ]


def faq_page():
    items = faq_items()
    toc = "".join(f'<li><a href="#q{i}">{mp.esc(q)}</a></li>'
                  for i, (q, _) in enumerate(items, 1))
    body = f"""
    <ul class="toc" aria-label="Questions on this page">{toc}</ul>
    {"".join(f'<section class="qa" id="q{i}"><h2>{mp.esc(q)}</h2><p>{a}</p></section>'
             for i, (q, a) in enumerate(items, 1))}
    <div class="panel">
      <h2>Still unanswered?</h2>
      <p>Write to <a href="mailto:couragegarikai@atomicmail.io">couragegarikai@atomicmail.io</a>
      with the question. Questions that more than one person asks get added to this page,
      with the answer given here first.</p>
    </div>
    """
    structured = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "url": f"{SITE}/faq/",
        "name": "Frequently asked questions",
        "isPartOf": {"@type": "WebSite", "url": SITE + "/"},
        "author": person_ref(),
        "dateModified": TODAY,
        "mainEntity": [
            {"@type": "Question", "name": q,
             "acceptedAnswer": {"@type": "Answer",
                                "text": mp_re.sub(r"<[^>]+>", "", a).strip()}}
            for q, a in items],
    }
    return page_shell(
        "faq",
        "Frequently asked questions",
        "What autonomous cognitive infrastructure is, who is behind the work, what is free, "
        "what is peer reviewed, whether merchant money is held, and how a project starts.",
        "FAQ",
        "Twelve questions that come up in the first conversation, answered here so the "
        "second conversation can be about the work.",
        body, structured=structured)


def permissions_page():
    rows = []
    for w in mp.WORKS:
        lic = w["licence"]
        rows.append(
            f'<tr><td><a href="../works/{w["id"]}.html">{mp.esc(w["title"])}</a><br>'
            f'<span class="small">{mp.esc(mp.KIND_LABEL[w["kind"]])} · {mp.esc(w["status"])}</span></td>'
            f'<td>{mp.esc(lic)}</td>'
            f'<td>{"Public — " + str(len(w["formats"])) + " format(s)" if w["formats"] else "No public edition"}</td></tr>')
    body = f"""
    <h2 id="site">The site itself</h2>
    <p>The writing on these pages is © {mp.AUTHOR}, {mp.YEAR}, unless a work says
    otherwise. Short quotation with attribution and a link is welcome and needs no
    permission. Republishing a page whole, or feeding this site into a product that
    resells it, is not covered by that.</p>
    <p>The <strong>design, the mark, the jacket artwork, the share cards and the
    illustrations</strong> are made for these works. Use them to write about the works —
    a review, a citation, a course page — and do not use them as anyone else's branding.</p>

    <h2 id="works">Every work, and its licence</h2>
    <p>The licence is a property of the work, not of the site. This table is generated
    from the catalogue, so it cannot drift from what each work page says.</p>
    <table class="lic">
      <thead><tr><th>Work</th><th>Licence</th><th>Public text</th></tr></thead>
      <tbody>{"".join(rows)}</tbody>
    </table>
    <p class="small"><strong>CC BY 4.0</strong> permits sharing and adaptation, including
    commercially, as long as the author is credited and changes are indicated.
    <strong>All rights reserved</strong> means what it says: read here, ask before reusing.</p>

    <h2 id="cite">How to cite</h2>
    <p>Papers and books, in a form that survives being copied:</p>
    <p><code>{mp.esc(mp.AUTHOR)} ({mp.YEAR}). <em>Order Without Custody: Governance-First
    Design for Merchant Commerce Rails in Low-Infrastructure Economies</em>. DCAI working
    paper 3. Jacaranda Labs Think Tank. {SITE}/works/custody.html</code></p>
    <p>For a web page: author, title of the page, the site, the date you read it, the URL.
    Every work page is stable — it is regenerated from the same catalogue entry, not
    renumbered — so a link from a syllabus will not rot into a 404.</p>

    <h2 id="press">Press and review copies</h2>
    <dl class="facts">
      <div><dt>Contact</dt><dd><a href="mailto:couragegarikai@atomicmail.io">couragegarikai@atomicmail.io</a>
      · calls <a href="tel:+263779674212">+263 77 967 4212</a></dd></div>
      <div><dt>Based</dt><dd>Harare, Zimbabwe — CAT/SAST (UTC+2)</dd></div>
      <div><dt>Review copies</dt><dd>Every public edition is already free to download from
      its own page; nothing needs to be requested for those. For the two works without a
      public edition, write and say who you are writing for and what you are writing.</dd></div>
      <div><dt>Interviews</dt><dd>Email, a call, or a recorded conversation. Answers about
      systems that were actually run are the easy ones; answers about numbers that were
      never measured are refused rather than estimated.</dd></div>
      <div><dt>Images</dt><dd>The jacket artwork for each work, at 1800 × 2700, is in the
      repository and can be supplied on request. The author portrait is a drawn mark, not
      a photograph — it is deliberate, and it is available at any size.</dd></div>
    </dl>

    <h2 id="bio">A bio you can paste</h2>
    <p><strong>One line.</strong> Courage Garikai is an autonomous cognitive infrastructure
    engineer, operator and writer in Harare, building merchant rails and agent systems for
    low-infrastructure markets, and publishing the research and the failures behind
    them.</p>
    <p><strong>Fifty words.</strong> Courage Garikai builds autonomous cognitive
    infrastructure in Harare: systems that decide, record and can be audited — merchant
    commerce rails, operator consoles, hiring and content agents. He owns Jacaranda Labs,
    whose think tank funds his research, books and papers. Fifteen years of
    techno-preneurship, including the failures, and a public catalogue of thirteen
    works.</p>

    <h2 id="teaching">Teaching, and course use</h2>
    <p>Works marked CC BY 4.0 may be used in teaching with attribution — no email needed,
    though knowing where they are being taught is useful. For works marked all rights
    reserved, ask; permission for a class is normally given the same day.</p>

    <h2 id="elsewhere">Translations, editions, and other uses</h2>
    <p>Write with the language, the territory and what you intend to do. The answer will
    be specific rather than a form letter, and it will not take a month.</p>
    """
    return page_shell(
        "permissions",
        "Permissions, press and citation",
        "The licence of every work in one table, how to cite a paper, what press can use, "
        "ready-to-paste bios, and how to ask for a review copy or a translation.",
        "Press · permissions · citation",
        "What may be quoted, what may be reused, and how to credit it — stated per work "
        "rather than in a paragraph of lawyer's fog.",
        body,
        structured={
            "@context": "https://schema.org",
            "@type": "WebPage",
            "name": "Permissions, press and citation",
            "url": f"{SITE}/permissions/",
            "author": person_ref(),
            "dateModified": TODAY,
        })


def accessibility_page():
    body = f"""
    <h2 id="approach">The approach</h2>
    <p>The site is hand-built HTML with no framework, no client-side rendering and no
    third-party assets. That removes a whole class of accessibility failures at the root:
    there is no injected widget to fight, no font that fails to load, no script that
    decides whether the text appears. What remains is typography, structure and focus —
    the parts that can be checked.</p>

    <h2 id="tested">What was actually tested</h2>
    <ul>
      <li>Keyboard-only navigation through every page: tab order follows the page, the
      skip targets are real headings, focus is visible.</li>
      <li>Text zoom to 200 % and 400 % at a 1280 px and a 390 px viewport, checking that
      nothing is clipped and the page does not scroll sideways.</li>
      <li>Rendering at 390, 768, 1024, 1280 and 1440 px; <code>scrollWidth</code> is
      asserted against the viewport width on the catalogue, every work page, the reading
      editions and the DeskOS page, because a page that scrolls sideways is a page that
      cannot be read on a phone.</li>
      <li>Contrast, calculated rather than eyeballed. Body text on paper is
      <strong>{ratio(R_BODY)}</strong>; the secondary grey is <strong>{ratio(R_MUTED)}</strong>;
      the accent red used for links and kickers is <strong>{ratio(R_ACCENT)}</strong>;
      the light grey on the dark panel in the editions is
      <strong>{ratio(R_PANEL)}</strong>. All exceed the 4.5:1 required for normal text
      (the accent is used above 18.66 px bold or for non-text accents where it does not
      carry meaning on its own).</li>
      <li>Reduced motion: if your system asks for less movement, the two looping images —
      the avatar in the consulting section and the floating contact button — are replaced
      by their still frames, and the hover transforms are switched off.</li>
    </ul>

    <h2 id="structure">Structure</h2>
    <p>One <code>h1</code> per page, headings in order after it, landmarks
    (<code>header</code>, <code>main</code>, <code>nav</code>, <code>footer</code>), a
    skip path through the masthead, and links whose text says where they go — no "click
    here". Decorative images carry empty <code>alt</code>; jackets carry the title they
    belong to.</p>

    <h2 id="motion">Animation</h2>
    <p>Two things on this site move: the avatar beside the consulting heading, and the
    floating contact button. Both are GIFs, so they cannot be paused by a control — that
    is a real limitation and it is stated rather than hidden. Both respect
    <code>prefers-reduced-motion</code>, both are small, and neither carries information
    that is lost if it stops. Nothing else on the site animates on its own.</p>

    <h2 id="limits">Where it falls short</h2>
    <ul>
      <li><strong>The PDFs are not reflowable.</strong> A fixed 6 × 9 page does not
      re-hex at 400 % zoom. This is why every text-native work also ships as HTML and
      EPUB, and why the HTML reading edition is one click from each work page.</li>
      <li><strong>The reading editions are the book's own design.</strong> Wide tables
      inside them scroll inside their own box on a small screen rather than shrinking the
      type.</li>
      <li><strong>No formal audit.</strong> The checks above are the author's own. No
      third-party accessibility audit has been commissioned, and the site does not claim
      conformance it has not had tested. If that changes, this page will say so.</li>
      <li><strong>One author.</strong> There is no accessibility team and no ticketing
      system; there is an email address, and it is read.</li>
    </ul>

    <h2 id="report">If something blocks you</h2>
    <p>Write to <a href="mailto:couragegarikai@atomicmail.io">couragegarikai@atomicmail.io</a>
    and say what you were trying to do and what happened instead. Barrier reports are
    treated as defects, not as feature requests, and fixed in the next build of the site.
    If you need any work in another form — a large-print PDF, a plain-text file, a
    differently structured document — ask, and it will be produced.</p>
    """
    return page_shell(
        "accessibility",
        "Accessibility",
        "What was tested, the measured contrast ratios, how the two animations behave under "
        "reduced motion, and where the site is known to fall short.",
        "Accessibility · statement",
        "Built to be read: no client-side rendering, no third-party assets, measured "
        "contrast, and an honest list of what falls short.",
        body,
        structured={
            "@context": "https://schema.org",
            "@type": "WebPage",
            "name": "Accessibility",
            "url": f"{SITE}/accessibility/",
            "author": person_ref(),
            "dateModified": TODAY,
        })


def built_page():
    body = f"""
    <h2 id="why">Why this page exists</h2>
    <p>A site that argues for auditable systems should be able to show its own working.
    This one can: every page here is generated by a script in a public repository, from
    one list of works, and the build fails on purpose if something private is about to be
    published. Nothing on this page is a claim about craft — it is a description of
    machinery you can read.</p>

    <h2 id="shape">The shape of it</h2>
    <dl class="facts">
      <div><dt>Catalogue</dt><dd>One Python file holds the works as data: title, subtitle,
      status, extent, licence, blurb, formats. {len(mp.WORKS)} entries.</dd></div>
      <div><dt>Pages</dt><dd>The catalogue page, {len(mp.WORKS)} work pages, the reading
      editions, the legal and FAQ pages, and a JSON copy of the catalogue — all emitted
      from that one list, so a page and its data cannot disagree.</dd></div>
      <div><dt>Artwork</dt><dd>The mark, the favicon set, the animated avatar, the contact
      button and the four jacket designs are drawn by scripts — deterministic, at any size,
      no stock imagery and no design tool in the loop.</dd></div>
      <div><dt>Deliverables</dt><dd>Books typeset from Markdown into PDF, EPUB, HTML and
      Markdown. The PDF is the same source as the HTML; the jacket is bound in as page one,
      so pagination and the contents page do not shift.</dd></div>
      <div><dt>Hosting</dt><dd>Static files on GitHub Pages; downloads as release assets.
      No database, no server process, no framework. The monthly cost of this site is
      zero.</dd></div>
      <div><dt>Tests</dt><dd>The merchant rail that sits beside this site carries 420
      assertions, and the publishing scripts carry their own checks: every download link
      must point into the repository or its release assets, or the build stops.</dd></div>
    </dl>

    <h2 id="gate">The gate that fails the build</h2>
    <p>Before any page is written, a checker reads every text file that is about to be
    published and looks for the things that must never appear in public: credentials,
    private hosts, machine paths, spreadsheet identifiers, and email addresses that are not
    the published one. A single hit stops the build with the file and line number. This is
    not a policy document; it is a script, and it runs on every build.</p>

    <h2 id="privacy">Why there is nothing to track you with</h2>
    <p>The site has no analytics because it needs none to be maintained, and because a page
    about governance that phones a third party on load is an argument that refutes itself.
    The privacy page is short for the same reason: there is very little to disclose.</p>

    <h2 id="read">Reading it</h2>
    <p>Everything on the site is plain HTML, CSS and images served as files. Open the
    source of any page and you will see the whole thing — there is no bundle to untangle
    and no build step at the reader's end. The catalogue is also published as JSON for
    anyone who wants the list without scraping it:
    <a href="../catalogue.json">catalogue.json</a>. A summary written for language models
    is at <a href="../../llms.txt">llms.txt</a>, and the feed is at
    <a href="../feed.xml">feed.xml</a>.</p>

    <h2 id="fail">What breaks it</h2>
    <ul>
      <li>A download link that leaves the repository — the build refuses to publish it.</li>
      <li>An email address that is not the published one — the build refuses to publish it.</li>
      <li>A work whose title, blurb, status or format list is missing — the build stops and
      names the work.</li>
      <li>A page that scrolls sideways at 390 px — caught by measuring
      <code>scrollWidth</code> against the viewport before the change is accepted.</li>
    </ul>
    """
    return page_shell(
        "how-it-is-built",
        "How this site is built",
        "One catalogue file, one script per artefact, generated jackets and share cards, a "
        "privacy gate that fails the build, and a site that costs nothing to run.",
        "Colophon · the machinery",
        "Every page here is generated from one repository. This is the description of that "
        "machinery — including the checks that stop it publishing something it should not.",
        body,
        structured={
            "@context": "https://schema.org",
            "@type": "WebPage",
            "name": "How this site is built",
            "url": f"{SITE}/how-it-is-built/",
            "author": person_ref(),
            "dateModified": TODAY,
        })


def contact_page():
    body = f"""
    <h2 id="channels">Channels</h2>
    <dl class="facts">
      <div><dt>Email</dt><dd><a href="mailto:couragegarikai@atomicmail.io">couragegarikai@atomicmail.io</a>
      — the best first move for anything that needs a record</dd></div>
      <div><dt>Calls</dt><dd><a href="tel:+263779674212">+263 77 967 4212</a></dd></div>
      <div><dt>WhatsApp</dt><dd><a href="https://wa.me/263784600904" rel="noopener">+263 78 460 0904</a></dd></div>
      <div><dt>Telegram</dt><dd><a href="https://t.me/+263784600904" rel="noopener">+263 78 460 0904</a></dd></div>
      <div><dt>Where</dt><dd>Jacaranda Labs, Harare, Zimbabwe — CAT/SAST, UTC+2</dd></div>
      <div><dt>Hours</dt><dd>Weekdays, and often past them. If it is urgent, say so and why;
      urgency claimed is not urgency shown.</dd></div>
    </dl>

    <h2 id="first">What a good first message contains</h2>
    <ol>
      <li>What the system has to do — in one sentence a stranger could repeat.</li>
      <li>Who uses it, and what they do today instead.</li>
      <li>What happens when it fails today. "Nothing yet" is a fine answer.</li>
      <li>The constraint that actually binds: money, bandwidth, power, staff, a regulator,
      or a person who will say no.</li>
    </ol>
    <p>That is enough for a first conversation. If the problem is not one this practice can
    help with, that is said in the first call rather than after a proposal nobody
    believes.</p>

    <h2 id="elsewhere">Elsewhere</h2>
    <p>The practice publishes in public:</p>
    <ul>
      <li><a href="https://github.com/king-kunta-cpu/tapstall" rel="noopener">The repository</a>
      — the systems, the books' sources, and the scripts that build this site.</li>
      <li><a href="https://jacaranda-labs.whop.site/" rel="noopener">Jacaranda Labs</a> and
      <a href="https://stpi.whop.site/" rel="noopener">STPi</a> — storefronts for the
      products.</li>
      <li><a href="https://tapstall.zlnew.workers.dev/" rel="noopener">Tapstall</a>,
      <a href="https://open-practice.zlnew.workers.dev/" rel="noopener">Open Practice</a>,
      <a href="https://contentops-edge.simalidudu.workers.dev/demo" rel="noopener">ContentOps</a>,
      <a href="https://bsky-audit.simalidudu.workers.dev/" rel="noopener">Bluesky Growth
      Audit</a> — the running systems, open now.</li>
      <li><a href="../deskos/">DeskOS</a> — the operator command centre, described.</li>
    </ul>

    <h2 id="press">Writing about the work</h2>
    <p>Bios, licences, images and review copies are on
    <a href="../permissions/">Permissions</a>. The <a href="../faq/">FAQ</a> answers the
    twelve questions that arrive most often.</p>

    <div class="panel">
      <h2>One thing worth saying plainly</h2>
      <p>There is no intake form, no funnel and no calendar link. A message arrives at a
      person who reads it, and it is answered — usually the same day, sometimes with a
      question instead of an answer, because the question is the useful part.</p>
      <p><a href="mailto:couragegarikai@atomicmail.io">couragegarikai@atomicmail.io</a></p>
    </div>
    """
    return page_shell(
        "contact",
        "Contact",
        "Email, calls, WhatsApp and Telegram, what a good first message contains, and where "
        "the systems can be seen running.",
        "Contact · Harare, CAT/SAST",
        "One person reads these. Say what the system has to do, who uses it, and what "
        "happens today when it fails — that is enough to start.",
        body,
        structured={
            "@context": "https://schema.org",
            "@type": "ContactPage",
            "name": "Contact",
            "url": f"{SITE}/contact/",
            "mainEntity": {
                "@type": "Person",
                "name": mp.AUTHOR,
                "email": "couragegarikai@atomicmail.io",
                "telephone": "+263779674212",
                "address": {"@type": "PostalAddress", "addressLocality": "Harare",
                            "addressCountry": "ZW"},
            },
            "dateModified": TODAY,
        })


def terms_page():
    body = f"""
    <h2 id="what">What this site is</h2>
    <p>This is the public record of a practice: a catalogue of published works, a
    description of the systems that were built, and a way to make contact. It is
    information, not advice.</p>

    <h2 id="accuracy">Accuracy, and what is not claimed</h2>
    <p>Each work states its own edition status — first edition, complete first edition,
    working manuscript, working paper, author-review edition, or a catalogue entry with no
    public text. Those labels are meant literally. A working paper is not peer reviewed. A
    single-case study is not a measured customer outcome. Where a number has not been
    measured it is not stated; where an example was constructed it is labelled as
    constructed.</p>
    <p>Nothing here is financial, legal, tax or medical advice, and nothing here is a
    promise about what a system will earn. Descriptions of running products describe what
    is running at the time of writing.</p>

    <h2 id="warranty">No warranty</h2>
    <p>The site and everything downloadable from it are provided as they are, without
    warranty of any kind. Links to other sites — GitHub, the product subdomains, WhatsApp
    — are there because they are useful; what those sites do is theirs, not this site's.</p>

    <h2 id="liability">Liability</h2>
    <p>To the extent the law allows, this practice is not liable for loss arising from use
    of the free material published here. Paid engagements are governed by the written
    scope agreed for that engagement, not by this page.</p>

    <h2 id="licence">Licence of the material</h2>
    <p>Each work carries its own licence, listed work by work on
    <a href="../permissions/">Permissions</a>. The site's own prose is © {mp.AUTHOR},
    {mp.YEAR}. Quotation with attribution and a link is welcome.</p>

    <h2 id="conduct">Conduct</h2>
    <p>No scraping of this site to train a product that resells it, no bulk cold outreach
    to the addresses published here, and no impersonation of the author or the company. If
    you want to cite or reproduce at scale, write — the answer is usually yes, in writing.</p>

    <h2 id="law">Governing law</h2>
    <p>This site is published from Harare, Zimbabwe, and any dispute about it falls under
    the law of Zimbabwe. <span class="small">(A one-line statement of jurisdiction; the
    author should confirm this is the intended one before it is relied on.)</span></p>

    <h2 id="changes">Changes</h2>
    <p>This page is versioned with the repository and regenerated with it. Last generated
    <strong>{TODAY}</strong>.</p>
    """
    return page_shell(
        "terms",
        "Terms",
        "What this site is, what its edition labels actually mean, the warranty it does not "
        "carry, how the material is licensed, and which law applies.",
        "Terms · the site",
        "Short, specific, and free of clauses nobody reads. The claims are what the works "
        "say they are, and the licence is per work.",
        body,
        structured={
            "@context": "https://schema.org",
            "@type": "WebPage",
            "name": "Terms",
            "url": f"{SITE}/terms/",
            "dateModified": TODAY,
        })


# --------------------------------------------------------------------------- robots, sitemap, feed
def write_robots():
    txt = f"""# {mp.AUTHOR} — {SITE}/
#
# Everything here is meant to be read, linked and quoted. The engines that answer
# questions are allowed by name: the point of publishing research in the open is to be
# read by whatever a person happens to ask.

User-agent: *
Allow: /

User-agent: Googlebot
Allow: /

User-agent: Bingbot
Allow: /

User-agent: DuckDuckBot
Allow: /

User-agent: GPTBot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Applebot
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: CCBot
Allow: /

# One thing is asked of anyone indexing this: cite the work and the person, not just
# the domain. The citation formats are on /portfolio/permissions/.

Sitemap: {SITE.replace('/portfolio', '')}/sitemap.xml
"""
    (PUBLIC / "robots.txt").write_text(txt, encoding="utf-8")
    return PUBLIC / "robots.txt"


def sitemap_urls():
    urls = [
        (f"{SITE}/", "1.0", "weekly"),
        (f"{SITE}/works/", None, None),
    ]
    urls += [(f"{SITE}/works/{w['id']}.html", "0.9", "monthly") for w in mp.WORKS]
    urls += [(f"{SITE}/faq/", "0.7", "monthly"),
             (f"{SITE}/permissions/", "0.6", "monthly"),
             (f"{SITE}/contact/", "0.8", "monthly"),
             (f"{SITE}/how-it-is-built/", "0.6", "monthly"),
             (f"{SITE}/accessibility/", "0.4", "yearly"),
             (f"{SITE}/privacy/", "0.4", "yearly"),
             (f"{SITE}/terms/", "0.4", "yearly"),
             (f"{SITE}/read/ledger.html", "0.6", "monthly"),
             (f"{SITE}/read/intelligence.html", "0.6", "monthly"),
             (f"{SITE}/read/custody.html", "0.6", "monthly"),
             (f"{SITE}/read/sovereign.html", "0.6", "monthly"),
             (f"{SITE}/read/cadence.html", "0.6", "monthly"),
             ("https://king-kunta-cpu.github.io/tapstall/deskos/", "0.5", "monthly")]
    return [u for u in urls if u[1]]


def write_sitemap():
    entries = "".join(
        f"  <url>\n    <loc>{mp.esc(u)}</loc>\n    <lastmod>{TODAY}</lastmod>\n"
        f"    <changefreq>{c}</changefreq>\n    <priority>{p}</priority>\n  </url>\n"
        for u, p, c in sitemap_urls())
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
           f"{entries}</urlset>\n")
    (PUBLIC / "sitemap.xml").write_text(xml, encoding="utf-8")
    return PUBLIC / "sitemap.xml"


def write_feed():
    base = "https://king-kunta-cpu.github.io/tapstall"
    entries = []
    for w in mp.WORKS:
        link = f"{SITE}/works/{w['id']}.html"
        entries.append(f"""  <entry>
    <title>{mp.esc(w['title'])}</title>
    <link href="{link}"/>
    <id>{link}</id>
    <updated>{TODAY}T06:00:00Z</updated>
    <author><name>{mp.esc(mp.AUTHOR)}</name></author>
    <category term="{mp.esc(mp.KIND_LABEL[w['kind']])}"/>
    <summary>{mp.esc(w['subtitle'])}. {mp.esc(w['blurb'][:300])}…</summary>
  </entry>""")
    xml = f"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>{mp.esc(mp.AUTHOR)} — books, research and running systems</title>
  <subtitle>Catalogue entries from a practice in Harare: autonomous cognitive
  infrastructure, published research, and the systems they come out of.</subtitle>
  <link href="{base}/portfolio/feed.xml" rel="self" type="application/atom+xml"/>
  <link href="{SITE}/" rel="alternate" type="text/html"/>
  <id>{SITE}/</id>
  <updated>{TODAY}T06:00:00Z</updated>
  <author><name>{mp.esc(mp.AUTHOR)}</name><uri>{SITE}/</uri></author>
  <rights>Per work — see {SITE}/permissions/</rights>
{"".join(entries)}
</feed>
"""
    (OUT / "feed.xml").write_text(xml, encoding="utf-8")
    return OUT / "feed.xml"


def write_llms():
    works = "\n".join(
        f"- [{w['title']}]({SITE}/works/{w['id']}.html) — {w['subtitle']}. "
        f"{mp.KIND_LABEL[w['kind']]}, {w['year']}, {w['status']}. Licence: {w['licence']}."
        for w in mp.WORKS)
    txt = f"""# {mp.AUTHOR}

> Autonomous cognitive infrastructure engineer, operator and writer in Harare, Zimbabwe.
> Owns Jacaranda Labs, which owns Tapstall, STPi, DeskOS, ContentOps, Open Practice and
> the Bluesky Growth Audit, and owns Jacaranda Labs Think Tank, which funds the research,
> the books and the papers. Publishes systems designs and failures rather than success
> claims; thirteen works, most in four formats, several free to reuse under CC BY 4.0.

This file exists so that a language model reading this site can summarise it without
guessing. It is a map of primary sources, not a substitute for them: every claim about a
work should be checked against that work's own page, where its edition status, extent and
licence are stated.

## Key facts

- Name: {mp.AUTHOR}. Role: Autonomous Cognitive Infrastructure Engineer, Operator, Writer.
- Based: Harare, Zimbabwe (CAT/SAST, UTC+2). Works remote-first.
- Education: BSc Entrepreneurship & Business Management (Creativity); MSc Applied
  Entrepreneurship (Innovation & Technology) — Chinhoyi University of Technology.
- Practice: fifteen years of techno-preneurship, including published failures.
- Company: Jacaranda Labs. Research arm: Jacaranda Labs Think Tank. Imprint: Jacaranda
  Labs Press.
- Catalogue: {len(mp.WORKS)} works — 7 books, 4 working papers, 2 shorter volumes.
- Languages: English.

## Where to look first

- [Catalogue and consulting]({SITE}/) — the whole practice on one page.
- [FAQ]({SITE}/faq/) — definitions, licences, what is and is not peer reviewed.
- [Permissions and citation]({SITE}/permissions/) — licence per work, citation format,
  bios in two lengths.
- [Contact]({SITE}/contact/) — email, calls, WhatsApp.
- [How the site is built]({SITE}/how-it-is-built/) — one catalogue file, generated
  artwork, a privacy gate that fails the build.
- [catalogue.json]({SITE}/catalogue.json) — the same catalogue, machine-readable.
- [Feed]({SITE}/feed.xml) — Atom.

## The works

{works}

## Running systems

- [Tapstall](https://tapstall.zlnew.workers.dev/) — merchant commerce rail for Zimbabwe,
  South Africa, Kenya and Nigeria. Holds no customer funds; flat fee; settlement statement
  reconciled against money the merchant received directly.
- [Open Practice](https://open-practice.zlnew.workers.dev/) — non-accredited AI learning
  platform, 50 activities.
- [ContentOps](https://contentops-edge.simalidudu.workers.dev/demo) — content operations
  with fact-bound generation and a deterministic editor.
- [DeskOS]({SITE}/deskos/) — operator command centre in ten modules; console closed.
- [STPi](https://stpi.whop.site/) — applied hiring agents across southern Africa.
- [Bluesky Growth Audit](https://bsky-audit.simalidudu.workers.dev/) — free, no-signup
  account audit.

## How to attribute

__CITE__

## What not to infer

Working papers are not peer reviewed. Single-case studies are not measured customer
outcomes. Two works are catalogued without a public edition — the absence of a download is
stated on the page, not a broken link. Nothing here is financial, legal or medical advice.
"""
    txt = txt.replace("__CITE__",
                      f"{mp.AUTHOR} ({mp.YEAR}). Title of the work. Publisher. "
                      f"{SITE}/works/<id>.html — and cite the work itself, not this file.")
    (PUBLIC / "llms.txt").write_text(txt, encoding="utf-8")
    return PUBLIC / "llms.txt"


# --------------------------------------------------------------------------- share cards
def _font(name, size):
    return ImageFont.truetype(str(FONTS / name), size)


def _wrap(draw, text, f, maxw):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=f) <= maxw:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def _shadow(img, box, radius=0):
    from PIL import ImageFilter
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rectangle(box, fill=(20, 18, 16, 90))
    layer = layer.filter(ImageFilter.GaussianBlur(18))
    return Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")


def og_card_home():
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), PANEL)
    mark = mpa.mark(230)
    img.paste(mark, (80, 172), mark)
    d = ImageDraw.Draw(img)
    gold, cream, dim = (224, 185, 120), (247, 244, 236), (207, 200, 187)
    d.text((80, 92), "COURAGE GARIKAI", font=_font("DejaVuSans-Bold.ttf", 27), fill=gold)
    d.text((80, 128), "HARARE · AUTONOMOUS COGNITIVE INFRASTRUCTURE",
           font=_font("DejaVuSansMono.ttf", 17), fill=(150, 160, 172))
    x = 372
    y = 210
    f = _font("DejaVuSerif-Bold.ttf", 54)
    for line in _wrap(d, "Autonomous cognitive infrastructure, books and research", f, 760)[:3]:
        d.text((x, y), line, font=f, fill=cream)
        y += 66
    d.line([(x, 424), (1122, 424)], fill=gold, width=2)
    sub = ("Merchant rails and agent systems for low-infrastructure markets. "
           "Thirteen works, four formats each.")
    # shrink the deck until it fits in two lines rather than clipping it mid-sentence
    for size in range(25, 14, -1):
        fsub = _font("DejaVuSans.ttf", size)
        lines = _wrap(d, sub, fsub, 740)
        if len(lines) <= 2:
            break
    yy = 456
    for line in lines:
        d.text((x, yy), line, font=fsub, fill=dim)
        yy += size + 11
    d.text((80, 566), "king-kunta-cpu.github.io/tapstall/portfolio",
           font=_font("DejaVuSansMono.ttf", 20), fill=(150, 160, 172))
    return img


def og_card_work(w):
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), PAPER)
    # the jacket, or the typographic panel the catalogue would use
    art_path = OUT / w["cover"] if w.get("cover") else None
    box = (70, 78, 380, 552)
    card = Image.new("RGB", (box[2] - box[0], box[3] - box[1]), "#ffffff")
    if art_path and art_path.exists():
        art = Image.open(art_path).convert("RGB")
        art.thumbnail((box[2] - box[0], box[3] - box[1]), Image.LANCZOS)
        card = Image.new("RGB", (box[2] - box[0], box[3] - box[1]), "#ffffff")
        card.paste(art, ((card.width - art.width) // 2, (card.height - art.height) // 2))
    else:
        d0 = ImageDraw.Draw(card)
        d0.rectangle([0, 0, card.width - 1, card.height - 1], fill=PANEL)
        d0.text((24, 26), f'{mp.KIND_LABEL[w["kind"]].upper()} · {w["year"]}',
                font=_font("DejaVuSans-Bold.ttf", 15), fill=(185, 178, 165))
        d0.rectangle([24, 62, 60, 65], fill=ACCENT)
        yy = 120
        for line in _wrap(d0, w["title"], _font("DejaVuSerif.ttf", 30), card.width - 48):
            d0.text((24, yy), line, font=_font("DejaVuSerif.ttf", 30), fill=(242, 238, 228))
            yy += 38
        d0.text((24, card.height - 44), mp.AUTHOR.upper(),
                font=_font("DejaVuSans-Bold.ttf", 14), fill=(157, 150, 138))
    img = _shadow(img, box)
    img.paste(card, (box[0], box[1]))
    d = ImageDraw.Draw(img)
    x = 430
    d.text((x, 86), f'{mp.KIND_LABEL[w["kind"]].upper()} · {w["year"]}',
           font=_font("DejaVuSans-Bold.ttf", 19), fill=ACCENT)
    y = 132
    f = _font("DejaVuSerif-Bold.ttf", 50) if len(w["title"]) < 40 else _font("DejaVuSerif-Bold.ttf", 42)
    for line in _wrap(d, w["title"], f, 700):
        d.text((x, y), line, font=f, fill=INK)
        y += f.size + 12
    y += 6
    y += 8
    for line in _wrap(d, w["subtitle"], _font("DejaVuSans.ttf", 24), 700)[:3]:
        d.text((x, y), line, font=_font("DejaVuSans.ttf", 24), fill="#57534d")
        y += 34
    d.line([(x, 470), (1150, 470)], fill="#ded8ca", width=2)
    d.text((x, 492), mp.AUTHOR, font=_font("DejaVuSans-Bold.ttf", 22), fill=INK)
    d.text((x, 524), mp.esc(w["status"]), font=_font("DejaVuSans.ttf", 19), fill="#57534d")
    d.text((1150 - d.textlength("king-kunta-cpu.github.io/tapstall/portfolio/works",
                               font=_font("DejaVuSansMono.ttf", 14)), 566),
           "king-kunta-cpu.github.io/tapstall/portfolio/works",
           font=_font("DejaVuSansMono.ttf", 14), fill="#8a857c")
    return img


def write_og():
    OG_DIR.mkdir(parents=True, exist_ok=True)
    home = OG_DIR / "home.jpg"
    og_card_home().save(home, quality=88, optimize=True)
    made = [home]
    for w in mp.WORKS:
        p = OG_DIR / f"{w['id']}.jpg"
        og_card_work(w).save(p, quality=88, optimize=True)
        made.append(p)
    return made


# --------------------------------------------------------------------------- main
def main():
    import re as _re
    global mp_re
    mp_re = _re
    written = []
    for fn in (privacy_page, faq_page, permissions_page, accessibility_page,
               built_page, contact_page, terms_page):
        slug = {"privacy_page": "privacy", "faq_page": "faq",
                "permissions_page": "permissions", "accessibility_page": "accessibility",
                "built_page": "how-it-is-built", "contact_page": "contact",
                "terms_page": "terms"}[fn.__name__]
        dest = OUT / slug / "index.html"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(fn(), encoding="utf-8")
        written.append((slug, dest.stat().st_size))

    r = write_robots()
    s = write_sitemap()
    t = write_llms()
    f = write_feed()
    cards = [] if "--no-og" in sys.argv else write_og()

    for slug, size in written:
        print(f"{slug + '/':26s} {size:>7,} B")
    for p in (r, s, t, f):
        print(f"{str(p.relative_to(PUBLIC)):26s} {p.stat().st_size:>7,} B")
    if cards:
        print(f"og/                        {len(cards)} cards, "
              f"{sum(c.stat().st_size for c in cards) / 1024:.0f} KB total")


if __name__ == "__main__":
    main()
