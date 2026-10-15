"""Render UI art in Blender: character portraits (Freestyle ink + toon + numpy watercolour), the OG/X share card,
favicon, and the giant ink palm used by the Iron Monk's Secret Art.

Usage: blender -b --factory-startup -P blender/render_art.py -- [portraits] [og] [icon] [palm]
"""
import importlib
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rig import core, pose  # noqa: E402

OUT_UI = os.path.join(core.REPO, 'game', 'public', 'assets', 'ui')
OUT_ROOT = os.path.join(core.REPO, 'game', 'public')
FONT_BRUSH = os.path.join(core.BLENDER_DIR, 'fonts', 'NanumBrushScript-Regular.ttf')
FONT_HAN = 'C:/Windows/Fonts/malgunbd.ttf'
PAPER = (0.910, 0.863, 0.769)
INK = (0.106, 0.102, 0.090)
CRIMSON = (0.639, 0.149, 0.165)

CHAR_POSES = {
    # character id -> (anim module attr or clip:frame, camera yaw degrees, light side)
    'mujin': ('clip:focus_release:7', -42),
    'seolhwa': ('clip:intro:8', -40),   # salute, feet together: static renders have no spring-driven skirt
    'hyeongong': ('clip:h:19', -34),
}


def lin(c):
    return tuple(core.srgb_to_linear(x) for x in c)


# ---------------------------------------------------------------- scene setup

def setup_render(w, h, transparent=True, freestyle=True, line_px=2.6):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x = w
    sc.render.resolution_y = h
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = transparent
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    try:
        sc.eevee.taa_render_samples = 32
    except Exception:
        pass
    sc.render.use_freestyle = freestyle
    if freestyle:
        sc.render.line_thickness_mode = 'ABSOLUTE'
        sc.render.line_thickness = line_px
        vl = bpy.context.view_layer
        vl.use_freestyle = True
        fs = vl.freestyle_settings
        fs.crease_angle = math.radians(120)
        ls = fs.linesets[0] if fs.linesets else fs.linesets.new('ink')
        ls.select_by_visibility = True
        ls.select_by_edge_types = True
        ls.select_silhouette = True
        ls.select_border = True
        ls.select_crease = True
        ls.select_contour = True
        ls.select_external_contour = True
        if ls.linestyle is None:
            ls.linestyle = bpy.data.linestyles.new('ink')
        lstyle = ls.linestyle
        lstyle.color = lin(INK)
        lstyle.thickness = line_px
        lstyle.thickness_position = 'CENTER'
        lstyle.caps = 'ROUND'
        try:
            m = lstyle.thickness_modifiers.new('along', 'ALONG_STROKE')
            m.mapping = 'CURVE'
            m.value_min = 0.3
            m.value_max = 1.6
            m.blend = 'MULTIPLY'
            curve = m.curve
            pts = curve.curves[0].points
            pts[0].location = (0.0, 0.15)
            pts[1].location = (1.0, 0.25)
            pts.new(0.35, 1.0)
            pts.new(0.7, 0.8)
            curve.update()
            g = lstyle.geometry_modifiers.new('wobble', 'PERLIN_NOISE_1D')
            g.frequency = 8.0
            g.amplitude = 1.4
            g.octaves = 2
        except Exception as e:  # noqa: BLE001
            print('WARN freestyle modifiers', e)
    world = bpy.data.worlds.new('w')
    sc.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    if bg:
        bg.inputs[0].default_value = (*lin(PAPER), 1)
        bg.inputs[1].default_value = 0.6
    return sc


def _toon_textured(m, albedo, ink):
    """Same look as the game's ink material: albedo x 3-step ramp (shifted by the ink map's light bias), inner
    ink lines from the ink map's blue channel."""
    nt = m.node_tree
    nt.nodes.clear()
    L = nt.links.new
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    uv = nt.nodes.new('ShaderNodeUVMap')
    uv.uv_map = 'UVMap'
    ta = nt.nodes.new('ShaderNodeTexImage')
    ta.image = albedo
    ti = nt.nodes.new('ShaderNodeTexImage')
    ti.image = ink
    ink.colorspace_settings.name = 'Non-Color'
    L(uv.outputs[0], ta.inputs[0])
    L(uv.outputs[0], ti.inputs[0])
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    L(ti.outputs['Color'], sep.inputs[0])
    diff = nt.nodes.new('ShaderNodeBsdfDiffuse')
    diff.inputs['Color'].default_value = (1, 1, 1, 1)
    s2r = nt.nodes.new('ShaderNodeShaderToRGB')
    L(diff.outputs[0], s2r.inputs[0])
    bias = nt.nodes.new('ShaderNodeMath')
    bias.operation = 'MULTIPLY_ADD'      # (r - 0.5) * 0.9 + light
    sub = nt.nodes.new('ShaderNodeMath')
    sub.operation = 'SUBTRACT'
    L(sep.outputs[0], sub.inputs[0])
    sub.inputs[1].default_value = 0.5
    L(sub.outputs[0], bias.inputs[0])
    bias.inputs[1].default_value = 0.9
    L(s2r.outputs['Alpha'], bias.inputs[2])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'CONSTANT'
    els = ramp.color_ramp.elements
    els[0].position = 0.0
    els[0].color = (0.42, 0.42, 0.42, 1)
    els[1].position = 0.18
    els[1].color = (0.72, 0.72, 0.72, 1)
    e3 = els.new(0.45)
    e3.color = (0.96, 0.96, 0.96, 1)
    L(bias.outputs[0], ramp.inputs[0])
    mul = nt.nodes.new('ShaderNodeMix')
    mul.data_type = 'RGBA'
    mul.blend_type = 'MULTIPLY'
    mul.inputs['Factor'].default_value = 1.0
    L(ta.outputs['Color'], mul.inputs[6])
    L(ramp.outputs[0], mul.inputs[7])
    line = nt.nodes.new('ShaderNodeMix')
    line.data_type = 'RGBA'
    f = nt.nodes.new('ShaderNodeMath')
    f.operation = 'MULTIPLY'
    L(sep.outputs[2], f.inputs[0])
    f.inputs[1].default_value = 0.85
    L(f.outputs[0], line.inputs['Factor'])
    L(mul.outputs[2], line.inputs[6])
    line.inputs[7].default_value = (*lin(INK), 1)
    emis = nt.nodes.new('ShaderNodeEmission')
    L(line.outputs[2], emis.inputs[0])
    L(emis.outputs[0], out.inputs[0])


def toonify_materials():
    """Replace every material with a 3-step toon shader (EEVEE: Shader to RGB) driven by its baked atlas when the
    character has one, else by its base colour."""
    for m in bpy.data.materials:
        if not m.node_tree:
            continue
        imgs = [n.image for n in m.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image]
        albedo = next((i for i in imgs if i.name.endswith('_albedo')), None)
        ink = next((i for i in imgs if i.name.endswith('_ink')), None)
        if albedo is not None and ink is not None:
            _toon_textured(m, albedo, ink)
            continue
        base = m.diffuse_color[:3]
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        diff = nt.nodes.new('ShaderNodeBsdfDiffuse')
        diff.inputs['Color'].default_value = (1, 1, 1, 1)
        s2r = nt.nodes.new('ShaderNodeShaderToRGB')
        ramp = nt.nodes.new('ShaderNodeValToRGB')
        ramp.color_ramp.interpolation = 'CONSTANT'
        els = ramp.color_ramp.elements
        els[0].position = 0.0
        els[0].color = (0.42, 0.42, 0.42, 1)
        els[1].position = 0.18
        els[1].color = (0.72, 0.72, 0.72, 1)
        e3 = els.new(0.45)
        e3.color = (0.96, 0.96, 0.96, 1)
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        mix.blend_type = 'MULTIPLY'
        mix.inputs['Factor'].default_value = 1.0
        mix.inputs[6].default_value = (*base, 1)
        emis = nt.nodes.new('ShaderNodeEmission')
        nt.links.new(diff.outputs[0], s2r.inputs[0])
        nt.links.new(s2r.outputs[0], ramp.inputs[0])
        nt.links.new(ramp.outputs[0], mix.inputs[7])
        nt.links.new(mix.outputs[2], emis.inputs[0])
        nt.links.new(emis.outputs[0], out.inputs[0])


def add_sun(direction=(-0.6, -0.9, -0.5), strength=3.5):
    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = strength
    o = bpy.data.objects.new('sun', sun)
    bpy.context.scene.collection.objects.link(o)
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = Vector(direction).normalized().to_track_quat('-Z', 'Y')
    return o


def add_camera(loc, target, lens=50, ortho=None):
    cd = bpy.data.cameras.new('cam')
    cd.lens = lens
    if ortho:
        cd.type = 'ORTHO'
        cd.ortho_scale = ortho
    cam = bpy.data.objects.new('cam', cd)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = loc
    cam.rotation_mode = 'QUATERNION'
    cam.rotation_quaternion = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y')
    bpy.context.scene.camera = cam
    return cam


def render_to(path):
    bpy.context.scene.render.filepath = path
    bpy.context.scene.render.image_settings.file_format = 'PNG'
    bpy.context.scene.render.image_settings.color_mode = 'RGBA'
    bpy.ops.render.render(write_still=True)
    return path


# ---------------------------------------------------------------- numpy image helpers

def load_px(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(h, w, 4)


def save_px(px, path, fmt='WEBP', quality=88):
    h, w = px.shape[:2]
    img = bpy.data.images.new('out', w, h, alpha=True)
    img.pixels.foreach_set(np.clip(px, 0, 1).astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = fmt
    sc = bpy.context.scene
    sc.render.image_settings.quality = quality
    img.save()
    bpy.data.images.remove(img)


def blur(a, r):
    if r <= 0:
        return a
    k = int(r)
    out = a.copy()
    for axis in (0, 1):
        acc = np.zeros_like(out)
        for d in range(-k, k + 1):
            acc += np.roll(out, d, axis=axis)
        out = acc / (2 * k + 1)
    return out


def noise(h, w, scale, seed):
    rng = np.random.default_rng(seed)
    small = rng.random((max(2, h // scale + 2), max(2, w // scale + 2))).astype(np.float32)
    ys = np.linspace(0, small.shape[0] - 1.001, h)
    xs = np.linspace(0, small.shape[1] - 1.001, w)
    y0 = ys.astype(int)
    x0 = xs.astype(int)
    fy = (ys - y0)[:, None]
    fx = (xs - x0)[None, :]
    a = small[y0][:, x0]
    b = small[y0][:, x0 + 1]
    c = small[y0 + 1][:, x0]
    d = small[y0 + 1][:, x0 + 1]
    fy = fy * fy * (3 - 2 * fy)
    fx = fx * fx * (3 - 2 * fx)
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def watercolour(px, seed=1, strength=1.0):
    """Pigment-pooling edges, granulation, slight colour bleed, paper grain. Keeps alpha."""
    h, w = px.shape[:2]
    rgb = px[..., :3].copy()
    a = px[..., 3:4]
    lum = rgb.mean(axis=2, keepdims=True)
    lb = blur(lum, 3)
    edge = np.clip((lb - lum) * 3.0, 0, 1)
    rgb *= 1 - edge * 0.35 * strength
    g = noise(h, w, 3, seed) * 0.6 + noise(h, w, 9, seed + 1) * 0.4
    dark = np.clip(1.2 - lum * 1.4, 0, 1)
    rgb *= 1 - (g[..., None] - 0.5) * 0.22 * dark * strength
    wash = noise(h, w, 40, seed + 2)
    rgb *= (0.94 + 0.1 * wash[..., None])
    bleed = blur(rgb * a, 2) / np.maximum(blur(a, 2), 1e-3)
    rgb = rgb * 0.75 + bleed * 0.25
    # soft wet edge on alpha
    a2 = np.clip(blur(a, 1) * 1.15, 0, 1)
    a2 *= (0.9 + 0.1 * noise(h, w, 2, seed + 3)[..., None])
    a2 = np.maximum(a2, a * 0.97)
    return np.concatenate([np.clip(rgb, 0, 1), a2], axis=2)


def brush_stroke_bg(h, w, color, seed, cx=0.5, cy=0.55, rx=0.42, ry=0.30, alpha=0.85):
    """A big wet ink blot / wash behind a character."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    nx = (xx / w - cx) / rx
    ny = ((1.0 - yy / h) - cy) / ry  # Blender pixel rows are bottom-up; cy is measured from the top
    d = np.sqrt(nx * nx + ny * ny)
    n = noise(h, w, 24, seed) * 0.5 + noise(h, w, 7, seed + 5) * 0.25
    m = np.clip((1.05 - d - n * 0.6) * 4, 0, 1)
    gran = noise(h, w, 2, seed + 9)
    m *= (0.8 + 0.2 * gran)
    out = np.zeros((h, w, 4), dtype=np.float32)
    out[..., :3] = color
    out[..., 3] = m * alpha
    return out


def over(dst, src):
    a = src[..., 3:4]
    out = dst.copy()
    out[..., :3] = src[..., :3] * a + dst[..., :3] * (1 - a)
    out[..., 3:4] = a + dst[..., 3:4] * (1 - a)
    return out


# ---------------------------------------------------------------- character helpers

def build_char(cid):
    cmod = importlib.import_module(f'rig.chars.{cid}')
    amod = importlib.import_module(f'rig.anims.{cid}')
    arm, mesh, chains = cmod.build()
    sk = pose.Skeleton(arm)
    sk.set_legacy(getattr(cmod, 'LEGACY', None))
    return cmod, amod, arm, mesh, sk


def pose_char(amod, arm, sk, spec):
    grips = getattr(amod, 'GRIP_DEFAULT', ('relaxed', 'relaxed'))
    if spec.startswith('clip:'):
        _, name, f = spec.split(':')
        c = amod.clips()[name]
        p = pose.sample(c['keys'], int(f))
        grips = getattr(amod, 'GRIP_CLIPS', {}).get(name, grips)
    else:
        p = getattr(amod, spec)
    pose.apply_pose(arm, sk, pose.with_grips(p, *grips))
    bpy.context.view_layer.update()


ONLY = [a for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []) if a.startswith('char=')]


def portraits():
    os.makedirs(OUT_UI, exist_ok=True)
    tmp = os.path.join(core.PREVIEW_DIR, '_portrait.png')
    only = [a.split('=')[1] for a in ONLY]
    for cid, (spec, yaw) in CHAR_POSES.items():
        if only and cid not in only:
            continue
        if not os.path.exists(os.path.join(core.BLENDER_DIR, 'rig', 'chars', f'{cid}.py')):
            print('SKIP portrait', cid)
            continue
        core.reset_scene()
        cmod, amod, arm, mesh, sk = build_char(cid)
        pose_char(amod, arm, sk, spec)
        toonify_materials()
        setup_render(768, 1024, transparent=True, line_px=2.4)
        add_sun((-0.5, 0.8, -0.6), 3.2)
        H = getattr(cmod, 'H', 1.8)
        tgt = Vector((0, -0.2, H * 0.52))
        r = 3.7 * H / 1.8
        a = math.radians(yaw)
        loc = Vector((math.sin(a) * r * -1, -math.cos(a) * r, H * 0.62))
        loc = Vector((-abs(loc.x), loc.y, loc.z))
        add_camera(loc, tgt, lens=58)
        render_to(tmp)
        px = load_px(tmp)
        px = watercolour(px, seed=sum(map(ord, cid)) % 97)
        h, w = px.shape[:2]
        bg = brush_stroke_bg(h, w, (0.165, 0.157, 0.141), seed=7 + len(cid), cy=0.55, rx=0.46, ry=0.36, alpha=0.2)
        red = brush_stroke_bg(h, w, CRIMSON, seed=3 + len(cid), cx=0.66, cy=0.2, rx=0.22, ry=0.16, alpha=0.8)
        comp = over(over(np.zeros_like(px), red), bg)
        comp = over(comp, px)
        save_px(comp, os.path.join(OUT_UI, f'portrait_{cid}.webp'))
        print('PORTRAIT', cid)


# ---------------------------------------------------------------- text helpers

def text_obj(body, font_path, size, loc, color, align='LEFT', extrude=0.0, rot=0.0):
    cu = bpy.data.curves.new('t', 'FONT')
    cu.body = body
    try:
        cu.font = bpy.data.fonts.load(font_path, check_existing=True)
    except Exception as e:  # noqa: BLE001
        print('WARN font', font_path, e)
    cu.size = size
    cu.align_x = align
    cu.extrude = extrude
    o = bpy.data.objects.new('t', cu)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = (math.radians(90), 0, rot)
    m = bpy.data.materials.new('txt')
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs[0].default_value = (*lin(color), 1)
    nt.links.new(em.outputs[0], out.inputs[0])
    cu.materials.append(m)
    return o


def og_card():
    """1200x630 share card: three fighters, ink wash, title."""
    tmp = os.path.join(core.PREVIEW_DIR, '_og.png')
    core.reset_scene()
    placed = []
    lineup = [('hyeongong', 'clip:h:19', -1.05, 0.0), ('mujin', 'clip:focus_release:7', 0.35, 0.3), ('seolhwa', 'clip:intro:8', 1.7, 0.0)]
    for cid, spec, x, y in lineup:
        if not os.path.exists(os.path.join(core.BLENDER_DIR, 'rig', 'chars', f'{cid}.py')):
            continue
        cmod, amod, arm, mesh, sk = build_char(cid)
        pose_char(amod, arm, sk, spec)
        arm.location = (x, y, 0)
        arm.rotation_euler = (0, 0, math.radians({'hyeongong': 48, 'mujin': 72, 'seolhwa': -64}[cid]))
        placed.append(cid)
    toonify_materials()
    setup_render(1200, 630, transparent=True, line_px=2.0)
    add_sun((-0.4, 0.9, -0.6), 3.2)
    add_camera(Vector((-0.9, -6.9, 1.25)), Vector((-0.9, 0, 0.95)), lens=42)
    render_to(tmp)
    figs = watercolour(load_px(tmp), seed=5)
    h, w = figs.shape[:2]
    # background: stage sky + far mountains if available, else paper
    bgp = np.zeros((h, w, 4), dtype=np.float32)
    bgp[..., :3] = PAPER
    bgp[..., 3] = 1
    stage_dir = os.path.join(core.REPO, 'game', 'public', 'assets', 'stage', 'cloudpeak')
    for layer, yoff, sc in (('sky.webp', 0.0, 1.0), ('far.webp', 0.25, 1.0), ('mid.webp', 0.42, 1.0)):
        p = os.path.join(stage_dir, layer)
        if os.path.exists(p):
            src = load_px(p)
            sh, sw = src.shape[:2]
            ys = (np.linspace(0, 1, h) * (sh - 1) * (1 - yoff * 0.5) + yoff * 0.5 * (sh - 1)).astype(int)
            xs = (np.linspace(0.0, 0.55, w) * (sw - 1)).astype(int)
            bgp = over(bgp, src[ys][:, xs])
    left = brush_stroke_bg(h, w, PAPER, seed=4, cx=0.14, cy=0.5, rx=0.46, ry=0.9, alpha=0.82)
    bgp = over(bgp, brush_stroke_bg(h, w, CRIMSON, seed=21, cx=0.9, cy=0.16, rx=0.06, ry=0.115, alpha=0.85))
    comp = over(over(bgp, left), figs)
    save_px(comp, os.path.join(core.PREVIEW_DIR, '_og_base.png'), fmt='PNG')
    # title text rendered by Blender over the composite
    core.reset_scene()
    setup_render(1200, 630, transparent=True, freestyle=False)
    add_camera(Vector((0, -10, 0)), Vector((0, 0, 0)), ortho=12.0)
    text_obj('INKFIST', FONT_BRUSH, 1.85, (-5.55, 0, 0.55), INK)
    text_obj('묵권   Murim Duels', FONT_BRUSH, 0.78, (-5.45, 0, -0.35), CRIMSON)
    text_obj('Freestyle martial arts', FONT_BRUSH, 0.56, (-5.45, 0, -1.55), (0.23, 0.215, 0.19))
    text_obj('Free in your browser', FONT_BRUSH, 0.56, (-5.45, 0, -2.15), (0.23, 0.215, 0.19))
    seal = bpy.data.meshes.new('seal')
    seal.from_pydata([(-0.55, 0, -0.55), (0.55, 0, -0.55), (0.55, 0, 0.55), (-0.55, 0, 0.55)], [], [(0, 1, 2, 3)])
    so = bpy.data.objects.new('seal', seal)
    bpy.context.scene.collection.objects.link(so)
    so.location = (-1.85, 0.1, 2.15)
    sm = bpy.data.materials.new('seal')
    sm.use_nodes = True
    sm.node_tree.nodes.clear()
    o_ = sm.node_tree.nodes.new('ShaderNodeOutputMaterial')
    e_ = sm.node_tree.nodes.new('ShaderNodeEmission')
    e_.inputs[0].default_value = (*lin(CRIMSON), 1)
    sm.node_tree.links.new(e_.outputs[0], o_.inputs[0])
    seal.materials.append(sm)
    text_obj('墨拳', FONT_HAN, 0.42, (-1.85, 0, 1.98), PAPER, align='CENTER')
    tmp2 = os.path.join(core.PREVIEW_DIR, '_og_text.png')
    render_to(tmp2)
    base = load_px(os.path.join(core.PREVIEW_DIR, '_og_base.png'))
    txt = load_px(tmp2)
    final = over(base, watercolour(txt, seed=8, strength=0.6))
    final[..., 3] = 1
    save_px(final, os.path.join(OUT_ROOT, 'og.jpg'), fmt='JPEG', quality=90)
    save_px(final, os.path.join(core.PREVIEW_DIR, 'og_preview.png'), fmt='PNG')
    print('OG', placed)


def icon(size=256, out_name='icon.png', extra_sizes=()):
    core.reset_scene()
    setup_render(size, size, transparent=True, freestyle=False)
    add_camera(Vector((0, -10, 0)), Vector((0, 0, 0)), ortho=2.4)
    seal = bpy.data.meshes.new('seal')
    seal.from_pydata([(-1, 0, -1), (1, 0, -1), (1, 0, 1), (-1, 0, 1)], [], [(0, 1, 2, 3)])
    so = bpy.data.objects.new('seal', seal)
    bpy.context.scene.collection.objects.link(so)
    sm = bpy.data.materials.new('seal')
    sm.use_nodes = True
    sm.node_tree.nodes.clear()
    o_ = sm.node_tree.nodes.new('ShaderNodeOutputMaterial')
    e_ = sm.node_tree.nodes.new('ShaderNodeEmission')
    e_.inputs[0].default_value = (*lin(CRIMSON), 1)
    sm.node_tree.links.new(e_.outputs[0], o_.inputs[0])
    seal.materials.append(sm)
    text_obj('墨', FONT_HAN, 1.55, (0, -0.1, -0.55), PAPER, align='CENTER')
    tmp = os.path.join(core.PREVIEW_DIR, '_icon.png')
    render_to(tmp)
    px = watercolour(load_px(tmp), seed=3, strength=0.8)
    h, w = px.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    rr = np.maximum(np.abs(xx / w - 0.5), np.abs(yy / h - 0.5))
    edge = np.clip((0.5 - rr) * 30 + (noise(h, w, 6, 2) - 0.5) * 2.5, 0, 1)
    px[..., 3] *= edge
    save_px(px, os.path.join(OUT_ROOT, out_name), fmt='PNG')
    for sz, nm in extra_sizes:
        img = bpy.data.images.load(os.path.join(OUT_ROOT, out_name))
        img.scale(sz, sz)
        img.filepath_raw = os.path.join(OUT_ROOT, nm)
        img.file_format = 'PNG'
        img.save()
        bpy.data.images.remove(img)
    print('ICON', out_name, [n for _, n in extra_sizes])


def palm():
    """A giant ink palm (fingers up, palm facing camera) for the Tathagata Palm."""
    core.reset_scene()
    from rig.core import MeshBuilder, material, ellipsoid
    from rig.parts import limb
    mats = {'ink': material('ink', '#1b1a17')}
    mb = MeshBuilder()
    mb.add(ellipsoid((0, 0, 0), 0.62, 0.16, 0.7, segs=20, rings=14), 'ink', 'x')
    fingers = [(-0.44, 0.55, 0.92, 0.13, -0.28), (-0.15, 0.66, 1.10, 0.14, -0.08), (0.15, 0.66, 1.16, 0.14, 0.08), (0.43, 0.56, 0.98, 0.13, 0.26)]
    for fx, base_z, length, r, spread in fingers:
        tip = (fx + spread * length, 0, base_z + length * 0.85)
        mb.add(limb((fx, 0, base_z - 0.1), tip, [r, r * 0.95, r * 0.88, r * 0.7], segs=12), 'ink', 'x')
        mb.add(ellipsoid(tip, r * 0.7, r * 0.6, r * 0.7), 'ink', 'x')
    mb.add(limb((-0.55, 0, -0.1), (-1.05, 0, 0.55), [0.18, 0.17, 0.15, 0.12], segs=12), 'ink', 'x')
    mb.add(limb((0, 0, -0.6), (0, 0, -1.6), [0.45, 0.42, 0.40], segs=14), 'ink', 'x')
    me = bpy.data.meshes.new('palm')
    me.from_pydata([tuple(v) for v in mb.verts], [], mb.faces)
    me.materials.append(mats['ink'])
    o = bpy.data.objects.new('palm', me)
    bpy.context.scene.collection.objects.link(o)
    toonify_materials()
    setup_render(640, 900, transparent=True, line_px=5.0)
    add_sun((0.2, 0.8, -0.5), 3)
    add_camera(Vector((0, -9, 0.2)), Vector((0, 0, 0.2)), ortho=4.2)
    tmp = os.path.join(core.PREVIEW_DIR, '_palm.png')
    render_to(tmp)
    px = load_px(tmp)
    h, w = px.shape[:2]
    # turn into a translucent ink wash: dark core, wet edges, gold glow ring
    a = px[..., 3]
    soft = blur(a[..., None], 6)[..., 0]
    core_a = np.clip(a * (0.93 + 0.07 * noise(h, w, 10, 3)), 0, 1)
    glow = np.clip(blur(a[..., None], 14)[..., 0] * 1.6 - a * 2.0, 0, 1) * 0.9
    out = np.zeros((h, w, 4), dtype=np.float32)
    gold = np.array((0.722, 0.537, 0.227), dtype=np.float32)
    ink = np.array(INK, dtype=np.float32)
    tot = np.clip(core_a + glow, 1e-4, 1)
    out[..., :3] = (ink * core_a[..., None] + gold * glow[..., None]) / tot[..., None]
    out[..., 3] = np.clip(core_a + glow, 0, 1)
    out = watercolour(out, seed=4, strength=0.7)
    save_px(out, os.path.join(core.REPO, 'game', 'public', 'assets', 'tex', 'palm.webp'))
    print('PALM')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    jobs = [a for a in argv if not a.startswith('char=')] or ['portraits', 'og', 'icon', 'palm']
    os.makedirs(core.PREVIEW_DIR, exist_ok=True)
    if 'portraits' in jobs:
        portraits()
    if 'og' in jobs:
        og_card()
    if 'icon' in jobs:
        icon()
        icon(512, 'icon-512.png', ((192, 'icon-192.png'), (180, 'apple-touch-icon.png')))
    if 'palm' in jobs:
        palm()


main()
