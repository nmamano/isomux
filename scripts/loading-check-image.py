"""The image of scripts/loading-check.mjs (task d3593a12).

    python3 -I scripts/loading-check-image.py <held.png> <loaded.png> <out.png>

stdin: a JSON list of {"held": box, "loaded": box}, a box with x, y, w, h in
viewport pixels. Draws a red box on each in its shot, labels the shots
"Loading" and "Loaded" in a band above each, and puts them side by side, or one above the other
when the shots are wider than tall.
"""

import json
import sys

from PIL import Image, ImageDraw, ImageFont

held_path, loaded_path, out_path = sys.argv[1:4]
marks = json.load(sys.stdin)


def font(size):
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass
    return ImageFont.load_default()


def mark(path, key, title):
    """The shot with its red boxes, under a band that holds its label: the
    label never covers the shot."""
    shot = Image.open(path).convert("RGB")
    draw = ImageDraw.Draw(shot)
    for m in marks:
        b = m[key]
        x0, y0 = b["x"], b["y"]
        x1, y1 = x0 + max(b["w"], 1), y0 + max(b["h"], 1)
        draw.rectangle([x0 - 2, y0 - 2, x1 + 2, y1 + 2], outline=(255, 0, 0), width=3)
    f = font(40)
    probe = ImageDraw.Draw(shot)
    left, top, right, bottom = probe.textbbox((0, 0), title, font=f)
    pad = 12
    band = bottom - top + 2 * pad
    img = Image.new("RGB", (shot.width, shot.height + band), (0, 0, 0))
    ImageDraw.Draw(img).text((pad - left, pad - top), title, font=f, fill=(255, 255, 255))
    img.paste(shot, (0, band))
    return img


held = mark(held_path, "held", "Loading")
loaded = mark(loaded_path, "loaded", "Loaded")
gap = 16
w, h = held.size
if w > h:
    out = Image.new("RGB", (w, 2 * h + gap), (255, 255, 255))
    out.paste(held, (0, 0))
    out.paste(loaded, (0, h + gap))
else:
    out = Image.new("RGB", (2 * w + gap, h), (255, 255, 255))
    out.paste(held, (0, 0))
    out.paste(loaded, (w + gap, 0))
out.save(out_path)
