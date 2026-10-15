"""Mu-jin 무진 — The Wild Fist. Young wanderer: wild black mane tied low with a red cord, torn crimson scarf,
steel-blue cross-collar travel coat split into four panels, black sash, dark trousers bloused into leg wraps,
bandaged forearms and knuckles, cloth shoes."""
import json
import math

import bpy
import numpy as np

from .. import charkit as K
from .. import face as FR
from .. import garment as G
from .. import hair as H_
from .. import outfit as O
from .. import skeleton, skin
from ..assemble import build_objects, hem_distance, resolve_weights
from ..base import to_blender
from ..body import Body, Regions, smoothstep
from ..part import Part

ID = 'mujin'
H = 1.78  # top of skull (the mane adds ~7 cm)

# landmark heights of the skeleton the clip library was authored on (targets are remapped from these)
LEGACY = {'A': 0.0846, 'P': 0.986, 'S': 1.431}

COLORS = {
    'skin': '#e8d1ae', 'hair': '#1b1a18', 'coat': '#5a6770', 'coat_lining': '#363e45', 'shirt': '#e6dcc6',
    'pants': '#2d2c29', 'wrap': '#b3a98f', 'scarf': '#a3262a', 'sash': '#211f1d', 'shoe': '#29261f',
    'coat_lining': '#2a3035', 'pants_lining': '#1c1b19', 'eye': '#f2ece0', 'lash': '#121110', 'brow': '#1b1a18', 'mouth': '#5a2a26', 'cord': '#8e2125', 'pouch': '#5b4a36', 'collar': '#3e4850', 'sole': '#ddd3bf',
}


# ---------------------------------------------------------------- body

def shape_body():
    b = Body('male')
    P = b.joints()
    hip = P['hip_L'][2]
    b.stretch_z(hip - 0.12, hip + 0.06, 1.045)   # manhwa legs
    b.scale_head(0.94)
    b.fit_height(H)
    return b


def chains(P):
    """Secondary spring chains (Blender space points; bones are generated per segment)."""
    hip = np.array(P['pelvis'])
    out = {}
    cloth = {'kind': 'cloth', 'stiffness': 0.22, 'damping': 0.84, 'gravity': 0.5, 'drag': 0.8}
    z0 = P['hip_L'][2] - 0.02
    z1 = P['knee_L'][2] - 0.20
    for name, ang, follow in (('cloth_fl', -62, 'thigh_L'), ('cloth_fr', -118, 'thigh_R'),
                              ('cloth_bl', 55, 'thigh_L'), ('cloth_br', 125, 'thigh_R')):
        a = math.radians(ang)
        pts = []
        for k in range(4):
            t = k / 3
            r = 0.17 + 0.06 * t
            pts.append((r * math.cos(a), -0.0 + r * math.sin(a) * 0.85, z0 + (z1 - z0) * t))
        c = dict(cloth, parent='hips', points=pts)
        if follow:
            c['follow'] = follow
            c['follow_amount'] = 0.3 if ang < 0 else 0.2
        out[name] = c
    # scarf tails: knotted at the back-right of the neck, trailing down behind the right shoulder
    nk = np.array(P['neck0'])
    zb = nk[2] - 0.01
    yb = nk[1] + 0.075
    for name, dx, ln, dz in (('scarf_a', 0.0, 0.78, 0.0), ('scarf_b', -0.045, 0.58, -0.03)):
        pts = []
        for k in range(5):
            t = k / 4
            pts.append((-0.055 + dx - 0.05 * t, yb + 0.02 + 0.10 * t ** 1.3, zb + dz - ln * t))
        out[name] = {'kind': 'cloth', 'parent': 'chest', 'points': pts, 'stiffness': 0.10, 'damping': 0.86,
                     'gravity': 0.6, 'drag': 1.0}
    # hair tail: tied at the nape, hanging down the back
    hd = np.array(P['head0'])
    tie = np.array([0.0, hd[1] + 0.085, hd[2] - 0.035])
    out['hair_tail'] = {'kind': 'hair', 'parent': 'head', 'points': [tuple(tie + np.array([0, 0.02 * t, -0.11 * k]))
                        for k, t in enumerate((0, 0.6, 1.2, 1.9, 2.6))],
                        'stiffness': 0.18, 'damping': 0.82, 'gravity': 0.55, 'drag': 0.7}
    # sash tails: knot at the front-left of the waist
    sp = np.array(P['spine0'])
    for name, dx, ln in (('sash_a', 0.0, 0.40), ('sash_b', 0.035, 0.30)):
        pts = []
        for k in range(4):
            t = k / 3
            pts.append((0.105 + dx + 0.02 * t, sp[1] - 0.125 - 0.01 * t, sp[2] - 0.035 - ln * t))
        out[name] = {'kind': 'cloth', 'parent': 'hips', 'points': pts, 'stiffness': 0.12, 'damping': 0.86,
                     'gravity': 0.7, 'drag': 1.0}
    return out


# ---------------------------------------------------------------- garments

COAT_FOLLOW = {'cloth_fl': ('thigh_L', 0.55), 'cloth_fr': ('thigh_R', 0.55), 'cloth_bl': ('thigh_L', 0.25),
               'cloth_br': ('thigh_R', 0.25)}
COAT_PANELS = [('cloth_fl', -100, -8), ('cloth_bl', -8, 90), ('cloth_br', 90, 188), ('cloth_fr', 188, 260)]


def garments(b, R, P, names, CH):
    co = b.co
    z = co[:, 2]
    topo = b.topo
    parts = []
    hip_z = P['hip_L'][2]
    navel_z = P['spine0'][2]
    knee_z = P['knee_L'][2]
    body_surf = G.Surface(co, topo.faces)
    proxy = O.dressing_proxy(b, R)
    proxy_surf = G.Surface(proxy, topo.faces)
    sash_lo, sash_hi = navel_z - 0.075, navel_z + 0.035

    # ---- trousers: pelvis + legs to mid-shin, baggy, bloused into the leg wraps
    tr_m = (z < navel_z + 0.02) & (R.arms < 0.5) & ((R.legs < 0.5) | (R.legt < 1.62))
    baggy = 0.012 + 0.026 * smoothstep(hip_z + 0.05, knee_z, z)
    pants = G.shell(topo, proxy, tr_m, 'pants', 'pants', offset=0.006, loosen=baggy * R.legs, smooth=25,
                    min_gap=0.005, clear=proxy_surf, hard=body_surf)
    for s in 'LR':
        kn, an = P['knee_' + s], P['ankle_' + s]
        L = min(G.boundary_loops(pants.faces), key=lambda L: np.linalg.norm(pants.co[L].mean(0) - kn * 0.4 - an * 0.6))
        G.straighten(pants, L, kn + (an - kn) * 0.62, an - kn)
        c0 = pants.co[L]
        cen = c0.mean(0)
        ax = (an - kn) / np.linalg.norm(an - kn)
        G.extrude_rings(pants, L, [cen + (c0 - cen) * 0.84 + ax * 0.012])
    G.orient_from(pants, body_surf)
    O.finish(pants, 0.003, 'pants_lining')
    parts.append(pants)

    # ---- coat torso + sleeves to mid-forearm; ends under the sash where the four-panel skirt starts
    sleeve_end = 1.52
    coat_m = (R.headneck < 0.30) & ((R.arms < 0.5) | (R.armt < sleeve_end)) & (z > sash_lo)
    blouse = 0.010 * smoothstep(P['chest0'][2] + 0.05, navel_z + 0.06, z) * (1 - smoothstep(sash_hi - 0.02, sash_lo, z))
    loosen = 0.006 + 0.016 * R.arms * smoothstep(0.2, 1.0, R.armt) + blouse
    pants_surf = G.surface_of(pants)
    under_coat = [proxy_surf, (pants_surf, 0.006)]
    hard_coat = [body_surf, (pants_surf, 0.004)]
    coat = G.shell(topo, proxy, coat_m, 'coat', 'coat', offset=0.008, loosen=loosen, smooth=30, min_gap=0.006,
                   clear=under_coat, hard=hard_coat)
    G.layer_over(coat, pants, 0.006)
    loops = G.boundary_loops(coat.faces)
    bottom = G.waist_loop(coat, sash_lo)
    G.straighten(coat, bottom, (0, 0, sash_lo), (0, 0, 1))
    for s in 'LR':
        el, wr = P['elbow_' + s], P['wrist_' + s]
        cpt = el + (wr - el) * (sleeve_end - 1.0)
        cuff = min(loops, key=lambda L: np.linalg.norm(coat.co[L].mean(0) - cpt))
        G.straighten(coat, cuff, cpt, wr - el)
        c0 = coat.co[cuff]
        ax = (wr - el) / np.linalg.norm(wr - el)
        cen = c0.mean(0)
        G.extrude_rings(coat, cuff, [cen + (c0 - cen) * 1.10 + ax * 0.010, cen + (c0 - cen) * 1.16 + ax * 0.026])
    bottom = G.waist_loop(coat, sash_lo)
    _, cy = O.skirt(coat, bottom, sash_lo, knee_z - 0.21, under_coat,
                    slits=((-100, 1), (-8, 3), (188, 3), (90, 4)))
    G.orient_from(coat, body_surf)
    coat.weights = O.chain_part_weights(coat, cy, co, topo, names, R.W, CH, COAT_PANELS, follow=COAT_FOLLOW)
    O.finish(coat, 0.004, 'coat_lining')
    parts.append(coat)

    # ---- leg wraps (shin)
    wr_m = (R.legs > 0.5) & (R.legt > 1.42) & (R.legt < 2.05)
    lw = G.shell(topo, proxy, wr_m, 'legwrap', 'wrap', offset=0.004, smooth=6, min_gap=0.003, clear=body_surf)
    parts.append(O.finish(lw, 0.002, 'wrap'))
    sh_m = (R.legs > 0.5) & (R.legt > 1.97)

    # ---- forearm + hand wraps (fingers beyond the proximal phalanx stay bare)
    distal = np.zeros(len(co))
    for n in names:
        if n.split('_')[0] in ('index', 'middle', 'ring', 'pinky', 'thumb') and n.split('_')[1] in ('2', '3'):
            distal += R.W[:, names.index(n)]
    hw_m = (R.arms > 0.5) & (R.armt > sleeve_end - 0.12) & (distal < 0.35)
    hw = G.shell(topo, co, hw_m, 'handwrap', 'wrap', offset=0.0022, smooth=0, min_gap=0.0015, clear=body_surf)
    parts.append(O.finish(hw, 0.0015, 'wrap'))

    covered = (coat_m & (z < P['neck0'][2] - 0.03)) | tr_m | wr_m | sh_m | hw_m
    return parts, covered


# ---------------------------------------------------------------- trims: collar, sash, scarf, shoes, pouch

def trims(b, R, P, coat, CH, names):
    parts = []
    nk, sp = np.array(P['neck0']), np.array(P['spine0'])
    navel_z = sp[2]
    sash_lo, sash_hi = navel_z - 0.075, navel_z + 0.035
    coat_surf = G.surface_of(coat)
    NL = max(coat.open_rings, key=lambda r: r[:, 2].mean())   # neckline, recorded before solidify
    cn = NL.mean(0)
    ang = np.degrees(np.arctan2(NL[:, 1] - cn[1], NL[:, 0] - cn[0]))  # +90 back, 0 left, -90 front

    def neck_pt(a):
        d = np.abs((ang - a + 180) % 360 - 180)
        return NL[int(np.argmin(d))] + np.array([0, 0, -0.012])

    # ---- cross collar (right over left: the wearer's left panel crosses to the right hip)
    zc = cn[2]
    outer_ctrl = [neck_pt(a) for a in (90, 55, 20, -15, -50)]
    for t in np.linspace(0, 1, 6)[1:]:
        x = 0.030 - 0.150 * t
        z_ = (zc - 0.06) + (sash_hi + 0.005 - (zc - 0.06)) * t
        hit = G.ray_front(coat_surf, x - 0.012 * math.sin(math.pi * t), z_)
        if hit is not None:
            outer_ctrl.append(hit)
    path = G.catmull(outer_ctrl, 60)
    path, nrm = G.project_path(coat_surf, path, lift=0.001)
    w_prof = np.interp(np.linspace(0, 1, len(path)), [0, 0.35, 1], [1.0, 1.0, 0.85])
    parts.append(G.band(path, nrm, 0.046, 0.007, 'collar_outer', 'collar', w_profile=w_prof, align=0.35))
    inner_ctrl = [neck_pt(a) for a in (90, 125, 160, 195, 230)]
    for t in np.linspace(0, 1, 4)[1:]:
        x = -0.030 + 0.07 * t
        z_ = (zc - 0.06) - 0.07 * t
        hit = G.ray_front(coat_surf, x, z_)
        if hit is not None:
            inner_ctrl.append(hit)
    path, nrm = G.project_path(coat_surf, G.catmull(inner_ctrl, 36), lift=0.0002)
    parts.append(G.band(path, nrm, 0.040, 0.005, 'collar_inner', 'collar', align=0.35))
    # white under-collar showing above the coat collar
    sh_path = G.catmull([neck_pt(a) + np.array([0, 0, 0.016]) for a in range(90, 450, 30)], 48, closed=True)
    sh_path, sh_n = G.project_path(G.Surface(b.co, b.topo.faces), sh_path, lift=0.004)
    parts.append(G.band(sh_path, sh_n, 0.028, 0.004, 'shirt_collar', 'shirt', closed=True, align=0.6))

    # ---- sash: wide band over the coat, knot + two hanging tails
    zs = 0.5 * (sash_lo + sash_hi)
    torso = G.surface_where(coat, lambda c: abs(c[0]) < 0.20 and abs(c[2] - zs) < 0.12)
    ring, rn = G.ring_on(torso, (0.0, coat.co[:, 1].mean()), zs, 56, lift=0.003, r0=0.30)
    parts.append(G.band(ring, rn, sash_hi - sash_lo, 0.010, 'sash', 'sash', closed=True))
    kp = np.array(CH['sash_a']['points'][0]) + np.array([0, -0.01, 0.02])
    parts.append(O.ellipsoid_part(kp, (0.032, 0.022, 0.026), 'sash_knot', 'sash'))
    for nm, w in (('sash_a', 0.052), ('sash_b', 0.046)):
        pts = G.catmull(CH[nm]['points'], 14)
        d = np.array([0.3, -1.0, 0.0])
        nrm = np.tile(d / np.linalg.norm(d), (len(pts), 1))
        tail = G.band(pts, nrm, w, 0.006, nm, 'sash', w_profile=np.linspace(1.0, 0.8, len(pts)))
        tail.weights = skin.chain_weights(tail.co, CH[nm]['points'], CH[nm]['bones'], root='hips', root_len=0.06)
        parts.append(tail)

    # ---- pouch at the right hip, hanging from the sash
    pc = np.array([-0.135, sp[1] - 0.06, sash_lo - 0.055])
    parts.append(O.ellipsoid_part(pc, (0.040, 0.026, 0.050), 'pouch', 'pouch'))
    parts.append(O.ellipsoid_part(pc + np.array([0, -0.004, 0.035]), (0.042, 0.028, 0.018), 'pouch_flap', 'pouch'))

    # ---- scarf: a bunched roll around the neck + two torn tails trailing behind the right shoulder
    body_surf = G.Surface(b.co, b.topo.faces)
    zr = cn[2] + 0.022
    rp, rn = G.ring_on(body_surf, (0.0, nk[1]), zr, 40, lift=0.024, r0=0.25)
    for _ in range(3):
        rp = 0.5 * rp + 0.25 * (np.roll(rp, 1, 0) + np.roll(rp, -1, 0))
    tilt = 0.012 * (-rp[:, 1] + rp[:, 1].mean()) / 0.06       # lower in front
    rp[:, 2] -= np.clip(tilt, -0.012, 0.012)
    ang_r = np.linspace(0, 2 * math.pi, len(rp), endpoint=False)
    radii = [(0.023 + 0.005 * math.sin(3 * a + 0.5), 0.027 + 0.004 * math.cos(2 * a)) for a in ang_r]
    parts.append(G.tube(rp, radii, 'scarf_roll', 'scarf', segs=12, closed=True, ref=(0, 0, 1)))
    rp2 = rp + np.array([0, 0, -0.026]) + rn * -0.004
    parts.append(G.tube(rp2, [(0.018, 0.022)] * len(rp2), 'scarf_roll2', 'scarf', segs=12, closed=True, ref=(0, 0, 1)))
    for nm, w in (('scarf_a', 0.082), ('scarf_b', 0.070)):
        pts = G.catmull(CH[nm]['points'], 18)
        tt = np.linspace(0, 1, len(pts))[:, None]
        # flat face turns from the back toward the camera side (char's right) along the tail
        nrm = (1 - tt) * np.array([-0.3, 1.0, 0.2]) + tt * np.array([-1.0, 0.35, 0.0])
        nrm /= np.linalg.norm(nrm, axis=1)[:, None]
        prof = np.linspace(1.0, 0.75, len(pts)) * (1 + 0.06 * np.sin(np.arange(len(pts)) * 2.7))
        tail = G.band(pts, nrm, w, 0.007, nm, 'scarf', w_profile=prof)
        tail.weights = skin.chain_weights(tail.co, CH[nm]['points'], CH[nm]['bones'], root='chest', root_len=0.05)
        parts.append(tail)

    # ---- cloth shoes with white layered soles
    for s in 'LR':
        parts += O.shoe(P, s)
    return parts


# ---------------------------------------------------------------- hair: wild mane tied low with a red cord

def hair_parts(b, fr, P, CH):
    rng = np.random.default_rng(7)
    ez = fr.eyes['L'].c[2]
    mz = fr.mouth_c[2]
    top_z = P['head_top'][2]

    def hairline(th):
        a = abs((th + 180) % 360 - 180)
        return float(np.interp(a, [0, 25, 50, 75, 92, 120, 150, 180],
                               [ez + 0.064, ez + 0.060, ez + 0.040, ez + 0.000, ez - 0.012, ez - 0.004, mz + 0.004, mz - 0.014]))

    def volume(th, z):
        a = abs((th + 180) % 360 - 180)
        up = smoothstep(ez + 0.0, top_z - 0.03, z)
        back = smoothstep(80, 170, a)
        front = 1 - smoothstep(10, 60, a)
        return 0.008 + 0.024 * up + 0.016 * back * smoothstep(mz - 0.01, ez + 0.05, z) - 0.006 * front * up

    sc = H_.Scalp(b, fr, P, hairline, lift=0.0045, volume=volume, ear_clear=0.024)
    parts = [sc.part]
    c = sc.center
    top = sc.top
    locks = []

    def add(root, d, ln, w, **kw):
        lk = H_.lock(sc, root, d, ln, w, rng=rng, name=f'lock{len(locks)}', **kw)
        locks.append(lk)
        return lk

    W_, R_ = H_.head_frame(sc)

    def clump(pts, w, **kw):
        lk = H_.curve_lock(sc, [W_(p) for p in pts], w, f'lock{len(locks)}', **kw)
        locks.append(lk)
        return lk

    # swept-back top: broad clumps from the hairline over the crown, tips kicking up and out behind
    for i in range(7):
        t = (i - 3) / 3
        x0 = 0.55 * t
        kick = rng.uniform(0.0, 0.35)
        clump([(x0, 0.78, 0.62 - 0.1 * t * t), (x0 * 1.1, 0.45, 1.0), (x0 * 1.2, -0.25, 1.06),
               (x0 * 1.35, -0.95, 0.85), (x0 * 1.55, -1.45, 0.7 + kick), (x0 * 1.7, -1.75, 0.75 + kick * 1.6)],
              rng.uniform(0.058, 0.068), thick=0.26, root_width=0.03, twist=rng.uniform(-0.3, 0.3), lift=0.002)
    # crown: wild spikes radiating from the whorl past the back of the head
    for i in range(13):
        a = math.radians(-135 + 270 * i / 12 + rng.uniform(-6, 6))
        sx_, cy_ = math.sin(a), math.cos(a)
        r1 = rng.uniform(1.65, 2.15)
        up = rng.uniform(-0.25, 0.75)
        clump([(0.15 * sx_, -0.30, 1.02), (0.6 * sx_, -0.72, 0.92), (1.0 * sx_, -1.08 - 0.1 * cy_, 0.62 + up * 0.25),
               (1.3 * sx_ * r1 / 1.7, -r1, 0.45 + up)], rng.uniform(0.040, 0.052), thick=0.42, root_width=0.022,
              twist=rng.uniform(-0.6, 0.6))
    # fringe: strands arc out over the hairline and fall across the brow, tips curling toward the face
    for x, zt in ((-0.66, 0.02), (-0.36, -0.26), (-0.08, -0.12), (0.16, -0.40), (0.42, -0.16), (0.66, 0.0)):
        clump([(x * 0.9, 0.62, 0.78), (x, 0.98, 0.55), (x * 1.04, 1.13, 0.22), (x * 0.92, 1.12, zt * 0.4),
               (x * 0.78, 1.06, zt)], rng.uniform(0.022, 0.028), thick=0.42, root_width=0.014, lift=0.004)
    # sides: from the temples over the upper ears, tips flicking back
    for sx in (1, -1):
        for i in range(4):
            y0 = 0.5 - 0.22 * i
            clump([(sx * 0.80, y0, 0.55), (sx * 1.04, y0 - 0.05, 0.2), (sx * 1.08, y0 - 0.12, -0.18),
                   (sx * 1.05, y0 - 0.32, -0.48 - 0.05 * i)], rng.uniform(0.028, 0.034), thick=0.45, root_width=0.016,
                  twist=sx * rng.uniform(0.0, 0.3))
    # back: the mass gathered toward the tie at the nape
    tie = np.array(CH['hair_tail']['points'][0])
    for i in range(12):
        a = math.radians(-75 + 150 * i / 11)
        root = c + np.array([math.sin(a) * 0.07, 0.065 + 0.012 * math.cos(a), 0.035 + rng.uniform(-0.01, 0.03)])
        d = _n_(tie - root)
        add(root, d, float(np.linalg.norm(tie - root)) * 1.08, rng.uniform(0.030, 0.036), attach=0.95, gravity=0.0,
            thick=0.45)
    # tail: hangs from the tie down the back (spring chain)
    tail = []
    for i in range(8):
        a = math.radians(-60 + 120 * i / 7)
        root = tie + np.array([math.sin(a) * 0.012, 0.004, math.cos(a) * 0.008])
        d = np.array([math.sin(a) * 0.2, 0.55, -1.0])
        lk = H_.lock(sc, root, d, rng.uniform(0.30, 0.42), rng.uniform(0.028, 0.036), attach=0.0, gravity=1.4,
                     flick=np.array([math.sin(a) * 0.3, 0.25, 0.0]), thick=0.5, name=f'tail{i}', rng=rng,
                     twist=rng.uniform(-0.5, 0.5), bend=0.6)
        lk.weights = skin.chain_weights(lk.co, CH['hair_tail']['points'], CH['hair_tail']['bones'], root='head',
                                        root_len=0.03)
        tail.append(lk)
    for lk in locks:
        lk.weights = (['head'], np.ones((lk.nv, 1)))
    sc.part.weights = (['head'], np.ones((sc.part.nv, 1)))
    # red cord binding the tail
    ring = np.array([tie + np.array([math.cos(a) * 0.024, 0.012 + math.sin(a) * 0.014, -0.004 + math.sin(a) * 0.006])
                     for a in np.linspace(0, 2 * math.pi, 16, endpoint=False)])
    cord = G.tube(ring, [0.0055] * len(ring), 'cord', 'cord', segs=8, closed=True)
    cord.group = 'hair'
    cord.weights = (['head'], np.ones((cord.nv, 1)))
    ends = []
    for k, dx in enumerate((-0.006, 0.008)):
        path = [tie + np.array([dx, 0.03, -0.006]), tie + np.array([dx * 2, 0.045, -0.05]),
                tie + np.array([dx * 3, 0.05, -0.10 - 0.02 * k])]
        e = G.tube(G.catmull(path, 6), np.linspace(0.004, 0.0025, 6).tolist(), f'cord_end{k}', 'cord', segs=6)
        e.group = 'hair'
        e.weights = skin.chain_weights(e.co, CH['hair_tail']['points'], CH['hair_tail']['bones'], root='head',
                                       root_len=0.03)
        ends.append(e)
    return parts + locks + tail + [cord] + ends


def _n_(v):
    return v / np.linalg.norm(v)


# ---------------------------------------------------------------- paint (recipe, params) per paint name

PAINT = {
    'coat': ('cloth', {'base': '#5d6a73', 'dark': '#2f3940', 'pool': 0.14, 'band': '#3c464d', 'band_at': (0.010, 0.024)}),
    'pants': ('cloth', {'base': '#3b3833', 'dark': '#25231f', 'pool': 0.08}),
    'coat_lining': ('cloth', {'base': '#2b3237', 'dark': '#1d2226', 'pool': 0.05, 'hem_line': False}),
    'pants_lining': ('flat', {'base': '#1c1b19'}),
    'collar': ('trim', {'base': '#36414a', 'stripe': '#4b5862', 'stripe_at': (-0.004, 0.012)}),
    'shirt': ('flat', {'base': '#e6dcc6'}),
    'sash': ('trim', {'base': '#1f1d1b', 'stripe': '#3a2f2a', 'stripe_at': (-0.035, -0.028), 'sheen': 0.25}),
    'pouch': ('cloth', {'base': '#7a6348', 'dark': '#54422f', 'pool': 0.02, 'hem_line': False}),
    'scarf': ('cloth', {'base': '#a3262a', 'dark': '#5e1214', 'pool': 0.12, 'wash_scale': 5.0}),
    'wrap': ('wrap', {'base': '#c9bfa6', 'dark': '#8f846c'}),
    'shoe': ('flat', {'base': '#24221e', 'sheen': 0.1}),
    'sole': ('wrap', {'base': '#e2d8c2', 'dark': '#a39983', 'pitch': 420.0, 'slant': 0.0}),
    'skin': ('skin', {'base': '#ead2b2', 'shade': '#d9b994'}),
    'mouth': ('mouth', {'base': '#4a2420'}),
    'eye': ('eye', {'iris': '#1d130e', 'iris_lo': '#5e3e26', 'iris_r': 0.0089, 'iris_offset': (0.0, 0.0012),
                    'glint': (-0.0030, 0.0036)}),
    'lash': ('flat', {'base': '#0f0e0d', 'bias': 0.3}),
    'brow': ('flat', {'base': '#161514'}),
    'hair': ('hair', {'base': '#1b1a1c', 'root': '#111012', 'streak': '#30323a'}),
    'cord': ('cloth', {'base': '#a3262a', 'dark': '#6b1518', 'hem_line': False}),
}

# ---------------------------------------------------------------- face

FACE = {
    # brow control points relative to each eye centre: (outward dx, up dz); widths inner -> outer
    'brow_ctrl': [(-0.022, 0.0115), (-0.011, 0.0165), (0.003, 0.019), (0.016, 0.0185), (0.027, 0.012)],
    'brow_width': [0.0095, 0.0088, 0.0072, 0.0050, 0.0020],
    'brow_lift': 0.0009,
    'lash': (0.0009, 0.0034, 0.009),
}


def build(bake=True):
    T = K.Timer(ID)
    b = shape_body()
    P0 = b.joints()
    CH = chains(P0)
    arm, P, names, W = K.build_rig(b, CH, ID)
    T('rig')
    R = Regions(b, names, W, P)
    fr = FR.FaceRig(b)
    T('face rig')
    parts, covered = garments(b, R, P, names, CH)
    T('garments')
    coat = next(p for p in parts if p.name == 'coat')
    parts += trims(b, R, P, coat, CH, names)
    T('trims')
    body_skin, head = K.skin_parts(b, covered, names, W, fr)
    parts += [body_skin, head] + K.face_features(b, fr, head, FACE)
    T('skin + face')
    parts += hair_parts(b, fr, P, CH)
    T('hair')
    for p in parts:
        if p.name.split('_')[0] in ('sash', 'collar', 'shirt', 'pouch', 'jade', 'tassel', 'norigae'):
            p.torso_only = True
    tris = skin.triangulate(b.topo.faces)
    resolve_weights(parts, b.co, tris, names, W)
    T('weights')
    objs = list(build_objects(ID, parts, arm, names, COLORS).values())
    T('objects')
    if bake:
        paints = dict(PAINT)
        e = fr.eyes['L']
        # lip tone + a healed scar slanting down across the left cheekbone
        spots = K.face_spots(fr, lips=('#c08a7c', 0.45))
        for t in np.linspace(0, 1, 7):
            spots.append((-(e.c[0] + 0.004 + 0.016 * t), e.c[2] - 0.012 - 0.028 * t, 0.0022, '#8f3b33', 0.75, False))
        paints['skin'] = ('skin', dict(PAINT['skin'][1], spots=spots))
        K.surface(arm, objs, paints, ID)
    K.ink_prep(objs, H_.Scalp.center_of(P))
    arm['colliders'] = json.dumps(K.colliders(b, names, W, arm))
    T('ink prep')
    return arm, objs, CH
