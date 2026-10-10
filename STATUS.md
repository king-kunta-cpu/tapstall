# Status — 2026-10-10

## Live right now

| What | Where | Proof |
|---|---|---|
| Worker (every tenant) | `https://zimlink.simalidudu.workers.dev` | `/__ping` → `{"ok":true,"version":"0.2.0"}` |
| Onboarding | `/onboard` | HTTP 200, self-serve, posts to `/api/register` |
| Rate calculator | `/fees?aov=7&n=140&cod=35&cash=20&min=6&hr=3&m=zw` | HTTP 200, 11,117 B, URL-synced |
| Landing (Pages) | `https://king-kunta-cpu.github.io/zimlink/` | HTTP 200 |
| Demo tenant (ZW) | `/s/mamatoe` | 4 products from its own CSV feed, 0 leaked secret fields |
| Demo tenant (ZA) | `/s/kotaking` | order `KOT-0001` marked `paid` by one tap, plan `annual` |
| Rail reference | `/rails` | 9 rails with pct/IMTT/type |
| CI/CD | `.github/workflows/deploy.yml` | run #7 `success` — tests → Worker → cron → Pages |

## Verified on production, not only in tests

- Two tenants isolated by KV key; neither can read the other's config; `/api/admin`
  for an unknown handle returns `{"ok":false,"error":"no store"}`.
- Order → `pay_now` `23.93` on a `23.12` total (PayShap, `pass`) and `23.89` on
  `23.10` (EcoCash, `absorb`, `fee_absorbed_by_merchant: 0.79`).
- One-tap confirmation via `GET /api/mark?handle=…&token=…&id=…` → `paid`,
  idempotent on a second tap (no duplicate row).
- Expiry → `runCron` suspended the store (`{"checked":2,"suspended":1}`) → orders
  answered `503 store paused — owner needs to renew` → Flutterwave-shaped webhook
  activated it (`paid_until` +365 d, `plan: annual`) → next cron tick clean.
- Rate limit: 8 `POST /api/order` per minute per IP, then `429`, while `GET`s stay
  open. (The flood test's 8 demo orders were deleted afterwards.)
- `publicStore()` leak check green in `/__selftest` and in the served HTML
  (`admin_token`, `owner_email`, `notify_webhook`, `feed_cache` all absent).
- Template hot-swap path works: HTML lives in KV under `tpl:*`, updated by one PUT.

## One thing left to confirm, in ~5 hours

The schedule is declared in `wrangler.toml` and wrangler reported
`schedule: 15 6,12,18,0 * * *` at deploy, but Cloudflare's cron-triggers API
refuses both JSON and metadata-only multipart for this token type, so it cannot be
read back over HTTP. Verify without the dashboard:

```
curl -s https://zimlink.simalidudu.workers.dev/__selftest | jq .cron_heartbeat
```

`minutes_ago` should be under ~365 after 06:15 UTC and never reset by a deploy.
If it reads `never run` long after that, set the trigger once in
Workers & Pages → zimlink → Settings → Triggers → `15 6,12,18,0 * * *`.
Nothing else breaks if it is missing — expiry checks also run whenever a merchant
renews, and orders are never lost.

## Known limits (deliberate, not TODO)

1. **No instant mobile-money confirmation** — none exists at $0 in ZW/SA. The
   product replaces the need for it (unique cents + one tap). Wiring a rail API
   later changes no interface here.
2. **`https://flutterwave.com/pay/zimlink`** is a placeholder link slug until a
   Flutterwave account exists. Renewal is still automatic the moment a webhook
   with a matching `tx_ref` arrives (`/api/hook/flutterwave`); until then the
   buyer-visible path is "pay and paste the reference", and the free 60 days
   means nobody is locked out by it.
3. **Email** needs the `EMAIL` binding created once in the dashboard (a
   Cloudflare-own send route, not third-party). Absent it, renewal notices ride
   on the merchant webhook only.
4. **Buyer phone numbers are stored per order.** Fingerprints are hashed with a
   180-day TTL; order rows themselves are the merchant's ledger and expire with
   the store's own housekeeping, not the platform's.
5. **`zimlink-stores` vs `zimlink-store`**: two KV namespaces exist — the Worker is
   bound to `b5c1c89d…` (title `zimlink-stores`), which holds every template and
   both demo stores. The older `b32c2fe9…` (`zimlink-store`) is an orphan from a
   buggy first run and can be deleted once you are sure you do not want it.

## Security note

The GitHub PAT and Cloudflare API token were pasted into this chat, so rotate
both when you are done building. The `ADMIN_SECRET` that briefly landed in a
public commit (`d9c6721`) was rotated in the same session; the repo was deleted
and recreated so the tree no longer contains it — the old blob may stay
reachable by its raw SHA until GitHub garbage-collects it, but the value is inert.
