// The deploy confirms the live /__ping version against package.json; the Worker's constant must move with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('worker VERSION equals package.json version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const m = readFileSync(new URL('../worker/worker.js', import.meta.url), 'utf8').match(/const VERSION = '([^']+)'/);
  assert.ok(m, 'VERSION constant present');
  assert.equal(m[1], pkg);
});
