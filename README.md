# Tapstall — a WhatsApp order desk for markets a global platform will not serve

Merchants on WhatsApp lose money in the last five minutes before the money
moves: buyers send screenshots instead of payments, mobile-money rails cost
3–5% and nobody passes that on, and a spreadsheet of "pending" orders is the
only ledger. Tapstall gives each merchant a real storefront link that runs
itself. The whole stack is on free tiers, and **no operator touches it** —
sign-up, provisioning, menu updates, payment confirmation and renewal are all
self-serve.

Zimbabwe and South Africa are where the payment tariffs are verified, because
that is where the incumbent refuses to work. The product is not limited to
those two: a payment method or a country we have not priced is a config entry,
not a release. See *Markets are data, not code*.

**Live:** `https://tapstall.simalidudu.workers.dev/onboard`
(storefront `…/s/<handle>` and every link minted before the rename still work: the
previous hostname `zimlink.simalidudu.workers.dev` is deployed as an alias and
answers with a redirect for page visits)
Storefront `…/s/<handle>` · dashboard `…/a` · rate calculator `…/fees`

---

## Why this is $0 and stays $0

| Piece | Cost | Why it is enough |
|---|---|---|
| Cloudflare Worker | free tier, 100k req/day | one Worker serves every tenant; tenancy is a KV key, not a deploy |
| 2× KV namespaces | free tier | `store:{handle}`, `order:{h}:{id}`, templates `tpl:*` |
| Cron trigger | free | term expiry, reinstatement, renewal notices |
| `*.workers.dev` route | free | no domain to buy, no SSL to manage |
| Merchant's Google Sheet | free | the menu *is* the database; the merchant edits it, we re-read it |
| GitHub Actions + Pages | free | CI/CD and the public landing/fees mirror |
| Flutterwave hosted link | 0 monthly | only paid when a merchant renews; a fallback path works without it |

A new merchant is one KV write. There is no per-customer deploy, no approval
queue, no invoice to send.

The one number that bounds it: **1,000 KV writes/day for the whole account**
(reads are 100,000/day). An order costs about four writes, so the free tier is
~150–200 orders a day across all tenants before anything needs paying for —
measured the hard way on 2026-10-10, and the reason every path that can avoid a
write now does (a deploy with unchanged HTML writes nothing; log writes are
best-effort; a quota answers 503 with a retry time instead of a 500).

## The two things the incumbent cannot do here

1. **A payment you can identify by its amount.** Every order is collected at
   `total + unique cents` (a deterministic 0–0.96 spread). One amount matches
   one order, so a "proof of payment" screenshot stops being evidence anyone
   needs to look at — which is the scam vector in a market where the platform
   tells you to reconcile transfers yourself.
2. **Know what a rail actually costs.** `worker/core.js` holds the per-rail
   math — EcoCash USD 1.4% + 2% IMTT, ZiG 2.0% + 1.5%, PayShap 0.5%, PayFast
   2.9% + R1 — and a merchant picks `absorb` (we report the cost they eat) or
   `pass` (the buyer pays it). Zimbabwe has no "automatic" rails at all, so
   pass-through surcharging is not a toggle there; it has to be computed.

## Layout

```
worker/core.js        price + menu parsing, the single source of truth (unit-tested)
worker/worker.js      the Worker: routes, KV, cron, webhooks
pages/kit.css         the one design language both suites are drawn from
pages/src/*.html      authored pages (onboard, admin, confirm, renew, ops)
pages/*.html          the shipped ones: storefront, onboarding, dashboard, fees, landing
pages/public/         what GitHub Pages uploads: _headers, the sample CSV, and
                      onboard{.html,/index.html} — a handoff, because Pages has no
                      rewrite engine and the builder needs the Worker's API.
                      index.html/fees.html are copied in by CI from pages/, never
                      committed here (two consumers, one source)
scripts/ui_kit.py     inlines kit.css into every page; `check` is the drift gate
tests/core.test.mjs   28 unit tests on the money and the parser
tests/live.test.mjs   34 tests that run the real handler + cron against a stub KV
tests/pages.test.mjs  14 tests on the shipped HTML itself (no browser needed)
scripts/deploy.sh     one command: tests → KV → templates → bundle → deploy → triggers → self-check
scripts/build_bundle.sh   inlines core.js into .build/worker.js, ESM syntax check
scripts/cf_publish.py     dependency-free publisher (fallback when wrangler is absent)
scripts/set_triggers.py   verifies the schedule/route over HTTP rather than trusting a write
```

## Deploying (or re-deploying) it

```bash
npm ci                    # installs wrangler, the only dependency
export CF_TOKEN=… CF_ACCOUNT=…     # or put them in .secrets/
./scripts/deploy.sh                 # the whole thing, including a live self-check
./scripts/deploy.sh --check         # tests + build, uploads nothing
./scripts/deploy.sh --push          # also creates/updates the GitHub repo + Pages
```

Everything after that is automatic: `main` pushes run
`.github/workflows/deploy.yml` (tests → Worker → Pages). For that to be
zero-touch, set three repository secrets — `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `ADMIN_SECRET` (a long random hex; it salts buyer
fingerprints and renewal tokens, so it must not rotate on every deploy).

To fix a page without any deploy at all:

```bash
curl -X PUT --data-binary @pages/store.html \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/storage/kv/namespaces/$NS/values/tpl:store" \
  -H "Authorization: Bearer $CF_TOKEN"
```

## The merchant journey, end to end

1. `POST /api/register` (from `/onboard`): handle, WhatsApp, market, currency,
   rail, tax, delivery fee, Google-Sheet link → store is live on return, and
   the response says how many products parsed, so a bad sheet is visible at
   once instead of silently empty.
2. Buyer opens `/s/<handle>`, picks options/add-ons, sees the exact amount to
   send, the rail's dial string and the reference. `POST /api/order` → code,
   `pay_now`, instructions, `wa_link`, and a `mark_url` for the merchant.
3. Merchant taps the confirm link in the notification (`/c/<capability>`) →
   the page shows buyer, amount and rail, then *the browser* POSTs it. No app,
   no key, no login — and no way for a link-scanner to pull the trigger.
4. Menu changes are the merchant's own sheet edit; `feed_cache` re-reads after
   `cache_seconds` (default 120). No one re-deploys anything.
5. Free for 60 days, then the cron warns at T-7d, and suspends at expiry (order
   endpoint answers 503 with a reason). `/renew/<token>` → `/api/checkout` →
   payment → the webhook extends `paid_until` and the next cron tick
   reinstates. Nobody sends an invoice.
6. `…/a` is the whole ledger: status, flags, buyer, amounts, plus the settings
   panel and the change log. The dashboard opens from a code that becomes a
   12-hour `HttpOnly` cookie; the ledger endpoint answers 401 to anyone else.
   The merchant renders a day-sheet and a CSV from the same payload.
7. A payout detail is wrong (typo'd EcoCash number, new sheet link, closed for
   a day): the merchant fixes it themselves in Store settings. Cosmetic fields
   land instantly; fields that move money or buyer data queue for 15 minutes,
   are cancellable inside that window, and every confirmation reply carries a
   15-minute undo link.

## Markets are data, not code

The one thing that made this a Zimbabwe-shaped product was a table of payment
methods in the source. It still exists (`RAILS` in `worker/core.js`, nine
verified ZW/SA tariffs) but it is now a **default, not the whole answer**:

- `GET /rails` is public and returns built-ins ⊕ whatever the operator has
  published in KV (`rails:extra`), plus a `custom` entry. Storefront, onboarding
  and the dashboard all build their pickers from it, so a new method is live for
  the next buyer within the 60-second cache and no page is redeployed.
- **Operator:** Ops console → *Templates* → *Markets & rails* (`POST
  /ops/api/rails`, same session and same `x-tapstall-confirm: 1` click as every
  other lever). A rail is `{label, dial, pct, imtt, fixed, type}`; label must be
  ≥ 2 characters, `pct`/`imtt` are clamped to 0–30% and `fixed` to ≤ 1000 so a
  fat-fingered percentage cannot quote a 300% surcharge. Keys that already exist
  in the built-in table are **refused** — verified tariffs change in `core.js`
  when a published rate moves, not in a text box. Removing a rail, or restoring
  the built-in table, is refused while any store still uses it, and the answer
  names the shops, because silently repricing a live merchant as cash is the one
  edit that would cost them money.
- **Merchant:** pick `My own method (I describe it)` and type the label, the dial
  string and the rate — in onboarding and in the dashboard. `rail_def` is a
  money-class field, so it waits out the same 15-minute reversible hold as the
  payment account, and it is public by design: it is what the buyer is shown.
- Pricing is arithmetic on whatever rail resolves
  (`fee = subtotal × (pct + imtt) + fixed`, zero for cash-on-delivery), the
  worker snapshots it into `order.pay`, and `/s/<handle>/config.json` hands the
  storefront the resolved rail as `rail_info` so the cart preview and the receipt
  cannot disagree. A rail removed later cannot change a slip already sent.

An invalid description at sign-up becomes `cash` rather than a rejected
registration: a merchant who never opens the shop is worse than one whose slip
says "pay on collection" until they fix it.

## The two suites

Both are plain HTML files with the kit inlined and their own inline script. No
framework, no build, no CDN — a page has to survive a 2G reconnect, a WhatsApp
in-app browser, a sandboxed link preview and a KV read, and 6 KB gzipped does
that. The Worker serves them out of KV (`tpl:*`), so re-skinning a screen is one
`PUT` instead of a deploy.

**Merchant side** — `/onboard` (4 steps, validated field by field, showing the
odd-cents and surcharge arithmetic on a live buyer card *before* the merchant
commits to it) · `/s/<handle>` (the buyer's storefront) · `/c/<capability>` (the
one-tap confirm page) · `/renew/<token>` (plan, price, pay-by-EcoCash reference
box) · `…/a` (the dashboard: Orders · Menu · Store settings · Plan · Share ·
Log & security).

**Operator side** — `/ops`, same origin, same Worker, cookie session. One screen
per job: KPI strip and attention queue (nothing is blocked, here is what wants a
look); a searchable tenant table with a per-tenant drawer carrying every lever
(+7d, +30d, grant a year, reset to free, pause, reinstate, clear a queued
settings change, clear filed references, issue a dashboard link, revoke every
link and key); the template editor, which publishes to KV at once and restores
from `git main` in one press; the health panel (the Worker's own self-test, the
cron heartbeat, the Pages mirror, the last CI line); and a change log that shows
merchant writes masked next to operator writes attributed.

Three rules hold it together, and each is tested:

* **Nothing on either suite is required for a customer to be onboarded, to order,
  or to be paid.** The console is oversight. A merchant's own recovery path
  ("Lost your link?") never routes through the operator, which is what keeps the
  no-participation rule true.
* **Every lever needs a second click.** `POST /ops/api/*` mutations refuse
  without `x-tapstall-confirm: 1`, which a stray `<img>` cannot send, and each one
  writes both the operator log and the store's own log — so "was that us?" has an
  answer in the merchant's dashboard.
* **A sign-in is a cookie, never a URL.** `/ops/login` exchanges the platform
  secret for a 12-hour `HttpOnly SameSite=Strict` session cap; signing out bumps a
  generation number in KV, which ends every console session on the platform,
  because a stateless cap would otherwise stay valid until it expired. Rotating
  `ADMIN_SECRET` still kills them instantly.

The confirm page is the friction compromise: a GET on `/c/…` renders an inert
document and *the browser* POSTs it once, only if the tab is actually visible
(`document.hidden` is false), so link-preview bots and headless fetches cannot
pull the trigger, and the merchant still taps exactly one thing.

`tests/pages.test.mjs` exists because nothing else looks at these files: no
bundler, no linter, and a typo in an element id only appears as a blank panel on
a merchant's phone. It compiles each page's script, proves every `#id` the script
reaches for is defined, proves every endpoint a page calls is a route the Worker
serves, and proves every console button names an action the Worker implements. It
caught four real bugs on its first run — a `await hash(x).slice()` precedence
mistake that 500-ed the Templates panel, `notify`/`link` falling through the lever
dispatch to `unknown action` (dead buttons), a lost `<div id="list">` (the orders
list would not have rendered at all), and a duplicate `id="tabs"` that hung the
tab bar's handler off a Show/Hide button.

## Merchant authority (why a shared link cannot burn the shop down)

Everything the merchant does is authorised by a **stateless HMAC capability**,
`v1.<expiry>.<payload>.<signature>`, signed with the `ADMIN_SECRET` and bound to
`{action, store, order, target status, auth_gen}`. Nothing about it is stored,
so nothing is searchable, and one KV write (`auth_gen`) invalidates every link,
key and cookie a store has ever issued.

| Surface | Before | Now |
|---|---|---|
| Dashboard | `?handle=x&token=<40-bit key>` in every URL, in logs, in the merchant's own notification text | one-time code → `HttpOnly SameSite=Strict` cookie (12 h) |
| Confirm an order | `GET /api/mark?token=…` — a prefetching bot could mark it paid | `GET /c/<cap>` renders an inert page that POSTs; `GET /api/mark` → 405 |
| Lifetime of a link | forever | 72 h confirm · 15 min undo · 7 d login code |
| Read a store's dashboard link from a handle | `/api/lookup` handed it out | `/api/lookup` returns public health only |
| Payout details | no self-serve path at all (`409 handle already taken`) | `POST /api/settings`, 15-minute hold on money fields, masked audit, self-serve "lost your link" |
| Cross-origin | `Access-Control-Allow-Origin: *` on every response | `*` on buyer/public paths only; admin/mutation paths send none |

Two rules hold the design together: **a GET can only ever return a page, never
move money**, and **the buyer's slip is frozen at order time** (`order.pay`), so
a payout account that does change can never retroactively redirect money a
buyer was already told to send.

The friction budget was spent deliberately: one tap for the merchant, exactly as
before. A stolen or shared link still cannot take the ledger or reroute today's
takings, because the state it would need is behind a 15-minute hold the owner can
see and cancel, and because revoking takes one press.

## What is deliberately not here

* **A password.** The store's `admin_token` is an API key for the merchant's own
  tooling (`x-tapstall-admin`), not something a human types. Losing a device is
  answered by sign-out and `POST /api/revoke`; losing the link is answered by
  knowledge recovery (`owner_email` *or* the store's WhatsApp, plus the payout
  account, or the sheet link for a cash shop) — 12 tries per 10 minutes per
  store, so the answer space is not searchable. There is no second factor, and
  no support queue either, which is the point of a $0 product.
* **A live order feed.** KV is eventually consistent: a new order appears in the
  dashboard list within about a minute, while the confirm link in the
  notification works the second it is sent. The ledger list and the order
  document are separate keys, and $0 rules out a database.
* **Instant mobile-money confirmation.** No $0 API exists for EcoCash/InnBucks/
  OnePay in Zimbabwe. Unique-cents matching plus one-tap confirmation is the
  honest answer; a bank/rail API would change nothing about the design.
* **Holding money.** We never touch a payment. `payfast`/`ozow`/`payshap` are
  instructions to the buyer, not integrations. Renewal money goes through a
  hosted Flutterwave link straight to the operator account.
* **Static assets binding.** Cloudflare's asset upload format rejects HTML
  modules; KV templates turned out better anyway (hot-swappable, no rebuild).
* **Storefront features that need a paid plan elsewhere** are free by
  construction here: unlimited products, images, options, add-ons, stock flags,
  WhatsApp handoff, analytics-lite. `publicStore()` strips everything private
  from the public config — asserted by tests.

## Where things live

| | |
|---|---|
| Onboarding (give this to merchants) | `https://tapstall.simalidudu.workers.dev/onboard` |
| A store | `…/s/<handle>` · its config `…/s/<handle>/config.json` · its menu `…/s/<handle>/feed.json` |
| Merchant dashboard | `…/a` — opened by the code returned at sign-up and sent with each order; `POST /api/login`, `POST /api/logout`, `POST /api/recover`, `POST /api/revoke` |
| Self-service settings | `POST /api/settings` · `POST /api/settings/revert` (fields from `GET /api/admin` → `editable`) |
| Rate calculator | `…/fees` (also on Pages, shareable with query-string state) |
| Health / diagnostics | `…/__ping`, `…/__selftest`, `…/__selftest?scheduled=1` |
| Rail table | `…/rails` |
| Production check (70 assertions, run it any time) | `./scripts/prod_check.sh` — needs the KV read token for the crawler probe, works with `HANDLE=` set to any store |
| Deploy log of the last CI run | `https://raw.githubusercontent.com/king-kunta-cpu/tapstall/main/ci-deploy.log` |
| Re-run a failed deploy | `POST /repos/king-kunta-cpu/tapstall/actions/runs/<id>/rerun-failed-jobs` with the repo PAT — the one Actions call that works (job *logs* are not readable with it, which is why `ci-deploy.log` and step annotations exist). `deploy-pages` fails on GitHub's side from time to time — "Fetching artifact metadata failed… re-run the deployment at a later time" — and a rerun is the whole fix; the Worker job is unaffected, so the product stays live and current while the mirror lags a run |

`STATUS.md` records what has been proven on production, the one item still
waiting on a clock (the cron heartbeat), and the deliberate limits.

## Verified

`node --test tests/` → **94 pass** (28 unit on `core.js`, 42 driving the real
bundled Worker against an in-memory KV — the full journey plus the authority
model: forged/expired/revoked codes, inert GETs, the 15-minute hold, masked
audit, cross-origin refusal, and now every `/ops` gate, lever and template rule;
14 on the shipped HTML — script compiles, ids resolve, endpoints routed, console
buttons backed by Worker actions — and 10 on the limits that a caller cannot talk
past: the per-IP order rate, the lockout, the KV quota). Deployed and exercised on the real Worker:
two tenants (Harare/USD/EcoCash, Durban/ZAR/PayShap), order → one-tap paid,
cross-tenant isolation, expiry → cron suspension → 503 → webhook → reinstated
(`plan: annual`, 746 days). `/__selftest` reports bindings, all five templates,
pricing, and a `secret_leak_check`. `scripts/prod_check.sh` (92 checks,
several of them per-tenant loops) against the live Worker at v0.5.0: nine sections, covering the crawler prefetch, the 405s, the CORS split, the
15-minute hold, masked audit, revocation, self-serve recovery, cross-tenant
refusal and — from v0.4.0 — the two consoles: money pages present in KV, `/ops`
refusing an anonymous reader, the cookie's flags, a lever needing the confirm
header, and sign-out actually ending the session. A check that the day's KV quota
made impossible is reported as **blocked**, not failed — `0 blocked` is the only
number that says the product works; a red write check on a capped day says nothing. The version assertion reads
`VERSION` out of `worker/worker.js`, so it can never go stale again.

Known gaps: the Flutterwave hosted-link slug (`FW_PAY_SLUG`, default
`tapstall`) is a placeholder until an account exists — it is config, so changing it
is a secret set and a redeploy, never an edit to shipped code (renewal works through the webhook and manual reference
until then); email delivery needs the `EMAIL` binding to be created in the
dashboard once; buyers' phone numbers are stored per order (POPIA/Zim GDPR
posture is "minimise + 180-day TTL on the fingerprint hash", not zero-knowledge).
