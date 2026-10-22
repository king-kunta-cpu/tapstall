#!/usr/bin/env python3
"""
Bind the cover artwork into the interior PDF.

The type-set interiors already carried a typographic title panel as page 1. The
artwork replaces that panel rather than being added in front of it, so pagination,
the contents page and every cross-reference in the text keep pointing at the page
they always pointed at.

Requires pypdf (`pip install pypdf`) and the 300 dpi art from scripts/make_covers.py,
which is generated to a scratch directory rather than committed.

Usage:  python3 scripts/bind_covers.py [--print-dir DIR] [--check]
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# interior PDF -> (cover id, title line for the PDF metadata)
BINDINGS = {
    "book/Garikai-2026-The-Ledger-and-the-Shopkeeper.pdf": ("ledger", "The Ledger and the Shopkeeper"),
    "book/Garikai-2026-Intelligence-Data-and-Judgement.pdf": ("intelligence", "Intelligence, Data and Judgement"),
}
# kept for the pre-rename filenames, so the script also works on an older checkout
LEGACY = {
    "book/Garikai-2026-The-Ledger-and-the-Shopkeeper.pdf": ("ledger", "The Ledger and the Shopkeeper"),
    "book/Garikai-2026-Intelligence-Data-and-Judgement.pdf": ("intelligence", "Intelligence, Data and Judgement"),
}


def cover_page_pdf(jpeg, w=432, h=648):
    """One page, one JPEG, no fonts — small enough to stay inside the interior's size."""
    data = Path(jpeg).read_bytes()
    content = f"q {w} 0 0 {h} 0 0 cm /Im0 Do Q".encode()
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 {w} {h}] >>".encode(),
        b"<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
        (f"<< /Type /XObject /Subtype /Image /Width 1800 /Height 2700 /ColorSpace /DeviceRGB "
         f"/BitsPerComponent 8 /Filter /DCTDecode /Length {len(data)} >>".encode(), data),
        (f"<< /Length {len(content)} >>".encode(), content),
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objs, 1):
        parts = obj if isinstance(obj, tuple) else (obj,)
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode()
        for j, part in enumerate(parts):
            out += part
            if len(parts) > 1 and j == 0:
                out += b"\nstream\n"
            elif len(parts) > 1 and j == 1:
                out += b"\nendstream"
        out += b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs)+1}\n".encode() + b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").encode()
    return bytes(out)


def main():
    from pypdf import PdfReader, PdfWriter
    print_dir = Path(sys.argv[sys.argv.index("--print-dir") + 1]) if "--print-dir" in sys.argv \
        else Path("/tmp/covers")
    check_only = "--check" in sys.argv

    bindings = dict(LEGACY)
    bindings.update({k: v for k, v in BINDINGS.items() if (ROOT / k).exists()})
    if not bindings:
        sys.exit("no interior PDF found — nothing to bind")

    for rel, (cid, title) in bindings.items():
        interior = ROOT / rel
        art = print_dir / f"{cid}-300.jpg"
        if not art.exists():
            sys.exit(f"missing cover art {art} — run scripts/make_covers.py first")
        reader = PdfReader(str(interior))
        first = (reader.pages[0].extract_text() or "").strip().lower()
        already = not first                 # a bound cover page carries no extractable text
        if check_only:
            print(f"{rel}: {len(reader.pages)} pages, cover bound: {already}")
            continue
        if already:
            print(f"{rel}: cover already bound, left alone")
            continue
        writer = PdfWriter()
        cover_tmp = Path("/tmp") / f"{cid}-cover-page.pdf"
        cover_tmp.write_bytes(cover_page_pdf(art))
        writer.append(str(cover_tmp))
        writer.append(str(interior), pages=(1, len(reader.pages)))   # keep the contents onward
        writer.add_metadata({
            "/Title": title,
            "/Author": "Courage Garikai",
            "/Subject": "Jacaranda Labs Press · Harare · first edition 2026",
            "/Creator": "scripts/bind_covers.py",
        })
        tmp = interior.with_suffix(".bound.pdf")
        writer.write(str(tmp))
        tmp.replace(interior)
        cover_tmp.unlink()
        print(f"{rel}: cover bound, {len(PdfReader(str(interior)).pages)} pages, "
              f"{interior.stat().st_size:,} B")


if __name__ == "__main__":
    main()
