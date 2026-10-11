# Tapstall — status

## The front door became a key and a PIN (2026-10-11, v0.6.0)

The magic-link scheme was not weak in theory — a 105-character HMAC capability,
7 days, one-use, revocable, no password to phish. It was weak in **explanation**.
Asked how a merchant signs in, the honest answer was "a link is minted, emailed or
shown, opened, traded for a code, which exchanges for a cookie, and if the `&`
survives the chat app". A product whose onboarding sentence needs a diagram loses
to a product whose sentence is: **"your key is `mamatoe`, your PIN is 482913."**

So the customer login and its entry screens were deleted and rebuilt, not patched.

| | |
|---|---|
| Sign in | one screen, two fields (`store name`, `PIN`), one button, no instructions |
| The key | the store name — never a secret, it is already in `/s/<handle>` |
| The PIN | 6 digits (7–8 allowed), `PIN_NORMALIZE` strips spaces and dashes so "482 913" pasted from a chat works |
| At rest | `st.pin = {v,kdf:'pbkdf2-sha256',iters:8000,salt,hash,set_at}`, per-store salt, PBKDF2-SHA256 |
| Sessions | `tp_sess` HMAC cap `{a:'sess',h,g}`, 12 h, killed by bumping `st.auth_gen` |
| Wrong answer | `'Store name or PIN is wrong.'` — identical bytes for a wrong PIN and a store that does not exist (both branches run a KDF; the unknown store is checked against `PIN_GHOST`), so the form is not an enumeration oracle |
| Freeze | per key: 6 wrong → 60 s, 10 → 10 min, 15 → 1 h, 22 → 12 h |
| Lost it | "I lost my PIN" on the same screen: store name + the contact you gave + your payout account or menu-sheet link → new PIN, shown once, `auth_gen` bumped, every other device dead, throttle and queued change cleared. No operator, no waiting. |
| Never sent | the PIN, the salt or the hash — not in any response, URL, log line or audit row (`PUBLIC_KEYS`/`adminStore` strip `pin`; the ledger records `fields:['pin']` and nothing else) |

**Why 8,000 iterations and not "as many as possible".** This Worker has a 10 ms CPU
ceiling per request. Measured warm on the runtime: 3k → 1.12 ms, 6k → 1.91 ms,
10k → 3.04 ms, 20k → 5.62 ms; at 50k+ the request died with error 1102. 8k is the
largest cost that cannot be turned into a cheap CPU attack by anyone who has learned
a store name. Against it, 6 digits are worth ~1.6 years at the old unfrozen rate
(1,728 guesses/day) and ~547 years at the rate the tiers actually allow, because
only a tier *entry* is persisted — one KV write per escalation, never one per guess.
That invariant is now a test: 60 wrong PINs cost ≤6 writes (they cost 60 before the
last pass, which is the same bug that made `POST /api/register` return 503 the day
the write budget ran out). Raising `PIN_ITER` later needs no migration: a PIN hashed
at the old cost is re-hashed on the next successful sign-in.

**What this gives up, stated plainly.** A 6-digit PIN is guessable by someone who can
make enough tries, and the counting that prevents that lives in isolate memory with
only the tier crossings in KV. An attacker who can spin unlimited fresh isolates —
or who can read this KV namespace — is not stopped by it. The old scheme was
unguessable. The exchange is deliberate: the attack that actually happened to this
product was a merchant standing at a login box holding a mangled link, and every
*other* axis moved forwards — no credential in a URL to be screenshotted, previewed
by a crawler or pasted into a group chat, no 7-day link to expire mid-transaction,
revocation still one write, and recovery no longer needs anybody.

**Retired, each with a door that says so rather than a silent 404:** `?code=`,
`?token=` trade-up, `st.admin_url`, `issueLogin`, `loginExchange`, `recoverLink`,
`CODE_TTL`, `POST /api/login` → 410, `POST /api/recover` → 410,
`POST /ops/api/link` → 410, and the ops `action:'link'` lever → 410 pointing at
`reset_pin`. Deliberately *not* a synonym for `reset_pin`: a console that believes it
is issuing a week-long credential must be told that is over. Buyers are untouched —
`/c/<code>` confirm caps, `/renew/<token>`, `x-tapstall-admin` and the order path are
the same code they shipped at 0.5.3.

Kept on purpose: the orders panel, the pending/queued settings flow, the rails
system, the ledger and the storefront — dozens of hard-won fixes and most of the
101 tests live there, and none of them had anything to do with how you get in.

**Migration.** Both tenants in KV (`mamatoe`, `kotaking`) pre-date the PIN, so each
needs one `POST /ops/api/store {action:'reset_pin', handle}` to be handed a PIN; the
console row reads `no PIN` until then and the drawer shows `PIN since <date>` after.

**Measured on production after the deploy (run #40, `0.6.0` on both origins).**
`scripts/prod_check.sh` → **138 passed, 0 blocked, 0 failed**, including a real
sign-in from an empty cookie jar, the HttpOnly/SameSite=Strict/Secure flags, and
`"kdf"|"salt"|"hash"` absent from the ledger payload. `/__selftest` reports
`pin_kdf:true, pin_iters:8000`. The alias Worker is on the same version: page GETs
301 to the canonical origin, and `POST /api/auth` is answered there rather than
redirected, so an old saved URL still gets a merchant in. Both tenants were handed
PINs through `reset_pin` and signed in (`mamatoe`: 30 orders read back, `kotaking`:
9), and three deliberate wrong-PIN probes left `pinl:*` empty — `count:0` — which is
the write-budget invariant, checked against the live namespace rather than the stub.
`/api/register` mints the PIN itself and prints it on the same screen the store link
is printed on, with Copy both / Send to myself on WhatsApp — the credential handover
is part of signup now, not a step somebody has to remember.

## The rename: ZimLink → Tapstall (2026-10-10, v0.5.0)

The name was a research artifact — Zimbabwe-shaped because that is where the
tariffs were verified — and the brief is now "anyone on WhatsApp the global
platforms will not serve". A country in the name says the opposite of that. So:
product, repo (`king-kunta-cpu/tapstall`), Worker (`tapstall.simalidudu.workers.dev`),
Pages mirror, mail subject, ICS `PRODID`, day-sheet file
names, the storefront poster default. Older entries in this file keep saying
ZimLink: that is what was true when they were written.

What did **not** change is the point of the exercise — a rename must not cost
anybody anything they had already:

| Carried by | How |
|---|---|
| Every link already sent (`/s/<handle>`, `/a?code=`, `/c/<cap>`, `/renew/<token>`) | the old Worker is deployed too, from the same code and the same KV, with `REDIRECT_TO` set: page GETs 301 to the canonical origin, everything with a body is still served there, so a browser mid-order never loses it. Its inherited cron still exists (the API refuses to delete it with this token: `PUT /schedules` → `success:false`), but a Worker with `REDIRECT_TO` returns from `scheduled()` before the sweep and `/__selftest` says `cron_owner:false` — so two Workers on one KV never sweep twice, and the deploy reads that flag instead of hoping a dashboard click happened. |
| Merchant and operator sessions | cookies are written as `tp_sess`/`tp_ops`, read as either. `auth_gen`/`ops_gen` still govern validity, so revocation works under both spellings; signing in clears the old name so "sign out" cannot be defeated by a cookie we accept on purpose. |
| Pages cached in a phone | they post `x-zimlink-confirm`/`x-zimlink-admin`; both are accepted, and CORS allows both. |
| Templates still in KV | `fillPage()` replaces `/*__TAPSTALL_*__*/null` **and** `/*__ZIMLINK_*__*/null` in one pass, so the Worker does not have to be deployed in the same second as the pages (and today it cannot be: no KV writes left). |
| A buyer's basket, a merchant's half-typed sign-up | `zl_cart_*` and `zl_onboard` are read, copied to the new key and only then removed. Losing a cart to a rebrand is not a rename, it is a lost order. |
| Merchant webhook integrations | `x-tapstall-body` is sent alongside `x-zimlink-body`; `x-tapstall`/`x-zimlink` response headers both carry the version. |
| A Flutterwave payout link | the slug became config (`FW_PAY_SLUG`, default `tapstall`) instead of a string welded to the old brand. |
| `VERSION` | 0.4.3 → 0.5.0: a hostname change is not a patch. |

Two guards were added while doing it, because the dangerous part of a rename is a
step that *succeeds quietly*:

* `kv_id` now searches the new namespace title, then the old one, and creates only
  if neither exists. A miss does not fail, it makes an empty namespace, and the
  deploy would then "work" against a store list with nothing in it. Testing that
  line is exactly how I created an empty `tapstall-stores` — caught it (0 keys),
  deleted it, wrote the guard.
* `deploy.sh` refuses to publish if the resolved STORES id differs from the one in
  `.deploy/state.json`, or if the namespace reports zero keys.

**The KV namespaces keep the titles** `zimlink-stores` and `zimlink-orders`.
Cloudflare refuses a namespace rename — `PATCH /storage/kv/namespaces/<id>`
answers `405 {code: 7001, "PATCH not supported for requested URI"}`, measured
today — and a title is visible to nobody but the deploy script, which binds by id.
So `kv_id` searches both titles, prints which one it settled on and why, and
creates nothing until both miss; the run resolved `b5c1c89d…` (25 keys) and
`4f4ac94a…`, the same ids as always. Chasing the label would be a data migration
wearing a rename's clothes.

Not done, deliberately: `no-reply@simalidudu.workers.dev` stays the send address —
it is what the Email binding will allow, not a brand choice. The orphan namespace
`zimlink-store` (b32c2fe9…) is still there for you to delete. `LEGACY_WORKER_NAME`
is one line to remove once the old hostname stops getting traffic.

## Live right now (measured 2026-10-11, 13:0x UTC — after the KV republish)

The rename is finished on the surfaces, not only in git: the eight pages that were
waiting on the day's write budget are published, and every brand-sensitive path now
answers `0` matches for `ZimLink`. `scripts/prod_check.sh` → **129 passed, 0 blocked,
0 failed** at 0.5.1 — the first fully green stretch of runs (every earlier one had ~15
write assertions the quota turned off).

| What | Where | Proof |
|---|---|---|
| Worker (canonical) | `https://tapstall.simalidudu.workers.dev` | `/__ping` → `{"ok":true,"version":"0.5.1"}`; `/__selftest` → `ok:true`, only `email` false (no SMTP is a choice, not a gap) |
| Brand sweep, served | `/`, `/fees`, `/onboard`, `/ops`, `/s/mamatoe`, `/s/kotaking`, `/a` | `0` matches for `ZimLink` on each, and `0` matches for `*/null` — the literal signature of a config hook nobody filled |
| Titles, as a customer sees them | same seven paths | `Tapstall — a WhatsApp store your customers can actually pay` · `What your WhatsApp orders actually cost you — Tapstall calculator` · `Tapstall — set up your WhatsApp order desk` · `Tapstall Store` · `Tapstall · operator` |
| KV vs git, byte for byte | `tpl:store onboard admin fees index confirm renew ops` | published today: `store 25,301 → 26,714`, `onboard 35,692 → 38,180`, `admin 49,711 → 51,908`, `fees 11,117 → 11,119`, `index 2,997 → 2,998`, `confirm 17,115 → 17,119`, `renew 17,621 → 17,626`, `ops 37,364 → 42,228` — right-hand figures are git's sizes, so served == shipped. `sample-menu.csv` was skipped as identical, which is the same code path a re-run takes |
| Previous hostname | `https://zimlink.simalidudu.workers.dev` | same build. `/`, `/fees`, `/onboard`, `/ops`, `/s/mamatoe`, `/a?code=…`, `/c/abc`, `/renew/x` → `301` to the canonical origin with the **query preserved**; `POST /api/login`, `/api/order`, `/api/lookup` → `401`, `422`, `404` — answered by the app, never bounced, because a rename must not eat a request body |
| Operator console | `/ops` | served copy is the renamed one; a live `tp_ops` cap reads `/ops/api/state` → 2 stores, 0 attention, no `admin_token`; the same cap under **`zl_ops` → 200**; login sets `tp_ops` and clears `zl_ops` |
| Merchant API | `/api/admin?handle=mamatoe` | `200` with 22 orders, `via:"key"`, under **either** `x-tapstall-admin` or `x-zimlink-admin`; no header → `401` |
| Markets & rails | `/rails`, `/ops/api/rails` | 9 built-in + 0 added = 10 live; `401` anonymous, `422` for a label-less rail; `rail_catalogue_ok`, `rail_custom_ok`, `rail_price_with_own` true |
| Landing + calculator mirror | `https://king-kunta-cpu.github.io/tapstall/` | `/` and `/fees` 200; `index.html` 2,998 B and `fees.html` 11,119 B **byte-identical to git** (CI copies them into the artifact, so the mirror cannot carry a stale draft). The old `…/zimlink/` path is `404`, which is why `PAGES_URL` and `REPO_RAW` moved in the same release |
| Mirror sign-up link | `/tapstall/onboard` | `200` on both `onboard` and `onboard.html`, handing off to `…workers.dev/onboard` and keeping the query string. It was `404` until today — see the mirror paragraph below |
| Alias cron | `/__selftest` on each origin | canonical `cron_owner:true`, alias `cron_owner:false`: the alias still *carries* the inherited schedule (this token cannot delete one) and ignores it in code, so one KV is swept once a day |
| Demo tenants | `/s/mamatoe`, `/s/kotaking` | 4 products from each store's own CSV; `config.json` carries `rail_info`; `feed.json` 200 |
| CI/CD | `.github/workflows/deploy.yml` | run #32 `success` on both jobs at 0.5.0: tests → templates → Worker → **alias Worker** → cron → Pages (`deploy-pages` failed three times on GitHub's side with *Fetching artifact metadata failed*; a `rerun-failed-jobs` call is the whole fix) |

## "Nothing loads" on the merchant dashboard (2026-10-11, 0.5.1)

Reported while opening the tenant dashboard as a client. Measured in order, because
that sentence fits three different failures:

| Probe | Answer |
|---|---|
| `GET /a` | 200, 51,908 B; every id `boot()` touches exists, so the script does not throw |
| `GET /a?handle=mamatoe&token=<legacy>` | `302` to `/a?code=v1…` — a pre-cap link trades itself for a fresh one |
| `POST /api/login {code}` | 200 `{ok:true, valid_for_sec:43200}`, `tp_sess` set, `zl_sess` cleared |
| `GET /api/admin?handle=mamatoe` with that cookie | 200, 23 orders, 27 editable fields, not suspended, `paid_until` 2026-12-08 |
| `king-kunta-cpu.github.io/tapstall/a` | **404** — the mirror hosts `index`, `fees` and the `onboard` handoff, nothing else. A dashboard link opened *from the mirror* is the one way to get a genuinely empty screen |

The dashboard opens. What did not work was **one panel inside it**: "this is your
store" is `<iframe id="shareFrame">` pointed at `location.origin + '/s/' + handle`, and
every response inherits `X-Frame-Options: DENY` + `frame-ancestors 'none'`, the
storefront included, so the browser refused to paint it — a blank white box on every
device for as long as the feature has existed. `FRAMEABLE` now allows same-origin
framing on `/s/*` alone, derived from `SEC_HEADERS` rather than copied, and `/a`,
`/ops`, `/onboard`, `/fees`, `/__selftest`, `/rails` keep refusing all framing.

The fix then found the quieter bug. `hdr()` spread `SEC_HEADERS` in its original casing
and merged overrides lower-cased, so the response carried `X-Frame-Options: DENY`
**and** `x-frame-options: SAMEORIGIN`; `Headers` joins same-name values, so the storefront
answered `DENY, SAMEORIGIN` — and two CSPs are *intersected* by the browser, the stricter
winning. No per-route override had ever been able to replace a security header, which
is also why the fix could have shipped looking like a policy that ignores its own
exception. `hdr()` lower-cases both sides now, so an override replaces.

`prod_check.sh` asserts the pair (storefront frameable, exactly one policy, `/a` still
DENY) and the suite pins both ends: no joined header values, and the iframe's `src`
beside the exception. That pairing is the point — if the preview ever embeds a
different path, the framing exception stops being a feature and becomes a hole.

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
curl -s https://tapstall.simalidudu.workers.dev/__selftest | jq .cron_heartbeat
```

`minutes_ago` should be under ~365 after 06:15 UTC and never reset by a deploy.
If it reads `never run` long after that, set the trigger once in
Workers & Pages → zimlink → Settings → Triggers → `15 6,12,18,0 * * *`
(you may delete it; nothing depends on it being gone, because the code ignores it
while `REDIRECT_TO` is set — `/__selftest` answers `cron_owner:false`).

The mirror has one defect class the Worker cannot cover for it: a link that resolves
because a *server* implements it. `pages/public/_redirects` said
`/onboard  /onboard  200`, which is Netlify syntax — GitHub Pages uploads files and
rewrites nothing, so the landing page's "Open the store builder" button 404d from the
mirror while working fine on the Worker. Nobody could see it: the Worker serves `/`
from a KV template, and the deploy only checked the mirror's status code for `/`. Now
`pages/public/onboard{.html,/index.html}` is a handoff that redirects to the origin
with the API (query string kept — an invite link may carry a code), `_redirects` is
deleted, and `tests/pages.test.mjs` resolves every internal link in the mirror's pages
against the actual artifact set. The artifact set is assembled by CI (`cp
pages/index.html pages/fees.html pages/public/`), so the mirror cannot carry a stale
draft of a page the Worker serves — the two copies had been kept identical by hand, and
still are, but now there is only one source.
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

## The first real capacity event (2026-10-10, ~10:50 UTC, shipped as 0.4.1)

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

## Rails became data, not code (2026-10-10, v0.4.2)

The market question came back a third time — "everyone using WhatsApp for
business who cannot reach take.app: geography, payment methods, the lot". A
name does not fix that; a table in `core.js` was the thing making the product
Zimbabwe-shaped. So the table stopped being the answer.

Now true:

* `GET /rails` = built-ins ⊕ `rails:extra` in KV ⊕ `custom`. Pickers read it,
  so a method is live for the next buyer without a deploy.
* Ops console → *Templates* → **Markets & rails**: add/edit/remove through
  `GET|POST /ops/api/rails` behind the same session and the same second click as
  every other lever. Refuses to override a built-in key; refuses to remove (or
  restore away) a rail a store is still using and names the handles.
* A merchant can describe their own method in onboarding or in Store settings
  (`rail: custom` + `rail_def`), which is a money-class field: 15-minute hold,
  cancellable, public by design because the buyer reads it.
* Validation is shared (`normaliseRail`): label ≥ 2 chars, `pct`/`imtt` clamped
  to 30%, `fixed` ≤ 1000, `type ∈ manual|auto|cod`. An invalid description at
  sign-up degrades to `cash` — wrong-but-safe beats a wrong amount.
* `/s/<handle>/config.json` now carries `rail_info` (the *resolved* rail) and the
  storefront prices from it, so the cart preview and the printed slip cannot
  drift apart. Orders still snapshot the rail into `pay`, so deleting a rail
  never changes a receipt already sent.

What the new tests caught, in order of embarrassment:

1. The catalogue's `custom` placeholder shadowed the store's own description, so
   every self-described rail priced at 0% under the label *we* invented.
   Resolution order is now store-document-first for `custom`.
2. `Math.round(subtotal * rate + fixed * 100) / 100` — precedence. It divided
   every per-payment fixed fee by 100 in the storefront preview and the
   onboarding estimate. Written as a test against the worker's own `priceOrder`
   before it could ship.
3. Moving the unknown-rail rule from `SET.rail` into the caller kept the product
   correct and broke two contracts: the per-field `422 {fields}` shape the
   dashboard renders and the `/__selftest` assertion. Membership is now checked
   inside `validateSettings` via `opts.rails`.

`node --test tests/` is 88 (was 81): +1 rails catalogue/merchant path, +1
self-described rail, +1 preview-matches-receipt, +1 who-can-see-what, +1 quota
wording per reader, +1 selftest-under-quota, +1 the single verdict.

Then CI taught two more lessons on the live deploy (run #22 red, #23 green):

* `kv_put_tpl`'s new quota branch never fired in CI, because `str(HTTPError)` is
  only `"HTTP Error 429: Too Many Requests"` and Cloudflare's `10048` / "free
  usage limit" sentence is in the **body**. So the release was held up by a page
  nobody was waiting for — the exact thing that change was written to prevent.
  The publisher now reads the body, treats 429 as quota, warns with both byte
  counts, and lets the Worker deploy. Verified against a real refusal, not a
  mock: `store NOT PUBLISHED … (26159 bytes in git, 25301 in KV)`.
* `/__selftest` had no verdict at all, and its KV write probe threw straight
  through the fetch handler, so on a quota day the endpoint that explains
  outages *became* one: `{ok:false, error:…, who:"operator"}` and nothing else.
  It now catches the probe, reports `kv_write_blocked` with a clock, keeps the
  other thirty answers, and returns one `ok` computed last over every boolean
  (capability flags — `kv_stores`, `kv_orders`, `email` — listed as such, so a
  missing optional binding is not an alarm). Adding that verdict immediately
  caught `rail_catalogue_ok`, which asked whether `{rail:"cash"}` came back as
  `test_momo`: impossible by construction, red in production for a day.
  `prod_check.sh` follows the same rule — it drops the one assertion that needs
  a write, says why in one yellow line, and still checks every read-side claim.

Then it found a live one (0.4.3). `prod_check` on the quota day failed 17
assertions, and 15 of them were the plan, not the build — so `ck()` now reports a
quota answer as `blocked by the day's KV budget` in its own colour instead of red,
which left the two that were real:

* **two read paths required a KV write.** `getStore` persisted the matured
  pending fold and `loadProducts` persisted the menu cache. Consequence: a
  merchant whose 15-minute hold matures after the budget runs out makes *every*
  storefront read a 503 until midnight, and a buyer who only wanted to see the
  menu got one. Both writes are now best-effort (the fold is idempotent; the
  next read folds again from the same block). Caught by the run, fixed with
  tests that were then reverted to prove they bite: `not ok` ×2 without the
  fix, 10/10 with it.
* **`/ops/logout` promised something it could not do.** `endOpsSessions` swallowed
  its own error, so on a spent budget the reply still said "every console session
  is ended now" while a stolen cookie stayed valid for up to 12 hours. It now
  answers `sessions_ended:false` with the exposure window and the next action,
  and `prod_check` accepts either the 401 or that sentence — never silence. `scripts/
deploy.sh --check` also stopped depending on exec bits (`python3 scripts/ui_kit.py`,
`bash scripts/build_bundle.sh`) because a checkout can lose them and a dry-run
gate must not be the thing that breaks.

The name is still ZimLink, deliberately: the human-visible strings are catalogued
(page titles and chrome on five pages, `/fees`, `/`, one mail subject, one ICS
`PRODID`, one store notice) but `WORKER_NAME`, `PAGES_URL`, `REPO_RAW`, the
`zl_*` cookies and the five `/*__ZIMLINK_*__*/` markers are load-bearing across a
deploy boundary and stored absolute in every tenant document. Renaming the brand
and renaming the hostname are two different operations and the second one strands
every link already sent to every merchant. Say the word and it is an afternoon.

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
