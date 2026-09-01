#!/usr/bin/env python3
"""Generate the Marketplace publisher-profile logo.

This is the *publisher* mark, not the extension icon. It identifies the account
across every extension published under it, so it deliberately says nothing about
TIFF: an 'SV' monogram (for the `sciviewer` handle) over the same ground as the
extension icon, with the accent rule echoing that icon's display-range bar.

    python3 tools/make-publisher-logo.py                 # publisher-logo.png, 512px
    python3 tools/make-publisher-logo.py -o out.png -s 256
    python3 tools/make-publisher-logo.py --text CT       # different handle
    python3 tools/make-publisher-logo.py --variant accent

Needs Pillow (`pip install Pillow`) and a geometric sans; it falls back through
Avenir Next, Futura and Helvetica Neue, then to Pillow's default.
"""
import argparse
import os
from PIL import Image, ImageDraw, ImageFont

INK = (247, 249, 252)
GROUND = (20, 24, 32)
ACCENT = (90, 170, 255)

# Tracking is per-monogram: letter pairs with a diagonal ('SV', 'AV') leave a
# hole at default spacing and need pulling in, while two upright forms ('CI')
# crowd if you apply the same value. Fractions of the canvas width.
PAIR_TRACKING = {
    "SV": -0.028,
    "AV": -0.030,
    "VA": -0.030,
    "AT": -0.022,
}
DEFAULT_TRACKING = 0.0

FONTS = [
    ("/System/Library/Fonts/Avenir Next.ttc", 2),      # Demi Bold
    ("/System/Library/Fonts/Supplemental/Futura.ttc", 0),
    ("/System/Library/Fonts/HelveticaNeue.ttc", 10),   # Medium
    ("/Library/Fonts/Arial.ttf", 0),
]


def load_font(size):
    for path, index in FONTS:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size, index=index)
            except OSError:
                continue
    return ImageFont.load_default(size)


def rounded_mask(size, radius, ss):
    m = Image.new("L", (size * ss, size * ss), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        [0, 0, size * ss - 1, size * ss - 1], radius=radius * ss, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def build(size=512, text="SV", variant="rule", ss=4, tracking=None):
    p = size * ss
    img = Image.new("RGBA", (p, p), GROUND)
    font = load_font(int(p * 0.40))
    if tracking is None:
        tracking = PAIR_TRACKING.get(text.upper(), DEFAULT_TRACKING)
    tracking = tracking * p
    colors = [INK] * len(text)
    if variant == "accent" and len(text) > 1:
        colors[-1] = ACCENT

    # Draw on a transparent layer first so the mark can be centred on its real
    # ink extent; font metrics include ascender space and would sit it too high.
    layer = Image.new("RGBA", (p, p), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x = p * 0.1
    for ch, color in zip(text, colors):
        d.text((x, p * 0.25), ch, font=font, fill=color)
        x += d.textlength(ch, font=font) + tracking

    bbox = layer.getbbox()
    if bbox is None:
        raise SystemExit("nothing was drawn - no usable font found")
    lw, lh = bbox[2] - bbox[0], bbox[3] - bbox[1]

    rule_h, rule_w, gap = p * 0.030, p * 0.30, p * 0.075
    has_rule = variant == "rule"
    # Letters and rule are one lockup, centred as a group.
    total_h = lh + (gap + rule_h if has_rule else 0)
    top = p / 2 - total_h / 2

    placed = Image.new("RGBA", (p, p), (0, 0, 0, 0))
    placed.paste(layer.crop(bbox), (int(p / 2 - lw / 2), int(top)))
    img = Image.alpha_composite(img, placed)

    if has_rule:
        y = top + lh + gap
        ImageDraw.Draw(img).rounded_rectangle(
            [p / 2 - rule_w / 2, y, p / 2 + rule_w / 2, y + rule_h],
            radius=rule_h / 2, fill=ACCENT)

    flat = img.convert("RGB").resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(flat, (0, 0), rounded_mask(size, int(size * 0.22), ss))
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", default="publisher-logo.png")
    ap.add_argument("-s", "--size", type=int, default=512)
    ap.add_argument("--text", default="SV")
    ap.add_argument("--variant", choices=["rule", "accent", "plain"], default="rule")
    ap.add_argument("--tracking", type=float, default=None,
                    help="letter spacing as a fraction of width; overrides the "
                         "per-pair default (negative tightens)")
    a = ap.parse_args()
    build(a.size, a.text, a.variant, tracking=a.tracking).save(a.out)
    used = a.tracking if a.tracking is not None else PAIR_TRACKING.get(a.text.upper(), DEFAULT_TRACKING)
    print(f"wrote {a.out} ({a.size}x{a.size}, '{a.text}', variant={a.variant}, tracking={used:+.3f})")
