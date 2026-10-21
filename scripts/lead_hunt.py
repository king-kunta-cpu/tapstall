#!/usr/bin/env python3
"""TapStall lead hunter — finds operators already selling the hard way, and files them
into the Worker's lead pipeline.

Sources that cost nothing and need no keys:
  1. Bing RSS search (`format=rss`) for WhatsApp sellers by segment. Google strips its
     result pages; Bing's RSS feed does not — never scrape Google SERPs (IP ban).
  2. DuckDuckGo HTML as a fallback, with a browser user agent.
  3. OpenStreetMap Overpass directory queries (formal SMB dossiers, POPIA-respectable
     business contacts). Every Overpass query carries `out center;`.
  4. Each candidate's own page, fetched once, for contact facts: phone, email, and
     WhatsApp/payment language. Those FACTS are what the Worker's 2-signal rule judges —
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
import xml.etree.ElementTree as ET

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
PHONE_RE = re.compile(r"(\+?(?:27|263)[\s().-]*\d[\d\s().-]{7,12}\d|0\d{2}[\s().-]*\d{3}[\s().-]*\d{4})")
WA_LINK_RE = re.compile(r"wa\.me/(\+?\d{9,15})")
SKIP_HOSTS = ("google.", "bing.com", "duckduckgo.com", "facebook.com/pages",
              "tripadvisor", "hellopeter", "wikipedia.", "youtube.com/watch")

QUERIES = {
    "ZA": ["WhatsApp to order kota takeaway South Africa",
           "PayShap WhatsApp orders shop",
           "order on WhatsApp food South Africa",
           "WhatsApp shop order online South Africa small business"],
    "ZW": ["EcoCash WhatsApp orders Zimbabwe shop",
           "WhatsApp to order Harare food delivery",
           "Zimbabwe online shop WhatsApp order",
           "order via WhatsApp Bulawayo shop"],
}
OSM_TAGS = ["shop", "amenity=fast_food", "amenity=restaurant", "amenity=marketplace", "craft"]
OSM_AREAS = {"ZA": "South Africa", "ZW": "Zimbabwe"}


def fetch(url, timeout=15, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")


def bing_rss(query, count=10):
    url = "https://www.bing.com/search?format=rss&q=" + urllib.parse.quote(query)
    _, body = fetch(url)
    root = ET.fromstring(body)
    out = []
    for item in root.iter("item"):
        link = item.findtext("link") or ""
        title = item.findtext("title") or ""
        desc = item.findtext("description") or ""
        out.append({"title": title.strip(), "url": link.strip(),
                    "note": re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", desc))).strip()[:240]})
    return out[:count]


def ddg_html(query, count=8):
    url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(query)
    _, body = fetch(url)
    out = []
    for m in re.finditer(r'class="result__a" href="([^"]+)"[^>]*>(.*?)</a>', body):
        href = html.unescape(m.group(1))
        if "uddg=" in href:
            href = urllib.parse.unquote(urllib.parse.parse_qs(urllib.parse.urlparse(href).query).get("uddg", [href])[0])
        out.append({"title": re.sub(r"<[^>]+>", "", html.unescape(m.group(2))).strip(), "url": href, "note": ""})
    return out[:count]


def osm_overpass(country, limit=40):
    area = OSM_AREAS.get(country)
    if not area:
        return []
    filters = ""
    for tag in OSM_TAGS:
        if "=" in tag:
            k, v = tag.split("=", 1)
            filters += f'node["{k}"="{v}"](area.a);'
        else:
            filters += f'node["{tag}"](area.a);'
    ql = f'[out:json][timeout:50];area["name"="{area}"]->.a;({filters});out center {limit};'
    # `out center;` is mandatory on every Overpass query (ways/relations carry no coordinates
    # otherwise). The public instance 406s browser UAs and 502s under load — identify honestly
    # and let the caller's tolerance skip the source that day rather than fail the hunt.
    _, body = fetch("https://overpass-api.de/api/interpreter?" + urllib.parse.urlencode({"data": ql}),
                    timeout=60, headers={"User-Agent": "tapstall-lead-hunt/1.0"})
    out = []
    for el in (json.loads(body).get("elements") or []):
        t = el.get("tags") or {}
        name = t.get("name")
        if not name:
            continue
        out.append({
            "business": name, "phone": t.get("contact:phone") or t.get("phone") or "",
            "email": t.get("contact:email") or t.get("email") or "",
            "website": t.get("contact:website") or t.get("website") or "",
            "url": "https://www.openstreetmap.org/node/%s" % el.get("id"),
            "note": ("OSM " + (t.get("shop") or t.get("amenity") or t.get("craft") or "")).strip(),
        })
    return out


def page_facts(url):
    """One polite fetch of the prospect's own page → contact facts only."""
    try:
        _, body = fetch(url, timeout=12)
    except Exception:
        return {}
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", body, flags=re.I | re.S)
    text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", text)))
    email = ""
    for e in EMAIL_RE.findall(text + " " + body):
        if not re.search(r"\.(png|jpg|svg|webp|css|js)$|example\.|sentry|wixpress", e, re.I):
            email = e
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


def hunt(countries, limit, enrich=True):
    seen, leads = set(), []
    for cc in countries:
        for q in QUERIES.get(cc, []):
            results = []
            try:
                results = bing_rss(q)
            except Exception as e:
                print(f"  bing failed for '{q}': {e}", file=sys.stderr)
            if not results:
                try:
                    results = ddg_html(q)
                except Exception as e:
                    print(f"  ddg failed for '{q}': {e}", file=sys.stderr)
            for r in results:
                url = r["url"].split("#")[0]
                host = urllib.parse.urlparse(url).netloc.lower()
                if not url or url in seen or any(h in host for h in SKIP_HOSTS):
                    continue
                seen.add(url)
                lead = {"business": clean_title(r["title"]), "source_url": url,
                        "note": r.get("note", ""), "country": cc,
                        "segment": segment_for(r["title"] + " " + r.get("note", ""))}
                if enrich:
                    facts = page_facts(url)
                    lead["email"] = facts.get("email", "")
                    lead["phone"] = facts.get("phone", "")
                    if facts.get("cues"):
                        lead["note"] = (lead["note"] + " | " + ", ".join(facts["cues"]))[:300]
                leads.append(lead)
                if len(leads) >= limit:
                    return leads
        try:
            for r in osm_overpass(cc):
                if r["url"] in seen:
                    continue
                seen.add(r["url"])
                lead = {"business": r["business"], "phone": r["phone"], "email": r["email"],
                        "website": r["website"], "source_url": r["url"], "note": r["note"],
                        "country": cc, "segment": "directories"}
                leads.append(lead)
                if len(leads) >= limit:
                    return leads
        except Exception as e:
            print(f"  overpass failed for {cc}: {e}", file=sys.stderr)
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
    got = []
    for cc in ("ZA", "ZW"):
        try:
            rows = bing_rss(QUERIES[cc][0], 3)
            print(f"[{cc}] bing rss: {len(rows)} rows" + (f" — {rows[0]['title'][:50]}" if rows else ""))
            got += rows
        except Exception as e:
            print(f"[{cc}] bing rss failed: {e}")
    try:
        rows = osm_overpass("ZA", 5)
        print(f"[ZA] overpass: {len(rows)} dossiers" + (f" — {rows[0]['business']}" if rows else ""))
        got += rows
    except Exception as e:
        print(f"[ZA] overpass failed: {e}")
    f = page_facts("https://example.com")
    print(f"page_facts(example.com) -> email={f.get('email')!r} cues={f.get('cues')}")
    ok = len(got) >= 3
    print("SELFTEST", "OK" if ok else "FAILED (no source answered)")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description="TapStall lead hunter")
    ap.add_argument("--origin", default=os.environ.get("TAPSTALL_ORIGIN", "https://tapstall.zlnew.workers.dev"))
    ap.add_argument("--limit", type=int, default=60)
    ap.add_argument("--countries", default="ZA,ZW")
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
