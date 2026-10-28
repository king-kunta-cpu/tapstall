# Distribution mesh: switching rails on (v2.0.0)

The press is **armed**: every rail below is registered and composes on its own the moment its account
secret exists on the Worker. Until then it reads **"on (waiting for account)"** in `/ops` →
*Deploys & health* → *Distribution rails*. A waiting rail costs no queue, no KV write and no post.

Secrets are set on the `tapstall` Worker (Cloudflare dashboard → Workers → tapstall → Settings →
Variables → *Encrypt*, or `wrangler secret put NAME`). Never in KV, never in the repo.

## Company rails (identity `owner`)

Use **Tapstall's own accounts**. Until 2026-10-28 the press was posting into STPi's Bluesky; that
was removed. One brand per account.

| Rail | Sign up | Secrets to set |
|---|---|---|
| Bluesky | Create a `tapstall` account at bsky.app → Settings → Privacy and security → App passwords → Add | `PRESS_OWNER_BLUESKY_HANDLE` (e.g. `tapstall.bsky.social`), `PRESS_OWNER_BLUESKY_APP_PASSWORD` |
| Telegram | @BotFather → `/newbot`; create a public channel; add the bot as an admin | `PRESS_OWNER_TELEGRAM_BOT_TOKEN`, `PRESS_OWNER_TELEGRAM_CHAT_ID` (`@channelname` or the numeric id) |
| X | Free Buffer account → connect X → Settings → API → access token | `PRESS_BUFFER_TOKEN`, then register the channel id (below) |
| LinkedIn | Same Buffer org → connect a LinkedIn page | same token; register the channel id |

Registering a Buffer channel id (one call, owner secret):

```bash
curl -X POST https://tapstall.zlnew.workers.dev/api/press/accounts \
  -H "x-tapstall-admin: $ADMIN_SECRET" -H "x-tapstall-confirm: 1" -H "content-type: application/json" \
  -d '{"action":"register","id":"owner","class":"owner","rails":{"bluesky":{},"telegram":{},"x":{"channel_id":"<buffer id>"},"linkedin":{"channel_id":"<buffer id>"}}}'
```

## Seller rails (identities `seller:a`, `seller:b`, …)

Off until a seller brings their own accounts. Register the identity with the same call
(`"id":"seller:a","class":"seller"`), then set `PRESS_SELLERA_BLUESKY_HANDLE`,
`PRESS_SELLERA_BLUESKY_APP_PASSWORD`, `PRESS_SELLERA_TELEGRAM_BOT_TOKEN`,
`PRESS_SELLERA_TELEGRAM_CHAT_ID`, or a Buffer token in `PRESS_BUFFER_TOKEN_SELLERA`. Seller posts carry
no links by policy. To offboard a seller, delete their secrets; nothing else holds them.

## Rails with no sender here

Nostr, Mastodon and dev.to show **"no sender"**. They are in the planner, but this Worker cannot post
to them, so they are never shown as waiting. WhatsApp status, Facebook groups and the counter notice
are hand-posted by design; the merchant mesh in each shop's dashboard writes those for a person to send.

## Checklist

- [ ] Bluesky `tapstall` account + app password → 2 secrets
- [ ] Telegram bot + channel → 2 secrets
- [ ] (optional) Buffer: X + LinkedIn → token + register channel ids
- [ ] `/ops` → Distribution rails shows **active**
- [ ] Revoke the old `stpi-official` Bluesky app password that Tapstall used to hold
