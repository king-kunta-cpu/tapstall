import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const doc = read('CONTENT-MESH.md');
const worker = read('worker/worker.js');
const core = read('worker/core.js');

/* A design document is worth as much as the day it was true. This file's whole claim is that the mesh
   already exists in mechanisms rather than intentions, so the claim is checked against the code that
   would have to be missing for it to be a boast — the same way the pages suite refuses to let a promise
   about HTML drift from the HTML. */
test('the mesh design names only mechanisms that exist', () => {
  for (const fn of ['meshWitness', 'meshPack', 'meshJson', 'meshMark', 'realPhoto']) {
    assert.match(core, new RegExp('export (function|const) ' + fn), fn + ' must be in the shared core');
    assert.match(doc, new RegExp(fn), 'the document must name ' + fn + ' if it says the control is enforced');
  }
  assert.match(worker, /if \(p === '\/api\/mesh'\)/, 'the shop-facing view route exists');
  assert.match(worker, /if \(p === '\/api\/mesh\/seen' && req\.method === 'POST'\)/, 'and its one write path is an explicit POST');
  assert.match(worker, /card_url: \(url\.origin \|\| ''\) \+ '\/s\/' \+ handle \+ '\/mesh\.json'/,
    'the card the mesh is built from is served per shop, from the origin in the request, not a hard-coded host');
});

/* The budget is the anti-spam guarantee, so it must be one number in two places. */
test('the budget in the document is the budget in the code', () => {
  const m = core.match(/export const MESH_BUDGET = \{([^}]+)\}/);
  assert.ok(m, 'MESH_BUDGET is declared once, in core');
  // the keys are names and only the values are numbers; coercing both (the first draft) turned every
  // pair into NaN:<value>, which made the two objects equal no matter what the document said. A check
  // that cannot fail is worse than no check, because it is read as one.
  const nums = (txt) => Object.fromEntries(txt.split(',').map((p) => {
    const i = p.indexOf(':');
    return [p.slice(0, i).trim(), Number(p.slice(i + 1))];
  }));
  const code = nums(m[1]);
  assert.deepEqual(Object.keys(code).sort(), ['item_cooldown_days', 'per_day', 'promo', 'value'],
    'the budget has exactly four numbers, each named');
  assert.ok(Object.values(code).every((n) => Number.isInteger(n) && n > 0), 'and all of them are positive integers');
  const d = doc.match(/`MESH_BUDGET = \{([^}]+)\}`/);
  assert.ok(d, 'the document quotes the budget literally rather than paraphrasing it');
  assert.deepEqual(nums(d[1]), code, 'a doc that raises or lowers the cap without a code change is how a limit becomes a slogan');
});

/* One state write per shop per day is what makes this affordable on a plan that meters writes, and the
   number is only true while a single place in the code performs it. */
test('the mesh costs the account at most one write a day per shop', () => {
  const writes = worker.match(/await env\.ORDERS\.put\('mesh:' \+ st\.handle/g) || [];
  assert.equal(writes.length, 1, 'exactly one writer of mesh state; a second would double the spend and the drift');
  assert.match(doc, /at most one write\s*\n?\s*per shop per day/, 'and the document says the same thing the code enforces');
  assert.doesNotMatch(worker, /env\.ORDERS\.put\(`?mesh:[^']*daily|put\('mesh:.*seen_counts/,
    'no per-view write: the seen tally stays in memory, which is why a busy day is free');
});

/* Nothing in the graph may publish on its own. The absence of a route is the guarantee, so it is
   asserted as an absence — the cheapest way to keep a design promise from being quietly implemented. */
test('no node can publish without the shop, because there is nothing to publish with', () => {
  assert.match(doc, /Nothing sends without a yes/, 'the rule is quoted from the pipeline it comes from');
  assert.doesNotMatch(worker, /'\/api\/mesh\/(publish|send|post|schedule)'/,
    'there is no auto-publish endpoint, and adding one must be a decision with a test written for it');
  assert.match(worker, /meshMark\(prev, Array\.isArray\(b\.marked\) \? b\.marked : \[\], Date\.now\(\)\)/,
    'state changes only by marking what a human looked at');
});

/* Provenance is the other half of the design: the negative constraint, not a style guide. */
test('provenance is a function, not an adjective', () => {
  assert.match(doc, /may only cite what appears there|Provenance or nothing/i,
    'the document states the constraint in its negative form, as the source does');
  assert.match(core, /export function meshWitness\(st, products, facts\)/, 'and a function holds it');
  assert.match(doc, /Deliberately not here[\s\S]*Engagement pods[\s\S]*credential/,
    'the things the mesh refuses are written down where a reader will find them, not implied');
  assert.match(doc, /not wired/, 'a node that does not exist yet is labelled, not described in the present tense');
});
