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
  const cap = await C.issueCap(SEC, { a: 'mark', h: 'shop', id: 'o9', s: 'paid', g: 'g1' }, 900);
  assert.equal(cap.split('.').length, 4, 'v1.<exp>.<payload>.<tag>');
  const p = await C.verifyCap(SEC, cap);
  assert.deepEqual({ a: p.a, h: p.h, id: p.id, s: p.s }, { a: 'mark', h: 'shop', id: 'o9', s: 'paid' });
  assert.ok(p.exp >= Math.floor(Date.now() / 1000) + 800, 'expiry attached');
  assert.equal(p.g, 'g1', 'and the payload keeps the generation it was minted under, byte for byte');
});

test('a capability dies on tamper, on expiry, on another secret and on garbage', async () => {
  const cap = await C.issueCap(SEC, { a: 'sess', h: 'shop', g: 'g1' }, 900);
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
  const cap = await C.issueCap(SEC, { a: 'mark', g: 'g1' }, 1);
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
  // a sheet behind it: since v0.9.10 the head describes cached feed rows only for a shop
  // that *has* a feed — for one that doesn't, its authored list is the shelf and the cache
  // is stale by definition, and a crawler must not be told more than the storefront shows
  feed_url: 'https://docs.google.com/spreadsheets/d/1a2b3c4d5e6f7g8h9i0jklmnop/edit#gid=0',
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

test('the ask can name a door, and says nothing about one that does not exist', () => {
  const rail = { key: 'zipit', label: 'Zimswitch', type: 'manual', spec: 'bank', proof: 'require' };
  const owe = { status: 'awaiting_payment', buyer: { proof: '' }, pricing: { rail } };
  assert.equal(C.proofAsk(owe), 'Need: Reference from your bank — your app shows it right after it sends. Send it here and I can confirm your order today.',
    'unchanged words when the caller has no door: the old sentence, byte for byte');
  const withDoor = C.proofAsk(owe, { here: 'https://tapstall.test/p/v1.abc' });
  assert.match(withDoor, /Add it here and I can confirm your order today: https:\/\/tapstall\.test\/p\/v1\.abc$/, 'and one clause swapped when it has');
  assert.match(C.proofAsk({ ...owe, pricing: { rail: { ...rail, proof: 'ask' } } }, { here: 'https://x/p/1' }),
    /add it here and it goes straight on the order: https:\/\/x\/p\/1/, 'the optional mode offers the door without demanding it');
  assert.ok(!/http/.test(C.proofAsk({ ...owe, buyer: { proof: 'HAS' } }, { here: 'https://x/p/1' })), 'answered is silent, door or no door');
});
test('the shop’s own door has no budget and no closing hour, and the same field rules', () => {
  const paid = { status: 'paid', buyer: { proof: '', payer: '+263770001111' } };
  const r = C.proofAccept(paid, { proof: 'IN CHAT' }, 'merchant');
  assert.equal(r.ok, true, 'a code that arrived after the money was counted is the most legitimate write in the file');
  assert.equal(r.by, 'merchant', 'and the answer says whose hand did it, so the record can too');
  assert.equal(r.status, undefined, 'no status in, no status out — not from either door');
  assert.equal(r.payer, '+263770001111', 'the untouched half of the buyer object carries forward');
  assert.equal(r.writes, 0, 'a shop write does not spend the buyer’s three corrections');
  const spent = { status: 'awaiting_payment', buyer: {}, proof_writes: C.PROOF_WRITES_MAX };
  assert.equal(C.proofAccept(spent, { proof: 'A' }, 'merchant').ok, true, 'nor does it spend the buyer’s allowance when the shop files');
  assert.equal(C.proofAccept(spent, { proof: 'A' }, 'buyer').why, 'spent', 'the stranger’s door is still shut at three');
  assert.equal(C.proofAccept(paid, { proof: 'A' }, 'buyer').why, 'settled', 'and shut at settle');
  assert.equal(C.proofAccept({ status: 'paid', buyer: {} }, {}, 'merchant').msg, 'Nothing to file — type the code they sent you.',
    'the blank refusal is written for the hand holding the phone: a buyer is told where to look, a shop is told what it failed to do');
  assert.equal(C.proofAccept(paid, {}, 'merchant').changed, false,
    'and a submit with no boxes that would change nothing says so, rather than clearing the payer it was never given');
  assert.equal(C.proofAccept(paid, { proof: 'x'.repeat(80) }, 'merchant').proof.length, 40, 'the same 40 characters, because it is one field');
});

test('the merchant’s notice tells them a door exists, and does not hand them the key', () => {
  const rail = { key: 'zipit', label: 'Zimswitch', type: 'manual', spec: 'bank', proof: 'require' };
  const st = { handle: 'shop', currency: 'USD', pay_account: '0771234567', rail: 'zipit' };
  const owe = { code: 'SH-1', buyer: { name: 'R', phone: '078' }, pricing: { rail, pay_now: 12 }, status: 'awaiting_payment', items: [] };
  const t = C.notifyText(st, owe);
  assert.match(t, /No reference from your bank yet — the row in your ledger has a link they can paste it into/, 'the sentence names the field in the shop’s own words: ' + t);
  assert.match(t, /nothing else it can change/, 'and says what the link cannot do, because that is the merchant’s first question');
  assert.ok(!/\/p\//.test(t), 'the URL itself never travels in an inbox — a forwarded email would carry a live write');
  assert.match(C.notifyText(st, { ...owe, buyer: { ...owe.buyer, proof: 'RBZ-9' } }), /proof RBZ-9/, 'an answered order reads as it always did');
  assert.ok(!/yet —/.test(C.notifyText(st, { ...owe, buyer: { ...owe.buyer, proof: 'RBZ-9' } })), 'and nothing is nagged about it');
  assert.ok(!/yet —/.test(C.notifyText(st, { ...owe, status: 'paid' })), 'a settled order is not sent chasing, the door is shut anyway');
  assert.ok(!/yet —/.test(C.notifyText(st, { ...owe, pricing: { rail: { ...rail, proof: 'none' }, pay_now: 12 } })), 'a rail that never asked says nothing');
});

test('proofUsed: a link is worth one change, and only once the order says so', () => {
  // the whole single-use rule is this one pure function, so it is worth its own truth table
  assert.equal(C.proofUsed({ pcap: 'abc' }, 'abc'), false, 'the live nonce matches, so the link is current');
  assert.equal(C.proofUsed({ pcap: 'abc' }, 'zzz'), true, 'a different one means this link already filed something');
  assert.equal(C.proofUsed({}, 'abc'), false, 'an order from before the rule is not retroactively spent');
  assert.equal(C.proofUsed({ pcap: 'abc' }, undefined), false, 'a cap minted before the rule is honoured, not punished');
  assert.equal(C.proofUsed({ pcap: '' }, ''), false, 'and two empties are the same case, said twice because they arrive separately');
  assert.equal(C.proofUsed({ pcap: 7 }, '7'), false, 'KV round-trips numbers as strings, and a nonce is not a type');
});

test('proofVoid: what it takes for a shop to hand the field back', () => {
  const rail = { key: 'zipit', type: 'manual', spec: 'bank', proof: 'ask', proof_label: 'Reference from your bank' };
  const open = { status: 'awaiting_payment', pricing: { rail }, buyer: { proof: 'RBZ 8891', payer: '0771234567' }, proof_writes: 2, pcap: 'old' };
  const v = C.proofVoid(open);
  assert.deepEqual({ ok: v.ok, changed: v.changed, proof: v.proof, payer: v.payer },
    { ok: true, changed: true, proof: '', payer: '' }, 'both halves of the field go, because half a reference is not evidence either');
  assert.deepEqual(v.cleared, ['RBZ 8891', '0771234567'], 'and the answer names what it removed, so a merchant can read it back to the buyer');
  assert.equal(v.writes, 0, 'a hand-back restarts the chain, which is the whole point of it');
  assert.equal(v.left, C.PROOF_WRITES_MAX, 'and says so in the number the buyer will meet next');
  assert.match(v.msg, /the reference is off the order/, 'in the rail’s own word, not ours: ' + v.msg);

  // nothing to hand back is a state, not a mistake: a double tap must not be an error
  const empty = C.proofVoid({ status: 'awaiting_payment', pricing: { rail }, buyer: {} });
  assert.deepEqual({ ok: empty.ok, changed: empty.changed }, { ok: true, changed: false }, 'idempotent, so a second tap is just a second tap');
  assert.match(empty.msg, /already empty/, 'and it says what it found rather than what it refused');

  // a payer with no code is still something on the field (the number the rail searches by)
  const onlyPayer = C.proofVoid({ status: 'awaiting_payment', pricing: { rail }, buyer: { payer: '077 000 1111' }, proof_writes: 1 });
  assert.equal(onlyPayer.changed, true, 'a lone sender number is on file, and it can be wrong too');
  assert.deepEqual(onlyPayer.cleared, ['0770001111'.replace(/0770001111/, '077 000 1111')], 'cleaned the way the field cleans, which is not the way it was typed');

  // the decision does not depend on the order being payable: what happens next does, and
  // that is withAsk’s business — this function must not pretend to know about money
  const paid = C.proofVoid({ ...open, status: 'paid' });
  assert.equal(paid.changed, true, 'a code mis-read after the money was counted is still a code mis-read');
  assert.equal(C.proofVoid(null).changed, false, 'and an order that is not there has nothing to hand back');
  assert.equal(C.proofVoid({}).ok, true, 'no throw, no drama: {} is just an empty field');
  assert.ok(!('status' in C.proofVoid(open)), 'the answer never claims to have touched status, because it cannot');
});

test('proofSuperseded: the link died, but not by the buyer\u2019s hand', () => {
  const used = { pcap: 'new', proof_void_at: '2026-10-12T16:40:11.000Z', buyer: {}, status: 'awaiting_payment' };
  assert.equal(C.proofSuperseded(used, 'old'), true, 'a stale nonce, a hand-back stamp, an empty field');
  assert.equal(C.proofSuperseded({ ...used, buyer: { proof: 'AGAIN' } }, 'old'), false,
    'once something is on file again the true sentence is the ordinary one: this link filed, then the order moved on');
  assert.equal(C.proofSuperseded({ ...used, buyer: { payer: '0771234567' } }, 'old'), false,
    'and a lone sender number counts, because the field is only empty when both halves are');
  assert.equal(C.proofSuperseded({ pcap: 'new', buyer: {}, status: 'awaiting_payment' }, 'old'), false,
    'no hand-back ever happened, so nothing was retired: this is the spent-link case');
  assert.equal(C.proofSuperseded({ ...used, pcap: 'old' }, 'old'), false,
    'a current link is never described as retired, stamp or no stamp');
  assert.equal(C.proofSuperseded({ ...used, buyer: { proof: '  ' } }, 'old'), true,
    'whitespace is not a code: the same cleaning the field itself uses decides it');
  assert.equal(C.proofSuperseded(null, 'x'), false, 'and an order that is not there is answered, not thrown');
});

test('railWantsPayer: the four surfaces that ask this question ask the same one', () => {
  const yes = ['phone', 'shapid', 'wallet', 'bank'];
  assert.deepEqual(C.PAYER_SPECS, yes, 'one array, in this order, so a page can be pinned against it');
  for (const sp of yes) assert.equal(C.railWantsPayer({ type: 'manual', spec: sp }), true, sp + ' is found by its number');
  for (const sp of ['none', 'link', 'cash', undefined, ''])
    assert.equal(C.railWantsPayer({ type: 'manual', spec: sp }), false, sp + ' has no number to match');
  for (const t of ['cod', 'auto'])
    assert.equal(C.railWantsPayer({ type: t, spec: 'phone' }), false, t + ' is not a hand-checked rail whatever its spec says');
  assert.equal(C.railWantsPayer(null), false, 'a rail nobody configured asks for nothing');

  // and against the catalogue itself, because the drift this closed was in the shapes, not in
  // the rule: a hosted link confirms itself, a ZIPIT has nothing else to go on
  const want = { cash: false, payfast: false, ozow: false, ecocash_usd: true, ecocash_zig: true,
    innbucks: true, onepay: true, zipit: true, payshap: true };
  for (const [key, expect] of Object.entries(want)) {
    const r = C.RAILS[key];
    assert.ok(r, key + ' is still in the catalogue');
    assert.equal(C.railWantsPayer(r), expect, key + ' (' + r.type + '/' + r.spec + ')');
  }
});

/* ---- v0.8.6 — capGenOk: the rule that decides whether a link still belongs to its store ---- */
const DAY = 86400000;
const genStore = (g) => ({ auth_gen: g });
const iso = (ms) => new Date(ms).toISOString();
const nowish = (base36) => Number.parseInt(base36, 36).toString(36);   // what a lowercase generation round-trips to

test('capGenOk: a cap that names a generation is compared to it, exactly', () => {
  assert.equal(C.capGenOk({ g: 'abc' }, genStore('abc'), {}), true);
  assert.equal(C.capGenOk({ g: 'abc' }, genStore('abd'), {}), false, 'one character off is a different generation');
  assert.equal(C.capGenOk({ g: 'abc' }, genStore('0'), {}), false, 'a revoked store does not honour a pre-revoke cap');
  assert.equal(C.capGenOk({ g: '0' }, genStore('0'), {}), true, 'the untouched store and the untouched cap agree on 0');
});

test('capGenOk: a store that has never revoked has nothing for a legacy link to be too old for', () => {
  assert.equal(C.capGenOk({}, genStore('0'), { at: iso(1) }), true);
  assert.equal(C.capGenOk({}, genStore(undefined), { at: iso(1) }), true, 'a store with no field at all is the same case');
  assert.equal(C.capGenOk({}, genStore(''), { at: iso(1) }), true);
});

test('capGenOk: a legacy link is judged by whether the order moved after the revoke', () => {
  const revoked = Date.now() - DAY;
  const st = genStore(revoked.toString(36));
  assert.equal(C.capGenOk({}, st, { at: iso(revoked + 1000) }), true, 'newer than the revoke');
  assert.equal(C.capGenOk({}, st, { at: iso(revoked - 1000) }), false, 'older than it');
  assert.equal(C.capGenOk({}, st, { at: iso(revoked - 1000), marked_at: iso(revoked + 1000) }), true,
    'a link minted by a later state change is a later link — marked_at counts as the move');
  assert.equal(C.capGenOk({}, st, { at: iso(revoked) }), false, 'to the millisecond, equal is not after');
});

test('capGenOk: anything it cannot date is refused, not waved through', () => {
  const now = Date.now();
  assert.equal(C.capGenOk({}, genStore('0'), {}), true, 'no order timestamps on a never-revoked store is fine');
  assert.equal(C.capGenOk({}, genStore(now.toString(36)), {}), false, 'a revoke with no order to date is a refusal');
  assert.equal(C.capGenOk({}, genStore(now.toString(36)), null), false, 'and with no order at all');
  assert.equal(C.capGenOk({}, genStore('zz!not36'), { at: iso(now) }), false, 'parseInt would read 1295 and call it 1969; the round-trip says otherwise');
  assert.equal(C.capGenOk({}, genStore((123).toString(36)), { at: iso(now) }), false, 'a number that is not a date in the ms range is not a revoke time');
  assert.equal(C.capGenOk({}, genStore('Z'.repeat(30)), { at: iso(now) }), false, 'absurd input is a closed door, not an exception');
});

test('capGenOk: only whole generations, in either spelling', () => {
  const g = Date.now().toString(36);
  assert.equal(C.capGenOk({ g }, genStore(g.toUpperCase()), {}), false,
    'the exact compare is exact: a store doc with a differently spelled generation is a different generation, and the door closes');
  assert.equal(C.capGenOk({}, genStore(nowish(g)), { at: iso(Date.now() + 1000) }), true,
    'the legacy path is case-tolerant, because it only has to read a number');
  assert.equal(C.capGenOk({ g: '' }, genStore('0'), { at: iso(Date.now()) }), true, 'an empty g is the legacy case, not the empty-generation case');
  assert.equal(C.capGenOk({}, genStore('0'), { at: 'not a date' }), true, 'a never-revoked store never needs the date at all');
});


/* --------------------------------------------------------------------------- 0.8.7
 * A mint that forgets the generation is not a style slip: it is the 0.8.6 bug returning by
 * omission, and no test that only exercises the door can see it. So the refusal lives in the
 * mint, where forgetting is impossible rather than discouraged. The renew link is the other
 * credential that answers to `auth_gen`, and it is judged by the same function, because a
 * second rule is a second opinion that can drift.
 */
test('an authority-bearing capability cannot be minted without the generation', async () => {
  assert.deepEqual(C.BOUND_CAP_ACTIONS, ['mark', 'proof', 'sess', 'ops'],
    'every capability kind this product mints that can change something');
  for (const a of C.BOUND_CAP_ACTIONS) {
    // the field named by the map, not by the habit of typing `g`: `ops` answers to the platform
    // generation, and a test that minted it with `g` would be asserting the wrong contract
    const field = C.capBindingField(a);
    await assert.rejects(() => C.issueCap(SEC, { a, h: 'shop', id: 'o1' }, 600), /cap_unbound/,
      a + ': an unbound mint must fail loudly, not ship a link outliving its revocation');
    for (const empty of [undefined, null, '']) {
      await assert.rejects(() => C.issueCap(SEC, { a, h: 'shop', id: 'o1', [field]: empty }, 600), /cap_unbound/,
        a + ': ' + JSON.stringify(empty) + ' is not a generation');
    }
    const cap = await C.issueCap(SEC, { a, h: 'shop', id: 'o1', [field]: 'g7' }, 600);
    assert.equal((await C.verifyCap(SEC, cap))[field], 'g7', a + ': with its own field the mint is normal');
  }
  // A whitelist, so the rule cannot quietly become "every cap must carry a generation": a
  // credential that changes nothing has no authority to bind.
  assert.equal(C.capNeedsGen('renew'), false);
  assert.equal(C.capNeedsGen(''), false);
  assert.equal(C.capNeedsGen(undefined), false);
  const free = await C.issueCap(SEC, { a: 'renew', h: 'shop', id: 'o1' }, 600);
  assert.ok(await C.verifyCap(SEC, free), 'an unbound non-authority cap still mints and verifies');
});

test('the binding is the field the door actually consults, not whichever letter is easiest', async () => {
  // `ops` caps carry `g: VERSION` and are revoked by the platform's own generation, `n`. If the
  // guard asked for `g` of everything, an ops cap could be minted with any `g` and be called bound
  // while nothing at the door ever read it — a check that passes is not a check that means it.
  assert.equal(C.capBindingField('mark'), 'g');
  assert.equal(C.capBindingField('proof'), 'g');
  assert.equal(C.capBindingField('sess'), 'g');
  assert.equal(C.capBindingField('ops'), 'n');
  assert.equal(C.capBindingField('renew'), null, 'a credential that is not a cap has no binding to demand');
  await assert.rejects(() => C.issueCap(SEC, { a: 'ops', g: 'v1' }, 600), /cap_unbound.*\(n\)/,
    'an ops cap with a version and no platform generation is refused');
  await assert.rejects(() => C.issueCap(SEC, { a: 'mark', n: '1' }, 600), /cap_unbound.*\(g\)/,
    'and the reverse: the right letter is not interchangeable');
  const ok = await C.issueCap(SEC, { a: 'ops', g: 'v1', n: '7' }, 600);
  assert.equal((await C.verifyCap(SEC, ok)).n, '7', 'with both fields it mints normally');
});

test('the renew link answers to the same rule as a signed capability', () => {
  const now = Date.now();
  const gen = now.toString(36);
  assert.equal(C.renewOk({ made: now, g: gen }, { auth_gen: gen }), true, 'minted under the live generation');
  assert.equal(C.renewOk({ made: now, g: 'older' }, { auth_gen: gen }), false,
    'a stale generation is closed whatever the clock says, because the clock is not the authority');
  assert.equal(C.renewOk({ made: now - 864e5, g: 'older' }, { auth_gen: gen }), false,
    'and the date cannot rescue it');
  assert.equal(C.renewOk({ made: now - 864e5 }, { auth_gen: '0' }), true,
    'a shop that never revoked has nothing for its link to be too old for — no cliff');
  assert.equal(C.renewOk({ made: 1000 }, { auth_gen: (now - 60000).toString(36) }), false,
    'a pre-0.8.7 link made before the revoke dies with it, which is what Revoke means');
  assert.equal(C.renewOk({ made: now }, { auth_gen: (now - 864e5).toString(36) }), true,
    'and one made after it stands');
  assert.equal(C.renewOk({ made: now }, { auth_gen: 'zz!not36' }), false,
    'a generation that is not a date counts as one that moved');
  assert.equal(C.renewOk(undefined, { auth_gen: gen }), false, 'no record, no link');
  assert.equal(C.renewOk({ made: now, g: gen }, null), false, 'no store, no verdict of innocent');
  assert.equal(C.renewOk({ g: 'x' }, { auth_gen: 'x' }), true,
    'a record with no date is still judged on its generation, which is the stronger evidence');
});

/* ============================== 0.9.0: VAT, the books, the receipt, the mesh */

test('0.9.0 a shop that never heard of VAT prices exactly as it did yesterday', () => {
  const st = { currency: 'USD' };
  const p = C.priceOrder(st, [{ name: 'Plate', price: 10, qty: 2 }], 'pickup', null);
  assert.equal(p.tax, 0);
  assert.equal(p.subtotal, 20);
  assert.equal(p.vat.on, false, 'no rate means no VAT, in either mode');
  assert.equal(p.vat.mode, 'excl');
  assert.match(C.receiptText({ shop_name: 'S' }, { code: 'X-1', items: [{ name: 'Plate', qty: 2, unit: 10, total: 20 }], pricing: p }),
    /not VAT-registered/, 'and the receipt says the plain truth about it');
});

test('0.9.0 the tax_pct a shop already set is the VAT rate, without a migration', () => {
  const plan = C.vatPlan({ tax_pct: 15 });
  assert.equal(plan.rate_pct, 15);
  assert.equal(plan.on, true);
  assert.equal(C.vatPlan({ tax_pct: 15, vat_rate_pct: 0 }).on, false, 'a shop can set the rate to nil and mean it');
  assert.equal(C.vatPlan({ tax_pct: 15, vat_rate_pct: 21 }).rate_pct, 21, 'the new field wins over the old one');
  assert.equal(C.vatPlan({ tax_pct: 999 }).rate_pct, 40, 'a rate outside the range is clamped, not trusted');
  assert.match(C.vatPlan({ tax_pct: 15 }).price_note, /added at checkout/);
  assert.match(C.vatPlan({ tax_pct: 15, vat_mode: 'incl' }).price_note, /include VAT/);
});

test('0.9.0 inclusive prices have the tax taken out of them, not added to them', () => {
  const items = [{ name: 'Chicken', price: 100, qty: 1 }];
  const ex = C.priceOrder({ tax_pct: 15 }, items, 'pickup', null);
  const inc = C.priceOrder({ tax_pct: 15, vat_mode: 'incl' }, [{ name: 'Chicken', price: 115, qty: 1 }], 'pickup', null);
  assert.equal(ex.subtotal, 115, 'exclusive: the shelf said 100, the buyer pays 115');
  assert.equal(inc.subtotal, 115, 'inclusive: the shelf said 115, the buyer pays 115');
  assert.equal(ex.tax, 15);
  assert.equal(inc.tax, 15, 'and the VAT the shop owes is the same figure either way');
  assert.equal(inc.vat.included, true);
  assert.equal(ex.vat.included, false);
  assert.equal(inc.vat.net, 100);
});

test('0.9.0 a zero-rated staple is zero-rated without turning the rest of the shop off', () => {
  const st = { tax_pct: 15 };
  const p = C.priceOrder(st, [{ name: 'Mealie meal', price: 100, qty: 1, vat_rate: 'zero' }, { name: 'Stew', price: 23, qty: 1 }], 'pickup', null);
  assert.equal(p.lines[0].vat_pct, 0);
  assert.equal(p.lines[1].vat_pct, 15);
  assert.equal(p.tax, 3.45, '15% of the stew, nothing of the meal');
  assert.equal(p.subtotal, 126.45, 'the meal is still on the invoice at its full price, with tax only on the stew');
  const both = C.priceOrder(st, [{ name: 'Mealie meal', price: 100, qty: 1, vat_rate: 'zero' }], 'pickup', null);
  assert.equal(both.tax, 0);
  assert.equal(C.vatLinePct({ vat_rate: 'exempt' }, st), -1, 'out of scope is its own answer, not a zero');
  assert.equal(C.vatLinePct({ vat_rate: '12.5' }, st), 12.5);
  assert.equal(C.vatLinePct({ vat_rate: 'nonsense' }, st), 15, 'a cell nobody meant falls back to the shop');
  assert.equal(C.cleanVatRate('18%'), '18');
  assert.equal(C.cleanVatRate('ZERO'), '0');
  assert.equal(C.cleanVatRate('-4'), '', 'a negative rate is refused, not obeyed');
});

test('0.9.0 the sheet gets a vat column and the editor gets a vat box', () => {
  const rows = C.parseProducts('id,name,price,vat\nm,Mealie meal,20,zero\ns,Stew,25,\n', { currency: 'USD' });
  assert.equal(rows[0].vat_rate, 'zero');
  assert.equal(rows[1].vat_rate, '', 'a blank cell means the shop rate, not zero');
  const e = C.sanitizeMenuEdit({ vat_rate: 'zero' }, 'shop');
  assert.equal(e.vat_rate, '0');
  assert.deepEqual(C.sanitizeMenuEdit({ price: '9' }, 'shop'), { price: 9 }, 'an edit that says nothing about VAT changes nothing about VAT');
  const m = C.sanitizeMenu({ over: { m: { vat_rate: '12' } }, handle: 'shop' });
  assert.equal(m.over.m.vat_rate, '12');
});

test('0.9.0 the books count the paid money on a cash basis and the orders on an accrual one', () => {
  const rows = [
    { id: 'a', code: 'A', at: '2026-10-01T09:00:00Z', marked_at: '2026-10-02T09:00:00Z', status: 'paid', total: 115, tax: 15, vat_pct: 15, pay_now: 115.07, rounding: 0.07 },
    { id: 'b', code: 'B', at: '2026-10-03T09:00:00Z', status: 'awaiting_payment', total: 230, tax: 30, vat_pct: 15 },
    { id: 'c', code: 'C', at: '2026-10-04T09:00:00Z', marked_at: '2026-10-04T10:00:00Z', status: 'paid', total: 60, tax: 0, vat_pct: 0 },
    { id: 'd', code: 'D', at: '2026-10-05T09:00:00Z', marked_at: '2026-10-05T10:00:00Z', status: 'cancelled', total: 40, tax: 5, vat_pct: 15 },
  ];
  const cash = C.vatReturn(rows, { tax_pct: 15 }, { basis: 'cash', from: '2026-10-01', to: '2026-10-31' });
  const acc = C.vatReturn(rows, { tax_pct: 15 }, { basis: 'accrual', from: '2026-10-01', to: '2026-10-31' });
  assert.equal(cash.count, 2, 'two payments arrived in October');
  assert.equal(cash.gross, 175);
  assert.equal(cash.vat, 15, 'the zero-rated row is on the return at nil, not off it');
  assert.equal(cash.net, 160);
  assert.equal(acc.count, 3, 'a cancelled order is in neither');
  assert.equal(acc.skipped, 1);
  assert.equal(cash.rates.length, 2, 'two rates means two lines on the return');
  assert.equal(cash.registered, false, 'the return reports what the shop claims about itself');
});

test('0.9.0 a row written before the tax fields are counted, and said out loud', () => {
  const rows = [{ id: 'l', at: '2026-09-01T09:00:00Z', marked_at: '2026-09-01T10:00:00Z', status: 'paid', total: 115 }];
  const r = C.vatReturn(rows, { tax_pct: 15 }, { basis: 'cash', period: '2026-09' });
  assert.equal(r.count, 1);
  assert.equal(r.estimated, 1, 'one row was worked out from today’s rate');
  assert.equal(r.vat, 17.25, 'the estimate is the arithmetic, not a shrug: 115 at today’s 15%');
  const j = C.vatReturn([{ id: 'n', at: '2026-09-02T09:00:00Z', marked_at: '2026-09-02T09:00:00Z', status: 'paid', total: 'nope' }], { tax_pct: 15 }, { basis: 'cash' });
  assert.equal(j.missing, 1);
  assert.equal(j.vat, 0, 'and an unreadable amount contributes nothing rather than a guess');
});

test('0.9.0 the summary and the CSV and the return are one computation in three clothes', () => {
  const rows = [
    { id: 'a', code: 'A', at: '2026-10-01T09:00:00Z', marked_at: '2026-10-02T09:00:00Z', status: 'paid', total: 115, tax: 15, vat_pct: 15, pay_now: 115.07, rounding: 0.07, rail: 'ecocash_usd', proof: '88123', payer: '0712345678' },
    { id: 'b', code: 'B', at: '2026-10-03T09:00:00Z', status: 'awaiting_payment', total: 230, tax: 30, vat_pct: 15, rail: 'cod' },
  ];
  const st = { handle: 'shop', shop_name: 'Tino & Sons', tax_pct: 15, currency: 'USD' };
  const s = C.booksSummary(rows, st, { period: '2026-10', basis: 'cash' });
  assert.equal(s.vat.gross, 115);
  assert.equal(s.collected, 115);
  assert.equal(s.money_in_by_rail.length, 1);
  assert.equal(s.money_in_by_rail[0].rail, 'ecocash_usd');
  assert.equal(s.outstanding_balance, 230, 'what has not arrived is named, as a balance, not hidden by the basis');
  assert.equal(s.with_proof, 1);
  assert.equal(s.rounding_identifiers, 0.07, 'the odd cents that identify a transfer are not income and are shown separately');
  const v = C.vatReturn(rows, st, { basis: 'cash', from: s.from, to: s.to });
  assert.equal(s.vat.vat, v.vat, 'the panel and the return cannot disagree');
  const csv = C.booksCsv(rows, st, { period: '2026-10', basis: 'cash' });
  assert.ok(csv.startsWith('# tapstall books pack'), 'a preamble an accountant reads as notes');
  assert.ok(csv.includes('date,ref,status,buyer,phone,service,rail,gross,vat,net'), 'then the real header');
  assert.ok(csv.includes('A,paid'), 'the row is in it');
  assert.ok(csv.includes('# totals'), 'and the totals are repeated where the file ends');
  assert.equal(C.booksCsv([{ id: 'x', code: 'Q"1', at: '2026-10-09T09:00:00Z', status: 'paid', total: 1, tax: 0, vat_pct: 0 }], st, {}).includes('"Q""1"'), true, 'a quote in a code is escaped, not a new column');
  assert.ok(C.booksCsv([{ id: 'y', code: 'OLD-1', at: '2026-10-08T09:00:00Z', status: 'paid', total: 100 }], st, { period: '2026-10' }).includes('OLD-1'),
    'a paid row with no marked date is still in the month it was ordered, not silently dropped');
  assert.equal(C.booksCsv([], st, { period: '2020-01' }).includes('gross,0.00'), true, 'an empty month is an empty month, said with zeros');
});

test('0.9.0 the receipt is the order it was printed from, in the money it was priced at', () => {
  const priced = C.priceOrder({ tax_pct: 15, currency: 'USD' }, [{ name: 'Chicken', price: 100, qty: 1 }], 'pickup', null);
  const o = { id: 'o1', code: 'MAM-7', at: '2026-10-01T09:00:00Z', marked_at: '2026-10-01T11:00:00Z',
    buyer: { name: 'Rudo', phone: '263771234567' }, items: [{ name: 'Chicken', qty: 1, unit: 100, total: 100 }], pricing: priced };
  const reg = { shop_name: 'Mama Too', handle: 'mamatoe', tax_pct: 15, vat_registered: true, vat_number: '4010000001', vat_address: '12 Mutare Rd' };
  // The registration the *order* was priced under is what the document says: a shop that ticks the
  // box in November does not restamp October's sales as tax invoices.
  const pricedReg = C.priceOrder({ ...reg, tax_pct: 15 }, [{ name: 'Chicken', price: 100, qty: 1 }], 'pickup', null);
  const oReg = { ...o, pricing: pricedReg };
  const txt = C.receiptText(reg, oReg);
  assert.match(txt, /TAX INVOICE/);
  assert.match(txt, /4010000001/);
  assert.match(txt, /MAM-7/);
  assert.match(txt, /VAT @ 15%\s+15\.00/);
  assert.match(txt, /Total\s+115\.00/);
  assert.ok(C.receiptText({ shop_name: 'S', tax_pct: 15 }, o).includes('not VAT-registered'), 'an unregistered shop prints a receipt, not a tax invoice');
  // the identity the order was priced under rides on the order, so a later tick-box does not
  // restamp an old sale as a tax invoice
  const html2 = C.receiptHtml({ shop_name: 'S', tax_pct: 15, vat_registered: true, vat_number: '9' }, o);
  assert.match(html2, /<h2>Receipt<\/h2>/, 'this order was priced before the shop registered');
  assert.match(C.receiptHtml(reg, { ...o, pricing: C.priceOrder(reg, [{ name: 'Chicken', price: 100, qty: 1 }], 'pickup', null) }), /Tax invoice/);
  assert.match(html2, /noindex|not VAT-registered/);
});

test('0.9.0 sample art draws, caches, and never claims to be a photo', () => {
  const svg = C.sampleArtSvg('2 litre Coke');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /2L|2l|2L/);
  assert.ok(!/http:\/\/[^"]*\.(com|net)/.test(svg.replace('http://www.w3.org/2000/svg', '')), 'no external reference of any kind');
  const u = C.sampleArtUrl('shop', { name: '2 litre Coke', cur: 'USD' });
  assert.ok(u.startsWith('/art/shop/'), u);
  assert.equal(u, C.sampleArtUrl('shop', { name: '2 litre Coke', cur: 'USD' }), 'the same row gives the same URL, so a year of cache is honest');
  assert.notEqual(u, C.sampleArtUrl('shop', { name: 'Other', cur: 'USD' }));
  assert.equal(C.realPhoto({ img: u, art: true }), '', 'fallback art is never a photo, for a crawler or anyone');
  assert.equal(C.realPhoto({ img: '/i/shop/abc123' }), '/i/shop/abc123');
  const withArt = C.applyMenu([{ id: 'x', name: 'X' }], { handle: 'shop' });
  assert.equal(withArt[0].art, true);
  assert.equal(C.applyMenu([{ id: 'x', name: 'X' }], { handle: 'shop', over: { x: { img: '' } } })[0].img, '', 'a merchant who cleared the box stays cleared');
});

test('0.9.0 the mesh has a budget, a memory, and no imagination', () => {
  const st = { shop_name: 'Mama Too', handle: 'mam', currency: 'USD', tax_pct: 15, whatsapp: '263771234567', hours: 'Mon-Sat 08:00-18:00' };
  const prods = Array.from({ length: 7 }, (_, i) => ({ id: 'p' + i, name: 'Item ' + (i + 1), price: 4 + i, cur: 'USD' }));
  const b = C.meshPack(st, prods, { currency: 'USD' }, { origin: 'https://t.test' });
  assert.equal(b.beats.length, C.MESH_BUDGET.per_day);
  assert.equal(b.beats.filter((x) => x.kind === 'promo').length, 1, 'value beats, then one promo, always');
  for (const x of b.beats) {
    assert.ok(x.text.length <= C.MESH_RAILS[x.rail].max, x.rail + ' is over its own limit');
    assert.match(x.text, /https:\/\/t\.test\/s\/mam/, 'every line ends where the order starts');
    if (x.price) assert.ok(prods.some((p) => p.price === x.price), 'and every number is a price on the menu');
  }
  assert.notEqual(b.beats[0].item_key, b.beats[1].item_key, 'the two value lines are about different things');
  assert.equal(b.beats.filter((x) => x.kind === 'value').map((x) => x.item_key).filter((x, i, a) => a.indexOf(x) !== i).length, 0, 'and no item is worth two value lines in one day');
  const used = {}; used[b.beats[0].item_key] = b.day;
  const again = C.meshPack(st, prods, { currency: 'USD' }, { origin: 'https://t.test', sent: { items: used } });
  assert.ok(!again.beats.some((x) => x.item_key === b.beats[0].item_key), 'a line posted today is quiet for a week');
  // Nothing on the menu is not nothing to say: the shop still exists, and a line that only says so
  // is worth more than a queue that renders blank and gets ignored.
  const empty = C.meshPack(st, [], { currency: 'USD' }, { origin: 'https://t.test' });
  assert.equal(empty.beats.length, 1);
  assert.ok(!/\d+\.\d{2} USD/.test(empty.beats[0].text), 'and not one figure in it');
  assert.match(empty.beats[0].text, /write to us on WhatsApp/);
  const broken = C.meshPack({ ...st, feed_error: 'feed_http_502' }, [], {}, { origin: 'https://t.test' });
  assert.ok(!/\d+\.\d{2} USD/.test(broken.beats.map((x) => x.text).join(' ')), 'a shop whose sheet is down is not quoted a price');
  assert.match(broken.beats[0].text, /confirm the price with you/);
  const doc = C.meshJson(broken ? st : st, prods, {}, 'https://t.test');
  assert.equal(doc.priced, true);
  assert.equal(doc.items.length, 7);
  assert.ok(!JSON.stringify(doc).includes('pay_account'), 'the public document carries no account number');
  const marked = C.meshMark(C.meshMark(null, ['p1'], Date.now()), ['p1', 'p2'], Date.now());
  assert.equal(Object.keys(marked.items).length, 2, 'the memory is a set of keys, not a log');
});

test('0.9.0 an operator patch fixes one row and leaves the rest of the shelf alone', () => {
  const cur = { over: { a: { price: 5 }, b: { price: 7 } }, extra: [{ id: 'z', name: 'Added', price: 3 }], hide: [], order: [], note: 'from the merchant' };
  const next = C.mergeMenuPatch(cur, { over: { a: { price: 6 } } }, 'shop');
  assert.equal(next.over.a.price, 6, 'the row named is changed');
  assert.equal(next.over.b.price, 7, 'the row not named is untouched');
  assert.equal(next.extra.length, 1, 'and the merchant’s own added row is still there');
  assert.equal(next.note, 'from the merchant', 'so is the note they wrote');
  const lifted = C.mergeMenuPatch(cur, { over: { a: false } }, 'shop');
  assert.equal(lifted.over.a, undefined, 'a row sent as false has its override taken off, and only that row');
  const cleared = C.mergeMenuPatch(cur, { over: { b: { img: '' } } }, 'shop');
  assert.equal(cleared.over.b.img, '', 'an explicit no-picture answer is respected through this door too');
  // `extra` is replaced when it is sent (a list, not a map), and the ref rule still runs on what
  // arrives: a patch cannot smuggle in another shop's picture.
  const foreign = C.mergeMenuPatch(cur, { extra: [{ name: 'Borrowed', price: 1, img: '/i/other/abcd' }] }, 'shop');
  assert.equal(foreign.extra.length, 1, 'the list sent is the list that replaces');
  assert.equal(foreign.extra[0].img, '', 'and the foreign reference was stripped on the way in');
  assert.equal(C.sanitizeMenuEdit({ available: false }, 'shop').available, false, 'both spellings of sold-out are read');
  assert.equal(C.sanitizeMenuEdit({ out: true }, 'shop').available, false, 'the sheet word and the checkbox word');
  assert.equal(C.sanitizeMenuEdit({ available: true }, 'shop').available, true, 'and back in');
  const kept = C.mergeMenuPatch(cur, { over: { a: { popular: true } } }, 'shop');
  assert.equal(kept.extra.length, 1, 'a patch that names no list leaves the list alone');
  assert.deepEqual(C.mergeMenuPatch(undefined, {}, 'shop'), C.sanitizeMenu({ handle: 'shop' }), 'nothing stored plus nothing sent is an empty shelf, not a crash');
});

/* ------------------------------------------------------------------ 0.9.10: USDT on Tron */
const CONTRACT = C.RAILS.usdt_trc20.crypto.contract;
const WALLET = 'TXuStMHPUxoRX8NPTTpJU6jBsBtZDRw2Uy';   // shape-valid, nobody's real wallet

test('0.9.10 a Tron address is T plus 33 base58 characters, and the shape check means it', () => {
  assert.equal(C.isTronAddr('T' + 'A'.repeat(33)), true);
  assert.equal(C.isTronAddr(WALLET), true);
  assert.equal(C.isTronAddr(' ' + WALLET + ' '), true, 'spaces around are the paste, not the address');
  assert.equal(C.isTronAddr(WALLET.toLowerCase()), false, 'base58 is case-sensitive: guessing one letter of somebody’s checksum is how USDT is lost');
  assert.equal(C.isTronAddr('T' + '0'.repeat(33)), false, '0 is not in the alphabet');
  assert.equal(C.isTronAddr('T' + 'O'.repeat(33)), false, 'neither is O');
  assert.equal(C.isTronAddr('T' + 'l'.repeat(33)), false, 'nor a lowercase L');
  assert.equal(C.isTronAddr('T' + 'I'.repeat(33)), false, 'nor an upper i');
  assert.equal(C.isTronAddr('T' + 'A'.repeat(32)), false, '33 characters after the T, not 32');
  assert.equal(C.isTronAddr('T' + 'A'.repeat(34)), false, 'not 34 either');
  assert.equal(C.isTronAddr(''), false);
  assert.equal(C.isTronAddr(null), false, 'nothing typed is not a wallet');
  assert.equal(C.isTronAddr('0x742d35Cc6634C05329362b4'), false, 'an EVM hex is not this shape at any length');
  assert.match(C.RAILS.usdt_trc20.crypto.contract, /^T[1-9A-HJ-NP-Za-km-z]{33}$/);   // the real USDT contract, by the same rule
});

test('0.9.10 six decimals: a cent is 10,000 units and a bill is always exact in both', () => {
  assert.equal(C.toUnits(6.34), 6_340_000, 'the odd cents of a unique-price order survive the trip — that is the whole matching scheme');
  assert.equal(C.toUnits('6.34'), 6_340_000, 'a string off an HTTP body counts the same as a number');
  assert.equal(C.toUnits(0.01), 10_000);
  assert.equal(C.toUnits('nan-ish'), 0, 'garbage reads as zero, and zero is not money');
  assert.equal(C.toUnits(12.03, 18), 12.03e18, 'the decimals count is the asset’s, passed by the caller, not baked into the arithmetic');
  assert.equal(C.fromUnits(6_340_000), 6.34);
  for (const v of [1, 10.5, 0.05, 6.34, 999999.99]) assert.equal(C.fromUnits(C.toUnits(v)), v, v + ' round-trips');
});

test('0.9.10 the match is the odd cents: exact credits, one percent says so, more is nobody’s order', () => {
  const at = Date.UTC(2026, 9, 15, 3, 0, 0);
  const T = (units, extra) => Object.assign({ txid: 'a1'.repeat(32), units, at }, extra || {});
  const A = (extra) => Object.assign({ id: 'a', code: 'K7M2QF', status: 'awaiting_payment',
    units: C.toUnits(6.34), proof: '' }, extra || {});
  const UNCLAIMED = 'a1'.repeat(32);   // not any order's TxID: pure chain traffic

  let r = C.cryptoMatch([T(C.toUnits(6.34))], [A()], 0.01);
  assert.equal(r.credits.length, 1, 'exact match credits');
  assert.equal(r.credits[0].kind, 'exact');
  assert.equal(r.credits[0].order_id, 'a', 'and it knows which order — by the amount, because the chain carries no memo');
  assert.equal(r.credits[0].shortfall_units, 0);
  assert.equal(r.loose.length + r.flags.length, 0, 'nothing is left unexplained');

  r = C.cryptoMatch([T(C.toUnits(6.34) - 30_000)], [A()], 0.01);
  assert.equal(r.credits.length, 1, 'a 0.47% short payment is a wallet fee, not a fraud');
  assert.equal(r.credits[0].kind, 'underpaid', 'credited and said so, never quietly');
  assert.equal(r.credits[0].shortfall_units, 30_000, 'the shortfall is in chain units, where the arithmetic happened');

  r = C.cryptoMatch([T(C.toUnits(5.00), { txid: UNCLAIMED })], [A({ proof: UNCLAIMED })], 0.01);
  assert.equal(r.credits.length, 0, 'nobody credits 79% of an order because a number matched');
  assert.equal(r.flags.length, 1);
  assert.equal(r.flags[0].kind, 'underpaid', 'the buyer named this order and this transfer — that is evidence for a human, not an instruction');
  assert.equal(r.flags[0].order_id, 'a');

  r = C.cryptoMatch([T(C.toUnits(5.00), { txid: UNCLAIMED })], [A({ proof: UNCLAIMED.slice(0, 40) })], 0.01);
  assert.equal(r.flags.length, 1, 'a stored proof is cleanProof’d to 40 of a 64-character TxID — prefix, or the claim line is dead in production and alive only in this file');
  assert.equal(r.flags[0].kind, 'underpaid');
  r = C.cryptoMatch([T(C.toUnits(5.00))], [A({ proof: '1234567' })], 0.01);
  assert.equal(r.flags.length, 0, 'a seven-character “code” is not a TxID prefix and claims nothing');
  assert.equal(r.loose.length, 1);

  r = C.cryptoMatch([T(C.toUnits(5.00), { txid: UNCLAIMED })], [A()], 0.01);
  assert.equal(r.flags.length, 0, 'an unclaimed odd amount is not a discrepancy, just somebody else’s Tuesday');
  assert.equal(r.loose.length, 1, 'but it is counted, so the report can say the sweep saw traffic');

  r = C.cryptoMatch([T(C.toUnits(6.34) + 20_000)], [A()], 0.01);
  assert.equal(r.credits[0].kind, 'overpaid', 'more inside the band is their overpay and the shop’s to notice');

  r = C.cryptoMatch([T(C.toUnits(6.34))], [A({ id: 'a' }), A({ id: 'b' })], 0.01);
  assert.equal(r.credits.length, 0, 'nothing is guessed when a guess spends money twice');
  assert.equal(r.flags[0].kind, 'ambiguous');
  assert.deepEqual(r.flags[0].order_ids, ['a', 'b'], 'and the human is told every order it could be');

  r = C.cryptoMatch([T(C.toUnits(6.34))], [A({ status: 'paid' })], 0.01);
  assert.equal(r.credits.length, 0, 'a paid order is not an open one — even by the buyer’s own refund');
  assert.equal(r.loose.length, 1, 'counted as traffic, not credited as anything');

  r = C.cryptoMatch([T(C.toUnits(6.34)), T(C.toUnits(6.34), { txid: 'b2'.repeat(32) })], [A()], 0.01);
  assert.equal(r.credits.length, 1, 'one order, one credit — a second transfer is not a second payment for it');
  assert.equal(r.loose.length, 1, 'the second is loose until a person says otherwise');

  r = C.cryptoMatch([T(C.toUnits(6.34)), { txid: 'a1'.repeat(32), units: 99, at }], [A()], 0.01);
  assert.equal(r.credits.length, 1, 'a replayed txid line is skipped, not double-counted');
  assert.equal(r.loose.length + r.flags.length, 0, 'skipped means skipped');

  r = C.cryptoMatch([{ txid: '', units: 6_340_000, at }, { txid: 'c3'.repeat(32), units: 0, at }, null,
    undefined, { txid: 'd4'.repeat(32) }, T(C.toUnits(6.34))], [A()], 0.01);
  assert.equal(r.credits.length, 1, 'the one well-formed transfer still does its job next to four junk ones');
  assert.equal(r.loose.length + r.flags.length, 0, 'and the junk makes no noise');

  r = C.cryptoMatch([T(6_340_000 * 0.5)], [A()], 0.01);
  assert.equal(r.credits.length, 0);
  r = C.cryptoMatch([T(C.toUnits(12.03) - 120_300)], [A({ units: C.toUnits(12.03) })], 0.01);
  assert.equal(r.credits.length, 1, 'at the exact edge of the band is inside it');
  r = C.cryptoMatch([T(C.toUnits(12.03) - 120_301)], [A({ units: C.toUnits(12.03) })], 0.01);
  assert.equal(r.credits.length, 0, 'one micro over it is outside, and the buyer keeps owing the rest');

  r = C.cryptoMatch([T(0), T(C.toUnits(6.34))], [A()], 25);
  assert.equal(r.credits.length, 1, 'the band is read as a percentage, and 25% of anything is a policy somebody should have to type');
  r = C.cryptoMatch([T(C.toUnits(6.34))], [A()], 9999);
  assert.equal(r.credits.length, 1, 'a nonsense tolerance is clamped to 50%, not trusted');
  r = C.cryptoMatch([T(C.toUnits(4.00))], [A()], 9999);
  assert.equal(r.credits.length, 1, 'and 4 dollars inside a 50% band of 6.34 credits — which is exactly why nobody gets to set that number');

  r = C.cryptoMatch([], [], 0.01);
  assert.deepEqual(r, { credits: [], flags: [], loose: [] }, 'a quiet hour is three empty lists, not a crash');
  assert.equal(C.cryptoMatch(undefined, undefined).credits.length, 0, 'and nothing at all in is still nothing at all out');
});

test('0.9.10 the slip, when the rail is a chain, says USDT, says TRC-20, and drops the lines that cannot apply', () => {
  const st = { shop_name: 'Chain Chef', currency: 'USD', pay_account: WALLET, pay_holder: 'MAMA TOE',
    reference_format: '{code}', rail: 'usdt_trc20' };
  const pay = C.payInstructions(st, { id: 'o1', code: 'K7M2QF' }, { rail: C.RAILS.usdt_trc20, pay_now: 6.34 });
  assert.equal(pay.currency, 'USDT', 'the unit on the big line is the asset, not the shop’s ZAR');
  assert.equal(pay.account, WALLET, 'printed exactly as typed: base58 is case-sensitive and a “prettier” address is a lost one');
  assert.equal(pay.account_label, 'TRC-20 address', 'the field says which network it wants before anything is pasted into it');
  assert.ok(pay.steps.some((s) => /not recoverable/.test(s)), 'the wrong-chain warning is a numbered step, not a footnote');
  assert.ok(pay.steps.some((s) => /exactly 6\.34 USDT/.test(s)), 'amount and unit are in the send line itself');
  assert.ok(pay.steps.some((s) => /TRC-20 \(TRON\)/.test(s)), 'the chain id is internal and lowercase; the buyer sees it upper, in wallet language');
  assert.match(pay.note, /odd cents/, 'the buyer is told why the number is odd — that is what makes the payment findable');
  assert.ok(!pay.steps.some((s) => /Check it reads/.test(s)), 'no holder check on a chain: the confirmation screen shows a wallet, not a name, and promising the lie would teach buyers to ignore the line that matters on the other rails');
  assert.ok(!pay.steps.some((s) => /Use reference/.test(s)), 'a TRC-20 transfer has no reference field to use — telling them to fill one trains them to skip the real step');
  assert.equal(pay.crypto.asset, 'USDT');
  assert.equal(pay.crypto.network, 'TRC-20');
  assert.equal(pay.proof, '', 'nothing typed yet is nothing printed, on any rail');
  const pay2 = C.payInstructions({ ...st, rail_accts: { usdt_trc20: { acct: 'T' + 'D'.repeat(33) } } },
    { code: 'K7M2QF' }, { rail: C.RAILS.usdt_trc20, pay_now: 6.34 });
  assert.equal(pay2.account, 'T' + 'D'.repeat(33), 'the per-rail row wins over the store default, same as every other rail');
  const pe = C.payInstructions(st, { code: 'K7M2QF' }, { rail: C.RAILS.eocash, pay_now: 6.34 });
  assert.equal(pe.crypto, null, 'nothing crypto on an EcoCash rail, ever');
  assert.equal(pe.currency, 'USD', 'and the unit goes back to the shop’s own');
  assert.ok(pe.steps.some((s) => /Use reference/.test(s)), 'the phone rails keep their reference line');
});

test('0.9.10 the placeholder rule is exact — it decides a UI now, not just a warning', () => {
  assert.equal(C.isPlaceholderFeed(''), true);
  assert.equal(C.isPlaceholderFeed(undefined), true);
  assert.equal(C.isPlaceholderFeed(null), true);
  assert.equal(C.isPlaceholderFeed('https://tapstall.dev/data/sample-menu.csv'), true, 'the onboarding default');
  assert.equal(C.isPlaceholderFeed('https://zimlink.simalidudu.co.zw/pages/sample-menu.csv'), true, 'the Pages one, at either path');
  assert.equal(C.isPlaceholderFeed('https://x.test/data/sample-menu.csv?v=3'), true, 'a query does not launder a sample');
  assert.equal(C.isPlaceholderFeed('https://raw.githubusercontent.com/zimlink/tapstall/main/pages/sample-menu.csv'), true);
  assert.equal(C.isPlaceholderFeed('https://raw.githubusercontent.com/mari/menus/main/sample-menu.csv'), false, 'somebody else’s repo, our filename: their menu. The rule is the sample’s path, not the host');
  assert.equal(C.isPlaceholderFeed('https://raw.githubusercontent.com/zimlink/tapstall/main/pages/README.md'), false, 'our own repo, not the file: not ours to call a placeholder');
  assert.equal(C.isPlaceholderFeed('https://docs.google.com/spreadsheets/d/abc/edit#gid=0'), false);
  assert.equal(C.isPlaceholderFeed('sample-menu.csv'), false, 'a bare filename somebody typed is not ours to call a sample — the rule is our path or nothing');
});

test('0.9.10 no real feed means the cache describes nothing — the head cannot out-live the shelf', () => {
  // shelfRows is the seam: same cached rows, and whether they count depends on whether
  // there is a feed under them at all. seoFacts reads through it, which is the one place
  // the old loose rule could make a crawler describe rows no page ever showed.
  const rows = [{ id: 'a', name: 'Chicken kota', price: 22.5, cur: 'ZAR' }];
  const stale = { shop_name: 'S', currency: 'ZAR',
    feed_url: 'https://raw.githubusercontent.com/zimlink/tapstall/main/pages/sample-menu.csv',
    feed_cache: { ts: 1, products: rows } };
  assert.doesNotMatch(C.seoFacts(stale, ORIGIN, MON_10).desc, /Chicken kota/, 'the demo rows are not this shop’s shelf, cached or not');
  assert.match(C.seoFacts({ ...stale, feed_url: 'https://docs.google.com/spreadsheets/d/abc/edit' }, ORIGIN, MON_10).desc,
    /Chicken kota/, 'a cached real sheet still describes the shelf while a fetch fails — that is what the cache is for');
});

test('0.9.10 a client delete keeps the row restorable and never falls on a stranger', () => {
  // the authed dashboard lets a no-sheet shop delete any row — so `del` must carry the full
  // item to the tray that restores it, tolerate a bare id, dedupe, and still refuse to let a
  // delete reach through to the sheet rows it shares ids with by accident (1, 2, 3, ...)
  const m = C.sanitizeMenu({ handle: 'shop',
    extra: [{ id: 'e1', name: 'Kota', price: 5 }, { id: 'e2', name: 'Chips', price: 3 }],
    del: [{ id: 'e2', name: 'Chips', price: 3, available: false }, { id: 'e2', name: 'Chips again', price: 1 }, { id: '' }, 'e9', { id: 'x'.repeat(80) }],
  }, 'shop');
  assert.equal(m.del.length, 3, 'the duplicate id is dropped and the empty one never was; bare ids ride along');
  assert.equal(m.del[2].id.length, 60, 'and an over-long id is cut to what the shelf allows, not kept as a receipt of the overflow');
  assert.equal(m.del[0].name, 'Chips', 'a deleted row keeps its copy — the tray is built from `del`, so the first write decides');
  assert.equal(m.del[0].deleted, true, 'and says what it is');
  assert.equal(m.del[1].id, 'e9');
  assert.deepEqual(Object.keys(m.del[1]), ['id'], 'a bare id is all a bare id can promise: no restorable copy, and nothing invented');
  assert.equal(m.extra.length, 2, 'sanitize stores the list it was given; the falling-out is applyMenu’s job');

  const shelf = C.applyMenu(
    [{ id: '1', name: 'Sheet one', price: 4 }, { id: '2', name: 'Sheet two', price: 9 }],
    { extra: [{ id: 'e1', name: 'Kota', price: 5 }, { id: 'e2', name: 'Chips', price: 3 }],
      del: [{ id: 'e2', name: 'Chips', price: 3 }],
      over: { e2: { popular: true } }, order: ['e1', 'e2'], hide: [] },
    'shop');
  assert.deepEqual(shelf.map((p) => p.id), ['e1', '1', '2'], 'the deleted extra is off the shelf, and the surviving order is extras-first as always');
  assert.ok(!shelf.some((p) => p.id === 'e2'), 'everywhere');
  const sameId = C.applyMenu([{ id: 'e2', name: 'Sheet chip', price: 7 }], { del: [{ id: 'e2', name: 'My chip', price: 3 }], extra: [] }, 'shop');
  assert.deepEqual(sameId.map((p) => p.id), ['e2'], 'and a base row that merely shares the id keeps standing: the delete falls on this shop’s list, never on the sheet under it');

  const bare = C.applyMenu([], { extra: [{ id: 'e1', name: 'Kota', price: 5 }], del: ['e1'] }, 'shop');
  assert.equal(bare.length, 0, 'the bare-id form deletes too — it just cannot be restored from');
});
