"""Anatomical landmarks + joint placement on the shared base-body topology.

Joints are defined once on the base male mesh as affine combinations of edge-interpolated surface points
(cross-section rings). Because every character is a reshaped copy of the same topology, evaluating the same
combinations on a reshaped body puts the joints in the right anatomical places automatically.
"""
import math

import numpy as np

FINGERS = ('thumb', 'index', 'middle', 'ring', 'pinky')


class Landmark:
    """Point = sum_i w_i * lerp(co[a_i], co[b_i], t_i)   (weights sum to 1)."""

    def __init__(self, a, b, t, w):
        self.a, self.b, self.t, self.w = (np.asarray(x) for x in (a, b, t, w))

    def __call__(self, co):
        p = co[self.a] * (1 - self.t)[:, None] + co[self.b] * self.t[:, None]
        return (p * self.w[:, None]).sum(0)

    @staticmethod
    def vertex(i):
        return Landmark([i], [i], [0.0], [1.0])

    @staticmethod
    def combine(parts):
        """parts: list of (coef, Landmark) with coefs summing to 1 -> one Landmark."""
        a, b, t, w = [], [], [], []
        for c, lm in parts:
            a += list(lm.a)
            b += list(lm.b)
            t += list(lm.t)
            w += list(c * lm.w)
        return Landmark(a, b, t, w)


class Sectioner:
    def __init__(self, topo):
        self.topo = topo
        e = np.array(sorted(topo.edge_faces.keys()))
        self.edges = e
        self.eidx = {tuple(x): i for i, x in enumerate(e)}

    def loops(self, co, p, n, mask=None):
        """Plane section -> list of loops; each loop = (edge idx array, t array, points)."""
        n = np.asarray(n, float)
        n = n / np.linalg.norm(n)
        e = self.edges
        d = (co - p) @ n
        da, db = d[e[:, 0]], d[e[:, 1]]
        hit = (da * db < 0)
        if mask is not None:
            hit &= mask[e[:, 0]] | mask[e[:, 1]]
        hi = np.where(hit)[0]
        t = da[hi] / (da[hi] - db[hi])
        # connect hit edges that share a face
        hset = {int(i): k for k, i in enumerate(hi)}
        nb = {k: [] for k in range(len(hi))}
        for k, i in enumerate(hi):
            a, b = e[i]
            for fi in self.topo.edge_faces[(int(a), int(b))]:
                f = self.topo.faces[fi]
                for j in range(len(f)):
                    x, y = f[j], f[(j + 1) % len(f)]
                    ei = self.eidx[(min(x, y), max(x, y))]
                    if ei != i and ei in hset:
                        nb[k].append(hset[ei])
        seen = set()
        out = []
        for k in range(len(hi)):
            if k in seen:
                continue
            comp, stack = [], [k]
            seen.add(k)
            while stack:
                c = stack.pop()
                comp.append(c)
                for m in nb[c]:
                    if m not in seen:
                        seen.add(m)
                        stack.append(m)
            comp = np.array(comp)
            ei = hi[comp]
            tt = t[comp]
            pts = co[e[ei, 0]] * (1 - tt)[:, None] + co[e[ei, 1]] * tt[:, None]
            out.append((ei, tt, pts))
        return out

    def ring(self, co, p, n, mask=None, pick='closest'):
        loops = self.loops(co, p, n, mask)
        if not loops:
            raise ValueError(f'no section at {p}')
        p = np.asarray(p, float)
        best = min(loops, key=lambda L: np.linalg.norm(L[2].mean(0) - p))
        return best

    def lm(self, ring, weights=None):
        ei, tt, pts = ring
        w = np.full(len(ei), 1.0 / len(ei)) if weights is None else np.asarray(weights) / np.sum(weights)
        return Landmark(self.edges[ei, 0], self.edges[ei, 1], tt, w)

    def centroid_lm(self, ring):
        """Perimeter-weighted centroid (robust to uneven edge density)."""
        ei, tt, pts = ring
        # order points around the centroid to get segment lengths
        c = pts.mean(0)
        u, s, vt = np.linalg.svd(pts - c)
        ax0, ax1 = vt[0], vt[1]
        ang = np.arctan2((pts - c) @ ax1, (pts - c) @ ax0)
        order = np.argsort(ang)
        P = pts[order]
        seg = np.linalg.norm(np.roll(P, -1, 0) - P, axis=1)
        w = np.zeros(len(pts))
        w[order] = 0.5 * (seg + np.roll(seg, 1))
        return self.lm(ring, w)

    def extreme_lm(self, ring, direction):
        ei, tt, pts = ring
        k = int(np.argmax(pts @ np.asarray(direction, float)))
        return Landmark([self.edges[ei[k], 0]], [self.edges[ei[k], 1]], [tt[k]], [1.0])


def _pca_axis(pts):
    c = pts.mean(0)
    u, s, vt = np.linalg.svd(pts - c)
    return c, vt[0]


def _norm(v):
    return v / np.linalg.norm(v)


def define_joints(topo):
    """Compute joint Landmarks on the base topology (topo.co = base male). Returns dict name -> Landmark,
    plus 'meta' info. Joint names: skeleton joint points (not bones)."""
    co = topo.co
    S = Sectioner(topo)
    H = co[:, 2].max()
    J = {}
    Z = np.array([0, 0, 1.0])

    def sec_z(z, xy, side_mask=None):
        return S.ring(co, np.array([xy[0], xy[1], z]), Z, side_mask)

    left = co[:, 0] > 0.0
    # ---- crotch: highest z where the left leg is its own loop
    crotch = None
    inner = np.abs(co[:, 0]) < 0.20 * H / 1.685
    for z in np.arange(0.65, 0.95, 0.005) * H / 1.685:
        loops = S.loops(co, np.array([0, 0, z]), Z, inner)
        legs = [L for L in loops if L[2][:, 0].min() > 0.005 and L[2][:, 0].max() < 0.20 * H / 1.685]
        if legs:
            crotch = z
    J['_crotch_z'] = crotch

    for s, sx in (('L', 1), ('R', -1)):
        side = co[:, 0] * sx > 0.0
        # ---- legs
        ank = S.ring(co, np.array([sx * 0.17, 0.05, 0.05 * H]), Z, side)
        J['ankle_' + s] = S.centroid_lm(ank)
        kn = S.ring(co, np.array([sx * 0.12, 0.0, 0.285 * H]), Z, side)
        J['knee_' + s] = S.centroid_lm(kn)
        th = S.ring(co, np.array([sx * 0.10, 0.0, crotch - 0.045 * H / 1.685]), Z, side)
        thigh_lm = S.centroid_lm(th)
        K = J['knee_' + s](co)
        T = thigh_lm(co)
        hip_z = crotch + 0.07 * H / 1.685
        k = (hip_z - K[2]) / (T[2] - K[2])
        J['hip_' + s] = Landmark.combine([(1 - k, J['knee_' + s]), (k, thigh_lm)])
        # ---- foot: toe tip & heel on the sole
        foot = np.where(side & (co[:, 2] < 0.03 * H))[0]
        toe = foot[np.argmin(co[foot, 1])]
        heel = foot[np.argmax(co[foot, 1])]
        J['toe_' + s] = Landmark.vertex(toe)
        J['heel_' + s] = Landmark.vertex(heel)

        # ---- arm axis (A-pose): PCA of the free part of the arm
        arm = np.where(side & (np.abs(co[:, 0]) > 0.22 * H / 1.685) & (co[:, 2] > 0.80 * H / 1.685) &
                       (co[:, 2] < 1.18 * H / 1.685))[0]
        c, ax = _pca_axis(co[arm])
        if ax[2] > 0:
            ax = -ax  # points down the arm
        # glenohumeral joint: on the axis at 0.812 H
        tz = (0.812 * H - c[2]) / ax[2]
        gh_guess = c + ax * tz
        # arm region: close to the axis line, outside the torso
        rel = co - c
        dline = np.linalg.norm(rel - np.outer(rel @ ax, ax), axis=1)
        armv = side & (dline < 0.075 * H / 1.685)
        # section perpendicular to the axis just below the armpit for a robust centre line
        up = S.ring(co, gh_guess + ax * 0.10 * H / 1.685, ax, armv)
        up_lm = S.centroid_lm(up)
        # elbow & wrist from sections along the axis
        dist_e = 0.186 * H
        el = S.ring(co, gh_guess + ax * dist_e, ax, armv)
        J['elbow_' + s] = S.centroid_lm(el)
        # wrist: narrowest section in [0.30H, 0.36H] beyond the shoulder
        best = None
        E = J['elbow_' + s](co)
        for d in np.linspace(0.12, 0.17, 26) * H:
            p = E + ax * d
            try:
                r = S.ring(co, p, ax, armv | (side & (np.linalg.norm(co - p, axis=1) < 0.08 * H / 1.685)))
            except ValueError:
                continue
            per = np.ptp(r[2] @ np.cross(ax, [0, 1, 0]))
            if best is None or per < best[0]:
                best = (per, r, d)
        J['wrist_' + s] = S.centroid_lm(best[1])
        # GH joint: back-project from the upper-arm section along the elbow->upper line, at 0.812H
        U = up_lm(co)
        k2 = (0.812 * H - E[2]) / (U[2] - E[2])
        gh_line = Landmark.combine([(1 - k2, J['elbow_' + s]), (k2, up_lm)])
        # sagittal section through the shoulder mass at the joint's x: its centroid is the joint centre
        G = gh_line(co)
        cap = side & (co[:, 2] > 0.755 * H) & (np.abs(co[:, 0] - G[0]) < 0.06 * H / 1.685)
        sag = S.ring(co, np.array([G[0], G[1], G[2] - 0.02 * H / 1.685]), np.array([1.0, 0, 0]), cap)
        cap_lm = S.centroid_lm(sag)
        C_ = cap_lm(co)
        # keep the line's x, take depth/height from the shoulder-mass section (blend toward the line height)
        J['shoulder_' + s] = Landmark.combine([(0.5, gh_line), (0.5, cap_lm)])
        J['_gh_debug_' + s] = (G, C_)
        J['_armaxis_' + s] = ax
        _fingers(J, S, topo, co, s, sx, side, H)

    # ---- spine: torso sections, pivot 35% toward the back
    def mid_extreme(r, direction):
        ei, tt, pts = r
        near = np.where(np.abs(pts[:, 0]) < 0.03 * H / 1.685)[0]
        k = near[int(np.argmax(pts[near] @ np.asarray(direction, float)))]
        return Landmark([S.edges[ei[k], 0]], [S.edges[ei[k], 1]], [tt[k]], [1.0])

    torso = np.abs(co[:, 0]) < 0.24 * H / 1.685

    def spine_lm(z, back=0.35):
        r = S.ring(co, np.array([0, 0.0, z]), Z, torso)
        cen = S.centroid_lm(r)
        bk = mid_extreme(r, [0, 1, 0])
        fr = mid_extreme(r, [0, -1, 0])
        # depth-centre on the midline, then pulled toward the back
        return Landmark.combine([((1 - back) * 0.5, fr), ((1 - back) * 0.5 + back, bk)])

    hip_z = J['hip_L'](co)[2]
    J['pelvis'] = spine_lm(hip_z + 0.028 * H, 0.30)
    J['spine0'] = spine_lm(0.600 * H, 0.35)
    J['chest0'] = spine_lm(0.700 * H, 0.30)
    J['neck0'] = spine_lm(0.830 * H, 0.15)
    J['head0'] = spine_lm(0.905 * H, 0.20)
    top = int(np.argmax(co[:, 2]))
    J['head_top'] = Landmark.vertex(top)
    # sternoclavicular joints: front of the neck-base section, slightly lateral
    r = S.ring(co, np.array([0, 0, 0.815 * H]), Z, torso)
    front = mid_extreme(r, [0, -1, 0])
    back = mid_extreme(r, [0, 1, 0])
    J['sternum'] = Landmark.combine([(0.8, front), (0.2, back)])
    return J


def _fingers(J, S, topo, co, s, sx, side, H):
    """Finger joints from geodesic iso-bands, starting at the wrist ring."""
    W = J['wrist_' + s](co)
    E = J['elbow_' + s](co)
    ax = _norm(W - E)
    near = np.linalg.norm(co - W, axis=1) < 0.24 * H / 1.685
    hand = np.where(side & near & ((co - W) @ ax > 0.0))[0]
    mask = np.zeros(topo.nv, bool)
    mask[hand] = True
    seeds = [int(i) for i in hand if (co[i] - W) @ ax < 0.012 * H / 1.685 and np.linalg.norm(co[i] - W) < 0.06]
    dist = _geodesic_masked(topo, seeds, mask)
    # tips: local maxima of geodesic distance
    tips = []
    for i in hand:
        if not np.isfinite(dist[i]):
            continue
        ring2 = topo.grow([i], 3, mask)
        if all(dist[i] >= dist[j] for j in ring2):
            tips.append(i)
    tips = sorted(tips, key=lambda i: -dist[i])
    sel = []
    for i in tips:
        if all(np.linalg.norm(co[i] - co[j]) > 0.012 for j in sel):
            sel.append(i)
        if len(sel) == 5:
            break
    if len(sel) < 5:
        raise RuntimeError(f'found {len(sel)} finger tips')
    thumb = max(sel, key=lambda i: co[i][2] - 0.6 * abs(co[i][0]))  # shortest/highest
    rest = sorted([i for i in sel if i != thumb], key=lambda i: co[i][1])  # index most forward (-Y)
    names = dict(zip(FINGERS, [thumb] + rest))
    J['_hand_' + s] = {'tips': names}
    for fname, tip in names.items():
        dtip = _geodesic_masked(topo, [tip], mask)
        # centre line samples
        cl = []
        step = 0.004 * H / 1.685
        width = None
        web = None
        for k in range(2, 40):
            d = k * step
            band = np.where(mask & (np.abs(dtip - d) < step * 1.25))[0]
            if len(band) < 3:
                continue
            # keep the band component nearest the previous sample
            pts = co[band]
            cen = pts.mean(0)
            spread = np.max(np.linalg.norm(pts - cen, axis=1))
            if width is None and k >= 3:
                width = spread
            if width is not None and spread > 1.9 * width and web is None:
                web = d
                break
            cl.append((d, band))
        if web is None:
            web = cl[-1][0]
        # finger axis from the free part
        P = np.array([co[b].mean(0) for _, b in cl])
        D = np.array([d for d, _ in cl])
        A = np.polyfit(D, P, 1)  # P(d) = A[0]*d + A[1]
        tipP = co[tip]
        dirv = _norm(A[0])  # from tip toward palm
        base = A[1] + A[0] * web
        if fname == 'thumb':
            mcp_d = web
            joints = {'mcp': (web, 1.0), 'ip': (web * 0.44, 1.0)}
        else:
            mcp_d = web * 1.30
            joints = {'mcp': (mcp_d, 1.0), 'pip': (mcp_d * 0.52, 1.0), 'dip': (mcp_d * 0.235, 1.0)}
        for jn, (d, _) in joints.items():
            # landmark: average of the band verts at distance d (inside the finger) or extrapolate
            if d <= cl[-1][0]:
                band = min(cl, key=lambda x: abs(x[0] - d))[1]
                lm = Landmark(band, band, np.zeros(len(band)), np.full(len(band), 1.0 / len(band)))
            else:
                # extrapolate beyond the free part: affine combo of two band centroids
                d1, b1 = cl[len(cl) // 2]
                d2, b2 = cl[-1]
                k = (d - d1) / (d2 - d1)
                l1 = Landmark(b1, b1, np.zeros(len(b1)), np.full(len(b1), 1.0 / len(b1)))
                l2 = Landmark(b2, b2, np.zeros(len(b2)), np.full(len(b2), 1.0 / len(b2)))
                lm = Landmark.combine([(1 - k, l1), (k, l2)])
            J[f'{fname}_{jn}_{s}'] = lm
        J[f'{fname}_tip_{s}'] = Landmark.vertex(tip)
    # thumb CMC: between wrist centre and the thumb MCP, pulled toward the wrist
    J['thumb_cmc_' + s] = Landmark.combine([(0.62, J['wrist_' + s]), (0.38, J['thumb_mcp_' + s])])


def _geodesic_masked(topo, seeds, mask):
    import heapq
    dist = np.full(topo.nv, np.inf)
    h = [(0.0, s) for s in seeds]
    for s in seeds:
        dist[s] = 0.0
    heapq.heapify(h)
    co = topo.co
    while h:
        d, v = heapq.heappop(h)
        if d > dist[v]:
            continue
        for w in topo.adj[v]:
            if not mask[w]:
                continue
            nd = d + float(np.linalg.norm(co[v] - co[w]))
            if nd < dist[w]:
                dist[w] = nd
                heapq.heappush(h, (nd, w))
    return dist


def evaluate(J, co):
    return {k: v(co) for k, v in J.items() if isinstance(v, Landmark)}
