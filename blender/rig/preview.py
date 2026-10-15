"""Workbench contact-sheet previews of poses (for iterating on models/animations)."""
import os
import bpy
import numpy as np
from mathutils import Vector

from .core import PREVIEW_DIR, hex_rgb
from .pose import apply_pose

VIEWS = {
    # name: (camera location, target)
    'game': (Vector((-3.4, -0.9, 1.2)), Vector((0, 0.05, 0.95))),   # char's right side = in-game camera side
    'front': (Vector((-1.0, -3.4, 1.25)), Vector((0, 0, 0.95))),
    'face': (Vector((-0.30, -0.95, 1.66)), Vector((0, -0.05, 1.64))),
    'facefront': (Vector((0.0, -1.0, 1.64)), Vector((0, -0.05, 1.63))),
}


def setup(width=300, height=420, lens=50):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.render.resolution_x = width
    sc.render.resolution_y = height
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sh = sc.display.shading
    sh.light = 'STUDIO'
    sh.color_type = 'TEXTURE' if any(i.name.endswith('_albedo') for i in bpy.data.images) else 'MATERIAL'
    sh.show_object_outline = True
    sh.object_outline_color = (0.0, 0.0, 0.0)
    try:
        sh.show_cavity = True
        sh.cavity_type = 'WORLD'
    except Exception:
        pass
    w = bpy.data.worlds.new('pv') if not sc.world else sc.world
    sc.world = w
    paper = hex_rgb('#e8dcc4')
    w.color = tuple(c ** 2.2 for c in paper)
    cam_data = bpy.data.cameras.get('pvcam') or bpy.data.cameras.new('pvcam')
    cam_data.lens = lens
    cam = bpy.data.objects.get('pvcam') or bpy.data.objects.new('pvcam', cam_data)
    if cam.name not in sc.collection.objects:
        sc.collection.objects.link(cam)
    sc.camera = cam
    return cam


def aim(cam, loc, target):
    cam.location = loc
    d = (target - loc)
    cam.rotation_mode = 'QUATERNION'
    cam.rotation_quaternion = d.to_track_quat('-Z', 'Y')


def render_sheet(arm, sk, poses, name, views=('game', 'front'), width=300, height=420, cols=None, lens=50):
    """poses: list of pose dicts (or None for rest). Renders each pose from each view and tiles them."""
    cam = setup(width, height, lens)
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    tiles = []
    for pi, pose in enumerate(poses):
        if pose is None:
            for pb in arm.pose.bones:
                pb.rotation_quaternion = (1, 0, 0, 0)
                pb.location = (0, 0, 0)
        else:
            apply_pose(arm, sk, pose)
        bpy.context.view_layer.update()
        for v in views:
            loc, tgt = VIEWS[v]
            aim(cam, loc, tgt)
            fp = os.path.join(PREVIEW_DIR, f'_tile_{pi}_{v}.png')
            bpy.context.scene.render.filepath = fp
            bpy.ops.render.render(write_still=True)
            tiles.append(fp)
    n = len(tiles)
    cols = cols or min(n, 8)
    rows = (n + cols - 1) // cols
    sheet = np.zeros((rows * height, cols * width, 4), dtype=np.float32)
    for i, fp in enumerate(tiles):
        img = bpy.data.images.load(fp)
        px = np.empty(width * height * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape(height, width, 4)
        r, c = divmod(i, cols)
        sheet[(rows - 1 - r) * height:(rows - r) * height, c * width:(c + 1) * width] = px
        bpy.data.images.remove(img)
        os.remove(fp)
    out = bpy.data.images.new('sheet_' + name, cols * width, rows * height, alpha=True)
    out.pixels.foreach_set(sheet.ravel())
    path = os.path.join(PREVIEW_DIR, name + '.png')
    out.filepath_raw = path
    out.file_format = 'PNG'
    out.save()
    return path
