/**
 * Tapstall discover — the autonomous list.
 *
 * The playbook says: sell to the people who already own the shops. That is worthless as a
 * paragraph and useful as a job that runs every morning, adds a handful of named prospects with
 * one true hook each, and never sends anything to anybody. This file is that job's brain.
 *
 * Two rules shape everything here:
 *   1. **Evidence, not invention.** A hook is only ever built from something observed — a page
 *      that talks about orders but has no order button, a business with no website at all, an
 *      email visible on the page. No hook is generated from a guess, because the first sentence
 *      a stranger reads about their own business must be true.
 *   2. **The Worker fetches; a human sends.** Discovery reads public pages and files candidates
 *      into the lead pipeline the sellers already work. It never emails, never messages, never
 *      claims a lead, and never overrides the do-not-contact ledger.
 *
 * Sources are free and keyless: Bing's RSS search (Google strips result pages and bans scrapers)
 * and OpenStreetMap's Overpass endpoint. Both are queried in small rotations so a month of runs
 * covers the whole target list without hammering either service.
 */

/* --------------------------------------------------------------- who, in order
 * The order is the strategy: agencies carry many merchants each, accountants recommend rather
 * than sell, resellers already install hardware, associations give a room of forty at once, and
 * individual shops only make sense inbound. `weight` is what the scoring uses; `rank` is what a
 * human reads.
 */
// A hook is the only thing a seller opens with, so it has to be a sentence a person could say out
// loud: "ZW" and a comma-stripped label first word ("web,") are not.
export const COUNTRY_NAMES = { ZW: 'Zimbabwe', ZA: 'South Africa', KE: 'Kenya', NG: 'Nigeria', ZM: 'Zambia', BW: 'Botswana', MW: 'Malawi', TZ: 'Tanzania', UG: 'Uganda' };
export function placeOf(c = {}) {
  const city = String(c.city || '').trim();
  if (city) return city;
  const cc = String(c.country || '').toUpperCase();
  return COUNTRY_NAMES[cc] || cc || 'your market';
}

export const TARGET_SEGMENTS = [
  {
    key: 'agencies', rank: 1, weight: 30,
    label: 'Web, brand and WhatsApp-marketing agencies',
    why: 'They already hold 20–80 merchants and are paid to evaluate software.',
    hook: (c) => 'A web agency in ' + placeOf(c) + ': it runs client storefronts, and the rail is the one thing it cannot currently bill for',
    queries: {
      ZA: ['website design agency Johannesburg', 'WhatsApp marketing agency South Africa', 'digital agency Durban small business', 'web design agency Cape Town ecommerce'],
      ZW: ['website design agency Harare', 'web developer Bulawayo small business', 'digital marketing agency Zimbabwe', 'web design Mutare'],
      KE: ['web design agency Nairobi small business'], NG: ['web design agency Lagos small business'],
    },
  },
  {
    key: 'accountants', rank: 2, weight: 26,
    label: 'Bookkeepers and accountants',
    why: 'They do month-end for 20–40 shops and want the settlement statement, not a sales job.',
    hook: (c) => 'A bookkeeper in ' + placeOf(c) + ': clients still match payments by screenshot at month-end',
    queries: {
      ZA: ['bookkeeper small business Johannesburg', 'accounting firm SMEs Cape Town', 'bookkeeping services Durban'],
      ZW: ['bookkeeper Harare small business', 'accounting firm Zimbabwe SMEs', 'tax consultant Bulawayo shops'],
    },
  },
  {
    key: 'pos_resellers', rank: 3, weight: 22,
    label: 'POS and payments resellers',
    why: 'They sell the terminal and have no software to go with it.',
    hook: (c) => 'A till reseller in ' + placeOf(c) + ': the order rail is the natural upsell, and it does not compete with the hardware',
    queries: {
      ZA: ['point of sale systems reseller South Africa', 'POS till supplier Johannesburg small business'],
      ZW: ['point of sale Harare supplier', 'POS machines Zimbabwe reseller'],
    },
  },
  {
    key: 'associations', rank: 4, weight: 18,
    label: 'Market, trade and chamber associations',
    why: 'One demo to a room of forty is forty prospects in an hour.',
    hook: (c) => 'An association in ' + placeOf(c) + ': forty members who all take orders by hand',
    queries: {
      ZA: ['small business chamber Johannesburg', 'restaurant association South Africa', 'informal traders association Gauteng'],
      ZW: ['business association Harare SMEs', 'informal traders association Zimbabwe'],
    },
  },
  {
    key: 'social_merchants', rank: 5, weight: 12,
    label: 'Shops already selling on WhatsApp',
    why: 'Inbound and near-inbound only: the pain is visible, the wallet is small.',
    hook: (c) => 'Sells in the chat in ' + placeOf(c) + ': a link would take the same order with the address and the amount already written down',
    queries: {
      ZA: ['order on WhatsApp food South Africa small business'],
      ZW: ['EcoCash WhatsApp orders Zimbabwe shop', 'WhatsApp to order Harare food'],
    },
  },
];

export const SEGMENT_KEYS = TARGET_SEGMENTS.map((s) => s.key);

export function segmentFor(key) {
  return TARGET_SEGMENTS.find((s) => s.key === String(key)) || null;
}

/* ------------------------------------------------------------ the map source
 * Why a second source exists: the first live pass asked Bing for "website design agency Harare ZW"
 * and Bing answered with Wix, Wikipedia and a dictionary definition of the word "digital". Its RSS
 * endpoint loosens the query until it matches something global. A list built on that is a list of
 * the internet, not of Harare.
 *
 * OpenStreetMap is the opposite kind of source: keyless, structured, and *local by construction* —
 * a bbox around the city, tags for what the business is, and often a phone, an email and a website
 * that a mapper stood in front of and typed in. Every candidate is checkable at a URL anybody can
 * open, which is the same standard the hook is held to.
 */
export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

export const OSM_CITIES = {
  ZW: [['Harare', -17.83, 31.05], ['Bulawayo', -20.15, 28.58]],
  ZA: [['Johannesburg', -26.20, 28.04], ['Cape Town', -33.93, 18.42], ['Durban', -29.86, 31.02]],
  KE: [['Nairobi', -1.29, 36.82]],
  NG: [['Lagos', 6.52, 3.37]],
};

/** What kind of business each segment is, in OpenStreetMap's own vocabulary. */
export const OSM_TAGS = {
  agencies: ['office=company', 'office=advertising_agency', 'office=it', 'craft=web_developer'],
  accountants: ['office=tax_advisor', 'office=accountant', 'office=bookkeeper'],
  pos_resellers: ['shop=computer', 'shop=electronics'],
  associations: ['office=association', 'office=ngo'],
};

export function overpassQuery(city, lat, lon, segment, radius = 0.14) {
  const tags = OSM_TAGS[segment] || [];
  if (!tags.length) return '';
  const bbox = [lat - radius, lon - radius, lat + radius, lon + radius].map((n) => n.toFixed(4)).join(',');
  const parts = tags.map((t) => {
    const [k, v] = t.split('=');
    return '  nwr["' + k + '"="' + v + '"](' + bbox + ');';
  });
  // names and a way to reach them: an unnamed node is a dot, and a named one with no contact is
  // a bookmark. Both are refused here rather than in a seller's morning.
  return '[out:json][timeout:25];\n(\n' + parts.join('\n') + '\n);\nout tags 120;';
}

/** Overpass JSON to the same item shape Bing produces, plus the contact the map already holds. */
export function parseOverpass(doc, segment) {
  const els = (doc && doc.elements) || [];
  const out = [];
  for (const el of els) {
    const t = (el && el.tags) || {};
    const name = String(t.name || t['name:en'] || '').trim();
    if (!name || name.length > 80) continue;
    const email = String(t.email || t['contact:email'] || '').toLowerCase();
    let phone = String(t.phone || t['contact:phone'] || t['contact:mobile'] || '')
      .split(/[;,/]/)[0].replace(/[^\d+]/g, '');
    if (phone && !phonePlausible(phone)) phone = '';
    const site = String(t.website || t['contact:website'] || t.url || '').trim();
    const osmUrl = 'https://www.openstreetmap.org/' + (el.type || 'node') + '/' + el.id;
    const kind = t.office || t.shop || t.craft || '';
    out.push({
      title: name,
      url: /^https?:\/\//.test(site) ? site : osmUrl,
      note: 'listed on OpenStreetMap as ' + (kind || 'a business') + ' in ' + (t['addr:city'] || 'the city'),
      contact: { email: /@/.test(email) ? email : '', phone },
      osm: { type: el.type, id: el.id, url: osmUrl, kind, segment },
      fromMap: true,
    });
  }
  return out;
}

async function runOverpass(fetcher, job, limit) {
  const cities = OSM_CITIES[String(job.country || '').toUpperCase()] || [];
  if (!cities.length) return { items: [], error: 'no_city_for_' + job.country };
  const picked = cities[Math.abs(Number(job.day) || 0) % cities.length];
  const q = overpassQuery(picked[0], picked[1], picked[2], job.segment);
  if (!q) return { items: [], error: 'no_osm_tags' };
  try {
    const r = await fetcher(OVERPASS_URL + '?data=' + encodeURIComponent(q), {
      headers: { 'user-agent': 'Tapstall discovery (harmless, once a day)', accept: 'application/json' },
    });
    if (!r.ok) return { items: [], error: 'status_' + r.status };
    const items = parseOverpass(JSON.parse(await r.text()), job.segment).slice(0, limit);
    return { items, city: picked[0], count: items.length };
  } catch (e) {
    return { items: [], error: String(e && e.message || e).slice(0, 80) };
  }
}

/* --------------------------------------------------------------- the rotation
 * A month of runs must cover every query once without repeating one twice in a day. The plan is
 * deterministic from the day number, so a retried cron produces the same slice and the state
 * document only has to remember which queries have ever run.
 */
export function discoveryPlan(opts = {}) {
  const countries = (opts.countries && opts.countries.length ? opts.countries : ['ZW', 'ZA']);
  const perRun = Math.max(1, Math.min(12, Number(opts.perRun) || 5));
  const dayIndex = Math.floor((Number(opts.nowMs) || Date.now()) / 864e5);
  const done = new Set(opts.done || []);
  const jobs = [];
  for (const seg of TARGET_SEGMENTS) {
    for (const cc of countries) {
      // The map is tried first for the segments it can actually describe (an agency, an
      // accountant, a till shop are all tagged offices and shops); the two softest segments stay on
      // search, where a phrase is the only handle there is.
      const mapFirst = !!OSM_TAGS[seg.key] && (OSM_CITIES[cc] || []).length;
      if (mapFirst) jobs.push({ segment: seg.key, country: cc, source: 'osm', query: 'openstreetmap ' + seg.key, key: 'osm|' + seg.key + '|' + cc });
      for (const q of ((seg.queries || {})[cc] || [])) jobs.push({ segment: seg.key, country: cc, source: 'bing', query: q, key: seg.key + '|' + cc + '|' + q });
    }
  }
  if (!jobs.length) return { jobs: [], day: dayIndex };
  // fresh queries first, then wrap around from today's offset so coverage is continuous
  const fresh = jobs.filter((j) => !done.has(j.key));
  const pool = fresh.length ? fresh : jobs;
  const start = fresh.length ? 0 : (dayIndex * perRun) % pool.length;
  const picked = [];
  for (let i = 0; i < Math.min(perRun, pool.length); i++) picked.push(pool[(start + i) % pool.length]);
  return { jobs: picked, day: dayIndex, total: jobs.length, fresh: fresh.length };
}

/* ------------------------------------------------------------------ parsing
 * Bing RSS is the cheapest honest search surface left: no key, no cookie, and a documented feed.
 * The parser is forgiving on purpose — a feed that changes shape degrades to fewer candidates
 * rather than to an exception inside a cron.
 */
export function parseBingRss(xml) {
  const s = String(xml || '');
  const items = [];
  const blocks = s.split(/<item\b/i).slice(1);
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
      return m ? decodeEntities(m[1]).trim() : '';
    };
    const title = pick('title'), link = pick('link'), desc = pick('description');
    if (!title || !link) continue;
    items.push({ title: stripTags(title).slice(0, 160), url: link, note: stripTags(desc).slice(0, 220) });
  }
  return items;
}

export function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}
export function stripTags(s) { return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }

/** A host we will not treat as a prospect: search engines, social walls, directories that hide
 *  the business behind a login. Keeping this list short and honest beats a clever matcher. */
/* The first live pass, read back, was a lesson: Bing's RSS answers a Zimbabwe agency query with
 * website.com and web.whatsapp.com, and a scraper that files those is a scraper that wastes a
 * seller's morning. So the blocklist is not "the obvious social platforms" — it is every host whose
 * page is a product, a directory or a marketplace rather than a business that could buy something. */
export const SKIP_HOSTS = ['google.', 'bing.com', 'duckduckgo.com', 'facebook.com', 'instagram.com',
  'linkedin.com', 'youtube.com', 'tripadvisor', 'wikipedia.', 'pinterest.', 'tiktok.com', 'x.com', 'twitter.com',
  // platforms and builders: a title from these is a product name, not a prospect
  'whatsapp.com', 'whatsapp.net', 'website.com', 'wix.com', 'squarespace.com', 'wordpress.com',
  'shopify.com', 'godaddy.com', 'hostinger.', 'namecheap.com', 'bluehost.com', 'weebly.com',
  'webflow.io', 'medium.com', 'quora.com', 'reddit.com', 'blogspot.com', 'wordpress.org',
  'github.com', 'apple.com', 'microsoft.com', 'amazon.', 'play.google.com', 'apps.apple.com',
  // directories and marketplaces: someone else's list is not a lead
  'yelp.', 'yellowpages', 'yell.com', 'brabys.com', 'cylex', 'hotfrog', 'kompass.com', 'clutch.co',
  'sortlist.', 'goodfirms.co', 'upwork.com', 'fiverr.com', 'freelancer.com', 'thumbtack.com',
  'alibaba.com', 'aliexpress.com', 'jumia.', 'takealot.com', 'ebay.', 'etsy.com', 'olx.',
  'indeed.com', 'glassdoor.', 'crunchbase.com', 'za.pinterest.com', 'lo.co.zw', 'classifed',
];

export function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; }
}
/** A host is usable when it is a real domain that is not a platform, a directory or a search
 *  engine. Suffix-matched, so `m.whatsapp.com` and `za.yelp.com` are caught too. */
export function usableHost(url) {
  const h = hostOf(url);
  if (!h || h.indexOf('.') < 0) return false;
  if (/\.(pdf|jpg|jpeg|png|gif|zip|docx?|xlsx?)$/.test(h)) return false;
  return !SKIP_HOSTS.some((x) => {
    // 'google.' is a family (google.co.zw, google.com.ng); 'yelp.' must catch za.yelp.com too.
    // Entries ending in a dot are matched anywhere in the host, the rest by exact host or suffix.
    if (x.endsWith('.')) return h.indexOf(x) >= 0;
    return h === x || h.endsWith('.' + x);
  });
}

/* ---------------------------------------------------------- the admission gate
 * Four things have to be true before a candidate is allowed to become work for a seller, and each
 * one is a sentence a person could check by opening the page:
 *   1. it is a business site, not a platform or somebody's directory;
 *   2. it is *in the market we searched* — the page names the country or one of its cities;
 *   3. the name is a business name, not a product slogan ("Create Your Free Website");
 *   4. there is a way to answer — an email, a plausible number, or a WhatsApp route.
 * A pass that fails these produces nothing. Volume is not the metric; a morning not wasted is.
 */
export const MARKET_CITIES = {
  ZW: ['zimbabwe', 'harare', 'bulawayo', 'mutare', 'gweru', 'kwekwe', 'masvingo', 'chitungwiza', 'victoria falls'],
  ZA: ['south africa', 'johannesburg', 'cape town', 'durban', 'pretoria', 'sandton', 'soweto', 'gauteng', 'port elizabeth', 'stellenbosch'],
  KE: ['kenya', 'nairobi', 'mombasa', 'kisumu', 'nakuru'],
  NG: ['nigeria', 'lagos', 'abuja', 'port harcourt', 'ibadan'],
};

/** Telephone lengths that are real in the markets we search: country code + national digits. */
export const PHONE_RULES = { '263': [9], '27': [9], '254': [9], '234': [10, 11] };

/** A number is a number when it is the right length for a market we actually reached and it was
 *  found with a separator or a plus — the live pass filed `279927998279`, an Indonesian id, off a
 *  page that happened to contain it. */
export function phonePlausible(num) {
  const d = String(num || '').replace(/\D/g, '');
  for (const cc of Object.keys(PHONE_RULES)) {
    if (!d.startsWith(cc)) continue;
    const rest = d.slice(cc.length);
    return PHONE_RULES[cc].includes(rest.length);
  }
  return false;
}

/** Does this page say where it is? A page that never names the country or a city of it is not
 *  evidence of a Zimbabwean agency, however it got into the results. */
export function marketMention(text, country) {
  const cc = String(country || '').toUpperCase();
  const words = MARKET_CITIES[cc] || (COUNTRY_NAMES[cc] ? [COUNTRY_NAMES[cc].toLowerCase()] : []);
  if (!words.length) return true;                 // a market we have no vocabulary for is not a filter we can apply
  const t = String(text || '').toLowerCase();
  return words.some((w) => t.indexOf(w) >= 0);
}

const GENERIC_NAME = /\b(create your|build your|log ?in|sign ?in|sign ?up|free website|website builder|home ?page|welcome|official site|book now|get a quote|contact us|search results)\b/i;

/** The map tags `office=company` honestly, and a national utility is a company. An institution is
 *  not a prospect — it cannot buy a storefront, and a seller who rings it has wasted the call. */
const NOT_A_PROSPECT = /\b(council|ministry|government|authority|commission|municipal\w*|university|polytechnic|college|hospital|clinic|school|bank|police|prison|embassy|high court|courts?|parastatal|zesa|zetdc|city of|residents association)\b/i;

export function admitCandidate(item = {}, evidence = {}, opts = {}) {
  const fromMap = !!opts.fromMap;
  const url = String(item.url || '');
  const host = hostOf(url);
  // A map candidate whose only URL is its own OpenStreetMap object has no site to judge — the map
  // record is the evidence, and it was read inside the city's own bbox.
  const mapOnly = fromMap && /openstreetmap\.org$/.test(host);
  if (!mapOnly && !usableHost(url)) return { ok: false, why: 'platform' };
  const body = [item.title, item.note, evidence.title, evidence.text].join(' ');
  if (!opts.pageChecked && !fromMap) return { ok: false, why: 'unverified' };   // no page read, no hook to stand behind
  if (!mapOnly && !marketMention(body + ' ' + host, opts.country)) return { ok: false, why: 'no_local_signal' };
  const name = fromMap ? String(item.title || '').trim() : businessFromTitle(item.title || evidence.title || '', host);
  if (name.length < 2 || name.length > 70) return { ok: false, why: 'no_name' };
  if (GENERIC_NAME.test(name)) return { ok: false, why: 'generic_name' };
  if (NOT_A_PROSPECT.test(name)) return { ok: false, why: 'institution' };
  const contact = opts.contact || {};
  const email = String(contact.email || (evidence.emails && evidence.emails[0]) || '').toLowerCase();
  const phone = phonePlausible(contact.phone) ? String(contact.phone) : (phonePlausible(evidence.phone) ? evidence.phone : '');
  if (!email && !phone) return { ok: false, why: 'no_contact' };
  return { ok: true, why: 'admitted', name, email, phone };
}

/** A business name from a search result: the part before the first separator, cleaned of the
 *  "| Home" / "- Contact us" tails that make a list look like a scraped mess. */
export function businessFromTitle(title, host) {
  let t = stripTags(title);
  t = t.split(/\s+[|–—]\s+|\s+-\s+|\s+::\s+/)[0] || t;
  t = t.replace(/\b(home|homepage|official site|official website|contact us|about us|welcome)\b/gi, '').trim();
  t = t.replace(/[.,;:]+$/, '').trim();
  if (t.length < 2 && host) {
    // A host that is two words ("kwekwe-tills.example") reads back as a name; a single unbroken
    // label does not, so it is kept exactly as it was found rather than turned into an invention.
    const first = String(host).split('.')[0];
    t = /[-_]/.test(first)
      ? first.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      : String(host);
  }
  return t.slice(0, 80);
}

/* -------------------------------------------------------------- the hook
 * One true sentence, built only from what the page shows. If we could not read the page, the hook
 * says what the segment says and nothing more — a true generic line beats a specific lie.
 */
export function hookFor(segmentKey, evidence = {}, candidate = {}) {
  const seg = segmentFor(segmentKey);
  const e = evidence || {};
  const city = candidate.city || '';
  if (e.orders_language && !e.has_order_button) {
    return 'talks about orders on ' + (e.host || 'its site') + ' but gives a buyer no way to order — a link would finish the sentence';
  }
  if (e.has_whatsapp && !e.has_price_page) {
    return 'already sells through WhatsApp, with no page that shows an item and its price — that page takes an hour';
  }
  if (e.no_site) return 'has no website of its own, so every order starts with a typed message';
  if (seg) return seg.hook(candidate);
  return 'a ' + (candidate.country || 'local') + ' business that takes orders by hand today';
}

/** What a fetched page tells us. Deliberately crude and cheap: the point is evidence a human can
 *  check in ten seconds by opening the same URL, not a classifier. */
export function readPageEvidence(html, url) {
  const s = String(html || '');
  const lower = s.toLowerCase();
  const host = hostOf(url);
  const emails = [...new Set((s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])
    .map((x) => x.toLowerCase()).filter((x) => !/\.(png|jpe?g|gif|webp|svg)$/.test(x) && x.length < 80))].slice(0, 3);
  const wa = (s.match(/wa\.me\/(\+?\d{9,15})/i) || [])[1] || '';
  // A number is read with its separators intact — "(024) 771 2345", "+263 77 111 2223" — and then
  // judged against the market's real lengths. The old loose pattern read digits out of the middle
  // of an id and called it a phone.
  const rawPhones = (s.match(/(?:^|[^\d])\+?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}(?![\d])/g) || [])
    .map((x) => x.replace(/[^\d+]/g, '')).filter((x) => phonePlausible(x));
  const phones = [...new Set(rawPhones)].slice(0, 3);
  return {
    host,
    emails,
    phone: wa || phones[0] || '',
    has_whatsapp: !!wa || lower.indexOf('whatsapp') >= 0,
    orders_language: /(order|cart|checkout|buy now|shop now|delivery)/i.test(lower),
    has_order_button: /<(button|a)[^>]*>(\s*)(add to (cart|order)|buy now|order now|checkout)/i.test(lower),
    has_price_page: /(price|usd|zar|\$\s?\d+|r\s?\d{2,}|kwacha)/i.test(lower),
    has_website: !!host,
    title: (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '',
    // a sample of the visible text, for the two questions only text can answer: does this page say
    // where it is, and does it talk about orders. Never stored — `evidence` on a lead is booleans.
    text: stripTags(s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')).slice(0, 4000),
  };
}

/* ------------------------------------------------------- assembling a candidate
 * Everything the Worker's existing `cleanLead` needs, plus the hook and the segment weight so the
 * pipeline scores an agency above a lone shop without either of them being invented.
 */
export function candidateLead(item = {}, opts = {}) {
  const seg = String(opts.segment || item.segment || '');
  const ev = opts.evidence || {};
  const host = hostOf(item.url);
  const business = businessFromTitle(item.title || ev.title || '', host) || host;
  const lead = {
    business,
    email: (ev.emails && ev.emails[0]) || item.email || '',
    phone: ev.phone || item.phone || '',
    country: String(opts.country || item.country || '').slice(0, 40),
    segment: seg || 'agencies',
    source: 'discovery:' + (opts.source || 'bing-rss'),
    source_url: String(item.url || '').slice(0, 300),
    note: [
      item.note ? String(item.note).slice(0, 120) : '',
      opts.hook || hookFor(seg, ev, { city: opts.city, country: opts.country }),
    ].filter(Boolean).join(' — ').slice(0, 240),
    hook: String(opts.hook || hookFor(seg, ev, { city: opts.city, country: opts.country })).slice(0, 200),
    evidence: {
      has_whatsapp: !!ev.has_whatsapp,
      has_order_button: !!ev.has_order_button,
      has_price_page: !!ev.has_price_page,
      page_checked: !!opts.pageChecked,
    },
  };
  return lead;
}

/* ------------------------------------------------------------- the run itself
 * `fetchJson`-less on purpose: the Worker already owns `fetch`, and a pass must be able to fail
 * one source without failing the run.
 */
export async function runDiscovery(opts = {}) {
  const fetcher = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!fetcher) return { ok: false, error: 'no_fetch' };
  const plan = discoveryPlan(opts);
  const limit = Math.max(1, Math.min(40, Number(opts.limit) || 12));
  const perQuery = Math.max(1, Math.min(10, Number(opts.perQuery) || 4));
  const out = { ok: true, day: plan.day, ran: [], candidates: [], errors: [], fetched: 0, rejected: {} };

  for (const job of plan.jobs) {
    if (out.candidates.length >= limit) break;
    const jobWithDay = { ...job, day: plan.day };
    let items = [];
    if (job.source === 'osm') {
      const map = await runOverpass(fetcher, jobWithDay, Math.min(limit, perQuery * 4));
      if (map.error) out.errors.push({ job: job.key, error: map.error });
      items = map.items || [];
      out.ran.push({ ...job, results: items.length, city: map.city || '' });
    } else {
      const q = encodeURIComponent(job.query + ' ' + job.country);
      const url = 'https://www.bing.com/search?format=rss&count=20&q=' + q;
      try {
        const r = await fetcher(url, { headers: { 'user-agent': 'Tapstall discovery (harmless, once a day)', accept: 'application/rss+xml,text/xml' } });
        if (!r.ok) throw new Error('status_' + r.status);
        items = parseBingRss(await r.text()).filter((i) => usableHost(i.url));
        out.ran.push({ ...job, results: items.length });
      } catch (e) {
        out.errors.push({ job: job.key, error: String(e && e.message || e).slice(0, 80) });
        continue;
      }
    }
    for (const item of items.slice(0, perQuery)) {
      if (out.candidates.length >= limit) break;
      let evidence = {};
      let pageChecked = false;
      // a map record with no website of its own: do not fetch the OpenStreetMap object page as if
      // it were the business's site — the hook that matters is that there is no site at all
      const hasOwnSite = !(item.osm && item.url === item.osm.url);
      try {
        if (!hasOwnSite) throw new Error('no_site');
        const pr = await fetcher(item.url, { headers: { 'user-agent': 'Tapstall discovery (harmless, once a day)' } });
        if (pr.ok) {
          const body = (await pr.text()).slice(0, 120000);
          evidence = readPageEvidence(body, item.url);
          pageChecked = true;
          out.fetched++;
        }
      } catch (e) {
        // an unreachable *website* is a finding, not a failure: it is why the hook exists
        if (hasOwnSite) out.errors.push({ page: hostOf(item.url), error: 'page_failed' });
      }
      const admit = admitCandidate(item, evidence, {
        country: job.country, pageChecked, fromMap: !!item.fromMap, contact: item.contact,
      });
      if (!admit.ok) { out.rejected[admit.why] = (out.rejected[admit.why] || 0) + 1; continue; }
      // A map record with no website is still a business a person can ring: the hook says exactly
      // that, which is the sharpest true thing about it.
      const evid = { ...evidence, no_site: !!item.fromMap && !hasOwnSite };
      out.candidates.push(candidateLead({ ...item, email: admit.email, phone: admit.phone }, {
        segment: job.segment, country: job.country, evidence: evid, pageChecked,
        source: item.fromMap ? 'openstreetmap' : 'bing-rss',
        hook: hookFor(job.segment, evid, { country: job.country, city: item.city }),
      }));
    }
  }
  return out;
}

/* --------------------------------------------------------- the honest summary
 * What the morning shows the owner: how many candidates, which segments, and — the number that
 * actually matters — how many carry an email or a number a human can use today.
 */
export function discoverySummary(candidates = []) {
  const by = {};
  let contactable = 0, withHook = 0;
  for (const c of candidates) {
    by[c.segment] = (by[c.segment] || 0) + 1;
    if (c.email || c.phone) contactable++;
    if (c.hook) withHook++;
  }
  return {
    candidates: candidates.length, contactable, with_hook: withHook, by_segment: by,
    note: contactable
      ? 'Every candidate here can be opened by a person in ten seconds: the hook is checkable on the page it came from.'
      : 'No contact details were found today. They are filed as research, not as prospects — nothing will be sent to nobody.',
  };
}
