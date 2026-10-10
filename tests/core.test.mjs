import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../worker/core.js';

/* ---------- CSV parsing (the merchant's Google Sheet) ---------- */
test('parseCSV: quoted fields, doubled quotes, embedded commas/newlines', () => {
  const rows = C.parseCSV('a,b\n"x, y","he said ""hi""\nnext"\n');
  assert.deepEqual(rows[0], ['a', 'b']);
  assert.deepEqual(rows[1], ['x, y', 'he said "hi"\nnext']);
});

test('normalizeFeedUrl: sheets link -> CSV, keeps gid', () => {
  const id = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
  const u = C.normalizeFeedUrl('https://docs.google.com/spreadsheets/d/' + id + '/edit#gid=42');
  assert.match(u, /gviz\/tq\?tqx=out:csv&gid=42$/);
  assert.equal(C.normalizeFeedUrl('not a url'), null);
  assert.equal(C.normalizeFeedUrl('https://example.com/menu.csv'), 'https://example.com/menu.csv');
});

test('parseProducts: quoting, types, options, addons, sold out, help row, BOM', () => {
  // options field legitimately contains commas -> must be a quoted CSV field ("" doubles)
  const csv = '\uFEFFid,name,category,price,options,addons,stock,popular\n' +
    'p1,Chicken,Main,5.50,"Size:Small:0,Medium:1.5,Large:3","Extra meat:3|Django:1.5",,yes\n' +
    'HELP row,,,,,,,,\n' +
    'p2,Ice cream,Desserts,2,Spice:hot,mild,no,\n';
  const p = C.parseProducts(csv, { currency: 'USD' });
  assert.equal(p.length, 2, 'HELP row must be skipped');
  assert.equal(p[0].name, 'Chicken');
  assert.equal(p[0].price, 5.5);
  assert.equal(p[0].popular, true);
  assert.equal(p[0].opts.length, 1, 'one option group named Size');
  assert.deepEqual(p[0].opts[0].choices,
    [{ label: 'Small', up: 0 }, { label: 'Medium', up: 1.5 }, { label: 'Large', up: 3 }],
    'fully-priced choice list becomes {label,up}');
  assert.deepEqual(p[1].opts[0].choices, [{ label: 'hot', up: 0 }], 'a plain choice list still parses, up=0');
  assert.deepEqual(p[0].addons, [{ name: 'Extra meat', price: 3 }, { name: 'Django', price: 1.5 }]);
  assert.equal(p[1].available, false, 'stock=no marks sold out');
  assert.equal(p[1].id, 'p2');

  const priced = C.priceOrder({ surcharge_mode: 'absorb', tax_pct: 0 },
    [{ price: 5.5, qty: 1, name: 'Chicken', options: [{ name: 'Medium', up: 1.5 }], addons: [3] }], 'pickup', 'cash');
  assert.equal(priced.lines[0].unit, 10, '5.5 + 1.5 option + 3 addon');
});

/* ---------- pricing ---------- */
test('priceOrder: line math with option upsell and addons', () => {
  const p = C.priceOrder({ surcharge_mode: 'absorb', tax_pct: 0 }, [
    { name: 'Burger', price: 8, qty: 2, options: [{ name: 'Large', up: 2 }], addons: [1.5] },
  ], 'pickup', 'cash');
  assert.equal(p.itemsTotal, 23, '2 x (8+2+1.5) = 23');
  assert.equal(p.total, 23);
  assert.equal(p.lines[0].unit, 11.5);
});

test('priceOrder: VAT 15.5% applies to items + delivery, not to the fee', () => {
  const p = C.priceOrder({ tax_pct: 15.5, delivery_fee: 2, surcharge_mode: 'absorb' }, [{ price: 10, qty: 1, name: 'x' }], 'delivery', 'cash');
  assert.equal(p.tax, 1.86, '(10+2)*0.155 = 1.86');
  assert.equal(p.subtotal, 13.86);
});

test('priceOrder: free_over zeroes delivery', () => {
  const withFee = C.priceOrder({ delivery_fee: 5, free_over: 50 }, [{ price: 10, qty: 1, name: 'x' }], 'delivery', 'cash');
  const free = C.priceOrder({ delivery_fee: 5, free_over: 50 }, [{ price: 60, qty: 1, name: 'x' }], 'delivery', 'cash');
  assert.equal(withFee.delivery, 5);
  assert.equal(free.delivery, 0);
});

test('priceOrder: EcoCash rail cost includes the 2% IMTT that take.app cannot surcharge in Zim', () => {
  const p = C.priceOrder({ surcharge_mode: 'absorb' }, [{ price: 100, qty: 1, name: 'x' }], 'pickup', 'ecocash_usd');
  // 1.4% operator + 2% IMTT on 100 = 3.40 absorbed by the merchant
  assert.equal(p.fee_absorbed_by_merchant, 3.4);
  assert.equal(p.total, 100, 'absorb mode must not change what the customer pays');
});

test('priceOrder: pass mode moves the rail cost onto the order', () => {
  const p = C.priceOrder({ surcharge_mode: 'pass', tax_pct: 0 }, [{ price: 100, qty: 1, name: 'x' }], 'pickup', 'payfast');
  assert.equal(p.fee, 3.9, '2.9% + R1.00 on 100');
  assert.equal(p.total, 103.9);
});

test('priceOrder: cash/COD has no rail fee in either mode', () => {
  for (const mode of ['pass', 'absorb']) {
    const p = C.priceOrder({ surcharge_mode: mode }, [{ price: 50, qty: 1, name: 'x' }], 'delivery', 'cash');
    assert.equal(p.fee, 0); assert.equal(p.fee_absorbed_by_merchant, 0);
  }
});

test('unique cents: spread without inflating, and never more than $0.96', () => {
  const seen = new Map();
  for (let i = 0; i < 300; i++) {
    const total = 10 + i * 0.05;
    const p = C.priceOrder({ surcharge_mode: 'absorb' }, [{ price: total, qty: 1, name: 'x' }], 'pickup', 'ecocash_usd');
    assert.ok(p.pay_now >= p.total, 'must never collect less than the total');
    assert.ok(p.pay_now - p.total <= 0.97, 'jitter must stay small: ' + (p.pay_now - p.total));
    assert.ok(Math.abs(p.pay_now * 100 - Math.round(p.pay_now * 100)) < 1e-9, 'two decimals only');
    seen.set(p.pay_now, (seen.get(p.pay_now) || 0) + 1);
  }
  assert.ok(seen.size > 250, 'distinct totals should mostly produce distinct pay_now; got ' + seen.size);
  // documented limitation: two concurrent orders of the same total share an amount
  const a = C.priceOrder({}, [{ price: 20, qty: 1, name: 'x' }], 'pickup', 'cash');
  const b = C.priceOrder({}, [{ price: 20, qty: 1, name: 'x' }], 'pickup', 'cash');
  assert.equal(a.pay_now, b.pay_now, 'same total => same amount, so the reference code stays the tie-breaker');
});

test('paid orders get their own payment instructions object', () => {
  const st = { currency: 'USD', pay_account: '0771234567', reference_format: '{code}/{id}' };
  const pricing = C.priceOrder(st, [{ price: 5, qty: 1, name: 'x' }], 'pickup', 'innbucks');
  const pay = C.payInstructions(st, { code: 'IN-9', id: 'abcdef123456' }, pricing);
  assert.equal(pay.reference, 'IN-9/123456', 'reference = code + last 6 of order id');
  assert.match(pay.steps.join(' '), /155\*4#/);
});

test('unique_change:false falls back to the plain total', () => {
  const p = C.priceOrder({ unique_change: false }, [{ price: 12, qty: 1, name: 'x' }], 'pickup', 'cash');
  assert.equal(p.pay_now, p.total);
  assert.equal(C.uniqueAmount(12, false), 12);
});

test('quantity clamps to sane bounds', () => {
  const p = C.priceOrder({}, [{ price: 1, qty: 999, name: 'x' }], 'pickup', 'cash');
  assert.equal(p.lines[0].qty, 99);
});

/* ---------- fraud flags ---------- */
test('riskFlags: repeat unpaid buyer, high-value COD delivery, missing pay account', () => {
  const rail = { type: 'manual' };
  assert.deepEqual(C.riskFlags({}, { service: 'pickup', pricing: { total: 5, rail } }, { unpaid: 3 }),
    ['repeat_unpaid_buyer', 'merchant_pay_account_not_set']);
  const f = C.riskFlags({ cod_review_above: 80, pay_account: '' }, { service: 'delivery', pricing: { total: 200, rail } }, {});
  assert.ok(f.includes('high_value_cod_review_before_sending'));
  assert.ok(f.includes('merchant_pay_account_not_set'));
  assert.deepEqual(C.riskFlags({ pay_account: '0771234567' }, { service: 'pickup', pricing: { total: 5, rail: { type: 'manual' } } }, { unpaid: 0 }), []);
});

/* ---------- receipts ---------- */
test('payInstructions: unique amount, reference, and no screenshot dependency', () => {
  const st = { currency: 'USD', pay_account: '077 123 4567', rail: 'ecocash_usd' };
  const pricing = C.priceOrder(st, [{ price: 14.5, qty: 1, name: 'x' }], 'pickup', 'ecocash_usd');
  const pay = C.payInstructions(st, { code: 'MAM-0007' }, pricing);
  assert.equal(pay.amount, pricing.pay_now);
  assert.equal(pay.reference, 'MAM-0007');
  assert.match(pay.account, /077 123 4567/);
  assert.match(pay.steps.join(' '), /151/);
});

test('waSummary contains code, buyer, totals and payment line', () => {
  const st = { currency: 'USD', pay_account: '0771234567' };
  const pricing = C.priceOrder(st, [{ price: 5, qty: 2, name: 'Sadza' }], 'pickup', 'ecocash_usd');
  const txt = C.waSummary(st, { code: 'A-1', buyer: { name: 'Rudo' }, items: [{ qty: 2, name: 'Sadza' }], service: 'pickup', when: 'asap', pricing });
  assert.match(txt, /A-1/); assert.match(txt, /Rudo/); assert.match(txt, /2x Sadza/);
  assert.match(txt, new RegExp('Pay ' + String(pricing.pay_now).replace('.', '\\.') + ' to 0771234567 ref A-1'));
});

/* ---------- privacy ---------- */
test('publicStore never leaks secrets into the customer page', () => {
  const st = { handle: 'x', shop_name: 'S', admin_token: 'SECRET', notify_email: 'a@b.c', owner_email: 'o@b.c', notify_webhook: 'https://hook', feed_url: 'https://sheet', feed_cache: { products: [1] }, paid_until: 1 };
  const out = JSON.stringify(C.publicStore(st));
  for (const leak of ['SECRET', 'a@b.c', 'o@b.c', 'https://hook', 'feed_cache', 'feed_url']) {
    assert.ok(!out.includes(leak), 'leaked ' + leak);
  }
  assert.ok(out.includes('"shop_name"'));
});

test('slug + handle validation', () => {
  assert.equal(C.slug('Mama Tunde  Kitchen!'), 'mama-tunde-kitchen');
  assert.equal(C.validHandle('mama-tunde'), true);
  assert.equal(C.validHandle('A'), false);
  assert.equal(C.validHandle('-lead'), false);
});
