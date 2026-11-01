# The WhatsApp shop bot (v2.3.0)

Buyers shop **inside WhatsApp**: no browser, so a WhatsApp-only data bundle is enough. They tap the
shop's link (or scan its poster), press send, and the bot answers with the menu:

```
*Mama Too Catering*
_Open until 20:00_

_Mains_
*1.* Sadza & beef stew — 5.00 USD
*2.* Rice & chicken — 5.50 USD ▸
_Drinks_
*3.* Coke 2L — 2.50 USD

Send the *number* of what you want (e.g. *2*, or *2x3* for three).
*C* cart & checkout · *S* my order · *T* talk to the shop · *H* help
```

Then: `2x2, 1` adds both, items with sizes or extras ask for them by number, `C` checks out (the
WhatsApp profile name is the default name, `1` pickup or type the address), and the bot sends the
same payment slip the storefront prints: amount with the odd cents, the shop's number, the
reference. The buyer pastes the EcoCash/OneMoney/bank SMS back into the chat, and the bot files the
code on the order (it picks the approval code out of the sentence). `S` shows the status, `T` gives
a wa.me link to the shop's own chat.

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
  When the shop has messaged the bot in the last 24 hours, new bot orders also arrive as a WhatsApp
  message (outside that window Meta would charge for a template, so the email and webhook alerts
  carry it instead).

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
(default `v25.0`), `WA_LINES` (`{"<phone_number_id>":"<handle>"}` for a shop with its own number).

## What it costs (Meta's rules since 1 October 2026)

* Messages **from** buyers are free. Replies are "service messages": **1,000 free per business
  number per month**, then the utility rate, which for Zimbabwe ("Rest of Africa") is about
  **$0.004 per reply**.
* With **no payment method** in Meta's Billing Hub, Meta delivers the first 1,000 and then stops
  delivering until the month resets. So the bot meters itself and goes quiet at 950 instead of
  talking into a void. `/__selftest` shows `month_sent` and `month_capped`.
* One order takes about 5 replies (menu, add, checkout, slip, code), so the free tier is about
  **150–200 bot orders a month on the shared number**. Past that: add a card and set
  `WA_BILLING=on`. At $0.004 a reply an order costs about 2 US cents.
* Cloudflare: one Durable Object request per incoming message plus one per reply (the meter), well
  inside the free plan's 100,000 a day, and no KV writes beyond the order itself.

## Later: a shop's own number

Shops that want the bot on their own WhatsApp Business number (keeping the app on the phone,
"coexistence") need Tapstall to become a Meta Tech Provider and use Embedded Signup. Meta limits
that to 10 new businesses a week until the business is verified. The code is ready for it: a number
listed in `WA_LINES` answers for its shop only, with no `#handle` needed.
