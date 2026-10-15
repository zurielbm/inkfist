"""Reusable stylised body / clothing part generators. All return (verts, faces) in Blender space."""
import math
import random
from mathutils import Vector, Matrix, Quaternion

from .core import sweep, ellipsoid, lerp, smoothstep


def rings_z(rings, segs=16, power=2.0, cap0=True, cap1=True, x=0.0):
    """rings: list of (z, rx, ry, yoff[, xoff]) bottom->top or top->bottom. Sweep along Z."""
    path = [Vector((x + (r[4] if len(r) > 4 else 0.0), r[3], r[0])) for r in rings]
    radii = [(r[1], r[2]) for r in rings]
    return sweep(path, radii, segs=segs, ref=Vector((1, 0, 0)), power=power, cap0=cap0, cap1=cap1)


def limb(top, bottom, radii, segs=12, power=2.0, ref=Vector((1, 0, 0))):
    """Straight tapered limb from top to bottom with len(radii) rings."""
    top, bottom = Vector(top), Vector(bottom)
    n = len(radii)
    path = [top.lerp(bottom, i / (n - 1)) for i in range(n)]
    return sweep(path, radii, segs=segs, ref=ref, power=power)


def ring_loop(center, rx, ry, section, segs=24, sec_segs=8, z_wave=None):
    """Closed ring (belt, scarf wrap, bead string path). section=(height, thickness)."""
    c = Vector(center)
    path = []
    for k in range(segs):
        a = 2 * math.pi * k / segs
        z = c.z + (z_wave(a) if z_wave else 0.0)
        path.append(Vector((c.x + rx * math.cos(a), c.y + ry * math.sin(a), z)))
    return sweep(path, [section] * segs, segs=sec_segs, ref=Vector((0, 0, 1)), closed=True)


def shell_panel(z_top, z_bot, th0, th1, r_top, r_bot, thick=0.012, nz=7, nth=9,
                flare_pow=1.0, center=(0.0, 0.0), sway=None, hem_wave=0.0, seed=0):
    """A curved cloth panel wrapping around the body axis (closed shell with thickness).
    Angles: 0 = char-left (+X), -pi/2 = front (-Y), +pi/2 = back (+Y).
    sway: optional function(t_down, theta) -> Vector offset (e.g. trailing back)."""
    rnd = random.Random(seed)
    waves = [rnd.uniform(-1, 1) for _ in range(nth)]
    outer, inner = [], []
    cx, cy = center
    for i in range(nz):
        t = i / (nz - 1)
        tt = t ** flare_pow
        rx = lerp(r_top[0], r_bot[0], tt)
        ry = lerp(r_top[1], r_bot[1], tt)
        for j in range(nth):
            u = j / (nth - 1)
            th = lerp(th0, th1, u)
            z = lerp(z_top, z_bot, t)
            if i == nz - 1 and hem_wave:
                z += hem_wave * waves[j]
            c, s = math.cos(th), math.sin(th)
            off = sway(t, th) if sway else Vector()
            outer.append(Vector((cx + rx * c, cy + ry * s, z)) + off)
            inner.append(Vector((cx + (rx - thick) * c, cy + (ry - thick) * s, z)) + off)
    verts = outer + inner
    N = nz * nth
    faces = []

    def o(i, j):
        return i * nth + j

    def n(i, j):
        return N + i * nth + j

    for i in range(nz - 1):
        for j in range(nth - 1):
            faces.append((o(i, j), o(i + 1, j), o(i + 1, j + 1), o(i, j + 1)))
            faces.append((n(i, j), n(i, j + 1), n(i + 1, j + 1), n(i + 1, j)))
    for j in range(nth - 1):
        faces.append((o(0, j), o(0, j + 1), n(0, j + 1), n(0, j)))
        faces.append((o(nz - 1, j), n(nz - 1, j), n(nz - 1, j + 1), o(nz - 1, j + 1)))
    for i in range(nz - 1):
        faces.append((o(i, 0), n(i, 0), n(i + 1, 0), o(i + 1, 0)))
        faces.append((o(i, nth - 1), o(i + 1, nth - 1), n(i + 1, nth - 1), n(i, nth - 1)))
    return verts, faces


def strip(path, width, thick=0.008, normal_hint=Vector((0, 1, 0)), taper=None):
    """Flat ribbon (scarf tail, sash end, lapel). width along the in-surface direction."""
    n = len(path)
    radii = []
    for i in range(n):
        w = width * (taper(i / (n - 1)) if taper else 1.0)
        radii.append((thick, w))
    return sweep(path, radii, segs=8, ref=normal_hint, power=2.6)


def lock(root, direction, length, radius, gravity=0.3, curl=Vector((0, 0, 0)), segs=6, flat=0.55,
         out_hint=None, n=5):
    """Tapered hair lock (brush-stroke-like spike). direction: unit-ish Vector."""
    d = Vector(direction).normalized()
    root = Vector(root)
    pts = []
    for i in range(n):
        t = i / (n - 1)
        p = root + d * (length * t) + Vector((0, 0, -gravity * length * t * t)) + curl * (t * t)
        pts.append(p)
    radii = []
    for i in range(n):
        t = i / (n - 1)
        r = radius * (1 - t) ** 0.9 + 0.0015
        radii.append((r * flat, r))
    ref = out_hint if out_hint is not None else None
    return sweep(pts, radii, segs=segs, ref=ref, cap0=True, cap1=True)


def scatter_scalp(center, radii, n, seed, z_min_frac=-0.2, back_bias=0.0, avoid_face=True):
    """Points + outward normals on the upper/back part of a scalp ellipsoid."""
    rnd = random.Random(seed)
    c = Vector(center)
    out = []
    tries = 0
    while len(out) < n and tries < n * 50:
        tries += 1
        u = rnd.uniform(-1, 1)
        th = rnd.uniform(0, 2 * math.pi)
        r = math.sqrt(1 - u * u)
        v = Vector((r * math.cos(th), r * math.sin(th), u))
        if v.z < z_min_frac:
            continue
        if avoid_face and v.y < -0.35 and v.z < 0.45:
            continue
        if back_bias and v.y < 0 and rnd.random() < back_bias:
            continue
        p = Vector((c.x + radii[0] * v.x, c.y + radii[1] * v.y, c.z + radii[2] * v.z))
        nrm = Vector((v.x / radii[0], v.y / radii[1], v.z / radii[2])).normalized()
        out.append((p, nrm))
    return out


def fist(center, side, size=1.0):
    """A blocky stylised fist (knuckles forward = -Y when arm hangs down... bound to hand bone)."""
    c = Vector(center)
    s = size
    v1, f1 = ellipsoid(c, 0.040 * s, 0.047 * s, 0.050 * s, segs=10, rings=7)
    thumb_c = c + Vector((-0.032 * s if side == 'L' else 0.032 * s, -0.022 * s, 0.012 * s))
    thumb_c = c + Vector((0.0, -0.035 * s, 0.01 * s))
    v2, f2 = ellipsoid(thumb_c, 0.016 * s, 0.016 * s, 0.026 * s, segs=8, rings=5)
    off = len(v1)
    return v1 + v2, f1 + [tuple(i + off for i in f) for f in f2]


def merge(*geos):
    verts, faces = [], []
    for v, f in geos:
        off = len(verts)
        verts.extend(v)
        faces.extend(tuple(i + off for i in ff) for ff in f)
    return verts, faces


def eye(center, w, h, tilt_deg, side):
    """Flattened almond eye shape."""
    s = 1 if side == 'L' else -1
    rot = Matrix.Rotation(math.radians(-s * tilt_deg), 3, 'Y')
    return ellipsoid(center, w, 0.006, h, segs=10, rings=6, rot=rot)


def brow(center, w, h, tilt_deg, side):
    s = 1 if side == 'L' else -1
    rot = Matrix.Rotation(math.radians(-s * tilt_deg), 3, 'Y')
    return ellipsoid(center, w, 0.006, h, segs=8, rings=5, rot=rot)
