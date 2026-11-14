#!/usr/bin/env python3
"""Tapstall global harvest (build step 3, 2026-11-06).

The market is every seller the card processors leave out: 105 countries Stripe does not serve (minus the
sanctioned ones), taken from the public Chrome UX Report country lists (github.com/zakird/crux-top-lists),
hosts on the country's own domain only (a .pe site in Peru's list, a .ng site in Nigeria's).

Each run probes one slice of that pool: the slice is the GitHub run number modulo SLICES, so successive
runs never probe the same host twice until the whole pool has been read. Per host: one homepage GET and,
for a page that already shows the evidence, one contact page. Public pages only, nothing is stored but
the facts below.

A host becomes a lead only with all three facts (the evidence rule in the strategy, section 6):
  * it sells online (an add-to-cart, a cart page, WooCommerce or a Shopify storefront),
  * a trigger: a WhatsApp order link, a local wallet (Yape, M-Pesa, GCash...), bank transfer or a
    request for proof of payment,
  * a generic inbox on the site's own domain (info@, ventas@, contato@...). Never a named person's
    address, never an address on another domain. A site that loads Stripe already takes cards: skipped.

Output is POST /api/leads/ingest (100 per call). The Worker re-judges every lead (strict email/domain
match, junk rules, the do-not-contact ledger) before anything is stored, and stores leads in TS_DB.

--recheck re-reads the queued leads against the same rule and puts the ones that fail on hold
(action "hold": back to research, never a stop, nothing deleted).

Usage:
  python3 scripts/harvest_global.py --selftest
  python3 scripts/harvest_global.py --dry-run --limit 200
  ADMIN_SECRET=... python3 scripts/harvest_global.py --post [--limit 1700] [--run N]
  ADMIN_SECRET=... python3 scripts/harvest_global.py --recheck [--post]
"""
import argparse
import concurrent.futures as cf
import datetime
import gzip
import hashlib
import html as htmllib
import io
import json
import os
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request

COUNTRIES = ("ng ke gh ci ug tz rw zm zw mw mz ao na bw ls sz cm sn ml bf ne tg bj gn sl lr gm cd cg ga et dj mg mu sc km "
             "cv tn dz ma eg mr ps jo lb om bh kw qa sa tr ge am az kz uz kg tj tm mn pk bd lk np bt mv ph vn kh la id in "
             "pe co ar bo ec py uy cl gt hn sv ni cr pa do jm tt ht bs bb bz gy sr pg fj ua md al ba mk me rs xk").split()
# ccTLDs sold worldwide as vanity names: a .co or .me site says nothing about where the seller is
VANITY = {"co", "me", "to", "ws", "st", "tv", "fm", "io", "ai", "cc", "la", "ly", "md", "am", "sh", "gg", "so", "ms", "gy", "bz"}
NON_COMMERCIAL = (".gov.", ".edu.", ".ac.", ".mil.", ".org.", ".gob.", ".go.", ".gouv.", ".nic.", ".sch.", ".police.", ".int.")
SLICES = 600
CRUX = "https://raw.githubusercontent.com/zakird/crux-top-lists/main/data/country/{cc}/{month}.csv.gz"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
ORIGIN = "https://tapstall.tapstall.workers.dev"

RX = {
    "wa": re.compile(r"wa\.me/|api\.whatsapp\.com/send|whatsapp://send|web\.whatsapp\.com/send|chat\.whatsapp\.com/", re.I),
    "cart": re.compile(r"add[ _-]to[ _-]cart|añadir al carrito|agregar al carrito|ajouter au panier|adicionar ao carrinho|"
                       r"tambah(kan)? ke keranjang|sepete ekle|thêm vào giỏ|додати в кошик|в корзину|أضف إلى السلة|"
                       r"woocommerce|cdn\.shopify\.com|/cart\b|/carrito\b|/carrinho\b|/panier\b|/sepet\b", re.I),
    "transfer": re.compile(r"bank transfer|transferencia bancaria|transferência|virement bancaire|transfer bank|havale|\bEFT\b|"
                           r"dep[oó]sito bancario|chuyển khoản|банківськ\w* переказ|تحويل بنكي", re.I),
    "wallet": re.compile(r"\byape\b|\bplin\b|\bnequi\b|daviplata|gcash|paymaya|maya wallet|m-?pesa|jazzcash|easypaisa|bkash|\bnagad\b|"
                         r"\bmomo\b|mobile money|orange money|wave money|airtel money|ecocash|gopay|dana wallet|vodafone cash|"
                         r"\bsinpe\b|tigo money|mercado ?pago|telebirr|\bpaytm\b|phonepe|\bupi\b|zalopay|\bfawry\b|instapay|"
                         r"monobank|privat24", re.I),
    "pop": re.compile(r"proof of payment|comprobante de pago|comprovante|preuve de paiement|bukti transfer|dekont|"
                      r"chứng từ|скріншот оплати|إثبات الدفع", re.I),
    "stripe": re.compile(r"js\.stripe\.com|checkout\.stripe\.com", re.I),
}
EMAIL_RX = re.compile(r"(?:mailto:)?([a-z0-9][a-z0-9._%+-]{0,40}@[a-z0-9.-]+\.[a-z]{2,})", re.I)
# generic inboxes only (owner, 6 Nov: never a named person's address)
GENERIC = re.compile(r"^(info|infos|information|contact|contacts|contacto|contato|contactenos|kontak|iletisim|hello|hi|hola|ola|ol[aá]|"
                     r"sales|ventas|vendas|ventes|satis|penjualan|order|orders|pedidos|pedido|commande|commandes|siparis|shop|store|"
                     r"tienda|loja|boutique|magasin|toko|office|oficina|escritorio|service|services|servicio|servicios|atendimento|"
                     r"atencion|atencionalcliente|sac|cs|customercare|customerservice|care|support|soporte|suporte|help|ayuda|"
                     r"enquiries|enquiry|inquiries|inquiry|reservas|reservations|booking|bookings|admin|mail|team|equipo|"
                     r"marketing|comercial|business|cskh|lienhe|hotro|zakaz|zamovlennya|cliente|clientes|client|clients)"
                     r"([._-]?[a-z]{0,12})?@", re.I)
CONTACT_HREF = re.compile(r"""href=["']([^"'#]*(?:contact|contacto|contato|kontak|iletisim|nous-contacter|lien-he|kontakt|"""
                          r"""contactenos|contact-us|about|sobre|tentang)[^"']*)["']""", re.I)
SECOND_LEVEL = {"co", "com", "net", "org", "gov", "ac", "edu", "or", "ne", "go", "mil", "biz", "info", "web", "nom", "gob", "sch", "in"}


def site_of(host):
    """The registrable domain, roughly: shop.example.com.pe -> example.com.pe. The Worker re-checks strictly."""
    parts = host.lower().strip(".").split(".")
    if len(parts) >= 3 and parts[-2] in SECOND_LEVEL and len(parts[-1]) == 2:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def bucket(host):
    return int(hashlib.sha1(host.encode()).hexdigest()[:8], 16) % SLICES


def usable_host(h, cc):
    if not h or not h.endswith("." + cc) or cc in VANITY:
        return False
    if any(x in "." + h + "." for x in NON_COMMERCIAL) or h.startswith(("gov.", "edu.")):
        return False
    return True


def parse_crux(text, cc):
    out = []
    for line in text.splitlines()[1:]:
        origin = line.split(",")[0].strip()
        host = (urllib.parse.urlparse(origin).hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        if usable_host(host, cc):
            out.append(host)
    return out


def get(url, timeout=10, cap=600_000, ctx=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en,es;q=0.8,pt;q=0.6,fr;q=0.5"})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        return r.geturl(), r.read(cap).decode("utf-8", "replace")


def crux_month():
    d = datetime.date.today().replace(day=1)
    for _ in range(5):
        d = (d - datetime.timedelta(days=1)).replace(day=1)
        m = d.strftime("%Y%m")
        try:
            urllib.request.urlopen(urllib.request.Request(CRUX.format(cc="ng", month=m), method="HEAD"), timeout=20)
            return m
        except Exception:
            continue
    raise SystemExit("no CrUX month found")


def load_pool(month, cache_dir):
    os.makedirs(cache_dir, exist_ok=True)

    def one(cc):
        path = os.path.join(cache_dir, "%s-%s.csv.gz" % (cc, month))
        try:
            if not os.path.exists(path):
                raw = urllib.request.urlopen(CRUX.format(cc=cc, month=month), timeout=60).read()
                with open(path, "wb") as f:
                    f.write(raw)
            with gzip.open(path) as g:
                return [(h, cc) for h in parse_crux(g.read().decode("utf-8", "replace"), cc)]
        except Exception:
            return []
    pool = {}
    with cf.ThreadPoolExecutor(8) as ex:
        for rows in ex.map(one, COUNTRIES):
            for h, cc in rows:
                pool.setdefault(h, cc)
    return sorted(pool.items())


def title_of(page, host):
    m = re.search(r'<meta[^>]+property=["\']og:site_name["\'][^>]+content=["\']([^"\']{2,80})', page, re.I)
    if not m:
        m = re.search(r"<title[^>]*>([^<]{2,200})</title>", page, re.I)
    t = htmllib.unescape(m.group(1)).strip() if m else ""
    t = re.split(r"\s+[|\-–—:·»]\s+", t)[0].strip() if t else ""
    return t[:80] or host


def emails_on(page, host):
    site = site_of(host)
    seen, out = set(), []
    for m in EMAIL_RX.finditer(page):
        e = m.group(1).lower().strip(".")
        dom = e.split("@")[1]
        if e in seen or re.search(r"\.(png|jpe?g|gif|webp|svg|css|js)$", e):
            continue
        seen.add(e)
        if site_of(dom) != site or not GENERIC.match(e):
            continue
        out.append(e)
    rank = lambda e: (0 if re.match(r"^(ventas|vendas|sales|orders?|pedidos?|shop|store|tienda|loja)", e) else 1, len(e))
    return sorted(out, key=rank)


def wa_number(page):
    m = re.search(r"(?:wa\.me/|phone=)\+?(\d{8,15})", page)
    return m.group(1) if m else ""


def facts(page):
    return {k: bool(rx.search(page)) for k, rx in RX.items()}


def judge(host, cc, page, final_url, contact_page=""):
    """(lead or None, reason). Pure: no network."""
    f = facts(page + "\n" + contact_page)
    if f["stripe"]:
        return None, "takes cards (Stripe)"
    if not f["cart"]:
        return None, "does not sell online"
    trig = [k for k in ("wa", "wallet", "transfer", "pop") if f[k]]
    if not trig:
        return None, "no trigger"
    em = emails_on(page + "\n" + contact_page, host)
    if not em:
        return None, "no generic inbox on the site's domain"
    wallets = sorted({m.group(0).strip().lower() for m in RX["wallet"].finditer(page + contact_page)})[:3]
    bits = (["orders over WhatsApp"] if f["wa"] else []) + (["mentions " + ", ".join(wallets)] if wallets else []) \
        + (["takes bank transfers"] if f["transfer"] else []) + (["asks for proof of payment"] if f["pop"] else [])
    lead = {
        "business": title_of(page, host), "email": em[0], "website": "https://" + host,
        "source_url": final_url if final_url.startswith("http") else "https://" + host,
        "country": cc.upper(), "segment": "other", "source": "crux-harvest",
        "evidence": {"has_whatsapp": f["wa"], "has_order_button": True, "page_checked": True},
        "signals": ["payment_friction"] if (f["wallet"] or f["transfer"] or f["pop"]) else [],
        "note": ("Site: " + "; ".join(bits))[:300],
    }
    num = wa_number(page + contact_page)
    if num:
        lead["phone"] = num
    return lead, "lead"


def probe(item, ctx):
    host, cc = item
    page, final = "", ""
    for scheme in ("https://", "http://"):
        try:
            final, page = get(scheme + host, ctx=ctx)
            break
        except Exception:
            continue
    if not page:
        return host, None, "unreachable"
    lead, why = judge(host, cc, page, final)
    if not lead and why == "no generic inbox on the site's domain":
        m = CONTACT_HREF.search(page)
        if m:
            try:
                _, cpage = get(urllib.parse.urljoin(final or "https://" + host, m.group(1)), timeout=8, ctx=ctx)
                lead, why = judge(host, cc, page, final, cpage)
            except Exception:
                pass
    return host, lead, why


def post_json(url, body, admin=""):
    headers = {"Content-Type": "application/json", "User-Agent": "tapstall-harvest/1.0"}
    if admin:
        headers.update({"x-tapstall-admin": admin, "x-tapstall-confirm": "1"})
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except Exception:
            return {"ok": False, "error": "http %s" % e.code}


def harvest(args):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    t0 = time.time()
    month = crux_month()
    pool = load_pool(month, args.cache)
    run = args.run if args.run is not None else int(os.environ.get("GITHUB_RUN_NUMBER", "0") or 0)
    sl = run % SLICES
    todo = [x for x in pool if bucket(x[0]) == sl][: args.limit]
    print("crux %s: pool %d hosts in %d countries; run %d -> slice %d: %d hosts" % (
        month, len(pool), len({c for _, c in pool}), run, sl, len(todo)))
    leads, why = [], {}
    with cf.ThreadPoolExecutor(args.threads) as ex:
        for host, lead, reason in ex.map(lambda it: probe(it, ctx), todo):
            why[reason] = why.get(reason, 0) + 1
            if lead:
                leads.append(lead)
    print("probed %d in %.0fs: %s" % (len(todo), time.time() - t0, json.dumps(why, sort_keys=True)))
    by_cc = {}
    for l in leads:
        by_cc[l["country"]] = by_cc.get(l["country"], 0) + 1
    print("leads %d by country %s" % (len(leads), json.dumps(dict(sorted(by_cc.items(), key=lambda x: -x[1])))))
    if not args.post:
        for l in leads[:10]:
            print("  ", l["country"], l["website"], l["email"], "|", l["note"])
        return 0
    secret = os.environ.get("ADMIN_SECRET", "")
    if not secret:
        raise SystemExit("ADMIN_SECRET is required to post")
    total = {}
    for i in range(0, len(leads), 100):
        r = post_json(args.origin.rstrip("/") + "/api/leads/ingest", {"leads": leads[i:i + 100]}, admin=secret)
        for k, v in (r.get("counts") or {}).items():
            total[k] = total.get(k, 0) + v
        if not r.get("ok"):
            print("ingest error:", r.get("error"))
    print("ingest:", json.dumps(total, sort_keys=True))
    return 0


def recheck(args):
    secret = os.environ.get("ADMIN_SECRET", "")
    if not secret:
        raise SystemExit("ADMIN_SECRET is required")
    q = urllib.parse.urlencode({"code": "owner", "key": secret, "status": "queued"})
    with urllib.request.urlopen(urllib.request.Request(args.origin.rstrip("/") + "/api/leads?" + q,
                                                       headers={"User-Agent": "tapstall-harvest/1.0"}), timeout=60) as r:
        leads = json.loads(r.read()).get("leads") or []
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    def check(l):
        url = l.get("website") or l.get("source_url") or ""
        host = (urllib.parse.urlparse(url).hostname or "").lower().replace("www.", "", 1)
        email = (l.get("email") or "").lower()
        if not host:
            return l, "no website to check"
        if not email or site_of(email.split("@")[-1]) != site_of(host):
            return l, "no site email"
        try:
            _, page = get(url if url.startswith("http") else "https://" + host, ctx=ctx)
        except Exception:
            return l, "site unreachable"
        f = facts(page)
        if not (f["wa"] or f["wallet"] or f["transfer"] or f["pop"]):
            return l, "no trigger on the site"
        return l, "keep"
    tally = {}
    with cf.ThreadPoolExecutor(16) as ex:
        results = list(ex.map(check, leads))
    for l, verdict in results:
        tally[verdict] = tally.get(verdict, 0) + 1
        if verdict != "keep" and args.post:
            r = post_json(args.origin.rstrip("/") + "/api/leads/act", {"code": "owner", "key": secret, "id": l["id"], "action": "hold",
                                                                      "note": "recheck 2026-11: " + verdict})
            if not r.get("ok"):
                tally["hold_failed"] = tally.get("hold_failed", 0) + 1
    print("recheck of %d queued leads: %s%s" % (len(leads), json.dumps(tally, sort_keys=True), "" if args.post else " (dry run)"))
    return 0


def selftest():
    shop = ('<html><head><meta property="og:site_name" content="Panadería Rosa"><title>Inicio | Panadería Rosa</title></head>'
            '<a href="https://wa.me/51987654321">Pide por WhatsApp</a> Pagos con Yape o Plin. <button>Agregar al carrito</button>'
            '<a href="mailto:ventas@panaderiarosa.com.pe">ventas</a> juan.perez@panaderiarosa.com.pe info@otrodominio.pe</html>')
    lead, why = judge("panaderiarosa.com.pe", "pe", shop, "https://panaderiarosa.com.pe/")
    assert why == "lead", why
    assert lead["email"] == "ventas@panaderiarosa.com.pe", lead["email"]
    assert lead["business"] == "Panadería Rosa"
    assert lead["country"] == "PE" and lead["phone"] == "51987654321"
    assert lead["evidence"] == {"has_whatsapp": True, "has_order_button": True, "page_checked": True}
    assert lead["signals"] == ["payment_friction"]
    assert "yape" in lead["note"] and "WhatsApp" in lead["note"]
    assert judge("x.com.pe", "pe", shop.replace("ventas@", "juan.perez@"), "")[1] == "no generic inbox on the site's domain", "named person refused"
    assert judge("x.com.pe", "pe", shop + '<script src="https://js.stripe.com/v3"></script>', "")[1] == "takes cards (Stripe)"
    assert judge("x.com.pe", "pe", shop.replace("Agregar al carrito", "Ver"), "")[1] == "does not sell online"
    plain = shop.replace("wa.me/51987654321", "x").replace("Yape o Plin", "efectivo")
    assert judge("panaderiarosa.com.pe", "pe", plain, "")[1] == "no trigger"
    assert emails_on("info@shop.co.ke sales@cdn.shop.co.ke a@b.png", "shop.co.ke") == ["sales@cdn.shop.co.ke", "info@shop.co.ke"]
    assert site_of("www.shop.com.ng") == "shop.com.ng" and site_of("shop.ng") == "shop.ng"
    assert parse_crux("origin,rank\nhttps://www.tienda.pe,1000\nhttps://x.com,1000\nhttps://sunat.gob.pe,1000\n", "pe") == ["tienda.pe"]
    assert not usable_host("shop.co", "co") and not usable_host("min.gov.ng", "ng") and usable_host("shop.ng", "ng")
    assert bucket("tienda.pe") == bucket("tienda.pe") and 0 <= bucket("tienda.pe") < SLICES
    print("SELFTEST OK - evidence rule, generic inboxes only, Stripe skipped, slices, CrUX parsing")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--post", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--recheck", action="store_true")
    ap.add_argument("--limit", type=int, default=1700)
    ap.add_argument("--threads", type=int, default=48)
    ap.add_argument("--run", type=int, default=None)
    ap.add_argument("--cache", default=os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"), "crux"))
    ap.add_argument("--origin", default=os.environ.get("TAPSTALL_ORIGIN", ORIGIN))
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if a.dry_run:
        a.post = False
    return recheck(a) if a.recheck else harvest(a)


if __name__ == "__main__":
    sys.exit(main())
