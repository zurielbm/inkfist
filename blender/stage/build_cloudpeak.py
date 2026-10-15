"""Build the Cloud Peak (雲峰 / 운봉) stage: sky, far, mid, near, floor, stage.json, preview.

Run headless from anywhere:
  "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup \
      -P E:/martial-arts/blender/stage/build_cloudpeak.py -- [--only sky,far,mid,near,floor,json,preview]

Deterministic: every random source uses a fixed seed.
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import inklib as ik  # noqa: E402
import cp_layout as lay  # noqa: E402

STEPS = ["json", "sky", "far", "mid", "near", "floor", "preview"]


def run(step):
    if step == "json":
        p, data = lay.write_stage_json()
        for line in lay.coverage_report():
            ik.log(line)
        ik.log("wrote", p)
    elif step == "sky":
        import cp_sky
        cp_sky.sky_layer()
    elif step == "far":
        import cp_ranges
        cp_ranges.far_layer()
    elif step == "mid":
        import cp_mid
        cp_mid.mid_layer()
    elif step == "near":
        import cp_near
        cp_near.near_layer()
    elif step == "floor":
        import cp_floor
        cp_floor.floor_layer()
    elif step == "preview":
        import cp_preview
        cp_preview.preview_all()


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    steps = STEPS
    if "--reuse" in argv:
        import cp_ranges
        cp_ranges.REUSE[0] = True
    if "--only" in argv:
        steps = argv[argv.index("--only") + 1].split(",")
    for s in steps:
        t = time.time()
        ik.log("== step", s)
        run(s)
        ik.log(f"== step {s} done in {time.time() - t:.1f}s")


if __name__ == "__main__":
    main()
