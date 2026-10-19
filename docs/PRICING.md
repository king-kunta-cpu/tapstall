# Pricing — is $60/year right?

**Verdict: the $60/year annual price is on point for launch; the structure around it was missing a
monthly door.** Keep $60/year as the founding annual price, add **$7/month monthly** (Whop plan),
and mirror them in rand as **R999/year / R129/month** for South African buyers. Revisit the annual
to $79 only with evidence (first ~100 paying shops, churn and support-minutes known), grandfathering
founding shops. The 60-day free period stays: an informal trader needs two month-ends of real
orders before the product has proven anything, and our marginal cost of a trial shop is ~$0.

Note on origin: $60 was **already the codebase's price** (`PRICE_USD` in the Worker) long before
v1.0.0 — it was kept, not invented. What v1.1.0 adds is the monthly plan beside it
(`SUBSCRIPTION_PLANS` in `core.js`) and Whop as the card rail that can actually collect both.

## The anchors (what the same merchant is offered elsewhere)

| Alternative | Price | Note |
|---|---|---|
| WhatsApp Business catalogue | Free | The real competitor: no order management, no payment matching |
| Take App (WhatsApp ordering) | Free ≤50 orders/mo, then **$50/mo** ($37.50 annual billing) | Our "no 50-order cliff" is a direct answer |
| Shopify Basic | $29–39/mo (Starter link-only $5/mo) | Plus gateway fees; built for formal e-commerce |
| Shopstar (SA) | from R220/mo (~$13) | Local, formal businesses |
| **Tapstall** | **$60/year ($5/mo) or $7/mo** | No order cap, no commission, local rails |

$5/month equivalent undercuts every paid anchor while staying credible: priced *below* Shopify
Starter's link-only tier for a full store whose differentiator (unique-amount payment matching on
EcoCash/PayShap) none of them have. Pricing sharply higher now would buy margin we don't need
(hosting is $0) at the cost of the one thing we do need: paying references in a market where the
free alternative is one tap away.

## What a sale actually nets on Whop (the card rail)

Whop card processing is 2.7% + $0.30 domestic, +1.5% international cards, +1% currency
conversion, ~$0.07 Radar; affiliate processing adds 1.25% when a seller's `?a=` link made the
sale. There is no Whop platform/monthly fee. Rounding to the cent that matters:

| Sale | Gross | Whop+card fees | Seller (30%) | **Owner keeps** |
|---|---|---|---|---|
| Annual $60, direct | $60 | ~$2.00 (domestic) – $3.49 (intl+FX) | — | **~$56.50–58.00** |
| Annual $60, via seller `?a=` | $60 | ~$2.75–4.25 incl. affiliate processing | $18.00 via Whop | **~$37.75–39.25** |
| Monthly $7, direct | $7 | ~$0.56–0.73 | — | **~$6.27–6.44** |
| Monthly $7, via seller | $7 | ~$0.65–0.82 | $2.10/mo via Whop | **~$4.10–4.25/mo** |

Two consequences baked into the code:

1. **Commission is never paid twice.** A Whop affiliate sale is settled by Whop to the seller
   (30-day hold). The sales ledger records `commission_via`, and the seller board now splits
   `commission_whop` (Whop carries it) from `commission_due` (the owner still owes it — manual
   bank/EcoCash/Mukuru/USDT sales). `commission` remains total earned so old totals reconcile.
2. **Monthly's fixed $0.30/transaction fee bites small tickets** — monthly is a cashflow door,
   not the profit door. That's intended: it catches merchants who cannot do $60 once, and the
   annual discount (~29%) is the nudge to migrate them.

⚠️ **Whop global affiliates are on by default at 30%** once a product is listed — meaning
strangers in Whop's network can also promote Tapstall for 30%. Decide deliberately in the Whop
dashboard (Marketing → Affiliates): keep it as a growth channel (same 30% your sellers get), or
restrict it so only your own sellers' `?a=` usernames ever earn. Nothing in Tapstall assumes
either way; the ledger records what Whop reports.

## What to create in Whop

See `docs/WHOP-SETUP.md`. Products/plans: Annual USD $60 one-time (366-day access language is
Whop's; Tapstall grants 365), Monthly USD $7 recurring, and ZAR twins R999 / R129. Each checkout
must ask **"Your Tapstall shop handle"** as a custom field — that answer is how automated
activation finds the shop.

## When to raise

Raise annual to $79 when (a) ≥100 paying shops, (b) trial→paid conversion is measured (not
guessed), and (c) support load per shop is known. Announce founding shops keep $60 for as long as
they stay subscribed — in this market, a price promise kept is marketing that compounds.
