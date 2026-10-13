# Moving Tapstall to another Cloudflare account

Written on 2026-10-13, while the destination account's token was still `Invalid API Token`. Nothing
here has been run against the new account, and this file says which half is proven and which half is
waiting on a credential rather than pretending both are done.

## What is in the old account, measured today

Read it again any time — `scripts/quota.sh` does exactly this, reads only, and prints the same shape:

```
account   0c6059d950fad268faa25cbb6d21ef77          subdomain  simalidudu
worker    tapstall        + alias zimlink (REDIRECT_TO set, so merchant links work through both names)
KV        zimlink-stores  b5c1c89d95114092ae91bbafc5a2d76c   38 keys   (store=2 tpl=11 buyer=11 hooks=4 renew=2 seq=2 cron=1 ops_gen=1 __ping=3 zz-probe=1)
KV        zimlink-orders  4f4ac94a66db4b859b61668a3c160819  118 keys   (order=113 list=2 audit=3)
secret    ADMIN_SECRET (one; it salts buyer fingerprints and renewal tokens — it must be COPIED, not regenerated)
triggers  cron 15 6,12,18,0 * * *  (v0.9.1 moves this to one slot: 20 0 * * *)
custom domains  none
```

752,099 bytes across both namespaces (an export of all 156 keys, run today, verified byte-for-byte
against the live namespace afterwards: `missing: 0 metadata mismatch: 0 value mismatch: 0`). So the
whole thing fits in a `wrangler`-sized curl session and does not need a storage-tier migration tool.

## The two facts that make this more than a copy

**A merchant's URL is the subdomain, not the worker.** Every live link is `tapstall.simalidudu.workers.dev/…`
(or the `zimlink.` alias), and those `*.workers.dev` names are reserved account-wide by *prefix*: the
destination can only claim `tapstall.` once the source releases it. So the sequence is
`delete the subdomain prefix on the old account → claim it on the new`, and the gap in between is a
real window in which no order can be placed. Do it outside business hours in Harare, and do it once —
a half-finished swap strands both names. `PUT /accounts/{dst}/workers/subdomain {"subdomain":"tapstall"}`
is the claim; the release is the same call's counterpart on the source (unverified here, because the
new token is invalid and I am not going to release the live name as a side effect of finding out).

**The ledger now lives in KV list *metadata*, not in a `list:` key.** Since v0.9.1 every order document
carries its own packed row, and the ledger is the listing. The KV REST API returns metadata on
`GET /keys` and accepts it on `PUT /values/{key}` only as multipart/form-data — which is why the
mover here is a script and not `kv:key bulk`, and why `verify` compares metadata presence rather than
counting keys. A migration that copies values and drops metadata produces a namespace that looks
complete and answers every order with a thin row: money zero, status `unknown`.

## Running it

```bash
# 0. both ends, read-only first
python3 scripts/kv_migrate.py --account $SRC --namespace $SRC_STORES export --out /tmp/stores.jsonl
python3 scripts/kv_migrate.py --account $SRC --namespace $SRC_ORDERS  export --out /tmp/orders.jsonl
python3 scripts/kv_migrate.py --account $SRC --namespace $SRC_ORDERS  verify --archive /tmp/orders.jsonl --values

# 1. destination namespaces, then ONE key, then the metadata check before the whole day's budget goes
curl -X POST https://api.cloudflare.com/client/v4/accounts/$DST/storage/kv/namespaces \
  -H "Authorization: Bearer $DST_TOKEN" -H "content-type: application/json" \
  -d '{"title":"tapstall-stores"}'          # and again for tapstall-orders; a title is immutable, so choose it once
python3 scripts/kv_migrate.py --account $DST --namespace $DST_ORDERS import --archive /tmp/orders.jsonl --limit 1 --yes-live
python3 scripts/kv_migrate.py --account $DST --namespace $DST_ORDERS verify --archive /tmp/orders.jsonl   # exits 1 on a metadata mismatch

# 2. the rest, in the order that keeps the Worker correct if it stops halfway: stores first, then orders
python3 scripts/kv_migrate.py --account $DST --namespace $DST_STORES import --archive /tmp/stores.jsonl --yes-live
python3 scripts/kv_migrate.py --account $DST --namespace $DST_ORDERS  import --archive /tmp/orders.jsonl  --yes-live

# 3. secrets and bindings: same binding names (STORES, ORDERS), same ADMIN_SECRET value
#    then deploy against $DST, claim the subdomain name, re-point the alias, set the cron trigger,
#    and run the pipeline's own proof against the new origin:
ORIGIN=https://tapstall.<newsub>.workers.dev bash scripts/prod_check.sh
```

156 writes for a full copy, which is under the 1,000 a day on its own; if the account is already part
spent, `import` stops where it can resume (keys already present are skipped unless `--overwrite`), so
a move can be spread over two days. The old namespaces must not be deleted until `prod_check.sh` is
green against the new origin — a rollback after the copy is simply repointing the bindings.

## Done 2026-10-13 at 15:20 UTC — the new account is live and holding the data

```
account 6527547015468a5ec705a1071010822d                  workers.dev prefix claimed here: zlnew
KV      tapstall-stores a9016473abef4a66bcba6f200d7d4af3    38 keys, imported and byte-compared: missing 0, metadata 0
KV      tapstall-orders 7dd531983a814ff5bb693598b93714d6   118 keys, imported and byte-compared: missing 0, metadata 0
worker  tapstall, deployed from .build/worker.js via wrangler (574.33 KiB, gzip 165.15), 2 KV bindings, cron from the toml
secret  ADMIN_SECRET re-set to the source value (a Worker secret cannot be read back, so it was copied from the file)
proved  GET https://tapstall.zlnew.workers.dev/s/mamatoe → 200, 45,945 bytes, "<title>Mama Too Catering | Tapstall</title>"
        /__selftest → version 0.9.1, pages_inlined 11, pages_store_from "bundle", kv_roundtrip true (fresh budget),
                      rate_limit_local_first {requests 9, ceiling 8, writes 1, refused 1}
```

Two API shapes this run paid for and the scripts now carry: a KV existence probe must use `limit=10`
(`limit=1` is refused with code 10028, and the importer stopped on its very first key until that was
fixed), and a secret PUT needs `"type":"secret_text"` or it answers 100145 `unsupported type`.

Still open, in the order that does not interrupt a shop:

1. **The name.** `tapstall.simalidudu.workers.dev` — printed on receipts, pasted into WhatsApp threads —
   is still the old account's, and still serving 0.9.1 correctly. Moving it means releasing the prefix
   there and claiming it here, with minutes in between in which no order can be placed. Deliberately
   not taken automatically; give me a quiet hour and it is two calls.
2. **CI.** The repo secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` still point at the source
   account, so a push deploys to the old copy while the new one sits beside it. Until the name moves,
   that is the one state that can produce two divergent shops, so it should be flipped in the same
   sitting as step 1, and the Pages project re-pointed with it (`deploy.sh --push`).
3. **Nothing deleted on the source.** It keeps serving until 1 and 2 are done; after that the rollback is
   repointing bindings, because the namespaces were copied rather than moved.

## What is owed before any of this can run

A token for `6527547015468a5ec705a1071010822d` with `Workers Scripts:Edit`, `Workers KV Storage:Edit`
and `Members:Read`, scoped to that account only. Two were supplied on 2026-10-13, and both measure
identically:

```
GET /user/tokens/verify            -> 200, success:false, code 1000  "Invalid API Token"
GET /accounts/{id}/workers/scripts -> 200, code 10000 "Authentication error"   (same for /storage/kv/namespaces and /workers/subdomain)
the second token as pasted         -> 53 chars, 48 after the `cfut_` prefix; Cloudflare does not issue 48
that minus its trailing 8 chars    -> 1000        (so it is not a paste that ate a checksum)
those 40 without the prefix        -> 1000
the trailing 8 alone               -> 6003 "Invalid request headers"
```

That is neither an IP restriction nor a missing scope, and the way to tell the three apart is worth
writing down because I got it wrong once here. `GET /user/tokens/verify` answers `code 1000
"Invalid API Token"` for a **perfectly working** account-scoped token — this repo's own `cfat_…` token
gets exactly that answer at 14:41 UTC and deploys the Worker fine — because that endpoint wants
user-level auth. It proves nothing either way. What proves something is the same request to an endpoint
that needs no scope:

```
GET /accounts   with the working token   → success, one account listed (0c6059d9…, "Simalidudu@gmail.com's Account")
GET /accounts   with the token you sent  → 9109 "Invalid access token"        ← Cloudflare does not know the string
GET /accounts/6527…/workers/scripts with the working token → 9109 "Unauthorized to access requested resource"
                                                              ← live token, simply not scoped to that account
```

Two different messages, and they mean two different fixes: `Unauthorized to access requested resource`
is a scope edit, `Invalid access token` is a credential that was never created, was deleted, or was
copied out of the wrong field. The pasted string is also 53 characters — the same length as the working
token, 48 after the prefix — which retires the guess recorded earlier in this file that the length was
odd. It is not odd; it matches. So the token is fine in shape and unknown in fact, and the thing to
check is that the value copied is the secret shown once at Create Token and not the token's id.

**Three credentials have been pasted into this task and all three are unknown to Cloudflare; the
control was run in the same request, so this is not the method failing.** Measured at 14:52 UTC against
`GET /accounts`, which needs no scope at all:

```
cfut_1dH3…61f6ba9f  as pasted                  → 9109 "Invalid access token"   (and 10502 on the retry)
cfut_1dH3…61f6ba9f  with the trailing 8 dropped → 9109 "Invalid access token"
cfat_1dH3…61f6ba9f  prefix swapped              → 9109 "Invalid access token"
cfat_…d1ad          the token this repo deploys with → VALID, accounts=['0c6059d950fad268faa25cbb6d21ef77']
```

The working token and the rejected ones have the same shape: a 5-character prefix, 40 characters, and
an 8-hex-character tail — so length, the tail, and truncation are all ruled out by measurement, and the
only difference left is that Cloudflare has no record of the `cfut_` strings. Every rejected credential here begins `cfut_`, and so does the one that eventually worked
(`cfut_…89d68a55`): same prefix, same 40+8 length, and Cloudflare knows that one. The shape was
never the signal — `GET /accounts` was, answering `9109 "Invalid access token"` for a string it has
no record of and `VALID accounts=['6527…']` for a live one. What that means in practice is not a theory
about prefixes but a check worth doing first: create the token as a **Custom API Token** (My Profile →
API Tokens → Create Token → Custom) and copy the **Token value** shown once immediately after Create —
the value, not the token's id, and not a token from another screen.

The second-best path needs no new secret at all, and it is the one to take if the goal is simply to
finish the move: edit the `cfat_…` token this repo already deploys with, and add the new account to its
**Account Resources**. Then `DST_TOKEN_FILE=~/.secrets/cf_token bash scripts/migrate_account.sh` runs
as written, CI keeps its existing secret, and nothing has to be pasted anywhere. The cost is that one
token can write to both accounts while the two exist side by side, which is also what makes the
rollback a re-point rather than a restore.

One more measured fact: after a handful of failures Cloudflare starts answering `429 code 10502
"Too many authentication failures"` and `10429 "Rate limited"` on everything, including calls that
would have worked. A migration script that retried through that would look like a broken account.
So `scripts/cf_probe.py` exists — one read of five surfaces, one verdict, and it exits non-zero unless
the token can act on *the account it was pointed at*, not merely on some account. That distinction is
the second bug this file records: the first draft passed on a token that could list `/accounts`, which
is how a deploy walks into the wrong account and succeeds there.

Nothing needs the dashboard. Paste the secret into `~/.secrets/cf_token-new` and run:

```bash
DST_ACCOUNT=6527547015468a5ec705a1071010822d DST_TOKEN_FILE=~/.secrets/cf_token-new \
  bash scripts/migrate_account.sh            # dry run: probes, reads, prints the plan, writes nothing
DST_ACCOUNT=6527547015468a5ec705a1071010822d DST_TOKEN_FILE=~/.secrets/cf_token-new \
  bash scripts/migrate_account.sh --apply    # stops after one key and the metadata check, for a human to read
```

It refuses to go past step 1 on a token that cannot read the destination, and it never takes the
subdomain window — that is printed, not performed.

While that is outstanding: `uploads/` still ships live credentials in the repo (the WhatsApp bot token,
OpenRail and GAS keys, 13 wallet addresses) and those need rotating whatever account they point at.
