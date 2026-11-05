// v2.0.0 worker/mail.js: the SMTP dialogue over a scripted socket, MIME, lanes and budget.
import './fixtures/clock.mjs'; // first: a steady clock, see the file
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../worker/mail.js';

function scripted(replies) {
  const wrote = [];
  const enc = new TextEncoder();
  let i = 0;
  const readable = new ReadableStream({ pull(c) { if (i < replies.length) c.enqueue(enc.encode(replies[i++])); else c.close(); } });
  const writable = new WritableStream({ write(chunk) { wrote.push(new TextDecoder().decode(chunk)); } });
  return { conn: M.mailConn(readable, writable, 2000), wrote };
}
function kv() {
  const m = new Map();
  return { _m: m, async get(k, t) { const v = m.get(k); return v == null ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; } };
}

test('smtp: EHLO, AUTH PLAIN, MAIL/RCPT/DATA with dot-stuffing', async () => {
  const { conn, wrote } = scripted(['220 hi\r\n', '250-smtp.gmail.com\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n', '235 ok\r\n',
    '250 ok\r\n', '250 ok\r\n', '354 go\r\n', '250 queued\r\n', '221 bye\r\n']);
  const s = await M.smtpSession(conn, { user: 'a@gmail.com', pass: 'p' });
  await s.send('a@gmail.com', 'b@shop.co.zw', 'Subject: x\r\n\r\n.leading dot\r\nok');
  await s.quit();
  const all = wrote.join('');
  assert.match(all, /AUTH PLAIN /);
  assert.match(all, /MAIL FROM:<a@gmail\.com> BODY=8BITMIME/);
  assert.match(all, /RCPT TO:<b@shop\.co\.zw>/);
  assert.match(all, /\r\n\.\.leading dot\r\n/, 'a line starting with a dot is stuffed');
  assert.match(all, /\r\n\.\r\n/);
});

test('smtp: a 535 is an auth failure, a 550 at RCPT is permanent', async () => {
  const a = scripted(['220 hi\r\n', '250 AUTH PLAIN\r\n', '535 bad\r\n']);
  await assert.rejects(M.smtpSession(a.conn, { user: 'u', pass: 'p' }), (e) => e.authFail === true);
  const b = scripted(['220 hi\r\n', '250 AUTH PLAIN\r\n', '235 ok\r\n', '250 ok\r\n', '550 no such user\r\n', '250 reset\r\n']);
  const s = await M.smtpSession(b.conn, { user: 'u', pass: 'p' });
  await assert.rejects(s.send('u@x.lv', 'gone@x.com', 'x'), (e) => e.permanent === true && e.stage === 'rcpt');
});

test('mime: headers cannot be injected, UTF-8 subjects are encoded, unsubscribe is RFC 8058', () => {
  const m = M.buildMail({ from: 'a@gmail.com', fromName: 'Tapstall', to: 'b@shop.co.zw', subject: 'Hi\r\nBcc: evil@x.com — café',
    text: 'body', unsubscribe: { url: 'https://t.example/u/1/abc' }, messageId: '<1@t>' });
  assert.doesNotMatch(m, /^Bcc:/m, 'a newline in a subject is not a new header');
  assert.match(m, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(m, /^List-Unsubscribe: <https:\/\/t\.example\/u\/1\/abc>/m);
  assert.match(m, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);
  assert.throws(() => M.buildMail({ from: 'a@gmail.com', to: 'not an address', subject: 's', text: 't' }));
});

test('lanes: nothing armed is a quiet no-op; transactional keeps a slot outreach cannot take', async () => {
  const env0 = { STORES: kv(), ORDERS: kv() };
  assert.deepEqual(await M.mailSend(env0, { to: 'a@b.co', subject: 's', text: 't' }), { sent: false, why: 'no_lane' });
  const sent = [];
  const env = { STORES: kv(), ORDERS: kv(), MAILBOXES: JSON.stringify([{ id: 'zz9', hourly: 2 }]), MAILBOX_ZZ9_USER: 'x@gmail.com', MAILBOX_ZZ9_PASS: 'p',
    MAIL_TEST_OPEN: async () => ({ async send(f, t, mime) { sent.push(t); return 'ok'; }, async quit() {} }) };
  const now = Date.UTC(2031, 0, 1, 10, 5);
  assert.equal((await M.mailSend(env, { to: 'a@b.co', subject: 's', text: 't', kind: 'outreach' }, { now })).sent, true);
  assert.equal((await M.mailSend(env, { to: 'c@d.co', subject: 's', text: 't', kind: 'outreach' }, { now })).why, 'lanes_full', 'outreach stops at hourly-1');
  assert.equal((await M.mailSend(env, { to: 'e@f.co', subject: 's', text: 't' }, { now })).sent, true, 'the held slot is for a merchant');
  assert.equal((await M.mailSend(env, { to: 'g@h.co', subject: 's', text: 't' }, { now })).why, 'lanes_full');
  assert.equal(env.STORES._m.get('mail:h:zz9:2031-01-01T10'), '2');
  assert.equal((await M.mailSend(env, { to: 'not-an-address', subject: 's', text: 't' }, { now })).permanent, true);
});

test('drain: an empty queue costs one read and no list; a queued message sets the flag the tick reads', async () => {
  const env = { STORES: kv(), ORDERS: kv(), MAILBOXES: JSON.stringify([{ id: 'xx7', hourly: 5 }]), MAILBOX_XX7_USER: 'x@gmail.com', MAILBOX_XX7_PASS: 'p',
    MAIL_TEST_OPEN: async () => { throw new Error('greeting 421: busy'); } };
  let lists = 0; const list0 = env.ORDERS.list; env.ORDERS.list = async (a) => { lists++; return list0(a); };
  const idle = await M.mailDrain(env, 3);
  assert.equal(idle.idle, true); assert.equal(lists, 0, 'no flag, no list');
  assert.equal((await M.mailDeliver(env, { to: 'a@b.co', subject: 's', text: 't' })).queued, true);
  assert.ok(env.ORDERS._m.get('mailflag:queued'), 'enqueue sets the flag');
  await M.mailDrain(env, 3); assert.equal(lists, 1, 'the flag earns a list');
  assert.ok(env.ORDERS._m.get('mailflag:queued'), 'mail still parked, flag stays');
  env.MAIL_TEST_OPEN = async () => ({ async send() { return 'ok'; }, async quit() {} });
  await env.STORES.delete('mail:lane:xx7');
  const d = await M.mailDrain(env, 3);
  assert.equal(d.sent, 1); assert.equal(env.ORDERS._m.get('mailflag:queued'), undefined, 'an emptied queue clears the flag');
  env.ORDERS._m.set('mailq:zz', JSON.stringify({ to: 'c@d.co', subject: 's', text: 't', tries: 1 }));   // a message whose flag was lost
  assert.equal((await M.mailDrain(env, 3)).idle, true);
  assert.equal((await M.mailDrain(env, 3, { full: true })).sent, 1, 'the nightly full drain finds it anyway');
});

test('lanes: a busy hour parks transactional mail, the drain sends it later; a 535 parks the lane', async () => {
  let fail = 'busy';
  const env = { STORES: kv(), ORDERS: kv(), MAILBOXES: JSON.stringify([{ id: 'yy8', hourly: 5 }]), MAILBOX_YY8_USER: 'x@gmail.com', MAILBOX_YY8_PASS: 'p',
    MAIL_TEST_OPEN: async () => { if (fail === 'busy') { const e = new Error('greeting 421: busy'); throw e; }
      if (fail === 'auth') { const e = new Error('auth 535'); e.authFail = true; throw e; }
      return { async send() { return 'ok'; }, async quit() {} }; } };
  const r = await M.mailDeliver(env, { to: 'a@b.co', subject: 's', text: 't' });
  assert.equal(r.queued, true, JSON.stringify(r));
  await env.STORES.delete('mail:lane:yy8');          // the cooldown passes
  fail = '';
  const d = await M.mailDrain(env, 4);
  assert.equal(d.sent, 1, JSON.stringify(d));
  assert.equal([...env.ORDERS._m.keys()].filter((k) => k.startsWith('mailq:')).length, 0);
  fail = 'auth';
  await M.mailSend(env, { to: 'a@b.co', subject: 's', text: 't' });
  const stt = (await M.mailStatus(env)).lanes[0].state;
  assert.ok(stt.auth_failed && Date.parse(stt.cooldown_until) > Date.now() + 5 * 3600e3, 'a wrong password parks the lane for hours instead of hammering it');
  assert.equal((await M.mailSend(env, { to: 'a@b.co', subject: 's', text: 't' })).why, 'lanes_full');
  await M.mailResume(env);
  assert.equal((await M.mailStatus(env)).lanes[0].state.cooldown_until, undefined);
});

test('mx: NXDOMAIN and null MX are undeliverable, a resolver failure is not a verdict', async () => {
  const ans = (j) => async () => new Response(JSON.stringify(j));
  assert.equal(await M.mxOk('nx-test-1.co.zw', ans({ Status: 3 })), false);
  assert.equal(await M.mxOk('nullmx-test.co.zw', ans({ Status: 0, Answer: [{ type: 15, data: '0 .' }] })), false);
  assert.equal(await M.mxOk('good-test.co.zw', ans({ Status: 0, Answer: [{ type: 15, data: '10 mx.good-test.co.zw.' }] })), true);
  assert.equal(await M.mxOk('flaky-test.co.zw', async () => { throw new Error('down'); }), true);
});

test('v2.2.0 gmail lane: provider preset, runner secret names, app-password spaces, rolling-day clamp', () => {
  const [l] = M.mailLanes({ MAILBOXES: JSON.stringify([{ id: 'owner', provider: 'gmail', hourly: 60 }]),
    GMAIL_OWNER_USER: 'Shop.Box@gmail.com', GMAIL_OWNER_APP_PASSWORD: 'abcd efgh ijkl mnop' });
  assert.equal(l.host, 'smtp.gmail.com');
  assert.equal(l.imapHost, 'imap.gmail.com');
  assert.equal(l.port, 465);
  assert.equal(l.pass, 'abcdefghijklmnop', 'the display spaces Google shows are stripped');
  assert.equal(l.hourly, M.MAIL_PROVIDERS.gmail.hourlyMax, 'clamped');
  assert.ok(l.hourly * 24 < 500, "no rolling 24 h can reach Google's ~500");
  const [d] = M.mailLanes({ MAILBOXES: '[{"id":"gm1"}]', MAILBOX_GM1_USER: 'a@gmail.com', MAILBOX_GM1_PASS: 'p' });
  assert.equal(d.host, 'smtp.gmail.com', 'no host = gmail; MAILBOX_<ID>_* names still work');
  assert.equal(d.hourly, 6, 'default 6/hour leaves room for the runner');
  assert.equal(M.mailLanes({ MAILBOXES: '[{"id":"owner","provider":"gmail"}]', GMAIL_OWNER_USER: 'a@gmail.com' }).length, 0, 'off until both secrets exist');
});

test('2026-11-04 outreach v2: the owner lane keeps merchant mail only; gm1 + gm2 take outreach, pinned per lead, threaded', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../scripts/gen_wrangler_toml.py', import.meta.url), 'utf8');
  const mb = /os\.environ\.get\("MAILBOXES", ""\)\.strip\(\) or \('([^']+)'\s*'([^']+)'\)/.exec(src);
  assert.ok(mb, 'default MAILBOXES');
  assert.match(src, /os\.environ\.get\("OUTREACH_LV", ""\)\.strip\(\) or "on"/);
  const env = { MAILBOXES: mb[1] + mb[2], GMAIL_OWNER_USER: 'box@gmail.com', GMAIL_OWNER_APP_PASSWORD: 'abcdabcdabcdabcd',
    MAILBOX_GM1_USER: 'one@gmail.com', MAILBOX_GM1_PASS: 'p1', MAILBOX_GM2_USER: 'two@gmail.com', MAILBOX_GM2_PASS: 'p2', ORDERS: kv(), STORES: kv() };
  const lanes = M.mailLanes(env);
  assert.deepEqual(lanes.map((l) => [l.id, l.outreach]), [['owner', false], ['gm1', true], ['gm2', true]]);
  const sent = [];
  env.MAIL_TEST_OPEN = async (l) => ({ async send(from, to, mime) { sent.push({ from, to, mime }); }, async quit() {} });
  const now = Date.parse('2026-11-05T09:00:00Z');
  const r = await M.mailSend(env, { to: 'a@shop.co.zw', subject: 'Re: s', text: 't', kind: 'outreach', laneUser: 'two@gmail.com', inReplyTo: '<m1@tapstall.mail>' }, { now });
  assert.equal(r.sent, true);
  assert.equal(r.user, 'two@gmail.com', 'pinned to the lead\'s box');
  assert.match(r.messageId, /^<.+@tapstall\.mail>$/);
  assert.match(sent[0].mime, /In-Reply-To: <m1@tapstall\.mail>\r\nReferences: <m1@tapstall\.mail>/);
  assert.equal((await M.mailSend(env, { to: 'b@shop.co.zw', subject: 's', text: 't', kind: 'outreach', laneUser: 'box@gmail.com' }, { now })).why, 'lanes_full', 'the owner lane never takes outreach');
});

test('outreach v2: T1 has no links, T2/T3/link carry it; ramp 10/25/50; brake; one box per address; spread over the day', async () => {
  const O = M;
  const lead = { business: 'Kota Queen', signals: ['whatsapp_selling'], touches: 0 };
  const o = { origin: 'https://tapstall.example', fromName: 'Courage', postal: 'Jacaranda Labs, P.O. Box 900, Bulawayo, Zimbabwe' };
  const t1 = O.v2Compose(lead, o);
  assert.doesNotMatch(t1.text, /https?:\/\/|www\.|\/onboard/);
  assert.match(t1.text, /reply "stop"/);
  assert.match(t1.text, /P\.O\. Box 900, Bulawayo/);
  assert.match(t1.text, /Just reply and I will/);
  const t2 = O.v2Compose({ ...lead, touches: 1 }, o), t3 = O.v2Compose({ ...lead, touches: 2 }, o), lk = O.v2Compose({ ...lead, touches: 1 }, { ...o, kind: 'link' });
  for (const m of [t2, t3, lk]) { assert.match(m.text, /https:\/\/tapstall\.example\/onboard/); assert.match(m.subject, /^Re: Kota Queen:/); }
  assert.match(t3.text, /I will not write again/);
  for (const m of [t1, t2, t3, lk]) assert.doesNotMatch(m.text + m.subject, /\u2014/);
  assert.deepEqual([O.v2Ramp(Date.parse('2026-11-04T12:00Z')), O.v2Ramp(Date.parse('2026-11-05T12:00Z')), O.v2Ramp(Date.parse('2026-11-12T12:00Z')), O.v2Ramp(Date.parse('2026-11-19T12:00Z'))], [0, 10, 25, 50]);
  assert.equal(O.v2Brake({ sent: 19, bounced: 5 }), '');
  assert.equal(O.v2Brake({ sent: 40, bounced: 20 }), ''); // owner 2026-11-04: a wrong address is not a failure
  assert.match(O.v2Brake({ sent: 40, stops: 2 }), /stops/);
  assert.equal(O.v2Brake({ sent: 40, bounced: 2, stops: 1 }), '');
  assert.equal(O.v2BoxIndex('A@b.co', 2), O.v2BoxIndex('a@B.co', 2));
  assert.equal(new Set(['a@x.zw', 'b@x.zw', 'c@x.zw', 'd@x.zw', 'e@x.zw', 'f@x.zw'].map((e) => O.v2BoxIndex(e, 2))).size, 2);
  assert.equal(O.v2PerTick(50, 7, 16), 5, '50 over ten hourly ticks');
  assert.equal(O.v2PerTick(10, 7, 16), 1);
  assert.equal(O.v2PerTick(0, 9, 16), 0);
  assert.ok(O.v2PerTick(50, 16, 16) <= 6, 'never a burst');
});
