# ZimLink — a WhatsApp order desk for Zimbabwe and South Africa

Merchants on WhatsApp lose money in the last five minutes before the money
moves: buyers send screenshots instead of payments, mobile-money rails cost
3–5% and nobody passes that on, and a spreadsheet of "pending" orders is the
only ledger. ZimLink gives each merchant a real storefront link that runs
itself. The whole stack is on free tiers, and **no operator touches it** —
sign-up, provisioning, menu updates, payment confirmation and renewal are all
self-serve.

**Live:** `https://zimlink.simalidudu.workers.dev/onboard`
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
pages/*.html          storefront, onboarding, dashboard, fees calculator, landing
pages/public/         static mirror for GitHub Pages (+ _headers, _redirects, sample CSV)
tests/core.test.mjs   18 unit tests on the money and the parser
tests/live.test.mjs   12 tests that run the real handler + cron against a stub KV
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
3. Merchant taps `/api/mark?handle=…&token=…&id=…` (link arrives in the
   notification, GET works, no app, no key) → order is `paid`.
4. Menu changes are the merchant's own sheet edit; `feed_cache` re-reads after
   `cache_seconds` (default 120). No one re-deploys anything.
5. Free for 60 days, then the cron warns at T-7d, and suspends at expiry (order
   endpoint answers 503 with a reason). `/renew/<token>` → `/api/checkout` →
   payment → the webhook extends `paid_until` and the next cron tick
   reinstates. Nobody sends an invoice.
6. `/api/admin?handle=…&token=…` is the whole ledger: status, flags, buyer,
   amounts. The dashboard renders a day-sheet and a CSV from the same payload.

## What is deliberately not here

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

## Verified

`node --test tests/` → 30 pass. Deployed and exercised on the real Worker:
two tenants (Harare/USD/EcoCash, Durban/ZAR/PayShap), order → one-tap paid,
cross-tenant isolation, expiry → cron suspension → 503 → webhook → reinstated
(`plan: annual`, 746 days). `/__selftest` reports bindings, all five templates,
pricing, and a `secret_leak_check`.

Known gaps: the Flutterwave hosted-link slug `zimlink` is a placeholder until
an account exists (renewal works through the webhook and manual reference
until then); email delivery needs the `EMAIL` binding to be created in the
dashboard once; buyers' phone numbers are stored per order (POPIA/Zim GDPR
posture is "minimise + 180-day TTL on the fingerprint hash", not zero-knowledge).
