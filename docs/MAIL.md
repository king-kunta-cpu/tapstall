# Mail — how Tapstall sends, and what it refuses to do (v2.2.0)

One personal Gmail box, two jobs: account mail (PIN reset links, email verification, payment claim
links, cancellation notices) and first-touch outreach to prospects. The Worker sends account mail
and its own first touches over SMTP (`worker/mail.js`); the outreach runner (GitHub Actions) sends
the daily batch from the same box. Replies land in that one inbox and a person reads them.
Until v2.1 the Worker used an inbox.lv box; it was retired on 2026-10-29.

## The Gmail route (no Google Cloud account)

`smtp.gmail.com:465` (implicit TLS) and `imap.gmail.com:993`, signed in with a 16-character Google
**app password**. There is no Google Cloud project, no OAuth client and no billing. You need:

1. A Gmail account with **2-Step Verification** on (myaccount.google.com/security).
2. An app password from **myaccount.google.com/apppasswords** (name it "Tapstall").
3. Two Worker secrets: `GMAIL_OWNER_USER` (the address) and `GMAIL_OWNER_APP_PASSWORD` (the app
   password; the spaces Google shows are fine, they are stripped).

Full guide, error codes and limits: [GMAIL.md](GMAIL.md).

## Lanes

`MAILBOXES` (a `[vars]` JSON array written by `scripts/gen_wrangler_toml.py`, overridable with the
repo variable `MAILBOXES`) lists the Worker's lanes:

```json
[{"id":"owner","provider":"gmail","fromName":"Tapstall","hourly":6}]
```

`"provider":"gmail"` fills in the hosts. A lane reads `GMAIL_<ID>_USER` / `GMAIL_<ID>_APP_PASSWORD`
(the names the runner reads too, so both share the box), or `MAILBOX_<ID>_USER` / `MAILBOX_<ID>_PASS`.
A lane with no secrets is simply off; nothing else breaks.

- **Hourly cap.** Personal Gmail allows about 500 recipients per rolling 24 hours across every client
  (this Worker, the runner, the web inbox). A gmail lane is clamped to 18/hour (18 × 24 = 432), and
  the Worker defaults to 6/hour so the runner and manual sending keep most of the day. Outreach may
  use `hourly − 1`; one slot an hour is always kept for account mail, so a reset link is never queued
  behind a prospect.
- **Queue.** A message that cannot leave now (cap reached, SMTP hiccup) is parked as `mailq:<id>`
  and retried by the cron. It is never dropped silently.
- **Auth failure park.** If Google rejects the login (`535 5.7.8`), the lane is parked for **6 hours**
  (`auth_failed`, `cooldown_until`) instead of retrying every tick; repeated bad logins get a Google
  account challenged. It clears itself; make a new app password in the meantime.
- **Quota.** `550 5.4.5 Daily sending quota exceeded` cools the lane down; Google lifts it within 24 h.

## Outreach (the runner)

`scripts/mail_outreach.py`, dispatched by the Worker's 06:15 UTC sweep on weekdays. The workflow
no longer has its own schedule, so it runs once a day.

- **Only real prospects.** Leads must pass the junk gate (`leadJunkReason`) and carry two signals
  at ingest. `/api/leads/act` refuses a claim on a legacy row that fails the gate (422 `junk`).
- **One voice.** A follow-up goes out only from the box that sent the first touch
  (`last_sender`). A prospect never hears from two addresses.
- **At most 3 touches**, each with an unsubscribe footer, `List-Unsubscribe` and
  `List-Unsubscribe-Post` (RFC 8058) headers, and the sender's postal address (`POSTAL_ADDRESS`).
  The `/u/<token>` link is HMAC-signed; one click marks the lead `dnc`.
- **Replies are read, not consumed.** Gmail IMAP is opened **read-only** (`BODY.PEEK`), last 4 days, and
  only mail from lead addresses or bounce notices is looked at. Nothing is marked read, moved or
  deleted, so the person working the inbox sees everything as it arrived.
- **STOP means stop, in their own words only.** Quoted text is stripped before looking for
  STOP/unsubscribe, so our own footer quoted back in a reply is not read as an opt-out.
- **Bounces** (`X-Failed-Recipients`, `Final-Recipient`) and refused recipients mark the lead
  `dnc`. Other send errors release the lead to try another day.

## Where to look

- `/ops/api/health` → `pipeline.mail` (lane state, sent this hour, park), `pipeline.mail_queue`,
  `pipeline.dispatch_last`, `pipeline.whop_unmatched`.
- `POST /ops/api/mail` (ops cookie + `x-tapstall-confirm: 1`): `{"action":"test","to":"you@…"}`
  sends one message now; `{"action":"resume"}` clears a park after fixing the password.
- `/leads`: the leads desk where sellers and the owner work prospects by WhatsApp, phone or mail.

## What is not here, on purpose

- No Gmail scraping and no Google Sheets. The CRM Sheet was removed in v2.0.0. A merchant's own
  menu may still be a published Google Sheet; that is their catalogue, not ours.
- No sending to role addresses of unrelated companies, news sites or platforms. The gate rejects
  an address whose domain does not belong to the business.
