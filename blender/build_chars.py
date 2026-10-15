"""Entry point: build characters, bake animations, export .glb + metadata, render previews.

Usage:
  blender -b --factory-startup -P blender/build_chars.py -- <char> [--preview NAME] [--export] [--sheet clipA,clipB]
"""
import importlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from rig import core, pose, preview  # noqa: E402


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    char = argv[0] if argv else 'mujin'
    opts = argv[1:]
    core.reset_scene()
    cmod = importlib.import_module(f'rig.chars.{char}')
    amod = importlib.import_module(f'rig.anims.{char}')
    bake = '--nobake' not in opts
    import inspect
    if 'bake' in inspect.signature(cmod.build).parameters:
        arm, meshes, chains = cmod.build(bake=bake)
    else:
        arm, meshes, chains = cmod.build()
    meshes = meshes if isinstance(meshes, (list, tuple)) else [meshes]
    sk = pose.Skeleton(arm)
    sk.set_legacy(getattr(cmod, 'LEGACY', None))
    for mesh in meshes:
        print(f'BUILD {char}/{mesh.name}: verts={len(mesh.data.vertices)} '
              f'tris={sum(len(p.vertices) - 2 for p in mesh.data.polygons)} mats={len(mesh.data.materials)}')

    if '--preview' in opts:
        which = opts[opts.index('--preview') + 1]
        poses = amod.preview_poses(which) if hasattr(amod, 'preview_poses') else [None, amod.STANCE]
        gd = getattr(amod, 'GRIP_DEFAULT', ('relaxed', 'relaxed'))
        poses = [None if p is None else pose.with_grips(p, *gd) for p in poses]
        views = ('game', 'front')
        if which == 'face':
            views = ('face', 'facefront')
        if which.startswith('poses'):
            views = ('game',)
        big = which.startswith('big') or which == 'rest'
        path = preview.render_sheet(arm, sk, poses, f'{char}_{which}', views=views,
                                    lens=50 if which != 'face' else 60,
                                    width=640 if big else 300, height=880 if big else 420,
                                    cols=6 if which.startswith('poses') else None)
        print('PREVIEW', path)

    if '--sheet' in opts:
        names = opts[opts.index('--sheet') + 1].split(',')
        clips = amod.clips()
        poses = []
        for nm in names:
            c = clips[nm]
            n = c['length']
            for f in sorted(set([0, n // 4, n // 2, (3 * n) // 4, n] + list(c.get('events', {}).values()))):
                poses.append(pose.sample(c['keys'], f))
        path = preview.render_sheet(arm, sk, poses, f'{char}_sheet', views=('game',), width=240, height=340, cols=10)
        print('PREVIEW', path)

    if '--export' in opts:
        clips = amod.clips()
        meta = {'id': char, 'clips': {}, 'chains': [], 'height': getattr(cmod, 'H', 1.8)}
        if 'colliders' in arm.keys():
            meta['colliders'] = json.loads(arm['colliders'])
            for c in meta['colliders']:
                bone = arm.data.bones[c['bone']]
                c['length'] = round(bone.length, 4)
            del arm['colliders']
        for nm, c in clips.items():
            grips = getattr(amod, 'GRIP_CLIPS', {}).get(nm, getattr(amod, 'GRIP_DEFAULT', ('relaxed', 'relaxed')))
            act, clamped = pose.bake_clip(arm, sk, nm, c['keys'], c['length'], grips=grips)
            if clamped:
                print(f'WARN clip {nm}: IK clamped for {clamped}')
            meta['clips'][nm] = {'length': c['length'], 'loop': bool(c.get('loop')), 'events': c.get('events', {})}
        for name, ch in chains.items():
            pts = [[round(p[0], 4), round(p[2], 4), round(-p[1], 4)] for p in ch['points']]  # Blender -> glTF (Y up)
            meta['chains'].append({k: v for k, v in ch.items() if k not in ('points',)} | {'name': name, 'points': pts})
        # rest pose for export
        for pb in arm.pose.bones:
            pb.rotation_quaternion = (1, 0, 0, 0)
            pb.location = (0, 0, 0)
        out = os.path.join(core.CHAR_SRC, f'{char}.glb')
        core.export_glb(out, [arm] + list(meshes))
        with open(os.path.join(core.CHAR_OUT, f'{char}.json'), 'w', encoding='utf-8') as fh:
            json.dump(meta, fh, indent=1)
        print('EXPORT', out, os.path.getsize(out))


main()
