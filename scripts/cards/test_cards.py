"""python3 -m unittest discover -s scripts/cards (needs Pillow)"""
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mediakit  # noqa: E402
import render  # noqa: E402
from PIL import Image  # noqa: E402

SPEC = {"key": "c0123456789abcdef", "layout": "headline", "shape": "wide", "kicker": "SHOP MATH",
        "headline": "Know the rail cost before you quote.", "body": "Fees are a pricing decision, not a month-end surprise.", "seed": "shop-math"}


class Cards(unittest.TestCase):
    def test_a_wanted_card_renders_as_a_tapstall_wide_png(self):
        png = render.render_spec(SPEC)
        im = Image.open(io.BytesIO(png))
        self.assertEqual(im.size, (1200, 630))
        self.assertLess(len(png), 600_000)
        self.assertEqual(mediakit.load_brand()["name"], "Tapstall")

    def test_brand_never_frames_tapstall_as_free(self):
        b = json.dumps(mediakit.load_brand()).lower()
        self.assertNotIn("free", b)

    def test_main_uploads_each_card_and_skips_bad_keys(self):
        calls = []

        def fake_req(method, url, token, data=None, ctype="application/json"):
            calls.append((method, url, ctype, len(data or b"")))
            if method == "GET":
                return 200, {"items": [SPEC, {"key": "../etc", "headline": "x"}]}
            return 200, {"ok": True}
        with mock.patch.object(render, "req", fake_req), mock.patch.dict(os.environ, {"CARDS_TOKEN": "t"}), mock.patch("sys.stdout", io.StringIO()):
            self.assertEqual(render.main(["--url", "https://t.test"]), 0)
        self.assertEqual([c[0] for c in calls], ["GET", "PUT"])
        self.assertEqual(calls[1][1], "https://t.test/api/press/cards/c0123456789abcdef")
        self.assertEqual(calls[1][2], "image/png")
