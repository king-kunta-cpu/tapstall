/**
 * ZimLink — zero-touch WhatsApp storefront platform.
 * Cloudflare Worker. Free-tier only (Worker + 2 KV namespaces + cron + assets).
 *
 * Bindings
 *   STORES (KV)  store:{handle} term:{handle} renew:{token} tx:{ref} seq:{h} rl:* buyer:* tpl:*
 *   ORDERS (KV)  order:{handle}:{id}  list:{handle}
 *   ADMIN_URL_PREFIX      optional; not required
 *   ADMIN_SECRET (secret) signs buyer-fingerprint hashes
 *   CRON                  every 6 hours → paid-term enforcement + renewal notice
 *
 * Templates live in KV (tpl:store, tpl:onboard, tpl:admin) so the storefront
 * can be hot-updated without redeploying the Worker (no assets binding needed,
 * so the free plan is enough and one curl can fix a template).
 */

import {
  RAILS, round2, clamp, slug, digits, isEmail, validHandle, parseCSV, normalizeFeedUrl,
  parseProducts, priceOrder, payInstructions, riskFlags, waSummary, publicStore, hash,
} from './core.js';

const VERSION = '0.2.0';
const FREE_DAYS = 60;
const PRICE_USD = 60;
const MAX_ORDERS_KEPT = 200;
const RL = { windowSec: 60, max: 8 };


export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    try {
      return (await route(req, new URL(req.url), env, ctx)) || json({ ok: false, error: 'not_found' }, 404);
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e), stage: 'worker' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};

async function route(req, url, env, ctx) {
  const p = url.pathname;

  if (p === '/__ping') return json({ ok: true, version: VERSION, ts: Date.now() });
  if (p === '/__selftest') {
    const t = await selftest(env);
    // ?scheduled=1 also runs the cron body live, so term enforcement is verifiable
    if (url.searchParams.get('scheduled') === '1') {
      try { t.scheduled = await runCron(env); }
      catch (e) { t.scheduled_error = String(e && e.message || e); }
    }
    return json(t);
  }
  if (p === '/rails') return json({ ok: true, rails: RAILS, price_usd: PRICE_USD, free_days: FREE_DAYS });
  if (p === '/fees.ics') return feesIcs();
  if (p === '/fees' || p === '/fees.html') {
    const page = await tpl(env, 'fees');
    return page.startsWith('<!doctype') ? html(page, 200, { 'Cache-Control': 'public, max-age=3600' }) : redirect('/onboard');
  }
  if (p === '/' || p === '/home' || p === '/index.html') {
    const page = await tpl(env, 'index');
    if (page.startsWith('<!doctype')) return html(page, 200, { 'Cache-Control': 'public, max-age=3600' });
    return redirect('/onboard');
  }
  if (p === '/data/sample-menu.csv') {
    const csv = await env.STORES.get('tpl:sample-menu');
    if (csv) return new Response(csv, { headers: { 'content-type': 'text/csv', 'cache-control': 'public, max-age=86400' } });
  }

  if (p === '/onboard') return html(await tpl(env, 'onboard'));

  let m;
  if ((m = p.match(/^\/s\/([a-z0-9][a-z0-9-]{1,30})$/))) return storePage(env, m[1]);
  if ((m = p.match(/^\/s\/([a-z0-9][a-z0-9-]{1,30})\/config\.json$/))) {
    const st = await getStore(env, m[1]);
    return st ? json({ ok: true, store: publicStore(st) }) : json({ ok: false, error: 'no_store' }, 404);
  }
  if ((m = p.match(/^\/s\/([a-z0-9][a-z0-9-]{1,30})\/feed\.json$/))) {
    const st = await getStore(env, m[1]);
    if (!st) return json({ ok: false, error: 'no_store' }, 404);
    return json({ ok: true, products: await loadProducts(st, env, true) });
  }

  if (p === '/api/order' && req.method === 'POST') return placeOrder(req, url, env, ctx);
  if (p === '/api/register' && req.method === 'POST') return register(req, url, env);
  if (p === '/api/lookup') return lookup(url, env);
  if (p === '/api/admin') return adminView(url, env);
  if (p === '/api/mark') return markPaid(req, url, env);   // POST body or one-tap GET link
  if (p === '/a') return html(await tpl(env, 'admin'));
  if ((m = p.match(/^\/renew\/([A-Za-z0-9]{6,40})$/))) return renewPage(env, m[1]);
  if (p === '/api/admin-put' && req.method === 'POST') return adminPut(req, env);

  if (p === '/api/checkout' && req.method === 'POST') return checkout(req, url, env);
  if (p === '/api/hook/flutterwave' && req.method === 'POST') return hookFlutterwave(req, url, env);
  if (p === '/api/hook/payfast' && req.method === 'POST') return hookPayfast(url, env);

  return null;
}

/* ------------------------------------------------------------- store page */
async function storePage(env, handle) {
  const st = await getStore(env, handle);
  if (!st) return html(notFoundPage(handle), 404);
  const term = await env.STORES.get('term:' + handle, 'json');
  let page = await tpl(env, 'store');
  page = page
    .replace('/*__ZIMLINK_CONFIG__*/null', JSON.stringify(publicStore(st)))
    .replace('/*__ZIMLINK_TERM__*/null', JSON.stringify(term || null));
  return html(page, 200, { 'Cache-Control': 'public, max-age=60, s-maxage=300' });
}

const getStore = async (env, handle) => (env.STORES ? await env.STORES.get('store:' + handle, 'json') : null);

async function writeStore(env, st) {
  if (env.STORES) await env.STORES.put('store:' + st.handle, JSON.stringify(st));
}

/* --------------------------------------------------------------- products */
async function loadProducts(st, env, force) {
  const ms = (st.cache_seconds || 120) * 1000;
  if (!force && st.feed_cache && st.feed_cache.at && Date.now() - st.feed_cache.at < ms) return st.feed_cache.products;
  let products = [], error = null;
  try {
    const feed = normalizeFeedUrl(st.feed_url);
    if (!feed) error = 'no_feed';
    else {
      const r = await fetch(feed, { headers: { 'User-Agent': 'zimlink/1' }, cf: { cacheTtl: 60 } });
      if (!r.ok) error = 'feed_http_' + r.status;
      else products = parseProducts(await r.text(), st);
    }
  } catch (e) { error = 'feed_fetch_failed'; }
  st.feed_cache = { at: Date.now(), products, count: products.length, error };
  await writeStore(env, st);
  return products;
}




/* ---------------------------------------------------------------- pricing */

/* ------------------------------------------------------------------ order */
async function placeOrder(req, url, env, ctx) {
  const body = await req.json().catch(() => null);
  if (!body || !body.handle) return json({ ok: false, error: 'missing handle' }, 400);
  const st = await getStore(env, String(body.handle));
  if (!st) return json({ ok: false, error: 'unknown store' }, 404);
  if (st.maintenance || st.suspended) return json({ ok: false, error: st.suspended ? 'store paused — owner needs to renew' : 'store paused' }, 503);
  const ip = (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'na').split(',')[0].trim();
  if (await rateLimited(env, ip)) return json({ ok: false, error: 'too many orders from you, wait a minute' }, 429);

  const buyer = {
    name: String((body.buyer || {}).name || '').trim().slice(0, 60),
    phone: digits((body.buyer || {}).phone || '').slice(0, 20),
    address: String((body.buyer || {}).address || '').trim().slice(0, 200),
    note: String((body.buyer || {}).note || '').trim().slice(0, 400),
    optin: !!(body.buyer || {}).optin,
  };
  if (!buyer.name || !buyer.phone || buyer.phone.replace(/\D/g, '').length < 9) {
    return json({ ok: false, error: 'name and a valid WhatsApp number are required' }, 422);
  }
  if (st.require_optin && !buyer.optin) return json({ ok: false, error: 'consent required to place an order' }, 422);
  const service = body.service === 'delivery' ? 'delivery' : 'pickup';
  if (service === 'delivery' && !buyer.address) return json({ ok: false, error: 'delivery address required' }, 422);
  const items = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
  if (!items.length) return json({ ok: false, error: 'cart empty' }, 422);

  const railKey = st.rail || 'cash';
  const pricing = priceOrder(st, items, service, railKey);
  const cap = Number(st.max_order_value) || 0;
  if (cap && pricing.total > cap) return json({ ok: false, error: `order over this shop's limit of ${cap} ${st.currency || 'USD'}` }, 422);

  const seq = await incr(env, 'seq:' + st.handle);
  const code = (st.order_prefix || st.handle.slice(0, 3).toUpperCase()).replace(/[^A-Za-z0-9-]/g, '') + '-' + String(seq).padStart(4, '0');
  const id = nowId();
  const buyerHash = await hash(st.handle + '|' + buyer.phone + '|' + (env.ADMIN_SECRET || 'dev-secret'));
  const hist = await buyerTouch(env, st.handle, buyerHash);

  const order = {
    id, code, service, at: new Date().toISOString(), handle: st.handle,
    buyer, when: String(body.when || 'asap').slice(0, 40),
    pricing, items,
    buyer_hash: buyerHash.slice(0, 16), prior_orders: hist.count, prior_unpaid: hist.unpaid,
    status: railKey === 'cash' ? 'cod' : 'awaiting_payment',
    risk_flags: [],
  };
  ctx.waitUntil((async () => {
    await persistOrder(env, st, order);
    await notify(env, st, order);
  })());

  const wa = st.whatsapp || '';
  const summary = waSummary(st, order);
  return json({
    ok: true,
    order: { id, code, at: order.at, status: order.status },
    pricing,
    pay: payInstructions(st, order, pricing),
    wa_link: wa ? `https://wa.me/${wa}?text=${encodeURIComponent(summary)}` : null,
    trust: { orders_before: hist.count, unconfirmed_before: hist.unpaid },
    risk_flags: order.risk_flags,
    // one-tap confirm for the merchant: no app, no key, no dashboard login
    mark_url: `/api/mark?handle=${encodeURIComponent(st.handle)}&token=${encodeURIComponent(st.admin_token || '')}&id=${id}`,
    cancel_url: `/api/mark?handle=${encodeURIComponent(st.handle)}&token=${encodeURIComponent(st.admin_token || '')}&id=${id}&status=cancelled`,
  }, 201);
}


async function persistOrder(env, st, order) {
  if (!env.ORDERS) return;
  await env.ORDERS.put(`order:${st.handle}:${order.id}`, JSON.stringify(order));
  const key = 'list:' + st.handle;
  const cur = (await env.ORDERS.get(key, 'json')) || [];
  cur.unshift({
    id: order.id, code: order.code, at: order.at, total: order.pricing.total, name: order.buyer.name,
    phone: order.buyer.phone, service: order.service, status: order.status, flags: order.risk_flags,
    prior_unpaid: order.prior_unpaid,
  });
  await env.ORDERS.put(key, JSON.stringify(cur.slice(0, MAX_ORDERS_KEPT)));
}


const MARK_BASE = '/api/mark?handle=';

async function notify(env, st, order) {
  const tasks = [];
  if (st.notify_webhook) {
    tasks.push(fetch(st.notify_webhook, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-zimlink-token': st.admin_token || '',
        // workers.dev bot rules reject requests without a browser-ish UA, which
        // would silently swallow a merchant's order webhook
        'user-agent': 'zimlink/1 (order notification)',
      },
      body: JSON.stringify({
        type: 'order.new', store: st.handle, order,
        // tap-to-confirm: the merchant's tool is whatever can open a link
        mark_url: `${MARK_BASE}${st.handle}&token=${st.admin_token}&id=${order.id}`,
      }),
    }).catch(() => {}));
  }
  if (env.EMAIL && st.notify_email) {
    try {
      await env.EMAIL.send(new EmailMessage(
        `${st.handle}@notify.zimlink`, st.notify_email,
        `New order ${order.code} — ${order.pricing.pay_now} ${st.currency || 'USD'}`,
        `Buyer: ${order.buyer.name} (${order.buyer.phone})\n${waSummary(st, order)}\nFlags: ${(order.risk_flags || []).join(', ') || 'none'}\n`
        + `One tap when the money lands: ${MARK_BASE}${st.handle}&token=${st.admin_token}&id=${order.id}\n`
        + `Or the dashboard: ${st.admin_url || ''}`
      ));
    } catch (e) { /* email optional */ }
  }
  await Promise.all(tasks);
}

async function markPaid(req, url, env) {
  // Works from the merchant dashboard (POST) and from a one-tap link in the
  // notification (GET /api/mark?handle=..&token=..&id=..) — no app, no API key.
  const b = (req.method === 'POST' ? await req.json().catch(() => null) : null) || {};
  for (const k of ['handle', 'token', 'id', 'status']) if (b[k] == null) b[k] = url.searchParams.get(k);
  const st = await getStore(env, String(b.handle || ''));
  if (!st) return json({ ok: false, error: 'no store' }, 404);
  if (!st.admin_token || String(b.token) !== st.admin_token) return json({ ok: false, error: 'bad token' }, 403);
  if (!b.id) return json({ ok: false, error: 'id required' }, 422);
  const key = `order:${st.handle}:${b.id}`;
  const o = await env.ORDERS.get(key, 'json');
  if (!o) return json({ ok: false, error: 'no such order' }, 404);
  o.status = b.status === 'cancelled' ? 'cancelled' : 'paid';
  o.marked_at = new Date().toISOString();
  if (o.status === 'paid') {
    const hk = `buyer:${st.handle}:${o.buyer_hash}`;
    const rec = (await env.STORES.get(hk, 'json')) || { count: 0, unpaid: 0 };
    rec.unpaid = Math.max(0, (rec.unpaid || 0) - 1);
    await env.STORES.put(hk, JSON.stringify(rec), { expirationTtl: 180 * 86400 });
  }
  await env.ORDERS.put(key, JSON.stringify(o));
  const list = (await env.ORDERS.get('list:' + st.handle, 'json')) || [];
  const row = list.find(x => x.id === o.id);
  if (row) { row.status = o.status; await env.ORDERS.put('list:' + st.handle, JSON.stringify(list)); }
  return json({ ok: true, id: o.id, status: o.status });
}

/* -------------------------------------------------------------- register */
async function register(req, url, env) {
  const b = await req.json().catch(() => null);
  if (!b) return json({ ok: false, error: 'bad json' }, 400);
  const handle = slug(String(b.handle || b.shop_name || '')).slice(0, 30);
  if (!validHandle(handle)) return json({ ok: false, error: 'handle: 2-30 chars, lowercase a-z 0-9 and dashes' }, 422);
  if (!b.shop_name) return json({ ok: false, error: 'shop_name required' }, 422);
  if (!/^https?:\/\//.test(String(b.feed_url || ''))) return json({ ok: false, error: 'feed_url must be a public Google Sheet link' }, 422);
  if (!digits(b.whatsapp || b.phone || '')) return json({ ok: false, error: 'WhatsApp number required (with country code)' }, 422);
  if (await getStore(env, handle)) return json({ ok: false, error: 'handle already taken — try another, or use your renew link' }, 409);

  const token = rand(10);
  const st = {
    handle,
    shop_name: String(b.shop_name).slice(0, 60),
    tagline: String(b.tagline || '').slice(0, 140),
    logo: /^https?:\/\//.test(b.logo || '') ? b.logo : '',
    whatsapp: digits(b.whatsapp || b.phone).replace(/\D/g, '').slice(0, 15),
    location: String(b.location || '').slice(0, 90),
    hours: String(b.hours || '').slice(0, 60),
    feed_url: String(b.feed_url).slice(0, 400),
    currency: String(b.currency || 'USD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3),
    zig_rate: Number(b.zig_rate) || 0,
    tax_pct: clamp(Number(b.tax_pct), 0, 40) || 0,
    rail: RAILS[b.rail] ? b.rail : 'cash',
    surcharge_mode: b.surcharge_mode === 'pass' ? 'pass' : 'absorb',
    delivery_fee: clamp(Number(b.delivery_fee), 0, 10000) || 0,
    free_over: Number(b.free_over) || 0,
    pay_account: String(b.pay_account || '').slice(0, 60),
    reference_format: String(b.reference_format || '{code}').replace(/[^{ }A-Za-z0-9_-]/g, '').slice(0, 30),
    order_prefix: (String(b.order_prefix || handle.slice(0, 3).toUpperCase()).replace(/[^A-Za-z0-9-]/g, '') || 'ORD').slice(0, 6),
    unique_change: b.unique_change !== false,
    require_optin: !!b.require_optin,
    max_order_value: Number(b.max_order_value) || 0,
    cod_review_above: Number(b.cod_review_above) || 80,
    cache_seconds: clamp(Number(b.cache_seconds), 15, 3600) || 120,
    notify_webhook: /^https?:\/\//.test(b.notify_webhook || '') ? String(b.notify_webhook).slice(0, 300) : '',
    notify_email: isEmail(b.notify_email) ? b.notify_email : '',
    owner_email: isEmail(b.owner_email) ? b.owner_email : '',
    created_at: new Date().toISOString(),
    admin_token: token,
    paid_until: Date.now() + FREE_DAYS * 864e5,
    plan: 'free60',
    term_days: FREE_DAYS,
  };
  st.admin_url = `${url.origin}/a?handle=${handle}&token=${token}`;
  st.renew_url = `${url.origin}/renew/${token}`;
  await env.STORES.put('store:' + handle, JSON.stringify(st));
  await env.STORES.put('renew:' + token, JSON.stringify({ handle, made: Date.now() }));
  const products = await loadProducts(st, env, true);
  const err = st.feed_cache && st.feed_cache.error;
  if (st.owner_email) {
    try {
      await sendMail(env, st.owner_email, `Your ${st.shop_name} store is live`,
        `Store: ${url.origin}/s/${handle}\nManage orders: ${st.admin_url}\nEdit your menu any time (it updates itself within ~2 min): ${st.feed_url}\n\n${products.length} products loaded. ${err ? 'FEED WARNING: ' + err : ''}\nFree until ${new Date(st.paid_until).toDateString()}. Renew (no monthly billing): ${st.renew_url}`);
    } catch (e) {}
  }
  return json({
    ok: true, handle,
    store_url: `${url.origin}/s/${handle}`,
    admin_url: st.admin_url, renew_url: st.renew_url,
    products_loaded: products.length, feed_error: err || null,
    free_until: new Date(st.paid_until).toISOString(),
    note: products.length
      ? 'Live. Put the link in your WhatsApp/IG bio and status. Update your Google Sheet to change prices — no one needs to touch this for you.'
      : 'Store is live but 0 products loaded. Share your Sheet as "Anyone with the link — Viewer" and make sure row 1 is: id,name,category,price,currency,image,description,options,addons,stock,popular',
  }, 201);
}

async function lookup(url, env) {
  const handle = slug(url.searchParams.get('handle') || '');
  const st = await getStore(env, handle);
  if (!st) return json({ ok: false, error: 'not found' }, 404);
  return json({
    ok: true,
    store: {
      handle, shop_name: st.shop_name, plan: st.plan, paid_until: st.paid_until,
      suspended: !!st.suspended, rail: st.rail, currency: st.currency,
      products: st.feed_cache ? st.feed_cache.count : 0, feed_error: st.feed_cache ? st.feed_cache.error : null,
      orders_today: ((await env.ORDERS.get('list:' + handle, 'json')) || []).length,
    },
    admin_url: st.admin_url, renew_url: st.renew_url,
  });
}

async function adminView(url, env) {
  const handle = slug(url.searchParams.get('handle') || ''), token = url.searchParams.get('token') || '';
  const st = await getStore(env, handle);
  if (!st) return json({ ok: false, error: 'no store' }, 404);
  if (!timingSafeEq(String(st.admin_token), token)) return json({ ok: false, error: 'bad token' }, 403);
  const rows = (await env.ORDERS.get('list:' + handle, 'json')) || [];
  const orders = [];
  for (const r of rows.slice(0, 40)) orders.push(await env.ORDERS.get(`order:${handle}:${r.id}`, 'json'));
  return json({
    ok: true,
    store: { ...publicStore(st), feed_url: st.feed_url, admin_url: st.admin_url, renew_url: st.renew_url },
    orders: orders.filter(Boolean),
    stats: { total: rows.length, cod: rows.filter(r => r.status === 'cod').length, flags: rows.filter(r => (r.flags || []).length).length },
  });
}

/* ------------------------------------------- payment → auto activation */
async function checkout(req, url, env) {
  const b = await req.json().catch(() => null) || {};
  const rec = await env.STORES.get('renew:' + String(b.token || ''), 'json');
  if (!rec) return json({ ok: false, error: 'unknown renew token' }, 404);
  const days = clamp(Number(b.days) || 365, 30, 1460);
  const amount = round2(PRICE_USD * (days / 365));
  const txRef = `${rec.handle}-${Date.now()}`;
  await env.STORES.put('tx:' + txRef, JSON.stringify({ handle: rec.handle, days, amount }));
  return json({
    ok: true, tx_ref: txRef, amount, days,
    pay_url: `https://flutterwave.com/pay/zimlink?tx_ref=${txRef}&amount=${amount}&currency=USD&customer_email=${encodeURIComponent(b.email || '')}&redirect_url=${encodeURIComponent(url.origin + '/api/hook/flutterwave?done=1&tx_ref=' + txRef)}`,
    manual: `Or send ${amount} USD / local equivalent and paste the payment reference to the operator's WhatsApp — activation is automatic on the webhook, manual only if you pay cash.`,
  });
}

async function hookFlutterwave(req, url, env) {
  if (url.searchParams.get('done')) {
    return html(`<!doctype html><meta charset=utf-8><title>Payment received</title>
      <body style="font:16px system-ui;max-width:30rem;margin:16vh auto;padding:0 1rem">
      <h2>Thanks — activating</h2><p>If your payment cleared, your store renews automatically within a minute. No email needed, no ticket, no waiting on a human.</p>
      <p><a href="/onboard">Back to setup</a></p>`);
  }
  const body = await req.json().catch(() => null) || {};
  const data = body.data || {};
  const txRef = data.tx_ref || body.tx_ref;
  if (!txRef) return json({ ok: false, error: 'no tx_ref' }, 400);
  if (env.FW_SECRET && req.headers.get('verif-hash') !== env.FW_SECRET) return json({ ok: false, error: 'bad verif-hash' }, 401);
  if (data.status && data.status !== 'successful') return json({ ok: true, ignored: data.status });
  const tx = await env.STORES.get('tx:' + txRef, 'json');
  if (!tx) return json({ ok: true, ignored: 'unknown tx_ref' });
  const st = await getStore(env, tx.handle);
  if (!st) return json({ ok: false, error: 'store gone' }, 410);
  st.paid_until = Math.max(Date.now(), st.paid_until || 0) + tx.days * 864e5;
  st.plan = tx.days >= 300 ? 'annual' : 'term';
  st.suspended = false; st.warned_at = null;
  await writeStore(env, st);
  await env.STORES.delete('tx:' + txRef);
  await env.STORES.delete('term:' + st.handle);
  return json({ ok: true, activated: st.handle, paid_until: new Date(st.paid_until).toISOString() });
}

async function hookPayfast(url, env) {
  const m = String(url.searchParams.get('payment_status') || '');
  const [handle, days] = String(url.searchParams.get('custom_str1') || '').split('|');
  if (m !== 'COMPLETE' || !handle) return json({ ok: false, ignored: m || 'no data' });
  const st = await getStore(env, handle);
  if (!st) return json({ ok: false, error: 'store gone' }, 410);
  st.paid_until = Math.max(Date.now(), st.paid_until || 0) + (Number(days) || 365) * 864e5;
  st.plan = 'term'; st.suspended = false;
  await writeStore(env, st);
  await env.STORES.delete('term:' + handle);
  return json({ ok: true, activated: handle });
}

/* ------------------------------------------------------------------ cron */
async function runCron(env) {
  const out = { checked: 0, suspended: 0, reinstated: 0, warned: 0 };
  if (!env.STORES) return out;
  // heartbeat: proves the schedule actually fires, without opening a dashboard
  try { await env.STORES.put('cron:last', JSON.stringify({ at: new Date().toISOString(), unix: Date.now() })); } catch (e) {}
  let cursor, loops = 0;
  do {
    const list = await env.STORES.list({ prefix: 'store:', cursor });
    for (const k of (list.keys || [])) {
      out.checked++;
      const st = await env.STORES.get(k.name, 'json');
      if (!st) continue;
      const leftDays = ((st.paid_until || 0) - Date.now()) / 864e5;
      if (leftDays <= 0 && !st.suspended) {
        st.suspended = true; st.suspended_at = new Date().toISOString();
        await writeStore(env, st);
        await env.STORES.put('term:' + st.handle, JSON.stringify({ state: 'expired', at: st.suspended_at }));
        out.suspended++;
      } else if (leftDays > 0 && st.suspended) {
        st.suspended = false;
        await writeStore(env, st);
        await env.STORES.delete('term:' + st.handle);
        out.reinstated++;
      } else if (leftDays > 0 && leftDays <= 7 && !st.warned_at) {
        st.warned_at = new Date().toISOString();
        await writeStore(env, st);
        if (env.EMAIL && st.owner_email) {
          try {
            await sendMail(env, st.owner_email, `Your store renews in ${Math.ceil(leftDays)} days`,
              `${st.shop_name} runs until ${new Date(st.paid_until).toDateString()}.\nRenew here and it switches over automatically: ${st.renew_url}\n${PRICE_USD} USD / 365 days. No monthly billing, no foreign-card subscription.`);
          } catch (e) {}
        }
        out.warned++;
      }
    }
    cursor = list.cursor;
  } while (cursor && loops++ < 10);
  return out;
}

/* ------------------------------------------------------------ renew page */
async function renewPage(env, token) {
  const rec = await env.STORES.get('renew:' + token, 'json');
  if (!rec) return html(`<h1 style="font:16px system-ui;padding:2rem">That renew link is old. Use the one from your welcome email, or <a href="/onboard">create a store</a>.</h1>`, 404);
  const st = await getStore(env, rec.handle);
  if (!st) return html('<h1 style="font:16px system-ui;padding:2rem">Store not found.</h1>', 404);
  const left = Math.ceil(((st.paid_until || 0) - Date.now()) / 864e5);
  const rows = (await env.ORDERS.get('list:' + st.handle, 'json')) || [];
  const gmv = rows.reduce((a, r) => a + (Number(r.total) || 0), 0);
  return html(`<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Renew ${esc(st.shop_name)}</title>
<style>body{font:16px/1.6 system-ui;max-width:34rem;margin:6vh auto;padding:0 1.1rem;color:#111}
.card{border:1px solid #e5e5e5;border-radius:14px;padding:1rem;margin:1rem 0}
button{font:inherit;background:#111;color:#fff;border:0;border-radius:10px;padding:.7rem 1rem;width:100%}
b{font-variant-numeric:tabular-nums}</style>
<h1>${esc(st.shop_name)}</h1>
<div class=card>
  <p>Plan: <b>${esc(st.plan)}</b> · ${left > 0 ? `<b>${left}</b> days left` : '<b style="color:#b00">expired — store paused</b>'}</p>
  <p>Orders recorded: <b>${rows.length}</b> · value <b>${gmv.toFixed(2)} ${esc(st.currency || 'USD')}</b></p>
  <p>Store URL: <a href="/s/${esc(st.handle)}">/s/${esc(st.handle)}</a> · <a href="${esc(st.admin_url || '/a')}">orders dashboard</a></p>
</div>
<div class=card>
  <h3 style="margin:.2rem 0 .6rem">Renew ${PRICE_USD} USD for 365 days</h3>
  <p style="margin:.2rem 0;font-size:.9rem;color:#555">One payment a year. No monthly billing, no foreign-card subscription (which in Zim adds 15% DSWT + 2% IMTT before it even reaches the provider).</p>
  <button id=pay>Pay and activate automatically</button>
  <p id=out style="font-size:.9rem"></p>
</div>
<script>
document.getElementById('pay').onclick=async()=>{
  const o=document.getElementById('out');o.textContent='opening payment…';
  const r=await fetch('/api/checkout',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:${JSON.stringify(token)},days:365})});
  const j=await r.json();
  if(j.ok){o.innerHTML='If payment clears, this page renews itself. <a href="'+j.pay_url+'">Pay '+j.amount+' USD</a>';}else{o.textContent=j.error||'failed';}
};
</script></html>`);
}

/* guarded template upload — lets deploy stay one command; key is a Worker secret */
async function adminPut(req, env) {
  const b = await req.json().catch(() => null) || {};
  if (!env.ADMIN_SECRET || b.secret !== env.ADMIN_SECRET) return json({ ok: false, error: 'unauthorised' }, 403);
  if (!/^tpl:(store|onboard|admin)$/.test(String(b.key || ''))) return json({ ok: false, error: 'bad key' }, 422);
  if (String(b.value || '').length < 200 || String(b.value || '').length > 400000) return json({ ok: false, error: 'bad size' }, 422);
  await env.STORES.put(b.key, b.value);
  return json({ ok: true, key: b.key, bytes: b.value.length });
}

/* ------------------------------------------------------------ plumbing */
async function rateLimited(env, ip) {
  if (!env.STORES) return false;
  const key = `rl:${ip}:${Math.floor(Date.now() / (RL.windowSec * 1000))}`;
  const n = Number((await env.STORES.get(key)) || 0);
  if (n >= RL.max) return true;
  await env.STORES.put(key, String(n + 1), { expirationTtl: RL.windowSec + 10 });
  return false;
}
async function incr(env, key) {
  if (!env.STORES) return 1;
  const n = Number((await env.STORES.get(key)) || 0) + 1;
  await env.STORES.put(key, String(n));
  return n;
}
async function buyerTouch(env, handle, h) {
  if (!env.STORES) return { count: 0, unpaid: 0 };
  const key = `buyer:${handle}:${h.slice(0, 16)}`;
  const rec = (await env.STORES.get(key, 'json')) || { count: 0, unpaid: 0 };
  rec.count++; rec.unpaid++;
  await env.STORES.put(key, JSON.stringify(rec), { expirationTtl: 180 * 86400 });
  return rec;
}

async function selftest(env) {
  const t = { version: VERSION, kv_stores: !!env.STORES, kv_orders: !!env.ORDERS, email: !!env.EMAIL };
  if (env.STORES) {
    const beat = await env.STORES.get('cron:last', 'json');
    t.cron_heartbeat = beat ? { at: beat.at, minutes_ago: Math.round((Date.now() - (beat.unix || 0)) / 60000) } : 'never run';
  }
  if (env.STORES) {
    const k = '__ping:' + Date.now();
    await env.STORES.put(k, '1');
    t.kv_roundtrip = (await env.STORES.get(k)) === '1';
    await env.STORES.delete(k);
    for (const tplName of ['store', 'onboard', 'admin', 'fees', 'index']) t['tpl_' + tplName] = ((await tpl(env, tplName)) || '').length > 200;
  }
  const fake = { handle: 'selftest', currency: 'USD', tax_pct: 15.5, delivery_fee: 2, rail: 'ecocash_usd', surcharge_mode: 'absorb', unique_change: true, pay_account: '0771234567' };
  t.pricing = priceOrder(fake, [{ name: 'Test', price: 12.5, qty: 2, addons: [4], options: [{ name: 'L', up: 2 }] }], 'delivery', 'ecocash_usd');
  t.pricing_pass_mode = priceOrder({ ...fake, surcharge_mode: 'pass' }, [{ name: 'Test', price: 100, qty: 1 }], 'pickup', 'ecocash_usd');
  t.csv = parseProducts('id,name,category,price,options,addons\np1,Chicken,Main,5.50,Size:S,L|Spice:hot,Cheese:1.5\nHELP,,,,,,,,\n', { currency: 'USD' });
  t.feed_url_sheet = normalizeFeedUrl('https://docs.google.com/spreadsheets/d/abc123DEF456ghi789JKL012mno345PQR/edit#gid=123');
  t.slug = slug('Mama Too Catering!');
  t.secret_leak_check = !JSON.stringify(publicStore({ ...fake, admin_token: 'x', notify_email: 'a@b.c', feed_cache: {} })).includes('admin_token');
  return t;
}

async function tpl(env, name) {
  if (env.STORES) {
    const v = await env.STORES.get('tpl:' + name);
    if (v && v.length > 200) return v;
  }
  return '<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:2rem"><h1>Template &ldquo;'
    + name + '&rdquo; missing</h1><p>Run <code>./scripts/deploy.sh</code> to upload templates into KV.</p>';
}
async function sendMail(env, to, subject, text) {
  if (!env.EMAIL) return false;
  await env.EMAIL.send(new EmailMessage('no-reply@simalidudu.workers.dev', to, subject, text));
  return true;
}

const nowId = () => Date.now().toString(36) + rand(4);
function rand(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return [...b].map(x => x.toString(36).padStart(2, '0')).join('').slice(0, n); }
function timingSafeEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function json(obj, status = 200) {
  return cors(new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } }));
}
function html(s, status = 200, extra = {}) {
  return cors(new Response(s, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...extra } }));
}
function redirect(loc) { return new Response(null, { status: 302, headers: { location: loc } }); }
function cors(r) {
  r.headers.set('Access-Control-Allow-Origin', '*');
  r.headers.set('Access-Control-Allow-Headers', 'content-type');
  r.headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  r.headers.set('X-ZimLink', VERSION);
  return r;
}
function notFoundPage(handle) {
  return `<!doctype html><meta charset=utf-8><title>No store here</title>
<body style="font:16px/1.6 system-ui;max-width:34rem;margin:14vh auto;padding:0 1.2rem">
<h1>No store at /s/${esc(handle)}</h1>
<p>Stores are created by the owner, instantly, with no approval from anyone.</p>
<p><a href="/onboard">Create one free →</a></p></body>`;
}
function feesIcs() {
  const d = new Date().toISOString().replace(/[-:]/g, '').slice(0, 8);
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//zimlink//rates//EN', 'BEGIN:VEVENT',
    `UID:zimlink-rates-${d}@zimlink`, `DTSTAMP:${d}T090000Z`, `DTSTART;VALUE=DATE:${nextJan(d.slice(0, 4))}`,
    'SUMMARY:Re-check mobile money tariffs after the national budget',
    'DESCRIPTION:EcoCash/InnBucks/PayShap/PayFast rates and VAT change with budgets. Update surcharge settings and prices on your ZimLink store.',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  return new Response(body, { headers: { 'content-type': 'text/calendar; charset=utf-8', 'access-control-allow-origin': '*' } });
}
const nextJan = (y) => `${Number(y) + 1}0115`;
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
