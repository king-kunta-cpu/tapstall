// 2026-11-06: Mastodon, Discord, Tumblr from the Worker; Buffer publishes (createPost) instead of drafting.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../worker/core.js';

const now = Date.parse('2026-11-06T10:00:00Z');
const item = (channel, extra) => ({ id: 'company:exact-amount:1-20398', channel, via: channel === 'pinterest' ? 'buffer' : 'direct',
  due: new Date(now - 60e3).toISOString(), text: 'A screenshot is not money.\n\n#FraudPrevention #MobileMoney', image: 'https://x.test/c.png',
  alt: 'card', pin_title: 'How to spot a fake proof of payment on WhatsApp', tags: ['fake proof of payment', 'mobile money'], ...(extra || {}) });

test('mastodon: uploads the card, then posts the status with its media id', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://x.test/c.png') return { status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => new ArrayBuffer(8) };
    if (url.endsWith('/api/v2/media')) return { status: 200, json: async () => ({ id: 'm1' }) };
    if (url.endsWith('/api/v1/statuses')) return { status: 200, json: async () => ({ id: 's1' }) };
    return { status: 404, json: async () => ({}) };
  };
  const out = await C.meshPressFlush([item('mastodon')], { direct: { mastodon: { token: 't', instance: 'mastodon.social' } } }, { now, fetch: fetcher });
  assert.equal(out.sent, 1, JSON.stringify(out.results));
  const st = calls.find((c) => c.url === 'https://mastodon.social/api/v1/statuses');
  const body = JSON.parse(st.init.body);
  assert.deepEqual(body.media_ids, ['m1']);
  assert.equal(body.visibility, 'public');
  assert.equal(st.init.headers.authorization, 'Bearer t');
});

test('mastodon: a refused status is failed, never sent', async () => {
  const fetcher = async (url) => (url.endsWith('/api/v1/statuses') ? { status: 422, json: async () => ({ error: 'x' }) } : { status: 500 });
  const out = await C.meshPressFlush([item('mastodon', { image: '' })], { direct: { mastodon: { token: 't' } } }, { now, fetch: fetcher });
  assert.equal(out.sent, 0);
  assert.equal(out.results[0].status, 'failed');
});

test('discord: webhook with wait=true, the card as an embed, no mentions, a browser user agent', async () => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return { status: 200, json: async () => ({ id: 'd1' }) }; };
  const out = await C.meshPressFlush([item('discord')], { direct: { discord: { webhook: 'https://discord.com/api/webhooks/1/abc' } } }, { now, fetch: fetcher });
  assert.equal(out.sent, 1, JSON.stringify(out.results));
  assert.equal(calls[0].url, 'https://discord.com/api/webhooks/1/abc?wait=true');
  const b = JSON.parse(calls[0].init.body);
  assert.deepEqual(b.allowed_mentions, { parse: [] });
  assert.equal(b.embeds[0].image.url, 'https://x.test/c.png');
  assert.match(calls[0].init.headers['user-agent'], /^Mozilla\/5\.0/);
});

test('discord: a secret that is not a webhook URL is refused before any call', async () => {
  let called = 0;
  const out = await C.meshPressFlush([item('discord')], { direct: { discord: { webhook: 'https://evil.test/x' } } }, { now, fetch: async () => { called++; return { status: 200 }; } });
  assert.equal(called, 0);
  assert.equal(out.results[0].status, 'failed');
});

test('tumblr: OAuth 1.0a signature matches the published HMAC-SHA1 reference', async () => {
  // Twitter's documented OAuth 1.0a example (form fields are part of the base string).
  const h = await C.oauth1Header('POST', 'https://api.twitter.com/1.1/statuses/update.json',
    { include_entities: 'true', status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
    { consumer_key: 'xvz1evFS4wEEPTGEFPHBog', consumer_secret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
      token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', token_secret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE' },
    1318622958 * 1000, 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg');
  assert.match(h, /oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"/);
});

test('tumblr: a titled text post with the card, tags, and an OAuth header; armed only with all four keys', async () => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return { status: 201, json: async () => ({ response: { id_string: '42' } }) }; };
  const cred = { blog: 'tapstall', consumer_key: 'ck', consumer_secret: 'cs', token: 'tk', token_secret: 'ts' };
  const out = await C.meshPressFlush([item('tumblr')], { direct: { tumblr: cred } }, { now, fetch: fetcher });
  assert.equal(out.sent, 1, JSON.stringify(out.results));
  assert.equal(calls[0].url, 'https://api.tumblr.com/v2/blog/tapstall.tumblr.com/post');
  assert.match(calls[0].init.headers.authorization, /^OAuth oauth_consumer_key="ck"/);
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get('tags'), 'fake proof of payment,mobile money');
  assert.ok(form.get('body').includes('<img src="https://x.test/c.png"'));
  assert.ok(!form.get('body').includes('#FraudPrevention'), 'inline hashtags become Tumblr tags');
  const half = await C.meshPressFlush([item('tumblr')], { direct: { tumblr: { ...cred, token: '' } } }, { now, fetch: fetcher });
  assert.equal(half.results[0].status, 'queued');
});

test('buffer: Pinterest is published with createPost, its board and title; a MutationError is failed', async () => {
  const sent = [];
  const okF = async (url, init) => { sent.push(JSON.parse(init.body)); return { status: 200, text: async () => '{"data":{"createPost":{"__typename":"PostActionSuccess","post":{"id":"p1"}}}}' }; };
  const press = { buffer_token: 't', channels: { pinterest: 'chan1' } };
  const out = await C.meshPressFlush([item('pinterest', { board: '2242', link: 'https://tapstall.zlnew.workers.dev/onboard' })], press, { now, fetch: okF });
  assert.equal(out.sent, 1, JSON.stringify(out.results));
  const inp = sent[0].variables.input;
  assert.match(sent[0].query, /createPost/);
  assert.equal(inp.mode, 'shareNow');
  assert.deepEqual(inp.metadata.pinterest, { boardServiceId: '2242', title: 'How to spot a fake proof of payment on WhatsApp', url: 'https://tapstall.zlnew.workers.dev/onboard' });
  assert.deepEqual(inp.assets, [{ image: { url: 'https://x.test/c.png' } }]);
  const badF = async () => ({ status: 200, text: async () => '{"data":{"createPost":{"__typename":"InvalidInputError","message":"no board"}}}' });
  const bad = await C.meshPressFlush([item('pinterest', { board: '2242' })], press, { now, fetch: badF });
  assert.equal(bad.results[0].status, 'failed');
  const noBoard = await C.meshPressFlush([item('pinterest')], press, { now, fetch: okF });
  assert.equal(noBoard.results[0].status, 'queued');
});

test('content: the proof pillar speaks to sellers everywhere and its rail texts stay in limits', () => {
  const lines = C.MESH_COMPANY_VALUE.filter((l) => l.pillar === 'exact-amount');
  assert.ok(lines.length >= 8);
  assert.ok(lines.some((l) => /Yape, GCash, M-Pesa/.test(l.text)));
  for (const rail of ['bluesky', 'mastodon', 'tumblr', 'discord', 'pinterest']) {
    for (const l of lines) {
      const it = C.meshQueueItem({ kind: 'value', pillar: 'exact-amount', item_key: 'company:exact-amount:1', text: l.text, rail, to: [rail] }, { now, board: 'b' });
      assert.ok(it.text.length <= (rail === 'bluesky' ? 300 : 500), rail + ' ' + it.text.length);
    }
  }
});

test('fan-out: each beat reaches at most topic_max_rails rails, and a day of beats covers every armed rail', () => {
  const rails = ['bluesky', 'mastodon', 'discord', 'tumblr', 'pinterest'];
  for (let d = 0; d < 10; d += 1) {
    const t = now + d * 864e5;
    const seen = new Set();
    for (let i = 0; i < 3; i += 1) {
      const r = C.meshFanOut(rails, i, t, 3);
      assert.equal(r.length, 3);
      assert.equal(new Set(r).size, 3, 'no rail twice for one beat');
      r.forEach((x) => seen.add(x));
    }
    assert.equal(seen.size, 5, 'day ' + d + ' covers all five');
  }
  assert.deepEqual(C.meshFanOut(['bluesky'], 2, now, 3), ['bluesky']);
  assert.deepEqual(C.meshFanOut([], 0, now, 3), []);
  assert.equal(C.MESH_QUEUE_DEFAULTS.topic_max_rails, 3);
});
