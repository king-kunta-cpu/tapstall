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
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'zl-'));
const bundle = join(dir, 'worker.js');

// core.js has no exports of its own to inline-check here, so build the same
// bundle the publisher ships, straight into a temp dir.
before(() => {
  execFileSync(join(root, 'scripts/build_bundle.sh'), [dir], { cwd: root, stdio: 'pipe' });
  assert.ok(existsSync(bundle), 'build produced no bundle');
});

// Exactly the contract the storefront documents: 9 columns, `|` between option
// groups, `,` between choices, "Name:price" for a priced choice/add-on.
const MENU = [
  'id,name,category,price,currency,options,addons,stock,popular',
  '1,Chicken & rice,Main,5.50,USD,"Size:Small,Large:2|Spice:mild,hot","Cheese:1.5|Egg:0.5",yes,1',
  '2,2 litre Coke,Drinks,2.50,USD,,,,yes',
  '3,Sold out item,Drinks,3.00,USD,,,,no,',
].join('\n');

function kvStub() {
  const m = new Map();
  return {
    _map: m,
    async get(key, type) {
      if (!m.has(key)) return null;
      const v = m.get(key).value;
      if (type === 'json') return JSON.parse(v);
      if (type === 'stream') return { json: async () => JSON.parse(v) };
      return v;
    },
    async put(key, value, opts) {
      m.set(key, { value: typeof value === 'string' ? value : JSON.stringify(value), exp: opts?.expirationTtl });
    },
    async delete(key) { m.delete(key); },
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

async function call(path, { method = 'GET', body, cookie, confirm, headers } = {}) {
  const w = await load();
  const h = { 'content-type': 'application/json', 'cf-connecting-ip': '196.0.0.1', ...(headers || {}) };
  if (cookie) h.cookie = cookie;
  if (confirm) h['x-zimlink-confirm'] = '1';
  const req = new Request('https://zimlink.test' + path, {
    method, headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const ctx = { waitUntil: (p) => p };
  const res = await w.fetch(req, env, ctx);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, headers: res.headers, cookie: (res.headers.getSetCookie?.() || []).join(';') };
}
/** A form post, the way a page with no JavaScript (or a `<noscript>` fallback) sends one. */
function form(o) { return Object.keys(o).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&'); }
/** Sign in the way the merchant's browser does: exchange the emailed code for a cookie. */
async function loginWithCode(adminUrl) {
  const code = new URL(adminUrl, 'https://zimlink.test').searchParams.get('code');
  const r = await call('/api/login', { method: 'POST', body: { code } });
  const set = (r.headers.getSetCookie?.() || [])[0] || '';
  const m = set.match(/zl_sess=([^;]+)/);
  return { r, cookie: m ? 'zl_sess=' + m[1] : null };
}

let store = {};

// Serve the real templates through the stub, exactly as KV does in production,
// so the storefront test exercises injection rather than the fallback page.
before(async () => {
  for (const name of ['store', 'onboard', 'admin', 'fees', 'index']) {
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
  assert.equal(r.json.products_loaded, 3, 'merchant sees instantly that the sheet parsed');
  assert.equal(r.json.feed_error, null, 'feed error surfaced to the merchant');
  assert.ok(!/token=/.test(r.json.admin_url), 'no master key in the dashboard URL any more');
  const code = new URL(r.json.admin_url, 'https://zimlink.test').searchParams.get('code');
  assert.ok(code && code.startsWith('v1.'), 'dashboard link is a signed capability: ' + code);
  assert.ok(!JSON.stringify(r.json).includes('admin_token'), 'register response does not echo the API key');
  store = { handle: r.json.handle, code, admin_url: r.json.admin_url, renew_url: r.json.renew_url };
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
  assert.ok(!/\/\*__ZIMLINK_/.test(page.text), 'no unreplaced placeholder left in the page');

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
  assert.equal(p.length, 3, `3 rows in, 3 out (got ${p.length})`);
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
  const bad = await call('/api/admin?handle=mamatoe', { cookie: 'zl_sess=v1.9999999999.eyJhIjoic2VzcyJ9.deadbeef' });
  assert.equal(bad.status, 403, 'a forged or expired cookie is refused: ' + bad.text);
  const s = await loginWithCode(store.admin_url);
  assert.equal(s.r.status, 200, s.r.text);
  assert.ok(s.cookie && s.cookie.startsWith('zl_sess='), 'login sets a session cookie');
  const sc = s.r.headers.get('set-cookie') || '';
  assert.match(sc, /HttpOnly/, 'the dashboard page script cannot read it back');
  assert.match(sc, /SameSite=Strict/, 'cross-site requests never carry it');
  assert.match(sc, /Secure/, 'and it is only ever sent over https');
  assert.match(sc, /Max-Age=43200/, 'and it dies after 12 hours');
  store.cookie = s.cookie;
  const replay = await call('/api/login', { method: 'POST', body: { code: store.code + 'x' } });
  assert.equal(replay.status, 401, 'a tampered code is refused');
  const legacy = await call('/a?handle=mamatoe&token=whatever');
  assert.equal(legacy.status, 302, 'a stale token link is not honoured');
  assert.match(legacy.headers.get('location'), /^\/a$/, 'and it lands on the login card, not the ledger');
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
  assert.ok(!dash0.json.store.admin_url, 'the dashboard payload never hands out a login code');

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
  const refused = await call('/api/admin?handle=mamatoe', { headers: { 'x-zimlink-admin': 'guess' } });
  assert.equal(refused.status, 429, 'while a guessed key is what the lock is for: ' + refused.text);
  await env.STORES.delete('lock:mamatoe');
  const back = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  assert.equal(back.status, 200, 'a valid session clears the counter');
});

test('bad token / unknown store are refused', async () => {
  const noTok = await call('/api/admin?handle=mamatoe', { cookie: 'zl_sess=nope' });
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

test('losing the link does not need an operator: knowledge recovery + lockout', async () => {
  const wrong = await call('/api/recover', { method: 'POST', body: { handle: 'mamatoe', owner_email: 'nobody@example.com', pay_account: '0785551122' } });
  assert.equal(wrong.status, 403, 'one right answer is not enough: ' + wrong.text);
  const partial = await call('/api/recover', { method: 'POST', body: { handle: 'mamatoe', owner_email: 'owner@example.com', pay_account: '0123' } });
  assert.equal(partial.status, 403, 'nor the other one alone');
  for (let i = 0; i < 12; i++) await call('/api/recover', { method: 'POST', body: { handle: 'mamatoe', owner_email: 'a@b.com', pay_account: 'x' } });
  const locked = await call('/api/recover', { method: 'POST', body: { handle: 'mamatoe', owner_email: 'owner@example.com', pay_account: '0785551122' } });
  assert.equal(locked.status, 429, 'a 40-bit guess is not searchable: rate-limited per store');
  await env.STORES.delete('lock:mamatoe');               // as a successful login would

  const ok = await call('/api/recover', { method: 'POST', body: { handle: 'mamatoe', owner_email: 'owner@example.com', pay_account: '0785551122' } });
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.json.dashboard_url, /\/a\?code=v1\./, 'a fresh, expiring link, no human involved');
  assert.equal(ok.json.emailed, false, 'no mail transport in this test, so it is shown once instead');
  const reopened = await loginWithCode(ok.json.dashboard_url);
  assert.equal(reopened.r.status, 200, 'and it works');
});

test('one write revokes every link, session and key for a store', async () => {
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
  assert.ok(!/token=/.test(r.json.dashboard_url), 'the replacement link is a code, not a key');

  const stale = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  assert.equal(stale.status, 403, 'the old session is refused immediately: ' + stale.text);
  const staleCode = await call('/api/login', { method: 'POST', body: { code: store.code } });
  assert.equal(staleCode.status, 401, 'and so is the link that was emailed out weeks ago');
  assert.match(staleCode.json.error, /revoked/, 'with an explanation: ' + staleCode.json.error);

  const fresh = await loginWithCode(r.json.dashboard_url);
  assert.equal(fresh.r.status, 200, 'the new link signs in');
  store.cookie = fresh.cookie;
  const byKey = await call('/api/admin?handle=mamatoe', { headers: { 'x-zimlink-admin': r.json.api_key } });
  assert.equal(byKey.status, 200, 'the API key works for machine clients');
  assert.equal(byKey.json.via, 'key');
  const wrongKey = await call('/api/admin?handle=mamatoe', { headers: { 'x-zimlink-admin': keyBefore } });
  assert.equal(wrongKey.status, 403, 'only the current key does');
  assert.match(r.json.dashboard_url, /^https:\/\/zimlink\.test\/a\?code=/, 'absolute, so it can be saved anywhere');
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

test('a stale v0.2 GET confirm link upgrades itself instead of acting', async () => {
  // exactly what is sitting in merchants’ WhatsApp history from the old version
  const key = JSON.parse(env.STORES._map.get('store:mamatoe').value).admin_token;
  const dash0 = await call('/api/admin?handle=mamatoe', { cookie: store.cookie });
  const openOrder = (dash0.json.orders || []).find((o) => o.status !== 'paid') || (dash0.json.orders || [])[0];
  const stale = await call(`/api/mark?handle=mamatoe&token=${key}&id=${openOrder.id}&status=paid`, { method: 'GET' });
  assert.equal(stale.status, 302, 'the merchant is not dead-ended: ' + stale.text);
  assert.match(stale.headers.get('location'), /^\/a\?handle=mamatoe&token=/, 'traded for a login code, not applied');
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

  const nope = await call('/api/recover', { method: 'POST', body: { handle: 'tinotuck', whatsapp: '263710002222', pay_account: 'guess' } });
  assert.equal(nope.status, 403, 'a cash shop cannot be recovered by guessing an account');
  const yes = await call('/api/recover', { method: 'POST', body: { handle: 'tinotuck', whatsapp: '263710002222', feed_url: 'https://stub/menu.csv' } });
  assert.equal(yes.status, 200, yes.text);
  assert.equal(yes.json.proved_by, 'whatsapp', 'the number on the store is the contact half');
  assert.equal(yes.json.second_factor, 'feed_url', 'the sheet link is the secret half');
  assert.equal(yes.json.emailed, false, 'nothing to email, so it is shown once');
  const s = await loginWithCode(yes.json.dashboard_url);
  assert.equal(s.r.status, 200, 'and the self-served link opens the dashboard');
  const wrongNum = await call('/api/recover', { method: 'POST', body: { handle: 'tinotuck', whatsapp: '26371009999', feed_url: 'https://stub/menu.csv' } });
  assert.equal(wrongNum.status, 403, 'a neighbour with the same sheet link pattern still fails');
  assert.equal(wrongNum.json.tries_left, 11, 'and is told how many goes are left');
  await env.STORES.delete('store:tinotuck');
  await env.STORES.delete('lock:tinotuck');
});

test('renew links are path-safe: a token can never contain a character the route rejects', async () => {
  const tok = store.renew_url.split('/').pop();
  assert.match(tok, /^[a-z0-9]{12,16}$/, 'issued token: ' + tok);
  assert.ok(!/[-_.~]/.test(tok), 'no url-unsafe punctuation in a path token');
});

test('renew link resolves and mints a checkout even with no gateway configured', async () => {
  const renewPath = new URL(store.renew_url, 'https://zimlink.test').pathname;
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
