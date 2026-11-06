// @ts-nocheck
// 2026-11-06: the company press through the real bundle: armed rails, fan-out under topic_max_rails, Pinterest via Buffer.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RealDate = Date;
let at = RealDate.parse('2026-11-07T08:25:00Z');
class FixedDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(at); else super(...a); }
  static now() { return at; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'press-'));
const bundle = join(dir, 'worker.js');
before(() => {
  execFileSync('bash', [join(root, 'scripts/build_bundle.sh'), dir], { cwd: root, stdio: 'pipe' });
  assert.ok(existsSync(bundle), 'build produced no bundle');
});

const kv = () => { const m = new Map(); return {
  async get(k, t) { const v = m.get(k); if (v == null) return null; return t === 'json' ? JSON.parse(v) : v; },
  async put(k, v) { m.set(k, typeof v === 'string' ? v : JSON.stringify(v)); }, async delete(k) { m.delete(k); },
  async list() { return { keys: [...m.keys()].map((name) => ({ name })), list_complete: true }; } }; };

test('company press: four armed rails, three per beat, every rail used, Tumblr waits for its token, Pinterest carries its board', async () => {
  const realFetch = globalThis.fetch; globalThis.Date = FixedDate;
  try {
    const STORES = kv(), ORDERS = kv();
    await STORES.put('press:registry', JSON.stringify({ owner: { class: 'owner', token_env: 'PRESS_BUFFER_TOKEN', source: {}, cadence: null, rails: {
      bluesky: { via: 'direct', channel: 'bluesky', handle: 'tapstall.bsky.social' }, x: { via: 'buffer', channel: 'twitter', channel_id: '' },
      mastodon: { via: 'direct', channel: 'mastodon' }, discord: { via: 'direct', channel: 'discord' }, tumblr: { via: 'direct', channel: 'tumblr' },
      pinterest: { via: 'buffer', channel: 'pinterest', channel_id: 'CH', board: 'BOARD' } } } }));
    const env = { STORES, ORDERS, ADMIN_SECRET: 'x', PRESS_BUFFER_TOKEN: 'b', PRESS_OWNER_BLUESKY_HANDLE: 'tapstall.bsky.social', PRESS_OWNER_BLUESKY_APP_PASSWORD: 'p',
      PRESS_OWNER_MASTODON_TOKEN: 'm', PRESS_OWNER_DISCORD_WEBHOOK: 'https://discord.com/api/webhooks/1/z',
      PRESS_OWNER_TUMBLR_BLOG: 'tapstall', PRESS_OWNER_TUMBLR_CONSUMER_KEY: 'k', PRESS_OWNER_TUMBLR_CONSUMER_SECRET: 's' };
    const calls = [];
    globalThis.fetch = async (u, init) => {
      const url = String((u && u.url) || u); calls.push({ url, body: init && typeof init.body === 'string' ? init.body : '' });
      const J = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('createSession')) return J({ accessJwt: 'j', did: 'did:plc:x' });
      if (url.includes('uploadBlob')) return J({ blob: { ref: 'r' } });
      if (url.includes('createRecord')) return J({ uri: 'at://x/1', cid: 'c' });
      if (url.includes('/api/v2/media')) return J({ id: 'm1' });
      if (url.includes('/api/v1/statuses')) return J({ id: 's1' });
      if (url.includes('discord.com')) return J({ id: 'd1' });
      if (url.includes('api.buffer.com')) return J({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'p1' } } } });
      return new Response(new Uint8Array(8), { status: 200, headers: { 'content-type': 'image/png' } });
    };
    const W = (await import(pathToFileURL(bundle).href + '?press')).default;
    const run = async () => (await (await W.fetch(new Request('https://tapstall.zlnew.workers.dev/api/press/run', { method: 'POST',
      headers: { 'x-tapstall-admin': 'x', 'x-tapstall-confirm': '1', 'content-type': 'application/json' }, body: '{}' }), env, { waitUntil() {} })).json()).ran[0];

    const r = await run();
    assert.deepEqual(Object.keys(r.rails).filter((k) => r.rails[k].status === 'active').sort(), ['bluesky', 'discord', 'mastodon', 'pinterest']);
    assert.equal(r.rails.tumblr.status, 'on (waiting for account)');
    assert.equal(r.skipped_slots, 0);
    assert.equal(r.in_slot, 9, 'three beats x three rails');
    const bySlot = {};
    for (const x of r.results) (bySlot[x.due] = bySlot[x.due] || []).push(x.channel);
    for (const chans of Object.values(bySlot)) { assert.equal(chans.length, 3); assert.equal(new Set(chans).size, 3); }
    assert.equal(new Set(r.results.map((x) => x.channel)).size, 4, 'every armed rail gets the day');
    assert.equal(r.sent, 3, 'the 08:20 beat goes out now, the rest wait for their slot');

    at = RealDate.parse('2026-11-07T16:25:00Z');
    const r2 = await run();
    assert.equal(r2.results.filter((x) => x.status === 'failed').length, 0, JSON.stringify(r2.results));
    const buf = calls.filter((c) => c.url.includes('api.buffer.com'));
    assert.ok(buf.length >= 1, 'Pinterest went through Buffer during the day');
    const input = JSON.parse(buf[0].body).variables.input;
    assert.equal(input.channelId, 'CH');
    assert.equal(input.mode, 'shareNow');
    assert.equal(input.metadata.pinterest.boardServiceId, 'BOARD');
    assert.ok(input.metadata.pinterest.title.length > 10);
  } finally { globalThis.fetch = realFetch; globalThis.Date = RealDate; }
});
