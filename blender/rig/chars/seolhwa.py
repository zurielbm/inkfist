"""Seol-hwa 설화 (雪花) — The Crimson Sleeve. Sleeve-dancer: very long black hair, half-up into a bun with a gold
plum-blossom pin; crimson open outer robe with gold borders and deep hanging sleeves; pleated lavender silk dress;
plum-black sash with a jade norigae and red tassel; red-brown boots with gold tooling."""
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

ID = 'seolhwa'
H = 1.64  # top of skull (the bun adds ~6 cm)

# landmark heights of the skeleton the clip library was authored on (targets are remapped from these)
LEGACY = {'A': 0.079, 'P': 0.921, 'S': 1.335}

COLORS = {
    'skin': '#ecd7b8', 'hair': '#17161a', 'robe': '#a3262a', 'robe_lining': '#5c171b', 'gold': '#b8893a',
    'dress': '#a99bbd', 'dress_lining': '#85789a', 'collar': '#ece2cc', 'sash': '#2b2228', 'boot': '#7a3b2a',
    'sole': '#3a2a22', 'eye': '#f2ece0', 'lash': '#121110', 'brow': '#1b1a18', 'mouth': '#5a2a26',
    'jade': '#4f7a62', 'tassel': '#a3262a', 'pin': '#b8893a',
}


# ---------------------------------------------------------------- body

def shape_body():
    b = Body('female')
    P = b.joints()
    hip = P['hip_L'][2]
    b.stretch_z(hip - 0.12, hip + 0.06, 1.05)   # long dancer's legs
    b.scale_head(0.95)
    b.fit_height(H)
    return b


def _legacy_joints():
    """Joint table in the old (head, tail) format; the clip library reads J['hips'][0][2]."""
    b = shape_body()
    P = b.joints()
    return {'hips': (tuple(P['pelvis']), tuple(P['spine0']))}


J = _legacy_joints()


# ---------------------------------------------------------------- spring chains

ROBE_PANELS = [('cloth_fl', -84, -8), ('cloth_bl', -8, 90), ('cloth_br', 90, 188), ('cloth_fr', 188, 264)]
DRESS_PANELS = [('skirt_fl', -90, 0), ('skirt_bl', 0, 90), ('skirt_br', 90, 180), ('skirt_fr', 180, 270)]


def back_y(b, z, x, half=0.05):
    """Body's back surface (+Y) at height z near lateral position x."""
    co = b.co
    m = (np.abs(co[:, 2] - z) < 0.025) & (np.abs(co[:, 0] - x) < half)
    return float(co[m, 1].max()) if m.any() else 0.1


def chains(P, b=None):
    out = {}
    sp = np.array(P['spine0'])
    navel_z = sp[2]
    sash_lo = navel_z - 0.06
    knee_z = P['knee_L'][2]
    for prefix, panels, z_hem, r0, r1, stiff in (('cloth', ROBE_PANELS, knee_z - 0.22, 0.16, 0.25, 0.20),
                                                ('skirt', DRESS_PANELS, 0.10, 0.14, 0.21, 0.26)):
        for name, a0, a1 in panels:
            a = math.radians((a0 + a1) / 2)
            pts = []
            for k in range(4):
                t = k / 3
                r = r0 + (r1 - r0) * t
                pts.append((r * math.cos(a), sp[1] + r * math.sin(a) * 0.85, sash_lo + (z_hem - sash_lo) * t))
            c = {'kind': 'cloth', 'parent': 'hips', 'points': pts, 'stiffness': stiff, 'damping': 0.85,
                 'gravity': 0.55, 'drag': 0.9}
            if 'f' in name.split('_')[1]:
                c['follow'] = 'thigh_' + ('L' if name.endswith('l') else 'R')
                c['follow_amount'] = 0.75 if prefix == 'skirt' else 0.55
            out[name] = c
    # deep hanging sleeves: from the elbow to the bottom of the sleeve bag
    for s in 'LR':
        el, wr = np.array(P['elbow_' + s]), np.array(P['wrist_' + s])
        ax = (wr - el) / np.linalg.norm(wr - el)
        down = np.array([0, 0, -1.0]) - ax * (-ax[2])
        down /= np.linalg.norm(down)
        L = np.linalg.norm(wr - el) + SLEEVE['past']
        pts = [tuple(el + ax * L * t + down * (SLEEVE['droop'] * t ** 1.4 + SLEEVE['r_open'] * 0.9 * t)) for t in
               (0.0, 0.34, 0.67, 1.0)]
        out['sleeve_' + s] = {'kind': 'cloth', 'parent': 'forearm_' + s, 'points': pts, 'stiffness': 0.12,
                              'damping': 0.84, 'gravity': 0.6, 'drag': 1.1}
    # hair curtain down the back (left / centre / right), following the back's contour with clearance
    hd = np.array(P['head0'])
    for name, dx in (('hair_l', 0.07), ('hair_c', 0.0), ('hair_r', -0.07)):
        pts = []
        for t in (0, 0.25, 0.5, 0.75, 1.0):
            z = hd[2] - 0.02 - 0.78 * t
            y = back_y(b, z, dx * (0.6 + 0.5 * t)) + 0.045 + 0.02 * t if b is not None else hd[1] + 0.10 + 0.06 * t
            y = max(y, hd[1] + 0.10)
            pts.append((dx * (0.6 + 0.5 * t), y, z))
        out[name] = {'kind': 'hair', 'parent': 'head', 'points': pts, 'stiffness': 0.26, 'damping': 0.82,
                     'gravity': 0.45, 'drag': 0.7, 'margin': 0.03}
    # norigae: jade + knot + tassel hanging from the sash at the front-left
    top = np.array([0.085, sp[1] - 0.115, sash_lo - 0.005])
    out['norigae'] = {'kind': 'cloth', 'parent': 'hips',
                      'points': [tuple(top + np.array([0.004 * t, -0.006 * t, -0.24 * t])) for t in (0, 0.33, 0.66, 1.0)],
                      'stiffness': 0.10, 'damping': 0.86, 'gravity': 0.8, 'drag': 1.0}
    return out


SLEEVE = {'r_open': 0.118, 'droop': 0.065, 'past': 0.03}


# ---------------------------------------------------------------- garments

def garments(b, R, P, names, CH):
    co = b.co
    z = co[:, 2]
    topo = b.topo
    parts = []
    navel_z = P['spine0'][2]
    sash_lo, sash_hi = navel_z - 0.06, navel_z + 0.035
    knee_z = P['knee_L'][2]
    body_surf = G.Surface(co, topo.faces)
    proxy = O.dressing_proxy(b, R)
    proxy_surf = G.Surface(proxy, topo.faces)

    # ---- lavender silk dress: fitted bodice + long pleated skirt to the ankles
    dr_m = (R.headneck < 0.30) & ((R.arms < 0.5) | (R.armt < 0.12)) & (z > sash_lo)
    # tight layers drape over the real body (membrane bridges the bust), loose ones may rest on the proxy
    dress = G.shell(topo, co, dr_m, 'dress', 'dress', offset=0.005, smooth=14, min_gap=0.003, clear=body_surf)
    loops = G.boundary_loops(dress.faces)
    bottom = G.waist_loop(dress, sash_lo)
    G.straighten(dress, bottom, (0, 0, sash_lo), (0, 0, 1))
    _, cy_d = O.skirt(dress, bottom, sash_lo, 0.085, G.surface_of((proxy, topo.faces)), nr=13, flare=0.42,
                      folds=((22, 0.018, 0.0), (11, 0.02, 0.9)), back=0.02, gap=(0.006, 0.018),
                      slits=((-90, 5), (0, 4), (90, 5), (180, 4)))
    G.orient_from(dress, body_surf)
    dress.weights = O.chain_part_weights(dress, cy_d, co, topo, names, R.W, CH, DRESS_PANELS, ramp=0.3)
    O.finish(dress, 0.0025, 'dress_lining')
    parts.append(dress)

    # ---- crimson outer robe: open front (painted inlay above the sash, a real split below), deep sleeves
    rb_m = (R.headneck < 0.30) & ((R.arms < 0.5) | (R.armt < 1.0)) & (z > sash_lo)
    loosen = 0.004 + 0.008 * R.arms
    dress_surf = G.surface_of(dress)
    under = [body_surf, (dress_surf, 0.007)]
    robe = G.shell(topo, co, rb_m, 'robe', 'robe', offset=0.013, loosen=loosen, smooth=22, min_gap=0.005,
                   clear=under, hard=[(dress_surf, 0.004)])
    G.layer_over(robe, dress, 0.006)
    loops = G.boundary_loops(robe.faces)
    bottom = G.waist_loop(robe, sash_lo)
    G.straighten(robe, bottom, (0, 0, sash_lo), (0, 0, 1))
    for s in 'LR':
        el, wr = P['elbow_' + s], P['wrist_' + s]
        cuff = min(loops, key=lambda L: np.linalg.norm(robe.co[L].mean(0) - el))
        G.straighten(robe, cuff, el + (wr - el) * 0.02, wr - el)
        O.bell_sleeve(robe, cuff, el, wr, SLEEVE['r_open'], SLEEVE['droop'], past=SLEEVE['past'])
    bottom = G.waist_loop(robe, sash_lo)
    _, cy = O.skirt(robe, bottom, sash_lo, knee_z - 0.22, [proxy_surf, (dress_surf, 0.012)], nr=11,
                    flare=0.5, back=0.04, gap=(0.012, 0.02), slits=((-8, 3), (188, 3), (90, 5)),
                    front_open=(-90, 6, 0))
    # signed distance to the open front (painted above the sash, where the robe still meets in the middle)
    w = 0.030 + 0.03 * smoothstep(P['neck0'][2] - 0.05, sash_lo, robe.co[:, 2])
    sd = np.abs(robe.co[:, 0]) - w
    sd[robe.co[:, 1] > robe.co[:, 1].mean() - 0.02] = 0.2   # back half: never
    robe.attrs['open_sd'] = sd
    G.orient_from(robe, body_surf)
    robe.weights = robe_weights(robe, cy, co, topo, names, R.W, CH)
    O.finish(robe, 0.004, 'robe_lining')
    parts.append(robe)

    # ---- boots
    for s in 'LR':
        ps = O.shoe(P, s, paint='boot', sole_paint='sole', shaft=0.20, shaft_r=(0.047, 0.044), toe_up=0.008)
        for p in ps:
            if p.name.startswith('shaft'):
                O.finish(p, 0.003, 'boot')
        parts += ps
    covered = (dr_m & (z < P['neck0'][2] - 0.03)) | ((R.legs > 0.5) & (R.legt > 1.35)) | (z < sash_lo) & (R.arms < 0.5)
    return parts, covered


def robe_weights(robe, cy, co, topo, names, W, CH):
    """Torso from the body, skirt panels from their chains, sleeves from the forearm into the sleeve chains."""
    names_, Wc = O.chain_part_weights(robe, cy, co, topo, names, W, CH, ROBE_PANELS)
    st = robe.attrs['sleeve_t']
    idx = {n: i for i, n in enumerate(names)}
    for s in 'LR':
        sx = 1 if s == 'L' else -1
        vs = np.where((st >= 0) & (np.sign(robe.co[:, 0]) == sx))[0]
        if not len(vs):
            continue
        c = CH['sleeve_' + s]
        bn, Wch = skin.chain_weights(robe.co[vs], c['points'], c['bones'])
        f = smoothstep(0.0, 0.45, st[vs])[:, None]
        Wn = np.zeros((len(vs), len(names)))
        for j, bname in enumerate(bn):
            Wn[:, idx[bname]] = Wch[:, j]
        base = np.zeros((len(vs), len(names)))
        base[:, idx['forearm_' + s]] = 1.0
        Wc[vs] = (1 - f) * base + f * Wn
    return (names_, Wc)


# ---------------------------------------------------------------- trims: collar, sash, norigae

def trims(b, R, P, robe, dress, CH):
    parts = []
    sp = np.array(P['spine0'])
    navel_z = sp[2]
    sash_lo, sash_hi = navel_z - 0.06, navel_z + 0.035
    robe_surf = G.surface_of(robe)
    NL = max(dress.open_rings, key=lambda r: r[:, 2].mean())
    cn = NL.mean(0)
    ang = np.degrees(np.arctan2(NL[:, 1] - cn[1], NL[:, 0] - cn[0]))

    def neck_pt(a, dz=0.0):
        d = np.abs((ang - a + 180) % 360 - 180)
        return NL[int(np.argmin(d))] + np.array([0, 0, dz])

    # white inner collar (cross collar of the dress), visible in the robe's open front
    dress_surf = G.surface_of(dress)
    for sign, name in ((1, 'collar_l'), (-1, 'collar_r')):
        ctrl = [neck_pt(90, 0.006), neck_pt(90 - sign * 60, 0.004), neck_pt(-90 + sign * 40, -0.004)]
        for t in (0.35, 0.7, 1.0):
            x = sign * (0.02 - 0.05 * t)
            hit = G.ray_front(dress_surf, x, cn[2] - 0.03 - 0.08 * t)
            if hit is not None:
                ctrl.append(hit)
        path, nrm = G.project_path(dress_surf, G.catmull(ctrl, 30), lift=0.0012 if sign > 0 else 0.0006)
        parts.append(G.band(path, nrm, 0.026, 0.004, name, 'collar', align=0.4))
    # sash over robe and dress at the waist + knot
    zs = 0.5 * (sash_lo + sash_hi)
    torso = G.surface_where(robe, lambda c: abs(c[0]) < 0.20 and abs(c[2] - zs) < 0.12)
    ring, rn = G.ring_on(torso, (0.0, robe.co[:, 1].mean()), zs, 56, lift=0.003, r0=0.30)
    parts.append(G.band(ring, rn, sash_hi - sash_lo, 0.009, 'sash', 'sash', closed=True))
    kp = np.array(CH['norigae']['points'][0]) + np.array([0, -0.006, 0.012])
    parts.append(O.ellipsoid_part(kp, (0.024, 0.016, 0.020), 'sash_knot', 'sash'))
    # norigae: jade disc, red knot, long tassel
    pts = np.array(CH['norigae']['points'])
    jade_c = pts[0] + (pts[1] - pts[0]) * 0.55
    disc = O.ellipsoid_part(jade_c, (0.022, 0.008, 0.022), 'jade', 'jade', segs=16, rings=8)
    knot = O.ellipsoid_part(pts[1] + (pts[2] - pts[1]) * 0.15, (0.010, 0.008, 0.012), 'tassel_knot', 'tassel')
    tassel = G.tube(G.catmull([pts[1] + (pts[2] - pts[1]) * 0.25, pts[2], pts[3]], 8),
                    np.linspace(0.006, 0.014, 8).tolist(), 'tassel', 'tassel', segs=10)
    cord = G.tube(G.catmull([pts[0], jade_c + np.array([0, 0, 0.02])], 4), [0.0022] * 4, 'norigae_cord', 'tassel',
                  segs=6)
    for p in (disc, knot, tassel, cord):
        p.weights = skin.chain_weights(p.co, CH['norigae']['points'], CH['norigae']['bones'], root='hips',
                                       root_len=0.02)
        parts.append(p)
    return parts


# ---------------------------------------------------------------- hair: half-up bun with a gold pin, long curtain

def hair_parts(b, fr, P, CH):
    rng = np.random.default_rng(11)
    ez = fr.eyes['L'].c[2]
    mz = fr.mouth_c[2]
    top_z = P['head_top'][2]

    def hairline(th):
        a = abs((th + 180) % 360 - 180)
        return float(np.interp(a, [0, 25, 50, 75, 92, 120, 150, 180],
                               [ez + 0.058, ez + 0.056, ez + 0.040, ez + 0.004, ez - 0.010, ez - 0.004, mz + 0.004,
                                mz - 0.016]))

    def volume(th, z):
        a = abs((th + 180) % 360 - 180)
        up = smoothstep(ez, top_z - 0.03, z)
        return 0.011 + 0.016 * up + 0.012 * smoothstep(60, 170, a) * smoothstep(mz, ez + 0.05, z)

    sc = H_.Scalp(b, fr, P, hairline, lift=0.004, volume=volume, ear_clear=0.022)
    parts = [sc.part]
    W_, R_ = H_.head_frame(sc)
    locks = []

    def clump(pts, w, **kw):
        lk = H_.curve_lock(sc, [W_(p) for p in pts], w, f'lock{len(locks)}', **kw)
        locks.append(lk)
        return lk

    bun_c = W_((0.0, -0.78, 0.78))
    # centre-parted top: sleek clumps from the part line down each side into the bun / behind the ears
    for side in (1, -1):
        for i in range(5):
            y0 = 0.75 - 0.22 * i
            clump([(side * 0.05, y0, 1.0 - 0.03 * i), (side * 0.58, y0 - 0.08, 0.88 - 0.05 * i),
                   (side * 0.90, y0 - 0.35, 0.45 - 0.05 * i), (side * 0.55, -0.72, 0.62)],
                  rng.uniform(0.052, 0.062), thick=0.30, root_width=0.026, lift=0.002)
    # curtain fringe: two long strands framing the face from the part
    for side in (1, -1):
        clump([(side * 0.08, 0.80, 0.92), (side * 0.45, 1.02, 0.55), (side * 0.66, 1.0, 0.05),
               (side * 0.78, 0.82, -0.55), (side * 0.80, 0.55, -1.15)], 0.030, thick=0.4, root_width=0.016)
        clump([(side * 0.20, 0.82, 0.86), (side * 0.52, 1.03, 0.42), (side * 0.6, 1.02, 0.02),
               (side * 0.6, 0.95, -0.28)], 0.024, thick=0.4, root_width=0.012)
        # long side locks falling in front of the shoulders to the chest (world-space lengths)
        top = W_((side * 0.84, 0.28, 0.35))
        for k, (dx, dy, ln) in enumerate(((0.0, 0.0, 0.40), (0.012, 0.025, 0.34))):
            pts = [top + np.array([side * dx, -dy, 0.0]),
                   top + np.array([side * (0.025 + dx), -0.01 - dy, -0.08]),
                   top + np.array([side * (0.04 + dx), -0.035 - dy, -ln * 0.55]),
                   top + np.array([side * (0.05 + dx), -0.06 - dy, -ln])]
            locks.append(H_.curve_lock(sc, pts, 0.040 - 0.006 * k, f'lock{len(locks)}', thick=0.42, root_width=0.02,
                                       n=18))
    # bun: coiled clumps around a core, gold pin through it
    for i in range(8):
        a = 2 * math.pi * i / 8
        p0 = bun_c + np.array([math.cos(a) * 0.028, 0.012, math.sin(a) * 0.026])
        p1 = bun_c + np.array([math.cos(a + 1.3) * 0.036, 0.034, math.sin(a + 1.3) * 0.032])
        p2 = bun_c + np.array([math.cos(a + 2.6) * 0.022, 0.050, math.sin(a + 2.6) * 0.020])
        lk = H_._sweep(G.catmull([p0, p1, p2], 10), np.tile(_n(np.array([0, 1.0, 0])), (10, 1)), 0.030,
                       f'bun{i}', 0.55, 10, 8, 0.7, 0.03, 0.0, 'hair')
        locks.append(lk)
    pin_a = bun_c + np.array([-0.075, 0.035, -0.015])
    pin_b = bun_c + np.array([0.075, 0.030, 0.030])
    pin = G.tube([pin_a, pin_b], [0.0026, 0.0026], 'pin', 'pin', segs=8)
    pin.group = 'hair'
    flower = []
    for k in range(5):
        a = 2 * math.pi * k / 5
        c = pin_b + np.array([math.cos(a) * 0.009, 0.004, math.sin(a) * 0.009])
        flower.append(O.ellipsoid_part(c, (0.0065, 0.003, 0.0065), f'petal{k}', 'pin', segs=8, rings=5))
    flower.append(O.ellipsoid_part(pin_b + np.array([0, 0.006, 0]), (0.004, 0.003, 0.004), 'pin_core', 'tassel',
                                   segs=8, rings=5))
    for p in flower:
        p.group = 'hair'
    # long curtain down the back to mid-thigh, riding the three hair chains
    tail = []
    hl, hc, hr = (np.array(CH[n]['points']) for n in ('hair_l', 'hair_c', 'hair_r'))
    for i in range(15):
        u = (i - 7) / 7
        # blend the chain spines across the curtain
        if u >= 0:
            spine = hc * (1 - u) + hl * u
            name = 'hair_l' if u > 0.33 else 'hair_c'
        else:
            spine = hc * (1 + u) + hr * (-u)
            name = 'hair_r' if u < -0.33 else 'hair_c'
        root = W_((u * 0.6, -0.78, 0.30 - 0.15 * abs(u)))
        pts = [root] + [p + np.array([u * 0.035, 0.012 + 0.01 * abs(u), 0.0]) for p in spine[1:]]
        pts[-1] = pts[-1] + np.array([rng.uniform(-0.02, 0.02), 0.0, rng.uniform(-0.06, 0.04) - 0.04 * (1 - abs(u))])
        lk = H_.curve_lock(sc, pts, rng.uniform(0.050, 0.060), f'curtain{i}', thick=0.34, root_width=0.026, n=22,
                           radial=0.4)
        lk.weights = skin.chain_weights(lk.co, CH[name]['points'], CH[name]['bones'], root='head', root_len=0.06)
        tail.append(lk)
    for p in locks + flower + [pin, sc.part]:
        if p.weights is None:
            p.weights = (['head'], np.ones((p.nv, 1)))
    return parts + locks + tail + [pin] + flower


def _n(v):
    return v / np.linalg.norm(v)


# ---------------------------------------------------------------- face + paint

FACE = {
    'brow_ctrl': [(-0.019, 0.016), (-0.008, 0.021), (0.005, 0.0225), (0.017, 0.019), (0.026, 0.011)],
    'brow_width': [0.0042, 0.0044, 0.0038, 0.0027, 0.0012],
    'lash': (0.0011, 0.0042, 0.011),
    'lower_lash': 0.0010,
}

PAINT = {
    'robe': ('cloth', {'base': '#a3262a', 'dark': '#5e1214', 'pool': 0.14, 'band': '#b8893a',
                       'band_at': (0.004, 0.026), 'inlay': 'open_sd', 'inlay_col': '#a99bbd',
                       'inlay_trim': '#b8893a', 'inlay_trim_w': 0.012, 'wash_scale': 3.5}),
    'robe_lining': ('cloth', {'base': '#6b1a1e', 'dark': '#3e0d10', 'pool': 0.06, 'hem_line': False}),
    'dress': ('cloth', {'base': '#a99bbd', 'dark': '#6f6189', 'pool': 0.10, 'wash_scale': 4.0}),
    'dress_lining': ('flat', {'base': '#85789a'}),
    'collar': ('flat', {'base': '#ece2cc'}),
    'sash': ('trim', {'base': '#2b2228', 'stripe': '#b8893a', 'stripe_at': (-0.040, -0.034), 'sheen': 0.3}),
    'boot': ('cloth', {'base': '#7a3b2a', 'dark': '#4a2014', 'pool': 0.03, 'band': '#b8893a',
                       'band_at': (0.006, 0.014), 'sheen': 0.15}),
    'sole': ('flat', {'base': '#3a2a22'}),
    'skin': ('skin', {'base': '#efdcc0', 'shade': '#e0c3a0'}),
    'mouth': ('mouth', {'base': '#4a2420'}),
    'eye': ('eye', {'iris': '#1c120d', 'iris_lo': '#6a4430', 'iris_r': 0.0070}),
    'lash': ('flat', {'base': '#0f0e0d', 'bias': 0.3}),
    'brow': ('flat', {'base': '#1a1918'}),
    'hair': ('hair', {'base': '#18171b', 'root': '#0f0e11', 'streak': '#2c2d36'}),
    'pin': ('flat', {'base': '#c9973f', 'sheen': 0.8}),
    'jade': ('flat', {'base': '#5b8a6d', 'sheen': 0.6}),
    'tassel': ('cloth', {'base': '#a3262a', 'dark': '#6b1518', 'hem_line': False}),
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
    robe = next(p for p in parts if p.name == 'robe')
    dress = next(p for p in parts if p.name == 'dress')
    parts += trims(b, R, P, robe, dress, CH)
    body_skin, head = K.skin_parts(b, covered, names, W, fr)
    parts += [body_skin, head] + K.face_features(b, fr, head, FACE)
    parts += hair_parts(b, fr, P, CH)
    T('hair + face')
    for p in parts:
        if p.name.split('_')[0] in ('sash', 'collar', 'shirt', 'pouch', 'jade', 'tassel', 'norigae'):
            p.torso_only = True
    tris = skin.triangulate(b.topo.faces)
    resolve_weights(parts, b.co, tris, names, W)
    objs = list(build_objects(ID, parts, arm, names, COLORS).values())
    T('objects')
    if bake:
        paints = dict(PAINT)
        e = fr.eyes['L']
        # lips, a soft blush and the plum-petal mark (화전) between the brows
        spots = K.face_spots(fr, lips=('#b33a33', 0.85), blush=('#eab4a4', 0.35))
        spots += [(0.0, e.c[2] + 0.042, 0.0042, '#a3262a', 0.95, True)]
        paints['skin'] = ('skin', dict(PAINT['skin'][1], spots=spots))
        K.surface(arm, objs, paints, ID)
    K.ink_prep(objs, H_.Scalp.center_of(P))
    arm['colliders'] = json.dumps(K.colliders(b, names, W, arm))
    T('ink prep')
    return arm, objs, CH
