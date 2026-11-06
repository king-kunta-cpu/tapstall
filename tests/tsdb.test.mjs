// @ts-nocheck
// 2026-11-06 (build step 2): the SQL store. Leads and the Proof Check ledger in a SQLite Durable Object.
// The Durable Object's sql.exec is emulated with node:sqlite (Node 22), statement for statement.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'tsdb-'));
const bundle = join(dir, 'worker.js');
let W, mod;
before(async () => {
  execFileSync('bash', [join(root, 'scripts/build_bundle.sh'), dir], { cwd: root, stdio: 'pipe' });
  assert.ok(existsSync(bundle), 'build produced no bundle');
  mod = await import(pathToFileURL(bundle).href + '?tsdb');
  W = mod.default;
});

const sqlStorage = () => {
  const db = new DatabaseSync(':memory:');
  return { db, exec(q, ...args) {
    const st = db.prepare(q);
    const rows = /^\s*(select|with)\b/i.test(q) ? st.all(...args) : (st.run(...args), []);
    return { toArray: () => rows.map((r) => ({ ...r })), one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } };
};
const doNamespace = (Cls, env) => {
  const objs = new Map(); let calls = 0;
  return { idFromName: (n) => n, get(id) {
    if (!objs.has(id)) { const sql = sqlStorage(); objs.set(id, { obj: new Cls({ storage: { sql } }, env), sql }); }
    const o = objs.get(id);
    return { fetch: (u, init) => { calls++; return o.obj.fetch(new Request(u, init)); } };
  }, get calls() { return calls; }, objs };
};
const kv = () => { const m = new Map(); let writes = 0; return { m, get writes() { return writes; },
  async get(k, t) { const v = m.get(k); if (v == null) return null; return t === 'json' ? JSON.parse(v.v) : v.v; },
  async put(k, v, o) { writes++; m.set(k, { v: typeof v === 'string' ? v : JSON.stringify(v), md: o && o.metadata }); },
  async delete(k) { m.delete(k); },
  async list({ prefix = '' } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name, metadata: m.get(name).md })), list_complete: true }; } }; };
const op = async (stub, o) => (await stub.fetch('https://tsdb/' + o.op, { method: 'POST', body: JSON.stringify(o) })).json();

test('TsDb: leads upsert, read back whole, index in pick order, filter by seller and status', async () => {
  const ns = doNamespace(mod.TsDb, {});
  const db = ns.get('main');
  const r = await op(db, { op: 'lead.put', docs: [
    { id: 'a1', status: 'queued', email: 'shop@a.test', score: 3, country: 'PE', signals: ['wa', 'pop'] },
    { id: 'b2', status: 'contacted', email: 'b@b.test', score: 5, next_follow_at: '2026-11-08T00:00:00Z', last_sender: 'X@gmail.com', touches: 1 },
    { id: 'c3', status: 'dnc', email: 'c@c.test', score: 9 },
    { id: 'd4', status: 'queued', email: 'd@d.test', score: 1, seller_code: 'kelly' },
    { nope: 1 },
  ] });
  assert.equal(r.n, 4, 'a document without an id is not a lead');
  const got = await op(db, { op: 'lead.get', ids: ['a1', 'zz'] });
  assert.deepEqual(got.docs.a1.signals, ['wa', 'pop']);
  assert.equal(got.docs.zz, undefined);
  const idx = await op(db, { op: 'lead.index' });
  assert.deepEqual(idx.rows.map((x) => x.id), ['b2', 'a1', 'd4'], 'dnc is not in the pick; score first');
  assert.equal(idx.rows[0].last_sender, 'x@gmail.com');
  assert.equal(idx.rows[2].seller_code, 'kelly');
  assert.deepEqual((await op(db, { op: 'lead.all', seller: 'kelly' })).docs.map((d) => d.id), ['d4']);
  assert.deepEqual((await op(db, { op: 'lead.all', status: 'queued' })).docs.map((d) => d.id), ['a1', 'd4']);
  await op(db, { op: 'lead.put', docs: [{ id: 'a1', status: 'contacted', email: 'shop@a.test', score: 3 }] });
  const c = await op(db, { op: 'lead.count' });
  assert.equal(c.total, 4);
  assert.deepEqual(c.by_status, { contacted: 2, dnc: 1, queued: 1 });
  assert.equal((await op(db, { op: 'nope' })).ok, false);
});

test('TsDb ledger: a reference seen again reports the first sighting and whether the same shop saw it', async () => {
  const db = doNamespace(mod.TsDb, {}).get('main');
  const h = 'ab'.repeat(32);
  const first = await op(db, { op: 'ledger.seen', hash: h, wallet: 'ecocash', cc: 'ZW', verdict: 'pass', store: 'mama', at: '2026-11-06T10:00:00Z' });
  assert.equal(first.prior, null);
  const again = await op(db, { op: 'ledger.seen', hash: h, wallet: 'ecocash', cc: 'ZW', verdict: 'reused', store: 'other', at: '2026-11-06T11:00:00Z' });
  assert.deepEqual(again.prior, { n: 1, first_at: '2026-11-06T10:00:00Z', last_at: '2026-11-06T10:00:00Z', same_store: false, verdict: 'pass' });
  const st = await op(db, { op: 'ledger.stats' });
  assert.deepEqual(st.rows, [{ wallet: 'ecocash', cc: 'zw', verdict: 'pass', refs: 1, checks: 2, repeats: 1 }]);
  const bad = await op(db, { op: 'ledger.seen', hash: 'EcoCash ref MP123' });
  assert.equal(bad.ok, false, 'only a hash is ever stored, never the reference');
});

test('worker: KV until the copy, then every lead read and write on TS_DB with no KV write', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 404 });
  try {
    const ORDERS = kv(), STORES = kv();
    const env = { ORDERS, STORES, ADMIN_SECRET: 'x', PUBLIC_ORIGIN: 'https://tapstall.zlnew.workers.dev' };
    env.TS_DB = doNamespace(mod.TsDb, env);
    const ingest = (leads) => W.fetch(new Request('https://tapstall.zlnew.workers.dev/api/leads/ingest', { method: 'POST',
      headers: { 'x-tapstall-admin': 'x', 'x-tapstall-confirm': '1', 'content-type': 'application/json' }, body: JSON.stringify({ leads }) }), env, { waitUntil() {} }).then((r) => r.json());
    const shop = (n) => ({ business: 'Panaderia ' + n, email: 'ventas@panaderia' + n + '.pe', website: 'https://panaderia' + n + '.pe',
      source_url: 'https://panaderia' + n + '.pe/contacto', signals: ['whatsapp_order', 'yape'], country: 'PE' });
    const a = await ingest([shop(1), shop(2)]);
    assert.equal(a.counts.added, 2, JSON.stringify(a));
    const kvLeads = [...ORDERS.m.keys()].filter((k) => k.startsWith('lead:'));
    assert.equal(kvLeads.length, 2, 'before the copy, KV is the store');

    const waits = [];
    await W.scheduled({ cron: '15 6,12,18,0 * * *' }, env, { waitUntil: (p) => waits.push(p) });
    const out = await Promise.all(waits);
    assert.deepEqual(out[0].leads_db, { copied: 2 }, JSON.stringify(out[0].leads_db));

    const before = ORDERS.writes;
    const b = await ingest([shop(3), shop(1)]);
    assert.equal(b.counts.added, 1);
    assert.equal(b.counts.added + b.counts.updated + b.counts.duplicate, 2);
    assert.equal([...ORDERS.m.keys()].filter((k) => k.startsWith('lead:')).length, 2, 'new leads no longer land in KV');
    assert.equal(ORDERS.writes - before, 0, 'no KV write for a lead');
    const c = await (await env.TS_DB.get('main').fetch('https://tsdb/lead.count', { method: 'POST', body: '{"op":"lead.count"}' })).json();
    assert.equal(c.total, 3);
    const again = await Promise.all((() => { const w = []; W.scheduled({ cron: '15 6,12,18,0 * * *' }, env, { waitUntil: (p) => w.push(p) }); return w; })());
    assert.deepEqual(again[0].leads_db, { done: true }, 'the copy runs once');
    const self = await (await W.fetch(new Request('https://tapstall.zlnew.workers.dev/__selftest'), env, { waitUntil() {} })).json();
    assert.equal(self.ts_db, 'durable_object');
  } finally { globalThis.fetch = realFetch; }
});

test('every deploy path carries the SQL store binding and its migration after wa-v1', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['wrangler.toml', 'scripts/gen_wrangler_toml.py']) {
    const s = readFileSync(join(root, f), 'utf8');
    assert.match(s, /name = "TS_DB"\nclass_name = "TsDb"/, f);
    assert.ok(s.indexOf('tag = "wa-v1"') < s.indexOf('tag = "db-v1"'), f + ': migrations in order');
    assert.match(s, /tag = "db-v1"\nnew_sqlite_classes = \["TsDb"\]/, f);
  }
  const pub = readFileSync(join(root, 'scripts/cf_publish.py'), 'utf8');
  assert.match(pub, /"durable_object_namespace", "name": "TS_DB", "class_name": "TsDb"/);
  assert.match(readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8'), /node-version: '22'/, 'node:sqlite needs Node 22');
  assert.equal(typeof mod.TsDb, 'function');
});

test('harvest: the script selftest passes, and the market helpers say who has copy', async () => {
  const out = execFileSync('python3', [join(root, 'scripts/harvest_global.py'), '--selftest'], { encoding: 'utf8' });
  assert.match(out, /SELFTEST OK/);
  const core = await import(pathToFileURL(join(root, 'worker/core.js')).href);
  const mail = await import(pathToFileURL(join(root, 'worker/mail.js')).href);
  assert.equal(core.leadCc('ZA'), 'za');
  assert.equal(core.leadCc('Zimbabwe'), 'zw');
  assert.equal(core.leadCc('somewhere'), '');
  assert.equal(mail.v2Market('ZW'), true);
  assert.equal(mail.v2Market('pe'), true, 'step 4: every country has copy');
  assert.equal(mail.v2Market(''), false);
  assert.deepEqual(['pe', 'ao', 'ci', 'eg', 'tr', 'id', 'ua', 'vn', 'ke', 'zw'].map(mail.v2Lang), ['es', 'pt', 'fr', 'ar', 'tr', 'id', 'uk', 'vi', 'en', 'en']);
  assert.equal(core.tsdbIndexRow({ id: 'x', status: 'queued', cc: 'pe' }).country, 'pe');
});
