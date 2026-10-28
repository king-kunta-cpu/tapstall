// v2.0.0 worker/mail.js: the SMTP dialogue over a scripted socket, MIME, lanes and budget.
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
  const { conn, wrote } = scripted(['220 hi\r\n', '250-mail.inbox.lv\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n', '235 ok\r\n',
    '250 ok\r\n', '250 ok\r\n', '354 go\r\n', '250 queued\r\n', '221 bye\r\n']);
  const s = await M.smtpSession(conn, { user: 'a@inbox.lv', pass: 'p' });
  await s.send('a@inbox.lv', 'b@shop.co.zw', 'Subject: x\r\n\r\n.leading dot\r\nok');
  await s.quit();
  const all = wrote.join('');
  assert.match(all, /AUTH PLAIN /);
  assert.match(all, /MAIL FROM:<a@inbox\.lv> BODY=8BITMIME/);
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
  const m = M.buildMail({ from: 'a@inbox.lv', fromName: 'Tapstall', to: 'b@shop.co.zw', subject: 'Hi\r\nBcc: evil@x.com — café',
    text: 'body', unsubscribe: { url: 'https://t.example/u/1/abc' }, messageId: '<1@t>' });
  assert.doesNotMatch(m, /^Bcc:/m, 'a newline in a subject is not a new header');
  assert.match(m, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(m, /^List-Unsubscribe: <https:\/\/t\.example\/u\/1\/abc>/m);
  assert.match(m, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);
  assert.throws(() => M.buildMail({ from: 'a@inbox.lv', to: 'not an address', subject: 's', text: 't' }));
});

test('lanes: nothing armed is a quiet no-op; transactional keeps a slot outreach cannot take', async () => {
  const env0 = { STORES: kv(), ORDERS: kv() };
  assert.deepEqual(await M.mailSend(env0, { to: 'a@b.co', subject: 's', text: 't' }), { sent: false, why: 'no_lane' });
  const sent = [];
  const env = { STORES: kv(), ORDERS: kv(), MAILBOXES: JSON.stringify([{ id: 'zz9', hourly: 2 }]), MAILBOX_ZZ9_USER: 'x@inbox.lv', MAILBOX_ZZ9_PASS: 'p',
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
  const env = { STORES: kv(), ORDERS: kv(), MAILBOXES: JSON.stringify([{ id: 'xx7', hourly: 5 }]), MAILBOX_XX7_USER: 'x@inbox.lv', MAILBOX_XX7_PASS: 'p',
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
  const env = { STORES: kv(), ORDERS: kv(), MAILBOXES: JSON.stringify([{ id: 'yy8', hourly: 5 }]), MAILBOX_YY8_USER: 'x@inbox.lv', MAILBOX_YY8_PASS: 'p',
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
