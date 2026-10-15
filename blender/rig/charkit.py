"""Shared character-build steps: rig + weights, skin split (head / body), face features with morph targets."""
import bpy
import numpy as np

from . import face as F
from . import garment as G
from . import skeleton, skin
from .base import to_blender
from .part import Part

MORPHS = ('blink', 'glare', 'pain', 'shout', 'smirk')


class Timer:
    """Prints elapsed time per build step (INFO lines survive run.sh's filter)."""

    def __init__(self, tag):
        import time
        self.t = self.t0 = time.time()
        self.tag = tag

    def __call__(self, step):
        import time
        now = time.time()
        print(f'INFO {self.tag} {step}: {now - self.t:.1f}s (total {now - self.t0:.1f}s)', flush=True)
        self.t = now


def build_rig(b, CH, char_id):
    P = b.joints()
    B = skeleton.layout(P)
    extra = []
    for name, c in CH.items():
        extra += skeleton.make_chain(name, c['parent'], c['points'])
        c['bones'] = [f'{name}_{i + 1}' for i in range(len(c['points']) - 1)]
    arm = skeleton.build_armature(char_id, B, extra)
    tmp = to_blender('tmp_body', b.topo, b.co)
    names, W = skin.heat_weights(tmp, arm, skeleton.DEFORM_BONES)
    W = skin.smooth_weights(b.topo, W, iters=2)
    bpy.data.objects.remove(tmp)
    all_names = [bn.name for bn in arm.data.bones if bn.use_deform]
    Wfull = np.zeros((len(W), len(all_names)))
    for j, n in enumerate(names):
        Wfull[:, all_names.index(n)] = W[:, j]
    return arm, P, all_names, Wfull


def skin_parts(b, covered, names, W, fr):
    """Visible skin split into the head mesh (face, with morphs) and the body mesh.

    covered: per-vertex bool (hidden under clothes; one ring under each garment edge is kept)."""
    topo = b.topo
    edge = np.zeros(topo.nv, bool)
    for v in np.where(~covered)[0]:
        for w in topo.adj[v]:
            edge[w] = True
    hide = covered & ~edge
    inside = np.zeros(topo.nv, bool)
    for E in fr.eyes.values():
        inside |= np.linalg.norm(b.co - E.c, axis=1) < E.r * 0.97
    hw = W[:, names.index('head')] + 0.5 * W[:, names.index('neck')]
    face_paint = []
    in_bag = np.zeros(topo.nv, bool)
    in_bag[fr.bag] = True
    keep_body, keep_head = [], []
    for f in topo.faces:
        if all(hide[v] for v in f) or all(inside[v] for v in f):
            keep_body.append(False)
            keep_head.append(False)
            continue
        is_head = all(hw[v] > 0.5 for v in f)
        keep_head.append(is_head)
        keep_body.append(not is_head)
    paint = ['mouth' if all(in_bag[v] for v in f) else 'skin' for f in topo.faces]
    full = Part('skin', b.co, topo.faces, 'skin', 'body', uv=topo.uv, src=np.arange(topo.nv))
    full.face_paint = paint
    body_skin = full.subset(keep_body, 'skin_body')
    head = full.subset(keep_head, 'skin_head')
    head.group = 'head'
    head.attrs['face_skin'] = np.ones(head.nv)
    # no ink hull inside the mouth: an open jaw would otherwise fill the cavity with solid black
    head.outline = np.where(in_bag[np.asarray(head.src)], 0.0, 1.0)
    head.texel = 2.0
    R = fr.weights(head.co, head.src)
    head.keys = fr.morphs(head.co, R)
    return body_skin, head


def face_features(b, fr, head, style):
    """Eyeballs, lash lines, brows; keys follow the skin. style: dict of per-character shapes."""
    surf = G.Surface(b.co, b.topo.faces)
    parts = []
    for s in 'LR':
        E = fr.eyes[s]
        parts.append(E.eyeball('eye_' + s))
        lt = style.get('lash', (0.0008, 0.0032, 0.008))
        parts.append(F.lash_strip(E, surf, 'lash_up_' + s, E.upper, lt[0], lt[1], wing=lt[2], up=True))
        lo = E.lower[int(len(E.lower) * style.get('lower_lash_from', 0.35)):]
        if len(lo) >= 3:
            parts.append(F.lash_strip(E, surf, 'lash_lo_' + s, lo, 0.0002, style.get('lower_lash', 0.0008), up=False))
        sx = 1 if s == 'L' else -1
        ctrl = [E.c + np.array([sx * dx, 0, dz]) for dx, dz in style['brow_ctrl']]
        parts.append(F.brow(surf, 'brow_' + s, ctrl, style['brow_width'], lift=style.get('brow_lift', 0.0012),
                            paint=style.get('brow_paint', 'brow')))
    for p in parts:
        p.group = 'head'
        if p.name.startswith('eye_'):
            p.keys = {k: np.zeros_like(p.co) for k in head.keys}
        else:
            p.keys = F.follow_deltas(head.co, head.keys, p.co)
            p.texel = 2.0
    return parts


def hidden_body(covered):
    return covered


def ao_pose(arm, on):
    """Arms lifted out, so baked occlusion doesn't stain the coat where the A-pose arms hang. The legs stay in the
    rest pose: garments are built clear of each other there, and spreading them makes skirt panels cut into the
    trousers (inked as dark combs)."""
    from . import pose
    if not on:
        for pb in arm.pose.bones:
            pb.rotation_quaternion = (1, 0, 0, 0)
            pb.location = (0, 0, 0)
        bpy.context.view_layer.update()
        return
    sk = pose.Skeleton(arm)
    an = {s: sk.head('foot_' + s) for s in 'LR'}
    sh = {s: sk.head('upper_arm_' + s) for s in 'LR'}
    spec = {'hips': {'loc': (0, 0, 0), 'rot': (0, 0, 0)}}
    for s, sx in (('L', 1), ('R', -1)):
        spec['hand_' + s] = {'pos': (sx * (abs(sh[s].x) + 0.50), 0.0, sh[s].z - 0.10), 'pole': (0, 1, 0)}
        spec['foot_' + s] = {'pos': (an[s].x, -an[s].y, an[s].z), 'pole': (sx * 0.2, 1, 0)}
    pose.apply_pose(arm, sk, spec)
    bpy.context.view_layer.update()


def surface(arm, objs, paints, char_id, size=2048, ink_size=1024):
    """UV atlas + baked albedo/ink textures + the single export material."""
    from . import paint
    T = Timer('surface')
    from .skeleton import DEFORM_BONES
    body = set(DEFORM_BONES)
    albedo, ink = paint.bake_textures(objs, paints, size, ink_size, ao_pose=lambda on: ao_pose(arm, on),
                                      is_loose=lambda g: g in arm.data.bones and g not in body)
    T('bake')
    albedo.name = f'{char_id}_albedo'
    ink.name = f'{char_id}_ink'
    return paint.final_material(objs, albedo, ink, f'{char_id}_ink')


def _weld_average(co, nrm, decimals=5):
    """Average normals over coincident vertices (seams) -> crack-free outline directions."""
    key = np.round(co, decimals)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.ravel()
    acc = np.zeros((inv.max() + 1, 3))
    np.add.at(acc, inv, nrm)
    out = acc[inv]
    ln = np.linalg.norm(out, axis=1)
    ln[ln < 1e-9] = 1
    return out / ln[:, None]


def _safe_unit(v, fallback):
    """Normalise rows; zero/NaN rows take the fallback row (or +Z)."""
    v = np.nan_to_num(np.asarray(v, float))
    ln = np.linalg.norm(v, axis=1)
    bad = ln < 1e-8
    out = v / np.where(bad, 1.0, ln)[:, None]
    if bad.any():
        fb = np.tile([0.0, 0.0, 1.0], (int(bad.sum()), 1)) if fallback is None else _safe_unit(np.asarray(fallback)[bad], None)
        out[bad] = fb
    return out


def _attr(me, name, n=1):
    a = me.attributes.get(name)
    if a is None:
        return None
    v = np.empty(len(me.vertices) * n, np.float32)
    a.data.foreach_get('value' if n == 1 else 'vector', v)
    return v if n == 1 else v.reshape(-1, n)


def ink_prep(objs, head_center, face_smooth=30):
    """Custom shading normals (face from a smoothed proxy, hair from a volume) + `_OUTLINE` attribute
    (glTF-space smoothed normal xyz, width w)."""
    from . import garment as G
    for o in objs:
        me = o.data
        bad = me.validate(verbose=False)
        if bad:
            print(f'WARN {o.name}: mesh validate fixed problems')
        me.update()
        nv = len(me.vertices)
        co = np.empty(nv * 3)
        me.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3)
        vn = np.empty(nv * 3)
        me.vertex_normals.foreach_get('vector', vn)
        vn = vn.reshape(-1, 3)
        nrm = vn.copy()
        if o.name.endswith('_head'):
            fs = _attr(me, 'face_skin')
            if fs is not None:
                faces = [tuple(p.vertices) for p in me.polygons]
                adj = G.adjacency(nv, faces)
                sm = G.laplacian(co, adj, face_smooth, 0.5)
                sn = G.vertex_normals(sm, faces)
                w = (fs > 0.5)[:, None] * 0.7
                nrm = vn * (1 - w) + sn * w
        elif o.name.endswith('_hair'):
            rad = co - np.asarray(head_center)
            rad /= np.linalg.norm(rad, axis=1)[:, None]
            nrm = vn * 0.4 + rad * 0.6
        nrm = _safe_unit(nrm, vn)
        nrm = _weld_average(co, nrm) if not o.name.endswith('_body') else nrm
        nrm = _safe_unit(nrm, vn)
        me.normals_split_custom_set_from_vertices([tuple(map(float, v)) for v in nrm])
        # outline: smoothed over seams, width from the per-vertex 'outline' attribute (hair tips thinner)
        on = _safe_unit(_weld_average(co, _safe_unit(vn, None)), None)
        width = _attr(me, 'outline')
        width = np.ones(nv) if width is None else width
        ht = _attr(me, 'hair_t')
        if ht is not None:
            width = width * (1.0 - 0.55 * np.clip(ht, 0, 1) ** 1.5)
        # Blender -> glTF axes; width is stored halved so every channel stays in [-1, 1] and quantizes to bytes
        gl = np.clip(np.stack([on[:, 0], on[:, 2], -on[:, 1], np.clip(width, 0, 2) * 0.5], 1), -1, 1).astype(np.float32)
        a = me.attributes.new('_OUTLINE', 'FLOAT_COLOR', 'POINT')
        a.data.foreach_set('color', gl.ravel())
        # drop build-only data from the export
        for nm in [a.name for a in me.attributes if not a.name.startswith(('_', '.')) and a.name not in
                   ('position', 'material_index', 'sharp_face', 'UVMap')]:
            if nm in me.attributes and me.attributes[nm].domain == 'POINT' and nm not in me.uv_layers:
                me.attributes.remove(me.attributes[nm])
        if 'Pat' in me.uv_layers:
            me.uv_layers.remove(me.uv_layers['Pat'])


def face_spots(fr, lips=None, blush=None, marks=()):
    """Skin paint spots placed from the face rig's landmarks (eye centres, mouth) instead of absolute heights.
    lips/blush: (hex, alpha) or None; marks: [(dx, dz from the left eye centre or 'brow', radius, hex, alpha, sym)]."""
    e = fr.eyes['L']
    m = fr.mouth_c
    out = []
    if lips:
        out.append((0.0, m[2] - 0.001, fr.corner_x * 0.62, lips[0], lips[1], True, 0.0055))
    if blush:
        out.append((e.c[0] + 0.006, e.c[2] - 0.032, 0.019, blush[0], blush[1], True, 0.012))
    for dx, dz, r, hexc, a, sym in marks:
        out.append((e.c[0] + dx if sym or dx >= 0 else dx, e.c[2] + dz, r, hexc, a, sym))
    return out


# capsules (bone head -> child joint) that secondary chains (hair, cloth) collide with in game
COLLIDER_BONES = [('hips', 'spine'), ('spine', 'chest'), ('chest', 'neck'), ('head', None),
                  ('thigh_L', 'shin_L'), ('shin_L', 'foot_L'), ('thigh_R', 'shin_R'), ('shin_R', 'foot_R'),
                  ('upper_arm_L', 'forearm_L'), ('forearm_L', 'hand_L'), ('upper_arm_R', 'forearm_R'),
                  ('forearm_R', 'hand_R')]


def colliders(b, names, W, arm, shrink=0.85):
    """Capsule radii measured from the body: mean distance of each bone's verts to its segment, shrunk a little
    so the rest pose never starts in contact."""
    bones = arm.data.bones
    out = []
    for bn, child in COLLIDER_BONES:
        a = np.array(bones[bn].head_local)
        c = np.array(bones[child].head_local) if child else np.array(bones[bn].tail_local)
        j = names.index(bn)
        sel = W[:, j] > 0.6
        if sel.sum() < 4:
            continue
        P = b.co[sel]
        ab = c - a
        t = np.clip(((P - a) @ ab) / (ab @ ab), 0, 1)
        d = np.linalg.norm(P - (a + np.outer(t, ab)), axis=1)
        torso = bn in ('hips', 'spine', 'chest', 'head')
        r = float(np.percentile(d, 80 if torso else 55)) * (0.92 if torso else shrink)
        out.append({'bone': bn, 'to': child, 'radius': round(r, 4)})
    return out
