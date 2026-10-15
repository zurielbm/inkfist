"""Skeleton built from anatomical joints: the 20 shared bones + fingers + forearm twist (+ secondary chains).

Bone names are shared by every character (the game and the clips rely on them). Rest pose = the base body's
relaxed A-pose; the pose solver works from rest directions, so the A-pose rest does not change the clips.
"""
import bpy
import numpy as np
from mathutils import Vector

from .anatomy import FINGERS

MAIN_BONES = ['root', 'hips', 'spine', 'chest', 'neck', 'head',
              'shoulder_L', 'upper_arm_L', 'forearm_L', 'hand_L',
              'shoulder_R', 'upper_arm_R', 'forearm_R', 'hand_R',
              'thigh_L', 'shin_L', 'foot_L', 'thigh_R', 'shin_R', 'foot_R']

PARENTS = {
    'root': None, 'hips': 'root', 'spine': 'hips', 'chest': 'spine', 'neck': 'chest', 'head': 'neck',
    'shoulder_L': 'chest', 'upper_arm_L': 'shoulder_L', 'forearm_L': 'upper_arm_L', 'hand_L': 'forearm_L',
    'shoulder_R': 'chest', 'upper_arm_R': 'shoulder_R', 'forearm_R': 'upper_arm_R', 'hand_R': 'forearm_R',
    'thigh_L': 'hips', 'shin_L': 'thigh_L', 'foot_L': 'shin_L',
    'thigh_R': 'hips', 'shin_R': 'thigh_R', 'foot_R': 'shin_R',
}


def finger_bones(side):
    out = []
    for f in FINGERS:
        for k in (1, 2, 3):
            out.append(f'{f}_{k}_{side}')
    return out


FINGER_BONES = finger_bones('L') + finger_bones('R')
TWIST_BONES = ['forearm_twist_L', 'forearm_twist_R']
DEFORM_BONES = [b for b in MAIN_BONES if b != 'root'] + FINGER_BONES + TWIST_BONES


def _v(p):
    return Vector(tuple(float(x) for x in p))


def layout(P):
    """Joint points (dict from anatomy.evaluate) -> bone table {name: (head, tail, parent, roll_z_hint)}."""
    B = {}
    mid = lambda a, b, t=0.5: a + (b - a) * t  # noqa: E731
    top = _v(P['head_top'])
    B['root'] = (Vector((0, 0, 0)), Vector((0, 0, 0.12)), None, None)
    pel, sp0, ch0, nk0, hd0 = (_v(P[k]) for k in ('pelvis', 'spine0', 'chest0', 'neck0', 'head0'))
    for p in (pel, sp0, ch0, nk0, hd0):
        p.x = 0.0
    B['hips'] = (pel, sp0, 'root', Vector((0, -1, 0)))
    B['spine'] = (sp0, ch0, 'hips', Vector((0, -1, 0)))
    B['chest'] = (ch0, nk0, 'spine', Vector((0, -1, 0)))
    B['neck'] = (nk0, hd0, 'chest', Vector((0, -1, 0)))
    B['head'] = (hd0, Vector((0, hd0.y, top.z)), 'neck', Vector((0, -1, 0)))
    st = _v(P['sternum'])
    for s, sx in (('L', 1), ('R', -1)):
        gh, el, wr = _v(P['shoulder_' + s]), _v(P['elbow_' + s]), _v(P['wrist_' + s])
        clav_h = Vector((sx * 0.025, (st.y + gh.y) * 0.5, st.z + 0.005))
        clav_t = Vector((gh.x - sx * 0.02, gh.y, gh.z + 0.025))
        B['shoulder_' + s] = (clav_h, clav_t, 'chest', Vector((0, -1, 0)))
        # elbow pole points backward: keep the arm bones' Z axis pointing forward (-Y)
        B['upper_arm_' + s] = (gh, el, 'shoulder_' + s, Vector((0, -1, 0)))
        B['forearm_' + s] = (el, wr, 'upper_arm_' + s, Vector((0, -1, 0)))
        B['forearm_twist_' + s] = (mid(el, wr), wr, 'forearm_' + s, Vector((0, -1, 0)))
        mcp = _v(P['middle_mcp_' + s])
        palm = palm_normal(P, s)
        B['hand_' + s] = (wr, mcp, 'forearm_' + s, palm)
        hp, kn, an = _v(P['hip_' + s]), _v(P['knee_' + s]), _v(P['ankle_' + s])
        B['thigh_' + s] = (hp, kn, 'hips', Vector((0, -1, 0)))
        B['shin_' + s] = (kn, an, 'thigh_' + s, Vector((0, -1, 0)))
        toe, heel = _v(P['toe_' + s]), _v(P['heel_' + s])
        ball = heel + (toe - heel) * 0.74
        ball.z = max(0.02, an.z * 0.25)
        B['foot_' + s] = (an, ball, 'shin_' + s, Vector((0, 0, 1)))
        for f in FINGERS:
            if f == 'thumb':
                pts = [P['thumb_cmc_' + s], P['thumb_mcp_' + s], P['thumb_ip_' + s], P['thumb_tip_' + s]]
            else:
                pts = [P[f'{f}_mcp_' + s], P[f'{f}_pip_' + s], P[f'{f}_dip_' + s], P[f'{f}_tip_' + s]]
            pts = [_v(p) for p in pts]
            pts[3] = pts[2] + (pts[3] - pts[2]) * 0.82  # tip joint sits inside the pad
            parent = 'hand_' + s
            for k in range(3):
                nm = f'{f}_{k + 1}_{s}'
                B[nm] = (pts[k], pts[k + 1], parent, palm)
                parent = nm
    return B


def palm_normal(P, s):
    """Unit vector out of the palm (palmar side) for hand `s`."""
    w = np.asarray(P['wrist_' + s])
    i, p = np.asarray(P['index_mcp_' + s]), np.asarray(P['pinky_mcp_' + s])
    m = np.asarray(P['middle_mcp_' + s])
    ax = m - w
    lat = i - p
    n = np.cross(ax, lat) if s == 'L' else np.cross(lat, ax)
    n = n / np.linalg.norm(n)
    # palms face the body in the A-pose: left palm normal points toward -X
    if (s == 'L' and n[0] > 0) or (s == 'R' and n[0] < 0):
        n = -n
    return _v(n)


def build_armature(name, B, extra=()):
    """B: layout() table. extra: [(name, parent, head, tail)] secondary chain bones."""
    data = bpy.data.armatures.new(name + '_rig')
    obj = bpy.data.objects.new(name + '_rig', data)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = {}
    for nm, (h, t, parent, roll_hint) in B.items():
        b = data.edit_bones.new(nm)
        b.head, b.tail = h, t
        if roll_hint is not None:
            b.align_roll(roll_hint)
        eb[nm] = b
    for nm, (h, t, parent, _) in B.items():
        if parent:
            eb[nm].parent = eb[parent]
    for (nm, parent, h, t) in extra:
        b = data.edit_bones.new(nm)
        b.head, b.tail = Vector(h), Vector(t)
        b.align_roll(Vector((0, -1, 0)) if abs((Vector(t) - Vector(h)).normalized().y) < 0.9 else Vector((0, 0, 1)))
        b.parent = data.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in obj.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    deform = set(DEFORM_BONES) | {e[0] for e in extra}
    for b in data.bones:
        b.use_deform = b.name in deform
    return obj


def make_chain(prefix, parent, points):
    out = []
    prev = parent
    for i in range(len(points) - 1):
        nm = f'{prefix}_{i + 1}'
        out.append((nm, prev, tuple(points[i]), tuple(points[i + 1])))
        prev = nm
    return out
