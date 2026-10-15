"""inklib -- shared ink-wash / watercolour painting toolkit for INKFIST asset generation.

Runs inside Blender's bundled Python (numpy is available, scipy is not).

Two halves:
  * Blender side: scene reset, Cycles GPU setup, procedural meshes, brush-stroke ribbon meshes,
    multi-pass renders read back into numpy, and WebP/PNG writing through Blender's image API.
  * numpy side: FFT gaussian blur, gaussian/fbm noise, domain warping, watercolour wash shapes,
    pigment edge darkening, granulation, dry-brush bristle texture, simple alpha compositing.

Convention for every numpy image in this module: float32, rows top-to-bottom, x to the right,
values 0..1, colours in sRGB (display) space.  Blender stores images bottom-to-top; the I/O
helpers flip.
"""
import math
import os
import time

import numpy as np
import bpy

F32 = np.float32
HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, "_work")
os.makedirs(WORK, exist_ok=True)


def log(*a):
    print("[ink]", *a, flush=True)


# --------------------------------------------------------------------------------------------
# palette (docs/ARCHITECTURE.md)
# --------------------------------------------------------------------------------------------
def hexc(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], F32)


PAPER = hexc("#e8dcc4")
PAPER_LIGHT = hexc("#efe6d2")
MIST = hexc("#ece3d0")          # horizon / cloud-sea colour shared by sky, far, mid and floor edge
INK = hexc("#1b1a17")
INK2 = hexc("#3a3730")
WASH = hexc("#8a8578")
CRIMSON = hexc("#a3262a")
GOLD = hexc("#b8893a")
JADE = hexc("#4f7a62")
COOL_INK = hexc("#3b4046")     # slightly blue-grey ink for aerial perspective


# --------------------------------------------------------------------------------------------
# small math helpers
# --------------------------------------------------------------------------------------------
def clamp01(x):
    return np.clip(x, 0.0, 1.0)


def smoothstep(e0, e1, x):
    t = clamp01((x - e0) / (e1 - e0))
    return t * t * (3.0 - 2.0 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def rng(seed):
    return np.random.default_rng(seed)


# --------------------------------------------------------------------------------------------
# FFT gaussian blur, resampling, noise
# --------------------------------------------------------------------------------------------
def _blur_axis(a, sigma, axis, wrap):
    if sigma <= 0.3:
        return a
    n = a.shape[axis]
    pad = 0
    if not wrap:
        pad = int(math.ceil(3.0 * sigma)) + 1
        pw = [(0, 0)] * a.ndim
        pw[axis] = (pad, pad)
        a = np.pad(a, pw, mode="symmetric")
    N = a.shape[axis]
    F = np.fft.rfft(a, axis=axis)
    f = np.fft.rfftfreq(N)
    tf = np.exp(-2.0 * (math.pi * sigma * f) ** 2)
    sh = [1] * a.ndim
    sh[axis] = -1
    out = np.fft.irfft(F * tf.reshape(sh), n=N, axis=axis)
    if pad:
        sl = [slice(None)] * a.ndim
        sl[axis] = slice(pad, pad + n)
        out = out[tuple(sl)]
    return out.astype(F32)


def blur(a, sx, sy=None, wrap_x=False, wrap_y=False):
    """Gaussian blur of a HxW or HxWxC array (sigma in pixels, separate x/y)."""
    sy = sx if sy is None else sy
    a = np.asarray(a, F32)
    a = _blur_axis(a, sx, 1, wrap_x)
    a = _blur_axis(a, sy, 0, wrap_y)
    return a


def _interp_axis(a, coords, axis, wrap):
    n = a.shape[axis]
    i0 = np.floor(coords).astype(np.int64)
    f = (coords - i0).astype(F32)
    if wrap:
        i1 = (i0 + 1) % n
        i0 = i0 % n
    else:
        i1 = np.clip(i0 + 1, 0, n - 1)
        i0 = np.clip(i0, 0, n - 1)
    a0 = np.take(a, i0, axis=axis)
    a1 = np.take(a, i1, axis=axis)
    sh = [1] * a.ndim
    sh[axis] = -1
    return a0 + (a1 - a0) * f.reshape(sh)


def resize(a, h, w, wrap_x=False, wrap_y=False):
    """Bilinear resize (pixel-centre aligned)."""
    H, W = a.shape[:2]
    ys = (np.arange(h) + 0.5) * H / h - 0.5
    xs = (np.arange(w) + 0.5) * W / w - 0.5
    out = _interp_axis(np.asarray(a, F32), ys, 0, wrap_y)
    out = _interp_axis(out, xs, 1, wrap_x)
    return out.astype(F32)


def sample(a, x, y, wrap_x=False, wrap_y=False):
    """Bilinear sample of a (HxW or HxWxC) at float pixel coords x, y (any equal shapes)."""
    H, W = a.shape[:2]
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = (x - x0).astype(F32)
    fy = (y - y0).astype(F32)
    if wrap_x:
        x1 = (x0 + 1) % W
        x0 = x0 % W
    else:
        x1 = np.clip(x0 + 1, 0, W - 1)
        x0 = np.clip(x0, 0, W - 1)
    if wrap_y:
        y1 = (y0 + 1) % H
        y0 = y0 % H
    else:
        y1 = np.clip(y0 + 1, 0, H - 1)
        y0 = np.clip(y0, 0, H - 1)
    if a.ndim == 3:
        fx = fx[..., None]
        fy = fy[..., None]
    top = a[y0, x0] * (1 - fx) + a[y0, x1] * fx
    bot = a[y1, x0] * (1 - fx) + a[y1, x1] * fx
    return (top * (1 - fy) + bot * fy).astype(F32)


def grid(h, w):
    yy, xx = np.mgrid[0:h, 0:w]
    return xx.astype(F32), yy.astype(F32)


def warp(a, dx, dy, wrap_x=False, wrap_y=False):
    h, w = a.shape[:2]
    xx, yy = grid(h, w)
    return sample(a, xx + dx, yy + dy, wrap_x, wrap_y)


def gnoise(h, w, sx, sy=None, seed=0, wrap_x=False, wrap_y=False):
    """Gaussian-filtered white noise, zero mean / unit std. sx, sy = correlation sigma (px).
    Large sigmas are generated at reduced resolution and bilinearly upsampled."""
    sy = sx if sy is None else sy
    r = rng(seed)
    k = max(1.0, min(sx, sy) / 3.0)
    hh = max(4, int(round(h / k)))
    ww = max(4, int(round(w / k)))
    sxl, syl = sx * ww / w, sy * hh / h
    px = 0 if wrap_x else int(3 * sxl) + 2
    py = 0 if wrap_y else int(3 * syl) + 2
    n = r.standard_normal((hh + 2 * py, ww + 2 * px)).astype(F32)
    n = blur(n, sxl, syl, True, True)
    n = n[py:py + hh, px:px + ww]
    if (hh, ww) != (h, w):
        n = resize(n, h, w, wrap_x, wrap_y)
    n = n - n.mean()
    return (n / (n.std() + 1e-8)).astype(F32)


def fbm(h, w, sigma, octaves=5, gain=0.55, lac=2.0, seed=0, wrap_x=False, wrap_y=False,
        aniso=1.0, min_sigma=0.6):
    """Fractal sum of gnoise octaves (unit-ish std). aniso>1 stretches features along x."""
    acc = np.zeros((h, w), F32)
    norm = 0.0
    amp = 1.0
    s = float(sigma)
    for i in range(octaves):
        if s < min_sigma:
            break
        acc += amp * gnoise(h, w, s * aniso, s, seed * 131 + i * 977 + 7, wrap_x, wrap_y)
        norm += amp * amp
        amp *= gain
        s /= lac
    return acc / math.sqrt(norm)


# --------------------------------------------------------------------------------------------
# watercolour primitives
# --------------------------------------------------------------------------------------------
def wash_shape(mask, seed, warp_amp=6.0, warp_sigma=18.0, soft=1.5, edge=0.08, jitter=0.06,
               wrap_x=False, wrap_y=False):
    """Turn a (hard or soft) coverage mask into an irregular, wet-edged wash coverage 0..1."""
    h, w = mask.shape
    m = mask
    if warp_amp > 0:
        dx = gnoise(h, w, warp_sigma, seed=seed, wrap_x=wrap_x, wrap_y=wrap_y) * warp_amp
        dy = gnoise(h, w, warp_sigma, seed=seed + 1, wrap_x=wrap_x, wrap_y=wrap_y) * warp_amp
        m = warp(mask, dx, dy, wrap_x, wrap_y)
    m = blur(m, soft, wrap_x=wrap_x, wrap_y=wrap_y)
    if jitter:
        m = m + gnoise(h, w, 1.6, seed=seed + 2, wrap_x=wrap_x, wrap_y=wrap_y) * jitter
    return smoothstep(0.5 - edge, 0.5 + edge, m)


def edge_darken(d, sigma=3.0, k=1.0, wrap_x=False, wrap_y=False):
    """Pigment migrates to the drying edge: boost density where the neighbourhood is lighter."""
    return d + k * np.maximum(d - blur(d, sigma, wrap_x=wrap_x, wrap_y=wrap_y), 0.0)


def granulation(h, w, seed, wrap_x=False, wrap_y=False, fine=0.8, clump=3.0, mix=0.45):
    """Zero-mean granulation field (pigment settling in paper tooth)."""
    g = (1 - mix) * gnoise(h, w, fine, seed=seed, wrap_x=wrap_x, wrap_y=wrap_y) \
        + mix * gnoise(h, w, clump, seed=seed + 3, wrap_x=wrap_x, wrap_y=wrap_y)
    return g / (g.std() + 1e-8)


def granulate(d, g, amount=0.35, dense=0.03, light_boost=None):
    """Apply granulation g (zero mean) to density d.  Pigment settles visibly in light washes;
    dense ink stays nearly solid (only a `dense` fraction of variation)."""
    dc = clamp01(d)
    return np.maximum(d * (1.0 + g * (amount * (1.0 - dc) ** 1.5 + dense)), 0.0)


def bleed(d, sigma=4.0, amount=0.35, wrap_x=False, wrap_y=False):
    """Wet-in-wet soft halo around a deposit."""
    return np.maximum(d, amount * blur(d, sigma, wrap_x=wrap_x, wrap_y=wrap_y))


def dilate_rgb(rgb, a, fallback=None):
    """Fill RGB under (near) transparent pixels with nearby colours (avoids fringes in mipmaps)."""
    out = rgb.copy()
    filled = a > 0.02
    for s in (3, 12, 48, 160):
        if filled.all():
            break
        wsum = blur(a, s)
        csum = blur(rgb * a[..., None], s)
        ok = (wsum > 1e-3) & (~filled)
        out[ok] = csum[ok] / wsum[ok][:, None]
        filled = filled | ok
    if fallback is not None:
        out[~filled] = fallback
    return out


class Canvas:
    """Straight-alpha RGBA painting surface (sRGB floats)."""

    def __init__(self, h, w, color=None, alpha=0.0):
        self.h, self.w = h, w
        self.rgb = np.empty((h, w, 3), F32)
        self.rgb[:] = MIST if color is None else color
        self.a = np.full((h, w), alpha, F32)

    def over(self, color, alpha):
        """Porter-Duff over with a colour (3,) or (h,w,3) and an alpha map."""
        al = clamp01(alpha).astype(F32)
        col = np.asarray(color, F32)
        a_out = al + self.a * (1 - al)
        num = col * al[..., None] + self.rgb * (self.a * (1 - al))[..., None]
        safe = np.maximum(a_out, 1e-6)[..., None]
        self.rgb = np.where(a_out[..., None] > 1e-6, num / safe, self.rgb).astype(F32)
        self.a = a_out.astype(F32)

    def multiply(self, color, density):
        """Transparent glaze (subtractive): rgb *= lerp(1, color/paper, density)."""
        t = np.clip(np.asarray(color, F32) / PAPER_LIGHT, 0, 1)
        d = clamp01(density)[..., None]
        self.rgb = (self.rgb * (1 - d + d * t)).astype(F32)

    def rgba(self):
        return np.concatenate([self.rgb, self.a[..., None]], -1)


# --------------------------------------------------------------------------------------------
# dry brush (bristle) texture driven by stroke coordinates from render_strokes()
# --------------------------------------------------------------------------------------------
_BRISTLE_CACHE = {}


def _bristle_tex(seed, along=60.0):
    key = (seed, along)
    if key not in _BRISTLE_CACHE:
        # rows = position across the brush (wraps), cols = along the stroke in px (wraps)
        n = gnoise(192, 4096, along, 0.9, seed=seed, wrap_x=True, wrap_y=True)
        n2 = gnoise(192, 4096, along * 0.25, 2.5, seed=seed + 1, wrap_x=True, wrap_y=True)
        _BRISTLE_CACHE[key] = (0.75 * n + 0.45 * n2).astype(F32)
    return _BRISTLE_CACHE[key]


def dry_brush(sd, *, seed=1, bristles=70.0, along=60.0, dry_start=0.55, dry_end=1.0,
              dryness=0.75, base_load=0.35, edge_dry=0.35, soft=0.12, pressure=None,
              wet_start=0.0):
    """Ink coverage for rendered strokes.

    sd: dict from render_strokes (a, arc, v, idx, lengths).  Returns ink amount 0..1 (already
    multiplied by coverage).  dryness grows from dry_start to dry_end of each stroke's length,
    breaking the stroke into bristle streaks ("flying white")."""
    a, arc, v, idx = sd["a"], sd["arc"], sd["v"], sd["idx"]
    lengths = sd["lengths"]
    tex = _bristle_tex(seed, along)
    ii = np.clip(idx, 0, len(lengths) - 1)
    L = np.maximum(lengths[ii], 1.0)
    t = clamp01(arc / L)
    per = (ii * 0.6180339 % 1.0).astype(F32)
    rows = ((v + 1) * 0.5 * bristles + per * 192.0) % 192.0
    cols = (arc + per * 4096.0 * 3.0) % 4096.0
    s = sample(tex, cols, rows, True, True)
    dry = dryness * smoothstep(dry_start, dry_end, t)
    if pressure is not None:
        dry = dry + pressure
    dry = dry + edge_dry * np.abs(v) ** 3
    if wet_start:
        dry = dry - wet_start * (1.0 - smoothstep(0.0, 0.12, t))
    # base_load: how much below-average bristles still carry ink when wet
    thresh = -1.6 + 3.2 * clamp01(dry) - base_load
    ink = smoothstep(thresh - soft * 4, thresh + soft * 4, s)
    return (a * ink).astype(F32)


# --------------------------------------------------------------------------------------------
# Blender: scene / render setup
# --------------------------------------------------------------------------------------------
_GPU_DONE = [False]


def setup_gpu():
    if _GPU_DONE[0]:
        return
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for t in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = t
            prefs.get_devices()
            devs = [d for d in prefs.devices if d.type == t]
            if devs:
                for d in prefs.devices:
                    d.use = d.type == t
                log("GPU", t, devs[0].name)
                break
        except Exception as e:  # pragma: no cover
            log("gpu setup failed for", t, e)
    _GPU_DONE[0] = True


def reset_scene():
    """Remove all datablocks we create so each generator starts clean."""
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.cameras,
                 bpy.data.lights, bpy.data.curves, bpy.data.textures, bpy.data.node_groups,
                 bpy.data.worlds, bpy.data.metaballs):
        for item in list(coll):
            try:
                coll.remove(item)
            except Exception:
                pass
    for im in list(bpy.data.images):
        if im.type == "IMAGE":
            bpy.data.images.remove(im)
    sc = bpy.context.scene
    w = bpy.data.worlds.new("World")
    sc.world = w
    set_world_color((0, 0, 0), 0.0)
    return sc


def _node_tree(idblock):
    try:
        idblock.use_nodes = True
    except Exception:
        pass
    return idblock.node_tree


def set_world_color(color, strength):
    w = bpy.context.scene.world
    nt = _node_tree(w)
    bg = nt.nodes.get("Background")
    if bg is None:
        nt.nodes.clear()
        bg = nt.nodes.new("ShaderNodeBackground")
        out = nt.nodes.new("ShaderNodeOutputWorld")
        nt.links.new(bg.outputs[0], out.inputs[0])
    bg.inputs["Color"].default_value = (*color, 1.0)
    bg.inputs["Strength"].default_value = strength


def setup_cycles(samples=32, denoise=False, transparent=True, bounces=0, filter_width=1.2):
    setup_gpu()
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "GPU"
    sc.cycles.samples = samples
    try:
        sc.cycles.use_adaptive_sampling = False
    except Exception:
        pass
    sc.cycles.use_denoising = denoise
    if denoise:
        try:
            sc.cycles.denoiser = "OPENIMAGEDENOISE"
        except Exception:
            pass
    sc.cycles.max_bounces = bounces
    sc.cycles.diffuse_bounces = bounces
    sc.cycles.glossy_bounces = 0
    sc.cycles.transmission_bounces = 0
    sc.cycles.transparent_max_bounces = 8
    sc.cycles.filter_width = filter_width
    sc.cycles.seed = 0
    sc.render.film_transparent = transparent
    sc.render.resolution_percentage = 100
    sc.render.pixel_aspect_x = sc.render.pixel_aspect_y = 1.0
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.view_settings.exposure = 0.0
    sc.view_settings.gamma = 1.0
    sc.render.use_compositing = False
    sc.render.use_sequencer = False
    return sc


def render_exr(name, w, h):
    """Render the current scene to a float EXR in _work and return HxWx4 (top-down, linear)."""
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y = w, h
    s = sc.render.image_settings
    s.file_format = "OPEN_EXR"
    s.color_depth = "32"
    s.color_mode = "RGBA"
    s.exr_codec = "ZIP"
    path = os.path.join(WORK, name + ".exr")
    sc.render.filepath = path
    t = time.time()
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path, check_existing=False)
    buf = np.empty(w * h * 4, F32)
    img.pixels.foreach_get(buf)
    bpy.data.images.remove(img)
    log(f"render {name} {w}x{h} {time.time() - t:.1f}s")
    return buf.reshape(h, w, 4)[::-1].copy()


def save_image(arr, path, quality=85):
    """Write a top-down float array (HxW, HxWx3 or HxWx4, sRGB 0..1) as WEBP or PNG via Blender."""
    arr = np.asarray(arr, F32)
    if arr.ndim == 2:
        arr = np.repeat(arr[..., None], 3, -1)
    h, w, c = arr.shape
    rgba = np.ones((h, w, 4), F32)
    rgba[..., :c] = clamp01(arr)
    img = bpy.data.images.new("__out", w, h, alpha=(c == 4), float_buffer=False)
    img.colorspace_settings.name = "sRGB"
    img.pixels.foreach_set(np.ascontiguousarray(rgba[::-1]).ravel())
    sc = bpy.context.scene
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.view_settings.exposure = 0.0
    sc.view_settings.gamma = 1.0
    s = sc.render.image_settings
    ext = os.path.splitext(path)[1].lower()
    s.file_format = "WEBP" if ext == ".webp" else "PNG"
    s.color_mode = "RGBA" if c == 4 else "RGB"
    if ext == ".webp":
        s.quality = quality
    else:
        s.color_depth = "8"
        s.compression = 90
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save_render(path, scene=sc)
    bpy.data.images.remove(img)
    log("wrote", path, f"{os.path.getsize(path) / 1024:.0f} KB")


def load_image(path):
    """Load an image file into a top-down float array (sRGB values for 8-bit files)."""
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    buf = np.empty(w * h * 4, F32)
    img.pixels.foreach_get(buf)
    bpy.data.images.remove(img)
    return buf.reshape(h, w, 4)[::-1].copy()


# --------------------------------------------------------------------------------------------
# Blender: meshes
# --------------------------------------------------------------------------------------------
def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def mesh_from_arrays(name, verts, face_sizes, loop_verts, attrs=None):
    """Fast mesh construction. verts (n,3); face_sizes (m,); loop_verts (sum sizes,).
    attrs: {name: (n,3) float array} stored as POINT FLOAT_VECTOR attributes."""
    me = bpy.data.meshes.new(name)
    verts = np.ascontiguousarray(verts, F32)
    me.vertices.add(len(verts))
    me.vertices.foreach_set("co", verts.ravel())
    me.loops.add(len(loop_verts))
    me.loops.foreach_set("vertex_index", np.ascontiguousarray(loop_verts, np.int32))
    starts = np.concatenate([[0], np.cumsum(face_sizes)[:-1]]).astype(np.int32)
    me.polygons.add(len(face_sizes))
    me.polygons.foreach_set("loop_start", starts)
    me.update(calc_edges=True)
    for an, av in (attrs or {}).items():
        at = me.attributes.new(an, "FLOAT_VECTOR", "POINT")
        at.data.foreach_set("vector", np.ascontiguousarray(av, F32).ravel())
    return me


def grid_mesh(name, X, Y, Z):
    """Quad grid mesh from 2D arrays (ny, nx) of Blender coordinates."""
    ny, nx = Z.shape
    verts = np.stack([X, Y, Z], -1).reshape(-1, 3)
    j, i = np.meshgrid(np.arange(nx - 1), np.arange(ny - 1))
    a = (i * nx + j).ravel()
    quads = np.stack([a, a + 1, a + nx + 1, a + nx], -1).ravel()
    sizes = np.full(len(a), 4, np.int32)
    me = mesh_from_arrays(name, verts, sizes, quads)
    if hasattr(me, "shade_smooth"):
        me.shade_smooth()
    else:
        me.polygons.foreach_set("use_smooth", np.ones(len(me.polygons), bool))
    return me


def mat_emission_attr(name="sd", attr="sd"):
    mat = bpy.data.materials.new(name)
    nt = _node_tree(mat)
    nt.nodes.clear()
    at = nt.nodes.new("ShaderNodeAttribute")
    at.attribute_name = attr
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Strength"].default_value = 1.0
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(at.outputs["Vector"], em.inputs["Color"])
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    return mat


def mat_diffuse(color=(0.8, 0.8, 0.8)):
    mat = bpy.data.materials.new("diffuse")
    nt = _node_tree(mat)
    nt.nodes.clear()
    df = nt.nodes.new("ShaderNodeBsdfDiffuse")
    df.inputs["Color"].default_value = (*color, 1)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(df.outputs[0], out.inputs["Surface"])
    return mat


def mat_data():
    """Emission = (world Z, view distance, object pass_index)."""
    mat = bpy.data.materials.new("data")
    nt = _node_tree(mat)
    nt.nodes.clear()
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    cam = nt.nodes.new("ShaderNodeCameraData")
    oi = nt.nodes.new("ShaderNodeObjectInfo")
    comb = nt.nodes.new("ShaderNodeCombineXYZ")
    em = nt.nodes.new("ShaderNodeEmission")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(geo.outputs["Position"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], comb.inputs["X"])
    nt.links.new(cam.outputs["View Distance"], comb.inputs["Y"])
    nt.links.new(oi.outputs["Object Index"], comb.inputs["Z"])
    nt.links.new(comb.outputs[0], em.inputs["Color"])
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    return mat


def mat_normal():
    """Emission = world-space shading normal."""
    mat = bpy.data.materials.new("normal")
    nt = _node_tree(mat)
    nt.nodes.clear()
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    em = nt.nodes.new("ShaderNodeEmission")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(geo.outputs["Normal"], em.inputs["Color"])
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    return mat


def g2b(p):
    """Game coords (x right, y up, z toward viewer) -> Blender (X, Y=-z, Z=y)."""
    return (p[0], -p[2], p[1])


def quad_camera(rect, z_layer, cam_pos=(0.0, 1.7, 10.0)):
    """Perspective camera at the game's default eye whose frame is exactly the layer quad
    rect=(x0, x1, y0, y1) lying at game z=z_layer.  3D content placed beyond the quad renders as
    the default camera would see it through that quad."""
    x0, x1, y0, y1 = rect
    d = cam_pos[2] - z_layer
    width = x1 - x0
    cam = bpy.data.cameras.new("cam")
    cam.type = "PERSP"
    cam.sensor_fit = "HORIZONTAL"
    cam.sensor_width = 36.0
    cam.lens = 36.0 * d / width
    cam.shift_x = ((x0 + x1) / 2 - cam_pos[0]) / width
    cam.shift_y = ((y0 + y1) / 2 - cam_pos[1]) / width
    cam.clip_start = 0.5
    cam.clip_end = 1.0e5
    ob = link(bpy.data.objects.new("cam", cam))
    ob.location = g2b(cam_pos)
    ob.rotation_euler = (math.pi / 2, 0.0, 0.0)
    bpy.context.scene.camera = ob
    return ob


def ortho_camera_px(w, h):
    """Orthographic camera looking down -Z onto the XY plane, 1 unit = 1 pixel, origin at the
    image's bottom-left (image y down maps to world Y = h - y)."""
    cam = bpy.data.cameras.new("ocam")
    cam.type = "ORTHO"
    cam.sensor_fit = "HORIZONTAL"
    cam.ortho_scale = float(w)
    cam.clip_start = 0.1
    cam.clip_end = 1000.0
    ob = link(bpy.data.objects.new("ocam", cam))
    ob.location = (w / 2.0, h / 2.0, 500.0)
    ob.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.scene.camera = ob
    return ob


def sun_light(direction, strength=3.0, angle_deg=2.0):
    """direction: Blender-space vector the light travels along."""
    from mathutils import Vector
    li = bpy.data.lights.new("sun", "SUN")
    li.energy = strength
    li.angle = math.radians(angle_deg)
    ob = link(bpy.data.objects.new("sun", li))
    ob.rotation_euler = Vector(direction).normalized().to_track_quat("-Z", "Y").to_euler()
    return ob


# --------------------------------------------------------------------------------------------
# Blender: brush strokes as ribbon meshes
# --------------------------------------------------------------------------------------------
def resample_polyline(pts, step=2.0):
    pts = np.asarray(pts, np.float64)
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    n = max(2, int(s[-1] / step) + 1)
    t = np.linspace(0, s[-1], n)
    return np.stack([np.interp(t, s, pts[:, 0]), np.interp(t, s, pts[:, 1])], -1)


def smooth_polyline(pts, iters=2):
    p = np.asarray(pts, np.float64).copy()
    for _ in range(iters):
        q = p.copy()
        q[1:-1] = 0.25 * p[:-2] + 0.5 * p[1:-1] + 0.25 * p[2:]
        p = q
    return p


def render_strokes(strokes, w, h, polys=(), samples=24, name="strokes", wrap_x=False,
                   wrap_y=False):
    """Rasterise brush strokes with Cycles.

    strokes: list of (pts (N,2) px, x right / y down, widths (N,) px).
    polys:   list of (N,2) px polygons (filled, each gets its own idx after the strokes).
    wrap_x/wrap_y: also render copies shifted by +-w / +-h so the result tiles seamlessly.
    Returns dict(a=coverage, arc=px along stroke, v=-1..1 across, idx=int index (-1 none),
    lengths=array of stroke lengths)."""
    reset_scene()
    setup_cycles(samples=samples, filter_width=1.0)
    verts, sizes, loops, data = [], [], [], []
    nv = 0
    lengths = []
    shifts = [(0.0, 0.0)]
    if wrap_x:
        shifts += [(-w, 0.0), (w, 0.0)]
    if wrap_y:
        shifts += [(dx, s) for (dx, _) in list(shifts) for s in (-h, h)]
    order = 0
    for k, (pts, wid) in enumerate(strokes):
        P = np.asarray(pts, np.float64)
        W = np.asarray(wid, np.float64)
        if len(P) < 2:
            lengths.append(1.0)
            continue
        d = np.gradient(P, axis=0)
        d /= np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
        nrm = np.stack([-d[:, 1], d[:, 0]], -1)
        arc = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
        lengths.append(max(arc[-1], 1.0))
        L = P + nrm * (W[:, None] / 2)
        R = P - nrm * (W[:, None] / 2)
        n = len(P)
        for (sx, sy) in shifts:
            vv = np.empty((2 * n, 3))
            vv[0::2, 0] = L[:, 0] + sx
            vv[0::2, 1] = h - (L[:, 1] + sy)
            vv[1::2, 0] = R[:, 0] + sx
            vv[1::2, 1] = h - (R[:, 1] + sy)
            vv[:, 2] = order * 1e-3
            dd = np.empty((2 * n, 3))
            dd[0::2, 0] = arc
            dd[1::2, 0] = arc
            dd[0::2, 1] = -1.0
            dd[1::2, 1] = 1.0
            dd[:, 2] = k
            i = np.arange(n - 1)
            q = np.stack([2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2], -1).ravel() + nv
            verts.append(vv)
            data.append(dd)
            loops.append(q)
            sizes.append(np.full(n - 1, 4, np.int32))
            nv += 2 * n
        order += 1
    base = len(strokes)
    for j, poly in enumerate(polys):
        P = np.asarray(poly, np.float64)
        n = len(P)
        for (sx, sy) in shifts:
            vv = np.empty((n, 3))
            vv[:, 0] = P[:, 0] + sx
            vv[:, 1] = h - (P[:, 1] + sy)
            vv[:, 2] = order * 1e-3
            dd = np.zeros((n, 3))
            dd[:, 2] = base + j
            verts.append(vv)
            data.append(dd)
            # ensure counter-clockwise doesn't matter for emission; one ngon
            loops.append(np.arange(n) + nv)
            sizes.append(np.array([n], np.int32))
            nv += n
        order += 1
        lengths.append(1.0)
    if not verts:
        z = np.zeros((h, w), F32)
        return dict(a=z, arc=z, v=z, idx=np.full((h, w), -1, np.int64), lengths=np.ones(1))
    me = mesh_from_arrays(name, np.concatenate(verts), np.concatenate(sizes),
                          np.concatenate(loops), {"sd": np.concatenate(data)})
    ob = link(bpy.data.objects.new(name, me))
    me.materials.append(mat_emission_attr())
    ortho_camera_px(w, h)
    img = render_exr(name, w, h)
    a = img[..., 3]
    inv = 1.0 / np.maximum(a, 1e-6)
    arc = img[..., 0] * inv
    v = np.clip(img[..., 1] * inv, -1, 1)
    idx = np.where(a > 1e-4, np.rint(img[..., 2] * inv), -1).astype(np.int64)
    return dict(a=clamp01(a), arc=arc.astype(F32), v=v.astype(F32), idx=idx,
                lengths=np.asarray(lengths, F32))


def cap_start(path, wid, m=10, bulge=1.0):
    """Prepend a rounded (semicircular) brush-press cap to a stroke."""
    P = np.asarray(path, np.float64)
    W = np.asarray(wid, np.float64)
    t0 = P[1] - P[0]
    t0 /= np.linalg.norm(t0) + 1e-9
    r = W[0] / 2 * bulge
    phi = np.linspace(0.12, np.pi / 2, m, endpoint=False)
    pts = P[0][None] - t0[None] * (r * np.cos(phi))[:, None]
    ws = 2 * r * np.sin(phi) * (W[0] / (2 * r))
    return np.concatenate([pts, P]), np.concatenate([ws, W])


def cap_end(path, wid, m=10):
    P, W = cap_start(np.asarray(path)[::-1], np.asarray(wid)[::-1], m)
    return P[::-1].copy(), W[::-1].copy()


def taper(n, w0, start=0.15, end=0.35, start_w=0.2, end_w=0.0, power=0.8):
    """Width profile: swell from start_w*w0 to w0 over `start`, hold, taper to end_w over `end`."""
    t = np.linspace(0, 1, n)
    s = np.clip(t / max(start, 1e-6), 0, 1) ** power
    e = np.clip((1 - t) / max(end, 1e-6), 0, 1) ** power
    prof = np.minimum(start_w + (1 - start_w) * s, end_w + (1 - end_w) * e)
    return w0 * prof


def wobble_path(p0, p1, n, amp, seed, freq=2.0):
    """Polyline from p0 to p1 with a smooth lateral wobble of amplitude amp px."""
    r = rng(seed)
    p0 = np.asarray(p0, np.float64)
    p1 = np.asarray(p1, np.float64)
    t = np.linspace(0, 1, n)
    d = p1 - p0
    L = np.linalg.norm(d) + 1e-9
    nrm = np.array([-d[1], d[0]]) / L
    ph = r.uniform(0, 2 * np.pi, 3)
    off = amp * (np.sin(2 * np.pi * freq * t + ph[0]) * 0.6
                 + np.sin(2 * np.pi * freq * 2.3 * t + ph[1]) * 0.3
                 + np.sin(2 * np.pi * freq * 0.5 * t + ph[2]) * 0.4) * np.sin(np.pi * t)
    return p0[None] + d[None] * t[:, None] + nrm[None] * off[:, None]
