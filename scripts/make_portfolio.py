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
import subprocess
import sys
import urllib.parse
from pathlib import Path

REPO = "https://github.com/king-kunta-cpu/tapstall"
RAW = REPO + "/raw/main"
RELEASE = REPO + "/releases/download/publications-2026-10"

AUTHOR = "Courage Garikai"
SITE = "https://king-kunta-cpu.github.io/tapstall/portfolio"
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
        "cover": "covers/ledger.jpg",
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
            "PDF": f"{RELEASE}/Garikai-2026-The-Ledger-and-the-Shopkeeper.pdf",
            "EPUB": f"{RAW}/book/Garikai-2026-The-Ledger-and-the-Shopkeeper.epub",
            "HTML": f"{RAW}/book/Garikai-2026-The-Ledger-and-the-Shopkeeper.html",
            "MD": f"{RAW}/book/Garikai-2026-The-Ledger-and-the-Shopkeeper.md",
        },
    },
    {
        "id": "intelligence",
        "cover": "covers/intelligence.jpg",
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
            "PDF": f"{RELEASE}/Garikai-2026-Intelligence-Data-and-Judgement.pdf",
            "EPUB": f"{RAW}/book/Garikai-2026-Intelligence-Data-and-Judgement.epub",
            "HTML": f"{RAW}/book/Garikai-2026-Intelligence-Data-and-Judgement.html",
            "MD": f"{RAW}/book/Garikai-2026-Intelligence-Data-and-Judgement.md",
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
            "PDF": f"{RELEASE}/Garikai-2026-Order-Without-Custody-DCAI-Working-Paper-3.pdf",
            "EPUB": f"{RAW}/papers/Garikai-2026-Order-Without-Custody-DCAI-Working-Paper-3.epub",
            "HTML": f"{RAW}/papers/Garikai-2026-Order-Without-Custody-DCAI-Working-Paper-3.html",
            "MD": f"{RAW}/papers/Garikai-2026-Order-Without-Custody-DCAI-Working-Paper-3.md",
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
            "PDF": f"{RELEASE}/Garikai-2026-The-Sovereign-Micro-Enterprise.pdf",
            "HTML": f"{RAW}/papers/Garikai-2026-The-Sovereign-Micro-Enterprise.html",
            "MD": f"{RAW}/papers/Garikai-2026-The-Sovereign-Micro-Enterprise.md",
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
            "PDF": f"{RELEASE}/Garikai-2026-Grounded-Cadence.pdf",
            "HTML": f"{RAW}/papers/Garikai-2026-Grounded-Cadence.html",
            "MD": f"{RAW}/papers/Garikai-2026-Grounded-Cadence.md",
        },
    },
    # --- works catalogued from the author's publications catalogue. The catalogue states
    # their editions and that full text is not distributed publicly, so these entries carry
    # a status and no download links; inventing a link would be inventing an edition.
    {
        "id": "governable",
        "cover": "covers/governable.jpg",
        "cover_pdf": f"{RELEASE}/Garikai-2026-The-Governable-Enterprise-cover.pdf",
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
        "cover": "covers/emotional.jpg",
        "cover_pdf": f"{RELEASE}/Garikai-2026-Emotional-Engineering-cover.pdf",
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
        "cover": "covers/musk-mirror.jpg",
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
        "formats": {"PDF": f"{RELEASE}/Garikai-2026-The-Musk-Mirror.pdf"},
    },
    {
        "id": "traffic",
        "cover": "covers/traffic.jpg",
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
        "formats": {"PDF": f"{RELEASE}/Garikai-2026-Traffic-Is-the-New-Oil.pdf"},
    },
    {
        "id": "pinterest",
        "cover": "covers/pinterest.jpg",
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
        "formats": {"PDF": f"{RELEASE}/Garikai-2026-Pinterest-Goldmine.pdf"},
    },
    {
        "id": "rocket-man",
        "cover": "covers/rocket-man.jpg",
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
        "formats": {"PDF": f"{RELEASE}/Garikai-2026-The-Rocket-Man-Reckoning.pdf"},
    },
    {
        "id": "unchained",
        "cover": "covers/unchained.jpg",
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
        "formats": {"PDF": f"{RELEASE}/Garikai-2026-Unchained-Blueprint-v1.pdf"},
    },
]

# --------------------------------------------------------------------------- what is running
#
# Every entry below was fetched live on 21 October 2026 and answered 200 (or, where noted,
# is protected by design). A portfolio that lists what someone intends to build is a plan;
# this list is what a reader can open right now.
BUILT = [
    {
        "title": "Tapstall",
        "logo": "logos/tapstall.svg",
        "role": "Founder & engineer · 2026",
        "url": "https://tapstall.zlnew.workers.dev/",
        "cta": True,
        "demo": [("Fee calculator", "https://tapstall.zlnew.workers.dev/fees.html"),
                 ("Merchant onboarding", "https://tapstall.zlnew.workers.dev/onboard"),
                 ("Partner terms", "https://tapstall.zlnew.workers.dev/partners"),
                 ("Payment-matching guide", "https://tapstall.zlnew.workers.dev/guide/payment-reference-matching")],
        "what": ("A merchant commerce rail for Zimbabwe, South Africa, Kenya and Nigeria: a shop "
                 "in one link, one-tap buyer confirmation, and a settlement statement that "
                 "reconciles orders against money the merchant received directly. It holds no "
                 "customer funds, charges a flat fee, and runs on free infrastructure."),
        "evidence": ["Single Cloudflare Worker + KV, $0/month, version 1.9.1 live",
                     "420 passing assertions on a ~14.8k-line codebase",
                     "Quota reserve ladder 1000/975/900/800/700 — order submission is the last thing refused",
                     "Public self-test endpoint reports every invariant it claims"],
    },
    {
        "title": "Open Practice",
        "logo": "logos/open-practice.svg",
        "role": "Designer & engineer · 2026",
        "url": "https://open-practice.zlnew.workers.dev/",
        "cta": True,
        "demo": [("The workshops", "https://open-practice.zlnew.workers.dev/activities.html"),
                 ("Starter challenge", "https://open-practice.zlnew.workers.dev/")],
        "what": ("An independent, non-accredited AI learning platform: 50 illustrated activities, "
                 "a curriculum, a tool field desk and a facilitator kit. Learner accounts sync "
                 "across devices; downloaded workspaces stay usable offline."),
        "evidence": ["Cloudflare Worker + Durable Object + Workers AI, live",
                     "68 repository tests passing on the deployed revision",
                     "First-party learning analytics; export and delete honoured",
                     "No advertising trackers, by construction"],
    },
    {
        "title": "DeskOS",
        "logo": "logos/deskos.svg",
        "role": "Architect · operator command centre",
        "url": "deskos/",
        "cta": True,
        "access": "Closed console — access by arrangement",
        "demo": [],
        "what": ("An operator command centre in ten modules: overview and ECU, units and wCells, "
                 "lead hunting, outreach, approvals, and a ledger that makes every step "
                 "auditable. It is the system examined in The Governable Enterprise, and the "
                 "console itself is closed — the paper carries the method, the screens stay "
                 "with the operator."),
        "evidence": ["Ten operating modules in one shell, ~300KB served",
                     "Every step writes to an auditable ledger",
                     "Described and bounded in The Governable Enterprise"],
    },
    {
        "title": "STPi",
        "logo": "logos/stpi.svg",
        "role": "Architect & engineer · applied agent system",
        "url": "https://stpi.whop.site/",
        "cta": True,
        "demo": [],
        "what": ("A hiring agent that hunts country-specific sources twice a day, Monday to "
                 "Saturday, across South Africa, Zimbabwe, Zambia and fourteen other southern "
                 "African countries. Every advert is scored against the candidate's real "
                 "profile; a tailored cover letter and a country-formatted CV are drafted as "
                 "PDFs; one card is posted to the dashboard. Approve it and it sends from the "
                 "candidate's own mailbox, signed as the candidate, with the reply reaching "
                 "both — interview invites flagged. Reject it and the PDFs are deleted on the "
                 "spot. Nothing sends without a human line, and nothing is invented."),
        "evidence": ["17 southern African countries, hunted twice daily Monday–Saturday",
                     "One card, one decision: approve sends as the candidate, reject deletes the PDFs",
                     "Nothing sends unattended; unsent drafts expire at 72 hours",
                     "Ceilings enforced — 45s per fetch, 30s per provider, 35min per run, failing loudly with a live log",
                     "Free tier is the same build as the paid tiers: one candidate, five sends per UTC month, no card"],
    },
    {
        "title": "ContentOps",
        "logo": "logos/contentops.svg",
        "role": "Engineer · 2026",
        "url": "https://contentops-edge.simalidudu.workers.dev/demo",
        "cta": True,
        "demo": [("Live demo", "https://contentops-edge.simalidudu.workers.dev/demo")],
        "what": ("A zero-capital writing service: a week of posts for twenty platforms, drafted "
                 "from a client's own facts, then checked by a deterministic editor before "
                 "anything may publish. When the check fails, the slot stays empty."),
        "evidence": ["Worker + D1 in production; 185 Python and 101 Worker cases",
                     "Fact-bound generation: no invented numbers, no invented customers",
                     "Clients hold their own model keys — capability isolation",
                     "Formalised with its incidents in the Grounded Cadence paper"],
    },
    {
        "title": "Bluesky Growth Audit",
        "role": "Engineer · 2026",
        "url": "https://bsky-audit.simalidudu.workers.dev/",
        "cta": True,
        "demo": [("Run an audit", "https://bsky-audit.simalidudu.workers.dev/")],
        "what": ("A free, no-signup audit of a Bluesky account: posting cadence, engagement shape, "
                 "content mix and timing, with specific fixes rather than a score."),
        "evidence": ["Live and free to use", "No account, no tracker, no email capture",
                     "Reads public data only"],
    },
    {
        "title": "Hunta lead console",
        "role": "Engineer · internal",
        "url": None,
        "access": "Gated — 401 without credentials",
        "state": "gated",
        "demo": [],
        "what": ("The lead pipeline behind the hunta field report: discovery, admission gating and "
                 "a do-not-contact ledger, driven by scheduled agents."),
        "evidence": ["Deployed and gated (HTTP 401 without credentials — working as designed)",
                     "Admission gate refuses before a record exists, not at send time"],
    },
]

SKILLS = [
    ("Systems & backend", ["Cloudflare Workers, KV, D1, Durable Objects", "Node.js, Python",
                           "Serverless cost ceilings and quota design", "Event-sourced ledgers",
                           "Idempotency and recovery design"]),
    ("Agent systems", ["Agent scheduling: unattended hunts, human decision points",
                       "Approval gates with real side effects — approve sends, reject deletes",
                       "Capability ladders and idle witnesses: agents that act only inside their grant",
                       "Admission gating and do-not-contact ledgers, enforced before a record exists",
                       "Bounded runs with fail-loud logs — per-fetch, per-provider, per-run ceilings",
                       "Durable agent state, idempotent re-entry and 72-hour draft expiry",
                       "Deterministic checks on what an agent emits before it may emit it",
                       "Autonomy that escalates to a person for anything irreversible"]),
    ("AI in production", ["LLM provider ladders and failover", "Retrieval and fact-binding",
                          "Prompt and evaluation design",
                          "Capability isolation: clients hold their own model keys",
                          "Cost ceilings and quota ladders on every model call"]),
    ("Product & front end", ["Accessible single-file web apps", "Per-business-type storefront design",
                             "Make-in-one-link flows for low-end Android", "Offline-first workspaces"]),
    ("Delivery & operations", ["GitHub Actions CI/CD", "Test suites that pin refusals, not just outputs",
                               "Production forensics and incident write-ups", "Zero-budget infrastructure"]),
    ("Writing & research", ["Long-form non-fiction and textbooks", "Typesetting pipelines (Markdown → PDF/EPUB)",
                            "Design-science case studies", "Reproducible document builds"]),
]

CONTACT = [
    ("Email", "couragegarikai@atomicmail.io", "mailto:couragegarikai@atomicmail.io"),
    ("Calls", "+263 77 967 4212", "tel:+263779674212"),
    ("WhatsApp", "+263 78 460 0904", "https://wa.me/263784600904"),
    ("Telegram", "+263 78 460 0904", "https://t.me/+263784600904"),
    ("Company", "Jacaranda Labs — owner of the products on this page", None),
    ("Research funding", "Jacaranda Labs Think Tank", None),
    ("Press & permissions", "Jacaranda Labs, Harare", None),
]

# The source link is replaced by the storefronts a reader can actually visit. Every URL
# here is checked live; a store that is not published yet is not linked.
SITES = [
    ("Jacaranda Labs", "jacaranda-labs.whop.site", "https://jacaranda-labs.whop.site/"),
    ("Tapstall", "tapstall.zlnew.workers.dev", "https://tapstall.zlnew.workers.dev/"),
    ("ContentOps", "contentops-edge.simalidudu.workers.dev/demo",
     "https://contentops-edge.simalidudu.workers.dev/demo"),
    ("DeskOS", "king-kunta-cpu.github.io/tapstall/deskos",
     "https://king-kunta-cpu.github.io/tapstall/deskos/"),
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

def built_card(b, n):
    """One system, set as a register entry: number, mark, what it is, what is running.

    Where a system is closed, the entry says so in the same place a live one offers
    its button — a public URL on a private console is an invitation nobody meant to
    send, so closed entries carry no link at all."""
    demo = "".join(f'<a class="chip" href="{esc(u)}" target="_blank" rel="noopener">{esc(l)}</a>'
                   for l, u in b["demo"] if u != b.get("url"))
    ev = "".join(f"<li>{esc(e)}</li>" for e in b["evidence"])
    if b.get("logo"):
        mark = (f'<img class="build-logo" src="{esc(b["logo"])}" alt="" '
                f'width="54" height="54" loading="lazy" decoding="async"/>')
    else:                       # no published mark: a lettered tile, never a fake logo
        initials = "".join(w[0] for w in b["title"].replace("—", " ").split()[:2]).upper()
        mark = f'<span class="build-logo build-logo-text" aria-hidden="true">{esc(initials)}</span>'
    title = (f'<a href="{esc(b["url"])}" target="_blank" rel="noopener">{esc(b["title"])}</a>'
             if b.get("url") else esc(b["title"]))
    if b.get("cta"):
        action = (f'<a class="build-cta" href="{esc(b["url"])}" target="_blank" rel="noopener">'
                  f'view it in action in the wild here<span aria-hidden="true">→</span></a>')
    elif b.get("url"):
        action = (f'<a class="build-cta build-cta-quiet" href="{esc(b["url"])}" '
                  f'target="_blank" rel="noopener">open it<span aria-hidden="true">→</span></a>')
    else:
        action = f'<span class="build-shut">{esc(b.get("access", "internal · gated"))}</span>'
    kind = b.get("state") or ("live" if b.get("url") else "closed")
    label = {"live": "running", "gated": "running · gated", "closed": "closed"}[kind]
    state = f'<span class="{kind}"><span class="dot" aria-hidden="true"></span>{label}</span>'
    chips = f'<div class="chips">{demo}</div>' if demo else ""
    return f"""
      <article class="build">
        <div class="build-num" aria-hidden="true">{n:02d}</div>
        <div class="build-main">
          <div class="build-head">
            {mark}
            <div class="build-id">
              <h3>{title}</h3>
              <span class="build-role">{esc(b['role'])}</span>
            </div>
          </div>
          <p class="build-what">{esc(b['what'])}</p>
          <div class="build-actions">{action}{state}</div>
        </div>
        <aside class="build-side">
          <div class="build-side-label">What is running</div>
          <ul class="build-evidence">{ev}</ul>
          {chips}
        </aside>
      </article>"""


def skills_block():
    return "".join(
        f'<div class="skill{" lead" if name == "Agent systems" else ""}"><h4>{esc(name)}</h4><ul>' +
        "".join(f"<li>{esc(x)}</li>" for x in items) + "</ul></div>"
        for name, items in SKILLS)


def contact_block():
    out = []
    for label, value, href in CONTACT:
        v = f'<a href="{esc(href)}">{esc(value)}</a>' if href else esc(value)
        out.append(f'<li><span class="c-label">{esc(label)}</span><span class="c-value">{v}</span></li>')
    return "".join(out)


def cover(w, cls="cover"):
    """The author's own cover artwork where the source file carried it; a typographic
    panel where it did not. The panel is deliberately plain and never imitates art —
    a made-up cover for a real book would be a small forgery."""
    if w.get("cover"):
        return (f'<div class="{cls} has-art">'
                f'<img src="{esc(w["cover"])}" alt="Cover of {esc(w["title"])}" '
                f'loading="lazy" decoding="async"/></div>')
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
        </div>
        <div class="cov-foot">
          <span>{esc(AUTHOR)}</span>
          <span>{esc(str(w['pages']) + ' pp' if w['pages'] else '')}</span>
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
        # The href still downloads, exactly as before. data-read is what the click
        # additionally opens, so nobody is left staring at an empty downloads folder.
        read = f' data-read="{esc(w["read"])}"' if w.get("read") else ""
        out.append(f'<a class="chip" href="{esc(url)}"{read}>{esc(label)}</a>')
    return '<div class="chips">' + "".join(out) + "</div>"


def facts(w):
    bits = [extent(w)]
    if w["words"]:
        bits.append(f"{w['words']:,} words")
    bits.append(w["licence"])
    return " · ".join(esc(b) for b in bits)


def primary_link(w, inner, cls=""):
    """Title and cover open the work's own page: jacket, argument, contents, every
    format, and the one button that reads and downloads in the same click. Nothing
    downloads by accident from the catalogue any more — the work page asks first."""
    c = f' class="{cls}"' if cls else ""
    return f'<a{c} href="works/{esc(w["id"])}.html">{inner}</a>'


def featured_card(w):
    return f"""
      <article class="card" data-kind="{w['kind']}" id="card-{esc(w['id'])}">
        {primary_link(w, cover(w), "cover-link")}
        <div class="card-body">
          <div class="card-meta">{esc(KIND_LABEL[w['kind']])} · {esc(w['year'])}</div>
          <div class="status">{esc(w['status'])}</div>
          <h2>{primary_link(w, esc(w['title']))}</h2>
          <p class="sub">{esc(w['subtitle'])}</p>
          <p class="blurb">{esc(w['blurb'])}</p>
          <p class="note">{esc(w['note'])}</p>
          <div class="card-foot">
            <span class="facts">{facts(w)}</span>
            {chips(w)}
          </div>
          <a class="more" href="works/{esc(w['id'])}.html">What is inside, and every format
          <span aria-hidden="true">→</span></a>
        </div>
      </article>"""


def shelf_row(w):
    thumb = (f'<img class="row-thumb" src="{esc(w["cover"])}" alt="" loading="lazy" decoding="async"/>'
             if w.get("cover") else '<div class="row-thumb row-thumb-none"></div>')
    return f"""
      <article class="row" data-kind="{w['kind']}" id="{esc(w['id'])}">
        <div class="row-year">{esc(w['year'])}</div>
        {thumb}
        <div class="row-main">
          <h3>{primary_link(w, f'<span class="row-title">{esc(w['title'])}</span>')}
            <span class="row-sub">{esc(w['subtitle'])}</span></h3>
          <div class="status status-row">{esc(w['status'])}</div>
          <p class="blurb">{esc(w['blurb'])}</p>
          <div class="card-foot">
            <span class="facts">{facts(w)}</span>
            {chips(w)}
          </div>
          <a class="more" href="works/{esc(w['id'])}.html">What is inside, and every format
          <span aria-hidden="true">→</span></a>
        </div>
      </article>"""


# --------------------------------------------------------------------------- sharing
#
# The icons are drawn here as paths rather than pulled from a brand kit: no network
# at render time, nothing to break, and the widget survives being opened offline.

SHARE_ICONS = {
    "x": '<path d="M3.4 3.4l13.2 13.2M16.6 3.4L3.4 16.6"/>',
    "linkedin": ('<rect x="2.6" y="2.6" width="14.8" height="14.8" rx="2.2"/>'
                 '<path d="M6.4 8.2v5.4M6.4 5.5v.2M9.8 13.6V8.2m0 2.2a2 2 0 014 0v3.2"/>'),
    "whatsapp": ('<path d="M10 2.9a7 7 0 00-5.9 10.6L3 17.1l3.7-1.1A7 7 0 1010 2.9z"/>'
                 '<path d="M7.3 7.4c.2 2 1.8 3.7 3.8 4.2.6.2 1.2-.2 1.3-.8v-.5l-1.5-.6-.6.7a4.6 4.6 0 01-1.7-1.7l.7-.6-.6-1.5h-.5c-.5 0-.9.3-.9.8z" '
                 'fill="currentColor" stroke="none"/>'),
    "telegram": '<path d="M17 3.6L2.9 9.2l3.9 1.3 1.4 4.3 2-2.4 3.3 2.4z"/><path d="M6.8 10.5l8-4.9-5.3 6.4"/>',
    "facebook": ('<rect x="2.6" y="2.6" width="14.8" height="14.8" rx="2.2"/>'
                 '<path d="M12.3 17V10.8h2.1l.3-2.4h-2.4V6.9c0-.7.2-1.1 1.2-1.1h1.3V3.7c-.2 0-1-.1-1.9-.1-1.9 0-3.1 1.1-3.1 3.2v1.6H7.6v2.4h2.2V17z"/>'),
    "mail": '<rect x="2.6" y="4.4" width="14.8" height="11.2" rx="1.6"/><path d="M3.2 5.4L10 10.6l6.8-5.2"/>',
    "copy": ('<path d="M7.6 7.6h9v9h-9z"/><path d="M12.4 7.6V3.4h-9v9h4.2"/>'),
    "phone": ('<path d="M5.2 3.4h2.6l1.2 3-1.6 1.2a8 8 0 004.9 4.9l1.2-1.6 3 1.2v2.6c0 .9-.7 1.6-1.6 1.6A13.4 13.4 0 013.6 5'
              'c0-.9.7-1.6 1.6-1.6z"/>'),
}


def _icon(name):
    return (f'<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">'
            f'{SHARE_ICONS[name]}</svg>')


def share_bar(url, title, label="Share"):
    """A share row that works with scripts disabled: every target is a plain link to
    the network's own share endpoint. The copy button is the only thing that needs
    JavaScript, and it is the only thing that degrades."""
    u = urllib.parse.quote(url, safe="")
    t = urllib.parse.quote(title, safe="")
    targets = [
        ("x", f"https://twitter.com/intent/tweet?text={t}&url={u}", "Share on X"),
        ("linkedin", f"https://www.linkedin.com/sharing/share-offsite/?url={u}", "Share on LinkedIn"),
        ("whatsapp", f"https://wa.me/?text={t}%20{u}", "Share on WhatsApp"),
        ("telegram", f"https://t.me/share/url?url={u}&text={t}", "Share on Telegram"),
        ("facebook", f"https://www.facebook.com/sharer/sharer.php?u={u}", "Share on Facebook"),
        ("mail", f"mailto:?subject={t}&body={u}", "Send by email"),
    ]
    links = "".join(
        f'<a href="{href}" target="_blank" rel="noopener" aria-label="{esc(name)}" '
        f'title="{esc(name)}">{_icon(icon)}</a>'
        for icon, href, name in targets)
    copy = (f'<button type="button" data-copy="{esc(url)}" aria-label="Copy the link" '
            f'title="Copy the link">{_icon("copy")}</button>')
    return f'<div class="share"><span class="sh-label">{esc(label)}</span>{links}{copy}</div>'


def float_contact(prefix=""):
    """The floating button: the animated mark, linked to the channel it names, with
    one quieter call button beside it. Two honest actions, no menu, nothing hidden."""
    return f"""
<div class="fly" aria-label="Contact">
  <a class="fly-call" href="tel:+263779674212" aria-label="Call Courage Garikai on +263 77 967 4212"
     title="Call +263 77 967 4212">{_icon("phone")}</a>
  <a class="fly-main" href="https://wa.me/263784600904" target="_blank" rel="noopener"
     aria-label="Message Courage Garikai on WhatsApp at +263 78 460 0904, or call +263 77 967 4212">
    <img src="{prefix}contact-me.gif" width="360" height="128" alt="Contact me">
  </a>
</div>"""


SHARE_CSS = """
/* sharing */
.share{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:20px 0 0}
.share .sh-label{font:600 9.5px/1 var(--sans,ui-sans-serif,system-ui,sans-serif);letter-spacing:.2em;text-transform:uppercase;
  color:var(--muted,#6d6f74);flex:0 0 100%;margin:0 0 2px}
.share a,.share button{width:32px;height:32px;display:inline-grid;place-items:center;padding:0;
  border:1px solid var(--rule,#ddd7c8);border-radius:50%;background:transparent;color:inherit;
  text-decoration:none;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
.share a:hover,.share button:hover,.share a:focus-visible,.share button:focus-visible{
  background:currentColor;border-color:currentColor}
.share a:hover svg,.share button:hover svg{stroke:var(--paper,#faf7f0)}
.share a:hover svg [fill="currentColor"],.share button:hover svg [fill="currentColor"]{fill:var(--paper,#faf7f0)}
.share svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:1.5;
  stroke-linecap:round;stroke-linejoin:round}
.share button.done{background:#2f6b4f;border-color:#2f6b4f;color:#fff}
.band .share a,.band .share button,.dark .share a,.dark .share button{border-color:rgba(242,238,228,.32)}
.band .share a:hover,.band .share button:hover{color:var(--panel);background:var(--panel-ink)}

/* the floating contact button */
.fly{position:fixed;right:16px;bottom:16px;z-index:60;display:flex;align-items:flex-end;
  gap:8px;filter:drop-shadow(0 10px 24px rgba(15,14,12,.28))}
.fly-main{display:block;line-height:0;border-radius:999px;transition:transform .18s ease}
.fly-main img{width:clamp(132px,30vw,176px);height:auto;display:block;border-radius:999px}
.fly-main:hover,.fly-main:focus-visible{transform:translateY(-2px)}
.fly-call{width:42px;height:42px;display:grid;place-items:center;border-radius:50%;
  background:var(--ink,#15171a);color:var(--paper,#faf7f0);border:1px solid rgba(250,247,240,.28);
  text-decoration:none;transition:transform .18s ease}
.fly-call svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.6;
  stroke-linecap:round;stroke-linejoin:round}
.fly-call:hover,.fly-call:focus-visible{transform:translateY(-2px);background:var(--accent,#a8332c)}
@media (max-width:620px){
  .fly{right:10px;bottom:10px;gap:6px}
  .fly-call{width:38px;height:38px}
}
@media (prefers-reduced-motion:reduce){.fly-main:hover,.fly-call:hover{transform:none}}
"""


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
body{margin:0;color:var(--ink);font:17px/1.62 var(--serif);background:var(--paper);padding-bottom:84px}
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
nav.mast-nav a.nav-consult{color:var(--ink);font-weight:700}



/* avatar lockup — the mark where a photograph would be */
.lockup{display:flex;align-items:center;gap:20px;margin-bottom:26px}
.avatar{width:104px;height:104px;border-radius:50%;display:block;flex:none;
  box-shadow:0 12px 30px -14px rgba(0,0,0,.8),0 0 0 1px #2a2c30}
.lockup-text .eyebrow{margin:0 0 8px}
.lockup-name{font:400 17px/1 var(--serif);letter-spacing:.02em;color:#f7f4ec}
@media (max-width:620px){
  .avatar{width:76px;height:76px}
  .lockup{gap:14px;margin-bottom:20px}
  .lockup-name{font-size:15px}
}

/* ownership, stated once and plainly */
.owner{border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);
  padding:34px 0;margin:0 0 6px;display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);
  gap:40px;align-items:start}
.owner h2{font:400 26px/1.2 var(--serif);margin:0 0 10px;letter-spacing:-.012em}
.owner p{margin:0;color:#41464b;font-size:14.8px;line-height:1.62}
.owner .brands{display:grid;grid-template-columns:1fr 1fr;gap:10px 26px;list-style:none;
  margin:16px 0 0;padding:0}
.owner .brands li{font-size:14px;color:#3a3f44;padding:7px 0;border-bottom:1px solid var(--rule)}
.owner .brands li b{font-weight:600;color:var(--ink)}
.owner .think{grid-column:1/-1;border-left:2px solid var(--accent);padding:2px 0 2px 16px;
  margin-top:6px}
.owner .think b{color:var(--ink)}
@media (max-width:820px){.owner{grid-template-columns:1fr;gap:22px}}
@media (max-width:520px){.owner .brands{grid-template-columns:1fr}}

/* ---- consulting opening: the first thing a visitor reads ---------------- */
.hero-consult{background:var(--ink);color:#f2eee4;padding:74px 0 66px;
  border-bottom:1px solid #2a2c30}
.hero.hero-consult .eyebrow{color:#d8b26a}
.hero.hero-consult h1{color:#f7f4ec}
.hero.hero-consult h1 em{color:#e0b978}
.hero.hero-consult .lede{color:#cdc8bc;font-size:19px;line-height:1.62;max-width:35em;margin-bottom:0}
.hero-consult .wrap{max-width:1080px;margin:0 auto;padding:0 32px}
.cta-row{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin:30px 0 46px}
.btn-solid{display:inline-flex;align-items:center;gap:10px;padding:15px 22px;border-radius:2px;
  background:#e0b978;color:#15171a;text-decoration:none;
  font:600 11px/1 var(--sans);letter-spacing:.14em;text-transform:uppercase}
.btn-solid:hover{background:#f2d7a4}
.btn-solid span{transition:transform .15s ease}
.btn-solid:hover span{transform:translateX(4px)}
.btn-line{display:inline-flex;align-items:center;padding:15px 18px;border:1px solid #3a3d42;
  border-radius:2px;color:#e7e2d6;text-decoration:none;
  font:600 11px/1 var(--sans);letter-spacing:.13em;text-transform:uppercase}
.btn-line:hover{border-color:#e0b978;color:#e0b978}
.grit{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:1px;
  background:#2a2c30;border:1px solid #2a2c30;margin:0 0 44px}
.grit-card{background:#15171a;padding:24px 22px 26px}
.grit-card h2{font:400 19px/1.25 var(--serif);margin:0 0 10px;color:#f7f4ec;
  padding-bottom:10px;border-bottom:1px solid #34373c}
.grit-card p{margin:0;font-size:14.2px;line-height:1.62;color:#b7b2a6}
.offer{margin:0 0 44px}
.offer h2{font:600 10.5px/1 var(--sans);letter-spacing:.2em;text-transform:uppercase;
  color:#d8b26a;margin:0 0 16px;padding:0;border:0}
.offer ul{list-style:none;margin:0;padding:0;display:grid;gap:12px;max-width:52em}
.offer li{position:relative;padding-left:22px;font-size:14.8px;line-height:1.6;color:#c9c4b8}
.offer li::before{content:"—";position:absolute;left:0;color:#e0b978}
.offer li b{color:#f7f4ec;font-weight:600}
.hero.hero-consult .stats{border-top:1px solid #2a2c30;padding-top:24px;margin:0 0 26px}
.hero.hero-consult .stat .n{color:#e0b978}
.hero.hero-consult .stat .k{color:#949086}
.credentials{font-size:13.4px;line-height:1.6;color:#a9a49a;margin:0 0 22px;max-width:46em;
  padding-top:20px;border-top:1px solid #2a2c30}
.honesty{font-size:14.6px;line-height:1.65;color:#c9c4b8;margin:0;max-width:44em;
  border-left:2px solid #3a3d42;padding-left:16px}
/* the thesis line that carries the reader from the offer into the catalogue */
.thesis{padding:34px 0 10px}
.thesis p{margin:0;max-width:52em;font-size:16.4px;line-height:1.65;color:#3d4247}
.thesis b{color:var(--ink);font-weight:600}

/* hero */
.hero{padding:76px 0 54px;border-bottom:1px solid var(--rule)}
.hero .eyebrow{display:block;
  font:600 10.8px/1.5 var(--sans);letter-spacing:.185em;text-transform:uppercase;
  color:var(--accent);margin-bottom:26px}
.hero .eyebrow span{display:block;max-width:26em;line-height:1.6}

.hero h1{font-size:clamp(38px,5.6vw,64px);line-height:1.05;letter-spacing:-.022em;
  font-weight:400;margin:0 0 26px;max-width:16em}
.hero h1 em{font-style:italic;color:var(--accent);white-space:nowrap}
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
.featured{display:grid;grid-template-columns:1fr;gap:40px}
.cover-link{display:block;text-decoration:none;line-height:0}
.card{display:grid;grid-template-columns:172px minmax(0,1fr);gap:30px;align-items:start;
  border-top:3px solid var(--ink);padding-top:22px}
.cover{background:var(--panel);color:var(--panel-ink);aspect-ratio:3/4.3;padding:20px 19px;
  display:flex;flex-direction:column;justify-content:space-between;position:relative;
  overflow:hidden}
.cover.has-art{background:#fff;padding:0;display:block;overflow:hidden;
  border:1px solid #d8d3c6;box-shadow:0 10px 24px -14px rgba(20,18,16,.45)}
.cover.has-art img{width:100%;height:100%;object-fit:contain;display:block;background:#fff}
.cover.has-art::after{display:none}
.cover::after{content:"";position:absolute;inset:0;
  background:linear-gradient(160deg,rgba(255,255,255,.055),rgba(0,0,0,.28));pointer-events:none}
.cov-top{display:flex;justify-content:space-between;align-items:baseline;
  font:600 8.4px/1 var(--sans);letter-spacing:.18em;text-transform:uppercase;color:#b9b2a5;
  position:relative;z-index:1}
.cov-year{color:#8d877c}
.cov-body{position:relative;z-index:1}
.cov-rule{width:30px;height:2px;background:var(--accent);margin-bottom:14px}
.cover h3{font:400 21px/1.16 var(--serif);letter-spacing:-.012em;margin:0 0 11px}
.cover h3{font-size:15.5px;line-height:1.32;word-break:normal;overflow-wrap:break-word;hyphens:auto}
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
.card h2{font:400 26px/1.18 var(--serif);margin:0 0 7px;letter-spacing:-.012em}
.card h2 a{text-decoration:none}
.card h2 a:hover{color:var(--accent)}
.sub{font-style:italic;color:var(--muted);font-size:15px;margin:0 0 13px}
.blurb{font-size:14.8px;line-height:1.58;color:#3a3f44;margin:0 0 12px}
.note{font:600 10.5px/1.5 var(--sans);letter-spacing:.02em;color:var(--muted);
  border-left:2px solid var(--rule);padding-left:10px;margin:0 0 16px}
.card-foot{margin-top:auto;padding-top:14px;border-top:1px solid var(--rule);
  display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.facts{font:11.5px/1.4 var(--mono);color:var(--muted)}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.more{display:inline-block;margin:12px 0 0;text-decoration:none;
  font:600 9.5px/1.3 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
.more span{display:inline-block;transition:transform .15s}
.more:hover span{transform:translateX(3px)}
.band .more{color:var(--gold,#e0b978)}
.chip{font:600 9.5px/1 var(--sans);letter-spacing:.12em;text-transform:uppercase;
  text-decoration:none;padding:6px 8px;border:1px solid var(--rule);border-radius:2px;
  color:#41474c;background:#fff}
.chip:hover{background:var(--ink);color:var(--paper);border-color:var(--ink)}

/* shelf rows */
.subhead{margin:44px 0 0;border-top:1px solid var(--rule);padding-top:20px}
.subhead span{font:600 10.5px/1 var(--sans);letter-spacing:.2em;text-transform:uppercase;
  color:var(--muted)}
.rows{border-top:1px solid var(--rule)}
.row{display:grid;grid-template-columns:74px 92px 1fr;gap:26px;padding:30px 0;
  border-bottom:1px solid var(--rule);align-items:start}
.row-thumb{width:92px;aspect-ratio:3/4.2;object-fit:cover;display:block;
  box-shadow:0 1px 0 var(--rule),0 6px 18px rgba(0,0,0,.10);background:#efece4}
.row-thumb-none{background:linear-gradient(150deg,#e9e5db,#dbd6ca);box-shadow:none}
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
.plate .chip{background:#fff;border-color:#d9d3c4;color:#4a5055}
.plate .chip:hover{background:var(--ink);color:#f7f3e9;border-color:var(--ink)}
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


/* built / live work */
.plate{background:#f4f0e6;border-top:1px solid #ded8c8;border-bottom:1px solid #ded8c8;
  padding:68px 0 34px;margin-top:66px}
.plate .sec-head h2{color:var(--ink)}
.plate .sec-intro{color:#41464b;margin-bottom:40px}
.builds{display:grid;gap:0;border-top:2px solid var(--ink)}
.build{display:grid;grid-template-columns:52px minmax(0,1.12fr) minmax(0,.88fr);
  gap:0 44px;padding:38px 0 36px;border-bottom:1px solid #d9d3c4;align-items:start}
.build-num{font:400 12px/1 var(--sans);letter-spacing:.2em;color:#a8332c;padding-top:9px}
.build-main{min-width:0}
.build-head{display:flex;gap:16px;align-items:center;margin-bottom:16px}
.build-logo{width:54px;height:54px;border-radius:14px;flex:none;display:block;
  box-shadow:0 6px 16px -10px rgba(20,18,16,.65)}
.build-logo-text{display:grid;place-items:center;background:#17150f;color:#efe9db;
  font:400 16px/1 var(--serif);letter-spacing:.05em}
.build-id{min-width:0}
.build-head h3{font:400 26px/1.12 var(--serif);margin:0 0 6px;letter-spacing:-.012em}
.build-head h3 a{text-decoration:none;color:var(--ink)}
.build-head h3 a:hover{color:var(--accent)}
.build-role{display:block;font:600 9.4px/1.4 var(--sans);letter-spacing:.15em;
  text-transform:uppercase;color:#7d7a72;overflow-wrap:anywhere}
.build-what{font-size:15.2px;line-height:1.62;color:#3a3f44;margin:0 0 20px;max-width:40em}
.build-actions{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.build-cta{display:inline-flex;align-items:center;gap:10px;padding:12px 18px;
  background:var(--ink);border:1px solid var(--ink);border-radius:2px;text-decoration:none;
  font:600 10.5px/1 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:#f7f3e9}
.build-cta span{transition:transform .15s ease}
.build-cta:hover{background:var(--accent);border-color:var(--accent)}
.build-cta:hover span{transform:translateX(3px)}
.build-cta-quiet{background:transparent;color:var(--ink)}
.build-cta-quiet:hover{background:var(--ink);color:#f7f3e9;border-color:var(--ink)}
.build-shut{display:inline-flex;align-items:center;padding:12px 16px;border:1px dashed #c3bcaa;
  border-radius:2px;font:600 10px/1 var(--sans);letter-spacing:.13em;text-transform:uppercase;
  color:#7d7a72}
.build-side{border-left:1px solid #d9d3c4;padding-left:34px;min-width:0}
.build-side-label{font:600 9.2px/1 var(--sans);letter-spacing:.19em;text-transform:uppercase;
  color:#8a8578;margin-bottom:12px}
.build-evidence{list-style:none;margin:0;padding:0}
.build-evidence li{font-size:13.1px;line-height:1.5;color:#4a5055;padding:9px 0 9px 14px;
  border-bottom:1px solid #e0dacb;position:relative}
.build-evidence li:last-child{border-bottom:0;padding-bottom:2px}
.build-evidence li::before{content:"";position:absolute;left:0;top:16px;width:5px;height:5px;
  border-radius:50%;background:#bfb8a6}
.build-side .chips{margin-top:16px}
.live{display:inline-flex;align-items:center;gap:7px;font:600 9.5px/1 var(--sans);
  letter-spacing:.16em;text-transform:uppercase;color:#3d7d59;text-decoration:none}
.live .dot{width:7px;height:7px;border-radius:50%;background:#1d7a4c;
  box-shadow:0 0 0 3px rgba(29,122,76,.14)}
.gated{display:inline-flex;align-items:center;gap:7px;font:600 9.5px/1 var(--sans);
  letter-spacing:.16em;text-transform:uppercase;color:#8a6a1f}
.gated .dot{width:7px;height:7px;border-radius:50%;background:#c08a1e;
  box-shadow:0 0 0 3px rgba(192,138,30,.16)}
.closed{display:inline-flex;align-items:center;gap:7px;font:600 9.5px/1 var(--sans);
  letter-spacing:.16em;text-transform:uppercase;color:#8d8a84}
.closed .dot{width:7px;height:7px;border-radius:50%;background:#9a968c}
.skills{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:34px 30px}
/* agent systems leads the section, so it takes the accent */
.skill h4{color:#7d7a72}
.skill.lead h4{color:var(--accent)}
.skill h4{font:600 10.5px/1.4 var(--sans);letter-spacing:.17em;text-transform:uppercase;
  color:var(--accent);margin:0 0 10px;padding-bottom:8px;border-bottom:2px solid var(--ink)}
.skill ul{list-style:none;margin:0;padding:0}
.skill li{font-size:14.2px;line-height:1.5;color:#3a3f44;padding:6px 0;border-bottom:1px solid var(--rule)}

/* contact */
.contact{display:grid;grid-template-columns:1.1fr .9fr;gap:48px;align-items:start}
.contact-list{list-style:none;margin:0;padding:0}
.sites-label{font:600 10px/1 var(--sans);letter-spacing:.19em;text-transform:uppercase;
  color:var(--muted);margin:26px 0 4px;padding-top:20px;border-top:1px solid var(--rule)}
.contact-list.sites li .c-value a{color:var(--ink)}
.contact-list.sites li .c-value{font-variant-numeric:tabular-nums;text-align:right;
  overflow-wrap:anywhere;font-size:12.5px}
.contact-list li{display:flex;justify-content:space-between;gap:18px;align-items:baseline;
  padding:13px 0;border-bottom:1px solid var(--rule)}
.c-label{font:600 10px/1.3 var(--sans);letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
.c-value{font-size:15.5px;text-align:right}
.c-value a{text-decoration:none;border-bottom:1px solid var(--rule)}
.c-value a:hover{color:var(--accent);border-color:var(--accent)}
.contact-note{font-size:14.6px;line-height:1.6;color:#3a3f44}
.contact-note b{font-weight:600;color:var(--ink)}

/* colophon */
footer.colophon{border-top:2px solid var(--ink);margin-top:40px;padding:34px 0 70px;
  font:12.5px/1.6 var(--sans);color:var(--muted)}
footer.colophon .wrap{display:flex;justify-content:space-between;gap:30px;flex-wrap:wrap}
footer.colophon .l{max-width:40em}
footer.colophon a{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--rule)}

@media (max-width:900px){
  .featured{grid-template-columns:1fr}
  .build{grid-template-columns:36px minmax(0,1fr);gap:0 18px}
  .build-side{grid-column:2;border-left:0;border-top:1px solid #d9d3c4;padding:18px 0 0;
    margin-top:22px}
  .build-evidence li{padding-left:13px}
  .card,.band .card{grid-template-columns:132px minmax(0,1fr);gap:20px}
  .cover h3{font-size:16px}
  .cover{aspect-ratio:3/4.2}
  .contact{grid-template-columns:1fr;gap:30px}
  .about{grid-template-columns:1fr;gap:34px}
  .aside{border-left:0;border-top:1px solid var(--rule);padding:26px 0 0}
}
@media (max-width:900px){
  .hero-consult{padding:52px 0 50px}
  .hero-consult .wrap{padding:0 20px}
  .hero-consult .lede{font-size:17.6px}
}
@media (max-width:620px){
  .stats{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  .cta-row .btn-solid,.cta-row .btn-line{width:100%;justify-content:center}
  .hero-consult .stat .n{font-size:26px}
  .grit-card{padding:20px 18px 22px}
  .build{grid-template-columns:minmax(0,1fr);padding:32px 0 30px}
  .build-num{display:none}
  .build-side{grid-column:1}
  .build-logo{width:46px;height:46px;border-radius:12px}
  .build-head h3{font-size:22px}
  .build-cta{width:100%;justify-content:center}
  .sec-head{flex-wrap:wrap;gap:6px}
  .card,.band .card{grid-template-columns:1fr;gap:18px}
  .cover{aspect-ratio:3/2.9}
  .wrap{padding:0 20px}
  .hero{padding:48px 0 40px}
  .hero .eyebrow{font-size:9px;letter-spacing:.085em;gap:6px;margin-bottom:20px}
  .hero h1 em{white-space:normal}
  .row{grid-template-columns:76px 1fr;gap:16px}
  .row-year{border-right:0;padding-top:0;grid-column:1/-1;margin-bottom:2px}
  .row-thumb{width:76px}
  .row-main{grid-column:2}
  .skills{grid-template-columns:1fr;gap:28px}
  .contact-list li{flex-direction:column;align-items:flex-start;gap:2px}
  .mast .wrap{flex-direction:column;align-items:flex-start;gap:11px}
  nav.mast-nav{gap:16px;flex-wrap:wrap;row-gap:8px}
}
@media print{ header.mast{position:static} .filters{display:none} body{background:#fff} }
""" + SHARE_CSS

JS = """
/* Every download in the catalogue also opens the work in a window of its own.
   The href still points at the file, so the download happens exactly as before;
   the new window is the reading view, so nobody is left hunting for a file. */
document.querySelectorAll('[data-read]').forEach(function(a){
  a.addEventListener('click', function(){
    var w = window.open(a.getAttribute('data-read'), '_blank');
    if (w) { w.opener = null; }
  });
});

document.querySelectorAll('[data-copy]').forEach(function(b){
  b.addEventListener('click', function(){
    var text = b.getAttribute('data-copy');
    var done = function(){ b.classList.add('done'); setTimeout(function(){ b.classList.remove('done'); }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function(){});
    } else {
      var t = document.createElement('textarea');
      t.value = text; t.setAttribute('readonly',''); document.body.appendChild(t);
      t.select(); try { document.execCommand('copy'); done(); } catch (e) {}
      document.body.removeChild(t);
    }
  });
});

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
    for w in WORKS:                      # reading views are written before the page
        w["read"] = read_view(w) if w["formats"] else None
    featured = [w for w in WORKS if w["featured"]]
    research = [w for w in featured if w["kind"] == "research"]
    books = [w for w in WORKS if w["kind"] == "book"]
    flagship = books          # every book gets a card, and therefore a cover
    also = []                 # no second-class books
    essays = [w for w in WORKS if w["kind"] == "essay"]

    total_pages = sum(w["pages"] or 0 for w in WORKS)
    total_words = sum(w["words"] or 0 for w in WORKS)

    cards = "".join(featured_card(w) for w in flagship)
    builds = "".join(built_card(b, i + 1) for i, b in enumerate(BUILT))
    skills = skills_block()
    contacts = contact_block()
    sites = "".join(
        f'<li><span class="c-label">{esc(name)}</span>'
        f'<span class="c-value"><a href="{esc(url)}" target="_blank" rel="noopener">{esc(shown)}</a></span></li>'
        for name, shown, url in SITES)
    research_block = "".join(featured_card(w) for w in research)
    rows = "".join(shelf_row(w) for w in essays)
    share_row = share_bar(SITE + "/", f"{AUTHOR} — books, research and running systems",
                          "Share the catalogue")
    floating = float_contact()

    doc = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="favicon.ico" sizes="16x16 32x32 48x48 64x64">
<link rel="icon" type="image/svg+xml" href="favicon.svg">
<link rel="apple-touch-icon" href="brand/icon-180.png">
<meta name="theme-color" content="#15171a">
<meta property="og:image" content="brand/icon-512.png">
<title>{esc(AUTHOR)} — AI infrastructure, autonomous systems, books and research</title>
<meta name="description" content="{esc(AUTHOR)} writes and builds merchant rails and autonomous AI operations for low-infrastructure markets. Books, research papers and field reports, in PDF, EPUB, HTML and Markdown.">
<meta name="author" content="{esc(AUTHOR)}">
<style>{CSS}</style>
</head>
<body>

<header class="mast">
  <div class="wrap">
    <div class="brand">{esc(AUTHOR)} <span>·</span> Harare</div>
    <nav class="mast-nav">
      <a href="#consult" class="nav-consult">Consulting</a>
      <a href="#company">Company</a>
      <a href="#books">Books</a>
      <a href="#research">Research</a>
      <a href="#work">Built</a>
      <a href="#skills">Skills</a>
      <a href="#contact">Contact</a>
    </nav>
  </div>
</header>

<main>
  <section class="hero hero-consult" id="consult">
    <div class="wrap">
      <div class="lockup">
        <img class="avatar" src="avatar.gif" alt="Courage Garikai" width="104" height="104"
             loading="eager" decoding="async">
        <div class="lockup-text">
          <div class="eyebrow"><span>Consulting · Harare · southern Africa and remote</span></div>
          <div class="lockup-name">Courage Garikai</div>
        </div>
      </div>
      <h1>You do not need another deck. You need someone who has already
      watched this fail — <em>and knows which part is structural.</em></h1>
      <p class="lede">Fifteen years of techno-preneurship: merchant rails, agent systems, learning
      platforms, publishing pipelines. Some of it runs today and is linked on this page. More of it
      failed, and the failures are the part I am proudest of, because they are the part I can hand
      you as a map instead of a warning.</p>

      <div class="cta-row">
        <a class="btn-solid" href="mailto:couragegarikai@atomicmail.io?subject=Consulting%20—%20what%20I%20am%20trying%20to%20build">Start a conversation<span aria-hidden="true">→</span></a>
        <a class="btn-line" href="https://wa.me/263784600904">WhatsApp</a>
        <a class="btn-line" href="tel:+263779674212">+263 77 967 4212</a>
      </div>

      <div class="grit">
        <div class="grit-card">
          <h2>Dirt under the fingernails</h2>
          <p>These systems have been run as the operator, not admired from an advisory seat: the
          3am incident, the post-mortem written the same night, the fix shipped, the explanation
          given to the person paying for it. Advice from someone who has never carried the pager is
          a guess with a typeface.</p>
        </div>
        <div class="grit-card">
          <h2>A failure log, not a logo wall</h2>
          <p>Instead of client badges, there is a taxonomy of the five ways this class of system
          fails — each with a signature, a detector and a design response — written up in a
          working paper anyone can read. Failure is the expensive half of the education. Mine is
          documented, and I will walk you through it.</p>
        </div>
        <div class="grit-card">
          <h2>Constraint-native, not constraint-aware</h2>
          <p>Built for intermittent power, low-end Android, bandwidth that disappears, no card
          rails and no credit history — because that is where the demand already is. If your plan
          assumes a postcode and always-on internet, the constraints are not a footnote in the
          brief. They are the brief.</p>
        </div>
      </div>

      <div class="offer">
        <h2>What I am hired to do</h2>
        <ul>
          <li><b>AI operations and agent governance.</b> Where an agent may act, where a person
          must tap, and how to prove afterwards that it did what you said it did.</li>
          <li><b>Merchant commerce and reconciliation.</b> Rails that hold no customer funds, and
          statements that can be recomputed by someone who does not trust you yet.</li>
          <li><b>Zero-budget infrastructure.</b> Systems that run at $0 marginal cost with the
          ceilings stated — because a cost ceiling is a design material, not an afterthought.</li>
          <li><b>Learning platforms and facilitation.</b> Curriculum, activities and offline-first
          workspaces that survive a bad connection and a shared phone.</li>
          <li><b>Publishing pipelines.</b> One source file to PDF, EPUB, HTML and Markdown, per
          title. Thirteen works are the receipt.</li>
        </ul>
      </div>

      <div class="stats">
        <div class="stat"><div class="n">15</div><div class="k">Years techno-preneurship</div></div>
        <div class="stat"><div class="n">7</div><div class="k">Systems running now</div></div>
        <div class="stat"><div class="n">13</div><div class="k">Published works</div></div>
        <div class="stat"><div class="n">420</div><div class="k">Assertions in the suite</div></div>
      </div>

      <p class="credentials">BSc Entrepreneurship &amp; Business Management (Creativity) ·
      MSc Applied Entrepreneurship (Innovation &amp; Technology) —
      Chinhoyi University of Technology, Zimbabwe's technology university.</p>

      <p class="honesty">No availability theatre and no scarcity clock: if the problem is real and
      the constraints are yours, write. If it is not, that gets said in the first call — it has
      happened before, and it is cheaper for both of us than a proposal nobody believes.</p>
    </div>
  </section>

    <div class="wrap">
    <section class="owner" id="company">
      <div>
        <h2>The company behind the pieces</h2>
        <p><b>Jacaranda Labs</b> is mine. It is the company that owns the products on this page —
        not a label on a résumé, the entity that carries them.</p>
      </div>
      <div>
        <ul class="brands">
          <li><b>Tapstall</b> — merchant commerce rail</li>
          <li><b>STPi</b> — applied hiring agents</li>
          <li><b>DeskOS</b> — operator command centre</li>
          <li><b>ContentOps</b> — content operations</li>
          <li><b>Open Practice</b> — AI learning platform</li>
          <li><b>Bluesky Audit</b> — growth audit</li>
        </ul>
        <p class="think"><b>Jacaranda Labs Think Tank</b> is the research arm, and the reason the
        writing exists: it funds the research, the books and the papers. Editions are published
        under Jacaranda Labs Press, and every working paper here states what it has and has not
        proved — because a funder who wants the truth is worth naming accurately.</p>
      </div>
    </section>

    <section class="thesis">
      <p><b>Demand was never the problem. Infrastructure was.</b> Thirteen published works on
      trade, technology and constraint — seven books, four working papers and two short volumes —
      come out of the same practice: each produced from a single source file and shipped in four
      formats, so a reader needs no particular app to read a book.</p>
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

  <section class="plate" id="work">
    <div class="wrap">
      <div class="sec-head">
        <h2>Built and running</h2>
        <div class="kicker">Seven systems · five answer a browser</div>
      </div>
      <p class="sec-intro">A portfolio of writing is an argument; a portfolio of running
      systems is evidence. Five of these open to a browser today, one more answers only with
      credentials, and one is a closed console that says so rather than pretending. Every link
      goes to the working product — nothing here is a mock-up or a screenshot. All seven are
      Jacaranda Labs products.</p>
      <div class="builds">{builds}</div>
    </div>
  </section>

  <div class="wrap">
    <section id="skills">
      <div class="sec-head">
        <h2>What I do</h2>
        <div class="kicker">Skills and experience</div>
      </div>
      <div class="skills">{skills}</div>
    </section>

  </div>

    <section id="about">
      <div class="sec-head">
        <h2>About</h2>
        <div class="kicker">{esc(PRESS)}</div>
      </div>
      <div class="about">
        <div>
          <p>The writing starts where the assumptions imported into a market simply do not
          hold — always-on power, card rails, a postcode, a credit history. The building
          follows: autonomous cognitive infrastructure that assumes none of them, and keeps a
          record when the connection drops. Consulting is the same work with a client in the
          room: fifteen years of running these things, including the ones that failed, brought to
          bear on someone else's problem.</p>
          <p><b>Autonomous Cognitive Infrastructure Engineer, Operator, Writer.</b> Three
          descriptions of one job: design systems that act on their own, write down how they
          fail, and stay answerable for the run. The writing is governance-first architecture,
          evidence and constraint. The building is merchant rails, operator consoles, learning
          platforms, hiring infrastructure and publishing pipelines — each deployed, each
          documented in public.</p>
          <p>No single product defines the practice. <b>Tapstall</b> is one of the systems
          that came out of it, and the books are another: the catalogue above is the written
          half, and the systems above that are the running half.</p>
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
            <li><b>Role</b> — Autonomous Cognitive Infrastructure Engineer, Operator, Writer</li>
            <li><b>Available for</b> — consulting engagements, in southern Africa and remote</li>
            <li><b>Education</b> — BSc Entrepreneurship &amp; Business Management (Creativity);
            MSc Applied Entrepreneurship (Innovation &amp; Technology), Chinhoyi University of
            Technology</li>
            <li><b>Practice</b> — 15 years of techno-preneurship, including the failures</li>
            <li><b>Company</b> — Jacaranda Labs, which owns the products on this page;
            Jacaranda Labs Think Tank funds the research and publishing</li>
            <li><b>Books</b> — seven long-form titles</li>
            <li><b>Research</b> — four working papers, DCAI series</li>
            <li><b>Essays &amp; reports</b> — two shorter volumes</li>
            <li><b>Formats</b> — PDF, EPUB, HTML, Markdown where an edition is public</li>
            <li><b>Words in print</b> — {total_words:,} across the four text-native works</li>
          </ul>
          <h4>Correspondence</h4>
          <ul>
            <li>Press and permissions — Jacaranda Labs, Harare</li>
            <li>Email — <a href="mailto:couragegarikai@atomicmail.io">couragegarikai@atomicmail.io</a></li>
            <li>Calls — <a href="tel:+263779674212">+263 77 967 4212</a></li>
          </ul>
        </aside>
      </div>
    </section>
  </div>

  <div class="wrap">
    <section id="contact">
      <div class="sec-head">
        <h2>Contact</h2>
        <div class="kicker">Harare, Zimbabwe · CAT/SAST</div>
      </div>
      <div class="contact">
        <div>
          <p class="contact-note"><b>Available for</b> systems design, AI operations reviews,
          autonomous cognitive infrastructure work, and building commerce or learning
          infrastructure for constrained markets. I work
          remote-first and I am comfortable with intermittent power and bandwidth, because
          that is the environment the infrastructure has to run in.</p>
          <p class="contact-note"><b>Best first message:</b> what the system has to do, who
          uses it, and what happens today when it fails. If the answer is "nothing yet", that
          is a fine place to start.</p>
        </div>
        <div>
          <ul class="contact-list">{contacts}</ul>
          <div class="sites-label">Where it runs</div>
          <ul class="contact-list sites">{sites}</ul>
          {share_row}
        </div>
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

{floating}
<script>{JS}</script>
</body>
</html>
"""
    return doc, total_pages


OUT_DIR = Path("pages/public/portfolio")
READ_DIR = OUT_DIR / "read"

READ_SCRIPT = """
<script>
/* A work page links here with ?dl=<file>. The reading edition is the destination and
   the download starts beside it, not instead of it. Nothing is dispatched unless a
   work page asked for it, so a reader who lands here directly gets no surprise file. */
(function(){
  var p = new URLSearchParams(location.search).get('dl');
  if (!p) return;
  var a = document.createElement('a');
  a.href = decodeURIComponent(p);
  a.setAttribute('download', '');
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){ a.remove(); }, 5000);
})();
</script>
"""


def read_view(w):
    """A window a reader can land in, instead of an empty tab and a downloads folder.

    Where the work has an HTML edition, that edition is copied here and served as
    text/html, so the browser renders the book itself. Where the only edition is a
    PDF, an edition page is generated: the cover, the facts, every format, and one
    sentence saying the file is on its way. Nothing here invents a format."""
    READ_DIR.mkdir(parents=True, exist_ok=True)
    html_url = w["formats"].get("HTML")
    local = None
    if html_url and "/raw/main/" in html_url:
        cand = Path(html_url.split("/raw/main/", 1)[1])
        if cand.exists():
            local = cand
    target = READ_DIR / f"{w['id']}.html"
    if local:
        # The edition is copied verbatim, with one addition: a wide table may not push
        # the whole page sideways on a phone, so the table scrolls inside its own box.
        book = local.read_text(encoding="utf-8")
        patch = ("\n<style>@media (max-width:760px){"
                 "table{display:block;max-width:100%;overflow-x:auto;"
                 "-webkit-overflow-scrolling:touch}"
                 "p,li,td,th,dd{overflow-wrap:anywhere}"
                 ".m{white-space:normal;overflow-wrap:anywhere}"
                 "pre,code{overflow-wrap:anywhere;white-space:pre-wrap}}"
                 "</style>\n")
        book = book.replace("</head>", patch + "</head>", 1) if "</head>" in book else patch + book
        book = (book.replace("</body>", READ_SCRIPT + "</body>", 1) if "</body>" in book
                else book + READ_SCRIPT)
        target.write_text(book, encoding="utf-8")
        return f"read/{w['id']}.html"
    cover = (f'<img class="ed-cover" src="../{esc(w["cover"])}" '
             f'alt="Cover of {esc(w["title"])}"/>' if w.get("cover")
             else '<div class="ed-cover ed-cover-none">No cover artwork supplied</div>')
    buttons = "".join(
        f'<a class="ed-btn" href="{esc(u)}">{esc(k)}</a>' for k, u in w["formats"].items())
    target.write_text(f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="../favicon.ico" sizes="16x16 32x32 48x48 64x64">
<link rel="icon" type="image/svg+xml" href="../favicon.svg">
<link rel="apple-touch-icon" href="../brand/icon-180.png">
<meta name="theme-color" content="#15171a">
<title>{esc(w['title'])} — {esc(AUTHOR)}</title>
<style>
  body{{margin:0;background:#f7f4ec;color:#191714;
    font:16px/1.6 Georgia,'Times New Roman',serif}}
  .wrap{{max-width:760px;margin:0 auto;padding:56px 24px 80px}}
  .kind{{font:600 10.5px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.2em;
    text-transform:uppercase;color:#a8332c;margin-bottom:18px}}
  h1{{font-size:clamp(30px,4.6vw,44px);line-height:1.12;letter-spacing:-.018em;margin:0 0 10px}}
  .sub{{font-style:italic;color:#5b5650;margin:0 0 26px}}
  .cols{{display:grid;grid-template-columns:200px minmax(0,1fr);gap:32px;align-items:start}}
  .ed-cover{{width:100%;height:auto;display:block;border:1px solid #ded8ca;background:#fff;
    box-shadow:0 12px 28px -18px rgba(20,18,16,.5)}}
  .ed-cover-none{{aspect-ratio:3/4.2;display:grid;place-items:center;text-align:center;
    padding:16px;background:#17150f;color:#a49b8b;font-size:12px}}
  .blurb{{color:#3a3631;margin:0 0 22px}}
  .facts{{font:600 10px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.14em;
    text-transform:uppercase;color:#7c756a;border-top:1px solid #ded8ca;
    border-bottom:1px solid #ded8ca;padding:12px 0;margin:0 0 24px}}
  .ed-btn{{display:inline-block;margin:0 8px 8px 0;padding:9px 15px;border:1px solid #191714;
    border-radius:3px;color:#191714;text-decoration:none;
    font:600 10.5px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase}}
  .ed-btn:hover{{background:#191714;color:#f7f4ec}}
  .note{{font-size:14px;color:#6f6961;margin-top:18px}}
  .back{{margin-top:34px;font-size:13.5px}}
  .back a{{color:#a8332c}}
  .dl-note{{border:1px solid #ded8ca;background:#fff;padding:16px 18px;margin:0 0 20px;
    font:14px/1.55 ui-sans-serif,system-ui,sans-serif;color:#4a453f}}
  .dl-note b{{display:block;font-size:11px;letter-spacing:.14em;text-transform:uppercase;
    color:#a8332c;margin-bottom:6px}}
  @media (max-width:620px){{.cols{{grid-template-columns:1fr}}.ed-cover{{max-width:220px}}}}
  body{{padding-bottom:96px}}
  {SHARE_CSS}
</style></head>
<body><div class="wrap">
  <div class="kind">{esc(KIND_LABEL[w['kind']])} · {esc(w['status'])}</div>
  <div class="cols">
    {cover}
    <div>
      <h1>{esc(w['title'])}</h1>
      <p class="sub">{esc(w['subtitle'])}</p>
      <p class="blurb">{esc(w['blurb'])}</p>
      <p class="facts">{facts(w)}</p>
      <div class="dl-note"><b>Reading edition</b>
      The file downloads on its own if you arrived here from the work's page. If it did
      not start, pick a format above — this page stays open so you can choose again.</div>
      {buttons}
      <p class="note">This edition is published as a PDF. Pick a format above and the file
      downloads; this page stays open so you can choose again.</p>
      {share_bar(f"{SITE}/works/{w['id']}.html", f"{w['title']} — {AUTHOR}")}
    </div>
  </div>
  <p class="back"><a href="../works/{w['id']}.html">Back to the work</a> ·
  <a href="../">All books and papers</a></p>
</div>
{float_contact("../")}
{READ_SCRIPT}
</body></html>
""", encoding="utf-8")
    return f"read/{w['id']}.html"


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
            {k: v for k, v in w.items() if k not in ("featured", "read")} for w in WORKS
        ],
    }
    (site / "catalogue.json").write_text(json.dumps(cat, indent=2, ensure_ascii=False) + "\n",
                                         encoding="utf-8")

    # the page behind every card, built from the same catalogue
    works = subprocess.run([sys.executable, str(Path(__file__).with_name("make_work_pages.py"))],
                           capture_output=True, text=True)
    if works.returncode != 0:
        raise SystemExit("work pages failed:\n" + works.stderr)
    print(works.stdout.strip().splitlines()[-1])

    check = subprocess.run([sys.executable, str(Path(__file__).with_name("check_portfolio.py"))],
                           capture_output=True, text=True)
    print(check.stdout.strip())
    if check.returncode != 0:
        raise SystemExit("refusing to finish: the portfolio would publish private material")

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
