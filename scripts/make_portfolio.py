#!/usr/bin/env python3
"""
Generate the portfolio site from one catalogue definition.

The catalogue lives in this file as data; the script emits two artefacts:

    pages/public/portfolio/index.html      a single self-contained page — no external CSS,
                                           fonts, scripts or images, so it renders the same
                                           offline, in a sandboxed preview, and on Pages
    pages/public/portfolio/catalogue.json  the same catalogue, machine-readable, for anyone
                                           who wants the list without scraping the page

The destination sits inside the directory the Pages workflow publishes, so the portfolio is
served at /portfolio/ *beside* the shipped landing page rather than replacing it — that page
is the live shop front and is not this script's business.

Adding a work means adding one dict below and re-running the script. Nothing else is
edited by hand, so the page and the JSON cannot drift.

Usage:  python3 scripts/make_portfolio.py
"""
import html
import json
from pathlib import Path

REPO = "https://github.com/king-kunta-cpu/tapstall"
RAW = REPO + "/raw/main"
RELEASE = REPO + "/releases/download/publications-2026-10"

AUTHOR = "Courage Garikai"
PRESS = "Jacaranda Labs Press · Harare"
YEAR = "2026"

# --------------------------------------------------------------------------- catalogue
#
# 'formats' maps a format label to a URL. Files held in the repository are served from
# main; the five long-form PDFs are release assets so that the repository stays lean.
#
WORKS = [
    {
        "id": "ledger",
        "kind": "book",
        "featured": True,
        "title": "The Ledger and the Shopkeeper",
        "subtitle": "Building commerce for the markets the platforms forgot",
        "year": "2026",
        "status": "First edition", "pages": 77, "words": 14595,
        "publisher": PRESS, "licence": "CC BY 4.0",
        "blurb": (
            "A trade book on building a merchant rail for shops the platforms skipped — "
            "written from the release log rather than the pitch deck. Part one is the gap: "
            "the forty-tab panic, and why the obvious answer is wrong. Part two is the "
            "machine: a shop in one link, a statement that can be recomputed, quotas as a "
            "design material, the first hundred prospects, and the number that could not be "
            "dialled. Part three is the rules: never hold the money, never lie in the copy, "
            "never post to your customers. Part four is the craft — what broke, in five "
            "failure classes, and the uncomfortable arithmetic that follows."
        ),
        "note": "Print edition typeset from a single Markdown source; 77 pages, running heads, resolved contents.",
        "formats": {
            "PDF": f"{RAW}/book/the-ledger-and-the-shopkeeper.pdf",
            "EPUB": f"{RAW}/book/the-ledger-and-the-shopkeeper.epub",
            "HTML": f"{RAW}/book/the-ledger-and-the-shopkeeper.html",
            "MD": f"{RAW}/book/the-ledger-and-the-shopkeeper.md",
        },
    },
    {
        "id": "intelligence",
        "kind": "book",
        "featured": True,
        "title": "Intelligence, Data and Judgement",
        "subtitle": "An applied introduction to artificial intelligence, with a production case",
        "year": "2026",
        "status": "First edition", "pages": 159, "words": 31930,
        "publisher": PRESS, "licence": "CC BY 4.0",
        "blurb": (
            "A textbook written to be taught from. Twenty-two chapters in five parts — "
            "foundations, the material, the machine, the case, and judgement — each with "
            "learning outcomes, a worked example, graded exercises and further reading. "
            "The disciplinary spine is three widely used curricula: COMCEC's introduction "
            "to AI and its fundamental concepts, Microsoft's Fundamentals of AI Module 1, "
            "and NITI Aayog's Let's Learn AI Base Module, each attributed and mapped "
            "chapter by chapter in the appendix. Tapstall runs through the middle of the "
            "book as the worked case, including its failures."
        ),
        "note": "Eleven tables, two pseudocode listings, a sixty-term glossary, eight labs and an annotated bibliography.",
        "formats": {
            "PDF": f"{RAW}/book/intelligence-data-and-judgement.pdf",
            "EPUB": f"{RAW}/book/intelligence-data-and-judgement.epub",
            "HTML": f"{RAW}/book/intelligence-data-and-judgement.html",
            "MD": f"{RAW}/book/intelligence-data-and-judgement.md",
        },
    },
    {
        "id": "custody",
        "kind": "research",
        "featured": True,
        "title": "Order Without Custody",
        "subtitle": "Governance-first design for merchant commerce rails in low-infrastructure economies",
        "year": "2026",
        "status": "Working paper; not peer reviewed", "pages": 30, "words": 11628,
        "publisher": "DCAI working paper 3", "licence": "CC BY 4.0",
        "blurb": (
            "Small merchants already sell at scale — through chat threads, pages and a phone "
            "number painted on a wall — but they sell without a record. This paper argues "
            "that the binding constraint at that tier is not payment capability but "
            "reconciliation, and that reconcilability is an architectural property rather "
            "than a feature. Five mechanisms are formalised against artefacts a reader can "
            "inspect: the No-Custody Rail, Admission-Gated Discovery, Reserve-Ladder "
            "Scheduling, Surface-Disjoint Multi-Tenancy and the Constrained Persuasion "
            "Doctrine. The empirical section is forensic: five classes of governance failure, "
            "each stated as a signature, a detector and a design response."
        ),
        "note": "Candid about its limits: no paying customers in the measurement window, no control condition, no inference beyond the case.",
        "formats": {
            "PDF": f"{RAW}/papers/tapstall-2026-order-without-custody.pdf",
            "EPUB": f"{RAW}/papers/tapstall-2026-order-without-custody.epub",
            "HTML": f"{RAW}/papers/tapstall-2026-order-without-custody.html",
            "MD": f"{RAW}/papers/tapstall-2026-order-without-custody.md",
        },
    },
    {
        "id": "sovereign",
        "kind": "research",
        "featured": True,
        "title": "The Sovereign Micro-Enterprise",
        "subtitle": "A governance-first architecture for zero-capital agentic businesses",
        "year": "2026",
        "status": "Working manuscript", "pages": 33, "words": None,
        "publisher": "DCAI field report 1", "licence": "All rights reserved",
        "blurb": (
            "Frontier models pushed the price of machine cognition toward zero, and the "
            "obvious inference — that any connected individual now owns a software company — "
            "proves fragile in practice. Producing is easy; operating is hard. This report "
            "documents the design, deployment and near-real-time failure forensics of a "
            "one-person, zero-capital sales and content business run entirely by autonomous "
            "agents under a governance architecture: guarded capability, a ledgered agent "
            "pattern with an idle witness, a zero-capital ladder, and effectuation-in-the-loop. "
            "Seven figures carry the anatomy, the cadence and the incident traces."
        ),
        "note": "Silent-failure taxonomy with detection-time bounds, offered as reusable diagnostic vocabulary.",
        "formats": {
            "PDF": f"{RAW}/papers/sovereign-micro-enterprise.pdf",
            "HTML": f"{RAW}/papers/sovereign-micro-enterprise.html",
            "MD": f"{RAW}/papers/sovereign-micro-enterprise.md",
        },
    },
    {
        "id": "cadence",
        "kind": "research",
        "featured": True,
        "title": "Grounded Cadence",
        "subtitle": "Fact-bound content operations as a governance architecture",
        "year": "2026",
        "status": "Working paper", "pages": 17, "words": None,
        "publisher": "DCAI working paper", "licence": "All rights reserved",
        "blurb": (
            "Anyone can now emit a week of social copy. Almost no one can emit it on a "
            "schedule, from a company's own facts, without inventing customers or numbers, "
            "without spending the operator's quota on a stranger, and without a silent failure "
            "looking like a green run. This paper reports a live zero-capital writing service "
            "and formalises four mechanisms with production incidents attached: fact-bound "
            "generation, value–promo cadence, capability isolation, and fail-loud operations."
        ),
        "note": "Honest where it matters: the Worker is in production, the test surface is documented, paying customers are zero.",
        "formats": {
            "PDF": f"{RAW}/papers/grounded-cadence.pdf",
            "HTML": f"{RAW}/papers/grounded-cadence.html",
            "MD": f"{RAW}/papers/grounded-cadence.md",
        },
    },
    # --- works catalogued from the author's publications catalogue. The catalogue states
    # their editions and that full text is not distributed publicly, so these entries carry
    # a status and no download links; inventing a link would be inventing an edition.
    {
        "id": "governable",
        "kind": "book",
        "featured": True,
        "title": "The Governable Enterprise",
        "subtitle": "A practical guide to evidence, authority and AI operations — lessons from DeskOS",
        "year": "2026",
        "status": "Complete first edition",
        "pages": 221, "extent": "24 developed chapters · 10 operating tools", "words": None,
        "publisher": "Jacaranda Labs Think Tank", "licence": "No open-content licence granted",
        "blurb": (
            "A practitioner guide to designing AI operations that can explain their evidence, "
            "limit their authority, account for resources and recover from uncertainty. "
            "DeskOS is examined as a candid, bounded case rather than a product-success claim, "
            "and the ten operating tools are given as methods a reader can adopt rather than "
            "results a reader should assume. Prepared in PDF, editable Word, EPUB, HTML and "
            "Markdown; full text is not distributed publicly."
        ),
        "note": "24 developed chapters, 221 pages, 10 operating tools. Constructed examples are identified as such in the work.",
        "formats": {},
    },
    {
        "id": "emotional",
        "kind": "book",
        "featured": False,
        "title": "Emotional Engineering for AI-Oriented Infrastructure Operators",
        "subtitle": "Trust, agency and ethical adoption in systems that act",
        "year": "2026",
        "status": "Private author-review edition",
        "pages": None, "extent": "author-review edition", "words": None,
        "publisher": "Jacaranda Labs Think Tank", "licence": "No open-content licence granted",
        "blurb": (
            "An examination of how evidence, meaningful choice and recovery can support "
            "appropriate reliance on automated systems. It distinguishes ethical adoption from "
            "emotional pressure, and treats operating methods as proposals rather than validated "
            "sales formulas — a distinction that matters most to the operator who has to decide "
            "what to say to a customer on a bad day."
        ),
        "note": "Author-review edition: not a public release.",
        "formats": {},
    },
    {
        "id": "autonomy",
        "kind": "research",
        "featured": True,
        "title": "From Spreadsheet Interface to Governable Autonomy",
        "subtitle": "DeskOS as a critical design-science case of evidence, agency and resource-constrained AI infrastructure",
        "year": "2026",
        "status": "Working paper; not peer reviewed",
        "pages": None, "extent": "working paper", "words": None,
        "publisher": "DCAI working paper", "licence": "No open-content licence granted",
        "blurb": (
            "A bounded implementation study separating generated artefacts from verified "
            "intelligence — the distinction that decides whether an operator is being informed "
            "or flattered. It proposes an Evidence–Authority–Resource Contract and a prospective "
            "evaluation protocol, and reports no customer-outcome experiment, because none was run."
        ),
        "note": "Working paper, not peer reviewed. The contract and protocol are proposals, tested prospectively or not at all.",
        "formats": {},
    },
    {
        "id": "musk-mirror",
        "kind": "book",
        "featured": False,
        "title": "The Musk Mirror",
        "subtitle": "How one billionaire exposed the cracks in China's innovation dream",
        "year": "2026",
        "status": "First edition", "pages": 286, "words": None,
        "publisher": "Courage Garikai, Harare", "licence": "All rights reserved",
        "blurb": (
            "A gallery of expert predictions, set against what was actually built. The book "
            "reads as a mirror rather than a weapon: on the rocket sceptics, the "
            "communications 'experts', the business-model critics and the CEO chorus, and on "
            "what their confidence cost. Its argument is about expertise without humility, "
            "and about the difference between a claim that sounds authoritative and a number "
            "that can be checked."
        ),
        "note": "Dedicated to engineers building impossible things in constrained environments.",
        "formats": {"PDF": f"{RELEASE}/the-musk-mirror.pdf"},
    },
    {
        "id": "traffic",
        "kind": "book",
        "featured": False,
        "title": "Traffic Is the New Oil",
        "subtitle": "The African digital wealth formula",
        "year": "2026",
        "status": "First edition", "pages": 256, "words": None,
        "publisher": "Jacaranda Labs", "licence": "All rights reserved",
        "blurb": (
            "Six chapters on the only formula that has ever run the internet — traffic, ads, "
            "money — argued for a continent that supplies the eyeballs and keeps too little "
            "of the revenue. From the awakening, through the traffic layer and the ad market, "
            "to what actually enters an account while the power is out, and a zero-capital "
            "route from nothing to a first four-figure month."
        ),
        "note": "Written for the operator with a phone, a connection and no capital.",
        "formats": {"PDF": f"{RELEASE}/traffic-is-the-new-oil.pdf"},
    },
    {
        "id": "pinterest",
        "kind": "book",
        "featured": False,
        "title": "Pinterest Goldmine",
        "subtitle": "The traffic source nobody told you about",
        "year": "2026",
        "status": "First edition", "pages": 242, "words": None,
        "publisher": "Jacaranda Labs", "licence": "All rights reserved",
        "blurb": (
            "A complete operating manual for one under-used traffic channel: the psychology "
            "of the scroll-stop, a pin factory run from Canva on a phone, the search "
            "optimisation playbook, a scheduling system that survives real-life disruption, "
            "and the money layer that turns attention into a payout."
        ),
        "note": "Includes the Sunday System: a week of output in forty-five minutes.",
        "formats": {"PDF": f"{RELEASE}/pinterest-goldmine.pdf"},
    },
    {
        "id": "rocket-man",
        "kind": "essay",
        "featured": False,
        "title": "The Rocket Man Reckoning",
        "subtitle": "How China mocked Elon Musk — and why they are now panicking",
        "year": "2026",
        "status": "First edition", "pages": 29, "words": None,
        "publisher": "Jacaranda Labs", "licence": "All rights reserved",
        "blurb": (
            "The arrogance of a rising superpower, the collapse of its myths, and what one "
            "company's success reveals about the future of innovation. A short book about a "
            "decade of ridicule from established voices — academic, industrial and "
            "editorial — and what happened when the engineering arrived anyway."
        ),
        "note": "Companion to The Musk Mirror.",
        "formats": {"PDF": f"{RELEASE}/the-rocket-man-reckoning.pdf"},
    },
    {
        "id": "unchained",
        "kind": "essay",
        "featured": False,
        "title": "Unchained Blueprint",
        "subtitle": "What to build when every payment door is closed",
        "year": "2026",
        "status": "Version 1 — working document", "pages": 13, "words": None,
        "publisher": "Jacaranda Labs", "licence": "All rights reserved",
        "blurb": (
            "Every single door was closed: the processor that does not support your country, "
            "the payouts that are unavailable in your region, the account that has been "
            "limited. This blueprint starts from the observation that these are decisions "
            "rather than accidents, and works out what a builder in that position can still "
            "put in place."
        ),
        "note": "Version 1 — a working document, not a finished book.",
        "formats": {"PDF": f"{RELEASE}/unchained-blueprint-v1.pdf"},
    },
]

KIND_LABEL = {"book": "Book", "research": "Research", "essay": "Essay & field report"}


def extent(w):
    """What is actually known about a work's size. A page count we have is stated;
    one we do not have is stated as what it is — a chapter count or nothing."""
    if w.get("pages"):
        return f"{w['pages']} pages"
    return w.get("extent") or "extent not published"


def esc(s):
    return html.escape(s or "")


# --------------------------------------------------------------------------- rendering

def cover(w, cls="cover"):
    """A CSS-drawn cover. No image files, so the page stays self-contained."""
    kicker = KIND_LABEL[w["kind"]]
    return f"""
      <div class="{cls}">
        <div class="cov-top">
          <span class="cov-kicker">{esc(kicker)}</span>
          <span class="cov-year">{esc(w['year'])}</span>
        </div>
        <div class="cov-body">
          <div class="cov-rule"></div>
          <h3>{esc(w['title'])}</h3>
          <p>{esc(w['subtitle'])}</p>
        </div>
        <div class="cov-foot">
          <span>{esc(AUTHOR)}</span>
          <span>{esc(w['pages'] and str(w['pages']) + ' pp' or 'catalogue')}</span>
        </div>
      </div>"""


def chips(w):
    """Download links where an edition exists. Where it does not, say so plainly —
    a missing link is information, and a fake one would be a lie about a book."""
    if not w["formats"]:
        return ('<div class="chips"><span class="chip chip-none">Catalogue entry · '
                'no public edition</span></div>')
    out = []
    for label, url in w["formats"].items():
        out.append(f'<a class="chip" href="{esc(url)}" target="_blank" rel="noopener">{esc(label)}</a>')
    return '<div class="chips">' + "".join(out) + "</div>"


def facts(w):
    bits = [extent(w)]
    if w["words"]:
        bits.append(f"{w['words']:,} words")
    bits.append(w["licence"])
    return " · ".join(esc(b) for b in bits)


def featured_card(w):
    return f"""
      <article class="card" data-kind="{w['kind']}" id="card-{esc(w['id'])}">
        {cover(w)}
        <div class="card-body">
          <div class="card-meta">{esc(KIND_LABEL[w['kind']])} · {esc(w['year'])}</div>
          <div class="status">{esc(w['status'])}</div>
          <h2><a href="#{esc(w['id'])}">{esc(w['title'])}</a></h2>
          <p class="sub">{esc(w['subtitle'])}</p>
          <p class="blurb">{esc(w['blurb'])}</p>
          <p class="note">{esc(w['note'])}</p>
          <div class="card-foot">
            <span class="facts">{facts(w)}</span>
            {chips(w)}
          </div>
        </div>
      </article>"""


def shelf_row(w):
    return f"""
      <article class="row" data-kind="{w['kind']}" id="{esc(w['id'])}">
        <div class="row-year">{esc(w['year'])}</div>
        <div class="row-main">
          <h3><span class="row-title">{esc(w['title'])}</span>
            <span class="row-sub">{esc(w['subtitle'])}</span></h3>
          <div class="status status-row">{esc(w['status'])}</div>
          <p class="blurb">{esc(w['blurb'])}</p>
          <div class="card-foot">
            <span class="facts">{facts(w)}</span>
            {chips(w)}
          </div>
        </div>
      </article>"""


CSS = """
:root{
  --paper:#faf7f0; --ink:#15171a; --accent:#a8332c; --muted:#6d6f74;
  --rule:#e3ded2; --panel:#14181c; --panel-ink:#f2eee4;
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;
  --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html{background:var(--paper);-webkit-text-size-adjust:100%}
body{margin:0;color:var(--ink);font:17px/1.62 var(--serif);background:var(--paper)}
a{color:inherit}
.wrap{max-width:1060px;margin:0 auto;padding:0 34px}

/* masthead */
header.mast{position:sticky;top:0;z-index:20;background:rgba(250,247,240,.92);
  backdrop-filter:saturate(140%) blur(8px);border-bottom:1px solid var(--rule)}
.mast .wrap{display:flex;align-items:baseline;justify-content:space-between;gap:20px;
  padding-top:15px;padding-bottom:15px}
.mast .brand{font:600 12.5px/1 var(--sans);letter-spacing:.2em;text-transform:uppercase}
.mast .brand span{color:var(--accent)}
nav.mast-nav{display:flex;gap:22px;font:500 11.5px/1 var(--sans);letter-spacing:.14em;
  text-transform:uppercase}
nav.mast-nav a{text-decoration:none;color:var(--muted)}
nav.mast-nav a:hover{color:var(--accent)}

/* hero */
.hero{padding:76px 0 54px;border-bottom:1px solid var(--rule)}
.hero .eyebrow{font:600 11.5px/1 var(--sans);letter-spacing:.22em;text-transform:uppercase;
  color:var(--accent);margin-bottom:26px}
.hero h1{font-size:clamp(38px,5.6vw,64px);line-height:1.05;letter-spacing:-.022em;
  font-weight:400;margin:0 0 26px;max-width:16em}
.hero h1 em{font-style:italic;color:var(--accent)}
.hero .lede{font-size:19.5px;line-height:1.55;color:#33383d;max-width:34em;margin:0 0 30px}
.hero .lede b{font-weight:600;color:var(--ink)}
.stats{display:flex;flex-wrap:wrap;gap:38px;margin-top:34px;padding-top:26px;
  border-top:1px solid var(--rule)}
.stat .n{font:400 30px/1 var(--serif);letter-spacing:-.01em}
.stat .k{font:600 10.5px/1.4 var(--sans);letter-spacing:.16em;text-transform:uppercase;
  color:var(--muted);margin-top:7px}

/* section headings */
section{padding:66px 0 10px}
.sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:24px;
  border-bottom:2px solid var(--ink);padding-bottom:11px;margin-bottom:34px}
.sec-head h2{font:400 27px/1.15 var(--serif);letter-spacing:-.01em;margin:0}
.sec-head .kicker{font:600 10.5px/1 var(--sans);letter-spacing:.2em;text-transform:uppercase;
  color:var(--muted)}
.sec-intro{max-width:38em;color:#3d4247;margin:-14px 0 34px}

/* filter */
.filters{display:flex;gap:9px;flex-wrap:wrap;margin:0 0 30px}
.filters button{font:600 10.5px/1 var(--sans);letter-spacing:.14em;text-transform:uppercase;
  padding:9px 14px;border:1px solid var(--rule);background:transparent;color:var(--muted);
  cursor:pointer;border-radius:2px}
.filters button[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:var(--paper)}

/* featured cards */
.featured{display:grid;grid-template-columns:1fr;gap:42px}
.card{display:grid;grid-template-columns:214px minmax(0,1fr);gap:30px;align-items:start;
  border-top:3px solid var(--ink);padding-top:24px}
.cover{background:var(--panel);color:var(--panel-ink);aspect-ratio:3/4.3;padding:20px 19px;
  display:flex;flex-direction:column;justify-content:space-between;position:relative;
  overflow:hidden}
.cover::after{content:"";position:absolute;inset:0;
  background:linear-gradient(160deg,rgba(255,255,255,.055),rgba(0,0,0,.28));pointer-events:none}
.cov-top{display:flex;justify-content:space-between;align-items:baseline;
  font:600 8.4px/1 var(--sans);letter-spacing:.18em;text-transform:uppercase;color:#b9b2a5;
  position:relative;z-index:1}
.cov-year{color:#8d877c}
.cov-body{position:relative;z-index:1}
.cov-rule{width:30px;height:2px;background:var(--accent);margin-bottom:14px}
.cover h3{font:400 21px/1.16 var(--serif);letter-spacing:-.012em;margin:0 0 11px}
.cover p{font:italic 400 11.5px/1.42 var(--serif);color:#cdc6b8;margin:0}
.cov-foot{display:flex;justify-content:space-between;font:600 8.4px/1 var(--sans);
  letter-spacing:.14em;text-transform:uppercase;color:#9d968a;position:relative;z-index:1}
.card-body{display:flex;flex-direction:column;min-height:100%}
.card-meta{font:600 10px/1 var(--sans);letter-spacing:.16em;text-transform:uppercase;
  color:var(--accent);margin-bottom:9px}
.status{font:600 10px/1.3 var(--sans);letter-spacing:.13em;text-transform:uppercase;
  color:var(--muted);margin:-3px 0 11px}
.status-row{margin:2px 0 10px}
.band .status{color:#9aa1a7}
.chip-none{border-style:dashed;color:var(--muted);cursor:default}
.card h2{font:400 27px/1.16 var(--serif);margin:0 0 7px;letter-spacing:-.012em}
.card h2 a{text-decoration:none}
.card h2 a:hover{color:var(--accent)}
.sub{font-style:italic;color:var(--muted);font-size:15px;margin:0 0 13px}
.blurb{font-size:14.6px;line-height:1.58;color:#3a3f44;margin:0 0 12px}
.note{font:600 10.5px/1.5 var(--sans);letter-spacing:.02em;color:var(--muted);
  border-left:2px solid var(--rule);padding-left:10px;margin:0 0 16px}
.card-foot{margin-top:auto;padding-top:14px;border-top:1px solid var(--rule);
  display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.facts{font:11.5px/1.4 var(--mono);color:var(--muted)}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{font:600 9.5px/1 var(--sans);letter-spacing:.12em;text-transform:uppercase;
  text-decoration:none;padding:6px 8px;border:1px solid var(--rule);border-radius:2px;
  color:#41474c;background:#fff}
.chip:hover{background:var(--ink);color:var(--paper);border-color:var(--ink)}

/* shelf rows */
.subhead{margin:44px 0 0;border-top:1px solid var(--rule);padding-top:20px}
.subhead span{font:600 10.5px/1 var(--sans);letter-spacing:.2em;text-transform:uppercase;
  color:var(--muted)}
.rows{border-top:1px solid var(--rule)}
.row{display:grid;grid-template-columns:74px 1fr;gap:26px;padding:30px 0;
  border-bottom:1px solid var(--rule)}
.row-year{font:400 15px/1 var(--serif);color:var(--muted);padding-top:5px;
  border-right:1px solid var(--rule)}
.row h3{margin:0 0 7px;font:400 23px/1.2 var(--serif);letter-spacing:-.01em}
.row-title{margin-right:12px}
.row-sub{font:italic 400 15px/1.35 var(--serif);color:var(--muted);
  display:inline-block}
.row .blurb{max-width:62ch}

/* research band */
.band{background:var(--panel);color:var(--panel-ink);padding:64px 0 66px;margin-top:66px}
.band .sec-head{border-color:#4a4f54}
.band .sec-head .kicker{color:#9aa1a7}
.band .sec-head h2{color:var(--panel-ink)}
.band .blurb{color:#cfcabd}
.band .facts,.band .note{color:#9aa1a7}
.band .note{border-color:#3a4046}
.band .chip{background:transparent;color:#e7e2d6;border-color:#4a4f54}
.band .chip:hover{background:var(--accent);border-color:var(--accent);color:#fff}
.band .card{border-top-color:var(--accent)}
.band .card{grid-template-columns:262px minmax(0,1fr);gap:40px}
.band .card h2{font-size:32px}
.band .blurb{font-size:15.4px;max-width:60ch}
.band .sec-intro{color:#bdb7a9}
.band .facts{color:#8f979d}
.band .blurb,.band .sub{color:#c9c4b7}

/* about */
.about{display:grid;grid-template-columns:1.35fr .8fr;gap:52px;padding:20px 0 30px}
.about h2{font:400 27px/1.15 var(--serif);margin:0 0 18px}
.about p{color:#3a3f44;margin:0 0 14px}
.about p:first-of-type{font-size:19px;color:var(--ink)}
.aside{border-left:1px solid var(--rule);padding-left:30px}
.aside h4{font:600 10.5px/1 var(--sans);letter-spacing:.18em;text-transform:uppercase;
  color:var(--accent);margin:0 0 12px}
.aside ul{list-style:none;margin:0 0 26px;padding:0}
.aside li{font-size:14.6px;color:#3a3f44;padding:7px 0;border-bottom:1px solid var(--rule)}
.aside li b{font-weight:600}

/* colophon */
footer.colophon{border-top:2px solid var(--ink);margin-top:40px;padding:34px 0 70px;
  font:12.5px/1.6 var(--sans);color:var(--muted)}
footer.colophon .wrap{display:flex;justify-content:space-between;gap:30px;flex-wrap:wrap}
footer.colophon .l{max-width:40em}
footer.colophon a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--rule)}

@media (max-width:900px){
  .card,.band .card{grid-template-columns:170px minmax(0,1fr);gap:22px}
  .cover{aspect-ratio:3/4.2}
  .about{grid-template-columns:1fr;gap:34px}
  .aside{border-left:0;border-top:1px solid var(--rule);padding:26px 0 0}
}
@media (max-width:620px){
  .stats{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  .sec-head{flex-wrap:wrap;gap:6px}
  .card,.band .card{grid-template-columns:1fr;gap:18px}
  .cover{aspect-ratio:3/2.9}
  .wrap{padding:0 20px}
  .hero{padding:48px 0 40px}
  .row{grid-template-columns:1fr;gap:8px}
  .row-year{border-right:0;padding-top:0}
  .mast .wrap{flex-direction:column;align-items:flex-start;gap:11px}
  nav.mast-nav{gap:16px}
}
@media print{ header.mast{position:static} .filters{display:none} body{background:#fff} }
"""

JS = """
document.querySelectorAll('.filters button').forEach(function(btn){
  btn.addEventListener('click', function(){
    var kind = btn.dataset.filter;
    document.querySelectorAll('.filters button').forEach(function(b){
      b.setAttribute('aria-pressed', String(b === btn));
    });
    document.querySelectorAll('[data-kind]').forEach(function(el){
      el.style.display = (kind === 'all' || el.dataset.kind === kind) ? '' : 'none';
    });
  });
});
"""


def build():
    featured = [w for w in WORKS if w["featured"]]
    research = [w for w in featured if w["kind"] == "research"]
    books = [w for w in WORKS if w["kind"] == "book"]
    flagship = [w for w in books if w["featured"]]
    also = [w for w in books if not w["featured"]]
    essays = [w for w in WORKS if w["kind"] == "essay"]

    total_pages = sum(w["pages"] or 0 for w in WORKS)
    total_words = sum(w["words"] or 0 for w in WORKS)

    cards = "".join(featured_card(w) for w in flagship)
    more_rows = "".join(shelf_row(w) for w in also)
    research_block = "".join(featured_card(w) for w in research)
    rows = "".join(shelf_row(w) for w in essays)

    doc = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(AUTHOR)} — books, research and field reports</title>
<meta name="description" content="{esc(AUTHOR)} writes and builds commerce systems for markets the platforms skip. Books, research papers and field reports, in PDF, EPUB, HTML and Markdown.">
<meta name="author" content="{esc(AUTHOR)}">
<style>{CSS}</style>
</head>
<body>

<header class="mast">
  <div class="wrap">
    <div class="brand">{esc(AUTHOR)} <span>·</span> Harare</div>
    <nav class="mast-nav">
      <a href="#books">Books</a>
      <a href="#research">Research</a>
      <a href="#shelf">Essays</a>
      <a href="#about">About</a>
    </nav>
  </div>
</header>

<main>
  <div class="wrap">
    <section class="hero">
      <div class="eyebrow">Writer · Engineer · Operator</div>
      <h1>I build commerce for the markets the platforms skip, and write down <em>what happens next</em>.</h1>
      <p class="lede">Thirteen published works on trade, technology and constraint — seven books, four
      working papers and two short volumes, all from the same practice.
      Everything here is produced from a source file and shipped in four formats, because a
      reader should not need a particular app to read a book.</p>
      <div class="stats">
        <div class="stat"><div class="n">13</div><div class="k">Published works</div></div>
        <div class="stat"><div class="n">{total_pages:,}</div><div class="k">Pages in print</div></div>
        <div class="stat"><div class="n">4</div><div class="k">Formats per title</div></div>
        <div class="stat"><div class="n">$0</div><div class="k">Marginal cost to serve</div></div>
      </div>
    </section>

    <section id="books">
      <div class="sec-head">
        <h2>Books</h2>
        <div class="kicker">Typeset from a single source</div>
      </div>
      <div class="filters" role="group" aria-label="Filter the catalogue">
        <button data-filter="all" aria-pressed="true">All</button>
        <button data-filter="book" aria-pressed="false">Books</button>
        <button data-filter="research" aria-pressed="false">Research</button>
        <button data-filter="essay" aria-pressed="false">Essays</button>
      </div>
      <div class="featured">{cards}</div>
      <div class="subhead"><span>Also in the catalogue</span></div>
      <div class="rows">{more_rows}</div>
    </section>
  </div>

  <section class="band" id="research">
    <div class="wrap">
      <div class="sec-head">
        <h2>Research</h2>
        <div class="kicker">Four working papers</div>
      </div>
      <p class="sec-intro">The papers the books come out of — each a single-case study of a
      system built to be auditable before it is profitable, and each candid about what has
      not been proven yet.</p>
      <div class="featured">{research_block}</div>
    </div>
  </section>

  <div class="wrap">
    <section id="shelf">
      <div class="sec-head">
        <h2>Essays and field reports</h2>
        <div class="kicker">Shorter volumes from the same practice</div>
      </div>
      <p class="sec-intro">Two short books — the argument behind the Musk material, and the
      blueprint for a builder whose payment doors are all closed.</p>
      <div class="rows">{rows}</div>
    </section>

    <section id="about">
      <div class="sec-head">
        <h2>About</h2>
        <div class="kicker">{esc(PRESS)}</div>
      </div>
      <div class="about">
        <div>
          <p>I write about commerce in places where the assumptions baked into
          software — always-on power, card rails, a postcode, a credit history — are
          simply false. Then I build the thing the writing describes.</p>
          <p>That practice is <b>Tapstall</b>: a merchant rail for Zimbabwe, South Africa,
          Kenya and Nigeria that gives a shop a storefront, an order link, a one-tap buyer
          confirmation and a settlement statement that reconciles orders against money the
          merchant received directly. It holds no customer funds, charges a flat fee, and
          runs on free infrastructure. The engineering is documented in public — releases,
          a test suite, a failure log — and this catalogue is what comes out of it.</p>
          <p>The books are published under a Creative Commons licence where I hold the
          rights, and produced as Markdown first. The page you are reading was generated by
          a script from the same repository the books live in, so the catalogue cannot drift
          from the files.</p>
          <p><b>On edition status.</b> Each entry states what it actually is — first edition,
          complete first edition, working manuscript, working paper, private author-review
          edition, or a catalogue entry with no public text. Where no download is offered the
          work exists but its full text is not distributed publicly, and the entry says so
          rather than hiding an absent link. A working paper is not represented here as
          peer-reviewed, and a bounded case study is not represented as measured customer
          success.</p>
        </div>
        <aside class="aside">
          <h4>At a glance</h4>
          <ul>
            <li><b>Books</b> — seven long-form titles</li>
            <li><b>Research</b> — four working papers, DCAI series</li>
            <li><b>Essays &amp; reports</b> — two shorter volumes</li>
            <li><b>Formats</b> — PDF, EPUB, HTML, Markdown where an edition is public</li>
            <li><b>Words in print</b> — {total_words:,} across the four text-native works</li>
          </ul>
          <h4>Correspondence</h4>
          <ul>
            <li>Press and permissions — Jacaranda Labs, Harare</li>
            <li>Source and errata — <a href="{REPO}">the repository</a></li>
          </ul>
        </aside>
      </div>
    </section>
  </div>
</main>

<footer class="colophon">
  <div class="wrap">
    <div class="l">
      <b>{esc(AUTHOR)}</b> · {esc(PRESS)} · {YEAR}. Text released under Creative Commons
      Attribution 4.0 where stated; titles marked <i>all rights reserved</i> are not.
      Prices, where a work is sold, are set by the press, not by this page.
    </div>
    <div>
      Built as one HTML file.<br>
      <a href="#books">Back to the books</a>
    </div>
  </div>
</footer>

<script>{JS}</script>
</body>
</html>
"""
    return doc, total_pages


OUT_DIR = Path("pages/public/portfolio")


def main():
    site = OUT_DIR
    site.mkdir(parents=True, exist_ok=True)
    doc, total_pages = build()
    (site / "index.html").write_text(doc, encoding="utf-8")

    cat = {
        "author": AUTHOR,
        "publisher": PRESS,
        "updated": "2026-10-21",
        "works": [
            {k: v for k, v in w.items() if k != "featured"} for w in WORKS
        ],
    }
    (site / "catalogue.json").write_text(json.dumps(cat, indent=2, ensure_ascii=False) + "\n",
                                         encoding="utf-8")

    print(f"{site}/index.html      {len(doc):,} bytes")
    print(f"{site}/catalogue.json  {len(WORKS)} works, {total_pages:,} pages catalogued")
    for w in WORKS:
        # `formats` may be an empty dict — a catalogued work without a public edition is a
        # legitimate entry. Every other listed field must carry text.
        missing = [k for k in ("title", "subtitle", "blurb", "status") if not w.get(k)]
        if "formats" not in w:
            missing.append("formats")
        if missing:
            raise SystemExit(f"{w['id']}: missing {missing}")
    # every format link must be absolute and point at the repository or its releases
    for w in WORKS:
        for label, url in w["formats"].items():
            assert url.startswith(REPO), f"{w['id']}: {label} link escapes the repository: {url}"
    print("links verified: every download points into the repository or its release assets")


if __name__ == "__main__":
    main()
