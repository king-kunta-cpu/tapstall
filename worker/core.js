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
export function priceOrder(st = {}, items = [], service = 'pickup', railKey = 'cash') {
  const rail = RAILS[railKey] || RAILS.cash;
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

export function publicStore(st) {
  if (!st) return null;
  const {
    admin_token, notify_webhook, notify_email, fw_secret, secret_hash, owner_email,
    feed_url, feed_cache, admin_url, renew_url, ...pub
  } = st;
  return pub;
}

/** SHA-256 hex — used for buyer fingerprints (no PII stored in the open). */
export async function hash(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(input)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
