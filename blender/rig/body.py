"""A character's body: the shared CC0 base topology, reshaped (proportions, bulk, face), with joints and
face-feature topology (eye pockets, mouth bag) located on it."""
import functools

import numpy as np

from . import anatomy
from .base import Topo, base_topo, load_base


@functools.lru_cache(maxsize=1)
def _defs():
    data = load_base()
    bt = base_topo('male', data=data)
    J = anatomy.define_joints(bt)
    return data, bt, J


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


EYE_POLE_L = 6594      # centre vertex of the left eye pocket (base topology)
MOUTH_POLE = 2835      # centre vertex of the mouth bag
EYE_POCKET_RINGS = 13  # rings 0..13 around the pole form the recessed pocket (deleted -> eye opening)
EYE_MARGIN_RING = 15   # lid margin (most anterior ring)


class Body:
    def __init__(self, sex='male', blend=0.0):
        data, self.ref, self.J = _defs()
        self.topo = base_topo(sex, blend, data=data)
        self.co = self.topo.co.copy()
        self.sex = sex

    # ---------------------------------------------------------------- queries
    @property
    def H(self):
        return float(self.co[:, 2].max())

    def joints(self, co=None):
        return anatomy.evaluate(self.J, self.co if co is None else co)

    def normals(self):
        return self.topo.vertex_normals(self.co)

    def mirror_index(self):
        """Vertex -> its mirror vertex (x -> -x) on the base topology."""
        if not hasattr(self, '_mirror'):
            from mathutils.kdtree import KDTree
            ref = self.ref.co
            kd = KDTree(len(ref))
            for i, v in enumerate(ref):
                kd.insert(tuple(v), i)
            kd.balance()
            self._mirror = np.array([kd.find((-v[0], v[1], v[2]))[1] for v in ref])
        return self._mirror

    def rings(self, pole, n):
        """BFS rings around a vertex: list of vertex lists (ring 0 = [pole])."""
        out = [[pole]]
        seen = {pole}
        for _ in range(n):
            nxt = set()
            for v in out[-1]:
                for w in self.topo.adj[v]:
                    if w not in seen:
                        nxt.add(w)
            seen |= nxt
            out.append(sorted(nxt))
        return out

    def eye_rings(self, side):
        pole = EYE_POLE_L if side == 'L' else int(self.mirror_index()[EYE_POLE_L])
        return self.rings(pole, 24)

    def mouth_rings(self):
        return self.rings(MOUTH_POLE, 24)

    # ---------------------------------------------------------------- shaping
    def stretch_z(self, z0, z1, k):
        """Scale heights below z0 by k, blending smoothly to 1 above z1 (legs longer/shorter)."""
        zs = np.linspace(-0.05, self.H + 0.05, 4000)
        slope = k + (1 - k) * smoothstep(z0, z1, zs)
        f = np.concatenate([[0], np.cumsum((slope[1:] + slope[:-1]) * 0.5 * np.diff(zs))])
        f -= np.interp(0.0, zs, f)
        self.co[:, 2] = np.interp(self.co[:, 2], zs, f)

    def scale_region(self, center, s, z0, z1, axes=(1, 1, 1)):
        """Scale verts above z1 about `center` by s (per-axis multipliers), blending in over [z0, z1]."""
        c = np.asarray(center, float)
        w = smoothstep(z0, z1, self.co[:, 2])[:, None]
        sc = 1 + (np.asarray(axes, float) * (s - 1))
        self.co = c + (self.co - c) * (1 + (sc - 1) * w)

    def scale_head(self, s, axes=(1, 1, 1)):
        P = self.joints()
        hd = P['head0']
        nk = P['neck0']
        c = np.array([0.0, hd[1], hd[2]])
        self.scale_region(c, s, nk[2] + 0.25 * (hd[2] - nk[2]), hd[2] + 0.02, axes)

    def fit_height(self, H):
        self.co *= H / self.H

    def displace(self, delta, mask=None):
        if mask is None:
            self.co = self.co + delta
        else:
            self.co[mask] += delta[mask]

    def inflate(self, weight, amount):
        """Push verts along normals by amount * weight (weight: per-vertex array)."""
        n = self.normals()
        self.co = self.co + n * (np.asarray(weight)[:, None] * amount)

    def capsule_weight(self, a, b, r0, r1=None, t0=0.0, t1=1.0, feather=0.4):
        """Soft weight of verts near segment a-b within radius r (smooth falloff), restricted to t in [t0,t1]."""
        a, b = np.asarray(a, float), np.asarray(b, float)
        ab = b - a
        t = np.clip(((self.co - a) @ ab) / (ab @ ab), -0.5, 1.5)
        p = a + np.outer(np.clip(t, 0, 1), ab)
        d = np.linalg.norm(self.co - p, axis=1)
        r = r0 if r1 is None else r0 + (r1 - r0) * np.clip(t, 0, 1)
        w = 1 - smoothstep(r * (1 - feather), r, d)
        w *= smoothstep(t0 - 0.15, t0, t) * (1 - smoothstep(t1, t1 + 0.15, t))
        return w

    def radial_scale(self, a, b, s, weight):
        """Scale verts radially about the a-b axis by s, blended with weight (thicker/thinner limbs)."""
        a, b = np.asarray(a, float), np.asarray(b, float)
        ab = (b - a) / np.linalg.norm(b - a)
        rel = self.co - a
        along = np.outer(rel @ ab, ab)
        radial = rel - along
        self.co = a + along + radial * (1 + (s - 1) * np.asarray(weight)[:, None])

    def smooth_region(self, weight, iters=2, lam=0.5):
        w = np.asarray(weight)
        sm = self.topo.laplacian_smooth(self.co, iters, lam)
        self.co = self.co + (sm - self.co) * w[:, None]

    def snapshot(self):
        return Topo(self.co, self.topo.sizes, self.topo.loops, self.topo.uv)


def limb_param(co, pts):
    """Param along a polyline (0 at pts[0] .. len(pts)-1 at the end) of each vertex's nearest segment point,
    plus the distance to the polyline."""
    co = np.asarray(co, float)
    best_d = np.full(len(co), np.inf)
    best_t = np.zeros(len(co))
    for i in range(len(pts) - 1):
        a, b = np.asarray(pts[i], float), np.asarray(pts[i + 1], float)
        ab = b - a
        t = np.clip(((co - a) @ ab) / (ab @ ab), 0, 1)
        d = np.linalg.norm(co - (a + np.outer(t, ab)), axis=1)
        m = d < best_d
        best_d[m] = d[m]
        best_t[m] = i + t[m]
    return best_t, best_d


def bone_sum(names, W, bones):
    idx = [names.index(b) for b in bones if b in names]
    return W[:, idx].sum(1)


def arm_bones(s):
    from .skeleton import FINGER_BONES
    return ['upper_arm_' + s, 'forearm_' + s, 'forearm_twist_' + s, 'hand_' + s] + \
        [b for b in FINGER_BONES if b.endswith('_' + s)]


def leg_bones(s):
    return ['thigh_' + s, 'shin_' + s, 'foot_' + s]


class Regions:
    """Per-vertex region masks/params from heat weights + joints (for garment selection)."""

    def __init__(self, body, names, W, P):
        co = body.co
        self.co = co
        self.names, self.W, self.P = names, W, P
        self.arm = {}
        self.arm_t = {}
        self.leg = {}
        self.leg_t = {}
        for s in 'LR':
            self.arm[s] = bone_sum(names, W, arm_bones(s))
            t, _ = limb_param(co, [P['shoulder_' + s], P['elbow_' + s], P['wrist_' + s], P['middle_mcp_' + s],
                                   P['middle_tip_' + s]])
            self.arm_t[s] = t
            self.leg[s] = bone_sum(names, W, leg_bones(s))
            t, _ = limb_param(co, [P['hip_' + s], P['knee_' + s], P['ankle_' + s], P['toe_' + s]])
            self.leg_t[s] = t
        self.arms = np.maximum(self.arm['L'], self.arm['R'])
        self.legs = np.maximum(self.leg['L'], self.leg['R'])
        self.armt = np.where(co[:, 0] > 0, self.arm_t['L'], self.arm_t['R'])
        self.legt = np.where(co[:, 0] > 0, self.leg_t['L'], self.leg_t['R'])
        self.headneck = bone_sum(names, W, ['head', 'neck'])
        self.head = bone_sum(names, W, ['head'])
        self.fingers = bone_sum(names, W, [n for n in names if n.split('_')[0] in ('thumb', 'index', 'middle', 'ring', 'pinky')])
        self.hands = bone_sum(names, W, ['hand_L', 'hand_R']) + self.fingers
