import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const doc = read('CONTENT-MESH.md');
const worker = read('worker/worker.js');
const core = read('worker/core.js');

/* A design document is worth as much as the day it was true. This file's whole claim is that the mesh
   already exists in mechanisms rather than intentions, so the claim is checked against the code that
   would have to be missing for it to be a boast — the same way the pages suite refuses to let a promise
   about HTML drift from the HTML. */
test('the mesh design names only mechanisms that exist', () => {
  for (const fn of ['meshWitness', 'meshPack', 'meshJson', 'meshMark', 'realPhoto']) {
    assert.match(core, new RegExp('export (function|const) ' + fn), fn + ' must be in the shared core');
    assert.match(doc, new RegExp(fn), 'the document must name ' + fn + ' if it says the control is enforced');
  }
  assert.match(worker, /if \(p === '\/api\/mesh'\)/, 'the shop-facing view route exists');
  assert.match(worker, /if \(p === '\/api\/mesh\/seen' && req\.method === 'POST'\)/, 'and its one write path is an explicit POST');
  assert.match(worker, /card_url: \(url\.origin \|\| ''\) \+ '\/s\/' \+ handle \+ '\/mesh\.json'/,
    'the card the mesh is built from is served per shop, from the origin in the request, not a hard-coded host');
});

/* The budget is the anti-spam guarantee, so it must be one number in two places. */
test('the budget in the document is the budget in the code', () => {
  const m = core.match(/export const MESH_BUDGET = \{([^}]+)\}/);
  assert.ok(m, 'MESH_BUDGET is declared once, in core');
  // the keys are names and only the values are numbers; coercing both (the first draft) turned every
  // pair into NaN:<value>, which made the two objects equal no matter what the document said. A check
  // that cannot fail is worse than no check, because it is read as one.
  const nums = (txt) => Object.fromEntries(txt.split(',').map((p) => {
    const i = p.indexOf(':');
    return [p.slice(0, i).trim(), Number(p.slice(i + 1))];
  }));
  const code = nums(m[1]);
  assert.deepEqual(Object.keys(code).sort(), ['item_cooldown_days', 'per_day', 'promo', 'value'],
    'the budget has exactly four numbers, each named');
  assert.ok(Object.values(code).every((n) => Number.isInteger(n) && n > 0), 'and all of them are positive integers');
  const d = doc.match(/`MESH_BUDGET = \{([^}]+)\}`/);
  assert.ok(d, 'the document quotes the budget literally rather than paraphrasing it');
  assert.deepEqual(nums(d[1]), code, 'a doc that raises or lowers the cap without a code change is how a limit becomes a slogan');
});

/* One state write per shop per day is what makes this affordable on a plan that meters writes, and the
   number is only true while a single place in the code performs it. */
test('the mesh costs the account at most one write a day per shop', () => {
  const writes = worker.match(/await env\.ORDERS\.put\('mesh:' \+ st\.handle/g) || [];
  assert.equal(writes.length, 1, 'exactly one writer of mesh state; a second would double the spend and the drift');
  assert.match(doc, /at most one write\s*\n?\s*per shop per day/, 'and the document says the same thing the code enforces');
  assert.doesNotMatch(worker, /env\.ORDERS\.put\(`?mesh:[^']*daily|put\('mesh:.*seen_counts/,
    'no per-view write: the seen tally stays in memory, which is why a busy day is free');
});

/* Nothing in the graph may publish on its own. The absence of a route is the guarantee, so it is
   asserted as an absence — the cheapest way to keep a design promise from being quietly implemented. */
test('no node can publish without the shop, because there is nothing to publish with', () => {
  assert.match(doc, /That one is \*\*rejected here\*\*/, 'the doc must not claim an approval gate this product does not have');
  assert.match(doc, /replies_only/, 'and it must name the gate it does have');
  // the decision the owner made twice in writing: the loop has to close on its own, so the endpoint
  // exists now. What the guard protects since then is not the absence of a door but who can open it.
  assert.match(worker, /'\/api\/mesh\/publish'/, 'there is one named action to send on, because a mesh that needs a person to fire it is not a mesh');
  for (const alias of ['send', 'post', 'schedule']) {
    assert.equal(new RegExp("'\\/api\\/mesh\\/" + alias + "'").test(worker), false, 'and no ' + alias + ' alias: one door, not four ways to spell it');
  }
  const pubSrc = worker.slice(worker.indexOf('async function meshPublish'), worker.indexOf('async function meshAuto'));
  assert.ok(pubSrc.length > 400, 'the publisher handler is readable, not a stub');
  assert.match(pubSrc, /await identify\(req, env,/, 'a send is always signed in as a shop: nothing can post as someone who did not sign in');
  assert.match(pubSrc, /x-tapstall-confirm/, 'a real send needs the confirm header, so a stray request cannot fire a batch');
  assert.match(pubSrc, /dry/, 'and the dry path exists, which is how this was tested before any token was handed over');
  assert.match(pubSrc, /press:queue:/, 'items land in the queue format the pipeline already reads');
  assert.match(pubSrc, /r\.status === 'sent'/, 'and a post is only counted when the platform answered, by that answer alone');
  assert.match(worker, /meshMark\(prev, Array\.isArray\(b\.marked\) \? b\.marked : \[\], Date\.now\(\)\)/,
    'state changes only by marking what a human looked at');
});

/* Provenance is the other half of the design: the negative constraint, not a style guide. */
test('provenance is a function, not an adjective', () => {
  assert.match(doc, /may only cite what appears there|Provenance or nothing/i,
    'the document states the constraint in its negative form, as the source does');
  assert.match(core, /export function meshWitness\(st, products, facts\)/, 'and a function holds it');
  assert.match(doc, /Deliberately not here[\s\S]*Engagement pods[\s\S]*credential/,
    'the things the mesh refuses are written down where a reader will find them, not implied');
  assert.match(doc, /not wired/, 'a node that does not exist yet is labelled, not described in the present tense');
});

/* The autonomous half. These exist because the ask changed on purpose: a person who is cooking is not
   a copy desk, so the gate moved from every post to one standing grant — which means the *content*
   rules have to be enforced by code that is tested, not by an approval habit that will lapse in month
   three when the shop has forty of these lines a week. */
test('a value beat may not sell anything, and the filter is the reason', async () => {
  const core = await import('file://' + join(root, 'worker', 'core.js'));
  const clean = core.meshIsPitch('Goat curry: fierce, and we mean it plenty');
  assert.equal(clean.pitch, false, 'a plain description passes: ' + clean.why);
  for (const [bad, why] of [['Order now and save', 'offer words'], ['Two for US$6 today', 'money'],
                            ['see https://x/s/mamatoe', 'a link'], ['message us on wa.me/263', 'a channel handle'],
                            ['free delivery this week', 'a promo promise'], ['@mamatoe on instagram', 'a handle']]) {
    const r = core.meshIsPitch(bad);
    assert.equal(r.pitch, true, why + ' must be refused, and was not: ' + bad);
  }
  assert.equal(core.MESH_AUTONOMY_V3.kinds.join(','), 'value,promo',
    'v0.9.3: both kinds run on their own, because a seller approving their own prices twice a day is not being protected, they are being worked');
  assert.equal(core.MESH_AUTONOMY_V3.ratio.value / core.MESH_AUTONOMY_V3.ratio.promo, 2,
    'and the ratio is the stated one: two pieces of value to one of shop facts');
  assert.equal(core.MESH_AUTONOMY_V3.human, 'replies_only', 'the human is on the reply, not on the send');
  assert.equal(core.MESH_AUTONOMY_V3.touch.warm_only, true, 'first touch goes to this shop\'s own history and nowhere else');
  assert.equal(core.MESH_AUTONOMY.revoke_writes, 1, 'and switching it off must be cheaper than a support ticket');
});

test('the value generator draws only on what a row says, and quotes no price', async () => {
  const core = await import('file://' + join(root, 'worker', 'core.js'));
  const st = { handle: 'mamatoe', shop_name: 'Mama Too', hours: 'Mon-Fri 08:00-16:00', whatsapp: '263781234567' };
  const rows = [{ id: 'p1', name: 'Beef & rice', desc: 'Slow-cooked six hours, mahewu on the side', category: 'Mains', price: 6 },
                { id: 'p2', name: 'Goat curry', desc: 'Fierce, and we mean it plenty', category: 'Mains', price: 7 },
                { id: 'p3', name: 'Pumpkin fritters', category: 'Snacks', price: 2, available: false }];
  const out = core.meshValueBeats(st, rows, { hours_text: 'Mon-Fri 08:00-16:00' }, { now: Date.parse('2026-10-13T06:00:00Z') });
  assert.ok(out.beats.length >= 1, 'a shop with real descriptions has something worth saying: ' + JSON.stringify(out));
  const all = JSON.stringify(out.beats);
  assert.doesNotMatch(all, /US\$|\$[0-9]|http|wa\.me|Order now/i, 'no price, no link, no pitch in anything emitted');
  assert.ok(out.beats.every((b) => b.kind !== 'promo'), 'and nothing here is a promotion');
  const sold = out.beats.find((b) => b.kind === 'status');
  if (sold) assert.match(sold.text, /Pumpkin fritters/, 'a sold-out line names the item that is actually gone');
  const lied = core.meshValueBeats(st, [{ id: 'x', name: 'Truffle risotto', desc: 'Order now, 20% off, US$40', category: 'Mains' }], {}, {});
  assert.equal(lied.beats.length, 0, 'a merchant who writes an advertisement into a description gets a dropped beat, not a softened one');
  assert.match(JSON.stringify(lied.blocked), /pitch word/, 'and the drop says why');
});

test('the growth queue is conversations, read from the ledger, and says so', async () => {
  const core = await import('file://' + join(root, 'worker', 'core.js'));
  const now = Date.parse('2026-10-13T09:00:00Z');
  const rows = [
    { id: 'a', at: new Date(now - 864e5).toISOString(), status: 'pending', phone: '0781234567', total: 12, items: [{ name: 'Beef & rice' }] },
    { id: 'b', at: new Date(now - 2 * 864e5).toISOString(), status: 'pending', phone: '0779998888', total: 7, items: [] },
    { id: 'c', at: new Date(now - 40 * 864e5).toISOString(), status: 'pending', phone: '0780000000', total: 9, items: [] },
    { id: 'd', at: new Date(now - 3 * 864e5).toISOString(), status: 'paid', phone: '0781234567', total: 5, items: [] },
    { id: 'e', at: new Date(now - 60 * 864e5).toISOString(), status: 'paid', phone: '0781234567', total: 5, items: [] },
  ];
  const g = core.meshGrowth({ handle: 'mamatoe' }, rows, { now });
  assert.equal(g.read, 5, 'it counted what it was given, including the row too old to chase');
  assert.equal(g.unpaid.length, 2, 'two unpaid inside three days, and the paid ones are not in it');
  assert.match(g.unpaid[0].line, /Beef & rice/, 'the line names the order, so a reply is possible');
  assert.ok(!/http|%\s*off|discount/i.test(JSON.stringify(g.unpaid)), 'a follow-up about money owed is not an advertisement');
  assert.equal(g.regulars.length, 1, 'one person crossed three orders');
  assert.equal(g.regulars[0].orders, 3, 'and the count is the real count, not a flattering one');
  assert.match(g.note, /Nothing in this list is automated/, 'and the queue tells the truth about who sends it');
});

/* v0.9.3 — what the autonomy actually promises, asserted where it is decided. */
test('the plan posts itself where a channel can be posted to, and never pretends elsewhere', async () => {
  const core = await import('file://' + join(root, 'worker', 'core.js'));
  const st = { handle: 'mamatoe', shop_name: 'Mama Too', currency: 'USD', mesh_class: 'seller', mesh_channels: { bluesky: { on: true }, x: { on: true }, whatsapp: { on: true } } };
  const rows = [{ id: 'm1', name: 'Nyama', desc: 'Slow-cooked overnight, so the meat gives up', category: 'Mains', price: 6 },
                { id: 'm2', name: 'Maheu', category: 'Drinks', price: 2, available: false },
                { id: 'm3', name: 'Matoke', category: 'Mains', price: 5, available: false }];
  const plan = core.meshSchedule(st, rows, { hours_text: 'Mon-Fri 08:00-16:00', feed_ok: true },
    { now: Date.parse('2026-10-13T04:00:00Z'), origin: 'https://tapstall.zlnew.workers.dev', state: { auto: { on: true } } });
  assert.equal(plan.on, true, 'granted, so the plan is live');
  assert.ok(plan.beats.length >= 2, 'there is something to say: ' + JSON.stringify(plan.beats).slice(0, 160));
  assert.ok(plan.beats.some((b) => b.kind === 'promo'), 'including the shop-facts one, with money in it');
  const promo = plan.beats.find((b) => b.kind === 'promo');
  assert.match(promo.text, /6\.00 USD|5\.00 USD|2\.00 USD/, 'a promo beat states a real price from the row');
  assert.match(promo.text, /tapstall\.zlnew\.workers\.dev\/s\/mamatoe/, 'and the link, because this is the half that is allowed to have one');
  assert.ok(plan.beats.every((b) => b.slot), 'each beat is on the clock, not fired at random');
  assert.equal(new Set(plan.beats.map((b) => b.slot)).size, plan.beats.length, 'and no two share a window on the same day');
  assert.ok(plan.beats.every((b) => b.auto_send === true), 'an authorised API channel means it sends itself');
  const assist = core.meshSchedule({ handle: 'x', mesh_class: 'seller', mesh_channels: { whatsapp: { on: true } } }, rows, {}, { state: { auto: { on: true } }, now: Date.now() });
  assert.ok(assist.beats.every((b) => b.auto_send === false), 'a channel with no API is never claimed to have been posted to');
  assert.match(assist.beats[0].to.join(','), /whatsapp/, 'it is queued for the person instead, which is honest and still costs them a tap');
  const trial = core.meshSchedule({ handle: 't', plan: 'trial', mesh_channels: { x: { on: true } } }, rows, {}, { state: {}, now: Date.now() });
  assert.equal(trial.on, false, 'a trial account with nothing delegated has nothing to post with, so it stays off');
  const switched = core.meshSchedule(st, rows, {}, { state: { auto: { on: false } }, now: Date.now() });
  assert.equal(switched.on, false, 'and one save off stops an account that was running by default');
  const sold = JSON.stringify(plan.beats);
  assert.ok(!(/is back on the menu[\s\S]*listed sold out/.test(sold) && /is back on the menu[\s\S]*is 2\.00 USD and listed sold out/.test(sold)),
    'one row cannot be sold out and back in the same day\'s plan');
});

test('first touch reaches warm contacts, caps itself, and hands the reply to a human', async () => {
  const core = await import('file://' + join(root, 'worker', 'core.js'));
  const now = Date.parse('2026-10-13T09:00:00Z'), day = 864e5;
  const rows = [{ id: 'u1', at: new Date(now - day).toISOString(), status: 'pending', phone: '0781110000', items: [{ name: 'Nyama' }] },
                { id: 'u2', at: new Date(now - 9 * day).toISOString(), status: 'pending', phone: '0782220000', items: [] },
                { id: 'u3', at: new Date(now - 30 * day).toISOString(), status: 'paid', phone: '0783330000', items: [] },
                { id: 'u4', at: new Date(now - 20 * day).toISOString(), status: 'paid', phone: '0783330000', items: [] },
                { id: 'u5', at: new Date(now - 10 * day).toISOString(), status: 'paid', phone: '0783330000', items: [] }];
  const t = core.meshFirstTouch({ handle: 'mamatoe' }, rows, { now });
  assert.equal(t.queue.length, 2, 'one abandoned order inside three days, one customer worth thanking: ' + JSON.stringify(t.queue.map((x) => x.kind)));
  assert.ok(t.queue.every((x) => x.human_after === true), 'every one of them marked as needing a person on the reply');
  assert.ok(t.queue.every((x) => /078/.test(x.to)), 'to numbers on this shop\'s own ledger, and to nobody else');
  assert.equal(t.refused, 1, 'and the count of rows it would not touch is said out loud');
  assert.match(t.touch.kinds.join(','), /dm_whatsapp|email|comment_reply/, 'the channels it may use');
  assert.match(t.note, /a template in a conversation is how a customer leaves/, 'the reason is in the payload, not only in the doc');
});

/* v0.9.5 — three classes of account, and no tap anywhere in the loop. */
test('a shop on the platform is an operator, and an operator\'s socials are not ours to hold', async () => {
  const core = await import('file://' + join(root, 'worker', 'core.js'));
  const rows = [{ id: 'm1', name: 'Nyama', desc: 'Slow-cooked overnight, so the meat gives up', category: 'Mains', price: 6 }];
  const f = { feed_ok: true, price_ok: true, hours_text: 'Mon-Fri 08:00-16:00' };
  const op = { handle: 'mamatoe', shop_name: 'Mama Too', currency: 'USD', mesh_channels: { x: { on: true }, bluesky: { on: true } } };
  const a = core.meshAccount(op);
  assert.equal(a.class, 'operator', 'the default for a shop that merely sells with us: not staff, not the owner');
  assert.equal(a.socials, false, 'and we hold nothing on their accounts, in any class of action');
  assert.match(a.credentials, /none, and none are asked for/, 'that is stated in the payload, not implied');
  const plan = core.meshSchedule(op, rows, f, { now: Date.parse('2026-10-14T04:00:00Z'), state: {} });
  assert.equal(plan.on, false, 'so nothing is autonomous on their accounts, and no grant is offered for them');
  const why = core.meshAutoPlan(op, rows, f, { now: Date.parse('2026-10-14T04:00:00Z'), state: {} });
  assert.match(why.why, /no standing grant for this shop/, 'the public feed still answers in plain words');
  const seller = core.meshAccount({ mesh_class: 'seller' });
  assert.equal(seller.socials, true, 'a seller is different: real credentials, handed over on purpose');
  assert.equal(seller.auto_default, true, 'and it runs from the day it is configured, with no one approving it');
  const owner = core.meshAccount({ owner: true });
  assert.equal(owner.class, 'owner', 'the company\'s own accounts');
  assert.equal(core.meshAccount({ plan: 'trial' }).class, 'trial', 'a trial is its own thing and posts nowhere');
  for (const cls of ['operator', 'trial']) {
    const p2 = core.meshSchedule({ handle: 'h', mesh_class: cls, mesh_channels: { x: { on: true } } }, rows, f, { now: Date.parse('2026-10-14T04:00:00Z'), state: {} });
    assert.ok((p2.beats || []).every((b) => !b.to || b.to.every((c) => core.MESH_OWN_NODES.includes(c))),
      cls + ' beats never name a social rail as a destination: ' + JSON.stringify((p2.beats || []).map((b) => b.to)));
  }
});

test('the batch sends itself: a tap on every batch is the clog that would end the loop', async () => {
  const core = await import('file://' + join(root, 'worker', 'core.js'));
  const o = core.MESH_OUTREACH;
  assert.equal(o.send, 'auto', 'composed by the machine, sent by the window');
  assert.equal(o.approvals, 'none', 'no approval of any size sits in this path');
  assert.match(o.human_for.join(','), /reply/, 'the human is on the reply');
  assert.match(o.human_for.join(','), /price|complaint/, 'and on the parts of a conversation with money or anger in it');
  const now = Date.parse('2026-10-14T04:00:00Z');   // a Wednesday
  const plan = core.meshOutreachPlan({ mesh_class: 'seller', mesh_channels: { x: { on: true } } }, { leads: [{ phone: '0781' }, { email: 'a@b.c' }], now });
  assert.equal(plan.composed, 2, 'both messages are written');
  assert.ok(plan.batch.every((b) => b.sends === true), 'and each one is marked as going, because a credential exists');
  assert.equal(plan.batch[0].approved_by, null, 'nobody approved it, and that is the point');
  assert.match(plan.batch[0].waits_for, /nothing/, 'the wait field says what it waits for, in words');
  const capped = core.meshOutreachPlan({ mesh_class: 'seller' }, { leads: Array.from({ length: 200 }, (_, i) => ({ phone: '078' + i })), now, state: { outreach: { sent: 0, total: 0 } } });
  assert.equal(capped.composed, 20, 'day one of the ramp is twenty, whatever the list size: the cap is arithmetic');
  const weekend = core.meshOutreachPlan({ mesh_class: 'seller' }, { leads: [{ phone: '0781' }], now: Date.parse('2026-10-18T04:00:00Z') });
  assert.equal(weekend.on, false, 'and the pipeline rests on a Sunday, as the bible says');
  assert.match(weekend.skip_reason, /weekend/, 'saying why, in the payload');
  const op = core.meshOutreachPlan({ handle: 'mamatoe' }, { leads: [{ phone: '0781' }], now });
  assert.equal(op.batch[0].sends, false, 'an operator gets no batch: we do not message from an account we do not hold');
  assert.match(op.batch[0].waits_for, /credential/, 'and it names the missing thing instead of asking for a tap');
});

/* v0.9.5 — the publisher layer, read out of the hunta docs rather than guessed at. */
test('X is a free Buffer rail, not a paid app: via buffer, on the 40-minute grid', async () => {
  const core = await import('file://' + join(root, 'worker', 'core.js'));
  assert.equal(core.MESH_PUBLISH.x.via, 'buffer', 'X posts through Buffer, which is how the pipeline pays nothing for it');
  assert.equal(core.MESH_PUBLISH.x.grid_min, 40, 'on the same grid the docs name');
  assert.doesNotMatch(JSON.stringify(core.MESH_PUBLISH.x), /paid|app keys|bearer from/, 'and the payload must not claim a paid app anywhere');
  assert.match(core.MESH_PUBLISH.x.needs, /free Buffer org/, 'what it needs is a Buffer token and a channel id');
  assert.equal(core.MESH_PUBLISH.linkedin.via, 'buffer', 'LinkedIn the same way');
  assert.equal(core.MESH_PUBLISH.pinterest.via, 'buffer', 'and Pinterest, board id and all');
  assert.equal(core.MESH_PUBLISH.bluesky.via, 'direct', 'Bluesky stays direct: an app password is simpler than a middleman');
  assert.equal(core.MESH_PUBLISH.nostr.via, 'direct', 'Nostr is a relay post on a key we make');
  assert.equal(core.MESH_PUBLISH.whatsapp.via, 'none', 'and the rails with no API say none, out loud');
  for (const [rail, p] of Object.entries(core.MESH_PUBLISH)) {
    assert.ok(['buffer', 'direct', 'own', 'none'].includes(p.via), rail + ' declares how it is published');
    assert.ok(typeof p.needs === 'string' && p.needs.length > 8, rail + ' states what the credential is');
  }
  assert.equal(core.MESH_BUFFER_FREE.grid_min, 40, 'the free plan is what the caps are built on');
  assert.ok(core.MESH_BUFFER_FREE.posts_per_day_ceiling >= core.MESH_AUTONOMY_V3.per_day, 'three beats a day fits a free org with room to spare: ' + JSON.stringify(core.MESH_BUFFER_FREE));
});

test('a dead rail is dropped from the cadence without asking anyone, and returns when the cadence does', async () => {
  const core = await import('file://' + join(root, 'worker', 'core.js'));
  const state = { rails: { pinterest: { fails: 2, ok: false }, x: { fails: 1, ok: false }, bluesky: { fails: 0, ok: true } },
                  cadence: { x: 3, pinterest: 1, bluesky: 1 } };
  const h = core.meshRailHealth(state);
  assert.deepEqual(h.dropped.map((d) => d.rail), ['pinterest'], 'two failed windows is the limit, the same number the pipeline uses');
  assert.equal(h.healthy.includes('x'), true, 'one failure is not a verdict, it is noise');
  assert.equal(h.cadence_active.some((c) => c.rail === 'pinterest'), false, 'and the dropped rail plans nothing, rather than planning zeros');
  assert.match(h.dropped[0].note, /a person is not consulted/, 'the doctrine is written into the reason');
  assert.equal(core.MESH_RAIL_HEALTH.ask_human, false, 'no question is asked of the owner');
  assert.equal(core.MESH_RAIL_HEALTH.fail_limit, 2, 'the threshold is data');
  assert.match(h.judged_by, /the ledger, never the run annotation/, 'health is read off the ledger, because an annotation that says landed while the ledger says false is the bug they already had');
});

test('outreach drips, caps and parks: the cap never demands a tap', async () => {
  const core = await import('file://' + join(root, 'worker', 'core.js'));
  const now = Date.parse('2026-10-14T06:00:00Z');   // a Wednesday
  const leads = Array.from({ length: 90 }, (_, i) => ({ phone: '078' + (1000 + i) }));
  const d = core.meshOutreachPlan({ mesh_class: 'seller', mesh_channels: { x: { on: true } } }, { leads, now });
  assert.equal(d.batch.length, 20, 'day one of the ramp is twenty, not eighty: ' + d.batch.length);
  const mature = core.meshOutreachPlan({ mesh_class: 'seller', mesh_channels: { x: { on: true } } }, { leads, now, state: { outreach: { sent: 0, total: 500 } } });
  assert.equal(mature.batch.length, 80, 'a mailbox past its ramp fills the batch to batch_max, which is where 80 lives');
  const drip = core.meshDrip(d.batch, { outreach: { sent: 0, total: 0 } });
  assert.equal(drip.release, 6, 'but only six go in this slot');
  assert.equal(drip.parked, 14, 'the rest wait their turn on the grid, they are not thrown away');
  assert.equal(drip.tap_required, false, 'and nobody is asked to release them');
  assert.equal(drip.cap_demands_tap, false, 'the sentence the pipeline had to rewrite in code, written here from the start');
  assert.equal(drip.grid_min, 40, 'on the same grid Buffer uses');
  const atCap = core.meshDrip(d.batch, { outreach: { sent: 30, total: 300 } });
  assert.equal(atCap.release, 0, 'at the cap nothing more goes');
  assert.match(atCap.at_cap, /park the remainder/, 'it parks');
  assert.match(atCap.note, /does not ask anyone for permission/, 'and says so');
  assert.equal(core.MESH_DRIP.batch_cap, 30, 'the cap is the pipeline number, 30 a day, not a feeling');
});

test('the payload carries a limit for every rail a beat can name', async () => {
  const core = await import('file://' + join(root, 'worker', 'core.js'));
  const beats = [{ rail: 'whatsapp_status' }, { rail: 'bluesky' }, { rail: 'nostr' }, { rail: 'a_rail_nobody_named_yet' }];
  const rails = core.meshRailsTotal(beats);
  for (const b of beats) {
    assert.ok(rails[b.rail] && Number.isFinite(rails[b.rail].max), b.rail + ' has a real limit: ' + JSON.stringify(rails[b.rail]));
    assert.ok(rails[b.rail].max > 0, b.rail + ' is not zero, which would silently swallow every post');
  }
});

test('replies: the machine answers the informational ones on the two rails that allow it, and hands over anything with money in it', async () => {
  const core = await import('file://' + join(root, 'worker', 'core.js'));
  const r = core.MESH_OUTREACH.replies;
  assert.equal(r.per_day, 4, 'four a day is the pipeline number for reply-DMs');
  assert.equal(r.scan_per_day, 3, 'an inbox scan three times a day, not a live socket');
  assert.deepEqual(r.auto_first_reply_on, ['bluesky', 'nostr'], 'and only where a reply is a post, not a private thread');
  assert.match(r.mode, /human/, 'the default stays a person');
  assert.ok(r.escalate_to_human.some((x) => /price/.test(x)) && r.escalate_to_human.some((x) => /angry/.test(x)),
    'price, complaint, refund, anger: straight to the human, no template in front of it');
  assert.equal(core.MESH_AUTONOMY_V3.human, 'replies_only', 'so the policy line still says exactly what is gated');
});

/* v0.9.5 — the press contract, checked against the pipeline's own files. */
test('our cadence is the cadence the running system uses, not numbers I made up', async () => {
  const core = await import('file://' + join(root, 'worker', 'core.js'));
  const fs = await import('node:fs');
  const hunta = JSON.parse(fs.readFileSync(join(root, 'tests', 'fixtures', 'hunta-cadence.json'), 'utf8'));
  const d = core.MESH_QUEUE_DEFAULTS;
  assert.equal(d.promo_per_day, hunta.promo_per_day, 'one promo a day, as their file says');
  assert.equal(d.promo_min_gap_days, hunta.promo_min_gap_days, 'and ' + hunta.promo_min_gap_days + ' days before the same item is sold again');
  assert.equal(d.reply_per_day, hunta.reply_per_day, 'four replies a day');
  assert.equal(d.run_target, hunta.run_target, 'four runs a day is what the grid is built around');
  assert.equal(d.longform_days, hunta.longform_days, 'long form once a week');
  assert.equal(d.topic_max_rails, hunta.topic_max_rails, 'one topic rides at most three rails');
  assert.equal(new Set(Object.keys(hunta).filter((k) => typeof hunta[k] === 'object')).size >= 10, true,
    'and the rail set is theirs: ' + Object.keys(hunta).filter((k) => typeof hunta[k] === 'object').length + ' rails');
  assert.equal(d.per_day, 3, 'three beats per rail per day, which is what every rail entry says');
  assert.equal(hunta.grid_min, undefined, 'the grid is not in their file, it is the 40 minutes the docs name');
  assert.equal(d.grid_min, 40, 'so we state it ourselves, and it matches Buffer\'s own spacing');
});

test('a queued item is written in their keys, so their sender can drain ours', async () => {
  const core = await import('file://' + join(root, 'worker', 'core.js'));
  const fs = await import('node:fs');
  const theirs = JSON.parse(fs.readFileSync(join(root, 'tests', 'fixtures', 'hunta-queue-item.json'), 'utf8'));
  const sample = theirs.items[0];
  const ours = core.meshQueueItem({ kind: 'value', rail: 'x', item_key: 'v1', text: 'A value post about reading boards, no pitch in it.', max: 280 },
    { now: Date.parse(sample.due), landing: theirs.landing, store: theirs.store, channel_id: sample.channel_id });
  for (const k of Object.keys(sample)) assert.ok(k in ours, 'their key ' + k + ' exists in our item');
  assert.equal(ours.channel, sample.channel, 'a beat on the x rail is queued for channel twitter, which is what Buffer calls it');
  assert.equal(ours.channel_id, sample.channel_id, 'the 24-character channel id goes through untouched');
  assert.ok(Date.parse(ours.due) >= Date.parse(sample.due), 'a due time no earlier than the run: ' + ours.due);
  const du = new Date(ours.due);
  assert.equal(du.getUTCSeconds(), 0, 'and it lands exactly on the grid');
  assert.equal(du.getUTCMinutes() % 40, 0, 'on Buffer\'s 40-minute spacing, minute ' + du.getUTCMinutes());
  assert.equal(ours.link, '', 'a value beat carries no link, by construction, not by clipping');
  const promo = core.meshQueueItem({ kind: 'promo', rail: 'x', item_key: 'p1', text: 'Nyama is 6.00 USD, available now', link: theirs.landing, max: 280 },
    { now: Date.parse(sample.due), landing: theirs.landing, store: theirs.store, channel_id: sample.channel_id });
  assert.equal(promo.link, theirs.landing, 'the shop-facts beat carries the store link, which is the whole point of it');
  assert.equal(promo.image, '', 'no card, no fake card url');
  const pin = core.meshQueueItem({ kind: 'promo', rail: 'pinterest', item_key: 'p2', item: 'Nyama', text: 'Nyama is 6.00 USD', link: theirs.landing },
    { now: Date.parse(sample.due), store: theirs.store, board: 'hunta-boards' });
  assert.equal(pin.board, 'hunta-boards', 'and a pin needs the board, or Buffer answers Board not found from a stale cache');
  assert.equal(pin.pin_title, 'Nyama', 'with a title of its own');

  const merged = core.meshQueueMerge({ items: [ours] }, [ours, promo], { now: Date.parse(sample.due) + 1000 });
  assert.equal(merged.added, 1, 'the duplicate id is not queued twice');
  assert.equal(merged.dropped[0].why, 'already queued', 'and it says why');
  const full = core.meshQueueMerge({ items: [ours, promo] }, [core.meshQueueItem({ kind: 'value', rail: 'x', item_key: 'v9', text: 'third', max: 280 }, { now: Date.parse(sample.due) }),
    core.meshQueueItem({ kind: 'value', rail: 'x', item_key: 'v10', text: 'fourth would be too many', max: 280 }, { now: Date.parse(sample.due) })], { now: Date.parse(sample.due) + 2000 });
  assert.equal(full.items.length, 3, 'the rail is full at three for the day: what was queued plus one that fit');
  assert.equal(full.added, 1, 'so the fourth is refused rather than silently deferred');
  assert.equal(full.dropped.filter((x) => /cadence/.test(String(x.why))).length, 1, 'and it says the cadence is why');
});

test('no credential means queued, never posted: the sender only says sent when the platform answered', async () => {
  const core = await import('file://' + join(root, 'worker', 'core.js'));
  const item = { id: 'x1', channel: 'twitter', channel_id: '', due: new Date(Date.now() - 60000).toISOString(), text: 'value', kind: 'value' };
  const noToken = await core.meshPressFlush([item], {}, { now: Date.now() });
  assert.equal(noToken.results[0].status, 'queued', 'no token: the item is queued and says so');
  assert.equal(noToken.sent, 0, 'nothing is claimed as sent');
  assert.equal(noToken.results[0].verified, false, 'and the verified flag is what makes a lie visible');
  const noChan = await core.meshPressFlush([{ ...item, channel_id: '' }], { buffer_token: 't' }, { now: Date.now() });
  assert.match(noChan.results[0].err, /no Buffer channel id/, 'a token with no channel id is a named missing piece, not a silent skip');
  const dry = await core.meshPressFlush([{ ...item, channel_id: 'abc', text: 'value post' }], { buffer_token: 't' }, { dry: true, now: Date.now() });
  assert.equal(dry.results[0].status, 'dry', 'dry runs describe the call and send nothing');
  assert.match(dry.results[0].url, /buffer\.com\/graphql/, 'to the same endpoint the pipeline uses');
  const future = await core.meshPressFlush([{ ...item, channel_id: 'abc', due: new Date(Date.now() + 3600e3).toISOString() }], { buffer_token: 't' }, { now: Date.now() });
  assert.equal(future.results[0].status, 'waiting', 'an item due later stays waiting rather than firing early');
  const calls = [];
  const ok = await core.meshPressFlush([{ ...item, channel_id: 'abc', text: 'value post' }], { buffer_token: 't' },
    { now: Date.now(), fetch: async (u, o) => {
        calls.push({ u, auth: o.headers.authorization, body: o.body });
        return { status: 200, text: async () => '{"data":{"createDraft":{"draft":{"id":"d1"}}}}' };
    } });
  assert.equal(ok.sent, 1, 'a real send, verified by the response');
  assert.equal(ok.results[0].status, 'sent', 'and the status is the platform\'s answer, not ours');
  assert.match(calls[0].auth, /^Bearer t$/, 'the token rides as a bearer header');
  assert.equal(JSON.parse(calls[0].body).variables.input.channelId, 'abc', 'to the channel the shop wired');
  const bad = await core.meshPressFlush([{ ...item, channel_id: 'abc', text: 'value post' }], { buffer_token: 't' },
    { now: Date.now(), fetch: async () => ({ status: 200, text: async () => '{"errors":[{"message":"Channel not connected"}]}' }) });
  assert.equal(bad.sent, 0, 'a 200 with errors in the body is a failure — this is the bug class the docs call prompt blindness');
  assert.equal(bad.results[0].status, 'failed', 'and it is recorded as one, so the rail can be dropped for it');
  const health = core.meshRailHealth({ rails: { twitter: { ok: false, fails: 2 } }, cadence: { twitter: 3 } });
  assert.equal(health.dropped[0].rail, 'twitter', 'two of those and the rail leaves the cadence without a question to anyone');
});

/* v0.9.6 — the press registry: company accounts and delegated sellers, and an operator that cannot be
 * registered at all. This is the boundary the platform's whole positioning depends on, so it is asserted
 * here rather than trusted to whoever next writes a handler. */
test('the registry holds owner and seller identities, and refuses an operator in every direction', async () => {
  const core = await import('file://' + join(root, 'worker', 'core.js'));
  const SHOPS = ['mamatoe', 'kotaking', 'vatmode', 'automesh'];
  const bad = core.meshRegister({}, { id: 'mamatoe', class: 'owner' }, { refuse_ids: SHOPS });
  assert.equal(bad.ok, false, 'a shop handle cannot become a sending identity, even when labelled owner');
  assert.match(bad.why, /we never post to their socials/, 'and the refusal says the rule, not just the verdict');
  const cls = core.meshRegister({}, { id: 'press:shop', class: 'operator' });
  assert.equal(cls.ok, false, 'there is no operator class in the registry to name');
  assert.match(cls.why, /not a content agency/, 'with the reason it exists');
  const sec = core.meshRegister({}, { id: 'seller:a', class: 'seller', buffer_token: 'abc' });
  assert.equal(sec.ok, false, 'a token in the body is refused: KV is readable by the whole worker');
  assert.match(sec.why, /token_env/, 'and it points at the env secret instead');
  const ok = core.meshRegister({}, { id: 'seller:a', class: 'seller', token_env: 'PRESS_BUFFER_TOKEN_A',
    rails: { x: { channel_id: '69fb5a1a5c4c051afa1829dc' }, bluesky: { handle: 'seller-a.bsky.social' }, whatsapp: {} },
    source: { store: 'vatmode' } }, { refuse_ids: SHOPS, now: Date.parse('2026-10-14T06:00:00Z') });
  assert.equal(ok.ok, true, 'a seller identity with a store as its content source registers');
  assert.deepEqual(Object.keys(ok.identity.rails).sort(), ['bluesky', 'x'], 'only rails with a sender survive: whatsapp has no API and is not smuggled in as a sending rail');
  assert.deepEqual(ok.ignored_rails.map((i) => i.rail), ['whatsapp'], 'and the drop is reported, never silent');
  assert.match(ok.ignored_rails[0].why, /a person posts to this one/, 'with the reason');
  assert.equal(ok.identity.rails.x.channel, 'twitter', 'and the buffer rail is stored under the name the sender uses');
  assert.equal(ok.identity.token_env, 'PRESS_BUFFER_TOKEN_A', 'with the secret named, never held');
  assert.equal(ok.identity.source.store, 'vatmode', 'the shop it writes about stays a shop: content source, not send target');
  assert.ok(JSON.stringify(ok.identity).indexOf('69fb5a1a') > -1, 'channel ids are kept: they are identifiers, not secrets');
  assert.equal(core.meshRegister({ 'seller:a': ok.identity }, { id: 'owner', class: 'owner', rails: { nostr: {} } }).count, 2, 'the registry is a map, so a fleet is a loop rather than a schema');
});

test('company content is composed with the same provenance rule as a shop: no number without a fact', async () => {
  const core = await import('file://' + join(root, 'worker', 'core.js'));
  const reg = core.meshRegister({}, { id: 'owner', class: 'owner', rails: { x: { channel_id: 'a' }, bluesky: {}, devto: {} } });
  const idn = reg.identity;
  const b = core.meshCompanyBeats(idn, { price_usd: 60, free_days: 60 }, { origin: 'https://tapstall.zlnew.workers.dev', now: Date.parse('2026-10-14T06:00:00Z') });
  assert.equal(b.beats.length, core.MESH_QUEUE_DEFAULTS.per_day, 'three beats a day on a company account, the pipeline number');
  assert.equal(b.beats.filter((x) => x.kind === 'value').length, 2, 'two of them value');
  assert.equal(b.beats.filter((x) => x.kind === 'promo').length, 1, 'one company facts, with the price in it');
  assert.equal(b.source, 'company', 'and the plan says what material it is, so a run can report it');
  assert.equal(b.beats[0].rails_from, 'identity', 'the rails come from the identity, not from a drafting surface');
  assert.match(JSON.stringify(b.beats), /60/, 'the price came from the facts handed in');
  for (const v of b.beats.filter((x) => x.kind === 'value')) assert.match(v.text, /\/[a-z.]+$/, 'and every value line cites where it is true: ' + v.text.slice(-24));
  assert.ok(!/discount|%\s?off|free trial month/i.test(JSON.stringify(b.beats)), 'no invented offer on a company promo either');
  const noPrice = core.meshCompanyBeats(idn, {}, { now: Date.parse('2026-10-14T06:00:00Z') });
  assert.equal(noPrice.beats.filter((x) => x.kind === 'promo').length, 0, 'with no price in the facts, the promo is not written');
  assert.match(noPrice.blocked[0].why, /cannot invent one either/, 'and the reason is recorded');
  const day = new Set();
  for (let d = 0; d < 7; d += 1) { const x = core.meshCompanyBeats(idn, { price_usd: 60 }, { now: Date.parse('2026-10-14T06:00:00Z') + d * 864e5 }); day.add(x.beats[0].text.slice(0, 30)); }
  assert.ok(day.size >= 4, 'the rhythm rotates through the material rather than repeating one line: ' + day.size + ' distinct opening beats in a week');
});

test('the run writes a ledger per identity, so a dead rail is seen and dropped without a question', async () => {
  const core = await import('file://' + join(root, 'worker', 'core.js'));
  const r1 = core.meshPressLedger(null, [{ channel: 'twitter', status: 'sent', due: 'd1' }], { now: Date.parse('2026-10-14T07:00:00Z') });
  assert.equal(r1.rails.twitter.ok, true, 'a send is recorded as health');
  const r2 = core.meshPressLedger(r1, [{ channel: 'twitter', status: 'failed', err: 'Channel not connected' }], { now: Date.parse('2026-10-15T07:00:00Z') });
  assert.equal(r2.rails.twitter.fails, 1, 'a failure counts from the last state');
  const r3 = core.meshPressLedger(r2, [{ channel: 'twitter', status: 'failed', err: 'Channel not connected' }], { now: Date.parse('2026-10-16T07:00:00Z') });
  assert.equal(r3.rails.twitter.fails, 2, 'twice, and it is at the limit');
  const health = core.meshRailHealth(r3, { now: Date.parse('2026-10-16T08:00:00Z') });
  assert.deepEqual(health.dropped.map((d) => d.rail), ['twitter'], 'so the rail leaves the cadence on its own; a dead rail is not a question for the owner');
  assert.equal(health.yield === undefined, true, 'health does not invent a yield number the ledger does not have');
  assert.equal(r3.yield, 1, 'the ledger itself carries the one send it saw, which is what a yield log means');
  assert.equal(r3.history.length, 3, 'one row per run, kept short');
});

test('a seller whose shop has nothing to say posts the company material instead of saying nothing', async () => {
  const core = await import('file://' + join(root, 'worker', 'core.js'));
  const idn = core.meshRegister({}, { id: 'seller:a', class: 'seller', rails: { x: { channel_id: 'a' } }, source: { store: 'novatmode' } }).identity;
  const empty = core.meshIdentityPlan(Object.assign({ id: 'seller:a' }, idn), { beats: [], blocked: [{ why: 'no items to price' }] },
    { price_usd: 60, free_days: 60 }, { origin: 'https://tapstall.zlnew.workers.dev', now: Date.parse('2026-10-14T06:00:00Z') });
  assert.equal(empty.source, 'company', 'the fallback is the company material, not silence');
  assert.equal(empty.beats.length, core.MESH_QUEUE_DEFAULTS.per_day, 'and it is a full day of it');
  assert.equal(empty.fallback_from, 'novatmode', 'it says which shop had nothing, so the operator can see the hole');
  assert.ok(empty.blocked.some((b) => /no items to price/.test(String(b.why))), 'the shop-side reason is kept, not overwritten');
  const withMenu = core.meshIdentityPlan(Object.assign({ id: 'seller:a' }, idn), { beats: [{ kind: 'value', text: 'Nyama: slow-cooked overnight', rail: 'x' }] }, {}, {});
  assert.equal(withMenu.source, 'store', 'a shop with facts keeps its own voice');
  assert.equal(withMenu.beats.length, 1, 'and its beats pass through untouched');
  const broken = core.meshIdentityPlan(Object.assign({ id: 'seller:a' }, idn), { beats: [{ kind: 'value', text: '', rail: 'x' }, null] }, { price_usd: 60 }, { now: Date.parse('2026-10-14T06:00:00Z') });
  assert.ok(broken.beats.length > 0 && broken.beats.every((b) => b.text), 'empty or missing lines are not sent as blank posts');
});

test("the items table belongs to the client dashboard, and no console claims a shop's menu", () => {
  const shop = read('pages/admin.html');
  assert.match(shop, /id="menuEdit"/, 'the shop console carries the items table');
  assert.match(shop, /id="menuSave"/, 'with a save that is armed only when a row changed');
  assert.match(shop, /id="menuAdd"/, 'and a button to add one');
  assert.match(shop, /k === 'drop'/, 'an item added here can be deleted here');
  assert.match(shop, /api\('\/api\/menu', \{ handle: S\.handle, menu: MDRAFT \}, \{ confirm: '1' \}\)/, 'it writes through the shop session with the confirm header');
  assert.doesNotMatch(shop, /x-tapstall-console/, 'it stamps itself as nothing: it is the shop');
  assert.doesNotMatch(worker, /x-tapstall-console/, 'and no route refuses a shop its own items');
  assert.doesNotMatch(read('pages/src/ops.html'), /api\('\/api\/menu'/, 'the fleet console reads every menu and writes none');
});

test("the client dashboard is honest about where a shop's items live", () => {
  const shop = read('pages/admin.html');
  assert.match(shop, /id="detMenu" open/, 'the items table is open when they arrive, not behind a summary click');
  assert.match(shop, /items live here, not in a sheet/, 'a shop with no sheet is told the truth in the line that used to say otherwise');
  // v0.9.10 tightened this from "looks like a sample" to "is our sample", because the same
  // predicate now decides which UI a shop gets, not just which buttons are shown. A shop that
  // hosts its own CSV on GitHub raw has a feed; ours is the sample path and nothing else —
  // and it is one rule with the worker, which `isPlaceholderFeed` pins from the other side.
  assert.match(shop, /data\|pages\).*sample-menu/, 'our own placeholder is recognised as a placeholder');
  assert.match(shop, /raw.*tapstall/, 'and only from our own repos, not from anybody who uses GitHub');
  assert.match(shop, /var fph = fph0\(fsheet\)/, 'the placeholder is decided once, before either control is drawn');
  assert.match(shop, /q\('#menuReload'\)\.style\.display = fph \? 'none' : ''/, 'and the button that would fetch it back over their edits is removed, not warned about');
});

test('0.9.12 the login form asks once — a second time has a reason, and the shop name survives it', () => {
  // Five merchants, one symptom: sign in, and the form is back on the dashboard.
  // The server answers the whole round-trip correctly on production (proved by the
  // live login journey), so the harm was the client: any single failed read after
  // a good sign-in silently threw them back to a blank form — no reason, no retry,
  // and it even fired with no store name at boot as a stray 404 on the page.
  const shop = read('pages/admin.html');
  assert.match(shop, /if \(!S\.handle\) return;\s*\/\/ a boot with no store name/,
    'a boot with nothing typed in asks the server nothing, so the login card is never greeted by an error');
  assert.match(shop, /\(authed \|\| S\.justIn\) && S\.loadRetry < 2[\s\S]{0,900}S\.loadRetry\+\+;\s*S\.loadTimer = setTimeout\(/,
    'a failure while the dashboard is open — or on the first load after sign-in — buys quiet retries before anyone is bounced');
  assert.match(shop, /var MDRAFT = null;/,
    'the menu draft is declared before menuRows() reads it on the first load — an undeclared read threw, and load()\'s catch put the sign-in card back over the opened dashboard');
  assert.match(shop, /if \(opened\) \{[\s\S]{0,240}q\('#login'\)\.classList\.add\('hide'\)/,
    'and a render error after the dashboard has opened can never resurrect the sign-in card over it');
  assert.match(shop, /stopped working mid-look/, 'and if it does bounce, the page says what happened and what did not');
  assert.match(shop, /q\('#fK'\)\.value = S\.handle;\s*\/\/ the store name they typed, kept; only the PIN is ever theirs/,
    'the store name they typed is re-filled — they re-enter a PIN, not their identity');
  const src = read('pages/src/admin.html');
  assert.ok(src.indexOf('S.loadRetry++') > src.indexOf('function load'), 'the retry lives in load(), which every refresher calls');
});

/* v1.0.0 — the tap is gone: the clock is the trigger, credentials are env-only, and the direct
   rails send from the Worker instead of "a script on the owner's box". */
test('1.0.0 the press runs on the cron, and no design surface asks the owner to tap send', async () => {
  assert.match(worker, /out\.press = await pressTick\(env\)/, 'runCron runs the press window itself');
  assert.match(worker, /async function runPress\(env, origin, opt\)/, 'compose+send exists as a clock-callable function, not only behind an HTTP door');
  assert.match(worker, /press:last/, 'the slot is claimed in KV so a retried tick cannot double-send a window');
  assert.doesNotMatch(doc, /single owner tap sends|one owner tap sends/, 'the owner-tap sentence is gone from the design doc');
  assert.doesNotMatch(core, /one owner tap sending|one tap sends the batch/, 'and from the code comments that taught it');
  const C = await import('file://' + join(root, 'worker', 'core.js'));
  const pr = C.meshPress({ press: { buffer_token: 'a-credential-in-the-wrong-place', channels: { twitter: 'abc' } } }, {});
  assert.equal(pr.has_token, false, 'a Buffer token sitting in a KV shop document is ignored, never used');
  assert.equal(pr.token_from, 'nowhere');
  assert.match(pr.stored_in, /Worker secret only/);
});

test('1.0.0 direct rails send from the Worker when the identity secret is bound — and queue honestly when it is not', async () => {
  const C = await import('file://' + join(root, 'worker', 'core.js'));
  const item = { id: 'b1', channel: 'bluesky', via: 'direct', due: new Date(Date.now() - 1000).toISOString(), text: 'A value line about stock sheets, no pitch in it.' };
  const seen = [];
  const stub = async (url, init) => {
    seen.push(String(url));
    if (String(url).includes('createSession')) return { status: 200, json: async () => ({ accessJwt: 'jwt', did: 'did:plc:x' }), text: async () => '{}' };
    return { status: 200, json: async () => ({ uri: 'at://did:plc:x/app.bsky.feed.post/1' }), text: async () => '{}' };
  };
  const sent = await C.meshPressFlush([item], { direct: { bluesky: { handle: 'house.bsky.social', app_password: 'pw' } } }, { fetch: stub, now: Date.now() });
  assert.equal(sent.sent, 1, JSON.stringify(sent.results));
  assert.equal(sent.results[0].verified, true, 'sent means the platform accepted it, on direct rails too');
  assert.equal(seen.length, 2, 'session then record — the ATProto shape, in order');
  const queued = await C.meshPressFlush([item], {}, { now: Date.now() });
  assert.equal(queued.results[0].status, 'queued');
  assert.match(queued.results[0].err, /no direct credential bound/, 'unbound is a named missing secret, not a silent skip and not a tap owed');
  const tg = { id: 't1', channel: 'telegram', via: 'direct', due: item.due, text: 'value line' };
  const tgSent = await C.meshPressFlush([tg], { direct: { telegram: { bot_token: 'tok', chat_id: '-1001' } } },
    { fetch: async () => ({ status: 200, json: async () => ({ ok: true }), text: async () => '{"ok":true}' }), now: Date.now() });
  assert.equal(tgSent.sent, 1, JSON.stringify(tgSent.results));
  const dry = await C.meshPressFlush([item], { direct: { bluesky: { handle: 'h', app_password: 'pw' } } }, { dry: true, fetch: async () => { throw new Error('dry must not call'); }, now: Date.now() });
  assert.equal(dry.results[0].status, 'dry', 'a dry run still calls nothing');
});
