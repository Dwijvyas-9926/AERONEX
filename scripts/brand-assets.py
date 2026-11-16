#!/usr/bin/env python3
"""
Builds every logo and icon file AERONEX uses from the two master artworks in
brand/:

  brand/AERONEX_App_Icon.png      the app icon (cream tile, orange rim, on black)
  brand/AERONEX_Primary_Logo.jpg  the primary logo (A mark and wordmark, on cream)

Run it again whenever either changes:

    python3 scripts/brand-assets.py            (add --preview for check images)

What it makes:
  public/icon-512.png, icon-192.png       the app icon, corners transparent
  public/icon-maskable-512.png            full-bleed, logo inside Android's safe circle
  public/apple-touch-icon.png             full-bleed 180 px for iOS (which rounds it)
  public/favicon.ico, favicon-16/32/48.png  the mark tile: the icon's tile and rim with
                                          just the A mark (its words can't be read at tab size)
  public/social-card.png                  1200x630 link preview
  src/assets/brand/mark-tile.png          the mark tile, for the app's top-left corner
  src/assets/brand/logo.webp              the primary logo, background removed, for About

Backgrounds are taken off with "colour to alpha" against a smooth estimate of
the background, so soft shadows and highlights survive as partial
transparency: on the app's ivory page the logo looks exactly as drawn.
"""
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "brand"
PUBLIC = ROOT / "public"
ASSETS = ROOT / "src" / "assets" / "brand"
PAPER = (246, 243, 236)  # the app's page colour (--paper)


def load(name):
    return np.asarray(Image.open(SRC / name).convert("RGB")).astype(np.float64)


def fit(im, size):
    """Downscale in steps (sharper than one big jump), premultiplied so edges keep their colour."""
    w, h = size
    if im.mode == "RGBA":
        a = np.asarray(im).astype(np.float64)
        a[..., :3] *= a[..., 3:4] / 255
        im = Image.fromarray(a.round().astype(np.uint8), "RGBA")
    while im.width > 2 * w:
        im = im.resize((im.width // 2, im.height // 2), Image.LANCZOS)
    im = im.resize((w, h), Image.LANCZOS)
    if im.mode == "RGBA":
        a = np.asarray(im).astype(np.float64)
        al = np.maximum(a[..., 3:4], 1e-6)
        a[..., :3] = np.where(a[..., 3:4] > 0, a[..., :3] * 255 / al, 0)
        im = Image.fromarray(np.clip(a, 0, 255).round().astype(np.uint8), "RGBA")
    return im


def estimate_background(rgb, keep, sigma):
    """
    A smooth background from the pixels in `keep`, filled in under everything
    else; far from any kept pixel it falls back to their median.
    """
    w = keep.astype(np.float64)
    den = ndimage.gaussian_filter(w, sigma)
    base = np.median(rgb[keep], axis=0)
    eps = 1e-3
    out = np.empty_like(rgb)
    for c in range(3):
        out[..., c] = (ndimage.gaussian_filter(rgb[..., c] * w, sigma) + eps * base[c]) / (den + eps)
    return out


def color_to_alpha(rgb, bg):
    """The least-opaque colour that composites over `bg` to exactly `rgb` (GIMP's colour-to-alpha)."""
    d = rgb - bg
    up = np.where(d > 0, d / np.maximum(255 - bg, 1), 0)
    dn = np.where(d < 0, -d / np.maximum(bg, 1), 0)
    a = np.clip(np.max(np.maximum(up, dn), axis=2), 0, 1)
    # Paper grain and JPEG noise, not artwork.
    a = np.clip((a - 0.02) / 0.98, 0, 1)
    col = np.clip(bg + d / np.maximum(a[..., None], 1e-6), 0, 255)
    return np.dstack([col, a * 255])


def crop_to_alpha(rgba, pad):
    ys, xs = np.nonzero(rgba[..., 3] > 6)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    return rgba[max(0, y0 - pad) : y1 + pad, max(0, x0 - pad) : x1 + pad]


def on_canvas(rgba, size, scale, fill=None, dy=0.0):
    """Centre artwork on a square canvas, its longer side `scale` of the canvas."""
    im = Image.fromarray(np.clip(rgba, 0, 255).round().astype(np.uint8), "RGBA")
    s = scale * size / max(im.size)
    im = fit(im, (max(1, round(im.width * s)), max(1, round(im.height * s))))
    canvas = Image.new("RGBA", (size, size), (*fill, 255) if fill else (0, 0, 0, 0))
    canvas.alpha_composite(im, ((size - im.width) // 2, round((size - im.height) / 2 + dy * size)))
    return canvas


# ---------------------------------------------------------------- the primary logo
logo_rgb = load("AERONEX_Primary_Logo.jpg")
border = np.concatenate([logo_rgb[:8].reshape(-1, 3), logo_rgb[-8:].reshape(-1, 3), logo_rgb[:, :8].reshape(-1, 3), logo_rgb[:, -8:].reshape(-1, 3)])
bg0 = np.broadcast_to(np.median(border, axis=0), logo_rgb.shape)
diff = np.max(np.abs(logo_rgb - bg0), axis=2)
# The artwork: every region that differs from the paper and somewhere differs
# strongly. The paper's embossed grain differs by at most ~60, artwork by 250,
# so this keeps each letter of the tagline and drops all the grain.
lab, n = ndimage.label(diff > 30)
peak = ndimage.maximum(diff, lab, range(1, n + 1))
art = np.isin(lab, 1 + np.nonzero(peak > 100)[0])
art_soft = ndimage.gaussian_filter(ndimage.binary_dilation(art, iterations=3).astype(np.float64), 1.5)
logo_bg = estimate_background(logo_rgb, ~ndimage.binary_dilation(art, iterations=30), sigma=40)
logo = color_to_alpha(logo_rgb, logo_bg)
logo[..., 3] *= art_soft
logo = crop_to_alpha(logo, pad=16)

# The mark alone: the A, its swoosh and the drone, above the wordmark (cut at
# the thinnest row between them).
prof = (logo[..., 3] > 90).sum(axis=1)
lo, hi = int(len(logo) * 0.55), int(len(logo) * 0.75)
cut = lo + int(np.argmin(prof[lo:hi]))
logo_mark = crop_to_alpha(logo[:cut], pad=6)

# ---------------------------------------------------------------- the app icon
icon_rgb = load("AERONEX_App_Icon.png")
# Outside the tile is black: the region of near-black joined to the corners.
dark = np.max(icon_rgb, axis=2) < 40
lab, _ = ndimage.label(dark)
corners = {lab[0, 0], lab[0, -1], lab[-1, 0], lab[-1, -1]} - {0}
outside = np.isin(lab, list(corners))
edge = ndimage.binary_dilation(outside, iterations=4) & ~outside
alpha = np.ones(icon_rgb.shape[:2])
alpha[outside] = 0
# The anti-aliased rim: un-premultiply from black.
rim = np.clip(np.max(icon_rgb, axis=2) / 245, 0, 1)
alpha[edge] = rim[edge]
col = np.where(edge[..., None], np.clip(icon_rgb / np.maximum(alpha[..., None], 1e-6), 0, 255), icon_rgb)
icon = crop_to_alpha(np.dstack([col, alpha * 255]), pad=0)
h, w = icon.shape[:2]
side = max(h, w)
sq = np.zeros((side, side, 4))
sq[(side - h) // 2 : (side - h) // 2 + h, (side - w) // 2 : (side - w) // 2 + w] = icon
icon = sq

# The mark tile, for sizes where the icon's words could not be read: the
# icon's own rounded tile and glossy orange rim, drawn afresh, with the A mark
# from the primary logo (cleaner and larger than the icon's) in the middle.
def mark_tile(S=1024, rim=0.05, mark_w=0.80):
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float64) + 0.5
    r = 0.225 * S
    def rounded(inset, rad):
        # Signed distance to a rounded square inset by `inset` pixels.
        half = S / 2 - inset
        qx = np.abs(xx - S / 2) - (half - rad)
        qy = np.abs(yy - S / 2) - (half - rad)
        return np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - rad
    outer = np.clip(0.5 - rounded(0, r), 0, 1)
    w = rim * S
    inner_d = rounded(w, r - w)
    inner = np.clip(0.5 - inner_d, 0, 1)
    t = (xx + yy) / (2 * S)
    # Rim: glossy orange, lighter at the top left (as the icon's).
    rim_col = np.dstack([np.full_like(t, 255), 172 - 70 * t, 22 - 20 * t])
    gloss = np.exp(-(((xx - 0.30 * S) ** 2 + (yy - 0.10 * S) ** 2) / (0.35 * S) ** 2))
    rim_col = rim_col + (np.array([255, 236, 170]) - rim_col) * (0.55 * gloss)[..., None]
    # Face: the icon's cream, warmer towards the rim like its inner shadow.
    depth = np.clip(-inner_d / (0.09 * S), 0, 1)[..., None]
    face_col = np.array([236, 211, 196]) + (np.array([253, 245, 238]) - np.array([236, 211, 196])) * np.sqrt(depth)
    col = rim_col * (1 - inner[..., None]) + face_col * inner[..., None]
    tile = Image.fromarray(np.dstack([col, outer * 255]).round().clip(0, 255).astype(np.uint8), "RGBA")
    m = Image.fromarray(np.clip(logo_mark, 0, 255).round().astype(np.uint8), "RGBA")
    s = mark_w * S / m.width
    m = fit(m, (round(m.width * s), round(m.height * s)))
    tile.alpha_composite(m, ((S - m.width) // 2, (S - m.height) // 2 + round(0.015 * S)))
    return tile

tile = mark_tile()
# At tab size the rim is thickened and the mark enlarged, so both still read.
tile_small = mark_tile(rim=0.075, mark_w=0.88)
face = ndimage.binary_erosion(icon[..., 3] > 250, iterations=80)
cream_fill = tuple(int(v) for v in np.median(icon[..., :3][face & (np.max(icon[..., :3], axis=2) > 240) & (np.min(icon[..., :3], axis=2) > 225)], axis=0))

# ---------------------------------------------------------------- write
icon_im = Image.fromarray(np.clip(icon, 0, 255).round().astype(np.uint8), "RGBA")
for n in (512, 192):
    fit(icon_im, (n, n)).save(PUBLIC / f"icon-{n}.png", optimize=True)

on_canvas(logo, 512, 0.66, fill=cream_fill).save(PUBLIC / "icon-maskable-512.png", optimize=True)
on_canvas(logo, 180, 0.86, fill=cream_fill).convert("RGB").save(PUBLIC / "apple-touch-icon.png", optimize=True)

for n in (16, 32, 48):
    fit(tile_small if n < 48 else tile, (n, n)).save(PUBLIC / f"favicon-{n}.png", optimize=True)
ico = [fit(tile_small, (16, 16)), fit(tile_small, (32, 32)), fit(tile, (48, 48)), fit(tile, (64, 64))]
ico[-1].save(PUBLIC / "favicon.ico", sizes=[i.size for i in ico], append_images=ico[:-1])
fit(tile_small, (192, 192)).save(ASSETS / "mark-tile.png", optimize=True)

logo_im = Image.fromarray(np.clip(logo, 0, 255).round().astype(np.uint8), "RGBA")
fit(logo_im, (960, round(960 * logo_im.height / logo_im.width))).save(ASSETS / "logo.webp", quality=90, method=6)

social = Image.new("RGBA", (1200, 630), (*PAPER, 255))
art = fit(logo_im, (round(560 * logo_im.width / logo_im.height), 560))
social.alpha_composite(art, ((1200 - art.width) // 2, (630 - art.height) // 2))
social.convert("RGB").save(PUBLIC / "social-card.png", optimize=True)

# With --preview, composites for checking by eye (not committed).
import sys
if "--preview" not in sys.argv:
    print("logo", logo_im.size, "mark tile", tile.size, "icon", icon_im.size, "cream", cream_fill)
    sys.exit(0)
prev = Path("/tmp/aeronex-brand-preview")
prev.mkdir(exist_ok=True)
for name, im, bgc in [("tile-on-paper", fit(tile, (256, 256)), PAPER), ("logo-on-paper", fit(logo_im, (900, round(900 * logo_im.height / logo_im.width))), PAPER), ("logo-on-white", fit(logo_im, (900, round(900 * logo_im.height / logo_im.width))), (255, 255, 255)), ("icon-on-dark", fit(icon_im, (256, 256)), (24, 28, 36))]:
    c = Image.new("RGBA", (im.width + 40, im.height + 40), (*bgc, 255))
    c.alpha_composite(im, (20, 20))
    c.convert("RGB").save(prev / f"{name}.png")
print("logo", logo_im.size, "mark tile", tile.size, "icon", icon_im.size, "cream", cream_fill)
