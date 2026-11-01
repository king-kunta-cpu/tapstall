/**
 * The WhatsApp shop bot (v2.3.1): the conversation as pure functions, then the whole thing through
 * the real Worker bundle — Meta's webhook handshake, the signature, a buyer who reads the menu,
 * orders a sized item with extras in one line, is given the payment slip and pastes the EcoCash
 * SMS back — with the Graph API stubbed and the Durable Object run in-process on a Map.
 *
 * The budget it holds the bot to: two billed replies per order (the menu and the slip). Every other
 * acknowledgement is a reaction, which Meta neither bills nor counts against the free 1,000.
 *
 * What it guards: the bot never prices anything itself (placeOrder does), never files a code by
 * another road (proofAdd does), costs no KV writes for a chat, answers each Meta retry once, stays
 * dormant without its secrets, and stops talking at the monthly cap instead of billing past it.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import {
  waInbound, waSigOk, waParseOrder, waCodes, waProofFrom, waMenu, waBotLink, waStep, waSession, waTextBody, waReactBody, WA_TEXT_MAX,
} from '../worker/wa.js';

/* A movable clock: the 15-minute hold on `wa_admin` is real, so the test steps past it. */
const RealDate = Date;
let shift = 0;
const anchor = new RealDate(RealDate.now()); anchor.setUTCDate(15); anchor.setUTCHours(10, 0, 0, 0);
const base = anchor.getTime() - RealDate.now();
class MovableDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(RealDate.now() + base + shift); else super(...a); }
  static now() { return RealDate.now() + base + shift; }
}
globalThis.Date = MovableDate;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'wa-'));
const bundle = join(dir, 'worker.js');
before(() => {
  execFileSync('bash', [join(root, 'scripts/build_bundle.sh'), dir], { cwd: root, stdio: 'pipe' });
  assert.ok(existsSync(bundle), 'build produced no bundle');
});

/* ------------------------------------------------------------- pure parts */

const hook = (msgs, contacts, phoneId = 'PHONE1') => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '263 77 000 0000', phone_number_id: phoneId },
    contacts: contacts || [], messages: msgs } }] }],
});

test('inbound: messages are flattened, receipts are not answered', () => {
  const got = waInbound(hook([
    { from: '263771110001', id: 'wamid.1', timestamp: '1700000000', type: 'text', text: { body: ' 3x2 ' } },
    { from: '263771110001', id: 'wamid.2', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'C', title: 'Checkout' } } },
    { from: '263771110001', id: 'wamid.3', type: 'image', image: { id: 'm1' } },
  ], [{ wa_id: '263771110001', profile: { name: 'Tendai' } }]));
  assert.equal(got.length, 3);
  assert.deepEqual([got[0].from, got[0].text, got[0].name, got[0].phone_id], ['263771110001', ' 3x2 ', 'Tendai', 'PHONE1']);
  assert.equal(got[1].text, 'C');
  assert.equal(got[2].type, 'image');
  const statuses = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: {}, statuses: [{ id: 'x', status: 'read' }] } }] }] };
  assert.equal(waInbound(statuses).length, 0, 'a delivery receipt is not a message');
  assert.equal(waInbound({ object: 'page', entry: [] }).length, 0);
});

test('signature: HMAC-SHA256 of the raw body with the app secret, nothing else', async () => {
  const raw = JSON.stringify({ a: 1 });
  const good = 'sha256=' + createHmac('sha256', 's3cret').update(raw).digest('hex');
  assert.equal(await waSigOk(raw, good, 's3cret'), true);
  assert.equal(await waSigOk(raw + ' ', good, 's3cret'), false, 'a byte changed');
  assert.equal(await waSigOk(raw, good, 'other'), false, 'another app');
  assert.equal(await waSigOk(raw, '', 's3cret'), false);
  assert.equal(await waSigOk(raw, good, ''), false, 'no secret, no trust');
});

test('order grammar: one typed line carries items, choices, quantities and how to get it', () => {
  assert.deepEqual(waParseOrder('1bd, 2x2 pickup'), { items: [{ n: 1, letters: 'bd', qty: 1 }, { n: 2, letters: '', qty: 2 }], service: 'pickup', address: '' });
  assert.deepEqual(waParseOrder('1bd deliver to 14 Fife Ave, near the Spar'),
    { items: [{ n: 1, letters: 'bd', qty: 1 }], service: 'delivery', address: '14 Fife Ave, near the Spar' }, 'the address keeps its numbers and case');
  assert.deepEqual(waParseOrder('2 x 3'), { items: [{ n: 2, letters: '', qty: 3 }], service: '', address: '' });
  assert.deepEqual(waParseOrder('*1bde* and 2 pickup please').items.length, 2);
  assert.deepEqual(waParseOrder('Deliver'), { items: [], service: 'delivery', address: '' }, 'a bare deliver reuses the last address');
  assert.deepEqual(waParseOrder('2 plates'), { bad: true }, 'an order with a word that does not fit is refused whole');
  for (const no of ['', 'hi', 'how much is delivery', '123456', '0771234567', 'MP221101.1234.A1',
    'Transfer Confirmation. Approval Code: MP261101.1834.C27587']) assert.equal(waParseOrder(no), null, no);
  const codes = waCodes({ opts: [{ name: 'Size', choices: [{ label: 'S' }, { label: 'L', up: 2 }] }], addons: Array.from({ length: 30 }, (_, i) => ({ name: 'A' + i, price: 1 })) });
  assert.equal(codes.length, 25, 'a to z without x');
  assert.ok(!codes.some((c) => c.l === 'x'), 'x means "how many", never a choice');
  assert.deepEqual(waReactBody('+263 77 1', 'wamid.9', '👍'), { messaging_product: 'whatsapp', recipient_type: 'individual', to: '263771', type: 'reaction', reaction: { message_id: 'wamid.9', emoji: '👍' } });
});

test('proof: the code out of a pasted EcoCash SMS, never the order’s own reference', () => {
  const sms = 'Transfer Confirmation. Transfer of USD 14.03 to 0770002222 MAMA TOO successful. Approval Code: MP261101.1834.C27587. New wallet balance: USD 3.10';
  assert.equal(waProofFrom(sms, 'WAB-0001'), 'MP261101.1834.C27587');
  assert.equal(waProofFrom('Txn ID: 8H2KD93LQ ref WAB-0001', 'WAB-0001'), '8H2KD93LQ');
  assert.equal(waProofFrom('ref WAB-0001', 'WAB-0001'), '', 'quoting our reference back is not a payment code');
  assert.equal(waProofFrom('PP261101.0912.H55555'), 'PP261101.0912.H55555');
  assert.equal(waProofFrom('483920117'), '483920117', 'a bank’s all-digit reference typed alone');
  assert.equal(waProofFrom('thanks!'), '');
});

test('menu: every item with its letters, the instructions written from this menu, pages when long', () => {
  const st = { handle: 'm', shop_name: 'M', currency: 'USD', delivery_fee: 2 };
  const small = waMenu(st, [
    { id: 'a', name: 'Beef stew', price: 5, cat: 'Mains', opts: [{ name: 'Size', choices: [{ label: 'Small' }, { label: 'Large', up: 2 }] }], addons: [{ name: 'Egg', price: 0.5 }] },
    { id: 'b', name: 'Coke', price: 1, cat: 'Drinks', available: false },
    { id: 'c', name: 'Water', price: 0.5, cat: 'Drinks' }], { known: false });
  assert.equal(small.pages, 1);
  assert.match(small.text, /\*1\* Beef stew · 5\.00\n   Size: \*a\* Small · \*b\* Large \+2\.00\n   Extras: \*c\* Egg \+0\.50/);
  assert.match(small.text, /\*2\* ~Coke~ _sold out_/);
  assert.match(small.text, /\*1bc\* = Beef stew, Large, \+Egg/, 'the example is a real item with real letters');
  assert.match(small.text, /_1bc, 3x2 pickup_/);
  assert.match(small.text, /_1bc, 3x2 deliver 14 Fife Ave/);
  assert.match(small.text, /react 👍 when I have added it and ❓ when I could not read it/);
  assert.match(small.text, /Delivery 2\.00 USD/);
  const many = Array.from({ length: 120 }, (_, i) => ({ id: 'i' + i, name: 'A rather long item name number ' + i, price: i + 1, cat: 'Cat ' + (i % 6) }));
  const big = waMenu(st, many, { known: true, open: false, label: 'Closed, opens tomorrow at 08:00' });
  assert.ok(big.pages > 1);
  assert.ok(big.text.length <= WA_TEXT_MAX, 'page 1 fits one message: ' + big.text.length);
  assert.match(big.text, /\*menu 2\*: /);
  assert.match(big.text, /HOW TO ORDER/, 'every page can be ordered from');
  assert.match(big.text, /you can still order/);
  const p2 = waMenu(st, many, null, 2);
  assert.ok(p2.text.length <= WA_TEXT_MAX);
  assert.match(p2.text, /\*menu 1\*: /);
  assert.equal(p2.ids.length, 120, 'numbers are the menu’s own on every page');
});

test('link: wa.me with the shop code typed for the buyer; nothing for a bad handle', () => {
  assert.equal(waBotLink('+263 77 000 0000', 'mamatoe', 'Mama Too'), 'https://wa.me/263770000000?text=' + encodeURIComponent('Hi Mama Too! #mamatoe'));
  assert.equal(waBotLink('', 'mamatoe'), '');
  assert.equal(waBotLink('263770000000', 'Bad Handle!'), '');
  const b = waTextBody('+263 77 111', 'x'.repeat(5000));
  assert.equal(b.to, '26377111');
  assert.ok(b.text.body.length <= WA_TEXT_MAX && b.text.preview_url === false);
});

test('step: a retry of the same message id is answered once', async () => {
  const deps = { store: async () => ({ handle: 'x', wa_bot: 'on', currency: 'USD' }), menu: async () => [], hours: async () => ({}) };
  const m = { id: 'w1', from: '263771', type: 'text', text: 'hi', name: '' };
  const a = await waStep(null, m, deps);
  assert.equal(a.replies.length, 1);
  const b = await waStep(a.sess, m, deps);
  assert.equal(b.duplicate, true);
  assert.equal(b.replies.length, 0);
  assert.equal(waSession({ v: 99, cart: [1] }).cart.length, 0, 'a session from another version starts clean');
});

/* --------------------------------------------------- through the Worker */

function kvStub() {
  const m = new Map(); let writes = 0;
  return {
    _map: m, get _writes() { return writes; },
    async get(k, kind) {
      if (!m.has(k)) return null;
      const v = m.get(k).value;
      const type = typeof kind === 'string' ? kind : (kind && kind.type) || '';
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v, o) { writes++; m.set(k, { value: typeof v === 'string' ? v : String(v), meta: o && o.metadata }); },
    async delete(k) { m.delete(k); },
    async list(arg) {
      const prefix = typeof arg === 'string' ? arg : (arg && arg.prefix) || '';
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((k) => (m.get(k).meta === undefined ? { name: k } : { name: k, metadata: m.get(k).meta })), list_complete: true, cursor: '' };
    },
  };
}
/** The Durable Object namespace, in-process: one WaBot per name, storage on a Map. */
function doNamespace(getClass, env) {
  const objs = new Map();
  return {
    idFromName: (n) => n,
    get(id) {
      if (!objs.has(id)) {
        const data = new Map();
        const storage = {
          get: async (k) => (data.has(k) ? structuredClone(data.get(k)) : undefined),
          put: async (k, v) => { data.set(k, structuredClone(v)); },
          setAlarm: async () => {}, deleteAll: async () => data.clear(),
        };
        const Cls = getClass();
        objs.set(id, { obj: new Cls({ storage }, env), data });
      }
      const o = objs.get(id);
      return { fetch: (u, init) => o.obj.fetch(new Request(u, init)), _data: o.data };
    },
    _objs: objs,
  };
}

const MENU = [
  'id,name,category,price,currency,options,addons,stock,popular',
  '1,Chicken & rice,Main,5.50,USD,"Size:Small,Large:2|Spice:mild,hot","Cheese:1.5|Egg:0.5",yes,1',
  '2,2 litre Coke,Drinks,2.50,USD,,,,yes',
  '3,Sold out item,Drinks,3.00,USD,,,no,',
].join('\n');

const sent = [];        // every Graph API call: { to, body } or { read }
let graphStatus = 200;
globalThis.fetch = async (u, init) => {
  const url = String(u);
  if (url.includes('stub/menu.csv')) return new Response(MENU, { headers: { 'content-type': 'text/csv' } });
  if (url.startsWith('https://graph.facebook.com/')) {
    const b = JSON.parse(init.body);
    assert.match(url, /\/v25\.0\/PHONE1\/messages$/);
    assert.equal(init.headers.authorization, 'Bearer tok');
    if (b.status === 'read') sent.push({ read: b.message_id });
    else if (b.type === 'reaction') sent.push({ react: b.reaction.emoji, on: b.reaction.message_id, to: b.to });
    else sent.push({ to: b.to, body: b.text.body });
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.out' }] }), { status: graphStatus, headers: { 'content-type': 'application/json' } });
  }
  return new Response('no network in tests', { status: 599 });
};

const env = {
  STORES: kvStub(), ORDERS: kvStub(), ADMIN_SECRET: 'test-secret', DISCOVERY: 'off',
  REG_RL: { windowSec: 3600, max: 100000 }, REG_RL_DAY: { windowSec: 86400, max: 100000 },
  PUBLIC_ORIGIN: 'https://tapstall.test',
};
let worker, mod;
async function load() {
  if (!worker) { mod = await import('file://' + bundle); worker = mod.default; }
  return worker;
}
async function call(path, { method = 'GET', body, cookie, headers, raw } = {}) {
  const w = await load();
  const h = { 'content-type': 'application/json', 'cf-connecting-ip': '196.1.1.1', ...(headers || {}) };
  if (cookie) { h.cookie = cookie; h['x-tapstall-confirm'] = '1'; }
  const req = new Request('https://tapstall.test' + path, { method, headers: h,
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
  const waits = [];
  const res = await w.fetch(req, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, headers: res.headers };
}
function arm() {
  Object.assign(env, { WA_TOKEN: 'tok', WA_APP_SECRET: 'appsecret', WA_VERIFY_TOKEN: 'verify-me', WA_PHONE_ID: 'PHONE1', WA_NUMBER: '263770000000' });
  env.WA_BOT = doNamespace(() => mod.WaBot, env);
}
let seq = 0;
async function buyerSays(text, { from = '263771110001', name = 'Tendai', type = 'text', id } = {}) {
  const mid = id || 'wamid.in' + (++seq);
  const msg = type === 'text' ? { from, id: mid, timestamp: '1', type, text: { body: text } } : { from, id: mid, timestamp: '1', type, image: { id: 'img' } };
  const raw = JSON.stringify(hook([msg], [{ wa_id: from, profile: { name } }]));
  const sig = 'sha256=' + createHmac('sha256', env.WA_APP_SECRET).update(raw).digest('hex');
  const before = sent.length;
  const r = await call('/wa/hook', { method: 'POST', raw, headers: { 'x-hub-signature-256': sig } });
  assert.equal(r.status, 200, r.text);
  const got = sent.slice(before);
  lastReact = (got.find((x) => x.react && x.on === mid) || {}).react || '';
  lastBilled = got.filter((x) => x.body).length;
  return got.filter((x) => x.body).map((x) => x.body).join('\n---\n');
}
let lastReact = '', lastBilled = 0;
/** One message; what came back: billed replies (text) and the free reaction. */
async function says(text, opts) { const t = await buyerSays(text, opts); return { t, react: lastReact, billed: lastBilled }; }
async function newShop(handle, extra) {
  const r = await call('/api/register', { method: 'POST', body: Object.assign({
    shop_name: 'WA Test Kitchen', owner_name: 'Rudo', owner_email: 'rudo@example.com', market: 'zw', city: 'Harare',
    whatsapp: '263772220002', handle, currency: 'USD', rail: 'ecocash_usd', pay_account: '0770002222',
    feed_url: 'https://stub/menu.csv' }, extra || {}) });
  assert.equal(r.status, 201, r.text);
  const a = await call('/api/auth', { method: 'POST', body: { key: handle, pin: r.json.pin } });
  const m = (a.headers.get('set-cookie') || '').match(/tp_sess=([^;]+)/);
  assert.ok(m, 'signed in');
  return { handle, cookie: 'tp_sess=' + m[1] };
}

let shop;

test('dormant until armed: the webhook answers 503 and the dashboard says "waiting for the number"', async () => {
  await load();
  shop = await newShop('wakitchen');
  const r = await call('/wa/hook', { method: 'POST', raw: '{}', headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } });
  assert.equal(r.status, 503);
  const on = await call('/api/settings', { method: 'POST', cookie: shop.cookie, body: { handle: shop.handle, wa_bot: 'on' } });
  assert.equal(on.status, 200, on.text);
  assert.deepEqual(on.json.applied_now, ['wa_bot'], 'installing the bot is instant: it moves no money');
  const adm = await call('/api/admin?handle=' + shop.handle, { cookie: shop.cookie });
  assert.equal(adm.json.wa.on, true);
  assert.equal(adm.json.wa.armed, false);
  assert.equal(adm.json.wa.link, '', 'no number yet, so no link to hand out');
  const self = await call('/__selftest');
  assert.equal(self.json.wa_bot.armed, false);
});

test('Meta’s handshake: the challenge is echoed to the verify token and nobody else', async () => {
  arm();
  const ok = await call('/wa/hook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444');
  assert.equal(ok.status, 200);
  assert.equal(ok.text, '1158201444');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const bad = await call('/wa/hook?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=1');
  assert.equal(bad.status, 403);
  const unsigned = await call('/wa/hook', { method: 'POST', raw: JSON.stringify(hook([])) });
  assert.equal(unsigned.status, 401, 'an unsigned body is a stranger');
  const adm = await call('/api/admin?handle=' + shop.handle, { cookie: shop.cookie });
  assert.equal(adm.json.wa.armed, true);
  assert.match(adm.json.wa.link, /^https:\/\/wa\.me\/263770000000\?text=.*%23wakitchen$/);
});

test('a buyer orders inside WhatsApp for two billed replies: the menu, then the slip', async () => {
  const w0 = env.STORES._writes + env.ORDERS._writes;
  const unknown = await buyerSays('Hi! #nosuchshop');
  assert.match(unknown, /could not find a shop called \*#nosuchshop\*/);

  const billed0 = sent.filter((x) => x.body && x.to === '263771110001').length;
  // reply 1 of 2: the menu, with every item's letters and the instructions
  const menu = await says('Hi WA Test Kitchen! #wakitchen');
  assert.equal(menu.billed, 1);
  assert.match(menu.t, /\*WA Test Kitchen\*/);
  assert.match(menu.t, /\*1\* Chicken & rice · 5\.50\n   Size: \*a\* Small · \*b\* Large \+2\.00\n   Spice: \*c\* mild · \*d\* hot\n   Extras: \*e\* Cheese \+1\.50 · \*f\* Egg \+0\.50/);
  assert.match(menu.t, /\*2\* 2 litre Coke · 2\.50/);
  assert.match(menu.t, /\*3\* ~Sold out item~ _sold out_/);
  assert.match(menu.t, /HOW TO ORDER/);
  assert.ok(sent.some((x) => x.read), 'the buyer’s message was marked read');

  // building the cart costs nothing: a reaction for each message
  let r = await says('3');
  assert.deepEqual([r.billed, r.react], [0, '❓'], 'sold out: not added, said with a reaction');
  r = await says('2x2');
  assert.deepEqual([r.billed, r.react], [0, '👍']);
  r = await says('1z');
  assert.deepEqual([r.billed, r.react], [0, '❓'], 'a letter that is not one of item 1’s choices');
  r = await says('1abe');
  assert.deepEqual([r.billed, r.react], [0, '❓'], 'two sizes at once is refused whole');
  r = await says('1be');
  assert.deepEqual([r.billed, r.react], [0, '👍'], 'Large + Cheese; spice left to the first choice');
  r = await says('hello');
  assert.deepEqual([r.billed, r.react], [0, '👋'], 'a greeting right after the menu does not resend it');
  r = await says('', { type: 'audio' });
  assert.deepEqual([r.billed, r.react], [0, '❓'], 'a voice note: the menu says typed text only');
  r = await says('deliver');
  assert.deepEqual([r.billed, r.react], [0, '❓'], 'deliver with no address and none on file');
  assert.equal(env.STORES._writes + env.ORDERS._writes, w0, 'browsing and a cart cost no KV writes at all');

  // reply 2 of 2: the slip
  const slip = await says('pickup');
  assert.equal(slip.billed, 1);
  const code = (slip.t.match(/Order (WAK-\d{4}) is in/) || [])[1];
  assert.ok(code, slip.t);
  assert.match(slip.t, /2× 2 litre Coke · 5\.00/);
  assert.match(slip.t, /1× Chicken & rice \(Large, mild, \+Cheese\) · 9\.00/);
  assert.match(slip.t, /Pickup/);
  assert.match(slip.t, /Name: Tendai/, 'the WhatsApp profile name');
  assert.match(slip.t, /Note: Chicken & rice: no spice sent, so mild/, 'the default is said out loud');
  assert.match(slip.t, /How to pay/);
  assert.match(slip.t, /Send exactly \d+\.\d\d USD to 0770002222/);
  assert.match(slip.t, /Use reference: WAK-/);
  assert.match(slip.t, /Then paste the payment SMS here/);
  assert.match(slip.t, /Optional: to send a screenshot .*https:\/\/wa\.me\/263772220002\?text=Hi%20about%20order%20WAK-/);

  const keys = [...env.ORDERS._map.keys()].filter((k) => k.startsWith('order:wakitchen:'));
  assert.equal(keys.length, 1);
  const o = JSON.parse(env.ORDERS._map.get(keys[0]).value);
  assert.equal(o.code, code);
  assert.equal(o.buyer.phone, '263771110001');
  assert.equal(o.buyer.name, 'Tendai');
  assert.equal(o.service, 'pickup');
  assert.equal(o.status, 'awaiting_payment');
  const chicken = o.items.find((i) => i.name === 'Chicken & rice');
  assert.deepEqual(chicken.options.map((x) => x.label), ['Large', 'mild']);
  assert.deepEqual(chicken.addons, [1.5]);
  assert.ok(!(o.risk_flags || []).some((f) => /repriced|off-menu/.test(f)), 'the bot sends menu prices, so nothing was repriced: ' + o.risk_flags);

  // the SMS is filed silently: ✅ and no message
  const sms = `Transfer Confirmation. Transfer of USD ${o.pricing.pay_now} to 0770002222 WA TEST successful. Approval Code: MP261115.1022.K88421. New wallet balance: USD 1.00`;
  const filed = await says(sms);
  assert.deepEqual([filed.billed, filed.react], [0, '✅']);
  const o2 = JSON.parse(env.ORDERS._map.get(keys[0]).value);
  assert.equal(o2.buyer.proof, 'MP261115.1022.K88421');
  assert.equal(o2.proof_by, 'buyer', 'filed through the buyer’s own door, proofAdd');
  const thanks = await says('thanks!');
  assert.deepEqual([thanks.billed, thanks.react], [0, '🙏']);
  const pic = await says('', { type: 'image' });
  assert.deepEqual([pic.billed, pic.react], [0, '❓'], 'a screenshot: the slip already said paste the text');

  const billed = sent.filter((x) => x.body && x.to === '263771110001').length - billed0;
  assert.equal(billed, 2, 'the whole order, cart to filed payment code, cost two billed replies');

  // optional, on the buyer's request only (each is one more billed reply)
  const st = await buyerSays('status');
  assert.match(st, new RegExp('Order \\*' + code + '\\*: waiting for your payment'));
  assert.match(st, /Payment code on file: MP261115\.1022\.K88421/);
  assert.match(await buyerSays('talk'), /https:\/\/wa\.me\/263772220002\?text=Hi%20about%20order%20WAK-/);
});

test('one line does it all; the next order can reuse the address with a bare "deliver"', async () => {
  const buyer = { from: '263775550005', name: 'Farai' };
  const before = sent.filter((x) => x.body && x.to === buyer.from).length;
  const one = await says('#wakitchen', buyer);
  assert.equal(one.billed, 1);
  const slip = await says('1bdf, 2 deliver 7 Kent Rd, Avondale, blue gate', buyer);
  assert.equal(slip.billed, 1);
  assert.match(slip.t, /Deliver to: 7 Kent Rd, Avondale, blue gate/);
  assert.match(slip.t, /1× Chicken & rice \(Large, hot, \+Egg\)/);
  assert.doesNotMatch(slip.t, /Note:/, 'every choice was sent, so nothing to note');
  assert.equal(sent.filter((x) => x.body && x.to === buyer.from).length - before, 2);
  const again = await says('2x3', buyer);
  assert.equal(again.react, '👍');
  const slip2 = await says('deliver', buyer);
  assert.match(slip2.t, /Deliver to: 7 Kent Rd, Avondale, blue gate/);
  const x = await says('2', buyer);
  assert.equal(x.react, '👍');
  assert.deepEqual([(await says('x', buyer)).react, (await says('pickup', buyer)).react], ['👍', '❓'], 'x empties the cart, so pickup has nothing to send');
});

test('a buyer who keeps asking runs into the daily cap; the slip never does', async () => {
  const buyer = { from: '263776660006', name: 'Nyasha' };
  env.WA_BUYER_DAY_CAP = '3';
  await says('#wakitchen', buyer);
  await says('help', buyer);
  await says('cart', buyer);
  const fourth = await says('menu', buyer);
  assert.deepEqual([fourth.billed, fourth.react], [0, '⏳'], 'past the cap: a reaction, not a reply');
  await says('2', buyer);
  const slip = await says('pickup', buyer);
  assert.equal(slip.billed, 1, 'the slip is the order: it always goes');
  assert.match(slip.t, /Order WAK-\d{4} is in/);
  delete env.WA_BUYER_DAY_CAP;
});

test('a Meta retry of a message is answered once', async () => {
  const first = await buyerSays('M', { id: 'wamid.retry1' });
  assert.match(first, /WA Test Kitchen/);
  const again = await buyerSays('M', { id: 'wamid.retry1' });
  assert.equal(again, '', 'the second delivery of the same id sends nothing');
});

test('a shop that has not installed the bot says so and hands over its own number', async () => {
  await newShop('offshop', { whatsapp: '263773330003' });
  const r = await buyerSays('#offshop', { from: '263779990009' });
  assert.match(r, /has not switched on WhatsApp ordering yet/);
  assert.match(r, /wa\.me\/263773330003/);
});

test('shop commands run only from the shop’s own number, and only after the held switch lands', async () => {
  const merchant = { from: '263772220002', name: 'Rudo' };
  await buyerSays('#wakitchen', merchant);
  const refused = await buyerSays('shop orders', merchant);
  assert.doesNotMatch(refused, /Today at/, 'commands are off until the owner turns them on');

  const set = await call('/api/settings', { method: 'POST', cookie: shop.cookie, body: { handle: shop.handle, wa_admin: true } });
  assert.equal(set.status, 200, set.text);
  assert.deepEqual(set.json.held, ['wa_admin'], 'an authority change waits out the hold');
  assert.match(await buyerSays('shop orders', merchant), /^(?!.*Today at)/s);
  shift += 16 * 60e3;                                  // past the 15-minute hold

  const list = await buyerSays('shop orders', merchant);
  assert.match(list, /\*Today at WA Test Kitchen\* \(4\)/);
  const code = (list.match(/(WAK-\d{4})[^\n]*Tendai/) || [])[1];
  assert.ok(code);

  const stranger = await buyerSays('shop paid ' + code, { from: '263771110001' });
  assert.doesNotMatch(stranger, /→ paid/, 'a buyer cannot mark anything');

  const paid = await buyerSays('shop paid ' + code.toLowerCase(), merchant);
  assert.match(paid, new RegExp(code + ' → paid'));
  const k = [...env.ORDERS._map.keys()].find((x) => x.startsWith('order:wakitchen:') && JSON.parse(env.ORDERS._map.get(x).value).code === code);
  assert.equal(JSON.parse(env.ORDERS._map.get(k).value).status, 'paid');
  assert.match(await buyerSays('S', { from: '263771110001' }), /paid ✅/);

  assert.match(await buyerSays('shop close', merchant), /^Closed\./);
  const doc = JSON.parse(env.STORES._map.get('store:wakitchen').value);
  assert.equal(doc.closed, true);
  assert.match(await buyerSays('shop open', merchant), /^Open\./);
});

test('the shop’s WhatsApp ping costs a billed message, so it is off unless WA_SHOP_PING=on', async () => {
  const merchant = '263772220002';
  await buyerSays('M', { from: merchant, name: 'Rudo' });              // the shop spoke within 24h
  const buyer = { from: '263774440004', name: 'Chipo' };
  await buyerSays('#wakitchen', buyer);
  await buyerSays('2', buyer);
  let before = sent.length;
  await buyerSays('deliver Plot 4, Borrowdale Rd, near the Spar', buyer);
  assert.ok(!sent.slice(before).some((x) => x.to === merchant), 'off by default: email and webhook carry the order');
  env.WA_SHOP_PING = 'on';
  await buyerSays('2', buyer);
  before = sent.length;
  await buyerSays('deliver', buyer);
  const ping = sent.slice(before).find((x) => x.to === merchant);
  assert.ok(ping, 'the merchant heard about it');
  assert.match(ping.body, /New WhatsApp order WAK-\d{4}/);
  assert.match(ping.body, /deliver to Plot 4, Borrowdale Rd/);
  delete env.WA_SHOP_PING;
});

test('the monthly cap: past it the bot goes quiet instead of billing', async () => {
  const meter = env.WA_BOT.get('meter:PHONE1');
  const month = new Date().toISOString().slice(0, 7);
  const used = meter._data.get('m:' + month);
  assert.ok(used > 8, 'every billed reply was counted: ' + used);
  const reacts = sent.filter((x) => x.react).length;
  assert.ok(reacts > 10, 'and reactions were sent without touching the meter: ' + reacts);
  env.WA_MONTH_CAP = String(used);
  const before = sent.filter((s) => s.body).length;
  await buyerSays('M');
  assert.equal(sent.filter((s) => s.body).length, before, 'nothing sent at the cap');
  assert.equal(meter._data.get('c:' + month), 1, 'and the refusal is counted for the operator');
  const self = await call('/__selftest');
  assert.equal(self.json.wa_bot.month_sent, used);
  assert.equal(self.json.wa_bot.sessions, 'durable_object');
  delete env.WA_MONTH_CAP;
});

test('the deploy paths all carry the Durable Object binding and its migration', async () => {
  const { readFileSync } = await import('node:fs');
  const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8');
  for (const f of ['wrangler.toml', 'scripts/gen_wrangler_toml.py']) {
    const s = readFileSync(join(root, f), 'utf8');
    assert.match(s, /\[\[durable_objects\.bindings\]\]\nname = "WA_BOT"\nclass_name = "WaBot"/, f);
    assert.match(s, /new_sqlite_classes = \["WaBot"\]/, f + ': free plan needs the SQLite kind');
  }
  const pub = readFileSync(join(root, 'scripts/cf_publish.py'), 'utf8');
  assert.match(pub, /"durable_object_namespace", "name": "WA_BOT", "class_name": "WaBot"/);
  assert.match(pub, /new_sqlite_classes/);
  assert.ok(toml.indexOf('WA_BOT') > 0);
  assert.equal(typeof mod.WaBot, 'function', 'the bundle exports the class the binding names');
});

test('the privacy notice Meta asks for is served, and says what the bot keeps', async () => {
  const r = await call('/privacy');
  assert.equal(r.status, 200);
  assert.match(r.text, /deleted after 60 days with no messages/);
  assert.match(r.text, /We cannot read pictures/);
});
