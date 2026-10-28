# Mail — how Tapstall sends, and what it refuses to do (v2.0.0)

One mailbox, two jobs: account mail (PIN reset links, email verification, payment claim links,
cancellation notices) and first-touch outreach to prospects. Both go out from the same inbox.lv
box over SMTP from the Worker (`worker/mail.js`); replies land in that same inbox and a person
reads them.

## Lanes

`MAILBOXES` (a `[vars]` JSON array written by `scripts/gen_wrangler_toml.py`, overridable with the
repo variable `MAILBOXES`) lists the lanes:

```json
[{"id":"lv1","host":"mail.inbox.lv","fromName":"Tapstall","hourly":2}]
```

Each lane reads its login from two Worker secrets, `MAILBOX_<ID>_USER` and `MAILBOX_<ID>_PASS`
(for `lv1`: `MAILBOX_LV1_USER`, `MAILBOX_LV1_PASS`, an inbox.lv *app password*, not the web
password). A lane with no secrets is simply off; nothing else breaks.

- **Hourly cap.** `hourly` is this pipeline's share of the box (inbox.lv allows ~15/h per box, and
  the box is shared with other pipelines). Outreach may use `hourly − 1`; one slot an hour is
  always kept for account mail, so a reset link is never queued behind a prospect.
- **Queue.** A message that cannot leave now (cap reached, SMTP hiccup) is parked as `mailq:<id>`
  and retried by the cron. It is never dropped silently.
- **Auth failure park.** If the box rejects the login, the lane is parked for **6 hours**
  (`auth_failed`, `cooldown_until`) instead of retrying every tick. Repeated bad logins can get an
  inbox.lv account locked. It clears itself; fix the password in the meantime.

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
- **Replies are read, not consumed.** IMAP is opened **read-only** (`BODY.PEEK`), last 4 days, and
  only mail from lead addresses or bounce notices is looked at. Nothing is marked read, moved or
  deleted, so the person working the inbox sees everything as it arrived.
- **STOP means stop, in their own words only.** Quoted text is stripped before looking for
  STOP/unsubscribe, so our own footer quoted back in a reply is not read as an opt-out.
- **Bounces** (`X-Failed-Recipients`, `Final-Recipient`) and refused recipients mark the lead
  `dnc`. Other send errors release the lead to try another day.

## Where to look

- `/ops/api/health` → `pipeline.mail` (lane state, sent this hour, park), `pipeline.mail_queue`,
  `pipeline.dispatch_last`, `pipeline.whop_unmatched`.
- `/leads`: the leads desk where sellers and the owner work prospects by WhatsApp, phone or mail.

## What is not here, on purpose

- No Gmail scraping and no Google Sheets. The CRM Sheet was removed in v2.0.0. A merchant's own
  menu may still be a published Google Sheet; that is their catalogue, not ours.
- No sending to role addresses of unrelated companies, news sites or platforms. The gate rejects
  an address whose domain does not belong to the business.
