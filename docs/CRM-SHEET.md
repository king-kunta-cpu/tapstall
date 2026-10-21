# The Master Sheet CRM — how Tapstall is wired into it

Sheet: `https://docs.google.com/spreadsheets/d/1j_ktMLCRmLlk6TOb0-YddYGTmfHChyI29wu84j7SJ8o`
Script: `leads/apps-script/TapstallMasterSheet.gs` (this file is the whole thing — one paste, no libraries)
Worker side: `GET /api/leads/sheets-feed?code=sheet&key=…&fmt=json` and `POST /api/leads/act`

## What it does, in one paragraph

Every two hours it asks Tapstall for the lead queue, appends the leads the sheet has never seen into
`3_CRM_Who_We_Talked_To` as rows whose Lead ID starts `tapstall-`, and — separately — pushes back
the **Stage** of any of those rows a human has changed, so Tapstall's own record of that prospect
moves with the sheet. It never sends anything, never claims a lead, and never touches a row another
engine wrote.

## Why it is built this way

| Decision | Reason |
| --- | --- |
| Its own file, its own menu, its own triggers | the sheet already runs STPi and DeskOS. A shared `onOpen` or a shared trigger handler is how two systems start fighting over one sheet. |
| Rows are namespaced `tapstall-<id>` | the script can prove a row is its own before it edits it. Without that, a filter or a sort in the sheet becomes data loss. |
| Columns are found **by header name**, not position | the other engine adds columns. A hardcoded `getRange(row, 9)` silently writes stages into the wrong column the day somebody inserts one. |
| Idempotent both ways | sync skips IDs already present; push keeps a ledger of the last stage accepted per lead. Run it every two hours for a year and you get one row per lead and one request per stage change. |
| Refusals are recorded, not retried | a `409` means the lead is allocated to another seller ("one prospect, one voice"). The ledger keeps the code and the message, and the pipeline tab counts it. Retrying would be the double-pitch the rule exists to prevent. |
| The sheet gets its own key (`SHEET_KEY`) | the platform's `ADMIN_SECRET` opens the ops console, the press and the deploy. The sheet key opens **only** the lead feed and lead actions. If the sheet is ever shared too widely, one secret rotates and nothing else does. |

## Setup, once

1. In the sheet: **Extensions → Apps Script → + → File**, paste `TapstallMasterSheet.gs`, save.
2. **Project Settings → Script Properties**:

   | Property | Value |
   | --- | --- |
   | `TAPSTALL_URL` | `https://tapstall.zlnew.workers.dev` |
   | `TAPSTALL_SHEET_KEY` | the key in `~/SHEET-KEY.txt` (mode 600, on the build machine — delete after pasting) |
   | `TAPSTALL_OWNER` | `simali` (or `tafa`) |

3. Reload the sheet → menu **⚡ Tapstall → Sync Tapstall leads now**.
4. **⚡ Tapstall → Turn on 2-hour sync**.

## The menu

| Item | What happens |
| --- | --- |
| Sync Tapstall leads now | appends unseen leads, writes the pipeline tab |
| Push stage changes to Tapstall | sends the Stage you typed back to the Worker, once |
| Rebuild tomorrow's queue (all engines) | rewrites Tab 4 from Tab 3 across STPi, DeskOS and Tapstall |
| Pipeline health | one dialog: key, feed, last sync, last error |
| Turn on / off 2-hour sync | installs/removes **only** the two Tapstall triggers |

## The stage vocabulary

Type any of these in the Stage column; nothing else is pushed (and the count of unmapped stages is
reported, so a new word is visible rather than silent):

| Stage you type | Tapstall action |
| --- | --- |
| `New`, `Queued` | nothing — a new lead is not an event |
| `Contacted`, `Called`, `WhatsApp Sent`, `Emailed`, `DM Sent`, `First Touch` | `contacted` (starts the follow-up clock, 3 days) |
| `Replied`, `In Conversation`, `Interested`, `Call Booked` | `replied` |
| `Trial Sent`, `Trial Link Sent`, `Pitch Sent`, `Proposal Sent`, `Demo Sent` | `trial` |
| `Won`, `Closed`, `Converted`, `Signed Up`, `Live` | `closed` |
| `DNC`, `Do Not Contact`, `Not Interested`, `Opted Out`, `Unsubscribe` | `dnc` — and the Worker writes the do-not-contact ledger that the discovery pass reads, so that address is never filed again |

A trailing date or note (`Trial link sent 21/10`) still maps, because people type like people.

## The pre-gate backlog

The live queue still holds 47 rows filed before the gate existed — page titles like *WhatsApp Web*,
*Order - definition of order*, a bank's charges calculator. They carry no `source`, and a lead whose
hook nobody can check is not a lead. The sync **counts** them (`Skipped: no source`) and does not
import them; nothing is deleted. Set `TPS_INCLUDE_UNSOURCED = true` only if you ever want that
backlog in the sheet on purpose.

## What it will never do

- Send an email, a WhatsApp, a DM or a post. There is no mail surface in the file; a test fails if
  one is added.
- Claim a lead for a person, or move one between sellers.
- Invent a business name, a number, an address or a deal value. A lead with no phone, no email and
  no page is not filed at all.
- Edit a row that is not `tapstall-*`.
- Hold money, promise a payout, or put a number in `Deal Value` that nobody agreed to.
