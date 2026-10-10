# Status — 2026-10-10

## Live right now

| What | Where | Proof |
|---|---|---|
| Worker (every tenant) | `https://zimlink.simalidudu.workers.dev` | `/__ping` → `{"ok":true,"version":"0.4.0"}` |
| Onboarding | `/onboard` | 35,692 bytes served, byte-identical to `pages/onboard.html` in git |
| Operator console | `/ops` | served page = committed `pages/ops.html` with the session hook filled (37,378 served vs 37,364 in git, the difference being `{"signed_in":false,"version":"0.4.0"}`); `/ops/api/*` → `401` anonymous |
| Money pages from KV | `tpl:confirm`, `tpl:renew`, `tpl:ops` | `/__selftest` → all eight `tpl_*` true, so no page is on the inline fallback |
| Rate calculator | `/fees?aov=7&n=140&cod=35&cash=20&min=6&hr=3&m=zw` | HTTP 200, 11,117 B, URL-synced |
| Landing (Pages) | `https://king-kunta-cpu.github.io/zimlink/` | HTTP 200 |
| Demo tenant (ZW) | `/s/mamatoe` | 4 products from its own CSV feed, 0 leaked secret fields |
| Demo tenant (ZA) | `/s/kotaking` | order `KOT-0001` marked `paid` by one tap, plan `annual` |
| Rail reference | `/rails` | 9 rails with pct/IMTT/type |
| CI/CD | `.github/workflows/deploy.yml` | run #19 `success` at v0.4.0 — tests → templates → Worker → cron → Pages; 124/124 re-measured on both tenants after it |

## Verified on production, not only in tests

- Two tenants isolated by KV key; neither can read the other's config; `/api/admin`
  for an unknown handle returns `{"ok":false,"error":"no store"}`.
- Order → `pay_now` `23.93` on a `23.12` total (PayShap, `pass`) and `23.89` on
  `23.10` (EcoCash, `absorb`, `fee_absorbed_by_merchant: 0.79`).
- One-tap confirmation is now `GET /c/<cap>` (inert page) → browser POST → `paid`,
  idempotent on a second tap (`already:true`, no duplicate row), reversible with
  the 15-minute `undo_url`. Re-measured after v0.3.0 with `scripts/prod_check.sh`:
  **88/88 on `mamatoe` and 88/88 on `kotaking`**, including the Slackbot-UA
  prefetch (order document read straight from KV, still `awaiting_payment`).
- Re-measured again after v0.4.0 with the two consoles added: **124/124 on
  `mamatoe` and 124/124 on `kotaking`**, section [8] covering the open door
  (`/ops/api/{state,health,audit,templates}` → 401 to an anonymous reader, a lever
  without `x-zimlink-confirm: 1` → 401), the cookie's flags (`HttpOnly`,
  `SameSite=Strict`, `Secure`, `Max-Age=43200`), a state read that holds no
  credential (`admin_token`, `secret_hash`, `fw_secret`, `auth_gen`, `admin_url` all
  absent), all eight templates live in KV, the link lever returning a `/a?code=v1`
  capability that expires in ≤7 days, and sign-out making the cookie worth 401.
  Two things the check does on purpose: it counts a dashboard link rather than
  printing it (`ck` echoes 240 bytes of a failing value, and that value is a
  credential), and it re-logs in at the end so its own wrong-guess probes cannot
  walk the operator's lockout counter toward a freeze.
- Expiry → `runCron` suspended the store (`{"checked":2,"suspended":1}`) → orders
  answered `503 store paused — owner needs to renew` → Flutterwave-shaped webhook
  activated it (`paid_until` +365 d, `plan: annual`) → next cron tick clean.
- Rate limit: 8 `POST /api/order` per minute per IP, then `429`, while `GET`s stay
  open. (The flood test's 8 demo orders were deleted afterwards.)
- `publicStore()` leak check green in `/__selftest` and in the served HTML. It is
  now an **allowlist**: the denylist version leaked `pending` (a queued payout
  account) into `/s/<handle>/config.json` for a day until the new check caught it.
- Merchant authority, measured live rather than only in the harness:
  `GET /api/mark` → 405 + `Allow: POST`; `GET /api/settings`/`/api/revoke` → 405;
  anonymous `POST /api/settings` → 401; `OPTIONS` on a mutation path → 403 while
  `OPTIONS /api/order` still answers `*`; no `Access-Control-Allow-Origin`, CSP
  `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `no-store` on every admin response; `/api/lookup` free of `admin_url`,
  `renew_url`, `pay_account`, `feed_url`, `whatsapp`, `admin_token`,
  `notify_email`; a forged or truncated cap → `link_expired`; a login code spent
  on `/api/mark` → `link_expired`; `POST /api/recover` with one right answer →
  403 and a counted attempt; settings with the API key → cosmetic field live at
  once, `pay_account` held with `in_ms` counting down, visible to the owner,
  absent from the public page, cancellable, and recorded in the audit masked.
- Migration, deliberately not forced: `kotaking` and `mamatoe` still hold their
  v0.2 `…/a?handle=…&token=<10 chars>` links and those links still open — by
  trading up for a 7-day code, over a `Set-Cookie`, never by acting on a GET.
  They are now throttled (12 bad tries per 10 minutes per store), no longer
  discoverable from a handle, and one `POST /api/revoke` rotates them to a
  128-bit key. Merchants were not emailed a new link, because the old one is
  not broken; the next revoke upgrades it, and the "Lost your link?" form is
  there whenever they choose to use it.
- Template hot-swap path works: HTML lives in KV under `tpl:*`, updated by one PUT.

## One thing left to confirm, in ~5 hours

The schedule is declared in `wrangler.toml` and wrangler reported
`schedule: 15 6,12,18,0 * * *` at deploy, but Cloudflare's cron-triggers API
refuses both JSON and metadata-only multipart for this token type, so it cannot be
read back over HTTP. Verify without the dashboard:

Note: `runCron` also runs on demand via `/__selftest?scheduled=1`, and the deploy
self-check does exactly that — so a fresh `minutes_ago` right after a deploy is not
proof on its own. Proof is a timestamp that moves at 06:15/12:15/18:15/00:15 UTC
with **no** deploy in between.

```
curl -s https://zimlink.simalidudu.workers.dev/__selftest | jq .cron_heartbeat
```

`minutes_ago` should be under ~365 after 06:15 UTC and never reset by a deploy.
If it reads `never run` long after that, set the trigger once in
Workers & Pages → zimlink → Settings → Triggers → `15 6,12,18,0 * * *`.
Nothing else breaks if it is missing — expiry checks also run whenever a merchant
renews, and orders are never lost.

## Merchant authority — this round (2026-10-10, v0.3.0)

Why it happened: adding self-serve `POST /api/settings` would have handed the
existing all-powerful `admin_token` the ability to rewrite a payout account.
Instead the credential model was rebuilt first, then the feature was added on
top. Both are in this release.

| Change | Proof |
|---|---|
| `core.js`: `issueCap`/`verifyCap` (HMAC-SHA256, 43-char tag), `validateSettings`, `stageSettings`, `applyPending`, `maskField`, `sign` | unit tests, and `/__selftest` re-runs the same assertions inside the Worker's own runtime |
| Confirm links are `/c/<cap>` pages that POST; `GET /api/mark` → 405 with `Allow: POST` | live test: fetch the page as a crawler would, order still `awaiting_payment` |
| `auth_gen` bump = every link, cookie and key dead in one write; `POST /api/revoke` also mints replacements | live test: old session 403, old code 401 "revoked", new link 200 |
| 12-hour `HttpOnly SameSite=Strict Secure` cookie; codes 7 d (login) / 72 h (mark) / 15 min (undo) | live test asserts the `Set-Cookie` attributes, not just the redirect |
| Money/PII settings held 15 min and applied lazily on the read path; cosmetic fields instant; `POST /api/settings/revert` cancels | live test fast-forwards `apply_at`, then reads `config.json` |
| `order.pay` snapshot freezes what a buyer was told to pay | live test: after the new account lands, the old order's slip still names the old one |
| `/api/lookup` stripped of `admin_url`/`renew_url`; outbound webhook stripped of the credential (now `x-zimlink-body: sign(body)`) | live test greps the public payload for each field name |
| CORS split: `*` on buyer paths, none on admin/mutation paths; CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `no-store` | live test on both halves |
| Self-serve link recovery with 12-per-10-min lockout per store | live test, including a no-email cash shop |
| Settings panel, pending countdown + Revert, masked change log, Revoke and Sign out in `/a` | `pages/admin.html`, served from KV as `tpl:admin` |

Two real bugs the suite caught while it was being written, both now fixed and
asserted: `/renew/<token>` used `randomKey` (base64url), so a `-` or `_` — about
1 shop in 8 — produced a renew link the route's own regex rejected with 404;
and `^\/{1,2}` in the CORS path test made *every* path public, so `ACAO: *` was
still on the ledger endpoint.

Old links are not dead: a v0.2 `?handle=…&token=…` link still authenticates
against the stored key and is redirected to a fresh code, and `GET` on such a
link is answered the same way — never by marking anything paid. Guessing at
either path counts as a failed attempt against the store's lock counter.

Scanner proof, taken from production after the deploy: one probe order's
`mark_url` fetched with six user agents — `WhatsApp/2.24.0`,
`TelegramBot (like TwitterBot)`, `Twitterbot/1.0`, `Googlebot/2.1`,
`Slack-ImgProxy 0.65`, `curl/8.5.0` — each with `-L`, following redirects the way
a preview bot does. Every one returned `200` on the same `/c/…` URL and the order
document, read straight back out of the ORDERS namespace, still said
`awaiting_payment` with `pay.account = 0771234567` (the merchant's real EcoCash
number) and `pay.amount = 0.04`. Under v0.2 the first of those six fetches would
have marked the order paid on its own.

**Throttling, and the DoS it must not create.** Twelve failed credential
attempts per store per ten minutes is what stops a stranger sweeping an old
10-character link or a leaked API key. It is consulted on exactly the paths
where guessing is possible — the `x-zimlink-admin` header, the legacy
`?token=` trade-up, and "Lost your link?" — and never on an HMAC session or a
signed capability. The first version of the gate also blocked the merchant's own
confirm button, which meant twelve junk requests from anyone could freeze a
shop's order flow for ten minutes; the test suite now asserts the opposite
(a throttled store still confirms with a valid link, and still opens its
dashboard with a valid cookie, which also clears the counter).

**The lockout is a brake on guessing, not a kill switch on the owner.** The
first version consulted the counter before comparing the key, so twelve junk
requests from a stranger answered `429` to the merchant's own correct API key.
Caught by repeating the sequence against production — 12 × `403`, then `429`,
then a *valid* key also `429` — and now asserted in the suite: the correct key
(or a correct legacy `?token=` link) always gets in and clears the counter, and
the lock only ever changes the answer given to a credential that is wrong.

## The two UI suites — this round (2026-10-10, v0.4.0)

The product sold itself fine and looked like three different products. Now there
is one design language (`pages/kit.css`), five authored pages (`pages/src/`),
and one generator (`scripts/ui_kit.py`) that inlines the kit into each shipped
file — because a page must render with no network, in a sandboxed preview, on a
2G handset, and the ~9 KB of kit is cheaper than any of those failure modes.
`ui_kit.py check` is the drift gate: it runs in `deploy.sh --check`, in the real
deploy before templates are published, and as a test.

What is new:

* `/onboard` — four steps (identity → menu + rail → money rules → live), per
  field validation, a handle-taken check against `/api/lookup`, and a buyer card
  that shows the odd-cents and surcharge arithmetic before anything is committed.
  The success screen carries the store link, the dashboard link, the renew link,
  a printable QR poster and the WhatsApp status text — the whole distribution
  motion, at the moment of highest motivation. Draft state lives in
  `sessionStorage`, so a dropped connection is not a lost form.
* `/c/<capability>` — the one-tap page. Renders buyer, amount, rail; auto-POSTs
  once, and only when `document.hidden` is false, so bots that prefetch links
  still cannot confirm an order. `<noscript>` posts the same cap to the same
  endpoint; `undo_url` gives 15 minutes; `already` / `expired` / `missing` are
  three distinct states, not one error string.
* `/renew/<token>` — days left, orders, GMV, the price for 365 days or a custom
  term, `POST /api/checkout`, and a box for "I paid by EcoCash/cash — here is the
  reference" that files against the store (`POST /api/renew-ref`, IP-throttled,
  last 10 kept, 30-day TTL) and appears in the operator's attention queue as
  `awaiting_ref`. Filing a reference switches nothing on by itself — the page
  says so.
* `/ops` — the console: KPI strip, attention queue, tenant table with a drawer
  carrying the levers, template editor (publish to KV at once, restore from
  `git main`), health (Worker self-test + cron heartbeat + Pages + last CI line),
  and the change log. Every mutation needs `x-zimlink-confirm: 1`; every lever
  writes the store's own log as well as the operator's.

`/onboard` (35,692 B), `/a` (49,711 B), `/fees` and `/` are each byte-identical
to their file in git, and `/ops` differs only by the filled session hook — which
is what makes the console's "restore from git main" button a real promise.

Four bugs the page tests caught before anything shipped — none of them visible
to `node --test` as it stood:

1. `await hash(x).slice(0, 8)` parses as `await (hash(x).slice(0, 8))` → the
   Templates panel 500-ed.
2. `notify` and `link` were handled *after* the lever dispatch chain, so they
   matched its final `else` and answered `unknown action`: two dead buttons.
3. Patching `admin.html` dropped `<div id="list"></div>`: the orders list would
   not have rendered at all in the new dashboard.
4. The new tab bar reused `id="tabs"`, which the pending-panel Show/Hide button
   already owned: both handlers landed on the button, and the tabs did nothing.

Two design changes that came out of testing rather than taste:

* **`/ops/logout` revokes.** The session is a stateless signed cap, so deleting
  the cookie was cosmetic — the cap stayed valid for 12 hours. Sign-out now bumps
  `ops_gen` in KV (one write), which ends every console session on the platform.
* **A dead cookie costs nothing.** An expired session cap hitting a gate used to
  increment the same 12-try counter as a wrong secret, so twelve refreshes — or
  twelve `prod_check` runs — would freeze the operator's own console for ten
  minutes. The counter now only follows secret guesses at `/ops/login`; forging a
  cookie is hopeless anyway, and the proof of the fix is six dead-cookie probes
  followed by a wrong guess that still shows a full counter minus one.

## Also fixed on the way (found by the new tests, not by a customer)

* **`publicStore` was a denylist and leaked the queued change.** Once `pending`
  lived on the store document, `/s/<handle>/config.json` handed an anonymous
  visitor the payout account that was 15 minutes from going live. `publicStore`
  is now an allowlist (`PUBLIC_KEYS`) and `adminStore` is the credential-stripped
  full record for the signed-in owner, so a field added in the future is private
  until someone deliberately publishes it. Asserted in both test files.
* **The dashboard payload used to carry `admin_url`.** A login code inside JSON
  turns any XSS on the dashboard page into a saved 7-day credential, and the
  cookie it replaces is `HttpOnly`, so the page never needed it.
* **The owner sees the raw queued value** (masked only in the append-only log) —
  a 15-minute "you can cancel this" window is useless if you cannot read what
  was typed.

## The first real capacity event (2026-10-10, ~10:50 UTC)

`POST /api/order` started answering `{"ok":false,"error":"KV put() limit exceeded
for the day.","stage":"worker"}` — 500-shaped, opaque, and true. Cloudflare's
free KV tier allows **1,000 writes/day for the whole account**; today's testing
consumed them: three `prod_check.sh` runs (each one creates and cancels a probe
order, files and clears a reference, issues a link, writes audit rows), two CI
deploys (each publishing eight templates), and the lock-counter probes. Reads
(100,000/day) were untouched, so every page kept rendering while nothing could be
written. Fixed, measured and tested rather than explained away:

* **A buyer can no longer be sent to pay for an order that was not saved.**
  `persistOrder` was inside `ctx.waitUntil`, so the write happened after the 201
  and its failure was invisible: the buyer got "send 6.00, reference QTQ-0001",
  the merchant never saw the order. It is now awaited before the answer; only the
  notification runs after. `tests/limits.test.mjs` drives the bundled Worker
  against a namespace whose writes all throw and asserts no 201 is possible.
* **A quota answers 503 in prose, not 500 in internals**: "out of storage writes
  for the day… Nothing is lost and no order was taken", with `retry_in_sec`
  (measured to the UTC reset) and `Retry-After`, the raw platform string kept in
  `detail` for the operator, and — because a CORS failure would hide all of that —
  `Access-Control-Allow-Origin: *` on the error path too, which it did not have.
* **Logging may never break the thing it logs.** `pushAudit`, `pushOpsLog`,
  `authFail` and `authClear` swallow storage failures and return whether they
  wrote, so on a bad day: a merchant's settings save still lands and answers
  `logged:false` with a note saying the log line is missing (the duplicate `note:`
  key that overwrote that sentence with "Saved." was itself a bug this found); a
  wrong secret is still a 403 with a count, not a 500; and `ops/login` still issues
  a session even though its own log write failed — a console that cannot be opened
  during an outage is the worst possible console.
* **Deploys now spend zero KV writes when the HTML is unchanged.** `kv_put_tpl`
  reads the current value and skips an identical file; a refused write is fatal
  only if KV then differs from git. Verified live against the real namespace while
  writes were blocked: all six pages reported `already current in KV`, and the
  byte sizes match the repo exactly (ops 37,364 · store 25,301 · onboard 35,692 ·
  admin 49,711 · confirm 17,115 · renew 17,621).

Headroom, honestly: at roughly four writes per order (order doc, list row, seq,
buyer touch) plus one audit row per merchant action, the free tier is a ceiling of
about **150–200 orders a day across every tenant** — not per tenant. Reads are not
the constraint. The fix when it bites for real is the $5/mo Workers plan (100k
writes), which is exactly the trade the pricing page should make once revenue
clears it; nothing else in the stack needs to change.

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
