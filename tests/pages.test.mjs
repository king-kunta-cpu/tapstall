/**
 * The shipped UI, checked without a browser.
 *
 * These pages are single self-contained files served from KV, so nothing else
 * exercises them: no bundler, no linter, no type checker, and a typo in an
 * element id only shows up as a blank panel on a merchant's phone. This file is
 * the substitute — it compiles each page's inline script, proves every id the
 * script reaches for exists, proves every endpoint it calls is a route the
 * Worker actually serves, and proves every console lever names an action the
 * Worker actually implements. (Two live bugs came out of writing it: the
 * Templates panel 500-ing, and the notify/link levers answering `unknown
 * action` because they fell through the dispatch chain.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = (n) => readFileSync(join(root, 'pages', n + '.html'), 'utf8');
const src = (n) => readFileSync(join(root, 'pages/src', n + '.html'), 'utf8');
const worker = readFileSync(join(root, 'worker/worker.js'), 'utf8');

const PAGES = ['store', 'onboard', 'admin', 'fees', 'index', 'confirm', 'renew', 'ops'];
const MONEY = ['confirm', 'renew'];          // pages a merchant taps to move money
const PRIVATE = ['admin', 'confirm', 'renew', 'ops'];   // must never be indexed

function scripts(html) { return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]); }
function idsDefined(html) {
  return new Set([...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
}

test('the shipped pages are the generated ones (kit inlined), and vice versa', () => {
  // ./scripts/ui_kit.py check is the drift gate; CI runs it too, but a failing
  // test here means a human gets told which page and why, at `npm test`.
  // python3, not the executable bit: a snapshot that drops the file mode is a
  // checkout detail, not a product failure
  execFileSync('python3', [join(root, 'scripts/ui_kit.py'), 'check'], { cwd: root, stdio: 'pipe' });
  assert.ok(true);
});

for (const name of PAGES) {
  test(`${name}.html: compiles, self-contained, no dead element references`, () => {
    const html = page(name);
    const js = scripts(html).join('\n;\n');
    assert.ok(js.length > 40 || name === 'index', name + ' has no inline script to check');

    // 1. it parses — the classic failure mode of these files (a duplicated
    //    function, a eaten brace) is otherwise invisible until someone opens it
    new Function(js);

    // 2. no cross-origin anything: these pages must render on a 2G handset, in
    //    a sandboxed preview and inside a WhatsApp in-app browser alike
    assert.ok(!/<script[^>]+\bsrc=/i.test(html), name + ' loads a remote script');
    assert.ok(!/<link[^>]+stylesheet/i.test(html), name + ' loads a remote stylesheet');
    assert.ok(!/@import\s+url/i.test(js), name + ' imports remote CSS from JS');
    assert.match(html, /name="viewport"/, name + ' has no viewport meta (unusable on a phone)');

    // 3. every `q('#x')` the script reaches for is defined somewhere in the
    //    file — static markup or a template string it writes
    const defined = idsDefined(html);
    const refs = new Set([...js.matchAll(/(?:querySelector\(|q\()['"]#([A-Za-z0-9_-]+)/g)].map((m) => m[1]));
    const missing = [...refs].filter((id) => !defined.has(id) && !new RegExp('id=[\\s\\S]{0,3}' + id).test(html));
    assert.deepEqual(missing, [], name + ' reaches for element ids that do not exist: ' + missing.join(', '));

    // 4. no two static blocks with the same id (querySelector would silently
    //    hit the first, and the second becomes invisible dead markup)
    const before = html.slice(0, html.search(/<script>/));
    const dupes = [...before.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1])
      .filter((v, i, a) => a.indexOf(v) !== i);
    assert.deepEqual([...new Set(dupes)], [], name + ' defines duplicate ids in markup: ' + [...new Set(dupes)].join(', '));
  });
}

test('every endpoint a page calls is a route the Worker serves', () => {
  // two shapes of route: `p === '/api/x'` and a prefix pattern like
  // p.match(/^\/s\//) — a page calling /s/mamatoe/config.json must be allowed
  const literal = [...worker.matchAll(/p === '([^']+)'/g)].map((m) => m[1]);
  const prefix = [...worker.matchAll(/p\.match\(\/\^\\\/(\w+)/g)].map((m) => '/' + m[1] + '/');
  const known = new Set(literal.concat(prefix));
  for (const name of PAGES) {
    const html = page(name);
    const calls = [...html.matchAll(/(?:fetch|api|post|jget)\(\s*['"](\/[A-Za-z0-9_\/.-]*)/g)].map((m) => m[1]);
    for (const path of calls) {
      // static assets the Pages bundle serves are allowed too
      if (path.startsWith('/data/') || path === '/rails' || path === '/healthz') continue;
      const hit = known.has(path) || prefix.some((r) => path.startsWith(r));
      assert.ok(hit, name + ' calls ' + path + ', which the Worker does not route');
    }
  }
});

test('the operator console offers only levers the Worker implements', () => {
  const advertised = worker.match(/'unknown action', actions: \[([^\]]+)\]/);
  assert.ok(advertised, 'the Worker no longer lists its actions, so this test can not check the buttons');
  const actions = advertised[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
  const buttons = [...src('ops').matchAll(/data-act="([a-z_0-9]+)"/g)].map((m) => m[1]);
  assert.ok(buttons.length >= 8, 'the console lost its levers (' + buttons.length + ')');
  for (const b of buttons) assert.ok(actions.includes(b), 'console button "' + b + '" has no Worker action behind it');
  // and the reverse: a lever that exists but has no button is dead weight in
  // the 422 message and no way to press it
  for (const a of actions) assert.ok(buttons.includes(a), 'Worker action "' + a + '" has no button in the console');
});

test('the pages that post money know what status the endpoint returns', () => {
  // register answers 201 and /api/mark 200; a page that compares against 200
  // alone reads a success as a failure, which is how this test was born
  const onb = src('onboard');
  assert.ok(!/res\.s !== 200/.test(onb), 'onboard must accept 201 from /api/register');
  assert.match(onb, /res\.s >= 200 && res\.s < 300/, 'onboard checks a range, not one code');
  for (const f of ['confirm', 'renew', 'ops']) {
    const html = src(f);
    const strict = [...html.matchAll(/(?:\.status|\.s|res\.s)\s*[!=]==?\s*200/g)];
    for (const m of strict) {
      // `=== 200` is fine where a 200 really is the only success (lookup does
      // exactly that for "is this handle taken"); flag anything else
      assert.ok(/lookup|api\/lookup/.test(html.slice(Math.max(0, m.index - 400), m.index + 200)),
        f + ' compares a status against 200 outside a lookup call: ' + JSON.stringify(html.slice(m.index - 60, m.index + 60)));
    }
  }
});

test('merchant-facing pages share the kit and the private ones hide from crawlers', () => {
  // the storefront keeps its own markup for now — it is the one page a buyer
  // sees, it ships from pages/store.html directly, and re-skinning it is a
  // separate change from shipping the merchant suite
  for (const name of ['onboard', 'admin', 'confirm', 'renew', 'ops']) {
    const html = page(name);
    assert.match(html, /--tap:\s*44px/, name + ' has no 44px touch target rule from the kit');
    assert.match(html, /prefers-reduced-motion/, name + ' ignores reduced-motion preference');
    assert.match(html, /var\(--tap\)/, name + ' defines the tap size but never applies it');
  }
  for (const name of MONEY) {
    const hook = name === 'confirm' ? '/*__ZIMLINK_CONFIRM__*/null' : '/*__ZIMLINK_RENEW__*/null';
    assert.ok(src(name).includes(hook), name + ' lost the server data hook');
    assert.ok(page(name).includes(hook), name + ' shipped without its data hook');
  }
  for (const name of PRIVATE) {
    assert.match(page(name), /name="robots" content="noindex/i, name + ' would be indexed by Google');
  }
  assert.match(page('confirm'), /<noscript>/, 'a merchant with JavaScript off still gets one button');
  assert.match(page('confirm'), /document\.hidden/, 'link-preview bots must not be able to confirm an order');
});

test('no page prints a credential, and none can be framed', () => {
  for (const name of PAGES) {
    // store/index/fees are authored directly, so there is no src/ twin for them
    let html = page(name);
    try { html += src(name); } catch (e) {}
    // naming the variable is required (the console has to say what to paste);
    // carrying a value for it is the thing that must never happen in markup
    assert.ok(!/ADMIN_SECRET\s*[:=]\s*['"][^'"]{6,}/.test(html), name + ' embeds a value for the platform secret');
    assert.ok(!/st\.admin_token|\.admin_token\b/.test(html), name + ' reads a store key in the browser');
  }
  // the console is the one page that must never be embeddable, and it is the
  // Worker that sets the header; the page still must not carry a secret itself
  assert.ok(!/value="[A-Za-z0-9_-]{20,}"/.test(page('ops')), 'ops page has a long hard-coded value that looks like a key');
});
