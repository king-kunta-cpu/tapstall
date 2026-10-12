/**
 * Tapstall core — the pure logic (pricing, CSV/menu parsing, feed normalisation,
 * fraud flags, receipt text). Imported by worker/worker.js and unit-tested by
 * tests/core.test.mjs, so the tests run against shipped code, not a copy.
 */

/* Every rail also says what its payment *detail* looks like, because one
 * `pay_account` per shop cannot be true: the EcoCash wallet is a phone number, the
 * ZIPIT account is a bank number, PayShap is a proxy handle, and cash has nothing
 * at all. `spec` picks the shape (RAIL_SPECS below), `holder` means "the payer
 * should see this name in their confirmation" — the one check that stops a wallet
 * swap — and `till` means the rail has a merchant paybill/till some shops use
 * instead of a personal number.
 */
export const RAILS = {
  ecocash_usd: { label: 'EcoCash USD', dial: '*151#', pct: 0.014, imtt: 0.02, fixed: 0, type: 'manual', spec: 'phone', holder: true, till: true, proof: 'ask' },
  ecocash_zig: { label: 'EcoCash ZiG', dial: '*151#', pct: 0.02, imtt: 0.015, fixed: 0, type: 'manual', spec: 'phone', holder: true, till: true, proof: 'ask' },
  innbucks: { label: 'InnBucks', dial: '*155*4#', pct: 0.015, imtt: 0.02, fixed: 0, type: 'manual', spec: 'phone', holder: true, till: false, proof: 'ask' },
  onepay: { label: 'OnePay / OneMoney', dial: 'wallet app', pct: 0.015, imtt: 0.02, fixed: 0, type: 'manual', spec: 'phone', holder: true, till: false, proof: 'ask' },
  // A ZIPIT with no reference is 40 transfers a day and one amount, so the
  // built-in requires the code the bank prints: matching takes five seconds instead of
  // asking every buyer who they paid from.
  zipit: { label: 'Bank ZIPIT / RTGS', dial: 'bank app', pct: 0, imtt: 0.02, fixed: 0, type: 'manual', spec: 'bank', holder: true, till: false, proof: 'require' },
  cash: { label: 'Cash on delivery / pickup', dial: '', pct: 0, imtt: 0, fixed: 0, type: 'cod', spec: 'none', holder: false, till: false, proof: 'none' },
  payshap: { label: 'PayShap (SA)', dial: 'ShapID', pct: 0.005, imtt: 0, fixed: 0, type: 'manual', spec: 'shapid', holder: true, till: false, proof: 'ask' },
  ozow: { label: 'Ozow (SA)', dial: 'link', pct: 0.01, imtt: 0, fixed: 0, type: 'auto', spec: 'bank', holder: true, till: false, proof: 'none' },
  payfast: { label: 'PayFast card (SA)', dial: 'hosted', pct: 0.029, imtt: 0, fixed: 1.0, type: 'auto', spec: 'link', holder: false, till: true, proof: 'none' },
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
/* ------------------------------------------------ how a payment gets proven */
/**
 * A manual rail is a phone the merchant looks at, and what makes an order findable
 * in that phone is the code the buyer's app prints. Every method calls it something
 * else and needs it to a different degree: EcoCash sends an SMS with a TxID, a ZIPIT
 * transfer is untraceable without the reference the bank prints, a card through a
 * hosted gateway needs nothing from anybody because the gateway confirms it itself.
 * So the rail says how much it wants, and a merchant whose bank cannot match a
 * payment without one can require it.
 *
 * Requiring it never blocks an order. An order without proof is still money on its
 * way, and losing a sale to a form field is a worse trade than a flag on the ledger
 * row that says what is missing — that is the whole order flow in one decision.
 */
export const PROOF_MODES = {
  none:    { ask: false, label: 'No code needed — I will see it in the app' },
  ask:     { ask: true,  label: 'Ask for the code their app shows (optional)' },
  require: { ask: true,  label: 'They have to type that code before ordering' },
};
const PROOF_NOUN = {
  phone:  { word: 'code', label: 'Code from the app', hint: 'What the wallet app or the confirmation SMS shows after it sends — not the order code' },
  wallet: { word: 'TxID', label: 'Transaction ID',    hint: 'The TxID in the app’s receipt, usually 8-12 digits' },
  shapid: { word: 'reference', label: 'ShapID reference',  hint: 'The reference on the payment proof in your banking app' },
  bank:   { word: 'reference', label: 'Reference from your bank', hint: 'The reference your bank shows when the transfer goes out' },
  link:   { word: 'receipt number', label: 'Payment reference', hint: 'The receipt number on the confirmation page or email' },
  none:   { word: 'reference', label: 'Reference',    hint: 'The code on your payment confirmation' },
};
/** The number a payment came from, kept in the shape the rail needs: a wallet's is
 *  digits, a bank's is "CABS 1234567890", and mangling either into the other is how
 *  a merchant chases a payment that was always identifiable. */
export function cleanPayer(v, spec) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return '';
  // 'loose' is capture time, before anyone knows which rail this order will be
  // priced on: keep what the buyer typed, narrow it when it is printed.
  if (spec === 'loose') return t.replace(/[^A-Za-z0-9 .+\/-]/g, '').replace(/\s+/g, ' ').slice(0, 30);
  if (spec === 'bank' || spec === 'link') return t.replace(/[^A-Za-z0-9 .\/-]/g, '').replace(/\s+/g, ' ').slice(0, 30);
  return t.replace(/[^\d+]/g, '').slice(0, 16);
}
/** Letters, digits, spaces and the punctuation a real reference carries. No
 *  reshaping: a code is matched against what the bank or the SMS says, so the
 *  digits a buyer typed are the digits the merchant needs — upper-casing or
 *  stripping a dash is how a valid proof stops matching. */
export const cleanProof = (v) => String(v == null ? '' : v).trim().replace(/[^A-Za-z0-9 ._\/-]/g, '').replace(/\s+/g, ' ').slice(0, 40);
/** What a rail wants when its merchant has not said. Derived from the shapes: a
 *  hand-checked wallet or phone payment asks, a bank transfer cannot be matched
 *  without it, anything hosted confirms itself, and cash has nothing to prove. */
export const proofDefault = (type, spec) => (type === 'cod' || type === 'auto' || spec === 'none' || spec === 'link')
  ? 'none' : (spec === 'bank' ? 'require' : 'ask');
export const proofNoun = (rail) => {
  const r = rail && typeof rail === 'object' ? rail : {};
  const d = PROOF_NOUN[r.spec] || PROOF_NOUN.none;
  return { word: d.word, label: String(r.proof_label || '').trim().slice(0, 40) || d.label, hint: d.hint };
};
/**
 * The sentence a merchant sends when the money is on its way and cannot be found.
 * Written here, next to the policy it comes from, for two reasons: it depends on the
 * rail as it was frozen on the order rather than on whatever the shop's settings say
 * today, and more than one surface needs the same words (the ledger's WhatsApp
 * button, the slip a merchant copies and pastes) — a second copy of a sentence is a
 * second place to be rude in.
 */
export function proofAsk(order = {}, opt = {}) {
  const rail = (order.pricing || {}).rail;
  // No rail on the order means nothing was ever decided about proof, and inventing a
  // policy for an order that never had one is how a merchant ends up apologising for
  // a field nobody asked for.
  // A sentence needs either the policy or the shape the policy came from. A label
  // alone is neither, and writing “send the reference” about a rail we cannot read
  // is worse than saying nothing.
  if (!rail || (rail.proof == null && !rail.type && !rail.spec)) return '';
  // The slip asked, so asking again is fair, even for an order placed before a
  // merchant ever set a policy: mode falls back to the same default the slip used.
  const mode = PROOF_MODES[rail.proof] ? rail.proof : proofDefault(rail.type, rail.spec);
  if (mode === 'none') return '';
  if (cleanProof((order.buyer || {}).proof)) return '';        // they answered; nobody is chased
  const noun = proofNoun(rail);
  // `here` is a door the caller has actually minted. With it, the sentence stops
  // pointing at the chat and points at a field; without it the words are exactly
  // what they were before, because a store page has no buyer and a settled order has
  // no link, and an invented "add it here" is a dead end printed in somebody else's
  // voice. The URL is not cleaned: it is ours, already absolute, and `cleanProof`
  // would eat its colons.
  const here = (opt && typeof opt.here === 'string') ? opt.here.trim() : '';
  return mode === 'require'
    ? 'Need: ' + noun.label + ' — your app shows it right after it sends. '
      + (here ? 'Add it here and I can confirm your order today: ' + here
              : 'Send it here and I can confirm your order today.')
    : 'If your app gave you one, send the ' + noun.word + ' too — '
      + (here ? 'add it here and it goes straight on the order: ' + here
              : 'it is how I find your payment faster.');
}

/**
 * The buyer's own second chance, and the only public write in this product.
 *
 * A code arrives *after* the order: the buyer has the confirmation on their screen
 * at the moment they have it, and the merchant's ledger is the wrong place to type
 * it in. So the receipt hands out a link, and the link is a capability minted for
 * one field on one order — not a wider version of the merchant's confirm link,
 * which is the other kind of thing a leaked URL could do. Three properties, in
 * order of how much they cost to give up: it writes one field, it cannot touch
 * `status`, and it stops being usable when the order is settled.
 *
 * Three writes rather than one, because the common failure is a mistyped TxID and
 * a buyer who cannot fix their own typo will message the shop instead, which is
 * the exact traffic this feature exists to remove.
 */
export const PROOF_WINDOW_SEC = 72 * 3600;
export const PROOF_WRITES_MAX = 3;
/** The states a buyer may still write into. `paid` and `cancelled` are the shop's
 *  record of what happened, and nothing a buyer sends reopens one. */
const PROOF_OPEN = ['awaiting_payment', 'cod'];

/** Whether a buyer may still write into this order. One definition, because the page
 *  that offers the form and the machine that accepts the write must never disagree
 *  about whether a door is open. */
/**
 * Is this cap still the one the order would honour? `pcap` is the order's current
 * *nonce*: minting a link folds it in, and an accepted write rotates it, so the URL a
 * buyer was handed is worth exactly one write — which is what "single-use" has to mean
 * before it means anything. Two shapes stay honoured, and both are the upgrade path, not
 * a hole: a cap with no nonce (issued by the release before this one, still inside its
 * 72 hours) and an order with no nonce (placed before it, and bound by its first write).
 * The nonce is not a secret and is safe to store on the order — it cannot be turned into
 * a link without the Worker's signing key, which is why this does not undo the rule that
 * the buyer's URL is never written to the order document.
 */
export function proofUsed(order = {}, nonce) {
  const bound = String(order.pcap || '');
  const got = String(nonce || '');
  return !!(bound && got && bound !== got);
}

/**
 * The shop handing the field back — the one thing that makes "one link, one change" a
 * loop rather than a dead end.
 *
 * A buyer's link is spent by the write that used it, and `proofAsk` goes quiet once a code
 * is on file, so a filed code is also a *sealed* field: nothing the buyer can do reopens
 * it, and no door is minted again. That is right while the code is good and wrong the moment
 * it is not — a screenshot nobody can read, a payment reversed and re-sent, a reference from
 * the wrong wallet. So the only way back is an act of the shop, on its own authority, on the
 * route that already files a code: clear the field, and let the order ask again.
 *
 * It is not the buyer's to take. `proofAccept` refuses an empty submission from either side
 * (a blank second tap must not erase evidence), and only this function clears anything, and
 * only the merchant route calls it. `status` is still untouchable: handing back a code is not
 * un-counting money, and on a settled order the field clears while the door stays shut —
 * `withAsk` asks the order's status, not this function.
 *
 * Pure, like the rest of the state machine: it decides what a hand-back means and says it;
 * rotating the nonce and writing the row are the caller's.
 */
export function proofVoid(order) {
  const o = order && typeof order === 'object' ? order : {};
  const had = o.buyer && typeof o.buyer === 'object' ? o.buyer : {};
  const proof = cleanProof(had.proof);
  const payer = cleanPayer(had.payer, 'loose');
  const used = Number(o.proof_writes) || 0;
  if (!proof && !payer) {
    // a double tap is not an error: the second one has nothing to hand back, and the shop
    // should be told the field is already theirs rather than shown a failure
    return { ok: true, changed: false, writes: used, left: Math.max(0, PROOF_WRITES_MAX - used),
      msg: 'Nothing to hand back — that field is already empty.' };
  }
  const rail = (o.pricing || {}).rail;
  // the rail's own word, the same one the chase uses: a shop that calls it a "slip
  // number" should not be handed a sentence about a "reference" at the moment it is
  // deciding whether to trust the answer
  const noun = String(proofNoun(rail).word || 'code').toLowerCase();
  return {
    ok: true, changed: true, proof: '', payer: '', writes: 0, left: PROOF_WRITES_MAX,
    cleared: [proof, payer].filter(Boolean),
    msg: 'Handed back — the ' + noun + ' is off the order and the field is theirs again, '
      + 'with ' + PROOF_WRITES_MAX + ' changes on it.',
  };
}

export function proofOpen(order) {
  const s = (order && typeof order === 'object' ? order : {}).status;
  return !s || PROOF_OPEN.indexOf(s) >= 0;
}

/**
 * Pure, so the whole state machine is testable without a request: what may be
 * written, by whom, how often, and what to say when it may not.
 *
 * `by` is the whole difference between the two doors. A buyer's writes are bounded,
 * because the door is a URL that can end up in a group chat; the shop's are not,
 * because it is their ledger and because the most legitimate write in the file is the
 * code a buyer sent in WhatsApp after the money had already been counted. Same field,
 * same cleaning, same refusal to touch `status` — that part is not negotiable either
 * way, and it is why one function holds both doors rather than two that can drift.
 */
export function proofAccept(order, input, by) {
  const mine = by === 'merchant';
  const o = order && typeof order === 'object' ? order : {};
  const b = input && typeof input === 'object' ? input : {};
  const used = Number(o.proof_writes) || 0;
  const left = Math.max(0, PROOF_WRITES_MAX - used);
  if (!mine && !proofOpen(o)) {
    return { ok: false, why: 'settled', left, writes: used,
      msg: 'This order is already ' + o.status + ', so its record is closed. Message the shop if the code needs correcting — do not try again here.' };
  }
  const had = o.buyer && typeof o.buyer === 'object' ? o.buyer : {};
  // an absent field is "not being changed", not "being cleared": a blank second
  // submit must not be a way to erase the evidence the buyer already gave
  const proof = b.proof == null ? cleanProof(had.proof) : cleanProof(b.proof);
  const payer = b.payer == null ? cleanPayer(had.payer, 'loose') : cleanPayer(b.payer, 'loose');
  if (!proof && !payer) {
    // the same refusal, in the voice of whoever is standing at the field: a buyer is
    // told where to look, a shop is told what it failed to do, and either sentence
    // read from the wrong side is a support message
    return { ok: false, why: 'empty', left, writes: used,
      msg: mine ? 'Nothing to file — type the code they sent you.'
                : 'Type the code your app printed after the payment — that is all that is needed.' };
  }
  const changed = proof !== cleanProof(had.proof) || payer !== cleanPayer(had.payer, 'loose');
  if (!changed) {
    return { ok: true, changed: false, proof, payer, left, writes: used,
      msg: 'That is what the shop already has, so nothing was rewritten.' };
  }
  if (!mine && left <= 0) {
    return { ok: false, why: 'spent', left: 0, writes: used,
      msg: 'You have added this ' + PROOF_WRITES_MAX + ' times, which is all the order allows. Message the shop if it still needs correcting.' };
  }
  return { ok: true, changed: true, proof, payer, by: mine ? 'merchant' : 'buyer',
    left: mine ? left : left - 1, writes: mine ? used : used + 1 };
}

export function normaliseRail(def, key) {
  const d = def && typeof def === 'object' ? def : {};
  const label = String(d.label || '').trim().slice(0, 40);
  if (label.length < 2) return null;
  const pct = clamp(Number(d.pct), 0, 0.30) || 0;
  const imtt = clamp(Number(d.imtt), 0, 0.30) || 0;
  const fixed = clamp(Number(d.fixed), 0, 1000) || 0;
  const type = ['manual', 'auto', 'cod'].indexOf(d.type) >= 0 ? d.type : 'manual';
  const dial = String(d.dial || '').trim().slice(0, 40);
  const spec = RAIL_SPECS[d.spec] ? String(d.spec) : (type === 'cod' ? 'none' : 'wallet');
  const proof = PROOF_MODES[d.proof] ? String(d.proof) : proofDefault(type, spec);
  const plabel = String(d.proof_label || '').trim().slice(0, 40);
  return { key: key || 'custom', label, dial: dial || (type === 'auto' ? 'link' : 'wallet app'), pct, imtt, fixed, type,
           spec, holder: d.holder !== false && type !== 'cod', till: d.till === true,
           proof, proof_label: plabel, added: true };
}

/* ───────────────────────── the number a buyer actually needs ─────────────────
 *
 * One field called `pay_account` for a whole shop was a guess about how people
 * get paid. They do not: the EcoCash USD wallet, the ZiG wallet, the ZIPIT
 * account and the ShapID are four numbers in four shapes, and a buyer who is
 * told "send it to the account" is a buyer who sends it to the wrong one. So
 * each rail holds its own detail, validated against that rail's own shape, and
 * `pay_account` survives underneath as the fallback — no store is broken by
 * this, every store can be improved by it.
 */
export const RAIL_SPECS = {
  none:   { label: 'Nothing to pay ahead', hint: 'Cash / on delivery — no number needed', ph: '' },
  phone:  { label: 'Number buyers pay', hint: 'The number they dial from their wallet, e.g. 0771234567 or 263771234567', ph: '0771234567' },
  bank:   { label: 'Account number', hint: 'The account the transfer lands in — branch code goes in your note if you need one', ph: '1234567890' },
  shapid: { label: 'ShapID / proxy address', hint: 'Your ShapID: a number, an @handle or an ID your bank gave you', ph: '0821234567' },
  wallet: { label: 'Wallet ID', hint: 'What your wallet is called inside that app', ph: 'wallet-id' },
  link:   { label: 'Payment link or store ID', hint: 'Where buyers are sent to pay', ph: 'https://…' },
};

/** One rail's payment detail. Blank means "use the store default", which is what
 *  makes this additive: a store that never touches it keeps behaving as before.
 *  Thrown messages are deliberate — validateSettings puts them on the field, so
 *  the merchant reads "EcoCash USD: 6 to 20 digits" instead of "invalid". */
export function cleanAcct(v, specName) {
  const s = String(v == null ? '' : v).trim();
  const spec = RAIL_SPECS[specName] || RAIL_SPECS.wallet;
  if (!s) return '';
  if (specName === 'none') return '';
  if (specName === 'phone') {
    const d = s.replace(/[^\d+]/g, '');
    if (!/^\+?\d{9,15}$/.test(d)) throw new Error(spec.label.toLowerCase() + ': 9 to 15 digits, with or without a +');
    return d;
  }
  if (specName === 'bank') {
    const d = s.replace(/[\s-]/g, '');
    if (!/^\d{6,20}$/.test(d)) throw new Error(spec.label.toLowerCase() + ': 6 to 20 digits, no spaces');
    return d;
  }
  if (specName === 'link') {
    if (!/^https?:\/\/\S{4,200}$/.test(s)) throw new Error(spec.label.toLowerCase() + ': a full http(s) link');
    return s;
  }
  if (s.length > 40 || !/^[A-Za-z0-9@.:+_-]{4,40}$/.test(s)) throw new Error(spec.label.toLowerCase() + ': 4 to 40 characters');
  return s;
}
const cleanHolder = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, 40);
const cleanTill = (v) => { const s = String(v == null ? '' : v).trim().replace(/[^0-9A-Za-z-]/g, ''); return s ? s.slice(0, 20) : ''; };

/** The whole map a settings POST may carry: { ecocash_usd: {acct, holder, till} }.
 *  Unknown rails and empty rows fall away; nothing here is stored as a stray. */
export function cleanRailAccts(input, rails, railDef) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  const custom = railDef && typeof railDef === 'object' ? railDef : null;
  for (const k of Object.keys(src).slice(0, 24)) {
    const key = String(k).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
    if (!key) continue;
    // A self-described rail is validated against the shape its owner gave it —
    // "Momo Street Wallet, phone-shaped" must refuse 'abc' as a phone number, not
    // shrug because the built-in table has never heard of it.
    const info = key === 'custom' && custom ? { spec: custom.spec || 'wallet', holder: custom.holder !== false, till: custom.till === true }
      : (rails && rails[key]) || RAILS[key] || (key === 'custom' ? { spec: 'wallet', holder: true, till: true } : null);
    if (!info) continue;                                   // a rail nobody has registered is not stored
    const row = src[k] && typeof src[k] === 'object' ? src[k] : {};
    const acct = cleanAcct(row.acct != null ? row.acct : row, info.spec);
    const holder = info.holder === false ? '' : cleanHolder(row.holder != null ? row.holder : row.name);
    const till = info.till === false ? '' : cleanTill(row.till != null ? row.till : row.paybill);
    if (acct || holder || till) out[key] = { acct, holder, till };
  }
  return Object.keys(out).length ? out : undefined;
}

/** What to tell a buyer about this rail, resolved against the store. */
export function railAcctOf(st, railKey, rail) {
  const s = st || {};
  const r = rail || {};
  const row = (s.rail_accts || {})[railKey || s.rail || ''] || null;
  const spec = RAIL_SPECS[r.spec] ? r.spec : 'wallet';
  const acct = (row && row.acct) || String(s.pay_account || '').trim();
  return {
    acct,
    holder: r.holder === false ? '' : ((row && row.holder) || String(s.shop_name || '').trim()),
    till: r.till === false ? '' : ((row && row.till) || ''),
    label: (RAIL_SPECS[spec] || RAIL_SPECS.wallet).label,
    spec,
    own: !!(row && row.acct),
  };
}

/* ─────────────────────────────────── the week ────────────────────────────
 *
 * "Opening hours" as one free-text line is a decoration: the buyer cannot act on
 * "Mon-Sat mornings" at 19:40, and the merchant cannot be asked to format it. So
 * the store holds a week — seven days, each closed or a list of from/to slots —
 * and the sentence every existing surface prints is *generated* from it. Two
 * slots a day covers the split shift a Harare caterer actually runs (breakfast,
 * supper), and a close time before the open time means the slot runs past
 * midnight, which is what a shebeen and a late kitchen need.
 *
 * Both markets this runs in are UTC+2 with no daylight saving, so the local clock
 * is a constant. If a third market ever moves, this is the one line to change.
 */
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STORE_TZ_MIN = 120;

const toMin = (v) => {
  const m = String(v == null ? '' : v).trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
};
const fromMin = (n) => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');

/** Tolerant on purpose: the dashboard sends {slots:[{open,close}]}, a hand-written
 *  payload may send {open,close} or "09:00-17:00", and a day may be null, false, 0
 *  or 'closed'. What comes out is always 7 rows of null | { slots:[{o,c}] }. */
const BLANK = (x) => x == null || String(x).trim() === '';
function daySlots(v) {
  if (v == null || v === false || v === 0 || v === 'false' || v === 'closed') return null;
  const raw = Array.isArray(v) ? v : (typeof v === 'object' ? (Array.isArray(v.slots) ? v.slots : [v]) : String(v).split(/,(?=[^,]*-)/));
  const slots = [];
  for (const x of raw) {
    if (!x || x === true) continue;
    if (typeof x === 'string') {
      if (BLANK(x)) continue;
      const p = x.split(/[-–]/).map((t) => toMin(t));
      if (p.length !== 2 || p[0] == null || p[1] == null) {
        throw new Error('a time needs both ends, like 09:00 to 17:00');
      }
      slots.push({ o: p[0], c: p[1] });
      continue;
    }
    const rawO = x.open != null ? x.open : x.o, rawC = x.close != null ? x.close : (x.to != null ? x.to : x.c);
    if (BLANK(rawO) && BLANK(rawC)) continue;                  // an empty row is a closed day
    const o = toMin(rawO), c = toMin(rawC);
    // Refusing here matters: the alternative is "unreadable" falling through to
    // "nothing open", which lets one typo'd box delete a shop's whole week.
    if (o == null || c == null) throw new Error('a time needs both ends, like 09:00 to 17:00');
    if (o !== c) slots.push({ o, c });
    if (slots.length >= 2) break;
  }
  return slots.length ? { slots: slots.slice(0, 2) } : null;
}
export function cleanWeek(input) {
  const src = Array.isArray(input) ? input : (input && typeof input === 'object' ? [] : null);
  if (!src) return null;
  const out = [];
  for (let d = 0; d < 7; d++) out.push(daySlots(src[d]));
  return out.some(Boolean) ? out : undefined;
}

/** The one line every surface already prints. Runs of identical days collapse, so
 *  a normal shop reads "Mon–Fri 08:00–17:00 · Sat 08:00–13:00", not seven clauses. */
export function hoursText(week) {
  if (!week || !week.length) return '';
  const sig = (d) => (week[d] ? week[d].slots.map((s) => fromMin(s.o) + '-' + fromMin(s.c)).join(',') : '');
  const parts = [];
  let d = 0;
  while (d < 7) {
    if (!week[d]) { d++; continue; }
    let e = d;
    while (e + 1 < 7 && sig(e + 1) === sig(d)) e++;
    const span = e === d ? DAY_NAMES[d] : DAY_NAMES[d] + '–' + DAY_NAMES[e];
    parts.push(span + ' ' + sig(d).replace(/,/g, ' & '));
    d = e + 1;
  }
  const open = parts.join(' · ');
  const off = [];
  for (let k = 0; k < 7; k++) if (!week[k]) off.push(DAY_NAMES[k]);
  return open ? (open + (off.length ? ' · closed ' + off.join(' ') : '')) : 'By arrangement';
}

export const syncHours = (st) => { const t = hoursText(st && st.week); if (t && st.hours !== t) st.hours = t; return st; };

/**
 * Is the shop open right now, and if not, when does it next open?
 * Unknown is a real answer and the default: a store that never set a week is
 * open, because the alternative is silently shutting 200 shops that predate this.
 */
export function openNow(st, nowMs) {
  const s = st || {};
  const week = s.week;
  if (s.closed) return { known: true, open: false, label: 'Closed right now', next: null };
  if (!week || !week.length) return { known: false, open: true, label: '', next: null };
  const t = new Date((nowMs || Date.now()) + STORE_TZ_MIN * 60000);
  const day = (t.getUTCDay() + 6) % 7;                    // index 0 = Monday
  const m = t.getUTCHours() * 60 + t.getUTCMinutes();
  const on = (row, check) => {
    if (!row) return null;
    for (const sl of row.slots) if (check(sl)) return sl;
    return null;
  };
  // Today's own slots. A slot that closes before it opened runs past midnight, so
  // "18:00–02:00" is open at 23:00 (m >= o) and at 01:00 (m < c).
  const hit = on(week[day], (sl) => sl.c > sl.o ? (m >= sl.o && m < sl.c) : (m >= sl.o || m < sl.c));
  if (hit) {
    const ends = hit.c > hit.o ? hit.c : (m < hit.c ? hit.c : hit.c + 1440);
    return { known: true, open: true, label: 'Open until ' + fromMin(ends % 1440), left: ends - m };
  }
  // And yesterday's, if it is still running into this morning — the case a
  // late kitchen lives in, and the one a day-indexed table always forgets.
  const prev = on(week[(day + 6) % 7], (sl) => sl.c <= sl.o && m < sl.c);
  if (prev) return { known: true, open: true, label: 'Open until ' + fromMin(prev.c), left: prev.c - m, since: 'last night' };
  let best = null;
  for (let i = 0; i < 8; i++) {
    const d = (day + i) % 7, row = week[d];
    if (!row) continue;
    for (const sl of row.slots) {
      const at = i * 1440 + sl.o;
      if (at <= m) continue;
      if (!best || at < best.at) best = { at, when: fromMin(sl.o), day: i === 0 ? 'today' : (i === 1 ? 'tomorrow' : DAY_NAMES[d]) };
    }
  }
  return { known: true, open: false, in_min: best ? best.at - m : null,
           label: best ? 'Closed — opens ' + best.day + ' at ' + best.when : 'Closed' };
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

/* ------------------------------------------------------------ store images */
/**
 * A picture is not a setting. The store document is read on every storefront
 * render and every priced order, so a 120 KB blob living inside it would be
 * fetched by Cloudflare's KV on every single page view — and KV is capped at
 * 1,000 writes a day and 1 GB in total on this plan, which a document that
 * grows a photo per item would not survive.
 *
 * So the bytes go in their own key and the document holds only the path:
 * `/i/<handle>/<id>`. The storefront asks for the path, the edge caches it for
 * a year, and a photo costs one KV read per object per cache window rather than
 * one per page. 25 MiB is a KV value's ceiling, so even an untrimmed camera shot
 * fits; what decides the cap here is buyer patience on a 3G handset in Harare,
 * not the platform.
 */
export const IMG_MAX_BYTES = 200 * 1024;        // server-side refusal, generous
export const IMG_TARGET_BYTES = 120 * 1024;     // what the dashboard aims for
const IMG_ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
export const imgKeyOf = (handle, id) => 'img:' + handle + ':' + id;
export const imgRefOf = (handle, id) => '/i/' + handle + '/' + id;
/** A reference is only ever this store's own path. Accepting another handle's
 *  would be a free way to read a competitor's uploads, and rejecting it is
 *  silent because the field is a picture, not a legal document. */
export function cleanImg(v, handle) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/^https?:\/\/\S+$/i.test(s)) return s.slice(0, 400);
  const m = s.match(/^\/i\/([a-z0-9][a-z0-9-]{1,29})\/([A-Za-z0-9_-]{4,40})$/);
  if (m && handle && m[1] === String(handle) && IMG_ID_RE.test(m[2])) return m[0];
  return '';
}
/** The three kinds a phone camera or a screenshot produces, read from the bytes
 *  rather than the header the browser was asked to send. SVG is refused by name:
 *  it is a document that can run script, and on this origin that script would
 *  carry the merchant's session cookie. */
/** Every /i/ path this store's document actually points at. The delete side needs
 *  the exact inverse of that, or a merchant who swaps a picture loses the wrong one. */
export function referencedImages(st) {
  const out = new Set();
  const s = st && typeof st === 'object' ? st : {};
  const add = (v) => { if (typeof v === 'string' && v.indexOf('/i/') === 0) out.add(v); };
  add(s.logo);
  const m = s.menu && typeof s.menu === 'object' ? s.menu : {};
  for (const k of Object.keys(m.over || {})) add((m.over[k] || {}).img);
  for (const x of (Array.isArray(m.extra) ? m.extra : [])) add(x && x.img);
  return out;
}
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz09123456789_-';
export const newImgId = () => {
  const b = new Uint8Array(10);
  (globalThis.crypto || {}).getRandomValues ? globalThis.crypto.getRandomValues(b) : b.forEach((_, i) => { b[i] = Math.floor(Math.random() * 256); });
  let s = '';
  for (const x of b) s += B64URL[x % 64];
  return s;
};
/** An id is never reused, which is what lets /i/ answers be `immutable`: a new
 *  picture is a new path, so no cache anywhere has to be invalidated. */
export function sniffImage(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []);
  if (b.length < 12) return null;
  const at = (i) => b[i];
  const str = (i, n) => String.fromCharCode.apply(null, b.subarray(i, i + n));
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return { kind: 'jpeg', mime: 'image/jpeg' };
  if (at(0) === 0x89 && str(1, 3) === 'PNG' && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) {
    return { kind: 'png', mime: 'image/png' };
  }
  if (str(0, 4) === 'RIFF' && str(8, 4) === 'WEBP') return { kind: 'webp', mime: 'image/webp' };
  if (str(0, 3) === 'GIF') return { bad: 'gif', why: 'A GIF is refused: it can hold dozens of frames and a photo needs one.' };
  if (str(0, 5).indexOf('<?xml') === 0 || str(0, 4) === '<svg' || (str(0, 1) === '<' && str(0, 5).toLowerCase().indexOf('xml') > 0)) {
    return { bad: 'svg', why: 'SVG is refused because it can carry code. A photo should be a PNG or a JPEG.' };
  }
  return { bad: 'unknown', why: 'That is not a picture we know how to serve: use a JPEG, PNG or WebP.' };
}

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
    // The shape fields ride along because this object is what a slip is printed
    // from *later*, when the store may have changed its rail config: a frozen order
    // that lost "this is a phone number, ask who it came from" would stop asking.
    rail: { key: railKey, label: rail.label, dial: rail.dial, pct: rail.pct, imtt: rail.imtt, fixed: rail.fixed, type: rail.type,
            spec: rail.spec, holder: rail.holder, till: rail.till,
            // proof rides in here for the same reason spec does: the slip is printed
            // from this object later, and an order that arrived without a code still
            // has to be able to say that this rail wanted one
            proof: rail.proof || proofDefault(rail.type, rail.spec), proof_label: rail.proof_label || '' },
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
  const det = railAcctOf(st, rail.key || st.rail, rail);
  const cod = rail.type === 'cod';
  // A cash slip has nothing to pay into. Printing the shop's EcoCash number there
  // because it happens to be on file is how a buyer pays early to a wallet the
  // order was never going to be reconciled against.
  const acct = cod ? 'pay on delivery' : (det.acct || 'not set — owner must fix');
  const cur = st.currency || 'USD';
  const to = det.till ? `${acct} (till ${det.till})` : acct;
  // Printed as the buyer typed it, digits kept. A local number has no country code
  // in it and inventing one is how a merchant phones a stranger's line.
  const from = cleanPayer((order.buyer || {}).payer, det.spec);
  const proofMode = rail.proof || proofDefault(rail.type, det.spec);
  const pn = proofNoun({ spec: det.spec, proof_label: rail.proof_label });
  const proof = cleanProof((order.buyer || {}).proof);
  const steps = cod
    ? ['Nothing to pay now — pay the runner or pay at pickup.']
    : [`Open ${rail.label}${rail.dial ? ' (' + rail.dial + ')' : ''}`,
       `Send exactly ${pricing.pay_now} ${cur} to ${to}`,
       // The confirmation screen's name is the only check a buyer can make before
       // money leaves, and a wallet swap looks exactly like a valid payment.
       ...(det.holder ? [`Check it reads “${det.holder}” — if it does not, do not send`] : []),
       `Use reference: ${ref}`,
       // Said before they pay, because a code is easy to keep and impossible to
       // recover after the app has been closed — and this line costs a buyer nothing.
       ...(proofMode !== 'none' ? [`Keep the code the app shows after sending — ${pn.label.toLowerCase()} comes to this shop with it`] : [])];
  return {
    rail: rail.label, dial: rail.dial, account: acct, account_label: det.label, holder: det.holder,
    till: det.till, reference: ref, amount: pricing.pay_now, currency: cur,
    // Manual rails are the ones where "which number did he send from?" is the whole
    // reconciliation, so the buyer is asked — and the answer rides on the slip.
    ask_payer: !cod && rail.type !== 'auto' && ['phone', 'shapid', 'wallet', 'bank'].indexOf(det.spec) >= 0,
    payer_from: from,
    // what the buyer's receipt and the merchant's ledger both show, plus the two
    // words that tell a buyer where to look for it
    proof: proof, proof_mode: proofMode, proof_label: pn.label, proof_hint: pn.hint,
    // A buyer who set hours expects to be told when nobody is home to see the alert.
    hours_note: (order.hours && order.hours.open === false && order.hours.label) || '',
    note: 'Pay the EXACT amount. The odd cents are what links your payment to your order — no screenshot needed.',
    steps,
  };
}

export function riskFlags(st = {}, order = {}, hist = {}) {
  const f = [];
  if ((hist.unpaid || 0) >= 2) f.push('repeat_unpaid_buyer');
  if (order.service === 'delivery' && ((order.pricing || {}).total || 0) > (Number(st.cod_review_above) || 80)) {
    f.push('high_value_cod_review_before_sending');
  }
  const railKey = ((order.pricing || {}).rail || {}).key || st.rail;
  const has = (st.rail_accts || {})[railKey] && (st.rail_accts || {})[railKey].acct;
  if (((order.pricing || {}).rail || {}).type === 'manual' && String(st.pay_account || '').length < 6 && !has) {
    f.push('merchant_pay_account_not_set');
  }
  // Hours are never a reason to lose an order, so an order sent at 02:00 is taken
  // and marked: the merchant sees "this arrived while the shop was shut" and can
  // decide, instead of the buyer hitting a wall and going to a competitor.
  const now = order.hours && order.hours.known !== undefined ? order.hours : openNow(st);
  if (now && now.known && !now.open) f.push('sent while closed' + (now.label ? ' — ' + now.label : ''));
  // The rail wanted a code and the buyer sent none: taken, flagged, and the merchant
  // is told in one line what to ask for. Which beats refusing the order and punishing
  // the buyer for it.
  const pr = (order.pricing || {}).rail || {};
  if (pr.proof === 'require' && !cleanProof((order.buyer || {}).proof)) {
    f.push('no ' + proofNoun(pr).label.toLowerCase() + ' — ask them before sending');
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
    // The same number the buyer was shown, from the same source: a handoff message
    // that quotes the store default while the slip says the EcoCash wallet is how a
    // payment ends up in the wrong account and nobody can say why.
    (p.rail || {}).type !== 'cod' ? (() => { const d = railAcctOf(st, (p.rail || {}).key, p.rail || {});
      const pf = cleanProof((o.buyer || {}).proof);
      const py = cleanPayer((o.buyer || {}).payer, d.spec || (p.rail || {}).spec);
      return `Pay ${p.pay_now} ${cur} to ${d.acct || '—'}${d.till ? ' (till ' + d.till + ')' : ''}${py ? ' · from ' + py : ''} ref ${o.code}${pf ? ' · proof ' + pf : ''}`;
    })() : 'Paying on delivery',
    o.hours && o.hours.known && !o.hours.open ? `(sent while closed — ${o.hours.label})` : '',
    (o.buyer || {}).note ? `Note: ${o.buyer.note}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * The merchant's own notice about a new order: who, what, the flag line, and — when
 * the rail asked for a code and the order is still open — one sentence telling them a
 * buyer can file it themselves.
 *
 * The sentence is a pointer, not the link. A merchant who was handed the buyer's
 * single-field URL could type into it themselves, and the ledger's `proof_by: 'buyer'`
 * would become a claim about a hand that did not hold the phone. The row in their
 * dashboard already carries the minted door, so nothing is gained by copying one into
 * an inbox that gets forwarded.
 */
export function notifyText(st, order = {}) {
  const o = order && typeof order === 'object' ? order : {};
  const flags = (o.risk_flags || []).join(', ') || 'none';
  const ask = proofAsk(o);
  const line = ask && proofOpen(o)
    ? '\nNo ' + proofNoun((o.pricing || {}).rail).label.toLowerCase() + ' yet — the row in your ledger has a link they can paste it into, one field, nothing else it can change.'
    : '';
  return `Buyer: ${(o.buyer || {}).name || ''} (${(o.buyer || {}).phone || ''})\n${waSummary(st, o)}\nFlags: ${flags}${line}\n`;
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
export function publicStore(st, catalog, nowMs) {
  // nowMs exists so the open/closed line can be proven against a fixed clock: a test
  // that asserts what today happens to be is a test that fails on Mondays, which is
  // exactly how it was written first.
  if (!st) return null;
  const out = {};
  for (const k of PUBLIC_KEYS) if (st[k] !== undefined) out[k] = st[k];
  // The storefront previews the total before the buyer commits, so it has to do
  // the same arithmetic the worker will do on the receipt. Handing it the
  // resolved rail (label, dial, rates) is what stops a page built for Zim's
  // 3.4% quoting a Ghanaian or Bangladeshi shop a number nothing will match.
  const r = resolveRail(st, st.rail || 'cash', catalog);
  out.rail_info = { key: r.key, label: r.label, dial: r.dial, type: r.type,
                    pct: r.pct, imtt: r.imtt, fixed: r.fixed, added: !!r.added,
                    // the storefront asks for the sender's number only on rails where
                    // that is how a payment gets found, so it needs the shape here
                    spec: r.spec || 'wallet',
                    ask_payer: r.type !== 'auto' && ['phone','shapid','wallet','bank'].indexOf(r.spec || 'wallet') >= 0,
                    // and whether to ask for the app's code, what that shop calls it,
                    // and whether they will not do without it
                    proof: r.proof || proofDefault(r.type, r.spec || 'wallet'),
                    proof_label: proofNoun(r).label, proof_hint: proofNoun(r).hint };
  // The buyer needs the number for the rail this shop actually takes; the other
  // five are nobody's business on a public page. So the derived one is published
  // and `rail_accts` itself never is.
  const det = railAcctOf(st, r.key, r);
  out.pay_account = det.acct || '';
  out.pay_holder = det.holder || '';
  out.pay_till = det.till || '';
  out.open = { known: true, ...openNow(st, nowMs) };
  return out;
}

/** What the signed-in owner may learn: everything except the credentials. */
export function adminStore(st) {
  if (!st) return null;
  const { admin_token, auth_gen, admin_url, pin, feed_cache, pending, secret_hash, fw_secret, ...rest } = st;
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

/* ============================================================================
 * The merchant's key and PIN.
 *
 * The model, in the words a merchant gets: *your key is your store name, your
 * PIN is six digits, you type them once a day.* Everything else here exists to
 * make that safe, because a six-digit secret typed into a form is a different
 * animal from the 105-character links this product used before:
 *
 *   - 10^6 possibilities, and the server is an oracle. The defence is therefore
 *     the *throttle*, not the hash: Worker CPU time on the free plan is capped at
 *     10 ms per request (measured locally: PBKDF2-SHA256 costs ~4.5 ms at 10k
 *     iterations, ~60 ms at 100k), so a serious KDF is unaffordable here and
 *     `PIN_ITER` is deliberately modest. Raising it is one line on a paid plan.
 *   - Guessing is bounded per *key*, not per IP, because IP rotation is free.
 *     The counter lives in memory per isolate and is persisted only when a lock
 *     tier is *entered* — see `pinFail` in worker.js — so an attacker hammering
 *     from a thousand addresses cannot spend the tenant's 1,000 KV writes/day
 *     (which is a denial of *orders*, not just of logins) and still gets only a
 *     handful of tries per day before a 12-hour freeze.
 *   - A key that does not exist costs the same work as one that does, and answers
 *     with the same words, so the form is not a store-directory.
 *
 * The PIN is never stored in plaintext, never returned by any endpoint, never
 * logged, and never appears in a URL — the four properties that made the old
 * link scheme fragile.
 * ==========================================================================*/

export const PIN_MIN = 6;
export const PIN_MAX = 8;
export const PIN_ITER = 8000;               // measured: 2.4 ms per login, warm (see the note above)
export const PIN_NORMALIZE = (v) => String(v == null ? '' : v).replace(/[\s.-]/g, '').slice(0, PIN_MAX);
export const validPin = (v) => new RegExp('^\\d{' + PIN_MIN + ',' + PIN_MAX + '}$').test(PIN_NORMALIZE(v));

function constEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Six (or eight) digits, from the WebCrypto RNG, never a run like 000000. */
export function genPin(len = PIN_MIN) {
  const n = Math.min(PIN_MAX, Math.max(PIN_MIN, Math.floor(len) || PIN_MIN));
  for (let guard = 0; guard < 64; guard++) {
    const raw = new Uint8Array(n);
    crypto.getRandomValues(raw);
    let out = '';
    for (let i = 0; i < n; i++) out += String(raw[i] % 10);
    if (!/^(.)\1+$/.test(out) && !/0123456|1234567|2345678|3456789/.test(out)) return out;
  }
  return String(Date.now()).slice(-n);       // unreachable in practice
}

async function pbkdf2Hex(secret, salt, iters) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(String(secret)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(String(salt)), iterations: Math.max(1000, iters | 0) },
    base, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * What gets stored on the tenant. `salt` is per-store, so two shops that pick the
 * same PIN do not share a hash; `kdf`/`iters` travel with it so a raised iteration
 * count never invalidates an existing PIN, and a PIN set under a weaker setting can
 * be re-hashed on the next successful login rather than forced on anyone.
 */
export async function pinRecord(pin, opts = {}) {
  const p = PIN_NORMALIZE(pin);
  if (!validPin(p)) return null;
  const iters = Math.max(1000, Math.floor((opts && opts.iters) || PIN_ITER));
  const salt = (opts && opts.salt) || randomKey(8);
  return { v: 1, kdf: 'pbkdf2-sha256', iters, salt, hash: await pbkdf2Hex(p, salt, iters), set_at: new Date().toISOString() };
}

/** True only for the right PIN against a real record. Never throws. */
export async function pinOk(pin, rec) {
  if (!rec || !rec.hash || !rec.salt) return false;
  const got = await pbkdf2Hex(PIN_NORMALIZE(pin), rec.salt, rec.iters || PIN_ITER);
  return constEq(got, rec.hash);
}

/** A record of the right shape for a store that does not exist, so a probe costs
 *  the same milliseconds as a hit and the difference cannot be measured. */
export const PIN_GHOST = { v: 1, kdf: 'pbkdf2-sha256', iters: PIN_ITER, salt: 'tapstall-ghost-salt', hash: '0'.repeat(64) };
export async function pinMiss(pin) { await pinOk(pin, PIN_GHOST); return false; }

/* ------------------------------------------------------------ settings model */

/** Fields a merchant may change instantly: nothing here moves money or PII. */
export const SOFT_FIELDS = ['tagline', 'logo', 'location', 'hours', 'closed', 'week'];

/** Every editable field and its validator; null = rejected, undefined-safe. */
const SET = {
  shop_name: (v) => { const s = String(v || '').trim().slice(0, 60); return s.length >= 2 ? s : null; },
  tagline: (v) => String(v || '').trim().slice(0, 140),
  // a URL from anywhere, or the store's own /i/ path after an upload
  logo: (v, opts) => { const s = cleanImg(v, opts && opts.handle); return (v && !s) ? null : s; },
  location: (v) => String(v || '').trim().slice(0, 90),
  hours: (v) => String(v || '').trim().slice(0, 60),
  // `false` is a legal stored answer meaning "this store has none", which is how a
  // merchant takes a week (or a rail's number) back off the shop: a validator that
  // only ever returns a value could add but never remove.
  week: (v) => (v === '' || v === null || v === false || (Array.isArray(v) && !v.some(Boolean))) ? false : (cleanWeek(v) || false),
  rail_accts: (v, opts) => (v === '' || v === null || v === false) ? false
    : (cleanRailAccts(v, opts && opts.rails, opts && opts.rail_def) || false),
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
    // A thrown message is the merchant-facing reason, so a validator that knows
    // exactly what it wanted can say so instead of returning a bare null and
    // leaving "check the format" to cover a phone number and a webhook alike.
    try { v = SET[k](src[k], options); } catch (e) { errors[k] = String((e && e.message) || 'check the format of this field').slice(0, 140); continue; }
    if (v === undefined) continue;                          // "no change", not an error
    if (v === null) { errors[k] = 'check the format of this field'; continue; }
    if (SOFT_FIELDS.indexOf(k) >= 0) soft[k] = v; else money[k] = v;
  }
  return { ok: !Object.keys(errors).length, soft, money, errors, ignored, at: now || Date.now() };
}

/** Objects and arrays need a real comparison: `!==` on two equal weeks is always
 *  true, which would report a change on every save and let a merchant "edit" the
 *  same hours into an endless 15-minute fuse. */
const sameVal = (a, b) => a === b || (!!a && !!b && typeof a === 'object' && typeof b === 'object'
  && JSON.stringify(a) === JSON.stringify(b));

/** Write one setting, with one extra meaning: `false` is "remove it". The week is
 *  the only field that carries a derived twin, so applying it also refreshes the
 *  sentence every other surface prints. */
export function applyField(st, k, v) {
  if (v === false) delete st[k]; else st[k] = v;
  if (k === 'week') syncHours(st);
}

/** Apply the harmless fields, stage the rest. Returns counts for the response. */
export function stageSettings(st, soft, money, holdMs, now) {
  const t = now || Date.now();
  let changed = 0;
  for (const k of Object.keys(soft || {})) if (!sameVal(st[k], soft[k])) { applyField(st, k, soft[k]); changed++; }
  const pend = (st.pending && st.pending.fields) || {};
  let staged = 0;
  for (const k of Object.keys(money || {})) {
    if (sameVal(st[k], money[k]) && !(k in pend)) continue;
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
  for (const k of Object.keys(p.fields)) { applyField(st, k, p.fields[k]); applied.push(k); }
  delete st.pending;
  return { applied, pending: null };
}

/** Audit-friendly rendering: enough to recognise a change, never the value. */
export function maskField(k, v) {
  // A whole week or a map of rail accounts must not read as "[object Object]" in
  // the log a merchant is told to trust.
  if (v && typeof v === 'object') {
    if (k === 'rail_accts') { const n = Object.keys(v).length; return n ? n + ' rail' + (n > 1 ? 's' : '') + ' given a number' : '(none)'; }
    if (k === 'week') return hoursText(v) || '(cleared)';
    if (k === 'menu') return ((v.over && Object.keys(v.over).length) + (v.extra && v.extra.length) || 0) + ' edits';
    return '(set)';
  }
  if (v === false) return '(cleared)';
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

/* ─────────────────────────── the menu, owned by the store ───────────────────
 *
 * The Google Sheet stays what it is: the merchant's spreadsheet, re-read on a
 * timer. What the dashboard adds is a second layer on top of it, because the two
 * things a merchant actually wants to do at 19:00 on a Friday — "the 2L Coke is
 * gone" and "raise the half-leg to 8" — must not require opening a spreadsheet,
 * waiting for a cache, or knowing what a column is called. A row edited here wins
 * over the row it came from; everything untouched keeps coming from the sheet.
 */

export const MENU_CAP = 200;                  // items held in the store document
const MENU_ITEM = (x, opts) => {
  const o = x && typeof x === 'object' ? x : {};
  const name = String(o.name == null ? '' : o.name).trim().slice(0, 80);
  if (!name) return null;
  const id = opts && opts.forced ? String(o.id || '') : String(o.id || slug(name));
  const out = {
    id: id.slice(0, 60),
    name,
    cat: String(o.cat == null ? o.category == null ? 'Menu' : o.category : o.cat).trim().slice(0, 40) || 'Menu',
    price: round2(clamp(Number(o.price) || 0, 0, 100000)),
    cur: String(o.cur || o.currency || 'USD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6) || 'USD',
    desc: String(o.desc || '').trim().slice(0, 240),
    img: cleanImg(o.img, opts && opts.handle),
    available: o.out === true ? false : o.available === false ? false : true,
    popular: !!o.popular,
  };
  out.opts = (Array.isArray(o.opts) ? o.opts : []).slice(0, 4).map((g) => {
    const gg = g && typeof g === 'object' ? g : {};
    const label = String(gg.name || '').trim().slice(0, 40);
    const choices = (Array.isArray(gg.choices) ? gg.choices : []).slice(0, 12).map((c) => {
      const cc = c && typeof c === 'object' ? c : { label: c };
      return { label: String(cc.label == null ? '' : cc.label).trim().slice(0, 40), up: round2(clamp(Number(cc.up) || 0, 0, 10000)) };
    }).filter((c) => c.label);
    return label && choices.length ? { name: label, choices } : null;
  }).filter(Boolean);
  out.addons = (Array.isArray(o.addons) ? o.addons : []).slice(0, 8).map((a) => {
    const aa = a && typeof a === 'object' ? a : { name: a };
    const nm = String(aa.name == null ? '' : aa.name).trim().slice(0, 40);
    return nm ? { name: nm, price: round2(clamp(Number(aa.price) || 0, 0, 10000)) } : null;
  }).filter(Boolean);
  return out;
};

/** One row's worth of edits. Deliberately not MENU_ITEM: the most common edit a
 *  merchant makes is a price or a sold-out tick on a row that already has a name
 *  in the sheet, and an editor that requires the name to be resent would throw the
 *  whole edit away. Absent means "unchanged", so nothing here may default a value. */
export function sanitizeMenuEdit(input, handle) {
  const o = input && typeof input === 'object' ? input : {};
  const c = {};
  if (o.name != null && String(o.name).trim()) c.name = String(o.name).trim().slice(0, 80);
  if (o.cat != null && String(o.cat).trim()) c.cat = String(o.cat).trim().slice(0, 40);
  if (o.price != null && String(o.price).trim() !== '' && isFinite(Number(o.price))) c.price = round2(clamp(Number(o.price), 0, 100000));
  if (o.desc != null) c.desc = String(o.desc).trim().slice(0, 240);
  // '' on a field that was present means "take the picture off", which is how a
  // merchant clears an upload without editing the row's other fields.
  if (o.img != null) c.img = cleanImg(o.img, handle);
  const sold = o.out === true || o.out === 'true' || o.out === 1;
  const back = o.out === false || o.out === 'false' || o.out === 0 || o.available === true;
  if (sold) c.available = false; else if (back) c.available = true;
  if (o.popular != null) c.popular = !(o.popular === false || o.popular === 'false' || o.popular === 0);
  if (Array.isArray(o.opts)) c.opts = MENU_ITEM({ name: 'x', opts: o.opts }, {}).opts;
  if (Array.isArray(o.addons)) c.addons = MENU_ITEM({ name: 'x', addons: o.addons }, {}).addons;
  return c;
}

/** Clean a posted menu into what may be stored. Unknown shapes fall away rather
 *  than throwing: a half-typed item must not 500 a save. */
export function sanitizeMenu(input) {
  const m = input && typeof input === 'object' ? input : {};
  // `handle` rides inside the payload rather than as a second argument because the
  // dashboard posts one object, and the check that matters is "does this path
  // belong to the store saving it". An unknown handle disables refs, not URLs.
  const handle = m.handle != null && validHandle(String(m.handle)) ? String(m.handle) : '';
  const out = { over: {}, hide: [], extra: [], order: [], set_at: new Date().toISOString() };
  const over = m.over && typeof m.over === 'object' ? m.over : {};
  for (const k of Object.keys(over).slice(0, MENU_CAP)) {
    const clean = sanitizeMenuEdit(over[k], handle);
    if (Object.keys(clean).length) out.over[String(k).slice(0, 60)] = clean;
  }
  const hide = new Set((Array.isArray(m.hide) ? m.hide : []).map((x) => String(x).slice(0, 60)).filter(Boolean));
  out.hide = [...hide].slice(0, MENU_CAP);
  const seen = new Set();
  for (const x of (Array.isArray(m.extra) ? m.extra : []).slice(0, MENU_CAP)) {
    const item = MENU_ITEM(x, { handle });
    if (!item || !item.id || seen.has(item.id)) continue;
    seen.add(item.id); item.menu_item = true; out.extra.push(item);
  }
  const order = (Array.isArray(m.order) ? m.order : []).map((x) => String(x).slice(0, 60)).filter(Boolean);
  out.order = [...new Set(order)].slice(0, MENU_CAP * 2);
  if (m.note != null) out.note = String(m.note).trim().slice(0, 160);
  return out;
}

/** The store's own edits, laid over whatever the sheet returned. Read-only with
 *  respect to both inputs, because the cached sheet rows are shared. */
export function applyMenu(products, menu) {
  const m = menu && typeof menu === 'object' ? menu : {};
  const over = m.over && typeof m.over === 'object' ? m.over : {};
  const hide = new Set(Array.isArray(m.hide) ? m.hide : []);
  const base = (Array.isArray(products) ? products : []).filter((p) => p && p.id && !hide.has(p.id));
  const merged = base.map((p) => {
    const o = over[p.id];
    if (!o) return p;
    const next = { ...p };
    if (o.name) next.name = o.name;
    if (o.cat) next.cat = o.cat;
    if (isFinite(Number(o.price))) next.price = round2(Number(o.price));
    if (o.desc != null) next.desc = o.desc;
    if (o.img != null) next.img = o.img;   // '' is an order to take the picture off, not a no-op
    if (Array.isArray(o.opts) && o.opts.length) next.opts = o.opts;
    if (Array.isArray(o.addons)) next.addons = o.addons;
    if (typeof o.available === 'boolean') next.available = o.available;
    if (typeof o.popular === 'boolean') next.popular = o.popular;
    next.edited = true;
    return next;
  });
  const extras = (Array.isArray(m.extra) ? m.extra : []).filter((x) => x && x.id && !hide.has(x.id));
  let all = merged.concat(extras).slice(0, MENU_CAP);
  const order = Array.isArray(m.order) ? m.order : null;
  if (order && order.length) {
    const rank = new Map();
    order.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); });
    all = all.slice().sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 1e9) - (rank.has(b.id) ? rank.get(b.id) : 1e9));
  }
  return all;
}

/**
 * Price a cart from the menu, not from the browser.
 *
 * Until now the posted `price` was the price, which meant anyone who opened the
 * storefront's devtools could order a whole leg of lamb for a cent and be handed a
 * payment instruction for a cent — with valid unique cents, a real reference, and a
 * merchant whose whole method is "the exact amount arrived, so it is theirs". The
 * posted item is a lookup here: id first, name as the fallback. Quantity, which
 * options and which add-ons are chosen stay the buyer's; the numbers come from the
 * store. A cart built before a price change is re-priced, not refused, and the
 * difference is named on the order so the merchant can see what happened.
 */
export function menuPrice(products, items) {
  const list = Array.isArray(products) ? products.filter(Boolean) : [];
  const byId = new Map(), byName = new Map();
  for (const p of list) {
    if (p.id && !byId.has(String(p.id))) byId.set(String(p.id), p);
    const nm = String(p.name || '').toLowerCase().trim();
    if (nm && !byName.has(nm)) byName.set(nm, p);
  }
  const out = [], notes = [];
  let unknown = 0, authoritative = list.length > 0;
  for (const raw of (Array.isArray(items) ? items : []).slice(0, 40)) {
    const it = raw && typeof raw === 'object' ? raw : {};
    const key = String(it.name || '').toLowerCase().trim();
    const p = (it.id != null ? byId.get(String(it.id)) : null) || byName.get(key);
    if (!p) {
      unknown++;
      out.push({ id: String(it.id || '').slice(0, 60), name: String(it.name || 'item').slice(0, 80), price: round2(Number(it.price) || 0), qty: Math.max(1, Math.min(99, Number(it.qty) || 1)) });
      notes.push('off-menu: ' + String(it.name || 'item').slice(0, 40));
      continue;
    }
    const opts = (Array.isArray(p.opts) ? p.opts : []);
    const chosen = (Array.isArray(it.options) ? it.options : []).slice(0, opts.length + 2).map((sel) => {
      const label = String((sel && sel.label) != null ? sel.label : (sel == null ? '' : sel)).trim();
      for (const grp of opts) for (const ch of (grp && grp.choices) || []) {
        if (String(ch.label).trim() === label) return { label: ch.label, up: round2(Number(ch.up) || 0) };
      }
      return null;                                        // a choice not on the menu is worth nothing
    }).filter(Boolean);
    const addons = (Array.isArray(p.addons) ? p.addons : []);
    const picked = (Array.isArray(it.addons) ? it.addons : []).slice(0, addons.length + 2).map((x) => {
      const nm = String((x && x.name) != null ? x.name : (x == null ? '' : x)).trim();
      const hit = addons.find((a) => String(a.name).trim() === nm);
      return hit ? round2(Number(hit.price) || 0) : null;
    }).filter((v) => v != null && v > 0);
    const sentPrice = round2(Number(it.price) || 0);
    const menuPrice_ = round2(Number(p.price) || 0);
    if (sentPrice !== menuPrice_) notes.push('repriced ' + p.name + ': ' + sentPrice.toFixed(2) + ' → ' + menuPrice_.toFixed(2));
    if (p.available === false) notes.push('sold out when ordered: ' + p.name);
    out.push({
      id: p.id, name: p.name, price: menuPrice_, cur: p.cur,
      qty: Math.max(1, Math.min(99, Number(it.qty) || 1)),
      options: chosen, addons: picked,
    });
  }
  return { items: out, notes, unknown, authoritative, repriced: notes.some((n) => n.indexOf('repriced') === 0) };
}

/* ------------------------------------------------------------------ money in
 * A payment that extends a plan is the one write in this product that must not be
 * reachable by whoever asks loudest. Everything an inbound provider notice asserts is
 * decided here, in plain functions, so the rules can be read and tested:
 *   · the terms come from a record this Worker minted, never from the caller;
 *   · the provider's own signature over the fields is required, not "if configured";
 *   · the amount and the currency have to match what was asked for;
 *   · the record is spent on the first success, so a replay credits nothing twice.
 */
export const TX_WINDOW_SEC = 1800;          // the payment window: half an hour, then it is moot
export const newTxRef = (handle) => String(handle).slice(0, 30) + '-' + randomKey(12);

/** MD5 over UTF-8 bytes. Workers' WebCrypto refuses MD5, and PayFast's signature spec
 *  is MD5, so the primitive lives here and is pinned in the suite against vectors
 *  computed elsewhere — a security function nobody can check is a liability. */
export function md5Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  const len = data.length;
  const padded = new Uint8Array((((len + 8) >> 6) + 1) * 64);
  padded.set(data); padded[len] = 0x80;
  const bits = len * 8;
  for (let i = 0; i < 8; i++) padded[padded.length - 8 + i] = Math.floor(bits / Math.pow(2, 8 * i)) & 0xff;
  let a0 = 1732584193, b0 = -271733879, c0 = -1732584194, d0 = 271733878;
  const words = new Int32Array(padded.buffer);
  for (let off = 0; off < words.length; off += 16) {
    const M = words.subarray(off, off + 16);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F = 0, g = 0;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  return [a0, b0, c0, d0].map((n) => {
    let s = '';
    for (let i = 0; i < 4; i++) s += ('0' + ((n >> (i * 8)) & 0xff).toString(16)).slice(-2);
    return s;
  }).join('');
}
/**
 * The string PayFast signs: every field but `signature`, values as decoded, sorted by
 * name, `k=v` joined with `&`, and the passphrase appended as a query when there is one.
 * `keepEmpty` decides whether a field sent blank is part of what was signed — the
 * providers' own samples disagree, so verification tries both (see payfastSignedOk):
 * the choice cannot be forged either way, and getting it wrong in the strict direction
 * would silently refuse a real payment, which is the worse failure by a long way.
 */
export function payfastCanonical(fields, passphrase, keepEmpty) {
  const keys = Object.keys(fields || {}).filter((k) => k !== 'signature')
    .filter((k) => keepEmpty ? fields[k] != null : String(fields[k] == null ? '' : fields[k]) !== '')
    .sort();
  const base = keys.map((k) => k + '=' + String(fields[k] == null ? '' : fields[k])).join('&');
  const pp = String(passphrase || '');
  return pp ? base + '?passphrase=' + pp : base;
}
export function payfastSignature(fields, passphrase) {
  return md5Hex(payfastCanonical(fields, passphrase, false));
}
/** True when the notice carries a signature either reading of the spec produces. */
export function payfastSignedOk(fields, passphrase) {
  const given = String((fields || {}).signature || '');
  if (!given) return false;
  return sigEq(md5Hex(payfastCanonical(fields, passphrase, false)), given)
    || sigEq(md5Hex(payfastCanonical(fields, passphrase, true)), given);
}
/** Equal, but without letting the length or an early mismatch show: a signature check
 *  that returns on the first byte is a oracle for building one byte at a time. */
export function sigEq(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (x.length !== y.length || !x) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
/** What the minted record has to see in the notice before a plan moves: the money, in
 *  the currency we asked for, and nothing about the terms taken from the caller. */
export function txMatches(tx, fields) {
  if (!tx || typeof tx !== 'object') return { ok: false, why: 'no payment intent on file for that reference — it was spent, or it expired' };
  const want = Math.round((Number(tx.amount) || 0) * 100);
  const cur = String(tx.currency || 'USD').toUpperCase();
  const gotCur = String(fields.amount_currency || cur).toUpperCase();
  if (gotCur !== cur) return { ok: false, why: 'paid in ' + gotCur + ', this plan is priced in ' + cur };
  const got = Math.round(Number(fields.amount_gross != null ? fields.amount_gross : tx.local_cents != null ? tx.local_cents : NaN));
  const wantCents = tx.local_cents != null ? Math.round(Number(tx.local_cents)) : want;
  if (!(got > 0) || got !== wantCents) {
    return { ok: false, why: 'the amount on the notice does not match the amount that was asked for' };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ being found
 *
 * The storefront is the only page in this product that a stranger might arrive at,
 * and the arrival is almost never a search box: it is a link into a WhatsApp group,
 * a Facebook status, a X post. Those hosts do not run JavaScript to build a preview
 * — they read the bytes we send. So everything below is rendered on the server, from
 * what the store document already holds, and nothing in it is invented.
 *
 * Borrowed, deliberately, from the COREMERCH content bot's checklist (canonical,
 * OG + Twitter card with alt text, JSON-LD, a title of "what it is | who", a
 * description trimmed on a word): a page that is worth a crawl is worth a click.
 * Not borrowed: keyword density and FAQ padding — a menu is not a blog post, and a
 * fabricated Q&A is how a small site gets tagged as thin content.
 */

export const SEO_TITLE_MAX = 62;          // Google truncates near 60 characters
export const SEO_DESC_MAX = 158;          // and near 158

/** The strict set: correct in an attribute and in text, so there is one function to
 *  trust rather than two that must never be swapped. */
export const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Trim on a word, or the snippet ends mid-"orde…". Idempotent on purpose: parts are
 *  clipped before they are joined, and a mark must never stack up (“….” is what that
 *  looks like when it is not). */
function clip(s, max) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(' ');
  const head = (at > max * 0.5 ? cut.slice(0, at) : cut.slice(0, max - 1));
  const cut2 = head.replace(/[,;:.\-\s]+$/, '');
  return cut2 + (/[…?!]$/.test(cut2) ? '' : '…');    // one mark, and never a loose space before it
}
const joinBits = (parts, sep) => parts.filter((p) => p && String(p).trim()).join(sep);

/** Prices as a buyer reads them: the store's currency, no cents when there are none.
 *  The ISO code and not a symbol is the point — this page serves Harare and Johannesburg
 *  from one line of code, and "R45" would be a guess about somebody's country. */
function money(n, cur) {
  const v = round2(Number(n) || 0);
  const txt = v % 1 ? v.toFixed(2) : String(v);
  return txt + (cur ? ' ' + cur : '');
}
/** Parts joined as sentences, because a description is read aloud by a voice
 *  assistant in a car and by a snippet in search, and neither wants "field field field". */
const sentences = (parts) => {
  const keep = parts.map((p) => String(p == null ? '' : p).replace(/[.\s]+$/, '')).filter(Boolean);
  let out = '';
  for (const p of keep) out = out ? out + (/[\u2026?!]$/.test(out) ? ' ' : '. ') + p : p;
  // a part that already ends on a mark is a finished ending; a second one is a typo
  return out && !/[\u2026?!]$/.test(out) ? out + '.' : out;
};

/** Rows for the head and the structured data — the cached shelf if there is one,
 *  otherwise the dashboard's own items. `loadProducts` is never called here: a
 *  Google sheet that is slow must not be able to slow down a page's first byte. */
function shelfRows(st) {
  const cached = st && st.feed_cache && Array.isArray(st.feed_cache.products) ? st.feed_cache.products : [];
  return applyMenu(cached, st && st.menu);
}

export function seoFacts(st, origin, nowMs) {
  const s = st || {};
  const name = clip(s.shop_name || s.handle || 'A shop', 48);
  const rows = shelfRows(s);
  const open = openNow(s, nowMs);
  const cur = String(s.currency || (rows[0] && rows[0].cur) || '').toUpperCase();
  const tagline = clip(s.tagline || '', 90);
  const priced = rows.filter((p) => p && p.name && Number(p.price) > 0).slice(0, 3);
  // "three items and what they cost" is the description for a shop, not a slogan:
  // it answers the question the link was sent to answer.
  const items = priced.map((p) => clip(p.name, 26) + ' ' + money(p.price, cur)).join(', ');
  const desc = clip(sentences([
    tagline && tagline !== name ? tagline : 'Order from ' + name + ' on Tapstall — menu, prices and payment in one link',
    items ? 'From the menu: ' + items : '',
    open.known && open.label ? open.label : ''],), SEO_DESC_MAX);
  const title = (() => {
    const brand = ' | Tapstall';
    const head = clip(joinBits([name, s.location ? clip(s.location, 22) : ''], ' — '), SEO_TITLE_MAX - brand.length);
    return head + (head.length + brand.length <= SEO_TITLE_MAX ? brand : '');
  })();
  const pic = (s.logo || (rows.find((p) => p && p.img) || {}).img || '').trim();
  const base = String(origin || '').replace(/\/+$/, '');
  const url = base + '/s/' + (s.handle || '');
  const prices = rows.map((p) => Number(p && p.price)).filter((n) => n > 0);
  return {
    handle: s.handle || '', title, desc, url,
    image: pic ? base + pic : '',
    // alt text belongs to a picture: with no image on file the answer is no alt and
    // no tag, because a preview that promises a photo and shows none is worse than
    // a preview that says nothing
    imageAlt: pic ? clip(joinBits([name, s.location ? 'in ' + clip(s.location, 22) : '', rows.length ? rows.length + ' items on the menu' : ''], ', '), 150) : '',
    tagline, currency: cur,
    phone: s.whatsapp ? '+' + digits(s.whatsapp).replace(/\D/g, '') : '',
    location: clip(s.location || '', 80),
    hours: hoursText(s.week), open_label: open.known ? open.label : '', is_open: !!(open.known && open.open),
    price_range: prices.length > 1 ? (cur ? cur + ' ' : '') + round2(Math.min(...prices)) + '–' + round2(Math.max(...prices)) : '',
    item_count: rows.length,
  };
}

/** schema.org's day windows, from the same week table the page shows. */
export function weekSpec(week) {
  const rows = Array.isArray(week) ? week : [];
  const out = [];
  for (let i = 0; i < 7 && i < rows.length; i++) {
    const row = rows[i];
    if (!row || !Array.isArray(row.slots)) continue;
    for (const sl of row.slots) {
      if (!sl || !isFinite(Number(sl.o)) || !sl.c && !isFinite(Number(sl.c))) continue;
      out.push({ '@type': 'OpeningHoursSpecification', dayOfWeek: DAY_NAMES[i], opens: fromMin(Number(sl.o)), closes: fromMin(Number(sl.c)) });
    }
  }
  return out;
}

/** A @graph, because a page that describes one business with a menu describes them
 *  together; `itemListElement` counts on the merchant's own shelf, never on ours. */
export function seoJsonLd(st, f) {
  const facts = f || {};
  const biz = {
    '@type': 'LocalBusiness', '@id': facts.url + '#business',
    name: (st && st.shop_name) || facts.handle, url: facts.url, description: facts.tagline || undefined,
    telephone: facts.phone || undefined, priceRange: facts.price_range || undefined,
    image: facts.image || undefined,
  };
  if (st && st.week) biz.openingHoursSpecification = weekSpec(st.week);
  if (!biz.openingHoursSpecification || !biz.openingHoursSpecification.length) delete biz.openingHoursSpecification;
  if (facts.location) biz.areaServed = [{ '@type': 'Place', name: facts.location }];
  const rows = shelfRows(st).filter((p) => p && p.name).slice(0, 40);
  if (rows.length) {
    biz.hasMenu = {
      '@type': 'Menu', name: clip(((st && st.shop_name) || '') + ' menu', 80), url: facts.url + '#menu',
      hasMenuItem: rows.map((p) => ({
        '@type': 'MenuItem', name: clip(p.name, 80),
        description: p.desc ? clip(p.desc, 200) : undefined,
        image: p.img ? String(facts.url || '').replace(/\/s\/.*$/, '') + p.img : undefined,
        offers: {
          '@type': 'Offer', price: round2(Number(p.price) || 0).toFixed(2),
          priceCurrency: p.cur || facts.currency || 'USD',
          availability: p.available === false ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
          url: facts.url,
        },
      })),
    };
  }
  const crumb = {
    '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Tapstall', item: String(facts.url || '').replace(/\/s\/.*$/, '') + '/onboard' },
      { '@type': 'ListItem', position: 2, name: biz.name, item: facts.url },
    ],
  };
  return { '@context': 'https://schema.org', '@graph': [biz, crumb] };
}

/** The data as an embeddable tag. `<` becomes \u003c — a shop called
 *  `<script>alert(1)</script>` must not be able to close the block it is quoted in —
 *  and the rule lives here rather than in the Worker so that it can be tested at all. */
export function seoJsonLdTag(st, f) {
  return '<script type="application/ld+json">'
    + JSON.stringify(seoJsonLd(st, f)).replace(/</g, '\\u003c') + '</script>';
}

/** The head block, as bytes: what a crawler and a chat preview actually read. */
export function seoHead(f) {
  const t = escHtml(f.title || 'Tapstall store'), d = escHtml(f.desc || ''), u = escHtml(f.url || '');
  const one = (k, v) => (v ? '<meta name="' + k + '" content="' + escHtml(v) + '">' : '');
  const prop = (k, v) => (v ? '<meta property="' + k + '" content="' + escHtml(v) + '">' : '');
  return [
    '<title>' + t + '</title>',
    one('description', d),
    // max-image-preview:large is what lets search show the food at full width
    '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">',
    u ? '<link rel="canonical" href="' + u + '">' : '',
    prop('og:type', 'website'), prop('og:site_name', 'Tapstall'), prop('og:title', f.title),
    prop('og:description', f.desc), prop('og:url', f.url),
    prop('og:image', f.image), one('og:image:alt', f.imageAlt),
    one('twitter:card', f.image ? 'summary_large_image' : 'summary'), one('twitter:title', f.title),
    one('twitter:description', f.desc), one('twitter:image', f.image), one('twitter:image:alt', f.imageAlt),
  ].filter(Boolean).join('\n');
}

/** robots.txt is a *permission*, and the two things here are the app pages (a
 *  dashboard with someone's orders in it is not content) and the images, which must
 *  stay crawlable or every og:image on this platform is a broken preview. */
export const ROBOTS_TXT = (origin) => [
  'User-agent: *',
  'Allow: /s/',
  'Allow: /i/',
  'Allow: /onboard',
  'Allow: /fees',
  'Disallow: /a',
  'Disallow: /api/',
  'Disallow: /ops',
  'Disallow: /__selftest',
  'Disallow: /__ping',
  'Disallow: /fees.ics',
  'Sitemap: ' + String(origin || '').replace(/\/+$/, '') + '/sitemap.xml',
  '',
].join('\n');

/**
 * The written pages, in code rather than in a directory listing, for one reason: the
 * route, the sitemap and the footer link all have to agree about what exists, and a
 * file that is published but not listed is an orphan — the exact failure the
 * COREMERCH bot calls out in its own link graph and fixes by prioritising orphans for
 * internal links. `updated` is the date the *page* changed, which is the only
 * `lastmod` a crawler can be trusted with.
 */
export const GUIDES = [
  { slug: 'whatsapp-shop-payments', kind: 'pillar',
    title: 'Taking payment for a WhatsApp shop in Zimbabwe and South Africa',
    desc: 'What EcoCash, InnBucks, ZIPIT, PayShap, Ozow and PayFast actually cost a small seller, and how a payment gets matched to an order when the only record is a chat.',
    updated: '2026-10-12' },
  { slug: 'payment-reference-matching', kind: 'cluster',
    title: '“I paid you” is not a payment: TxIDs, ShapIDs and references',
    desc: 'Every rail prints its proof under a different name and needs it to a different degree. How a seller tells a real payment from an assertion, in five seconds, without a spreadsheet.',
    updated: '2026-10-12' },
];
export const guideOf = (slug) => GUIDES.find((g) => g.slug === slug) || null;

/** Deliberately not a list of every store. `/s/<handle>` shows that shop's payment
 *  numbers; a public file naming every handle is a harvest list of our whole
 *  customer base, and a merchant's page needs a link to be found, not our index.
 *  Store pages are crawlable and canonical — that is enough for the crawler, and
 *  it is the merchant's own sharing that supplies the link. */
export function sitemapXml(origin, extra = []) {
  const base = String(origin || '').replace(/\/+$/, '');
  const url = (loc, freq, pri, mod) => '  <url><loc>' + escHtml(base + loc) + '</loc>'
    + (mod ? '<lastmod>' + escHtml(mod) + '</lastmod>' : '')
    + '<changefreq>' + freq + '</changefreq><priority>' + pri + '</priority></url>';
  const rows = [url('/onboard', 'weekly', '1.0'), url('/', 'weekly', '0.9'), url('/fees', 'monthly', '0.5')];
  for (const g of GUIDES) rows.push(url('/guide/' + g.slug, 'monthly', '0.8', g.updated));
  for (const x of extra) rows.push(url(x.loc, x.freq || 'monthly', x.pri || '0.5', x.mod));
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + rows.join('\n') + '\n</urlset>\n';
}

/**
 * Copy a merchant can paste, generated from the store — the shape borrowed from the
 * COREMERCH bot's cross-post generator (one block per destination, a length rule per
 * destination, a CTA and the link at the end), applied to a shop instead of an article.
 *
 * It is server-side for the same reason the head is: a merchant on a prepaid handset
 * should not have to write marketing copy at 21:00 when the kitchen is quiet. And each
 * format is only as long as that platform allows, because a post truncated by the host
 * is a post with no link in it.
 */
export function shareCopy(st, f, origin) {
  const s = st || {};
  const facts = f || {};
  const base = String(origin || '').replace(/\/+$/, '');
  const url = base + '/s/' + (s.handle || '');
  const rows = shelfRows(s).filter((p) => p && p.name && Number(p.price) > 0);
  const name = clip(s.shop_name || s.handle || 'Our shop', 40);
  const where = s.location ? clip(s.location, 28) : '';
  const top = rows.slice(0, 3).map((p) => clip(p.name, 28) + ' ' + money(p.price, p.cur || facts.currency));
  const open = facts.open_label || (facts.hours ? clip(facts.hours, 48) : '');
  const rail = s.rail_info && s.rail_info.label ? s.rail_info.label : '';
  const link = url;   // each format frames it its own way; a brand word twice in a 280-char post is a word wasted

  const lead = name + (where ? ', ' + where : '');
  const wa = [lead, top.length ? 'On the menu: ' + top.join(' · ') : '', open, 'Full menu: ' + link]
    .filter(Boolean).join('\n');
  const xLine = clip(top.length ? name + ': ' + top[0] + (top[1] ? ', ' + top[1] : '') : lead, 240 - url.length - 1);
  // bullets first, then a gap, then the link: an empty line where a missing fact was
  // is how generated copy looks generated
  const fbLines = [lead + (taglineIsReal(s) ? ' — ' + clip(s.tagline, 90) : ''),
    ...top.map((t) => '• ' + t), open ? '• ' + open : '', rail ? '• We take ' + rail : ''].filter(Boolean);
  const fb = fbLines.join('\n') + '\n\n→ ' + link;
  return {
    url,
    wa: wa.slice(0, 650),
    x: (xLine + ' ' + url).slice(0, 280),
    fb: fb.slice(0, 1400),
    ig: clip(lead + (top.length ? ' — ' + top[0] + ' and more' : ''), 140) + '. Link in bio.',
    hook: clip(lead + (top.length ? ': ' + top[0] : ''), 47),
  };
}
const taglineIsReal = (s) => String((s && s.tagline) || '').trim().length > 6;

/**
 * A refused payment notice, counted per hour rather than per request.
 *
 * OpenRail posts every guard refusal to Discord, which is the right instinct and the
 * wrong cost here: this account can make 1,000 KV writes a day, and a refusal is the
 * one event a stranger can generate at will. So the ledger is one key per (hour,
 * outcome), created only if it does not exist — an attacker's busiest hour and a
 * merchant's quiet one both cost the platform at most a handful of writes, and the
 * Ops console can still answer "was anything tried, and did anything get through".
 */
export const HOOK_AUDIT_STATUSES = ['refused', 'ignored', 'already', 'activated'];
export const hookAuditKey = (hourStamp, status) => 'hooks:' + hourStamp + ':' + status;
export const hookHourStamp = (ms) => new Date(ms || Date.now()).toISOString().slice(0, 13).replace(/[-:T]/g, '');
