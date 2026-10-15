"""Build INKFIST shared textures (game/public/assets/tex/).

Run headless:
  "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup \
      -P blender/tex/build_textures.py -- [--only paper,splat,crater,cracks,speedlines,brush_stroke,enso,mist]

Everything is deterministic (fixed seeds).  Brush strokes / cracks / fibres are built as ribbon
meshes and rasterised by Cycles (render_strokes); watercolour behaviour (edge darkening,
granulation, bleed, dry brush) is numpy post-processing inside Blender's Python.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "stage"))
sys.path.insert(0, HERE)

import numpy as np  # noqa: E402
import inklib as ik  # noqa: E402
from inklib import F32, blur, gnoise, fbm, smoothstep, clamp01, rng  # noqa: E402

OUT = os.path.normpath(os.path.join(HERE, "..", "..", "game", "public", "assets", "tex"))
Q = 85


def white_alpha(alpha):
    """Tintable convention: RGB white, alpha = ink."""
    h, w = alpha.shape
    out = np.ones((h, w, 4), F32)
    out[..., 3] = clamp01(alpha)
    return out


def ink_finish(ink, seed, *, edge=0.35, edge_sigma=2.0, gran=0.18, bleed_sigma=1.6,
               bleed_amt=0.25, wrap=False):
    """Common ink look for a deposit map: soft wet halo, edge pooling and granulation."""
    h, w = ink.shape
    d = ik.bleed(ink, bleed_sigma, bleed_amt, wrap, wrap)
    d = ik.edge_darken(d, edge_sigma, edge, wrap, wrap)
    g = ik.granulation(h, w, seed, wrap, wrap)
    d = ik.granulate(d, g, gran)
    return clamp01(d)


# --------------------------------------------------------------------------------------------
# brush stroke (1024 x 160)
# --------------------------------------------------------------------------------------------
def brush_stroke():
    W, H = 1024, 160
    r = rng(11)
    n = 400
    path = ik.wobble_path((58, 84), (978, 78), n, 3.0, seed=12, freq=1.2)
    t = np.linspace(0, 1, n)
    path[:, 1] += -6 * np.sin(np.pi * t)            # slight arc
    wid = ik.taper(n, 108, start=0.05, end=0.30, start_w=0.62, end_w=0.30, power=0.6)
    wid *= 1 + 0.05 * np.sin(2 * np.pi * (t * 3.1 + 0.2)) + 0.03 * np.sin(2 * np.pi * t * 7.3)
    path, wid = ik.cap_start(path, wid, m=14, bulge=1.0)
    strokes = [(path, wid)]
    # split bristles trailing off the dry end
    for k in range(7):
        s0 = int(n * r.uniform(0.80, 0.9))
        off = r.uniform(-38, 38)
        p = path[s0:].copy()
        p[:, 1] += off * np.linspace(0.6, 1.0, len(p))
        ext = np.linspace(0, r.uniform(8, 26), len(p))
        p[:, 0] += ext
        ww = np.linspace(r.uniform(3, 7), 0.3, len(p))
        strokes.append((p, ww))
    sd = ik.render_strokes(strokes, W, H, samples=32, name="brush")
    main = sd["idx"] == 0
    ink = ik.dry_brush(sd, seed=5, bristles=80, along=90, dry_start=0.42, dry_end=1.0,
                       dryness=0.95, base_load=0.55, edge_dry=0.45, soft=0.07,
                       wet_start=0.8)
    # sparse flying-white gaps in the body too
    body_gaps = ik.dry_brush(sd, seed=9, bristles=55, along=140, dry_start=0.0, dry_end=0.4,
                             dryness=0.25, base_load=0.25, edge_dry=0.3, soft=0.08)
    ink = np.where(main, np.minimum(ink, 0.35 + 0.65 * body_gaps / np.maximum(sd["a"], 1e-3)
                                    * sd["a"]), ink)
    # wet pooling at the heavy start
    tnorm = sd["arc"] / sd["lengths"][np.clip(sd["idx"], 0, None)]
    pool = (1 + 0.35 * np.abs(sd["v"]) ** 4) * (1 - 0.12 * smoothstep(0.0, 0.5, tnorm))
    ink = ink * np.where(main, pool, 1.0)
    d = ink_finish(ink, 21, edge=0.25, gran=0.12)
    ik.save_image(white_alpha(d), os.path.join(OUT, "brush_stroke.webp"), Q)
    return d


# --------------------------------------------------------------------------------------------
# enso (512 x 512)
# --------------------------------------------------------------------------------------------
def enso():
    S = 512
    n = 700
    th0, sweep = math.radians(236), math.radians(-332)
    t = np.linspace(0, 1, n)
    th = th0 + sweep * (t + 0.04 * t * t)
    r = rng(31)
    rad = 186 + 6 * np.sin(2 * np.pi * (t * 1.3 + 0.1)) - 10 * t
    cx, cy = 256, 258
    x = cx + rad * np.cos(th) * 1.02
    y = cy - rad * np.sin(th)
    path = np.stack([x, y], -1)
    wid = ik.taper(n, 52, start=0.03, end=0.42, start_w=0.7, end_w=0.18, power=0.7)
    wid *= 1 + 0.08 * np.sin(2 * np.pi * t * 2.2 + 1.0)
    cpath, cwid = ik.cap_start(path, wid, m=12)
    strokes = [(cpath, cwid)]
    for k in range(5):
        s0 = int(n * r.uniform(0.84, 0.93))
        p = path[s0:].copy()
        th_k = th[s0:]
        off = r.uniform(-14, 14)
        p[:, 0] += off * np.cos(th_k) * np.linspace(0.3, 1, len(p))
        p[:, 1] -= off * np.sin(th_k) * np.linspace(0.3, 1, len(p))
        strokes.append((p, np.linspace(r.uniform(2, 4.5), 0.3, len(p))))
    sd = ik.render_strokes(strokes, S, S, samples=32, name="enso")
    ink = ik.dry_brush(sd, seed=33, bristles=60, along=70, dry_start=0.45, dry_end=1.0,
                       dryness=1.0, base_load=0.5, edge_dry=0.5, soft=0.08,
                       wet_start=0.8)
    main = sd["idx"] == 0
    tnorm = sd["arc"] / sd["lengths"][np.clip(sd["idx"], 0, None)]
    ink = ink * np.where(main, (1 + 0.3 * np.abs(sd["v"]) ** 4) * (1 - 0.15 * tnorm), 1.0)
    d = ink_finish(ink, 34, edge=0.3, gran=0.15)
    ik.save_image(white_alpha(d), os.path.join(OUT, "enso.webp"), Q)
    return d


import tex_gen as tg  # noqa: E402

BUILDERS = {
    "paper": lambda: tg.paper(OUT, 95),           # q95: ~100 KB, edge mismatch < 1/255
    "splat": lambda: tg.splats(OUT, Q),
    "crater": lambda: tg.crater(OUT, Q),
    "cracks": lambda: tg.cracks(OUT, Q),
    "speedlines": lambda: tg.speedlines(OUT, Q),
    "brush_stroke": brush_stroke,
    "enso": enso,
    "mist": lambda: tg.mist(OUT, Q),
}


PREVIEW_DIR = os.path.join(HERE, "_work")


def preview(name):
    """Composite a written texture onto paper for visual review (_work/prev_<name>.png)."""
    path = os.path.join(OUT, name + ".webp")
    if not os.path.exists(path):
        return
    img = ik.load_image(path)
    a = img[..., 3:4]
    tint = ik.INK if img[..., :3].mean() > 0.97 else None
    rgb = img[..., :3] if tint is None else np.broadcast_to(tint, img[..., :3].shape)
    if name == "mist":
        rgb = img[..., :3]
        bg = np.broadcast_to(ik.WASH, rgb.shape)
    else:
        bg = np.broadcast_to(ik.PAPER, rgb.shape)
    out = rgb * a + bg * (1 - a)
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    ik.save_image(out, os.path.join(PREVIEW_DIR, f"prev_{name}.png"))


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    only = None
    if "--only" in argv:
        only = argv[argv.index("--only") + 1].split(",")
    os.makedirs(OUT, exist_ok=True)
    for name, fn in BUILDERS.items():
        if only and name not in only:
            continue
        ik.log("== texture", name)
        fn()
        if "--preview" in argv:
            outs = [f"splat_{i}" for i in range(4)] if name == "splat" else [name]
            for o in outs:
                preview(o)


if __name__ == "__main__":
    main()
