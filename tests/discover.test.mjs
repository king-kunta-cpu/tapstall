/**
 * Discovery is the part of the platform that decides *who the company talks to next* without a
 * person in the loop, so the rules it must never break are pinned here as tests rather than as
 * promises in a doc:
 *
 *   - the target list is ranked the way the playbook ranks it, and every segment is one the lead
 *     pipeline actually accepts (`LEAD_SEGMENTS`), or an agency would silently score as "other";
 *   - a pass is bounded and deterministic per day, so a retried cron is the same slice of work;
 *   - reading is all it does: it names a prospect, a page, and a hook that page supports. It never
 *     invents a contact, never claims a lead and never sends anything;
 *   - the three partner tiers are flat prices in data, not copy in a template.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
import {
  TARGET_SEGMENTS, SEGMENT_KEYS, segmentFor, discoveryPlan, parseBingRss, decodeEntities,
  stripTags, usableHost, hostOf, businessFromTitle, hookFor, readPageEvidence, candidateLead,
  discoverySummary, runDiscovery, placeOf, COUNTRY_NAMES, admitCandidate, phonePlausible,
  marketMention, MARKET_CITIES, overpassQuery, parseOverpass, OSM_TAGS, OSM_CITIES, OVERPASS_URL,
  OVERPASS_MIRRORS, OVERPASS_TIMEOUTS, parseDirectory, parseDirectoryIndex, DIRECTORY_KEYWORDS,
  DIRECTORY_INDEX, DIRECTORY_SITES, DIRECTORY_PHRASES, dialablePhone, parseDirectorySearch,
  parseCompanyPage, searchProvider, parseBrave, parseSerpApi,
} from '../worker/discover.js';
import { LEAD_SEGMENTS, PARTNER_TIERS, PARTNER_TIER_KEYS, cleanLead, cleanLeadEvidence } from '../worker/core.js';

test('the targets are ranked in playbook order and every segment is one the pipeline accepts', () => {
  assert.deepEqual(TARGET_SEGMENTS.map((s) => s.key),
    ['agencies', 'accountants', 'pos_resellers', 'associations', 'social_merchants'],
    'agencies first, then the people who do their month-end, then tills, rooms, and the long tail');
  assert.deepEqual(TARGET_SEGMENTS.map((s) => s.rank), [1, 2, 3, 4, 5], 'rank is data, not array position');
  const weights = TARGET_SEGMENTS.map((s) => s.weight);
  assert.deepEqual(weights, [...weights].sort((a, b) => b - a), 'and weight falls with rank: ' + weights.join(' > '));
  for (const s of TARGET_SEGMENTS) {
    assert.ok(LEAD_SEGMENTS.includes(s.key), s.key + ' must be a segment the lead pipeline knows, or its leads score as "other"');
    assert.ok(s.why && s.why.length > 20, s.key + ' says why it is worth a person’s morning');
    const qs = Object.values(s.queries || {}).flat();
    assert.ok(qs.length >= 1, s.key + ' has live queries');
    assert.ok(Object.keys(s.queries).every((cc) => /^[A-Z]{2}$/.test(cc)), s.key + ' keys queries by country code');
  }
  assert.equal(SEGMENT_KEYS.length, 5);
  assert.equal(segmentFor('agencies').rank, 1);
  assert.equal(segmentFor('nope'), null, 'an unknown key is null, never a guess');
});

test('a pass is bounded, deterministic per day, and never repeats a query inside itself', () => {
  const day1 = 20300 * 864e5;
  const a = discoveryPlan({ nowMs: day1, perRun: 5, countries: ['ZW', 'ZA'] });
  const b = discoveryPlan({ nowMs: day1 + 1000 * 60 * 60, perRun: 5, countries: ['ZW', 'ZA'] });
  assert.deepEqual(a.jobs.map((j) => j.key), b.jobs.map((j) => j.key), 'the same day plans the same slice, so a retry is not extra work');
  assert.equal(a.jobs.length, 5, 'five queries a run');
  assert.equal(new Set(a.jobs.map((j) => j.key)).size, 5, 'no query twice in one pass');
  assert.ok(a.total >= 20, 'the pool is bigger than a run, or the rotation means nothing: ' + a.total);

  // fresh-first: what has ever run is not picked again until the pool is spent
  const done = a.jobs.map((j) => j.key);
  const next = discoveryPlan({ nowMs: day1, perRun: 5, done });
  assert.ok(next.jobs.every((j) => !done.includes(j.key)), 'a query that has run before is not the next one');
  assert.equal(next.fresh, a.total - done.length);

  // clamps: a caller cannot ask for the internet
  assert.equal(discoveryPlan({ perRun: 999, nowMs: day1 }).jobs.length, 12, 'perRun is capped at 12');
  assert.equal(discoveryPlan({ perRun: 0, nowMs: day1 }).jobs.length, 5, 'and zero falls back to the default, not to a crash');
  assert.equal(discoveryPlan({ countries: [] , nowMs: day1 }).jobs.every((j) => ['ZW', 'ZA'].includes(j.country)), true,
    'no country asked for means the two home markets');
});

test('the feed parser degrades rather than throws, and a social post is not a business', () => {
  const xml = [
    '<rss><channel>',
    '<item><title>Harare Web Studio | Design</title><link>https://harareweb.example/about</link><description>We build &amp; host sites</description></item>',
    '<item><title>No link at all</title></item>',
    '<item><title>Facebook page</title><link>https://www.facebook.com/someagency</link></item>',
    '</channel></rss>',
  ].join('');
  const items = parseBingRss(xml);
  assert.equal(items.length, 2, 'the item with no link is dropped, the other two survive');
  assert.equal(items[0].note, 'We build & host sites', 'entities are decoded for the human reading the queue');
  assert.equal(usableHost('https://www.facebook.com/someagency'), false, 'a platform page is a conversation, not a prospect');
  assert.equal(usableHost('https://harareweb.example/about'), true);
  assert.equal(hostOf('https://www.harareweb.example/about'), 'harareweb.example', 'www is stripped, or dedupe breaks');
  assert.equal(parseBingRss('not xml at all').length, 0, 'garbage is zero candidates, not an exception inside a cron');
  assert.equal(decodeEntities('&lt;b&gt;x&lt;/b&gt; &amp; y'), '<b>x</b> & y');
  assert.equal(stripTags('<p>hello <b>there</b></p>'), 'hello there');
});

test('a business is named from its title, not from its URL', () => {
  assert.equal(businessFromTitle('Harare Web Studio | Design and hosting', 'harareweb.example'), 'Harare Web Studio');
  assert.equal(businessFromTitle('Bulawayo Bookkeeping – month-end for shops', 'bulaweb.example'), 'Bulawayo Bookkeeping');
  assert.equal(businessFromTitle('Home', 'kwekwe-tills.example'), 'Kwekwe Tills', 'a generic title falls back to the host, read back as words');
  assert.equal(businessFromTitle('', 'harareweb.example'), 'harareweb.example', 'an unbroken host is kept as found, not case-mangled into a fake name');
});

test('the page is read for evidence a person can check in ten seconds', () => {
  const html = [
    '<html><head><title>Harare Web Studio</title></head><body>',
    '<a href="mailto:hello@harareweb.example">Email</a>',
    '<a href="https://wa.me/263771112223">WhatsApp</a>',
    '<p>Call +263 77 111 2223</p>',
    '<a class="btn" href="/quote">Get a quote</a>',
    '<img src="logo@2x.png">',
    '</body></html>',
  ].join('');
  const ev = readPageEvidence(html, 'https://harareweb.example/about');
  assert.deepEqual(ev.emails, ['hello@harareweb.example'], 'the mailto address, and not the image filename');
  assert.equal(ev.phone, '263771112223', 'a number a person can dial, digits only');
  assert.equal(ev.has_whatsapp, true);
  assert.equal(ev.title, 'Harare Web Studio');
  assert.equal(readPageEvidence('', 'https://x.example').emails.length, 0, 'an empty page yields no contact, never a guess');
});

test('every hook is a sentence about the prospect, and none of them is a country code', () => {
  for (const s of TARGET_SEGMENTS) {
    const hook = s.hook({ country: 'ZW' });
    assert.ok(hook.length > 40, s.key + ' hook is a sentence: ' + hook);
    assert.ok(!/\bundefined\b|\bnull\b/.test(hook), s.key + ' hook has no missing values: ' + hook);
    assert.ok(!/\b(ZW|ZA)\b/.test(hook), s.key + ' names the country in words, not a code: ' + hook);
    assert.ok(!hook.startsWith('web,'), s.key + ' hook does not start with a comma-stripped label');
    assert.ok(/^[A-Z]/.test(hook), s.key + ' starts like a sentence');
  }
  assert.equal(placeOf({ country: 'ZW' }), 'Zimbabwe');
  assert.equal(placeOf({ country: 'ZW', city: 'Harare' }), 'Harare', 'a city is more useful than a country');
  assert.equal(COUNTRY_NAMES.ZW, 'Zimbabwe');
  // evidence outranks the template: the hook says what the page showed
  const wa = hookFor('agencies', { has_whatsapp: true, has_price_page: false }, { country: 'ZW' });
  assert.match(wa, /WhatsApp/, 'a page selling through WhatsApp gets the hook about that, not the generic one');
  assert.match(hookFor('pos_resellers', { orders_language: true, has_order_button: false, host: 'tills.example' }, {}),
    /no way to order/, 'a shop that talks about orders and offers no button is the sharpest hook there is');
});

test('a candidate carries the page it came from, and the pipeline keeps that provenance', () => {
  const c = candidateLead(
    { title: 'Kwekwe Tills | POS', url: 'https://tills.example/contact', note: 'till supplier' },
    { segment: 'pos_resellers', country: 'ZW', evidence: { phone: '263771112223', has_whatsapp: true }, pageChecked: true });
  assert.equal(c.business, 'Kwekwe Tills');
  assert.equal(c.segment, 'pos_resellers');
  assert.equal(c.source_url, 'https://tills.example/contact', 'the URL a person opens to check the claim');
  assert.equal(c.evidence.page_checked, true);

  const lead = cleanLead(c);
  assert.equal(lead.segment, 'pos_resellers', 'a channel segment survives the pipeline’s whitelist');
  assert.equal(lead.source_url, 'https://tills.example/contact');
  assert.equal(lead.evidence.page_checked, true, 'and the evidence is stored with the lead, as four booleans');
  assert.deepEqual(Object.keys(lead.evidence).sort(),
    ['has_order_button', 'has_price_page', 'has_whatsapp', 'page_checked'], 'nothing scraped is stored, only what was true');
  assert.ok(['queued', 'research_hold'].includes(lead.status), 'filed as work, never as a conversation');
  assert.ok(!/contacted/.test(lead.status));
  assert.deepEqual(cleanLeadEvidence({ has_whatsapp: 'true', page_checked: 1, has_price_page: 'yes' }),
    { has_whatsapp: true, has_order_button: false, has_price_page: false, page_checked: true }, 'only a real true counts');
});

/** A directory source with no categories: for tests that are about another source. */
const EMPTY_DIR = async () => ({ ok: true, text: async () => '<html><body><a href="/x">nothing</a></body></html>' });

test('the gate refuses a platform, a stranger, a slogan and a dead end — the first live pass taught it', () => {
  const page = (title, extra = '') => '<html><head><title>' + title + '</title></head><body>'
    + '<h1>Websites for restaurants in Harare</h1><a href="mailto:hello@harareweb.example">mail</a>' + extra + '</body></html>';
  const read = (html, url) => readPageEvidence(html, url);

  // what the deployed pass actually filed before this gate existed
  for (const url of ['https://www.website.com/', 'https://web.whatsapp.com/', 'https://www.wix.com/',
    'https://za.yelp.com/search?x=1', 'https://www.upwork.com/', 'https://m.facebook.com/x']) {
    assert.equal(usableHost(url), false, url + ' is a product or somebody else’s list, not a prospect');
  }
  assert.equal(usableHost('https://harareweb.example/about'), true);
  assert.equal(usableHost('https://kwekwe-tills.example/'), true, 'a real business host still passes');

  const ok = admitCandidate({ title: 'Harare Web Studio | Design', url: 'https://harareweb.example/about' },
    read(page('Harare Web Studio | Design'), 'https://harareweb.example/about'), { country: 'ZW', pageChecked: true });
  assert.equal(ok.ok, true, 'a Harare agency with an address on its page is admitted');
  assert.equal(ok.name, 'Harare Web Studio');

  const platform = admitCandidate({ title: 'WhatsApp Web', url: 'https://web.whatsapp.com/' },
    read(page('WhatsApp Web'), 'https://web.whatsapp.com/'), { country: 'ZW', pageChecked: true });
  assert.deepEqual(platform, { ok: false, why: 'platform' });

  const elsewhere = admitCandidate({ title: 'Jakarta Studio', url: 'https://jakarta.example/' },
    read('<html><title>Jakarta Studio</title><body>Jakarta digital agency<a href="mailto:a@jakarta.example">m</a></body></html>', 'https://jakarta.example/'),
    { country: 'ZW', pageChecked: true });
  assert.equal(elsewhere.why, 'no_local_signal', 'a page that never names the market is not a Zimbabwean agency');

  const slogan = admitCandidate({ title: 'Create Your Free Website | Zimbabwe', url: 'https://site.example/' },
    read(page('Create Your Free Website'), 'https://site.example/'), { country: 'ZW', pageChecked: true });
  assert.equal(slogan.why, 'generic_name', 'a product slogan is not a business name');

  const blind = admitCandidate({ title: 'Harare Web Studio', url: 'https://harareweb.example/' }, {},
    { country: 'ZW', pageChecked: false });
  assert.equal(blind.why, 'unverified', 'no page read, no hook to stand behind');

  const unreachable = admitCandidate({ title: 'Harare Web Studio', url: 'https://harareweb.example/' },
    read('<html><title>Harare Web Studio</title><body>Harare. We build sites.</body></html>', 'https://harareweb.example/'),
    { country: 'ZW', pageChecked: true });
  assert.equal(unreachable.why, 'no_contact', 'a lead nobody can answer is not work, it is a bookmark');

  const utility = admitCandidate({ title: 'ZETDC Harare Regional Office', url: 'https://zetdc.example/' },
    { emails: [], phone: '263242706451', text: 'Zimbabwe' }, { country: 'ZW', pageChecked: true });
  assert.equal(utility.why, 'institution', 'a national utility is a company on the map and is not a customer');

  // a WhatsApp route alone is not enough evidence of a way to *answer* a business — but the number — but the number
  // behind it is, and it has to be a real length for the market
  assert.equal(phonePlausible('263771112223'), true, 'Zimbabwe mobile: 263 + 9');
  assert.equal(phonePlausible('27711234567'), true, 'South African mobile: 27 + 9');
  assert.equal(phonePlausible('279927998279'), false, '27 + 10 digits is an Indonesian id, not a Cape Town number');
  assert.equal(phonePlausible('26377111222'), false, '263 + 8 is not a Zimbabwean number');
  assert.equal(phonePlausible(''), false);
  assert.equal(marketMention('we serve Harare and Bulawayo', 'ZW'), true);
  assert.equal(marketMention('we serve Zimbabwe', 'ZW'), true);
  assert.equal(marketMention('we serve Nairobi', 'KE'), true);
  assert.equal(marketMention('we serve Nairobi', 'ZW'), false);
  assert.ok(MARKET_CITIES.ZA.includes('johannesburg'));
});

test('a run files only what the gate admitted, and says what it refused', async () => {
  const fetcher = async (url) => {
    if (String(url).includes('classifieds.co.zw')) return EMPTY_DIR();
    if (String(url).includes('overpass')) return { ok: true, text: async () => '{"elements":[]}' };
    if (String(url).includes('bing.com/search')) {
      return { ok: true, text: async () => '<rss><channel>'
        + '<item><title>Harare Web Studio | Design</title><link>https://harareweb.example/about</link></item>'
        + '<item><title>Jakarta Studio | Web</title><link>https://jakarta-studio.example/</link></item>'
        + '</channel></rss>' };
    }
    if (String(url).includes('harareweb')) {
      return { ok: true, text: async () => '<html><title>Harare Web Studio</title><body>Harare agencies.'
        + '<a href="mailto:hello@harareweb.example">mail</a></body></html>' };
    }
    return { ok: true, text: async () => '<html><title>Jakarta Studio</title><body>Jakarta agencies.'
      + '<a href="mailto:hi@jakarta-studio.example">mail</a></body></html>' };
  };
  const run = await runDiscovery({ fetch: fetcher, perRun: 6, limit: 6, perQuery: 3, countries: ['ZW'], nowMs: 20747 * 864e5 });
  const names = run.candidates.map((c) => c.business);
  assert.ok(names.includes('Harare Web Studio'), 'the in-market business is filed: ' + names.join(', '));
  assert.ok(!names.some((n) => /Jakarta/i.test(n)), 'the stranger is not: ' + names.join(', '));
  assert.ok(run.rejected.no_local_signal >= 1, 'and the stranger is counted, not quietly dropped: ' + JSON.stringify(run.rejected));
});

test('the summary counts what a person can act on today, and says so plainly', () => {
  const cands = [
    { segment: 'agencies', email: 'a@x.example', hook: 'h' },
    { segment: 'agencies', phone: '263771112223' },
    { segment: 'accountants', source_url: 'https://y.example' },
  ];
  const s = discoverySummary(cands);
  assert.equal(s.candidates, 3);
  assert.equal(s.contactable, 2, 'two of three have an address or a number');
  assert.equal(s.with_hook, 1);
  assert.deepEqual(s.by_segment, { agencies: 2, accountants: 1 });
  assert.match(s.note, /checkable|ten seconds/i);
  assert.equal(discoverySummary([]).candidates, 0, 'an empty morning is not an error');
});

test('a run reads a search feed and the pages behind it, and stops at the limit', async () => {
  const asked = [];
  // Every query answers with its own businesses, the way a real search does. A fixed feed would
  // make the second query return the first query's results, which the pass (correctly) refuses as
  // duplicates — and then this test would be measuring dedupe, not the limit.
  let feed = 0;
  const fetcher = async (url) => {
    asked.push(url);
    if (String(url).includes('classifieds.co.zw')) return EMPTY_DIR();
    if (String(url).includes('overpass')) return { ok: true, text: async () => '{"elements":[]}' };
    if (String(url).includes('bing.com/search')) {
      feed++;
      return { ok: true, text: async () => [
        '<rss><channel>',
        '<item><title>Harare Web Studio ' + feed + ' | Design</title><link>https://harareweb' + feed + '.example/about</link></item>',
        '<item><title>Second Agency ' + feed + ' | Web</title><link>https://second' + feed + '.example/</link></item>',
        '<item><title>Third ' + feed + ' | Web</title><link>https://third' + feed + '.example/</link></item>',
        '</channel></rss>',
      ].join('') };
    }
    // a page the gate can stand behind: it names the market and offers a way to answer
    return { ok: true, text: async () => '<html><title>Harare Studio</title><body>Harare, Zimbabwe. '
      + 'Website design for restaurants.<a href="mailto:hi@' + hostOf(url) + '">mail</a></body></html>' };
  };
  // five jobs reserved: the directory (empty here), the map (empty), and the search queries. A pass
  // may ask up to three times its budget when sources answer nothing, so "how many did it ask" is a
  // range with a ceiling, not a fixed number — what is fixed is the candidate ceiling.
  const run = await runDiscovery({ fetch: fetcher, perRun: 5, limit: 4, perQuery: 2, countries: ['ZW'], nowMs: 20300 * 864e5 });
  assert.equal(run.ok, true);
  assert.ok(run.asked >= 3 && run.asked <= 15, 'it asked sources, inside the attempt cap: ' + run.asked);
  assert.equal(run.candidates.length, 4, 'two from each query, and never more than the limit: ' + run.candidates.length);
  assert.equal(new Set(run.candidates.map((c) => c.business)).size, 4, 'and no business counted twice');
  assert.ok(run.ran.some((r) => r.source === 'bing'), 'the search leg was asked');

  // the limit is a ceiling, not a suggestion: one query offering six results still yields the cap
  const capped = await runDiscovery({ fetch: fetcher, perRun: 5, limit: 1, perQuery: 3, countries: ['ZW'], nowMs: 20300 * 864e5 });
  assert.equal(capped.candidates.length, 1, 'one is the ceiling it was given');
  assert.ok(capped.asked <= 15, 'and it stopped asking once it had enough: ' + capped.asked);
  assert.ok(run.candidates.every((c) => c.segment && c.source_url && c.evidence.page_checked), 'each candidate was read on its page');
  assert.ok(asked.every((u) => /^https:\/\//.test(u)), 'only https');
  assert.ok(!asked.some((u) => u.includes('facebook')), 'nothing did a social platform');

  // one source failing does not fail the run, and it is reported rather than swallowed
  const broken = await runDiscovery({
    fetch: async () => { throw new Error('dns gone'); }, perRun: 2, limit: 2, countries: ['ZW'], nowMs: 20300 * 864e5 });
  assert.equal(broken.ok, true, 'a run survives a dead source');
  assert.equal(broken.candidates.length, 0, 'with no candidates invented to fill the gap');
  assert.ok(broken.errors.length >= 2, 'and every failure named: ' + JSON.stringify(broken.errors));
  assert.match(broken.errors[0].error, /dns gone/);
});

test('the map source asks a city bbox a question only a local business can answer', () => {
  const q = overpassQuery('Harare', -17.83, 31.05, 'agencies');
  assert.match(q, /^\[out:json\]/, 'a query Overpass will accept');
  assert.match(q, /nwr\["office"="company"\]\(-17\.9/, 'an office tag, inside a box around the city');
  assert.match(q, /nwr\["craft"="web_developer"\]/, 'and the craftsman spelling of the same trade');
  assert.equal(overpassQuery('Harare', -17.83, 31.05, 'social_merchants'), '',
    'a segment the map cannot describe gets no query at all, rather than a bad one');
  assert.ok(OSM_TAGS.accountants.includes('office=tax_advisor'));
  assert.ok(OSM_CITIES.ZW.some((c) => c[0] === 'Harare'));

  const doc = { elements: [
    { type: 'node', id: 1, tags: { name: 'Harare Web Studio', office: 'company', phone: '+263 77 111 2223',
      website: 'https://harareweb.example/', email: 'hi@harareweb.example' } },
    { type: 'way', id: 2, tags: { name: 'Bula Books', office: 'tax_advisor', phone: '27 11 234 5678' } },
    { type: 'node', id: 3, tags: { name: 'A Dot', office: 'company', phone: '279927998279' } },
    { type: 'node', id: 4, tags: { office: 'company', phone: '+263 77 111 2222' } },
  ] };
  const items = parseOverpass(doc, 'agencies');
  assert.equal(items.length, 3, 'the unnamed node is a dot, not a business');
  assert.equal(items[0].title, 'Harare Web Studio');
  assert.equal(items[0].url, 'https://harareweb.example/', 'the business site when the map has one');
  assert.equal(items[0].contact.email, 'hi@harareweb.example');
  assert.equal(items[0].contact.phone, '+263771112223', 'the number the mapper typed, digits kept');
  assert.equal(items[1].url, 'https://www.openstreetmap.org/way/2', 'a business with no site is checkable at its map object');
  assert.equal(items[2].contact.phone, '', 'an Indonesian id is not a Harare number, and the map is not believed blindly');
});

test('a map candidate with no website is filed, with the hook that makes it sharp', async () => {
  const osm = { elements: [
    { type: 'node', id: 11, tags: { name: 'Kwekwe Tills', shop: 'computer', phone: '+263 77 222 3344' } },
    { type: 'node', id: 12, tags: { name: 'No Contact Traders', shop: 'computer' } },
  ] };
  const asked = [];
  const fetcher = async (url) => {
    asked.push(String(url));
    if (String(url).includes('classifieds.co.zw')) return EMPTY_DIR();
    if (String(url).includes('overpass')) return { ok: true, text: async () => JSON.stringify(osm) };
    return { ok: false, status: 404, text: async () => '' };
  };
  const run = await runDiscovery({ fetch: fetcher, perRun: 2, limit: 5, countries: ['ZW'], nowMs: 20750 * 864e5 });
  assert.equal(run.candidates.length, 1, 'one of the two can be answered');
  const c = run.candidates[0];
  assert.equal(c.business, 'Kwekwe Tills');
  assert.equal(c.phone, '+263772223344');
  assert.equal(c.source, 'discovery:openstreetmap', 'the lead says where it came from');
  assert.equal(c.source_url, 'https://www.openstreetmap.org/node/11', 'and a person can open that URL');
  assert.match(c.hook, /no website of its own/, 'the true and useful thing about a shop with a phone and no site');
  assert.equal(run.rejected.no_contact, 1, 'and the one that cannot be answered is counted, not filed');
  assert.ok(!asked.some((u) => u.includes('openstreetmap.org/node/')), 'the map object page is not fetched as if it were a shop’s site');
});

test('the map is asked about the segments it can describe, and a month of passes covers them all', () => {
  // One pass is a slice on purpose, so the claim "every target is being worked" is only testable
  // over time: simulate the rotation with the same done-list the Worker keeps.
  let done = [];
  const seen = new Set();
  let firstPass = null;
  for (let d = 0; d < 60; d++) {
    const p = discoveryPlan({ nowMs: 20750 * 864e5 + d * 864e5, perRun: 12, countries: ['ZW', 'ZA'], done });
    if (!firstPass) firstPass = p;
    for (const j of p.jobs) seen.add(j.source + ':' + j.segment + ':' + j.country);
    done = [...new Set([...done, ...p.jobs.map((j) => j.key)])];
    assert.equal(new Set(p.jobs.map((j) => j.key)).size, p.jobs.length, 'no job twice in one pass');
  }
  for (const seg of ['agencies', 'accountants', 'pos_resellers', 'associations']) {
    assert.ok(seen.has('osm:' + seg + ':ZW'), 'over two months the map is asked about ' + seg + ' in Zimbabwe');
    assert.ok(seen.has('osm:' + seg + ':ZA'), 'and in South Africa');
  }
  for (const seg of ['agencies', 'accountants', 'pos_resellers', 'associations']) {
    assert.ok(seen.has('bing:' + seg + ':ZW'), 'search backs the map up for ' + seg);
  }
  assert.ok(seen.has('bing:social_merchants:ZW'), 'and the long tail is reachable only through a phrase');
  assert.ok(![...seen].some((k) => k.startsWith('osm:social_merchants')),
    'the map is never asked about a segment it cannot describe: no query full of nothing');
  assert.ok(done.length >= firstPass.total, 'a month of passes eventually touches every query in the pool');
});

test('one Overpass mirror at capacity is not a lost day: fall through, then fall back to the cache', async () => {
  assert.ok(OVERPASS_MIRRORS.length >= 3, 'there is more than one server to ask: ' + OVERPASS_MIRRORS.join(', '));
  assert.equal(OVERPASS_TIMEOUTS.length, OVERPASS_MIRRORS.length, 'every mirror has its own clock');
  assert.ok(OVERPASS_TIMEOUTS[0] >= 45000, 'the primary queues rather than refuses when busy — measured 34–45s, not 12');
  assert.ok(OVERPASS_TIMEOUTS.slice(1).every((t) => t < OVERPASS_TIMEOUTS[0]), 'and the alternates are either fast or gone');
  const osm = { elements: [{ type: 'node', id: 7, tags: { name: 'Harare Web Studio', office: 'it', phone: '+263 77 111 2223' } }] };
  const store = {};
  const asked = [];
  const fetcher = async (url) => {
    const u = String(url);
    asked.push(u);
    if (u.includes('classifieds.co.zw')) return EMPTY_DIR();
    if (u.includes('overpass-api.de')) return { ok: false, status: 502, text: async () => 'at capacity' };
    if (u.includes('overpass')) return { ok: true, text: async () => JSON.stringify(osm) };
    return { ok: true, text: async () => '<rss><channel></channel></rss>' };
  };
  const cv = { cacheGet: async (k) => store[k], cachePut: async (k, v) => { store[k] = v; } };
  const first = await runDiscovery({ fetch: fetcher, perRun: 2, limit: 4, countries: ['ZW'], nowMs: 20747 * 864e5, ...cv });
  assert.equal(first.candidates.length, 1, 'the second mirror answered where the first refused');
  const osmRun = first.ran.find((r) => r.source === 'osm');
  assert.match(osmRun.mirror, /private\.coffee|osm\.ch|osm\.jp/, 'and the run says which one: ' + osmRun.mirror);
  assert.ok(asked.some((u) => u.includes('overpass-api.de')), 'the failed mirror was actually tried first');

  // every mirror down, but the answer from earlier today is in KV: the list still gets built
  const down = async (u) => (String(u).includes('classifieds.co.zw')
    ? EMPTY_DIR() : { ok: false, status: 502, text: async () => '' });
  const second = await runDiscovery({ fetch: down, perRun: 2, limit: 4, countries: ['ZW'], nowMs: 20747 * 864e5, ...cv });
  assert.equal(second.candidates.length, 1, 'a capacity spike must not empty the queue for the day');
  assert.equal(second.ran.find((r) => r.source === 'osm').cached, true, 'and the run is honest that the answer came from the cache');

  // with no cache and no server, the failure is named, not hidden
  const bare = await runDiscovery({ fetch: down, perRun: 2, limit: 4, countries: ['ZW'], nowMs: 20747 * 864e5 });
  assert.equal(bare.candidates.length, 0);
  const osmErr = bare.errors.find((e) => /osm/.test(e.job));
  assert.match(osmErr.error, /all_mirrors_failed/, 'the error the state document keeps says what happened: ' + JSON.stringify(bare.errors));
});

// The markup here is the shape the live directory actually serves (v1.7.6 verified against a real
// page): a `listing` panel per business, the name in an h3 link, the number inside the WhatsApp
// button's data-href, and the category in a link of its own.
const DIR_PAGE = [
  '<html><body><div class="listings">',
  '<div id="advertiser-187221" class="listing panel panel-default panel-listing bd" data-id="187221">',
  '<h3 class="ellipsis"><a href="https://www.classifieds.co.zw/macbyte-systems13">MacByte Systems</a></h3>',
  '<a class="panel-header__category" href="https://www.classifieds.co.zw/directory/computer-services-software">Computer Services &amp; Software</a>',
  '<button data-href="https://api.whatsapp.com/send?phone=263773098427&amp;text=Hi">WhatsApp</button>',
  '</div>',
  '<div id="advertiser-2" class="listing panel panel-default" data-id="2">',
  '<h3 class="ellipsis"><a href="https://www.classifieds.co.zw/the-future-store">The Future Store</a></h3>',
  '<a href="https://thefuturestore.co.zw/">our site</a>',
  '<button data-href="https://api.whatsapp.com/send?phone=279927998279">WhatsApp</button>',
  '</div>',
  '</div></body></html>',
].join('');

test('the directory source reads a listing page into named businesses with a number that works', () => {
  const items = parseDirectory(DIR_PAGE, 'https://www.classifieds.co.zw/directory/computer-services-software');
  assert.equal(items.length, 2, 'two listings, two businesses');
  assert.equal(items[0].title, 'MacByte Systems');
  assert.equal(items[0].contact.phone, '263773098427', 'the number the advertiser published');
  assert.equal(items[0].url, 'https://www.classifieds.co.zw/macbyte-systems13', 'and the page that proves the lead');
  assert.equal(items[0].site, '', 'the listing’s own WhatsApp button is not the business’s website');
  assert.match(items[0].note, /no website of its own/, 'so the note says the true thing: ' + items[0].note);
  assert.equal(items[1].site, 'https://thefuturestore.co.zw/', 'a real outbound link is the site');
  assert.equal(items[1].contact.phone, '', 'an Indonesian id in the button is not a Zimbabwean number');
  assert.equal(items[1].fromDirectory, true);

  const index = parseDirectoryIndex('<a href="https://www.classifieds.co.zw/directory/computer-services-software">Computer Services &amp; Software</a>'
    + '<a href="https://www.classifieds.co.zw/directory/estate-agents-valuers">Estate Agents</a>');
  assert.equal(index.length, 2);
  assert.equal(index[0].slug, 'computer-services-software');
  assert.equal(index[1].label, 'Estate Agents', 'entities decoded, or every match is a near-miss');
  // the directory's real category names, from the live index
  assert.ok(DIRECTORY_KEYWORDS.agencies.some((p) => p.test('Computer Services & Software')));
  assert.ok(DIRECTORY_KEYWORDS.agencies.some((p) => p.test('Internet & Telecommunications')));
  assert.ok(DIRECTORY_KEYWORDS.accountants.some((p) => p.test('Finance Services')));
  assert.ok(DIRECTORY_KEYWORDS.pos_resellers.some((p) => p.test('Scales & Weighing Machines')),
    'a Zimbabwean till seller is filed under scales, which the playbook would never have guessed');
  assert.ok(!DIRECTORY_KEYWORDS.agencies.some((p) => p.test('Motor Vehicle Dealers')), 'and a car dealer is not an agency');
  assert.match(DIRECTORY_INDEX, /classifieds\.co\.zw/);
  // and the directory host can never be filed as a business itself
  assert.equal(usableHost('https://www.classifieds.co.zw/macbyte-systems13'), false);
});

test('the three tiers are flat prices in data', () => {
  assert.deepEqual(PARTNER_TIER_KEYS, ['pilot', 'partner', 'platform']);
  assert.equal(PARTNER_TIERS.pilot.price, 0);
  assert.equal(PARTNER_TIERS.pilot.months, 2, 'sixty days, free, with a decision date');
  assert.equal(PARTNER_TIERS.pilot.seats, 10);
  assert.equal(PARTNER_TIERS.partner.price, 149);
  assert.equal(PARTNER_TIERS.partner.seats, 5);
  assert.equal(PARTNER_TIERS.partner.seat_price, 29, 'each seat after five is $29, a number and not a share');
  assert.equal(PARTNER_TIERS.platform.price, 299);
  assert.equal(PARTNER_TIERS.platform.seats, 0, 'zero seats means unlimited in this data, and the page says so in words');
  for (const k of PARTNER_TIER_KEYS) {
    const t = PARTNER_TIERS[k];
    assert.ok(t.label && t.line && t.includes.length >= 3, k + ' is a tier a person could read out');
    assert.ok(!/%/.test(t.line), k + ' is priced flat: no percentage in the line');
  }
});

/* ------------------------------------------------- v1.9.0: one directory per country
 * The complaint that started this was arithmetic: one source, one country, one category taxonomy,
 * and 1–3 leads a day. These tests hold the answer to it — a registry of directories, a phrase
 * search for the countries whose directory has no taxonomy, and one country honestly marked as
 * having no reachable free directory at all.
 */
test('every target country with a reachable free directory is in the registry, and the missing one is admitted', () => {
  assert.ok(DIRECTORY_SITES.ZW, 'Zimbabwe: the classifieds index that produced the first real lead');
  assert.ok(DIRECTORY_SITES.KE, 'Kenya: a directory that answers a phrase');
  assert.ok(DIRECTORY_SITES.NG, 'Nigeria: the same platform, its own market');
  assert.equal(DIRECTORY_SITES.KE.kind, 'search');
  assert.equal(DIRECTORY_SITES.NG.dial, '234');
  // South Africa is not missing by oversight: yep/cylex/brabys are Cloudflare or JS shells from a
  // Worker's address, and hotfrog/all.biz refuse the datacentre. Saying so is the honest state.
  assert.equal(DIRECTORY_SITES.ZA, undefined, 'no ZA directory is claimed');

  for (const [cc, site] of Object.entries(DIRECTORY_SITES)) {
    assert.ok(site.host && /^[a-z0-9.-]+$/.test(site.host), cc + ' names a host');
    assert.ok(site.note && !/[A-Z]{2}\b/.test(site.note), cc + ' describes itself in words, not a country code');
    if (site.kind === 'search') {
      const u = site.search('web design');
      assert.match(u, /^https:\/\/[a-z0-9.-]+\/\?q=/, cc + ' asks a phrase in the URL, not a session');
      assert.ok(!/login|auth|token|cookie/i.test(u), cc + ' needs nobody to sign in');
    } else {
      assert.match(site.index, /^https:\/\//, cc + ' points at a public index');
    }
  }
});

test('a Kenyan or Nigerian company page is read for the number the business published, dialable from anywhere', () => {
  const page = (tel) => '<html><body><div id="company_name">Hope Brand</div>'
    + '<a href="tel:' + tel + '">call</a><a href="mailto:Info@Hope.example">mail</a>'
    + '<a href="https://ajax.googleapis.com/x.js">cdn</a><a href="https://hopebrand.example">site</a></body></html>';

  const ke = parseCompanyPage(page('0726239033'), 'https://www.businesslist.co.ke/company/1/hope-brand', DIRECTORY_SITES.KE);
  assert.equal(ke.title, 'Hope Brand');
  assert.equal(ke.contact.phone, '254726239033', 'a local 07 number becomes a number dialable from Harare');
  assert.equal(ke.contact.email, 'info@hope.example', 'the published address, lowercased');
  assert.equal(ke.site, 'https://hopebrand.example', 'the site it names — not the CDN its stylesheet came from');
  assert.match(ke.note, /Kenyan business directory/);

  const ng = parseCompanyPage(page('08031234567'), 'https://www.businesslist.com.ng/company/2/x', DIRECTORY_SITES.NG);
  assert.equal(ng.contact.phone, '2348031234567');

  // a number that is not a number for that market is refused rather than filed as one
  const bad = parseCompanyPage(page('12345'), 'https://www.businesslist.co.ke/company/3/x', DIRECTORY_SITES.KE);
  assert.equal(bad.contact.phone, '', 'a five-digit string is not a phone number');
  assert.equal(dialablePhone('+254 (726) 239-033', '254'), '254726239033');
  // the way a Nigerian page writes it, with the trunk zero in brackets — the shape the first real
  // pass produced, and the shape that made a dialable number look like an 11-digit local one
  assert.equal(dialablePhone('+234 (0)7301771710', '234'), '2347301771710');
  assert.equal(dialablePhone('+27 (0)11 234 5678', '27'), '27112345678');
  assert.equal(dialablePhone('', '254'), '');
});

test('the phrase a directory is asked comes from the directory\u2019s words, and the pass keeps asking when one source answers nothing', async () => {
  assert.ok(DIRECTORY_PHRASES.agencies.includes('web design'), 'asked in the words a Kenyan shop lists itself under');
  assert.ok(!DIRECTORY_PHRASES.agencies.includes('digital transformation consultant'),
    'and not in the words a conference deck uses');

  const asked = [];
  const fetcher = async (url) => {
    const u = String(url);
    asked.push(u);
    if (u.includes('businesslist.co.ke') && u.includes('?q=')) {
      return { ok: true, text: async () => '<html><a href="/company/146903/hope-brand">Hope Brand</a>'
        + '<a href="/company/149751/up-fix-electronics">UP Fix Electronics</a></html>' };
    }
    if (u.includes('/company/146903')) return { ok: true, text: async () => '<div id="company_name">Hope Brand</div><a href="tel:0726239033">c</a>' };
    if (u.includes('/company/149751')) return { ok: true, text: async () => '<div id="company_name">UP Fix Electronics</div><a href="tel:0726999888">c</a>' };
    if (u.includes('businesslist.com.ng') && u.includes('?q=')) return { ok: false, status: 503, text: async () => '' };
    return { ok: true, text: async () => '<html><body>Harare, Zimbabwe. Website design. <a href="mailto:hi@x.example">m</a></body></html>' };
  };

  const run = await runDiscovery({ fetch: fetcher, perRun: 4, limit: 6, countries: ['KE'], nowMs: 20750 * 864e5 });
  assert.equal(run.ok, true);
  const fromKe = run.candidates.filter((c) => /businesslist\.co\.ke/.test(c.source_url || ''));
  assert.ok(fromKe.length >= 1, 'a Kenyan directory candidate was filed: ' + JSON.stringify(run.ran.map((r) => r.source + '=' + r.results)));
  const hope = fromKe.find((c) => c.business === 'Hope Brand');
  assert.ok(hope, 'with the name the directory holds');
  assert.equal(hope.phone, '254726239033', 'and the number on its page, dialable');
  assert.equal(hope.segment, 'agencies', 'filed in the segment the playbook ranks first');
  assert.ok(/^https:\/\/www\.businesslist\.co\.ke\/company\//.test(hope.source_url), 'the hook is checkable where it came from');
  assert.ok(!/contacted|messaged|sent/i.test(hope.status || ''), 'discovery still never claims a lead');

  // a dead market does not stop the pass: the next source is asked in the same run
  const partial = await runDiscovery({ fetch: fetcher, perRun: 4, limit: 2, countries: ['NG', 'ZW'], nowMs: 20750 * 864e5 });
  assert.equal(partial.ok, true);
  assert.ok(partial.errors.some((e) => /503/.test(e.error)), 'the failure is named: ' + JSON.stringify(partial.errors));
  assert.ok(partial.asked > 1, 'and the pass kept asking: ' + partial.asked);
});

test('nothing discovery does is behind a login, and the paid search APIs stay off until a key exists', () => {
  const src = readFileSync(join(root, 'worker/discover.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const host of ['linkedin.com', 'facebook.com', 'instagram.com', 'tiktok.com']) {
    assert.ok(!new RegExp('https?://([a-z0-9-]+\\.)?' + host.replace('.', '\\.'), 'i').test(src),
      'no request is made to ' + host + ' — profiles there are neither public to a Worker nor legal to harvest');
  }
  for (const key of ['BRAVE_KEY', 'SERPAPI_KEY']) {
    assert.ok(src.includes(key), key + ' is read from the Worker environment, never committed');
  }

  // off means off: with no key the search leg reports why, rather than pretending a pass ran
  assert.equal(searchProvider({}), null);
  assert.equal(searchProvider({ BRAVE_KEY: 'short' }), null, 'a stub value is not a key');
  assert.equal(searchProvider({ BRAVE_KEY: 'b'.repeat(24) }).provider, 'brave');
  assert.equal(searchProvider({ SERPAPI_KEY: 's'.repeat(24) }).provider, 'serpapi');

  const p = discoveryPlan({ nowMs: 20750 * 864e5, perRun: 6, countries: ['ZW', 'KE'], done: [] });
  assert.ok(p.jobs.every((j) => j.source !== 'search'), 'no key, no search jobs');
  const withKey = discoveryPlan({ nowMs: 20750 * 864e5, perRun: 6, countries: ['ZW', 'KE'], done: [], search: { provider: 'brave', key: 'k'.repeat(24) } });
  assert.ok(withKey.jobs.some((j) => j.source === 'search'), 'one key and the leg is the search provider, not Bing');

  // the parse of both providers, on the shapes they actually return
  assert.deepEqual(parseBrave({ web: { results: [{ title: 'A', url: 'https://a.example', description: 'd' }] } }),
    [{ title: 'A', url: 'https://a.example', note: 'd' }]);
  assert.deepEqual(parseSerpApi({ organic_results: [{ title: 'B', link: 'https://b.example', snippet: 's' }] }),
    [{ title: 'B', url: 'https://b.example', note: 's' }]);
  assert.deepEqual(parseBrave({}), [], 'an empty answer is empty, not an exception');
});

test('the daily pass asks every market the rail is sold in, not the two it started with', () => {
  // The registry is worthless if the cron never names the country. This pins the default the
  // scheduled pass uses (worker.js) against the registry here, so a fifth market cannot be added to
  // one and forgotten in the other.
  const src = readFileSync(join(root, 'worker/worker.js'), 'utf8');
  const m = src.match(/opts\.countries : \[([^\]]+)\]/);
  assert.ok(m, 'the default country list is findable');
  const defaults = m[1].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.deepEqual(defaults, ['ZW', 'ZA', 'KE', 'NG'], 'ZW, ZA, KE, NG');
  for (const cc of Object.keys(DIRECTORY_SITES)) {
    assert.ok(defaults.includes(cc), cc + ' has a directory and is asked about it');
  }
  assert.match(src, /search: searchProvider\(env\)/, 'and the keyed provider, when one exists, is what the pass uses');
});

test('a directory listing that is an institution or a charity is refused, and its number is still made dialable', () => {
  const page = (name, tel) => '<div id="company_name">' + name + '</div><a href="tel:' + tel + '">c</a>';
  // the two live shapes that got through on the first real Kenyan/Nigerian pass
  for (const name of ["House of Mercy Children's  Lagos, Nigeria (HOM)", 'Lagos Orphanage Trust', 'Grace Foundation NGO']) {
    const c = parseCompanyPage(page(name, '+2348022499177'), 'https://www.businesslist.com.ng/company/9/x', DIRECTORY_SITES.NG);
    const admit = admitCandidate(c, {}, { fromDirectory: true, pageChecked: true, contact: c.contact });
    assert.equal(admit.ok, false, name + ' is not a prospect');
    assert.equal(admit.why, 'institution');
  }
  // and a real shop is untouched, with the local number made dialable from anywhere
  const shop = parseCompanyPage(page('Olumedia E-Commerce Company', '07080574539'), 'https://www.businesslist.com.ng/company/1/x', DIRECTORY_SITES.NG);
  assert.equal(shop.contact.phone, '2347080574539', 'a Nigerian 0708 number filed as-is is a number a Kenyan seller cannot ring');
  assert.equal(admitCandidate(shop, {}, { fromDirectory: true, pageChecked: true, contact: shop.contact }).ok, true);
});
