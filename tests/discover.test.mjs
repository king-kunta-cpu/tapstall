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
import {
  TARGET_SEGMENTS, SEGMENT_KEYS, segmentFor, discoveryPlan, parseBingRss, decodeEntities,
  stripTags, usableHost, hostOf, businessFromTitle, hookFor, readPageEvidence, candidateLead,
  discoverySummary, runDiscovery, placeOf, COUNTRY_NAMES,
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
  const fetcher = async (url) => {
    asked.push(url);
    if (String(url).includes('bing.com/search')) {
      return { ok: true, text: async () => [
        '<rss><channel>',
        '<item><title>Harare Web Studio | Design</title><link>https://harareweb.example/about</link></item>',
        '<item><title>Second Agency | Web</title><link>https://second.example/</link></item>',
        '<item><title>Third | Web</title><link>https://third.example/</link></item>',
        '</channel></rss>',
      ].join('') };
    }
    return { ok: true, text: async () => '<a href="mailto:hi@' + hostOf(url) + '">mail</a>' };
  };
  const run = await runDiscovery({ fetch: fetcher, perRun: 2, limit: 4, perQuery: 2, countries: ['ZW'], nowMs: 20300 * 864e5 });
  assert.equal(run.ok, true);
  assert.equal(run.ran.length, 2, 'two queries');
  assert.equal(run.candidates.length, 4, 'two from each, and no more than the limit: ' + run.candidates.length);

  // the limit is a ceiling, not a suggestion: one query offering six results still yields the cap
  const capped = await runDiscovery({ fetch: fetcher, perRun: 1, limit: 1, perQuery: 3, countries: ['ZW'], nowMs: 20300 * 864e5 });
  assert.equal(capped.candidates.length, 1);
  assert.equal(capped.ran.length, 1, 'and it stopped asking once it had enough');
  assert.ok(run.candidates.every((c) => c.segment && c.source_url && c.evidence.page_checked), 'each candidate was read on its page');
  assert.ok(asked.every((u) => /^https:\/\//.test(u)), 'only https');
  assert.ok(!asked.some((u) => u.includes('facebook')), 'nothing did a social platform');

  // one source failing does not fail the run, and it is reported rather than swallowed
  const broken = await runDiscovery({
    fetch: async () => { throw new Error('dns gone'); }, perRun: 2, limit: 2, countries: ['ZW'], nowMs: 20300 * 864e5 });
  assert.equal(broken.ok, true, 'a run survives a dead source');
  assert.equal(broken.candidates.length, 0, 'with no candidates invented to fill the gap');
  assert.equal(broken.errors.length, 2, 'and every failure named: ' + JSON.stringify(broken.errors));
  assert.match(broken.errors[0].error, /dns gone/);
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
