/* Tapstall mail over personal Gmail (v2.2.0, 2026-10-29; was inbox.lv), ported from STPi edge/src/mail.js
 * (itself AttestOS worker/src/mail/*). One Gmail box carries both halves:
 *   - the merchant's own mail: the welcome + email-confirm link, the PIN-reset link, the
 *     "your PIN was reset" and "a money setting changed" alerts, renewal notices, new-order
 *     alerts (opt-in), crypto reports, Whop payment claims;
 *   - cold first touches to merchants (the cron's outreach tick, a few an hour at most).
 *
 * Route (docs/GMAIL.md): SMTP 465 to smtp.gmail.com with a 16-character Google app password.
 * No Google Cloud project, no OAuth, no billing: 2-Step Verification on, then
 * myaccount.google.com/apppasswords.
 *
 * Config  MAILBOXES = '[{"id":"owner","provider":"gmail","fromName":"Tapstall","hourly":6}]'  (var)
 *         secrets GMAIL_<ID>_USER / GMAIL_<ID>_APP_PASSWORD (the same names the outreach runner
 *         reads, so the Worker and the runner share one inbox); MAILBOX_<ID>_USER / _PASS also work.
 * Nothing armed = every caller gets {sent:false, why:'no_lane'} and carries on (never a 500).
 *
 * Budget: personal Gmail allows ~500 recipients per rolling 24 h, shared with the outreach runner
 * and anything sent by hand. A gmail lane is clamped to 18/hour (18 x 24 = 432) and defaults to 6. Transactional mail always goes first; outreach only spends what is left
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
  if (m.inReplyTo) h.push(`In-Reply-To: ${mailClean(m.inReplyTo)}`, `References: ${mailClean(m.inReplyTo)}`);   // v2: T2/T3/link stay in T1's thread
  if (m.replyTo) h.push(`Reply-To: ${mailAddress(m.replyTo)}`);
  if (m.unsubscribe && (m.unsubscribe.url || m.unsubscribe.mailto)) {
    const parts = [];
    if (m.unsubscribe.mailto) parts.push(`<mailto:${mailClean(m.unsubscribe.mailto)}?subject=unsubscribe>`);
    if (m.unsubscribe.url) parts.push(`<${mailClean(m.unsubscribe.url)}>`);
    h.push(`List-Unsubscribe: ${parts.join(', ')}`);
    if (m.unsubscribe.url) h.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');   // RFC 8058
  }
  if (m.auto) h.push('Auto-Submitted: auto-generated');
  if (m.attachments && m.attachments.length) {   // the day-7 guide: multipart/mixed, the plain text first
    const mb = mailMixedBody(String(m.text || ''), m.attachments);
    h.push('Content-Type: ' + mb.contentType);
    return `${h.join('\r\n')}\r\n\r\n${mb.body}`;
  }
  h.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64');
  const body = mailB64(MAIL_ENC.encode(String(m.text || ''))).replace(/.{1,76}/g, '$&\r\n').trimEnd();
  return `${h.join('\r\n')}\r\n\r\n${body}\r\n`;
}

/* ------------------------------------------------------------------ lanes */
/** Provider presets: a lane names a provider instead of hosts. 18/hour keeps any rolling 24 h under 432. */
export const MAIL_PROVIDERS = { gmail: { host: 'smtp.gmail.com', imapHost: 'imap.gmail.com', hourlyMax: 18 } };
export function mailLanes(env) {
  let cfg = [];
  try { cfg = JSON.parse(String((env && env.MAILBOXES) || '[]')); } catch (e) { return []; }
  if (!Array.isArray(cfg)) return [];
  const out = [];
  for (const c of cfg) {
    const id = String((c && c.id) || '').toLowerCase();
    if (!/^[a-z0-9]{1,12}$/.test(id)) continue;
    const K = id.toUpperCase();
    const provider = String(c.provider || (c.host && c.host !== MAIL_PROVIDERS.gmail.host ? 'custom' : 'gmail')).toLowerCase();
    const preset = MAIL_PROVIDERS[provider] || null;
    const user = String(env['GMAIL_' + K + '_USER'] || env['MAILBOX_' + K + '_USER'] || '').trim();
    // Google shows app passwords as four groups of four; the spaces are display only.
    const pass = String(env['GMAIL_' + K + '_APP_PASSWORD'] || env['MAILBOX_' + K + '_PASS'] || '').replace(/\s+/g, '');
    const host = String(c.host || (preset && preset.host) || '');
    if (!user.includes('@') || !pass || !host) continue;
    out.push({ id, provider, user, pass, host, imapHost: String(c.imapHost || (preset && preset.imapHost) || host), port: Number(c.smtpPort) || 465,
      fromName: String(c.fromName || 'Tapstall'), hourly: Math.max(1, Math.min(preset ? preset.hourlyMax : 60, Number(c.hourly) || 6)),
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
async function pickLane(env, kind, now, onlyUser) {
  for (const l of mailLanes(env)) {
    if (kind === 'outreach' && !l.outreach) continue;
    if (onlyUser && l.user.toLowerCase() !== String(onlyUser).toLowerCase()) continue;   // v2: one box per lead
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
  const lane = await pickLane(env, kind, now, msg.laneUser);
  if (!lane) return { sent: false, why: 'lanes_full' };
  const messageId = `<${now.toString(36)}.${Math.random().toString(36).slice(2, 10)}@tapstall.mail>`;
  const mime = buildMail({ from: lane.user, fromName: msg.fromName || lane.fromName, to, subject: msg.subject, text: msg.text,
    replyTo: msg.replyTo || lane.user, unsubscribe: msg.unsubscribe, auto: kind === 'transactional', inReplyTo: msg.inReplyTo, messageId,
    attachments: msg.attachments });
  let s = null;
  try {
    const open = env.MAIL_TEST_OPEN || (async (l) => smtpSession(await mailOpenTls(l.host, l.port, 15000), { user: l.user, pass: l.pass }));
    s = await open(lane);
    await s.send(lane.user, to, mime);
    await laneBump(env, lane.id, now);
    return { sent: true, lane: lane.id, user: lane.user, messageId };
  } catch (e) {
    // a refused password parks the lane for six hours instead of hammering the box (repeated bad logins
    // get a Google account challenged); it comes back by itself, so nobody has to press resume
    if (e && e.authFail) await laneSetState(env, lane.id, { status: 'active', auth_failed: true, cooldown_until: new Date(now + 6 * 3600e3).toISOString(), why: String(e.message).slice(0, 160), at: new Date(now).toISOString() });
    else if (e && !e.permanent) await laneSetState(env, lane.id, { status: 'active', cooldown_until: new Date(now + 10 * 60e3).toISOString(), why: String(e && e.message || e).slice(0, 160) });
    return { sent: false, why: String(e && e.message || e).slice(0, 160), permanent: !!(e && e.permanent) };
  } finally {
    if (s) { try { await s.quit(); } catch (e) { void e; } }
  }
}

/** Transactional with retry: sends now, or parks it in `mailq:` for the hourly tick. */
export async function mailDeliver(env, msg, opts) {
  const r = await mailSend(env, { ...msg, kind: 'transactional' }, opts);
  if (r.sent || r.permanent || r.why === 'no_lane') return r;
  try {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await env.ORDERS.put('mailq:' + id, JSON.stringify({ to: msg.to, subject: msg.subject, text: msg.text, replyTo: msg.replyTo || '',
      tries: 1, first: new Date().toISOString(), why: r.why }), { expirationTtl: 3 * 86400 });
    // The flag the hourly tick reads instead of listing: a read is 1/100,000 of the day, a list 1/1,000.
    try { await env.ORDERS.put(MAILQ_FLAG, String(Date.now()), { expirationTtl: 3 * 86400 }); } catch (e) { void e; }
    return { ...r, queued: true };
  } catch (e) { return r; }
}

/** The tick: retry parked transactional mail, oldest first, while a lane has room. */
const MAILQ_FLAG = 'mailflag:queued';   // outside the mailq: prefix, so it is never mistaken for a message

/** opts.full: list even without the flag (the nightly sweep does, so a flag lost to a race costs hours, not mail). */
export async function mailDrain(env, max, opts) {
  const out = { sent: 0, failed: 0, dropped: 0, left: 0 };
  if (!mailArmed(env) || !env.ORDERS) return out;
  const full = !!(opts && opts.full);
  let flag = null;
  if (!full) {
    try { flag = await env.ORDERS.get(MAILQ_FLAG); } catch (e) { return out; }
    if (!flag) { out.idle = true; return out; }
  }
  let keys = [];
  try { keys = ((await env.ORDERS.list({ prefix: 'mailq:', limit: 50 })).keys || []).map((k) => k.name).sort(); } catch (e) { return out; }
  out.left = keys.length;
  const clearFlag = async () => {
    // Only the flag this pass saw: an enqueue that landed meanwhile re-set it with a newer stamp.
    try { const now = await env.ORDERS.get(MAILQ_FLAG); if (now && (full || now === flag)) await env.ORDERS.delete(MAILQ_FLAG); } catch (e) { void e; }
  };
  if (!keys.length) { await clearFlag(); return out; }
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
  if (out.left <= 0) await clearFlag();
  else if (full) { try { await env.ORDERS.put(MAILQ_FLAG, String(Date.now()), { expirationTtl: 3 * 86400 }); } catch (e) { void e; } }
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

/* ------------------------------------------------------------------ PDF (day-7 attachment) */
// Dependency-free A4 PDF writer, inlined here because build_bundle.sh inlines only rail/discover/mail/wa/core.
// Helvetica advance widths (1/1000 em) for ASCII 32..126 (standard AFM metrics).
const MAIL_HW = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const MAIL_HBW = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

/** Text the built-in fonts can print: curly quotes, dashes, ellipses and accents folded to ASCII. */
export function mailPdfSafe(s) {
  return String(s ?? "")
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-").replace(/\u2026/g, "...").replace(/[\u00A0\u2009\u202F]/g, " ")
    .replace(/\u2022/g, "-").replace(/\u00D7/g, "x")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E\n]/g, "");
}
const mailPdfEsc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const mailPdfWidth = (s, size, bold) => { const w = bold ? MAIL_HBW : MAIL_HW; let n = 0; for (const ch of s) n += w[ch.charCodeAt(0) - 32] ?? 556; return (n * size) / 1000; };

function mailPdfWrap(text, size, bold, max) {
  const out = [];
  for (const para of mailPdfSafe(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? line + " " + word : word;
      if (mailPdfWidth(next, size, bold) <= max || !line) line = next; else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

function mailPdfRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "")) || [0, "1f3a5f"];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3)).join(" ");
}

export function mailPdf({ title = "", subtitle = "", accent = "#1f3a5f", sections = [], footer = "" } = {}) {
  const W = 595, H = 842, L = 56, R = 56, TOP = 70, BOTTOM = 64, MAX = W - L - R;
  const pages = [];
  let ops = [], y = H - TOP;
  const newPage = () => { if (ops.length) pages.push(ops); ops = []; y = H - TOP; ops.push(`${mailPdfRgb(accent)} rg 0 ${H - 18} ${W} 18 re f 0 g`); };
  const need = (h) => { if (y - h < BOTTOM) newPage(); };
  const text = (s, size, bold, x = L, color = "0 g") => { ops.push(`BT ${color} /${bold ? "F2" : "F1"} ${size} Tf ${x} ${y.toFixed(1)} Td (${mailPdfEsc(s)}) Tj ET`); };
  newPage();
  for (const line of mailPdfWrap(title, 20, true, MAX)) { need(26); text(line, 20, true, L, `${mailPdfRgb(accent)} rg`); y -= 26; }
  if (subtitle) { y -= 2; for (const line of mailPdfWrap(subtitle, 11, false, MAX)) { need(15); text(line, 11, false, L, "0.35 g"); y -= 15; } }
  y -= 10;
  for (const sec of sections) {
    if (sec.heading) { y -= 6; need(34); for (const line of mailPdfWrap(sec.heading, 13, true, MAX)) { text(line, 13, true); y -= 18; } }
    for (const p of sec.paras || []) { for (const line of mailPdfWrap(p, 10.5, false, MAX)) { need(14.5); text(line, 10.5, false); y -= 14.5; } y -= 6; }
    if (sec.code && sec.code.length) { // monospace (Courier, built in)
      y -= 2; const per = Math.floor(MAX / (0.6 * 8.5));
      for (const raw of sec.code) {
        let rest = mailPdfSafe(raw), first = true; // long lines wrap with an indent; code is never cut
        do { const w = first ? per - 2 : per - 6; const piece = (first ? "" : "    ") + rest.slice(0, w); rest = rest.slice(w); first = false;
          need(11.5); ops.push(`BT 0.12 g /F3 8.5 Tf ${L + 8} ${y.toFixed(1)} Td (${mailPdfEsc(piece)}) Tj ET`); y -= 11.5; } while (rest.length);
      }
      y -= 8;
    }
    for (const b of sec.bullets || []) {
      const lines = mailPdfWrap(b, 10.5, false, MAX - 14);
      lines.forEach((line, i) => { need(14.5); if (i === 0) text("-", 10.5, true); text(line, 10.5, false, L + 14); y -= 14.5; });
      y -= 3;
    }
  }
  pages.push(ops);
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const f3 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  const pagesId = objs.length + 1; objs.push(null);
  const kids = [];
  pages.forEach((p, i) => {
    const foot = `BT 0.45 g /F1 8.5 Tf ${L} 36 Td (${mailPdfEsc(mailPdfSafe(footer))}) Tj ET BT 0.45 g /F1 8.5 Tf ${W - R - 30} 36 Td (${i + 1}/${pages.length}) Tj ET`;
    const stream = [...p, foot].join("\n");
    const c = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >> /Contents ${c} 0 R >>`));
  });
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${mailPdfEsc(mailPdfSafe(title))}) /Producer (Jacaranda Labs) >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
  return bytes;
}

/** base64 of bytes, wrapped at 76 columns (MIME). */
export function mailB64wrap(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

/** A multipart/mixed body: the plain text first, then each attachment. Returns { contentType, body }. */
export function mailMixedBody(text, attachments, boundary = "jl" + Math.random().toString(36).slice(2, 14)) {
  const parts = [`--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${mailB64wrap(new TextEncoder().encode(text))}\r\n`];
  for (const a of attachments) {
    const name = mailPdfSafe(a.filename).replace(/["\\\r\n]/g, "").slice(0, 80) || "brief.pdf";
    parts.push(`--${boundary}\r\nContent-Type: ${a.type || "application/pdf"}; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${mailB64wrap(a.content)}\r\n`);
  }
  return { contentType: `multipart/mixed; boundary="${boundary}"`, body: parts.join("") + `--${boundary}--\r\n` };
}

/* ------------------------------------------------------------------ outreach v2 */
// Outreach v2 (owner, 2026-11-04). Pure, so tests can hold it to the rules:
//  T1 is plain text with NO links and no attachments ("reply stop" + postal; the one-click unsubscribe
//  lives in the List-Unsubscribe header, not the body). The link goes out when the business replies
//  (a short threaded answer), or on day 7 if they don't (T2). Day 14 is one short last note (T3), then stop.
//  Two Gmail boxes; each lead stays on one box. Daily = ramp 10/25/50 from 5 Nov 2026; the brake stops
//  new first touches when a week shows >5% bounces or >3% stops (from 20 sends).
export const V2_FOLLOW_DAYS = [7, 7, 7];
export const V2_MAX_TOUCHES = 3;
export function v2Ramp(now, start) {
  const days = Math.floor((now - Date.parse((start || '2026-11-05') + 'T00:00:00Z')) / 864e5);
  return days < 0 ? 0 : days < 7 ? 10 : days < 14 ? 25 : 50;
}
export function v2Brake(w) {
  const sent = Number(w && w.sent) || 0, b = Number(w && w.bounced) || 0, s = Number(w && w.stops) || 0;
  if (sent < 20) return '';
  // owner 2026-11-04: a wrong address or missing domain is not a failure; it never brakes or pauses outreach
  if (s / sent > 0.03) return 'brake: ' + s + ' stops in ' + sent + ' sends this week';
  return '';
}
/** FNV-1a: the same address always lands on the same box. */
export function v2BoxIndex(email, n) {
  let h = 2166136261;
  for (const ch of String(email || '').toLowerCase()) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return n > 0 ? h % n : 0;
}
/** How many this tick may send: spread what is left of the day over the ticks left in the window. */
export function v2PerTick(dailyLeft, hourUtc, endHour) {
  const ticksLeft = Math.max(1, (endHour || 16) - hourUtc + 1);
  return Math.max(0, Math.min(6, Math.ceil(Math.max(0, dailyLeft) / ticksLeft)));
}
export const v2WeekKey = (now) => {
  const d = new Date(now); const day = Math.floor(d.getTime() / 864e5); // ISO-ish week bucket: days since epoch / 7
  return 'outreach:wk:' + Math.floor((day + 3) / 7);
};

/** 2026-11-06 (build step 4): one copy set per language, picked by the lead's country; English is the fallback, so
 *  every country has a template. Price lines live in V2_PRICE only (step 7 swaps them for the free plan).
 *  The claim is what the product does today: each order shows an exact amount and a short reference to pay, and the
 *  seller matches the money in their own account to the order. Nothing promises cents (CFA, rupiah and M-Pesa have none). */
export const V2_LANG = {
  es: ['pe', 'co', 'ar', 'bo', 'ec', 'py', 'uy', 'cl', 'gt', 'hn', 'sv', 'ni', 'cr', 'pa', 'do'],
  pt: ['ao', 'mz', 'cv', 'st', 'gw'],
  fr: ['ci', 'sn', 'ml', 'bf', 'ne', 'tg', 'bj', 'gn', 'cd', 'cg', 'ga', 'dj', 'mg', 'km', 'cm', 'tn', 'dz', 'ma', 'ht', 'td', 'cf', 'bi'],
  ar: ['eg', 'jo', 'lb', 'om', 'bh', 'kw', 'qa', 'sa', 'ps', 'mr'],
  tr: ['tr'], id: ['id'], uk: ['ua'], vi: ['vn'],
};
export const V2_LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'tr', 'id', 'uk', 'vi'];
export function v2Lang(cc) {
  const c = String(cc || '').toLowerCase();
  for (const [lang, list] of Object.entries(V2_LANG)) if (list.includes(c)) return lang;
  return 'en';
}
/** Every country now has copy (English where there is no local set); the guard stays for codes that are not countries. */
export function v2Market(cc) { return /^[a-z]{2}$/.test(String(cc || '').toLowerCase()); }

/** The wallet a seller in this country most likely means by "pay me" (used only when the site names none). */
const V2_WALLET_CC = { pe: 'Yape', co: 'Nequi', ar: 'Mercado Pago', cr: 'SINPE Móvil', ke: 'M-Pesa', tz: 'M-Pesa', cd: 'M-Pesa', mz: 'M-Pesa',
  gh: 'MoMo', ug: 'MoMo', rw: 'MoMo', zm: 'MoMo', cm: 'Orange Money', ci: 'Orange Money', sn: 'Orange Money', ml: 'Orange Money',
  bf: 'Orange Money', et: 'telebirr', bd: 'bKash', pk: 'JazzCash', in: 'UPI', ph: 'GCash', np: 'eSewa', eg: 'InstaPay', mw: 'Airtel Money',
  zw: 'EcoCash', za: 'PayShap', vn: 'MoMo' };
/** How the harvest's lower-case matches are written by their owners. */
const V2_WALLET_NAME = { yape: 'Yape', plin: 'Plin', nequi: 'Nequi', daviplata: 'Daviplata', gcash: 'GCash', paymaya: 'Maya', 'maya wallet': 'Maya',
  mpesa: 'M-Pesa', 'm-pesa': 'M-Pesa', jazzcash: 'JazzCash', easypaisa: 'Easypaisa', bkash: 'bKash', nagad: 'Nagad', momo: 'MoMo',
  'orange money': 'Orange Money', 'wave money': 'Wave', 'airtel money': 'Airtel Money', ecocash: 'EcoCash', gopay: 'GoPay', 'dana wallet': 'DANA',
  'vodafone cash': 'Vodafone Cash', sinpe: 'SINPE Móvil', 'tigo money': 'Tigo Money', mercadopago: 'Mercado Pago', 'mercado pago': 'Mercado Pago',
  telebirr: 'telebirr', paytm: 'Paytm', phonepe: 'PhonePe', upi: 'UPI', zalopay: 'ZaloPay', fawry: 'Fawry', instapay: 'InstaPay',
  monobank: 'monobank', privat24: 'Privat24' };
/** What the site itself showed (the harvest writes "Site: orders over WhatsApp; mentions yape, plin; takes bank transfers"). */
export function v2Seen(lead) {
  const note = String(lead.note || '');
  const sig = new Set(lead.signals || []);
  const m = note.match(/mentions ([^;]+)/i);
  const wallets = [...new Set((m ? m[1].split(',') : []).map((w) => V2_WALLET_NAME[w.trim().toLowerCase()]).filter(Boolean))].slice(0, 2);
  return { wa: sig.has('whatsapp_selling') || /orders over WhatsApp/i.test(note) || !!(lead.evidence && lead.evidence.has_whatsapp),
    wallets, transfers: /takes bank transfers/i.test(note), friction: sig.has('payment_friction') };
}

const V2_PRICE = {
  en: { t1: 'It is free for 60 days, then USD 60 a year. No commission on your sales and no order cap.', t2: 'It is free for 60 days. No commission on your sales.',
    link: 'Free for 60 days, then USD 60 a year (or USD 7 a month). No commission on your sales.' },
  es: { t1: 'Es gratis durante 60 días y luego cuesta 60 USD al año. Sin comisión sobre sus ventas y sin límite de pedidos.', t2: 'Es gratis durante 60 días. Sin comisión sobre sus ventas.',
    link: 'Gratis durante 60 días; luego 60 USD al año (o 7 USD al mes). Sin comisión sobre sus ventas.' },
  pt: { t1: 'É grátis durante 60 dias e depois custa 60 USD por ano. Sem comissão sobre as vossas vendas e sem limite de encomendas.', t2: 'É grátis durante 60 dias. Sem comissão sobre as vossas vendas.',
    link: 'Grátis durante 60 dias; depois 60 USD por ano (ou 7 USD por mês). Sem comissão sobre as vossas vendas.' },
  fr: { t1: "C'est gratuit pendant 60 jours, puis 60 USD par an. Aucune commission sur vos ventes et aucune limite de commandes.", t2: "C'est gratuit pendant 60 jours. Aucune commission sur vos ventes.",
    link: 'Gratuit pendant 60 jours, puis 60 USD par an (ou 7 USD par mois). Aucune commission sur vos ventes.' },
  tr: { t1: '60 gün ücretsiz, sonrasında yılda 60 USD. Satışlarınızdan komisyon yok, sipariş sınırı yok.', t2: '60 gün ücretsiz. Satışlarınızdan komisyon yok.',
    link: '60 gün ücretsiz, sonra yılda 60 USD (veya ayda 7 USD). Satışlarınızdan komisyon yok.' },
  id: { t1: 'Gratis selama 60 hari, lalu USD 60 per tahun. Tanpa komisi dari penjualan Anda dan tanpa batas pesanan.', t2: 'Gratis selama 60 hari. Tanpa komisi dari penjualan Anda.',
    link: 'Gratis selama 60 hari, lalu USD 60 per tahun (atau USD 7 per bulan). Tanpa komisi dari penjualan Anda.' },
  uk: { t1: 'Перші 60 днів безкоштовно, далі 60 USD на рік. Без комісії з ваших продажів і без ліміту замовлень.', t2: 'Перші 60 днів безкоштовно. Без комісії з ваших продажів.',
    link: 'Перші 60 днів безкоштовно, далі 60 USD на рік (або 7 USD на місяць). Без комісії з ваших продажів.' },
  vi: { t1: 'Miễn phí 60 ngày, sau đó 60 USD mỗi năm. Không thu hoa hồng trên doanh số và không giới hạn số đơn.', t2: 'Miễn phí 60 ngày. Không thu hoa hồng trên doanh số.',
    link: 'Miễn phí 60 ngày, sau đó 60 USD mỗi năm (hoặc 7 USD mỗi tháng). Không thu hoa hồng trên doanh số.' },
  ar: { t1: 'الخدمة مجانية لمدة 60 يومًا، ثم 60 دولارًا أمريكيًا في السنة. بلا عمولة على مبيعاتكم وبلا حد لعدد الطلبات.', t2: 'الخدمة مجانية لمدة 60 يومًا. بلا عمولة على مبيعاتكم.',
    link: 'مجاني لمدة 60 يومًا، ثم 60 دولارًا أمريكيًا في السنة (أو 7 دولارات شهريًا). بلا عمولة على مبيعاتكم.' },
};

export const V2_COPY = {
  en: { shop: 'your shop', and: ' and ', transfers: 'bank transfers',
    subj: (b) => `${b}: a screenshot is not a payment`,
    ev: { waPay: (b, p) => `I came across ${b} and saw that you take orders on WhatsApp and accept ${p}.`, wa: (b) => `I came across ${b} taking orders on WhatsApp.`,
      pay: (b, p) => `I came across ${b} and saw that you accept ${p}.`, fric: (b) => `I came across ${b} while looking at how shops match payments to orders.`,
      none: (b) => `I came across ${b} online.` },
    into: (w) => (w ? `your own ${w} or bank account` : 'your own mobile wallet or bank account'),
    stop: 'If you would rather not hear from me again, just reply "stop".',
    t1: (c) => `Hi ${c.biz} team,\n\n${c.ev} Can I ask about a moment most shops know too well?\n\nA customer sends a screenshot that says "paid", you hand over the order, and the money never arrives. Or twenty payments land in one evening and you sit up late matching amounts to names.\n\nI built Tapstall so that moment stops happening. Customers pick from your menu on one page and pay straight into ${c.into}. Each order shows the exact amount and a short reference to pay, so you match the money that lands in your account to the order, not to a screenshot. A screenshot proves nothing; the payment does.\n\n${c.P.t1}\n\nWould it help if I sent you the link to try it? Just reply and I will.`,
    t2: (c) => `Hi again,\n\nRather than ask twice, I made something for ${c.biz}: the attached one-page guide to ending fake proof of payment. It shows how the fakes usually happen, five checks to make before you hand over goods, and how a shop page gives every order an exact amount and a reference to pay. The checks work even if you never use Tapstall.\n\nWhen you want the money to tell you which order it is, here is the link: ${c.link}\n\nIt takes about two minutes to set up. ${c.P.t2}`,
    t3: (c) => `Last note from me, and thank you for reading. If fake screenshots or late nights matching payments ever start costing ${c.biz} sales, your shop page can be live in a few minutes: ${c.link}\n\nI will not write again.`,
    link: (c) => `Thank you for writing back. Here is the link: ${c.link}\n\nYou set up your menu once, customers order from one link and pay into ${c.into}, and each order shows its exact amount and a reference, so the payment that lands tells you which order it is. ${c.P.link}\n\nAny question, just reply here.` },
  es: { shop: 'su tienda', and: ' y ', transfers: 'transferencias bancarias',
    subj: (b) => `${b}: una captura de pantalla no es un pago`,
    ev: { waPay: (b, p) => `Conocí ${b} y vi que reciben pedidos por WhatsApp y aceptan ${p}.`, wa: (b) => `Conocí ${b} y vi que reciben pedidos por WhatsApp.`,
      pay: (b, p) => `Conocí ${b} y vi que aceptan ${p}.`, fric: (b) => `Conocí ${b} mientras veía cómo las tiendas cuadran pagos con pedidos.`,
      none: (b) => `Conocí ${b} en internet.` },
    into: (w) => (w ? `su propia cuenta de ${w} o su cuenta bancaria` : 'su propia billetera móvil o su cuenta bancaria'),
    stop: 'Si prefieren no recibir más mensajes míos, respondan "stop" o "baja".',
    t1: (c) => `Hola, equipo de ${c.biz}:\n\n${c.ev} ¿Puedo preguntarles por un momento que muchas tiendas conocen demasiado bien?\n\nUn cliente envía una captura que dice "pagado", ustedes entregan el pedido y el dinero nunca llega. O llegan veinte pagos en una sola noche y se quedan hasta tarde cuadrando montos con nombres.\n\nCreé Tapstall para que ese momento deje de pasar. Los clientes eligen de su menú en una sola página y pagan directamente a ${c.into}. Cada pedido muestra el monto exacto y una referencia corta para pagar, así ustedes comparan el dinero que llega a su cuenta con el pedido, no con una captura. Una captura no prueba nada; el pago sí.\n\n${c.P.t1}\n\n¿Les sirve que les envíe el enlace para probarlo? Solo respondan y se lo envío.`,
    t2: (c) => `Hola de nuevo:\n\nEn lugar de preguntar dos veces, les preparé algo que pueden usar hoy: la guía adjunta de una página para acabar con los comprobantes de pago falsos. Muestra cómo suelen ocurrir los engaños, cinco verificaciones antes de entregar un pedido y cómo una página de tienda da a cada pedido un monto exacto y una referencia para pagar. Las verificaciones sirven aunque nunca usen Tapstall.\n\nCuando quieran que el dinero les diga a qué pedido corresponde, este es el enlace: ${c.link}\n\nConfigurarlo toma unos dos minutos. ${c.P.t2}`,
    t3: (c) => `Esta es mi última nota; gracias por leer. Si algún día las capturas falsas o las noches cuadrando pagos empiezan a costarle ventas a ${c.biz}, su página de tienda puede estar lista en pocos minutos: ${c.link}\n\nNo volveré a escribirles.`,
    link: (c) => `Gracias por responder. Este es el enlace: ${c.link}\n\nConfiguran su menú una vez, los clientes piden desde un solo enlace y pagan a ${c.into}, y cada pedido muestra su monto exacto y una referencia, así el pago que llega les dice a qué pedido corresponde. ${c.P.link}\n\nCualquier pregunta, respondan aquí.` },
  pt: { shop: 'a vossa loja', and: ' e ', transfers: 'transferências bancárias',
    subj: (b) => `${b}: uma captura de ecrã não é um pagamento`,
    ev: { waPay: (b, p) => `Encontrei ${b} e vi que recebem encomendas pelo WhatsApp e aceitam ${p}.`, wa: (b) => `Encontrei ${b} e vi que recebem encomendas pelo WhatsApp.`,
      pay: (b, p) => `Encontrei ${b} e vi que aceitam ${p}.`, fric: (b) => `Encontrei ${b} enquanto via como as lojas fazem corresponder pagamentos e encomendas.`,
      none: (b) => `Encontrei ${b} na internet.` },
    into: (w) => (w ? `a vossa própria conta ${w} ou conta bancária` : 'a vossa própria carteira móvel ou conta bancária'),
    stop: 'Se preferirem não receber mais mensagens minhas, basta responder "stop" ou "parar".',
    t1: (c) => `Olá, equipa ${c.biz},\n\n${c.ev} Posso perguntar sobre um momento que muitas lojas conhecem bem demais?\n\nUm cliente envia uma captura de ecrã a dizer "pago", vocês entregam a encomenda e o dinheiro nunca chega. Ou chegam vinte pagamentos numa só noite e ficam até tarde a fazer corresponder valores a nomes.\n\nCriei o Tapstall para que esse momento deixe de acontecer. Os clientes escolhem do vosso menu numa só página e pagam diretamente para ${c.into}. Cada encomenda mostra o valor exato e uma referência curta para pagar, por isso vocês comparam o dinheiro que entra na vossa conta com a encomenda, não com uma captura de ecrã. Uma captura de ecrã não prova nada; o pagamento prova.\n\n${c.P.t1}\n\nAjudaria se eu vos enviasse o link para experimentar? Basta responder e eu envio.`,
    t2: (c) => `Olá novamente,\n\nEm vez de perguntar duas vezes, preparei algo que podem usar hoje: o guia de uma página em anexo para acabar com comprovativos de pagamento falsos. Mostra como as fraudes costumam acontecer, cinco verificações antes de entregar uma encomenda e como uma página de loja dá a cada encomenda um valor exato e uma referência para pagar. As verificações funcionam mesmo que nunca usem o Tapstall.\n\nQuando quiserem que o dinheiro vos diga a que encomenda pertence, aqui está o link: ${c.link}\n\nA configuração demora cerca de dois minutos. ${c.P.t2}`,
    t3: (c) => `Esta é a minha última mensagem; obrigado por lerem. Se um dia as capturas falsas ou as noites a conferir pagamentos começarem a custar vendas, a vossa página de loja pode estar pronta em poucos minutos: ${c.link}\n\nNão voltarei a escrever.`,
    link: (c) => `Obrigado pela resposta. Aqui está o link: ${c.link}\n\nConfiguram o vosso menu uma vez, os clientes encomendam a partir de um só link e pagam para ${c.into}, e cada encomenda mostra o valor exato e uma referência, por isso o pagamento que entra diz-vos a que encomenda pertence. ${c.P.link}\n\nQualquer dúvida, basta responder aqui.` },
  fr: { shop: 'votre boutique', and: ' et ', transfers: 'les virements bancaires',
    subj: (b) => `${b} : une capture d'écran n'est pas un paiement`,
    ev: { waPay: (b, p) => `J'ai découvert ${b} et j'ai vu que vous prenez les commandes sur WhatsApp et acceptez ${p}.`, wa: (b) => `J'ai découvert ${b} et j'ai vu que vous prenez les commandes sur WhatsApp.`,
      pay: (b, p) => `J'ai découvert ${b} et j'ai vu que vous acceptez ${p}.`, fric: (b) => `J'ai découvert ${b} en regardant comment les boutiques rapprochent paiements et commandes.`,
      none: (b) => `J'ai découvert ${b} en ligne.` },
    into: (w) => (w ? `votre propre compte ${w} ou votre compte bancaire` : 'votre propre portefeuille mobile ou votre compte bancaire'),
    stop: 'Si vous préférez ne plus recevoir de messages de ma part, répondez simplement « stop ».',
    t1: (c) => `Bonjour à l'équipe ${c.biz},\n\n${c.ev} Puis-je vous parler d'un moment que beaucoup de boutiques connaissent trop bien ?\n\nUn client envoie une capture d'écran qui dit « payé », vous remettez la commande, et l'argent n'arrive jamais. Ou vingt paiements arrivent en une soirée et vous veillez tard pour faire correspondre les montants aux noms.\n\nJ'ai créé Tapstall pour que ce moment n'arrive plus. Vos clients choisissent dans votre menu sur une seule page et paient directement sur ${c.into}. Chaque commande affiche le montant exact et une courte référence de paiement, vous comparez donc l'argent reçu sur votre compte avec la commande, pas avec une capture d'écran. Une capture d'écran ne prouve rien ; le paiement, si.\n\n${c.P.t1}\n\nVoulez-vous que je vous envoie le lien pour l'essayer ? Il suffit de répondre.`,
    t2: (c) => `Bonjour à nouveau,\n\nPlutôt que de demander deux fois, j'ai préparé quelque chose d'utile dès aujourd'hui : le guide d'une page ci-joint pour en finir avec les fausses preuves de paiement. Il montre comment les fraudes se produisent le plus souvent, cinq vérifications à faire avant de remettre une commande, et comment une page boutique donne à chaque commande un montant exact et une référence de paiement. Ces vérifications sont utiles même si vous n'utilisez jamais Tapstall.\n\nQuand vous voudrez que l'argent vous dise à quelle commande il correspond, voici le lien : ${c.link}\n\nLa mise en place prend environ deux minutes. ${c.P.t2}`,
    t3: (c) => `Dernier message de ma part, merci de m'avoir lu. Si les fausses captures ou les soirées passées à vérifier les paiements finissent par coûter des ventes à ${c.biz}, votre page boutique peut être en ligne en quelques minutes : ${c.link}\n\nJe ne vous écrirai plus.`,
    link: (c) => `Merci pour votre réponse. Voici le lien : ${c.link}\n\nVous configurez votre menu une fois, vos clients commandent depuis un seul lien et paient sur ${c.into}, et chaque commande affiche son montant exact et une référence : le paiement reçu vous dit à quelle commande il correspond. ${c.P.link}\n\nPour toute question, répondez simplement ici.` },
  tr: { shop: 'mağazanız', and: ' ve ', transfers: 'havale/EFT',
    subj: (b) => `${b}: ekran görüntüsü ödeme değildir`,
    ev: { waPay: (b, p) => `${b} ile karşılaştım; WhatsApp üzerinden sipariş aldığınızı ve ${p} kabul ettiğinizi gördüm.`, wa: (b) => `${b} ile karşılaştım; WhatsApp üzerinden sipariş aldığınızı gördüm.`,
      pay: (b, p) => `${b} ile karşılaştım; ${p} kabul ettiğinizi gördüm.`, fric: (b) => `Mağazaların ödemeleri siparişlerle nasıl eşleştirdiğine bakarken ${b} ile karşılaştım.`,
      none: (b) => `${b} ile internette karşılaştım.` },
    into: (w) => (w ? `kendi ${w} hesabınıza veya banka hesabınıza` : 'kendi banka hesabınıza veya mobil cüzdanınıza'),
    stop: 'Benden tekrar mesaj almak istemezseniz "stop" veya "dur" yazarak yanıtlamanız yeterli.',
    t1: (c) => `Merhaba ${c.biz} ekibi,\n\n${c.ev} Pek çok mağazanın çok iyi bildiği bir anı sorabilir miyim?\n\nBir müşteri "ödendi" yazan bir ekran görüntüsü gönderir, siz siparişi teslim edersiniz ve para hiç gelmez. Ya da bir akşamda yirmi ödeme gelir ve gece geç saatlere kadar tutarları isimlerle eşleştirirsiniz.\n\nTapstall'ı bu an bir daha yaşanmasın diye yaptım. Müşteriler tek bir sayfada menünüzden seçer ve ödemeyi doğrudan ${c.into} yapar. Her sipariş ödenecek tam tutarı ve kısa bir referansı gösterir; böylece hesabınıza gelen parayı ekran görüntüsüyle değil, siparişle eşleştirirsiniz. Ekran görüntüsü hiçbir şeyi kanıtlamaz; ödeme kanıtlar.\n\n${c.P.t1}\n\nDenemeniz için bağlantıyı göndermemi ister misiniz? Yanıtlamanız yeterli, hemen gönderirim.`,
    t2: (c) => `Tekrar merhaba,\n\nİki kez sormak yerine bugün kullanabileceğiniz bir şey hazırladım: sahte ödeme dekontlarına son vermek için ekteki tek sayfalık rehber. Sahteciliklerin genellikle nasıl yapıldığını, siparişi teslim etmeden önce yapılacak beş kontrolü ve bir mağaza sayfasının her siparişe nasıl tam bir tutar ve ödeme referansı verdiğini anlatıyor. Bu kontroller Tapstall'ı hiç kullanmasanız da işe yarar.\n\nGelen paranın hangi siparişe ait olduğunu size söylemesini istediğinizde bağlantı burada: ${c.link}\n\nKurulum yaklaşık iki dakika sürer. ${c.P.t2}`,
    t3: (c) => `Bu benden son mesaj, okuduğunuz için teşekkürler. Sahte ekran görüntüleri ya da ödemeleri kontrol ederek geçen geceler bir gün ${c.biz} için satış kaybına dönüşürse, mağaza sayfanız birkaç dakikada hazır olabilir: ${c.link}\n\nBir daha yazmayacağım.`,
    link: (c) => `Yanıtınız için teşekkürler. Bağlantı burada: ${c.link}\n\nMenünüzü bir kez kurarsınız, müşteriler tek bir bağlantıdan sipariş verir ve ödemeyi ${c.into} yapar; her sipariş tam tutarını ve bir referansı gösterir, böylece gelen ödeme hangi siparişe ait olduğunu size söyler. ${c.P.link}\n\nHer türlü sorunuz için buradan yanıtlamanız yeterli.` },
  id: { shop: 'toko Anda', and: ' dan ', transfers: 'transfer bank',
    subj: (b) => `${b}: tangkapan layar bukan pembayaran`,
    ev: { waPay: (b, p) => `Saya menemukan ${b} dan melihat bahwa Anda menerima pesanan lewat WhatsApp dan pembayaran lewat ${p}.`, wa: (b) => `Saya menemukan ${b} dan melihat bahwa Anda menerima pesanan lewat WhatsApp.`,
      pay: (b, p) => `Saya menemukan ${b} dan melihat bahwa Anda menerima pembayaran lewat ${p}.`, fric: (b) => `Saya menemukan ${b} saat melihat bagaimana toko mencocokkan pembayaran dengan pesanan.`,
      none: (b) => `Saya menemukan ${b} di internet.` },
    into: (w) => (w ? `akun ${w} atau rekening bank Anda sendiri` : 'rekening bank atau dompet digital Anda sendiri'),
    stop: 'Jika Anda tidak ingin menerima pesan dari saya lagi, cukup balas "stop" atau "berhenti".',
    t1: (c) => `Halo tim ${c.biz},\n\n${c.ev} Boleh saya bertanya tentang satu momen yang terlalu dikenal banyak toko?\n\nPelanggan mengirim tangkapan layar bertuliskan "sudah bayar", Anda menyerahkan pesanan, dan uangnya tidak pernah masuk. Atau dua puluh pembayaran masuk dalam satu malam dan Anda begadang mencocokkan nominal dengan nama.\n\nSaya membuat Tapstall agar momen itu tidak terjadi lagi. Pelanggan memilih dari menu Anda di satu halaman dan membayar langsung ke ${c.into}. Setiap pesanan menampilkan nominal yang tepat dan referensi singkat untuk dibayar, jadi Anda mencocokkan uang yang masuk ke rekening Anda dengan pesanannya, bukan dengan tangkapan layar. Tangkapan layar tidak membuktikan apa pun; pembayaranlah buktinya.\n\n${c.P.t1}\n\nApakah akan membantu jika saya kirimkan tautannya untuk dicoba? Cukup balas, dan saya kirimkan.`,
    t2: (c) => `Halo lagi,\n\nDaripada bertanya dua kali, saya menyiapkan sesuatu yang bisa Anda pakai hari ini: panduan satu halaman terlampir untuk menghentikan bukti transfer palsu. Isinya cara penipuan ini biasanya terjadi, lima pemeriksaan sebelum menyerahkan pesanan, dan bagaimana halaman toko memberi setiap pesanan nominal yang tepat dan referensi pembayaran. Pemeriksaan ini tetap berguna walaupun Anda tidak pernah memakai Tapstall.\n\nKetika Anda ingin uang yang masuk memberi tahu pesanan mana pemiliknya, ini tautannya: ${c.link}\n\nPenyiapannya sekitar dua menit. ${c.P.t2}`,
    t3: (c) => `Ini pesan terakhir dari saya, terima kasih sudah membaca. Jika suatu hari tangkapan layar palsu atau malam-malam mencocokkan pembayaran mulai membuat ${c.biz} kehilangan penjualan, halaman toko Anda bisa siap dalam beberapa menit: ${c.link}\n\nSaya tidak akan menulis lagi.`,
    link: (c) => `Terima kasih sudah membalas. Ini tautannya: ${c.link}\n\nAnda menyiapkan menu sekali, pelanggan memesan dari satu tautan dan membayar ke ${c.into}, dan setiap pesanan menampilkan nominal yang tepat dan referensi, sehingga pembayaran yang masuk memberi tahu pesanan mana pemiliknya. ${c.P.link}\n\nAda pertanyaan, cukup balas di sini.` },
  uk: { shop: 'ваш магазин', and: ' і ', transfers: 'банківський переказ',
    subj: (b) => `${b}: скриншот не є оплатою`,
    ev: { waPay: (b, p) => `Я натрапив на ${b} і побачив, що ви берете замовлення у WhatsApp і приймаєте оплату через ${p}.`, wa: (b) => `Я натрапив на ${b} і побачив, що ви берете замовлення у WhatsApp.`,
      pay: (b, p) => `Я натрапив на ${b} і побачив, що ви приймаєте оплату через ${p}.`, fric: (b) => `Я натрапив на ${b}, коли дивився, як магазини звіряють оплати із замовленнями.`,
      none: (b) => `Я натрапив на ${b} в інтернеті.` },
    into: (w) => (w ? `ваш власний рахунок ${w} або банківський рахунок` : 'вашу власну картку або банківський рахунок'),
    stop: 'Якщо не бажаєте більше отримувати від мене листів, просто дайте відповідь "stop" або "стоп".',
    t1: (c) => `Добрий день, командо ${c.biz}!\n\n${c.ev} Можна запитати про момент, який багато магазинів знають надто добре?\n\nКлієнт надсилає скриншот із написом "оплачено", ви віддаєте замовлення, а гроші так і не надходять. Або за один вечір приходить двадцять оплат, і ви до ночі звіряєте суми з іменами.\n\nЯ створив Tapstall, щоб цей момент більше не траплявся. Клієнти обирають із вашого меню на одній сторінці й платять напряму на ${c.into}. Кожне замовлення показує точну суму та короткий код для оплати, тож ви звіряєте гроші, що надійшли на ваш рахунок, із замовленням, а не зі скриншотом. Скриншот нічого не доводить; доводить оплата.\n\n${c.P.t1}\n\nНадіслати вам посилання, щоб спробувати? Просто дайте відповідь, і я надішлю.`,
    t2: (c) => `Ще раз добрий день,\n\nЗамість того щоб питати вдруге, я підготував те, що ви можете використати вже сьогодні: доданий односторінковий посібник про те, як покласти край фальшивим підтвердженням оплати. У ньому: як зазвичай підробляють оплату, п'ять перевірок перед тим, як віддати замовлення, і як сторінка магазину дає кожному замовленню точну суму та код для оплати. Перевірки корисні, навіть якщо ви ніколи не користуватиметеся Tapstall.\n\nКоли захочете, щоб гроші самі показували, до якого замовлення вони належать, ось посилання: ${c.link}\n\nНалаштування займає близько двох хвилин. ${c.P.t2}`,
    t3: (c) => `Це мій останній лист, дякую, що прочитали. Якщо фальшиві скриншоти чи вечори за звірянням оплат колись почнуть коштувати ${c.biz} продажів, сторінка вашого магазину може запрацювати за кілька хвилин: ${c.link}\n\nБільше не писатиму.`,
    link: (c) => `Дякую за відповідь. Ось посилання: ${c.link}\n\nВи один раз налаштовуєте меню, клієнти замовляють за одним посиланням і платять на ${c.into}, а кожне замовлення показує точну суму й код, тож оплата, що надійшла, сама показує, до якого замовлення вона належить. ${c.P.link}\n\nЯкщо є питання, просто дайте відповідь тут.` },
  vi: { shop: 'cửa hàng của anh chị', and: ' và ', transfers: 'chuyển khoản ngân hàng',
    subj: (b) => `${b}: ảnh chụp màn hình không phải là thanh toán`,
    ev: { waPay: (b, p) => `Tôi biết đến ${b} và thấy cửa hàng nhận đơn qua WhatsApp và nhận thanh toán qua ${p}.`, wa: (b) => `Tôi biết đến ${b} và thấy cửa hàng nhận đơn qua WhatsApp.`,
      pay: (b, p) => `Tôi biết đến ${b} và thấy cửa hàng nhận thanh toán qua ${p}.`, fric: (b) => `Tôi biết đến ${b} khi tìm hiểu cách các cửa hàng đối chiếu thanh toán với đơn hàng.`,
      none: (b) => `Tôi biết đến ${b} trên mạng.` },
    into: (w) => (w ? `tài khoản ${w} hoặc tài khoản ngân hàng của chính anh chị` : 'ví điện tử hoặc tài khoản ngân hàng của chính anh chị'),
    stop: 'Nếu anh chị không muốn nhận thư của tôi nữa, chỉ cần trả lời "stop" hoặc "dừng".',
    t1: (c) => `Xin chào đội ngũ ${c.biz},\n\n${c.ev} Tôi có thể hỏi về một khoảnh khắc mà nhiều cửa hàng đã quá quen thuộc không?\n\nKhách gửi một ảnh chụp màn hình ghi "đã chuyển khoản", anh chị giao hàng, rồi tiền không bao giờ về. Hoặc hai mươi khoản thanh toán đổ về trong một buổi tối và anh chị thức khuya đối chiếu số tiền với tên người gửi.\n\nTôi làm ra Tapstall để khoảnh khắc đó không xảy ra nữa. Khách chọn từ danh mục của anh chị trên một trang duy nhất và thanh toán thẳng vào ${c.into}. Mỗi đơn hàng hiển thị số tiền chính xác và một mã tham chiếu ngắn để thanh toán, nên anh chị đối chiếu tiền về tài khoản với đơn hàng, chứ không phải với ảnh chụp màn hình. Ảnh chụp màn hình không chứng minh điều gì; khoản thanh toán mới là bằng chứng.\n\n${c.P.t1}\n\nAnh chị có muốn tôi gửi đường link để dùng thử không? Chỉ cần trả lời, tôi sẽ gửi.`,
    t2: (c) => `Xin chào lần nữa,\n\nThay vì hỏi lại lần hai, tôi đã chuẩn bị một thứ anh chị có thể dùng ngay hôm nay: bản hướng dẫn một trang đính kèm để chấm dứt bằng chứng thanh toán giả. Hướng dẫn cho biết các vụ gian lận thường diễn ra thế nào, năm bước kiểm tra trước khi giao hàng, và cách một trang cửa hàng gán cho mỗi đơn một số tiền chính xác cùng mã tham chiếu để thanh toán. Các bước kiểm tra vẫn hữu ích ngay cả khi anh chị không bao giờ dùng Tapstall.\n\nKhi anh chị muốn chính khoản tiền về cho biết nó thuộc đơn nào, đây là đường link: ${c.link}\n\nViệc thiết lập mất khoảng hai phút. ${c.P.t2}`,
    t3: (c) => `Đây là thư cuối cùng của tôi, cảm ơn anh chị đã đọc. Nếu một ngày ảnh chụp màn hình giả hay những đêm đối chiếu thanh toán bắt đầu làm ${c.biz} mất doanh số, trang cửa hàng của anh chị có thể sẵn sàng chỉ trong vài phút: ${c.link}\n\nTôi sẽ không viết thư nữa.`,
    link: (c) => `Cảm ơn anh chị đã trả lời. Đây là đường link: ${c.link}\n\nAnh chị thiết lập danh mục một lần, khách đặt hàng từ một đường link và thanh toán vào ${c.into}, mỗi đơn hiển thị số tiền chính xác và mã tham chiếu, nên khoản tiền về cho anh chị biết nó thuộc đơn nào. ${c.P.link}\n\nNếu có câu hỏi, anh chị chỉ cần trả lời tại đây.` },
  ar: { shop: 'متجركم', and: ' و', transfers: 'التحويلات البنكية',
    subj: (b) => `${b}: لقطة الشاشة ليست دفعة`,
    ev: { waPay: (b, p) => `تعرّفت على ${b} ورأيت أنكم تستقبلون الطلبات عبر واتساب وتقبلون الدفع عبر ${p}.`, wa: (b) => `تعرّفت على ${b} ورأيت أنكم تستقبلون الطلبات عبر واتساب.`,
      pay: (b, p) => `تعرّفت على ${b} ورأيت أنكم تقبلون الدفع عبر ${p}.`, fric: (b) => `تعرّفت على ${b} أثناء بحثي في كيفية مطابقة المتاجر للدفعات مع الطلبات.`,
      none: (b) => `تعرّفت على ${b} عبر الإنترنت.` },
    into: (w) => (w ? `حسابكم الخاص على ${w} أو حسابكم البنكي` : 'محفظتكم الإلكترونية أو حسابكم البنكي'),
    stop: 'إذا كنتم تفضّلون عدم تلقي رسائل مني مجددًا، يكفي أن تردّوا بكلمة "stop" أو "توقف".',
    t1: (c) => `مرحبًا فريق ${c.biz}،\n\n${c.ev} هل تسمحون لي بالسؤال عن لحظة يعرفها كثير من التجار جيدًا؟\n\nيرسل العميل لقطة شاشة مكتوبًا عليها "تم الدفع"، فتسلّمونه الطلب، ثم لا يصل المال أبدًا. أو تصلكم عشرون دفعة في مساء واحد فتسهرون لمطابقة المبالغ مع الأسماء.\n\nأنشأت Tapstall حتى لا تتكرر هذه اللحظة. يختار العملاء من قائمتكم في صفحة واحدة ويدفعون مباشرة إلى ${c.into}. يعرض كل طلب المبلغ الدقيق ورمزًا مرجعيًا قصيرًا للدفع، فتطابقون المال الذي يصل إلى حسابكم مع الطلب، لا مع لقطة شاشة. لقطة الشاشة لا تثبت شيئًا؛ الدفعة هي الدليل.\n\n${c.P.t1}\n\nهل يفيدكم أن أرسل لكم الرابط لتجربته؟ يكفي أن تردّوا وسأرسله.`,
    t2: (c) => `مرحبًا مجددًا،\n\nبدلًا من أن أسأل مرتين، أعددت لكم شيئًا يمكنكم استخدامه اليوم: الدليل المرفق في صفحة واحدة لإيقاف إثباتات الدفع المزيفة. يشرح كيف يحدث التزوير عادةً، وخمس خطوات تحقق قبل تسليم أي طلب، وكيف تمنح صفحة المتجر كل طلب مبلغًا دقيقًا ورمزًا مرجعيًا للدفع. خطوات التحقق مفيدة حتى لو لم تستخدموا Tapstall أبدًا.\n\nعندما تريدون أن يدلّكم المال الواصل على الطلب الذي يخصه، هذا هو الرابط: ${c.link}\n\nيستغرق الإعداد نحو دقيقتين. ${c.P.t2}`,
    t3: (c) => `هذه آخر رسالة مني، وشكرًا على القراءة. إذا بدأت لقطات الشاشة المزيفة أو ليالي مطابقة الدفعات تكلّف ${c.biz} مبيعات في يوم من الأيام، يمكن أن تكون صفحة متجركم جاهزة خلال دقائق: ${c.link}\n\nلن أراسلكم مرة أخرى.`,
    link: (c) => `شكرًا على ردكم. هذا هو الرابط: ${c.link}\n\nتُعدّون قائمتكم مرة واحدة، ويطلب العملاء من رابط واحد ويدفعون إلى ${c.into}، ويعرض كل طلب مبلغه الدقيق ورمزًا مرجعيًا، فتعرفون من الدفعة الواصلة الطلب الذي تخصه. ${c.P.link}\n\nلأي سؤال، يكفي الرد هنا.` },
};

/** Everything a template needs, worked out once: language, evidence sentence, wallet, link, signatures. */
export function v2Ctx(lead, { origin, fromName, postal }) {
  const lang = v2Lang(lead.country);
  const L = V2_COPY[lang];
  const biz = String(lead.business || '').trim() || L.shop;
  const seen = v2Seen(lead);
  const pays = [...seen.wallets, ...(seen.transfers ? [L.transfers] : [])];
  const pay = pays.length > 1 ? pays.slice(0, -1).join(', ') + L.and + pays[pays.length - 1] : (pays[0] || '');
  const ev = seen.wa && pay ? L.ev.waPay(biz, pay) : seen.wa ? L.ev.wa(biz) : pay ? L.ev.pay(biz, pay) : seen.friction ? L.ev.fric(biz) : L.ev.none(biz);
  const wallet = seen.wallets[0] || V2_WALLET_CC[String(lead.country || '').toLowerCase()] || '';
  const post = String(postal || '').trim();
  const name = String(fromName || 'Courage');
  return { lang, L, biz, ev, into: L.into(wallet), wallet, link: String(origin || '').replace(/\/+$/, '') + '/onboard', name, P: V2_PRICE[lang],
    sig: `${name}, Tapstall\nJacaranda Labs${post ? '\n' + post : ''}`, sig2: `${name}, Tapstall${post ? '\n' + post : ''}` };
}
/** The pre-rendered guide for a language other than English (pages/public/guides, built by scripts/render_guides.mjs). */
export const V2_GUIDE_BASE = 'https://king-kunta-cpu.github.io/tapstall/guides';
export const v2GuideFile = (lang) => 'fake-proof-of-payment-' + lang + '.pdf';

/** The English T2 attachment (owner 2026-11-04): a one-page guide made for this shop (mailPdf is ASCII/Helvetica, so
 *  only English is built here; other languages attach the pre-rendered guide). General, checkable advice; no invented numbers. */
export function v2Guide(lead, { origin, postal }) {
  const c = v2Ctx({ ...lead, country: lead.country && v2Lang(lead.country) === 'en' ? lead.country : '' }, { origin, postal });
  const biz = c.biz;
  const day = new Date().toISOString().slice(0, 10);
  const slug = biz.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'shop';
  return { filename: 'tapstall-guide-' + slug + '.pdf', content: mailPdf({
    title: biz + ': ending fake proof of payment',
    subtitle: 'A one-page guide made for ' + biz + ', ' + day + '. From Tapstall, a Jacaranda Labs venture.',
    accent: '#0b6e4f',
    sections: [
      { heading: 'How fake proof of payment happens', bullets: [
        'An edited or recycled screenshot of a payment that never reached your account.',
        'A forwarded or typed-out "payment SMS" that did not come from your provider.',
        'A real payment for a smaller amount, or one already used for another order.',
        'Twenty payments landing in an hour, and no quick way to tell which one is whose.' ] },
      { heading: 'Five checks before you hand over goods', bullets: [
        'Check your own account, or the message your provider sent you; never only the customer\'s screenshot.',
        'Match the exact amount.',
        'Match the sender name or reference, and the time.',
        'A payment you cannot find yet is not received, however urgent the customer sounds.',
        'Mark each payment as used for one order, so it cannot be claimed twice.' ] },
      { heading: 'How Tapstall makes the money tell you', paras: [
        'Customers order from your menu on one page and pay straight into ' + c.into + '; Tapstall never holds your money. Each order shows the exact amount and a short reference to pay, so you match the money that lands in your account to the order, not to a screenshot. A screenshot proves nothing; the payment does.' ] },
      { heading: 'Set up in about two minutes', bullets: [
        'Add your menu: names and prices.',
        'Add the account your customers pay into.',
        'Share your one link on your WhatsApp status, your bio and your groups.' ],
        paras: [] },
      { paras: [c.P.link + ' Start here: ' + c.link] },
    ],
    footer: 'Tapstall, Jacaranda Labs' + (postal ? ' - ' + String(postal).trim() : ''),
  }) };
}

/** touch 0 = T1 (no link), 1 = T2 day 7 (the link + the guide), 2 = T3 day 14 (last note). kind 'link' = the answer to a reply.
 *  `guide` = the pre-rendered PDF for a language other than English; without it a T2 comes back with `missing: 'guide'`
 *  and the sender skips the lead this tick (T2 never goes out without its attachment). */
export function v2Compose(lead, { origin, fromName, postal, kind, guide }) {
  const c = v2Ctx(lead, { origin, fromName, postal });
  const L = c.L;
  const subj1 = L.subj(c.biz);
  const re = (x) => 'Re: ' + x;
  if (kind === 'link') return { lang: c.lang, subject: re(subj1), text: L.link(c) + `\n\n${c.name}, Tapstall` };
  const touch = Math.max(0, Math.min(Number(lead.touches) || 0, V2_MAX_TOUCHES - 1));
  if (touch === 0) return { lang: c.lang, subject: subj1, text: `${L.t1(c)}\n\n${c.sig}\n\n${L.stop}` };
  if (touch === 1) {
    const att = c.lang === 'en' ? v2Guide(lead, { origin, postal }) : (guide && guide.content ? guide : null);
    return { lang: c.lang, subject: re(subj1), text: `${L.t2(c)}\n\n${c.sig2}\n\n${L.stop}`, attachments: att ? [att] : [], ...(att ? {} : { missing: 'guide' }) };
  }
  return { lang: c.lang, subject: re(subj1), text: `${L.t3(c)}\n\n${c.sig2}` };
}
