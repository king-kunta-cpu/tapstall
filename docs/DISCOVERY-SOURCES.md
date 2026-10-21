# Discovery sources — what is wired, what it costs, what it will not do

Written 2026-10-21, after the complaint that **1–3 leads a day is not a business**. Everything below
was probed from the same kind of address a Cloudflare Worker uses, not from a laptop.

## The one-line answer

Three free directories are now wired (ZW, KE, NG), the daily pass asks all four markets, and the
ceiling is **12 candidates a day instead of 1–3**. The remaining ways to go materially higher all
involve either a key or somebody's terms of service, so they are your call, not mine to take.

## Wired today (free, no key, no login)

| Country | Source | How it is read | State |
| --- | --- | --- | --- |
| ZW | `classifieds.co.zw/directory` | 40 categories → listing blocks → `tel:` / `wa.me` | live since v1.7.7, produced the first real lead |
| KE | `businesslist.co.ke/?q=<phrase>` | phrase search → company page → `tel:` on the page | **new in v1.9.0** |
| NG | `businesslist.com.ng/?q=<phrase>` | same platform, same parser | **new in v1.9.0** |
| ZA | *none* | — | see below |

Phrases come from the directory's own words, not a playbook's: `web design`, `website design`,
`digital agency`, `software company`, `accountants`, `bookkeeping`, `tax consultants`, `auditors`,
`point of sale`, `computer shop`, `electronics shop`, `weighing scales`, `business association`,
`chamber of commerce`.

Numbers are normalised to something a seller anywhere can dial — `0726239033` in Kenya becomes
`254726239033` — and refused if they are not a plausible number for that market.

## Why South Africa has no directory

| Candidate | Result from a Worker address |
| --- | --- |
| `yellowpages.co.za`, `yep.co.za` | 200 but a 290-byte JS shell — nothing to read |
| `cylex.co.za`, `brabys`, `infobel.co.za`, `za.all.biz` | `403 Just a moment…` (Cloudflare interstitial) |
| `vconnect.com`, `thebiz.co.za`, `findservices.co.za` | connection failed |
| `hotfrog.co.za`, `sa-directory.co.za`, `businesslist.co.za` | marketing pages, no listings, no `tel:` |
| `sabusinessdirectory.co.za` | redirects to yep.co.za — dead |

South Africa is covered by the map leg (OpenStreetMap has real ZA coverage, already wired) and would
be covered by a keyed search provider. It has no free directory that answers a Worker, and I am not
going to claim one does.

## Paid search: what it actually costs

| Option | Free tier | Price after that | Verdict |
| --- | --- | --- | --- |
| **Brave Search API** | **2,000 queries/month, no card** | ~$5 per 1k | the one I would buy, if any |
| SerpAPI | 100 searches/month (a trial) | ~$75 per 5k | poor first rung, good data |
| Serper | 2,500 one-off trial credits | ~$50 per 5k | same shape, cheaper, less proven |
| Bing RSS (current) | free, keyless | — | honours neither the market nor the query; it is a formality |

**Recommendation:** Brave, and only Brave, and only because 2,000 a month is roughly 60–70 a day —
enough to stop guessing. It costs one secret (`BRAVE_KEY`) and no code change: the leg turns on in
the next pass and `/api/discover` reports `search: {state: "on"}`. Serper and SerpAPI would both work
through the same code path if you prefer them; their keys are equal live secrets and belong in
Worker secrets, never in the repo.

Until a key exists the search leg reports `state: "off"` **with the reason and the price**, rather
than silently returning Bing's guesses.

## LinkedIn and Facebook: no, and why not

You asked for free LinkedIn and Facebook scraping. I am not going to build it, and it is better you
hear the reason plainly than get a vague "it's complicated":

- **Both require a session** for people/company search. Scraping behind a login means holding
  somebody's cookies in a Worker — that is a credential-handling problem on top of a terms problem.
- **Both forbid automated collection in their terms.** The block is not "we might get caught"; the
  account that gets caught is the one the whole company sells from.
- **Both refuse datacentre IPs.** Cloudflare will serve you 403/999 from a Worker regardless of what
  the terms say, so even a rule-breaking build mostly returns nothing.
- **The pitch breaks.** Tapstall's argument to an agency is "your records stay yours". A company
  that harvests profiles to make its first hundred calls cannot make that argument with a straight
  face.

What *is* legitimate and adjacent, and what I will wire if you want it:

1. **A public Facebook Page** (`facebook.com/<page>`) publishes name, category, phone and address
   with no login. That is a business publishing a contact detail, the same act as a directory
   listing. It is read like any other public page — no session, no profile data, no scraping of
   people.
2. **A business's own site**: the `og:` tags, the footer number, the WhatsApp link. Already the main
   of what the gate reads.

If you want (1), say so and I will add `facebook.com/<page>` as a *page* source with the same gate —
never a search, never a profile.

## What the numbers look like now

- Per pass: up to **24 source attempts** (3× the 8-query daily budget) and up to **12 candidates**.
- Per day: up to **20 new leads written** (`DISC_WRITES_MAX`), unchanged — the queue stays a queue.
- Expected on a normal day, with the three directories answering: **6–12 candidates**, most of them
  contactable, versus the 1–3 that started this.
- A market that is down no longer costs the day: `quiet` (answered with nothing) is reported
  separately from `errors` (refused).

## The one thing that would change the arithmetic most

Not another source — **the first seller**. Twenty leads a day a human never opens is a slower way of
having 1–3. The queue, the hook and the source URL are only worth what the first person on the phone
does with them.
