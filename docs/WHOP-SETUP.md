# Whop setup — cards in, shops switch on by themselves

Whop takes the card money; Tapstall does the activation. The chain is:

```
operator → renew page "Pay and switch on" → Whop checkout (seller's ?a= rides along)
        → card clears on Whop → Whop webhook POST /api/hook/whop (signed, verified)
        → shop found by the handle typed at checkout → term extended, sale + commission booked
        → anything unmatched lands in the nightly exception digest, never guessed
```

No person approves a batch and nobody tops up shops by hand: registration of the webhook *is*
the policy action, taken once below. Manual rails (bank / EcoCash / Mukuru / ZIPIT / USDT) keep
working through the renew page's reference box → `recognise_ref`.

## 1. In the Whop dashboard (owner, once)

1. **Create the product** "Tapstall" under your Whop company (same store as STPi is fine —
   a separate product keeps the money readable). Cover art: `brand/whop-cover.png`,
   avatar: `brand/tapstall-avatar.png`.
2. **Plans** (prices per `docs/PRICING.md`):
   - Annual — **$60 one-time**, and a ZAR twin **R999 one-time**
   - Monthly — **$7/month recurring**, and **R129/month**
3. **Checkout custom field (required, all plans):** label it exactly
   **"Your Tapstall shop handle"**, placeholder `e.g. mama-toe (the bit after /s/ in your shop link)`.
   This answer is how the webhook finds the shop. No field → activation still works via the
   buyer's account email matching the shop's owner email, but the field is the sure path.
4. **Affiliates (Marketing → Affiliates):** set 30% to match the seller promise. ⚠️ Listed
   products are open to Whop's *global* affiliate network at that rate by default — keep it if
   you want strangers selling for the same 30%, or restrict it to your own sellers.
   Each seller needs a Whop username; store it on their seller record (`whop` field) and
   Tapstall appends `?a=<username>` to their shops' checkout links automatically.
5. Copy each plan's **checkout URL** and **plan ID** (`plan_…`) for step 3.

## 2. The webhook (owner, once — after the v1.1.0 deploy)

Whop dashboard → Developer → Webhooks → Create webhook:

- **Endpoint URL:** `https://tapstall.zlnew.workers.dev/api/hook/whop`
- **Events:** payments and memberships (succeeded / went valid / went invalid / failed / refund —
  the Worker routes each kind; endings and failures never book as sales).
- Whop shows the signing secret (`ws_…`) **once**. Keep it whole, prefix included.

## 3. Configuration (GitHub repo secrets → deploy sets Worker secrets)

Add these under GitHub → tapstall repo → Settings → Secrets and variables → Actions
(the deploy passes only non-empty ones, so unset never wipes what is live):

| Secret | Value |
|---|---|
| `WHOP_WEBHOOK_SECRET` | The `ws_…` secret from step 2. Until this exists the endpoint answers **503 — refused**, by design |
| `WHOP_CHECKOUT_URL_ANNUAL` | Annual checkout URL (USD) |
| `WHOP_CHECKOUT_URL_MONTHLY` | Monthly checkout URL (USD), optional |
| `WHOP_CHECKOUT_URL` | Fallback single checkout URL if you only make one |
| `WHOP_PLANS_JSON` | e.g. `{"plan_AnnualUSD":{"days":365,"usd":60},"plan_MonthlyUSD":{"days":31,"usd":7},"plan_AnnualZAR":{"days":365,"usd":999,"currency":"ZAR"}}` — real plan IDs remove all term guesswork |
| `PLATFORM_PAY_DETAILS` | The public text the renew page prints for manual payment, e.g. `EcoCash USD: 077… (Name) · Bank: … · Mukuru: … · USDT (TRC-20): T…` |

Then any push to `main` (or a manual deploy run) arms it. Verify in the owner console →
health → `pipeline.armed.whop: true`, and send Whop's **test event**: it must answer 200
`ignored: test` and grant nothing.

## How matching and money safety work (so support can answer questions)

- **Signature first:** Standard Webhooks HMAC-SHA256 over `{id}.{timestamp}.{body}`,
  5-minute tolerance — the same verifier running live on the sister product's mint.
  Forgery → 401, nothing written.
- **Once only:** deliveries are idempotent on `webhook-id` and on payment ID (40-day memory),
  and the companion `membership.went_valid` that follows a purchase inside 3 days is
  recognised as the same sale, not a second term.
- **Matching order:** checkout handle answer → stored Whop membership ID → buyer email =
  shop owner/notify email. No match → filed under `whop:unmatched:*`, counted in the nightly
  digest's `needs_a_person`. The money is already in Whop; a human matches it in ops
  (extend the right shop), nothing was credited to a guessed shop.
- **Commission:** if the shop's seller has a Whop username (or Whop reports an affiliate),
  the sale is booked `commission_via: whop` — Whop pays the seller after its 30-day hold and
  the owner's board shows it under `commission_whop`, *not* `commission_due`. Manual-rail
  sales remain owner-owed. Never both.
- **Endings:** `payment.failed` is logged only; cancel/invalid marks the shop's Whop status
  (the paid term still runs to `paid_until` — the clock, not the event, ends access);
  refunds/disputes are filed for human review and **never** claw a term back automatically.
