"""Turn Parts into skinned Blender mesh objects (one per output group)."""
import bpy
import numpy as np

from . import skin
from .core import material
from .part import merge_parts, orient_outward


def resolve_weights(parts, body_co, body_tris, names, W_body):
    """Fill part.weights: copy via src for body-derived verts, transfer from the body surface otherwise.
    Parts flagged `torso_only` (sashes, collars, knots, pouches) sample only the torso, never a hand hanging
    beside the waist in the A-pose."""
    sampler = None
    torso_sampler = None
    for p in parts:
        if p.weights is not None:
            # align explicit weights to the global name list
            pn, pw = p.weights
            if list(pn) != list(names):
                full = np.zeros((p.nv, len(names)))
                idx = {n: i for i, n in enumerate(names)}
                for j, n in enumerate(pn):
                    if n not in idx:
                        raise KeyError(f'part {p.name}: unknown bone {n}')
                    full[:, idx[n]] += pw[:, j]
                p.weights = (list(names), full)
            continue
        Wp = np.zeros((p.nv, len(names)))
        need = np.ones(p.nv, bool)
        if p.src is not None:
            src = np.asarray(p.src)
            ok = src >= 0
            Wp[ok] = W_body[src[ok]]
            need = ~ok
        if need.any():
            if getattr(p, 'torso_only', False):
                if torso_sampler is None:
                    limb = np.zeros(len(body_co))
                    for j, n in enumerate(names):
                        if n.split('_')[0] in ('upper', 'forearm', 'hand', 'thumb', 'index', 'middle', 'ring', 'pinky'):
                            limb += W_body[:, j]
                    keep = np.array([limb[list(t)].max() < 0.2 for t in body_tris])
                    torso_sampler = skin.SurfaceSampler(body_co, body_tris[keep])
                vals, _ = torso_sampler.interpolate(W_body, p.co[need])
            else:
                if sampler is None:
                    sampler = skin.SurfaceSampler(body_co, body_tris)
                vals, _ = sampler.interpolate(W_body, p.co[need])
            Wp[need] = vals
        p.weights = (list(names), Wp)


def hem_distance(p):
    """Geodesic distance (metres) from each vertex to the part's open boundary (1.0 if closed)."""
    import heapq
    from .garment import boundary_loops
    loops = boundary_loops(p.faces)
    dist = np.full(p.nv, 1.0)
    if not loops:
        return dist
    adj = [set() for _ in range(p.nv)]
    for f in p.faces:
        for k in range(len(f)):
            a, b = f[k], f[(k + 1) % len(f)]
            adj[a].add(b)
            adj[b].add(a)
    h = []
    for L in loops:
        for v in L:
            dist[v] = 0.0
            h.append((0.0, v))
    heapq.heapify(h)
    while h:
        d, v = heapq.heappop(h)
        if d > dist[v]:
            continue
        for w in adj[v]:
            nd = d + float(np.linalg.norm(p.co[v] - p.co[w]))
            if nd < dist[w] and nd < 1.0:
                dist[w] = nd
                heapq.heappush(h, (nd, w))
    return dist


def _check(p):
    """Report degenerate / duplicate faces (Blender would silently 'fix' them, shifting per-face data)."""
    rep = sum(1 for f in p.faces if len(set(f)) < len(f))
    seen = set()
    dup = 0
    for f in p.faces:
        k = tuple(sorted(f))
        dup += k in seen
        seen.add(k)
    if rep or dup:
        print(f'WARN part {p.name}: {rep} faces with repeated verts, {dup} duplicate faces')


def build_objects(char_id, parts, arm, names, colors, groups=('body', 'head', 'hair')):
    """Merge parts per group -> mesh objects parented to the armature. colors: paint name -> hex (preview)."""
    from .paint import normalize_texel, shelf_pack
    objs = {}
    for p in parts:
        if 'hem' not in p.attrs:
            p.attrs['hem'] = hem_distance(p)
        _check(p)
    merged = {}
    for g in groups:
        gp = [orient_outward(p) for p in parts if p.group == g]
        if not gp:
            continue
        m = merge_parts(gp, f'{char_id}_{g}', group=g)
        face_texel = np.concatenate([np.full(len(p.faces), p.texel) for p in gp])
        normalize_texel(m, face_texel)
        merged[g] = (m, gp)
    shelf_pack([m for m, _ in merged.values()])
    for g, (m, gp) in merged.items():
        objs[g] = mesh_object(m, arm, names, colors)
        objs[g]['part_names'] = [p.name for p in gp]
    return objs


def mesh_object(m, arm, names, colors):
    me = bpy.data.meshes.new(m.name)
    me.from_pydata([tuple(map(float, v)) for v in m.co], [], m.faces)
    me.update()
    if m.uv is not None:
        uvl = me.uv_layers.new(name='UVMap')
        uvl.data.foreach_set('uv', np.asarray(m.uv, np.float32).ravel())
    if m.pat is not None:
        pl = me.uv_layers.new(name='Pat')
        pl.data.foreach_set('uv', np.asarray(m.pat, np.float32).ravel())
    paints = sorted(set(m.face_paint), key=m.face_paint.index)
    for pn in paints:
        me.materials.append(material(pn, colors.get(pn, '#cccccc')))
    pidx = {pn: i for i, pn in enumerate(paints)}
    mi = np.array([pidx[pn] for pn in m.face_paint], np.int32)
    me.polygons.foreach_set('material_index', mi)
    me.polygons.foreach_set('use_smooth', np.ones(len(me.polygons), bool))
    for k, v in m.attrs.items():
        a = me.attributes.new(k, 'FLOAT', 'POINT')
        a.data.foreach_set('value', np.asarray(v, np.float32))
    a = me.attributes.new('outline', 'FLOAT', 'POINT')
    a.data.foreach_set('value', np.asarray(m.outline, np.float32))
    obj = bpy.data.objects.new(m.name, me)
    bpy.context.scene.collection.objects.link(obj)
    if m.weights is not None:
        skin.write_weights(obj, names, m.weights[1] if isinstance(m.weights, tuple) else m.weights)
    obj.parent = arm
    mod = obj.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm
    if m.keys:
        obj.shape_key_add(name='Basis', from_mix=False)
        for kn, delta in m.keys.items():
            sk = obj.shape_key_add(name=kn, from_mix=False)
            sk.data.foreach_set('co', (m.co + delta).astype(np.float32).ravel())
            sk.value = 0.0
        print('INFO shape keys', obj.name, [(k.name, k.value, k.relative_key.name) for k in obj.data.shape_keys.key_blocks])
    return obj
