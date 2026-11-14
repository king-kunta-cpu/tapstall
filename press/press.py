#!/usr/bin/env python3
"""Tapstall press — the copy bank, the cards, and the rotation.

Mechanism Audit has a press; Tapstall did not. This is that press: a fixed bank of posts, each one
carrying a real Tapstall card (rendered by the venture's own card engine at
king-kunta-cpu.github.io/tapstall/brand/cards/), published through `social.py`, in a rotation that
keeps the owner's two rules by construction rather than by memory:

    * every post carries an image — a post with no card is refused, not published as text;
    * value outnumbers promo 2:1 — the bank is ordered so that every third post is the only promo in
      the window, and `--selftest` proves it.

    python3 press.py --plan               # what the queue looks like, and the ratio
    python3 press.py --due [--dry]        # publish the next post in the rotation
    python3 press.py --post 3 [--dry]     # publish one specific post
    python3 press.py --status             # where the rotation is, what has gone out
    python3 press.py --selftest           # no network: bank shape and ratio

State lives in `press-state.json` next to this file, committed by the workflow so the rotation
survives a runner dying. A post that already went out is never sent twice.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE = HERE / "press-state.json"
CARDS = "https://king-kunta-cpu.github.io/tapstall/brand/cards"
SITE = "https://tapstall.tapstall.workers.dev"
FREE_DAYS = 60

# --------------------------------------------------------------------------- the bank
# kind: "value" teaches something a market trader can use on its own; "promo" asks.
# card: a real rendered card from the venture's card engine. No post ships without one.
BANK = [
    dict(id="till-tips", kind="value", card=f"{CARDS}/till-tips.png", tags=["shop", "zimbabwe"],
         text="Take the order where the customer already is. A WhatsApp shop needs no app: one link, "
              "a menu that stays current, and a message that says what to pay.\n\n"
              "This week: pin the link, price every item, say how long delivery takes."),
    dict(id="exact-amount", kind="value", card=f"{CARDS}/exact-amount.png", tags=["payments", "ecocash"],
         text="Matching money to orders is the whole job. If two buyers pay the same amount on the same "
              "day, a screenshot tells you nothing.\n\n"
              "Give each order its own odd amount and a short reference. The alert then names the buyer."),
    dict(id="shop-math", kind="value", card=f"{CARDS}/shop-math.png", tags=["pricing", "fees"],
         text="Know the rail cost before you quote. Mobile money, bank transfer and card each take a "
              "different cut, and a price built on the wrong one quietly loses money on every order.\n\n"
              "Work the fee into the shelf price once, write it down, and stop re-deciding it at the "
              "counter."),
    dict(id="buyer-trust", kind="value", card=f"{CARDS}/buyer-trust.png", tags=["trust", "sales"],
         text="A first-time buyer is answering one question: what happens if this goes wrong?\n\n"
              "Answer it in the shop link itself — who you are, where the shop is, how long delivery "
              "takes, and what a refund looks like. The traders who write it down get the second order."),
    dict(id="menu-craft", kind="value", card=f"{CARDS}/menu-craft.png", tags=["menu", "copy"],
         text="A menu is a price list and a promise. The item name sells it, the line under the name "
              "closes it, and the photo confirms it.\n\n"
              "One line under each item: what is in it, how big it is, what it costs. That is the "
              "whole edit, and it is the one most shops never make."),
    dict(id="books", kind="value", card=f"{CARDS}/books.png", tags=["bookkeeping", "records"],
         text="The cheapest bookkeeping is the kind the order does for you.\n\n"
              "If every order already records the item, the amount and the moment it was paid, then "
              "month-end is a read, not a reconstruction from chat scrollback."),
    dict(id="launch", kind="value", card=f"{CARDS}/launch.png", tags=["opening", "first-week"],
         text="Opening a shop link well is a week of small, boring decisions: a name people can spell, "
              "a photo that is in focus, five items instead of forty, and a delivery rule you can keep "
              "on your worst day.\n\n"
              "Start with the five things you sell most. The rest can wait for the second week."),
    dict(id="promo-free", kind="promo", card=f"{CARDS}/promo.png", tags=["tapstall"],
         text=f"Tapstall is a shop link for the markets the big platforms skip: EcoCash, InnBucks, "
              f"PayShap and ZIPIT understood, exact-amount payment matching, and your own sheet.\n\n"
              f"Free for {FREE_DAYS} days, no card to open, no order cap.",
         link=SITE),
    dict(id="promo-price", kind="promo", card=f"{CARDS}/shop-math.png", tags=["tapstall", "pricing"],
         text="One bill a year, priced for a counter in Harare rather than a salary in San Francisco: "
              "$7 a month, or $60 for a founding year. No percentage of your orders, ever.",
         link=SITE),
    dict(id="promo-orders", kind="promo", card=f"{CARDS}/exact-amount.png", tags=["tapstall", "orders"],
         text="Your orders stop living in the chat. A Tapstall shop keeps name, number, address, items "
              "and the exact amount in a dashboard you own — and tells the buyer what to pay.",
         link=SITE),
    dict(id="promo-week", kind="promo", card=f"{CARDS}/promo.png", tags=["tapstall", "zimbabwe"],
         text="Set up in about ninety seconds, on a phone, with no app to install. Free for "
              f"{FREE_DAYS} days and no card to start — a shop in Harare, sold at a price a Harare "
              "shop can carry.",
         link=SITE),
    dict(id="repeat", kind="value", card=f"{CARDS}/buyer-trust.png", tags=["retention", "service"],
         text="The second order is the business. A buyer comes back for being remembered, not for a "
              "discount: the same delivery window, the same spelling of their name, the same amount "
              "they paid last time.\n\nWrite it down once and the remembering is free."),
]

# The rotation: value first, and never two promos closer than three slots apart. Written out rather
# than computed so the order is reviewable in a diff; the selftest enforces the ratio.
ROTATION = ["till-tips", "promo-free", "exact-amount", "shop-math", "promo-price",
            "buyer-trust", "menu-craft", "promo-orders", "books", "launch",
            "promo-week", "repeat"]

CADENCE_HOURS = 30          # about one post a day and a quarter: enough to be present, not a firehose


def load_state() -> dict:
    if STATE.exists():
        try:
            return json.loads(STATE.read_text())
        except json.JSONDecodeError:
            pass
    return {"sent": [], "last_at": ""}


def save_state(st: dict) -> None:
    STATE.write_text(json.dumps(st, indent=1) + "\n")


def by_id(post_id: str) -> dict:
    for p in BANK:
        if p["id"] == post_id:
            return p
    raise SystemExit(f"no such post: {post_id}")


def next_post(st: dict) -> dict:
    sent = st.get("sent", [])
    if len(sent) >= len(ROTATION):
        return {}                     # the bank is spent; a human writes the next one
    return by_id(ROTATION[len(sent)])


def due(st: dict, now: dt.datetime | None = None) -> bool:
    now = now or dt.datetime.now(dt.timezone.utc)
    last = st.get("last_at") or ""
    if not last:
        return True
    try:
        prev = dt.datetime.fromisoformat(last.replace("Z", "+00:00"))
    except ValueError:
        return True
    return (now - prev).total_seconds() >= CADENCE_HOURS * 3600


def publish(post: dict, dry: bool = False) -> int:
    import social                                    # the rail in this directory
    if not post:
        print("the bank is spent — write the next post before the queue runs dry", file=sys.stderr)
        return 3
    card = post["card"]
    print(f"→ {post['id']} ({post['kind']}) card={card.rsplit('/', 1)[-1]}")
    # the card goes in as the image itself, never as a hint inside the text: a hint counts against
    # Bluesky's 300-grapheme limit (measured: 301 on the first live send, rejected by createRecord)
    res = social.post(post["text"], link=post.get("link", ""), tags=post.get("tags", []),
                      image=card, dry=dry)
    good = sum(1 for ok, _ in res.values() if ok)
    for rail, (ok, detail) in res.items():
        print(f"  {'OK  ' if ok else 'FAIL'} {rail:9s} {detail}")
    if not dry and good:
        st = load_state()
        st["sent"] = list(st.get("sent", [])) + [post["id"]]
        st["last_at"] = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
        st.setdefault("log", []).append({"id": post["id"], "at": st["last_at"], "rails": good})
        save_state(st)
    return 0 if good else 1


def plan(st: dict) -> None:
    sent = set(st.get("sent", []))
    print(f"{'#':<3}{'id':<14}{'kind':<7}{'state':<10}card")
    for i, pid in enumerate(ROTATION, 1):
        p = by_id(pid)
        print(f"{i:<3}{pid:<14}{p['kind']:<7}{'sent' if pid in sent else 'queued':<10}"
              f"{p['card'].rsplit('/', 1)[-1]}")
    vals = sum(1 for pid in ROTATION if by_id(pid)["kind"] == "value")
    promos = len(ROTATION) - vals
    print(f"\n{vals} value : {promos} promo  ({vals / max(promos, 1):.1f}:1, rule is 2:1)")
    nxt = next_post(st)
    print(f"next: {nxt.get('id', '— bank spent —')} · cadence {CADENCE_HOURS}h · "
          f"last {st.get('last_at') or 'never'}")


def selftest() -> int:
    problems = []
    ids = [p["id"] for p in BANK]
    if len(ids) != len(set(ids)):
        problems.append("duplicate post id")
    for p in BANK:
        if not p.get("card", "").startswith("https://"):
            problems.append(f"{p['id']}: no card")
        total = len(p["text"]) + (len(p.get("link", "")) + 2 if p.get("link") else 0)
        if total > 300:
            problems.append(f"{p['id']}: {total} chars with its link — over Bluesky's 300")
        if p["kind"] not in ("value", "promo"):
            problems.append(f"{p['id']}: bad kind {p['kind']}")
    if sorted(ids) != sorted(ROTATION):
        problems.append("rotation and bank disagree")
    # no two promos within three slots, and value outnumbers promo 2:1 in every window of 3
    kinds = [by_id(p)["kind"] for p in ROTATION]
    for i in range(len(kinds) - 2):
        if kinds[i:i + 3].count("value") < 2:
            problems.append(f"window at {i} is {kinds[i:i + 3]} — breaks 2 value : 1 promo")
    for i, k in enumerate(kinds):
        if k == "promo" and i > 0 and kinds[i - 1] == "promo":
            problems.append(f"two promos back to back at {i}")
    print("bank:", len(BANK), "posts ·", kinds.count("value"), "value ·", kinds.count("promo"), "promo")
    for p in problems:
        print("  ✗", p)
    print("  ✓ clean" if not problems else f"  {len(problems)} problem(s)")
    return 0 if not problems else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--due", action="store_true")
    ap.add_argument("--post", default="")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    st = load_state()

    if a.selftest:
        return selftest()
    if a.plan or a.status:
        plan(st)
        return 0
    if a.post:
        return publish(by_id(a.post), a.dry)
    if a.due:
        if not due(st):
            print(f"not due yet (last {st.get('last_at')}, cadence {CADENCE_HOURS}h) — nothing sent")
            return 0
        return publish(next_post(st), a.dry)
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
