"""Surfacing: one UV atlas per character + baked textures.

  albedo (sRGB)  hand-painted look: pigment pooling toward hems, fabric grain, trims, motifs, skin tones, irises
  ink    (linear) R = light bias (0.5 neutral; AO + painted occlusion push it down -> forced ink shadow)
                  G = sheen mask (hair band, silk, metal)
                  B = inner ink lines (creases from small-radius AO + painted seams/trims)

Paint recipes are Blender shader graphs (emission) baked with Cycles; per-vertex attributes ('hem', 'hair_t',
'outline'...) and the 'Pat' UV map (pattern coordinates in metres) drive them.
"""
import math
import os

import bpy
import numpy as np

from .core import hex_rgb, srgb_to_linear


# ---------------------------------------------------------------- UV islands (numpy, before objects exist)

def uv_islands(part):
    """Face islands: faces sharing an edge whose endpoints have identical UVs in both faces."""
    parent = list(range(len(part.faces)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    edge = {}
    k = 0
    uv = part.uv
    for fi, f in enumerate(part.faces):
        n = len(f)
        for j in range(n):
            a, b = f[j], f[(j + 1) % n]
            ua, ub = tuple(np.round(uv[k + j], 6)), tuple(np.round(uv[k + (j + 1) % n], 6))
            key = (min(a, b), max(a, b))
            val = (ua, ub) if a < b else (ub, ua)
            if key in edge:
                of, ov = edge[key]
                if ov == val:
                    ra, rb = find(fi), find(of)
                    if ra != rb:
                        parent[ra] = rb
            else:
                edge[key] = (fi, val)
        k += n
    return np.array([find(i) for i in range(len(part.faces))])


def normalize_texel(part, face_texel):
    """Scale every UV island so its UV area matches its 3D area x texel factor (uniform density)."""
    isl = uv_islands(part)
    starts = np.concatenate([[0], np.cumsum([len(f) for f in part.faces])])
    uv = part.uv.copy()
    co = part.co
    for i in np.unique(isl):
        fids = np.where(isl == i)[0]
        a3 = auv = 0.0
        lidx = []
        for fi in fids:
            f = part.faces[fi]
            s = starts[fi]
            for j in range(1, len(f) - 1):
                p0, p1, p2 = co[f[0]], co[f[j]], co[f[j + 1]]
                a3 += 0.5 * np.linalg.norm(np.cross(p1 - p0, p2 - p0))
                u0, u1, u2 = uv[s], uv[s + j], uv[s + j + 1]
                auv += 0.5 * abs((u1[0] - u0[0]) * (u2[1] - u0[1]) - (u2[0] - u0[0]) * (u1[1] - u0[1]))
            lidx.extend(range(s, s + len(f)))
        lidx = np.array(lidx)
        if auv < 1e-14 or a3 < 1e-12:
            uv[lidx] = uv[lidx] * 0 + uv[lidx].mean(0)
            continue
        sc = math.sqrt(a3 / auv) * float(np.mean([face_texel[fi] for fi in fids]))
        c = uv[lidx].mean(0)
        uv[lidx] = c + (uv[lidx] - c) * sc
    part.uv = uv


def pack_atlas(objs, margin=0.003, shape='CONVEX'):
    bpy.ops.object.mode_set(mode='OBJECT') if bpy.context.object and bpy.context.object.mode != 'OBJECT' else None
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
        o.data.uv_layers.active = o.data.uv_layers['UVMap']
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.context.scene.tool_settings.use_uv_select_sync = True
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(udim_source='CLOSEST_UDIM', rotate=True, rotate_method='CARDINAL', scale=True,
                            margin_method='FRACTION', margin=margin, shape_method=shape)
    bpy.ops.object.mode_set(mode='OBJECT')


# ---------------------------------------------------------------- node kit

def lin(hexcol):
    return tuple(srgb_to_linear(c) for c in hex_rgb(hexcol))


class NK:
    """Tiny shader-graph builder (returns output sockets)."""

    def __init__(self, mat):
        mat.use_nodes = True
        self.nt = mat.node_tree
        self.nt.nodes.clear()
        self.x = 0

    def n(self, t, **kw):
        nd = self.nt.nodes.new(t)
        nd.location = (self.x, 0)
        self.x += 160
        for k, v in kw.items():
            setattr(nd, k, v)
        return nd

    def link(self, out, inp):
        self.nt.links.new(out, inp)

    def _in(self, nd, key, v):
        s = nd.inputs[key]
        if isinstance(v, bpy.types.NodeSocket):
            self.link(v, s)
        else:
            s.default_value = v

    def attr(self, name):
        nd = self.n('ShaderNodeAttribute', attribute_name=name)
        return nd.outputs['Fac']

    def uv(self, name='Pat'):
        nd = self.n('ShaderNodeUVMap', uv_map=name)
        return nd.outputs['UV']

    def obj(self):
        return self.n('ShaderNodeTexCoord').outputs['Object']

    def xyz(self, vec):
        nd = self.n('ShaderNodeSeparateXYZ')
        self.link(vec, nd.inputs[0])
        return nd.outputs[0], nd.outputs[1], nd.outputs[2]

    def m(self, op, a, b=0.0, clamp=False):
        nd = self.n('ShaderNodeMath', operation=op, use_clamp=clamp)
        self._in(nd, 0, a)
        self._in(nd, 1, b)
        return nd.outputs[0]

    def ss(self, e0, e1, x):
        """smoothstep(e0, e1, x) (works for e0 > e1 too)."""
        nd = self.n('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP')
        self._in(nd, 'Value', x)
        nd.inputs['From Min'].default_value = e0
        nd.inputs['From Max'].default_value = e1
        nd.inputs['To Min'].default_value = 0.0
        nd.inputs['To Max'].default_value = 1.0
        nd.clamp = True
        return nd.outputs['Result']

    def noise(self, vec, scale, detail=2.0, rough=0.5, w=None):
        nd = self.n('ShaderNodeTexNoise', noise_dimensions='3D')
        if vec is not None:
            self.link(vec, nd.inputs['Vector'])
        nd.inputs['Scale'].default_value = scale
        nd.inputs['Detail'].default_value = detail
        nd.inputs['Roughness'].default_value = rough
        return nd.outputs['Fac']

    def wave(self, vec, scale, dist=0.0, kind='BANDS', direction='X', profile='SIN'):
        nd = self.n('ShaderNodeTexWave', wave_type=kind, bands_direction=direction, wave_profile=profile)
        if vec is not None:
            self.link(vec, nd.inputs['Vector'])
        nd.inputs['Scale'].default_value = scale
        nd.inputs['Distortion'].default_value = dist
        return nd.outputs['Fac']

    def rgb(self, hexcol):
        nd = self.n('ShaderNodeRGB')
        nd.outputs[0].default_value = (*lin(hexcol), 1.0)
        return nd.outputs[0]

    def mix(self, fac, a, b, blend='MIX'):
        nd = self.n('ShaderNodeMix', data_type='RGBA', blend_type=blend, clamp_result=True)
        self._in(nd, 'Factor', fac)
        if isinstance(a, str):
            a = self.rgb(a)
        if isinstance(b, str):
            b = self.rgb(b)
        self._in(nd, 6, a)
        self._in(nd, 7, b)
        return nd.outputs[2]

    def mul_col(self, col, f):
        nd = self.n('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY', clamp_result=True)
        nd.inputs['Factor'].default_value = 1.0
        self._in(nd, 6, col)
        if isinstance(f, (int, float)):
            nd.inputs[7].default_value = (f, f, f, 1)
        else:
            self._in(nd, 7, f)
        return nd.outputs[2]

    def combine(self, r, g, b):
        nd = self.n('ShaderNodeCombineColor')
        for i, v in enumerate((r, g, b)):
            self._in(nd, i, v)
        return nd.outputs[0]

    def emit(self, col):
        em = self.n('ShaderNodeEmission')
        self.link(col, em.inputs['Color'])
        em.inputs['Strength'].default_value = 1.0
        out = self.n('ShaderNodeOutputMaterial')
        self.link(em.outputs[0], out.inputs['Surface'])
        return out


# ---------------------------------------------------------------- recipes
# Each recipe(nk, p) -> (albedo color socket, (light_bias, sheen, line) sockets/values). p: palette dict.

def _grain(nk, amount=0.06, scale=900.0):
    g = nk.noise(nk.obj(), scale, 1.0)
    return nk.m('ADD', nk.m('MULTIPLY', nk.m('SUBTRACT', g, 0.5), amount * 2), 1.0)


def r_cloth(nk, p):
    """Ink-wash dyed cloth: pigment pools darker toward hems/edges, soft blotches, fine grain, hem band."""
    hem = nk.attr('hem')
    base = p['base']
    dark = p.get('dark', base)
    wash = nk.noise(nk.obj(), p.get('wash_scale', 3.0), 3.0, 0.6)
    pool = nk.ss(p.get('pool', 0.10), 0.0, hem)                       # 1 at the hem -> darker
    col = nk.mix(nk.m('ADD', nk.m('MULTIPLY', pool, 0.75), nk.m('MULTIPLY', nk.ss(0.35, 0.75, wash), 0.35)), base, dark)
    if 'band' in p:                                                   # contrasting band near the hem
        w0, w1 = p.get('band_at', (0.012, 0.030))
        band = nk.m('MULTIPLY', nk.ss(w0 - 0.003, w0, hem), nk.ss(w1, w1 - 0.003, hem))
        col = nk.mix(band, col, p['band'])
    if 'inlay' in p:                                                  # painted layering: signed distance attr
        sd = nk.attr(p['inlay'])                                      # (metres, < 0 inside the inlay)
        col = nk.mix(nk.ss(0.0008, -0.0008, sd), col, p['inlay_col'])
        if 'inlay_trim' in p:
            tw = p.get('inlay_trim_w', 0.012)
            trim = nk.m('MULTIPLY', nk.ss(-0.0006, 0.0006, sd), nk.ss(tw + 0.0006, tw - 0.0006, sd))
            col = nk.mix(trim, col, p['inlay_trim'])
    col = nk.mul_col(col, _grain(nk, p.get('grain', 0.05)))
    line = nk.ss(0.004, 0.0015, hem) if p.get('hem_line', True) else 0.0
    if 'inlay' in p:
        line = nk.m('MAXIMUM', line, nk.ss(0.0016, 0.0, nk.m('ABSOLUTE', nk.attr(p['inlay']))))
    return col, (0.5, p.get('sheen', 0.0), line)


def r_flat(nk, p):
    col = nk.mul_col(nk.rgb(p['base']), _grain(nk, p.get('grain', 0.04)))
    return col, (p.get('bias', 0.5), p.get('sheen', 0.0), p.get('line', 0.0))


def r_skin(nk, p):
    co = nk.obj()
    x, y, z = nk.xyz(co)
    col = nk.rgb(p['base'])
    blot = nk.noise(co, 18.0, 2.0)
    col = nk.mix(nk.m('MULTIPLY', nk.ss(0.45, 0.8, blot), 0.25), col, p.get('shade', p['base']))
    for sp in p.get('spots', []):                                     # blush / lips / marks (object coords)
        cx, cz, r, hexc, a = sp[:5]
        sym = sp[5] if len(sp) > 5 else True                         # mirrored on both sides of the face
        ry = sp[6] if len(sp) > 6 else r                             # vertical radius (ellipses)
        xx = nk.m('ABSOLUTE', x) if sym else x
        d = nk.m('SQRT', nk.m('ADD', nk.m('POWER', nk.m('SUBTRACT', xx, cx), 2.0),
                                   nk.m('POWER', nk.m('MULTIPLY', nk.m('SUBTRACT', z, cz), r / ry), 2.0)))
        col = nk.mix(nk.m('MULTIPLY', nk.ss(r, r * 0.35, d), a), col, hexc)
    col = nk.mul_col(col, _grain(nk, 0.03, 1400))
    return col, (0.5, 0.0, 0.0)


def r_mouth(nk, p):
    return nk.rgb(p.get('base', '#4a2420')), (0.15, 0.0, 0.0)


def r_eye(nk, p):
    """Sclera + large stylised iris/pupil + catch-light, from eye-plane coords in 'Pat' (metres)."""
    u, v, _ = nk.xyz(nk.uv('Pat'))
    ox, oy = p.get('iris_offset', (0.0, 0.0006))
    du = nk.m('SUBTRACT', u, ox)
    dv = nk.m('SUBTRACT', v, oy)
    r = nk.m('SQRT', nk.m('ADD', nk.m('MULTIPLY', du, du), nk.m('MULTIPLY', dv, dv)))
    ri = p.get('iris_r', 0.0068)
    col = nk.rgb(p.get('sclera', '#efe8da'))
    col = nk.mix(nk.ss(0.0055, 0.0015, v), col, p.get('lid_shadow', '#b9b0a2'))          # upper-lid shadow
    iris = nk.ss(ri + 0.0004, ri - 0.0002, r)
    grad = nk.mix(nk.ss(ri * 0.2, ri, nk.m('ADD', r, nk.m('MULTIPLY', dv, -0.6))), p.get('iris_lo', '#6b4a2c'),
                  p.get('iris', '#2a1c14'))
    col = nk.mix(iris, col, grad)
    col = nk.mix(nk.ss(ri + 0.0006, ri, r), col, '#14110f') if p.get('ring', True) else col   # limbal ring
    col = nk.mix(nk.ss(ri * 0.42 + 0.0002, ri * 0.42 - 0.0002, r), col, '#0a0908')            # pupil
    hx, hy = p.get('glint', (-0.0022, 0.0026))
    gl = nk.m('SQRT', nk.m('ADD', nk.m('POWER', nk.m('SUBTRACT', u, hx), 2.0), nk.m('POWER', nk.m('SUBTRACT', v, hy), 2.0)))
    col = nk.mix(nk.ss(0.0013, 0.0009, gl), col, '#fbf7ee')
    return col, (0.72, 0.0, 0.0)


def r_hair(nk, p):
    t = nk.attr('hair_t')
    u, v, _ = nk.xyz(nk.uv('Pat'))
    base = p.get('base', '#1b1a18')
    col = nk.mix(nk.ss(0.0, 0.25, t), p.get('root', base), base)
    streak = nk.wave(nk.uv('Pat'), p.get('streak_scale', 40.0), 2.0, 'BANDS', 'X')
    col = nk.mix(nk.m('MULTIPLY', nk.ss(0.6, 1.0, streak), 0.35), col, p.get('streak', '#2c2e33'))
    # sheen band across the locks a third of the way down
    sheen = nk.m('MULTIPLY', nk.ss(0.18, 0.32, t), nk.ss(0.55, 0.38, t))
    sheen = nk.m('MULTIPLY', sheen, nk.ss(0.3, 0.7, nk.noise(nk.obj(), 30.0, 1.0)))
    line = nk.m('MULTIPLY', nk.ss(0.55, 0.95, streak), 0.6)
    return col, (0.5, sheen, line)


def r_wrap(nk, p):
    """Bandage: diagonal overlapping strips with darker edges, undyed linen."""
    co = nk.obj()
    x, y, z = nk.xyz(co)
    s = nk.m('ADD', nk.m('MULTIPLY', z, p.get('pitch', 55.0)), nk.m('MULTIPLY', nk.m('ADD', x, y), p.get('slant', 18.0)))
    band = nk.m('FRACT', s)
    edge = nk.m('MULTIPLY', nk.ss(0.80, 0.97, band), 1.0)
    col = nk.mix(nk.m('MULTIPLY', edge, 0.6), p['base'], p.get('dark', '#7e7563'))
    col = nk.mix(nk.m('MULTIPLY', nk.ss(0.5, 0.9, nk.noise(co, 60.0, 2.0)), 0.25), col, p.get('stain', '#8d826c'))
    col = nk.mul_col(col, _grain(nk, 0.08, 1200))
    return col, (0.5, 0.0, nk.m('MULTIPLY', nk.ss(0.88, 0.98, band), 0.8))


def r_trim(nk, p):
    """Collar/sash bands: base colour with a contrasting stripe along the band (Pat v = across, metres)."""
    u, v, _ = nk.xyz(nk.uv('Pat'))
    col = nk.rgb(p['base'])
    if 'stripe' in p:
        a, b = p.get('stripe_at', (-0.006, 0.006))
        st = nk.m('MULTIPLY', nk.ss(a - 0.001, a, v), nk.ss(b + 0.001, b, v))
        col = nk.mix(st, col, p['stripe'])
    col = nk.mul_col(col, _grain(nk, 0.05))
    return col, (0.5, p.get('sheen', 0.0), 0.0)


def r_kasaya(nk, p):
    """Monk's patchwork robe: staggered rectangular patches (cylindrical coords around the body), each a slightly
    different dye lot, with dark stitched seams that also become ink lines; dark border near the hems."""
    co = nk.obj()
    x, y, z = nk.xyz(co)
    u = nk.m('MULTIPLY', nk.m('ARCTAN2', y, x), 0.20)          # ~metres around the body
    cw, rh = p.get('patch', (0.105, 0.22))
    col = nk.m('FLOOR', nk.m('DIVIDE', u, cw))
    vv = nk.m('ADD', z, nk.m('MULTIPLY', col, rh * 0.5))
    row = nk.m('FLOOR', nk.m('DIVIDE', vv, rh))
    fu = nk.m('FRACT', nk.m('DIVIDE', u, cw))
    fv = nk.m('FRACT', nk.m('DIVIDE', vv, rh))
    du = nk.m('MULTIPLY', nk.m('MINIMUM', fu, nk.m('SUBTRACT', 1.0, fu)), cw)
    dv = nk.m('MULTIPLY', nk.m('MINIMUM', fv, nk.m('SUBTRACT', 1.0, fv)), rh)
    seam = nk.ss(0.0045, 0.0015, nk.m('MINIMUM', du, dv))
    lot = nk.noise(nk.combine(nk.m('MULTIPLY', col, 3.7), nk.m('MULTIPLY', row, 5.3), 0.0), 1.0, 0.0)
    base, dark = p['base'], p.get('dark', p['base'])
    col_c = nk.mix(nk.m('MULTIPLY', nk.ss(0.3, 0.75, lot), 0.45), base, dark)
    wash = nk.noise(co, 3.0, 3.0, 0.6)
    col_c = nk.mix(nk.m('MULTIPLY', nk.ss(0.4, 0.8, wash), 0.25), col_c, dark)
    hem = nk.attr('hem')
    col_c = nk.mix(nk.m('MULTIPLY', nk.ss(p.get('pool', 0.1), 0.0, hem), 0.6), col_c, dark)
    if 'band' in p:
        w0, w1 = p.get('band_at', (0.004, 0.03))
        band = nk.m('MULTIPLY', nk.ss(w0 - 0.002, w0, hem), nk.ss(w1, w1 - 0.002, hem))
        col_c = nk.mix(band, col_c, p['band'])
    col_c = nk.mix(nk.m('MULTIPLY', seam, 0.9), col_c, p.get('seam', '#4a2410'))
    col_c = nk.mul_col(col_c, _grain(nk, 0.06))
    line = nk.m('MAXIMUM', nk.m('MULTIPLY', seam, 0.7), nk.ss(0.004, 0.0015, hem))
    return col_c, (0.5, 0.0, line)


RECIPES = {'cloth': r_cloth, 'flat': r_flat, 'skin': r_skin, 'mouth': r_mouth, 'eye': r_eye, 'hair': r_hair,
           'wrap': r_wrap, 'trim': r_trim, 'kasaya': r_kasaya}


# ---------------------------------------------------------------- bake

def _gpu():
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        for kind in ('OPTIX', 'CUDA'):
            try:
                prefs.compute_device_type = kind
                prefs.get_devices()
                devs = [d for d in prefs.devices if d.type == kind]
                if devs:
                    for d in prefs.devices:
                        d.use = d.type == kind
                    bpy.context.scene.cycles.device = 'GPU'
                    return kind
            except Exception:
                continue
    except Exception:
        pass
    bpy.context.scene.cycles.device = 'CPU'
    return 'CPU'


def _img(name, size, float_buf=False, color='sRGB'):
    im = bpy.data.images.get(name)
    if im:
        bpy.data.images.remove(im)
    im = bpy.data.images.new(name, size, size, alpha=False, float_buffer=float_buf)
    im.colorspace_settings.name = color
    return im


def _target(mat, img):
    nt = mat.node_tree
    nd = nt.nodes.get('_bake') or nt.nodes.new('ShaderNodeTexImage')
    nd.name = '_bake'
    nd.image = img
    nt.nodes.active = nd


def _bake(objs, kind, img, samples, margin=8, use_clear=True):
    sc = bpy.context.scene
    sc.cycles.samples = samples
    for o in objs:
        for m in o.data.materials:
            _target(m, img)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.bake(type=kind, margin=margin, margin_type='EXTEND', use_clear=use_clear)


def _px(img):
    a = np.empty(img.size[0] * img.size[1] * 4, np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)


def _split_loose(objs, is_loose):
    """Temporary copies of objs split into (fixed, loose) faces. A face is loose when most of its vertex weight sits
    on bones is_loose(name) accepts (spring chains): skirt panels, hair locks, beads swing away in game, so they
    must not bake their occlusion onto the cloth beneath."""
    import bmesh
    fixed, loose = [], []
    for o in objs:
        gl = np.array([is_loose(g.name) for g in o.vertex_groups] + [False], bool)
        me = o.data
        wl = np.zeros(len(me.vertices))
        for v in me.vertices:
            for g in v.groups:
                if gl[g.group]:
                    wl[v.index] += g.weight
        # skirts hang loose below their top fifth even where a panel partly follows the thigh
        st = me.attributes.get('skirt_t')
        if st is not None and st.domain == 'POINT':
            t = np.empty(len(me.vertices), np.float32)
            st.data.foreach_get('value', t)
            wl = np.where(t >= 0.2, 1.0, wl)
        fl = np.zeros(len(me.polygons), np.float32)
        for f in me.polygons:
            fl[f.index] = wl[list(f.vertices)].mean()
        for keep, out in ((fl <= 0.5, fixed), (fl > 0.5, loose)):
            if not keep.any():
                continue
            c = o.copy()
            c.data = me.copy()
            c.name = c.data.name = f'_ao_{o.name}_{len(out)}{"L" if out is loose else "F"}'
            for coll in o.users_collection:
                coll.objects.link(c)
            bm = bmesh.new()
            bm.from_mesh(c.data)
            bm.faces.ensure_lookup_table()
            bmesh.ops.delete(bm, geom=[bm.faces[i] for i in np.flatnonzero(~keep)], context='FACES')
            bm.to_mesh(c.data)
            bm.free()
            out.append(c)
    return fixed, loose


def _dilate(px, cov, iters=8):
    """EXTEND-style gutter: uncovered pixels take the mean of covered neighbours, `iters` rings out. Done here rather
    than by Blender's bake margin, which with several objects in one image lets one object's margin paint over
    another object's islands."""
    px = px.copy()
    cov = cov.copy()
    for _ in range(iters):
        if cov.all():
            break
        p = np.pad(px, ((1, 1), (1, 1), (0, 0)))
        c = np.pad(cov, 1).astype(np.float32)
        sl = ((slice(None, -2), slice(1, -1)), (slice(2, None), slice(1, -1)),
              (slice(1, -1), slice(None, -2)), (slice(1, -1), slice(2, None)))
        tot = sum(p[r, q] * c[r, q][..., None] for r, q in sl)
        cnt = sum(c[r, q] for r, q in sl)
        new = ~cov & (cnt > 0)
        px[new] = tot[new] / cnt[new][:, None]
        cov |= new
    return px


def _coverage(objs, size):
    """Pixels inside any UV island: one margin-free white emission bake into a sentinel-filled buffer."""
    for o in objs:
        for m in o.data.materials:
            nk = NK(m)
            nk.emit(nk.rgb('#ffffff'))
    img = _img('_coverage', size, True, 'Non-Color')
    img.pixels.foreach_set(np.full(size * size * 4, -1.0, np.float32))
    _bake(objs, 'EMIT', img, 1, margin=0, use_clear=False)
    cov = _px(img)[..., 0] >= 0
    bpy.data.images.remove(img)
    return cov


def _bake_dilated(objs, kind, img, samples, cov):
    _bake(objs, kind, img, samples, margin=0)
    img.pixels.foreach_set(_dilate(_px(img), cov).astype(np.float32).ravel())


def _bake_split(fixed, loose, img, samples):
    """AO bake where loose faces get full occlusion but are invisible to the fixed faces. Both passes write into a
    sentinel-filled buffer without margin; the gutter is then filled from the union."""
    n = img.size[0] * img.size[1] * 4
    acc = np.full((img.size[1], img.size[0]), -1.0, np.float32)
    for objs, hide in ((fixed, loose), (loose, [])):
        if not objs:
            continue
        for o in hide:
            o.hide_render = True
        img.pixels.foreach_set(np.full(n, -1.0, np.float32))
        _bake(objs, 'AO', img, samples, margin=0, use_clear=False)
        for o in hide:
            o.hide_render = False
        v = _px(img)[..., 0]
        acc = np.where(v >= 0, v, acc)
    acc = _dilate(acc[..., None], acc >= 0)[..., 0]
    acc = np.where(acc < 0, 1.0, acc)
    img.pixels.foreach_set(np.dstack([acc, acc, acc, np.ones_like(acc)]).astype(np.float32).ravel())


def bake_textures(objs, paints, size=2048, ink_size=1024, ao_pose=None, is_loose=None):
    """paints: paint name -> (recipe name, params). is_loose(vertex group name) marks spring-chain bones whose parts
    shouldn't cast baked occlusion. Returns (albedo image, ink image)."""
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    dev = _gpu()
    print('INFO bake device', dev)
    sc.render.bake.margin = 8
    mats = {m.name: m for o in objs for m in o.data.materials}
    cov = _coverage(objs, size)
    cov_ink = _coverage(objs, ink_size)
    # pass 1: albedo + ink recipes (emission)
    ink_parts = {}
    for name, m in mats.items():
        recipe, params = paints.get(name, ('flat', {'base': '#ff00ff'}))
        nk = NK(m)
        col, ink = RECIPES[recipe](nk, params)
        m['_col'] = True
        ink_parts[name] = (nk, col, ink)
        nk.emit(col)
    albedo = _img('albedo', size)
    _bake_dilated(objs, 'EMIT', albedo, 4, cov)
    ink_paint = _img('ink_paint', ink_size, True, 'Non-Color')
    for name, (nk, col, ink) in ink_parts.items():
        m = mats[name]
        nk2 = NK(m)
        r, g, b = ink
        recipe, params = paints.get(name, ('flat', {}))
        _, ink2 = RECIPES[recipe](nk2, params)
        nk2.emit(nk2.combine(*ink2))
    _bake_dilated(objs, 'EMIT', ink_paint, 4, cov_ink)
    # pass 2: ambient occlusion (wide = shadow bias, tight = crease lines), in an arms-out pose
    if ao_pose:
        ao_pose(True)
    ao_w = _img('ao_wide', ink_size, True, 'Non-Color')
    sc.world = sc.world or bpy.data.worlds.new('w')
    sc.world.light_settings.distance = 0.10
    for o in objs:
        for m in o.data.materials:
            nk = NK(m)
            nk.emit(nk.rgb('#ffffff'))
    fixed, loose = _split_loose(objs, is_loose) if is_loose else (objs, [])
    hidden = [o for o in objs if o not in fixed]
    for o in hidden:
        o.hide_render = True
    _bake_split(fixed, loose, ao_w, 48)
    ao_t = _img('ao_tight', ink_size, True, 'Non-Color')
    sc.world.light_settings.distance = 0.014
    _bake_split(fixed, loose, ao_t, 48)
    for o in hidden:
        o.hide_render = False
    for o in fixed + loose:
        if o not in objs:
            me = o.data
            bpy.data.objects.remove(o)
            bpy.data.meshes.remove(me)
    if ao_pose:
        ao_pose(False)
    # combine
    P = _px(ink_paint)
    Aw = _px(ao_w)[..., 0]
    At = _px(ao_t)[..., 0]
    bias = np.clip(P[..., 0] - (1 - Aw) * 0.55, 0, 1)
    # only deep, narrow occlusion becomes an inked crease (layered cloth resting close together must not smudge)
    crease = np.clip((0.45 - At) / 0.25, 0, 1) ** 2 * 0.7
    line = np.clip(np.maximum(P[..., 2], crease), 0, 1)
    out = np.dstack([bias, P[..., 1], line, np.ones_like(bias)])
    ink = _img('ink', ink_size, False, 'Non-Color')
    ink.pixels.foreach_set(out.astype(np.float32).ravel())
    return albedo, ink


def final_material(objs, albedo, ink, name):
    """One glTF material per character: base colour = albedo, emissive slot carries the ink map."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.use_backface_culling = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    ta = nt.nodes.new('ShaderNodeTexImage')
    ta.image = albedo
    ti = nt.nodes.new('ShaderNodeTexImage')
    ti.image = ink
    uvn = nt.nodes.new('ShaderNodeUVMap')
    uvn.uv_map = 'UVMap'
    nt.links.new(uvn.outputs[0], ta.inputs[0])
    nt.links.new(uvn.outputs[0], ti.inputs[0])
    nt.links.new(ta.outputs['Color'], bsdf.inputs['Base Color'])
    nt.links.new(ti.outputs['Color'], bsdf.inputs['Emission Color'])
    bsdf.inputs['Emission Strength'].default_value = 1.0
    bsdf.inputs['Roughness'].default_value = 0.9
    nt.links.new(bsdf.outputs[0], out.inputs['Surface'])
    for o in objs:
        o.data.materials.clear()
        o.data.materials.append(m)
        o.data.polygons.foreach_set('material_index', np.zeros(len(o.data.polygons), np.int32))
    return m


def save_image(img, path, fmt='PNG'):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.filepath_raw = path
    img.file_format = fmt
    img.save()


def shelf_pack(parts, margin_frac=0.003):
    """Pack the UV islands of several merged Parts into one [0,1] atlas (deterministic shelf packer).

    Islands are rotated landscape, sorted by height and placed in rows; the row width is binary-searched so the
    result is roughly square. UV scale between islands is preserved (uniform texel density)."""
    items = []  # (part, loop index array, w, h, rotated)
    for p in parts:
        isl = uv_islands(p)
        starts = np.concatenate([[0], np.cumsum([len(f) for f in p.faces])])
        groups = {}
        for fi, i in enumerate(isl):
            groups.setdefault(i, []).extend(range(starts[fi], starts[fi + 1]))
        for li in groups.values():
            li = np.array(li)
            uv = p.uv[li]
            lo, hi = uv.min(0), uv.max(0)
            w, h = hi - lo
            rot = h > w
            p.uv[li] = uv - lo if not rot else np.stack([uv[:, 1] - lo[1], hi[0] - uv[:, 0]], 1)
            items.append((p, li, max(w, h), min(w, h)))
    area = sum(w * h for _, _, w, h in items)
    side0 = math.sqrt(area)
    order = sorted(range(len(items)), key=lambda i: -items[i][3])

    def place(width, m):
        x = y = row_h = 0.0
        pos = {}
        for i in order:
            w, h = items[i][2] + m, items[i][3] + m
            if x + w > width and x > 0:
                y += row_h
                x = row_h = 0.0
            pos[i] = (x, y)
            x += w
            row_h = max(row_h, h)
        return pos, y + row_h

    lo, hi = side0, side0 * 2.5
    best = None
    for _ in range(30):
        mid = 0.5 * (lo + hi)
        m = margin_frac * mid
        pos, height = place(mid, m)
        if height <= mid:
            best = (pos, mid, m)
            hi = mid
        else:
            lo = mid
    pos, side, m = best
    for i, (p, li, w, h) in enumerate(items):
        x, y = pos[i]
        p.uv[li] = (p.uv[li] + np.array([x + m * 0.5, y + m * 0.5])) / side
    used = area / (side * side)
    print(f'INFO atlas: {len(items)} islands, {used * 100:.0f}% filled')
