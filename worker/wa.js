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
 * so the conversation is written to need few of them: a whole menu is one message, several
 * items can be added in one ("3x2, 5"), and checkout asks one question, not four.
 */

export const WA_VERSION = 1;
export const WA_SEEN_MAX = 24;                 // message ids remembered for webhook-retry dedupe
export const WA_CART_MAX = 30;                 // lines in one cart (placeOrder takes 40)
export const WA_TEXT_MAX = 3900;               // WhatsApp's text body limit is 4,096
export const WA_MENU_INLINE_MAX = 3000;        // a longer menu is browsed by category
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
    step: p.step || 'menu',
    cart: Array.isArray(p.cart) ? p.cart : [],
    ids: Array.isArray(p.ids) ? p.ids : [],
    cats: Array.isArray(p.cats) ? p.cats : [],
    pending: p.pending || null,
    queue: Array.isArray(p.queue) ? p.queue : [],
    name: p.name || '',
    address: p.address || '',
    last: p.last || null,
    seen: Array.isArray(p.seen) ? p.seen : [],
    at: Number(p.at) || 0,
    last_in: Number(p.last_in) || 0,
  };
}

/* ------------------------------------------------------------------ inbound */

/**
 * Meta's webhook body, flattened to the messages a bot answers. Statuses (sent, delivered, read,
 * failed) are dropped: they are receipts about our own messages, and answering them would be a
 * loop that bills us. Every message type is kept so the bot can say "send text" to a sticker
 * rather than ignore a buyer who is trying.
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

/* ---------------------------------------------------------------- the menu */

function waCatsOf(products) {
  const cats = [];
  for (const p of products) { const c = String(p.cat || 'Menu').trim() || 'Menu'; if (cats.indexOf(c) < 0) cats.push(c); }
  return cats;
}
function waItemLine(n, p, cur) {
  const sold = p.available === false ? ' _(sold out)_' : '';
  const opt = (Array.isArray(p.opts) && p.opts.length) || (Array.isArray(p.addons) && p.addons.length) ? ' ▸' : '';
  return `*${n}.* ${waClip(p.name, 48)} — ${waM2(p.price)} ${cur}${opt}${sold}`;
}
const WA_FOOT = 'Send the *number* of what you want (e.g. *2*, or *2x3* for three).\n*C* cart & checkout · *S* my order · *T* talk to the shop · *H* help';

/** The menu as one message, or the category list when one message would be too long. */
export function waMenu(st, products, hours, catIndex) {
  const cur = (st && st.currency) || 'USD';
  const list = Array.isArray(products) ? products : [];
  const ids = list.map((p) => String(p.id));
  const head = `*${waClip((st && (st.shop_name || st.handle)) || 'Shop', 60)}*`
    + (hours && hours.known && hours.label ? `\n_${hours.label}${hours.open ? '' : ' — you can still order; they will reply when they open'}_` : '')
    + ((st && st.welcome_message) ? `\n${waClip(st.welcome_message, 220)}` : '');
  if (!list.length) {
    return { ids, cats: [], step: 'menu',
      text: `${head}\n\nThe menu is empty right now. Send *T* to message the shop directly.` };
  }
  const cats = waCatsOf(list);
  const block = (c) => {
    const rows = [];
    list.forEach((p, i) => { if ((String(p.cat || 'Menu').trim() || 'Menu') === c) rows.push(waItemLine(i + 1, p, cur)); });
    return (cats.length > 1 ? `_${waClip(c, 40)}_\n` : '') + rows.join('\n');
  };
  if (catIndex != null && cats[catIndex]) {
    return { ids, cats, step: 'menu', text: `${head}\n\n${block(cats[catIndex])}\n\n${WA_FOOT}\n*M* back to the sections` };
  }
  const full = `${head}\n\n${cats.map(block).join('\n\n')}\n\n${WA_FOOT}`;
  if (full.length <= WA_MENU_INLINE_MAX) return { ids, cats, step: 'menu', text: full };
  const counts = cats.map((c) => list.filter((p) => (String(p.cat || 'Menu').trim() || 'Menu') === c).length);
  return { ids, cats, step: 'cats',
    text: `${head}\n\nWhat are you looking for?\n${cats.map((c, i) => `*${i + 1}.* ${waClip(c, 40)} (${counts[i]})`).join('\n')}\n\nSend a section number.\n*C* cart & checkout · *S* my order · *T* talk to the shop` };
}

/* ---------------------------------------------------------------- the cart */

export function waUnit(line) {
  const ups = (line.options || []).reduce((s, o) => s + (Number(o.up) || 0), 0);
  const adds = (line.addons || []).reduce((s, a) => s + (Number(a.price) || 0), 0);
  return (Number(line.price) || 0) + ups + adds;
}
export function waCartTotal(cart) { return (cart || []).reduce((s, l) => s + waUnit(l) * (Number(l.qty) || 1), 0); }
function waLineText(l, cur) {
  const extra = [...(l.options || []).map((o) => o.label), ...(l.addons || []).map((a) => '+' + a.name)].join(', ');
  return `${l.qty}× ${waClip(l.name, 40)}${extra ? ' (' + waClip(extra, 60) + ')' : ''} — ${waM2(waUnit(l) * l.qty)} ${cur}`;
}
function waCartText(cart, cur) { return cart.map((l) => waLineText(l, cur)).join('\n'); }

/** "3", "3x2", "3 x 2, 5 7" → [{n:3,qty:2},{n:5,qty:1},{n:7,qty:1}]; anything else → null. */
export function waPicks(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!/^\d{1,3}(\s*[x×*]\s*\d{1,2})?(\s*[,;&\s]\s*\d{1,3}(\s*[x×*]\s*\d{1,2})?)*$/.test(t)) return null;
  const out = [];
  const re = /(\d{1,3})(?:\s*[x×*]\s*(\d{1,2}))?/g;
  let m;
  while ((m = re.exec(t))) out.push({ n: Number(m[1]), qty: Math.max(1, Math.min(99, Number(m[2] || 1))) });
  return out.length ? out.slice(0, 12) : null;
}

function waAddLine(sess, p, qty, options, addons) {
  const key = JSON.stringify([String(p.id), (options || []).map((o) => o.label), (addons || []).map((a) => a.name)]);
  const same = sess.cart.find((l) => l.key === key);
  if (same) { same.qty = Math.min(99, same.qty + qty); return true; }
  if (sess.cart.length >= WA_CART_MAX) return false;
  sess.cart.push({ key, id: String(p.id), name: String(p.name || 'item').slice(0, 80), price: Number(p.price) || 0,
    qty, options: options || [], addons: addons || [] });
  return true;
}

/** The question for the item at the head of the queue (an option group, then its add-ons). */
function waAskPending(sess, products, cur) {
  const pd = sess.pending;
  const p = products.find((x) => String(x.id) === pd.id);
  if (!p) { sess.pending = null; return null; }
  const groups = Array.isArray(p.opts) ? p.opts : [];
  if (pd.gi < groups.length) {
    const g = groups[pd.gi];
    sess.step = 'opt';
    return `*${waClip(p.name, 48)}* — choose ${waClip(String(g.name || 'one').toLowerCase(), 30)}:\n`
      + (g.choices || []).slice(0, 20).map((c, i) => `*${i + 1}.* ${waClip(c.label, 40)}${Number(c.up) ? ' (+' + waM2(c.up) + ' ' + cur + ')' : ''}`).join('\n')
      + '\n\nSend a number. *X* to skip this item.';
  }
  const adds = Array.isArray(p.addons) ? p.addons : [];
  if (!pd.asked && adds.length) {
    sess.step = 'addons';
    return `Anything extra with *${waClip(p.name, 48)}*?\n`
      + adds.slice(0, 20).map((a, i) => `*${i + 1}.* ${waClip(a.name, 40)}${Number(a.price) ? ' (+' + waM2(a.price) + ' ' + cur + ')' : ''}`).join('\n')
      + '\n\nSend the numbers (e.g. *1,3*), or *0* for none.';
  }
  return null;
}

/** Add what was picked; returns the reply. Items with choices are queued and asked one by one. */
function waAddPicks(sess, picks, products, cur) {
  const added = [], bad = [], sold = [];
  for (const pk of picks) {
    const id = sess.ids[pk.n - 1];
    const p = id != null ? products.find((x) => String(x.id) === String(id)) : null;
    if (!p) { bad.push(pk.n); continue; }
    if (p.available === false) { sold.push(p.name); continue; }
    const needs = (Array.isArray(p.opts) && p.opts.length) || (Array.isArray(p.addons) && p.addons.length);
    if (needs) sess.queue.push({ id: String(p.id), qty: pk.qty });
    else if (waAddLine(sess, p, pk.qty, [], [])) added.push(`${pk.qty}× ${waClip(p.name, 40)}`);
  }
  return waNextQueued(sess, products, cur, added, bad, sold);
}

function waNextQueued(sess, products, cur, added, bad, sold) {
  const notes = [];
  if (added && added.length) notes.push('Added ' + added.join(', ') + '.');
  if (sold && sold.length) notes.push('Sold out: ' + sold.map((s) => waClip(s, 30)).join(', ') + '.');
  if (bad && bad.length) notes.push(`There is no item ${bad.join(', ')} on this menu. Send *M* to see it again.`);
  while (sess.queue.length) {
    const q = sess.queue.shift();
    sess.pending = { id: q.id, qty: q.qty, gi: 0, options: [], asked: false };
    const ask = waAskPending(sess, products, cur);
    if (ask) return (notes.length ? notes.join(' ') + '\n\n' : '') + ask;
  }
  sess.pending = null;
  sess.step = 'menu';
  const n = sess.cart.reduce((s, l) => s + l.qty, 0);
  if (!n) return (notes.join(' ') || 'Your cart is empty.') + '\nSend a number from the menu, or *M* to see it.';
  return (notes.length ? notes.join(' ') + '\n' : '')
    + `🛒 ${n} item${n === 1 ? '' : 's'} · ${waM2(waCartTotal(sess.cart))} ${cur}\nSend more numbers, or *C* to check out.`;
}

/* --------------------------------------------------------------- checkout */

function waCheckoutText(st, sess) {
  const cur = st.currency || 'USD';
  const fee = Number(st.delivery_fee) || 0;
  const freeOver = Number(st.free_over) || 0;
  const feeTxt = fee ? ` (delivery ${waM2(fee)} ${cur}${freeOver ? ', free over ' + waM2(freeOver) : ''})` : '';
  return `*Your order — ${waClip(st.shop_name || st.handle, 50)}*\n${waCartText(sess.cart, cur)}\n*Subtotal ${waM2(waCartTotal(sess.cart))} ${cur}*\n`
    + `Name: ${sess.name || '—'}  _(send *N your name* to change)_\n\n`
    + `*1* — I'll collect it (pickup)\n*2* — deliver to me${feeTxt}`
    + (sess.address ? `\n*3* — deliver to: ${waClip(sess.address, 80)}` : '')
    + '\n\nOr just type your delivery address.\n*M* add more · *X* empty the cart';
}

function waOrderReply(st, sess, r) {
  const cur = st.currency || 'USD';
  const pay = r.pay || {};
  const code = (r.order && r.order.code) || '';
  const cod = r.order && r.order.status === 'cod';
  const steps = Array.isArray(pay.steps) ? pay.steps : [];
  const lines = [`✅ *Order ${code} is in.*`, waCartText(sess.cart, cur),
    `*Total: ${waM2((r.pricing || {}).pay_now)} ${pay.currency || cur}*`];
  if ((r.pricing || {}).delivery) lines.push(`(includes delivery ${waM2(r.pricing.delivery)})`);
  if (pay.hours_note) lines.push(`_${pay.hours_note}: the shop will see it when they open._`);
  if (cod) lines.push('', 'Nothing to pay now: pay when you collect, or pay the runner.');
  else {
    lines.push('', '*How to pay*');
    steps.slice(0, 7).forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    if (pay.note) lines.push(`_${pay.note}_`);
    lines.push('', 'After paying, *paste the confirmation SMS here* (or type the code) and I will put it on your order.');
  }
  lines.push('*S* order status · *T* talk to the shop · *M* order again');
  return lines.join('\n');
}

const WA_STATUS_WORDS = {
  awaiting_payment: 'waiting for your payment',
  paid: 'paid ✅ — the shop has it',
  cod: 'placed — pay on delivery or at pickup',
  cancelled: 'cancelled',
};

/* ------------------------------------------------------------------- talk */

function waTalkText(st, sess) {
  const n = waDigits(st.whatsapp);
  if (!n) return 'This shop has not listed a WhatsApp number. Your order and code are with them; they will be in touch.';
  const about = sess.last && sess.last.handle === st.handle && sess.last.code ? ` about order ${sess.last.code}` : '';
  return `Message ${waClip(st.shop_name || st.handle, 50)} directly${about}:\nhttps://wa.me/${n}?text=${encodeURIComponent('Hi' + about)}`
    + '\n(Opens a chat in WhatsApp. Send payment screenshots there too.)';
}

const WA_HELP = '*How this works*\nPick by number: *3* adds item 3, *3x2* adds two, *3, 5x2* adds both.\n'
  + '*M* menu · *C* cart & checkout · *X* empty cart\n*S* my last order · *T* talk to the shop\n*N your name* sets your name\nPaste your payment SMS after paying.\nTo shop somewhere else, send its code, like *#shopname*.';

/* ------------------------------------------------------------------ admin */

const WA_ADMIN_HELP = '*Shop commands* (only from your shop’s number)\n'
  + '*shop orders* — today’s orders\n*shop paid CODE* — mark an order paid\n*shop cancel CODE* — cancel one\n'
  + '*shop close* / *shop open* — stop or start taking orders';

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

/**
 * One inbound message in, the replies out.
 *
 * `msg`  — one element of `waInbound`, plus `line` (a handle when this business number belongs to
 *          one shop) and `admin_ok` is decided by deps.isAdmin, never by the message.
 * `deps` — store(handle), menu(st), hours(st), order(st, body), proof(st, last, code),
 *          status(st, last), isAdmin(st, from), adminOrders(st), adminMark(st, code, status),
 *          setClosed(st, closed). All async; each one is the platform's own code path.
 */
export async function waStep(sessIn, msg, deps, now) {
  const t0 = Number(now) || Date.now();
  const sess = waSession(sessIn);
  const replies = [];
  const say = (s) => { if (s) replies.push(waClip(s, WA_TEXT_MAX)); };
  const done = (extra) => ({ sess, replies, ...(extra || {}) });

  if (sess.seen.indexOf(msg.id) >= 0) return { sess, replies: [], duplicate: true };
  sess.seen = sess.seen.concat(msg.id).slice(-WA_SEEN_MAX);
  if (sess.at && t0 - sess.at > WA_IDLE_MS) { sess.cart = []; sess.step = 'menu'; sess.pending = null; sess.queue = []; }
  sess.at = t0; sess.last_in = t0;
  if (!sess.name && msg.name) sess.name = String(msg.name).slice(0, 60);

  const raw = String(msg.text || '').trim();
  const low = raw.toLowerCase().replace(/\s+/g, ' ');

  // which shop: a business number that belongs to one shop always answers for it; on the shared
  // number the buyer names the shop with "#handle" (the install link types it for them)
  let st = null;
  const tag = (msg.line ? null : raw.match(/#([a-z0-9][a-z0-9-]{1,30})\b/i));
  const bareHandle = !msg.line && !tag && !sess.shop && WA_HANDLE_RE.test(low) && !waPicks(low) && low.length > 2 ? low : '';
  const wantShop = msg.line || (tag ? tag[1].toLowerCase() : '') || bareHandle;
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
      sess.shop = cand.handle; sess.cart = []; sess.pending = null; sess.queue = []; sess.step = 'menu'; sess.ids = []; sess.cats = [];
      st = cand;
      if (tag) {   // "#shop" alone, or the install link's greeting: show the menu
        const products = await deps.menu(st);
        const mv = waMenu(st, products, await deps.hours(st));
        sess.ids = mv.ids; sess.cats = mv.cats; sess.step = mv.step;
        say(mv.text);
        return done();
      }
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

  // the shop's own number, with WhatsApp commands switched on in its dashboard
  if (/^shop\b/.test(low) && await deps.isAdmin(st, msg.from)) {
    say(await waAdminStep(st, sess, low.replace(/^shop\s*/, ''), deps));
    return done();
  }

  if (msg.type !== 'text' && msg.type !== 'interactive' && msg.type !== 'button') {
    if (msg.type === 'image' || msg.type === 'document') {
      say(sess.last && sess.last.handle === st.handle
        ? 'Thanks. I can only read text, so please *paste the SMS* or *type the code* from it here.\nTo send the screenshot itself to the shop: send *T*.'
        : 'I can only read text messages. Send *M* for the menu.');
    } else say('I can only read text messages. Send *M* for the menu or *H* for help.');
    return done();
  }

  const showMenu = async (catIndex) => {
    const products = await deps.menu(st);
    const mv = waMenu(st, products, await deps.hours(st), catIndex);
    sess.ids = mv.ids; sess.cats = mv.cats; sess.step = mv.step; sess.pending = null; sess.queue = [];
    say(mv.text);
  };

  // the install link's greeting (or "#shop" again) for the shop already open: the menu
  if (tag) { await showMenu(null); return done(); }

  // words that mean the same thing at every step
  if (low === 'm' || low === 'menu' || WA_GREET.test(low) || (low === '0' && sess.step !== 'addons')) { await showMenu(null); return done(); }
  if (low === 'h' || low === 'help' || low === '?') { say(WA_HELP); return done(); }
  if (low === 't' || low === 'talk' || low === 'call' || low === 'chat') { say(waTalkText(st, sess)); return done(); }
  if (low === 'x' || low === 'clear' || low === 'cancel') {
    if (sess.step === 'opt' || sess.step === 'addons') {
      sess.pending = null;
      const products = await deps.menu(st);
      say('Skipped.\n' + waNextQueued(sess, products, cur));
      return done();
    }
    sess.cart = []; sess.queue = []; sess.pending = null; sess.step = 'menu';
    say('Cart emptied. Send *M* for the menu.');
    return done();
  }
  if (low === 's' || low === 'status') {
    const last = sess.last && sess.last.handle === st.handle ? sess.last : null;
    if (!last) { say('You have no order with this shop yet. Send *M* for the menu.'); return done(); }
    const o = await deps.status(st, last);
    if (!o) { say(`I cannot find order ${last.code} any more. Send *T* to ask the shop.`); return done(); }
    const proof = o.buyer && o.buyer.proof ? `\nPayment code on file: ${o.buyer.proof}` : '';
    say(`Order *${o.code}*: ${WA_STATUS_WORDS[o.status] || o.status}.\nTotal ${waM2((o.pricing || {}).pay_now)} ${cur}${proof}`
      + (o.status === 'awaiting_payment' && !proof ? '\nPaid already? Paste the SMS here.' : ''));
    return done();
  }
  if (low === 'c' || low === 'cart' || low === 'checkout' || low === 'check out') {
    if (!sess.cart.length) { say('Your cart is empty. Send *M* for the menu.'); return done(); }
    if (!sess.name) { sess.step = 'name'; say('What name should the order be under?'); return done(); }
    sess.step = 'checkout';
    say(waCheckoutText(st, sess));
    return done();
  }
  const nm = raw.match(/^(?:n|name)[\s:]+(.{2,60})$/i);
  if (nm) {
    sess.name = nm[1].replace(/[*_~`]/g, '').trim().slice(0, 60);
    if (sess.step === 'checkout' || sess.step === 'name') { sess.step = 'checkout'; say(`Thanks, ${sess.name}.\n\n` + waCheckoutText(st, sess)); }
    else say(`Thanks, ${sess.name}. Orders will be under this name.`);
    return done();
  }

  // the step's own question
  if (sess.step === 'name') {
    const name = raw.replace(/[*_~`]/g, '').trim().slice(0, 60);
    if (name.length < 2) { say('Please send your name (at least two letters).'); return done(); }
    sess.name = name; sess.step = 'checkout';
    say(waCheckoutText(st, sess));
    return done();
  }

  if (sess.step === 'opt' || sess.step === 'addons') {
    const products = await deps.menu(st);
    const pd = sess.pending;
    const p = pd ? products.find((x) => String(x.id) === pd.id) : null;
    if (!p) { sess.pending = null; say(waNextQueued(sess, products, cur)); return done(); }
    if (sess.step === 'opt') {
      const g = (p.opts || [])[pd.gi] || { choices: [] };
      const n = Number(low);
      const ch = Number.isInteger(n) && n >= 1 ? (g.choices || [])[n - 1] : null;
      if (!ch) { say(`Send a number from 1 to ${(g.choices || []).length}, or *X* to skip this item.`); return done(); }
      pd.options.push({ label: ch.label, up: Number(ch.up) || 0 });
      pd.gi++;
    } else {
      const adds = p.addons || [];
      const nums = low === '0' || low === 'no' || low === 'none' ? [] : (low.match(/\d{1,2}/g) || []).map(Number);
      if (low !== '0' && low !== 'no' && low !== 'none' && (!nums.length || nums.some((n) => n < 1 || n > adds.length))) {
        say(`Send the extras’ numbers (1 to ${adds.length}), like *1,2*, or *0* for none.`); return done();
      }
      pd.addons = [...new Set(nums)].map((n) => ({ name: adds[n - 1].name, price: Number(adds[n - 1].price) || 0 }));
      pd.asked = true;
    }
    const ask = waAskPending(sess, products, cur);
    if (ask) { say(ask); return done(); }
    const ok = waAddLine(sess, p, pd.qty, pd.options, pd.addons || []);
    sess.pending = null;
    say(waNextQueued(sess, products, cur, ok ? [`${pd.qty}× ${waClip(p.name, 40)}`] : [], [], []));
    return done();
  }

  if (sess.step === 'cats') {
    const n = Number(low);
    if (Number.isInteger(n) && n >= 1 && n <= sess.cats.length) { await showMenu(n - 1); return done(); }
    // item numbers mean nothing on this screen: the buyer has not seen any yet
    say(`Send a section number from 1 to ${sess.cats.length}, or *H* for help.`); return done();
  }

  if (sess.step === 'checkout' || sess.step === 'address') {
    let service = '', address = '';
    if (sess.step === 'checkout' && low === '1') service = 'pickup';
    else if (sess.step === 'checkout' && low === '2') { sess.step = 'address'; say('Send your delivery address (area, street and house number, and a landmark).'); return done(); }
    else if (sess.step === 'checkout' && low === '3' && sess.address) { service = 'delivery'; address = sess.address; }
    else if (raw.length >= 6 && !waPicks(low)) { service = 'delivery'; address = raw.replace(/[*_~`]/g, '').trim().slice(0, 200); }
    else { say(sess.step === 'address' ? 'That address looks too short. Send the area, street and a landmark.' : 'Send *1* for pickup, *2* for delivery, or type your address.'); return done(); }
    if (address) sess.address = address;
    const r = await deps.order(st, {
      handle: st.handle, service, when: 'asap',
      items: sess.cart.map((l) => ({ id: l.id, name: l.name, price: l.price, qty: l.qty,
        options: (l.options || []).map((o) => ({ label: o.label })), addons: (l.addons || []).map((a) => ({ name: a.name })) })),
      buyer: { name: sess.name, phone: msg.from, address, note: 'Ordered in WhatsApp' },
    });
    if (!r || !r.ok) {
      sess.step = 'checkout';
      say(`Sorry, the order did not go through: ${waClip((r && r.error) || 'the shop could not be reached', 200)}\nYour cart is kept. Send *C* to try again, or *T* to message the shop.`);
      return done();
    }
    say(waOrderReply(st, sess, r));
    const cod = r.order && r.order.status === 'cod';
    sess.last = { handle: st.handle, id: r.order.id, code: r.order.code, cap: String(r.proof_url || '').replace(/^\/p\//, ''), at: t0 };
    sess.cart = []; sess.pending = null; sess.queue = [];
    sess.step = cod ? 'menu' : 'paid';
    return done({ placed: { handle: st.handle, id: r.order.id, code: r.order.code } });
  }

  const picks = waPicks(low);
  if (picks) {
    if (!sess.ids.length) {
      const products = await deps.menu(st);
      const mv = waMenu(st, products, await deps.hours(st));
      sess.ids = mv.ids; sess.cats = mv.cats;
    }
    const products = await deps.menu(st);
    say(waAddPicks(sess, picks, products, cur));
    return done();
  }

  // a pasted payment confirmation, or "p CODE"
  const last = sess.last && sess.last.handle === st.handle ? sess.last : null;
  const pm = raw.match(/^(?:p|paid|proof|code)[\s:]+(.+)$/i);
  if (last && (pm || sess.step === 'paid')) {
    const code = waProofFrom(pm ? pm[1] : raw, last.code);
    if (!code) {
      say(pm || raw.length > 20 ? 'I could not find a payment code in that. Type just the code from the SMS (letters and numbers).'
        : 'Send *M* for the menu, *S* for your order, or paste your payment SMS.');
      return done();
    }
    const r = await deps.proof(st, last, code);
    if (r && r.ok) {
      if (r.proof_url) last.cap = String(r.proof_url).replace(/^\/p\//, '');
      sess.step = 'menu';
      say(`Got it: code *${r.proof || code}* is on order ${last.code}. The shop will confirm it.`
        + (r.left > 0 ? ` If it is wrong, send *p* and the right code (${r.left} change${r.left === 1 ? '' : 's'} left).` : ''));
    } else say(`That code was not added: ${waClip((r && r.error) || 'try again in a minute', 200)}`);
    return done();
  }

  say('Sorry, I did not get that.\nSend a *number* from the menu, *M* for the menu, *C* to check out, or *H* for help.');
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
