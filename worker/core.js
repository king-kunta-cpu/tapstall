/**
 * ZimLink core — the pure logic (pricing, CSV/menu parsing, feed normalisation,
 * fraud flags, receipt text). Imported by worker/worker.js and unit-tested by
 * tests/core.test.mjs, so the tests run against shipped code, not a copy.
 */

export const RAILS = {
  ecocash_usd: { label: 'EcoCash USD', dial: '*151#', pct: 0.014, imtt: 0.02, fixed: 0, type: 'manual' },
  ecocash_zig: { label: 'EcoCash ZiG', dial: '*151#', pct: 0.02, imtt: 0.015, fixed: 0, type: 'manual' },
  innbucks: { label: 'InnBucks', dial: '*155*4#', pct: 0.015, imtt: 0.02, fixed: 0, type: 'manual' },
  onepay: { label: 'OnePay / OneMoney', dial: 'wallet app', pct: 0.015, imtt: 0.02, fixed: 0, type: 'manual' },
  zipit: { label: 'Bank ZIPIT / RTGS', dial: 'bank app', pct: 0, imtt: 0.02, fixed: 0, type: 'manual' },
  cash: { label: 'Cash on delivery / pickup', dial: '', pct: 0, imtt: 0, fixed: 0, type: 'cod' },
  payshap: { label: 'PayShap (SA)', dial: 'ShapID', pct: 0.005, imtt: 0, fixed: 0, type: 'manual' },
  ozow: { label: 'Ozow (SA)', dial: 'link', pct: 0.01, imtt: 0, fixed: 0, type: 'auto' },
  payfast: { label: 'PayFast card (SA)', dial: 'hosted', pct: 0.029, imtt: 0, fixed: 1.0, type: 'auto' },
};

/**
 * The rails above are the ones with published tariffs I could verify. The
 * market is not those two countries: it is every seller take.app excludes, and
 * in most of those places the method is one this table has never heard of —
 * M-Pesa, GCash, bKash, Paystack transfer, Yape, Nequi, Tigo Pasa. So a rail is
 * data, not code: the operator can add one to KV (`rails:extra`) and a merchant
 * can describe the one their buyers already use. We never touch the money, so a
 * rail only has to answer two questions — what does the buyer dial, and what does
 * it cost them to move a rand/dollar/kyat through it.
 */
export function normaliseRail(def, key) {
  const d = def && typeof def === 'object' ? def : {};
  const label = String(d.label || '').trim().slice(0, 40);
  if (label.length < 2) return null;
  const pct = clamp(Number(d.pct), 0, 0.30) || 0;
  const imtt = clamp(Number(d.imtt), 0, 0.30) || 0;
  const fixed = clamp(Number(d.fixed), 0, 1000) || 0;
  const type = ['manual', 'auto', 'cod'].indexOf(d.type) >= 0 ? d.type : 'manual';
  const dial = String(d.dial || '').trim().slice(0, 40);
  return { key: key || 'custom', label, dial: dial || (type === 'auto' ? 'link' : 'wallet app'), pct, imtt, fixed, type, added: true };
}

/** The rail a store actually prices with: operator-added catalogue, then the
 *  built-in table, then the store's own description, then cash. */
export function resolveRail(st, railKey, catalog) {
  // 'custom' is answered by the store document, not the catalogue: the
  // catalogue's `custom` entry is only a placeholder for pickers, and letting
  // it win would price every self-described method at 0% with a label the
  // merchant never wrote
  if (railKey === 'custom') {
    return normaliseRail((st || {}).rail_def, 'custom') || (catalog && catalog.custom) || RAILS.cash;
  }
  if (catalog && catalog[railKey]) return catalog[railKey];
  if (RAILS[railKey]) return RAILS[railKey];
  return RAILS.cash;
}

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const clamp = (n, lo, hi) => { n = Number(n); return isNaN(n) ? 0 : Math.max(lo, Math.min(hi, n)); };
export const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const digits = (s) => String(s || '').replace(/[^\d+]/g, '');
export const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(String(s || ''));
export const validHandle = (h) => /^[a-z0-9][a-z0-9-]{1,29}$/.test(String(h));

/** Parse a CSV string into rows of fields, honouring quotes and doubled quotes. */
export function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

/** Google Sheets view/edit/pub link -> CSV endpoint. Anything else passes through. */
export function normalizeFeedUrl(u) {
  if (!u) return null;
  const s = String(u);
  const g = s.match(/docs\.google\.com\/spreadsheets\/d\/(?:e\/)?([A-Za-z0-9_-]{20,})/);
  if (g) {
    const gid = (s.match(/[#&?]gid=(\d+)/) || [])[1] || '0';
    return `https://docs.google.com/spreadsheets/d/${g[1]}/gviz/tq?tqx=out:csv&gid=${gid}`;
  }
  const pub = s.match(/spreadsheets\/d\/([A-Za-z0-9_-]+)\/pub/);
  if (pub) return `https://docs.google.com/spreadsheets/d/${pub[1]}/gviz/tq?tqx=out:csv&gid=0`;
  return /^https?:\/\//.test(s) ? s : null;
}

/** Menu CSV -> product objects the storefront renders. */
export function parseProducts(csv, st = {}) {
  const rows = parseCSV(csv);
  if (!rows.length) return [];
  const head = rows[0].map(h => String(h).trim().toLowerCase().replace(/\s+/g, '_').replace(/^\uFEFF/, ''));
  const i = (k) => head.indexOf(k);
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row.length) continue;
    const get = (k) => { const j = i(k); return j >= 0 && row[j] != null ? String(row[j]).trim() : ''; };
    const name = get('name') || get('product') || get('item');
    if (!name || /^help$|^_/i.test(name)) continue;
    const price = Number((get('price') || '0').replace(/[^0-9.]/g, '')) || 0;
    const stock = get('stock').toLowerCase();
    const outOf = stock !== '' && ['no', 'out', '0', 'sold out', 'false'].includes(stock);
    const avail = get('available').toLowerCase();
    // options = "Size:Small,Medium,Large"  |  with price = "Size:Regular:0,Large:2"
    // addons  = "Extra meat:3|Django:1.5"
    const parseOpt = (raw) => {
      const t = String(raw).trim(); if (!t) return null;
      const c = t.indexOf(':'); if (c < 0) return null;
      const head = t.slice(0, c).trim();
      const parts = t.slice(c + 1).split(',').map(x => x.trim()).filter(Boolean);
      if (!head || !parts.length) return null;
      // Per choice, a trailing ":number" is a price; anything else is plain text.
      // Forgiving on purpose: a merchant who prices 2 of 3 sizes must not lose a price,
      // and an unpriced list must never silently drop its labels.
      return { name: head, choices: parts.map((x) => {
        const k = x.lastIndexOf(':');
        const maybe = k > 0 ? x.slice(k + 1).trim() : '';
        return /^\d*\.?\d+$/.test(maybe)
          ? { label: x.slice(0, k).trim(), up: Number(maybe) || 0 }
          : { label: x, up: 0 };
      }) };
    };
    const parseAddon = (raw) => {
      const t = String(raw).trim(); if (!t) return null;
      const c = t.indexOf(':');
      const name = (c < 0 ? t : t.slice(0, c)).trim();
      const price = c < 0 ? 0 : Number(t.slice(c + 1).replace(/[^0-9.]/g, '')) || 0;
      return name ? { name, price } : null;
    };
    out.push({
      id: get('id') || slug(name),
      name,
      cat: get('category') || get('cat') || 'Menu',
      price,
      cur: (get('currency') || st.currency || 'USD').toUpperCase(),
      img: get('image') || get('image_url') || '',
      desc: get('description') || get('desc') || '',
      opts: String(get('options') || '').split('|').map(parseOpt).filter(Boolean),
      addons: String(get('addons') || '').split('|').map(parseAddon).filter(Boolean),
      available: !outOf && avail !== 'no' && !st.closed,
      prep: Number(get('prep_min')) || 0,
      popular: ['yes', 'y', 'true', '1', '*'].includes(get('popular').toLowerCase()),
    });
  }
  return out;
}

/**
 * The money math. Two things the incumbent does not do for Zim/SA merchants:
 *  1) rail cost is known per payment method (incl. Zimbabwe's 2% IMTT) so the
 *     merchant can absorb it knowingly, or pass it — take.app can only pass on
 *     "automatic" rails, which Zimbabwe has none of;
 *  2) every order gets unique odd cents so a payment is identifiable by amount
 *     alone, which is what kills proof-of-payment screenshots as a dependency.
 */
export function priceOrder(st = {}, items = [], service = 'pickup', railKey = 'cash', catalog) {
  const rail = resolveRail(st, railKey, catalog);
  const lines = [];
  let itemsTotal = 0;
  for (const raw of items) {
    const it = raw || {};
    const base = Number(it.price) || 0;
    const optUp = (it.options || []).reduce((a, o) => a + (Number(o && o.up) || 0), 0);
    const addOn = (it.addons || []).reduce((a, x) => a + (Number(x) || 0), 0);
    const unit = round2(base + optUp + addOn);
    const qty = Math.max(1, Math.min(99, Number(it.qty) || 1));
    const total = round2(unit * qty);
    itemsTotal = round2(itemsTotal + total);
    lines.push({ name: String(it.name || 'item').slice(0, 80), qty, unit, total });
  }
  const delivery = service === 'delivery' ? round2(Number(st.delivery_fee) || 0) : 0;
  const freeOver = Number(st.free_over) || 0;
  const del = freeOver && itemsTotal >= freeOver ? 0 : delivery;
  const taxPct = Number(st.tax_pct) || 0;
  const tax = round2((itemsTotal + del) * taxPct / 100);
  const subtotal = round2(itemsTotal + del + tax);
  const mode = st.surcharge_mode === 'pass' ? 'pass' : 'absorb';
  const fee = rail.type === 'cod' ? 0 : round2(subtotal * (rail.pct || 0) + (rail.fixed || 0) + subtotal * (rail.imtt || 0));
  const total = round2(subtotal + (mode === 'pass' ? fee : 0));
  const jitter = st.unique_change === false ? 0 : (Math.abs(Math.round(total * 100)) % 97) / 100;
  return {
    lines, itemsTotal, delivery: del, tax, taxPct, subtotal,
    rail: { key: railKey, label: rail.label, dial: rail.dial, pct: rail.pct, imtt: rail.imtt, fixed: rail.fixed, type: rail.type },
    fee: mode === 'pass' ? fee : 0,
    fee_absorbed_by_merchant: mode === 'absorb' ? fee : 0,
    surcharge_mode: mode,
    total, pay_now: round2(total + jitter), unique_change: round2(jitter),
  };
}

/** Unique pay-this amount per order — the anti-screenshot trick. */
export function uniqueAmount(total, enabled = true) {
  if (!enabled) return round2(total);
  return round2(round2(total) + (Math.abs(Math.round(round2(total) * 100)) % 97) / 100);
}

export function reference(st = {}, order = {}) {
  return String(st.reference_format || '{code}')
    .replace('{code}', order.code || '')
    .replace('{id}', String(order.id || '').slice(-6));
}

export function payInstructions(st = {}, order = {}, pricing = {}) {
  const rail = pricing.rail || {};
  const ref = reference(st, order);
  const acct = st.pay_account || (rail.type === 'cod' ? 'pay on delivery' : 'not set — owner must fix');
  return {
    rail: rail.label, dial: rail.dial, account: acct, reference: ref,
    amount: pricing.pay_now, currency: st.currency || 'USD',
    note: 'Pay the EXACT amount. The odd cents are what links your payment to your order — no screenshot needed.',
    steps: rail.type === 'cod'
      ? ['Nothing to pay now — pay the runner or pay at pickup.']
      : [`Open ${rail.label}${rail.dial ? ' (' + rail.dial + ')' : ''}`, `Send exactly ${pricing.pay_now} ${st.currency || 'USD'} to ${acct}`, `Use reference: ${ref}`],
  };
}

export function riskFlags(st = {}, order = {}, hist = {}) {
  const f = [];
  if ((hist.unpaid || 0) >= 2) f.push('repeat_unpaid_buyer');
  if (order.service === 'delivery' && ((order.pricing || {}).total || 0) > (Number(st.cod_review_above) || 80)) {
    f.push('high_value_cod_review_before_sending');
  }
  if (((order.pricing || {}).rail || {}).type === 'manual' && String(st.pay_account || '').length < 6) {
    f.push('merchant_pay_account_not_set');
  }
  return f;
}

export function waSummary(st = {}, o = {}) {
  const cur = st.currency || 'USD';
  const p = o.pricing || {};
  const lines = (o.items || []).map(it => `${it.qty || 1}x ${it.name}${(it.addons || []).length ? ' +' + it.addons.length + ' extra' : ''}`);
  return [
    `*${o.code}* — ${(o.buyer || {}).name || ''}`,
    ...lines,
    `Total *${p.pay_now}* ${cur} (${(p.rail || {}).label || 'cash'})`,
    o.service === 'delivery' ? `Deliver to: ${(o.buyer || {}).address || ''}` : 'Pickup',
    o.when && o.when !== 'asap' ? `Time: ${o.when}` : '',
    (p.rail || {}).type !== 'cod' ? `Pay ${p.pay_now} to ${st.pay_account || '—'} ref ${o.code}` : 'Paying on delivery',
    (o.buyer || {}).note ? `Note: ${o.buyer.note}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * What a stranger may learn about a store. An allowlist, on purpose: a denylist
 * leaks the day someone adds a field and forgets to list it here — which is
 * exactly what happened when `pending` (a queued payout account) started riding
 * along on the store document and turned up in `/s/<handle>/config.json`.
 */
export const PUBLIC_KEYS = [
  'handle', 'shop_name', 'tagline', 'logo', 'location', 'hours', 'closed',
  'currency', 'zig_rate', 'tax_pct', 'rail', 'surcharge_mode', 'delivery_fee', 'free_over',
  'pay_account', 'whatsapp', 'require_optin', 'unique_change', 'order_prefix', 'reference_format',
  'rail_def',   // a merchant-described rail is buyer-facing by definition: label, dial string, fee
];
// `catalog` is optional and only ever widens what a store is allowed to mean;
// a page rendered without it still prices correctly for the built-in tariffs.
export function publicStore(st, catalog) {
  if (!st) return null;
  const out = {};
  for (const k of PUBLIC_KEYS) if (st[k] !== undefined) out[k] = st[k];
  // The storefront previews the total before the buyer commits, so it has to do
  // the same arithmetic the worker will do on the receipt. Handing it the
  // resolved rail (label, dial, rates) is what stops a page built for Zim's
  // 3.4% quoting a Ghanaian or Bangladeshi shop a number nothing will match.
  const r = resolveRail(st, st.rail || 'cash', catalog);
  out.rail_info = { key: r.key, label: r.label, dial: r.dial, type: r.type,
                    pct: r.pct, imtt: r.imtt, fixed: r.fixed, added: !!r.added };
  return out;
}

/** What the signed-in owner may learn: everything except the credentials. */
export function adminStore(st) {
  if (!st) return null;
  const { admin_token, auth_gen, admin_url, feed_cache, pending, secret_hash, fw_secret, ...rest } = st;
  return rest;
}

/** SHA-256 hex — used for buyer fingerprints (no PII stored in the open). */
export async function hash(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(input)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ============================================================================
 * Capability tokens, sessions and self-service settings.
 *
 * The rule this whole section exists to enforce: a URL that a mail scanner,
 * a chat link-preview bot or a crawler can fetch must never be able to move
 * money or change a store. So authority is carried by short-lived signed
 * tokens (never stored, never guessed, scoped to one store + one action + one
 * expiry), and every one of them is *spent* by a POST the browser initiates.
 * A GET can only ever return a page.
 * ==========================================================================*/

const b64u = (buf) => btoa(String.fromCharCode.apply(null, new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '==='.slice((t.length + 3) % 4));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};

async function hmacSig(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(msg)))).slice(0, 43);
}

/** 128-bit url-safe random, for revocable API keys. */
export function randomKey(bytes = 16) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b64u(b);
}

/** Signed, stateless capability: `v1.<expiry>.<payload>.<tag>`. */
export async function issueCap(secret, payload, ttlSec) {
  const exp = Math.floor(Date.now() / 1000) + Math.max(300, Math.floor(ttlSec || 3600));
  const body = b64u(new TextEncoder().encode(JSON.stringify(payload)));
  return `v1.${exp}.${body}.${await hmacSig(secret, exp + '.' + body)}`;
}

/** Returns the payload with `exp` attached, or null for any forgery/expiry. */
export async function verifyCap(secret, cap, nowSec) {
  const parts = String(cap || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < (nowSec || Math.floor(Date.now() / 1000))) return null;
  const want = await hmacSig(secret, exp + '.' + parts[2]);
  const got = parts[3];
  if (want.length !== got.length) return null;
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ got.charCodeAt(i);
  if (d) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64u(parts[2])));
    p.exp = exp;
    return p;
  } catch (e) { return null; }
}

/** Detached signature over an arbitrary message (outbound webhook bodies). */
export async function sign(secret, msg) { return hmacSig(secret, String(msg || '')); }

/* ------------------------------------------------------------ settings model */

/** Fields a merchant may change instantly: nothing here moves money or PII. */
export const SOFT_FIELDS = ['tagline', 'logo', 'location', 'hours', 'closed'];

/** Every editable field and its validator; null = rejected, undefined-safe. */
const SET = {
  shop_name: (v) => { const s = String(v || '').trim().slice(0, 60); return s.length >= 2 ? s : null; },
  tagline: (v) => String(v || '').trim().slice(0, 140),
  logo: (v) => (!v ? '' : /^https?:\/\/\S+$/.test(String(v)) ? String(v).slice(0, 300) : null),
  location: (v) => String(v || '').trim().slice(0, 90),
  hours: (v) => String(v || '').trim().slice(0, 60),
  closed: (v) => v === true || v === 'true' || v === 1 || v === '1',
  whatsapp: (v) => { const d = digits(v).replace(/\D/g, ''); return d.length >= 9 && d.length <= 15 ? d : null; },
  pay_account: (v) => String(v || '').trim().slice(0, 60),
  // the catalogue a caller knows about decides what a valid rail is; without
  // one we can only check syntax, which is why this takes opts.rails
  rail: (v, opts) => {
    const key = String(v || '');
    if (!/^[a-z0-9][a-z0-9_-]{1,19}$/.test(key)) return null;
    const cat = opts && opts.rails;
    if (cat) return cat[key] || key === 'custom' ? key : null;
    return RAILS[key] || key === 'custom' ? key : null;
  },
  rail_def: (v) => (v === '' || v === null ? {} : normaliseRail(v, 'custom') || null),
  surcharge_mode: (v) => (v === 'pass' || v === 'absorb' ? v : null),
  currency: (v) => { const s = String(v || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3); return s.length === 3 ? s : null; },
  zig_rate: (v) => { const n = Number(v); return n >= 0 && n < 1e7 ? n : null; },
  tax_pct: (v) => { const n = Number(v); return n >= 0 && n <= 40 ? round2(n) : null; },
  delivery_fee: (v) => { const n = Number(v); return n >= 0 && n <= 10000 ? round2(n) : null; },
  free_over: (v) => { const n = Number(v); return n >= 0 && n <= 1e7 ? round2(n) : null; },
  max_order_value: (v) => { const n = Number(v || 0); return n >= 0 && n <= 1e7 ? round2(n) : null; },
  cod_review_above: (v) => { const n = Number(v || 0); return n >= 0 && n <= 1e7 ? round2(n) : null; },
  cache_seconds: (v) => { const n = Number(v); return n >= 15 && n <= 3600 ? Math.floor(n) : null; },
  feed_url: (v) => (/^https?:\/\/\S+$/.test(String(v || '')) ? String(v).slice(0, 400) : null),
  notify_webhook: (v) => (!v ? '' : /^https:\/\/\S+$/.test(String(v)) ? String(v).slice(0, 300) : null),
  notify_email: (v) => (!v ? '' : isEmail(v) ? String(v).toLowerCase().slice(0, 120) : null),
  owner_email: (v) => (!v ? '' : isEmail(v) ? String(v).toLowerCase().slice(0, 120) : null),
  unique_change: (v) => !(v === false || v === 'false' || v === 0 || v === '0'),
  require_optin: (v) => v === true || v === 'true' || v === 1 || v === '1',
  reference_format: (v) => { const s = String(v || '{code}'); return /^[{ }A-Za-z0-9_-]{1,30}$/.test(s) ? s : null; },
  order_prefix: (v) => { const s = String(v || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 6); return s || null; },
};

export const EDITABLE_FIELDS = Object.keys(SET);

/**
 * Split a settings POST into what applies now and what is held back.
 * `money` fields are the ones an attacker would use to redirect payments or
 * exfiltrate buyer details, so they are staged, not applied.
 */
export function validateSettings(body, now, opts) {
  const soft = {}, money = {}, errors = {}, ignored = [];
  const src = body && typeof body === 'object' ? body : {};
  const options = opts || {};
  for (const k of Object.keys(src)) {
    if (!SET[k]) { ignored.push(k); continue; }
    let v;
    try { v = SET[k](src[k], options); } catch (e) { v = null; }
    if (v === null) { errors[k] = 'check the format of this field'; continue; }
    if (SOFT_FIELDS.indexOf(k) >= 0) soft[k] = v; else money[k] = v;
  }
  return { ok: !Object.keys(errors).length, soft, money, errors, ignored, at: now || Date.now() };
}

/** Apply the harmless fields, stage the rest. Returns counts for the response. */
export function stageSettings(st, soft, money, holdMs, now) {
  const t = now || Date.now();
  let changed = 0;
  for (const k of Object.keys(soft || {})) if (st[k] !== soft[k]) { st[k] = soft[k]; changed++; }
  const pend = (st.pending && st.pending.fields) || {};
  let staged = 0;
  for (const k of Object.keys(money || {})) {
    if (st[k] === money[k] && !(k in pend)) continue;
    pend[k] = money[k]; staged++;
  }
  if (staged) st.pending = { fields: pend, set_at: t, apply_at: t + Math.max(60e3, holdMs) };
  else if (Object.keys(pend).length) st.pending = { fields: pend, set_at: st.pending.set_at, apply_at: st.pending.apply_at };
  else delete st.pending;
  return { changed, staged };
}

/**
 * Fold a due pending change into the store. Called from the read path, so a
 * held change lands the moment anyone (a buyer or the merchant) next looks —
 * no cron dependency, no timer to lose.
 */
export function applyPending(st, now) {
  const p = st && st.pending;
  if (!p || !p.fields || !Object.keys(p.fields).length) return { applied: [], pending: null };
  const t = now || Date.now();
  if (t < (p.apply_at || 0)) {
    return { applied: [], pending: { keys: Object.keys(p.fields), in_ms: p.apply_at - t, apply_at: p.apply_at } };
  }
  const applied = [];
  for (const k of Object.keys(p.fields)) { st[k] = p.fields[k]; applied.push(k); }
  delete st.pending;
  return { applied, pending: null };
}

/** Audit-friendly rendering: enough to recognise a change, never the value. */
export function maskField(k, v) {
  const s = String(v == null ? '' : v);
  if (!s) return '(blank)';
  if (k === 'notify_webhook' || k === 'feed_url' || k === 'logo') {
    try { return new URL(s).host; } catch (e) { return s.slice(0, 8) + '…'; }
  }
  if (k.indexOf('email') >= 0) return (s[0] || '') + '***@' + (s.split('@')[1] || '?');
  if (k === 'pay_account' || k === 'whatsapp') return '•••' + s.slice(-4);
  if (k === 'pay' || k === 'secret') return '••••';
  return s.length > 8 ? s.slice(0, 4) + '…' + s.slice(-2) : s;
}
