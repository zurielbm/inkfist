"""Procedural ink pines (松) and a tiny pavilion, built as brush-stroke geometry.

All coordinates are image pixels (x right, y down).  Generators return stroke lists
(pts, widths) and filled polygons that inklib.render_strokes rasterises with Cycles; the
caller paints them with dry-brush / wash treatments.
"""
import math

import numpy as np

import inklib as ik
from inklib import rng


def _walk(p0, ang, length, n, r, jitter=0.10, pull=0.05, target=None, kinks=0):
    """Gnarled path: heading random walk with a spring toward `target` angle, optional kinks."""
    pts = [np.asarray(p0, np.float64)]
    a = ang
    tgt = ang if target is None else target
    step = length / n
    kink_at = set(r.choice(np.arange(3, n - 2), size=min(kinks, max(n - 5, 0)), replace=False)) \
        if kinks else set()
    for i in range(n):
        a += r.normal(0, jitter) + pull * (tgt - a)
        if i in kink_at:
            a += r.choice([-1, 1]) * r.uniform(0.25, 0.5)
        pts.append(pts[-1] + step * np.array([math.cos(a), math.sin(a)]))
    return np.array(pts)


def pad_polygon(cx, cy, rx, ry, r, n=48, flat=0.55, lumps=5):
    """Foliage pad: dome-topped, flat-bottomed lumpy ellipse."""
    th = np.linspace(0, 2 * np.pi, n, endpoint=False)
    ph = r.uniform(0, 2 * np.pi, 3)
    rad = 1 + 0.12 * np.sin(lumps * th + ph[0]) + 0.06 * np.sin(2 * lumps * th + ph[1]) \
        + 0.05 * r.standard_normal(n)
    x = cx + rx * rad * np.cos(th)
    s = np.sin(th)
    y = cy - ry * rad * np.where(s > 0, s, s * flat)   # y down: top (s>0) is the dome
    return np.stack([x, y], -1)


def pine(base, height, seed, lean=0.0, spread=1.0, style="small", hang=False):
    """One pine.  base = (x, y) px of the root; height px; lean radians (+ = to the right).
    hang=True grows the trunk out sideways from a cliff (welcoming pine)."""
    r = rng(seed)
    up = -math.pi / 2
    trunk_ang = up + lean
    n = 26
    if hang:
        tr = _walk(base, trunk_ang, height, n, r, jitter=0.07, pull=0.08,
                   target=trunk_ang - 0.25 * np.sign(lean), kinks=1)
    else:
        tr = _walk(base, trunk_ang, height, n, r, jitter=0.09, pull=0.10, target=up + lean * 0.4,
                   kinks=2 if style == "big" else 1)
    tr = ik.smooth_polyline(tr, 2)
    w0 = height * (0.075 if style == "big" else 0.09)
    tw = np.linspace(1.0, 0.32, len(tr)) * w0
    tw[:3] *= np.array([1.6, 1.3, 1.1])                 # root flare
    strokes = [(tr, tw)]
    branches, pads = [], []
    side = r.choice([-1, 1])
    k0 = int(len(tr) * (0.38 if not hang else 0.25))
    ks = list(range(k0, len(tr) - 1, max(2, (len(tr) - k0) // (5 if style == "big" else 4))))
    for j, k in enumerate(ks):
        t = k / (len(tr) - 1)
        side = -side if not hang else (1 if r.random() < 0.7 else -1) * np.sign(lean or 1)
        blen = height * spread * r.uniform(0.32, 0.52) * (1.1 - 0.55 * t)
        a0 = (0 if side > 0 else math.pi) + side * r.uniform(-0.15, 0.25) * -1
        nb = 9
        bp = _walk(tr[k], a0, blen, nb, r, jitter=0.12, pull=0.0)
        # droop then tip up
        tt = np.linspace(0, 1, len(bp))
        bp[:, 1] += blen * 0.10 * np.sin(np.pi * tt) - blen * 0.08 * tt ** 3
        bw = np.linspace(tw[k] * 0.55, tw[k] * 0.12, len(bp))
        branches.append((bp, bw))
        tip = bp[-1]
        prx = blen * r.uniform(0.42, 0.6)
        pads.append((tip[0] - side * prx * 0.25, tip[1] - prx * 0.12, prx, prx * r.uniform(0.28, 0.38)))
        if style == "big" or r.random() < 0.5:
            mid = bp[len(bp) // 2]
            pads.append((mid[0], mid[1] - prx * 0.1, prx * 0.6, prx * 0.22))
    top = tr[-1]
    crx = height * spread * r.uniform(0.18, 0.26)
    pads.append((top[0], top[1] + crx * 0.1, crx, crx * 0.45))
    return dict(trunk=strokes, branches=branches, pads=pads, trunk_w=w0)


def needle_fans(pads, seed, density=1.0):
    """Radiating needle strokes for each pad (for large, near pines)."""
    r = rng(seed)
    strokes = []
    for (cx, cy, rx, ry) in pads:
        nf = max(2, int(rx / 9 * density))
        for f in range(nf):
            fx = cx + r.uniform(-0.8, 0.8) * rx
            fy = cy + r.uniform(-0.3, 0.5) * ry
            L = r.uniform(0.25, 0.42) * rx + 6
            nn = r.integers(9, 15)
            for q in range(nn):
                a = -math.pi / 2 + (q / (nn - 1) - 0.5) * math.radians(r.uniform(150, 190)) \
                    + r.normal(0, 0.05)
                ll = L * r.uniform(0.7, 1.05)
                p0 = np.array([fx, fy])
                p1 = p0 + ll * np.array([math.cos(a), math.sin(a)])
                pts = np.linspace(p0, p1, 6)
                wid = np.linspace(max(1.0, rx / 55), 0.4, 6)
                strokes.append((pts, wid))
    return strokes


def pavilion(cx, base_y, width, seed):
    """Tiny hexagonal pavilion silhouette: returns (ink polys, crimson polys, strokes)."""
    r = rng(seed)
    W = width
    H = W * 0.95
    ink, red, strokes = [], [], []
    # stone platform
    pb = base_y
    ink.append(np.array([[cx - W * 0.55, pb], [cx + W * 0.55, pb], [cx + W * 0.5, pb - H * 0.1],
                         [cx - W * 0.5, pb - H * 0.1]]))
    # pillars (crimson)
    py0, py1 = pb - H * 0.1, pb - H * 0.55
    for fx in (-0.36, -0.12, 0.12, 0.36):
        x = cx + fx * W
        red.append(np.array([[x - W * 0.035, py0], [x + W * 0.035, py0], [x + W * 0.035, py1],
                             [x - W * 0.035, py1]]))
    # railing
    red.append(np.array([[cx - W * 0.42, py0 - H * 0.12], [cx + W * 0.42, py0 - H * 0.12],
                         [cx + W * 0.42, py0 - H * 0.15], [cx - W * 0.42, py0 - H * 0.15]]))
    # sweeping roof with upturned eaves
    t = np.linspace(-1, 1, 40)
    eave_y = py1 - H * 0.02 - H * 0.12 * np.abs(t) ** 4
    roof_top = py1 - H * 0.42
    xs = cx + t * W * 0.68
    lower = np.stack([xs, eave_y], -1)
    upper_t = np.linspace(1, -1, 40)
    ux = cx + upper_t * W * 0.68
    uy = roof_top + (py1 - H * 0.08 - roof_top) * np.abs(upper_t) ** 0.55 - H * 0.12 * np.abs(upper_t) ** 4
    upper = np.stack([ux, uy], -1)
    ink.append(np.concatenate([lower, upper]))
    # finial
    strokes.append((np.array([[cx, roof_top + 1], [cx, roof_top - H * 0.16]]),
                    np.array([W * 0.035, W * 0.01])))
    return ink, red, strokes
