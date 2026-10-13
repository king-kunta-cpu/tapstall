/**
 * Tapstall — zero-touch WhatsApp storefront platform.
 * Cloudflare Worker. Free-tier only (Worker + 2 KV namespaces + cron + assets).
 *
 * Bindings
 *   STORES (KV)  store:{handle} term:{handle} renew:{token} tx:{ref} seq:{h} rl:* buyer:* tpl:*
 *   ORDERS (KV)  order:{handle}:{id}  list:{handle}
 *   ADMIN_URL_PREFIX      optional; not required
 *   ADMIN_SECRET (secret) signs buyer-fingerprint hashes
 *   CRON                  every 6 hours → paid-term enforcement + renewal notice
 *
 * Templates live in KV (tpl:store, tpl:onboard, tpl:admin) so the storefront
 * can be hot-updated without redeploying the Worker (no assets binding needed,
 * so the free plan is enough and one curl can fix a template).
 */

import {
  RAILS, round2, clamp, slug, digits, isEmail, validHandle, parseCSV, normalizeFeedUrl,
  parseProducts, priceOrder, payInstructions, riskFlags, waSummary, publicStore, hash,
  applyMenu, sanitizeMenu, menuPrice, openNow, cleanWeek, cleanRailAccts, hoursText,
  cleanImg, sniffImage, imgKeyOf, imgRefOf, newImgId, referencedImages, IMG_MAX_BYTES,
  IMG_TARGET_BYTES,
  cleanProof, cleanPayer, proofNoun, proofAsk, PROOF_MODES, notifyText,
  proofAccept, proofOpen, proofUsed, proofSuperseded, proofVoid, PROOF_WINDOW_SEC, PROOF_WRITES_MAX,
  issueCap, verifyCap, capGenOk, renewOk, randomKey, validateSettings, stageSettings, applyPending, maskField,
  newTxRef, TX_WINDOW_SEC, payfastSignedOk, txMatches,
  seoFacts, seoHead, seoJsonLdTag, ROBOTS_TXT, sitemapXml, GUIDES, guideOf,
  shareCopy, hookAuditKey, hookHourStamp,
  // v0.9.0: the money side. VAT profile, the books pack, the receipt, the art, the mesh — all of
  // it read-time arithmetic over rows that already exist, because a shop has to be able to close a
  // month on a day its write budget is gone.
  vatPlan, vatReturn, booksSummary, booksCsv, booksPeriods, vatBuckets, realPhoto, sampleArtUrl, mergeMenuPatch,
  receiptText, receiptHtml, sampleArtSvg, meshPack, meshJson, meshMark, meshWitness,
  MESH_RAILS, MESH_BUDGET,
  EDITABLE_FIELDS, SOFT_FIELDS, sign, adminStore, normaliseRail, resolveRail,
  genPin, pinRecord, pinOk, pinMiss, validPin, PIN_NORMALIZE, PIN_ITER,
} from './core.js';

const VERSION = '0.9.0';
const FREE_DAYS = 60;
const PRICE_USD = 60;
const MAX_ORDERS_KEPT = 200;
const RL = { windowSec: 60, max: 8 };

/* ---- rename compatibility: ZimLink -> Tapstall, 2026-10-10 -----------------
   A rename may change what a person reads. It must not change what a person has
   already been sent, what sits in their browser, or what an integration already
   posts. So every spelling the old brand wrote is still accepted, and only the
   new one is ever written out. These aliases are load-bearing until the last KV
   template has been republished — deleting one logs merchants out, drops buyer
   carts in progress, or renders a page whose data hook never filled.
   Revocation does NOT depend on the old names: both cookies carry the store's
   `auth_gen` (or the platform's `ops_gen`) inside the signed payload, so one KV
   write still invalidates every link, key and cookie under either spelling. */
const LEGACY_COOKIE = { tp_sess: 'zl_sess', tp_ops: 'zl_ops' };
const LEGACY_HEADER = {
  'x-tapstall-confirm': 'x-zimlink-confirm',
  'x-tapstall-admin': 'x-zimlink-admin',
};
function reqHeader(req, name) {
  const v = req.headers.get(name);
  if (v !== null && v !== '') return v;
  const alt = LEGACY_HEADER[name];
  return alt ? req.headers.get(alt) : v;
}
function cookieVal(req, name) {
  const raw = req.headers.get('cookie') || '';
  for (const n of [name, LEGACY_COOKIE[name]].filter(Boolean)) {
    const m = raw.match(new RegExp('(?:^|;\\s*)' + n + '=([^;]*)'));
    if (m && m[1]) return decodeURIComponent(m[1]);
  }
  return '';
}
/** Both cookie names, cleared: an old one left in a browser would still read as
 *  a valid session here, because we accept it. Signing out means both. */
function killCookies(names) {
  const extra = names.map((n) => LEGACY_COOKIE[n]).filter(Boolean);
  return names.concat(extra)
    .map((n) => n + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure');
}
/** Fill a page's data hook under either brand. The templates in KV are republished
 *  on their own schedule (and cannot be written at all on a spent-quota day), so
 *  the Worker has to speak both spellings for as long as any old copy is live. */
function fillPage(html, pairs) {
  // `marker` is the whole brand-bearing name, e.g. `TAPSTALL_CONFIG`: the pages
  // are written with `/*__TAPSTALL_CONFIG__*/null` and yesterday's KV copy with
  // `/*__ZIMLINK_CONFIG__*/null`, and both must land in one pass
  let out = String(html || '');
  for (const [marker, value] of pairs) {
    const txt = JSON.stringify(value);
    out = out.replace('/*__' + marker + '__*/null', txt)
             .replace('/*__' + marker.replace('TAPSTALL', 'ZIMLINK') + '__*/null', txt);
  }
  return out;
}

/* ---- authority model (see core.js: "a GET must never move money") ---- */
const HOLD_MS = 15 * 60 * 1000;      // money-moving settings land after this hold
// 0.6.0: link sign-in and its 7-day lifetime are gone. The credential is a PIN;
// the only token a browser holds is the 12-hour session cookie.
const MARK_TTL = 72 * 3600;           // per-order confirm link lifetime
const UNDO_TTL = 15 * 60;             // tap-back to reverse a confirmation
const SESS_TTL = 12 * 3600;           // signed-in browser session
const LOCK_MAX = 12;                  // bad credentials per handle before a cooldown
const LOCK_TTL = 600;


export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const open = isOpenPath(url.pathname);
    if (req.method === 'OPTIONS') return open ? openCors(new Response(null, { status: 204 })) : new Response(null, { status: 403 });
    try {
      const res = (await route(req, url, env, ctx)) || json({ ok: false, error: 'not_found' }, 404);
      return open ? openCors(res) : res;
    } catch (e) {
      const msg = String((e && e.message) || e);
      const spent = quotaAnswer(msg, url.pathname, req);
      if (spent) return open ? openCors(spent) : spent;
      return json({ ok: false, error: msg, stage: 'worker' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    // An alias origin never owns the sweep. Cloudflare's API would not let this
    // token remove the schedule that the previous hostname kept when it was
    // deployed as a second Worker (PUT /schedules answers success:false), and
    // deleting it from a dashboard is a manual step — so the guard lives here
    // instead, where forgetting it costs something: two Workers on one KV running
    // the same daily job means double writes on a 1,000/day plan and two expiry
    // notices where the merchant expected one.
    if (env.REDIRECT_TO) return;
    ctx.waitUntil(runCron(env));
  },
};

async function route(req, url, env, ctx) {
  // A link that has been through an email client, a Markdown renderer, a chat
  // preview or a copy-paste out of HTML often arrives with `&` written as
  // `&amp;`. That silently renames the *second* parameter: `&token=` becomes
  // `&amp;token=`, so the page loads, sees no credential, and asks you to paste
  // the link you are already holding. Repaired once, here, because every reader
  // of the query is downstream of it — the alias redirect included.
  if (/(?:&|&#0*38;)(?:amp|#0*38);/i.test(url.search)) url = unescapeQuery(url);
  const p = url.pathname;
  const NOSTORE = { 'Cache-Control': 'no-store' };

  /* The previous brand's hostname is kept alive as an alias of this Worker and
     answers nothing but a redirect (env.REDIRECT_TO is set only on that deploy).
     Only page GETs: a request with a body — placing an order, tapping confirm,
     saving a setting — is served here as normal, because a 301 loses a POST and
     a browser that is mid-action must not lose the order. Nothing a customer
     already saved dies when the name changes. */
  if (env.REDIRECT_TO && req.method === 'GET' && LEGACY_PAGES_RE.test(p)) {
    const to = env.REDIRECT_TO.replace(/\/+$/, '') + p + (url.search || '');
    return redirect(to, 301);
  }

  if (p === '/__ping') return json({ ok: true, version: VERSION, ts: Date.now() });
  if (p === '/__selftest') {
    const t = await selftest(env);
    // ?scheduled=1 also runs the cron body live, so term enforcement is verifiable
    if (url.searchParams.get('scheduled') === '1') {
      try { t.scheduled = await runCron(env); }
      catch (e) { t.scheduled_error = String(e && e.message || e); }
    }
    return json(t, 200, NOSTORE);
  }
  if (p === '/rails') {
    const cat = await railsCatalog(env);
    return json({ ok: true, rails: cat, custom: true, price_usd: PRICE_USD, free_days: FREE_DAYS,
      note: 'Any payment method works here, including one nobody has heard of outside your street. If yours is missing, ask us to add it — or pick "describe my own" and type it in.' },
      200, { 'Cache-Control': 'public, max-age=60' });
  }
  if (p === '/fees.ics') return feesIcs();
  // robots.txt and sitemap.xml are answered by the Worker rather than by a file in
  // Pages, because the origin a crawler sees is the host that answered it, and because
  // the second file is a list of what we will *not* enumerate (see core.js).
  if (p === '/robots.txt') return text(ROBOTS_TXT(url.origin));
  if (p === '/sitemap.xml') return text(sitemapXml(url.origin), 200, 'application/xml; charset=utf-8');   // text(body, status, type): passing the type second is a 500
  if (p === '/fees' || p === '/fees.html') {
    const page = await tpl(env, 'fees');
    return page.startsWith('<!doctype') ? html(page, 200, { 'Cache-Control': 'public, max-age=3600' }) : redirect('/onboard');
  }
  if (p === '/' || p === '/home' || p === '/index.html') {
    const page = await tpl(env, 'index');
    if (page.startsWith('<!doctype')) return html(page, 200, { 'Cache-Control': 'public, max-age=3600' });
    return redirect('/onboard');
  }
  if (p === '/data/sample-menu.csv') {
    const csv = await env.STORES.get('tpl:sample-menu');
    if (csv) return new Response(csv, { headers: { 'content-type': 'text/csv', 'cache-control': 'public, max-age=86400' } });
  }

  if (p === '/onboard') return html(await tpl(env, 'onboard'));

  let m;
  // A merchant's own picture, out of the store's KV. Public on purpose: it is a
  // photo of the food, and the storefront is what has to load it fast on a handset.
  if ((m = p.match(/^\/i\/([a-z0-9][a-z0-9-]{1,30})\/([A-Za-z0-9_-]{4,40})$/))) return imageGet(req, env, m[1], m[2]);
  if ((m = p.match(/^\/s\/([a-z0-9][a-z0-9-]{1,30})$/))) return storePage(url, env, m[1]);
  if ((m = p.match(/^\/s\/([a-z0-9][a-z0-9-]{1,30})\/config\.json$/))) {
    const st = await getStore(env, m[1]);
    return st ? json({ ok: true, store: publicStore(st, await railsCatalog(env)) }) : json({ ok: false, error: 'no_store' }, 404);
  }
  // The written pages. `@ORIGIN@` is stamped here rather than at build time so the
  // canonical URL is the host that answered, forever, and so a move to a real domain
  // fixes every guide with no edit to any of them.
  if (p === '/guide' || p === '/guides' || p === '/guides.html') return redirect('/guide/' + GUIDES[0].slug);
  if ((m = p.match(/^\/guide\/([a-z0-9][a-z0-9-]{3,46})\/?$/))) {
    const g = guideOf(m[1]);
    if (!g) return html(NO_GUIDE, 404, NOINDEX);
    const page = await tpl(env, 'guide-' + g.slug);
    if (!page.includes('<title>')) return html(NO_GUIDE, 404, NOINDEX);   // written but never published
    return html(page.split('@ORIGIN@').join(url.origin), 200, { 'Cache-Control': 'public, max-age=3600' });
  }
  if ((m = p.match(/^\/s\/([a-z0-9][a-z0-9-]{1,30})\/share\.txt$/))) {
    // The post a merchant would otherwise have to write at 21:00 with one hand. Plain
    // text on purpose: on any phone a text page is select-all then share, and it works
    // with JavaScript off, which the storefront itself cannot claim.
    const st = await getStore(env, m[1]);
    if (!st) return text('No store at this address.', 404);
    const c = shareCopy(st, seoFacts(st, url.origin), url.origin);
    return text('Copy the block for the place you are posting it.\n\n'
      + '— WhatsApp status or a group —\n' + c.wa + '\n\n'
      + '— X / Twitter (fits the limit) —\n' + c.x + '\n\n'
      + '— Facebook page or group —\n' + c.fb + '\n\n'
      + '— Instagram (link in bio) —\n' + c.ig + '\n\n'
      + 'The link on its own, if you would rather write the rest yourself:\n' + c.url + '\n',
      200, 'text/plain; charset=utf-8');
  }
  // Today's posting pack, public and read-only, in the same family as share.txt: everything on it
  // is already public on the storefront, so a bot that wants to repeat this shop's prices can, and
  // it can also see that the shop's prices are the shop's own and move.
  if ((m = p.match(/^\/s\/([a-z0-9][a-z0-9-]{1,30})\/mesh\.json$/))) {
    const st = await getStore(env, m[1]);
    if (!st) return json({ ok: false, error: 'no_store' }, 404);
    const products = await loadProducts(st, env);
    return json({ ok: true, ...meshJson(st, products, meshFacts(st, url.origin), url.origin) },
      200, { 'Cache-Control': 'public, max-age=600', 'X-Robots-Tag': 'noindex' });
  }
  // Fallback art for a row with no picture. No KV read, no KV write, cached for a year: the URL
  // carries the name it draws from, so there is nothing to look up and nothing to invalidate.
  if ((m = p.match(/^\/art\/([a-z0-9][a-z0-9-]{1,30})\/(\d{1,6})\.svg$/))) {
    const nm = String(url.searchParams.get('n') || 'item').slice(0, 60);
    return new Response(sampleArtSvg(nm), { headers: {
      'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable',
      'vary': 'Accept-Encoding', 'x-tapstall-art': 'sample, not a photo' } });
  }
  if ((m = p.match(/^\/s\/([a-z0-9][a-z0-9-]{1,30})\/feed\.json$/))) {
    const st = await getStore(env, m[1]);
    if (!st) return json({ ok: false, error: 'no_store' }, 404);
    // Cached by default now, and ?fresh=1 means it: the storefront is the hot path,
     // and a sheet that has not changed in two minutes does not need to be asked
     // again by every buyer. The dashboard's own Re-read button passes fresh=1, so
     // "I just edited the sheet" still answers immediately.
    return json({ ok: true, products: await loadProducts(st, env, url.searchParams.get('fresh') === '1') });
  }

  // ---- merchant authority: a code becomes a cookie, and only POSTs act ----
  const MUT = /^\/api\/(mark|proof|order\/proof|settings|settings\/revert|menu|mesh\/seen|revoke|auth|pin\/change|pin\/reset|login|logout|recover|image)$/;
  // /api/mark answers its own 405, because it also has to recognise a v0.2
  // ?token= link and trade it for a session rather than dead-end the merchant.
  const selfHandled = p === '/api/mark';
  if (MUT.test(p) && req.method !== 'POST' && !selfHandled) {
    return json({ ok: false, error: 'method_not_allowed', why: 'This endpoint changes state, so it never answers GET.' }, 405, { Allow: 'POST' });
  }
  if (p === '/api/auth' && req.method === 'POST') return pinLogin(req, env);
  if (p === '/api/pin/change' && req.method === 'POST') return pinChange(req, env);
  if (p === '/api/pin/reset' && req.method === 'POST') return pinReset(req, env);
  if (p === '/api/logout' && req.method === 'POST') return withCookie(json({ ok: true, signed_out: true }), ...KILL_COOKIES);
  // The link sign-in is retired. A saved bookmark or an old welcome message is
  // answered, not 404-ed, because the only honest thing to say to somebody
  // holding a dead link is what to do instead.
  if (p === '/api/login' || p === '/api/recover') {
    return json({ ok: false, retired: true, need_login: true,
      error: 'Sign-in by link has been retired. Open /a and sign in with your store name and PIN — or tap “I lost my PIN” there to set a new one.' }, 410);
  }

  if (p === '/api/order' && req.method === 'POST') return placeOrder(req, url, env, ctx);
  if (p === '/api/register' && req.method === 'POST') return register(req, url, env);
  if (p === '/api/lookup') return lookup(url, env);
  if (p === '/api/mark') return markPaid(req, url, env);
  if (p === '/api/proof' && req.method === 'POST') return proofAdd(req, url, env);
  // The shop's half of the same field, on the shop's own authority: no capability is
  // read here, so no link — including a leaked one — can reach this write.
  if (p === '/api/order/proof' && req.method === 'POST') return proofFile(req, url, env);
  if (p === '/api/admin') return adminView(req, url, env);
  if (p === '/api/settings' && req.method === 'POST') return settingsEdit(req, url, env);
  if (p === '/api/settings/revert' && req.method === 'POST') return revertPending(req, url, env);
  if (p === '/api/menu' && req.method === 'POST') return menuEdit(req, env);
  if (p === '/api/image' && req.method === 'POST') return imageUpload(req, env);
  if (p === '/api/revoke' && req.method === 'POST') return revokeKeys(req, url, env);
  // The books and the receipt, on the shop's own authority: no new credential, no new surface for
  // a buyer to meet, and nothing written. A month is a read of the row list; a receipt is a read
  // of one order.
  if (p === '/api/books') return booksView(req, url, env);
  if (p === '/api/receipt') return receiptView(req, url, env);
  if (p === '/api/mesh') return meshView(req, url, env);
  if (p === '/api/mesh/seen' && req.method === 'POST') return meshSeen(req, env);

  // The one-tap confirm link: GET renders an inert page, the browser posts.
  if ((m = p.match(/^\/c\/([A-Za-z0-9._-]{20,400})$/))) return confirmPage(env, m[1]);
  // The buyer's own write, on its own path and its own capability kind: `/c/` marks
  // money, `/p/` adds a reference, and neither link can do the other's job.
  if ((m = p.match(/^\/p\/([A-Za-z0-9._-]{20,400})$/))) return proofPage(env, m[1]);

  if (p === '/a') return adminEntry(req, url, env);

  /* Platform operator console. Same-origin, cookie-session, and deliberately
   * outside the public path set: no CORS, no caching, no links in it that move
   * money without a POST. */
  if (p === '/ops' || p === '/ops/') return opsPage(req, env);
  if (p === '/ops/login') return req.method === 'POST' ? opsLogin(req, env) : json({ ok: false, error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  if (p === '/ops/logout') {
    if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    const ended = await endOpsSessions(env);
    return withCookie(json({
      ok: true, sessions_ended: ended,
      note: ended
        ? 'Every console session on this platform is ended now, not just this tab.'
        : 'This tab is signed out, but the platform-wide revocation could not be written — any other session stays valid until its cookie expires (12 hours max). Sign out again after the write budget resets at 00:00 UTC to be certain.',
    }), opsKillCookies());
  }
  // The four read endpoints used to swallow a lever's payload: `POST
  // /ops/api/state {"action":"link"}` answered 200 with the state body and the
  // operator's script (or the console, if a route is ever rewired) read `ok:true`
  // for a lever that never fired. Measured, not theorised — this is exactly what
  // happened to whoever automates this console. Now a write-shaped POST to a read
  // path is refused by name and pointed at the door that dispatches it, after the
  // auth check so an anonymous probe learns nothing.
  if (p === '/ops/api/state') return opsGate(req, env, async () => (await misroutedLever(req, p)) || opsState(env));
  if (p === '/ops/api/health') return opsGate(req, env, async () => (await misroutedLever(req, p)) || opsHealth(env));
  if (p === '/ops/api/audit') return opsGate(req, env, async () => (await misroutedLever(req, p)) || opsAudit(req, url, env));
  if (p === '/ops/api/store') {
    if (req.method === 'POST') return opsGate(req, env, () => opsStoreAction(req, env));
    return opsGate(req, env, () => opsStoreDetail(url, env));
  }
  if (p === '/ops/api/templates') return opsGate(req, env, async () => (await misroutedLever(req, p)) || opsTemplates(env));
  if (p === '/ops/api/template') {
    if (req.method === 'POST') return opsGate(req, env, () => opsTemplateWrite(req, env));
    return opsGate(req, env, () => opsTemplateRead(url, env));
  }
  if (p === '/ops/api/rails') {
    if (req.method === 'POST') return opsGate(req, env, () => opsRailsWrite(req, env));
    return opsGate(req, env, () => opsRailsRead(env));
  }
  if (p === '/ops/api/link') return json({ ok: false, retired: true, error: 'Retired with link sign-in: reset a merchant’s PIN with action “reset_pin” on /ops/api/store.' }, 410);
  if ((m = p.match(/^\/renew\/([A-Za-z0-9_-]{6,40})$/))) return renewPage(env, m[1]);
  if (p === '/api/admin-put' && req.method === 'POST') return adminPut(req, env);

  if (p === '/api/checkout' && req.method === 'POST') return checkout(req, url, env);
  if (p === '/api/renew-ref' && req.method === 'POST') return renewRef(req, env);
  if (p === '/api/hook/flutterwave' && req.method === 'POST') return hookFlutterwave(req, url, env, ctx);
  if (p === '/api/hook/payfast' && req.method === 'POST') return hookPayfast(req, url, env, ctx);

  return null;
}
/* ------------------------------------------------------------- store page */
async function storePage(url, env, handle) {
  const st = await getStore(env, handle);
  if (!st) return html(notFoundPage(handle), 404, NOINDEX);
  const term = await env.STORES.get('term:' + handle, 'json');
  const page = fillPage(await tpl(env, 'store'),
    [['TAPSTALL_CONFIG', publicStore(st, await railsCatalog(env))], ['TAPSTALL_TERM', term || null]]);
  return html(fillSeo(page, url.origin, st), 200, { 'Cache-Control': 'public, max-age=60, s-maxage=300', ...FRAMEABLE });
}

/** The head a crawler reads, written as raw bytes. `fillPage` cannot carry this: its
 *  values go through `JSON.stringify`, because they land inside a script, and a
 *  `<meta>` tag is not a JS literal. So this is a deliberate second path, and it
 *  degrades: the marker in `pages/store.html` sits *above* a static title, so an old
 *  copy of the page that never saw a substitution still has a title and still works.
 *  The origin is the host that answered, which is always the real one: the alias
 *  redirects a store link to this Worker before any of this runs. */
function fillSeo(page, origin, st) {
  const out = String(page);
  if (!out.includes('<!--@SEO@-->')) return out;        // a page published before this existed: leave it alone
  let facts;
  try { facts = seoFacts(st, origin); } catch (e) { return out; }      // a broken store doc must not blank a storefront
  const ld = seoJsonLdTag(st, facts);   // the escaping is core's, so a test can reach it
  // the fallback title is only a fallback: two <title> elements are invalid, and a
  // crawler is free to show either, so a real one has to replace it rather than
  // out-rank it. Deleting it here (and only here) is what keeps the old copy whole.
  return out.replace('<!--@SEO@-->', seoHead(facts) + '\n' + ld + '\n')
            .replace('<title>Tapstall Store</title>', '');
}

/**
 * Loads a store and lands any held setting whose hold has expired. Applying on
 * the read path means no timer to lose: the change takes effect the first time
 * a buyer or the merchant looks, which is exactly when it matters.
 */
async function getStore(env, handle) {
  if (!env.STORES) return null;
  const st = await env.STORES.get('store:' + handle, 'json');
  if (!st || !st.pending) return st;
  const { applied } = applyPending(st, Date.now());
  if (applied.length) {
    // Persisting the fold is a convenience — the next read would fold it again
    // from the same `pending` block. Awaiting it here meant a merchant who moved
    // their payout account at 18:00 on a day the write budget ran out at 17:55
    // turned *every* storefront read into a 503 from 18:15 to midnight, because
    // the lazy apply could not be written down. Read paths serve; they do not
    // require a write to answer.
    try { await writeStore(env, st); } catch (e) { /* served from the fold, uncached */ }
  }
  return st;
}

async function writeStore(env, st) {
  if (env.STORES) await env.STORES.put('store:' + st.handle, JSON.stringify(st));
}

/* --------------------------------------------------------------- products */
/**
 * The store's menu: whatever the sheet said, with this store's own dashboard edits
 * laid over it. The cache holds the sheet as fetched — the edits are applied on the
 * way out, never inside the cache — so "Revert this row to my sheet" is a matter of
 * dropping an override, and a sheet that comes back tomorrow still arrives clean.
 */
async function loadProducts(st, env, force) {
  const ms = (st.cache_seconds || 120) * 1000;
  if (!force && st.feed_cache && st.feed_cache.at && Date.now() - st.feed_cache.at < ms) return applyMenu(st.feed_cache.products, st.menu, st.handle);
  let products = [], error = null;
  try {
    const feed = normalizeFeedUrl(st.feed_url);
    if (!feed) error = 'no_feed';
    else {
      const r = await fetch(feed, { headers: { 'User-Agent': 'tapstall/1' }, cf: { cacheTtl: 60 } });
      if (!r.ok) error = 'feed_http_' + r.status;
      else products = parseProducts(await r.text(), st);
    }
  } catch (e) { error = 'feed_fetch_failed'; }
  st.feed_cache = { at: Date.now(), products, count: products.length, error };
  // Same rule one layer up: the products came from the merchant's sheet and cost
  // nothing to read, so refusing to *cache* them must not refuse to *show* them.
  // A quota day leaves the storefront re-fetching per hit instead of 503-ing at
  // every buyer who only wanted to see what is on offer.
  try { await writeStore(env, st); } catch (e) { /* uncached today, correct today */ }
  return applyMenu(products, st.menu, st.handle);
}




/* ---------------------------------------------------------------- pricing */

/* ------------------------------------------------------------------ order */
async function placeOrder(req, url, env, ctx) {
  const body = await req.json().catch(() => null);
  if (!body || !body.handle) return json({ ok: false, error: 'missing handle' }, 400);
  const st = await getStore(env, String(body.handle));
  if (!st) return json({ ok: false, error: 'unknown store' }, 404);
  if (st.maintenance || st.suspended) return json({ ok: false, error: st.suspended ? 'store paused — owner needs to renew' : 'store paused' }, 503);
  const ip = (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'na').split(',')[0].trim();
  if (await rateLimited(env, ip)) return json({ ok: false, error: 'too many orders from you, wait a minute' }, 429);

  const buyer = {
    name: String((body.buyer || {}).name || '').trim().slice(0, 60),
    phone: digits((body.buyer || {}).phone || '').slice(0, 20),
    address: String((body.buyer || {}).address || '').trim().slice(0, 200),
    note: String((body.buyer || {}).note || '').trim().slice(0, 400),
    optin: !!(body.buyer || {}).optin,
    // The number the payment will come *from*, when the buyer volunteers it. On a
    // manual mobile-money rail the merchant's whole reconciliation is matching an
    // SMS alert to an order, and an alert with no number in it is a phone call.
    // Optional by design: a buyer who will not say gets the order anyway.
    payer: cleanPayer((body.buyer || {}).payer || (body.buyer || {}).pay_from || (body.buyer || {}).from, 'loose'),
    // The code the buyer's app printed. Asked for because a manual rail is a phone
    // the merchant reads, and on a bank transfer it is the only way in. Kept as
    // typed, and never a reason to lose the order: a missing one is flagged instead.
    proof: cleanProof((body.buyer || {}).proof || (body.buyer || {}).txid || (body.buyer || {}).tx_id
                      || (body.buyer || {}).reference_given),
  };
  if (!buyer.name || !buyer.phone || buyer.phone.replace(/\D/g, '').length < 9) {
    return json({ ok: false, error: 'name and a valid WhatsApp number are required' }, 422);
  }
  if (st.require_optin && !buyer.optin) return json({ ok: false, error: 'consent required to place an order' }, 422);
  const service = body.service === 'delivery' ? 'delivery' : 'pickup';
  if (service === 'delivery' && !buyer.address) return json({ ok: false, error: 'delivery address required' }, 422);
  const items = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
  if (!items.length) return json({ ok: false, error: 'cart empty' }, 422);

  // The menu prices the order. The browser said what it wanted to pay, which is not
  // the same thing: the storefront's own JS is public, and a one-cent "leg of lamb"
  // with valid unique cents and a real reference used to be a deliverable order.
  const products = await loadProducts(st, env);
  const priced = menuPrice(products, items);
  if (priced.authoritative && priced.unknown) {
    return json({ ok: false, error: 'Some of that is not on ' + (st.shop_name || st.handle) + '’s menu any more. Reload the page and send it again.', fields: { items: priced.notes.slice(0, 5) } }, 422);
  }
  const railKey = st.rail || 'cash';
  const pricing = priceOrder(st, priced.items, service, railKey, await railsCatalog(env));
  const cap = Number(st.max_order_value) || 0;
  if (cap && pricing.total > cap) return json({ ok: false, error: `order over this shop's limit of ${cap} ${st.currency || 'USD'}` }, 422);

  const seq = await incr(env, 'seq:' + st.handle);
  const code = (st.order_prefix || st.handle.slice(0, 3).toUpperCase()).replace(/[^A-Za-z0-9-]/g, '') + '-' + String(seq).padStart(4, '0');
  const id = nowId();
  const buyerHash = await hash(st.handle + '|' + buyer.phone + '|' + (env.ADMIN_SECRET || 'dev-secret'));
  const hist = await buyerTouch(env, st.handle, buyerHash);

  const order = {
    id, code, service, at: new Date().toISOString(), handle: st.handle,
    buyer, when: String(body.when || 'asap').slice(0, 40),
    // The names and prices on the slip are the menu's, so what the merchant reads,
    // what the buyer was told to send and what the ledger holds cannot disagree.
    pricing, items: priced.authoritative ? priced.items : items,
    buyer_hash: buyerHash.slice(0, 16), prior_orders: hist.count, prior_unpaid: hist.unpaid,
    status: railKey === 'cash' ? 'cod' : 'awaiting_payment',
    // What the merchant has to know: the cart arrived with different numbers than
    // the menu (so: check it), or this store has no menu to check against at all.
    // When the shop opened its doors is part of the order, not a decoration: the
    // flag below is what tells the merchant this arrived at 02:00 with nobody home.
    hours: openNow(st),
  };
  /* Freeze the payment details onto the order. The merchant's dashboard, the
   * WhatsApp handoff and the notification all read the slip, not the store — so
   * a payout account changed afterwards can never rewrite what a buyer was
   * already told to pay, and yesterday's customer is never sent to a new number. */
  /* The risk engine and the pricing notes are one list. `riskFlags` had been sitting
   * unwired since the first release — repeat-unpaid, high-value cash and a missing
   * payout account were computed by a function nothing called — so the flags a
   * merchant reads on an order now come from both halves: what the cart did wrong and
   * what the buyer's history says. */
  const flags = riskFlags(st, order, hist).concat(
    priced.authoritative ? priced.notes.slice(0, 6) : ['no menu on file: priced from the browser']);
  order.risk_flags = [...new Set(flags)].slice(0, 8);
  order.pay = payInstructions(st, order, pricing);

  /* One-tap confirm, without a bearer credential in the URL: each link is a
   * signed, 72-hour capability for THIS order and THIS action. Stored on the
   * order so the merchant can also reach it from the dashboard later. */
  const secret = env.ADMIN_SECRET || 'dev-secret';
  // Both links carry the store's auth generation, so a Revoke ends them the way it ends
  // sessions and code links. A confirm link is a write, and it was the last credential in the
  // product that did not know who it belonged to.
  const gen = String(st.auth_gen || '0');
  const markCap = await issueCap(secret, { a: 'mark', h: st.handle, id, s: 'paid', g: gen }, MARK_TTL);
  const cancelCap = await issueCap(secret, { a: 'mark', h: st.handle, id, s: 'cancelled', g: gen }, MARK_TTL);
  order.confirm_url = `${url.origin}/c/${markCap}`;
  order.cancel_url = `${url.origin}/c/${cancelCap}`;
  /* The buyer's link to add their own code later. Deliberately NOT stored on the
   * order: a merchant who reads the order document would otherwise hold a URL that
   * writes into a field labelled as coming from the buyer, and `via: 'buyer'` in the
   * audit log would stop being true. The capability exists in the response, for the
   * person who needs it, and nowhere else. */
  // The nonce is what makes the link worth one write: it is stored on the order, folded
  // into the signature, and rotated by every accepted write. Storing it here is not the
  // thing the comment above refuses — a nonce is not a URL and cannot become one without
  // the signing key, so a merchant reading the document learns only that a link exists.
  order.pcap = randomKey(8);
  const proofCap = await issueCap(secret, { a: 'proof', h: st.handle, id, g: String(st.auth_gen || '0'), n: order.pcap }, PROOF_WINDOW_SEC);

  /* The order document is written BEFORE the buyer is answered. It used to sit
   * in ctx.waitUntil, which meant a failed write — a spent KV write budget, a
   * namespace hiccup — was invisible: the buyer got "send 6.00 to 077…, quote
   * QTQ-0001" for an order that did not exist, and the merchant never saw it.
   * For a service whose whole pitch is proof-of-payment, that is the worst
   * possible failure, so only the notification is allowed to run after the
   * response. A persist failure now bubbles up and answers 503 with a retry
   * time, and nothing was told to anybody. */
  await persistOrder(env, st, order);
  ctx.waitUntil(Promise.resolve().then(() => notify(env, st, order)).catch(() => {}));

  const wa = st.whatsapp || '';
  const summary = waSummary(st, order);
  return json({
    ok: true,
    order: { id, code, at: order.at, status: order.status },
    pricing,
    pay: payInstructions(st, order, pricing),
    wa_link: wa ? `https://wa.me/${wa}?text=${encodeURIComponent(summary)}` : null,
    trust: { orders_before: hist.count, unconfirmed_before: hist.unpaid },
    risk_flags: order.risk_flags,
    // tap once: the page posts it itself, so a link scanner can never pull the trigger
    mark_url: `/c/${markCap}`,
    confirm_url: order.confirm_url,
    cancel_url: `/c/${cancelCap}`,
    // the receipt's second half: they have the code on screen right now.
    // `left` is the door's own word for the budget, and the storefront gates its
    // keep-this-link-on-your-device decision on it, so it has to be here and not only in
    // a POST the buyer has not made yet: minting a 72-hour door and then letting the page
    // drop it because the number went by another name is how the link died in the tab it
    // was handed to.
    proof_url: `/p/${proofCap}`,
    left: PROOF_WRITES_MAX,
    proof_writes: PROOF_WRITES_MAX,
  }, 201);
}


/**
 * Put a patch on the merchant's ledger row for this order, and keep trying for a moment if
 * the row is not there yet. `list:<handle>` is written just after the order document, so a
 * read served by another edge can still be holding the snapshot from before the order
 * existed — and skipping the mirror then is permanent: the code sits on the order while the
 * ledger keeps saying "no proof yet" (or "awaiting payment" after a mark) until something
 * else touches that row. Reads are free at $0 hosting and the row is there on the first try
 * in the normal case, so the cost of the loop is paid only by the race.
 */
async function mirrorRow(env, handle, id, patch) {
  const key = 'list:' + handle;
  for (let i = 0; i < 4; i++) {
    const list = (await env.ORDERS.get(key, 'json')) || [];
    const row = list.find((x) => x && x.id === id);
    if (row) {
      Object.assign(row, patch);
      await env.ORDERS.put(key, JSON.stringify(list));
      return true;
    }
    if (i < 3) await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function persistOrder(env, st, order) {
  if (!env.ORDERS) return;
  await env.ORDERS.put(`order:${st.handle}:${order.id}`, JSON.stringify(order));
  const key = 'list:' + st.handle;
  const cur = (await env.ORDERS.get(key, 'json')) || [];
  cur.unshift({
    id: order.id, code: order.code, at: order.at, total: order.pricing.total, name: order.buyer.name,
    phone: order.buyer.phone, service: order.service, status: order.status, flags: order.risk_flags,
    // the two things that turn "an alert for 12.34 arrived" into a matched payment,
    // on the row list so the ledger does not need the order document to answer
    payer: order.buyer.payer || '', proof: order.buyer.proof || '',
    prior_unpaid: order.prior_unpaid,
    // the money split, frozen at order time rather than recomputed from the shop's settings today:
    // four numbers on the row, and a whole month can be reported and downloaded without reading a
    // single order document. `unique_change` is here because it is not income and an accountant asks.
    tax: order.pricing.tax || 0, net: (order.pricing.vat && order.pricing.vat.net) != null ? order.pricing.vat.net : 0,
    vat_pct: (order.pricing.vat && order.pricing.vat.pct) || 0, vat_mode: (order.pricing.vat && order.pricing.vat.mode) || 'excl',
    // and the split itself, one entry per rate, so a shop that sells zero-rated staples alongside
    // taxed meals can file from the row list rather than from a phone call to an accountant
    vat_by: vatBuckets(order.pricing) || undefined,
    pay_now: order.pricing.pay_now, rounding: order.pricing.unique_change || 0,
    fee: order.pricing.fee || 0, fee_absorbed: order.pricing.fee_absorbed_by_merchant || 0,
    rail: order.pricing.rail && order.pricing.rail.key,
    // the row is what the dashboard mints from, so the row has to know the current nonce
    // or a shop's link to the buyer's field would be an unbound one
    pcap: order.pcap || '',
  });
  await env.ORDERS.put(key, JSON.stringify(cur.slice(0, MAX_ORDERS_KEPT)));
}


const MARK_BASE = '/api/mark?handle=';

async function notify(env, st, order) {
  const tasks = [];
  const body = JSON.stringify({ type: 'order.new', store: st.handle, order });
  if (st.notify_webhook) {
    tasks.push(fetch(st.notify_webhook, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Integrity proof for the merchant's own tooling. Never send a
        // credential in a header here: their webhook target is third-party
        // software that logs what it receives.
        'x-tapstall-body': await sign(env.ADMIN_SECRET || 'dev-secret', body),
        // same signature under the old name, for whoever already wired it up
        'x-zimlink-body': await sign(env.ADMIN_SECRET || 'dev-secret', body),
        // workers.dev bot rules reject requests without a browser-ish UA, which
        // would silently swallow a merchant's order notification
        'user-agent': 'tapstall/1 (order notification)',
      },
      body,
    }).catch(() => {}));
  }
  if (env.EMAIL && st.notify_email) {
    try {
      await env.EMAIL.send(new EmailMessage(
        `${st.handle}@notify.tapstall`, st.notify_email,
        `New order ${order.code} — ${order.pricing.pay_now} ${st.currency || 'USD'}`,
        notifyText(st, order)
        + `Open this to confirm (it needs your browser, nothing else): ${order.confirm_url || ''}\n`
        + `Dashboard: ${env.PUBLIC_ORIGIN || ''}/a with your store name and PIN`
      ));
    } catch (e) { /* email optional */ }
  }
  await Promise.all(tasks);
}
/** The only states a confirm/undo link may move an order into. */
function markTarget(v) { return (v === 'cancelled' || v === 'awaiting_payment') ? v : 'paid'; }

async function markPaid(req, url, env) {
  // POST only. A GET here would let a mail scanner or a link-preview crawler
  // "confirm" an unpaid order simply by prefetching the link in the email.
  if (req.method !== 'POST') {
    /* Links handed out by the previous version were GETs with the store key in
     * them. Tapping one should not dead-end, so a stale link is traded for a
     * session instead of acted on: the redirect only ever lands on the login
     * page, which changes nothing, so a prefetching crawler still cannot
     * confirm an order. */
    const legacy = url.searchParams.get('token');
    const lh = slug(String(url.searchParams.get('handle') || ''));
    if (legacy && lh) {
      const lst = await getStore(env, lh);
      if (lst && lst.admin_token && timingSafeEq(String(lst.admin_token), String(legacy))) {
        return redirect(`/a?handle=${lh}&token=${encodeURIComponent(legacy)}`);
      }
      // Guessing at an old-style link is a credential failure, counted — but once
      // the store is frozen the count is full anyway, and a per-request write there
      // is a free way to spend a tenant's daily write budget.
      if (lst && !(await lockedOut(env, lh))) await authFail(env, lh);
    }
    return json({ ok: false, error: 'method_not_allowed', why: 'Confirm links are opened, not fetched. Open the link in a browser and it posts itself, and the page shows you the money first.' }, 405, { Allow: 'POST' });
  }
  const b = await readBody(req);
  const secret = env.ADMIN_SECRET || 'dev-secret';
  const p = b.cap ? await verifyCap(secret, String(b.cap)) : null;
  const viaCap = !!(p && p.a === 'mark');
  // A `cap` that is present but not valid is the interesting case: say so, and
  // say it the same way whether it expired, was edited or came from a copy.
  if (b.cap && !viaCap) {
    return json({ ok: false, error: 'link_expired', why: 'Confirm links last 72 hours and work once per state. Open your dashboard and tap Confirm on the order for a fresh one.' }, 401);
  }

  const handle = viaCap ? p.h : slug(String(b.handle || ''));
  const want = markTarget(viaCap ? p.s : b.status);
  const st = await getStore(env, handle);
  if (!st) return json({ ok: false, error: 'no store' }, 404);

  let id = viaCap ? p.id : String(b.id || '');
  if (!viaCap) {
    // The lockout guards guessable credentials only. A valid capability needs
    // no guessing, so a stranger must not be able to freeze the merchant's
    // one-tap confirm — 12 bad requests would otherwise be a cheap DoS.
    const who = await identify(req, env, handle);
    const lr = lockRes(who); if (lr) return lr;
    if (!who || who.anonymous) return json({ ok: false, error: 'not signed in', need_login: true }, 401);
    if (who.bad) { await authFail(env, handle); return json({ ok: false, error: 'bad key or revoked session' }, 403); }
    if (who.via === 'sess' && (reqHeader(req, 'x-tapstall-confirm') || '') !== '1') {
      return json({ ok: false, error: 'confirm header missing' }, 403);
    }
    if (!id) return json({ ok: false, error: 'id required' }, 422);
  }
  const key = `order:${handle}:${id}`;
  const o = await env.ORDERS.get(key, 'json');
  if (!o) return json({ ok: false, error: 'no such order' }, 404);
  // Checked before the `already` short-circuit on purpose. A link that no longer holds authority
  // must not be answered as though it does: "already paid" would be a true statement about the
  // order and a false one about the link, and the person holding it would keep it.
  if (viaCap && !capGenOk(p, st, o)) {
    return json({
      ok: false, error: 'link_revoked', revoked: true, final: true,
      handle, code: o.code, status: o.status,
      why: 'This shop has closed its payment links, so this link writes nothing. The order itself is unchanged — the shop can still confirm it from the dashboard in one tap.',
    }, 410);
  }
  if (o.status === want) {
    // replay (double click, retry) is a no-op, not a second state change
    return json({ ok: true, id: o.id, status: o.status, already: true });
  }
  const prev = o.status;
  o.status = want;
  o.marked_at = new Date().toISOString();
  if (o.status === 'paid') {
    const hk = `buyer:${handle}:${o.buyer_hash}`;
    const rec = (await env.STORES.get(hk, 'json')) || { count: 0, unpaid: 0 };
    rec.unpaid = Math.max(0, (rec.unpaid || 0) - 1);
    await env.STORES.put(hk, JSON.stringify(rec), { expirationTtl: 180 * 86400 });
  }
  await env.ORDERS.put(key, JSON.stringify(o));
  // `marked_at` rides with the status: the cash basis is "the day the money arrived", and the row
  // is the only thing the ledger reads, so a date that lives only on the order document would
  // leave a shop unable to say which week a payment belonged to without pulling every document.
  await mirrorRow(env, handle, o.id, { status: o.status, marked_at: o.marked_at });   // the ledger keeps pace, or tries to
  const logged = await pushAudit(env, st, { act: 'mark', via: viaCap ? 'link' : 'session', fields: [o.code + ' → ' + want], ip: ipOf(req) });
  // an undo link for 15 minutes, same shape, opposite action
  // undo returns the order to whatever it was before this tap
  const undo = await issueCap(secret, { a: 'mark', h: handle, id, s: prev, g: String(st.auth_gen || '0') }, UNDO_TTL);
  const label = { paid: 'Marked paid', cancelled: 'Cancelled', awaiting_payment: 'Reopened' }[o.status];
  // `logged:false` is a gap in the paper trail, not a failed tap: the order row
  // above is already written, and saying so beats a 500 that leaves the merchant
  // guessing whether to tap again
  return json({ ok: true, id: o.id, code: o.code, status: o.status, label, logged, amount: o.pricing && o.pricing.pay_now, undo_url: '/c/' + undo });
}
/* ------------------------------------------------------------------------------------
 * the buyer's half: one field, on a link of its own
 *
 * A payment code arrives after the order does, and the receipt is where that moment
 * happens. So the receipt gets a door — with one room behind it. This handler cannot
 * touch `status`, it closes when the shop settles the order, and it is a different
 * capability kind from the merchant's confirm link, which means a `/p/` URL leaked
 * into a group chat is worth a reference field and nothing else.
 * ---------------------------------------------------------------------------------- */

/** The page behind a buyer's link: the order as the shop sees it, the field, one button. */
async function proofPage(env, cap) {
  const p = await verifyCap(env.ADMIN_SECRET || "dev-secret", cap);
  const card = (title, lines, code, tail) => html(shell(title, `<h2 style="margin:.1rem 0 .5rem">${esc(title)}</h2>`
    + lines.map((t) => `<p class=t>${t}</p>`).join("") + (tail || "")), code, NOINDEX);
  if (!p || p.a !== "proof") {
    return card("This link is finished",
      ["A code link lasts 72 hours after the order, and all it can ever do is add a reference to that one order. If it has closed, send the code in the chat with the shop — they can find the order by its amount."], 401);
  }
  const st = await getStore(env, p.h);
  // Two facts that used to share one sentence. A shop that is not on the books has not closed
  // anything, and the difference is not politeness: the branch below hands the phone a script that
  // deletes the buyer's link, and a page may not rewrite someone's storage on the strength of a
  // guess about which of the two it is looking at.
  if (!st) {
    return card("There is no shop behind this link",
      ["The store this link was written for is not on the books any more, so there is no field here to answer. Nothing you did changed that. If the shop is still trading, send the code in your chat with it."], 404);
  }
  const o = await env.ORDERS.get(`order:${st.handle}:${p.id}`, "json");
  // The credential first, then what it points at: a link the shop has closed is dead whatever is
  // behind it, and answering "order not found" instead would leave the buyer looking for an order
  // they were never meant to find. The row is read first only because the rule needs it to judge a
  // link with no generation, and a missing row is judged as one that has not moved.
  if (!capGenOk(p, st, o || {})) {
    // The same rule the confirm link and the renew record answer to, in the core, with its one
    // branch for a link minted before the rule existed. A copy of this comparison here would be a
    // third opinion on what a stale credential means, which is how a shop that never pressed
    // Revoke came to be told it had closed its links.
    return card("The shop closed its code links",
      ["Nothing is wrong with your order. Revoking access on the shop closes these links too, so send the code to the shop directly."], 410,
      pfForgetScript(st.handle, "", cap));
  }
  if (!o) return card("Order not found", ["It is not on this shop's list any more."], 404, pfForgetScript(st.handle, "", cap));
  if (proofUsed(o, p.n) && proofOpen(o)) {
    // Spent link, open order: the one refusal that closes the link and not the field. the order has moved
    // on to a new token, so the URL in the buyer's phone is worth putting down — while the
    // field itself is still open on their receipt, which is where the sentence sends them.
    // Nothing is minted here: a spent link that could ask for a fresh one is not spent.
    // The one case that must not borrow this sentence is the hand-back: a link the shop retired
    // while the buyer was carrying it is not a link the buyer used, and saying so would be a
    // accusation with nothing behind it. Same status, same pruning, different words.
    // and the sentence has to survive the device it is read on. "Open your receipt" was true of
    // the phone that filed the code, because the answer left a newer door in that phone's list;
    // it was never true of the phone a forwarded link arrived on, and after a hand-back it is
    // true of nobody — every link for the order is retired at once. The route that always exists
    // is the chat, where the shop has the same field on its own side (0.7.4).
    const sup = proofSuperseded(o, p.n);
    return card(sup ? "That link is retired" : "That link is used", [sup
      ? `The shop cleared the code on this order, so every link written for it is retired — nothing you did caused that. Send the code in your chat with the shop: their ledger has the same field, one box, and they can put it on the order for you.`
      : `This order's field accepts one code per link, and this one has already filed something. If this phone has a newer link for the order, that box is still open — otherwise send the code in your chat and the shop can put it on the order for you, because their ledger has the same field and nothing else it can change.`],
      410, pfForgetScript(st.handle, "", cap));
  }
  const back = `<p class=t><a href="/s/${esc(st.handle)}">Back to ${esc(st.name || st.handle)}</a></p>`;
  const rail = (o.pricing || {}).rail;
  const noun = proofNoun(rail);
  const onFile = cleanProof((o.buyer || {}).proof);
  const left = Math.max(0, PROOF_WRITES_MAX - (Number(o.proof_writes) || 0));
  const open = proofOpen(o);
  const amount = `${(Number(o.total) || 0).toFixed(2)} ${esc(o.currency || "")}`.trim();
  const pay = o.pay || {};
  const ask = proofAsk(o);
  const wa = String(st.whatsapp || "").replace(/[^0-9]/g, "");
  // The same second field the order form had, and no more than that: it appears only
  // where this shop's rail reconciles by sender number (`ask_payer`, frozen on the slip
  // at order time, so a shop that changes its rail cannot retroactively demand it of a
  // buyer who already answered or declined) and only while the order has none. A buyer
  // who typed a code but skipped the number can finish their own record; a buyer with
  // both sees no second box and no extra sentence.
  const wantPayer = !!(o.pay && o.pay.ask_payer) && !cleanPayer((o.buyer || {}).payer, 'loose');
  const onFilePayer = cleanPayer((o.buyer || {}).payer, 'loose');
  const state = !open
    ? `<p>This order is ${esc(o.status)}, so its record is closed from here. ${esc(left > 0 ? "If the code needs correcting, message the shop — they can fix it on their side." : "Message the shop and they will fix it on their side.")}</p>`
    : left <= 0
      ? "<p>You have added this as many times as the order allows. Message the shop if it still needs correcting.</p>"
      : `<form method=post action="/api/proof" style="margin-top:.9rem">`
        + `<input type=hidden name=cap value="${esc(cap)}"><input type=hidden name=form value=1>`
        + `<label class=t for=proof>${esc(onFile ? "Correct the reference" : noun.label)}</label>`
        + `<input id=proof name=proof value="${esc(onFile)}" maxlength=40 autocapitalize=characters spellcheck=false autocomplete=off`
        + ` style="font:inherit;width:100%;box-sizing:border-box;padding:.65rem .7rem;margin:.35rem 0 .6rem;border:1px solid #cfd8e3;border-radius:10px">`
        + (wantPayer
            ? `<label class=t for=payer style="display:block;margin-top:.6rem">Number you will pay from`
              + ` <span style="font-weight:400;font-size:.82em">(optional — helps us find your payment)</span></label>`
              + `<input id=payer name=payer maxlength=30 inputmode=tel autocomplete=off spellcheck=false placeholder="0712345678"`
              + ` style="font:inherit;width:100%;box-sizing:border-box;padding:.65rem .7rem;margin:.35rem 0 0;border:1px solid #cfd8e3;border-radius:10px">`
            : '')
        + `<button type=submit style="margin-top:.6rem">Send it to the shop</button>`
        + `<p class=t style="margin-top:.5rem">${esc(noun.hint)}</p>`
        + `<p class=t style="margin-top:.7rem">One link, this order only. It adds a reference — it cannot mark anything paid, and the shop still decides when the money has arrived.</p>`
        + (left < PROOF_WRITES_MAX ? `<p class=t>${left} more ${left === 1 ? "correction" : "corrections"} allowed on this order.</p>` : "")
        + (wa ? `<p class=t style="text-align:center"><a href="https://wa.me/${wa}?text=${encodeURIComponent(`Order ${o.code || ""} — my payment is ${amount}`)}">or send it in the chat</a></p>` : "")
        + `</form>`;
  const pfClear = pfForgetScript(st.handle, o.code, cap);
  const body = `<p class=t>${esc(st.name || st.handle)}</p>`
    + `<h2 style="margin:.15rem 0 .5rem">Order <b>${esc(o.code || "")}</b></h2>`
    + `<p class=t><b>${amount}</b> · ${esc(o.status || "open")}${rail && rail.label ? " · " + esc(rail.label) : ""}</p>`
    + (pay.account ? `<p class=t>Paid to <b>${esc(pay.account)}</b></p>` : "")
    + (onFile || onFilePayer
        ? `<p>The shop has ${onFile ? 'the reference <b>' + esc(onFile) + '</b>' : 'a sender number'} on this order${onFilePayer ? (onFile ? ', sent from <b>' + esc(onFilePayer) + '</b>' : '<b>' + esc(onFilePayer) + '</b>, and no reference yet') : ''}.</p>`
        : (ask ? `<p class=t>${esc(ask)}</p>` : ""))
    + state + back + pfClear;
  return html(shell("Add your payment code", body), 200, NOINDEX);
}

/**
 * Put the door down where it was picked up. The storefront keeps the receipt's link
 * on the buyer's own device until it is used; this is the "used" signal. It is
 * decoration, not state — if the write fails, if the key is blocked, if the browser is
 * a WhatsApp webview with storage switched off, all that happens is a line that offers
 * a link one more time, and the link's own page tells the truth about the order.
 *
 * The values go in as a regex-checked literal, not as HTML-escaped text, because this
 * is a script: anything that is not a shop handle or an order code is refused outright
 * and the script is simply not emitted.
 */
/**
 * `code` is how the storefront names an entry; `cap` is how a page that never got to the
 * order can still name one — a revoked shop or a vanished order knows the link it was
 * reached by and nothing else. Either half may be missing; both being missing emits
 * nothing. The url half is the client's own storage shape, `/^\/p\/[A-Za-z0-9._-]{20,400}$/`,
 * pinned against it in pages.test.mjs so the two files cannot drift apart silently.
 */
function pfDoorScript(handle, code, cap, mode) {
  const h = String(handle || '');
  if (!/^[a-z0-9-]{2,30}$/.test(h)) return '';
  const c = String(code || '');
  const k = String(cap || '');
  const keep = mode === 'keep' && /^[A-Za-z0-9._-]{20,400}$/.test(k);
  const test = [
    /^[A-Za-z0-9_-]{1,16}$/.test(c) ? 'String(x.c)==="' + c + '"' : '',
    /^[A-Za-z0-9._-]{20,400}$/.test(k) ? 'String(x.u)==="/p/' + k + '"' : '',
  ].filter(Boolean).join('||');
  if (!test && !keep) return '';
  // both shapes drop the entry they name; `keep` then puts the fresh door in that slot, so
  // the line under the notice bar is never a link that can only answer "used"
  const drop = keep
    ? (/^[A-Za-z0-9_-]{1,16}$/.test(c) ? 'String(x.c)==="' + c + '"' : 'String(x.u)==="/p/' + k + '"')
    : test;
  const put = keep ? '.push({c:"' + String(code || '').slice(0, 16) + '",u:"/p/' + k + '",t:Date.now()})' : '';
  return '<script>try{var k="tp_pf_' + h + '",a=JSON.parse(localStorage.getItem(k)||"[]");'
    + 'if(Object.prototype.toString.call(a)==="[object Array]"){var n=a.filter(function(x){return !(x&&(' + drop + '))})'
    + put + ';if(n.length>5)n=n.slice(-5);'
    + 'if(n.length!==a.length)localStorage.setItem(k,JSON.stringify(n))}}catch(e){}</script>';
}
function pfForgetScript(handle, code, cap) { return pfDoorScript(handle, code, cap, 'forget'); }
function pfKeepScript(handle, code, cap) { return pfDoorScript(handle, code, cap, 'keep'); }

/**
 * The write. Same shape as `markPaid`, minus the money: POST-only, its own rate
 * bucket, the capability re-verified on the way in, and the store's revoke generation
 * re-checked so the one lever at the top of the shop still closes this door.
 */
async function proofAdd(req, url, env) {
  const ip = ipOf(req);
  // A form post is a person, and a person gets a page. The rate limit is the one answer
  // that must be given before the body is read, so the shape comes from the only thing
  // visible that early: urlencoded is the <form>, json is the dashboard. And it prunes
  // nothing — a busy minute is not an answer about the order, and a buyer who is told to
  // wait should still find the link where they left it.
  const isForm = String(req.headers.get("content-type") || "").includes("application/x-www-form-urlencoded");
  // the rate limit answers before the body is read, so it builds its own envelope — with
  // the two fields the refusal helper carries, because a caller deciding "do I keep this
  // box open?" must not have to tell a throttled minute from a closed door by prose
  const throttle = (m) => json({ ok: false, error: m, why: "throttled", final: false }, 429);
  if (await rateLimited(env, ip, "proof:", PRL)) {
    const msg = "too many attempts from you — wait a minute and send it again";
    return isForm
      ? html(shell("Not added", `<h2 style="margin:.1rem 0 .5rem">Not added</h2><p class=t>${esc(msg)}</p>`
          + `<p class=t>Nothing you have already sent was lost, and one more minute is all it needs.</p>`), 429, NOINDEX)
      : throttle(msg);
  }
  const b = await readBody(req);
  const asPage = b.form === "1";
  // `final` is the whole of it: an answer that means this door will never open again may
  // put it down, and an answer that means "not yet" may not. A rate limit and an empty
  // field are not answers, so they are never final; a settled order, a shop that closed
  // its links, and an order that is gone are, and each one leaves the buyer's notice bar
  // offering a link that could only ever say "not added" a second time.
  //
  // The same two facts ride the JSON answer as `final` and `why`, because the receipt page
  // carries this door inline now and has to decide whether to keep it or fold it away. A
  // browser reading English to work that out is a browser that stops working the day the
  // sentence is reworded, so the Worker keeps the classification and says it in a field.
  // `shell` takes a title and a body and nothing else: the status and the noindex header
  // belong to `html`. They were passed one level in on this page path, which made every
  // refusal a buyer could see answer HTTP 200 and drop the robots header — invisible in the
  // body, and invisible to a test that only reads the words.
  const no = (msg, code, handle, final, why) => {
    // `used` and `superseded` are one fact about the link (it is finished, put it down) and two
    // facts about the buyer (you used it / the shop retired it), so they share the pruning and
    // the folding and never share the sentence. `dead` is the single place that knows this.
    const dead = why === "used" || why === "superseded";
    return asPage
      ? html(shell("Not added", `<h2 style="margin:.1rem 0 .5rem">Not added</h2><p class=t>${esc(msg)}</p>`
          + (handle ? `<p class=t><a href="/s/${esc(handle)}">Back to the shop</a></p>` : "")
          // a used token is pruned for a different reason than a closed field: the link is
          // dead, the field is not, so the sentence has to send them to the receipt instead of
          // the chat — and `used` rides the JSON so the inline box knows to fold itself away
          + (handle && (final || dead) ? pfForgetScript(handle, "", String(b.cap || "")) : "")), code, NOINDEX)
      : json({ ok: false, error: msg, why: why || "refused", final: !!final,
        used: dead, ...(dead ? { superseded: why === "superseded" } : {}) }, code);
  };
  const p = b.cap ? await verifyCap(env.ADMIN_SECRET || "dev-secret", String(b.cap)) : null;
  if (!p || p.a !== "proof") return no("that link does not open this field any more", 401, "", false, "cap");
  const st = await getStore(env, p.h);
  if (!st) return no("no such shop", 404, "", false, "shop");
  const key = `order:${st.handle}:${p.id}`;
  const o = await env.ORDERS.get(key, "json");
  // Read the row first, because the rule needs it: a link with no generation is judged by whether
  // the order moved after the shop last revoked, and that is a question about the order. The
  // credential is still answered before the row's absence is, so a closed link is never reported
  // as a missing order — that ordering is the shipped contract, and it is kept on purpose.
  if (!capGenOk(p, st, o || {})) return no("this shop has closed its code links", 410, st.handle, true, "revoked");
  if (!o) return no("no such order", 404, st.handle, true, "gone");
  const r = proofAccept(o, { proof: b.proof == null ? null : String(b.proof), payer: b.payer == null ? null : String(b.payer) }, 'buyer');
  /* One link, one *change*. A spent link may still submit the value the order already holds,
     because that is not a second edit — it is the retry of a first one whose answer was lost,
     and a buyer told "already used" in that case is a buyer who pays again or phones the shop.
     A spent link offering anything NEW is the thing that is refused. */
  if (proofUsed(o, p.n) && proofOpen(o)) {
    if (r.ok && !r.changed) {
      const again = `Payment reference ${r.proof || r.payer} is on order ${o.code || ""}. That is what the shop already has, so nothing was rewritten.`;
      if (asPage) {
        return html(shell("Sent", `<h2 style="margin:.1rem 0 .5rem">Sent to the shop</h2><p>${esc(again)}</p>`
            + pfForgetScript(st.handle, o.code, String(b.cap || ""))
            + `<p class=t>You can close this now — settling the order is the shop's to do.</p>`), 200, NOINDEX);
      }
      return json({ ok: true, changed: false, code: o.code, proof: o.buyer.proof, payer: o.buyer.payer,
        left: r.left, note: again, proof_url: null, retry: true });
    }
    const sup = proofSuperseded(o, p.n);
    // the inline box folds itself away on `used`, so this string is the whole answer the buyer
    // sees on the receipt: it may name what just happened to the field, and it may not send them
    // looking for a box that a hand-back has already closed for everybody
    return no(sup
      ? "the shop cleared that code, so every link for this order is retired — send it in the chat and they can put it on the order for you"
      : "this link has already filed a code — a newer link from this order still works, or the shop can put it on the order for you",
      410, st.handle, false, sup ? "superseded" : "used");
  }
  if (!r.ok) return no(r.msg, r.why === "settled" ? 409 : r.why === "spent" ? 429 : 422, st.handle,
    r.why === "settled" || r.why === "spent", r.why);
  if (r.changed) {
    const when = new Date().toISOString();
    o.buyer = Object.assign({}, o.buyer || {}, { proof: r.proof, payer: r.payer });
    o.proof_writes = r.writes; o.proof_at = when; o.proof_by = "buyer";
    // the token is spent the moment the value lands, so the order moves to a new nonce and
    // this response — and only this response, in the hand that just wrote — carries the one
    // link worth using next
    const nextNonce = randomKey(8);
    o.pcap = nextNonce;
    await env.ORDERS.put(key, JSON.stringify(o));
    // and onto the row the merchant reads, so the chase sentence disappears from the
    // place it was written: the same two writes a mark spends, no more
    await mirrorRow(env, st.handle, o.id, {
      payer: o.buyer.payer, proof: o.buyer.proof, proof_by: "buyer", proof_at: when, pcap: nextNonce,
    });
    await pushAudit(env, st, { act: "proof", via: "buyer",
      fields: [`${o.code || o.id} ← ${[o.buyer.proof, o.buyer.payer].filter(Boolean).join(' · ')}`], ip });
  }
  // the fresh token, minted only for the caller whose write was just accepted: whoever can
  // file once can correct twice more, and does not need a second link to anybody else
  let freshUrl = "";
  if (r.changed) {
    const fresh = await issueCap(env.ADMIN_SECRET || "dev-secret",
      { a: "proof", h: st.handle, id: o.id, g: String(st.auth_gen || "0"), n: o.pcap }, PROOF_WINDOW_SEC);
    freshUrl = "/p/" + fresh;
  }
  const note = `Payment reference ${r.proof || r.payer} is on order ${o.code || ""}.`
    + (r.changed ? "" : " That is what the shop already had, so nothing was rewritten.")
    + (r.left > 0 ? ` You can correct it ${r.left} more time${r.left === 1 ? "" : "s"} while the order is open.` : "");
  if (asPage) {
    // the kept line and the box are the same door, so when this answer carries a fresh one
    // the device takes it: a buyer who mistyped, closed the page, and came back tomorrow
    // should find the offer still standing — `withAsk` mints nothing while a code is on file,
    // so this response is the only place the next link exists
    return html(shell("Sent", `<h2 style="margin:.1rem 0 .5rem">Sent to the shop</h2><p>${esc(note)}</p>`
      + (r.changed && r.left > 0 && freshUrl
          ? pfKeepScript(st.handle, o.code, freshUrl.slice(3))
          : pfForgetScript(st.handle, o.code, String(b.cap || "")))
      + (r.changed && r.left > 0
          ? `<p class=t><a href="${esc(freshUrl)}">Correct it</a> — this field takes ${r.left} more ${r.left === 1 ? "change" : "changes"} on this order.</p>`
          : "")
      + `<p class=t>You can close this now — settling the order is the shop's to do.</p>`
      + `<p class=t><a href="/s/${esc(st.handle)}">Back to ${esc(st.name || st.handle)}</a></p>`), 200, NOINDEX);
  }
  return json({ ok: true, changed: r.changed, code: o.code, proof: o.buyer.proof, payer: o.buyer.payer,
    left: r.left, note, proof_url: freshUrl || null });
}

/* -------------------------------------------------------------- register */
async function register(req, url, env) {
  const b = await req.json().catch(() => null);
  if (!b) return json({ ok: false, error: 'bad json' }, 400);
  const handle = slug(String(b.handle || b.shop_name || '')).slice(0, 30);
  if (!validHandle(handle)) return json({ ok: false, error: 'handle: 2-30 chars, lowercase a-z 0-9 and dashes' }, 422);
  if (!b.shop_name) return json({ ok: false, error: 'shop_name required' }, 422);
  // A Google Sheet is one way to stock a shelf, not a precondition of trading: a
  // merchant who types their items into the dashboard opens the same store with the
  // same money rules. A value that is not a link at all is still refused, because a
  // typo'd sheet is how "0 items" and a silent lost week of orders begins.
  const fed = String(b.feed_url || '').trim();
  if (fed && !/^https?:\/\//.test(fed)) return json({ ok: false, error: 'feed_url must be a public Google Sheet link — or leave it blank and type your items in the dashboard' }, 422);
  if (!digits(b.whatsapp || b.phone || '')) return json({ ok: false, error: 'WhatsApp number required (with country code)' }, 422);
  if (await getStore(env, handle)) return json({ ok: false, error: 'handle already taken — try another, or use your renew link' }, 409);

  const adminKey = randomKey(16);
  const renewToken = alnumToken(14);   // path-safe: base64url -/_ would break the /renew/ route
  const st = {
    handle,
    shop_name: String(b.shop_name).slice(0, 60),
    tagline: String(b.tagline || '').slice(0, 140),
    logo: cleanImg(b.logo, handle),   // a URL at sign-up; there is nothing stored to reference yet
    whatsapp: digits(b.whatsapp || b.phone).replace(/\D/g, '').slice(0, 15),
    location: String(b.location || '').slice(0, 90),
    hours: String(b.hours || '').slice(0, 60),
    // Onboarding may arrive with a week and per-rail numbers already in hand (the
    // CSV importer and a merchant's own form both do). Junk in that half is dropped
    // silently — the dashboard is the careful path — but a blank must never make a
    // store believe hours it never set.
    ...(() => { try {
      const g = {};
      const wk = cleanWeek(b.week); if (wk) { g.week = wk; }
      const ra = cleanRailAccts(b.rail_accts, null); if (ra) g.rail_accts = ra;
      if (g.week) g.hours = hoursText(g.week);
      return g;
    } catch (e) { return {}; } })(),
    feed_url: fed.slice(0, 400),
    currency: String(b.currency || 'USD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3),
    zig_rate: Number(b.zig_rate) || 0,
    tax_pct: clamp(Number(b.tax_pct), 0, 40) || 0,
    rail: await registerRail(b, env),
    rail_def: String(b.rail || '') === 'custom' ? (normaliseRail(b.rail_def, 'custom') || null) || undefined : undefined,
    surcharge_mode: b.surcharge_mode === 'pass' ? 'pass' : 'absorb',
    delivery_fee: clamp(Number(b.delivery_fee), 0, 10000) || 0,
    free_over: Number(b.free_over) || 0,
    pay_account: String(b.pay_account || '').slice(0, 60),
    reference_format: String(b.reference_format || '{code}').replace(/[^{ }A-Za-z0-9_-]/g, '').slice(0, 30),
    order_prefix: (String(b.order_prefix || handle.slice(0, 3).toUpperCase()).replace(/[^A-Za-z0-9-]/g, '') || 'ORD').slice(0, 6),
    unique_change: b.unique_change !== false,
    require_optin: !!b.require_optin,
    max_order_value: Number(b.max_order_value) || 0,
    cod_review_above: Number(b.cod_review_above) || 80,
    cache_seconds: clamp(Number(b.cache_seconds), 15, 3600) || 120,
    notify_webhook: /^https?:\/\//.test(b.notify_webhook || '') ? String(b.notify_webhook).slice(0, 300) : '',
    notify_email: isEmail(b.notify_email) ? b.notify_email : '',
    owner_email: isEmail(b.owner_email) ? b.owner_email : '',
    created_at: new Date().toISOString(),
    admin_token: adminKey,          // API key for the merchant's own tooling; never in a URL
    auth_gen: '0',                  // bump to invalidate every link, key and cookie
    paid_until: Date.now() + FREE_DAYS * 864e5,
    plan: 'free60',
    term_days: FREE_DAYS,
  };
  st.renew_url = `${url.origin}/renew/${renewToken}`;
  /* The merchant's whole way in, created here and shown once: a key (their store
     name, already public in the storefront URL) and a six-digit PIN that exists in
     this response and the welcome email and nowhere else. Nothing about signing in
     expires, so nothing about it can go stale in an inbox or be mangled by a mailer. */
  const pin = genPin();
  st.pin = await pinRecord(pin);
  await env.STORES.put('store:' + handle, JSON.stringify(st));
  // `g` because the link must die with the authority that issued it: `made` is what a legacy
  // record is judged by, and a record with neither is the hole the Revoke was meant to close.
  await env.STORES.put('renew:' + renewToken,
    JSON.stringify({ handle, made: Date.now(), g: String(st.auth_gen || '0') }));
  const products = await loadProducts(st, env);          // cache honoured; a menu edit is applied after it, so it shows at once
  const err = st.feed_cache && st.feed_cache.error;
  if (st.owner_email) {
    try {
      await sendMail(env, st.owner_email, `Your ${st.shop_name} store is live`,
        `Store: ${url.origin}/s/${handle}\nSign in at ${url.origin}/a with key ${handle} and PIN ${pin} — that is the whole method.\nManage orders there. ${st.feed_url ? `Edit your menu any time (it updates itself within ~2 min): ${st.feed_url}` : 'Add your items in the dashboard under Shop → Edit items here — no spreadsheet needed.'}\n\n${products.length} products loaded. ${err ? 'FEED WARNING: ' + err : ''}\nFree until ${new Date(st.paid_until).toDateString()}. Renew (no monthly billing): ${st.renew_url}`);
    } catch (e) {}
  }
  return json({
    ok: true, handle,
    store_url: `${url.origin}/s/${handle}`,
    key: handle, pin, renew_url: st.renew_url,
    pin_note: 'Show this PIN to nobody. Change it inside the dashboard any time; if it is lost, “I lost my PIN” on the sign-in screen resets it from the store’s own details — no operator, no waiting.',
    products_loaded: products.length, feed_error: err || null,
    free_until: new Date(st.paid_until).toISOString(),
    note: products.length
      // Either door is offered, because both are real now: the sheet is one way to
      // change a price, the dashboard is the other, and neither waits on an operator.
      ? 'Live. Put the link in your WhatsApp/IG bio and status. Change a price or mark something sold out in the dashboard any time, or edit your Google Sheet — both are the same shelf.'
      : (st.feed_url
        ? 'Store is live but 0 products loaded. Share your Sheet as "Anyone with the link — Viewer" and make sure row 1 is: id,name,category,price,currency,image,description,options,addons,stock,popular'
        : 'Live with an empty shelf. Open the dashboard, Shop → Edit items here, and type your items in — a Google Sheet is optional here, not required.'),
  }, 201);
}

/** A store's rail must exist in the catalogue; `custom` means "the merchant
 *  described it" and is only honoured when the description is valid, because a
 *  half-typed rail would silently price every order at 0% fee. An invalid one
 *  falls back to cash — the buyer is still told to pay on delivery, which is a
 *  wrong-but-safe instruction rather than a wrong amount. */
async function registerRail(b, env) {
  const key = String(b.rail || '');
  if (key === 'custom') return normaliseRail(b.rail_def, 'custom') ? 'custom' : 'cash';
  const cat = await railsCatalog(env);
  return cat[key] ? key : 'cash';
}

async function lookup(url, env) {
  // Public storefront health only. This endpoint used to return admin_url and
  // renew_url, which meant anyone who knew a shop handle could read the master
  // dashboard link (and with it every buyer name and number) from a shell.
  const handle = slug(url.searchParams.get('handle') || '');
  const st = await getStore(env, handle);
  if (!st) return json({ ok: false, error: 'not found' }, 404);
  return json({
    ok: true,
    store: {
      handle, shop_name: st.shop_name, plan: st.plan, paid_until: st.paid_until,
      suspended: !!st.suspended, rail: st.rail, currency: st.currency,
      products: st.feed_cache ? st.feed_cache.count : 0, feed_error: st.feed_cache ? st.feed_cache.error : null,
      orders_today: ((await env.ORDERS.get('list:' + handle, 'json')) || []).length,
    },
  });
}
/**
 * The merchant-only door, in one place: identify, then the four answers in the order they matter —
 * no store, then the lockout (a lockout must be honoured before anything else spends effort on a
 * credential that is right-but-cooled), then an anonymous request, then a bad key, which is the
 * only answer that costs the shop a failed-attempt record.
 *
 * Four routes used to re-type this block, and a fifth (the books) was about to become a fifth copy.
 * The order of those lines is the whole security property; a copy is where the order goes wrong.
 */
async function adminGate(req, env, handle) {
  const who = await identify(req, env, handle);
  if (!who || !who.st) return { res: json({ ok: false, error: 'no store' }, 404) };
  const lr = lockRes(who); if (lr) return { res: lr };
  if (who.anonymous) return { res: json({ ok: false, error: 'unauthorised', need_login: true }, 401) };
  if (who.bad) { await authFail(env, handle); return { res: json({ ok: false, error: 'bad key or revoked session' }, 403) }; }
  return { who };
}

async function adminView(req, url, env) {
  const handle = slug(url.searchParams.get('handle') || '');
  const g = await adminGate(req, env, handle);
  if (g.res) return g.res;
  const who = g.who;
  const st = who.st;
  const rows = (await env.ORDERS.get('list:' + handle, 'json')) || [];
  const orders = [];
  for (const r of rows.slice(0, 40)) orders.push(await env.ORDERS.get(`order:${handle}:${r.id}`, 'json'));
  return json({
    ok: true,
    via: who.via,
    // No admin_url here on purpose: a login code inside a JSON body turns any
    // XSS on the dashboard into a saved 7-day credential. The session cookie is
    // HttpOnly, so the page itself cannot read it back.
    store: { ...adminStore(st), feed_url: st.feed_url, renew_url: st.renew_url, dashboard_path: '/a',
      // the *date* the PIN was set, not anything about it: an owner scanning this
      // should be able to see "changed 3 days ago" without the dashboard ever
      // holding a credential it could leak
      pin_set_at: st.pin ? (st.pin.set_at || null) : null },
    // read-time, like the sentence itself: a mint costs one HMAC and no KV write, so
    // the dashboard can hand every open row a live link without storing anything that
    // outlives the request
    orders: await Promise.all(orders.filter(Boolean).map((o) => withAsk(o, st, url.origin, env))),
    // the owner sees the real queued value — cancelling is useless if they
    // cannot check what was typed — while the append-only log keeps it masked
    pending: st.pending ? { keys: Object.keys(st.pending.fields), apply_at: st.pending.apply_at, in_ms: Math.max(0, st.pending.apply_at - Date.now()), fields: st.pending.fields } : null,
    editable: EDITABLE_FIELDS,
    soft_fields: SOFT_FIELDS,
    audit: await getAudit(env, handle),
    stats: { total: rows.length, cod: rows.filter(r => r.status === 'cod').length, flags: rows.filter(r => (r.flags || []).length).length },
  }, 200, { 'Cache-Control': 'no-store' });
}
/* ------------------------------------------- payment → auto activation */
async function checkout(req, url, env) {
  const b = await req.json().catch(() => null) || {};
  const rec = await env.STORES.get('renew:' + String(b.token || ''), 'json');
  if (!rec) return json({ ok: false, error: 'unknown renew token' }, 404);
  /* Refused before the write, so a dead link cannot reach the gateway carrying someone else's
     shop name, and cannot spend the store's KV budget on the attempt either. */
  const cSt = await getStore(env, rec.handle);
  if (!cSt) return json({ ok: false, error: 'store not found' }, 404);
  if (!renewOk(rec, cSt))
    return json({ ok: false, error: 'links_revoked', final: true, why: RENEW_CLOSED_WHY }, 410);
  const days = clamp(Number(b.days) || 365, 30, 1460);
  const amount = round2(PRICE_USD * (days / 365));
  // The reference is random and the record carries the terms: a ref built from the
  // clock is one a stranger can walk, and anything the caller may repeat is something
  // a caller can change. The window is why an old link says "start again" rather than
  // activating a month later at a price that no longer exists.
  const txRef = newTxRef(rec.handle);
  await env.STORES.put('tx:' + txRef, JSON.stringify({ handle: rec.handle, days, amount, currency: 'USD', at: Date.now() }),
    { expirationTtl: TX_WINDOW_SEC });
  return json({
    ok: true, tx_ref: txRef, amount, days, window_sec: TX_WINDOW_SEC,
    // what a payment button has to echo back as custom_str1: the only thread that
    // ties a notice to terms this Worker chose, instead of terms the sender typed
    custom_str1: txRef,
    // the slug of the Flutterwave *payment link* in whoever's account is
    // receiving money; it is external configuration, so it is a secret and not a
    // string in the source — the brand can change without breaking payouts
    pay_url: `https://flutterwave.com/pay/${env.FW_PAY_SLUG || 'tapstall'}?tx_ref=${txRef}&amount=${amount}&currency=USD&customer_email=${encodeURIComponent(b.email || '')}&redirect_url=${encodeURIComponent(url.origin + '/api/hook/flutterwave?done=1&tx_ref=' + txRef)}`,
    manual: `Or send ${amount} USD / local equivalent and paste the payment reference to the operator's WhatsApp — activation is automatic on the webhook, manual only if you pay cash.`,
  });
}

/**
 * "I paid by EcoCash, here is the reference." No email thread, no support
 * ticket: it is filed against the store, it shows up in the operator console,
 * and the payment itself — not the note — is what extends the plan. Public, so
 * rate-limited and write-cheap on purpose.
 */
async function renewRef(req, env) {
  const ip = ipOf(req);
  if (await rateLimited(env, ip)) return json({ ok: false, error: 'too many attempts — wait a minute' }, 429);
  const b = await readBody(req);
  const rec = await env.STORES.get('renew:' + String(b.token || ''), 'json');
  if (!rec) return json({ ok: false, error: 'that renew link is not on the books any more — the current one is inside your dashboard' }, 404);
  // A public write that a token alone authorises, into the list a shop reconciles real payments
  // against. Someone holding a link the shop closed must not be able to add to it, so the link
  // is checked before anything else is read and before anything is filed.
  if (!renewOk(rec, await getStore(env, rec.handle)))
    return json({ ok: false, error: 'links_revoked', final: true,
      why: 'This shop has closed its links, so nothing can be filed through this one. The current link is inside your dashboard, or paste the reference to the number on your store page.' }, 410);
  const ref = String(b.reference || '').trim().slice(0, 80);
  if (ref.length < 3) return json({ ok: false, error: 'paste the payment reference (at least 3 characters)' }, 422);
  const key = 'ref:' + rec.handle;
  const cur = (await env.STORES.get(key, 'json')) || [];
  cur.unshift({ at: new Date().toISOString(), ref, amount: clamp(Number(b.amount), 0, 100000) || 0, phone: String(b.phone || '').replace(/\D/g, '').slice(0, 15) });
  await env.STORES.put(key, JSON.stringify(cur.slice(0, 10)), { expirationTtl: 30 * 86400 });
  return json({
    ok: true, filed: cur.length,
    note: 'Filed against ' + rec.handle + '. This note alone switches nothing on — the plan extends when the payment itself is recognised (webhook, or the operator ticking it off), and you will not be chased for it.',
  });
}

async function hookFlutterwave(req, url, env, ctx) {
  // every exit is audited, so a refusal cannot be forgotten by the code that
  // refuses: one place to answer "what was this door asked to do, and did it
  // do it". `say` is the only way out of this function.
  const say = (obj, code = 200) => {   // a defaulted code is how an exit that omitted the status lands in the wrong column
    const kind = code === 200 ? (obj.already ? 'already' : obj.activated ? 'activated' : 'ignored') : 'refused';
    auditHook(env, ctx, kind, obj.error || obj.ignored || obj.note || '');
    return json(obj, code);
  };
  if (url.searchParams.get('done')) {
    return html(`<!doctype html><meta charset=utf-8><title>Payment received</title>
      <body style="font:16px system-ui;max-width:30rem;margin:16vh auto;padding:0 1rem">
      <h2>Thanks — activating</h2><p>If your payment cleared, your store renews automatically within a minute. No email needed, no ticket, no waiting on a human.</p>
      <p><a href="/onboard">Back to setup</a></p>`);
  }
  const body = await req.json().catch(() => null) || {};
  const data = body.data || {};
  const txRef = data.tx_ref || body.tx_ref;
  if (!txRef) return say({ ok: false, error: 'no tx_ref' }, 400);
  // Fail closed. A check that only applies "if configured" is a check that is off
  // until somebody notices it was never turned on, and this one moves a paid plan.
  if (!env.FW_SECRET) return say({ ok: false, error: 'the renewal webhook is not armed — set FW_SECRET on this Worker (the verify hash in the Flutterwave dashboard), then this notice will be accepted' }, 503);
  if (req.headers.get('verif-hash') !== env.FW_SECRET) return say({ ok: false, error: 'bad verif-hash' }, 401);
  if (data.status && data.status !== 'successful') return say({ ok: true, ignored: data.status });
  const tx = await env.STORES.get('tx:' + txRef, 'json');
  if (!tx) return say({ ok: true, ignored: 'no payment intent on file for that reference — it was spent, or its window closed' });
  // Never take a payment's word for its own success: when an API key exists, the
  // transaction is fetched back and the status and the amount are read from that.
  if (env.FLW_API_KEY) {
    let v = null;
    try {
      const vr = await fetch('https://api.flutterwave.com/v3/transactions/' + encodeURIComponent(data.id || tx.tx_id || '') + '/verify',
        { headers: { Authorization: 'Bearer ' + env.FLW_API_KEY } });
      v = await vr.json();
    } catch (e) { v = null; }
    if (!v || !v.data || v.data.status !== 'successful') {
      // the intent is left unspent on purpose: a provider that is briefly unreachable
      // must not cost a merchant a payment they really made
      return say({ ok: false, error: 'the payment could not be confirmed with Flutterwave just now — nothing was changed, it will be checked again on the next notice' }, 502);
    }
    if (Number(v.data.amount) !== round2(Number(tx.amount))) return say({ ok: false, error: 'the amount on the transaction is not the amount this plan costs' }, 400);
    if (String(v.data.currency || tx.currency || 'USD').toUpperCase() !== String(tx.currency || 'USD').toUpperCase()) {
      return say({ ok: false, error: 'paid in a currency this plan is not priced in' }, 400);
    }
  }
  const st = await getStore(env, tx.handle);
  if (!st) return say({ ok: false, error: 'store gone' }, 410);
  st.paid_until = Math.max(Date.now(), st.paid_until || 0) + tx.days * 864e5;
  st.plan = tx.days >= 300 ? 'annual' : 'term';
  st.suspended = false; st.warned_at = null;
  await writeStore(env, st);
  await env.STORES.delete('tx:' + txRef);
  await env.STORES.delete('term:' + st.handle);
  return say({ ok: true, activated: st.handle, paid_until: new Date(st.paid_until).toISOString() });
}

/**
 * PayFast's ITN. Everything this may conclude about a payment comes from two places:
 * the signature PayFast computed over the notice, and the intent this Worker minted
 * when the merchant asked to renew. The request itself is trusted for nothing — not
 * the handle, not the number of days, not the amount.
 */
async function hookPayfast(req, url, env, ctx) {
  // every exit is audited, so a refusal cannot be forgotten by the code that
  // refuses: one place to answer "what was this door asked to do, and did it
  // do it". `say` is the only way out of this function.
  const say = (obj, code = 200) => {   // a defaulted code is how an exit that omitted the status lands in the wrong column
    const kind = code === 200 ? (obj.already ? 'already' : obj.activated ? 'activated' : 'ignored') : 'refused';
    auditHook(env, ctx, kind, obj.error || obj.ignored || obj.note || '');
    return json(obj, code);
  };
  const ip = ipOf(req);
  if (await rateLimited(env, ip)) return say({ ok: false, error: 'too many notices from you, wait a minute' }, 429);
  const body = await req.text().catch(() => '');
  // the body is the notice; the query string is accepted too because PayFast echoes it
  const fields = Object.fromEntries(new URLSearchParams(body || url.search));
  const status = String(fields.payment_status || '');
  if (status !== 'COMPLETE') return say({ ok: true, ignored: status || 'no status' });
  const pp = String(env.PAYFAST_PASSPHRASE || '');
  if (!pp) return say({ ok: false, error: 'the renewal webhook is not armed — set PAYFAST_PASSPHRASE on this Worker (the same passphrase as the payment button), then this notice will be accepted' }, 503);
  if (!payfastSignedOk(fields, pp)) {
    return say({ ok: false, error: 'signature does not verify' }, 400);
  }
  // One payment, one credit — asked before anything else, because the answer to a
  // retry of a payment that already landed is "already applied", not "unknown
  // reference": a provider told the second keeps retrying the first. The id is inside
  // the signed string, so it is the provider's own number, not the sender's.
  const pid = String(fields.pf_payment_id || '');
  const seenKey = 'paid:' + (pid || String(fields.custom_str1 || ''));
  if (await env.STORES.get(seenKey)) return say({ ok: true, already: true, note: 'that payment was already applied' });
  const ref = String(fields.custom_str1 || '');
  if (ref.length < 6) return say({ ok: true, ignored: 'no reference this Worker minted' });
  const tx = await env.STORES.get('tx:' + ref, 'json');
  const check = txMatches(tx, fields);
  if (!check.ok) return say({ ok: true, ignored: check.why });        // nothing to retry, nothing written
  const st = await getStore(env, tx.handle);
  if (!st) return say({ ok: false, error: 'store gone' }, 410);
  st.paid_until = Math.max(Date.now(), st.paid_until || 0) + (Number(tx.days) || 365) * 864e5;
  st.plan = (Number(tx.days) || 0) >= 300 ? 'annual' : 'term';
  st.suspended = false; st.warned_at = null;
  await env.STORES.put(seenKey, JSON.stringify({ handle: st.handle, ref, at: new Date().toISOString() }), { expirationTtl: 30 * 86400 });
  // Flutterwave needs no marker of its own: the minted intent is deleted on success,
  // so a replay there has nothing to spend. Here the intent is spent the same way, and
  // the extra key is what lets a retry be answered with the truth instead of a shrug.
  await env.STORES.delete('tx:' + ref);
  await writeStore(env, st);
  await env.STORES.delete('term:' + st.handle);
  return say({ ok: true, activated: st.handle, paid_until: new Date(st.paid_until).toISOString(), days: tx.days });
}

/* ------------------------------------------------------------------ cron */
async function runCron(env) {
  const out = { checked: 0, suspended: 0, reinstated: 0, warned: 0 };
  if (!env.STORES) return out;
  // heartbeat: proves the schedule actually fires, without opening a dashboard
  try { await env.STORES.put('cron:last', JSON.stringify({ at: new Date().toISOString(), unix: Date.now() })); } catch (e) {}
  let cursor, loops = 0;
  do {
    const list = await env.STORES.list({ prefix: 'store:', cursor });
    for (const k of (list.keys || [])) {
      out.checked++;
      const st = await env.STORES.get(k.name, 'json');
      if (!st) continue;
      const leftDays = ((st.paid_until || 0) - Date.now()) / 864e5;
      if (leftDays <= 0 && !st.suspended) {
        st.suspended = true; st.suspended_at = new Date().toISOString();
        await writeStore(env, st);
        await env.STORES.put('term:' + st.handle, JSON.stringify({ state: 'expired', at: st.suspended_at }));
        out.suspended++;
      } else if (leftDays > 0 && st.suspended) {
        st.suspended = false;
        await writeStore(env, st);
        await env.STORES.delete('term:' + st.handle);
        out.reinstated++;
      } else if (leftDays > 0 && leftDays <= 7 && !st.warned_at) {
        st.warned_at = new Date().toISOString();
        await writeStore(env, st);
        if (env.EMAIL && st.owner_email) {
          try {
            await sendMail(env, st.owner_email, `Your store renews in ${Math.ceil(leftDays)} days`,
              `${st.shop_name} runs until ${new Date(st.paid_until).toDateString()}.\nRenew here and it switches over automatically: ${st.renew_url}\n${PRICE_USD} USD / 365 days. No monthly billing, no foreign-card subscription.`);
          } catch (e) {}
        }
        out.warned++;
      }
    }
    cursor = list.cursor;
  } while (cursor && loops++ < 10);
  return out;
}

// What a closed link says, once, for all three doors it used to open. It names the reason (the
// shop did this, on purpose), states that nothing moved, and says where the working link is,
// because unlike a buyer the person holding this one has a dashboard.
const RENEW_CLOSED_WHY = 'This shop has closed its payment links, so this one opens nothing and files nothing.'
  + ' Nothing about the store has changed: the current link is on the plan card in your dashboard.';

/* ------------------------------------------------------------ renew page */
async function renewPage(env, token) {
  let custom = await env.STORES.get('tpl:renew');
  const rec = await env.STORES.get('renew:' + token, 'json');
  const shop = rec ? await getStore(env, rec.handle) : null;
  /* The renew link is revocable too: it is not a signed capability but a KV key with no expiry
     of its own, and it opens the checkout intent and the payment-reference write as well as this
     page. A Revoke that left it standing was a revoke with a hole in it, and the hole led to the
     money door. Judged by the same rule as a mark cap, in the core, so nothing can drift. */
  const closed = !!(rec && shop && !renewOk(rec, shop));
  // The skin has no panel for this state, and its unknown-token panel points the shop at the
  // welcome email, whose link is exactly what just died. A page that cannot draw a fact is not
  // handed the fact: the floor answers, in the shop's own terms.
  if (closed && custom && !/state === ['"]closed['"]/.test(custom)) custom = null;
  if (custom && custom.length > 200) {
    const st = shop;
    const rows = st ? ((await env.ORDERS.get('list:' + st.handle, 'json')) || []) : [];
    const data = {
      known: !!(st), token,
      state: closed ? 'closed' : null, why: closed ? RENEW_CLOSED_WHY : null,
      shop: st ? st.shop_name : null, handle: st ? st.handle : null,
      plan: st ? (st.plan || 'free60') : null, currency: st ? (st.currency || 'USD') : 'USD',
      left: st ? Math.ceil(((st.paid_until || 0) - Date.now()) / 864e5) : 0,
      suspended: st ? !!st.suspended : false,
      orders: rows.length, gmv: Math.round(rows.reduce((a, r) => a + (Number(r.total) || 0), 0) * 100) / 100,
      price: PRICE_USD, store_url: st ? '/s/' + st.handle : '/onboard',
      pay_url: st ? '/a' : '/onboard',
    };
    return html(fillPage(custom, [['TAPSTALL_RENEW', data]]));
  }
  // The link is not on the books, which has two honest reasons: a shop that never registered, and
  // a shop that revoked (the record goes with the generation, and a new one is minted for the
  // dashboard). "Use the one from your welcome email" used to be the helpful half of this sentence
  // and is now the wrong half, so the dashboard is named first and the email stays as the fallback.
  if (!rec) return html(`<h1 style="font:16px system-ui;padding:2rem">That renew link is no longer on the books.</h1>
<p style="font:15px/1.6 system-ui;padding:0 2rem;max-width:38rem;color:#444">The current one is on the plan card in your <a href="/a">dashboard</a> — it is reissued whenever the shop closes its links. If you never created a store, <a href="/onboard">start here</a>.</p>`, 404);
  if (closed) return html(`<h1 style="font:16px system-ui;padding:2rem">This shop has closed its links</h1>
<p style="font:15px/1.6 system-ui;padding:0 2rem;max-width:38rem;color:#444">${RENEW_CLOSED_WHY} <a href="/a">Sign in to your dashboard</a> and the current link is on the plan card.</p>`, 410);
  const st = await getStore(env, rec.handle);
  if (!st) return html('<h1 style="font:16px system-ui;padding:2rem">Store not found.</h1>', 404);
  const left = Math.ceil(((st.paid_until || 0) - Date.now()) / 864e5);
  const rows = (await env.ORDERS.get('list:' + st.handle, 'json')) || [];
  const gmv = rows.reduce((a, r) => a + (Number(r.total) || 0), 0);
  return html(`<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Renew ${esc(st.shop_name)}</title>
<style>body{font:16px/1.6 system-ui;max-width:34rem;margin:6vh auto;padding:0 1.1rem;color:#111}
.card{border:1px solid #e5e5e5;border-radius:14px;padding:1rem;margin:1rem 0}
button{font:inherit;background:#111;color:#fff;border:0;border-radius:10px;padding:.7rem 1rem;width:100%}
b{font-variant-numeric:tabular-nums}</style>
<h1>${esc(st.shop_name)}</h1>
<div class=card>
  <p>Plan: <b>${esc(st.plan)}</b> · ${left > 0 ? `<b>${left}</b> days left` : '<b style="color:#b00">expired — store paused</b>'}</p>
  <p>Orders recorded: <b>${rows.length}</b> · value <b>${gmv.toFixed(2)} ${esc(st.currency || 'USD')}</b></p>
  <p>Store URL: <a href="/s/${esc(st.handle)}">/s/${esc(st.handle)}</a> · <a href="/a">orders dashboard</a> (sign in with ${esc(st.handle)} and your PIN)</p>
</div>
<div class=card>
  <h3 style="margin:.2rem 0 .6rem">Renew ${PRICE_USD} USD for 365 days</h3>
  <p style="margin:.2rem 0;font-size:.9rem;color:#555">One payment a year. No monthly billing, no foreign-card subscription (which in Zim adds 15% DSWT + 2% IMTT before it even reaches the provider).</p>
  <button id=pay>Pay and activate automatically</button>
  <p id=out style="font-size:.9rem"></p>
</div>
<script>
document.getElementById('pay').onclick=async()=>{
  const o=document.getElementById('out');o.textContent='opening payment…';
  const r=await fetch('/api/checkout',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:${JSON.stringify(token)},days:365})});
  const j=await r.json();
  if(j.ok){o.innerHTML='If payment clears, this page renews itself. <a href="'+j.pay_url+'">Pay '+j.amount+' USD</a>';}else{o.textContent=j.why||j.error||'failed';}
};
</script></html>`);
}

/* guarded template upload — lets deploy stay one command; key is a Worker secret */
async function adminPut(req, env) {
  const b = await req.json().catch(() => null) || {};
  // Constant-time, and counted against the same small cooldown as every other door
  // that answers yes/no to a secret: the key is 48 random characters, so this is
  // about not handing a script a free oracle, not about the odds.
  if (!env.ADMIN_SECRET || !timingSafeEq(String(b.secret || ''), String(env.ADMIN_SECRET))) {
    if (!(await lockedOut(env, '__put'))) await authFail(env, '__put');
    return json({ ok: false, error: 'unauthorised' }, 403);
  }
  await authClear(env, '__put');
  if (!/^tpl:(store|onboard|admin|fees|index|sample-menu)$/.test(String(b.key || ''))) return json({ ok: false, error: 'bad key' }, 422);
  if (String(b.value || '').length < 200 || String(b.value || '').length > 400000) return json({ ok: false, error: 'bad size' }, 422);
  await env.STORES.put(b.key, b.value);
  return json({ ok: true, key: b.key, bytes: b.value.length });
}

/* ------------------------------------------------------------ plumbing */
async function rateLimited(env, ip, bucket, rl) {
  if (!env.STORES) return false;
  const win = rl || RL;
  const key = `rl:${bucket || ''}${ip}:${Math.floor(Date.now() / (win.windowSec * 1000))}`;
  const n = Number((await env.STORES.get(key)) || 0);
  if (n >= win.max) return true;
  await env.STORES.put(key, String(n + 1), { expirationTtl: win.windowSec + 10 });
  return false;
}
/** Its own bucket, wider than an order's and narrower than nothing: one buyer adds a
 *  code once or twice, and the ceiling exists only so the field is not a free write
 *  oracle. `proof:` keeps it off the order counter, because a buyer and a shop behind
 *  one carrier NAT should not be spending each other's allowance. */
const PRL = { windowSec: 60, max: 6 };
async function incr(env, key) {
  if (!env.STORES) return 1;
  const n = Number((await env.STORES.get(key)) || 0) + 1;
  await env.STORES.put(key, String(n));
  return n;
}
async function buyerTouch(env, handle, h) {
  if (!env.STORES) return { count: 0, unpaid: 0 };
  const key = `buyer:${handle}:${h.slice(0, 16)}`;
  const rec = (await env.STORES.get(key, 'json')) || { count: 0, unpaid: 0 };
  rec.count++; rec.unpaid++;
  await env.STORES.put(key, JSON.stringify(rec), { expirationTtl: 180 * 86400 });
  return rec;
}

async function selftest(env) {
  const t = { version: VERSION, kv_stores: !!env.STORES, kv_orders: !!env.ORDERS, email: !!env.EMAIL,
    // whose cron is this? an alias answers redirects and skips the sweep, and the
    // deploy check reads this instead of trusting that the schedule was deleted
    cron_owner: !env.REDIRECT_TO };
  /* Login is one PBKDF2 comparison, so the runtime having WebCrypto's deriveBits
     is a health question, not a detail: without it every merchant in the country
     fails to sign in and every status page says green. */
  try { t.pin_kdf = (await pinOk('246813', await pinRecord('246813'))) === true; }
  catch (e) { t.pin_kdf = false; t.pin_kdf_error = String((e && e.message) || e); }
  t.pin_iters = PIN_ITER;
  if (env.STORES) {
    const beat = await env.STORES.get('cron:last', 'json');
    t.cron_heartbeat = beat ? { at: beat.at, minutes_ago: Math.round((Date.now() - (beat.unix || 0)) / 60000) } : 'never run';
  }
  if (env.STORES) {
    const k = '__ping:' + Date.now();
    // The write probe is the one line here that can fail, and if it throws it
    // takes the other thirty assertions with it — which is how a spent KV budget
    // turned the endpoint that exists to explain outages into one more outage.
    // Fail the probe, keep the report, and name the reason with a clock.
    try {
      await env.STORES.put(k, '1');
      t.kv_roundtrip = (await env.STORES.get(k)) === '1';
      await env.STORES.delete(k);
    } catch (e) {
      const msg = String((e && e.message) || e);
      t.kv_roundtrip = false;
      t.kv_write_blocked = QUOTA_RE.test(msg)
        ? { reason: 'quota', retry_in_sec: secsToMidnightUTC(), note: 'the account has spent its free KV writes for today' }
        : LIMIT_RE.test(msg)
          ? { reason: 'limits', note: 'this run hit the Worker CPU or memory ceiling, not the write budget' }
          : { reason: 'error', note: msg.slice(0, 140) };
    }
    for (const tplName of ['store', 'onboard', 'admin', 'fees', 'index', 'confirm', 'renew', 'ops']) t['tpl_' + tplName] = ((await tpl(env, tplName)) || '').length > 200;
  }
  const fake = { handle: 'selftest', currency: 'USD', tax_pct: 15.5, delivery_fee: 2, rail: 'ecocash_usd', surcharge_mode: 'absorb', unique_change: true, pay_account: '0771234567' };
  t.pricing = priceOrder(fake, [{ name: 'Test', price: 12.5, qty: 2, addons: [4], options: [{ name: 'L', up: 2 }] }], 'delivery', 'ecocash_usd');
  t.pricing_pass_mode = priceOrder({ ...fake, surcharge_mode: 'pass' }, [{ name: 'Test', price: 100, qty: 1 }], 'pickup', 'ecocash_usd');
  t.csv = parseProducts('id,name,category,price,options,addons\np1,Chicken,Main,5.50,Size:S,L|Spice:hot,Cheese:1.5\nHELP,,,,,,,,\n', { currency: 'USD' });
  t.feed_url_sheet = normalizeFeedUrl('https://docs.google.com/spreadsheets/d/abc123DEF456ghi789JKL012mno345PQR/edit#gid=123');
  // ---- v0.9.0: the money side, asserted on the same fake store as the pricing block, on rows
  // built here rather than in KV. A selftest that reads the shop's ledger would answer a different
  // question on a different day; this one answers the same one at midnight UTC and on a spent day.
  {
    const st15 = { ...fake, tax_pct: 15, unique_change: false, surcharge_mode: 'pass' };
    const ex = priceOrder(st15, [{ name: 'x', price: 100, qty: 1 }], 'pickup', 'ecocash_usd');
    const inx = priceOrder({ ...st15, vat_mode: 'incl' }, [{ name: 'x', price: 115, qty: 1 }], 'pickup', 'ecocash_usd');
    t.vat_excl_adds_incl_takes = Math.abs(ex.total - inx.total) < 0.011
      && ex.vat.included === false && inx.vat.included === true
      && Math.abs(ex.tax - 15) < 0.011 && Math.abs(inx.tax - 15) < 0.011;
    const zero = priceOrder(st15, [{ name: 'Mealie meal', price: 100, qty: 1, vat_rate: '0' }, { name: 'Stew', price: 20, qty: 1 }], 'pickup', 'ecocash_usd');
    t.vat_zero_line_off_base = Math.abs(zero.tax - 3) < 0.011 && zero.lines[0].vat_pct === 0 && zero.lines[1].vat_pct === 15;
    const old = priceOrder({ ...fake, vat_rate_pct: 21, tax_pct: 15, unique_change: false }, [{ name: 'x', price: 100, qty: 1 }], 'pickup', 'ecocash_usd');
    t.vat_rate_override_reads = Math.abs(old.tax - 21) < 0.011;
    const rows = [
      { id: 'a', code: 'A', at: '2026-10-01T09:00:00Z', marked_at: '2026-10-02T09:00:00Z', status: 'paid', total: 115, tax: 15, vat_pct: 15, pay_now: 115.07, rounding: 0.07 },
      { id: 'b', code: 'B', at: '2026-10-03T09:00:00Z', status: 'awaiting_payment', total: 230, tax: 30, vat_pct: 15 },
      { id: 'c', code: 'C', at: '2026-10-04T09:00:00Z', marked_at: '2026-10-04T10:00:00Z', status: 'paid', total: 60, tax: 0, vat_pct: 0 },
    ];
    const rc = vatReturn(rows, { tax_pct: 15 }, { basis: 'cash', from: '2026-10-01', to: '2026-10-31' });
    const ra = vatReturn(rows, { tax_pct: 15 }, { basis: 'accrual', from: '2026-10-01', to: '2026-10-31' });
    t.vat_return_basis_split = rc.count === 2 && ra.count === 3 && rc.vat === 15 && ra.vat === 45 && rc.net === 160;
    t.vat_return_buckets_rates = rc.rates.length === 2 && rc.rates.some((b) => b.rate_pct === 0) && rc.registered === false;
    t.books_summary_agrees_with_return = (() => {
      const bs = booksSummary(rows, { handle: 'selftest', tax_pct: 15, currency: 'USD' }, { period: '2026-10', basis: 'cash' });
      return bs.vat.gross === rc.gross && bs.vat.vat === rc.vat && bs.rounding_identifiers === 0.07
        && bs.outstanding_balance === 230 && /Sales side only/.test(bs.note);
    })();
    t.books_csv_is_csv = (() => {
      const c = booksCsv(rows, { handle: 'selftest', shop_name: 'S', tax_pct: 15, currency: 'USD' }, { period: '2026-10' });
      return c.startsWith('# tapstall books pack') && c.includes('date,ref,status,buyer,phone') && c.includes('A,paid') && c.includes('# totals');
    })();
    const ord = { id: 'a', code: 'SELF-1', at: '2026-10-01T09:00:00Z', marked_at: '2026-10-02T09:00:00Z',
      buyer: { name: 'Tino', phone: '+263771234567' }, items: [{ name: 'x', qty: 1, unit: 100, total: 100 }], pricing: ex };
    // The shop's VAT identity is frozen on the order (see pricing.vat), so an order placed before a
    // registration prints a receipt — and an order placed after it prints a tax invoice. The store's
    // settings today only fill in what the order did not carry.
    const reg = { ...fake, shop_name: 'Selftest', vat_registered: true, vat_number: '4012345', vat_address: '12 Road, Harare', tax_pct: 15, unique_change: false };
    const exReg = priceOrder(reg, [{ name: 'x', price: 100, qty: 1 }], 'pickup', 'ecocash_usd');
    const ordReg = { ...ord, pricing: exReg };
    t.receipt_shows_vat_when_registered = /VAT @ 15%/.test(receiptText(reg, ordReg))
      && /4012345/.test(receiptHtml(reg, ordReg)) && /Tax invoice/i.test(receiptHtml(reg, ordReg))
      && /4012345/.test(receiptText(reg, ordReg));
    t.receipt_says_unregistered = /not VAT-registered/.test(receiptText({ ...fake, tax_pct: 15 }, ord))
      && /Receipt/.test(receiptHtml({ ...fake, tax_pct: 15 }, ord));
    t.receipt_total_matches_pricing = new RegExp(ex.total.toFixed(2)).test(receiptText({ ...fake, tax_pct: 15 }, ord));
    const shop = { ...fake, shop_name: 'Selftest Shop', handle: 'selftest', whatsapp: '+263771234567', hours: 'Mon-Fri 08:00-17:00', tax_pct: 15 };
    const prods = Array.from({ length: 9 }, (_, k) => ({ id: 'p' + k, name: 'Item ' + (k + 1), price: 5 + k, cur: 'USD' }));
    const pk = meshPack(shop, prods, meshFacts(shop, 'https://x'), { origin: 'https://x' });
    t.mesh_budget_held = pk.beats.length === MESH_BUDGET.per_day && MESH_BUDGET.promo === 1
      && pk.beats.filter((b) => b.kind === 'promo').length <= 1 && pk.beats.every((b) => b.text.length <= (MESH_RAILS[b.rail] || { max: 1e6 }).max);
    t.mesh_prices_are_the_menu = pk.beats.every((b) => !b.price || prods.some((pp) => Math.abs(pp.price - b.price) < 0.005));
    t.mesh_cools_a_used_item = (() => {
      const used = {}; used[pk.beats[0].item_key] = new Date().toISOString().slice(0, 10);
      const again = meshPack(shop, prods, meshFacts(shop, 'https://x'), { origin: 'https://x', sent: { items: used } });
      return again.beats.every((b) => b.item_key !== pk.beats[0].item_key);
    })();
    // A shop whose sheet is unreadable is the case the mesh has to get right: it may still say the
    // shop exists, but no number may leave this function that is not on a row read today.
    const broken = { ...shop, feed_error: 'feed_http_502' };
    t.mesh_no_invented_price = (() => {
      const p2 = meshPack(broken, [], meshFacts(broken, 'https://x'), { origin: 'https://x' });
      return !/\d+\.\d{2} USD/.test(p2.beats.map((b) => b.text).join(' ')) && /feed/.test(p2.beats.map((b) => b.why || '').join(' ') + p2.fails.map((f) => f.key).join(','));
    })();
    t.mesh_public_doc_refuses_broken = meshJson(broken, [], meshFacts(broken, 'https://x'), 'https://x').priced === false
      && meshJson(shop, prods, meshFacts(shop, 'https://x'), 'https://x').items.length === 9;
    t.mesh_mark_bounds_state = (() => {
      const ids = Array.from({ length: 500 }, (_, k) => 'item:p' + k + ':v1');
      const st2 = meshMark(meshMark(null, ids.slice(0, 250), Date.now()), ids, Date.now());
      return Object.keys(st2.items).length <= 400 && !!st2.at;
    })();
    t.art_drawn_not_photographed = /^<svg xmlns/.test(sampleArtSvg('2L Coke'))
      && sampleArtUrl('h', { name: '2L Coke' }) === sampleArtUrl('h', { name: '2L Coke' })
      && realPhoto({ img: '/art/h/1.svg', art: true }) === '' && realPhoto({ img: '/i/h/1' }) === '/i/h/1';
    t.menu_art_never_overrides_a_clear = (() => {
      const withSheet = applyMenu([{ id: 'p1', name: 'X' }], { handle: 'shop' });
      const cleared = applyMenu([{ id: 'p1', name: 'X' }], { handle: 'shop', over: { p1: { img: '' } } });
      return withSheet[0].art === true && cleared[0].img === '' && cleared[0].art === undefined;
    })();
    t.ops_menu_shares_the_foreign_ref_rule = sanitizeMenu({ extra: [{ name: 'X', price: 1, img: '/i/other-shop/abcd' }], handle: 'shop' }).extra[0].img === ''
      && sanitizeMenu({ extra: [{ name: 'X', price: 1, img: '/i/shop/abcd' }], handle: 'shop' }).extra[0].img === '/i/shop/abcd';
  }
  t.slug = slug('Mama Too Catering!');
  t.secret_leak_check = !JSON.stringify(publicStore({ ...fake, admin_token: 'x', notify_email: 'a@b.c', owner_email: 'a@b.c', notify_webhook: 'https://x', feed_cache: {}, feed_url: 'https://y' })).includes('admin_token');
  const k = 'selftest-secret';
  const cap = await issueCap(k, { a: 'mark', h: 'shop', id: 'o1', s: 'paid', g: 'g1' }, 600);
  const back = await verifyCap(k, cap);
  // The mint carries a generation, because that is the shape a production mint has: a selftest
  // that minted something no caller would accept would prove the wrong thing while passing.
  t.cap_roundtrip = !!(back && back.a === 'mark' && back.h === 'shop' && back.id === 'o1' && back.g === 'g1');
  t.cap_rejects_tamper = !(await verifyCap(k, cap.slice(0, -4) + 'AAAA'));
  t.cap_rejects_other_secret = !(await verifyCap('other', cap));
  t.cap_rejects_expired = !(await verifyCap(k, cap, Math.floor(Date.now() / 1000) + 3600));
  /* The generation binding, proven on the bundle that is actually deployed. Every line here that
     reads or writes a store row goes quiet on a day the account has spent its 1,000 writes; these
     cost nothing, so they answer on that day too. */
  const boundP = await verifyCap(k, await issueCap(k, { a: 'mark', h: 'shop', id: 'o1', s: 'paid', g: 'gen-now' }, 600));
  t.cap_bound_roundtrip = !!(boundP && boundP.a === 'mark' && boundP.g === 'gen-now');
  t.cap_stale_generation_refused = capGenOk({ g: 'gen-then' }, { auth_gen: 'gen-now' }, {}) === false;
  t.cap_current_generation_honoured = capGenOk(boundP, { auth_gen: 'gen-now' }, {}) === true;
  const orphan = { a: 'mark', h: 'shop', id: 'o1', s: 'paid' };   // deliberately unbound: this mint is the bug
  t.cap_mint_refuses_unbound = await issueCap(k, orphan, 600).then(() => false, () => true);
  t.cap_legacy_judged_by_time = capGenOk({}, { auth_gen: (Date.now() - 864e5).toString(36) }, { at: new Date().toISOString() }) === true;
  t.cap_legacy_refused_when_older = capGenOk({}, { auth_gen: Date.now().toString(36) }, { at: new Date(Date.now() - 864e5).toISOString() }) === false;
  t.renew_link_revocable = renewOk({ made: Date.now(), g: 'gen-now' }, { auth_gen: 'gen-now' }) === true
    && renewOk({ made: Date.now(), g: 'gen-then' }, { auth_gen: 'gen-now' }) === false
    && renewOk({ made: Date.now() - 864e5 }, { auth_gen: '0' }) === true;
  /* 0.8.8: the rule is one function, and the doors call it. These two lines are the version of
     "the shipped bundle agrees" that costs no writes — a page-level check needs an order, and an
     order needs a write, and on a spent day there is no such thing. */
  t.code_link_rule_shared = capGenOk({ a: 'proof' }, { auth_gen: '0' }, { at: new Date(Date.now() - 864e5).toISOString() }) === true
    && capGenOk({ a: 'proof', g: 'gen-then' }, { auth_gen: 'gen-now' }, {}) === false;
  t.ops_cap_needs_platform_gen = await issueCap(k, { a: 'ops', g: VERSION }, 600).then(() => false, () => true);
  const v = validateSettings({ rail: 'nope', tax_pct: 999, hours: '8-5' }, Date.now(), { rails: await railsCatalog(env) });
  const cat = Object.assign(await railsCatalog(env), { test_momo: normaliseRail({ label: 'Test MoMo', pct: 0.01 }, 'test_momo') });
  // A rail the operator added this morning has to be selectable, resolvable and
  // priceable by the very next order — that is the whole promise of rails-as-data.
  // (The first draft of this checked `rail: 'cash'` came back as 'test_momo',
  // which is impossible by construction and read as a red selftest for a day.)
  const vCat = validateSettings({ rail: 'test_momo' }, Date.now(), { rails: cat });
  const pCat = priceOrder({ currency: 'USD', rail: 'test_momo', surcharge_mode: 'pass', unique_change: false },
    [{ name: 'x', price: 100, qty: 1 }], 'pickup', 'test_momo', cat);
  t.rail_catalogue_ok = vCat.ok && vCat.money.rail === 'test_momo'
    && resolveRail({}, 'test_momo', cat).label === 'Test MoMo'
    && pCat.fee === 1 && pCat.pay_now === 101;
  t.rail_custom_ok = (() => { const r = resolveRail({ rail_def: { label: 'My Yape', dial: 'Yape app', pct: 0.012 } }, 'custom'); return r.label === 'My Yape' && r.pct === 0.012; })();
  t.rail_price_with_own = (() => { const p = priceOrder({ currency: 'USD', rail: 'custom', rail_def: { label: 'My Yape', pct: 0.10, fixed: 0, type: 'manual' }, surcharge_mode: 'pass', unique_change: false }, [{ name: 'x', price: 100, qty: 1 }], 'pickup', 'custom'); return p.fee === 10 && p.pay_now === 110; })();
  t.settings_rejects_bad = !v.ok && !!(v.errors.rail && v.errors.tax_pct) && v.soft.hours === '8-5';
  const st2 = { rail: 'cash', pay_account: 'A1', hours: 'x' };
  stageSettings(st2, { hours: '9-6' }, { pay_account: 'EVIL' }, 9e5, 1000);
  t.money_change_is_held = st2.pay_account === 'A1' && st2.hours === '9-6' && st2.pending.apply_at === 901000;
  applyPending(st2, 902000);
  t.money_change_lands_late = st2.pay_account === 'EVIL' && !st2.pending;
  t.masking_hides_values = maskField('pay_account', '0771234567') === '•••4567'
    && maskField('notify_email', 'secret@example.com') === 's***@example.com'
    && maskField('whatsapp', '263771234567') === '•••4567'
    && maskField('feed_url', 'https://docs.google.com/spreadsheets/d/abcdef/edit').indexOf('abcdef') === -1;
  // One verdict for the caller, computed on the last line: every assertion in
  // here is written so that true means healthy, so `ok` is "no boolean came
  // back false". Anything added below this line is silently outside the verdict,
  // which is why it sits after the last check instead of near the first.
  t.ok = Object.keys(t).every((k) => typeof t[k] !== 'boolean' || t[k] === true || CAPABILITY_FLAGS.includes(k));
  return t;
}

// Which booleans are facts about the wiring rather than verdicts on it. `email`
// is the binding being absent on a $0 account and `kv_orders` the namespace not
// yet created on a fresh one — both documented gaps, neither a failure, so they
// must not turn the single verdict red. A new capability flag has to be listed
// here or it becomes an alarm.
const CAPABILITY_FLAGS = ['kv_stores', 'kv_orders', 'email', 'cron_owner'];

/**
 * The rails a store may price with: the built-in table (published tariffs for
 * the two markets this was proven in) plus whatever the operator has added in
 * KV under `rails:extra`. Adding Ghana or Pakistan is a KV write, not a deploy —
 * which is the only way a $0 service can chase a list of excluded markets that
 * changes every time a telco launches a wallet.
 */
async function railsCatalog(env) {
  const out = Object.assign({}, RAILS);
  let extra = null;
  try { extra = env.STORES ? await env.STORES.get('rails:extra', 'json') : null; } catch (e) { extra = null; }
  for (const k of Object.keys(extra || {})) {
    const r = normaliseRail(extra[k], k);
    if (r) out[k] = r;
  }
  // The picker's own entry: `own` tells a UI to render the merchant's description,
  // and the shape fields say what a number for an undescribed method looks like —
  // a wallet ID, a name worth checking and, if they have one, a till.
  out.custom = { key: 'custom', label: 'My own method (I describe it)', dial: 'as you describe', pct: 0, imtt: 0, fixed: 0, type: 'manual',
                 spec: 'wallet', holder: true, till: true, own: true };
  return out;
}

async function tpl(env, name) {
  if (env.STORES) {
    const v = await env.STORES.get('tpl:' + name);
    if (v && v.length > 200) return v;
  }
  return '<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:2rem"><h1>Template &ldquo;'
    + name + '&rdquo; missing</h1><p>Run <code>./scripts/deploy.sh</code> to upload templates into KV.</p>';
}
async function sendMail(env, to, subject, text) {
  if (!env.EMAIL) return false;
  await env.EMAIL.send(new EmailMessage('no-reply@simalidudu.workers.dev', to, subject, text));
  return true;
}

const nowId = () => Date.now().toString(36) + rand(4);
/** Tokens that must survive a path segment untouched: unambiguous lowercase alnum. */
function alnumToken(n) {
  const A = 'abcdefghijkmnpqrstuvwxyz23456789';   // no l/o/0/1/i — dictated over the phone
  const b = new Uint8Array(n); crypto.getRandomValues(b);
  return [...b].map((x) => A[x % A.length]).join('');
}
function rand(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return [...b].map(x => x.toString(36).padStart(2, '0')).join('').slice(0, n); }
function timingSafeEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const SEC_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // 'unsafe-inline' stays because the templates are single-file documents with
  // inline scripts; everything remote is what this actually blocks.
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; referrer no-referrer",
};

/**
 * Only genuinely public surfaces get `Access-Control-Allow-Origin: *`. The
 * admin, settings, mark and login endpoints deliberately do not, so no foreign
 * page can read a ledger or fire a mutation from a visitor's browser.
 */
/**
 * The store page is the one surface the dashboard embeds, to show a merchant
 * their own store next to the share buttons. `frame-ancestors 'none'` +
 * `X-Frame-Options: DENY` on it therefore painted that preview as a blank white
 * box on every device — a feature that has never once rendered. Same-origin
 * framing is allowed there and nowhere else: a stranger's page still cannot put
 * a store inside a clickbait frame, and the admin, operator and API surfaces keep
 * DENY. Deriving the string instead of duplicating it is deliberate: a CSP edited
 * in one place must not silently stop applying to the other.
 */
const FRAMEABLE = {
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': SEC_HEADERS['Content-Security-Policy'].replace(
    "frame-ancestors 'none'", "frame-ancestors 'self'"),
};

const LEGACY_PAGES_RE = /^\/$|^\/s\/|^\/a$|^\/c\/|^\/renew\/|^\/fees\b|^\/onboard\b|^\/rails\b|^\/data\/|^\/ops$/;
const OPEN_RE = /^\/s\/|^\/rails\b|^\/fees\b|^\/data\/|^\/onboard\b|^\/__ping\b|^\/api\/(order|register|lookup|hook\/)|^\/renew\//;
function isOpenPath(pathname) { return OPEN_RE.test(pathname); }
const SESS_COOKIE = 'tp_sess';
const KILL_COOKIES = killCookies([SESS_COOKIE]);
/** The session cookie, plus the clearing of the old brand's spelling: a browser
 *  that still holds `zl_sess` would otherwise keep a signed-in tab alive after
 *  "sign out", because this Worker accepts that name on purpose. */
function sessCookie(value) {
  return [`${SESS_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${SESS_TTL}`,
    'zl_sess=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure'];
}

/** Merge per-route headers over the defaults, lower-cased, so callers that
 *  write `Cache-Control` cannot end up with `no-store, no-store`. */
/** The pages that are an application, not content: a dashboard holding somebody's
 *  orders should not be indexed even by a crawler that ignores robots.txt, and a
 *  header costs no crawl budget to enforce. */
const NOINDEX = { 'X-Robots-Tag': 'noindex, nofollow' };
const NO_GUIDE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>No such guide | Tapstall</title><meta name="robots" content="noindex"></head>
<body style="font:16px/1.6 system-ui;max-width:34rem;margin:14vh auto;padding:0 1.2rem">
<h1 style="font-size:1.3rem">No guide at that address</h1>
<p>The guides we have: <a href="/guide/whatsapp-shop-payments">taking payment for a WhatsApp shop</a>
and <a href="/guide/payment-reference-matching">matching a payment to an order</a>.</p>
<p><a href="/onboard">Create a shop</a> — a name, a menu and a PIN.</p></body></html>`;
function text(s, status = 200, type = 'text/plain; charset=utf-8') {
  return new Response(s, { status, headers: { 'content-type': type, 'cache-control': 'public, max-age=3600' } });
}
function hdr(extra) {
  // both spellings for one release: a cached page or a script an operator wrote
  // against the old header should keep working while it is still in use
  // Everything is folded into one lower-cased table on purpose. Spreading
  // SEC_HEADERS first leaves `X-Frame-Options` and `Content-Security-Policy` in
  // their original casing, and a per-route override then *adds* a second key that
  // differs only in case — a Headers object keeps both and joins them, so the
  // response read `DENY, SAMEORIGIN` (and two CSPs, which a browser intersects:
  // the stricter one wins). Lower-case both sides and an override replaces.
  const h = { 'cache-control': 'no-store', 'x-tapstall': VERSION, 'x-zimlink': VERSION };
  for (const k of Object.keys(SEC_HEADERS)) h[k.toLowerCase()] = SEC_HEADERS[k];
  for (const k of Object.keys(extra || {})) h[k.toLowerCase()] = extra[k];
  return h;
}
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...hdr(extra) },
  });
}
function html(s, status = 200, extra = {}) {
  return new Response(s, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...hdr(extra) },
  });
}
function redirect(loc, status = 302) {
  return new Response(null, { status, headers: { location: loc, 'cache-control': 'no-store' } });
}
function withCookie(res, ...cookies) { for (const c of cookies) if (c) res.headers.append('set-cookie', c); return res; }
function openCors(r) {
  r.headers.set('Access-Control-Allow-Origin', '*');
  r.headers.set('Access-Control-Allow-Headers',
    'content-type, x-tapstall-confirm, x-zimlink-confirm, x-tapstall-admin, x-zimlink-admin');
  r.headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  r.headers.set('X-Tapstall', VERSION);
  return r;
}

/* ---------------------------------------------------------------- authority */
function ipOf(req) {
  return (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'na').split(',')[0].trim();
}
async function readBody(req) {
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  if (ct.indexOf('json') >= 0) return await req.json().catch(() => ({}));
  if (ct.indexOf('form') >= 0) {
    const fd = await req.formData().catch(() => null);
    const out = {};
    if (fd) for (const [k, v] of fd.entries()) out[k] = v;
    return out;
  }
  const t = await req.text().catch(() => '');
  if (t && t[0] === '{') { try { return JSON.parse(t); } catch (e) { return {}; } }
  return {};
}
async function lockedOut(env, handle) {
  if (!env.STORES) return false;
  return Number((await env.STORES.get('lock:' + handle)) || 0) >= LOCK_MAX;
}
async function authFail(env, handle) {
  if (!env.STORES) return 0;
  const n = Number((await env.STORES.get('lock:' + handle)) || 0) + 1;
  // the counter is a courtesy to slow guessing, not a dependency: on a day the
  // write budget is gone, refuse with 403 as usual instead of 500-ing
  try { await env.STORES.put('lock:' + handle, String(n), { expirationTtl: LOCK_TTL }); } catch (e) {}
  return n;
}
async function authClear(env, handle) {
  if (!env.STORES) return;
  // Only touch KV when a counter actually exists: an unconditional delete on
  // every authenticated request would burn the 1,000 free writes/day on a
  // dashboard that polls. Reads are 100k/day, so checking first is free.
  const n = await env.STORES.get('lock:' + handle);
  if (n && Number(n) > 0) { try { await env.STORES.delete('lock:' + handle); } catch (e) {} }
}

/** Who is asking? Cookie session, or the store's API key. Never a URL token. */
async function identify(req, env, handle) {
  handle = slug(String(handle || ''));
  const st = await getStore(env, handle);
  if (!st) return null;
  const raw = cookieVal(req, 'tp_sess');
  if (raw) {
    const p = await verifyCap(env.ADMIN_SECRET || 'dev-secret', raw);
    // gen-rule: strict — deliberately not `capGenOk`. A cookie has a self-service replacement one
    // tap away (sign in again), so there is no buyer to strand and no cliff to soften; the time
    // branch exists to keep a *stranger* holding a dead link from being punished for a release
    // they never installed, and a session is not that. The store's `auth_gen` is a base36 timestamp
    // while a session minted before 0.6.0 had no `g` at all, so widening this would let an old
    // cookie back in on every shop that has never revoked. Strict, and named, so the next reader
    // does not "unify" it by mistake.
    if (p && p.a === 'sess' && p.h === handle && String(p.g) === String(st.auth_gen || '0')) {
      await authClear(env, handle);
      return { via: 'sess', st, handle };
    }
    return { bad: true, st, handle };
  }
  const key = reqHeader(req, 'x-tapstall-admin');
  if (key) {
    // Right key first, always. The lock exists to slow guessing at a key; an
    // attacker who fills it must not thereby gain the ability to lock the real
    // owner out — measured on production, where gating before the comparison
    // answered 429 to a correct key.
    if (st.admin_token && timingSafeEq(String(key), String(st.admin_token))) {
      await authClear(env, handle);
      return { via: 'key', st, handle };
    }
    if (await lockedOut(env, handle)) return { locked: true, st, handle };
    return { bad: true, st, handle };
  }
  return { anonymous: true, st, handle };
}

/** 429 for a store whose key is being guessed; null everywhere else. */
function lockRes(who) {
  return who && who.locked
    ? json({ ok: false, error: 'too many failed attempts with that key — wait for the freeze to pass, or reset the PIN with the store’s own details' }, 429)
    : null;
}



/** `&amp;` and friends, repaired to a clean query. Loops because a link escaped
 *  twice (`&amp;amp;`) is exactly what a Markdown-to-HTML-to-clipboard round trip
 *  produces, and a half-repaired query is as confusing as an unrepaired one. */
function unescapeQuery(url) {
  let s = String(url.search || '');
  for (let i = 0; i < 3 && /&(?:amp|#0*38);/i.test(s); i++) {
    s = s.replace(/&(?:amp|#0*38);/gi, '&').replace(/&&+/g, '&');
  }
  return new URL(url.origin + url.pathname + s + (url.hash || ''));
}

/* ---------------------------------------------------------------------------
 * Key + PIN. This replaced the dashboard-link sign-in wholesale.
 *
 * A six-digit PIN is 10^6, and the login form is an oracle, so the defence is the
 * throttle rather than the hash: Worker CPU on the free plan is capped at 10 ms a
 * request, and PBKDF2 at a strong iteration count costs 60 ms+ (measured — see
 * core.js), so `PIN_ITER` stays modest and is documented as such. What makes the
 * scheme safe to operate is that guesses are bounded *per store*, in memory, and
 * persisted only when a freeze tier is entered — which also means a guesser cannot
 * spend the tenant's 1,000 KV writes a day and freeze real orders as a side effect.
 * -------------------------------------------------------------------------*/
const PIN_TIERS = [[6, 60], [10, 600], [15, 3600], [22, 43200]];
const pinMem = new Map();                      // handle -> { n, tier, until }

function pinTier(n) {
  let out = { tier: -1, secs: 0 };
  for (let i = 0; i < PIN_TIERS.length; i++) if (n >= PIN_TIERS[i][0]) out = { tier: i, secs: PIN_TIERS[i][1] };
  return out;
}

async function pinLockedOut(env, handle) {
  const now = Math.floor(Date.now() / 1000);
  const m = pinMem.get(handle);
  if (m && m.until > now) return m.until - now;
  if (!env.STORES) return 0;
  const held = await env.STORES.get('pinl:' + handle, 'json');
  const left = held && held.until ? Math.max(0, held.until - now) : 0;
  if (left) pinMem.set(handle, { n: m && m.n ? m.n : 99, tier: held.tier == null ? -1 : held.tier, until: now + left });
  return left;
}

/** Records a bad try. Returns the seconds the store is now frozen for. */
async function pinFail(env, handle) {
  const prev = pinMem.get(handle) || { n: 0, tier: -1, until: 0 };
  const n = prev.n + 1;
  const t = pinTier(n);
  const now = Math.floor(Date.now() / 1000);
  const until = t.secs ? now + t.secs : 0;
  pinMem.set(handle, { n, tier: t.tier, until });
  if (t.tier > prev.tier && env.STORES) {
    try { await env.STORES.put('pinl:' + handle, JSON.stringify({ until, tier: t.tier, n }), { expirationTtl: t.secs + 120 }); } catch (e) {}
  }
  return Math.max(0, until - now);
}

async function pinClear(env, handle) {
  pinMem.delete(handle);
  if (!env.STORES) return;
  const held = await env.STORES.get('pinl:' + handle);       // reads are free; only delete if it exists
  if (held) { try { await env.STORES.delete('pinl:' + handle); } catch (e) {} }
}

/**
 * `key` is the store name and is not a secret — it is in the storefront URL. What
 * is secret is the PIN, and the two branches below (store exists / does not) do the
 * same work and answer the same words, so the form cannot be used to enumerate
 * tenants. The freeze never reports remaining tries: a guesser learns nothing.
 */
async function pinLogin(req, env) {
  const b = await readBody(req);
  const handle = slug(String(b.key || b.handle || ''));
  const pin = PIN_NORMALIZE(b.pin);
  if (!handle || !pin) return json({ ok: false, need_login: true, error: 'Enter your store name and your PIN.' }, 400);
  const frozen = await pinLockedOut(env, handle);
  const st = await getStore(env, handle);
  // The first freeze lasts a minute, which is short enough to be worth paying a KDF
  // for rather than shutting the owner out of their own shop: inside tier 1 the PIN
  // is still verified, so six guesses fired by a script cannot lock the merchant out
  // of the login. Past that tier nothing is computed at all, so a sustained flood
  // stops costing this worker anything. Either way a refusal stays a refusal.
  const checked = (!frozen || frozen <= PIN_TIERS[0][1])
    ? ((st && st.pin) ? await pinOk(pin, st.pin) : await pinMiss(pin)) : false;
  if (!st || !st.pin || !checked) {
    // Only the tiered PIN counter is touched here. Writing the shared `lock:` key
    // on every wrong PIN would hand an attacker the tenant's KV write budget — the
    // 1,000/day the order path needs — at a cost of one request each, which is the
    // failure mode measured on production in 0.5.2. A *correct* PIN still clears it.
    await pinFail(env, handle);
    if (frozen) {
      return json({ ok: false, need_login: true, retry_in_sec: frozen, error: 'Too many tries for that store — '
        + (frozen >= 90 ? 'frozen for ' + Math.ceil(frozen / 60) + ' more minutes' : frozen + ' more seconds')
        + '. When it thaws, sign in — or use “I lost my PIN” below to set a new one from your store details.' }, 429);
    }
    return json({ ok: false, need_login: true, error: 'Store name or PIN is wrong.' }, 401);
  }
  const sess = await issueCap(env.ADMIN_SECRET || 'dev-secret',
    { a: 'sess', h: st.handle, g: String(st.auth_gen || '0') }, SESS_TTL);
  await authClear(env, handle);
  await pinClear(env, handle);
  await pushAudit(env, st, { act: 'login', via: 'pin', ip: ipOf(req) });
  // A PIN set while PIN_ITER was lower is upgraded on the spot, so ratcheting the
  // cost never requires locking a merchant out to change a number in a file.
  if (st.pin.iters !== PIN_ITER) {
    const better = await pinRecord(pin);
    if (better) { st.pin = better; await writeStore(env, st); }
  }
  return withCookie(json({ ok: true, handle: st.handle, valid_for_sec: SESS_TTL }), ...sessCookie(sess));
}

/** Changing your PIN needs your current PIN: a borrowed cookie must not be able to
 *  take the account over by swapping the only secret. */
/**
 * The store's own menu edits: { over: { row: {price,out,name…} }, hide: [ids],
 * extra: [items], order: [ids] }. Signed in like any other write — session cookie
 * or API key, plus the confirm header — and applied instantly rather than held:
 * a sold-out sign and a price are the merchant's own loss to get wrong, not a way
 * to move today's money somewhere else, and a buyer who pays a stale number is
 * refused at the till by menuPrice, not quietly underpaid.
 */
/* ------------------------------------------------------------------- the books and the receipt
 *
 * Both answer from rows the platform already wrote. That is the design constraint and the reason
 * they exist at all: an operator-facing report that needs a place to put its answer is a report an
 * operator cannot run on the 31st at 23:00, when the day's writes are gone.
 */
function booksOpts(url) {
  return {
    period: String(url.searchParams.get('period') || '').slice(0, 7),
    from: String(url.searchParams.get('from') || '').slice(0, 10),
    to: String(url.searchParams.get('to') || '').slice(0, 10),
    basis: String(url.searchParams.get('basis') || '') === 'accrual' ? 'accrual' : 'cash',
  };
}

async function booksView(req, url, env) {
  const handle = slug(url.searchParams.get('handle') || '');
  const g = await adminGate(req, env, handle);
  if (g.res) return g.res;
  const st = g.who.st;
  const rows = (await env.ORDERS.get('list:' + handle, 'json')) || [];
  const opt = booksOpts(url);
  if (String(url.searchParams.get('fmt') || '').toLowerCase() === 'csv') {
    // A file, not a page: the point is that the number in the panel and the number in the
    // accountant's spreadsheet come from the same call, so nobody re-keys anything.
    return new Response(booksCsv(rows, st, opt), { headers: {
      'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': 'attachment; filename="' + handle + '-books-' + (opt.period || 'all') + '.csv"',
    } });
  }
  return json({
    ok: true, handle, opts: opt, periods: booksPeriods(rows),
    summary: booksSummary(rows, st, opt), vat: vatReturn(rows, st, opt),
    store: { shop_name: st.shop_name, currency: st.currency || 'USD', vat: vatPlan(st) },
    rows: rows.slice(0, 200),
    note: 'Cash basis counts the day a payment was marked; accrual counts the day the order arrived. Rows written before this release carry no tax figure and are computed at the shop’s current rate, counted separately below.',
  }, 200, { 'Cache-Control': 'no-store' });
}

async function receiptView(req, url, env) {
  const handle = slug(url.searchParams.get('handle') || '');
  const g = await adminGate(req, env, handle);
  if (g.res) return g.res;
  const st = g.who.st;
  const want = String(url.searchParams.get('order') || url.searchParams.get('id') || '').trim().slice(0, 60);
  if (!want) return json({ ok: false, error: 'order_required', note: 'Pass ?order=<order id or code>.' }, 422);
  const rows = (await env.ORDERS.get('list:' + handle, 'json')) || [];
  const row = rows.find((r) => r && (String(r.id) === want || String(r.code || '').toLowerCase() === want.toLowerCase()));
  if (!row) return json({ ok: false, error: 'no_such_order', note: 'Only this shop’s own orders can be printed, and the order list holds ' + rows.length + '.' }, 404);
  const o = await env.ORDERS.get('order:' + handle + ':' + row.id, 'json');
  if (!o) return json({ ok: false, error: 'no_order_document', note: 'The row exists but its order document does not, so the line items cannot be printed truthfully. Nothing was invented to fill the gap.' }, 404);
  const fmt = String(url.searchParams.get('fmt') || 'html').toLowerCase();
  if (fmt === 'txt') return text(receiptText(st, o), 200, 'text/plain; charset=utf-8');
  if (fmt === 'wa') {
    // One tap, straight to the buyer's own chat, with the receipt already in the box. No send
    // happens here and no credential is needed: the shop's WhatsApp is the delivery method, and
    // pretending otherwise would mean an SMTP password nobody on this plan has.
    const digits = String((o.buyer && o.buyer.phone) || '').replace(/\D/g, '').slice(0, 15);
    const body = receiptText(st, o);
    if (!digits) return json({ ok: true, sent: false, need_number: true, text: body,
      note: 'This order has no buyer number on it, so there is nothing to tap. The text is here for copying.' });
    return redirect('https://wa.me/' + digits + '?text=' + encodeURIComponent(body));
  }
  return html(receiptHtml(st, o), 200, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
}

/** What the mesh is allowed to know about a shop: read-time facts, never a stored claim. */
function meshFacts(st, origin) {
  const f = {
    currency: st.currency || 'USD',
    closed_today: !!st.closed,
    hours_text: st.hours || cleanWeekHours(st.week),
    origin: origin || '',
    photo: '',
  };
  const on = openNow(st, Date.now());
  if (on && typeof on === 'object') { f.open_now = !!on.open; f.open_label = on.label || ''; }
  else if (typeof on === 'boolean') f.open_now = on;
  return f;
}
function cleanWeekHours(w) { try { return w && w !== false ? (hoursText(w) || '') : ''; } catch (e) { return ''; } }

async function meshView(req, url, env) {
  const handle = slug(url.searchParams.get('handle') || '');
  const g = await adminGate(req, env, handle);
  if (g.res) return g.res;
  const st = g.who.st;
  const products = await loadProducts(st, env);
  const state = await env.ORDERS.get('mesh:' + handle, 'json').catch(() => null);
  const pack = meshPack(st, products, meshFacts(st, url.origin), { origin: url.origin, sent: state || {} });
  return json({
    ok: true, handle, plan: pack, rails: MESH_RAILS, budget: MESH_BUDGET,
    state_saved: !!state, posted: state ? (state.sent || {}) : {},
    card_url: (url.origin || '') + '/s/' + handle + '/mesh.json',
    note: 'Nothing here is sent anywhere. Tap Copy, then post it yourself — the pack is rebuilt from your menu each morning, so a price that moved today is not in a post you make tomorrow.',
  }, 200, { 'Cache-Control': 'no-store' });
}

async function meshSeen(req, env) {
  const b = await readBody(req);
  const who = await identify(req, env, b.handle || urlHandle(req));
  if (!who || !who.st) return json({ ok: false, error: 'no store' }, 404);
  if (who.anonymous || who.bad) return json({ ok: false, need_login: true, error: 'sign in first' }, 401);
  if (who.via === 'sess' && (reqHeader(req, 'x-tapstall-confirm') || '') !== '1') {
    return json({ ok: false, error: 'missing x-tapstall-confirm header' }, 403);
  }
  const st = who.st;
  const prev = await env.ORDERS.get('mesh:' + st.handle, 'json').catch(() => null);
  const next = meshMark(prev, Array.isArray(b.marked) ? b.marked : [], Date.now());
  try {
    await env.ORDERS.put('mesh:' + st.handle, JSON.stringify(next));
  } catch (e) {
    // The memory is a courtesy. A shop that has spent its write budget still gets the same pack
    // tomorrow; it just cannot be told which lines it already posted.
    return json({ ok: true, saved: false, count: next.count,
      note: 'Nothing was saved — the storage write budget for today is spent. Today’s copy is unchanged by that: tomorrow’s plan simply will not know what you posted today.' });
  }
  return json({ ok: true, saved: true, count: next.count,
    note: 'Marked. Those lines go quiet for a week, which is the whole point: a menu that is posted at every item every day is a menu nobody reads twice.' });
}

async function menuEdit(req, env) {
  const b = await readBody(req);
  const who = await identify(req, env, b.handle || urlHandle(req));
  if (!who || !who.st) return json({ ok: false, error: 'no store' }, 404);
  const lr = lockRes(who); if (lr) return lr;
  if (who.anonymous || who.bad) return json({ ok: false, need_login: true, error: 'sign in first' }, 401);
  // Same rule as a settings write: a browser session can be planted by a form on
  // someone else's page, so the dashboard has to say so out loud with a header.
  // An API key is already a secret the merchant keeps, not a cookie a page has.
  if (who.via === 'sess' && (reqHeader(req, 'x-tapstall-confirm') || '') !== '1') {
    return json({ ok: false, error: 'missing x-tapstall-confirm header' }, 403);
  }
  const st = who.st;
  const was = st.menu || {};
  const refsBefore = referencedImages(st);       // before the mutation, so a dropped picture is known
  // The handle rides along so a reference can be checked against the store saving
  // it: /i/other-shop/abc is not a picture of this shop's food.
  const next = sanitizeMenu(Object.assign({}, b.menu, { handle: st.handle }));
  const touched = Object.keys(next.over).length + next.hide.length + next.extra.length + (next.order.length ? 1 : 0);
  if (!touched) delete st.menu; else st.menu = next;
  await writeStore(env, st);
  await pushAudit(env, st, {
    act: 'menu', via: who.via, ip: ipOf(req),
    before: { edits: Object.keys(was.over || {}).length + (was.hide || []).length + (was.extra || []).length },
    after: { edits: touched },
  });
  // Any save can orphan a picture — a cleared row, a deleted extra, a revert that
  // drops the whole shelf — so the sweep runs on every one of them rather than on a
  // guess about which edits touch images. It is a list plus deletes for keys nobody
  // references, and a merchant saves a menu a handful of times a day at most.
  await pruneImages(env, st, refsBefore);
  const eff = await loadProducts(st, env);
  return json({
    ok: true, edits: touched, items: eff.length,
    note: touched
      ? 'Saved on the store, so buyers see it on their next load. Nothing in your sheet was touched — a row you edited here keeps this value until you press Revert on it.'
      : 'Everything is back to your sheet: no row is overridden here any more.',
  });
}

/* ------------------------------------------------------------ store images */
const IMG_MAX_PER_STORE = 60;
const IMG_CT = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/**
 * A picture the merchant dropped in the dashboard, out of that store's own KV.
 *
 * Why KV and not R2: R2 is the right object store and it is free to 10 GB, but a
 * bucket nobody can read in a browser is worse than a KV key everyone can — public
 * access needs a custom domain on the free plan, and this product's rule is that the
 * merchant never has to leave the dashboard or buy a name. What KV costs here is the
 * read budget, and that is answered by the header below instead of by new plumbing:
 * ids are never reused, so a storefront thumbnail is a KV read once per object and a
 * revalidation after that is a 304 with no read at all.
 */
async function imageGet(req, env, handle, id) {
  const inm = reqHeader(req, 'if-none-match') || '';
  if (inm === '"' + id + '"') {
    return new Response(null, { status: 304, headers: { etag: '"' + id + '"', 'cache-control': 'public, max-age=31536000, immutable' } });
  }
  let buf = null;
  // 'arrayBuffer' as the second argument, the way every other KV read in this file
  // asks: Cloudflare accepts both this and the options object, and the stub the live
  // suite runs on understands only this — which is how a wrong shape here reads as
  // "the picture is not there" rather than "the picture is not a picture".
  try { buf = await env.STORES.get(imgKeyOf(handle, id), 'arrayBuffer'); }
  catch (e) { return json({ ok: false, error: 'This picture could not be read just now.' }, 503, { 'Cache-Control': 'no-store' }); }
  if (!buf || !buf.byteLength) return new Response('not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const kind = sniffImage(buf);
  if (!kind || kind.bad) {
    // A value that does not sniff is not a picture we were given; drop it on the
    // floor rather than serve bytes we cannot name, and say so in the log line a
    // merchant would never see but I would want to exist.
    console.log('image_get_unsniffable', handle, id, buf.byteLength);
    return new Response('not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  return new Response(buf, {
    headers: {
      'content-type': IMG_CT[kind.kind] || 'application/octet-stream',
      'content-length': String(buf.byteLength),
      'cache-control': 'public, max-age=31536000, immutable',
      etag: '"' + id + '"',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'always',
      'access-control-allow-origin': '*',
    },
  });
}

/**
 * POST /api/image — the upload half of the same control the logo box and the item
 * rows use. It takes the file as the body and nothing else, because the browser
 * already has it: no base64 in JSON (33% bigger, and it would sit in the store
 * document where every storefront render pays for it), no form parsing, no field
 * names to agree on. The response hands back the path, and the *path* is what the
 * dashboard's normal Save writes.
 */
async function imageUpload(req, env) {
  const who = await identify(req, env, urlHandle(req));
  if (!who || !who.st) return json({ ok: false, error: 'no store' }, 404);
  const lr = lockRes(who); if (lr) return lr;
  if (who.anonymous || who.bad) return json({ ok: false, need_login: true, error: 'Sign in first: /a, your store name and your PIN.' }, 401);
  if (who.via === 'sess' && (reqHeader(req, 'x-tapstall-confirm') || '') !== '1') {
    return json({ ok: false, error: 'missing x-tapstall-confirm header' }, 403);
  }
  const st = who.st;
  const len = Number(reqHeader(req, 'content-length') || '0');
  // A 4 MB phone photo is refused before a single byte is read, so the ceiling
  // costs nothing to enforce. The client is asked for less than half of it, so
  // this only ever fires on something that was never going to be a thumbnail.
  if (len > IMG_MAX_BYTES * 4) {
    return json({ ok: false, error: 'That file is too big for a menu picture. The dashboard squeezes pictures for you if you drop it in the box instead.', max_bytes: IMG_MAX_BYTES }, 413);
  }
  let buf;
  try { buf = await req.arrayBuffer(); } catch (e) { return json({ ok: false, error: 'The file did not arrive intact — send it again.' }, 422); }
  if (!buf || !buf.byteLength) return json({ ok: false, error: 'There was nothing in that file.' }, 422);
  if (buf.byteLength > IMG_MAX_BYTES) {
    return json({ ok: false, error: 'That picture is ' + Math.round(buf.byteLength / 1024) + ' KB. Under ' + Math.round(IMG_MAX_BYTES / 1024) + ' KB, please — drop it in the box and it gets squeezed to ' + Math.round(IMG_TARGET_BYTES / 1024) + ' KB for you.', max_bytes: IMG_MAX_BYTES }, 413);
  }
  const kind = sniffImage(buf);
  if (!kind || kind.bad) {
    return json({ ok: false, error: (kind && kind.why) || 'That is not a picture we know how to serve: use a JPEG, PNG or WebP.' }, 422);
  }
  const live = await pruneImages(env, st);
  if (live >= IMG_MAX_PER_STORE) {
    return json({ ok: false, error: 'This store has ' + IMG_MAX_PER_STORE + ' pictures on file, which is the ceiling. Take one off an item or the logo and send this one again.', cap: IMG_MAX_PER_STORE }, 429);
  }
  const id = newImgId();
  try {
    await env.STORES.put(imgKeyOf(st.handle, id), buf, { metadata: { kind: kind.kind, bytes: buf.byteLength } });
  } catch (e) {
    const msg = String((e && e.message) || e);
    const qa = quotaAnswer(msg, '/api/image');
    return qa || json({ ok: false, error: 'The picture could not be stored just now: ' + msg.slice(0, 120) }, 503);
  }
  await pushAudit(env, st, { act: 'image_put', via: who.via, ip: ipOf(req), after: { ref: imgRefOf(st.handle, id), bytes: buf.byteLength, kind: kind.kind } });
  return json({ ok: true, ref: imgRefOf(st.handle, id), bytes: buf.byteLength, kind: kind.kind,
    note: 'Stored. Put it where you want it and Save — the file is already kept, so a discarded upload costs nothing but a little space.' });
}

/**
 * Delete what no document points at. Called before a count and after a save, so
 * "this store is full" is only ever said when it is true, and so an upload the
 * merchant abandoned does not sit on the 1 GB forever. One list per call, and a
 * list is not one of the 1,000 writes a day.
 */
/**
 * Free the bytes nobody points at any more. `before` is the set of refs the store
 * held *before* this save: those are deleted directly, because KV's list() is only
 * eventually consistent and the file a merchant just took off is usually the newest
 * key in the namespace — a sweep that depends on the listing alone leaves precisely
 * the picture they removed, orphaned until some later save happens to notice it.
 * The listing still runs after that, as the janitor for everything else.
 */
async function pruneImages(env, st, before) {
  const prefix = 'img:' + st.handle + ':';
  const keep = referencedImages(st);
  let gone = 0;
  const dropped = new Set(Array.from(before || []).filter((ref) => !keep.has(ref) && ref.indexOf('/i/') === 0));
  for (const ref of dropped) {
    try { await env.STORES.delete(prefix + String(ref).split('/').pop()); gone++; }
    catch (e) { /* the day's delete budget; the sweep below or a later save tries again */ }
  }
  let keys = [];
  try {
    const r = await env.STORES.list({ prefix, limit: 1000 });
    keys = (r && r.keys) || [];
  } catch (e) { return dropped.size ? keep.size : 0; }
  let live = 0;
  for (const k of keys) {
    const id = String(k.name).slice(prefix.length);
    const ref = imgRefOf(st.handle, id);
    if (keep.has(ref)) live++;
    else if (!dropped.has(ref)) { try { await env.STORES.delete(k.name); gone++; } catch (e) { /* budget; next save tries again */ } }
  }
  if (gone) console.log('image_prune', st.handle, gone, 'freed');
  return live;
}

async function pinChange(req, env) {
  const b = await readBody(req);
  const who = await identify(req, env, b.handle || urlHandle(req));
  if (!who || !who.st) return json({ ok: false, error: 'no store' }, 404);
  const lr = lockRes(who); if (lr) return lr;
  if (who.anonymous || who.bad) return json({ ok: false, need_login: true, error: 'sign in first' }, 401);
  const st = who.st;
  if (!st.pin || !await pinOk(String(b.current || ''), st.pin)) {
    await pinFail(env, st.handle);
    return json({ ok: false, error: 'Your current PIN is not right, so nothing was changed.' }, 403);
  }
  const next = PIN_NORMALIZE(b.next);
  if (!validPin(next)) return json({ ok: false, error: 'A new PIN is 6 to 8 digits.' }, 422);
  if (next === PIN_NORMALIZE(b.current)) return json({ ok: false, error: 'That is the PIN you already have.' }, 422);
  st.pin = await pinRecord(next);
  await writeStore(env, st);
  await pinClear(env, st.handle);
  await pushAudit(env, st, { act: 'pin', via: who.via, fields: ['pin'], ip: ipOf(req) });
  return json({ ok: true, changed: 'PIN', note: 'It works from the next sign-in. This device stays as it is.' });
}

/**
 * The forgotten-PIN path, which needs nobody: prove the two things only the owner
 * holds — the contact on the store and the payout account (the menu link for a
 * cash shop) — and a new PIN is set on the spot. Every other session dies with it,
 * because this is the door you use when somebody else might know your PIN.
 */
async function pinReset(req, env) {
  const b = await readBody(req);
  const handle = slug(String(b.key || b.handle || ''));
  const st = await getStore(env, handle);
  if (!st) return json({ ok: false, need_login: true, error: 'No store with that name.' }, 404);
  const frozen = await pinLockedOut(env, handle);
  if (frozen) return json({ ok: false, need_login: true, error: 'Too many attempts — wait ' + Math.ceil(frozen / 60) + ' minutes.', retry_in_sec: frozen }, 429);
  const email = String(b.owner_email || '').toLowerCase().trim();
  const wa = digits(String(b.whatsapp || '')).replace(/\D/g, '');
  const okWho = (st.owner_email && isEmail(email) && timingSafeEq(String(st.owner_email).toLowerCase(), email))
             || (st.whatsapp && wa && timingSafeEq(String(st.whatsapp).replace(/\D/g, ''), wa));
  // Second detail, in order of how well it is kept: the pay account (on slips, not
  // on the page), then the sheet link, then — for a store that has set neither yet,
  // which is every store in its first hour if it came here without a sheet — the
  // owner address it signed up with. Weaker than the other two and honest about it:
  // an address is not secret, and a stranger still has to know this store's key.
  const field = st.pay_account ? 'pay_account' : (st.feed_url ? 'feed_url' : 'owner_email');
  const proof = String(b[field] || b.pay_account || b.feed_url || '').trim();
  const want = String(field === 'owner_email' ? st.owner_email : st[field]).trim();
  const okProof = !!want && !!proof && timingSafeEq(field === 'owner_email' ? want.toLowerCase() : want,
                                                 field === 'owner_email' ? proof.toLowerCase() : proof);
  if (!okWho || !okProof) {
    await pinFail(env, handle);            // one counter, in memory; see pinLogin
    return json({ ok: false, need_login: true, error: 'Those details do not match this store.' }, 403);
  }
  let next = PIN_NORMALIZE(b.new_pin || b.pin);
  if (!next) next = genPin();
  else if (!validPin(next)) return json({ ok: false, error: 'A PIN is 6 to 8 digits.' }, 422);
  st.pin = await pinRecord(next);
  st.auth_gen = Date.now().toString(36);
  delete st.pending;
  await rotateRenewLink(env, st);          // the same lever moves the same set of credentials
  await writeStore(env, st);
  await pinClear(env, handle); await authClear(env, handle);
  await pushAudit(env, st, { act: 'pin_reset', via: 'owner', fields: ['pin', 'auth_gen'], ip: ipOf(req) });
  return json({ ok: true, handle, pin: next,
    note: 'That is your PIN now, everywhere. Sign in with your store name and it — other devices are signed out.' });
}

function urlHandle(req) {
  try { return new URL(req.url).searchParams.get('handle') || ''; } catch (e) { return ''; }
}

/* `/a` is the sign-in screen and the dashboard in one file; with the PIN model it
   needs no query parameter at all, so there is nothing to trade and nothing to
   leak. `?code=`/`?token=` links from before 0.6.0 are dead ends by design and the
   page says so. */
async function adminEntry(req, url, env) {
  return html(await tpl(env, 'admin'), 200, NOINDEX);
}

/* ------------------------------------------------------- self-service settings */
async function settingsEdit(req, url, env) {
  const b = await readBody(req);
  const who = await identify(req, env, b.handle || url.searchParams.get('handle'));
  if (!who || !who.st) return json({ ok: false, error: 'no store' }, 404);
  const lr = lockRes(who); if (lr) return lr;
  if (who.anonymous) return json({ ok: false, need_login: true, error: 'Not signed in: open /a and sign in with your store name and PIN. (Or send your API key as x-tapstall-admin, which is what a script should do.)' }, 401);
  if (who.bad) { await authFail(env, who.handle); return json({ ok: false, error: 'bad key or revoked session' }, 403); }
  // A cookie is ambient authority, so require a header a cross-site form
  // cannot set. SameSite=Strict already blocks most of that; this is the belt.
  if (who.via === 'sess' && (reqHeader(req, 'x-tapstall-confirm') || '') !== '1') {
    return json({ ok: false, error: 'missing x-tapstall-confirm header' }, 403);
  }
  const st = who.st;
  const patch = (b.settings && typeof b.settings === 'object') ? b.settings : b;
  // validated against the live catalogue, so a rail the operator added this
  // morning is accepted here in the same breath as the built-ins, and a
  // misspelled one comes back as a field error instead of a mystery
  const cat = await railsCatalog(env);
  // A POST that describes a rail and fills its number in the same breath is one
  // intention, not two: the number is validated against the shape being written
  // now, not the one that happened to be stored before it.
  const described = patch.rail_def && typeof patch.rail_def === 'object' ? normaliseRail(patch.rail_def, 'custom') : null;
  const v = validateSettings(patch, Date.now(), { rails: cat, rail_def: described || st.rail_def, handle: st.handle });
  if (!v.ok) return json({ ok: false, error: 'some fields need a different format', fields: v.errors, ignored: v.ignored,
    hint: v.errors.rail ? 'Pick one of: ' + Object.keys(cat).join(', ') + '. "custom" means you describe it below.' : undefined }, 422);
  if (v.money.rail === 'custom') {
    const def = v.money.rail_def !== undefined ? v.money.rail_def : st.rail_def;
    if (!(def && def.label)) {
      return json({ ok: false, error: 'a custom rail needs a name, what the buyer dials, and its fee',
        fields: { rail_def: 'label, dial, pct (0-30), fixed, type' } }, 422);
    }
  }
  const keys = Object.keys(v.soft).concat(Object.keys(v.money));
  if (!keys.length) {
    return json({ ok: false, error: 'nothing to change', unknown: v.ignored, fields: v.errors,
      note: 'Send only the fields you want changed, with their current names.' }, v.ignored.length ? 422 : 200);
  }
  const before = {};
  for (const k of keys) before[k] = maskField(k, st[k]);
  const refsBefore = referencedImages(st);       // the logo about to be replaced, if any
  const { changed, staged } = stageSettings(st, v.soft, v.money, HOLD_MS, Date.now());
  const after = {};
  for (const k of keys) {
    const held = st.pending && st.pending.fields && k in st.pending.fields;
    after[k] = maskField(k, held ? st.pending.fields[k] : st[k]);
  }
  if (changed || staged) await writeStore(env, st);
  // Swapping or clearing the logo orphans its bytes: the store document holds a
  // path, so the file itself has nobody left who points at it.
  if (changed && v.soft.logo !== undefined) await pruneImages(env, st, refsBefore);
  const logged = (changed || staged) ? await pushAudit(env, st, { act: 'settings', via: who.via, changed, staged, before, after, ip: ipOf(req) }) : true;
  const held = Object.keys(v.money);
  return json({
    ok: true, applied_now: changed ? Object.keys(v.soft) : [],
    logged,                                    // false = a gap in the change log,
    held, hold_until: st.pending ? st.pending.apply_at : null,
    unchanged: !changed && !staged,
    // one note, in order of what the merchant most needs to know: a missing
    // log line first (a duplicate `note:` key used to silently overwrite it
    // with 'Saved.'), then the hold, then the ordinary thank-you
    note: !logged ? LOG_GAP
      : held.length
        ? 'Payment, menu and contact changes take effect after 15 minutes and you can cancel them in that window. Anyone already ordering pays the account printed on their slip, so a stolen link cannot quietly reroute today’s takings.'
        : 'Saved.',
  });
}

async function revertPending(req, url, env) {
  const b = await readBody(req);
  const who = await identify(req, env, b.handle || url.searchParams.get('handle'));
  if (!who || !who.st) return json({ ok: false, error: 'no store' }, 404);
  const lr = lockRes(who); if (lr) return lr;
    if (who.anonymous || who.bad) return json({ ok: false, error: 'sign in first' }, 401);
  const was = who.st.pending ? Object.keys(who.st.pending.fields) : [];
  if (was.length) { delete who.st.pending; await writeStore(env, who.st); }
  await pushAudit(env, who.st, { act: 'revert', via: who.via, fields: was, ip: ipOf(req) });
  return json({ ok: true, cancelled: was });
}

/* The renew link is not a signed capability, so a generation change alone would leave the shop
   holding a dead URL while the closed page told it the current one was on the plan card. Here the
   record moves: the old key is deleted, a fresh one is minted under the new generation, and the
   store's own copy of the URL follows. Every site that bumps `auth_gen` calls this, so no lever
   can half-revoke. Two writes on a rare action; the origin is kept by string, because these sites
   do not all have the request URL to hand and the link must stay on the host it was issued on. */
async function rotateRenewLink(env, st) {
  if (!st || !st.renew_url || !env || !env.STORES) return;
  const head = String(st.renew_url).split('/renew/')[0];
  const old = String(st.renew_url).split('/renew/')[1] || '';
  const tok = alnumToken(14);
  if (old) await env.STORES.delete('renew:' + old);
  await env.STORES.put('renew:' + tok,
    JSON.stringify({ handle: st.handle, made: Date.now(), g: String(st.auth_gen || '0') }));
  st.renew_url = head + '/renew/' + tok;
}

/** One write that kills every outstanding link, key and cookie for a store. */
async function revokeKeys(req, url, env) {
  const b = await readBody(req);
  const who = await identify(req, env, b.handle || url.searchParams.get('handle'));
  if (!who || !who.st) return json({ ok: false, error: 'no store' }, 404);
  const lr = lockRes(who); if (lr) return lr;
    if (who.anonymous || who.bad) return json({ ok: false, error: 'sign in first' }, 401);
  const st = who.st;
  st.auth_gen = Date.now().toString(36);
  st.admin_token = randomKey(16);
  delete st.pending;
  await rotateRenewLink(env, st);
  await writeStore(env, st);
  await pushAudit(env, st, { act: 'revoke', via: who.via, ip: ipOf(req) });
  const res = json({
    ok: true, api_key: st.admin_token,
    note: 'Every session and API key for this store is dead, and so is any payment-code link or confirm link a buyer was holding, and the renew link in your welcome email — the new key is above. Your PIN still signs you in; change it inside the dashboard if you think somebody knows it.',
  });
  return withCookie(res, ...KILL_COOKIES);
}

/**
 * "Lost your link" without an operator. Proof of ownership = the two values
 * that are on no public page: the owner email and the payment account. With a
 * mail binding it also arrives by email; without one it is shown once here.
 */

/* ------------------------------------------------------------------ audit */
async function pushAudit(env, st, row) {
  if (!env.ORDERS || !st) return false;
  const k = 'audit:' + st.handle;
  let cur = [];
  try { cur = (await env.ORDERS.get(k, 'json')) || []; } catch (e) { cur = []; }
  try {
    cur.unshift({
    at: new Date().toISOString(), act: row.act, via: row.via || '', ip: row.ip || '',
    changed: row.changed || 0, staged: row.staged || 0,
      fields: row.fields || Object.keys(row.before || {}),
      before: row.before || undefined, after: row.after || undefined,
    });
    await env.ORDERS.put(k, JSON.stringify(cur.slice(0, 40)));
    return true;
  } catch (e) { return false; }   // the change stands; the log has a gap, and
}                                 // the response says so rather than failing
async function getAudit(env, handle) {
  if (!env.ORDERS) return [];
  return (await env.ORDERS.get('audit:' + handle, 'json')) || [];
}

/* -------------------------------------------------- inert, self-posting page */
function js(v) { return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '').replace(/\u2029/g, ''); }
function shell(title, body) {
  return '<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">'
    + '<title>' + esc(title) + '</title><style>body{font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;background:#0b0f14;color:#101418;margin:0;padding:1.2rem}'
    + '.c{background:#fff;border-radius:16px;padding:1.1rem;max-width:26rem;margin:6vh auto}'
    + 'b{font-variant-numeric:tabular-nums}button{font:inherit;background:#0b0f14;color:#fff;border:0;border-radius:10px;padding:.7rem .9rem;width:100%;font-weight:600}'
    + '.t{color:#65788b;font-size:.85rem}</style><div class=c>' + body + '</div></body></html>';
}

/**
 * The page a confirm link opens. It changes nothing by itself: it shows the
 * money context, then the browser POSTs. A crawler that fetches and never runs
 * the script leaves the order exactly as it was.
 */
/* The refusal, once. Two doors render it — the KV skin, when it can say so, and this floor —
   and a screenshot of one must not contradict the other, which is why the sentence is not typed
   twice. No form, no button: 0.8.3 was about a refusal that promised an action, and a closed link
   has none left. */
function linkClosed(o) {
  return html(shell('Link closed', '<h2>This shop has closed its payment links</h2>'
    + '<p class=t>Your order <b>' + esc(o.code) + '</b> is still ' + esc(o.status) + ' and nothing about it changed. '
    + 'Send the shop that code and they can confirm it in one tap from their dashboard.</p>'), 410);
}

async function confirmPage(env, cap) {
  const p = await verifyCap(env.ADMIN_SECRET || 'dev-secret', cap);
  let custom = env.STORES ? await env.STORES.get('tpl:confirm') : null;
  if (custom && custom.length > 200) {
    // same state machine, markup from KV so the page can be re-skinned without
    // a redeploy; the inline builder below is the floor if the template is gone
    let state = 'expired';
    let data = { cap, state };
    if (p && p.a === 'mark') {
      const st = await getStore(env, p.h);
      const o = st ? await env.ORDERS.get('order:' + p.h + ':' + p.id, 'json') : null;
      if (!st || !o) state = data.state = 'missing';
      else if (p.a === 'mark' && !capGenOk(p, st, o)) {
        if (!/revoked/.test(custom)) return linkClosed(o);
        // A skin that carries the branch gets the fact: 'expired' is the state it already renders
        // sanely, and `revoked` is what a re-skinned page can say better. The check matters
        // because the copy in KV is published separately from the code: the 0.8.5 page has no
        // branch for this, and its expired panel would tell the buyer they were too slow.
        state = data.state = 'expired';
        data = { cap, state: 'expired', revoked: true, code: o.code, status: o.status,
                 shop: st.shop_name, handle: st.handle, store_url: '/s/' + st.handle };
      }
      else {
        const want = markTarget(p.s);
        data = {
          cap, state: o.status === want ? 'already' : 'confirm', want,
          shop: st.shop_name, handle: st.handle, code: o.code, amount: (o.pricing && (o.pricing.pay_now || o.pricing.total)) || 0,
          currency: st.currency || 'USD', buyer: (o.buyer && o.buyer.name) || 'buyer',
          rail: (o.pricing && o.pricing.rail && o.pricing.rail.label) || '', marked_at: o.marked_at || null,
          store_url: '/s/' + st.handle,
        };
      }
    }
    return html(fillPage(custom, [['TAPSTALL_CONFIRM', data]]));
  }
  if (!p || p.a !== 'mark') {
    return html(shell('Link expired', '<h2>This link has expired</h2><p class=t>Confirm links last 72 hours. Open your dashboard and use the Confirm button on the order — it does exactly the same thing.</p>'));
  }
  const st = await getStore(env, p.h);
  const o = st ? await env.ORDERS.get('order:' + p.h + ':' + p.id, 'json') : null;
  if (!o) return html(shell('Order not found', '<h2>Order not found</h2><p class=t>It may have been archived.</p>'), 404);
  if (!capGenOk(p, st, o)) return linkClosed(o);
  const want = markTarget(p.s);
  if (o.status === want) {
    return html(shell('Already confirmed', '<h2>Already ' + esc(want) + '</h2><p class=t>' + esc(o.code) + ' was confirmed on ' + esc(String(o.marked_at || '').slice(0, 16).replace('T', ' ')) + ' UTC. Nothing changed.</p>'));
  }
  const amt = (o.pricing && (o.pricing.pay_now || o.pricing.total)) || 0;
  const body = '<h2 style="margin:.1rem 0 .4rem">' + esc({ paid: 'Mark ' + o.code + ' paid?', cancelled: 'Cancel ' + o.code + '?', awaiting_payment: 'Reopen ' + o.code + ' as unpaid?' }[want]) + '</h2>'
    + '<p><b>' + esc(String(amt)) + ' ' + esc(st.currency || 'USD') + '</b> from ' + esc((o.buyer && o.buyer.name) || 'buyer')
    + '<br><span class=t>ref ' + esc(o.code) + ' · ' + esc((o.pricing && o.pricing.rail && o.pricing.rail.label) || '') + '</span></p>'
    + '<p id=s class=t>Confirming…</p>'
    + '<form method="post" action="/api/mark" style="margin:.6rem 0 0"><input type="hidden" name="cap" value="' + esc(cap) + '">'
    + '<button type="submit">Tap if this is not automatic</button></form>'
    + '<script>var f=new FormData();f.set("cap",' + js(cap) + ');'
    + 'fetch("/api/mark",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cap:' + js(cap) + '})})'
    + '.then(function(r){return r.json()}).then(function(j){document.getElementById("s").innerHTML=j.ok'
    + '?("<b style=color:#0b5b34>✓ " + (j.label||"Done") + "</b>"):"<span style=color:#b00020>"+(j.error||"failed")+"</span>"})'
    + '.catch(function(){document.getElementById("s").textContent="Could not reach the server — use the button.";});</script>';
  return html(shell('Confirm order', body));
}function notFoundPage(handle) {
  return `<!doctype html><meta charset=utf-8><title>No store here</title>
<body style="font:16px/1.6 system-ui;max-width:34rem;margin:14vh auto;padding:0 1.2rem">
<h1>No store at /s/${esc(handle)}</h1>
<p>Stores are created by the owner, instantly, with no approval from anyone.</p>
<p><a href="/onboard">Create one free →</a></p></body>`;
}
function feesIcs() {
  const d = new Date().toISOString().replace(/[-:]/g, '').slice(0, 8);
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tapstall//rates//EN', 'BEGIN:VEVENT',
    `UID:tapstall-rates-${d}@tapstall`, `DTSTAMP:${d}T090000Z`, `DTSTART;VALUE=DATE:${nextJan(d.slice(0, 4))}`,
    'SUMMARY:Re-check mobile money tariffs after the national budget',
    'DESCRIPTION:EcoCash/InnBucks/PayShap/PayFast rates and VAT change with budgets. Update surcharge settings and prices on your Tapstall store.',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  return new Response(body, { headers: { 'content-type': 'text/calendar; charset=utf-8', 'access-control-allow-origin': '*' } });
}
const nextJan = (y) => `${Number(y) + 1}0115`;
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ============================================================ operator suite
 *
 * A control panel for whoever runs the platform: how every tenant is doing,
 * whether the feed/cron/deploy are healthy, and a handful of levers for when a
 * merchant is stuck. It exists so that NOTHING in the normal customer journey
 * ever needs a human: those pages are for exceptions and for reading, not for
 * onboarding anyone.
 *
 * Auth: paste the platform secret once -> a 12-hour HttpOnly cookie. The secret
 * never goes in a URL, never goes in the page, and is never sent to the browser.
 * Guessing is throttled per-platform, and a correct secret always works — the
 * lock exists to stop a stranger, not to lock the owner out of their own shop.
 */
function secsToMidnightUTC() {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60, Math.round((midnight - now.getTime()) / 1000));
}

const OPS_COOKIE = 'tp_ops';
const OPS_TPL_NAMES = ['store', 'onboard', 'admin', 'fees', 'index', 'confirm', 'renew', 'ops', 'sample-menu',
  'guide-whatsapp-shop-payments', 'guide-payment-reference-matching'];
const PAGES_URL = 'https://king-kunta-cpu.github.io/tapstall/';

function opsKillCookies() { return killCookies([OPS_COOKIE]); }

/** The console session is a stateless signed cap — nothing to look up, which
 *  is why it costs no KV write to sign in from a hotel laptop. It also means
 *  a cookie would outlive "sign out" unless a generation number is carried in
 *  it, so one tiny KV read is the price of a logout that actually logs out.
 *  Bumping it ends every console session on the platform at once. */
async function endOpsSessions(env) {
  if (!env.STORES) return true;
  // returns whether the platform-wide revocation actually landed. Swallowing
  // this error let the reply promise "every console session is ended now" while
  // a stolen cookie stayed valid for its remaining 12 hours — the one answer
  // the operator must be able to trust.
  try { await env.STORES.put('ops_gen', Date.now().toString(36)); return true; } catch (e) { return false; }
}
async function opsGen(env) {
  if (!env.STORES) return '0';
  try { return (await env.STORES.get('ops_gen')) || '0'; } catch (e) { return '0'; }
}

async function opsIssue(env) {
  return issueCap(env.ADMIN_SECRET || 'dev-secret', { a: 'ops', g: VERSION, n: await opsGen(env) }, SESS_TTL);
}

async function opsAuthed(req, env) {
  // gen-rule: platform — this door is bound to `ops_gen`, not to a store's `auth_gen`, and
  // `issueCap` demands `n` of an `ops` cap for exactly that reason: `g` here is a version string,
  // so a guard that only looked for `g` would have called any ops cap bound.
  const raw = cookieVal(req, OPS_COOKIE);
  if (!raw) return { anon: true };
  const p = await verifyCap(env.ADMIN_SECRET || 'dev-secret', raw);
  if (p && p.a === 'ops' && String(p.n) === String(await opsGen(env))) return { ok: true };
  return { bad: true };
}

/* The free Workers plan answers a spent KV write budget with
   `KV put() limit exceeded for the day.` — hit for real on 2026-10-10 after a
   few prod checks and two deploys. Two rules follow from it. (1) Never let it
   surface as a 500 with internals in it: say what it is and when it clears.
   (2) Say it in the reader's own terms, because the same exception reaches a
   buyer placing an order, a merchant saving a setting and an operator pulling a
   lever, and the message that comforts one alarms or confuses the others.
   Anything that catches and reshapes an error (opsGate below) has to consult
   this too, or the whole point is lost one layer down. */
const QUOTA_RE = /put\(\) limit|write.*limit/i;
/* A CPU ceiling and a spent write budget need different fixes: one is a code problem, the other
   is a date on the calendar. They used to be answered by one regex, so a Worker that ran out of
   compute reported that the account had none left today. Why a check is blocked is a fact about
   the account, and a fact about the account has to be the right one. */
const LIMIT_RE = /CPU time exceeded|Memory limit/i;
function quotaAnswer(msg, pathname, req) {
  if (!QUOTA_RE.test(msg)) return null;
  const secs = secsToMidnightUTC();
  // The buyer's door is a public write like the cart, and a browser reaches it with a
  // <form>. Two things follow on a day the account has spent its 1,000 writes: the answer
  // is addressed to the buyer, not to the merchant whose settings are nothing to do with
  // this, and it is a page, not a JSON blob in the middle of someone's payment. It is also
  // not an answer about the order — a full budget is a fact about the shop's plan — so the
  // page prunes nothing: the link the buyer is holding still works the moment the shop can
  // write again, and the storefront line stays up to bring them back to it.
  const doorForm = pathname === '/api/proof'
    && String((req && req.headers && req.headers.get('content-type')) || '')
         .includes('application/x-www-form-urlencoded');
  const buyerish = pathname === '/api/order' || pathname === '/api/lookup' || pathname === '/api/proof';
  const merchantish = pathname.indexOf('/api/') === 0 || /^\/(a|c\/|renew\/)/.test(pathname);
  const who = buyerish ? 'buyer' : merchantish ? 'merchant' : 'operator';
  const line = who === 'buyer'
    ? 'This store is out of storage writes for the day. Nothing is lost and no order was taken — try again in a few hours, or message the shop directly.'
    : who === 'merchant'
      ? 'Nothing was saved, and nothing was half-saved: your settings are exactly as they were. The account\u2019s storage writes are spent for today — try again in a few hours.'
      : 'Nothing was written. The account has spent its free storage writes for today (1,000/day on the free Workers plan), so this lever will work again in a few hours. Upgrade to the $5 plan and the ceiling goes away.';
  if (doorForm) {
    return html(shell("Not saved", `<h2 style="margin:.1rem 0 .5rem">Not saved</h2>`
        + `<p class=t>The shop cannot take a code at this moment — its storage allowance for the day is spent. Nothing you sent was lost, and the order stands exactly as it was.</p>`
        + `<p class=t>Try again in a few hours, or paste it into the chat with the shop: it is the same field either way.</p>`),
      503, Object.assign({ 'Retry-After': String(secs) }, NOINDEX));
  }
  return json({ ok: false, retry_in_sec: secs, detail: msg, who, error: line },
    503, { 'Retry-After': String(secs), 'Cache-Control': 'no-store' });
}

/** A POST that carries an `action` to a read-only ops path: answered as an error
 *  rather than as a successful no-op. Returns null for everything legitimate. */
async function misroutedLever(req, path) {
  if (req.method !== 'POST') return null;
  let b = null;
  try { b = await req.clone().json(); } catch (e) { return null; }
  const act = b && String(b.action || b.act || '').slice(0, 32);
  if (!act) return null;   // a read endpoint ignores an empty or unrelated body, as before
  return json({
    ok: false,
    error: `'${act}' is a store lever: it posts to /ops/api/store with {handle, action}. `
         + `${path} is a read endpoint — it would have answered your last attempt with the `
         + 'current state and changed nothing.',
    action: act, use: '/ops/api/store',
  }, 400);
}

async function opsGate(req, env, fn) {
  const who = await opsAuthed(req, env);
  if (who.ok) {
    try { return await fn(); }
    catch (e) {
      const msg = String((e && e.message) || e);
      // a lever that cannot write is not a broken console, and this catch would
      // otherwise turn the one explainable failure into a bare 500
      const spent = quotaAnswer(msg, new URL(req.url).pathname);
      if (spent) return spent;
      return json({ ok: false, error: msg, stage: 'ops' }, 500);
    }
  }
  // A stale or forged *cookie* is refused but does not feed the lock counter:
  // the counter exists to slow somebody guessing the secret at /ops/login, and
  // a cookie is unguessable by construction (HMAC over the payload). Counting
  // cookies instead let a refresh on an expired session walk the operator's own
  // door toward a 10-minute freeze — the same self-inflicted DoS the per-store
  // lockout had, found by the prod check hammering this endpoint.
  if (who.anon) return json({ ok: false, error: 'sign in with the platform secret', need_login: true }, 401);
  return json({ ok: false, error: 'session expired — paste the platform secret again', need_login: false }, 401);
}

async function opsLogin(req, env) {
  if (!env.ADMIN_SECRET) return json({ ok: false, error: 'ADMIN_SECRET is not bound on this Worker, so the console stays shut' }, 503);
  const b = await readBody(req);
  if (await lockedOut(env, '__ops')) return json({ ok: false, error: 'too many attempts — wait 10 minutes' }, 429);
  const given = String(b.secret || b.token || '').trim();
  if (given && timingSafeEq(given, String(env.ADMIN_SECRET))) {
    await authClear(env, '__ops');
    const cap = await opsIssue(env);
    await pushOpsLog(env, { act: 'login', ip: ipOf(req) });
    return withCookie(json({ ok: true, valid_for_sec: SESS_TTL, note: 'This console is oversight only — no customer flow waits on it.' }),
      `${OPS_COOKIE}=${encodeURIComponent(cap)}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${SESS_TTL}`,
      'zl_ops=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure');
  }
  const n = await authFail(env, '__ops');
  return json({ ok: false, error: 'not the platform secret', tries_left: Math.max(0, LOCK_MAX - n) }, 403);
}

async function opsPage(req, env) {
  const who = await opsAuthed(req, env);
  const page = await tpl(env, 'ops');
  const signed = who.ok ? 'true' : 'false';
  return html(fillPage(page, [['TAPSTALL_OPS', { signed_in: who.ok === true, version: VERSION }]]), 200, NOINDEX);
}

function opsSummarise(st, rows) {
  const now = Date.now();
  const left = Math.ceil(((st.paid_until || 0) - now) / 864e5);
  const today = rows.filter(r => String(r.at || '').slice(0, 10) === new Date(now).toISOString().slice(0, 10));
  return {
    handle: st.handle, shop_name: st.shop_name, currency: st.currency || 'USD', rail: st.rail,
    plan: st.plan || 'free60', left, suspended: !!st.suspended, created_at: st.created_at,
    paid_until: st.paid_until || 0, feed_products: st.feed_cache ? (st.feed_cache.count || 0) : 0,
    feed_error: st.feed_cache ? (st.feed_cache.error || null) : 'never fetched',
    notify_email: !!st.notify_email, owner_email: st.owner_email ? maskField('notify_email', st.owner_email) : null,
    pay_account_set: !!st.pay_account, whatsapp_set: !!st.whatsapp,
    // can this tenant sign in at all? a store migrated from link login has no PIN
    // until the owner resets it or the operator sets one — say so on the tile.
    has_pin: !!(st.pin && st.pin.hash), pin_set_at: st.pin ? (st.pin.set_at || null) : null,
    has_pending: !!(st.pending && st.pending.fields && Object.keys(st.pending.fields).length),
    pending_apply_at: st.pending ? st.pending.apply_at : null,
    orders: rows.length, orders_today: today.length,
    unpaid: rows.filter(r => r.status === 'awaiting_payment').length,
    cod: rows.filter(r => r.status === 'cod').length,
    gmv: rows.reduce((a, r) => a + (Number(r.total) || 0), 0),
    last_order_at: rows.length ? rows[0].at : null,
    store_url: '/s/' + st.handle,
  };
}
async function opsRefs(env, handle) {
  return ((await env.STORES.get('ref:' + handle, 'json')) || []).slice(0, 5);
}

async function opsState(env) {
  const t0 = Date.now();
  const listed = await env.STORES.list({ prefix: 'store:', limit: 1000 });
  const handles = (listed.keys || []).map(k => String(k.name).slice('store:'.length)).filter(Boolean);
  const stores = [];
  for (const h of handles) {
    const st = await getStore(env, h);
    if (!st) continue;
    const rows = (await env.ORDERS.get('list:' + h, 'json')) || [];
    const sum = opsSummarise(st, rows);
    sum.awaiting_reference = await opsRefs(env, h);
    sum.awaiting_ref = sum.awaiting_reference.length;
    stores.push(sum);
  }
  stores.sort((a, b) => (b.orders_today - a.orders_today) || String(a.handle).localeCompare(b.handle));
  const due = stores.filter(s => !s.suspended && s.left <= 7);
  return json({
    ok: true, at: new Date().toISOString(), ms: Date.now() - t0,
    version: VERSION, stores,
    totals: {
      stores: stores.length,
      live: stores.filter(s => !s.suspended).length,
      suspended: stores.filter(s => s.suspended).length,
      expiring_7d: due.length,
      expired: stores.filter(s => s.left <= 0).length,
      feeds_broken: stores.filter(s => !s.feed_products || s.feed_error).length,
      orders_today: stores.reduce((a, s) => a + s.orders_today, 0),
      orders_all: stores.reduce((a, s) => a + s.orders, 0),
      unpaid: stores.reduce((a, s) => a + s.unpaid, 0),
      pending_settings: stores.filter(s => s.has_pending).length,
      gmv: Math.round(stores.reduce((a, s) => a + s.gmv, 0) * 100) / 100,
      awaiting_reference: stores.reduce((a, s) => a + (s.awaiting_ref || 0), 0),
      on_free: stores.filter(s => s.plan === 'free60').length,
      paying: stores.filter(s => s.plan !== 'free60').length,
    },
    attention: stores.filter(s => s.suspended || s.left <= 7 || !s.feed_products || s.feed_error || s.has_pending || s.awaiting_ref)
      .map(s => ({ handle: s.handle, why: [s.suspended ? 'suspended' : '', s.left <= 0 ? 'expired' : (s.left <= 7 ? s.left + 'd left' : ''), (!s.feed_products || s.feed_error) ? 'menu' : '', s.has_pending ? 'queued settings' : '', s.awaiting_ref ? s.awaiting_ref + ' payment ref(s)' : ''].filter(Boolean).join(' · '), left: s.left })),
    free_plan: { kv_reads_day: 100000, kv_writes_day: 1000, kv_list_day: 1000, requests_day: 100000, cron_runs_day: 5 },
    reads_used_estimate: stores.length * 2 + 1,
  }, 200, { 'Cache-Control': 'no-store' });
}

/**
 * Every refusal at a money door is counted, once per hour per outcome, and only if that
 * hour has not already logged one. The bound matters more than the detail: a stranger
 * can generate refusals at will, and this account has 1,000 KV writes a day in total,
 * so an unbounded audit trail is a denial-of-wallet waiting to happen. (The COREMERCH
 * engine this is taken from posts every guard refusal to Discord, which is right about
 * visibility and silent about cost.)
 */
const hookSeen = new Set();
function auditHook(env, ctx, status, note) {
  const key = hookAuditKey(hookHourStamp(), status);
  if (hookSeen.has(key)) return null;
  if (hookSeen.size > 400) hookSeen.clear();     // an isolate lives for hours, not forever, but say it anyway
  hookSeen.add(key);
  const rec = { at: new Date().toISOString(), note: String(note || '').slice(0, 160), version: VERSION };
  // `onlyIf: {match:'none'}` is the guard that actually holds. The set above is a
  // courtesy — it is per isolate, and a burst spreads across isolates, so without the
  // conditional write the "once an hour" bound is only as true as the warmest worker.
  // If a namespace cannot do conditional writes, the `catch` loses the line rather
  // than opening the budget: the audit is worth a read, not a denial of service.
  const job = env.STORES.put(key, JSON.stringify(rec), { expirationTtl: 7 * 86400, onlyIf: { match: 'none' } })
    .catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(job);
  return job;
}

/** One line for the operator: what the money doors were asked for, and what they did
 *  about it, per hour. A count per hour is not a census of attempts and never claimed
 *  to be — a census is exactly what an attacker would pay us in writes to obtain. */

async function opsHealth(env) {
  const t = await selftest(env);
  let pages = 'unreachable';
  try {
    const r = await fetch(PAGES_URL, { headers: { 'user-agent': 'tapstall/1 (operator health check)' } });
    pages = r.status === 200 ? 'ok' : 'http ' + r.status;
  } catch (e) { pages = 'unreachable'; }
  let ci = null;
  try {
    const r = await fetch(REPO_RAW + 'ci-deploy.log', { headers: { 'user-agent': 'tapstall/1 (operator health check)' } });
    if (r.ok) { const txt = await r.text(); ci = txt.split('\n').filter(l => /==== exit|tests |pass |fail /.test(l)).slice(-6); }
  } catch (e) { ci = null; }
  // what the two money doors were asked for in the last 24 hours, by outcome
  const hooks = { refused: 0, ignored: 0, already: 0, activated: 0, hours: [] };
  try {
    const list = await env.STORES.list({ prefix: 'hooks:', limit: 200 });
    const since = hookHourStamp(Date.now() - 24 * 3600 * 1000);
    for (const k of list.keys || []) {
      const name = String(k.name || '');
      const hour = name.slice(6, 16);
      if (hour < since) continue;
      hooks.hours.push(name);
      const status = name.split(':')[2];
      if (hooks[status] !== undefined) hooks[status]++;
    }
    hooks.hours.sort();
  } catch (e) { hooks.error = String((e && e.message) || e).slice(0, 120); }
  return json({ ok: true, selftest: t, pages, ci, cron: t.cron_heartbeat || null, version: VERSION, templates: OPS_TPL_NAMES, hooks },
    200, { 'Cache-Control': 'no-store' });
}

async function opsAudit(req, url, env) {
  const handle = slug(url.searchParams.get('handle') || '');
  if (handle) return json({ ok: true, handle, entries: await getAudit(env, handle) }, 200, { 'Cache-Control': 'no-store' });
  const listed = await env.STORES.list({ prefix: 'store:', limit: 1000 });
  const out = [];
  for (const k of (listed.keys || [])) {
    const h = String(k.name).slice('store:'.length);
    const rows = await getAudit(env, h);
    for (const r of rows.slice(0, 5)) out.push({ handle: h, at: r.at, act: r.act, via: r.via, fields: r.fields });
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const ops = await getOpsLog(env);
  return json({ ok: true, entries: out.slice(0, 60), ops }, 200, { 'Cache-Control': 'no-store' });
}

async function getOpsLog(env) {
  if (!env.ORDERS) return [];
  return (await env.ORDERS.get('audit:ops', 'json')) || [];
}
/**
 * Logging is never allowed to break the thing it is logging. Cloudflare's free
 * KV tier answers `KV put() limit exceeded for the day.` once the 1,000 writes
 * are gone — measured today, after three prod_check runs and two CI deploys —
 * and a console that 500s because its own audit line failed is worse than a
 * console with a gap in the log. Each helper therefore returns whether it
 * wrote, so callers can say so out loud instead of pretending.
 */
const LOG_GAP = 'Applied, but this change could not be written to your change log — the storage write budget for today is spent. Nothing about the change itself failed.';

async function pushOpsLog(env, row) {
  if (!env.ORDERS) return false;
  try {
    const cur = await getOpsLog(env);
    cur.unshift({ at: new Date().toISOString(), act: row.act, handle: row.handle || '', note: row.note || '', ip: row.ip || '' });
    await env.ORDERS.put('audit:ops', JSON.stringify(cur.slice(0, 60)));
    return true;
  } catch (e) { return false; }
}

/**
 * The levers, all of them reversible and all of them logged. None of them is on
 * a customer's critical path; they exist so a stuck merchant can be un-stuck in
 * one click instead of one support conversation.
 */
async function opsStoreAction(req, env) {
  const b = await readBody(req);
  if ((reqHeader(req, 'x-tapstall-confirm') || '') !== '1') return json({ ok: false, error: 'missing x-tapstall-confirm header' }, 403);
  const handle = slug(String(b.handle || ''));
  const st = await getStore(env, handle);
  if (!st) return json({ ok: false, error: 'no store' }, 404);
  const act = String(b.action || '');

  // the two levers that change nothing on the plan answer here and return,
  // before the state-writing chain below — they used to fall through it and
  // come back as `unknown action`, which made them dead buttons
  if (act === 'notify') {
    const sent = [];
    const failed = [];
    if (st.notify_webhook) {
      try {
        await fetch(st.notify_webhook, {
          method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'tapstall/1 (operator notice)' },
          body: JSON.stringify({ type: 'store.notice', store: handle, text: b.message || 'A note from your Tapstall store: your store is fine, nothing is needed from you.' }),
        });
        sent.push('webhook');
      } catch (e) { failed.push('webhook'); }
    }
    if (env.EMAIL && (st.owner_email || st.notify_email)) {
      try {
        await sendMail(env, st.owner_email || st.notify_email, 'A note about your Tapstall store', String(b.message || 'Your store is running normally. No action needed.'));
        sent.push('email');
      } catch (e) { failed.push('email'); }
    }
    // a channel that threw is not a delivery: saying "Sent." when the POST
    // failed would leave the operator believing the merchant had been told
    await pushOpsLog(env, { act: 'notify', handle, note: (sent.join('+') || 'none') + (failed.length ? ' (failed: ' + failed.join(',') + ')' : ''), ip: ipOf(req) });
    return json({
      ok: true, delivered: sent, failed,
      note: sent.length && !failed.length ? 'Sent.'
        : sent.length ? 'Sent on ' + sent.join(' + ') + ', but ' + failed.join(' and ') + ' did not go through — the store can still see it in their log.'
        : failed.length ? 'The channel on file is there but did not answer (' + failed.join(', ') + '). Nothing was delivered.'
        : 'This store has no webhook or email on file, so there is no channel to it. That is a gap in the merchant setup, not an outage.',
    });
  }
  if (act === 'link') {
    // An error rather than a synonym: this lever used to hand out a login link, and
    // quietly *resetting a merchant's PIN* under the same name would be a destructive
    // surprise for any script still calling it.
    return json({ ok: false, error: 'Link sign-in was retired in 0.6.0. Use action “reset_pin”: it gives you a new PIN to read out, and signs out every device that had the old one.' }, 410);
  }
  if (act === 'reset_pin') {
    const pin = genPin();
    st.pin = await pinRecord(pin);
    st.auth_gen = Date.now().toString(36);          // every session it had is dead from now on
    delete st.pending;
    await rotateRenewLink(env, st);
    await writeStore(env, st);
    await pinClear(env, handle); await authClear(env, handle);
    await pushOpsLog(env, { act: 'reset_pin', handle, note: 'PIN reset; all sessions signed out', ip: ipOf(req) });   // best-effort
    await pushAudit(env, st, { act: 'pin_reset', via: 'ops', fields: ['pin', 'auth_gen'], ip: ipOf(req) });
    return json({ ok: true, handle, key: handle, pin,
      note: 'Read the PIN out once; after that it exists nowhere but in their phone. They can change it themselves inside the dashboard.' });
  }

  // An operator fixing a price or a sold-out tick must not be able to say anything the merchant
  // cannot say about their own shop, so this lever does not have its own edit path: the payload
  // goes through the merchant's sanitizer, the store's own merge, the same image sweep, and the
  // merchant's own change log — with `via: 'ops'` on the line, so the shop can see who did it.
  // `undo` is deliberately the merchant's Revert: they get the last word on their own menu.
  if (act === 'menu' || act === 'menu_revert') {
    if (act === 'menu_revert' || b.revert) {
      const had = st.menu ? Object.keys(st.menu.over || {}).length + (st.menu.hide || []).length + (st.menu.extra || []).length : 0;
      if (!had) return json({ ok: true, handle, action: 'menu_revert', edits: 0, note: 'Nothing was overridden here, so there was nothing to revert.' });
      const refsBefore = referencedImages(st);
      delete st.menu;
      await writeStore(env, st);
      await pruneImages(env, st, refsBefore);
      await pushOpsLog(env, { act: 'menu_revert', handle, note: had + ' override(s) cleared back to the sheet', ip: ipOf(req) });
      await pushAudit(env, st, { act: 'menu', via: 'ops', fields: ['revert'], before: { edits: had }, after: { edits: 0 }, ip: ipOf(req) });
      return json({ ok: true, handle, action: 'menu_revert', edits: 0,
        note: 'The store’s menu is back to the sheet. The merchant sees this in their own change log as an operator action.' });
    }
    if (!b.menu || typeof b.menu !== 'object') {
      return json({ ok: false, error: 'menu_payload_required',
        note: 'Send {action:"menu", menu:{over:{id:{price:8}}}} — one row per key, and anything you leave out stays as it is; {hide:[], extra:[], order:[], note:""} are replaced only when you send them. Action "menu_revert" drops every override at once.' }, 422);
    }
    const was = st.menu || {};
    const refsBefore = referencedImages(st);
    // Patch, not replace. An operator phoning in one price must not have to resend the shelf, and
    // anything they leave out has to survive: `sanitizeMenu` on its own would drop the merchant's
    // own rows the moment a payload named only one of them. `{ id: false }` is still how a single
    // override is lifted, and `menu_revert` is still how all of them are.
    const next = mergeMenuPatch(st.menu, b.menu, handle);
    const touched = Object.keys(next.over).length + next.hide.length + next.extra.length + (next.order.length ? 1 : 0);
    const stripAt = (m) => { const x = Object.assign({}, m || {}); delete x.set_at; return JSON.stringify(x); };
    const keysOf = (m) => Object.keys((m && m.over) || {});
    const changedRows = keysOf(next).filter((k) => JSON.stringify((st.menu && st.menu.over || {})[k]) !== JSON.stringify(next.over[k])).length;
    if (!Object.keys(b.menu).length || stripAt(next) === stripAt(st.menu)) {
      // Nothing named is nothing changed, and that is a successful no-op rather than a refusal —
      // which is what patch semantics buy: a payload that forgets a row cannot destroy it, so there
      // is nothing to be afraid of and nothing worth writing. No write, no log line, no churn.
      return json({ ok: true, handle, action: 'menu', changed: false, edits: touched,
        note: Object.keys(b.menu).length
          ? 'Already exactly as sent — nothing changed, so nothing was written and no log line was made.'
          : 'That payload named no field, so nothing was changed. Send {over:{id:{price:8}}} to fix one row; a row sent as {id:false} loses its override; "menu_revert" drops the whole layer.' });
    }
    st.menu = next;
    await writeStore(env, st);
    await pruneImages(env, st, refsBefore);
    const eff = await loadProducts(st, env);
    await pushOpsLog(env, { act: 'menu', handle, note: touched + ' override(s), ' + eff.length + ' rows live', ip: ipOf(req) });
    const logged = await pushAudit(env, st, { act: 'menu', via: 'ops', fields: Object.keys(next.over).slice(0, 20),
      before: { edits: Object.keys(was.over || {}).length + (was.hide || []).length + (was.extra || []).length }, after: { edits: touched }, ip: ipOf(req) });
    return json({ ok: true, handle, action: 'menu', changed: true,
    // `edits` is the store's whole override layer (the same figure the merchant's own save
    // reports); `changed_rows` is what this one patch moved. An operator script that assumed the
    // second number was the first would think a one-row fix had rewritten the shelf.
    edits: touched, changed_rows: changedRows, items: eff.length, logged,
      note: 'Live for buyers on their next load. Nothing in the sheet was touched, and the merchant can Revert everything in Shop → Edit items here — which is the right way to undo this too.' });
  }

  const before = { plan: st.plan, paid_until: st.paid_until, suspended: !!st.suspended };
  let done = act;
  if (act === 'suspend') st.suspended = true;
  else if (act === 'reinstate') { st.suspended = false; st.warned_at = null; await env.STORES.delete('term:' + handle); }
  else if (act === 'extend7') st.paid_until = Math.max(Date.now(), st.paid_until || 0) + 7 * 864e5;
  else if (act === 'extend30') st.paid_until = Math.max(Date.now(), st.paid_until || 0) + 30 * 864e5;
  else if (act === 'grant_year') { st.paid_until = Math.max(Date.now(), st.paid_until || 0) + 365 * 864e5; st.plan = 'annual'; st.suspended = false; }
  else if (act === 'reset_free') { st.paid_until = Date.now() + FREE_DAYS * 864e5; st.plan = 'free60'; st.suspended = false; }
  else if (act === 'clear_pending') { delete st.pending; done = 'reverted a queued settings change'; }
  else if (act === 'clear_refs') { await env.STORES.delete('ref:' + handle); delete st.pending_ref_note; done = 'cleared the payment references the merchant filed'; }
  else if (act === 'revoke') { st.auth_gen = Date.now().toString(36); st.admin_token = randomKey(16); delete st.pending; await rotateRenewLink(env, st); done = 'revoked every link, key and cookie, including the renew link'; }
  else return json({ ok: false, error: 'unknown action', actions: ['suspend', 'reinstate', 'extend7', 'extend30', 'grant_year', 'reset_free', 'clear_pending', 'clear_refs', 'revoke', 'notify', 'reset_pin', 'menu', 'menu_revert'] }, 422);

  await writeStore(env, st);
  const after = { plan: st.plan, paid_until: st.paid_until, suspended: !!st.suspended };
  const loggedOps = await pushOpsLog(env, { act, handle, note: JSON.stringify(after), ip: ipOf(req) });
  const loggedStore = await pushAudit(env, st, { act: 'operator:' + act, via: 'ops', fields: Object.keys(after), before: opsMaskTerm(before), after: opsMaskTerm(after) });
  return json({
    ok: true, handle, action: done, before, after, logged: loggedOps && loggedStore,
    undo: act === 'reinstate' ? 'suspend' : 'reinstate',
    note: loggedStore ? 'Logged in this store’s change log too, so the merchant can see that it was us, not them.'
      : 'The change is applied. Its log line could not be written (storage write budget for today), so the merchant will not see a note about it until tomorrow.',
  });
}

function opsMaskTerm(o) { return { plan: o.plan, suspended: o.suspended, paid_until: o.paid_until ? new Date(o.paid_until).toISOString().slice(0, 10) : null }; }


/** Everything the operator might need to see about one store, and nothing that
 *  would let a console session become a credential: no `admin_token`, no PIN hash,
 *  no salt. A PIN is reset deliberately (action `reset_pin`), never read out. */
/**
 * The rail catalogue, editable. `built_in` is what ships in code; the editor
 * holds only the additions, so a mistake here can always be emptied back to the
 * tariffs that were verified, and nothing a merchant is quoted can silently
 * disappear mid-order (orders snapshot their own rail at placement).
 */
async function opsRailsRead(env) {
  const extra = (await env.STORES.get('rails:extra', 'json')) || {};
  return json({
    ok: true, added: extra, built_in: RAILS, live: await railsCatalog(env),
    price_usd: PRICE_USD, free_days: FREE_DAYS,
  }, 200, { 'Cache-Control': 'no-store' });
}
async function opsRailsWrite(req, env) {
  const b = await readBody(req);
  if ((reqHeader(req, 'x-tapstall-confirm') || '') !== '1') return json({ ok: false, error: 'missing x-tapstall-confirm header' }, 403);
  if (b.restore) {
    const prev = (await env.STORES.get('rails:extra', 'json')) || {};
    if (Object.keys(prev).length) {
      const listed = await env.STORES.list({ prefix: 'store:', limit: 1000 });
      const still = [];
      for (const kk of (listed.keys || [])) {
        const h = String(kk.name).slice('store:'.length);
        const doc = await getStore(env, h);
        if (doc && prev[doc.rail]) still.push(h + ':' + doc.rail);
      }
      if (still.length) return json({ ok: false, error: 'cannot restore while an added rail is in use', used_by: still,
        note: 'Switch those stores to a built-in rail first.' }, 422);
    }
    await env.STORES.delete('rails:extra');
    await pushOpsLog(env, { act: 'rails-restore', handle: 'rails', note: 'removed every added rail, back to the built-in tariffs', ip: ipOf(req) });
    return json({ ok: true, restored: 'built-in tariffs only', live: await railsCatalog(env) });
  }
  const input = b.rails && typeof b.rails === 'object' ? b.rails : null;
  if (!input) return json({ ok: false, error: 'send { rails: { key: { label, dial, pct, fixed, type } } }' }, 422);
  const out = {}, bad = {};
  for (const k of Object.keys(input)) {
    const key = String(k).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
    const r = normaliseRail(input[k], key);
    if (!key) bad[k] = 'key: lowercase letters, digits, dash';
    else if (RAILS[key]) bad[k] = 'that key is a built-in tariff and cannot be overridden here — change core.js if the published rate moved';
    else if (!r) bad[k] = 'needs a label of at least 2 characters';
    else out[key] = r;
  }
  if (Object.keys(bad).length) return json({ ok: false, error: 'some rails need a different format', rails: bad }, 422);
  const was = await env.STORES.get('rails:extra', 'json');
  // removing a rail a store is still using would silently reprice that store as
  // cash — no fee, no dial string, buyers told to pay on delivery. Refuse, and
  // name the shops, so the fix is obvious instead of discovered by a merchant.
  const removed = Object.keys(was || {}).filter((k) => !(k in out));
  if (removed.length) {
    const inUse = {};
    const listed = await env.STORES.list({ prefix: 'store:', limit: 1000 });
    for (const kk of (listed.keys || [])) {
      const h = String(kk.name).slice('store:'.length);
      const doc = await getStore(env, h);
      if (doc && removed.indexOf(doc.rail) >= 0) (inUse[doc.rail] = inUse[doc.rail] || []).push(h);
    }
    if (Object.keys(inUse).length) {
      return json({ ok: false, error: 'a rail in use cannot be removed', rails: Object.keys(inUse).reduce((a, k) => { a[k] = inUse[k].length + ' store(s): ' + inUse[k].join(', '); return a; }, {}),
        note: 'Move those stores to another rail first, or leave the rail in place.' }, 422);
    }
  }
  await env.STORES.put('rails:extra', JSON.stringify(out));
  await pushOpsLog(env, { act: 'rails', handle: 'rails', note: (Object.keys(was || {}).length) + ' -> ' + Object.keys(out).length + ' added rails: ' + Object.keys(out).join(','), ip: ipOf(req) });
  return json({ ok: true, added: Object.keys(out), live: await railsCatalog(env),
    note: 'Live at once for new stores and new orders. Orders already placed keep the rail printed on their slip.' });
}

async function opsStoreDetail(url, env) {
  const handle = slug(url.searchParams.get('handle') || '');
  const st = await getStore(env, handle);
  if (!st) return json({ ok: false, error: 'no store' }, 404);
  const rows = (await env.ORDERS.get('list:' + handle, 'json')) || [];
  const orders = [];
  for (const r of rows.slice(0, 15)) { const o = await env.ORDERS.get('order:' + handle + ':' + r.id, 'json'); if (o) orders.push(opsOrderLite(o)); }
  return json({
    ok: true,
    summary: Object.assign(opsSummarise(st, rows), { awaiting_reference: await opsRefs(env, handle) }),
    store: adminStore(st),
    feed_url: st.feed_url, renew_url: st.renew_url,
    editable: EDITABLE_FIELDS,
    orders,
    audit: await getAudit(env, handle),
    queued: st.pending ? { keys: Object.keys(st.pending.fields), apply_at: st.pending.apply_at, in_ms: Math.max(0, st.pending.apply_at - Date.now()), fields: st.pending.fields } : null,
  }, 200, { 'Cache-Control': 'no-store' });
}
/* A row that owes the shop a payment code carries the words to ask for it, written by
 * the same function the slip came from. Read-time on purpose: the sentence depends on
 * the rail as frozen on the order, and a merchant who renames what they call it should
 * not have to wait for a re-price to get the new wording.
 *
 * And the sentence ends at a door, because "send it here" was a promise this platform
 * could not keep. The merchant's two taps — *WhatsApp buyer* and *Copy slip* — both
 * append `ask`, so minting the link here is the whole of making the chase actionable.
 * It is minted fresh on every read and stored nowhere, which is also how a buyer who
 * closed the receipt gets the door back: they do not need the old link, they need the
 * next message. */
async function withAsk(o, st, origin, env) {
  if (!o) return o;
  if (!origin || !proofOpen(o)) {
    const bare = proofAsk(o);
    return bare ? { ...o, ask: bare } : o;
  }
  // `n` only when the reader has a nonce to offer: an unbound cap is honoured (it is how
  // orders placed before this release keep working), but a bound one is worth one write
  const cap = await issueCap(env.ADMIN_SECRET || 'dev-secret',
    { a: 'proof', h: st.handle, id: o.id, g: String(st.auth_gen || '0'), ...(o.pcap ? { n: o.pcap } : {}) },
    PROOF_WINDOW_SEC);
  const here = origin + '/p/' + cap;
  const a = proofAsk(o, { here });
  return a ? { ...o, ask: a, proof_url: here } : o;
}

/* ------------------------------------------------------------------------------------
 * the shop's own half of the same field
 *
 * The buyer's door closes when the order is settled, and the refusal text sends people
 * to the chat — so a code that arrives in the chat has to be able to land somewhere,
 * or the honest answer is "your record is now wrong forever". Hence the shop can file
 * what it was sent, on its own authority, with no capability in sight: `identify`
 * only. Which is why this is `/api/order/proof` and not a wider `/api/mark` — a link
 * that a phone can fetch must never gain a second field to write, and this handler
 * cannot be reached by one. It also has no budget and no closing hour, because both
 * exist to bound a stranger, not the owner of the ledger.
 * ---------------------------------------------------------------------------------- */
async function proofFile(req, url, env) {
  const b = await readBody(req);
  const who = await identify(req, env, slug(String(b.handle || url.searchParams.get('handle') || '')));
  if (!who || !who.st) return json({ ok: false, error: 'no store' }, 404);
  const lr = lockRes(who); if (lr) return lr;
  if (who.anonymous) return json({ ok: false, error: 'not signed in', need_login: true }, 401);
  if (who.bad) { await authFail(env, who.st.handle); return json({ ok: false, error: 'bad key or revoked session' }, 403); }
  const st = who.st;
  const key = `order:${st.handle}:${String(b.id || '')}`;
  const o = await env.ORDERS.get(key, 'json');
  if (!o) return json({ ok: false, error: 'no such order' }, 404);
  // Handed back, not filed. `void` is not a buyer's word and cannot become one: the public
  // door builds its input from `proof` and `payer` alone and calls `proofAccept`, which only
  // ever writes; nothing but a signed-in shop can reach this branch, and it clears rather than
  // sets, so the power it adds is the power the ledger row already has.
  const VOID_ON = [true, 1, '1', 'true'];
  // One list, read strictly, and it has to hold every shape a client naturally has. The
  // dashboard's button sends the number 1 while this line knew only `true`, '1' and 'true'
  // — so for a release "Hand it back" was answered "Nothing to file", every merchant press
  // did nothing, and the suite stayed green because every test sent the one spelling the
  // button does not. A truthy word read as a blank box is the bug; the page is fine.
  if (VOID_ON.includes(b.void)) {
    const v = proofVoid(o);
    if (!v.changed) return json({ ok: true, changed: false, void: false, code: o.code, proof: '', note: v.msg });
    const when = new Date().toISOString();
    o.buyer = Object.assign({}, o.buyer || {}, { proof: '', payer: '' });
    o.proof_writes = 0; o.proof_at = ''; o.proof_by = ''; o.proof_void_at = when;
    // a field sent back is a new chain, so the nonce turns over with it: every link minted for
    // the code just cleared is dead, spent or not, and `withAsk` mints the next one from here
    o.pcap = randomKey(8);
    await env.ORDERS.put(key, JSON.stringify(o));
    await mirrorRow(env, st.handle, o.id, {
      payer: '', proof: '', proof_by: '', proof_at: '', pcap: o.pcap,
    });
    const logged = await pushAudit(env, st, { act: 'proof', via: 'merchant',
      fields: [`${o.code || o.id} ↩ ${v.cleared.join(' · ')} cleared, field handed back`], ip: ipOf(req) });
    return json({ ok: true, changed: true, void: true, code: o.code, proof: '', status: o.status, logged,
      ask: proofOpen(o), note: v.msg + (proofOpen(o)
        ? ' The order will ask them for it again, wherever your chase goes.'
        : ' This order is ' + o.status + ', so nothing is being asked of them — file whatever they send you.') });
  }
  const r = proofAccept(o, { proof: b.proof == null ? null : String(b.proof), payer: b.payer == null ? null : String(b.payer) }, 'merchant');
  if (!r.ok) return json({ ok: false, error: r.msg }, r.why === 'empty' ? 422 : 400);
  if (!r.changed) return json({ ok: true, changed: false, code: o.code, proof: r.proof, status: o.status, note: 'That is what the order already says.' });
  const when = new Date().toISOString();
  o.buyer = Object.assign({}, o.buyer || {}, { proof: r.proof, payer: r.payer });
  o.proof_at = when; o.proof_by = 'merchant';
  // and the buyer's link is spent by this write as much as by theirs: one link, one write,
  // whichever hand held it. A code that arrived in the chat should not leave a live field
  // open on the order for the next 72 hours.
  o.pcap = randomKey(8);
  await env.ORDERS.put(key, JSON.stringify(o));
  await mirrorRow(env, st.handle, o.id, {
    payer: o.buyer.payer, proof: o.buyer.proof, proof_by: 'merchant', proof_at: when, pcap: o.pcap,
  });
  // the response says whether the log held, in the same words a mark uses: a gap in
  // the paper trail is not a failed tap, and the merchant must not retype to be sure
  const logged = await pushAudit(env, st, { act: 'proof', via: 'merchant',
    fields: [`${o.code || o.id} ← ${[o.buyer.proof, o.buyer.payer].filter(Boolean).join(' · ')}`], ip: ipOf(req) });
  return json({ ok: true, changed: true, code: o.code, proof: o.buyer.proof, status: o.status, logged,
    note: 'Filed on ' + (o.code || 'the order') + (o.status === 'paid' ? ' — the money was already counted, so nothing else moved.' : '.') });
}

function opsOrderLite(o) {
  return {
    id: o.id, code: o.code, at: o.at, status: o.status, service: o.service,
    total: o.pricing && o.pricing.total, pay_now: o.pricing && o.pricing.pay_now,
    currency: o.pricing && o.pricing.currency, rail: o.pricing && o.pricing.rail && o.pricing.rail.label,
    buyer: o.buyer ? { name: o.buyer.name, phone: o.buyer.phone } : null,
    proof: (o.buyer && o.buyer.proof) || '', payer: (o.buyer && o.buyer.payer) || '',
    proof_wanted: (o.pricing && o.pricing.rail && o.pricing.rail.proof) || '',
    items: (o.items || []).length, flags: o.risk_flags || [], marked_at: o.marked_at || null,
    pay_account: o.pay && o.pay.account, reference: o.pay && o.pay.reference,
  };
}

const REPO_RAW = 'https://raw.githubusercontent.com/king-kunta-cpu/tapstall/main/';

async function opsTemplates(env) {
  const out = [];
  for (const name of OPS_TPL_NAMES) {
    const v = await env.STORES.get('tpl:' + name);
    out.push({ name, bytes: v ? v.length : 0, live: !!(v && v.length > 200), sha: v ? (await hash(name + ':' + v.length + ':' + v.slice(0, 64))).slice(0, 8) : null });
  }
  return json({ ok: true, templates: out }, 200, { 'Cache-Control': 'no-store' });
}
async function opsTemplateRead(url, env) {
  const name = safeTplName(url.searchParams.get('name'));
  if (!name) return json({ ok: false, error: 'bad template name' }, 422);
  const v = await env.STORES.get('tpl:' + name);
  return json({ ok: true, name, bytes: v ? v.length : 0, html: v || '' }, 200, { 'Cache-Control': 'no-store' });
}
function safeTplName(n) { const x = String(n || ''); return OPS_TPL_NAMES.indexOf(x) >= 0 ? x : null; }
async function opsTemplateWrite(req, env) {
  const b = await readBody(req);
  if ((reqHeader(req, 'x-tapstall-confirm') || '') !== '1') return json({ ok: false, error: 'missing x-tapstall-confirm header' }, 403);
  const name = safeTplName(b.name);
  if (!name) return json({ ok: false, error: 'not a template this console may write', allowed: OPS_TPL_NAMES }, 422);
  const html = String(b.html || '');
  if (html.length < 200) return json({ ok: false, error: 'refusing to publish a page shorter than 200 bytes' }, 422);
  if (!/^<!doctype html>/i.test(html.trim().slice(0, 40))) return json({ ok: false, error: 'must start with <!doctype html>' }, 422);
  if (/<script[^>]+src\s*=\s*["']?http/i.test(html)) return json({ ok: false, error: 'no remote scripts: these pages are single-file by design' }, 422);
  const key = name === 'sample-menu' ? 'tpl:sample-menu' : 'tpl:' + name;
  const was = await env.STORES.get(key);
  if (b.restore) {
    // the committed copy is the safety net: a hand-edit that goes wrong in the
    // console is one press from being undone, with nothing to redeploy
    const raw = await fetch(REPO_RAW + (name === 'sample-menu' ? 'pages/sample-menu.csv' : 'pages/' + name + '.html'),
      { headers: { 'user-agent': 'tapstall/1 (template restore)' } });
    if (!raw.ok) return json({ ok: false, error: 'could not read the committed copy (HTTP ' + raw.status + ')' }, 502);
    const text = await raw.text();
    if (text.length < 200) return json({ ok: false, error: 'committed copy looks truncated; refusing to publish it' }, 502);
    await env.STORES.put(key, text);
    await pushOpsLog(env, { act: 'template-restore', handle: name, note: (was ? was.length : 0) + ' -> ' + text.length + ' bytes from main', ip: ipOf(req) });
    return json({ ok: true, restored: name, bytes: text.length, was: was ? was.length : 0, source: 'git main' });
  }
  await env.STORES.put(key, html);
  const now = await env.STORES.get(key);
  await pushOpsLog(env, { act: 'template', handle: name, note: (was ? was.length : 0) + ' -> ' + now.length + ' bytes', ip: ipOf(req) });
  return json({ ok: true, name, bytes: now.length, was: was ? was.length : 0, matches: now === html, hot: 'no redeploy needed — this is the live copy', note: name === 'sample-menu' ? 'CSV published.' : 'Live for the next request.' });
}

