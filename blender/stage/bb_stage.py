"""Bamboo Grove (竹林 / 죽림) stage: moonlit wash sky, distant pale bamboo and hills, a misty
bamboo grove (mid), dark framing bamboo (near), and a tileable forest-floor path.

Bamboo is a brush subject: stalk segments are 'bone' strokes (pressed at both ends, pigment
pooled at the edges), node marks are short dark strokes, leaves are tapered strokes grouped in
个/介 clusters on thin twigs.  All strokes are ribbon meshes rasterised by Cycles; the ink
behaviour is numpy (dry brush, edge darkening, granulation, mist)."""
import math

import numpy as np

import inklib as ik
from inklib import F32, blur, gnoise, fbm, smoothstep, clamp01, rng
import cp_layout as lay

STAGE = "bamboo"
EYE_Y = lay.EYE[1]
MOON = dict(x=-11.0, y=13.6, r=2.6)
MOON_COL = ik.hexc("#f5efe2")
LEAF_PROF = np.array([0.15, 0.62, 0.92, 1.0, 0.92, 0.78, 0.62, 0.46, 0.3, 0.14, 0.02])


# --------------------------------------------------------------------------------------------
# bamboo stroke geometry (pixel space of a layer)
# --------------------------------------------------------------------------------------------
def leaf(p0, ang, L, W, r):
    t = np.linspace(0, 1, len(LEAF_PROF))
    d = np.array([math.cos(ang), math.sin(ang)])
    n = np.array([-d[1], d[0]])
    bend = r.normal(0, 0.07) * L
    pts = p0[None] + d[None] * (L * t)[:, None] + n[None] * (bend * np.sin(np.pi * t))[:, None]
    return pts, W * LEAF_PROF


def leaf_cluster(p, base_ang, L, W, r, n=None):
    """个 / 介 style cluster of 3-5 leaves radiating from p."""
    n = n or r.integers(3, 6)
    spread = r.uniform(0.28, 0.45)
    out = []
    for k in range(n):
        a = base_ang + (k - (n - 1) / 2) * spread + r.normal(0, 0.08)
        ll = L * r.uniform(0.75, 1.1) * (1.0 if k != (n - 1) // 2 else 1.12)
        out.append(leaf(p, a, ll, W * r.uniform(0.85, 1.1), r))
    return out


def stalk(to_px, ppm, x, y0, y1, width_m, lean, seed, leaves=True, leaf_scale=1.0,
          leaf_from=0.45, droop=1.0):
    """One bamboo stalk from (x, y0) to y1 (layer metres).  Returns dict of stroke lists."""
    r = rng(seed)
    W = width_m * ppm
    bx, by = to_px(x, y0)
    tx, ty = to_px(x + lean, y1)
    H = by - ty
    bow = r.normal(0, 0.025) * H
    segs, nodes, twigs, lv = [], [], [], []
    s = 0.0
    k = 0
    while s < H - 4:
        seg = W * r.uniform(5.5, 8.0) * (0.75 + 0.5 * math.sin(math.pi * min(s / H, 1.0)))
        e = min(s + seg, H)
        gap = max(1.2, W * 0.12)
        t0, t1 = (s + gap / 2) / H, (e - gap / 2) / H
        tt = np.linspace(t0, t1, 10)
        xs = bx + (tx - bx) * tt + bow * np.sin(np.pi * tt)
        ys = by - H * tt
        u = np.linspace(-1, 1, 10)
        wd = W * (1 - 0.06 * (s / H)) * (1 + 0.16 * np.abs(u) ** 6)
        segs.append((np.stack([xs, ys], -1), wd))
        if e < H - 2:
            te = e / H
            nx = bx + (tx - bx) * te + bow * math.sin(math.pi * te)
            ny = by - H * te
            sm = r.choice([-1, 1]) * W * 0.12
            q = np.array([[nx - W * 0.62, ny + sm * 0.3], [nx - W * 0.2, ny - sm * 0.2],
                          [nx + W * 0.2, ny - sm * 0.2], [nx + W * 0.62, ny + sm * 0.3]])
            nodes.append((q, np.array([0.18, 0.32, 0.32, 0.12]) * W + 0.6))
            # twigs and leaves on the upper part
            if leaves and te > leaf_from and r.random() < 0.55:
                side = r.choice([-1, 1])
                tw_len = ppm * r.uniform(0.25, 0.55) * leaf_scale
                a = -math.pi / 2 + side * r.uniform(0.5, 1.1)
                p0 = np.array([nx + side * W * 0.4, ny])
                pts = [p0]
                for j in range(5):
                    a += r.normal(0, 0.12)
                    pts.append(pts[-1] + tw_len / 5 * np.array([math.cos(a), math.sin(a)]))
                pts = np.array(pts)
                twigs.append((pts, np.linspace(max(1.0, W * 0.14), 0.5, len(pts))))
                L = ppm * r.uniform(0.30, 0.48) * leaf_scale
                LW = L * r.uniform(0.11, 0.15)
                base = math.pi / 2 - side * r.uniform(0.6, 1.2) * droop      # droop downward
                lv += leaf_cluster(pts[-1], base, L, LW, r)
                if r.random() < 0.6:
                    lv += leaf_cluster(pts[len(pts) // 2], base + side * 0.3, L * 0.85, LW, r,
                                       n=r.integers(2, 4))
        s = e
        k += 1
    return dict(segs=segs, nodes=nodes, twigs=twigs, leaves=lv)


def paint_bamboo_row(cv, rows_strokes, w, h, *, tone, leaf_tone, fog, seed, name, dry=0.35,
                     color=None):
    """Render one depth row of bamboo and paint it (ink over the canvas, multiplied by fog)."""
    color = ik.INK if color is None else color
    segs, nodes, twigs, leaves = [], [], [], []
    for st in rows_strokes:
        segs += st["segs"]
        nodes += st["nodes"]
        twigs += st["twigs"]
        leaves += st["leaves"]
    strokes = segs + nodes + twigs + leaves
    if not strokes:
        return
    n0, n1, n2 = len(segs), len(segs) + len(nodes), len(segs) + len(nodes) + len(twigs)
    sd = ik.render_strokes(strokes, w, h, samples=16, name=name)
    idx = sd["idx"]
    a = sd["a"]
    v = sd["v"]
    is_seg = ((idx >= 0) & (idx < n0)).astype(F32)
    is_node = ((idx >= n0) & (idx < n1)).astype(F32)
    is_twig = ((idx >= n1) & (idx < n2)).astype(F32)
    is_leaf = (idx >= n2).astype(F32)
    g = ik.granulation(h, w, seed, fine=1.0, clump=3.0)
    dryb = ik.dry_brush(sd, seed=seed + 1, bristles=16, along=60, dry_start=0.0, dry_end=1.0,
                        dryness=dry, base_load=0.25, edge_dry=0.0, soft=0.12)
    stalk_d = tone * (0.62 + 0.38 * np.abs(v) ** 2) * (0.75 + 0.25 * dryb / np.maximum(a, 1e-3))
    stalk_d = stalk_d * a * is_seg
    stalk_d = ik.granulate(stalk_d, g, 0.3)
    per = rng(seed + 2).uniform(0.7, 1.15, len(strokes) + 1)
    pl = np.where(idx >= 0, per[np.clip(idx, 0, len(strokes))], 1.0).astype(F32)
    leaf_d = leaf_tone * pl * a * is_leaf
    leaf_d = ik.edge_darken(ik.bleed(leaf_d, 1.2, 0.2), 1.2, 0.4)
    d = stalk_d + min(1.0, tone * 1.5 + 0.1) * a * is_node + leaf_tone * 0.9 * a * is_twig + leaf_d
    cv.over(color, clamp01(d * fog))


# --------------------------------------------------------------------------------------------
# layers
# --------------------------------------------------------------------------------------------
def moon_clearing(name, q_dist, radius):
    """Negative space around the moon's line of sight on a layer at distance q_dist."""
    w, h, yrow, xcol = layer_grids(name)
    mx = MOON["x"] * q_dist / 70
    my = EYE_Y + (MOON["y"] - EYE_Y) * q_dist / 70
    d = np.hypot(xcol - mx, yrow - my) / radius
    d = d + 0.12 * gnoise(h, w, 30.0, seed=5)
    return (1 - 0.92 * smoothstep(1.0, 0.45, d)).astype(F32)


def _finish(cv, name):
    rgb = ik.dilate_rgb(cv.rgb, cv.a, fallback=ik.MIST)
    out = np.concatenate([rgb, cv.a[..., None]], -1)
    ik.save_image(out, lay.out_dir(STAGE) + f"/{name}.webp", 85)
    prev = rgb * cv.a[..., None] + ik.MIST * (1 - cv.a[..., None])
    ik.save_image(prev, ik.WORK + f"/bb_prev_{name}.png")


def layer_grids(name):
    L = lay.LAYERS[name]
    w, h = L["size"]
    yrow = lay.row_grid_y(name)[:, None] * np.ones((1, w), F32)
    xcol = lay.col_grid_x(name)[None, :] * np.ones((h, 1), F32)
    return w, h, yrow, xcol


def sky_layer():
    name = "sky"
    w, h, yrow, xcol = layer_grids(name)
    ppm = lay.px_per_m(name)
    g = ik.granulation(h, w, 3, fine=1.4, clump=5.0, mix=0.7)
    wob = fbm(h, w, 220.0, 4, seed=4, aniso=3.0)
    cv = ik.Canvas(h, w, ik.MIST, 1.0)
    yb = 3.5 + 2.0 * gnoise(h, w, 260.0, 60.0, seed=11)
    grad = smoothstep(yb, yb + 16.0, yrow)
    cv.over(ik.COOL_INK, clamp01(ik.granulate(0.58 * grad ** 0.75 * (1 + 0.15 * wob), g, 0.12,
                                              dense=0.0)))
    # moon: lifted paper disc with a soft halo and two thin cloud bars across it
    mx, my = lay.to_px(name, MOON["x"], MOON["y"])
    R = MOON["r"] * ppm
    xx, yy = ik.grid(h, w)
    rad = np.hypot(xx - mx, yy - my)
    halo = np.exp(-((rad / (R * 4.0)) ** 2)) * 0.6 + np.exp(-((rad / (R * 1.8)) ** 2)) * 0.45
    cv.over(ik.MIST, clamp01(halo))
    disc = smoothstep(R + 1.2, R - 1.2, rad * (1 + 0.004 * gnoise(h, w, 8.0, seed=12)))
    cv.over(MOON_COL, clamp01(disc * 0.97))
    shade = disc * smoothstep(0.2, 1.0, (xx - mx + (yy - my) * 0.3) / R) * 0.08
    cv.over(ik.WASH, clamp01(shade * (1 + 0.6 * gnoise(h, w, 10.0, seed=13))))
    for i, (dy_, th_, hl_, a_) in enumerate([(0.35, 0.10, 2.6, 0.30), (0.62, 0.06, 2.0, 0.22),
                                             (-0.15, 0.05, 1.6, 0.12)]):
        cy = my + dy_ * R
        n = gnoise(h, w, 40.0, 5.0, seed=20 + i)
        core = np.exp(-(((yy - cy) / (th_ * R)) - 0.8 * n) ** 2)
        span = np.exp(-(((xx - mx - 0.2 * R) / (hl_ * R)) ** 4))
        m = blur(core * span, 2.0, 1.0)
        cv.over(ik.COOL_INK, clamp01(a_ * m))
    # long wisps elsewhere
    for i, (cx, cy, hl, th, a) in enumerate([(14, 18.5, 22, 0.8, 0.07), (30, 14.0, 14, 0.5, 0.05),
                                             (-34, 19.0, 18, 0.7, 0.06)]):
        n = gnoise(h, w, 50.0, 8.0, seed=40 + i)
        core = np.exp(-((yrow - cy - 0.6 * n * th) / th) ** 2)
        span = smoothstep(cx - hl, cx - hl * 0.3, xcol) * (1 - smoothstep(cx + hl * 0.3, cx + hl,
                                                                          xcol))
        cv.over(ik.COOL_INK, clamp01(a * blur(core * span, 3.0, 1.5) * 1.6))
    out = cv.rgb
    ik.save_image(out, lay.out_dir(STAGE) + "/sky.webp", 85)
    ik.save_image(out, ik.WORK + "/bb_prev_sky.png")


def _row(to_px, ppm, xs, y0, y1, widths, seed, lean_sd=0.25, clear=None, **kw):
    """A depth row of stalks.  y1 = (min, max) top heights.  clear = (x, y, radius) keeps the
    line of sight to the moon open (stalks crossing that circle are shortened below it)."""
    r = rng(seed)
    out = []
    for i, x in enumerate(xs):
        top = r.uniform(*y1)
        lean = r.normal(0, lean_sd)
        if clear is not None:
            cx, cy, cr_ = clear
            if abs(x + lean * 0.5 - cx) < cr_:
                top = min(top, cy - cr_ * r.uniform(0.9, 1.6))
        out.append(stalk(to_px, ppm, x, y0 + r.uniform(-0.3, 0.0), top, r.uniform(*widths),
                         lean, seed * 100 + i, **kw))
    return out


def _spread(r, n, x0, x1, avoid=None, min_gap=0.4):
    xs = []
    tries = 0
    while len(xs) < n and tries < n * 50:
        tries += 1
        x = r.uniform(x0, x1)
        if avoid and abs(x) < avoid and r.random() < 0.85:
            continue
        if all(abs(x - q) > min_gap for q in xs):
            xs.append(x)
    return sorted(xs)


def far_layer():
    name = "far"
    w, h, yrow, xcol = layer_grids(name)
    ppm = lay.px_per_m(name)

    def to_px(x, y):
        return lay.to_px(name, x, y)

    cv = ik.Canvas(h, w, ik.MIST, 0.0)
    # distant hills: soft pale ridges
    import cp_ranges as cr
    for k, (base, tone, seed, peaks) in enumerate([
            (2.0, 0.26, 31, [(-30, 7.5, 10, 1.6), (-8, 6.0, 12, 1.4), (14, 7.2, 10, 1.5),
                             (36, 6.4, 10, 1.5)]),
            (1.5, 0.34, 32, [(-38, 5.6, 8, 1.6), (-20, 4.8, 9, 1.5), (4, 4.2, 9, 1.4),
                             (24, 5.2, 9, 1.5)])]):
        xs = lay.col_grid_x(name)
        crest = cr.crest_profile(xs, peaks, base, 0.15, seed)
        m = (yrow < crest[None, :]).astype(F32)
        m = ik.wash_shape(m, seed, warp_amp=2, warp_sigma=6, soft=1.0, edge=0.25)
        fog = smoothstep(base - 0.5, base + 3.5, yrow)
        d = ik.edge_darken(tone * m * (1 + 0.15 * fbm(h, w, 60.0, 3, seed=seed)), 2.0, 0.8)
        cv.over(ik.COOL_INK, clamp01(d * fog))
    # opaque ground mist (bottom)
    cv.over(ik.MIST, smoothstep(1.4, -0.6, yrow + 0.4 * gnoise(h, w, 60.0, 10.0, seed=33)))
    # distant bamboo: thin pale stalks with soft leaf masses
    r = rng(34)
    xs = _spread(r, 95, -40, 40, avoid=None, min_gap=0.4)
    mx = MOON["x"] * 50 / 70
    my = EYE_Y + (MOON["y"] - EYE_Y) * 50 / 70
    row = _row(to_px, ppm, xs, -0.5, (7.0, 15.0), (0.06, 0.12), 35, lean_sd=0.35,
               clear=(mx, my, 4.2), leaf_scale=1.6, leaf_from=0.4)
    fog = smoothstep(0.0, 6.0, yrow) * moon_clearing(name, 50.0, 5.0)
    paint_bamboo_row(cv, row, w, h, tone=0.16, leaf_tone=0.14, fog=fog, seed=36,
                     name="bb_far", dry=0.2, color=ik.COOL_INK)
    # soften the whole distant grove like wet-in-wet
    cv.a = clamp01(blur(cv.a, 0.8))
    _finish(cv, name)


def mid_layer():
    name = "mid"
    w, h, yrow, xcol = layer_grids(name)
    ppm = lay.px_per_m(name)

    def to_px(x, y):
        return lay.to_px(name, x, y)

    cv = ik.Canvas(h, w, ik.MIST, 0.0)
    r = rng(50)
    rows = [
        # (n stalks, width range m, tone, leaf tone, fog lo-hi, avoid centre, seed)
        (46, (0.10, 0.17), 0.20, 0.18, (1.0, 6.5), 4.0, 51),
        (28, (0.17, 0.26), 0.36, 0.34, (1.5, 6.0), 6.0, 52),
        (14, (0.26, 0.38), 0.62, 0.60, (2.0, 5.5), 8.5, 53),
    ]
    mx = MOON["x"] * 30 / 70
    my = EYE_Y + (MOON["y"] - EYE_Y) * 30 / 70
    for (n, wr, tone, lt, fg, avoid, seed) in rows:
        xs = _spread(r, n, -27, 27, avoid=avoid, min_gap=0.5)
        row = _row(to_px, ppm, xs, -1.0, (6.5, 15.5), wr, seed, lean_sd=0.6, leaf_scale=1.6,
                   leaf_from=0.3, clear=(mx, my, 2.6))
        fog = smoothstep(fg[0], fg[1], yrow)
        # centre (behind the fighters) is paler still
        fog = fog * (1 - 0.45 * np.exp(-(xcol / 7.0) ** 2) * (1 - smoothstep(4.0, 9.0, yrow)))
        fog = fog * moon_clearing(name, 30.0, 3.4)
        paint_bamboo_row(cv, row, w, h, tone=tone, leaf_tone=lt, fog=fog, seed=seed,
                         name=f"bb_mid{seed}")
        # mist between depth rows
        band = smoothstep(4.5, 0.5, yrow + 0.5 * gnoise(h, w, 80.0, 12.0, seed=seed + 5))
        cv.over(ik.MIST, clamp01(0.55 * band * cv.a))
    # ground mist: opaque at the bottom, soft billowy top
    top = 0.9 + 0.5 * gnoise(h, w, 90.0, 4.0, seed=58)
    cv.over(ik.MIST, smoothstep(top + 1.4, top - 0.8, yrow))
    _finish(cv, name)


def near_layer():
    name = "near"
    w, h, yrow, xcol = layer_grids(name)
    ppm = lay.px_per_m(name)

    def to_px(x, y):
        return lay.to_px(name, x, y)

    cv = ik.Canvas(h, w, ik.MIST, 0.0)
    r = rng(70)
    back = [(-16.4, 0.36, 0.25), (-12.6, 0.32, 0.2), (12.2, 0.34, -0.2), (16.8, 0.38, -0.3)]
    front = [(-17.4, 0.52, 0.5), (-14.8, 0.46, 0.75), (-10.8, 0.42, 1.05), (-9.2, 0.30, 1.6),
             (10.4, 0.44, -0.9), (14.2, 0.5, -0.55), (17.6, 0.46, -0.3)]
    for k, (stalks, tone, lt, sd) in enumerate([(back, 0.55, 0.5, 71), (front, 0.92, 0.88, 72)]):
        row = [stalk(to_px, ppm, x, -0.2, 12.2, wd, lean, sd * 100 + i, leaf_scale=1.0,
                     leaf_from=0.3, droop=0.9) for i, (x, wd, lean) in enumerate(stalks)]
        paint_bamboo_row(cv, row, w, h, tone=tone, leaf_tone=lt, fog=1.0, seed=sd,
                         name=f"bb_near{sd}")
    # big leaf sprays reaching into the top corners
    sprays = []
    for (x, y, side, n) in [(-9.4, 5.6, 1, 4), (-8.2, 6.4, 1, 3), (-10.6, 4.8, 1, 3),
                            (9.8, 5.9, -1, 4), (8.9, 6.7, -1, 3), (11.0, 5.0, -1, 3)]:
        px, py = to_px(x, y)
        for j in range(n):
            q = np.array([px + side * r.uniform(0, 80), py + r.uniform(-40, 40)])
            L = ppm * r.uniform(0.75, 1.05)
            base = math.pi / 2 - side * r.uniform(0.25, 0.9)
            sprays += [(pts, wd) for (pts, wd) in leaf_cluster(q, base, L, L * 0.13, r)]
    paint_bamboo_row(cv, [dict(segs=[], nodes=[], twigs=[], leaves=sprays)], w, h, tone=0.9,
                     leaf_tone=0.9, fog=1.0, seed=73, name="bb_near_sprays")
    # base: dark ink rocks / earth mounds and grass at the stalk feet
    mounds = np.zeros((h, w), F32)
    for (x0, x1, hh) in [(-18.5, -8.2, 0.9), (8.8, 18.5, 1.0)]:
        cx = (x0 + x1) / 2
        hw = (x1 - x0) / 2
        prof = hh * np.clip(1 - ((xcol - cx) / hw) ** 2, 0, 1) ** 0.6
        prof = prof * (1 + 0.25 * gnoise(h, w, 30.0, 200.0, seed=74))
        mounds = np.maximum(mounds, (yrow < prof - 0.05).astype(F32))
    mounds = ik.wash_shape(mounds, 75, warp_amp=4, warp_sigma=10, soft=1.2, edge=0.25)
    cv.over(ik.PAPER, mounds)
    g = ik.granulation(h, w, 76)
    cv.over(ik.INK2, clamp01(ik.granulate(0.55 * mounds * (1 + 0.3 * gnoise(h, w, 12.0,
                                                                            seed=77)), g, 0.4)))
    edge = clamp01((mounds - blur(mounds, 1.8)) * 3.0)
    cv.over(ik.INK, clamp01(edge))
    from cp_near import grass_tufts
    pts = []
    for x in list(np.linspace(-18, -8.6, 14)) + list(np.linspace(9.0, 18, 14)) + \
            [-6.2, -3.9, -1.4, 1.7, 4.3, 6.6]:
        c, rw = to_px(x + r.normal(0, 0.2), 0.02)
        pts.append((float(c), float(rw)))
    grass = grass_tufts(pts, ppm, 78, scale=1.2)
    sd = ik.render_strokes(grass, w, h, samples=16, name="bb_grass")
    cv.over(ik.INK2, clamp01(0.85 * sd["a"]))
    _finish(cv, name)


def floor_layer():
    """Forest-floor path: packed earth, flat stepping stones, fallen bamboo leaves, moss."""
    W, H = lay.FLOOR["size"]
    tile = lay.FLOOR["tileWidth"]
    depth = lay.FLOOR["zNear"] - lay.FLOOR["zFar"]
    ppm = W / tile
    DH = int(round(depth / 3.0 * ppm))
    r = rng(90)
    h, w = DH, W
    zw = lay.FLOOR["zFar"] + (np.arange(h)[:, None] + 0.5) / h * depth
    g = ik.granulation(h, w, 91, wrap_x=True, fine=1.1, clump=3.5, mix=0.6)
    cv = ik.Canvas(h, w, ik.hexc("#e4dac4"), 1.0)
    # patchy earth washes
    for i, (sig, thr, amt) in enumerate([(120, 0.2, 0.10), (50, 0.5, 0.10), (20, 0.9, 0.08)]):
        m = smoothstep(thr, thr + 0.8, fbm(h, w, sig, 4, seed=92 + i, wrap_x=True))
        m = ik.wash_shape(m, 95 + i, warp_amp=3, warp_sigma=8, soft=1.5, edge=0.3, wrap_x=True)
        cv.over(ik.WASH, clamp01(ik.granulate(ik.edge_darken(amt * m, 3.0, 1.0, wrap_x=True), g,
                                              0.5)))
    # stepping stones (rounded, outlined), a loose band along the fighting line
    polys = []
    for i in range(12):
        cx = r.uniform(0, W)
        cz = (r.uniform(-7.0, 7.0) - lay.FLOOR["zFar"]) / 3.0 * ppm
        rx, rz = r.uniform(0.22, 0.42) * ppm, r.uniform(0.18, 0.32) * ppm
        k = 28
        a = np.linspace(0, 2 * np.pi, k, endpoint=False)
        rr = 1 + 0.08 * np.sin(3 * a + r.uniform(0, 6)) + 0.05 * r.normal(size=k)
        polys.append(np.stack([cx + rx * rr * np.cos(a), cz + rz * rr * np.sin(a)], -1))
    sp = ik.render_strokes([], w, h, polys=polys, samples=16, name="bb_stones", wrap_x=True)
    st = ik.wash_shape(sp["a"], 97, warp_amp=1.5, warp_sigma=4, soft=0.8, edge=0.25, wrap_x=True)
    cv.over(ik.PAPER_LIGHT, clamp01(0.85 * st))
    tone = rng(98).uniform(0.05, 0.22, len(polys) + 1)
    tm = np.where(sp["idx"] >= 0, tone[np.clip(sp["idx"], 0, len(polys))], 0) * st
    cv.over(ik.WASH, clamp01(ik.edge_darken(tm.astype(F32), 3.0, 1.2, wrap_x=True)))
    edge = clamp01((st - blur(st, 1.5, wrap_x=True)) * 3.0) * smoothstep(-0.4, 0.8, gnoise(
        h, w, 6.0, seed=99, wrap_x=True))
    cv.over(ik.INK, clamp01(0.75 * edge))
    # fallen leaves: small tapered strokes, random orientation, two tones
    leaves = []
    for i in range(520):
        p = np.array([r.uniform(0, W), r.uniform(0, h)])
        a = r.uniform(0, 2 * np.pi)
        L = ppm * r.uniform(0.10, 0.2)
        leaves.append(leaf(p, a, L, L * 0.16, r))
    sl = ik.render_strokes(leaves, w, h, samples=16, name="bb_leaves", wrap_x=True)
    lt = rng(100).uniform(0.25, 0.75, len(leaves) + 1)
    lm = np.where(sl["idx"] >= 0, lt[np.clip(sl["idx"], 0, len(leaves))], 0) * sl["a"]
    cv.over(ik.INK2, clamp01(lm.astype(F32)))
    # moss
    moss = smoothstep(1.3, 1.9, gnoise(h, w, 1.6, seed=101, wrap_x=True)) * smoothstep(
        0.4, 1.2, fbm(h, w, 40.0, 3, seed=102, wrap_x=True))
    cv.over(ik.lerp(ik.JADE, ik.INK2, 0.45), clamp01(0.5 * moss * smoothstep(
        0.6, 1.4, gnoise(h, w, 25.0, seed=105, wrap_x=True))))
    # near edge darker, far edge into mist
    near = smoothstep(2.0, 8.0, zw + 0.6 * gnoise(h, w, 110.0, 40.0, seed=103, wrap_x=True))
    cv.over(ik.INK2, clamp01(0.42 * near ** 1.2))
    fz = zw + 0.35 * gnoise(h, w, 30.0, 12.0, seed=104, wrap_x=True)
    cv.over(ik.MIST, clamp01((1 - smoothstep(-9.0, -5.6, fz)) ** 1.4))
    out = clamp01(ik.resize(cv.rgb, H, W, wrap_x=True))
    ik.save_image(out, lay.out_dir(STAGE) + "/floor.webp", 85)
    ik.save_image(out, ik.WORK + "/bb_prev_floor.png")
