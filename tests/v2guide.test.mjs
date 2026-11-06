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

// 2026-11-06 build step 4: nine languages, picked by country; the wallet the site names; no claim the product can't keep.
import { V2_COPY, V2_LANGS, v2Lang, v2Ctx } from '../worker/mail.js';
const CC = { en: 'ke', es: 'pe', pt: 'ao', fr: 'sn', ar: 'eg', tr: 'tr', id: 'id', uk: 'ua', vi: 'vn' };

test('every language: T1 link-free with the stop line; T2/T3/link carry the link; no placeholders, em dashes or cents', () => {
  assert.deepEqual(Object.keys(V2_COPY).sort(), [...V2_LANGS].sort());
  for (const lang of V2_LANGS) {
    const l = { business: 'Casa Nova', country: CC[lang].toUpperCase(), signals: ['payment_friction'], note: 'Site: orders over WhatsApp; mentions momo; takes bank transfers', touches: 0 };
    assert.equal(v2Lang(l.country), lang);
    const t1 = v2Compose(l, opt);
    assert.equal(t1.lang, lang);
    assert.doesNotMatch(t1.text, /https?:\/\/|\/onboard/, lang);
    assert.ok(t1.text.includes(V2_COPY[lang].stop), lang + ' stop line');
    assert.ok(t1.text.includes('Casa Nova') && t1.subject.includes('Casa Nova'), lang);
    assert.ok(t1.text.includes('MoMo'), lang + ': the wallet the site names');
    assert.ok(t1.text.includes('P.O. Box 900, Bulawayo'), lang + ': postal address');
    const t2 = v2Compose({ ...l, touches: 1 }, { ...opt, guide: { filename: 'g.pdf', content: new Uint8Array([37, 80, 68, 70]) } });
    const t3 = v2Compose({ ...l, touches: 2 }, opt), lk = v2Compose(l, { ...opt, kind: 'link' });
    for (const m of [t2, t3, lk]) { assert.match(m.text, /https:\/\/tapstall\.example\/onboard/, lang); assert.ok(m.subject.startsWith('Re: '), lang); }
    assert.equal(t2.attachments.length, 1, lang);
    for (const m of [t1, t2, t3, lk]) {
      assert.doesNotMatch(m.text + m.subject, /\u2014|undefined|\$\{|\[object|null/, lang);
      assert.doesNotMatch(m.text, /\bcent(?:s|avo|imo)?\b|kuruş|\bsen\b|копій/i, lang + ': no cents claim');
    }
  }
});

test('a T2 in a language other than English never goes out without its guide; English builds its own', () => {
  const pe = { business: 'Panaderia Rosa', country: 'PE', touches: 1, signals: ['whatsapp_selling'] };
  const m = v2Compose(pe, opt);
  assert.equal(m.missing, 'guide');
  assert.equal(m.attachments.length, 0);
  const en = v2Compose({ business: 'Mama Duka', country: 'KE', touches: 1 }, opt);
  assert.equal(en.missing, undefined);
  const pdf = Buffer.from(en.attachments[0].content).toString('latin1');
  assert.match(pdf, /M-Pesa or bank account/, 'the country\'s wallet, not EcoCash');
  assert.doesNotMatch(pdf, /cents included|down to the cent|EcoCash/);
});

test('wallet and evidence: the site first, then the country, then a neutral phrase', () => {
  assert.equal(v2Ctx({ country: 'PE', note: 'Site: mentions plin, yape' }, opt).wallet, 'Plin');
  assert.equal(v2Ctx({ country: 'PE' }, opt).wallet, 'Yape');
  assert.equal(v2Ctx({ country: 'TR' }, opt).into, 'kendi banka hesabınıza veya mobil cüzdanınıza');
  assert.equal(v2Ctx({ country: 'ZW', signals: ['whatsapp_selling'], business: 'Kota Queen' }, opt).ev, 'I came across Kota Queen taking orders on WhatsApp.');
  assert.equal(v2Ctx({ country: 'EG', note: 'Site: mentions instapay; takes bank transfers', business: 'X' }, opt).ev, 'تعرّفت على X ورأيت أنكم تقبلون الدفع عبر InstaPay والتحويلات البنكية.');
  assert.equal(v2Ctx({ country: '' }, opt).lang, 'en');
});

test('every outreach language has its pre-rendered one-page guide on the Pages mirror', async () => {
  const { readFileSync } = await import('node:fs');
  const { v2GuideFile } = await import('../worker/mail.js');
  for (const lang of V2_LANGS) {
    const b = readFileSync(new URL('../pages/public/guides/' + v2GuideFile(lang), import.meta.url));
    assert.equal(b.subarray(0, 5).toString('latin1'), '%PDF-', lang);
    assert.ok(b.length > 2000 && b.length < 2e6, lang + ' size ' + b.length);
    assert.equal((b.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length, 1, lang + ': one page');
  }
});
