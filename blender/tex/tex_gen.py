"""Shared INKFIST textures: paper, splats, crater, cracks, speed lines, mist.

Imported by build_textures.py (run inside Blender).  Strokes (fibres, cracks, speed lines) are
ribbon meshes rasterised by Cycles; shapes and watercolour behaviour are numpy."""
import math
import os

import numpy as np

import inklib as ik
from inklib import F32, blur, gnoise, fbm, smoothstep, clamp01, rng


def white_alpha(alpha):
    h, w = alpha.shape
    out = np.ones((h, w, 4), F32)
    out[..., 3] = clamp01(alpha)
    return out


def luma(rgb):
    return rgb @ np.array([0.2126, 0.7152, 0.0722], F32)


# --------------------------------------------------------------------------------------------
# paper (1024, tileable, opaque, multiply overlay, mean luma ~0.92)
# --------------------------------------------------------------------------------------------
def paper(out_dir, q=85):
    S = 1024
    r = rng(500)
    base = np.array([0.944, 0.921, 0.874], F32)
    form = 0.6 * gnoise(S, S, 36.0, seed=501, wrap_x=True, wrap_y=True) \
        + 0.4 * gnoise(S, S, 110.0, seed=502, wrap_x=True, wrap_y=True)
    grain = 0.7 * gnoise(S, S, 0.7, seed=503, wrap_x=True, wrap_y=True) \
        + 0.3 * gnoise(S, S, 1.8, seed=504, wrap_x=True, wrap_y=True)
    lum = 1.0 + 0.011 * form + 0.009 * grain
    # fibres: long thin curved strokes, some lighter (pulp) some darker (bark fibre)
    strokes = []
    kinds = []
    for i in range(1500):
        L = r.uniform(10, 80) if r.random() < 0.85 else r.uniform(80, 150)
        n = 14
        a = r.uniform(0, 2 * np.pi)
        p = [np.array([r.uniform(0, S), r.uniform(0, S)])]
        for j in range(n):
            a += r.normal(0, 0.18)
            p.append(p[-1] + L / n * np.array([math.cos(a), math.sin(a)]))
        p = np.array(p)
        wd = r.uniform(0.55, 1.5) * np.sin(np.linspace(0.15, np.pi - 0.15, n + 1)) ** 0.5
        strokes.append((p, wd))
        kinds.append(1 if r.random() < 0.78 else -1)
    sd = ik.render_strokes(strokes, S, S, samples=16, name="paper_fibres", wrap_x=True,
                           wrap_y=True)
    kind = np.where(sd["idx"] >= 0, np.asarray(kinds + [0], F32)[np.clip(sd["idx"], 0, None)],
                    0.0)
    amp = np.where(kind > 0, 0.03, -0.03)
    lum = lum + amp * sd["a"] * np.abs(kind)
    lum = lum + 0.006 * blur(sd["a"] * kind, 2.5, wrap_x=True, wrap_y=True)
    # a few tiny dark inclusions
    xx, yy = ik.grid(S, S)
    for i in range(26):
        cx, cy, rr = r.uniform(0, S), r.uniform(0, S), r.uniform(0.6, 1.6)
        dx = (xx - cx + S / 2) % S - S / 2
        dy = (yy - cy + S / 2) % S - S / 2
        lum = lum - 0.06 * clamp01(rr - np.hypot(dx, dy * r.uniform(0.6, 1.4)))
    rgb = base[None, None, :] * lum[..., None]
    rgb = rgb * (0.92 / float(luma(rgb).mean()))
    rgb = clamp01(rgb)
    ik.save_image(rgb, os.path.join(out_dir, "paper.webp"), q)
    m = float(luma(rgb).mean())
    sd_ = float(luma(rgb).std())
    seam = float(np.abs(rgb[:, 0] - rgb[:, -1]).mean() + np.abs(rgb[0] - rgb[-1]).mean())
    ik.log(f"paper mean luma {m:.4f} std {sd_:.4f} seam {seam:.4f}")
    return rgb


# --------------------------------------------------------------------------------------------
# ink splats (512, white RGB + alpha)
# --------------------------------------------------------------------------------------------
def _periodic_noise(n, sigma, seed):
    return gnoise(4, n, sigma, 1.0, seed=seed, wrap_x=True)[1]


def _disc(xx, yy, cx, cy, rx, ry=None, ang=0.0):
    ry = rx if ry is None else ry
    c, s = math.cos(ang), math.sin(ang)
    dx, dy = xx - cx, yy - cy
    u = (dx * c + dy * s) / rx
    v = (-dx * s + dy * c) / ry
    d = np.hypot(u, v)
    return clamp01((1 - d) * min(rx, ry) + 0.5)


def splat(kind, seed, S=512):
    r = rng(seed)
    xx, yy = ik.grid(S, S)
    m = np.zeros((S, S), F32)
    cx, cy = S / 2 + r.uniform(-10, 10), S / 2 + r.uniform(-10, 10)
    if kind == 3:
        cx, cy = S * 0.32, S * 0.55
    rad = np.hypot(xx - cx, yy - cy)
    th = np.arctan2(yy - cy, xx - cx)
    nth = 1024
    ti = ((th + np.pi) / (2 * np.pi) * nth).astype(np.int64) % nth
    R0 = {0: 78, 1: 62, 2: 70, 3: 30}[kind]
    prof = R0 * (1 + 0.10 * _periodic_noise(nth, 30, seed) + 0.05 * _periodic_noise(nth, 6,
                                                                                        seed + 1))
    if kind == 1:                              # thrown to the right: stretched blob
        prof *= 1 + 0.55 * np.clip(np.cos(np.linspace(-np.pi, np.pi, nth, endpoint=False)), 0, 1)
    nsp = {0: 22, 1: 16, 2: 9, 3: 8}[kind]
    tips = []
    angs = np.linspace(-np.pi, np.pi, nth, endpoint=False)
    for k in range(nsp):
        if kind == 1:
            a = r.normal(0.0, 0.55)
        elif kind == 3:
            a = r.normal(-0.2, 0.5)
        else:
            a = r.uniform(-np.pi, np.pi)
        L = R0 * r.uniform(1.35, 2.7 if kind != 2 else 1.8)
        wd = r.uniform(0.03, 0.10)
        da = np.angle(np.exp(1j * (angs - a)))
        prof = np.maximum(prof, R0 + (L - R0) * np.exp(-(da / wd) ** 2) ** 0.7)
        tips.append((a, L))
    m = np.maximum(m, clamp01(prof[ti] - rad + 0.5))
    # droplets beyond spike tips + satellites
    for (a, L) in tips:
        if r.random() < 0.7:
            d = L + r.uniform(6, 40)
            rr = r.uniform(2.5, 9) * (R0 / 70)
            m = np.maximum(m, _disc(xx, yy, cx + d * math.cos(a), cy + d * math.sin(a), rr * 1.6,
                                    rr, a))
    nsat = {0: 40, 1: 55, 2: 18, 3: 160}[kind]
    for i in range(nsat):
        if kind == 1:
            a = r.normal(0.0, 0.45)
        elif kind == 3:
            a = r.normal(-0.2, 0.42)
        else:
            a = r.uniform(-np.pi, np.pi)
        d = R0 * r.uniform(1.3, 3.0 if kind != 3 else 7.0)
        if kind == 3:
            d = R0 * (1.5 + r.exponential(1.8))
        rr = max(0.9, r.uniform(1.5, 8.0) * (R0 * 1.4 / d) ** 0.8 * (R0 / 70) ** 0.3)
        if kind == 3:
            rr = r.uniform(0.9, 4.5) * (1.0 if r.random() < 0.8 else 1.8)
        px, py = cx + d * math.cos(a), cy + d * math.sin(a)
        if not (8 < px < S - 8 and 8 < py < S - 8):
            continue
        el = r.uniform(1.0, 2.2)
        m = np.maximum(m, _disc(xx, yy, px, py, rr * el, rr, a))
    # drips running down
    ndr = {0: 2, 1: 1, 2: 6, 3: 0}[kind]
    for i in range(ndr):
        x0 = cx + r.uniform(-0.75, 0.75) * R0
        col = m[:, int(x0)] > 0.5
        y0 = int(cy)
        if not col[y0]:
            continue
        while y0 < S - 2 and col[y0 + 1]:
            y0 += 1
        y0 -= 4
        L = r.uniform(40, 170) if kind == 2 else r.uniform(25, 70)
        wd = r.uniform(4, 11)
        y1 = min(y0 + L, S - 24)
        t = clamp01((yy - y0) / max(y1 - y0, 1))
        wx = wd * (1 - 0.35 * t) * (1 + 0.15 * np.sin(yy * 0.07 + i))
        xc = x0 + 3 * np.sin(yy * 0.03 + i * 2)
        run = clamp01(wx / 2 - np.abs(xx - xc) + 0.5) * (yy >= y0) * (yy <= y1)
        m = np.maximum(m, run)
        m = np.maximum(m, _disc(xx, yy, xc[int(y1), 0] if False else x0 + 3 * math.sin(
            y1 * 0.03 + i * 2), y1, wd * 0.75, wd * 0.9))
    # soft edges + ink behaviour
    m = ik.wash_shape(m, seed + 7, warp_amp=1.5, warp_sigma=4.0, soft=0.7, edge=0.25,
                      jitter=0.03)
    dens = 0.9 + 0.06 * gnoise(S, S, 18.0, seed=seed + 8)
    d = m * dens
    d = ik.edge_darken(d, 2.5, 0.9)
    d = ik.granulate(d, ik.granulation(S, S, seed + 9), 0.3, dense=0.02)
    d = ik.bleed(d, 1.2, 0.25)
    # keep away from the borders
    edge = smoothstep(0, 10, np.minimum(np.minimum(xx, S - 1 - xx), np.minimum(yy, S - 1 - yy)))
    return clamp01(d) * edge


def splats(out_dir, q=85):
    for k in range(4):
        d = splat(k, 600 + 17 * k)
        ik.save_image(white_alpha(d), os.path.join(out_dir, f"splat_{k}.webp"), q)


# --------------------------------------------------------------------------------------------
# crater decal (1024 RGBA, real colours)
# --------------------------------------------------------------------------------------------
def crack_tree(p0, ang, length, width, r, depth=0, max_depth=2, jitter=0.28):
    """Branching tapered crack polylines: jagged (per-segment heading jitter around a fixed
    direction, no accumulated curl) with occasional angular kinks."""
    out = []
    n = max(6, int(length / 8))
    pts = [np.asarray(p0, np.float64)]
    base = ang
    for i in range(n):
        if r.random() < 0.12:
            base += r.normal(0, 0.35)                  # occasional kink
        a = base + r.normal(0, jitter)
        pts.append(pts[-1] + length / n * np.array([math.cos(a), math.sin(a)]))
    pts = np.array(pts)
    wd = np.linspace(width, width * 0.12, len(pts))
    out.append((pts, wd))
    if depth < max_depth:
        for j in range(r.integers(1, 3)):
            k = r.integers(len(pts) // 4, max(len(pts) // 4 + 1, len(pts) - 2))
            out += crack_tree(pts[k], base + r.choice([-1, 1]) * r.uniform(0.4, 0.9),
                              length * r.uniform(0.3, 0.5), wd[k] * 0.75, r, depth + 1,
                              max_depth, jitter)
    return out


def _shrink(poly, px):
    c = poly.mean(0)
    d = poly - c
    n = np.linalg.norm(d, axis=1, keepdims=True)
    return c + d * np.maximum(n - px, n * 0.5) / np.maximum(n, 1e-6)


def crater(out_dir, q=85):
    """Shattered-ground crater: radial cracks x staggered concentric breaks -> wedge plates
    lifted at their outer edge (light), sunk at the inner edge (shadow); dark pit; radial cracks
    and rubble continuing into the ground.  Real colours, straight alpha."""
    S = 1024
    R = 420.0
    c = S / 2
    r = rng(700)
    K = 24
    th = (np.arange(K) + r.uniform(-0.32, 0.32, K)) / K * 2 * np.pi + r.uniform(0, 1)
    th = np.sort(th % (2 * np.pi))
    radii = np.linspace(0.04, 1.0, 60)
    jag = [np.cumsum(r.normal(0, 0.012, len(radii))) * 0 + r.normal(0, 0.018, len(radii))
           for _ in range(K)]

    def crack_pt(i, rr):
        a = th[i % K] + (2 * np.pi if i >= K else 0) + np.interp(rr, radii, jag[i % K])
        return np.array([c + rr * R * math.cos(a), c + rr * R * math.sin(a)])

    pieces, ring_of, tval = [], [], []
    outer_r = []
    for i in range(K):
        rr = r.uniform(0.09, 0.13)
        rings = [rr]
        while rr < 0.66:
            rr += r.uniform(0.17, 0.32)
            rings.append(min(rr, 0.86))
        outer_r.append(rings[-1])
        for j in range(len(rings) - 1):
            r0, r1 = rings[j], rings[j + 1]
            ra = np.linspace(r0, r1, 6)
            left = [crack_pt(i, x) for x in ra]
            right = [crack_pt(i + 1, x) for x in ra[::-1]]
            a0 = th[i]
            a1 = th[(i + 1) % K] + (2 * np.pi if i + 1 >= K else 0)
            arc_o = [np.array([c + (r1 + r.normal(0, 0.006)) * R * math.cos(a),
                               c + (r1 + r.normal(0, 0.006)) * R * math.sin(a)])
                     for a in np.linspace(a0, a1, 7)[1:-1]]
            arc_i = [np.array([c + (r0 + r.normal(0, 0.006)) * R * math.cos(a),
                               c + (r0 + r.normal(0, 0.006)) * R * math.sin(a)])
                     for a in np.linspace(a1, a0, 7)[1:-1]]
            poly = np.array(left + arc_o + right + arc_i)
            pieces.append(_shrink(poly, r.uniform(2.0, 3.6)))
            ring_of.append(j)
            tval.append((r0, r1))
    np_ = len(pieces)
    # extra cracks splitting some plates
    strokes = []
    for k in range(np_):
        if r.random() < 0.3:
            p = pieces[k]
            a, b = p[r.integers(0, len(p))], p[r.integers(0, len(p))]
            if np.linalg.norm(a - b) > 25:
                t = np.linspace(0, 1, 6)[:, None]
                pts = a + (b - a) * t + r.normal(0, 1.5, (6, 2))
                strokes.append((pts, np.full(6, 1.6)))
    # radial cracks continuing outward + rubble
    for i in range(K):
        p0 = crack_pt(i, outer_r[i] - 0.02)
        a = th[i] + r.normal(0, 0.08)
        strokes += crack_tree(p0, a, R * r.uniform(0.12, 0.3), r.uniform(3.0, 5.5), r,
                              max_depth=2, jitter=0.22)
    nlines = len(strokes)
    rubble = []
    for i in range(170):
        a = r.uniform(0, 2 * np.pi)
        d = R * (0.82 + r.exponential(0.1))
        if d > 0.48 * S:
            continue
        px, py = c + d * math.cos(a), c + d * math.sin(a)
        s = r.uniform(2.5, 10.0) * max(0.4, 1.3 - (d / R - 0.82) * 2)
        k = r.integers(4, 7)
        ang = np.sort(r.uniform(0, 2 * np.pi, k))
        rubble.append(np.stack([px + s * np.cos(ang) * r.uniform(0.55, 1.0, k),
                                py + s * np.sin(ang) * r.uniform(0.55, 1.0, k)], -1))
    sp = ik.render_strokes([], S, S, polys=pieces, samples=16, name="crater_pieces")
    sl = ik.render_strokes(strokes, S, S, polys=rubble, samples=24, name="crater_lines")
    xx, yy = ik.grid(S, S)
    dx, dy = xx - c, yy - c
    rad = np.hypot(dx, dy)
    rn = rad / R
    ang_px = np.arctan2(dy, dx)
    pid = sp["idx"]
    pa = sp["a"]
    g = ik.granulation(S, S, 703)
    wob = fbm(S, S, 40.0, 4, seed=704)
    # shard region (opaque) = union of pieces dilated over the gaps
    region = clamp01(blur(pa, 3.0) * 2.2)
    region = np.maximum(region, smoothstep(0.13, 0.08, rn))
    cv = ik.Canvas(S, S, ik.PAPER, 0.0)
    cv.over(ik.PAPER, region)
    # gaps between plates: deep ink cracks
    gap = clamp01(region - pa)
    cv.over(ik.INK, clamp01(gap * 1.1))
    # plate shading: sunk inner edge (dark) -> lifted outer edge (light), plus light direction
    r0s = np.array([t[0] for t in tval] + [0.0])
    r1s = np.array([t[1] for t in tval] + [1.0])
    tone_rand = np.concatenate([r.uniform(-0.08, 0.1, np_), [0.0]])
    ii = np.clip(pid, 0, np_)
    tt = clamp01((rn - r0s[ii]) / np.maximum(r1s[ii] - r0s[ii], 1e-3))
    facing = 0.5 + 0.5 * np.cos(ang_px - math.radians(-135))   # outer edges facing upper-left
    shade = (0.55 * (1 - tt) ** 1.6 + 0.12 + tone_rand[ii] + 0.18 * (1 - facing) * tt)
    shade = shade * (1.0 + 0.25 * smoothstep(0.6, 0.15, rn))      # deeper toward the centre
    shade = ik.granulate(clamp01(shade) * (1 + 0.15 * wob), g, 0.35) * pa
    shade = ik.edge_darken(shade, 2.0, 0.5)
    cv.over(ik.WASH, clamp01(shade * 0.9))
    cv.over(ik.INK2, clamp01(smoothstep(0.35, 0.0, tt) * 0.35 * pa))
    # lifted outer rims catch light
    rim = smoothstep(0.82, 0.97, tt) * pa * facing
    cv.over(ik.PAPER_LIGHT, clamp01(0.6 * rim))
    # crushed pit
    streak = np.interp(ang_px, np.linspace(-np.pi, np.pi, 256),
                       gnoise(4, 256, 2.0, seed=705, wrap_x=True)[1])
    pit = smoothstep(0.12, 0.03, rn + 0.035 * gnoise(S, S, 4.0, seed=702)
                     + 0.03 * np.interp(ang_px, np.linspace(-np.pi, np.pi, 64),
                                        gnoise(4, 64, 1.0, seed=708, wrap_x=True)[1]))
    chips = smoothstep(1.2, 1.8, gnoise(S, S, 1.6, seed=709))
    cv.over(ik.INK, clamp01(pit * (0.6 + 0.25 * smoothstep(0.0, 1.5, streak)) * (1 - 0.6 * chips)))
    # dust wash around the ring
    dust = np.exp(-((rn - 0.92) / 0.09) ** 2) * clamp01(0.5 + 0.7 * gnoise(S, S, 18.0, seed=706))
    cv.over(ik.WASH, clamp01(0.30 * dust * (1 - region)))
    # cracks / rubble
    ns = nlines
    is_s = ((sl["idx"] >= 0) & (sl["idx"] < ns)).astype(F32)
    is_p = (sl["idx"] >= ns).astype(F32)
    ink = ik.dry_brush(sl, seed=707, bristles=6, along=20, dry_start=0.6, dryness=0.6,
                       base_load=0.6, edge_dry=0.0, soft=0.12)
    cv.over(ik.INK, clamp01(0.92 * ink * is_s))
    cv.over(ik.INK2, clamp01(0.9 * sl["a"] * is_p))
    fade = smoothstep(0.495 * S, 0.45 * S, rad)
    cv.a = (cv.a * fade).astype(F32)
    rgb = ik.dilate_rgb(cv.rgb, cv.a, fallback=ik.PAPER)
    ik.save_image(np.concatenate([rgb, cv.a[..., None]], -1), os.path.join(out_dir,
                                                                          "crater.webp"), q)


# --------------------------------------------------------------------------------------------
# cracks decal (1024, white RGB + alpha)
# --------------------------------------------------------------------------------------------
def cracks(out_dir, q=85):
    S = 1024
    c = S / 2
    r = rng(800)
    strokes = []
    n = 9
    for i in range(n):
        a = (i + r.uniform(0.15, 0.85)) / n * 2 * np.pi
        strokes += crack_tree((c + r.normal(0, 4), c + r.normal(0, 4)), a,
                              r.uniform(0.28, 0.46) * S, r.uniform(5.0, 8.5), r, max_depth=2,
                              jitter=0.22)
    # a few short concentric links near the centre (spider-web)
    for i in range(7):
        rr = r.uniform(40, 150)
        a0 = r.uniform(0, 2 * np.pi)
        span = r.uniform(0.25, 0.6)
        t = np.linspace(a0, a0 + span, 10)
        pts = np.stack([c + rr * np.cos(t), c + rr * np.sin(t)], -1) + r.normal(0, 2.0, (10, 2))
        strokes.append((pts, np.linspace(3.0, 0.6, 10)))
    sd = ik.render_strokes(strokes, S, S, samples=24, name="cracks")
    ink = ik.dry_brush(sd, seed=801, bristles=5, along=18, dry_start=0.55, dryness=0.7,
                       base_load=0.6, edge_dry=0.0, soft=0.12)
    xx, yy = ik.grid(S, S)
    rad = np.hypot(xx - c, yy - c)
    core = smoothstep(26, 8, rad + 6 * gnoise(S, S, 3.0, seed=802))
    d = np.maximum(ink, 0.9 * core)
    d = ik.edge_darken(d, 1.5, 0.3)
    d = d * smoothstep(0.5 * S, 0.44 * S, rad)
    ik.save_image(white_alpha(clamp01(d)), os.path.join(out_dir, "cracks.webp"), q)


# --------------------------------------------------------------------------------------------
# speed lines (1024, white RGB + alpha)
# --------------------------------------------------------------------------------------------
def speedlines(out_dir, q=85):
    S = 1024
    c = S / 2
    r = rng(900)
    strokes = []
    R_out = 0.76 * S
    n = 460
    for i in range(n):
        a = r.uniform(-np.pi, np.pi)
        r_in = r.uniform(0.22, 0.47) * S
        if r.random() < 0.15:
            r_in = r.uniform(0.40, 0.5) * S
        w_out = r.uniform(1.5, 7.0) if r.random() < 0.85 else r.uniform(8.0, 15.0)
        t = np.linspace(0, 1, 8)
        rr = R_out + (r_in - R_out) * t
        pts = np.stack([c + rr * math.cos(a), c + rr * math.sin(a)], -1)
        wd = w_out * (1 - t) ** 1.2 + 0.25
        strokes.append((pts, wd))
    sd = ik.render_strokes(strokes, S, S, samples=24, name="speedlines")
    ink = ik.dry_brush(sd, seed=901, bristles=4, along=30, dry_start=0.7, dryness=0.5,
                       base_load=0.8, edge_dry=0.0, soft=0.15)
    xx, yy = ik.grid(S, S)
    rad = np.hypot(xx - c, yy - c)
    d = ink * smoothstep(0.2 * S, 0.3 * S, rad)
    ik.save_image(white_alpha(clamp01(d)), os.path.join(out_dir, "speedlines.webp"), q)


# --------------------------------------------------------------------------------------------
# mist band (1024 x 256, tileable horizontally, white RGB + alpha)
# --------------------------------------------------------------------------------------------
def mist(out_dir, q=85):
    W, H = 1024, 256
    yy = (np.arange(H)[:, None] + 0.5) / H
    n1 = gnoise(H, W, 120.0, 18.0, seed=950, wrap_x=True)
    n2 = gnoise(H, W, 40.0, 6.0, seed=951, wrap_x=True)
    centre = 0.52 + 0.05 * gnoise(4, W, 140.0, 1.0, seed=952, wrap_x=True)[1][None, :]
    half = 0.24 + 0.05 * gnoise(4, W, 90.0, 1.0, seed=953, wrap_x=True)[1][None, :]
    prof = np.exp(-(((yy - centre) / half) ** 2) * 2.2)
    a = prof * clamp01(0.62 + 0.22 * n1 + 0.12 * n2)
    a = blur(a, 3.0, 2.0, wrap_x=True)
    a = a * smoothstep(0.0, 0.12, yy) * smoothstep(1.0, 0.88, yy)
    a = clamp01(a * 0.9)
    ik.save_image(white_alpha(a), os.path.join(out_dir, "mist.webp"), q)
    seam = float(np.abs(a[:, 0] - a[:, -1]).mean())
    ik.log(f"mist seam {seam:.4f} max alpha {a.max():.2f}")
