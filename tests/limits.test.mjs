/**
 * The day the storage budget is gone.
 *
 * Cloudflare's free KV tier allows 1,000 writes per day across the account, and
 * this project hit that for real (three production checks plus two CI deploys —
 * STATUS.md has the numbers). Reads keep working: 100,000/day. So what does a
 * shop do for the remaining hours of that day? It must not be a 500 page, and it
 * must not be a silent loss. This file drives the real bundled Worker against a
 * KV stub whose writes throw, and asserts the four things that have to stay true:
 *
 *   - a buyer is never told to pay for an order that was not persisted
 *   - a quota answers 503 in words a person can act on, with a retry time
 *   - a merchant's settings save still lands, and is told its log line is missing
 *   - the operator can still sign in, read everything, and pull a lever
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'zl-lim-'));
const bundle = join(dir, 'worker.js');
const LIMIT_MSG = 'KV put() limit exceeded for the day.';
const KEY = 'q'.repeat(20);
const T = 'limittest';

/** A KV namespace that refuses to write, key by key, exactly like a spent quota. */
function kvStub(failWrite) {
  const m = new Map();
  const boom = (key) => { if (failWrite && failWrite(key)) throw new Error(LIMIT_MSG); };
  return {
    _map: m,
    async get(key, type) {
      if (!m.has(key)) return null;
      const v = m.get(key).value;
      return type === 'json' ? JSON.parse(v) : (type === 'stream' ? { json: async () => JSON.parse(v) } : v);
    },
    async put(key, value, opts) { boom(key); m.set(key, { value: typeof value === 'string' ? value : JSON.stringify(value), exp: opts && opts.expirationTtl }); },
    async delete(key) { boom(key); m.delete(key); },
    async list(arg) {
      const prefix = (typeof arg === 'string' ? arg : (arg && arg.prefix)) || '';
      return { keys: [...m.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((k) => ({ name: k })), list_complete: true, cursor: '' };
    },
  };
}

const env = {
  // the lock counter and every order/audit row are unwritable; onboarding-era
  // store documents and the feed cache (also STORES) still are
  STORES: kvStub((k) => k.startsWith('lock:')),
  ORDERS: kvStub(() => true),
  ADMIN_SECRET: 'test-secret',
};

let worker;
async function call(path, { method = 'GET', body, cookie, admin, confirm, headers } = {}) {
  if (!worker) worker = (await import('file://' + bundle)).default;
  const h = { 'content-type': 'application/json', 'cf-connecting-ip': '41.9.1.1', ...(headers || {}) };
  if (cookie) h.cookie = cookie;
  if (admin) h['x-zimlink-admin'] = admin;
  if (confirm) h['x-zimlink-confirm'] = '1';
  const res = await worker.fetch(new Request('https://zimlink.test' + path, {
    method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  }), env, { waitUntil: (p) => p });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: res.status, text, json, headers: res.headers, cookie: (res.headers.getSetCookie?.() || []).join(';') };
}

const storeDoc = () => ({
  handle: T, shop_name: 'Quota Day Kitchen', tagline: 'catering', logo: '', whatsapp: '263771234567',
  location: 'Harare', hours: 'daily', closed: false, feed_url: 'https://stub/menu.csv',
  currency: 'USD', zig_rate: 0, tax_pct: 0, rail: 'ecocash_usd', surcharge_mode: 'absorb',
  delivery_fee: 0, free_over: 0, pay_account: '0771234567', reference_format: '{code}',
  order_prefix: 'QTQ', unique_change: true, require_optin: false, max_order_value: 0,
  cod_review_above: 80, cache_seconds: 120, notify_webhook: '', notify_email: '', owner_email: '',
  created_at: new Date(Date.now() - 864e5).toISOString(), admin_token: KEY, auth_gen: '0',
  paid_until: Date.now() + 30 * 864e5, plan: 'free60', term_days: 60,
  renew_url: '/renew/qtqtoken1234567', admin_url: '/a',
});

before(async () => {
  execFileSync('bash', [join(root, 'scripts/build_bundle.sh'), dir], { cwd: root, stdio: 'pipe' });
  assert.ok(existsSync(bundle), 'bundle built');
  await env.STORES.put('store:' + T, JSON.stringify(storeDoc()));
  for (const name of ['store', 'onboard', 'admin', 'fees', 'index', 'confirm', 'renew', 'ops']) {
    await env.STORES.put('tpl:' + name, readFileSync(join(root, 'pages', name + '.html'), 'utf8'));
  }
  // the menu is a local stub; this file is about writes, not about Google Sheets
  const real = globalThis.fetch;
  globalThis.fetch = (u, init) => (String(u).includes('stub/menu.csv')
    ? Promise.resolve(new Response('id,name,category,price,currency,options,addons,stock,popular\n1,Beef & rice,Main,6.00,USD,,,,yes,\n', { headers: { 'content-type': 'text/csv' } }))
    : real(u, init));
});

test('reads are untouched: the shop stays open for browsing on a quota day', async () => {
  const shop = await call('/s/' + T);
  assert.equal(shop.status, 200);
  assert.match(shop.text, /Quota Day Kitchen/, 'the storefront still renders from KV templates');
  const cfg = await call('/s/' + T + '/config.json');
  assert.equal(cfg.json.ok, true, 'and its config still reads');
  assert.ok(!JSON.stringify(cfg.json).includes(KEY), 'with no key in it');
  assert.equal((await call('/onboard')).status, 200, 'onboarding still opens, so a signup page is not lost too');
});

test('an order that cannot be persisted is never answered as accepted', async () => {
  // the regression this file exists for: the write used to sit in
  // ctx.waitUntil, so the 201 arrived whether or not the order survived, and the
  // buyer was sent off to pay for something the merchant would never see
  const r = await call('/api/order', {
    method: 'POST',
    body: { handle: T, buyer: { name: 'Farai', phone: '0781234567' }, items: [{ name: 'Beef & rice', price: 6, qty: 1 }] },
  });
  assert.notEqual(r.status, 201, 'no success answer without a stored order');
  assert.ok([...env.ORDERS._map.keys()].every((k) => !k.startsWith('order:')), 'nothing half-written was accepted either');
});

test('a quota day answers 503 in prose, with a retry time, still CORS-open', async () => {
  const r = await call('/api/order', {
    method: 'POST',
    body: { handle: T, buyer: { name: 'Farai', phone: '0781234567' }, items: [{ name: 'Beef & rice', price: 6, qty: 1 }] },
  });
  assert.equal(r.status, 503, 'a quota is "not now", not "broken": ' + r.text.slice(0, 200));
  assert.match(r.json.error, /out of storage writes for the day/, r.json.error);
  assert.match(r.json.error, /Nothing is lost/, 'says plainly that nothing was taken');
  assert.ok(!/KV put|at \w+.*\(|undefined/.test(r.json.error), 'the buyer-facing sentence is prose, not internals: ' + r.json.error);
  assert.ok((r.json.detail || '').includes('put()'), 'the raw platform message is kept for the operator');
  const secs = Number(r.json.retry_in_sec);
  assert.ok(secs > 60 && secs <= 86400, 'retry_in_sec is hours to a day, not a guess: ' + secs);
  assert.ok(Number(r.headers.get('retry-after')) >= 60, 'Retry-After is set, so a client can back off honestly');
  assert.equal(r.headers.get('access-control-allow-origin'), '*', 'the buyer page must be able to READ this answer, not just get a CORS failure');
});

test('a settings save still lands while the log write fails, and says so', async () => {
  const soft = await call('/api/settings', { method: 'POST', admin: KEY, body: { handle: T, hours: 'Tue-Sat 9-6' } });
  assert.equal(soft.status, 200, 'the save is not the log: ' + soft.text.slice(0, 200));
  assert.deepEqual(soft.json.applied_now, ['hours']);
  assert.equal(soft.json.logged, false, 'and the page is told the audit line did not land');
  assert.match(soft.json.note, /could not be written to your change log/, soft.json.note);
  assert.equal(JSON.parse(env.STORES._map.get('store:' + T).value).hours, 'Tue-Sat 9-6', 'the change is really applied');
  assert.ok([...env.ORDERS._map.keys()].every((k) => !k.startsWith('audit:')), 'the gap is a gap, not a partial write');

  const money = await call('/api/settings', { method: 'POST', admin: KEY, body: { handle: T, pay_account: '0785551122' } });
  assert.equal(money.status, 200, money.text.slice(0, 200));
  assert.deepEqual(money.json.held, ['pay_account'], 'the 15-minute hold still applies on a bad day');
  assert.equal(money.json.logged, false);
  assert.ok(money.json.hold_until > Date.now(), 'and the fuse is still lit');
});

test('the operator can still sign in, read the estate, and pull a lever', async () => {
  const ok = await call('/ops/login', { method: 'POST', body: { secret: 'test-secret' }, confirm: true });
  assert.equal(ok.status, 200, 'a failed ops-log write must not lock the operator out: ' + ok.text.slice(0, 200));
  assert.match(ok.cookie, /zl_ops=/);
  const c = 'zl_ops=' + (ok.cookie.match(/zl_ops=([^;]+)/) || [])[1];

  const bad = await call('/ops/login', { method: 'POST', body: { secret: 'nope' }, confirm: true });
  assert.equal(bad.status, 403, 'a wrong secret is still a 403, not a 500, when the counter cannot be written');
  assert.equal(bad.json.tries_left, 11, 'and the count still comes from the read, honestly');

  const state = await call('/ops/api/state', { cookie: c });
  assert.equal(state.status, 200, state.text.slice(0, 200));
  assert.equal(state.json.stores[0].handle, T, 'reads are 100k/day, so oversight is unaffected');
  assert.ok(!JSON.stringify(state.json).includes(KEY), 'and it still leaks nothing');

  const lever = await call('/ops/api/store', { method: 'POST', cookie: c, confirm: true, body: { handle: T, action: 'extend7' } });
  assert.equal(lever.status, 200, lever.text.slice(0, 200));
  assert.equal(lever.json.logged, false, 'the lever reports that neither log line landed');
  assert.match(lever.json.note, /will not see a note about it until tomorrow/, lever.json.note);
  assert.ok(JSON.parse(env.STORES._map.get('store:' + T).value).paid_until > Date.now() + 6 * 864e5, 'the seven days were really granted');

  const out = await call('/ops/logout', { method: 'POST', cookie: c });
  assert.equal(out.status, 200, 'and signing out still works while the write budget is gone');
});
