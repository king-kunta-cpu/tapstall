import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../worker/core.js';
const { sanitizeMenu, sanitizeMenuEdit, applyMenu, menuPrice } = C;

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
  assert.match(txt, new RegExp('Pay ' + String(pricing.pay_now).replace('.', '\\.') + ' USD to 0771234567 ref A-1'));
  // The currency is on the line because a ZiG quote and a USD payment are one
  // WhatsApp message apart, and this summary is that message.
  assert.match(txt, /USD/);
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

/* ---------- capability tokens: the thing that replaced the URL master key ---------- */
const SEC = 'unit-secret';
test('a capability round-trips and carries its payload', async () => {
  const cap = await C.issueCap(SEC, { a: 'mark', h: 'shop', id: 'o9', s: 'paid' }, 900);
  assert.equal(cap.split('.').length, 4, 'v1.<exp>.<payload>.<tag>');
  const p = await C.verifyCap(SEC, cap);
  assert.deepEqual({ a: p.a, h: p.h, id: p.id, s: p.s }, { a: 'mark', h: 'shop', id: 'o9', s: 'paid' });
  assert.ok(p.exp >= Math.floor(Date.now() / 1000) + 800, 'expiry attached');
});

test('a capability dies on tamper, on expiry, on another secret and on garbage', async () => {
  const cap = await C.issueCap(SEC, { a: 'sess', h: 'shop' }, 900);
  assert.equal(await C.verifyCap(SEC, cap.slice(0, -2) + 'xy'), null, 'edited tag');
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const seg = cap.split('.'); seg[2] = b64u({ a: 'sess', h: 'other-shop' });
  assert.equal(await C.verifyCap(SEC, seg.join('.')), null, 'payload swapped for another store, tag recomputed by hand');
  assert.equal(await C.verifyCap('other-secret', cap), null, 'other master secret');
  const far = Math.floor(Date.now() / 1000) + 100000;
  assert.equal(await C.verifyCap(SEC, cap, far), null, 'expired');
  for (const junk of ['', 'x', 'v1', 'v1.1.2.3.4', 'v1.9999999999.@@@.tag', 'v2.1.2.3']) {
    assert.equal(await C.verifyCap(SEC, junk), null, 'no throw on: ' + junk);
  }
});

test('a minimum TTL keeps a link usable even if a caller asks for seconds', async () => {
  const cap = await C.issueCap(SEC, { a: 'mark' }, 1);
  const p = await C.verifyCap(SEC, cap);
  assert.ok(p && p.exp - Math.floor(Date.now() / 1000) >= 290, 'floored at 5 minutes');
});

/* ---------- sign: what the outbound webhook proves ---------- */
test('sign is deterministic and secret-bound', async () => {
  const a = await C.sign(SEC, '{"type":"order.new"}');
  assert.equal(a, await C.sign(SEC, '{"type":"order.new"}'), 'same message, same tag');
  assert.notEqual(a, await C.sign('other', '{"type":"order.new"}'), 'other secret, other tag');
  assert.match(a, /^[A-Za-z0-9_-]{20,}$/, 'url-safe');
});

/* ---------- the settings gate ---------- */
test('validateSettings splits cosmetic from money and names bad fields', () => {
  const v = C.validateSettings({ hours: '9-5', closed: true, pay_account: '078', tax_pct: 2, rail: 'payfast', junk: 1 }, 5);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(v.soft, { hours: '9-5', closed: true });
  assert.equal(v.money.rail, 'payfast');
  assert.equal(v.money.pay_account, '078', 'a payout number is never "cosmetic"');
  assert.deepEqual(v.ignored, ['junk'], 'unknown keys are reported, not stored');
  const bad = C.validateSettings({ feed_url: 'not-a-url', zig_rate: -3 }, 5);
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['feed_url', 'zig_rate']);
});

test('a held change merges with an earlier one instead of overwriting it', () => {
  const st = { rail: 'cash', pay_account: 'A', whatsapp: '771', hours: 'x' };
  C.stageSettings(st, {}, { pay_account: 'B' }, 900e3, 1000);
  C.stageSettings(st, {}, { whatsapp: '772' }, 900e3, 60_000);
  assert.deepEqual(Object.keys(st.pending.fields).sort(), ['pay_account', 'whatsapp'], 'both still queued');
  assert.equal(st.pending.apply_at, 60_000 + 900_000, 'the window restarts from the newest save');
  assert.equal(st.pay_account, 'A', 'nothing landed');
  const early = C.applyPending(st, 959000);
  assert.equal(early.applied.length, 0, 'not before the hold is up');
  assert.equal(early.pending.in_ms, 1000, 'and the caller is told how long is left');
  const late = C.applyPending(st, 961000);
  assert.deepEqual(late.applied.sort(), ['pay_account', 'whatsapp']);
  assert.equal(st.pay_account, 'B');
  assert.equal(st.whatsapp, '772');
  assert.equal(st.pending, undefined, 'queue drained');
});

test('the queue is empty for a soft-only save, so the dashboard shows no banner', () => {
  const st = { hours: 'old' };
  const r = C.stageSettings(st, { hours: 'new' }, {}, 900e3, 1000);
  assert.equal(r.changed, 1);
  assert.equal(r.staged, 0);
  assert.equal(st.pending, undefined);
  assert.equal(C.applyPending(st, 5000).pending, null, 'nothing to land');
});

test('masks keep the audit readable and the values unreadable', () => {
  assert.equal(C.maskField('pay_account', '0771234567'), '•••4567');
  assert.equal(C.maskField('whatsapp', '263771234567'), '•••4567');
  assert.equal(C.maskField('notify_email', 'merchant@example.com'), 'm***@example.com');
  assert.equal(C.maskField('feed_url', 'https://docs.google.com/spreadsheets/d/1AbC/edit?usp=sharing'), 'docs.google.com', 'a sheet link is its host, nothing else');
  assert.equal(C.maskField('notify_webhook', 'https://hooks.zapier.com/x/y'), 'hooks.zapier.com');
  assert.equal(C.maskField('hours', 'Tue-Sat 9-6'), 'Tue-…-6', 'cosmetic fields stay legible');
  assert.equal(C.maskField('pay_account', ''), '(blank)', 'a blanking is visible as a blanking');
});

test('publicStore also strips the dashboard and renew links', () => {
  const out = JSON.stringify(C.publicStore({ handle: 'x', admin_url: 'https://z/a?code=v1.1.2.3', renew_url: 'https://z/renew/abc', admin_token: 't' }));
  assert.ok(!out.includes('admin_url') && !out.includes('renew_url') && !out.includes('v1.1.2.3'), out);
});

test('publicStore is an allowlist, so a new field is private by default', () => {
  const st = { handle: 'x', shop_name: 'S', pay_account: '0771', pending: { fields: { pay_account: 'EVIL' } }, auth_gen: '7', admin_url: 'https://z/a?code=v1', new_secret_field: 'oops' };
  const out = JSON.stringify(C.publicStore(st));
  for (const bad of ['EVIL', 'pending', 'auth_gen', 'admin_url', 'new_secret_field']) {
    assert.ok(!out.includes(bad), 'leaked ' + bad);
  }
  assert.equal(JSON.parse(out).pay_account, '0771', 'the buyer-facing fields stay');
  const admin = JSON.stringify(C.adminStore(st));
  assert.ok(!admin.includes('admin_url') && !admin.includes('auth_gen') && !admin.includes('"pending"'), 'the owner payload drops credentials too');
  assert.ok(admin.includes('new_secret_field'), 'but shows the owner their own record');
});

/* ------------------------------------------------------------- the store's menu
 * A dashboard that edits items is only safe if the server re-prices from what it
 * stored, so these tests are the boundary: what may be written, how it merges, and
 * that a cart's numbers do not survive contact with it.
 * -------------------------------------------------------------------------- */
test('sanitizeMenu keeps only what applyMenu can use', () => {
  const m = sanitizeMenu({
    over: { a: { price: '12.50', out: 'true', name: '  Trimmed  ' }, b: {}, junk: { price: 'x' } },
    hide: ['c', 42, ''], extra: [{ name: 'Goat', price: 40, cat: 'S' }, { name: '', price: 5 }],
    order: ['b', 'a', 'b'], note: 'y'.repeat(900),
  });
  assert.equal(m.over.a.price, 12.5, 'a price typed as text is still a price');
  assert.equal(m.over.a.available, false, 'out:true becomes available:false');
  assert.equal(m.over.a.name, 'Trimmed');
  assert.ok(!m.over.b, 'an empty edit is dropped, not stored as a row of defaults');
  assert.ok(!m.over.junk, 'a row with no id-relevant field is dropped');
  assert.deepEqual(m.hide, ['c', '42'], 'hide is a list of ids and only ids');
  assert.equal(m.extra.length, 1, 'an item with no name cannot be added');
  assert.deepEqual(m.order, ['b', 'a'], 'order is deduped');
  assert.equal(m.note.length, 160, 'the note is clamped, not whatever was posted');
  assert.equal(sanitizeMenu(null).set_at ? 1 : 0, 1, 'a missing body is still a valid empty menu');
});

test('a price-only edit survives the round trip — the common case', () => {
  const m = sanitizeMenu({ over: { chicken: { price: 8.5 } } });
  const merged = applyMenu([{ id: 'chicken', name: 'Chicken & rice', price: 5.5, available: true }], m);
  assert.equal(merged[0].price, 8.5, 'no name in the payload must not lose the price');
  assert.equal(merged[0].edited, true);
});

test('applyMenu merges without touching the rows it was given', () => {
  const sheet = [{ id: 'a', name: 'A', price: 1, available: true }, { id: 'b', name: 'B', price: 2, available: false }];
  const frozen = JSON.stringify(sheet);
  const out = applyMenu(sheet, { over: { a: { price: 5 } }, extra: [{ id: 'x', name: 'X', price: 9 }], hide: ['b'] });
  assert.equal(JSON.stringify(sheet), frozen, 'the cached sheet rows are never mutated by an edit');
  assert.deepEqual(out.map((p) => p.id), ['a', 'x']);
  assert.equal(out[0].price, 5);
  assert.ok(out.every((p) => p !== undefined));
});

test('menuPrice re-prices a cart instead of trusting it', () => {
  const menu = [{ id: 'a', name: 'A', price: 5.5, available: true, opts: [{ name: 'Size', choices: [{ label: 'S' }, { label: 'L', up: 2 }] }], addons: [{ name: 'Cheese', price: 1.5 }] }];
  const bad = menuPrice(menu, [{ id: 'a', name: 'A', price: 0.01, qty: 2, options: [{ label: 'L', up: 99 }], addons: [{ name: 'Cheese', price: 99 }] }]);
  assert.equal(bad.authoritative, true);
  assert.equal(bad.items[0].price, 5.5, 'the line price comes from the menu');
  assert.equal(bad.items[0].options[0].up, 2, 'so does the option');
  assert.deepEqual(bad.items[0].addons, [1.5], 'so does the add-on, as a price list');
  assert.ok(bad.repriced, 'and the difference is reported');
  assert.ok(bad.notes.some((n) => /price/i.test(n) || /option/i.test(n)), 'with a note the merchant can read');

  const off = menuPrice(menu, [{ id: 'gone', name: 'Whatever', price: 1, qty: 1 }]);
  assert.equal(off.unknown, 1, 'an item that is not on this menu is counted');
  assert.ok(!off.authoritative || off.unknown, 'never silently accepted');

  const noMenu = menuPrice([], [{ id: 'a', name: 'A', price: 3, qty: 1 }]);
  assert.equal(noMenu.authoritative, false, 'a store with no menu on file cannot be held to one');
  assert.equal(noMenu.items[0].price, 3, 'its cart is passed through, flagged upstream instead of refused');

  const qty = menuPrice(menu, [{ id: 'a', price: 5.5, qty: 1e6 }]);
  assert.ok(qty.items[0].qty <= 99, 'a quantity is bounded on the way in too');
});

/* ------------------------------------------------ payment detail, per rail */
test('each rail takes the shape of number it actually uses', () => {
  assert.equal(C.cleanAcct('07712 34567', 'phone'), '0771234567', 'spaces are a typing artefact');
  assert.equal(C.cleanAcct('+263771234567', 'phone'), '+263771234567', 'a country code survives');
  assert.equal(C.cleanAcct('123-456-7890', 'bank'), '1234567890', 'dashes off a bank number');
  assert.equal(C.cleanAcct('', 'phone'), '', 'blank means use the default, not an error');
  assert.equal(C.cleanAcct('anything at all', 'none'), '', 'cash has no number, whatever was typed');
  for (const [v, kind] of [['12345', 'phone'], ['abc', 'bank'], ['ftp://x', 'link'], ['@@', 'wallet']]) {
    assert.throws(() => C.cleanAcct(v, kind), /[a-z]/, kind + ' refuses ' + v + ' in words');
    let msg = '';
    try { C.cleanAcct(v, kind); } catch (e) { msg = e.message; }
    assert.ok(msg.length > 8 && /\d|http/.test(msg), 'and the sentence says what it wanted: ' + msg);
  }
});

test('a rail map keeps only rails that exist and rows that say something', () => {
  const m = C.cleanRailAccts({
    ecocash_usd: { acct: '0771234567', holder: '  Mama   Too ', till: '*121*9#' },
    cash: { acct: 'no number needed' },
    nosuchrail: { acct: '0700' },
    zipit: { acct: '', holder: '', till: '' },
  }, null);
  assert.deepEqual(Object.keys(m), ['ecocash_usd'], 'an unregistered rail and an empty row are not stored');
  assert.equal(m.ecocash_usd.acct, '0771234567');
  assert.equal(m.ecocash_usd.holder, 'Mama Too', 'the name a buyer checks is collapsed, not mangled');
  assert.equal(C.cleanRailAccts({ cash: { acct: '' } }, null), undefined, 'a map of nothing is no map at all');
  const st = { pay_account: '0800000000', shop_name: 'Mama Too', rail: 'ozow', rail_accts: m };
  const own = C.railAcctOf(st, 'ecocash_usd', C.RAILS.ecocash_usd);
  assert.equal(own.acct, '0771234567'); assert.equal(own.own, true); assert.equal(own.till, '1219');
  const fb = C.railAcctOf(st, 'ozow', C.RAILS.ozow);
  assert.equal(fb.acct, '0800000000', 'a method with no number of its own uses the default');
  assert.equal(fb.own, false, 'and says so, which is what the dashboard prints');
});

test('the slip prints the number, the name to expect and the till', () => {
  const st = { currency: 'USD', shop_name: 'Mama Too', rail: 'ecocash_usd', pay_account: '0800000000',
               rail_accts: { ecocash_usd: { acct: '0771234567', holder: 'MAMA TOO CATERING', till: '55123' } } };
  const pricing = C.priceOrder(st, [{ price: 5, qty: 1, name: 'Sadza' }], 'pickup', 'ecocash_usd');
  const pay = C.payInstructions(st, { code: 'A-2', buyer: { payer: '0718663235' }, hours: { known: false } }, pricing);
  assert.equal(pay.account, '0771234567', 'the rail’s own number, not the default');
  assert.ok(pay.steps[1].includes('(till 55123)'), 'the till rides on the same line');
  assert.ok(pay.steps.some((t) => /MAMA TOO CATERING/.test(t)), 'and the name check is a step, not a hint');
  assert.equal(pay.ask_payer, true, 'a manual wallet asks who it is coming from');
  assert.equal(pay.payer_from, '0718663235', 'typed as typed, digits kept, no invented country code');
  const cod = C.payInstructions(st, { code: 'A-3', buyer: {} }, C.priceOrder(st, [{ price: 5 }], 'pickup', 'cash'));
  assert.equal(cod.account, 'pay on delivery');
  assert.equal(cod.ask_payer, false, 'nothing to match on cash');
});

test('the week is a week, and the sentence is printed from it', () => {
  const wk = C.cleanWeek([
    { open: '09:00', close: '17:00' }, { open: '09:00', close: '17:00' }, { open: '09:00', close: '17:00' },
    { open: '09:00', close: '17:00' }, { open: '09:00', close: '17:00' }, { open: '08:00', close: '13:00' }, null,
  ]);
  assert.equal(C.hoursText(wk), 'Mon–Fri 09:00-17:00 · Sat 08:00-13:00 · closed Sun');
  const one = C.cleanWeek([{ open: '09:00', close: '17:00' }, null, null, null, null, null, null]);
  assert.equal(one.length, 7, 'a week with one day open is still a full seven-day week');
  assert.match(C.hoursText(one), /^Mon 09:00-17:00 · closed Tue/);
  assert.equal(C.hoursText(C.cleanWeek([{ slots: [{ open: '06:30', close: '10:00' }, { open: '18:00', close: '21:30' }, { open: '22:00', close: '23:00' }] }])), 'Mon 06:30-10:00 & 18:00-21:30 · closed Tue Wed Thu Fri Sat Sun', 'two slots a day, the third dropped');
  // One unreadable box must not be silently read as "closed": that is how a typo
  // deletes a shop's hours and nobody notices until the phone will not ring.
  assert.throws(() => C.cleanWeek(['nonsense', null, null, null, null, null, null]), /both ends/);
  assert.throws(() => C.cleanWeek([{ open: '99:99', close: '08:00' }]), /both ends/, '99:99 is not a time');
  assert.throws(() => C.cleanWeek([{ open: '09:00' }]), /both ends/, 'a start with no end is a half-answer');
  assert.equal(C.cleanWeek([{}, {}, {}, {}, {}, {}, {}]), undefined, 'a week of genuinely blank days is no week');
  assert.equal(C.cleanWeek([{ open: '', close: '' }, null, null, null, null, null, null]), undefined, 'and blanks read as blank, not as garbage');
});

test('open now is answered from the shop clock, past midnight included', () => {
  const at = (iso) => Date.parse(iso);
  const wk = C.cleanWeek([{ open: '09:00', close: '17:00' }, { open: '18:00', close: '02:00' }, null, null, null, null, { open: '11:00', close: '15:00' }]);
  const st = { week: wk };
  assert.equal(C.openNow(st, at('2026-10-12T09:00:00Z')).open, true, 'Mon 11:00 local, inside 09:00-17:00');
  assert.match(C.openNow(st, at('2026-10-12T09:00:00Z')).label, /Open until 17:00/);
  assert.equal(C.openNow(st, at('2026-10-13T23:00:00Z')).open, true, 'Wed 01:00 local is still Tuesday night');
  assert.equal(C.openNow(st, at('2026-10-13T23:00:00Z')).since, 'last night', 'and it says so');
  assert.equal(C.openNow(st, at('2026-10-14T07:00:00Z')).open, false, 'Wed 09:00: Wednesday is shut');
  assert.match(C.openNow(st, at('2026-10-14T07:00:00Z')).label, /opens Sun at 11:00/, 'and names the day it next opens');
  assert.ok(C.openNow(st, at('2026-10-14T07:00:00Z')).in_min > 0, 'and how long');
  assert.equal(C.openNow({ week: wk, closed: true }, at('2026-10-12T09:00:00Z')).open, false, 'the closed tick beats the calendar');
  assert.equal(C.openNow({}, at('2026-10-12T09:00:00Z')).known, false, 'a store with no week is open, not shut by an absence');
  assert.equal(C.openNow({}, at('2026-10-12T09:00:00Z')).open, true);
});

test('a settings write can clear a week, and the sentence follows it', () => {
  const st = { hours: 'old words' };
  const v = C.validateSettings({ week: [{ open: '08:00', close: '16:00' }, null, null, null, null, null, null] }, Date.now());
  assert.ok(v.ok, 'accepted: ' + JSON.stringify(v.errors));
  C.stageSettings(st, v.soft, v.money, 9e5, 1000);
  assert.equal(st.hours, 'Mon 08:00-16:00 · closed Tue Wed Thu Fri Sat Sun', 'generated, on the same write');
  const again = C.validateSettings({ week: [{ open: '08:00', close: '16:00' }, null, null, null, null, null, null] }, Date.now());
  const before = JSON.stringify(st);
  const r2 = C.stageSettings(st, again.soft, again.money, 9e5, 2000);
  assert.equal(r2.changed, 0, 'saving the identical week is not a change, so no new fuse and no lie');
  assert.equal(JSON.stringify(st), before);
  const cleared = C.validateSettings({ week: [] }, Date.now());
  C.stageSettings(st, cleared.soft, cleared.money, 9e5, 3000);
  assert.ok(!st.week, 'and posting an empty week removes it — a validator that only adds can never take away');
  assert.equal(st.hours, 'Mon 08:00-16:00 · closed Tue Wed Thu Fri Sat Sun', 'the last printed words stand until they are edited');
});

test('a per-rail number is a money field and waits like one', () => {
  const st = { rail: 'ecocash_usd', pay_account: '0800000000' };
  const now = 1e9;
  const v = C.validateSettings({ rail_accts: { ecocash_usd: { acct: '0771234567' } } }, now, { rails: C.RAILS });
  assert.ok(v.ok, JSON.stringify(v.errors));
  const r = C.stageSettings(st, v.soft, v.money, 9e5, now);
  assert.equal(r.staged, 1, 'staged, not applied');
  assert.ok(!st.rail_accts, 'the shop is untouched until the fuse runs out');
  assert.deepEqual(C.applyPending(st, now + 9e5).applied, ['rail_accts'], 'and lands when it is due');
  assert.equal(st.rail_accts.ecocash_usd.acct, '0771234567');
  const off = C.validateSettings({ rail_accts: false }, now, { rails: C.RAILS });
  C.stageSettings(st, off.soft, off.money, 9e5, now);
  assert.deepEqual(C.applyPending(st, now + 9e5).applied, ['rail_accts']);
  assert.ok(!st.rail_accts, 'and taking it away is as easy as putting it on');
});

test('a bad number names its rail instead of saying invalid', () => {
  const v = C.validateSettings({ rail_accts: { zipit: { acct: 'not a number' }, ecocash_usd: { acct: '0771234567' } } }, Date.now(), { rails: C.RAILS });
  assert.equal(v.ok, false);
  assert.match(v.errors.rail_accts, /account number/, 'the field error carries the validator’s own sentence');
});

test('flags: a missing number and an order sent after hours', () => {
  const pricing = { rail: { key: 'ecocash_usd', type: 'manual', label: 'EcoCash USD' } };
  const bare = { rail: 'ecocash_usd', pay_account: '', currency: 'USD' };
  const f1 = C.riskFlags(bare, { pricing, service: 'pickup', hours: { known: false } }, {});
  assert.ok(f1.some((x) => /pay_account_not_set/.test(x)), 'no number anywhere: ' + JSON.stringify(f1));
  const covered = { rail: 'ecocash_usd', pay_account: '', rail_accts: { ecocash_usd: { acct: '0771234567' } }, currency: 'USD' };
  const f2 = C.riskFlags(covered, { pricing, service: 'pickup', hours: { known: false } }, {});
  assert.ok(!f2.some((x) => /pay_account_not_set/.test(x)), 'the rail has its own, so nobody is warned about a hole that is not there');
  const night = C.riskFlags({ ...covered, week: C.cleanWeek([null, null, null, null, null, null, null]) || undefined, closed: true },
    { pricing, service: 'pickup' }, {});
  assert.ok(night.some((x) => /sent while closed/.test(x)), 'and an order that arrives with the shutters down says so: ' + JSON.stringify(night));
});

test('the public page publishes one number, not all of them', () => {
  const st = { handle: 'h', shop_name: 'S', rail: 'ecocash_usd', pay_account: '0800000000',
               rail_accts: { ecocash_usd: { acct: '0771234567', holder: 'MAMA TOO', till: '55123' }, zipit: { acct: '999888777', holder: 'SECRET BANK' } },
               admin_token: 'SECRET', week: C.cleanWeek([{ open: '09:00', close: '17:00' }, null, null, null, null, null, null]) };
  const out = C.publicStore(st);
  const blob = JSON.stringify(out);
  assert.equal(out.pay_account, '0771234567', 'the number for the method on offer');
  assert.equal(out.pay_holder, 'MAMA TOO');
  assert.ok(!blob.includes('999888777'), 'the ZIPIT account is not the storefront’s business');
  assert.ok(!blob.includes('SECRET'), 'and the API key never rides along');
  assert.ok(!('rail_accts' in out), 'the map itself stays private');
  assert.equal(out.rail_info.spec, 'phone', 'the shape is public so the form asks the right question');
  // Monday-only fixture, so the two answers are pinned to a clock rather than to the
  // day this happens to run on: it is the shop's clock that decides, and the page must
  // agree with it at 11:00 and at 09:00 on a Wednesday.
  const at = (iso) => Date.parse(iso);
  assert.equal(C.publicStore(st, undefined, at('2026-10-14T07:00:00Z')).open.open, false,
    'shut when the shop’s clock is outside its slots — computed here, not on the buyer’s');
  assert.match(C.publicStore(st, undefined, at('2026-10-14T07:00:00Z')).open.label, /opens Mon/, 'and it says when it next opens');
  assert.equal(C.publicStore(st, undefined, at('2026-10-12T09:00:00Z')).open.open, true,
    'open when the shop’s clock is inside one');
});

/* ------------------------------------------------------------ store images */
/* Written against the failures a picture invites: a reference pointed at somebody
 * else's shop, a file that is not a file, and a document that quietly grows to a
 * megabyte because a validator took whatever it was handed. */
const ref = (h, id) => '/i/' + h + '/' + id;

test('a picture reference is only a picture if it is this store’s own', () => {
  assert.equal(C.cleanImg(ref('mamatoe', 'aB3dEf6gH9'), 'mamatoe'), ref('mamatoe', 'aB3dEf6gH9'));
  assert.equal(C.cleanImg('https://cdn.example/x.jpg', 'mamatoe'), 'https://cdn.example/x.jpg', 'a URL still works: half of these stores already have one');
  assert.equal(C.cleanImg(ref('kotaking', 'aB3dEf6gH9'), 'mamatoe'), '', 'another shop’s path is not a link to a stranger’s photos');
  assert.equal(C.cleanImg('/i/mamatoe/..%2f..%2fstore', 'mamatoe'), '', 'and it is not a way to walk out of the namespace either');
  assert.equal(C.cleanImg('data:image/png;base64,AAAA', 'mamatoe'), '', 'bytes do not get smuggled in through a field meant for a path');
  assert.equal(C.cleanImg('javascript:alert(1)', 'mamatoe'), '', 'nor does script');
  assert.equal(C.cleanImg('', 'mamatoe'), '', 'blank is a legal answer, not an error');
  assert.equal(C.cleanImg('  ' + ref('mamatoe', 'aB3dEf6gH9') + '  ', 'mamatoe'), ref('mamatoe', 'aB3dEf6gH9'), 'a paste with whitespace is the same picture');
  assert.equal(C.cleanImg(ref('mamatoe', 'ab'), 'mamatoe'), '', 'an id too short to be unguessable is refused');
});

test('the logo field stores a path or a URL and rejects the rest', () => {
  const set = (v, h) => C.validateSettings({ logo: v }, 0, { handle: h });
  assert.equal(set(ref('mamatoe', 'aB3dEf6gH9'), 'mamatoe').soft.logo, ref('mamatoe', 'aB3dEf6gH9'), 'a logo is a soft field: no 15-minute fuse on a picture');
  assert.equal(set('https://x.test/a.png', 'mamatoe').soft.logo, 'https://x.test/a.png');
  assert.equal(set(ref('kotaking', 'aB3dEf6gH9'), 'mamatoe').ok, false, 'a borrowed path comes back as a field error');
  assert.ok(!set(ref('kotaking', 'aB3dEf6gH9'), 'mamatoe').money.logo, 'and it is not staged into the money queue either');
});

test('a byte string is judged by what its first bytes say', () => {
  const enc = (s) => new TextEncoder().encode(s);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0xd]).buffer;
  assert.equal(C.sniffImage(png).mime, 'image/png');
  assert.equal(C.sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]).buffer).kind, 'jpeg');
  assert.equal(C.sniffImage(enc('RIFFxxxxWEBPVP8 ').buffer).kind, 'webp');
  assert.match(C.sniffImage(enc('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>').buffer).why, /SVG is refused/i, 'SVG on this origin would run with the merchant’s session cookie');
  assert.match(C.sniffImage(enc('GIF89a........').buffer).why, /GIF is refused/i);
  assert.match(C.sniffImage(enc('PK..........' ).buffer).why, /not a picture/i);
  assert.equal(C.sniffImage(enc('tiny').buffer), null, 'a buffer too short to name is not a picture');
});

test('what a store points at is exactly what may be kept', () => {
  const st = { handle: 'mamatoe', logo: ref('mamatoe', 'logoId1'),
    menu: { over: { '1': { img: ref('mamatoe', 'itemId1') }, '2': { img: 'https://x.test/y.jpg' } },
            extra: [{ id: 'z', name: 'z', img: ref('mamatoe', 'extraId') }] } };
  const kept = C.referencedImages(st);
  assert.deepEqual([...kept].sort(), [ref('mamatoe', 'extraId'), ref('mamatoe', 'itemId1'), ref('mamatoe', 'logoId1')].sort());
  assert.ok(!kept.has('https://x.test/y.jpg'), 'a URL is not our bytes to delete');
  assert.equal(C.referencedImages({}).size, 0, 'a store with nothing references nothing, and does not throw');
});

test('an id for a new picture is unguessable and never shaped like a counter', () => {
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const id = C.newImgId();
    assert.match(id, /^[A-Za-z0-9_-]{10}$/, 'the path regex and the generator have to agree: ' + id);
    seen.add(id);
  }
  assert.ok(seen.size > 390, '400 draws collide more than once in a while: ' + seen.size);
});

test('a menu row can carry a photo, and only its own store’s photo', () => {
  const withOwn = C.sanitizeMenu({ over: { '1': { price: '5.5', img: ref('mamatoe', 'aB3dEf6gH9') } }, handle: 'mamatoe' });
  assert.equal(withOwn.over['1'].img, ref('mamatoe', 'aB3dEf6gH9'));
  const without = C.sanitizeMenu({ over: { '1': { price: '5.5', img: ref('mamatoe', 'aB3dEf6gH9') } } });
  assert.equal(without.over['1'].img, '', 'no handle on the payload means no refs: a URL still rides along');
  const cleared = C.sanitizeMenu({ over: { '1': { img: '' } }, handle: 'mamatoe' });
  assert.equal(cleared.over['1'].img, '', 'and an empty string is kept as the order to take the picture off');
  const extra = C.sanitizeMenu({ extra: [{ name: 'New cake', img: ref('mamatoe', 'aB3dEf6gH9') }], handle: 'mamatoe' });
  assert.equal(extra.extra[0].img, ref('mamatoe', 'aB3dEf6gH9'), 'a brand-new item can arrive with its picture');
  const laid = C.applyMenu([{ id: '1', name: 'x', price: 1, img: 'https://x.test/old.jpg' }],
    { over: { '1': { img: ref('mamatoe', 'aB3dEf6gH9') } } });
  assert.equal(laid[0].img, ref('mamatoe', 'aB3dEf6gH9'), 'the store’s own picture wins over the sheet’s');
});

test('taking a picture off a row really takes it off', () => {
  const laid = C.applyMenu([{ id: '1', name: 'x', price: 1, img: 'https://x.test/old.jpg' }],
    { over: { '1': { img: '' } } });
  assert.equal(laid[0].img, '', 'an override that says nothing must beat the sheet that says something, or the row keeps a photo its merchant deleted');
});

/* -------------------------------------------------------- proof on a payment */
/* A manual rail is a phone the merchant reads. These tests are about what the rail
 * says it needs to find the money — a policy, a label, a code kept exactly as typed,
 * and a flag rather than a wall when the code is missing. */
test('each rail says how much proof it needs, from what it is', () => {
  assert.equal(C.RAILS.ecocash_usd.proof, 'ask', 'a wallet SMS has a code and the merchant can usually find it without one');
  assert.equal(C.RAILS.zipit.proof, 'require', 'a bank transfer with no reference is one amount and forty payers');
  assert.equal(C.RAILS.payfast.proof, 'none', 'a hosted gateway confirms itself — asking a buyer for a card auth code is theatre');
  assert.equal(C.RAILS.ozow.proof, 'none');
  assert.equal(C.RAILS.cash.proof, 'none', 'nothing was paid ahead, so nothing can be proven');
  assert.equal(C.RAILS.payshap.proof, 'ask', 'a ShapID proof is a reference photo, and it helps');
});

test('a described rail declares its own proof, and the default follows its shape', () => {
  const mpesa = C.normaliseRail({ label: 'M-Pesa', type: 'manual', spec: 'phone' }, 'custom');
  assert.equal(mpesa.proof, 'ask', 'a hand-checked wallet asks');
  const bank = C.normaliseRail({ label: 'Nequi', type: 'manual', spec: 'bank' }, 'custom');
  assert.equal(bank.proof, 'require', 'a hand-checked transfer needs the code');
  const link = C.normaliseRail({ label: 'Wave', type: 'auto', spec: 'link' }, 'custom');
  assert.equal(link.proof, 'none');
  const set = C.normaliseRail({ label: 'Tigo Pasa', type: 'manual', spec: 'phone', proof: 'require', proof_label: 'TP code' }, 'custom');
  assert.equal(set.proof, 'require', 'the merchant overrides the shape');
  assert.equal(set.proof_label, 'TP code', 'and names it in their own words, because their buyers know their name for it');
  const junk = C.normaliseRail({ label: 'Yolo', proof: 'please', proof_label: '  ' + 'q'.repeat(90) }, 'custom');
  assert.equal(junk.proof, 'ask', 'a mode nobody knows falls back to the default, not to nothing');
  assert.equal(junk.proof_label.length, 40, 'a label is capped rather than rejected — a long name is not a reason to lose a rail');
});

test('a proof code is kept as typed and nothing else gets in', () => {
  assert.equal(C.cleanProof(' ABC-1234.5/6 '), 'ABC-1234.5/6', 'dashes, dots and slashes are in real references');
  assert.equal(C.cleanProof('abc-1'), 'abc-1', 'not upper-cased: the bank prints it lower and matching is character for character');
  assert.equal(C.cleanProof('a   b'), 'a b', 'runs of space collapse, because the ledger is read by eye');
  assert.equal(C.cleanProof('1234<script>'), '1234script', 'markup is stripped, not escaped into a surprise');
  assert.equal(C.cleanProof('id 🙂 77'), 'id  77'.replace('  ', ' '), 'and emoji go: they are not in any bank reference');
  assert.equal(C.cleanProof('x'.repeat(80)).length, 40, 'a novel is not a reference');
  assert.equal(C.cleanProof(null), '', 'nothing is nothing');
});

test('the number a payment came from is kept in the shape that rail needs', () => {
  assert.equal(C.cleanPayer('0771234567', 'phone'), '0771234567');
  assert.equal(C.cleanPayer('+263 77 123 4567', 'phone'), '+263771234567', 'a phone keeps digits and a plus');
  assert.equal(C.cleanPayer('CABS 1234567890', 'bank'), 'CABS 1234567890', 'a bank needs its letters');
  assert.equal(C.cleanPayer('CABS 1234567890', 'loose'), 'CABS 1234567890', 'at capture nobody knows the rail yet, so nothing is dropped');
  assert.equal(C.cleanPayer('0771234567', 'loose'), '0771234567');
  assert.equal(C.cleanPayer('x'.repeat(60), 'loose').length, 30, 'but it is still bounded');
  assert.equal(C.cleanPayer('a@b.c', 'bank'), 'ab.c', 'no addresses, no at-signs');
});

test('the proof shape is frozen into the order, not read from the store later', () => {
  const st = { handle: 'h', rail: 'zipit', pay_account: '1234567890', currency: 'USD' };
  const p = C.priceOrder(st, [{ name: 'x', price: 10, qty: 1 }], 'pickup', 'zipit');
  assert.equal(p.rail.proof, 'require', 'so a slip printed next month still knows this order needed a code');
  assert.equal(C.priceOrder(st, [{ name: 'x', price: 10 }], 'pickup', 'cash').rail.proof, 'none');
  const bare = { rail: { key: 'x', type: 'manual', spec: 'phone', label: 'Old rail' }, pay_now: 1 };
  assert.equal(bare.rail.proof, undefined, 'an order stored before this release has no proof field, which is why every reader defaults it');
  const i = C.payInstructions({ pay_account: '1' }, { code: 'A-1', buyer: {} }, bare);
  assert.equal(i.proof_mode, 'ask', 'and it is read as the shape default, not as none');
});

test('the slip tells the buyer to keep the code, in the shop’s own words', () => {
  const st = { shop_name: 'Mama Too', currency: 'USD', rail: 'zipit', pay_account: '1234567890' };
  const ord = { code: 'A-1', buyer: { payer: '0771234567', proof: 'REF-99' } };
  const p = C.priceOrder(st, [{ name: 'x', price: 10 }], 'pickup', 'zipit');
  const i = C.payInstructions(st, ord, p);
  assert.ok(i.steps.some((l) => /keep the code the app shows/i.test(l)), 'one line, before they pay, while the code is still on screen: ' + JSON.stringify(i.steps));
  assert.equal(i.proof, 'REF-99');
  assert.equal(i.proof_mode, 'require');
  assert.equal(i.proof_label, 'Reference from your bank');
  assert.ok(/bank shows when the transfer goes out/.test(i.proof_hint), 'and it says where to look, because every app hides it differently');
  assert.equal(i.payer_from, '0771234567');
  assert.equal(i.ask_payer, true, 'a bank transfer is matched by account, so that question is worth asking too');
  const custom = C.payInstructions({ ...st, rail: 'custom', rail_def: { label: 'M-Pesa', spec: 'phone', proof: 'require', proof_label: 'M-Pesa code' } }, ord,
    C.priceOrder({ ...st, rail: 'custom', rail_def: { label: 'M-Pesa', spec: 'phone', proof: 'require', proof_label: 'M-Pesa code' } }, [{ name: 'x', price: 10 }], 'pickup', 'custom'));
  assert.equal(custom.proof_label, 'M-Pesa code', 'the shop’s name for it is the name the buyer reads');
  const cash = C.payInstructions(st, ord, C.priceOrder(st, [{ name: 'x', price: 10 }], 'pickup', 'cash'));
  assert.ok(!cash.steps.some((l) => /keep the code/i.test(l)), 'a cash slip asks for nothing it cannot use');
  assert.equal(cash.proof_mode, 'none');
});

test('a missing code is a flag on the row, never a refused order', () => {
  const st = { handle: 'h', rail: 'zipit', pay_account: '1234567890' };
  const rail = { key: 'zipit', type: 'manual', spec: 'bank', proof: 'require' };
  const none = C.riskFlags(st, { pricing: { rail, total: 5 }, buyer: {} }, {});
  assert.ok(none.some((f) => /no reference from your bank — ask them before sending/.test(f)), 'the flag says what to ask, in the words the rail uses: ' + JSON.stringify(none));
  assert.ok(!C.riskFlags(st, { pricing: { rail, total: 5 }, buyer: { proof: 'R-1' } }, {}).length, 'given, and nothing is flagged');
  const ask = { key: 'ecocash_usd', type: 'manual', spec: 'phone', proof: 'ask' };
  assert.ok(!C.riskFlags(st, { pricing: { ask, total: 5 }, buyer: {} }, {}).some((f) => /no code/.test(f)), 'optional means optional, and no order is shamed for it');
});

test('the handoff to the merchant’s phone carries the code', () => {
  const st = { shop_name: 'S', currency: 'USD', rail: 'ecocash_usd', pay_account: '0771234567', rail_accts: { ecocash_usd: { acct: '0771234567' } } };
  const p = C.priceOrder(st, [{ name: 'x', price: 10 }], 'pickup', 'ecocash_usd');
  const withIt = C.waSummary(st, { code: 'A-1', buyer: { name: 'Rudo', payer: '0912345678', proof: 'TX88123' }, pricing: p });
  assert.ok(/ · proof TX88123$/.test(withIt) || withIt.includes('proof TX88123'), 'the merchant reads one line and knows: ' + withIt);
  const without = C.waSummary(st, { code: 'A-1', buyer: { name: 'Rudo', payer: '0912345678' }, pricing: p });
  assert.ok(!/proof/.test(without), 'and does not see an empty field');
});

test('the buyer’s page is told the policy and never a code', () => {
  const st = { handle: 'h', shop_name: 'S', rail: 'zipit', pay_account: '1234567890', currency: 'USD' };
  const out = C.publicStore(st);
  assert.equal(out.rail_info.proof, 'require');
  assert.equal(out.rail_info.proof_label, 'Reference from your bank');
  assert.ok(out.rail_info.proof_hint.length > 8, 'where to look is part of the field, not a paragraph under it');
  assert.equal(out.rail_info.ask_payer, true);
  assert.ok(!JSON.stringify(out).includes('proof:'), 'no code is ever published — there is no buyer on a store page, and none should be needed');
  const auto = C.publicStore({ ...st, rail: 'payfast', pay_account: 'https://pay/biz' });
  assert.equal(auto.rail_info.proof, 'none');
  assert.equal(auto.rail_info.ask_payer, false, 'a hosted link has nothing to match, so the page asks nothing');
});

test('the ask is a sentence, not a second form to fill', () => {
  const rail = (proof, extra) => ({ pricing: { rail: { proof, type: 'manual', spec: 'bank', ...(extra || {}) } } });
  assert.equal(C.proofAsk({ buyer: {} }), '', 'an order with no rail says nothing — there is nothing to explain');
  assert.equal(C.proofAsk({ ...rail('none'), buyer: {} }), '', 'a rail that needs nothing is never mentioned again');
  assert.match(C.proofAsk({ ...rail('require'), buyer: {} }), /^Need: Reference from your bank/, 'a required code is asked for in the shop’s words');
  assert.match(C.proofAsk(rail('ask'), { buyer: {} }) || C.proofAsk({ ...rail('ask'), buyer: {} }), /send the reference too/, 'an optional one is a courtesy line, not a demand');
  assert.equal(C.proofAsk({ ...rail('require'), buyer: { proof: 'REF-1' } }), '', 'answered, so nobody is chased');
  assert.ok(!/Please provide|kindly|at your earliest convenience/.test(C.proofAsk({ ...rail('require'), buyer: {} })), 'it reads like a person texting, because that is what it is');
  // an order placed before any of this existed: the slip asked, so the follow-up may too
  assert.match(C.proofAsk({ pricing: { rail: { type: 'manual', spec: 'bank' } }, buyer: {} }), /^Need: Reference/, 'the same default the slip used, from the same function');
  assert.equal(C.proofAsk({ pricing: { rail: { type: 'cod', spec: 'none' } }, buyer: {} }), '', 'and cash is still cash');
  const renamed = C.proofAsk({ pricing: { rail: { proof: 'require', type: 'manual', spec: 'phone', proof_label: 'M-Pesa code' } }, buyer: {} });
  assert.match(renamed, /Need: M-Pesa code/, 'a renamed field is asked for by that name');
  assert.ok(!/M-PESA CODE/.test(renamed), 'and the merchant’s capitalisation survives: it is their word, not a token');
});

/* The money-in path. These functions decide whether a plan moves, so the primitives
 * are pinned against things computed elsewhere — the MD5 vectors are from Python's
 * hashlib, not from this implementation. */
test('md5 is the MD5, checked against other people’s numbers', () => {
  assert.equal(C.md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(C.md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(C.md5Hex('payment_status=COMPLETE&foo=bar'), 'd05a90eb880eb7a4e0ddf594f0461e2e');
  assert.equal(C.md5Hex('amount_gross=4500&payment_status=COMPLETE?passphrase=pp'), '92e82fb7448efd4f78e2414a2eb42fde');
  assert.equal(C.md5Hex('Ünïcode ✓'), '769df59d614789c7d7f90278b10ffed4', 'encoded as UTF-8, as every provider does');
  assert.equal(C.md5Hex('0'.repeat(64)).length, 32, 'a block boundary still returns hex');
});

test('the payfast string is the fields, sorted, without the signature, plus the passphrase', () => {
  const f = { payment_status: 'COMPLETE', amount_gross: '4500', custom_str1: 'a-b', signature: 'deadbeef', empty_field: '' };
  assert.equal(C.payfastCanonical(f, 'pp', false), 'amount_gross=4500&custom_str1=a-b&payment_status=COMPLETE?passphrase=pp',
    'in order, values as decoded, the signature excluded, and an empty field left out');
  assert.equal(C.payfastCanonical(f, 'pp', true), 'amount_gross=4500&custom_str1=a-b&empty_field=&payment_status=COMPLETE?passphrase=pp',
    'the other reading keeps the blank — the spec samples disagree, so verification tries both');
  assert.equal(C.payfastCanonical(f, ''), 'amount_gross=4500&custom_str1=a-b&payment_status=COMPLETE', 'no passphrase, no suffix');
  assert.equal(C.payfastSignature(f, 'pp'), C.md5Hex(C.payfastCanonical(f, 'pp', false)), 'the signature is the hash of that string, nothing else');
  assert.notEqual(C.payfastSignature({ ...f, amount_gross: '1' }, 'pp'), C.payfastSignature(f, 'pp'), 'one cent changes it, which is the point');
  // a notice is accepted if it was signed either way, and never without the passphrase
  const signed = (obj) => ({ ...obj, signature: C.md5Hex(C.payfastCanonical(obj, 'pp', true)) });
  assert.equal(C.payfastSignedOk(signed(f), 'pp'), true, 'signed with the blanks included');
  const strict = { ...f, signature: C.md5Hex(C.payfastCanonical(f, 'pp', false)) };
  assert.equal(C.payfastSignedOk(strict, 'pp'), true, 'or with them left out');
  assert.equal(C.payfastSignedOk({ ...f, signature: 'x'.repeat(32) }, 'pp'), false, 'a shape that is not the hash is still refused');
  assert.equal(C.payfastSignedOk(f, 'pp'), false, 'and no signature field at all is no payment');
  assert.equal(C.payfastSignedOk(signed({ ...f, amount_gross: '1' }), 'pp') , true, 'note: this is the same string the sender signed — what protects the plan is that only the passphrase holder can produce it');
});

test('a signature is compared without leaking how much of it was right', () => {
  assert.equal(C.sigEq('abc123', 'abc123'), true);
  assert.equal(C.sigEq('abc123', 'abc124'), false);
  assert.equal(C.sigEq('abc123', 'abc12'), false, 'a length difference is a mismatch, not a panic');
  assert.equal(C.sigEq('', ''), false, 'nothing is never a signature');
  assert.equal(C.sigEq(undefined, 'x'), false);
});

test('what a notice may claim about money is checked against what was asked for', () => {
  const tx = { handle: 'h', days: 365, amount: 45.05, currency: 'USD' };
  assert.equal(C.txMatches(tx, { amount_gross: '4505', amount_currency: 'USD' }).ok, true, 'cents match, currency matches');
  assert.match(C.txMatches(tx, { amount_gross: '4500', amount_currency: 'USD' }).why, /amount on the notice/, '45.00 is not 45.05');
  assert.match(C.txMatches(tx, { amount_gross: '4505', amount_currency: 'ZAR' }).why, /priced in USD/, 'the asset is verified too, not just the number');
  assert.match(C.txMatches(tx, {}).why, /does not match/, 'a notice with no amount at all says nothing about having paid');
  assert.match(C.txMatches(null, { amount_gross: '4505' }).why, /spent|expired/, 'a spent or window-closed reference is not a payment');
  const local = { handle: 'h', days: 30, amount: 4, currency: 'ZAR', local_cents: 7600 };
  assert.equal(C.txMatches(local, { amount_gross: '7600', amount_currency: 'ZAR' }).ok, true, 'a plan priced in rand is checked in rand');
  assert.equal(C.txMatches(local, { amount_gross: '400', amount_currency: 'ZAR' }).ok, false, 'and not against the USD figure by accident');
});

test('a payment reference cannot be walked, and a payment window closes', () => {
  const a = C.newTxRef('mamatoe'), b = C.newTxRef('mamatoe');
  assert.match(a, /^mamatoe-[A-Za-z0-9_-]{16}$/, 'the handle is the thread support can see, the rest is not guessable');
  assert.notEqual(a, b);
  assert.ok(C.newTxRef('x'.repeat(60)).length <= 30 + 1 + 16, 'a long handle is cut, not concatenated past the key’s dignity');
  assert.equal(C.TX_WINDOW_SEC, 1800, 'thirty minutes: long enough to pay, short enough that the price is still the price');
});

/* ------------------------------------------------------------- being found */
/* The storefront is read by things that do not run JavaScript: a WhatsApp preview
 * bot, Google, and a phone on a bad connection. All three get the bytes we send, so
 * the bytes are the product — which is why the rules are here rather than in the
 * page, where a test cannot reach them. */
const SEO_STORE = {
  handle: 'kotaking', shop_name: 'Kota King', tagline: 'Halal fried chicken and kota',
  location: 'Harare CBD', currency: 'ZAR', whatsapp: '263771234567', rail: 'cash',
  week: [{ slots: [{ o: 540, c: 1260 }] }, null, null, null, null, null, { slots: [{ o: 600, c: 1020 }] }],
  logo: '/i/kotaking/logo-1',
  feed_cache: { products: [
    { id: 'a', name: 'Chicken kota', price: 22.5, cur: 'ZAR', desc: 'with egg and atchar', img: '/i/kotaking/pic-a' },
    { id: 'b', name: 'Full polish', price: 45, cur: 'ZAR', available: false },
  ] },
};
const MON_10 = Date.UTC(2026, 9, 12, 10, 0);   // a Monday, so "open until" is a fact and not a weekday lottery
const ORIGIN = 'https://tapstall.test';

test('what a crawler is told about a shop, and only what the shop said', () => {
  const f = C.seoFacts(SEO_STORE, ORIGIN, MON_10);
  assert.equal(f.title, 'Kota King — Harare CBD | Tapstall', 'what it is, where, then who hosts it');
  assert.equal(f.url, ORIGIN + '/s/kotaking', 'and the page has one canonical spelling');
  assert.match(f.desc, /^Halal fried chicken and kota\./, 'the merchant’s own line first, as a sentence');
  assert.match(f.desc, /Chicken kota 22\.50 ZAR/, 'prices from the shelf, in the shop’s currency');
  assert.equal(f.image, ORIGIN + '/i/kotaking/logo-1', 'an absolute URL, because a preview bot cannot resolve ours');
  assert.match(f.imageAlt, /Kota King.*Harare CBD/, 'alt text, which their bot taught me to never leave out');
  assert.equal(f.price_range, 'ZAR 22.5–45', 'and a range only if two prices exist');
  assert.equal(f.open_label, 'Open until 21:00', 'the answer to the only question a street food page has');
  assert.ok(f.desc.length <= C.SEO_DESC_MAX && f.title.length <= C.SEO_TITLE_MAX, 'truncated where search truncates');
});

test('a page is never left describing nothing, and never invents', () => {
  const bare = C.seoFacts({ handle: 'x9', shop_name: '' }, ORIGIN, MON_10);
  assert.equal(bare.title, 'x9 | Tapstall', 'no name is the handle’s job');
  assert.match(bare.desc, /menu, prices and payment in one link/, 'the fallback line, which is true of every store');
  assert.equal(bare.image, '', 'no picture on file, so no picture is promised');
  const head = C.seoHead(bare);
  assert.ok(!/og:image|twitter:image/.test(head), 'and no og:image tag either — a broken preview image is worse than none');
  assert.match(head, /name="twitter:card" content="summary"/, 'summary, not summary_large_image, when there is nothing to show');
  assert.ok(!/undefined|null/.test(head), 'nothing that leaked through as the word undefined');
  const huge = C.seoFacts({ handle: 'h', shop_name: 'A'.repeat(80), tagline: 'word '.repeat(120) }, ORIGIN, MON_10);
  assert.ok(huge.title.length <= C.SEO_TITLE_MAX, 'a shouty name still fits');
  assert.match(huge.desc, /\u2026$/, 'it is long enough to need a mark');
  assert.ok(!/[\.\s]\u2026/.test(huge.desc), 'one mark, and never a loose dot or space in front of it');
  assert.ok(huge.desc.length <= C.SEO_DESC_MAX, 'the limit is a limit, not an aim');
});

test('merchant text is data, not markup', () => {
  const evil = { handle: 'zz', shop_name: 'G\'s "Shop" <script>alert(1)</script>', tagline: 'a & b < c', currency: 'USD' };
  const head = C.seoHead(C.seoFacts(evil, ORIGIN, MON_10));
  assert.ok(!head.includes('<script>alert'), 'a shop name cannot open a tag');
  assert.match(head, /&lt;script&gt;alert/, 'it is there, escaped, as the merchant typed it');
  assert.match(head, /G&#39;s &quot;Shop&quot;/, 'quotes inside an attribute cannot escape it either');
  const tag = C.seoJsonLdTag(evil, C.seoFacts(evil, ORIGIN, MON_10));
  const body = tag.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  assert.ok(!/</.test(body), 'inside the JSON-LD, not one < survives unescaped');
  assert.match(body, /alert\(1\)/, 'the shop name is still in there, as data');
  assert.ok(tag.startsWith('<script type="application/ld+json">') && tag.endsWith('</script>'), 'and the block itself is one tag');
});

test('the structured data is the shop: hours, menu, sold-out, and the price of each', () => {
  const f = C.seoFacts(SEO_STORE, ORIGIN, MON_10);
  const g = C.seoJsonLd(SEO_STORE, f);
  assert.equal(g['@context'], 'https://schema.org');
  const [biz] = g['@graph'];
  assert.equal(biz['@type'], 'LocalBusiness', 'not Restaurant, not Takeaway: nobody asked us to claim that');
  assert.deepEqual(biz.openingHoursSpecification, [
    { '@type': 'OpeningHoursSpecification', dayOfWeek: 'Mon', opens: '09:00', closes: '21:00' },
    { '@type': 'OpeningHoursSpecification', dayOfWeek: 'Sun', opens: '10:00', closes: '17:00' },
  ], 'minutes on the sheet, HH:MM here, closed days simply absent');
  assert.equal(biz.telephone, '+263771234567', 'the number the buyer already sees, in the form a dialler wants');
  assert.equal(biz.hasMenu.hasMenuItem.length, 2);
  assert.equal(biz.hasMenu.hasMenuItem[0].offers.price, '22.50', 'a string with two decimals, per schema.org');
  assert.equal(biz.hasMenu.hasMenuItem[0].offers.priceCurrency, 'ZAR');
  assert.equal(biz.hasMenu.hasMenuItem[1].offers.availability, 'https://schema.org/OutOfStock', 'sold out is said, not hidden');
  assert.equal(biz.hasMenu.hasMenuItem[1].offers.price, '45.00');
  const [crumb] = g['@graph'].slice(1);
  assert.equal(crumb['@type'], 'BreadcrumbList');
  assert.equal(crumb.itemListElement[1].item, ORIGIN + '/s/kotaking');
  const empty = C.seoJsonLd({ handle: 'x' }, C.seoFacts({ handle: 'x', shop_name: 'X' }, ORIGIN, MON_10));
  assert.equal(empty['@graph'][0].hasMenu, undefined, 'no shelf, no menu — not an empty one');
  assert.equal(empty['@graph'][0].openingHoursSpecification, undefined, 'and no hours either');
});

test('what may not be in a public head, and what may not be in a sitemap', () => {
  const leaky = { ...SEO_STORE, admin_token: 'tok-SECRET', pin: { hash: 'HASH' }, secret_hash: 'SH',
    paid_until: 1893456000000, plan: 'annual', suspended: false, rail_accts: { bank: '1234567890' },
    pending: { fields: { pay_account: 'SECRET-ACCT' } }, notify_email: 'me@secret.example' };
  const blob = JSON.stringify(C.seoFacts(leaky, ORIGIN, MON_10)) + JSON.stringify(C.seoJsonLd(leaky, C.seoFacts(leaky, ORIGIN, MON_10))) + C.seoHead(C.seoFacts(leaky, ORIGIN, MON_10));
  for (const w of ['tok-SECRET', 'HASH', 'SH', 'SECRET-ACCT', 'me@secret.example', '1234567890']) {
    assert.ok(!blob.includes(w), 'the head carries ' + w);
  }
  for (const k of ['admin_token', 'paid_until', 'rail_accts', 'pending', 'secret_hash', 'plan', 'suspended']) {
    assert.ok(!blob.includes('"' + k + '"'), 'and not even the field name ' + k);
  }
  const robots = C.ROBOTS_TXT(ORIGIN);
  assert.match(robots, /^Allow: \/s\/$/m, 'the storefront is the content');
  assert.match(robots, /^Allow: \/i\/$/m, 'and the pictures must be fetchable or every preview is blank');
  for (const d of ['/a', '/api/', '/ops', '/__selftest']) assert.match(robots, new RegExp('^Disallow: ' + d.replace(/[/]/g, '\\/') + '$', 'm'), d + ' is not for a crawler');
  const sm = C.sitemapXml(ORIGIN);
  assert.match(sm, /<loc>https:\/\/tapstall\.test\/onboard<\/loc>/);
  assert.ok(!sm.includes('/s/'), 'we do not publish a list of every merchant: those pages carry their payment numbers');
  assert.match(robots, /Sitemap: https:\/\/tapstall\.test\/sitemap\.xml$/m, 'and the file we do publish is announced');
});

test('the post a merchant would otherwise have to write at 21:00', () => {
  const f = C.seoFacts(SEO_STORE, ORIGIN, MON_10);
  const c = C.shareCopy(SEO_STORE, f, ORIGIN);
  assert.ok(c.x.length <= 280, 'X counts characters, and truncates the link if you do not: ' + c.x.length);
  assert.ok(c.wa.length <= 650, 'a WhatsApp status is not a newsletter');
  assert.ok(c.x.endsWith(ORIGIN + '/s/kotaking'), 'the link survives to the end of every block or the post is decoration');
  for (const k of ['wa', 'x', 'fb']) {
    assert.equal(c[k].split(ORIGIN + '/s/kotaking').length - 1, 1, k + ' repeats the link');
    assert.ok(!/undefined|null/.test(c[k]), k + ' leaks an unset field as a word');
  }
  // Instagram captions are not clickable, so the one format that must not carry a URL
  // is the one a generator would otherwise paste one into.
  assert.ok(!c.ig.includes(ORIGIN), 'ig says link in bio and means it');
  assert.match(c.ig, /Link in bio\./);
  assert.match(c.wa, /Chicken kota 22\.50 ZAR/, 'what is on offer, priced, in the shop’s own currency');
  assert.match(c.wa, /Open until 21:00/, 'whether they can come now');
  assert.match(c.fb, /^Kota King, Harare CBD — Halal fried chicken and kota\n(?:• [^\n]+\n)+\n→ /, 'a line for the shop, bullets, a gap, then the link');
  assert.ok(!/\n\n\n/.test(c.fb) && !/•\s*\n/.test(c.fb), 'and a missing line is missing, not a bullet with nothing after it');
  const bare = C.shareCopy({ handle: 'x9' }, C.seoFacts({ handle: 'x9' }, ORIGIN, MON_10), ORIGIN);
  assert.match(bare.wa, /^x9\b/, 'a shop with nothing typed still gets something sendable');
  assert.ok(bare.x.length <= 280 && bare.fb.includes(ORIGIN), 'in every format');
});

test('what the money doors were asked for is counted, once an hour', () => {
  const stamp = C.hookHourStamp(Date.UTC(2026, 9, 12, 10, 30));
  assert.equal(stamp, '2026101210', 'UTC, to the hour, because the day boundary is somebody else’s');
  assert.equal(C.hookAuditKey(stamp, 'refused'), 'hooks:2026101210:refused');
  for (const s of C.HOOK_AUDIT_STATUSES) assert.match(C.hookAuditKey(stamp, s), /^hooks:\d{10}:/);
});

/* ---------------------------------------------------- 0.7.3 the buyer adds their own code */
test('the rules a buyer can write under are a function, not a page', () => {
  const open = { status: 'awaiting_payment', buyer: { proof: '', payer: '' } };
  assert.equal(C.proofAccept(open, { proof: ' 88 12.x ' }).proof, '88 12.x', 'the same intake as the cart: trimmed, never reshaped');
  assert.equal(C.proofAccept(open, {}).why, 'empty', 'an empty box is an answer, and it is “type the code”');
  assert.equal(C.proofAccept(open, { proof: '   ' }).why, 'empty', 'spaces are not a reference');
  assert.equal(C.proofAccept({ status: 'cod', buyer: {} }, { proof: 'COD 1' }).ok, true, 'cash on delivery is still an order a buyer can annotate');
  for (const st of ['paid', 'cancelled']) {
    const r = C.proofAccept({ status: st, buyer: {} }, { proof: 'X' });
    assert.equal(r.ok, false, st + ' is the shop’s word, and a buyer does not overwrite it');
    assert.equal(r.why, 'settled');
    assert.match(r.msg, /Message the shop/i, 'a closed door with somewhere else to go');
  }
  assert.equal(C.proofAccept(open, { proof: '<b>x</b>' }).proof, 'bx/b', 'the cleaning the cart applies, applied here as well');
});
test('three corrections, and a replay costs nothing', () => {
  let o = { status: 'awaiting_payment', buyer: { proof: '', payer: '' } };
  const left = [];
  for (let i = 0; i < 5; i++) {
    const r = C.proofAccept(o, { proof: 'R' + i });
    left.push(r.left + (r.ok ? '' : ':' + r.why));
    if (r.ok && r.changed) o = { status: o.status, buyer: { proof: r.proof, payer: r.payer }, proof_writes: r.writes };
  }
  assert.deepEqual(left, ['2', '1', '0', '0:spent', '0:spent'], 'three accepted writes, then the door shuts on every later try');
  assert.equal(C.PROOF_WRITES_MAX, 3, 'and the number is a named constant, because it is a promise made in three places');
  const same = C.proofAccept(o, { proof: 'R2' });
  assert.equal(same.ok, true, 'the value already on the order is not a fourth write');
  assert.equal(same.changed, false, 'it changed nothing, and says so instead of quietly rewriting');
  assert.equal(same.left, 0, 'and it is free: a retry after a lost response must not spend the budget');
  assert.equal(C.proofAccept(o, { proof: '   ' }).why, 'empty', 'blank is refused before it can read as “clear the field”');
  const doc = C.proofAccept(o, {});
  assert.equal(doc.ok, true, 'nothing to change reads as fine rather than as an error');
  assert.equal(C.PROOF_WINDOW_SEC, 72 * 3600, 'the same 72 hours a confirm link gets: a buyer’s door must not outlive the shop’s own');
  // the number is checked where both sentences are read: see the live test's 72-hours pair
});
test('an absent field is left alone, not erased', () => {
  const o = { status: 'awaiting_payment', buyer: { proof: 'KEEP-1', payer: '+263771234567' } };
  assert.equal(C.proofAccept(o, { proof: 'KEEP-1' }).changed, false, 'a form with no payer box must not wipe a payer that was typed');
  const r = C.proofAccept(o, { proof: 'KEEP-2' });
  assert.equal(r.payer, '+263771234567', 'and a real edit carries the untouched half forward');
  assert.equal(r.proof, 'KEEP-2');
  assert.equal(C.proofAccept({ status: 'paid', buyer: o.buyer }, { proof: 'KEEP-1' }).why, 'settled',
    'the same value does not reopen a settled order');
  assert.equal(C.proofOpen({ status: 'awaiting_payment' }), true);
  assert.equal(C.proofOpen({ status: 'paid' }), false);
  assert.equal(C.proofOpen({}), true, 'an order with no status yet is open — refusing would strand it');
});
