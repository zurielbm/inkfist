"""Cloud Peak MID layer: granite pillars (Huangshan-like), mid-distance ridge, cloud sea,
pines on summits/ledges, a hanging 'welcoming' pine and a tiny crimson pavilion."""
import numpy as np

import inklib as ik
from inklib import F32, blur, gnoise, fbm, smoothstep, clamp01, rng
import cp_layout as lay
from cp_ranges import (EYE, ridged, range_mesh, add_object, cloud_sea, render_passes,
                       soft_mask, finish_layer, layer_height, paint_mountain, paint_clouds,
                       cloud_contours)


def pillar_mesh(name, x, dist, z_bot, z_top, R, seed, nh=240, nt=180, squash=0.75):
    """Parametric craggy pillar: rings around a vertical axis, radius displaced by vertical
    ridged noise (granite joints), terraces (ledges), a frontal cleft, slight lean and a
    per-pillar summit shape (domed / flat / pointed)."""
    r = rng(seed)
    taper = r.uniform(0.30, 0.62)
    lean = r.uniform(-0.25, 0.25)
    t = np.linspace(0, 1, nh)[:, None]
    th = np.linspace(0, 2 * np.pi, nt + 1)[None, :] + np.pi / 2       # seam faces away
    prof = 1 - taper * t ** 1.25
    cap0 = r.uniform(0.74, 0.86)
    cap_pow = r.choice([0.35, 0.6, 1.1])          # flat-ish / domed / pointed summit
    capf = np.clip(1 - ((t - cap0) / (1 - cap0)) ** 2, 0, 1) ** (0.5 * cap_pow)
    prof = prof * np.where(t > cap0, capf, 1.0)
    rib = ridged(nh, nt, 2.0, 22.0, seed + 1, 3)
    rib = np.concatenate([rib, rib[:, :1]], 1)
    lump = fbm(nh, nt, 10.0, 4, seed=seed + 2, wrap_x=True)
    lump = np.concatenate([lump, lump[:, :1]], 1)
    st = np.cumsum(np.abs(r.standard_normal(nh)) ** 3)
    st = (st - st.min()) / (st.max() - st.min() + 1e-9)
    terr = np.floor(st * 6) / 6 - st
    thc = -np.pi / 2 + r.uniform(-0.6, 0.6)       # cleft roughly facing the camera
    dth = np.angle(np.exp(1j * (th - thc)))
    cleft = 1 - (r.uniform(0.15, 0.35) * np.exp(-(dth / 0.18) ** 2) * smoothstep(0.05, 0.5, t)
                 * (1 - smoothstep(cap0 - 0.05, cap0 + 0.05, t)))
    rr = R * prof * cleft * (1 + 0.26 * (rib - 0.55) + 0.12 * lump + 0.16 * terr[:, None])
    rr = np.maximum(rr, 0.0)
    X = x + rr * np.cos(th) + lean * R * t ** 1.5
    Y = (dist - EYE[2]) + rr * np.sin(th) * squash
    top_bump = 0.02 * (z_top - z_bot) * lump * ((t > cap0) & (t < 0.97))
    Z = z_bot + (z_top - z_bot) * t + top_bump
    Z = np.ascontiguousarray(np.broadcast_to(Z, X.shape), F32)
    return ik.grid_mesh(name, X.astype(F32), Y.astype(F32), Z)


# x, top y (quad metres), half width (quad metres), distance from eye
MID_PILLARS = [
    dict(idx=11, x=-12.0, top=12.6, hw=2.5, dist=95.0),
    dict(idx=12, x=-17.6, top=9.4, hw=2.3, dist=122.0),
    dict(idx=13, x=-8.7, top=6.4, hw=1.45, dist=74.0),
    dict(idx=14, x=-22.4, top=7.6, hw=2.5, dist=108.0),
    dict(idx=15, x=-26.0, top=10.8, hw=2.4, dist=140.0),
    dict(idx=16, x=12.8, top=9.0, hw=2.1, dist=90.0),
    dict(idx=17, x=9.0, top=4.6, hw=1.3, dist=68.0),
    dict(idx=18, x=17.4, top=6.8, hw=2.3, dist=114.0),
    dict(idx=19, x=22.2, top=10.2, hw=2.5, dist=132.0),
    dict(idx=20, x=26.4, top=6.4, hw=2.3, dist=118.0),
    dict(idx=21, x=-4.4, top=1.3, hw=0.9, dist=58.0),
    dict(idx=22, x=5.0, top=0.9, hw=0.8, dist=54.0),
]
MID_RIDGE = dict(idx=5, dist=230.0, base=0.6, rough=0.3, seed=505,
                 peaks=[(-21, 6.4, 6, 2.0), (-10, 4.0, 5, 1.8), (-2, 2.4, 4, 1.5), (9, 3.6, 5, 1.8),
                        (20, 5.8, 6, 2.0), (29, 4.8, 5, 1.8)])
PAVILION_ON = 16
HANGING_PINE = dict(pillar=11, y=7.4, size=2.6)


def mid_layer():
    name = "mid"
    L = lay.LAYERS[name]
    w, h = L["size"]
    qd = EYE[2] - L["z"]
    ik.reset_scene()
    ik.quad_camera(L["rect"], L["z"], EYE)
    z_cloud = EYE[1] + (0.15 - EYE[1]) * 80.0 / qd
    mat = ik.mat_diffuse()
    for i, p in enumerate(MID_PILLARS):
        s = p["dist"] / qd
        z_top = EYE[1] + (p["top"] - EYE[1]) * s
        z_bot = z_cloud - 0.5 * (z_top - z_cloud) - 5
        me = pillar_mesh(f"pillar{p['idx']}", p["x"] * s, p["dist"], z_bot, z_top, p["hw"] * s,
                         seed=600 + 7 * i)
        add_object(me, p["idx"], mat)
    R = MID_RIDGE
    add_object(range_mesh("ridge", R["dist"], R["peaks"], R["base"], z_cloud, R["seed"],
                          rough=R["rough"], q_dist=qd, extent=30.0), R["idx"], mat)
    cloud_sea(z_cloud, 32.0, 260.0, 650, 88, size=(0.03, 0.07), lift=0.22, extent=30.0,
              q_dist=qd, mat=mat)
    P = render_passes(name, w, h, light_dir=(-0.82, 0.22, -0.52), sun=3.6, ambient=0.22)
    return paint_mid(P, w, h, qd)


def summit(mask):
    """Topmost silhouette point (col, row) of a boolean mask."""
    rows = np.where(mask.any(1))[0]
    if len(rows) == 0:
        return None
    r0 = rows[0]
    cols = np.where(mask[r0])[0]
    return float(cols.mean()), float(r0)


def top_edge_points(mask, step=6):
    """(col, row) of the top silhouette for every `step`-th column of the mask."""
    pts = []
    any_c = mask.any(0)
    first = np.argmax(mask, 0)
    for c in range(0, mask.shape[1], step):
        if any_c[c]:
            pts.append((c, int(first[c])))
    return pts


def stamp_dots(h, w, ys, xs, r, rmin=1.0, rmax=2.6):
    dots = np.zeros((h, w), F32)
    for y0, x0 in zip(ys, xs):
        rr = r.uniform(rmin, rmax)
        sl = (slice(max(y0 - 4, 0), min(y0 + 5, h)), slice(max(x0 - 5, 0), min(x0 + 6, w)))
        yy, xx = np.mgrid[sl]
        dots[sl] = np.maximum(dots[sl], clamp01(rr - np.hypot((xx - x0) * 0.8, yy - y0)))
    return dots


def mist_bands(name, bands, seed):
    L = lay.LAYERS[name]
    w, h = L["size"]
    yrow = lay.row_grid_y(name)[:, None]
    xcol = lay.col_grid_x(name)[None, :]
    band = np.zeros((h, w), F32)
    for (yc, hh, x0, x1, a) in bands:
        prof = np.exp(-((yrow - yc) / hh) ** 2) * smoothstep(x0, x0 + 3, xcol) \
            * (1 - smoothstep(x1 - 3, x1, xcol))
        band = np.maximum(band, a * prof)
    return band * clamp01(0.75 + 0.5 * fbm(h, w, 40.0, 4, seed=seed, aniso=4.0))


def paint_pines(cv, strokes, pads, ink_polys, red_polys, w, h, name, fog=None):
    import cp_pines as pines
    nstrokes = len(strokes)
    pad_polys = [pines.pad_polygon(*pd, rng(i + 900)) for i, pd in enumerate(pads)]
    polys = pad_polys + ink_polys + red_polys
    sd = ik.render_strokes(strokes, w, h, polys=polys, samples=24, name=name)
    idx = sd["idx"]
    n1 = nstrokes + len(pad_polys)
    n2 = n1 + len(ink_polys)
    is_stroke = ((idx >= 0) & (idx < nstrokes)).astype(F32)
    is_pad = ((idx >= nstrokes) & (idx < n1)).astype(F32)
    is_ink = ((idx >= n1) & (idx < n2)).astype(F32)
    is_red = (idx >= n2).astype(F32)
    a = sd["a"]
    f = 1.0 if fog is None else fog
    bark = ik.dry_brush(sd, seed=77, bristles=12, along=12, dry_start=0.7, dryness=0.5,
                        base_load=0.6, edge_dry=0.2, soft=0.15)
    padm = ik.wash_shape(a * is_pad, 78, warp_amp=1.2, warp_sigma=3.0, soft=0.7, edge=0.25)
    stip = smoothstep(-0.6, 0.8, gnoise(h, w, 1.1, seed=79))
    cv.over(ik.INK2, clamp01(0.55 * padm * f))
    cv.over(ik.INK, clamp01(ik.edge_darken(0.55 * padm * stip, 1.2, 0.8) * f))
    cv.over(ik.INK, clamp01(0.92 * bark * is_stroke * f))
    cv.over(ik.INK, clamp01(0.9 * a * is_ink * f))
    cv.over(ik.CRIMSON, clamp01(0.85 * a * is_red * f))


def paint_mid(P, w, h, qd):
    import cp_pines as pines
    cv = ik.Canvas(h, w, ik.MIST, 0.0)
    cv.over(ik.MIST, P["a"])
    S, Z, cls, N = P["S"], P["Z"], P["cls"], P["N"]
    g = ik.granulation(h, w, 7, fine=1.2, clump=4.0, mix=0.6)
    wobble = fbm(h, w, 70.0, 4, seed=8)
    paint_clouds(cv, P, 61, g, wobble, shade=0.08, line=0.16)
    R = MID_RIDGE
    m = soft_mask(cls == R["idx"], 0.6)
    fog = smoothstep(1.0, 4.4, layer_height(Z, R["dist"], qd))
    vis = np.where(cls == R["idx"], fog, 1.0).astype(F32)
    paint_mountain(cv, m, S, fog, tone=0.26, color=ik.COOL_INK,
                   levels=[(-1, 0, 1.0), (0.45, 0.62, 0.6)], crest=1.0, seed=R["seed"], g=g,
                   wobble=wobble)
    shadow = blur(clamp01(1 - S), 0.8)
    order = sorted(MID_PILLARS, key=lambda p: -p["dist"])
    allm = np.zeros((h, w), F32)
    fog_all = np.zeros((h, w), F32)
    streak = (smoothstep(1.0, 2.0, gnoise(h, w, 0.6, 9.0, seed=71))
              + 0.7 * smoothstep(1.3, 2.2, gnoise(h, w, 1.3, 5.0, seed=72)))
    side = smoothstep(-1.0, 1.0, gnoise(h, w, 6.0, seed=70))
    for p in order:
        mk = cls == p["idx"]
        m = soft_mask(mk, 0.6)
        yq = layer_height(Z, p["dist"], qd)
        near = clamp01((140.0 - p["dist"]) / 80.0)
        fog = smoothstep(1.6, 5.4 + 0.8 * near, yq)
        tone = 0.50 + 0.30 * near
        paint_mountain(cv, m, S, fog, tone=tone, color=ik.INK,
                       levels=[(-1, 0, 0.22), (0.36, 0.52, 0.62), (0.64, 0.80, 0.6)],
                       crest=0.0, seed=p["idx"] * 31, g=g, wobble=wobble, edge=0.9)
        cun = clamp01(streak) * smoothstep(0.22, 0.6, shadow) * m
        cv.over(ik.INK, clamp01(0.75 * tone * cun * fog))
        # confident silhouette line, heavier on the shadow (left) side
        edge = clamp01((m - blur(m, 1.3)) * 3.2)
        gx = np.gradient(blur(m, 2.0), axis=1)
        heavy = clamp01(0.55 + 6.0 * gx) * (0.6 + 0.4 * side)
        thick = clamp01((m - blur(m, 2.6)) * 2.6) * heavy
        cv.over(ik.INK, clamp01(0.95 * np.maximum(edge * (0.55 + 0.45 * side), thick) * fog))
        allm = np.maximum(allm, m)
        fog_all = np.where(mk, fog, fog_all)
        vis = np.where(mk, fog, vis)
    Sb = blur(S, 1.0)
    gy, gx = np.gradient(Sb)
    crease = clamp01((np.hypot(gx, gy) - 0.05) * 6.0) * allm
    crease = crease * smoothstep(-0.2, 1.2, gnoise(h, w, 3.0, seed=73))
    cv.over(ik.INK, clamp01(0.5 * crease * fog_all))
    rocky = cls >= 11
    cont = cloud_contours(P["dist"], rocky | (cls == 5), rel=0.03, hit=P["hit"])
    cont = blur(cont, 0.7) * (0.6 + 0.4 * smoothstep(-0.5, 1.0, gnoise(h, w, 5.0, seed=74)))
    cv.over(ik.INK, clamp01(0.75 * cont * fog_all))
    r = rng(75)
    up = (N[..., 2] > 0.55) & rocky & (fog_all > 0.5)
    ys, xs = np.nonzero(up)
    if len(xs):
        pick = r.choice(len(xs), size=min(900, len(xs)), replace=False)
        dots = stamp_dots(h, w, ys[pick], xs[pick], r)
        cv.over(ik.INK, clamp01(0.85 * dots * fog_all))
    band = mist_bands("mid", [(3.3, 0.9, -27, -6.5, 0.85), (5.6, 0.55, -21, -9, 0.55),
                              (2.7, 0.8, 7, 27, 0.8), (4.6, 0.45, 15, 25, 0.5)], 76)
    cv.over(ik.MIST, clamp01(band) * clamp01(cv.a))
    # misty bases of rocks dissolve to transparency (the far layer's mist shows through)
    clouds = (cls == 8) | (cls == 9)
    keep = np.where(clouds, 1.0, smoothstep(0.0, 0.45, blur(vis, 1.0)))
    cv.a = (cv.a * keep).astype(F32)
    # pines on summits and ledges + hanging pine + pavilion
    strokes, pads, red_polys, ink_polys = [], [], [], []
    ppm = lay.px_per_m("mid")
    for p in MID_PILLARS:
        if p["top"] < 3:
            continue
        mk = cls == p["idx"]
        sm = summit(mk)
        if sm is None:
            continue
        size = ppm * (0.9 + 0.5 * clamp01((140 - p["dist"]) / 80)) * 1.2
        if p["idx"] == PAVILION_ON:
            ink, red, st = pines.pavilion(sm[0], sm[1] + 3, ppm * 1.0, 9)
            ink_polys += ink
            red_polys += red
            strokes += st
            continue
        edge = [q for q in top_edge_points(mk, 5) if abs(q[0] - sm[0]) < ppm * p["hw"] * 0.9]
        rr = rng(p["idx"])
        rr.shuffle(edge)
        chosen = []
        for (c, rw) in edge:
            if all(abs(c - c2) > size * 0.7 for c2, _ in chosen):
                chosen.append((c, rw))
            if len(chosen) >= 2:
                break
        for j, (c, rw) in enumerate(chosen):
            pn = pines.pine((c, rw + 2), size * rr.uniform(0.8, 1.2), seed=p["idx"] * 10 + j,
                            lean=rr.uniform(-0.35, 0.35), spread=1.1)
            strokes += pn["trunk"] + pn["branches"]
            pads += pn["pads"]
    hp = HANGING_PINE
    mk = cls == hp["pillar"]
    cy = int(lay.to_px("mid", 0, hp["y"])[1])
    cols = np.where(mk[cy])[0]
    if len(cols):
        pn = pines.pine((cols.max() - 3, cy), ppm * hp["size"], seed=4242, lean=1.15,
                        spread=1.25, hang=True)
        strokes += pn["trunk"] + pn["branches"]
        pads += pn["pads"]
    paint_pines(cv, strokes, pads, ink_polys, red_polys, w, h, "mid_pines")
    return finish_layer(cv, "mid")
