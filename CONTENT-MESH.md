# The content and promotional mesh — what it is, how it moves, what it must never do

Read as the union of three things that already exist: the **hunta** machine (its published architecture,
`hunta-marketing/scripts/_data/essay-pipeline.md`, plus the voice rules in `BRAND.md`), the **COREMERCH**
substrate (the `store` repo's static Pages mesh — `products.json`, `posts/`, `sitemap.xml`, `robots.txt`,
`index.json`, all served free off GitHub Pages; `bsky-audit`; `n8n-workflow-pack`;
`free-apis-for-automators`), and **Tapstall's** own half, which shipped first, in v0.9.0: `meshPack`,
`meshJson`, `meshMark`, `meshWitness`, `MESH_BUDGET`, `GET /s/<handle>/mesh.json`, `GET /api/mesh`,
`POST /api/mesh/seen`, and the `menu`/art rules around them.

The claim, stated small: **a shop's own facts and the niche its customers care about — content they
find value from, with no mention of the offering — published on a rhythm, through nodes that cost
nothing, with provenance on every sentence.** This is growth work, and the point of it is that more
people know the shop exists; revenue tracks attention, and attention is bought with usefulness or not
at all. What the design refuses is not ambition but the one failure mode that ends an account: a
machine that talks *as* a seller without constraint. The hunta essay names it — "a reputation destroyer
with good marketing" — and the fix taken from it is structural rather than moral: caps the software
holds, provenance a function enforces, a yield log that lets a useless channel be dropped.

## The two sentences that decide everything else

From the hunta pipeline, the two controls that are worth stealing whole, quoted because they are load-bearing:

> The truth file is a short list of verified facts… Its whole purpose is negative: the model may only
> cite what appears there. If it is not in the truth file, it does not exist.

> Nothing sends without a yes. That rule is not a disclaimer, it is the design.

That one is **rejected here**, and an earlier draft of this file quoted it as though it applied, which
was a description of a safety habit that does not survive contact with the actual user. A person running
a kitchen, a till and a delivery bike is not a copy desk; a mesh that depends on them clicking through an
approval queue does not reach forty shops, it reaches four. So both kinds of post — value and shop facts —
are created, scheduled and posted by the machine, along with the first touch to a shop's own warm contacts
and the replies to nothing. **What is human-gated is the reply**: the DM answer, the email answer, the
comment under the post — where a sale is won or lost, and where a template is how a customer leaves.
`MESH_AUTONOMY_V3.human = 'replies_only'` is the whole policy, in the code that reads it.

What replaces the approval gate is provenance, applied hardest to the half allowed to mention money.
`meshWitness` is the negative rule: a beat may assert only what a row read *today* supports, and a broken
feed returns `priced: false` so no price appears anywhere. `meshUnsupportedOffer` is its promo-specific
form — a discount, a voucher, a "free …" or a was/now exists only if the merchant put that field on the
row, so an offer is never improvised: the beat is dropped and the reason kept for the shop to read.
`MESH_BUDGET` is the cap: three beats a day, **two value to one shop-facts promo**
(`MESH_AUTONOMY_V3.ratio = { value: 2, promo: 1 }`), on three fixed windows, with a seven-day cooldown per
item so the same dish is not sold at twice in a week. A promo beat states price, availability and hours
with the store link, because those are facts the shop owns; it may not state an offer nobody configured.

## Nodes, and what each is for

| node | role in the mesh | cost | already there? |
|---|---|---|---|
| Tapstall shop page `/s/<handle>` | the origin: the only place the shop's facts are authored | 1 read per view, 0 writes | yes (v0.9.1: pages from the bundle) |
| `GET /s/<handle>/mesh.json` | the machine-readable face: beats, prices, guides, art, witness marks | 1 read | yes |
| the shop's own WhatsApp broadcast list | the only channel a merchant owns outright; deep link back to `/s/<handle>` | outside us | yes — the receipt/`wa.me` path, `fmt=wa` |
| `hunta-marketing` Pages site (`index.html`, the 16-tab bible) | the method, published; every tab has a Copy button, so distribution is a person pasting | 0 (GitHub Pages) | yes |
| COREMERCH `store` static mesh | the commerce substrate as a discoverable object: `products.json`, `posts/`, `sitemap.xml` | 0 (GitHub Pages) | yes — audited live at 200s |
| `bsky-audit` | free, no-signup lead capture; the audit result *is* the pitch | 0 | yes (repo exists; the site is the product) |
| `n8n-workflow-pack`, `n8n-code-node-stdlib`, `free-apis-for-automators` | the automation layer third parties can adopt; each adoption is a node that can post about us without us paying | 0 | yes (40 free APIs = the data plane nobody has to buy) |
| dev.to (owner persona) | the long-form engine: one essay per slot, mirrored, never deleted | 0 | the archive pattern exists (`scripts/_data/devto-*.md`) |
| Nostr | the mirror that cannot be deplatformed or throttled by us; publish-once, relay-many | 0 | named in the pipeline doc as the mirror; not wired |
| Bluesky / X / LinkedIn | per-node echo of the same text, each with its own shape, never the same paragraph pasted raw | 0 | not wired |
| the guide pages (`/guide/<slug>`) | the SEO and the "value" half of the 2:1 ratio | 0 writes/day (the seen tally is memory-resident) | yes |
| art `/art/<handle>/<seed>.svg` | the visual that makes a post not-text; immutable, zero-KV, never over a real photo | 0 | yes |

Anything not on this list does not get an integration until it earns a row here. That is the hunta
discipline about sources: the pipeline walks a *configured* set, logs each source's yield nightly, and
lets a zero-yield night retarget the aim rather than blame the parser.

## The edges — who pushes to whom, and on what clock

1. **Shop → mesh.json → everything downstream.** A merchant approves beats in ops; `meshPack` renders
   them into the JSON feed. Nothing else reads the merchant's mind, and no node composes a claim the shop
   did not approve. This is the origin rule: **facts are authored once, at the shop, and mirrored.**
2. **mesh.json → the Copy surface.** The hunta bible and the guide pages carry Copy buttons, which makes
   WhatsApp/Bluesky/forum distribution a *human* action with a machine-prepared artefact. It is the
   cheapest edge in the graph and it is the one that keeps the human on the trigger.
3. **dev.to → Nostr → the small boards**, on a fixed window: `04:00` local for the nightly walk, publishing
   in the windows the audience is in (`devto-2026-10-01-fixed-windows-beat-the-feed.md` is that claim, and
   the boards' own rhythm is in `boards-publish-on-a-rhythm-set-alerts-to-it.md`). Freshness beats fit:
   a post aimed at a live window outranks a better post aimed at a quiet one.
4. **COREMERCH `store` → search and the aggregators**, via `sitemap.xml`/`index.json`/`products.json`
   already served. Being crawlable is a distribution channel with zero marginal cost — and the audit that
   called a live site dead was the one that queried the org root instead of `/store/*`, which is the
   lesson written into the check, not the marketing.
5. **`bsky-audit` → the shop**, i.e. inbound: the free audit is what a stranger can say yes to in ten
   seconds, and its output names Tapstall as the fix rather than arguing for it.
6. **`mesh:seen` back into the shop.** Every node's traffic lands as one small state write per shop per
   day, and the promo ratio gate reads it, so the mesh learns which node produced and demotes one that
   did not. This is the yield log, in the one place it can be afforded.

## The invariants, as a list you can test

1. **Provenance or nothing.** A beat may cite only witnessed facts (a row read today, a real photo, an
   approved price). `meshWitness` and `realPhoto` are the enforcement; the art never overrides a real or
   explicitly-cleared photo.
2. **A standing grant, and no gate on the send.** The human is not a copy desk: a person cooking, serving
   and chasing payments does not approve a paragraph about their own Tuesday, and a mesh that needs them
   to dies at forty shops. So the gate is one save that turns autonomy on and one save that turns it
   off (`POST /api/mesh/auto`, `mesh:<handle>.auto`, timestamped and counted), and the machine's hands
   are tied by what it is allowed to say rather than by who reads it first. This is a deliberate move
   away from the pipeline hunta runs — where *nothing sends without a yes*, because there a sentence is
   a person's name in front of one employer and one bad line costs an interview. Here the autonomous
   half is confined to value beats drawn from the shop's own words, with no price, no link and no offer
   in any of them (`MESH_AUTONOMY.pitch = 'never'`, refused by `meshIsPitch`), which is the class of
   sentence that cannot embarrass a shop; the promo half stays exactly where it was, a tap in ops. The
   two kinds of statement get two different gates, and the difference is written down instead of
   pretending one rule fits both.
3. **Caps are software.** `MESH_BUDGET = { per_day: 3, value: 2, promo: 1, item_cooldown_days: 7 }`, plus
   the account's own write budget. "Runaway is not representable" is the standard, so a bug cannot make us
   a spammer.
4. **The mesh spends no quota it can avoid.** Reads are 100× cheaper than writes on the free plan, so:
   beats are derived, not stored; the seen-tally is memory-resident; `mesh:<handle>` is at most one write
   per shop per day; pages ride the bundle. A saving that made a shop slower or a repair need a human is
   rejected on sight — the limiter is local-first for exactly this reason.
5. **Voice is fixed, not per-channel.** From `BRAND.md`: specific over impressive; state limits honestly;
   never "revolutionise", never "guaranteed"; never the word "bot" in buyer copy; Southern-African
   specifics (EcoCash, Zimswitch, SARS eFiling for the cross-border half); no emoji except a literal ✅ or
   ❌ where a yes/no is meant. A channel changes the shape of a sentence, never its claims.
6. **Zero is data.** A night with no beats, a source with no yield, a shop with no responses — reported,
   not retried into noise. The mesh must be able to say "nothing to publish today" and mean it.
7. **Delete the mechanism, not the promise.** Nothing in the mesh may hold a lead hostage: a page that
   captured an email must let the merchant export it, and a node we shut down must not strand a shop's
   audience. Same reason the receipt lives on the buyer's device.

## Who is on the other end of the switch

Two kinds of account, and they do not start the same way:

- **the owner's company accounts** (`meshAccount → owner`) are autonomous from the day they are
  configured: the person who wrote the policy is the person who turns it on, so a grant would be him
  asking himself for permission;
- **a seller's account** (`seller`) is *delegated*: the seller hands over the credential — a Bluesky app
  password, a Telegram bot token, a Mastodon token, a free X app bearer, or the nsec we generate for
  them — and the owner's machine posts to their account with it. They stop it by changing the password at
  the provider or tapping revoke in ops; `schedule.beats[].on_behalf_of` says out loud whose account said
  it, because that is the thing a platform asks you to be able to answer;
- **a trial shop** (`trial`) has nothing connected, so it has nothing to post with and stays off until it
  grants. That is the only class the old grant flow was ever really for, and the 0.9.2 tests now say so.

The cadence is the pipeline's, not a mood: X ≥3 a day, LinkedIn ≥3, dev.to 3, daily pins, daily Bluesky and
Nostr, ratio two value to one shop facts, weekends included. Replies are a human's, at a human pace —
four a day, questions first. Cold outreach is composed at 08:21 on weekdays into one batch that a single
owner tap sends, mailbox ramped 20 → 100 over five working days: the machine writes, one action fires the
set, nobody approves eighty messages.

## What the machine can send by itself, and what it physically cannot

`MESH_CHANNELS` declares the capability per channel, because pretending otherwise is how a shop loses an
account. That is not governance, it is what the platforms accept:

```
posts itself by API    x (write-only free tier, 1,500 posts a month) · linkedin · dev.to (free key, the long-form
                        home of the value beats) · pinterest (the photo rails are the ones that sell food) ·
                        bluesky · nostr (an nsec we generate per shop: no signup, no cost, nobody to approve it) ·
                        mastodon · telegram · our own Pages mirror
queued for one tap     WhatsApp status and groups · Facebook groups · Instagram personal · the paper by the till
first touch, per shop   a DM or an email to a number already on that shop's ledger — warm only, capped at eight a
                        day, and sent from the shop's own credentials: there is no legitimate API for a personal
                        WhatsApp account, and a bulk send from that number gets the number restricted
replies                 never sent by the machine: the console shows them and waits for a person
```

A shop with no authorised API channel still gets the whole pack, and `schedule.beats[].auto_send` is
`false` for it — the plan says out loud that a tap is owed, rather than reporting a post that never
happened. Credentials stay the merchant's, on their own store document, revocable at their provider.

## The growth mechanics, borrowed from the pipeline rather than invented

The hunta machine is worth reading as a distribution system, not a job tool, and these are the parts
that carry over with a shop in place of a CV:

- **Walk a configured set of sources, and log each one's yield.** Zero on a channel is market data. The
  mesh keeps per-node counts in `mesh:<handle>` and a node that produces nothing across two windows
  gets demoted by rank, not by feeling.
- **Fixed windows beat the feed.** Publish when the audience is on it — `MESH_AUTONOMY.window_utc`,
  two beats a day, morning and lunch — so a follower's alert catches the rhythm. Boards and groups run
  on a cadence; a shop that appears on that cadence is remembered, a shop that appears often is muted.
- **Freshness beats polish.** A line about what is cooking today outranks a beautiful line about the
  brand, and both outrank a repost.
- **Warm the contact before you need anything.** The ledger already knows who bought three times;
  `meshGrowth` puts those names in front of the merchant with a thank-you and a referral ask, and puts
  the two people who left an order unpaid inside three days there too, with one line each. The human
  sends it from their own number. That is the highest-yield outreach in this whole system, it costs
  nothing, and no software should do it — a person who replies to a bot stops replying to you.
- **One line of proof per bullet.** A claim in a beat carries the row it came from; `meshWitness` is the
  function that decides whether the shop is allowed to say it today.
- **Give the useful thing, capture the interest separately.** `bsky-audit` is the model: a free result a
  stranger can take in ten seconds, no signup, with the shop's own link as the only call to action.
  Tapstall's version is the guide shelf and the shop's value feed at `/s/<handle>/mesh.json` — the
  thing worth following *is* the content, and the pitch never has to appear in it.

## Scale: seller accounts, not one company account

Forty sellers, each with their own voice, their own audience and their own risk — which is a different
problem from one brand posting for itself, and the differences are the design:

- **Policy per shop.** The grant, the cap and the cooldown are stored on `mesh:<handle>`; one seller
  switching off or over-tuning changes nobody else's queue. `MESH_AUTONOMY` is the ceiling, not a
  shared schedule.
- **No cross-shop amplification, ever.** Sellers must not be arranged into each other's engagement — no
  mutual upvoting, no seeded replies, no "network" of accounts inflating one another. It is the one
  growth move that converts a platform ban into forty customers losing their income, and it is why the
  mesh publishes *outward to audiences a shop already has* rather than inward to each other.
- **No shared lead pool.** A buyer's number belongs to the shop they ordered from; `meshGrowth` reads
  one shop's ledger and nothing else. There is no cross-shop list to build, sell or leak, and the code
  has no path that would let it read across handles.
- **Cost must stay flat per shop.** Content costs 0 KV writes a day (the feed is derived), state costs
  at most 1, reads are unmetered at this volume — so a seller with 300 followers and one with 30,000
  cost the same to run, and the plan's budget is not what caps growth. That is the whole reason the mesh
  is derived-from-rows instead of stored.

## What to build, in the order that pays

**Shipped in v0.9.2** (this is the part that made the rest worth writing): `MESH_PITCH_TOKENS` +
`meshIsPitch`, `meshValueBeats`, `MESH_AUTONOMY`, `meshGrant` and `meshAutoPlan` in the shared core;
`POST /api/mesh/auto` as the one save that grants or revokes; the public `/s/<handle>/mesh.json`
carrying an `auto` section so the state of a shop's voice is visible to the world that reads it; and
`meshGrowth` in the ops view, which is the outreach queue with nothing automated in it.

**Now, cheap, and mostly wiring.** (a) A `mirror` step: take one approved beat and emit the three shapes
it needs — 280-character, a board post with the price line, and a WhatsApp paragraph with the deep link —
from the *same* `meshPack` render, so a channel never rewrites a claim. (b) An RSS/Atom feed per shop at
`/s/<handle>/feed.xml`, because it costs nothing and every aggregator already speaks it. (c) Nostr
publish as a script in `scripts/` (the pipeline doc already treats it as the mirror of record; a key per
shop, kept in the shop's own repo, not ours — that is the "runs on your infrastructure" rule).

**Next, because it needs the yield ledger to be honest.** (d) Per-node counters on the `mesh:seen` state
and a ranking that demotes a node after two zero-yield windows. (e) A `bsky-audit` result that can name a
real shop and link to its `/s/<handle>` — inbound, not outbound, so it never touches the approval rule.

**Later, and only if the free half runs out of room.** (f) The paid-plan version of the same mesh: Durable
Objects for a cross-isolate counter, which is the correct shape for the rate limiter, and the headroom to
let each shop publish on more windows. Nothing in this design has to change to take it — that is the
point of writing the caps as data.

## Deliberately not here

Auto-posting to a merchant's followers. Buying reach. Engagement pods. A "content calendar" that is a
calendar and not a budget. Anything that would need a merchant to trust us with a channel credential —
every node a merchant owns is one they hold, exactly as hunta keeps the data plane on the customer's own
repo. And no metric we cannot reproduce from a row: if the number is not on a ledger we read today, it
does not go in a post, in a report, or in this file.
