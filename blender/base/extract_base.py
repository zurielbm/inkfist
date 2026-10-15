"""Extract the CC0 Blender Studio "Human Base Meshes" realistic bodies into a compact committed file.

The bundle (CC0, https://www.blender.org/download/demo-files/#assets) is fetched by tools/fetch-basemesh.sh into
blender/base/.cache/. This script bakes each body's multires sculpt into its base cage ("Apply Base") and stores
the male and female shapes (they share one topology), the faces and the UV layout in blender/base/hbm_base.npz.

  ./blender/run.sh base/extract_base.py -- [path/to/human_base_meshes_bundle.blend]
"""
import os
import sys

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT = os.path.join(HERE, '.cache', 'human-base-meshes-bundle-v1.4.1', 'human_base_meshes_bundle.blend')
OUT = os.path.join(HERE, 'hbm_base.npz')
BODIES = {'male': 'GEO-body_male_realistic', 'female': 'GEO-body_female_realistic'}


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    path = argv[0] if argv else DEFAULT
    bpy.ops.wm.read_factory_settings(use_empty=True)
    with bpy.data.libraries.load(path, link=False) as (src, dst):
        dst.objects = list(BODIES.values())
    sc = bpy.context.scene
    data = {}
    ref_faces = None
    for key, name in BODIES.items():
        o = bpy.data.objects[name]
        sc.collection.objects.link(o)
        o.location = (0, 0, 0)
        bpy.context.view_layer.objects.active = o
        o.select_set(True)
        mod = next(m for m in o.modifiers if m.type == 'MULTIRES')
        bpy.ops.object.multires_base_apply(modifier=mod.name)
        o.modifiers.remove(mod)
        me = o.data
        n = len(me.vertices)
        co = np.empty(n * 3, np.float32)
        me.vertices.foreach_get('co', co)
        sizes = np.empty(len(me.polygons), np.int32)
        me.polygons.foreach_get('loop_total', sizes)
        loops = np.empty(len(me.loops), np.int32)
        me.loops.foreach_get('vertex_index', loops)
        if ref_faces is None:
            ref_faces = (sizes, loops)
            uv = np.empty(len(me.loops) * 2, np.float32)
            me.uv_layers[0].data.foreach_get('uv', uv)
            data['face_sizes'] = sizes
            data['face_loops'] = loops
            data['uv'] = uv.reshape(-1, 2)
        else:
            # same topology; only each face's starting loop may differ
            same = np.array_equal(ref_faces[0], sizes) and all(
                sorted(a) == sorted(b) for a, b in zip(np.split(ref_faces[1], np.cumsum(sizes)[:-1]),
                                                       np.split(loops, np.cumsum(sizes)[:-1])))
            assert same, 'topology differs'
        data[key] = co.reshape(-1, 3)
        print(f'BASE {key}: verts={n} faces={len(sizes)} z=[{co[2::3].min():.3f},{co[2::3].max():.3f}]')
    np.savez_compressed(OUT, **data)
    print('EXPORT', OUT, os.path.getsize(OUT))


main()
