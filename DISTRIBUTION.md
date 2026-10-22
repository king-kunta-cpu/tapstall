# Where to put this in front of people

A plan for attention that does not require pretending. Every channel below is one where
the work itself is the post: a paper, a failure, a working tool. Nothing here invents a
customer, a number or a client, and nothing here republishes the parts of the practice
that are private.

**The line, stated once:** distribute the *front door*, the *abstracts* and the
*artefacts you own outright*. Do not distribute full texts of works marked all rights
reserved, the interiors of the two unpublished books, the closed consoles, the lead
lists, or any credential. `pages/public/` is the boundary — if a file is in there, it is
public on purpose; if it is not, it does not leave the repository.

**What to point at.** Never the home page alone. Every post links one specific work page
(`/portfolio/works/<id>.html`) or one running tool. A front page asks a stranger to care
about a person; a work page lets them care about a problem.

---

## 1. Today: make it findable and citable (2 hours, highest leverage)

| Action | Why it matters | Where |
|---|---|---|
| **Google Search Console** — verify `king-kunta-cpu.github.io`, submit `sitemap.xml` | Without this, indexing is luck. With it, you see the queries you already rank for and can fix the pages that nearly worked | search.google.com/search-console |
| **Bing Webmaster Tools** — same domain, same sitemap | Bing feeds ChatGPT's browsing and DuckDuckGo; this is the cheapest AI-visibility win that exists | bing.com/webmasters |
| **Mint DOIs for the four papers on Zenodo** | A DOI makes a working paper citable, permanent, and indexable by Google Scholar. It also gives each paper a second front door that academic search trusts | zenodo.org (GitHub login, upload the PDF, choose *Report*) |
| **ORCID iD** — add the works, set the site as your homepage | The identity graph that academic search, Wikipedia editors and publishers actually read | orcid.org |
| **Google Scholar profile** — add the papers manually | Scholar auto-links PDFs it finds; a verified profile with the same name and affiliation resolves the "is this one person?" question that splits your ranking | scholar.google.com |
| **Wikidata item** — one for you, one for Jacaranda Labs, one for each product you can source | Wikidata is the backbone of Google's Knowledge Graph and of most answer engines. Every claim needs a source URL — yours are your own pages | wikidata.org |
| **Crunchbase / LinkedIn company page for Jacaranda Labs** | Entity recognition: the company becomes a thing, not a string | crunchbase.com, linkedin.com |

Two of these (Search Console, Bing) are the difference between "published" and
"discovered". The DOI step is the difference between "a PDF on GitHub" and "a paper".

---

## 2. This week: the free tool is your best funnel

You already own the highest-converting asset a person can have: a **free tool with no
signup** (the Bluesky Growth Audit) and a **useful calculator** (Tapstall's fee
calculator). Tools get links; essays get nods.

- **Submit the audit to tool directories** — AlternativeTo, Product Hunt (as a free
  utility, not a launch stunt), Tiny Startups, Indie Hackers products, Hacker News
  *Show HN* on a weekday morning UTC.
- **Show HN framing that works:** "Show HN: A free Bluesky audit that tells you what to
  fix, not a score". First comment: what it measures, what it deliberately does not, and
  the one thing it got wrong in testing. HN rewards the confession.
- **Write one post per tool** on dev.to and Hashnode: the design decision, the incident,
  the fix. Both have domain authority and both syndicate with a canonical link back.
  Set `rel=canonical` to your page — dev.to supports it in the front matter.

---

## 3. The work-by-work angles

Each of these is a different room, because each work answers a different question. Post
the *argument*, not the announcement.

| Work | The post | The room |
|---|---|---|
| **Order Without Custody** | "Small merchants don't have a payments problem, they have a reconciliation problem" — the five governance signatures, with the failure taxonomy | r/Zimbabwe, r/smallbusiness, Indie Hackers, dev.to, LinkedIn |
| **The Ledger and the Shopkeeper** | The forty-tab panic, and the uncomfortable arithmetic of a $0 rail | r/Entrepreneur, r/africa, Hacker News (as an essay, not a book ad) |
| **The Sovereign Micro-Enterprise** | "One person, zero capital, run by agents — and the seven ways it failed silently" | r/AI_Agents, r/LocalLLaMA, Hacker News, dev.to |
| **Grounded Cadence** | "Your content agent invents customers. Here's the deterministic editor that stops it" | r/SEO (careful, read rules), dev.to, Indie Hackers |
| **From Spreadsheet Interface to Governable Autonomy** | The Evidence–Authority–Resource Contract — a one-page diagram people can steal | LinkedIn, r/ExperiencedDevs, Hacker News |
| **Intelligence, Data and Judgement** | "A textbook written to be taught from" — the eight labs, free | r/learnmachinelearning, r/artificial, university course lists |
| **Emotional Engineering…** | "Ethical adoption is not emotional pressure" — the distinction, applied to a bad day | r/UXResearch, r/HCI, LinkedIn |
| **The Musk Mirror / Rocket Man** | The prediction-vs-outcome gallery — the single most shareable thing you own | r/space, r/China, X, Hacker News |
| **The Governable Enterprise** | The ten operating tools, one per week as a series | LinkedIn series, dev.to series |

**The rule for cross-posting:** rewrite the first two sentences for each room. The same
text in five subreddits reads as spam in all five and gets you banned from the one that
mattered.

---

## 4. The channels that compound

- **Bluesky** — you run an audit for it; use it. Post the work, reply to people talking
  about agent reliability, and let the tool do the outreach for you.
- **X** — one thread per paper: the claim, the failure, the number, the link. Threads
  with a confession in them travel.
- **LinkedIn** — the consulting funnel. One post a week, each a single incident from a
  running system, no hashtag soup, the link in the first comment.
- **GitHub** — `README.md` at the repository root is a top-20 search result for
  "tapstall". Add topics (`ai-agents`, `cloudflare-workers`, `governance`,
  `merchant-commerce`), a social preview image, and a link to the portfolio at the top.
- **Awesome lists and directories** — a PR to `awesome-ai-agents`, `awesome-cloudflare`,
  `awesome-zimbabwe`, `awesome-design-science`. Each accepted PR is a permanent,
  human-curated backlink.
- **Whop** — you already have two storefronts; the profile needs a banner, a bio with the
  portfolio link, and the free audit listed as a product even if it costs nothing.
- **Newsletters** — pitch, don't submit. One paragraph: the finding, the link, why their
  readers care. AI newsletters and African tech newsletters are both short of
  practitioner accounts with numbers in them.
- **Internet Archive / Scholar Archive** — upload the CC BY 4.0 papers; another permanent
  full-text copy that search can index.
- **Podcasts** — the "fifteen years of techno-preneurship including the failures" angle
  is a booking. Send three bullets, not a CV.

---

## 5. What not to do

- No bought followers, engagement pods, or "growth" services. They convert into nothing
  and they are visible.
- No posting the same text across communities on the same day.
- No claims of traction. You have real artefacts: thirteen works, seven systems, 420
  assertions, a published failure taxonomy. Those are stronger than a made-up number and
  they survive being checked.
- No DM blasts. The published numbers are for people who want to reach *you*.

---

## 6. Measuring it without analytics

The site deliberately has none. What you can read instead, all of it aggregate:

- **GitHub** → Insights → Traffic (views, clones, referrers) and each release's download
  count — that is the download funnel, per file, by name.
- **Search Console** → queries and impressions. This is the only place you learn what
  people actually type before they arrive.
- **Cloudflare dashboard** for the Workers — request counts per product.
- **Whop** — storefront views and orders.

If a channel produces nothing after three honest attempts, drop it. Attention compounds
through the one room where your work is genuinely the answer, not through being
everywhere.

---

## 7. The order I would do it in

1. Search Console + Bing + sitemap (today — nothing works without it).
2. Zenodo DOIs + ORCID + Scholar (this week — makes the papers real).
3. Wikidata + Crunchbase (this week — makes the person and the company a thing).
4. Show HN on the audit + Product Hunt as a utility (next week).
5. One LinkedIn post a week and one dev.to post a week, for eight weeks (the compounding
   pair).
6. Awesome-list PRs in one sitting (an afternoon, permanent links).
7. Newsletter pitches only after the first three posts have something to point at.
