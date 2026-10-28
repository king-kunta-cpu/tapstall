# Selling TapStall — the seller guide

You sell TapStall. TapStall gives a small operator an online shop on their phone: a link they share,
a menu they edit, orders that arrive with a payment amount nobody can fake, and confirmation in one
tap. They pay $60 a year after 60 free days. You earn 30% of every sale attributed to you. This guide
is everything you need; if something is missing, ask the owner — do not improvise numbers.

## Your three things

1. **Your code** — e.g. `tino-sells`. It is how the system knows a shop is yours.
2. **Your key** — shown to you once, when you were registered. It opens your seller view and your
   lead queue. Treat it like a bank PIN: never share it, never put it in a screenshot. If it leaks,
   tell the owner the same day; they rotate it and the old one dies instantly.
3. **Your links**:
   - Short link: `https://tapstall.zlnew.workers.dev/r/tino-sells` — goes straight to sign-up.
   - Story link: `https://tapstall.zlnew.workers.dev/g/tino-sells` — goes to the homepage first
     (use this for someone who has never heard of TapStall).
   - Your seller view: `https://tapstall.zlnew.workers.dev/api/seller?code=tino-sells&key=YOURKEY`
     — save it as a bookmark. It shows your shops, your sales and what you have earned. Honest
     warning: it shows raw text (JSON), not a pretty page. Read the numbers; that is all you need.

A shop that signs up through your link is yours **for life of that shop** — renewals included. A shop
that signs up without your link is not attributed to anyone, and it cannot be moved to you later.
So: always send YOUR link, never the plain homepage address.

## Who to sell to

Operators already selling on WhatsApp or Facebook who live inside this loop: a customer messages, the
operator replies with a price, the customer pays "somehow", then sends a screenshot as proof, and the
operator cannot tell real payments from fake ones or match them to orders. Kota stands, takeaways,
bakers, clothing sellers, anyone taking EcoCash/PayShap against screenshots. If they say "WhatsApp
to order" anywhere, they are your person.

Skip: formal businesses with a till system and card machine that works, and anyone who needs
delivery tracking or card payments on the shop page (TapStall takes payment to the operator's own
rail — EcoCash, PayShap, bank, USDT — never holds their money).

## The pitch, in order

1. **Name their pain first.** "How do you know a proof-of-payment screenshot is real?" Let them talk.
2. **The fix.** Every order on TapStall gets its own exact amount — odd cents — so when $23.47 lands
   in their EcoCash, they know which order paid. No screenshots to argue about.
3. **Their money, their rail.** Customers pay their EcoCash/PayShap directly. TapStall never touches
   the money and never takes a cut of their sales. Flat $60 a year, that is all.
4. **One link.** They share one link — WhatsApp status, Facebook, a printed QR at the stand. The
   menu is on their phone; they change prices any time.
5. **The offer.** 60 days free, no card. Sign up now on your link, put five items on today, share
   the link tonight. If it does not bring orders in 60 days, they have lost nothing.

Never promise: card payments, delivery, "we bring you customers", or a refund policy that is not
yours to give. One oversold promise costs more than ten lost sales.

## The 5-touch week

Most operators need five small touches, not one big pitch:

- **Day 0:** Sign them up on your link, in person if you can. Watch them add the first item.
- **Day 1:** Send them the operator guide. Ask: "Did you share your link?"
- **Day 3:** Visit their shop link yourself. Place a test order if they agree — seeing the
  odd-cents amount and the confirm tap once teaches more than any talk.
- **Day 5:** Check their menu has prices and at least five items. A thin menu is the main reason
  trials die.
- **Day 7:** Ask for their first real order story. If they have one, ask them to put the link in
  their WhatsApp status that day.

## Leads assigned to you

The system hunts for operators selling the hard way and assigns each prospect to exactly one seller —
sometimes you. Your queue:

- In your seller view: `lead_counts` shows how many are waiting at each stage.
- On the **leads desk** (`/leads` on the Tapstall site): sign in with your seller code and key. Each
  lead has a WhatsApp button with an opening message already written (your `/r/` link included), a
  call button, and the buttons below. Tabs show what to work today and which follow-ups are due.
- Rules that protect you: a lead assigned to another seller **cannot** be taken by you (the system
  refuses), and yours cannot be taken either. One voice per prospect — ever.
- Work them in order: **claim** when you start, **contacted** when you have messaged/called,
  **replied** when they answer, **trial** when they sign up, **closed** when they pay.
- If someone says "stop contacting me" — mark **dnc** immediately. That writes them onto a list the
  system never hunts again. South African law (POPIA) and basic decency both require it, and the
  system makes it permanent.
- Contact facts in a lead came from the prospect's own public page. Use them for one honest
  business approach, not for anything else.

A claimed lead that sits untouched is visible to the owner in the nightly report. Claim what you
will work this week.

## Money

- When a shop of yours pays, the sale and your 30% are recorded automatically — by the payment
  webhook, or by the owner recognising the operator's payment reference. Your seller view shows
  `sales`, `revenue` and `commission_due` — that number is the ledger, not an estimate.
- Payouts are arranged with the owner outside the system (bank/EcoCash), against that ledger. If a
  number looks wrong, screenshot your seller view (crop out the key in the address!) and send it.
- A shop in its 60 free days shows under `trial`, not `paying`. Your commission lands when they pay,
  not when they sign up — so the 5-touch week is how you get paid.

## When something breaks

- Your link goes to plain sign-up without your code → your seller account may be inactive. Ask the
  owner.
- Seller view says "seller key required" → the key in your bookmark is wrong or was rotated. Ask
  the owner to rotate and re-issue.
- An operator says they paid but their shop still counts down → ask them to open their renew link
  and file the payment reference; the owner recognises it from the report. Tell the owner the shop
  name so it moves same-day.
