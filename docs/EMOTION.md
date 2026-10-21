# The Emotion Doctrine — Tapstall

Every decision a shopkeeper makes about software is emotional first, and justified with logic
afterwards. This is not a marketing theory we adopt for campaigns; it is the standing rule for
every page, receipt, message and pixel this product puts in front of a human. If a touchpoint
does not *invoke* a true feeling and then *serve* it, it is unfinished, however tidy it looks.

The same doctrine applies twice, to two different people:

- **The seller** — the shop, restaurant, salon, tailor, phone bench, grocery stall that pays us.
- **The buyer** — the person ordering from that shop. We serve the seller's customer as if they
  were ours, because that is the only way the seller's pride survives the transaction.

## The leverage, said plainly

> **Mainstream providers — Silicon Valley first among them — do not want to work with shops in
> our markets. They decline our cards, skip our statutory registries, ignore our money rails and
> price for California salaries. We built this here, for here. To a shopkeeper in Harare,
> Johannesburg or Nairobi we are the only emotional *and* logical choice available — and their
> competitor down the road knows it.**

This is leverage, but it is also literally true in the product: no foreign card needed to run a
shop, no USD subscription that loses 15% in withholding before it leaves the country, EcoCash,
InnBucks, PayShap and ZIPIT understood as first-class rails, a Google Sheet instead of a vendor
database, and a CSV the owner can hand to an accountant without asking us.

## The five levers, wired into Tapstall

### 1. Righteous resentment & sovereign pride — *"They built for Silicon Valley. This was engineered for us."*

- **The wound:** *Card declined. Country not supported. Stripe unavailable. Subscription hit by
  withholding before it lands. Priced for San Francisco.* A shop that sells every day cannot buy
  the software to sell it.
- **How we serve it:** we say it out loud, then remove every trace of it — local rails, local
  currency, one bill a year, no card required to open a shop, and a price a Harare counter can
  absorb (founding annual $60 / $7 a month, ZAR twins).
- **Proof we can actually make:** the pricing page, the rail list on every shop, the reference
  matching that works with a phone screenshot of EcoCash.
- **Where it lands:** landing hero and lever one; `fees.html`; the renewal page's rail list.

### 2. Morning relief — *the 07:00 coffee vs the 40-tab panic*

- **The wound:** the shop wakes up to orders spread across a chat, six "I paid you, look"
  screenshots, an address typed three times, and a pile of unread messages before the first sale.
- **How we serve it:** one link that takes the order complete — items, name, number, address,
  delivery, the exact amount — and a dashboard where the morning is a scan, not a hunt.
- **Where it lands:** landing lever two; onboarding ("Your menu, in your sheet"); the empty-state
  of a new dashboard; the receipt the buyer gets (`Order received — stored with the shop`).

### 3. Territorial urgency — *second place gets nothing*

- **The wound:** in a small market the shop that answers first is the shop that gets paid. The
  competitor two streets away is already replying.
- **How we serve it:** we shorten the distance to "open": 90 seconds to a live store, a price
  change in two minutes from a sheet, orders that arrive already written down.
- **The line:** *"The shops on your street will answer at 16:00, by hand. Yours answers the minute
  the order lands. Which shop do you want to be?"*
- **Where it lands:** landing CTA block, `share.txt`, the onboarding completion screen.
- **The honesty clause:** see below. This lever is the one most easily abused, so it is the most
  tightly bound.

### 4. Ownership & control — *no hostage data, no silent bots*

- **The wound:** black-box tools that hold the client list behind a login, hallucinate in the
  shop's name, or die the day a subscription lapses.
- **How we serve it:** the shop's data lives in the shop's own Google Sheet and the shop's own
  Google account; the CSV is theirs; nothing is posted or sent in their name without the shop
  choosing it; a paused subscription does not delete the menu.
- **Where it lands:** landing lever four; the dashboard's own language ("Your sheet stays the
  base"); the renewal page's "nothing is held hostage" card.

### 5. Reciprocity & status — *give before you ask*

- **The wound:** every other vendor wants a 30-minute discovery call before handing over a shred
  of value.
- **How we serve it:** the store is live and taking orders before a cent is paid; 60 days free; no
  order cap; the buyer's receipt already does real work for the seller on day one.
- **Where it lands:** landing ("Nothing to install, nothing to pay today"), onboarding, and the
  first order's confirmation.

## The buyer's five (the shop's customers)

1. **Relief** — the price is exact, the steps are numbered, nothing needs a card.
2. **Dignity** — "pay from your own wallet" is the sentence; nobody is treated like a fraud risk.
3. **Pride** — the shop looks like its trade (a plate, a lookbook, a shelf), not like generic SaaS.
4. **Reciprocity** — the receipt thanks them with something useful (the reference, the dial code,
   the "welcome back" line) rather than asking again.
5. **Trust that is checkable** — "no screenshot needed" is a mechanism, not a promise.

## The honesty clause (non-negotiable)

Emotion is invoked, never faked. Any touchpoint that breaks one of these is a bug:

1. **No invented scarcity.** No "only 3 left", no fake stock counters, no countdown timers, no
   "27 people are viewing this shop".
2. **No invented social proof.** No testimonials we cannot name, no order counts we did not
   observe, no logos of shops that never joined.
3. **Urgency must be real.** We may say a competitor will answer later; we may not claim one is
   watching this page.
4. **No shaming the buyer.** No "you forgot something", no false deadline on a cart.
5. **Give before asking.** Value lands before the ask, in that order, every page.
6. **Emotion never overrules arithmetic.** Prices, quantities, fees and the exact amount owed are
   the truth, and no copy may soften or inflate them.
7. **The seller's voice, not ours, in the seller's shop.** Our doctrine never puts words in a
   merchant's mouth; we give their shop a better stage, not our politics.

## Where each lever is wired (map)

| Touchpoint | Lever | What the human should feel |
| --- | --- | --- |
| `pages/index.html` hero | 1 | "They were never going to serve me. This one was built for me." |
| `pages/index.html` five cards | 1–5 | "Somebody has been paying attention to my actual morning." |
| `pages/index.html` CTA block | 3 + 5 | "I can be the shop that answers first — and it costs nothing to try." |
| `pages/onboard.html` | 2 + 5 | "This is 90 seconds, not a project." |
| `pages/admin.html` first run | 2 + 4 | "My orders are here, mine, and I can see all of them." |
| `pages/renew.html` | 4 + 1 | "Nothing of mine is hostage; paying keeps the shop open." |
| `pages/store.html` header + shelf | buyer 2, 3 | "This shop is proud and clear; ordering here is safe." |
| `pages/store.html` receipt | buyer 1, 5 | "It is done, the amount is exact, no screenshots." |
| `pages/share.txt` | 3 | "Say this to one person and my shop is in front of their group." |
