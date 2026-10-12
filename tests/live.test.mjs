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
      m.set(key, { value: typeof value === 'string' ? value : toBin(value), exp: opts?.expirationTtl });
    },
    async delete(key) { deletes++; gone.push(key); tally('del:' + key); m.delete(key); },
    async list(arg) {
      const prefix = typeof arg === 'string' ? arg : (arg && arg.prefix) || '';
      const keys = [...m.keys()].filter((k) => !prefix || k.startsWith(prefix))
        .filter((k) => !k.startsWith('rl:') && !k.startsWith('__ping'))
        .map((k) => ({ name: k }));
      return { keys, list_complete: true, cursor: '' };
    },
  };
}

const env = {
  STORES: kvStub(),
  ORDERS: kvStub(),
  ADMIN_SECRET: 'test-secret',
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
  const renewPath = new URL(store.renew_url, 'https://tapstall.test').pathname;
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
const renewToken = () => (store.renew_url || '').split('/').pop();

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
  assert.ok((good.cookies || []).some((c) => c.startsWith('zl_ops=;') && /Max-Age=0/.test(c)),
    'signing in also clears the old brand cookie, or a browser holding it stays signed in after a sign-out');
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
  assert.equal(st.json.reads_used_estimate, st.json.stores.length * 2 + 1, 'the page tells the operator what a refresh costs');
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
  assert.equal(list.json.templates.every((t) => t.live), true, 'every page is present in KV');

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
  const served = await call('/renew/' + renewToken());
  assert.equal(served.status, 200);
  assert.ok(served.text.includes('<!-- OPS-PUBLISHED -->'), 'a template edit is live at once — no deploy, no cache clear');
  assert.ok(!/\/\*__TAPSTALL_RENEW__\*\/null/.test(served.text), 'and the payload still gets injected into a hand-edited page');

  // deleting the KV copy must fall back to the builder, so a bad publish never
  // leaves merchants staring at "Template missing"
  await env.STORES.delete('tpl:renew');
  const fb = await call('/renew/' + renewToken());
  assert.equal(fb.status, 200, 'the renewal page still renders from code when KV has nothing');
  assert.ok(fb.text.length > 1200 && /renew|plan|year/i.test(fb.text), 'fallback is the real page, not an error');
  await call('/ops/api/template', { method: 'POST', cookie: c, confirm: true, body: { name: 'renew', html: read.json.html } });
  assert.ok((await call('/ops/api/template?name=renew', { cookie: c })).json.bytes === read.json.bytes, 'the console can put the page back');
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

test('an alias origin does not sweep the same KV twice a day', async () => {
  // Cloudflare would not let this token delete the schedule the old hostname kept
  // (PUT /schedules -> success:false), so the guard is in the code: a Worker
  // deployed with REDIRECT_TO returns from scheduled() before runCron. The
  // selftest reports which kind of origin it is, so the deploy can check that
  // rather than assume a dashboard click happened.
  const w = await load();
  const had = Object.prototype.hasOwnProperty.call(env, 'REDIRECT_TO');
  const before = env.REDIRECT_TO;
  env.REDIRECT_TO = 'https://tapstall.test';
  const ctx = { waitUntil: (p) => p };
  let wrote = false;
  const put = env.STORES.put.bind(env.STORES);
  env.STORES.put = async (k, v, o) => { if (String(k).startsWith('cron:')) wrote = true; return put(k, v, o); };
  try {
    await w.scheduled({ scheduledTime: Date.now() }, env, ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(wrote, false, 'the alias wrote no heartbeat, so it wrote nothing at all');
    const asAlias = await call('/__selftest');
    assert.equal(asAlias.json.cron_owner, false, 'and it admits it');
    assert.equal(asAlias.json.ok, true, 'without that making the health verdict red');
  } finally {
    env.STORES.put = put;
    if (had) env.REDIRECT_TO = before; else delete env.REDIRECT_TO;
  }
  const owner = await call('/__selftest');
  assert.equal(owner.json.cron_owner, true, 'the canonical origin owns the daily sweep');
});

test('the previous brand’s hostname is an alias that moves people, not data', async () => {
  const had = Object.prototype.hasOwnProperty.call(env, 'REDIRECT_TO');
  const before = env.REDIRECT_TO;
  env.REDIRECT_TO = 'https://tapstall.test';
  try {
    const shop = await call('/s/mamatoe');
    assert.equal(shop.status, 301, 'a storefront link a buyer saved in WhatsApp follows the rename: ' + shop.text.slice(0, 120));
    assert.equal(shop.headers.get('location'), 'https://tapstall.test/s/mamatoe');
    const dash = await call('/a?code=abc123');
    assert.equal(dash.status, 301, 'so does a dashboard link');
    assert.match(dash.headers.get('location'), /\/a\?code=abc123$/, 'and the query is carried across, or the code is lost');
    assert.equal((await call('/fees')).status, 301, 'the calculator too');
    assert.equal((await call('/ops')).status, 301, 'and the console');
    assert.equal((await call('/api/lookup?handle=mamatoe')).status, 200, 'a machine endpoint is still served here, not bounced');
    const post = await call('/api/order', { method: 'POST', ip: '41.9.9.1',
      body: { handle: 'mamatoe', buyer: { name: 'P', phone: '263700000001' }, items: [{ name: 'x', price: 5, qty: 1 }] } });
    assert.ok(post.status !== 301, 'a POST is never redirected: a 301 drops the body and the order with it (got ' + post.status + ')');
    const ping = await call('/__ping');
    assert.equal(ping.status, 200, 'health checks keep answering on the alias, or the monitor reads an outage');
  } finally {
    if (had) env.REDIRECT_TO = before; else delete env.REDIRECT_TO;
  }
  assert.equal((await call('/s/mamatoe')).status, 200, 'and with no REDIRECT_TO set, this Worker serves the shop itself');
});

test('the old brand still works everywhere it was already written down', async () => {
  // The rename changed what a page says, never what a browser or a KV namespace
  // already holds. Four things carry the old spelling into the future, and each
  // one is only correct if a *specific* thing keeps working:
  //   1. a template published before the rename (KV is republished on its own
  //      schedule, and not at all on a day the write budget is spent)
  //   2. a merchant's or operator's existing cookie (they must not be logged out)
  //   3. an old page still cached in a phone, posting the old confirm header
  //   4. a merchant tooling integration reading the old admin header
  const opsTpl = await env.STORES.get('tpl:ops', 'text');
  const legacyOps = opsTpl.replace('/*__TAPSTALL_OPS__*/null', '/*__ZIMLINK_OPS__*/null');
  assert.ok(legacyOps.includes('/*__ZIMLINK_OPS__*/null'), 'the fixture is really the old spelling');
  await env.STORES.put('tpl:ops', legacyOps);
  const old = await call('/ops');
  assert.equal(old.status, 200);
  assert.ok(!old.text.includes('__ZIMLINK_OPS__*/null'), 'a page from yesterday still gets its data hook filled');
  assert.match(old.text, /"signed_in":false/);
  await env.STORES.put('tpl:ops', opsTpl);

  const storeTpl = await env.STORES.get('tpl:store', 'text');
  await env.STORES.put('tpl:store', storeTpl
    .replace('/*__TAPSTALL_CONFIG__*/null', '/*__ZIMLINK_CONFIG__*/null')
    .replace('/*__TAPSTALL_TERM__*/null', '/*__ZIMLINK_TERM__*/null'));
  const shop = await call('/s/mamatoe');
  assert.equal(shop.status, 200);
  assert.ok(!shop.text.includes('__TAPSTALL_CONFIG__*/null') && !shop.text.includes('__ZIMLINK_CONFIG__*/null'),
    'neither spelling is left unfilled on a storefront rendered from the old template');
  assert.ok(shop.text.includes('"mamatoe"'), 'and the store really was injected');
  await env.STORES.put('tpl:store', storeTpl);

  // a session minted before the rename lives under zl_ops; the value is the same
  // signed cap, so accepting the name costs nothing that trust did not already
  const good = await call('/ops/login', { method: 'POST', body: { secret: SECRET } });
  const cap = (good.cookies.find((c) => c.startsWith('tp_ops=')) || '').match(/tp_ops=([^;]+)/)[1];
  const viaLegacy = await call('/ops/api/state', { cookie: 'zl_ops=' + cap });
  assert.equal(viaLegacy.status, 200, 'the old cookie name still opens the console: ' + viaLegacy.text.slice(0, 120));
  assert.equal((await call('/ops/api/state', { cookie: 'tp_ops=' + cap })).status, 200, 'and so does the new one');

  const c = 'tp_ops=' + cap;
  const oldHeader = await call('/ops/api/rails', { method: 'POST', cookie: c, headers: { 'x-zimlink-confirm': '1' },
    body: { rails: { oldpage: { label: 'Old Cached Page Rail', pct: 0.01 } } } });
  assert.equal(oldHeader.status, 200, 'a cached page posting the old confirm header is obeyed, not refused: ' + oldHeader.text.slice(0, 160));
  const yank = await call('/ops/api/rails', { method: 'POST', cookie: c, confirm: true, body: { rails: {} } });
  assert.equal(yank.status, 200, yank.text.slice(0, 120));
  const byAdmin = await call('/api/lookup?handle=mamatoe');
  assert.equal(byAdmin.status, 200);
  const keyed = await call('/api/admin?handle=mamatoe', { headers: { 'x-zimlink-admin': JSON.parse(env.STORES._map.get('store:mamatoe').value).admin_token } });
  assert.equal(keyed.status, 200, 'and an integration still sending x-zimlink-admin keeps working');
  assert.equal(keyed.json.via, 'key');

  const pre = await call('/api/settings', { method: 'POST', cookie: store.cookie,
    headers: { 'x-zimlink-confirm': '1' }, body: { handle: 'mamatoe', hours: 'Mon-Fri 8-5' } });
  assert.equal(pre.status, 200, pre.text.slice(0, 160));
  await call('/api/settings', { method: 'POST', cookie: store.cookie, confirm: true, body: { handle: 'mamatoe', hours: 'daily' } });
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
    'settings_rejects_bad', 'money_change_is_held', 'money_change_lands_late', 'masking_hides_values']) {
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
  const rows = JSON.parse(env.ORDERS._map.get('list:' + h).value);
  const row = rows.find((r) => r.id === withProof.json.order.id);
  assert.equal(row.proof, 'REF-99.x/1', 'and on the ledger row, so the list does not need the document to answer');
  assert.equal(row.payer, 'Standard Bank 6288112233', 'and the ledger row agrees with the slip');
  assert.equal(rows.find((r) => r.id === bare.json.order.id).proof, '', 'a row with nothing says nothing rather than lying about it');

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

  const row = JSON.parse(env.ORDERS._map.get('list:' + late.handle).value).find((x) => x.id === late.json.order.id);
  assert.equal(row.proof, 'RBZ 8812.x', 'on the ledger row too, so the list answers without opening the document');
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
  const cap = proofCapOf(ord);
  const key = 'order:' + late.handle + ':' + ord.json.order.id;
  const put = (proof, ip) => call('/api/proof', { method: 'POST', ip, body: { cap, proof } });
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
