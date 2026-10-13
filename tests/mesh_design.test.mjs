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
  assert.doesNotMatch(worker, /'\/api\/mesh\/(publish|send|post|schedule)'/,
    'there is no auto-publish endpoint, and adding one must be a decision with a test written for it');
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
  const st = { handle: 'mamatoe', shop_name: 'Mama Too', currency: 'USD', mesh_channels: { bluesky: { on: true }, whatsapp: { on: true } } };
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
  const assist = core.meshSchedule({ handle: 'x', mesh_channels: { whatsapp: { on: true } } }, rows, {}, { state: { auto: { on: true } }, now: Date.now() });
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
