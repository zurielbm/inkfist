"""Face: eyeballs, lash lines, brows, teeth, mouth interior and expression morph targets.

All features are located from the shared base topology (eye pockets, mouth bag) so every character gets them
automatically. The lid margin is found as the head surface's intersection with the fitted eyeball sphere.
"""
import math

import numpy as np

from . import garment as G
from .part import Part


def smoothstep(e0, e1, x):
    t = np.clip((np.asarray(x, float) - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def fit_sphere(P):
    A = np.c_[2 * P, np.ones(len(P))]
    f = (P ** 2).sum(1)
    c, *_ = np.linalg.lstsq(A, f, rcond=None)
    cen = c[:3]
    return cen, float(np.sqrt(c[3] + cen @ cen))


def _norm(v):
    return v / np.linalg.norm(v)


class Eye:
    """Eyeball sphere + lid margin curve for one eye."""

    def __init__(self, body, side, co=None):
        co = body.co if co is None else co
        rings = body.eye_rings(side)
        pocket = [v for k in range(2, 12) for v in rings[k]]
        self.c, self.r = fit_sphere(co[pocket])
        self.side = side
        near = set(v for k in range(0, 24) for v in rings[k])
        self.near = np.array(sorted(near))
        # lid margin: intersection of the head with a sphere slightly larger than the eyeball
        eps = 0.0007
        f = np.linalg.norm(co - self.c, axis=1) - (self.r + eps)
        pts = []
        seen = set()
        for v in self.near:
            for w in body.topo.adj[v]:
                e = (min(v, w), max(v, w))
                if e in seen or w not in near:
                    continue
                seen.add(e)
                if f[v] * f[w] < 0:
                    t = f[v] / (f[v] - f[w])
                    p = co[v] + (co[w] - co[v]) * t
                    if (p - self.c)[1] < -0.3 * self.r:  # front half only
                        pts.append(p)
        pts = np.array(pts)
        self.axis = _norm(pts.mean(0) - self.c)
        up = np.array([0, 0, 1.0])
        u = _norm(np.cross(up, self.axis))  # horizontal, toward char-left for a -Y facing eye ... sign fixed below
        if u[0] < 0:
            u = -u
        self.u = u                           # +X direction in the eye plane
        self.w = _norm(np.cross(self.axis, u))
        if self.w[2] < 0:
            self.w = -self.w                 # up in the eye plane
        rel = pts - self.c
        ang = np.arctan2(rel @ self.w, rel @ self.u)
        order = np.argsort(ang)
        self.margin = pts[order]
        self.ang = ang[order]
        # canthi: extreme horizontal points; medial = toward the nose
        uu = self.margin @ self.u
        i_out = int(np.argmax(uu)) if side == 'L' else int(np.argmin(uu))
        i_in = int(np.argmin(uu)) if side == 'L' else int(np.argmax(uu))
        self.outer, self.inner = self.margin[i_out], self.margin[i_in]
        ww = (self.margin - self.c) @ self.w
        line = _lerp_line(self, self.margin)
        upper = self.margin[ww > line]
        lower = self.margin[ww <= line]
        self.upper = _sort_inner_to_outer(self, upper)
        self.lower = _sort_inner_to_outer(self, lower)

    def plane(self, p):
        rel = np.asarray(p) - self.c
        return rel @ self.u, rel @ self.w

    def eyeball(self, name, paint='eye', segs=24, rings=16, grow=0.0006):
        """UV-sphere eyeball, pole along the eye axis. pat = eye-plane coords (metres) for the iris recipe."""
        r = self.r + grow
        a, u, w = self.axis, self.u, self.w
        co = [self.c + a * r]
        for i in range(1, rings):
            th = math.pi * i / rings
            for k in range(segs):
                ph = 2 * math.pi * k / segs
                d = a * math.cos(th) + (u * math.cos(ph) + w * math.sin(ph)) * math.sin(th)
                co.append(self.c + d * r)
        co.append(self.c - a * r)
        co = np.array(co)
        faces = []
        for k in range(segs):
            faces.append((0, 1 + (k + 1) % segs, 1 + k))
        for i in range(rings - 2):
            for k in range(segs):
                a0 = 1 + i * segs + k
                b0 = 1 + i * segs + (k + 1) % segs
                faces.append((a0, b0, b0 + segs, a0 + segs))
        last = len(co) - 1
        base = 1 + (rings - 2) * segs
        for k in range(segs):
            faces.append((last, base + k, base + (k + 1) % segs))
        pl = np.array([self.plane(p) for p in co])
        uv = [tuple(pl[v]) for f in faces for v in f]
        p = Part(name, co, faces, paint, 'head', uv=uv, pat=uv, outline=0.0, texel=2.5)
        return p


def _lerp_line(eye, pts):
    """Height of the canthus-to-canthus line at each point's horizontal position (eye plane)."""
    ui, wi = eye.plane(eye.inner) if hasattr(eye, 'inner') else (0, 0)
    uo, wo = eye.plane(eye.outer) if hasattr(eye, 'outer') else (1, 0)
    uu = (np.asarray(pts) - eye.c) @ eye.u
    t = np.clip((uu - ui) / (uo - ui + 1e-9), 0, 1)
    return wi + (wo - wi) * t


def _sort_inner_to_outer(eye, pts):
    ui = (eye.inner - eye.c) @ eye.u
    d = np.abs((np.asarray(pts) - eye.c) @ eye.u - ui)
    return np.asarray(pts)[np.argsort(d)]


def lash_strip(eye, surf, name, pts, thick_in, thick_out, wing=0.0, up=True, lift=0.0003, paint='lash', depth=0.0012):
    """Ink lash line hugging a lid margin (inner -> outer), with an optional flick past the outer corner."""
    P = np.asarray(pts, float)
    P = G.catmull(P[:: max(1, len(P) // 10)].tolist() + [P[-1].tolist()], 22)
    if wing > 0:
        d_out = _norm(eye.outer - eye.inner)
        flick = _norm(d_out + eye.w * (0.45 if up else -0.15))
        extra = [P[-1] + flick * wing * t for t in (0.35, 0.7, 1.0)]
        P = np.vstack([P, extra])
    n = len(P)
    t = np.linspace(0, 1, n)
    th = thick_in + (thick_out - thick_in) * t ** 0.8
    if wing > 0:
        th[-3:] *= np.array([0.8, 0.5, 0.15])
    rings = []
    for i in range(n):
        p = P[i]
        loc, nrm, _, _ = surf.nearest(p)
        outward = _norm(p - eye.c)
        vdir = eye.w if up else -eye.w
        # cross-section quad: base on the margin, extending away from the opening
        b0 = p + outward * lift
        b1 = p + outward * (lift + depth)
        t0 = b0 + vdir * th[i] * 0.2 + outward * 0.0002
        t1 = b1 + vdir * th[i] + outward * 0.0003
        rings.append([b0, b1, t1, t0])
    return G.lofted([np.array(r) for r in rings], name, paint, group='head')


def brow(surf, name, ctrl, widths, lift=0.0012, paint='brow', segs=18):
    """Brow as a raised tapered band on the skin. ctrl: points near the skin (projected along -Y rays)."""
    path = G.catmull(ctrl, segs)
    pp, nn = [], []
    for p in path:
        hit = surf.raycast(np.array([p[0], -1.0, p[2]]), np.array([0, 1.0, 0]), 2.0)
        if hit is None:
            loc, nrm, _, _ = surf.nearest(p)
        else:
            loc, nrm, _ = hit
        pp.append(loc)
        nn.append(nrm)
    pp, nn = np.array(pp), np.array(nn)
    prof = np.interp(np.linspace(0, 1, len(pp)), np.linspace(0, 1, len(widths)), widths)
    return G.band(pp, nn, 1.0, lift, name, paint, group='head', w_profile=prof, align=0.5)


# ---------------------------------------------------------------- morph targets

def rot_about(p, c, axis, ang):
    """Rotate points p about the line through c along unit axis by ang (radians) — Rodrigues."""
    v = p - c
    k = axis
    ca, sa = np.cos(ang), np.sin(ang)
    ang = np.asarray(ang)
    if ang.ndim:
        ca, sa = ca[:, None], sa[:, None]
    return c + v * ca + np.cross(k, v) * sa + np.outer(v @ k, k) * (1 - ca)


class FaceRig:
    """Landmarks + morph deltas on the full body vertex array."""

    def __init__(self, body):
        self.body = body
        co = body.co
        self.eyes = {s: Eye(body, s) for s in 'LR'}
        mr = body.mouth_rings()
        bag = [v for k in range(0, 10) for v in mr[k]]
        self.bag = np.array(bag)
        lip = [v for k in range(10, 17) for v in mr[k]]
        L = co[lip]
        self.mouth_c = np.array([0.0, L[:, 1].min(), np.median(L[:, 2])])
        self.corner_x = np.abs(L[:, 0]).max()
        # contact line height: midpoint between the closest upper/lower lip verts at the centre
        cen = L[np.abs(L[:, 0]) < 0.006]
        front = cen[np.argsort(cen[:, 1])[:6]]
        self.mouth_c[2] = np.median(front[:, 2])
        e = self.eyes['L']
        self.tmj = np.array([0.0, e.c[1] + 0.085, e.c[2] - 0.055])

    def jaw_weight(self):
        if getattr(self, '_jaw', None) is not None:
            return self._jaw
        co = self.body.co
        m = self.mouth_c
        dl = co[:, 2] - self.mouth_line(co[:, 0])
        w = (dl < 0).astype(float)
        y_f = smoothstep(self.tmj[1] - 0.005, self.tmj[1] - 0.04, co[:, 1])
        neck = smoothstep(m[2] - 0.13, m[2] - 0.06, co[:, 2])
        far = (co[:, 2] < m[2] - 0.16) | (co[:, 2] > m[2] + 0.12)
        w = w * y_f * neck
        w[far] = 0.0
        in_bag = np.zeros(len(co), bool)
        in_bag[self.bag] = True
        pin = in_bag | ((np.abs(co[:, 0]) < 0.75 * self.corner_x) & (np.abs(dl) < 0.025) & (co[:, 1] < m[1] + 0.03))
        pin |= far
        nb = [np.fromiter(self.body.topo.adj[i], int) for i in range(len(co))]
        active = np.where(~pin & (co[:, 2] > m[2] - 0.17) & (co[:, 2] < m[2] + 0.13))[0]
        for _ in range(40):
            avg = np.array([w[nb[i]].mean() for i in active])
            w[active] = w[active] + 0.6 * (avg - w[active])
        self._jaw = w
        return w

    def mouth_line(self, x):
        """Contact line height at x (slight smile-neutral curve)."""
        t = np.clip(np.abs(x) / self.corner_x, 0, 1)
        return self.mouth_c[2] + 0.002 * t * t

    def weights(self, co, src=None):
        """Region weights over the head verts (src: their body vertex indices, for topology regions)."""
        e = self.eyes
        out = {}
        for s in 'LR':
            E = e[s]
            rel = co - E.c
            uu, ww = rel @ E.u, rel @ E.w
            d = np.linalg.norm(rel, axis=1)
            front = smoothstep(-0.2 * E.r, 0.4 * E.r, -(rel @ np.array([0, 1.0, 0])))
            dist_m = _dist_to_curve(co, E.margin)
            lidzone = (1 - smoothstep(0.0025, 0.016, dist_m)) * (1 - smoothstep(E.r + 0.008, E.r + 0.02, d))
            line = _lerp_line(E, co)
            above = smoothstep(-0.0015, 0.0015, ww - line)
            out['ulid_' + s] = lidzone * above * front
            out['llid_' + s] = lidzone * (1 - above) * front * (1 - smoothstep(0.002, 0.008, dist_m))
            # brow zone: above the eye, centred over it
            bz = (E.c[2] + E.r * 0.9, E.c[2] + E.r * 2.6)
            brow_h = smoothstep(bz[0] - 0.006, bz[0] + 0.004, co[:, 2]) * (1 - smoothstep(bz[1], bz[1] + 0.012, co[:, 2]))
            lat = np.abs(co[:, 0] - E.c[0] * 1.0)
            brow_x = 1 - smoothstep(0.022, 0.040, lat)
            out['brow_' + s] = brow_h * brow_x * smoothstep(-0.02, 0.0, -(co[:, 1] - E.c[1] - 0.01))
            # inner-brow factor (toward the nose)
            out['brow_in_' + s] = out['brow_' + s] * (1 - smoothstep(-0.004, 0.016, np.abs(co[:, 0]) - np.abs(E.c[0]) + 0.012))
        m = self.mouth_c
        rel = co - m
        # jaw: everything below the mouth line in front of the ears, fading under the chin into the neck
        # jaw weight: sharp split along the lip seam, then diffused over the mesh topology (not space), so the
        # lips stay separated while the folded mouth corners and cheeks blend smoothly
        if src is not None:
            out['jaw'] = self.jaw_weight()[np.asarray(src)]
        else:
            out['jaw'] = 1 - smoothstep(-0.003, 0.003, co[:, 2] - self.mouth_line(co[:, 0]))
        lips = 1 - smoothstep(0.004, 0.014, np.linalg.norm((rel * np.array([1 / 1.6, 1, 1.4])), axis=1) - 0.012)
        out['lips'] = lips * smoothstep(-0.01, 0.0, -(co[:, 1] - m[1] - 0.03))
        for s, sx in (('L', 1), ('R', -1)):
            cpt = np.array([sx * self.corner_x, m[1] + 0.012, m[2]])
            out['corner_' + s] = 1 - smoothstep(0.0, 0.026, np.linalg.norm(co - cpt, axis=1))
            out['cheek_' + s] = (1 - smoothstep(0.01, 0.03, np.linalg.norm(co - (cpt + np.array([sx * 0.008, -0.004, 0.028])), axis=1)))
        return out

    def morphs(self, co, R):
        """Morph deltas for points co (full head verts). R: weights() output for co."""
        e = self.eyes
        D = {k: np.zeros_like(co) for k in ('blink', 'glare', 'pain', 'shout', 'smirk')}

        def lids(amount_up, amount_lo):
            out = np.zeros_like(co)
            for s in 'LR':
                E = e[s]
                um, lm = E.upper[len(E.upper) // 2], E.lower[len(E.lower) // 2]
                a1 = _norm(um - E.c)
                a2 = _norm(lm - E.c)
                full = math.acos(np.clip(a1 @ a2, -1, 1))
                axis = E.u  # rotating about +u moves the upper lid down (w -> -axis side)
                for key, amt, sign in (('ulid_' + s, amount_up, 1), ('llid_' + s, amount_lo, -1)):
                    w = R[key]
                    sel = w > 1e-4
                    ang = sign * full * amt * w[sel]
                    q = rot_about(co[sel], E.c, axis, _sgn_axis(E, axis) * ang)
                    out[sel] += q - co[sel]
            return out

        D['blink'] += lids(1.0, 0.12)
        self._jaw = getattr(self, '_jaw', None)
        for s, sx in (('L', 1), ('R', -1)):
            b, bi = R['brow_' + s], R['brow_in_' + s]
            # glare: brows down and pulled in, inner ends lowest
            D['glare'][:, 2] += -0.0035 * b - 0.0030 * bi
            D['glare'][:, 0] += -sx * 0.0022 * bi
            D['glare'][:, 1] += -0.0010 * bi
            # pain: inner brows up and knitted
            D['pain'][:, 2] += 0.0040 * bi - 0.0010 * (b - bi)
            D['pain'][:, 0] += -sx * 0.0018 * bi
            # shout: fierce brows
            D['shout'][:, 2] += -0.0028 * b - 0.0022 * bi
            D['shout'][:, 0] += -sx * 0.0016 * bi
        D['glare'] += lids(0.28, 0.22)
        D['pain'] += lids(0.62, 0.30)
        D['shout'] += lids(0.18, 0.12)
        # jaw open (shout) / clench (pain)
        jw = R['jaw']
        sel = jw > 1e-4
        ang = math.radians(13) * jw[sel]
        q = rot_about(co[sel], self.tmj, np.array([1.0, 0, 0]), -ang)
        D['shout'][sel] += q - co[sel]
        for s, sx in (('L', 1), ('R', -1)):
            c = R['corner_' + s]
            D['shout'][:, 0] += sx * 0.0030 * c
            D['shout'][:, 2] += -0.0010 * c
            D['pain'][:, 0] += sx * 0.0022 * c
            D['pain'][:, 2] += -0.0022 * c
        ang2 = math.radians(4) * jw[sel]
        q = rot_about(co[sel], self.tmj, np.array([1.0, 0, 0]), -ang2)
        D['pain'][sel] += q - co[sel]
        # smirk: wearer's left corner up/out, cheek lifts, that eye narrows a little
        c = R['corner_L']
        D['smirk'][:, 0] += 0.0030 * c
        D['smirk'][:, 2] += 0.0042 * c
        D['smirk'][:, 1] += 0.0012 * c
        D['smirk'][:, 2] += 0.0020 * R['cheek_L']
        D['smirk'] += lids(0.0, 0.0)
        for s, amt in (('L', 0.22),):
            pass
        return D


def _sgn_axis(E, axis):
    """Rotation sign so that positive angles move the upper lid toward the lower lid."""
    um = E.upper[len(E.upper) // 2]
    test = rot_about(um[None], E.c, axis, 0.05)[0]
    return 1.0 if (test - um) @ E.w < 0 else -1.0


def _dist_to_curve(co, curve):
    from mathutils.kdtree import KDTree
    kd = KDTree(len(curve))
    for i, p in enumerate(curve):
        kd.insert(tuple(p), i)
    kd.balance()
    return np.array([kd.find(tuple(p))[2] for p in co])


def _in_set(n, idx):
    m = np.zeros(n)
    m[np.asarray(idx)] = 1.0
    return m


def follow_deltas(src_co, src_D, dst_co, k=3):
    """Deltas for feature verts (lashes/brows) copied from the nearest skin verts (inverse-distance avg)."""
    from mathutils.kdtree import KDTree
    kd = KDTree(len(src_co))
    for i, p in enumerate(src_co):
        kd.insert(tuple(p), i)
    kd.balance()
    out = {name: np.zeros_like(dst_co) for name in src_D}
    for j, p in enumerate(dst_co):
        hits = kd.find_n(tuple(p), k)
        w = np.array([1.0 / (h[2] + 1e-4) for h in hits])
        w /= w.sum()
        idx = [h[1] for h in hits]
        for name, D in src_D.items():
            out[name][j] = (D[idx] * w[:, None]).sum(0)
    return out
