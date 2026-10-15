"""Build the Bamboo Grove (竹林 / 죽림) stage: sky, far, mid, near, floor, stage.json, preview.

Run headless:
  "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup \
      -P E:/martial-arts/blender/stage/build_bamboo.py -- [--only json,sky,far,mid,near,floor,preview]

Uses the same layer rectangles / floor mapping as Cloud Peak (cp_layout) so the game can treat
both stages identically.  Deterministic (fixed seeds)."""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import inklib as ik  # noqa: E402
import cp_layout as lay  # noqa: E402

STEPS = ["json", "sky", "far", "mid", "near", "floor", "preview"]


def run(step):
    import bb_stage as bb
    if step == "json":
        p, _ = lay.write_stage_json(stage=bb.STAGE, name="Bamboo Grove", name_ko="죽림",
                                    name_zh="竹林", bg="#e8dcc4")
        ik.log("wrote", p)
    elif step == "preview":
        import cp_preview
        cp_preview.preview_all(stage=bb.STAGE)
    else:
        getattr(bb, f"{step}_layer")()


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    steps = STEPS
    if "--only" in argv:
        steps = argv[argv.index("--only") + 1].split(",")
    for s in steps:
        t = time.time()
        ik.log("== bamboo step", s)
        run(s)
        ik.log(f"== bamboo step {s} done in {time.time() - t:.1f}s")


if __name__ == "__main__":
    main()
