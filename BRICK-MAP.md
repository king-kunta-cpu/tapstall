# TapStall mapped to the master blueprint — v1.0.0

The reference is the household's master commercialization blueprint (Bricks 0–14), written from the
STPi/hunta stack. TapStall is a different product with the same physics: no servers, no per-instance
hosting, graph-shaped distribution, humans only where judgement pays. This file says, brick by brick,
what v1.0.0 implements, what deliberately differs, and what is still owed — so the next agent does not
have to reverse-engineer intent from code.

Three people, three words, used exactly this way everywhere: **owner** (owns the platform),
**sellers** (the owner's own people who sell TapStall subscriptions), **operators** (sell through
TapStall shops; older code calls them "merchants" — same person, word retired going forward).

## Brick 0 — brain vs exoskeleton

Kept. The Worker is product *and* commercialization in one deployable, but the seam exists in code:
`worker/core.js` is the pure brain (all decisions, no I/O, fully tested), `worker/worker.js` is the
shell (routes, KV, fetches). Anything that judges money, press or leads lives in the brain; the shell
only fetches facts and writes conclusions. That is why every v1.0.0 feature landed as core functions
first (`cleanLead`, `leadTransition`, `sellerBoard`, `meshDirectSend`).

## Brick 1 — repo topology

Differs, deliberately. One repo, not four: TapStall is one product on one free tier, and splitting
`product / owners / hunter / contentops` would quadruple CI ceremony for no isolation gain at this
scale. The hunter is `scripts/lead_hunt.py` + `.github/workflows/leads-hunt.yml`; content ops is the
press module in the Worker; the Sheets satellite is `leads/apps-script/Code.gs`. If a second product
ever shares this exoskeleton, split then — the file boundaries already say where the cuts are.

## Brick 2 — one clock, dispatching

Implemented in v1.0.0, and it was the critical fix. The Worker's cron (`15 6,12,18,0 * * *` UTC,
`tapstall` worker only) is the single authoritative clock. Inside it, `runCron` runs named slots,
each isolated so one failure cannot take the term sweep down with it:

- **press window** (`pressTick`, every slot, claimed once per hour via `press:last`): composes and
  sends under standing policy. Before v1.0.0 this needed a human POST; queues composed 2026-10-14
  sat unsent for five days proving it.
- **outreach dispatch** (`dispatchTick`, weekday mornings): repository-dispatches the Actions lead
  hunt when `GH_DISPATCH_TOKEN` is configured — the Worker decides *when*, Actions does the fetching.
- **nightly exception digest** (`writeDigest`, 00 slot): writes `digest:last` — counts plus a
  `needs_a_person` list (payment references awaiting recognition, shops expiring ≤14 days, overdue
  unsent press, lead follow-ups due). That list is the owner's entire recurring job description.
- **term sweep + Tron watcher**: as before, unchanged.

GitHub schedules were removed from `deploy.yml` (they redeployed identical code daily while the
check job skipped itself). Two honest exceptions, both documented in their files: `monitor.yml`
(weekly external witness — a dead Worker cannot report its own death) and `prod_check.sh`, now run
against the sandbox store `logintest` with KV namespace ids resolved **by title** at runtime.

**The autonomy rule, because it was violated in prose and plumbing alike:** nobody approves batches.
Registration is policy — a seller presses the moment they are registered; the owner account presses
by default. Standing policy, per-channel medians, daily caps, provenance, and the kill switch
(revoke the grant or the credential) are controls that hold at 3 a.m. What is left to people:
replies, complaints and refunds, credential grants, payout changes — and recognising a payment
reference, which is a judgement **about money**, not an approval of machine output.

## Brick 3 — edge control plane

One codebase, one `tapstall` Worker, shared KV, no D1. D1 was not
adopted: the current Cloudflare token has no D1 scope, KV already fits the write budget, and the
1,000-write/day free cap is the architecture's known governor — every v1.0.0 feature was designed
under it (seller clicks buffer in-isolate and flush every 10th; boards and digests are derived at
read time, never recomputed into storage; the press slot claim shares the run's own write).

## Brick 4 — browser-sealed operator credentials

Not built; nothing is stored insecurely instead. v1.0.0 went the other way: **no credential is
stored in KV at all.** A Buffer token pasted into the press registry is refused (400) and any stored
one is deleted on the next write; direct-rail credentials (Bluesky app password, Telegram bot token)
are assembled from Worker env secrets only, per identity (`PRESS_<TAG>_…`, see `directCredsFor`).
Sealed per-operator credentials (RSA-OAEP + AES-GCM in the browser) remain on the roadmap for the
day operator-owned sending is wanted; until then operator-owned sending means the platform composes
and the operator's own accounts are never touched — assist surfaces get copy, API rails get nothing.

## Brick 5 — customer-owned sending, identity in the ledger

Partial, by design. The press ledger records `identity`, `channel`, `provider` (`buffer`,
`bluesky-direct`, `telegram-direct`) and `verified` per send. Owner and seller identities send from
platform-controlled accounts today (Buffer or direct rails). Operator-owned identities are never
posted to; operators get the platform's nodes. When Brick 4 lands, `provider` is where
`customer-owned` will appear, and the ledger already distinguishes it.

## Brick 6 — subscriptions + commission

v1.1.0 makes Whop the card rail (the owner's standing collection route) *and* keeps sellers:
$60/year annual + $7/month monthly (`SUBSCRIPTION_PLANS`; the pricing case is `docs/PRICING.md`),
60 free days, 30% default commission. The renew checkout carries the attributed seller's Whop
`?a=<username>` so Whop settles their 30% directly; the ledger records `commission_via` and the
board splits `commission_whop` (Whop pays it) from `commission_due` (owner still owes it —
manual-rail sales), so nobody is paid twice.
Attribution is judged at birth: `/r/<code>` (or `?ref=` / `?a=`) sticks only if the code names a
registered, active seller — an invented code manufactures nothing. Sales rows (`sale:…`) are written
by both payment webhooks and by manual recognition (`recognise_ref`), and `sellerBoard` reconciles
clicks → shops → trials → paying → revenue → commission → leads from documents at read time, with a
house row so direct sales are visible. Seller keys hash at rest and are shown exactly once.
Automated activation is `POST /api/hook/whop` (setup: `docs/WHOP-SETUP.md`): Standard Webhooks
HMAC verified the mint's way, fail-closed 503 until `WHOP_WEBHOOK_SECRET` exists, events routed in
the core (failed/invalid/refund never grant), shop matched by checkout handle → membership →
email, unmatched filed to the digest, idempotent on webhook + payment ids with the 3-day companion
rule. The Flutterwave/PayFast doors remain as unarmed fallbacks (503), and the recognised-reference
path remains the manual money rail (bank/EcoCash/Mukuru/ZIPIT/USDT).

## Brick 7 — storefront

`pages/index.html` (the authored landing) propagates a seller code from hash, query or
`sessionStorage` into the onboarding and fees links, and `/g/<code>` lands there too. The Whop
storefront is the card checkout (product + covers from `brand/`); the shop itself remains the
storefront for trading.

## Brick 8 — landing pages + brand

Pages are bundle constants (inlined at build; deploy fails if any is missing). `ui_kit.py`
regenerates `/pages` from `pages/src` and the test suite enforces they match byte-for-byte.
Brand: the ops console is titled "owner", matching the role words; v1.1.0 adds the brand system
in `brand/` (stall-and-tap mark, lockups, Whop cover, avatar, palette extending the UI kit's
green/chrome), wired into the landing page as inline SVG + favicon so the single-file rule holds.

## Brick 9 — onboarding + guides

Operators self-onboard (unchanged). Sellers: `scripts/seller_add.sh` or the owner console's sellers
API; the key and links print once. Guides: `docs/SELLER-GUIDE.md` and `docs/OPERATOR-GUIDE.md`
(action-oriented; sellers get links, the key, the pitch order, the 5-touch week and the Sheets
surface; operators get the 7-step first week). The wet-ink contract remains the house practice —
paper is not code's problem.

## Brick 10 — lead hunter

Implemented. `scripts/lead_hunt.py` (stdlib only) hunts Bing RSS and DuckDuckGo for WhatsApp
sellers by segment, pulls OSM Overpass dossiers (every query `out center;`), and enriches from each
prospect's own page — facts only. The **2-signal rule** is judged by the Worker at ingest from five
derived signals (phone, email, source URL, WhatsApp-selling language, payment-friction language);
under two signals a lead parks in `research_hold` and a later fact promotes it on merge.
**Allocation** is deterministic FNV over the dedupe key across active sellers, owner if none — so
every hunt of the same business lands on the same desk. `leads-hunt.yml` runs it; the Worker may
dispatch it weekday mornings. It sends nothing to anyone.

## Brick 11 — outreach sending

Implemented in v1.1.0 the STPi way — **seller-owned Gmail by default**: `scripts/mail_outreach.py`
(stdlib SMTP/IMAP, run by `outreach.yml`, dispatched by the Worker's weekday slot alongside the
hunt) sends only to Worker-eligible leads (queued = 2+ signals, or a follow-up due under the
3-touch cap), from the allocated seller's own mailbox connected by Gmail **app password**, and files
every outcome back through `/api/leads/act` acting *as that seller*. App passwords live as Worker
secrets `GMAIL_<TAG>_*` and reach the runner only through the admin-gated
`GET /api/outreach/mailboxes` (the mint's /hook/settings shape); no `EMAIL` binding and no custom
domain are involved. Replies are polled over IMAP: STOP → the DNC ledger, any human answer →
`replied` and the machine stops. WhatsApp-only leads are counted, never auto-messaged — they wait
for the seller's own tap, because cold WhatsApp sending from shared numbers is how numbers die.

## Brick 12 — anti-spam engagement engine

The parts that matter without inboxes are in: **anti-collision locks** (`leadTransition` — a second
seller's claim gets a loud 409, tested end-to-end), stage taxonomy (`queued → claimed → contacted →
replied → trial → closed`, plus `research_hold`, `paused`, `dnc`), follow-up scheduling
(`next_follow_at`, surfaced in the digest when due), and a **do-not-contact ledger** (`Lead:<email>`
/ `Lead:<phone>` markers consulted before anything is stored, so a re-hunt cannot resurrect an
opt-out — POPIA §69 honoured in structure, not in a memo). The 6-class LLM inbox automation waits
on the EMAIL binding (Brick 11); when it lands it writes the same transitions through the same door.

## Brick 13 — Google Sheets command bot

Implemented for free, the other way round: instead of a service account pushing into sheets, the
Worker serves a per-seller TSV/JSON feed (`/api/leads/sheets-feed`) and `leads/apps-script/Code.gs`
pulls it. Six tabs (`DASHBOARD`, `Leads`, `NEW_CONTACTS`, `DELETIONS`, `REGISTER_SELLER`,
`SEND_SCHEDULE`); the sheet proposes actions in a DO column and the Worker judges them — the
spreadsheet is a control surface, never an authority. Owner-gated doors (ingest, seller
registration) stay owner-gated from the sheet too.

## Brick 14 — press autopilot

The press module itself predates v1.0.0 (registry, medians, provenance, budget guard, ledger) and
was already the best-built part of the codebase — except nothing ran it unattended. v1.0.0: the
cron runs every window; Buffer remains the primary rail; **direct rails** (Bluesky, Telegram) now
send from the Worker with env-sealed credentials instead of queueing forever behind a
"direct rail — queued, unsent" note; an unbound direct rail stays queued and the error names the
missing secret. "3 Buffer accounts" maps to the owner identity plus per-seller identities
(`seller:<code>`, each with its own env-named Buffer token). Narrated video is not built — no TTS or
render budget exists on free tiers here yet; the beats already carry everything a renderer would
need, in `mesh.json`.

## What is still owed (none of it is code-shaped)

1. Press credentials: `PRESS_BUFFER_TOKEN` (owner) and/or direct-rail secrets (`PRESS_BLUESKY_*`,
   `PRESS_TELEGRAM_BOT_TOKEN`, per-identity `PRESS_<TAG>_…`), plus a token env per seller identity
   that will press through Buffer. Until then: compose + queue + honest errors, nothing published.
2. Payment webhook secrets (`FW_SECRET`, `FLW_API_KEY`, `PAYFAST_PASSPHRASE`, `TRONGRID_KEY`) —
   the doors stay shut (503) until armed; `recognise_ref` is the interim money rail.
3. `GH_DISPATCH_TOKEN` + `GH_REPO` Worker secrets if the weekday hunt should self-dispatch;
   `ADMIN_SECRET` as an Actions secret for the workflow runs.
4. A domain, for the `EMAIL` binding (Brick 11/12) and for seller links that are not `workers.dev`.
   Set `PUBLIC_ORIGIN` when it lands; the cron's press windows use it automatically.
5. Parked by the owner's instruction, listed so they are not lost: credential rotation, and the
   single-root admin secret rework (audit Risks 1 & 2).
