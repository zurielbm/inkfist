"""Composite preview of a stage exactly as stage.json describes it.

Builds the layer quads (unlit, alpha) and the tiled floor plane in a Blender scene, renders
through the game camera (vertical FOV 30 deg), adds two dark silhouette fighters at x=+-1.5
(preview only) and multiplies the shared paper texture over the frame like the game does.
Also renders coverage tests at the extreme camera positions against a magenta background and
reports the fraction of uncovered pixels."""
import json
import math
import os

import numpy as np
import bpy
import bmesh
from mathutils import Matrix, Vector

import inklib as ik
from inklib import F32, clamp01
import cp_layout as lay

TEX_DIR = os.path.normpath(os.path.join(lay.HERE, "..", "..", "game", "public", "assets", "tex"))


def _img(path):
    im = bpy.data.images.load(path, check_existing=True)
    im.colorspace_settings.name = "sRGB"
    try:
        im.alpha_mode = "STRAIGHT"
    except Exception:
        pass
    return im


def unlit_material(name, image=None, color=None, alpha=1.0, repeat=False):
    mat = bpy.data.materials.new(name)
    nt = ik._node_tree(mat)
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    em.inputs["Strength"].default_value = 1.0
    if image is not None:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = image
        tex.interpolation = "Linear"
        tex.extension = "REPEAT" if repeat else "EXTEND"
        nt.links.new(tex.outputs["Color"], em.inputs["Color"])
        nt.links.new(tex.outputs["Alpha"], mix.inputs["Fac"])
    else:
        em.inputs["Color"].default_value = (*[c ** 2.2 for c in color], 1.0)
        mix.inputs["Fac"].default_value = alpha
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    try:
        mat.blend_method = "BLEND"
    except Exception:
        pass
    return mat


def quad(name, x0, x1, y0, y1, z, mat, uv=None):
    """Vertical quad in game space (faces +z toward the camera)."""
    verts = [ik.g2b((x0, y0, z)), ik.g2b((x1, y0, z)), ik.g2b((x1, y1, z)), ik.g2b((x0, y1, z))]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], [(0, 1, 2, 3)])
    uvl = me.uv_layers.new()
    uvs = uv or [(0, 0), (1, 0), (1, 1), (0, 1)]
    for i, l in enumerate(me.loops):
        uvl.data[i].uv = uvs[l.vertex_index]
    me.materials.append(mat)
    return ik.link(bpy.data.objects.new(name, me))


def floor_plane(fl, mat, x_ext=60.0):
    zN, zF, tw = fl["zNear"], fl["zFar"], fl["tileWidth"]
    verts = [ik.g2b((-x_ext, 0, zN)), ik.g2b((x_ext, 0, zN)), ik.g2b((x_ext, 0, zF)),
             ik.g2b((-x_ext, 0, zF))]
    me = bpy.data.meshes.new("floor")
    me.from_pydata(verts, [], [(0, 1, 2, 3)])
    uvl = me.uv_layers.new()
    uvs = [(-x_ext / tw, 0), (x_ext / tw, 0), (x_ext / tw, 1), (-x_ext / tw, 1)]
    for i, l in enumerate(me.loops):
        uvl.data[i].uv = uvs[l.vertex_index]
    me.materials.append(mat)
    return ik.link(bpy.data.objects.new("floor", me))


def _segment(bm, p0, p1, r0, r1, seg=12):
    p0, p1 = Vector(ik.g2b(p0)), Vector(ik.g2b(p1))
    d = p1 - p0
    L = d.length
    rot = d.normalized().to_track_quat("Z", "Y").to_matrix().to_4x4()
    mtx = Matrix.Translation((p0 + p1) / 2) @ rot
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r0, radius2=r1, depth=L,
                          matrix=mtx)
    for p, r in ((p0, r0), (p1, r1)):
        bmesh.ops.create_uvsphere(bm, u_segments=10, v_segments=6, radius=r,
                                  matrix=Matrix.Translation(p))


def fighter(name, x0, facing, pose, ink, accent):
    """Crude martial-artist silhouette (robe, limbs, head) in a fighting stance."""
    s = facing

    def P(x, y, z=0.0):
        return (x0 + s * x, y, z)

    bm = bmesh.new()
    J = pose
    _segment(bm, P(*J["hip"]), P(*J["neck"]), 0.16, 0.13)
    bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=0.12,
                              matrix=Matrix.Translation(Vector(ik.g2b(P(*J["head"])))))
    for leg in ("lf", "lb"):
        hip, knee, ank, toe = J[leg]
        _segment(bm, P(*hip), P(*knee), 0.085, 0.065)
        _segment(bm, P(*knee), P(*ank), 0.065, 0.05)
        _segment(bm, P(*ank), P(*toe), 0.05, 0.04)
    for arm in ("af", "ab"):
        sh, el, ha = J[arm]
        _segment(bm, P(*sh), P(*el), 0.06, 0.05)
        _segment(bm, P(*el), P(*ha), 0.05, 0.045)
    # robe skirt
    _segment(bm, P(J["hip"][0], J["hip"][1] + 0.08), P(J["hip"][0] + 0.05, 0.42), 0.17, 0.33,
             seg=16)
    # hair tail
    hx, hy = J["head"]
    _segment(bm, P(hx - 0.05, hy + 0.05), P(hx - 0.32, hy - 0.25), 0.05, 0.015)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(unlit_material(name + "_ink", color=ink))
    ob = ik.link(bpy.data.objects.new(name, me))
    # sash / accent
    bm = bmesh.new()
    _segment(bm, P(J["hip"][0], J["hip"][1] + 0.02), P(J["hip"][0], J["hip"][1] + 0.12), 0.175,
             0.17, seg=16)
    sx, sy = J["hip"]
    _segment(bm, P(sx - 0.12, sy + 0.05), P(sx - 0.45, sy - 0.25), 0.04, 0.02)
    me2 = bpy.data.meshes.new(name + "_sash")
    bm.to_mesh(me2)
    bm.free()
    me2.materials.append(unlit_material(name + "_acc", color=accent))
    ik.link(bpy.data.objects.new(name + "_sash", me2))
    # soft contact shadow
    bm = bmesh.new()
    bmesh.ops.create_circle(bm, cap_ends=True, segments=32, radius=0.5,
                            matrix=Matrix.Translation(Vector(ik.g2b((x0, 0.005, 0.0)))) @
                            Matrix.Diagonal((1.0, 0.45, 1.0, 1.0)))
    me3 = bpy.data.meshes.new(name + "_shadow")
    bm.to_mesh(me3)
    bm.free()
    me3.materials.append(unlit_material(name + "_sh", color=ik.INK, alpha=0.35))
    ik.link(bpy.data.objects.new(name + "_shadow", me3))
    return ob


POSE_A = dict(hip=(0.0, 0.92), neck=(0.1, 1.42), head=(0.14, 1.58),
              lf=((0.06, 0.9), (0.4, 0.52), (0.46, 0.07), (0.62, 0.03)),
              lb=((-0.06, 0.9), (-0.32, 0.5), (-0.52, 0.07), (-0.38, 0.03)),
              af=((0.12, 1.38), (0.4, 1.3), (0.66, 1.4)),
              ab=((0.04, 1.38), (-0.04, 1.12), (0.2, 1.18)))
POSE_B = dict(hip=(0.0, 0.82), neck=(0.14, 1.32), head=(0.2, 1.47),
              lf=((0.06, 0.8), (0.46, 0.46), (0.5, 0.07), (0.66, 0.03)),
              lb=((-0.06, 0.8), (-0.4, 0.42), (-0.62, 0.07), (-0.48, 0.03)),
              af=((0.16, 1.28), (0.36, 1.05), (0.6, 1.2)),
              ab=((0.08, 1.28), (-0.2, 1.36), (-0.34, 1.58)))


def build_scene(stage, fighters=True, bg=None):
    ik.reset_scene()
    d = lay.out_dir(stage)
    with open(os.path.join(d, "stage.json"), encoding="utf-8") as f:
        data = json.load(f)
    bgc = ik.hexc(data["bg"]) if bg is None else np.asarray(bg, F32)
    ik.set_world_color(tuple(float(c) ** 2.2 for c in bgc), 1.0)
    for L in data["layers"]:
        im = _img(os.path.join(d, L["src"]))
        mat = unlit_material(L["id"], image=im)
        cy, w, h = L["centerY"], L["width"], L["height"]
        quad(L["id"], -w / 2, w / 2, cy - h / 2, cy + h / 2, L["z"], mat)
    fl = data["floor"]
    floor_plane(fl, unlit_material("floor", image=_img(os.path.join(d, fl["src"])), repeat=True))
    if fighters:
        fighter("fA", -1.5, 1, POSE_A, ik.INK, ik.CRIMSON)
        fighter("fB", 1.5, -1, POSE_B, ik.INK2, ik.hexc("#5d6a73"))
    return data


def game_camera(x=0.0, y=1.7, z=10.0, look_y=1.2, pitch_deg=None, aspect=16 / 9):
    cam = bpy.data.cameras.new("gcam")
    cam.type = "PERSP"
    cam.sensor_fit = "VERTICAL"
    cam.angle_y = math.radians(30.0)
    cam.clip_start = 0.1
    cam.clip_end = 1000.0
    ob = ik.link(bpy.data.objects.new("gcam", cam))
    ob.location = ik.g2b((x, y, z))
    pitch = math.radians(pitch_deg) if pitch_deg is not None else math.atan2(look_y - y, z)
    ob.rotation_euler = (math.pi / 2 + pitch, 0.0, 0.0)
    bpy.context.scene.camera = ob
    return ob


def render_view(name, w, h, **cam):
    for ob in [o for o in bpy.data.objects if o.name.startswith("gcam")]:
        bpy.data.objects.remove(ob)
    game_camera(aspect=w / h, **cam)
    ik.setup_cycles(samples=16, denoise=False, transparent=False, bounces=0, filter_width=1.0)
    bpy.context.scene.cycles.transparent_max_bounces = 16
    img = ik.render_exr(name, w, h)
    rgb = np.clip(img[..., :3], 0, 1) ** (1 / 2.2)     # scene linear -> display (approx sRGB)
    return rgb.astype(F32)


def paper_overlay(rgb, scale=1.0):
    p = os.path.join(TEX_DIR, "paper.webp")
    if not os.path.exists(p):
        return rgb
    pap = ik.load_image(p)[..., :3]
    h, w = rgb.shape[:2]
    ph, pw = pap.shape[:2]
    ys = (np.arange(h) % ph)
    xs = (np.arange(w) % pw)
    return rgb * pap[ys][:, xs]


def preview_all(stage="cloudpeak"):
    build_scene(stage)
    rgb = render_view("pv_main", 1920, 1080)
    out = paper_overlay(rgb)
    ik.save_image(out, os.path.join(lay.HERE, f"_preview_{stage}.png"))
    ik.save_image(paper_overlay(render_view("pv_wide", 2520, 1080, x=3.0)),
                  os.path.join(ik.WORK, f"pv_{stage}_wide.png"))
    ik.save_image(paper_overlay(render_view("pv_high", 1920, 1080, y=4.5, look_y=1.5)),
                  os.path.join(ik.WORK, f"pv_{stage}_high.png"))
    # coverage tests: magenta background shows any gap
    build_scene(stage, fighters=False, bg=(1.0, 0.0, 1.0))
    worst = 0.0
    for i, (x, y, p, asp) in enumerate([(4, 4.5, -6, 2.4), (-4, 4.5, 2, 2.4), (4, 1.2, 2, 2.4),
                                        (-4, 1.2, -6, 2.4), (0, 1.7, None, 16 / 9)]):
        hh = 300
        ww = int(hh * asp)
        rgb = render_view(f"cov{i}", ww, hh, x=x, y=y, pitch_deg=p)
        mag = (rgb[..., 0] > 0.9) & (rgb[..., 1] < 0.15) & (rgb[..., 2] > 0.9)
        frac = float(mag.mean())
        worst = max(worst, frac)
        ik.log(f"coverage cam x={x} y={y} pitch={p} aspect={asp:.2f}: uncovered {frac:.5f}")
        if i == 0:
            ik.save_image(rgb, os.path.join(ik.WORK, f"cov_{stage}_{i}.png"))
    ik.log(f"coverage worst uncovered fraction: {worst:.5f}")
