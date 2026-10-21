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

## Setup, once — do NOT paste over their code

The sheet already has a `Code.gs` (STPi + DeskOS). **Keep it.** This file goes in as a *second*
file in the same project:

1. Sheet → **Extensions → Apps Script**.
2. In the left sidebar, **＋ (Add a file) → Script** — *not* "paste over Code.gs". Name it
   `TapstallMasterSheet`. Delete the empty stub the editor puts in it, paste the whole file, save.
3. Still in the editor: **Project Settings → Script Properties → Add script property**:

   | Property | Value |
   | --- | --- |
   | `TAPSTALL_URL` | `https://tapstall.zlnew.workers.dev` |
   | `TAPSTALL_SHEET_KEY` | the key in `~/SHEET-KEY.txt` (mode 600 on the build machine — delete after pasting) |
   | `TAPSTALL_OWNER` | `simali` (or `tafa`) |

4. In the editor's function dropdown pick **`tapstallInstallAll`** → **Run**. Authorise when asked.
   That installs the ⚡ Tapstall menu, the 2-hour sync and the stage push. Nothing else is touched.
5. Reload the sheet. You now have **two menus**: `🚀 STPi + DeskOS Command OS` (theirs) and
   **⚡ Tapstall** (this file).

**Tab 7 (the DeskOS fleet register) is not created by this file.** It is theirs — running their
menu item **1. Initialize / Upgrade All 7 WorkCell Tabs** creates `1_`…`7_`, including
`7_DeskOS_Units_And_Switches`. If it is missing, their setup has never been run in this spreadsheet;
that is fixed by pasting their unified `Code.gs` and running item 1, not by anything here.

## The menu

| Item | What happens |
| --- | --- |
| Sync Tapstall leads now | appends unseen leads, writes the pipeline tab |
| Push stage changes to Tapstall | sends the Stage you typed back to the Worker, once |
| Rebuild Tab 4 myself | refuses by default: Tab 4 belongs to the STPi/DeskOS script. Only runs if `TPS_OWN_QUEUE = true`. |
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

## How it coexists with STPi and DeskOS (checked against their live `Code.gs`)

Read from `https://stpi-deskos.stpi-cloud.workers.dev/deskos/master-sheet-code.gs` (32 KB, HTTP 200)
on 2026-10-21. Not assumptions:

| Surface | Who writes it | Why it does not collide |
| --- | --- | --- |
| Tab 3 `3_CRM_Who_We_Talked_To` | both — **append only** | theirs never rewrites an existing row (`appendRow` + an index of existing keys). Ours only appends rows whose ID starts `tapstall-`. Their dedupe index keys on Lead ID, email and website, so it will not re-add a Tapstall lead, and ours re-reads the IDs before appending. |
| Tab 4 `4_Tomorrow_Queue` | **theirs, exclusively** | `refreshTomorrowQueue()` reads *every* row of Tab 3 with no engine filter, so Tapstall leads appear in tomorrow's queue and in their morning digest automatically. A second writer would clear and rewrite the same view twice a day, so this file refuses unless `TPS_OWN_QUEUE = true`. |
| Tab 7 `7_DeskOS_Units_And_Switches` | theirs | ours never touches it. |
| Menus | each file its own | theirs defines `onOpen`. Ours defines none — it registers `tpsOnOpen` as an installable on-open trigger. Two same-named functions in one project would silently replace one of the two menus; that is why this file has no `onOpen` at all. |
| Triggers | separate handlers | theirs: `installDailyTrigger` and friends. Ours: `tapstallSyncTick` (2 hours) and `tpsOnOpen`. Neither deletes the other's — our cleanup only removes functions whose names start with `tapstall`/`tpsOnOpen`. |
| Credentials | separate | theirs uses `SHEETS_TOKEN` for their two workers. Ours uses `TAPSTALL_SHEET_KEY`, which only opens Tapstall's lead feed and lead actions. |

One thing worth knowing about *their* file, since it will show up in your queue: their
`refreshTomorrowQueue()` writes 12 columns in a different order from their own Tab 4 header —
row 7 (What We Discussed) lands under **Next Action Required**, and Next Action lands under
**Phone**. Their morning digest therefore prints the discussion line where the next action should
be. Not ours to change, but it is a one-line fix in their file if you want it.

## The pre-gate backlog

**Deleted on 2026-10-21.** All 47 rows filed before the gate existed — page titles like *WhatsApp
Web*, *Order - definition of order*, a bank's charges calculator — were read one by one, confirmed to
carry no `source`, and removed from the production lead store (KV `bulk/delete`, 47 removed, 0 failed).
The one real lead was kept: **Cainway Holdings (Pvt) Ltd**, `discovery:directory`, `263783283422`.
The queue is now 1 row, and the sheet's first sync will file exactly that.

The script still guards against a recurrence: any lead with no `source` is counted
(`Skipped: no source`) rather than imported. `TPS_INCLUDE_UNSOURCED = true` overrides it if you ever
want a backlog on purpose.

## What it will never do

- Send an email, a WhatsApp, a DM or a post. There is no mail surface in the file; a test fails if
  one is added.
- Claim a lead for a person, or move one between sellers.
- Invent a business name, a number, an address or a deal value. A lead with no phone, no email and
  no page is not filed at all.
- Edit a row that is not `tapstall-*`.
- Hold money, promise a payout, or put a number in `Deal Value` that nobody agreed to.
