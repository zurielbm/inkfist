"""Cloud Peak far + mid mountain layers.

3D forms are built procedurally (numpy heightfields / displaced pillar meshes / billow
ellipsoids), rendered with Cycles through a camera whose frame is exactly the layer quad seen
from the default game eye, then painted in numpy: aerial-perspective washes, pigment edge
darkening, granulation, dry-brush cun texture, mist, and finally saved as RGBA WebP.
"""
import math

import numpy as np
import bpy

import inklib as ik
from inklib import F32, blur, gnoise, fbm, smoothstep, clamp01, rng
import cp_layout as lay

EYE = lay.EYE


# --------------------------------------------------------------------------------------------
# geometry helpers
# --------------------------------------------------------------------------------------------
def noise1d(n, sigma, seed):
    return gnoise(4, n, sigma, 1.0, seed=seed)[1]


def ridged(h, w, sx, sy, seed, octaves=3):
    acc = np.zeros((h, w), F32)
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        n = gnoise(h, w, sx / 2 ** o, sy / 2 ** o, seed=seed + 17 * o)
        r = 1.0 - np.abs(n) / 1.2
        acc += amp * r
        norm += amp
        amp *= 0.5
    return acc / norm


def crest_profile(xL, peaks, base, rough, seed):
    """Layer-space crest height for each x: union of rounded, slightly asymmetric peak
    profiles (long concave flanks, soft summit) plus ridged 1D roughness."""
    r = rng(seed)
    y = np.full_like(xL, base, dtype=np.float64)
    for (px, py, hw, k) in peaks:
        skew = r.uniform(-0.35, 0.35)
        u = (xL - px) / hw
        u = u * np.where(u < 0, 1 + skew, 1 - skew)
        prof = 1.0 / (1.0 + (np.abs(u) * 1.7) ** (1.0 + k * 0.55))
        y = np.maximum(y, base + (py - base) * prof)
        # a shoulder / sub-peak on one side
        side = r.choice([-1, 1])
        sx = px + side * hw * r.uniform(0.45, 0.8)
        su = (xL - sx) / (hw * 0.35)
        y = np.maximum(y, base + (py - base) * r.uniform(0.45, 0.7) / (1 + (np.abs(su) * 1.7) ** 1.8))
    n1 = 1 - np.abs(noise1d(len(xL), len(xL) / 80.0, seed))
    n2 = 1 - np.abs(noise1d(len(xL), len(xL) / 300.0, seed + 1))
    n = 0.65 * n1 + 0.35 * n2 - 0.45
    return y + rough * n * np.clip((y - base) / 2.0, 0.15, 1.0)


def range_mesh(name, dist, peaks, base_L, z_cloud, seed, nx=1500, ny=320, rough=0.35,
               spur=0.20, depth_front=0.30, depth_back=0.22, extent=46.0, q_dist=50.0):
    """Heightfield mountain range whose crest, seen from EYE, follows `peaks` (layer space of
    the quad at distance q_dist)."""
    s = dist / q_dist
    X = np.linspace(-extent * s, extent * s, nx)
    xL = X / s
    crestL = crest_profile(xL, peaks, base_L, rough, seed)
    Zc = EYE[1] + (crestL - EYE[1]) * s
    Zb = z_cloud - 0.35 * (Zc.max() - z_cloud)
    Yc = (dist - EYE[2]) + 0.05 * dist * noise1d(nx, nx / 25.0, seed + 5)
    Wf, Wb = depth_front * dist, depth_back * dist
    Y = np.linspace(Yc.min() - Wf, Yc.max() + Wb, ny)
    XX, YY = np.meshgrid(X, Y)
    u = (YY - Yc[None, :])
    u = np.where(u < 0, -u / Wf, u / Wb)
    cross = np.clip(1 - np.abs(u) ** 1.35, 0, 1)
    ZZ = Zb + (Zc[None, :] - Zb) * cross
    rel = np.clip((ZZ - Zb) / max(Zc.max() - Zb, 1e-6), 0, 1)
    sp = ridged(ny, nx, 5.0, 26.0, seed + 9, 3)
    fine = fbm(ny, nx, 6.0, 4, seed=seed + 11)
    ZZ = ZZ + (Zc.max() - Zb) * rel * (spur * (sp - 0.55) + 0.025 * fine)
    me = ik.grid_mesh(name, XX.astype(F32), YY.astype(F32), ZZ.astype(F32))
    return me


def ellipsoid_soup(name, centers, radii, seg=18, ring=10):
    """One mesh containing many UV ellipsoids (cloud billows)."""
    th = np.linspace(0, 2 * np.pi, seg, endpoint=False)
    ph = np.linspace(0, np.pi, ring + 1)[1:-1]
    unit = [np.array([0, 0, 1.0])]
    for p in ph:
        for t in th:
            unit.append(np.array([math.sin(p) * math.cos(t), math.sin(p) * math.sin(t),
                                  math.cos(p)]))
    unit.append(np.array([0, 0, -1.0]))
    unit = np.array(unit)
    nv = len(unit)
    faces = []
    for t in range(seg):
        faces.append([0, 1 + t, 1 + (t + 1) % seg])
    for r in range(ring - 2):
        for t in range(seg):
            a = 1 + r * seg + t
            b = 1 + r * seg + (t + 1) % seg
            faces.append([a, a + seg, b + seg, b])
    last = nv - 1
    off = 1 + (ring - 2) * seg
    for t in range(seg):
        faces.append([off + t, last, off + (t + 1) % seg])
    C = np.asarray(centers, np.float64)
    Rr = np.asarray(radii, np.float64)
    verts = (unit[None] * Rr[:, None, :] + C[:, None, :]).reshape(-1, 3)
    fsz = np.array([len(f) for f in faces], np.int32)
    floop = np.concatenate([np.asarray(f) for f in faces])
    k = len(C)
    sizes = np.tile(fsz, k)
    loops = (floop[None, :] + (np.arange(k) * nv)[:, None]).ravel()
    me = ik.mesh_from_arrays(name, verts, sizes, loops)
    if hasattr(me, "shade_smooth"):
        me.shade_smooth()
    return me


def add_object(me, pass_index, mat):
    ob = ik.link(bpy.data.objects.new(me.name, me))
    ob.pass_index = pass_index
    me.materials.append(mat)
    return ob


def cloud_sea(z_cloud, d0, d1, n, seed, size=(0.02, 0.06), lift=0.25, extent=48.0,
              q_dist=50.0, pass_index=9, mat=None):
    """Billow ellipsoids on the cloud level plus a flat cloud floor reaching the horizon."""
    r = rng(seed)
    cen, rad = [], []
    for i in range(n):
        dist = math.exp(r.uniform(math.log(d0), math.log(d1)))
        x = r.uniform(-extent, extent) * dist / q_dist
        R = dist * r.uniform(*size)
        cen.append((x, dist - EYE[2], z_cloud + R * r.uniform(-0.1, lift)))
        rad.append((R * r.uniform(1.2, 2.2), R * r.uniform(0.8, 1.4), R * r.uniform(0.35, 0.6)))
    me = ellipsoid_soup("billows", cen, rad)
    add_object(me, pass_index, mat)
    # flat cloud floor (class 8)
    big = 1.0e5
    verts = np.array([[-big, -EYE[2] + 1.0, z_cloud - 0.5], [big, -EYE[2] + 1.0, z_cloud - 0.5],
                      [big, big, z_cloud - 0.5], [-big, big, z_cloud - 0.5]], F32)
    pm = ik.mesh_from_arrays("cloudfloor", verts, np.array([4]), np.array([0, 1, 2, 3]))
    add_object(pm, 8, mat)


REUSE = [False]   # set by build --reuse: load cached passes instead of re-rendering


def render_passes(name, w, h, light_dir=(-0.55, 0.5, -0.65), sun=3.2, ambient=0.35,
                  samples=64):
    """Lit pass (shade + coverage) and exact data pass (Z, distance, class)."""
    import os
    cache = ik.WORK + f"/{name}_passes.npz"
    if REUSE[0] and os.path.exists(cache):
        ik.log("reusing cached passes", cache)
        z = np.load(cache)
        return {k: z[k] for k in z.files}
    P = _render_passes(name, w, h, light_dir, sun, ambient, samples)
    np.savez(cache, **P)
    return P


def _render_passes(name, w, h, light_dir, sun, ambient, samples):
    sc = bpy.context.scene
    ik.sun_light(light_dir, sun, 3.0)
    ik.set_world_color((1, 1, 1), ambient)
    ik.setup_cycles(samples=samples, denoise=True, bounces=2, filter_width=1.2)
    lit = ik.render_exr(name + "_lit", w, h)
    vl = bpy.context.view_layer
    vl.material_override = ik.mat_data()
    ik.setup_cycles(samples=1, denoise=False, bounces=0, filter_width=0.01)
    data = ik.render_exr(name + "_data", w, h)
    vl.material_override = ik.mat_normal()
    nrm = ik.render_exr(name + "_nrm", w, h)
    vl.material_override = None
    a = clamp01(lit[..., 3])
    rgb = lit[..., :3] / np.maximum(a, 1e-4)[..., None]
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722], F32)
    ref = np.percentile(lum[a > 0.5], 99.0) if (a > 0.5).any() else 1.0
    S = clamp01(lum / max(ref, 1e-6))
    hit = data[..., 3] > 0.5
    return dict(a=a, S=S, Z=data[..., 0], dist=data[..., 1],
                cls=np.where(hit, np.rint(data[..., 2]), 0).astype(np.int32),
                N=nrm[..., :3], hit=hit)


def soft_mask(m, s=0.7):
    return clamp01(blur(m.astype(F32), s))


def finish_layer(cv, name, stage="cloudpeak", quality=85):
    rgb = ik.dilate_rgb(cv.rgb, cv.a, fallback=ik.MIST)
    out = np.concatenate([rgb, cv.a[..., None]], -1)
    path = lay.out_dir(stage) + f"/{name}.webp"
    ik.save_image(out, path, quality)
    # review image over the sky colour
    prev = rgb * cv.a[..., None] + ik.MIST * (1 - cv.a[..., None])
    ik.save_image(prev, ik.WORK + f"/prev_{name}.png")
    return out


# --------------------------------------------------------------------------------------------
# FAR layer
# --------------------------------------------------------------------------------------------
FAR_RANGES = [
    # crest peaks (x, y_top, half width, sharpness) in far-quad metres; fog in quad metres above
    # the range's cloud line; levels = posterised wash bands (shadow lo, hi, strength)
    dict(idx=1, dist=1000.0, base=1.2, rough=0.10, seed=101, tone=0.14, color=ik.COOL_INK,
         fog=(1.4, 4.6), crest=0.9, levels=[(-1, 0, 1.0), (0.50, 0.70, 0.45)],
         peaks=[(-46, 5.0, 8, 1.6), (-35, 6.0, 7, 1.7), (-24, 7.4, 8, 1.8), (-12, 5.6, 7, 1.5),
                (-1, 4.6, 8, 1.4), (11, 5.2, 7, 1.6), (22, 6.4, 8, 1.7), (34, 7.0, 7, 1.6),
                (46, 5.6, 8, 1.6)]),
    dict(idx=2, dist=520.0, base=0.8, rough=0.14, seed=202, tone=0.22, color=ik.COOL_INK,
         fog=(1.0, 4.4), crest=1.0, levels=[(-1, 0, 1.0), (0.48, 0.66, 0.55)],
         peaks=[(-39, 7.0, 6.0, 1.9), (-29, 9.6, 6.5, 2.1), (-18, 6.4, 5.5, 1.8), (-7, 3.6, 5, 1.5),
                (5, 3.2, 5, 1.5), (16, 5.2, 5.5, 1.9), (28, 7.6, 6.5, 2.0), (40, 6.0, 6, 1.8)]),
    dict(idx=3, dist=240.0, base=-0.6, rough=0.30, seed=303, tone=0.34, color=ik.INK2,
         fog=(0.2, 4.2), crest=1.2, levels=[(-1, 0, 0.8), (0.42, 0.6, 0.6), (0.66, 0.82, 0.55)],
         peaks=[(-26, 10.4, 5.0, 2.3), (-34, 7.4, 4.0, 2.0), (-18.5, 5.2, 3.0, 2.0),
                (24, 6.8, 4.2, 2.2), (34, 8.8, 4.8, 2.1)]),
]


def far_layer():
    name = "far"
    L = lay.LAYERS[name]
    w, h = L["size"]
    qd = EYE[2] - L["z"]
    ik.reset_scene()
    ik.quad_camera(L["rect"], L["z"], EYE)
    z_cloud = EYE[1] + (0.0 - EYE[1]) * 240.0 / qd    # range C bases vanish at y=0 on the quad
    mat = ik.mat_diffuse()
    for R in FAR_RANGES:
        me = range_mesh(f"range{R['idx']}", R["dist"], R["peaks"], R["base"], z_cloud, R["seed"],
                        rough=R["rough"], q_dist=qd, spur={1: 0.09, 2: 0.12, 3: 0.2}[R["idx"]])
        add_object(me, R["idx"], mat)
    cloud_sea(z_cloud, 70.0, 420.0, 520, 77, size=(0.025, 0.06), lift=0.12, q_dist=qd, mat=mat)
    P = render_passes(name, w, h, light_dir=(-0.5, 0.3, -0.8))
    return paint_far(P, z_cloud, w, h, qd)


def layer_height(Z, dist, qd):
    """World height of a point at `dist` projected onto the quad at distance qd."""
    return EYE[1] + (Z - EYE[1]) * qd / dist


def paint_mountain(cv, m, S, fog, *, tone, color, levels, crest, seed, g, wobble,
                   gran=0.12, edge=0.7):
    """Layered wet washes from the render shading: each level is a separate glaze with its own
    irregular wet edge, pigment rim and granulation; fog fades everything into mist."""
    shadow = blur(clamp01(1.0 - S), 1.0)
    for i, (lo, hi, amt) in enumerate(levels):
        if lo < 0:
            mask = m
        else:
            mask = smoothstep(lo, hi, shadow) * m
            mask = ik.wash_shape(mask, seed + 13 * i, warp_amp=2.5, warp_sigma=7.0, soft=1.0,
                                 edge=0.22, jitter=0.04)
        d = amt * tone * mask * (1 + 0.15 * wobble)
        d = ik.edge_darken(d, 1.6, edge)
        d = ik.granulate(d, g, gran)
        cv.over(color, clamp01(d * fog))
    if crest:
        band = clamp01(m - blur(m, 1.4)) * 2.2
        band = band * (0.7 + 0.3 * smoothstep(-1, 1, gnoise(*m.shape, 4.0, seed=seed + 99)))
        cv.over(color, clamp01(crest * tone * band * fog))


def cloud_contours(dist, cls_mask, rel=0.04, hit=None):
    """Occluding contours from the distance pass: pixels of `cls_mask` whose neighbour (above,
    left or right) is a farther surface.  Empty sky counts as 'nothing' (no contour)."""
    hit = (dist > 0) if hit is None else hit
    D = np.where(hit, dist, 0.0)
    up = np.vstack([D[:1], D[:-1]])
    lf = np.hstack([D[:, :1], D[:, :-1]])
    rt = np.hstack([D[:, 1:], D[:, -1:]])
    j = np.maximum(np.maximum(up - D, lf - D), rt - D) / np.maximum(D, 1e-3)
    return clamp01((j - rel) * 4.0) * cls_mask


def paint_clouds(cv, P, seed, g, wobble, *, shade=0.07, line=0.12, color=None):
    color = ik.COOL_INK if color is None else color
    cls = P["cls"]
    cm = soft_mask((cls == 9) | (cls == 8), 0.6)
    hh = cm.shape[0]
    cm = cm * (1 - smoothstep(0.62, 0.82, (np.arange(hh) / hh)[:, None]))
    shadow = clamp01(1.0 - P["S"])
    sh = blur(smoothstep(0.25, 0.85, shadow), 2.0) * cm
    d = ik.granulate(sh * shade * (1 + 0.3 * wobble), g, 0.5)
    cv.over(color, clamp01(d))
    c = cloud_contours(P["dist"], (cls == 9) | (cls == 8), hit=P["hit"])
    c = blur(c, 0.9)
    c = clamp01(c * 2.0) * (0.55 + 0.45 * smoothstep(-0.5, 1.0, gnoise(*c.shape, 6.0,
                                                                           seed=seed)))
    under = clamp01(blur(np.vstack([c[3:], np.zeros((3, c.shape[1]), F32)]), 4.0, 2.0) * 1.5)
    cv.over(color, clamp01(ik.granulate(under * shade * 1.3, g, 0.5)) * cm)
    cv.over(color, clamp01(ik.edge_darken(c * line, 1.2, 0.5)) * cm)


def paint_far(P, z_cloud, w, h, qd):
    cv = ik.Canvas(h, w, ik.MIST, 0.0)
    cv.over(ik.MIST, P["a"])
    S, Z, cls = P["S"], P["Z"], P["cls"]
    g = ik.granulation(h, w, 5, fine=1.2, clump=4.0, mix=0.6)
    wobble = fbm(h, w, 60.0, 4, seed=6)
    paint_clouds(cv, P, 51, g, wobble, shade=0.05, line=0.08)
    for R in FAR_RANGES:
        m = soft_mask(cls == R["idx"], 0.6)
        if m.max() <= 0:
            continue
        yq = layer_height(Z, R["dist"], qd)
        fog = smoothstep(R["fog"][0], R["fog"][1], yq)
        paint_mountain(cv, m, S, fog, tone=R["tone"], color=R["color"], levels=R["levels"],
                       crest=R["crest"], seed=R["seed"], g=g, wobble=wobble)
    return finish_layer(cv, "far")
