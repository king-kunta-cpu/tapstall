#!/usr/bin/env python3
"""TapStall lead hunter — finds operators already selling the hard way, and files them
into the Worker's lead pipeline.

Sources that cost nothing and need no keys (v2.0.0):
  1. OpenStreetMap Overpass, one city bounding box at a time (rotating daily), asking only for
     places that carry a phone, an email or a website. Every query uses `out center`. The old
     whole-country `area["name"=…]` query timed out (502) and the old Bing RSS / DuckDuckGo leg
     filed search results ABOUT WhatsApp and EcoCash — support@meta.com, stock-ticker sites —
     as leads. Both are gone.
  2. Each candidate's own website, fetched once, for contact facts: phone, an email ON THAT
     DOMAIN, and WhatsApp/payment language. Those FACTS are what the Worker's gate judges —
     this script never claims a signal, it only gathers evidence.

It never sends anything to anyone. Output is POST /api/leads/ingest, where the Worker
dedupes, scores (2 signals before outreach), allocates each prospect to exactly one
seller, and respects the do-not-contact ledger.

Usage:
  python3 scripts/lead_hunt.py --selftest
  python3 scripts/lead_hunt.py --dry-run [--limit 40] [--countries ZA,ZW]
  ADMIN_SECRET=... python3 scripts/lead_hunt.py --post [--origin https://tapstall.zlnew.workers.dev]
"""
import argparse
import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import datetime
import time

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
PHONE_RE = re.compile(r"(\+?(?:27|263)[\s().-]*\d[\d\s().-]{7,12}\d|0\d{2}[\s().-]*\d{3}[\s().-]*\d{4})")
WA_LINK_RE = re.compile(r"wa\.me/(\+?\d{9,15})")
# (south, west, north, east). Rotated by day so a week covers every city and no day hammers one.
CITY_BBOX = {
    "ZW": [("Harare", (-17.93, 30.95, -17.73, 31.15)), ("Bulawayo", (-20.20, 28.50, -20.10, 28.65)),
           ("Mutare", (-19.00, 32.62, -18.94, 32.70)), ("Gweru", (-19.48, 29.78, -19.42, 29.85))],
    "ZA": [("Johannesburg", (-26.28, 27.93, -26.08, 28.13)), ("Cape Town", (-34.00, 18.38, -33.88, 18.55)),
           ("Durban", (-29.90, 30.95, -29.80, 31.08)), ("Pretoria", (-25.80, 28.15, -25.70, 28.28)),
           ("Soweto", (-26.30, 27.82, -26.20, 27.95)), ("Gqeberha", (-34.00, 25.55, -33.90, 25.65))],
}
OVERPASS_ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
                      "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"]
FREE_MAIL = re.compile(r"@(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|icloud|aol|proton|protonmail|zoho|gmx|mweb|telkomsa|vodamail|zol)\.", re.I)
ROLE_JUNK = re.compile(r"^(privacy|abuse|webmaster|postmaster|hostmaster|noreply|no-reply|donotreply|press|media|legal|security|careers|jobs|user|name|email|you|yourname)@", re.I)


def site_of(host):
    h = (host or "").lower().split(":")[0]
    h = h[4:] if h.startswith("www.") else h
    parts = [p for p in h.split(".") if p]
    if len(parts) <= 2:
        return ".".join(parts)
    n = 3 if (parts[-2] in ("co", "com", "org", "net", "ac", "gov", "edu", "biz") and len(parts[-1]) == 2) else 2
    return ".".join(parts[-n:])


def fetch(url, timeout=15, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")


# Three cheap parts, not a union of every tag pair: the 18-part version timed out on every public
# mirror. A shop with a website is enriched from that site; one with a phone is reachable already.
OSM_MAIN_PARTS = ('nwr["shop"]["phone"]', 'nwr["shop"]["website"]',
                  'nwr["amenity"~"^(fast_food|restaurant|cafe)$"]["phone"]')
# v2.2.1: the three kinds of seller the slim query dropped: makers who sell what they make, market
# traders, and food places that list only a website. Asked as a SECOND, best-effort query: folded
# into the main one, it timed out on all four mirrors (29 Oct), and a busy mirror must never cost
# the main batch.
OSM_EXTRA_PARTS = ('nwr["craft"~"^(tailor|dressmaker|caterer|shoemaker|jeweller|confectionery|bakery|'
                   'photographer|beautician|upholsterer|carpenter)$"]["phone"]',
                   'nwr["amenity"="marketplace"]["phone"]',
                   'nwr["amenity"~"^(fast_food|restaurant|cafe)$"]["website"]')


def osm_city(cc, city, bbox, limit=40, parts=OSM_MAIN_PARTS, endpoints=None):
    s_, w_, n_, e_ = bbox
    b = f"({s_},{w_},{n_},{e_})"
    ql = "[out:json][timeout:25];(" + "".join(p + b + ";" for p in parts) + f");out center tags {limit * 3};"
    # The public instance 406s browser UAs and 502s under load — identify honestly and let the
    # caller skip the city that day rather than fail the hunt.
    body, last = None, None
    for attempt, ep in enumerate(endpoints or OVERPASS_ENDPOINTS):
        try:
            _, body = fetch(ep, data=urllib.parse.urlencode({"data": ql}).encode(), timeout=35,
                            headers={"User-Agent": "tapstall-lead-hunt/2.0 (+https://tapstall.zlnew.workers.dev)"})
            break
        except Exception as e:          # 429/502/504 at capacity: next mirror after a short backoff
            last = e
            time.sleep(min(8, 2 ** attempt))
    if body is None:
        raise last
    out = []
    for el in (json.loads(body).get("elements") or []):
        t = el.get("tags") or {}
        name = t.get("name")
        if not name or is_chain(name, t):
            continue
        out.append({
            "business": name[:80], "phone": t.get("contact:phone") or t.get("phone") or t.get("contact:whatsapp") or "",
            "email": t.get("contact:email") or t.get("email") or "",
            "website": t.get("contact:website") or t.get("website") or "",
            "url": "https://www.openstreetmap.org/%s/%s" % (el.get("type", "node"), el.get("id")),
            "note": ("OSM " + (t.get("shop") or t.get("amenity") or t.get("craft") or "") + " in " + city).strip(),
        })
    return out


# Tapstall sells to the independent seller. A branch of a chain has a head office, a POS system and
# a marketing department, and its OSM email is the chain's (benmore@pnp.co.za, info@wimpy.co.za).
CHAIN_TAGS = ("brand", "brand:wikidata", "operator:wikidata", "network")
# Distinctive names only: generic words (total, shell, game, pep, clicks) would catch "Total Fashion
# Boutique". Fuel stations and most branches carry a brand tag, which CHAIN_TAGS already catches.
CHAIN_RE = re.compile(r"\b(pick ?n ?pay|spar|shoprite|checkers|woolworths|makro|ackermans|mr ?price|dis-?chem|"
                      r"kfc|mcdonald'?s|wimpy|steers|debonairs|nando'?s|chicken inn|pizza inn|creamy inn|bakers inn|"
                      r"ok mart|ok zimbabwe|tm pick ?n ?pay|food lover'?s|choppies|usave|"
                      r"cbz|steward bank|fbc bank|nmb bank|absa|fnb|standard bank|nedbank|capitec|econet|netone|vodacom|telkom)\b", re.I)


def is_chain(name, tags):
    return any(tags.get(k) for k in CHAIN_TAGS) or bool(CHAIN_RE.search(name or ""))


def cities_for(cc, day=None, per_run=2):
    rows = CITY_BBOX.get(cc, [])
    if not rows:
        return []
    d = (day or datetime.date.today()).toordinal()
    return [rows[(d * per_run + i) % len(rows)] for i in range(min(per_run, len(rows)))]


def page_facts(url):
    """One polite fetch of the prospect's own page → contact facts only."""
    try:
        _, body = fetch(url, timeout=12)
    except Exception:
        return {}
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", body, flags=re.I | re.S)
    text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", text)))
    email = ""
    site = site_of(urllib.parse.urlparse(url).netloc)
    for e in EMAIL_RE.findall(text + " " + body):
        if re.search(r"\.(png|jpg|svg|webp|css|js)$|example\.|sentry|wixpress|domain\.com", e, re.I) or ROLE_JUNK.search(e):
            continue
        # an address on the business's own domain, or a free-mail box printed on its own page;
        # never a third party's address that happens to appear (a theme vendor, a news site)
        if site_of(e.split("@")[1]) == site or FREE_MAIL.search(e):
            email = e.lower()
            break
    phone = ""
    wa = WA_LINK_RE.search(body)
    if wa:
        phone = wa.group(1)
    else:
        m = PHONE_RE.search(text)
        phone = m.group(1).strip() if m else ""
    cues = []
    low = text.lower()
    for cue in ("whatsapp to order", "whatsapp us", "order on whatsapp", "ecocash", "payshap",
                "m-pesa", "proof of payment", "send proof", "dm to order", "order via whatsapp"):
        if cue in low:
            cues.append(cue)
    return {"email": email, "phone": phone, "cues": cues, "snippet": text[:200]}


def segment_for(text):
    t = text.lower()
    if re.search(r"school|academy|tutor|college|creche", t):
        return "dues_and_fees"
    if re.search(r"kota|food|takeaway|restaurant|kitchen|catering|braai|cuisine|eats|bakery", t):
        return "catalog_vendors"
    return "social_merchants"


def clean_title(title):
    t = re.sub(r"\s*[|•\-–—]\s*(Home|Facebook|Instagram|.*Online|Official.*)$", "", title, flags=re.I)
    return t.strip(" -|•")[:80]


def hunt(countries, limit, enrich=True, day=None):
    seen, leads = set(), []
    for cc in countries:
        for city, bbox in cities_for(cc, day):
            try:
                rows = osm_city(cc, city, bbox)
            except Exception as e:
                print(f"  overpass failed for {city}: {type(e).__name__}", file=sys.stderr)
                continue
            try:   # makers, market traders, website-only food places: a bonus, never a blocker
                rows += osm_city(cc, city, bbox, 15, OSM_EXTRA_PARTS, OVERPASS_ENDPOINTS[:2])
            except Exception as e:
                print(f"  extra categories skipped for {city}: {type(e).__name__}", file=sys.stderr)
            for r in rows:
                if r["url"] in seen:
                    continue
                seen.add(r["url"])
                lead = {"business": r["business"], "phone": r["phone"], "email": r["email"],
                        "website": r["website"], "source_url": r["url"], "note": r["note"],
                        "country": cc, "segment": segment_for(r["business"] + " " + r["note"])}
                if enrich and r["website"].startswith("http"):
                    facts = page_facts(r["website"])
                    lead["email"] = lead["email"] or facts.get("email", "")
                    lead["phone"] = lead["phone"] or facts.get("phone", "")
                    if facts.get("cues"):
                        lead["note"] = (lead["note"] + " | " + ", ".join(facts["cues"]))[:300]
                if not (lead["email"] or lead["phone"]):
                    continue
                leads.append(lead)
                if len(leads) >= limit:
                    return leads
    return leads


def post_leads(origin, secret, leads):
    total = {}
    for i in range(0, len(leads), 50):
        chunk = leads[i:i + 50]
        req = urllib.request.Request(
            origin.rstrip("/") + "/api/leads/ingest",
            data=json.dumps({"leads": chunk}).encode(),
            headers={"Content-Type": "application/json", "x-tapstall-admin": secret,
                     "x-tapstall-confirm": "1", "User-Agent": "tapstall-lead-hunt/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            res = json.loads(r.read())
        for k, v in (res.get("counts") or {}).items():
            total[k] = total.get(k, 0) + v
    return total


def selftest():
    # offline checks first (a public runner must not fail on Overpass weather)
    assert site_of("mail.shop.co.za") == "shop.co.za" and site_of("www.fluency.co.zw") == "fluency.co.zw"
    assert len(cities_for("ZW", datetime.date(2026, 10, 28))) == 2
    assert cities_for("ZW", datetime.date(2026, 10, 28)) != cities_for("ZW", datetime.date(2026, 10, 29))
    assert ROLE_JUNK.search("privacy@x.com") and not ROLE_JUNK.search("sales@x.com")
    assert is_chain("Pick n Pay Benmore", {}) and is_chain("Mama's Kitchen", {"brand": "X"}) and is_chain("KFC Avondale", {})
    assert not is_chain("Upi Computers", {"shop": "computer"}) and not is_chain("Gameplan Tailors", {}) and not is_chain("Total Fashion Boutique", {})
    assert len(OSM_MAIN_PARTS) == 3 and len(OSM_EXTRA_PARTS) == 3
    assert any('"craft"' in p for p in OSM_EXTRA_PARTS) and any("marketplace" in p for p in OSM_EXTRA_PARTS)
    assert all(p.count("[") == p.count("]") and p.count('"') % 2 == 0 for p in OSM_MAIN_PARTS + OSM_EXTRA_PARTS)
    print("offline checks OK")
    try:
        city, bbox = CITY_BBOX["ZW"][0]
        rows = osm_city("ZW", city, bbox, 5)
        print(f"[ZW] overpass {city}: {len(rows)} places" + (f" — {rows[0]['business']}" if rows else ""))
    except Exception as e:
        print(f"[ZW] overpass failed (not fatal): {type(e).__name__}")
    print("SELFTEST OK")
    return 0


def main():
    ap = argparse.ArgumentParser(description="TapStall lead hunter")
    ap.add_argument("--origin", default=os.environ.get("TAPSTALL_ORIGIN", "https://tapstall.zlnew.workers.dev"))
    ap.add_argument("--limit", type=int, default=60)
    ap.add_argument("--countries", default="ZW,ZA")
    ap.add_argument("--post", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--no-enrich", action="store_true", help="skip fetching each prospect's page")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    countries = [c.strip().upper() for c in a.countries.split(",") if c.strip()]
    print(f"Hunting {countries}, limit {a.limit} ...")
    leads = hunt(countries, a.limit, enrich=not a.no_enrich)
    print(f"hunted {len(leads)} prospects")
    if a.post and not a.dry_run:
        secret = os.environ.get("ADMIN_SECRET", "")
        if not secret:
            print("ADMIN_SECRET env required to --post", file=sys.stderr)
            return 2
        counts = post_leads(a.origin, secret, leads)
        print("ingest counts:", json.dumps(counts, sort_keys=True))
    else:
        print(json.dumps(leads[:10], indent=1)[:3000])
        print("(dry run — nothing posted)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
