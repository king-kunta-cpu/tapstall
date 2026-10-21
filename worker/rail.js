/**
 * Tapstall rail — the settlement layer of a "selling rail".
 *
 * The product decision this file encodes: **we sell the rail, we never hold the money.**
 * Funds travel buyer → merchant (manual rails) or buyer → processor → merchant (collect
 * rails). Nothing here has a balance, a payout, or a wallet, and a test asserts that no
 * export can move money on its own. Every function below is pure so the Worker, the
 * statement page and the tests all argue from the same arithmetic.
 *
 * What was missing before this file (the 80% of rail work that is not collecting):
 *   1. a payment ledger distinct from the order ledger — money *seen*, not just orders placed
 *   2. one catalogue that answers, for any rail, "can a buyer be sent to it?" and
 *      "how does it get proven?" — built-ins, operator extras and processors in one shape
 *   3. reference allocation with TTL, collision retry and a reuse window, so odd cents stay
 *      a reference and not a lottery
 *   4. a settlement statement: expected vs matched vs unmatched, per rail, per day, with fees
 *   5. a refund / dispute path with an evidence trail and a records clock
 *   6. merchant vetting before a cross-border leg is offered, because a processor will ask
 */

/* ------------------------------------------------------------------ the ledger
 * A payment event is a fact about money, written by a human or a webhook, never inferred.
 * `seen` is "the merchant's phone/statement shows this credit"; `matched` is "we know which
 * order it pays"; `unmatched` is money with no home yet (the honest, useful state); `refunded`
 * and `disputed` leave the matched pool. Nothing is ever silently deleted: a mistaken entry is
 * superseded, so the statement can be shown to an accountant six months later.
 */
export const PAY_EVENTS = ['seen', 'matched', 'unmatched', 'refunded', 'disputed', 'resolved', 'written_off'];

export const PAY_EVENT_NOTE = {
  seen: 'A credit the merchant can see on their own phone or statement.',
  matched: 'A credit tied to a specific order. This is the only state that closes an order.',
  unmatched: 'Money arrived and no order claimed it yet. Not a failure — a queue.',
  refunded: 'Money sent back to the buyer. Kept on the record, never deleted.',
  disputed: 'The merchant or the buyer contests the match. Holds the amount aside.',
  resolved: 'A dispute closed. Says who closed it and how.',
  written_off: 'A shortfall the merchant chose to absorb, with a reason.',
};

/** One KV document per shop per month holds the events: one read, one write per event, and
 *  the quota doctrine in core.js (writes are the scarce resource) is respected rather than
 *  argued with. */
export const PAY_DOC_MAX = 400;
export function payDocKey(handle, atMs) {
  const d = new Date(Number(atMs) || Date.now());
  return 'pay:' + String(handle || '') + ':' + d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const railRound2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
const railClip = (v, n = 80) => String(v == null ? '' : v).trim().slice(0, n);

/**
 * A payment event, normalised. `id` is stable so a webhook that arrives twice cannot write
 * twice — the caller checks `hasPaymentEvent()` before appending.
 */
export function paymentEvent(input = {}) {
  const kind = PAY_EVENTS.indexOf(String(input.kind)) >= 0 ? String(input.kind) : null;
  const amount = railRound2(input.amount);
  if (!kind) throw new Error('unknown payment event kind');
  if (!(amount > 0)) throw new Error('a payment event needs an amount: zero is not money');
  const at = Number(input.at) || Date.now();
  const order = railClip(input.order, 60);
  return {
    // Idempotency keys on what the event *is*, never on when it was typed: a webhook delivered
    // twice, or a merchant double-tapping a button, carries the same rail, order, amount and
    // reference — so the second write is refused instead of doubling the statement.
    id: railClip(input.id, 64) || [kind, railClip(input.rail, 40), order, Math.round(amount * 100), railClip(input.reference, 40)].join('|'),
    kind, amount, at, order,
    rail: railClip(input.rail, 40),
    reference: railClip(input.reference, 40),
    by: railClip(input.by, 40) || 'merchant',
    note: railClip(input.note, 240),
    // evidence is a claim, not a payment: it is what lets a human check later
    evidence: input.evidence && typeof input.evidence === 'object'
      ? { type: railClip(input.evidence.type, 20), ref: railClip(input.evidence.ref, 120) } : null,
  };
}

export function hasPaymentEvent(doc, id) {
  const events = (doc && Array.isArray(doc.events)) ? doc.events : [];
  return events.some((e) => e && String(e.id) === String(id));
}

export function appendPaymentEvent(doc, event) {
  const base = (doc && Array.isArray(doc.events)) ? { ...doc } : { events: [], v: 1 };
  if (hasPaymentEvent(base, event.id)) return { doc: base, wrote: false };
  const events = base.events.concat([event]).slice(-PAY_DOC_MAX);
  return { doc: { ...base, events, v: 1, updated: Date.now() }, wrote: true };
}

/* --------------------------------------------------------------- the catalogue
 * A rail answers two questions for the product: what does the buyer dial/visit, and how does
 * the money become proof? Everything else (fees, dial strings, tolerances) already lives in
 * core.RAILS. This layer adds *capability* — which rails can be presented on a receipt, which
 * can be confirmed by machine, and which are the processor's responsibility, not ours.
 */
export const RAIL_KINDS = ['manual', 'auto', 'cod', 'collect'];

export function railCatalogue({ coreRails = {}, extras = {}, collect = {}, vetting } = {}) {
  const out = [];
  for (const [key, r] of Object.entries(coreRails || {})) out.push(shapeRail(key, r, 'built-in'));
  for (const [key, r] of Object.entries(extras || {})) {
    if (!r || typeof r !== 'object') continue;
    if (out.some((x) => x.key === key)) continue;   // a built-in always wins over an extra
    out.push(shapeRail(key, r, 'operator'));
  }
  for (const [key, p] of Object.entries(collect || {})) out.push(shapeRail('collect:' + key, p, 'processor'));
  return out;
}

function shapeRail(key, r = {}, source) {
  const kind = RAIL_KINDS.indexOf(String(r.type)) >= 0 ? String(r.type) : 'manual';
  const proof = String(r.proof || (kind === 'cod' ? 'none' : 'ask'));
  return {
    key,
    label: railClip(r.label || key, 40),
    kind, source,
    dial: railClip(r.dial, 40),
    spec: railClip(r.spec || 'none', 20),
    proof,
    // A buyer can always be *shown* a manual rail; a machine can confirm only an auto or a
    // verified collect leg. Saying this once, in one place, stops a receipt promising more
    // than the rail can keep.
    presentable: kind !== 'collect' || !!r.presentable,
    machine_confirmable: kind === 'auto' || (kind === 'collect' && r.ipn === true),
    custody: 'none',
    tolerance_pct: num(r.tolerance_pct, kind === 'collect' ? 0.01 : 0),
  };
}

export function railFor(catalogue, key) {
  const k = String(key || '');
  return (catalogue || []).find((r) => r.key === k) || null;
}

/* ----------------------------------------------------- reference allocation
 * Odd cents are the whole trick: two buyers can owe $12, only one owes $12.43. That only works
 * if the number is unique *among live orders*, so allocation is stateful — TTL, collision
 * retry, and a reuse window. Jitter is deterministic per shop+total so the statement and the
 * receipt can never disagree about the same order.
 */
export const REF_TTL_SEC = 72 * 3600;      // a live reference outlives the order by three days
export const REF_REUSE_SEC = 24 * 3600;    // a spent reference is not reused within a day

export function allocateCents(total, opts = {}) {
  const base = railRound2(total);
  if (!(base > 0)) return { pay: 0, cents: 0, attempts: 0, reason: 'nothing_to_allocate' };
  if (opts.unique === false) return { pay: base, cents: 0, attempts: 0, reason: 'shop_turned_unique_off' };
  const mod = Math.max(7, Math.min(997, num(opts.modulo, 97)));
  const now = Number(opts.nowMs) || Date.now();
  const taken = new Set();
  for (const t of (opts.taken || [])) {
    const cents = railRound2(t && t.cents != null ? t.cents : 0);
    const at = Number(t && t.at) || 0;
    // a reference older than the TTL is not "taken" any more: the money either arrived or the
    // order was abandoned, and holding the cents forever is how allocators run out of numbers
    if (cents > 0 && now - at < Math.max(0, num(opts.ttlSec, REF_TTL_SEC)) * 1000) taken.add(Math.round(cents * 100));
  }
  const seed = [...String(opts.shopSeed || '') + String(Math.round(base * 100))].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 100003, 7);
  let attempts = 0;
  for (let i = 0; i < mod; i++) {
    attempts++;
    const c = ((seed + i) % mod) + 1;                  // 1..mod cents, never 0: a round number is nobody's key
    if (!taken.has(c)) return { pay: railRound2(base + c / 100), cents: c / 100, attempts, reason: 'unique' };
  }
  return { pay: railRound2(base + 0.01 * mod), cents: mod / 100, attempts, reason: 'pool_exhausted' };
}

export function referenceLive(entry, nowMs, ttlSec = REF_TTL_SEC) {
  if (!entry) return false;
  const at = Number(entry.at) || 0;
  return !!at && (Number(nowMs) || Date.now()) - at < ttlSec * 1000 && entry.kind !== 'refunded';
}

/* -------------------------------------------------------- settlement statement
 * Expected is what the order book says should have arrived. Matched is what the merchant has
 * confirmed arrived *and* tied to an order. Everything else is a queue, not a loss — and the
 * statement says so in words, because a merchant reading "unmatched: 3" at 07:00 needs to know
 * whether that is money or a mistake.
 */
export function settlement(rows = [], events = [], opts = {}) {
  const day = opts.day ? String(opts.day) : null;
  const from = opts.from ? Number(opts.from) : null;
  const to = opts.to ? Number(opts.to) : null;
  // A time arrives as epoch ms from a payment event and as an ISO string from an order row
  // (orderRow keeps the document's own `at`), so both are read the same way — a statement that
  // silently counted zero because a string was not a number would be worse than useless.
  const ms = (v) => {
    if (typeof v === 'number') return v;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
    const t = Date.parse(String(v || ''));
    return Number.isFinite(t) ? t : 0;
  };
  const inWindow = (v) => {
    const t = ms(v);
    if (day) return new Date(t).toISOString().slice(0, 10) === day;
    if (from && t < from) return false;
    if (to && t > to) return false;
    return true;
  };
  const orderRows = (rows || []).filter((r) => r && inWindow(r.at));
  const money = (events || []).filter((e) => e && inWindow(e.at));

  const per = new Map();
  const bump = (rail, field, v) => {
    const k = String(rail || 'unrecorded');
    if (!per.has(k)) per.set(k, { rail: k, expected: 0, matched: 0, unmatched: 0, refunded: 0, disputed: 0, fees: 0, orders: 0, events: 0 });
    const row = per.get(k);
    row[field] = railRound2(row[field] + num(v));
    return row;
  };

  let expected = 0, cancelled = 0;
  for (const r of orderRows) {
    if (String(r.status) === 'cancelled') { cancelled = railRound2(cancelled + num(r.pay_now)); continue; }
    const amt = num(r.pay_now != null ? r.pay_now : r.total);
    expected = railRound2(expected + amt);
    const row = bump(r.rail, 'expected', amt);
    row.orders += 1;
    row.fees = railRound2(row.fees + num(r.fee));
  }
  let matched = 0, unmatched = 0, refunded = 0, disputed = 0, written = 0;
  for (const e of money) {
    const row = bump(e.rail, 'events', 0);
    const amt = num(e.amount);
    if (e.kind === 'matched' || e.kind === 'seen') {   // `seen` counts as matched money only if it names an order
      if (e.kind === 'matched' || e.order) { row.matched = railRound2(row.matched + amt); matched = railRound2(matched + amt); }
      else { row.unmatched = railRound2(row.unmatched + amt); unmatched = railRound2(unmatched + amt); }
    } else if (e.kind === 'unmatched') { row.unmatched = railRound2(row.unmatched + amt); unmatched = railRound2(unmatched + amt); }
    else if (e.kind === 'refunded') { row.refunded = railRound2(row.refunded + amt); refunded = railRound2(refunded + amt); }
    else if (e.kind === 'disputed') { row.disputed = railRound2(row.disputed + amt); disputed = railRound2(disputed + amt); }
    else if (e.kind === 'written_off') { written = railRound2(written + amt); }
  }
  const fees = railRound2([...per.values()].reduce((a, r) => a + num(r.fees), 0));
  const net = railRound2(matched - refunded - fees);
  const gap = railRound2(expected - matched - refunded - written);
  return {
    window: day ? { day } : { from: from || null, to: to || null },
    totals: {
      expected, matched, unmatched, refunded, disputed, written_off: written,
      fees, net,
      // the one number a merchant should act on: money the book expects that the ledger has not
      // matched yet. Negative means money arrived beyond the book — also worth a look.
      awaiting_match: gap,
      orders: orderRows.length,
      cancelled,
    },
    per_rail: [...per.values()].sort((a, b) => b.expected - a.expected),
    events: money.length,
    note: gap > 0
      ? 'Money the order book expects is not matched yet. Check the rail the buyer used before calling it a loss.'
      : (gap < 0 ? 'More money is matched than the book expects — a duplicate credit, or an order marked paid twice. Both are worth a minute.' : 'Every expected amount is matched. Nothing to chase.'),
  };
}

export function settlementCsv(statement, st = {}) {
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [];
  lines.push(['shop', 'window', 'rail', 'orders', 'expected', 'matched', 'unmatched', 'refunded', 'disputed', 'fees', 'net'].map(q).join(','));
  const w = statement.window.day || ((statement.window.from || '') + '..' + (statement.window.to || ''));
  for (const r of statement.per_rail) {
    lines.push([st.handle || '', w, r.rail, r.orders, r.expected, r.matched, r.unmatched, r.refunded, r.disputed, r.fees, railRound2(r.matched - r.refunded - r.fees)].map(q).join(','));
  }
  const t = statement.totals;
  lines.push([st.handle || '', w, 'TOTAL', t.orders, t.expected, t.matched, t.unmatched, t.refunded, t.disputed, t.fees, t.net].map(q).join(','));
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------- merchant vetting
 * A processor will not open an account for an unvetted merchant, and a rail sold to an
 * unvetted merchant is a liability with our name on it. The checklist is deliberately short
 * and evidence-based: six answers, each of which can be shown to a partner on request.
 */
export const VET_STEPS = [
  { id: 'identity', label: 'Who the business is', why: 'Legal or trading name, and who is answerable for it.', years: 5 },
  { id: 'contact', label: 'A reachable owner', why: 'A number that answers, and where the money is collected.', years: 5 },
  { id: 'rails', label: 'Which rails they already use', why: 'We only present rails the merchant actually holds an account on.', years: 5 },
  { id: 'refunds', label: 'Their refund and dispute policy, accepted', why: 'A buyer must know how to get money back before they send any.', years: 5 },
  { id: 'records', label: 'Records kept for five years', why: 'Statements, receipts and payout references, retrievable by the merchant.', years: 5 },
  { id: 'sanctions', label: 'Sanctions / PEP screening acknowledged', why: 'Required before any cross-border leg; the processor asks for it, so we ask first.', years: 5 },
];

export function vettingPlan(st = {}, answers = {}) {
  const a = answers && typeof answers === 'object' ? answers : {};
  const steps = VET_STEPS.map((s) => {
    const v = a[s.id];
    const ok = !!(v && (v === true || (typeof v === 'object' && v.ok) || (typeof v === 'string' && v.trim().length > 1)));
    return {
      ...s, ok,
      at: v && typeof v === 'object' && v.at ? Number(v.at) : (ok ? null : null),
      evidence: v && typeof v === 'object' && v.evidence ? railClip(v.evidence, 160) : '',
    };
  });
  const missing = steps.filter((s) => !s.ok).map((s) => s.id);
  const local = ['rails', 'refunds', 'records'];
  const foreign = ['identity', 'contact', 'sanctions'];
  return {
    steps,
    ready: missing.length === 0,
    missing,
    // Two levels on purpose: a shop can take local money with the light checklist, while a
    // cross-border leg (someone else's processor, someone else's regulator) needs the full set.
    can_take_local: missing.filter((m) => local.includes(m)).length === 0,
    can_collect_cross_border: missing.filter((m) => foreign.concat(local).includes(m)).length === 0,
    note: missing.length
      ? 'Nothing here blocks a shop from taking its own money on its own rails. It blocks us from offering a cross-border leg, which is a promise made with someone else’s licence.'
      : 'Complete. Re-check yearly: a vetting that never expires is a vetting nobody maintains.',
  };
}

/* ------------------------------------------------------- refund / dispute path
 * There are no chargebacks on a manual rail, so the shop is the whole appeals process. What
 * the software owes them is a state machine that cannot lose the evidence trail, and a clock.
 */
export const REFUND_FLOW = {
  requested: ['approved', 'declined'],
  approved: ['sent', 'disputed'],
  sent: ['closed', 'disputed'],
  disputed: ['resolved', 'written_off'],
  resolved: ['closed'],
  declined: ['closed'],
  written_off: ['closed'],
  closed: [],
};

export function refundTransition(state, action) {
  const s = String(state || 'requested');
  const allowed = REFUND_FLOW[s] || [];
  if (allowed.indexOf(String(action)) < 0) {
    return { ok: false, state: s, allowed, note: 'A refund cannot jump from ' + s + ' to ' + action + '. ' + (allowed.length ? 'Allowed next: ' + allowed.join(', ') + '.' : 'This one is closed.') };
  }
  return { ok: true, state: String(action), allowed: REFUND_FLOW[String(action)] || [] };
}

/** Records retention: five years from the event, which is what a partner, a bank and a revenue
 *  authority each ask for in the markets we serve. */
export const RECORD_YEARS = 5;
export function retentionUntil(atMs, years = RECORD_YEARS) {
  const d = new Date(Number(atMs) || Date.now());
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.getTime();
}
export function retentionHolds(event, nowMs) {
  return retentionUntil(event && event.at) > (Number(nowMs) || Date.now());
}

/* ------------------------------------------------------- cross-border collect leg
 * The genuinely novel piece: an order a buyer anywhere can settle, without the seller owning a
 * foreign card facility. Two rules keep it honest and licence-free:
 *   · the processor is the counterparty and pays the merchant (we never touch the money)
 *   · the price is locked server-side; the buyer's currency is a display, not an input
 */
export const COLLECT_PROVIDERS = {
  nowpayments: {
    label: 'NOWPayments',
    // adopted from the OpenRail/CoreMerch engines, which already do this properly
    tolerance_pct: 0.01,
    settle_window_min: 15,
    price_currency: 'usd',
  },
};

export function collectInvoiceDraft(input = {}) {
  const provider = String(input.provider || 'nowpayments');
  const p = COLLECT_PROVIDERS[provider];
  if (!p) return { ok: false, error: 'unknown_provider' };
  const amount = railRound2(input.amount);
  if (!(amount > 0)) return { ok: false, error: 'amount_required' };
  const order = railClip(input.order, 60);
  if (!order) return { ok: false, error: 'order_required' };
  return {
    ok: true,
    provider,
    // price is the server's, never the cart's: Guard 6 of the engines we adopted
    payload: {
      price_amount: amount,
      price_currency: p.price_currency,
      pay_currency: railClip(input.payCurrency, 20) || undefined,
      order_id: order,
      order_description: railClip(input.description, 120) || ('Order ' + order),
      ipn_callback_url: railClip(input.ipnUrl, 300) || undefined,
      is_fee_paid_by_user: false,
    },
    tolerance_pct: p.tolerance_pct,
    expires_in_min: p.settle_window_min,
    note: 'Server-side price lock. The processor is the counterparty and pays the merchant; Tapstall holds no balance and makes no payout.',
  };
}

/** A credit is only "paid" when it meets or exceeds the locked price inside the tolerance. A
 *  short payment is flagged for a human, never silently accepted. */
export function collectSettlement({ price, paid, tolerance_pct = 0.01, status } = {}) {
  const want = railRound2(price), got = railRound2(paid);
  if (!(want > 0)) return { ok: false, reason: 'no_price', shortfall: 0 };
  const min = railRound2(want - want * Math.max(0, Math.min(0.2, num(tolerance_pct, 0.01))));
  const s = String(status || '').toLowerCase();
  if (s && ['finished', 'confirmed', 'partially_paid'].indexOf(s) < 0) return { ok: false, reason: 'not_settled', shortfall: 0 };
  if (got <= 0) return { ok: false, reason: 'nothing_paid', shortfall: want };
  if (got < min) return { ok: false, reason: 'underpaid', shortfall: railRound2(want - got) };
  return { ok: true, reason: got > want + 0.01 ? 'overpaid' : 'exact', shortfall: 0, excess: railRound2(Math.max(0, got - want)) };
}

/* ------------------------------------------------------------------ webhook proof
 * An IPN is a claim until the signature is checked. Constant-time compare, and the raw body —
 * re-serialised JSON breaks the HMAC, which is the mistake the engines we adopted had to fix.
 */
export async function hmacSha256Hex(secret, body) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(body)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (x.length !== y.length || !x.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function verifyWebhook(secret, rawBody, header) {
  if (!secret) return { ok: false, reason: 'no_secret_configured' };
  if (!header) return { ok: false, reason: 'no_signature' };
  const want = String(header).split(',').map((s) => s.trim().split('=').pop()).pop();
  const got = await hmacSha256Hex(secret, rawBody);
  const ok = timingSafeEqual(String(want).toLowerCase(), got);
  return { ok, reason: ok ? 'signed' : 'bad_signature' };
}
