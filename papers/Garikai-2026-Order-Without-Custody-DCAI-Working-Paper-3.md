---
title: "Order Without Custody: Governance-First Design for Merchant Commerce Rails in Low-Infrastructure Economies — The Tapstall Case"
author: "Courage Garikai"
affiliation: "Tapstall · Jacaranda Labs, Harare, Zimbabwe"
series: "Distributed Cognitive Autonomous Infrastructure (DCAI) programme — working paper 3"
date: "21 October 2026"
version: "1.0 (pre-submission draft)"
licence: "CC BY 4.0"
---

# Abstract

Small merchants across sub-Saharan Africa already sell at scale — through WhatsApp threads, Facebook pages, and a phone number painted on a wall — but they sell without a record. The order exists as a chat message, the payment as a screenshot, and the month-end as a memory argument between a shopkeeper and whoever keeps the books. The obvious remedy, a payments platform, is the one remedy that most of these merchants cannot and should not accept: it requires custody of their money, which in weak-recourse jurisdictions converts a bookkeeping problem into an insolvency risk, and it prices itself as a share of volume, which taxes the merchant precisely for succeeding. This paper argues that the binding constraint on digital commerce at this tier is not payment capability but *reconciliation* — the ability to state, without custody, who owes what and what is still outstanding — and that reconcilability is an architectural property, not a feature.

The argument is developed as a revelatory single case (Yin, 2018). **Tapstall** is a merchant order rail built and operated by the author on a zero-marginal-cost stack (Cloudflare Workers and KV free tiers, GitHub Actions, Whop for the subscription leg only), serving Zimbabwe, South Africa, Kenya and Nigeria. It holds no balances, makes no payouts, performs no currency conversion, and prices flatly. Its money-shaped output is not a wallet but a document: a per-day settlement statement that separates *matched* from *expected*, and reports *to chase* as the single actionable number.

Five mechanisms are formalised and each is tied to an artefact that a reader can inspect: the **No-Custody Rail (NCR)**, with a completeness result showing that the statement is derivable from the event log alone, and therefore that certainty does not require custody; **Admission-Gated Discovery (AGD)**, a seven-predicate admission gate for autonomous prospect discovery, with a *provenance coverage* measure that makes each hook checkable on the page it came from; **Reserve-Ladder Scheduling (RLS)**, a lexicographic budget regime under which automation can never be the reason an order fails to land; **Surface-Disjoint Multi-Tenancy (SDM)**, a lattice of posting and visibility surfaces that keeps platform operators permanently outside the merchant's audience; and the **Constrained Persuasion Doctrine (CPD)**, a set of forbidden persuasive moves binding on all generated copy.

The empirical heart of the paper is forensic rather than promotional. Across the build's release chain (v1.0.0 to v1.9.1; 419 passing assertions on a 14,855-line codebase), five classes of *governance* failure are identified from verbatim production traces: provenance collapse (47 pre-gate "leads" that were page titles), budget cannibalisation (a single dead directory consuming a day's discovery allowance), representation drift (a Nigerian trunk zero that produced a number nobody could dial), surface collision (two Apps Script files competing for one menu and one queue view), and custody leakage attempts in documentation. Each is stated as a signature, a detector, and a design response. The taxonomy is offered as reusable diagnostic vocabulary for anyone operating autonomous systems under legal and financial constraint.

The paper is candid about what it is not: there are no paying customers in the measurement window, no control condition, and no inference beyond the case. Its claims are architectural, its evidence is reproducible, and its contribution is a demonstration that a merchant rail can be built to be *auditable before it is profitable* — and that in this market that ordering is not a virtue but a precondition.

**Keywords:** merchant commerce; reconciliation; payment custody; platform governance; agentic AI; admission control; multi-tenancy; informal economy; mobile money; design science; single-case research; sub-Saharan Africa

---

# 1. Introduction

## 1.1 The problem with the obvious answer

Consider a hardware shop in Harare that sells tills and weighing scales, and an accountant in Bulawayo who keeps books for eleven such shops. The shop already takes orders: a customer messages a photograph of a scale they want, the shop replies with a price in USD, the customer sends an EcoCash transfer or hands over cash, and the goods are delivered by a cousin on a Friday. This works. What does not work is the record. At month-end nobody can say which orders were paid, which were promised, which were delivered, or which customer still owes forty dollars. The accountant reconstructs the month from screenshots and a WhatsApp search box, and prices her uncertainty into the fee.

The standard prescription is a payments platform: a wallet, an acceptance product, a dashboard. Three properties of that prescription make it wrong for this tier of merchant.

**Custody.** A platform that accepts money on a merchant's behalf is holding funds it must later disburse. In jurisdictions with slow or contested commercial recourse — and Zimbabwe's multi-currency, cash-scarce, high-inflation-memory economy is the paradigm — that intermediation is a risk transfer the merchant did not ask for. When the platform fails, the merchant's money is inside the failure. The literature on mobile money is largely a literature about *inclusion* (Suri and Jack, 2016; Jack and Suri, 2014); the literature on platform failure is largely about consumers (Rochet and Tirole, 2003; Parker and Van Alstyne, 2005). The merchant-as-creditor of an insolvent intermediary is the gap between them.

**Percentage pricing.** A fee proportional to volume is a tax on success and a subsidy to failure. For a merchant whose monthly turnover is a few hundred dollars, the difference between 1.5% and a flat annual fee is not a pricing preference; it is whether the second employee gets hired.

**Capability without custody.** Nothing about the merchant's actual problem — *knowing* — requires the platform to touch money at all. What the merchant lacks is not a recipient of funds but a **record that both parties trust**, produced without the platform ever becoming a counterparty.

## 1.2 The thesis

This paper's thesis is that for merchants at this tier the scarce good is **reconcilability**: the capacity to state, at any moment and from evidence both sides can inspect, what was ordered, what was matched against a payment the merchant received directly, what remains expected, and what must be chased. Reconcilability is a design property of a socio-technical system. It can be engineered without custody, and engineering it without custody is strictly better for the merchant than engineering it with custody, because it removes an entire failure class (the intermediary's solvency) instead of insuring against it.

The paper demonstrates the thesis with **Tapstall**, a merchant order rail deployed in production on a zero-marginal-cost stack. Tapstall gives a merchant a storefront, an order link, a one-tap confirmation for the buyer, and — the artefact that carries the thesis — a **settlement statement** that the shop can hand to its accountant. Money moves between the buyer and the merchant through rails the merchant already uses. Tapstall holds nothing.

## 1.3 Contributions

1. **A design theory of custody-free reconciliation** (§5.1): the No-Custody Rail, with definitions, four invariants, and a completeness proposition showing that the statement is a *function of the event log* — so the merchant's certainty is not purchased with counterparty risk.
2. **An admission-control formalism for autonomous discovery** (§5.2): a seven-predicate gate, a *provenance coverage* measure $\kappa_{\text{hook}}$, and a precision argument explaining why an ungated crawler produces exactly the failure it produced here (47 rows of page titles).
3. **A starvation-freedom result for platform budgets** (§5.3): the reserve ladder under which orders are structurally immune to automation's appetite, stated as a theorem over priority reserves.
4. **A surface lattice for multi-tenant governance** (§5.4) and **a doctrine of constrained persuasion** (§5.5), both offered as constraints that are checkable in code and in copy rather than as policy prose.
5. **An empirically grounded taxonomy of governance failures in autonomous systems** (§7): five classes (provenance collapse, budget cannibalisation, representation drift, surface collision, custody leakage) with verbatim production evidence, signature predicates, detectors and design responses.
6. **A measurement base** (§6) for a zero-capital merchant rail: throughput, budget consumption, verification surface, and the refusals — because a discovery system's honesty is better measured by what it declines to file than by what it files.

## 1.4 Reading map

§2 situates the work across four literatures. §3 states the research design and its disciplines. §4 describes the case. §5 is the formal core and the paper's theoretical contribution. §6 measures. §7 is the forensic heart. §8 discusses implications. §9 concedes threats to validity. §10 concludes with an agenda.

---

# 2. Background and related work

## 2.1 Entrepreneurship without capital: effectuation, bricolage, and their limit

Sarasvathy's (2001) effectuation theory describes expert entrepreneurs reasoning from *means at hand* rather than from a pre-specified goal: they take affordable losses, stitch partnerships from self-selected stakeholders, and treat surprises as resources. Baker and Nelson (2005) describe bricolage — making do with whatever is to hand, often violating institutional expectations about what a firm of a given size should look like. Both traditions explain the merchant in §1.1 remarkably well: she has a phone, a customer list, a cousin with a van, and a cousin with a bank account, and she assembles a functioning commerce system out of exactly those parts.

What neither tradition was written to explain is what happens when the means at hand include **software agents that act under the founder's name several times a day**. The effectuation literature's inventory question ("what do I have?") acquires a new kind of answer — *I have a machine that can call four hundred prospect pages a week* — and with it a new kind of hazard, because an agent's acts are attributable to a human who may not have watched them happen. This paper takes effectuation as given and asks the engineering question that follows from it: **what must be true of the architecture for that attribution to remain honest?**

## 2.2 Mobile money, informal commerce, and the record gap

The economics of mobile money is well developed. Suri and Jack (2016) estimate long-run welfare effects of M-PESA access in Kenya; Jack and Suri (2014) show risk-sharing improvements through remittance networks; the GSMA's annual state-of-the-industry reports document agent networks and interoperability. This literature is overwhelmingly about **inclusion and transfer** — moving value between people who lacked access to banking. It says comparatively little about the *bookkeeping* consequences of that success. When a shop takes payment on a phone, the payment rail gets a record and the shop does not: the rail's ledger is the merchant's bank statement row, arriving late, aggregated, and anonymous with respect to which order it settled. The reconciliation gap this paper addresses is, in a sense, a second-order effect of successful inclusion.

Work on informal retail and micro-enterprise operations (e.g. credit and inventory studies in Nairobi's and Harare's markets) documents exactly the phenomenon: high transaction counts, low record fidelity, and credit relationships mediated by memory. Tapstall is an intervention at that seam.

## 2.3 Platform economics and the custody question

Two-sided market theory (Rochet and Tirole, 2003; Parker and Van Alstyne, 2005) frames platforms as price structures governing interactions between groups, and the payments literature treats intermediation as the platform's natural profit centre (Rochet and Tirole, 2011, on interchange). The regulatory literature on e-money (E-Money Directive 2009/110/EC; national payment-system acts across SADC) treats custody as a licensed activity precisely because holding funds creates systemic and consumer risk.

A merchant-facing platform may therefore take one of three stances: (i) become a licensed intermediary (custody, float, licensing, capital); (ii) become an agent of a licensed intermediary (custody moves but does not vanish, and the platform inherits onboarding duties); or (iii) **refuse custody and deliver the record instead**. The third stance is almost absent from the platform literature because it monetises badly under percentage pricing — which is the point. Flat pricing and no custody are not independent choices; they are the same choice seen from two sides, since a platform that takes no share of volume has no reason to want custody of it.

The accounting literature supplies the constructive half. The idea that a transaction should be recorded in more than one place, and that agreement between places is the substance of truth, runs from double-entry bookkeeping through Ijiri's (1975) axiomatics of accounting measurement to Grigg's (2005) proposal of *triple-entry* accounting, in which a cryptographic third entry seals a transaction between two parties. Tapstall's statement is a modest, practical instance of the same intuition: the buyer's confirmation, the merchant's own receipt of funds, and the platform's event log are three places, and the statement is what happens when they are compared rather than asserted.

## 2.4 Observability, and the log as witness

Site reliability engineering (Beyer et al., 2016) established the operating doctrine that availability is managed through cheap, honest proxies — error budgets, golden signals — and that humans instrument chiefly for failure modes they already understand. Oliner and Stearley (2007) demonstrated across five supercomputers that most major failures are preceded by anomalies visible in ordinary logs, and simultaneously that operators under-instrument novel failure modes. For an autonomous business system the consequence is stark: **the failure you will suffer is the one you did not write a log line for.**

Contemporary agent observability (span-level tracing under the OpenTelemetry GenAI conventions) is arriving, but presumes SDK cooperation and a vendor. The pattern in the case is older and portable: an append-only event record plus an independent reader that checks invariants. The reader is the paper's *Idle Witness* analogue, and §5.3 makes its budget an architectural object rather than an operational habit.

## 2.5 Agentic systems: capability versus custody

The LLM-agent literature is dominated by capability (Xi et al., 2023; Wang et al., 2024; Guo et al., 2024) and evaluation (Jimenez et al., 2024; Yehudai et al., 2025). Framework practice (Wu et al., 2023; Anthropic, 2024) concerns how to build agents that succeed at tasks. The question this paper asks is orthogonal and, for a small firm, prior: **who is watching, under what budget, with what revocation path, and what will the record show afterwards?** The EU AI Act (2024), notably Article 14 on effective human oversight, elevates a version of this question to law for high-risk systems; Lebovitz, Lifshitz-Assaf and Levina (2022) supply evidence that professional deference to machine judgment is conditional and frequently misplaced. Both point the same direction: oversight must be *designed into the workflow* at specific, justified boundaries — which is what §5.5's gating rule attempts for the persuasion surface, and what §5.2 attempts for discovery.

## 2.6 Design science and the single case

The work is design science in the sense of Hevner et al. (2004): an artefact (the rail) is built to address a class of problems (reconciliation without custody), and knowledge is extracted from its construction and use. Following Yin (2018), the study is a *revelatory single case* — revelatory because the phenomenon (a custody-free reconciliation artefact in production for merchants in four African markets) is not otherwise accessible to study. The unit of analysis is the **governance architecture**, embedded in one operator–platform–merchant triad. Generalisation is analytic, not statistical: the mechanisms are offered as transferable design knowledge, and the case as their demonstration.

---

# 3. Research design and method

## 3.1 Positionality

The author designed, built and operates the system under study, and holds the owner role in it. This is the participant-inventor stance familiar from engineering research and close to Schön's (1983) reflective practice; it is not detached social science and is not presented as such. Positionality is compensated by four disciplines, each of which is auditable in the artefacts:

1. **Pre-registered invariants.** What counts as a failure is fixed in code and in tests *before* the narrative is written. If the suite does not assert it, the paper may not claim it. The suite is public in the repository and its count is quoted per release.
2. **Verbatim machine evidence.** Incidents are quoted from production responses, stored records and commit diffs, not reconstructed from memory. Where a quotation is abbreviated, the abbreviation is marked.
3. **Adversarial self-audit.** Dedicated audit passes whose *verdicts* are also recorded (including the ones that found defects in the author's own prior release) are part of the record; §7 draws on them.
4. **Negative reporting.** Refusals, misses and unbuilt features are reported with the same prominence as successes. A discovery system that files nothing on a given day is reported as such, not smoothed.

## 3.2 Evidence base

| Evidence class | Source | Window | Use |
|---|---|---|---|
| Release chain | git log, version string, deploy telemetry | v1.0.0 → v1.9.1 (2026) | Chronology; what changed and why |
| Verification surface | test suite (`npm test`), live smoke tests, bundle build | 419 assertions at v1.9.1 | Bounds on what may be claimed |
| Production state | live endpoints, KV records read directly | continuous | Cross-checks; incident traces |
| Discovery traces | per-pass summaries, candidate records, rejection counts | v1.7.1 → v1.9.1 | §6 throughput; §7 provenance |
| Configuration artefacts | policy documents, page copy, script files | continuous | §5.4, §5.5 compliance claims |

## 3.3 Measurement definitions

All quantities are windowed and dated; none is impressionistic.

- **Pass**: one scheduled discovery execution. **Candidate**: a record that survived every admission predicate. **Filed lead**: a candidate written to durable storage subject to the daily write budget.
- **Attempt budget** $A$: maximum source queries per pass. **Candidate ceiling** $\Lambda$: maximum candidates per pass. **Daily write ceiling** $W$: maximum new leads per day.
- **Provenance coverage** $\kappa_{\text{hook}} \in [0,1]$: the fraction of filed leads whose stated hook is verifiable at the recorded source URL. Measured by inspection in §7.1; designed to equal 1 by construction after v1.9.0.
- **Budget utilisation** per source: attempts consumed ÷ results returned, reported to expose budget cannibalisation (§7.2).
- **Statement completeness**: the fraction of statement figures reproducible from the event log alone, computed by re-deriving the statement for the same day and comparing to the API response (§5.1, tested).

## 3.4 The disciplines that constrain the paper's claims

Three rules were adopted at the outset and are visible in the artefacts. First, **nothing is called live until the production endpoint confirms it** — a version string served from the edge, not a build log. Second, **no arithmetic is duplicated**: the statement page and the statement API call one implementation, so a page cannot disagree with a file. Third, **no credential appears in a document**: the audit trail may name a credential class but never a value, and one commit in the chain exists solely to redact fragments that had leaked into documentation (§7.5).

---

# 4. The case: anatomy of a custody-free merchant rail

## 4.1 What Tapstall is, in one paragraph

A merchant registers a shop, publishes a small catalogue as a tabular feed, and receives a public storefront at a handle. The merchant shares one link — in a WhatsApp thread, on a Facebook page, printed on a receipt — and the buyer opens it, picks items, and places an order without an account. The merchant sees the order, taps to confirm it, and the buyer receives a confirmation whose only job is to make the record two-sided. Money moves on rails the merchant already uses: cash on delivery, a mobile-money transfer to the merchant's own wallet, a bank transfer to the merchant's own account, or a card processor that pays the merchant directly. Tapstall records; it does not accept, hold, convert or disburse. At the end of the day the merchant opens a **settlement statement** and can tell, in one screen, what came in, what is expected, what to chase, and what the platform's flat fee was.

Three actor classes exist, and the distinctions are governance, not marketing:

| Class | Who | May do | May never do |
|---|---|---|---|
| **Owner** | the platform's proprietor | operate, audit, provision, revoke | post to a merchant's audience as if a merchant |
| **Seller** (class B) | the proprietor's employees, selling the platform | carry the platform's own offer to prospects | hold merchant credentials or merchant money |
| **Operator** (class C) | tenants — agencies, accountants, resellers running the rail for their own clients | see and act within their own tenant's scope | be posted to, or be treated as a prospect, ever |

The class-C exclusion deserves emphasis because it inverts normal SaaS behaviour: an operator is a *customer*, and the platform's own content machinery is structurally forbidden from addressing it. A tenant who resells the rail must never receive the platform's marketing, because the platform's marketing is the tenant's product. §5.4 formalises this as a surface-disjointness property rather than a policy.

## 4.2 The substrate, and why it is part of the argument

The platform runs on Cloudflare Workers with two KV namespaces (a stores namespace and an orders namespace), a bundle built from source and shipped unchanged to production, and GitHub Actions for deploy. Subscription money is collected through a marketplace page; merchant payment flows never traverse the platform. Total marginal cost: **zero** within free-tier quotas; total fixed cost: a domain and the author's time.

Making the substrate part of the argument is deliberate. A governance architecture that requires paid infrastructure is not available to the merchant in §1.1, and a claim about what small firms can do must be demonstrated at their price point. The cost of zero is paid in **quotas**, and quotas are the object of §5.3: the free stack is not one budget but five, and they do not bind equally. Worker requests and KV reads (100,000/day each) are roomy. KV writes, deletes and lists (1,000/day each) are not.

## 4.3 The verification surface

At v1.9.1 the codebase is 14,855 lines across five principal files (worker 5,930; core 4,635; discovery 955; rail 431; and roughly 3,000 lines of server-rendered page sources) and the suite reports **419 passing assertions**, including a live smoke test that boots the real request handler against an in-memory store and walks the merchant journey end to end: register → storefront → menu feed → order → one-tap paid → dashboard → export → renewal → suspension. The suite exists because unit tests of pure logic cannot catch a reference error in the handler, and four such defects reached production before the live test was written. This is the paper's first empirical claim and it is a claim about *method*: **the verification surface is a governance instrument**, because it bounds what the operator is allowed to believe.

## 4.4 The commercial frame

Pricing is flat and deliberately unremarkable: a founding annual tier at USD 60, a monthly tier at USD 7 with local-currency twins, and agency tiers at USD 149/month (five seats) and USD 299/month (unlimited), against a zero-price pilot of sixty days for ten merchants. The price is set against the merchant's *whole* cost of not knowing — an accountant's reconstruction hours, a disputed debt, a month-end argument — and not against a percentage of what she sells. §5.6 argues that this is not altruism but coherence: flat pricing and custody-free architecture are the same commitment viewed from the revenue side.

## 4.5 The document that carries the thesis

The settlement statement (Fig. 1 conceptually) reports six quantities for a day — *expected*, *matched*, *to chase*, *refunded*, *fees*, *net* — a per-rail table of orders and outstanding amounts, and one sentence naming the single thing to do next. It is server-rendered, contains no script, sets `no-store`, and is reachable only by a live merchant session; an anonymous request is redirected to the door with the shop named, a dead session gets a page that says the session no longer works and that nothing about the money changed, and an unknown shop gets a 404. A day with no orders says so in words — "nothing on this day" — rather than printing a wall of zeros that a merchant would read as a failure.

The statement is the paper's *unit of analysis made concrete*. Everything in §5.1 is an attempt to say precisely what that document is, why it can be trusted without custody, and what would falsify it.

---

# 5. Theory: five mechanisms, formalised

This section states the mechanisms as definitions and propositions. The mathematics is deliberately undergraduate: a governance claim the operator cannot compute is a governance claim the operator will not use (a design constraint inherited from the DCAI programme's first working paper and adopted here without modification).

## 5.1 The No-Custody Rail (NCR)

### 5.1.1 Definitions

Let a merchant $m$ maintain a catalogue $\mathcal{C}_m$ and receive **orders** $o = (m, \text{buyer}, \text{items}, \text{amount}, t_o)$. Let $\Pi$ be the set of payment rails available to the merchant (cash, mobile money, bank transfer, card processor), and let $P(o) \in \Pi$ be the rail on which the merchant *actually* received funds for order $o$, if any. Crucially $P(o)$ is observed **by the merchant, on the merchant's own rail** — never by the platform.

**Definition 1 (Event log).** The platform maintains an append-only event sequence
$$L = \langle e_1, e_2, \dots, e_n \rangle, \qquad e_i = (k_i, \tau_i, \sigma_i, d_i)$$
where $k_i$ is the event kind (order, confirm, proof, memory, refund, fee, settle), $\tau_i$ its timestamp, $\sigma_i$ its actor (buyer, merchant, system), and $d_i$ its payload. $L$ is the platform's only claim to truth.

**Definition 2 (No-custody invariant).** The platform satisfies NCR iff at every time $t$ its holdings of merchant funds are identically zero:
$$\text{Custody}(t) \;=\; 0 \quad \forall t,$$
and its code contains no operation that debits, credits, converts, or disburses merchant value. Formally, for every rail $\pi \in \Pi$ and every agent process $a$, the platform's reachable capability set satisfies $\text{Reach}(a) \cap \Sigma_{\text{money}} = \varnothing$, where $\Sigma_{\text{money}}$ is the set of credentials capable of moving funds.

**Definition 3 (Reconciliation partition).** For a day $D$, partition the orders with $t_o \in D$ into
$$\mathcal{M}_D \;\text{(matched)}, \quad \mathcal{E}_D \;\text{(expected)}, \quad \mathcal{R}_D \;\text{(refunded)}, \qquad \mathcal{M}_D \cup \mathcal{E}_D \cup \mathcal{R}_D = \mathcal{O}_D,$$
where $o \in \mathcal{M}_D$ iff a merchant-side settlement exists for $o$ in $L$; $o \in \mathcal{E}_D$ iff the order is confirmed and no settlement exists; $o \in \mathcal{R}_D$ iff a refund event precedes settlement. Then
$$\text{expected}_D = \sum_{o \in \mathcal{E}_D} \text{amt}(o), \qquad \text{matched}_D = \sum_{o \in \mathcal{M}_D} \text{amt}(o), \qquad \text{to chase}_D = \text{expected}_D .$$

**Definition 4 (Statement function).** The statement is the map $S_D = \Phi(L_{D})$, computed as the tuple $\langle \text{expected}_D, \text{matched}_D, \text{to chase}_D, \text{refunded}_D, \text{fees}_D, \text{net}_D \rangle$ together with per-rail counts, where $\text{net}_D = \text{matched}_D - \text{fees}_D$ and fees are a flat function of the subscription, never a share of $\text{matched}_D$.

### 5.1.2 Results

**Proposition 1 (Completeness without custody).** $S_D$ is a function of $L_D$ alone; no external account of the platform's own is required to compute it.

*Justification.* By Definitions 3 and 4 every term of $S_D$ is a sum of order amounts selected by predicates over events in $L_D$. The only predicate that references the outside world is membership in $\mathcal{M}_D$, and it is satisfied by the presence of a merchant-side settlement *event* — which the merchant or buyer records in $L$ after the fact, on the merchant's own rail. The platform's contribution is the selection and the arithmetic, not the custody. Therefore a third party holding a copy of $L_D$ can recompute $S_D$ exactly. $\square$

*Empirical test.* The platform ships this proposition as a test: for a given day, the rendered statement page's figures are asserted equal to the JSON returned by the settlement API, and both are recomputed from the event log inside the live smoke suite. A page that disagrees with the log fails the build. This is not a stylistic preference; it is the operational meaning of Proposition 1.

**Proposition 2 (Custody elimination trades one failure class for one ambiguity).** Removing custody removes the class of failures in which merchant funds are lost, delayed or impaired by platform insolvency, fraud, or licensing action. It introduces a class of *ambiguity*: the platform cannot itself prove that a payment occurred.

*Justification.* The first clause is definitional: with $\text{Custody}(t) = 0$ there is no merchant value at risk in the platform. The second follows because $P(o)$ lies outside the platform's observation set by construction (§5.1.1). $\square$

Proposition 2 is the honest cost, and the design response is not to reintroduce custody but to **make the ambiguity small and explicit**: the partition distinguishes *matched* from *expected* and never presents either as the other; a proof-of-payment reference can be attached by the buyer on its own capability path; and the statement's single actionable number is *to chase*, which is precisely the residue of ambiguity — the merchant's short list of things that are claimed but not confirmed.

**Definition 5 (The three non-blurred sentences).** The statement and all its surrounding copy are bound by three separations: *matched* is not *paid*; *expected* is not *owed*; *to chase* is the actionable number. These are the paper's ethical invariant on the money surface, and they are enforced in copy review and in the acceptance tests.

**Proposition 3 (Fee coherence).** If the platform's revenue is a fraction $\phi$ of matched volume, the platform's incentive is to maximise $\phi \cdot \text{matched}_D$, which rewards (i) custody, since custody is how a platform reliably observes matched volume, and (ii) volume maximisation, including volume the merchant cannot service. If revenue is flat, both incentives vanish: the platform's interest is in the merchant's *continued* use, which is a function of reconciliation quality.

*Justification.* Immediate from the revenue expressions. The proposition is not that percentage pricing is unethical; it is that percentage pricing and custody-free architecture are in *tension*, so a platform claiming both should be examined for the one that will eventually win. $\square$

## 5.2 Admission-Gated Discovery (AGD)

### 5.2.1 The problem AGD answers

The platform must find merchants before merchants find it, at zero capital, without cold-mailing its way into a spam dossier. The pre-gate epoch of the case is the empirical motivation: an ungated crawler, asked for agencies and accountants in Zimbabwe, filed **47 records** across several weeks, of which **zero** were prospects. The corpus was page titles: *WhatsApp Web*, *Download WhatsApp*, *Order — definition of order by The Free Dictionary*, *Ecocash Charges Calculator 2026*, *Chewy Partner Hub*, *Uber Eats*. These are not noise in the statistical sense; they are a **category error**, and their presence in a queue that a salesperson is asked to work is worse than an empty queue, because it consumes the scarcest resource in the firm — attention — while producing the appearance of activity.

### 5.2.2 The gate

**Definition 6 (Admission predicate).** A candidate $c$ with page evidence $E(c)$ is admitted iff
$$G(c) \;=\; \neg\text{platform}(c) \wedge \text{verified}(c) \wedge \text{local}(c) \wedge \text{named}(c) \wedge \neg\text{generic}(c) \wedge \neg\text{institution}(c) \wedge \text{contactable}(c).$$
Each conjunct is a decidable predicate over the fetched page and the source record: `platform` rejects known non-businesses (social platforms, dictionaries, marketplaces, news sites, asset CDNs); `verified` rejects candidates whose page was not read; `local` requires a market signal — a place name, a country-domain, or membership of a bbox-bounded map query — with the concession that a map record's locality is its query, not a sentence; `named` requires a name of plausible length; `generic` rejects category nouns; `institution` rejects public bodies, banks, universities — and, after §7.3, charities, orphanages, NGOs and churches; `contactable` requires a published number whose digit count is valid for the market, or an address, or a checkable URL.

**Definition 7 (Provenance coverage).** For filed leads $F$ with hooks $h(c)$ and source URLs $u(c)$,
$$\kappa_{\text{hook}}(F) \;=\; \frac{|\{c \in F : h(c) \text{ is verifiable at } u(c)\}|}{|F|}.$$
The design target is $\kappa_{\text{hook}} = 1$: every hook must be checkable on the page it came from, in one click, by a person who was not present when it was generated.

**Proposition 4 (Gate precision versus source recall).** AGD raises precision at fixed recall by rejecting candidates the seller cannot act on; it cannot raise recall, because recall is bounded by what the *sources* contain.

*Justification.* $G$ is a conjunction of rejections, hence monotone decreasing in the admitted set; precision over the admitted set is therefore non-decreasing while recall is non-increasing. Raising recall requires enlarging the source set $U$ or the query phrases within it — an orthogonal design axis. $\square$

Proposition 4 resolves a tension that appears in the field as a complaint: *volume is too low*. The case's answer is architecturally specific — **the gate is not the constraint; the number of sources is**. At v1.7.7 the platform queried one directory in one country. At v1.9.0 it queries four source classes across four markets, interleaves them, and reported a real pass returning 6 Kenyan company pages and 6 Nigerian ones with dialable numbers (§6). Weakening the gate would have produced the 47-row corpus again.

**Definition 8 (Attempt budget and refunds).** Let $A$ be the maximum attempts per pass and $n = |\text{planned jobs}|$. A job that returns *no data because none exists* (an empty map result, a directory with no matching category) consumes budget; a job that *fails* (transport error, refusal) is refunded and the next source is asked, subject to $A \le 3n$ and a circuit breaker of three consecutive failures. This is the direct response to the budget-cannibalisation failure in §7.2.

## 5.3 Reserve-Ladder Scheduling (RLS)

### 5.3.1 The mechanism

The free tier's scarce resource is KV writes: 1,000 per day, shared by orders, security state, operator saves, scheduled automation and telemetry. The platform allocates them by **priority classes with reserves**, not by arrival order:

$$\text{classes} = \langle \text{money}, \text{security}, \text{operator}, \text{automation}, \text{telemetry} \rangle, \qquad r = (0, 25, 75, 200, 300)$$

where $r_p$ is the number of writes that class $p$ may not spend — i.e. must be left for higher classes. A write request from class $p$ is admitted iff

$$u + 1 \;\le\; B - \sum_{q \prec p} r_q,$$

with $u$ the writes already spent and $B = 1{,}000$. Telemetry is additionally *paced* through the UTC day so that an isolate waking at 01:00 cannot consume the whole soft ceiling.

**Theorem 1 (Starvation freedom for orders).** Under the reserve ladder, an order write can fail for lack of budget only if at least $B$ writes have been spent in the day.

*Proof.* Let $p = \text{money}$, for which $\sum_{q \prec p} r_q = 0$ by construction. The admission condition reduces to $u + 1 \le B$. Any automation write requires $u + 1 \le B - 200$, hence automation alone can bring $u$ to at most $B - 200$; adding operator ($\le B-75$) and security ($\le B-25$) classes still leaves $u \le B - 25 < B$ at every earlier class's ceiling. Therefore at least 25 writes remain available to the money class whenever any lower-class request was admitted, and more in general. $\square$

Theorem 1 is the architectural expression of a plain commitment made to the merchant: **a marketing run can never be the reason an order fails to land.** It is stated as arithmetic rather than as good intentions because the arithmetic is testable — the suite asserts the reserve ordering, and `/writes` exposes the decision reason (`reserve_for_higher_priority` versus `paced_for_later_in_day`) so that a refusal is legible rather than mysterious.

## 5.4 Surface-Disjoint Multi-Tenancy (SDM)

### 5.4.1 The lattice

Let $\mathcal{S} = \{P, B, M, S, O\}$ be the surfaces: public (anyone), buyer (an order's counterparty), merchant (a shop's owner), seller (the platform's own sales staff), operator (a tenant). Visibility is a relation $\preceq$ (can see), and posting is a separate relation $\rightsquigarrow$ (may address as audience). SDM requires that $\rightsquigarrow$ respect two constraints:

**(C1) Tenant non-addressability:** $\text{operator} \notin \text{audience}(p)$ for every platform post $p$. A tenant is a customer whose product *is* the platform's marketing; addressing it is a conflict of interest.

**(C2) Operator opacity on merchant data:** a tenant may see aggregate state of its own tenants' shops, and may never enumerate another tenant's products, items, or customers. Equivalently, the platform's operator-facing views are partitioned by tenant scope at the query layer, not filtered in the template.

**Proposition 5 (Non-reachability).** If every platform post is generated by a process whose audience parameter is drawn from $\{P, B, M, S\}$ and is validated against C1 before dispatch, then no post can reach an operator. *Justification.* Direct from the audience validation being a precondition of dispatch. $\square$

The practical force of the proposition is that it is enforced on the *generator*, not on the post: a content pipeline that cannot express an operator audience cannot leak one through a template change.

## 5.5 Constrained Persuasion Doctrine (CPD)

### 5.5.1 The constraint set

Persuasion is the surface where a platform most easily becomes a liar, and where generated copy makes lying cheap. The case adopts a doctrine of five legitimate levers — righteous resentment of the structural gap (mainstream providers do not serve these markets), morning relief (the 07:00 coffee versus the 40-tab panic), territorial urgency (the second mover in a trade loses the position), ownership and control (no hostage data, no silent bots), and reciprocity and status (give before asking) — and an explicit **forbidden set** $\mathcal{F}$:

$$\mathcal{F} = \{\text{manufactured scarcity}, \ \text{invented social proof}, \ \text{buyer shame}, \ \text{emotion overruling arithmetic}\}.$$

**Definition 9 (Doctrine compliance).** Generated copy is compliant iff it uses at most the five levers, contains no element of $\mathcal{F}$, and every quantitative claim in it is derivable from a value in the platform's own data.

**Proposition 6 (Doctrine versus conversion).** $\mathcal{F}$ removes persuasive instruments that are, in the short run, weakly conversion-increasing; compliance therefore costs measurable conversion and buys non-measurable durability (account survival, merchant trust, regulatory posture).

*Justification.* Manufactured scarcity and invented social proof raise click-through under uncertainty; the durability benefit is not observable within the conversion experiment. The trade is therefore a *values* choice, not an optimisation, and must be made explicitly — which is why it is written as a doctrine rather than tuned as a parameter. $\square$

Proposition 6 is included because it is the point at which this architecture is most vulnerable to internal erosion: a platform optimising copy by A/B test will discover $\mathcal{F}$ and use it. The doctrine's defence is that it is bound to the generator and auditable in the artefact, not held in the operator's taste.

## 5.6 Why these five belong to one theory

The five mechanisms look disparate — money, discovery, budgets, tenancy, copy — but each answers the same question in a different surface: **what must be true of the architecture for a person to trust a system they did not watch?** NCR answers it for money, by making certainty a document rather than a balance. AGD answers it for prospects, by making every claim checkable at its source. RLS answers it for attention, by making the order path structurally immune to the marketing path. SDM answers it for relationships, by making a conflict of interest inexpressible. CPD answers it for language, by removing the tools of deceit from the writer. The unifying claim is that trust is a property of *constraints that are visible in the artefact*, and that this is the only kind of trust that survives an operator who is tired.

---

# 6. What the system does, measured

All figures below are taken from the artefacts named in §3.2, on the dates given (Africa/Johannesburg). Where a quantity is a design ceiling rather than an observation, the table says so.

## 6.1 The verification surface across the release chain

| Release | Commit | Assertions | Deploy | Production version confirmed |
|---|---|---|---|---|
| v1.7.6 | `76c90c4` | — | success | 1.7.6 |
| v1.7.7 | `704fc8b` | — | success | 1.7.7 (first real lead filed) |
| v1.7.8 | `4cf00e5` | — | success | 1.7.8 |
| v1.8.0 | `417a563` | 402 | (batched) | — |
| v1.9.0 | `2b19dca` | 406 → 408 | success | 1.9.0 → 1.9.1 |
| v1.9.1 | `c0e4dd7`, `050c30b` | 416 → 419 | success | 1.9.1 |

The assertion count more than doubled across the measurement window while the feature surface grew by four sources, one page and one external integration. The growth is not a virtue in itself; what matters for §5 is *which* claims are pinned — the no-custody invariants, the statement's arithmetic, the gate's refusals, the reserve ordering, the reserve-ladder arithmetic, and the sheet's idempotency each have an assertion that fails if the claim becomes false.

## 6.2 Discovery throughput, before and after the source expansion

The pre-gate epoch is measured by its own output: 47 filed records, 0 actionable, over the build's early weeks. The v1.7.7 epoch, with one directory and one market, produced a single real lead in a pass — *Cainway Holdings (Pvt) Ltd*, an agency in Zimbabwe, with a published number and a page that talked about orders without offering a way to order.

A real v1.9.0 pass, executed against live third-party services rather than fixtures, over Kenya and Nigeria with `perRun = 6`:

| Source | Segment | Market | Results |
|---|---|---|---|
| directory (phrase search) | agencies | KE | 6 company pages |
| directory (phrase search) | agencies | NG | 6 |
| map (Overpass) | agencies | KE / NG | 0 / 0 (empty, reported as quiet) |
| search (Bing RSS) | agencies | KE / NG | 1 / 1 |
| directory (phrase search) | accountants | KE / NG | 6 / 6 |
| map | accountants | KE / NG | 3 / 0 |
| directory (phrase search) | till resellers | KE / NG | 6 / 6 |
| map | till resellers | KE / NG | 0 / 8 |
| directory (phrase search) | associations | KE / NG | 6 / 6 |
| map | associations | KE / NG | 0 / 4 |

Attempts 18, candidates 8 (the pass ceiling bound the output before the sources were exhausted), errors 5 (all Overpass mirror failures, correctly classified as fatal rather than quiet). Sample filed records included *Hope Brand* (`254726239033`), *ADIL TRANSPORTERS LIMITED* (`254783687700`), *WOW Travels and Tours* (`2348022226930`) and *Olumedia E-Commerce Company* (`2347301771710`) — each with a URL on the directory that published it.

Two observations matter for the theory. First, **the directory sources dominate**: 48 company pages from four phrase queries versus 15 map records from eight bbox queries. Directory entries are businesses that *chose to be listed*; a bbox finds businesses that happened to be mapped. Second, the pass's binding constraint was the candidate ceiling, not the source supply — the argument of Proposition 4 in practice.

## 6.3 Budget behaviour

| Quantity | Value | Nature |
|---|---|---|
| Attempt budget per pass | $A \le 3n$, $n$ = planned jobs | design ceiling |
| Candidate ceiling per pass | $\Lambda \le 24$ | design ceiling |
| Daily new-lead ceiling | $W = 20$ | design ceiling |
| Reserve ladder | $r = (0, 25, 75, 200, 300)$ | design |
| Observed attempts, live pass | 18 | observation |
| Observed candidates, live pass | 8 | observation |
| Observed errors, live pass | 5 (all map transport) | observation |
| Duplicates suppressed within a pass | deduped on name + host | design |

## 6.4 The statement's arithmetic

The statement page and the settlement API are asserted equal for the same day inside the live suite; both are re-derived from the event log. Six figures, one per-rail table, one sentence. A quiet day is asserted to render the "nothing on this day" copy rather than zeros. Anonymous access is asserted to redirect (302) with the shop named; a dead session is asserted to render 403 with an explanation that nothing about the money changed; an unknown shop is asserted to 404; every response is asserted to carry `no-store` and to contain no `<script>` element. These are not cosmetic tests: each corresponds to a way a reconciliation document could leak or mislead.

## 6.5 What was refused

A system's honesty is better measured by its refusals than its output, so the refusals are tabulated:

| Refusal | Count in window | Consequence |
|---|---|---|
| Candidates rejected by the gate | reported per pass (e.g. `unverified: 3`, `no_local_signal: 1`) | not filed |
| Leads with no source, excluded from the CRM import | 47 (then deleted at source) | not imported, counted |
| Non-prospects rejected post-gate (charities, orphanages) | ≥ 1 caught in live pass | gate extended (§7.3) |
| Sheet stage pushes refused by ownership rules | surfaced with HTTP 409 in a ledger | not retried |
| Statement requests without a live session | 302 / 403, never 200 | no data served |

## 6.6 Cost

Zero marginal cost within free-tier quotas; the fixed cost is the domain and the author's time. The shadow price of the architecture is quota, and the quota regime is §5.3. This is reported as a limitation as much as a result: the case demonstrates feasibility at zero price, not superiority to a funded alternative.

---

# 7. Failure forensics: a governance failure taxonomy

The empirical heart of the paper is not the throughput table but the incident record. Five classes were observed in production. Each is stated with a signature predicate, the verbatim evidence that established it, the detector that would have caught it sooner, and the design response that now prevents it. The taxonomy is offered as reusable vocabulary; the claim is not that these are the only classes, but that they are **classes**, i.e. that each has a signature which distinguishes it from operator error.

## 7.1 G1 — Provenance collapse

**Signature.** Records exist with no provenance field; $\kappa_{\text{hook}} = 0$ over the affected set; the queue's cardinality grows while its actionable subset does not.

**Evidence.** The pre-gate corpus, read record by record from production storage before deletion. Verbatim business names, abbreviated:

```
Ecocash Charges Calculator 2026 - USD | Econet
WhatsApp Web
Order - definition of order by The Free Dictionary
Chewy Partner Hub | Start Selling On Chewy.com
Track your Order | AT&T
Zimbabwe | History, Map, Flag, Population, Capital, Pronunciation
```

47 such records; one genuine (`Cainway Holdings`, `discovery:directory`). None of the 47 carried a `source` field, so none could be checked at its origin — which is the definition of provenance collapse: *the record outlives the ability to verify it*.

**Detector.** A provenance query: for every record, is there a URL at which the claim is checkable? $\kappa_{\text{hook}} < 1$ is an alarm, not a statistic.

**Response.** The gate (Definition 6) makes `verified` a conjunct, so a candidate whose page was not read cannot be filed. The CRM import refuses any record without a source and *counts* it (§6.5) rather than silently importing or silently dropping. The 47 records were removed from production after being read one by one — the audit precedes the deletion, because "clean up the junk" is precisely the operation that destroys evidence of how the junk arose.

## 7.2 G2 — Budget cannibalisation

**Signature.** Attempts consumed $\gg$ results returned, with the deficit concentrated in one source; passes producing zero candidates while sources with supply go unasked.

**Evidence.** In the first release of the multi-source planner, a strict sort by source priority allowed a single failing source to consume the day's allowance. The regression was caught by the suite on the first run of the change:

```
four jobs ran before the limit filled it:
directory,osm,bing,directory,osm,bing     (6 !== 4)
```

and, in production form, a pass whose only recorded errors were `directory_index_404` — a directory that had moved — produced `"candidates":0, "added":0` for the day while the map and the search leg were never asked.

**Detector.** Per-source utilisation (attempts ÷ results) with an alarm when a source's utilisation exceeds a threshold for consecutive passes; and the pass-level invariant that a *fatal* error refunds its attempt.

**Response.** Three changes, each independently testable: (i) sources are **interleaved by round-robin over (source, market)** rather than stacked by priority, so every working source is asked in every pass; (ii) a job that fails *refunds* its attempt and the pass reaches into a reserve, bounded by $A \le 3n$ with a three-consecutive-failure circuit breaker (Definition 8); (iii) the pass distinguishes **quiet** (a source answered with nothing, which is information) from **error** (a source refused, which is a fault), so the error count means what it says.

## 7.3 G3 — Representation drift

**Signature.** A value in the record is *internally plausible and externally wrong*: it parses, it validates, and a human using it fails.

**Evidence.** A Nigerian company page published its number as `+234 (0)730 177 1710`; the trunk zero in brackets is not part of the number. The normaliser prefixed the country code to a string that already carried it, producing `23407301771710`. This is a fourteen-digit string that passes every obvious plausibility check for the market and cannot be dialled.

```
before:  23407301771710    (14 digits, undialable)
after:   2347301771710     (13 digits, dialable)
```

Two related instances in the same window: a Kenyan local-format number (`0726239033`) filed without its country code, which a seller outside Kenya could not ring; and a children's home, `House of Mercy Children's Lagos, Nigeria (HOM)`, admitted as a prospect because the institution predicate covered `orphanage` in one spelling and the page used another.

**Detector.** Round-trip validation: every stored number must re-normalise to itself, and every number must satisfy the market's digit length *after* normalisation rather than before. For names, an adversarial corpus test: institutions, charities, trusts and churches are added to the gate's fixtures rather than to its exceptions.

**Response.** `dialablePhone()` handles the bracketed-trunk form, the leading-zero form and the already-prefixed form, and refuses anything whose post-normalisation length is wrong for the market; the taxonomy of refusals is asserted in tests, including the exact strings observed in production. The institution predicate was extended to charities, NGOs, orphanages, foundations, churches, missions, dioceses, parishes, trust funds and children's homes — with a regression test built from the live record that slipped through, so the same page cannot be admitted twice.

## 7.4 G4 — Surface collision

**Signature.** Two agents or two human-facing artefacts claim the same surface; effects are non-deterministic, order-dependent, or silently replaced.

**Evidence.** Three instances in one integration. (i) The Master Sheet CRM is an Apps Script project that already contained an `onOpen` function; the Tapstall file also defined `onOpen`. In Apps Script, two functions of the same name in one project do not merge — one silently replaces the other, and the loser is whichever the editor loads last. The failure mode is a **menu that disappears**, with no error anywhere. (ii) Two files both rebuilt the "tomorrow" queue tab: the incumbent script cleared and rewrote it from all rows of the CRM; the new file did the same. Two writers clearing and rewriting one view produce flicker and, under concurrency, loss. (iii) The incumbent script's queue rebuild writes twelve columns in a different order from its own header, so a column labelled *Next Action* contains the previous discussion text and the column labelled *Phone* contains the next action — a representation drift **in the other party's code**, discovered by reading it rather than by trusting it.

**Detector.** A surface register: for every shared artefact (menu, trigger name, sheet tab, scheduled job), exactly one owning module is recorded, and an integration test asserts that a second claimant does not install. For row-level ownership, a namespace prefix on identifiers (`tapstall-<id>`) so that each writer can prove which rows are its own before editing.

**Response.** The Tapstall file defines no `onOpen` and registers `tpsOnOpen` as a spreadsheet on-open trigger instead; it refuses to write the queue tab unless explicitly told it owns it (`TPS_OWN_QUEUE`); it writes only rows whose ID carries its namespace; and it finds columns **by header text** rather than by position, because the other engine adds columns. The general lesson is a design rule: *in any integration with code you do not own, claim surfaces explicitly and prove row ownership structurally.*

## 7.5 G5 — Custody leakage (and its documentation analogue)

**Signature.** A component that must not hold value acquires the ability to move it; or, in the documentary form, a boundary that must not carry a secret carries a fragment of one.

**Evidence.** On the architecture side, the invariant is positive: the platform's code contains no debit, credit, convert or disburse operation, and the test suite asserts the absence of a balance-like concept. On the documentary side, a retrospective migration note had quoted eight-character tails of API tokens as evidence in a post-mortem — a practice that is conventional in incident reports and wrong in a public repository, because the tail plus the prefix narrows the search space and the note's entire purpose is to be read. A single commit exists in the chain whose only content is the redaction of those fragments.

**Detector.** For custody: an architectural test asserting the absence of money-moving capabilities (see Proposition 1's operational form). For documentation: a pattern scan over the repository tree for credential-shaped strings, run as part of the pre-push discipline, with the audit trail permitted to name a credential *class* but never a value or a fragment.

**Response.** Custody is refused by construction and asserted by test. Documentation is scanned, and the redaction is committed as its own change so the record shows what was removed without reproducing it.

## 7.6 What the taxonomy is for

The five classes share a property that distinguishes them from ordinary bugs: **each is a failure of a boundary rather than of a function.** Provenance collapse is a boundary between claim and source; budget cannibalisation is a boundary between one subsystem's appetite and another's guarantee; representation drift is a boundary between a record and the world; surface collision is a boundary between two authors; custody leakage is a boundary between the platform and the merchant's money. Ordinary testing finds function failures. Boundary failures are found by *naming the boundary and asserting something about it* — which is why the taxonomy is more useful than a defect count, and why the design responses in §7.1–7.5 are all phrased as constraints rather than as fixes.

---

# 8. Discussion

## 8.1 The custody arbitrage

There is a structural arbitrage available to anyone building for merchants in weak-recourse economies: the incumbents' business models require custody, because custody is how a platform observes volume and therefore how it can charge for volume. A builder willing to forgo percentage pricing can forgo custody, and in doing so can serve a merchant whom the incumbent cannot serve *safely*. This is not charity and not a niche: it is the observation that the merchant's willingness to pay for a **record** is high, while her willingness to trust a **balance** to a stranger is low, and that most platforms sell the second when the first is what was asked for.

Proposition 3 makes the arbitrage precise and also makes it fragile: any drift toward volume-linked revenue recreates the incentive to take custody. The design defence is architectural (no code path can move money) and commercial (the price list contains no percentage).

## 8.2 Reconciliation as the product, and the statement as an object

The paper's central reframing is that the merchant is not buying a storefront. Storefronts are abundant and free. She is buying the ability to answer a question at month-end without reconstructing her own month. In the language of science and technology studies, the statement functions as a **boundary object** (Star and Griesemer, 1989): a document sufficiently concrete for the shopkeeper ("chase these four"), sufficiently structured for the accountant ("these match, these do not"), and sufficiently invariant across both that it can travel between them without renegotiation. The design requirement that falls out of this framing is unusual — the statement must be *readable by a person who does not trust the platform*, which is why it is server-rendered, script-free, printable, and reproducible from the log.

## 8.3 Attention as the real quota

The reserve ladder (§5.3) is written about KV writes, but its logic generalises to the scarcer resource: **human attention**. The daily write ceiling ($W = 20$ new leads) is not a storage constraint; it is the number of new names a two-person sales function can actually work. Similarly, the candidate ceiling per pass is a statement about what a person can read on a given morning. The paper's suggestion to designers is that quotas should be chosen to protect the *downstream human*, not only the upstream service — a provisioning principle that most free-tier engineering ignores because the provider's meter measures only its own side.

## 8.4 What this buys an agency, and what it costs

For an agency or an accountant's practice — the class-C operator — the rail is attractive because it turns a recurring service ("I keep your books") into a product ("your clients get a statement"), without the agency becoming a payment intermediary. `docs/RAIL.md` in the repository exists to answer the single question such an operator will ask: *does reselling this make me a money-services business?* The answer the architecture supports is that it does not, because no party in the chain holds funds: the buyer pays the merchant, the merchant's own rail records receipt, and the platform compares. The cost is that the agency cannot earn float or spread — a real revenue stream forgone. The paper does not pretend otherwise.

## 8.5 Design principles that transfer

Five principles are stated as the transferable output of the case, each with the mechanism that enforces it:

1. **Make certainty a document, not a balance** (NCR). If your system must reassure someone about money, build the artefact that can be recomputed by a third party.
2. **Gate on verification, and grow recall with sources** (AGD, Proposition 4). Precision is a predicate; recall is a portfolio.
3. **Reserve capacity for the highest-consequence write** (RLS, Theorem 1). Then prove the reservation as arithmetic.
4. **Claim every shared surface explicitly, and namespace your rows** (SDM; §7.4). In integration, ambiguity is not neutral; it is whoever writes last.
5. **Remove the seductive instruments from the generator, not from the reviewer** (CPD, Proposition 6). A tired operator is the threat model.

---

# 9. Limitations and threats to validity

**Construct validity.** The mechanisms are operationalised in code, which is a strength (they are falsifiable) and a limitation (the operationalisation is the author's). Provenance coverage $\kappa_{\text{hook}}$ is measured by inspection rather than by an automated verifier; a hostile reading could argue that the hooks are checkable *in the author's judgement*. The mitigation is that the URLs are recorded and the assertion is one click deep for any reader.

**Internal validity.** The case has no control condition. Before/after comparisons (47:0 versus the gated corpus) confound the gate with the source set, the query phrasing, the market and the season. §5.2's Proposition 4 is an argument about what *can* be attributed to a conjunction of rejections, not a measured effect size. The incident analyses are stronger than the throughput analyses because each incident has a signature and a fix that can be re-tested.

**External validity.** One platform, one operator, four markets, no paying merchants in the window. There is no statistical generalisation on offer. What is offered is analytic transfer: the mechanisms are stated abstractly enough to be adopted elsewhere, and the failure taxonomy is stated as signature predicates rather than as anecdotes, so another operator can test whether their system exhibits them.

**Reliability.** Evidence is drawn from production artefacts that a reader cannot fully access (private repositories, live stores). The appendices quote verbatim traces and commit identifiers to make the chain checkable, but a reader cannot re-run the case. This is the standard cost of a revelatory single case, and it is why the paper's claims are architectural rather than causal.

**Researcher bias.** The author built the system and wants it to be good. The disciplines of §3.1 mitigate but do not eliminate this. Two specific risks deserve naming: the taxonomy may over-attribute failures to interesting architectural causes rather than to ordinary inattention; and the doctrine (§5.5) may be read as a rationalisation of copy that the author would have written anyway. The counter-discipline applied was to keep defects that had no architectural lesson in the record (§7.4(iii), an error in *someone else's* code) rather than curating them out.

**Temporal.** The measurement window is weeks, and the platform's commercial claims are unproven. A follow-up study at twelve months, with paying merchants and a comparison group of merchants using conventional rails, is the obvious next step and is not attempted here.

---

# 10. Conclusion and agenda

This paper asked how a merchant in a low-infrastructure economy can be given the one thing she actually lacks — a trusted record of what she sold and what she is owed — without being made a creditor of the platform that gives it to her. The answer developed here is an architecture rather than a feature: refuse custody and make certainty a document; admit prospects only through a conjunction of verifiable predicates; reserve budget so that the order path is structurally immune to the marketing path; make conflicts of interest inexpressible by construction; and remove the instruments of deceit from the generator rather than policing them at review.

The Tapstall case demonstrates that this is buildable at zero marginal cost, on free tiers, by one person, in four markets — and that the interesting difficulties are not the ones a demo shows. They are boundary failures: a queue that fills with page titles, a dead source that eats a day, a bracketed zero that makes a phone number undialable, two files that both think they own a menu. Those failures are the substance of operating, and they are exactly what a governance-first architecture is for.

**Agenda.** Four studies follow naturally. (1) A twelve-month, multi-merchant evaluation of statement completeness and its effect on dispute incidence and accountant hours — the measurable value of reconciliation. (2) A comparative study of custody-free versus custodial rails on merchant *survival* in weak-recourse jurisdictions, where the hypothesis is that the failure mode of the incumbent is not fees but counterparty risk. (3) A formal treatment of the reserve ladder under adversarial load, extending Theorem 1 to multiple scarce resources with cross-class coupling. (4) An empirical test of Proposition 6: does doctrine compliance measurably reduce conversion, and if so, what is the durable benefit that pays for it? The last is the question this paper is least able to answer and most wants answered, because the answer determines whether honest platforms can compete.

---

# References

Allee, V. (2003). *The Future of Knowledge: Increasing Prosperity through Value Networks.* Butterworth-Heinemann.

Anthropic (2024). *Building Effective Agents.* Engineering guidance, Anthropic.

Baker, T., and Nelson, R. E. (2005). Creating something from nothing: Resource construction through entrepreneurial bricolage. *Administrative Science Quarterly*, 50(3), 329–366.

Beyer, B., Jones, C., Petoff, J., and Murphy, N. R. (2016). *Site Reliability Engineering: How Google Runs Production Systems.* O'Reilly.

Dew, N., Read, S., Sarasvathy, S. D., and Wiltbank, R. (2009). Effectual versus predictive logics in entrepreneurial decision-making: Differences between experts and novices. *Journal of Business Venturing*, 24(4), 287–309.

Directive 2009/110/EC of the European Parliament and of the Council on the taking up, pursuit and prudential supervision of the business of electronic money institutions. *Official Journal of the European Union*, L 267.

European Parliament and Council (2024). Regulation (EU) 2024/1689 laying down harmonised rules on artificial intelligence (Artificial Intelligence Act).

Grigg, I. (2005). Triple entry accounting. Working paper, Systemics Inc.

Guo, T., Chen, X., Wang, Y., et al. (2024). Large language model based multi-agents: A survey of progress and challenges. *IJCAI 2024*.

Hevner, A. R., March, S. T., Park, J., and Ram, S. (2004). Design science in information systems research. *MIS Quarterly*, 28(1), 75–105.

Ijiri, Y. (1975). *Theory of Accounting Measurement.* American Accounting Association, Studies in Accounting Research No. 10.

Jack, W., and Suri, T. (2014). Risk sharing and transactions costs: Evidence from Kenya's mobile money revolution. *American Economic Review*, 104(1), 183–223.

Jimenez, C. E., Yang, J., Wettig, A., Yao, S., Pei, K., Press, O., and Narasimhan, K. (2024). SWE-bench: Can language models resolve real-world GitHub issues? *ICLR 2024*.

Kartik, A., et al. (2025). AgentCompass: Towards reliable evaluation of web agents. arXiv preprint.

Lebovitz, S., Lifshitz-Assaf, H., and Levina, N. (2022). To engage or not to engage with AI for critical judgments: How professionals deal with opacity when using AI for medical diagnosis. *Organization Science*, 33(1), 126–148.

Lim, A. (2017). GitOps: A path to more self-service IT. *ACM Queue*, 15(5).

Oliner, A., and Stearley, J. (2007). What supercomputers say: A study of five system logs. *Proceedings of the 37th Annual IEEE/IFIP International Conference on Dependable Systems and Networks (DSN)*, 575–584.

OpenTelemetry (2024–). Semantic conventions for generative AI systems. OpenTelemetry project documentation.

Parker, G. G., and Van Alstyne, M. W. (2005). Two-sided network effects: A theory of information product design. *Management Science*, 51(10), 1494–1504.

Read, S., Dew, N., Sarasvathy, S. D., Song, M., and Wiltbank, R. (2009). Marketing under uncertainty: The logic of an effectual approach. *Journal of Marketing*, 73(3), 1–18.

Rochet, J.-C., and Tirole, J. (2003). Platform competition in two-sided markets. *Journal of the European Economic Association*, 1(4), 990–1029.

Rochet, J.-C., and Tirole, J. (2011). Must-take cards: Merchant discounts and avoided costs. *Journal of the European Economic Association*, 9(3), 462–495.

Sarasvathy, S. D. (2001). Causation and effectuation: Toward a theoretical shift from economic inevitability to entrepreneurial contingency. *Academy of Management Review*, 26(2), 243–263.

Sarasvathy, S. D. (2008). *Effectuation: Elements of Entrepreneurial Expertise.* Edward Elgar.

Schön, D. A. (1983). *The Reflective Practitioner: How Professionals Think in Action.* Basic Books.

South Africa (2013). Protection of Personal Information Act 4 of 2013.

Star, S. L., and Griesemer, J. R. (1989). Institutional ecology, "translations" and boundary objects: Amateurs and professionals in Berkeley's Museum of Vertebrate Zoology, 1907–39. *Social Studies of Science*, 19(3), 387–420.

Suri, T., and Jack, W. (2016). The long-run poverty and gender impacts of mobile money. *Science*, 354(6317), 1288–1292.

Wang, L., Ma, C., Feng, X., et al. (2024). A survey on large language model based autonomous agents. *Frontiers of Computer Science*, 18(6).

Wu, Q., Bansal, G., Zhang, J., et al. (2023). AutoGen: Enabling next-gen LLM applications via multi-agent conversation. arXiv preprint.

Xi, Z., Chen, W., Guo, X., et al. (2023). The rise and potential of large language model based agents: A survey. arXiv preprint.

Yehudai, A., et al. (2025). Survey on evaluation of LLM-based agents. arXiv preprint.

Yin, R. K. (2018). *Case Study Research and Applications: Design and Methods* (6th ed.). Sage.

Zimbabwe (2021). Cyber and Data Protection Act [Chapter 12:07].

---

# Appendix A — Evidence inventory

Release chain, commits and confirmed production versions are tabulated in §6.1. Repository artefacts referenced in this paper, by path:

| Path | Content |
|---|---|
| `worker/worker.js` | request handler, routes, scheduled passes, statement page |
| `worker/core.js` | pricing, quota policy and reserve ladder, feed normalisation, lead state machine |
| `worker/discover.js` | sources, admission gate, phone normalisation, planner |
| `worker/rail.js` | settlement arithmetic, vetting rails, records policy |
| `docs/RAIL.md` | the no-custody rule, the do/never-do table, the three unblurred sentences |
| `docs/DISCOVERY-SOURCES.md` | source inventory, costs, and the refusals (no login-gated scraping) |
| `docs/CRM-SHEET.md` | the sheet integration, its credential scoping and its coexistence rules |
| `docs/EMOTION.md` | the five levers and the honesty clause (CPD) |
| `papers/…` | this paper |

# Appendix B — Verbatim traces (abridged; long strings elided with …)

**B.1 Pre-gate corpus (47 records, names as stored).** Extracts in §7.1.

**B.2 Budget cannibalisation.** Pass summary with a moved directory:
`{"ok":true,"ran":2,"candidates":0,"added":0,"errors":[{"job":"dir|agencies|ZW","error":"directory_index_404"},{"job":"dir|accountants|ZW","error":"directory_index_404"}], …}`

**B.3 Planner regression captured by the suite.**
`four jobs ran before the limit filled it: directory,osm,bing,directory,osm,bing — 6 !== 4`

**B.4 Representation drift, before and after.** §7.3.

**B.5 Live pass (v1.9.0), Kenya and Nigeria.** Table in §6.2; sample records with dialable numbers and their source URLs.

**B.6 Statement access responses.** Anonymous → `302` with the shop named in the redirect; dead session → `403` with the explanation that nothing about the money changed; unknown shop → `404`; all with `cache-control: no-store` and no `<script>` element.

# Appendix C — Reproducibility notes

The platform builds from source into a single bundle that is both the test artefact and the deployed artefact, so the suite runs against the shipped bytes. A pass may be executed against live third-party services or against fixtures; the paper reports which. The reserve ladder, the admission gate and the phone normaliser are pure functions with their own unit tests, so their claims can be verified without a network. The statement's arithmetic is exposed twice — as rendered HTML and as JSON/CSV — and both are asserted against one implementation, so a reader with a merchant session can compare page and file. Where a figure in this paper is a design ceiling rather than an observation, §6 marks it as such.

# Appendix D — Statement specification (normative)

For a day $D$ and merchant $m$, the statement MUST report: expected, matched, to chase, refunded, fees, net; a per-rail breakdown of orders and outstanding amounts; and a single next-action sentence. It MUST be computed as a function of the event log for $D$ alone (Proposition 1). It MUST NOT contain script, MUST carry `no-store`, and MUST be reachable only by a live session of $m$. It MUST render an explicit quiet-day message in words rather than a table of zeros. It MUST NOT describe a matched order as paid, an expected order as owed, or the platform's fee as a share of volume. Any implementation that violates these clauses is non-conforming regardless of its correctness on ordinary input.
