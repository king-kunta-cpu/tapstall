# The content and promotional mesh — what it is, how it moves, what it must never do

Read as the union of three things that already exist: the **hunta** machine (its published architecture,
`hunta-marketing/scripts/_data/essay-pipeline.md`, plus the voice rules in `BRAND.md`), the **COREMERCH**
substrate (the `store` repo's static Pages mesh — `products.json`, `posts/`, `sitemap.xml`, `robots.txt`,
`index.json`, all served free off GitHub Pages; `bsky-audit`; `n8n-workflow-pack`;
`free-apis-for-automators`), and **Tapstall's** own half, which shipped first, in v0.9.0: `meshPack`,
`meshJson`, `meshMark`, `meshWitness`, `MESH_BUDGET`, `GET /s/<handle>/mesh.json`, `GET /api/mesh`,
`POST /api/mesh/seen`, and the `menu`/art rules around them.

The claim, stated small: **a shop's own facts, published on a rhythm, through nodes that cost nothing,
with a human on every trigger and provenance on every sentence.** Not "growth hacking". The hunta essay
is blunt about what the alternative is — "a reputation destroyer with good marketing" — and this design
takes that as its boundary condition.

## The two sentences that decide everything else

From the hunta pipeline, the two controls that are worth stealing whole, quoted because they are load-bearing:

> The truth file is a short list of verified facts… Its whole purpose is negative: the model may only
> cite what appears there. If it is not in the truth file, it does not exist.

> Nothing sends without a yes. That rule is not a disclaimer, it is the design.

In Tapstall those already have mechanisms, which is why the mesh was cheap to build: `meshWitness` is the
negative constraint (a beat can only assert what a row read today supports — no number may be rendered
that is not on a row, and a feed error returns `priced:false` instead of a plausible figure), and the ops
confirm path is the human gate. `MESH_BUDGET` is the third: **caps enforced in software, not promises** —
three beats a day, two of them value, one promo at most, a seven-day cooldown per item.

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
2. **A human on the trigger.** No node auto-publishes for a merchant. Approval is a state, and the state
   lives in `mesh:<handle>`.
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

## What to build, in the order that pays

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
