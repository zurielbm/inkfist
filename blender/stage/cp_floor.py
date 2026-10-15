"""Cloud Peak FLOOR: top-down plateau texture, tileable horizontally.

Mapping (stage.json floor): u = x / tileWidth (16 m), v: top row = zFar (-9), bottom row =
zNear (+8).  Features are painted stretched 3x along z so they read correctly at the grazing
camera angle: we paint in a square-pixel design canvas of 16 m x (15 m / 3) and resample it
vertically to the final 2048x1024.

Content: weathered flagstone rows with dry-brush joints, chipped corners, cracks, ink-wash
stains, moss dots and grass tufts in the joints, darker toward the near (bottom) edge, a rough
rocky lip at the far edge that dissolves into the MIST colour so it blends with the backdrop."""
import math

import numpy as np

import inklib as ik
from inklib import F32, blur, gnoise, fbm, smoothstep, clamp01, rng
import cp_layout as lay

STRETCH = 3.0
FLOOR_PAPER = ik.hexc("#e6dbc4")


def floor_layer():
    W, H = lay.FLOOR["size"]
    tile = lay.FLOOR["tileWidth"]
    depth = lay.FLOOR["zNear"] - lay.FLOOR["zFar"]
    ppm = W / tile                                   # design px per metre (both axes)
    DH = int(round(depth / STRETCH * ppm))           # design canvas height (640)

    def zrow(z):                                     # world z -> design row
        return (z - lay.FLOOR["zFar"]) / STRETCH * ppm

    r = rng(1234)
    # ---------------- slab layout (design metres, rows along x) ----------------
    slabs, outlines, cracks = [], [], []
    z = -7.35
    row_edges = [z]
    while z < lay.FLOOR["zNear"]:
        dz = r.uniform(1.7, 3.3)                      # world metres (= 0.57-1.1 m designed)
        z = min(z + dz, lay.FLOOR["zNear"] + 0.6)
        row_edges.append(z)
    gap = 2.0
    holes = []
    for k in range(len(row_edges) - 1):
        z0, z1 = zrow(row_edges[k]), zrow(row_edges[k + 1])
        n = r.integers(8, 14)
        widths = r.uniform(0.55, 1.8, n)
        widths = widths / widths.sum() * W
        x = r.uniform(0, W)
        for i in range(n):
            x0, x1 = x, x + widths[i]
            x = x1
            poly = slab_poly(x0, x1, z0, z1, gap, r)
            if 0 < k < len(row_edges) - 4 and r.random() < 0.035:   # missing slab: earth+grass
                holes.append(poly)
                cx_, cz_ = poly.mean(0)
                continue
            if r.random() < 0.22:                        # cracked slab: split by a crack
                a_, b_, crack = split_poly(poly, r)
                slabs += [a_, b_]
                cracks.append(crack)
            else:
                slabs.append(poly)
            outlines += broken_outline(poly, r)
    tufts_h = []
    for poly in holes:
        for j in range(r.integers(3, 6)):
            c = poly[r.integers(0, len(poly))] * 0.5 + poly.mean(0) * 0.5
            tufts_h += tuft(c[0], c[1], r, ppm)
    # extra hairline cracks
    for i in range(46):
        cx, cz = r.uniform(0, W), r.uniform(zrow(-7), DH)
        cracks.append(crack_path(cx, cz, r.uniform(20, 70), r))
    # grass tufts + moss in joints (sampled along row edges)
    tufts = []
    moss_pts = []
    for k, ze in enumerate(row_edges[1:-1]):
        zr = zrow(ze)
        for i in range(r.integers(5, 9)):
            moss_pts.append((r.uniform(0, W), zr + r.normal(0, 2)))
        for i in range(r.integers(1, 4)):
            tufts += tuft(r.uniform(0, W), zr, r, ppm)
    nsl = len(slabs)
    sd_sl = ik.render_strokes([], W, DH, polys=slabs, samples=16, name="floor_slabs",
                              wrap_x=True)
    sd_h = ik.render_strokes([], W, DH, polys=holes or [np.zeros((3, 2))], samples=8,
                             name="floor_holes", wrap_x=True)
    tufts = tufts + tufts_h
    strokes = outlines + cracks + tufts
    no, nc = len(outlines), len(cracks)
    sd = ik.render_strokes(strokes, W, DH, samples=24, name="floor_lines", wrap_x=True)
    # ---------------- painting ----------------
    h, w = DH, W
    g = ik.granulation(h, w, 21, wrap_x=True, fine=1.1, clump=3.5, mix=0.6)
    wob = fbm(h, w, 70.0, 4, seed=22, wrap_x=True)
    cv = ik.Canvas(h, w, FLOOR_PAPER, 1.0)
    slab_a = sd_sl["a"]
    sid = sd_sl["idx"]
    # joints: dark grooves where no slab
    joint = clamp01(1.0 - slab_a)
    joint = ik.wash_shape(joint, 23, warp_amp=1.2, warp_sigma=3.0, soft=0.8, edge=0.3,
                          wrap_x=True)
    cv.over(ik.INK2, clamp01(0.42 * joint * (1 + 0.2 * wob)))
    earth = ik.wash_shape(sd_h["a"], 33, warp_amp=2, warp_sigma=5, soft=1.0, edge=0.3,
                          wrap_x=True)
    cv.over(ik.WASH, clamp01(0.28 * earth * (1 + 0.3 * gnoise(h, w, 4.0, seed=34, wrap_x=True))))
    # per-slab washes with pigment rims
    tones = r.uniform(0.0, 0.12, nsl + 1)
    tones[r.random(nsl + 1) < 0.18] += 0.09
    tmap = np.where(sid >= 0, tones[np.clip(sid, 0, nsl)], 0.0).astype(F32) * slab_a
    tmap = tmap * (1 + 0.35 * wob)
    tmap = ik.edge_darken(tmap, 3.0, 1.1, wrap_x=True)
    cv.over(ik.WASH, clamp01(ik.granulate(tmap, g, 0.5)))
    # broad ink-wash stains spanning slabs
    st = fbm(h, w, 90.0, 4, seed=24, wrap_x=True)
    stm = ik.wash_shape(smoothstep(0.7, 1.3, st), 25, warp_amp=6, warp_sigma=14, soft=2.0,
                        edge=0.3, wrap_x=True)
    cv.over(ik.WASH, clamp01(ik.edge_darken(0.12 * stm, 3.0, 1.2, wrap_x=True)))
    # dry-brush joint outlines and cracks
    idx = sd["idx"]
    a = sd["a"]
    ink = ik.dry_brush(sd, seed=26, bristles=10, along=30, dry_start=0.3, dryness=0.55,
                       base_load=0.3, edge_dry=0.25, soft=0.1)
    is_o = ((idx >= 0) & (idx < no)).astype(F32)
    is_c = ((idx >= no) & (idx < no + nc)).astype(F32)
    is_t = (idx >= no + nc).astype(F32)
    lw = rng(41).uniform(0.35, 1.0, len(strokes) + 1)
    weight = np.where(idx >= 0, lw[np.clip(idx, 0, len(strokes))], 0.0).astype(F32)
    cv.over(ik.INK, clamp01(0.8 * ink * is_o * weight))
    cv.over(ik.INK, clamp01(0.62 * a * is_c))
    # moss dots (muted jade-ink) and grass tufts
    moss_col = ik.lerp(ik.JADE, ik.INK2, 0.55)
    mr = rng(27)
    mx = np.array([p[0] for p in moss_pts])
    mz = np.array([p[1] for p in moss_pts])
    dots = np.zeros((h, w), F32)
    xx, yy = ik.grid(h, w)
    for x0, z0 in zip(mx, mz):
        for j in range(mr.integers(3, 8)):
            px = (x0 + mr.normal(0, 7)) % w
            pz = z0 + mr.normal(0, 3)
            rr = mr.uniform(1.2, 3.2)
            ys = slice(int(max(pz - 6, 0)), int(min(pz + 7, h)))
            xs = slice(int(max(px - 6, 0)), int(min(px + 7, w)))
            dx = xx[ys, xs] - px
            dy = yy[ys, xs] - pz
            dots[ys, xs] = np.maximum(dots[ys, xs], clamp01(rr - np.hypot(dx, dy * 1.4)))
    cv.over(moss_col, clamp01(0.7 * dots))
    cv.over(ik.INK2, clamp01(0.8 * a * is_t))
    # near-edge darkening (bottom = toward the camera)
    zw = lay.FLOOR["zFar"] + (np.arange(h)[:, None] + 0.5) / h * depth
    near = smoothstep(2.0, 8.0, zw + 0.6 * gnoise(h, w, 110.0, 40.0, seed=28, wrap_x=True))
    cv.over(ik.INK2, clamp01(0.42 * near ** 1.2 * (1 + 0.2 * wob)))
    # far edge: a faint worn rim, then the plateau dissolves into mist
    lipz = row_edges[0]
    rim = smoothstep(lipz - 0.9, lipz - 0.25, zw) * (1 - smoothstep(lipz - 0.2, lipz + 0.1, zw))
    rim = rim * clamp01(0.6 + 0.6 * gnoise(h, w, 10.0, seed=29, wrap_x=True))
    cv.over(ik.WASH, clamp01(0.22 * blur(rim, 1.5, wrap_x=True)))
    fz = zw + 0.35 * gnoise(h, w, 30.0, 12.0, seed=31, wrap_x=True)
    fade = 1 - smoothstep(-9.0, lipz + 1.4, fz)
    cv.over(ik.MIST, clamp01(fade ** 1.4))
    # stretch the design canvas to the final texture (features become 3x longer along z)
    out = ik.resize(cv.rgb, H, W, wrap_x=True)
    out = clamp01(out)
    path = lay.out_dir() + "/floor.webp"
    ik.save_image(out, path, 85)
    ik.save_image(out, ik.WORK + "/prev_floor.png")
    # seam check
    seam = float(np.abs(out[:, 0] - out[:, -1]).mean())
    ik.log(f"floor seam mean |L-R| = {seam:.4f}")
    return out


def slab_poly(x0, x1, z0, z1, gap, r):
    """Softly irregular rectangle (design px) inset by gap/2, optional chipped / worn corner.
    Edges wobble with smooth low-frequency curves (hand-drawn, not jagged)."""
    g = gap / 2 + r.uniform(0, 1.2)
    x0, x1, z0, z1 = x0 + g, x1 - g, z0 + g, z1 - g
    pts = []
    n = 12
    for (ax, az, bx, bz) in [(x0, z0, x1, z0), (x1, z0, x1, z1), (x1, z1, x0, z1),
                             (x0, z1, x0, z0)]:
        L = math.hypot(bx - ax, bz - az)
        nx, nz = -(bz - az) / L, (bx - ax) / L
        ph = r.uniform(0, 2 * np.pi, 2)
        amp = r.uniform(0.6, 2.2)
        for t in np.linspace(0, 1, n, endpoint=False):
            off = amp * (math.sin(np.pi * 2 * t + ph[0]) * 0.6 + math.sin(np.pi * 5 * t + ph[1])
                         * 0.25) * math.sin(np.pi * t)
            pts.append([ax + (bx - ax) * t + nx * off, az + (bz - az) * t + nz * off])
    pts = np.array(pts)
    if r.random() < 0.45:                               # chipped corner
        c = r.integers(0, 4) * n
        k = r.integers(2, 4)
        idx = [(c + j) % len(pts) for j in range(-k + 1, k)]
        cut_a, cut_b = pts[idx[0]], pts[idx[-1]]
        mid = (cut_a + cut_b) / 2 + (pts[c] - (cut_a + cut_b) / 2) * r.uniform(0.0, 0.3)
        keep = [i for i in range(len(pts)) if i not in idx[1:-1]]
        new = []
        for i in keep:
            new.append(pts[i])
            if i == idx[0]:
                new.append(mid)
        pts = np.array(new)
    return pts


def split_poly(poly, r):
    """Split a slab polygon along a jagged crack between two opposite edges."""
    n = len(poly)
    i = r.integers(0, n // 4) + r.choice([0, n // 2])
    j = (i + n // 2 + r.integers(-3, 4)) % n
    a, b = poly[i], poly[j]
    t = np.linspace(0, 1, 9)[:, None]
    d = b - a
    nrm = np.array([-d[1], d[0]]) / (np.linalg.norm(d) + 1e-9)
    crack = a + d * t + nrm * r.normal(0, 3.0, (9, 1)) * np.sin(np.pi * t)
    gap = nrm * 1.2
    if i < j:
        p1 = np.concatenate([poly[i:j + 1], (crack[::-1] + gap)[1:-1]])
        p2 = np.concatenate([poly[j:], poly[:i + 1], (crack - gap)[1:-1]])
    else:
        p1 = np.concatenate([poly[i:], poly[:j + 1], (crack[::-1] + gap)[1:-1]])
        p2 = np.concatenate([poly[j:i + 1], (crack - gap)[1:-1]])
    return p1, p2, (crack, np.full(len(crack), 1.8) * np.array([0.3, 1, 1, 1, 1, 1, 1, 1, 0.3]))


def broken_outline(poly, r):
    """Slab outline as several separate brush strokes with gaps (not a closed CG line)."""
    P = np.concatenate([poly, poly[:1]])
    n = len(P)
    out = []
    i = r.integers(0, 6)
    while i < n - 3:
        L = r.integers(3, 10)
        seg = P[i:min(i + L, n)]
        if len(seg) >= 3:
            seg = ik.resample_polyline(seg, 3.0)
            m = len(seg)
            wd = ik.taper(m, r.uniform(1.3, 2.8), start=0.15, end=0.3, start_w=0.3, end_w=0.1)
            if r.random() < 0.6:
                out.append((seg, wd))
        i += L + r.integers(2, 7)
    return out


def crack_path(x, z, length, r):
    a = r.uniform(0, 2 * np.pi)
    pts = [np.array([x, z])]
    n = 10
    for i in range(n):
        a += r.normal(0, 0.45)
        pts.append(pts[-1] + length / n * np.array([math.cos(a), math.sin(a)]))
    pts = np.array(pts)
    return pts, np.linspace(1.6, 0.3, len(pts))


def tuft(x, z, r, ppm):
    out = []
    H = ppm * r.uniform(0.10, 0.2)
    for b in range(r.integers(5, 10)):
        a = -math.pi / 2 + r.normal(0, 0.55)
        L = H * r.uniform(0.5, 1.0)
        p0 = np.array([x + r.normal(0, 3), z + r.normal(0, 1.5)])
        t = np.linspace(0, 1, 6)[:, None]
        d = np.array([math.cos(a), math.sin(a)])
        nrm = np.array([-d[1], d[0]])
        pts = p0 + d * L * t + nrm * r.normal(0, 0.2) * L * t ** 2
        out.append((pts, np.linspace(1.8, 0.3, 6)))
    return out
