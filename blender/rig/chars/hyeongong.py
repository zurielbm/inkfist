"""Hyeon-gong 현공 (玄功) — The Iron Monk. Massive old monk: bald with nine ordination marks, long white drooping brows
and beard; saffron patchwork kasaya over the left shoulder with the right shoulder and arm bare; deep-crimson
under-robe and trousers; heavy belt; giant rosewood prayer beads with a red tassel; iron bracers; white gaiters;
straw sandals."""
import json
import math

import bpy
import numpy as np

from .. import charkit as K
from .. import face as FR
from .. import garment as G
from .. import hair as H_
from .. import outfit as O
from .. import skin
from ..assemble import build_objects, resolve_weights
from ..body import Body, Regions, smoothstep
from ..part import Part

ID = 'hyeongong'
H = 1.88  # top of the (bald) skull

# landmark heights of the skeleton the clip library was authored on (targets are remapped from these)
LEGACY = {'A': 0.0917, 'P': 1.010, 'S': 1.565}

COLORS = {
    'skin': '#c9a27a', 'kasaya': '#c77b2b', 'border': '#7a2a1c', 'kasaya_lining': '#8a4f1a', 'robe': '#6e1f22', 'robe_lining': '#4a1316',
    'pants': '#5a1c1e', 'pants_lining': '#3a1012', 'belt': '#3b2a20', 'bead': '#4a2c1c', 'tassel': '#a3262a',
    'iron': '#4a4f55', 'wrap': '#d8cfbb', 'straw': '#b89a5e', 'sole': '#6b5638', 'eye': '#f2ece0', 'lash': '#121110',
    'brow': '#e9e4da', 'beard': '#e9e4da', 'mouth': '#5a2a26',
}


# ---------------------------------------------------------------- body: a huge, heavy frame

def shape_body():
    b = Body('male')
    P = b.joints()
    hip = P['hip_L'][2]
    b.stretch_z(hip - 0.12, hip + 0.06, 0.985)        # heavy trunk, shorter legs
    b.scale_head(0.92)
    P = b.joints()
    co = b.co
    z = co[:, 2]
    # broad shoulders + deep barrel chest: widen everything above the waist (arms ride outward with it)
    up = smoothstep(P['spine0'][2] - 0.05, P['chest0'][2] + 0.10, z) * (1 - smoothstep(P['neck0'][2], P['head0'][2], z) * 0.85)
    co[:, 0] *= 1 + 0.17 * up
    cy = P['chest0'][1]
    co[:, 1] = cy + (co[:, 1] - cy) * (1 + 0.12 * up)
    b.co = co
    # thick arms, neck and thighs
    P = b.joints()
    for s in 'LR':
        w = b.capsule_weight(P['shoulder_' + s], P['wrist_' + s], 0.09, 0.07, feather=0.5)
        b.radial_scale(P['shoulder_' + s], P['wrist_' + s], 1.22, w)
        w = b.capsule_weight(P['hip_' + s], P['knee_' + s], 0.12, 0.08, feather=0.5)
        b.radial_scale(P['hip_' + s], P['knee_' + s], 1.10, w)
    w = b.capsule_weight(P['neck0'], P['head0'], 0.075, feather=0.6) * (1 - smoothstep(P['head0'][2] - 0.02, P['head0'][2] + 0.03, b.co[:, 2]))
    b.radial_scale(P['neck0'], P['head0'], 1.22, w)
    # a solid belly under the belt
    P = b.joints()
    belly = b.capsule_weight(P['spine0'] + np.array([0, -0.08, 0]), P['spine0'] + np.array([0, -0.08, 0.10]), 0.12, feather=0.8)
    belly *= (b.co[:, 1] < P['spine0'][1]).astype(float)
    b.inflate(belly, 0.025)
    b.fit_height(H)
    return b


# ---------------------------------------------------------------- spring chains

KASAYA_PANELS = [('cloth_fl', -100, -10), ('cloth_bl', -10, 90), ('cloth_br', 90, 190), ('cloth_fr', 190, 260)]
KASAYA_FOLLOW = {'cloth_fl': ('thigh_L', 0.55), 'cloth_fr': ('thigh_R', 0.55), 'cloth_bl': ('thigh_L', 0.25),
                 'cloth_br': ('thigh_R', 0.25)}


def chains(P, b=None):
    out = {}
    sp = np.array(P['spine0'])
    belt_lo = sp[2] - 0.07
    knee_z = P['knee_L'][2]
    z_hem = knee_z - 0.12
    for name, a0, a1 in KASAYA_PANELS:
        a = math.radians((a0 + a1) / 2)
        pts = []
        for k in range(4):
            t = k / 3
            r = 0.21 + 0.07 * t
            pts.append((r * math.cos(a), sp[1] + r * math.sin(a) * 0.85, belt_lo + (z_hem - belt_lo) * t))
        c = {'kind': 'cloth', 'parent': 'hips', 'points': pts, 'stiffness': 0.24, 'damping': 0.85, 'gravity': 0.55,
             'drag': 0.8}
        if name.endswith(('fl', 'fr')):
            c['follow'] = 'thigh_' + ('L' if name.endswith('l') else 'R')
            c['follow_amount'] = 0.3
        out[name] = c
    # prayer beads: the front loop hangs from the neck to the belly
    nk = np.array(P['neck0'])
    top = np.array([0.0, nk[1] - 0.12, nk[2] - 0.06])
    out['beads'] = {'kind': 'cloth', 'parent': 'chest', 'stiffness': 0.30, 'damping': 0.82, 'gravity': 0.9, 'drag': 0.4,
                    'margin': 0.03,
                    'points': [tuple(top + np.array([0, -0.035 * t, -0.30 * t])) for t in (0, 0.5, 1.0)]}
    # beard
    hd = np.array(P['head0'])
    chin = np.array([0.0, hd[1] - 0.115, hd[2] - 0.085])
    out['beard'] = {'kind': 'hair', 'parent': 'head', 'stiffness': 0.30, 'damping': 0.82, 'gravity': 0.4, 'drag': 0.6,
                    'margin': 0.02,
                    'points': [tuple(chin + np.array([0, -0.02 * t, -0.20 * t])) for t in (0, 0.33, 0.66, 1.0)]}
    # belt tails: knot at the front-right
    for name, dx, ln in (('sash_a', 0.0, 0.34), ('sash_b', -0.03, 0.26)):
        out[name] = {'kind': 'cloth', 'parent': 'hips', 'stiffness': 0.12, 'damping': 0.86, 'gravity': 0.7, 'drag': 1.0,
                     'points': [(-0.12 + dx - 0.02 * t, sp[1] - 0.175 - 0.01 * t, belt_lo - 0.01 - ln * t)
                                for t in (0, 1 / 3, 2 / 3, 1.0)]}
    return out


# ---------------------------------------------------------------- garments

def diag_cut(P):
    """The kasaya / under-robe edge: from the right armpit up across the chest to the left side of the neck.
    Returns f(co) -> signed distance (metres in the frontal plane, > 0 = bare side above the line)."""
    a = np.array([-0.17, P['chest0'][2] + 0.005])
    bpt = np.array([0.06, P['neck0'][2] + 0.01])
    d = bpt - a
    n = np.array([-d[1], d[0]]) / np.linalg.norm(d)   # points up-left of the line

    def f(co):
        rel = np.stack([co[:, 0], co[:, 2]], 1) - a
        return rel @ n
    f.n = n
    return f


RIGHT_ARM = ('upper_arm_R', 'forearm_R', 'forearm_twist_R', 'hand_R')


def off_right_arm(part, names, W, x0=-0.06, x1=-0.13):
    """Torso cloth along the bare side must not ride the right upper arm (it flaps out when the arm lifts): that
    share of its weight moves to the chest, fully from x1 outward."""
    if part.weights is None:
        src = np.asarray(part.src)
        Wp = np.zeros((part.nv, len(names)))
        Wp[src >= 0] = W[src[src >= 0]]
        nm = list(names)
    else:
        nm, Wp = part.weights[0], part.weights[1].copy()
    arm = [nm.index(n) for n in RIGHT_ARM if n in nm]
    k = smoothstep(x0, x1, part.co[:, 0])
    moved = Wp[:, arm].sum(1) * k
    Wp[:, arm] *= (1 - k)[:, None]
    Wp[:, nm.index('chest')] += moved
    part.weights = (nm, Wp)


def snap_to_cut(part, cut, target, surf, x_max=0.04, rows=3):
    """Slide the open edge along the diagonal onto cut == target: a straight cut instead of the body-topology
    staircase. The rows behind it relax, and everything moved is re-seated on surf at its old height."""
    co = part.co
    f = cut(co)
    n3 = np.array([cut.n[0], 0.0, cut.n[1]])
    edge = np.zeros(part.nv, bool)
    for L in G.boundary_loops(part.faces):
        L = np.asarray(L)
        edge[L[(co[L, 0] < x_max) & (np.abs(f[L] - target) < 0.05)]] = True
    nb = [np.fromiter(a, int) for a in G.adjacency(part.nv, part.faces)]
    band = edge.copy()
    for _ in range(rows):
        band = band | np.array([band[n].any() for n in nb])
    idx = np.flatnonzero(band)
    h = []
    for i in idx:
        loc, nrm, _, _ = surf.nearest(co[i])
        h.append((co[i] - loc) @ nrm)
    co[edge] += np.outer(target - f[edge], n3)
    free = np.flatnonzero(band & ~edge)
    for _ in range(8):
        avg = np.array([co[nb[i]].mean(0) for i in free])
        co[free] += 0.6 * (avg - co[free])
    for i, hi in zip(idx, h):
        loc, nrm, _, _ = surf.nearest(co[i])
        co[i] = loc + nrm * hi
    part.co = co


def garments(b, R, P, names, CH):
    co = b.co
    z = co[:, 2]
    topo = b.topo
    parts = []
    sp = np.array(P['spine0'])
    belt_lo, belt_hi = sp[2] - 0.07, sp[2] + 0.05
    knee_z = P['knee_L'][2]
    body_surf = G.Surface(co, topo.faces)
    proxy = O.dressing_proxy(b, R)
    proxy_surf = G.Surface(proxy, topo.faces)
    cut = diag_cut(P)
    def bare(t):   # right shoulder, right chest and right arm; t shifts the diagonal toward the bare side
        return (cut(co) > t) & (co[:, 0] < 0.08) | (R.arm['R'] > 0.5)

    # ---- crimson trousers to the ankles (gaiters over the shins)
    tr_m = (z < sp[2] + 0.02) & (R.arms < 0.5) & ((R.legs < 0.5) | (R.legt < 1.85))
    baggy = (0.014 + 0.03 * smoothstep(P['hip_L'][2] + 0.05, knee_z, z)) * (1 - 0.75 * smoothstep(knee_z - 0.02, knee_z - 0.14, z))
    pants = G.shell(topo, proxy, tr_m, 'pants', 'pants', offset=0.006, loosen=baggy * R.legs, smooth=25,
                    min_gap=0.005, clear=proxy_surf, hard=body_surf)
    G.orient_from(pants, body_surf)
    O.finish(pants, 0.003, 'pants_lining')
    parts.append(pants)

    # ---- under-robe: left shoulder + chest below the diagonal + left sleeve to mid-forearm
    # (its diagonal edge shows ~1.5 cm past the kasaya border)
    rb_reg = (R.headneck < 0.3) & ((R.arms < 0.5) | (R.armt < 1.5)) & (z > belt_lo - 0.02)
    rb_m = rb_reg & ~bare(0.05)
    robe = G.shell(topo, co, rb_m, 'robe', 'robe', offset=0.006, loosen=0.010 * R.arms, smooth=18, min_gap=0.004,
                   clear=body_surf)
    G.orient_from(robe, body_surf)
    snap_to_cut(robe, cut, 0.032, body_surf)
    off_right_arm(robe, names, R.W)
    O.finish(robe, 0.003, 'robe_lining')
    parts.append(robe)

    # ---- kasaya: over the robe on the torso, then a wrap skirt to below the knee on four chained panels
    pants_surf = G.surface_of(pants)
    robe_surf = G.surface_of(robe)
    ks_m = (R.headneck < 0.3) & ~bare(0.0) & ((R.arms < 0.5) | (R.armt < 0.35)) & (z > belt_lo)
    kas = G.shell(topo, co, ks_m, 'kasaya', 'kasaya', offset=0.012, loosen=0.004, smooth=16, min_gap=0.004,
                  clear=[body_surf, (robe_surf, 0.005)], hard=[(robe_surf, 0.004)])
    snap_to_cut(kas, cut, -0.004, robe_surf)
    G.layer_over(kas, robe, 0.005)
    bottom = G.waist_loop(kas, belt_lo)
    G.straighten(kas, bottom, (0, 0, belt_lo), (0, 0, 1))
    under = [proxy_surf, (pants_surf, 0.010)]
    _, cy = O.skirt(kas, bottom, belt_lo, knee_z - 0.12, under, nr=10, flare=0.42, back=0.03,
                    slits=((-100, 2), (-10, 3), (190, 3), (90, 4)))
    G.orient_from(kas, body_surf)
    kas.weights = O.chain_part_weights(kas, cy, co, topo, names, R.W, CH, KASAYA_PANELS, follow=KASAYA_FOLLOW)
    off_right_arm(kas, names, R.W)
    O.finish(kas, 0.004, 'kasaya_lining')
    parts.append(kas)

    # ---- gaiters (white shin wraps) and straw sandals
    gw_m = (R.legs > 0.5) & (R.legt > 1.35) & (R.legt < 2.05)
    gw = G.shell(topo, proxy, gw_m, 'gaiter', 'wrap', offset=0.010, smooth=8, min_gap=0.006,
                 clear=[proxy_surf, (pants_surf, 0.004)])
    for s in 'LR':
        kn, an = np.array(P['knee_' + s]), np.array(P['ankle_' + s])
        ax = (an - kn) / np.linalg.norm(an - kn)
        loops = G.boundary_loops(gw.faces)
        lo = min(loops, key=lambda L: np.linalg.norm(gw.co[L].mean(0) - an))
        hi = min(loops, key=lambda L: np.linalg.norm(gw.co[L].mean(0) - (kn + (an - kn) * 0.35)))
        G.straighten(gw, lo, an + ax * 0.005, ax)
        G.straighten(gw, hi, kn + (an - kn) * 0.33, ax)
    gw.co = G.clear_layers(gw.co, [(pants_surf, 0.005), (body_surf, 0.006)], np.full(gw.nv, 0.005), passes=2)
    parts.append(O.finish(gw, 0.002, 'wrap'))
    for s in 'LR':
        parts += O.shoe(P, s, paint='straw', sole_paint='sole')

    covered = (((rb_reg & ~bare(0.012)) | ks_m) & (z < P['neck0'][2] - 0.03)) | tr_m | gw_m | ((R.legs > 0.5) & (R.legt > 1.97))
    return parts, covered


# ---------------------------------------------------------------- trims: belt, beads, bracers

def trims(b, R, P, kas, CH):
    parts = []
    sp = np.array(P['spine0'])
    belt_lo, belt_hi = sp[2] - 0.07, sp[2] + 0.05
    zs = 0.5 * (belt_lo + belt_hi)
    torso = G.surface_where(kas, lambda c: abs(c[0]) < 0.30 and abs(c[2] - zs) < 0.14)
    ring, rn = G.ring_on(torso, (0.0, kas.co[:, 1].mean()), zs, 60, lift=0.004, r0=0.40)
    parts.append(G.band(ring, rn, belt_hi - belt_lo, 0.014, 'belt', 'belt', closed=True))
    kp = np.array(CH['sash_a']['points'][0]) + np.array([0, -0.01, 0.025])
    parts.append(O.ellipsoid_part(kp, (0.042, 0.028, 0.034), 'belt_knot', 'belt'))
    for nm, w in (('sash_a', 0.07), ('sash_b', 0.06)):
        pts = G.catmull(CH[nm]['points'], 14)
        d = np.array([-0.3, -1.0, 0.0])
        nrm = np.tile(d / np.linalg.norm(d), (len(pts), 1))
        tail = G.band(pts, nrm, w, 0.008, nm, 'belt', w_profile=np.linspace(1.0, 0.85, len(pts)))
        tail.weights = skin.chain_weights(tail.co, CH[nm]['points'], CH[nm]['bones'], root='hips', root_len=0.06)
        parts.append(tail)

    # dark-red border along the kasaya's neckline and diagonal edge (hides the cut, as on a real kasaya)
    edge = max(kas.open_rings, key=lambda r: r[:, 2].mean())
    kas_surf = G.surface_of(kas)
    path = G.catmull(edge[:: max(1, len(edge) // 40)], 90, closed=True)
    path, nrm = G.project_path(kas_surf, path, lift=0.001)
    for _ in range(2):
        path = 0.5 * path + 0.25 * (np.roll(path, 1, 0) + np.roll(path, -1, 0))
    parts.append(G.band(path, nrm, 0.034, 0.006, 'kasaya_border', 'border', closed=True, align=0.5))

    # prayer beads: a ring of big beads around the back of the neck, the front loop hanging to the belly
    nk = np.array(P['neck0'])
    body_surf = G.Surface(b.co, b.topo.faces)
    # one continuous loop: behind the neck, then the front U hanging to the belly
    back = []
    for k in range(9):
        a = math.radians(-15 + 210 * k / 8)
        back.append(np.array([math.cos(a) * 0.13, nk[1] + math.sin(a) * 0.09 + 0.012, nk[2] - 0.03 + 0.025 * math.sin(a)]))
    bottom = np.array(CH['beads']['points'][-1])
    front = [back[-1] + np.array([0.0, -0.06, -0.10]), bottom + np.array([-0.07, -0.02, 0.10]), bottom,
             bottom + np.array([0.07, -0.02, 0.10]), back[0] + np.array([0.0, -0.06, -0.10])]
    loop = G.catmull(back + front, 200, closed=True)
    for i, p in enumerate(loop):
        loc, nrm, _, _ = body_surf.nearest(p)
        if (p - loc) @ nrm < 0.035:
            loop[i] = loc + nrm * 0.035
    seg = np.linalg.norm(np.diff(np.vstack([loop, loop[:1]]), axis=0), axis=1)
    s_acc = np.concatenate([[0], np.cumsum(seg)])
    total = s_acc[-1]
    rb = 0.0165
    nb = int(total / (2 * rb * 1.02))
    bead_pts = [np.array([np.interp(t, s_acc, np.append(loop[:, k], loop[0, k])) for k in range(3)])
                for t in np.linspace(0, total, nb, endpoint=False)]
    i_bottom = int(np.argmin([q[2] for q in bead_pts]))
    beads = []
    for i, p in enumerate(bead_pts):
        big = 0.022 if i == i_bottom else rb
        beads.append(O.ellipsoid_part(p, (big, big, big), f'bead{i}', 'bead', segs=10, rings=7))
    knot = O.ellipsoid_part(bottom + np.array([0, -0.01, -0.03]), (0.014, 0.012, 0.018), 'tassel_knot', 'tassel')
    tassel = G.tube(G.catmull([bottom + np.array([0, -0.01, -0.04]), bottom + np.array([0, -0.012, -0.10]),
                               bottom + np.array([0, -0.014, -0.16])], 8), np.linspace(0.008, 0.02, 8).tolist(),
                    'tassel', 'tassel', segs=10)
    for p in beads + [knot, tassel]:
        front = p.co.mean(0)[1] < nk[1] - 0.06 and p.co.mean(0)[2] < nk[2] - 0.05
        if front:
            p.weights = skin.chain_weights(p.co, CH['beads']['points'], CH['beads']['bones'], root='chest', root_len=0.05)
        else:
            p.weights = (['chest'], np.ones((p.nv, 1)))
        parts.append(p)

    # iron bracers on both forearms
    for s in 'LR':
        el, wr = np.array(P['elbow_' + s]), np.array(P['wrist_' + s])
        ax = (wr - el) / np.linalg.norm(wr - el)
        rings = []
        for k in range(6):
            t = 0.42 + 0.56 * k / 5
            c = el + (wr - el) * t
            sel = np.linalg.norm(b.co - c, axis=1) < 0.09
            rel = b.co[sel] - c
            rel = rel - np.outer(rel @ ax, ax)
            r = float(np.percentile(np.linalg.norm(rel, axis=1), 90)) + 0.010 + (0.006 if k in (0, 5) else 0.0)
            u = np.cross(ax, np.array([0, 0, 1.0]))
            u /= np.linalg.norm(u)
            v = np.cross(ax, u)
            rings.append(np.array([c + (u * math.cos(a) + v * math.sin(a)) * r
                                   for a in np.linspace(0, 2 * math.pi, 18, endpoint=False)]))
        br = G.lofted(rings, 'bracer_' + s, 'iron')
        br.weights = (['forearm_' + s, 'forearm_twist_' + s], np.tile([0.5, 0.5], (br.nv, 1)))
        parts.append(br)
    return parts


# ---------------------------------------------------------------- head: white brows + beard (the "hair" mesh)

def hair_parts(b, fr, P, CH):
    rng = np.random.default_rng(5)
    parts = []
    head_surf = G.Surface(b.co, b.topo.faces)

    class _S:   # a minimal scalp stand-in: locks only need a centre + collision surfaces
        pass
    sc = _S()
    sc.center = H_.Scalp.center_of(P)
    sc.top = np.array(P['head_top'])
    sc.surf = head_surf
    sc.coll = head_surf
    # long drooping white brows: clumps from the brow ridge past the outer eye corners
    for s, sx in (('L', 1), ('R', -1)):
        E = fr.eyes[s]
        for k in range(4):
            t = k / 3
            root = E.c + np.array([sx * (-0.016 + 0.024 * t), -0.008, 0.017 + 0.003 * math.sin(math.pi * t)])
            pts = [root, root + np.array([sx * 0.016, -0.006, 0.002]),
                   root + np.array([sx * (0.030 + 0.01 * t), -0.004, -0.018 - 0.01 * t]),
                   root + np.array([sx * (0.036 + 0.014 * t), 0.004, -0.050 - 0.02 * t])]
            lk = H_.curve_lock(sc, pts, 0.011 + 0.003 * (1 - t), f'brow{s}{k}', thick=0.5, lift=0.003, n=10,
                               root_width=0.006, paint='brow', bury=0.0)
            lk.weights = (['head'], np.ones((lk.nv, 1)))
            parts.append(lk)
    # moustache sweeping down past the mouth corners
    m = fr.mouth_c
    for sx in (1, -1):
        for k in range(3):
            root = np.array([sx * (0.006 + 0.008 * k), m[1] - 0.004, m[2] + 0.016])
            pts = [root, root + np.array([sx * 0.018, -0.004, -0.004]), root + np.array([sx * 0.032, 0.0, -0.030]),
                   root + np.array([sx * 0.036, 0.006, -0.070 - 0.01 * k])]
            lk = H_.curve_lock(sc, pts, 0.012, f'stache{k}{sx}', thick=0.5, lift=0.002, n=10, root_width=0.006,
                               paint='beard', bury=0.0)
            lk.weights = (['head'], np.ones((lk.nv, 1)))
            parts.append(lk)
    # beard: clumps from the jaw and chin, falling to the chest on the beard chain
    bp = np.array(CH['beard']['points'])
    for i in range(11):
        u = (i - 5) / 5
        root = np.array([u * 0.05, m[1] + 0.015 + 0.03 * abs(u) ** 1.5, m[2] - 0.028 + 0.035 * abs(u) ** 1.6])
        root, _ = head_surf.nearest(root)[0], None
        end = bp[-1] + np.array([u * 0.035, 0.0, rng.uniform(-0.03, 0.02) + 0.05 * abs(u)])
        mid = 0.5 * (root + end) + np.array([u * 0.012, -0.03, 0.0])
        lk = H_.curve_lock(sc, [root, root + np.array([0, -0.02, -0.02]), mid, end], rng.uniform(0.022, 0.030),
                           f'beard{i}', thick=0.5, lift=0.004, n=14, root_width=0.014, paint='beard', bury=0.004)
        lk.weights = skin.chain_weights(lk.co, CH['beard']['points'], CH['beard']['bones'], root='head', root_len=0.03)
        parts.append(lk)
    return parts


# ---------------------------------------------------------------- face + paint

FACE = {
    'brow_ctrl': [(-0.020, 0.013), (-0.008, 0.018), (0.006, 0.020), (0.018, 0.017)],
    'brow_width': [0.007, 0.007, 0.006, 0.004],
    'brow_paint': 'brow',
    'lash': (0.0010, 0.0030, 0.004),
}

PAINT = {
    'kasaya': ('kasaya', {'base': '#c77b2b', 'dark': '#8f5219', 'seam': '#5a2a12', 'band': '#7a2a1c',
                          'band_at': (0.004, 0.030), 'pool': 0.12}),
    'border': ('cloth', {'base': '#7a2a1c', 'dark': '#4e170f', 'pool': 0.0, 'hem_line': False}),
    'kasaya_lining': ('cloth', {'base': '#9a5a20', 'dark': '#6e3c12', 'pool': 0.04, 'hem_line': False}),
    'robe': ('cloth', {'base': '#6e1f22', 'dark': '#3e0d10', 'pool': 0.10}),
    'robe_lining': ('flat', {'base': '#4a1316'}),
    'pants': ('cloth', {'base': '#5c2224', 'dark': '#381214', 'pool': 0.08}),
    'pants_lining': ('flat', {'base': '#3a1012'}),
    'belt': ('trim', {'base': '#3b2a20', 'stripe': '#5a4231', 'stripe_at': (-0.02, 0.02)}),
    'bead': ('flat', {'base': '#5a3420', 'sheen': 0.5}),
    'tassel': ('cloth', {'base': '#a3262a', 'dark': '#6b1518', 'hem_line': False}),
    'iron': ('flat', {'base': '#4f555c', 'sheen': 0.9, 'line': 0.0}),
    'wrap': ('wrap', {'base': '#ddd4c0', 'dark': '#a39983'}),
    'straw': ('wrap', {'base': '#c2a466', 'dark': '#8a7240', 'pitch': 160.0, 'slant': 60.0}),
    'sole': ('flat', {'base': '#6b5638'}),
    'skin': ('skin', {'base': '#cfa67c', 'shade': '#b98c62'}),
    'mouth': ('mouth', {'base': '#4a2420'}),
    'eye': ('eye', {'iris': '#1d130e', 'iris_lo': '#4e3524', 'iris_r': 0.0078}),
    'lash': ('flat', {'base': '#2a2522', 'bias': 0.3}),
    'brow': ('hair', {'base': '#e8e3d8', 'root': '#cfc8ba', 'streak': '#ffffff', 'streak_scale': 60.0}),
    'beard': ('hair', {'base': '#ece7dc', 'root': '#cfc8ba', 'streak': '#ffffff', 'streak_scale': 60.0}),
}


def build(bake=True):
    T = K.Timer(ID)
    b = shape_body()
    P0 = b.joints()
    CH = chains(P0, b)
    arm, P, names, W = K.build_rig(b, CH, ID)
    T('rig')
    R = Regions(b, names, W, P)
    fr = FR.FaceRig(b)
    parts, covered = garments(b, R, P, names, CH)
    T('garments')
    kas = next(p for p in parts if p.name == 'kasaya')
    parts += trims(b, R, P, kas, CH)
    body_skin, head = K.skin_parts(b, covered, names, W, fr)
    parts += [body_skin, head] + K.face_features(b, fr, head, FACE)
    hp = hair_parts(b, fr, P, CH)
    for p in hp:
        p.group = 'hair'
    parts += hp
    T('hair + face')
    for p in parts:
        if p.name.split('_')[0] in ('belt', 'sash', 'tassel') or p.name == 'kasaya_border':
            p.torso_only = True
    tris = skin.triangulate(b.topo.faces)
    resolve_weights(parts, b.co, tris, names, W)
    objs = list(build_objects(ID, parts, arm, names, COLORS).values())
    T('objects')
    if bake:
        paints = dict(PAINT)
        e = fr.eyes['L']
        m = fr.mouth_c
        spots = K.face_spots(fr, lips=('#9a6a58', 0.35))
        # nine ordination marks on the crown, forehead lines, nasolabial folds, crow's feet
        top = P['head_top']
        for i in range(3):
            for j in range(3):
                spots.append(((j - 1) * 0.018, top[2] - 0.035 - i * 0.018, 0.0032, '#7d5a40', 0.9, False))
        for k in range(3):
            for t in np.linspace(-1, 1, 9):
                spots.append((t * 0.032, e.c[2] + 0.045 + 0.012 * k + 0.004 * t * t, 0.0016, '#8a6448', 0.55, False))
        for t in np.linspace(0, 1, 7):
            spots.append((0.018 + 0.016 * t, m[2] + 0.034 - 0.040 * t, 0.0018, '#8a6448', 0.55, True))
            spots.append((e.c[0] + 0.020 + 0.006 * t, e.c[2] + 0.006 - 0.012 * t, 0.0012, '#8a6448', 0.45, True))
        paints['skin'] = ('skin', dict(PAINT['skin'][1], spots=spots))
        K.surface(arm, objs, paints, ID)
    K.ink_prep(objs, H_.Scalp.center_of(P))
    arm['colliders'] = json.dumps(K.colliders(b, names, W, arm))
    T('ink prep')
    return arm, objs, CH
