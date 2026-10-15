"""Reusable outfit pieces built on garment.py: dressing proxy, split skirts on spring chains, lined finishing,
bell sleeves, parametric footwear and small props."""
import math

import numpy as np

from . import garment as G
from . import skin
from .assemble import hem_distance
from .part import Part


def smoothstep(e0, e1, x):
    t = np.clip((np.asarray(x, float) - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def dressing_proxy(b, R, torso_iters=6, feet_iters=25):
    """Body with anatomy relaxed away where clothes go (feet lose their toes). Clothes rest on it; a small hard
    clearance against the real body then guarantees no poke-through."""
    co = b.co
    adj = [b.topo.adj[i] for i in range(b.topo.nv)]
    under = (1 - smoothstep(0.15, 0.45, R.headneck + R.hands)) * (1 - smoothstep(0.3, 0.6, R.arms) * 0.6)
    proxy = G.laplacian(co, adj, torso_iters, 0.5)
    proxy = co + (proxy - co) * under[:, None]
    feet = smoothstep(1.75, 2.05, R.legt) * (R.legs > 0.5)
    pf = G.laplacian(co, adj, feet_iters, 0.5)
    return proxy + (pf - proxy) * feet[:, None]


def finish(part, thick, lining, rim=None):
    """Pigment-pooling distance from the hems, then real thickness with a lining (records open rings first)."""
    part.attrs['hem'] = hem_distance(part)
    part.open_rings = [part.co[L].copy() for L in G.boundary_loops(part.faces)]
    G.solidify(part, thick, lining, rim)
    return part


def skirt(part, loop, z_top, z_hem, under, nr=11, flare=0.55, folds=((9, 0.05, 0.6), (17, 0.025, 1.3)),
          back=0.035, depth=0.9, gap=(0.012, 0.02), slits=(), front_open=None):
    """Extrude a skirt from a waist loop down to z_hem: flaring, folded, clear of `under`, split by slits.

    slits: [(angle_deg, from_ring)] (0 = char-left, -90 = front, +90 = back). front_open: optional
    (angle_deg, half_width_deg, from_ring) -> two slits around the front for an open robe.
    Sets part.attrs['skirt_t'] (0 at the waist .. 1 at the hem; -1 elsewhere). Returns (rings, centre_y)."""
    top = part.co[loop]
    cy = top[:, 1].mean()
    ang = np.arctan2(top[:, 1] - cy, top[:, 0])
    rings = []
    for k in range(1, nr + 1):
        t = k / nr
        zk = z_top + (z_hem - z_top) * t
        fl = 1.0 + flare * t ** 1.3
        fo = 1.0 + sum(a * t * np.sin(ang * f + ph) for f, a, ph in folds)
        bk = back * t * smoothstep(-0.2, 0.9, np.sin(ang))
        rr = np.stack([top[:, 0] * fl * fo, cy + (top[:, 1] - cy) * fl * fo * depth + bk, np.full(len(top), zk)], 1)
        lay = G._layers(under)
        for _ in range(4):
            rr = G.clear_layers(rr, lay, np.full(len(rr), gap[0] + gap[1] * t))
            rr = 0.5 * rr + 0.25 * (np.roll(rr, 1, 0) + np.roll(rr, -1, 0))
        rings.append(G.clear_layers(rr, lay, np.full(len(rr), gap[0] * 0.85 + gap[1] * 0.75 * t), passes=2))
    all_rings = G.extrude_rings(part, loop, rings)
    st = np.full(part.nv, -1.0)
    for k, ring in enumerate(all_rings[1:], 1):
        st[ring] = k / nr
    part.attrs['skirt_t'] = st
    angs = np.degrees(np.arctan2(part.co[all_rings[0]][:, 1] - cy, part.co[all_rings[0]][:, 0]))
    cuts = list(slits)
    if front_open:
        a, hw, fr = front_open
        cuts += [(a - hw, fr), (a + hw, fr)]
    for a_deg, from_ring in cuts:
        d = np.abs((angs - a_deg + 180) % 360 - 180)
        G.split_column(part, all_rings, int(np.argmin(d)), from_ring)
    return all_rings, cy


def panel_of(angle, panels):
    """panels: [(name, a0, a1)] degree ranges (wrapping allowed, a0 < a1 may exceed 180)."""
    for name, a0, a1 in panels:
        a = angle
        while a < a0:
            a += 360
        while a >= a0 + 360:
            a -= 360
        if a0 <= a < a1:
            return name
    return panels[-1][0]


def chain_part_weights(part, cy, co, topo, names, W, CH, panels, ramp=0.35, key='skirt_t', follow=None):
    """Body weights where the part follows the body; skirt panels hang from their chains (by face angle).
    follow: {panel: (bone, amount)} rigidly binds that share of a panel to a bone (front panels to the thighs,
    so a kick carries the panel even before the spring chain reacts)."""
    n = part.nv
    Wc = np.zeros((n, len(names)))
    src = np.asarray(part.src) if part.src is not None else np.full(n, -1)
    ok = src >= 0
    Wc[ok] = W[src[ok]]
    if (~ok).any():
        sampler = skin.SurfaceSampler(co, skin.triangulate(topo.faces))
        Wc[~ok], _ = sampler.interpolate(W, part.co[~ok])
    st = part.attrs[key]
    panel = {}
    for f in part.faces:
        if any(st[v] > 0 for v in f) and all(st[v] >= 0 for v in f):
            pc = part.co[list(f)].mean(0)
            a = math.degrees(math.atan2(pc[1] - cy, pc[0]))
            name = panel_of(a, panels)
            for v in f:
                panel.setdefault(v, name)
    idx = {nm: i for i, nm in enumerate(names)}
    for name in {p[0] for p in panels}:
        vs = np.array([v for v, pn in panel.items() if pn == name])
        if not len(vs):
            continue
        c = CH[name]
        bn, Wch = skin.chain_weights(part.co[vs], c['points'], c['bones'])
        f = smoothstep(0.0, ramp, np.maximum(st[vs], 0))[:, None]
        Wn = np.zeros((len(vs), len(names)))
        for j, b in enumerate(bn):
            Wn[:, idx[b]] = Wch[:, j]
        if follow and name in follow:
            bone, amt = follow[name]
            Wn *= (1 - amt)
            Wn[:, idx[bone]] += amt
        Wc[vs] = (1 - f) * Wc[vs] + f * Wn
    return (list(names), Wc)


def bell_sleeve(part, loop, el, wr, r_open, droop, n=7, past=0.03, tilt=0.0):
    """Extrude a wide hanging sleeve from an elbow ring to just past the wrist: the top edge stays near the arm,
    the lower edge drops into a deep bag (classic wide hanfu sleeve). Sets attrs['sleeve_t']."""
    el, wr = np.asarray(el, float), np.asarray(wr, float)
    ax = (wr - el) / np.linalg.norm(wr - el)
    L = np.linalg.norm(wr - el) + past
    c0 = part.co[loop]
    cen0 = c0.mean(0)
    rel0 = c0 - cen0
    r0 = float(np.linalg.norm(rel0, axis=1).mean())
    down = np.array([0, 0, -1.0])
    down = down - ax * (down @ ax)
    down /= np.linalg.norm(down)
    rings = []
    for k in range(1, n + 1):
        t = k / n
        r = r0 + (r_open - r0) * t ** 0.75
        c = cen0 + ax * L * t + down * (r - r0) * 0.92 + down * droop * t ** 1.6
        dirs = rel0 / np.linalg.norm(rel0, axis=1)[:, None]
        ring = c + dirs * r
        # lower half hangs a bit further (heavy silk)
        hang = np.clip(dirs @ down, 0, 1)
        ring = ring + down[None] * (hang * droop * 0.35 * t)[:, None]
        rings.append(ring)
    all_rings = G.extrude_rings(part, loop, rings)
    st = part.attrs.get('sleeve_t', np.full(part.nv, -1.0))
    st = np.concatenate([np.asarray(st), np.full(part.nv - len(st), -1.0)])
    for k, ring in enumerate(all_rings[1:], 1):
        st[ring] = k / n
    part.attrs['sleeve_t'] = st
    return all_rings


def ellipsoid_part(c, r, name, paint, segs=12, rings=8, rot=None):
    from .core import ellipsoid
    v, f = ellipsoid(tuple(c), r[0], r[1], r[2], segs=segs, rings=rings, rot=rot)
    co = np.array([tuple(x) for x in v])
    uv = [(co[i][0] + co[i][2], co[i][1] + co[i][2]) for ff in f for i in ff]
    return Part(name, co, f, paint, uv=uv, pat=uv)


def shoe(P, s, paint='shoe', sole_paint='sole', shaft=0.0, shaft_r=(0.046, 0.042), toe_up=0.0):
    """Cloth shoe (or a boot when shaft > 0: height of the shaft above the ankle) with a layered sole."""
    heel, toe, ank = (np.array(P[k + '_' + s]) for k in ('heel', 'toe', 'ankle'))
    f = toe - heel
    f[2] = 0
    L = np.linalg.norm(f)
    f /= L
    lat = np.cross(np.array([0, 0, 1.0]), f)
    sx = 1 if s == 'L' else -1
    secs, sole = [], []
    ts = np.linspace(0, 1, 13)
    prof_w = np.interp(ts, [0, 0.12, 0.45, 0.72, 0.9, 1.0], [0.030, 0.038, 0.042, 0.047, 0.036, 0.012])
    prof_h = np.interp(ts, [0, 0.15, 0.4, 0.7, 0.9, 1.0], [0.070, 0.082, 0.070, 0.042, 0.028, 0.016])
    bend = np.interp(ts, [0, 0.6, 1.0], [0.0, 0.004, -0.012]) * sx
    lift = np.interp(ts, [0, 0.85, 1.0], [0.0, 0.0, toe_up])
    m = 14
    for t, w, h, bd, lf in zip(ts, prof_w, prof_h, bend, lift):
        c = heel + f * (L * (t * 1.06 - 0.03)) + lat * bd
        c[2] = 0.0
        ring, sring = [], []
        for k in range(m):
            a = 2 * math.pi * k / m
            ca, sa = math.cos(a), math.sin(a)
            x = w * math.copysign(abs(ca) ** 0.7, ca)
            zz = 0.012 + (h - 0.012) * (abs(sa) ** 0.8) if sa >= 0 else 0.012 + 0.004 * sa
            ring.append(c + lat * x + np.array([0, 0, zz + lf]))
            sring.append(c + lat * x * 1.04 + np.array([0, 0, 0.006 + 0.006 * sa + lf * 0.5]))
        secs.append(np.array(ring))
        sole.append(np.array(sring))
    out = [G.lofted(secs, 'shoe_' + s, paint), G.lofted(sole, 'sole_' + s, sole_paint)]
    if shaft > 0:
        # boot shaft: rings around the shin from below the ankle up to `shaft` above it, flaring at the top
        kn = np.array(P['knee_' + s])
        ax = (kn - ank) / np.linalg.norm(kn - ank)
        rings = []
        for k in range(8):
            t = k / 7
            c = ank + ax * (shaft * t - 0.035)
            rx = shaft_r[0] * (1 + 0.25 * t ** 3)
            ry = shaft_r[1] * (1 + 0.25 * t ** 3)
            u = np.cross(ax, f)
            u /= np.linalg.norm(u)
            v = np.cross(u, ax)
            rings.append(np.array([c + u * rx * math.cos(a) + v * ry * math.sin(a) + v * 0.006
                                   for a in np.linspace(0, 2 * math.pi, 16, endpoint=False)]))
        out.append(G.lofted(rings, 'shaft_' + s, paint, cap0=False, cap1=False))
    return out
