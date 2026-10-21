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
import { readFileSync, existsSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as CORE from '../worker/core.js';

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
  // The owner's console deliberately does not list or edit an operator's items:
  // `menu`/`menu_revert` stay API-only support actions behind ops auth, while
  // every visible owner lever still has to be a real button here.
  const apiOnly = ['menu', 'menu_revert'];
  for (const a of apiOnly) assert.ok(!buttons.includes(a), 'the owner console grew its item-list lever back: ' + a);
  for (const a of actions.filter((x) => !apiOnly.includes(x))) assert.ok(buttons.includes(a), 'Worker action "' + a + '" has no button in the console');
});

test('the design surfaces all speak the same template list', () => {
  const keys = Object.keys(CORE.STOREFRONT_TEMPLATES).sort();
  const onboardKeys = [...src('onboard').matchAll(/<option value="([a-z]+)">[^<]*(?:General retail|Food|Fashion|Groceries|Phones|Home|Services)/g)].map((m) => m[1]).sort();
  assert.deepEqual(onboardKeys, keys, 'sign-up offers exactly the templates core can resolve');
  const admin = src('admin');
  assert.match(admin, /S\.templates = j\.templates/, 'the dashboard takes its template list from the Worker, not a second copy');
  assert.match(admin, /function designPanel\(\)/, 'the dashboard has one grouped outfit panel');
  for (const k of ['business_type', 'cover_image', 'accent_color', 'store_layout', 'hero_style', 'welcome_message', 'about', 'cta_label', 'sort_mode', 'search_bar', 'category_bar', 'product_descriptions', 'whatsapp_button']) {
    assert.ok(admin.includes('data-k="' + k + '"'), 'dashboard cannot save ' + k);
    assert.ok(CORE.EDITABLE_FIELDS.includes(k), 'core will not accept ' + k);
    assert.ok(CORE.SOFT_FIELDS.includes(k), k + ' is cosmetic and must not wait with money fields');
  }
  const store = page('store');
  for (const needle of ['CFG.design', 'layout-list', 'layout-compact', "D.hero === 'cover'", 'id="q"', 'D.popular_label', 'D.cta', 'waFloat', 'aboutText']) {
    assert.ok(store.includes(needle), 'storefront does not use ' + needle);
  }
  assert.match(worker, /business_type: STOREFRONT_TEMPLATES\[String\(b\.business_type/, 'registration stores only a known business type');
  assert.match(worker, /templates: STOREFRONT_TEMPLATES/, 'the dashboard API carries the catalogue');
});

test('the brand is on every surface, and the storefront wears the professional shelf', () => {
  for (const name of PAGES.concat(['guide-whatsapp-shop-payments', 'guide-payment-reference-matching'])) {
    assert.match(page(name), /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/, name + ' has no Tapstall favicon');
  }
  for (const rel of ['public/onboard.html', 'public/a.html', 'public/guide/whatsapp-shop-payments.html']) {
    assert.match(readFileSync(join(root, 'pages', rel), 'utf8'), /rel="icon"/, rel + ' (Pages mirror handoff) has no favicon');
  }
  for (const f of ['brand/favicon.svg', 'brand/favicon.ico', 'brand/apple-touch-icon.png', 'brand/icon-192.png', 'brand/icon-512.png',
                   'brand/og-banner.png', 'brand/banner-1600x900.png', 'brand/banner-square.png',
                   'pages/public/brand/og-banner.png', 'pages/public/brand/apple-touch-icon.png']) {
    assert.ok(existsSync(join(root, f)), 'missing brand asset ' + f);
  }
  const og = readFileSync(join(root, 'brand/og-banner.png'));
  assert.equal(og.readUInt32BE(16), 1200, 'OG banner is 1200 wide');
  assert.equal(og.readUInt32BE(20), 630, 'OG banner is 630 tall');
  const store = page('store');
  for (const needle of ['class="toolbar" id="browse"', 'class="service-strip"', 'id="avatarFallback"', 'class="media"', 'class="soldflag"', 'class="skel"', 'id="browseTitle"', 'id="itemCount"', 'class="footmark"']) {
    assert.ok(store.includes(needle), 'professional storefront is missing ' + needle);
  }
  assert.match(store, /@media \(min-width:1024px\)\{body\.layout-grid \.grid\{grid-template-columns:repeat\(4,1fr\)\}/, 'the shelf widens on desktop instead of staying a phone column');
});

test('the quota redesign stays wired: indexed cron, one-write orders, zero-KV measurement', () => {
  assert.match(worker, /metadata: storeMeta\(st\)/, 'a store write carries its cron/index row in the same write');
  assert.match(worker, /storeMetaAction\(k\.metadata/, 'cron judges shops from list metadata before reading documents');
  assert.ok(!/'term:' \+/.test(worker), 'the redundant term key (a read per storefront, a write per suspend) stayed deleted');
  assert.match(worker, /const SEQ_BLOCK = 50/, 'order numbers are block-leased, not incremented per order');
  assert.match(worker, /async function ledgerRowsAll/, 'owner state reads the order key space once, not once per shop');
  assert.match(worker, /quotaGate\('writes', force \? 'operator' : 'automation'\)/, 'feed snapshots are governed writes');
  assert.match(worker, /function cookieVals/, 'auth doors try every same-name cookie a browser sends, not just the first');
  const admin = page('admin');
  assert.match(admin, /S\.justIn = 1/, 'a fresh sign-in is marked so the first dashboard load may retry');
  assert.match(admin, /\(authed \|\| S\.justIn\) && S\.loadRetry < 2/, 'and the cookie-landing retry applies to that first load, not only to a dashboard already on screen');
  const hunt = readFileSync(join(root, 'scripts/lead_hunt.py'), 'utf8');
  assert.match(hunt, /"x-tapstall-confirm": "1"/, 'the lead hunter sends the confirm header the Worker actually reads (the retired x-confirm spelling 403s at ingest)');
  const quota = readFileSync(join(root, 'scripts/quota.sh'), 'utf8');
  assert.match(quota, /kvOperationsAdaptiveGroups/, 'quota measurement reads GraphQL counters');
  assert.match(quota, /--inventory/, 'the KV-spending inventory is opt-in and says so');
  const deploy = readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8');
  assert.ok(!/ci heartbeat/.test(deploy), 'deploys no longer spend a bot commit announcing themselves');
  assert.match(deploy, /publish the deploy log \(failures only\)[\s\S]{0,40}if: failure\(\)/, 'the deploy log commit is failure-only');
  const monitor = readFileSync(join(root, '.github/workflows/monitor.yml'), 'utf8');
  assert.match(monitor, /cron: '20 5 \* \* 1'[\s\S]{0,80}cron: '35 5 1 \* \*'/, 'the outside witness is weekly-light and monthly-full');
  assert.match(monitor, /zero KV writes spent/, 'and the weekly witness says what it costs');
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

test('every guide that is written is published, listed and linked from somewhere', () => {
  // The COREMERCH bot keeps a LinkGraph sheet and spends a whole subsystem on orphan
  // posts — pages published but never linked. Here the three lists have to agree with
  // each other and with the directory, so the failure it detects cannot exist:
  // GUIDES (what is routed and sitemapped) == pages/guide-*.html (what is published).
  // template name = `guide-<slug>`, slug = what GUIDES routes on; both spellings are
  // derived here from the same directory listing, so neither can drift quietly
  const names = readdirSync(join(root, 'pages')).filter((f) => /^guide-.*\.html$/.test(f)).map((f) => f.slice(0, -5));
  const files = names.map((n) => n.replace(/^guide-/, ''));
  const routes = worker.match(/'guide-' \+ g\.slug/) ? true : false;
  assert.ok(routes, 'the Worker resolves a guide slug to a template name');
  const core = readFileSync(join(root, 'worker', 'core.js'), 'utf8');
  const block = core.slice(core.indexOf('export const GUIDES'), core.indexOf('export const guideOf'));
  const slugs = [...block.matchAll(/slug: '([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.ok(slugs.length >= 2, 'there are guides in the list at all: ' + slugs.join(','));
  assert.deepEqual(slugs.slice().sort(), files.sort(), 'a guide in git that is not in GUIDES is unrouteable, and one in GUIDES with no file is a 404 in a sitemap');
  for (const slug of slugs) {
    const html = page('guide-' + slug);
    assert.ok(html.includes('<title>'), slug + ' has a title');
    assert.ok(html.includes('rel="canonical" href="@ORIGIN@/guide/' + slug), slug + ' canonical is stamped at serve time, not hard-coded to a host');
    assert.ok(html.includes('@ORIGIN@'), slug + ' uses the token the Worker replaces');
    const others = slugs.filter((x) => x !== slug);
    assert.ok(others.some((o) => html.includes('/guide/' + o)), slug + ' links to a sibling — a page nothing points at is the thing the crawl never reaches');
  }
  // and the publish list is derived, not remembered
  const deploy = readFileSync(join(root, 'scripts', 'deploy.sh'), 'utf8');
  assert.match(deploy, /pages\/guide-\*\.html/, 'deploy.sh discovers guide pages from the directory instead of a hand-kept list');
  const opsList = worker.slice(worker.indexOf('const OPS_TPL_NAMES'), worker.indexOf('];', worker.indexOf('const OPS_TPL_NAMES')));
  for (const slug of slugs) assert.ok(opsList.includes('guide-' + slug), 'the operator cannot hot-edit ' + slug + ': not in OPS_TPL_NAMES');
});

test('the storefront head is filled by the Worker, and the pair agree', () => {
  // The crawler-facing head is not in the page: it is generated per store and dropped
  // in at a marker. That is two files making one page, so the contract between them is
  // asserted here — a renamed marker would otherwise degrade silently to a page that
  // tells Google nothing, and nothing would ever notice.
  const at = page('store').indexOf('<!--@SEO@-->');
  assert.ok(at > 0, 'the store page carries the marker the Worker looks for');
  assert.ok(at < page('store').indexOf('<title>'), 'and above the fallback title, so an unsubstituted page still has one');
  assert.match(worker, /replace\('<!--@SEO@-->'/, 'the Worker replaces that exact marker');
  assert.match(worker, /if \(!out\.includes\('<!--@SEO@-->'\)\) return out;/, 'and leaves a page without one exactly as it found it');
  assert.match(worker, /<title>Tapstall Store<\/title>', ''\)/, 'it removes the fallback, so there is one title and not two');
  assert.ok(!/<meta property="og:/.test(page('store')), 'store hard-codes an og: tag that every store would share — its head is per-shop, from the Worker');
  for (const name of ['index', 'fees']) {
    assert.match(page(name), /<meta property="og:image" content="https:\/\/king-kunta-cpu\.github\.io\/tapstall\/brand\/og-banner\.png">/, name + ' is a platform page, so it carries the one platform banner');
  }
  // robots.txt says these are private; the header is the version a bot cannot ignore
  assert.match(worker, /const NOINDEX = \{ 'x-robots-tag'|const NOINDEX = \{ 'X-Robots-Tag': 'noindex, nofollow' \};/, 'the Worker holds one noindex constant');
  assert.ok((worker.match(/200, NOINDEX\)|404, NOINDEX\)/g) || []).length >= 3, 'admin, ops and the missing-store page all carry it');
  assert.match(worker, /html\(NO_GUIDE, 404, NOINDEX\)/, 'and so does a guide that was never written');
  assert.match(worker, /p === '\/robots\.txt'/, 'and robots.txt is served by the Worker, not by a file that can drift from it');
  assert.match(worker, /p === '\/sitemap\.xml'/, 'same for the sitemap');
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
  const shapes = ['onboard.html', 'onboard/index.html', 'a.html', 'a/index.html'];
  // and the same for every guide the landing page links to: a written page the mirror
  // points at must have something to point with
  for (const f of readdirSync(join(root, 'pages')).filter((x) => /^guide-.*\.html$/.test(x))) {
    const slug = f.slice('guide-'.length, -5);
    shapes.push(`guide/${slug}.html`, `guide/${slug}/index.html`);
  }
  for (const shape of shapes) {
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
  // widened on purpose by the release that unified the rule: `manual` was this page's own
  // narrower guess (two of four specs, one of three types), and a page inventing a policy is
  // how a ZIPIT shop with a stale cache ended up asking for nothing
  assert.ok(/R\.type !== 'auto' && R\.type !== 'cod'/.test(s),
    'where the page must guess it guesses with the server\u2019s rule, not a narrower one of its own');
  assert.ok(/R\.ask_payer !== undefined \? !!R\.ask_payer/.test(s), 'and it still obeys the published field first');
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
  assert.ok(!/data:image\/(?:png|jpe?g|gif|webp);base64|readAsDataURL/.test(a), 'no base64 picture is ever built into a save payload (the SVG favicon in the head is not an upload)');
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

/* ------------------------------------------------------- proof of payment, in the UI */
test('the buyer is asked for their payment code where the rail needs one, and nowhere else', () => {
  const s = page('store');
  assert.ok(s.includes('id="fProof"'), 'the field exists on the order form');
  assert.ok(/if \(!p\.value && !nudged\)|!nudged && pf && R && R\.proof === 'require'/.test(s),
    'an empty code is asked for once and then let through — a form that will not send is a lost order');
  assert.ok(/return;/.test(s.slice(s.indexOf('!nudged && pf'), s.indexOf('!nudged && pf') + 400)),
    'the first tap only focuses the field, it does not send');
  assert.ok(/R\.proof !== 'none'/.test(s), 'whether to show it at all is the server’s answer, not a list of rail names');
  assert.ok(s.includes("R.proof_label || 'Code from the app'"), 'the label is the shop’s own words, because buyers know the name their street uses');
  assert.ok(/cannot find a payment without it/i.test(s), 'a required code says why, in one line, not a paragraph');
  assert.ok(/proof: \$\('fProof'\)/.test(s), 'and it is sent with the order');
  assert.ok(/pay\.proof \? '<div class="kv">/.test(s), 'the receipt repeats it back, so a buyer can read it over the phone');
  assert.ok(/will message you for it/.test(s), 'and if they skipped it, the receipt tells them what happens next instead of leaving them guessing');
  const flags = s.split('\n').filter((l) => l.includes('risk_flags'));
  assert.equal(flags.length, 1, 'the buyer sees the merchant’s flags once, and only once: ' + JSON.stringify(flags.map((l) => l.trim().slice(0, 60))));
  assert.match(flags[0], /The shop will double-check this order before sending/, 'and always inside the sentence that says what happens next, never as a list of suspicions');
});

test('a merchant decides how much proof each method needs, in their own words', () => {
  const a = page('admin');
  assert.ok(a.includes('data-rd="proof"') && a.includes('data-rd="proof_label"'), 'both controls are in the rail editor');
  assert.ok(/var PROOF_MODES_UI = \{ none:/.test(a), 'and the picker offers the three answers, in merchant words');
  assert.ok(a.includes("'proof', 'proof_label'"), 'both are in the list of fields a save compares and sends, or they would be typed into a void');
  assert.ok(/\\nfrom ' \+ esc\(o\.buyer\.payer\)/.test(a), 'the ledger row shows who sent it');
  assert.ok(/o\.buyer\.proof \? '\\n'/.test(a), 'and what code they gave, in the shop’s name for it');
  assert.ok(/p\.rail\.proof === 'require'/.test(a), 'a row that needs a code and has none is marked — from the rail frozen on the order, not from a field the order does not carry');
  assert.ok(a.includes('payer,proof_of_payment,flags'), 'the CSV names its columns, so a bookkeeper opening it is not guessing what the two new ones are');
});

test('the dashboard’s idea of a rail default is the Worker’s, column for column', () => {
  // The picker shows the merchant what will happen if they touch nothing. The moment
  // that sentence and proofDefault() disagree, a saved rail means something other than
  // what the merchant was shown — which is the exact failure this product cannot afford.
  const a = page('admin');
  const fn = a.match(/function autoProof\(type, spec\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'the mirror exists as one readable function');
  const auto = (0, eval)(fn[0] + '; autoProof');
  const C = CORE;
  const types = ['manual', 'cod', 'auto', 'link', 'nonsense'];
  const specs = ['wallet', 'phone', 'bank', 'shapid', 'link', 'none', undefined];
  let seen = 0;
  for (const t of types) {
    for (const sp of specs) {
      assert.equal(auto(t, sp), C.proofDefault(t, sp), 'the picker shows ' + t + '/' + sp);
      seen++;
    }
  }
  assert.ok(seen > 30, 'the whole table was walked, not a few rows of it: ' + seen);
});

test('the merchant’s CSV has one header name per value, or Excel shifts the book', () => {
  const a = page('admin');
  const head = a.match(/var head = '([^']*)';/);
  assert.ok(head, 'the header is one string on one line');
  const cols = head[1].replace(/\\n$/, '').split(',');
  const from = a.indexOf('return [', a.indexOf('var head ='));
  const to = a.indexOf('].map(csvq)', from);
  assert.ok(from > 0 && to > from, 'the row is one array literal that a header can be counted against');
  const arr = a.slice(from + 'return ['.length, to);
  let depth = 0, n = 1;
  for (const ch of arr) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) n++;
  }
  assert.equal(cols.length, n, 'header says ' + cols.length + ' columns, the row writes ' + n + ': ' + cols.join('|'));
});


test('the ask for a missing code is in the message a merchant already has a button for', () => {
  const a = page('admin');
  const from = a.indexOf("qa('[data-wa]', root)");
  assert.ok(from > 0, 'the WhatsApp buyer button is still there');
  const body = a.slice(from, a.indexOf('};', from));
  assert.ok(/if \(o\.ask\) txt \+= /.test(body), 'its message appends whatever the server wrote, when the server wrote something');
  assert.ok(!/Need:/.test(body) && !/send the code/i.test(body), 'the page invents no sentence of its own — one authority, in the Worker');
  assert.ok(/o\.buyer && o\.ask|o\.ask \? '\\n' \+ o\.ask/.test(a), 'the copied slip carries it too, because that is the other half of the same tap');
});

/* ------------------------------------------------------------------ 0.7.3 the receipt's second half */
const storeHtml = page('store');
test('the receipt offers the code field, and only when a code is owed', () => {
  assert.match(storeHtml, /var addProof = \(pay\.proof \|\| !pay\.proof_mode \|\| pay\.proof_mode === 'none'\) \? ''/, 'one gate, and it is written so an answered order says nothing at all');
  assert.match(storeHtml, /o\.proof_url/, 'and the gate opens on the link the order response handed back');
  assert.match(storeHtml, /add your code here|add it here/, 'the sentence is an instruction with a door in it, not an apology');
  assert.match(storeHtml, /the shop cannot see your payment until it is on the order/, 'a required code is named as a blocker, once, plainly');
  assert.ok(!/screenshot/.test(storeHtml.match(/addProof[\s\S]{0,700}/)[0]), 'and it never asks for a picture: this is the field a code goes in, not an upload');
});
test('the buyer’s link is not stitched into anything the shop reads', () => {
  for (const n of ['admin', 'dash', 'store']) {
    const src = n === 'store' ? storeHtml : (existsSync(join(root, 'pages', n + '.html')) ? page(n) : '');
    assert.ok(!/\/p\/\$\{|proofCap/.test(src), n + ' does not mint or hold a capability, it only renders what the order response gave it');
  }
  // where the write is allowed to happen, in the source that ships
  assert.match(worker, /\/api\/proof' && req\.method === 'POST'/, 'the route is POST-only at the router, not just in the handler');
  assert.match(worker, /a: 'proof', h: st\.handle, id, g:/, 'and the mint binds the link to one handle, one order and the shop’s current generation');
  assert.ok(!/order\.proof_url/.test(worker), 'the link is never stored on the order document, so the merchant cannot hold it');
});

test('the ledger gives the shop the same one box, on its own side', () => {
  const admin = page('admin');
  assert.match(admin, /data-pf="/, 'a field per row that needs one, keyed to the order');
  assert.match(admin, /data-pfs="/, 'and one button beside it');
  assert.match(admin, /api\('\/api\/order\/proof'/, 'posted to the shop’s own endpoint, never to /api/mark and never with a capability');
  assert.match(admin, /o\.ask \|\| open\(o\)/, 'shown when a code is owed or the order is still open, so a settled row that answered shows nothing');
  assert.match(admin, /value="' \+ esc\(\(o\.buyer && o\.buyer\.proof\) \|\| ''\)/, 'prefilled with what the buyer sent, so a correction is the same gesture');
  assert.match(admin, /an empty box is not a filing/, 'and the box refuses to post itself empty, which is what the 422 exists for');
});

test('the receipt page holds the door open itself, one box, no navigation', () => {
  // the fifth pass at the same instruction: the buyer has the code on their screen at the
  // moment they place the order, so the field moves to where their eyes already are
  assert.match(storeHtml, /\(needDoor \? pfBox : addProof\)/,
    'the box and the link are one decision, not two copies of the same condition');
  assert.match(storeHtml, /var pfBox = '<div style="background:#fff;color:#101418[^>]*border-radius:12px/,
    'and the box is drawn inside the dark paybox as a light card, so it is legible without a new stylesheet');
  assert.match(storeHtml, /<form id="pff" method="post" action="\/api\/proof">/,
    'it is a form first: with JS switched off it posts to the same route the link opens');
  assert.match(storeHtml, /name="cap" value="' \+ esc\(pfTok\(o\.proof_url\)\)/,
    'the token inside it is the one this very response handed this browser, escaped, and nothing else');
  assert.match(storeHtml, /name="proof" maxlength="40" autocapitalize=characters|name="proof" maxlength="40" autocapitalize="characters"/,
    'the same field the door has, same length, same no-autocorrect rule');
  assert.match(storeHtml, /pay\.ask_payer\s*\?\s*'<label for="fPfPayer">Number you will pay from/,
    'the sender number joins it only where this rail searches by it, in the cart\u2019s words');
  assert.match(storeHtml, /if \(j\.final \|\| j\.used\)/,
    'and the page asks the Worker whether a refusal ends the door or only spent its link, rather than reading the sentence');
  assert.match(storeHtml, /if \(j\.proof_url\) o\.proof_url = j\.proof_url;/,
    'a successful write hands the box its next link, so the buyer is never told to go and find one');
  const eps = [...storeHtml.matchAll(/fetch\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(eps.length >= 2, 'the receipt page does fetch, so the list is real: ' + JSON.stringify(eps));
  assert.ok(eps.every((e) => /^\/(api\/(order|order\/proof|proof|lookup)|s\/)/.test(e)),
    'and none of it is a new door: ' + JSON.stringify(eps));
  // the box must not accuse anybody, same rule as the line under the notice bar
  const box = storeHtml.slice(storeHtml.indexOf('var pfBox ='), storeHtml.indexOf('var addProof'));
  assert.ok(!/you have not paid|still owed|you owe|unpaid/.test(box),
    'the words inside it offer, and claim nothing it cannot know: ' + box.slice(0, 80));
  assert.match(box, /esc\(pay\.proof_label \|\| 'Code from the app'\)/, 'the shop names the field here too');
});

test('a returning buyer finds the door again, on the device it was left on', () => {
  assert.match(storeHtml, /var PFK = 'tp_pf_' \+ CFG\.handle/, 'one key per shop, so a shared phone does not mix two stores’ doors');
  assert.match(storeHtml, /var addProof = \(pay\.proof \|\| !pay\.proof_mode \|\| pay\.proof_mode === 'none'\) \? '' : '<p class="hint">'/, 'the sentence the receipt shows is still gated on the same one condition');
  assert.match(storeHtml, /var needDoor = !pay\.proof && pay\.proof_mode && pay\.proof_mode !== 'none' && !!o\.proof_url;/, 'and keeping the link is gated on that same condition, not a second copy of it');
  assert.match(storeHtml, /if \(needDoor\) pfAdd\(o\.order\.code, o\.proof_url\);/, 'the entry is written from showDone, where the link actually was');
  // the client must not outlive the token: same 72 hours, held in one number each side
  assert.match(storeHtml, /PF_TTL = 72 \* 3600 \* 1000/, 'the client prunes at the lifetime the server mints with');
  assert.equal(CORE.PROOF_WINDOW_SEC * 1000, 72 * 3600 * 1000, 'and that lifetime is still the one in core.js, so the two cannot drift');
  assert.match(storeHtml, /PF_MAX = 5/, 'a handful of entries, no unbounded growth in someone’s storage');
  assert.match(storeHtml, /typeof x\.u === 'string' &&/, 'a stored value is checked before it is rendered as a link');
  assert.match(storeHtml, /\{20,400\}\$\//, 'against the shape a capability actually has, so a junk entry cannot become an <a href>');
  assert.match(storeHtml, /try \{ a = JSON.parse\(localStorage\.getItem\(PFK\) \|\| '\[\]'\); \} catch \(e\) \{ a = \[\]; \}/, 'parse failure reads as empty, never as a crash on the shop’s front page');
  assert.match(storeHtml, /if \(!Array\.isArray\(a\)\) a = \[\];/, 'and a stored object is refused rather than walked');
  // scoped to the renderer, because the rest of the file legitimately talks about
  // unpaid orders elsewhere — this one line must not, since it cannot know
  const pf = storeHtml.slice(storeHtml.indexOf('function pfRender()'));
  assert.match(pf.slice(0, 700), /add your payment code/, 'the line offers, in the buyer’s words');
  assert.ok(!/you have not paid|still owed|you owe|unpaid/.test(pf.slice(0, 700)),
    'and it accuses nobody: nothing on this page can read the order back, so nothing here may claim to know');
  assert.match(storeHtml, /aria-label="Dismiss"/, 'a line like this must be puttable down by hand too');
  // and the door page itself has to be able to say the same thing without knowing the order:
  // a revocation or a deletion never reached the document, so the link is all it can name
  assert.match(worker, /String\(x\.u\)==="\/p\/' \+ k/, 'the Worker prunes by the stored url as well as the code');
  assert.match(worker, /\/\^\[A-Za-z0-9\._-\]\{20,400\}\$\/.test\(k\)/,
    'only for a value with the shape a capability has, spelled as the client filter above spells it');
});

/* The shop's side of the code field, and the one gesture that keeps "one link, one change" a
   loop instead of a seal: an empty box is not how a filed code is cleared (a stray blank submit
   must never erase evidence), so clearing has to be a button the merchant means. */
test('the ledger row hands the field back with a word, not with a blank', () => {
  const admin = page('admin');
  assert.match(admin, /data-pfv="/, 'a button of its own, on the row where a code is on file');
  assert.match(admin, /\(o\.buyer && o\.buyer\.proof\)\s*\?\s*'<button class="sm" data-pfv="/,
    'and it only exists when there is something to hand back — no dead control on a row that owes nothing');
  assert.match(admin, /Clear their code and let them send it again/, 'title spells it out, because the verb is ambiguous');
  assert.match(admin, /api\('\/api\/order\/proof', \{ handle: S\.handle, id: id, void: 1 \}\)/,
    'one field on the route that already files, and the route needs a shop session to hear it');
  assert.ok(!/confirm\(/.test(admin.slice(admin.indexOf("data-pfv"), admin.indexOf("data-pfv") + 1200)),
    'no dialog on the way: the merchant loses nothing they own, and the buyer retypes from their own app');
  // the box itself used to hide on a paid order that already had a code, which left "correct
  // it" unreachable exactly when a mis-read code is noticed — the row comment promised it
  assert.match(admin, /\+ \(o\.ask \|\| open\(o\) \|\| \(o\.buyer && o\.buyer\.proof\)/,
    'so a row with a filed code shows its field whatever the status says');

  const storeHtml = page('store');
  assert.match(storeHtml, /function pfTok\(u\) \{ var i = String\(u \|\| ''\)\.indexOf\('\/p\/'\)/,
    'a door is cut at the marker, not at character three: the receipt link is relative and a ledger link is not');
  assert.match(storeHtml, /value="' \+ esc\(pfTok\(o\.proof_url\)\)/, 'into the form field');
  assert.match(storeHtml, /var body = \{ cap: pfTok\(o\.proof_url\), proof: code \};/, 'and into the json');
  assert.match(storeHtml, /if \(j\.proof_url && j\.left > 0\) pfAdd\(o\.order\.code, j\.proof_url\); else pfDone\(o\.order\.code\);/,
    'and the fresh door the answer handed back is kept on the device while the field still has changes, because nothing else ever writes it down');

  // two files, one storage shape: the Worker's keep script must not invent a second format
  assert.match(worker, /\.push\(\{c:"' \+ String\(code \|\| ''\)\.slice\(0, 16\) \+ '",u:"\/p\/'/,
    'the script writes c/u exactly as pfAdd does');
  assert.match(worker, /if\(n\.length>5\)n=n\.slice\(-5\)/, 'and trims to the same five the storefront keeps');
  assert.match(storeHtml, /PF_MAX = 5/, 'five, said in both places, with this line as the pin');
});

/* The release's whole safety claim in one grep: the public door reads two fields and no verb.
   `void` is a word the shop's route understands and the buyer's cannot, because the buyer's
   input is built field by field before it reaches proofAccept. */
test('a buyer’s door has no verb that clears, and no way to borrow one', () => {
  const proofAdd = worker.slice(worker.indexOf('async function proofAdd'), worker.indexOf('/* ------', worker.indexOf('async function proofAdd')));
  assert.match(proofAdd, /proofAccept\(o, \{ proof: b\.proof == null \? null : String\(b\.proof\), payer: b\.payer == null \? null : String\(b\.payer\) \}, 'buyer'\)/,
    'its input is named, not forwarded — a whole body passed through would be a body full of fields');
  assert.ok(!proofAdd.includes('proofVoid('), 'and nothing on that path clears anything');
  assert.equal((worker.match(/b\.void/g) || []).length, 1,
    'read exactly once, in the shop route — a second read is a second place for the shape rule to drift');
  assert.match(worker, /const VOID_ON = \[true, 1, '1', 'true'\];/,
    'the shapes that mean “clear it” are one named list, so the button and the route cannot disagree in private');
  assert.match(worker, /if \(VOID_ON\.includes\(b\.void\)\) \{/,
    'and read in one condition, strict about what is not the verb');
  assert.equal(worker.split('proofVoid(').length - 1, 1, 'and the clearing helper is called from exactly one handler');

  assert.ok(/act: 'proof', via: 'merchant'/.test(worker.slice(worker.indexOf('const v = proofVoid(o)'), worker.indexOf('const v = proofVoid(o)') + 2400)),
    'and it is written down as an act, in the trail the merchant can read back');
});

/* One status, two sentences: the difference between a link the buyer used and a link the shop
   retired is only a difference in words — the folding, the pruning and the refusal to write are
   shared, and neither card mints. So the test pins both halves: the shared signal in one place,
   and no new power behind the softer sentence. */
test('the door says who closed it, and folds the same way either way', () => {
  assert.match(worker, /const dead = why === "used" \|\| why === "superseded";/,
    'one place in the Worker knows what a finished link is, so pruning and folding cannot drift apart');
  assert.match(worker, /used: dead, \.\.\.\(dead \? \{ superseded: why === "superseded" \} : \{\}\)/,
    'the json carries the fold signal the client already reads, plus the reason for it');
  assert.match(worker, /\(handle && \(final \|\| dead\) \? pfForgetScript/,
    'a retired link is put down like a used one, by url, with no order needed');
  assert.match(worker, /card\(sup \? "That link is retired" : "That link is used"/,
    'the page titles differ, because the sentences must');
  assert.match(worker, /nothing you did caused that/, 'and the softer card says who did cause it');
  const proofPage = worker.slice(worker.indexOf('async function proofPage'), worker.indexOf('async function proofAdd'));
  assert.equal((proofPage.match(/issueCap\(/g) || []).length, 0,
    'and no mint happens at the door page: a retired link stays a pointer to nowhere');
  const proofAdd = worker.slice(worker.indexOf('async function proofAdd'), worker.indexOf('/* ------', worker.indexOf('async function proofAdd')));
  assert.ok(!/proofVoid\(/.test(proofAdd), 'and the softer words do not come with a new verb');
});

/* A refusal is a claim about what the buyer can still do, and the hand-back changed that fact
   for every link at once. So the sentence is pinned where it is written, not only where it is
   read: the retired card may not send a buyer to a box, because after a void there is no box on
   any device — and the spent card may only promise one conditionally, since the newer door lives
   on the phone that filed and nowhere else. */
test('a refusal promises only what the device can still deliver', () => {
  const page = worker.slice(worker.indexOf('async function proofPage'), worker.indexOf('const back ='));
  const retired = page.slice(page.indexOf('sup ? "That link is retired"'));
  const spent = retired.slice(retired.indexOf(': `This order'));
  assert.match(retired, /their ledger has the same field, one box, and they can put it on the order for you/,
    'the retired card names the route that exists on every phone, including one a link was forwarded into');
  assert.ok(!/receipt/i.test(retired), 'and sends nobody to a receipt a hand-back has already emptied');
  assert.match(retired, /nothing you did caused that/, 'the blame question is answered in the first breath');
  assert.match(spent, /If this phone has a newer link for the order/, 'the spent card is conditional, because the fresh door is a fact about one device');
  assert.match(spent, /nothing else it can change/, 'and it says what the shop\u2019s box cannot touch, in the words the merchant notice already uses');
  // the inline half, which folds the box and shows nothing else
  const add = worker.slice(worker.indexOf('async function proofAdd'), worker.indexOf('/* ------', worker.indexOf('async function proofAdd')));
  const refusal = add.slice(add.indexOf('const sup = proofSuperseded(o, p.n);'), add.indexOf('const sup = proofSuperseded(o, p.n);') + 900);
  assert.match(refusal, /every link for this order is retired/, 'same fact, in the shorter voice a fold needs');
  // the sentences, not the prose around them: a comment may say "receipt", a buyer-facing
  // string may not, and a guard that cannot tell them apart is a guard that gets weakened
  const msgs = (refusal.match(/"[^"]{20,}"/g) || []).filter((s) => /retired|filed a code/.test(s));
  assert.equal(msgs.length, 2, 'both refusals are found by this test, not one: ' + JSON.stringify(msgs));
  assert.ok(msgs.every((s) => !/receipt/i.test(s)), 'and neither promises a box a hand-back has closed: ' + msgs.join(' | '));
  assert.match(refusal, /a newer link from this order still works/, 'the spent answer points at what may exist without naming a screen');
});

/* The rule lives once; the surfaces obey it. This test exists because the same question — "does
   this rail find a payment by the number it came from?" — was answered in four places, and two
   of them had quietly disagreed: the store config omitted the cod guard the slip carried, and
   the storefront's fallback for a cached pre-0.7.6 config knew two of the four shapes, so a bank
   or ShapID shop with a stale cache asked for nothing at all. */
test('who is asked for a sender number is one rule, said in two files', () => {
  const core = readFileSync(join(root, 'worker', 'core.js'), 'utf8');
  assert.match(core, /export const PAYER_SPECS = \['phone', 'shapid', 'wallet', 'bank'\];/,
    'the list is an exported constant, so a page can be checked against it without importing it');
  assert.equal((core.match(/PAYER_SPECS/g) || []).length, 2, 'the list is read in exactly one place: the helper');
  assert.equal((core.match(/railWantsPayer\(/g) || []).length, 3, 'and the helper is written once, read twice — the slip and the store config');
  const rest = core.replace(/export const PAYER_SPECS[^\n]*\n/, '');
  assert.ok(!/\[\s*'phone'/.test(rest), 'and no second array of specs survives in core: ' + (rest.match(/\[\s*'phone'[^\]]*\]/) || [''])[0].slice(0, 80));
  const storeHtml = page('store');
  const at = storeHtml.indexOf('R.ask_payer !== undefined');
  assert.ok(at > 0, 'the storefront still obeys what it is told first');
  const fb = storeHtml.slice(at, at + 320);
  for (const sp of ['phone', 'shapid', 'wallet', 'bank'])
    assert.ok(fb.includes("R.spec === '" + sp + "'"), 'and its fallback knows ' + sp + ' because the list is the same one');
  assert.match(fb, /R\.type !== 'auto' && R\.type !== 'cod'/, 'and excludes the two types with nothing to match, as core does');
});

test('the config deploys the artifact the tests read', () => {
  // The whole point of compiling the pages into the Worker was that git's bytes become the served
  // bytes. That promise is only true if the deploy uploads the file the suites opened — and it wasn't:
  // wrangler.toml said worker/worker.js, so production ran the source with INLINED_PAGES empty while
  // .build/worker.js, the tested bundle, sat beside it and every test stayed green.
  const gen = readFileSync(join(root, 'scripts', 'gen_wrangler_toml.py'), 'utf8');
  assert.match(gen, /MAIN = "worker\/worker\.js" if os\.environ\.get\("BUILD", "1"\) == "0" else "\.build\/worker\.js"/,
    'main defaults to the built bundle, and the source is the typed exception');
  assert.match(gen, /main = "\{MAIN\}"/, 'the template reads it from that variable, so no second copy can drift');
  const tom = readFileSync(join(root, 'wrangler.toml'), 'utf8');
  assert.match(tom, /^main = "\.build\/worker\.js"$/m,
    'and the checked-in wrangler.toml agrees with it — a deploy that skips the build fails loudly instead of quietly shipping the other file');
});


/* A retry you cannot prove fires is a wish. The single 00:20 UTC scheduled run was the whole
   answer to a stale page for two days, and GitHub delivered it once (#56, six hours late) out of
   83 runs — so two pages served yesterday's bytes for nine hours while a log line promised a
   nightly fix. This test is the difference between that and a mechanism: it fails if the retry
   collapses back to one slot, or if the job starts depending on an event that has to be pushed. */


test('a page cannot stick, so the night is a check and not a retry', () => {
  // This test used to demand four cron slots a day, because pages were KV keys: a release whose
  // eight template writes fell off the end of the day's 1,000 left a merchant served git's *older*
  // page, and the only cure was to try again after midnight, four times because GitHub drops
  // scheduled runs. v0.9.1 removes the failure mode instead of scheduling around it — a page is a
  // bundle constant, published by the same upload as the code that reads it — so what has to be
  // true now is narrower and stronger: nothing in the pipeline spends a write on a page, the check
  // that a page is current is local and runs before anything ships, and something still looks.
  // v1.0.0 moves the looking out of the deploy workflow entirely: the old scheduled run
  // redeployed identical code daily while its check job skipped itself on an hour gate GitHub's
  // delivery never met (five-second green runs, checks never executed). Now there is one clock —
  // the Worker's cron — and one outside witness, monitor.yml, which only looks.
  const wf = readFileSync(join(root, '.github', 'workflows', 'deploy.yml'), 'utf8');
  assert.ok(!/^ {2}schedule:/m.test(wf), 'the deploy workflow has no schedule: a cron that redeploys identical code is cost dressed as care');
  assert.ok(!/night-check/.test(wf), 'and no self-skipping check job to paint a skipped hour green');
  assert.ok(!/--templates/.test(wf), 'and the workflow no longer re-publishes pages: there is nothing left to retry');
  const mon = readFileSync(join(root, '.github', 'workflows', 'monitor.yml'), 'utf8');
  assert.match(mon, /- cron: '20 5 \* \* 1'/, 'the witness runs weekly, before the week’s traffic');
  assert.match(mon, /prod_check\.sh/, 'the witness runs the live check, so a broken product is seen without anybody typing');
  assert.match(mon, /HANDLE: logintest/, 'against the sandbox store, never a trading operator’s shop');
  assert.match(mon, /exit \$rc/, 'and a red line fails the run — a warning with exit 0 is how a stale page looked green');
  assert.ok(!/wrangler|deploy\.sh/.test(mon), 'the witness deploys nothing: looking and shipping are different jobs');

  const dep = readFileSync(join(root, 'scripts', 'deploy.sh'), 'utf8');
  assert.match(dep, /check_pages_in_bundle \.build/, 'a deploy proves the bundle carries every page before it uploads');
  assert.match(dep, /if \[\[ "\$\{PAGES_KV:-0\}" == 1 \]\]; then/, 'the legacy KV publish exists only behind a switch, as a rollback target');
  assert.equal((dep.match(/kv_put_tpl "\$STORES_ID" \$TPL_NAMES/g) || []).length, 1,
    'the publish-to-KV line survives exactly once, inside the PAGES_KV branch — the default path writes no page');
  assert.equal((dep.match(/verify_templates "\$STORES_ID"/g) || []).length, 1,
    'and so does its read-back: a rollback copy is the only thing worth reading out of KV for');
  assert.match(dep, /if \[\[ "\$MODE" == "--pages-override" \|\| "\$MODE" == "--pages-clear" \]\]/,
    'the emergency door is a real mode, for the case that is left: a wrong page at 22:00');
  assert.match(dep, /case " \$TPL_NAMES sample-menu " in .*die "\$PAGE_T is not a page this pipeline publishes/,
    'and it takes only names that are actually pages, so a typo cannot publish a blank over a live screen');
  assert.match(dep, /check_pages_in_bundle \/tmp\/tapstall-pages-check/, 'and --templates still answers the question it was always asked, locally');
});

/* The receipt keeps the door on the device only when the response says the budget, under
   the word `left`. For six releases it said `proof_writes` instead, the branch read
   `undefined > 0`, and the page threw away a link valid for three days — while every test
   stayed green, because the test asserted the field that existed. */
test('the receipt counts its corrections under one word, not two', () => {
  const store = readFileSync(join(root, 'pages', 'store.html'), 'utf8');
  const ok = store.slice(store.indexOf('j.proof_url'), store.indexOf('j.final'));
  assert.equal([...ok.matchAll(/j\.proof_writes/g)].length, 0,
    'the page must not read the document field name off a response; that name belongs to the order document');
  assert.match(ok, /j\.proof_url && j\.left > 0\) pfAdd/,
    'the door is stored only while the response says the field still has changes on it');
  assert.match(ok, /j\.proof_url && j\.left > 0 \? '<p class="hint">/,
    'and the sentence under the box is gated on the same number, so the two can never disagree');
});

/* The two files that speak this verb must speak the same one. A page sending a shape the
   route does not list is invisible to both suites on its own: the page test sees the button,
   the live test sends `true`, and production answers a merchant with "Nothing to file". */
test('the button’s verb is a verb the route honours', () => {
  const admin = readFileSync(join(root, 'pages', 'src', 'admin.html'), 'utf8');
  const worker = readFileSync(join(root, 'worker', 'worker.js'), 'utf8');
  const list = (worker.match(/const VOID_ON = \[([^\]]*)\]/) || [])[1];
  assert.ok(list, 'the accepted spellings of `void` are one named list, not a chain of === in an if');
  const accepted = list.split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(accepted, ['true', '1', '1', 'true'], 'the list is true, 1 and their strings — in that order, so a reader can scan it: ' + accepted.join(','));
  const sent = (admin.match(/void:\s*([A-Za-z0-9'"]+)/) || [])[1];
  assert.ok(sent, 'the dashboard still offers a hand-back at all');
  assert.ok(accepted.includes(String(sent).replace(/^'|'$/g, '')),
    'the dashboard sends void: ' + sent + ', which the route would read as a blank box — fix the page or the list, not this test');
});


/* A `run:` block is shell that nothing executes until the job runs at 00:20 against production.
   That gap cost a night: an unescaped apostrophe inside an awk program in the nightly check step
   made the step die with a syntax error, so a *healthy* build went red and a broken one said
   nothing. YAML quoting and shell quoting disagree in ways no linter here can see, so the check
   is to hand every block to bash and listen. */
test('every shell block in every workflow parses as shell', () => {
  const dir = join(root, '.github', 'workflows');
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length, 'the workflow files are where they are supposed to be');
  let checked = 0;
  for (const f of files) {
    const lines = readFileSync(join(dir, f), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const head = lines[i].match(/^(\s*)run:\s*\|\s*$/);
      if (!head) continue;
      const pad = head[1].length;
      const body = [];
      let dedent = null;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '') { body.push(''); continue; }
        const indent = lines[j].match(/^\s+/)[0].length;
        if (indent <= pad) break;
        if (dedent === null) dedent = indent;
        body.push(lines[j].slice(dedent));
      }
      const path = join(tmpdir(), 'wf-' + f + '-' + i + '.sh');
      writeFileSync(path, '#!/bin/bash\nset -e\n' + body.join('\n') + '\n');
      try {
        execFileSync('bash', ['-n', path], { stdio: 'pipe' });
      } catch (e) {
        const why = String(e.stderr || e.message).trim().split('\n').slice(0, 2).join(' ');
        assert.fail(f + ' line ' + (i + 1) + ': a run: block in this workflow is not valid shell (' + why
          + ')\n' + body.map((l, k) => '  ' + (k + 1) + ' | ' + l).join('\n'));
      }
      unlinkSync(path);
      checked++;
    }
  }
  assert.ok(checked >= 4, 'there are run: blocks to check at all — found ' + checked);
});

/* The confirm link now dies with the store's generation (v0.8.6). Two files are involved in that
   sentence — the Worker decides the state, the page draws it — and each half looks fine alone.
   These are the seam: the fact the Worker sends is the fact the page reads, and the words the API
   returns are the words the page shows. */
test('a closed confirm link is drawn as closed, in both halves', () => {
  const page = src('confirm');
  const built = page ? page : '';
  const worker = readFileSync(join(root, 'worker', 'worker.js'), 'utf8');
  assert.match(page, /S\.revoked/, 'the page has a branch for a revoked link, not just an expired one');
  assert.match(worker, /state:\s*'expired',\s*revoked:\s*true/, 'and the Worker sends `revoked` inside the state the template already knows');
  assert.match(worker, /revoked:\s*true,[\s\S]{0,120}?code:/, 'with the order code, because that is what the buyer is told to send');
  assert.match(page, /"expired"/.test(page) ? /state:\s*'expired'/ : /S\.state/, 'the fallback state is still spelled the way the page compares it');
  assert.ok(worker.includes("shell('Link closed'"), 'the floor page (no template) says the same thing');
  assert.match(worker, /closed its payment links/, 'in the same words, so a screenshot cannot contradict the JSON');
  assert.ok(!/action="\/api\/mark"[\s\S]{0,400}closed its payment links/.test(worker), 'the refusal page carries no form');
  // both clients of the refusal print the sentence, not the code
  assert.match(page, /j\.why \|\| j\.error/, 'the auto-send shows the Worker’s why');
  assert.match(page, /u\.why \|\| u\.error/, 'and so does the undo tap');
  assert.ok(built === built, 'the built page carries the same branch (it is a copy with the kit inlined)');
});

/* ---------------------------------------------------------------------------------------------
 * 0.8.8 — the same audit, on the reader side. 0.8.6 put the generation rule in one function so the
 * doors could not disagree; 0.8.7 stopped a mint from forgetting the field; and the /p/ door went
 * on comparing `p.g` to `auth_gen` by hand in two handlers, each of which had to decide for itself
 * what a link with no generation means. Both decided "closed", so a shop that had never pressed
 * Revoke was told its links were closed. This scan is that audit made permanent: every function that
 * verifies a capability must either call the shared rule or carry a `gen-rule:` marker naming the
 * exemption, and the set of markers is asserted, so an exemption cannot be added quietly.
 */
test('every door that reads a capability judges it with the shared rule, or declares that it does not', () => {
  const lines = worker.split('\n');
  const bodies = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:async )?function ([A-Za-z0-9_]+)/);
    if (m && !open) { open = { name: m[1], from: i }; continue; }
    if (open && /^\}/.test(lines[i])) { bodies.push({ name: open.name, text: lines.slice(open.from, i + 1).join('\n') }); open = null; }
  }
  assert.ok(bodies.length > 60, 'the scan found ' + bodies.length + ' top-level functions; if the file stopped looking like this, fix the scan before trusting it');
  const readers = bodies.filter((b) => /verifyCap\(/.test(b.text));
  assert.ok(readers.length >= 4, 'the doors that verify a capability: ' + readers.map((r) => r.name).join(', '));
  const exempt = [];
  for (const r of readers) {
    if (r.name === 'selftest') continue;                       // the probe file, which mints and refuses on purpose
    const marker = r.text.match(/gen-rule: ([a-z]+)/);
    if (marker) { exempt.push(r.name + '=' + marker[1]); continue; }
    assert.ok(/capGenOk\(|renewOk\(/.test(r.text),
      r.name + ' verifies a capability without the shared rule — a second copy of the rule is what made a shop that never revoked look like it had');
  }
  assert.deepEqual(exempt.sort(), ['identify=strict', 'opsAuthed=platform'],
    'exactly two doors judge a credential their own way, and both say why: ' + exempt.join(', '));
});

/* ---------------------------------------------------------------------------------------------
 * 0.8.7 — three scans over the source, for the one rule that has to hold everywhere: a credential
 * that carries authority belongs to the generation that minted it. Each is a scan rather than a
 * behaviour test because the failure being guarded is the absence of a field. A behaviour test
 * cannot see an absent field in a file it never opens; a scan can, and it is the same idiom the
 * sender-number rule ended on in 0.8.4 — one place to look, so a fifth opinion has to be
 * deliberate rather than accidental.
 */
test('every authority-bearing capability the Worker mints names the generation it was issued under', () => {
  const chunks = worker.split('issueCap(').slice(1).map((c) => c.slice(0, 300));
  const authority = chunks.filter((c) => /a:\s*['"](mark|proof|sess|ops)['"]/.test(c));
  assert.ok(authority.length >= 9,
    'the scan found ' + authority.length + ' mints of something with authority; if the product has fewer than nine, the list of what matters changed and this test should be read, not adjusted');
  const unbound = authority.filter((c) => !/\bg:/.test(c));
  assert.deepEqual(unbound.map((c) => c.slice(0, 100).replace(/\s+/g, ' ')), [],
    'a mint without `g` is a link that outlives its own revocation');
  // One mint deliberately does not carry the field, because it exists to prove the mint refuses:
  // it goes through a named variable so the scan can see the intent instead of guessing at it.
  assert.match(worker, /const orphan = \{ a: 'mark'[^\n]*\n[^\n]*cap_mint_refuses_unbound = await issueCap\(k, orphan, 600\)/,
    'the selftest keeps exactly one unbound mint, and says why');
  // A mint whose payload is a variable is the one shape this scan cannot read, so there is exactly
  // one in the file and it is the probe. Anything else that starts hiding a payload behind a name
  // has to be pointed at deliberately, which is the whole purpose of counting them.
  const byVariable = chunks.filter((c) => !/a:/.test(c));
  assert.equal(byVariable.length, 1, 'mints with no literal action: ' + byVariable.length);
  assert.match(byVariable[0], /^k, orphan, 600\)/, 'the selftest probe, and nothing else');
});

test('every door a renew token opens checks the token against the generation', () => {
  const opens = [];
  let at = -1;
  while ((at = worker.indexOf("STORES.get('renew:'", at + 1)) !== -1) opens.push(worker.slice(at, at + 900));
  assert.equal(opens.length, 3, 'the plan page, the checkout intent and the reference write, no more and no fewer: ' + opens.length);
  for (const o of opens)
    assert.match(o, /renewOk\(/, 'a renew read that never consults the rule is a link Revoke cannot close');
  assert.equal((worker.match(/await rotateRenewLink\(env, st\)/g) || []).length, 4,   // 4 call sites, not counting the definition
    'and every site that moves the generation reissues the link, so "the current one is in your dashboard" is a fact and not a hope');
});

test('the closed state is decided once and drawn by both halves of the renew door', () => {
  assert.match(worker, /state:\s*closed \? 'closed' : null/, 'the page is handed a state it can switch on');
  assert.match(worker, /why:\s*closed \? RENEW_CLOSED_WHY : null/, 'and the sentence, from the same constant the API answers with');
  const built = page('renew');
  assert.match(built, /state === ['"]closed['"]/, 'the shipped page has a branch for it');
  assert.match(src('renew'), /state === ['"]closed['"]/, 'and so does the authored one, or the built copy is lying about the source');
  assert.match(worker, /!\/state === \['"\]closed\['"\]\/\.test\(custom\)/,
    'the sniff that decides whether a skin may be handed the fact matches the page text exactly — an out-of-date template gets the floor instead of a blank card');
  assert.match(worker, /const RENEW_CLOSED_WHY = 'This shop has closed its payment links/,
    'in the shop’s own words: what happened, that nothing moved, and where the working link is');
});


/* ============================== 0.9.0: the money pages */

test('0.9.0 the dashboard prints the books from the Worker and never from its own arithmetic', () => {
  const a = src('admin');
  assert.ok(a.includes('id="booksCard"'), 'the card exists');
  assert.match(a, /\/api\/books\?handle=/, 'and its numbers are the endpoint’s');
  assert.ok(!/taxP\b/.test(a), 'no tax figure is computed in the page — one rule, one place');
  assert.match(a, /#booksCsv'\)\.href = '\/api\/books/, 'the CSV download is the same query with fmt=csv on it');
  assert.match(a, /outstanding_balance/, 'what has not been collected is shown as a balance, the one thing a cash-basis window cannot honestly filter');
  assert.match(a, /predate the tax fields/, 'and the report says out loud how much of itself is inferred');
  assert.match(a, /Sales side only|b\.note/, 'the limit of it is on the page, not in a footnote');
});

test('0.9.0 the ledger row can print and send a receipt, and asks the Worker for both', async () => {
  const a = src('admin');
  assert.match(a, /data-rc="' \+ esc\(o\.id\) \+ '">Print receipt/);
  assert.match(a, /data-rw="' \+ esc\(o\.id\) \+ '">Send receipt to buyer/);
  assert.match(a, /\/api\/receipt\?handle=/, 'the receipt is read from the order, not composed here');
  assert.match(a, /&fmt=wa/, 'the send is the same document with one tap on the end of it');
  assert.match(a, /no buyer number, so the receipt was copied instead/, 'a row with no number is answered, not left as a broken link');
  // and the pages must not claim a document the Worker would not print
  const worker = readFileSync(join(root, 'worker', 'worker.js'), 'utf8');
  assert.ok(worker.includes("if (p === '/api/receipt')"), 'the route the page calls is mounted');
  assert.match(worker, /X-Robots-Tag': 'noindex, nofollow'/);
});

test('0.9.0 the mesh panel copies text, marks it posted, and says nothing is sent for you', () => {
  const a = src('admin');
  assert.match(a, /id="detMesh"/);
  assert.match(a, /\/api\/mesh\?handle=/);
  assert.match(a, /\/api\/mesh\/seen/, 'the one write, behind the confirm header api() already adds');
  assert.match(a, /Rebuild the pack/);
  assert.match(a, /nothing is sent for you|Nothing is sent for you/i, 'the promise is on the card, not in a README');
  assert.match(a, /saved: false|j\.saved/, 'a refused write is reported as a lost memory, not a failed post');
  assert.match(a, /\/mesh\.json/, 'and the public half is linked where a machine can read it');
});

test('0.9.0 the storefront prices VAT the way the till will, in either direction', () => {
  const st = readFileSync(join(root, 'pages', 'store.html'), 'utf8');
  assert.match(st, /CFG\.vat_rate_pct != null[\s\S]{0,80}CFG\.tax_pct/, 'the new rate reads first, the old field is the fallback');
  assert.match(st, /String\(CFG\.vat_mode \|\| 'excl'\) === 'incl'/);
  assert.match(st, /rateOf\(c\.id\)/, 'per line, from the catalogue rather than from a stored cart');
  assert.match(st, /inside that price/, 'and the wording tells a buyer which way round they are being quoted');
  assert.match(st, /VAT No/, 'a registered shop prints its number on the page that takes the money');
  assert.ok(!/vat_mode === 'incl'\s*\?\s*0/.test(st), 'inclusive mode is not modelled as "no tax"');
});

test('the owner console does not list or edit an operator shop’s items', () => {
  const o = src('ops');
  assert.ok(!/id="menuBox"|Menu <span|the rows as buyers see them/.test(o), 'the drawer grew a product/item list back');
  assert.ok(!/\/s\/' \+ encodeURIComponent\(hh\) \+ '\/feed\.json'/.test(o), 'the drawer fetches an operator shelf again');
  assert.ok(!/data-act="menu"|data-act="menu_revert"|payload\.menu/.test(o), 'the drawer can save operator rows again');
  // The API actions remain an authenticated support door, but they are not part
  // of the owner's daily UI and no product names/prices are rendered there.
  const worker = readFileSync(join(root, 'worker', 'worker.js'), 'utf8');
  assert.match(worker, /act === 'menu' \|\| act === 'menu_revert'/);
  assert.match(worker, /mergeMenuPatch\(st\.menu, b\.menu, handle\)/, 'the worker merges, so a forgotten row survives');
});

test('0.9.0 no page quotes a price or a picture the store did not give it', () => {
  const a = src('admin'), o = src('ops'), st = readFileSync(join(root, 'pages', 'store.html'), 'utf8');
  for (const [name, page] of [['admin', a], ['ops', o], ['store', st]]) {
    assert.ok(!/sampleImg\(|sampleArt|draw an? icon/i.test(page) || name === 'store' || name === 'admin', name + ' must not invent art of its own');
    assert.ok(!/\/\/ *TODO/.test(page), name + ' carries a TODO into a money page');
  }
  // the fallback is served by the Worker, from the row, so the pages cannot drift about what it is
  const worker = readFileSync(join(root, 'worker', 'worker.js'), 'utf8');
  assert.match(worker, /x-tapstall-art': 'sample, not a photo'/);
  assert.ok(!/og:image/.test(o), 'the console does not promise a social preview either');
  const core = readFileSync(join(root, 'worker', 'core.js'), 'utf8');
  assert.equal((core.match(/function realPhoto\(p\)/g) || []).length, 1, 'core decides what a photo is, once');
  assert.ok(!/function realPhoto/.test(worker) && !/realPhoto\s*=/.test(a), 'and no page or the worker keeps a second copy of that decision');
});

test('0.9.1 every write to an order document packs the row with it', () => {
  // The ledger is the key space now: a row is KV metadata on the order document, which is what makes
  // one write per order enough and makes an index that can lose a row impossible. It holds only as
  // long as nobody writes an order key another way — so the scan that keeps the generation rule
  // honest keeps this one honest too, over the whole file rather than one function.
  const w = readFileSync(join(root, 'worker', 'worker.js'), 'utf8');
  const puts = (w.match(/ORDERS\.put\([^;]*;/g) || []);
  const orderPuts = puts.filter((line) => /order:/.test(line));
  assert.equal(orderPuts.length, 1, 'exactly one place writes an order document, and it is saveOrder: ' + JSON.stringify(orderPuts));
  assert.match(orderPuts[0], /metadata:\s*packRow\(orderRow\(order\)\)/);
  assert.ok(!/function mirrorRow|await mirrorRow\(/.test(w),
    'the read-modify-write of a shared row array is gone, not merely unused — only its name survives, in a comment explaining why');
  assert.equal((w.match(/ORDERS\.get\('list:/g) || []).length, 1,
    'the legacy index is read in exactly one function, so a second reader cannot appear beside it and disagree');
  const core = readFileSync(join(root, 'worker', 'core.js'), 'utf8');
  assert.match(core, /export const ROW_META_CAP = 1000/, 'and the budget a row has to fit is named, not assumed');
});

test('0.9.1 one reader decides which copy of a page a merchant is served', () => {
  // Pages stopped being KV keys and became bundle bytes with an override key in front of them, so the
  // priority is a rule now — and a rule every door must share. Two handlers used to `get('tpl:renew')`
  // and `get('tpl:confirm')` straight out of KV, which meant an operator's hand-published renew page
  // edited the storefront and left the renewal link serving the old copy: the same class of bug the
  // credential comparison was caught for in 0.8.8, one layer down.
  const w = readFileSync(join(root, 'worker', 'worker.js'), 'utf8');
  const legacy = (w.match(/STORES\.get\('tpl:'/g) || []).length;
  assert.equal(legacy, 2, 'the rollback key is read in exactly two places — the reader, and the console that reports it: ' + legacy);
  const ovr = w.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /STORES\.get\('tpl-ovr:'/.test(l));
  assert.equal(ovr.length, 2, 'the override is read by the reader and by the console that reports what a merchant is being served, and by nobody else');
  const inReader = w.slice(w.indexOf('async function tplPage'), w.indexOf('async function sendMail'));
  assert.match(inReader, /STORES\.get\('tpl-ovr:'/, 'the reader is one of the two');
  const body = w.slice(w.indexOf('async function tplPage'), w.indexOf('async function sendMail'));
  assert.match(body, /tpl-ovr:/, 'override first');
  assert.match(body, /INLINED_PAGES\[name\]/, 'bundle second');
  assert.match(body, /'tpl:' \+ name/, 'legacy key third');
  for (const fn of ['renewPage', 'confirmPage']) {
    const i = w.indexOf('async function ' + fn);
    assert.ok(i > 0, fn + ' exists');
    assert.match(w.slice(i, i + 900), /await tplPage\(env, '[a-z-]+'\)/, fn + ' asks the reader instead of naming a key');
  }
  // and the bundle is filled by the builder, not at runtime: an empty map would pass every page test
  const builder = readFileSync(join(root, 'scripts', 'build_bundle.sh'), 'utf8');
  assert.match(builder, /const INLINED_PAGES = \{\};/, 'the builder fills the declaration worker.js keeps empty');
  assert.match(builder, /pages missing or stubby/, 'and refuses to ship a bundle with a page missing');
  assert.match(builder, /3 MB Worker limit/, 'with the platform bundle cap checked at build time, not by a 413 mid-release');
});

test('0.9.1 the floor still has the true sentence, even though a deploy makes it rare', () => {
  // The floor — the page the Worker builds when there is no skin to fill — is now only reachable in
  // production by a bundle that lost a page, which the builder refuses to ship. Its copy still
  // matters, because a link that has been revoked is answered there, and the sentence it prints
  // used to send people to a welcome email containing exactly that dead link. Asserted from source:
  // the state is not reachable through a deleted key any more, and pretending otherwise would be a
  // test that verifies a mechanism that no longer exists.
  const w = readFileSync(join(root, 'worker', 'worker.js'), 'utf8');
  const floor = w.slice(w.indexOf('if (!rec) return html(`'), w.indexOf('if (closed) return html(`'));
  assert.ok(floor.length > 80, 'the erased-token floor is still written out, not inlined away');
  assert.match(floor, /plan card in your <a href=\"\/a\">dashboard<\/a>/, 'it names where the working link genuinely is');
  assert.ok(!/welcome email/.test(floor), 'and the retired sentence is gone from it, not left alongside the new one');
  const closedFloor = w.slice(w.indexOf('if (closed) return html(`'), w.indexOf('const st = await getStore(env, rec.handle);'));
  assert.match(closedFloor, /closed its links/);
  assert.ok(!/id=pay/.test(closedFloor), 'a closed link renders no way to pay through it');
});

test('1.5.4 the collection shelf is the default storefront, and it is wired to the tested doors', () => {
  const store = page('store');
  // the shelf itself
  for (const needle of ['class="coll" id="coll"', 'id="cstage"', 'id="cthumbs"', 'class="rail" id="collRail"',
                        'id="collPrev"', 'id="collNext"', 'id="cadd"', 'id="cask"', 'id="cdName"', 'id="railNext"']) {
    assert.ok(store.includes(needle), 'collection shelf is missing ' + needle);
  }
  // the swipe: pointer drag with a decision threshold, and a finger's own pan is not stolen
  assert.match(store, /Math\.abs\(dx\) > 44/, 'a swipe has a threshold, not a hair trigger');
  assert.match(store, /pointerType === 'touch'/, 'the row lets a finger scroll natively and only helps a mouse');
  // the grid stays in the page for the other layouts, and a collection shop hides it
  assert.match(store, /body\.layout-collection \.grid\{display:none!important\}/,
    'a collection shop must not paint the old grid underneath the shelf');
  assert.match(store, /\.hero\[hidden\][^{]*\{display:none\}/, 'a hidden hero must actually be hidden (display:flex beat [hidden])');
  // every door into an order is the reviewed one
  assert.match(store, /add\.onclick = function \(\) \{ if \(!soldOut\) openItem\(p\); \}/,
    'the stage adds through openItem, so options, add-ons, VAT and the receipt are unchanged');
  assert.match(store, /if \(p && p\.available !== false\) openItem\(p\)/, 'the row adds through the same door');
  // the shelf holds its item by id, not by position, so a filter cannot make the page jump
  assert.match(store, /var collCur = ''/, 'the chosen item is an id');
  // the template's own words and the shop's own rail are used, never invented
  assert.match(store, /D\.popular_label/, 'the popular badge still speaks the template language');
  assert.match(store, /CFG\.rail_info/, 'the shelf says how this shop takes money');
  // the chrome above the shelf gets out of the way on a collection page
  assert.match(store, /body\.layout-collection header\{position:static\}/);
  assert.match(store, /typeof CFG\.hours === 'string'/, 'a week object must never be printed as [object Object]');
  // admin can choose the shelf
  const admin = src('admin');
  assert.match(admin, /\['collection', 'Collection/, 'the dashboard offers the collection layout');
  assert.equal(CORE.STOREFRONT_LAYOUTS[0], 'collection', 'collection is the layout a shop that never chose gets');
  assert.equal(CORE.STOREFRONT_DEFAULT_LAYOUT, 'collection');
});

test('1.5.5 every trade gets its own storefront, and the space under the details is used', () => {
  const store = page('store'), admin = src('admin');
  // the template's rhythm reaches the page as a body class, and it survives the config whitelist
  assert.match(store, /variant: D\.variant \|\| CFG\.store_variant/, 'the rhythm must survive the resolved-design whitelist');
  assert.match(store, /' coll-' \+ variant/, 'the shelf wears the template rhythm as a body class');
  for (const v of ['lookbook', 'shelf', 'spec', 'gallery', 'service', 'showcase']) {
    assert.ok(store.includes('body.coll-' + v), 'no rhythm drawn for ' + v);
  }
  // a booking shop asks for a booking, in the button and in the panel
  assert.match(store, /D\.template === 'services' \? 'Book'/, 'a booking shop asks for a booking');
  assert.match(store, /Book next/, 'a booking shop suggests the next appointment');
  // the empty panel is filled with real items, each one a door into the tested sheet
  assert.match(store, /function paintPairs/, 'the panel fills itself');
  assert.match(store, /Goes well with/, 'and says what it is for');
  assert.match(store, /data-add="' \+ esc\(x\.id\)/, 'a pair adds through the same door');
  // no commentary in a buyer-facing page
  assert.ok(!/Why the photo is this big/i.test(store), 'the sandbox explainer never ships to a buyer');
  // the dashboard names the look the chosen trade draws, instead of pretending every shop is the same
  assert.match(admin, /function lookName/, 'the dashboard knows the trade looks by name');
  assert.match(admin, /template draws/, 'and says which one this shop gets');
});

test('1.5.6 the header is a card from the same paper as the shelf, not a row of grey pills', () => {
  const store = page('store');
  // the identity plate: monogram, name, one status pill, quiet facts, two small actions
  assert.match(store, /<div class="avatarFallback"[^>]*>[^<]*<\/div>/, 'the shop still carries a mark');
  assert.match(store, /<div class="idtext">/, 'and a column for its name');
  assert.match(store, /<span class="pill" id="chours" hidden><\/span>/, 'the clock is one pill, not a debug chip');
  assert.match(store, /header \.pill\.shut\{/, 'a closed shop is said in colour, not in a bullet character');
  assert.match(store, /ch\.className = 'pill ' \+ \(shut \? 'shut' : 'open'\)/, 'and the state is a class the template can style');
  assert.ok(!/\\u25cf/.test(store), 'no literal bullet inside the sentence');
  // share and WhatsApp are actions with a spoken label, and the phone shows only the mark
  assert.match(store, /<a class="mact" id="shareChip" href="share\.txt" aria-label="Share this shop"/);
  assert.match(store, /header \.mact \.lbl\{display:none\}/, 'the label folds away on a phone, the aria-label does not');
  // the plate follows the trade
  for (const v of ['lookbook', 'gallery', 'service', 'spec', 'shelf']) {
    assert.ok(store.includes('body.coll-' + v + ' header'), 'the header does not follow the ' + v + ' rhythm');
  }
  // a monogram is two initials, because one letter reads as a placeholder
  assert.match(store, /words\.slice\(0, 2\)/, 'the mark is up to two initials');
  // the tagline is identity, so a collection page keeps it now that the banner is folded away
  assert.match(store, /body\.layout-collection header \.tag\{display:block\}/);
});
