# The Selling Rail — can we build and monetise a parallel payment rail?

**Verdict: yes — if we sell the rail and never become the custodian of the money.**

That single sentence decides whether this is a three-week build on Cloudflare Workers or a
three-year licensing project with capital we do not have. Everything below hangs off it.

---

## 1. What we are actually proposing to sell

There are three completely different businesses hiding inside the phrase "payment rail":

| Lane | What it means | Who holds the licence | Can we do it now? |
| --- | --- | --- | --- |
| **A · Selling rail (software)** | Take the order, price it, present the right rail, allocate an exact amount, capture proof, verify it, reconcile it, produce a settlement statement. Funds move **buyer → merchant** directly (mobile money, bank, processor). | Nobody — we are software. | **Yes, on what already exists** |
| **B · Aggregation (partner)** | Become the distribution face of licensed processors per region (Paynow, Ozow/Stitch, Paystack, Xendit, Paytabs…). They hold the licence, we hold the merchant. | The processor | Yes, but only with signed partner agreements |
| **C · Custody (a real rail)** | Hold funds, hold balances, convert FX, pay sellers out. | RBZ (ZW) · FSCA/FIC (SA) · CBK (KE)… capital, audits, fit-and-proper tests | **No.** Not this year, probably not ever solo |

Tapstall today is already deeper into Lane A than "one rail": `worker/core.js` carries **eleven
rails** (EcoCash USD/ZiG, InnBucks, OneMoney, ZIPIT/RTGS, PayShap, Ozow, PayFast, cash,
**USDT on Tron**), a KV-extensible rail table (`rails:extra`) so an operator can add M-Pesa, GCash,
bKash, Yape or Nequi without a code change, unique-amount allocation in production, a **free
TRON watcher** that re-verifies every credit against TronGrid instead of trusting a pasted TxID,
and the OpenRail 1% stablecoin tolerance adopted verbatim. What it does **not** have is the
**settlement layer**: a statement the merchant can trust, matched against their own money, and a
bill for the rail work.

The market gap is **not checkout** — Paynow, Ozow and Flutterwave already exist, badly but
existently. The gap is:

> **the last mile between "an order exists" and "the money has been identified, matched to that
> order, and the seller can prove it to their accountant."**

That mile is where shops lose hours, where fake proofs live, and where every US-centric tool is
blind because it assumes a card payment with a chargeback machine behind it. Nobody in our
markets has that machine. **Proof-first reconciliation is the product.**

Our honest market line: *not* "we replace Stripe". It is "we make the rails you already have
behave like a commerce system, and we add the one leg US providers deny you — collection from
anywhere."

---

## 2. The assets we already hold (this is why it is a shot, not a fantasy)

| Asset | Where it lives | What it gives the rail |
| --- | --- | --- |
| Eleven rails + unique cents, in production | `tapstall/worker/core.js` (`RAILS`), live shops | The reconciler, already used by real orders |
| Custom rails from KV, so a new country needs no deploy | `rails:extra` | Every one of the six regions becomes a data row, not a release |
| USDT/TRC-20 watcher with TronGrid re-verification | `worker/worker.js` (`tronUsdtTransfers`, `tronTxOk`) | The crypto leg already exists, licence-free and free per call |
| Proof capture with caps, one field, on the receipt | `store.html` (`/api/proof`) | The buyer-side loop, already tested |
| Order records, CSVs, receipts, 7 storefront rhythms | Tapstall KV + pages | Merchant base + the surface rails get sold from |
| **NOWPayments invoice + IPN with 7 guards** (re-deposit, idempotency, API re-verify, amount, asset, price-lock, rate-limit) | `OpenRail`, `CoreMerch` attachments | The **cross-border collect leg**, already engineered |
| Productised pricing discipline ($47 / $197 / $497) and delivery emails | `CoreMerch` | A proven shape for productising each rail pack |
| A content/digest engine + social mesh | `COREMERCH WEEKLY DIGEST`, studio | Distribution — the actual bottleneck |

What we do **not** have, and must build before charging anyone:
a ledger, a multi-rail abstraction, a merchant vetting flow, a refund/dispute path, settlement
statements, and partner agreements. Those are the 80% of rail work that is not code.

---

## 3. Three products, in the order I would ship them

### 3.1 · **Settle** — the selling rail sold to shops (ship first)

Tapstall's rail layer, productised: multi-rail invoice, exact-amount allocation, proof capture,
verification, day-statement, CSV export.

- **Rails in v1:** EcoCash, InnBucks, PayShap, ZIPIT, bank transfer, cash-on-collection, and the
  crypto collect leg (see 3.3).
- **Pricing:** free tier keeps the current one-rail behaviour. **Pro $19/month** for: unlimited
  rails, settlement statement, refund/dispute log, multi-user, and 200 verification credits a
  month; **$0.10 per verification after that**.
- **Why flat per-verification and not a % of volume:** a percentage of money moved is what a
  payment service charges. A flat fee per document verified is what software charges. Same
  revenue shape, radically different regulatory character. Keep it that way.

### 3.2 · **Rail-as-a-service** — white label for agencies (ship second, this is the money)

Web designers, WhatsApp-marketing agencies, POS resellers and e-commerce hosts already own 20–80
merchants each and have no way to give them a working order rail. We sell them the engine:

- Their own subdomain and brand, merchant onboarding, our reconciler underneath.
- **$149/month per agency** + $29 per active merchant seat, or a flat $299/month unlimited.
- One agency = 20–80 merchants we never have to acquire ourselves. **This is the leverage that
  makes a small team matter** — we sell to the people who already sell.

### 3.3 · **Cross-border collect leg** — the actual "parallel rail" (ship with Settle)

For the seller who cannot get a Stripe or a PayPal: an invoice the buyer can settle from anywhere
(crypto via NOWPayments, and local rails where we have them), with the seller paid out by the
processor in their own account. The CoreMerch/OpenRail code already does the hard part.

For breadth beyond Tron (300+ assets, other chains, fiat on-ramps) NOWPayments is the
processor; for the one chain we already watch, the TRON path needs nobody but us and TronGrid's
free API.

- **Pricing:** $2.50 flat per cross-border invoice, or 1.5% (min $1) on large ones.
- **Why this is legitimate without a licence:** NOWPayments is the regulated counterparty for the
  crypto leg and the merchant of record for the processing. We are invoicing software. The moment
  we hold a balance or pay a seller out ourselves, we are back in Lane C and the answer is no.
- **What we must add:** sanctions/PEP screening at onboarding, a written refund policy, five-year
  records, and a per-jurisdiction note on what the *seller* must declare. Cheap to write, not
  optional.

---

## 4. Unit economics (the honest version)

Full model, with editable assumptions: **[`RAIL-ECONOMICS.xlsx`](../RAIL-ECONOMICS.xlsx)** (sheet
*Model*). Three scenarios, monthly, USD:

| Line (Base scenario) | Assumption | Monthly |
| --- | --- | --- |
| Settle Pro subscriptions | 180 shops × $19 | **$3,420** |
| Verification credits | 180 shops × 85 credits × $0.10 | $1,530 |
| Agency licences | 12 agencies × $149 | **$1,788** |
| Agency merchant seats | 12 × 15 seats × $29 | **$5,220** |
| Cross-border collect leg | 3,000 invoices × $2.50 | $7,500 |
| **Gross** | | **$19,458** |
| Costs (infra, support, 2% goodwill) | | $521 |
| **Net** | | **≈ $18,937 / month → $227k a year** |

Conservative (60 shops, 3 agencies, 300 cross-border invoices): **$2.5k net a month**.
Stretch (450 shops, 30 agencies, 9,000 invoices): **$61k net a month**.

**Read it the right way:** plan the business on the bolded lines — subscriptions, agency licences
and seats — which are **$10,428 of the $19,458** and the only part that does not depend on volume
we have never seen. Credits and cross-border invoices flatter the picture and should be treated as
upside. **Platform costs are covered by the third paying shop**; roughly 40 shops plus 3 agencies
is a modest income, and 180 shops plus 12 agencies is a real business.

Against that: **a licensed PSP doing the same thing needs $250k–$1M in capital and 18–30 months
of regulatory work.** Our version needs Cloudflare, a ledger, and distribution. That asymmetry is
the whole opportunity.

## 5. The five things that kill rails — and what we do about each

1. **Float temptation.** The day a balance appears on our side, we are a money remitter. Rule:
   *no balance ever.* Funds go buyer → merchant or buyer → processor → merchant. Encode it: no
   wallet, no payout button, no "top up".
2. **Reference collisions and reuse.** Unique cents only work if allocation is stateful: TTL,
   collision retry, a reuse window, and a hard "one live reference per order" rule. This allocator
   is our real IP — build it once, well, with tests.
3. **Settlement ambiguity.** A buyer's screenshot is not money. Until we read the merchant's own
   statement (upload) or a partner API confirms it, "verified" means *verified against what we were
   shown*, and the product must say exactly that. Never display "paid" — display "matched /
   awaiting statement".
4. **Fraud in a no-chargeback world.** Our gift: proof-first design. Add velocity limits, device
   notes on risky cash orders (Tapstall already flags), and a one-tap "hold" for the merchant.
5. **Trust.** A rail without a written policy is a hobby. Before the first paying agency: a
   four-page compliance pack — data handling, records retention, refunds, sanctions screening,
   what we do and do not do with money.

And the sixth, which is organisational: **six regions is a slide, not a plan.** We serve Zimbabwe
and South Africa first because we can name the rails, the banks and the merchants. Zambia, Kenya,
Nigeria and the Gulf follow as *partner-led* lanes at Lane B, not as our own licences.

---

## 6. Ninety days

**Days 1–14 — foundations (I can build most of this now)**
- Rotate every credential in the attachments (see the warning at the bottom — today).
- Write the "software, not custody" policy and the one-page merchant rail policy.
- Ship `worker/rail.js`: rail registry, reference allocator (KV + TTL + collision retry), payment
  intent, proof verification, day-statement ledger, CSV. Behind a flag.
- Ship `/s/<handle>/settle`: today's money in, matched, unmatched — the merchant's morning page.

**Days 15–45 — pilots**
- 10 pilot shops on 2+ rails each; instrument verified %, time-to-verify, unmatched rate, disputes.
- Merchant statement upload → reconciliation (closes loop 3 without a partner).
- Cross-border leg lit for 3 sellers outside ZW/ZA, with sanctions screening.

**Days 46–90 — the agency product**
- White-label shell (agency subdomain, their brand, merchant seats, billing).
- Sign 2 agencies in Harare/Johannesburg; move them from pilot pricing to $149.
- Publish the settlement statement as the thing agencies show *their* clients. That artefact is the
  sale.

**Kill criteria, written now so they are not negotiated later**
- <30% of pilot orders verified within 24h after 60 days → the pain is not where we think it is;
  drop Settle and sell the agency product only.
- No agency signed by day 90 → distribution assumption is wrong; stop building and go sell for a
  month.
- Any feature that requires custody → cut the feature, not the rule.

---

## 7. What I think, plainly

**The opportunity is real and the wedge is unusually good**, because the reconciliation layer is
the part everyone skips and it is exactly what we already ship. The **crypto collect leg is the
genuinely novel piece** — the one thing a shop in Harare or Bogotá can use that a US processor will
never give them — and the attachments show it is already engineered to a decent standard
(7-guard delivery, IPN re-verification, price lock).

**The risk is not technical, it is characterological.** Rails fail by drifting: first a float
account "just for speed", then a payout button "just for the big client", then a licence
conversation we cannot afford. The rule in section 1 is the business model, not a compliance
footnote.

**And the real bottleneck is distribution, not code.** We can build this in weeks. Getting 180
shops and 12 agencies to pay monthly is the actual work — which is why 3.2 (sell to agencies) is
the second ship, not a later nice-to-have.

---

## 8. Warning about the attachments

All five files contain **live secrets in plaintext**: two different NOWPayments API keys and IPN
secrets, a Discord webhook URL, a Google Apps Script endpoint, plus a list of real payout wallet
addresses. Uploaded into a chat, that is the same as posting them.

- **Rotate the NOWPayments API keys and IPN secrets today**, and recreate the Discord webhook.
- CoreMerch already does the right thing (`PropertiesService`); OpenRail and Unchained do not —
  move their secrets into properties and delete them from source, exactly as CoreMerch's setup
  notes say.
- Treat the wallet addresses as public (they are), but check that no key with *withdrawal* rights
  was ever pasted into a client-side file or a repo.
- Nothing in these notes was copied into this repository; I read them, I did not restate them.
