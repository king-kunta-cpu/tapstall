# The WhatsApp shop bot (v2.3.1)

Buyers shop **inside WhatsApp**: no browser, so a WhatsApp-only data bundle is enough. They tap the
shop's link (or scan its poster), press send, and the bot answers with the menu. **An order costs
two billed bot messages: the menu and the order slip.** Everything in between and after is
acknowledged with an emoji *reaction* on the buyer's own message, which Meta does not bill and does
not count against the 1,000 free messages a month.

### Message 1 of 2: the menu (with the instructions in it)

```
*Mama Too Catering*
_Open now · closes 18:00_
Home-cooked lunch, Avondale.

_Main_
*1* Chicken & rice · 5.50
   Size: *a* Small · *b* Large +2.00
   Spice: *c* mild · *d* hot
   Extras: *e* Cheese +1.50 · *f* Egg +0.50

_Drinks_
*2* 2 litre Coke · 2.50
*3* ~Sold out item~ _sold out_
_Prices in USD._

*HOW TO ORDER*
• Send the item number: *2* · two of it: *2x2*
• Choices and extras: letters after the number. *1bde* = Chicken & rice, Large, hot, +Cheese
   (no letter sent = the first choice)
• Several at once, with commas: *1bde, 2x2*
• *Finish with* _pickup_ or _deliver_ and your address:
   _1bde, 2x2 pickup_
   _1bde, 2x2 deliver 14 Fife Ave, near the Spar_
   Delivery 2.00 USD, free over 20.00.

One message or a few, as you like. I react 👍 when I have added it and ❓ when I could not read it
(then nothing was added: check the numbers and send it again). Your total and how to pay come in my
next message.
I read typed text only, not voice notes or photos.
_x_ empty my cart · _cart_ · _help_ · _talk_ to the shop
```

The examples are written from the shop's own menu, so they always name real items and letters.
Each item's letters run a…z (never **x**, which means "how many"): its option groups' choices
first, then its extras. A group the buyer leaves out gets its first choice, and the slip says so.
A menu too long for one message is split by section into pages (`menu 2`, `menu 3`), with the
item numbers unchanged and the instructions on every page, so a buyer orders from page 1 without
paying for page 2.

### Between the two: free reactions only

| Buyer sends | Bot does | Billed? |
|---|---|---|
| `1bd`, `2x2`, `1bd, 2x2` | 👍 on the message (added to the cart) | no |
| a number not on the menu, a letter that is not a choice, two sizes at once, a sold-out item, `2 plates` | ❓ (nothing from that message is added) | no |
| `x` | 👍 (cart emptied) | no |
| `name Rudo` | 👍 (name for the order; default is the WhatsApp profile name) | no |
| `hi` within 6 h of the menu | 👋 (the menu is right above) | no |
| a voice note, photo or sticker | ❓ | no |
| `thanks`, `ok` | 🙏 | no |

A message is read whole or not at all: if any word in it does not fit, nothing is added, so the
cart never holds something the buyer did not mean.

### Message 2 of 2: the slip

`pickup`, or `deliver <address>` (a bare `deliver` reuses the last address), places the order and
the bot sends one message: the items, pickup or the address, the name, the total, any defaulted
choice, the shop's payment steps (amount with the odd cents, number, reference), and:

> **Then paste the payment SMS here.** The whole message is fine; I find the code in it. I react ✅
> when the code is on your order, without writing again, to keep this chat light. ❓ means I found
> no code: type just the code.
> _Optional: to send a screenshot or ask the shop anything, message them: wa.me/…_

Items and the finish can be one message: `1bd, 2x2 deliver 7 Kent Rd, blue gate` goes straight
to the slip.

### After: the payment SMS

The buyer pastes the EcoCash/OneMoney/InnBucks/bank confirmation SMS. The bot pulls the approval
code out of the sentence (never the order's own reference), files it through `proofAdd`, and
reacts ✅. No code found → ❓. Only a refused code (already used, too many changes) gets words.
Sending a screenshot to the shop is optional, via the link on the slip.

### Optional, on request (one billed reply each)

`menu` / `menu 2`, `cart`, `status`, `help`, `talk` (wa.me link to the shop's own chat). Each buyer
gets at most `WA_BUYER_DAY_CAP` (default 8) billed replies a day; past that the bot reacts ⏳
instead of replying. The slip and the shop's own commands are never held back by that cap.

Nothing about the money is new. Orders go through `placeOrder` (menu pricing, risk flags, the frozen
payment slip, email and webhook alerts), codes through `proofAdd`, and phone commands through the
same handler as the one-tap confirm link. A chat costs **no KV writes**: carts live in a
SQLite-backed Durable Object, one per buyer chat, deleted after 60 quiet days.

## For a merchant: installing it

Dashboard → **WhatsApp shop bot** → **Install the shop bot**. The card then shows:

* the order link `https://wa.me/<Tapstall number>?text=Hi <shop>! #<handle>`, plus **Copy link**,
  **Status text** and **QR poster** (the poster also prints "or send #handle to +263…");
* **Let my WhatsApp number run shop commands**: an authority change, so it waits out the 15-minute
  hold and the owner email is told. After that, from the shop's own WhatsApp number:
  `shop orders`, `shop paid WAK-0012`, `shop cancel WAK-0012`, `shop close`, `shop open`.
  New orders reach the shop by its order email and webhook as always. A WhatsApp ping per order is
  available but **off** (`WA_SHOP_PING=on` to enable): it costs one billed message per order, and it
  can only go while the shop has messaged the bot in the last 24 hours.

Until Tapstall's number is live the card says **On (waiting for the number)** and nothing else is
needed from the merchant.

## For the operator: going live (one time, about 30 minutes)

1. **Meta app.** developers.facebook.com → My Apps → Create app → use case *Connect with customers
   through WhatsApp* → attach (or create) a Meta Business portfolio.
2. **Number.** WhatsApp → API Setup gives a free test number (it can message up to 5 numbers you
   verify; good for a first run). For production: WhatsApp Manager → Phone numbers → Add. It has to
   be a number **not** currently signed in to the WhatsApp or WhatsApp Business app (or delete that
   account first), able to receive an SMS or call once. Set the display name (Meta reviews it).
3. **Permanent token.** Business settings → Users → System users → Add (Admin) → Assign assets: the
   app and the WhatsApp account, full control → Generate token with `whatsapp_business_messaging`
   and `whatsapp_business_management`, expiry *Never*.
4. **App secret.** App settings → Basic → App secret.
5. **Secrets on the Worker** (zlnew account, worker `tapstall`). Hand them to the operator or run:
   ```
   npx wrangler secret put --name tapstall WA_TOKEN         # the system-user token
   npx wrangler secret put --name tapstall WA_APP_SECRET    # the app secret
   npx wrangler secret put --name tapstall WA_VERIFY_TOKEN  # any long random string you choose
   npx wrangler secret put --name tapstall WA_PHONE_ID      # "Phone number ID" on API Setup (not the number)
   npx wrangler secret put --name tapstall WA_NUMBER        # the number itself, digits only, e.g. 263771234567
   ```
6. **Webhook.** WhatsApp → Configuration → Callback URL
   `https://tapstall.zlnew.workers.dev/wa/hook`, Verify token = the same `WA_VERIFY_TOKEN` →
   *Verify and save* → Webhook fields → subscribe **messages**.
7. **Live mode.** App settings → Basic: Privacy policy URL `https://tapstall.zlnew.workers.dev/privacy`,
   then switch the app from Development to **Live** (development apps only get test traffic).
8. **Check.** `GET /__selftest` → `wa_bot.armed: true`, `sessions: "durable_object"`. Send
   `#courage` to the number from your phone.

Optional settings (plain vars or secrets): `WA_MONTH_CAP` (replies per number per month, default
950), `WA_BILLING=on` (raises the default cap to 20,000 once a card is on file), `WA_GRAPH_VERSION`
(default `v25.0`), `WA_LINES` (`{"<phone_number_id>":"<handle>"}` for a shop with its own number),
`WA_BUYER_DAY_CAP` (default 8), `WA_SHOP_PING=on` (shop ping per order, off by default).

## What it costs (Meta's rules since 1 October 2026)

* Messages **from** buyers are free. Replies are "service messages": **1,000 free per business
  number per month**, then the utility rate, which for Zimbabwe ("Rest of Africa") is about
  **$0.004 per reply**.
* With **no payment method** in Meta's Billing Hub, Meta delivers the first 1,000 and then stops
  delivering until the month resets. So the bot meters itself and goes quiet at 950 instead of
  talking into a void. `/__selftest` shows `month_sent` and `month_capped`.
* **One order = 2 billed replies** (menu + slip). Reactions (👍 ❓ ✅ 👋 🙏 ⏳) and read ticks are
  free. So the free tier carries about **475 orders a month on the shared number** (950 ÷ 2), fewer
  if buyers ask for `cart`/`status`/`help` often. Past that: add a card and set `WA_BILLING=on`; at
  $0.004 a reply an order costs under 1 US cent.
* A returning buyer who already knows the codes can skip the menu (`2x2 pickup` straight away): one
  billed reply for the whole order.
* Cloudflare: one Durable Object request per incoming message plus one per billed reply (the meter), well
  inside the free plan's 100,000 a day, and no KV writes beyond the order itself.

## Later: a shop's own number

Shops that want the bot on their own WhatsApp Business number (keeping the app on the phone,
"coexistence") need Tapstall to become a Meta Tech Provider and use Embedded Signup. Meta limits
that to 10 new businesses a week until the business is verified. The code is ready for it: a number
listed in `WA_LINES` answers for its shop only, with no `#handle` needed.

## Is Meta the right road? (researched 1 November 2026)

Every *official* way to run a bot on WhatsApp goes through Meta's WhatsApp Business Platform. The
choice is only who stands between Tapstall and Meta:

| Route | Who approves | Cost on top of Meta's fees | Risk |
|---|---|---|---|
| **Meta Cloud API direct** (built) | self-serve; business verification optional | none | lowest; unverified accounts reply to buyers without limit, only *business-initiated* chats are capped (250 a day) |
| **A BSP**: 360dialog, Twilio, Gupshup | the BSP onboards you (still a Meta business portfolio) | 360dialog ~€49/number/month; Twilio $0.005/msg each way; Gupshup $0.001/msg | same policy as direct |
| **Unofficial QR pairing** (Baileys, whatsapp-web.js, Whapi.cloud ~$29/mo) | nobody | hosting or subscription | breaks WhatsApp's terms; the paired number can be banned without warning |

Policy note: since 15 January 2026 Meta bans *general-purpose* AI assistants on the platform; shop,
order and booking bots like this one are the intended use. If direct onboarding stalls, the bot's
Graph calls are the standard Cloud API payloads, which a BSP such as 360dialog accepts unchanged
(different base URL and key header), so switching is a small adapter, not a rewrite.
