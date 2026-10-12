# Pointers taken from the COREMERCH bots

Source material: `COREMERCH CONTENT BOT V6.0` (387 KB Apps Script, publishes to GitHub
Pages), `COREMERCH WEEKLY DIGEST MAILER V1.0`, `OPENRAIL SOVEREIGN INFRASTRUCTURE`
(NOWPayments engine). Read 2026-10-12, on the user's instruction: *"take pointers from
my google bots."*

Every line is one of three things: **taken** (now in this repo, with the file that holds
it), **already had** (we do it, and their version is compared where it differs), or
**refused** (with the reason, so the refusal can be argued with rather than re-litigated).

## The content bot's numbered changelog, line by line

| Tag | Their feature | Here | Where / why |
|---|---|---|---|
| PLR-1/2/3 | pillar post per category, clusters link back, pillar gets the long treatment | **taken** (shape, not automation) | `core.js: GUIDES` — one pillar (`whatsapp-shop-payments`) and a cluster (`payment-reference-matching`) that links back, both listed in one array so the route, the sitemap and the footer cannot disagree. Written by hand, not generated: the product's whole argument is that a merchant should not have to write, and our copy is our job. |
| KWD-1/2 | keyword density 0.8–1.8%, logged per post | **refused** | A menu is data. Padding a page to a ratio is how a small site earns a thin-content tag, and the number is a proxy for a thing we can check directly (does the H1 and the first sentence name the thing?). |
| SQV-1/2/3 | section quality validator, uniqueness ≥ 0.4, headings must carry the keyword | **taken as a check, not a prompt** | `tests/pages.test.mjs`: every guide is asserted to have one `<h1>`, ≥ 3 `<h2>`, a description of substance, > 400 words, a dated claim, and a link to a sibling. Their instinct — a machine rejects a thin page — is right; running it on generated text instead of shipped text is how junk gets produced at volume. |
| DUP-1/2 | sentence-level dedupe via hashes in ScriptProperties, LRU eviction at 500 | **refused** | A bounded memory means the 501st item can be republished: for us the same shape (a small set of "already seen" keys) is how a double credit happens. `paid:<provider id>` with a 30-day TTL cannot be evicted into a duplicate. |
| HDG-1/2 | heading hierarchy, primary keyword in H1 | **taken** | Same rule in the guide test above, and the storefront's own `<h1>` is the shop name. |
| ANC-1/2 | anchor-text diversity across 4 types, logged to a LinkGraph sheet | **partly taken** | Guides vary their anchors by hand. Not taken: an anchor *ledger*, which is an optimisation for a site with hundreds of pages; ours has three. |
| ORP-1/2 | orphan detection, orphans prioritised for internal links | **taken, and made impossible** | `deploy.sh` derives the publish list from `pages/guide-*.html`, `GUIDES` drives routes + sitemap, and the parity test fails if a file is not in the list or a list entry has no file. Their bot *detects* orphans weekly; ours cannot exist, because the directory is the list. |
| RLF-1/2 | daily quota forecasting, providers above 80% filtered from the cascade | **already had** | Same shape as the KV budget: `/__selftest` answers `kv_write_blocked` with `retry_in_sec`, a refused write is a first-class answer (`ckw` in `prod_check.sh`), and a budget-blocked deploy is a *green* nightly rather than a red one. |
| XPS-1/2 | cross-post generator: forum, X, LinkedIn, hook, 3-bullet formats | **taken, for a shop instead of an article** | `core.js: shareCopy` → `GET /s/<handle>/share.txt`, linked from the storefront's own header. Length rules per destination (X counts characters and truncates your link if you do not), a bulleted block with no hollow bullets, and one format — Instagram — that must *not* carry the URL, which the test says out loud. |
| IMG-1 | real PNG byte enforcement on all images | **already had, now also for previews** | `sniffImage` on upload and re-sniffed on serve; `og:image` is only emitted when a file is actually in KV, and the live proof fetched the URL a preview bot would fetch (200, image/png) and then confirmed 404 after the merchant took the picture off. |
| SEO-1 | slug system | **taken** | `/guide/<slug>`, `[a-z0-9][a-z0-9-]{3,46}`, resolved against `GUIDES` — an unknown slug is a 404 that names what exists, not a soft 200. |
| SEO-2 | canonical, JSON-LD, OG, Twitter card | **taken** | 0.7.1: `seoFacts` / `seoHead` / `seoJsonLdTag`, per store, server-rendered, canonical stamped with the host that answered. |
| SEO-3 | sitemap + RSS regenerated on every publish | **taken (sitemap), refused (RSS)** | `/sitemap.xml` from the Worker. A shop has nothing to subscribe to; a *feed of every store* is the enumeration we refuse on purpose. |
| SEO-4 | IndexNow + Google + Bing ping on every publish | **refused, on the record** | IndexNow needs a key file at the root, which we could self-serve in ten lines — and it is the same enumeration as a tenant sitemap, sent to a search engine instead of the public. `google.com/ping?sitemap=` is documented by Google as unnecessary; worth deleting from their bot. If the user ever wants a directory page, this line gets revisited *with* it. |
| CTN-1 | FAQ section in every post with JSON-LD | **refused** | Google demoted FAQ rich results for non-authoritative sites in 2023. Copying it now is ceremony with a schema.org dependency attached. |
| CTN-2 | internal link injection with anchor diversity | **taken (links), refused (injection)** | The guides and the marketing pages link each other explicitly. Injecting links at publish time is a thing you do when you cannot read your own output; we can, and there is a test. |
| OPS-1 | provider performance scoring + dynamic cascade | **not applicable, and noted** | We call one KV store and one Google sheet. If a second LLM or provider ever enters the picture for merchant-facing text, this is the pattern to copy — including the 80% filter. |
| OPS-2 | weekly content refresh engine | **taken as the next release** | Applied to shops as a *page-readiness* nudge (no picture means no preview, no hours means no "open now"), because a thin store page is the same failure as a thin post, and here the merchant can fix it in one screen. |
| OPS-3 | dead image detector | **already had** | 0.6.9: the save that drops a picture frees it, without waiting for an eventually-consistent listing. |
| OPS-4 | category rotation + topic saturation detection | **not applicable** | A shop is not a content calendar. |
| OPS-5 | phase budget management | **already had** | The KV write budget governs the whole pipeline: template gate, per-key write counting in the live suite, and a check that says "needs a KV write" instead of failing on a capped day. |

## The mailer and the payment engine

| Their feature | Here |
|---|---|
| Digest selects 5 posts *not previously included* | **already had** in the money path: `paid:<id>` (30 d), `tx:<ref>` spent on use, one undo window per order. A "was this already handled" ledger is the same object. |
| Daily send limit (80 of 100) with `capacityLeft()`, jittered `throttleSleep()`, batch delays | **taken as the governing rule**: never plan to the published ceiling of a free tier. Ours is the KV write budget and it is why a refusal is designed to cost nothing. The jitter is a good idea we do not need yet, because we send no bulk mail. |
| Subject prefix + issue number, unsubscribe link in the footer | Noted for later: if merchants ever get a weekly summary, both are cheap and both are legally load-bearing in some jurisdictions. |
| `PENDING_SUBJECT` / in-progress markers, `clearStaleInProgress()` | **refused, with a reason**: their sweep needs a resume marker because a *send* is half-done at the point of failure. Ours is one atomic KV write per store, so a killed cron leaves nothing half-applied; the next run is the retry. Taking the marker would be adding state to be wrong about. |
| OpenRail: five guards — re-deposit, idempotency, API re-verification, amount, asset | **already had as of 0.7.0** — signature, `paid:<id>`, minted intent, amount+currency, and the `verify` fetch-back. Their ordering (cheapest, most-forgeable check last) is what `hookPayfast` now does too: check the signature before the ledger. |
| OpenRail: `PAYMENT_WINDOW` 15 min on the invoice | **already had, one choice different**: `TX_WINDOW_SEC = 1800`. Half an hour because a buyer on a prepaid handset in a load-shedding blackout needs the second try, and the price is held, not extended, so nothing drifts. |
| OpenRail: 1% tolerance on stablecoins, 2% on volatile, under-payment flagged not refused | **taken as a policy for a future rail, not now**: an exact-cent match is correct for a fixed plan price and wrong for anything that moves through a chain. Also note the shared instinct with the order flow — *flag, never block* — which is how proof-of-payment was designed. |
| OpenRail: daily underpayment report | **taken as the reconciliation idea**: the hour ledger (`hooks:<YYYYMMDDHH>:<outcome>`) in `/ops/api/health` is the first version of "what did the money doors get asked for, and what did they do". Their Discord alert is right about visibility and silent about cost: a refusal is the one event a stranger can generate at will, and we have 1,000 writes a day in total. |
| OpenRail: PDF deployment report, 13 static wallets in a config block | Not applicable / anti-pattern. Wallets and any credential in a source file is exactly what their three uploads do with a GitHub PAT, a NOWPayments API key, an IPN secret and a Discord webhook — see below. |

## The one pointer that is not about SEO

The content bot is a *machine that never asks permission*: cron, quotas, retries,
self-healing, an LRU, a link graph. The product's acceptance criteria say the same thing
about a merchant's day. Where their automation drifts, though, is instructive: it has
live credentials in the source file, a ping that does nothing, and a memory that forgets
after 500 items. Rigour about the boring parts — what is authorised, what is bounded,
what is provable — is the part worth taking wholesale.
