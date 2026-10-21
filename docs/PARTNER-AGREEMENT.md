# Partner agreement — template

⚠️ **This is a template, not legal advice.** It is written so a lawyer in Harare or Johannesburg
can turn it into a signed document in one sitting, and so that nothing in it promises something
the software cannot do. Get it reviewed before the first signature.

---

## 1. Parties

**Tapstall** ("the Platform"), trading as ____________________, of ____________________
and **____________________** ("the Partner"), of ____________________.

## 2. What is being licensed

The Partner may offer the Platform's **selling rail** — storefront, order capture, rail
presentation, payment proof capture and the settlement statement — to merchants under the
Partner's own trading name, on the terms below.

**The Platform is software.** It does not hold, custody, convert, transmit or pay out money. Funds
move directly between a merchant's buyer and the merchant, or between a buyer and a third-party
processor who then pays the merchant. No clause of this agreement creates a balance, a wallet or a
payout obligation on either party.

## 3. Fees

| Item | Fee |
| --- | --- |
| Partner licence | **US$149** per month (or US$299 for the Platform tier: unlimited seats) |
| Merchant seat beyond the five included | **US$29** per merchant per month |
| Cross-border collect invoices | **US$2.50** each, or 1.5% with a US$1 minimum, whichever is greater |
| Pilot | **US$0 for 60 days**, ending on ____________, after which Section 3 applies |

Fees are invoiced monthly in advance. Late payment suspends new merchant onboarding after 14 days
and does not delete any merchant's data.

## 4. What the Platform will do

1. Keep the rail available at no less than 99% monthly availability, excluding scheduled
   maintenance announced 48 hours ahead.
2. Issue a settlement statement per merchant per day, exportable as CSV, for as long as the
   merchant's store exists.
3. Hold merchant data in the merchant's own account and sheet. On written request, hand over a
   full export within 5 business days.
4. Not approach a merchant introduced by the Partner for direct billing for 24 months from
   introduction, where the introduction is recorded in writing (Section 8).
5. Tell the Partner within 24 hours of a security incident affecting merchant data.

## 5. What the Partner will do

1. Present the Platform accurately: it improves rails the merchant already has, and it does not
   replace a bank, a processor or a licence.
2. Complete the merchant vetting checklist for every merchant before enabling a cross-border leg,
   and keep the evidence for five years.
3. Publish the merchant's refund and dispute policy, and point buyers at it before payment.
4. Not resell under any name other than its own, and not represent itself as the Platform.
5. Train anyone selling on its behalf on Sections 2 and 5.1–5.3.

## 6. Money, refunds and disputes

- The Partner does not collect merchant funds, and neither does the Platform.
- A buyer's refund is handled by the merchant, recorded in the Platform's refund path with a
  reason and an evidence reference, and never deleted.
- **There are no card chargebacks on the manual rails.** Where a processor is used, its own dispute
  process applies and the merchant is the party of record.
- Either party may request a written statement of any disputed amount; both will answer within 5
  business days.

## 7. Records and data

Statements, payment events, proof references and refund records are kept for **five years** from
the event and remain available to the merchant and to the Partner for their merchants. Neither
party may use merchant or buyer data for any purpose other than providing the service.

## 8. Introductions and non-solicitation

An introduction is recorded when either party names the merchant and the date in writing (email is
enough). The Platform will not bill that merchant directly for 24 months. The Partner will not
onboard a merchant it first met through the Platform's own outbound for 12 months.

## 9. Term and termination

- Initial term: 12 months, renewing monthly.
- Either party may terminate on 30 days' written notice.
- On termination: merchants choose whether to stay with the Platform directly or leave. No
  merchant is held hostage by the end of this agreement, and their data leaves with them.

## 10. Liability

Each party's total liability is limited to the fees paid in the three months before the claim.
Neither party is liable for indirect loss. Nothing here limits liability for fraud or wilful
misconduct.

## 11. Law

Governed by the laws of ____________________. Disputes go first to a meeting of the two principals
within 10 business days, then to ____________________.

---

**Signed**

Platform: ____________________  Date: __________
Partner:  ____________________  Date: __________

*Annex A — merchant vetting checklist (six items, see `vettingPlan` in `worker/rail.js`)*
*Annex B — the settlement statement sample (the artefact both parties rely on)*
