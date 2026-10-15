# Stage art generators (Blender 5.2, headless)

Everything here is procedural and deterministic (fixed seeds). The 3D forms (mountain heightfields, granite pillars, cloud billows, convex-hull rocks) and the brush strokes (pines, cracks, slab joints, as ribbon meshes) are rendered with Cycles on the GPU (OPTIX). The watercolour and sumi-e look comes from numpy post-processing inside Blender's Python: layered wet washes, pigment edge darkening, granulation, dry-brush bristles, bleed, and mist.

## Run

```
"C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup -P E:/martial-arts/blender/stage/build_cloudpeak.py
```

Options, after `--`:

- `--only json,sky,far,mid,near,floor,preview` runs a subset of the steps.
- `--reuse` reuses the cached Cycles passes in `_work/*_passes.npz`. Use it only for paint-only iterations, because geometry changes need a fresh render.

A full build takes about 5 minutes on an RTX 3060. Output goes to `game/public/assets/stage/cloudpeak/`: `sky|far|mid|near|floor.webp` and `stage.json`.

Shared textures (`paper`, `splat_*`, `crater`, `cracks`, `speedlines`, `brush_stroke`, `enso`, `mist`) live in `blender/tex/`:

```
"C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup -P E:/martial-arts/blender/tex/build_textures.py [-- --only paper,crater --preview]
```

Run the textures before the stage `preview` step, because the preview multiplies `tex/paper.webp` over the frame.

## Files

| file | role |
|---|---|
| `build_cloudpeak.py` | entry point (steps: json, sky, far, mid, near, floor, preview) |
| `inklib.py` | shared toolkit: FFT blur and noise, watercolour ops, dry brush, Canvas, Cycles setup, ribbon stroke renderer, EXR and WebP I/O (also used by `blender/tex`) |
| `cp_layout.py` | layer rectangles, image sizes, `stage.json` writer, camera-coverage check |
| `cp_sky.py` | graded sky wash, wisps, crimson sun, birds |
| `cp_ranges.py` | far ranges (heightfields), cloud sea, shared mountain and cloud painters, render passes |
| `cp_mid.py` | granite pillars, mid ridge, mist bands, pines, crimson pavilion |
| `cp_pines.py` | procedural pine and pavilion stroke geometry |
| `cp_near.py` | convex-hull rock outcrops, framing pines, grass tufts |
| `cp_floor.py` | top-down tileable flagstone floor (painted 3× stretched along z) |
| `cp_preview.py` | renders the real layer quads, floor and silhouette fighters through the game camera; magenta coverage tests |
| `_preview_cloudpeak.png` | composite preview (default camera, 16:9, paper overlay) |
| `_work/` | scratch renders, caches and review images (safe to delete) |

## Layer sizing

Each layer is a vertical quad centred on x=0. Paintings are projected from the default eye (0, 1.7, 10), so a layer's painted horizon sits at eye level. Rectangles were chosen by sweeping the camera box: x ±4, y 1.2–4.5, z 7–10, pitch −6…+2°, vertical FOV 30°, aspect up to 2.4. The x extent covers the widest frustum. The far and mid layers extend below the floor's far-edge sight line, with opaque cloud sea at the bottom. The sky also covers the frustum top. `build_cloudpeak.py -- --only json` prints the check, and the `preview` step renders magenta-background coverage tests at the extremes (the last run had zero uncovered pixels).

The floor runs from `zFar=-9` to `zNear=+8`. A low (1.2 m), down-pitched camera sees the ground up to z≈6.9, so the near edge extends past the originally suggested +6.
