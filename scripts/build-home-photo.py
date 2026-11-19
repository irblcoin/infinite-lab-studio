#!/usr/bin/env python3
"""Build the ILS homepage hero photo from one source image.

    python3 scripts/build-home-photo.py path/to/photo.jpg [--rotate DEG]

The photo of the control room is slightly tilted and has flat grey wedges in
the top-left and bottom-right corners (the edges of the scanner/camera frame).
This script:

  1. finds those flat grey areas,
  2. measures the tilt of their inner edge (the real edge of the photo),
  3. rotates the photo back to level,
  4. crops to the largest rectangle that contains no grey at all,
  5. lifts exposure/contrast a little without changing the warm look,
  6. writes WebP + JPG at 480/768/1080/1440/1920 px, a 32 px blurred
     placeholder, and src/ui/homePhoto.ts for the homepage to import.

Everything is free/open-source (Pillow). No keys, no network.
"""

from __future__ import annotations

import argparse
import base64
import io
import math
import os
import sys

from PIL import Image, ImageEnhance, ImageFilter, ImageStat

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "public", "studio")
TS_PATH = os.path.join(ROOT, "src", "ui", "homePhoto.ts")
WIDTHS = [480, 768, 1080, 1440, 1920]


def grey_mask(img: Image.Image) -> Image.Image:
    """Mask of flat, neutral grey pixels (0 = photo, 255 = grey wedge)."""
    small = img.convert("RGB")
    px = small.load()
    w, h = small.size
    mask = Image.new("L", (w, h), 0)
    mp = mask.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            hi, lo = max(r, g, b), min(r, g, b)
            # Flat grey: almost no chroma and no bright highlight.
            if hi - lo <= 10 and 45 <= hi <= 215:
                mp[x, y] = 255
    # Remove speckle so textured walls are not mistaken for the wedge.
    return mask.filter(ImageFilter.MedianFilter(5))


def wedge_line(mask: Image.Image, corner: str) -> tuple[float, float] | None:
    """Fit x = a*y + b to the inner edge of a corner wedge."""
    w, h = mask.size
    px = mask.load()
    rows = range(0, int(h * 0.45)) if corner == "tl" else range(int(h * 0.55), h)
    points: list[tuple[float, float]] = []
    for y in rows:
        xs = [x for x in range(w) if px[x, y] > 127]
        if len(xs) < w * 0.02:
            continue
        edge = max(xs) if corner == "tl" else min(xs)
        # Keep only rows where the wedge is a thin corner slice, not the frame.
        if corner == "tl" and edge > w * 0.55:
            continue
        if corner == "br" and edge < w * 0.45:
            continue
        points.append((float(y), float(edge)))
    if len(points) < max(12, h * 0.05):
        return None
    n = len(points)
    my = sum(p[0] for p in points) / n
    mx = sum(p[1] for p in points) / n
    var = sum((p[0] - my) ** 2 for p in points)
    if var <= 1e-6:
        return None
    a = sum((p[0] - my) * (p[1] - mx) for p in points) / var
    b = mx - a * my
    return a, b


def estimate_tilt(img: Image.Image) -> float:
    """Degrees to rotate so the photo edges become vertical/horizontal."""
    small = img.convert("RGB")
    small.thumbnail((900, 900))
    mask = grey_mask(small)
    angles = []
    for corner in ("tl", "br"):
        fit = wedge_line(mask, corner)
        if fit is None:
            continue
        a, _ = fit
        angles.append(math.degrees(math.atan(a)))
    if not angles:
        return 0.0
    return sum(angles) / len(angles)


def clean_bbox(img: Image.Image) -> tuple[int, int, int, int] | None:
    """Bounding box of everything that is not a grey wedge."""
    small = img.convert("RGB")
    small.thumbnail((900, 900))
    mask = grey_mask(small)
    inv = mask.point(lambda v: 0 if v > 127 else 255)
    bbox = inv.getbbox()
    if not bbox:
        return None
    sx = img.width / small.width
    sy = img.height / small.height
    left, top, right, bottom = (int(bbox[0] * sx), int(bbox[1] * sy), int(bbox[2] * sx), int(bbox[3] * sy))
    # Keep a hair of margin so no antialiased grey survives the crop.
    inset = max(2, int(min(img.size) * 0.004))
    left, top = left + inset, top + inset
    right, bottom = right - inset, bottom - inset
    if right - left < img.width * 0.5 or bottom - top < img.height * 0.5:
        return None
    return left, top, right, bottom


def enhance(img: Image.Image) -> Image.Image:
    """A gentle, believable lift: a little brighter, a little more contrast."""
    out = img.convert("RGB")
    stat = ImageStat.Stat(out.resize((64, 64)))
    mean = sum(stat.mean) / 3
    # Only brighten genuinely dark photos, and never blow the warm highlights.
    if mean < 150:
        out = ImageEnhance.Brightness(out).enhance(min(1.10, 1.0 + (150 - mean) / 900))
    out = ImageEnhance.Contrast(out).enhance(1.06)
    out = ImageEnhance.Color(out).enhance(1.04)
    return out.filter(ImageFilter.UnsharpMask(radius=1.1, percent=55, threshold=3))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("--rotate", type=float, default=None, help="Override the detected tilt (degrees).")
    ap.add_argument("--no-enhance", action="store_true")
    ap.add_argument(
        "--screen",
        default="42.7,11.3,18.6,13.2",
        help="Wall monitor screen as left,top,width,height in percent of the photo (default fits the control-room photo).",
    )
    args = ap.parse_args()

    if not os.path.isfile(args.source):
        print(f"! no such file: {args.source}", file=sys.stderr)
        return 1

    img = Image.open(args.source)
    img = img.convert("RGB")
    # Phone photos carry an orientation tag; apply it before anything else.
    try:
        from PIL import ImageOps

        img = ImageOps.exif_transpose(img)
    except Exception:
        pass

    tilt = args.rotate if args.rotate is not None else estimate_tilt(img)
    if abs(tilt) > 0.2:
        img = img.rotate(tilt, resample=Image.BICUBIC, expand=False)
        print(f"· straightened by {tilt:.2f}°")
    else:
        print("· photo is already level")

    box = clean_bbox(img)
    if box:
        img = img.crop(box)
        print(f"· cropped grey corners -> {img.width}x{img.height}")
    else:
        # No grey wedges detected (or they cover too much): keep the frame and
        # trim a thin border instead of guessing.
        inset = int(min(img.size) * 0.008)
        img = img.crop((inset, inset, img.width - inset, img.height - inset))
        print("· no grey wedges found, trimmed the outer border instead")

    if not args.no_enhance:
        img = enhance(img)

    os.makedirs(OUT_DIR, exist_ok=True)
    # Never upscale past 1080 on top of the source; large photos get the full set.
    largest = max(int(img.width), 1080)
    base = img.copy()
    if base.width > largest:
        base = base.resize((largest, round(base.height * largest / base.width)), Image.LANCZOS)

    for width in WIDTHS:
        if width > max(base.width, 1080):
            continue
        h = round(base.height * width / base.width)
        frame = base.resize((width, h), Image.LANCZOS)
        frame.save(os.path.join(OUT_DIR, f"studio-room-{width}.jpg"), quality=86, progressive=True, optimize=True)
        frame.save(os.path.join(OUT_DIR, f"studio-room-{width}.webp"), quality=84, method=6)
        print(f"  wrote studio-room-{width}.{{jpg,webp}}")

    tiny = base.resize((32, max(1, round(base.height * 32 / base.width))), Image.LANCZOS)
    tiny = tiny.filter(ImageFilter.GaussianBlur(1.4))
    tiny_path = os.path.join(OUT_DIR, "studio-room-tiny.webp")
    tiny.save(tiny_path, quality=70, method=6)
    raw = io.BytesIO()
    tiny.save(raw, format="WEBP", quality=62, method=6)
    placeholder = "data:image/webp;base64," + base64.b64encode(raw.getvalue()).decode("ascii")

    ratio = base.height / base.width
    built = [w for w in WIDTHS if w <= max(base.width, 1080)]
    try:
        screen = [float(v) for v in args.screen.split(",")]
        if len(screen) != 4:
            raise ValueError
    except ValueError:
        print("! --screen needs four comma separated numbers", file=sys.stderr)
        return 2
    ts = f"""// Generated by scripts/build-home-photo.py — rebuild after swapping the photo.
export const HOME_PHOTO = {{
  base: '/studio/studio-room',
  widths: [{', '.join(str(w) for w in built)}],
  /** height / width of the cleaned photo, used to reserve layout space. */
  ratio: {ratio:.6f},
  /** Wall-monitor screen in percent of the photo (left, top, width, height). */
  screen: {{ left: {screen[0]}, top: {screen[1]}, width: {screen[2]}, height: {screen[3]} }},
  /** 32 px blurred copy, shown before the real frame arrives. */
  placeholder:
    '{placeholder}',
}}

export function homeSrcSet(ext: 'jpg' | 'webp'): string {{
  return HOME_PHOTO.widths.map((w) => `${{HOME_PHOTO.base}}-${{w}}.${{ext}} ${{w}}w`).join(', ')
}}

export const HOME_PHOTO_ALT =
  'The ILS home studio: a wall-mounted display showing the mixer above a desk with a mixing console, MIDI keyboard and rack unit, studio monitors either side, a microphone, turntable and a wall chord chart.'
"""
    with open(TS_PATH, "w", encoding="utf-8") as fh:
        fh.write(ts)
    print(f"· wrote {os.path.relpath(TS_PATH, ROOT)}")
    print(f"· placeholder {len(placeholder) // 1024} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
