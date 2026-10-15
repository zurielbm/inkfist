"""Cloud Peak layout: layer rectangles (game metres) and image sizes.

Coverage (computed by sweeping the camera box x in [-4,4], y in [1.2,4.5], z in [7,10],
pitch in [-6,+2] deg, vfov 30 deg, aspect up to 2.4; see coverage_report()):
  sky  z=-60 needs x +-50.6, y from -14.3 (floor sight line) to 25.9 (frustum top)
  far  z=-40 needs x +-37.3, bottom <= -8.7
  mid  z=-20 needs x +-24.0, bottom <= -3.1
  near z=-9  needs x +-16.6, bottom at the floor's far edge (y=0)
Each rectangle has exactly the aspect of its image so paintings are not distorted.
"""
import itertools
import json
import math
import os

import numpy as np

EYE = (0.0, 1.7, 10.0)          # default game camera (paintings are projected from here)

LAYERS = {
    "sky": dict(z=-60.0, rect=(-54.0, 54.0, -16.0, 38.0), size=(2048, 1024)),
    "far": dict(z=-40.0, rect=(-40.0, 40.0, -11.0, 21.0), size=(2560, 1024)),
    "mid": dict(z=-20.0, rect=(-26.0, 26.0, -5.0, 15.8), size=(2560, 1024)),
    "near": dict(z=-9.0, rect=(-18.0, 18.0, -0.25, 11.75), size=(3072, 1024)),
}
FLOOR = dict(zNear=8.0, zFar=-9.0, tileWidth=16.0, size=(2048, 1024))

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.normpath(os.path.join(HERE, "..", "..", "game", "public", "assets", "stage"))


def out_dir(stage="cloudpeak"):
    d = os.path.join(ASSETS, stage)
    os.makedirs(d, exist_ok=True)
    return d


def px_per_m(name):
    L = LAYERS[name]
    return L["size"][0] / (L["rect"][1] - L["rect"][0])


def to_px(name, x, y):
    """Layer world (x, y) -> image pixel (col, row), rows top-down."""
    L = LAYERS[name]
    x0, x1, y0, y1 = L["rect"]
    w, h = L["size"]
    return (np.asarray(x) - x0) / (x1 - x0) * w, (y1 - np.asarray(y)) / (y1 - y0) * h


def to_world(name, col, row):
    L = LAYERS[name]
    x0, x1, y0, y1 = L["rect"]
    w, h = L["size"]
    return x0 + np.asarray(col) / w * (x1 - x0), y1 - np.asarray(row) / h * (y1 - y0)


def row_grid_y(name):
    """World y of each image row (top-down)."""
    L = LAYERS[name]
    x0, x1, y0, y1 = L["rect"]
    w, h = L["size"]
    return y1 - (np.arange(h) + 0.5) / h * (y1 - y0)


def col_grid_x(name):
    L = LAYERS[name]
    x0, x1, y0, y1 = L["rect"]
    w, h = L["size"]
    return x0 + (np.arange(w) + 0.5) / w * (x1 - x0)


def stage_json(name="Cloud Peak", name_ko="운봉", name_zh="雲峰", bg="#e8dcc4"):
    layers = []
    for lid in ("sky", "far", "mid", "near"):
        L = LAYERS[lid]
        x0, x1, y0, y1 = L["rect"]
        layers.append({"id": lid, "src": f"{lid}.webp", "z": L["z"],
                       "centerY": round((y0 + y1) / 2, 3), "width": round(x1 - x0, 3),
                       "height": round(y1 - y0, 3)})
    return {"name": name, "nameKo": name_ko, "nameZh": name_zh, "bg": bg, "layers": layers,
            "floor": {"src": "floor.webp", "zNear": FLOOR["zNear"], "zFar": FLOOR["zFar"],
                      "tileWidth": FLOOR["tileWidth"]}}


def write_stage_json(stage="cloudpeak", **kw):
    data = stage_json(**kw)
    p = os.path.join(out_dir(stage), "stage.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return p, data


def coverage_report(xs=(-4, 4), ys=(1.2, 1.7, 4.5), zs=(7, 10), pitches=(-6, 0, 2),
                    aspects=(16 / 9, 2.4), vfov=30.0):
    """Required extents per layer for the camera box; verifies LAYERS rects."""
    t = math.tan(math.radians(vfov / 2))
    req = {k: dict(xmin=1e9, xmax=-1e9, ybot=1e9, ytop=-1e9) for k in LAYERS}
    for xc, yc, zc, p, asp in itertools.product(xs, ys, zs, pitches, aspects):
        c, s = math.cos(math.radians(p)), math.sin(math.radians(p))
        for sx in np.linspace(-1, 1, 9):
            for sy in np.linspace(-1, 1, 9):
                d = np.array([sx * t * asp, sy * t, -1.0])
                d = np.array([d[0], c * d[1] - s * d[2], s * d[1] + c * d[2]])
                for k, L in LAYERS.items():
                    tt = (L["z"] - zc) / d[2]
                    x, y = xc + tt * d[0], yc + tt * d[1]
                    r = req[k]
                    r["xmin"], r["xmax"] = min(r["xmin"], x), max(r["xmax"], x)
                    r["ytop"] = max(r["ytop"], y)
        for k, L in LAYERS.items():
            zl = L["z"]
            yf = yc * (1 - (zc - zl) / (zc - FLOOR["zFar"])) if zl < FLOOR["zFar"] else 0.0
            req[k]["ybot"] = min(req[k]["ybot"], yf)
    lines = []
    for k, r in req.items():
        x0, x1, y0, y1 = LAYERS[k]["rect"]
        ok_x = x0 <= r["xmin"] and x1 >= r["xmax"]
        ok_b = y0 <= r["ybot"]
        ok_t = (y1 >= r["ytop"]) if k == "sky" else True
        lines.append(f"{k}: need x[{r['xmin']:.1f},{r['xmax']:.1f}] bottom<={r['ybot']:.2f} "
                     f"top>={r['ytop']:.1f} | have x[{x0},{x1}] y[{y0},{y1}] "
                     f"{'OK' if ok_x and ok_b and ok_t else 'FAIL'}")
    return lines
