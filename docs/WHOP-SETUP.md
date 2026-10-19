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

## 1. The live Whop store (redone 2026-10-19)

The former Forge store is now the Tapstall store. Do not recreate these objects; if a value
below disagrees with Whop, re-read Whop first and update this file in the same change.

- **Company:** `biz_dUYhC6sMZONDgB` — title **Tapstall**, route `tapstall`
- **Store:** https://whop.com/tapstall/
- **Product:** `prod_d31gep8HxEW24` — https://whop.com/tapstall/tapstall/
- **Brand on Whop:** Tapstall logo + cover/social art from `brand/`; card descriptor
  `WHOP*TAPSTALL`; global affiliates **30% enabled**, member affiliates disabled.
- Old Community Content Autopilot product is hidden/retired and its plans are archived;
  its ContentOps webhook is disabled, so Tapstall payments cannot route to the old Worker.

| Plan | Price / term | Plan ID | Checkout |
|---|---:|---|---|
| Annual USD | $60 one-time, 365 days | `plan_LOEvoldSgFUUI` | https://whop.com/checkout/plan_LOEvoldSgFUUI |
| Monthly USD | $7 every 30 days, grants 31 days | `plan_jWquFledgoz6B` | https://whop.com/checkout/plan_jWquFledgoz6B |
| Annual ZAR | R999 one-time, 365 days | `plan_wlkFLUdonWAPN` | https://whop.com/checkout/plan_wlkFLUdonWAPN |
| Monthly ZAR | R129 every 30 days, grants 31 days | `plan_VzCVd0ycxGSJg` | https://whop.com/checkout/plan_VzCVd0ycxGSJg |

Every plan has the required checkout field **“Your Tapstall shop handle”** with placeholder
`e.g. mama-toe (the bit after /s/ in your shop link)`. That answer is the sure activation
path. Each seller still needs a Whop username on their seller record (`whop` field);
Tapstall appends `?a=<username>` to their shops' checkout links automatically.

## 2. The webhook (created disabled — enable only after the v1.1.0 deploy)

Tapstall webhook `hook_lo2v5QyNxqenn` already exists and is **disabled**:

- **Endpoint URL:** `https://tapstall.zlnew.workers.dev/api/hook/whop`
- **API version:** v1; **events:** `payment.succeeded`, `payment.failed`,
  `membership.activated`, `membership.deactivated`, `refund.created`.
- After deploying v1.1.0, copy this webhook's signing secret into `WHOP_WEBHOOK_SECRET`,
  redeploy/confirm the Worker health flag, then enable the webhook. Never commit the secret.

## 3. Configuration (GitHub repo secrets → deploy sets Worker secrets)

Add these under GitHub → tapstall repo → Settings → Secrets and variables → Actions
(the deploy passes only non-empty ones, so unset never wipes what is live):

| Secret | Value |
|---|---|
| `WHOP_WEBHOOK_SECRET` | Signing secret for webhook `hook_lo2v5QyNxqenn` from step 2. Until this exists the endpoint answers **503 — refused**, by design |
| `WHOP_CHECKOUT_URL_ANNUAL` | `https://whop.com/checkout/plan_LOEvoldSgFUUI` |
| `WHOP_CHECKOUT_URL_MONTHLY` | `https://whop.com/checkout/plan_jWquFledgoz6B` |
| `WHOP_CHECKOUT_URL` | Fallback only; leave unset now that annual/monthly are set |
| `WHOP_PLANS_JSON` | `{"plan_LOEvoldSgFUUI":{"days":365,"usd":60,"currency":"USD"},"plan_jWquFledgoz6B":{"days":31,"usd":7,"currency":"USD"},"plan_wlkFLUdonWAPN":{"days":365,"usd":999,"currency":"ZAR"},"plan_VzCVd0ycxGSJg":{"days":31,"usd":129,"currency":"ZAR"}}` |
| `PLATFORM_PAY_DETAILS` | The public text the renew page prints for manual payment, e.g. `EcoCash USD: 077… (Name) · Bank: … · Mukuru: … · USDT (TRC-20): T…` |

The ZAR plans are live on the Whop product page and at the direct checkout links above.
The current Worker renew page consumes the USD annual/monthly env vars; do not invent ZAR
env names unless the Worker is changed to read them.

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
