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
  issueCap, verifyCap, randomKey, validateSettings, stageSettings, applyPending, maskField,
  EDITABLE_FIELDS, SOFT_FIELDS, sign, adminStore, normaliseRail, resolveRail,
} from './core.js';

const VERSION = '0.4.2';
const FREE_DAYS = 60;
const PRICE_USD = 60;
const MAX_ORDERS_KEPT = 200;
const RL = { windowSec: 60, max: 8 };

/* ---- authority model (see core.js: "a GET must never move money") ---- */
const HOLD_MS = 15 * 60 * 1000;      // money-moving settings land after this hold
const CODE_TTL = 7 * 24 * 3600;       // dashboard link lifetime
const MARK_TTL = 72 * 3600;           // per-order confirm link lifetime
const UNDO_TTL = 15 * 60;             // tap-back to reverse a confirmation
const SESS_TTL = 12 * 3600;           // signed-in browser session
const LOCK_MAX = 12;                  // bad credentials per handle before a cooldown
const LOCK_TTL = 600;


export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const open = isOpenPath(url.pathname);
    if (req.method === 'OPTIONS') return open ? openCors(new Response(null, { status: 204 })) : new Response(null, { status: 403 });
    try {
      const res = (await route(req, url, env, ctx)) || json({ ok: false, error: 'not_found' }, 404);
      return open ? openCors(res) : res;
    } catch (e) {
      const msg = String((e && e.message) || e);
      const spent = quotaAnswer(msg, url.pathname);
      if (spent) return open ? openCors(spent) : spent;
      return json({ ok: false, error: msg, stage: 'worker' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};

async function route(req, url, env, ctx) {
  const p = url.pathname;
  const NOSTORE = { 'Cache-Control': 'no-store' };

  if (p === '/__ping') return json({ ok: true, version: VERSION, ts: Date.now() });
  if (p === '/__selftest') {
    const t = await selftest(env);
    // ?scheduled=1 also runs the cron body live, so term enforcement is verifiable
    if (url.searchParams.get('scheduled') === '1') {
      try { t.scheduled = await runCron(env); }
      catch (e) { t.scheduled_error = String(e && e.message || e); }
    }
    return json(t, 200, NOSTORE);
  }
  if (p === '/rails') {
    const cat = await railsCatalog(env);
    return json({ ok: true, rails: cat, custom: true, price_usd: PRICE_USD, free_days: FREE_DAYS,
      note: 'Any payment method works here, including one nobody has heard of outside your street. If yours is missing, ask us to add it — or pick "describe my own" and type it in.' },
      200, { 'Cache-Control': 'public, max-age=60' });
  }
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
    return st ? json({ ok: true, store: publicStore(st, await railsCatalog(env)) }) : json({ ok: false, error: 'no_store' }, 404);
  }
  if ((m = p.match(/^\/s\/([a-z0-9][a-z0-9-]{1,30})\/feed\.json$/))) {
    const st = await getStore(env, m[1]);
    if (!st) return json({ ok: false, error: 'no_store' }, 404);
    return json({ ok: true, products: await loadProducts(st, env, true) });
  }

  // ---- merchant authority: a code becomes a cookie, and only POSTs act ----
  const MUT = /^\/api\/(mark|settings|settings\/revert|revoke|login|logout|recover)$/;
  // /api/mark answers its own 405, because it also has to recognise a v0.2
  // ?token= link and trade it for a session rather than dead-end the merchant.
  const selfHandled = p === '/api/mark';
  if (MUT.test(p) && req.method !== 'POST' && !selfHandled) {
    return json({ ok: false, error: 'method_not_allowed', why: 'This endpoint changes state, so it never answers GET.' }, 405, { Allow: 'POST' });
  }
  if (p === '/api/login' && req.method === 'POST') return loginExchange(req, env);
  if (p === '/api/logout' && req.method === 'POST') return withCookie(json({ ok: true, signed_out: true }), KILL_COOKIE);
  if (p === '/api/recover' && req.method === 'POST') return recoverLink(req, url, env);

  if (p === '/api/order' && req.method === 'POST') return placeOrder(req, url, env, ctx);
  if (p === '/api/register' && req.method === 'POST') return register(req, url, env);
  if (p === '/api/lookup') return lookup(url, env);
  if (p === '/api/mark') return markPaid(req, url, env);
  if (p === '/api/admin') return adminView(req, url, env);
  if (p === '/api/settings' && req.method === 'POST') return settingsEdit(req, url, env);
  if (p === '/api/settings/revert' && req.method === 'POST') return revertPending(req, url, env);
  if (p === '/api/revoke' && req.method === 'POST') return revokeKeys(req, url, env);

  // The one-tap confirm link: GET renders an inert page, the browser posts.
  if ((m = p.match(/^\/c\/([A-Za-z0-9._-]{20,400})$/))) return confirmPage(env, m[1]);

  if (p === '/a') return adminEntry(req, url, env);

  /* Platform operator console. Same-origin, cookie-session, and deliberately
   * outside the public path set: no CORS, no caching, no links in it that move
   * money without a POST. */
  if (p === '/ops' || p === '/ops/') return opsPage(req, env);
  if (p === '/ops/login') return req.method === 'POST' ? opsLogin(req, env) : json({ ok: false, error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  if (p === '/ops/logout') {
    if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    await endOpsSessions(env);
    return withCookie(json({ ok: true, note: 'Every console session on this platform is ended now, not just this tab.' }), opsKillCookie());
  }
  if (p === '/ops/api/state') return opsGate(req, env, () => opsState(env));
  if (p === '/ops/api/health') return opsGate(req, env, () => opsHealth(env));
  if (p === '/ops/api/audit') return opsGate(req, env, () => opsAudit(req, url, env));
  if (p === '/ops/api/store') {
    if (req.method === 'POST') return opsGate(req, env, () => opsStoreAction(req, env));
    return opsGate(req, env, () => opsStoreDetail(url, env));
  }
  if (p === '/ops/api/templates') return opsGate(req, env, () => opsTemplates(env));
  if (p === '/ops/api/template') {
    if (req.method === 'POST') return opsGate(req, env, () => opsTemplateWrite(req, env));
    return opsGate(req, env, () => opsTemplateRead(url, env));
  }
  if (p === '/ops/api/rails') {
    if (req.method === 'POST') return opsGate(req, env, () => opsRailsWrite(req, env));
    return opsGate(req, env, () => opsRailsRead(env));
  }
  if (p === '/ops/api/link') return req.method === 'POST' ? opsGate(req, env, () => opsIssueLink(req, env)) : json({ ok: false, error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  if ((m = p.match(/^\/renew\/([A-Za-z0-9_-]{6,40})$/))) return renewPage(env, m[1]);
  if (p === '/api/admin-put' && req.method === 'POST') return adminPut(req, env);

  if (p === '/api/checkout' && req.method === 'POST') return checkout(req, url, env);
  if (p === '/api/renew-ref' && req.method === 'POST') return renewRef(req, env);
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
    .replace('/*__ZIMLINK_CONFIG__*/null', JSON.stringify(publicStore(st, await railsCatalog(env))))
    .replace('/*__ZIMLINK_TERM__*/null', JSON.stringify(term || null));
  return html(page, 200, { 'Cache-Control': 'public, max-age=60, s-maxage=300' });
}

/**
 * Loads a store and lands any held setting whose hold has expired. Applying on
 * the read path means no timer to lose: the change takes effect the first time
 * a buyer or the merchant looks, which is exactly when it matters.
 */
async function getStore(env, handle) {
  if (!env.STORES) return null;
  const st = await env.STORES.get('store:' + handle, 'json');
  if (!st || !st.pending) return st;
  const { applied } = applyPending(st, Date.now());
  if (applied.length) await writeStore(env, st);
  return st;
}

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
  const pricing = priceOrder(st, items, service, railKey, await railsCatalog(env));
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
  /* Freeze the payment details onto the order. The merchant's dashboard, the
   * WhatsApp handoff and the notification all read the slip, not the store — so
   * a payout account changed afterwards can never rewrite what a buyer was
   * already told to pay, and yesterday's customer is never sent to a new number. */
  order.pay = payInstructions(st, order, pricing);

  /* One-tap confirm, without a bearer credential in the URL: each link is a
   * signed, 72-hour capability for THIS order and THIS action. Stored on the
   * order so the merchant can also reach it from the dashboard later. */
  const secret = env.ADMIN_SECRET || 'dev-secret';
  const markCap = await issueCap(secret, { a: 'mark', h: st.handle, id, s: 'paid' }, MARK_TTL);
  const cancelCap = await issueCap(secret, { a: 'mark', h: st.handle, id, s: 'cancelled' }, MARK_TTL);
  order.confirm_url = `${url.origin}/c/${markCap}`;
  order.cancel_url = `${url.origin}/c/${cancelCap}`;

  /* The order document is written BEFORE the buyer is answered. It used to sit
   * in ctx.waitUntil, which meant a failed write — a spent KV write budget, a
   * namespace hiccup — was invisible: the buyer got "send 6.00 to 077…, quote
   * QTQ-0001" for an order that did not exist, and the merchant never saw it.
   * For a service whose whole pitch is proof-of-payment, that is the worst
   * possible failure, so only the notification is allowed to run after the
   * response. A persist failure now bubbles up and answers 503 with a retry
   * time, and nothing was told to anybody. */
  await persistOrder(env, st, order);
  ctx.waitUntil(Promise.resolve().then(() => notify(env, st, order)).catch(() => {}));

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
    // tap once: the page posts it itself, so a link scanner can never pull the trigger
    mark_url: `/c/${markCap}`,
    confirm_url: order.confirm_url,
    cancel_url: `/c/${cancelCap}`,
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
  const body = JSON.stringify({ type: 'order.new', store: st.handle, order });
  if (st.notify_webhook) {
    tasks.push(fetch(st.notify_webhook, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Integrity proof for the merchant's own tooling. Never send a
        // credential in a header here: their webhook target is third-party
        // software that logs what it receives.
        'x-zimlink-body': await sign(env.ADMIN_SECRET || 'dev-secret', body),
        // workers.dev bot rules reject requests without a browser-ish UA, which
        // would silently swallow a merchant's order notification
        'user-agent': 'zimlink/1 (order notification)',
      },
      body,
    }).catch(() => {}));
  }
  if (env.EMAIL && st.notify_email) {
    try {
      await env.EMAIL.send(new EmailMessage(
        `${st.handle}@notify.zimlink`, st.notify_email,
        `New order ${order.code} — ${order.pricing.pay_now} ${st.currency || 'USD'}`,
        `Buyer: ${order.buyer.name} (${order.buyer.phone})\n${waSummary(st, order)}\nFlags: ${(order.risk_flags || []).join(', ') || 'none'}\n`
        + `Open this to confirm (it needs your browser, nothing else): ${order.confirm_url || ''}\n`
        + `Dashboard: ${st.admin_url || ''}`
      ));
    } catch (e) { /* email optional */ }
  }
  await Promise.all(tasks);
}
/** The only states a confirm/undo link may move an order into. */
function markTarget(v) { return (v === 'cancelled' || v === 'awaiting_payment') ? v : 'paid'; }

async function markPaid(req, url, env) {
  // POST only. A GET here would let a mail scanner or a link-preview crawler
  // "confirm" an unpaid order simply by prefetching the link in the email.
  if (req.method !== 'POST') {
    /* Links handed out by the previous version were GETs with the store key in
     * them. Tapping one should not dead-end, so a stale link is traded for a
     * session instead of acted on: the redirect only ever lands on the login
     * page, which changes nothing, so a prefetching crawler still cannot
     * confirm an order. */
    const legacy = url.searchParams.get('token');
    const lh = slug(String(url.searchParams.get('handle') || ''));
    if (legacy && lh) {
      const lst = await getStore(env, lh);
      if (lst && lst.admin_token && timingSafeEq(String(lst.admin_token), String(legacy))) {
        return redirect(`/a?handle=${lh}&token=${encodeURIComponent(legacy)}`);
      }
      if (lst) await authFail(env, lh);   // guessing at an old-style link is a credential failure
    }
    return json({ ok: false, error: 'method_not_allowed', why: 'Confirm links are opened, not fetched. Open the link in a browser and it posts itself, and the page shows you the money first.' }, 405, { Allow: 'POST' });
  }
  const b = await readBody(req);
  const secret = env.ADMIN_SECRET || 'dev-secret';
  const p = b.cap ? await verifyCap(secret, String(b.cap)) : null;
  const viaCap = !!(p && p.a === 'mark');
  // A `cap` that is present but not valid is the interesting case: say so, and
  // say it the same way whether it expired, was edited or came from a copy.
  if (b.cap && !viaCap) {
    return json({ ok: false, error: 'link_expired', why: 'Confirm links last 72 hours and work once per state. Open your dashboard and tap Confirm on the order for a fresh one.' }, 401);
  }

  const handle = viaCap ? p.h : slug(String(b.handle || ''));
  const want = markTarget(viaCap ? p.s : b.status);
  const st = await getStore(env, handle);
  if (!st) return json({ ok: false, error: 'no store' }, 404);

  let id = viaCap ? p.id : String(b.id || '');
  if (!viaCap) {
    // The lockout guards guessable credentials only. A valid capability needs
    // no guessing, so a stranger must not be able to freeze the merchant's
    // one-tap confirm — 12 bad requests would otherwise be a cheap DoS.
    const who = await identify(req, env, handle);
    const lr = lockRes(who); if (lr) return lr;
    if (!who || who.anonymous) return json({ ok: false, error: 'not signed in', need_login: true }, 401);
    if (who.bad) { await authFail(env, handle); return json({ ok: false, error: 'bad key or revoked session' }, 403); }
    if (who.via === 'sess' && (req.headers.get('x-zimlink-confirm') || '') !== '1') {
      return json({ ok: false, error: 'confirm header missing' }, 403);
    }
    if (!id) return json({ ok: false, error: 'id required' }, 422);
  }
  const key = `order:${handle}:${id}`;
  const o = await env.ORDERS.get(key, 'json');
  if (!o) return json({ ok: false, error: 'no such order' }, 404);
  if (o.status === want) {
    // replay (double click, retry) is a no-op, not a second state change
    return json({ ok: true, id: o.id, status: o.status, already: true });
  }
  const prev = o.status;
  o.status = want;
  o.marked_at = new Date().toISOString();
  if (o.status === 'paid') {
    const hk = `buyer:${handle}:${o.buyer_hash}`;
    const rec = (await env.STORES.get(hk, 'json')) || { count: 0, unpaid: 0 };
    rec.unpaid = Math.max(0, (rec.unpaid || 0) - 1);
    await env.STORES.put(hk, JSON.stringify(rec), { expirationTtl: 180 * 86400 });
  }
  await env.ORDERS.put(key, JSON.stringify(o));
  const list = (await env.ORDERS.get('list:' + handle, 'json')) || [];
  const row = list.find(x => x.id === o.id);
  if (row) { row.status = o.status; await env.ORDERS.put('list:' + handle, JSON.stringify(list)); }
  const logged = await pushAudit(env, st, { act: 'mark', via: viaCap ? 'link' : 'session', fields: [o.code + ' → ' + want], ip: ipOf(req) });
  // an undo link for 15 minutes, same shape, opposite action
  // undo returns the order to whatever it was before this tap
  const undo = await issueCap(secret, { a: 'mark', h: handle, id, s: prev }, UNDO_TTL);
  const label = { paid: 'Marked paid', cancelled: 'Cancelled', awaiting_payment: 'Reopened' }[o.status];
  // `logged:false` is a gap in the paper trail, not a failed tap: the order row
  // above is already written, and saying so beats a 500 that leaves the merchant
  // guessing whether to tap again
  return json({ ok: true, id: o.id, code: o.code, status: o.status, label, logged, amount: o.pricing && o.pricing.pay_now, undo_url: '/c/' + undo });
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

  const adminKey = randomKey(16);
  const renewToken = alnumToken(14);   // path-safe: base64url -/_ would break the /renew/ route
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
    rail: await registerRail(b, env),
    rail_def: String(b.rail || '') === 'custom' ? (normaliseRail(b.rail_def, 'custom') || null) || undefined : undefined,
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
    admin_token: adminKey,          // API key for the merchant's own tooling; never in a URL
    auth_gen: '0',                  // bump to invalidate every link, key and cookie
    paid_until: Date.now() + FREE_DAYS * 864e5,
    plan: 'free60',
    term_days: FREE_DAYS,
  };
  st.renew_url = `${url.origin}/renew/${renewToken}`;
  st.admin_url = await issueLogin(env, st, url.origin);
  await env.STORES.put('store:' + handle, JSON.stringify(st));
  await env.STORES.put('renew:' + renewToken, JSON.stringify({ handle, made: Date.now() }));
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

/** A store's rail must exist in the catalogue; `custom` means "the merchant
 *  described it" and is only honoured when the description is valid, because a
 *  half-typed rail would silently price every order at 0% fee. An invalid one
 *  falls back to cash — the buyer is still told to pay on delivery, which is a
 *  wrong-but-safe instruction rather than a wrong amount. */
async function registerRail(b, env) {
  const key = String(b.rail || '');
  if (key === 'custom') return normaliseRail(b.rail_def, 'custom') ? 'custom' : 'cash';
  const cat = await railsCatalog(env);
  return cat[key] ? key : 'cash';
}

async function lookup(url, env) {
  // Public storefront health only. This endpoint used to return admin_url and
  // renew_url, which meant anyone who knew a shop handle could read the master
  // dashboard link (and with it every buyer name and number) from a shell.
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
  });
}
async function adminView(req, url, env) {
  const handle = slug(url.searchParams.get('handle') || '');
  const who = await identify(req, env, handle);
  if (!who || !who.st) return json({ ok: false, error: 'no store' }, 404);
  const lr = lockRes(who); if (lr) return lr;
    if (who.anonymous) return json({ ok: false, error: 'unauthorised', need_login: true }, 401);
  if (who.bad) { await authFail(env, handle); return json({ ok: false, error: 'bad key or revoked session' }, 403); }
  const st = who.st;
  const rows = (await env.ORDERS.get('list:' + handle, 'json')) || [];
  const orders = [];
  for (const r of rows.slice(0, 40)) orders.push(await env.ORDERS.get(`order:${handle}:${r.id}`, 'json'));
  return json({
    ok: true,
    via: who.via,
    // No admin_url here on purpose: a login code inside a JSON body turns any
    // XSS on the dashboard into a saved 7-day credential. The session cookie is
    // HttpOnly, so the page itself cannot read it back.
    store: { ...adminStore(st), feed_url: st.feed_url, renew_url: st.renew_url, dashboard_path: '/a' },
    orders: orders.filter(Boolean),
    // the owner sees the real queued value — cancelling is useless if they
    // cannot check what was typed — while the append-only log keeps it masked
    pending: st.pending ? { keys: Object.keys(st.pending.fields), apply_at: st.pending.apply_at, in_ms: Math.max(0, st.pending.apply_at - Date.now()), fields: st.pending.fields } : null,
    editable: EDITABLE_FIELDS,
    soft_fields: SOFT_FIELDS,
    audit: await getAudit(env, handle),
    stats: { total: rows.length, cod: rows.filter(r => r.status === 'cod').length, flags: rows.filter(r => (r.flags || []).length).length },
  }, 200, { 'Cache-Control': 'no-store' });
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

/**
 * "I paid by EcoCash, here is the reference." No email thread, no support
 * ticket: it is filed against the store, it shows up in the operator console,
 * and the payment itself — not the note — is what extends the plan. Public, so
 * rate-limited and write-cheap on purpose.
 */
async function renewRef(req, env) {
  const ip = ipOf(req);
  if (await rateLimited(env, ip)) return json({ ok: false, error: 'too many attempts — wait a minute' }, 429);
  const b = await readBody(req);
  const rec = await env.STORES.get('renew:' + String(b.token || ''), 'json');
  if (!rec) return json({ ok: false, error: 'that renew link is not on the books any more — the current one is inside your dashboard' }, 404);
  const ref = String(b.reference || '').trim().slice(0, 80);
  if (ref.length < 3) return json({ ok: false, error: 'paste the payment reference (at least 3 characters)' }, 422);
  const key = 'ref:' + rec.handle;
  const cur = (await env.STORES.get(key, 'json')) || [];
  cur.unshift({ at: new Date().toISOString(), ref, amount: clamp(Number(b.amount), 0, 100000) || 0, phone: String(b.phone || '').replace(/\D/g, '').slice(0, 15) });
  await env.STORES.put(key, JSON.stringify(cur.slice(0, 10)), { expirationTtl: 30 * 86400 });
  return json({
    ok: true, filed: cur.length,
    note: 'Filed against ' + rec.handle + '. This note alone switches nothing on — the plan extends when the payment itself is recognised (webhook, or the operator ticking it off), and you will not be chased for it.',
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
  const custom = await env.STORES.get('tpl:renew');
  const rec = await env.STORES.get('renew:' + token, 'json');
  if (custom && custom.length > 200) {
    const st = rec ? await getStore(env, rec.handle) : null;
    const rows = st ? ((await env.ORDERS.get('list:' + st.handle, 'json')) || []) : [];
    const data = {
      known: !!(st), token,
      shop: st ? st.shop_name : null, handle: st ? st.handle : null,
      plan: st ? (st.plan || 'free60') : null, currency: st ? (st.currency || 'USD') : 'USD',
      left: st ? Math.ceil(((st.paid_until || 0) - Date.now()) / 864e5) : 0,
      suspended: st ? !!st.suspended : false,
      orders: rows.length, gmv: Math.round(rows.reduce((a, r) => a + (Number(r.total) || 0), 0) * 100) / 100,
      price: PRICE_USD, store_url: st ? '/s/' + st.handle : '/onboard',
      pay_url: st ? (st.admin_url || '/a') : '/onboard',
    };
    return html(custom.replace('/*__ZIMLINK_RENEW__*/null', JSON.stringify(data)));
  }
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
  if (!/^tpl:(store|onboard|admin|fees|index|sample-menu)$/.test(String(b.key || ''))) return json({ ok: false, error: 'bad key' }, 422);
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
    for (const tplName of ['store', 'onboard', 'admin', 'fees', 'index', 'confirm', 'renew', 'ops']) t['tpl_' + tplName] = ((await tpl(env, tplName)) || '').length > 200;
  }
  const fake = { handle: 'selftest', currency: 'USD', tax_pct: 15.5, delivery_fee: 2, rail: 'ecocash_usd', surcharge_mode: 'absorb', unique_change: true, pay_account: '0771234567' };
  t.pricing = priceOrder(fake, [{ name: 'Test', price: 12.5, qty: 2, addons: [4], options: [{ name: 'L', up: 2 }] }], 'delivery', 'ecocash_usd');
  t.pricing_pass_mode = priceOrder({ ...fake, surcharge_mode: 'pass' }, [{ name: 'Test', price: 100, qty: 1 }], 'pickup', 'ecocash_usd');
  t.csv = parseProducts('id,name,category,price,options,addons\np1,Chicken,Main,5.50,Size:S,L|Spice:hot,Cheese:1.5\nHELP,,,,,,,,\n', { currency: 'USD' });
  t.feed_url_sheet = normalizeFeedUrl('https://docs.google.com/spreadsheets/d/abc123DEF456ghi789JKL012mno345PQR/edit#gid=123');
  t.slug = slug('Mama Too Catering!');
  t.secret_leak_check = !JSON.stringify(publicStore({ ...fake, admin_token: 'x', notify_email: 'a@b.c', owner_email: 'a@b.c', notify_webhook: 'https://x', feed_cache: {}, feed_url: 'https://y' })).includes('admin_token');
  const k = 'selftest-secret';
  const cap = await issueCap(k, { a: 'mark', h: 'shop', id: 'o1', s: 'paid' }, 600);
  const back = await verifyCap(k, cap);
  t.cap_roundtrip = !!(back && back.a === 'mark' && back.h === 'shop' && back.id === 'o1');
  t.cap_rejects_tamper = !(await verifyCap(k, cap.slice(0, -4) + 'AAAA'));
  t.cap_rejects_other_secret = !(await verifyCap('other', cap));
  t.cap_rejects_expired = !(await verifyCap(k, cap, Math.floor(Date.now() / 1000) + 3600));
  const v = validateSettings({ rail: 'nope', tax_pct: 999, hours: '8-5' }, Date.now(), { rails: await railsCatalog(env) });
  const vCat = validateSettings({ rail: 'cash' }, Date.now(), { rails: Object.assign(await railsCatalog(env), { test_momo: normaliseRail({ label: 'Test MoMo', pct: 0.01 }, 'test_momo') }) });
  t.rail_catalogue_ok = vCat.ok && vCat.money.rail === 'test_momo';
  t.rail_custom_ok = (() => { const r = resolveRail({ rail_def: { label: 'My Yape', dial: 'Yape app', pct: 0.012 } }, 'custom'); return r.label === 'My Yape' && r.pct === 0.012; })();
  t.rail_price_with_own = (() => { const p = priceOrder({ currency: 'USD', rail: 'custom', rail_def: { label: 'My Yape', pct: 0.10, fixed: 0, type: 'manual' }, surcharge_mode: 'pass', unique_change: false }, [{ name: 'x', price: 100, qty: 1 }], 'pickup', 'custom'); return p.fee === 10 && p.pay_now === 110; })();
  t.settings_rejects_bad = !v.ok && !!(v.errors.rail && v.errors.tax_pct) && v.soft.hours === '8-5';
  const st2 = { rail: 'cash', pay_account: 'A1', hours: 'x' };
  stageSettings(st2, { hours: '9-6' }, { pay_account: 'EVIL' }, 9e5, 1000);
  t.money_change_is_held = st2.pay_account === 'A1' && st2.hours === '9-6' && st2.pending.apply_at === 901000;
  applyPending(st2, 902000);
  t.money_change_lands_late = st2.pay_account === 'EVIL' && !st2.pending;
  t.masking_hides_values = maskField('pay_account', '0771234567') === '•••4567'
    && maskField('notify_email', 'secret@example.com') === 's***@example.com'
    && maskField('whatsapp', '263771234567') === '•••4567'
    && maskField('feed_url', 'https://docs.google.com/spreadsheets/d/abcdef/edit').indexOf('abcdef') === -1;
  return t;
}

/**
 * The rails a store may price with: the built-in table (published tariffs for
 * the two markets this was proven in) plus whatever the operator has added in
 * KV under `rails:extra`. Adding Ghana or Pakistan is a KV write, not a deploy —
 * which is the only way a $0 service can chase a list of excluded markets that
 * changes every time a telco launches a wallet.
 */
async function railsCatalog(env) {
  const out = Object.assign({}, RAILS);
  let extra = null;
  try { extra = env.STORES ? await env.STORES.get('rails:extra', 'json') : null; } catch (e) { extra = null; }
  for (const k of Object.keys(extra || {})) {
    const r = normaliseRail(extra[k], k);
    if (r) out[k] = r;
  }
  out.custom = { key: 'custom', label: 'My own method (I describe it)', dial: 'as you describe', pct: 0, imtt: 0, fixed: 0, type: 'manual', own: true };
  return out;
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
/** Tokens that must survive a path segment untouched: unambiguous lowercase alnum. */
function alnumToken(n) {
  const A = 'abcdefghijkmnpqrstuvwxyz23456789';   // no l/o/0/1/i — dictated over the phone
  const b = new Uint8Array(n); crypto.getRandomValues(b);
  return [...b].map((x) => A[x % A.length]).join('');
}
function rand(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return [...b].map(x => x.toString(36).padStart(2, '0')).join('').slice(0, n); }
function timingSafeEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const SEC_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // 'unsafe-inline' stays because the templates are single-file documents with
  // inline scripts; everything remote is what this actually blocks.
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; referrer no-referrer",
};

/**
 * Only genuinely public surfaces get `Access-Control-Allow-Origin: *`. The
 * admin, settings, mark and login endpoints deliberately do not, so no foreign
 * page can read a ledger or fire a mutation from a visitor's browser.
 */
const OPEN_RE = /^\/s\/|^\/rails\b|^\/fees\b|^\/data\/|^\/onboard\b|^\/__ping\b|^\/api\/(order|register|lookup|hook\/)|^\/renew\//;
function isOpenPath(pathname) { return OPEN_RE.test(pathname); }
const KILL_COOKIE = 'zl_sess=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure';

/** Merge per-route headers over the defaults, lower-cased, so callers that
 *  write `Cache-Control` cannot end up with `no-store, no-store`. */
function hdr(extra) {
  const h = { 'cache-control': 'no-store', 'x-zimlink': VERSION, ...SEC_HEADERS };
  for (const k of Object.keys(extra || {})) h[k.toLowerCase()] = extra[k];
  return h;
}
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...hdr(extra) },
  });
}
function html(s, status = 200, extra = {}) {
  return new Response(s, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...hdr(extra) },
  });
}
function redirect(loc, status = 302) {
  return new Response(null, { status, headers: { location: loc, 'cache-control': 'no-store' } });
}
function withCookie(res, cookie) { res.headers.append('set-cookie', cookie); return res; }
function openCors(r) {
  r.headers.set('Access-Control-Allow-Origin', '*');
  r.headers.set('Access-Control-Allow-Headers', 'content-type, x-zimlink-confirm');
  r.headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  r.headers.set('X-ZimLink', VERSION);
  return r;
}

/* ---------------------------------------------------------------- authority */
function ipOf(req) {
  return (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'na').split(',')[0].trim();
}
async function readBody(req) {
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  if (ct.indexOf('json') >= 0) return await req.json().catch(() => ({}));
  if (ct.indexOf('form') >= 0) {
    const fd = await req.formData().catch(() => null);
    const out = {};
    if (fd) for (const [k, v] of fd.entries()) out[k] = v;
    return out;
  }
  const t = await req.text().catch(() => '');
  if (t && t[0] === '{') { try { return JSON.parse(t); } catch (e) { return {}; } }
  return {};
}
async function lockedOut(env, handle) {
  if (!env.STORES) return false;
  return Number((await env.STORES.get('lock:' + handle)) || 0) >= LOCK_MAX;
}
async function authFail(env, handle) {
  if (!env.STORES) return 0;
  const n = Number((await env.STORES.get('lock:' + handle)) || 0) + 1;
  // the counter is a courtesy to slow guessing, not a dependency: on a day the
  // write budget is gone, refuse with 403 as usual instead of 500-ing
  try { await env.STORES.put('lock:' + handle, String(n), { expirationTtl: LOCK_TTL }); } catch (e) {}
  return n;
}
async function authClear(env, handle) {
  if (!env.STORES) return;
  // Only touch KV when a counter actually exists: an unconditional delete on
  // every authenticated request would burn the 1,000 free writes/day on a
  // dashboard that polls. Reads are 100k/day, so checking first is free.
  const n = await env.STORES.get('lock:' + handle);
  if (n && Number(n) > 0) { try { await env.STORES.delete('lock:' + handle); } catch (e) {} }
}

/** Who is asking? Cookie session, or the store's API key. Never a URL token. */
async function identify(req, env, handle) {
  handle = slug(String(handle || ''));
  const st = await getStore(env, handle);
  if (!st) return null;
  const raw = (req.headers.get('cookie') || '').match(/(?:^|;\s*)zl_sess=([^;]+)/);
  if (raw) {
    const p = await verifyCap(env.ADMIN_SECRET || 'dev-secret', decodeURIComponent(raw[1]));
    if (p && p.a === 'sess' && p.h === handle && String(p.g) === String(st.auth_gen || '0')) {
      await authClear(env, handle);
      return { via: 'sess', st, handle };
    }
    return { bad: true, st, handle };
  }
  const key = req.headers.get('x-zimlink-admin');
  if (key) {
    // Right key first, always. The lock exists to slow guessing at a key; an
    // attacker who fills it must not thereby gain the ability to lock the real
    // owner out — measured on production, where gating before the comparison
    // answered 429 to a correct key.
    if (st.admin_token && timingSafeEq(String(key), String(st.admin_token))) {
      await authClear(env, handle);
      return { via: 'key', st, handle };
    }
    if (await lockedOut(env, handle)) return { locked: true, st, handle };
    return { bad: true, st, handle };
  }
  return { anonymous: true, st, handle };
}

/** 429 for a store whose key is being guessed; null everywhere else. */
function lockRes(who) {
  return who && who.locked
    ? json({ ok: false, error: 'too many failed attempts with that key — wait 10 minutes, or open the dashboard link' }, 429)
    : null;
}

async function issueLogin(env, st, origin) {
  const cap = await issueCap(env.ADMIN_SECRET || 'dev-secret',
    { a: 'login', h: st.handle, g: String(st.auth_gen || '0') }, CODE_TTL);
  return `${origin}/a?code=${cap}`;
}

async function loginExchange(req, env) {
  const b = await readBody(req);
  const p = await verifyCap(env.ADMIN_SECRET || 'dev-secret', String(b.code || ''));
  if (!p || p.a !== 'login') return json({ ok: false, error: 'that sign-in link has expired — open a fresh one from your notification, or use "Lost your link?"' }, 401);
  const st = await getStore(env, p.h);
  if (!st) return json({ ok: false, error: 'no store' }, 404);
  if (String(p.g) !== String(st.auth_gen || '0')) return json({ ok: false, error: 'this link was revoked' }, 401);
  const sess = await issueCap(env.ADMIN_SECRET || 'dev-secret',
    { a: 'sess', h: st.handle, g: String(st.auth_gen || '0') }, SESS_TTL);
  await authClear(env, st.handle);
  return withCookie(json({ ok: true, handle: st.handle, valid_for_sec: SESS_TTL }),
    `zl_sess=${encodeURIComponent(sess)}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${SESS_TTL}`);
}

/** Legacy `?handle=..&token=..` links still work, but trade down to a code. */
async function adminEntry(req, url, env) {
  const legacy = url.searchParams.get('token');
  if (legacy && !url.searchParams.get('code')) {
    const handle = slug(url.searchParams.get('handle') || '');
    const st = await getStore(env, handle);
    if (st && st.admin_token && timingSafeEq(String(st.admin_token), String(legacy))) {
      await authClear(env, handle);
      return redirect(await issueLogin(env, st, url.origin));
    }
    if (st && await lockedOut(env, handle)) return json({ ok: false, error: 'too many failed attempts — wait 10 minutes' }, 429);
    if (st) await authFail(env, handle);
    return redirect('/a');
  }
  return html(await tpl(env, 'admin'));
}

/* ------------------------------------------------------- self-service settings */
async function settingsEdit(req, url, env) {
  const b = await readBody(req);
  const who = await identify(req, env, b.handle || url.searchParams.get('handle'));
  if (!who || !who.st) return json({ ok: false, error: 'no store' }, 404);
  const lr = lockRes(who); if (lr) return lr;
    if (who.anonymous) return json({ ok: false, error: 'sign in from your dashboard link first', need_login: true }, 401);
  if (who.bad) { await authFail(env, who.handle); return json({ ok: false, error: 'bad key or revoked session' }, 403); }
  // A cookie is ambient authority, so require a header a cross-site form
  // cannot set. SameSite=Strict already blocks most of that; this is the belt.
  if (who.via === 'sess' && (req.headers.get('x-zimlink-confirm') || '') !== '1') {
    return json({ ok: false, error: 'missing x-zimlink-confirm header' }, 403);
  }
  const st = who.st;
  const patch = (b.settings && typeof b.settings === 'object') ? b.settings : b;
  // validated against the live catalogue, so a rail the operator added this
  // morning is accepted here in the same breath as the built-ins, and a
  // misspelled one comes back as a field error instead of a mystery
  const cat = await railsCatalog(env);
  const v = validateSettings(patch, Date.now(), { rails: cat });
  if (!v.ok) return json({ ok: false, error: 'some fields need a different format', fields: v.errors, ignored: v.ignored,
    hint: v.errors.rail ? 'Pick one of: ' + Object.keys(cat).join(', ') + '. "custom" means you describe it below.' : undefined }, 422);
  if (v.money.rail === 'custom') {
    const def = v.money.rail_def !== undefined ? v.money.rail_def : st.rail_def;
    if (!(def && def.label)) {
      return json({ ok: false, error: 'a custom rail needs a name, what the buyer dials, and its fee',
        fields: { rail_def: 'label, dial, pct (0-30), fixed, type' } }, 422);
    }
  }
  const keys = Object.keys(v.soft).concat(Object.keys(v.money));
  if (!keys.length) {
    return json({ ok: false, error: 'nothing to change', unknown: v.ignored, fields: v.errors,
      note: 'Send only the fields you want changed, with their current names.' }, v.ignored.length ? 422 : 200);
  }
  const before = {};
  for (const k of keys) before[k] = maskField(k, st[k]);
  const { changed, staged } = stageSettings(st, v.soft, v.money, HOLD_MS, Date.now());
  const after = {};
  for (const k of keys) {
    const held = st.pending && st.pending.fields && k in st.pending.fields;
    after[k] = maskField(k, held ? st.pending.fields[k] : st[k]);
  }
  if (changed || staged) await writeStore(env, st);
  const logged = (changed || staged) ? await pushAudit(env, st, { act: 'settings', via: who.via, changed, staged, before, after, ip: ipOf(req) }) : true;
  const held = Object.keys(v.money);
  return json({
    ok: true, applied_now: changed ? Object.keys(v.soft) : [],
    logged,                                    // false = a gap in the change log,
    held, hold_until: st.pending ? st.pending.apply_at : null,
    unchanged: !changed && !staged,
    // one note, in order of what the merchant most needs to know: a missing
    // log line first (a duplicate `note:` key used to silently overwrite it
    // with 'Saved.'), then the hold, then the ordinary thank-you
    note: !logged ? LOG_GAP
      : held.length
        ? 'Payment, menu and contact changes take effect after 15 minutes and you can cancel them in that window. Anyone already ordering pays the account printed on their slip, so a stolen link cannot quietly reroute today’s takings.'
        : 'Saved.',
  });
}

async function revertPending(req, url, env) {
  const b = await readBody(req);
  const who = await identify(req, env, b.handle || url.searchParams.get('handle'));
  if (!who || !who.st) return json({ ok: false, error: 'no store' }, 404);
  const lr = lockRes(who); if (lr) return lr;
    if (who.anonymous || who.bad) return json({ ok: false, error: 'sign in first' }, 401);
  const was = who.st.pending ? Object.keys(who.st.pending.fields) : [];
  if (was.length) { delete who.st.pending; await writeStore(env, who.st); }
  await pushAudit(env, who.st, { act: 'revert', via: who.via, fields: was, ip: ipOf(req) });
  return json({ ok: true, cancelled: was });
}

/** One write that kills every outstanding link, key and cookie for a store. */
async function revokeKeys(req, url, env) {
  const b = await readBody(req);
  const who = await identify(req, env, b.handle || url.searchParams.get('handle'));
  if (!who || !who.st) return json({ ok: false, error: 'no store' }, 404);
  const lr = lockRes(who); if (lr) return lr;
    if (who.anonymous || who.bad) return json({ ok: false, error: 'sign in first' }, 401);
  const st = who.st;
  st.auth_gen = Date.now().toString(36);
  st.admin_token = randomKey(16);
  delete st.pending;
  await writeStore(env, st);
  await pushAudit(env, st, { act: 'revoke', via: who.via, ip: ipOf(req) });
  const res = json({
    ok: true, dashboard_url: await issueLogin(env, st, url.origin), api_key: st.admin_token,
    note: 'Every older link, session and API key for this store is dead. Save the new ones; the old key stops working immediately.',
  });
  return withCookie(res, KILL_COOKIE);
}

/**
 * "Lost your link" without an operator. Proof of ownership = the two values
 * that are on no public page: the owner email and the payment account. With a
 * mail binding it also arrives by email; without one it is shown once here.
 */
async function recoverLink(req, url, env) {
  const b = await readBody(req);
  const handle = slug(String(b.handle || ''));
  const st = await getStore(env, handle);
  if (!st) return json({ ok: false, error: 'no store with that name' }, 404);
  if (await lockedOut(env, handle)) return json({ ok: false, error: 'too many attempts — wait 10 minutes' }, 429);
  /* Two things only the owner holds. The first is whichever contact exists on
   * the store (email, else the WhatsApp buyers use); the second is the payout
   * account — or, for a cash shop that has none, the menu sheet link. Neither
   * appears in any public response any more, so the pair is a real secret and
   * the reset needs no operator. */
  const email = String(b.owner_email || '').toLowerCase().trim();
  const wa = digits(String(b.whatsapp || '')).replace(/\D/g, '');
  const okEmail = !!st.owner_email && isEmail(email) && timingSafeEq(String(st.owner_email).toLowerCase(), email);
  const okWa = !!st.whatsapp && !!wa && timingSafeEq(String(st.whatsapp).replace(/\D/g, ''), wa);
  const secretField = st.pay_account ? 'pay_account' : 'feed_url';
  const proof = String(b[secretField] || b.pay_account || b.feed_url || '').trim();
  const okProof = !!st[secretField] && !!proof && timingSafeEq(String(st[secretField]), proof);
  if (!(okEmail || okWa) || !okProof) {
    const n = await authFail(env, handle);
    return json({ ok: false, error: 'those details do not match this store', tries_left: Math.max(0, LOCK_MAX - n) }, 403);
  }
  await authClear(env, handle);
  const link = await issueLogin(env, st, url.origin);
  let sent = false;
  if (env.EMAIL && (st.owner_email || st.notify_email)) {
    try {
      await sendMail(env, st.owner_email || st.notify_email, 'Your ZimLink dashboard link',
        `A fresh dashboard link (valid 7 days):\n${link}\n\nIf you did not ask for this, open it and press "Revoke links & API key" at once.`);
      sent = true;
    } catch (e) { /* shown here instead */ }
  }
  return json({
    ok: true, dashboard_url: link, emailed: sent,
    proved_by: okEmail ? 'owner_email' : 'whatsapp', second_factor: secretField,
    note: sent ? 'Emailed, and shown once here.' : 'Copy it now — it is not shown again. A lost link never needs anyone’s help: the same two details always remake it.',
  });
}

/* ------------------------------------------------------------------ audit */
async function pushAudit(env, st, row) {
  if (!env.ORDERS || !st) return false;
  const k = 'audit:' + st.handle;
  let cur = [];
  try { cur = (await env.ORDERS.get(k, 'json')) || []; } catch (e) { cur = []; }
  try {
    cur.unshift({
    at: new Date().toISOString(), act: row.act, via: row.via || '', ip: row.ip || '',
    changed: row.changed || 0, staged: row.staged || 0,
      fields: row.fields || Object.keys(row.before || {}),
      before: row.before || undefined, after: row.after || undefined,
    });
    await env.ORDERS.put(k, JSON.stringify(cur.slice(0, 40)));
    return true;
  } catch (e) { return false; }   // the change stands; the log has a gap, and
}                                 // the response says so rather than failing
async function getAudit(env, handle) {
  if (!env.ORDERS) return [];
  return (await env.ORDERS.get('audit:' + handle, 'json')) || [];
}

/* -------------------------------------------------- inert, self-posting page */
function js(v) { return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '').replace(/\u2029/g, ''); }
function shell(title, body) {
  return '<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">'
    + '<title>' + esc(title) + '</title><style>body{font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;background:#0b0f14;color:#101418;margin:0;padding:1.2rem}'
    + '.c{background:#fff;border-radius:16px;padding:1.1rem;max-width:26rem;margin:6vh auto}'
    + 'b{font-variant-numeric:tabular-nums}button{font:inherit;background:#0b0f14;color:#fff;border:0;border-radius:10px;padding:.7rem .9rem;width:100%;font-weight:600}'
    + '.t{color:#65788b;font-size:.85rem}</style><div class=c>' + body + '</div></body></html>';
}

/**
 * The page a confirm link opens. It changes nothing by itself: it shows the
 * money context, then the browser POSTs. A crawler that fetches and never runs
 * the script leaves the order exactly as it was.
 */
async function confirmPage(env, cap) {
  const p = await verifyCap(env.ADMIN_SECRET || 'dev-secret', cap);
  const custom = env.STORES ? await env.STORES.get('tpl:confirm') : null;
  if (custom && custom.length > 200) {
    // same state machine, markup from KV so the page can be re-skinned without
    // a redeploy; the inline builder below is the floor if the template is gone
    let state = 'expired';
    let data = { cap, state };
    if (p && p.a === 'mark') {
      const st = await getStore(env, p.h);
      const o = st ? await env.ORDERS.get('order:' + p.h + ':' + p.id, 'json') : null;
      if (!st || !o) state = data.state = 'missing';
      else {
        const want = markTarget(p.s);
        data = {
          cap, state: o.status === want ? 'already' : 'confirm', want,
          shop: st.shop_name, handle: st.handle, code: o.code, amount: (o.pricing && (o.pricing.pay_now || o.pricing.total)) || 0,
          currency: st.currency || 'USD', buyer: (o.buyer && o.buyer.name) || 'buyer',
          rail: (o.pricing && o.pricing.rail && o.pricing.rail.label) || '', marked_at: o.marked_at || null,
          store_url: '/s/' + st.handle,
        };
      }
    }
    return html(custom.replace('/*__ZIMLINK_CONFIRM__*/null', JSON.stringify(data)));
  }
  if (!p || p.a !== 'mark') {
    return html(shell('Link expired', '<h2>This link has expired</h2><p class=t>Confirm links last 72 hours. Open your dashboard and use the Confirm button on the order — it does exactly the same thing.</p>'));
  }
  const st = await getStore(env, p.h);
  const o = st ? await env.ORDERS.get('order:' + p.h + ':' + p.id, 'json') : null;
  if (!o) return html(shell('Order not found', '<h2>Order not found</h2><p class=t>It may have been archived.</p>'), 404);
  const want = markTarget(p.s);
  if (o.status === want) {
    return html(shell('Already confirmed', '<h2>Already ' + esc(want) + '</h2><p class=t>' + esc(o.code) + ' was confirmed on ' + esc(String(o.marked_at || '').slice(0, 16).replace('T', ' ')) + ' UTC. Nothing changed.</p>'));
  }
  const amt = (o.pricing && (o.pricing.pay_now || o.pricing.total)) || 0;
  const body = '<h2 style="margin:.1rem 0 .4rem">' + esc({ paid: 'Mark ' + o.code + ' paid?', cancelled: 'Cancel ' + o.code + '?', awaiting_payment: 'Reopen ' + o.code + ' as unpaid?' }[want]) + '</h2>'
    + '<p><b>' + esc(String(amt)) + ' ' + esc(st.currency || 'USD') + '</b> from ' + esc((o.buyer && o.buyer.name) || 'buyer')
    + '<br><span class=t>ref ' + esc(o.code) + ' · ' + esc((o.pricing && o.pricing.rail && o.pricing.rail.label) || '') + '</span></p>'
    + '<p id=s class=t>Confirming…</p>'
    + '<form method="post" action="/api/mark" style="margin:.6rem 0 0"><input type="hidden" name="cap" value="' + esc(cap) + '">'
    + '<button type="submit">Tap if this is not automatic</button></form>'
    + '<script>var f=new FormData();f.set("cap",' + js(cap) + ');'
    + 'fetch("/api/mark",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cap:' + js(cap) + '})})'
    + '.then(function(r){return r.json()}).then(function(j){document.getElementById("s").innerHTML=j.ok'
    + '?("<b style=color:#0b5b34>✓ " + (j.label||"Done") + "</b>"):"<span style=color:#b00020>"+(j.error||"failed")+"</span>"})'
    + '.catch(function(){document.getElementById("s").textContent="Could not reach the server — use the button.";});</script>';
  return html(shell('Confirm order', body));
}function notFoundPage(handle) {
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

/* ============================================================ operator suite
 *
 * A control panel for whoever runs the platform: how every tenant is doing,
 * whether the feed/cron/deploy are healthy, and a handful of levers for when a
 * merchant is stuck. It exists so that NOTHING in the normal customer journey
 * ever needs a human: those pages are for exceptions and for reading, not for
 * onboarding anyone.
 *
 * Auth: paste the platform secret once -> a 12-hour HttpOnly cookie. The secret
 * never goes in a URL, never goes in the page, and is never sent to the browser.
 * Guessing is throttled per-platform, and a correct secret always works — the
 * lock exists to stop a stranger, not to lock the owner out of their own shop.
 */
function secsToMidnightUTC() {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60, Math.round((midnight - now.getTime()) / 1000));
}

const OPS_COOKIE = 'zl_ops';
const OPS_TPL_NAMES = ['store', 'onboard', 'admin', 'fees', 'index', 'confirm', 'renew', 'ops', 'sample-menu'];
const PAGES_URL = 'https://king-kunta-cpu.github.io/zimlink/';

function opsKillCookie() { return OPS_COOKIE + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure'; }

/** The console session is a stateless signed cap — nothing to look up, which
 *  is why it costs no KV write to sign in from a hotel laptop. It also means
 *  a cookie would outlive "sign out" unless a generation number is carried in
 *  it, so one tiny KV read is the price of a logout that actually logs out.
 *  Bumping it ends every console session on the platform at once. */
async function endOpsSessions(env) {
  try { if (env.STORES) await env.STORES.put('ops_gen', Date.now().toString(36)); } catch (e) {}
}
async function opsGen(env) {
  if (!env.STORES) return '0';
  try { return (await env.STORES.get('ops_gen')) || '0'; } catch (e) { return '0'; }
}

async function opsIssue(env) {
  return issueCap(env.ADMIN_SECRET || 'dev-secret', { a: 'ops', g: VERSION, n: await opsGen(env) }, SESS_TTL);
}

async function opsAuthed(req, env) {
  const raw = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + OPS_COOKIE + '=([^;]+)'));
  if (!raw) return { anon: true };
  const p = await verifyCap(env.ADMIN_SECRET || 'dev-secret', decodeURIComponent(raw[1]));
  if (p && p.a === 'ops' && String(p.n) === String(await opsGen(env))) return { ok: true };
  return { bad: true };
}

/* The free Workers plan answers a spent KV write budget with
   `KV put() limit exceeded for the day.` — hit for real on 2026-10-10 after a
   few prod checks and two deploys. Two rules follow from it. (1) Never let it
   surface as a 500 with internals in it: say what it is and when it clears.
   (2) Say it in the reader's own terms, because the same exception reaches a
   buyer placing an order, a merchant saving a setting and an operator pulling a
   lever, and the message that comforts one alarms or confuses the others.
   Anything that catches and reshapes an error (opsGate below) has to consult
   this too, or the whole point is lost one layer down. */
const QUOTA_RE = /put\(\) limit|write.*limit|CPU time exceeded|Memory limit/i;
function quotaAnswer(msg, pathname) {
  if (!QUOTA_RE.test(msg)) return null;
  const secs = secsToMidnightUTC();
  const buyerish = pathname === '/api/order' || pathname === '/api/lookup';
  const merchantish = pathname.indexOf('/api/') === 0 || /^\/(a|c\/|renew\/)/.test(pathname);
  const who = buyerish ? 'buyer' : merchantish ? 'merchant' : 'operator';
  const line = who === 'buyer'
    ? 'This store is out of storage writes for the day. Nothing is lost and no order was taken — try again in a few hours, or message the shop directly.'
    : who === 'merchant'
      ? 'Nothing was saved, and nothing was half-saved: your settings are exactly as they were. The account\u2019s storage writes are spent for today — try again in a few hours.'
      : 'Nothing was written. The account has spent its free storage writes for today (1,000/day on the free Workers plan), so this lever will work again in a few hours. Upgrade to the $5 plan and the ceiling goes away.';
  return json({ ok: false, retry_in_sec: secs, detail: msg, who, error: line },
    503, { 'Retry-After': String(secs), 'Cache-Control': 'no-store' });
}

async function opsGate(req, env, fn) {
  const who = await opsAuthed(req, env);
  if (who.ok) {
    try { return await fn(); }
    catch (e) {
      const msg = String((e && e.message) || e);
      // a lever that cannot write is not a broken console, and this catch would
      // otherwise turn the one explainable failure into a bare 500
      const spent = quotaAnswer(msg, new URL(req.url).pathname);
      if (spent) return spent;
      return json({ ok: false, error: msg, stage: 'ops' }, 500);
    }
  }
  // A stale or forged *cookie* is refused but does not feed the lock counter:
  // the counter exists to slow somebody guessing the secret at /ops/login, and
  // a cookie is unguessable by construction (HMAC over the payload). Counting
  // cookies instead let a refresh on an expired session walk the operator's own
  // door toward a 10-minute freeze — the same self-inflicted DoS the per-store
  // lockout had, found by the prod check hammering this endpoint.
  if (who.anon) return json({ ok: false, error: 'sign in with the platform secret', need_login: true }, 401);
  return json({ ok: false, error: 'session expired — paste the platform secret again', need_login: false }, 401);
}

async function opsLogin(req, env) {
  if (!env.ADMIN_SECRET) return json({ ok: false, error: 'ADMIN_SECRET is not bound on this Worker, so the console stays shut' }, 503);
  const b = await readBody(req);
  if (await lockedOut(env, '__ops')) return json({ ok: false, error: 'too many attempts — wait 10 minutes' }, 429);
  const given = String(b.secret || b.token || '').trim();
  if (given && timingSafeEq(given, String(env.ADMIN_SECRET))) {
    await authClear(env, '__ops');
    const cap = await opsIssue(env);
    await pushOpsLog(env, { act: 'login', ip: ipOf(req) });
    return withCookie(json({ ok: true, valid_for_sec: SESS_TTL, note: 'This console is oversight only — no customer flow waits on it.' }),
      `${OPS_COOKIE}=${encodeURIComponent(cap)}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${SESS_TTL}`);
  }
  const n = await authFail(env, '__ops');
  return json({ ok: false, error: 'not the platform secret', tries_left: Math.max(0, LOCK_MAX - n) }, 403);
}

async function opsPage(req, env) {
  const who = await opsAuthed(req, env);
  const page = await tpl(env, 'ops');
  const signed = who.ok ? 'true' : 'false';
  return html(page.replace('/*__ZIMLINK_OPS__*/null', JSON.stringify({ signed_in: who.ok === true, version: VERSION })));
}

function opsSummarise(st, rows) {
  const now = Date.now();
  const left = Math.ceil(((st.paid_until || 0) - now) / 864e5);
  const today = rows.filter(r => String(r.at || '').slice(0, 10) === new Date(now).toISOString().slice(0, 10));
  return {
    handle: st.handle, shop_name: st.shop_name, currency: st.currency || 'USD', rail: st.rail,
    plan: st.plan || 'free60', left, suspended: !!st.suspended, created_at: st.created_at,
    paid_until: st.paid_until || 0, feed_products: st.feed_cache ? (st.feed_cache.count || 0) : 0,
    feed_error: st.feed_cache ? (st.feed_cache.error || null) : 'never fetched',
    notify_email: !!st.notify_email, owner_email: st.owner_email ? maskField('notify_email', st.owner_email) : null,
    pay_account_set: !!st.pay_account, whatsapp_set: !!st.whatsapp,
    has_pending: !!(st.pending && st.pending.fields && Object.keys(st.pending.fields).length),
    pending_apply_at: st.pending ? st.pending.apply_at : null,
    orders: rows.length, orders_today: today.length,
    unpaid: rows.filter(r => r.status === 'awaiting_payment').length,
    cod: rows.filter(r => r.status === 'cod').length,
    gmv: rows.reduce((a, r) => a + (Number(r.total) || 0), 0),
    last_order_at: rows.length ? rows[0].at : null,
    store_url: '/s/' + st.handle,
  };
}
async function opsRefs(env, handle) {
  return ((await env.STORES.get('ref:' + handle, 'json')) || []).slice(0, 5);
}

async function opsState(env) {
  const t0 = Date.now();
  const listed = await env.STORES.list({ prefix: 'store:', limit: 1000 });
  const handles = (listed.keys || []).map(k => String(k.name).slice('store:'.length)).filter(Boolean);
  const stores = [];
  for (const h of handles) {
    const st = await getStore(env, h);
    if (!st) continue;
    const rows = (await env.ORDERS.get('list:' + h, 'json')) || [];
    const sum = opsSummarise(st, rows);
    sum.awaiting_reference = await opsRefs(env, h);
    sum.awaiting_ref = sum.awaiting_reference.length;
    stores.push(sum);
  }
  stores.sort((a, b) => (b.orders_today - a.orders_today) || String(a.handle).localeCompare(b.handle));
  const due = stores.filter(s => !s.suspended && s.left <= 7);
  return json({
    ok: true, at: new Date().toISOString(), ms: Date.now() - t0,
    version: VERSION, stores,
    totals: {
      stores: stores.length,
      live: stores.filter(s => !s.suspended).length,
      suspended: stores.filter(s => s.suspended).length,
      expiring_7d: due.length,
      expired: stores.filter(s => s.left <= 0).length,
      feeds_broken: stores.filter(s => !s.feed_products || s.feed_error).length,
      orders_today: stores.reduce((a, s) => a + s.orders_today, 0),
      orders_all: stores.reduce((a, s) => a + s.orders, 0),
      unpaid: stores.reduce((a, s) => a + s.unpaid, 0),
      pending_settings: stores.filter(s => s.has_pending).length,
      gmv: Math.round(stores.reduce((a, s) => a + s.gmv, 0) * 100) / 100,
      awaiting_reference: stores.reduce((a, s) => a + (s.awaiting_ref || 0), 0),
      on_free: stores.filter(s => s.plan === 'free60').length,
      paying: stores.filter(s => s.plan !== 'free60').length,
    },
    attention: stores.filter(s => s.suspended || s.left <= 7 || !s.feed_products || s.feed_error || s.has_pending || s.awaiting_ref)
      .map(s => ({ handle: s.handle, why: [s.suspended ? 'suspended' : '', s.left <= 0 ? 'expired' : (s.left <= 7 ? s.left + 'd left' : ''), (!s.feed_products || s.feed_error) ? 'menu' : '', s.has_pending ? 'queued settings' : '', s.awaiting_ref ? s.awaiting_ref + ' payment ref(s)' : ''].filter(Boolean).join(' · '), left: s.left })),
    free_plan: { kv_reads_day: 100000, kv_writes_day: 1000, kv_list_day: 1000, requests_day: 100000, cron_runs_day: 5 },
    reads_used_estimate: stores.length * 2 + 1,
  }, 200, { 'Cache-Control': 'no-store' });
}

async function opsHealth(env) {
  const t = await selftest(env);
  let pages = 'unreachable';
  try {
    const r = await fetch(PAGES_URL, { headers: { 'user-agent': 'zimlink/1 (operator health check)' } });
    pages = r.status === 200 ? 'ok' : 'http ' + r.status;
  } catch (e) { pages = 'unreachable'; }
  let ci = null;
  try {
    const r = await fetch('https://raw.githubusercontent.com/king-kunta-cpu/zimlink/main/ci-deploy.log', { headers: { 'user-agent': 'zimlink/1 (operator health check)' } });
    if (r.ok) { const txt = await r.text(); ci = txt.split('\n').filter(l => /==== exit|tests |pass |fail /.test(l)).slice(-6); }
  } catch (e) { ci = null; }
  return json({ ok: true, selftest: t, pages, ci, cron: t.cron_heartbeat || null, version: VERSION, templates: OPS_TPL_NAMES }, 200, { 'Cache-Control': 'no-store' });
}

async function opsAudit(req, url, env) {
  const handle = slug(url.searchParams.get('handle') || '');
  if (handle) return json({ ok: true, handle, entries: await getAudit(env, handle) }, 200, { 'Cache-Control': 'no-store' });
  const listed = await env.STORES.list({ prefix: 'store:', limit: 1000 });
  const out = [];
  for (const k of (listed.keys || [])) {
    const h = String(k.name).slice('store:'.length);
    const rows = await getAudit(env, h);
    for (const r of rows.slice(0, 5)) out.push({ handle: h, at: r.at, act: r.act, via: r.via, fields: r.fields });
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const ops = await getOpsLog(env);
  return json({ ok: true, entries: out.slice(0, 60), ops }, 200, { 'Cache-Control': 'no-store' });
}

async function getOpsLog(env) {
  if (!env.ORDERS) return [];
  return (await env.ORDERS.get('audit:ops', 'json')) || [];
}
/**
 * Logging is never allowed to break the thing it is logging. Cloudflare's free
 * KV tier answers `KV put() limit exceeded for the day.` once the 1,000 writes
 * are gone — measured today, after three prod_check runs and two CI deploys —
 * and a console that 500s because its own audit line failed is worse than a
 * console with a gap in the log. Each helper therefore returns whether it
 * wrote, so callers can say so out loud instead of pretending.
 */
const LOG_GAP = 'Applied, but this change could not be written to your change log — the storage write budget for today is spent. Nothing about the change itself failed.';

async function pushOpsLog(env, row) {
  if (!env.ORDERS) return false;
  try {
    const cur = await getOpsLog(env);
    cur.unshift({ at: new Date().toISOString(), act: row.act, handle: row.handle || '', note: row.note || '', ip: row.ip || '' });
    await env.ORDERS.put('audit:ops', JSON.stringify(cur.slice(0, 60)));
    return true;
  } catch (e) { return false; }
}

/**
 * The levers, all of them reversible and all of them logged. None of them is on
 * a customer's critical path; they exist so a stuck merchant can be un-stuck in
 * one click instead of one support conversation.
 */
async function opsStoreAction(req, env) {
  const b = await readBody(req);
  if ((req.headers.get('x-zimlink-confirm') || '') !== '1') return json({ ok: false, error: 'missing x-zimlink-confirm header' }, 403);
  const handle = slug(String(b.handle || ''));
  const st = await getStore(env, handle);
  if (!st) return json({ ok: false, error: 'no store' }, 404);
  const act = String(b.action || '');

  // the two levers that change nothing on the plan answer here and return,
  // before the state-writing chain below — they used to fall through it and
  // come back as `unknown action`, which made them dead buttons
  if (act === 'notify') {
    const sent = [];
    const failed = [];
    if (st.notify_webhook) {
      try {
        await fetch(st.notify_webhook, {
          method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'zimlink/1 (operator notice)' },
          body: JSON.stringify({ type: 'store.notice', store: handle, text: b.message || 'A note from your ZimLink store: your store is fine, nothing is needed from you.' }),
        });
        sent.push('webhook');
      } catch (e) { failed.push('webhook'); }
    }
    if (env.EMAIL && (st.owner_email || st.notify_email)) {
      try {
        await sendMail(env, st.owner_email || st.notify_email, 'A note about your ZimLink store', String(b.message || 'Your store is running normally. No action needed.'));
        sent.push('email');
      } catch (e) { failed.push('email'); }
    }
    // a channel that threw is not a delivery: saying "Sent." when the POST
    // failed would leave the operator believing the merchant had been told
    await pushOpsLog(env, { act: 'notify', handle, note: (sent.join('+') || 'none') + (failed.length ? ' (failed: ' + failed.join(',') + ')' : ''), ip: ipOf(req) });
    return json({
      ok: true, delivered: sent, failed,
      note: sent.length && !failed.length ? 'Sent.'
        : sent.length ? 'Sent on ' + sent.join(' + ') + ', but ' + failed.join(' and ') + ' did not go through — the store can still see it in their log.'
        : failed.length ? 'The channel on file is there but did not answer (' + failed.join(', ') + '). Nothing was delivered.'
        : 'This store has no webhook or email on file, so there is no channel to it. That is a gap in the merchant setup, not an outage.',
    });
  }
  if (act === 'link') {
    const link = await issueLogin(env, st, new URL(req.url).origin);
    await pushOpsLog(env, { act: 'link', handle, note: 'issued a dashboard link for the merchant', ip: ipOf(req) });   // best-effort
    return json({ ok: true, dashboard_url: link, note: 'Paste this to them once; it opens a 12-hour session and dies in 7 days.' });
  }

  const before = { plan: st.plan, paid_until: st.paid_until, suspended: !!st.suspended };
  let done = act;
  if (act === 'suspend') st.suspended = true;
  else if (act === 'reinstate') { st.suspended = false; st.warned_at = null; await env.STORES.delete('term:' + handle); }
  else if (act === 'extend7') st.paid_until = Math.max(Date.now(), st.paid_until || 0) + 7 * 864e5;
  else if (act === 'extend30') st.paid_until = Math.max(Date.now(), st.paid_until || 0) + 30 * 864e5;
  else if (act === 'grant_year') { st.paid_until = Math.max(Date.now(), st.paid_until || 0) + 365 * 864e5; st.plan = 'annual'; st.suspended = false; }
  else if (act === 'reset_free') { st.paid_until = Date.now() + FREE_DAYS * 864e5; st.plan = 'free60'; st.suspended = false; }
  else if (act === 'clear_pending') { delete st.pending; done = 'reverted a queued settings change'; }
  else if (act === 'clear_refs') { await env.STORES.delete('ref:' + handle); delete st.pending_ref_note; done = 'cleared the payment references the merchant filed'; }
  else if (act === 'revoke') { st.auth_gen = Date.now().toString(36); st.admin_token = randomKey(16); delete st.pending; done = 'revoked every link, key and cookie'; }
  else return json({ ok: false, error: 'unknown action', actions: ['suspend', 'reinstate', 'extend7', 'extend30', 'grant_year', 'reset_free', 'clear_pending', 'clear_refs', 'revoke', 'notify', 'link'] }, 422);

  await writeStore(env, st);
  const after = { plan: st.plan, paid_until: st.paid_until, suspended: !!st.suspended };
  const loggedOps = await pushOpsLog(env, { act, handle, note: JSON.stringify(after), ip: ipOf(req) });
  const loggedStore = await pushAudit(env, st, { act: 'operator:' + act, via: 'ops', fields: Object.keys(after), before: opsMaskTerm(before), after: opsMaskTerm(after) });
  return json({
    ok: true, handle, action: done, before, after, logged: loggedOps && loggedStore,
    undo: act === 'reinstate' ? 'suspend' : 'reinstate',
    note: loggedStore ? 'Logged in this store’s change log too, so the merchant can see that it was us, not them.'
      : 'The change is applied. Its log line could not be written (storage write budget for today), so the merchant will not see a note about it until tomorrow.',
  });
}

function opsMaskTerm(o) { return { plan: o.plan, suspended: o.suspended, paid_until: o.paid_until ? new Date(o.paid_until).toISOString().slice(0, 10) : null }; }

async function opsIssueLink(req, env) {
  const b = await readBody(req);
  const st = await getStore(env, slug(String(b.handle || '')));
  if (!st) return json({ ok: false, error: 'no store' }, 404);
  return json({ ok: true, dashboard_url: await issueLogin(env, st, new URL(req.url).origin) });
}

/** Everything the operator might need to see about one store, and nothing
 *  that would let a browser session become a credential (no admin_token, no
 *  raw admin_url — the link is issued deliberately, via the link lever). */
/**
 * The rail catalogue, editable. `built_in` is what ships in code; the editor
 * holds only the additions, so a mistake here can always be emptied back to the
 * tariffs that were verified, and nothing a merchant is quoted can silently
 * disappear mid-order (orders snapshot their own rail at placement).
 */
async function opsRailsRead(env) {
  const extra = (await env.STORES.get('rails:extra', 'json')) || {};
  return json({
    ok: true, added: extra, built_in: RAILS, live: await railsCatalog(env),
    price_usd: PRICE_USD, free_days: FREE_DAYS,
  }, 200, { 'Cache-Control': 'no-store' });
}
async function opsRailsWrite(req, env) {
  const b = await readBody(req);
  if ((req.headers.get('x-zimlink-confirm') || '') !== '1') return json({ ok: false, error: 'missing x-zimlink-confirm header' }, 403);
  if (b.restore) {
    const prev = (await env.STORES.get('rails:extra', 'json')) || {};
    if (Object.keys(prev).length) {
      const listed = await env.STORES.list({ prefix: 'store:', limit: 1000 });
      const still = [];
      for (const kk of (listed.keys || [])) {
        const h = String(kk.name).slice('store:'.length);
        const doc = await getStore(env, h);
        if (doc && prev[doc.rail]) still.push(h + ':' + doc.rail);
      }
      if (still.length) return json({ ok: false, error: 'cannot restore while an added rail is in use', used_by: still,
        note: 'Switch those stores to a built-in rail first.' }, 422);
    }
    await env.STORES.delete('rails:extra');
    await pushOpsLog(env, { act: 'rails-restore', handle: 'rails', note: 'removed every added rail, back to the built-in tariffs', ip: ipOf(req) });
    return json({ ok: true, restored: 'built-in tariffs only', live: await railsCatalog(env) });
  }
  const input = b.rails && typeof b.rails === 'object' ? b.rails : null;
  if (!input) return json({ ok: false, error: 'send { rails: { key: { label, dial, pct, fixed, type } } }' }, 422);
  const out = {}, bad = {};
  for (const k of Object.keys(input)) {
    const key = String(k).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
    const r = normaliseRail(input[k], key);
    if (!key) bad[k] = 'key: lowercase letters, digits, dash';
    else if (RAILS[key]) bad[k] = 'that key is a built-in tariff and cannot be overridden here — change core.js if the published rate moved';
    else if (!r) bad[k] = 'needs a label of at least 2 characters';
    else out[key] = r;
  }
  if (Object.keys(bad).length) return json({ ok: false, error: 'some rails need a different format', rails: bad }, 422);
  const was = await env.STORES.get('rails:extra', 'json');
  // removing a rail a store is still using would silently reprice that store as
  // cash — no fee, no dial string, buyers told to pay on delivery. Refuse, and
  // name the shops, so the fix is obvious instead of discovered by a merchant.
  const removed = Object.keys(was || {}).filter((k) => !(k in out));
  if (removed.length) {
    const inUse = {};
    const listed = await env.STORES.list({ prefix: 'store:', limit: 1000 });
    for (const kk of (listed.keys || [])) {
      const h = String(kk.name).slice('store:'.length);
      const doc = await getStore(env, h);
      if (doc && removed.indexOf(doc.rail) >= 0) (inUse[doc.rail] = inUse[doc.rail] || []).push(h);
    }
    if (Object.keys(inUse).length) {
      return json({ ok: false, error: 'a rail in use cannot be removed', rails: Object.keys(inUse).reduce((a, k) => { a[k] = inUse[k].length + ' store(s): ' + inUse[k].join(', '); return a; }, {}),
        note: 'Move those stores to another rail first, or leave the rail in place.' }, 422);
    }
  }
  await env.STORES.put('rails:extra', JSON.stringify(out));
  await pushOpsLog(env, { act: 'rails', handle: 'rails', note: (Object.keys(was || {}).length) + ' -> ' + Object.keys(out).length + ' added rails: ' + Object.keys(out).join(','), ip: ipOf(req) });
  return json({ ok: true, added: Object.keys(out), live: await railsCatalog(env),
    note: 'Live at once for new stores and new orders. Orders already placed keep the rail printed on their slip.' });
}

async function opsStoreDetail(url, env) {
  const handle = slug(url.searchParams.get('handle') || '');
  const st = await getStore(env, handle);
  if (!st) return json({ ok: false, error: 'no store' }, 404);
  const rows = (await env.ORDERS.get('list:' + handle, 'json')) || [];
  const orders = [];
  for (const r of rows.slice(0, 15)) { const o = await env.ORDERS.get('order:' + handle + ':' + r.id, 'json'); if (o) orders.push(opsOrderLite(o)); }
  return json({
    ok: true,
    summary: Object.assign(opsSummarise(st, rows), { awaiting_reference: await opsRefs(env, handle) }),
    store: adminStore(st),
    feed_url: st.feed_url, renew_url: st.renew_url,
    editable: EDITABLE_FIELDS,
    orders,
    audit: await getAudit(env, handle),
    queued: st.pending ? { keys: Object.keys(st.pending.fields), apply_at: st.pending.apply_at, in_ms: Math.max(0, st.pending.apply_at - Date.now()), fields: st.pending.fields } : null,
  }, 200, { 'Cache-Control': 'no-store' });
}
function opsOrderLite(o) {
  return {
    id: o.id, code: o.code, at: o.at, status: o.status, service: o.service,
    total: o.pricing && o.pricing.total, pay_now: o.pricing && o.pricing.pay_now,
    currency: o.pricing && o.pricing.currency, rail: o.pricing && o.pricing.rail && o.pricing.rail.label,
    buyer: o.buyer ? { name: o.buyer.name, phone: o.buyer.phone } : null,
    items: (o.items || []).length, flags: o.risk_flags || [], marked_at: o.marked_at || null,
    pay_account: o.pay && o.pay.account, reference: o.pay && o.pay.reference,
  };
}

const REPO_RAW = 'https://raw.githubusercontent.com/king-kunta-cpu/zimlink/main/';

async function opsTemplates(env) {
  const out = [];
  for (const name of OPS_TPL_NAMES) {
    const v = await env.STORES.get('tpl:' + name);
    out.push({ name, bytes: v ? v.length : 0, live: !!(v && v.length > 200), sha: v ? (await hash(name + ':' + v.length + ':' + v.slice(0, 64))).slice(0, 8) : null });
  }
  return json({ ok: true, templates: out }, 200, { 'Cache-Control': 'no-store' });
}
async function opsTemplateRead(url, env) {
  const name = safeTplName(url.searchParams.get('name'));
  if (!name) return json({ ok: false, error: 'bad template name' }, 422);
  const v = await env.STORES.get('tpl:' + name);
  return json({ ok: true, name, bytes: v ? v.length : 0, html: v || '' }, 200, { 'Cache-Control': 'no-store' });
}
function safeTplName(n) { const x = String(n || ''); return OPS_TPL_NAMES.indexOf(x) >= 0 ? x : null; }
async function opsTemplateWrite(req, env) {
  const b = await readBody(req);
  if ((req.headers.get('x-zimlink-confirm') || '') !== '1') return json({ ok: false, error: 'missing x-zimlink-confirm header' }, 403);
  const name = safeTplName(b.name);
  if (!name) return json({ ok: false, error: 'not a template this console may write', allowed: OPS_TPL_NAMES }, 422);
  const html = String(b.html || '');
  if (html.length < 200) return json({ ok: false, error: 'refusing to publish a page shorter than 200 bytes' }, 422);
  if (!/^<!doctype html>/i.test(html.trim().slice(0, 40))) return json({ ok: false, error: 'must start with <!doctype html>' }, 422);
  if (/<script[^>]+src\s*=\s*["']?http/i.test(html)) return json({ ok: false, error: 'no remote scripts: these pages are single-file by design' }, 422);
  const key = name === 'sample-menu' ? 'tpl:sample-menu' : 'tpl:' + name;
  const was = await env.STORES.get(key);
  if (b.restore) {
    // the committed copy is the safety net: a hand-edit that goes wrong in the
    // console is one press from being undone, with nothing to redeploy
    const raw = await fetch(REPO_RAW + (name === 'sample-menu' ? 'pages/sample-menu.csv' : 'pages/' + name + '.html'),
      { headers: { 'user-agent': 'zimlink/1 (template restore)' } });
    if (!raw.ok) return json({ ok: false, error: 'could not read the committed copy (HTTP ' + raw.status + ')' }, 502);
    const text = await raw.text();
    if (text.length < 200) return json({ ok: false, error: 'committed copy looks truncated; refusing to publish it' }, 502);
    await env.STORES.put(key, text);
    await pushOpsLog(env, { act: 'template-restore', handle: name, note: (was ? was.length : 0) + ' -> ' + text.length + ' bytes from main', ip: ipOf(req) });
    return json({ ok: true, restored: name, bytes: text.length, was: was ? was.length : 0, source: 'git main' });
  }
  await env.STORES.put(key, html);
  const now = await env.STORES.get(key);
  await pushOpsLog(env, { act: 'template', handle: name, note: (was ? was.length : 0) + ' -> ' + now.length + ' bytes', ip: ipOf(req) });
  return json({ ok: true, name, bytes: now.length, was: was ? was.length : 0, matches: now === html, hot: 'no redeploy needed — this is the live copy', note: name === 'sample-menu' ? 'CSV published.' : 'Live for the next request.' });
}

