"""Cloud Peak NEAR layer: dark faceted rock outcrops and gnarled pines framing the LEFT and RIGHT
ends; the centre stays transparent (only a few grass tufts on the plateau lip).

Rocks: clusters of convex hulls (bmesh.ops.convex_hull) -> big flat facets, rendered with a
hard side light in Cycles, then posterised into paper / wash / ink facets with crease lines and
dry axe-cut streaks.  Pines: brush-stroke ribbons (trunk, branches, needle fans, pads)."""
import math

import numpy as np
import bpy
import bmesh

import inklib as ik
from inklib import F32, blur, gnoise, fbm, smoothstep, clamp01, rng
import cp_layout as lay
from cp_ranges import EYE, add_object, render_passes, soft_mask, finish_layer, cloud_contours
import cp_pines as pines

ROCK_PAPER = ik.hexc("#e3d6bd")


def hull_rock(name, center, size, seed, npts=26, squash_top=0.0):
    """Faceted boulder: convex hull of jittered points on an ellipsoid (game coords in)."""
    r = rng(seed)
    p = r.normal(size=(npts, 3))
    p /= np.linalg.norm(p, axis=1, keepdims=True)
    p *= r.uniform(0.7, 1.0, (npts, 1))
    p *= np.asarray(size)[None]
    if squash_top:
        top = size[1] * (1 - squash_top)
        p[:, 1] = np.minimum(p[:, 1], top + 0.08 * size[1] * r.random(npts))
    c = np.asarray(center)
    bm = bmesh.new()
    for q in p:
        g = c + q
        bm.verts.new(ik.g2b(g))
    res = bmesh.ops.convex_hull(bm, input=list(bm.verts))
    junk = list({v for v in res.get("geom_interior", []) + res.get("geom_unused", [])
                 if isinstance(v, bmesh.types.BMVert) and v.is_valid})
    if junk:
        bmesh.ops.delete(bm, geom=junk, context="VERTS")
    # merge near-coplanar triangles into big facets (axe-cut planes, not a low-poly gem)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(14), use_dissolve_boundaries=False,
                             verts=list(bm.verts), edges=list(bm.edges))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return me


# rocks: (x, y, z) centre in game metres, (sx, sy, sz) half sizes, flat-top fraction
LEFT_ROCKS = [
    ((-16.6, 1.2, -10.4), (2.6, 2.6, 1.6), 0.15), ((-13.6, 0.9, -10.0), (2.0, 2.1, 1.4), 0.25),
    ((-11.4, 0.4, -9.7), (1.5, 1.3, 1.1), 0.3), ((-9.6, 0.1, -9.5), (1.0, 0.8, 0.8), 0.2),
    ((-8.2, 0.0, -9.4), (0.6, 0.42, 0.5), 0.2), ((-7.2, 0.0, -9.3), (0.35, 0.22, 0.3), 0.1),
    ((-15.0, 2.6, -11.2), (1.8, 1.5, 1.2), 0.1), ((-18.0, 3.4, -11.6), (2.0, 1.9, 1.3), 0.1),
    ((-12.6, 1.8, -10.9), (1.2, 1.0, 1.0), 0.0),
]
RIGHT_ROCKS = [
    ((14.4, 2.6, -10.6), (1.7, 3.1, 1.3), 0.0), ((16.6, 1.6, -10.2), (1.9, 2.2, 1.4), 0.1),
    ((12.2, 0.8, -9.8), (1.4, 1.2, 1.1), 0.2), ((10.4, 0.2, -9.5), (0.9, 0.7, 0.8), 0.25),
    ((9.0, 0.0, -9.4), (0.55, 0.36, 0.5), 0.2), ((8.1, 0.0, -9.3), (0.3, 0.2, 0.3), 0.1),
    ((17.8, 4.2, -11.4), (1.6, 2.0, 1.2), 0.1), ((15.4, 5.6, -11.0), (0.9, 1.1, 0.9), 0.0),
]
TUFT_X = [-6.4, -5.1, -3.3, -0.8, 1.9, 3.6, 5.4, 6.9]


def near_layer():
    name = "near"
    L = lay.LAYERS[name]
    w, h = L["size"]
    ik.reset_scene()
    ik.quad_camera(L["rect"], L["z"], EYE)
    mat = ik.mat_diffuse()
    for i, (c, s, ft) in enumerate(LEFT_ROCKS + RIGHT_ROCKS):
        me = hull_rock(f"rock{i}", c, s, seed=300 + i, squash_top=ft)
        add_object(me, 1 + i, mat)
    P = render_passes(name, w, h, light_dir=(-0.75, 0.35, -0.55), sun=3.8, ambient=0.25)
    return paint_near(P, w, h)


def streak_field(h, w, angle_deg, seed, sx=14.0, sy=0.8):
    """Thin parallel dry-brush streaks at an angle (noise sampled in rotated coordinates)."""
    base = gnoise(512, 2048, sx, sy, seed=seed, wrap_x=True, wrap_y=True)
    xx, yy = ik.grid(h, w)
    a = math.radians(angle_deg)
    u = xx * math.cos(a) + yy * math.sin(a)
    v = -xx * math.sin(a) + yy * math.cos(a)
    return ik.sample(base, u % 2048, v % 512, True, True)


def big_pine(ppm, to_px):
    """The framing pine on the left: gnarled trunk leaning right, long horizontal top branch."""
    r = rng(5150)
    ctrl = np.array([(-12.6, 1.55), (-12.25, 2.4), (-12.6, 3.3), (-11.9, 4.2), (-11.0, 4.7),
                     (-10.6, 5.4), (-10.9, 6.2), (-10.3, 7.0)])
    P = np.stack(to_px(ctrl[:, 0], ctrl[:, 1]), -1)
    trunk = ik.smooth_polyline(ik.resample_polyline(P, 4.0), 6)
    n = len(trunk)
    tw = np.linspace(0.62, 0.2, n) * ppm
    tw[:6] *= np.linspace(1.5, 1.0, 6)
    tw *= 1 + 0.06 * np.sin(np.linspace(0, 9, n))
    strokes = [(trunk, tw)]
    branches = []
    pads = []

    def branch(pts_m, w0, w1, pad_list):
        Pm = np.asarray(pts_m)
        Bp = np.stack(to_px(Pm[:, 0], Pm[:, 1]), -1)
        Bp = ik.smooth_polyline(ik.resample_polyline(Bp, 4.0), 4)
        branches.append((Bp, np.linspace(w0, w1, len(Bp)) * ppm))
        for (px, py, rx, ry) in pad_list:
            cx, cy = to_px(px, py)
            pads.append((float(cx), float(cy), rx * ppm, ry * ppm))

    # main branch sweeping right over the arena
    branch([(-11.0, 4.75), (-10.0, 5.05), (-8.7, 5.0), (-7.4, 5.25), (-6.1, 5.15), (-5.0, 5.35),
            (-4.3, 5.25)], 0.17, 0.035,
           [(-4.7, 5.35, 0.85, 0.30), (-6.0, 5.25, 0.75, 0.26), (-7.4, 5.35, 0.8, 0.28),
            (-8.8, 5.12, 0.62, 0.22), (-5.5, 4.95, 0.55, 0.18)])
    # lower branch
    branch([(-12.2, 3.6), (-11.2, 3.75), (-10.2, 3.6), (-9.3, 3.85)], 0.12, 0.03,
           [(-9.4, 3.95, 0.62, 0.22), (-10.4, 3.8, 0.45, 0.16)])
    # upper crown branches
    branch([(-10.7, 6.3), (-9.9, 6.6), (-8.9, 6.55), (-8.2, 6.85)], 0.11, 0.03,
           [(-8.4, 6.95, 0.72, 0.26), (-9.5, 6.7, 0.55, 0.2)])
    branch([(-10.4, 6.9), (-11.3, 7.3), (-12.3, 7.25), (-13.0, 7.5)], 0.1, 0.03,
           [(-12.8, 7.6, 0.7, 0.25), (-11.6, 7.4, 0.5, 0.18)])
    branch([(-10.35, 6.95), (-10.0, 7.6), (-9.6, 8.0)], 0.08, 0.03, [(-9.7, 8.1, 0.6, 0.22)])
    # twigs off the main branch
    for (x0, y0, x1, y1) in [(-8.7, 5.0, -8.3, 4.6), (-6.1, 5.15, -6.4, 4.75),
                             (-7.4, 5.25, -7.0, 5.65), (-5.0, 5.35, -5.3, 5.7)]:
        branch([(x0, y0), ((x0 + x1) / 2 + 0.05, (y0 + y1) / 2), (x1, y1)], 0.05, 0.02, [])
    return strokes, branches, pads


def small_pine(ppm, to_px):
    """Smaller pine growing out of the right outcrop, leaning left into the frame."""
    strokes, branches, pads = [], [], []
    ctrl = np.array([(14.0, 5.4), (13.6, 5.9), (12.9, 6.1), (12.3, 6.5), (11.9, 6.9)])
    P = np.stack(to_px(ctrl[:, 0], ctrl[:, 1]), -1)
    trunk = ik.smooth_polyline(ik.resample_polyline(P, 4.0), 5)
    strokes.append((trunk, np.linspace(0.22, 0.08, len(trunk)) * ppm))
    for pts, padl in [
        ([(12.9, 6.1), (11.9, 5.95), (10.8, 5.6), (9.6, 5.5), (8.6, 5.25)],
         [(8.8, 5.35, 0.7, 0.24), (10.0, 5.65, 0.62, 0.21), (11.2, 5.85, 0.5, 0.18)]),
        ([(12.1, 6.7), (11.3, 7.0), (10.6, 7.05)], [(10.7, 7.15, 0.55, 0.2)]),
        ([(13.5, 5.85), (14.2, 6.3), (14.8, 6.35)], [(14.8, 6.45, 0.5, 0.18)]),
    ]:
        Pm = np.asarray(pts)
        Bp = np.stack(to_px(Pm[:, 0], Pm[:, 1]), -1)
        Bp = ik.smooth_polyline(ik.resample_polyline(Bp, 4.0), 4)
        branches.append((Bp, np.linspace(0.11, 0.03, len(Bp)) * ppm))
        for (px, py, rx, ry) in padl:
            cx, cy = to_px(px, py)
            pads.append((float(cx), float(cy), rx * ppm, ry * ppm))
    return strokes, branches, pads


def grass_tufts(points, ppm, seed, scale=1.0):
    """Clusters of thin upward strokes at (col, row) points."""
    r = rng(seed)
    out = []
    for (c, rw) in points:
        nb = r.integers(5, 10)
        H = ppm * r.uniform(0.14, 0.32) * scale
        for b in range(nb):
            a = -math.pi / 2 + r.normal(0, 0.45)
            L = H * r.uniform(0.5, 1.0)
            p0 = np.array([c + r.normal(0, H * 0.15), rw])
            bend = r.normal(0, 0.25)
            t = np.linspace(0, 1, 7)[:, None]
            d = np.array([math.cos(a), math.sin(a)])
            nrm = np.array([-d[1], d[0]])
            pts = p0 + d * L * t + nrm * bend * L * t ** 2
            out.append((pts, np.linspace(max(1.2, H * 0.06), 0.3, 7)))
    return out


def bark_scales(trunk, widths, seed, step=16.0):
    """Short curved marks across the trunk (pine bark plates)."""
    r = rng(seed)
    P = np.asarray(trunk)
    W = np.asarray(widths)
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    out = []
    pos = r.uniform(0, step)
    while pos < s[-1] * 0.92:
        i = int(np.searchsorted(s, pos))
        i = min(max(i, 1), len(P) - 2)
        d = P[i + 1] - P[i - 1]
        d /= np.linalg.norm(d) + 1e-9
        nrm = np.array([-d[1], d[0]])
        half = W[i] / 2
        v0, v1 = r.uniform(-0.85, -0.2), r.uniform(0.1, 0.8)
        t = np.linspace(v0, v1, 6)
        bow = r.uniform(0.15, 0.35) * half
        pts = P[i][None] + nrm[None] * (t * half)[:, None] + d[None] * (bow * (1 - (
            (t - (v0 + v1) / 2) / ((v1 - v0) / 2 + 1e-6)) ** 2))[:, None]
        out.append((pts, np.full(6, max(1.6, half * 0.12)) * np.array([0.4, 1, 1, 1, 0.8, 0.3])))
        pos += step * r.uniform(0.7, 1.3) * max(0.6, W[i] / W.max())
    return out


def needle_wheels(pads, seed, ppm):
    """Dense dark needle fans covering each foliage pad (sumi-e pine foliage)."""
    r = rng(seed)
    out = []
    for (cx, cy, rx, ry) in pads:
        nf = max(4, int(rx * ry / (0.0065 * ppm * ppm)))
        for f in range(nf):
            u = r.uniform(-1, 1)
            vv = r.uniform(-0.55, 0.7)
            if u * u + vv * vv > 1.0:
                continue
            fx = cx + u * rx * 0.92
            fy = cy - vv * ry * 0.85
            L = ppm * r.uniform(0.18, 0.30) * (0.75 + 0.25 * (1 - abs(u)))
            nn = r.integers(11, 17)
            spread = math.radians(r.uniform(140, 175))
            tilt = r.normal(0, 0.15) + 0.25 * u
            for q in range(nn):
                a = -math.pi / 2 + tilt + (q / (nn - 1) - 0.5) * spread + r.normal(0, 0.04)
                ll = L * r.uniform(0.75, 1.05)
                p0 = np.array([fx, fy])
                p1 = p0 + ll * np.array([math.cos(a), math.sin(a)])
                out.append((np.linspace(p0, p1, 5), np.array([2.3, 2.0, 1.6, 1.0, 0.35])))
    return out


def paint_near(P, w, h):
    ppm = lay.px_per_m("near")

    def to_px(x, y):
        return lay.to_px("near", x, y)

    a, S, cls, N = P["a"], P["S"], P["cls"], P["N"]
    rockm = a
    cv = ik.Canvas(h, w, ROCK_PAPER, 0.0)
    cv.over(ROCK_PAPER, rockm)
    g = ik.granulation(h, w, 9, fine=1.2, clump=3.5, mix=0.6)
    wob = fbm(h, w, 50.0, 4, seed=10)
    Sb = blur(S, 0.8)
    yrow = lay.row_grid_y("near")[:, None]
    # overall body wash (rocks are dark), deeper toward the ground contact
    base = (0.26 + 0.18 * (1 - smoothstep(0.0, 2.5, yrow))) * rockm * (1 + 0.2 * wob)
    cv.over(ik.INK2, clamp01(ik.granulate(base, g, 0.3)))
    levels = [(0.70, 0.52, 0.50, ik.INK2), (0.44, 0.30, 0.82, ik.INK)]
    for i, (hi, lo, amt, col) in enumerate(levels):
        m = smoothstep(hi, lo, Sb) * rockm
        m = ik.wash_shape(m, 20 + i, warp_amp=2.5, warp_sigma=7.0, soft=1.0, edge=0.2,
                          jitter=0.05)
        d = amt * m * (1 + 0.12 * wob)
        d = ik.edge_darken(d, 1.8, 0.6)
        d = ik.granulate(d, g, 0.25)
        cv.over(col, clamp01(d))
    # axe-cut dry streaks across the facets
    st = smoothstep(0.9, 1.8, streak_field(h, w, 62, 31)) + \
        0.6 * smoothstep(1.2, 2.0, streak_field(h, w, 75, 32, sx=8, sy=1.4))
    cv.over(ik.INK, clamp01(0.55 * clamp01(st) * smoothstep(0.85, 0.45, Sb) * rockm))
    # lift a few lit facet highlights back toward paper (dry-brush scumble)
    lit = smoothstep(0.78, 0.92, Sb) * rockm
    lit = ik.wash_shape(lit, 23, warp_amp=2.0, warp_sigma=5.0, soft=1.0, edge=0.25)
    scum = smoothstep(-0.2, 1.2, streak_field(h, w, 58, 34, sx=10, sy=1.0))
    cv.over(ROCK_PAPER, clamp01(0.55 * lit * scum))
    # significant facet creases and occluding contours, brushy and broken
    Nb = blur(N, 0.6)
    e = np.zeros((h, w), F32)
    for c in range(3):
        gy, gx = np.gradient(Nb[..., c])
        e += np.hypot(gx, gy)
    crease = clamp01((e - 0.22) * 3.0) * rockm
    brk = smoothstep(-0.3, 0.9, gnoise(h, w, 9.0, seed=33))
    cont = cloud_contours(P["dist"], P["hit"], rel=0.02, hit=P["hit"])
    lines = np.maximum(crease * 0.75 * brk, blur(cont, 1.0) * 1.3)
    cv.over(ik.INK, clamp01(lines))
    edge = clamp01((rockm - blur(rockm, 2.2)) * 2.6)
    side = 0.65 + 0.35 * smoothstep(-1.0, 1.0, gnoise(h, w, 12.0, seed=34))
    cv.over(ik.INK, clamp01(edge * side))
    # moss dots on upward facets (fine, sparse) + grass
    r = rng(35)
    up = (N[..., 2] > 0.65) & (a > 0.95)
    ys, xs = np.nonzero(up)
    tufts_pts = []
    if len(xs):
        from cp_mid import stamp_dots
        pick = r.choice(len(xs), size=min(220, len(xs)), replace=False)
        dots = stamp_dots(h, w, ys[pick], xs[pick], r, 0.9, 2.2)
        cv.over(ik.INK, clamp01(0.9 * dots))
        sel = r.choice(len(xs), size=min(22, len(xs)), replace=False)
        tufts_pts = [(xs[i], ys[i]) for i in sel]
    for x in TUFT_X:
        c, rw = to_px(x, 0.02)
        tufts_pts.append((float(c), float(rw)))
    # pines
    s1, b1, p1 = big_pine(ppm, to_px)
    s2, b2, p2 = small_pine(ppm, to_px)
    trunks = s1 + s2
    branches = b1 + b2
    pads = p1 + p2
    scales = []
    for k, (tp, tw) in enumerate(trunks):
        scales += bark_scales(tp, tw, 500 + k)
    needles = needle_wheels(pads, 77, ppm)
    grass = grass_tufts(tufts_pts, ppm, 36)
    strokes = trunks + branches + scales + needles + grass
    n0 = len(trunks)
    n1 = n0 + len(branches)
    n2 = n1 + len(scales)
    n3 = n2 + len(needles)
    pad_polys = [pines.pad_polygon(*pd, rng(i + 1900), flat=0.7) for i, pd in enumerate(pads)]
    sp = ik.render_strokes([], w, h, polys=pad_polys, samples=16, name="near_pads")
    sd = ik.render_strokes(strokes, w, h, samples=24, name="near_pine")
    idx = sd["idx"]
    sa = sd["a"]
    is_tr = ((idx >= 0) & (idx < n0)).astype(F32)
    is_br = ((idx >= n0) & (idx < n1)).astype(F32)
    is_sc = ((idx >= n1) & (idx < n2)).astype(F32)
    is_nd = ((idx >= n2) & (idx < n3)).astype(F32)
    is_gr = ((idx >= n3) & (idx < len(strokes))).astype(F32)
    padm = ik.wash_shape(sp["a"], 40, warp_amp=3.0, warp_sigma=8.0, soft=1.5, edge=0.3)
    cv.over(ik.INK2, clamp01(ik.edge_darken(0.32 * padm * (1 + 0.2 * wob), 2.0, 0.8)))
    # trunk: dry-brush ink body with flying-white streaks, darker rims, bark plates
    v = sd["v"]
    bark = ik.dry_brush(sd, seed=41, bristles=14, along=40, dry_start=0.0, dry_end=1.0,
                        dryness=0.45, base_load=0.15, edge_dry=0.0, soft=0.1)
    body = sa * is_tr
    cv.over(ROCK_PAPER, clamp01(body))
    cv.over(ik.INK2, clamp01(0.78 * body))
    rim = smoothstep(0.35, 0.9, np.abs(v)) * body
    cv.over(ik.INK, clamp01(0.95 * np.maximum(rim, 0.8 * bark * is_tr)))
    cv.over(ik.INK, clamp01(0.85 * sa * is_sc))
    brn = ik.dry_brush(sd, seed=43, bristles=10, along=30, dry_start=0.5, dryness=0.5,
                       base_load=0.6, edge_dry=0.2, soft=0.12)
    cv.over(ik.INK, clamp01(0.95 * brn * is_br))
    cv.over(ik.INK, clamp01(0.92 * sa * is_nd))
    cv.over(ik.INK2, clamp01(0.85 * sa * is_gr))
    return finish_layer(cv, "near")
