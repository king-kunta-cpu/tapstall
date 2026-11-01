// Cloudflare budget guard (playbook/CF-BUDGET.md, 2026-11-01). Tapstall shares the zlnew account with Open Practice,
// so each business keeps under 10% of every free daily quota. The clock that writes to KV runs hourly, not every 20 minutes;
// this test fails if the schedule is quietly raised again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const field = (f, lo, hi) => {
  const out = new Set();
  for (const part of f.split(',')) {
    const [range, step] = part.split('/');
    const [a, b] = range === '*' ? [lo, hi] : range.includes('-') ? range.split('-').map(Number) : [Number(range), step ? hi : Number(range)];
    for (let i = a; i <= b; i += Number(step || 1)) out.add(i);
  }
  return out.size;
};
export const firesPerDay = (cron) => { const [m, h] = cron.trim().split(/\s+/); return field(m, 0, 59) * field(h, 0, 23); };

test('cron budget: at most 28 scheduled runs a day (hourly clock + four sweeps)', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const crons = JSON.parse(toml.match(/^crons\s*=\s*(\[[^\]]*\])/m)[1]);
  const total = crons.reduce((n, c) => n + firesPerDay(c), 0);
  assert.equal(firesPerDay('5,25,45 * * * *'), 72, 'counter sanity');
  assert.ok(total <= 28, `crons fire ${total} times a day: ${crons.join(' | ')}`);
  const worker = readFileSync(new URL('../worker/worker.js', import.meta.url), 'utf8');
  const press = worker.match(/const PRESS_CRON = '([^']+)'/)[1];
  assert.ok(crons.includes(press), 'the clock the worker listens for is the one wrangler schedules');
  assert.ok(firesPerDay(press) <= 24, 'the KV-writing clock is at most hourly');
});

test('every deploy path schedules the same budgeted crons as wrangler.toml', () => {
  // deploy.sh regenerates wrangler.toml (gen_wrangler_toml.py), re-asserts triggers (set_triggers.py args) and has a
  // dependency-free fallback (cf_publish.py): a stale copy in any of them silently restores the old schedule.
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const want = JSON.parse(toml.match(/^crons\s*=\s*(\[[^\]]*\])/m)[1]);
  for (const f of ['scripts/gen_wrangler_toml.py', 'scripts/cf_publish.py', 'scripts/deploy.sh']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    for (const c of want) assert.ok(src.includes(`"${c}"`), `${f} schedules ${c}`);
    assert.doesNotMatch(src, /"5,25,45 \* \* \* \*"/, `${f} still carries the 20-minute clock`);
  }
});
