#!/usr/bin/env bash
# Finish a release whose pages could not be published, without a human at a keyboard.
#
# A day's free KV writes (1,000) are spent often enough that `deploy.sh` ships the Worker and
# leaves the HTML behind, saying so honestly and exiting 0. The fix has always been "run
# `--templates` after midnight", and a step that lives in a status file is a step that gets
# forgotten — so here it is as a process that waits for the reset the API itself reports, does
# the put, verifies the served bytes against git, and then reads the two pages back over HTTP
# to prove the *new* controls are the ones customers get.
#
#   scripts/publish_watch.sh              wait for the reset, publish, verify
#   scripts/publish_watch.sh --now        skip the wait (a capped day just refuses, loudly)
#
# Why it sleeps once instead of polling: `kv_write_blocked.retry_in_sec` is read from a GET, and
# asking "can I write yet?" by trying a write is how a watcher eats the budget it is waiting
# for. `deploy.sh --templates` then spends a write only where KV differs from git, so a run on a
# quiet day costs nothing and proves the same fact every time.
#
# Nothing here prints a secret: `load_secrets` reads the files and keeps them in the environment.
#
# WHAT IT IS NOT: a scheduler. It was written to close a stuck publish with nobody at a keyboard,
# and on its first night the sandbox it ran in was recycled while it slept — killed at ~23:09 on
# the way to a 00:02 wake-up, leaving both pages stale for another nine hours. A process that
# must outlive an idle gap is not a mechanism; `pages-are-current` in .github/workflows/deploy.yml
# is, which is why that job now fires four times a day instead of once. Run this from a terminal
# you control (`nohup ... &`, or `at 00:05`) when you want the pages fixed before the next push.
set -uo pipefail
cd "$(dirname "$0")/.."
LIVE="${LIVE:-https://tapstall.simalidudu.workers.dev}"
MARGIN="${MARGIN:-120}"
TRY_GAP="${TRY_GAP:-300}"
LOG=.publish-watch.log
note() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG"; }

# the two pages this release owes, by the control a reader looks for rather than by byte count:
# the buyer's inline box and the merchant's hand-back button. A size that matches git proves the
# bytes shipped; these prove the bytes are the ones being served.
PROBES=("store:/s/mamatoe:id=\"pff\"" "admin:/a:data-pfv")

if [[ "${1:-}" != "--now" ]]; then
  SEC=$(curl -s -m 30 "$LIVE/__selftest" | jq -r '(.kv_write_blocked.retry_in_sec // 0) + 1' 2>/dev/null || echo 0)
  SEC=$(( ${SEC:-0} + MARGIN ))
  (( SEC > 3900 )) && SEC=3900          # the counter may be wrong; the retry loop below is the cure
  (( SEC < 5 )) && SEC=5
  note "budget: reset in ${SEC}s (reported + ${MARGIN}s margin); sleeping"
  sleep "$SEC"
fi

ok=0
for try in 1 2 3; do
  note "attempt $try: deploy.sh --templates"
  OUT=/tmp/pw-templates.log
  if bash scripts/deploy.sh --templates > "$OUT" 2>&1; then
    cp "$OUT" "$LOG.last-attempt"
    note "attempt $try: $(grep -c 'same bytes in KV' "$OUT") pages verified against git, and the difference is gone"
    ok=1; break
  fi
  cat "$OUT" >> "$LOG"
  # counted from this attempt alone: a log file that accumulates three attempts reports three
  # times as many verified pages as exist, which is the kind of number that makes a broken
  # release look like a busy one
  note "attempt $try: refused or still stale; the count that matters is per attempt, and it follows"
  sed -n 's/^/    /p' "$OUT" | tail -8 | tee -a "$LOG"
  (( try < 3 )) && { note "sleeping ${TRY_GAP}s"; sleep "$TRY_GAP"; }
done
(( ok )) || note "giving up after 3 attempts: the pages differ from git and no write landed — that is a red CI run, not a silence"

for p in "${PROBES[@]}"; do
  name="${p%%:*}"; rest="${p#*:}"; path="${rest%%:*}"; needle="${rest#*:}"
  code=$(curl -s -o /tmp/pw-$name.html -w '%{http_code}' -m 30 "$LIVE$path" || echo 000)
  # `grep -c` prints its own 0 and exits 1 when it finds nothing: `|| echo 0` there turns one
  # zero into "0\n0", which is not equal to "0" and so reads as a hit. Found by running this.
  hits=$(grep -c -- "$needle" /tmp/pw-$name.html 2>/dev/null || true); hits=${hits:-0}
  if [[ "$code" == 200 ]] && (( hits > 0 )); then note "served $path: 200, $needle present ($hits×)"
  else note "NOT SERVED YET: $path -> HTTP $code, $needle ×$hits"; fi
done

if [[ -n "${OPS_PIN:-}" || -f ~/.secrets/ops_pin ]]; then
  note "prod_check (the live suite, including the write-gated lines a capped day blocks)"
  PIN="${OPS_PIN:-$(cat ~/.secrets/ops_pin)}" bash scripts/prod_check.sh 2>&1 | tail -4 | tee -a "$LOG"
else
  note "prod_check skipped: set OPS_PIN (or ~/.secrets/ops_pin) to run the write-gated half"
fi
note "done"
