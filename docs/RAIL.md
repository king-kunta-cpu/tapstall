# The rail — what Tapstall does with money, and what it never does

*Written for the person who has to answer a regulator, an accountant, or a merchant who asks the
obvious question: "if I use this, where does my money sit?" The answer is the same in every
version of this document: **it does not sit with us.***

## The one rule

> We do not hold, move, pay out, convert or lend money. Not for a merchant, not for a buyer, not
> for an agency, not "just while the settlement clears". If a feature cannot be built without
> holding a balance, the feature is cut and the rule stays.

This is not a marketing position. It is a constraint on the code: `worker/rail.js` has no payout,
balance, withdraw or transfer verb, and a test fails the build if one appears. The settlement
statement reconciles two things it is allowed to know — what the order book expected, and what the
shop recorded as received — and never claims to know anything about a bank account it does not
control.

## What the platform actually does

| It does | It does not |
| --- | --- |
| Reads the order book (what buyers owed, per rail) | Take the buyer's money |
| Records what the shop says arrived, with a reference | Verify a bank balance |
| Keeps the two apart, per rail, per day, per month | Net them into a "balance held" |
| Issues a settlement statement and a CSV | Pay the merchant, or anyone else |
| Allocates an odd-cent reference so a payment can be matched | Clear, settle or net across rails |
| Runs a vetting checklist before a cross-border leg | Convert currency or quote an FX rate |
| Keeps records for five years | Hold a float, an escrow or a reserve |

Every rail on a statement paid the shop **directly**. EcoCash pays the merchant's wallet. A bank
transfer lands in the merchant's account. Cash is in the merchant's hand. Tapstall's own revenue is
a subscription paid to Tapstall — never a share of what a shop sells, and never a slice of the
payment as it passes (it does not pass).

## Why the money flow is shaped this way

1. **The markets decide it.** Most of the rails that matter here (EcoCash, InnBucks, ZIPIT, PayShap,
   Ozow, cash on delivery) do not offer a small platform a custodian relationship. A design that
   needs one is a design that does not ship in Harare.
2. **A licence would have to be bought, then defended.** Holding client money means a licensing
   regime, capital requirements, audits and a reporting calendar, in every market, forever. That is
   a different company, and it would make the subscription more expensive for a shop selling eight
   orders a day.
3. **The merchant's risk disappears with it.** A merchant's money never depends on our uptime, our
   bank, our processor or our honesty. If Tapstall went dark tomorrow, every shop would still have
   its cash, its wallet and its statements (CSV, downloadable, no login needed to keep a file you
   already saved).

## The three sentences we never blur

1. **"Matched" is not "paid".** A matched row means the shop recorded a payment against an order.
   It is the shop's own statement of fact, not our confirmation of a bank balance. The statement
   says this on its face, and the partner page repeats it, because an agency will be asked.
2. **"Expected" is not "owed".** It is what the order book says buyers were asked to pay, including
   any charge the shop added. A cancelled order leaves the expected figure; a written-off one is
   named as written off.
3. **"To chase" is the only number that asks for action.** Money the book expects that the ledger
   has not matched. Negative means the opposite — more arrived than the book knows about — and that
   is also worth a minute, not a celebration.

## Cross-border collect (the crypto leg)

Where a shop sells to a buyer outside its own payment rails, a processor can be used to collect.
That leg is built to the same rule:

- The **shop** names the receiving address or account. Tapstall does not hold the asset at any point.
- The invoice is a price lock with a tolerance, not a promise of an exchange rate.
- A webhook from the processor **writes a ledger event, never a payment**: the shop still closes the
  order, and the money is already where the shop said it should go.
- An underpayment is never reported as paid. It is a shortfall with a number attached.
- The legs are dark until the shop's vetting is complete (identity, contact, sanctions). A rail
  without vetting is a rail we refuse to switch on, and the API says `503` or `409` rather than
  pretending.

## Records

- A statement is retained per shop per month, and rows are kept for **five years** (`retentionUntil`).
- The CSV export is deliberately plain: shop, window, rail, orders, expected, matched, unmatched,
  refunded, disputed, fees, net — the columns an accountant asks for, in the order they ask for them.
- A refund or dispute moves through a state machine that cannot skip states; the record of who
  changed what is kept.

## What an agency is told, in one paragraph

You are reselling software that reads and reconciles. Every payment your merchants take lands in
their own wallet, bank or hand — never in ours, never in yours. You are not a payment intermediary
because of this platform, and neither are we. The thing you sell is the statement: expected,
matched, to chase, per rail, per day, printable and exportable. That is the whole product.

---

*If a future feature needs custody, this document is the answer: cut the feature. If the rule
itself ever needs to change, it is an owner decision with a licence attached, and it is written
here first, not discovered in the code.*
