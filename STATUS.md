# Tapstall — status

## Three bugs the checks could not see (2026-10-13, v0.8.5)

For two days `prod_check.sh` ran on accounts whose 1,000 free KV writes were gone, so every
line that needs an order — 96 of them — printed `! blocked` and the run said `0 failed`. That
number was never evidence. Today the budget was open, the lines ran for the first time, and the
run came back `265 passed / 33 failed`. Three of those failures were the product.

**The merchant's `Hand it back` button did nothing.** `pages/src/admin.html` posts
`{handle, id, void: 1}`; the route accepted `void === true`, `'1'` or `'true'`. A number is not
a string in JavaScript, so the verb fell through to the filing branch and production answered
every press with `{"ok":false,"error":"Nothing to file — type the code they sent you."}`. The
live test for the feature sent `void: true`, and `prod_check` asserted `'void: 1'` against the
*page source* — so both suites watched the two halves of the seam and neither watched the seam.
Now `const VOID_ON = [true, 1, '1', 'true']` is one named list, read strictly, and a new live
test walks four truthy shapes and four falsy ones (`0`, `'0'`, `'false'`, `''` must stay a
filing, because a caller who means to write a code must not find the field cleared by a value
that only looked like the verb), with a pages test that canonicalises the literal the button
sends and demands it be in the list.

**The receipt threw away the door it was handed.** `POST /api/order` answered
`proof_url` and `proof_writes: 3`; the storefront asks `if (j.proof_url && j.left > 0)`, and
`left` — the word every door response uses — was not there. `undefined > 0` is false, so the
success branch took `else pfDone(order)`: it *deleted* the entry it was meant to keep. Three
days of valid link, discarded on the screen that minted it, and the `Correct it — this field
takes N more` line under the box never rendered. The create response now carries
`left: PROOF_WRITES_MAX` beside the document's own name for the count, and the two gates in the
page are pinned by pattern, not by hope.

**A code could land on the order and never reach the ledger.** Four writers (`markPaid`,
`/api/proof`, the shop's filing, the shop's hand-back) each mirrored onto `list:<handle>` with
the same three lines: read the list, `const row = list.find(…)`, `if (row) { patch; put }`.
The list is written just after the order document, so a read served by a colder edge can still
hold the snapshot from before the order existed — and the `if` made that a *permanent* wrong
answer: a reference on the order, `no proof yet` in the merchant's list, nothing left to fix it
until the shop happened to touch the row. One helper now, `mirrorRow(env, handle, id, patch)`,
reading again for ~450 ms before it gives up; the four writers call it and none of them owns
the policy any more.

The other thirty failures were the checker, and they are worth recording because they were
worse than noise — they were the reason `0 failed` had meant nothing. A proof section that
borrowed the order another section had marked paid and undone; four ledger assertions read from
one snapshot grabbed before the row existed; a card assertion aimed at the *offer* page (which
must not prune a live link) instead of the card that closes it; a `week` restore whose response
went to `/dev/null` unasserted; a placeholder written inside single quotes so the string
`AGAIN-$(date +%s | tail -c 6)` was filed as a payment reference. And two states the product
declines on purpose, now reported as states: the minute's 8 mutations (`the minute was spent:
this got a rate limit, not an answer`) and the KV REST mirror lagging the Worker by minutes
(`had not caught up in ~100s; the Worker answered this line itself`). Yesterday's `0 failed` and
today's `0 failed` are different claims; only one of them was worth anything.

**The dead promise.** Both stale pages stayed stale overnight twice running, and the sentence
in `deploy.sh` that explained it — *it publishes itself at 00:20 UTC (the scheduled run)* — was
checked: `.github/workflows/deploy.yml` declares `schedule: cron: '20 0 * * *'` and across 83
runs GitHub delivered **one** scheduled run (#56, six hours late). A retry nobody can prove fires
is a wish, so `pages-are-current` now runs at `20 0,6,12,18 * * *`, the wording in `deploy.sh`
and `lib.sh` names both real routes (any push, or one of four scheduled runs), and
`publish_watch.sh` carries the correction on its first line: the process left to finish this at
midnight was killed by the sandbox mid-sleep, printing nothing, because **a sleep in a sandbox is
not a scheduler**. The pages themselves shipped at 01:14 UTC, verified the only way that means
anything — `all shipped pages are what git holds`, `/a` served at 94,163 bytes exactly as git
holds it with `data-pfv` present, `/s/mamatoe` serving `id="pff"`.

### The 96 blocked lines, run for real

`prod_check.sh` went from `205 passed / 96 blocked / 0 failed` (a spent budget, where the
write-gated copy had never executed) to a same-day sequence of `265 / 33`, `287 / 20`,
`290 / 12`, `296 / 6`, `299 / 2` — each step a fix, and the last two red lines are named below.
Then the day's 1,000 writes ran out mid-run and the script answered `207 / 99 blocked / 0
failed`: it cannot be told apart from health except by the blocked column, which is now the
thing the run prints first.

Five classes of harness fault came out of it, all of them the same shape — *an assertion written
against a state that another request had already moved*:

- **a borrowed fixture.** The proof section read section [4]'s order, which had just been
  marked paid and undone; a section that needs an open order now opens its own (`ORDP`) and
  cancels it at the end.
- **a snapshot where a poll was needed.** `rowwait` and `kvwait` read the ledger row and the
  order document until they exist (and, where the claim is about a change, until the change
  is visible), because `list:<handle>` is a second document and the KV REST mirror of the
  first one lags the Worker by minutes, not seconds. A mirror that has not caught up is
  reported `!` — not verifiable this way — with the reason in the line.
- **a limiter mistaken for a defect.** 8 mutations a minute per address at the order door, 6
  at the buyer's; a section that posts a dozen writes in twenty seconds gets what it asked
  for. `pace` now pauses before the bursts, and a rate-limited body is counted as a state in
  both `ck` and `nk` — a throttled `nk` was the nastier case, because an empty body is a
  false green.
- **an unasserted housekeeping write.** The `week` restore went to `/dev/null` for two
  releases; and worse, it wrote back the logo path read at the start of the run while the
  reaper had already deleted the bytes it named — so every run handed `mamatoe` a dangling
  pointer and the shop went on advertising an `og:image` no crawler can load. A path is now
  fetched before it is written back, and a dead one is replaced by no picture.
- **a positive assertion doing a negative job.** `while the week applies in the same breath`
  accepted `applied_now:[]`, which also means "already like that" — so it could not fail when
  the week *was* wrongly held. It is now a negative on the held list (`'"held":[^]]*week'`),
  checked against five fixture shapes including `held:["week"]` alone.

Two lines were re-anchored after the budget closed and are verified by pattern, not by a live
run: the replayed Confirm (asserts the order was not *changed* — `already:true` or the same
status back, with an `nk` that fails on a reopening) and the shop's verb against a blank box
(posted with a link the order still honours). Run `PIN=… bash scripts/prod_check.sh` after
00:00 UTC for the live answer.

The one real boundary this exercise found in the money path, recorded rather than papered
over: `markPaid` decides `already` by reading the order document, and the buyer's unpaid
tally is a decrement taken on the transition. Replayed inside the consistency window the tap
is honestly seen as a first one, so the tally can move twice. `Math.max(0, …)` floors it and
no money moves twice — status, amount and the ledger row are all idempotent — so this stays a
documented edge of KV-at-$0 rather than a lock invented to dress it up.

It ran in CI on 2026-10-13 at 11:16:24Z-11:31:25Z (`workflow_dispatch`, run #86, commit `4c62313`,
15m01s against the live Worker):

    passed: 179   blocked by the day's KV budget: 98   failed: 0      prod_check exit=0

so the 98 write-gated lines are named daily instead of silently skipped, and nothing on the product
failed. The step that prints that was itself broken when it first went in: `the day's` closed a quote
early, bash died on the line, and no summary printed at all — caught by executing the step body here,
not in CI, because the suite only read the YAML. So the checker now checks the checker: every `run:`
block in every workflow is handed to `bash -n` by `tests/pages.test.mjs` (red on that apostrophe, green
on the fix), and the step prints each failing line with the pattern it wanted and the body it got,
instead of a `tail` that scrolls them out of the log.

## One rule, four places (2026-10-12, v0.8.4)

A deferred line in this file — *"unify `ask_payer` behind `railWantsPayer(rail)`"* — was not
tidiness. The question "does this rail find a payment by the number it came from?" was answered
four times, and two of the answers had quietly split:

- `rail_info.ask_payer` (what the storefront obeys) omitted the `cod` guard that
  `payInstructions` (what the buyer's slip is frozen from) carried;
- `pages/store.html`'s fallback for a config cached before the field existed recognised **two of
  four** specs and required `type === 'manual'`, so a ZIPIT (bank) or PayShap (shapid) shop whose
  buyer held a stale config was asked for *nothing* — on the one rail shape where a number is the
  entire reconciliation.

Now: `PAYER_SPECS` and `railWantsPayer(rail)` in core, defined once and read once; the slip and
the store config call the helper; the storefront's legacy guess names the same four shapes. The
helper takes the spec **as each caller resolved it** rather than defaulting internally, because a
silent `|| 'wallet'` inside a shared rule is how a refactor quietly changes what a buyer is asked.

**Pinned, not promised:** a `core` test walks the catalogue (`cash`/`payfast`/`ozow` false,
`ecocash_usd`/`ecocash_zig`/`innbucks`/`onepay`/`zipit`/`payshap` true) so a shape that flips is
caught by behaviour; a `pages` test counts the source (`PAYER_SPECS` twice — definition and use;
`railWantsPayer(` three times — one writer, two readers) and asserts no second `['phone', …]`
array survives in core. One existing test had to be updated, not silenced: it pinned the storefront
to `R.type === 'manual'`, which *was* the drift; it now pins the page to the server's rule and to
obeying the published field first.

**Checked.** `npm test` **221/221** (core 81 · live 90 · pages 40 · limits 10), `deploy.sh --check`
green, Worker live and confirmed at 0.8.4 on both hostnames. The two page publishes still wait on
the day's KV budget, which is what `scripts/publish_watch.sh` is now for: it slept to the reset the
API reports (00:00 UTC + 2 min), runs `--templates`, and then greps the *served* bytes for the
controls themselves — `id="pff"` on `/s/mamatoe`, `data-pfv` on `/a` — the dry run on a capped day
correctly reporting `NOT SERVED YET … ×0` for both.

## A refusal is a claim about the device (2026-10-12, v0.8.3)

0.8.2 gave the retired link the right *blame* and left the wrong *direction*. Its card said:
"Your receipt has a fresh box for the same field: open it, type the code." That is true of the
phone that filed a code — because `pfKeepScript` left a newer door in that phone's list — and it
was written without asking what happens on the phone a forwarded link arrives on. After a
hand-back it is true of **nobody**: the void retires every link the order had, at once, and the
storefront's only persistent order affordance is that list of doors (`pages/store.html` keeps
`tp_pf_<handle>` and nothing else — there is no saved-order view to go back to).

- **The retired card now sends the buyer somewhere that exists on every phone:** "Send the code in
  your chat with the shop: their ledger has the same field, one box, and they can put it on the
  order for you." The shop's half of that sentence is not a promise invented here — it is
  `/api/order/proof` from 0.7.4, and it ends with the same clause the merchant notice has used all
  along: *nothing else it can change*.
- **The spent card became conditional** — "If this phone has a newer link for the order, that box
  is still open" — because the fresh door is a fact about one device, not about the order.
- **The guard is on the source, not on the fixture:** a new `pages` test reads the two shipped
  strings out of `proofPage` and the two out of the `no()` call in `proofAdd` and fails if any of
  them says "receipt". It also asserts it found *two* strings, so a reword that renames one of
  them fails the count rather than silently checking one sentence. And it matches the strings
  rather than the lines around them — my first version of that assertion tripped on a comment of
  mine that said "receipt" while every shipped sentence was clean, which is precisely how a copy
  guard gets weakened and then stops being one.
- **prod_check reads the live copy**: one probe, four reads of its body (`why`, `used`, the chat
  clause, and an `nkw` that the error names no receipt box). Measured on the live Worker after
  this release: **205 passed / 96 blocked / 0 failed** — the two new lines sit in the blocked
  column because every POST to the door is answered by the rate limiter on a capped day, which is
  the same rule that has kept the other 96 honest since 0.7.8.

**Checked.** `npm test` **219/219** (core 80 · live 90 · pages 39 · limits 10). The three new
`prod_check` patterns were replayed with `grep -qE` against the exact body `/api/proof` returns for
a retired link, and against a deliberately regressed body containing "your receipt has a fresh
box" — which the `nkw` catches. Deployed and confirmed through the loop 0.8.2 added:
`worker live: https://tapstall.simalidudu.workers.dev (0.8.3)`.

## Who closed the door (2026-10-12, v0.8.2)

**Yesterday's card lied by omission.** "That link is used — this order's field accepts one code
per link, and this one has already filed something" was written when there was exactly one way for
a link to die. The hand-back added a second: the shop clears the field, `pcap` turns over, and
every link written for the old code goes dead — including the one sitting in the buyer's
notification bar. Those buyers were being told they had spent something. They had not done
anything.

- **`proofSuperseded(order, nonce)`** (core, pure, seven-line truth table): the link is not
  current, `proof_void_at` exists, and the field is empty. That last condition is the same test
  `proofAsk` uses to decide whether to start asking again, which is what makes the box and the
  sentence unable to disagree about whether there is anywhere to put a code.
- **One status, two sentences.** 410, `final: false`, `used: true`, `pfForgetScript` by url — all
  shared, so a retired link is folded away exactly like a spent one and cannot drift. `no()` holds
  the whole rule in one line (`const dead = why === "used" || why === "superseded"`) and the new
  pages test pins that line, so the shared signal stays shared. The words differ:
  *"That link is retired — the shop cleared the code on this order, so every link written for it
  is retired; nothing you did caused that. Your receipt has a fresh box for the same field."*
- **No power moved with the softer tone.** The retired card mints nothing (`issueCap` appears zero
  times in `proofPage`, asserted), the buyer's door still has no clearing verb, and a retired link
  cannot write even the value it filed before — the field is empty, so a fresh door is the answer,
  and only the surfaces that already mint (the receipt read, the chase) hand one out. An old link
  stays a pointer to nowhere.
- **The control is in the test, not in the reasoning**: the *same* URL is fetched before the void
  (field full, link spent by the buyer → "That link is used", no occurrence of "retired") and
  after it (field empty, void stamped → "That link is retired"). If either case ever falls through
  to the other's copy, that pair fails.

**Also fixed, in the deploy harness:** the self-check waited for *a* live Worker and then printed
whatever version the edge happened to hold, so a green deploy could report yesterday's build —
which is exactly what happened here, twice today (once in `prod_check`, once in run #77's log). It
now waits for the version it uploaded, up to 24 seconds, and if the edge is still behind it says
`still propagating; the upload itself succeeded` instead of letting a number read as a verdict.
Verified against the real edge: `worker live: https://tapstall.simalidudu.workers.dev (0.8.2)`.

**Checked.** `npm test` **218/218** (core 80 · live 90 · pages 38 · limits 10). `prod_check.sh`
gains one probe and three reads of it (retired-not-used, `final` absent, `used` present) — written
as one POST because every probe on a capped day costs a rate-limit write; the three new lines sit in
the blocked column today — `prod_check.sh` measured **205 passed / 94 blocked / 0 failed**, up from
92 blocked because one status-only probe became one POST and three reads of it. `deploy.sh --check` green, and
0.8.2 is live on both hostnames.

## The field can be handed back (2026-10-12, v0.8.1)

**The seventh reading of the same instruction found the seam the sixth left open.** A filed code
is a *sealed* field: `proofAsk` goes quiet once a value is on file, `withAsk` mints nothing while
the field is full, and the buyer’s link is spent by the write that used it. That is correct while
the code is good. It is a dead end the moment it is not — a screenshot nobody can read, a payment
reversed and re-sent, a reference from the wrong wallet. The 410 card has been telling buyers to
“ask the shop and they can change it on their side” since yesterday, and the shop could change a
code but could never **send the field back**.

- **`proofVoid(order)`** (core, pure, its own truth table): both halves of the field clear, the
  write count restarts, and an already-empty field answers `changed: false` — a second tap is a
  second tap, not a failure. It never claims to have touched `status`, because it cannot.
- **One more field on the shop’s route, not one more verb on the buyer’s.** `/api/order/proof`
  takes `void`; `/api/proof` builds its input from `proof` and `payer` alone, so there is nothing
  for a buyer to borrow. `pages.test.mjs` counts it in the source: `b.void` in exactly one
  condition, `proofVoid(` in exactly one handler, and the public door’s `proofAccept` call spelled
  out so a body passed through whole would fail the test.
- **A hand-back turns the nonce over**, so every link minted for the cleared code dies — spent or
  live — and a stale tab cannot file over a decision the shop just made. The idempotent case
  rotates nothing and writes nothing, which the live test checks by comparing the row and the
  document before and after.
- **A filed code keeps the merchant’s box open after the money is counted**
  (`o.ask || open(o) || o.buyer.proof`). The row comment has promised “correct it is the same
  gesture as file it” since 0.7.4; on a paid order the field was hidden, so the promise was only
  true while it was unnecessary.
- **The buyer’s device keeps the fresh door** while the field still has changes: `pfKeepScript`
  writes into the same five-slot list `pfAdd` maintains, so the `Correct it` offer survives a
  reload for the first time — nothing else ever wrote that link down, because a read mints only
  for an empty field. `pfTok` cuts the token at the `/p/` marker rather than at character three,
  because the receipt’s URL is relative and a ledger read’s is absolute.

**Checked.** `npm test` **216/216** (core 79 · live 90 · pages 37 · limits 10), `deploy.sh --check`
green including the ui-kit sync that proves `pages/admin.html` is the generated form of
`pages/src/admin.html`, and `prod_check.sh` **205 passed / 92 blocked / 0 failed** on a capped day:
12 new write-gated checks sitting in the blocked column exactly as the rule says they should, and
6 new static ones passing against the shipped page. Every new pattern was replayed with `grep -qE`
against those page bytes and against the exact JSON these routes emit, plus six fixtures they must
*not* match — two of my own patterns needed their parentheses escaped before they matched anything
at all, which is what that replay is for. Live: `__ping` answers `{"ok":true,"version":"0.8.1"}`,
CI run #76 `exit=0`, and the two pages still owed (`store` 39,588 B, `admin` 94,163 B) were
reported by the *other* fix from today — `NOT PUBLISHED — this account's KV write budget is spent
(429/10048) … the Worker is deployed regardless` — one attempt each, not three.

**Also fixed:** `load_secrets` now looks in `$HOME/.secrets` as well as the repo’s, and tolerates a
secret file with no trailing newline — `read` returns 1 at EOF, and under `set -e` that was a
deploy that died *after* reading the token correctly, silently, in 160 ms.

## One link, one change (2026-10-12, v0.8.0)

**The instruction has always said *single-use token*, and until today it did not mean that.**
`a:'proof'` caps were purpose-bound (this field only) and order-bound, and they expired — but
the same URL could file up to `PROOF_WRITES_MAX` values for its full 72 hours. A link that had
done its job stayed worth doing it again: forwarded into a group chat, screenshotted, left in
a notification, it kept one live write for three days. So the token is now spent by the write.

- **Order creation binds a nonce**: `order.pcap = randomKey(8)`, folded into the signed
  payload as `n`, mirrored onto the ledger row so a dashboard read mints from the same value.
  Storing the *nonce* on the document does not breach the rule that the buyer's URL is never
  stored there: a nonce is not a link, and cannot become one without the signing key.
- **An accepted, changed write rotates it** — same document put, no extra write — and mints
  the next link for one recipient: the response. `Sent` gets `Correct it`, the JSON gets
  `proof_url`, and the receipt box re-points `o.proof_url` at it, so a buyer who mistyped once
  corrects twice more exactly as before, at zero extra taps and with nothing in an inbox.
- **A spent link may still re-file the value it filed.** `proofUsed` + `changed:false` is a
  retry, not a second edit, and a buyer whose answer was lost in a bad signal must not be told
  their code never arrived. It answers `retry: true` and costs the order no write.
- **A spent link may not file anything new**: 410, `why: "used"`, `used: true`, `final: false`
  — the link is dead, the field is not — and the page carries `pfForgetScript` by url, so the
  dead entry leaves the phone that was holding it. Nothing is minted in refusal: a spent link
  that could ask for a fresh one is not spent.
- **The shop's own file spends the buyer's link too** (`/api/order/proof` rotates the nonce as
  well): a code that arrived in the chat does not leave a live write on the order for three
  days. The merchant never needs `/p/`; they have a box.
- **No cliff, no migration**: a cap with no `n`, or an order with no `pcap`, is honoured as it
  was, and the first write that lands binds it. `proofUsed(order, nonce)` is the whole rule and
  it has its own truth table in `core.test.mjs`, including `pcap: 7` against `'7'`, because KV
  round-trips numbers as strings and a nonce is not a type.

Two shipped sentences had to change on the way in, and one existing behaviour had to be
defended rather than tightened: `no()` now prunes on `why === "used"` as well as on `final`,
because "the link is finished" and "the field is finished" need the same tidying and different
words; the settled-order answer takes precedence over the spent-link one, since an order that
has been paid is the more useful thing to say; and the ledger row stops carrying a door once a
code is on file — mint-per-read means it can never be stale, and a stale door would undo the
rule this release exists for.

**Checked.** `npm test` **212/212** (core 78 · live 89 · pages 35 · limits 10). `npm test` also
caught five of its own regressions first: every test that reused one cap for several writes now
follows the chain a phone follows, which is the only way this change is provably *usable* and
not merely correct. `prod_check.sh` gains four lines (two about the box, two about the rule);
the two that need a write are `ckw` today because a capped day answers the door at its rate
limiter before a cap is looked at. Worker 0.8.0 on both hostnames. `pages/store.html` still
waits on the 00:20 UTC publish, which now carries 0.7.5's keeping, 0.7.9's box and this
re-pointing in one put.

**CI #74's red was the edge, not this build.** `templates → KV` died on a Cloudflare 504 (code
7009, "Upstream service unavailable") for the `tpl:store` put, and the publisher's rule — *a
refused write where KV differs from git is fatal* — could not tell that from a stale page. It now
waits a 5xx out (three attempts, 3s then 6s) and keeps the fatal verdict for after the waiting,
while a spent quota (429/10048) still stops on sight rather than hammering a budget that cannot
unspend itself. Proven against the shipped `kv_put_tpl` with `CF_API_BASE` pointed at a stand-in
origin: 504,504,200 → `^ index 0 -> 3236 bytes` after 10s; 429/10048 → one attempt in 0s; always
504 → the new message, exit 0. Applying that patch also briefly ate lib.sh's prologue —
`require_cmd`, `die`, the KV namespace titles — which `bash -n` and all 212 tests walked past;
`scripts/deploy.sh --check` caught it, which is why it now runs before every release note is
written.

## The field is on the receipt, not one tap away (2026-10-12, v0.7.9)

**The instruction, read for the fifth time, says *from the receipt page*.** Four releases had
built a door and walked the buyer to it. What the words actually describe is smaller and closer:
the code their app just printed is on the screen in front of them, at the moment they still
trust the page, so the box goes there. `pages/store.html` now renders `pfBox` inside the paybox
whenever `needDoor` — the same cap the order response just handed this browser (`o.proof_url`,
sliced to the token and escaped into a hidden field), the shop's own `proof_label` and
`proof_hint`, and the sender-number box only where `pay.ask_payer` said this rail searches by
it. It is a real `<form method=post action="/api/proof">` with `form=1` in it, so the no-JS
answer is still the door's page; the script only replaces the navigation with one `fetch` to
the route that already exists. No new endpoint, no new capability, nothing the token can do
that it could not do before the box moved.

**Success folds the box into the receipt.** On `{ok:true}` the form is replaced by the `.kv`
line the page would have printed anyway — `Code from the app · MLINE 4471, from +263 77 999
0001` — and `pfDone(code)` takes the kept entry down with it, so a buyer who fills it here
never sees the line under the notice bar. A failure keeps the box and shows the sentence, with
one exception the Worker now decides: refusals carry `why` and `final` (`empty`/`throttled`/
`cap`/`shop` keep it; `settled`/`spent`/`revoked`/`gone` fold it away). That split exists
because a browser classifying an answer by reading English stops working the day the sentence
is reworded, and it is the same classification `pfForgetScript` already obeys on the page path
— one rule, two shapes of caller.

**A capped day fails closed at the door, and that is the right way round.** Writing the
assertions showed that `rateLimited`'s own counter is a KV write, so when the account has no
writes left every POST to `/api/proof` is answered with the buyer-worded 503 from 0.7.8 before
a cap is even looked at. The alternative — letting the limiter skip when its put throws — would
mean a spent budget switches off the throttle that stands between a stranger and a merchant's
PIN. So the ceiling stays, and the behaviour is now pinned by a test (`a capped account fails
closed at the door, politely, and never answers 500`): 503 as a page, `who: buyer` as JSON, no
prune, no 500, and reads unaffected.

**Checked.** `npm test` **210/210** (core 77 · live 88 · pages 35 · limits 10).
`prod_check.sh` **198 passed / 78 blocked / 0 failed**: three of the new lines read git's copy of
the page, so they are true today even though the page cannot be served yet; two read the live
`why`/`final` fields and are blocked, because on a capped day the door cannot reach them at all.
Worker **0.7.9 on both hostnames**, `pin_kdf true`. The gap worth saying out loud:
`pages/store.html` is **38,237 bytes in git against 31,381 in KV**, so the 00:20 UTC publish ships
0.7.5's keeping *and* this box together, and until it runs a buyer is served the page that has
neither.

## Every answer at the door closes it (2026-10-12, v0.7.7 → v0.7.8)

**Fourth time the same instruction came back, and what was left was the door's own manners.**
The field, the chase that ends at it, the device that remembers it and the sender number that
completes the record are all shipped. A link that could no longer be honoured was not: it sat in
the buyer's phone for its full 72 hours, so the storefront went on offering a door that could
only ever answer "not added".

**One script, two ways to name an entry.** `pfForgetScript(handle, code, cap)` prunes on either
half. A page that reached the order prunes by its code, as it did. A page that never got there —
a shop that revoked its links (410), an order that is gone (404), a refusal posted after either —
prunes by `String(x.u)==="/p/<cap>"`, the link being all it knows. Each half is shape-checked
before a byte is emitted, and the url half is spelled with the storefront's own filter
(`/^[A-Za-z0-9._-]{20,400}$/`), pinned in `pages.test.mjs` so neither file can drift alone.

**What may prune, and what may not.** Final answers do: settled, out of corrections, order gone,
links closed. Non-answers do not: an empty box (422), a busy minute (429), a link that never
verified (401). The last one cannot name a key at all — a cap reveals its shop only once it
verifies — and its entries die on the client at exactly the hour the token dies, so nothing
waits on it. A refusal that is *final* is where the buyer learns the truth, and the storefront
line cannot be corrected from the outside: nobody polls the order from a phone, and the door is
the only place the order is ever read back to the person holding it.

**Two bugs this found, both mine, both already shipped in this loop.** `shell()` takes a title
and a body; `no()` in `proofAdd` handed it four arguments, so every page-shaped refusal — the 422
"type the code", the 409 "already paid", the 410 — answered **HTTP 200 with no `X-Robots-Tag`**.
Invisible in the words, invisible to an assertion that reads only the body: the new test reads the
status and the header. The second: a buyer who pressed Send seven times in a minute got a raw JSON
blob in the browser, because the rate limit answers before the body is read. It answers with a page
now — "Nothing you have already sent was lost, and one more minute is all it needs" — decided from
the request's own content type, which is the only thing visible that early.

**A spent budget is not an answer about the order.** Today is the kind of day that proves
it: the account has no KV writes left, so a buyer posting a code reaches `ORDERS.put`, the put
throws, and the global catch used to answer **a JSON blob addressed to the merchant** — "your
settings are exactly as they were" — in the middle of someone's payment. `/api/proof` is now a
buyer path in `quotaAnswer`, and a form post to it gets a page: *Not saved — the shop cannot
take a code at this moment … Nothing you sent was lost, and the order stands exactly as it was*,
with `Retry-After` and `noindex`, and **no prune**: the link works the hour the shop can write
again, and the storefront line stays up to bring them back to it. v0.7.8.

**Checked.** `npm test` **207/207** (core 77 · live 86 · pages 34 · limits 10). The new live test
walks one order through all seven states and asserts the entry survives exactly where it should:
blank → 422, keeps it; flood → 429 page, keeps it; settled page and settled post → prune; deleted
order → prune; revocation, on the page *and* on the write path → prune; forged cap → no script at
all. `prod_check.sh` gains seven lines: three for the closing — one of them an `nk` that needs
no write and went green today — and four for the budget page, three of which are only true on a
capped day, which today is, so all four ran against the live Worker: **195 passed / 76 blocked /
0 failed**. Two older lines moved from red to blocked for the same reason as the rest of them: they
read something the Worker itself writes (`hooks:<hour>:refused`, and the Sent page), and on a day
with no writes left nothing can create them. The Worker is 0.7.8 on both hostnames;
`pages/store.html` did not change, so the storefront page is still the one waiting for the 00:20
UTC publish.

## The door is kept, and it takes the whole record (2026-10-12, v0.7.5 → v0.7.6)

**Third time the same instruction came back, so the same loop got its last two edges.**
0.7.3 gave a buyer a field, 0.7.4 put that field at the end of the chase. What was left
was everything *around* the write: whether a buyer who closed the page could ever get back
to it, whether the shop knew the door existed, and whether "their own record" meant half
of it.

**v0.7.5 — the door is kept where it was handed out.** `pages/store.html` stores the
receipt's `/p/<cap>` against this shop's handle (`tp_pf_<handle>`, max five entries, each
pruned at 72 hours — `PF_TTL = 72 * 3600 * 1000`, pinned in a test to `PROOF_WINDOW_SEC`
so the client cannot outlive the token) and shows one quiet line under the notice bar:
"Order MAM-1234 — add your payment code", with a dismiss. The `/p/` page removes the entry
when the code lands, from `proofPage` and from the Sent page, and the storefront's keep
gate and the receipt's sentence come from one `needDoor` condition rather than two copies
of it. The wording offers instead of accusing: nothing on that page can read the order
back, so nothing on it may claim the buyer still owes anything, and a spent link still
tells the truth on the far side. `pfForgetScript` refuses to emit anything unless the
handle and code match their own shapes — it is a `<script>`, where HTML escaping is the
wrong tool.

**v0.7.5 — the merchant is told a door exists, and is not given the key.** The order
notice body moved to `notifyText(st, order)` in `core.js`, so the sentence is testable
without a Worker, and when a code is owed on an open order it appends: *"No reference from
your bank yet — the row in your ledger has a link they can paste it into, one field,
nothing else it can change."* A pointer, not the URL: a link in an inbox is a live write
that gets forwarded, and `proof_by: 'buyer'` would stop meaning the hand that held the
phone. The merchant's own dashboard row already carries the minted door.

**v0.7.6 — the buyer's door takes the sender number too.** `proofAccept` has always
accepted `payer` next to `proof`; the page never asked for it, which left the loop half
shut on the rails where the number *is* the reconciliation. The field now appears when
`order.pay.ask_payer` is true — read from the slip frozen at order time, so a shop that
changes its rail cannot retroactively demand it of a buyer who already declined — and only
while the order has none, so a buyer with both sees one box and no extra sentence. Same
words as the cart's ("Number you will pay from (optional — helps us find your payment)"),
same `cleanPayer(…, 'loose')` rule, so it is stored spaced exactly as typed while the
printed slip keeps the dialable form it was issued with: a receipt does not acquire a line
afterwards, which is why the ledger row, the dashboard and the handoff read the buyer
object instead. Two fields, one `proof_writes`, one put per key, and the audit line lists
both (`MAM-9 ← MLINE 4471 · +263 77 999 0001`) rather than whichever came first.

**A deploy that could not write, and the check that now catches it.** The storefront
change is in git and in the Worker; the KV copy of `tpl:store` could not be updated,
because the account had spent its 1,000 free writes today (`__selftest: kv_write_blocked`,
retry in ~11 h). `deploy.sh --templates` says it exactly: *"git has 34305 bytes, KV has
31382 — customers are served the older page"*, and the scheduled `pages-are-current` run
at 00:20 UTC — twenty minutes after the reset — publishes it and goes red if the difference
survives. The gap that mattered was in the *ordinary* deploy path, which published pages
and never read them back, so "deployed" could mean "one page is stale" behind a green log.
It runs the same verification now and warns with the reason and both fixes.

**Then the same flakiness wore a different hat.** Runs #65 to #67 on `main` went red with
the tests green: #65 on a `504` at the post-publish subdomain read, #66 on three `504s` at
three different endpoints of the Workers API (`PATCH /script-settings`, `POST /deployments`,
`PUT /schedules`), and #67's rerun on an HTML page — `<!--[if I…`, 6,504 bytes — where the
API should have answered. The Worker merchants use was 0.7.6 and already live from this
machine, so the red meant "Cloudflare would not talk to the runner", and reading the log is
now enough to know that: each attempt names its matched line, and a non-JSON body is labelled
as edge trouble instead of left as a fragment. The scheduled run retries on its own.

`node_modules` is not installed on this machine, so local deploys have always gone through
`scripts/cf_publish.py`, and the retry is proven by CI's own transcript: run #66 printed
`wrangler deploy failed, attempt 1 of 3: PATCH /…/script-settings -> 504 Gateway Timeout`,
`…attempt 2 of 3: POST /…/deployments -> 504`, `…3 of 3: PUT /…/schedules -> 504`, then
`the Worker was not published in three attempts — nothing new is live`. To see the second
shape here, `node_modules/.bin/wrangler` was created as a stub that prints a Cloudflare HTML
page and exits 1, and the line read `Cloudflare answered HTML, not the API (6271 bytes back)
— an edge outage or a challenge, not something this deploy can fix`, three times, then died.
The stub is deleted; `node_modules` is not a tracked directory, so nothing else was touched.

**Reporting, not noise.** A spent budget used to turn thirteen buyer-door lines red,
because their inputs (an order, a page publish) could not exist. They are `ckw`/`nkw` now —
`nkw` is new, because a must-not-contain check on an empty input passes for the wrong
reason and prints green. Today's live run: **192 passed / 72 blocked / 0 failed**.

**Checked.** `npm test` **205/205** (core 77 · live 84 · pages 34 · limits 10): the payer
box appears on a phone rail and not on a rail with no sender number to search; both halves
land in one write and one put; the pair is echoed back and the second box then disappears;
document, ledger row, dashboard row and audit line agree; the frozen slip stays honest. The
storefront's keeping is asserted statically, including that its line cannot accuse.

**Untouched, still.** `/c/` does not check `p.g`, so *Revoke* closes code links and
sessions and leaves confirm links alone — raised in 0.7.3, unanswered, unfixed.

## The last mile of the same field (2026-10-12, v0.7.4)

**The instruction came back, so the feature went deeper.** 0.7.3 let a buyer add their
own code from the receipt. Two things were still false at the edges of that, and this
release is only those two.

**(1) The chase now ends at a door.** `proofAsk`'s sentence used to say *"Send it here"*
while "here" was a chat window. So `withAsk` mints a `proof` capability while it writes
the row's `ask` — `proofAsk(order, { here })` swaps one clause — and because the
merchant's two taps already append `ask`, *WhatsApp buyer* and *Copy slip* now both carry
an absolute `/p/<cap>` link. That is the whole change, and it also answers the failure 0.7.3
left open: a buyer who closed the receipt lost the door for 72 hours. Minted per read,
one HMAC, **no KV write**, nothing stored — a buyer needs the next message, not the old
link. A settled order's row keeps its sentence and gets no link: `proofOpen` decides
both halves, so the page and the machine still cannot disagree.

**(2) The shop can file what a buyer sent in chat.** A code that arrives after the money
was counted had nowhere to go — the buyer's door was closed by design and the merchant had
no field at all, which made the honest answer "your record is wrong forever". So
`POST /api/order/proof` exists: `identify` only, no capability read anywhere in the
handler, no rate bucket (it is the owner's ledger), **no** open-state gate and **no**
three-write budget, because both of those exist to bound a stranger. Same `proofAccept`,
`by: 'merchant'` — same cleaning, same "an absent field is left alone", and the one rule
that does not bend: it cannot write `status`. `proof_by` records which hand filed it, the
audit row says `via: 'merchant'`, and the buyer's allowance is untouched by a shop write
(`proof_writes` stays where it was, asserted). The dashboard row grows one input and one
button when a code is owed or the order is open, prefilled with what the buyer sent, so
"correct it" is the same gesture as "file it".

**One voice per door.** The blank-field refusal is written for whoever is standing at the
field: the buyer is told where to look, the shop is told what it failed to do
(`Nothing to file — type the code they sent you.`). A shared sentence read from the wrong
side is a support message, and a test pins both strings.

**Generated pages, caught as designed.** The dashboard is built from `pages/src/admin.html`
by `scripts/ui_kit.py`, and the first edit went to the shipped copy; the drift test failed
it inside the same minute. The edit went to the source and `python3 scripts/ui_kit.py`
regenerated. `store.html` has no source counterpart — it is hand-authored — which is why
0.7.3's receipt edit was fine where it was.

**Checked.** `npm test` **200/200** (core 76 · live 81 · pages 33 · limits 10): the minted
row link is driven end to end and accepted; a paid row keeps its words and gains no door;
the shop files over a buyer's value on a settled order with `status` unmoved and the
buyer's budget intact; `proof_url` is absolute where a chat needs it and relative in the
order response; anonymous 401 with `need_login`, a `proof` cap offered to the merchant
door is not even read, GET 405, blank 422, replay `changed:false`, ghost id 404, and the
sentence byte-for-byte unchanged when no door was minted. `prod_check.sh` grew nine lines
on the live Worker — including reading the stored order out of KV for `"proof_by":
"merchant"` beside `"proof_writes":1` — and cancels both probe orders at the end.

**Not done, on purpose.** The merchant's `markPaid` session path still does not check
`p.g` against `auth_gen` for `/c/` links (raised, unanswered, untouched — no line of it
changed in either release), and `pages/admin.html`'s filed value has no "clear" gesture:
an empty box refuses, which is the same rule the buyer's door runs.

## The buyer closes the loop themselves (2026-10-12, v0.7.3)

**The ask, kept exactly.** *"letting a buyer add their code after the order from the
receipt page would close the loop properly … It needs a new public write, so the
mitigation is a separate single-use token minted for that field only — not the existing
`/c/` mark-paid capability, whose power I'm not widening without you saying so."* So
`a:'mark'` has the same powers today that it had yesterday, and that is a checkable
claim rather than a promise — the command to re-run whenever it is doubted:

```
git log -1 --grep="buyer adds their own payment code" -p -- worker/worker.js \
  | grep -E "^[+-]" | grep -E "markPaid|confirmPage|a: .mark."
```

(The 0.7.3 commit is `3d91692`; the lookup is by message so the command survives a rebase.)
One line comes back, and it is a comment inside the new handler saying that it copies
`markPaid`'s shape: no added or removed line lies inside either function, and the
`a: 'mark'` mint is byte-identical. What is new is a second kind of capability,
`a:'proof'`, minted at order time as `/p/<cap>`, and one endpoint behind it. The only
shared guard that moved is `MUT` gaining `proof`, and that takes a power away: a GET
to `/api/proof` answers `405`, so a link prefetcher cannot add a reference either.

**One deviation, chosen deliberately: it is not single-use, it is three.** A
mistyped TxID is the ordinary failure of this exact flow, and a buyer who has one
chance and blows it does the thing the feature exists to prevent — they message the
shop. So the budget is `PROOF_WRITES_MAX = 3` *accepted* writes, counted on the order
(`proof_writes`), not in the token, so a replay after the limit is inert rather than a
fresh allowance; and the door closes outright the moment the shop settles the order,
which is the tighter half of the promise. A resubmit of the value already on file costs
no write and says `changed: false`, because a retry after a lost response must not eat
an allowance.

**What the whole policy is, in one pure function.** `proofAccept(order, input)` in
`core.js`: open states only (`awaiting_payment`, `cod`), never `status`, never
`cleanAcct`, cleaning by the same `cleanProof`/`cleanPayer(…, 'loose')` the cart uses, an
absent field left alone instead of cleared (so an empty second submit is not a way to
erase evidence), and refusal text that points at the chat rather than at another try.
`proofOpen` is shared by the page and the machine, so the form is never offered where the
write would fail. The route pair is `GET /p/<cap>` → a page with a plain
`<form method=post action="/api/proof">` — a form is the floor and `fetch` never enters
it, because the buyer is on whatever browser their bank app opened — and `POST
/api/proof`, added to `MUT` so a link-prefetching crawler gets `405` and changes nothing.
Gates in order: POST, own rate bucket, `verifyCap` *and* `p.a === 'proof'`,
`p.g === st.auth_gen` (so the merchant's one lever, *Revoke*, closes the buyer's door
too — the revoke note now says so), order exists, then the state machine.

**Cost, because $0 is a product decision.** Two `ORDERS` puts per accepted write — the
order document and the ledger row — which is exactly what a mark already spends; zero
puts on a refusal, a replay, a forgery or an expiry. No KV key per token and no delete,
because the capability is stateless (HMAC, 43-char tag, 72 h) and "single-use" was
bought with a counter on the order instead of a write per click. `rateLimited` grew an
optional bucket (`rl:proof:<ip>:<hour>`, 6/min) so a buyer on the shop's carrier NAT
does not spend the shop's order allowance, and the default key shape is byte-identical
to what every existing budget assertion reads.

**Not widened, and stated on the page.** A `proof` cap pointed at `/api/mark` gets the
same `link_expired` answer as an expired link, so nothing leaks about which kind it was;
a `mark` cap pointed at `/p/` gets the dead-link card. The link is minted into the
order *response* and never stored on the order document — a merchant reading the ledger
would otherwise hold a URL that writes into a field labelled `proof_by: 'buyer'`, and
the label would stop being true. The audit row is `act: 'proof', via: 'buyer'`.

**The free win.** `proofAsk` already returns `''` as soon as a code is on file, so the
chase sentence leaves the ledger row, the slip and the CSV with no new wiring — and its
words, *"Send it here and I can confirm your order today"*, became literally true for
the first time.

**Checked.** `npm test` 195/195 (core 74 · live 79 · pages 32 · limits 10 — +10 tests
over 0.7.2, six of them driving the real handler: mint, page, write, ledger row, audit
row, status untouched, three-then-shut, empty-is-not-erase, forged and wrong-kind caps
both directions, revoke, and the throttle bucket's isolation). `prod_check.sh` gained
14 lines on the live Worker, including reading the order document back out of KV to
prove `"status":"awaiting_payment"` survived a public write and that no `/p/` link is
in the stored order.

**Left alone on purpose.** `/c/` still does not check `p.g` against `st.auth_gen`, so
*Revoke* does not yet kill a confirm link the way it kills a code link — a real,
pre-existing gap in a money path, which is a one-line change and its own conversation,
not a passenger here. The buyer page is built with `shell()` rather than published as a
`tpl:` template: the confirm page earns a template because it carries the money state;
a one-field form does not need a re-skin lever, and a second lever is a second thing to
secure.

## The shop can introduce itself, and there is something to find (2026-10-12, v0.7.2)

**Same instruction, taken further.** *"Take pointers from my google bots"* was asked
twice, and the second time it was read properly rather than skimmed: the content bot's
30 numbered changelog lines, the digest mailer's rate-limiting and resume markers, and
the OpenRail engine's five money guards. `docs/POINTERS.md` now holds every one of them,
dispositioned — taken, already had, or refused with the reason, so a refusal can be
argued with instead of rediscovered.

**Three things shipped.** (1) `GET /s/<handle>/share.txt`: the cross-post generator idea
applied to a shop. `shareCopy` in `core.js` builds four blocks — WhatsApp status, X,
Facebook, Instagram — each obeying *its own* platform's limit, because a post that
truncates loses the link, which is the only part that mattered. X is measured to 280
characters in a test, not in a comment; the Instagram block deliberately carries no URL,
because a caption is not clickable, and a test says so; a missing fact leaves no hollow
bullet. (2) Two written pages, `/guide/whatsapp-shop-payments` and
`/guide/payment-reference-matching` — a pillar and a cluster, in their bot's own model,
with the tariff table and the matching trick that only our code can describe accurately.
`GUIDES` in `core.js` is the single source: the route, the sitemap entry and the footer
link all read it, and `deploy.sh` now derives its publish list from
`pages/guide-*.html`, so a written page that never got published — the exact orphan
failure their bot spends a whole subsystem detecting each week — cannot happen here
without a test going red. `@ORIGIN@` is stamped at serve time, so canonicals stay right
if the platform ever moves to its own domain. (3) Every exit of both money doors is
counted per hour per outcome (`hooks:<YYYYMMDDHH>:<status>`, `onlyIf: {match:'none'}` so
the one-write-per-hour bound holds across isolates rather than per warm worker) and
surfaced in `/ops/api/health`. Their engine posts every guard refusal to Discord; that is
right about visibility and silent about cost — a refusal is the one event a stranger can
generate at will, and the account has 1,000 writes a day in total.

**Refused, in brief, and why it is worth refusing loudly:** keyword-density and
uniqueness ratios (padding is how a small site earns a thin-content tag), FAQ JSON-LD
(Google demoted it for sites like ours in 2023), IndexNow and tenant sitemaps (the same
enumeration, mailed to a search engine), the sentence-hash LRU (a bounded memory forgets,
and a thing that forgets double-credits), `google.com/ping?sitemap=` (documented as
ignored — their bot should delete it), and the mailer's in-progress resume marker
(our unit of work is one atomic KV write, so the next cron run *is* the retry, and
adding state would only add a way to be wrong).

**Two bugs the new checks caught in the checks themselves**, which is what they are for:
a `grep -E` pattern with an escaped pipe (BRE habit, no alternation in ERE), and a
canonical pattern that allowed one character where the HTML has two (`="`). Both were
proved against production bytes before being declared fixed — the pages were always
right; the assertions were wrong, and a red line that is wrong is worse than no line.
Suite **185/185** (core 71, live 74, pages 30, limits 10); `prod_check.sh` **230
assertions, 0 failed** against live production, including "the merchant's private
columns are not in the bytes", "no unstamped token reached a reader" and "a guide nobody
wrote is a 404, not an indexable page".

**One production note.** `deploy.sh` used to print "ADMIN_SECRET generated locally" even
when it had merely read the existing `.secrets/admin_secret` — a stable secret reporting
itself as rotating, which is the one thing that variable must not appear to do. It now
says which case it is in. A local deploy whose value differs from CI's does sign
merchants out (sessions and CSRF caps are signed with it) and resets buyer order-history
fingerprints; no money state is affected, and renewal links keep working because their
tokens are stored keys, not derived values.

## A store link now looks like a shop when it is pasted into a group (2026-10-12, v0.7.1)

**Prompted by the user's own bots.** Three files were handed over to take pointers
from: the COREMERCH content bot (387 KB of Apps Script that publishes posts to GitHub
Pages), its weekly digest mailer, and the OpenRail payment engine. The content bot's
discoverability half is a checklist worth copying, and this release copies it for
storefronts: a canonical URL, OG tags **with alt text**, a Twitter large-image card,
JSON-LD per page, `robots.txt`, a sitemap, and the rule that an image is never
promised unless its bytes are real. The mailer and the payment engine mostly confirmed
things already built here (quota-aware batching, budget forecasting, the five-guard
money ladder) — OpenRail's header literally lists *IPN token + API re-verification +
idempotency + re-deposit guard + amount verification*, which is 0.7.0 in other words.

**What was broken before:** every store page shipped `<title>Tapstall Store</title>`
and nothing else in the head — no description, no canonical, no `og:*`, no structured
data, and no `robots.txt` at all. So a pasted link previewed as a grey box labelled
"Tapstall Store", and Google saw a hundred near-identical empty pages. That is not a
cosmetic miss in this product: the storefront is the whole distribution story
(no chasing — the merchant's own audience finds them), and the preview *is* the ad.

**The shape of the fix.** The head cannot be built in the page, because the crawler
that reads it runs no JavaScript, so `storePage` injects it server-side. The rules live
in `core.js` (`seoFacts`, `seoHead`, `seoJsonLdTag`, `weekSpec`, `ROBOTS_TXT`,
`sitemapXml`) — 5 new unit tests — with one deliberate raw-string path
(`fillSeo`), because `fillPage` JSON.stringifies its values and a `<meta>` tag is not
a JS literal. Every fact is derived from the store document: title from
`shop_name` + `location`, description from `tagline` plus the top three priced items
plus the live open/closed line, `LocalBusiness` with `telephone` (the number the buyer
already sees), `priceRange`, `openingHoursSpecification` from the same week table the
page shows, and a `Menu` of the merchant's own rows with `OutOfStock` on the sold-out
ones. Nothing is invented: no hours when none were typed, no cuisine nobody claimed,
no `og:image` when no picture exists.

**The one deliberate refusal.** `/sitemap.xml` lists three of our own pages and does
**not** enumerate `/s/<handle>`. It is an unauthenticated URL, and every store page
carries that shop's payment numbers — a tenant sitemap is a downloadable register of
the whole customer base and their tills. Store pages stay crawlable and canonical; the
link that gets them found is the one the merchant posts. `robots.txt` disallows
`/a`, `/ops`, `/api/` and the diagnostic routes, and those pages also answer with
`X-Robots-Tag: noindex, nofollow` for the crawler that ignores robots.txt. IndexNow and
Search Console are one line each and are left off for the same enumeration reason.

**Caught on the way, and worth repeating.** The old live assertion "no menu is baked
into the served HTML" (the reason a menu edit is instant) is now drawn where it
actually matters — at `</head>`: the list a buyer orders from stays live-fetched, the
head may quote the last-known shelf for a crawler, and a stale snippet is normal while
a stale order is not. Two bugs came out of writing this: `og:image:alt` surviving with
no image (a preview that promises a photo and shows none is worse than silence), and
`….` — a stacked ending, because a truncated part was joined as a sentence and got a
full stop after its own ellipsis; `clip` is now idempotent and `sentences` respects a
part that already ends on a mark. `prod_check`'s own new JSON-LD line was red against
production first, and it was the check that was wrong: a greedy `[^
]*>` swallowed the
whole `<script>` line including its closing tag.

**Proven live, from a clean state and back to one:** uploaded a real PNG to
`mamatoe`, set it as the logo, and the served head gained `og:image` +
`og:image:alt` (`Mama Too Catering, 4 items on the menu`) + `twitter:card
summary_large_image`, the JSON-LD gained the same absolute image, and the URL a
preview bot fetches answered `200 image/png`. Taking the logo off removed the tags and
the file `404`ed with `img:mamatoe:*` empty in the namespace — 0.6.9's reclaim,
confirmed by a test that was about something else. Suite **179/179**;
`prod_check.sh` **214 assertions** including "the merchant's private columns are not in
the bytes" and "we do not hand out a register of merchants".

## A public POST can no longer hand anybody a paid plan (2026-10-12, v0.7.0)

**Found while auditing my own money model, not reported by anyone.** The proof-of-payment
work made me re-read every path that can move money. `POST /api/hook/payfast` was a public
route that believed whoever called it: `payment_status=COMPLETE&custom_str1=<handle>|<days>`
extended that store by `days` — a number taken from the request — with no signature check,
no amount check, no replay guard, and without ever looking at the payment intent `checkout`
had minted. I measured it on production against a real store: `36500` days went through.
(The record was put back to the exact bytes it held before, `paid_until` 2027-10-10 and
`plan=annual`, and the repair is what proved the KV read-after-write lag noted below.)
`hookFlutterwave` had the right shape and then gated its verify hash behind
`env.FW_SECRET &&` — in production that variable is unset, so the check was switched off
by the absence of a config line.

**The rule now, in one sentence: a notice may confirm a payment, never describe a deal.**
`checkout` mints `tx:<handle>-<16 random base64url chars>` holding
`{handle, days, amount, currency, at}` with `expirationTtl: 1800`, and hands the button
only that reference (`custom_str1`). The hook reads the record back and takes every term
from it: how long, how much, which store. `custom_str2=36500` in the notice is now
decoration. The 30-minute TTL is not a nicety — an old payment link that still honours last
month's price is a pricing bug with a receipt.

**Both doors are shut until armed, in the same shape as `markPaid`:** capability first,
effect second. Unconfigured, `/api/hook/payfast` answers `503` naming `PAYFAST_PASSPHRASE`
and `/api/hook/flutterwave` answers `503` naming `FW_SECRET`, so "nobody set it" is a loud
refusal instead of an open door — the opposite of the `&&` bug above. Once armed, a PayFast
notice must carry a signature over the sorted, decoded fields (`payfastSignedOk`), compared
in `sigEq` without leaking how much of it matched. Workers' WebCrypto has no MD5, so
`md5Hex` is ours, pinned in the suite against five published vectors and run differentially
against Python's `hashlib` over 70 inputs (empty string, 63/64/65-byte block boundaries,
unicode, 1000 bytes) — 0 mismatches. Both readings of the provider's empty-field rule are
accepted, because their own samples disagree and picking the strict one would silently
refuse real payments; neither reading is forgeable without the passphrase.

**Refusals are engineered to cost the merchant nothing.** Amount or currency that does not
match the intent, or a spent/expired intent, answers `200 {ok:true, ignored:"…"}` — nothing
to retry, nothing written — and **leaves the intent unspent**, so the genuine notice can
still land minutes later; rate limits and a provider's own retry storm must never be able to
consume a real payment. A duplicate `pf_payment_id` answers `{ok:true, already:true}`
(30-day key) rather than "unknown reference", which is what stops a provider retrying
forever; on success the intent is deleted, so a second copy of the same notice has nothing
to spend. Flutterwave additionally gets **asked back** when `FLW_API_KEY` exists
(`GET /v3/transactions/{id}/verify`): the provider's word about its own success is not
evidence, `status` must be `successful` and amount/currency must match, and an unreachable
provider is a `502` with the intent left unspent rather than a lost sale. The hooks now share
the order rate limiter by IP.

**What a merchant would notice:** nothing on the storefront; on renewal, a stale payment
window says "start again" instead of honouring an old price. `tests/core.test.mjs` 64/64
(five new: ref shape, canonical string, signature, amount, spent-ref), `tests/live.test.mjs`
68/68 (two new: the exact old exploit against the live handler — refused, `paid_until`
unchanged — and a full signed notice that activates, replays as `already`, then finds
nothing to spend; plus the Flutterwave 503/401/verify-failure/amount-mismatch path with the
provider fetch stubbed). Whole suite **170/170**. `prod_check.sh` is at **200 assertions,
all green**, and `[11]` is the exploit itself as a standing line: a handle plus a number of
days buys nothing at either door, and the store's `paid_until` read straight from KV is
byte-identical after the probes. Writing those tests caught a bug in code I had just written
(a truthy test on `fields[k] != null && fields[k] !== ''` let a blank field into the signed
string) and a design mistake in the handler (idempotency was checked after the intent, so a
retry of a *successful* payment answered "unknown reference").

**One thing to know about KV:** a `GET` on the REST API right after a `PUT` can return the
**old** value — I watched it stay stale for over 8 seconds on a store document. Repairs that
are relative (subtract a year, add a year) must not be re-applied on the strength of that
read; the safe form is an absolute value derived from arithmetic you can check, then a
read-back **loop**. My first repair attempt did exactly that, and the second read was of my
own double-applied write.

## A removed picture is freed by the save that removed it (2026-10-12, v0.6.9)

**What the daily check caught, hours after 0.6.8 shipped.** `prod_check.sh` went red on
one line: *the file the shop stopped pointing at is gone, not orphaned* — it answered
`200`. The picture had been uploaded, set as the logo, taken off again, and it was still
being served. First instinct was the CDN: `GET /i/…` carries `cache-control: public,
max-age=31536000, immutable`, and a cached copy would explain a `200` forever. It wasn't
that — the same URL with a cache-buster also answered `200`, and Cloudflare wasn't
tagging the response at all (no `cf-cache-status`, no `Age`). The object was really
there: listing the namespace showed `img:mamatoe:<id>` alive, ~140 bytes nobody points
at, while the store document and `config.json` had no reference to it.

**The cause is one sentence in Cloudflare's own docs:** `list()` is eventually
consistent. `pruneImages` enumerated the namespace and deleted whatever the listing said
was unreferenced — and the file a merchant just took off is *by definition the newest key
in the namespace*, the one the index is most likely not to have seen yet. So the sweep
missed precisely the case it existed for, and caught the older orphan a minute later on
the next save. (That is also why the 0.6.6 manual proof passed: by then, more time had
elapsed.) A test in `tests/live.test.mjs` asserted the delete on a synchronous in-memory
stub, where the listing is never behind — so the bug was invisible to every suite and only
production could show it.

**Fix.** `pruneImages(env, st, before)` now takes the refs the store held *before* this
save — `referencedImages(st)` sampled before the mutation, cheap and in-memory — and
deletes those directly, without consulting the index. The listing sweep still runs
afterwards as the janitor for everything else (a store document edited by an operator, a
revert that drops a whole shelf), which is where eventual consistency is harmless.
Wrong-direction risk was checked and is nil: if the listing hasn't caught up on a file
that *is* still referenced, the sweep simply skips it — a later save frees it — while the
direct path can only delete a ref this very save is dropping.

**Provable, not asserted.** The new live test stubs `env.STORES.list` to return no keys
— the lag, simulated, because the stub is instant — and requires the picture to be gone
in the same save that dropped it. With the fix: **66/66 live, 163/163 overall**. With
`before` not passed (the old behaviour): that one test fails and nothing else does, which
is what a regression guard is for. `prod_check.sh`'s picture line is the production half
of the same claim.

**Also today, while chasing it:** the orphan my own probe left (`img:mamatoe:YH9E3B6Qen`)
was freed by the worker's next save ✓ no litter left behind — and an API-token `DELETE`
on a key path is not usable from a sandbox (`10025`: the path with a colon'd key does not
resolve, encoded or not), so the KV console's own delete is not a lever here. Cleanup of
anything the worker did not free means a bulk delete, which the free token also refuses.
Note for the record: only an empty `User-Agent` is refused on this zone (Cloudflare's
browser integrity check) — a browser, `curl`, `Googlebot` and `WhatsApp/2.x` all fetch a
storefront `200`, so link previews in the app where the whole product lives are fine.

## The message a merchant would have to type is typed for them (2026-10-12, v0.6.8)

**The one tap rule, applied to the follow-up.** 0.6.7 put a flag on the ledger row —
`no reference from your bank — ask them before sending` — and then left the merchant to
compose the text themselves. That is the same five minutes of friction in a different
place: knowing you should message someone and typing "hi, it's …, the code please" into
a WhatsApp box, per order. So the ask is now written by the Worker and travels with the
row as `order.ask`, and the two taps a merchant already has — **WhatsApp buyer** and
**Copy the slip** — append it.

**Why it is server-side.** The sentence depends on the rail *as frozen on the order*,
not on whatever the shop's settings say today, and it has two readers (the message link
and the copied slip) plus a third that will want it later (the mailer, the webhook). A
second copy of a sentence is a second place to be rude in, so there is one function:
`proofAsk` in `worker/core.js`, next to the policy it derives from. The page adds
`if (o.ask)` and nothing else — a test asserts the shipped admin invents no sentence of
its own, by grepping for the words it must not contain.

**What it never does.** It is not written when the buyer answered (`proofAsk` returns
`''`, the field is absent, the row is untouched — no badge, no nudge, nothing to act
on), not written for a rail that needs nothing, and not written for an order whose rail
carries neither a policy nor a shape: a label alone is not enough to claim to know what
a shop needs. It is computed at read time rather than stored, so a merchant who renames
what they call the field gets the new wording on yesterday's orders too — and a stored
`ask` could go stale in a way the owner cannot fix. An order placed before any of this
existed still gets the sentence, from the same `proofDefault` its slip used: the slip
asked, so asking again is fair.

**Wording.** Two lines, no apologies: `Need: Reference from your bank — your app shows
it right after it sends. Send it here and I can confirm your order today.` for a rail
that requires it, and for the optional case the generic lowercase word for the shape
(`code`, `TxID`, `reference`, `receipt number`) rather than the merchant's label, because
`send the Code from the app too` is what capitalising a name mid-sentence does. The
merchant's own wording is used verbatim, and never re-cased, in the `Need:` line.

**Verification.** `node --test tests/` → **162/162** (core 59, live 65, pages 28, limits
10); production check gained a line that reads the merchant's own ledger payload and
asks whether any row carries a sentence, which is blocked today only because the
account has no KV writes left to make an order with.

**The alias, fixed on the way (same release, no product code).** The previous brand's
hostname is a redirect-only deployment whose entire behaviour is one plain-text var,
`REDIRECT_TO`. The dependency-free publisher (`scripts/cf_publish.py`, used whenever
`node_modules` is absent — which is how a sandbox and a lean CI both deploy) built its
bindings from its command-line arguments alone, so an alias deployed through it came
back as a **second full copy of the app**: store pages answered from the old host and
`cron_owner` flipped to `true`, meaning the daily sweep was scheduled from two origins
4× a day. `deploy.sh` printed `200 -> ` for that and moved on. Now: the fallback
passes the var, `deploy.sh` warns loudly unless the alias answers `301`, and
`prod_check.sh` asserts the `301` plus `cron_owner:false` in its ordinary run — verified
live, `alias redirects a saved store link: 301 -> https://tapstall.simalidudu.workers.dev/s/mamatoe`
and `{"cron_owner":false,"version":"0.6.8"}`. The alias's inherited schedule still
exists (this token cannot delete it; the API refuses), and that is the documented
design: `scheduled()` returns first when the var is set, which is the thing the var is
for. A KV write budget spent on duplicate sweeps is how a $0 plan becomes an outage.

**Unverified here, by nature:** what the composed WhatsApp message looks like on a phone
(a `wa.me` link is opened by the browser) and whether the two sentences read well to a
buyer. Both are copy, not behaviour, and both are one edit in `core.js` away.

## Every rail says how the money gets found (2026-10-12, v0.6.7)

**The problem was the last five minutes, again.** A merchant on a hand-checked rail
does not lose money at checkout; they lose it standing in front of a wallet app with
four "pending" orders and one amount. Two shops can be on the same rail and need
opposite things — an EcoCash seller reads the confirmation code as a nicety, a ZIPIT
seller cannot match a transfer without one, and a PayFast seller has nothing to ask
for. So a rail now carries a *policy*, not just a number: `proof` is `none`, `ask` or
`require`, derived from what the rail is and overridable in the dashboard, where the
merchant can also rename the field, because their buyers know their word for it.

**What the buyer sees** is one line, on the form, with the shop's own label and a hint
about where the code lives ("what the wallet app or the confirmation SMS shows after it
sends — not the order code") — every app hides it differently, and that sentence is the
difference between a code and a shrug. On a `require` rail the tap is met once by a
focus and one firm sentence, and then the order sends anyway.

**Never a wall.** A missing code is a flag on the row — `no reference from your bank —
ask them before sending` — printed in the badge line of the ledger, carried into the
WhatsApp handoff (`· proof SLP 88123`) and into the CSV. It is not a 422: the field a
merchant forgot to fill cannot be allowed to cost them an order, and a buyer who hits a
required field they cannot answer goes nowhere. This is the same rule the payer field
follows and the reason "require" is a word about *asking*, not about *blocking*.

**Where the values live.** On the order document and the list row, nowhere else.
`publicStore` publishes `proof`, `proof_label`, `proof_hint` and `ask_payer` — the
policy — and never a code; `config.json` therefore says what a shop needs and stays
safe to cache publicly. `priceOrder` freezes `proof` and `proof_label` into
`pricing.rail` for the same reason it freezes the fee: the slip gets printed later,
after the store may have changed, and a rail removed or renamed must not rewrite an
order's instructions.

**Two real bugs, both caught by the suite written for this:** the slip's `proofMode` /
`payer_from` block sat *below* the `steps` array that reads it — a temporal-dead-zone
`ReferenceError` in `payInstructions`, which would have thrown on a live order after it
was already stored; and the merchant's CSV gained two row values without two header
names, which is the quiet kind of corruption where Excel shifts a whole month's book.
The second is now structurally impossible: a test counts the columns in the header and
the elements in the row at bracket-depth one, and the dashboard's `autoProof` mirror is
compared to the Worker's `proofDefault` for every type × spec pair.

**Verification.** `node --test tests/` → **159/159** (core 58, live 64, limits 10,
pages 27): a zipit store asks and flags, a described M-Pesa rail demands its own code
under its own name, a code is kept character-for-character (` REF-99.x/1 ` arrives as
`REF-99.x/1`, never upper-cased, since banks print lowercase), a wallet payer is
narrowed to dialable digits, `+263 77 123 4567` → `+263771234567`, and no public
surface — config, feed, lookup, storefront — carries a buyer's reference.

**Browser-only, unverified here:** the nudge's focus behaviour and the settings drawer's
three-way picker on a phone. Everything they depend on is asserted in the suites.

## A merchant can put a picture on the shop (2026-10-11, v0.6.6)

**What changed.** `logo` and every item row now take a file, from the same control:
drop it on the square, click Browse, or paste a link — for the shop mark and for each
item, plus the add-an-item form. Drag-and-drop is bound with `dragover` + `drop` +
`preventDefault`, so dropping lands the picture instead of navigating the dashboard
away to it. The browser squeezes to 120 KB (quality first, then the box, then it gives
up honestly rather than shipping a blurry 400 KB); a small PNG or WebP is passed
through untouched, because flattening a transparent logo to a white square is not
"helping". A `Take off` button clears either.

**What is stored is a path, never the bytes.** `/i/<store>/<id>` in the store
document, the file in its own KV key. The store doc is read on every page view and
every priced order, and 1 GB of KV across every merchant is the ceiling this runs at:
twelve thumbnails as bytes in the document would be twelve KV reads per view and a
store doc in the hundreds of kilobytes. Proved in a test (`the store document keeps
the path and never the bytes`) and in prod check (`the store document stays a
document (2,103 bytes)`).

**Serving.** `GET /i/…` is public (it is a photo of the food), typed from the bytes it
sniffed, `X-Content-Type-Options: nosniff`, and `Cache-Control: public,
max-age=31536000, immutable` — honest because an id is never reused, so a new picture
is a new path and no cache anywhere has to be invalidated. `ETag` is the id, so a
buyer's reload costs a 304 and no KV read at all, which is the answer to the
100,000-reads-a-day budget rather than a reason for a new bucket.

**Why KV and not R2, measured:** KV's value ceiling is 25 MiB (docs, checked today), so
a photo fits 100× over; what decided it is that R2's public read needs a custom domain
on the free plan, and a logo that only loads after the merchant buys a name is not a
feature. Storage total: 60 pictures a store, refused at 429 with a sentence that says
what to do about it.

**Refusals, in the merchant's words.** SVG is refused by name on both sides of the wire
("SVG is refused because it can carry code") because a picture that can run script
would run it with the merchant's session cookie; a GIF too; anything that does not
sniff as JPEG/PNG/WebP; over 200 KB with the number it wanted; and an upload with no
session answers 401, the same answer as a store that does not exist, so a guesser
learns nothing. Refused uploads spend **no KV write** — asserted, because a 1,000-a-day
budget is a thing a hostile trickle can spend.

**Storage hygiene is a sweep, not a promise.** Every menu save and every logo change
lists the store's own `img:` keys and deletes what no document points at, so "60
pictures" can only be said when it is true and an abandoned upload does not sit on the
1 GB forever. A list is not one of the 1,000 writes.

**Proved:** `node --test tests/` **142/142** (49 core · 60 live · 10 limits · 23 pages).
Against production: **137 passed / 0 failed / 35 blocked** — the blocked ones are the
assertions that need a KV write, and today the account's 1,000 were spent by the day's
four deploys; the refusals, the 401, the store-document size, the public shape of the
route and the shipped page all ran for real. Live checks run this release: upload →
`/i/` 200 with identical bytes → 304 revalidation → SVG 422 → 260 KB 413 → anonymous
401 → logo saved and visible in `config.json` → store doc still 2,103 bytes → logo
restored → the freed file returns 404.

**One thing still true at handover:** `/a` is served from KV, and KV would not accept a
write when this shipped, so merchants see the new picture control from the next
deploy after 00:00 UTC. That retry is now automatic rather than something to remember:
`deploy.sh --templates` (pages only, spends a write only where KV differs from git, then
reads every page back against git and fails if a customer is being served an older
copy) is run by a new scheduled CI job at **00:20 UTC daily**, so the page ships itself
and a night where it does not is a red run, not a rumour.

**Two harness lies this round caught and killed:** `tests/live.test.mjs`'s flood test
asserted `≤6` writes across the whole namespace, so a legitimate mid-loop fold of the
store document read as a throttle regression — it is now per key (`pinl:mamatoe` ≤ 4,
one per freeze tier) plus a looser total. And `prod_check.sh` asserted two page-shape
facts against the *served* page while a spent KV budget held that page at an older
revision, which is a blocked check, not a failed one: they read the shipped file now and
the live-vs-git question is stated once, in section [6].

## Rails that know their own number, and a week that means something (2026-10-11, v0.6.5)

Items 2 and 3 off your list, in one release because they met in the same place —
the line on the slip a buyer reads.

**A payment number per rail.** One `pay_account` for a whole shop was a guess about
how people get paid. It isn't: the EcoCash USD wallet, the ZiG wallet, the ZIPIT
account, the ShapID and a PayFast store ID are five different shapes, and a buyer
told "send it to the account" picks whichever one they find first. So:

| Now | Detail |
|---|---|
| `st.rail_accts` | `{ ecocash_usd: { acct, holder, till }, zipit: { acct } … }` — each method holds its own |
| `RAIL_SPECS` | every rail says what its number *looks like*: `phone` (9–15 digits), `bank` (6–20), `shapid`, `wallet`, `link`, `none` |
| `cleanAcct` | validates against that shape and **throws a sentence** — `account number: 6 to 20 digits, no spaces` — which `validateSettings` now puts on the field, so a wrong-shaped number is named, not "invalid" |
| `payInstructions` | quotes the rail's own number, its till, and a step that was missing: **"Check it reads “MAMA TOO CATERING” — if it does not, do not send"** — the one check a buyer can make before money leaves, which is what a wallet swap defeats |
| `publicStore` | publishes **one** number (the method on offer) plus the name and till. `rail_accts` itself is never public: your ZIPIT account is not the storefront's business |
| `buyer.payer` | on a manual wallet the buyer is asked, optionally, what number they'll pay from. It rides on the slip, the WhatsApp handoff (`· from 0718663235`) and the dashboard, because the merchant's whole reconciliation is matching an SMS alert to an order |
| `ask_payer` | the question appears **only** where it explains a payment — `spec: phone|wallet` and `type: manual`. Card links and cash never see it |

`pay_account` stays underneath as the default, so nothing built before this breaks; a
rail with no number of its own says "falls back to your default" in the dashboard and
prints the default on the slip. **The whole map is a money field**: staged 15 minutes
like a payout change, cancellable, because repricing where money lands is exactly
that class of edit.

**The custom rail, developed.** `rail_def` now carries `spec`, `holder` and `till` —
so "MTN MoMo, phone-shaped, name check, has a till" is a rail the platform validates,
prices and prints properly, with no operator in the loop. A number posted for a
custom rail is checked against **the shape being written in the same POST**, not the
one stored before it.

**Opening hours are a week, not a sentence.** `st.week` = seven days, each closed or
one or two `from → to` slots, in the shop's own clock. `st.hours` — the string every
existing surface already prints — is now *generated* from it (`Mon–Fri 09:00-17:00 ·
Sat 08:00-13:00 · closed Sun`), so the chip, the config, the WhatsApp line and the
preview cannot disagree with the editor. `openNow()` answers *is it open*: today's
slots, **and yesterday's if they run past midnight** (18:00–02:00 is open at 01:00 —
the case a day-indexed table always forgets), plus `Closed — opens tomorrow at
09:00`. Both markets are UTC+2 with no DST, so it's a constant, and the one place to
change if that stops being true.

Two decisions worth stating:
- **A store with no week is open.** `known: false`. The alternative is shutting every
  shop that predates this feature because they never typed a calendar.
- **An order sent while closed is taken, and flagged** (`sent while closed — Closed
  right now`), and the buyer sees the same words on the receipt. Refusing a hungry
  customer at 22:00 is a way to lose them to a competitor; the merchant decides.

**Found on the way, both by tests:** `riskFlags()` — repeat-unpaid, high-value cash,
missing payout account — **had never been called from `placeOrder`**; the risk engine
was a function and a dream, so flags now come from the buyer's history *and* the
cart *and* the clock. And `priceOrder` froze a rail without its `spec`, so the "ask
who is paying" question would have vanished from every slip printed later.

**Refusing to lose data:** one unreadable time box is now a 422 (`a time needs both
ends, like 09:00 to 17:00`) instead of being read as "closed" — a validator that
treats garbage as an empty day is a validator that deletes a shop's hours on a typo.
A genuinely blank day still means closed, and `week: []` still means "take the week
back off", because a setter that cannot unset is a trap.

**Proved:** `node --test tests/` **126/126** (42 core · 53 live · 10 limits · 21
pages; was 111). Nine new production assertions in `prod_check.sh` run the same
paths against a live store and leave nothing behind: the held `rail_accts` is
verified *not* to be readable before its fuse, the week is verified to rewrite the
sentence, `rail_accts` is verified absent from `config.json`, the half-typed week is
verified refused, and then revert + restore put the store back exactly as found.

**And the harness was the bug, not the shop.** The first two runs after this deploy
reported three reds, all greps on the served dashboard. `ck`/`nk` decided with
`printf '%s' "$page" | grep -qE …` while the script runs under `set -o pipefail`, and
`grep -q` returns the moment it matches: the SIGPIPE that then kills `printf` becomes
the pipeline's status (141), so the taken branch is "not found". It only bites inputs
larger than the 64K pipe buffer whose match sits early — i.e. `admin.html`, and
nothing else. `/a` was byte-identical to the deployed file the whole time, twelve
fetches in a row. Both helpers now write the value to a temp file and grep the file
(one process, one verdict, and the `got:` excerpt reads the same bytes), and section
[6] asserts the served dashboard's length equals the deployed one before it asserts
anything about its contents — that check alone would have ended this in one line.
Two consecutive runs: **152 passed, 0 blocked, 0 failed**.

**Still owed:** image upload with browse/drag-drop (#1), and the rest of #5 — of
which one item is yours, not mine: a verified sending domain, without which email
transport stays off and PINs keep arriving through you.

## The shelf belongs to the store now (2026-10-11, v0.6.4)

You opened `mamatoe`, looked at the Shop card and said the quiet part: *4 items ·
re-read every 120s* — **"i need to edit the store and items in the dashboard,
especially items. no need for opening sheet."** Building that is what found the
hole underneath it, so this entry is in that order: the hole, then the door.

**The hole.** `placeOrder` took `body.items` from the browser and handed it to
`priceOrder`, whose per-line `price`, `options[].up` and `addons[]` were all read
off the posted cart. The storefront's JavaScript is public. So this was a
deliverable order, end to end, with a real payment instruction:

```
POST /api/order  { items: [{ name: "Whole leg of lamb", price: 0.01, qty: 40 }] }
→ 201 · unique cents computed on 0.40 · reference minted · merchant's method is
  "the exact amount arrived, so it is theirs" → 40 legs of lamb for 40 cents
```

Nothing in the 0.6.x hardening touched it, because every path *around* it was
tightened (sessions, PINs, confirm headers, holds on money fields) while the money
itself still entered from the client. A dashboard that can edit items is the fix,
not a feature next to the fix: prices had to stop being the browser's property.

**The door.** `worker/core.js` gained a menu layer; `worker/worker.js` one route.

| Piece | What it does |
|---|---|
| `sanitizeMenu` / `sanitizeMenuEdit` | What a posted menu may contain: 200 rows, clamped prices, ids that fit a key, `out:true` → `available:false`. A half-typed row is dropped rather than 500-ing the save |
| `applyMenu` | Sheet rows + the store's edits = the shelf. Non-mutating, so the cached sheet stays the sheet and Revert is a real promise |
| `menuPrice` | Prices a cart off that shelf: id first, name as the fallback, invented add-ons and choices worth 0, qty 1..99. A stale cart is re-priced and *named*, not refused |
| `POST /api/menu` | Signed in like any other write (session **or** API key) and it needs the `x-tapstall-confirm` header, because repricing a shop moves money by proxy |
| `loadProducts` | The single seam: it returns `applyMenu(products, st.menu)`, so `/s/<h>/feed.json`, the storefront page and the order path cannot disagree about what is on the shelf |
| `placeOrder` | Prices from `menuPrice`, stores the menu's names and prices on the slip, and puts `repriced X: 0.01 → 9.75` in `risk_flags` so the merchant sees the cart arrive with different numbers |

**Also in this release, because the item editor made them reachable:**

- **A Google Sheet is now optional.** `POST /api/register` refused to make a store
  without one. `feed_url` blank is legal now (a *malformed* one is still refused —
  a typo is how "0 items" and a lost week of orders starts), the first message to a
  new merchant tells a sheetless owner where to type, and the empty-shelf warning in
  the dashboard says *"Add an item below"* instead of *"share your Sheet"*.
- **PIN recovery had a dead end.** Its second detail was `pay_account`, else
  `feed_url` — and a brand-new store with neither could not recover its PIN at all.
  `owner_email` is the third option, and it says which one it asked for.
- **Two labels in the dashboard were reading keys the API never sends** (`p.out`,
  `p.category`), so the "out of stock" badge and the group name in the item list
  have never once displayed. They now read `available`/`cat`.
- **`cache_seconds` is real.** The storefront used to re-fetch your sheet on every
  page view (and the dashboard printed a refresh interval that governed nothing);
  both now honour the setting, and only the dashboard's **Re-read my sheet** forces
  a fetch. A *menu edit* still shows instantly, because overrides are applied after
  the cache, never inside it.
- **The Shop card prints the number it promised**: the cache interval comes from
  your store's setting now, not a hardcoded 120.

**Proved, not asserted:** `node --test tests/` is **111/111** (was 103 — 32 core,
50 live, 10 limits, 19 pages). Four of the new ones drive the actual HTTP handler:
a cart of 3 × 0.01 becomes 29.25 and the ledger row agrees; an invented
"Extra everything +500" and a "Gold leaf 400" add-on come to exactly the menu's
9.75; a row hidden in the dashboard returns 422 with *"reload the page"* rather
than a 500; and `nomenuyet`, a store registered with no sheet at all, still trades
— with `no menu on file: priced from the browser` written on the order so nobody
pretends it was checked.

Four existing tests had to change, and it is worth saying why rather than burying
it: they ordered `Jollof and chicken`, `Waakye`, `Waakye special` and `a` at round
prices because ordering an invented item used to be free. Those rows are now in
the stub sheet at the same prices, so each test still tests its own thing (rails,
fees, receipt-vs-preview) and the money rule stays airtight with no exception
flavoured "for tests".

**Proved on production, not just in the harness.** `scripts/prod_check.sh` with
`PIN=919414` → **141 passed, 0 blocked, 0 failed** (the harness grew from 138: it
had to stop inventing its own probe item, and now orders mamatoe's first real shelf
row and asserts the order came back priced `2.5` — the menu's number — plus a second
order attempt for "Whole leg of lamb @ 0.01 × 5" that must be refused, which it is,
with `Reload the page`). And on `kotaking`, live, from an empty jar: sign in with key
and PIN, save a menu (`2 litre Coca-Cola → 1.11`, hide one row, add "Probe pie"),
watch `/s/kotaking/feed.json` answer with `2 litre Coca-Cola@1.11* | Sadza + beef@6 |
Vanilla ice cream@2/out | Probe pie@3.33`, order the hidden row and get the 422,
then revert and find the feed **byte-identical to before** (`cmp` clean) with
`menu(sess) ; menu(sess)` sitting in the audit log. One thing that check noticed on
its own: `/api/menu` *without* the confirm header was answering 200 until a test said
so — the price of a shop was one CSRF away from being anybody's to change.

**Not done, still owed from your five:** image upload with browse-and-drop,
real opening hours (days × from/to), a payment number per rail with mobile-money
handled properly, and the rest of the production pass. The email transport is still
`email: false` — that one needs a verified sending domain from you and nothing I
write can substitute for it.

## The dashboard became one page (2026-10-11, v0.6.1)

Same instruction as the login, applied to what is behind it: *"completely trash
the existing customer login **and customer dashboard** … no over complicated
system."* Six tabs and four explanatory paragraphs became **four cards on one
scroll**, because on a phone at a counter a tab is a decision and a paragraph is
a chore.

| Before | Now |
|---|---|
| Tabs: Orders · Menu · Store settings · Plan · Share · Log & security | One page: **Today**, **Shop**, **Your store link**, **Sign-in** — nothing to navigate, the day's work is at the top |
| A row of order buttons: `Mark paid · Undo · Cancel · WhatsApp buyer · Copy details` | One wide green **Paid — money arrived** per waiting order; undo, cancel, message the buyer and copy the slip are one tap down inside the row |
| Four stats counting the whole ledger (orders, value, cash due, flagged) | Four stats about *today*: to confirm, taken today, cash to count, flagged — and the flagged box only turns red when something is flagged |
| `<p class="hint">` sermons about the 15-minute hold, the sheet being the menu, what a buyer sees | The hold marks the field it governs (`· 15-min hold`), the queued banner counts down, and the buyer preview is a disclosure that answers the question instead of describing it |
| `#feedWarn` warning strip + a second menu panel + a duplicate menu-link box | One Shop card: item count, when it re-reads, the error if there is one, `Re-read my sheet`, and the sheet link living in the settings grid like every other field |

Nothing was **removed** from what a merchant can do: mark/undo/cancel, the five
filters (cancelled got added, it was only reachable as a stat before), re-read
feed, all 26 editable fields with their held/soft split, custom rail, cancel
queued, export CSV, print day sheet, QR poster, status text, buyer preview,
plan/renew/paused notice, masked log, change PIN, sign out here, sign out every
device + new API key. What changed is where each thing lives and how many words
it takes.

Server side: **not one byte of the contract moved.** Same `POST /api/admin`
payload, same `/api/mark`, same 15-minute hold, same rails, same audit. This is
a front-end rebuild on purpose — the API and its 46 live tests are what carry the
money rules, and re-deriving them under a new skin would have thrown away every
fix they encode. `VERSION` 0.6.0 → 0.6.1 because the merchant-visible surface
changed; `/a` is the whole product and it was rewritten.

Verification, and its edge: 102/102 across four suites (28 core, 10 limits, 46
live, 18 page checks) — which for this file means the inlined JS parses (`new Function`),
every `q('#id')` it reaches for exists in the markup, no id is duplicated, no
remote script or stylesheet is loaded, the preview still frames only `/s/<handle>`,
and the sign-in card still meets the two-fields-one-button-zero-instructions bar.
What that does **not** prove is runtime rendering in a browser: no browser or DOM
library exists in this sandbox, so nothing here clicked a button. The first
`↻ refresh` on a real phone is the remaining check, and it is the one thing I
cannot do from here — the live page is at `/a`, and `mamatoe` / `499078` signs in.

## The front door became a key and a PIN (2026-10-11, v0.6.0)

The magic-link scheme was not weak in theory — a 105-character HMAC capability,
7 days, one-use, revocable, no password to phish. It was weak in **explanation**.
Asked how a merchant signs in, the honest answer was "a link is minted, emailed or
shown, opened, traded for a code, which exchanges for a cookie, and if the `&`
survives the chat app". A product whose onboarding sentence needs a diagram loses
to a product whose sentence is: **"your key is `mamatoe`, your PIN is 482913."**

So the customer login and its entry screens were deleted and rebuilt, not patched.

| | |
|---|---|
| Sign in | one screen, two fields (`store name`, `PIN`), one button, no instructions |
| The key | the store name — never a secret, it is already in `/s/<handle>` |
| The PIN | 6 digits (7–8 allowed), `PIN_NORMALIZE` strips spaces and dashes so "482 913" pasted from a chat works |
| At rest | `st.pin = {v,kdf:'pbkdf2-sha256',iters:8000,salt,hash,set_at}`, per-store salt, PBKDF2-SHA256 |
| Sessions | `tp_sess` HMAC cap `{a:'sess',h,g}`, 12 h, killed by bumping `st.auth_gen` |
| Wrong answer | `'Store name or PIN is wrong.'` — identical bytes for a wrong PIN and a store that does not exist (both branches run a KDF; the unknown store is checked against `PIN_GHOST`), so the form is not an enumeration oracle |
| Freeze | per key: 6 wrong → 60 s, 10 → 10 min, 15 → 1 h, 22 → 12 h |
| Lost it | "I lost my PIN" on the same screen: store name + the contact you gave + your payout account or menu-sheet link → new PIN, shown once, `auth_gen` bumped, every other device dead, throttle and queued change cleared. No operator, no waiting. |
| Never sent | the PIN, the salt or the hash — not in any response, URL, log line or audit row (`PUBLIC_KEYS`/`adminStore` strip `pin`; the ledger records `fields:['pin']` and nothing else) |

**Why 8,000 iterations and not "as many as possible".** This Worker has a 10 ms CPU
ceiling per request. Measured warm on the runtime: 3k → 1.12 ms, 6k → 1.91 ms,
10k → 3.04 ms, 20k → 5.62 ms; at 50k+ the request died with error 1102. 8k is the
largest cost that cannot be turned into a cheap CPU attack by anyone who has learned
a store name. Against it, 6 digits are worth ~1.6 years at the old unfrozen rate
(1,728 guesses/day) and ~547 years at the rate the tiers actually allow, because
only a tier *entry* is persisted — one KV write per escalation, never one per guess.
That invariant is now a test: 60 wrong PINs cost ≤6 writes (they cost 60 before the
last pass, which is the same bug that made `POST /api/register` return 503 the day
the write budget ran out). Raising `PIN_ITER` later needs no migration: a PIN hashed
at the old cost is re-hashed on the next successful sign-in.

**What this gives up, stated plainly.** A 6-digit PIN is guessable by someone who can
make enough tries, and the counting that prevents that lives in isolate memory with
only the tier crossings in KV. An attacker who can spin unlimited fresh isolates —
or who can read this KV namespace — is not stopped by it. The old scheme was
unguessable. The exchange is deliberate: the attack that actually happened to this
product was a merchant standing at a login box holding a mangled link, and every
*other* axis moved forwards — no credential in a URL to be screenshotted, previewed
by a crawler or pasted into a group chat, no 7-day link to expire mid-transaction,
revocation still one write, and recovery no longer needs anybody.

**Retired, each with a door that says so rather than a silent 404:** `?code=`,
`?token=` trade-up, `st.admin_url`, `issueLogin`, `loginExchange`, `recoverLink`,
`CODE_TTL`, `POST /api/login` → 410, `POST /api/recover` → 410,
`POST /ops/api/link` → 410, and the ops `action:'link'` lever → 410 pointing at
`reset_pin`. Deliberately *not* a synonym for `reset_pin`: a console that believes it
is issuing a week-long credential must be told that is over. Buyers are untouched —
`/c/<code>` confirm caps, `/renew/<token>`, `x-tapstall-admin` and the order path are
the same code they shipped at 0.5.3.

Kept on purpose: the orders panel, the pending/queued settings flow, the rails
system, the ledger and the storefront — dozens of hard-won fixes and most of the
101 tests live there, and none of them had anything to do with how you get in.

**Migration.** Both tenants in KV (`mamatoe`, `kotaking`) pre-date the PIN, so each
needs one `POST /ops/api/store {action:'reset_pin', handle}` to be handed a PIN; the
console row reads `no PIN` until then and the drawer shows `PIN since <date>` after.

One thing the log said about all this, unprompted: at 14:38–14:39 three
`pin_reset · via:ops` rows landed on `mamatoe` from the operator's own IP — the
console's *New sign-in PIN* lever, pressed by a human, twice in two minutes, while
this rebuild was still in flight. That is the exact behaviour the lever exists for,
and the reason `prod_check` no longer calls a stale `PIN=` a failure: it now reads
the store's `pin.set_at` and reports the check as not verifiable today, because the
truth is "somebody with the shop changed the PIN", not "the door is broken".
`PIN=919414` afterwards: **138 passed, 0 blocked, 0 failed**, real session and all.

**Measured on production after the deploy (run #40, `0.6.0` on both origins).**
`scripts/prod_check.sh` → **138 passed, 0 blocked, 0 failed**, including a real
sign-in from an empty cookie jar, the HttpOnly/SameSite=Strict/Secure flags, and
`"kdf"|"salt"|"hash"` absent from the ledger payload. `/__selftest` reports
`pin_kdf:true, pin_iters:8000`. The alias Worker is on the same version: page GETs
301 to the canonical origin, and `POST /api/auth` is answered there rather than
redirected, so an old saved URL still gets a merchant in. Both tenants were handed
PINs through `reset_pin` and signed in (`mamatoe`: 30 orders read back, `kotaking`:
9), and three deliberate wrong-PIN probes left `pinl:*` empty — `count:0` — which is
the write-budget invariant, checked against the live namespace rather than the stub.
`/api/register` mints the PIN itself and prints it on the same screen the store link
is printed on, with Copy both / Send to myself on WhatsApp — the credential handover
is part of signup now, not a step somebody has to remember.

## The rename: ZimLink → Tapstall (2026-10-10, v0.5.0)

The name was a research artifact — Zimbabwe-shaped because that is where the
tariffs were verified — and the brief is now "anyone on WhatsApp the global
platforms will not serve". A country in the name says the opposite of that. So:
product, repo (`king-kunta-cpu/tapstall`), Worker (`tapstall.simalidudu.workers.dev`),
Pages mirror, mail subject, ICS `PRODID`, day-sheet file
names, the storefront poster default. Older entries in this file keep saying
ZimLink: that is what was true when they were written.

What did **not** change is the point of the exercise — a rename must not cost
anybody anything they had already:

| Carried by | How |
|---|---|
| Every link already sent (`/s/<handle>`, `/a?code=`, `/c/<cap>`, `/renew/<token>`) | the old Worker is deployed too, from the same code and the same KV, with `REDIRECT_TO` set: page GETs 301 to the canonical origin, everything with a body is still served there, so a browser mid-order never loses it. Its inherited cron still exists (the API refuses to delete it with this token: `PUT /schedules` → `success:false`), but a Worker with `REDIRECT_TO` returns from `scheduled()` before the sweep and `/__selftest` says `cron_owner:false` — so two Workers on one KV never sweep twice, and the deploy reads that flag instead of hoping a dashboard click happened. |
| Merchant and operator sessions | cookies are written as `tp_sess`/`tp_ops`, read as either. `auth_gen`/`ops_gen` still govern validity, so revocation works under both spellings; signing in clears the old name so "sign out" cannot be defeated by a cookie we accept on purpose. |
| Pages cached in a phone | they post `x-zimlink-confirm`/`x-zimlink-admin`; both are accepted, and CORS allows both. |
| Templates still in KV | `fillPage()` replaces `/*__TAPSTALL_*__*/null` **and** `/*__ZIMLINK_*__*/null` in one pass, so the Worker does not have to be deployed in the same second as the pages (and today it cannot be: no KV writes left). |
| A buyer's basket, a merchant's half-typed sign-up | `zl_cart_*` and `zl_onboard` are read, copied to the new key and only then removed. Losing a cart to a rebrand is not a rename, it is a lost order. |
| Merchant webhook integrations | `x-tapstall-body` is sent alongside `x-zimlink-body`; `x-tapstall`/`x-zimlink` response headers both carry the version. |
| A Flutterwave payout link | the slug became config (`FW_PAY_SLUG`, default `tapstall`) instead of a string welded to the old brand. |
| `VERSION` | 0.4.3 → 0.5.0: a hostname change is not a patch. |

Two guards were added while doing it, because the dangerous part of a rename is a
step that *succeeds quietly*:

* `kv_id` now searches the new namespace title, then the old one, and creates only
  if neither exists. A miss does not fail, it makes an empty namespace, and the
  deploy would then "work" against a store list with nothing in it. Testing that
  line is exactly how I created an empty `tapstall-stores` — caught it (0 keys),
  deleted it, wrote the guard.
* `deploy.sh` refuses to publish if the resolved STORES id differs from the one in
  `.deploy/state.json`, or if the namespace reports zero keys.

**The KV namespaces keep the titles** `zimlink-stores` and `zimlink-orders`.
Cloudflare refuses a namespace rename — `PATCH /storage/kv/namespaces/<id>`
answers `405 {code: 7001, "PATCH not supported for requested URI"}`, measured
today — and a title is visible to nobody but the deploy script, which binds by id.
So `kv_id` searches both titles, prints which one it settled on and why, and
creates nothing until both miss; the run resolved `b5c1c89d…` (25 keys) and
`4f4ac94a…`, the same ids as always. Chasing the label would be a data migration
wearing a rename's clothes.

Not done, deliberately: `no-reply@simalidudu.workers.dev` stays the send address —
it is what the Email binding will allow, not a brand choice. The orphan namespace
`zimlink-store` (b32c2fe9…) is still there for you to delete. `LEGACY_WORKER_NAME`
is one line to remove once the old hostname stops getting traffic.

## Live right now (measured 2026-10-11, 13:0x UTC — after the KV republish)

The rename is finished on the surfaces, not only in git: the eight pages that were
waiting on the day's write budget are published, and every brand-sensitive path now
answers `0` matches for `ZimLink`. `scripts/prod_check.sh` → **129 passed, 0 blocked,
0 failed** at 0.5.1 — the first fully green stretch of runs (every earlier one had ~15
write assertions the quota turned off).

| What | Where | Proof |
|---|---|---|
| Worker (canonical) | `https://tapstall.simalidudu.workers.dev` | `/__ping` → `{"ok":true,"version":"0.5.1"}`; `/__selftest` → `ok:true`, only `email` false (no SMTP is a choice, not a gap) |
| Brand sweep, served | `/`, `/fees`, `/onboard`, `/ops`, `/s/mamatoe`, `/s/kotaking`, `/a` | `0` matches for `ZimLink` on each, and `0` matches for `*/null` — the literal signature of a config hook nobody filled |
| Titles, as a customer sees them | same seven paths | `Tapstall — a WhatsApp store your customers can actually pay` · `What your WhatsApp orders actually cost you — Tapstall calculator` · `Tapstall — set up your WhatsApp order desk` · `Tapstall Store` · `Tapstall · operator` |
| KV vs git, byte for byte | `tpl:store onboard admin fees index confirm renew ops` | published today: `store 25,301 → 26,714`, `onboard 35,692 → 38,180`, `admin 49,711 → 51,908`, `fees 11,117 → 11,119`, `index 2,997 → 2,998`, `confirm 17,115 → 17,119`, `renew 17,621 → 17,626`, `ops 37,364 → 42,228` — right-hand figures are git's sizes, so served == shipped. `sample-menu.csv` was skipped as identical, which is the same code path a re-run takes |
| Previous hostname | `https://zimlink.simalidudu.workers.dev` | same build. `/`, `/fees`, `/onboard`, `/ops`, `/s/mamatoe`, `/a?code=…`, `/c/abc`, `/renew/x` → `301` to the canonical origin with the **query preserved**; `POST /api/login`, `/api/order`, `/api/lookup` → `401`, `422`, `404` — answered by the app, never bounced, because a rename must not eat a request body |
| Operator console | `/ops` | served copy is the renamed one; a live `tp_ops` cap reads `/ops/api/state` → 2 stores, 0 attention, no `admin_token`; the same cap under **`zl_ops` → 200**; login sets `tp_ops` and clears `zl_ops` |
| Merchant API | `/api/admin?handle=mamatoe` | `200` with 22 orders, `via:"key"`, under **either** `x-tapstall-admin` or `x-zimlink-admin`; no header → `401` |
| Markets & rails | `/rails`, `/ops/api/rails` | 9 built-in + 0 added = 10 live; `401` anonymous, `422` for a label-less rail; `rail_catalogue_ok`, `rail_custom_ok`, `rail_price_with_own` true |
| Landing + calculator mirror | `https://king-kunta-cpu.github.io/tapstall/` | `/` and `/fees` 200; `index.html` 2,998 B and `fees.html` 11,119 B **byte-identical to git** (CI copies them into the artifact, so the mirror cannot carry a stale draft). The old `…/zimlink/` path is `404`, which is why `PAGES_URL` and `REPO_RAW` moved in the same release |
| Mirror sign-up link | `/tapstall/onboard` | `200` on both `onboard` and `onboard.html`, handing off to `…workers.dev/onboard` and keeping the query string. It was `404` until today — see the mirror paragraph below |
| Alias cron | `/__selftest` on each origin | canonical `cron_owner:true`, alias `cron_owner:false`: the alias still *carries* the inherited schedule (this token cannot delete one) and ignores it in code, so one KV is swept once a day |
| Demo tenants | `/s/mamatoe`, `/s/kotaking` | 4 products from each store's own CSV; `config.json` carries `rail_info`; `feed.json` 200 |
| CI/CD | `.github/workflows/deploy.yml` | run #32 `success` on both jobs at 0.5.0: tests → templates → Worker → **alias Worker** → cron → Pages (`deploy-pages` failed three times on GitHub's side with *Fetching artifact metadata failed*; a `rerun-failed-jobs` call is the whole fix) |

## "Nothing loads" on the merchant dashboard (2026-10-11, 0.5.1)

Reported while opening the tenant dashboard as a client. Measured in order, because
that sentence fits three different failures:

| Probe | Answer |
|---|---|
| `GET /a` | 200, 51,908 B; every id `boot()` touches exists, so the script does not throw |
| `GET /a?handle=mamatoe&token=<legacy>` | `302` to `/a?code=v1…` — a pre-cap link trades itself for a fresh one |
| `POST /api/login {code}` | 200 `{ok:true, valid_for_sec:43200}`, `tp_sess` set, `zl_sess` cleared |
| `GET /api/admin?handle=mamatoe` with that cookie | 200, 23 orders, 27 editable fields, not suspended, `paid_until` 2026-12-08 |
| `king-kunta-cpu.github.io/tapstall/a` | **404** — the mirror hosts `index`, `fees` and the `onboard` handoff, nothing else. A dashboard link opened *from the mirror* is the one way to get a genuinely empty screen |

The dashboard opens. What did not work was **one panel inside it**: "this is your
store" is `<iframe id="shareFrame">` pointed at `location.origin + '/s/' + handle`, and
every response inherits `X-Frame-Options: DENY` + `frame-ancestors 'none'`, the
storefront included, so the browser refused to paint it — a blank white box on every
device for as long as the feature has existed. `FRAMEABLE` now allows same-origin
framing on `/s/*` alone, derived from `SEC_HEADERS` rather than copied, and `/a`,
`/ops`, `/onboard`, `/fees`, `/__selftest`, `/rails` keep refusing all framing.

The fix then found the quieter bug. `hdr()` spread `SEC_HEADERS` in its original casing
and merged overrides lower-cased, so the response carried `X-Frame-Options: DENY`
**and** `x-frame-options: SAMEORIGIN`; `Headers` joins same-name values, so the storefront
answered `DENY, SAMEORIGIN` — and two CSPs are *intersected* by the browser, the stricter
winning. No per-route override had ever been able to replace a security header, which
is also why the fix could have shipped looking like a policy that ignores its own
exception. `hdr()` lower-cases both sides now, so an override replaces.

`prod_check.sh` asserts the pair (storefront frameable, exactly one policy, `/a` still
DENY) and the suite pins both ends: no joined header values, and the iframe's `src`
beside the exception. That pairing is the point — if the preview ever embeds a
different path, the framing exception stops being a feature and becomes a hole.

## Verified on production, not only in tests

- Two tenants isolated by KV key; neither can read the other's config; `/api/admin`
  for an unknown handle returns `{"ok":false,"error":"no store"}`.
- Order → `pay_now` `23.93` on a `23.12` total (PayShap, `pass`) and `23.89` on
  `23.10` (EcoCash, `absorb`, `fee_absorbed_by_merchant: 0.79`).
- One-tap confirmation is now `GET /c/<cap>` (inert page) → browser POST → `paid`,
  idempotent on a second tap (`already:true`, no duplicate row), reversible with
  the 15-minute `undo_url`. Re-measured after v0.3.0 with `scripts/prod_check.sh`:
  **88/88 on `mamatoe` and 88/88 on `kotaking`**, including the Slackbot-UA
  prefetch (order document read straight from KV, still `awaiting_payment`).
- Re-measured again after v0.4.0 with the two consoles added: **124/124 on
  `mamatoe` and 124/124 on `kotaking`**, section [8] covering the open door
  (`/ops/api/{state,health,audit,templates}` → 401 to an anonymous reader, a lever
  without `x-zimlink-confirm: 1` → 401), the cookie's flags (`HttpOnly`,
  `SameSite=Strict`, `Secure`, `Max-Age=43200`), a state read that holds no
  credential (`admin_token`, `secret_hash`, `fw_secret`, `auth_gen`, `admin_url` all
  absent), all eight templates live in KV, the link lever returning a `/a?code=v1`
  capability that expires in ≤7 days, and sign-out making the cookie worth 401.
  Two things the check does on purpose: it counts a dashboard link rather than
  printing it (`ck` echoes 240 bytes of a failing value, and that value is a
  credential), and it re-logs in at the end so its own wrong-guess probes cannot
  walk the operator's lockout counter toward a freeze.
- Expiry → `runCron` suspended the store (`{"checked":2,"suspended":1}`) → orders
  answered `503 store paused — owner needs to renew` → Flutterwave-shaped webhook
  activated it (`paid_until` +365 d, `plan: annual`) → next cron tick clean.
- Rate limit: 8 `POST /api/order` per minute per IP, then `429`, while `GET`s stay
  open. (The flood test's 8 demo orders were deleted afterwards.)
- `publicStore()` leak check green in `/__selftest` and in the served HTML. It is
  now an **allowlist**: the denylist version leaked `pending` (a queued payout
  account) into `/s/<handle>/config.json` for a day until the new check caught it.
- Merchant authority, measured live rather than only in the harness:
  `GET /api/mark` → 405 + `Allow: POST`; `GET /api/settings`/`/api/revoke` → 405;
  anonymous `POST /api/settings` → 401; `OPTIONS` on a mutation path → 403 while
  `OPTIONS /api/order` still answers `*`; no `Access-Control-Allow-Origin`, CSP
  `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `no-store` on every admin response; `/api/lookup` free of `admin_url`,
  `renew_url`, `pay_account`, `feed_url`, `whatsapp`, `admin_token`,
  `notify_email`; a forged or truncated cap → `link_expired`; a login code spent
  on `/api/mark` → `link_expired`; `POST /api/recover` with one right answer →
  403 and a counted attempt; settings with the API key → cosmetic field live at
  once, `pay_account` held with `in_ms` counting down, visible to the owner,
  absent from the public page, cancellable, and recorded in the audit masked.
- Migration, deliberately not forced: `kotaking` and `mamatoe` still hold their
  v0.2 `…/a?handle=…&token=<10 chars>` links and those links still open — by
  trading up for a 7-day code, over a `Set-Cookie`, never by acting on a GET.
  They are now throttled (12 bad tries per 10 minutes per store), no longer
  discoverable from a handle, and one `POST /api/revoke` rotates them to a
  128-bit key. Merchants were not emailed a new link, because the old one is
  not broken; the next revoke upgrades it, and the "Lost your link?" form is
  there whenever they choose to use it.
- Template hot-swap path works: HTML lives in KV under `tpl:*`, updated by one PUT.

## One thing left to confirm, in ~5 hours

The schedule is declared in `wrangler.toml` and wrangler reported
`schedule: 15 6,12,18,0 * * *` at deploy, but Cloudflare's cron-triggers API
refuses both JSON and metadata-only multipart for this token type, so it cannot be
read back over HTTP. Verify without the dashboard:

Note: `runCron` also runs on demand via `/__selftest?scheduled=1`, and the deploy
self-check does exactly that — so a fresh `minutes_ago` right after a deploy is not
proof on its own. Proof is a timestamp that moves at 06:15/12:15/18:15/00:15 UTC
with **no** deploy in between.

```
curl -s https://tapstall.simalidudu.workers.dev/__selftest | jq .cron_heartbeat
```

`minutes_ago` should be under ~365 after 06:15 UTC and never reset by a deploy.
If it reads `never run` long after that, set the trigger once in
Workers & Pages → zimlink → Settings → Triggers → `15 6,12,18,0 * * *`
(you may delete it; nothing depends on it being gone, because the code ignores it
while `REDIRECT_TO` is set — `/__selftest` answers `cron_owner:false`).

The mirror has one defect class the Worker cannot cover for it: a link that resolves
because a *server* implements it. `pages/public/_redirects` said
`/onboard  /onboard  200`, which is Netlify syntax — GitHub Pages uploads files and
rewrites nothing, so the landing page's "Open the store builder" button 404d from the
mirror while working fine on the Worker. Nobody could see it: the Worker serves `/`
from a KV template, and the deploy only checked the mirror's status code for `/`. Now
`pages/public/onboard{.html,/index.html}` is a handoff that redirects to the origin
with the API (query string kept — an invite link may carry a code), `_redirects` is
deleted, and `tests/pages.test.mjs` resolves every internal link in the mirror's pages
against the actual artifact set. The artifact set is assembled by CI (`cp
pages/index.html pages/fees.html pages/public/`), so the mirror cannot carry a stale
draft of a page the Worker serves — the two copies had been kept identical by hand, and
still are, but now there is only one source.
Nothing else breaks if it is missing — expiry checks also run whenever a merchant
renews, and orders are never lost.

## Merchant authority — this round (2026-10-10, v0.3.0)

Why it happened: adding self-serve `POST /api/settings` would have handed the
existing all-powerful `admin_token` the ability to rewrite a payout account.
Instead the credential model was rebuilt first, then the feature was added on
top. Both are in this release.

| Change | Proof |
|---|---|
| `core.js`: `issueCap`/`verifyCap` (HMAC-SHA256, 43-char tag), `validateSettings`, `stageSettings`, `applyPending`, `maskField`, `sign` | unit tests, and `/__selftest` re-runs the same assertions inside the Worker's own runtime |
| Confirm links are `/c/<cap>` pages that POST; `GET /api/mark` → 405 with `Allow: POST` | live test: fetch the page as a crawler would, order still `awaiting_payment` |
| `auth_gen` bump = every link, cookie and key dead in one write; `POST /api/revoke` also mints replacements | live test: old session 403, old code 401 "revoked", new link 200 |
| 12-hour `HttpOnly SameSite=Strict Secure` cookie; codes 7 d (login) / 72 h (mark) / 15 min (undo) | live test asserts the `Set-Cookie` attributes, not just the redirect |
| Money/PII settings held 15 min and applied lazily on the read path; cosmetic fields instant; `POST /api/settings/revert` cancels | live test fast-forwards `apply_at`, then reads `config.json` |
| `order.pay` snapshot freezes what a buyer was told to pay | live test: after the new account lands, the old order's slip still names the old one |
| `/api/lookup` stripped of `admin_url`/`renew_url`; outbound webhook stripped of the credential (now `x-zimlink-body: sign(body)`) | live test greps the public payload for each field name |
| CORS split: `*` on buyer paths, none on admin/mutation paths; CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `no-store` | live test on both halves |
| Self-serve link recovery with 12-per-10-min lockout per store | live test, including a no-email cash shop |
| Settings panel, pending countdown + Revert, masked change log, Revoke and Sign out in `/a` | `pages/admin.html`, served from KV as `tpl:admin` |

Two real bugs the suite caught while it was being written, both now fixed and
asserted: `/renew/<token>` used `randomKey` (base64url), so a `-` or `_` — about
1 shop in 8 — produced a renew link the route's own regex rejected with 404;
and `^\/{1,2}` in the CORS path test made *every* path public, so `ACAO: *` was
still on the ledger endpoint.

Old links are not dead: a v0.2 `?handle=…&token=…` link still authenticates
against the stored key and is redirected to a fresh code, and `GET` on such a
link is answered the same way — never by marking anything paid. Guessing at
either path counts as a failed attempt against the store's lock counter.

Scanner proof, taken from production after the deploy: one probe order's
`mark_url` fetched with six user agents — `WhatsApp/2.24.0`,
`TelegramBot (like TwitterBot)`, `Twitterbot/1.0`, `Googlebot/2.1`,
`Slack-ImgProxy 0.65`, `curl/8.5.0` — each with `-L`, following redirects the way
a preview bot does. Every one returned `200` on the same `/c/…` URL and the order
document, read straight back out of the ORDERS namespace, still said
`awaiting_payment` with `pay.account = 0771234567` (the merchant's real EcoCash
number) and `pay.amount = 0.04`. Under v0.2 the first of those six fetches would
have marked the order paid on its own.

**Throttling, and the DoS it must not create.** Twelve failed credential
attempts per store per ten minutes is what stops a stranger sweeping an old
10-character link or a leaked API key. It is consulted on exactly the paths
where guessing is possible — the `x-zimlink-admin` header, the legacy
`?token=` trade-up, and "Lost your link?" — and never on an HMAC session or a
signed capability. The first version of the gate also blocked the merchant's own
confirm button, which meant twelve junk requests from anyone could freeze a
shop's order flow for ten minutes; the test suite now asserts the opposite
(a throttled store still confirms with a valid link, and still opens its
dashboard with a valid cookie, which also clears the counter).

**The lockout is a brake on guessing, not a kill switch on the owner.** The
first version consulted the counter before comparing the key, so twelve junk
requests from a stranger answered `429` to the merchant's own correct API key.
Caught by repeating the sequence against production — 12 × `403`, then `429`,
then a *valid* key also `429` — and now asserted in the suite: the correct key
(or a correct legacy `?token=` link) always gets in and clears the counter, and
the lock only ever changes the answer given to a credential that is wrong.

## The two UI suites — this round (2026-10-10, v0.4.0)

The product sold itself fine and looked like three different products. Now there
is one design language (`pages/kit.css`), five authored pages (`pages/src/`),
and one generator (`scripts/ui_kit.py`) that inlines the kit into each shipped
file — because a page must render with no network, in a sandboxed preview, on a
2G handset, and the ~9 KB of kit is cheaper than any of those failure modes.
`ui_kit.py check` is the drift gate: it runs in `deploy.sh --check`, in the real
deploy before templates are published, and as a test.

What is new:

* `/onboard` — four steps (identity → menu + rail → money rules → live), per
  field validation, a handle-taken check against `/api/lookup`, and a buyer card
  that shows the odd-cents and surcharge arithmetic before anything is committed.
  The success screen carries the store link, the dashboard link, the renew link,
  a printable QR poster and the WhatsApp status text — the whole distribution
  motion, at the moment of highest motivation. Draft state lives in
  `sessionStorage`, so a dropped connection is not a lost form.
* `/c/<capability>` — the one-tap page. Renders buyer, amount, rail; auto-POSTs
  once, and only when `document.hidden` is false, so bots that prefetch links
  still cannot confirm an order. `<noscript>` posts the same cap to the same
  endpoint; `undo_url` gives 15 minutes; `already` / `expired` / `missing` are
  three distinct states, not one error string.
* `/renew/<token>` — days left, orders, GMV, the price for 365 days or a custom
  term, `POST /api/checkout`, and a box for "I paid by EcoCash/cash — here is the
  reference" that files against the store (`POST /api/renew-ref`, IP-throttled,
  last 10 kept, 30-day TTL) and appears in the operator's attention queue as
  `awaiting_ref`. Filing a reference switches nothing on by itself — the page
  says so.
* `/ops` — the console: KPI strip, attention queue, tenant table with a drawer
  carrying the levers, template editor (publish to KV at once, restore from
  `git main`), health (Worker self-test + cron heartbeat + Pages + last CI line),
  and the change log. Every mutation needs `x-zimlink-confirm: 1`; every lever
  writes the store's own log as well as the operator's.

`/onboard` (35,692 B), `/a` (49,711 B), `/fees` and `/` are each byte-identical
to their file in git, and `/ops` differs only by the filled session hook — which
is what makes the console's "restore from git main" button a real promise.

Four bugs the page tests caught before anything shipped — none of them visible
to `node --test` as it stood:

1. `await hash(x).slice(0, 8)` parses as `await (hash(x).slice(0, 8))` → the
   Templates panel 500-ed.
2. `notify` and `link` were handled *after* the lever dispatch chain, so they
   matched its final `else` and answered `unknown action`: two dead buttons.
3. Patching `admin.html` dropped `<div id="list"></div>`: the orders list would
   not have rendered at all in the new dashboard.
4. The new tab bar reused `id="tabs"`, which the pending-panel Show/Hide button
   already owned: both handlers landed on the button, and the tabs did nothing.

Two design changes that came out of testing rather than taste:

* **`/ops/logout` revokes.** The session is a stateless signed cap, so deleting
  the cookie was cosmetic — the cap stayed valid for 12 hours. Sign-out now bumps
  `ops_gen` in KV (one write), which ends every console session on the platform.
* **A dead cookie costs nothing.** An expired session cap hitting a gate used to
  increment the same 12-try counter as a wrong secret, so twelve refreshes — or
  twelve `prod_check` runs — would freeze the operator's own console for ten
  minutes. The counter now only follows secret guesses at `/ops/login`; forging a
  cookie is hopeless anyway, and the proof of the fix is six dead-cookie probes
  followed by a wrong guess that still shows a full counter minus one.

## Also fixed on the way (found by the new tests, not by a customer)

* **`publicStore` was a denylist and leaked the queued change.** Once `pending`
  lived on the store document, `/s/<handle>/config.json` handed an anonymous
  visitor the payout account that was 15 minutes from going live. `publicStore`
  is now an allowlist (`PUBLIC_KEYS`) and `adminStore` is the credential-stripped
  full record for the signed-in owner, so a field added in the future is private
  until someone deliberately publishes it. Asserted in both test files.
* **The dashboard payload used to carry `admin_url`.** A login code inside JSON
  turns any XSS on the dashboard page into a saved 7-day credential, and the
  cookie it replaces is `HttpOnly`, so the page never needed it.
* **The owner sees the raw queued value** (masked only in the append-only log) —
  a 15-minute "you can cancel this" window is useless if you cannot read what
  was typed.

## The first real capacity event (2026-10-10, ~10:50 UTC, shipped as 0.4.1)

`POST /api/order` started answering `{"ok":false,"error":"KV put() limit exceeded
for the day.","stage":"worker"}` — 500-shaped, opaque, and true. Cloudflare's
free KV tier allows **1,000 writes/day for the whole account**; today's testing
consumed them: three `prod_check.sh` runs (each one creates and cancels a probe
order, files and clears a reference, issues a link, writes audit rows), two CI
deploys (each publishing eight templates), and the lock-counter probes. Reads
(100,000/day) were untouched, so every page kept rendering while nothing could be
written. Fixed, measured and tested rather than explained away:

* **A buyer can no longer be sent to pay for an order that was not saved.**
  `persistOrder` was inside `ctx.waitUntil`, so the write happened after the 201
  and its failure was invisible: the buyer got "send 6.00, reference QTQ-0001",
  the merchant never saw the order. It is now awaited before the answer; only the
  notification runs after. `tests/limits.test.mjs` drives the bundled Worker
  against a namespace whose writes all throw and asserts no 201 is possible.
* **A quota answers 503 in prose, not 500 in internals**: "out of storage writes
  for the day… Nothing is lost and no order was taken", with `retry_in_sec`
  (measured to the UTC reset) and `Retry-After`, the raw platform string kept in
  `detail` for the operator, and — because a CORS failure would hide all of that —
  `Access-Control-Allow-Origin: *` on the error path too, which it did not have.
* **Logging may never break the thing it logs.** `pushAudit`, `pushOpsLog`,
  `authFail` and `authClear` swallow storage failures and return whether they
  wrote, so on a bad day: a merchant's settings save still lands and answers
  `logged:false` with a note saying the log line is missing (the duplicate `note:`
  key that overwrote that sentence with "Saved." was itself a bug this found); a
  wrong secret is still a 403 with a count, not a 500; and `ops/login` still issues
  a session even though its own log write failed — a console that cannot be opened
  during an outage is the worst possible console.
* **Deploys now spend zero KV writes when the HTML is unchanged.** `kv_put_tpl`
  reads the current value and skips an identical file; a refused write is fatal
  only if KV then differs from git. Verified live against the real namespace while
  writes were blocked: all six pages reported `already current in KV`, and the
  byte sizes match the repo exactly (ops 37,364 · store 25,301 · onboard 35,692 ·
  admin 49,711 · confirm 17,115 · renew 17,621).

Headroom, honestly: at roughly four writes per order (order doc, list row, seq,
buyer touch) plus one audit row per merchant action, the free tier is a ceiling of
about **150–200 orders a day across every tenant** — not per tenant. Reads are not
the constraint. The fix when it bites for real is the $5/mo Workers plan (100k
writes), which is exactly the trade the pricing page should make once revenue
clears it; nothing else in the stack needs to change.

## Rails became data, not code (2026-10-10, v0.4.2)

The market question came back a third time — "everyone using WhatsApp for
business who cannot reach take.app: geography, payment methods, the lot". A
name does not fix that; a table in `core.js` was the thing making the product
Zimbabwe-shaped. So the table stopped being the answer.

Now true:

* `GET /rails` = built-ins ⊕ `rails:extra` in KV ⊕ `custom`. Pickers read it,
  so a method is live for the next buyer without a deploy.
* Ops console → *Templates* → **Markets & rails**: add/edit/remove through
  `GET|POST /ops/api/rails` behind the same session and the same second click as
  every other lever. Refuses to override a built-in key; refuses to remove (or
  restore away) a rail a store is still using and names the handles.
* A merchant can describe their own method in onboarding or in Store settings
  (`rail: custom` + `rail_def`), which is a money-class field: 15-minute hold,
  cancellable, public by design because the buyer reads it.
* Validation is shared (`normaliseRail`): label ≥ 2 chars, `pct`/`imtt` clamped
  to 30%, `fixed` ≤ 1000, `type ∈ manual|auto|cod`. An invalid description at
  sign-up degrades to `cash` — wrong-but-safe beats a wrong amount.
* `/s/<handle>/config.json` now carries `rail_info` (the *resolved* rail) and the
  storefront prices from it, so the cart preview and the printed slip cannot
  drift apart. Orders still snapshot the rail into `pay`, so deleting a rail
  never changes a receipt already sent.

What the new tests caught, in order of embarrassment:

1. The catalogue's `custom` placeholder shadowed the store's own description, so
   every self-described rail priced at 0% under the label *we* invented.
   Resolution order is now store-document-first for `custom`.
2. `Math.round(subtotal * rate + fixed * 100) / 100` — precedence. It divided
   every per-payment fixed fee by 100 in the storefront preview and the
   onboarding estimate. Written as a test against the worker's own `priceOrder`
   before it could ship.
3. Moving the unknown-rail rule from `SET.rail` into the caller kept the product
   correct and broke two contracts: the per-field `422 {fields}` shape the
   dashboard renders and the `/__selftest` assertion. Membership is now checked
   inside `validateSettings` via `opts.rails`.

`node --test tests/` is 88 (was 81): +1 rails catalogue/merchant path, +1
self-described rail, +1 preview-matches-receipt, +1 who-can-see-what, +1 quota
wording per reader, +1 selftest-under-quota, +1 the single verdict.

Then CI taught two more lessons on the live deploy (run #22 red, #23 green):

* `kv_put_tpl`'s new quota branch never fired in CI, because `str(HTTPError)` is
  only `"HTTP Error 429: Too Many Requests"` and Cloudflare's `10048` / "free
  usage limit" sentence is in the **body**. So the release was held up by a page
  nobody was waiting for — the exact thing that change was written to prevent.
  The publisher now reads the body, treats 429 as quota, warns with both byte
  counts, and lets the Worker deploy. Verified against a real refusal, not a
  mock: `store NOT PUBLISHED … (26159 bytes in git, 25301 in KV)`.
* `/__selftest` had no verdict at all, and its KV write probe threw straight
  through the fetch handler, so on a quota day the endpoint that explains
  outages *became* one: `{ok:false, error:…, who:"operator"}` and nothing else.
  It now catches the probe, reports `kv_write_blocked` with a clock, keeps the
  other thirty answers, and returns one `ok` computed last over every boolean
  (capability flags — `kv_stores`, `kv_orders`, `email` — listed as such, so a
  missing optional binding is not an alarm). Adding that verdict immediately
  caught `rail_catalogue_ok`, which asked whether `{rail:"cash"}` came back as
  `test_momo`: impossible by construction, red in production for a day.
  `prod_check.sh` follows the same rule — it drops the one assertion that needs
  a write, says why in one yellow line, and still checks every read-side claim.

Then it found a live one (0.4.3). `prod_check` on the quota day failed 17
assertions, and 15 of them were the plan, not the build — so `ck()` now reports a
quota answer as `blocked by the day's KV budget` in its own colour instead of red,
which left the two that were real:

* **two read paths required a KV write.** `getStore` persisted the matured
  pending fold and `loadProducts` persisted the menu cache. Consequence: a
  merchant whose 15-minute hold matures after the budget runs out makes *every*
  storefront read a 503 until midnight, and a buyer who only wanted to see the
  menu got one. Both writes are now best-effort (the fold is idempotent; the
  next read folds again from the same block). Caught by the run, fixed with
  tests that were then reverted to prove they bite: `not ok` ×2 without the
  fix, 10/10 with it.
* **`/ops/logout` promised something it could not do.** `endOpsSessions` swallowed
  its own error, so on a spent budget the reply still said "every console session
  is ended now" while a stolen cookie stayed valid for up to 12 hours. It now
  answers `sessions_ended:false` with the exposure window and the next action,
  and `prod_check` accepts either the 401 or that sentence — never silence. `scripts/
deploy.sh --check` also stopped depending on exec bits (`python3 scripts/ui_kit.py`,
`bash scripts/build_bundle.sh`) because a checkout can lose them and a dry-run
gate must not be the thing that breaks.

The name is still ZimLink, deliberately: the human-visible strings are catalogued
(page titles and chrome on five pages, `/fees`, `/`, one mail subject, one ICS
`PRODID`, one store notice) but `WORKER_NAME`, `PAGES_URL`, `REPO_RAW`, the
`zl_*` cookies and the five `/*__ZIMLINK_*__*/` markers are load-bearing across a
deploy boundary and stored absolute in every tenant document. Renaming the brand
and renaming the hostname are two different operations and the second one strands
every link already sent to every merchant. Say the word and it is an afternoon.

## Known limits (deliberate, not TODO)

1. **No instant mobile-money confirmation** — none exists at $0 in ZW/SA. The
   product replaces the need for it (unique cents + one tap). Wiring a rail API
   later changes no interface here.
2. **`https://flutterwave.com/pay/zimlink`** is a placeholder link slug until a
   Flutterwave account exists. Renewal is still automatic the moment a webhook
   with a matching `tx_ref` arrives (`/api/hook/flutterwave`); until then the
   buyer-visible path is "pay and paste the reference", and the free 60 days
   means nobody is locked out by it.
3. **Email** needs the `EMAIL` binding created once in the dashboard (a
   Cloudflare-own send route, not third-party). Absent it, renewal notices ride
   on the merchant webhook only.
4. **Buyer phone numbers are stored per order.** Fingerprints are hashed with a
   180-day TTL; order rows themselves are the merchant's ledger and expire with
   the store's own housekeeping, not the platform's.
5. **`zimlink-stores` vs `zimlink-store`**: two KV namespaces exist — the Worker is
   bound to `b5c1c89d…` (title `zimlink-stores`), which holds every template and
   both demo stores. The older `b32c2fe9…` (`zimlink-store`) is an orphan from a
   buggy first run and can be deleted once you are sure you do not want it.

## Security note

The GitHub PAT and Cloudflare API token were pasted into this chat, so rotate
both when you are done building. The `ADMIN_SECRET` that briefly landed in a
public commit (`d9c6721`) was rotated in the same session; the repo was deleted
and recreated so the tree no longer contains it — the old blob may stay
reachable by its raw SHA until GitHub garbage-collects it, but the value is inert.

## The confirm link that outlived its own revocation (2026-10-13, v0.8.6)

`Revoke` in the dashboard is the product's answer to "somebody has my links". It bumped
`auth_gen`, which every session and every payment-code link is bound to — and the one-tap confirm
link did not care. `{ a: 'mark', h, id, s }` carried no generation, `markPaid` checked no
generation, so a leaked receipt link stayed a 72-hour write for three days after the merchant
revoked, and the undo link for 15 minutes after it too.

Fixed at both ends. Every mark cap is minted with `g: String(st.auth_gen || '0')` (order
confirm, order cancel, undo) and `markPaid` refuses a cap whose generation is gone: 410,
`{ error: 'link_revoked', final: true, code, why }`, checked *before* the `already`
short-circuit, because "already paid" is a true sentence about the order and a false one about
the link's authority. `confirmPage` refuses the same way, and its floor page renders no form —
a button that will be refused is the 0.8.3 defect again. The rule is one function,
`capGenOk` in the core, so the write path and the page cannot drift.

There is no cliff, because the last release left links in buyers' hands. A cap with no `g` is
judged by time: honoured if the order it points at (`at`, or `marked_at` for an undo link) moved
after the revoke, refused if it predates it, and refused if the generation cannot be read as a
date — the round-trip check exists because `parseInt('zz!not36', 36)` is 1295, and 1295 is
September 1969, which would have made every legacy link look fresh.

The revoke note that already promised "…and so is any payment-code link a buyer was holding" now
says *confirm link* too, and the sentence is finally true.

**Verification.** `npm test` → **241/241** (core 86 · live 100 · pages 44 · limits 10 + the
sidecars' 11+14 in their own folders): 5 new core tests on the rule, 8 new live tests on the
whole sequence (bind → honour → revoke → 410 with nothing written → fresh link works → legacy
link honoured → same legacy link dies on the next revoke → undo link dead → page draws it closed
in both the template branch and the floor branch), 1 pages test pinning the seam between the two
files. `scripts/prod_check.sh` gained two lines that the binding has to permit, so the nightly CI
run proves it on production; today's KV budget is spent, so those two report `blocked` until the
00:20 UTC slot and the target is two consecutive 0-failed runs.

## The revocation had a second hole, and the fix had to stop needing memory (2026-10-13, v0.8.7)

The sentence was re-sent: `/c/` links do not check `auth_gen`, so *Revoke* kills sessions and code
links but not outstanding confirm links. 0.8.6 closed that. This round did the two things the first
round left open — make the rule un-forgettable, and find out whether `/c/` was the only door.

It was not. `/renew/<token>` is the one credential this product hands out that is not a signed
capability: `alnumToken(14)` as a KV key, written once at registration, **no expiry, never
rotated**. Three doors open on it. The plan page (`/renew/<tok>`), which renders the shop's order
count and GMV. `POST /api/checkout`, which mints a gateway payment intent against the store with a
caller-chosen length (30 to 1460 days). And `POST /api/renew-ref`, a public write that prepends a
payment reference to `ref:<handle>` — the list the owner reconciles real EcoCash transfers
against, on the exact reasoning that a sender number and a cents-suffix identify a payer. Anyone
holding a retired renew link could add to that list, and *Revoke* could not stop them, because
nothing that reads the token consulted the generation. The disclosure is the small part; the
reference list is a trust channel, and it was unauthenticated after the one action whose whole
purpose is "someone has my links".

**The mint refuses now.** `core.js` has `BOUND_CAP_ACTIONS = ['mark','proof','sess','ops']`, and
`issueCap` throws `cap_unbound` for any of them without `g`. Not a convention, because a convention
is what failed: the field was easy to omit at a fifth call site, and every test in the repo that
exercises the door would have gone on passing. A whitelist rather than "always require it", so the
rule cannot quietly turn into a blanket and cost the next non-authority credential its simplicity.

**The renew link is judged by the same function, not a copy of it.** `renewOk(rec, store)` reads
`rec.g` and, if there is none, the record's `made` date, then calls `capGenOk` — the rule 0.8.6 put
in the core for exactly this reason. No new semantics, so nothing to drift. A record with no `g`
from before the release is honoured if it was minted after the shop's last revoke and closed if it
predates it; a store that never pressed Revoke keeps every link it has ever been sent, which is
almost all of them. No cliff, same as 0.8.6.

**And the link is reissued, because the promise had to be true.** The refusal copy says the current
link is on the plan card in the dashboard, which would have been a lie while `st.renew_url` kept
pointing at the dead token. So `rotateRenewLink` deletes the old record, mints a fresh one under the
new generation and moves the URL — called at every one of the four sites that bump `auth_gen`
(dashboard revoke, owner-verified PIN reset, the console's `reset_pin`, the console's `revoke`). The
generation check still governs the legacy records that rotation cannot reach. Erasure plus distrust,
each covering what the other cannot.

**A page that cannot draw a fact is not handed the fact.** Both doors now ask the skin before they
use it. The confirm page sets `revoked: true` inside the shape a template already knows, and reuses
one `linkClosed(o)` builder for the refusal in either branch, so a screenshot of the page cannot
contradict the JSON from the API; the renew page switches on `state === 'closed'`. And the sniff in
front of each (`/revoked/`, `/state === ['"]closed['"]/`) means an out-of-date copy in KV — which is
the situation *right now*, because templates publish on the nightly slot and the KV copies are still
0.8.5 — gets the floor page instead of a panel that blames the buyer for being slow or points the
shop at a welcome email whose link the revoke just killed.
The sniff means the floor takes that traffic instead, in the right words, today.

Left alone on purpose. An attempt on a closed link is not audit-logged: the cap is validly signed, so
its holder may retry as often as the expiry allows, and each attempt is a KV write against the
shop's 1,000 a day; routing it through `authFail` instead would let a stranger freeze the merchant's
own dashboard at twelve tries. A refusal is a fact about a link, not evidence about a person. What a
live renew link discloses (order count, GMV, plan, days left) also stays, because it is the page's
job to show a shop its own plan, and the fix was to make it revocable rather than to redesign it.

Checked: 251/251 (core 88 · live 105 · pages 48 · limits 10). Mutated, to prove the guard has teeth
— drop `g` from one production mint: `worker.js` still compiles, the scan fails and 49 live tests
fail. Replace one renew door's check with `if (false)`: live fails. Delete the refusal from
`issueCap`: core fails. Restored, the suite is green again. Seven new `__selftest` keys (`cap_bound_*`,
`cap_stale_*`, `cap_current_*`, `cap_mint_refuses_unbound`, `cap_legacy_*`, `renew_link_revocable`)
cost no KV writes, so `prod_check.sh` reads them off the deployed Worker on a day the account is
silent — which is the only way to verify a revocation fix at 20:00 UTC on the day the budget ran out.

## The rule was copied, and the copies accused a shop that had done nothing (2026-10-13, v0.8.8)

The instruction went out a ninth time, so the audit went one layer further: 0.8.7 guarded the *mint*
side of the generation rule, and this round is the *reader* side. Measured in the shipped file before
anything was changed, three functions read a capability and hand-rolled the comparison instead of
calling `capGenOk`: `proofPage`, `proofAdd` (the two halves of the buyer's code link, `/p/`) and
`identify` (the session cookie).

The two proof doors had no time branch, so "a capability with no `g`" meant "closed" to them, while
to the core it means "judge it by its date". For a shop that has never revoked anything, whose
`auth_gen` is `0`, that produced a sentence that could not be true: `/p/<link>` rendered *The shop
closed its code links* and handed the phone a `tp_pf_<handle>` script pruning a link nobody had
closed. A buyer forwarded such a link would find the door shut, the shop would hear nothing, and the
one action that would have fixed it, Revoke, had never been taken. The fix is not a new rule: it is
`capGenOk` in those two handlers, which is the same line `markPaid` and `confirmPage` already call, so
a link with no generation on a shop that never revoked opens, and the same link on a shop that did
revoke is closed with the prune and the true sentence.

`proofPage` also had a second fact welded to the first: `if (!st || genMismatch)`. A store row that
is not there — deleted, archived, or a KV read that came back empty — was reported to the buyer as a
revocation. It is now its own card, 404, "there is no shop behind this link", and it deliberately
emits no script: a page may not rewrite someone's storage on the strength of a guess about which of
the two situations it is looking at. The credential is still answered before the order row's absence
is, which is the shipped contract and is what an existing test about pruning order-of-refusals
insists on; that ordering was kept deliberately, and the comment in the handler says why.

`identify` is *not* unified, and says so in the source: `gen-rule: strict`. A cookie has a
self-service replacement one tap away, so there is no stranger to protect from a cliff, and the time
branch would let a pre-0.6.0 cookie back in on every shop that has never revoked. The ops door is
bound to `ops_gen` rather than a store's `auth_gen`, and its cap's `g` is a version string; so the
`issueCap` guard now asks each action for the field its own door consults (`CAP_BINDING`: `g` for
`mark`/`proof`/`sess`, `n` for `ops`). A guard that looked only for `g` would have called any ops cap
bound while nothing ever read that `g` — the shape of a check that passes for the wrong reason.

Two permanent guards, both mutation-proven: a scan over every top-level function that calls
`verifyCap`, requiring the shared rule or a `gen-rule:` marker, with the *set* of markers asserted
(`identify=strict`, `opsAuthed=platform`) so an exemption cannot be added quietly; and the 0.8.7 mint
scan, unchanged. Put the hand-rolled comparison back and the scan fails plus two live tests; strip one
marker and the scan fails; rename one marker and the scan fails. 257/257 after each restore (core 89,
live 109, pages 49, limits 10). Two more zero-write `__selftest` keys carry the claim to production on
a day the account has no KV writes left: `code_link_rule_shared` and `ops_cap_needs_platform_gen`.

One correction to a claim in this file's previous section: it said `confirmPage` had been given the
skin-capability sniff "the same treatment as the API". It had not, only the renew door had it; the
confirm sniff is in as of this release (`/revoked/` in the KV template, floor page otherwise), which is
what that paragraph described. A second correction: the selftest key `confirm_link_signed` named while
planning 0.8.7 does not exist in the source; the deployed keys are the ones listed here.

One correction recorded here rather than left implicit: the free-plan reset in the quota note is
midnight UTC (`secsToMidnightUTC`), and the `retry_in_sec` the endpoint reported today (42,765 s)
matches a call made at 12:07 UTC, not the 19:27 I first converted it against. The code was right and
my arithmetic was not; the nightly slot at `20 0,6,12,18` remains the right place for write-gated
checks, since 00:20 UTC is the first minute the budget is open again.
