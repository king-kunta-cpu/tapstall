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
  assert.equal(out.open.open, false, 'and open/closed is computed here, not on the buyer’s clock');
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
