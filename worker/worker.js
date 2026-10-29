/**
 * Tapstall — zero-touch WhatsApp storefront platform.
 * Cloudflare Worker. Free-tier only (Worker + 2 KV namespaces + cron + assets).
 *
 * Bindings
 *   STORES (KV)  store:{handle} renew:{token} tx:{ref} seq:{h} rl:* buyer:* tpl-ovr:*
 *   ORDERS (KV)  order:{handle}:{id} (ledger row in metadata)  list:{handle} (legacy)
 *   ADMIN_URL_PREFIX      optional; not required
 *   ADMIN_SECRET (secret) signs buyer-fingerprint hashes
 *   CRON                  every 6 hours → paid-term enforcement + renewal notice
 *
 * Pages ride in the Worker bundle; `tpl-ovr:*` is only the emergency override.
 * Quota rule (v1.3.0): memory first, reads second, indexed lists third, and a
 * KV write only for a fact that must survive the isolate.
 */

import {
  runDiscovery, discoveryPlan, discoverySummary, TARGET_SEGMENTS, SEGMENT_KEYS,
  DIRECTORY_SITES, searchProvider,
} from './discover.js';
import {
  railCatalogue, railFor, allocateCents, paymentEvent, appendPaymentEvent, hasPaymentEvent,
  settlement, settlementCsv, vettingPlan, refundTransition, retentionUntil,
  collectInvoiceDraft, collectSettlement, verifyWebhook, payDocKey, PAY_EVENTS, COLLECT_PROVIDERS,
} from './rail.js';
import {
  mailSend, mailDeliver, mailDrain, mailArmed, mailLanes, mailStatus, mailResume, mailRoom, mxOk,
} from './mail.js';
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
  meshAutoPlan, meshGrant, meshGrowth, meshIsPitch, meshValueBeats, meshSchedule, meshFirstTouch,
  MESH_AUTONOMY, MESH_AUTONOMY_V3, MESH_CHANNELS, MESH_OUTREACH, meshAccount, meshOutreachPlan,
  meshQueueItem, meshQueueMerge, meshPress, meshPressFlush, MESH_QUEUE_DEFAULTS, MESH_BUFFER_CHANNEL,
  meshRegister, meshCompanyIdentities, meshCompanyBeats, meshPressLedger, MESH_ID_CLASSES, MESH_ID_RAIL_DEFAULTS,
  meshIdentityPlan, contentPostedPrune, contentFingerprint, contentPosted, contentPostKey,
  contentSlotDue, contentSlotMissed, meshQueueExpire,
  cleanSellerCode, allocateSeller, cleanLead, leadJunkReason, leadEmailFor, leadPhoneOk, leadTransition, sellerBoard, commissionFor, SELLER_DEFAULT_PCT,
  whopEventKind, whopBuyer, whopMoney, whopTerm, SUBSCRIPTION_PLANS,
  MESH_PUBLISH, MESH_BUFFER_FREE, MESH_DRIP, meshRailsTotal, meshRailHealth, meshDrip,
  MESH_RAILS, MESH_BUDGET,
  orderRow, packRow, unpackRow, mergeRows, MAX_ORDERS_KEPT,   // the ledger row, and the cap on it
  isPlaceholderFeed, isTronAddr, cryptoMatch, toUnits, fromUnits, railAcctOf,
  EDITABLE_FIELDS, SOFT_FIELDS, sign, adminStore, normaliseRail, resolveRail,
  STOREFRONT_TEMPLATES, storefrontDesign,
  QUOTA_LIMITS, quotaAllows, quotaPriorityForKey, storeMeta, storeMetaAction, suspendDecision, SUSPEND_GRACE_DAYS, emailHash,
  genPin, pinRecord, pinOk, pinMiss, validPin, PIN_NORMALIZE, PIN_ITER,
} from './core.js';

const VERSION = '2.2.1';
const FREE_DAYS = 60;
const PRICE_USD = 60;
// MAX_ORDERS_KEPT lives in core.js beside the row itself, so a cap and a row cannot drift apart.
const RL = { windowSec: 60, max: 8 };
const PRESS_CRON = '5,25,45 * * * *';   // 20-minute press flush; the 6-hourly sweep is the other trigger

/* ------------------------------------------------------ quota-first runtime
 * The cheapest KV operation is the one this isolate already knows the answer
 * to. These caches are deliberately small, short-lived and clone-on-read:
 * Cloudflare KV is itself eventually consistent for about a minute, so a
 * 15–60 second isolate cache does not invent a new consistency model — it
 * simply stops paying a billed KV read for the same answer inside the window
 * KV was already allowed to be stale. Every mutation that goes through a
 * central helper below updates or invalidates the cache in the same breath.
 *
 * The write governor is the other half. It cannot know the account-global
 * counter without spending the thing it is guarding, so it does the honest
 * local version: this isolate counts the governed writes it makes, core's
 * reserve ladder decides whether automation may spend another one, and the
 * external quota script reads Cloudflare's GraphQL truth with zero KV ops.
 */
const memCache = new Map();              // key -> { at, ttl, value }
const MEM_CACHE_MAX = 256;
function cloneVal(v) {
  if (v == null || typeof v !== 'object') return v;
  try { return structuredClone(v); } catch (e) { return JSON.parse(JSON.stringify(v)); }
}
function memGet(key) {
  const hit = memCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > hit.ttl) { memCache.delete(key); return undefined; }
  // refresh LRU order without extending the TTL: hot is not the same as fresh
  memCache.delete(key); memCache.set(key, hit);
  return cloneVal(hit.value);
}
function memSet(key, value, ttlMs) {
  if (memCache.size >= MEM_CACHE_MAX) {
    for (const k of memCache.keys()) { memCache.delete(k); if (memCache.size < MEM_CACHE_MAX - 16) break; }
  }
  memCache.set(key, { at: Date.now(), ttl: Math.max(250, Number(ttlMs) || 30000), value: cloneVal(value) });
  return value;
}
function memDel(key) { memCache.delete(key); }
function memDelPrefix(prefix) { for (const k of memCache.keys()) if (k.startsWith(prefix)) memCache.delete(k); }
async function cached(key, ttlMs, loader) {
  const hit = memGet(key);
  if (hit !== undefined) return hit;
  const value = await loader();
  memSet(key, value, ttlMs);
  return cloneVal(value);
}

const quotaMem = { day: '', reads: 0, writes: 0, deletes: 0, lists: 0, blocked: 0, by_priority: {} };
function quotaToday(now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (quotaMem.day !== day) Object.assign(quotaMem, { day, reads: 0, writes: 0, deletes: 0, lists: 0, blocked: 0, by_priority: {} });
  return quotaMem;
}
function quotaNote(op, priority = 'operator', n = 1) {
  const q = quotaToday();
  if (op in q) q[op] += n;
  if (op === 'writes' || op === 'deletes') q.by_priority[priority] = (q.by_priority[priority] || 0) + n;
}
function quotaGate(op = 'writes', priority = 'automation', cost = 1) {
  const q = quotaToday();
  const limit = op === 'deletes' ? QUOTA_LIMITS.kv_deletes : op === 'lists' ? QUOTA_LIMITS.kv_lists : QUOTA_LIMITS.kv_writes;
  const d = quotaAllows({ used: q[op] || 0, limit, priority, cost, now: Date.now() });
  if (!d.ok) q.blocked++;
  return d;
}
function quotaLocal() {
  const q = quotaToday();
  return { day: q.day, reads: q.reads, writes: q.writes, deletes: q.deletes, lists: q.lists,
    blocked_optional: q.blocked, by_priority: { ...q.by_priority }, limits: QUOTA_LIMITS,
    note: 'isolate-local governed counters; Cloudflare GraphQL via scripts/quota.sh is the account truth' };
}
async function governedPut(ns, key, value, opts, priority) {
  if (!ns) return false;
  const pri = priority || quotaPriorityForKey(key);
  if (!quotaGate('writes', pri).ok) return false;
  await ns.put(key, value, opts);
  quotaNote('writes', pri);
  return true;
}
async function governedDelete(ns, key, priority) {
  if (!ns) return false;
  const pri = priority || quotaPriorityForKey(key);
  if (!quotaGate('deletes', pri).ok) return false;
  await ns.delete(key);
  quotaNote('deletes', pri);
  return true;
}

/* ---- Tapstall is the only spelling this Worker speaks ----------------------
   One cookie name, one header name, one template marker, one Worker. The retired
   brand's spellings are not read, not emitted and not migrated: clients and tools
   use `tp_*`, `x-tapstall-*` and TAPSTALL template markers, or they are not talking to
   this platform. */
function reqHeader(req, name) { return req.headers.get(name); }
function cookieVals(req, name) {
  // A browser can legitimately send two cookies with this name (an old one
  // from a different path/host variant beside the fresh one), and it decides
  // the order. Reading only the first made a correct sign-in answer
  // "unauthorised" whenever the stale/empty copy won the race — so every
  // candidate is collected and the auth doors try each signed one.
  const raw = req.headers.get('cookie') || '';
  const out = [];
  for (const part of raw.split(';')) {
    const t = part.trim();
    if (!t.startsWith(name + '=')) continue;
    try {
      const v = decodeURIComponent(t.slice(name.length + 1));
      if (v && !out.includes(v)) out.push(v);
    } catch (e) { /* a malformed copy cannot veto a good one */ }
  }
  return out;
}
function cookieVal(req, name) { return cookieVals(req, name)[0] || ''; }
function killCookies(names) {
  return names.map((n) => n + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure');
}
function fillPage(html, pairs) {
  let out = String(html || '');
  for (const [marker, value] of pairs) out = out.replace('/*__' + marker + '__*/null', JSON.stringify(value));
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
    // Plain HTTP is served by the edge too, and a shop link that answers on
    // http:// is a shop link a browser will one day label "not secure". Redirect
    // before any routing so no surface — page, API, or webhook — can be reached
    // unencrypted. HSTS (below) then stops the browser trying http:// at all.
    if (url.protocol === 'http:') {
      url.protocol = 'https:';
      return new Response(null, { status: 301, headers: { Location: url.toString() } });
    }
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
    // Two clocks, two jobs: the 6-hourly sweep owns terms/dispatch/digest;
    // the hourly tick exists only to flush due press items near their grid
    // time (a direct rail sends when a tick sees it due, unlike Buffer,
    // which schedules the draft itself). Press-only costs a handful of
    // reads an hour and no store list at all.
    if (event && event.cron === PRESS_CRON) { ctx.waitUntil(tick(env)); return; }
    ctx.waitUntil(runCron(env));
  },
};

async function route(req, url, env, ctx) {
  // A link that has been through an email client, a Markdown renderer, a chat
  // preview or a copy-paste out of HTML often arrives with `&` written as
  // `&amp;`. That silently renames the *second* parameter: `&token=` becomes
  // `&amp;token=`, so the page loads, sees no credential, and asks you to paste
  // the link you are already holding. Repaired once, here, because every reader
  // of the query is downstream of it.
  if (/(?:&|&#0*38;)(?:amp|#0*38);/i.test(url.search)) url = unescapeQuery(url);
  const p = url.pathname;
  const NOSTORE = { 'Cache-Control': 'no-store' };

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
  if (p === '/partners' || p === '/partners.html') {
    const page = await tpl(env, 'partners');
    return page.startsWith('<!doctype') ? html(page, 200, { 'Cache-Control': 'public, max-age=3600' }) : redirect('/onboard');
  }
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
    const csv = await tpl(env, 'sample-menu');
    if (csv) return new Response(csv, { headers: { 'content-type': 'text/csv', 'cache-control': 'public, max-age=86400' } });
  }

  if (p === '/onboard') return html(await tpl(env, 'onboard'));

  let m;
  // A merchant's own picture, out of the store's KV. Public on purpose: it is a
  // photo of the food, and the storefront is what has to load it fast on a handset.
  if ((m = p.match(/^\/i\/([a-z0-9][a-z0-9-]{1,30})\/([A-Za-z0-9_-]{4,40})$/))) return imageGet(req, env, m[1], m[2]);
  if ((m = p.match(/^\/s\/([a-z0-9][a-z0-9-]{1,30})$/))) return storePage(url, env, m[1]);
  if ((m = p.match(/^\/s\/([a-z0-9][a-z0-9-]{1,30})\/config\.json$/))) {
    const st = await getStore(env, m[1], { cache: true });
    return st ? json({ ok: true, store: publicStore(st, await railsCatalog(env)) }, 200, { 'Cache-Control': 'public, max-age=30, s-maxage=60' })
      : json({ ok: false, error: 'no_store' }, 404, { 'Cache-Control': 'public, max-age=30' });
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
  // v1.8.0: the statement as a page. `/api/settle` is the same arithmetic for a machine; this is
  // the copy a shop prints and hands to its accountant, or photographs and sends to a supplier.
  if ((m = p.match(/^\/s\/([a-z0-9][a-z0-9-]{1,30})\/settle(?:\/|\.html)?$/))) return settlePage(req, url, env, m[1]);
  if ((m = p.match(/^\/s\/([a-z0-9][a-z0-9-]{1,30})\/share\.txt$/))) {
    // The post a merchant would otherwise have to write at 21:00 with one hand. Plain
    // text on purpose: on any phone a text page is select-all then share, and it works
    // with JavaScript off, which the storefront itself cannot claim.
    const st = await getStore(env, m[1], { cache: true });
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
    // and the half that publishes itself: value only, and only because the shop said once that it may
    const mst = env.ORDERS ? await env.ORDERS.get('mesh:' + m[1], 'json').catch(() => null) : null;
    const mf = meshFacts(st, url.origin);
    return json({ ok: true, ...meshJson(st, products, mf, url.origin),
      auto: meshAutoPlan(st, products, mf, { state: mst || {}, now: Date.now() }) },
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
    const st = await getStore(env, m[1], { cache: true });
    if (!st) return json({ ok: false, error: 'no_store' }, 404);
    // Cached by default now, and ?fresh=1 means it: the storefront is the hot path,
     // and a sheet that has not changed in two minutes does not need to be asked
     // again by every buyer. The dashboard's own Re-read button passes fresh=1, so
     // "I just edited the sheet" still answers immediately.
    const fresh = url.searchParams.get('fresh') === '1';
    return json({ ok: true, products: await loadProducts(st, env, fresh) }, 200,
      { 'Cache-Control': fresh ? 'no-store' : 'public, max-age=30, s-maxage=120' });
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
  if (p === '/api/email/verify' && req.method === 'GET') return emailVerify(req, url, env);
  if (p === '/api/whop/claim' && req.method === 'POST') return whopClaim(req, url, env);
  if (p.startsWith('/u/') && (req.method === 'GET' || req.method === 'POST')) return unsubRoute(req, url, env);
  if (p === '/api/settings/cancel' && (req.method === 'GET' || req.method === 'POST')) return cancelByMail(req, url, env);
  if (p === '/api/menu' && req.method === 'POST') return menuEdit(req, env);
  if (p === '/api/crypto/check' && req.method === 'POST') return cryptoCheck(req, env);
  if (p === '/api/image' && req.method === 'POST') return imageUpload(req, env);
  if (p === '/api/revoke' && req.method === 'POST') return revokeKeys(req, url, env);
  // The books and the receipt, on the shop's own authority: no new credential, no new surface for
  // a buyer to meet, and nothing written. A month is a read of the row list; a receipt is a read
  // of one order.
  if (p === '/api/books') return booksView(req, url, env);
  /* v1.7.0, the selling rail: a settlement statement, an event log, vetting, and the
   * cross-border collect leg. Read-only by default; every write needs the same admin gate the
   * dashboard uses, and none of it can move money. */
  if (p === '/api/settle' && req.method === 'GET') return settleView(req, url, env);
  if (p === '/api/settle/event' && req.method === 'POST') return settleEvent(req, url, env);
  if (p === '/api/rail' && req.method === 'GET') return railView(req, url, env);
  if (p === '/api/rail/vet' && req.method === 'POST') return railVet(req, url, env);
  if (p === '/api/collect/invoice' && req.method === 'POST') return collectInvoice(req, url, env);
  if (p === '/api/hook/nowpayments' && req.method === 'POST') return hookNowPayments(req, url, env);
  if (p === '/api/receipt') return receiptView(req, url, env);
  if (p === '/api/mesh') return meshView(req, url, env);
  if (p === '/api/mesh/seen' && req.method === 'POST') return meshSeen(req, env);
  if (p === '/api/mesh/auto' && req.method === 'POST') return meshAuto(req, env);
  if (p === '/api/mesh/press' && req.method === 'POST') return meshPressSet(req, env);
  if (p === '/api/press/accounts' && req.method === 'POST') return pressAccounts(req, env);
  if (p === '/api/press/run' && req.method === 'POST') return pressRun(req, env);
  if (p === '/api/mesh/publish' && req.method === 'POST') return meshPublish(req, env);
  // v1.0.0: sellers — the people who sell Tapstall. A tracked link attributes a shop to the
  // seller whose link brought it, once, at birth; the seller's own view is read-only and carries
  // no buyer data and no shop credentials. Leads are worked by sellers, allocated by hash, and
  // the anti-collision rule lives in core so every door refuses the same way.
  if ((m = p.match(/^\/(r|g)\/([a-z0-9][a-z0-9-]{1,23})$/))) return sellerRedirect(url, env, m[2], m[1]);
  if (p === '/api/seller') return sellerView(url, env);
  if (p === '/api/leads/ingest' && req.method === 'POST') return leadsIngest(req, env);
  /* v1.7.1, the autonomous list: read the state, trigger a pass by hand, and receive a partner
   * application. Discovery itself is a cron job — a human only looks at what it found. */
  if (p === '/api/discover' && req.method === 'GET') return discoverStatus(req, env);
  if (p === '/api/discover/run' && req.method === 'POST') return discoverRun(req, env);
  if (p === '/api/partners/apply' && req.method === 'POST') return partnerApply(req, url, env);
  if (p === '/api/leads' && req.method === 'GET') return leadsListSeller(url, env);
  if (p === '/api/leads/act' && req.method === 'POST') return leadsAct(req, env);
  if (p === '/api/outreach/mailboxes') return outreachMailboxes(req, env);

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
  // v2.0.0: the leads desk replaces the Google Sheet as the place sellers (and the owner) work
  // their queue. A static page: it holds no data until the code + key open /api/leads.
  if (p === '/leads' || p === '/leads/') return html(await tpl(env, 'leads'), 200, { ...NOINDEX, 'Cache-Control': 'no-store' });
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
  // v2.0.0: the mail lane's two levers. `test` sends one transactional message now (it uses a slot
  // of the hourly cap like any other) so the owner can prove the box works; `resume` clears a 6h
  // auth park after the password has been fixed.
  if (p === '/ops/api/mail' && req.method === 'POST') return opsGate(req, env, () => opsMail(req, env));
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
  if (p === '/ops/api/sellers') return opsGate(req, env, () => opsSellers(req, env));
  if (p === '/ops/api/leads') return opsGate(req, env, async () => {
    const leads = await listLeads(env, { limit: 500 });
    const by_status = {};
    for (const l of leads) by_status[l.status] = (by_status[l.status] || 0) + 1;
    return json({ ok: true, leads, by_status, count: leads.length }, 200, NOSTORE);
  });
  if (p === '/ops/api/link') return json({ ok: false, retired: true, error: 'Retired with link sign-in: reset a merchant’s PIN with action “reset_pin” on /ops/api/store.' }, 410);
  if ((m = p.match(/^\/renew\/([A-Za-z0-9_-]{6,40})$/))) return renewPage(env, m[1]);
  if (p === '/api/admin-put' && req.method === 'POST') return adminPut(req, env);

  if (p === '/api/checkout' && req.method === 'POST') return checkout(req, url, env);
  if (p === '/api/renew-ref' && req.method === 'POST') return renewRef(req, env);
  if (p === '/api/hook/whop' && req.method === 'POST') return hookWhop(req, url, env, ctx);
  if (p === '/api/hook/flutterwave' && req.method === 'POST') return hookFlutterwave(req, url, env, ctx);
  if (p === '/api/hook/payfast' && req.method === 'POST') return hookPayfast(req, url, env, ctx);

  return null;
}
/* ------------------------------------------------------------- store page */
async function storePage(url, env, handle) {
  const st = await getStore(env, handle, { cache: true });
  if (!st) return html(notFoundPage(handle), 404, NOINDEX);
  // The term state is already on the store document (`suspended` +
  // `suspended_at`); a second `term:` read on every storefront view bought
  // nothing but another billed KV read and a second write on every suspend.
  const term = st.suspended ? { state: 'expired', at: st.suspended_at || null } : null;
  const page = fillPage(await tpl(env, 'store'),
    [['TAPSTALL_CONFIG', publicStore(st, await railsCatalog(env))], ['TAPSTALL_TERM', term]]);
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
async function getStore(env, handle, opts = {}) {
  if (!env.STORES || !handle) return null;
  const ck = 'store:' + handle;
  // Cache is opt-in for public read paths. Authority, order and admin paths
  // always judge the document KV holds now; a buyer page may reuse a copy
  // for a few seconds (inside KV's own stale window), and never when a
  // pending money change is in flight — its fold is clock-judged fresh.
  let raw = (opts.cache && !opts.fresh) ? memGet(ck) : undefined;
  if (raw && raw.pending) raw = undefined;
  if (raw === undefined) {
    raw = await env.STORES.get(ck, 'json');
    quotaNote('reads', 'operator');
    // Cache the *unfolded* document (and a negative answer, briefly): the
    // pending fold below is a function of the clock, so it is re-judged on
    // every hit, while the billed KV read happens at most once a TTL.
    memSet(ck, raw || null, raw ? 15000 : 5000);
  }
  if (!raw) return null;
  const st = cloneVal(raw);
  if (!st.pending) return st;
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
  if (!env.STORES || !st || !st.handle) return;
  // One write, three jobs: the document, its cron/index metadata row, and the
  // isolate cache entry every hot read will reuse for the next few seconds.
  await env.STORES.put('store:' + st.handle, JSON.stringify(st), { metadata: storeMeta(st) });
  quotaNote('writes', 'money');
  memSet('store:' + st.handle, st, 15000);
  memDelPrefix('ledger:all:');
}

/* --------------------------------------------------------------- products */
/** One-time, and only ever on a shop whose base turns out to be our own sample: lift
 *  whatever the demo feed had cached — with the shop's edits already folded in, so a
 *  price someone corrected yesterday is not "reverted" to the fixture tomorrow — into
 *  the authored list, and mark the promoted rows as starters so the dashboard can say
 *  what they are: "these arrived with the account; edit or delete, they are yours now."
 *  It runs in the read path like the pending-settings fold does, so no migration script
 *  exists to forget, and the cache it clears is what makes it fire exactly once. */
function seedAuthoredFromCache(st) {
  const rows = st.feed_cache && Array.isArray(st.feed_cache.products) ? st.feed_cache.products : [];
  // Fires exactly once: only for a shop that has the sample's rows cached and no menu
  // of its own yet (the cache empties on the way out, and a shop that has typed rows
  // is not being handed duplicates of a fixture it already overrode).
  if (!rows.length || (st.menu && (st.menu.extra || []).length)) return false;
  const eff = applyMenu(rows, st.menu, st.handle);   // the shop's own edits, on the sample's rows
  const promoted = eff.map((p) => ({
    id: String(p.id || '').slice(0, 60), name: p.name, cat: p.cat, price: p.price, cur: p.cur,
    desc: p.desc, img: realPhoto(p) || '', available: p.available !== false, popular: !!p.popular,
    vat_rate: p.vat_rate, opts: p.opts, addons: p.addons, starter: true,
  }));
  // A row the shop had hidden in overlay mode is a row it had deleted in authored mode:
  // the hide list rides into `del` so the intent survives the fold, not the artefact.
  const dead = [...((st.menu && st.menu.hide) || []), ...(((st.menu && st.menu.del) || []).map((x) => (x && typeof x === 'object' ? x.id : x)))];
  const seeded = sanitizeMenu({
    extra: promoted, del: dead,
    note: (st.menu && st.menu.note) || 'starter items — from the sample menu, now yours to change or delete',
  });
  for (const x of seeded.extra) x.starter = true;
  st.feed_cache = { at: Date.now(), products: [], count: 0, error: 'no_feed' };
  st.menu = seeded;
  return true;
}

/**
 * The store's menu: whatever the sheet said, with this store's own dashboard edits
 * laid over it. The cache holds the sheet as fetched — the edits are applied on the
 * way out, never inside the cache — so "Revert this row to my sheet" is a matter of
 * dropping an override, and a sheet that comes back tomorrow still arrives clean.
 *
 * A shop with no sheet — none linked, or the pointer to our own sample that
 * onboarding once offered — has a different base, and v0.9.10 is the honesty of it:
 * there is nothing to overlay, so the authored list IS the menu. `applyMenu` over an
 * empty base is that sentence in code; the one-time `seedAuthoredFromCache` below is
 * the one-time mercy: shops whose "menu" has been the demo CSV all along keep their
 * rows on the switch, as their own, editable and deletable, instead of waking up to
 * an empty shelf. The sample is never fetched again, and `?fresh=1` cannot resurrect
 * it, because the branch runs before anything reads a URL.
 */
async function loadProducts(st, env, force) {
  if (isPlaceholderFeed(st.feed_url)) {
    if (seedAuthoredFromCache(st)) {
      // the seed is worth one write: it turns a fixture into a starting point
      try { await writeStore(env, st); } catch (e) { /* seeded in memory today, again tomorrow */ }
    }
    return applyMenu([], st.menu, st.handle);
  }
  const ms = Math.max(15000, (Number(st.cache_seconds) || 120) * 1000);
  const feedKey = 'feed:' + st.handle + ':' + String(st.feed_url || '');
  if (!force) {
    const hot = memGet(feedKey);
    if (hot && Array.isArray(hot.products)) return applyMenu(hot.products, st.menu, st.handle);
    if (st.feed_cache && st.feed_cache.at && Date.now() - st.feed_cache.at < ms) {
      memSet(feedKey, { products: st.feed_cache.products || [], error: st.feed_cache.error || null }, ms);
      return applyMenu(st.feed_cache.products, st.menu, st.handle);
    }
  }
  let products = [], error = null;
  try {
    const feed = normalizeFeedUrl(st.feed_url);
    if (!feed) error = 'no_feed';
    else {
      const r = await fetch(feed, { headers: { 'User-Agent': 'tapstall/1' }, cf: { cacheTtl: Math.min(300, Math.max(30, Math.round(ms / 1000))) } });
      if (!r.ok) error = 'feed_http_' + r.status;
      else products = parseProducts(await r.text(), st);
    }
  } catch (e) { error = 'feed_fetch_failed'; }
  memSet(feedKey, { products, error }, ms);
  const prev = st.feed_cache || null;
  const nextCache = { at: Date.now(), products, count: products.length, error };
  st.feed_cache = nextCache;
  // The durable snapshot is for SEO, ops health and a cold isolate — not for
  // proving the sheet was asked again. Persist it only when it says something
  // new (rows, count or error changed), when force was explicit, or at most
  // every six hours; the hot copy above serves buyers either way. Before this,
  // one busy shop on the default 120s cache could rewrite its whole store
  // document 720 times a day and spend most of the account's write budget
  // recording that its menu had not changed.
  const changed = !prev || prev.error !== error || Number(prev.count || 0) !== products.length
    || JSON.stringify(prev.products || []) !== JSON.stringify(products);
  const staleSnapshot = !prev || !prev.at || Date.now() - prev.at > 6 * 3600e3;
  if ((changed || force || staleSnapshot) && quotaGate('writes', force ? 'operator' : 'automation').ok) {
    try { await writeStore(env, st); } catch (e) { /* uncached today, correct today */ }
  }
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

  const id = nowId();
  const seq = await nextOrderSeq(env, st.handle);
  const prefix = (st.order_prefix || st.handle.slice(0, 3).toUpperCase()).replace(/[^A-Za-z0-9-]/g, '');
  const code = seq ? prefix + '-' + String(seq).padStart(4, '0')
    : prefix + '-' + id.slice(-6).toUpperCase();
  const buyerHash = await hash(st.handle + '|' + buyer.phone + '|' + (capKey(env)));
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
  const secret = capKey(env);
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
 * One write, and the ledger row is inside it.
 *
 * `persistOrder` used to write the document and then rewrite the shop's whole row array, and the
 * array was where orders went to die: two buyers in the same second, one array read each, the
 * slower write won, and the other order was left a document with no row — invisible in the
 * dashboard, missing from the month's books, unrecoverable because nothing knew it had happened. It
 * also cost three subrequests on the way in and two more on every mark, with a 150 ms×4 wait
 * whenever a list that had just been written had not reached the edge you were standing on.
 *
 * The row is metadata on the document now. KV hands metadata back from `list()` beside the key, so
 * the index is the key space: saving an order *is* indexing it, and there is no second copy to lose
 * a race with. `mirrorRow` and its retry loop are gone — not replaced by something better, made
 * unnecessary, which is why the mark path no longer says "or tries to".
 */
async function saveOrder(env, handle, order) {
  if (!env.ORDERS || !handle || !order || !order.id) return;
  await env.ORDERS.put('order:' + handle + ':' + order.id, JSON.stringify(order),
    { metadata: packRow(orderRow(order)) });
  quotaNote('writes', 'money');
  memDelPrefix('ledger:' + handle + ':');
  memDelPrefix('ledger:all:');
}

async function persistOrder(env, st, order) {
  await saveOrder(env, st && st.handle, order);
}

/**
 * A shop's rows, newest first, out of one `list()` over its own key space.
 *
 * Reads are free at $0 hosting and metadata arrives with the key, so the ledger costs a page of a
 * listing instead of a shared array that every write had to read first. Rows written before the
 * metadata existed have none, and the frozen legacy index supplies them: nothing is migrated, and
 * "half a migration" is not a state this can sit in, because there is no migration to half-finish.
 * A document with neither a row nor an index entry still shows as a thin row, because counting an
 * order a shop took is not the same as pricing one.
 */
async function ledgerRows(env, handle, cap, opts = {}) {
  if (!env.ORDERS || !handle) return [];
  const wanted = Math.max(Number(cap) || MAX_ORDERS_KEPT, 1);
  const ck = 'ledger:' + handle + ':' + wanted;
  if (!opts.fresh) {
    const hit = memGet(ck);
    if (hit !== undefined) return hit;
  }
  const rows = await ledgerRowsFresh(env, handle, wanted);
  memSet(ck, rows, 15000);
  return cloneVal(rows);
}

async function ledgerRowsFresh(env, handle, cap) {
  if (!env.ORDERS || !handle) return [];
  const prefix = 'order:' + handle + ':';
  const wanted = Math.max(Number(cap) || MAX_ORDERS_KEPT, 1);
  const fromDocs = [];
  const bare = [];
  try {
    let cursor, pages = 0;
    do {
      const l = await env.ORDERS.list({ prefix, limit: 1000, cursor });
      quotaNote('lists', 'operator');
      for (const k of l.keys || []) {
        const id = String(k.name || '').slice(prefix.length);
        if (k.metadata) {
          const r = unpackRow(k.metadata);
          if (r.id !== id) r.id = id;                     // the key is the truth about who it is
          fromDocs.push(r);
        } else if (bare.length < wanted) {
          bare.push(id);
        }
      }
      cursor = l.list_complete ? undefined : l.cursor;
    } while (cursor && ++pages < 5 && fromDocs.length + bare.length < wanted);
  } catch (e) { /* an unreadable listing is answered by the index below, not by a guess */ }
  const legacy = (await env.ORDERS.get('list:' + handle, 'json')) || [];
  const have = new Set(fromDocs.map((r) => r.id));
  const filled = [];
  for (const r of legacy) {
    // Only ids the documents could not supply: a row that shed fields to fit its budget must not be
    // shadowed by the fatter copy the old index happens to still hold.
    if (r && r.id && !have.has(r.id)) filled.push({ ...r, legacy: true });
    if (filled.length >= wanted) break;
  }
  const merged = mergeRows(fromDocs, filled, wanted);
  const known = new Set(merged.map((r) => r.id));
  const thin = [];
  for (const id of bare) {
    if (known.has(id)) continue;
    thin.push({ id, code: id.slice(-5).toUpperCase(), at: '', total: 0, status: 'unknown', thin: true });
  }
  return thin.length ? mergeRows(merged, thin, wanted) : merged;
}

/** Every shop's rows from one listing of the order key space, grouped by the
 *  handle in the key. The owner state used to spend one list *per shop* (plus
 *  a legacy read each) to learn what one list already knew; at 1,000 list
 *  operations a day that made the oversight page the quota risk. Shops whose
 *  documents carry no metadata row fall back to the per-shop reader, which is
 *  also where the frozen legacy index lives. */
async function ledgerRowsAll(env, capPerStore = MAX_ORDERS_KEPT) {
  if (!env.ORDERS) return new Map();
  const cap = Math.max(1, Number(capPerStore) || MAX_ORDERS_KEPT);
  return cached('ledger:all:' + cap, 15000, async () => {
    const by = new Map();
    const bare = new Set();
    let cursor, pages = 0;
    try {
      do {
        const l = await env.ORDERS.list({ prefix: 'order:', limit: 1000, cursor });
        quotaNote('lists', 'operator');
        for (const k of l.keys || []) {
          const parts = String(k.name || '').split(':');
          if (parts.length < 3) continue;
          const handle = parts[1], id = parts.slice(2).join(':');
          if (!by.has(handle)) by.set(handle, []);
          if (k.metadata) {
            const r = unpackRow(k.metadata);
            if (r.id !== id) r.id = id;
            by.get(handle).push(r);
          } else bare.add(handle);
        }
        cursor = l.list_complete ? undefined : l.cursor;
      } while (cursor && ++pages < 10);
    } catch (e) { /* the per-shop fallback below is the answer, not a guess */ }
    for (const [h, rows] of by) by.set(h, mergeRows(rows, [], cap));
    for (const h of bare) by.set(h, await ledgerRows(env, h, cap, { fresh: true }));
    return by;
  });
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
        'x-tapstall-body': await sign(capKey(env), body),
        // workers.dev bot rules reject requests without a browser-ish UA, which
        // would silently swallow a merchant's order notification
        'user-agent': 'tapstall/1 (order notification)',
      },
      body,
    }).catch(() => {}));
  }
  if (st.notify_email && mailArmed(env)) {
    // Opt-in new-order alerts; a busy hour on the shared box parks them for the next tick.
    tasks.push(sendMail(env, st.notify_email,
      `New order ${order.code} — ${order.pricing.pay_now} ${st.currency || 'USD'}`,
      notifyText(st, order)
      + `Open this to confirm (it needs your browser, nothing else): ${order.confirm_url || ''}\n`
      + `Dashboard: ${env.PUBLIC_ORIGIN || ''}/a with your store name and PIN\n`).catch(() => false));
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
  const secret = capKey(env);
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
  let logged;
  if (want === 'paid') {
    // the same credit the chain watcher runs — one path from "the money is believed"
    // to "the ledger says paid", whichever hand believed it
    logged = await creditOrder(env, st, o, viaCap ? 'link' : 'session', ipOf(req), '');
  } else {
    o.status = want;
    o.marked_at = new Date().toISOString();
    // one write: the document and the row the dashboard reads are the same object now
    await saveOrder(env, handle, o);   // the ledger keeps pace, or tries to
    logged = await pushAudit(env, st, { act: 'mark', via: viaCap ? 'link' : 'session', fields: [o.code + ' → ' + want], ip: ipOf(req) });
  }
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
  const p = await verifyCap(capKey(env), cap);
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
  const p = b.cap ? await verifyCap(capKey(env), String(b.cap)) : null;
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
    // one write: the document and the row the dashboard reads are the same object now
    await saveOrder(env, st.handle, o);
    await pushAudit(env, st, { act: "proof", via: "buyer",
      fields: [`${o.code || o.id} ← ${[o.buyer.proof, o.buyer.payer].filter(Boolean).join(' · ')}`], ip });
  }
  // the fresh token, minted only for the caller whose write was just accepted: whoever can
  // file once can correct twice more, and does not need a second link to anybody else
  let freshUrl = "";
  if (r.changed) {
    const fresh = await issueCap(capKey(env),
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

/** Onboarding is the one open door that WRITES, and on the free plan every store
 *  shares a single budget of 1,000 KV writes a day: an unbounded `POST /api/register`
 *  is therefore a script that can eat the whole day before noon and leave the trading
 *  merchants unable to record an order. The meter is the platform's own hybrid
 *  limiter — the one `/api/order` uses — because it is the shape that survives the
 *  real topology: memory answers a burst inside one isolate for free, and from half
 *  the ceiling up the shared 'rl:' counter answers across isolates and restarts, so
 *  spreading traffic across colos stops being an invisibility cloak. Three stores an
 *  hour, six a day, per connecting address; `cf-connecting-ip` is Cloudflare's own,
 *  so a flood cannot lie about it. A harness that builds many stores from one
 *  address passes a wide `REG_RL`/`REG_RL_DAY` through env rather than the code
 *  growing a production check; a pilot that onboards five merchants a month will
 *  never meet the default at all. */
const REG_RL = { windowSec: 3600, max: 3 }, REG_RL_DAY = { windowSec: 86400, max: 6 };

async function register(req, url, env) {
  const regIp = ipOf(req);
  if (await rateLimited(env, regIp, 'reg:', env.REG_RL || REG_RL)
    || await rateLimited(env, regIp, 'regday:', env.REG_RL_DAY || REG_RL_DAY)) {
    return json({ ok: false, error: 'too many stores have been created from this network — the shop-creation window opens again later today; if you are setting up for real, come back after it and nothing you typed is lost' },
      429, { 'retry-after': '3600' });
  }
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

  // Seller attribution is a fact about the link the merchant arrived on, judged once, here at
  // birth: a code that names no active seller attributes nothing, and no later edit can move a
  // shop between sellers (a shop's seller is history, not a setting). One read, only when a
  // code arrived at all, so the common door costs what it always cost.
  let sellerCode = cleanSellerCode(b.ref || b.a || b.seller || b.seller_code || '');
  if (sellerCode) {
    const sd = await sellerDoc(env, sellerCode);
    if (!sd || sd.active === false) sellerCode = '';
  }

  const adminKey = randomKey(16);
  const renewToken = alnumToken(14);   // path-safe: base64url -/_ would break the /renew/ route
  const st = {
    handle,
    shop_name: String(b.shop_name).slice(0, 60),
    tagline: String(b.tagline || '').slice(0, 140),
    logo: cleanImg(b.logo, handle),   // a URL at sign-up; there is nothing stored to reference yet
    business_type: STOREFRONT_TEMPLATES[String(b.business_type || '')] ? String(b.business_type) : 'general',
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
    auth_gen: '0',                  // bumpadminKey,          // API key for the merchant's own tooling; never in a URL
    auth_gen: '0',                  // bump to invalidate every link, key and cookie
    paid_until: Date.now() + FREE_DAYS * 864e5,
    plan: 'free60',
    term_days: FREE_DAYS,
    seller_code: sellerCode || undefined,
    seller_at: sellerCode ? new Date().toISOString() : undefined,
  };
  st.renew_url = `${url.origin}/renew/${renewToken}`;
  /* The merchant's whole way in, created here and shown once: a key (their store
     name, already public in the storefront URL) and a six-digit PIN that exists in
     this response and the welcome email and nowhere else. Nothing about signing in
     expires, so nothing about it can go stale in an inbox or be mangled by a mailer. */
  const pin = genPin();
  st.pin = await pinRecord(pin);
  await writeStore(env, st);
  memDelPrefix('listkeys:');
  // `g` because the link must die with the authority that issued it: `made` is what a legacy
  // record is judged by, and a record with neither is the hole the Revoke was meant to close.
  await env.STORES.put('renew:' + renewToken,
    JSON.stringify({ handle, made: Date.now(), g: String(st.auth_gen || '0') }));
  const products = await loadProducts(st, env);          // cache honoured; a menu edit is applied after it, so it shows at once
  const err = st.feed_cache && st.feed_cache.error;
  let verify_sent = false;
  if (st.owner_email) {
    // v2.0.0: the welcome now carries a confirm link (the confirmed address is what a Whop
    // payment may be matched to) and no longer carries the PIN: a PIN in a mailbox outlives
    // the screen it was shown on.
    const vcap = await issueCap(capKey(env), { a: 'everify', h: handle, e: String(st.owner_email).toLowerCase(), g: String(st.auth_gen || '0') }, 14 * 86400);
    verify_sent = await sendMail(env, st.owner_email, `Your ${st.shop_name} store is live — confirm your email`,
      `Store: ${url.origin}/s/${handle}\n`
      + `Sign in at ${url.origin}/a with your store name (${handle}) and the PIN shown when you signed up.\n\n`
      + `Confirm this email address (one tap; it lets us match your payments and send you a reset link if you lose the PIN):\n`
      + `${url.origin}/api/email/verify?cap=${encodeURIComponent(vcap)}\n\n`
      + `${products.length} products loaded. ${err ? 'FEED WARNING: ' + err : ''}\n`
      + `Free until ${new Date(st.paid_until).toDateString()}. Renew (no monthly billing): ${st.renew_url}\n`
      + `Keep that renew link private: with your WhatsApp number it can reset your PIN.\n`);
  }
  return json({
    ok: true, handle,
    ...(st.seller_code ? { seller_code: st.seller_code } : {}),
    store_url: `${url.origin}/s/${handle}`,
    key: handle, pin, renew_url: st.renew_url, verify_sent,
    pin_note: 'Show this PIN to nobody. Change it inside the dashboard any time; if it is lost, “I lost my PIN” on the sign-in screen emails a reset link to your address (or, with no email, takes your WhatsApp number and this renew link) — no operator, no waiting. Keep the renew link private.',
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
      orders_today: (await ledgerRows(env, handle, 400)).length,
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
  const rows = await ledgerRows(env, handle);
  const orders = [];
  for (const r of rows.slice(0, 40)) orders.push(await env.ORDERS.get(`order:${handle}:${r.id}`, 'json'));
  return json({
    ok: true,
    via: who.via,
    // No admin_url here on purpose: a login code inside a JSON body turns any
    // XSS on the dashboard into a saved 7-day credential. The session cookie is
    // HttpOnly, so the page itself cannot read it back.
    store: { ...adminStore(st), feed_url: st.feed_url, renew_url: renewLink(st, url.origin), dashboard_path: '/a',
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
    design: storefrontDesign(st),
    templates: STOREFRONT_TEMPLATES,
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
  let days = clamp(Number(b.days) || 365, 30, 1460);
  let amount = round2(PRICE_USD * (days / 365));
  // The card rail is Whop — that is the owner's standing instruction, and the page must not
  // send a Zimbabwean merchant to an unconfigured gateway slug when the business collects
  // somewhere else. A Whop checkout is a fixed plan, not a days slider: a year ask goes to
  // the annual checkout, a short ask to the monthly one when it exists, and the intent still
  // records the terms THIS Worker chose. The seller's Whop affiliate name rides along as
  // ?a= so Whop settles their 30% — the same preservation the sister stack pins end-to-end.
  const whopAnnual = String(env.WHOP_CHECKOUT_URL_ANNUAL || env.WHOP_CHECKOUT_URL || '');
  const whopMonthly = String(env.WHOP_CHECKOUT_URL_MONTHLY || '');
  const whopPlan = days >= 300 ? { key: 'annual', url: whopAnnual } : (whopMonthly ? { key: 'monthly', url: whopMonthly } : null);
  let whopUrl = '';
  if (whopPlan && whopPlan.url) {
    days = SUBSCRIPTION_PLANS[whopPlan.key].days;
    amount = SUBSCRIPTION_PLANS[whopPlan.key].usd;
    whopUrl = whopPlan.url;
    const code = cleanSellerCode(cSt.seller_code || '');
    if (code) {
      const sd = await sellerDoc(env, code).catch(() => null);
      if (sd && sd.whop) whopUrl += (whopUrl.includes('?') ? '&' : '?') + 'a=' + encodeURIComponent(sd.whop);
    }
  }
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
    provider: whopUrl ? 'whop' : 'flutterwave',
    // Whop first (it is where the card money actually goes); the Flutterwave payment link
    // remains the fallback for a platform that arms it. The shop handle is the thread either
    // way: on Whop it is the checkout's custom field, answered with exactly this handle.
    pay_url: whopUrl || `https://flutterwave.com/pay/${env.FW_PAY_SLUG || 'tapstall'}?tx_ref=${txRef}&amount=${amount}&currency=USD&customer_email=${encodeURIComponent(b.email || '')}&redirect_url=${encodeURIComponent(url.origin + '/api/hook/flutterwave?done=1&tx_ref=' + txRef)}`,
    shop_handle: rec.handle,
    manual_details: String(env.PLATFORM_PAY_DETAILS || ''),
    manual: `Or send ${amount} USD / local equivalent (bank, EcoCash, Mukuru, ZIPIT or USDT) and paste the payment reference below — a card payment on Whop switches the store on by itself; a manual reference is recognised from the owner's exception list.`,
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
  quotaNote('writes', 'money'); memDelPrefix('listkeys:');
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
  await recordSale(env, st, { amount: tx.amount, currency: tx.currency, provider: 'flutterwave', ref: txRef, days: tx.days });
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
  await recordSale(env, st, { amount: tx.amount, currency: tx.currency, provider: 'payfast', ref, days: tx.days });
  return say({ ok: true, activated: st.handle, paid_until: new Date(st.paid_until).toISOString(), days: tx.days });
}

/* ------------------------------------------------------- crypto: watch the till */
/**
 * The crypto rail has two modes, and the order of them is the whole design brief:
 *
 *  manual — the EcoCash path, unchanged in kind: the slip prints an address, the
 *      buyer sends and (optionally) pastes the TxID, a human looks at their wallet
 *      and taps Confirm. Zero cost, zero setup beyond the address itself, available
 *      to every shop the moment this deploys — a watcher that is down, unbilled or
 *      never enabled cannot stall an order.
 *  watcher — the same credit without the tap. Once the shop flips it on, the cron
 *      reads the address's incoming USDT (TRC-20) transfers off TronGrid's public
 *      API and applies the tolerance policy: inside 1% of an open order's exact
 *      amount the order is credited and any shortfall is *flagged, not refused*;
 *      outside it, nothing moves by machine and the row waits for a human. Every
 *      discrepancy goes on a nightly report.
 *
 * There is no provider in the loop, and that is the route, not an omission: a hosted
 * crypto checkout takes a percentage and demands an account, a key, and settlement in
 * a currency the seller does not keep. TronGrid needs none of those — 100,000 free
 * calls a day on the public cluster, one call per watching shop per cron slot at this
 * shop count — and TRC-20 transfers carry no memo field, so the matching key had to be
 * the amount. It already is: `unique_change`'s odd cents make every open total unique
 * at the micro-unit level, which is what `cryptoMatch` reads. USDT on Tron is the
 * asset this method buys; TRX (needs a price feed, 2% band) and EVM chains (need a
 * paid indexer or a node) are excluded by the arithmetic, not by taste.
 *
 * The five guards, mapped to this file: re-deposit is `ctx:tx:*` (a transfer is spent
 * once, for 40 days of memory); idempotency is the order's own status, re-read at the
 * moment of credit; API re-verification is `tronTxOk` — a list row is not believed,
 * the transaction's own record has to say the contract accepted it; amount and asset
 * are the band in `cryptoMatch` and the contract filter below, both before any write.
 */
const TRONGRID_API = 'https://api.trongrid.io';
const WATCH_SCAN_CAP = 50;                       // transfers per shop per sweep
const WATCH_ORDER_WINDOW = 14 * 864e5;           // older than this, a human owns it
const TX_MEMORY_DAYS = 40;
const CRYPTO_REPORT_CAP = 24;                    // rows the dashboard can hold per shop
const CRYPTO_REPORT_DAYS = 14;                   // and how long it may hold them

function tronHeaders(env) {
  // A key is optional and buys rate ceiling only; the watcher is built to run
  // without one, so `TRONGRID_KEY` is a comfort, never a dependency.
  const h = { 'user-agent': 'tapstall/1 (chain watch)' };
  if (env.TRONGRID_KEY) h['TRON-PRO-API-KEY'] = String(env.TRONGRID_KEY);
  return h;
}

async function tronUsdtTransfers(env, addr, contract, sinceMs) {
  const q = 'only_confirmed=true&only_to=true&limit=' + WATCH_SCAN_CAP
    + '&contract_address=' + encodeURIComponent(contract)
    + '&min_timestamp=' + (Math.max(0, Number(sinceMs) || 0) + 1);
  const r = await fetch(`${TRONGRID_API}/v1/accounts/${encodeURIComponent(addr)}/transactions/trc20?${q}`,
    { headers: tronHeaders(env) });
  if (!r.ok) throw new Error('trongrid_' + r.status);
  const doc = await r.json().catch(() => null);
  // the free plan throttles at 3 rps and answers the excess with an Error body at
  // HTTP 200 — read as an empty hour, it would silently skip money; read as an
  // error, the store's whole sweep aborts and the next cron slot re-reads it
  if (doc && doc.Error) throw new Error('trongrid_ratelimited');
  // field names are what the API actually returned when this was written (probed live
  // 2026-10-15): `block_timestamp` — there is no plain `timestamp` on these rows —
  // and `type`, which distinguishes a Transfer from an Approval. An approval's
  // "value" is an allowance the owner granted, not money sent: trusting an endpoint
  // to have filtered by the type nobody asked it for is how phantom payments happen.
  return (((doc && doc.data) || [])).map((x) => ({
    txid: String((x && x.transaction_id) || '').slice(0, 80),
    at: Number(x && (x.block_timestamp != null ? x.block_timestamp : x.timestamp)) || 0,
    type: String((x && x.type) || ''),
    units: Math.round(Number(x && x.value) || 0),
    from: String((x && x.from) || '').slice(0, 42),
    to: String((x && x.to) || '').slice(0, 42),
    contract: String((x && x.token_info && x.token_info.address) || contract || ''),
  })).filter((x) => x.txid && x.units > 0 && (!x.type || x.type === 'Transfer'));
}

/** Re-verification. A sweep row is an event somebody indexed; this is the chain
 *  being asked directly whether the transaction executed. The live shape, probed
 *  2026-10-15, is `receipt.result` on the node's transaction-info answer — the
 *  older `ret[].contractRet` is honoured too, because a `data[0].ret` shape is
 *  what the docs still show and endpoints drift. A txid the node does not know
 *  answers `{}` and defers. Anything short of an explicit SUCCESS — a dead
 *  endpoint, a rate-limit, a revert — defers the credit to the next sweep.
 *  A watcher that cannot verify credits nothing; that is the difference between
 *  this and a webhook that trusts a POST. */
async function tronTxOk(env, txid) {
  try {
    const r = await fetch(`${TRONGRID_API}/wallet/gettransactioninfobyid`, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, tronHeaders(env)),
      body: JSON.stringify({ value: String(txid) }),
    });
    if (!r.ok) return false;
    const doc = await r.json().catch(() => null);
    if (!doc || typeof doc !== 'object') return false;
    if (doc.Error) return false;
    const rows = Array.isArray(doc.data) ? doc.data : [doc];
    let judged = 0;
    for (const d of rows) {
      if (!d || typeof d !== 'object') continue;
      const rid = String(d.id || d.tx_id || '');
      if (rid && rid !== String(txid)) continue;          // an answer about another transaction is not an answer
      const rec = (d.receipt && d.receipt.result) || null;
      const rets = (d.ret && d.ret.length ? d.ret : (d.tx_info && d.tx_info.ret)) || [];
      if (!rec && !rets.length) continue;                 // {} for an unknown txid: nothing to believe
      judged++;
      if (rec && rec !== 'SUCCESS') return false;
      if (!rets.every((x) => !x || x.contractRet == null || x.contractRet === 'SUCCESS')) return false;
    }
    return judged > 0;
  } catch (e) { return false; }
}

/** "The money has been counted", in one place, because there are now two hands that
 *  count it: the merchant's tap and the watcher's credit. A ledger half that lives
 *  twice is a ledger half that drifts — status, marked_at, the buyer's unpaid counter,
 *  the row the dashboard reads, the audit line. */
async function creditOrder(env, st, o, via, ip, note) {
  o.status = 'paid';
  o.marked_at = new Date().toISOString();
  try {
    const hk = `buyer:${st.handle}:${o.buyer_hash}`;
    const rec = (await env.STORES.get(hk, 'json')) || { count: 0, unpaid: 0 };
    rec.unpaid = Math.max(0, (rec.unpaid || 0) - 1);
    await env.STORES.put(hk, JSON.stringify(rec), { expirationTtl: 180 * 86400 });
  } catch (e) { /* a buyer-stat read must not hold up a payment being believed */ }
  await saveOrder(env, st.handle, o);
  return await pushAudit(env, st, { act: 'mark', via, fields: [o.code + ' → paid' + (note ? ' · ' + note : '')], ip: ip || '' });
}

/** One shop's sweep. `manual` marks the dashboard button, which is the same code on
 *  the same rules — a watcher that also answers a "check now" is a watcher the
 *  merchant can trust at 19:00 without waiting for the next cron slot. */
async function cryptoSweep(env, st, manual) {
  const out = { scanned: 0, credited: [], flagged: [], deferred: [], loose: 0, skipped: null, errors: [] };
  const rail = resolveRail(st, st.rail || 'cash', await railsCatalog(env));
  const cr = rail.crypto;
  if (!cr) { out.skipped = 'no_crypto_rail'; return out; }
  const det = railAcctOf(st, rail.key, rail);
  const addr = String(det.acct || '').trim();
  if (!isTronAddr(addr)) { out.skipped = 'bad_address'; return out; }
  let since = 0;
  try { since = Number((await env.STORES.get('ctx:' + st.handle, 'json') || {}).at) || 0; } catch (e) { since = 0; }
  if (!since) since = Date.now() - WATCH_ORDER_WINDOW;      // first run: the window the ledger still owns
  let rows;
  try { rows = await tronUsdtTransfers(env, addr, cr.contract, since); }
  catch (e) { out.errors.push(String((e && e.message) || e).slice(0, 60)); return out; }
  // The asset guard runs over what the API *returned*, not over what it was asked
  // for: a filter that silently misfires must not be able to bill a TRX transfer
  // to a USDT order.
  rows = rows.filter((x) => x.to === addr && x.contract === cr.contract);
  out.scanned = rows.length;
  if (!rows.length) return out;
  const now = Date.now();
  const ledger = await ledgerRows(env, st.handle, 100);
  const open = ledger
    .filter((r) => r && r.id && r.status !== 'paid' && r.status !== 'cancelled'
      && (Number(r.pay_now) || 0) > 0 && (!r.at || now - Date.parse(r.at) < WATCH_ORDER_WINDOW))
    .map((r) => ({ id: r.id, code: r.code || '', units: toUnits(r.pay_now, cr.decimals), status: r.status, proof: r.proof || '' }));
  const m = cryptoMatch(rows, open, cr.tolerance_pct || 0.01);
  const report = [];
  for (const c of m.credits) {
    const tk = 'ctx:tx:' + c.txid;
    if (await env.STORES.get(tk)) { out.flagged.push({ txid: c.txid, kind: 'replay' }); continue; }
    const key = `order:${st.handle}:${c.order_id}`;
    const o = await env.ORDERS.get(key, 'json');
    if (!o || o.status === 'paid' || o.status === 'cancelled') continue;   // idempotency, at the write
    if (!(await tronTxOk(env, c.txid))) { out.deferred.push({ txid: c.txid, order_id: c.order_id }); continue; }
    const paid = fromUnits(c.units, cr.decimals), expected = fromUnits(c.expected_units, cr.decimals);
    o.crypto = { txid: c.txid, paid, expected, shortfall: round2(expected - paid) > 0 ? round2(expected - paid) : 0,
                 kind: c.kind, by: 'watcher', at: new Date().toISOString() };
    const flags = [...(o.risk_flags || [])];
    if (c.kind === 'underpaid') flags.push(`crypto_underpaid: ${paid} of ${expected} USDT`);
    if (c.kind === 'overpaid') flags.push(`crypto_overpaid: ${paid} for ${expected} USDT`);
    o.risk_flags = [...new Set(flags)].slice(0, 8);
    await creditOrder(env, st, o, manual ? 'session' : 'chain', '', c.txid.slice(0, 10) + '…');
    await env.STORES.put(tk, '1', { expirationTtl: TX_MEMORY_DAYS * 86400 });
    out.credited.push({ order_id: c.order_id, code: o.code, kind: c.kind, paid, expected });
    if (c.kind !== 'exact') report.push({ at: new Date().toISOString(), kind: c.kind, code: o.code, paid, expected,
      shortfall: round2(Math.max(0, expected - paid)), txid: c.txid.slice(0, 16) + '…' });
  }
  for (const f of m.flags) {
    // Ambiguous and self-reported rows attach to the order as a flag and to the
    // report — never as a credit. The watcher's job ends where arithmetic stops.
    if (f.order_id) {
      const key = `order:${st.handle}:${f.order_id}`;
      const o = await env.ORDERS.get(key, 'json');
      if (o && o.status !== 'paid' && o.status !== 'cancelled') {
        o.risk_flags = [...new Set([...(o.risk_flags || []), `crypto_${f.kind}: ${fromUnits(f.units, cr.decimals)} USDT seen`])].slice(0, 8);
        o.crypto = { txid: f.txid, paid: fromUnits(f.units, cr.decimals), expected: fromUnits(f.expected_units || 0, cr.decimals),
                     by: 'watcher', at: new Date().toISOString(), credited: false };
        await saveOrder(env, st.handle, o);
      }
    }
    out.flagged.push({ txid: f.txid, kind: f.kind, order_id: f.order_id || null });
    report.push({ at: new Date().toISOString(), kind: f.kind, code: f.code || '', paid: fromUnits(f.units, cr.decimals),
      expected: f.expected_units ? fromUnits(f.expected_units, cr.decimals) : 0, txid: String(f.txid).slice(0, 16) + '…' });
  }
  for (const l of m.loose) {
    out.loose++;
    report.push({ at: new Date().toISOString(), kind: 'unattributed', paid: fromUnits(l.units, cr.decimals),
      txid: String(l.txid).slice(0, 16) + '…' });
    out.flagged.push({ txid: l.txid, kind: 'unattributed' });
  }
  const newest = rows.reduce((a, x) => Math.max(a, x.at || 0), since);
  if (newest > since) await env.STORES.put('ctx:' + st.handle, JSON.stringify({ at: newest }), { expirationTtl: 60 * 86400 });
  if (report.length) {
    st.crypto_report = [...report.reverse(), ...(st.crypto_report || [])]
      .filter((r) => now - Date.parse(r.at || 0) < CRYPTO_REPORT_DAYS * 864e5).slice(0, CRYPTO_REPORT_CAP);
    await writeStore(env, st);
  }
  if (out.credited.length) auditHook(env, { waitUntil: (p) => { try { p && p.catch && p.catch(() => {}); } catch (e) {} } },
    'crypto', st.handle + ': ' + out.credited.length + ' credited by watcher');
  return out;
}

/** The nightly underpayment report — one mail a day per shop, listing what the band
 *  caught, sent to the address the shop already used for order alerts. No EMAIL
 *  binding configured? The report still happened: it lives in the store document,
 *  where the dashboard prints it, and `sent_at` simply stays empty. A mechanism that
 *  only exists when a credential is present would quietly not exist. */
async function cryptoNightly(env, st) {
  const rows = (st.crypto_report || []).filter((r) => !r.sent_at && (r.kind === 'underpaid' || r.kind === 'overpaid' || r.kind === 'unattributed'));
  if (!rows.length) return 0;
  const lines = rows.map((r) => `${String(r.at || '').slice(0, 16).replace('T', ' ')}  ${r.kind}${r.code ? '  order ' + r.code : ''}  `
    + (r.paid != null ? `paid ${r.paid} USDT` : '') + (r.expected ? ` of ${r.expected}` : '')
    + (r.shortfall ? ` (short ${r.shortfall})` : '') + (r.txid ? '  tx ' + r.txid : ''));
  const body = `Crypto discrepancies — ${st.shop_name || st.handle}\n\n`
    + `${lines.join('\n')}\n\nNothing here was refused or cancelled. A short payment inside the 1% band was credited to the order it matched; `
    + `one that matched nothing, or matched twice, waits for you. This mail is the nightly report; the dashboard lists the same rows live.\n`
    + `Dashboard: /a — Payment methods.`;
  const to = st.notify_email || st.owner_email || '';
  const sent = await sendMail(env, to, `Crypto report: ${rows.length} discrepancy(ies) — ${st.shop_name || st.handle}`, body);
  const stamp = new Date().toISOString();
  st.crypto_report = (st.crypto_report || []).map((r) => (rows.indexOf(r) >= 0 ? Object.assign({}, r, { sent_at: stamp }) : r));
  await writeStore(env, st);
  return sent ? rows.length : -rows.length;
}

/** The dashboard's "look at the chain now": one sweep for this shop, on this tap,
 *  on the same rules and through the same function as the cron. */
async function cryptoCheck(req, env) {
  const b = await readBody(req);
  const who = await identify(req, env, (b && b.handle) || urlHandle(req));
  if (!who || !who.st) return json({ ok: false, error: 'no store' }, 404);
  if (who.anonymous || who.bad) return json({ ok: false, need_login: true, error: 'sign in first' }, 401);
  if (who.via === 'sess' && (reqHeader(req, 'x-tapstall-confirm') || '') !== '1') {
    return json({ ok: false, error: 'missing x-tapstall-confirm header' }, 403);
  }
  const out = await cryptoSweep(env, who.st, true);
  const credited = out.credited.length, flagged = out.flagged.length;
  return json({
    ok: true,
    ...out,
    note: out.skipped === 'bad_address'
      ? 'No wallet to watch: the payment number for this method is not a Tron address (T, then 33 characters). Fix it under Payment methods and tap again.'
      : out.skipped === 'no_crypto_rail'
        ? 'This shop is not on a crypto rail, so there is no chain to read.'
        : out.errors.length
          ? 'The chain reader (TronGrid) did not answer — ' + out.errors[0] + '. Nothing was credited and nothing was lost: the next check reads it again.'
          : credited + flagged === 0
            ? 'Checked every incoming transfer since the last look: nothing matched an open order.'
            : credited + ' order(s) credited, ' + flagged + ' left for you to count.',
  }, 200, { 'Cache-Control': 'no-store' });
}

/* ------------------------------------------------------------------ cron */
async function runCron(env) {
  const out = { checked: 0, suspended: 0, reinstated: 0, warned: 0, held: 0 };
  if (!env.STORES) return out;
  const nightly = new Date().getUTCHours() === 0;    // the 00:15 slot owns the report
  // Heartbeat once a day, not four times: it proves the schedule fires, and
  // the other three writes proved only that a write costs a write.
  if (nightly) {
    try { if (await governedPut(env.STORES, 'cron:last', JSON.stringify({ at: new Date().toISOString(), unix: Date.now() }), null, 'telemetry')) out.heartbeat = true; } catch (e) {}
  }
  try { out.buyer_flushed = await flushBuyerBuf(env, 25); } catch (e) { out.buyer_flushed = 0; }
  // v2.0.0: discovery moved to the 02:xx/03:xx 20-minute tick (its own subrequest budget);
  // the press flushes on that tick too, so the 6-hourly sweep no longer runs it twice.
  // v2.0.0: the dispatch runs first, before the store walk and the chain readers spend fetches.
  try { out.dispatch = await dispatchTick(env); }
  catch (e) { out.dispatch = { error: String(e && e.message || e).slice(0, 160) }; }
  try { out.press = await pressTick(env); }        // also on the 20-minute tick; press:last dedupes a minute
  catch (e) { out.press = { error: String(e && e.message || e).slice(0, 160) }; }
  if (nightly) {
    // v2.1.0: the tick drains only when the queued-mail flag is set; once a day the queue is listed
    // regardless, so a flag lost to a race delays mail by hours, never loses it.
    try { out.mailq = await mailDrain(env, 3, { full: true }); } catch (e) { out.mailq = { error: String(e && e.message || e).slice(0, 120) }; }
    try { out.lead_meta = await leadMetaBackfill(env, 60); } catch (e) { out.lead_meta = { error: String(e && e.message || e).slice(0, 120) }; }
  }
  const watch = [];                                  // shops that asked for the chain reader
  const summary = { total: 0, live: 0, suspended: 0, expiring: [] };
  out.read_docs = 0; out.legacy_docs = 0; out.backfilled = 0;
  let cursor, loops = 0;
  do {
    const list = await env.STORES.list({ prefix: 'store:', cursor });
    quotaNote('lists', 'operator');
    for (const k of (list.keys || [])) {
      out.checked++; summary.total++;
      const handle = String(k.name).slice('store:'.length);
      const action = storeMetaAction(k.metadata, Date.now());
      if (action !== 'legacy') {
        const meta = k.metadata || {};
        const left = ((Number(meta.p) || 0) - Date.now()) / 864e5;
        if (meta.s) summary.suspended++;
        else if (left > 0) { summary.live++; if (left <= 14) summary.expiring.push({ handle, left_days: Math.ceil(left) }); }
        if (!action) continue;               // the metadata row was the whole visit: no document read
      } else out.legacy_docs++;
      out.read_docs++;
      const st = await getStore(env, handle, { fresh: true });
      if (!st) continue;
      if (action === 'legacy') {
        const left0 = ((st.paid_until || 0) - Date.now()) / 864e5;
        if (st.suspended) summary.suspended++;
        else if (left0 > 0) { summary.live++; if (left0 <= 14) summary.expiring.push({ handle, left_days: Math.ceil(left0) }); }
        // Give a pre-metadata document its row at most 25 shops a night (and
        // only at night): the migration is one write per shop, ever, paced so
        // it can never crowd out a day's orders. Any real action below writes
        // the document anyway and backfills for free.
        const needsAction = (left0 <= 0 && !st.suspended) || (left0 > 0 && st.suspended)
          || (left0 > 0 && left0 <= 7 && !st.warned_at);
        if (!needsAction && nightly && out.backfilled < 25 && quotaGate('writes', 'automation').ok) {
          try { await writeStore(env, st); out.backfilled++; } catch (e) { /* next night */ }
        }
      }
      if (st.crypto_watch) watch.push(st);
      const leftDays = ((st.paid_until || 0) - Date.now()) / 864e5;
      if (leftDays <= 0 && !st.suspended) {
        // v2.2.1: closed only once the owner was told and had SUSPEND_GRACE_DAYS (suspendDecision).
        const decision = suspendDecision(st, Date.now());
        if (decision === 'notify') {
          let told = false;
          if (mailArmed(env)) {
            told = await sendMail(env, st.owner_email, `Your store has expired: renew within ${SUSPEND_GRACE_DAYS} days to keep it open`,
              `${st.shop_name} reached the end of its paid year on ${new Date(st.paid_until).toDateString()}.\nIt stays open for ${SUSPEND_GRACE_DAYS} more days. Renew here and it carries on without a gap: ${renewLink(st, env.PUBLIC_ORIGIN || '')}\n${PRICE_USD} USD / 365 days. No monthly billing, no foreign-card subscription.`);
          }
          if (told) { st.warned_at = new Date().toISOString(); await writeStore(env, st); out.warned++; }
          out.held++;
        } else if (decision === 'hold') {
          out.held++;
        } else if (decision === 'suspend') {
          st.suspended = true; st.suspended_at = new Date().toISOString();
          await writeStore(env, st);
          summary.suspended++;
          out.suspended++;
        }
      } else if (leftDays > 0 && st.suspended) {
        st.suspended = false;
        await writeStore(env, st);
        summary.suspended = Math.max(0, summary.suspended - 1); summary.live++;
        out.reinstated++;
      } else if (leftDays > 0 && leftDays <= 7 && !st.warned_at) {
        // v2.0.0: stamped only once the notice actually left (or there is nobody to tell);
        // before, the stamp came first and the mail was a no-op, so no shop was ever warned.
        let told = !st.owner_email;
        if (st.owner_email && mailArmed(env)) {
          told = await sendMail(env, st.owner_email, `Your store renews in ${Math.ceil(leftDays)} days`,
            `${st.shop_name} runs until ${new Date(st.paid_until).toDateString()}.\nRenew here and it switches over automatically: ${renewLink(st, env.PUBLIC_ORIGIN || '')}\n${PRICE_USD} USD / 365 days. No monthly billing, no foreign-card subscription.`);
        }
        if (told) { st.warned_at = new Date().toISOString(); await writeStore(env, st); }
        out.warned++;
      }
    }
    cursor = list.cursor;
  } while (cursor && loops++ < 10);
  out.stores = summary;
  /* The chain readers run after the sweep finished reading, on the same documents —
   * capped at twenty shops a slot so a wedged TronGrid can never make the cron slow
   * for the expiry walk that actually keeps the doors shut. */
  out.crypto = { watching: watch.length, credited: 0, flagged: 0, deferred: 0, errors: 0, reports: 0 };
  for (const st of watch.slice(0, 20)) {
    try {
      const s = await cryptoSweep(env, st, false);
      out.crypto.credited += s.credited.length;
      out.crypto.flagged += s.flagged.length;
      out.crypto.deferred += s.deferred.length;
      out.crypto.errors += (s.errors ? s.errors.length : 0);
      if (nightly) { const n = await cryptoNightly(env, st); if (n) out.crypto.reports++; }
    } catch (e) { out.crypto.errors++; }
  }
  /* v1.0.0: the scheduler. One Cloudflare cron is the only clock in the system; everything
   * periodic hangs off it in slots, each slot claimed in one write so a retried tick cannot
   * double-fire. Nothing here waits for a person: the press composes and sends under standing
   * policy (caps, provenance, rail health judge it), the lead hunt is dispatched to Actions
   * when a scoped token is bound, and the nightly digest records the exceptions — expiries,
   * unrecognised payment references, dead rails — which are the only lines a human is for.
   * A slot that fails says so in the return value and never takes the expiry sweep down with it. */
  if (nightly) {
    try { out.digest = await writeDigest(env, summary); }
    catch (e) { out.digest = { error: String(e && e.message || e).slice(0, 160) }; }
  }
  return out;
}

// What a closed link says, once, for all three doors it used to open. It names the reason (the
// shop did this, on purpose), states that nothing moved, and says where the working link is,
// because unlike a buyer the person holding this one has a dashboard.
const RENEW_CLOSED_WHY = 'This shop has closed its payment links, so this one opens nothing and files nothing.'
  + ' Nothing about the store has changed: the current link is on the plan card in your dashboard.';

/* ------------------------------------------------------------ renew page */
async function renewPage(env, token) {
  // through the one reader, so an operator's override and the bundle's copy both reach this page;
  // reading the KV key by name here is how a hand-published page edited the storefront and not this one
  let custom = (await tplPage(env, 'renew')).html || null;
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
    const rows = st ? await ledgerRows(env, st.handle) : [];
    const data = {
      known: !!(st), token,
      state: closed ? 'closed' : null, why: closed ? RENEW_CLOSED_WHY : null,
      shop: st ? st.shop_name : null, handle: st ? st.handle : null,
      plan: st ? (st.plan || 'free60') : null, currency: st ? (st.currency || 'USD') : 'USD',
      left: st ? Math.ceil(((st.paid_until || 0) - Date.now()) / 864e5) : 0,
      suspended: st ? !!st.suspended : false,
      orders: rows.length, gmv: Math.round(rows.reduce((a, r) => a + (Number(r.total) || 0), 0) * 100) / 100,
      price: PRICE_USD, price_monthly: SUBSCRIPTION_PLANS.monthly.usd,
      pay_whop: !!(env.WHOP_CHECKOUT_URL || env.WHOP_CHECKOUT_URL_ANNUAL),
      pay_manual: String(env.PLATFORM_PAY_DETAILS || ''),
      store_url: st ? '/s/' + st.handle : '/onboard',
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
  const rows = await ledgerRows(env, st.handle);
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
  if (!/^tpl(-ovr)?:(store|onboard|admin|fees|index|sample-menu)$/.test(String(b.key || ''))) return json({ ok: false, error: 'bad key' }, 422);
  if (String(b.value || '').length < 200 || String(b.value || '').length > 400000) return json({ ok: false, error: 'bad size' }, 422);
  await env.STORES.put(b.key, b.value);
  memDel('tplkv:' + String(b.key).split(':').pop()); quotaNote('writes', 'operator');
  return json({ ok: true, key: b.key, bytes: b.value.length });
}

/* ------------------------------------------------------------ plumbing */
/* Counted in the isolate first, because a limit that writes on every request is a door an attacker
 * can spend your *quota* through: this one used to put a key per request per window, so 1,000 free
 * writes a day — the whole shop's order ledger for a day, every confirmation link and every settings
 * save in it — was gone in about 1,000 refused attempts, sent by somebody who was never blocked.
 * A local counter stops that (it costs the attacker their own requests, not the platform's budget)
 * and it is faster: the guarded doors answered from a KV round trip they did not need.
 *
 * The KV key stays, and that is not decoration. Isolates are per-colo and they come and go, so a
 * local count alone would let a distributed flood reset its allowance at every hop; the key is what
 * makes the block hold across them. The difference is *when* it is touched: it is read only once an
 * isolate is already halfway to the ceiling, and written only when a block actually starts. A normal
 * buyer never spends a write. A flood spends one per (ip, window, bucket) and then finds the door
 * shut everywhere.
 *
 * `LRU` is not a fairness claim — a cold isolate counts from zero, so the first `max/2` attempts of
 * a fresh burst are free. `RL.max` was chosen for a human mistyping a PIN, not for a targeted
 * attack, and the ceiling that matters for an attack (per-store attempts, lockouts) is counted on
 * the store document, which no isolate-local trick can soften.
 */
const localHits = new Map();
const LOCAL_TTL = 10 * 60e3;
function localNote(ipKey, window) {
  const now = Date.now();
  if (localHits.size > 4096) for (const [k, v] of localHits) if (now - v.at > LOCAL_TTL) localHits.delete(k);
  const hit = localHits.get(ipKey);
  if (!hit || hit.window !== window) { localHits.set(ipKey, { window, n: 1, at: now }); return 1; }
  hit.n++; hit.at = now;
  return hit.n;
}
async function rateLimited(env, ip, bucket, rl) {
  if (!env.STORES) return false;
  const win = rl || RL;
  const window = Math.floor(Date.now() / (win.windowSec * 1000));
  const ipKey = `${bucket || ''}${ip}:${window}`;
  // `seen` is the number of attempts this isolate has already counted, which is what the shared
  // key holds — the two must mean the same thing or the ceiling moves by one depending on which
  // isolate happens to answer, and "max per minute" would be a range instead of a number.
  const seen = localNote(ipKey, window) - 1;
  if (seen >= win.max) return true;                       // at the ceiling locally: refused, and KV cannot talk us out of it
  if (seen + 1 < Math.ceil(win.max / 2)) return false;    // nowhere near it: no KV at all, which is the point
  const key = 'rl:' + ipKey;
  // Three answers a read can give, and the middle one is the trap. *Absent* is not "zero": a
  // counter that was never armed says nothing, and treating it as a zero would reset this isolate's
  // own count on the way up and let a flood run forever — which is the bug this function had before
  // it had a local half. Present-and-lower is a different fact: somebody cleared it (an operator's
  // lever, a revoke), and a clear is a decision to let this address try again. Unreadable is a third
  // fact, answered by what this isolate saw, which keeps the ceiling a ceiling.
  let raw = null;
  try { raw = await env.STORES.get(key); } catch (e) { raw = undefined; void e; }
  if (raw === undefined) {
    if (seen >= win.max) return true;
  } else if (raw !== null) {
    const shared = Number(raw) || 0;
    if (shared >= win.max) {
      localHits.set(ipKey, { window, n: shared + 1, at: Date.now() });
      return true;
    }
    if (shared < seen) localHits.set(ipKey, { window, n: shared + 1, at: Date.now() });
  }
  const shared2 = raw === null || raw === undefined ? seen : (Number(raw) || 0);
  if (shared2 + 1 >= win.max) {
    try { await env.STORES.put(key, String(shared2 + 1), { expirationTtl: win.windowSec + 10 }); }
    catch (e) {
      // A spent write budget used to be answered 503 on every guarded POST, which meant the buyer's
      // own door closed at midnight UTC on the busiest day of the month because a *counter* could not
      // be written. The ceiling is not lost — the next attempt reads the same absent key, counts
      // locally, and is refused at the limit. What is given up is the cross-isolate arm of the block
      // on that one day, and the store's own lockout counter (which is what guards a PIN, and is a
      // write this budget already spends) is untouched.
      void e;
    }
  }
  return false;
}

/** Its own bucket, wider than an order's and narrower than nothing: one buyer adds a
 *  code once or twice, and the ceiling exists only so the field is not a free write
 *  oracle. `proof:` keeps it off the order counter, because a buyer and a shop behind
 *  one carrier NAT should not be spending each other's allowance. */
const PRL = { windowSec: 60, max: 6 };
/** Order numbers are leased in blocks. The human code stays sequential in the
 *  common case, but KV is touched once per block instead of once per order:
 *  at full tilt that turns 1,000 sequence writes into 20. KV never offered an
 *  atomic increment here (the old get+put could already race across isolates),
 *  and the order *id* — not the printed code — is the unique key, so a leased
 *  block changes the cost without changing what correctness rests on. If the
 *  lease write is refused, the caller falls back to a code derived from the
 *  unique order id and the order still lands with its one money write. */
const seqBlocks = new Map();       // handle -> { next, end }
const SEQ_BLOCK = 50;
async function nextOrderSeq(env, handle) {
  if (!env.STORES) return 1;
  const held = seqBlocks.get(handle);
  if (held && held.next <= held.end) return held.next++;
  try {
    const key = 'seq:' + handle;
    const cur = Number((await env.STORES.get(key)) || 0) || 0;
    quotaNote('reads', 'operator');
    const end = cur + SEQ_BLOCK;
    await env.STORES.put(key, String(end));
    quotaNote('writes', 'money');
    seqBlocks.set(handle, { next: cur + 2, end });
    return cur + 1;
  } catch (e) { return 0; }
}

/** Buyer history is a risk hint, not the ledger. It used to cost a KV write on
 *  every order — as much as the order itself — to increment two counters. Now
 *  the durable record is read once per isolate, deltas accumulate in memory,
 *  and a write happens only every tenth touch for that buyer, when the repeat
 *  threshold is crossed, or when cron flushes the buffer. The returned shape
 *  and semantics are the old ones (the current order included), so riskFlags
 *  and the trust line read exactly as they did. */
const buyerBuf = new Map();        // key -> { count, unpaid, dirty }
async function buyerTouch(env, handle, h) {
  if (!env.STORES) return { count: 0, unpaid: 0 };
  const key = `buyer:${handle}:${h.slice(0, 16)}`;
  let rec = buyerBuf.get(key);
  if (!rec) {
    const stored = (await env.STORES.get(key, 'json').catch(() => null)) || { count: 0, unpaid: 0 };
    quotaNote('reads', 'operator');
    rec = { count: Number(stored.count) || 0, unpaid: Number(stored.unpaid) || 0, dirty: 0 };
    buyerBuf.set(key, rec);
  }
  rec.count++; rec.unpaid++; rec.dirty++;
  if (rec.dirty >= 10 || rec.unpaid === 2) {
    try {
      await env.STORES.put(key, JSON.stringify({ count: rec.count, unpaid: rec.unpaid }), { expirationTtl: 180 * 86400 });
      quotaNote('writes', 'telemetry'); rec.dirty = 0;
    } catch (e) { /* a hint that cannot persist today is still a hint in this isolate */ }
  }
  return { count: rec.count, unpaid: rec.unpaid };
}
async function flushBuyerBuf(env, cap = 100) {
  if (!env.STORES) return 0;
  let n = 0;
  for (const [key, rec] of buyerBuf) {
    if (!rec.dirty || n >= cap) continue;
    if (!quotaGate('writes', 'telemetry').ok) break;
    try {
      await env.STORES.put(key, JSON.stringify({ count: rec.count, unpaid: rec.unpaid }), { expirationTtl: 180 * 86400 });
      quotaNote('writes', 'telemetry'); rec.dirty = 0; n++;
    } catch (e) { break; }
  }
  return n;
}

async function selftest(env) {
  const t = { version: VERSION, kv_stores: !!env.STORES, kv_orders: !!env.ORDERS, email: mailArmed(env),
    // whose cron is this? an alias answers redirects and skips the sweep, and the
    // deploy check reads this instead of trusting that the schedule was deleted
    cron_owner: true,
    quota_policy: { limits: QUOTA_LIMITS, soft_writes: QUOTA_LIMITS.kv_writes - 200, one_write_order: true } };
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
      await env.STORES.put(k, '1', { expirationTtl: 120 });
      quotaNote('writes', 'telemetry');
      t.kv_roundtrip = (await env.STORES.get(k)) === '1';
      // no delete: the probe already spent the write it exists to test, and a
      // delete is a second daily budget. The key expires by itself.
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
    // Pages are inlined in v0.9.1, so the two facts that matter are that the bundle carries all of
    // them and that a hand-published override still outranks it. Both are reads, so a day with no
    // KV writes left still reports them, which is the whole point of moving pages out of KV.
    // The guarded doors must cost the platform nothing until a block actually starts. That is a
    // claim about a code path, so it is measured through the limiter itself — nine requests through
    // `rateLimited` against a stub that counts puts — rather than reported as `true` beside the
    // function it describes, which would stay true even if the function went back to writing on
    // every request, which is exactly what it did before v0.9.1. Nine requests used to be nine
    // writes; the answer here says one, and the one is the block being armed.
    let rlPuts = 0, rlRefused = 0;
    const rlMap = new Map();
    const rlEnv = { STORES: {
      // the shape this Worker's STORES keeps: get answers with the value, not a wrapper object —
      // a probe stub that returned {value} would report the ceiling as never reached
      get: async (k) => (rlMap.has(k) ? rlMap.get(k) : null),
      put: async (k, v) => { rlPuts++; rlMap.set(k, v); },
      delete: async (k) => { rlMap.delete(k); },
    } };
    const rlIp = '198.51.100.7:' + Date.now();   // its own bucket, so a probe never spends a buyer's allowance
    for (let i = 0; i < 9; i++) if (await rateLimited(rlEnv, rlIp, 'selftest:', RL)) rlRefused++;
    t.rate_limit_local_first = { requests: 9, ceiling: RL.max, writes: rlPuts, refused: rlRefused };
    // The autonomous half of the mesh is only safe because a filter stands between a merchant's words
    // and a public feed, so the filter is checked here too — on the same fake shop the pricing checks
    // use, and with a description written as an advertisement, which is the case that must drop.
    // Two single-item shops, deliberately: one generator picks a row by day, so a shop holding both a
    // clean line and an advertisement would report a different truth on Wednesday than on Thursday. A
    // selftest key that varies with the date is a key nobody can grep for a cause.
    const clean = meshValueBeats({ handle: 'selftest', shop_name: 'Selftest', hours: 'Mon 08:00-16:00' },
      [{ id: 'x', name: 'Test item', desc: 'Slow-cooked overnight, so the meat gives up on its own', category: 'Mains', price: 12.5 }], {}, {});
    const advert = meshValueBeats({ handle: 'selftest' },
      [{ id: 'y', name: 'Truffle risotto', desc: 'Order now, 20% off, US$40 - click the link in bio', category: 'Mains', price: 40 }], {}, {});
    t.press_operator_refused = meshRegister({}, { id: 'anyshop', class: 'operator' }, { refuse_ids: ['anyshop'] }).ok === false;
    t.press_no_secrets_in_registry = meshRegister({ owner: {} }, { id: 'seller-x', class: 'seller', buffer_token: 'no' }).ok === false;
    t.press_company_beats_priced = (function () { const r = meshRegister({}, { id: 'owner', class: 'owner', rails: { x: { channel_id: 'abc' } } }, {});
      const b = meshCompanyBeats(r.identity, { price_usd: PRICE_USD, free_days: FREE_DAYS }, { origin: 'https://tapstall.zlnew.workers.dev', now: Date.now() });
      return b.beats.length === MESH_QUEUE_DEFAULTS.per_day && b.beats.some((x) => x.kind === 'promo'); })();
    t.press_queue_shape = (function () { const it = meshQueueItem({ kind: 'value', rail: 'x', item_key: 'k1', text: 'value line', to: ['x'], max: 280 }, { now: Date.now(), channel_id: 'abc' });
      return it.channel === 'twitter' && it.channel_id === 'abc' && it.via === 'buffer'; })();
    t.mesh_no_pitch_in_feed = clean.beats.length > 0 && clean.beats.every((x) => !meshIsPitch(x.text).pitch)
      && !/US\$|https?:|wa\.me|order now|discount|\$[0-9]/i.test(JSON.stringify(clean.beats));
    t.mesh_pitch_filter_drops = advert.beats.length === 0 && advert.blocked.length === 1
      && /pitch word|price|link/.test(JSON.stringify(advert.blocked));
    t.pages_inlined = Object.keys(INLINED_PAGES).filter((n) => (INLINED_PAGES[n] || '').length > 200).length;
    t.pages_bytes = Object.values(INLINED_PAGES).reduce((a, v) => a + v.length, 0);
    // Zero writes, like every other key here: `from` is the label the read already answered with,
    // so production says *which* copy a merchant is being served without anybody asking it.
    const ps = await tplPage(env, 'store');
    t.pages_store_from = ps.from;
    t.pages_served = ps.html.length > 200 && ps.from !== 'none';
    t.pages_no_longer_from_kv = t.pages_inlined > 0 ? ps.from !== 'kv' : true;
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
  const hit = memGet('rails:catalog');
  if (hit !== undefined) return hit;
  const out = Object.assign({}, RAILS);
  let extra = null;
  try { extra = env.STORES ? await env.STORES.get('rails:extra', 'json') : null; if (env.STORES) quotaNote('reads', 'operator'); } catch (e) { extra = null; }
  for (const k of Object.keys(extra || {})) {
    const r = normaliseRail(extra[k], k);
    if (r) out[k] = r;
  }
  // The picker's own entry: `own` tells a UI to render the merchant's description,
  // and the shape fields say what a number for an undescribed method looks like —
  // a wallet ID, a name worth checking and, if they have one, a till.
  out.custom = { key: 'custom', label: 'My own method (I describe it)', dial: 'as you describe', pct: 0, imtt: 0, fixed: 0, type: 'manual',
                 spec: 'wallet', holder: true, till: true, own: true };
  memSet('rails:catalog', out, 10 * 60e3);
  return cloneVal(out);
}

/* Every page this Worker serves, inlined by build_bundle.sh. The declaration below is what the
 * tests and a local dev run see (empty: fall through to KV); the deployed bundle carries git's
 * bytes in it, which is why a page publish costs no KV write and cannot lag a deploy. */
const INLINED_PAGES = {};

/**
 * The page a merchant is served, in the order the platform can actually honour.
 *
 *  1. `tpl-ovr:<name>` — a page the operator console published by hand. It wins, because whoever
 *     presses that button is fixing something that is wrong right now, and a redeploy is not always
 *     available at 22:00 to the only person awake.
 *  2. the bytes `build_bundle.sh` inlined, which are the bytes `npm test` passed;
 *  3. `tpl:<name>` — the KV copy, for a Worker published before pages rode in the bundle. This is
 *     what production was until v0.9.1, and a rollback lands back on it with nothing to undo;
 *  4. a page that says what is missing, rather than a blank one.
 *
 * One KV read in the normal case: an inlined page never falls through to the legacy key.
 */
async function tplPage(env, name) {
  // The override is an emergency door, so it is checked live: caching its
  // absence would make a 22:00 page fix wait on a timer. That one read is
  // the price of the door; everything downstream of it is bundle bytes.
  if (env.STORES) {
    const ovr = await env.STORES.get('tpl-ovr:' + name);
    quotaNote('reads', 'operator');
    if (ovr && ovr.length > 200) return { html: ovr, from: 'override' };
  }
  const inline = INLINED_PAGES[name];
  if (inline && inline.length > 200) return { html: inline, from: 'bundle' };
  if (env.STORES) {
    return cached('tplkv:' + name, 60e3, async () => {
      const v = await env.STORES.get('tpl:' + name);
      quotaNote('reads', 'operator');
      return (v && v.length > 200) ? { html: v, from: 'kv' } : { html: '', from: 'none' };
    });
  }
  return { html: '', from: 'none' };
}

async function tpl(env, name) {
  const p = await tplPage(env, name);
  if (p.html) return p.html;
  return '<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:2rem"><h1>Template &ldquo;'
    + name + '&rdquo; missing</h1><p>Neither the bundle nor KV carries it. <code>./scripts/deploy.sh</code> puts git\'s'
    + ' pages into the bundle; <code>./scripts/deploy.sh --pages-override ' + name + '</code> publishes one into KV as a stopgap.</p>';
}
/** The signing key for every capability, session and webhook signature. There used to be a
 *  `|| 'dev-secret'` fallback, so a deploy that lost the secret would mint sessions anyone could
 *  forge. Missing is now an error (the router answers 500) instead of a public key. */
function capKey(env) {
  const k = env && env.ADMIN_SECRET;
  if (!k || String(k).length < 8) throw new Error('ADMIN_SECRET is not set (or shorter than 8 characters)');
  return k;
}

/** v2.0.0: merchant mail goes out over the mail lane (worker/mail.js; Gmail since v2.2.0). Before this the
 *  function called `new EmailMessage(...)` with no import and no EMAIL binding: every merchant
 *  mail since launch was a silent no-op. Returns true when the message left or was parked for the
 *  20-minute retry; false when no lane is armed or the address is unusable. Never throws. */
async function sendMail(env, to, subject, text, extra) {
  if (!to) return false;
  const r = await mailDeliver(env, { to, subject, text, ...(extra || {}) });
  return !!(r.sent || r.queued);
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
  // One year, subdomains included: after the first https visit the browser stops
  // offering http://, which removes the downgrade window entirely.
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
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

const OPEN_RE = /^\/s\/|^\/rails\b|^\/fees\b|^\/data\/|^\/onboard\b|^\/__ping\b|^\/api\/(order|register|lookup|hook\/)|^\/renew\//;
function isOpenPath(pathname) { return OPEN_RE.test(pathname); }
const SESS_COOKIE = 'tp_sess';
const KILL_COOKIES = killCookies([SESS_COOKIE]);
function sessCookie(value) {
  return [`${SESS_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${SESS_TTL}`];
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
/* A statement is the shop's own money, so the two pages that are not the statement say plainly
 * that they are not, and where the working one is. */
const NO_STORE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>No statement here | Tapstall</title>
<meta name="robots" content="noindex"></head>
<body style="font:16px/1.6 system-ui;max-width:34rem;margin:14vh auto;padding:0 1.2rem">
<h1 style="font-size:1.3rem">No shop at that address</h1>
<p>A statement belongs to a shop. This address has no shop, so there is nothing to show and nothing was read.</p>
<p><a href="/onboard">Create a shop</a> — a name, a menu and a PIN.</p></body></html>`;
const SETTLE_CLOSED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in again | Tapstall</title>
<meta name="robots" content="noindex"></head>
<body style="font:16px/1.6 system-ui;max-width:34rem;margin:14vh auto;padding:0 1.2rem">
<h1 style="font-size:1.3rem">That sign-in no longer works</h1>
<p>The session used to open this statement has been closed or replaced. Nothing about the shop’s
money changed, and nothing was shown to whoever held the old link.</p>
<p><a href="/a">Sign in with your store name and PIN</a> to open the statement again.</p></body></html>`;
function text(s, status = 200, type = 'text/plain; charset=utf-8') {
  return new Response(s, { status, headers: { 'content-type': type, 'cache-control': 'public, max-age=3600' } });
}
function hdr(extra) {
  // Everything is folded into one lower-cased table on purpose. Spreading
  // SEC_HEADERS first leaves `X-Frame-Options` and `Content-Security-Policy` in
  // their original casing, and a per-route override then *adds* a second key that
  // differs only in case — a Headers object keeps both and joins them, so the
  // response read `DENY, SAMEORIGIN` (and two CSPs, which a browser intersects:
  // the stricter one wins). Lower-case both sides and an override replaces.
  const h = { 'cache-control': 'no-store', 'x-tapstall': VERSION };
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
    'content-type, x-tapstall-confirm, x-tapstall-admin');
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
/* Local-first, for the same reason the PIN tiers are: a counter that reads KV
 * on every authenticated dashboard request and writes KV on every bad guess
 * is a quota door held open for whoever knocks. This isolate counts first;
 * KV is read once to seed the count and written only when the lock actually
 * starts, which is the moment the cross-isolate fact matters. A success
 * clears the local count for free and touches KV only if a lock was ever
 * persisted (or might have been, once, before this isolate looked). */
const authMem = new Map();         // handle -> { n, persisted, loaded }
async function authState(env, handle) {
  let a = authMem.get(handle) || { n: 0, persisted: false, loaded: false };
  if (env.STORES) {
    try {
      const raw = await env.STORES.get('lock:' + handle);
      quotaNote('reads', 'security');
      a.n = Math.max(a.n, Number(raw) || 0);
      a.persisted = raw != null && Number(raw) > 0;
    } catch (e) { /* the local count still answers */ }
  }
  a.loaded = true;
  authMem.set(handle, a);
  return a;
}
async function lockedOut(env, handle) {
  if (!env.STORES) return false;
  const a = authMem.get(handle);
  if (a && a.n >= LOCK_MAX) return true;
  return (await authState(env, handle)).n >= LOCK_MAX;
}
async function authFail(env, handle) {
  if (!env.STORES) return 0;
  const a = await authState(env, handle);
  a.n++;
  // Persist at the first failure, halfway, and at the lock: cross-isolate
  // counting stays honest where it matters, without a write per guess.
  if (a.n === 1 || a.n === Math.ceil(LOCK_MAX / 2) || a.n >= LOCK_MAX) {
    // the counter is a courtesy to slow guessing, not a dependency: on a day the
    // write budget is gone, refuse with 403 as usual instead of 500-ing
    try { await env.STORES.put('lock:' + handle, String(a.n), { expirationTtl: LOCK_TTL }); quotaNote('writes', 'security'); a.persisted = true; } catch (e) {}
  }
  return a.n;
}
async function authClear(env, handle) {
  if (!env.STORES) { authMem.delete(handle); return; }
  const n = await env.STORES.get('lock:' + handle).catch(() => null);
  if (n && Number(n) > 0) {
    try { await env.STORES.delete('lock:' + handle); quotaNote('deletes', 'security'); } catch (e) {}
  }
  authMem.set(handle, { n: 0, persisted: false, loaded: true });
}

/** Who is asking? Cookie session, or the store's API key. Never a URL token. */
async function identify(req, env, handle) {
  handle = slug(String(handle || ''));
  const st = await getStore(env, handle);
  if (!st) return null;
  const raws = cookieVals(req, 'tp_sess');
  if (raws.length) {
    for (const raw of raws) {
    const p = await verifyCap(capKey(env), raw);
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
    ? json({ ok: false, error: 'too many failed attempts with that key — wait for the freeze to pass, or use “I lost my PIN” to get a reset link by email' }, 429)
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
  const sess = await issueCap(capKey(env),
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
  const rows = await ledgerRows(env, handle);
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


/* ---------------------------------------------------------------- the selling rail
 * v1.7.0. What was missing before charging for a rail: a payment ledger separate from the order
 * ledger, one catalogue for built-in / operator / processor rails, a settlement statement, a
 * vetting gate and a refund trail. The doctrine is unchanged and enforced in worker/rail.js:
 * **we never hold the money**, so there is no balance, no payout and no wallet anywhere below.
 */

/** The month documents a window touches. One read per month, because KV writes are the scarce
 *  resource and a statement is a read-heavy page. */
async function payEvents(env, handle, { day, from, to } = {}) {
  const months = new Set();
  if (day) months.add(String(day).slice(0, 7));
  else {
    const a = new Date(Number(from) || Date.now()), b = new Date(Number(to) || Date.now());
    const cur = new Date(a.getUTCFullYear(), a.getUTCMonth(), 1);
    const end = new Date(b.getUTCFullYear(), b.getUTCMonth(), 1);
    let guard = 0;
    while (cur <= end && guard++ < 24) { months.add(cur.toISOString().slice(0, 7)); cur.setUTCMonth(cur.getUTCMonth() + 1); }
  }
  if (!months.size) months.add(new Date().toISOString().slice(0, 7));
  const out = [];
  for (const m of months) {
    const doc = await env.ORDERS.get('pay:' + handle + ':' + m, 'json').catch(() => null);
    if (doc && Array.isArray(doc.events)) out.push(...doc.events);
  }
  return out;
}

async function payWrite(env, handle, event) {
  const key = payDocKey(handle, event.at);
  const doc = await env.ORDERS.get(key, 'json').catch(() => null);
  const res = appendPaymentEvent(doc, event);
  if (!res.wrote) return { wrote: false, doc: res.doc };
  await env.ORDERS.put(key, JSON.stringify(res.doc));
  return { wrote: true, doc: res.doc, key };
}

function settleOpts(url) {
  const day = String(url.searchParams.get('day') || '').slice(0, 10);
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) return { day };
  return {
    from: from ? Date.parse(from + 'T00:00:00Z') : undefined,
    to: to ? Date.parse(to + 'T23:59:59Z') : undefined,
  };
}

async function settleView(req, url, env) {
  const handle = slug(url.searchParams.get('handle') || '');
  const g = await adminGate(req, env, handle);
  if (g.res) return g.res;
  const st = g.who.st;
  const opt = settleOpts(url);
  const rows = await ledgerRows(env, handle);
  const events = await payEvents(env, handle, opt);
  const doc = settlement(rows, events, opt);
  if (String(url.searchParams.get('fmt') || '').toLowerCase() === 'csv') {
    return new Response(settlementCsv(doc, st), { headers: {
      'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': 'attachment; filename="' + handle + '-settlement-' + (opt.day || 'all') + '.csv"',
    } });
  }
  return json({ ok: true, handle, ...doc, currency: st.currency || 'USD' }, 200, { 'Cache-Control': 'no-store' });
}

/** The statement a shop can hold. Same arithmetic as `/api/settle` (it calls `settlement()`), a
 *  plain HTML page with no script and no external asset, so it prints, saves as PDF, and opens on a
 *  phone with a dead battery of patience. It says the one thing that matters about custody out loud:
 *  every rail paid the shop directly; Tapstall never held the money. */
async function settlePage(req, url, env, handleHint) {
  const handle = slug(handleHint || url.searchParams.get('handle') || '');
  const who = await identify(req, env, handle);
  if (!who || !who.st) return html(NO_STORE_PAGE, 404, { 'Cache-Control': 'no-store' });
  // No `next=` promise: the dashboard does not read one, and a redirect that carries a parameter
  // nothing consumes is a link that looks like it will come back here and will not.
  if (who.anonymous) return redirect('/a?handle=' + encodeURIComponent(handle));
  if (who.bad) return html(SETTLE_CLOSED_PAGE, 403, { 'Cache-Control': 'no-store' });
  const st = who.st;
  const asked = String(url.searchParams.get('day') || '').slice(0, 10);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : new Date().toISOString().slice(0, 10);
  const rows = await ledgerRows(env, handle);
  const events = await payEvents(env, handle, { day });
  const doc = settlement(rows, events, { day });
  const cur = st.currency || 'USD';
  const money = (n) => (cur === 'ZAR' ? 'R' : (cur === 'USD' ? '$' : cur + ' ')) + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
  const t = doc.totals;
  const nice = new Date(day + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const prev = new Date(Date.parse(day + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
  const next = new Date(Date.parse(day + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
  const base = '/s/' + handle + '/settle';
  const csv = '/api/settle?handle=' + encodeURIComponent(handle) + '&day=' + day + '&fmt=csv';
  const stat = (label, value, cls) => '<div class="stat' + (cls ? ' ' + cls : '') + '"><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div>';
  const railRows = (doc.per_rail || []).map((r) => '<tr><td>' + esc(r.rail || 'unrecorded') + '</td><td class="n">' + r.orders + '</td>'
    + '<td class="n">' + esc(money(r.expected)) + '</td><td class="n">' + esc(money(r.matched)) + '</td>'
    + '<td class="n' + (r.unmatched > 0 ? ' warn' : '') + '">' + esc(r.unmatched > 0 ? money(r.unmatched) : '—') + '</td>'
    + '<td class="n">' + esc(r.fees > 0 ? money(r.fees) : '—') + '</td></tr>').join('');
  const nothing = !doc.events && !t.orders;
  return html('<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">'
    + '<title>Statement · ' + esc(st.shop_name || handle) + ' · ' + esc(day) + '</title>'
    + '<style>'
    + ':root{--ink:#12211b;--mut:#5d7169;--line:#e2e8e4;--hot:#0b5b34;--warn:#a8560d}'
    + '*{box-sizing:border-box}body{margin:0;background:#f4f6f5;color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}'
    + 'main{max-width:46rem;margin:0 auto;padding:1.6rem 1.1rem 3rem}'
    + 'h1{font-size:1.28rem;margin:0 0 .15rem}h2{font-size:.82rem;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:1.6rem 0 .5rem}'
    + '.head{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap}'
    + '.sub{color:var(--mut);font-size:.9rem;margin:0}'
    + '.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(7.5rem,1fr));gap:.55rem;margin-top:1.1rem}'
    + '.stat{background:#fff;border:1px solid var(--line);border-radius:.6rem;padding:.7rem .8rem}'
    + '.stat b{display:block;font-size:1.12rem;font-variant-numeric:tabular-nums}'
    + '.stat span{color:var(--mut);font-size:.76rem}'
    + '.stat.hot{border-color:var(--hot)}.stat.hot b{color:var(--hot)}.stat.warn b{color:var(--warn)}'
    + 'table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:.6rem;overflow:hidden}'
    + 'th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid var(--line);font-size:.88rem;vertical-align:top}'
    + 'th{background:#fafbfa;font-weight:600;color:var(--mut);font-size:.76rem;text-transform:uppercase;letter-spacing:.04em}'
    + 'tr:last-child td{border-bottom:0}.n{text-align:right;font-variant-numeric:tabular-nums}.warn{color:var(--warn)}'
    + '.todo{background:#fff;border:1px solid var(--hot);border-radius:.6rem;padding:.75rem .85rem;margin-top:1rem}'
    + '.todo b{display:block;font-size:.76rem;text-transform:uppercase;letter-spacing:.05em;color:var(--hot);margin-bottom:.2rem}'
    + '.foot{margin-top:1.6rem;color:var(--mut);font-size:.82rem}'
    + '.act{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:1rem}'
    + '.act a{display:inline-block;padding:.5rem .8rem;border-radius:.45rem;border:1px solid var(--line);background:#fff;color:var(--ink);text-decoration:none;font-size:.85rem}'
    + '.act a.pri{background:var(--hot);border-color:var(--hot);color:#fff}'
    + '@media print{body{background:#fff}main{padding:0}.act{display:none}.stat,table{border-color:#ccc}'
    + '.stat,.stat.hot{border-width:1px}tr{break-inside:avoid}}'
    + '</style></head><body><main>'
    + '<div class="head"><div><h1>' + esc(st.shop_name || handle) + '</h1>'
    + '<p class="sub">Settlement statement · ' + esc(nice) + ' · ' + esc(cur) + '</p></div>'
    + '<div class="sub">' + esc(handle) + '<br>prepared by Tapstall</div></div>'
    + '<div class="stats">'
    + stat('expected from orders', money(t.expected))
    + stat('matched in the ledger', money(t.matched), 'hot')
    + stat('to chase', money(t.awaiting_match), t.awaiting_match > 0 ? 'warn' : '')
    + stat('refunded', money(t.refunded))
    + stat('rail fees recorded', money(t.fees))
    + stat('net', money(t.net))
    + '</div>'
    + (nothing
      ? '<div class="todo"><b>Nothing on this day</b>No order and no payment was recorded on ' + esc(day) + '. Pick another day below — a statement with zeros in it is not a statement that something went wrong.</div>'
      : '<div class="todo"><b>One thing to do today</b>' + esc(doc.note) + '</div>')
    + '<h2>By rail</h2>'
    + '<table><thead><tr><th>rail</th><th class="n">orders</th><th class="n">expected</th><th class="n">matched</th><th class="n">to chase</th><th class="n">fees</th></tr></thead>'
    + '<tbody>' + (railRows || '<tr><td colspan="6" class="sub">No rail activity recorded.</td></tr>') + '</tbody></table>'
    + '<h2>The two facts this page is built on</h2>'
    + '<p class="sub"><b>Expected</b> is what the order book says buyers owed. <b>Matched</b> is what the shop recorded as actually received against an order. They are kept apart on purpose: a rail that shows a payment is not the same thing as money in the shop’s account, and this page never calls one the other.</p>'
    + '<div class="act"><a class="pri" href="' + esc(csv) + '" download>Download this day as CSV</a>'
    + '<a href="' + esc(base + '?day=' + prev) + '">← ' + esc(prev) + '</a>'
    + '<a href="' + esc(base + '?day=' + next) + '">' + esc(next) + ' →</a>'
    + '<a href="javascript:print()">Print or save as PDF</a></div>'
    + '<p class="foot">Every rail on this statement paid the shop directly. Tapstall does not hold the money, does not pay it out and does not convert it — it reads what the shop recorded and does the arithmetic. '
    + 'Rows stay available for five years. A rail that is missing from this page has no payments recorded against it, which is a fact worth checking rather than a gap in the arithmetic.</p>'
    + '</main></body></html>', 200, { 'Cache-Control': 'no-store' });
}

async function settleEvent(req, url, env) {
  const b = await readBody(req);
  const handle = slug(b.handle || url.searchParams.get('handle') || '');
  const g = await adminGate(req, env, handle);
  if (g.res) return g.res;
  let event;
  try {
    event = paymentEvent({
      kind: b.kind, amount: b.amount, order: b.order, rail: b.rail, reference: b.reference,
      note: b.note, evidence: b.evidence, by: 'merchant', at: b.at,
    });
  } catch (e) {
    return json({ ok: false, error: 'bad_event', note: String(e.message || e) + '. Kinds: ' + PAY_EVENTS.join(', ') + '.' }, 422);
  }
  const res = await payWrite(env, handle, event);
  const rows = await ledgerRows(env, handle);
  const events = await payEvents(env, handle, { day: new Date(event.at).toISOString().slice(0, 10) });
  return json({ ok: true, wrote: res.wrote, event,
    statement: settlement(rows, events, { day: new Date(event.at).toISOString().slice(0, 10) }) },
    200, { 'Cache-Control': 'no-store' });
}

/** The rails this shop can actually offer, in one shape — built-ins, the operator's KV extras and
 *  any processor we hold credentials for. Vetting rides along because a cross-border leg without
 *  it is a promise made with somebody else's licence. */
async function railView(req, url, env) {
  const handle = slug(url.searchParams.get('handle') || '');
  const g = await adminGate(req, env, handle);
  if (g.res) return g.res;
  const st = g.who.st;
  const extras = (env.STORES ? await env.STORES.get('rails:extra', 'json').catch(() => null) : null) || st.rails_extra || {};
  const collect = {};
  for (const key of Object.keys(COLLECT_PROVIDERS)) {
    if (env['NOWPAYMENTS_API_KEY'] && key === 'nowpayments') collect[key] = { label: COLLECT_PROVIDERS[key].label, type: 'collect', ipn: true, presentable: true };
  }
  const vetAnswers = (env.STORES ? await env.STORES.get('vet:' + handle, 'json').catch(() => null) : null) || {};
  const vet = vettingPlan(st, vetAnswers);
  const cat = railCatalogue({ coreRails: RAILS, extras, collect });
  return json({
    ok: true, handle, rails: cat,
    store_rails: Object.keys(st.rails || {}).length ? st.rails : null,
    vet,
    collect_ready: Object.keys(collect).length > 0 && vet.can_collect_cross_border,
    note: 'A rail is data, not code: the operator can add one to KV (rails:extra) and a shop can describe the one its buyers already use. We never touch the money, so a rail only has to answer what the buyer dials and how the payment is proven.',
  }, 200, { 'Cache-Control': 'no-store' });
}

async function railVet(req, url, env) {
  const b = await readBody(req);
  const handle = slug(b.handle || url.searchParams.get('handle') || '');
  const g = await adminGate(req, env, handle);
  if (g.res) return g.res;
  if (!env.STORES) return json({ ok: false, error: 'no_store_kv' }, 503);
  const cur = (await env.STORES.get('vet:' + handle, 'json').catch(() => null)) || {};
  const answers = (b.answers && typeof b.answers === 'object') ? b.answers : {};
  const next = { ...cur };
  for (const [k, v] of Object.entries(answers)) {
    if (!k || k.length > 24) continue;
    next[k] = (v && typeof v === 'object') ? { ok: !!v.ok, at: Date.now(), evidence: String(v.evidence || '').slice(0, 160) }
      : { ok: !!v, at: Date.now(), evidence: '' };
  }
  await env.STORES.put('vet:' + handle, JSON.stringify(next));
  return json({ ok: true, vet: vettingPlan(g.who.st, next) }, 200, { 'Cache-Control': 'no-store' });
}

/** Cross-border collect: a price locked server-side, an invoice the processor issues, and no
 *  money of ours anywhere in the flow. Refuses honestly when the key is not configured rather
 *  than pretending the leg exists. */
async function collectInvoice(req, url, env) {
  const b = await readBody(req);
  const handle = slug(b.handle || url.searchParams.get('handle') || '');
  const g = await adminGate(req, env, handle);
  if (g.res) return g.res;
  const key = env.NOWPAYMENTS_API_KEY;
  if (!key) return json({ ok: false, error: 'collect_not_configured',
    note: 'No processor key is set, so this shop cannot be offered a cross-border leg yet. Nothing was charged and nothing was promised.' }, 503);
  const vet = vettingPlan(g.who.st, (await env.STORES.get('vet:' + handle, 'json').catch(() => null)) || {});
  if (!vet.can_collect_cross_border) return json({ ok: false, error: 'vetting_incomplete', missing: vet.missing, note: vet.note }, 409);
  const want = String(b.order || '').slice(0, 60);
  const rows = await ledgerRows(env, handle);
  const row = rows.find((r) => r && (String(r.id) === want || String(r.code || '').toLowerCase() === want.toLowerCase()));
  if (!row) return json({ ok: false, error: 'no_such_order', note: 'Only this shop’s own orders can be invoiced, and the amount must come from the order — never from the page.' }, 404);
  const draft = collectInvoiceDraft({
    provider: 'nowpayments', amount: Number(row.pay_now || row.total), order: String(row.code || row.id),
    description: (g.who.st.shop_name || 'Shop') + ' — order ' + (row.code || row.id),
    ipnUrl: url.origin + '/api/hook/nowpayments?h=' + encodeURIComponent(handle),
    payCurrency: b.pay_currency,
  });
  if (!draft.ok) return json(draft, 422);
  const res = await fetch('https://api.nowpayments.io/v1/invoice', {
    method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(draft.payload),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.invoice_url) {
    return json({ ok: false, error: 'processor_refused', status: res.status,
      note: 'The processor did not issue an invoice. No money moved and the order is unchanged.',
      detail: String(out.message || out.error || '').slice(0, 200) }, 502);
  }
  return json({ ok: true, invoice_url: out.invoice_url, id: out.id, order: draft.payload.order_id,
    amount: draft.payload.price_amount, currency: draft.payload.price_currency,
    tolerance_pct: draft.tolerance_pct, expires_in_min: draft.expires_in_min,
    note: 'Send this link to the buyer. The processor is the counterparty and pays the merchant directly; Tapstall holds no balance and makes no payout.' },
    200, { 'Cache-Control': 'no-store' });
}

/** The webhook: a claim until the signature checks out on the raw body. It writes a ledger
 *  event, not a payment — the shop still closes the order, and the statement shows why. */
async function hookNowPayments(req, url, env) {
  const handle = slug(url.searchParams.get('h') || '');
  const st = handle ? await getStore(env, handle) : null;
  if (!st) return json({ ok: false, error: 'no_store' }, 404);
  const raw = await req.text();
  const sig = req.headers.get('x-nowpayments-sig') || req.headers.get('x-nowpayments-signature');
  const check = await verifyWebhook(env.NOWPAYMENTS_IPN_SECRET, raw, sig);
  if (!check.ok) return json({ ok: false, error: check.reason }, check.reason === 'no_secret_configured' ? 503 : 401);
  let body = {};
  try { body = JSON.parse(raw); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
  const paid = Number(body.actually_paid || body.price_amount || 0);
  const price = Number(body.price_amount || 0);
  const s = collectSettlement({ price, paid, status: body.payment_status });
  const order = String(body.order_id || '');
  const event = paymentEvent({
    kind: s.ok ? 'seen' : 'unmatched',
    amount: s.ok ? price : paid,
    order,
    rail: 'collect:nowpayments',
    reference: String(body.payment_id || ''),
    by: 'processor',
    note: s.ok ? 'Processor reports ' + String(body.payment_status) + '. The shop still closes the order.' : 'Processor says ' + s.reason + '; a human decides what to do.',
    evidence: { type: 'ipn', ref: String(body.payment_id || '') },
  });
  const res = await payWrite(env, handle, event);
  return json({ ok: true, wrote: res.wrote, settled: s.ok, reason: s.reason, shortfall: s.shortfall || 0,
    note: 'Recorded as a ledger event only. Nothing was marked paid automatically: an IPN is the processor’s word, and the shop’s confirmation is still the thing that closes an order.' });
}

async function receiptView(req, url, env) {
  const handle = slug(url.searchParams.get('handle') || '');
  const g = await adminGate(req, env, handle);
  if (g.res) return g.res;
  const st = g.who.st;
  const want = String(url.searchParams.get('order') || url.searchParams.get('id') || '').trim().slice(0, 60);
  if (!want) return json({ ok: false, error: 'order_required', note: 'Pass ?order=<order id or code>.' }, 422);
  const rows = await ledgerRows(env, handle);
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
  const mf = meshFacts(st, url.origin);
  const pack = meshPack(st, products, mf, { origin: url.origin, sent: state || {} });
  const pressQueue = ((await env.ORDERS.get('press:queue:' + handle, 'json').catch(() => null)) || {}).items || [];
  return json({
    ok: true, handle, plan: pack, rails: meshRailsTotal((pack && pack.beats) || []), budget: MESH_BUDGET,
    state_saved: !!state, posted: state ? (state.sent || {}) : {},
    auto: { on: !!(state && state.auto && state.auto.on), at: (state && state.auto && state.auto.at) || null,
      flips: (state && state.auto && state.auto.flips) || 0, policy: MESH_AUTONOMY },
    growth: meshGrowth(st, await ledgerRows(env, handle, 200)),
    // v0.9.3: the plan is the machine's own work list, and the touch queue is the first half of a
    // conversation. Neither of them waits on an approval; both of them hand the reply to a person.
    schedule: meshSchedule(st, products, mf || meshFacts(st, url.origin), { origin: url.origin, state: state || {}, now: Date.now() }),
    touch: meshFirstTouch(st, await ledgerRows(env, handle, 200)),
    channels: MESH_CHANNELS, policy_v3: MESH_AUTONOMY_V3,
    publish: MESH_PUBLISH, buffer_free: MESH_BUFFER_FREE, drip: MESH_DRIP,
    rail_health: meshRailHealth(state || {}),
    press: (function () { const pr = meshPress(st, env); const q = pressQueue; return {
      channels: pr.channels, has_token: pr.has_token, token_from: pr.token_from, missing: pr.missing,
      cadence: pr.cadence || MESH_QUEUE_DEFAULTS, stored_in: pr.stored_in, queued: q }; })(),
    drip_plan: meshDrip(((meshFirstTouch(st, await ledgerRows(env, handle, 200)) || {}).queue) || [], state || {}), rails: { ...MESH_RAILS, ...Object.fromEntries(Object.keys(MESH_CHANNELS).filter((c) => !MESH_RAILS[c]).map((c) => [c, { name: c, max: MESH_CHANNELS[c].max }])) },
    account: meshAccount(st), rails_available: Object.keys(MESH_CHANNELS),
    outreach: meshOutreachPlan(st, { leads: st.outreach_list || [], state: state || {} }),
    card_url: (url.origin || '') + '/s/' + handle + '/mesh.json',
    note: 'Nothing here is sent anywhere. Tap Copy, then post it yourself — the pack is rebuilt from your menu each morning, so a price that moved today is not in a post you make tomorrow.',
  }, 200, { 'Cache-Control': 'no-store' });
}

/** The grant. A merchant turning the mesh on is one save, and turning it off is the same save the
 *  other way — which is what makes it safe to stop asking for approval per post: the thing being
 *  authorised is a policy with a ceiling, not an inbox. */
/* v0.9.5: press intake and flush. `press` records what an account posts *through* — Buffer channel ids,
 * a board, a cadence override, and optionally the token itself (env wins; KV is theirs to delete).
 * `publish` composes today's plan into hunta's own queue format and sends what is due: with no credential
 * an item says `queued` and nothing more, with one it calls Buffer and keeps the answer. `dry=1` returns
 * the exact payload without sending anything, so a live distribution test can be run before a token is
 * handed over. A rail that fails twice is dropped from cadence by itself; nothing here asks for a tap. */
/* ── v0.9.6: the press registry and the run, for company accounts and delegated sellers ─────────
 * `accounts` registers an identity (owner, or seller:<name>) with its channel ids and the name of the
 * env secret that holds its token; it refuses an id that belongs to a shop, refuses any class but
 * owner/seller, and refuses a secret in the body. `run` composes for each identity, queues in the
 * pipeline's own format, sends what is due, and writes the outcome where rail health is judged from.
 * An operator's shop cannot be reached by either route: the registry has no shape for one, and the id
 * list it refuses is read from the shops themselves. */
async function pressAdmin(req, env) {
  const secret = String((reqHeader(req, 'x-tapstall-admin') || '')).trim();
  if (!secret || !env.ADMIN_SECRET || secret !== String(env.ADMIN_SECRET)) return json({ ok: false, error: 'admin secret required' }, 401);
  if ((reqHeader(req, 'x-tapstall-confirm') || '') !== '1') return json({ ok: false, error: 'missing x-tapstall-confirm header' }, 403);
  return null;
}
async function pressRegistry(env) {
  return cached('press:registry', 5 * 60e3, async () => {
    const raw = await env.STORES.get('press:registry', 'json').catch(() => null);
    quotaNote('reads', 'operator');
    return (raw && typeof raw === 'object') ? raw : {};
  });
}
async function pressShopIds(env) {
  const ids = [];
  try {
    const list = await env.STORES.list({ prefix: 'store:' });
    for (const k of ((list && list.keys) || [])) ids.push(String(k.name || '').replace(/^store:/, '').toLowerCase());
  } catch (e) { /* a failed list makes the guard looser, so it is said, not hidden */ }
  return ids;
}
async function pressAccounts(req, env) {
  const denied = await pressAdmin(req, env); if (denied) return denied;
  const b = await readBody(req).catch(() => ({}));
  const reg = await pressRegistry(env);
  const act = String(b.action || 'list');
  if (act === 'list') {
    const masked = {};
    for (const [id, e] of Object.entries(reg)) masked[id] = { class: e.class, token_env: e.token_env, rails: Object.keys(e.rails || {}), rail_state: pressRailState(env, e, id),
      channel_ids: Object.fromEntries(Object.entries(e.rails || {}).map(([k, v]) => [k, String(v.channel_id || '').slice(0, 6) + (v.channel_id ? '…' : '')])), source: e.source || {} };
    return json({ ok: true, action: 'list', classes: MESH_ID_CLASSES, identities: masked, defaults: MESH_ID_RAIL_DEFAULTS,
      note: 'tokens are never stored here: they are the named env secret, so a departed seller is one secret change, not an edit to a document' });
  }
  if (act === 'forget') {
    const id = String(b.id || '').toLowerCase();
    if (!reg[id]) return json({ ok: false, error: 'no such identity' }, 404);
    delete reg[id];
    try { await env.STORES.put('press:registry', JSON.stringify(reg)); quotaNote('writes', 'operator'); memSet('press:registry', reg, 5 * 60e3); } catch (e) { return json({ ok: false, error: 'no writes left to forget it', why: String(e && e.name || e) }, 503); }
    return json({ ok: true, action: 'forget', id: id, left: Object.keys(reg).length, note: 'removed here; the provider password change is what actually stops them' });
  }
  const guard = await pressShopIds(env);
  const res = meshRegister(reg, b, { refuse_ids: guard, now: Date.now() });
  if (!res.ok) return json(Object.assign({ refused_because: 'a shop on the platform is an operator, and the platform does not post to an operator socials in any shape' }, res), 400);
  try { await env.STORES.put('press:registry', JSON.stringify(reg)); quotaNote('writes', 'operator'); memSet('press:registry', reg, 5 * 60e3); } catch (e) { return json({ ok: false, error: 'no writes left to save the registry', why: String(e && e.name || e) }, 503); }
  return json({ ok: true, action: 'register', id: res.id, identity: { class: res.identity.class, token_env: res.identity.token_env,
    rails: Object.keys(res.identity.rails), has_token_in_env: !!env[res.identity.token_env] }, count: res.count });
}
/** The env names a direct credential answers to, per identity: PRESS_<TAG>_BLUESKY_APP_PASSWORD,
 *  PRESS_<TAG>_TELEGRAM_BOT_TOKEN, … where TAG is the identity id upper-cased and stripped
 *  (owner → OWNER, seller:a → SELLERA). The registry keeps only handles and channel ids; the
 *  secrets themselves live where secrets live, so offboarding a seller is deleting their secret. */
function directCredsFor(env, e, id) {
  const tag = String(id || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const rails = (e && e.rails) || {};
  const out = {};
  const bskyPw = env['PRESS_' + tag + '_BLUESKY_APP_PASSWORD'] || env.PRESS_BLUESKY_APP_PASSWORD || '';
  const bskyHandle = env['PRESS_' + tag + '_BLUESKY_HANDLE'] || (rails.bluesky && rails.bluesky.handle) || env.PRESS_BLUESKY_HANDLE || '';
  if (bskyHandle || bskyPw) out.bluesky = { handle: String(bskyHandle), app_password: String(bskyPw) };
  const tgTok = env['PRESS_' + tag + '_TELEGRAM_BOT_TOKEN'] || env.PRESS_TELEGRAM_BOT_TOKEN || '';
  const tgChat = env['PRESS_' + tag + '_TELEGRAM_CHAT_ID'] || (rails.telegram && rails.telegram.channel_id) || '';
  if (tgTok || tgChat) out.telegram = { bot_token: String(tgTok), chat_id: String(tgChat) };
  return out;
}

/** v2.0.0 armed mesh. A registered rail is `active` only when the credential it sends with is bound;
 *  until then it reads "on (waiting for account)" and names the secrets that switch it on. The press
 *  composes and queues only for active rails, so an identity with no accounts yet costs no KV write
 *  and no queue that fills and expires. Rails with no sender in this Worker (nostr, mastodon, devto)
 *  say so instead of pretending to be waiting. */
const PRESS_SENDERS = { bluesky: 'direct', telegram: 'direct', x: 'buffer', linkedin: 'buffer', pinterest: 'buffer' };
function pressRailState(env, e, id) {
  const tag = String(id || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const rails = (e && e.rails) || {};
  const d = directCredsFor(env, e, id);
  const out = {};
  for (const [rail, r] of Object.entries(rails)) {
    const via = PRESS_SENDERS[rail];
    let armed = false, secrets = [];
    if (!via) { out[rail] = { status: 'no sender', needs: 'this Worker has no sender for ' + rail }; continue; }
    if (rail === 'bluesky') {
      armed = !!(d.bluesky && d.bluesky.handle && d.bluesky.app_password);
      secrets = ['PRESS_' + tag + '_BLUESKY_HANDLE', 'PRESS_' + tag + '_BLUESKY_APP_PASSWORD'];
    } else if (rail === 'telegram') {
      armed = !!(d.telegram && d.telegram.bot_token && d.telegram.chat_id);
      secrets = ['PRESS_' + tag + '_TELEGRAM_BOT_TOKEN', 'PRESS_' + tag + '_TELEGRAM_CHAT_ID'];
    } else {
      armed = !!(env[e.token_env] && r && r.channel_id);
      secrets = [e.token_env, '(and the Buffer channel id, registered on the identity)'];
    }
    out[rail] = armed ? { status: 'active' } : { status: 'on (waiting for account)', needs: (r && r.needs) || '', secrets };
  }
  return out;
}

/** One press window, callable by the clock as readily as by a person: compose for each identity,
 *  queue in the pipeline's own format, send what is due, write the outcome where rail health is
 *  judged from. This is the function the cron runs (v1.0.0) — the HTTP door below is an override
 *  and a diagnostic, never the trigger, because a batch that waits for a tap is a queue that
 *  grows behind one person's attention. */
async function runPress(env, origin, opt) {
  const o = opt || {};
  const dry = !!o.dry;
  const reg = await pressRegistry(env);
  const only = o.id ? [String(o.id).toLowerCase()] : null;
  const out = [];
  for (const id of (only || Object.keys(reg))) {
    const e = reg[id];
    if (!e) { out.push({ id, ok: false, error: 'not registered' }); continue; }
    const railState = pressRailState(env, e, id);
    const armedRails = Object.keys(railState).filter((r) => railState[r].status === 'active');
    if (!armedRails.length) { out.push({ id, class: e.class, ok: true, skipped: true, why: 'no rail has an account yet', rails: railState }); continue; }
    const press = { channels: Object.fromEntries(Object.entries(e.rails || {}).map(([k, v]) => [v.channel || k, v.channel_id || ''])),
      handles: Object.fromEntries(Object.entries(e.rails || {}).map(([k, v]) => [v.channel || k, String(v.handle || '')])),
      buffer_token: env[e.token_env] || '', board: (e.rails && e.rails.pinterest && e.rails.pinterest.board) || '',
      direct: directCredsFor(env, e, id) };
    let plan;
    if (e.source && e.source.store) {
      const doc = await env.STORES.get('store:' + e.source.store, 'json').catch(() => null) || {};
      const products = (doc.feed_cache && doc.feed_cache.products) || [];
      const sp = meshSchedule(Object.assign({}, doc, { mesh_class: e.class }), products, meshFacts(doc, origin),
        { origin: origin, state: { auto: { on: true } }, now: Date.now() });
      plan = meshIdentityPlan(Object.assign({ id: id }, e), sp, { price_usd: PRICE_USD, free_days: FREE_DAYS, feed_ok: true, price_ok: true }, { origin: origin, now: Date.now() });
    } else {
      plan = meshCompanyBeats(e, { price_usd: PRICE_USD, free_days: FREE_DAYS, feed_ok: true, price_ok: true }, { origin: origin, now: Date.now() });
    }
    const idRails = armedRails;
    // v1.5.3: a day's beats belong to fixed clock slots, so the same beat is the same item at every
    // tick of the day — and a slot missed by more than the grace window is skipped, not dumped late.
    const items = (plan.beats || []).filter((beat, i) => !contentSlotMissed(Date.now(), i)).map((beat, i) => meshQueueItem(Object.assign({}, beat, { seq: i, to: idRails.length ? idRails : (beat.to || []) }), { landing: origin + '/fees', store: id, now: Date.now(),
      channel_id: ((e.rails || {})[beat.rail] || {}).channel_id || press.channels[beat.rail] || '', board: press.board, no_links: e.class === 'seller',
      due_at: contentSlotDue(Date.now(), i) }));
    const prevQ = await env.ORDERS.get('press:queue:' + id, 'json').catch(() => null) || {};
    const expiredQ = Array.isArray(prevQ.items) ? meshQueueExpire(prevQ.items.map((it) => applyContentLinkPolicy(it, e.class)), { now: Date.now() }) : { items: [], expired: [] };
    prevQ.items = expiredQ.items;
    const merged = meshQueueMerge(prevQ, items, { store: id, landing: origin + '/fees', cadence: e.cadence || MESH_QUEUE_DEFAULTS });
    // v1.5.3: the record of what actually went out, read before composing and written after
    // sending, so a queue write that lagged a good send can never post the same words twice.
    const postedLog = await env.ORDERS.get('press:posted', 'json').catch(() => null);
    // First tick after the guard was armed: seed it from the rail ledger this identity already keeps,
    // so a queue that lagged behind its own good send is not allowed one last repeat.
    const seenLog = Object.assign({}, postedLog || {});
    if (!postedLog) {
      const st = await env.ORDERS.get('press:state:' + id, 'json').catch(() => null);
      for (const [ch, v] of Object.entries((st && st.rails) || {})) {
        if (v && v.ok && v.id) seenLog[ch + '|' + v.id] = { at: v.at || new Date().toISOString(), channel: ch, id: v.id, seeded: true };
      }
    }
    // a beat already marked as said today is not re-queued at all: the queue stays empty instead of
    // being refilled and drained every twenty minutes
    const fresh = merged.items.filter((it) => !contentPosted(seenLog, contentPostKey(it), { now: Date.now() }));
    const settledEarlier = merged.items.length - fresh.length;
    const flush = await meshPressFlush(fresh, press, { dry: dry, now: Date.now(), posted: seenLog });
    const settled = new Set(flush.results.filter((r) => r.status === 'sent' || r.status === 'duplicate').map((r) => r.id));
    const keptItems = fresh.filter((i) => !settled.has(i.id));
    const hadQueueDoc = Array.isArray(prevQ.items);
    const queueChanged = JSON.stringify(((prevQ && prevQ.items) || [])) !== JSON.stringify(keptItems);
    if (!dry && (queueChanged || !hadQueueDoc)) {
      try { await governedPut(env.ORDERS, 'press:queue:' + id, JSON.stringify({ store: id, landing: origin + '/fees', at: new Date().toISOString(), items: keptItems }), null, 'automation'); } catch (e2) { /* a full queue is not worth failing the run for */ }
    }
    if (!dry && Array.isArray(flush.posted) && flush.posted.length) {
      const next = Object.assign({}, postedLog || {});
      for (const m of flush.posted) next[m.key] = { at: m.at, channel: m.channel, id: m.id };
      try { await governedPut(env.ORDERS, 'press:posted', JSON.stringify(contentPostedPrune(next, { now: Date.now() })), null, 'automation'); } catch (e2) { /* the send already happened; the queue still removes it */ }
    }
    const prevState = await env.ORDERS.get('press:state:' + id, 'json').catch(() => null);
    const ledger = meshPressLedger(prevState, flush.results, { now: Date.now() });
    const stateChanged = flush.results.some((r) => r.status === 'sent' || r.status === 'failed');
    if (!dry && stateChanged) {
      try { await governedPut(env.ORDERS, 'press:state:' + id, JSON.stringify(ledger), null, 'automation'); } catch (e2) { /* same */ }
    }
    out.push({ id, class: e.class, ok: true, dry: dry, composed: (plan.beats || []).length, in_slot: items.length,
      skipped_slots: (plan.beats || []).length - items.length, queued_now: merged.added, dropped: merged.dropped.length,
      sent: flush.sent, waiting: flush.waiting, duplicates: (flush.duplicates || 0) + settledEarlier,
      expired_slots: expiredQ.expired.length, token_env: e.token_env, token_present: !!press.buffer_token,
      results: flush.results.map((r) => ({ channel: r.channel, status: r.status, due: r.due, err: r.err || r.note || '' })),
      material: plan.source, fallback_from: plan.fallback_from || '', rail_health: meshRailHealth(ledger), rails: railState });
  }
  return out;
}

async function pressRun(req, env) {
  const denied = await pressAdmin(req, env); if (denied) return denied;
  const b = await readBody(req).catch(() => ({}));
  const dry = b.dry === true;
  const out = await runPress(env, new URL(req.url).origin, { dry, id: b.id });
  return json({ ok: true, dry: dry, identities: out.length, ran: out,
    note: dry ? 'dry: the exact items and the exact Buffer call, sent to nobody'
      : 'sent where the env secret existed, queued where it did not; nothing is counted as posted unless the platform answered. The cron window runs this on its own — this door is an override, never the trigger.' });
}

async function meshPressSet(req, env) {
  const b = await readBody(req);
  const who = await identify(req, env, b.handle || urlHandle(req));
  if (!who || !who.st) return json({ ok: false, error: 'no store' }, 404);
  if (who.anonymous || who.bad) return json({ ok: false, need_login: true, error: 'sign in first' }, 401);
  if ((reqHeader(req, 'x-tapstall-confirm') || '') !== '1') return json({ ok: false, error: 'missing x-tapstall-confirm header' }, 403);
  const doc = who.st, handle = doc.handle || who.handle;
  const next = Object.assign({}, (doc.press && typeof doc.press === 'object') ? doc.press : {});
  if (b.channels && typeof b.channels === 'object') {
    next.channels = Object.assign({}, next.channels || {});
    for (const k of Object.keys(b.channels)) {
      const v = String(b.channels[k] || '');
      if (!v) delete next.channels[k]; else next.channels[k] = v.slice(0, 40);
    }
  }
  for (const k of ['board', 'image_base', 'landing']) if (typeof b[k] === 'string') next[k] = b[k].slice(0, 120);
  if ('buffer_token' in b) return json({ ok: false, error: 'secrets are never stored in KV: bind PRESS_BUFFER_TOKEN as a Worker secret (or the identity secret in the press registry) and this wiring uses it without holding it' }, 400);
  delete next.buffer_token;   // clear one saved by the old shape, so a stale credential cannot linger in a document every handler can read
  if (b.cadence && typeof b.cadence === 'object') next.cadence = b.cadence;
  doc.press = next;
  try { await writeStore(env, doc); }
  catch (e) { return json({ ok: false, error: 'no writes left to save the wiring', why: String(e && e.name || e) }, 503); }
  const pr = meshPress(doc, env);
  return json({ ok: true, handle, channels: Object.keys(next.channels || {}), has_token: pr.has_token, token_from: pr.token_from,
    missing: pr.missing, stored_in: pr.stored_in, note: 'Wired. Nothing has been posted yet: that is /api/mesh/publish, and dry=1 first.' });
}
async function meshPublish(req, env) {
  const b = await readBody(req).catch(() => ({}));
  const who = await identify(req, env, b.handle || urlHandle(req));
  if (!who || !who.st) return json({ ok: false, error: 'no store' }, 404);
  if (who.anonymous || who.bad) return json({ ok: false, need_login: true, error: 'sign in first' }, 401);
  const origin = new URL(req.url).origin;
  const dry = b.dry === true || new URL(req.url).searchParams.get('dry') === '1';
  if (!dry && (reqHeader(req, 'x-tapstall-confirm') || '') !== '1') return json({ ok: false, error: 'a real send needs the confirm header' }, 403);
  const doc = who.st, handle = doc.handle || who.handle;
  const products = (doc.feed_cache && doc.feed_cache.products) || [];
  const facts = meshFacts(doc, origin);
  const state = await env.ORDERS.get('mesh:' + handle, 'json').catch(() => null);
  const plan = meshSchedule(doc, products, facts, { origin: origin, state: state || {}, now: Date.now() });
  const pr = meshPress(doc, env);
  const items = (plan.beats || []).map((beat, i) => meshQueueItem({ ...beat, seq: i }, {
    landing: origin + '/s/' + handle, store: handle, now: Date.now(),
    channel_id: (pr.channels || {})[MESH_BUFFER_CHANNEL[beat.rail] || beat.rail] || '', board: pr.board,
    image: pr.image_base && beat.image ? String(pr.image_base) + String(beat.image) : '' }));
  const prevQ = await env.ORDERS.get('press:queue:' + handle, 'json').catch(() => null) || {};
  if (Array.isArray(prevQ.items)) prevQ.items = prevQ.items.map((it) => applyContentLinkPolicy(it, 'operator'));
  const merged = meshQueueMerge(prevQ, items, { store: handle, landing: origin + '/s/' + handle, cadence: pr.cadence || MESH_QUEUE_DEFAULTS });
  const flush = await meshPressFlush(merged.items, pr, { dry: dry, now: Date.now() });
  const sent = new Set(flush.results.filter((r) => r.status === 'sent').map((r) => r.id));
  const kept = merged.items.filter((i) => !sent.has(i.id));
  if (!dry && JSON.stringify(((prevQ && prevQ.items) || [])) !== JSON.stringify(kept)) {
    try { await governedPut(env.ORDERS, 'press:queue:' + handle, JSON.stringify({ store: handle, landing: origin + '/s/' + handle, at: new Date().toISOString(), items: kept }), null, 'automation'); } catch (e) { /* a full queue is not worth failing the run for */ }
  }
  const rails = Object.assign({}, (state && state.rails && typeof state.rails === 'object') ? state.rails : {});
  let railsChanged = false;
  for (const r of flush.results) {
    if (r.status === 'sent') { rails[r.channel] = { ok: true, fails: 0, at: new Date().toISOString() }; railsChanged = true; }
    else if (r.status === 'failed') { rails[r.channel] = { ok: false, fails: (Number((rails[r.channel] || {}).fails) || 0) + 1, at: new Date().toISOString(), err: r.err || r.note }; railsChanged = true; }
  }
  if (!dry && railsChanged) {
    try { await governedPut(env.ORDERS, 'mesh:' + handle, JSON.stringify({ ...(state || {}), rails }), null, 'automation'); } catch (e) { /* same: report, do not break */ }
  }
  return json({ ok: true, handle, dry: dry, class: meshAccount(doc).class, socials: meshAccount(doc).socials,
    composed: items.length, queued_now: merged.added, dropped: merged.dropped, still_queued: kept.length,
    flush: { sent: flush.sent, queued: flush.queued, waiting: flush.waiting, results: flush.results },
    rail_health: meshRailHealth({ rails }), auto: plan.on,
    items: items.map((i) => ({ id: i.id, channel: i.channel, due: i.due, chars: String(i.text).length, link: !!i.link })),
    note: dry ? 'dry run: the exact items and the exact call, sent to nobody'
      : 'sent where a credential existed, queued where it did not; a rail that fails twice leaves the cadence on its own' });
}

async function meshAuto(req, env) {
  const b = await readBody(req);
  const who = await identify(req, env, b.handle || urlHandle(req));
  if (!who || !who.st) return json({ ok: false, error: 'no store' }, 404);
  if (who.anonymous || who.bad) return json({ ok: false, need_login: true, error: 'sign in first' }, 401);
  if (who.via === 'sess' && (reqHeader(req, 'x-tapstall-confirm') || '') !== '1') {
    return json({ ok: false, error: 'missing x-tapstall-confirm header' }, 403);
  }
  const prev = await env.ORDERS.get('mesh:' + who.st.handle, 'json').catch(() => null);
  const next = meshGrant(prev, b.on === true, Date.now());
  try {
    await env.ORDERS.put('mesh:' + who.st.handle, JSON.stringify(next));
  } catch (e) {
    return json({ ok: false, error: 'no_writes_left', on: next.auto.on,
      note: 'The grant could not be saved today: the write budget is spent. Nothing started or stopped — '
        + 'a mesh that cannot persist its own switch has not moved it.' }, 503);
  }
  return json({ ok: true, auto: next.auto, policy: MESH_AUTONOMY,
    note: next.auto.on ? 'Publishing value lines within the cap. No price, no link, no offer, ever — and '
      + 'the cap is two a day.' : 'Stopped. The plan reverts to copy-and-tap, and nothing else changes.' });
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
  const touched = Object.keys(next.over).length + next.hide.length + next.extra.length + next.del.length + (next.order.length ? 1 : 0);
  if (!touched) delete st.menu; else st.menu = next;
  // A shop with no sheet has no cached shelf either — not after a save. The loader
  // already refuses to read it; this is the same refusal said to the one other place
  // that looks (ops' feed columns), so a promoted-starter row cannot be double-counted
  // as both "authored" and "from the feed" by two surfaces with two truths.
  if (isPlaceholderFeed(st.feed_url) && st.feed_cache && (st.feed_cache.products || []).length) {
    st.feed_cache = { at: Date.now(), products: [], count: 0, error: 'no_feed' };
  }
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
  const noSheet = isPlaceholderFeed(st.feed_url);
  return json({
    ok: true, edits: touched, items: eff.length,
    note: noSheet
      ? (touched
        ? 'Saved — and here, saved is the menu: no sheet sits under it, so what you typed is what buyers get, deletes and all.'
        : 'The menu is empty now. With no sheet to fall back on, the store page shows “no items yet” until you add one — or link a sheet and its rows become the base.')
      : touched
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
const imageSweepAt = new Map();
async function pruneImages(env, st, before) {
  const prefix = 'img:' + st.handle + ':';
  const keep = referencedImages(st);
  let gone = 0;
  const dropped = new Set(Array.from(before || []).filter((ref) => !keep.has(ref) && ref.indexOf('/i/') === 0));
  for (const ref of dropped) {
    try { await governedDelete(env.STORES, prefix + String(ref).split('/').pop(), 'operator'); gone++; }
    catch (e) { /* the day's delete budget; the sweep below or a later save tries again */ }
  }
  // A save that already named the dropped refs does not need a janitor list:
  // it knew exactly what to delete. The full sweep (for uploads abandoned
  // before Save) runs when a count is actually needed — no `before` set —
  // and otherwise at most once a day per shop in this isolate.
  const lastSweep = imageSweepAt.get(st.handle) || 0;
  if (before && Date.now() - lastSweep < 24 * 3600e3) return keep.size;
  imageSweepAt.set(st.handle, Date.now());
  let keys = [];
  try {
    const r = await env.STORES.list({ prefix, limit: 1000 });
    quotaNote('lists', 'operator');
    keys = (r && r.keys) || [];
  } catch (e) { return dropped.size ? keep.size : 0; }
  let live = 0;
  for (const k of keys) {
    const id = String(k.name).slice(prefix.length);
    const ref = imgRefOf(st.handle, id);
    if (keep.has(ref)) live++;
    else if (!dropped.has(ref)) { try { await governedDelete(env.STORES, k.name, 'telemetry'); gone++; } catch (e) { /* budget; next save tries again */ } }
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
 * The forgotten-PIN path, v2.0.0. The old one accepted the owner email (or the public WhatsApp
 * number) plus a "second detail" that, for a shop with no pay account and no menu link, was the
 * owner email again: one guessable fact took over a store and its payout account. Now:
 *   1. {key} alone -> a one-hour, single-use link goes to the email on file (bound to the PIN
 *      and the session generation, so it dies the moment the PIN changes). The response shows
 *      only a masked address.
 *   2. {cap, new_pin} -> the link's page sets the PIN.
 *   3. Shops with no email: the store WhatsApp number AND the renew link (which only the owner
 *      was given). Payment changes are then held for 24 hours, and the email on file, if any,
 *      is told.
 * Every success signs out every other device and rotates the renew link.
 */
const RESET_LINK_TTL = 3600;
const RESET_HOLD_MS = 24 * 3600e3;
const RESET_MAIL_GAP_MS = 10 * 60e3;
async function pinReset(req, env) {
  const b = await readBody(req);
  if (b.cap) return pinResetByLink(req, env, b);
  const handle = slug(String(b.key || b.handle || ''));
  const st = await getStore(env, handle);
  if (!st) return json({ ok: false, need_login: true, error: 'No store with that name.' }, 404);
  const frozen = await pinLockedOut(env, handle);
  if (frozen) return json({ ok: false, need_login: true, error: 'Too many attempts — wait ' + Math.ceil(frozen / 60) + ' minutes.', retry_in_sec: frozen }, 429);
  const origin = new URL(req.url).origin;
  const details = !!(b.whatsapp || b.renew || b.owner_email);
  if (!details) {
    if (!st.owner_email || !mailArmed(env)) {
      return json({ ok: false, no_email: true, error: st.owner_email
        ? 'Email is not switched on for this service right now. Use your store WhatsApp number and your renew link instead.'
        : 'This store has no email on file. Use your store WhatsApp number and your renew link instead.' }, 409);
    }
    const to = maskField('notify_email', st.owner_email);
    if (Date.now() - (Date.parse(st.reset_mail_at || '') || 0) < RESET_MAIL_GAP_MS) {
      return json({ ok: true, sent_to: to, note: 'A link was sent a few minutes ago. Check that inbox and its spam folder; it works for one hour.' });
    }
    const cap = await issueCap(capKey(env), { a: 'pinreset', h: handle, g: String(st.auth_gen || '0'),
      ps: String((st.pin && st.pin.set_at) || '0') }, RESET_LINK_TTL);
    const link = `${origin}/a?reset=${encodeURIComponent(cap)}`;
    const sent = await sendMail(env, st.owner_email, `Reset the PIN for ${st.shop_name || handle}`,
      `Someone (hopefully you) asked to reset the PIN for your Tapstall store "${st.shop_name || handle}".\n\n`
      + `Open this link within one hour to choose a new PIN:\n${link}\n\n`
      + `It works once. If you did not ask for this, ignore this email: nothing changes and your PIN still works.\n`);
    if (!sent) return json({ ok: false, error: 'The email could not be sent just now. Try again in a few minutes, or use your store WhatsApp number and renew link.' }, 503);
    st.reset_mail_at = new Date().toISOString();
    await writeStore(env, st);
    await pushAudit(env, st, { act: 'pin_reset_link', via: 'owner', fields: [], ip: ipOf(req) });
    return json({ ok: true, sent_to: to, note: 'We emailed a reset link to ' + to + '. It works once, for one hour. Check spam if it is not there in a few minutes.' });
  }
  const email = String(b.owner_email || '').toLowerCase().trim();
  const wa = digits(String(b.whatsapp || '')).replace(/\D/g, '');
  const okWho = (st.owner_email && isEmail(email) && timingSafeEq(String(st.owner_email).toLowerCase(), email))
             || (st.whatsapp && wa && timingSafeEq(String(st.whatsapp).replace(/\D/g, ''), wa));
  const renewTok = String(b.renew || '').trim().split('/renew/').pop().replace(/[^a-z0-9]/g, '');
  const wantTok = String(st.renew_url || '').split('/renew/')[1] || '';
  const okProof = !!wantTok && !!renewTok && timingSafeEq(wantTok, renewTok);
  if (!okWho || !okProof) {
    await pinFail(env, handle);            // one counter, in memory; see pinLogin
    return json({ ok: false, need_login: true, error: 'Those details do not match this store. You need the store WhatsApp number (or email) and the renew link you were given at sign-up.' }, 403);
  }
  return finishPinReset(req, env, st, b, 'details');
}
async function pinResetByLink(req, env, b) {
  const p = await verifyCap(capKey(env), String(b.cap || ''));
  const dead = json({ ok: false, error: 'This reset link has expired or was already used. Ask for a new one from the sign-in screen.' }, 403);
  if (!p || p.a !== 'pinreset') return dead;
  const st = await getStore(env, p.h);
  if (!st) return dead;
  if (!capGenOk(p, st) || String((st.pin && st.pin.set_at) || '0') !== String(p.ps)) return dead;
  return finishPinReset(req, env, st, b, 'link');
}
async function finishPinReset(req, env, st, b, how) {
  let next = PIN_NORMALIZE(b.new_pin || b.pin);
  if (!next) next = genPin();
  else if (!validPin(next)) return json({ ok: false, error: 'A PIN is 6 to 8 digits.' }, 422);
  const handle = st.handle;
  st.pin = await pinRecord(next);
  st.auth_gen = Date.now().toString(36);
  delete st.pending;
  delete st.reset_mail_at;
  if (how === 'details') st.reset_hold_until = Date.now() + RESET_HOLD_MS;
  if (how === 'link' && st.owner_email) st.email_verified = String(st.owner_email).toLowerCase();   // they read that inbox
  await rotateRenewLink(env, st);          // the same lever moves the same set of credentials
  await writeStore(env, st);
  await pinClear(env, handle); await authClear(env, handle);
  await pushAudit(env, st, { act: 'pin_reset', via: how === 'link' ? 'email_link' : 'details', fields: ['pin', 'auth_gen'], ip: ipOf(req) });
  if (st.owner_email) {
    const origin = new URL(req.url).origin;
    await sendMail(env, st.owner_email, `Your Tapstall PIN was reset`,
      `The PIN for "${st.shop_name || handle}" was reset just now `
      + (how === 'link' ? 'from the reset email' : 'using the store WhatsApp number and renew link') + '. Every other device was signed out.\n\n'
      + `If this was not you, open ${origin}/a, choose "I lost my PIN", and a link to this inbox takes the store back.`
      + (how === 'details' ? ' Payment changes are on hold for 24 hours, so nothing can be rerouted meanwhile.' : '') + '\n');
  }
  return json({ ok: true, handle, pin: next,
    note: 'That is your PIN now, everywhere. Sign in with your store name and it — other devices are signed out.'
      + (how === 'details' ? ' Payment changes made in the next 24 hours wait the full day before they apply.' : '') });
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
  const refsBefore = referencedImages(st);       // the logo/cover about to be replaced, if any
  // after a WhatsApp+renew-link reset, money changes wait a full day (the owner's inbox gets a say)
  const holdMs = Math.max(HOLD_MS, (Number(st.reset_hold_until) || 0) - Date.now());
  const { changed, staged } = stageSettings(st, v.soft, v.money, holdMs, Date.now());
  const after = {};
  for (const k of keys) {
    const held = st.pending && st.pending.fields && k in st.pending.fields;
    after[k] = maskField(k, held ? st.pending.fields[k] : st[k]);
  }
  if (changed || staged) await writeStore(env, st);
  // Swapping or clearing the logo or cover orphans its bytes: the store document
  // holds a path, so the file itself has nobody left who points at it.
  if (changed && (v.soft.logo !== undefined || v.soft.cover_image !== undefined)) await pruneImages(env, st, refsBefore);
  const logged = (changed || staged) ? await pushAudit(env, st, { act: 'settings', via: who.via, changed, staged, before, after, ip: ipOf(req) }) : true;
  const held = Object.keys(v.money);
  // v2.0.0: a held change is only a defence if the owner hears about it inside the hold.
  if (staged && st.pending && st.owner_email) {
    const origin = new URL(req.url).origin;
    const cap = await issueCap(capKey(env), { a: 'cancelchg', h: st.handle, at: String(st.pending.set_at), g: String(st.auth_gen || '0') }, 2 * 86400);
    await sendMail(env, st.owner_email, `A payment or contact change on ${st.shop_name || st.handle}`,
      `These settings on your Tapstall store were changed and apply at ${new Date(st.pending.apply_at).toUTCString()}:\n`
      + held.map((k) => `  ${k}: ${before[k] || '(empty)'} -> ${after[k] || '(empty)'}`).join('\n') + '\n\n'
      + `If that was you, do nothing. If it was not, open this link before then to cancel it and sign every device out:\n`
      + `${origin}/api/settings/cancel?cap=${encodeURIComponent(cap)}\n`);
  }
  const newMail = String((v.money && v.money.owner_email) || (v.soft && v.soft.owner_email) || '').toLowerCase();
  if (newMail && newMail !== st.email_verified && (changed || staged)) {
    const vcap = await issueCap(capKey(env), { a: 'everify', h: st.handle, e: newMail, g: String(st.auth_gen || '0') }, 14 * 86400);
    await sendMail(env, newMail, `Confirm your email for ${st.shop_name || st.handle}`,
      `Tap to confirm this address for your Tapstall store "${st.shop_name || st.handle}":\n${new URL(req.url).origin}/api/email/verify?cap=${encodeURIComponent(vcap)}\n\nIf you did not add this address, ignore this email.\n`);
  }
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

/** The email's cancel link. GET only renders a button (mail scanners prefetch links); the POST
 *  cancels the held change, signs every device out and rotates the renew link. */
/** The welcome mail's confirm link. GET is fine here: confirming is idempotent and grants nothing
 *  but "this address reads its mail" (a prefetching scanner can only confirm the true owner's box). */
async function emailVerify(req, url, env) {
  const p = await verifyCap(capKey(env), String(url.searchParams.get('cap') || ''));
  const page = (msg) => html('<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=robots content=noindex>'
    + '<title>Tapstall</title><body style="font:17px system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.3rem">Tapstall</h1><p>' + msg + '</p><p><a href="/a">Open your dashboard</a></p></body>', 200, NOINDEX);
  if (!p || p.a !== 'everify') return page('This confirm link has expired. Your store works as before; sign in and save your email again to get a fresh one.');
  const st = await getStore(env, p.h);
  const pend = st && st.pending && st.pending.fields && String(st.pending.fields.owner_email || '').toLowerCase();
  if (!st || !capGenOk(p, st) || (String(st.owner_email || '').toLowerCase() !== p.e && pend !== p.e)) return page('That address is no longer the one on this store, so there is nothing to confirm.');
  if (st.email_verified !== p.e) {
    st.email_verified = p.e;
    await writeStore(env, st);
    await pushAudit(env, st, { act: 'email_verified', via: 'email_link', fields: ['owner_email'], ip: ipOf(req) });
  }
  return page('Thanks — <b>' + p.e.replace(/[&<>"]/g, '') + '</b> is confirmed for this store.');
}

async function cancelByMail(req, url, env) {
  const raw = req.method === 'POST' ? String((await readBody(req).catch(() => ({}))).cap || '') : String(url.searchParams.get('cap') || '');
  const p = await verifyCap(capKey(env), raw);
  const page = (msg, form) => html('<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=robots content=noindex>'
    + '<title>Tapstall</title><body style="font:17px system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.3rem">Tapstall</h1><p>' + msg + '</p>' + (form || '') + '</body>', 200, NOINDEX);
  if (!p || p.a !== 'cancelchg') return page('This link has expired. Sign in at <a href="/a">/a</a> to see your settings.');
  const st = await getStore(env, p.h);
  if (!st || !capGenOk(p, st) || !st.pending || String(st.pending.set_at) !== String(p.at)) return page('There is nothing waiting to cancel: the change was already cancelled or has applied. Sign in at <a href="/a">/a</a> to check your settings.');
  if (req.method !== 'POST') {
    const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return page('Cancel the change waiting on <b>' + esc(st.shop_name || st.handle) + '</b> (' + esc(Object.keys(st.pending.fields).join(', ')) + ') and sign out every device?',
      '<form method=post><input type=hidden name=cap value="' + esc(raw) + '"><button style="font:inherit;padding:.7rem 1.2rem">Cancel the change</button></form>');
  }
  const was = Object.keys(st.pending.fields);
  delete st.pending;
  st.auth_gen = Date.now().toString(36);
  await rotateRenewLink(env, st);
  await writeStore(env, st);
  await authClear(env, st.handle);
  await pushAudit(env, st, { act: 'revert', via: 'email_link', fields: was, ip: ipOf(req) });
  return page('Cancelled. Every device is signed out. If someone else knows your PIN, open <a href="/a">/a</a>, choose "I lost my PIN", and we will email you a link to set a new one.');
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
/** Where a shop's renew link points *today*. The stored absolute URL is a fact about
 *  the day it was minted — hosts move, brands move, and a link frozen on the old name
 *  dies quietly while the store itself follows the redirect fine. The token is the
 *  durable half, so the pages and the mails take the host from the request (or from
 *  PUBLIC_ORIGIN, when no browser is involved) and keep only the path from the record.
 *  The ops console still shows the stored value: for an operator, "what the document
 *  says" is the useful truth. */
function renewLink(st, origin) {
  const tok = String((st && st.renew_url) || '').split('/renew/')[1] || '';
  return tok && origin ? `${String(origin).replace(/\/+$/, '')}/renew/${tok}` : ((st && st.renew_url) || '');
}

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
  if (!quotaGate('writes', 'operator').ok) return false;
  const k = 'audit:' + st.handle;
  let cur = memGet(k);
  if (cur === undefined) {
    try { cur = (await env.ORDERS.get(k, 'json')) || []; quotaNote('reads', 'operator'); } catch (e) { cur = []; }
  }
  try {
    cur.unshift({
    at: new Date().toISOString(), act: row.act, via: row.via || '', ip: row.ip || '',
    changed: row.changed || 0, staged: row.staged || 0,
      fields: row.fields || Object.keys(row.before || {}),
      before: row.before || undefined, after: row.after || undefined,
    });
    const kept = cur.slice(0, 40);
    await env.ORDERS.put(k, JSON.stringify(kept));
    quotaNote('writes', 'operator'); memSet(k, kept, 60e3);
    return true;
  } catch (e) { return false; }   // the change stands; the log has a gap, and
}                                 // the response says so rather than failing
async function getAudit(env, handle) {
  if (!env.ORDERS) return [];
  return cached('audit:' + handle, 60e3, async () => {
    const rows = (await env.ORDERS.get('audit:' + handle, 'json')) || [];
    quotaNote('reads', 'operator');
    return rows;
  });
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
  const p = await verifyCap(capKey(env), cap);
  let custom = (await tplPage(env, 'confirm')).html || null;      // the same one reader, for the same reason
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
const OPS_TPL_NAMES = ['store', 'onboard', 'admin', 'fees', 'index', 'confirm', 'renew', 'ops', 'leads', 'sample-menu',
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
  return issueCap(capKey(env), { a: 'ops', g: VERSION, n: await opsGen(env) }, SESS_TTL);
}

async function opsAuthed(req, env) {
  // gen-rule: platform — this door is bound to `ops_gen`, not to a store's `auth_gen`, and
  // `issueCap` demands `n` of an `ops` cap for exactly that reason: `g` here is a version string,
  // so a guard that only looked for `g` would have called any ops cap bound.
  const raws = cookieVals(req, OPS_COOKIE);
  if (!raws.length) return { anon: true };
  const gen = String(await opsGen(env));
  for (const raw of raws) {
    const p = await verifyCap(capKey(env), raw);
    if (p && p.a === 'ops' && String(p.n) === gen) return { ok: true };
  }
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
      `${OPS_COOKIE}=${encodeURIComponent(cap)}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${SESS_TTL}`);
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

async function opsMail(req, env) {
  if ((reqHeader(req, 'x-tapstall-confirm') || '') !== '1') return json({ ok: false, error: 'missing x-tapstall-confirm header' }, 403);
  const b = await readBody(req).catch(() => ({}));
  if (b.action === 'resume') return json({ ok: true, mail: await mailResume(env) });
  if (b.action === 'test') {
    const to = String(b.to || '').trim().slice(0, 120);
    const r = await mailSend(env, { to, kind: 'transactional', subject: 'Tapstall mail check',
      text: 'This is a test from the Tapstall operator console (' + new Date().toISOString() + ').\n\nIf you can read it, the mail lane works: password resets, email checks and payment claim links will reach people.\n' });
    return json({ ok: !!r.sent, result: r, mail: await mailStatus(env) }, r.sent ? 200 : 502);
  }
  return json({ ok: false, error: 'action must be test or resume' }, 422);
}

function opsSummarise(st, rows) {
  const now = Date.now();
  const left = Math.ceil(((st.paid_until || 0) - now) / 864e5);
  const today = rows.filter(r => String(r.at || '').slice(0, 10) === new Date(now).toISOString().slice(0, 10));
  return {
    handle: st.handle, shop_name: st.shop_name, currency: st.currency || 'USD', rail: st.rail,
    seller: st.seller_code || '',
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
  quotaNote('lists', 'operator');
  const handles = (listed.keys || []).map(k => String(k.name).slice('store:'.length)).filter(Boolean);
  const rowsByStore = await ledgerRowsAll(env);
  const refKeys = await listKeys(env.STORES, 'ref:', 1000);
  const refHandles = new Set(refKeys.map((k) => k.slice('ref:'.length)));
  const stores = [];
  for (const h of handles) {
    const st = await getStore(env, h);
    if (!st) continue;
    const rows = rowsByStore.get(h) || [];
    const sum = opsSummarise(st, rows);
    sum.awaiting_reference = refHandles.has(h) ? await opsRefs(env, h) : [];
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
    reads_used_estimate: stores.length + 3,
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
  // what the two money doors were asked for in the last 24 hours, by outcome,
  // plus the third door: transfers the chain watcher turned into paid orders
  const hooks = { refused: 0, ignored: 0, already: 0, activated: 0, crypto: 0, hours: [] };
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
  // The pipeline at a glance, for the one question that matters at 07:00: what needs a person,
  // and what is merely unarmed? Arming is a one-time policy act (bind a secret); after that the
  // slots run themselves and this block is how the owner can tell.
  const pipeline = { digest: null, press_last: null, armed: {}, sellers_active: 0, press_identities: [], quota_local: quotaLocal() };
  try {
    pipeline.digest = await env.ORDERS.get('digest:last', 'json').catch(() => null);
    pipeline.press_last = await env.ORDERS.get('press:last', 'json').catch(() => null);
    const reg = await pressRegistry(env);
    pipeline.press_identities = Object.entries(reg).map(([id, e]) => ({ id, class: e.class,
      token_env: e.token_env, token_present: !!env[e.token_env],
      direct_bound: Object.keys(directCredsFor(env, e, id)) }));
    pipeline.armed = {
      whop: !!env.WHOP_WEBHOOK_SECRET, whop_checkout: !!(env.WHOP_CHECKOUT_URL || env.WHOP_CHECKOUT_URL_ANNUAL),
      flutterwave: !!env.FW_SECRET, payfast: !!env.PAYFAST_PASSPHRASE, email: mailArmed(env),
      gh_dispatch: !!env.GH_DISPATCH_TOKEN, trongrid_key: !!env.TRONGRID_KEY,
    };
    pipeline.sellers_active = (await listSellers(env)).filter((s) => s.active !== false).length;
    // v2.0.0: the mail lane (who sends merchant mail and first touches), what is parked for retry,
    // and whether this morning's dispatch actually reached GitHub
    pipeline.mail = await mailStatus(env);
    try { const reg = await pressRegistry(env); pipeline.press = Object.fromEntries(Object.entries(reg).map(([id, e]) => [id, { class: e.class, rails: pressRailState(env, e, id) }])); } catch (e) { pipeline.press = { error: String(e && e.message || e).slice(0, 120) }; }
    pipeline.mail_queue = ((await env.ORDERS.list({ prefix: 'mailq:', limit: 50 }).catch(() => ({ keys: [] }))).keys || []).length;
    pipeline.dispatch_last = await env.ORDERS.get('dispatch:last', 'json').catch(() => null);
    pipeline.whop_unmatched = ((await env.ORDERS.list({ prefix: 'whop:unmatched:', limit: 50 }).catch(() => ({ keys: [] }))).keys || []).length;
  } catch (e) { pipeline.error = String((e && e.message) || e).slice(0, 120); }
  return json({ ok: true, selftest: t, pages, ci, cron: t.cron_heartbeat || null, version: VERSION, templates: OPS_TPL_NAMES, hooks, pipeline },
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
  return cached('audit:ops', 60e3, async () => {
    const rows = (await env.ORDERS.get('audit:ops', 'json')) || [];
    quotaNote('reads', 'operator');
    return rows;
  });
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
  if (!quotaGate('writes', 'security').ok) return false;
  try {
    const cur = await getOpsLog(env);
    cur.unshift({ at: new Date().toISOString(), act: row.act, handle: row.handle || '', note: row.note || '', ip: row.ip || '' });
    const kept = cur.slice(0, 60);
    await env.ORDERS.put('audit:ops', JSON.stringify(kept));
    quotaNote('writes', 'security'); memSet('audit:ops', kept, 60e3);
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
    if (mailArmed(env) && (st.owner_email || st.notify_email)) {
      const ok = await sendMail(env, st.owner_email || st.notify_email, 'A note about your Tapstall store', String(b.message || 'Your store is running normally. No action needed.'));
      (ok ? sent : failed).push('email');
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
  if (act === 'recognise_ref') {
    // A manual payment (cash, EcoCash to the owner's number) has no webhook to believe, so
    // recognising it is the one money judgement that stays with a person — they can see the
    // money in their own wallet. Everything after that judgement is the machine's: the plan
    // extends, the filed reference is consumed (never recognisable twice), the sale and the
    // seller's commission land on the ledger, and both logs say who did it. Before this lever
    // the same job took grant_year plus clear_refs and recorded no sale at all.
    const key = 'ref:' + handle;
    const refs = (await env.STORES.get(key, 'json').catch(() => null)) || [];
    if (!refs.length) return json({ ok: false, error: 'no filed payment reference for this store' }, 404);
    const want = String(b.ref || '');
    const idx = want ? refs.findIndex((r) => String(r.ref || '') === want) : 0;
    if (idx < 0) return json({ ok: false, error: 'that reference is not on file for this store', filed: refs.map((r) => r.ref) }, 404);
    const pick = refs[idx];
    const days = Math.min(1460, Math.max(30, Number(b.days) || 365));
    const amount = Math.min(100000, Math.max(0, Number(b.amount) || Number(pick.amount) || round2(PRICE_USD * days / 365)));
    const before = { plan: st.plan, paid_until: st.paid_until, suspended: !!st.suspended };
    st.paid_until = Math.max(Date.now(), st.paid_until || 0) + days * 864e5;
    st.plan = days >= 300 ? 'annual' : 'term';
    st.suspended = false; st.warned_at = null;
    const rest = refs.filter((_, i) => i !== idx);
    if (rest.length) await env.STORES.put(key, JSON.stringify(rest), { expirationTtl: 30 * 86400 });
    else await env.STORES.delete(key);
    memDelPrefix('listkeys:');
    await writeStore(env, st);
    const sale = await recordSale(env, st, { amount, provider: 'manual_ref', ref: String(pick.ref || ''), days });
    await pushOpsLog(env, { act: 'recognise_ref', handle, note: String(pick.ref || '') + ' -> +' + days + 'd, ' + amount + ' USD' + (sale && sale.seller_code ? ', commission ' + sale.commission + ' to ' + sale.seller_code : ''), ip: ipOf(req) });
    const logged = await pushAudit(env, st, { act: 'operator:recognise_ref', via: 'ops', fields: ['paid_until', 'plan'], before: opsMaskTerm(before), after: opsMaskTerm({ plan: st.plan, paid_until: st.paid_until, suspended: false }) });
    return json({ ok: true, handle, action: 'recognise_ref', recognised: pick.ref, days, amount,
      paid_until: new Date(st.paid_until).toISOString(), plan: st.plan,
      commission: sale ? { seller: sale.seller_code || null, amount: sale.commission } : null,
      refs_left: rest.length, logged,
      note: 'Plan extended and the reference consumed — it cannot be recognised twice. The sale is on the ledger' + (sale && sale.seller_code ? ' with commission to ' + sale.seller_code : '') + '.' });
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
  else if (act === 'reinstate') { st.suspended = false; st.warned_at = null; }
  else if (act === 'extend7') st.paid_until = Math.max(Date.now(), st.paid_until || 0) + 7 * 864e5;
  else if (act === 'extend30') st.paid_until = Math.max(Date.now(), st.paid_until || 0) + 30 * 864e5;
  else if (act === 'grant_year') { st.paid_until = Math.max(Date.now(), st.paid_until || 0) + 365 * 864e5; st.plan = 'annual'; st.suspended = false; }
  else if (act === 'reset_free') { st.paid_until = Date.now() + FREE_DAYS * 864e5; st.plan = 'free60'; st.suspended = false; }
  else if (act === 'clear_pending') { delete st.pending; done = 'reverted a queued settings change'; }
  else if (act === 'clear_refs') { await env.STORES.delete('ref:' + handle); memDelPrefix('listkeys:'); delete st.pending_ref_note; done = 'cleared the payment references the merchant filed'; }
  else if (act === 'revoke') { st.auth_gen = Date.now().toString(36); st.admin_token = randomKey(16); delete st.pending; await rotateRenewLink(env, st); done = 'revoked every link, key and cookie, including the renew link'; }
  else return json({ ok: false, error: 'unknown action', actions: ['suspend', 'reinstate', 'extend7', 'extend30', 'grant_year', 'reset_free', 'clear_pending', 'clear_refs', 'revoke', 'notify', 'reset_pin', 'menu', 'menu_revert', 'recognise_ref'] }, 422);

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
  await env.STORES.put('rails:extra', JSON.stringify(out)); memDel('rails:catalog'); quotaNote('writes', 'operator');
  await pushOpsLog(env, { act: 'rails', handle: 'rails', note: (Object.keys(was || {}).length) + ' -> ' + Object.keys(out).length + ' added rails: ' + Object.keys(out).join(','), ip: ipOf(req) });
  return json({ ok: true, added: Object.keys(out), live: await railsCatalog(env),
    note: 'Live at once for new stores and new orders. Orders already placed keep the rail printed on their slip.' });
}

async function opsStoreDetail(url, env) {
  const handle = slug(url.searchParams.get('handle') || '');
  const st = await getStore(env, handle);
  if (!st) return json({ ok: false, error: 'no store' }, 404);
  const rows = await ledgerRows(env, handle);
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
  const cap = await issueCap(capKey(env),
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
    // one write: the document and the row the dashboard reads are the same object now
    await saveOrder(env, st.handle, o);
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
  // one write: the document and the row the dashboard reads are the same object now
  await saveOrder(env, st.handle, o);
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
    const ovr = await env.STORES.get('tpl-ovr:' + name);
    const inline = INLINED_PAGES[name] || '';
    // `live` is what a merchant is served, and since v0.9.1 that is the override if there is one
    // and the bundle otherwise — the KV publish key is only a rollback target now.
    out.push({ name, bytes: (ovr && ovr.length > 200 ? ovr : inline).length, kv_bytes: v ? v.length : 0,
      override: !!(ovr && ovr.length > 200), inlined: inline.length,
      live: !!(ovr && ovr.length > 200) || inline.length > 200,
      sha: (ovr && ovr.length > 200 ? ovr : inline) ? (await hash(name + ':' + (ovr || inline).length + ':' + (ovr || inline).slice(0, 64))).slice(0, 8) : null });
  }
  return json({ ok: true, templates: out }, 200, { 'Cache-Control': 'no-store' });
}
async function opsTemplateRead(url, env) {
  const name = safeTplName(url.searchParams.get('name'));
  if (!name) return json({ ok: false, error: 'bad template name' }, 422);
  const p = await tplPage(env, name);
  return json({ ok: true, name, bytes: p.html.length, from: p.from, html: p.html || '' }, 200, { 'Cache-Control': 'no-store' });
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
  // the console publishes an *override*, which outranks the bundle and can be deleted; writing
  // `tpl:<name>` would publish a page that a redeploy silently un-serves, which is worse than not
  const key = (name === 'sample-menu' ? 'tpl-ovr:sample-menu' : 'tpl-ovr:' + name);
  const was = await env.STORES.get(key);
  if (b.restore) {
    // the committed copy is the safety net: a hand-edit that goes wrong in the
    // console is one press from being undone, with nothing to redeploy
    const raw = await fetch(REPO_RAW + (name === 'sample-menu' ? 'pages/sample-menu.csv' : 'pages/' + name + '.html'),
      { headers: { 'user-agent': 'tapstall/1 (template restore)' } });
    if (!raw.ok) return json({ ok: false, error: 'could not read the committed copy (HTTP ' + raw.status + ')' }, 502);
    const text = await raw.text();
    if (text.length < 200) return json({ ok: false, error: 'committed copy looks truncated; refusing to publish it' }, 502);
    await env.STORES.put(key, text); memDel('tplkv:' + name); quotaNote('writes', 'operator');
    await pushOpsLog(env, { act: 'template-restore', handle: name, note: (was ? was.length : 0) + ' -> ' + text.length + ' bytes from main', ip: ipOf(req) });
    return json({ ok: true, restored: name, bytes: text.length, was: was ? was.length : 0, source: 'git main' });
  }
  await env.STORES.put(key, html); memDel('tplkv:' + name); quotaNote('writes', 'operator');
  const now = html;
  await pushOpsLog(env, { act: 'template', handle: name, note: (was ? was.length : 0) + ' -> ' + now.length + ' bytes', ip: ipOf(req) });
  return json({ ok: true, name, bytes: now.length, was: was ? was.length : 0, matches: now === html, hot: 'no redeploy needed — this is the live copy', note: name === 'sample-menu' ? 'CSV published.' : 'Live for the next request.' });
}


/* ── v1.0.0: sellers, leads and the scheduler slots ─────────────────────────────────────────────
 * The people layer the doctrine names. OWNER sets policy once (registers a seller, binds a
 * secret, reads the exception digest). SELLERS work their own links, leads and conversations.
 * OPERATORS never meet any of this. Nothing below asks anybody to approve a batch: attribution
 * is judged at registration, leads are allocated by hash, commission is arithmetic on a recorded
 * payment, and the counters a human would have to babysit are derived at read time. */

const nsIds = new WeakMap();
let nsSeq = 0;
function nsId(ns) { if (!nsIds.has(ns)) nsIds.set(ns, ++nsSeq); return nsIds.get(ns); }
async function listKeys(ns, prefix, cap = 1000, opts = {}) {
  const out = [];
  if (!ns) return out;
  const ck = 'listkeys:' + nsId(ns) + ':' + prefix + ':' + cap;
  if (!opts.fresh) {
    const hit = memGet(ck);
    if (hit !== undefined) return hit;
  }
  let cursor, loops = 0;
  do {
    const l = await ns.list({ prefix, limit: 1000, cursor });
    quotaNote('lists', 'operator');
    for (const k of (l.keys || [])) out.push(String(k.name));
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor && loops++ < 5 && out.length < cap);
  const sliced = out.slice(0, cap);
  memSet(ck, sliced, 30000);
  return cloneVal(sliced);
}

/* ---- sellers ---- */
async function sellerDoc(env, code) {
  const c = cleanSellerCode(code);
  if (!c || !env.STORES) return null;
  return cached('seller:' + c, 60e3, async () => {
    try { const d = await env.STORES.get('seller:' + c, 'json'); quotaNote('reads', 'operator'); return d || null; }
    catch (e) { return null; }
  });
}
async function listSellers(env) {
  return cached('sellers:list', 60e3, async () => {
    const keys = await listKeys(env.STORES, 'seller:', 500);
    const out = [];
    for (const k of keys) {
      try { const d = await env.STORES.get(k, 'json'); quotaNote('reads', 'operator'); if (d && d.code) out.push(d); } catch (e) { void e; }
    }
    return out.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  });
}
function publicSeller(d) {
  if (!d) return null;
  return { code: d.code, name: d.name || '', active: d.active !== false,
    commission_pct: Number(d.commission_pct ?? SELLER_DEFAULT_PCT) || 0,
    whop: d.whop || '', clicks: Number(d.clicks) || 0, created_at: d.created_at || null,
    link_path: '/r/' + d.code, onboard_path: '/onboard?ref=' + d.code };
}
async function sellerAuth(env, codeIn, keyIn) {
  const code = cleanSellerCode(codeIn);
  const key = String(keyIn || '');
  if (!code || !key) return null;
  const doc = await sellerDoc(env, code);
  if (!doc || doc.active === false || !doc.key_hash) return null;
  const h = await hash(code + ':' + key);
  return timingSafeEq(h, String(doc.key_hash)) ? doc : null;
}
/** Owner-as-seller for the lead doors: code `owner` with the platform secret. Returns a sentinel
 *  doc so callers can tell "sees everything" from "sees their own book". (v2.0.0: the Google Sheet
 *  CRM key and its feed are gone — one less credential, one less breaking point.) */
async function leadActor(env, codeIn, keyIn) {
  const code = String(codeIn || '');
  if (code === 'owner' && env.ADMIN_SECRET && keyIn && timingSafeEq(String(keyIn), String(env.ADMIN_SECRET))) {
    return { code: 'owner', owner: true, active: true, via: 'admin' };
  }
  return sellerAuth(env, codeIn, keyIn);
}
async function listSales(env) {
  return cached('sales:list', 60e3, async () => {
    const out = [];
    let cursor, pages = 0;
    try {
      do {
        const l = await env.STORES.list({ prefix: 'sale:', limit: 1000, cursor });
        quotaNote('lists', 'operator');
        for (const k of l.keys || []) {
          if (k.metadata && k.metadata.at) { out.push(k.metadata); continue; }
          try { const s = await env.STORES.get(k.name, 'json'); quotaNote('reads', 'operator'); if (s) out.push(s); } catch (e) { void e; }
          if (out.length >= 2000) break;
        }
        cursor = l.list_complete ? undefined : l.cursor;
      } while (cursor && ++pages < 2 && out.length < 2000);
    } catch (e) { /* a board with no sales row is better than a 500 */ }
    return out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  });
}
/** One payment, one sale row, commission attached at the seller's standing rate. Best-effort by
 *  design: a spent write budget must never un-activate a shop that really paid — the activation
 *  already happened on the store document, and this row is the bookkeeping that follows it. */
async function recordSale(env, st, sale) {
  try {
    if (!env.STORES || !st || !st.handle) return null;
    const code = cleanSellerCode(st.seller_code || '');
    let pct = 0, sd = null;
    if (code) {
      sd = await sellerDoc(env, code);
      pct = sd ? (Number(sd.commission_pct ?? SELLER_DEFAULT_PCT) || 0) : 0;
    }
    // Who carries the commission is a fact about the door the money came through: a Whop
    // affiliate sale is settled by Whop to the seller's Whop balance (30-day hold), so the
    // owner must not owe it again out of pocket. The handler says so explicitly; anything
    // else with a seller on it is owed internally, as before.
    const via = (sale && sale.commission_via === 'whop') ? 'whop' : (code ? 'internal' : '');
    const amount = round2(Number(sale && sale.amount) || 0);
    const row = { handle: st.handle, seller_code: code, amount,
      currency: String((sale && sale.currency) || 'USD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'USD',
      days: Number(sale && sale.days) || 365, pct, commission: commissionFor(amount, pct), commission_via: via,
      provider: String((sale && sale.provider) || ''), ref: String((sale && sale.ref) || '').slice(0, 80),
      at: new Date().toISOString() };
    await env.STORES.put('sale:' + st.handle + ':' + Date.now().toString(36) + alnumToken(6), JSON.stringify(row), { metadata: row });
    quotaNote('writes', 'money'); memDel('sales:list'); memDelPrefix('listkeys:');
    return row;
  } catch (e) { return null; }
}
async function boardInputs(env) {
  const sellers = await listSellers(env);
  const handles = (await listKeys(env.STORES, 'store:', 1000)).map((k) => k.slice('store:'.length)).filter(Boolean);
  const stores = [];
  for (const h of handles) {
    try { const st = await getStore(env, h); if (st) stores.push(st); } catch (e) { void e; }
  }
  const sales = await listSales(env);
  return { sellers, stores, sales };
}
const sellerClickBuf = new Map();
async function sellerRedirect(url, env, codeIn, mode) {
  // /r/<code> goes straight to sign-up; /g/<code> tells the story first (the landing page
  // carries the code forward into every joining link). Both count the same click.
  const code = cleanSellerCode(codeIn);
  const landing = mode === 'g' ? '/' : '/onboard';
  const doc = code ? await sellerDoc(env, code) : null;
  if (!doc || doc.active === false) return redirect(url.origin + landing);
  // A click is telemetry, not money: count in the isolate and flush every tenth, so a shared
  // link cannot spend the account's 1,000 daily writes one redirect at a time. Attribution —
  // the number money hangs off — is judged exactly, at registration.
  const n = (sellerClickBuf.get(code) || 0) + 1;
  if (n >= 50 && quotaGate('writes', 'telemetry').ok) {
    sellerClickBuf.set(code, 0);
    try { doc.clicks = (Number(doc.clicks) || 0) + n; await env.STORES.put('seller:' + code, JSON.stringify(doc)); quotaNote('writes', 'telemetry'); memSet('seller:' + code, doc, 60e3); memDel('sellers:list'); } catch (e) { void e; }
  } else sellerClickBuf.set(code, n);
  return redirect(url.origin + landing + '?ref=' + code);
}
async function opsSellers(req, env) {
  if (req.method !== 'POST') {
    const { sellers, stores, sales } = await boardInputs(env);
    return json({ ok: true, sellers: sellers.map(publicSeller), board: sellerBoard(sellers, stores, sales),
      note: 'Registering a seller is a policy act, done once per person. After that their link attributes shops by itself, their leads allocate by hash, and commission is arithmetic on recorded payments — nothing routes through the owner per sale.' }, 200, { 'Cache-Control': 'no-store' });
  }
  if ((reqHeader(req, 'x-tapstall-confirm') || '') !== '1') return json({ ok: false, error: 'missing x-tapstall-confirm header' }, 403);
  const b = await readBody(req).catch(() => ({}));
  const act = String(b.action || 'register');
  const code = cleanSellerCode(b.code || '');
  if (!code) return json({ ok: false, error: 'code: 2-24 chars, lowercase a-z 0-9 and dashes (it is the bit of the link a person reads aloud)' }, 422);
  const existing = await sellerDoc(env, code);
  if (act === 'deactivate' || act === 'activate') {
    if (!existing) return json({ ok: false, error: 'no such seller' }, 404);
    existing.active = act === 'activate';
    await env.STORES.put('seller:' + code, JSON.stringify(existing)); quotaNote('writes', 'operator'); memSet('seller:' + code, existing, 60e3); memDel('sellers:list'); memDelPrefix('listkeys:');
    await pushOpsLog(env, { act: 'seller_' + act, handle: code, note: existing.name || '', ip: ipOf(req) });
    return json({ ok: true, seller: publicSeller(existing), note: act === 'deactivate'
      ? 'Deactivated: their links land on plain onboarding and no new leads allocate to them. Shops already attributed stay attributed — history is not edited.'
      : 'Active again: links and allocation resume.' });
  }
  if (act === 'rotate_key') {
    if (!existing) return json({ ok: false, error: 'no such seller' }, 404);
    const key = randomKey(18);
    existing.key_hash = await hash(code + ':' + key);
    await env.STORES.put('seller:' + code, JSON.stringify(existing)); quotaNote('writes', 'operator'); memSet('seller:' + code, existing, 60e3); memDel('sellers:list'); memDelPrefix('listkeys:');
    await pushOpsLog(env, { act: 'seller_rotate_key', handle: code, note: '', ip: ipOf(req) });
    return json({ ok: true, seller: publicSeller(existing), seller_key: key, note: 'Shown once. The old key is dead everywhere (seller view, leads, sheets feed).' });
  }
  if (act !== 'register') return json({ ok: false, error: 'unknown action', actions: ['register', 'activate', 'deactivate', 'rotate_key'] }, 422);
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name && !existing) return json({ ok: false, error: 'name required (the person, not the code)' }, 422);
  const doc = { ...(existing || {}), code, name: name || existing.name,
    email: isEmail(b.email || '') ? String(b.email).toLowerCase() : (existing && existing.email) || '',
    whatsapp: digits(b.whatsapp || '').replace(/^\+/, '').slice(0, 15) || (existing && existing.whatsapp) || '',
    whop: String(b.whop || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || (existing && existing.whop) || '',
    commission_pct: Math.min(90, Math.max(0, Number(b.commission_pct ?? ((existing && existing.commission_pct) ?? SELLER_DEFAULT_PCT)) || 0)),
    active: existing ? existing.active !== false : true,
    clicks: (existing && Number(existing.clicks)) || 0,
    created_at: (existing && existing.created_at) || new Date().toISOString() };
  let key = null;
  if (!doc.key_hash) { key = randomKey(18); doc.key_hash = await hash(code + ':' + key); }
  await env.STORES.put('seller:' + code, JSON.stringify(doc)); quotaNote('writes', 'operator'); memSet('seller:' + code, doc, 60e3); memDel('sellers:list'); memDelPrefix('listkeys:');
  await pushOpsLog(env, { act: existing ? 'seller_update' : 'seller_register', handle: code, note: doc.name + ' · ' + doc.commission_pct + '%', ip: ipOf(req) });
  return json({ ok: true, seller: publicSeller(doc), ...(key ? { seller_key: key } : {}),
    links: { short: '/r/' + code, onboard: '/onboard?ref=' + code, whop_hint: doc.whop ? '?a=' + doc.whop : null },
    note: key ? 'Seller live. Give them their key once; it opens their read-only scoreboard, their lead queue and their sheets feed — never a shop dashboard.'
      : 'Updated. Key unchanged; rotate it with action "rotate_key" if it ever leaks.' });
}
async function sellerView(url, env) {
  const doc = await leadActor(env, url.searchParams.get('code') || '', url.searchParams.get('key') || '');
  if (!doc) return json({ ok: false, error: 'seller code + key required' }, 401);
  const { sellers, stores, sales } = await boardInputs(env);
  const board = sellerBoard(sellers, stores, sales);
  const mine = doc.owner ? null : board.find((r) => r.code === doc.code) || null;
  const mineStores = stores.filter((st) => doc.owner || cleanSellerCode(st.seller_code || '') === doc.code)
    .map((st) => ({ handle: st.handle, shop_name: st.shop_name, plan: st.plan || 'free60',
      left_days: Math.ceil(((st.paid_until || 0) - Date.now()) / 864e5), suspended: !!st.suspended, created_at: st.created_at }));
  const mineSales = sales.filter((s) => doc.owner || s.seller_code === doc.code)
    .map((s) => ({ handle: s.handle, amount: s.amount, currency: s.currency, commission: s.commission, provider: s.provider, at: s.at }));
  const leads = await listLeads(env, doc.owner ? {} : { seller: doc.code });
  const by_status = {};
  for (const l of leads) by_status[l.status] = (by_status[l.status] || 0) + 1;
  return json({ ok: true, seller: doc.owner ? { code: 'owner' } : publicSeller(doc),
    board: doc.owner ? board : [mine].filter(Boolean), shops: mineStores, sales: mineSales,
    leads: { total: leads.length, by_status },
    note: 'Read-only by construction: no buyer data, no shop credentials, nothing here moves money.' }, 200, { 'Cache-Control': 'no-store' });
}

/* ---- leads ---- */
/** What the outreach pick needs, carried on the key so a list answers it without a read per lead.
 *  KV allows 1,024 bytes of metadata; this is ~120. A key written before v2.1.0 has none, and the
 *  pick falls back to reading documents until the nightly sweep has re-filed it. */
function leadMeta(l) {
  return { s: String(l.status || ''), e: l.email ? 1 : 0, k: l.seller_code ? 1 : 0, t: Number(l.touches) || 0,
    p: Number(l.score) || 0, f: String(l.next_follow_at || '').slice(0, 30), ls: String(l.last_sender || '').toLowerCase().slice(0, 80) };
}
/** One list, no reads: { rows (id + the metadata fields, listLeads order), legacy: keys without metadata }. */
async function leadIndex(env) {
  const rows = [], legacy = [];
  let cursor, loops = 0;
  do {
    const l = await env.ORDERS.list({ prefix: 'lead:', limit: 1000, cursor }); quotaNote('lists', 'automation');
    for (const k of (l.keys || [])) {
      const m = k.metadata;
      if (!m || typeof m.s !== 'string') { legacy.push(k.name); continue; }
      rows.push({ id: String(k.name).slice(5), status: m.s, email: m.e ? 1 : '', seller_code: m.k ? 'x' : '', touches: m.t || 0,
        score: m.p || 0, next_follow_at: m.f || '', last_sender: m.ls || '' });
    }
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor && loops++ < 3);
  rows.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0)
    || String(a.next_follow_at || '9999').localeCompare(String(b.next_follow_at || '9999')));
  return { rows, legacy };
}
/** Nightly: give pre-v2.1.0 lead keys their metadata (a read + a write each, once, capped). */
async function leadMetaBackfill(env, cap) {
  if (!env.ORDERS) return 0;
  const { legacy } = await leadIndex(env);
  let n = 0;
  for (const k of legacy.slice(0, cap || 60)) {
    const l = await env.ORDERS.get(k, 'json').catch(() => null);
    if (!l || !l.id) continue;
    await env.ORDERS.put(k, JSON.stringify(l), { metadata: leadMeta(l) }); quotaNote('writes', 'automation'); n++;
  }
  if (n) memDel('leads:all');
  return n;
}
async function listLeads(env, filter) {
  const f = filter || {};
  if (!env.ORDERS) return [];
  const out = await cached('leads:all', 60e3, async () => {
    const keys = await listKeys(env.ORDERS, 'lead:', 2000);
    const rows = [];
    for (const k of keys) {
      try { const l = await env.ORDERS.get(k, 'json'); quotaNote('reads', 'operator'); if (l && l.id) rows.push(l); } catch (e) { void e; }
    }
    return rows;
  });
  const rows = out.filter((l) => (!f.seller || l.seller_code === f.seller) && (!f.status || l.status === f.status));
  rows.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0)
    || String(a.next_follow_at || '9999').localeCompare(String(b.next_follow_at || '9999')));
  return rows.slice(0, Math.min(2000, Number(f.limit) || 500));
}
async function leadsIngest(req, env) {
  const denied = await pressAdmin(req, env); if (denied) return denied;
  const b = await readBody(req).catch(() => ({}));
  const raw = Array.isArray(b.leads) ? b.leads.slice(0, 100) : (b.business || b.email || b.phone ? [b] : []);
  if (!raw.length) return json({ ok: false, error: 'send {leads:[…]} (max 100 per call)' }, 422);
  return json(await ingestLeads(env, raw));
}

/** The one place a lead is filed, shared by the HTTP ingest, the autonomous discovery pass and the
 *  partner page. Dedupe, scoring, seller allocation and the do-not-contact ledger live here, so a
 *  cron cannot invent a second, more permissive way in. */
async function ingestLeads(env, rawList) {
  const raw = (rawList || []).slice(0, 100);
  const activeCodes = (await listSellers(env)).filter((s) => s.active !== false).map((s) => s.code);
  const counts = { received: raw.length, added: 0, updated: 0, duplicate: 0, dnc_skipped: 0, invalid: 0, junk: 0, research_hold: 0 };
  const junkWhy = {};
  const added = [];
  for (const item of raw) {
    const lead = cleanLead(item, { now: Date.now() });
    if (!lead.id) { counts.invalid++; continue; }
    // v2.0.0: a search result about WhatsApp is not a WhatsApp seller. Junk is counted and dropped
    // before any write, so a bad source costs reads, never the day's write budget or a stranger's inbox.
    if (lead.junk) { counts.junk++; const k = String(lead.junk).split(' (')[0]; junkWhy[k] = (junkWhy[k] || 0) + 1; continue; }
    const dncHit = (lead.email && await env.STORES.get('Lead:' + lead.email).catch(() => null))
      || (lead.phone && await env.STORES.get('Lead:' + lead.phone).catch(() => null));
    if (dncHit) { counts.dnc_skipped++; continue; }
    const existing = await env.ORDERS.get('lead:' + lead.id, 'json').catch(() => null);
    if (existing) {
      if (existing.status === 'dnc') { counts.dnc_skipped++; continue; }
      const merged = [...new Set([].concat(existing.signals || [], lead.signals || []))].sort();
      const before = JSON.stringify([existing.signals || [], existing.status, existing.score]);
      existing.signals = merged;
      existing.score = Math.max(Number(existing.score) || 0, lead.score);
      if (existing.status === 'research_hold' && merged.length >= 2 && !leadJunkReason(existing) && (existing.email || existing.phone)) existing.status = 'queued';
      if (!existing.source_url && lead.source_url) existing.source_url = lead.source_url;
      if (JSON.stringify([existing.signals, existing.status, existing.score]) !== before) {
        await env.ORDERS.put('lead:' + lead.id, JSON.stringify(existing), { metadata: leadMeta(existing) }); quotaNote('writes', 'automation'); memDel('leads:all'); counts.updated++;
      } else counts.duplicate++;
      continue;
    }
    lead.seller_code = (lead.seller_code && activeCodes.includes(lead.seller_code))
      ? lead.seller_code : allocateSeller(lead.dedupe, activeCodes);
    await env.ORDERS.put('lead:' + lead.id, JSON.stringify(lead), { metadata: leadMeta(lead) }); quotaNote('writes', 'automation'); memDel('leads:all'); memDelPrefix('listkeys:');
    counts.added++; if (lead.status === 'research_hold') counts.research_hold++;
    if (added.length < 100) added.push(lead.id);
  }
  return { ok: true, counts, junk_why: junkWhy, added_ids: added,
    note: 'Two signals is the door out of research_hold; allocation is by hash across active sellers; dnc is checked before anything is stored. No outreach is sent here — this fills the queue sellers work.' };
}
async function leadsListSeller(url, env) {
  const doc = await leadActor(env, url.searchParams.get('code') || '', url.searchParams.get('key') || '');
  if (!doc) return json({ ok: false, error: 'seller code + key required' }, 401);
  const leads = await listLeads(env, { ...(doc.owner ? {} : { seller: doc.code }), status: url.searchParams.get('status') || '' });
  return json({ ok: true, seller: doc.code, leads, count: leads.length }, 200, { 'Cache-Control': 'no-store' });
}
async function leadsAct(req, env) {
  const b = await readBody(req).catch(() => ({}));
  const doc = await leadActor(env, b.code || '', b.key || '');
  if (!doc) return json({ ok: false, error: 'seller code + key required' }, 401);
  const id = String(b.id || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
  const lead = id ? await env.ORDERS.get('lead:' + id, 'json').catch(() => null) : null;
  if (!lead) return json({ ok: false, error: 'no such lead' }, 404);
  if (!doc.owner && lead.seller_code && lead.seller_code !== doc.code) {
    return json({ ok: false, conflict: true, error: 'allocated to ' + lead.seller_code + ' — one prospect, one voice' }, 409);
  }
  // The outreach runner holds no seller keys (they hash at rest and are shown once), so the
  // owner credential may name the allocated seller it is acting for — and ONLY that seller:
  // an as_seller that does not match the allocation is the same 409 as any other collision.
  let actor = doc.owner ? 'owner' : doc.code;
  if (doc.owner && b.as_seller) {
    const as = cleanSellerCode(String(b.as_seller));
    if (as && lead.seller_code && lead.seller_code !== as) {
      return json({ ok: false, conflict: true, error: 'allocated to ' + lead.seller_code + ' — one prospect, one voice' }, 409);
    }
    if (as) actor = as;
  }
  // v2.0.0: the runner cannot run the gate itself, so the door does. A row filed before the gate
  // existed (support@meta.com was one) is refused here instead of being emailed.
  if ((b.action === 'claim' || b.action === 'contacted') && (lead.status === 'queued' || lead.status === 'research_hold')) {
    const junk = leadJunkReason(lead) || (lead.email && !leadEmailFor(lead.email, lead.source_url, lead.website) ? 'address does not belong to the business' : '');
    if (junk) return json({ ok: false, junk, error: 'not a lead: ' + junk }, 422);
  }
  const t = leadTransition(lead, b.action, actor, { shop: b.shop, follow_days: b.follow_days, now: Date.now() });
  if (!t.ok) return json({ ok: false, conflict: !!t.conflict, error: t.error, ...(t.actions ? { actions: t.actions } : {}) }, t.conflict ? 409 : 422);
  if (b.note) t.lead.note = String(b.note).slice(0, 300);
  if (b.sender && isEmail(String(b.sender))) t.lead.last_sender = String(b.sender).toLowerCase().slice(0, 80);
  await env.ORDERS.put('lead:' + id, JSON.stringify(t.lead), { metadata: leadMeta(t.lead) }); quotaNote('writes', 'automation'); memDel('leads:all');
  if (b.action === 'dnc') {
    try {
      if (t.lead.email) await env.STORES.put('Lead:' + t.lead.email, JSON.stringify({ at: new Date().toISOString(), by: doc.code }));
      if (t.lead.phone) await env.STORES.put('Lead:' + t.lead.phone, JSON.stringify({ at: new Date().toISOString(), by: doc.code }));
    } catch (e) { void e; }
  }
  return json({ ok: true, lead: t.lead });
}

/* --------------------------------------------------------------- the autonomous list
 * v1.7.1. The playbook's first week was "build a list of 60 agencies and 30 accountants". That is
 * now a job that runs itself: the cron picks a slice of the target queries, reads public pages,
 * files candidates into the same lead pipeline the sellers work, and records what it did. It never
 * sends, never claims, and never exceeds a daily write budget — a discovery pass must never be the
 * reason an order cannot land.
 */
const DISC_STATE = 'disc:state';
const DISC_PER_RUN_DEFAULT = 8;     // jobs per pass: enough for the directory to be asked about every ZW segment
const DISC_LIMIT_DEFAULT = 12;      // candidates per pass
const DISC_WRITES_MAX = 20;         // new leads per day, so the lead pipeline stays a queue

async function discoverState(env) {
  const raw = env.ORDERS ? await env.ORDERS.get(DISC_STATE, 'json').catch(() => null) : null;
  return (raw && typeof raw === 'object') ? raw : { runs: [], done: [], added: 0, day: '', candidates: 0, errors: 0 };
}

/** One pass. Bounded by writes, not by ambition. */
async function discoveryPass(env, opts = {}) {
  // A switch, so a test run (or a workshop with no network) never reaches out to a search engine
  // inside a cron. Never used to hide a failure: when it is on, it runs or it reports the error.
  if (String(env.DISCOVERY || '') === 'off') return { ok: true, skipped: 'disabled', added: 0, candidates: 0 };
  const st = await discoverState(env);
  const today = new Date().toISOString().slice(0, 10);
  if (!opts.force && st.day === today) {
    return { ok: true, skipped: 'already_ran_today', added: 0, candidates: 0, summary: null, state: { day: st.day, added: st.added } };
  }
  if (opts.force === false && !quotaGate('writes', 'automation').ok) {
    return { ok: true, skipped: 'quota', added: 0, candidates: 0 };
  }
  // Every market the rail is sold in — a registry of directories is only worth what it is asked,
  // and ZW+ZA alone left Kenya and Nigeria wired but never queried.
  const countries = (opts.countries && opts.countries.length) ? opts.countries : ['ZW', 'ZA', 'KE', 'NG'];
  // The free plan allows 50 fetches per invocation and a morning when every source answers nothing
  // spent 51 (each mirror tried, each reserve job asked). The pass now carries its own budget with
  // headroom, and stops asking when it is spent instead of collecting "Too many subrequests".
  const fetchCap = Math.max(5, Math.min(48, Number(env.DISC_FETCH_CAP) || 42));
  let fetched = 0;
  const budgetFetch = async (u, init) => {
    if (fetched >= fetchCap) { const e = new Error('discovery fetch budget spent (' + fetchCap + ')'); e.budget = true; throw e; }
    fetched++;
    return fetch(u, init);
  };
  const run = await runDiscovery({
    fetch: budgetFetch, spent: () => fetched >= fetchCap,
    nowMs: Date.now(), countries,
    // a paid/keyed provider if the Worker holds one; otherwise the search leg stays Bing RSS
    search: searchProvider(env),
    perRun: Math.max(1, Math.min(12, Number(opts.perRun) || DISC_PER_RUN_DEFAULT)),
    limit: Math.max(1, Math.min(24, Number(opts.limit) || DISC_LIMIT_DEFAULT)),
    perQuery: 3, done: st.done || [],
    // The map is answered once a day per segment and kept for twenty hours: a capacity spike at
    // Overpass must not cost the day's list, and the data changes at map speed, not shop speed.
    cacheGet: async (k) => {
      try { return await env.ORDERS.get('osm:' + k, 'json'); } catch (e) { return null; }
    },
    cachePut: async (k, v) => {
      try { await env.ORDERS.put('osm:' + k, JSON.stringify(v), { expirationTtl: 20 * 3600 }); quotaNote('writes', 'automation'); } catch (e) { void e; }
    },
  });
  const summary = discoverySummary(run.candidates);
  const budget = Math.max(0, Math.min(DISC_WRITES_MAX, Number(opts.writes) || DISC_WRITES_MAX) - (st.added_today || 0));
  const batch = run.candidates.filter((c) => c.email || c.phone || c.source_url).slice(0, budget);
  let ingest = { counts: { added: 0, updated: 0, duplicate: 0, invalid: 0 }, added_ids: [] };
  if (batch.length) {
    try { ingest = await ingestLeads(env, batch); } catch (e) { ingest.error = String(e && e.message || e); }
  }
  const next = {
    ...st,
    day: today,
    added_today: (st.added_today || 0) + (ingest.counts.added || 0),
    added: (st.added || 0) + (ingest.counts.added || 0),
    candidates: (st.candidates || 0) + summary.candidates,
    errors: (st.errors || 0) + run.errors.length,
    done: [...new Set([...(st.done || []), ...run.ran.map((r) => r.key)])].slice(-400),
    runs: [...(st.runs || []), {
      at: new Date().toISOString(), day: run.day,
      queries: run.ran.length, candidates: summary.candidates, added: ingest.counts.added || 0,
      by_segment: summary.by_segment, errors: run.errors.length,
      // what the gate refused, so "a quiet morning" and "a broken gate" look different in the log
      rejected: run.rejected || {},
      // the text of what went wrong, not only the count: "errors: 1" diagnoses nothing
      last_errors: run.errors.slice(0, 3),
    }].slice(-30),
  };
  if (env.ORDERS && (ingest.counts.added || run.ran.length)) {
    try { await governedPut(env.ORDERS, DISC_STATE, JSON.stringify(next), null, 'automation'); } catch (e) { void e; }
  }
  return { ok: true, ran: run.ran.length, candidates: summary.candidates, added: ingest.counts.added || 0,
    updated: ingest.counts.updated || 0, by_segment: summary.by_segment, errors: run.errors.slice(0, 3),
    rejected: run.rejected || {},
    summary: summary.note, state: { day: next.day, added_today: next.added_today, added: next.added } };
}

async function discoverStatus(req, env) {
  const denied = await pressAdmin(req, env); if (denied) return denied;
  const st = await discoverState(env);
  return json({
    ok: true,
    targets: TARGET_SEGMENTS.map((t) => ({ rank: t.rank, key: t.key, label: t.label, why: t.why, queries: Object.values(t.queries || {}).reduce((a, x) => a + x.length, 0) })),
    state: { day: st.day || 'never', runs: (st.runs || []).length, added: st.added || 0, added_today: st.added_today || 0, candidates: st.candidates || 0, errors: st.errors || 0, queries_seen: (st.done || []).length },
    gate: { rules: ['platform', 'unverified', 'no_local_signal', 'no_name', 'generic_name', 'institution', 'no_contact'],
      note: 'A candidate is filed only if its page was read, names the market, gives a business name and a way to answer. Refusals are counted, never padded over.' },
    last: (st.runs || []).slice(-5).reverse(),
    budget: { per_day_writes: DISC_WRITES_MAX, per_run_queries: DISC_PER_RUN_DEFAULT, per_run_candidates: DISC_LIMIT_DEFAULT },
    // What is wired, per country, so "why is the list thin" has an answer that is not a guess.
    sources: {
      directories: Object.entries(DIRECTORY_SITES).map(([cc, d]) => ({ country: cc, site: d.host, kind: d.kind })),
      directoryless: ['ZA'],
      search: searchProvider(env) ? { provider: searchProvider(env).provider, label: searchProvider(env).label, state: 'on' } : {
        state: 'off',
        reason: 'no key — set BRAVE_KEY (2,000 free queries a month) or SERPAPI_KEY (100) as a Worker secret and the search leg turns on in the next pass',
      },
      never: ['linkedin.com', 'facebook.com profiles', 'any page behind a login'],
      why: 'A directory the business chose to be listed in is consent. A profile somebody did not publish for this is not, and both networks block datacentre traffic anyway.',
    },
    note: 'Discovery reads public pages and files candidates into the lead queue. It never sends, never claims a lead and never overrides the do-not-contact ledger. A human opens the queue; the cron only fills it.',
  }, 200, { 'Cache-Control': 'no-store' });
}

async function discoverRun(req, env) {
  const denied = await pressAdmin(req, env); if (denied) return denied;
  const b = await readBody(req).catch(() => ({}));
  const out = await discoveryPass(env, { force: true, perRun: b.perRun, limit: b.limit, countries: b.countries });
  return json(out, out.ok ? 200 : 502);
}

/** A partner application is a lead, filed by the same pipeline, with the segment the playbook says
 *  is worth most. Public by necessity, so it is throttled per address and stores nothing a stranger
 *  can abuse: no seller allocation trouble, no echo of other applicants. */
async function partnerApply(req, url, env) {
  const b = await readBody(req).catch(() => ({}));
  const ip = ipOf(req);
  const meterKey = 'pa:' + ip;
  if (env.STORES) {
    const seen = await env.STORES.get(meterKey).catch(() => null);
    const n = Number(seen || 0);
    if (n >= 5) return json({ ok: false, error: 'too_many', note: 'Five applications a day from one address is the limit. Nothing was filed.' }, 429);
    try { await env.STORES.put(meterKey, String(n + 1), { expirationTtl: 86400 }); } catch (e) { void e; }
  }
  const business = String(b.business || b.company || '').trim().slice(0, 80);
  if (business.length < 2) return json({ ok: false, error: 'business_required', note: 'A trading name is the one thing needed.' }, 422);
  const email = isEmail(String(b.email || '')) ? String(b.email).toLowerCase() : '';
  const phone = digits(b.phone || b.whatsapp || '').slice(0, 15);
  if (!email && !phone) return json({ ok: false, error: 'contact_required', note: 'An email or a number — otherwise there is no way to answer.' }, 422);
  const tier = String(b.tier || 'partner').toLowerCase();
  const leadIn = {
    business, name: String(b.name || '').slice(0, 60), email, phone,
    country: String(b.country || '').slice(0, 40), segment: 'agencies',
    source: 'partners page', source_url: String(url.origin + '/partners'),
    note: 'Applied for the ' + tier + ' tier.' + (b.merchants ? ' Carries ' + String(b.merchants).slice(0, 12) + ' merchants.' : '')
      + (b.note ? ' ' + String(b.note).slice(0, 160) : ''),
    signals: ['applied'],   // an application is one honest signal; the pipeline still wants a second
  };
  const out = await ingestLeads(env, [leadIn]);
  return json({ ok: true, filed: out.counts.added > 0 || out.counts.updated > 0, tier,
    note: 'Filed. A person answers applications within one working day — nothing was subscribed, and nothing is charged until you choose a tier.' },
    200, { 'Cache-Control': 'no-store' });
}

/* ---- scheduler slots ---- */
const PRESS_ORIGIN_FALLBACK = 'https://tapstall.zlnew.workers.dev';
async function pressTick(env) {
  if (!env.ORDERS) return { ran: 0, why: 'no ORDERS binding' };
  const reg = await pressRegistry(env);
  if (!Object.keys(reg).length) return { ran: 0, why: 'no press identities registered' };
  const slot = new Date().toISOString().slice(0, 16);   // minute bucket: a retried tick in the same minute is one run; the next 20-min tick is a new flush
  const last = await env.ORDERS.get('press:last', 'json').catch(() => null);
  if (last && last.slot === slot) return { skipped: 'this hour already ran', slot };
  const ran = await runPress(env, env.PUBLIC_ORIGIN || PRESS_ORIGIN_FALLBACK, { dry: false });
  const statuses = {};
  for (const r of ran) for (const x of (r.results || [])) statuses[x.status] = (statuses[x.status] || 0) + 1;
  const sum = { slot, at: new Date().toISOString(), triggered_by: 'cron', identities: ran.length,
    composed: ran.reduce((a, r) => a + (r.composed || 0), 0), sent: ran.reduce((a, r) => a + (r.sent || 0), 0),
    waiting: ran.reduce((a, r) => a + (r.waiting || 0), 0),
    duplicates: ran.reduce((a, r) => a + (r.duplicates || 0), 0), statuses,
    ran: ran.map((r) => ({ id: r.id, ok: r.ok, composed: r.composed || 0, in_slot: r.in_slot || 0, skipped_slots: r.skipped_slots || 0,
      sent: r.sent || 0, waiting: r.waiting || 0, duplicates: r.duplicates || 0, expired_slots: r.expired_slots || 0,
      token_present: !!r.token_present, error: r.error || '',
      ...(r.skipped ? { skipped: true, why: r.why || '' } : {}), ...(r.rails ? { rails: r.rails } : {}) })) };
  // The slot is claimed so a retried tick cannot double-send a window. A tick that composed nothing
  // and sent nothing has no window to protect, and rewriting an identical summary 72 times a day was
  // the single largest line on the KV write budget. So an idle tick writes only when its picture
  // differs from the last one, or once a day as a heartbeat the console can date.
  const shape = (x) => JSON.stringify({ ...x, slot: '', at: '' });
  const quiet = !sum.composed && !sum.sent && last && String(last.at || '').slice(0, 10) === sum.at.slice(0, 10) && shape(last) === shape(sum);
  if (quiet) return { ...sum, unchanged: true };
  try { await env.ORDERS.put('press:last', JSON.stringify(sum)); } catch (e) { void e; }
  return sum;
}
async function dispatchTick(env) {
  const day = new Date().getUTCDay();
  if (day === 0 || day === 6) return { skipped: 'weekend' };
  if (!env.ORDERS) return { ran: 0 };
  // The 00:15 sweep is the first of a new UTC day, so it used to fire the Gmail runner at 02:15 in
  // Harare: cold mail arriving in the night. The day's dispatch now belongs to 06:15 (08:15 local),
  // with 12:15 and 18:15 as the retries.
  const fh = env.DISPATCH_FROM_HOUR;
  const fromHour = fh !== undefined && fh !== '' && Number.isFinite(Number(fh)) ? Number(fh) : 6;
  if (new Date().getUTCHours() < fromHour) return { skipped: 'before ' + fromHour + ':00 UTC: mail goes out in business hours' };
  const stamp = new Date().toISOString().slice(0, 10);
  const last0 = await env.ORDERS.get('dispatch:last', 'json').catch(() => null);
  const last = (last0 && last0.day === stamp) ? last0 : null;
  const done = (k) => !!(last && last[k] === 'dispatched');
  if (done('leads_hunt') && done('outreach')) return { skipped: 'today already dispatched', day: stamp };
  const out = { day: stamp, at: new Date().toISOString(),
    leads_hunt: done('leads_hunt') ? 'dispatched' : 'skipped_no_token', outreach: done('outreach') ? 'dispatched' : 'skipped_no_token' };
  if (!(env.GH_DISPATCH_TOKEN && env.GH_REPO)) return out;   // nothing attempted, nothing worth a write
  const fire = async (wf, inputs) => {
    const r = await fetch('https://api.github.com/repos/' + env.GH_REPO + '/actions/workflows/' + wf + '/dispatches', {
      method: 'POST', headers: { authorization: 'Bearer ' + env.GH_DISPATCH_TOKEN, accept: 'application/vnd.github+json',
        'content-type': 'application/json', 'user-agent': 'tapstall/1 (scheduler)' },
      body: JSON.stringify({ ref: env.GH_REF || 'main', inputs }) });
    return r.status === 204 ? 'dispatched' : 'http ' + r.status;
  };
  // v2.0.0: each workflow is stamped on its own and only when GitHub said 204. The old code stamped
  // the day after an exception ("Too many subrequests"), so a failed morning was never retried.
  if (!done('leads_hunt')) {
    try { out.leads_hunt = await fire('leads-hunt.yml', { post: 'true' }); }
    catch (e) { out.leads_hunt = 'error'; out.error = String(e && e.message || e).slice(0, 120); }
  }
  if (!done('outreach')) {
    try { out.outreach = await fire('outreach.yml', { mode: 'send_and_poll' }); }
    catch (e) { out.outreach = 'error'; out.outreach_error = String(e && e.message || e).slice(0, 120); }
  }
  try { await governedPut(env.ORDERS, 'dispatch:last', JSON.stringify(out), null, 'automation'); } catch (e) { void e; }
  return out;
}
/* ------------------------------------------------------------ outreach over the Gmail lane (v2.0.0; Gmail since v2.2.0)
 * The Gmail runner (Actions, once a weekday) stays; this is the second voice: the Worker itself
 * sends a first touch or a due follow-up from its Gmail lane, at most one per 20-minute tick
 * and only while the lane has room after a slot is held back for merchant mail. Weekdays,
 * 07:00–16:59 UTC (09:00–18:59 in Harare/Johannesburg). House leads only (a seller's lead is
 * that seller's voice). Every lead is re-judged by the v2 gate before a byte is sent, the
 * domain must publish a mail server, and every message carries a one-click unsubscribe.
 * A follow-up goes out from the box the first touch came from, so a thread stays one voice. */
const OUT_FOLLOW_DAYS = [3, 5, 7];
const OUT_MAX_TOUCHES = OUT_FOLLOW_DAYS.length;

async function unsubLink(env, lead) {
  const tok = (await sign(capKey(env), 'unsub:' + lead.id)).replace(/[^A-Za-z0-9]/g, '').slice(0, 22);
  return `${String(env.PUBLIC_ORIGIN || PRESS_ORIGIN_FALLBACK).replace(/\/+$/, '')}/u/${lead.id}/${tok}`;
}
function outreachCompose(lead, origin, fromName, unsub, postal) {
  const biz = String(lead.business || '').trim() || 'there';
  const link = String(origin).replace(/\/+$/, '') + '/onboard';
  const touch = Math.min(Number(lead.touches) || 0, OUT_MAX_TOUCHES - 1);
  const sig = new Set(lead.signals || []);
  const ev = sig.has('whatsapp_selling') ? `I came across ${biz} taking orders on WhatsApp.`
    : sig.has('payment_friction') ? `I came across ${biz} while looking at how shops here match payments to orders.`
    : `I came across ${biz} online.`;
  const foot = `\n\n—\nNot for you? One click and we never write again: ${unsub}` + (postal ? `\n${postal}` : '');
  const subjects = [`${biz} — orders that identify their own payment`, `Following up — ${biz} on Tapstall`, `Last note from me — ${biz}`];
  const bodies = [
    `Hi ${biz} team,\n\n${ev} Tapstall gives a shop like yours one link: customers pick from your menu, pay your own `
      + `EcoCash/PayShap/bank account, and every order carries a unique amount down to the cent — so the money that lands `
      + `identifies the order, no screenshots to argue about.\n\nIt is free for 60 days, then USD 60/year (or USD 7/month). `
      + `No commission on your sales, no order cap.\n\nStart here: ${link}\n\n— ${fromName}, Tapstall\nA reply to this email reaches a person.`,
    `Hi again,\n\nShort version: your menu on one link, payment straight to your own account, and an exact amount per `
      + `order so fake proof-of-payment stops working. Free for 60 days:\n${link}\n\n— ${fromName}`,
    `Hi — last note from me. If order-taking on WhatsApp ever starts costing you sales or disputes, your shop link can be `
      + `live in about two minutes:\n${link}\n\n— ${fromName}`,
  ];
  return { subject: subjects[touch], text: bodies[touch] + foot };
}
async function leadPut(env, lead) {
  await env.ORDERS.put('lead:' + lead.id, JSON.stringify(lead), { metadata: leadMeta(lead) }); quotaNote('writes', 'automation'); memDel('leads:all');
}
async function leadDnc(env, lead, why, by) {
  const t = leadTransition(lead, 'dnc', 'owner', { now: Date.now() });
  const next = t.ok ? t.lead : { ...lead, status: 'dnc' };
  next.note = String(why || 'do not contact').slice(0, 300);
  await leadPut(env, next);
  const rec = JSON.stringify({ at: new Date().toISOString(), by: by || 'owner', why: String(why || '').slice(0, 80) });
  try {
    if (next.email) await env.STORES.put('Lead:' + next.email, rec);
    if (next.phone && by !== 'mx') await env.STORES.put('Lead:' + next.phone, rec);
  } catch (e) { void e; }
  return next;
}

async function outreachTick(env, nowMs) {
  const now = nowMs || Date.now();
  const d = new Date(now), h = d.getUTCHours(), wd = d.getUTCDay();
  if (String(env.OUTREACH_LV || 'on') === 'off') return { skipped: 'off' };
  if (String(env.OUTREACH_WINDOW || '') !== 'always' && (wd === 0 || wd === 6 || h < 7 || h > 16)) return { skipped: 'outside the send window' };
  const lanes = mailLanes(env).filter((l) => l.outreach);
  if (!lanes.length) return { skipped: 'no outreach lane' };
  // The lane allows one outreach message an hour, so the hour is decided on its first tick; the :25 and
  // :45 ticks would only re-list the same leads to find the same answer (31 lists a weekday became 10).
  if (String(env.OUTREACH_WINDOW || '') !== 'always' && d.getUTCMinutes() >= 20) return { skipped: 'outreach is decided on the first tick of the hour' };
  if (!await mailRoom(env, 'outreach')) return { skipped: 'lane has no outreach room this hour' };   // before the lead list: a full hour costs no reads
  const boxes = new Set(lanes.map((l) => l.user.toLowerCase()));
  const nowIso = d.toISOString();
  // One list with metadata picks the candidates; only the (at most four) checked leads are read.
  // Keys from before v2.1.0 carry no metadata, and while any exist the old full read is the honest path.
  const idx = await leadIndex(env);
  const rows = idx.legacy.length ? await listLeads(env, { limit: 2000 }) : idx.rows;
  const follow = rows.filter((l) => l.status === 'contacted' && !l.seller_code && l.email && (Number(l.touches) || 0) < OUT_MAX_TOUCHES
    && l.next_follow_at && l.next_follow_at <= nowIso && boxes.has(String(l.last_sender || '').toLowerCase()));
  const first = rows.filter((l) => l.status === 'queued' && !l.seller_code && l.email);
  const out = { considered: follow.length + first.length, sent: 0, held: 0, dnc: 0 };
  let checks = 0;
  for (const lead0 of [...follow, ...first]) {
    if (checks++ >= 4) break;                         // each check may cost a DNS fetch + a write
    const lead = await env.ORDERS.get('lead:' + lead0.id, 'json').catch(() => null);   // fresh: the runner may have moved it
    if (!lead || !lead.id) continue;                  // gone, or an index row without its document
    if (!['queued', 'contacted'].includes(lead.status)) continue;
    const junk = leadJunkReason(lead);
    const email = leadEmailFor(lead.email, lead.source_url, lead.website);
    if (junk || !email) {
      await leadPut(env, { ...lead, status: 'research_hold', junk: junk || 'address does not belong to the business', updated_at: nowIso });
      out.held++; continue;
    }
    if (await env.STORES.get('Lead:' + email).catch(() => null)) { await leadDnc(env, lead, 'on the do-not-contact ledger', 'ledger'); out.dnc++; continue; }
    if (!await mxOk(email.split('@')[1], env.MAIL_TEST_FETCH)) { await leadDnc(env, lead, 'domain publishes no mail server', 'mx'); out.dnc++; continue; }
    const origin = env.PUBLIC_ORIGIN || PRESS_ORIGIN_FALLBACK;
    const unsub = await unsubLink(env, lead);
    const m = outreachCompose(lead, origin, String(env.OUTREACH_FROM_NAME || 'Courage'), unsub, String(env.POSTAL_ADDRESS || ''));
    const r = await mailSend(env, { to: email, subject: m.subject, text: m.text, kind: 'outreach', unsubscribe: { url: unsub } }, { now });
    if (r.sent) {
      const lane = lanes.find((l) => l.id === r.lane);
      const t = leadTransition(lead, 'contacted', 'owner', { follow_days: OUT_FOLLOW_DAYS[Math.min(Number(lead.touches) || 0, OUT_MAX_TOUCHES - 1)], now });
      if (t.ok) { t.lead.last_sender = lane ? lane.user.toLowerCase() : ''; await leadPut(env, t.lead); }
      out.sent++; out.to_lead = lead.id;
      break;                                           // one per tick, always
    }
    if (r.permanent) { await leadDnc(env, lead, 'refused at send: ' + String(r.why).slice(0, 60), 'bounce'); out.dnc++; continue; }
    out.why = r.why; break;                            // lane full or down: try next tick
  }
  return out;
}

/** /u/<lead>/<tok>: GET shows one button (scanners prefetch); POST (the button, or a mail client's
 *  RFC 8058 one-click) writes the do-not-contact ledger. */
async function unsubRoute(req, url, env) {
  const m = url.pathname.match(/^\/u\/([a-z0-9-]{1,40})\/([A-Za-z0-9]{10,40})$/);
  const page = (msg, form) => html('<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=robots content=noindex>'
    + '<title>Tapstall</title><body style="font:17px system-ui;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.3rem">Tapstall</h1><p>' + msg + '</p>' + (form || '') + '</body>', 200, NOINDEX);
  if (!m) return page('That link is not complete. Reply to the email with the word STOP and a person will remove you.');
  const want = (await sign(capKey(env), 'unsub:' + m[1])).replace(/[^A-Za-z0-9]/g, '').slice(0, 22);
  if (!timingSafeEq(want, m[2])) return page('That link is not valid. Reply to the email with the word STOP and a person will remove you.');
  const lead = await env.ORDERS.get('lead:' + m[1], 'json').catch(() => null);
  if (req.method !== 'POST') {
    if (lead && lead.status === 'dnc') return page('You are already unsubscribed. We will not write again.');
    return page('Stop all emails from Tapstall to this business?', '<form method=post><button style="font:inherit;padding:.7rem 1.2rem">Unsubscribe</button></form>');
  }
  if (lead && lead.status !== 'dnc') await leadDnc(env, lead, 'unsubscribed by link', 'unsubscribe');
  return page('Done. You will not hear from us again.');
}

/** The 20-minute clock (PRESS_CRON). Each job is small, and discovery — the only one that fans out
 *  to dozens of fetches — gets its own invocation in the quiet hour, so it can never again starve
 *  the dispatch of its 50-subrequest allowance (the 2026-10-28 "Too many subrequests"). */
async function tick(env) {
  const out = {};
  const h = new Date().getUTCHours();
  if (h === 2 || h === 3) {
    const st = await discoverState(env).catch(() => ({}));
    if (st.day !== new Date().toISOString().slice(0, 10)) {
      try { const d = await discoveryPass(env, {}); out.discovery = { added: d.added || 0, candidates: d.candidates || 0, skipped: d.skipped || null }; }
      catch (e) { out.discovery = { error: String(e && e.message || e).slice(0, 80) }; }
      if (!(out.discovery && out.discovery.skipped)) return out;   // it really ran: this invocation's fetches are spent

    }
  }
  try { out.press = await pressTick(env); } catch (e) { out.press = { error: String(e && e.message || e).slice(0, 120) }; }
  try { out.mailq = await mailDrain(env, 3); } catch (e) { out.mailq = { error: String(e && e.message || e).slice(0, 120) }; }
  try { out.outreach = await outreachTick(env); } catch (e) { out.outreach = { error: String(e && e.message || e).slice(0, 120) }; }
  return out;
}

/** The nightly exception digest: derived from the same rows everything else reads, stored once,
 *  and surfaced by /ops/api/health. It exists so the owner's morning question — "what needs a
 *  person?" — has one answer with numbers, instead of an approval queue with opinions. */
async function writeDigest(env, sweep) {
  const now = Date.now();
  // The cron sweep just listed every store and judged the same three facts
  // from metadata; rescanning the estate here would double the nightly reads
  // to learn them twice. A direct call with no sweep keeps the old path.
  let total = 0, live = 0, suspended = 0; const expiring = [];
  if (sweep && Number.isFinite(Number(sweep.total))) {
    total = Number(sweep.total) || 0;
    live = Number(sweep.live) || 0; suspended = Number(sweep.suspended) || 0;
    for (const x of sweep.expiring || []) expiring.push(x);
  } else {
    const handles = (await listKeys(env.STORES, 'store:', 1000)).map((k) => k.slice('store:'.length)).filter(Boolean);
    total = handles.length;
    for (const h of handles) {
      try {
        const st = await getStore(env, h);
        if (!st) continue;
        const left = ((st.paid_until || 0) - now) / 864e5;
        if (st.suspended) suspended++;
        else if (left > 0) { live++; if (left <= 14) expiring.push({ handle: h, left_days: Math.ceil(left) }); }
      } catch (e) { void e; }
    }
  }
  let refCount = 0; const refHandles = [];
  for (const k of await listKeys(env.STORES, 'ref:', 200)) {
    try { const rows = await env.STORES.get(k, 'json'); const n = Array.isArray(rows) ? rows.length : 0; if (n) { refCount += n; refHandles.push(k.slice('ref:'.length)); } } catch (e) { void e; }
  }
  const reg = await pressRegistry(env);
  let queuedItems = 0, overdueItems = 0;
  for (const id of Object.keys(reg)) {
    try {
      const q = await env.ORDERS.get('press:queue:' + id, 'json');
      for (const it of ((q && q.items) || [])) { queuedItems++; if (Date.parse(it.due || '') < now) overdueItems++; }
    } catch (e) { void e; }
  }
  const pressLast = await env.ORDERS.get('press:last', 'json').catch(() => null);
  const leads = await listLeads(env, { limit: 2000 });
  const by_status = {}; let followups_due = 0;
  for (const l of leads) {
    by_status[l.status] = (by_status[l.status] || 0) + 1;
    if (l.next_follow_at && Date.parse(l.next_follow_at) <= now && !['closed', 'dnc'].includes(l.status)) followups_due++;
  }
  const sales30 = (await listSales(env)).filter((s) => now - Date.parse(s.at || '') <= 30 * 864e5);
  const whopUnmatched = (await listKeys(env.ORDERS, 'whop:unmatched:', 200)).length;
  const whopRefunds = (await listKeys(env.ORDERS, 'whop:refund:', 200)).length;
  const digest = { at: new Date(now).toISOString(), version: VERSION,
    stores: { total, live, suspended, expiring_14d: expiring },
    awaiting_refs: { count: refCount, handles: refHandles },
    press: { identities: Object.keys(reg).length, queued_items: queuedItems, overdue_items: overdueItems,
      last_run: pressLast ? { at: pressLast.at, sent: pressLast.sent, statuses: pressLast.statuses } : null },
    leads: { total: leads.length, by_status, followups_due },
    whop: { unmatched_payments: whopUnmatched, refunds_to_review: whopRefunds },
    sales_30d: { count: sales30.length, revenue: round2(sales30.reduce((a, s) => a + (Number(s.amount) || 0), 0)),
      commission: round2(sales30.reduce((a, s) => a + (Number(s.commission) || 0), 0)) },
    needs_a_person: [
      ...(refCount ? [refCount + ' payment reference(s) to recognise (' + refHandles.join(', ') + ')'] : []),
      ...(expiring.length ? [expiring.length + ' shop(s) inside 14 days of expiry'] : []),
      ...(overdueItems ? [overdueItems + ' press item(s) overdue in queue (credential or rail missing — bind the secret, the cron does the rest)'] : []),
      ...(followups_due ? [followups_due + ' lead follow-up(s) due for sellers'] : []),
      ...(whopUnmatched ? [whopUnmatched + ' Whop payment(s) could not be matched to a shop (wrong handle at checkout?) — match by hand, the money is already in Whop'] : []),
      ...(whopRefunds ? [whopRefunds + ' Whop refund/dispute(s) to review before any term is clawed back'] : []),
    ] };
  try { await governedPut(env.ORDERS, 'digest:last', JSON.stringify(digest), null, 'operator'); } catch (e) { void e; }
  return { written: true, needs_a_person: digest.needs_a_person.length, stores_live: live, leads_total: leads.length };
}

/* ==================== v1.1.0 — Whop automated activation ====================
 * The card money lives on Whop; this door is how a cleared Whop payment becomes a switched-on
 * shop with no person in between. It refuses everything until WHOP_WEBHOOK_SECRET exists
 * (fail-closed like every money door here), verifies the Standard Webhooks signature exactly
 * the way the sister product's mint verifies it live, routes the event in the core (failed and
 * invalid are not sales), matches the shop by the checkout's own handle answer — then the
 * stored membership, then the buyer's email — and never guesses: an unmatched *payment* is
 * money already taken, so it is filed for the owner's exception digest, not bounced at Whop
 * and not credited to a stranger. A purchase fires companion events (membership valid +
 * payment succeeded); the mint's rule applies — a second grant signal inside 3 days for the
 * same shop is the companion, not a second year. Refunds move nothing automatically: they are
 * flagged for a human, because clawing back a trading shop's term is a judgement. */
async function hmacB64(secret, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
async function verifyWhopSig(headers, rawBody, secret) {
  if (!secret) return { ok: false, reason: 'no secret' };
  const id = headers['webhook-id'] || '', ts = headers['webhook-timestamp'] || '', provided = headers['webhook-signature'] || '';
  if (!id || !ts || !provided) return { ok: false, reason: 'missing headers' };
  const t = parseInt(ts, 10);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return { ok: false, reason: 'stale timestamp' };
  const expected = await hmacB64(secret, id + '.' + ts + '.' + rawBody);
  for (const part of String(provided).split(/\s+/)) {
    const bare = part.slice(0, 3) === 'v1,' ? part.slice(3) : part;
    if (bare.length === expected.length) {
      let same = 0; for (let i = 0; i < expected.length; i++) same |= expected.charCodeAt(i) ^ bare.charCodeAt(i);
      if (same === 0) return { ok: true };
    }
  }
  return { ok: false, reason: 'signature mismatch' };
}
function whopCatalog(env) {
  try { const c = JSON.parse(String(env.WHOP_PLANS_JSON || '{}')); return (c && typeof c === 'object') ? c : {}; }
  catch (e) { return {}; }
}
/** Apply a paid Whop term to a shop: the one place it happens (webhook match or buyer claim). */
async function whopGrant(env, st, term, buyer, ref) {
  const amount = term.amount || (term.days >= 300
    ? (term.currency === 'ZAR' ? SUBSCRIPTION_PLANS.annual.zar : SUBSCRIPTION_PLANS.annual.usd)
    : (term.currency === 'ZAR' ? SUBSCRIPTION_PLANS.monthly.zar : SUBSCRIPTION_PLANS.monthly.usd));
  st.paid_until = Math.max(Date.now(), st.paid_until || 0) + term.days * 864e5;
  st.plan = term.days >= 300 ? 'annual' : 'term';
  st.suspended = false; st.warned_at = null;
  if (buyer.membership_id) st.whop_membership_id = buyer.membership_id;
  st.whop_status = 'valid';
  st.whop_last_grant = { at: new Date().toISOString(), ref, days: term.days, from: term.from };
  await writeStore(env, st);
  if (buyer.membership_id) { try { await env.STORES.put('whopmem:' + buyer.membership_id, JSON.stringify({ handle: st.handle, at: new Date().toISOString() })); } catch (e) { void e; } }
  if (buyer.payment_id) { try { await env.STORES.put('paid:whop:pay:' + buyer.payment_id, JSON.stringify({ handle: st.handle, at: new Date().toISOString() }), { expirationTtl: 40 * 86400 }); } catch (e) { void e; } }
  const code = cleanSellerCode(st.seller_code || '');
  const sd = code ? await sellerDoc(env, code).catch(() => null) : null;
  const sale = await recordSale(env, st, { amount, currency: term.currency, days: term.days, provider: 'whop',
    ref: buyer.payment_id || buyer.membership_id || ref,
    commission_via: (buyer.affiliate || (sd && sd.whop)) ? 'whop' : 'internal' });
  return sale;
}

/** POST /api/whop/claim {claim} — signed in as the shop the buyer wants credited. */
async function whopClaim(req, url, env) {
  const b = await readBody(req);
  const who = await identify(req, env, b.handle || url.searchParams.get('handle'));
  if (!who || !who.st) return json({ ok: false, need_login: true, error: 'Sign in to the shop this payment is for, then open the link again.' }, 401);
  const lr = lockRes(who); if (lr) return lr;
  if (who.anonymous || who.bad) return json({ ok: false, need_login: true, error: 'Sign in to the shop this payment is for, then open the link again.' }, 401);
  if (who.via === 'sess' && (reqHeader(req, 'x-tapstall-confirm') || '') !== '1') return json({ ok: false, error: 'missing x-tapstall-confirm header' }, 403);
  const tok = String(b.claim || '').replace(/[^a-z0-9]/g, '').slice(0, 40);
  const c = tok ? await env.ORDERS.get('whop:claim:' + tok, 'json').catch(() => null) : null;
  const u = c && c.key ? await env.ORDERS.get(c.key, 'json').catch(() => null) : null;
  if (!u || !u.term) return json({ ok: false, error: 'This payment link was already used or has expired. Reply to the payment email and we will sort it out by hand.' }, 410);
  const st = who.st;
  if (u.payment_id && await env.STORES.get('paid:whop:pay:' + u.payment_id, 'json').catch(() => null)) {
    try { await env.ORDERS.delete('whop:claim:' + tok); await env.ORDERS.delete(c.key); } catch (e) { void e; }
    return json({ ok: false, error: 'This payment was already applied to a shop.' }, 409);
  }
  const buyer = { email: u.email || '', name: u.name || '', membership_id: u.membership_id || '', payment_id: u.payment_id || '', affiliate: u.affiliate || '' };
  if (buyer.email && String(st.owner_email || '').toLowerCase() === buyer.email) st.email_verified = buyer.email;   // the claim link reached that inbox
  const sale = await whopGrant(env, st, u.term, buyer, u.ref || tok);
  try { await env.ORDERS.delete('whop:claim:' + tok); await env.ORDERS.delete(c.key); } catch (e) { void e; }
  await pushAudit(env, st, { act: 'whop_claim', via: who.via, fields: ['paid_until'], ip: ipOf(req) });
  return json({ ok: true, handle: st.handle, days: u.term.days, paid_until: new Date(st.paid_until).toISOString(),
    commission: sale ? { seller: sale.seller_code, amount: sale.commission, via: sale.commission_via } : null });
}

async function hookWhop(req, url, env, ctx) {
  const say = (obj, code = 200) => {
    const kind = code === 200 ? (obj.already ? 'already' : obj.activated ? 'activated' : 'ignored') : 'refused';
    auditHook(env, ctx, kind, obj.error || obj.ignored || obj.note || '');
    return json(obj, code);
  };
  if (!env.WHOP_WEBHOOK_SECRET) return say({ ok: false, error: 'the Whop webhook is not armed — set WHOP_WEBHOOK_SECRET on this Worker (Whop dashboard → Developer → Webhooks), then payments will activate shops by themselves' }, 503);
  const raw = await req.text().catch(() => '');
  const headers = {};
  req.headers.forEach((v, k) => { headers[String(k).toLowerCase()] = v; });
  const v = await verifyWhopSig(headers, raw, String(env.WHOP_WEBHOOK_SECRET));
  if (!v.ok) return say({ ok: false, error: 'webhook verification failed: ' + v.reason }, 401);
  let b = null;
  try { b = JSON.parse(raw); } catch (e) { return say({ ok: false, error: 'bad json' }, 400); }
  const webhookId = String(headers['webhook-id'] || '').slice(0, 80);
  const seenKey = webhookId ? 'paid:whop:' + webhookId : '';
  if (seenKey && await env.STORES.get(seenKey, 'json').catch(() => null)) return say({ ok: true, already: true });
  const markSeen = async (extra) => { if (seenKey) { try { await env.STORES.put(seenKey, JSON.stringify({ at: new Date().toISOString(), ...(extra || {}) }), { expirationTtl: 40 * 86400 }); } catch (e) { void e; } } };
  const action = String(b.action || b.type || '');
  const kind = whopEventKind(action);
  const buyer = whopBuyer(b);
  if (kind === 'test' || kind === 'ignore') { await markSeen({ kind }); return say({ ok: true, ignored: kind }); }

  let st = buyer.handle ? await getStore(env, buyer.handle) : null;
  if (!st && buyer.membership_id) {
    const idx = await env.STORES.get('whopmem:' + buyer.membership_id, 'json').catch(() => null);
    if (idx && idx.handle) st = await getStore(env, idx.handle);
  }
  if (!st && buyer.email) {
    const wanted = emailHash(buyer.email);
    const legacy = [];
    try {
      let cursor, pages = 0;
      do {
        const l = await env.STORES.list({ prefix: 'store:', limit: 1000, cursor });
        quotaNote('lists', 'operator');
        for (const k of l.keys || []) {
          const handle = String(k.name).slice('store:'.length);
          const hashes = (k.metadata && k.metadata.e) || null;
          if (!hashes) { legacy.push(handle); continue; }
          if (hashes.includes(wanted)) {
            const cand = await getStore(env, handle, { fresh: true });
            if (cand && String(cand.email_verified || '') === buyer.email && String(cand.owner_email || '').toLowerCase() === buyer.email) { st = cand; break; }
          }
        }
        cursor = l.list_complete ? undefined : l.cursor;
      } while (!st && cursor && ++pages < 5);
    } catch (e) { void e; }
    for (const handle of legacy) {
      if (st) break;
      try {
        const cand = await getStore(env, handle, { fresh: true });
        if (cand && String(cand.email_verified || '') === buyer.email && String(cand.owner_email || '').toLowerCase() === buyer.email) st = cand;
      } catch (e) { void e; }
    }
  }

  if (kind !== 'grant') {
    if (st) {
      st.whop_status = action.slice(0, 60);
      if (buyer.membership_id) st.whop_membership_id = buyer.membership_id;
      try { await writeStore(env, st); } catch (e) { void e; }
      if (kind === 'refund') {
        try { await env.ORDERS.put('whop:refund:' + (buyer.payment_id || webhookId || Date.now()),
          JSON.stringify({ at: new Date().toISOString(), handle: st.handle, action, payment_id: buyer.payment_id })); } catch (e) { void e; }
      }
    }
    await markSeen({ kind });
    return say({ ok: true, ignored: kind, matched: st ? st.handle : null });
  }

  if (!st) {
    // v2.0.0: a payment nobody can match used to sit in a KV key the buyer never heard about.
    // Now the buyer gets a claim link; opening it while signed in to their shop applies the term.
    // Matching is still never a guess: a confirmed email, a membership seen before, or the
    // handle the checkout carried — otherwise the buyer chooses, not the Worker.
    const uKey = 'whop:unmatched:' + (webhookId || buyer.payment_id || String(Date.now()));
    const term = whopTerm(b, whopCatalog(env));
    const claim = alnumToken(20);
    try { await env.ORDERS.put(uKey,
      JSON.stringify({ at: new Date().toISOString(), action, email: buyer.email, name: buyer.name,
        membership_id: buyer.membership_id, payment_id: buyer.payment_id, handle_said: buyer.handle, affiliate: buyer.affiliate || '',
        money: whopMoney(b), term, claim, ref: buyer.payment_id || webhookId,
        note: 'Whop was paid; no shop matched. The buyer was emailed a claim link; or match by hand (ops → extend), then delete this key.' }),
      { expirationTtl: 90 * 86400 });
      await env.ORDERS.put('whop:claim:' + claim, JSON.stringify({ key: uKey }), { expirationTtl: 90 * 86400 });
    } catch (e) { void e; }
    let mailed = false;
    if (buyer.email) {
      mailed = await sendMail(env, buyer.email, 'Your Tapstall payment — one step to attach it to your shop',
        `Thanks${buyer.name ? ' ' + String(buyer.name).split(' ')[0] : ''} — your Whop payment for Tapstall arrived (${term.days} days).\n\n`
        + `We could not tell which shop it is for, so nothing has been applied yet. Open this link, sign in to your shop with its name and PIN, and the time is added at once:\n`
        + `${env.PUBLIC_ORIGIN || url.origin}/a?claim=${claim}\n\n`
        + `No shop yet? Make one first at ${env.PUBLIC_ORIGIN || url.origin}/onboard (free), then open the link above.\n`
        + `The link works for 90 days. Reply to this email if anything looks wrong.\n`);
    }
    await markSeen({ kind, unmatched: true, mailed });
    return say({ ok: true, unmatched: true, mailed, note: 'filed with a claim link for the buyer — never credited to a guessed shop' });
  }

  if (buyer.payment_id && await env.STORES.get('paid:whop:pay:' + buyer.payment_id, 'json').catch(() => null)) {
    await markSeen({ kind, already: 'payment' }); return say({ ok: true, already: true, activated: st.handle });
  }
  const last = st.whop_last_grant;
  if (last && Date.now() - Date.parse(last.at || '') < 3 * 864e5) {
    await markSeen({ kind, companion: true });
    return say({ ok: true, already: true, companion: true, activated: st.handle });
  }

  const term = whopTerm(b, whopCatalog(env));
  const sale = await whopGrant(env, st, term, buyer, buyer.payment_id || webhookId);
  await markSeen({ kind, handle: st.handle });
  return say({ ok: true, activated: st.handle, days: term.days, term_from: term.from,
    paid_until: new Date(st.paid_until).toISOString(), commission: sale ? { seller: sale.seller_code, amount: sale.commission, via: sale.commission_via } : null });
}

/** The outreach runner's key ring, the STPi /hook/settings shape: Gmail app passwords live as
 *  Worker secrets named GMAIL_<TAG>_USER / GMAIL_<TAG>_APP_PASSWORD (tag = seller code
 *  uppercased with non-letters stripped, OWNER for the house mailbox), and the one caller who
 *  may read them back is the admin-gated runner. They are never in KV, never in git, and this
 *  answer is never cached. */
async function outreachMailboxes(req, env) {
  const denied = await pressAdmin(req, env); if (denied) return denied;
  const out = [];
  for (const k of Object.keys(env || {})) {
    const m = k.match(/^GMAIL_([A-Z0-9]+)_USER$/);
    if (m && env['GMAIL_' + m[1] + '_APP_PASSWORD']) out.push({ tag: m[1], user: String(env[k]), app_password: String(env['GMAIL_' + m[1] + '_APP_PASSWORD']),
      smtp: true, imap_host: 'imap.gmail.com' });
  }
  // A Worker lane on a box the runner doesn't already know (MAILBOX_<ID>_* secrets) is poll-only for the
  // runner: the Worker sends on it under its own hourly counter; the runner only reads replies.
  for (const l of mailLanes(env)) {
    if (out.some((o) => o.user.toLowerCase() === l.user.toLowerCase())) continue;
    out.push({ tag: 'W' + l.id.toUpperCase(), user: l.user, app_password: l.pass, smtp: false, imap_host: l.imapHost, readonly: true });
  }
  return json({ ok: true, mailboxes: out }, 200, { 'Cache-Control': 'no-store' });
}
