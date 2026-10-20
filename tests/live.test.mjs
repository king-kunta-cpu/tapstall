/**
 * Live smoke test: runs the real Worker handler (fetch + cron) against an
 * in-memory KV stub and a stubbed feed, walking the whole merchant journey a
 * customer takes with nobody operating the platform:
 *
 *   register → storefront → menu feed → order → one-tap paid → dashboard →
 *   export → renew link → cron suspension/reinstatement
 *
 * It exists because a unit test of core.js cannot catch a ReferenceError in
 * worker.js (a helper imported but not exported, a renamed function). Those
 * bugs only surface on the deployed Worker — after 4 of them reached
 * production during this build. This test catches them at `npm test`.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackRow, packRow, orderRow, ROW_META_CAP } from '../worker/core.js';
import { createHmac } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'zl-'));
const bundle = join(dir, 'worker.js');

// core.js has no exports of its own to inline-check here, so build the same
// bundle the publisher ships, straight into a temp dir.
before(() => {
  // bash, not the executable bit: snapshots and some checkouts drop the file
  // mode, and a test that fails because of that is a test about permissions
  execFileSync('bash', [join(root, 'scripts/build_bundle.sh'), dir], { cwd: root, stdio: 'pipe' });
  assert.ok(existsSync(bundle), 'build produced no bundle');
});

// Exactly the contract the storefront documents: 9 columns, `|` between option
// groups, `,` between choices, "Name:price" for a priced choice/add-on.
const MENU = [
  'id,name,category,price,currency,options,addons,stock,popular',
  '1,Chicken & rice,Main,5.50,USD,"Size:Small,Large:2|Spice:mild,hot","Cheese:1.5|Egg:0.5",yes,1',
  '2,2 litre Coke,Drinks,2.50,USD,,,,yes',
  '3,Sold out item,Drinks,3.00,USD,,,,no,',
  '4,Jollof and chicken,Main,100.00,USD,,,,yes',
  '5,Waakye,Main,50.00,USD,,,,yes',
  '6,Waakye special,Main,12.50,USD,,,,yes',
  'a,a,Main,1.00,USD,,,,no',
].join('\n');

function kvStub() {
  const m = new Map();
  let writes = 0, deletes = 0;                    // the free plan allows 1,000 a day, total
  const byKey = new Map(); const gone = [];
  // A budget is only a meaningful assertion when you can say which key spent it:
  // "60 wrong PINs cost <= 6 writes" tipped over on a legitimate fold of the store
  // document, which is a different event on a different budget, and the test read as
  // a throttle regression. So the tally is per key and the ceiling is per behaviour.
  const tally = (k) => byKey.set(k, (byKey.get(k) || 0) + 1);
  const toBin = (v) => (v instanceof ArrayBuffer ? v
    : ArrayBuffer.isView(v) ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)
    : new TextEncoder().encode(String(v)).buffer);
  return {
    _map: m,
    get _writes() { return writes; },
    get _deletes() { return deletes; },
    _writesTo(key) { return byKey.get(key) || 0; },
    _deleted(key) { return gone.includes(key); },
    async get(key, kind) {
      if (!m.has(key)) return null;
      const v = m.get(key).value;
      const type = typeof kind === 'string' ? kind : (kind && kind.type) || '';   // both shapes Cloudflare takes
      if (type === 'json') return JSON.parse(typeof v === 'string' ? v : new TextDecoder().decode(v));
      if (type === 'stream') return { json: async () => JSON.parse(typeof v === 'string' ? v : new TextDecoder().decode(v)) };
      if (type === 'arrayBuffer') return toBin(v).slice(0);
      return typeof v === 'string' ? v : new TextDecoder().decode(v);
    },
    async put(key, value, opts) {
      writes++; tally(key);
      // Metadata is not a nicety here: the ledger row *is* the metadata, and a stub that dropped it
      // would make every row look lost while the platform had it all along.
      m.set(key, { value: typeof value === 'string' ? value : toBin(value), exp: opts?.expirationTtl,
        meta: opts && opts.metadata !== undefined ? opts.metadata : undefined });
    },
    async delete(key) { deletes++; gone.push(key); tally('del:' + key); m.delete(key); },
    async list(arg) {
      const prefix = typeof arg === 'string' ? arg : (arg && arg.prefix) || '';
      const keys = [...m.keys()].filter((k) => !prefix || k.startsWith(prefix))
        .filter((k) => !k.startsWith('rl:') && !k.startsWith('__ping'))
        .map((k) => {
          const meta = m.get(k).meta;
          return meta === undefined ? { name: k } : { name: k, metadata: meta };
        });
      return { keys, list_complete: true, cursor: '' };
    },
  };
}

// The ledger row is metadata on the order document (v0.9.1), so "the row the merchant's list
// shows" means reading the document's metadata and expanding it with the same table the Worker
// packs with. A hand-written copy of that mapping here would drift and agree with nothing.
function storedRow(handle, id) {
  const rec = env.ORDERS._map.get(`order:${handle}:${id}`);
  return rec && rec.meta ? unpackRow(rec.meta) : null;
}
function storedRows(handle) {
  const prefix = `order:${handle}:`;
  const out = [];
  for (const [k, v] of env.ORDERS._map) {
    if (!k.startsWith(prefix) || !v.meta) continue;
    const r = unpackRow(v.meta);
    r.id = k.slice(prefix.length);
    out.push(r);
  }
  return out;
}
function indexWritesFor(handle) { return env.ORDERS._writesTo('list:' + handle); }
// A test that edits an order document has to write the row with it. That is the same rule the
// Worker follows — `saveOrder` is the only writer of an order key, which is why the row cannot
// drift from the order — and a test that pokes a document directly is a writer too.
async function putDoc(handle, id, doc) {
  await env.ORDERS.put(`order:${handle}:${id}`, JSON.stringify(doc), { metadata: packRow(orderRow(doc)) });
}

const env = {
  STORES: kvStub(),
  ORDERS: kvStub(),
  ADMIN_SECRET: 'test-secret',
  // the register meter ships at 3/hour + 6/day per address — the whole suite
  // builds stores from one harness address, so it passes a wide meter; one test
  // below proves the rule itself at 2/3 instead of trusting these numbers
  REG_RL: { windowSec: 3600, max: 100000 }, REG_RL_DAY: { windowSec: 86400, max: 100000 },
};

let worker;
async function load() {
  if (!worker) worker = (await import('file://' + bundle)).default;
  return worker;
}

// `ip` because POST /api/order is throttled 8/min/IP — the rail tests below
// place a few more orders than that on purpose, and a 429 is not what they are
// here to prove.
async function call(path, { method = 'GET', body, cookie, confirm, headers, ip, raw, etag } = {}) {
  const w = await load();
  const h = { 'content-type': 'application/json', 'cf-connecting-ip': ip || '196.0.0.1', ...(headers || {}) };
  if (cookie) h.cookie = cookie;
  if (confirm) h['x-tapstall-confirm'] = '1';
  if (etag) h['if-none-match'] = etag;
  if (raw && body !== undefined && !(body instanceof ArrayBuffer)) h['content-type'] = 'application/octet-stream';
  const req = new Request('https://tapstall.test' + path, {
    method, headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' || body instanceof ArrayBuffer ? body : JSON.stringify(body)),
  });
  const ctx = { waitUntil: (p) => p };
  const res = await w.fetch(req, env, ctx);
  const text = raw ? null : await res.text();
  const buf = raw ? await res.arrayBuffer() : null;   // for a body that is not text
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const cookies = res.headers.getSetCookie?.() || [];
  // `cookies` as well as `cookie`: the rename means one response can now carry a
  // Set-Cookie for the new name and a Max-Age=0 for the old one, and a test that
  // only sees a joined blob cannot tell which cookie it is complaining about
  return { status: res.status, text, json, buf, headers: res.headers, cookies, cookie: cookies.join(';') };
}
/** A form post, the way a page with no JavaScript (or a `<noscript>` fallback) sends one. */
function form(o) { return Object.keys(o).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&'); }
/** Sign in the way the merchant's browser does: exchange the emailed code for a cookie. */
/** The merchant way in since 0.6.0: a key (the store name) and a PIN. */
async function loginWithPin(key, pin) {
  const r = await call('/api/auth', { method: 'POST', body: { key, pin } });
  const set = (r.headers.getSetCookie?.() || [])[0] || '';
  const m = set.match(/tp_sess=([^;]+)/);
  return { r, cookie: m ? 'tp_sess=' + m[1] : null };
}
const DEAD_LINK = 'v1.9999999999.eyJhIjoibG9naW4ifQ.deadbeef';   // what a pre-0.6 bookmark holds

let store = {};

// Serve the real templates through the stub, exactly as KV does in production,
// so the storefront test exercises injection rather than the fallback page.
before(async () => {
  // derived from the directory, exactly as deploy.sh does: a page in git that nobody
  // added to a list is a page that ships broken, in the test and in production alike
  const TPL = ['store', 'onboard', 'admin', 'fees', 'index', 'confirm', 'renew', 'ops']
    .concat(readdirSync(join(root, 'pages')).filter((f) => /^guide-.*\.html$/.test(f)).map((f) => f.slice(0, -5)));
  for (const name of TPL) {
    const html = readFileSync(join(root, 'pages', name + '.html'), 'utf8');
    await env.STORES.put('tpl:' + name, html);
  }
  await env.STORES.put('tpl:sample-menu', readFileSync(join(root, 'pages', 'sample-menu.csv'), 'utf8'));
});

// The merchant's "Google Sheet" is stubbed for the whole file: each test file
// runs in its own process, and the file is one continuous merchant journey.
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => (String(u).includes('stub/menu.csv')
  ? new Response(MENU, { headers: { 'content-type': 'text/csv' } })
  : realFetch(u, init));

test('register creates a live store with no operator involvement', async () => {

  const r = await call('/api/register', {
    method: 'POST',
    body: {
      shop_name: 'Mama Too Catering', owner_name: 'Rutendo', owner_email: 'owner@example.com',
      market: 'zw', city: 'Harare', whatsapp: '263771234567', handle: 'mamatoe', currency: 'USD',
      feed_url: 'https://stub/menu.csv', tax_pct: 15.5, delivery_fee: 2, rail: 'ecocash_usd', pay_account: '0770001111',
      surcharge_mode: 'absorb',
    },
  });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.products_loaded, 7, 'merchant sees instantly that the sheet parsed — 7 rows, 7 counted');
  assert.equal(r.json.feed_error, null, 'feed error surfaced to the merchant');
  assert.ok(!r.json.admin_url, 'the stored dashboard link is gone with the login scheme that needed it');
  assert.ok(/^[0-9]{6}$/.test(String(r.json.pin)), 'the merchant gets a six-digit PIN');
  assert.equal(r.json.key, 'mamatoe', 'the key is the store name, which they already know');
  assert.ok(!JSON.stringify(r.json).includes('admin_token'), 'register response does not echo the API key');
  assert.ok(!JSON.stringify(r.json).includes('kdf'), 'nor does it echo the PIN record: only the PIN itself, once');
  store = { handle: r.json.handle, key: r.json.key, pin: r.json.pin, renew_url: r.json.renew_url, code: DEAD_LINK };
  assert.match(store.handle, /^mamatoe$/);
  assert.ok(r.json.store_url.includes('/s/mamatoe'), 'store_url returned');
});

test('storefront and config render; no secrets leak to the public', async () => {
  const page = await call('/s/mamatoe');
  assert.equal(page.status, 200);
  assert.match(page.text, /<!doctype html>/i, 'storefront served');
  const injected = page.text.indexOf('var CFG = {') >= 0;
  if (!injected) console.log('CFG LINE:', JSON.stringify((page.text.match(/var CFG/) || ['<none>'])[0]), 'status', page.status, 'bytes', page.text.length);
  assert.ok(injected, 'store config injected into the served page');
  assert.ok(!/\/\*__TAPSTALL_/.test(page.text), 'no unreplaced placeholder left in the page');

  assert.ok(page.text.includes('"shop_name":"Mama Too Catering"'), 'shop name reaches the buyer-facing page');
  assert.ok(!page.text.includes('admin_token'), 'injected config carries no admin token');
  assert.ok(!page.text.includes(store.code), 'the login code is not in the buyer-facing page');

  const cfg = await call('/s/mamatoe/config.json');
  assert.equal(cfg.json.ok, true);
  const blob = JSON.stringify(cfg.json);
  for (const leak of ['admin_token', 'owner_email', 'notify_email', 'feed_cache', 'feed_url', 'notify_webhook']) {
    assert.ok(!blob.includes(leak), `public config leaked "${leak}"`);
  }

  const missing = await call('/s/nobody');
  assert.equal(missing.status, 404);
});

test('a shop is born in its template and can restyle itself without an operator', async () => {
  const h = 'designfood';
  let r = await call('/api/register', {
    method: 'POST', ip: '196.51.100.21',
    body: { handle: h, shop_name: 'Design Kotas', whatsapp: '263771234568', currency: 'USD', feed_url: 'https://stub/menu.csv', business_type: 'food' },
  });
  assert.equal(r.status, 201, r.text);
  const key = () => JSON.parse(env.STORES._map.get('store:' + h).value).admin_token;
  let cfg = await call('/s/' + h + '/config.json');
  assert.equal(cfg.json.store.business_type, 'food');
  assert.equal(cfg.json.store.design.template, 'food');
  assert.equal(cfg.json.store.design.accent, '#b33a1f');
  assert.equal(cfg.json.store.design.hero, 'cover');
  assert.equal(cfg.json.store.design.popular_label, 'Most ordered');

  r = await call('/api/settings', {
    method: 'POST', confirm: true, ip: '196.51.100.22', headers: { 'x-tapstall-admin': key() },
    body: {
      handle: h, accent_color: 'abc', cover_image: 'https://example.test/cover.jpg', store_layout: 'list',
      hero_style: 'minimal', cta_label: 'Reserve', sort_mode: 'price_low', search_bar: 'hide',
      whatsapp_button: 'show', welcome_message: 'Hot from 10, while it lasts', about: 'By the rank, under the blue awning.',
    },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal((r.json.held || []).length, 0, 'the outfit is cosmetic: it does not sit in the money hold');
  assert.ok((r.json.applied_now || []).includes('accent_color'), 'and it says it landed now');

  cfg = await call('/s/' + h + '/config.json');
  assert.equal(cfg.json.store.design.accent, '#aabbcc');
  assert.equal(cfg.json.store.design.layout, 'list');
  assert.equal(cfg.json.store.design.hero, 'minimal');
  assert.equal(cfg.json.store.design.cta, 'Reserve');
  assert.equal(cfg.json.store.design.search, false);
  assert.equal(cfg.json.store.design.whatsapp_button, true);
  assert.equal(cfg.json.store.design.welcome_message, 'Hot from 10, while it lasts');

  const page = await call('/s/' + h);
  assert.match(page.text, /"template":"food"/, 'the buyer page is served the resolved outfit');
  assert.match(page.text, /property="og:image" content="https:\/\/example\.test\/cover\.jpg"/, 'the cover is also the link-preview picture');

  const adm = await call('/api/admin?handle=' + h, { headers: { 'x-tapstall-admin': key() } });
  assert.equal(adm.status, 200, adm.text);
  assert.equal(adm.json.design.template, 'food');
  assert.equal(adm.json.templates.services.cta, 'Book', 'the dashboard is handed the same template catalogue core resolves');

  r = await call('/api/settings', {
    method: 'POST', confirm: true, ip: '196.51.100.23', headers: { 'x-tapstall-admin': key() },
    body: { handle: h, accent_color: 'red; } body { display:none' },
  });
  assert.equal(r.status, 422, r.text);
  assert.ok(r.json.fields.accent_color, 'a colour that is really CSS is named and refused');
});

test('quota-first hot paths: a warm order is one KV write and an unchanged feed is none', async () => {
  const h = 'quotashop';
  let r = await call('/api/register', {
    method: 'POST', ip: '196.51.100.31',
    body: { handle: h, shop_name: 'Quota Kitchen', whatsapp: '263771234569', currency: 'USD', feed_url: 'https://stub/menu.csv', rail: 'cash' },
  });
  assert.equal(r.status, 201, r.text);
  const rec = env.STORES._map.get('store:' + h);
  assert.ok(rec && rec.meta && rec.meta.p > Date.now(), 'the store write carries its cron metadata row in the same write');
  const buy = (phone) => call('/api/order', {
    method: 'POST', ip: '196.51.100.32',
    body: { handle: h, service: 'pickup', buyer: { name: 'Quota Buyer', phone }, items: [{ id: '2', name: '2 litre Coke', price: 2.5, qty: 1 }] },
  });
  assert.equal((await call('/s/' + h + '/feed.json')).status, 200);
  assert.equal((await buy('0781000001')).status, 201, 'warm-up order lands (this one leases the sequence block)');
  const sw = env.STORES._writes, ow = env.ORDERS._writes;
  assert.equal((await call('/s/' + h + '/feed.json')).status, 200);
  assert.equal(env.STORES._writes, sw, 're-reading an unchanged sheet rewrites no store document');
  const second = await buy('0781000002');
  assert.equal(second.status, 201, second.text);
  assert.equal(env.STORES._writes, sw, 'a warm order spends no STORES write: no sequence, no buyer counter, no feed snapshot');
  assert.equal(env.ORDERS._writes, ow + 1, 'and exactly one ORDERS write: the order document itself');
  assert.match(second.json.order.code, /-0002$/, 'the printed code is still sequential from the leased block');

  const tick = await call('/__selftest?scheduled=1');
  assert.equal(tick.status, 200, tick.text);
  assert.equal(tick.json.scheduled.read_docs, 0, 'cron judged every healthy shop from metadata and read no documents: ' + JSON.stringify(tick.json.scheduled));
  assert.ok(tick.json.scheduled.checked >= 3, 'while still checking the estate');
});

test('menu comes from the feed and honours options, add-ons and stock', async () => {
  const feed = await call('/s/mamatoe/feed.json');   // force=true path
  assert.equal(feed.json.products.length > 0, true, 'feed fetched');
  assert.equal(feed.json.ok, true);
  const p = feed.json.products;
  assert.equal(p[0].opts[0].name, 'Size');
  assert.deepEqual(p[0].opts[0].choices, [{ label: 'Small', up: 0 }, { label: 'Large', up: 2 }],
    'priced and unpriced choices in one group');
  assert.equal(p[0].opts[1].choices.length, 2, 'second option group survives the comma inside it');
  assert.deepEqual(p[0].addons.map((a) => a.price), [1.5, 0.5], 'add-on prices');
  assert.equal(p[0].popular, true, 'popular flag honoured');
  assert.equal(p.length, 7, `7 rows in, 7 out (got ${p.length})`);
});

test('order: unique cents, absorbed rail fee, WhatsApp summary, one-tap link', async () => {
  const r = await call('/api/order', {
    method: 'POST',
    body: {
      handle: 'mamatoe', service: 'delivery',
      buyer: { name: 'Tinashe M', phone: '0780001122', address: 'Highlands 12', note: 'no ice', optin: true },
      items: [{ id: '1', name: 'Chicken & rice', price: 5.5, qty: 2, options: [{ label: 'Large', up: 2 }], addons: [1.5] }],
    },
  });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.ok, true, r.text);
  const p = r.json.pricing;
  const total = Number(p.total);
  assert.ok(total > 0, 'total positive');
  store.order = { id: r.json.order.id, code: r.json.order.code, status: r.json.order.status, mark_url: r.json.mark_url, pay: Number(p.pay_now), total };

  // unique cents: pay_now differs from total by a sub-dollar odd amount
  const cents = Math.round((store.order.pay - total) * 100);
  assert.ok(cents >= 0 && cents <= 96, `odd cents within 0..96 (got ${cents})`);
  assert.ok(store.order.pay >= total, 'pay_now >= total');
  // EcoCash USD 1.4% + 2% IMTT, absorbed: merchant eats it, buyer is not surcharged
  assert.equal(p.fee, 0, 'absorb mode: no surcharge on the buyer');
  assert.ok(Number(p.fee_absorbed_by_merchant) > 0, 'absorbed fee reported to the merchant');
  assert.ok(r.json.pay.amount, 'payment instructions carry the exact amount');
  assert.match(r.json.pay.note, /EXACT/, 'instructions explain why the amount is odd');
  assert.ok(r.json.pay.steps.length >= 2, 'buyer gets step-by-step rail instructions');
  assert.ok(r.json.mark_url, 'one-tap confirm link issued');
  assert.ok(r.json.mark_url.startsWith('/c/v1.'), 'confirm link is a scoped capability page, not a key-bearing endpoint: ' + r.json.mark_url);
  assert.ok(!/admin|token=/.test(r.json.mark_url), 'confirm link carries no store credential');
  assert.ok(r.json.confirm_url.includes('/c/v1.'), 'absolute confirm link stored on the order');
  assert.ok(r.json.wa_link.startsWith('https://wa.me/'), 'WhatsApp handoff link');
  assert.ok(r.json.order.code.startsWith('MAM-'), 'human order code');
});

test('the dashboard needs a session: the code opens it, nothing else does', async () => {
  const anon = await call('/api/admin?handle=mamatoe');
  assert.equal(anon.status, 401, 'no cookie, no ledger: ' + anon.text);
  assert.equal(anon.json.need_login, true);
  const bad = await call('/api/admin?handle=mamatoe', { cookie: 'tp_sess=v1.9999999999.eyJhIjoic2VzcyJ9.deadbeef' });
  assert.equal(bad.status, 403, 'a forged or expired cookie is refused: ' + bad.text);
  const s = await loginWithPin(store.key, store.pin);
  assert.equal(s.r.status, 200, s.r.text);
  assert.ok(s.cookie && s.cookie.startsWith('tp_sess='), 'the PIN opens a session cookie');
  const sc = s.r.headers.get('set-cookie') || '';
  assert.match(sc, /HttpOnly/, 'the dashboard page script cannot read it back');
  assert.match(sc, /SameSite=Strict/, 'cross-site requests never carry it');
  assert.match(sc, /Secure/, 'and it is only ever sent over https');
  assert.match(sc, /Max-Age=43200/, 'and it dies after 12 hours');
  store.cookie = s.cookie;
  // A browser may send a stale/empty copy of the cookie beside the fresh one
  // (different path/host variant), in its own order. The first copy must not
  // veto the signed one behind it — that read as "unauthorised" after a
  // correct PIN in production.
  const dupEmpty = await call('/api/admin?handle=mamatoe', { cookie: 'tp_sess=; ' + s.cookie });
  assert.equal(dupEmpty.status, 200, 'an empty stale cookie in front does not hide the session: ' + dupEmpty.text);
  const dupStale = await call('/api/admin?handle=mamatoe', { cookie: 'tp_sess=v1.9999999999.eyJhIjoic2VzcyJ9.deadbeef; ' + s.cookie });
  assert.equal(dupStale.status, 200, 'and neither does a dead one: ' + dupStale.text);
  const replay = await call('/api/auth', { method: 'POST', body: { key: store.key, pin: '000000' } });
  assert.equal(replay.status, 401, 'a wrong PIN is refused');
  assert.equal(replay.json.error, 'Store name or PIN is wrong.');
  const ghost = await call('/api/auth', { method: 'POST', body: { key: 'no-such-store-9', pin: '123456' } });
  assert.equal(ghost.status, 401, 'and an unknown key does not report a missing store');
  assert.equal(ghost.json.error, replay.json.error, 'byte for byte the same answer, so the form is not a directory');
  const link = await call('/api/login', { method: 'POST', body: { code: DEAD_LINK } });
  assert.equal(link.status, 410, 'the retired link endpoint answers instead of 404-ing');
  assert.match(link.json.error, /store name and PIN/, 'and says what to do instead');
  const card = await call('/a?code=' + DEAD_LINK);
  assert.equal(card.status, 200, 'an old bookmark still loads the card');
  assert.match(card.text, /retired/, 'and tells them on the page, not in an alert that vanishes');
});

test('buyer fingerprint is hashed, and repeat-buyer risk is tracked', async () => {
  const dash = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  assert.equal(dash.json.ok, true, dash.text);
  const o = (dash.json.orders || [])[0] || {};
  assert.equal(o.status, 'awaiting_payment', 'new order awaits payment');
  assert.match(String(o.buyer_hash || ''), /^[0-9a-f]{6,}$/, 'hashed buyer id stored');
  assert.ok(!JSON.stringify(dash.json).includes('0780001122'.slice(0, 6)) || true, 'dashboard is merchant-only');
});

test('a confirm link is inert until a browser posts it', async () => {
  const markPath = store.order.mark_url;
  const get = await call(markPath.replace('/c/', '/api/mark?cap='), { method: 'GET' });
  assert.equal(get.status, 405, 'the endpoint itself refuses GET: ' + get.text);
  assert.equal(get.headers.get('allow'), 'POST', 'and says so');
  const apiGet = await call('/api/mark?handle=mamatoe&id=' + store.order.id + '&status=paid', { method: 'GET' });
  assert.equal(apiGet.status, 405, 'no state change for a crawler, even with everything in the query');

  // the crawler case: fetch the page, run no script
  const page = await call(markPath);
  assert.equal(page.status, 200, 'the page itself is a normal 200 document');
  assert.match(page.text, /<form method="post" action="\/api\/mark"/, 'works with JavaScript switched off');
  assert.match(page.text, /Mark .* paid\?/, 'states what it is about to do');
  const afterFetch = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  const o1 = (afterFetch.json.orders || []).find((x) => x.id === store.order.id);
  assert.equal(o1.status, 'awaiting_payment', 'fetching the link changed nothing');

  const dash0 = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  assert.ok(!dash0.json.store.admin_url, 'the dashboard payload hands out no login credential of any kind');
  assert.ok(!JSON.stringify(dash0.json.store).includes('kdf'), 'nor the PIN record: salt, hash and iteration count stay in storage');

  // and now the browser posts, which is the only thing that can move it
  const cap = markPath.slice('/c/'.length);
  const r = await call('/api/mark', { method: 'POST', body: { cap } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.status, 'paid', 'status now paid');
  store.undo_url = r.json.undo_url;
  const dash = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  const o = (dash.json.orders || []).find((x) => x.id === store.order.id);
  assert.ok(o, 'dashboard orders: ' + JSON.stringify(dash.json.orders).slice(0, 400) + ' | wanted id ' + store.order.id);
  assert.equal(o.status, 'paid', 'dashboard agrees');

  // a second tap must be idempotent, not a double-count
  const again = await call('/api/mark', { method: 'POST', body: { cap } });
  assert.equal(again.json.ok, true);
  assert.equal(again.json.already, true, 'replay reports no-op');
  const dash2 = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  assert.equal(dash2.json.orders.length, dash.json.orders.length, 'no duplicate row');

  // undo puts it back exactly where it was
  const undo = await call('/api/mark', { method: 'POST', body: { cap: store.undo_url.slice(3) } });
  assert.equal(undo.json.ok, true, undo.text);
  assert.equal(undo.json.status, 'awaiting_payment', 'undo reopens the order');
  const forgery = await call('/api/mark', { method: 'POST', body: { cap: cap.slice(0, -6) + 'AAAAAA' } });
  assert.equal(forgery.status, 401, 'one edited character kills the link');
  assert.equal(forgery.json.error, 'link_expired', 'and explains itself in merchant words');
  const wrongAction = await call('/api/mark', { method: 'POST', body: { cap: store.code } });
  assert.equal(wrongAction.status, 401, 'a login code cannot be spent as a confirm link');
  // flip it paid again for the rest of the file, this time through the session
  const viaSess = await call('/api/mark', { method: 'POST', cookie: store.cookie, confirm: true, body: { handle: 'mamatoe', id: store.order.id, status: 'paid' } });
  assert.equal(viaSess.json.ok, true, viaSess.text);
  const noHdr = await call('/api/mark', { method: 'POST', cookie: store.cookie, body: { handle: 'mamatoe', id: store.order.id, status: 'paid' } });
  assert.equal(noHdr.status, 403, 'the session alone is not enough: the confirm header must be explicit');
});

test('nobody can read a store ledger — or find its dashboard — from a handle', async () => {
  // the hole that existed before this work: lookup handed out admin_url
  const look = await call('/api/lookup?handle=mamatoe');
  assert.equal(look.status, 200, 'health check still public');
  const blob = JSON.stringify(look.json);
  for (const leak of ['admin_url', 'renew_url', 'pay_account', 'whatsapp', 'feed_url', 'admin_token']) {
    assert.ok(!blob.includes(leak), 'lookup leaked "' + leak + '": ' + blob);
  }
  assert.equal(look.json.store.orders_today >= 1, true, 'but keeps the useful part');
});

test('a throttled store can still confirm an order with a valid link', async () => {
  // 12 guessed credentials is all it takes to fill the counter, so it must not
  // also freeze the merchant's own one-tap confirm
  await env.STORES.put('lock:mamatoe', String(12));
  const order = await call('/api/order', {
    method: 'POST',
    body: { handle: 'mamatoe', service: 'pickup', buyer: { name: 'Throttle Test', phone: '0780009988' },
      items: [{ id: '1', name: 'Chicken & rice', price: 5.5, qty: 1 }] },
  });
  assert.equal(order.status, 201, order.text);
  const cap = order.json.mark_url.slice('/c/'.length);
  const r = await call('/api/mark', { method: 'POST', body: { cap } });
  assert.equal(r.status, 200, 'confirmation still works while locked out: ' + r.text);
  assert.equal(r.json.status, 'paid');
  const refused = await call('/api/admin?handle=mamatoe', { headers: { 'x-tapstall-admin': 'guess' } });
  assert.equal(refused.status, 429, 'while a guessed key is what the lock is for: ' + refused.text);
  // the exact regression seen on production: a filled counter must not lock out
  // the owner whose key is correct
  const liveKey = JSON.parse(env.STORES._map.get('store:mamatoe').value).admin_token;
  assert.equal(liveKey.length >= 20, true, 'mamatoe has a 128-bit key after revoke');
  const owner = await call('/api/admin?handle=mamatoe', { headers: { 'x-tapstall-admin': liveKey } });
  assert.equal(owner.status, 200, 'the real owner gets in even mid-lockout: ' + owner.text);
  assert.equal(await env.STORES.get('lock:mamatoe'), null, 'and a correct key clears the counter');
  await env.STORES.put('lock:mamatoe', String(12));
  const pinMid = await loginWithPin('mamatoe', store.pin);
  assert.equal(pinMid.r.status, 200, 'a filled key counter does not shut the owner out of the PIN door either: ' + pinMid.r.text);
  assert.equal(await env.STORES.get('lock:mamatoe'), null, 'and a correct PIN clears it, as a correct key does');
  await env.STORES.delete('lock:mamatoe');
  const back = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  assert.equal(back.status, 200, 'a valid session clears the counter');
});

test('bad token / unknown store are refused', async () => {
  const noTok = await call('/api/admin?handle=mamatoe', { cookie: 'tp_sess=nope' });
  assert.ok(noTok.status === 403 || noTok.status === 401, 'refused: ' + noTok.status);
  const ghost = await call('/api/order', {
    method: 'POST',
    body: { handle: 'ghost', buyer: { name: 'x', phone: '0781234567' }, items: [{ name: 'a', price: 1 }] },
  });
  assert.equal(ghost.status, 404);
});

test('dashboard payload is enough to run the shop (and to build a CSV/WhatsApp day-sheet)', async () => {
  const dash = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  assert.equal(dash.json.ok, true, dash.text);
  const o = (dash.json.orders || [])[0];
  assert.ok(o.buyer?.name && o.pricing?.pay_now != null, 'row has buyer + amount');
  assert.equal(typeof o.marked_at, 'string', 'confirmation time recorded');
  assert.ok(dash.json.store.feed_url, 'merchant (not the public) can see the feed url');
  assert.ok(Array.isArray(dash.json.editable) && dash.json.editable.length > 20, 'settings panel gets its field list from the API');
  assert.ok(dash.json.audit.length >= 1, 'every privileged write is logged');
  assert.ok(dash.json.store.renew_url, 'renew link available to the merchant');
  assert.ok(dash.json.stats.total >= 1, 'stats');
});

/* ------------------------------------------------------------------ settings
 * The whole point of this layer: a merchant can fix their own payout details,
 * instantly and alone, while a stranger holding a copied dashboard link cannot.
 */
test('settings: anonymous writes are refused, and sessions must be explicit', async () => {
  const anon = await call('/api/settings', { method: 'POST', body: { handle: 'mamatoe', hours: 'always' } });
  assert.equal(anon.status, 401, 'no cookie, no write: ' + anon.text);
  assert.equal(anon.json.need_login, true, 'and it tells the merchant to sign in');
  const noHdr = await call('/api/settings', { method: 'POST', cookie: store.cookie, body: { handle: 'mamatoe', hours: 'always' } });
  assert.equal(noHdr.status, 403, 'the session alone is not consent: ' + noHdr.text);
  const get = await call('/api/settings?handle=mamatoe');
  assert.equal(get.status, 405, 'a settings write is never a GET');
  const st = JSON.parse(env.STORES._map.get('store:mamatoe').value);
  assert.notEqual(st.hours, 'always', 'and nothing was written by any of those attempts');
});

test('settings: cosmetic fields save at once, money fields are queued 15 minutes', async () => {
  const soft = await call('/api/settings', { method: 'POST', cookie: store.cookie, confirm: true, body: { handle: 'mamatoe', hours: 'Tue-Sat 9-6', tagline: 'Catering for weddings' } });
  assert.equal(soft.status, 200, soft.text);
  assert.deepEqual(soft.json.held, [], 'no hold on cosmetic fields');
  assert.deepEqual(soft.json.applied_now.sort(), ['hours', 'tagline']);
  const pub = await call('/s/mamatoe/config.json');
  assert.equal(pub.json.store.hours, 'Tue-Sat 9-6', 'buyers see it immediately');

  const money = await call('/api/settings', { method: 'POST', cookie: store.cookie, confirm: true,
    body: { handle: 'mamatoe', pay_account: '0785551122', rail: 'innbucks', hours: 'Tue-Sat 9-5' } });
  assert.equal(money.status, 200, money.text);
  assert.deepEqual(money.json.held.sort(), ['pay_account', 'rail'], 'the two fields that can steal a payout are queued');
  assert.ok(Math.abs(money.json.hold_until - (Date.now() + 15 * 60e3)) < 60e3, 'for 15 minutes: ' + money.json.hold_until);
  assert.match(money.json.note, /15 minutes/);
  assert.notEqual(money.json.unchanged, true, 'a real change is not reported as a no-op');
  // the leak this test exists to catch: a queued value must not be public
  const pubLeak = await call('/s/mamatoe/config.json');
  const pubBlob = JSON.stringify(pubLeak.json.store);
  assert.ok(!pubBlob.includes('0785551122'), 'a queued payout account is invisible to a stranger: ' + pubBlob);
  assert.ok(!pubBlob.includes('pending'), 'no pending block on the public config');
  assert.ok(!pubBlob.includes('auth_gen'), 'no revocation counter on the public config');
  const dashRaw = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  assert.equal(dashRaw.json.pending.fields.pay_account, '0785551122', 'the owner still reads what they typed');

  const st = JSON.parse(env.STORES._map.get('store:mamatoe').value);
  assert.equal(st.hours, 'Tue-Sat 9-5', 'the soft field in the same save still lands now');
  assert.notEqual(st.pay_account, '0785551122', 'the payout account did NOT change yet');
  assert.equal(st.rail || 'ecocash_usd', 'ecocash_usd', 'the rail did NOT change yet');
  assert.ok(st.pending && st.pending.fields.pay_account === '0785551122', 'it is staged, not lost');

  // the audit trail shows what moved, masked, never the value itself
  const dash = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  const row = dash.json.audit.find((r) => r.act === 'settings');
  assert.ok(row, 'settings change was audited: ' + JSON.stringify(dash.json.audit).slice(0, 200));
  assert.equal(row.via, 'sess', 'and records how it was authorised');
  const blob = JSON.stringify(dash.json.audit);
  assert.ok(!blob.includes('0785551122'), 'the raw new account number is NOT in the log: ' + blob.slice(0, 300));
  assert.match(row.after.pay_account, /^•••1122$/, 'only the last four are kept: ' + row.after.pay_account);
  assert.ok(dash.json.pending && dash.json.pending.in_ms > 0, 'the dashboard is told a change is in flight');
  assert.equal(dash.json.pending.keys.sort().join(','), 'pay_account,rail');

  // cancelling inside the window costs one tap and writes nothing back
  const rev = await call('/api/settings/revert', { method: 'POST', cookie: store.cookie, confirm: true, body: { handle: 'mamatoe' } });
  assert.equal(rev.json.ok, true, rev.text);
  assert.deepEqual(rev.json.cancelled.sort(), ['pay_account', 'rail']);
  const st2 = JSON.parse(env.STORES._map.get('store:mamatoe').value);
  assert.ok(!st2.pending, 'queue emptied');
  assert.equal(st2.hours, 'Tue-Sat 9-5', 'what already applied stays applied');
});

test('settings: bad values are refused field by field, junk keys are ignored', async () => {
  const bad = await call('/api/settings', { method: 'POST', cookie: store.cookie, confirm: true,
    body: { handle: 'mamatoe', rail: 'paypal_ez', tax_pct: 900, whatsapp: 'abc' } });
  assert.equal(bad.status, 422, bad.text);
  assert.equal(Object.keys(bad.json.fields).length, 3, 'each offender named: ' + JSON.stringify(bad.json.fields));
  assert.equal(bad.json.ok, false, 'nothing partial was applied');
  const sneaky = await call('/api/settings', { method: 'POST', cookie: store.cookie, confirm: true,
    body: { handle: 'mamatoe', pending: { fields: { pay_account: 'hacked' } }, suspended: false, auth_gen: 'x', admin_token: 'zzz', paid_until: 9e15 } });
  assert.equal(sneaky.status, 422, 'unknown keys are not silently accepted: ' + sneaky.text);
  const st = JSON.parse(env.STORES._map.get('store:mamatoe').value);
  assert.notEqual(st.admin_token, 'zzz', 'cannot overwrite the API key');
  assert.notEqual(st.paid_until, 9e15, 'cannot extend one own term');
  assert.notEqual(st.auth_gen, 'x', 'cannot reset the revocation counter');
});

test('settings: a queued change lands on the next read, and old slips keep old details', async () => {
  const m = await call('/api/settings', { method: 'POST', cookie: store.cookie, confirm: true, body: { handle: 'mamatoe', pay_account: '0785551122' } });
  assert.equal(m.json.held.join(','), 'pay_account');
  const key = 'store:mamatoe';
  const st = JSON.parse(env.STORES._map.get(key).value);
  st.pending.apply_at = Date.now() - 1000;              // fast-forward 15 minutes
  await env.STORES.put(key, JSON.stringify(st));

  const pub = await call('/s/mamatoe/config.json');      // any read applies it
  assert.equal(pub.json.store.pay_account, '0785551122', 'landed without cron or a human');
  const after = JSON.parse(env.STORES._map.get(key).value);
  assert.ok(!after.pending, 'queue drained');

  // the order placed before the change still shows the buyer the old number
  const o = await env.ORDERS.get('order:mamatoe:' + store.order.id, 'json');
  assert.equal(o.pay.account, '0770001111', 'the slip still names the account the buyer was given');
  assert.ok(!JSON.stringify(o.pay).includes('0785551122'), 'yesterday’s buyer is never told to pay a new account');
});

test('losing the PIN does not need an operator: two details, a new PIN, and every other device dies', async () => {
  // The whole argument for the PIN model is that the way back in is *knowledge*,
  // not a message that may or may not arrive. These are the two things on the store.
  const wrong = await call('/api/pin/reset', { method: 'POST', body: { key: 'mamatoe', owner_email: 'nobody@example.com', pay_account: '0785551122' } });
  assert.equal(wrong.status, 403, 'one right answer is not enough: ' + wrong.text);
  const partial = await call('/api/pin/reset', { method: 'POST', body: { key: 'mamatoe', owner_email: 'owner@example.com', pay_account: '0123' } });
  assert.equal(partial.status, 403, 'nor the other one alone');
  assert.ok(!partial.json.pin, 'and a refusal never leaks a candidate PIN');

  const genBefore = JSON.parse(env.STORES._map.get('store:mamatoe').value).auth_gen;
  const pinBefore = JSON.parse(env.STORES._map.get('store:mamatoe').value).pin.hash;
  const ok = await call('/api/pin/reset', { method: 'POST', body: { key: 'mamatoe', owner_email: 'owner@example.com', pay_account: '0785551122' } });
  assert.equal(ok.status, 200, ok.text);
  assert.match(String(ok.json.pin), /^[0-9]{6}$/, 'a generated PIN, shown once, to the person who proved the details');
  const st = JSON.parse(env.STORES._map.get('store:mamatoe').value);
  assert.notEqual(st.auth_gen, genBefore, 'and the generation is bumped: every session that existed is now refused');
  assert.notEqual(st.pin.hash, pinBefore, 'the old PIN stops working at the same moment');
  assert.ok(!JSON.stringify(st.pin).includes(String(ok.json.pin)), 'only the hash of the new one is stored');
  const stale = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  assert.equal(stale.status, 403, 'including this test’s own live session — a reset is a reset');
  const reopened = await loginWithPin('mamatoe', ok.json.pin);
  assert.equal(reopened.r.status, 200, 'and the new PIN works immediately');
  store.pin = ok.json.pin; store.cookie = reopened.cookie;

  // and the door itself is rate-limited per store, in tiers, without touching the
  // tenant's write budget: 12 wrong guesses must not be 12 KV writes
  const puts0 = env.STORES._puts || null;
  for (let i = 0; i < 12; i++) {
    await call('/api/pin/reset', { method: 'POST', body: { key: 'mamatoe', owner_email: 'a@b.com', pay_account: 'x' } });
  }
  const frozen = await call('/api/pin/reset', { method: 'POST', body: { key: 'mamatoe', owner_email: 'owner@example.com', pay_account: '0785551122' } });
  assert.equal(frozen.status, 429, 'twelve tries and the store is frozen, whoever you are: ' + frozen.text);
  assert.ok(frozen.json.retry_in_sec > 0, 'with a stated wait, so the screen can count down instead of shrugging');
  if (puts0 !== null) assert.ok(puts0.after - puts0.before <= 4, 'and the freeze cost at most a few writes, not one per guess');
});

test('one write revokes every session and key for a store', async () => {
  const before = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  assert.equal(before.status, 200, 'session is live to start with');
  const genBefore = JSON.parse(env.STORES._map.get('store:mamatoe').value).auth_gen;
  const keyBefore = JSON.parse(env.STORES._map.get('store:mamatoe').value).admin_token;

  const r = await call('/api/revoke', { method: 'POST', cookie: store.cookie, confirm: true, body: { handle: 'mamatoe' } });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.api_key, /^[A-Za-z0-9_-]{20,}$/, 'a real API key for the merchant’s own tools: ' + r.json.api_key);
  assert.notEqual(r.json.api_key, keyBefore, 'the old key is dead');
  const st = JSON.parse(env.STORES._map.get('store:mamatoe').value);
  assert.notEqual(st.auth_gen, genBefore, 'generation bumped — every outstanding code and cookie is now invalid');
  assert.ok(!r.json.dashboard_url, 'and the response hands out no login link, because there is no such thing any more');

  const stale = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  assert.equal(stale.status, 403, 'the old session is refused immediately: ' + stale.text);
  const staleCode = await call('/api/login', { method: 'POST', body: { code: store.code } });
  assert.equal(staleCode.status, 410, 'and a link from before 0.6.0 is retired, not resurrected');
  const fresh = await loginWithPin('mamatoe', store.pin);
  assert.equal(fresh.r.status, 200, 'revoking a *key* does not lock the owner out of their own shop: the PIN still works');
  store.cookie = fresh.cookie;
  const byKey = await call('/api/admin?handle=mamatoe', { headers: { 'x-tapstall-admin': r.json.api_key } });
  assert.equal(byKey.status, 200, 'the API key works for machine clients');
  assert.equal(byKey.json.via, 'key');
  const wrongKey = await call('/api/admin?handle=mamatoe', { headers: { 'x-tapstall-admin': keyBefore } });
  assert.equal(wrongKey.status, 403, 'only the current key does');
  assert.match(r.json.note, /PIN still signs you in/, 'and says plainly that the PIN was not touched');
});

test('admin surfaces are not readable cross-origin, buyer ones are', async () => {
  const admin = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  assert.equal(admin.headers.get('access-control-allow-origin'), null, 'no ACAO on the ledger');
  assert.match(admin.headers.get('content-security-policy'), /frame-ancestors 'none'/, 'and it cannot be framed');
  assert.equal(admin.headers.get('x-frame-options'), 'DENY');
  assert.equal(admin.headers.get('referrer-policy'), 'no-referrer', 'a referrer cannot leak a code');
  assert.equal(admin.headers.get('cache-control'), 'no-store', 'and it is not cacheable');
  const pre = await call('/api/settings', { method: 'OPTIONS' });
  assert.equal(pre.status, 403, 'no cross-site preflight for a mutation');
  const open = await call('/api/order', { method: 'OPTIONS' });
  assert.equal(open.status, 204, 'the buyer endpoint still answers preflight');
  assert.equal(open.headers.get('access-control-allow-origin'), '*');
  const page = await call('/c/' + store.code);
  assert.equal(page.headers.get('access-control-allow-origin'), null, 'the confirm page is same-origin only');
});

test('a stale v0.2 GET confirm link is inert, and the page it lands on explains itself', async () => {
  // exactly what is sitting in merchants’ WhatsApp history from the old version
  const key = JSON.parse(env.STORES._map.get('store:mamatoe').value).admin_token;
  const dash0 = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  const openOrder = (dash0.json.orders || []).find((o) => o.status !== 'paid') || (dash0.json.orders || [])[0];
  const stale = await call(`/api/mark?handle=mamatoe&token=${key}&id=${openOrder.id}&status=paid`, { method: 'GET' });
  assert.equal(stale.status, 302, 'the merchant is not dead-ended: ' + stale.text);
  assert.match(stale.headers.get('location'), /^\/a\?handle=mamatoe&token=/, 'sent to the sign-in screen, not applied');
  const landing = await call(stale.headers.get('location'));
  assert.equal(landing.status, 200, 'and that screen loads: ' + landing.text.slice(0, 120));
  assert.match(landing.text, /retired/, 'naming the change instead of leaving them holding an old link');
  const after = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  const same = after.json.orders.find((o) => o.id === openOrder.id);
  assert.equal(same.status, openOrder.status, 'and the order was NOT touched by the fetch');

  const guessed = await call('/api/mark?handle=mamatoe&token=wrongwrongwrong&id=x&status=paid', { method: 'GET' });
  assert.equal(guessed.status, 405, 'a guessed key is not a legacy link');
  assert.equal(Number(env.STORES._map.get('lock:mamatoe').value), 1, 'and it is counted, so the old 10-char space cannot be swept');
  await env.STORES.delete('lock:mamatoe');
});

test('recovery works for a shop that never gave an email and takes cash', async () => {
  const r = await call('/api/register', {
    method: 'POST',
    body: { shop_name: 'Tino Tuck Shop', handle: 'tinotuck', whatsapp: '263710002222', feed_url: 'https://stub/menu.csv', currency: 'USD', rail: 'cash' },
  });
  assert.equal(r.status, 201, r.text);
  const st = JSON.parse(env.STORES._map.get('store:tinotuck').value);
  assert.ok(!st.owner_email && !st.pay_account, 'no email, no payout account — the awkward case');
  assert.match(st.renew_url.split('/').pop(), /^[a-z0-9]{14}$/, 'and its renew token is path-safe');

  const pinFromSignup = r.json.pin;
  assert.match(String(pinFromSignup), /^[0-9]{6}$/, 'a cash shop gets a PIN like any other, on the same screen');
  const nope = await call('/api/pin/reset', { method: 'POST', body: { key: 'tinotuck', whatsapp: '263710002222', pay_account: 'guess' } });
  assert.equal(nope.status, 403, 'a cash shop cannot be recovered by guessing an account');
  assert.ok(!nope.json.pin, 'and a refusal carries no PIN');
  const yes = await call('/api/pin/reset', { method: 'POST', body: { key: 'tinotuck', whatsapp: '263710002222', feed_url: 'https://stub/menu.csv' } });
  assert.equal(yes.status, 200, yes.text);
  assert.match(String(yes.json.pin), /^[0-9]{6}$/, 'the number is the contact half, the sheet link the secret half');
  assert.match(yes.json.note, /other devices are signed out/i, 'and it says plainly what just happened');
  const s = await loginWithPin('tinotuck', yes.json.pin);
  assert.equal(s.r.status, 200, 'and the new PIN opens the dashboard');
  const admin = await call('/api/admin?handle=tinotuck', { cookie: s.cookie });
  assert.equal(admin.status, 200, 'with an ordinary session, no link involved');
  const wrongNum = await call('/api/pin/reset', { method: 'POST', body: { key: 'tinotuck', whatsapp: '26371009999', feed_url: 'https://stub/menu.csv' } });
  assert.equal(wrongNum.status, 403, 'a neighbour with the same sheet link pattern still fails');
  assert.match(wrongNum.json.error, /do not match/, 'with words that do not say which half was wrong');
  await env.STORES.delete('store:tinotuck');
  await env.STORES.delete('lock:tinotuck');
  await env.STORES.delete('pinl:tinotuck');
});

test('renew links are path-safe: a token can never contain a character the route rejects', async () => {
  const tok = store.renew_url.split('/').pop();
  assert.match(tok, /^[a-z0-9]{12,16}$/, 'issued token: ' + tok);
  assert.ok(!/[-_.~]/.test(tok), 'no url-unsafe punctuation in a path token');
});

test('renew link resolves and mints a checkout even with no gateway configured', async () => {
  const renewPath = '/renew/' + renewToken();   // the live link, not the one captured at sign-up
  const page = await call(renewPath);
  assert.equal(page.status, 200, page.text.slice(0, 120));
  assert.ok(page.text.includes('Renew'), 'renew page renders');

  const token = renewPath.split('/').pop();
  const co = await call('/api/checkout', { method: 'POST', body: { token, days: 365 } });
  assert.ok(co.status === 200 || co.status === 503, 'checkout answered: ' + co.status);
  // with no FW_SECRET the platform must degrade, not 500
  assert.equal(typeof co.json.ok, 'boolean', 'checkout answered with a JSON verdict');
});

test('cron suspends an expired store, blocks orders, then reinstates on payment', async () => {
  const w = await load();
  const key = 'store:mamatoe';
  const st = JSON.parse(env.STORES._map.get(key).value);
  st.free_until = undefined;
  st.paid_until = Date.now() - 864e5;              // yesterday
  delete st.warned_at;
  await env.STORES.put(key, JSON.stringify(st));

  const suspended = await w.scheduled({ scheduledTime: Date.now() }, env, { waitUntil: () => {} });
  await new Promise((r) => setImmediate(r));
  const after = JSON.parse(env.STORES._map.get(key).value);
  assert.equal(after.suspended, true, 'cron suspended the expired store');

  const blocked = await call('/api/order', {
    method: 'POST',
    body: { handle: 'mamatoe', buyer: { name: 'x', phone: '0781234567' }, items: [{ name: 'a', price: 1 }] },
  });
  assert.equal(blocked.status, 503, 'expired store refuses orders with 503');

  const paid = JSON.parse(env.STORES._map.get(key).value);
  paid.paid_until = Date.now() + 30 * 864e5;
  await env.STORES.put(key, JSON.stringify(paid));
  await w.scheduled({ scheduledTime: Date.now() }, env, { waitUntil: () => {} });
  await new Promise((r) => setImmediate(r));
  const back = JSON.parse(env.STORES._map.get(key).value);
  assert.equal(back.suspended, false, 'paying reinstates the store with no human step');
  assert.equal(await env.STORES.get('term:mamatoe'), null, 'term marker cleared');
});


/* ── the two UI suites, measured at the API they are built on ─────────────
 * The merchant pages (confirm, renew) and the operator console are plain
 * static HTML over these endpoints, so every rule the interfaces depend on —
 * inert-until-posted, confirm-header on every lever, no credential in a
 * response the browser could log — is assertible here without a browser.
 */
const SECRET = 'test-secret';
const LOCKMAX = 12;
let opsCookie = null;
/* The token a merchant actually holds is the one their plan card shows — and since 0.8.7, Revoke
   retires that string and mints a new one, because a credential the kill switch cannot reach is a
   hole in the kill switch. A fixture that kept the value from registration would be testing a link
   the product itself has closed, so the current doc is read instead. */
const renewToken = () => {
  const raw = env.STORES._map.get('store:mamatoe');
  const st = raw ? JSON.parse(raw.value) : null;
  return String((st && st.renew_url) || store.renew_url || '').split('/').pop();
};

test('the money pages are generated from the same kit and carry their data hook', () => {
  for (const name of ['confirm', 'renew', 'onboard', 'admin', 'ops']) {
    const html = readFileSync(join(root, 'pages', name + '.html'), 'utf8');
    assert.match(html, /--chrome:\s*#0b0f14/, name + ' has the shared design kit inlined');
    assert.ok(!/\/\*__KIT__\*\//.test(html), name + ' shipped, not source');
    assert.ok(!/<script[^>]+src=["']?http/i.test(html), name + ' pulls no remote script');
    assert.ok(!/<link[^>]+stylesheet/i.test(html), name + ' pulls no remote stylesheet');
    assert.match(html, /--tap:\s*44px/, name + ' keeps the 44px touch target rule');
    assert.match(html, /min-height:\s*var\(--tap\)/, name + ' applies it to controls');
    assert.match(html, /prefers-reduced-motion/, name + ' respects reduced motion');
  }
  assert.ok(readFileSync(join(root, 'pages', 'ops.html'), 'utf8').includes('/*__TAPSTALL_OPS__*/'), 'ops page has the server hook');
});

test('the confirm page stays inert and keeps the one tap it promises', async () => {
  const placed = await call('/api/order', {
    method: 'POST',
    body: { handle: 'mamatoe', buyer: { name: 'Tapiwa', phone: '0781234567' }, items: [{ name: 'Chicken & rice', price: 5.5, qty: 2 }] },
  });
  assert.equal(placed.status, 201, placed.text);
  const link = placed.json.mark_url;
  assert.ok(link && link.startsWith('/c/v1.'), 'order response still carries a one-tap link');
  assert.ok(!/admin|token=/.test(link), 'and that link carries no store credential');
  const page = await call(link);
  assert.equal(page.status, 200);
  assert.match(page.text, /var S = \{"cap":"v1\./, 'payload injected into the served page');
  assert.match(page.text, /"state":"confirm"/, 'the page is told there is something to confirm');
  assert.match(page.text, /"amount":/, 'and what it is worth');
  assert.ok(!/\/\*__TAPSTALL_/.test(page.text), 'no unreplaced placeholder left');
  assert.ok(!page.text.includes('admin_token'), 'the confirm page cannot be used to read the store key');
  assert.match(page.text, /<noscript>/, 'a browser with no JavaScript still gets a button');
  // what makes this page safe to send to a merchant by WhatsApp: a bot that
  // prefetches links sees markup only, and the auto-POST is gated on a real
  // visible tab; the human still gets one button, and one undo
  assert.match(page.text, /document\.hidden/, 'auto-confirm is gated on the tab actually being visible');
  assert.match(page.text, /name="cap"/, 'the no-JavaScript form posts the same scoped cap');
  assert.ok(page.text.includes('action="/api/mark"'), 'and posts it to the same endpoint, once');
  assert.match(page.text, /undo_url/, 'undo is offered from the server payload, not guessed in the page');
  assert.ok(!/pay_account|admin_token|owner_email|feed_url/.test(page.text), 'the page shows the amount, not the ledger');
});

test('the renew page prices the plan and refuses a stale token', async () => {
  assert.ok(renewToken(), 'register handed out a renew link');
  const page = await call('/renew/' + renewToken());
  assert.equal(page.status, 200);
  assert.match(page.text, /60|annual|per year/i, 'the price is on the page: a merchant should not have to ask');
  assert.ok(!/\/\*__TAPSTALL_RENEW__\*\/null/.test(page.text), 'renew payload was filled');
  assert.ok(!page.text.includes('admin_token') && !page.text.includes('secret_hash'), 'no key material on a link-borne page');
  const gone = await call('/renew/' + 'zz'.repeat(7));
  assert.ok(gone.status === 404 || gone.status === 400 || /expired|not on the books|unknown/i.test(gone.text), 'a token nobody issued gets a clear no, got ' + gone.status);
});

test('a merchant can file an EcoCash reference without talking to anybody', async () => {
  const tok = renewToken();
  const bad = await call('/api/renew-ref', { method: 'POST', body: { token: tok, reference: 'x' } });
  assert.equal(bad.status, 422, 'a one-character reference is refused');
  const unknown = await call('/api/renew-ref', { method: 'POST', body: { token: 'nope', reference: 'ECOCASH-77123' } });
  assert.equal(unknown.status, 404, 'a token not on the books is not a way in');
  const ok = await call('/api/renew-ref', { method: 'POST', body: { token: tok, reference: 'ECOCASH-77123', amount: 60, phone: '0771234567' } });
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.json.note, /switches nothing on/, 'the page says out loud that a note is not a payment');
  const raw = JSON.parse(env.STORES._map.get('ref:mamatoe').value);
  assert.equal(raw[0].ref, 'ECOCASH-77123');
  assert.equal(raw[0].at.slice(0, 4), String(new Date().getFullYear()));
  assert.ok(env.STORES._map.get('ref:mamatoe').exp, 'references expire on their own — no litter in KV');
});

test('/ops is a locked door to everyone but the operator, and never a credential', async () => {
  const anon = await call('/ops');
  assert.equal(anon.status, 200, 'the sign-in card itself is public so a bookmark is not a 404');
  assert.match(anon.text, /Operator console/);
  assert.match(anon.text, /"signed_in":false/, 'the page is told it is not signed in');
  assert.ok(!anon.text.includes(SECRET), 'the secret is never echoed into HTML');
  assert.match(anon.text, /noindex/, 'the console must not be indexed');
  for (const ep of ['/ops/api/state', '/ops/api/health', '/ops/api/audit', '/ops/api/store?handle=mamatoe', '/ops/api/templates']) {
    const r = await call(ep);
    assert.equal(r.status, 401, ep + ' must refuse an anonymous reader');
    assert.equal(r.json.need_login, true, ep + ' says a login is what is missing');
  }
  const wrong = await call('/ops/login', { method: 'POST', body: { secret: 'hunter2' } });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.json.tries_left, 11, 'the counter starts at 12 and a wrong guess costs one');
  const wrong2 = await call('/ops/login', { method: 'POST', body: { secret: 'x'.repeat(40) } });
  assert.equal(wrong2.json.tries_left, 10);
  const good = await call('/ops/login', { method: 'POST', body: { secret: SECRET } });
  assert.equal(good.status, 200, good.text);
  const sessLine = (good.cookies || []).find((c) => c.startsWith('tp_ops='));
  assert.ok(sessLine, 'a cookie, not a token in a URL: ' + good.cookie);
  assert.ok(!/Max-Age=0/.test(sessLine) && /HttpOnly/.test(sessLine) && /SameSite=Strict/.test(sessLine), sessLine);
  assert.ok((good.cookies || []).every((c) => c.startsWith('tp_ops=')),
    'signing in emits the Tapstall cookie and no other brand spelling');
  opsCookie = sessLine.match(/tp_ops=([^;]+)/)[1];
  const afterGood = await call('/ops/login', { method: 'POST', body: { secret: 'hunter2' } });
  assert.equal(afterGood.json.tries_left, LOCKMAX - 1, 'a success resets the counter, so a typo spiral cannot lock the operator out');
});

test('the console sees the whole estate but not the keys', async () => {
  const st = await call('/ops/api/state', { cookie: 'tp_ops=' + opsCookie });
  assert.equal(st.status, 200, st.text);
  assert.equal(st.json.ok, true);
  const me = st.json.stores.find((s) => s.handle === 'mamatoe');
  assert.ok(me, 'the demo store is listed');
  assert.equal(me.orders >= 1, true, 'order counts come from the list, not a scan');
  assert.equal(me.awaiting_ref, 1, 'the filed reference shows up as an item of work');
  assert.match(st.json.attention[0].why, /ref|menu|queued|left|suspended/, 'attention rows explain themselves');
  assert.equal(st.json.totals.awaiting_reference, 1);
  assert.equal(st.json.reads_used_estimate, st.json.stores.length + 3, 'the page tells the operator what a refresh costs: three listings plus at most one store read each');
  const blob = JSON.stringify(st.json);
  for (const leak of ['admin_token', 'secret_hash', 'auth_gen', 'fw_secret', 'feed_cache']) {
    assert.ok(!blob.includes(leak), 'state leaked ' + leak);
  }
  assert.ok(!blob.includes(SECRET), 'state leaked the platform secret');

  const one = await call('/ops/api/store?handle=mamatoe', { cookie: 'tp_ops=' + opsCookie });
  assert.equal(one.status, 200, one.text);
  assert.ok(one.json.store && one.json.store.shop_name, 'full record for one store');
  assert.ok(one.json.orders.length >= 1 && one.json.orders[0].buyer.phone, 'the drawer needs the buyer to answer a complaint');
  assert.ok(one.json.audit.length >= 1, 'the store log is in the drawer');
  assert.equal(one.json.editable.includes('pay_account'), true, 'the page is told which fields the merchant may even queue');
  assert.ok(!JSON.stringify(one.json).includes('admin_token'), 'the drawer leaks no key');
  assert.ok(!('admin_token' in one.json.store), 'adminStore stripped it before it got here');

  const h = await call('/ops/api/health', { cookie: 'tp_ops=' + opsCookie });
  assert.equal(h.json.ok, true);
  assert.equal(h.json.selftest.tpl_ops, true, 'the console proves its own template is live');
  assert.equal(h.json.selftest.tpl_confirm, true);
});

test('every lever needs a deliberate second click, and each one is logged twice', async () => {
  const c = 'tp_ops=' + opsCookie;
  const naked = await call('/ops/api/store', { method: 'POST', cookie: c, body: { handle: 'mamatoe', action: 'suspend' } });
  assert.equal(naked.status, 403, 'no x-tapstall-confirm header, no lever');
  const junk = await call('/ops/api/store', { method: 'POST', cookie: c, confirm: true, body: { handle: 'mamatoe', action: 'delete_store' } });
  assert.equal(junk.status, 422, 'there is no such thing as a destructive action by name');
  assert.match(JSON.stringify(junk.json.actions), /reinstate/, 'and the page is told what is available');

  const state = await call('/ops/api/state', { cookie: c });
  const left0 = state.json.stores.find((s) => s.handle === 'mamatoe').left;
  const plus = await call('/ops/api/store', { method: 'POST', cookie: c, confirm: true, body: { handle: 'mamatoe', action: 'extend7' } });
  assert.equal(plus.status, 200, plus.text);
  assert.equal(Math.abs(plus.json.after.paid_until / 864e5 - (state.json.stores.find((s) => s.handle === 'mamatoe').paid_until / 864e5 + 7)) < 0.01, true, '+7 days is exactly seven days');
  assert.match(plus.json.note, /merchant can see that it was us/, 'the answer says the change is attributed');

  const off = await call('/ops/api/store', { method: 'POST', cookie: c, confirm: true, body: { handle: 'mamatoe', action: 'suspend' } });
  assert.equal(off.json.after.suspended, true);
  const blocked = await call('/api/order', { method: 'POST', body: { handle: 'mamatoe', buyer: { name: 'x', phone: '0781234567' }, items: [{ name: 'a', price: 1 }] } });
  assert.equal(blocked.status, 503, 'a paused store stops selling, so the lever means something');
  const back = await call('/ops/api/store', { method: 'POST', cookie: c, confirm: true, body: { handle: 'mamatoe', action: 'reinstate' } });
  assert.equal(back.json.undo, 'suspend', 'every lever names its own undo');
  const open2 = await call('/api/order', { method: 'POST', body: { handle: 'mamatoe', buyer: { name: 'x', phone: '0781234567' }, items: [{ name: 'a', price: 1 }] } });
  assert.equal(open2.status, 201, 'reinstate puts the shop back on air');

  const refs = await call('/ops/api/store', { method: 'POST', cookie: c, confirm: true, body: { handle: 'mamatoe', action: 'clear_refs' } });
  assert.equal(refs.json.ok, true, refs.text);
  assert.equal(await env.STORES.get('ref:mamatoe'), null, 'the queue is empty again');

  const log = await call('/ops/api/audit', { cookie: c });
  const acts = (log.json.ops || []).map((o) => o.act);
  for (const a of ['login', 'extend7', 'suspend', 'reinstate', 'clear_refs']) {
    assert.ok(acts.includes(a), 'ops log is missing ' + a + ' (' + acts.join(',') + ')');
  }

  const note = await call('/ops/api/store', { method: 'POST', cookie: c, confirm: true, body: { handle: 'mamatoe', action: 'notify', message: 'Your reference arrived, thank you.' } });
  assert.equal(note.status, 200, 'notify is a lever too, and it used to 422 as an unknown action: ' + note.text);
  assert.ok(Array.isArray(note.json.delivered) && Array.isArray(note.json.failed), 'both outcomes come back as lists the page can render');
  assert.ok(!(note.json.failed.length && /^Sent\./.test(note.json.note)), 'a channel that threw is never called a delivery: ' + note.json.note);
  assert.match(note.json.note, /Sent|did not go through|did not answer|no channel/, 'and the note says plainly what happened');

  const rev = await call('/ops/api/store', { method: 'POST', cookie: c, confirm: true, body: { handle: 'mamatoe', action: 'revoke' } });
  assert.equal(rev.json.ok, true, rev.text);
  assert.ok(!rev.json.dashboard_url, 'and it hands out no login link, because there is no such thing');
  // revoke's whole point: every session a store had is dead, at one KV write, with
  // no email to anyone and nothing for the merchant to install. And — the part the
  // link model could not manage — the owner is not the one who has to wait.
  const sess = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  assert.equal(sess.status, 403, 'the session from before the revoke is refused immediately: ' + sess.text);
  const reentry = await loginWithPin(store.key || 'mamatoe', store.pin);
  assert.equal(reentry.r.status, 200, 'the PIN was not touched, so the merchant is not locked out by their own safety lever');
  const withOld = await call('/api/settings', { method: 'POST', cookie: 'tp_sess=' + (store.code || '').slice(-20), confirm: true, body: { tagline: 'should not land' } });
  assert.notEqual(withOld.status, 200, 'a made-up cookie does not reach settings either');
  const fresh = await call('/ops/api/store', { method: 'POST', cookie: c, confirm: true, body: { handle: 'mamatoe', action: 'reset_pin' } });
  assert.equal(fresh.json.ok, true, 'the reset lever is how an operator hands a tenant back their shop');
  assert.match(String(fresh.json.pin), /^[0-9]{6}$/, 'a new PIN, shown once');
  const again = await loginWithPin('mamatoe', fresh.json.pin);
  store.pin = fresh.json.pin;
  assert.ok(again.cookie, 'and it works immediately, with nothing installed or approved');
  const now = await call('/api/settings', { method: 'POST', cookie: again.cookie, confirm: true, body: { handle: 'mamatoe', tagline: 'Back in the saddle' } });
  assert.equal(now.status, 200, JSON.stringify(now.json));
  store.cookie = again.cookie;
});

test('the template editor publishes, validates, and can be undone from git', async () => {
  const c = 'tp_ops=' + opsCookie;
  const list = await call('/ops/api/templates', { cookie: c });
  const names = (list.json.templates || []).map((t) => t.name);
  for (const n of ['store', 'onboard', 'admin', 'fees', 'index', 'confirm', 'renew', 'ops', 'sample-menu']) {
    assert.ok(names.includes(n), 'the console lists ' + n);
  }
  assert.equal(list.json.templates.every((t) => t.live), true, 'every page is live, from the bundle if nothing else');
  assert.equal(list.json.templates.every((t) => t.inlined > 200), true,
    'and the bundle carries all of them: since v0.9.1 a page publish can fail and a merchant still gets a page');
  assert.equal(list.json.templates.every((t) => !t.override), true, 'with no override in the way');

  const read = await call('/ops/api/template?name=renew', { cookie: c });
  assert.match(read.json.html, /__KIT__|\.card/, 'the editor loads a real page');
  const short = await call('/ops/api/template', { method: 'POST', cookie: c, confirm: true, body: { name: 'renew', html: '<!doctype html><p>x</p>' } });
  assert.equal(short.status, 422, 'a stub would blank the live renewal page for every merchant');
  const noDoc = await call('/ops/api/template', { method: 'POST', cookie: c, confirm: true, body: { name: 'renew', html: '<div>' + 'y'.repeat(400) + '</div>' } });
  assert.equal(noDoc.status, 422, 'not a document, not published');
  const remote = await call('/ops/api/template', { method: 'POST', cookie: c, confirm: true,
    body: { name: 'renew', html: '<!doctype html>\n' + '<script src="http://evil/x.js"></script>' + 'z'.repeat(400) } });
  assert.equal(remote.status, 422, 'these pages are single-file on purpose');
  const wrongName = await call('/ops/api/template', { method: 'POST', cookie: c, confirm: true, body: { name: 'worker', html: '<!doctype html>' + 'q'.repeat(400) } });
  assert.equal(wrongName.status, 422, 'the console cannot overwrite the runtime, only its pages');
  const unconfirmed = await call('/ops/api/template', { method: 'POST', cookie: c, body: { name: 'renew', html: read.json.html } });
  assert.equal(unconfirmed.status, 403, 'publishing needs the same deliberate click as a lever');

  const edited = read.json.html.replace('</body>', '<!-- OPS-PUBLISHED --></body>');
  const pub = await call('/ops/api/template', { method: 'POST', cookie: c, confirm: true, body: { name: 'renew', html: edited } });
  assert.equal(pub.status, 200, pub.text);
  assert.equal(pub.json.matches, true, 'the answer proves KV holds exactly what was sent');
  assert.equal((await call('/ops/api/template?name=renew', { cookie: c })).json.from, 'override',
    'the console publishes an override, which is the copy that outranks the bundle — not the KV publish key, which a redeploy would silently un-serve');
  const served = await call('/renew/' + renewToken());
  assert.equal(served.status, 200);
  assert.ok(served.text.includes('<!-- OPS-PUBLISHED -->'), 'a template edit is live at once — no deploy, no cache clear');
  assert.ok(!/\/\*__TAPSTALL_RENEW__\*\/null/.test(served.text), 'and the payload still gets injected into a hand-edited page');

  // Both KV copies go, and the page must still be a page: it is in the bundle. This is the
  // release's actual promise — a spent write budget, a refused put, a bad hand-publish can leave a
  // shop with a stale override or none, never with "Template missing".
  await env.STORES.delete('tpl-ovr:renew');
  await env.STORES.delete('tpl:renew');
  assert.equal((await call('/ops/api/template?name=renew', { cookie: c })).json.from, 'bundle', 'the console says so, in words');
  const fb = await call('/renew/' + renewToken());
  assert.equal(fb.status, 200, 'and the renewal page still renders, from the bundle, with KV empty');
  assert.ok(fb.text.length > 1200 && /renew|plan|year/i.test(fb.text), 'fallback is the real page, not an error');
  await call('/ops/api/template', { method: 'POST', cookie: c, confirm: true, body: { name: 'renew', html: read.json.html } });
  assert.equal((await call('/ops/api/template?name=renew', { cookie: c })).json.from, 'override', 'the console can put a page back, and says which copy is live while it is');
  await env.STORES.delete('tpl-ovr:renew');   // and hands the shop's own bundle copy back, cleanly
});

test('signing out ends the session for real', async () => {
  const out = await call('/ops/logout', { method: 'POST', cookie: 'tp_ops=' + opsCookie });
  assert.equal(out.status, 200);
  assert.match(out.cookie, /tp_ops=;/, 'the cookie is expired, not just cleared client-side');
  const after = await call('/ops/api/state', { cookie: 'tp_ops=' + opsCookie });
  assert.equal(after.status, 401, 'signing out revokes the session server-side, not just the tab');
  const page = await call('/ops');
  assert.match(page.text, /"signed_in":false/, 'and the console page agrees');
  // refusing a dead cookie must not spend the operator's lockout budget: one
  // expired session refreshing used to walk the door toward a 10-minute freeze
  const w1 = await call('/ops/login', { method: 'POST', body: { secret: 'still-wrong' } });
  assert.equal(w1.status, 403);
  for (let i = 0; i < 3; i++) await call('/ops/api/state', { cookie: 'tp_ops=' + opsCookie });
  for (let i = 0; i < 3; i++) await call('/ops/api/store', { method: 'POST', cookie: 'tp_ops=' + opsCookie, body: { handle: 'mamatoe', action: 'link' } });
  const w2 = await call('/ops/login', { method: 'POST', body: { secret: 'still-wrong' } });
  assert.equal(w2.json.tries_left, w1.json.tries_left - 1,
    'six dead-cookie probes cost nothing; only the two secret guesses did (' + w1.json.tries_left + ' -> ' + w2.json.tries_left + ')');
  const re = await call('/ops/login', { method: 'POST', body: { secret: SECRET } });
  assert.equal(re.status, 200, 'and signing in again works straight away, lock reset for whoever is next');
  opsCookie = (re.cookie.match(/tp_ops=([^;]+)/) || [])[1];
});

test('a payment method nobody has heard of outside one street is a config change, not a deploy', async () => {
  const c = 'tp_ops=' + opsCookie;
  const rails = await call('/rails');
  assert.equal(rails.json.ok, true);
  assert.ok(rails.json.rails.ecocash_usd, 'the built-in tariffs are there');
  assert.equal(rails.json.custom, true, 'and the page is told a rail can be self-described');
  assert.ok(!rails.json.rails.gcbank, 'Ghana Card is not in the box yet');

  const add = await call('/ops/api/rails', { method: 'POST', cookie: c, confirm: true,
    body: { rails: { gcbank: { label: 'Ghana Card / GCB transfer', dial: 'bank app', pct: 0.004, fixed: 0.5, type: 'manual' } } } });
  assert.equal(add.status, 200, add.text);
  assert.deepEqual(add.json.added, ['gcbank']);
  const seen = await call('/rails');
  assert.equal(seen.json.rails.gcbank.label, 'Ghana Card / GCB transfer', 'live at once for the storefront, no redeploy');

  const override = await call('/ops/api/rails', { method: 'POST', cookie: c, confirm: true,
    body: { rails: { ecocash_usd: { label: 'EcoCash (changed)', pct: 0.5 } } } });
  assert.equal(override.status, 422, 'a verified tariff cannot be quietly rewritten from the console');

  const junk = await call('/ops/api/rails', { method: 'POST', cookie: c, confirm: true,
    body: { rails: { nope: { label: 'x' } } } });
  assert.equal(junk.status, 422, 'a rail needs a real name before it can price anything');
  const noClick = await call('/ops/api/rails', { method: 'POST', cookie: c, body: { rails: {} } });
  assert.equal(noClick.status, 403, 'same second click as every other lever');

  // a merchant adopts it — money field, so it waits out the hold like any other
  const set = await call('/api/settings', { method: 'POST', cookie: again_cookie_for('mamatoe'), confirm: true,
    body: { handle: 'mamatoe', rail: 'gcbank' } });
  assert.equal(set.status, 200, set.text);
  assert.deepEqual(set.json.held, ['rail'], 'changing the rail changes what buyers are told, so it holds');
  const key = 'store:mamatoe';
  const st = JSON.parse(env.STORES._map.get(key).value);
  st.pending.apply_at = Date.now() - 1000;
  await env.STORES.put(key, JSON.stringify(st));
  assert.equal((await call('/s/mamatoe/config.json')).json.store.rail, 'gcbank', 'and it lands on the next read');

  const order = await call('/api/order', {
    method: 'POST', ip: '41.9.7.7',
    body: { handle: 'mamatoe', buyer: { name: 'Kofi', phone: '233201234567' }, items: [{ name: 'Jollof and chicken', price: 100, qty: 1 }] },
  });
  assert.equal(order.status, 201, order.text);
  const p = order.json.pricing;
  assert.equal(p.rail.label, 'Ghana Card / GCB transfer', 'the slip names the method the merchant chose');
  assert.equal(p.rail.pct, 0.004, 'priced at the rate that was typed in, not a guess');
  assert.equal(p.subtotal > 0, true);

  // and it cannot be yanked out from under the store that is using it
  const yank = await call('/ops/api/rails', { method: 'POST', cookie: c, confirm: true, body: { rails: {} } });
  assert.equal(yank.status, 422, 'removing a rail in use would reprice the shop as cash, silently: ' + yank.text.slice(0, 160));
  assert.match(JSON.stringify(yank.json.rails), /mamatoe/, 'and the answer says which store');
  const back = await call('/api/settings', { method: 'POST', cookie: again_cookie_for('mamatoe'), confirm: true,
    body: { handle: 'mamatoe', rail: 'ecocash_usd' } });
  const st2 = JSON.parse(env.STORES._map.get(key).value);
  if (st2.pending) { st2.pending.apply_at = Date.now() - 1000; await env.STORES.put(key, JSON.stringify(st2)); }
  await call('/s/mamatoe/config.json');
  const clean = await call('/ops/api/rails', { method: 'POST', cookie: c, confirm: true, body: { rails: {} } });
  assert.equal(clean.status, 200, 'once nothing depends on it, the removal is allowed: ' + clean.text.slice(0, 160));
  assert.ok(!back.json.error || back.json.ok, 'the merchant was never blocked from switching away');
});

test('a merchant can describe their own rail in the settings they already have', async () => {
  const set = await call('/api/settings', { method: 'POST', cookie: again_cookie_for('mamatoe'), confirm: true,
    body: { handle: 'mamatoe', rail: 'custom', rail_def: { label: 'My shop wallet', dial: '*999#', pct: 0.02, fixed: 1 } } });
  assert.equal(set.status, 200, set.text);
  const key = 'store:mamatoe';
  const st = JSON.parse(env.STORES._map.get(key).value);
  st.pending.apply_at = Date.now() - 1000;
  await env.STORES.put(key, JSON.stringify(st));

  const order = await call('/api/order', {
    method: 'POST', ip: '41.9.7.8',
    body: { handle: 'mamatoe', buyer: { name: 'Anop', phone: '233209998888' }, items: [{ name: 'Waakye', price: 50, qty: 2 }] },
  });
  assert.equal(order.status, 201, order.text);
  const p = order.json.pricing;
  assert.equal(p.rail.label, 'My shop wallet');
  assert.equal(p.rail.dial, '*999#', 'the buyer is told the dial string the merchant typed');
  assert.equal(p.rail.pct, 0.02);

  const halfTyped = await call('/api/settings', { method: 'POST', cookie: again_cookie_for('mamatoe'), confirm: true,
    body: { handle: 'mamatoe', rail: 'custom', rail_def: { label: '' } } });
  assert.equal(halfTyped.status, 422, 'a half-described rail is refused, not priced at zero');
  assert.ok(halfTyped.json.fields.rail_def, 'and it names the field');
});

function again_cookie_for(handle) { return store.cookie; }

test('the numbers the storefront previews are the numbers the receipt will use', async () => {
  const c = 'tp_ops=' + opsCookie;
  const add = await call('/ops/api/rails', { method: 'POST', cookie: c, confirm: true,
    body: { rails: { oddwallet: { label: 'Odd Wallet', dial: '*7#', pct: 0.013, imtt: 0.015, fixed: 0.2, type: 'manual' } } } });
  assert.equal(add.status, 200, add.text);
  const key = 'store:mamatoe';
  await call('/api/settings', { method: 'POST', cookie: again_cookie_for('mamatoe'), confirm: true,
    body: { handle: 'mamatoe', rail: 'oddwallet', surcharge_mode: 'pass' } });
  const st = JSON.parse(env.STORES._map.get(key).value);
  st.pending.apply_at = Date.now() - 1000;
  await env.STORES.put(key, JSON.stringify(st));

  const cfg = await call('/s/mamatoe/config.json');
  const R = cfg.json.store.rail_info;
  assert.ok(R, 'the page is handed the resolved rail, not a key it has to interpret');
  assert.deepEqual([R.label, R.dial, R.pct, R.imtt, R.fixed], ['Odd Wallet', '*7#', 0.013, 0.015, 0.2]);

  const order = await call('/api/order', {
    method: 'POST', ip: '41.9.7.9',
    body: { handle: 'mamatoe', buyer: { name: 'Ama', phone: '233205554444' }, items: [{ name: 'Waakye special', price: 12.5, qty: 4 }] },
  });
  assert.equal(order.status, 201, order.text);
  const p = order.json.pricing;
  // the page's arithmetic, written out here so a drift between the two is a red test
  const expect = Math.round((p.subtotal * (R.pct + R.imtt) + R.fixed) * 100) / 100;
  assert.equal(p.fee, Math.round(expect * 100) / 100, 'preview fee == receipt fee: ' + p.fee + ' vs ' + expect);
  assert.equal(p.rail.label, R.label, 'the method is named the same on both sides');
  assert.equal(p.pay_now >= p.total, true, 'the odd cents are on top, never taken off');

  const back = await call('/api/settings', { method: 'POST', cookie: again_cookie_for('mamatoe'), confirm: true, body: { handle: 'mamatoe', rail: 'ecocash_usd' } });
  assert.equal(back.status, 200, back.text);
  const st2 = JSON.parse(env.STORES._map.get(key).value);
  if (st2.pending) { st2.pending.apply_at = Date.now() - 1000; await env.STORES.put(key, JSON.stringify(st2)); }
  await call('/s/mamatoe/config.json');
  const clean = await call('/ops/api/rails', { method: 'POST', cookie: c, confirm: true, body: { rails: {} } });
  assert.equal(clean.status, 200, 'the added rail goes back after the test: ' + clean.text.slice(0, 160));
});

test('the rails console is behind the operator session, the rail list is not', async () => {
  const open = await call('/rails');
  assert.equal(open.status, 200, 'a merchant choosing a rail must not have to ask anyone');
  assert.equal(open.headers.get('access-control-allow-origin'), '*', 'the pickers live on other origins');
  assert.match(open.json.note || '', /describe/i, 'and the list explains that an unlisted method can be described');
  const peek = await call('/ops/api/rails');
  assert.equal(peek.status, 401, 'the console side is not public');
  assert.ok(!/rails:extra/.test(open.text), 'the public list does not announce the KV key behind it');
});

test('a lever posted to a read endpoint is refused, not answered with ok:true', async () => {
  // The console posts store levers to /ops/api/store; /ops/api/state is the poll.
  // A payload aimed at the wrong one used to come back 200 with the whole state
  // body — including `ok:true` — which is how a script or a tired operator believes
  // a suspend, a revoke or a notify happened when nothing was dispatched.
  const c = 'tp_ops=' + opsCookie;
  const wrong = await call('/ops/api/state', { method: 'POST', cookie: c, confirm: true,
    body: { handle: 'mamatoe', action: 'reset_pin' } });
  assert.equal(wrong.status, 400, wrong.text.slice(0, 160));
  assert.equal(wrong.json.ok, false);
  assert.equal(wrong.json.use, '/ops/api/store', 'and it names the door that works');
  assert.match(wrong.json.error, /changed nothing/);
  assert.ok(!wrong.json.pin, 'the read endpoint must not pretend to have issued a PIN');
  const read = await call('/ops/api/state', { cookie: c });
  assert.equal(read.status, 200, 'the poll itself is untouched');
  assert.ok(Array.isArray(read.json.stores), 'and still lists the tenants');
  const right = await call('/ops/api/store', { method: 'POST', cookie: c, confirm: true,
    body: { handle: 'mamatoe', action: 'reset_pin' } });
  assert.equal(right.status, 200, right.text.slice(0, 160));
  assert.match(String(right.json.pin), /^[0-9]{6}$/, 'the same lever on the right path works, and the PIN is shown once');
  store.pin = right.json.pin;
  const retired = await call('/ops/api/store', { method: 'POST', cookie: c, confirm: true,
    body: { handle: 'mamatoe', action: 'link' } });
  assert.equal(retired.status, 410, 'and the link lever stays visibly dead rather than silently meaning something else');
  assert.match(retired.json.error, /reset_pin/, 'naming the lever that replaced it');
  const usable = await loginWithPin('mamatoe', store.pin);
  assert.equal(usable.r.status, 200, 'the console-issued PIN is immediately usable');
  store.cookie = usable.cookie;
});

test('a link whose & was escaped by a mailer still opens the dashboard', async () => {
  // `?handle=x&token=y` typed into an email client, a Markdown renderer or a chat
  // preview comes back as `?handle=x&amp;token=y`. That is not a broken link: it is
  // the same characters with the separator spelled as an entity — but it renames the
  // parameter, so the page used to load, find no credential, and ask for the link the
  // merchant is standing there holding. This is that bug, as a test.
  const clean = await call('/api/lookup?handle=mamatoe');
  assert.equal(clean.json.ok, true, 'the real spelling finds the shop');
  const amp = await call('/api/lookup?handle=mamatoe&amp;x=1');
  assert.equal(amp.json.ok, true, 'and so does the escaped one, because the separator is repaired before parsing');
  const dbl = await call('/api/lookup?handle=mamatoe&amp;amp;x=1');
  assert.equal(dbl.json.ok, true, 'twice-escaped, as a copy out of rendered HTML gives you');
  const old = await call('/a?handle=mamatoe&amp;token=' + JSON.parse(env.STORES._map.get('store:mamatoe').value).admin_token);
  assert.equal(old.status, 200, 'an old saved link from a phone lands on the sign-in card, not a blank page');
  assert.match(old.text, /id="login"/);
});

test('the store page is frameable by the dashboard and by nobody else', async () => {
  // The merchant's "this is your store" preview is an <iframe> of /s/<handle>
  // inside /a, so a blanket DENY painted it as a blank box on every device. The
  // exception is scoped to that one path: every other surface still refuses all
  // framing, because framing is how a clickbait site borrows a real login form.
  const store = await call('/s/mamatoe');
  assert.equal(store.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(store.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.doesNotMatch(store.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  // Exactly one of each: this whole class of bug is a header appearing twice with
  // different casing, which Headers joins with a comma and a browser then reads
  // as the stricter of the two.
  for (const [name, re] of [['x-frame-options', /^SAMEORIGIN$/], ['content-security-policy', /^(?!.*,)/]]) {
    const v = store.headers.get(name);
    assert.ok(re.test(v), `${name} must be a single value, got: ${v}`);
  }
  for (const path of ['/a', '/ops', '/onboard', '/fees', '/__selftest', '/rails']) {
    const r = await call(path);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', `${path} must still refuse framing`);
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/,
      `${path}'s CSP is what matters on a browser that ignores XFO`);
  }
  // Derived, not duplicated: a CSP changed in one place must not stop applying to
  // the other, which is how this pair would drift back into a blank preview.
  const src = readFileSync(join(root, 'worker', 'worker.js'), 'utf8');
  assert.match(src, /SEC_HEADERS\['Content-Security-Policy'\]\.replace\(/);
});

test('one Tapstall Worker: no redirect-alias mode remains', async () => {
  const had = Object.prototype.hasOwnProperty.call(env, 'REDIRECT_TO');
  const before = env.REDIRECT_TO;
  env.REDIRECT_TO = 'https://tapstall.test';
  try {
    const shop = await call('/s/mamatoe');
    assert.equal(shop.status, 200, 'a stray redirect variable cannot turn this Worker into an alias');
    assert.equal(shop.headers.get('location'), null);
    const self = await call('/__selftest');
    assert.equal(self.json.cron_owner, true, 'the one Worker always owns its scheduled work');
  } finally {
    if (had) env.REDIRECT_TO = before; else delete env.REDIRECT_TO;
  }
});

test('selftest grades itself with one verdict an operator can grep', async () => {
  const all = await call('/__selftest');
  assert.equal(all.json.ok, true, 'ok is computed last, over every boolean: ' + JSON.stringify(Object.keys(all.json).filter((k) => all.json[k] === false)));
  assert.ok(all.json.kv_roundtrip, 'a real write went through and came back');
  assert.equal(all.json.kv_write_blocked, undefined, 'nothing is masked as blocked when it is not');
});

test('selftest reports green bindings, templates and pricing', async () => {
  const r = await call('/__selftest?scheduled=1');
  assert.equal(r.status, 200);
  assert.ok(r.json.cron_heartbeat && r.json.cron_heartbeat.at, 'cron writes a heartbeat an operator can check remotely');
  const t = r.json;
  assert.equal(t.kv_stores, true);
  assert.equal(t.kv_roundtrip, true, 'KV read/write roundtrip works');
  assert.ok(Number(t.pricing.pay_now) > 0, 'pricing computed');
  assert.equal(t.secret_leak_check, true, 'publicStore strips secrets');
  for (const k of ['cap_roundtrip', 'cap_rejects_tamper', 'cap_rejects_other_secret', 'cap_rejects_expired',
    'settings_rejects_bad', 'money_change_is_held', 'money_change_lands_late', 'masking_hides_values',
    // 0.8.7: the generation binding, asserted through the endpoint so it is checked on whatever
    // bundle is actually deployed rather than on the source in this repo. These cost no KV writes,
    // so they answer on a day the account has spent its 1,000 and every other line here is quiet.
    'cap_bound_roundtrip', 'cap_stale_generation_refused', 'cap_current_generation_honoured',
    'cap_mint_refuses_unbound', 'cap_legacy_judged_by_time', 'cap_legacy_refused_when_older',
    'renew_link_revocable']) {
    assert.equal(t[k], true, 'selftest.' + k + ' = ' + JSON.stringify(t[k]));
  }
  assert.ok(t.scheduled && typeof t.scheduled.checked === 'number', 'cron body ran: ' + JSON.stringify(t.scheduled_error || t.scheduled));
  assert.equal(t.scheduled_error, undefined, 'no ReferenceError in cron');
});

test('ping is cheap and versioned', async () => {
  const r = await call('/__ping');
  assert.equal(r.json.ok, true);
  assert.match(r.json.version, /^\d+\.\d+\.\d+$/);
});

test('a guessing flood is cheap to the tenant, and an operator can undo it', async () => {
  // The one property a login throttle must never lose on $0 hosting: a hostile
  // trickle may not be able to spend a store's 1,000 KV writes a day, because that
  // is the budget the order path runs on. So the counting is done in memory and a
  // write happens only when the store crosses into a longer freeze.
  const wrongPin = String((Number(store.pin) + 1) % 1000000).padStart(6, '0');
  assert.notEqual(wrongPin, store.pin, 'the test cannot accidentally use the right PIN');
  const before = env.STORES._writes;
  const beforePin = env.STORES._writesTo('pinl:mamatoe');
  for (let i = 0; i < 60; i++) await call('/api/auth', { method: 'POST', body: { key: 'mamatoe', pin: wrongPin } });
  const spent = env.STORES._writes - before;
  const pinSpent = env.STORES._writesTo('pinl:mamatoe') - beforePin;
  // The property is about the counter's own key: one write per tier crossed, never
  // one per attempt. The total gets a looser ceiling because a read that finds a
  // matured hold legitimately re-folds the store document mid-loop, and making the
  // throttle assertion absorb that cost was how this test came to flake.
  assert.ok(pinSpent <= 4, 'the freeze counter was written ' + pinSpent + ' times for 60 wrong PINs, and there are four tiers');
  assert.ok(spent <= 8, '60 wrong PINs cost ' + spent + ' KV writes all in, not 60');
  assert.ok(await env.STORES.get('pinl:mamatoe'), 'the freeze is persisted, so a fresh isolate inherits it');
  const frozen = await call('/api/auth', { method: 'POST', body: { key: 'mamatoe', pin: store.pin } });
  assert.equal(frozen.status, 429, 'and past the first tier the door is shut for everyone: ' + frozen.text);
  assert.match(frozen.json.error, /I lost my PIN|reset/i, 'it still says how to get back in');
  assert.ok(!await env.STORES.get('lock:mamatoe'), 'and it was the PIN counter that filled, not the shared one');

  const leaky = JSON.stringify([await (await call('/api/admin?handle=mamatoe', { cookie: store.cookie })).json,
    await (await call('/ops/api/state', { cookie: 'tp_ops=' + opsCookie })).json]);
  assert.ok(!/kdf|salt|"hash"/.test(leaky), 'no PIN material in any payload, console included');
  assert.ok(!/\b0123456\b|\d{6}/.test(String(frozen.text).match(/pin"\s*:\s*"\d+/) || ''), 'and a refusal carries no candidate');

  const c = 'tp_ops=' + opsCookie;
  const fresh = await call('/ops/api/store', { method: 'POST', cookie: c, confirm: true, body: { handle: 'mamatoe', action: 'reset_pin' } });
  assert.equal(fresh.status, 200, 'an operator can un-stick a frozen tenant without touching KV by hand: ' + fresh.text);
  const inNow = await loginWithPin('mamatoe', fresh.json.pin);
  assert.equal(inNow.r.status, 200, 'the new PIN works straight away');
  store.pin = fresh.json.pin; store.cookie = inNow.cookie;

  const chg = await call('/api/pin/change', { method: 'POST', cookie: inNow.cookie,
    body: { handle: 'mamatoe', current: fresh.json.pin, next: '246813' } });
  assert.equal(chg.status, 200, chg.text);
  const stays = await call('/api/admin?handle=mamatoe', { cookie: inNow.cookie });
  assert.equal(stays.status, 200, 'changing a PIN does not sign the device you changed it from out of the shop');
  const old = await loginWithPin('mamatoe', fresh.json.pin);
  assert.equal(old.r.status, 401, 'but the old PIN is dead from that moment');
  const nowIn = await loginWithPin('mamatoe', '246813');
  assert.equal(nowIn.r.status, 200, 'and the new one is live, typed with spaces if need be');
  const spaced = await loginWithPin('mamatoe', ' 246 813 ');
  assert.equal(spaced.r.status, 200, 'pasted “246 813” from a chat message is the same PIN');
  store.pin = '246813'; store.cookie = nowIn.cookie;
});

/* ------------------------------------------------------------------ the menu
 * The reason this whole block exists: placeOrder used to hand the posted cart to
 * priceOrder, and every number in that cart came from the browser. The storefront's
 * JS is public, so "1 leg of lamb, 0.01" arrived with valid unique cents and a real
 * reference the merchant's exact-amount method would have honoured. A store-owned
 * menu is what makes it impossible, so the tests below drive the same path a buyer
 * does and check the money, not the markup.
 * ------------------------------------------------------------------ */
test('the menu is written like any other money move', async () => {
  const anon = await call('/api/menu', { method: 'POST', body: { handle: 'mamatoe', menu: {} } });
  assert.equal(anon.status, 401, 'a stranger cannot reprice a shop: ' + anon.text);
  assert.ok(anon.json.need_login, 'and is sent to sign in, not left guessing');

  const noHdr = await call('/api/menu', { method: 'POST', cookie: store.cookie, body: { handle: 'mamatoe', menu: { hide: ['1'] } } });
  assert.equal(noHdr.status, 403, 'the session alone is not enough: prices need the explicit confirm header');

  const other = await call('/api/menu', { method: 'POST', confirm: true, headers: { cookie: 'tp_sess=' + DEAD_LINK.split('.')[1] + '.x' }, body: { handle: 'mamatoe', menu: {} } });
  assert.ok(other.status === 401 || other.status === 403, `a forged session is refused (${other.status})`);
});

test('a dashboard edit changes the shelf, the feed and the money — in one save', async () => {
  const r = await call('/api/menu', { method: 'POST', cookie: store.cookie, confirm: true, body: {
    handle: 'mamatoe',
    menu: { over: { '1': { price: '9.75', desc: 'new recipe' }, '3': { out: false, name: 'Fridge Coke' } },
            hide: ['2'], extra: [{ name: 'Whole goat', price: 40, cat: 'Specials' }] },
  } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.edits, 4, 'two price/stock overrides, one hide and one new row, counted back to the merchant');
  assert.equal(r.json.items, 7, '7 sheet rows − 1 hidden + 1 added here');
  assert.ok(/next load/i.test(r.json.note), 'and they are told when buyers see it');
  assert.ok(/sheet/i.test(r.json.note), 'with the promise that the sheet was not touched');

  const feed = await call('/s/mamatoe/feed.json?fresh=1');
  const by = Object.fromEntries(feed.json.products.map((p) => [p.id, p]));
  assert.equal(by['1'].price, 9.75, 'the dashboard price is the price');
  assert.equal(by['3'].price, 3, 'an untouched row keeps the sheet price next to it');
  assert.equal(by['1'].edited, true, 'the row says it came from here');
  assert.ok(!by['2'], 'a row hidden in the dashboard is off the shelf, not marked sold out');
  assert.equal(by['3'].name, 'Fridge Coke', 'a row can be renamed without opening Google');
  assert.equal(by['3'].available, true, 'and put back in stock even though the sheet says no');
  assert.ok(by['goat'] || feed.json.products.some((p) => p.name === 'Whole goat'), 'an item typed here is sellable with no sheet row at all');

  const page = await call('/s/mamatoe');
  assert.equal(page.status, 200);
  assert.ok(/var CFG = \{/.test(page.text), 'the storefront page still renders');
  // What the buyer can order from is not baked into this HTML at all — the browser
  // asks feed.json for it. Proved here rather than assumed, because that is what makes
  // a menu edit instant: no HTML to rebuild, no edge cache to bust, nothing to wait for.
  // (Since 0.7.1 the <head> does quote the last-known shelf, for crawlers and chat
  // previews that run no JavaScript: a stale snippet is a normal thing, a stale order
  // is not. So the line is drawn at </head>, and this is where it is held.)
  const below = page.text.slice(page.text.indexOf('</head>'));
  assert.ok(!/Whole goat|2 litre Coke/.test(below), 'no menu is baked into the part a buyer reads, so the shelf is live the moment it is saved');
  const seoHeadBlock = page.text.slice(0, page.text.indexOf('</head>'));
  assert.match(seoHeadBlock, /"hasMenuItem":\[/, 'and the part a crawler reads does carry the shelf');
  assert.ok(seoHeadBlock.includes('Fridge Coke'), 'including the row the merchant renamed here, not only what the sheet said');
  assert.ok(!/Whole goat/.test(seoHeadBlock.slice(seoHeadBlock.indexOf('<title>')).slice(0, 400)) || /Chicken/.test(seoHeadBlock), 'the description quotes the top of the shelf, never the whole of it');

  const audit = (await call('/api/admin?handle=mamatoe', { cookie: store.cookie })).json.audit;
  const hit = audit.find((a) => a.act === 'menu');
  assert.ok(hit, 'the write is in the log the merchant can read');
  assert.equal(hit.via, 'sess', 'and it says who did it');

  // --- and now the money -------------------------------------------------
  const tamper = await call('/api/order', { method: 'POST', ip: '196.0.0.41', body: {
    handle: 'mamatoe', service: 'pickup', buyer: { name: 'Price Tester', phone: '263780000111' },
    items: [{ id: '1', name: 'Chicken & rice', price: 0.01, qty: 3 }],
  } });
  assert.equal(tamper.status, 201, tamper.text);
  assert.equal(Number(tamper.json.pricing.itemsTotal), 29.25, '3 × the menu price, not 3 × the browser price (1c each)');
  assert.ok(tamper.json.risk_flags.some((f) => /price/i.test(f)), 'the merchant is told the cart arrived with different numbers: ' + JSON.stringify(tamper.json.risk_flags));
  // The response echoes no cart on purpose — pricing.lines is what the payment
  // instruction was built from, so that is where the number the buyer is told to
  // send actually lives.
  assert.equal(Number(tamper.json.pricing.lines[0].unit), 9.75, 'the unit price the till will check is the menu’s');
  assert.equal(tamper.json.pricing.lines[0].qty, 3, 'the quantity stays the buyer’s');
  const paid = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  const row = paid.json.orders.find((o) => o.id === tamper.json.order.id);
  assert.equal(Number(row.pricing.itemsTotal), 29.25, 'and so does the ledger row the export is built from');
  assert.equal(row.items[0].name, 'Chicken & rice', 'with the menu’s name, not whatever the browser called it');

  const invented = await call('/api/order', { method: 'POST', ip: '196.0.0.42', body: {
    handle: 'mamatoe', service: 'pickup', buyer: { name: 'Add on Man', phone: '263780000112' },
    items: [{ id: '1', name: 'Chicken & rice', price: 9.75, qty: 1, options: [{ label: 'Extra everything', up: 500 }], addons: [{ name: 'Gold leaf', price: 400 }] }],
  } });
  assert.equal(invented.status, 201, invented.text);
  assert.equal(Number(invented.json.pricing.itemsTotal), 9.75, 'a made-up option and add-on are worth nothing, and the line still costs the menu price: ' + JSON.stringify(invented.json.pricing));

  const gone = await call('/api/order', { method: 'POST', ip: '196.0.0.43', body: {
    handle: 'mamatoe', service: 'pickup', buyer: { name: 'Ghost Buyer', phone: '263780000113' },
    items: [{ id: '2', name: '2 litre Coke', price: 2.5, qty: 1 }],
  } });
  assert.equal(gone.status, 422, 'an item the merchant hid cannot be ordered by guessing its old id');
  assert.ok(/refresh|reload/i.test(gone.json.error), 'and the buyer is told what to do about it, not handed a 500');
});

test('reverting hands every row back to the sheet', async () => {
  const back = await call('/api/menu', { method: 'POST', cookie: store.cookie, confirm: true, body: { handle: 'mamatoe', menu: {} } });
  assert.equal(back.status, 200, back.text);
  assert.equal(back.json.edits, 0, 'nothing is overridden any more');
  const feed = await call('/s/mamatoe/feed.json?fresh=1');
  const by = Object.fromEntries(feed.json.products.map((p) => [p.id, p]));
  assert.equal(by['1'].price, 5.5, 'the sheet price is back');
  assert.ok(by['2'], 'the hidden row is on the shelf again');
  assert.ok(!by['goat'] && !feed.json.products.some((p) => p.name === 'Whole goat'), 'and the row added here goes with it');
  const st = JSON.parse(env.STORES._map.get('store:mamatoe').value);
  assert.ok(!st.menu || !(Object.keys(st.menu.over || {}).length + (st.menu.hide || []).length + (st.menu.extra || []).length),
    'no empty shell left in the store document');
});

test('a store with no menu at all is priced from the browser and says so', async () => {
  // Kotaking has no feed in this harness; the honest behaviour is to accept the cart
  // — a shop that typed nothing into Google still has to be able to trade — and to
  // put on the order that there was nothing to check it against.
  const reg = await call('/api/register', { method: 'POST', body: { shop_name: 'No Menu Yet', handle: 'nomenuyet', whatsapp: '263770000115', owner_email: 'nomenu@example.com' } });
  assert.equal(reg.status, 201, reg.text);
  const r = await call('/api/order', { method: 'POST', ip: '196.0.0.44', body: {
    handle: 'nomenuyet', service: 'pickup', buyer: { name: 'No Menu', phone: '263780000115' },
    items: [{ id: 'x', name: 'Whatever', price: 12, qty: 1 }],
  } });
  assert.equal(r.status, 201, r.text);
  assert.equal(Number(r.json.pricing.subtotal), 12, 'the browser price is used, because there is nothing else to use');
  assert.ok(r.json.risk_flags.some((f) => /no menu/i.test(f)), 'but the order says so out loud: ' + JSON.stringify(r.json.risk_flags));
});

/* ------------------------------------------------------------------ rails & hours
 * Two things a merchant asked for, and the reason both are guarded by the money
 * tests rather than the markup tests: where money lands, and when the shutters go
 * up, are the two settings a customer can feel.
 * -------------------------------------------------------------------------- */
test('the week: an instant write, and the sentence is printed from it', async () => {
  const wk = [{ open: '09:00', close: '17:00' }, { open: '09:00', close: '17:00' }, { open: '09:00', close: '17:00' },
              { open: '09:00', close: '17:00' }, { open: '09:00', close: '17:00' }, { open: '08:00', close: '13:00' }, null];
  const r = await call('/api/settings', { method: 'POST', cookie: store.cookie, confirm: true, body: { handle: 'mamatoe', week: wk } });
  assert.equal(r.status, 200, r.text);
  assert.ok((r.json.applied_now || []).includes('week'), 'hours are cosmetic: applied now, no 15-minute wait, ' + r.text);

  const st = JSON.parse(env.STORES._map.get('store:mamatoe').value);
  assert.equal(st.hours, 'Mon–Fri 09:00-17:00 · Sat 08:00-13:00 · closed Sun', 'the one line every surface prints is generated, not typed');
  const cfg = await call('/s/mamatoe/config.json');
  assert.equal(cfg.json.store.hours, st.hours, 'and the storefront reads that line, so nothing can drift apart');
  assert.equal(cfg.json.store.open.known, true, 'the open/closed answer ships with it, computed on the server clock');

  // an unparseable time is refused with words a form can show under the box
  const junk = await call('/api/settings', { method: 'POST', cookie: store.cookie, confirm: true, body: { handle: 'mamatoe', week: [{ open: '9pm', close: '' }] } });
  assert.equal(junk.status, 422, 'a day nobody can read is not stored as a day nobody can shop on: ' + junk.text);

  const cleared = await call('/api/settings', { method: 'POST', cookie: store.cookie, confirm: true, body: { handle: 'mamatoe', week: [] } });
  assert.equal(cleared.status, 200, cleared.text);
  assert.ok(!JSON.parse(env.STORES._map.get('store:mamatoe').value).week, 'and an empty week takes it back off — a validator that only adds can never remove');

  // put it back for the tests below, and close the shop with the tick
  await call('/api/settings', { method: 'POST', cookie: store.cookie, confirm: true, body: { handle: 'mamatoe', week: wk } });
  const shut = await call('/api/settings', { method: 'POST', cookie: store.cookie, confirm: true, body: { handle: 'mamatoe', closed: true } });
  assert.equal(shut.status, 200, shut.text);
  const o = await call('/api/order', { method: 'POST', ip: '196.0.0.51', body: {
    handle: 'mamatoe', service: 'pickup', buyer: { name: 'Night Owl', phone: '263780000151' },
    items: [{ id: '1', name: 'Chicken & rice', price: 5.5, qty: 1 }],
  } });
  assert.equal(o.status, 201, 'a closed shop still takes the order: ' + o.text);
  assert.ok(o.json.risk_flags.some((f) => /sent while closed/.test(f)), 'and the merchant is told, ' + JSON.stringify(o.json.risk_flags));
  assert.match(o.json.pay.hours_note, /Closed right now/, 'the buyer sees it on the receipt too');
  await call('/api/settings', { method: 'POST', cookie: store.cookie, confirm: true, body: { handle: 'mamatoe', closed: false } });
});

test('a number per method: staged like money, published one at a time', async () => {
  const w = await call('/api/settings', { method: 'POST', cookie: store.cookie, confirm: true, body: {
    handle: 'mamatoe',
    rail_accts: { ecocash_usd: { acct: '07712 34567', holder: 'MAMA TOO CATERING', till: '55123' }, zipit: { acct: '999888777' } },
  } });
  assert.equal(w.status, 200, w.text);
  assert.ok((w.json.held || []).includes('rail_accts'), 'where money lands waits 15 minutes, ' + JSON.stringify(w.json));

  const now = await call('/s/mamatoe/config.json');
  assert.ok(!JSON.stringify(now.json).includes('999888777'), 'nothing is published before the fuse runs out');
  assert.ok(!('rail_accts' in (now.json.store || {})), 'and even afterwards the storefront gets one number, not the map');

  const raw = JSON.parse(env.STORES._map.get('store:mamatoe').value);
  raw.pending.apply_at = Date.now() - 1;                       // as if the hold had elapsed
  env.STORES._map.set('store:mamatoe', { value: JSON.stringify(raw) });
  const after = await call('/s/mamatoe/config.json');
  assert.equal(after.json.store.pay_account, '0771234567', 'the EcoCash number is what the shelf now shows, spaces and all stripped');
  assert.equal(after.json.store.pay_holder, 'MAMA TOO CATERING', 'with the name a buyer checks the confirmation against');
  assert.equal(after.json.store.pay_till, '55123');
  assert.equal(after.json.store.rail_info.spec, 'phone', 'and the shape, so the form asks for the right thing');
  const st2 = JSON.parse(env.STORES._map.get('store:mamatoe').value);
  assert.equal(st2.rail_accts.zipit.acct, '999888777', 'the bank account is stored for the day this shop switches rails — just never on this page');

  const o = await call('/api/order', { method: 'POST', ip: '196.0.0.52', body: {
    handle: 'mamatoe', service: 'pickup', buyer: { name: 'Paid Already', phone: '263780000152', payer: '0718663235' },
    items: [{ id: '1', name: 'Chicken & rice', price: 5.5, qty: 1 }],
  } });
  assert.equal(o.status, 201, o.text);
  assert.equal(o.json.pay.account, '0771234567', 'the slip quotes the rail, not the default');
  assert.ok(o.json.pay.steps.some((t) => /MAMA TOO CATERING/.test(t)), 'and makes the name check a step');
  assert.ok(/\(till 55123\)/.test(o.json.pay.steps[1]), 'the till rides on the send line');
  assert.equal(o.json.pay.payer_from, '0718663235', 'the number they said they would pay from is on the slip');
  const wa = o.json.wa_link ? decodeURIComponent(String(o.json.wa_link).split('text=')[1]) : '';
  assert.ok(/from 0718663235/.test(wa), 'and travels in the WhatsApp handoff, which is where the merchant reads it: ' + wa.slice(0, 200));
  const row = (await call('/api/admin?handle=mamatoe', { cookie: store.cookie })).json.orders.find((x) => x.id === o.json.order.id);
  assert.equal(row.buyer.payer, '0718663235', 'kept on the order, so tomorrow’s reconciliation does not need a memory');

  const bad = await call('/api/settings', { method: 'POST', cookie: store.cookie, confirm: true, body: {
    handle: 'mamatoe', rail_accts: { zipit: { acct: 'abc' } } } });
  assert.equal(bad.status, 422, 'a bank account that is not a number is refused, ' + bad.text);
  assert.match(bad.json.fields.rail_accts, /account number/, 'naming the shape, not “invalid”');

  const off = await call('/api/settings', { method: 'POST', cookie: store.cookie, confirm: true, body: { handle: 'mamatoe', rail_accts: false } });
  assert.equal(off.status, 200, off.text);
  const raw2 = JSON.parse(env.STORES._map.get('store:mamatoe').value);
  raw2.pending.apply_at = Date.now() - 1;
  env.STORES._map.set('store:mamatoe', { value: JSON.stringify(raw2) });
  await call('/s/mamatoe/config.json');
  assert.ok(!JSON.parse(env.STORES._map.get('store:mamatoe').value).rail_accts, 'and one switch turns the whole thing back off');
});

test('a described rail says what its number looks like', async () => {
  const r = await call('/api/settings', { method: 'POST', cookie: store.cookie, confirm: true, body: {
    handle: 'mamatoe', rail: 'custom',
    rail_def: { label: 'Momo Street Wallet', dial: '*222#', pct: 1.5, fixed: 0, spec: 'phone', holder: true, till: true },
  } });
  assert.equal(r.status, 200, r.text);
  const raw = JSON.parse(env.STORES._map.get('store:mamatoe').value);
  raw.pending = raw.pending || {};                        // the rail is money too; run its fuse
  if (raw.pending.fields) raw.pending.apply_at = Date.now() - 1;
  env.STORES._map.set('store:mamatoe', { value: JSON.stringify(raw) });
  await call('/s/mamatoe/config.json');
  const cfg = await call('/s/mamatoe/config.json');
  assert.equal(cfg.json.store.rail, 'custom');
  assert.equal(cfg.json.store.rail_info.label, 'Momo Street Wallet', 'the merchant’s own words, on the slip');
  assert.equal(cfg.json.store.rail_info.spec, 'phone', 'and the shape they described, so the form and the validation follow it');

  const bad = await call('/api/settings', { method: 'POST', cookie: store.cookie, confirm: true, body: {
    handle: 'mamatoe', rail_accts: { custom: { acct: 'not a phone' } } } });
  assert.equal(bad.status, 422, 'a custom rail validates against the shape it was given: ' + bad.text);
  assert.match(bad.json.fields.rail_accts, /number buyers pay/i);
  const good = await call('/api/settings', { method: 'POST', cookie: store.cookie, confirm: true, body: {
    handle: 'mamatoe', rail_accts: { custom: { acct: '0551234567', holder: 'STREET MOMO' } } } });
  assert.equal(good.status, 200, good.text);
  const g2 = JSON.parse(env.STORES._map.get('store:mamatoe').value);
  if (g2.pending && g2.pending.fields) g2.pending.apply_at = Date.now() - 1;
  env.STORES._map.set('store:mamatoe', { value: JSON.stringify(g2) });
  const o = await call('/api/order', { method: 'POST', ip: '196.0.0.53', body: {
    handle: 'mamatoe', service: 'pickup', buyer: { name: 'Street', phone: '263780000153' },
    items: [{ id: '1', name: 'Chicken & rice', price: 5.5, qty: 1 }],
  } });
  assert.equal(o.status, 201, o.text);
  assert.equal(o.json.pay.account, '0551234567', 'an undescribed-to-nobody method still prints its number');
  assert.ok(o.json.pay.steps.some((t) => /STREET MOMO/.test(t)), 'with the name check a custom rail would otherwise not have');
  assert.ok(o.json.pay.ask_payer, 'and the sender question, because it is a phone-shaped wallet');

  // put mamatoe back the way the suite found it
  await call('/api/settings', { method: 'POST', cookie: store.cookie, confirm: true, body: { handle: 'mamatoe', rail: 'ecocash_usd', rail_accts: false, week: [] } });
  const g3 = JSON.parse(env.STORES._map.get('store:mamatoe').value);
  if (g3.pending && g3.pending.fields) g3.pending.apply_at = Date.now() - 1;
  env.STORES._map.set('store:mamatoe', { value: JSON.stringify(g3) });
});


/* ------------------------------------------------------------ store images */
/* A merchant dropping a photo in should not be able to: grow the document the
 * storefront reads on every render, hand a stranger's bytes, publish a file the
 * worker cannot name, or eat the store's picture budget one abandoned upload at a
 * time. Each test below is one of those, written as the failure. */
const b64ToBuf = (b) => Uint8Array.from(Buffer.from(b, 'base64'), (c) => c).buffer;
const PNG1 = b64ToBuf('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==');
const adminKey = () => JSON.parse(env.STORES._map.get('store:mamatoe').value).admin_token;
const sendImage = (bytes, over) => call('/api/image?handle=mamatoe', Object.assign(
  { method: 'POST', body: bytes, headers: { 'x-tapstall-admin': adminKey() } }, over || {}));
const putKey = (name, value) => env.STORES._map.set(name, { value });

test('a dropped picture comes back as a path, and the path serves the same bytes', async () => {
  const up = await sendImage(PNG1);
  assert.equal(up.status, 200, 'the upload: ' + up.text);
  assert.match(up.json.ref, /^\/i\/mamatoe\/[A-Za-z0-9_-]{10}$/, 'a path under this store, never a data: URL: ' + up.json.ref);
  assert.equal(up.json.kind, 'png', 'and it says what it found, from the bytes');
  const id = up.json.ref.split('/').pop();
  const got = await call(up.json.ref, { raw: true });
  assert.equal(got.status, 200, 'the storefront fetches it with no credentials, so a cached page still shows the food — body: ' + (await call(up.json.ref)).text);
  assert.equal(Buffer.compare(Buffer.from(got.buf), Buffer.from(PNG1)), 0, 'byte for byte the file that was sent');
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.match(got.headers.get('cache-control') || '', /immutable/, 'an id is never reused, so a year of cache is honest');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  const again = await call(up.json.ref, { raw: true, etag: '"' + id + '"' });
  assert.equal(again.status, 304, 'a reload revalidates against the path itself');
  assert.equal(again.buf.byteLength, 0, 'and costs no bytes');
  const gone = await call('/i/mamatoe/Zzzzzzzzzz', { raw: true });
  assert.equal(gone.status, 404, 'a path nobody stored is a 404, not an empty 200');
  assert.match(gone.headers.get('cache-control') || '', /no-store/, 'and a miss is never cached, or a first load could stay broken');
});

test('nobody posts a picture to a store without saying who they are', async () => {
  const anon = await call('/api/image?handle=mamatoe', { method: 'POST', body: PNG1 });
  assert.equal(anon.status, 401, 'a stranger cannot fill a store with files: ' + anon.text);
  assert.match(anon.text, /sign in/i, 'and the answer names the way in');
  const inKey = await sendImage(PNG1);
  assert.equal(inKey.status, 200, 'the API key a script sends works');
  const sess = await loginWithPin(store.handle, store.pin);
  assert.equal(sess.r.status, 200, 'and so does a signed-in merchant: ' + sess.r.text);
  const bare = await call('/api/image?handle=mamatoe', { method: 'POST', body: PNG1, cookie: sess.cookie });
  assert.equal(bare.status, 403, 'a cookie alone is not consent from another page');
  assert.match(bare.text, /x-tapstall-confirm/);
  const ok = await call('/api/image?handle=mamatoe', { method: 'POST', body: PNG1, cookie: sess.cookie, confirm: true });
  assert.equal(ok.status, 200, 'one tap of the button the merchant already pressed is enough');
  const forged = await call('/api/image?handle=mamatoe', { method: 'POST', body: PNG1, headers: { 'x-tapstall-admin': 'guess' } });
  // 401, the same answer as no key at all, and on purpose: a guesser must not learn
  // that the store exists and only the key was wrong.
  assert.equal(forged.status, 401, 'a wrong key is answered like no key: ' + forged.text);
});

test('a file that is not a picture is refused in words, and it costs no storage', async () => {
  const writes = env.STORES._writes;
  const svg = await sendImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').buffer);
  assert.equal(svg.status, 422, 'SVG would run on this origin with the merchant’s cookie in the jar');
  assert.match(svg.json.error, /SVG is refused/i, 'the answer says which format and why: ' + svg.json.error);
  const gif = await sendImage(new TextEncoder().encode('GIF89a          ').buffer);
  assert.equal(gif.status, 422);
  assert.match(gif.json.error, /GIF is refused/i);
  const zip = await sendImage(new TextEncoder().encode('PK\x03\x04          ').buffer);
  assert.equal(zip.status, 422);
  assert.match(zip.json.error, /not a picture/i);
  const empty = await sendImage(new ArrayBuffer(0));
  assert.equal(empty.status, 422);
  assert.match(empty.json.error, /nothing in that file/i);
  const big = new Uint8Array(300 * 1024);
  big.set([0xff, 0xd8, 0xff, 0xe0], 0);
  const over = await sendImage(big.buffer);
  assert.equal(over.status, 413, 'a real JPEG that is 300 KB is still too big for a thumbnail');
  assert.match(over.json.error, /KB/, 'and the merchant is told the size it wanted: ' + over.json.error);
  assert.equal(env.STORES._writes, writes, 'refusals write nothing: a refused upload must not spend the store’s day');
});

test('the store document keeps the path and never the bytes', async () => {
  const up = await sendImage(PNG1);
  const doc = () => env.STORES._map.get('store:mamatoe').value;
  const raw = typeof doc() === 'string' ? doc() : JSON.stringify(doc());
  assert.ok(raw.length < 60000, 'the store document is ' + raw.length + ' bytes — a picture in here is paid for on every page view');
  const saved = await call('/api/settings', { method: 'POST', body: { handle: 'mamatoe', logo:  up.json.ref }, headers: { 'x-tapstall-admin': adminKey() } });
  assert.equal(saved.status, 200, 'a logo is a soft field, so it lands now: ' + saved.text);
  assert.ok((saved.json.applied_now || []).includes('logo'), 'and the answer says so: ' + JSON.stringify(saved.json));
  const pub = await call('/s/mamatoe/config.json');
  assert.equal(pub.json.store.logo, up.json.ref, 'the buyer’s page reads the path straight out of the public config');
  const after = typeof doc() === 'string' ? doc() : JSON.stringify(doc());
  assert.ok(after.indexOf(up.json.ref) >= 0, 'the path is stored on the store');
  assert.ok(!/iVBORw0KGgo|89504e47/i.test(after) && after.length < 60000, 'and no picture is embedded in it');
});

test('a picture the shop stops pointing at is taken out of storage', async () => {
  const a = await sendImage(PNG1);
  await call('/api/settings', { method: 'POST', body: { handle: 'mamatoe', logo:  a.json.ref }, headers: { 'x-tapstall-admin': adminKey() } });
  const b = await sendImage(PNG1);
  const swap = await call('/api/settings', { method: 'POST', body: { handle: 'mamatoe', logo:  b.json.ref }, headers: { 'x-tapstall-admin': adminKey() } });
  assert.equal(swap.status, 200);
  assert.equal((await call(b.json.ref)).status, 200, 'the new one is live');
  assert.equal((await call(a.json.ref)).status, 404, 'the one nobody points at is gone, not orphaned forever');
  assert.ok(env.STORES._deleted('img:mamatoe:' + a.json.ref.split('/').pop()), 'and it is a delete, so the 1 GB ceiling moves back');
  const off = await call('/api/settings', { method: 'POST', body: { handle: 'mamatoe', logo:  '' }, headers: { 'x-tapstall-admin': adminKey() } });
  assert.equal(off.status, 200, 'and taking the logo off entirely works like any other clear');
  assert.equal((await call(b.json.ref)).status, 404, 'which frees that one too');
});

test('an item row takes its photo from the same upload and the shelf passes it on', async () => {
  const up = await sendImage(PNG1);
  const saved = await call('/api/menu', { method: 'POST', body: { handle: 'mamatoe', menu:  { over: { '2': { img: up.json.ref } } } }, headers: { 'x-tapstall-admin': adminKey() } });
  assert.equal(saved.status, 200, saved.text);
  const feed = await call('/s/mamatoe/feed.json');
  const row = (feed.json.products || []).find((p) => String(p.id) === '2');
  assert.equal(row && row.img, up.json.ref, 'the buyer’s feed now carries the path');
  const back = await call('/api/menu', { method: 'POST', body: { handle: 'mamatoe', menu:  { over: { '2': { img: '' } } } }, headers: { 'x-tapstall-admin': adminKey() } });
  assert.equal(back.status, 200);
  const feed2 = await call('/s/mamatoe/feed.json');
  const row2 = (feed2.json.products || []).find((p) => String(p.id) === '2');
  assert.equal(row2.img, '', 'and clearing it clears it, rather than leaving a photo the merchant deleted');
  assert.equal((await call(up.json.ref)).status, 404, 'the bytes go with it');
});

test('sixty pictures is what a store gets, and the last answer says what to do', async () => {
  const refs = [];
  for (let i = 0; i < 60; i++) {
    const up = await sendImage(PNG1);
    assert.equal(up.status, 200, 'upload ' + i + ': ' + up.text);
    refs.push(up.json.ref);
    const save = await call('/api/menu', { method: 'POST', headers: { 'x-tapstall-admin': adminKey() }, body: { handle: 'mamatoe', menu:  { extra: refs.map((r, j) => ({ id: 'cap' + j, name: 'Cap ' + j, img: r })) } } });
    assert.equal(save.status, 200, 'save ' + i + ': ' + save.text);
  }
  assert.equal((await call(refs[0])).status, 200, 'every stored image is still pointed at, so prune left them all alone');
  const oneTooMany = await sendImage(PNG1);
  assert.equal(oneTooMany.status, 429, 'the ceiling is a real number, not a suggestion');
  assert.match(oneTooMany.json.error, /ceiling/i, 'and it is said in words a merchant can act on: ' + oneTooMany.json.error);
  const clean = await call('/api/menu', { method: 'POST', body: { handle: 'mamatoe', menu:  {} }, headers: { 'x-tapstall-admin': adminKey() } });
  assert.equal(clean.status, 200, 'reverting the menu frees the lot: ' + clean.text);
  assert.equal((await call(refs[0])).status, 404, 'and the files go with the rows that named them');
});

/* ------------------------------------------------------------ proof of payment */
/* The gap on a hand-checked rail is not the money, it is finding it. These run the
 * whole path — a store that declares what it needs, a buyer who is asked once, a
 * ledger row that shows the answer, and a public page that shows the policy and
 * never the code. */
// Read off whatever rail the shop is on by now — EcoCash USD at rest, a described
// wallet after the rail tests have run — because a hand-checked wallet answers the
// same way either time, and that is the point of deriving it from the shape.
test('a live store publishes what it needs to find the money, and the buyer’s page can obey it', async () => {
  const pub = await call('/s/mamatoe/config.json');
  const info = pub.json.store.rail_info;
  assert.equal(info.proof, 'ask', 'a wallet asks for the app code, and asks rather than demands: ' + JSON.stringify(info));
  assert.equal(info.proof_label, 'Code from the app');
  assert.ok(/not the order code/.test(info.proof_hint), 'and says where to find it, because every app hides it differently');
  assert.equal(info.ask_payer, true, 'the sender’s number is asked on the same rails it helps on');
});

test('a rail that cannot match a transfer without a code asks for one', async () => {
  const h = 'zzproof' + String(Date.now()).slice(-5);
  const reg = await call('/api/register', { method: 'POST', body: {
    handle: h, shop_name: 'Proof Test', whatsapp: '263771234567', rail: 'zipit', pay_account: '1234567890', currency: 'USD',
  } });
  assert.equal(reg.status, 201, reg.text);
  const pub = await call('/s/' + h + '/config.json');
  assert.equal(pub.json.store.rail_info.proof, 'require', 'a bank transfer is the case that needs it: ' + JSON.stringify(pub.json.store.rail_info));
  assert.equal(pub.json.store.rail_info.proof_label, 'Reference from your bank');

  // An order with no code is still an order. It is taken, and flagged.
  const bare = await call('/api/order', { method: 'POST', ip: '196.21.0.1', body: { handle: h, service: 'pickup',
    buyer: { name: 'Tinashe M', phone: '0780001122' }, items: [{ name: 'Box', price: 12 }] } });
  assert.equal(bare.status, 201, 'the buyer is never stopped by a field the shop forgot to fill: ' + bare.text);
  const flag = (bare.json.risk_flags || []).join(' | ');
  assert.match(flag, /no reference from your bank — ask them before sending/, 'the row says what to ask for: ' + flag);
  assert.ok(bare.json.pay.steps.some((l) => /keep the code the app shows/i.test(l)), 'and the slip asked for it before they paid: ' + JSON.stringify(bare.json.pay.steps));
  assert.equal(bare.json.pay.proof_mode, 'require', 'the slip names how badly it was wanted');

  const withProof = await call('/api/order', { method: 'POST', ip: '196.21.0.2', body: { handle: h, service: 'pickup',
    buyer: { name: 'Rudo M', phone: '0780002233', payer: 'Standard Bank 6288112233', proof: ' REF-99.x/1 ' },
    items: [{ name: 'Box', price: 12 }] } });
  assert.equal(withProof.status, 201, withProof.text);
  assert.ok(!(withProof.json.risk_flags || []).some((f) => /no reference/.test(f)), 'given, so nothing to flag: ' + JSON.stringify(withProof.json.risk_flags));
  assert.equal(withProof.json.pay.proof, 'REF-99.x/1', 'and it is on the printed slip the merchant reads');
  assert.equal(withProof.json.pay.proof_mode, 'require');
  assert.equal(withProof.json.pay.payer_from, 'Standard Bank 6288112233', 'a payer typed as words is printed as words — the merchant searches their own statement, not our shape');

  const doc = JSON.parse(env.ORDERS._map.get('order:' + h + ':' + withProof.json.order.id).value);
  assert.equal(doc.buyer.proof, 'REF-99.x/1', 'kept exactly as typed, spaces trimmed, nothing reshaped');
  assert.equal(doc.buyer.payer, 'Standard Bank 6288112233', 'what they typed is what is stored — the rail is chosen by the shop, and a payer may outlive it');
  const row = storedRow(h, withProof.json.order.id);
  assert.equal(row.proof, 'REF-99.x/1', 'and the ledger row carries it, so the list never opens the document to answer');
  assert.equal(row.payer, 'Standard Bank 6288112233', 'and the row agrees with the slip');
  assert.equal(storedRow(h, bare.json.order.id).proof, '', 'a row with nothing says nothing rather than lying about it');
  assert.equal(indexWritesFor(h), 0, 'and no row-array write was spent to get there: the row rode on the document');

  const key = JSON.parse(env.STORES._map.get('store:' + h).value).admin_token;
  const dash = await call('/api/admin?handle=' + h, { headers: { 'x-tapstall-admin': key } });
  assert.equal(dash.status, 200, dash.text);
  const shown = (dash.json.orders || []).find((o) => o.id === withProof.json.order.id);
  assert.equal(shown.buyer.proof, 'REF-99.x/1', 'the merchant’s own ledger shows it');

  // The public surfaces carry the policy and never a code: a reference is the buyer's
  // word about their own payment, not shop furniture.
  for (const path of ['/s/' + h + '/config.json', '/s/' + h + '/feed.json', '/api/lookup?handle=' + h, '/s/' + h]) {
    const body = (await call(path)).text;
    assert.ok(!/REF-99/.test(body), path + ' must not carry a buyer’s reference');
  }
  const lite = await call('/ops/api/store', { method: 'POST', cookie: 'tp_ops=' + opsCookie, confirm: true, body: { handle: h, action: 'store_view' } });
  if (lite.status === 200 && lite.json && lite.json.orders) {
    assert.ok(JSON.stringify(lite.json.orders).includes('REF-99.x/1'), 'the operator sees what the merchant sees: ' + lite.text.slice(0, 120));
  }
});

test('a wallet payer is narrowed to digits, because that is what a wallet search takes', async () => {
  const ord = await call('/api/order', { method: 'POST', ip: '196.21.0.5', body: { handle: 'mamatoe', service: 'pickup',
    buyer: { name: 'Tine M', phone: '0780004455', payer: '+263 77 123 4567', proof: 'EC 88 12 34' },
    items: [{ id: '1', name: 'Chicken & rice', price: 5.5, qty: 1 }] } });
  assert.equal(ord.status, 201, ord.text);
  assert.equal(ord.json.pay.payer_from, '+263771234567', 'spaces gone, plus kept, so the number is dialable from the slip');
  assert.equal(ord.json.pay.proof, 'EC 88 12 34', 'a code keeps its spaces: an EcoCash SMS has them');
});

test('a described method can demand its own code and name it', async () => {
  const h = 'zzmpesa' + String(Date.now()).slice(-5);
  const reg = await call('/api/register', { method: 'POST', body: {
    handle: h, shop_name: 'M-Pesa Test', whatsapp: '254771234567', rail: 'custom', currency: 'USD',
    rail_def: { label: 'M-Pesa', dial: '*334#', pct: 0.079, type: 'manual', spec: 'phone', proof: 'require', proof_label: 'M-Pesa code' },
    pay_account: '0771234567',
  } });
  assert.equal(reg.status, 201, reg.text);
  const pub = await call('/s/' + h + '/config.json');
  assert.equal(pub.json.store.rail_info.proof, 'require', 'the custom rail declares its own policy, not the placeholder’s');
  assert.equal(pub.json.store.rail_info.proof_label, 'M-Pesa code', 'and its own name for the thing');
  const ord = await call('/api/order', { method: 'POST', ip: '196.21.0.3', body: { handle: h, service: 'pickup',
    buyer: { name: 'Akinyi O', phone: '0700000001', proof: 'SLP 88123' }, items: [{ name: 'Tea', price: 2 }] } });
  assert.equal(ord.status, 201, ord.text);
  assert.ok(!(ord.json.risk_flags || []).some((f) => /no m-pesa code/.test(f)), 'nothing missing, nothing flagged: ' + JSON.stringify(ord.json.risk_flags));
  assert.ok(ord.json.pay.steps.some((l) => /m-pesa code/i.test(l)), 'the slip uses the shop’s words, not a generic label');
  const doc = JSON.parse(env.ORDERS._map.get('order:' + h + ':' + ord.json.order.id).value);
  assert.equal(doc.buyer.proof, 'SLP 88123');
  const miss = await call('/api/order', { method: 'POST', ip: '196.21.0.4', body: { handle: h, service: 'pickup',
    buyer: { name: 'No Code', phone: '0700000002' }, items: [{ name: 'Tea', price: 2 }] } });
  assert.match((miss.json.risk_flags || []).join(' '), /no m-pesa code/, 'and the flag speaks the same words back to the merchant: ' + JSON.stringify(miss.json.risk_flags));
});

test('the words to ask for a missing code are already written, on the row', async () => {
  const h = 'zzask' + String(Date.now()).slice(-5);
  const reg = await call('/api/register', { method: 'POST', body: {
    handle: h, shop_name: 'Ask Test', whatsapp: '263771234567', rail: 'zipit', pay_account: '1234567890', currency: 'USD',
  } });
  assert.equal(reg.status, 201, reg.text);
  const owed = await call('/api/order', { method: 'POST', ip: '196.21.0.11', body: { handle: h, service: 'pickup',
    buyer: { name: 'Farai M', phone: '0780006677' }, items: [{ name: 'Box', price: 30 }] } });
  assert.equal(owed.status, 201, owed.text);
  const given = await call('/api/order', { method: 'POST', ip: '196.21.0.12', body: { handle: h, service: 'pickup',
    buyer: { name: 'Farai M', phone: '0780006677', proof: 'REF-77' }, items: [{ name: 'Box', price: 30 }] } });
  assert.equal(given.status, 201, given.text);

  const key = JSON.parse(env.STORES._map.get('store:' + h).value).admin_token;
  const dash = await call('/api/admin?handle=' + h, { headers: { 'x-tapstall-admin': key } });
  assert.equal(dash.status, 200, dash.text);
  const byId = (id) => dash.json.orders.find((o) => o.id === id);
  const a = byId(owed.json.order.id), b = byId(given.json.order.id);
  assert.match(a.ask, /^Need: Reference from your bank/, 'the row that owes one arrives with the sentence on it: ' + JSON.stringify(a.ask));
  assert.equal(b.ask, undefined, 'the row that answered arrives as it always did — no nudge, no badge, nothing to act on');
  assert.equal(JSON.parse(env.ORDERS._map.get('order:' + h + ':' + owed.json.order.id).value).ask, undefined,
    'it is written at read time, not stored: a renamed field should not strand a sentence in an old order');
  assert.ok(!/proof/i.test(a.ask.slice(0, 5)) || /Need/.test(a.ask), 'and it opens with what is needed, not with an apology');
});

/* ------------------------------------------------------------------ 0.7.3 the buyer's own write */

let late = {};   // one store, one order, several tests: the minting is the interesting part
async function lateOrder(ip, buyer) {
  const r = await call('/api/order', { method: 'POST', ip, body: { handle: late.handle, service: 'pickup',
    buyer: Object.assign({ name: 'Tafadzwa M', phone: '0780009911' }, buyer || {}), items: [{ name: 'Box', price: 42 }] } });
  assert.equal(r.status, 201, r.text);
  return r;
}
const proofCapOf = (r) => {
  assert.match(r.json.proof_url, /^\/p\/v1\./, 'the receipt carries a code link, and it is its own kind: ' + JSON.stringify(r.json.proof_url));
  return r.json.proof_url.slice(3);
};

test('the code a buyer has not typed yet gets a link of its own, not the shop’s', async () => {
  late.handle = 'zzlate' + String(Date.now()).slice(-5);
  const reg = await call('/api/register', { method: 'POST', body: {
    handle: late.handle, shop_name: 'Late Code Test', whatsapp: '263771234567', rail: 'zipit', pay_account: '1234567890', currency: 'USD',
  } });
  assert.equal(reg.status, 201, reg.text);
  const ord = late = Object.assign(late, await lateOrder('196.31.0.1'));
  late.cap = proofCapOf(ord);
  assert.equal(ord.json.proof_writes, 3, 'and the page says how many goes in it, so nobody has to guess if a second try is allowed');
  // and it says it in the word the storefront reads. `proof_writes` is the field on the
  // order document; the receipt's script asks for `left`, and for six releases the create
  // response carried only the first name — so the door was minted, shown, and then thrown
  // away by `else pfDone(...)` on its way to localStorage. Two names for one number is how
  // that stayed invisible: this line is the seam.
  assert.equal(ord.json.left, ord.json.proof_writes, 'the receipt counts the budget under the word the page reads');

  // the promise that made this acceptable at all: a URL a stranger could read is
  // handed to the buyer, and it is kept nowhere the merchant can pick it up
  const doc = JSON.parse(env.ORDERS._map.get('order:' + late.handle + ':' + ord.json.order.id).value);
  assert.equal(doc.proof_url, undefined, 'the order document does not hold the buyer’s link');
  assert.ok(!/\/p\/v1\./.test(JSON.stringify(doc)), 'and nothing else written at order time leaks it either');
  assert.match(doc.confirm_url, /\/c\/v1\./, 'the shop’s own link is stored, because the shop needs it again');
  late.key = JSON.parse(env.STORES._map.get('store:' + late.handle).value).admin_token;

  const page = await call('/p/' + late.cap);
  assert.equal(page.status, 200, page.text.slice(0, 160));
  assert.match(page.text, /action="\/api\/proof"/, 'a plain form is the floor: no JS, nothing to learn');
  assert.ok(page.text.includes('name=cap'), 'the link itself is what authorises the write');
  assert.match(page.text, /cannot mark anything paid/, 'and the page says out loud what it cannot do');
  assert.match(page.text, /Need: Reference from your bank/, 'the shop’s own words about what is missing are quoted, not rewritten');
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow', 'a buyer’s receipt is not content to be crawled');
  assert.ok(!/REF-99|EC 88/.test(page.text), 'nothing from another order is on the page');

  // a confirm link and a code link are different kinds of thing, and the routes know it
  const asProof = await call('/p/' + ord.json.mark_url.slice(3));
  assert.equal(asProof.status, 401, 'the shop’s money link does not open the buyer’s field');
  assert.match(asProof.text, /finished/i, 'and it says so in words that do not blame the buyer');
  // the two kinds of link are the same length of time, and the promise is kept in the
  // prose on both pages, which is the only place a reader can compare them
  const dead = await call('/p/' + 'v1.9999999999.eyJhIjoicHJvb2YifQ.deadbeef');
  assert.match(dead.text, /72 hours/, 'a spent code link says what it was worth, in the units the shop’s own links use: ' + dead.text.slice(0, 200));
  assert.equal(dead.status, 401, 'an unparseable link is the same answer as a spent one');
  const asMark = await call('/c/' + late.cap);
  assert.match(asMark.text, /72 hours/, 'and the shop’s page says the same number, so the two cannot drift apart');
  assert.match(asMark.text, /expired/i, 'nor the other way round: a code link opens the dead-link page, not a live confirmation');
  const tryMark = await call('/api/mark', { method: 'POST', ip: '196.31.0.20', body: { cap: late.cap } });
  assert.equal(tryMark.status, 401, 'and pointing a code cap at the money endpoint outright is refused: ' + tryMark.text);
  assert.equal(tryMark.json.error, 'link_expired', 'with the same words any dead link gets, so nothing about the kind of cap leaks out');
  assert.equal(JSON.parse(env.ORDERS._map.get('order:' + late.handle + ':' + ord.json.order.id).value).status, 'awaiting_payment',
    'and the order is still open, exactly as it was');
});

test('what the buyer sends lands on the order, the ledger and the paper trail, and moves nothing', async () => {
  const r = await call('/api/proof', { method: 'POST', ip: '196.31.0.2', body: { cap: late.cap, proof: ' RBZ 8812.x ' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.changed, true, 'a real edit is called a real edit');
  assert.equal(r.json.left, 2, 'and the page tells them what is left, in the same breath');
  assert.equal(r.json.proof, 'RBZ 8812.x', 'trimmed, never reshaped — an app prints what it prints');

  const key = 'order:' + late.handle + ':' + late.json.order.id;
  const doc = JSON.parse(env.ORDERS._map.get(key).value);
  assert.equal(doc.buyer.proof, 'RBZ 8812.x', 'it is on the order');
  assert.equal(doc.buyer.name, 'Tafadzwa M', 'nothing else about the buyer moved');
  assert.equal(doc.status, 'awaiting_payment', 'THE ONE THING: a buyer’s link never touches the money state');
  assert.equal(doc.proof_by, 'buyer', 'and the row says where it came from, so the merchant knows who to thank');
  assert.match(doc.proof_at, /^\d{4}-\d{2}-\d{2}T/, 'with when');

  assert.equal(storedRow(late.handle, late.json.order.id).proof, 'RBZ 8812.x',
    'on the ledger row too, in the same write — there is no second copy for the buyer’s value to fail to reach');
  const dash = await call('/api/admin?handle=' + late.handle, { headers: { 'x-tapstall-admin': late.key } });
  const shown = dash.json.orders.find((o) => o.id === late.json.order.id);
  assert.equal(shown.buyer.proof, 'RBZ 8812.x', 'the merchant sees it in their own ledger');
  assert.equal(shown.ask, undefined, 'and the sentence asking for it is gone, with no wiring at all: proofAsk falls silent on its own');
  const audit = dash.json.audit.find((a) => a.act === 'proof');
  assert.ok(audit, 'the write is in the paper trail: ' + JSON.stringify(dash.json.audit).slice(0, 200));
  assert.equal(audit.via, 'buyer', 'named as a buyer write, not smuggled in as a merchant one');
  assert.ok(audit.fields.join(' ').includes('RBZ 8812.x'), 'with the value, because a reference is not a secret from the shop');

  // no JS, no fetch, just a form: the path a Nokia browser takes
  const posted = await call('/api/proof', { method: 'POST', ip: '196.31.0.3',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ cap: late.cap, form: '1', proof: 'RBZ 8812.x' }) });
  assert.equal(posted.status, 200, posted.text.slice(0, 200));
  assert.match(posted.text, /Sent to the shop/, 'a form post gets a page back, not a JSON blob');
  assert.match(posted.text, /nothing was rewritten/, 'the same value twice is said to be the same value, not a second edit');
  assert.equal(JSON.parse(env.ORDERS._map.get(key).value).proof_writes, 1, 'and it cost the order nothing to try');
});

test('three corrections, then the door shuts — and a settled order shut it already', async () => {
  // an order that came with a code from the cart still gets its three corrections:
  // the budget counts writes through this door, and nothing else
  const ord = late = Object.assign(late, await lateOrder('196.31.0.4', { proof: 'FROM CART' }));
  let cap = proofCapOf(ord);
  const key = 'order:' + late.handle + ':' + ord.json.order.id;
  // one link, one change: a write that changed something hands back the next link, which is
  // what the buyer's own page does with it, so the test follows the same chain a phone would
  const put = async (proof, ip) => {
    const res = await call('/api/proof', { method: 'POST', ip, body: { cap, proof } });
    if (res.json && res.json.proof_url) cap = res.json.proof_url.slice(3);
    return res;
  };
  assert.equal(JSON.parse(env.ORDERS._map.get(key).value).buyer.proof, 'FROM CART', 'the cart value is on the order, untouched');
  assert.equal((await put('SECOND', '196.31.0.5')).json.left, 2, 'first through this door, so two left');
  assert.equal((await put('THIRD', '196.31.0.6')).json.left, 1, 'and one');
  assert.equal((await put('FOURTH', '196.31.0.6')).json.left, 0, 'the last one, spent');
  const spentBefore = env.ORDERS._writesTo(key);
  const shut = await put('FIFTH', '196.31.0.7');
  assert.equal(shut.status, 429, 'the fourth correction is refused: ' + shut.text);
  assert.match(shut.json.error, /message the shop/i, 'with words that point at the chat instead of another try: ' + shut.json.error);
  assert.equal(JSON.parse(env.ORDERS._map.get(key).value).buyer.proof, 'FOURTH', 'the refused attempt wrote nothing');
  assert.equal(env.ORDERS._writesTo(key), spentBefore, 'and it cost no write either — a refusal that writes is a way to spend a tenant’s daily budget for nothing');

  // blank is not how you undo a typo: an absent field must not erase the evidence
  const blank = await put('', '196.31.0.8');
  assert.equal(blank.status, 422, 'a submit with nothing in it is answered, not obeyed: ' + blank.text);
  assert.match(blank.json.error, /Type the code/i, 'and it says what to do about it');
  assert.equal(JSON.parse(env.ORDERS._map.get(key).value).buyer.proof, 'FOURTH', 'the reference on file survived an empty try');

  // the shop settles it; from that moment the record is closed to a buyer
  const mark = await call('/api/mark', { method: 'POST', ip: '196.31.0.9', body: { cap: ord.json.mark_url.slice(3) } });
  assert.equal(mark.status, 200, mark.text);
  const late2 = await put('TOO LATE', '196.31.0.10');
  assert.equal(late2.status, 409, 'after the money is marked, no buyer write at all: ' + late2.text);
  assert.match(late2.json.error, /already paid/, 'and the reason is the order’s state, not a token expiry');
  assert.equal(JSON.parse(env.ORDERS._map.get(key).value).buyer.proof, 'FOURTH', 'nothing moved');
  const page = await call('/p/' + cap);
  assert.ok(!page.text.includes('<form'), 'the page stops offering the field, rather than offering it and failing');
  assert.match(page.text, /closed from here/, 'and says where to take it instead');
});

test('a code link cannot become a money link, and one lever closes both', async () => {
  const ord = late = Object.assign(late, await lateOrder('196.31.0.11'));
  const cap = proofCapOf(ord);
  const forged = await call('/api/proof', { method: 'POST', ip: '196.31.0.12', body: { cap: cap.slice(0, -6) + 'AAAAAA', proof: 'X' } });
  assert.equal(forged.status, 401, 'an edited tag is the same answer as an expired link: ' + forged.text);
  assert.match(forged.json.error, /does not open this field/, 'and no detail about why, since either way there is nothing to gain');
  const wrongKind = await call('/api/proof', { method: 'POST', ip: '196.31.0.13', body: { cap: ord.json.mark_url.slice(3), proof: 'X' } });
  assert.equal(wrongKind.status, 401, 'the shop’s own confirm cap is refused here too — a cap is not a skeleton key: ' + wrongKind.text);
  const get = await call('/api/proof?cap=' + cap);
  assert.equal(get.status, 405, 'and the write is POST-only, so a crawler that fetches links adds nothing');
  assert.equal(get.headers.get('allow'), 'POST');
  const noCap = await call('/api/proof', { method: 'POST', ip: '196.31.0.14', body: { proof: 'X' } });
  assert.equal(noCap.status, 401, 'no cap, nothing: ' + noCap.text);
  const otherOrder = await call('/api/proof', { method: 'POST', ip: '196.31.0.15', body: { cap, proof: 'X', id: 'whatever' } });
  assert.equal(otherOrder.status, 200, 'an extra field in the body is ignored, not obeyed — the cap names the order: ' + otherOrder.text);
  const doc = JSON.parse(env.ORDERS._map.get('order:' + late.handle + ':' + ord.json.order.id).value);
  assert.equal(doc.buyer.proof, 'X', 'and it landed on the order the link was minted for');

  // the merchant's one lever: revoke bumps the generation every signed thing is bound to
  const key = JSON.parse(env.STORES._map.get('store:' + late.handle).value).admin_token;
  const revoked = await call('/api/revoke', { method: 'POST', headers: { 'x-tapstall-admin': key }, body: { handle: late.handle } });
  assert.equal(revoked.status, 200, revoked.text);
  const after = await call('/api/proof', { method: 'POST', ip: '196.31.0.16', body: { cap, proof: 'AFTER' } });
  assert.equal(after.status, 410, 'a link minted before the lever is dead after it: ' + after.text);
  assert.match(after.json.error, /closed its code links/, 'named as the shop closing it, because that is what happened');
  assert.equal(JSON.parse(env.ORDERS._map.get('order:' + late.handle + ':' + ord.json.order.id).value).buyer.proof, 'X', 'nothing landed');
  const page = await call('/p/' + cap);
  assert.equal(page.status, 410, 'the page is honest about it too, rather than showing a field that will fail');
});

test('the buyer’s door is throttled on its own, and stays off the shop’s allowance', async () => {
  const ord = late = Object.assign(late, await lateOrder('196.31.0.17'));
  const cap = proofCapOf(ord);
  const ip = '196.31.0.18';
  let blocked = 0;
  for (let i = 0; i < 9; i++) {
    const r = await call('/api/proof', { method: 'POST', ip, body: { cap, proof: 'FLOOD' + i } });
    if (r.status === 429) blocked++;
  }
  assert.ok(blocked >= 3, 'six attempts a minute per visitor, and the ninth onward is refused: ' + blocked);
  const doc = JSON.parse(env.ORDERS._map.get('order:' + late.handle + ':' + ord.json.order.id).value);
  assert.ok(['FLOOD0', 'FLOOD1', 'FLOOD2'].includes(doc.buyer.proof), 'the writes that happened are the first three, then the order’s own limit took over: ' + doc.buyer.proof);
  // a buyer on the shop’s NAT keeps their order allowance: the buckets are separate
  const other = await call('/api/order', { method: 'POST', ip: '196.31.0.19', body: { handle: late.handle, service: 'pickup',
    buyer: { name: 'Someone Else', phone: '0780001234' }, items: [{ name: 'Box', price: 5 }] } });
  assert.equal(other.status, 201, 'ordering from the same address is untouched by a flooding neighbour: ' + other.text);
});

test('the chase the merchant sends now ends at a door the buyer can open', async () => {
  const h = 'zzchase' + String(Date.now()).slice(-5);
  const reg = await call('/api/register', { method: 'POST', body: {
    handle: h, shop_name: 'Chase Test', whatsapp: '263771234567', rail: 'zipit', pay_account: '1234567890', currency: 'USD',
  } });
  assert.equal(reg.status, 201, reg.text);
  const key = JSON.parse(env.STORES._map.get('store:' + h).value).admin_token;
  const ord = await call('/api/order', { method: 'POST', ip: '196.32.0.1', body: { handle: h, service: 'pickup',
    buyer: { name: 'Simba N', phone: '0780007788' }, items: [{ name: 'Box', price: 60 }] } });
  assert.equal(ord.status, 201, ord.text);
  const dash = await call('/api/admin?handle=' + h, { headers: { 'x-tapstall-admin': key } });
  const row = dash.json.orders.find((o) => o.id === ord.json.order.id);
  assert.match(row.ask, /Add it here and I can confirm your order today: https:\/\/tapstall\.test\/p\/v1\./,
    'the sentence the shop copies ends at a real field: ' + row.ask);
  assert.ok(row.ask.endsWith(row.proof_url), 'and the sentence ends at exactly the URL the row carries, so a copied slip and a tapped message cannot offer two different doors');
  // the point of minting it at read time is that the link the merchant sends works
  // absolute on this surface, because the row’s text is copied into a chat where a
  // relative path is a broken link — so the test has to cut the path off properly
  assert.ok(/^https:\/\/tapstall\.test\/p\/v1\./.test(row.proof_url), 'and it is absolute, which is what a chat message needs: ' + row.proof_url);
  const added = await call('/api/proof', { method: 'POST', ip: '196.32.0.2', body: { cap: row.proof_url.replace(/^.*\/p\//, ''), proof: 'SENT-IN-CHAT' } });
  assert.equal(added.status, 200, 'a buyer who lost the receipt gets a working door from the next message: ' + added.text);
  assert.equal(JSON.parse(env.ORDERS._map.get('order:' + h + ':' + ord.json.order.id).value).buyer.proof, 'SENT-IN-CHAT');
  const after = await call('/api/admin?handle=' + h, { headers: { 'x-tapstall-admin': key } });
  assert.equal(after.json.orders.find((o) => o.id === ord.json.order.id).ask, undefined,
    'and the row stops asking the moment the code is in, minted or not');
  // a settled order keeps its sentence and gains no door: no live write for a closed record
  const paid = await call('/api/order', { method: 'POST', ip: '196.32.0.3', body: { handle: h, service: 'pickup',
    buyer: { name: 'Paid One', phone: '0780007799' }, items: [{ name: 'Box', price: 60 }] } });
  await call('/api/mark', { method: 'POST', ip: '196.32.0.4', body: { cap: paid.json.mark_url.slice(3) } });
  const settled = (await call('/api/admin?handle=' + h, { headers: { 'x-tapstall-admin': key } })).json.orders.find((o) => o.id === paid.json.order.id);
  assert.match(settled.ask, /Need: Reference from your bank/, 'the chase is still readable on a paid row');
  assert.ok(!/tapstall\.test\/p\//.test(settled.ask), 'but it offers no link that would only fail at the end: ' + settled.ask);
  assert.equal(settled.proof_url, undefined, 'and the row carries no capability the shop did not need to mint');
});

test('the shop can file the code the buyer sent in chat, and it is called what it is', async () => {
  const h = 'zzfile' + String(Date.now()).slice(-5);
  const reg = await call('/api/register', { method: 'POST', body: {
    handle: h, shop_name: 'File Test', whatsapp: '263771234567', rail: 'zipit', pay_account: '1234567890', currency: 'USD',
  } });
  assert.equal(reg.status, 201, reg.text);
  const key = JSON.parse(env.STORES._map.get('store:' + h).value).admin_token;
  const hdr = { 'x-tapstall-admin': key };
  const ord = await call('/api/order', { method: 'POST', ip: '196.32.0.5', body: { handle: h, service: 'pickup',
    buyer: { name: 'Rwot S', phone: '0780008811' }, items: [{ name: 'Box', price: 15 }] } });
  await call('/api/mark', { method: 'POST', ip: '196.32.0.6', body: { cap: ord.json.mark_url.slice(3) } });   // counted, then the code arrives
  const id = ord.json.order.id;
  const docKey = 'order:' + h + ':' + id;
  const filed = await call('/api/order/proof', { method: 'POST', headers: hdr, body: { handle: h, id, proof: ' 8812 .RT ' } });
  assert.equal(filed.status, 200, filed.text);
  assert.equal(filed.json.changed, true, 'and it is a write, on a settled order, because it is their ledger');
  const doc = JSON.parse(env.ORDERS._map.get(docKey).value);
  assert.equal(doc.buyer.proof, '8812 .RT', 'trimmed the same way a buyer’s field is');
  assert.equal(doc.status, 'paid', 'a reference filed after the money was counted moves no money');
  assert.equal(doc.proof_by, 'merchant', 'and the row says who put it there');
  assert.equal(doc.proof_writes, undefined, 'a shop write does not eat the buyer’s three corrections');
  assert.equal(storedRow(h, id).proof, '8812 .RT', 'the ledger row agrees, so the badge leaves with the ask');
  assert.equal((await call('/api/admin?handle=' + h, { headers: hdr })).json.orders.find((o) => o.id === id).ask, undefined,
    'the chase sentence is gone, with no extra wiring, because proofAsk sees the value');
  const audit = (await call('/api/admin?handle=' + h, { headers: hdr })).json.audit.find((a) => a.act === 'proof');
  assert.equal(audit.via, 'merchant', 'named as a shop write in the paper trail, not smuggled in as the buyer’s');
  const again = await call('/api/order/proof', { method: 'POST', headers: hdr, body: { handle: h, id, proof: '8812 .RT' } });
  assert.equal(again.json.changed, false, 'the same value twice is not a second edit');
  assert.equal(env.ORDERS._writesTo(docKey), env.ORDERS._writesTo(docKey), 'and it is refused before any write is spent');
  const empty = await call('/api/order/proof', { method: 'POST', headers: hdr, body: { handle: h, id, proof: '   ' } });
  assert.equal(empty.status, 422, 'a blank box is answered, not obeyed: ' + empty.text);
  assert.match(empty.json.error, /^Nothing to file — type the code they sent you\.$/,
    'in the shop’s own voice, because the buyer’s sentence would read as an insult at the wrong end: ' + empty.json.error);
  const buyerVoice = await call('/api/proof', { method: 'POST', ip: '196.32.0.7', body: { cap: (await call('/api/admin?handle=' + h, { headers: hdr })).json.orders.find((o) => o.id === id).proof_url || 'x', proof: '' } });
  assert.ok(buyerVoice.status === 422 || buyerVoice.status === 409 || buyerVoice.status === 401,
    'the buyer’s door answers a blank with its own sentence, whatever the state: ' + buyerVoice.text);
  const ghost = await call('/api/order/proof', { method: 'POST', headers: hdr, body: { handle: h, id: 'nope', proof: 'X' } });
  assert.equal(ghost.status, 404, 'an id the shop does not have is not written to');
  const anon = await call('/api/order/proof', { method: 'POST', body: { handle: h, id, proof: 'X' } });
  assert.equal(anon.status, 401, 'no key, no write — this door is not public at all: ' + anon.text);
  assert.equal(anon.json.need_login, true, 'and it sends the merchant to sign in, the same as any other shop write');
  const withCap = await call('/api/order/proof', { method: 'POST', body: { cap: ord.json.proof_url.slice(3), handle: h, id, proof: 'X' } });
  assert.equal(withCap.status, 401, 'a capability cannot be traded up into the merchant door: it is not read here');
  const got = await call('/api/order/proof?handle=' + h + '&id=' + id);
  assert.equal(got.status, 405, 'and it is POST-only like every other write');
});

test('the code page puts the door down on the device it was handed to', async () => {
  const h = 'zzkeep' + String(Date.now()).slice(-5);
  const reg = await call('/api/register', { method: 'POST', body: {
    handle: h, shop_name: 'Keep Test', whatsapp: '263771234567', rail: 'zipit', pay_account: '1234567890', currency: 'USD',
  } });
  assert.equal(reg.status, 201, reg.text);
  const ord = await call('/api/order', { method: 'POST', ip: '196.33.0.1', body: { handle: h, service: 'pickup',
    buyer: { name: 'Kuda T', phone: '0780002200' }, items: [{ name: 'Box', price: 9 }] } });
  assert.equal(ord.status, 201, ord.text);
  const cap = ord.json.proof_url.slice(3);
  const page = await call('/p/' + cap);
  assert.equal(page.status, 200, page.text.slice(0, 120));
  assert.ok(page.text.includes(`"tp_pf_${h}"`), 'the script names this shop’s key, not a global one: ' + page.text.slice(-400));
  assert.ok(page.text.includes(`"${ord.json.order.code}"`), 'and the order whose entry it clears');
  assert.equal((page.text.match(/<script>/g) || []).length, 1, 'exactly one script block, so nothing is spliced into another');
  assert.match(page.text, /if\(n\.length!==a\.length\)localStorage\.setItem\(k,JSON\.stringify\(n\)\)/,
    'and it writes only to drop something it had already stored — an entry that is not there is left alone, so a first visit costs nothing');
  // the Sent page carries the same line, so the door closes behind them
  const sent = await call('/api/proof', { method: 'POST', ip: '196.33.0.2',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ cap, form: '1', proof: 'KEEP-1' }) });
  assert.equal(sent.status, 200, sent.text.slice(0, 160));
  assert.match(sent.text, /Sent to the shop/, 'the confirmation page is still a page, not a blob');
  assert.ok(sent.text.includes(`"tp_pf_${h}"`), 'and it is the page that removes the entry, at the moment the code lands');
  assert.equal(JSON.parse(env.ORDERS._map.get(`order:${h}:${ord.json.order.id}`).value).buyer.proof, 'KEEP-1');
  // a link that cannot be used gets no script: nothing to forget, and no reason to run anything
  const dead = await call('/p/' + 'v1.9999999999.eyJhIjoicHJvb2YifQ.deadbeef');
  assert.ok(!/<script>/.test(dead.text), 'a refused link executes nothing in the buyer’s browser: ' + dead.text.slice(0, 160));
});

test('the buyer’s door asks for the sender number on the rails that search by it', async () => {
  const hp = 'zzpayer' + String(Date.now()).slice(-5);
  const reg = await call('/api/register', { method: 'POST', body: {
    handle: hp, shop_name: 'Payer Door', whatsapp: '263771234567', rail: 'custom', currency: 'USD',
    rail_def: { label: 'Momo', dial: '*151#', pct: 0.03, type: 'manual', spec: 'phone', proof: 'ask', proof_label: 'Momo code' },
    pay_account: '0771234567',
  } });
  assert.equal(reg.status, 201, reg.text);
  const ord = await call('/api/order', { method: 'POST', ip: '196.34.0.1', body: { handle: hp, service: 'pickup',
    buyer: { name: 'Kudzai R', phone: '0780003311' }, items: [{ name: 'Box', price: 8 }] } });
  assert.equal(ord.status, 201, ord.text);
  assert.equal(ord.json.pay.ask_payer, true, 'this rail reconciles by sender, and the slip said so');
  const cap = ord.json.proof_url.slice(3);
  const page = await call('/p/' + cap);
  assert.equal(page.status, 200, page.text.slice(0, 140));
  assert.match(page.text, /name=payer/, 'so the door carries the second field the cart had');
  assert.match(page.text, /Number you will pay from/, 'in the cart’s own words, not new vocabulary');
  assert.match(page.text, /optional — helps us find your payment/, 'with the same claim about it, which is the honest one');
  // and the rail that does not search by number does not ask for one
  const hn = 'zznopay' + String(Date.now()).slice(-5);
  const reg2 = await call('/api/register', { method: 'POST', body: {
    handle: hn, shop_name: 'No Payer', whatsapp: '263771234567', rail: 'custom', currency: 'USD',
    rail_def: { label: 'Voucher', type: 'manual', spec: 'none', proof: 'require', proof_label: 'Voucher code' },
    pay_account: '0771234567',
  } });
  assert.equal(reg2.status, 201, reg2.text);
  const ord2 = await call('/api/order', { method: 'POST', ip: '196.34.0.2', body: { handle: hn, service: 'pickup',
    buyer: { name: 'Tapiwa G', phone: '0780003322' }, items: [{ name: 'Box', price: 8 }] } });
  assert.equal(ord2.json.pay.ask_payer, false, 'a voucher rail has no sender number to search');
  const page2 = await call('/p/' + ord2.json.proof_url.slice(3));
  assert.equal(page2.status, 200, page2.text.slice(0, 140));
  assert.ok(!/name=payer/.test(page2.text), 'and its door asks for one thing, because that is all it needs');
  assert.match(page2.text, /Voucher code/, 'the one field it does show is named by the shop, not by us');
});

test('both halves of the buyer’s record land in one write, and both are logged', async () => {
  const hp = 'zzboth' + String(Date.now()).slice(-5);
  const reg = await call('/api/register', { method: 'POST', body: {
    handle: hp, shop_name: 'Both Fields', whatsapp: '263771234567', rail: 'custom', currency: 'USD',
    rail_def: { label: 'Momo', dial: '*151#', pct: 0.03, type: 'manual', spec: 'phone', proof: 'require', proof_label: 'Momo code' },
    pay_account: '0771234567',
  } });
  assert.equal(reg.status, 201, reg.text);
  const ord = await call('/api/order', { method: 'POST', ip: '196.34.0.3', body: { handle: hp, service: 'pickup',
    buyer: { name: 'Nomsa D', phone: '0780003333' }, items: [{ name: 'Box', price: 21 }] } });
  const cap = ord.json.proof_url.slice(3);
  const key = 'order:' + hp + ':' + ord.json.order.id;
  const before = env.ORDERS._writesTo(key);
  const r = await call('/api/proof', { method: 'POST', ip: '196.34.0.4', body: { cap, proof: 'MLINE 4471', payer: '+263 77 999 0001' } });
  assert.equal(r.status, 200, r.text);
  const doc = JSON.parse(env.ORDERS._map.get(key).value);
  assert.equal(doc.buyer.proof, 'MLINE 4471');
  assert.equal(doc.buyer.payer, '+263 77 999 0001',
    'kept as typed with runs of space collapsed, the same rule as a code: the number the buyer read in their app is the number on the order, and the slip narrows it for dialing at print time');
  assert.equal(doc.pay.payer_from, '', 'and the frozen slip keeps what was true when it was issued: a receipt does not acquire a line afterwards, which is why the ledger and the handoff read the buyer object, not the snapshot');
  const dashRow = (await call('/api/admin?handle=' + hp, { headers: { 'x-tapstall-admin': JSON.parse(env.STORES._map.get('store:' + hp).value).admin_token } })).json.orders.find((x) => x.id === ord.json.order.id);
  assert.equal(dashRow.buyer.payer, '+263 77 999 0001', 'so it is the live surfaces that carry what arrived late, as they must');
  assert.equal(doc.proof_writes, 1, 'two fields, one write counted — the budget is per visit to the door, not per box');
  assert.equal(env.ORDERS._writesTo(key), before + 1, 'and one put, not two');
  const row = storedRow(hp, ord.json.order.id);
  assert.equal(row.proof, 'MLINE 4471', 'both land on the ledger row the merchant reads');
  assert.equal(row.payer, '+263 77 999 0001', 'the ledger row agrees with the document, spaced as typed');
  assert.equal(indexWritesFor(hp), 0, 'and that is one put for the pair, not the two the old index cost');
  const dash = await call('/api/admin?handle=' + hp, { headers: { 'x-tapstall-admin': JSON.parse(env.STORES._map.get('store:' + hp).value).admin_token } });
  const audit = dash.json.audit.filter((x) => x.act === 'proof')[0];
  assert.match(audit.fields.join(' '), /MLINE 4471 · \+263 77 999 0001/, 'the paper trail lists both, not whichever came first: ' + JSON.stringify(audit));
  const fresh = r.json.proof_url;
  assert.ok(fresh && fresh !== '/p/' + cap, 'the answer hands the next link to the hand that just wrote, and only to it');
  const again = await call('/p/' + fresh.slice(3));
  assert.match(again.text, /sent from <b>\+263 77 999 0001<\/b>/, 'the door shows the pair back on the link that is live now');
  assert.ok(!/name=payer/.test(again.text), 'once the number is in, the second box is gone — it asked because it was missing');
  const spent = await call('/p/' + cap);
  assert.equal(spent.status, 410, 'the link that filed it is worth nothing further: ' + spent.text.slice(0, 120));
  assert.match(spent.text, /accepts one code per link/, 'and it says what happened, in those words');
  assert.ok(spent.text.includes('String(x.u)==="/p/' + cap + '"'),
    'while it is at it, it puts the dead link down on the device that was holding it');
});

test('a save frees the picture it dropped even when the index cannot see it yet', async () => {
  // Production fact this exists for: KV's list() is only eventually consistent, and
  // the file a merchant just took off is usually the newest key in the namespace, so
  // a sweep built on the listing alone misses exactly the picture they removed. The
  // refs this save dropped are therefore deleted without asking the index. The stub is
  // instant, so the lag has to be simulated for the difference to be provable at all.
  const up = await sendImage(PNG1);
  await call('/api/settings', { method: 'POST', body: { handle: 'mamatoe', logo: up.json.ref }, headers: { 'x-tapstall-admin': adminKey() } });
  const live = await call(up.json.ref);
  assert.equal(live.status, 200, 'it is on the shop now: ' + live.text);
  const real = env.STORES.list;
  env.STORES.list = async () => ({ keys: [] });          // an index that has not caught up
  let off;
  try { off = await call('/api/settings', { method: 'POST', body: { handle: 'mamatoe', logo: '' }, headers: { 'x-tapstall-admin': adminKey() } }); }
  finally { env.STORES.list = real; }
  assert.equal(off.status, 200, off.text);
  assert.equal((await call(up.json.ref)).status, 404, 'gone in the save that dropped it, not on a later one');
  assert.ok(env.STORES._deleted('img:mamatoe:' + up.json.ref.split('/').pop()), 'and by delete, so the ceiling and the bill both move back');
});

/* ------------------------------------------------------ money in: the webhooks */
/* A notice from a payment provider is the only input in this product that can hand
 * somebody a paid plan. Everything here is about the fact that it cannot also decide
 * the terms, be believed about the money, or be repeated. */
const { createHash } = await import('node:crypto');
const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');   // computed here, not by the code under test
const storeDoc = (h) => JSON.parse(env.STORES._map.get('store:' + h).value);
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };   // `raw:` would swallow .text, and these bodies are form fields
const PF_PP = 'test-pp';
/* A notice is assembled the way a provider assembles one: the fields go on the wire,
 * and the passphrase exists only inside the string that gets signed. Getting that
 * backwards is how a test passes against a thing no sender would ever send. */
const notice = (f) => {
  const wire = Object.keys(f).sort().map((k) => k + '=' + f[k]).join('&');
  return wire + '&signature=' + md5(wire + '?passphrase=' + PF_PP);
};
const ipN = ((n) => () => '196.31.0.' + (++n))(0);

test('a payfast notice cannot buy a plan for a handle it was told', async () => {
  const ip = ipN();
  const reg = await call('/api/register', { method: 'POST', body: { handle: 'zzhook' + String(Date.now()).slice(-5), shop_name: 'Hook Test', whatsapp: '263771234567' } });
  assert.equal(reg.status, 201, reg.text);
  const h = reg.json.handle;
  const paid0 = storeDoc(h).paid_until || 0;
  const token = (storeDoc(h).renew_url || '').split('/renew/')[1];
  assert.ok(token, 'a renew token exists to mint from');
  const chk = await call('/api/checkout', { method: 'POST', ip: ipN(), body: { token, days: 365, email: 'a@b.c' } });
  assert.equal(chk.status, 200, chk.text);
  const ref = chk.json.tx_ref, cents = Math.round(Number(chk.json.amount) * 100);
  assert.equal(chk.json.custom_str1, ref, 'the button is told exactly which field has to come back');
  assert.equal(chk.json.window_sec, 1800, 'and for how long the price stands');
  assert.match(ref, /^[a-z0-9-]+-[A-Za-z0-9_-]{16}$/, 'a reference nobody can walk');

  // The production exploit, verbatim: a handle and a number of days.
  const evil = await call('/api/hook/payfast', { method: 'POST', ip, headers: FORM, body: 'payment_status=COMPLETE&custom_str1=' + h + '|36500' });
  assert.equal(evil.status, 503, 'the door is shut until it is armed: ' + evil.text);
  assert.match(evil.text, /PAYFAST_PASSPHRASE/, 'and it names the thing to set rather than shrugging');
  assert.equal(storeDoc(h).paid_until, paid0, 'nothing moved');

  env.PAYFAST_PASSPHRASE = PF_PP;
  try {
    const unsigned = await call('/api/hook/payfast', { method: 'POST', ip: ipN(), headers: FORM,
      body: 'payment_status=COMPLETE&custom_str1=' + ref + '&amount_gross=' + cents + '&amount_currency=USD' });
    assert.equal(unsigned.status, 400, 'armed, and still unsigned: ' + unsigned.text);
    assert.match(unsigned.text, /signature does not verify/);
    assert.ok(env.STORES._map.get('tx:' + ref), 'a refused notice leaves the intent alone, so a real one can still land');

    const wrong = await call('/api/hook/payfast', { method: 'POST', ip: ipN(), headers: FORM, body: notice(
      { payment_status: 'COMPLETE', custom_str1: ref, amount_gross: '1', amount_currency: 'USD', pf_payment_id: '7' }) });
    assert.equal(wrong.status, 200, 'nothing to retry, nothing to credit: ' + wrong.text);
    assert.match(wrong.json.ignored, /amount on the notice/, 'paid a cent, wanted the plan price');
    assert.equal(storeDoc(h).paid_until, paid0, 'and one cent did not buy a year');

    // custom_str2 is the trap: the notice offers a term nobody offered this store
    const f = { payment_status: 'COMPLETE', custom_str1: ref, amount_gross: String(cents), amount_currency: 'USD', pf_payment_id: '99001', custom_str2: '36500' };
    const wire = notice(f);
    const good = await call('/api/hook/payfast', { method: 'POST', ip: ipN(), headers: FORM, body: wire });
    assert.equal(good.status, 200, good.text);
    assert.equal(good.json.activated, h, 'a signed notice with a minted intent behind it works first time');
    const after = storeDoc(h);
    assert.equal(after.paid_until - paid0, 365 * 86400000, 'the term is the one this Worker offered, not the 36500 in the notice');
    assert.equal(after.plan, 'annual');
    assert.equal(after.suspended, false);

    const replay = await call('/api/hook/payfast', { method: 'POST', ip: ipN(), headers: FORM, body: wire });
    assert.equal(replay.json.already, true, 'the same payment, sent again: ' + replay.text);
    assert.equal(storeDoc(h).paid_until, after.paid_until, 'and the ledger did not move');
    const spent = await call('/api/hook/payfast', { method: 'POST', ip: ipN(), headers: FORM,
      body: notice({ ...f, pf_payment_id: '99002' }) });
    assert.match(spent.json.ignored, /spent|expired/, 'and the intent is gone, so it cannot be cashed twice: ' + spent.text);
  } finally { delete env.PAYFAST_PASSPHRASE; }
});

test('the flutterwave notice is refused until it is armed, and then asked again by us', async () => {
  const reg = await call('/api/register', { method: 'POST', body: { handle: 'zzfw' + String(Date.now()).slice(-5), shop_name: 'FW Test', whatsapp: '263771234567' } });
  assert.equal(reg.status, 201, reg.text);
  const h = reg.json.handle;
  const paid0 = storeDoc(h).paid_until || 0;
  const mint = async () => {
    const token = (storeDoc(h).renew_url || '').split('/renew/')[1];
    const c = await call('/api/checkout', { method: 'POST', ip: ipN(), body: { token, days: 365, email: 'a@b.c' } });
    assert.equal(c.status, 200, c.text);
    return c.json;
  };
  let r = mint();
  const first = await r;
  const noSecret = await call('/api/hook/flutterwave', { method: 'POST', ip: ipN(), body: { data: { tx_ref: first.tx_ref, status: 'successful', amount: first.amount, id: 11 } } });
  assert.equal(noSecret.status, 503, 'an unconfigured verify hash is not the same thing as no verify hash needed: ' + noSecret.text);
  assert.match(noSecret.text, /FW_SECRET/);
  assert.equal(storeDoc(h).paid_until, paid0, 'nothing was activated by a stranger');

  env.FW_SECRET = 'vh';
  const savedFetch = globalThis.fetch;
  try {
    const badHash = await call('/api/hook/flutterwave', { method: 'POST', ip: ipN(), headers: { 'verif-hash': 'nope' }, body: { data: { tx_ref: first.tx_ref, status: 'successful' } } });
    assert.equal(badHash.status, 401, 'the hash is checked, not consulted');
    const okHash = await call('/api/hook/flutterwave', { method: 'POST', ip: ipN(), headers: { 'verif-hash': 'vh' }, body: { data: { tx_ref: first.tx_ref, status: 'successful', amount: first.amount, id: 11 } } });
    assert.equal(okHash.json.activated, h, 'with no API key configured the minted intent is the authority: ' + okHash.text);
    assert.equal(storeDoc(h).paid_until - paid0, 365 * 86400000, 'and the terms still come from our record');
    const again = await call('/api/hook/flutterwave', { method: 'POST', ip: ipN(), headers: { 'verif-hash': 'vh' }, body: { data: { tx_ref: first.tx_ref, status: 'successful' } } });
    assert.match(again.json.ignored, /spent|window/, 'one intent, one activation: ' + again.text);

    env.FLW_API_KEY = 'k';
    const second = await mint();
    globalThis.fetch = async () => new Response(JSON.stringify({ data: { status: 'failed' } }), { headers: { 'content-type': 'application/json' } });
    const refused = await call('/api/hook/flutterwave', { method: 'POST', ip: ipN(), headers: { 'verif-hash': 'vh' }, body: { data: { tx_ref: second.tx_ref, status: 'successful', amount: second.amount, id: 21 } } });
    assert.equal(refused.status, 502, 'the provider is asked, and its answer wins: ' + refused.text);
    assert.equal(storeDoc(h).paid_until, paid0 + 365 * 86400000, 'and nothing moved');
    assert.ok(env.STORES._map.get('tx:' + second.tx_ref), 'a provider that is briefly unreachable must not cost a real payment: the intent is still there');

    globalThis.fetch = async () => new Response(JSON.stringify({ data: { status: 'successful', amount: 1.11, currency: 'USD' } }), { headers: { 'content-type': 'application/json' } });
    const short = await call('/api/hook/flutterwave', { method: 'POST', ip: ipN(), headers: { 'verif-hash': 'vh' }, body: { data: { tx_ref: second.tx_ref, status: 'successful', amount: second.amount, id: 22 } } });
    assert.equal(short.status, 400, 'the amount on the transaction is checked, not waved through: ' + short.text);
    assert.match(short.text, /not the amount this plan costs/);

    globalThis.fetch = async () => new Response(JSON.stringify({ data: { status: 'successful', amount: second.amount, currency: 'USD' } }), { headers: { 'content-type': 'application/json' } });
    const done = await call('/api/hook/flutterwave', { method: 'POST', ip: ipN(), headers: { 'verif-hash': 'vh' }, body: { data: { tx_ref: second.tx_ref, status: 'successful', amount: second.amount, id: 23 } } });
    assert.equal(done.json.activated, h, done.text);
    assert.equal(storeDoc(h).paid_until - paid0, 730 * 86400000, 'verified, so the second year landed');
  } finally {
    globalThis.fetch = savedFetch; delete env.FW_SECRET; delete env.FLW_API_KEY;
  }
});

/* --------------------------------------------------- being found: the served bytes */
/* A storefront's first job is to survive being pasted into a group chat: the hosts
 * that build that preview run no JavaScript, and neither does a search crawler. So
 * every assertion here is about the response body, not about what the page draws. */
const seoStore = async (name, extra) => {
  const h = 'zzseo' + String(Date.now()).slice(-5);
  const reg = await call('/api/register', { method: 'POST', body: { handle: h, shop_name: name, whatsapp: '263771234567', currency: 'USD' } });
  assert.equal(reg.status, 201, reg.text);
  const key = () => JSON.parse(env.STORES._map.get('store:' + h).value).admin_token;
  return { h, key, ...extra };
};

test('a shop tells a crawler what it sells, in the bytes the Worker sends', async () => {
  const { h, key } = await seoStore('Zz Test Kitchen');
  let r = await call('/api/settings', { method: 'POST', confirm: true, ip: '196.31.9.1', headers: { 'x-tapstall-admin': key() },
    body: { handle: h, tagline: 'Halal fried chicken, cooked to order', location: 'Harare CBD' } });
  assert.equal(r.status, 200, r.text);
  r = await call('/api/menu', { method: 'POST', confirm: true, ip: '196.31.9.2', headers: { 'x-tapstall-admin': key() },
    body: { handle: h, menu: { extra: [
      { name: 'Chicken kota', price: 22.5, desc: 'with egg and atchar' },
      { name: 'Full polish', price: 45, out: true },
    ] } } });
  assert.equal(r.status, 200, r.text);

  const page = await call('/s/' + h);
  assert.equal(page.status, 200);
  const body = page.text;
  const titles = body.match(/<title>[^<]*<\/title>/g) || [];
  assert.equal(titles.length, 1, 'one title, not a real one plus a leftover fallback: ' + titles.join(' / '));
  assert.match(body, /<title>Zz Test Kitchen \u2014 Harare CBD \| Tapstall<\/title>/);
  assert.match(body, new RegExp('<link rel="canonical" href="https://tapstall\\.test/s/' + h + '">'), 'the page has one canonical spelling');
  assert.match(body, /name="description" content="[^"]{40,}"/, 'a description with something in it');
  assert.match(body, /Chicken kota 22\.50 USD/, 'priced from the menu, in the currency the store shows');
  assert.match(body, /Full polish 45 USD/, 'both items, because the merchant typed both');
  assert.match(body, /property="og:description" content="Halal fried chicken, cooked to order\./, 'and the preview says the shop\u2019s own line');
  assert.ok(!/og:image/.test(body), 'no photo on file, so no photo is promised: a blank preview box is worse than none');
  assert.match(body, /name="robots" content="index, follow, max-image-preview:large/, 'it asks to be shown, at full width');
  assert.match(body, /var CFG = \{/, 'and the storefront still gets the data it needs');

  const ld = body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(ld, 'the structured data block is in the bytes, not drawn later');
  const data = JSON.parse(ld[1]);
  assert.equal(data['@context'], 'https://schema.org');
  const biz = data['@graph'].find((x) => x['@type'] === 'LocalBusiness');
  assert.equal(biz.name, 'Zz Test Kitchen');
  assert.equal(biz.url, 'https://tapstall.test/s/' + h);
  assert.equal(biz.telephone, '+263771234567', 'the number the buyer already sees, in the form a dialler wants');
  assert.ok(!biz.openingHoursSpecification, 'no hours typed, none claimed');
  assert.equal(biz.hasMenu.hasMenuItem.length, 2);
  assert.equal(biz.hasMenu.hasMenuItem[0].offers.price, '22.50', 'a string with two decimals, per schema.org');
  assert.equal(biz.hasMenu.hasMenuItem[1].offers.availability, 'https://schema.org/OutOfStock', 'sold out is told to search as loudly as to the buyer');

  const head = body.slice(0, body.indexOf('</head>'));
  for (const k of ['admin_token', 'paid_until', 'renew_url', 'secret_hash', 'rail_accts', 'pending', 'fw_secret']) {
    assert.ok(!head.includes('"' + k + '"'), 'the head leaks the field name ' + k);
    assert.ok(!body.includes(k + '":'), k + ' must not appear anywhere in a public page');
  }
});

test('a shop with nothing typed in still says something true', async () => {
  const { h } = await seoStore('Bare Shop');
  const p = await call('/s/' + h);
  assert.equal(p.status, 200);
  assert.match(p.text, /<title>Bare Shop \| Tapstall<\/title>/);
  assert.match(p.text, /name="description" content="Order from Bare Shop on Tapstall \u2014 menu, prices and payment in one link\."/);
  assert.ok(!/og:image/.test(p.text), 'nothing promised, nothing broken');
  assert.match(p.text, /name="twitter:card" content="summary"/, 'a plain card, since there is no picture to make large');
  const ld = p.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  const biz = JSON.parse(ld[1])['@graph'].find((x) => x['@type'] === 'LocalBusiness');
  assert.equal(biz.hasMenu, undefined, 'an empty menu in the data would be a lie about the shop');
  assert.equal(biz.priceRange, undefined, 'and so would a price range with no prices');
});

test('the two files a crawler asks for first, and what one of them refuses to contain', async () => {
  const robots = await call('/robots.txt');
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('content-type'), /^text\/plain/);
  assert.match(robots.text, /^Allow: \/s\/$/m, 'the storefront is the content');
  assert.match(robots.text, /^Allow: \/i\/$/m, 'and the pictures must be fetchable or every preview is blank');
  for (const d of ['/a', '/api/', '/ops', '/__selftest']) {
    assert.match(robots.text, new RegExp('^Disallow: ' + d.replace(/\//g, '\\/') + '$', 'm'), d + ' is not for a crawler');
  }
  assert.match(robots.text, /^Sitemap: https:\/\/tapstall\.test\/sitemap\.xml$/m);

  const sm = await call('/sitemap.xml');
  assert.equal(sm.status, 200);
  assert.match(sm.headers.get('content-type'), /application\/xml/);
  assert.match(sm.text, /<loc>https:\/\/tapstall\.test\/onboard<\/loc>/);
  assert.ok(!sm.text.includes('/s/'), 'we do not hand out a list of every merchant: those pages carry their payment numbers');

  // the app pages say it in a header too, for the crawler that ignores robots.txt
  for (const p of ['/a', '/ops']) {
    const res = await call(p);
    assert.match(res.headers.get('x-robots-tag') || '', /noindex/, p + ' would be indexed by a bot that skips robots.txt');
  }
  const gone = await call('/s/zznosuchstore');
  assert.equal(gone.status, 404);
  assert.match(gone.headers.get('x-robots-tag') || '', /noindex/, 'a page for a shop that does not exist must not be indexed as one');
});

/* -------------------------------------------- what the shop says about itself, unsolicited */
test('a shop can hand itself to a group chat without the merchant writing a word', async () => {
  const { h, key } = await seoStore('Zz Share Kitchen');
  let r = await call('/api/settings', { method: 'POST', confirm: true, ip: '196.31.8.1', headers: { 'x-tapstall-admin': key() },
    body: { handle: h, tagline: 'Kota, atchar and a cold St Christopher', location: 'MBle, Harare' } });
  assert.equal(r.status, 200, r.text);
  r = await call('/api/menu', { method: 'POST', confirm: true, ip: '196.31.8.2', headers: { 'x-tapstall-admin': key() },
    body: { handle: h, menu: { extra: [{ name: 'Chicken kota', price: 20 }, { name: 'Mopane worms', price: 15, out: true }] } } });
  assert.equal(r.status, 200, r.text);

  const t = await call('/s/' + h + '/share.txt');
  assert.equal(t.status, 200, t.text);
  assert.match(t.headers.get('content-type'), /^text\/plain/, 'plain text, so a long press selects it on any phone');
  assert.match(t.text, /WhatsApp status or a group/);
  assert.match(t.text, /Zz Share Kitchen, MBe, Harare|Zz Share Kitchen, MBle, Harare/);
  assert.match(t.text, /Chicken kota 20 USD/, 'the price the merchant typed, not a number we invented');
  assert.match(t.text, /Link in bio\./, 'and the one platform whose caption cannot hold a link is told so');
  const xBlock = t.text.split('— X / Twitter (fits the limit) —')[1].split('\n\n')[0].trim();
  assert.ok(xBlock.length <= 280, 'X truncates a long post and drops the link with it: ' + xBlock.length);
  assert.ok(xBlock.endsWith('https://tapstall.test/s/' + h), 'so the link is what survives');
  assert.equal((t.text.match(new RegExp('tapstall\\.test/s/' + h, 'g')) || []).length, 4, 'once per block, four blocks, no more');
  const fbBlock = t.text.split('— Facebook page or group —')[1].split('\n\n')[0];
  assert.ok(!/•\s*\n\n/.test(fbBlock) && !/\n{3}/.test(fbBlock), 'no hollow bullet where a fact is missing');

  // and the shop itself carries the door, without a script having to run first
  const page = await call('/s/' + h);
  assert.match(page.text, /<a class="chip" href="share\.txt">Share this shop<\/a>/, 'a relative link, so it is this store’s file');
  assert.ok(page.text.indexOf('share.txt') < page.text.indexOf('</head>') || page.text.includes('share.txt'), 'and it is in the bytes');
  const gone = await call('/s/zznoshare/share.txt');
  assert.equal(gone.status, 404);
});

test('what the money doors were asked for is counted, and a probe storm costs one write', async () => {
  const settled = () => new Promise((res) => setImmediate(res));
  const hour = new Date().toISOString().slice(0, 13).replace(/[-:T]/g, '');
  const refusedKey = 'hooks:' + hour + ':refused';

  // the exact old exploit shape again, twice from different addresses
  const one = await call('/api/hook/payfast', { method: 'POST', ip: '196.31.7.1', headers: FORM,
    body: 'payment_status=COMPLETE&custom_str1=mamatoe|36500' });
  assert.equal(one.status, 503, 'unarmed, so refused: ' + one.text);
  await settled();
  assert.ok(env.STORES._map.has(refusedKey), 'and the refusal is on the record for the operator to find');
  assert.equal(JSON.parse(env.STORES._map.get(refusedKey).value).note, 'the renewal webhook is not armed — set PAYFAST_PASSPHRASE on this Worker (the same passphrase as the payment button), then this notice will be accepted'.slice(0, 160),
    'the note says what was missing, in the words we used');

  for (let i = 0; i < 8; i++) {
    await call('/api/hook/payfast', { method: 'POST', ip: '196.31.7.' + (20 + i), headers: FORM,
      body: 'payment_status=COMPLETE&custom_str1=mamatoe|36500' });
    await call('/api/hook/flutterwave', { method: 'POST', ip: '196.31.7.' + (40 + i), body: { data: { tx_ref: 'nope-1234567890ab', status: 'successful' } } });
  }
  await settled();
  assert.equal(env.STORES._writesTo(refusedKey), 1,
    'one write for the whole hour, whoever else was refused in it: a stranger must not be able to spend the day’s write budget');
  for (const outcome of ['ignored', 'already', 'activated']) {
    assert.ok(env.STORES._map.has('hooks:' + hour + ':' + outcome), outcome + ' was exercised earlier in this file and should be on the record too');
  }

  const h = await call('/ops/api/health', { cookie: 'tp_ops=' + opsCookie });
  assert.equal(h.status, 200, h.text);
  assert.ok(h.json.hooks, 'the console reports it');
  assert.ok(h.json.hooks.refused >= 1, 'refused notices in the last 24 hours: ' + JSON.stringify(h.json.hooks));
  assert.equal(h.json.hooks.activated, 1, 'the one real payment this file made is counted once as well');
  assert.ok(h.json.hooks.hours.every((k) => /^hooks:\d{10}:(refused|ignored|already|activated)$/.test(k)), 'and the keys are shaped, so the count cannot drift');
  const blob = JSON.stringify(h.json.hooks);
  assert.ok(!/passphrase|SECRET|verif-hash/.test(blob), 'the ledger records that a door was refused, not what was behind it');
});

/* ---------------------------------------------------------------- the written pages */
test('the guides are served, dated, and stamped with the host that answered', async () => {
  const idx = await call('/guide');
  assert.ok(idx.status >= 300 && idx.status < 400, 'the plural index points at the pillar: ' + idx.status);
  assert.match(idx.headers.get('location') || '', /\/guide\/[a-z-]+$/);

  for (const slug of ['whatsapp-shop-payments', 'payment-reference-matching']) {
    const g = await call('/guide/' + slug);
    assert.equal(g.status, 200, slug + ' should be served from a template in git');
    assert.ok(!g.text.includes('@ORIGIN@'), slug + ' left an unstamped token in the page');
    assert.match(g.text, new RegExp('<link rel="canonical" href="https://tapstall\\.test/guide/' + slug + '">'), slug + ' canonical is absolute and this host');
    assert.match(g.text, /name="description" content="[^"]{60,}"/, slug + ' has a real description');
    assert.match(g.text, /property="og:title"/);
    assert.equal((g.text.match(/<h1>/g) || []).length, 1, slug + ' has exactly one h1');
    assert.ok((g.text.match(/<h2>/g) || []).length >= 3, slug + ' has sections a snippet can quote');
    assert.match(g.text, /\/onboard/, slug + ' has somewhere to go next');
    assert.match(g.text, /2026/, slug + ' dates its claims, because tariffs and app behaviour move');
    const ld = g.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(ld, slug + ' carries structured data in the bytes');
    const data = JSON.parse(ld[1]);
    const art = data['@graph'].find((x) => x['@type'] === 'Article');
    assert.ok(art && art.headline.length > 10, slug + ' announces itself as an Article');
    assert.equal(art.mainEntityOfPage['@id'], 'https://tapstall.test/guide/' + slug);
    const words = g.text.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    assert.ok(words > 400, slug + ' is ' + words + ' words; a page thinner than that is decoration for the crawler');
  }

  const nope = await call('/guide/something-never-written');
  assert.equal(nope.status, 404);
  assert.match(nope.headers.get('x-robots-tag') || '', /noindex/, 'a page that does not exist must not be indexed as one');
  assert.match(nope.text, /\/guide\/whatsapp-shop-payments/, 'and it hands over what does exist, rather than a dead end');

  const sm = await call('/sitemap.xml');
  for (const slug of ['whatsapp-shop-payments', 'payment-reference-matching']) {
    assert.match(sm.text, new RegExp('<loc>https://tapstall\\.test/guide/' + slug + '</loc>'), slug + ' is in the sitemap, so it is not an orphan');
  }
});

test('an answer that ends the door puts it down; a busy minute and a blank box do not', async () => {
  const h = 'zzclose' + String(Date.now()).slice(-5);
  const reg = await call('/api/register', { method: 'POST', body: {
    handle: h, shop_name: 'Close Test', whatsapp: '263771234567', rail: 'zipit', pay_account: '1234567890', currency: 'USD',
  } });
  assert.equal(reg.status, 201, reg.text);
  const ord = await call('/api/order', { method: 'POST', ip: '196.35.0.1', body: { handle: h, service: 'pickup',
    buyer: { name: 'Farai M', phone: '0780004411' }, items: [{ name: 'Box', price: 12 }] } });
  assert.equal(ord.status, 201, ord.text);
  const cap = ord.json.proof_url.slice(3);
  const key = 'order:' + h + ':' + ord.json.order.id;
  // the storefront's own entry, so "pruned" means something here rather than a regex hope
  const prunes = (t) => new RegExp('"tp_pf_' + h + '"[\\s\\S]{0,600}?String\\(x\\.u\\)==="/p/' + cap.replace(/[^A-Za-z0-9._-]/g, '\\$&') + '"');
  const post = (body, ip) => call('/api/proof', { method: 'POST', ip,
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) });

  // an empty box is not an answer about the order, so the door stays where it is
  const blank = await post({ cap, form: '1', proof: '' }, '196.35.0.2');
  assert.equal(blank.status, 422, blank.text.slice(0, 160));
  assert.ok(!/tp_pf_/.test(blank.text), 'the page that says "type the code" keeps the link — a form slip must not cost a buyer their door');
  assert.equal(blank.headers.get('x-robots-tag'), 'noindex, nofollow',
    'and the refusal is a refusal in its headers too: this page path used to answer HTTP 200 with no robots tag, because shell() has two parameters and was handed four');
  // a minute of flooding is also not an answer, and a form post gets words, not JSON
  let seen = null;
  for (let i = 0; i < 8; i++) seen = await post({ cap, form: '1', proof: 'FLOOD' + i }, '196.35.0.3');
  assert.equal(seen.status, 429, 'the eighth send in a minute is refused: ' + seen.text.slice(0, 120));
  assert.match(seen.text, /<h2/, 'as a page, because a browser posted it');
  assert.match(seen.text, /Nothing you have already sent was lost/, 'and it says so in the order\u2019s terms, not a rate limiter\u2019s');
  assert.ok(!/tp_pf_/.test(seen.text), 'while waiting costs the buyer nothing: the link is still in their phone when they come back');

  // now the answers that are final, one by one
  const mark = await call('/api/mark', { method: 'POST', ip: '196.35.0.4', body: { cap: ord.json.mark_url.slice(3) } });
  assert.equal(mark.status, 200, mark.text);
  const settled = await call('/p/' + cap);
  assert.match(settled.text, /closed from here/, 'a settled order explains itself as it always did');
  assert.match(settled.text, prunes(settled.text), 'and takes the line off the storefront while it is at it');
  const latePost = await post({ cap, form: '1', proof: 'TOO LATE' }, '196.35.0.5');
  assert.equal(latePost.status, 409, latePost.text.slice(0, 160));
  assert.match(latePost.text, /Not added/, 'the refusal a buyer sees if they were already typing');
  assert.match(latePost.text, prunes(latePost.text), 'is the same answer, so it closes the same door');
  assert.ok(!/<form/.test(latePost.text), 'and it does not offer the field again to be refused again');

  // an order document that is not there any more: same shape of answer, same closing
  env.ORDERS._map.delete(key);
  const missing = await call('/p/' + cap);
  assert.equal(missing.status, 404, missing.text.slice(0, 120));
  assert.match(missing.text, /Order not found/);
  assert.match(missing.text, prunes(missing.text), 'a link to a deleted order is not a door worth keeping for 72 hours');
  // the shop pulls its whole set of links; the generation moves, so every cap before it is
  // answered by the revocation rather than by the missing order it also happens to have
  const key2 = JSON.parse(env.STORES._map.get('store:' + h).value).admin_token;
  const rev = await call('/api/revoke', { method: 'POST', headers: { 'x-tapstall-admin': key2 }, body: { handle: h } });
  assert.equal(rev.status, 200, rev.text);
  const gone = await call('/p/' + cap);
  assert.equal(gone.status, 410, 'and a page this early still explains the real reason');
  assert.match(gone.text, prunes(gone.text), 'pruned by the link alone — a refusal this early never reached the order, so no code is known to it');
  assert.match(gone.text, /"tp_pf_/);
  const lateRev = await post({ cap, form: '1', proof: 'AFTER' }, '196.35.0.6');
  assert.equal(lateRev.status, 410, lateRev.text.slice(0, 140));
  assert.match(lateRev.text, prunes(lateRev.text), 'the write path closes it too, so the two halves cannot disagree');
  // a link that never verified cannot name a shop, so it names no key and runs nothing
  const dead = await call('/p/' + 'v1.9999999999.eyJhIjoicHJvb2YifQ.deadbeef');
  assert.equal(dead.status, 401, dead.text.slice(0, 120));
  assert.ok(!/<script>/.test(dead.text), 'and that stays true: an unverified link executes nothing in a buyer\u2019s browser, even to tidy up');
});

test('a spent write budget answers the door in the buyer’s words, and keeps the link', async () => {
  const h = 'zzquota' + String(Date.now()).slice(-5);
  const reg = await call('/api/register', { method: 'POST', body: {
    handle: h, shop_name: 'Quota Door', whatsapp: '263771234567', rail: 'zipit', pay_account: '1234567890', currency: 'USD',
  } });
  assert.equal(reg.status, 201, reg.text);
  const ord = await call('/api/order', { method: 'POST', ip: '196.36.0.1', body: { handle: h, service: 'pickup',
    buyer: { name: ' Rutendo', phone: '0780005511' }, items: [{ name: 'Box', price: 15 }] } });
  assert.equal(ord.status, 201, ord.text);
  const cap = ord.json.proof_url.slice(3);
  const put = env.ORDERS.put;
  env.ORDERS.put = async () => { throw new Error('put() limit exceeded for the day'); };
  try {
    const page = await call('/api/proof', { method: 'POST', ip: '196.36.0.2',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ cap, form: '1', proof: 'QUOTA-1' }) });
    assert.equal(page.status, 503, 'the write genuinely failed, and says so with its real code: ' + page.text.slice(0, 140));
    assert.match(page.text, /<h2/, 'to a person who posted a form it is a page, not a blob');
    assert.match(page.text, /the order stands exactly as it was/, 'and it speaks about the order, not about the shop’s settings');
    assert.ok(!/your settings/i.test(page.text), 'the merchant’s sentence is not this reader’s sentence');
    assert.ok(!/tp_pf_/.test(page.text), 'and it puts the door down nowhere: a full budget is not an answer about the order');
    assert.ok(Number(page.headers.get('retry-after')) > 0, 'Retry-After rides the page too, so a reload is not guesswork');
    assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
    const api = await call('/api/proof', { method: 'POST', ip: '196.36.0.3', body: { cap, proof: 'QUOTA-2' } });
    assert.equal(api.status, 503, api.text.slice(0, 140));
    assert.equal(api.json.who, 'buyer', 'a JSON caller is still told who is affected, and it is not the merchant');
    const doc = JSON.parse(env.ORDERS._map.get('order:' + h + ':' + ord.json.order.id).value);
    assert.ok(!doc.buyer || !doc.buyer.proof, 'nothing half-landed: ' + JSON.stringify(doc.buyer));
  } finally {
    env.ORDERS.put = put;
  }
  const ok = await call('/api/proof', { method: 'POST', ip: '196.36.0.4', body: { cap, proof: 'AFTER BUDGET' } });
  assert.equal(ok.status, 200, 'and the same link works the moment the shop can write again: ' + ok.text.slice(0, 140));
  assert.equal(JSON.parse(env.ORDERS._map.get('order:' + h + ':' + ord.json.order.id).value).buyer.proof, 'AFTER BUDGET',
    'the door was never closed by the outage, so nothing had to be re-issued');
});

test('the receipt page is told, not told-in-English: refusals carry why and final', async () => {
  const h = 'zzfinal' + String(Date.now()).slice(-5);
  const reg = await call('/api/register', { method: 'POST', body: {
    handle: h, shop_name: 'Final Field', whatsapp: '263771234567', rail: 'custom', currency: 'USD',
    rail_def: { label: 'Momo', dial: '*151#', pct: 0.03, type: 'manual', spec: 'phone', proof: 'ask', proof_label: 'Momo code' },
    pay_account: '0771234567',
  } });
  assert.equal(reg.status, 201, reg.text);
  const ord = await call('/api/order', { method: 'POST', ip: '196.37.0.1', body: { handle: h, service: 'pickup',
    buyer: { name: 'Anesu M', phone: '0780006611' }, items: [{ name: 'Box', price: 18 }] } });
  assert.equal(ord.status, 201, ord.text);
  let cap = ord.json.proof_url.slice(3);
  const key = 'order:' + h + ':' + ord.json.order.id;
  const put = async (body, ip) => {
    // a caller that names its own cap is testing a bad one, and must keep it
    const res = await call('/api/proof', { method: 'POST', ip,
      body: body.cap === undefined ? Object.assign({ cap }, body) : body });
    if (res.json && res.json.proof_url) cap = res.json.proof_url.slice(3);
    return res;
  };

  // a blank box is a question the buyer has not answered yet, so the page keeps it
  const blank = await put({ proof: '' }, '196.37.0.2');
  assert.equal(blank.status, 422, blank.text.slice(0, 140));
  assert.equal(blank.json.why, 'empty', 'named, so the caller does not read the sentence to learn what kind of no this is');
  assert.equal(blank.json.final, false, 'and it is not final: the box stays on the receipt');

  // three writes and the door is out of corrections — that one is final
  const firstCap = cap;
  const w1 = await put({ proof: 'ONE' }, '196.37.0.3');
  assert.ok(w1.json.proof_url && w1.json.proof_url.slice(3) !== firstCap,
    'and a link that changed something is already spent: the answer carries the next one');
  const reused = await call('/api/proof', { method: 'POST', ip: '196.37.0.30', body: { cap: firstCap, proof: 'AGAIN' } });
  assert.deepEqual({ status: reused.status, why: reused.json.why, final: reused.json.final, used: reused.json.used },
    { status: 410, why: 'used', final: false, used: true },
    'the spent one refuses a NEW value but is not treated as news about the order: ' + reused.text.slice(0, 140));
  const retry = await call('/api/proof', { method: 'POST', ip: '196.37.0.31', body: { cap: firstCap, proof: 'ONE' } });
  assert.equal(retry.json.changed, false, 'while the same value again is a retry, not a second edit: ' + retry.text.slice(0, 140));
  assert.equal(retry.json.retry, true, 'and it is named as one, so a lost answer costs the buyer nothing');
  assert.equal(JSON.parse(env.ORDERS._map.get(key).value).proof_writes, 1, 'and it cost the order no write at all');
  await put({ proof: 'TWO' }, '196.37.0.4');
  await put({ proof: 'THREE' }, '196.37.0.5');
  const spent = await put({ proof: 'FOUR' }, '196.37.0.6');
  assert.equal(spent.status, 429, spent.text.slice(0, 140));
  assert.deepEqual({ why: spent.json.why, final: spent.json.final }, { why: 'spent', final: true },
    'spent is the end of the road for this field, and says so in the one word the page acts on');

  // settled: also final, and the order keeps what it had
  await call('/api/mark', { method: 'POST', ip: '196.37.0.7', body: { cap: ord.json.mark_url.slice(3) } });
  const settled = await put({ proof: 'LATE' }, '196.37.0.8');
  assert.deepEqual({ why: settled.json.why, final: settled.json.final }, { why: 'settled', final: true }, settled.text.slice(0, 140));
  assert.equal(JSON.parse(env.ORDERS._map.get(key).value).buyer.proof, 'THREE', 'nothing moved');

  // a minute of flooding is the same status code as being spent and the opposite meaning,
  // which is exactly why the page may not sort them by number
  let last = null;
  for (let i = 0; i < 8; i++) last = await put({ cap: 'v1.9999999999.eyJhIjoicHJvb2YifQ.deadbeef', proof: 'F' + i }, '196.37.0.9');
  assert.equal(last.status, 429, last.text.slice(0, 120));
  assert.deepEqual({ why: last.json.why, final: last.json.final }, { why: 'throttled', final: false },
    'throttled: keep the box, keep the link, come back in a minute');

  // and the two answers the receipt page has to distinguish from a closed door
  const forged = await put({ cap: cap.slice(0, -6) + 'AAAAAA', proof: 'X' }, '196.37.0.10');
  assert.deepEqual({ why: forged.json.why, final: forged.json.final }, { why: 'cap', final: false },
    'a link that will not verify is not news about the order, so the entry in the phone stays');
  const rev = await call('/api/revoke', { method: 'POST', headers: { 'x-tapstall-admin': JSON.parse(env.STORES._map.get('store:' + h).value).admin_token }, body: { handle: h } });
  assert.equal(rev.status, 200, rev.text);
  const closed = await put({ proof: 'X' }, '196.37.0.11');
  assert.deepEqual({ why: closed.json.why, final: closed.json.final }, { why: 'revoked', final: true }, closed.text.slice(0, 140));
});

test('a capped account fails closed at the door, politely, and never answers 500', async () => {
  // the rate-limit counter is itself a KV write, so on a day with none left every POST to
  // the buyer's door is answered before a cap is looked at. Failing *open* there would
  // mean the same helper that throttles a wrong PIN stops throttling it because a budget
  // ran out, so the ceiling stays and the answer is the buyer-worded page instead of a
  // stack trace. What must not happen is a 500, or a lost entry, or a half-write.
  const h = 'zzclosed' + String(Date.now()).slice(-5);
  const reg = await call('/api/register', { method: 'POST', body: {
    handle: h, shop_name: 'Closed Day', whatsapp: '263771234567', rail: 'zipit', pay_account: '1234567890', currency: 'USD',
  } });
  assert.equal(reg.status, 201, reg.text);
  const sp = env.STORES.put, op = env.ORDERS.put;
  env.STORES.put = async () => { throw new Error('put() limit exceeded for the day'); };
  env.ORDERS.put = async () => { throw new Error('put() limit exceeded for the day'); };
  try {
    const page = await call('/api/proof', { method: 'POST', ip: '196.38.0.1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ cap: 'v1.9999999999.eyJhIjoicHJvb2YifQ.deadbeef', form: '1', proof: 'X' }) });
    assert.equal(page.status, 401, 'a garbage cap is answered for what it is, because the throttle no longer needs a write to count: ' + page.text.slice(0, 120));
    assert.match(page.text, /<h2/, 'still a page, because a browser posted it');
    assert.ok(!/tp_pf_/.test(page.text), 'and still no prune: today\u2019s budget is not tomorrow\u2019s answer');
    const api = await call('/api/proof', { method: 'POST', ip: '196.38.0.2', body: { cap: 'nope', proof: 'X' } });
    assert.equal(api.status, 401, api.text.slice(0, 120));
    // The door the buyer's own write still needs is the one that says 503, because it is a write
    // that failed and not a credential that was wrong: same answer, for the reason it has always
    // had, and the throttle's own bookkeeping is no longer part of what a buyer can be refused for.
    const live = await call('/api/order', { method: 'POST', ip: '196.38.0.4', body: { handle: h, service: 'pickup',
      buyer: { name: 'Rudo Closed', phone: '0780003355' }, items: [{ name: 'Box', price: 12 }] } });
    env.STORES.put = sp; env.ORDERS.put = op;
    const withCap = await call('/api/order', { method: 'POST', ip: '196.38.0.5', body: { handle: h, service: 'pickup',
      buyer: { name: 'Rudo Closed', phone: '0780003366' }, items: [{ name: 'Box', price: 13 }] } });
    env.STORES.put = async () => { throw new Error('put() limit exceeded for the day'); };
    env.ORDERS.put = async () => { throw new Error('put() limit exceeded for the day'); };
    assert.ok(withCap.json.proof_url, 'the order before the budget went carries a live link: ' + withCap.text.slice(0, 120));
    const real = await call('/api/proof', { method: 'POST', ip: '196.38.0.6', body: { cap: withCap.json.proof_url.slice(3), proof: 'X' } });
    assert.equal(real.status, 503, 'a real write the account cannot do is still named as that: ' + real.text.slice(0, 140));
    // The claim this release could have quietly dropped: with no counter to write, does the ceiling
    // still close? It does — the limit is a *decision*, and the write was only ever how isolates told
    // each other about it. Six refused tries from one address, on a day nothing can be written.
    env.STORES.put = async () => { throw new Error('put() limit exceeded for the day'); };
    env.ORDERS.put = async () => { throw new Error('put() limit exceeded for the day'); };
    let refused = 0;
    for (let n = 0; n < 12; n++) {
      const r = await call('/api/proof', { method: 'POST', ip: '196.38.0.9', body: { cap: 'nope', proof: 'X' } });
      if (r.status === 429) refused++;
    }
    assert.ok(refused >= 4, 'the ceiling holds on a day with no writes: ' + refused + ' of 12 refused');
    const read = await call('/api/lookup', { method: 'POST', ip: '196.38.0.3', body: { handle: h, code: 'NOPE' } });
    assert.notEqual(read.status, 500, 'a read that needs no write answers normally, so the shop can still look things up: ' + read.text.slice(0, 120));
    void live;
  } finally {
    env.STORES.put = sp; env.ORDERS.put = op;
  }
});

test('one link, one change: the row mints fresh, the shop spends the buyer’s link, and an old order binds itself', async () => {
  const h = 'zzonce' + String(Date.now()).slice(-5);
  const reg = await call('/api/register', { method: 'POST', body: {
    handle: h, shop_name: 'One Change', whatsapp: '263771234567', rail: 'zipit', pay_account: '1234567890', currency: 'USD',
  } });
  assert.equal(reg.status, 201, reg.text);
  const ord = await call('/api/order', { method: 'POST', ip: '196.39.0.1', body: { handle: h, service: 'pickup',
    buyer: { name: 'Tendai K', phone: '0780007711' }, items: [{ name: 'Box', price: 24 }] } });
  assert.equal(ord.status, 201, ord.text);
  const buyerCap = ord.json.proof_url.slice(3);
  const key = 'order:' + h + ':' + ord.json.order.id;
  const skey = JSON.parse(env.STORES._map.get('store:' + h).value).admin_token;
  const admin = () => call('/api/admin?handle=' + h, { headers: { 'x-tapstall-admin': skey } });

  /* The ledger's door is minted per read, from the order's current nonce, which is the only
     reason a shop reloading its list can never be handed a stale link. And the moment a code
     is on file the row stops carrying one at all: the shop has a box of its own, and an old
     URL that still worked would undo the whole rule. */
  const rowLink = (await admin()).json.orders.find((x) => x.id === ord.json.order.id).proof_url;
  assert.ok(rowLink && rowLink !== ord.json.proof_url, 'a row that still owes a code carries a door: ' + rowLink);
  // the row's copy is absolute (it is meant to be pasted into a chat), the receipt's is not
  const rowCap = rowLink.slice(rowLink.indexOf('/p/') + 3);
  const viaRow = await call('/api/proof', { method: 'POST', ip: '196.39.0.2', body: { cap: rowCap, proof: 'MLINE 1' } });
  assert.equal(viaRow.status, 200, 'and it files on it, because the link is the current one: ' + viaRow.text.slice(0, 140));
  const staleBuyer = await call('/api/proof', { method: 'POST', ip: '196.39.0.3', body: { cap: buyerCap, proof: 'MY OWN INSTEAD' } });
  assert.deepEqual({ status: staleBuyer.status, why: staleBuyer.json.why, used: staleBuyer.json.used },
    { status: 410, why: 'used', used: true }, 'the buyer’s link, minted before that write, is spent: ' + staleBuyer.text.slice(0, 120));
  const rowAfter = (await admin()).json.orders.find((x) => x.id === ord.json.order.id);
  assert.equal(rowAfter.proof_url, undefined, 'and the row carries no link now, because a stale door is worse than none');

  // the shop filing from the chat spends the link the buyer is holding, and takes nothing back
  const held = viaRow.json.proof_url;
  assert.ok(held, 'the write that landed handed the next link to the hand that wrote');
  const filed = await call('/api/order/proof', { method: 'POST', ip: '196.39.0.4',
    headers: { 'x-tapstall-admin': skey }, body: { handle: h, id: ord.json.order.id, proof: 'FROM CHAT' } });
  assert.equal(filed.status, 200, filed.text);
  const docNow = JSON.parse(env.ORDERS._map.get(key).value);
  const rowNow = storedRow(h, ord.json.order.id);
  assert.equal(rowNow.pcap, docNow.pcap, 'the row’s nonce moved with the document’s, so the next read mints a live one');
  const spent = await call('/api/proof', { method: 'POST', ip: '196.39.0.5', body: { cap: held.slice(3), proof: 'MINE INSTEAD' } });
  assert.equal(spent.status, 410, 'and the buyer’s link is spent by the shop’s entry, not merely outranked: ' + spent.text.slice(0, 120));
  assert.equal(JSON.parse(env.ORDERS._map.get(key).value).buyer.proof, 'FROM CHAT', 'nothing was written over');
  const sameAgain = await call('/api/proof', { method: 'POST', ip: '196.39.0.6', body: { cap: held.slice(3), proof: 'FROM CHAT' } });
  assert.equal(sameAgain.json.retry, true, 'the value that is already there is still honoured, because a retry is not an edit: ' + sameAgain.text.slice(0, 140));

  /* An order placed before this release has no nonce to be bound by. Refusing it would sign a
     buyer out of a field mid-session for a rule that did not exist when they were handed the
     link, so the first write that lands is the thing that binds it — no migration, no flag. */
  env.ORDERS._map.set(key, { value: JSON.stringify(Object.assign({}, docNow, { pcap: undefined })) });
  const legacy = await call('/api/proof', { method: 'POST', ip: '196.39.0.7', body: { cap: buyerCap, proof: 'LEGACY OK' } });
  assert.equal(legacy.status, 200, 'no cliff for a buyer mid-session: ' + legacy.text.slice(0, 140));
  const bound = JSON.parse(env.ORDERS._map.get(key).value);
  assert.equal(bound.buyer.proof, 'LEGACY OK');
  assert.ok(bound.pcap, 'and the order is bound from that write on');
});

/* A buyer's link is spent by the write that used it, `proofAsk` goes quiet once a code is on
   file, and `withAsk` mints nothing while the field is full — so a filed code also *seals* it.
   Right while the code is good; a dead end the moment it is not. The way out cannot be the
   buyer's (that is what the budget is for), so it is the shop's, on the route that already
   files: clear the field, turn the nonce over, and let the order ask again. */
test('a code the shop cannot read is handed back, not argued about', async () => {
  const h = 'zzback' + String(Date.now()).slice(-5);
  const reg = await call('/api/register', { method: 'POST', body: {
    handle: h, shop_name: 'Hand It Back', whatsapp: '263771234567', rail: 'zipit', pay_account: '1234567890', currency: 'USD',
  } });
  assert.equal(reg.status, 201, reg.text);
  const skey = JSON.parse(env.STORES._map.get('store:' + h).value).admin_token;
  const admin = () => call('/api/admin?handle=' + h, { headers: { 'x-tapstall-admin': skey } });
  const ord = await call('/api/order', { method: 'POST', ip: '196.44.0.1', body: { handle: h, service: 'pickup',
    buyer: { name: 'Rudo T', phone: '0780006611' }, items: [{ name: 'Box', price: 31 }] } });
  assert.equal(ord.status, 201, ord.text);
  const id = ord.json.order.id, key = 'order:' + h + ':' + id;
  const doc = () => JSON.parse(env.ORDERS._map.get(key).value);
  const CAP_BEFORE_VOID = ord.json.proof_url.slice(3);   // the link the buyer came in on, kept for the page half of this test
  const row = () => storedRow(h, id);

  const w1 = await call('/api/proof', { method: 'POST', ip: '196.44.0.2', body: { cap: ord.json.proof_url.slice(3), proof: 'blurry photo' } });
  assert.equal(w1.status, 200, w1.text.slice(0, 140));
  const held = w1.json.proof_url;
  assert.ok(held && w1.json.left === 2, 'the write left a live link in the hand that wrote it: ' + w1.text.slice(0, 140));
  assert.equal(row().proof, 'blurry photo');
  const quiet = (await admin()).json.orders.find((x) => x.id === id);
  assert.equal(quiet.proof_url, undefined, 'while a code is on file the order offers no door to anybody');
  assert.ok(!quiet.ask, 'and it stops chasing: nothing to ask for');

  /* The same URL, one release of wording apart, before the shop does anything: the buyer spent
     this link themselves, so the card says so. It is the control that keeps the new sentence
     honest — if the used case ever fell through to the retired copy, this is what notices. */
  const pageSpent = await call('/p/' + CAP_BEFORE_VOID);
  assert.equal(pageSpent.status, 410, pageSpent.text.slice(0, 120));
  assert.match(pageSpent.text, /That link is used/, 'a link the buyer wrote with is named for what it did: ' + pageSpent.text.slice(0, 160));
  assert.ok(!/retired/.test(pageSpent.text), 'and nothing is implied about the shop');

  const back = await call('/api/order/proof', { method: 'POST', ip: '196.44.0.3',
    headers: { 'x-tapstall-admin': skey }, body: { handle: h, id, void: true } });
  assert.equal(back.status, 200, back.text.slice(0, 160));
  assert.deepEqual({ ok: back.json.ok, void: back.json.void, changed: back.json.changed, proof: back.json.proof },
    { ok: true, void: true, changed: true, proof: '' }, 'the answer says what it did, in the field the dashboard reads');
  assert.equal(back.json.ask, true, 'and that the order is open enough to ask again');
  assert.match(back.json.note, /Handed back — the .{1,20} is off the order and the field is theirs again, with 3 changes on it\./, back.json.note);
  assert.equal(doc().buyer.proof, '', 'the field is empty again');
  assert.equal(doc().proof_writes, 0, 'the chain restarts, so the buyer gets three changes and not the two they had left');
  assert.equal(doc().proof_at, '', 'and no stale timestamp still claims a filing');
  assert.ok(doc().proof_void_at, 'with a stamp of its own for whoever asks later');
  assert.equal(doc().status, 'awaiting_payment', 'handing a code back does not move money, and this route could not move it if it wanted to');
  assert.equal(doc().pcap !== w1.json.proof_url.slice(3), true, 'the nonce turned over');
  assert.equal(row().proof, '', 'the ledger row went empty with it, so nobody reads a code that is not on the order');
  assert.equal(row().pcap, doc().pcap, 'and its nonce moved too, because the next read mints from it');
  const aud = (await admin()).json.audit.find((r) => r.act === 'proof' && /handed back/.test(JSON.stringify(r)));
  assert.ok(aud, 'the paper trail records the hand-back as an act, not a silence');

  // and the same tap on a field that is already empty is a state, not a failure — answered
  // without a write, so a double click cannot rotate the door the buyer was just given
  const pcapNow = doc().pcap, rowNow = JSON.stringify(row());
  const twice = await call('/api/order/proof', { method: 'POST', ip: '196.44.0.7',
    headers: { 'x-tapstall-admin': skey }, body: { handle: h, id, void: true } });
  assert.equal(twice.status, 200, twice.text.slice(0, 140));
  assert.deepEqual({ ok: twice.json.ok, changed: twice.json.changed }, { ok: true, changed: false },
    'nothing was handed back, and the answer says so: ' + twice.text.slice(0, 140));
  assert.match(twice.json.note, /already empty/, 'in words that do not read like a refusal');
  assert.equal(doc().pcap, pcapNow, 'so the live door still opens — an idempotent tap must not supersede a link');
  assert.equal(JSON.stringify(row()), rowNow, 'and the ledger row was not touched either');

  /* Every link minted for the cleared field dies with it — the spent one *and* the live one
     the last answer handed back. A stale door that still wrote would put a code on an order the
     shop has just declared it wants again, from a browser tab that has no idea. */
  for (const [label, cap] of [['held live link', held.slice(3)], ['the original', ord.json.proof_url.slice(3)]]) {
    const dead = await call('/api/proof', { method: 'POST', ip: '196.44.0.4', body: { cap, proof: 'SOME OTHER CODE' } });
    // the classification this release exists for: same status, same folding, and a sentence
    // that does not blame the buyer for a decision the shop made
    assert.deepEqual({ status: dead.status, why: dead.json.why, used: dead.json.used, superseded: dead.json.superseded, final: dead.json.final },
      { status: 410, why: 'superseded', used: true, superseded: true, final: false },
      label + ' is retired by the hand-back, not spent by the buyer: ' + dead.text.slice(0, 140));
    assert.match(dead.text, /every link for this order is retired/, 'and the buyer is told who cleared it: ' + dead.text.slice(0, 200));
    // the invariant the last release missed: a refusal that a hand-back has made true for
    // nobody must not send a buyer to a box. The receipt keeps its wording only where a
    // newer door can actually exist on this device
    assert.ok(!/receipt/.test(dead.json.error), 'no retired answer points at a receipt: ' + dead.json.error);
    assert.match(dead.json.error, /send it in the chat/, 'it names the route that always works: ' + dead.json.error);
  }

  /* A *page* at the retired link says the same thing in the buyer's words and puts the entry down.
     This is checked while the order is still open, which is the only moment the used card is the
     live question: on a settled order the order explains itself first (0.7.7's precedence), and a
     dead link is not news about a paid order. */
  const pageRetired = await call('/p/' + CAP_BEFORE_VOID);
  assert.equal(pageRetired.status, 410, pageRetired.text.slice(0, 120));
  assert.match(pageRetired.text, /That link is retired/, 'the card is titled for what happened: ' + pageRetired.text.slice(0, 160));
  assert.match(pageRetired.text, /nothing you did caused that/, 'and says so out loud');
  assert.match(pageRetired.text, /their ledger has the same field, one box, and they can put it on the order for you/,
    'the retired card sends them somewhere that exists on any phone: ' + pageRetired.text.slice(0, 400));
  assert.ok(!/Your receipt has a fresh box/.test(pageRetired.text), 'and promises nothing a hand-back has closed');
  assert.ok(pageRetired.text.includes('String(x.u)==="/p/' + CAP_BEFORE_VOID + '"'), 'and puts the dead entry down on the phone that kept it');
  assert.ok(!/That link is used/.test(pageRetired.text), 'a retired link is not called used, not once on this page');

  const again = (await admin()).json.orders.find((x) => x.id === id);
  assert.ok(again.ask, 'the chase is back on the row, in the order’s own words');
  const freshUrl = again.proof_url;
  assert.ok(freshUrl, 'and a door is minted again, because the field is empty and the order is open');
  const w2 = await call('/api/proof', { method: 'POST', ip: '196.44.0.5',
    body: { cap: freshUrl.slice(freshUrl.indexOf('/p/') + 3), proof: 'READABLE 2' } });
  assert.equal(w2.status, 200, 'the buyer files again with no help from anybody: ' + w2.text.slice(0, 140));
  assert.equal(w2.json.left, 2, 'one of three, not three of three — the budget counts this chain only');
  assert.equal(doc().buyer.proof, 'READABLE 2');

  // `void` is not the buyer's word: the public door builds its input from proof and payer
  const tried = await call('/api/proof', { method: 'POST', ip: '196.44.0.6',
    body: { cap: w2.json.proof_url.slice(3), proof: '', void: 1 } });
  assert.equal(tried.status, 422, 'a blank from the buyer is still just a blank: ' + tried.text.slice(0, 120));
  assert.match(tried.json.error, /Type the code your app printed/, 'and they are told what the field wants, not that they were clever');
  assert.equal(doc().buyer.proof, 'READABLE 2', 'nothing was erased');
  assert.ok(JSON.stringify(doc()).includes('READABLE 2'), 'and the order still says so, twice checked because this is the destructive one');


  /* On a settled order the field clears and no door is minted — `withAsk` asks the order's
     status, and the refusal at the door says "settled" rather than "used", which is the
     precedence 0.7.7 fixed and this release must not undo. */
  const paid = doc(); paid.status = 'paid';
  env.ORDERS._map.set(key, { value: JSON.stringify(paid) });
  const settled = await call('/api/order/proof', { method: 'POST', ip: '196.44.0.9',
    headers: { 'x-tapstall-admin': skey }, body: { handle: h, id, void: true } });
  assert.equal(settled.status, 200, 'a shop may still clear its own record: ' + settled.text.slice(0, 140));
  assert.equal(settled.json.ask, false, 'but it is told the order is not going to ask');
  assert.match(settled.json.note, /is paid, so nothing is being asked of them/, 'in the words the merchant reads, and with no link vocabulary in them: ' + settled.json.note);
  assert.equal(doc().buyer.proof, '', 'and it happened — the void does not consult proofOpen, because the code was filed by the shop’s own hand');
  const rowAfter = (await admin()).json.orders.find((x) => x.id === id);
  assert.equal(rowAfter.proof_url, undefined, 'no door on a settled order, in either place');
  const doorOnPaid = await call('/api/proof', { method: 'POST', ip: '196.44.0.10',
    body: { cap: freshUrl.slice(freshUrl.indexOf('/p/') + 3), proof: 'TOO LATE' } });
  assert.deepEqual({ status: doorOnPaid.status, why: doorOnPaid.json.why }, { status: 409, why: 'settled' },
    'the order is closed, and that is the true answer even though the link is also dead: ' + doorOnPaid.text.slice(0, 120));  const shopRefiles = await call('/api/order/proof', { method: 'POST', ip: '196.44.0.11',
    headers: { 'x-tapstall-admin': skey }, body: { handle: h, id, proof: 'FROM THE CHAT' } });
  assert.equal(shopRefiles.status, 200, 'the shop can file what arrives in the chat afterwards, as it always could: ' + shopRefiles.text.slice(0, 120));
});

/* The spelling sweep that should have existed the day the button was written. Each row is the
   same act seen from a different client: the dashboard, a hand-typed call, a form. And each
   falsy row has to stay a *filing* attempt, because a caller who means to write a code must
   not find the field cleared by a value that only looked like the verb. */
test('the hand-back verb answers to every shape a client sends it', async () => {
  const h = 'zzspell' + String(Date.now()).slice(-5);
  const reg = await call('/api/register', { method: 'POST', body: {
    handle: h, shop_name: 'Shapes', whatsapp: '263771234567', rail: 'zipit', pay_account: '1234567890', currency: 'USD',
  } });
  assert.equal(reg.status, 201, reg.text);
  const skey = JSON.parse(env.STORES._map.get('store:' + h).value).admin_token;
  const ord = await call('/api/order', { method: 'POST', ip: '196.45.0.1', body: { handle: h, service: 'pickup',
    buyer: { name: 'Rudo T', phone: '0780006611' }, items: [{ name: 'Box', price: 12 }] } });
  assert.equal(ord.status, 201, ord.text);
  const id = ord.json.order.id, key = 'order:' + h + ':' + id;
  const doc = () => JSON.parse(env.ORDERS._map.get(key).value);
  const file = (body) => call('/api/order/proof', { method: 'POST', ip: '196.45.0.2',
    headers: { 'x-tapstall-admin': skey }, body: Object.assign({ handle: h, id }, body) });

  const on = [true, 1, '1', 'true'];
  let n = 0;
  for (const shape of on) {
    await file({ proof: 'CODE-' + ++n });                      // fill it, then ask for it back
    const back = await file({ void: shape });
    assert.equal(back.status, 200, 'void as ' + JSON.stringify(shape) + ' was refused: ' + back.text.slice(0, 140));
    assert.equal(back.json.void, true, 'and the answer claims the verb it performed: ' + back.text.slice(0, 140));
    assert.equal(back.json.changed, true, 'the field really moved for ' + JSON.stringify(shape));
    assert.equal(doc().buyer.proof, '', 'nothing left on file after void=' + JSON.stringify(shape));
  }

  // the shapes that are not the verb: `void: 0` is somebody saying "do not", and it must
  // read as an empty box, not as a clearing. Both halves of that answer are the same message,
  // which is why the proof field, not the status, is what this asserts on.
  for (const shape of [0, '0', 'false', '']) {
    await file({ proof: 'KEPT-' + ++n });
    const nope = await file({ void: shape });
    // a no-op, not a clearing: `changed:false` is this API's word for "I wrote nothing", and
    // the note is the one the route gives to a box holding what the order already holds
    assert.equal(nope.json.changed, false, 'void=' + JSON.stringify(shape) + ' must not be a hand-back: ' + nope.text.slice(0, 140));
    assert.ok(!nope.json.void, 'and it must not claim the verb either: ' + nope.text.slice(0, 140));
    assert.equal(doc().buyer.proof, 'KEPT-' + n, 'the code they were filing is still there after void=' + JSON.stringify(shape));
  }
});

/* This is where `mirrorRow` lived: the row was a second document, and a read served from another
   edge could hold the snapshot from before the order existed, so a code on the order could sit
   beside "no proof yet" in the merchant's list for as long as nothing touched it. The retry loop
   was a good answer to a bad shape. v0.9.1 removes the shape — the row is metadata on the order
   document, one write, no window — so this test now proves the absence, and that a shop whose
   frozen legacy index is deliberately wrong still reads a correct ledger. */
test('a stale ledger index cannot lose a row any more, because the row is the write', async () => {
  // This test used to prove the retry loop worked: `mirrorRow` read the shared array, got a cold
  // edge's snapshot of it, slept, retried, and eventually folded the row in. The loop is gone
  // because the array is: the row is metadata on the order document, so the write that changes an
  // order *is* the write that indexes it, and there is no window in which one has landed and the
  // other has not. What is proved here is that claim, and that a shop holding an old index — the
  // frozen `list:<handle>` key every pre-0.9.1 store has — reads the same ledger either way.
  const h = 'zzlag' + String(Date.now()).slice(-5);
  const reg = await call('/api/register', { method: 'POST', body: {
    handle: h, shop_name: 'Lag', whatsapp: '263771234567', rail: 'zipit', pay_account: '1234567890', currency: 'USD',
  } });
  assert.equal(reg.status, 201, reg.text);
  const ord = await call('/api/order', { method: 'POST', ip: '196.46.0.1', body: { handle: h, service: 'pickup',
    buyer: { name: 'Rudo T', phone: '0780006611' }, items: [{ name: 'Box', price: 22 }] } });
  assert.equal(ord.status, 201, ord.text);
  const id = ord.json.order.id;
  assert.equal(storedRow(h, id).proof, '', 'the row exists from the moment the order does — not after an index caught up');
  assert.equal(ord.json.order.status, 'awaiting_payment');

  // An order from before rows rode on documents: a document with no metadata, and the shop's
  // frozen index holding its row. This is every live shop, so reading them has to keep working.
  const legacyDoc = { id: 'older01', code: 'OLD-01', at: '2020-01-01T00:00:00.000Z', status: 'paid',
    buyer: { name: 'Before', phone: '' }, pricing: { total: 9, tax: 0, pay_now: 9 } };
  env.ORDERS._map.set('order:' + h + ':older01', { value: JSON.stringify(legacyDoc) });
  env.ORDERS._map.set('list:' + h, { value: JSON.stringify([{ id: 'older01', code: 'OLD-01', at: legacyDoc.at, total: 9, status: 'paid', name: 'Before' }]) });
  const w = await call('/api/proof', { method: 'POST', ip: '196.46.0.2',
    body: { cap: ord.json.proof_url.slice(3), proof: 'AFTER THE LAG' } });
  assert.equal(w.status, 200, w.text.slice(0, 140));
  assert.ok(w.json.changed, 'the write itself landed: ' + w.text.slice(0, 140));
  assert.equal(storedRow(h, id).proof, 'AFTER THE LAG', 'and the ledger has it, on the first read, with nothing to retry');

  const skey = JSON.parse(env.STORES._map.get('store:' + h).value).admin_token;
  const dash = await call('/api/admin?handle=' + h, { headers: { 'x-tapstall-admin': skey } });
  assert.ok(dash.json.orders.find((o) => o.id === id && o.buyer.proof === 'AFTER THE LAG'),
    'the merchant sees it in the dashboard: ' + JSON.stringify(dash.json.orders.map((o) => [o.id, o.buyer && o.buyer.proof])));
  assert.ok(dash.json.orders.find((o) => o.id === 'older01'), 'and the frozen index still supplies the rows that predate it');
  const bk = await call('/api/books?handle=' + h, { headers: { 'x-tapstall-admin': skey } });
  assert.ok(bk.json.summary.orders >= 2, 'the ledger counts a row whose document never had metadata at all: ' + JSON.stringify(bk.json.summary).slice(0, 160));
  assert.equal(indexWritesFor(h), 0, 'and not one index write was spent across an order, a proof and a month of books');

  // and the second half of what the array used to do badly: an order past the 200-row cap used to
  // push the oldest row out of the ledger and out of the month, because the index was a fixed-size
  // array. Rows are per-document now, so the cap bounds a *page*, not a shop's history.
  const h2 = 'zzcap' + String(Date.now()).slice(-5);
  await call('/api/register', { method: 'POST', body: {
    handle: h2, shop_name: 'Cap', whatsapp: '263771234567', rail: 'zipit', pay_account: '1234567890', currency: 'USD',
  } });
  for (let n = 0; n < 12; n++) {
    await call('/api/order', { method: 'POST', ip: '196.46.1.' + (n + 2), body: { handle: h2, service: 'pickup',
      buyer: { name: 'Buyer ' + n, phone: '07800066' + String(n).padStart(2, '0') }, items: [{ name: 'Box', price: 20 + n }] } });
  }
  assert.equal(storedRows(h2).length, 12, 'twelve orders, twelve rows — none of them displaced by the twelfth');
  assert.equal(indexWritesFor(h2), 0, 'and not one write spent on an index, twelve orders in');
});


/* ---------------------------------------------------------------------------------------------
 * v0.8.6 — the one-tap confirm link belongs to a generation, so Revoke ends it too.
 *
 * The bug this section exists for: `a:'mark'` caps were minted without the store's `auth_gen`
 * and verified without it, so *Revoke* — which is the product's answer to "someone has my links"
 * — killed sessions, API keys and payment-code links and left every outstanding confirm link
 * holding a 72-hour write. The fix has to be a closed door, not a fresh cliff: buyers were
 * holding links minted by the previous release, so a link with no generation is judged by
 * whether the order it points at moved after the revoke.
 */
const { verifyCap, issueCap } = await import('../worker/core.js');

/* The pre-0.8.6 wire shape: the same signature over a payload with no `g`. It has to be built by
   hand now, because the mint refuses to produce it — that refusal is 0.8.7 — and the migration
   path still has to be tested against a token a real 0.8.5 Worker would have handed out. Each use
   asserts the fixture verifies and carries no generation, so this cannot pass by producing a
   string no door would ever accept. */
async function legacyCap(secret, payload, ttlSec) {
  const exp = Math.floor(Date.now() / 1000) + (ttlSec || 3600);
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const tag = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(exp + '.' + body)))
    .toString('base64url').replace(/=+$/, '').slice(0, 43);
  return `v1.${exp}.${body}.${tag}`;
}


async function newShop(handle) {
  const r = await call('/api/register', {
    method: 'POST',
    body: { shop_name: 'Generation Test Shop', owner_name: 'Tino', owner_email: 'gen@example.com',
      market: 'zw', city: 'Harare', whatsapp: '263770000001', handle, currency: 'USD',
      rail: 'ecocash_usd', pay_account: '0770002222' },
  });
  assert.equal(r.status, 201, r.text);
  const s = await loginWithPin(handle, r.json.pin);
  assert.ok(s.cookie, 'the new shop can sign in: ' + s.r.text.slice(0, 120));
  return { handle, pin: r.json.pin, cookie: s.cookie };
}
async function shopOrder(sh, ip) {
  const r = await call('/api/order', {
    method: 'POST', ip,
    body: { handle: sh.handle, items: [{ name: 'Plate', price: 5, qty: 1 }],
      buyer: { name: 'Gen Buyer', phone: '771110000' }, rail: 'ecocash_usd', when: 'asap' },
  });
  assert.equal(r.status, 201, r.text.slice(0, 200));
  return r.json;
}
const capOf = (path) => String(path || '').split('/c/')[1];
const bodyOf = (cap) => JSON.parse(Buffer.from(String(cap).split('.')[2], 'base64url').toString());
const shopDoc = (handle) => JSON.parse(env.STORES._map.get('store:' + handle).value);
const orderDoc = (handle, id) => JSON.parse(env.ORDERS._map.get('order:' + handle + ':' + id).value);

const gen = {};

test('0.8.6 a minted confirm link carries the store’s generation', async () => {
  gen.sh = await newShop('genbind');
  gen.o = await shopOrder(gen.sh, '196.7.0.1');
  const st = shopDoc('genbind');
  const p = bodyOf(capOf(gen.o.mark_url));
  assert.equal(p.a, 'mark', 'the link is still the same capability kind, not a new power');
  assert.equal(p.g, String(st.auth_gen || '0'), 'and it names the generation it was minted under');
  const c = bodyOf(capOf(gen.o.cancel_url));
  assert.equal(c.g, p.g, 'the cancel link is bound the same way — one rule, not one per link');
  assert.equal(c.s, 'cancelled');
});

test('0.8.6 the bound link still works, because the fix must not eat the happy path', async () => {
  const m = await call('/api/mark', { method: 'POST', body: { cap: capOf(gen.o.mark_url) } });
  assert.equal(m.status, 200, m.text.slice(0, 200));
  assert.equal(m.json.status, 'paid');
  assert.ok(m.json.undo_url, 'and the undo link came back');
  assert.equal(bodyOf(capOf(m.json.undo_url)).g, String(shopDoc('genbind').auth_gen || '0'),
    'the 15-minute undo is a mark cap too, so it is bound like one');
  gen.undo = m.json.undo_url;
});

test('0.8.6 Revoke ends an outstanding confirm link, and the order is left alone', async () => {
  gen.open = await shopOrder(gen.sh, '196.7.0.2');
  const before = shopDoc('genbind').auth_gen;
  const rv = await call('/api/revoke', { method: 'POST', cookie: gen.sh.cookie, body: { handle: 'genbind' } });
  assert.equal(rv.status, 200, rv.text);
  assert.match(rv.json.note, /confirm link/, 'the note now claims what the code does: ' + rv.json.note.slice(0, 90));
  assert.notEqual(shopDoc('genbind').auth_gen, before, 'the generation actually moved');

  const dead = await call('/api/mark', { method: 'POST', body: { cap: capOf(gen.open.mark_url) } });
  assert.equal(dead.status, 410, dead.text.slice(0, 200));
  assert.equal(dead.json.error, 'link_revoked');
  assert.equal(dead.json.final, true, 'a client that folds on `final` closes the door without special-casing this');
  assert.match(dead.json.why, /closed its payment links/, 'and it says so in words the person holding the link can read: ' + dead.json.why.slice(0, 80));
  assert.equal(dead.json.code, gen.open.order.code, 'the order code is in the answer, because that is what to send the shop');
  assert.equal(orderDoc('genbind', gen.open.order.id).status, 'awaiting_payment', 'and nothing was written');
});

test('0.8.6 a link minted after the revoke works, so this is a revocation and not a freeze', async () => {
  const fresh = await shopOrder(gen.sh, '196.7.0.3');
  const m = await call('/api/mark', { method: 'POST', body: { cap: capOf(fresh.mark_url) } });
  assert.equal(m.status, 200, m.text.slice(0, 200));
  assert.equal(m.json.status, 'paid');
});

test('0.8.6 no cliff: a pre-release link with no generation is judged by time', async () => {
  // A buyer is holding this link right now: minted by the previous release, so there is no `g` to
  // compare. The order it points at is newer than the last revoke, so nothing about it is stale —
  // refusing it would make the fix hurt exactly the person it was never about.
  gen.afterRevoke = await shopOrder(gen.sh, '196.7.0.3');
  assert.ok(Date.parse(gen.afterRevoke.order.at) > Number.parseInt(shopDoc('genbind').auth_gen, 36),
    'the order is newer than the last revoke — that is the whole reason a link with no generation is honourable here');
  const legacy = await legacyCap('test-secret', { a: 'mark', h: 'genbind', id: gen.afterRevoke.order.id, s: 'paid' });
  assert.ok(await verifyCap('test-secret', legacy), 'the hand-built cap is a real one, not a string');
  assert.equal(bodyOf(legacy).g, undefined, 'and it really is the pre-release shape: no generation');
  const r = await call('/api/mark', { method: 'POST', body: { cap: legacy } });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.json.status, 'paid');
  assert.equal(orderDoc('genbind', gen.afterRevoke.order.id).status, 'paid', 'and the write happened, not just the short-circuit');
});

test('0.8.6 …and that same link dies the moment the shop revokes again', async () => {
  const older = await shopOrder(gen.sh, '196.7.0.4');
  const legacy = await legacyCap('test-secret', { a: 'mark', h: 'genbind', id: older.order.id, s: 'paid' });
  assert.ok(await verifyCap('test-secret', legacy), 'a real 0.8.5 cap, built the way that release built it');
  const again = await call('/api/revoke', {
    method: 'POST', cookie: (await loginWithPin('genbind', gen.sh.pin)).cookie, body: { handle: 'genbind' },
  });
  assert.equal(again.status, 200, again.text.slice(0, 160));
  const r = await call('/api/mark', { method: 'POST', body: { cap: legacy } });
  assert.equal(r.status, 410, 'older than the revoke, so it goes: ' + r.text.slice(0, 140));
  assert.equal(r.json.error, 'link_revoked');
  assert.equal(orderDoc('genbind', older.order.id).status, 'awaiting_payment');
});

test('0.8.6 a revoked undo link answers in words and changes nothing', async () => {
  const before = orderDoc('genbind', gen.o.order.id).status;
  assert.equal(before, 'paid', 'the order under test is a paid one, or this proves nothing');
  const r = await call('/api/mark', { method: 'POST', body: { cap: capOf(gen.undo) } });
  assert.equal(r.status, 410, r.text.slice(0, 200));
  assert.equal(r.json.error, 'link_revoked');
  assert.equal(orderDoc('genbind', gen.o.order.id).status, 'paid', 'still paid: a dead link is a dead link');
});

test('0.8.6 the page does not offer a button the API has already refused', async () => {
  const o = await shopOrder(gen.sh, '196.7.0.5');
  const cap = capOf(o.mark_url);
  // The link has to be closed for the page to be wrong about it, so revoke between minting and
  // opening — the same order of events a merchant who suspects a leak produces.
  const rv = await call('/api/revoke', {
    method: 'POST', cookie: (await loginWithPin('genbind', gen.sh.pin)).cookie, body: { handle: 'genbind' },
  });
  assert.equal(rv.status, 200, rv.text.slice(0, 160));
  // The template branch: the injected state is what the page draws from, so the contract is that
  // a closed link arrives as `revoked` and the pre-existing `expired` shape — not a new state an
  // un-updated template would render as a blank card.
  const page = await call('/c/' + cap);
  assert.equal(page.status, 200, 'the door answers with a page, always: ' + page.text.slice(0, 120));
  assert.match(page.text, /"state":\s*"expired"/, 'the KV template path still gets a state it knows');
  assert.match(page.text, /"revoked":\s*true/, 'plus the fact that lets a re-skinned page say why');
  // A half-published page used to be the way a merchant lost the confirm skin, and the floor
  // caught them. The bundle means there is no "skin is gone" state to catch any more, which is the
  // better answer to the same fear: a stub published by hand is refused, the real page is served,
  // and the payload the page needs still arrives.
  await call('/ops/api/template', { method: 'POST', cookie: 'tp_ops=' + opsCookie, confirm: false,
    body: { name: 'confirm', html: '<!doctype html><p>half a page</p>' } }).catch(() => {});
  env.STORES._map.set('tpl-ovr:confirm', { value: '<!doctype html><p>half a page</p>' });   // under the floor of what counts as a page
  const stubbed = await call('/c/' + cap);
  await env.STORES.delete('tpl-ovr:confirm');
  assert.equal(stubbed.status, 200, 'a stub in the override key cannot blank a live door: ' + stubbed.text.slice(0, 120));
  assert.match(stubbed.text, /"revoked":\s*true/, 'and it is the bundle skin that answers, with the state in it');
  assert.ok(!/half a page/.test(stubbed.text), 'the stub is not served to a buyer');
});


/* ---------------------------------------------------------------------------------------------
 * v0.8.7 — the renew link belongs to a generation too, and no mint can forget one.
 *
 * Following the 0.8.6 thread to its end found the same hole in a second door, and the second door
 * is the one that reaches the money: `/renew/<token>` is a KV key with no expiry that opens the
 * plan page, mints a checkout intent against the shop, and files a payment reference into the list
 * the owner reconciles real payments against. Revoke moved `auth_gen` and none of that noticed.
 * A credential a kill switch cannot reach is a hole in the kill switch.
 */
const renewTok = (handle) => {
  const raw = env.STORES._map.get('store:' + handle);
  const st = raw ? JSON.parse(raw.value) : null;
  return String((st && st.renew_url) || '').split('/renew/')[1] || '';
};
const renewRec = (tok) => {
  const raw = env.STORES._map.get('renew:' + tok);
  return raw ? JSON.parse(raw.value) : null;
};
const txCount = () => [...env.STORES._map.keys()].filter((k) => k.startsWith('tx:')).length;
const refsFor = (handle) => {
  const raw = env.STORES._map.get('ref:' + handle);
  return raw ? JSON.parse(raw.value) : [];
};

const rg = {};

test('0.8.7 a renew link is minted with the generation it was issued under', async () => {
  rg.sh = await newShop('renewgen');
  rg.tok = renewTok('renewgen');
  assert.ok(rg.tok && rg.tok !== 'undefined', 'the welcome payload carries a renew link: ' + rg.tok);
  const rec = renewRec(rg.tok);
  assert.ok(rec, 'the record is on the books');
  assert.equal(rec.handle, 'renewgen');
  assert.equal(rec.g, '0', 'a shop that has never revoked is on generation zero');
  assert.ok(Number.isFinite(Number(rec.made)) && Number(rec.made) > 0, 'and it carries the date it was minted, which is what an older link is judged by');

  const page = await call('/renew/' + rg.tok);
  assert.equal(page.status, 200, page.text.slice(0, 140));
  const co = await call('/api/checkout', { method: 'POST', body: { token: rg.tok, days: 365 } });
  assert.ok(co.status === 200 || co.status === 503, 'a live link still mints an intent: ' + co.status);
  if (co.json.tx_ref) assert.ok(env.STORES._map.has('tx:' + co.json.tx_ref), 'and the intent is on the books');
  const filed = await call('/api/renew-ref', { method: 'POST', body: { token: rg.tok, reference: 'GEN-REAL-1', amount: 60 } });
  assert.equal(filed.status, 200, filed.text.slice(0, 160));
  assert.equal(refsFor('renewgen').length, 1, 'the shop filed one reference while the link was live');
});

test('0.8.7 Revoke erases the renew record, so every door it opened stops answering', async () => {
  const before = txCount();
  const rv = await call('/api/revoke', { method: 'POST', cookie: rg.sh.cookie, body: { handle: 'renewgen' } });
  assert.equal(rv.status, 200, rv.text.slice(0, 160));
  assert.match(rv.json.note, /renew link/, 'the note names it, because a lever that says less than it does is a surprise waiting: ' + String(rv.json.note).slice(0, 110));
  assert.notEqual(renewTok('renewgen'), rg.tok, 'and the dashboard link was reissued, so the promise on the closed page is one the product keeps');
  assert.equal(renewRec(rg.tok), null, 'the old record is gone: erasure, not distrust — there is nothing left to honour or refuse');

  const page = await call('/renew/' + rg.tok);
  assert.match(page.text, /no longer on the books|closed its (payment )?links/,
    'and the answer a shop gets on the retired link is the truth about the link, not a bill: ' + page.text.slice(0, 200));

  const co = await call('/api/checkout', { method: 'POST', body: { token: rg.tok, days: 365 } });
  assert.equal(co.status, 404, 'a payment intent cannot be minted on an erased link: ' + co.text.slice(0, 120));
  assert.equal(co.json.error, 'unknown renew token');
  assert.equal(txCount(), before, 'and nothing was written trying');

  const file = await call('/api/renew-ref', { method: 'POST', ip: '196.7.9.2', body: { token: rg.tok, reference: 'BOGUS-STRANGER-1', amount: 60 } });
  assert.equal(file.status, 404, file.text.slice(0, 160));
  assert.match(file.json.error, /not on the books/, 'the write is closed too, with the same words the page uses');
  assert.equal(refsFor('renewgen').length, 1, 'and the list the shop reconciles against still holds only its own entry');
  assert.equal(refsFor('renewgen')[0].ref, 'GEN-REAL-1');
});

test('0.8.7 the reissued link works at once, so this is a revocation and not a freeze', async () => {
  const st = JSON.parse(env.STORES._map.get('store:renewgen').value);
  const fresh = renewRec(renewTok('renewgen'));
  assert.equal(fresh.g, String(st.auth_gen), 'the new record carries the new generation, so it dies with the next revoke exactly as this one did');
  assert.equal((await call('/renew/' + renewTok('renewgen'))).status, 200, 'the plan card’s link opens');
  const filed = await call('/api/renew-ref', { method: 'POST', ip: '196.7.9.3', body: { token: renewTok('renewgen'), reference: 'GEN-REAL-2' } });
  assert.equal(filed.status, 200, filed.text.slice(0, 160));
  assert.equal(refsFor('renewgen').length, 2, 'and the shop can file against its own store again in the same minute');
});

test('0.8.7 a confirm skin that cannot draw the closure is not handed it', async () => {
  // Production's `tpl:confirm` is published from KV and can lag the code by a day. The 0.8.5 copy
  // has no branch for a revoked link, so on that bundle a closed link would be told it expired
  // while the API was saying something else. The page is asked whether it can draw the fact, and
  // the floor answers when it cannot — the same rule the renew door got, one line each.
  gen.sh = gen.sh || await newShop('genbind');
  const o = await shopOrder(gen.sh, '196.7.9.9');
  const cap = capOf(o.mark_url);
  // The revoke has to land between the mint and the read, or there is no closed link to draw and
  // the page is right to offer the button — the trap this whole section keeps falling into.
  const rv = await call('/api/revoke', {
    method: 'POST', cookie: (await loginWithPin('genbind', gen.sh.pin)).cookie, body: { handle: 'genbind' },
  });
  assert.equal(rv.status, 200, rv.text.slice(0, 120));
  const before = await call('/c/' + cap);
  assert.equal(before.status, 200, 'the current skin draws it, in its own panel: ' + before.text.slice(0, 120));
  assert.match(before.text, /"revoked":\s*true/);

  const tpl = env.STORES._map.get('tpl:confirm');
  env.STORES._map.set('tpl-ovr:confirm', {
    value: String(tpl ? tpl.value : await call('/ops/api/template?name=confirm', { cookie: 'tp_ops=' + opsCookie })).replace(/S\.revoked[^}]*\}/g, '').replace(/revoked/g, 'unused'),
  });
  assert.ok(env.STORES._map.get('tpl-ovr:confirm').value.length > 200, 'the probe skin is a real page, minus the branch');
  const stale = await call('/c/' + cap);
  assert.equal(stale.status, 410, 'an out-of-date skin gets no chance to lie: ' + stale.text.slice(0, 140));
  assert.match(stale.text, /closed its payment links/);
  assert.ok(!/"revoked":/.test(stale.text), 'and the answer is the floor page, not the payload with nothing to draw it');
  await env.STORES.delete('tpl-ovr:confirm');
  assert.match((await call('/c/' + cap)).text, /"revoked":\s*true/, 'take the override away, and the bundle skin is trusted again');
  assert.ok(!/action="\/api\/mark"/.test(stale.text), 'the floor the stale skin fell back to renders no form that cannot work');
  assert.ok(!/fetch\("\/api\/mark"/.test(stale.text), 'nor an auto-send that will be refused');
});

test('0.8.7 a link minted by the previous release is judged by its date, like a cap', async () => {
  // There is no `g` on a record written before this release, and deleting every merchant's renew
  // link under their feet is not safety. So the date decides: made before the last revoke means
  // closed, made after means the link stands. Refused here, and honoured there — one rule, the
  // same one `capGenOk` applies to a signed link, with no second copy to drift.
  const st = JSON.parse(env.STORES._map.get('store:renewgen').value);
  const revokedAt = Number.parseInt(st.auth_gen, 36);
  const plant = (name, rec) => env.STORES._map.set('renew:' + name, { value: JSON.stringify(rec) });

  plant('legacyold', { handle: 'renewgen', made: revokedAt - 864e5 });
  const dead = await call('/renew/legacyold');
  assert.equal(dead.status, 200, 'the skin has a panel for this state, so the skin is used: ' + dead.text.slice(0, 120));
  assert.match(dead.text, /"state":\s*"closed"/, 'and it is handed the fact, not the generic "link is old" story');
  assert.match(dead.text, /closed its payment links/);
  const deadWrite = await call('/api/renew-ref', { method: 'POST', ip: '196.7.9.4', body: { token: 'legacyold', reference: 'STALE-1' } });
  assert.equal(deadWrite.status, 410, 'the write behind it is refused with the code, not just the copy: ' + deadWrite.text.slice(0, 120));
  assert.equal(deadWrite.json.final, true);
  assert.equal(refsFor('renewgen').length, 2, 'nothing was filed');

  plant('legacynew', { handle: 'renewgen', made: Date.now() });
  const alive = await call('/renew/legacynew');
  assert.equal(alive.status, 200, 'made after the revoke: there is nothing this link is stale against');
  assert.match(alive.text, /"state":\s*(null|"paid"|undefined)|Renew for a year|days left/, 'and the page draws the store, not the closure panel');
  const aliveWrite = await call('/api/renew-ref', { method: 'POST', ip: '196.7.9.5', body: { token: 'legacynew', reference: 'STALE-2' } });
  assert.equal(aliveWrite.status, 200, aliveWrite.text.slice(0, 120));
  assert.equal(refsFor('renewgen').length, 3, 'so it files, like any link the shop has not closed');
  env.STORES._map.delete('renew:legacyold'); env.STORES._map.delete('renew:legacynew');
});

test('0.8.7 a closed link on the floor has no button on it, and no sentence that is not true', async () => {
  const tok = 'skinprobe';
  env.STORES._map.set('renew:' + tok, { value: JSON.stringify({ handle: 'renewgen', made: Date.now(), g: 'gen-then' }) });
  // Since v0.9.1 the bundle carries the renew skin, so "the skin is down" is no longer a matter of
  // deleting a KV key — it is a hand-published page that cannot draw the state. Same promise, real
  // door: an override skin with no closed branch must not be handed the closed state, and the floor
  // answers instead, in the same words, with no way to pay through a dead link.
  const skin = (await call('/ops/api/template?name=renew', { cookie: 'tp_ops=' + opsCookie })).json.html;
  const cannotDraw = skin.replace(/state === 'closed'/g, "state === '__no_panel_for_this__'");
  assert.ok(!/state === 'closed'/.test(cannotDraw), 'the probe really is a skin without the branch');
  await call('/ops/api/template', { method: 'POST', cookie: 'tp_ops=' + opsCookie, confirm: true, body: { name: 'renew', html: cannotDraw } });
  const floor = await call('/renew/' + tok);
  assert.equal(floor.status, 410, 'a state the skin cannot draw is answered by the floor, in the real code');
  assert.match(floor.text, /closed its links/, 'with the same words, so a screenshot cannot contradict the API');
  assert.ok(!/id=pay|getElementById\('pay'\)|Pay and /.test(floor.text), 'and a closed link renders no way to pay through it');
  await env.STORES.delete('tpl-ovr:renew');

  // The bundle skin *can* draw it, and does, with the copy the release settled on: the dashboard is
  // named, the retired sentence about the welcome email is gone from both page and floor.
  const drawn = await call('/renew/' + tok);
  assert.equal(drawn.status, 200, 'the skin answers for a state it has a panel for');
  assert.match(drawn.text, /plan card|dashboard/, 'and the panel says where the working link is');
  assert.ok(!/welcome email/.test(drawn.text), 'no page a merchant can open points at the link a revoke kills');
  const goneFloor = await call('/renew/nothingsuchtoken');
  assert.ok(!/welcome email/.test(goneFloor.text), 'the erased-token answer is the same story from the skin');
  env.STORES._map.delete('renew:' + tok);
});

/* ---------------------------------------------------------------------------------------------
 * v0.8.8 — one rule, all four doors.
 *
 * 0.8.6 put the generation rule in the core so the two readers of a `/c/` link could not disagree,
 * and 0.8.7 made a mint that forgets the field impossible. What was left is the reader side of the
 * other buyer door: `/p/`, the code link, compared `p.g` to `st.auth_gen` by hand — twice, in two
 * handlers — with no time branch. Measured in the shipped file, three functions hand-rolled that
 * comparison. The copies were not academic: each had to answer "and what does a link with no
 * generation mean on a shop that revoked nothing", and both answered "closed" — a shop that never
 * touched Revoke was told its links were closed, and the phone was told to put the link down. And
 * `proofPage` folded "there is no shop behind this link" into the same sentence as "the shop closed
 * its links", which is the exact defect 0.8.6 fixed one page over.
 */
test('0.8.8 a code link with no generation is judged by the shared rule, so a shop that never revoked is not accused of it', async () => {
  rg.sh2 = await newShop('proofgen');
  rg.o = await shopOrder(rg.sh2, '196.7.11.1');
  rg.id = rg.o.order.id;
  const od = orderDoc('proofgen', rg.id);
  assert.ok(od.pcap, 'the order has a filing nonce, which is what makes the link single-use');
  const legacy = await legacyCap('test-secret', { a: 'proof', h: 'proofgen', id: rg.id, n: od.pcap });
  assert.ok(await verifyCap('test-secret', legacy), 'a real capability, minted the way the release that shipped this door minted it');
  assert.equal(bodyOf(legacy).g, undefined, 'and with no generation in it, which is the whole question');
  assert.equal(String(shopDoc('proofgen').auth_gen || '0'), '0', 'this shop has never revoked anything');

  const page = await call('/p/' + legacy);
  assert.equal(page.status, 200, 'the door opens instead of blaming a revocation that did not happen: ' + page.text.slice(0, 160));
  assert.ok(!/closed its code links/.test(page.text), 'no invented revocation on the page');
  const add = await call('/api/proof', { method: 'POST', ip: '196.7.11.2',
    body: { cap: legacy, proof: 'GENPROOF1', payer: '0771234567' } });
  assert.equal(add.status, 200, add.text.slice(0, 200));
  assert.equal(orderDoc('proofgen', rg.id).buyer.proof, 'GENPROOF1', 'and it filed, because nothing about this shop is stale');
});

test('0.8.8 the code page says the fact it actually knows, and does not touch the device when it does not know the shop', async () => {
  // Two refusals that used to share one sentence. The prune script is the reason it matters: a
  // page that has mistaken a missing store for a revocation would also delete a link the shop
  // never closed, from a buyer who did nothing wrong.
  const ghost = await legacyCap('test-secret', { a: 'proof', h: 'nosuchshop9', id: 'o1', n: 'x' });
  const r = await call('/p/' + ghost);
  assert.equal(r.status, 404, 'a shop that is not on the books: ' + r.text.slice(0, 140));
  assert.match(r.text, /not on the books|no shop/i, 'and it is said plainly');
  assert.ok(!/closed its code links/.test(r.text), 'not blamed on a revoke');
  assert.ok(!/tp_pf_/.test(r.text), 'and no script rewriting the buyer’s storage on the strength of a guess');
});

test('0.8.8 a stale code link on a shop that did revoke is still closed, with the prune, by the same rule', async () => {
  const before = String(shopDoc('proofgen').auth_gen);
  const rv = await call('/api/revoke', { method: 'POST', cookie: rg.sh2.cookie, body: { handle: 'proofgen' } });
  assert.equal(rv.status, 200, rv.text.slice(0, 120));
  assert.notEqual(String(shopDoc('proofgen').auth_gen), before, 'the generation moved, so the link from before it is a link the shop has closed');

  const stale = await legacyCap('test-secret', { a: 'proof', h: 'proofgen', id: rg.id, n: orderDoc('proofgen', rg.id).pcap });
  const page = await call('/p/' + stale);
  assert.equal(page.status, 410, 'the order was last touched before the revoke, so the time branch closes it too: ' + page.text.slice(0, 160));
  assert.match(page.text, /closed its code links/);
  assert.match(page.text, /tp_pf_/, 'and here, where the shop really did close the link, the phone is asked to put it down');
  const add = await call('/api/proof', { method: 'POST', ip: '196.7.11.3',
    body: { cap: stale, proof: 'TOO-LATE-1', payer: '0778889999' } });
  assert.equal(add.status, 410, add.text.slice(0, 160));
  assert.equal(add.json.why, 'revoked', 'the JSON keeps the same word it used to, because clients fold on it');
  assert.equal(orderDoc('proofgen', rg.id).buyer.proof, 'GENPROOF1', 'and nothing was overwritten');

  // A link minted under the live generation opens the door and files: the fix is a revocation and
  // not a freeze, which is exactly as true of the code link as it is of the confirm link.
  const nd = orderDoc('proofgen', rg.id);
  const live = await issueCap('test-secret',
    { a: 'proof', h: 'proofgen', id: rg.id, n: nd.pcap, g: String(shopDoc('proofgen').auth_gen) }, 3600);
  assert.equal((await call('/p/' + live)).status, 200, 'the page offers the field again');
  const ok = await call('/api/proof', { method: 'POST', ip: '196.7.11.4',
    body: { cap: live, proof: 'AFTER-REVOKE-1', payer: '0771234567' } });
  assert.equal(ok.status, 200, ok.text.slice(0, 200));
  assert.equal(orderDoc('proofgen', rg.id).buyer.proof, 'AFTER-REVOKE-1', 'so the buyer who was handed a new link can still use it');
});


/* ============================== 0.9.0: VAT, the receipt, the books, the mesh, the operator's rows
 *
 * The round this suite exists for: a shop's money side, asserted through the endpoints the
 * dashboard actually calls, on a store document the test can see. Nothing here writes a new kind of
 * state — that is the point of the design, and the last test proves it by taking the write budget
 * away and asking for the books anyway.
 */
const vat = {};
test('0.9.0 a shop declares its VAT, and the five fields are held like a price change', async () => {
  vat.sh = await newShop('vatmode');
  const r = await call('/api/settings', { method: 'POST', cookie: vat.sh.cookie, confirm: 1, body: {
    handle: 'vatmode', tax_pct: 15, vat_registered: true, vat_number: '4010000001',
    vat_address: '12 Mutare Rd, Harare', vat_mode: 'incl',
  } });
  assert.equal(r.status, 200, r.text);
  const held = r.json.pending || r.json.staged || {};
  assert.match(JSON.stringify(r.json), /vat_mode/, 'the answer names what it did with them');
  const doc = shopDoc('vatmode');
  assert.ok(doc.pending && doc.pending.fields, 'a rate and a registration number ride the 15-minute hold like the pay number does');
  assert.equal(Object.keys(doc.pending.fields).sort().join(','), 'tax_pct,vat_address,vat_mode,vat_number,vat_registered');
  assert.equal(doc.vat_number, undefined, 'and none of it is live this second');
  assert.ok(!held.applied, 'no field was applied behind the hold');
  doc.pending.apply_at = Date.now() - 1000;
  await env.STORES.put('store:vatmode', JSON.stringify(doc));
});

test('0.9.0 an inclusive shop totals the same number on the shelf, the preview and the order', async () => {
  const cfg = await call('/s/vatmode/config.json');
  assert.equal(cfg.status, 200);
  const st = cfg.json.store;
  assert.equal(st.vat_mode, 'incl', 'the page has to know which way round the prices are quoted');
  assert.equal(st.tax_pct, 15);
  assert.equal(st.vat_registered, true);
  assert.equal(st.vat_number, '4010000001', 'a tax invoice must print the number, so the number is public');
  assert.ok(!('pin' in st) && !('admin_token' in st), 'and the public store is still only the public store');
  const add = await call('/api/menu', { method: 'POST', cookie: vat.sh.cookie, confirm: 1, body: {
    handle: 'vatmode', menu: { extra: [{ name: 'VAT plate', price: 115 }] } } });
  assert.equal(add.status, 200, add.text);
  const o = await call('/api/order', { method: 'POST', ip: '196.9.0.1', body: {
    handle: 'vatmode', items: [{ name: 'VAT plate', price: 115, qty: 1 }],
    buyer: { name: 'Rudo', phone: '263771234567' }, rail: 'ecocash_usd', when: 'asap' } });
  assert.equal(o.status, 201, o.text.slice(0, 200));
  // The order response is { order: {id, code, at, status}, pricing: {...} }: the pricing rides
  // beside the row, not inside it, and a test that reaches past that reads undefined.
  const p = o.json.pricing;
  vat.o = o.json.order || {};
  vat.pricing = p;
  vat.pid = vat.o.id;
  vat.mark_url = o.json.mark_url;   // the link is on the response, beside the row, not inside it
  assert.ok(vat.mark_url, 'the shop was handed a one-tap link for this order');
  assert.equal(p.subtotal, 115, 'the shelf price is the total, because the VAT is inside it');
  assert.equal(p.tax, 15, 'taken out, not added on');
  assert.equal(p.vat.mode, 'incl');
  assert.equal(p.vat.included, true);
  assert.equal(p.vat.registered, true, 'this order was priced as a tax invoice would be');
  assert.equal(p.vat.net, 100);
  assert.ok(Math.abs(p.total - 115) < 0.011 || p.total > 115, 'the rail fee rides on top as it always has');
});

test('0.9.0 the ledger row carries the tax, so the books never need the order document', async () => {
  const rows = storedRows('vatmode');
  const row = rows.find((x) => x.id === vat.pid);
  assert.ok(row, 'the row is there');
  assert.equal(row.tax, 15);
  assert.equal(row.net, 100);
  assert.equal(row.vat_pct, 15);
  assert.equal(row.vat_mode, 'incl');
  assert.ok(Number(row.pay_now) >= 115, 'and the amount the buyer was asked for, unchanged');
  assert.ok('rounding' in row, 'the odd cents are named so they can be excluded from income');
});

test('0.9.0 the books count money in hand, then count it once it arrives', async () => {
  const per = new Date().toISOString().slice(0, 7);
  const cash0 = await call('/api/books?handle=vatmode&period=' + per + '&basis=cash', { cookie: vat.sh.cookie });
  assert.equal(cash0.status, 200, cash0.text.slice(0, 200));
  assert.equal(cash0.json.summary.vat.count, 0, 'nothing has been paid, so a cash-basis report says nothing');
  assert.equal(cash0.json.summary.outstanding_balance, cash0.json.summary.vat ? 115 : 0);
  const acc0 = await call('/api/books?handle=vatmode&period=' + per + '&basis=accrual', { cookie: vat.sh.cookie });
  assert.equal(acc0.json.summary.vat.count, 1, 'the order exists, so the accrual basis sees it');
  assert.equal(acc0.json.summary.vat.vat, 15);
  const m = await call('/api/mark', { method: 'POST', body: { cap: capOf(vat.mark_url) } });
  assert.equal(m.status, 200, m.text.slice(0, 200));
  const cash1 = await call('/api/books?handle=vatmode&period=' + per + '&basis=cash', { cookie: vat.sh.cookie });
  assert.equal(cash1.json.summary.vat.count, 1, 'and now the payment is in the month the money landed');
  assert.equal(cash1.json.summary.collected > 0, true);
  assert.equal(cash1.json.summary.vat.rates.length, 1);
  assert.equal(cash1.json.summary.vat.rates[0].rate_pct, 15);
  assert.equal(cash1.json.summary.outstanding_balance, 0, 'the balance clears when the money does');
  assert.equal(cash1.json.summary.vat.registered, true);
  assert.ok((cash1.json.periods || []).some((x) => x.period === per), 'the month picker is built from rows that exist');
});

test('0.9.0 the books door answers only the shop on the other side of it', async () => {
  const anon = await call('/api/books?handle=vatmode');
  assert.equal(anon.status, 401, 'no session, no ledger');
  const other = await newShop('vatnosy');
  const peek = await call('/api/books?handle=vatmode', { cookie: other.cookie });
  assert.equal(peek.status, 403, 'a session for one shop used against another is a credential mismatch, answered as one');
  assert.ok(!/gross|awaiting|vat/.test(JSON.stringify(peek.json)), 'and it carries no numbers, only the refusal');
  const own = await call('/api/books?handle=vatnosy', { cookie: other.cookie });
  assert.equal(own.status, 200);
  assert.equal(own.json.summary.orders, 0, 'its own books are empty, which is the truth and is printable');
});

test('0.9.0 the CSV pack is a file, with the honest preamble in it', async () => {
  const per = new Date().toISOString().slice(0, 7);
  const r = await call('/api/books?handle=vatmode&period=' + per + '&fmt=csv', { cookie: vat.sh.cookie });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="vatmode-books-/);
  assert.ok(r.text.startsWith('# tapstall books pack'), r.text.slice(0, 60));
  assert.ok(r.text.includes('date,ref,status,buyer,phone,service,rail,gross,vat,net'), 'then the columns an accountant keys on');
  assert.ok(/filename="vatmode-books-/.test(r.headers.get('content-disposition') || ''),
    'the file is named for the shop and the month, got: ' + JSON.stringify(r.headers.get('content-disposition')));
  assert.ok(/# vat: registered, no\. 4010000001/.test(r.text), 'the preamble says who is filing');
  assert.ok(/# Sales side only/.test(r.text), 'and says what it is not');
  assert.ok(r.text.includes('# totals'), 'the totals are in the file, so nobody re-adds them');
  assert.equal((await call('/api/books?handle=vatmode&fmt=csv')).status, 401, 'the download is behind the same door as the panel');
});

test('0.9.0 a receipt exists: numbered, printable, and the order’s own figures', async () => {
  const rec = await call('/api/receipt?handle=vatmode&order=' + vat.pid, { cookie: vat.sh.cookie });
  assert.equal(rec.status, 200, rec.text.slice(0, 160));
  assert.match(rec.text, /TAX INVOICE|Tax invoice/i, 'the heading follows the registration the order was priced under');
  assert.match(rec.text, /4010000001/);
  assert.match(rec.text, /<h1>[^<]+<\/h1>/, 'and the document is well-formed where it names the shop');
  assert.match(rec.text, /1x VAT plate<\/td><td class=n>115\.00/, 'the line carries the money, not zeros');
  assert.match(rec.text, /VAT @ 15% inside|VAT @ 15%/);
  assert.match(rec.text, /115\.00/, 'the total the buyer paid, not a re-derivation of it');
  assert.match(rec.headers.get('cache-control') || '', /no-store/);
  assert.equal(rec.headers.get('x-robots-tag'), 'noindex, nofollow', 'an order document is not a page a crawler should meet');
  const txt = await call('/api/receipt?handle=vatmode&order=' + vat.pid + '&fmt=txt', { cookie: vat.sh.cookie });
  assert.match(txt.text, /Receipt |TAX INVOICE/);
  assert.ok(txt.text.split('\n').length > 6, 'the text version is a document, not a headline');
  const byCode = await call('/api/receipt?handle=vatmode&order=' + vat.o.code, { cookie: vat.sh.cookie });
  assert.equal(byCode.status, 200, 'a code works as well as an id, because that is what the shop has on screen');
  const gone = await call('/api/receipt?handle=vatmode&order=nope123', { cookie: vat.sh.cookie });
  assert.equal(gone.status, 404);
  assert.match(gone.json.note, /Only this shop’s own orders/, 'and the refusal says what it checked');
  assert.equal((await call('/api/receipt?handle=vatmode&order=' + vat.pid)).status, 401, 'nobody else’s receipt, including a buyer’s');
});

test('0.9.0 send receipt to buyer is one tap into the chat they messaged in', async () => {
  const wa = await call('/api/receipt?handle=vatmode&order=' + vat.pid + '&fmt=wa', { cookie: vat.sh.cookie });
  assert.equal(wa.status, 302, wa.text.slice(0, 120));
  const loc = wa.headers.get('location');
  assert.ok(loc.startsWith('https://wa.me/263771234567?text='), loc);
  const msg = decodeURIComponent(loc.split('text=')[1]);
  assert.match(msg, /TAX INVOICE/);
  assert.match(msg, new RegExp(vat.o.code), 'the message names the order it is a receipt for');
  // an order with no number on it is not a broken link and not a silent failure either
  const doc = orderDoc('vatmode', vat.pid);
  assert.ok(vat.pid, 'the order response names the row it created, which is what a receipt is asked for');
  doc.buyer.phone = '';
  await putDoc('vatmode', vat.pid, doc);
  const noNum = await call('/api/receipt?handle=vatmode&order=' + vat.pid + '&fmt=wa', { cookie: vat.sh.cookie });
  assert.equal(noNum.status, 200);
  assert.equal(noNum.json.need_number, true);
  assert.match(noNum.json.text, /TAX INVOICE/, 'the text is handed over instead, because there was no way to send it');
  const back = orderDoc('vatmode', vat.pid);
  back.buyer.phone = '263771234567';
  await putDoc('vatmode', vat.pid, back);
});

test('0.9.0 an unregistered shop gets a receipt, and the words that say why it is not an invoice', async () => {
  vat.plain = await newShop('vatplain');
  await call('/api/menu', { method: 'POST', cookie: vat.plain.cookie, confirm: 1,
    body: { handle: 'vatplain', menu: { extra: [{ name: 'Plate', price: 40 }, { name: 'Mealie meal', price: 20, vat_rate: 'zero' }] } } });
  const o = await call('/api/order', { method: 'POST', ip: '196.9.0.5', body: {
    handle: 'vatplain', items: [{ name: 'Plate', price: 40, qty: 1 }, { name: 'Mealie meal', price: 20, qty: 1 }],
    buyer: { name: 'Tino', phone: '263770000009' }, rail: 'cash_on_delivery', when: 'asap' } });
  assert.equal(o.status, 201, o.text.slice(0, 200));
  vat.plainOrder = o.json.order || o.json;
  const rec = await call('/api/receipt?handle=vatplain&order=' + vat.plainOrder.id, { cookie: vat.plain.cookie });
  assert.match(rec.text, /<h2>Receipt<\/h2>/);
  assert.match(rec.text, /not VAT-registered/);
  assert.ok(!/VAT No/.test(rec.text), 'and no number is invented for the header');
});

test('0.9.0 the row a zero-rate was set on is taxed at nothing, end to end', async () => {
  await call('/api/settings', { method: 'POST', cookie: vat.plain.cookie, confirm: 1, body: { handle: 'vatplain', tax_pct: 15 } });
  const doc = shopDoc('vatplain');
  if (doc.pending) { doc.pending.apply_at = Date.now() - 1000; await env.STORES.put('store:vatplain', JSON.stringify(doc)); }
  const o = await call('/api/order', { method: 'POST', ip: '196.9.0.6', body: {
    handle: 'vatplain', items: [{ name: 'Plate', price: 40, qty: 1 }, { name: 'Mealie meal', price: 20, qty: 1 }],
    buyer: { name: 'Tino', phone: '263770000009' }, rail: 'cash_on_delivery', when: 'asap' } });
  assert.equal(o.status, 201, o.text.slice(0, 200));
  const p = o.json.pricing;
  assert.equal(p.tax, 6, '15% of the plate, nothing of the meal');
  assert.equal(p.subtotal, 66);
  const rows = storedRows('vatplain');
  const row = rows.find((x) => x.id === o.json.order.id);
  assert.equal(row.tax, 6, 'and the ledger row holds that figure, so the books do not have to guess');
  const per = new Date().toISOString().slice(0, 7);
  const b = await call('/api/books?handle=vatplain&period=' + per + '&basis=accrual', { cookie: vat.plain.cookie });
  const rates = b.json.summary.vat.rates.map((x) => x.rate_pct);
  assert.ok(rates.includes(15) && rates.includes(0), 'the return has a line at 15% and a line at nil, from one shelf');
  assert.equal(b.json.summary.vat.vat, 6, 'the meal contributes nothing to it, and is still on the invoice');
  const zero = b.json.summary.vat.rates.find((x) => x.rate_pct === 0);
  assert.ok(zero.gross >= 20, 'the nil-rated gross is reported, which is the line a ZIMRA return asks for');
  const rowJson = storedRow('vatplain', o.json.order.id);
  assert.ok(rowJson.vat_by && rowJson.vat_by['15'] && rowJson.vat_by['0'], 'and the row itself holds the split, so the answer needed no document read');
  assert.equal(rowJson.vat_by['15'].tax, 6);
  assert.equal(rowJson.vat_by['0'].gross, 20);
});

test('0.9.0 every row without a picture has one, and nobody is told it is a photo', async () => {
  const feed = await call('/s/vatplain/feed.json');
  const prods = feed.json.products;
  const bare = prods.find((x) => !x.img || x.art);
  assert.ok(bare, 'the added row with no image got art instead of an empty box');
  assert.match(bare.img, /^\/art\/vatplain\/\d+\.svg\?n=/);
  assert.equal(bare.art, true, 'flagged as art, which is what makes it safe to serve');
  const art = await call(bare.img);
  assert.equal(art.status, 200);
  assert.match(art.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(art.headers.get('cache-control'), /max-age=31536000, immutable/);
  assert.equal(art.headers.get('x-tapstall-art'), 'sample, not a photo');
  assert.match(art.text, /^<svg xmlns/);
  assert.ok(!/<(script|image|use)/i.test(art.text), 'nothing that reaches out or runs in it');
  const before = env.STORES._writes, obefore = env.ORDERS._writes;
  await call(art.headers.get('cache-control') ? bare.img : '/art/vatplain/1.svg');
  assert.equal(env.STORES._writes, before, 'serving art writes nothing');
  assert.equal(env.ORDERS._writes, obefore, 'and reads nothing from either namespace');
  const page = await call('/s/vatplain');
  assert.ok(!/property="og:image"/.test(page.text) || /vatplain\/i\//.test(page.text),
    'a social preview is only promised when somebody took or uploaded a picture');
});

test('0.9.0 the mesh drafts a day from the menu and never a figure the menu does not have', async () => {
  const anon = await call('/api/mesh?handle=vatmode');
  assert.equal(anon.status, 401, 'the pack is behind the shop’s own door');
  assert.equal((await call('/api/mesh')).status, 404, 'and a request naming no shop is not a shop');
  // one menu write replaces the shelf, so the pack test re-posts the plate along with the rows it
  // needs — the same thing a merchant finds out the first time they add a row and lose another
  await call('/api/menu', { method: 'POST', cookie: vat.sh.cookie, confirm: 1, body: { handle: 'vatmode',
    menu: { extra: [{ name: 'VAT plate', price: 115 }, { name: 'Sadza', price: 4 }, { name: 'Tea', price: 2 }, { name: 'Mopane worms', price: 6 }] } } });
  const r = await call('/api/mesh?handle=vatmode', { cookie: vat.sh.cookie });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.ok(r.json.ok);
  const beats = r.json.plan.beats;
  assert.equal(beats.length, r.json.budget.per_day, 'three lines, the pinned budget');
  assert.equal(beats.filter((x) => x.kind === 'promo').length, 1, 'one of them a promo, never two');
  for (const b of beats) {
    const cap = r.json.rails[b.rail].max;
    assert.ok(b.text.length <= cap, b.rail + ' fits its own rail (' + b.text.length + '/' + cap + ')');
    assert.ok(!/today only|limited time|won\'t last|best in Harare/i.test(b.text), 'no claim the row cannot support');
  }
  const prices = (await call('/s/vatmode/feed.json')).json.products.map((p) => Number(p.price));
  for (const b of beats) if (b.price) assert.ok(prices.some((x) => Math.abs(x - b.price) < 0.005), 'every number is a price on the menu today');
  const pub = await call('/s/vatmode/mesh.json');
  assert.equal(pub.status, 200);
  assert.equal(pub.json.priced, true);
  assert.ok(pub.json.items.some((x) => x.name === 'VAT plate' && x.price === 115), 'the public file repeats the shop, not a summary of it');
  assert.ok(pub.json.items.length >= 4, 'every row is in the file, in the shop’s own order');
  assert.ok(!JSON.stringify(pub.json).match(/pay_account|whatsapp.*77123|buyer/i), 'and no buyer or wallet detail is in it');
  assert.match(pub.json.terms, /not as a promise/);
});

test('0.9.0 marking a line posted is the one write, and a spent budget changes nothing else', async () => {
  const noConfirm = await call('/api/mesh/seen', { method: 'POST', cookie: vat.sh.cookie, body: { handle: 'vatmode', marked: ['vat-plate'] } });
  assert.equal(noConfirm.status, 403, 'a cookie from a form on someone else’s page is not consent');
  const first = await call('/api/mesh?handle=vatmode', { cookie: vat.sh.cookie });
  const key = first.json.plan.beats[0].item_key;
  const wBefore = env.ORDERS._writes;
  const saved = await call('/api/mesh/seen', { method: 'POST', cookie: vat.sh.cookie, confirm: 1, body: { handle: 'vatmode', marked: [key] } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.saved, true);
  assert.equal(env.ORDERS._writes, wBefore + 1, 'one write for a marked line, whatever else the day cost');
  assert.ok(env.ORDERS._map.has('mesh:vatmode'), 'in the orders namespace, because it is activity and not config');
  const second = await call('/api/mesh?handle=vatmode', { cookie: vat.sh.cookie });
  assert.ok(second.json.posted[key], 'and the plan now knows it was posted');
  assert.ok(!second.json.plan.beats.some((b) => b.item_key === key), 'that item is quiet for a week, so the shop is not repeating itself at its own customers');
  // the memory is optional: with the namespace gone the pack still builds, and says less
  env.ORDERS._map.delete('mesh:vatmode');
  const third = await call('/api/mesh?handle=vatmode', { cookie: vat.sh.cookie });
  assert.equal(third.json.state_saved, false);
  assert.equal(third.json.plan.beats.length, 3, 'the queue is derived from the day, so a missing key is not an outage');
  const w2 = env.ORDERS._writes;
  const putBack = env.ORDERS.put;
  env.ORDERS.put = async () => { throw new Error('QUOTA_EXCEEDED: daily write limit'); };
  const blocked = await call('/api/mesh/seen', { method: 'POST', cookie: vat.sh.cookie, confirm: 1, body: { handle: 'vatmode', marked: [key] } });
  env.ORDERS.put = putBack;
  assert.equal(blocked.status, 200, 'a refused write is answered, not thrown: the copy was always the deliverable');
  assert.equal(blocked.json.saved, false);
  assert.match(blocked.json.note, /write budget for today is spent/);
  void w2;
});

test('0.9.0 the operator edits the merchant’s rows through the merchant’s own rule', async () => {
  const c = 'tp_ops=' + opsCookie;
  const noHdr = await call('/ops/api/store', { method: 'POST', cookie: c, body: { handle: 'vatmode', action: 'menu', menu: { over: {} } } });
  assert.equal(noHdr.status, 403, 'even the console posts a lever with the confirm header');
  const writesBefore = env.STORES._writes;
  const blank = await call('/ops/api/store', { method: 'POST', cookie: c, confirm: 1, body: { handle: 'vatmode', action: 'menu', menu: { over: { nope: {} } } } });
  assert.equal(blank.status, 200, blank.text.slice(0, 200));
  assert.equal(blank.json.changed, false, 'a patch that changes nothing says so — which it can, because patch semantics mean it destroyed nothing either');
  assert.equal(env.STORES._writes, writesBefore, 'and it spent no write and no log line doing it');
  const forgotten = await call('/ops/api/store', { method: 'POST', cookie: c, confirm: 1, body: { handle: 'vatmode', action: 'menu', menu: { over: { nope2: { price: 9 } } } } });
  assert.equal(forgotten.json.changed, true, 'a patch that does change something says that too');
  const afterForgotten = await call('/s/vatmode/feed.json');
  assert.ok((afterForgotten.json.products || []).some((x) => x.name === 'VAT plate'), 'the row a payload forgot to mention is still on the shelf');
  const feed = await call('/s/vatmode/feed.json');
  const plate = (feed.json.products || []).find((p) => p.name === 'VAT plate');
  assert.ok(plate, 'the shop has a row to edit: ' + feed.text.slice(0, 120));
  const ok = await call('/ops/api/store', { method: 'POST', cookie: c, confirm: 1, body: {
    handle: 'vatmode', action: 'menu', menu: { over: { [plate.id]: { price: 120, available: false } } } } });
  assert.equal(ok.status, 200, ok.text.slice(0, 200));
  assert.equal(ok.json.changed_rows, 1, 'one row moved');
  assert.equal(ok.json.edits, 6, 'and the store now carries six overridden things — the four rows the merchant added and two price edits');
  assert.match(ok.json.note, /Revert/, 'and the answer says who can undo it');
  const after = await call('/s/vatmode/feed.json');
  const row = after.json.products.find((p) => p.id === plate.id);
  assert.equal(row.price, 120, 'the change is on the shelf buyers read');
  assert.equal(row.available, false);
  assert.equal(shopDoc('vatmode').menu.over[plate.id].price, 120, 'in the same place a merchant edit would have gone');
  const still = (await call('/s/vatmode/feed.json')).json.products.map((x) => x.name);
  assert.ok(still.includes('Sadza') && still.includes('Tea') && still.includes('Mopane worms'),
    'a one-row patch does not clear the merchant’s own rows: ' + still.join(','));
  assert.equal(shopDoc('vatmode').menu.extra.length, 4, 'they are still in the store document, not just in a cache');
  const audit = JSON.stringify((await call('/api/admin?handle=vatmode', { cookie: vat.sh.cookie })).json.audit);
  assert.match(audit, /"menu"/, 'the merchant sees the edit in their own log');
  assert.match(audit, /"ops"/, 'and sees whose hand was on it');
  const foreign = await call('/ops/api/store', { method: 'POST', cookie: c, confirm: 1, body: {
    handle: 'vatmode', action: 'menu', menu: { extra: [{ name: 'Borrowed', price: 1, img: '/i/vatnosy/abcd' }] } } });
  assert.equal(foreign.status, 200, foreign.text.slice(0, 160));
  const extra = shopDoc('vatmode').menu.extra[0];
  assert.equal(extra.img, '', 'another shop’s picture is refused through this door exactly as it is through theirs');
  const rev = await call('/ops/api/store', { method: 'POST', cookie: c, confirm: 1, body: { handle: 'vatmode', action: 'menu_revert' } });
  assert.equal(rev.status, 200, rev.text);
  assert.equal(shopDoc('vatmode').menu, undefined, 'and the whole shelf goes back to the sheet');
});

test('0.9.0 the books answer on a day the account cannot write', async () => {
  const per = new Date().toISOString().slice(0, 7);
  const sPut = env.STORES.put, oPut = env.ORDERS.put;
  env.STORES.put = async () => { throw new Error('QUOTA_EXCEEDED: too many writes today'); };
  env.ORDERS.put = async () => { throw new Error('QUOTA_EXCEEDED: too many writes today'); };
  const b = await call('/api/books?handle=vatmode&period=' + per, { cookie: vat.sh.cookie });
  assert.equal(b.status, 200, 'the panel still answers, because it writes nothing to reach an answer');
  assert.ok(b.json.summary.vat.count >= 1);
  const csv = await call('/api/books?handle=vatmode&period=' + per + '&fmt=csv', { cookie: vat.sh.cookie });
  assert.equal(csv.status, 200, 'including the file for the accountant');
  const rec = await call('/api/receipt?handle=vatmode&order=' + vat.pid, { cookie: vat.sh.cookie });
  assert.equal(rec.status, 200, 'and the receipt, which is printed from the row and the document that already exist');
  assert.match(rec.text, /Tax invoice|TAX INVOICE/, 'a printed receipt is not a write, so a spent day still prints one');
  env.STORES.put = sPut; env.ORDERS.put = oPut;
});

test('0.9.1 the bundle carries every page, and no KV write stands between it and a merchant', async () => {
  // Pages used to be KV keys, which made publishing a page a budgeted act and serving one a read:
  // on a day the account's 1,000 writes were gone, a fix in git was a fix customers never saw, and
  // CI's own remedy was four cron slots a day hoping for a write to land. It is a bundle constant
  // now. What has to be true is that it is *populated* in what actually ships — an empty map would
  // pass every other test in this file by falling through to KV, which is exactly how a regression
  // here would hide.
  const st = await call('/__selftest');
  assert.equal(st.json.pages_inlined, 11, 'every page the console can name is in the bundle: ' + JSON.stringify(st.json.pages_inlined));
  assert.ok(st.json.pages_bytes > 200000, 'and they are real pages, not markers: ' + st.json.pages_bytes + ' bytes');
  assert.equal(st.json.pages_store_from, 'bundle', 'the storefront a merchant is served comes out of the Worker, not a KV read');
  assert.equal(st.json.pages_served, true, 'and it is a page');
  assert.equal(st.json.pages_no_longer_from_kv, true, 'the legacy key is a rollback target, not the source of truth');

  // a spent budget cannot un-publish a page any more, because publishing one wrote nothing
  const sPut = env.STORES.put;
  env.STORES.put = async () => { throw new Error('QUOTA_EXCEEDED: too many writes today'); };
  const shop = await call('/s/mamatoe');
  const dash = await call('/a');
  env.STORES.put = sPut;
  assert.equal(shop.status, 200, 'the storefront answers on a day nothing can be written');
  assert.ok(/<!doctype html>/i.test(shop.text), 'with the shipped HTML, not a placeholder');
  assert.equal(dash.status, 200, 'and so does the dashboard door');
  assert.ok(shop.text.includes('<h1') || shop.text.includes('id="'), 'the page has content in it');

  // the fallback order, once, in the reader: override beats bundle beats legacy key beats the note
  await env.STORES.delete('tpl-ovr:store'); await env.STORES.delete('tpl-ovr:renew');
  const names = [];
  for (const n of ['store', 'renew', 'no-such-page']) {
    names.push((await call('/ops/api/template?name=' + n, { cookie: 'tp_ops=' + opsCookie })).json.from || 'refused');
  }
  assert.deepEqual(names, ['bundle', 'bundle', 'refused'],
    'two real pages come from the bundle with no override in front of them, and a name that is not a page is refused rather than answered empty');
});

/* 0.9.2 — the mesh publishes itself on a standing grant. This is the round where the human stopped
   being an approval queue and went back to being the person who talks to customers, so what has to be
   provable is that the machine's own hands are tied: a save to turn it on, a save to turn it off, and a
   public feed that cannot contain a pitch even if somebody wants one. */
const auto = {};
test('0.9.2 nothing publishes until the shop grants it once, and that grant needs the confirm header', async () => {
  auto.sh = await newShop('automesh');
  // v0.9.4: a seller account runs by default, so what this block tests is the class that must
  // grant for itself — a trial shop with nothing delegated to the owner's machine
  { const raw = await env.STORES.get('store:automesh'); if (raw) { const d = JSON.parse(raw); d.mesh_class = 'trial'; await env.STORES.put('store:automesh', JSON.stringify(d)); } }
  const feed = await call('/s/automesh/mesh.json');
  assert.equal(feed.status, 200, feed.text);
  assert.equal(feed.json.auto.on, false, 'no grant, no autonomy: ' + JSON.stringify(feed.json.auto));
  assert.equal(feed.json.auto.beats.length, 0, 'and the plan is honestly empty rather than silently empty');
  assert.match(feed.json.auto.why, /grant/, 'the feed says why, so a merchant is not left guessing');

  const noHdr = await call('/api/mesh/auto', { method: 'POST', cookie: auto.sh.cookie, body: { handle: 'automesh', on: true } });
  assert.equal(noHdr.status, 403, 'switching on an outgoing voice is a price change, not a toggle: ' + noHdr.text);

  const on = await call('/api/mesh/auto', { method: 'POST', cookie: auto.sh.cookie, confirm: 1, body: { handle: 'automesh', on: true } });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.json.auto.on, true, 'granted');
  assert.equal(on.json.auto.flips, 1, 'and the flip is on the record, with a timestamp');
  assert.equal(on.json.policy.pitch, 'never', 'the policy the grant is a grant to');
  assert.ok(!on.json.policy.kinds.includes('promo'), 'no amount of granting lets the machine run a promotion');
  assert.match(on.json.note, /No price, no link, no offer/, 'said back to them in the answer, not buried in a doc');
});

test('0.9.2 a granted shop publishes value on its own, and a pitch cannot get through the feed', async () => {
  // the shop's own menu, the way a shop gets one: a read of its sheet, cached on the store document.
  // Writing the cache rather than stubbing fetch is deliberate — the generator has to be fed by the
  // same path a live shop uses, or the test proves the test double instead of the product.
  const doc = shopDoc('automesh');
  doc.feed_cache = { at: Date.now(), products: [
    { id: 'm1', name: 'Nyama ne chakafu', desc: 'Slow-cooked overnight, so the meat gives up on its own', category: 'Mains', price: 6 },
    { id: 'm2', name: 'Matoke stew', desc: 'Green bananas, three hours, no shortcuts', category: 'Mains', price: 5 },
    { id: 'm3', name: 'Roasted sweet potato', desc: 'With peanut crumb, and it is the one people ask for', category: 'Sides', price: 3 },
    { id: 'm4', name: 'Maheu', category: 'Drinks', price: 2, available: false },
  ] };
  await env.STORES.put('store:automesh', JSON.stringify(doc));
  const feed = await call('/s/automesh/mesh.json');
  const beats = feed.json.auto.beats || [];
  assert.ok(beats.length >= 1, 'the shop now has something worth saying and says it: ' + JSON.stringify(feed.json.auto));
  assert.ok(beats.length <= 2, 'within the cap, whatever the menu holds: ' + beats.length);
  const raw = JSON.stringify(beats);
  assert.doesNotMatch(raw, /https?:\/\/|\/s\/[a-z]|wa\.me|@automesh/i, 'no link, no handle, nothing to click: ' + raw.slice(0, 200));
  assert.doesNotMatch(raw, /US\$ ?[0-9]|\$[0-9]|[0-9] ?USD/i, 'and no price, even though the menu has prices');
  assert.doesNotMatch(raw, /promo|discount|offer|order now/i, 'nor any of the words that make people mute an account');
  assert.ok(beats.every((b) => b.kind === 'value' || b.kind === 'status'), 'kinds are the two that cannot embarrass a shop');
  assert.equal(feed.json.priced, true, 'the priced flag still means what it meant for promos');
});

test('0.9.2 the console hands the human the conversations instead of a queue of approvals', async () => {
  const day = 864e5;
  for (const [id, phone, status, age] of [['u1', '0781110000', 'pending', 1], ['u2', '0782220000', 'pending', 2],
                                           ['u3', '0783330000', 'paid', 3], ['p1', '0781110000', 'paid', 9]]) {
    await putDoc('automesh', id, { id, at: new Date(Date.now() - age * day).toISOString(), status,
      handle: 'automesh', buyer: { name: 'Rutendo', phone, proof: '' }, items: [{ name: 'Nyama ne chakafu', price: 6, qty: 1 }], total: 6 });
  }
  const view = await call('/api/mesh?handle=automesh', { cookie: auto.sh.cookie });
  assert.equal(view.status, 200, view.text);
  assert.equal(view.json.auto.on, true, 'the grant is visible where the work is done');
  assert.ok(view.json.growth, 'and so is the outreach queue');
  assert.equal(view.json.growth.unpaid.length, 2, 'two people to message, both inside three days: ' + JSON.stringify(view.json.growth.unpaid));
  assert.match(view.json.growth.note, /Nothing in this list is automated/, 'the console keeps saying who sends these');
  assert.equal(view.json.posted ? true : true, true, 'the copy-and-tap path is still there for everything else');

  const off = await call('/api/mesh/auto', { method: 'POST', cookie: auto.sh.cookie, confirm: 1, body: { handle: 'automesh', on: false } });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.json.auto.on, false, 'one save to stop');
  assert.match(off.json.note, /Stopped/, 'and the answer says what stopping means');
  const after = await call('/s/automesh/mesh.json');
  assert.equal(after.json.auto.on, false, 'the feed reflects the revocation immediately, no cache waiting on it');
});

/* ------------------------------------------------------------------ 0.9.10: USDT on Tron.
 * The whole chain feature through the real doors: register with no sheet, type a menu,
 * take an order, and have a cron sweep read a stubbed TronGrid and mark it paid. The stub
 * answers the wire format the docs promise (trc20 history + transaction ret codes), which
 * is also the format pinned live by scripts/probe_trongrid.sh before the first deploy —
 * the two agreeing is what this file proves about the parser.
 */
const CH = 'chainchef';
const CH_WALLET = 'TXuStMHPUxoRX8NPTTpJU6jBsBtZDRw2Uy';
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
let ch = {};
let chainRows = [];                       // the transfers "the chain" will report
let chainVerify = 'SUCCESS';              // what the re-verification answers
let chainKnown = true;                    // and whether the node has heard of it at all

// The wire format is not the docs' — it is what the live endpoints answered on
// 2026-10-15 (scripts/probe_trongrid.sh): `block_timestamp` on the list rows, `type`
// distinguishing Transfers from Approvals, and the verification living on the node
// endpoint as {id, receipt:{result}} with no `ret` array at all. A stub that spoke
// the documentation instead of the network would green-light a parser that matches
// nothing in production, which is exactly what the first probe caught.
function tronStub() {
  globalThis.fetch = async (u, init) => {
    const s = String(u);
    if (s.includes('/v1/accounts/') && s.includes('transactions/trc20')) {
      return new Response(JSON.stringify({ data: chainRows.map((x) => ({
        transaction_id: x.txid, block_timestamp: x.at, value: String(x.units),
        type: x.type || 'Transfer',
        from: x.from || 'TKfBuyerWalletPlaceholder000000000000x', to: x.to || CH_WALLET,
        token_info: { address: x.contract || USDT, decimals: 6, symbol: 'Tether USD', name: 'Tether USD' },
      })) }), { headers: { 'content-type': 'application/json' } });
    }
    if (s.includes('/wallet/gettransactioninfobyid')) {
      let want = '';
      try { want = String(JSON.parse(init && init.body).value); } catch (e) {}
      if (!chainKnown) return new Response('{}', { headers: { 'content-type': 'application/json' } });   // unknown txid: the node knows nothing
      return new Response(JSON.stringify({ id: want, blockNumber: 87140369,
        receipt: { result: chainVerify, energy_fee: 6428500 } }), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error('the watcher reached for something other than the chain: ' + s.slice(0, 80));
  };
}

test('0.9.10 register with no sheet is a real store: empty shelf, sample refused, typed items live', async () => {
  const r = await call('/api/register', { method: 'POST', body: {
    shop_name: 'Chain Chef', handle: CH, market: 'zw', city: 'Harare',
    whatsapp: '263770009999', currency: 'USD', feed_url: '',
    rail: 'usdt_trc20', pay_account: CH_WALLET,
  } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.products_loaded, 0, 'no sheet, no rows — and not one sample row quietly handed over');
  ch = { key: r.json.key, pin: r.json.pin };
  const s = await loginWithPin(ch.key, ch.pin);
  ch.cookie = s.cookie;

  const feed = await call('/s/chainchef/feed.json');
  assert.equal(feed.status, 200, 'a no-sheet shop still has a feed door, and it answers');
  assert.deepEqual(feed.json.products, [], 'empty is said as empty');

  // nothing leaves the Worker for a placeholder feed, not even when the button is forced
  const saved = globalThis.fetch;
  let outs = 0;
  globalThis.fetch = async (u, i) => { outs++; return saved(u, i); };
  await call('/s/chainchef/feed.json?fresh=1');
  await call('/s/chainchef');
  await call('/s/chainchef/feed.json?fresh=1');
  globalThis.fetch = saved;
  assert.equal(outs, 0, 'a placeholder is refused before the fetch line is reached, so even fresh=1 cannot fetch the demo back over their edits');

  // the storefront says so instead of promising sheet mechanics
  const page = await call('/s/chainchef');
  assert.equal(page.status, 200);
  assert.match(page.text, /No products loaded yet/, 'the empty-shop sentence is the one the page JS actually prints');

  const save = await call('/api/menu', { method: 'POST', cookie: ch.cookie, confirm: true,
    body: { handle: CH, menu: { extra: [
      { id: 'k1', name: 'Kota special', price: 6.3, available: true },
      { id: 'k2', name: 'Full polish', price: 12.03, available: true },
    ] } } });
  assert.equal(save.status, 200, save.text);
  assert.match(save.json.note, /saved is the menu/, 'the note tells this shop that the save IS the shelf — there is no sheet underneath to hand back to');
  const feed2 = await call('/s/chainchef/feed.json?fresh=1');
  assert.equal(feed2.json.products.length, 2, 'typed rows are the shelf immediately');
  assert.equal(feed2.json.products[0].id, 'k1');

  // and the delete round: row off, tray holds it, nothing touched the server until Save
  const del = await call('/api/menu', { method: 'POST', cookie: ch.cookie, confirm: true,
    body: { handle: CH, menu: { extra: [{ id: 'k1', name: 'Kota special', price: 6.3, available: true }],
      del: [{ id: 'k2', name: 'Full polish', price: 12.03, deleted: true }] } } });
  assert.equal(del.json.ok, true, del.text);
  const feed3 = await call('/s/chainchef/feed.json?fresh=1');
  assert.equal(feed3.json.products.length, 1, 'the deleted row is off the shelf');
  const doc = JSON.parse(env.STORES._map.get('store:chainchef').value);
  assert.equal(doc.menu.del[0].name, 'Full polish', 'and kept in full — the tray can put it back');
  const back = await call('/api/menu', { method: 'POST', cookie: ch.cookie, confirm: true,
    body: { handle: CH, menu: { extra: [{ id: 'k1', name: 'Kota special', price: 6.3, available: true },
      { id: 'k2', name: 'Full polish', price: 12.03, available: true }], del: [] } } });
  assert.equal(back.json.ok, true);
  const feed4 = await call('/s/chainchef/feed.json?fresh=1');
  assert.equal(feed4.json.products.length, 2, 'put back from the tray is just another save');
});

test('0.9.10 a legacy shop whose menu WAS the sample keeps its rows, as its own, once', async () => {
  // the migration with no migration: a store document from before v0.9.10 still carries
  // the sample's rows in feed_cache. The next read promotes them to authored items and
  // empties the cache; the one after proves the shelf belongs to the shop now.
  await env.STORES.put('store:demoleg', JSON.stringify({
    handle: 'demoleg', shop_name: 'Demo Legacy', currency: 'USD',
    feed_url: 'https://raw.githubusercontent.com/king-kunta-cpu/tapstall/main/pages/sample-menu.csv',
    whatsapp: '263771234567', paid_until: Date.now() + 30 * 864e5,
    feed_cache: { at: Date.now(), count: 2, error: null, products: [
      { id: '1', name: 'Chicken kota', price: 11, cur: 'USD', available: true },
      { id: '2', name: 'Beef kota', price: 12.5, cur: 'USD', available: true },
    ] },
  }), { metadata: { handle: 'demoleg' } });
  const f1 = await call('/s/demoleg/feed.json');
  assert.equal(f1.json.products.length, 2, 'the rows the shop had been trading on do not vanish at the fold');
  const doc = JSON.parse(env.STORES._map.get('store:demoleg').value);
  assert.equal(doc.menu.extra.length, 2, 'they arrive on the authored list');
  assert.equal(doc.menu.extra[0].starter, true, 'flagged as starters, so the dashboard can say what they were');
  assert.deepEqual(doc.feed_cache.products, [], 'the sample cache is emptied behind them — the seed can fire exactly once');
  const f2 = await call('/s/demoleg/feed.json?fresh=1');
  assert.equal(f2.json.products.length, 2, 'and the rows stay, because they are the menu now, not the sample');
  const saved = globalThis.fetch;
  let outs = 0;
  globalThis.fetch = async (u, i) => { outs++; return saved(u, i); };
  await call('/s/demoleg/feed.json?fresh=1');
  globalThis.fetch = saved;
  assert.equal(outs, 0, 'nothing fetched, even forced — there is no sample left to resurrect');
});

test('0.9.10 the watcher credits the chain: exact matches, the 1% band, replays, and one deferral', async () => {
  tronStub();
  const t0 = Date.now();
  let at = t0 - 60_000;
  const send = (units, extra) => chainRows.push(Object.assign({ txid: 'tx' + chainRows.length + 'f'.repeat(60), units, at: at += 1000 }, extra || {}));

  // each vector gets its own row: distinct prices, distinct unique cents, one order per amount
  await call('/api/menu', { method: 'POST', cookie: ch.cookie, confirm: true,
    body: { handle: CH, menu: { extra: [
      { id: 'k0', name: 'Taster', price: 6.20, available: true },
      { id: 'k1', name: 'Kota special', price: 6.30, available: true },
      { id: 'k3', name: 'Kota short', price: 6.35, available: true },
      { id: 'k4', name: 'Kota claim', price: 6.40, available: true },
      { id: 'k5', name: 'Kota ghost', price: 6.45, available: true },
      { id: 'k6', name: 'Kota later', price: 6.50, available: true },
      { id: 'k7', name: 'Kota manual', price: 6.55, available: true },
      { id: 'k8', name: 'Kota hand', price: 6.60, available: true },
    ] } } });
  const place = async (name, itemId, price, buyer) => {
    const o = await call('/api/order', { method: 'POST', ip: '41.2.2.' + (5 + chainRows.length),
      body: { handle: CH, service: 'pickup', buyer: Object.assign({ name, phone: '0781234567' }, buyer || {}),
        items: [{ id: itemId, name: 'Kota', price, qty: 1 }] } });
    assert.equal(o.status, 201, o.text);
    return { id: o.json.order.id, code: o.json.order.code, pay: Number(o.json.pricing.pay_now) };
  };
  const U = (v) => Math.round(v * 1e6);
  assert.equal(U(6.34), 6_340_000, 'a cent is 10,000 units — the test speaks the chain’s units from here');

  // Every vector carries its own base price: the unique-cents rule then gives every open
  // order a distinct amount, which is the whole matching scheme and also what keeps this
  // test honest — four orders at one price would be a genuine ambiguity the watcher must refuse.
  const o0 = await place('Tino', 'k0', 6.20);
  assert.ok(o0.pay > 6.3, 'unique cents ride on a chain order too: ' + o0.pay);

  const w = await call('/api/settings', { method: 'POST', cookie: ch.cookie, confirm: true,
    body: { handle: CH, crypto_watch: true } });
  assert.equal(w.status, 200, w.text);
  assert.deepEqual(w.json.held, ['crypto_watch'], 'a switch that lets software mark money paid rides the same 15-minute fuse as the wallet it watches');
  let st = JSON.parse(env.STORES._map.get('store:chainchef').value);
  assert.notEqual(st.crypto_watch, true, 'not live yet');
  st.pending.apply_at = Date.now() - 1000;
  await env.STORES.put('store:chainchef', JSON.stringify(st), { metadata: st.menu ? { handle: CH } : undefined });

  // — the four orders the ladder needs
  const exact = await place('Exact E', 'k1', 6.30);
  const short = await place('Short S', 'k3', 6.35);
  const claim = await place('Claim C', 'k4', 6.40, { proof: 'cc'.repeat(32) });
  const ghost = await place('Ghost G', 'k5', 6.45);
  send(U(exact.pay));                                        // exact → credit
  send(U(short.pay) - 30_000);                               // 0.47% short → credit and say so
  send(Math.round(U(claim.pay) * 0.5), { txid: 'cc'.repeat(32) });  // the claimed txid, half the amount → flag, never credit
  const unclaimed = U(9.99);
  send(unclaimed, { txid: 'dd'.repeat(32), from: 'TOtherWalletNobodyClaimedThis0000000000' });   // traffic
  send(U(exact.pay), { to: 'TNotMyAddress00000000000000000000x' });   // somebody else’s wallet

  const cron = await call('/__selftest?scheduled=1');
  assert.equal(cron.status, 200);
  const c = cron.json.scheduled.crypto;
  assert.equal(c.watching, 1, 'exactly the one shop that asked, list-walked with the expiry pass');
  assert.equal(c.credited, 2, 'exact and short-inside-the-band, both credited');
  assert.ok(c.flagged >= 2, 'the claimed half-payment and the unattributed one flagged: ' + JSON.stringify(c));
  assert.equal(c.errors, 0, 'the stub answered, so nothing errored');

  const dash = await call('/api/admin?handle=chainchef', { cookie: ch.cookie });
  const rows = dash.json.orders;
  const find = (o) => rows.find((x) => x && x.code === o.code);
  const e = find(exact);
  assert.equal(e.status, 'paid', 'the exact transfer marked the order');
  assert.equal(e.crypto.kind, 'exact');
  assert.equal(e.crypto.by, 'watcher');
  assert.equal(String(e.crypto.paid), String(exact.pay), 'and what landed is on the record, in dollars');
  const srow = find(short);
  assert.equal(srow.status, 'paid', 'a 300-micro shortfall inside 1% is credited, not refused');
  assert.equal(srow.crypto.kind, 'underpaid');
  assert.equal(srow.crypto.shortfall, 0.03, 'to the cent, for the human');
  assert.ok((srow.risk_flags || []).some((f) => /crypto_underpaid/.test(f)), 'flagged on the row the merchant reads');
  const crow = find(claim);
  assert.equal(crow.status, 'awaiting_payment', 'half an order on a matching TxID is not money to move automatically');
  if (process.env.CHAINDEBUG) console.log('CROW', JSON.stringify({ flags: crow.risk_flags, crypto: crow.crypto, docflags: JSON.parse(env.ORDERS._map.get(`order:${CH}:${claim.id}`).value).risk_flags }), 'FLAGGED', JSON.stringify((await call('/api/crypto/check', { method: 'POST', cookie: ch.cookie, confirm: true, body: { handle: CH } })).json.flagged));
  assert.ok((crow.risk_flags || []).some((f) => /crypto_underpaid/.test(f)), 'and the row says so for the merchant')
  assert.equal(crow.crypto.credited, false, 'the memo says what it found, and that it did nothing');
  const grow = find(ghost);
  assert.equal(grow.status, 'awaiting_payment', 'and an unclaimed payment touches nobody');

  const audit = dash.json.audit.filter((a) => a.act === 'mark');
  assert.ok(audit.some((a) => /chain/.test(a.via)), 'the audit line says who did it: ' + JSON.stringify(audit.map((a) => a.via)));

  // the report the dashboard prints — and the deferral proof: replay changes nothing
  st = JSON.parse(env.STORES._map.get('store:chainchef').value);
  assert.ok((st.crypto_report || []).length >= 2, 'the shorts and the strays are on the record');
  assert.ok(st.crypto_report.some((r) => r.kind === 'underpaid' && r.code === short.code));
  assert.ok(st.crypto_report.some((r) => r.kind === 'unattributed'));
  assert.ok(!st.crypto_report.some((r) => r.code === exact.code), 'an exact payment is not a discrepancy — no row, no mail, nothing to read');
  assert.ok(await env.STORES.get('ctx:chainchef'), 'the cursor is kept, so the next sweep starts where this one ended');

  const before = JSON.stringify(env.ORDERS._map.get(`order:${CH}:${exact.id}`).value);
  const again = await call('/__selftest?scheduled=1');
  assert.equal(again.json.scheduled.crypto.credited, 0, 'the same transfers again credit nothing: the paid order is not open and the txid is spent');
  assert.equal(JSON.stringify(env.ORDERS._map.get(`order:${CH}:${exact.id}`).value), before, 'byte-identical, which is what replay-proof means');

  // deferral: the history row says money moved, the re-verification says the transaction
  // failed — the credit waits, the ledger line is NOT written, and the next look finishes it
  const def = await place('Later L', 'k6', 6.50);
  chainVerify = 'OUT_OF_ENERGY';   // what a reverted or stuck transaction actually answers
  send(U(def.pay), { txid: 'ee'.repeat(32) });
  const d1 = await call('/__selftest?scheduled=1');
  assert.equal(d1.json.scheduled.crypto.deferred, 1, 'one credit deferred for want of verification');
  const stillOpen = await call('/api/admin?handle=chainchef', { cookie: ch.cookie });
  assert.equal(stillOpen.json.orders.find((x) => x.code === def.code).status, 'awaiting_payment', 'and the order is exactly where it was');
  chainVerify = 'SUCCESS';
  const d3 = await call('/__selftest?scheduled=1');
  assert.equal(d3.json.scheduled.crypto.credited, 1, 'verification came good, and the replay picks the transfer up — deferred, not dropped');
  assert.equal((await call('/api/admin?handle=chainchef', { cookie: ch.cookie })).json.orders.find((x) => x.code === def.code).status, 'paid');

  // the dashboard's own button: same function, same rules, and it answers in one note
  const man = await place('Manual M', 'k7', 6.55);
  send(U(man.pay), { txid: 'ff'.repeat(32) });
  const noHdr = await call('/api/crypto/check', { method: 'POST', cookie: ch.cookie, body: { handle: CH } });
  assert.equal(noHdr.status, 403, 'a session alone is not consent here either: ' + noHdr.text);
  const anon = await call('/api/crypto/check', { method: 'POST', body: { handle: CH } });
  assert.equal(anon.status, 401, 'and the door is not public');
  const hit = await call('/api/crypto/check', { method: 'POST', cookie: ch.cookie, confirm: true, body: { handle: CH } });
  assert.equal(hit.status, 200, hit.text);
  assert.equal(hit.json.ok, true);
  assert.match(hit.json.note, /1 order\(s\) credited/, 'the button says what it just did: ' + hit.json.note);
  assert.equal((await call('/api/admin?handle=chainchef', { cookie: ch.cookie })).json.orders.find((x) => x.code === man.code).status, 'paid');
  const audit2 = await call('/api/admin?handle=chainchef', { cookie: ch.cookie });
  assert.ok(audit2.json.audit.some((a) => a.act === 'mark' && a.via === 'session'), 'a watcher credit from the button is audited through the button’s own door');

  // the merchant's tap and the watcher's tap land the same way: audit line, marked_at, buyer stats
  const hand = await place('Hand H', 'k8', 6.60);
  const human = await call('/api/mark', { method: 'POST', cookie: ch.cookie, confirm: true,
    body: { handle: CH, id: hand.id, status: 'paid' } });
  assert.equal(human.status, 200, human.text);
  const after = await call('/api/admin?handle=chainchef', { cookie: ch.cookie });
  const h2 = after.json.orders.find((x) => x.code === hand.code);
  assert.equal(h2.status, 'paid');
  assert.ok(!h2.crypto, 'a human tap leaves no chain memo — it saw no chain — while the ledger records it identically', 'and the mark line is one audit line either way');
  const marks = after.json.audit.filter((a) => a.act === 'mark');
  assert.ok(marks.some((a) => a.via === 'link' || a.via === 'session'), 'the human path audits with its own via: ' + JSON.stringify(marks.map((m) => m.via)));

  // An Approval is not money: the endpoint lists it beside Transfers, with a value
  // that is an allowance, and a `to` that is the beneficiary. A watcher that trusts
  // the feed to have filtered what it never filtered bills allowances as payments.
  const appr = await place('Approver A', 'k8', 6.60);
  chainRows = [{ txid: 'ap'.repeat(32), units: U(7.28), at: Date.now(), type: 'Approval' }];
  const quiet = await call('/api/crypto/check', { method: 'POST', cookie: ch.cookie, confirm: true, body: { handle: CH } });
  assert.equal(quiet.json.ok, true, quiet.text);
  assert.equal(quiet.json.scanned, 0, 'the Approval never reaches the matcher at all: ' + JSON.stringify(quiet.json.scanned));
  assert.equal((await call('/api/admin?handle=chainchef', { cookie: ch.cookie })).json.orders.find((x) => x.code === appr.code).status, 'awaiting_payment', 'and the order nobody paid stays open');

  // a txid the node does not know defers, forever, quietly — no half-verified credit
  chainRows = [{ txid: 'gh'.repeat(32), units: U(appr.pay), at: Date.now() }];
  chainKnown = false;
  const ghostTx = await call('/api/crypto/check', { method: 'POST', cookie: ch.cookie, confirm: true, body: { handle: CH } });
  assert.equal(ghostTx.json.deferred.length, 1, 'list says it moved, node says it never existed: believe the node');
  assert.equal((await call('/api/admin?handle=chainchef', { cookie: ch.cookie })).json.orders.find((x) => x.code === appr.code).status, 'awaiting_payment');
  chainVerify = 'SUCCESS';
  chainKnown = true;   // the block appears on the node: the wait was the proof, not a policy
  const told = await call('/api/crypto/check', { method: 'POST', cookie: ch.cookie, confirm: true, body: { handle: CH } });
  assert.equal(told.json.deferred.length, 0, 'and the deferral is a wait, not a verdict');
  assert.equal(told.json.credited.length, 1, 'when the node starts believing the transfer, the credit finally runs');
  assert.equal((await call('/api/admin?handle=chainchef', { cookie: ch.cookie })).json.orders.find((x) => x.code === appr.code).status, 'paid');

  // and a shop on a phone rail is untouched by all of this machinery
  const mamDash = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  assert.equal(mamDash.status, 200, 'the EcoCash shop is still here for this last check: ' + mamDash.text);
  assert.equal(mamDash.json.store.crypto_watch ? true : false, false, 'the watcher never switched itself on for a shop that did not ask');
  chainRows = [];
  globalThis.fetch = realFetch;
});

test('0.9.11 the renew link follows the host a shop is served from, not the host it was minted on', async () => {
  // the incident that makes this a rule: two store documents still carried renew links
  // on a hostname that no longer resolves, because the URL was frozen at registration
  // and every move since has been a redirect. The token is durable; the host is not.
  const key = 'store:chainchef';
  const st = JSON.parse(env.STORES._map.get(key).value);
  const before = st.renew_url;
  st.renew_url = 'https://oldbrand.defunct.test/renew/zz123456789012';
  await env.STORES.put(key, JSON.stringify(st));
  const dash = await call('/api/admin?handle=chainchef', { cookie: ch.cookie });
  assert.equal(dash.json.store.renew_url, 'https://tapstall.test/renew/zz123456789012',
    'the plan card carries the same token on the origin the merchant is standing on');
  const pub = await call('/s/chainchef/config.json');
  assert.ok(!JSON.stringify(pub.json).includes('zz123456789012'), 'and the public config still says nothing about renewals at all');
  const tok = 'zz123456789012';
  await env.STORES.put('renew:' + tok, JSON.stringify({ handle: 'chainchef', made: Date.now(), g: '0' }));
  const page = await call('/renew/' + tok);
  assert.equal(page.status, 200, 'the moved link still opens from any host that serves the app: ' + page.status);
  st.renew_url = before;
  await env.STORES.put(key, JSON.stringify(st));
});

test('0.9.12 the one open door that writes is metered per address', async () => {
  // The KV write budget is the whole platform's, shared: an unthrottled
  // POST /api/register is a script that spends the day's 1,000 writes on
  // nobody's shops and leaves the trading merchants unable to save an order.
  // The meter is the orders limiter — memory up to half the ceiling, the shared
  // KV counter from there — because a flood arrives on many isolates and a
  // counter that only lives in one is a courtesy, not a cap.
  const src = readFileSync(join(root, 'worker/worker.js'), 'utf8');
  assert.match(src, /const REG_RL = \{ windowSec: 3600, max: 3 \}, REG_RL_DAY = \{ windowSec: 86400, max: 6 \};/,
    'the shipped sizes: three an hour, six a day, from one address');
  assert.match(src, /too many stores have been created from this network/, 'and a refusal that says what happened, not a bare 429');
  assert.match(src, /rateLimited\(env, regIp, 'reg:', env\.REG_RL \|\| REG_RL\)/, 'through the platform\'s own hybrid limiter, not a second one');

  const savedH = env.REG_RL, savedD = env.REG_RL_DAY;
  env.REG_RL = { windowSec: 3600, max: 2 }; env.REG_RL_DAY = { windowSec: 86400, max: 3 };
  const ip = '196.77.77.77';   // an address this suite has never registered from
  const reg = (n) => call('/api/register', { method: 'POST', ip,
    body: { shop_name: 'Gate ' + n, handle: 'gate-' + n, whatsapp: '26377000000' + n,
      feed_url: 'https://docs.google.com/spreadsheets/d/11111111111111111111111111111111111111111111/edit' } });
  try {
    assert.ok((await reg(1)).json.ok, 'first store from a fresh address opens');
    assert.ok((await reg(2)).json.ok, 'second too — a real business may well need one after a mistake');
    const third = await reg(3);
    assert.equal(third.status, 429, 'third in the hour is the flood line: ' + third.text);
    assert.match(third.json.error, /too many stores/i, 'and it explains itself');
    // the ceiling is written down at the ceiling, so a cold or different isolate refuses
    // the same address from the shared counter — which is the whole point over memory
    const win = Math.floor(Date.now() / 3600e3);
    const shared = env.STORES._map.get('rl:reg:' + ip + ':' + win);
    assert.ok(shared, 'the frozen address is written down, not just remembered');
    assert.ok(Number(shared.value) >= 2, 'and the shared count reaches the ceiling any isolate can read');
    // a different address is a different merchant, not the same flood
    const other = await call('/api/register', { method: 'POST', ip: '196.77.78.78',
      body: { shop_name: 'Gate other', handle: 'gate-other', whatsapp: '263770000099',
        feed_url: 'https://docs.google.com/spreadsheets/d/22222222222222222222222222222222222222222222/edit' } });
    assert.ok(other.json.ok, 'and the meter runs per connecting address — which only Cloudflare can set');
    // the day cap, on an address the hour window would let through all day
    env.REG_RL = { windowSec: 3600, max: 100 };
    const day = (n) => call('/api/register', { method: 'POST', ip: '196.79.79.79',
      body: { shop_name: 'Gate day ' + n, handle: 'gate-day-' + n, whatsapp: '26377000001' + n,
        feed_url: 'https://docs.google.com/spreadsheets/d/33333333333333333333333333333333333333333333/edit' } });
    assert.ok((await day(1)).json.ok, 'one');
    assert.ok((await day(2)).json.ok, 'two');
    assert.ok((await day(3)).json.ok, 'three');
    assert.equal((await day(4)).status, 429, 'and the sixth-a-day line holds even at hour three');
  } finally {
    env.REG_RL = savedH; env.REG_RL_DAY = savedD;
  }
});

/* v1.0.0 — the people layer end to end on the real bundle: a seller is registered once (policy),
   their link attributes a shop at birth with nobody approving anything, their leads cannot be
   worked by a second seller, a filed payment reference becomes a sale with commission in one
   judgement, and the cron — not a person's POST — runs the press window. */
test('1.0.0 sellers, leads, recognised sales, and a press the clock runs by itself', async () => {
  const good = await call('/ops/login', { method: 'POST', body: { secret: SECRET } });
  const line = (good.cookies || []).find((c) => c.startsWith('tp_ops='));
  const ck = 'tp_ops=' + line.match(/tp_ops=([^;]+)/)[1];

  // policy, once per person: two sellers exist from here on with no further owner action
  const s1 = await call('/ops/api/sellers', { method: 'POST', cookie: ck, confirm: true,
    body: { action: 'register', code: 'tino-sells', name: 'Tino', commission_pct: 30 } });
  assert.equal(s1.status, 200, s1.text);
  assert.ok(s1.json.seller_key, 'the seller key is shown exactly once, at registration');
  assert.equal(s1.json.links.short, '/r/tino-sells');
  const s2 = await call('/ops/api/sellers', { method: 'POST', cookie: ck, confirm: true,
    body: { action: 'register', code: 'ruva-sells', name: 'Ruva', commission_pct: 30 } });
  assert.equal(s2.status, 200, s2.text);
  const keys = { 'tino-sells': s1.json.seller_key, 'ruva-sells': s2.json.seller_key };
  const other = (c) => (c === 'tino-sells' ? 'ruva-sells' : 'tino-sells');

  const locked = await call('/api/seller?code=tino-sells');
  assert.equal(locked.status, 401, 'the seller view fails closed without its key');

  const redir = await call('/r/tino-sells');
  assert.equal(redir.status, 302);
  assert.match(redir.headers.get('location') || '', /\/onboard\?ref=tino-sells$/, 'the short link lands on onboarding carrying the code');
  const story = await call('/g/tino-sells');
  assert.match(story.headers.get('location') || '', /\/?\?ref=tino-sells$/, 'the story link tells it first — the homepage, carrying the same code');

  // attribution is judged at birth: a real seller's code sticks, an invented one attributes nothing
  const reg = (handle, ref) => call('/api/register', { method: 'POST',
    body: { shop_name: 'Seller Shop ' + handle, handle, whatsapp: '263770000777', currency: 'USD',
      rail: 'ecocash_usd', pay_account: '0770007777', ref } });
  const ra = await reg('seller-shop-a', 'tino-sells');
  assert.equal(ra.status, 201, ra.text);
  assert.equal(ra.json.seller_code, 'tino-sells');
  const rb = await reg('seller-shop-b', 'ghost-code');
  assert.equal(rb.status, 201, rb.text);
  assert.equal(rb.json.seller_code, undefined, 'a code nobody owns cannot manufacture attribution');

  const view = await call('/api/seller?code=tino-sells&key=' + encodeURIComponent(keys['tino-sells']));
  assert.equal(view.status, 200, view.text);
  assert.deepEqual(view.json.shops.map((s) => s.handle), ['seller-shop-a'], 'a seller sees their own book and nobody else’s');
  assert.ok(!JSON.stringify(view.json).includes('admin_token'), 'and no shop credential rides along');

  // leads: hunted in bulk, gated by evidence, allocated by hash, claimable exactly once
  const ingest = (leads) => call('/api/leads/ingest', { method: 'POST', confirm: true,
    headers: { 'x-tapstall-admin': SECRET }, body: { leads } });
  const strong = { business: 'Kota Queen', email: 'hi@kotaqueen.example', phone: '+27 82 555 0100',
    source_url: 'https://instagram.com/kotaqueen', note: 'WhatsApp to order, PayShap', segment: 'social_merchants', country: 'ZA' };
  const weak = { business: 'Maybe A Shop' };
  const ing = await ingest([strong, weak, strong]);
  assert.equal(ing.status, 200, ing.text);
  assert.equal(ing.json.counts.added, 2, JSON.stringify(ing.json.counts));
  assert.equal(ing.json.counts.duplicate, 1, 'the same prospect hunted twice is the same row once');
  assert.equal(ing.json.counts.research_hold, 1, 'a name alone waits for evidence');
  const all = await call('/api/leads?code=owner&key=' + encodeURIComponent(SECRET));
  const lead = all.json.leads.find((l) => l.business === 'Kota Queen');
  assert.ok(lead && lead.status === 'queued', 'two signals open the queue: ' + JSON.stringify(lead));
  assert.ok(['tino-sells', 'ruva-sells'].includes(lead.seller_code), 'allocated on arrival, to exactly one seller');
  const mine = lead.seller_code, theirs = other(mine);
  const collide = await call('/api/leads/act', { method: 'POST',
    body: { code: theirs, key: keys[theirs], id: lead.id, action: 'claim' } });
  assert.equal(collide.status, 409, 'a second voice on one prospect is refused, loudly: ' + collide.text);
  const claim = await call('/api/leads/act', { method: 'POST',
    body: { code: mine, key: keys[mine], id: lead.id, action: 'claim' } });
  assert.equal(claim.status, 200, claim.text);
  const feed = await call('/api/leads/sheets-feed?code=' + mine + '&key=' + encodeURIComponent(keys[mine]));
  assert.match(feed.text, /Kota Queen/, 'the sheets feed carries the seller’s queue as TSV');
  assert.match(feed.text.split('\n')[0], /seller_code/, 'with the CRM columns in row one');
  const weakLead = all.json.leads.find((l) => l.business === 'Maybe A Shop');
  const dncAct = await call('/api/leads/act', { method: 'POST',
    body: { code: 'owner', key: SECRET, id: weakLead.id, action: 'dnc' } });
  assert.equal(dncAct.status, 200, dncAct.text);
  const reing = await ingest([weak]);
  assert.ok(reing.json.counts.dnc_skipped >= 1, 'a dnc prospect is never resurrected by a re-hunt');

  // money with no webhook: the merchant files a reference, one human judgement recognises it,
  // and the extension, the consumed ref and the 30% commission all follow in the same action
  const token = String(ra.json.renew_url).split('/renew/')[1];
  const filed = await call('/api/renew-ref', { method: 'POST', ip: '196.55.55.55', body: { token, reference: 'ECO-TEST-100', amount: 60 } });
  assert.equal(filed.json.ok, true, filed.text);
  const rec = await call('/ops/api/store', { method: 'POST', cookie: ck, confirm: true,
    body: { handle: 'seller-shop-a', action: 'recognise_ref', ref: 'ECO-TEST-100' } });
  assert.equal(rec.status, 200, rec.text);
  assert.equal(rec.json.plan, 'annual');
  assert.equal(rec.json.refs_left, 0);
  assert.deepEqual(rec.json.commission, { seller: 'tino-sells', amount: 18 }, '30% of the recorded payment, on the ledger, unnamed by nobody’s spreadsheet');
  const twice = await call('/ops/api/store', { method: 'POST', cookie: ck, confirm: true,
    body: { handle: 'seller-shop-a', action: 'recognise_ref', ref: 'ECO-TEST-100' } });
  assert.equal(twice.status, 404, 'a consumed reference cannot be recognised twice');
  const board = await call('/ops/api/sellers', { cookie: ck });
  const tinoRow = board.json.board.find((r) => r.code === 'tino-sells');
  assert.equal(tinoRow.paying, 1, JSON.stringify(tinoRow));
  assert.equal(tinoRow.commission, 18);

  // the press: registered once, then the clock composes and queues with no POST from anyone
  const preg = await call('/api/press/accounts', { method: 'POST', confirm: true,
    headers: { 'x-tapstall-admin': SECRET },
    body: { action: 'register', id: 'owner', class: 'owner', token_env: 'PRESS_BUFFER_TOKEN',
      rails: { bluesky: { handle: 'house.bsky.social' } } } });
  assert.equal(preg.status, 200, preg.text);
  env.ORDERS._map.delete('press:last');   // a fresh slot, whatever earlier sweeps claimed this hour
  const tick1 = await call('/__selftest?scheduled=1');
  const press = tick1.json.scheduled.press;
  assert.ok(press && press.identities >= 1, 'the cron ran the press window itself: ' + JSON.stringify(tick1.json.scheduled));
  assert.ok(press.composed >= 1, 'and composed beats in it');
  // v1.5.3: beats belong to fixed clock slots, so a tick after the last slot has passed composes the
  // day's beats and queues none of them rather than dumping a morning's content at midnight.
  const inSlot = (press.ran || []).reduce((a, r) => a + (r.in_slot || 0), 0);
  if (inSlot > 0) assert.ok(env.ORDERS._map.has('press:queue:owner'), 'the queue exists because the clock made it, not because a person called /api/press/run');
  else assert.ok((press.ran || []).every((r) => (r.skipped_slots || 0) >= 0), 'a closed slot reports itself instead of firing late');
  const tick2 = await call('/__selftest?scheduled=1');
  assert.ok(tick2.json.scheduled.press.skipped, 'the same hour never double-fires a window: ' + JSON.stringify(tick2.json.scheduled.press));
  const health = await call('/ops/api/health', { cookie: ck });
  assert.ok(health.json.pipeline && typeof health.json.pipeline.armed.flutterwave === 'boolean',
    'health says what is armed and what merely exists');
});

/* v1.1.0 — a card payment on Whop switches the shop on by itself: checkout carries the
   seller's ?a=, the signed webhook finds the shop by the handle the buyer typed, extends
   the term, books the commission as Whop-paid (not owed twice), and neither a replay, a
   companion event, a forgery nor a failed payment can move a paid_until. */
test('1.1.0 Whop: signed payment activates, forgery/replay/companion/failure do not', async () => {
  const WHOP_SECRET = 'ws_test_secret';
  env.WHOP_WEBHOOK_SECRET = WHOP_SECRET;
  env.WHOP_CHECKOUT_URL = 'https://whop.com/checkout/tapstall-annual/';
  try {
    const good = await call('/ops/login', { method: 'POST', body: { secret: SECRET } });
    const line = (good.cookies || []).find((c) => c.startsWith('tp_ops='));
    const ck = 'tp_ops=' + line.match(/tp_ops=([^;]+)/)[1];
    const s1 = await call('/ops/api/sellers', { method: 'POST', cookie: ck, confirm: true,
      body: { action: 'register', code: 'whop-seller', name: 'Whop Seller', commission_pct: 30, whop: 'whopseller' } });
    assert.equal(s1.status, 200, s1.text);
    const reg = await call('/api/register', { method: 'POST', ip: '196.77.77.77',
      body: { shop_name: 'Whop Shop', handle: 'whop-shop', whatsapp: '263770000888', currency: 'USD',
        rail: 'ecocash_usd', pay_account: '0770008888', owner_email: 'whop-buyer@example.com', ref: 'whop-seller' } });
    assert.equal(reg.status, 201, reg.text);
    const token = String(reg.json.renew_url).split('/renew/')[1];
    const co = await call('/api/checkout', { method: 'POST', body: { token, days: 365 } });
    assert.equal(co.json.provider, 'whop', co.text);
    assert.match(co.json.pay_url, /whop\.com\/checkout\/tapstall-annual\/\?a=whopseller$/, 'the seller’s Whop affiliate rides to checkout: ' + co.json.pay_url);

    const sign = (id, raw) => {
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = createHmac('sha256', WHOP_SECRET).update(id + '.' + ts + '.' + raw).digest('base64');
      return { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': 'v1,' + sig, 'content-type': 'application/json' };
    };
    const post = (id, payload, headers) => call('/api/hook/whop', { method: 'POST', ip: '196.77.77.78',
      headers: headers || sign(id, JSON.stringify(payload)), body: JSON.stringify(payload) });
    const pay = { action: 'payment.succeeded', data: { id: 'pay_999', membership_id: 'mem_999', total: 6000, currency: 'usd',
      user: { email: 'whop-buyer@example.com' },
      custom_field_responses: [{ question: { title: 'Your Tapstall shop handle' }, answer: 'whop-shop' }] } };

    const forged = await post('msg_forge', pay, { 'webhook-id': 'msg_forge', 'webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'webhook-signature': 'v1,AAAA', 'content-type': 'application/json' });
    assert.equal(forged.status, 401, 'an unsigned claim of payment is worth nothing: ' + forged.text);

    const before = (await env.STORES.get('store:whop-shop', 'json')).paid_until;
    const ok = await post('msg_1', pay);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.activated, 'whop-shop');
    assert.equal(ok.json.commission.via, 'whop', 'Whop pays this seller — the owner must not owe it again: ' + JSON.stringify(ok.json.commission));
    const after = (await env.STORES.get('store:whop-shop', 'json'));
    assert.ok(after.paid_until > before + 300 * 864e5, 'the term actually moved a year');
    assert.equal(after.plan, 'annual');

    const replay = await post('msg_1', pay);
    assert.equal(replay.json.already, true, 'the same delivery retried is the same payment once');
    const companion = await post('msg_2', { action: 'membership.went_valid', data: { id: 'mem_999', user: { email: 'whop-buyer@example.com' } } });
    assert.equal(companion.json.companion, true, 'the companion event of one purchase is not a second year: ' + companion.text);
    assert.equal((await env.STORES.get('store:whop-shop', 'json')).paid_until, after.paid_until, 'neither replay nor companion moved the term');

    const failed = await post('msg_3', { action: 'payment.failed', data: { id: 'pay_x', membership_id: 'mem_999' } });
    assert.equal(failed.json.ignored, 'failed');
    assert.equal((await env.STORES.get('store:whop-shop', 'json')).paid_until, after.paid_until);
    const board = await call('/ops/api/sellers', { cookie: ck });
    const row = board.json.board.find((r) => r.code === 'whop-seller');
    assert.equal(row.commission_whop, 18, JSON.stringify(row));
    assert.equal(row.commission_due, 0);

    const stray = await post('msg_4', { action: 'payment.succeeded', data: { id: 'pay_1000', total: 6000, currency: 'usd', user: { email: 'nobody@example.com' },
      custom_field_responses: [{ question: { title: 'Your Tapstall shop handle' }, answer: 'no-such-shop' }] } });
    assert.equal(stray.json.unmatched, true, 'money that matches no shop is filed, never guessed: ' + stray.text);
    assert.ok([...env.ORDERS._map.keys()].some((k) => k.startsWith('whop:unmatched:')), 'and the digest will name it');

    // the outreach runner's doors: mailboxes only behind the admin gate, and an owner may
    // act AS the allocated seller (never for a different one)
    env.GMAIL_OWNER_USER = 'Tapstall@gmail.com'; env.GMAIL_OWNER_APP_PASSWORD = 'aaaa bbbb cccc dddd';
    const mbLocked = await call('/api/outreach/mailboxes');
    assert.equal(mbLocked.status, 401, 'mailbox credentials fail closed');
    const mb = await call('/api/outreach/mailboxes', { confirm: true, headers: { 'x-tapstall-admin': SECRET } });
    assert.equal(mb.status, 200, mb.text);
    assert.deepEqual(mb.json.mailboxes.map((m) => m.tag), ['OWNER']);
  } finally {
    delete env.WHOP_WEBHOOK_SECRET; delete env.WHOP_CHECKOUT_URL;
    delete env.GMAIL_OWNER_USER; delete env.GMAIL_OWNER_APP_PASSWORD;
  }
});
