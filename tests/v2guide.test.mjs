// Owner 2026-11-04: T1 has no link or attachment; T2 (day 7) carries a one-page PDF guide made for the shop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v2Compose, buildMail } from '../worker/mail.js';

const lead = { business: 'Kota Queen', signals: ['whatsapp_selling'], touches: 0 };
const opt = { origin: 'https://tapstall.example', fromName: 'Courage', postal: 'Jacaranda Labs, P.O. Box 900, Bulawayo, Zimbabwe' };

test('T1: emotional, link-free, no attachment', () => {
  const m = v2Compose(lead, opt);
  assert.equal(m.attachments, undefined);
  assert.doesNotMatch(m.text, /https?:\/\//);
  assert.match(m.text, /screenshot that says "paid"/);
  assert.match(m.text, /Just reply and I will/);
});

test('T2: the guide PDF is attached, the copy says so, and the mail is multipart/mixed', () => {
  const m = v2Compose({ ...lead, touches: 1 }, opt);
  assert.equal(m.attachments.length, 1);
  const a = m.attachments[0];
  assert.equal(a.filename, 'tapstall-guide-kota-queen.pdf');
  const pdf = Buffer.from(a.content).toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.4'));
  assert.match(pdf, /Kota Queen: ending fake proof of payment/);
  assert.match(pdf, /Five checks before you hand over goods/);
  assert.match(pdf, /https:\/\/tapstall\.example\/onboard/);
  assert.match(m.text, /attached one-page guide/);
  const mime = buildMail({ from: 'a@gmail.com', to: 'shop@kq.co.zw', subject: m.subject, text: m.text, attachments: m.attachments, messageId: '<x@y>' });
  assert.match(mime, /Content-Type: multipart\/mixed; boundary="jl[a-z0-9]+"/);
  assert.match(mime, /filename="tapstall-guide-kota-queen\.pdf"/);
  assert.ok(mime.indexOf('text/plain') < mime.indexOf('application/pdf'));
});

test('T3 and the link answer carry no attachment', () => {
  assert.equal(v2Compose({ ...lead, touches: 2 }, opt).attachments, undefined);
  assert.equal(v2Compose(lead, { ...opt, kind: 'link' }).attachments, undefined);
});
