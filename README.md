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
tests/core.test.mjs   49 unit tests on the money, the parser, the menu, the rails and the pictures
tests/live.test.mjs   60 tests that run the real handler + cron against a stub KV
tests/limits.test.mjs 10 tests on the free-tier budgets (writes, sizes, locks)
tests/pages.test.mjs  23 tests on the shipped HTML itself (no browser needed)
scripts/deploy.sh     one command: tests → KV → templates → bundle → deploy → triggers → self-check
scripts/deploy.sh --templates   the pages only, for the morning after a day whose 1,000 KV writes ran out
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
  string, the rate, the shape of the number buyers pay into, and what proof the buyer
  has to hand over — in onboarding and in the dashboard. `rail_def` is a
  money-class field, so it waits out the same 15-minute reversible hold as the
  payment account, and it is public by design: it is what the buyer is shown.
- Pricing is arithmetic on whatever rail resolves
  (`fee = subtotal × (pct + imtt) + fixed`, zero for cash-on-delivery), the
  worker snapshots it into `order.pay`, and `/s/<handle>/config.json` hands the
  storefront the resolved rail as `rail_info` so the cart preview and the receipt
  cannot disagree. A rail removed later cannot change a slip already sent.

- **Every rail answers a second question: how does the money get *found*.** A wallet
  prints a code in its confirmation SMS, and a merchant who searches the app by amount
  usually finds the payment anyway; a bank transfer is one amount and forty payers, so
  there a reference is not a nicety. So `proof` is per rail — `none`, `ask`, `require` —
  derived from the rail's own shape (`cod`/`auto`/`link` → `none`, `bank` → `require`,
  everything else → `ask`) and overridable, with the merchant's own name for the field,
  in the rail description. What the policy does: `ask` and `require` put one line on the
  order form (`require` marks it and nudges once if it is empty), the payment slip tells
  the buyer to keep the code **before** they pay, the ledger row and the WhatsApp handoff
  carry it, and a `require` order that arrives without one is flagged on the row — never
  refused. Built-ins declare theirs (`zipit` requires, `payfast`/`ozow`/`cash` ask for
  nothing) and `proofDefault` in `worker/core.js` is the single authority: the dashboard's
  picker mirrors it, and a test walks the two tables cell by cell. Values live on the order
  document and the list row only — `/s/<handle>/config.json` publishes the policy and
  never a buyer's reference, because there is no buyer on a store page.

- **And the follow-up is written.** A row that owes a code carries `ask`: one or two
  sentences, produced by `proofAsk` in `core.js` from the rail frozen on that order, and
  appended by the two taps a merchant already has — *WhatsApp buyer* and *Copy the slip*.
  Nothing is stored (a renamed field updates yesterday's wording), nothing is said when
  the buyer answered or the rail needs nothing, and the page never invents its own copy.

- **The buyer can answer it themselves, from the receipt.** A code exists about ninety
  seconds after the order does, and the person holding it is looking at their own screen.
  So `POST /api/order` mints a third link, `/p/<cap>`, alongside the shop's two: a
  capability of kind `proof`, bound to one handle, one order id and the store's current
  `auth_gen`, valid for the same 72 hours as a confirm link. `/api/proof` is the only
  public write in the product, and `proofAccept` in `core.js` is the whole policy as a
  pure function: `awaiting_payment` and `cod` only, `status` never, one field at a time,
  an absent field left alone rather than cleared, a value identical to the one on file
  answered `changed: false` at no cost, and **three** accepted writes before the door
  shuts — three because a mistyped TxID is the common case and a buyer who cannot fix
  their own typo goes back to messaging the shop, which is what this exists to remove.
  The capability is *not* a widened `/c/`: `a:'proof'` is refused by the money endpoint
  and `a:'mark'` by this one, both answered in the same words as an expired link. It is
  minted for the response and deliberately never stored on the order document, so the
  merchant cannot hold a URL that writes a field the ledger labels `proof_by: buyer`.
  Each accepted write costs two `ORDERS` puts — the document and the ledger row, the same
  two a mark spends — and every refusal costs nothing. The free part: `proofAsk` falls
  silent the moment a code is on file, so the chase sentence leaves the row, the slip and
  the CSV with no new wiring, and its "send it here" wording becomes literally true.

- **The chase carries the door, and the shop can file what it was sent.** Two halves of
  the same loop, both needed once a buyer could write their own code. (1) `withAsk` in
  `worker/worker.js` mints a fresh `proof` capability while it writes the row's `ask`
  sentence — `proofAsk(order, { here })` swaps one clause, so *"Send it here"* becomes
  *"Add it here … `<absolute /p/ link>`"*, and the merchant's two existing taps
  (*WhatsApp buyer*, *Copy slip*) both append `ask`, which is the whole of making the
  chase actionable with no new UI. Minting is read-time, one HMAC, no KV write, and it is
  why a lost receipt is not a lost capability: the buyer needs the next message, not the
  old link. A settled order's row keeps its sentence and gains **no** link — `proofOpen`
  decides both. (2) `POST /api/order/proof` is the shop's own write of the same field:
  `identify` only, no capability read anywhere, so it cannot be reached by a fetchable
  URL — that is why it is a new route rather than one more field on `/api/mark`, and it
  is the one place this release refuses to touch a working money path. No budget and no
  closing hour apply to it, because both exist to bound a stranger; `proof_by` records
  which hand did it (`buyer` / `merchant`), and the audit row says the same. The ledger
  row grows one input and one button when a code is owed or the order is open, prefilled
  so correcting is the same gesture as filing; an empty box is not a filing, in either
  voice (`Nothing to file — type the code they sent you.` vs the buyer's *"type what your
  app printed"*), which is why `proofAccept`'s refusals take `by` as well.

- **A buyer who closed the page is not locked out, and the door takes the whole
  record.** `pages/store.html` keeps the receipt's `/p/<cap>` in `localStorage` under
  `tp_pf_<handle>` — five entries, each dropped at the token's own 72 hours — and shows
  one line above the shelf: *"Order MAM-1234 — add your payment code"*, dismissible. The
  code page removes the entry when the value lands (`pfForgetScript`, which emits nothing
  unless the handle and code match their declared shapes). It never states that anything
  is owed, because the page cannot know. The field itself is the pair the cart had:
  `payer` joins `proof` whenever `order.pay.ask_payer` was true on the frozen slip and
  the number is missing, so the buyer can complete the record the shop searches by, in the
  cart's own words and the cart's own cleaning rule. And `notifyText(st, order)` in
  `core.js` — the merchant's order notice, now testable as a function — appends one
  sentence when a code is owed on an open order, pointing at the door in their ledger
  rather than pasting a live write into an inbox that gets forwarded.

- **Every answer at the door puts it down.** A link that could no longer be honoured used to
  stay on the buyer's phone for its full 72 hours, so the storefront kept offering a door that
  could only answer "not added". `pfForgetScript` now takes the cap as well as the code: a
  revocation or a deleted order never reached the document, so the link is the one thing such a
  page knows. Four answers may prune — settled, out of corrections, order gone, shop closed its
  links — and three may not: an empty box, a busy minute, an unverified link. Writing it found
  two bugs of its own: the page-shaped refusals had been passing their status into
  `shell(title, body)`, which takes two arguments, so every "Not added" answered HTTP 200 with
  no robots tag; and a rate-limited form post handed the browser a JSON blob, which is now a
  page that says nothing was lost and keeps the entry where it is.
  On a day when the account's 1,000 KV writes are spent, the door also answers the buyer in
  the buyer's own words — a page that says the order stands as it was, with `Retry-After`, and no
  pruning — instead of the JSON blob about the merchant's settings that the shared catch used to
  hand to a phone mid-payment (v0.7.8).

- **The field is on the receipt, not one tap away.** `showDone` draws `pfBox` in the paybox
  whenever `needDoor`: a real `<form method=post action="/api/proof">` carrying the cap this
  response handed this browser, the shop's own label and hint, and the sender-number box only
  where the rail searches by it. JS replaces the navigation with one `fetch` and folds the box
  into a line of the receipt; without JS it is still the door's page. Refusals answer with
  `why` and `final` so the client never classifies an answer by reading English — `empty` and
  `throttled` keep the box, `settled`, `spent`, `revoked` and `gone` fold it away — and the
  same counter that throttles a wrong PIN is why a capped day answers the door with 503 before
  it looks at a cap (v0.7.9).

- **One link, one change.** The buyer's cap is bound to a nonce stored on the order, and an
  accepted write rotates it and hands the next link back in its own answer — `Correct it` on
  the `Sent` page, `proof_url` in the JSON, and the receipt box re-pointed at it. So the
  affordance is exactly what it was (three writes, one field, no merchant in the loop) and a
  link that has filed something is worth one thing more: the same value again, which is a
  retry, answered `retry: true` at no cost. A new value on a spent link is 410 `why: "used"`,
  it prunes that link from the phone that kept it, and it mints nothing in the refusal. The
  shop filing a code from the chat spends the buyer's link the same way; a cap or an order
  from before the rule is honoured and binds itself on its first write (v0.8.0).
- **A filed code can be handed back.** Sealing the field when a value is on file is right while
  the code is good and a dead end when it is not, so the shop's ledger row grew one deliberate
  gesture — `Hand it back` — that clears the reference, restarts the buyer's three changes, and
  turns the order's nonce over so every link minted for the old code is dead, spent or live. It
  is the shop's route only: the buyer's door reads two fields and no verb, a blank box is still
  refused on both sides, and an already-empty field is answered as a state rather than a failure
  (v0.8.1).
- **The door says who closed it.** A link can die two ways now — the buyer spent it, or the shop
  handed the field back and turned the nonce over — and only one of those is something the buyer
  did. Same 410, same `used: true`, same pruning of the dead entry from the phone that kept it;
  different sentence, chosen by `proofSuperseded` reading the void stamp and the empty field. No
  retired link gains a write or a mint: an old link is a pointer to nowhere, and the fresh box
  comes from the receipt that already mints (v0.8.2).

- **A refusal may only promise what the device can still deliver.** "Open your receipt" was true of
  the phone that filed and false of the one a forwarded link arrived on; after a hand-back it is
  true of nobody, because the void retires every link the order had at once. So the retired card
  sends the buyer to the chat, where the shop's own one-field box can put the code on the order,
  and the spent card says *if this phone has a newer link*, which is the only form of that
  sentence that is ever false-free (v0.8.3).

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
settings change, clear filed references, hand out a new sign-in PIN, revoke
every session and key); the template editor, which publishes to KV at once and restores
from `git main` in one press; the health panel (the Worker's own self-test, the
cron heartbeat, the Pages mirror, the last CI line); and a change log that shows
merchant writes masked next to operator writes attributed.

Three rules hold it together, and each is tested:

* **Nothing on either suite is required for a customer to be onboarded, to order,
  or to be paid.** The console is oversight. A merchant's own recovery path
  ("I lost my PIN") never routes through the operator, which is what keeps the
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
| Lifetime of a link | forever | 72 h confirm · 15 min undo · 12 h session, and no login link at all since 0.6.0 |
| Read a store's dashboard link from a handle | `/api/lookup` handed it out | `/api/lookup` returns public health only |
| Payout details | no self-serve path at all (`409 handle already taken`) | `POST /api/settings`, 15-minute hold on money fields, masked audit, self-serve PIN reset |
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
| Prove one merchant's login, right now | `./scripts/try_login.sh <store name> <PIN>` — signs in from an empty cookie jar, shows the cookie flags, reads the dashboard with nothing but that cookie, and reports whether any PIN material came back. A login is not one-use, so running it does not spend anything |
| Production check (194 assertions today, run it any time) | `./scripts/prod_check.sh` — needs the KV read token for the crawler probe, works with `HANDLE=` set to any store, and `PIN=` to walk the whole front door |
| Deploy log of the last CI run | `https://raw.githubusercontent.com/king-kunta-cpu/tapstall/main/ci-deploy.log` |
| Re-run a failed deploy | `POST /repos/king-kunta-cpu/tapstall/actions/runs/<id>/rerun-failed-jobs` with the repo PAT — the one Actions call that works (job *logs* are not readable with it, which is why `ci-deploy.log` and step annotations exist). `deploy-pages` fails on GitHub's side from time to time — "Fetching artifact metadata failed… re-run the deployment at a later time" — and a rerun is the whole fix; the Worker job is unaffected, so the product stays live and current while the mirror lags a run |

`STATUS.md` records what has been proven on production and the deliberate limits.
One measurement worth knowing before you trust it: `cron:last` lives in KV, so
*both* origins report the same heartbeat — the value cannot tell you who swept. The
field that does is `/__selftest`'s `cron_owner` (`true` on `tapstall`, `false` on the
alias), which is what `deploy.sh` checks and what the test suite proves by watching
every `cron:*` write while `REDIRECT_TO` is set. That var is the alias's *only*
behaviour, so both publishers have to carry it: the day the dependency-free one
(`cf_publish.py`, used when `node_modules` is absent) built its bindings from its
arguments alone, it shipped the alias without it — the old hostname started serving
the app itself and the sweep ran from two origins, four times a day, quietly. Both
paths pass it now, `deploy.sh` refuses to call an alias healthy on a `200`, and
`prod_check.sh` asserts the `301` and the `cron_owner:false` in its ordinary run, so
this cannot regress between two people noticing.

## Verified

`node --test tests/` → **163 pass** (59 unit on `core.js` — money, menu, rails,
hours, image references and sniffing, and every rail's proof policy with the
dashboard's mirror of it compared cell by cell; 66 driving the real bundled Worker
against an in-memory KV — the full journey plus the authority model: forged/expired/
revoked codes, inert GETs, the 15-minute hold, masked audit, cross-origin refusal,
every `/ops` gate, lever and template rule, an upload that is stored, served, refused
and swept, and a payment code that round-trips from the buyer's thumb to the ledger
row without ever meeting a public page; 28 on the shipped HTML — script compiles, ids
resolve, endpoints routed, console buttons backed by Worker actions, a picture path
cannot escape its attribute, a CSV header has one name per column; and 10 on the
limits a caller cannot talk past: the per-IP order rate, the lockout, the KV quota). Deployed and exercised on the real Worker:
two tenants (Harare/USD/EcoCash, Durban/ZAR/PayShap), order → one-tap paid,
cross-tenant isolation, expiry → cron suspension → 503 → webhook → reinstated
(`plan: annual`, 746 days). `/__selftest` reports bindings, all five templates,
pricing, and a `secret_leak_check`. `scripts/prod_check.sh` (194 assertions today,
several of them per-tenant loops) against the live Worker → **194 passed, 0 blocked,
0 failed** on a day the account can write (the same run on a spent one reads
154/40/0, and every difference is a line that needs an order to exist): eleven sections, covering the crawler prefetch, the 405s, the CORS split, the
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

## Being found

A store link is pasted into a WhatsApp group, a Facebook page, a X post. The things
that build those previews run no JavaScript, and neither does a crawler — so since
0.7.1 the storefront's `<head>` is written by the Worker, per store, from what the
store document already holds. `core.js` owns the rules (`seoFacts`, `seoHead`,
`seoJsonLdTag`, `ROBOTS_TXT`, `sitemapXml`) so they are testable; `fillSeo` in
`worker.js` is the one deliberate raw-string injection (the marker
`<!--@SEO@-->` sits *above* a fallback title, so a template published before this
still works, and the fallback is removed only when a real title replaces it).

| Emitted | From | Never from |
|---|---|---|
| `<title>` = shop, place, brand | `shop_name`, `location` | a hard-coded brand line |
| `description` | `tagline` + the top three priced items + "Open until 21:00" | a template sentence when the merchant wrote one |
| `og:image`, `twitter:image` | `logo`, else the first item picture, served by `/i/…` | a promise with no file behind it: no picture, no tag |
| `canonical` | the host that answered | the alias, which 301s before this runs |
| `LocalBusiness` + `Menu` JSON-LD | `whatsapp`, `week`, `menu`/cached shelf, `currency` | hours nobody typed, a cuisine nobody claimed |
| `robots.txt`, `sitemap.xml` | the app paths to shut, three pages to open | **a list of every store** |

The sitemap is the one place we say no. `/sitemap.xml` is unauthenticated, and every
`/s/<handle>` displays that shop's payment numbers, so enumerating tenants is a
downloadable register of our customer base and their tills. Store pages stay
crawlable (`robots.txt` opens `/s/` and `/i/`, `robots: index, max-image-preview:large`)
and the merchant's own sharing supplies the link; `/a`, `/ops` and the API are
`Disallow`ed *and* carry `X-Robots-Tag: noindex` for the crawler that ignores
robots.txt. IndexNow and Search Console verification are one config line each and are
deliberately not switched on: they are the same enumeration with extra steps.

Two more surfaces came out of the same reading. **A shop can post itself**:
`GET /s/<handle>/share.txt` returns plain text assembled from the store document —
a WhatsApp status block, an X post that fits 280 characters so its link survives, a
Facebook bullet block with no hollow bullets, and an Instagram line that carries no URL
because captions there are not clickable. The storefront links it from its own header
(`share.txt`, relative, so it needs no script and no absolute URL), and a buyer
forwarding a shop uses the same file. **There are written pages**: `/guide/<slug>`,
one pillar and one cluster, listed in `core.js: GUIDES` so the route, the sitemap and
the footer all read the same array — and `deploy.sh` derives its publish list from
`pages/guide-*.html`, which is how the bot's whole orphan problem is made impossible
instead of monitored. `@ORIGIN@` in those files is stamped with the host that answered,
so the canonical is right on any domain and a move to a real one fixes every page at once.

The last piece is operational: every exit of both money doors is counted, once per hour
per outcome (`hooks:<YYYYMMDDHH>:<status>`, a conditional write so the bound holds across
isolates), and `/ops/api/health` reports it. Their engine posts each guard refusal to
Discord, which is right about visibility and silent about cost; a refusal is the one
event a stranger can generate at will, so what you get is "was anything tried this hour,
and did anything get through" rather than a ledger an attacker can spend our budget with.

### What came from the COREMERCH bots, and what did not

Every numbered feature in their changelog, plus the mailer's and the payment engine's,
is dispositioned in [`docs/POINTERS.md`](docs/POINTERS.md) — taken, already had, or
refused with a reason. The short version: take the checklist and the discipline, leave
the density counters, the ping that Google ignores, and the credential in the source.

`uploads/COREMERCH CONTENT BOT V6.0.txt` is a 387 KB Google Apps Script that publishes
to GitHub Pages. Its discoverability half is good engineering and is now ours in
substance: canonical URLs, OG **with alt text**, Twitter `summary_large_image`,
JSON-LD per page, a sitemap with a priority map and `lastmod`, ping-on-publish,
"real PNG byte enforcement on all images" (ours are sniffed and re-sniffed at serve
time), heading discipline, and a dead-image detector (0.6.9's reclaim is the same
instinct, applied to KV instead of a repo).

Not copied, with reasons: **keyword density and section-uniqueness ratios** (they
optimise a blog for a crawler; a menu is data, and a page that pads to hit 0.8–1.8%
is how a small site earns a thin-content tag); **FAQ JSON-LD** (Google demoted FAQ
rich results for non-authoritative sites in 2023, so it is now ceremony);
**a sentence-hash LRU of 500 for dedupe** (a bounded memory means an old post can be
republished once it falls out — a TTL, which is what `paid:` and `tx:` use, cannot be
evicted into a double); **`google.com/ping?sitemap=`** (Google never committed to it
and says it is ignored — one HTTP call per publish for a documented no-op, worth
deleting from the bot). Its `OPENRAIL` engine's five guards (re-deposit, idempotency,
API re-verification, amount, asset) are the same ladder 0.7.0 now walks, which is
worth knowing: the discipline is not new to this household, it had simply not been
applied to *our* webhook. If a crypto rail is ever added, the piece to take from
`OPENRAIL` is its tolerance policy — 1% on stablecoins, 2% volatile, under-payment
flagged not refused, and a nightly underpayment report — because an exact-cent match
is the right rule for a fixed plan price and the wrong one for a chain.

## How a payment is believed

Renewal money arrives by provider webhook, and a webhook is a public POST that
*claims* to be somebody. Both doors are therefore **shut until configured**:
`/api/hook/payfast` answers `503` naming `PAYFAST_PASSPHRASE` until that secret
exists, and `/api/hook/flutterwave` answers `503` naming `FW_SECRET`. Neither has a
"verify if configured" mode, because a check that defaults to off is a check that
stays off. This is the same shape as `markPaid`: capability first, effect second.

What an armed door may conclude lives in `core.js`, so it can be read and tested:

| Rule | Where | Why it is there |
|---|---|---|
| The terms come **only** from the intent this Worker minted | `POST /api/checkout` → `tx:<random 16>`, `expirationTtl: 1800` | a notice cannot name a shop, a number of days, or a price; the 30-minute window is why an old link says "start again" instead of honouring last month's price |
| PayFast's signature over the sorted, decoded fields is required | `payfastCanonical` / `payfastSignedOk`, MD5 pinned in the suite against vectors from Python's `hashlib` | Workers' WebCrypto has no MD5, so the primitive is ours and is checked; both readings of the provider's spec are accepted (their samples disagree) — the strict direction would silently refuse a real payment, and it cannot be forged either way |
| Amount **and** currency on the notice must equal what was asked | `txMatches` | "someone paid something" is not "someone paid the price" |
| Flutterwave is asked back when `FLW_API_KEY` exists | `GET /transactions/{id}/verify` | never take a payment's word for its own success; an unreachable provider answers `502` and leaves the intent unspent rather than losing a payment that happened |
| Success spends the intent and records `paid:<provider id>` for 30 days | both hooks | one payment, one credit; a retry is answered `already: true`, not double-counted |

Both hooks are rate-limited by IP like an order, and everything they refuse writes
nothing — so a probe, a replay and a guess all cost the same: nothing.
