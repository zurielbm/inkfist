"""Shared helpers for building INKFIST characters in Blender (headless).

Conventions
- Blender units are metres, Z up. Characters face -Y. Character's LEFT is +X.
- Pose/character space helper C(side, fwd, up): side>0 = character's left, fwd>0 = forward.
"""
import bpy
import math
import os
from mathutils import Vector, Quaternion, Matrix

BLENDER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(BLENDER_DIR)
CHAR_OUT = os.path.join(REPO, 'game', 'public', 'assets', 'chars')  # metadata JSON (served)
CHAR_SRC = os.path.join(REPO, 'game', 'assets-src', 'chars')  # raw .glb (optimised into public by `npm run optimize`)
PREVIEW_DIR = os.path.join(REPO, '.scratch', 'previews')


def C(side, fwd, up):
    """Character space -> Blender space."""
    return Vector((side, -fwd, up))


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


# ---------------------------------------------------------------- scene

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = 60
    sc.frame_start = 0
    try:
        bpy.context.preferences.edit.keyframe_new_interpolation_type = 'LINEAR'
    except Exception:
        pass
    return sc


def material(name, hex_color, roughness=0.85, emission=None):
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    rgb = hex_rgb(hex_color)
    lin = tuple(srgb_to_linear(c) for c in rgb)
    nt = m.node_tree
    bsdf = None
    for n in nt.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            bsdf = n
    if bsdf is None:
        bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
        out = nt.nodes.get('Material Output') or nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(bsdf.outputs[0], out.inputs[0])
    bsdf.inputs['Base Color'].default_value = (*lin, 1.0)
    bsdf.inputs['Roughness'].default_value = roughness
    if 'Specular IOR Level' in bsdf.inputs:
        bsdf.inputs['Specular IOR Level'].default_value = 0.2
    m.diffuse_color = (*lin, 1.0)
    return m


# ---------------------------------------------------------------- geometry primitives

def _superellipse(c, s, power):
    if power == 2.0:
        return c, s
    e = 2.0 / power
    return (math.copysign(abs(c) ** e, c), math.copysign(abs(s) ** e, s))


def sweep(path, radii, segs=12, ref=None, cap0=True, cap1=True, closed=False,
          power=2.0, offsets=None, twist=0.0, arc=None):
    """Sweep an elliptical cross-section along a polyline.

    path:   list of Vector
    radii:  list of float or (rx, ry) per path point
    ref:    Vector used for the cross-section X axis (projected); None -> parallel transport
    offsets: optional list of Vector added per ring (after frame computation)
    arc:    optional (a0, a1) radians -> open arc cross-section (still capped as a ribbon)
    Returns (verts, faces).
    """
    n = len(path)
    pts = [Vector(p) for p in path]
    tangents = []
    for i in range(n):
        if closed:
            t = pts[(i + 1) % n] - pts[(i - 1) % n]
        elif i == 0:
            t = pts[1] - pts[0]
        elif i == n - 1:
            t = pts[-1] - pts[-2]
        else:
            t = pts[i + 1] - pts[i - 1]
        if t.length < 1e-9:
            t = Vector((0, 0, 1))
        tangents.append(t.normalized())

    normals = []
    prev_n = None
    for i, t in enumerate(tangents):
        if ref is not None:
            r = Vector(ref)
            nv = r - t * r.dot(t)
            if nv.length < 1e-6:
                nv = prev_n if prev_n is not None else _any_perp(t)
            nv.normalize()
        else:
            if prev_n is None:
                nv = _any_perp(t)
            else:
                nv = prev_n - t * prev_n.dot(t)
                if nv.length < 1e-6:
                    nv = _any_perp(t)
                nv.normalize()
        normals.append(nv)
        prev_n = nv

    verts = []
    faces = []
    if arc is None:
        angles = [2 * math.pi * k / segs + twist for k in range(segs)]
        ring_closed = True
    else:
        a0, a1 = arc
        angles = [a0 + (a1 - a0) * k / (segs - 1) for k in range(segs)]
        ring_closed = False
    m = len(angles)
    for i in range(n):
        t, nv = tangents[i], normals[i]
        bv = t.cross(nv)
        r = radii[i]
        rx, ry = (r, r) if not isinstance(r, (tuple, list)) else r
        off = offsets[i] if offsets else Vector((0, 0, 0))
        for a in angles:
            c, s = _superellipse(math.cos(a), math.sin(a), power)
            verts.append(pts[i] + off + nv * (rx * c) + bv * (ry * s))
    rings = n if not closed else n
    for i in range(rings - (0 if closed else 1)):
        i2 = (i + 1) % n
        for k in range(m if ring_closed else m - 1):
            k2 = (k + 1) % m
            faces.append((i * m + k, i * m + k2, i2 * m + k2, i2 * m + k))
    if not closed and ring_closed:
        if cap0:
            ci = len(verts)
            verts.append(pts[0] + (offsets[0] if offsets else Vector()))
            for k in range(m):
                faces.append((ci, (k + 1) % m, k))
        if cap1:
            ci = len(verts)
            verts.append(pts[-1] + (offsets[-1] if offsets else Vector()))
            base = (n - 1) * m
            for k in range(m):
                faces.append((ci, base + k, base + (k + 1) % m))
    return verts, faces


def _any_perp(t):
    a = Vector((1, 0, 0)) if abs(t.x) < 0.9 else Vector((0, 1, 0))
    v = a - t * a.dot(t)
    return v.normalized()


def ellipsoid(center, rx, ry, rz, segs=14, rings=10, rot=None):
    """UV ellipsoid. rot: optional Matrix(3x3) applied to the local shape."""
    c = Vector(center)
    verts = []
    faces = []
    for j in range(1, rings):
        phi = math.pi * j / rings
        z = math.cos(phi)
        r = math.sin(phi)
        for k in range(segs):
            th = 2 * math.pi * k / segs
            v = Vector((rx * r * math.cos(th), ry * r * math.sin(th), rz * z))
            if rot is not None:
                v = rot @ v
            verts.append(c + v)
    top = len(verts)
    verts.append(c + ((rot @ Vector((0, 0, rz))) if rot is not None else Vector((0, 0, rz))))
    bot = len(verts)
    verts.append(c + ((rot @ Vector((0, 0, -rz))) if rot is not None else Vector((0, 0, -rz))))
    for j in range(rings - 2):
        for k in range(segs):
            k2 = (k + 1) % segs
            a, b = j * segs + k, j * segs + k2
            c2, d = (j + 1) * segs + k2, (j + 1) * segs + k
            faces.append((a, d, c2, b))
    for k in range(segs):
        k2 = (k + 1) % segs
        faces.append((top, k, k2))
        last = (rings - 2) * segs
        faces.append((bot, last + k2, last + k))
    return verts, faces


def box(center, sx, sy, sz, rot=None):
    c = Vector(center)
    vs = []
    for z in (-1, 1):
        for y in (-1, 1):
            for x in (-1, 1):
                v = Vector((x * sx, y * sy, z * sz))
                vs.append(c + (rot @ v if rot is not None else v))
    faces = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    return vs, faces


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


# ---------------------------------------------------------------- mesh builder with skin weights

class MeshBuilder:
    def __init__(self):
        self.verts = []
        self.faces = []
        self.face_mat = []
        self.weights = []  # per-vertex dict bone->w
        self.mats = []

    def mat_index(self, name):
        if name not in self.mats:
            self.mats.append(name)
        return self.mats.index(name)

    def add(self, geo, mat, weight):
        """weight: bone name | dict | callable(Vector)->dict"""
        verts, faces = geo
        base = len(self.verts)
        mi = self.mat_index(mat)
        for v in verts:
            v = Vector(v)
            self.verts.append(v)
            if isinstance(weight, str):
                self.weights.append({weight: 1.0})
            elif isinstance(weight, dict):
                self.weights.append(dict(weight))
            else:
                self.weights.append(weight(v))
        for f in faces:
            self.faces.append(tuple(base + i for i in f))
            self.face_mat.append(mi)
        return base

    def mirror_x(self, geo):
        verts, faces = geo
        mv = [Vector((-v[0], v[1], v[2])) for v in verts]
        mf = [tuple(reversed(f)) for f in faces]
        return mv, mf

    def build(self, name, arm_obj, materials):
        me = bpy.data.meshes.new(name)
        me.from_pydata([tuple(v) for v in self.verts], [], self.faces)
        me.update()
        import bmesh
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()
        me.update()
        for mname in self.mats:
            me.materials.append(materials[mname])
        for i, poly in enumerate(me.polygons):
            poly.material_index = self.face_mat[i]
            poly.use_smooth = True
        obj = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(obj)
        groups = {}
        for vi, wd in enumerate(self.weights):
            tot = sum(wd.values()) or 1.0
            for bname, w in wd.items():
                if w <= 1e-4:
                    continue
                g = groups.get(bname)
                if g is None:
                    g = obj.vertex_groups.new(name=bname)
                    groups[bname] = g
                g.add([vi], w / tot, 'REPLACE')
        obj.parent = arm_obj
        mod = obj.modifiers.new('Armature', 'ARMATURE')
        mod.object = arm_obj
        return obj


def blend_z(bone_hi, bone_lo, z_mid, width):
    """Weight function blending two bones across height z_mid (bone_hi above)."""
    def f(v):
        t = smoothstep(z_mid - width, z_mid + width, v.z)
        return {bone_hi: t, bone_lo: 1.0 - t}
    return f


def chain_z(stops):
    """stops: list of (z, bone) sorted from top to bottom; linear blend between stop heights."""
    def f(v):
        z = v.z
        if z >= stops[0][0]:
            return {stops[0][1]: 1.0}
        for (z0, b0), (z1, b1) in zip(stops, stops[1:]):
            if z0 >= z >= z1:
                t = (z0 - z) / max(1e-6, z0 - z1)
                return {b0: 1 - t, b1: t}
        return {stops[-1][1]: 1.0}
    return f


def chain_weights(points, bones, root_bone=None, root_frac=0.3, blend=0.3):
    """bones[i] spans points[i]..points[i+1]. Smooth blend between neighbours and into root_bone at the top."""
    pts = [Vector(p) for p in points]

    def f(v):
        best = None
        for i in range(len(pts) - 1):
            a, b = pts[i], pts[i + 1]
            ab = b - a
            t = max(0.0, min(1.0, (v - a).dot(ab) / max(1e-9, ab.length_squared)))
            d = (a + ab * t - v).length
            if best is None or d < best[0]:
                best = (d, i, t)
        _, i, t = best
        if i == 0 and root_bone and t < root_frac:
            k = smoothstep(0, root_frac, t)
            return {root_bone: 1 - k, bones[0]: k}
        if i + 1 < len(bones) and t > 1 - blend:
            k = 0.5 * smoothstep(1 - blend, 1.0, t)
            return {bones[i]: 1 - k, bones[i + 1]: k}
        if i > 0 and t < blend:
            k = 0.5 * (1 - smoothstep(0, blend, t))
            return {bones[i - 1]: k, bones[i]: 1 - k}
        return {bones[i]: 1.0}
    return f


def chain_path(points_bones, falloff=0.6):
    """Weights along a polyline of (point, bone) — nearest segment parameter blend."""
    pts = [Vector(p) for p, _ in points_bones]
    bones = [b for _, b in points_bones]

    def f(v):
        best = None
        for i in range(len(pts) - 1):
            a, b = pts[i], pts[i + 1]
            ab = b - a
            t = max(0.0, min(1.0, (v - a).dot(ab) / max(1e-9, ab.length_squared)))
            d = (a + ab * t - v).length
            if best is None or d < best[0]:
                best = (d, i, t)
        _, i, t = best
        # bone i owns segment i; blend into next bone near the end of the segment
        w = smoothstep(1 - falloff, 1.0, t)
        res = {bones[i]: 1 - w}
        if i + 1 < len(bones):
            res[bones[i + 1]] = res.get(bones[i + 1], 0) + w
        return res
    return f


# ---------------------------------------------------------------- armature

MAIN_BONES = ['root', 'hips', 'spine', 'chest', 'neck', 'head',
              'shoulder_L', 'upper_arm_L', 'forearm_L', 'hand_L',
              'shoulder_R', 'upper_arm_R', 'forearm_R', 'hand_R',
              'thigh_L', 'shin_L', 'foot_L', 'thigh_R', 'shin_R', 'foot_R']


def humanoid_joints(H=1.80, shoulder_x=0.19, hip_x=0.095, head_h=None, leg=0.52, arm_scale=1.0):
    """Returns dict of joint positions (Blender space) for the shared skeleton."""
    hh = head_h if head_h is not None else H / 7.8
    hip_z = H * leg
    knee_z = hip_z * 0.535
    ankle_z = H * 0.047
    pelvis = hip_z + H * 0.028
    spine0 = pelvis + H * 0.056
    chest0 = spine0 + H * 0.10
    neck0 = H - hh - H * 0.052
    head0 = H - hh
    sh_z = neck0 - H * 0.025
    ua = H * 0.157 * arm_scale
    fa = H * 0.145 * arm_scale
    hd = H * 0.06
    J = {
        'root': ((0, 0, 0), (0, 0, 0.12)),
        'hips': ((0, 0, pelvis), (0, 0, spine0)),
        'spine': ((0, 0, spine0), (0, 0, chest0)),
        'chest': ((0, 0, chest0), (0, 0, neck0)),
        'neck': ((0, 0, neck0), (0, 0, head0)),
        'head': ((0, 0, head0), (0, 0, H)),
    }
    for s, sx in (('L', 1), ('R', -1)):
        J['shoulder_' + s] = ((sx * 0.035, 0, sh_z + 0.01), (sx * (shoulder_x - 0.015), 0, sh_z + 0.01))
        J['upper_arm_' + s] = ((sx * shoulder_x, 0, sh_z), (sx * shoulder_x, 0, sh_z - ua))
        J['forearm_' + s] = ((sx * shoulder_x, 0, sh_z - ua), (sx * shoulder_x, 0, sh_z - ua - fa))
        J['hand_' + s] = ((sx * shoulder_x, 0, sh_z - ua - fa), (sx * shoulder_x, 0, sh_z - ua - fa - hd))
        J['thigh_' + s] = ((sx * hip_x, 0, hip_z), (sx * hip_x, 0, knee_z))
        J['shin_' + s] = ((sx * hip_x, 0, knee_z), (sx * hip_x, 0, ankle_z))
        J['foot_' + s] = ((sx * hip_x, 0, ankle_z), (sx * hip_x, -H * 0.085, 0.02))
    return J


PARENTS = {
    'root': None, 'hips': 'root', 'spine': 'hips', 'chest': 'spine', 'neck': 'chest', 'head': 'neck',
    'shoulder_L': 'chest', 'upper_arm_L': 'shoulder_L', 'forearm_L': 'upper_arm_L', 'hand_L': 'forearm_L',
    'shoulder_R': 'chest', 'upper_arm_R': 'shoulder_R', 'forearm_R': 'upper_arm_R', 'hand_R': 'forearm_R',
    'thigh_L': 'hips', 'shin_L': 'thigh_L', 'foot_L': 'shin_L',
    'thigh_R': 'hips', 'shin_R': 'thigh_R', 'foot_R': 'shin_R',
}


def build_armature(name, joints, extra=None):
    """joints: dict bone->(head, tail); extra: list of (bone, parent, head, tail)."""
    data = bpy.data.armatures.new(name + '_rig')
    obj = bpy.data.objects.new(name + '_rig', data)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = {}
    for bname in MAIN_BONES:
        h, t = joints[bname]
        b = data.edit_bones.new(bname)
        b.head = h
        b.tail = t
        b.roll = 0.0
        eb[bname] = b
    for bname in MAIN_BONES:
        p = PARENTS[bname]
        if p:
            eb[bname].parent = eb[p]
    for (bname, parent, h, t) in (extra or []):
        b = data.edit_bones.new(bname)
        b.head = h
        b.tail = t
        b.roll = 0.0
        b.parent = data.edit_bones[parent]
        eb[bname] = b
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in obj.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    return obj


def make_chain(prefix, parent, points):
    """Points list -> extra bone defs [(name,parent,head,tail)...] for a secondary-motion chain."""
    out = []
    prev = parent
    for i in range(len(points) - 1):
        nm = f'{prefix}_{i + 1}'
        out.append((nm, prev, tuple(points[i]), tuple(points[i + 1])))
        prev = nm
    return out


# ---------------------------------------------------------------- export

def export_glb(path, objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True,
        export_animations=True, export_animation_mode='ACTIONS',
        # sampled LINEAR keys (not the fcurves' CUBICSPLINE, 3x the data): the optimizer can then thin them
        export_force_sampling=True, export_frame_step=1, export_optimize_animation_size=True,
        export_optimize_animation_keep_anim_armature=False,   # no constant rest-pose channels (chain bones, scales)
        export_skins=True, export_morph=True, export_morph_normal=False, export_yup=True, export_apply=False,
        export_materials='EXPORT', export_attributes=True, export_image_format='WEBP', export_image_quality=80,
        export_vertex_color='NONE', export_all_vertex_colors=False, export_active_vertex_color_when_no_material=False,
    )
