"""Pose solver (FK + analytic two-bone IK) and clip baking.

Pose spec (all angles in degrees, positions in character space (side, fwd, up), metres):
  'hips':  {'loc': (side, fwd, up) offset, 'rot': (bend, lean, twist)}
  'spine'/'chest'/'neck'/'head': (bend, lean, twist)      bend>0 forward, lean>0 to char-left, twist>0 turn to char-left
  'shoulder_L'/'shoulder_R': (raise, fwd)
  'hand_L'/'hand_R': {'pos': (s,f,u) wrist target, 'pole': elbow hint dir, 'dir': optional hand direction, 'twist': deg}
  'foot_L'/'foot_R': {'pos': (s,f,u) ankle target, 'pole': knee hint dir, 'yaw': deg, 'pitch': deg (toes down +)}
  'grip_L'/'grip_R': hand shape — a name from GRIPS or a numeric table (see grip()); blends between keys
Finger bones and forearm twist bones are solved too when the skeleton has them.
"""
import copy
import math
from mathutils import Vector, Quaternion

from .core import C, MAIN_BONES

AX = Vector((1, 0, 0))
AY = Vector((0, 1, 0))
AZ = Vector((0, 0, 1))


def qa(axis, d):
    return Quaternion(axis, math.radians(d))


def spine_q(bend=0.0, lean=0.0, twist=0.0):
    return qa(AZ, twist) @ qa(AY, lean) @ qa(AX, bend)


def clav_q(side, raise_=0.0, fwd=0.0):
    s = 1 if side == 'L' else -1
    return qa(AZ, -s * fwd) @ qa(AY, -s * raise_)


class Skeleton:
    def __init__(self, arm_obj):
        self.obj = arm_obj
        self.b = {}
        for bone in arm_obj.data.bones:
            self.b[bone.name] = {
                'head': bone.head_local.copy(),
                'tail': bone.tail_local.copy(),
                'R': bone.matrix_local.to_quaternion(),
                'parent': bone.parent.name if bone.parent else None,
            }

    def head(self, n):
        return self.b[n]['head']

    def parent(self, n):
        return self.b[n]['parent']

    def rest_dir(self, n):
        return (self.b[n]['tail'] - self.b[n]['head']).normalized()

    def seg(self, a, b):
        return (self.b[b]['head'] - self.b[a]['head']).length

    def set_legacy(self, legacy):
        """Clips authored for an older skeleton: legacy = {'A': ankle z, 'P': pelvis z, 'S': shoulder z}.
        Target heights are remapped piecewise from those landmarks onto this skeleton's own."""
        if not legacy:
            self.map = None
            return
        A1 = self.head('foot_L').z
        P1 = self.head('hips').z
        S1 = self.head('upper_arm_L').z
        A0, P0, S0 = legacy['A'], legacy['P'], legacy['S']
        kL = (P1 - A1) / (P0 - A0)
        kU = (S1 - P1) / (S0 - P0)

        def m(z):
            if z <= P0:
                return A1 + (z - A0) * kL
            return P1 + (z - P0) * kU if z <= S0 else S1 + (z - S0)
        self.map = m
        self.legacy_P = P0


def _two_bone(S, T, a, b, pole):
    d_vec = T - S
    d = d_vec.length
    clamped = False
    lo, hi = abs(a - b) + 1e-4, a + b - 1e-4
    if d > hi:
        clamped = d - hi
        d = hi
    if d < lo:
        d = lo
    u = d_vec.normalized() if d_vec.length > 1e-9 else Vector((0, 0, -1))
    v = pole - u * pole.dot(u)
    if v.length < 1e-6:
        v = Vector((0, 1, 0)) - u * u.y
    v.normalize()
    cos_a = max(-1.0, min(1.0, (a * a + d * d - b * b) / (2 * a * d)))
    sin_a = math.sqrt(max(0.0, 1 - cos_a * cos_a))
    E = S + (u * cos_a + v * sin_a) * a
    W = S + u * d
    return E, W, clamped


# ---------------------------------------------------------------- hand shapes
# fingers: (flex1, flex2, flex3, spread) degrees; thumb: (cmc_flex, cmc_abduct, mcp_flex, ip_flex, roll)
GRIPS = {
    'relaxed': {'thumb': (8, 6, 12, 14, 0), 'index': (14, 20, 12, 3), 'middle': (18, 24, 14, 0),
                'ring': (22, 28, 16, -3), 'pinky': (26, 30, 18, -6)},
    'fist': {'thumb': (30, -8, 38, 34, 18), 'index': (88, 98, 50, 2), 'middle': (92, 100, 52, 0),
             'ring': (94, 100, 52, -2), 'pinky': (96, 98, 50, -4)},
    'half': {'thumb': (22, 0, 26, 24, 10), 'index': (58, 72, 38, 2), 'middle': (62, 74, 40, 0),
             'ring': (66, 76, 40, -2), 'pinky': (70, 76, 40, -5)},
    'open': {'thumb': (-6, 22, 0, 0, -6), 'index': (-6, 3, 2, 5), 'middle': (-6, 3, 2, 0),
             'ring': (-5, 3, 2, -5), 'pinky': (-4, 3, 2, -10)},
    'palm': {'thumb': (2, 10, 6, 6, 0), 'index': (-14, 0, 0, 2), 'middle': (-14, 0, 0, 0),
             'ring': (-12, 0, 0, -2), 'pinky': (-10, 2, 0, -4)},
    'sword': {'thumb': (34, -10, 40, 36, 20), 'index': (-2, 2, 0, -2), 'middle': (-2, 2, 0, 2),
              'ring': (92, 100, 52, -2), 'pinky': (94, 98, 50, -4)},
    'claw': {'thumb': (14, 18, 30, 40, 0), 'index': (30, 62, 52, 8), 'middle': (32, 64, 54, 0),
             'ring': (34, 64, 54, -8), 'pinky': (36, 62, 52, -14)},
}


def grip(spec):
    """Grip name | {name: weight} | numeric table -> numeric table."""
    if isinstance(spec, str):
        return copy.deepcopy(GRIPS[spec])
    if isinstance(spec, dict) and spec and all(k in GRIPS for k in spec):
        tot = sum(spec.values())
        out = {}
        for f in GRIPS['relaxed']:
            out[f] = tuple(sum(GRIPS[n][f][i] * w for n, w in spec.items()) / tot
                           for i in range(len(GRIPS['relaxed'][f])))
        return out
    return spec


def with_grips(pose, default_L='relaxed', default_R='relaxed'):
    """Ensure both grips are numeric tables (so keys blend smoothly)."""
    p = dict(pose)
    p['grip_L'] = grip(pose.get('grip_L', default_L))
    p['grip_R'] = grip(pose.get('grip_R', default_R))
    return p


def _finger_locals(sk, local, pose):
    for s in 'LR':
        g = grip(pose.get('grip_' + s, 'relaxed'))
        for f, vals in g.items():
            names = [f'{f}_{k}_{s}' for k in (1, 2, 3)]
            if names[0] not in sk.b:
                continue
            if f == 'thumb':
                cf, ca, mf, ipf, roll = vals
                local[names[0]] = qa(AY, roll) @ qa(AZ, -ca) @ qa(AX, cf)
                local[names[1]] = qa(AX, mf)
                local[names[2]] = qa(AX, ipf)
            else:
                f1, f2, f3, spread = vals
                local[names[0]] = qa(AZ, spread) @ qa(AX, f1)
                local[names[1]] = qa(AX, f2)
                local[names[2]] = qa(AX, f3)


def _twist_locals(sk, local, D):
    """Forearm twist bone takes half of the hand's roll around the forearm axis."""
    for s in 'LR':
        tw = 'forearm_twist_' + s
        if tw not in sk.b:
            continue
        fa, hd = 'forearm_' + s, 'hand_' + s
        rel = D[fa].inverted() @ D[hd]  # hand rotation relative to the forearm (rest world frame)
        axis = sk.rest_dir(fa)
        v = Vector((rel.x, rel.y, rel.z))
        proj = axis * v.dot(axis)
        twist = Quaternion((rel.w, proj.x, proj.y, proj.z))
        if twist.magnitude < 1e-9:
            local[tw] = Quaternion()
            continue
        twist.normalize()
        ang = twist.angle
        if Vector((twist.x, twist.y, twist.z)).dot(axis) < 0:
            ang = -ang
        if ang > math.pi:
            ang -= 2 * math.pi
        local[tw] = Quaternion((0, 1, 0), 0.5 * ang)


ARM_POLE = {'L': (0.5, -1.0, -0.6), 'R': (-0.5, -1.0, -0.6)}
LEG_POLE = {'L': (0.2, 1.0, 0.0), 'R': (-0.2, 1.0, 0.0)}


def _mz(sk, pos):
    m = getattr(sk, 'map', None)
    return pos if not m else (pos[0], pos[1], m(pos[2]))


def _target(sk, spec, hips):
    """IK target in Blender space. A 'spin' angle (degrees) marks an unrotated legacy target: it is height-remapped
    first, then rotated about the hips' side axis, so a somersault stays rigid on any skeleton."""
    T = C(*_mz(sk, spec['pos']))
    if spec.get('spin'):
        T = hips + Quaternion(AX, math.radians(spec['spin'])) @ (T - hips)
    return T


def solve(sk, pose):
    """Returns (local quaternions dict, hips local location Vector, info)."""
    D = {}
    P = {}
    info = {'clamped': []}

    def place(n):
        p = sk.parent(n)
        P[n] = P[p] + D[p] @ (sk.head(n) - sk.head(p))

    def set_dir(n, target, Dp):
        cur = Dp @ sk.rest_dir(n)
        t = target.normalized()
        q = cur.rotation_difference(t)
        D[n] = q @ Dp

    D['root'] = Quaternion()
    P['root'] = sk.head('root').copy()
    hp = pose.get('hips', {})
    D['hips'] = spine_q(*hp.get('rot', (0, 0, 0)))
    remap = getattr(sk, 'map', None)
    loc = hp.get('loc', (0, 0, 0))
    if remap:
        # absolute legacy hip height -> this skeleton (keeps crouches and lying poses on the floor)
        z_old = sk.legacy_P + loc[2]
        loc = (loc[0], loc[1], remap(z_old) - sk.head('hips').z)
    P['hips'] = sk.head('hips') + C(*loc)
    hip_twist = hp.get('rot', (0, 0, 0))[2]
    for n in ('spine', 'chest', 'neck', 'head'):
        place(n)
        D[n] = D[sk.parent(n)] @ spine_q(*pose.get(n, (0, 0, 0)))

    for s in 'LR':
        sh, ua, fa, hd = 'shoulder_' + s, 'upper_arm_' + s, 'forearm_' + s, 'hand_' + s
        place(sh)
        D[sh] = D['chest'] @ clav_q(s, *pose.get(sh, (0, 0)))
        place(ua)
        spec = pose['hand_' + s]
        S = P[ua]
        a, b = sk.seg(ua, fa), sk.seg(fa, hd)
        T = _target(sk, spec, P['hips'])
        pole = C(*spec.get('pole', ARM_POLE[s]))
        E, W, cl = _two_bone(S, T, a, b, pole)
        if cl and cl > 0.01:
            info['clamped'].append((hd, round(cl, 3)))
        set_dir(ua, E - S, D[sh])
        place(fa)
        set_dir(fa, W - P[fa], D[ua])
        place(hd)
        if 'dir' in spec:
            set_dir(hd, C(*spec['dir']), D[fa])
        else:
            D[hd] = D[fa]
        if spec.get('twist'):
            D[hd] = Quaternion(D[hd] @ sk.rest_dir(hd), math.radians(spec['twist'])) @ D[hd]

        th, sn, ft = 'thigh_' + s, 'shin_' + s, 'foot_' + s
        place(th)
        fs = pose['foot_' + s]
        H = P[th]
        a, b = sk.seg(th, sn), sk.seg(sn, ft)
        T = _target(sk, fs, P['hips'])
        pole = C(*fs.get('pole', LEG_POLE[s]))
        K, A, cl = _two_bone(H, T, a, b, pole)
        if cl and cl > 0.01:
            info['clamped'].append((ft, round(cl, 3)))
        set_dir(th, K - H, D['hips'])
        place(sn)
        set_dir(sn, A - P[sn], D[th])
        place(ft)
        base = sk.rest_dir(ft)
        dir_ = qa(AZ, hip_twist + fs.get('yaw', 0.0)) @ qa(AX, fs.get('pitch', 0.0)) @ base
        set_dir(ft, dir_, D[sn])

    local = {}
    for n in MAIN_BONES:
        R = sk.b[n]['R']
        p = sk.parent(n)
        Dp = D[p] if p else Quaternion()
        local[n] = R.inverted() @ Dp.inverted() @ D[n] @ R
    _finger_locals(sk, local, pose)
    _twist_locals(sk, local, D)
    hips_loc = sk.b['hips']['R'].inverted() @ (P['hips'] - sk.head('hips'))
    info['P'] = P
    info['D'] = D
    return local, hips_loc, info


# ---------------------------------------------------------------- pose authoring helpers

def P(base, **kw):
    """Deep-merge overrides into a copy of base. Dict values merge one level deep."""
    out = copy.deepcopy(base)
    for k, v in kw.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            d = dict(out[k])
            d.update(v)
            out[k] = d
        else:
            out[k] = v
    return out


def mirror_pose(pose):
    """Mirror left/right (used to derive symmetric variants)."""
    out = {}
    for k, v in pose.items():
        nk = k[:-2] + ('_R' if k.endswith('_L') else '_L') if k.endswith(('_L', '_R')) else k
        out[nk] = _mirror_val(k, v)
    return out


def _mirror_val(k, v):
    if isinstance(v, dict):
        r = {}
        for kk, vv in v.items():
            if kk in ('pos', 'pole', 'dir', 'loc'):
                r[kk] = (-vv[0], vv[1], vv[2])
            elif kk == 'rot':
                r[kk] = (vv[0], -vv[1], -vv[2])
            elif kk in ('yaw', 'twist'):
                r[kk] = -vv
            else:
                r[kk] = vv
        return r
    if k in ('spine', 'chest', 'neck', 'head'):
        return (v[0], -v[1], -v[2])
    return v


_NUM_DEFAULTS = {'pitch': 0.0, 'twist': 0.0, 'yaw': 0.0, 'spin': 0.0}


def _lerp(a, b, t):
    if isinstance(a, dict):
        out = {}
        for k in set(a) | set(b):
            if k in a and k in b:
                out[k] = _lerp(a[k], b[k], t)
            elif k in _NUM_DEFAULTS:
                # scalar keys missing on one side blend from/to their neutral value instead of popping
                out[k] = _lerp(a.get(k, _NUM_DEFAULTS[k]), b.get(k, _NUM_DEFAULTS[k]), t)
            else:
                out[k] = a.get(k, b.get(k)) if t < 0.5 or k not in b else b[k]
        return out
    if isinstance(a, (tuple, list)):
        return tuple(_lerp(x, y, t) for x, y in zip(a, b))
    if isinstance(a, (int, float)):
        return a + (b - a) * t
    return a if t < 0.5 else b


EASE = {
    'lin': lambda t: t,
    'in': lambda t: t * t,
    'in3': lambda t: t * t * t,
    'out': lambda t: 1 - (1 - t) ** 2,
    'out3': lambda t: 1 - (1 - t) ** 3,
    'snap': lambda t: 1 - (1 - t) ** 4,
    'inout': lambda t: t * t * (3 - 2 * t),
    'hold': lambda t: 0.0 if t < 1 else 1.0,
}


def sample(keys, f):
    """keys: list of (frame, pose, ease). ease applies to the segment ENDING at that key."""
    if f <= keys[0][0]:
        return keys[0][1]
    for (f0, p0, _), (f1, p1, e1) in zip(keys, keys[1:]):
        if f0 <= f <= f1:
            t = 0.0 if f1 == f0 else (f - f0) / (f1 - f0)
            return _lerp(p0, p1, EASE[e1](t))
    return keys[-1][1]


def apply_pose(arm_obj, sk, pose):
    local, hips_loc, info = solve(sk, pose)
    for pb in arm_obj.pose.bones:
        if pb.name not in local:
            pb.rotation_quaternion = (1, 0, 0, 0)
    for n, q in local.items():
        arm_obj.pose.bones[n].rotation_quaternion = q
    arm_obj.pose.bones['hips'].location = hips_loc
    return info


def bake_clip(arm_obj, sk, name, keys, length, step=2, grips=('relaxed', 'relaxed')):
    import bpy
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm_obj.animation_data_create()
    arm_obj.animation_data.action = act
    prev = {}
    frames = list(range(0, length + 1, step))
    if frames[-1] != length:
        frames.append(length)
    clamped = {}
    keys = [(kf, with_grips(p, *grips), e) for kf, p, e in keys]
    for f in frames:
        pose = sample(keys, f)
        local, hips_loc, info = solve(sk, pose)
        for nm_, ex in info['clamped']:
            clamped[nm_] = max(clamped.get(nm_, 0.0), ex)
        for n in local:
            q = local[n]
            if n in prev and prev[n].dot(q) < 0:
                q = -q
            prev[n] = q
            pb = arm_obj.pose.bones[n]
            pb.rotation_quaternion = q
            pb.keyframe_insert('rotation_quaternion', frame=f)
        pb = arm_obj.pose.bones['hips']
        pb.location = hips_loc
        pb.keyframe_insert('location', frame=f)
    arm_obj.animation_data.action = None
    return act, {k: round(v, 3) for k, v in sorted(clamped.items())}
