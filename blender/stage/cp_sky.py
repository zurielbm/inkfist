"""Cloud Peak SKY layer (opaque): graded paper wash, faint wet cloud wisps, faded crimson sun,
a few distant birds.  The lower band is exactly MIST so it matches the opaque cloud sea and the
fogged bases of the far/mid layers."""
import math

import numpy as np

import inklib as ik
from inklib import F32, blur, gnoise, fbm, smoothstep, clamp01, rng
import cp_layout as lay

SUN = dict(x=9.0, y=12.2, r=2.7)


def sky_layer():
    name = "sky"
    L = lay.LAYERS[name]
    w, h = L["size"]
    ppm = lay.px_per_m(name)
    yrow = lay.row_grid_y(name)[:, None] * np.ones((1, w), F32)
    xcol = lay.col_grid_x(name)[None, :] * np.ones((h, 1), F32)
    g = ik.granulation(h, w, 3, fine=1.4, clump=5.0, mix=0.7)
    wob = fbm(h, w, 220.0, 4, seed=4, aniso=3.0)
    cv = ik.Canvas(h, w, ik.MIST, 1.0)
    # graded wash from the top: warm grey, smooth and uneven only at large scale
    yb = 8.0 + 2.0 * gnoise(h, w, 260.0, 60.0, seed=11)
    grad = smoothstep(yb, yb + 24.0, yrow)
    d = 0.14 * grad * (1 + 0.22 * wob)
    d = ik.granulate(d, g, 0.10, dense=0.0)
    cv.over(ik.WASH, clamp01(d))
    # broad soft blooms with faint dried rims in the upper sky
    for i, (cx, cy, rx, ry, a) in enumerate([(-30, 27, 24, 6, 0.045), (26, 29, 28, 5, 0.04)]):
        m = np.exp(-(((xcol - cx) / rx) ** 2 + ((yrow - cy) / ry) ** 2) ** 1.5)
        m = ik.wash_shape(m, 20 + i, warp_amp=22, warp_sigma=60, soft=6, edge=0.45, jitter=0.0)
        dd = ik.edge_darken(a * m, 4.0, 0.8)
        cv.over(ik.WASH, clamp01(dd))
    # long horizontal cloud wisps (wet-in-wet, slightly cool, soft edges)
    wisps = [(-24, 17.5, 26, 0.9, 0.06), (-38, 21.5, 14, 0.7, 0.045), (18, 19.8, 20, 0.8, 0.05),
             (36, 15.5, 16, 0.6, 0.04), (2, 23.5, 18, 0.6, 0.035), (14, 10.6, 12, 0.4, 0.04)]
    for i, (cx, cy, hl, th, a) in enumerate(wisps):
        n = gnoise(h, w, 50.0, 8.0, seed=40 + i)
        core = np.exp(-((yrow - cy - 0.6 * n * th) / th) ** 2)
        span = smoothstep(cx - hl, cx - hl * 0.3, xcol) * (1 - smoothstep(cx + hl * 0.3,
                                                                          cx + hl, xcol))
        streak = clamp01(0.55 + 0.6 * gnoise(h, w, 90.0, 3.0, seed=60 + i))
        m = blur(core * span * streak, 3.0, 1.5)
        dd = a * m * 1.6
        dd = dd + 0.5 * a * clamp01(m - blur(m, 4.0)) * 3.0     # faint pigment rim
        cv.over(ik.COOL_INK, clamp01(dd))
    # faded crimson sun: transparent glaze, pigment pooled at the rim, lifted by a cloud band
    sx, sy = lay.to_px(name, SUN["x"], SUN["y"])
    R = SUN["r"] * ppm
    xx, yy = ik.grid(h, w)
    rad = np.hypot(xx - sx, yy - sy)
    edge_n = 1.0 + 0.006 * gnoise(h, w, 10.0, seed=81)
    disc = smoothstep(R * edge_n + 1.0, R * edge_n - 1.0, rad)
    inner = 0.64 + 0.12 * smoothstep(0.3 * R, R, rad) + 0.05 * gnoise(h, w, 16.0, seed=83)
    ds = disc * inner
    ds = ik.edge_darken(ds, 2.5, 0.25)
    ds = ik.granulate(ds, g, 0.12, dense=0.04)
    band = np.exp(-((yy - (sy + 0.30 * R) - 0.04 * R * gnoise(h, w, 40, 4, seed=84)) /
                    (0.10 * R)) ** 2)
    band2 = np.exp(-((yy - (sy + 0.60 * R)) / (0.05 * R)) ** 2) * 0.6
    lift = 1 - 0.5 * clamp01(band + band2) * clamp01(0.75 + 0.4 * gnoise(h, w, 30, 3, seed=85))
    glow = 0.06 * np.exp(-((rad / (R * 2.0)) ** 2)) * (1 - disc)
    cv.multiply(ik.CRIMSON, clamp01(glow))
    cv.multiply(ik.CRIMSON, clamp01(ds * lift))
    # distant birds near the sun
    birds = []
    r = rng(90)
    for (bx, by, s) in [(-6.5, 14.2, 0.62), (-5.2, 15.0, 0.5), (-4.2, 14.4, 0.55),
                        (-7.9, 15.4, 0.4)]:
        px, py = lay.to_px(name, bx, by)
        S = s * ppm
        for side in (-1, 1):
            t = np.linspace(0, 1, 10)
            pts = np.stack([px + side * S * t, py - S * 0.35 * np.sin(np.pi * t * 0.9) + S *
                            0.25 * t ** 2], -1)
            birds.append((pts, np.linspace(0.18 * S, 0.04 * S, 10)))
    sd = ik.render_strokes(birds, w, h, samples=24, name="sky_birds")
    cv.over(ik.INK2, clamp01(0.8 * sd["a"]))
    out = cv.rgb
    ik.save_image(out, lay.out_dir() + "/sky.webp", 85)
    ik.save_image(out, ik.WORK + "/prev_sky.png")
    return out
