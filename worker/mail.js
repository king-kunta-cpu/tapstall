/* Tapstall mail over inbox.lv (v2.0.0, 2026-10-28), ported from STPi edge/src/mail.js
 * (itself AttestOS worker/src/mail/*). One free inbox.lv box carries both halves:
 *   - the merchant's own mail: the welcome + email-confirm link, the PIN-reset link, the
 *     "your PIN was reset" and "a money setting changed" alerts, renewal notices, new-order
 *     alerts (opt-in), crypto reports, Whop payment claims;
 *   - cold first touches to merchants (the cron's outreach tick, a few an hour at most).
 *
 * Config  MAILBOXES = '[{"id":"lv1","host":"mail.inbox.lv","fromName":"Tapstall","hourly":2}]'  (var)
 *         MAILBOX_<ID>_USER / MAILBOX_<ID>_PASS  (secrets; an inbox.lv app password)
 * Nothing armed = every caller gets {sent:false, why:'no_lane'} and carries on (never a 500).
 *
 * Budget: inbox.lv allows 15 messages/hour per box and this box is shared with other products,
 * so `hourly` is small. Transactional mail always goes first; outreach only spends what is left
 * after one slot per hour is held back for a merchant who is waiting for a link.
 * KV: one write per sent message (the lane's hour counter), one per queued retry. No outbox for
 * outreach — a skipped first touch is simply picked up by the next tick.
 *
 * Workers' connect() blocks port 25 only; SMTPS 465 works. `cloudflare:sockets` is imported
 * lazily so the bundle still loads in Node for the test suites (they pass env.MAIL_TEST_OPEN).
 * No classes on purpose: build_bundle.sh inlines this file and strips `export` from
 * const/function declarations only.
 */

const MAIL_ENC = new TextEncoder();
const MAIL_DEC = new TextDecoder();
const mailB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const mailB64s = (s) => mailB64(MAIL_ENC.encode(s));

function mailErr(stage, code, msg) {
  const e = new Error(`${stage}${code ? ' ' + code : ''}: ${String(msg || '').slice(0, 200)}`);
  e.stage = stage; e.code = code || 0;
  e.permanent = code >= 500 && code < 600 && (stage === 'rcpt' || stage === 'body' || stage === 'mail');
  e.authFail = stage === 'auth' && (code === 535 || code === 534 || code === 530);
  return e;
}

/* ------------------------------------------------------------------ wire */
export function mailConn(readable, writable, timeoutMs) {
  const reader = readable.getReader();
  const writer = writable.getWriter();
  let buf = '';
  const t = timeoutMs || 15000;
  const withTimeout = (p, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(mailErr('timeout', 0, what)), t))]);
  return {
    async line() {
      for (;;) {
        const i = buf.indexOf('\r\n');
        if (i >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); return l; }
        const { value, done } = await withTimeout(reader.read(), 'read');
        if (done) throw mailErr('connection', 0, 'closed by server');
        buf += MAIL_DEC.decode(value, { stream: true });
      }
    },
    async write(s) { await withTimeout(writer.write(MAIL_ENC.encode(s)), 'write'); },
    async close() { try { await writer.close(); } catch (e) { void e; } try { reader.releaseLock(); } catch (e) { void e; } },
  };
}

async function mailOpenTls(host, port, timeoutMs) {
  const mod = await import('cloudflare:sockets');
  const sock = mod.connect({ hostname: host, port }, { secureTransport: 'on', allowHalfOpen: false });
  const c = mailConn(sock.readable, sock.writable, timeoutMs);
  const close0 = c.close;
  c.close = async () => { await close0(); try { await sock.close(); } catch (e) { void e; } };
  return c;
}

export async function mailReadReply(c) {
  const lines = [];
  for (;;) {
    const l = await c.line();
    lines.push(l);
    if (!/^\d{3}-/.test(l)) break;
    if (lines.length > 100) throw mailErr('protocol', 0, 'reply too long');
  }
  const code = parseInt(lines[lines.length - 1].slice(0, 3), 10) || 0;
  return { code, lines: lines.map((l) => l.slice(4)) };
}

/** Open, greet, authenticate. Returns a session { send(from,to,mime), quit() }. */
export async function smtpSession(c, o) {
  const g = await mailReadReply(c);
  if (g.code !== 220) throw mailErr('greeting', g.code, g.lines.join(' '));
  await c.write(`EHLO ${o.helo || 'tapstall.local'}\r\n`);
  const e = await mailReadReply(c);
  if (e.code !== 250) throw mailErr('ehlo', e.code, e.lines.join(' '));
  const caps = e.lines.slice(1).map((l) => l.toUpperCase());
  const auth = caps.find((l) => l.startsWith('AUTH')) || 'AUTH PLAIN LOGIN';
  let r;
  if (/\bPLAIN\b/.test(auth)) {
    await c.write(`AUTH PLAIN ${mailB64s(`\0${o.user}\0${o.pass}`)}\r\n`);
    r = await mailReadReply(c);
  } else {
    await c.write('AUTH LOGIN\r\n'); r = await mailReadReply(c);
    if (r.code === 334) { await c.write(`${mailB64s(o.user)}\r\n`); r = await mailReadReply(c); }
    if (r.code === 334) { await c.write(`${mailB64s(o.pass)}\r\n`); r = await mailReadReply(c); }
  }
  if (r.code !== 235) throw mailErr('auth', r.code, r.lines.join(' '));
  const step = async (cmd, stage, ok) => {
    await c.write(cmd);
    const rr = await mailReadReply(c);
    if (!ok.includes(rr.code)) {
      try { await c.write('RSET\r\n'); await mailReadReply(c); } catch (er) { void er; }
      throw mailErr(stage, rr.code, rr.lines.join(' '));
    }
    return rr;
  };
  return {
    async send(from, to, mime) {
      await step(`MAIL FROM:<${from}>${caps.some((x) => x.startsWith('8BITMIME')) ? ' BODY=8BITMIME' : ''}\r\n`, 'mail', [250]);
      await step(`RCPT TO:<${to}>\r\n`, 'rcpt', [250, 251]);
      await step('DATA\r\n', 'data', [354]);
      const body = mime.replace(/\r?\n/g, '\r\n').split('\r\n').map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n').replace(/(\r\n)*$/, '');
      const rr = await step(`${body}\r\n.\r\n`, 'body', [250]);
      return rr.lines.join(' ').slice(0, 200);
    },
    async quit() { try { await c.write('QUIT\r\n'); await mailReadReply(c); } catch (er) { void er; } await c.close(); },
  };
}

/* ------------------------------------------------------------------ mime */
const mailClean = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();   // header-injection guard
export function mailHeaderWord(v) {
  const c = mailClean(v);
  if (/^[\x20-\x7e]*$/.test(c)) return c;
  const words = []; let chunk = [];
  for (const ch of c) {
    const bytes = MAIL_ENC.encode(ch);
    if (chunk.length + bytes.length > 45) { words.push(`=?UTF-8?B?${mailB64(new Uint8Array(chunk))}?=`); chunk = []; }
    chunk.push(...bytes);
  }
  if (chunk.length) words.push(`=?UTF-8?B?${mailB64(new Uint8Array(chunk))}?=`);
  return words.join('\r\n ');
}
export function mailAddress(email, name) {
  const e = mailClean(email);
  if (!/^[^@\s<>"]+@[^@\s<>"]+$/.test(e)) throw new Error('Invalid email: ' + e);
  const n = mailClean(name || '').replace(/["\\]/g, '').trim();
  if (!n) return e;
  const display = /^[\x20-\x7e]*$/.test(n) ? (/[()<>[\]:;@,.]/.test(n) ? `"${n}"` : n) : mailHeaderWord(n);
  return `${display} <${e}>`;
}
/** m: { from, fromName, to, subject, text, replyTo?, messageId?, unsubscribe?: {mailto, url}, auto? } */
export function buildMail(m) {
  const h = [
    `From: ${mailAddress(m.from, m.fromName)}`,
    `To: ${mailAddress(m.to)}`,
    `Subject: ${mailHeaderWord(m.subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    'MIME-Version: 1.0',
  ];
  if (m.messageId) h.push(`Message-ID: ${mailClean(m.messageId)}`);
  if (m.replyTo) h.push(`Reply-To: ${mailAddress(m.replyTo)}`);
  if (m.unsubscribe && (m.unsubscribe.url || m.unsubscribe.mailto)) {
    const parts = [];
    if (m.unsubscribe.mailto) parts.push(`<mailto:${mailClean(m.unsubscribe.mailto)}?subject=unsubscribe>`);
    if (m.unsubscribe.url) parts.push(`<${mailClean(m.unsubscribe.url)}>`);
    h.push(`List-Unsubscribe: ${parts.join(', ')}`);
    if (m.unsubscribe.url) h.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');   // RFC 8058
  }
  if (m.auto) h.push('Auto-Submitted: auto-generated');
  h.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64');
  const body = mailB64(MAIL_ENC.encode(String(m.text || ''))).replace(/.{1,76}/g, '$&\r\n').trimEnd();
  return `${h.join('\r\n')}\r\n\r\n${body}\r\n`;
}

/* ------------------------------------------------------------------ lanes */
export function mailLanes(env) {
  let cfg = [];
  try { cfg = JSON.parse(String((env && env.MAILBOXES) || '[]')); } catch (e) { return []; }
  if (!Array.isArray(cfg)) return [];
  const out = [];
  for (const c of cfg) {
    const id = String((c && c.id) || '').toLowerCase();
    if (!/^[a-z0-9]{1,12}$/.test(id)) continue;
    const user = String(env['MAILBOX_' + id.toUpperCase() + '_USER'] || '').trim();
    const pass = String(env['MAILBOX_' + id.toUpperCase() + '_PASS'] || '').trim();
    if (!user.includes('@') || !pass) continue;
    out.push({ id, user, pass, host: String(c.host || 'mail.inbox.lv'), port: Number(c.smtpPort) || 465,
      fromName: String(c.fromName || 'Tapstall'), hourly: Math.max(1, Math.min(15, Number(c.hourly) || 2)),
      outreach: c.outreach !== false });
  }
  return out;
}
export const mailArmed = (env) => mailLanes(env).length > 0;

const mailHourKey = (id, now) => 'mail:h:' + id + ':' + new Date(now).toISOString().slice(0, 13);
const mailMem = new Map();   // isolate cache of hour counters: a read saved, never a write
async function laneUsedThisHour(env, id, now) {
  const k = mailHourKey(id, now);
  if (mailMem.has(k)) return mailMem.get(k);
  let n = 0;
  try { n = Number(await env.STORES.get(k)) || 0; } catch (e) { void e; }
  mailMem.set(k, n);
  return n;
}
async function laneBump(env, id, now) {
  const k = mailHourKey(id, now);
  const n = (await laneUsedThisHour(env, id, now)) + 1;
  mailMem.set(k, n);
  try { await env.STORES.put(k, String(n), { expirationTtl: 7200 }); } catch (e) { void e; }
  return n;
}
async function laneState(env, id) {
  try { return (await env.STORES.get('mail:lane:' + id, 'json')) || { status: 'active' }; } catch (e) { return { status: 'active' }; }
}
async function laneSetState(env, id, st) {
  try { await env.STORES.put('mail:lane:' + id, JSON.stringify(st)); } catch (e) { void e; }
}

/** Which lane may send a message of this kind right now. Outreach leaves one slot an hour free. */
async function pickLane(env, kind, now) {
  for (const l of mailLanes(env)) {
    if (kind === 'outreach' && !l.outreach) continue;
    const st = await laneState(env, l.id);
    if (st.status === 'paused') continue;
    if (st.cooldown_until && Date.parse(st.cooldown_until) > now) continue;
    const used = await laneUsedThisHour(env, l.id, now);
    const cap = kind === 'outreach' ? l.hourly - 1 : l.hourly;
    if (used < cap) return l;
  }
  return null;
}

/** Is there a lane with room for this kind of message right now? (no write) */
export async function mailRoom(env, kind) { return !!(await pickLane(env, kind === 'outreach' ? 'outreach' : 'transactional', Date.now())); }

/** Send one message on the first lane with room. Never throws.
 *  msg: { to, subject, text, kind, replyTo?, unsubscribe? }  kind: 'transactional' (default) | 'outreach'
 *  -> { sent, lane?, why?, permanent? } */
export async function mailSend(env, msg, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const kind = msg.kind === 'outreach' ? 'outreach' : 'transactional';
  const to = String(msg.to || '').trim().toLowerCase();
  if (!/^[^@\s<>"]+@[^@\s<>"]+\.[a-z]{2,}$/i.test(to)) return { sent: false, why: 'bad_address', permanent: true };
  if (!mailArmed(env)) return { sent: false, why: 'no_lane' };
  const lane = await pickLane(env, kind, now);
  if (!lane) return { sent: false, why: 'lanes_full' };
  const mime = buildMail({ from: lane.user, fromName: lane.fromName, to, subject: msg.subject, text: msg.text,
    replyTo: msg.replyTo || lane.user, unsubscribe: msg.unsubscribe, auto: kind === 'transactional',
    messageId: `<${now.toString(36)}.${Math.random().toString(36).slice(2, 10)}@tapstall.mail>` });
  let s = null;
  try {
    const open = env.MAIL_TEST_OPEN || (async (l) => smtpSession(await mailOpenTls(l.host, l.port, 15000), { user: l.user, pass: l.pass }));
    s = await open(lane);
    await s.send(lane.user, to, mime);
    await laneBump(env, lane.id, now);
    return { sent: true, lane: lane.id };
  } catch (e) {
    if (e && e.authFail) await laneSetState(env, lane.id, { status: 'paused', why: String(e.message).slice(0, 160), at: new Date(now).toISOString() });
    else if (e && !e.permanent) await laneSetState(env, lane.id, { status: 'active', cooldown_until: new Date(now + 10 * 60e3).toISOString(), why: String(e && e.message || e).slice(0, 160) });
    return { sent: false, why: String(e && e.message || e).slice(0, 160), permanent: !!(e && e.permanent) };
  } finally {
    if (s) { try { await s.quit(); } catch (e) { void e; } }
  }
}

/** Transactional with retry: sends now, or parks it in `mailq:` for the 20-minute tick. */
export async function mailDeliver(env, msg, opts) {
  const r = await mailSend(env, { ...msg, kind: 'transactional' }, opts);
  if (r.sent || r.permanent || r.why === 'no_lane') return r;
  try {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await env.ORDERS.put('mailq:' + id, JSON.stringify({ to: msg.to, subject: msg.subject, text: msg.text, replyTo: msg.replyTo || '',
      tries: 1, first: new Date().toISOString(), why: r.why }), { expirationTtl: 3 * 86400 });
    return { ...r, queued: true };
  } catch (e) { return r; }
}

/** The tick: retry parked transactional mail, oldest first, while a lane has room. */
export async function mailDrain(env, max) {
  const out = { sent: 0, failed: 0, dropped: 0, left: 0 };
  if (!mailArmed(env) || !env.ORDERS) return out;
  let keys = [];
  try { keys = ((await env.ORDERS.list({ prefix: 'mailq:', limit: 50 })).keys || []).map((k) => k.name).sort(); } catch (e) { return out; }
  out.left = keys.length;
  for (const k of keys.slice(0, max || 4)) {
    const m = await env.ORDERS.get(k, 'json').catch(() => null);
    if (!m) { continue; }
    const r = await mailSend(env, { ...m, kind: 'transactional' });
    if (r.sent) { out.sent++; out.left--; try { await env.ORDERS.delete(k); } catch (e) { void e; } continue; }
    if (r.why === 'lanes_full') break;
    if (r.permanent || (m.tries || 0) >= 6) { out.dropped++; out.left--; try { await env.ORDERS.delete(k); } catch (e) { void e; } continue; }
    out.failed++;
    try { await env.ORDERS.put(k, JSON.stringify({ ...m, tries: (m.tries || 0) + 1, why: r.why }), { expirationTtl: 3 * 86400 }); } catch (e) { void e; }
  }
  return out;
}

export async function mailStatus(env) {
  const now = Date.now();
  const lanes = [];
  for (const l of mailLanes(env)) {
    lanes.push({ id: l.id, user: l.user.replace(/^(.).*(@.*)$/, '$1***$2'), host: l.host, hourly: l.hourly, outreach: l.outreach,
      used_this_hour: await laneUsedThisHour(env, l.id, now), state: await laneState(env, l.id) });
  }
  return { armed: lanes.length > 0, lanes };
}
export async function mailResume(env) {
  for (const l of mailLanes(env)) await laneSetState(env, l.id, { status: 'active' });
  return mailStatus(env);
}

/* ------------------------------------------------------------------ MX */
const mxMem = new Map();
/** Does this domain accept mail at all? DNS-over-HTTPS, cached per isolate. Unknown = true
 *  (a resolver hiccup must not mark a real shop undeliverable); NXDOMAIN or no MX/A = false. */
export async function mxOk(domain, fetcher) {
  const d = String(domain || '').toLowerCase().replace(/[^a-z0-9.-]/g, '');
  if (!d || !d.includes('.')) return false;
  if (mxMem.has(d)) return mxMem.get(d);
  const f = fetcher || fetch;
  let ok = true;
  try {
    const r = await f('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(d) + '&type=MX', { headers: { accept: 'application/dns-json' } });
    const j = await r.json();
    if (j.Status === 3) ok = false;                                     // NXDOMAIN
    else if (j.Status === 0) ok = (j.Answer || []).some((a) => a.type === 15 && !/^0 \.$/.test(String(a.data || '')));   // null MX (RFC 7505) = no mail
  } catch (e) { ok = true; }
  mxMem.set(d, ok);
  return ok;
}
