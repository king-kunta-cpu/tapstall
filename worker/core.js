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
  /* USDT on Tron, and only that, for the reason the method dictates: the watcher that
   * costs nothing is TronGrid's free public API (no account, no key, no per-call fee), and
   * it reads one chain. A dollar-pegged asset settles the other half of the problem — the
   * amount an order must carry — without a price oracle, which is why TRX (2% band, needs
   * a feed) and EVM chains (need a paid index or a node) stay out until there is a reason.
   * The buyer's network fee is their wallet's, not this rail's: `pct: 0`. `proof: 'ask'`
   * is the EcoCash discipline kept whole — a TxID that can be pasted into an explorer is
   * how a human confirms in ten seconds when no watcher is running; nothing here refuses
   * an order for leaving it out.
   */
  usdt_trc20: { label: 'USDT (Tron, TRC-20)', dial: 'wallet app', pct: 0, imtt: 0, fixed: 0, type: 'manual', spec: 'wallet', holder: false, till: false, proof: 'ask',
                proof_label: 'TxID from the wallet',
                proof_hint: 'The long receipt number on the transfer in your wallet app (tap it to copy) — it opens on the explorer with no login',
                crypto: { chain: 'tron', network: 'TRC-20', asset: 'USDT',
                          contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6,
                          // the OPENRAIL policy, adopted verbatim: 1% on a stable, a short
                          // payment flagged not refused, and a nightly report of the shorts
                          tolerance_pct: 0.01 } },
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
/**
 * Which rails reconcile by the sender's number. Said once, because four surfaces ask it — the
 * slip a buyer is handed, the store config the storefront obeys, the door page, and this page's
 * own fallback for a config cached before the field existed — and every one of them that keeps
 * its own copy drifts. They had already drifted: the config surface omitted a `cod` guard the
 * slip had, and the storefront's fallback recognised only two of the four shapes, so a ZIPIT or
 * a PayShap shop whose buyer held a stale config was asked for nothing where the whole
 * reconciliation is a number.
 *
 * The spec is passed in as *resolved*, by each caller, because the two sources resolve a missing
 * one differently (`det.spec` is always set; a raw rail's is not) and a helper that silently
 * defaults would quietly change what a buyer is asked. It may not do that from the inside.
 */
export const PAYER_SPECS = ['phone', 'shapid', 'wallet', 'bank'];
export function railWantsPayer(rail) {
  const r = rail && typeof rail === 'object' ? rail : {};
  if (r.type === 'cod' || r.type === 'auto') return false;   // nothing to match, or it matches itself
  return PAYER_SPECS.indexOf(r.spec) >= 0;
}

export const cleanProof = (v) => String(v == null ? '' : v).trim().replace(/[^A-Za-z0-9 ._\/-]/g, '').replace(/\s+/g, ' ').slice(0, 40);
/** What a rail wants when its merchant has not said. Derived from the shapes: a
 *  hand-checked wallet or phone payment asks, a bank transfer cannot be matched
 *  without it, anything hosted confirms itself, and cash has nothing to prove. */
export const proofDefault = (type, spec) => (type === 'cod' || type === 'auto' || spec === 'none' || spec === 'link')
  ? 'none' : (spec === 'bank' ? 'require' : 'ask');
export const proofNoun = (rail) => {
  const r = rail && typeof rail === 'object' ? rail : {};
  const d = PROOF_NOUN[r.spec] || PROOF_NOUN.none;
  return { word: d.word, label: String(r.proof_label || '').trim().slice(0, 40) || d.label,
           hint: String(r.proof_hint || '').trim().slice(0, 120) || d.hint };
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

/**
 * Who closed the door — because the sentence a buyer deserves depends on it, and nothing else.
 *
 * `used` means this link filed something and the order moved on. `superseded` means the shop
 * handed the field back (0.8.1) while this link was in somebody's pocket: the buyer did nothing,
 * the value they sent is gone by the shop's choice, and a fresh door is being minted for the
 * empty field on their next read. The two facts are told apart by the field itself: a hand-back
 * leaves `proof_void_at` and an empty `proof`, which is exactly the condition `proofAsk` uses to
 * start asking again — so the box and the sentence cannot disagree about whether there is
 * somewhere to put the code.
 *
 * It changes no capability. A superseded link writes nothing and mints nothing here, any more
 * than a spent one does: the fresh door comes from the surfaces that already mint (the receipt
 * read, the chase), never from the retired one. An old link must stay a pointer to nowhere.
 */
export function proofSuperseded(order, nonce) {
  const o = order && typeof order === 'object' ? order : {};
  if (!proofUsed(o, nonce)) return false;
  if (!o.proof_void_at) return false;
  const b = o.buyer && typeof o.buyer === 'object' ? o.buyer : {};
  return !cleanProof(b.proof) && !cleanPayer(b.payer, 'loose');
}

/**
 * The renew link is the one credential this product hands out that is not a signed
 * capability: a random token as a KV key, with no expiry of its own, opening the plan page,
 * the checkout intent and the "I paid, here is the reference" write. It is judged by the rule
 * below, not by a second opinion that can drift: minted after the last revoke, or closed. A
 * record from before any revoke stands, which is every store that never pressed Revoke.
 */
export function renewOk(rec, store) {
  if (!rec || typeof rec !== 'object' || !store) return false;
  const made = Number(rec.made) || Date.parse(String(rec.at || '')) || 0;
  return capGenOk(rec, store, { at: made ? new Date(made).toISOString() : '' });
}

/* A credential that outlives the authority which minted it is not a credential.
   `auth_gen` is the generation every session and every payment-code link is bound to;
   the one-tap confirm link was the last thing in the product that ignored it, which is
   how a merchant's *Revoke* could end sessions and code links and still leave a buyer
   holding a 72-hour write.

   A cap minted before this rule exists carries no `g`, and refusing those would strand
   every buyer who was handed a link in the last three days — that is not safety, it is a
   cliff. So a legacy cap is judged by time instead: it survives only if the order it
   points at moved *after* the revocation. `auth_gen` is '0' until a store first revokes,
   and there is no revocation for a link to be too old for. A generation we cannot read as
   a timestamp counts as one that moved: fail closed, because the alternative is guessing. */
export function capGenOk(payload, store, order) {
  const want = String((store && store.auth_gen) || '0');
  const got = payload ? payload.g : undefined;
  if (got !== undefined && got !== null && got !== '') return String(got) === want;
  const revoked = Number.parseInt(want, 36);
  // Round-trip the parse, because parseInt reads as far as it can and stops: 'zz!not36' parses
  // as 1295, and 1295 is September 1969, which would make every legacy link look fresh. A
  // generation that is not a date we can read is one that moved, and the honest answer is no.
  if (!Number.isFinite(revoked) || revoked.toString(36) !== want.toLowerCase()) return false;
  if (revoked <= 0) return true;                     // '0' means nothing has ever been revoked here
  if (revoked < 1577836800000 || revoked > 4102444800000) return false;   // 2020..2100, or it is not a date
  const stamp = (v) => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? t : 0; };
  const moved = Math.max(stamp(order && order.at), stamp(order && order.marked_at));
  return moved > revoked && moved > 0;
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

/**
 * Is this feed_url "no sheet at all"? Every shop that arrived without a real one holds
 * either nothing or a pointer to our own sample (`/data/sample-menu.csv`, or the file in
 * the zimlink/tapstall repos) — and the sample is a fixture, not a source: fetching it
 * back over a shop's own edits is what v0.9.9 stopped offering, and a shop of four fake
 * items is what this stops being. Said once, in core, because three surfaces must agree:
 * the storefront's loader, the dashboard's rows, and the SEO head. A merchant who hosts
 * their own CSV on GitHub raw keeps their feed — the rule is the sample's path, not the
 * host. (The client mirror in `admin.html` is pinned to this function by a test.)
 */
export function isPlaceholderFeed(u) {
  const s = String(u == null ? '' : u).trim();
  if (!s) return true;
  return /\/(data|pages)\/sample-menu\.csv(\?|$)/.test(s)
    || (/raw\.githubusercontent\.com\/[^/]+\/(zimlink|tapstall)\//.test(s) && /sample-menu\.csv/.test(s));
}

/** A Tron address is `T` plus 33 base58 characters, and the alphabet is missing
 *  `0`, `O`, `I`, `l` on purpose — a shape check that lets `0lIlO` through is a
 *  check that trades a buyer's USDT for a typo. The watcher refuses anything that
 *  fails this; a manual-only shop is never stopped by it, because the address is
 *  printed exactly as the merchant typed it either way. */
export const isTronAddr = (v) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(v == null ? '' : v).trim());

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
      // `vat` on the sheet is per-row on purpose: a tuckshop's mealie meal is zero-rated while its
      // cooked food is standard-rated, and a shop-wide switch would force one to be wrong.
      vat_rate: get('vat') || get('vat_rate') || '',
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
    lines.push({ name: String(it.name || 'item').slice(0, 80), qty, unit, total, vat_pct: vatLinePct(it, st) });
  }
  const delivery = service === 'delivery' ? round2(Number(st.delivery_fee) || 0) : 0;
  const freeOver = Number(st.free_over) || 0;
  const del = freeOver && itemsTotal >= freeOver ? 0 : delivery;
  const vat = vatPlan(st);
  const base = round2(itemsTotal + del);
  // A shop that quotes inclusive prices (every shelf label in a ZW tuckshop) has its VAT taken
  // OUT of the price it printed; a shop that quotes exclusive prices has it added. One number on
  // the menu, one number the buyer pays, and the difference lives here rather than in a page.
  const flat = lines.every((l) => l.vat_pct === vat.rate_pct);
  let tax = 0;
  if (vat.on) {
    if (flat) tax = vat.mode === 'incl' ? round2(base - base / (1 + vat.rate_pct / 100)) : round2(base * vat.rate_pct / 100);
    else {
      for (const l of lines) {
        if (l.vat_pct <= 0) continue;                       // zero-rated and out-of-scope lines carry no VAT
        tax = round2(tax + (vat.mode === 'incl'
          ? round2(l.total - l.total / (1 + l.vat_pct / 100))
          : round2(l.total * l.vat_pct / 100)));
      }
      if (del && vat.rate_pct > 0)
        tax = round2(tax + (vat.mode === 'incl' ? round2(del - del / (1 + vat.rate_pct / 100)) : round2(del * vat.rate_pct / 100)));
    }
  }
  const subtotal = vat.mode === 'incl' ? base : round2(base + tax);
  const mode = st.surcharge_mode === 'pass' ? 'pass' : 'absorb';
  const fee = rail.type === 'cod' ? 0 : round2(subtotal * (rail.pct || 0) + (rail.fixed || 0) + subtotal * (rail.imtt || 0));
  const total = round2(subtotal + (mode === 'pass' ? fee : 0));
  const jitter = st.unique_change === false ? 0 : (Math.abs(Math.round(total * 100)) % 97) / 100;
  return {
    lines, itemsTotal, delivery: del, tax, taxPct: vat.rate_pct, subtotal,
    // The rate and the mode ride on the order, not just the number: a shop that changes its VAT
    // registration in March must not silently re-write what January's invoice said.
    vat: { pct: vat.rate_pct, mode: vat.mode, included: vat.mode === 'incl' && vat.on,
           on: vat.on, registered: vat.registered, number: vat.number,
           net: round2(subtotal - tax) },
    // The shape fields ride along because this object is what a slip is printed
    // from *later*, when the store may have changed its rail config: a frozen order
    // that lost "this is a phone number, ask who it came from" would stop asking.
    rail: { key: railKey, label: rail.label, dial: rail.dial, pct: rail.pct, imtt: rail.imtt, fixed: rail.fixed, type: rail.type,
            spec: rail.spec, holder: rail.holder, till: rail.till,
            // proof rides in here for the same reason spec does: the slip is printed
            // from this object later, and an order that arrived without a code still
            // has to be able to say that this rail wanted one
            proof: rail.proof || proofDefault(rail.type, rail.spec), proof_label: rail.proof_label || '',
            proof_hint: rail.proof_hint || '',
            // and a chain says its own piece: contract, decimals, the tolerance the
            // watcher will apply, the network the buyer must not get wrong
            crypto: rail.crypto || null },
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
  const pn = proofNoun({ spec: det.spec, proof_label: rail.proof_label, proof_hint: rail.proof_hint });
  const proof = cleanProof((order.buyer || {}).proof);
  const cr = rail.crypto || null;
  const steps = cod
    ? ['Nothing to pay now — pay the runner or pay at pickup.']
    : cr
      // On a chain there is no name in the confirmation and no reference field on
      // the transfer — there is only the address and the amount. So the two things
      // that can end badly both get a line before money leaves: the network, and
      // the exact number whose odd cents are what makes the payment findable.
      ? [`Open your wallet app (Trust, Binance, Yellow Card, Luno — anything that holds USDT)`,
         `Send exactly ${pricing.pay_now} USDT to ${to}`,
         `Only on the ${cr.network || 'TRC-20'} (${String(cr.chain || 'tron').toUpperCase()}) network. USDT sent on any other chain is not recoverable by anybody`,
         'Send the TxID with your order if it asks — it makes the wait shorter',
         `Reference for your own records: ${ref}`]
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
    rail: rail.label, dial: rail.dial, account: acct, account_label: cr ? (cr.network || 'TRC-20') + ' address' : det.label, holder: det.holder,
    till: det.till, reference: ref, amount: pricing.pay_now, currency: cr ? (cr.asset || 'USDT') : cur,
    // Manual rails are the ones where "which number did he send from?" is the whole
    // reconciliation, so the buyer is asked — and the answer rides on the slip.
    ask_payer: railWantsPayer({ type: rail.type, spec: det.spec }),
    // the storefront prints the explorer link for a chain TxID without learning
    // what a chain is; a rail says so once, here
    crypto: cr ? { chain: cr.chain || '', network: cr.network || '', asset: cr.asset || 'USDT', tolerance_pct: cr.tolerance_pct || 0.01 } : null,
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

/* ------------------------------------------------------------------ crypto */
/** Dollars to chain units and back. USDT on Tron is six decimals, so a cent is
 *  10,000 units and the odd cents a unique-cents order carries survive the trip
 *  exactly — which is the whole reason a chain payment can be matched by amount. */
export const toUnits = (usd, decimals = 6) => Math.round((Number(usd) || 0) * Math.pow(10, Number(decimals) || 0));
export const fromUnits = (u, decimals = 6) => Math.round(Number(u) || 0) / Math.pow(10, Number(decimals) || 0);

/**
 * The tolerance policy, as pure arithmetic, in the one shape a chain allows:
 * TRC-20 transfers carry no memo and no reference field, so the amount is the
 * address book — an order's odd cents make every open total unique, and this
 * matches each transfer against the open orders and nothing else.
 *
 *  within ±tol of one open order → credit it; a short payment inside the band is
 *      credited *and* flagged, never refused (the OPENRAIL line: exact-cent is the
 *      right rule for a fixed price and the wrong one for a chain)
 *  within tol of two open orders → nothing is credited: an amount that fits two
 *      orders identifies neither, and a guess that ships someone's lunch is worse
 *      than one more row for the human
 *  a buyer typed this TxID on their order → flagged onto the order for them to
 *      count; never auto-credited on amount alone
 *  none of the above             → loose: money arrived, say so, name the amount
 *
 * A transfer is consumed once, and a second sweep that sees the same txid is a
 * replay: `credits` for an already-taken order cannot happen because a paid order
 * is not open. The caller layers the KV facts on top (txid ledger, order status);
 * this function only says who *would* match whom.
 */
export function cryptoMatch(transfers, orders, tolPct = 0.01) {
  const tol = Math.min(0.5, Math.max(0, Number(tolPct) || 0.01));
  const credits = [];
  const flags = [];
  const loose = [];
  const consumed = new Set();
  const taken = new Set();
  const open = (Array.isArray(orders) ? orders : []).filter((o) => o && o.id != null
    && o.status !== 'paid' && o.status !== 'cancelled' && Number(o.units) > 0);
  for (const t of (Array.isArray(transfers) ? transfers : [])) {
    const txid = t && t.txid != null ? String(t.txid).trim() : '';
    if (!txid || consumed.has(txid)) continue;
    const paid = Math.round(Number(t.units) || 0);
    if (paid <= 0) continue;
    const cands = [];
    for (const o of open) {
      if (taken.has(o.id)) continue;
      const band = Math.floor(Number(o.units) * tol);
      if (paid >= Number(o.units) - band && paid <= Number(o.units) + band) {
        cands.push({ o, kind: paid < o.units ? 'underpaid' : (paid > o.units ? 'overpaid' : 'exact') });
      }
    }
    if (cands.length === 1) {
      const { o, kind } = cands[0];
      taken.add(o.id); consumed.add(txid);
      credits.push({ order_id: o.id, code: o.code || '', txid, units: paid, expected_units: Number(o.units),
        shortfall_units: kind === 'underpaid' ? Number(o.units) - paid : 0, kind });
      continue;
    }
    if (cands.length > 1) {
      consumed.add(txid);
      flags.push({ txid, units: paid, at: Number(t.at) || 0, kind: 'ambiguous', order_ids: cands.map((c) => c.o.id) });
      continue;
    }
    // The buyer's typed proof is a cleanProof'd 40 characters; a chain TxID is 64 hex.
    // Compare like prefixes, not like equal strings, or the claim line is dead code in
    // production while every unit test hands it whole txids and calls it green.
    const txLower = txid.toLowerCase();
    const claimed = open.find((o) => {
      if (taken.has(o.id)) return false;
      const p = String(o.proof || '').trim().toLowerCase();
      return p.length >= 8 && (txLower.startsWith(p) || p.startsWith(txLower));
    });
    if (claimed) {
      consumed.add(txid);
      flags.push({ txid, units: paid, at: Number(t.at) || 0, order_id: claimed.id, code: claimed.code || '',
        expected_units: Number(claimed.units), kind: paid < claimed.units ? 'underpaid' : (paid > claimed.units ? 'overpaid' : 'exact') });
      continue;
    }
    loose.push({ txid, units: paid, at: Number(t.at) || 0, from: String(t.from || '').slice(0, 42) });
  }
  return { credits, flags, loose };
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
  const prVat = (o.pricing || {}).vat || {};
  return [
    `*${o.code}* — ${(o.buyer || {}).name || ''}`,
    ...lines,
    `Total *${p.pay_now}* ${cur} (${(p.rail || {}).label || 'cash'})`,
    // Printed on the slip the buyer already reads, so the receipt and the handoff message are
    // the same sentence about the same money and never have to be reconciled by hand.
    // One clause either way, worded the same in both modes: the amount of VAT *inside* the figure
    // above it. A merchant who quotes inclusive and a merchant who quotes exclusive both owe the
    // same number to the same authority, and a line that only appears in one mode is a line that
    // goes missing from a query about a sale two days later.
    prVat.on ? `of which VAT @ ${prVat.pct}%: ${(o.pricing.tax || 0).toFixed(2)}${prVat.included ? ' (already inside the price)' : ''}` : '',
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
  // VAT fields ride in the public store on purpose: a buyer who is told a price includes VAT has
  // to be able to see that claim on the page they are looking at, and a tax invoice that omits the
  // seller's VAT number is not one. Nothing secret is here — a number a shop is registered under is
  // a number a customer is entitled to ask for.
  'pay_account', 'whatsapp', 'require_optin', 'unique_change', 'order_prefix', 'reference_format',
  'rail_def',   // a merchant-described rail is buyer-facing by definition: label, dial string, fee
  'vat_registered', 'vat_rate_pct', 'vat_mode', 'vat_number', 'vat_address',
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
                    // a chain tells the storefront which network the number is on,
                    // so the warning under the pay button can be printed before the
                    // order too, not only on the receipt after it
                    crypto: r.crypto ? { chain: r.crypto.chain || '', network: r.crypto.network || '', asset: r.crypto.asset || 'USDT' } : null,
                    // the storefront asks for the sender's number only on rails where
                    // that is how a payment gets found, so it needs the shape here
                    spec: r.spec || 'wallet',
                    ask_payer: railWantsPayer({ type: r.type, spec: r.spec || 'wallet' }),
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

/**
 * Every action a capability can perform is authority, so every one of them names the
 * generation that issued it. A whitelist rather than a rule of thumb, because the cost of
 * forgetting one is the bug this prevents: a mark cap without `g` stayed a live write for
 * days after its merchant revoked it (0.8.6), and a mint site that drops the field is
 * invisible to any test that only asks the door to work. So the mint refuses instead.
 */
export const BOUND_CAP_ACTIONS = ['mark', 'proof', 'sess', 'ops'];
/* Which field carries the binding, per action, because the name is not the meaning: `mark`,
   `proof` and `sess` answer to a store's `auth_gen`, while `ops` answers to the platform's
   `ops_gen` and its `g` is a version string. A guard that only asked for `g` would have let an ops
   cap be minted with any `g` at all and called that bound, so the check is on the field that is
   actually consulted at the door. */
export const CAP_BINDING = { mark: 'g', proof: 'g', sess: 'g', ops: 'n' };
export function capBindingField(action) {
  return CAP_BINDING[String(action || '')] || null;
}
export function capNeedsGen(action) {
  return BOUND_CAP_ACTIONS.indexOf(String(action || '')) !== -1;
}

/** Signed, stateless capability: `v1.<expiry>.<payload>.<tag>`. */
export async function issueCap(secret, payload, ttlSec) {
  const field = payload && typeof payload === 'object' ? capBindingField(payload.a) : null;
  if (field && (payload[field] === undefined || payload[field] === null || payload[field] === ''))
    throw new Error('cap_unbound: ' + (/^[aeiou]/i.test(payload.a) ? 'an ' : 'a ') + payload.a
      + ' capability must carry the generation it is bound to (' + field + ')');
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
  // `vat_rate_pct` overrides the old `tax_pct` rather than replacing it: every store already on
  // this platform has its rate in `tax_pct`, and a migration that writes to a hundred stores to
  // change a name is a hundred chances to get a store wrong.
  vat_rate_pct: (v) => { if (v === '' || v == null) return null; const n = Number(v); return n >= 0 && n <= VAT_RATE_MAX ? round2(n) : null; },
  vat_mode: (v) => (String(v || '').toLowerCase() === 'incl' ? 'incl' : 'excl'),
  vat_registered: (v) => (v === true || v === 'true' || v === 1 || v === '1' || v === 'on' || v === 'yes'),
  vat_number: (v) => { const s = String(v || '').replace(/[^\w./-]/g, '').slice(0, 40); return s || null; },
  vat_address: (v) => String(v || '').trim().slice(0, 120),
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
  /* The watcher is a boolean switch, not a credential: what it can ever do is READ
   * a public chain for the address already printed to buyers, and credit an order
   * a human could have confirmed by hand. So it lives beside `require_optin`, and
   * everything it might be used *on* (the rail, the address) stays in the money
   * path with its 15-minute fuse. Off is the default; a rail with no watcher set up
   * behaves exactly as the EcoCash line does — money in, human taps. */
  crypto_watch: (v) => v === true || v === 'true' || v === 1 || v === '1',
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
    vat_rate: cleanVatRate(o.vat_rate != null ? o.vat_rate : o.vat),
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
  // `available: false` is the machine-shaped way to say sold out, and `out: true` is the way the
  // dashboard's checkbox says it: both are read, because a field that only answers to one spelling
  // is a field that silently does nothing for everyone else. (The ops console's own row editor sent
  // the first spelling, and ticked nothing off, until a test caught it here.)
  const sold = o.out === true || o.out === 'true' || o.out === 1 || o.available === false;
  const back = o.out === false || o.out === 'false' || o.out === 0 || o.available === true;
  if (sold) c.available = false; else if (back) c.available = true;
  if (o.popular != null) c.popular = !(o.popular === false || o.popular === 'false' || o.popular === 0);
  // An empty box means "back to the shop's rate", which is why this is set rather than skipped:
  // a merchant who zero-rated a row by mistake has to be able to undo it from the same box.
  if (o.vat_rate != null && String(o.vat_rate).trim() !== '') c.vat_rate = cleanVatRate(o.vat_rate);
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
  const out = { over: {}, hide: [], extra: [], order: [], del: [], set_at: new Date().toISOString() };
  const over = m.over && typeof m.over === 'object' ? m.over : {};
  for (const k of Object.keys(over).slice(0, MENU_CAP)) {
    const clean = sanitizeMenuEdit(over[k], handle);
    if (Object.keys(clean).length) out.over[String(k).slice(0, 60)] = clean;
  }
  const hide = new Set((Array.isArray(m.hide) ? m.hide : []).map((x) => String(x).slice(0, 60)).filter(Boolean));
  out.hide = [...hide].slice(0, MENU_CAP);
  /* `del` is the hard-delete list, and it exists because of the shops that have no sheet:
   * for them the authored list IS the menu, so "Hide" is a lie — there is nothing to hand
   * back. A deleted row is removed from the extras and kept here, in full, so the save that
   * deletes is also the tray the row can be picked out of again ("put it back" for a
   * moment's slip, gone for good once the tray is emptied). A caller may name an id alone;
   * it then suppresses without a restorable copy, which is all a bare id can promise.
   */
  const delSeen = new Set();
  for (const x of (Array.isArray(m.del) ? m.del : []).slice(0, MENU_CAP)) {
    const bare = x && typeof x === 'object' ? String(x.id == null ? '' : x.id).slice(0, 60) : String(x).slice(0, 60);
    if (!bare || delSeen.has(bare)) continue;
    delSeen.add(bare);
    const item = x && typeof x === 'object' && String(x.name || '').trim() ? MENU_ITEM(Object.assign({}, x, { id: bare }), { handle }) : null;
    if (item) { item.deleted = true; out.del.push(item); } else out.del.push({ id: bare });
  }
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
/**
 * Patch a store's menu without replacing it. A caller who fixes one price must not have to resend
 * every row it did not touch, or the row it forgot to resend is gone — which is how an override
 * API becomes a data-loss API. A row named with `false` or `null` is the one deliberate exception:
 * that is how a single override is taken back off.
 */
export function mergeMenuPatch(cur, patch, handle) {
  const c = cur && typeof cur === 'object' ? cur : {};
  const b = patch && typeof patch === 'object' ? patch : {};
  const over = Object.assign({}, c.over && typeof c.over === 'object' ? c.over : {});
  const src = b.over && typeof b.over === 'object' ? b.over : {};
  for (const k of Object.keys(src)) {
    const id = String(k).slice(0, 60);
    if (src[k] === false || src[k] === null) { delete over[id]; continue; }
    const clean = sanitizeMenuEdit(Object.assign({}, over[id] || {}, src[k]), handle);
    if (Object.keys(clean).length) over[id] = clean; else delete over[id];
  }
  const pick = (k) => (b[k] !== undefined ? b[k] : c[k]);
  return sanitizeMenu({
    over, hide: pick('hide'), del: pick('del'), extra: pick('extra'), order: pick('order'), note: pick('note'), handle,
  });
}

/** Is this row's picture one a person took or uploaded? Fallback art is decorative and must never
 *  be quoted as a photo — not in a crawler tag, not in a share card, not in a promise. */
export function realPhoto(p) { return p && !p.art && p.img ? String(p.img).trim() : ''; }

/** A row's VAT cell: a percent, `zero`, `exempt`, or blank for "the shop's rate". */
export function cleanVatRate(v) {
  const t = String(v == null ? '' : v).trim().toLowerCase();
  if (!t) return '';
  if (t === 'zero' || t === 'nil' || t === '0' || t === '0%') return '0';
  if (t === 'exempt' || t === 'out' || t === 'none' || t === '-') return 'exempt';
  const n = Number(t.replace(/%$/, ''));
  return Number.isFinite(n) && n >= 0 && n <= VAT_RATE_MAX ? String(round2(n)) : '';
}

/** `handle` names whose /art/ path a pictureless row draws from: the caller knows the store it
 *  just read, and the stored menu is deliberately free of that kind of detail. */
export function applyMenu(products, menu, handle) {
  const m = menu && typeof menu === 'object' ? menu : {};
  const over = m.over && typeof m.over === 'object' ? m.over : {};
  const hide = new Set(Array.isArray(m.hide) ? m.hide : []);
  // Hard deletes fall on the shop's own rows only. `hide` hands a sheet row back on revert, and a
  // `del` that suppressed the *base* would suppress a stranger too: the sample rows are numbered
  // 1, 2, 3, and so is the first page of every real sheet a shop might link the week after.
  const del = new Set((Array.isArray(m.del) ? m.del : [])
    .map((x) => (x && typeof x === 'object' ? String(x.id == null ? '' : x.id) : String(x)).slice(0, 60))
    .filter(Boolean));
  const base = (Array.isArray(products) ? products : []).filter((p) => p && p.id && !hide.has(p.id));
  const applyOver = (p) => {
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
  };
  // Sheet rows and dashboard rows take the same override map. Before this, an item added in the
  // dashboard could be deleted and added again but never corrected — a price typed twice to change
  // a price — because the merge only ever looked at the sheet's rows.
  const extras = (Array.isArray(m.extra) ? m.extra : []).filter((x) => x && x.id && !hide.has(x.id) && !del.has(x.id)).map(applyOver);
  let all = base.map(applyOver).concat(extras).slice(0, MENU_CAP);
  const order = Array.isArray(m.order) ? m.order : null;
  if (order && order.length) {
    const rank = new Map();
    order.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i); });
    all = all.slice().sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : 1e9) - (rank.has(b.id) ? rank.get(b.id) : 1e9));
  }
  // The fallback, drawn rather than photographed. It lands here because this is the one
  // function every surface reads through — storefront, feed.json, the dashboard, the mesh card —
  // so the alternative is four copies of a rule and four chances for a row to be bare in one of
  // them. Nothing stored changes: a sheet row that gains a real picture wins it back instantly.
  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    if (!p || p.img) continue;
    // A merchant who cleared the box on a row said something, and it was not "draw me a shape":
    // the store's own answer about a picture always wins, in both directions.
    const o = over[p.id];
    if (o && o.img != null) continue;
    all[i] = { ...p, img: sampleArtUrl(handle || m.handle || '', p), art: true };
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
      // the row's own VAT cell rides through, or a shop that zero-rated a staple on its sheet
      // would find it taxed at the till anyway: the menu is the authority on price *and* on rate
      vat_rate: p.vat_rate,
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
 *  Google sheet that is slow must not be able to slow down a page's first byte.
 *  A shop with no sheet has no cached shelf either: the head describes the authored
 *  menu, because anything else would put the sample's items in somebody's Google result. */
function shelfRows(st) {
  const cached = !isPlaceholderFeed(st && st.feed_url) && st && st.feed_cache && Array.isArray(st.feed_cache.products) ? st.feed_cache.products : [];
  return applyMenu(cached, st && st.menu, st && st.handle);
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
  // `realPhoto`, not `p.img`: fallback art is a picture of nothing in particular, and a social
  // preview that shows it is a claim that somebody photographed this food.
  const pic = (s.logo || realPhoto(rows.find(realPhoto)) || '').trim();
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

/* =============================================================================================
 * VAT, receipts, the books, and the mesh
 *
 * Why this section exists in one place: a tax figure, a receipt line and a ledger row are the
 * same three numbers wearing different clothes, and every one of them has to agree with the
 * others or the shop cannot hand anything to an accountant without a phone call. So the arithmetic
 * is here, it is pure, and nothing in it writes to KV — a store can be reconciled on a day its
 * write budget is spent, which is the day a shop most needs to know what it took.
 * ---------------------------------------------------------------------------------------------
 * The question this answers first ("are we issuing receipts?"): no. What existed was a message the
 * BUYER taps to send the shop (`waSummary`) and a notice emailed to the merchant when an email
 * binding is configured (it is not, on the free account this runs on). Nothing was handed to the
 * buyer, nothing was numbered, and nothing showed a tax line. `receiptText`/`receiptHtml` are that
 * artefact, derived from the order row, so a receipt exists without a single new write and without
 * depending on a binding that may not be there.
 */

export const VAT_MODES = ['excl', 'incl'];
export const VAT_RATE_MAX = 40;

/** What a store's VAT settings mean, with the old `tax_pct` read as the rate it always was. */
export function vatPlan(st) {
  const s = st && typeof st === 'object' ? st : {};
  const raw = s.vat_rate_pct != null ? s.vat_rate_pct : s.tax_pct;
  const rate = round2(Math.min(VAT_RATE_MAX, Math.max(0, Number(raw) || 0)));
  const registered = s.vat_registered === true || s.vat_registered === 'true';
  const mode = String(s.vat_mode || 'excl').toLowerCase() === 'incl' ? 'incl' : 'excl';
  return {
    on: rate > 0, rate_pct: rate, mode, registered,
    number: String(s.vat_number || '').replace(/[^\w./-]/g, '').slice(0, 40),
    // The clause a buyer needs next to a price, in the shop's own words. It never claims a
    // registration the shop has not ticked, and it never says "VAT zero-rated" for a rate of nil.
    price_note: !rate ? ''
      : mode === 'incl' ? 'Prices include VAT at ' + rate + '%.'
      : 'VAT at ' + rate + '% is added at checkout.',
  };
}

/** A line's rate: its own override when it has one, the shop's otherwise. -1 means out of scope. */
export function vatLinePct(it, stOrPlan) {
  const plan = stOrPlan && stOrPlan.rate_pct != null ? stOrPlan : vatPlan(stOrPlan);
  const v = it && typeof it === 'object' ? (it.vat_rate != null ? it.vat_rate : it.vat) : null;
  if (v == null || v === '') return plan.rate_pct;
  const t = String(v).trim().toLowerCase().replace(/%$/, '');
  if (t === 'zero' || t === 'nil' || t === '0') return 0;
  if (t === 'exempt' || t === 'out' || t === 'none') return -1;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= VAT_RATE_MAX ? round2(n) : plan.rate_pct;
}

/* ------------------------------------------------------------- the books (derived, never stored) */
const DAY_MS = 864e5;
export const BOOKS_BASES = ['cash', 'accrual'];

const dayOf = (v) => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ''; };
const periodOf = (v) => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 7) : ''; };
const inRange = (d, from, to) => !!d && (!from || d >= from) && (!to || d <= to);

/**
 * The date a row counts on, per basis: money in hand, or the day the order arrived.
 *
 * A paid row with no marked date falls back to the order date rather than dropping out of the
 * period. Rows written before this release carry no `marked_at`, and a books pack that quietly
 * omitted every one of them would tell a shop it had a good month — which is a worse error by far
 * than a payment counted a day early. `vatReturn` counts those rows as estimated, so the report
 * still says how much of itself is inferred.
 */
export function booksDate(row, basis) {
  const r = row && typeof row === 'object' ? row : {};
  if (basis === 'accrual') return dayOf(r.at);
  const stt = String(r.status || '');
  return dayOf(r.marked_at) || dayOf(r.paid_at) || (stt === 'paid' ? dayOf(r.at) : '');
}

/**
 * Every month that has rows, newest first. A picker built from the data rather than a list of
 * twelve, because a shop that started in August has nothing to file for January and showing it
 * invites a figure that has no rows behind it.
 */
export function booksPeriods(rows) {
  const seen = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const p = periodOf(r && (r.marked_at || r.at));
    const q = periodOf(r && r.at);
    if (p) seen[p] = (seen[p] || 0) + 1;
    if (q && q !== p) seen[q] = (seen[q] || 0) + 1;
  }
  return Object.keys(seen).sort().reverse().map((period) => ({ period, rows: seen[period] }));
}

/**
 * The figure a VAT vendor returns, from the ledger rows alone. Buckets by rate, because a shop
 * that zero-rates staples and standard-rates a cooked meal files two lines off one sale list.
 *
 * `estimated` counts rows written before the row carried a tax figure — those are computed from
 * the shop's *current* rate and the report says so out loud, because a return assembled from
 * guesses has to be identifiable as one. `missing` rows are counted and excluded: a report that
 * quietly ignored half of March would be worse than no report.
 */
export function vatReturn(rows, st, opt) {
  const o = opt && typeof opt === 'object' ? opt : {};
  const basis = o.basis === 'accrual' ? 'accrual' : 'cash';
  const from = String(o.from || '').slice(0, 10);
  const to = String(o.to || '').slice(0, 10);
  const plan = st ? vatPlan(st) : vatPlan({});
  const buckets = {};
  let gross = 0, vat = 0, net = 0, count = 0, estimated = 0, missing = 0, skipped = 0;
  for (const raw of Array.isArray(rows) ? rows : []) {
    if (!raw || typeof raw !== 'object') continue;
    const d = booksDate(raw, basis);
    if (!inRange(d, from, to)) continue;
    // Cash basis counts money that arrived; the accrual basis counts orders that were not called
    // off. Anything cancelled is out of both, or the shop pays tax on a sale it refunded.
    const stt = String(raw.status || '');
    if (basis === 'cash' ? stt !== 'paid' : (stt === 'cancelled' || stt === 'void' || stt === 'refunded')) { skipped++; continue; }
    count++;
    // A row that mixes a zero-rated staple with a standard-rated meal has more than one rate on
    // it, and a return filed from one figure per order would put the whole sale in the wrong
    // column. Where the row carries its buckets, the buckets are the answer.
    const by = raw.vat_by && typeof raw.vat_by === 'object' ? raw.vat_by : null;
    if (by) {
      let t = 0, g = 0;
      for (const k of Object.keys(by)) {
        const bb = by[k] || {};
        const pct2 = round2(Math.max(0, Number(k) || 0));
        const gross2 = Number(bb.gross) || 0, tax2 = Number(bb.tax) || 0;
        const dst = buckets[String(pct2)] || (buckets[String(pct2)] = { rate_pct: pct2, gross: 0, vat: 0, net: 0, count: 0 });
        dst.gross = round2(dst.gross + gross2); dst.vat = round2(dst.vat + tax2);
        dst.net = round2(dst.net + (gross2 - tax2)); dst.count++;
        t = round2(t + tax2); g = round2(g + gross2);
      }
      gross = round2(gross + g); vat = round2(vat + t); net = round2(net + (g - t));
      continue;
    }
    let pct = Number(raw.vat_pct);
    let tax = Number(raw.tax);
    if (!Number.isFinite(tax) || !Number.isFinite(pct)) {
      if (!Number.isFinite(Number(raw.total))) { missing++; continue; }
      estimated++;
      pct = plan.on ? plan.rate_pct : 0;
      tax = plan.on ? (plan.mode === 'incl'
        ? round2(Number(raw.total) - Number(raw.total) / (1 + pct / 100))
        : round2(Number(raw.total) * pct / 100)) : 0;
    }
    const key = String(round2(Math.max(0, pct)));
    const b = buckets[key] || (buckets[key] = { rate_pct: round2(Math.max(0, pct)), gross: 0, vat: 0, net: 0, count: 0 });
    b.gross = round2(b.gross + Number(raw.total) || 0);
    b.vat = round2(b.vat + tax);
    b.net = round2(b.net + (Number(raw.total) - tax));
    b.count++;
    gross = round2(gross + Number(raw.total));
    vat = round2(vat + tax);
    net = round2(net + (Number(raw.total) - tax));
  }
  return {
    basis, from: from || null, to: to || null,
    gross, vat, net, count, estimated, missing, skipped,
    rates: Object.keys(buckets).sort((x, y) => Number(y) - Number(x)).map((k) => buckets[k]),
    // What the shop owes before its own input claims, which this product cannot see and will not
    // invent: the sheet hands this figure over and the claim goes in against it.
    due_before_inputs: vat,
    registered: plan.registered, vat_number: plan.number, mode: plan.mode,
  };
}

/** The whole month (or any window) as one object the dashboard prints and the CSV repeats. */
/** The VAT buckets a priced order carries, as one small object per rate. Frozen with the order. */
export function vatBuckets(pr) {
  const p = pr || {};
  const out = {};
  const add = (pct, gross, tax) => {
    const k = String(round2(Math.max(0, Number(pct) || 0)));
    const b = out[k] || (out[k] = { gross: 0, tax: 0, count: 0 });
    b.gross = round2(b.gross + (Number(gross) || 0));
    b.tax = round2(b.tax + (Number(tax) || 0));
    b.count++;
  };
  const lines = Array.isArray(p.lines) ? p.lines : [];
  if (!lines.length) return null;
  for (const ln of lines) {
    const pct = Number(ln.vat_pct);
    if (!Number.isFinite(pct) || pct <= 0) { add(0, ln.total, 0); continue; }
    const incl = p.vat && p.vat.mode === 'incl';
    const tax = incl ? round2(Number(ln.total) - Number(ln.total) / (1 + pct / 100)) : round2(Number(ln.total) * pct / 100);
    add(pct, ln.total, incl ? tax : round2(Number(ln.total) - tax) === Number(ln.total) ? tax : tax);
  }
  if (p.delivery) {
    const d = vatPlan(p.vat ? { vat_rate_pct: p.taxPct, vat_mode: (p.vat || {}).mode } : {});
    add(d.rate_pct, p.delivery, d.on ? (d.mode === 'incl' ? round2(Number(p.delivery) - Number(p.delivery) / (1 + d.rate_pct / 100)) : round2(Number(p.delivery) * d.rate_pct / 100)) : 0);
  }
  return Object.keys(out).length ? out : null;
}

export function booksSummary(rows, st, opt) {
  const o = opt && typeof opt === 'object' ? opt : {};
  const basis = o.basis === 'accrual' ? 'accrual' : 'cash';
  const period = String(o.period || '').slice(0, 7);
  const from = o.from || (period ? period + '-01' : '');
  const to = o.to || (period ? new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0))
    .toISOString().slice(0, 10) : '');
  const win = { basis, from, to };
  const vat_fig = vatReturn(rows, st, win);
  const list = Array.isArray(rows) ? rows : [];
  let awaiting = 0, cod = 0, cash_in = 0, rounding = 0, flagged = 0, proofs = 0, open = 0, paid = 0, cancelled = 0;
  const by_rail = {};
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const d = booksDate(r, basis);
    const mine = inRange(d, from, to);
    const stt = String(r.status || '');
    if (stt === 'paid') paid++; else if (stt === 'cancelled' || stt === 'void') cancelled++; else open++;
    // The balance is counted outside the window on purpose. An order that has not been paid has no
    // cash-basis date at all, so a period filter would report "nothing outstanding" to the shop
    // with the most money owed to it — and a balance is not a monthly figure in any case.
    if (stt === 'awaiting_payment' || stt === 'new' || stt === 'preparing' || stt === 'cod') {
      awaiting = round2(awaiting + (Number(r.total) || 0));
      if (String(r.rail || '') === 'cod' || stt === 'cod' || stt === 'new') cod = round2(cod + (Number(r.total) || 0));
    }
    if (!mine) continue;
    if (stt === 'paid') {
      const rail = String(r.rail || 'other');
      by_rail[rail] = round2((by_rail[rail] || 0) + Number(r.total || 0));
      cash_in = round2(cash_in + Number(r.paid || r.total || 0));
    }
    rounding = round2(rounding + Math.max(0, (Number(r.pay_now) || 0) - (Number(r.total) || 0)));
    if ((r.flags || []).length) flagged++;
    if (r.proof || r.payer) proofs++;
  }
  return {
    period: period || null, from: from || null, to: to || null, basis,
    orders: list.length, paid, cancelled, open,
    vat: vat_fig, collected: cash_in,
    // named as balances, because that is what they are: money not yet in hand, from any month
    outstanding_balance: awaiting, outstanding_cod: cod,
    rounding_identifiers: rounding, flagged, with_proof: proofs,
    money_in_by_rail: Object.keys(by_rail).sort().map((k) => ({ rail: k, amount: by_rail[k] })),
    // The honest footer: what this page cannot know, said on the page rather than in a footnote.
    note: 'Sales side only. Input VAT on what the shop bought is not in these rows and is not guessed here.',
  };
}

const csvCell = (v) => {
  const t = String(v == null ? '' : v);
  return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
};

/**
 * The accountant pack: metadata as `#` lines, then one row per order, then the totals the report
 * was built from. It is the same numbers as the panel, in the file an accountant opens, so nobody
 * re-keys anything — which is the whole reason this exists.
 */
export function booksCsv(rows, st, opt) {
  const s = booksSummary(rows, st, opt);
  const shop = st || {};
  const head = [
    '# tapstall books pack',
    '# shop: ' + String(shop.shop_name || shop.handle || '') + ' (' + (shop.handle || '') + ')',
    '# period: ' + (s.from || 'start') + ' .. ' + (s.to || 'today') + '   basis: ' + s.basis,
    '# currency: ' + (shop.currency || 'USD'),
    '# vat: ' + (s.vat.registered ? 'registered, no. ' + (s.vat.vat_number || 'not on file') : 'not registered')
      + ', mode ' + s.vat.mode + ', rate ' + s.vat.rates.map((b) => b.rate_pct + '%').join('/') + ' of nil',
    '# ' + s.note,
  ];
  if (s.vat.estimated) head.push('# ' + s.vat.estimated + ' row(s) predate the tax fields and were computed at the current rate');
  if (s.vat.missing) head.push('# ' + s.vat.missing + ' row(s) had no readable amount and are excluded');
  const cols = ['date', 'ref', 'status', 'buyer', 'phone', 'service', 'rail', 'gross', 'vat', 'net',
    'pay_now', 'rounding', 'payer_sent_from', 'proof', 'flags'];
  const body = [cols.join(',')];
  for (const r of (Array.isArray(rows) ? rows : []).slice().sort((x, y) => String(x && (x.marked_at || x.at) || '').localeCompare(String(y && (y.marked_at || y.at) || '')))) {
    if (!r || typeof r !== 'object') continue;
    const d = booksDate(r, s.basis);
    if (!inRange(d, s.from || '', s.to || '')) continue;
    const gross = Number(r.total) || 0;
    const tax = Number.isFinite(Number(r.tax)) ? Number(r.tax) : '';
    body.push([
      d || dayOf(r.at), r.code || r.id || '', r.status || '', r.name || '', r.phone || '', r.service || '',
      r.rail || '', gross.toFixed(2), tax === '' ? '' : tax.toFixed(2),
      tax === '' ? '' : round2(gross - tax).toFixed(2),
      Number(r.pay_now) ? Number(r.pay_now).toFixed(2) : '', r.rounding || '',
      r.payer || '', r.proof || '', (r.flags || []).join('|'),
    ].map(csvCell).join(','));
  }
  const tot = ['# totals',
    '# gross,' + s.vat.gross.toFixed(2) + ',vat,' + s.vat.vat.toFixed(2) + ',net,' + s.vat.net.toFixed(2),
    '# collected,' + s.collected.toFixed(2) + ',outstanding_balance,' + s.outstanding_balance.toFixed(2)
      + ',of which cash on delivery,' + s.outstanding_cod.toFixed(2),
    '# orders_in_window,' + s.vat.count + ',skipped_not_counted,' + s.vat.skipped].join('\n');
  return head.join('\n') + '\n' + body.join('\n') + '\n' + tot + '\n';
}

/* --------------------------------------------------------------------- the receipt, at last */
const money2 = (v, cur) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '0.00') + (cur ? ' ' + cur : '');

/**
 * The receipt as text, because in this market the paper is a WhatsApp message. Same numbers the
 * ledger row holds, so the buyer's message and the shop's books cannot disagree; a VAT number
 * appears only when the shop says it is registered, since printing one that was never issued is
 * how a receipt becomes a problem.
 */
export function receiptText(st, o) {
  const s = st || {}, ord = o || {}, pr = ord.pricing || {};
  const cur = s.currency || pr.rail && pr.rail.cur || 'USD';
  const v = pr.vat || { pct: pr.taxPct || 0, on: (pr.taxPct || 0) > 0, included: false, net: round2((pr.subtotal || 0) - (pr.tax || 0)) };
  const paid = Number(pr.pay_now || pr.total || 0);
  // `pricing.lines` is what the till computed; the order's own `items` are what the buyer asked
  // for. The two agree on names and quantities, but only the first carries the unit and line
  // totals, and a receipt drawn from the second prints 0.00 beside a total of 115.00 — which is
  // exactly what this did the first time it was tested end to end against a real order row.
  const shown = (pr.lines && pr.lines.length ? pr.lines : (ord.items || [])).map((it) => {
    const unit = it.unit != null ? it.unit : it.price;
    const tot = it.total != null ? it.total : round2((Number(unit) || 0) * (it.qty || 1));
    return (it.qty || 1) + 'x ' + it.name
      + (round2(Number(unit)) !== round2(Number(tot)) ? ' @ ' + money2(unit, '') : '') + '  ' + money2(tot, '');
  });
  const out = [
    (v.registered && v.number ? '*TAX INVOICE* — ' : '*RECEIPT* — ') + (s.shop_name || s.handle || ''),
    s.vat_address ? 'Address: ' + s.vat_address : (s.location ? s.location : ''),
    'Receipt ' + (ord.code || '') + (ord.code ? '' : ' (unnumbered draft)'),
    'Date: ' + dayOf(ord.marked_at || ord.at) + '  Time: ' + String(ord.marked_at || ord.at || '').slice(11, 16),
    'For: ' + String((ord.buyer || {}).name || 'buyer') + ((ord.buyer || {}).phone ? ' (' + (ord.buyer || {}).phone + ')' : ''),
    (ord.items || []).length ? 'Items:' : '',
    ...shown,
    (pr.vat && pr.vat.mode === 'incl')
      ? 'Total (VAT at ' + (v.pct || 0) + '% included)  ' + money2(pr.total, cur)
      : (v.on ? 'Net ' + money2(v.net, pr.cur || cur) + '\nVAT @ ' + (v.pct || 0) + '%  ' + money2(pr.tax, pr.cur || cur) + '\nTotal  ' + money2(pr.total, pr.cur || cur)
              : 'Total  ' + money2(pr.total, pr.cur || cur)),
    pr.delivery ? 'Of which delivery: ' + money2(pr.delivery, cur) : '',
    paid && Math.abs(paid - Number(pr.total)) >= 0.005
      ? 'Paid: ' + money2(paid, cur) + ' (the odd cents identify your transfer; change as usual)'
      : (paid ? 'Paid: ' + money2(paid, cur) : ''),
    pr.rail ? 'Method: ' + (pr.rail.label || pr.rail.key) : '',
    (ord.buyer && ord.buyer.proof) ? 'Our reference: ' + ord.buyer.proof : '',
    v.registered ? 'VAT No: ' + (v.number || 'on file') : 'This shop is not VAT-registered; no VAT is charged.',
    'Kept by ' + (s.shop_name || s.handle || 'the shop') + ' · ' + (s.handle ? 'tapstall/s/' + s.handle : ''),
  ];
  return out.filter(Boolean).join('\n');
}

/** The same document, printable: an A5 block that becomes a clean PDF from the browser's own print. */
export function receiptHtml(st, o) {
  const s = st || {}, ord = o || {}, pr = ord.pricing || {};
  const v = pr.vat || {};
  const esc2 = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const cur = s.currency || 'USD';
  const rowLines = (pr.lines && pr.lines.length ? pr.lines : (ord.items || []));
  const rows = rowLines.map((it) => {
    const unit = it.unit != null ? it.unit : it.price;
    const tot = it.total != null ? it.total : round2((Number(unit) || 0) * (it.qty || 1));
    return '<tr><td>' + esc2((it.qty || 1) + 'x ' + it.name
      + ((it.addons || []).length ? ' +' + it.addons.length + ' extra' : '')) + '</td><td class=n>' + esc2(Number(unit || 0).toFixed(2))
      + '</td><td class=n>' + esc2(Number(tot || 0).toFixed(2)) + '</td></tr>';
  }).join('');
  const taxline = v.on
    ? '<tr><td>' + (v.included ? 'VAT @ ' + esc2(v.pct) + '% included' : 'VAT @ ' + esc2(v.pct) + '%') + '</td><td></td><td class=n>'
      + esc2(Number(pr.tax || 0).toFixed(2)) + '</td></tr>' : '';
  return '<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">'
    + '<title>Receipt ' + esc2(ord.code || '') + ' · ' + esc2(s.shop_name || s.handle) + '</title><style>'
    + 'body{font:14px/1.5 system-ui;margin:0;background:#f4f6f8;color:#16202b}'
    + '.doc{max-width:38rem;margin:3vh auto;background:#fff;padding:1.4rem 1.5rem;border:1px solid #dde4ea;border-radius:8px}'
    + 'h1{font-size:1.05rem;margin:.1rem 0 .1rem}h2{font-size:.78rem;letter-spacing:.06em;text-transform:uppercase;color:#65788b;margin:.1rem 0 .8rem;font-weight:600}'
    + 'table{width:100%;border-collapse:collapse;margin:.4rem 0}td{padding:.24rem 0;border-bottom:1px solid #eef2f6;vertical-align:top}'
    + '.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;padding-left:.8rem}'
    + '.tot td{border:0;font-weight:700}.meta{color:#41525f;font-size:.85rem}.foot{margin-top:.9rem;color:#65788b;font-size:.8rem}'
    + '@media print{body{background:#fff}.doc{border:0;border-radius:0;margin:0;padding:0}button{display:none}}</style>'
    + '<div class=doc><h1>' + esc2(s.shop_name || s.handle) + '</h1>'
    + '<h2>' + (v.registered && v.number ? 'Tax invoice' : 'Receipt') + '</h2>'
    + '<p class=meta>' + esc2(s.vat_address || s.location || '') + (s.whatsapp ? ' · ' + esc2(s.whatsapp) : '')
    + (v.registered && v.number ? '<br>VAT No ' + esc2(v.number) : '')
    + '<br>Receipt <b>' + esc2(ord.code || '—') + '</b> · ' + esc2(dayOf(ord.marked_at || ord.at))
    + ' · ' + esc2(String((ord.buyer || {}).name || '')) + '</p>'
    + '<table><tr><td class=meta>Item</td><td class=n>Unit</td><td class=n>Amount</td></tr>' + rows
    + (pr.delivery ? '<tr><td>Delivery</td><td></td><td class=n>' + esc2(Number(pr.delivery).toFixed(2)) + '</td></tr>' : '')
    + taxline
    + '<tr class=tot><td>Total</td><td></td><td class=n>' + esc2(Number(pr.total || 0).toFixed(2)) + ' ' + esc2(cur) + '</td></tr></table>'
    + (pr.unique_change ? '<p class=meta>Paid ' + esc2(Number(pr.pay_now).toFixed(2)) + ' — the odd ' + esc2(Number(pr.unique_change).toFixed(2))
      + ' identifies this transfer; change as usual.</p>' : '')
    + (pr.fee_absorbed_by_merchant ? '<p class=meta>Payment fee carried by the shop: ' + esc2(Number(pr.fee_absorbed_by_merchant).toFixed(2)) + '.</p>' : '')
    + '<p class=foot>' + (v.registered ? 'This is a tax invoice for the amount above.' : 'This shop is not VAT-registered, so no VAT is shown.')
    + ' Figures come from the order as it was priced, not from the shop\'s settings today.</p>'
    + '<button onclick="print()">Print or save as PDF</button></div>';
}

/* ----------------------------------------------------------------- sample art (zero storage) */
/**
 * A picture for a row that has none, drawn from the row. Served as a file rather than a data URI
 * so a 60-item menu does not grow 20 KB of markup on every load, and cached forever because the
 * URL carries everything that draws it. It is deliberately abstract: a photographic stand-in for a
 * dish nobody has photographed would be a false claim about food, which is the one thing a menu
 * must not do.
 */
export function sampleArtUrl(handle, item) {
  const name = String((item && item.name) || 'item').slice(0, 60);
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const cur = (item && item.cur) || '';
  return '/art/' + encodeURIComponent(String(handle || 'shop').slice(0, 30)) + '/' + (h % 100000)
    + '.svg?n=' + encodeURIComponent(name) + (cur ? '&c=' + encodeURIComponent(String(cur).slice(0, 8)) : '');
}
const ART_PALETTES = [['#F4EEE4', '#8A6B3F'], ['#E9F1EC', '#3E6B52'], ['#EDEDF6', '#4A4C86'], ['#F6EBE9', '#8C4A45'],
  ['#EAF2F7', '#2F5D7C'], ['#F4F0E6', '#6B6142'], ['#F0EEE8', '#5C5548'], ['#ECF3F1', '#356B62']];
/** The SVG itself: two initials, a tint, and a rule. No fonts, no network, no lie. */
export function sampleArtSvg(name) {
  const n = String(name || 'item').replace(/[<>]/g, '').slice(0, 60);
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  const pal = ART_PALETTES[h % ART_PALETTES.length];
  const words = n.split(/[\s·,]+/).filter(Boolean);
  const ini = ((words[0] || '').charAt(0) + (words.length > 1 ? (words[1] || '').charAt(0) : (words[0] || '').charAt(1) || '')).toUpperCase();
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" role="img" aria-label="'
    + n.replace(/"/g, '') + '">'
    + '<rect width="96" height="96" rx="10" fill="' + pal[0] + '"/>'
    + '<rect x="10" y="66" width="76" height="1" fill="' + pal[1] + '" opacity=".5"/>'
    + '<text x="48" y="56" text-anchor="middle" font-family="system-ui,sans-serif" font-size="30" font-weight="600" fill="' + pal[1] + '">'
    + (ini || '•') + '</text></svg>';
}

/* ============================================================ the content distribution mesh */
/* Adapted from the mesh this house already runs for its other product (hunta-marketing,
 * scripts/expand_bible.py, 2026-10-01): a registry of what there is to say, a planner that gates
 * cadence and a value-to-promo ratio, one renderer per rail, witnesses that report only new
 * failures, and hard budgets pinned in tests. Three things change on the way here, and each change
 * is the point. (1) The registry is the shop's own live menu, so nothing has to be authored and
 * nothing can be invented: no item name, no price and no claim appears that is not in the row today
 * — Hunta's editor rejected "hype and fabricated stats"; ours has no author model at all, so a
 * figure that cannot be sourced is dropped rather than smoothed. (2) There is no posting: the rails
 * are surfaces a merchant already has, and the output is copy-paste text plus one tap, because the
 * alternative is a token to guard and a ban to fear. (3) The state is optional: a plan derived from
 * the date needs no write, so a shop whose day of KV writes is spent still gets a queue, and
 * "already posted" is a memory the merchant chooses to record.
 */
export const MESH_RAILS = {
  whatsapp_status: { label: 'WhatsApp status', max: 130, tap: 'link' },
  whatsapp_group:  { label: 'a WhatsApp or Telegram group', max: 300, tap: 'link' },
  facebook_group:  { label: 'a Facebook group', max: 500, tap: 'link' },
  x:               { label: 'X', max: 240, tap: 'link' },
  instagram:       { label: 'an Instagram caption', max: 900, tap: 'hashtag' },
  counter:         { label: 'the notice by the till', max: 150, tap: 'none' },
};
export const MESH_BUDGET = { per_day: 3, value: 2, promo: 1, item_cooldown_days: 7 };
export const MESH_KINDS = ['value', 'promo'];

const clipText = (t, n) => { const x = String(t || '').trim(); return x.length <= n ? x : x.slice(0, Math.max(0, n - 1)).trimEnd() + '…'; };

/** Does the shop have a right to say this today? A broken feed prices nothing. */
export function meshWitness(st, products, facts) {
  const f = facts || {}, s = st || {}, list = Array.isArray(products) ? products : [];
  const fails = [];
  if (s.feed_error && String(s.feed_error) !== 'no_feed') fails.push({ key: 'feed', note: 'the menu could not be read (' + s.feed_error + '), so no price is quoted' });
  if (!list.length) fails.push({ key: 'empty', note: 'no items to publish, so nothing is drafted' });
  if (!s.hours && !f.hours_text) fails.push({ key: 'hours', note: 'no opening line on file, so the queue says nothing about when you are open' });
  if (!s.whatsapp) fails.push({ key: 'contact', note: 'no buyer number on file, so a post cannot say where to write' });
  return { price_ok: list.length > 0 && !(s.feed_error && String(s.feed_error) !== 'no_feed'), fails };
}

/**
 * Today's queue: at most `per_day` beats, the ratio gate applied (value first, one promo at most),
 * each beat about one real thing, and an item that was used inside the cooldown never repeated.
 * Deterministic on the date: two loads of the same day show the same plan, which is what makes it
 * testable and what stops a shop from being shown a roulette wheel.
 */
export function meshPack(st, products, facts, opt) {
  const o = opt || {}, now = o.now || Date.now();
  const s = st || {}, list = (Array.isArray(products) ? products : []).filter((p) => p && p.name);
  const base = String(o.origin || '').replace(/\/+$/, '');
  const url = base + '/s/' + (s.handle || '');
  const day = Math.floor(now / DAY_MS);
  const iso = new Date(now).toISOString().slice(0, 10);
  const seen = o.sent && o.sent.items && typeof o.sent.items === 'object' ? o.sent.items : {};
  const wd = MESH_BUDGET.item_cooldown_days;
  const keyOf = (x) => String((x && (x.id || x.name)) || '').slice(0, 80);
  const fresh = (id) => { const d = seen[id]; return !d || (day - Math.floor(Date.parse(d) / DAY_MS)) >= wd; };
  const wit = meshWitness(st, list, facts);
  const openLine = (facts && (facts.open_label || facts.hours_text)) || (s.hours ? clipText(s.hours, 48) : '');
  const beats = [];
  const pool = list.slice().sort((a, b) => (Number(!!b.popular) - Number(!!a.popular)) || String(a.name).localeCompare(String(b.name)));
  const pick = (dayOffset) => {
    for (let i = 0; i < pool.length; i++) {
      const p = pool[(day + dayOffset + i) % pool.length];
      if (p && fresh(String(p.id || p.name))) return p;
    }
    return pool.length ? pool[(day + dayOffset) % pool.length] : null;
  };
  const money = (n, cur) => (Number(n) || 0).toFixed(2) + ' ' + (cur || (facts && facts.currency) || s.currency || 'USD');
  if (wit.price_ok && pool.length) {
    const a = pick(0);
    beats.push({ id: 'item:' + (a.id || a.name) + ':v1', kind: 'value', rail: 'whatsapp_status',
      item: String(a.name).slice(0, 60), item_key: keyOf(a), price: Number(a.price) || 0,
      text: clipText((a.popular ? 'The one people keep ordering: ' : '') + a.name + ' — ' + money(a.price, a.cur)
        + (openLine ? '. ' + openLine : '') + '. ' + url, MESH_RAILS.whatsapp_status.max) });
    const b = pick(1);
    beats.push({ id: 'item:' + (b.id || b.name) + ':v2', kind: 'value', rail: 'facebook_group',
      item: String(b.name).slice(0, 60), item_key: keyOf(b), price: Number(b.price) || 0,
      text: clipText((s.shop_name || 'Our shop') + ' has ' + b.name + ' at ' + money(b.price, b.cur)
        + (s.location ? ', in ' + s.location : '') + (openLine ? '. Open: ' + openLine : '')
        + (s.whatsapp ? '. Order on WhatsApp ' + s.whatsapp : '') + '. ' + url, MESH_RAILS.facebook_group.max) });
    beats.push({ id: 'promo:' + (a.id || a.name), kind: 'promo', rail: 'x', item: String(a.name).slice(0, 60), item_key: keyOf(a),
      price: Number(a.price) || 0,
      text: clipText(a.name + ' ' + money(a.price, a.cur)
        + (facts && facts.closed_today ? ' — closed today' : (openLine ? ' · ' + openLine : '')) + ' ' + url, MESH_RAILS.x.max) });
  } else {
    beats.push({ id: 'notice:no-prices', kind: 'value', rail: 'whatsapp_status',
      text: clipText((s.shop_name || 'Our shop') + ' is taking orders — write to us on WhatsApp'
        + (s.whatsapp ? ' ' + s.whatsapp : '') + ' and we will confirm the price with you.' + (url ? ' ' + url : ''), 160),
      why: wit.fails.map((f) => f.key).join(',') });
  }
  const out = beats.filter((x) => x && x.text).slice(0, MESH_BUDGET.per_day);
  const promos = out.filter((x) => x.kind === 'promo').length;
  if (promos > MESH_BUDGET.promo) while (out.filter((x) => x.kind === 'promo').length > MESH_BUDGET.promo) {
    const i = out.map((x) => x.kind).lastIndexOf('promo'); if (i < 0) break; out.splice(i, 1);
  }
  return { day: iso, url, beats: out, fails: wit.fails,
    budget: { per_day: MESH_BUDGET.per_day, value: MESH_BUDGET.value, promo: MESH_BUDGET.promo, cooldown_days: wd } };
}

/** The public half: what a machine may repeat about this shop, and nothing it may not. */
export function meshJson(st, products, facts, origin) {
  const s = st || {}, f = facts || {};
  const base = String(origin || '').replace(/\/+$/, '');
  const wit = meshWitness(s, products, f);
  return {
    shop: String(s.shop_name || s.handle || '').slice(0, 60),
    handle: String(s.handle || '').slice(0, 30),
    url: base + '/s/' + (s.handle || ''),
    tagline: clipText(s.tagline || '', 140),
    location: clipText(s.location || '', 90),
    hours: f.closed ? 'closed' : clipText(f.hours_text || s.hours || '', 90),
    whatsapp: s.whatsapp ? String(s.whatsapp).replace(/\D/g, '').slice(0, 15) : '',
    currency: s.currency || 'USD',
    vat_registered: !!(f.vat && f.vat.registered),
    prices_included: !!(f.vat && f.vat.included),
    // The point of the flag: a reader can tell "this shop has no prices today" from "this feed is
    // broken", and a publisher can refuse to quote the difference.
    priced: wit.price_ok,
    items: wit.price_ok ? (Array.isArray(products) ? products : []).filter((p) => p && p.name).slice(0, 60)
      .map((p) => ({ name: String(p.name).slice(0, 60), price: round2(Number(p.price) || 0),
                     currency: p.cur || s.currency || 'USD', sold_out: p.available === false,
                     popular: !!p.popular, url: base + '/s/' + (s.handle || '') })) : [],
    generated_at: new Date().toISOString(),
    terms: 'Facts about a shop, generated from the shop. Prices are the shop\'s own and move; quote them with the store link, not as a promise.',
  };
}

/** The one write the mesh can make: "the merchant says they posted these". */
export function meshMark(prev, ids, nowMs) {
  const t = nowMs || Date.now();
  const iso = new Date(t).toISOString();
  const day = iso.slice(0, 10);
  const items = (prev && prev.items) || {};
  const sent = (prev && prev.sent) || {};
  for (const id of (Array.isArray(ids) ? ids : []).slice(0, 40)) {
    if (!id) continue;
    items[String(id).slice(0, 80)] = day;
    sent[String(id).slice(0, 80)] = day;
  }
  const kept = {};
  for (const k of Object.keys(items).sort().reverse().slice(0, 400)) kept[k] = items[k];
  return { at: iso, items: kept, sent: kept, count: Object.keys(kept).length };
}

/* ------------------------------------------------------------ the ledger row
 *
 * A row used to live in its own key — `list:<handle>`, a JSON array holding the shop's last 200
 * orders — and every write to an order meant read-modify-write of that whole array. Three things
 * were wrong with that, and only one of them was cost.
 *
 * Two buyers ordering in the same second each read the array, each unshifted their own order, and
 * the slower write won: the other order stayed a document with no row, invisible in the dashboard
 * and missing from the month's books. Nothing retried it, because nothing knew. It was also five
 * subrequests per order (doc, list read, list write, then on a mark: list read, list write) and a
 * 150 ms×4 wait whenever a just-written list had not reached the edge you were standing on — the
 * `mirrorRow` loop, whose comment promised "the ledger keeps pace, or tries to". Trying was the
 * problem: a failed mirror was silent, and a shop that cannot see an order concludes the platform
 * lost their money.
 *
 * So the row is now *metadata on the order document*. KV gives metadata back from `list()` beside
 * the key, so the index is the key space: one write per order, per mark, per correction, and there
 * is no second copy to lose the race with. It is capped at 1,024 bytes by the platform, which is
 * the only real constraint here and why `packRow` shrinks on purpose instead of failing: a
 * merchant's 900-character proof note must not cost them a ledger row. What survives the shrink is
 * the money, because the money is what the books are read for.
 *
 * `list:<handle>` is not deleted and not written again — the frozen legacy index keeps supplying any
 * id that predates this change, so no shop needs a migration and no migration can half-run.
 */
export const ROW_META_CAP = 1000;           // the platform allows 1024; a hundred bytes of air
export const MAX_ORDERS_KEPT = 200;

/** The row for an order document, in the long form every consumer already reads. */
export function orderRow(o) {
  const p = (o && o.pricing) || {};
  const v = p.vat || {};
  return {
    id: o.id, code: o.code, at: o.at, status: o.status, total: p.total,
    name: (o.buyer && o.buyer.name) || '', phone: (o.buyer && o.buyer.phone) || '',
    service: o.service, flags: o.risk_flags,
    payer: (o.buyer && o.buyer.payer) || '', proof: (o.buyer && o.buyer.proof) || '',
    prior_unpaid: o.prior_unpaid,
    // the money split, frozen at order time rather than recomputed from the shop's settings today
    tax: p.tax || 0, net: v.net != null ? v.net : 0, vat_pct: v.pct || 0, vat_mode: v.mode || 'excl',
    vat_by: vatBuckets(p) || undefined,
    pay_now: p.pay_now, rounding: p.unique_change || 0,
    fee: p.fee || 0, fee_absorbed: p.fee_absorbed_by_merchant || 0,
    rail: p.rail && p.rail.key,
    // the ledger mints the buyer's link from the row, so the row has to know the current nonce
    pcap: o.pcap || '',
    marked_at: o.marked_at || null, proof_at: o.proof_at || '', proof_by: o.proof_by || '',
  };
}

/* Short keys, because 1,024 bytes is the whole budget for a row. `unpackRow` is the only place
 * that knows the mapping, so nothing downstream reads a one-letter field. */
const ROW_K = {
  id: 'i', code: 'c', at: 'a', status: 's', total: 't', name: 'n', phone: 'p', service: 'v',
  flags: 'f', payer: 'y', proof: 'r', prior_unpaid: 'u', tax: 'x', net: 'e', vat_pct: 'q',
  vat_mode: 'm', vat_by: 'b', pay_now: 'w', rounding: 'g', fee: 'd', fee_absorbed: 'o',
  rail: 'l', pcap: 'k', marked_at: 'z', proof_at: 'h', proof_by: 'j',
};

/** Shrink a row into the metadata budget, giving up the words before the numbers. */
export function packRow(row) {
  const r = Object.assign({}, row || {});
  const out = {};
  for (const k of Object.keys(ROW_K)) {
    if (r[k] === undefined || r[k] === null || r[k] === '' || (Array.isArray(r[k]) && !r[k].length)) continue;
    out[ROW_K[k]] = r[k];
  }
  const size = () => JSON.stringify(out).length;
  // The order is a decision: a proof URL and a name are nice in a list, and the money is not
  // negotiable, so the strings go first and `pcap` — which only mints a link — goes last-but-one.
  for (const [k, cap] of [['r', 96], ['y', 48], ['n', 40], ['v', 24]]) {
    if (size() <= ROW_META_CAP) break;
    if (typeof out[ROW_K[k]] === 'string' && out[ROW_K[k]].length > cap) out[ROW_K[k]] = out[ROW_K[k]].slice(0, cap);
  }
  for (const k of ['k', 'p', 'f', 'b']) {
    if (size() <= ROW_META_CAP) break;
    delete out[ROW_K[k]];
  }
  if (size() > ROW_META_CAP) {
    // Nothing left that is fair game and it is still too big: keep the money and the identity,
    // because a row that fits is a shop that can still close their month.
    const keep = ['i', 'c', 'a', 's', 't', 'x', 'e', 'q', 'm', 'w', 'u'];
    const tiny = {};
    for (const k of keep) if (out[k] !== undefined) tiny[k] = out[k];
    return tiny;
  }
  return out;
}

/**
 * Back to the long form, tolerant of a row that shed fields to fit.
 *
 * The shed fields come back as what they were, not as `undefined`: a row that never carried a
 * payment code and a row whose code was cleared are the same answer to everything downstream — the
 * dashboard's `row.proof || 'no code yet'` and the merchant's eye should not have to know that
 * `packRow` deletes empty strings to stay inside 1,024 bytes.
 */
export function unpackRow(meta) {
  const out = {};
  if (!meta || typeof meta !== 'object') return out;
  for (const long of Object.keys(ROW_K)) {
    const short = ROW_K[long];
    out[long] = meta[short] !== undefined ? meta[short] : (ROW_DEFAULT[long] !== undefined ? ROW_DEFAULT[long] : '');
  }
  for (const k of Object.keys(meta)) {                     // a forward-compatible field, if a newer
    const long = ROW_V[k];                                 // worker wrote one this one can read
    if (long === undefined && meta[k] !== undefined) out[k] = meta[k];
  }
  return out;
}
const ROW_DEFAULT = { flags: [], vat_by: undefined, prior_unpaid: undefined, marked_at: null };
const ROW_V = Object.fromEntries(Object.entries(ROW_K).map(([l, v]) => [v, l]));

/**
 * Newest first, from the documents, with the frozen legacy index filling any id that predates
 * them. A row present in both is the same row — the document's is the one that was written last.
 */
export function mergeRows(fromDocs, fromIndex, cap) {
  const seen = new Set();
  const out = [];
  for (const r of fromDocs || []) {
    if (!r || !r.id || seen.has(r.id)) continue;
    seen.add(r.id); out.push(r);
  }
  for (const r of fromIndex || []) {
    if (!r || !r.id || seen.has(r.id)) continue;
    seen.add(r.id); out.push(r);
  }
  out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return out.slice(0, cap || MAX_ORDERS_KEPT);
}

/* ── the autonomous half of the mesh (v0.9.2) ────────────────────────────────────────────────
 * The merchant is not an editor. Asking a person who is cooking, serving and chasing payments to
 * approve a paragraph about their own Tuesday is how a distribution system quietly dies at 40 shops —
 * and it is the wrong use of the only irreplaceable thing in the business, a human willing to talk to
 * another human. So the gate moves: not one approval per post, but ONE standing grant per shop,
 * revocable in a single save, with the machine confined to what cannot embarrass anybody — the shop's
 * own words, real availability, no price, no link, no pitch.
 */
/** Anything on this list turns a value beat into an advertisement, and an advertisement is the one
 *  thing this half of the mesh is not allowed to be: the whole strategy is that people follow a shop
 *  that is useful and ignore a shop that is selling. */
export const MESH_PITCH_TOKENS = ['order now', 'buy now', 'discount', 'voucher', 'promo', 'special offer',
  'free delivery', 'wa.me', 'whatsapp', 'delivery fee', 'shop now', 'click', 'link in bio', 'checkout',
  'reserve', 'book now', 'call to order', 'price list', 'menuprice', 'order'];
/** A value beat may not carry money either, so a digit-with-currency is refused rather than clipped. */
const PITCH_MONEY = /(\b[Z$£€][0-9]|[0-9](\.[0-9]{1,2})?\s?(usd|zar|bwp|gel|kwd|eur|gbp)\b)/i;
const PITCH_LINK = /(https?:\/\/|www\.|\/s\/[a-z0-9]|@)/i;

/** True when a sentence is selling something. Deliberately over-strict: a beat dropped for a false
 *  positive costs a post, a beat published with a false negative costs the shop its audience. */
export function meshIsPitch(text, extra) {
  const t = String(text || '').toLowerCase();
  const words = (extra && Array.isArray(extra.tokens) ? extra.tokens : MESH_PITCH_TOKENS)
    .map((w) => String(w).toLowerCase());
  const hit = words.find((w) => w && t.includes(w));
  if (hit) return { pitch: true, why: 'pitch word: ' + hit };
  if (PITCH_MONEY.test(t)) return { pitch: true, why: 'a price in a value post' };
  if (PITCH_LINK.test(t)) return { pitch: true, why: 'a link or handle in a value post' };
  return { pitch: false, why: '' };
}

export const MESH_AUTONOMY = {
  kinds: ['value', 'status'],           // promo never appears here: that one stays a human's tap
  pitch: 'never',                     // the ban is a field, so a test can read it and a UI can show it
  per_day: 2, window_utc: '08:15',      // one morning beat and one lunch beat, in the audience's window
  max_chars: 300, revoke_writes: 1,     // switching it off costs one save, which is the point
};

const meshClip = (t, n) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length <= n ? x : x.slice(0, Math.max(0, n - 1)).trimEnd() + '…'; };

/**
 * What the shop can say today with no offering in it, built only from fields a row already carries:
 * its own item descriptions, its categories, what is sold out, and its opening line. The witness rule
 * is unchanged — no number, no claim, nothing that is not on the data read this minute — but the
 * target of the rule moved: a promo beat must be right about money, a value beat must be right about
 * the shop's own words, and the second one is the kind a stranger will follow.
 */
export function meshValueBeats(st, products, facts, opt) {
  const o = opt || {}, s = st || {}, f = facts || {};
  const list = (Array.isArray(products) ? products : []).filter((p) => p && p.name);
  const day = Math.floor((o.now || Date.now()) / DAY_MS);
  const open = f.closed ? 'closed today' : meshClip(f.hours_text || s.hours || '', 60);
  const beats = [];
  const push = (kind, body, key) => {
    const text = meshClip(body, MESH_AUTONOMY.max_chars);
    const v = meshIsPitch(text, o);
    if (v.pitch) { beats.push({ kind, item_key: key, text, blocked: v.why }); return; }
    beats.push({ kind, item_key: key, text, rail: 'whatsapp_status' });
  };
  const withWords = list.filter((p) => meshClip(p.desc || p.description || p.note || '', 20).length > 12);
  if (withWords.length) {
    const p = withWords[day % withWords.length];
    push('value', meshClip(p.name, 60) + ': ' + meshClip(p.desc || p.description || p.note, 200),
      'words:' + String(p.id || p.name).slice(0, 40));
  }
  const gone = list.filter((p) => p.available === false);
  if (gone.length && open) {
    push('status', 'Not making ' + meshClip(gone[0].name, 40) + ' today — back with the next '
      + (open === 'closed today' ? 'service' : 'service after ' + meshClip(open.replace(/^[^.]*[.:]\s*/i, ''), 24)) + '.',
      'gone:' + String(gone[0].id || gone[0].name).slice(0, 40));
  } else if (list.length > 2) {
    const cats = [...new Set(list.map((p) => String(p.category || '').trim()).filter(Boolean))];
    if (cats.length) {
      const c = cats[day % cats.length];
      push('value', c + ' is the one we make the most of here — '
        + list.filter((p) => String(p.category || '').trim() === c).slice(0, 3).map((p) => meshClip(p.name, 28)).join(', ') + '.',
        'cat:' + c.slice(0, 40));
    }
  }
  const out = beats.filter((b) => !b.blocked);
  return { beats: out.slice(0, MESH_AUTONOMY.per_day), blocked: beats.filter((b) => b.blocked),
    witness: { sources: out.map((b) => b.item_key), rows: list.length } };
}

/** The standing grant. One save to turn it on, one to turn it off, and the timestamp is what makes an
 *  audit possible later — "who authorised this and when" is a question a shop will ask in month three. */
export function meshGrant(prev, on, nowMs) {
  const t = nowMs || Date.now();
  const iso = new Date(t).toISOString();
  const p = prev && typeof prev === 'object' ? prev : {};
  const was = p.auto || {};
  return { ...p, auto: { on: !!on, at: was.on === !!on ? (was.at || iso) : iso, flips: (Number(was.flips) || 0) + (was.on === !!on ? 0 : 1) } };
}

/** Everything the autonomous publisher is allowed to put out, or nothing. An empty list is a correct
 *  answer, and saying it beats publishing a shop's Tuesday into a void. */
export function meshAutoPlan(st, products, facts, opt) {
  const o = opt || {}, s = st || {};
  const state = o.state || {};
  const acct = meshAccount(st);
  if (!(state.auto ? state.auto.on === true : acct.auto_default)) return { on: false, beats: [], blocked: [], why: state.auto ? 'the grant was switched off for this shop' : 'no standing grant for this shop' };
  const v = meshValueBeats(s, products, facts, o);
  const wit = meshWitness(s, products, facts);
  const seen = (state.items && typeof state.items === 'object') ? state.items : {};
  const day = Math.floor((o.now || Date.now()) / DAY_MS);
  const fresh = (k) => { const d = seen[k]; return !d || (day - Math.floor(Date.parse(String(d)) / DAY_MS)) >= MESH_BUDGET.item_cooldown_days; };
  const beats = v.beats.filter((b) => fresh(b.item_key));
  return { on: true, beats, blocked: v.beats.length === 0 ? v.blocked : [], witness: v.witness,
    priced: wit.price_ok, note: 'value only: no price, no link, no offer in any of these lines',
    sent_if: beats.length ? 'a beat that would sell something is dropped, not softened' : '' };
}

/**
 * The outreach half, which is the part a person is for. A growth machine that writes to strangers
 * from a queue burns the number it is calling from; a shop messaging four people who left an order
 * unpaid, and thanking the nine who keep coming back, is the same motion at a scale that stays
 * believed. Nothing here composes a promise, an offer or a discount: it reads today's ledger, picks
 * the conversations worth having, and hands over a first line to send as yourself.
 */
export function meshGrowth(st, rows, opt) {
  const o = opt || {}, now = o.now || Date.now(), day = 864e5;
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.at);
  const paid = (r) => /paid|done|complete|collected|deliver/i.test(String(r.status || ''));
  const first = (r) => String((r.items && r.items[0] && r.items[0].name) || r.note || 'your order').slice(0, 40);
  const unpaid = list.filter((r) => !paid(r) && r.phone && (now - Date.parse(String(r.at)) || 0) < 3 * day)
    .slice(0, 12)
    .map((r) => ({ phone: String(r.phone).replace(/\D/g, '').slice(0, 15), when: String(r.at).slice(0, 10),
      line: 'Hi — the ' + first(r) + ' from ' + new Date(String(r.at)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
        + ' is still with us. Want it for the next run, or shall I let it go?',
      why: 'left unpaid, still inside three days' }));
  const byPhone = new Map();
  for (const r of list) { const p = r.phone ? String(r.phone).replace(/\D/g, '') : ''; if (p) byPhone.set(p, (byPhone.get(p) || 0) + 1); }
  const regulars = [...byPhone.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([phone, n]) => ({ phone, orders: n,
      line: 'You have had us ' + n + ' times — that means something to us. If a colleague has not tried us yet, tell them.',
      why: n + ' orders on the ledger' }));
  return { unpaid, regulars, read: list.length,
    note: 'Read from the ledger, sent by a human. Nothing in this list is automated, because a person who '
      + 'replies to a machine stops replying to you.' };
}

/* ── v0.9.3: the whole loop autonomous, and the human on the part only a human can do ─────────
 * The correction that made this: a shop's promo posts are not advertisements in the sense the pitch
 * filter fears — they are facts about the shop (what it costs, what is out, when it is back), and a
 * seller who has to approve each of those twice a day is not being protected, they are being worked.
 * So both kinds are created, scheduled and posted here, on a rhythm; what stays with the person is
 * the reply — the conversation that follows a first touch, which is where a sale is actually won or
 * lost and which no template should own.
 */
/** Where a beat can physically go by itself. `auto` means an API exists that a shop can authorise
 *  with a token of their own; `assist` means the platform has no legitimate API for what we do (a
 *  personal WhatsApp status, a Facebook group) and the pack hands a person the text and the link. A
 *  publisher that pretends otherwise is how an account gets restricted, so the capability is declared
 *  per channel and the schedule refuses to claim a send it cannot make. */
/* ── v0.9.4: the rails and the accounts, read off the pipeline that already runs this ─────────
 * The rail list and the cadence are the hunta bible's own machine section: X >=3 posts a day per
 * persona, LinkedIn >=3, dev.to 3, daily pins, daily Bluesky and Nostr ("niche value, low
 * competition"), planner ratio two value to one promo, replies capped at four a day at human pace,
 * and cold outreach composed at 08:21 on weekdays with one owner tap sending the whole batch to a
 * ramped mailbox. The line I had wrong was the price of X: the write-only free tier is 1,500 posts
 * a month, so a shop's three beats a day is nothing against it and no seller needs a paid app.
 */
const MESH_RAIL_ALIAS = { whatsapp_status: 'whatsapp', fb_group: 'facebook', ig: 'instagram', x_thread: 'x', paper: 'counter' };
const MESH_FALLBACK = { mode: 'assist', max: 300, cadence: 1, api: null, needs: 'not a channel we know: it is queued for a person, never claimed as posted', pitch: true };

export const MESH_CHANNELS = {
  x:         { mode: 'auto', max: 280, cadence: 3, api: "v2 write-only free tier (1,500 posts a month)", needs: "a bearer token from the seller's own free app", pitch: true },
  linkedin:  { mode: 'auto', max: 3000, cadence: 3, api: "share / community management", needs: "access token", pitch: true },
  devto:     { mode: 'auto', max: 100000, cadence: 3, api: "articles", needs: "free api key; the long-form home of the value beats", pitch: false },
  bluesky:   { mode: 'auto', max: 300, cadence: 1, api: "atproto", needs: "handle + app password", pitch: true },
  nostr:     { mode: 'auto', max: 1000, cadence: 1, api: "relay, kind 1", needs: "an nsec we generate for the shop: no signup, no cost, nobody to approve it", pitch: true },
  mastodon:  { mode: 'auto', max: 500, cadence: 1, api: "rest", needs: "instance + token", pitch: true },
  telegram:  { mode: 'auto', max: 1024, cadence: 1, api: "bot", needs: "bot token + channel id", pitch: true },
  pinterest: { mode: 'auto', max: 500, cadence: 1, api: "pins", needs: "business account; the photo rails are the ones that sell food", pitch: true },
  gpages:    { mode: 'auto', max: 5000, cadence: 3, api: "static", needs: "nothing: we host it", pitch: true },
  whatsapp:  { mode: 'assist', max: 130, cadence: 2, api: null, needs: "the seller taps send from their own number", pitch: true },
  facebook:  { mode: 'assist', max: 500, cadence: 1, api: null, needs: "groups have no API for this; a person posts", pitch: true },
  instagram: { mode: 'assist', max: 900, cadence: 1, api: null, needs: "business account + token if they have one", pitch: true },
  counter:   { mode: 'assist', max: 150, cadence: 1, api: null, needs: "the paper by the till", pitch: true },
};

export const MESH_RAIL_SOURCE = "the rails and the cadence are the pipeline's own, not invented here; and the ratio 2 value : 1 promo is the planner rule the bible states, weekends included";

/* Whose account is it, and does anyone have to switch it on? A company account the owner runs is
 * autonomous by default: he wrote the policy, so a grant would be him asking himself for permission.
 * A seller's account is delegated to the same machine — their key, their number, one tap of theirs
 * to stop — and a trial account has nothing connected, so it has nothing to post with. */
/* Three kinds of account, and the difference is who we may post *as* — not how careful we are.
 *  owner    the company's own accounts. Autonomous by default: he wrote the policy, so a grant or a
 *           tap would be him asking himself for permission.
 *  seller   staff and people reselling Tapstall on the company's behalf. They hand over real
 *           credentials (Bluesky app password, Telegram bot token, Mastodon token, a free X bearer, an
 *           nsec we generate, dev.to key) and the machine posts to those accounts itself.
 *  operator anyone selling *with* the platform. Their socials are not ours to touch — we are not a
 *           content agency — so they get the free nodes we run, and copy they can post themselves. */
export const MESH_OWN_NODES = ['gpages'];
export const MESH_ACCOUNT_CLASSES = {
  owner:    { auto_default: true,  socials: true,  credentials: "the owner's own company accounts", revoke: "flip the default off in ops" },
  seller:   { auto_default: true,  socials: true,  credentials: "delegated for real: the seller hands over their app password, bot token or nsec and the machine posts to their account", revoke: "they change the password at the provider, or tap revoke in ops" },
  operator: { auto_default: false, socials: false, credentials: "none, and none are asked for: an operator's accounts stay theirs", revoke: "nothing to revoke; the platform only ever publishes its own nodes" },
  // kept so an old document still classifies: a trial shop is an operator with nothing connected
  trial:    { auto_default: false, socials: false, credentials: "none until they connect their own", revoke: "nothing to revoke: it never posts" },
};

export function meshAccount(st) {
  const s = st || {};
  const cls = s.mesh_class || (s.owner === true || s.type === 'company' ? 'owner'
    : (s.staff === true || s.reseller === true || s.delegate === true || /staff|reseller|seller/i.test(String(s.role || '')) ? 'seller'
      : (s.plan === 'trial' || /trial/i.test(String(s.status || '')) ? 'trial' : 'operator')));
  const c = MESH_ACCOUNT_CLASSES[cls] || MESH_ACCOUNT_CLASSES.seller;
  const ch = (s.mesh_channels && typeof s.mesh_channels === 'object') ? s.mesh_channels : {};
  return { class: cls, auto_default: c.auto_default, credentials: c.credentials, revoke: c.revoke,
    rails: Object.keys(ch).filter((k) => ch[k] && ch[k].on), delegated: cls === 'seller',
    socials: c.socials, own_nodes: MESH_OWN_NODES,
    on_behalf_of: cls === 'seller' ? "a seller's account, posted to by the owner's machine on credentials the seller gave"
      : cls === 'owner' ? "the owner's own account" : "an operator's shop, published on the platform's own nodes only" };
}

/* Outreach the way the pipeline does it: the machine composes, one tap sends the batch, the mailbox
 * ramps, and the reply stays at a human pace. What is deliberately absent is a per-message
 * approval, which is how a growth machine becomes a to-do list nobody gets to. */
export const MESH_OUTREACH = {
  compose: 'auto', send: 'auto', approvals: 'none', at_utc: '08:21', weekdays_only: true,
  human_for: ['reply', 'price', 'complaint', 'anything a customer is angry about'],
  ramp_per_day: [20, 40, 60, 80, 100], batch_max: 80,
  replies: { per_day: 4, scan_per_day: 3, mode: 'human', order: 'questions first',
    auto_first_reply_on: ['bluesky', 'nostr'],
    escalate_to_human: ['price', 'complaint', 'refund', 'anything a customer is angry about'] },
  basis: ['ledger', 'uploaded list', 'follower who engaged'],
};

export function meshOutreachPlan(st, opt) {
  const o = opt || {}, now = o.now || Date.now(), d = new Date(now);
  const weekday = d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
  const state = o.state || {}, ramp = MESH_OUTREACH.ramp_per_day;
  const sent = Number((state.outreach && state.outreach.sent) || 0);
  const total = Number((state.outreach && state.outreach.total) || 0);
  const cap = ramp[Math.min(ramp.length - 1, Math.floor(total / 100))];
  const list = Array.isArray(o.leads) ? o.leads : [];
  const acct = meshAccount(st);
  const sendable = !!acct.socials || (o.channels || []).length > 0;   // a credential is a physical limit, not an approval
  const batch = list.slice(0, Math.max(0, Math.min(MESH_OUTREACH.batch_max, cap - sent))).map((l, i) => {
    const to = String((l && (l.phone || l.email || l.handle)) || l || '').slice(0, 60);
    return { to, kind: /@/.test(to) ? 'email' : 'dm_whatsapp', i: i + 1,
      sends: sendable, approved_by: null, waits_for: sendable ? 'nothing: the window sends it' : 'an outbound credential for this account',
      text: meshClip((l && l.note) ? String(l.note) : String(l), 220) };
  });
  return { composed: batch.length, send_at_utc: MESH_OUTREACH.at_utc, on: weekday || !MESH_OUTREACH.weekdays_only,
    skip_reason: (!weekday && MESH_OUTREACH.weekdays_only) ? 'weekend: the pipeline composes on weekdays only' : '',
    cap_today: cap, sent_today: sent, ramp_day: Math.floor(total / 100) + 1, batch,
    replies: MESH_OUTREACH.replies, basis: MESH_OUTREACH.basis,
    note: 'Composed here, sent by the window, capped by the ramp. Nothing waits for a yes; what waits for a person is the reply, because that is the half where a sale is won.' };
}

export const MESH_AUTONOMY_V3 = {
  kinds: ['value', 'promo'], ratio: { value: 2, promo: 1 }, per_day: 3,
  windows_utc: ['06:30', '11:30', '17:30'],            // breakfast, lunch, home-time: the audience's rhythm
  human: 'replies_only', revoke_writes: 1,
  touch: { per_day: 8, warm_only: true, kinds: ['dm_whatsapp', 'email', 'comment_reply'], reply_window_days: 3 },
};

/** A promo beat states a fact with money in it. Money may not be improvised: a discount, a free
 *  something or a "was/now" only exists if the row carries it, so an invented offer is dropped here
 *  rather than caught downstream, and the reason is kept for the shop to read. */
const OFFER_WORDS = /(\d+\s?%\s?off|discount|voucher|free\s|bogo|was\s[0-9])/i;
export function meshUnsupportedOffer(text, row) {
  if (!OFFER_WORDS.test(String(text || ''))) return '';
  const p = row || {};
  if (p.promo || p.discount || p.voucher || p.was || p.bogo || p.free_with) return '';
  return 'an offer nobody configured: the menu row carries no promo, discount or was/now field';
}

export function meshPromoBeats(st, products, facts, opt) {
  const o = opt || {}, s = st || {}, f = facts || {};
  const list = (Array.isArray(products) ? products : []).filter((p) => p && p.name);
  const wit = meshWitness(st, list, f);
  const day = Math.floor((o.now || Date.now()) / DAY_MS);
  const base = String(o.origin || '').replace(/\/+$/, '');
  const link = base + '/s/' + (s.handle || '');
  const money = (n, cur) => (Number(n) || 0).toFixed(2) + ' ' + (cur || s.currency || (f && f.currency) || 'USD');
  if (!wit.price_ok || !list.length) return { beats: [], blocked: [{ why: wit.fails.length ? String(wit.fails[0].note) : 'no items to price' }] };
  const pool = list.slice().sort((a, b) => (Number(!!b.popular) - Number(!!a.popular)) || String(a.name).localeCompare(String(b.name)));
  const out = [], blocked = [];
  const add = (row, body, kind) => {
    const text = meshClip(body, 300);
    const bad = meshUnsupportedOffer(text, row);
    if (bad) { blocked.push({ item_key: String(row.id || row.name).slice(0, 40), text, why: bad }); return; }
    const full = text + ' ' + link;
    // the rail is chosen by length, because the limit is the platform's, not ours: a line that does
    // not fit a status update is not trimmed into nonsense, it goes where the sentence fits
    const rail = ['whatsapp_status', 'x', 'facebook_group', 'instagram'].find((r) => full.length <= (MESH_RAILS[r] || { max: 1e9 }).max) || 'counter';
    out.push({ kind: kind || 'promo', rail, item_key: String(row.id || row.name).slice(0, 40), item: meshClip(row.name, 60),
      price: Number(row.price) || 0, text: full, sends: true });
  };
  const a = pool[day % pool.length];
  add(a, meshClip(a.name, 60) + ' is ' + money(a.price, a.cur) + (a.available === false ? ' and listed sold out — write to ask about the next batch' : ', available now')
    + (f.hours_text ? ', while we are open: ' + meshClip(f.hours_text, 40) : ''), 'promo');
  const gone = list.filter((p) => p.available === false);
  // and the good news only when it is not contradicting the line above: the same row cannot be sold
  // out in one beat and back in the next, which is the kind of thing a person notices in a shop's
  // posts long before they notice a clever one
  if (gone.length) {
    const already = new Set(out.map((b) => b.item_key));
    const g = gone.find((p) => !already.has(String(p.id || p.name).slice(0, 40)));
    if (g) add(g, g.name + ' is back on the ' + (Number(g.price) ? 'menu at ' + money(g.price, g.cur) : 'menu'), 'promo');
  }
  return { beats: out.slice(0, MESH_AUTONOMY_V3.ratio.promo + 1), blocked, witness: { rows: list.length, priced: wit.price_ok } };
}

/** Today's plan, one number: the ratio applied, the windows assigned, and each beat marked with the
 *  channels it can actually reach. Deterministic on the date, so a shop can predict what went out. */
export function meshSchedule(st, products, facts, opt) {
  const o = opt || {}, now = o.now || Date.now(), day = Math.floor(now / DAY_MS);
  const state = o.state || {};
  const auto = state.auto ? state.auto.on === true : meshAccount(st).auto_default;   // owner and seller accounts run by default
  const acct = meshAccount(st);
  const seen = (state.items && typeof state.items === 'object') ? state.items : {};
  const fresh = (k) => { const d = seen[k]; return !d || (day - Math.floor(Date.parse(String(d)) / DAY_MS)) >= MESH_BUDGET.item_cooldown_days; };
  const v = meshValueBeats(st, products, facts, o);
  const p = meshPromoBeats(st, products, facts, o);
  const ratio = MESH_AUTONOMY_V3.ratio, cap = MESH_AUTONOMY_V3.per_day;
  const chosen = [];
  const allowPromo = (chosen.filter((b) => b.kind === 'promo').length < Math.max(1, Math.floor(cap * ratio.promo / (ratio.value + ratio.promo))));
  const promos = allowPromo ? p.beats.slice(0, 1) : [];
  for (const b of v.beats.slice(0, cap - promos.length)) if (fresh(b.item_key)) chosen.push(b);
  for (const b of promos) if (fresh(b.item_key)) chosen.push(b);
  const chans = (st && st.mesh_channels && typeof st.mesh_channels === 'object') ? st.mesh_channels : {};
  const open = Object.keys(MESH_CHANNELS).filter((c) => chans[c] && chans[c].on);
  const beats = chosen.map((b, i) => {
    const autoCh = open.filter((c) => (MESH_CHANNELS[MESH_RAIL_ALIAS[c] || c] || MESH_FALLBACK).mode === 'auto');
    return { ...b, slot: MESH_AUTONOMY_V3.windows_utc[i % MESH_AUTONOMY_V3.windows_utc.length],
      to: (acct.socials ? ((acct.socials ? open : []).length ? open : ['whatsapp']) : MESH_OWN_NODES).slice(), socials_allowed: acct.socials,
      posted_by: (b.kind === 'promo' ? 'shop facts' : 'shop words'), on_behalf_of: meshAccount(st).on_behalf_of, delegate: meshAccount(st).delegated,
      auto_send: auto && autoCh.length > 0, channels_auto: autoCh };
  });
  return { on: auto, beats, blocked: [].concat(v.blocked || [], p.blocked || []),
    human: MESH_AUTONOMY_V3.human, note: auto
      ? 'Scheduled and posted by itself where a channel can be posted to by API; the rest is queued for a tap. Replies are never sent from here.'
      : 'No standing grant: nothing goes out on its own, and everything here is still copy-and-tap ready.' };
}

/** First touch to people who already exist in the shop's own history — a left order, a return, a
 *  question asked in a comment. Cold lists are refused by shape, not by sermon: there is no path that
 *  takes a number from anywhere but a row on this shop's ledger, and a mass DM from a shop's own
 *  WhatsApp number is the fastest way documented to lose that number. */
export function meshFirstTouch(st, rows, opt) {
  const o = opt || {}, now = o.now || Date.now(), day = 864e5, cap = MESH_AUTONOMY_V3.touch.per_day;
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.at && r.phone);
  const unpaid = list.filter((r) => !/paid|done|complete|collected|deliver/i.test(String(r.status || '')) && (now - (Date.parse(String(r.at)) || 0)) < 3 * day);
  const counts = new Map();
  for (const r of list) { const p = String(r.phone).replace(/\D/g, ''); if (p) counts.set(p, (counts.get(p) || 0) + 1); }
  const queue = [];
  for (const r of unpaid.slice(0, cap)) {
    queue.push({ to: String(r.phone).replace(/\D/g, '').slice(0, 15), kind: 'dm_whatsapp', row: r.id,
      first: true, human_after: true,
      text: 'Hi — your ' + meshClip((r.items && r.items[0] && r.items[0].name) || 'order', 40) + ' from '
        + new Date(String(r.at)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' is still here. Want it on the next run?' });
  }
  for (const [p, n] of [...counts.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).slice(0, Math.max(0, cap - queue.length))) {
    queue.push({ to: p, kind: 'dm_whatsapp', orders: n, first: true, human_after: true,
      text: 'You have had us ' + n + ' times — thank you. If someone at work has not tried us, tell them and we will look after them too.' });
  }
  return { queue, sent_if: queue.length ? 'queued for the shop’s own number, capped at ' + cap + ' a day' : '',
    refused: list.length - (unpaid.length + counts.size), touch: MESH_AUTONOMY_V3.touch,
    note: 'Warm contacts only, read off this shop’s ledger. A reply lands in the inbox, and a person answers it — '
      + 'that half is not automated because a template in a conversation is how a customer leaves.' };
}

/* ── v0.9.5: the publisher is Buffer's free GraphQL, not app keys ──────────────────────────────
 * Straight from the hunta docs (AGENT-HANDOVER, 19 §pipeline, 20 §distribution, 26 §scale-up):
 *   PUBLISH  Buffer GraphQL (X, LinkedIn, Pinterest, scheduled on a 40-min grid) · Bluesky · Nostr ·
 *            dev.to · Whop
 * X is free because it is posted *through a free Buffer org*: the seller connects their own X in Buffer
 * and pastes the Buffer access token plus the connected channel id, which is exactly `PRESS_BUFFER_TOKEN_A`
 * and `PRESS_CHANNEL_X_A` in the scale-up doc. There is no app to create and no paid tier to buy.
 * A rail that cannot be reached by API is not a failure of the plan, it is a rail in `assist` mode.
 */
export const MESH_PUBLISH = {
  x:         { via: 'buffer', grid_min: 40, needs: 'a free Buffer org: access token + the connected channel id' },
  linkedin:  { via: 'buffer', grid_min: 40, needs: 'same Buffer token, the LinkedIn channel id' },
  pinterest: { via: 'buffer', grid_min: 40, needs: 'same Buffer token, a board id (Buffer caches the board list: re-select the board after a rename)' },
  bluesky:   { via: 'direct', grid_min: 40, needs: 'handle + app password (their own repo can push it too)' },
  nostr:     { via: 'direct', grid_min: 40, needs: 'an nsec per shop and any public relay: no signup, no cost, nothing to approve' },
  telegram:  { via: 'direct', grid_min: 40, needs: 'bot token + channel id' },
  mastodon:  { via: 'direct', grid_min: 40, needs: 'instance + access token' },
  devto:     { via: 'direct', grid_min: 40, needs: 'free api key; the long-form home of the value beats' },
  gpages:    { via: 'own',    grid_min: 40, needs: 'nothing: these are our nodes' },
  whatsapp:  { via: 'none',   grid_min: 0,  needs: 'their number, their hand: no API exists and we do not pretend one does' },
  facebook:  { via: 'none',   grid_min: 0,  needs: 'groups: no API for this' },
  instagram: { via: 'none',   grid_min: 0,  needs: 'business account + token if they have one' },
  counter:   { via: 'none',   grid_min: 0,  needs: 'the paper by the till' },
};
export const MESH_BUFFER_FREE = { org_channels: 3, queued_per_channel: 10, grid_min: 40, posts_per_day_ceiling: 36 };
/** Two failed windows in a row and the rail comes out of the cadence by itself. This is the no-wait
 *  doctrine in the docs (45): the machine resolved "reconnect or remove?" by removing, without asking,
 *  because a dead rail plans zero posts and the owner's attention is the scarce budget. The entry goes
 *  back in the cadence the moment the rail works again — restore the line, restore the rail. */
export const MESH_RAIL_HEALTH = { fail_limit: 2, action: 'drop from cadence', ask_human: false, ledger: 'mesh:<handle>.rails' };
export function meshRailHealth(state, opt) {
  const o = opt || {}, st = (state && typeof state === 'object') ? state : {};
  const seen = (st.rails && typeof st.rails === 'object') ? st.rails : {};
  const cadence = (st.cadence && typeof st.cadence === 'object') ? st.cadence : {};
  const dropped = [], healthy = [];
  for (const rail of Object.keys(seen)) {
    const f = Number((seen[rail] || {}).fails) || 0;
    const ok = (seen[rail] || {}).ok === true;
    if (f >= MESH_RAIL_HEALTH.fail_limit && !ok) dropped.push({ rail, fails: f, note: 'out of the cadence until it answers again; a person is not consulted about a dead rail' });
    else healthy.push(rail);
  }
  const list = Object.keys(cadence).filter((r) => !dropped.some((d) => d.rail === r));
  return { healthy, dropped, cadence_active: list.map((r) => ({ rail: r, per_day: Number(cadence[r]) || 0 })),
    policy: MESH_RAIL_HEALTH, judged_by: 'the ledger, never the run annotation' };
}
/** Drip, cap and park — the outreach shape the docs settled on (12 §drip, 08-10 handover entry): send
 *  the batch in drips on the grid rather than all at once; the cap is a runaway bound, and at the cap
 *  the remainder is parked for the next compose run. It must never demand a tap: that is the sentence
 *  the pipeline had to rewrite in code after it stalled on exactly that. */
export const MESH_DRIP = { batch_cap: 30, drip_per_slot: 6, grid_min: 40, at_cap: 'park the remainder for the next compose run', cap_demands_tap: false };
export function meshDrip(queue, state, opt) {
  const o = opt || {}, st = (state && typeof state === 'object') ? state : {};
  const cap = Number(o.batch_cap || MESH_DRIP.batch_cap), slot = Number(o.drip_per_slot || MESH_DRIP.drip_per_slot);
  const sent = Number((st.outreach && st.outreach.sent) || 0);
  const room = Math.max(0, cap - sent);
  const releasing = queue.slice(0, Math.min(slot, room));
  const parked = queue.slice(releasing.length);
  return { release: releasing.length, per_slot: slot, parked: parked.length, cap, sent_today: sent,
    grid_min: MESH_DRIP.grid_min, tap_required: false, cap_demands_tap: MESH_DRIP.cap_demands_tap,
    at_cap: releasing.length ? '' : MESH_DRIP.at_cap, note: 'The cap bounds the runaway; it does not ask anyone for permission.' };
}
/** Every rail this shop's plan can name must have a limit on the payload, or a caller measuring a beat
 *  against its rail reads undefined and the truncation only shows up as a post that came out short. */
export function meshRailsTotal(beats) {
  const all = {};
  for (const r of Object.keys(MESH_RAILS)) all[r] = MESH_RAILS[r];
  for (const c of Object.keys(MESH_CHANNELS)) if (!all[c]) all[c] = { name: c, max: MESH_CHANNELS[c].max };
  for (const b of (Array.isArray(beats) ? beats : [])) {
    const r = b && b.rail ? String(b.rail) : '';
    if (r && !all[r]) all[r] = { name: r, max: Number(MESH_AUTONOMY_V3.max_chars || (typeof MESH_AUTONOMY === 'object' ? MESH_AUTONOMY.max_chars : 0) || 300) };
  }
  return all;
}

/* ── v0.9.5: the press contract, copied from the running pipeline ───────────────────────────────
 * hunta's `press/cadence.json` and `press/queue.json` are the interface its Buffer sender reads, so
 * Tapstall composes into that shape instead of inventing one of our own: cadence numbers come from
 * their file (a fixture in tests/fixtures, checked by test), and a queued item is
 * { id, channel, channel_id, due, text, link, image, board, pin_title, landing, store }.
 * Two ways out of the queue, and both are honest about what happened: if the shop has a Buffer access
 * token we create the draft ourselves; if it does not, the item stays queued in a format their sender
 * (or a cron on their own box, holding the keys we never ask for) picks up. Nothing is reported as
 * posted because it was written down.
 */
export const MESH_BUFFER_CHANNEL = { x: 'twitter', linkedin: 'linkedin', pinterest: 'pinterest' };
export const MESH_QUEUE_DEFAULTS = { grid_min: 40, per_day: 3, promo_per_day: 1, promo_min_gap_days: 3,
  reply_per_day: 4, run_target: 4, longform_days: 7, topic_max_rails: 3 };
export const MESH_GRAPHQL_URL = 'https://buffer.com/graphql';

/** The queue item for one beat, in their keys, with a due time on the grid. `link` is only present on
 *  the shop-facts half, because the value half has no link by design. */
/** Which channel a beat actually goes out on. The rail a line was drafted for is often an assist surface
 *  (a status update, the paper by the till), and a queue item naming one of those is a post that can never
 *  happen; so the destination list wins, and only a channel something can physically send is chosen. */
export function meshBeatChannel(beat) {
  const want = [] .concat((beat && beat.to) || [], (beat && beat.rail) || 'bluesky');
  for (const w of want) {
    const key = String(w);
    const pub = MESH_PUBLISH[key];
    if (!pub) continue;
    if (pub.via === 'buffer' || pub.via === 'direct' || pub.via === 'own') {
      return { channel: pub.via === 'buffer' ? (MESH_BUFFER_CHANNEL[key] || key) : key, via: pub.via, rail: key };
    }
  }
  for (const w of want) { const pub = MESH_PUBLISH[String(w)]; if (pub) return { channel: String(w), via: 'none', rail: String(w) }; }
  return { channel: 'bluesky', via: 'none', rail: String((beat && beat.rail) || 'bluesky') };
}

export function meshQueueItem(beat, opt) {
  const o = opt || {}, now = o.now || Date.now(), grid = Number(o.grid_min || MESH_QUEUE_DEFAULTS.grid_min) * 60000;
  const pick = meshBeatChannel(beat);
  const rail = pick.rail;
  const chan = o.channel_name ? String(o.channel_name) : pick.channel;
  const n = Number(beat && beat.seq) || 0;
  return {
    id: String((beat && (beat.item_key || beat.id)) || ('b' + n)).replace(/[^\w:-]/g, '').slice(0, 40) + '-' + Math.floor(now / 864e5),
    channel: chan, channel_id: String((o.channel_id || '') || '').slice(0, 40),
    due: new Date(Math.ceil((now + 60000) / grid) * grid + n * grid).toISOString(),
    text: String((beat && beat.text) || '').slice(0, Number(beat && beat.max) || 300),
    link: beat && beat.kind === 'promo' ? String(beat.link || o.landing || '') : '',
    image: String((beat && beat.image) || o.image || ''),
    board: rail === 'pinterest' ? String(o.board || '') : '',
    pin_title: rail === 'pinterest' ? meshClip((beat && beat.item) || '', 60) : '',
    landing: String(o.landing || ''), store: String(o.store || ''),
    kind: String((beat && beat.kind) || 'value'), posted_by: String((beat && beat.posted_by) || 'shop words'), via: pick.via,
  };
}

/** Merge new items into the shop's queue: one item per rail per slot, the day's cadence as the ceiling,
 *  a promo never twice inside its gap, and nothing already queued by id. A full queue is a normal state,
 *  not an error, so it reports how much it dropped instead of failing. */
export function meshQueueMerge(prev, items, opt) {
  const o = opt || {}, now = o.now || Date.now(), cad = o.cadence || MESH_QUEUE_DEFAULTS;
  const keep = ((prev && prev.items) || []).filter((it) => it && it.due && Date.parse(it.due) > now - 60000);
  const byId = new Set(keep.map((i) => i.id));
  const day = Math.floor(now / DAY_MS);
  const perRail = {}; const promoGap = {};
  for (const i of keep) {
    perRail[i.channel] = (perRail[i.channel] || 0) + (Math.floor(Date.parse(i.due) / DAY_MS) === day ? 1 : 0);
    if (i.kind === 'promo') promoGap[i.channel] = Math.floor(Date.parse(i.due) / DAY_MS);
  }
  const dropped = []; const added = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    if (byId.has(it.id)) { dropped.push({ id: it.id, why: 'already queued' }); continue; }
    const limit = Number((cad.rails && cad.rails[it.channel] && cad.rails[it.channel].per_day) || cad.per_day || MESH_QUEUE_DEFAULTS.per_day);
    if ((perRail[it.channel] || 0) >= limit) { dropped.push({ id: it.id, channel: it.channel, why: 'cadence for today is full: ' + limit }); continue; }
    if (it.kind === 'promo') {
      const last = promoGap[it.channel];
      if (typeof last === 'number' && day - last < (Number(cad.promo_min_gap_days) || MESH_QUEUE_DEFAULTS.promo_min_gap_days)) {
        dropped.push({ id: it.id, channel: it.channel, why: 'promo gap ' + (cad.promo_min_gap_days || 3) + ' days' }); continue;
      }
    }
    added.push(it); byId.add(it.id); perRail[it.channel] = (perRail[it.channel] || 0) + 1;
    if (it.kind === 'promo') promoGap[it.channel] = day;
  }
  return { items: keep.concat(added).sort((a, b) => String(a.due).localeCompare(String(b.due))), added: added.length, dropped,
    store: String((prev && prev.store) || (o.store || '')), landing: String((prev && prev.landing) || o.landing || '') };
}

/** The Buffer draft call, kept small and loud: it either returns an id or it returns an error, and a
 *  rail with no token or no channel id is an error, never a silent skip. `verified` is set only by a
 *  response we actually got, so nothing in this code can report a post it did not see accepted. */
export function meshBufferCall(press, item) {
  const p = press || {};
  if (!p.buffer_token) return { call: null, err: 'no Buffer access token wired for this account' };
  const ch = String(item.channel_id || (p.channels || {})[item.channel] || '');
  if (!ch) return { call: null, err: 'no Buffer channel id for ' + item.channel };
  const body = JSON.stringify({
    operationName: 'createDraft',
    query: 'mutation createDraft($input: CreateDraftInput!) { createDraft(input: $input) { draft { id state } } }',
    variables: { input: { channelId: ch, text: item.text, publishAt: item.due,
      attachments: item.image ? [{ type: 'IMAGE', url: item.image }] : undefined } },
  });
  return { err: '', call: { url: MESH_GRAPHQL_URL, method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + String(p.buffer_token).slice(0, 200) },
    body: body } };
}

/** Resolve what an account can actually send with: the owner's env secrets win, a shop's own stored
 *  config is second, and a missing piece is returned as a reason rather than a silent no-op. Cadence
 *  comes from the shop if it set one, otherwise from the pipeline's file. */
export function meshPress(st, env) {
  const p = (st && st.press && typeof st.press === 'object') ? st.press : {};
  const e = env || {};
  const channels = Object.assign({}, p.channels || {});
  const out = { channels: channels, has_token: !!(e.PRESS_BUFFER_TOKEN || p.buffer_token),
    token_from: e.PRESS_BUFFER_TOKEN ? 'env' : (p.buffer_token ? 'kv' : 'nowhere'),
    board: p.board || '', image_base: p.image_base || '', landing: p.landing || '', store: (st && st.handle) || '',
    cadence: (p.cadence && typeof p.cadence === 'object') ? p.cadence : null,
    stored_in: p.buffer_token ? 'kv (theirs to delete; prefer the worker secret)' : 'env',
    missing: [] };
  if (!out.has_token) out.missing.push('PRESS_BUFFER_TOKEN');
  if (!Object.keys(channels).length) out.missing.push('a channel id per rail (Buffer: Channels, the 24-character id)');
  return out;
}

/** Send what is due. `dry` returns exactly what would be sent and calls nothing; a real send records
 *  every outcome, and a rail that fails twice is dropped from the cadence by meshRailHealth, without
 *  a question to anyone. The queue is their format, so a sender on their own box can drain it instead. */
export async function meshPressFlush(items, press, opt) {
  const o = opt || {}, now = o.now || Date.now(), dry = !!o.dry, fetcher = o.fetch || (typeof fetch === 'function' ? fetch : null);
  const results = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    if (Date.parse(it.due) > now) { results.push({ id: it.id, channel: it.channel, status: 'waiting', due: it.due }); continue; }
    // Buffer is only for the rails Buffer can hold. A direct rail is a script with the shop's own key,
    // an assist surface is a person with a phone, and neither is our call to make or to claim.
    if (it.via === 'none') { results.push({ id: it.id, channel: it.channel, status: 'queued', sent: false, verified: false,
      err: 'no API exists for ' + it.channel + ': the item is prepared for a person, and nothing is called posted until they do it' }); continue; }
    if (it.via === 'direct' || it.via === 'own') { results.push({ id: it.id, channel: it.channel, status: 'queued', sent: false, verified: false,
      err: it.via === 'own' ? 'published on our own node: the feed is the post'
        : "a direct rail is sent by the script that holds the key, in the shop's own repo or the owner's box" }); continue; }
    const call = meshBufferCall(press, it);
    if (call.err) { results.push({ id: it.id, channel: it.channel, status: 'queued', sent: false, err: call.err, verified: false }); continue; }
    if (dry) { results.push({ id: it.id, channel: it.channel, status: 'dry', url: call.call.url, due: it.due, chars: String(it.text).length, verified: false }); continue; }
    if (!fetcher) { results.push({ id: it.id, channel: it.channel, status: 'queued', sent: false, err: 'no fetch in this runtime', verified: false }); continue; }
    try {
      const r = await fetcher(call.call.url, { method: call.call.method || 'POST', headers: call.call.headers, body: call.call.body });
      const txt = await r.text();
      const ok = r.status >= 200 && r.status < 300 && !/"errors"\s*:\s*\[/.test(txt);
      results.push({ id: it.id, channel: it.channel, status: ok ? 'sent' : 'failed', http: r.status, sent: ok,
        verified: ok, note: ok ? 'the draft was accepted by Buffer' : txt.slice(0, 160) });
    } catch (e) {
      results.push({ id: it.id, channel: it.channel, status: 'failed', sent: false, err: String(e && e.message || e).slice(0, 160), verified: false });
    }
  }
  return { results, sent: results.filter((r) => r.status === 'sent').length, queued: results.filter((r) => r.status === 'queued').length,
    waiting: results.filter((r) => r.status === 'waiting').length, dry: dry, at: new Date(now).toISOString(),
    note: 'A post is only called posted when the platform said yes. Everything else stays queued and says so.' };
}

/* ── v0.9.6: the press registry — company accounts and seller accounts, and nobody else ─────────
 * An identity is not a shop. A shop is an operator's business, and the platform never posts to an
 * operator's socials; an identity is a *sending* account the company controls — the owner's own
 * accounts, or a seller's account delegated to the company by them. So the registry is keyed by
 * identity id, it holds channel ids and refs, and it cannot hold a token: tokens live in the worker's
 * env secrets, named per identity (`token_env`), which is what makes a revoked seller a matter of
 * changing one secret instead of editing a document.
 *
 * This exists because a live test was once run by relabelling an operator's shop as an owner account.
 * That is the exact thing the boundary forbids, so now it is refused by the code that writes the
 * registry, and a test says so.
 */
export const MESH_ID_CLASSES = ['owner', 'seller'];
export const MESH_ID_RAIL_DEFAULTS = { owner: ['x', 'bluesky', 'nostr', 'devto', 'linkedin'], seller: ['x', 'bluesky', 'telegram', 'nostr'] };

/** The company's own material, as data with a source path: the value half for a company account is the
 *  thing the platform teaches (nodes, provenance, ledger-first books), and it must cite where it is
 *  true, same rule as a shop's facts. A line with no `path` cannot be composed. */
export const MESH_COMPANY_VALUE = [
  { text: 'A shop front that is a URL, a photo and a phone number: no app store, no card terminal, nothing for the customer to install.', path: '/onboard' },
  { text: 'Every post we make is written from a row that was read today. If the menu did not answer, no price appears anywhere in the feed.', path: '/s/<handle>/mesh.json' },
  { text: 'Books that come out of orders rather than a Sunday evening: the ledger is the record, the receipt is the proof.', path: '/api/books' },
  { text: 'VAT is a percentage of what you actually sold, and the split is done where the order is taken, not in a spreadsheet later.', path: '/fees' },
  { text: 'A pricing page that doubles as a calendar: the renewal dates are a file any app can subscribe to.', path: '/fees.ics' },
  { text: 'Free nodes, not a subscription to reach your own customers: a feed, a sitemap, a plain-text page, and the shop keeps the copy.', path: '/rails' },
];

export function meshCompanyIdentities(reg) {
  const r = (reg && typeof reg === 'object') ? reg : {};
  return Object.keys(r).map((id) => ({ id, ...r[id] })).filter((e) => MESH_ID_CLASSES.includes(e.class));
}

/** Validate and upsert. Refusals are returned as data, because a registry that fails silently is how an
 *  operator ends up posted at by accident. */
export function meshRegister(reg, rec, opt) {
  const o = opt || {}, r = (reg && typeof reg === 'object') ? reg : {};
  const e = rec || {}, id = String(e.id || '').trim().toLowerCase().replace(/[^a-z0-9_:.-]/g, '').slice(0, 40);
  const refused = (o.refuse_ids || []).map((x) => String(x).toLowerCase());
  if (!id) return { ok: false, error: 'an identity needs an id (owner, or seller:<name>)' };
  if (!MESH_ID_CLASSES.includes(e.class)) {
    return { ok: false, error: 'class must be ' + MESH_ID_CLASSES.join(' or '), why: 'the platform is not a content agency: it holds no identity for an operator, and cannot be made to' };
  }
  if (refused.includes(id)) return { ok: false, error: 'refused', id: id, why: 'that id belongs to a shop on the platform, and a shop is an operator: we never post to their socials' };
  if (['buffer_token', 'token', 'app_password', 'nsec', 'api_key', 'bot_token'].some((k) => k in e)) {
    return { ok: false, error: 'no secrets in the registry', why: 'name the env secret instead (token_env); KV is readable by the whole worker, a secret is not' };
  }
  const rails = {}; const ignored = [];
  for (const [name, v] of Object.entries((e.rails && typeof e.rails === 'object') ? e.rails : {})) {
    const pub = MESH_PUBLISH[name];
    if (!pub) { ignored.push({ rail: name, why: 'not a rail we know' }); continue; }
    // a rail with no sender is not a sending rail: registering it would only produce items that sit in
    // the queue forever, so it is refused here and named, rather than recorded and quietly never sent
    if (pub.via === 'none') { ignored.push({ rail: name, why: 'no API exists for it: an identity posts to channels, a person posts to this one' }); continue; }
    rails[name] = { via: pub.via, channel: MESH_BUFFER_CHANNEL[name] || name,
      channel_id: String((v && v.channel_id) || '').slice(0, 40), handle: String((v && v.handle) || '').slice(0, 60),
      board: String((v && v.board) || '').slice(0, 40), needs: pub.needs };
  }
  const next = { class: e.class, token_env: String(e.token_env || (e.class === 'owner' ? 'PRESS_BUFFER_TOKEN' : 'PRESS_BUFFER_TOKEN_' + id.replace(/[^a-z0-9]/g, '').toUpperCase().slice(-6))),
    source: (e.source && typeof e.source === 'object') ? { store: String(e.source.store || '').slice(0, 40) } : {},
    cadence: (e.cadence && typeof e.cadence === 'object') ? e.cadence : null,
    rails, at: new Date(o.now || Date.now()).toISOString(), rails_default: MESH_ID_RAIL_DEFAULTS[e.class] };
  r[id] = Object.assign({}, r[id] || {}, next);
  return { ok: true, id: id, identity: r[id], count: Object.keys(r).length, ignored_rails: ignored };
}

/** Company content, with the same rule as a shop's: a number may only appear if the facts handed in
 *  carry it, and a value line cites the place it is true. */
export function meshCompanyBeats(identity, facts, opt) {
  const o = opt || {}, f = facts || {}, now = o.now || Date.now(), day = Math.floor(now / DAY_MS);
  const lines = MESH_COMPANY_VALUE.filter((l) => l.path);
  const out = [];
  const per = Number(MESH_QUEUE_DEFAULTS.per_day) || 3;
  const take = Math.max(1, per - 1);
  for (let i = 0; i < take; i += 1) {
    const l = lines[(day + i) % lines.length];
    out.push({ kind: 'value', item_key: 'company:' + (day + i) % lines.length, text: l.text + ' — ' + l.path, source: l.path, rail: 'bluesky' });
  }
  if (Number(f.price_usd) > 0) {
    out.push({ kind: 'promo', item_key: 'company:price', rail: 'x',
      text: 'A storefront, orders on WhatsApp, books from the ledger, for ' + (Number(f.price_usd) || 0).toFixed(0) + ' US dollars a year'
        + (Number(f.free_days) > 0 ? ', with ' + f.free_days + ' days free first' : '') + '. ' + String(o.origin || '') + '/fees',
      posted_by: 'shop facts' });
  }
  const rails = Object.keys((identity && identity.rails) || {});
  const beats = out.map((b) => ({ ...b, to: rails.length ? rails : ['bluesky'], rails_from: rails.length ? 'identity' : 'default', auto_send: rails.some((r) => (MESH_PUBLISH[r] || {}).via === 'buffer' || (MESH_PUBLISH[r] || {}).via === 'direct') }));
  return { on: true, source: 'company', beats: beats.slice(0, per), blocked: Number(f.price_usd) > 0 ? [] : [{ why: 'no price in facts: a company promo cannot invent one either' }],
    human: 'replies_only', identity: (identity && identity.id) || 'owner' };
}

/** One run for one identity: compose, queue, send what is due, and write the outcome where health is
 *  judged from. The registry never sees a token; the env does, and a missing one is reported as a
 *  reason, not a failure of the run. */
export function meshPressLedger(prev, results, opt) {
  const o = opt || {}, st = (prev && typeof prev === 'object') ? prev : {};
  const rails = Object.assign({}, (st.rails && typeof st.rails === 'object') ? st.rails : {});
  for (const r of (results || [])) {
    const k = String(r.channel || 'unknown');
    if (r.status === 'sent') rails[k] = { ok: true, fails: 0, at: r.due || new Date(o.now || Date.now()).toISOString(), id: r.id };
    else if (r.status === 'failed') rails[k] = { ok: false, fails: (Number((rails[k] || {}).fails) || 0) + 1, at: new Date(o.now || Date.now()).toISOString(), err: String(r.err || r.note || '').slice(0, 160) };
  }
  const hist = ((st.history && Array.isArray(st.history)) ? st.history : []).concat([{ at: new Date(o.now || Date.now()).toISOString(),
    sent: (results || []).filter((r) => r.status === 'sent').length, queued: (results || []).filter((r) => r.status === 'queued').length }]).slice(-30);
  return { rails, history: hist, yield: hist.reduce((a, h) => a + (Number(h.sent) || 0), 0) };
}

/** Which material an identity posts. A shop-fed identity uses that shop's facts when there are facts; if
 *  the menu is empty, missing or broken, the identity still has something to say, because a registered
 *  seller who posts nothing is a registered seller doing nothing — and the fallback is company material,
 *  which is what a reseller is actually reselling. Silence is a state to report, never a plan to ship. */
export function meshIdentityPlan(identity, storePlan, facts, opt) {
  const o = opt || {}, e = identity || {};
  const fromStore = (storePlan && Array.isArray(storePlan.beats)) ? storePlan.beats.filter((b) => b && b.text) : [];
  if (fromStore.length) return Object.assign({ source: 'store', identity: e.id || '' }, storePlan, { beats: fromStore });
  const comp = meshCompanyBeats(e, facts, o);
  return Object.assign({}, comp, { source: 'company', fallback_from: (storePlan && e.source && e.source.store) ? String(e.source.store) : '',
    blocked: (comp.blocked || []).concat((storePlan && storePlan.blocked) || []) });
}
