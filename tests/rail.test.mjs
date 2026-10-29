import './fixtures/clock.mjs'; // first: a steady clock, see the file
import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../worker/rail.js';
import * as CORE from '../worker/core.js';

test('the rail layer never holds money: no balance, no payout, no custody', () => {
  // The doctrine, asserted rather than remembered. If any export grows a payout verb, this fails.
  const names = Object.keys(R).join(' ').toLowerCase();
  for (const forbidden of ['payout', 'withdraw', 'balance', 'topup', 'top_up', 'custodywallet']) {
    assert.ok(!names.includes(forbidden), 'a rail export named ' + forbidden + ' is the lane we refuse');
  }
  const cat = R.railCatalogue({ coreRails: CORE.RAILS });
  assert.ok(cat.length >= 10, 'the catalogue carries the rails the shop already has');
  for (const rail of cat) assert.equal(rail.custody, 'none', rail.key + ' must never imply custody');
});

test('one catalogue shapes built-ins, operator extras and processors the same way', () => {
  const cat = R.railCatalogue({
    coreRails: CORE.RAILS,
    extras: { mpesa: { label: 'M-Pesa', dial: '*334#', spec: 'phone', proof: 'ask', pct: 0.012 } },
    collect: { nowpayments: { label: 'NOWPayments', type: 'collect', ipn: true, presentable: true } },
  });
  const mpesa = R.railFor(cat, 'mpesa');
  assert.ok(mpesa, 'an operator rail is a rail, not a special case');
  assert.equal(mpesa.source, 'operator');
  assert.equal(mpesa.kind, 'manual');
  assert.equal(mpesa.presentable, true);
  assert.equal(mpesa.machine_confirmable, false, 'a manual rail is proven by a human, not by us pretending');

  const np = R.railFor(cat, 'collect:nowpayments');
  assert.ok(np, 'a processor rides the same shape');
  assert.equal(np.source, 'processor');
  assert.equal(np.machine_confirmable, true, 'an IPN-capable processor can confirm itself');
  assert.equal(np.tolerance_pct, 0.01, 'the adopted 1% stablecoin tolerance survives shaping');

  // a built-in wins over an extra of the same key, so a shop cannot shadow EcoCash
  const shadow = R.railCatalogue({ coreRails: CORE.RAILS, extras: { cash: { label: 'Not cash' } } });
  assert.equal(R.railFor(shadow, 'cash').source, 'built-in');
});

test('odd cents stay a reference: unique, retried on collision, and freed by the TTL', () => {
  const now = Date.UTC(2026, 9, 21, 6);
  const a = R.allocateCents(12.0, { shopSeed: 'mamatoe', nowMs: now });
  assert.equal(a.pay, 12 + a.cents, 'the payer sends the base plus the cents');
  assert.ok(a.cents > 0 && a.cents <= 0.97, 'never zero, never more than the modulo');

  // the second buyer with the same total gets a different number — which is the whole point
  const b = R.allocateCents(12.0, { shopSeed: 'mamatoe', nowMs: now, taken: [{ cents: a.cents, at: now }] });
  assert.notEqual(b.cents, a.cents);

  // a reference older than the TTL is not "taken" any more
  const old = now - (R.REF_TTL_SEC + 60) * 1000;
  const c = R.allocateCents(12.0, { shopSeed: 'mamatoe', nowMs: now, taken: [{ cents: a.cents, at: old }] });
  assert.equal(c.cents, a.cents, 'expired references return to the pool');

  // a shop that turned unique cents off gets the plain total, and says why
  const off = R.allocateCents(12.0, { unique: false });
  assert.equal(off.pay, 12);
  assert.equal(off.reason, 'shop_turned_unique_off');
  assert.equal(R.allocateCents(0).reason, 'nothing_to_allocate');
});

test('a payment event is a fact with an id, and a webhook that arrives twice writes once', () => {
  const e = R.paymentEvent({ kind: 'matched', amount: 12.43, order: 'MAM-1042', rail: 'ecocash_usd', reference: 'ABC123', at: 1 });
  assert.equal(e.kind, 'matched');
  assert.equal(e.amount, 12.43);
  assert.ok(e.id.length > 5);
  // the same fact, typed twice a minute apart, is the same event
  const again = R.paymentEvent({ kind: 'matched', amount: 12.43, order: 'MAM-1042', rail: 'ecocash_usd', reference: 'ABC123', at: 999 });
  assert.equal(again.id, e.id, 'idempotency keys on what happened, not when it was typed');
  const first = R.appendPaymentEvent(null, e);
  assert.equal(first.wrote, true);
  const twice = R.appendPaymentEvent(first.doc, e);
  assert.equal(twice.wrote, false, 'idempotent by id, not by hope');
  assert.equal(twice.doc.events.length, 1);

  assert.throws(() => R.paymentEvent({ kind: 'nonsense', amount: 1 }), /unknown payment event/);
  assert.throws(() => R.paymentEvent({ kind: 'seen' }), /needs an amount/);
});

test('the settlement statement separates what the book expects from what the money says', () => {
  const rows = [
    { id: 'a', at: Date.UTC(2026, 9, 21, 6), status: 'paid', pay_now: 12.43, rail: 'ecocash_usd', fee: 0.17 },
    { id: 'b', at: Date.UTC(2026, 9, 21, 7), status: 'new', pay_now: 6.01, rail: 'ecocash_usd', fee: 0.08 },
    { id: 'c', at: Date.UTC(2026, 9, 21, 8), status: 'cancelled', pay_now: 3, rail: 'cash', fee: 0 },
    { id: 'd', at: Date.UTC(2026, 9, 21, 9), status: 'paid', pay_now: 45, rail: 'payshap', fee: 0.22 },
  ];
  const events = [
    R.paymentEvent({ kind: 'matched', amount: 12.43, order: 'a', rail: 'ecocash_usd', at: Date.UTC(2026, 9, 21, 6) }),
    R.paymentEvent({ kind: 'unmatched', amount: 5, rail: 'ecocash_usd', at: Date.UTC(2026, 9, 21, 7) }),
    R.paymentEvent({ kind: 'refunded', amount: 2, order: 'a', rail: 'ecocash_usd', at: Date.UTC(2026, 9, 21, 10) }),
    R.paymentEvent({ kind: 'matched', amount: 45, order: 'd', rail: 'payshap', at: Date.UTC(2026, 9, 21, 9) }),
  ];
  const s = R.settlement(rows, events, { day: '2026-10-21' });
  assert.equal(s.totals.expected, 63.44, 'a cancelled order is not expected money');
  assert.equal(s.totals.cancelled, 3);
  assert.equal(s.totals.matched, 57.43);
  assert.equal(s.totals.unmatched, 5, 'money with no home is a queue, and it is shown');
  assert.equal(s.totals.refunded, 2);
  assert.equal(s.totals.fees, 0.47);
  assert.equal(s.totals.net, 54.96, 'net is matched minus refunds minus the rails’ own fees');
  assert.equal(s.totals.awaiting_match, 4.01, 'the number a merchant should act on');
  assert.ok(s.per_rail.length >= 2);
  assert.match(s.note, /not matched yet/);

  const csv = R.settlementCsv(s, { handle: 'mamatoe' });
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, s.per_rail.length + 2, 'a header, one line per rail, one total');
  assert.match(lines[0], /^"shop","window","rail"/);
  assert.match(csv, /"TOTAL"/);
  assert.equal(csv.trim().split('\n')[0].split(',').length, 11, 'the columns and the rows cannot drift');

  // a day with nothing in it still answers, rather than throwing
  const quiet = R.settlement([], [], { day: '2026-10-22' });
  assert.equal(quiet.totals.expected, 0);
  assert.match(quiet.note, /Every expected amount is matched/);
});

test('vetting gates a cross-border leg without blocking a shop’s own money', () => {
  const st = { handle: 'mamatoe' };
  const empty = R.vettingPlan(st, {});
  assert.equal(empty.ready, false);
  assert.equal(empty.can_take_local, false);
  assert.equal(empty.can_collect_cross_border, false);

  // the light checklist: rails, refunds, records
  const local = R.vettingPlan(st, { rails: true, refunds: true, records: { ok: true, evidence: 'policy.pdf' } });
  assert.equal(local.can_take_local, true, 'a shop can take its own money with three answers');
  assert.equal(local.can_collect_cross_border, false, 'but a processor wants identity and sanctions');

  const full = R.vettingPlan(st, { rails: true, refunds: true, records: true, identity: 'Mama Too Catering (t/a)', contact: '+263 77 000 0000', sanctions: true });
  assert.equal(full.ready, true);
  assert.equal(full.can_collect_cross_border, true);
  assert.equal(full.steps.length, 6);
  for (const s of full.steps) assert.equal(s.years, 5, 'every step carries the records clock');
});

test('a refund cannot jump states, and the evidence trail is never deleted', () => {
  assert.equal(R.refundTransition('requested', 'sent').ok, false);
  assert.equal(R.refundTransition('requested', 'approved').ok, true);
  assert.equal(R.refundTransition('approved', 'sent').ok, true);
  assert.equal(R.refundTransition('sent', 'disputed').ok, true);
  assert.equal(R.refundTransition('disputed', 'resolved').ok, true);
  assert.equal(R.refundTransition('closed', 'approved').ok, false);
  const t = R.refundTransition('closed', 'approved');
  assert.match(t.note, /closed/);

  const at = Date.UTC(2026, 9, 21);
  assert.equal(R.retentionHolds({ at }, at + 4 * 365 * 86400000), true);
  assert.equal(R.retentionHolds({ at }, Date.UTC(2032, 0, 1)), false, 'five years, then the clock is done');
});

test('the collect leg locks the price server-side and never calls an underpayment paid', () => {
  const draft = R.collectInvoiceDraft({ provider: 'nowpayments', amount: 45, order: 'MAM-1042', ipnUrl: 'https://x/api/hook/nowpayments' });
  assert.equal(draft.ok, true);
  assert.equal(draft.payload.price_amount, 45);
  assert.equal(draft.payload.price_currency, 'usd');
  assert.equal(draft.payload.order_id, 'MAM-1042');
  assert.equal(draft.payload.is_fee_paid_by_user, false);
  assert.equal(draft.tolerance_pct, 0.01);

  assert.equal(R.collectInvoiceDraft({ amount: 0, order: 'x' }).error, 'amount_required');
  assert.equal(R.collectInvoiceDraft({ amount: 5, order: '' }).error, 'order_required');
  assert.equal(R.collectInvoiceDraft({ provider: 'nope', amount: 5, order: 'x' }).error, 'unknown_provider');

  assert.equal(R.collectSettlement({ price: 45, paid: 45, status: 'finished' }).ok, true);
  assert.equal(R.collectSettlement({ price: 45, paid: 44.8, status: 'finished' }).ok, true, 'within the adopted 1% band');
  const short = R.collectSettlement({ price: 45, paid: 40, status: 'finished' });
  assert.equal(short.ok, false);
  assert.equal(short.reason, 'underpaid');
  assert.equal(short.shortfall, 5);
  assert.equal(R.collectSettlement({ price: 45, paid: 45, status: 'waiting' }).reason, 'not_settled');
  assert.equal(R.collectSettlement({ price: 45, paid: 50, status: 'finished' }).reason, 'overpaid');
});

test('a webhook is a claim until its signature checks out, on the raw body', async () => {
  const secret = 'test-secret';
  const body = '{"payment_status":"finished","price_amount":45,"order_id":"MAM-1042"}';
  const sig = await R.hmacSha256Hex(secret, body);
  assert.equal(sig.length, 64);

  const good = await R.verifyWebhook(secret, body, 'sha256=' + sig);
  assert.equal(good.ok, true);

  const bad = await R.verifyWebhook(secret, body, 'sha256=' + '0'.repeat(64));
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad_signature');

  // re-serialising the JSON breaks the HMAC — the exact bug the adopted engines had to fix
  const spaced = '{ "payment_status": "finished", "price_amount": 45, "order_id": "MAM-1042" }';
  const spacedSig = await R.hmacSha256Hex(secret, spaced);
  const drift = await R.verifyWebhook(secret, JSON.stringify(JSON.parse(spaced)), 'sha256=' + spacedSig);
  assert.equal(drift.ok, false, 'a re-serialised body must not verify');

  assert.equal((await R.verifyWebhook('', body, 'x')).reason, 'no_secret_configured');
  assert.equal((await R.verifyWebhook(secret, body, '')).reason, 'no_signature');
});

test('the rail layer is wired into the Worker behind the admin gate, and the webhook is not', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const w = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'worker/worker.js'), 'utf8');

  // every rail route exists…
  for (const route of ['/api/settle', '/api/settle/event', '/api/rail', '/api/rail/vet', '/api/collect/invoice', '/api/hook/nowpayments']) {
    assert.ok(w.includes("'" + route + "'"), 'no route for ' + route);
  }
  // …the merchant-facing ones all pass through adminGate…
  for (const fn of ['settleView', 'settleEvent', 'railView', 'railVet', 'collectInvoice']) {
    const at = w.indexOf('async function ' + fn);
    assert.ok(at > 0, fn + ' is missing');
    const body = w.slice(at, at + 1200);
    assert.ok(body.includes('adminGate'), fn + ' must not answer without a login');
  }
  // …and the webhook trusts nobody: raw body, signature, then a ledger event
  const hook = w.slice(w.indexOf('async function hookNowPayments'), w.indexOf('async function hookNowPayments') + 1600);
  assert.match(hook, /await req\.text\(\)/, 'the raw body is required, not a re-serialised copy');
  assert.match(hook, /verifyWebhook\(env\.NOWPAYMENTS_IPN_SECRET/);
  assert.match(hook, /paymentEvent\(/, 'an IPN writes a ledger event');
  assert.ok(!/status:\s*'paid'|marked_at/.test(hook), 'an IPN must never close an order by itself');

  // the collect leg refuses honestly when no processor key is configured
  assert.match(w, /collect_not_configured/);
  assert.match(w, /Only this shop’s own orders can be invoiced/, 'the amount comes from the order, never from the page');
  // and no route can move money out
  assert.ok(!/payout|withdraw/i.test(w.slice(w.indexOf('/api/settle'), w.indexOf('/api/hook/nowpayments'))), 'no payout verb in the rail routes');
});
