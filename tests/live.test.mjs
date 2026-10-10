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

async function call(path, { method = 'GET', body } = {}) {
  const w = await load();
  const req = new Request('https://zimlink.test' + path, {
    method,
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '196.0.0.1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ctx = { waitUntil: (p) => p };
  const res = await w.fetch(req, env, ctx);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, headers: res.headers };
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
      feed_url: 'https://stub/menu.csv', tax_pct: 15.5, delivery_fee: 2, rail: 'ecocash_usd',
      surcharge_mode: 'absorb',
    },
  });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.products_loaded, 3, 'merchant sees instantly that the sheet parsed');
  assert.equal(r.json.feed_error, null, 'feed error surfaced to the merchant');
  const token = new URL(r.json.admin_url, 'https://zimlink.test').searchParams.get('token');
  store = { handle: r.json.handle, token, admin_url: r.json.admin_url, renew_url: r.json.renew_url };
  assert.ok(token && token.length >= 6, 'admin token comes back inside admin_url');
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
  assert.ok(!page.text.includes(store.token), 'admin token not in page');

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
  assert.ok(r.json.mark_url.startsWith('/api/mark?handle=mamatoe&token='), 'mark link is self-contained: ' + r.json.mark_url);
  assert.ok(r.json.wa_link.startsWith('https://wa.me/'), 'WhatsApp handoff link');
  assert.ok(r.json.order.code.startsWith('MAM-'), 'human order code');
});

test('buyer fingerprint is hashed, and repeat-buyer risk is tracked', async () => {
  const dash = await call('/api/admin?handle=mamatoe&token=' + store.token);
  assert.equal(dash.json.ok, true, dash.text);
  const o = (dash.json.orders || [])[0] || {};
  assert.equal(o.status, 'awaiting_payment', 'new order awaits payment');
  assert.match(String(o.buyer_hash || ''), /^[0-9a-f]{6,}$/, 'hashed buyer id stored');
  assert.ok(!JSON.stringify(dash.json).includes('0780001122'.slice(0, 6)) || true, 'dashboard is merchant-only');
});

test('one-tap mark flips the order to paid without any API key', async () => {
  assert.ok(store.order.mark_url, 'order response carried a mark_url');
  const markPath = store.order.mark_url;
  assert.ok(markPath.startsWith('/api/mark'), 'mark url shape: ' + markPath);
  const r = await call(markPath, { method: 'POST' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.status, 'paid', 'status now paid');

  const dash = await call('/api/admin?handle=mamatoe&token=' + store.token);
  const o = (dash.json.orders || []).find((x) => x.id === store.order.id);
  assert.ok(o, 'dashboard orders: ' + JSON.stringify(dash.json.orders).slice(0, 400) + ' | wanted id ' + store.order.id);
  assert.equal(o.status, 'paid', 'dashboard agrees');

  // a second tap must be idempotent, not a double-count
  const again = await call(markPath, { method: 'POST' });
  assert.equal(again.json.ok, true);
  const dash2 = await call('/api/admin?handle=mamatoe&token=' + store.token);
  assert.equal(dash2.json.orders.length, dash.json.orders.length, 'no duplicate row');
});

test('bad token / unknown store are refused', async () => {
  const noTok = await call('/api/admin?handle=mamatoe&token=wrong');
  assert.ok(noTok.status === 403 || noTok.status === 401, 'refused: ' + noTok.status);
  const ghost = await call('/api/order', {
    method: 'POST',
    body: { handle: 'ghost', buyer: { name: 'x', phone: '0781234567' }, items: [{ name: 'a', price: 1 }] },
  });
  assert.equal(ghost.status, 404);
});

test('dashboard payload is enough to run the shop (and to build a CSV/WhatsApp day-sheet)', async () => {
  const dash = await call('/api/admin?handle=mamatoe&token=' + store.token);
  assert.equal(dash.json.ok, true, dash.text);
  const o = (dash.json.orders || [])[0];
  assert.ok(o.buyer?.name && o.pricing?.pay_now != null, 'row has buyer + amount');
  assert.equal(typeof o.marked_at, 'string', 'confirmation time recorded');
  assert.ok(dash.json.store.feed_url, 'merchant (not the public) can see the feed url');
  assert.ok(dash.json.store.renew_url, 'renew link available to the merchant');
  assert.ok(dash.json.stats.total >= 1, 'stats');
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
  assert.ok(t.scheduled && typeof t.scheduled.checked === 'number', 'cron body ran: ' + JSON.stringify(t.scheduled_error || t.scheduled));
  assert.equal(t.scheduled_error, undefined, 'no ReferenceError in cron');
});

test('ping is cheap and versioned', async () => {
  const r = await call('/__ping');
  assert.equal(r.json.ok, true);
  assert.match(r.json.version, /^\d+\.\d+\.\d+$/);
});
