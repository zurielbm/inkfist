"""Hair: a scalp cap from the hairline + designed clumps ("locks") that grow along the scalp then lift off.

Locks are tapered sweeps with a lens-shaped cross-section, oriented flat against the head, so the hair reads
as big graphic ink shapes. UV: u across the lock, v from root (0) to tip (1); attribute 'hair_t' = v.
"""
import math

import numpy as np

from . import garment as G
from .part import Part


def _n(v):
    v = np.asarray(v, float)
    return v / max(np.linalg.norm(v), 1e-12)


class Scalp:
    @staticmethod
    def center_of(P):
        hd = np.array(P['head0'])
        top = np.array(P['head_top'])
        return np.array([0.0, hd[1], 0.5 * (hd[2] + top[2]) - 0.01])

    def __init__(self, b, fr, P, hairline, lift=0.004, name='scalp', paint='hair', ear_clear=0.032, volume=None):
        """hairline(theta_deg) -> z of the hairline at that angle around the head (0 = front, +90 = char left).
        volume(theta_deg, z) -> extra thickness of the hair mass above the scalp (metres)."""
        co = b.co
        self.P = P
        hd = np.array(P['head0'])
        top = np.array(P['head_top'])
        self.center = np.array([0.0, hd[1], 0.5 * (hd[2] + top[2]) - 0.01])
        self.top = top
        rel = co - self.center
        theta = np.degrees(np.arctan2(rel[:, 0], -rel[:, 1]))
        hz = np.array([hairline(t) for t in theta])
        ear_c = [np.array([sx * 0.075, hd[1] + 0.005, fr.eyes['L'].c[2] - 0.012]) for sx in (1, -1)]
        near_ear = np.zeros(len(co), bool)
        for e in ear_c:
            near_ear |= (np.linalg.norm((co - e) * np.array([1.0, 1.0, 0.8]), axis=1) < ear_clear) & (np.abs(co[:, 0]) > 0.055)
        head_zone = np.linalg.norm(rel, axis=1) < 0.16
        m = head_zone & (co[:, 2] > hz) & ~near_ear
        off = np.full(len(co), lift)
        if volume is not None:
            off = off + np.array([volume(t, z) for t, z in zip(theta, co[:, 2])])
            # thin out toward the hairline so the mass meets the skin cleanly
            off = lift + (off - lift) * np.clip((co[:, 2] - hz) / 0.03, 0, 1)
        self.part = G.shell(b.topo, co, m, name, paint, offset=off, smooth=10, min_gap=lift * 0.8, group='hair',
                            texel=0.8)
        self.part.attrs['hair_t'] = np.zeros(self.part.nv)
        self.surf = G.surface_of(self.part)
        self.head_surf = G.Surface(co, b.topo.faces)
        self.coll = G.surface_of(self.part, (co, b.topo.faces))

    def snap(self, p, lift=0.0):
        loc, nrm, _, _ = self.surf.nearest(p)
        return loc + nrm * lift, nrm


def lock(scalp, root, direction, length, width, attach=0.45, lift=0.003, thick=0.5, curl=(0, 0, 0),
         gravity=0.6, flick=(0, 0, 0), n=14, segs=8, taper=0.92, name='lock', paint='hair', twist=0.0,
         root_width=None, rng=None, bend=0.8):
    """Grow a lock: attach*length metres hug the hair mass, the free rest turns (eased by `bend`) from its
    take-off direction toward take-off + down*gravity + flick + curl."""
    root = np.asarray(root, float)
    p, nrm = scalp.snap(root, lift)
    d = _n(np.asarray(direction, float))
    pts, nrms = [p], [nrm]
    ds = length / (n - 1)
    n_att = max(0, int(round(attach * (n - 1))))
    d_free = None
    tgt = None
    for i in range(1, n):
        t = i / (n - 1)
        if i <= n_att and n_att > 0:
            d = _n(d - nrm * (d @ nrm))
            q = pts[-1] + d * ds
            q, nrm2 = scalp.snap(q, lift + 0.0015 * i / n_att)
            d = _n(q - pts[-1])
            nrm = nrm2
            pts.append(q)
            nrms.append(nrm)
        else:
            if d_free is None:
                d_free = d.copy()
                tgt = _n(d_free + np.array([0, 0, -1.0]) * gravity + np.asarray(flick, float) + np.asarray(curl, float))
            ft = (i - n_att) / max(1, n - 1 - n_att)
            e = ft ** bend
            d = _n(d_free * (1 - e) + tgt * e)
            q = pts[-1] + d * ds
            # never sink into the hair mass or the face
            loc, nn, _, dist = scalp.coll.nearest(q)
            if (q - loc) @ nn < lift:
                q = loc + nn * lift
            pts.append(q)
            nrms.append(_n(nrms[-1] * 0.85 + nn * 0.15))
    P = np.array(pts)
    N = np.array([_n(x) for x in nrms])
    T = np.gradient(P, axis=0)
    T = T / np.linalg.norm(T, axis=1)[:, None]
    Sd = np.cross(N, T)
    Sd = Sd / np.maximum(np.linalg.norm(Sd, axis=1), 1e-9)[:, None]
    Nn = np.cross(T, Sd)
    tt = np.linspace(0, 1, n)
    w0 = width if root_width is None else root_width
    W = np.where(tt < 0.15, w0 + (width - w0) * tt / 0.15, width * (1 - taper * (np.clip(tt - 0.15, 0, None) / 0.85) ** 1.15))
    W = np.maximum(W, 0.0006)
    Th = W * thick
    co, uv, attr = [], [], []
    for i in range(n):
        tw = twist * tt[i]
        ct, st = math.cos(tw), math.sin(tw)
        sd = Sd[i] * ct + Nn[i] * st
        nn = Nn[i] * ct - Sd[i] * st
        for k in range(segs):
            a = 2 * math.pi * k / segs
            ca, sa = math.cos(a), math.sin(a)
            # lens: wide flat lock, slightly convex on top
            x = W[i] * 0.5 * math.copysign(abs(ca) ** 0.8, ca)
            y = Th[i] * 0.5 * math.copysign(abs(sa) ** 1.1, sa) + Th[i] * 0.25 * (1 - ca * ca) * (1 if sa > 0 else 0.3)
            co.append(P[i] + sd * x + nn * (y + Th[i] * 0.3))
        attr += [tt[i]] * segs
    faces = []
    for i in range(n - 1):
        for k in range(segs):
            k2 = (k + 1) % segs
            faces.append((i * segs + k, i * segs + k2, (i + 1) * segs + k2, (i + 1) * segs + k))
            for (ii, kk) in ((i, k), (i, k2 if k2 else segs), (i + 1, k2 if k2 else segs), (i + 1, k)):
                uv.append((kk / segs * max(width, 0.01) * 2.0, tt[ii] * length))
    # root cap (tucked into the scalp) and tip point
    c0 = len(co)
    co.append(P[0] - Nn[0] * 0.002)
    attr.append(0.0)
    for k in range(segs):
        faces.append((c0, (k + 1) % segs, k))
        uv += [(0, 0), (0.001, 0), (0, 0.001)]
    c1 = len(co)
    co.append(P[-1] + T[-1] * 0.004)
    attr.append(1.0)
    base = (n - 1) * segs
    for k in range(segs):
        faces.append((c1, base + k, base + (k + 1) % segs))
        uv += [(0, length), (0.001, length), (0, length + 0.001)]
    p = Part(name, np.array(co), faces, paint, 'hair', uv=uv, pat=uv)
    p.attrs['hair_t'] = np.array(attr)
    p.texel = 0.8
    p.path = P
    return p


def spread_roots(scalp, center, radius, n, rng, min_sep=0.012):
    """Random roots on the scalp around `center` (projected), Poisson-ish."""
    out = []
    tries = 0
    c = np.asarray(center, float)
    while len(out) < n and tries < n * 200:
        tries += 1
        off = rng.normal(0, radius, 3)
        q, _ = scalp.snap(c + off)
        if all(np.linalg.norm(q - o) > min_sep for o in out):
            out.append(q)
    return out


def push_out(scalp, p, lift):
    """Keep p outside the hair mass (radial ray from the head centre) and outside the face skin."""
    c = scalp.center
    r = _n(p - c)
    hit = scalp.surf.raycast(c, r, 1.0)
    nn = r
    if hit is not None:
        loc, nrm, d = hit
        if np.linalg.norm(p - c) < d + lift:
            p = c + r * (d + lift)
        nn = nrm if nrm @ r > 0 else -nrm
    loc, n2, _, _ = scalp.coll.nearest(p)
    if (p - loc) @ n2 < lift:
        p = loc + n2 * lift
        nn = n2
    return p, nn


def head_frame(scalp):
    """Head-space -> Blender: x = char-left, y = forward, z = up, in units of R (head radius) from the centre."""
    c = scalp.center
    R = float(np.linalg.norm(scalp.top - c))

    def to_world(p):
        p = np.asarray(p, float)
        return c + np.array([p[0], -p[1], p[2]]) * R
    return to_world, R


def curve_lock(scalp, ctrl, width, name, thick=0.45, lift=0.003, n=16, segs=8, taper=0.92, root_width=None,
               twist=0.0, paint='hair', radial=0.75, bury=0.012):
    """Lock along explicit guide points (Blender space). Points inside the hair mass are pushed out; the lock's
    flat side faces away from the head centre (blended with the surface normal)."""
    P = G.catmull([np.asarray(p, float) for p in ctrl], n)
    c = scalp.center
    N = []
    for i, p in enumerate(P):
        P[i], nn = push_out(scalp, p, lift)
        N.append(_n(_n(P[i] - c) * radial + nn * (1 - radial)))
    # relax after the push-out
    for _ in range(2):
        P[1:-1] = 0.5 * P[1:-1] + 0.25 * (P[:-2] + P[2:])
    # bury the root inside the hair mass so the cut end never shows
    r0 = _n(P[0] - c)
    P[0] = P[0] - r0 * bury
    P[1] = P[1] - _n(P[1] - c) * bury * 0.35
    return _sweep(P, np.array(N), width, name, thick, n, segs, taper, root_width, twist, paint)


def _sweep(P, N, width, name, thick, n, segs, taper, root_width, twist, paint):
    T = np.gradient(P, axis=0)
    T = T / np.linalg.norm(T, axis=1)[:, None]
    Sd = np.cross(N, T)
    Sd = Sd / np.maximum(np.linalg.norm(Sd, axis=1), 1e-9)[:, None]
    Nn = np.cross(T, Sd)
    tt = np.linspace(0, 1, n)
    w0 = width if root_width is None else root_width
    W = np.where(tt < 0.15, w0 + (width - w0) * tt / 0.15, width * (1 - taper * (np.clip(tt - 0.15, 0, None) / 0.85) ** 1.15))
    W = np.maximum(W, 0.0006)
    Th = W * thick
    co, uv, attr = [], [], []
    length = float(np.linalg.norm(np.diff(P, axis=0), axis=1).sum())
    for i in range(n):
        tw = twist * tt[i]
        ct, st = math.cos(tw), math.sin(tw)
        sd = Sd[i] * ct + Nn[i] * st
        nn = Nn[i] * ct - Sd[i] * st
        for k in range(segs):
            a = 2 * math.pi * k / segs
            ca, sa = math.cos(a), math.sin(a)
            x = W[i] * 0.5 * math.copysign(abs(ca) ** 0.8, ca)
            y = Th[i] * 0.5 * math.copysign(abs(sa) ** 1.1, sa) + Th[i] * 0.25 * (1 - ca * ca) * (1 if sa > 0 else 0.3)
            co.append(P[i] + sd * x + nn * (y + Th[i] * 0.3))
        attr += [tt[i]] * segs
    faces = []
    for i in range(n - 1):
        for k in range(segs):
            k2 = (k + 1) % segs
            faces.append((i * segs + k, i * segs + k2, (i + 1) * segs + k2, (i + 1) * segs + k))
            for (ii, kk) in ((i, k), (i, k2 if k2 else segs), (i + 1, k2 if k2 else segs), (i + 1, k)):
                uv.append((kk / segs * max(width, 0.01) * 2.0, tt[ii] * length))
    c0 = len(co)
    co.append(P[0] - Nn[0] * 0.002)
    attr.append(0.0)
    for k in range(segs):
        faces.append((c0, (k + 1) % segs, k))
        uv += [(0, 0), (0.001, 0), (0, 0.001)]
    c1 = len(co)
    co.append(P[-1] + T[-1] * 0.004)
    attr.append(1.0)
    base = (n - 1) * segs
    for k in range(segs):
        faces.append((c1, base + k, base + (k + 1) % segs))
        uv += [(0, length), (0.001, length), (0, length + 0.001)]
    p = Part(name, np.array(co), faces, paint, 'hair', uv=uv, pat=uv)
    p.attrs['hair_t'] = np.array(attr)
    p.texel = 0.8
    p.path = P
    return p
