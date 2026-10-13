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

## What is owed before any of this can run

A token for `6527547015468a5ec705a1071010822d` with `Workers Scripts:Edit`, `Workers KV Storage:Edit`
and `Members:Read`, scoped to that account only. The one supplied on 2026-10-13 answers
`Authentication error` / code 10000 `Invalid API Token` on every endpoint from two networks, so the
destination has no resources in it and there is nothing to migrate into yet.

While that is outstanding: `uploads/` still ships live credentials in the repo (the WhatsApp bot token,
OpenRail and GAS keys, 13 wallet addresses) and those need rotating whatever account they point at.
