# Sending with a personal Gmail and an app password

This is how Tapstall sends email: a normal Gmail account, signed in over SMTP with a Google
**app password**. You do **not** need a Google Cloud account, a Cloud project, OAuth consent screens,
the Gmail API or billing.

## What you need (10 minutes)

1. **A Gmail account for this business.** By design each business has its own Gmail, so one
   business's reputation, quota or lockout never touches another. (For live testing, several
   businesses may share one box; give each its own app password later.)
2. **2-Step Verification on.** Google Account → Security → 2-Step Verification
   (myaccount.google.com/security). App passwords do not exist without it.
3. **An app password.** Open **myaccount.google.com/apppasswords**, type a name (for example
   "Tapstall worker") and press Create. Google shows 16 letters in four groups. Copy them now; Google
   never shows them again. The spaces are display only, and the code strips them.

If the app-passwords page says the setting is unavailable: 2-Step Verification is off, the
account is managed by a work or school admin who disabled it, or Advanced Protection is on.
Brand-new accounts sometimes have to wait a few days before the page appears.

## Settings (already filled in by `"provider":"gmail"`)

| | |
|---|---|
| SMTP | `smtp.gmail.com`, port **465**, implicit TLS (port 587 STARTTLS also works elsewhere) |
| IMAP | `imap.gmail.com`, port **993**, TLS |
| Username | the full Gmail address |
| Password | the 16-character app password (never the normal account password) |
| Spam folder | `[Gmail]/Spam` |

## Limits

- **About 500 recipients per rolling 24 hours** for a personal account. The limit counts every
  recipient (To, Cc, Bcc) across *all* clients: this software, other workers using the same box,
  and anything you send by hand in the Gmail web or phone app.
- At most 100 recipients per message, and no more than ~10 simultaneous SMTP sessions.
- A gmail lane is clamped to **18 messages per hour** (18 × 24 = 432), so no 24-hour window can
  reach 500 even if the cron runs flat out. The configured daily and hourly caps are lower still.
- Google Workspace accounts get about 2,000 per day; the same setup works unchanged.

## What the errors mean

| Reply from Google | Meaning | What happens / what to do |
|---|---|---|
| `535 5.7.8 Username and Password not accepted` | Wrong, revoked or mistyped app password | The lane parks itself (no retry storm). Make a new app password and update the secret. |
| `534 5.7.9 Application-specific password required` | The normal account password was used | Use an app password. |
| `550 5.4.5 Daily user sending limit exceeded` | The ~500/day quota is spent (often by manual sending) | The lane cools down; Google lifts the block within 1–24 hours. |
| `421 4.7.0 Try again later` | Too many connections or a temporary throttle | Retried automatically on a later tick. |
| `530 5.7.0 Must issue a STARTTLS command first` | Plain connection on 587 | Use 465 (the default). |

If Google suspects a sign-in it shows a "critical security alert" in the inbox. Open it, confirm
it was you, and the next tick sends again.

## Good practice

- Rotate the app password if it ever appears in a log, a chat or a screenshot: create a new one,
  update the secret, then revoke the old one on the same page.
- Changing the account's main password revokes **all** its app passwords; update the secrets after.
- Keep cold email small, plain and honest: a real name, a postal address and a working one-click
  unsubscribe in every marketing message. Gmail's bulk-sender rules apply to how recipients see
  you, whoever sends.
- Read replies in the Gmail inbox; that is where the business happens.

## In this repo

One box, two senders, one inbox for replies:

- **The Worker** (`worker/mail.js`, lane `owner`): merchant mail (links, PIN resets, alerts,
  receipts) and at most a few first touches an hour, default ≤6/hour.
- **The outreach runner** (`scripts/mail_outreach.py` on GitHub Actions): the daily batch, fetched
  from `GET /api/outreach/mailboxes`.

Both read the same Worker secrets:

```bash
npx wrangler secret put GMAIL_OWNER_USER          --name tapstall   # the Gmail address
npx wrangler secret put GMAIL_OWNER_APP_PASSWORD  --name tapstall   # the app password
```

More boxes for the runner: `GMAIL_<TAG>_USER` / `GMAIL_<TAG>_APP_PASSWORD`. Details in `docs/MAIL.md`.
