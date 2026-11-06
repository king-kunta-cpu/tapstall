// Press v3 (playbook/PRESS-V3.md): a company lesson is written in each platform's own shape; a shop's words are left alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../worker/core.js';

const line = 'Before you mark anything paid, search the amount first and the name second. Names repeat; exact amounts do not.';
const beat = (rail, extra) => ({ kind: 'value', pillar: 'exact-amount', item_key: 'company:exact-amount:1', text: line, rail, to: [rail], ...(extra || {}) });

test('press v3: each platform gets its own hashtag count, Pinterest gets none and a keyword pin title', () => {
  const now = Date.parse('2026-11-05T08:00:00Z');
  const bs = C.meshQueueItem(beat('bluesky'), { now });
  assert.equal((bs.text.match(/#\w+/g) || []).length, 2);
  assert.ok(bs.text.length <= 300);
  assert.ok(bs.text.endsWith('#FraudPrevention #MobileMoney'));
  assert.deepEqual(bs.tags, ['fraudprevention', 'mobilemoney', 'smallbusiness', 'whatsappbusiness', 'scamalert']);
  const li = C.meshQueueItem(beat('linkedin'), { now });
  assert.equal((li.text.match(/#\w+/g) || []).length, 4);
  const pin = C.meshQueueItem(beat('pinterest', { text: line + ' #EcoCash' }), { now, board: 'b1' });
  assert.ok(!/#\w/.test(pin.text), pin.text);
  assert.equal(pin.pin_title, 'How to spot a fake proof of payment on WhatsApp');
  assert.ok(pin.pin_title.toLowerCase().includes(C.CONTENT_SEO['exact-amount'].keyphrase));
});

test('press v3: a shop\'s own post is left exactly as the shop wrote it', () => {
  const shop = C.meshQueueItem({ kind: 'value', pillar: 'menu-craft', item_key: 'words:sadza', text: 'Sadza and beef: slow-cooked, served hot.', rail: 'bluesky', to: ['bluesky'] }, { now: Date.parse('2026-11-05T08:00:00Z') });
  assert.equal(shop.text, 'Sadza and beef: slow-cooked, served hot.');
  assert.equal(shop.tags, undefined);
});

test('press v3: hashtags are dropped before the lesson is ever cut', () => {
  const long = 'x'.repeat(290);
  assert.equal(C.contentNative(long, 'books', 'bluesky'), long);
  assert.equal(C.contentNative(line, 'unknown-pillar', 'bluesky'), line);
});

test('press v3: the Bluesky record has clickable hashtags and links, a language and hidden tags', async () => {
  const now = Date.parse('2026-11-05T08:30:00Z');
  const it = { ...C.meshQueueItem(beat('bluesky', { text: 'Read https://tapstall.zlnew.workers.dev/guide first. ' + line }), { now: now - 3600e3 }), due: new Date(now - 60e3).toISOString(), image: '', video: '' };
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, body: init && init.body });
    if (url.endsWith('createSession')) return { status: 200, json: async () => ({ accessJwt: 'j', did: 'did:plc:x' }) };
    if (url.endsWith('uploadBlob')) return { status: 200, json: async () => ({ blob: { ref: 'b' } }) };
    if (url.endsWith('createRecord')) return { status: 200, json: async () => ({ uri: 'at://x/app.bsky.feed.post/1' }) };
    return { status: 200, arrayBuffer: async () => new ArrayBuffer(4), text: async () => 'png' };
  };
  const out = await C.meshPressFlush([it], { direct: { bluesky: { handle: 'tapstall.bsky.social', app_password: 'p' } } }, { now, fetch: fetcher });
  assert.equal(out.sent, 1, JSON.stringify(out.results));
  const rec = JSON.parse(calls.find((c) => c.url.endsWith('createRecord')).body).record;
  assert.deepEqual(rec.langs, ['en']);
  assert.ok(rec.tags.length && rec.tags.length <= 8);
  const enc = new TextEncoder(), dec = new TextDecoder();
  const spans = rec.facets.map((f) => [f.features[0].$type.split('#')[1], dec.decode(enc.encode(rec.text).slice(f.index.byteStart, f.index.byteEnd))]);
  assert.deepEqual(spans, [['link', 'https://tapstall.zlnew.workers.dev/guide'], ['tag', '#FraudPrevention'], ['tag', '#MobileMoney']]);
});
