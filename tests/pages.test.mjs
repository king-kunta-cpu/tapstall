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
import { readFileSync, existsSync } from 'node:fs';
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
    const hook = name === 'confirm' ? '/*__TAPSTALL_CONFIRM__*/null' : '/*__TAPSTALL_RENEW__*/null';
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

/* --------------------------------------------------------------------------
   The GitHub Pages mirror — the one host with no server to fall back on.
   -------------------------------------------------------------------------- */

test('the dashboard preview frames the store page, the one page allowed to be framed', () => {
  // The store page's `frame-ancestors 'self'` exists only for this iframe. If the
  // preview starts pointing somewhere else, it goes blank and the header
  // exception is then nothing but a hole — so the two halves are asserted together.
  const html = page('admin');
  assert.match(html, /location\.origin \+ '\/s\/' \+ S\.handle;/);   // the shape is the point, not which line builds it
  assert.match(html, /q\('#shareFrame'\)\.src = url;/);
  assert.ok(!/iframe[^>]*src="\/api/.test(html), 'the preview must not frame an API answer');
});

test('the mirror never links to a page it does not have', () => {
  // Pages serves files and nothing else. It has no rewrite engine and ignores
  // `_redirects` (that file is Netlify's), so `/onboard` on the mirror 404'd for
  // as long as the landing page's "Open the store builder" button existed — while
  // the same link worked on the Worker, which serves that path from a template.
  // Nothing in CI or in a browser would ever have noticed: this does.
  const pub = (rel) => existsSync(join(root, 'pages', 'public', rel));
  // The artifact CI uploads: pages/public, plus the marketing pages copied in
  // from pages/ so the mirror cannot drift from the shipped page.
  const inArtifact = (rel) => pub(rel) || ['index.html', 'fees.html'].includes(rel);
  const resolves = (href) => {
    const path = href.split('?')[0].split('#')[0].replace(/\/+$/, '').replace(/^\//, '');
    if (path === '') return inArtifact('index.html');
    return inArtifact(path + '.html') || inArtifact(path + '/index.html');
  };
  for (const name of ['index', 'fees']) {
    const html = page(name);
    const links = [...html.matchAll(/(?:href|action)="(\/[^"]*)"/g)].map((m) => m[1]);
    for (const l of links) {
      assert.ok(resolves(l), `pages/${name}.html links ${l}, which the Pages artifact does not contain`);
    }
  }
  assert.equal(pub('_redirects'), false,
    'a _redirects rule is a promise Pages does not keep; keeping the file invites trusting it');
  for (const shape of ['onboard.html', 'onboard/index.html', 'a.html', 'a/index.html']) {
    assert.ok(pub(shape), `${shape} is the handoff that makes the mirror's app link work`);
  }
  for (const [name, path] of [['public/onboard', 'onboard'], ['public/a', 'a']]) {
    const handoff = page(name);
    assert.match(handoff, new RegExp(`http-equiv="refresh" content="1; url=https:\\/\\/tapstall\\.[^/"]*\\/${path}`),
      'it moves the visitor without JS too, but one second late on purpose');
    assert.match(handoff, new RegExp(`location\\.replace\\('https:\\/\\/tapstall\\.[^']+\\/${path}' \\+ \\(location\\.search \\|\\| \\'\\'\\)`),
      'and the JS move keeps the query string — for /a the query string is the credential');
  }
});

test('the mirror marketing page is the shipped one, not a copy that drifted', () => {
  // build_bundle.sh puts pages/public/{index,fees}.html in the Worker's bundle as
  // the fallback under the KV templates, and CI copies pages/{index,fees}.html
  // into the same directory for Pages. Two consumers, one source: if somebody
  // commits a draft into public/ again, the Worker and the mirror disagree.
  const pub = (rel) => existsSync(join(root, 'pages', 'public', rel));
  const wf = readFileSync(join(root, '.github', 'workflows', 'deploy.yml'), 'utf8');
  const copies = /cp pages\/index\.html pages\/fees\.html pages\/public\//.test(wf);
  assert.ok(copies, 'the pages job must copy the shipped marketing pages into the artifact dir');
  for (const name of ['index.html', 'fees.html']) {
    // …and they must not be committed there as well, or the copy masks a draft.
    assert.equal(pub(name), false,
      `pages/public/${name} belongs to CI's copy step; committing it re-opens the drift`);
  }
});

test('the sign-in card stays two fields, one button, zero instructions', () => {
  // Link sign-in was deleted because explaining it was harder than using it. That
  // is the bar this screen has to keep meeting, so it is written down as a test:
  // nothing to read before you act, and the only text that appears on its own is
  // the text that names a failure.
  const card = src('admin').match(/<div class="card" id="login">([\s\S]*?)\n<\/div>/);
  assert.ok(card, 'the admin page lost its #login card');
  const front = card[1].split('<div id="lost"')[0];          // the recovery form is allowed to explain itself
  assert.equal([...front.matchAll(/<input /g)].length, 2, 'a store name and a PIN — a third box is a step back');
  assert.equal([...front.matchAll(/<button(?![^>]*class="sm")[^>]*>/g)].length, 1, 'one button; the escape hatch is link-styled, not a second primary');
  assert.ok(!/<p class="hint">/.test(front), 'no paragraph of instructions above the fields');
  assert.match(front, /id="why"[^>]*class="hide"|class="hide"[^>]*id="why"/, 'the explanation slot exists but starts hidden');
  assert.match(front, /id="fK"/); assert.match(front, /id="fP"/);
  assert.match(front, /type="password"/, 'the PIN is not typed into a box a shoulder can read off');
  assert.match(front, /inputmode="numeric"/, 'and it opens the number pad on a phone');
  for (const dead of ['code', 'token', 'link', 'magic']) {
    assert.ok(!new RegExp('id="f' + dead[0].toUpperCase() + '"|name="' + dead + '"').test(front),
      'the retired credential came back: ' + dead);
  }
});

test('no shipped sentence still tells a merchant to use a link', () => {
  // 0.6.0 deleted link sign-in. The failure mode after that is not the code, it is
  // a *sentence*: one stale error string or help line keeps teaching the old method
  // to somebody who has to be told the new one, and it survives every API test.
  const forbidden = [/lost your link/i, /dashboard link/i, /login link/i, /paste the (whole )?link/i,
    /link (we|that we) (sent|emailed)/i, /fresh link/i, /sign in by link to/i];
  const files = ['worker/worker.js', 'worker/core.js'].concat(PAGES.map((n) => {
    try { src(n); return 'pages/src/' + n + '.html'; } catch (e) { return 'pages/' + n + '.html'; }
  })).concat(['pages/public/a.html', 'pages/public/onboard.html']);
  for (const rel of files) {
    const txt = readFileSync(join(root, rel), 'utf8');
    txt.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\*.*?\*\//g, '');
      if (/^\s*(\*|\/\/)/.test(code.trim()) || /^\s*\/\/|^\s*\*/.test(line)) return;   // comments tell the story; they are allowed
      if (/retired|used to|no longer|instead of|was a link|never|not a secret/i.test(code)) return;
      for (const re of forbidden) {
        assert.ok(!re.test(code), rel + ':' + (i + 1) + ' still says ' + JSON.stringify(re) + ' → ' + line.trim().slice(0, 110));
      }
    });
  }
});

test('the dashboard can hold a number per method and a week of hours', () => {
  const a = page('admin');
  for (const id of ['railAccts', 'weekEd', 'fields']) {
    assert.ok(a.includes('id="' + id + '"'), id + ' exists in the settings drawer');
  }
  // Both editors build their rows in script, so the only proof they are wired is
  // the render call next to the grid they hang under.
  assert.ok(/renderAccts\(\); renderWeek\(\);/.test(a), 'the two editors are repainted whenever the settings grid is');
  assert.ok(a.includes("getAttribute('data-ra')"), 'each rail row is read back on save');
  assert.ok(a.includes("getAttribute('data-wk')"), 'and each day slot too');
  assert.ok(/an opening time needs a closing time/.test(a), 'a half-typed slot is stopped here, not sent as a closed week');
  assert.ok(/readonly/.test(a), 'and the hours sentence goes read-only while the week owns it');
  // The default is still the default: a store that never touches the new fields
  // must behave exactly as it did, which is what "falls back" has to mean.
  assert.ok(/falls back to your default/.test(a), 'the dashboard says which rails are falling back');
});

test('the storefront asks for the sending number only where it explains a payment', () => {
  const s = page('store');
  assert.ok(s.includes('id="fPayer"'), 'the buyer can say what number the payment comes from');
  assert.ok(/R\.type === 'manual'/.test(s), 'but only on a manual rail, decided by the shape the server published');
  assert.ok(/Should read/.test(s) && /pay\.holder/.test(s), 'the name to check the confirmation against is on the slip');
  assert.ok(/pay\.till/.test(s), 'and so is the till, when the merchant has one');
  assert.ok(/CFG\.open/.test(s), 'the open/closed line is computed on the shop clock, not the visitor’s');
  assert.ok(!/rail_accts/.test(s), 'the map of every rail is never handed to a public page');
});

test('a merchant can drop a picture, browse for one, or paste a link — in both places', () => {
  const a = page('admin');
  // The control is one builder used for the shop logo and every item row, plus the
  // static copy in the add-an-item form. Two ways to say "the same box twice".
  assert.ok(/function picHtml\(value, ph, boxAttr, inAttr\)/.test(a), 'one builder for every picture box');
  assert.ok(a.includes("data-which=\"logo\"") && a.includes("data-which=\"row\""), 'the logo and the rows use it');
  assert.ok(/data-which="new"/.test(a), 'and so does the add-an-item form');
  for (const need of ['accept="image/*"', 'data-pk="pick"', 'data-pk="off"', 'class="pu"']) {
    assert.ok(a.includes(need), need + ' — a picture box without it is a box that cannot ' + (need.includes('pick') ? 'pick a file' : need.includes('off') ? 'take one off' : 'hold a link'));
  }
  assert.ok((a.match(/accept="image\/\*"/g) || []).length >= 2, 'a file input for the built boxes and for the static one');
  // Drag and drop is only real if both events are handled and the drop is stopped
  // from navigating the page to the file.
  assert.ok(/addEventListener\('dragover'/.test(a) && /addEventListener\('drop'/.test(a), 'the box accepts a dropped file');
  assert.ok(/e\.preventDefault\(\)/.test(a), 'and dropping does not replace the dashboard with the image');
  // An upload is a write, so it carries the same header the settings save does.
  assert.ok(/fetch\('\/api\/image\?handle='/.test(a), 'it posts to the store that asked for it');
  assert.ok(/'x-tapstall-confirm': '1'/.test(a), 'with the confirmation header a cross-site form cannot set');
  // The bytes never become the setting. Only a path does.
  assert.ok(!/data:image/.test(a), 'no base64 picture is ever built into a save payload');
  assert.ok(a.includes("apply(o.j.ref)"), 'what comes back from the upload is the path, and that is what is applied');
  assert.ok(/setEdit\(box\.getAttribute\('data-id'\), \{ img: v \|\| '' \}\)/.test(a), 'a row records the path in the same draft the price uses');
  // Client and server have to agree on the ceiling, or a squeezed file still gets refused.
  assert.ok(/PIC_AIM = 120 \* 1024, PIC_HARD = 200 \* 1024/.test(a), 'the dashboard aims under what the worker accepts');
  assert.ok(/SVG is refused/.test(a), 'and it says so before the round trip, in the same words the server uses');
  const s = page('store');
  assert.ok(/p\.img/.test(s) && /class="logo" id="logo"/.test(s), 'the buyer’s page shows the item picture and the logo the store holds');
});

test('a picture path typed by a merchant cannot escape the attribute it is written into', () => {
  // The box puts a value the merchant controls into an HTML attribute, in three
  // places, and it is built in script rather than by the browser — so this is the
  // one claim about it worth executing instead of grepping.
  const js = scripts(src('admin')).join('\n;\n');
  const grab = (name) => {
    const i = js.indexOf('function ' + name);
    assert.ok(i >= 0, name + ' is in the admin script');
    const j = js.indexOf('\n}', i);
    assert.ok(j > i, name + ' closes on its own line');
    return js.slice(i, j + 2);
  };
  const picHtml = new Function(grab('esc') + '\n' + grab('picHtml') + '\nreturn picHtml;')();
  const hostile = '/i/mamatoe/abc" onerror="alert(1)';
  const out = picHtml(hostile, 'ph', 'data-which="row"', '');
  assert.ok(!/["']\s*onerror\s*=/.test(out), 'the quote is escaped, so a value cannot open a new attribute: ' + out);
  assert.ok(out.includes('&quot;'), 'and it is visibly escaped rather than silently dropped');
  const box = picHtml('', 'drop a file', 'data-which="logo"', 'data-k="logo"');
  assert.ok(box.includes('<input class="pu" data-k="logo" value=""'), 'the logo box writes into the field the ordinary Save already reads: ' + box);
  assert.ok(box.includes('Take off') && box.includes('style="display:none"'), 'and there is a way to take a picture off, shown only when one is set');
});
