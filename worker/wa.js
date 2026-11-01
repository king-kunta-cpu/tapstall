/**
 * The WhatsApp shop bot: a Tapstall store that a buyer shops *inside* WhatsApp.
 *
 * Why this surface exists: most buyers on this platform pay for WhatsApp-only data bundles. A
 * storefront link opens a browser, and a browser is billed from the general bundle the buyer
 * usually does not have. A buyer who can only afford WhatsApp could not order at all. Here the
 * whole order happens in the chat: "send 3 for the beef stew", a cart, pickup or delivery, the
 * payment instructions, and the payment code pasted back into the chat. Nothing leaves WhatsApp.
 *
 * This module is the conversation and nothing else. It holds no credentials, reads no storage
 * and calls no network: the Worker hands it a session object, one inbound message and a `deps`
 * bag (find a store, read its menu, place an order through the same `placeOrder` the storefront
 * uses, file a payment code through the same `proofAdd`), and gets back the new session and the
 * replies to send. So pricing, the order slip, the payment instructions, risk flags and the proof
 * rules stay exactly where they are, in one tested place, and this file only decides what to say.
 *
 * Every reply costs money after Meta's 1,000 free service messages a month per business number,
 * so an order is built to cost exactly two: the menu (with the instructions and every item's
 * choice letters in it) and the order slip (with the total and how to pay). Everything between and
 * after is acknowledged with an emoji reaction, which Meta does not bill and does not count
 * against the free tier: 👍 added, ❓ not understood, ✅ payment code filed.
 */

export const WA_VERSION = 2;
export const WA_SEEN_MAX = 24;                 // message ids remembered for webhook-retry dedupe
export const WA_CART_MAX = 30;                 // lines in one cart (placeOrder takes 40)
export const WA_TEXT_MAX = 3900;               // WhatsApp's text body limit is 4,096
export const WA_IDLE_MS = 3 * 24 * 3600e3;     // an abandoned cart is forgotten after 3 days
export const WA_HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

const waM2 = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const waClip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const waDigits = (s) => String(s || '').replace(/\D/g, '');

/** A fresh session. `seen` is the retry guard: Meta re-delivers a webhook it did not get a 200 for. */
export function waSession(prev) {
  const p = prev && typeof prev === 'object' && prev.v === WA_VERSION ? prev : {};
  return {
    v: WA_VERSION,
    shop: p.shop || '',
    cart: Array.isArray(p.cart) ? p.cart : [],
    notes: Array.isArray(p.notes) ? p.notes : [],
    ids: Array.isArray(p.ids) ? p.ids : [],
    menu_at: Number(p.menu_at) || 0,
    name: p.name || '',
    address: p.address || '',
    last: p.last || null,
    day: p.day || '',
    day_n: Number(p.day_n) || 0,
    seen: Array.isArray(p.seen) ? p.seen : [],
    at: Number(p.at) || 0,
    last_in: Number(p.last_in) || 0,
  };
}

/* ------------------------------------------------------------------ inbound */

/**
 * Meta's webhook body, flattened to the messages a bot answers. Statuses (sent, delivered, read,
 * failed) are dropped: they are receipts about our own messages, and answering them would be a
 * loop that bills us. Every message type is kept so a sticker or voice note gets a ❓ reaction
 * rather than silence.
 */
export function waInbound(payload) {
  const out = [];
  const entries = payload && payload.object === 'whatsapp_business_account' && Array.isArray(payload.entry) ? payload.entry : [];
  for (const e of entries) {
    for (const ch of (Array.isArray(e && e.changes) ? e.changes : [])) {
      const v = ch && ch.field === 'messages' && ch.value ? ch.value : null;
      if (!v || !Array.isArray(v.messages)) continue;
      const meta = v.metadata || {};
      const names = {};
      for (const c of (Array.isArray(v.contacts) ? v.contacts : [])) {
        if (c && c.wa_id) names[String(c.wa_id)] = String((c.profile && c.profile.name) || '').slice(0, 60);
      }
      for (const msg of v.messages) {
        if (!msg || !msg.from || !msg.id) continue;
        const from = waDigits(msg.from).slice(0, 20);
        if (from.length < 8) continue;
        let text = '';
        if (msg.type === 'text') text = String((msg.text && msg.text.body) || '');
        else if (msg.type === 'interactive') {
          const i = msg.interactive || {};
          text = String((i.button_reply && i.button_reply.id) || (i.list_reply && i.list_reply.id) || '');
        } else if (msg.type === 'button') text = String((msg.button && (msg.button.payload || msg.button.text)) || '');
        out.push({
          phone_id: String(meta.phone_number_id || ''),
          display: waDigits(meta.display_phone_number || ''),
          from, id: String(msg.id).slice(0, 200), type: String(msg.type || 'unknown'),
          text: text.slice(0, 1200), name: names[from] || '',
          ts: Number(msg.timestamp) || 0,
        });
      }
    }
  }
  return out;
}

/** `X-Hub-Signature-256: sha256=<hex>` over the raw body, keyed with the app secret. */
export async function waSigOk(raw, header, secret) {
  if (!secret || !header) return false;
  const want = String(header).trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, typeof raw === 'string' ? enc.encode(raw) : raw));
  const got = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

/** The Graph API body for one plain text message. Plain text is used on purpose: it renders on
 *  every WhatsApp build, including the KaiOS feature-phone app, and "send 3" needs no buttons. */
export function waTextBody(to, text) {
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to: waDigits(to),
    type: 'text', text: { preview_url: false, body: waClip(text, WA_TEXT_MAX) } };
}

/** A reaction on the buyer's own message: the bot's free "got it". Meta bills no reaction and
 *  counts none against the 1,000 free service messages, so every acknowledgement is one of these. */
export function waReactBody(to, messageId, emoji) {
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to: waDigits(to),
    type: 'reaction', reaction: { message_id: String(messageId || ''), emoji: String(emoji || '') } };
}

/** The install link a merchant shares: opens the bot's chat inside WhatsApp with the shop code
 *  already typed, so the buyer's first tap is "send". `wa.me` is answered by the WhatsApp app
 *  itself on a phone, so it does not need a browser bundle. */
export function waBotLink(number, handle, shopName) {
  const n = waDigits(number);
  if (!n || !WA_HANDLE_RE.test(String(handle || ''))) return '';
  const text = `Hi ${String(shopName || handle).replace(/[#\n]/g, ' ').trim().slice(0, 60)}! #${handle}`;
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}

/* ------------------------------------------------------------- proof codes */

/**
 * The payment code out of whatever the buyer pasted. EcoCash, OneMoney, InnBucks and bank apps
 * all print a confirmation SMS with the code somewhere in a sentence; asking a buyer to cut it
 * out by hand on a small phone is how codes arrive mistyped. Labelled codes win, then the
 * EcoCash shape, then the longest letters-and-digits token. The order's own reference is never
 * taken for the payment's code: an SMS that quotes "Ref MAM-0012" is quoting us back.
 */
export function waProofFrom(text, orderCode) {
  const t = String(text || '').slice(0, 800);
  const own = String(orderCode || '').toUpperCase();
  const ok = (c) => {
    const s = String(c || '').replace(/[.\-\/]+$/, '');
    return s.length >= 5 && s.length <= 40 && /\d/.test(s) && s.toUpperCase() !== own ? s : '';
  };
  const labelled = /(?:approval\s*code|txn\s*id|trans(?:action)?\.?\s*(?:id|ref(?:erence)?|no\.?|number|code)|receipt\s*(?:no\.?|number)?|confirmation\s*(?:code|no\.?|number)?|ref(?:erence)?\s*(?:no\.?|number)?|code|id)\s*[:#.\-]?\s*([A-Za-z0-9][A-Za-z0-9.\-\/]{3,39})/gi;
  let m;
  while ((m = labelled.exec(t))) { const c = ok(m[1]); if (c) return c; }
  const eco = t.match(/\b[A-Z]{2,4}\d{6}\.\d{4}\.[A-Z0-9]{4,8}\b/i);
  if (eco && ok(eco[0])) return ok(eco[0]);
  const toks = (t.match(/[A-Za-z0-9][A-Za-z0-9.\-\/]{4,39}/g) || [])
    .map((x) => x.replace(/[.\-\/]+$/, ''))
    .filter((x) => /\d/.test(x) && /[A-Za-z]/.test(x) && ok(x) && !/^(usd|zwg|zig|zar)\d/i.test(x));
  if (toks.length) return toks.sort((a, b) => b.length - a.length)[0];
  // a code typed on its own (one or two words): the last resort, and never one that quotes the order
  const bare = t.trim();
  if (own && bare.toUpperCase().indexOf(own) >= 0) return '';
  if (bare.length >= 5 && bare.length <= 40 && /\d/.test(bare) && bare.split(/\s+/).length <= 2) return ok(bare.replace(/[^A-Za-z0-9 ._\/-]/g, ''));
  return '';
}

/* ---------------------------------------------------------- order grammar */

/*
 * The whole order fits in one line a buyer can type on any phone:
 *
 *     1bd, 2x2 pickup
 *     1bd deliver 14 Fife Ave, near the Spar
 *
 * A number picks the menu item; letters after it pick that item's choices and extras (each item's
 * own letters, printed under it on the menu, a…z without x); "x2" is how many. "pickup" or
 * "deliver <address>" at the end sends the order. Items can also come over several messages: each
 * understood message gets a free 👍 reaction instead of a billed reply, and the order slip is the
 * next message the bot writes. That is the point: menu + slip, two billed replies per order.
 */
export const WA_LETTERS = 'abcdefghijklmnopqrstuvwyz';        // no x: x is "how many"
const WA_FILLER = new Set(['and', 'please', 'pls', 'plz', 'also', 'plus', 'then', 'add', 'thanks']);

/**
 * One message → { items:[{n, letters, qty}], service, address } when every word in it belongs to
 * the grammar; { bad:true } when it tries to (starts with an item number) but something does not
 * fit; null when it is not an order at all (a greeting, an SMS, a question). Nothing is half-read:
 * a message with one word that does not fit adds nothing, so a buyer is never surprised by a cart.
 */
export function waParseOrder(text) {
  const orig = String(text || '').replace(/[*_~`]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!orig || orig.length > 600) return null;
  let low = orig.toLowerCase();
  const same = low.length === orig.length;            // indices line up, so the address keeps its case
  let service = '', address = '';
  const dm = low.match(/(?:^|[\s,;.])(deliver(?:y|ed)?)(?:\s+(?:it\s+)?to)?(?=$|[\s,:;.\-])/);
  if (dm) {
    service = 'delivery';
    address = (same ? orig : low).slice(dm.index + dm[0].length).replace(/^[\s,:;.\-]+/, '').trim().slice(0, 200);
    low = low.slice(0, dm.index);
  } else {
    const pm = low.match(/(?:^|[\s,;.])(pick\s*-?\s*up|collect(?:ion)?|i'?ll\s+collect)(?:\s+(?:please|pls|plz|thanks))?[\s.!]*$/);
    if (pm) { service = 'pickup'; low = low.slice(0, pm.index); }
  }
  const body = low.replace(/\s*[x×*]\s*(\d)/g, 'x$1').trim();
  const toks = body ? body.split(/[\s,;&+.]+/).filter(Boolean) : [];
  const items = [];
  let stray = false;
  for (const tk of toks) {
    const m = tk.match(/^(\d{1,3})([a-wyz]{0,12})(?:x(\d{1,2}))?$/);
    if (m) items.push({ n: Number(m[1]), letters: m[2] || '', qty: Math.max(1, Math.min(99, Number(m[3] || 1))) });
    else if (!WA_FILLER.has(tk)) stray = true;
  }
  if (stray) return /^\d{1,3}([a-wyz]|x\d|[\s,]|$)/.test(body) ? { bad: true } : null;
  if (!items.length && !service) return null;
  return { items: items.slice(0, 20), service, address };
}

/** An item's letters: its option groups' choices in order, then its extras. */
export function waCodes(p) {
  const out = [];
  let i = 0;
  (Array.isArray(p.opts) ? p.opts : []).forEach((g, gi) => (g.choices || []).forEach((c) => {
    if (i < WA_LETTERS.length) out.push({ l: WA_LETTERS[i++], g: gi, label: String(c.label || ''), up: Number(c.up) || 0 });
  }));
  (Array.isArray(p.addons) ? p.addons : []).forEach((a) => {
    if (i < WA_LETTERS.length) out.push({ l: WA_LETTERS[i++], add: true, label: String(a.name || ''), up: Number(a.price) || 0 });
  });
  return out;
}

/** One parsed pick against the menu: the cart line, or why it cannot be one. Notes are what the
 *  slip will say about it (a choice the buyer left out gets the first one, said out loud). */
function waResolve(pk, ids, products) {
  const id = ids[pk.n - 1];
  const p = id != null ? products.find((x) => String(x.id) === String(id)) : null;
  if (!p) return { err: 'no item ' + pk.n };
  if (p.available === false) return { err: waClip(p.name, 30) + ' is sold out' };
  const codes = waCodes(p);
  const groups = Array.isArray(p.opts) ? p.opts : [];
  const chosen = new Map();
  const addons = [];
  for (const l of pk.letters) {
    const c = codes.find((x) => x.l === l);
    if (!c) return { err: pk.n + l + ' is not a choice' };
    if (c.add) { if (!addons.some((a) => a.name === c.label)) addons.push({ name: c.label, price: c.up }); continue; }
    if (chosen.has(c.g)) return { err: 'two choices for one ' + String(groups[c.g].name || 'option').toLowerCase() };
    chosen.set(c.g, c);
  }
  const options = [];
  const notes = [];
  groups.forEach((g, gi) => {
    const ch = (g.choices || []);
    if (!ch.length) return;
    const pick = chosen.get(gi);
    if (pick) { options.push({ label: pick.label, up: pick.up }); return; }
    options.push({ label: String(ch[0].label || ''), up: Number(ch[0].up) || 0 });
    if (ch.length > 1) notes.push(`${waClip(p.name, 30)}: no ${String(g.name || 'choice').toLowerCase()} sent, so ${waClip(ch[0].label, 20)}`);
  });
  return { p, qty: pk.qty, options, addons, notes };
}

/* ---------------------------------------------------------------- the menu */

function waCatOf(p) { return String(p.cat || 'Menu').trim() || 'Menu'; }

function waItemBlock(n, p, cur) {
  if (p.available === false) return `*${n}* ~${waClip(p.name, 48)}~ _sold out_`;
  const rows = [`*${n}* ${waClip(p.name, 48)} · ${waM2(p.price)}`];
  const codes = waCodes(p);
  (Array.isArray(p.opts) ? p.opts : []).forEach((g, gi) => {
    const cs = codes.filter((c) => !c.add && c.g === gi);
    if (cs.length) rows.push(`   ${waClip(g.name || 'Choose', 20)}: ${cs.map((c) => `*${c.l}* ${waClip(c.label, 24)}${c.up ? ' +' + waM2(c.up) : ''}`).join(' · ')}`);
  });
  const adds = codes.filter((c) => c.add);
  if (adds.length) rows.push(`   Extras: ${adds.map((c) => `*${c.l}* ${waClip(c.label, 24)}${c.up ? ' +' + waM2(c.up) : ''}`).join(' · ')}`);
  return rows.join('\n');
}

/** "How to order", written from this shop's own menu so the examples are real items. */
function waHowTo(st, list) {
  const cur = (st && st.currency) || 'USD';
  const avail = list.map((p, i) => ({ p, n: i + 1 })).filter((x) => x.p.available !== false);
  const withCodes = avail.find((x) => waCodes(x.p).length >= 2) || avail.find((x) => waCodes(x.p).length);
  const plain = avail.find((x) => x !== withCodes) || avail[0];
  const lines = ['*HOW TO ORDER*'];
  if (plain) lines.push(`• Send the item number: *${plain.n}* · two of it: *${plain.n}x2*`);
  let ex = plain ? `${plain.n}x2` : '1';
  if (withCodes) {
    const codes = waCodes(withCodes.p);
    const groups = Array.isArray(withCodes.p.opts) ? withCodes.p.opts : [];
    const pickEx = [];
    groups.forEach((g, gi) => { const cs = codes.filter((c) => !c.add && c.g === gi); if (cs.length) pickEx.push(cs[Math.min(1, cs.length - 1)]); });
    const add = codes.find((c) => c.add);
    if (add) pickEx.push(add);
    const lt = pickEx.map((c) => c.l).join('');
    lines.push(`• Choices and extras: letters after the number. *${withCodes.n}${lt}* = ${waClip(withCodes.p.name, 30)}, ${pickEx.map((c) => (c.add ? '+' : '') + waClip(c.label, 16)).join(', ')}`);
    if (groups.length) lines.push('   (no letter sent = the first choice)');
    ex = `${withCodes.n}${lt}` + (plain && plain !== withCodes ? `, ${plain.n}x2` : '');
  }
  const fee = Number(st && st.delivery_fee) || 0;
  const freeOver = Number(st && st.free_over) || 0;
  lines.push('• Several at once, with commas: *' + ex + '*');
  lines.push('• *Finish with* _pickup_ or _deliver_ and your address:');
  lines.push(`   _${ex} pickup_`);
  lines.push(`   _${ex} deliver 14 Fife Ave, near the Spar_`);
  if (fee) lines.push(`   Delivery ${waM2(fee)} ${cur}${freeOver ? ', free over ' + waM2(freeOver) : ''}.`);
  lines.push('', 'One message or a few, as you like. I react 👍 when I have added it and ❓ when I could not read it (then nothing was added: check the numbers and send it again). Your total and how to pay come in my next message.');
  lines.push('I read typed text only, not voice notes or photos.');
  lines.push('_x_ empty my cart · _cart_ · _help_ · _talk_ to the shop');
  return lines.join('\n');
}

/**
 * The menu: one message with every item, its letters and the instructions. A menu too long for one
 * message is cut into pages by section (*menu 2*, *menu 3*), the numbers staying the menu's own, so
 * a buyer who knows what they want orders from page 1 and never pays for page 2.
 */
export function waMenu(st, products, hours, page) {
  const cur = (st && st.currency) || 'USD';
  const list = Array.isArray(products) ? products : [];
  const ids = list.map((p) => String(p.id));
  const head = `*${waClip((st && (st.shop_name || st.handle)) || 'Shop', 60)}*`
    + (hours && hours.known && hours.label ? `\n_${hours.label}${hours.open ? '' : ' (you can still order; they will see it when they open)'}_` : '')
    + ((st && st.welcome_message) ? `\n${waClip(st.welcome_message, 200)}` : '');
  if (!list.length) return { ids, pages: 1, text: `${head}\n\nThe menu is empty right now. Send *talk* to message the shop.` };
  const how = waHowTo(st, list);
  const cats = [];
  list.forEach((p, i) => {
    const c = waCatOf(p);
    let sec = cats.find((x) => x.name === c);
    if (!sec) { sec = { name: c, rows: [] }; cats.push(sec); }
    sec.rows.push(waItemBlock(i + 1, p, cur));
  });
  const multi = cats.length > 1;
  const blocks = [];
  for (const c of cats) {
    let cur2 = multi ? `_${waClip(c.name, 40)}_` : '';
    for (const r of c.rows) {
      if (cur2.length + r.length > 1800) { blocks.push({ name: c.name, text: cur2 }); cur2 = (multi ? `_${waClip(c.name, 40)} (more)_` : ''); }
      cur2 += (cur2 ? '\n' : '') + r;
    }
    blocks.push({ name: c.name, text: cur2 });
  }
  const budget = WA_TEXT_MAX - head.length - how.length - 160;
  const pages = [];
  for (const b of blocks) {
    const last = pages[pages.length - 1];
    if (last && last.len + b.text.length + 2 <= budget) { last.parts.push(b); last.len += b.text.length + 2; }
    else pages.push({ parts: [b], len: b.text.length });
  }
  const pi = Math.max(0, Math.min(pages.length - 1, (Number(page) || 1) - 1));
  const more = pages.length > 1
    ? '\n\n' + pages.map((pg, i) => (i === pi ? null : `*menu ${i + 1}*: ${[...new Set(pg.parts.map((x) => waClip(x.name, 20)))].join(', ')}`)).filter(Boolean).join(' · ')
    : '';
  const body = pages[pi].parts.map((x) => x.text).join('\n\n');
  return { ids, pages: pages.length, text: `${head}\n\n${body}\n_Prices in ${cur}._${more}\n\n${how}` };
}

/* ---------------------------------------------------------------- the cart */

export function waUnit(line) {
  const ups = (line.options || []).reduce((s, o) => s + (Number(o.up) || 0), 0);
  const adds = (line.addons || []).reduce((s, a) => s + (Number(a.price) || 0), 0);
  return (Number(line.price) || 0) + ups + adds;
}
export function waCartTotal(cart) { return (cart || []).reduce((s, l) => s + waUnit(l) * (Number(l.qty) || 1), 0); }
function waLineText(l) {
  const extra = [...(l.options || []).map((o) => o.label), ...(l.addons || []).map((a) => '+' + a.name)].join(', ');
  return `${l.qty}× ${waClip(l.name, 40)}${extra ? ' (' + waClip(extra, 60) + ')' : ''} · ${waM2(waUnit(l) * l.qty)}`;
}
function waCartText(cart) { return cart.map(waLineText).join('\n'); }

function waAddLine(cart, p, qty, options, addons) {
  const key = JSON.stringify([String(p.id), (options || []).map((o) => o.label), (addons || []).map((a) => a.name)]);
  const same = cart.find((l) => l.key === key);
  if (same) { same.qty = Math.min(99, same.qty + qty); return true; }
  if (cart.length >= WA_CART_MAX) return false;
  cart.push({ key, id: String(p.id), name: String(p.name || 'item').slice(0, 80), price: Number(p.price) || 0,
    qty, options: options || [], addons: addons || [] });
  return true;
}

/* ---------------------------------------------------------- the order slip */

function waTalkLink(st, sess) {
  const n = waDigits(st.whatsapp);
  if (!n) return '';
  const about = sess.last && sess.last.handle === st.handle && sess.last.code ? ` about order ${sess.last.code}` : '';
  return `https://wa.me/${n}?text=${encodeURIComponent('Hi' + about)}`;
}

/** Reply 2 of 2: everything the buyer needs until the food is in their hands. */
function waOrderReply(st, sess, cart, notes, r, service, address) {
  const cur = st.currency || 'USD';
  const pay = r.pay || {};
  const code = (r.order && r.order.code) || '';
  const cod = r.order && r.order.status === 'cod';
  const steps = Array.isArray(pay.steps) ? pay.steps : [];
  const lines = [`✅ *Order ${code} is in* · ${waClip(st.shop_name || st.handle, 40)}`, waCartText(cart)];
  lines.push(service === 'delivery' ? `Deliver to: ${waClip(address, 120)}` : 'Pickup (you collect)');
  lines.push(`Name: ${waClip(sess.name, 40)}`);
  if ((r.pricing || {}).delivery) lines.push(`Delivery ${waM2(r.pricing.delivery)}`);
  lines.push(`*Total: ${waM2((r.pricing || {}).pay_now)} ${pay.currency || cur}*`);
  if (notes && notes.length) lines.push('_Note: ' + notes.slice(0, 5).join('; ') + '. Wrong? Tell the shop (link below)._');
  if (pay.hours_note) lines.push(`_${pay.hours_note}: the shop will see it when they open._`);
  if (cod) lines.push('', 'Nothing to pay now: pay when you collect, or pay the runner.');
  else {
    lines.push('', '*How to pay*');
    steps.slice(0, 7).forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    if (pay.note) lines.push(`_${pay.note}_`);
    lines.push('', '*Then paste the payment SMS here.* The whole message is fine; I find the code in it. '
      + 'I react ✅ when the code is on your order, without writing again, to keep this chat light. '
      + '❓ means I found no code: type just the code.');
  }
  const talk = waTalkLink(st, sess);
  if (talk) lines.push('', `_Optional: to send a screenshot or ask the shop anything, message them: ${talk}_`);
  lines.push('_status_ · _menu_ to order again');
  return lines.join('\n');
}

const WA_STATUS_WORDS = {
  awaiting_payment: 'waiting for your payment',
  paid: 'paid ✅ (the shop has it)',
  cod: 'placed (pay on delivery or at pickup)',
  cancelled: 'cancelled',
};

/* ------------------------------------------------------------------ admin */

const WA_ADMIN_HELP = '*Shop commands* (only from your shop’s number)\n'
  + '*shop orders* · today’s orders\n*shop paid CODE* · mark an order paid\n*shop cancel CODE* · cancel one\n'
  + '*shop close* / *shop open* · stop or start taking orders';

async function waAdminStep(st, sess, cmd, deps) {
  const [verb, arg] = cmd.split(/\s+/, 2);
  if (verb === 'orders') {
    const rows = await deps.adminOrders(st);
    if (!rows.length) return 'No orders yet today.';
    const cur = st.currency || 'USD';
    return `*Today at ${waClip(st.shop_name || st.handle, 40)}* (${rows.length})\n`
      + rows.slice(0, 25).map((r) => `${r.code} · ${waM2(r.total)} ${cur} · ${String(r.status || '').replace(/_/g, ' ')}${r.name ? ' · ' + waClip(r.name, 20) : ''}`).join('\n')
      + (rows.length > 25 ? `\n…and ${rows.length - 25} more in your dashboard.` : '')
      + '\n\nReply *shop paid CODE* when money lands.';
  }
  if (verb === 'paid' || verb === 'cancel') {
    if (!arg) return `Which order? Send *shop ${verb} CODE*, e.g. shop ${verb} ${(st.order_prefix || 'ABC').toUpperCase()}-0012.`;
    const r = await deps.adminMark(st, arg.toUpperCase(), verb === 'paid' ? 'paid' : 'cancelled');
    if (!r || !r.ok) return `Not changed: ${(r && r.error) || 'no such order'}.`;
    return r.already ? `${r.code || arg.toUpperCase()} was already ${r.status}.` : `${r.code} → ${r.status}. (Undo in your dashboard within 15 minutes.)`;
  }
  if (verb === 'close' || verb === 'open') {
    const ok = await deps.setClosed(st, verb === 'close');
    return ok ? (verb === 'close' ? 'Closed. Buyers are told you are closed (they can still leave an order).' : 'Open. Buyers see you as open.')
      : 'Could not save that just now; try again in a minute or use the dashboard.';
  }
  return WA_ADMIN_HELP;
}

/* ------------------------------------------------------------------- step */

const WA_GREET = /^(hi+|hey|hello|helo|hie|hy|mhoro|mhoroi|makadini|sawubona|salibonani|good\s*(morning|afternoon|evening)|start|order|shop)\b[!. ]*$/i;
const WA_THANKS = /^(thanks?|thank\s*you|thx|ok(ay)?|sure|cool|great|tatenda|ndatenda|ngiyabonga|siyabonga|👍|🙏)[!. ]*$/i;
export const WA_MENU_FRESH_MS = 6 * 3600e3;      // a greeting soon after the menu gets 👋, not the menu again
export const WA_BUYER_DAY_CAP = 8;              // replies to one buyer per day beyond which only reactions go

/**
 * One inbound message in; at most one reply and/or one reaction out.
 *
 * `msg`  — one element of `waInbound`, plus `line` (a handle when this business number belongs to
 *          one shop). Shop commands are decided by deps.isAdmin, never by the message.
 * `deps` — store(handle), menu(st), hours(st), order(st, body), proof(st, last, code),
 *          status(st, last), isAdmin(st, from), adminOrders(st), adminMark(st, code, status),
 *          setClosed(st, closed); optional dayCap. Each one is the platform's own code path.
 *
 * Returns { sess, replies:[text], react:'' }. A reaction costs nothing (Meta bills no reaction and
 * counts none against the free 1,000), so it is the bot's "got it"; a reply is written only where
 * words are needed. Replies other than the order slip and shop commands count toward a per-buyer
 * daily cap, so a confused or hostile chat cannot drain the shared month.
 */
export async function waStep(sessIn, msg, deps, now) {
  const t0 = Number(now) || Date.now();
  const sess = waSession(sessIn);
  const replies = [];
  let react = '';
  const day = new Date(t0 + 2 * 3600e3).toISOString().slice(0, 10);      // the stores' day (CAT)
  if (sess.day !== day) { sess.day = day; sess.day_n = 0; }
  const cap = Number(deps.dayCap) > 0 ? Number(deps.dayCap) : WA_BUYER_DAY_CAP;
  let capped = false;
  const say = (s, essential) => {
    if (!s) return;
    if (!essential && sess.day_n >= cap) { capped = true; react = react || '⏳'; return; }
    sess.day_n++;
    replies.push(waClip(s, WA_TEXT_MAX));
  };
  const done = (extra) => ({ sess, replies, react, ...(capped ? { capped: true } : {}), ...(extra || {}) });

  if (sess.seen.indexOf(msg.id) >= 0) return { sess, replies: [], react: '', duplicate: true };
  sess.seen = sess.seen.concat(msg.id).slice(-WA_SEEN_MAX);
  if (sess.at && t0 - sess.at > WA_IDLE_MS) { sess.cart = []; sess.notes = []; }
  sess.at = t0; sess.last_in = t0;
  if (!sess.name && msg.name) sess.name = String(msg.name).replace(/[*_~`]/g, '').trim().slice(0, 60);

  const raw = String(msg.text || '').trim();
  const low = raw.toLowerCase().replace(/\s+/g, ' ');

  // which shop: a business number that belongs to one shop always answers for it; on the shared
  // number the buyer names the shop with "#handle" (the install link types it for them)
  let st = null;
  const tag = (msg.line ? null : raw.match(/#([a-z0-9][a-z0-9-]{1,30})\b/i));
  const bareHandle = !msg.line && !tag && !sess.shop && WA_HANDLE_RE.test(low) && !/^\d/.test(low) && low.length > 2 ? low : '';
  const wantShop = msg.line || (tag ? tag[1].toLowerCase() : '') || bareHandle;
  const showMenu = async (page) => {
    const products = await deps.menu(st);
    const mv = waMenu(st, products, await deps.hours(st), page);
    sess.ids = mv.ids; sess.menu_at = t0;
    say(mv.text);
  };
  if (wantShop && wantShop !== sess.shop) {
    const cand = await deps.store(wantShop);
    if (!cand && !bareHandle) {
      say(`I could not find a shop called *#${wantShop}*. Check the code on the shop’s poster or status, and send it again.`);
      return done();
    }
    if (cand) {
      if (!msg.line && cand.wa_bot !== 'on') {
        say(`*${waClip(cand.shop_name || cand.handle, 50)}* has not switched on WhatsApp ordering yet.`
          + (waDigits(cand.whatsapp) ? `\nYou can message them here: https://wa.me/${waDigits(cand.whatsapp)}` : ''));
        return done();
      }
      sess.shop = cand.handle; sess.cart = []; sess.notes = []; sess.ids = []; sess.menu_at = 0;
      st = cand;
      if (tag) { await showMenu(1); return done(); }      // the install link's greeting: the menu
    }
  }
  if (!st && sess.shop) st = await deps.store(sess.shop);
  if (!st) {
    sess.shop = '';
    say('Welcome to Tapstall shops on WhatsApp 👋\nSend the code of the shop you want, like *#mamatoe*. You will find it on the shop’s poster, status or link.');
    return done();
  }
  if (!msg.line && st.wa_bot !== 'on') {
    sess.shop = '';
    say(`*${waClip(st.shop_name || st.handle, 50)}* has switched WhatsApp ordering off. Send another shop’s code, like *#shopname*.`);
    return done();
  }
  const cur = st.currency || 'USD';
  const last = sess.last && sess.last.handle === st.handle ? sess.last : null;

  // the shop's own number, with WhatsApp commands switched on in its dashboard (not capped: it is
  // the merchant working, and the merchant's own replies are few)
  if (/^shop\b/.test(low) && await deps.isAdmin(st, msg.from)) {
    say(await waAdminStep(st, sess, low.replace(/^shop\s*/, ''), deps), true);
    return done();
  }

  // a photo, voice note or sticker: the slip and the menu already said "typed text only"
  if (msg.type !== 'text' && msg.type !== 'interactive' && msg.type !== 'button') { react = '❓'; return done(); }

  if (tag) { await showMenu(1); return done(); }
  if (WA_GREET.test(low)) {
    if (sess.menu_at && t0 - sess.menu_at < WA_MENU_FRESH_MS) { react = '👋'; return done(); }
    await showMenu(1); return done();
  }
  const mp = low.match(/^(?:m|menu)(?:\s*(\d{1,2}))?$/);
  if (mp) { await showMenu(mp[1] ? Number(mp[1]) : 1); return done(); }
  if (low === 'h' || low === 'help' || low === '?') {
    const products = await deps.menu(st);
    say(waHowTo(st, products) + '\n\nTo shop somewhere else, send its code, like *#shopname*.');
    return done();
  }
  if (low === 't' || low === 'talk' || low === 'call' || low === 'chat') {
    const link = waTalkLink(st, sess);
    say(link ? `Message ${waClip(st.shop_name || st.handle, 50)} directly (opens a chat in WhatsApp; send screenshots there):\n${link}`
      : 'This shop has not listed a WhatsApp number. Your order and code are with them; they will be in touch.');
    return done();
  }
  if (low === 'x' || low === 'clear' || low === 'empty' || low === 'cancel') {
    sess.cart = []; sess.notes = []; react = '👍'; return done();
  }
  if (low === 'c' || low === 'cart') {
    if (!sess.cart.length) { say('Your cart is empty. Send item numbers from the menu (*menu* to see it again).'); return done(); }
    const n = sess.cart.reduce((s, l) => s + l.qty, 0);
    say(`🛒 *Your cart* (${n})\n${waCartText(sess.cart)}\n*Subtotal ${waM2(waCartTotal(sess.cart))} ${cur}*\n\n`
      + 'Send more numbers, or finish with _pickup_ or _deliver_ and your address. _x_ empties the cart.');
    return done();
  }
  if (low === 's' || low === 'status') {
    if (!last) { say('You have no order with this shop yet. Send *menu* to see it.'); return done(); }
    const o = await deps.status(st, last);
    if (!o) { say(`I cannot find order ${last.code} any more. Send *talk* to ask the shop.`); return done(); }
    const proof = o.buyer && o.buyer.proof ? `\nPayment code on file: ${o.buyer.proof}` : '';
    say(`Order *${o.code}*: ${WA_STATUS_WORDS[o.status] || o.status}.\nTotal ${waM2((o.pricing || {}).pay_now)} ${cur}${proof}`
      + (o.status === 'awaiting_payment' && !proof ? '\nPaid already? Paste the SMS here.' : ''));
    return done();
  }
  const nm = raw.match(/^(?:n|name)[\s:]+(.{2,60})$/i);
  if (nm) { sess.name = nm[1].replace(/[*_~`]/g, '').trim().slice(0, 60); react = '👍'; return done(); }
  if (WA_THANKS.test(low)) { react = '🙏'; return done(); }

  // "p CODE" is always a payment code; so is anything unparseable while an order waits for one
  const pm = raw.match(/^(?:p|paid|proof|code)[\s:]+(.+)$/i);
  const order = pm ? null : waParseOrder(raw);
  if (order && !order.bad) {
    if (!sess.ids.length) sess.ids = (await deps.menu(st)).map((p) => String(p.id));
    const products = await deps.menu(st);
    const cart = sess.cart.map((l) => Object.assign({}, l));
    const notes = (sess.notes || []).slice();
    for (const pk of order.items) {
      const r = waResolve(pk, sess.ids, products);
      if (r.err || !waAddLine(cart, r.p, r.qty, r.options, r.addons)) { react = '❓'; return done(); }
      for (const n of r.notes) if (notes.indexOf(n) < 0) notes.push(n);
    }
    if (!order.service) { sess.cart = cart; sess.notes = notes.slice(0, 8); react = '👍'; return done(); }
    if (!cart.length) { react = '❓'; return done(); }
    let address = '';
    if (order.service === 'delivery') {
      address = order.address.length >= 6 ? order.address : (sess.address || '');
      if (address.length < 6) { react = '❓'; return done(); }
    }
    const name = sess.name || ('WhatsApp ' + String(msg.from).slice(-4));
    const r = await deps.order(st, {
      handle: st.handle, service: order.service, when: 'asap',
      items: cart.map((l) => ({ id: l.id, name: l.name, price: l.price, qty: l.qty,
        options: (l.options || []).map((o) => ({ label: o.label })), addons: (l.addons || []).map((a) => ({ name: a.name })) })),
      buyer: { name, phone: msg.from, address, note: 'Ordered in WhatsApp' },
    });
    if (!r || !r.ok) {
      sess.cart = cart; sess.notes = notes;
      say(`Sorry, the order did not go through: ${waClip((r && r.error) || 'the shop could not be reached', 200)}\nYour cart is kept; send _pickup_ or _deliver ..._ again to retry, or *talk* to message the shop.`, true);
      return done();
    }
    if (address) sess.address = address;
    if (!sess.name) sess.name = name;
    sess.last = { handle: st.handle, id: r.order.id, code: r.order.code, cap: String(r.proof_url || '').replace(/^\/p\//, ''), at: t0 };
    say(waOrderReply(st, sess, cart, notes, r, order.service, address), true);
    sess.cart = []; sess.notes = [];
    return done({ placed: { handle: st.handle, id: r.order.id, code: r.order.code } });
  }
  if (order && order.bad) { react = '❓'; return done(); }

  // a pasted payment confirmation: filed silently, acknowledged with ✅
  if (last && (pm || last.status !== 'filed' || raw.length > 20)) {
    const code = waProofFrom(pm ? pm[1] : raw, last.code);
    if (!code) { react = '❓'; return done(); }
    const r = await deps.proof(st, last, code);
    if (r && r.ok) {
      if (r.proof_url) last.cap = String(r.proof_url).replace(/^\/p\//, '');
      last.status = 'filed';
      react = '✅';
      return done();
    }
    say(`That code was not added: ${waClip((r && r.error) || 'try again in a minute', 200)}`);
    return done();
  }
  react = '❓';
  return done();
}

/** The merchant's ping for an order that came in through the bot (only inside their 24h window). */
export function waMerchantNote(st, order) {
  const cur = (st && st.currency) || 'USD';
  const o = order || {};
  const items = (o.items || []).slice(0, 8).map((i) => `${i.qty || 1}× ${waClip(i.name, 40)}`).join(', ');
  return `🛎 *New WhatsApp order ${o.code || ''}*\n${waClip((o.buyer || {}).name || '', 40)} (+${waDigits((o.buyer || {}).phone)})\n${items}\n`
    + `Total ${waM2((o.pricing || {}).pay_now)} ${cur} · ${o.service === 'delivery' ? 'deliver to ' + waClip((o.buyer || {}).address || '', 80) : 'pickup'}\n`
    + `Reply *shop paid ${o.code || 'CODE'}* when the money lands.`;
}
