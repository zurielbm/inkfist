"""Garment construction on top of the body: extracted shells (inherit the body's quad flow, UVs and weights),
loosening with a no-poke-through projection, hem straightening, ring extrusion (skirts, cuffs), slits, and
surface-following bands (collars, sashes)."""
import math

import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

from .part import Part


def smoothstep(e0, e1, x):
    t = np.clip((np.asarray(x, float) - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


class Surface:
    """BVH over a mesh (body or another garment) for nearest-point and clearance queries."""

    def __init__(self, co, faces):
        self.co = np.asarray(co, float)
        self.faces = faces
        self.bvh = BVHTree.FromPolygons([tuple(map(float, v)) for v in self.co], [tuple(f) for f in faces])

    def nearest(self, p):
        loc, nrm, idx, d = self.bvh.find_nearest(Vector(tuple(map(float, p))))
        return np.array(loc), np.array(nrm), idx, d

    def push_out(self, pts, gap, normals_hint=None):
        """Move points that are inside / closer than `gap` to the surface outward along the surface normal."""
        out = np.array(pts, float)
        for i, p in enumerate(out):
            loc, nrm, idx, d = self.nearest(p)
            if idx is None:
                continue
            s = (p - loc) @ nrm
            g = gap[i] if np.ndim(gap) else gap
            if s < g:
                out[i] = p + nrm * (g - s)
        return out

    def raycast(self, origin, direction, dist=10.0):
        loc, nrm, idx, d = self.bvh.ray_cast(Vector(tuple(map(float, origin))), Vector(tuple(map(float, direction))), dist)
        return None if loc is None else (np.array(loc), np.array(nrm), d)


# ---------------------------------------------------------------- topology helpers

def adjacency(nv, faces):
    adj = [set() for _ in range(nv)]
    for f in faces:
        for k in range(len(f)):
            a, b = f[k], f[(k + 1) % len(f)]
            adj[a].add(b)
            adj[b].add(a)
    return adj


def boundary_loops(faces):
    """Ordered boundary loops (vertex index lists) of a polygon soup; orientation follows the faces."""
    from collections import Counter, defaultdict
    cnt = Counter()
    directed = {}
    for f in faces:
        for k in range(len(f)):
            a, b = f[k], f[(k + 1) % len(f)]
            cnt[(min(a, b), max(a, b))] += 1
            directed[(a, b)] = True
    nxt = defaultdict(list)
    for (a, b) in directed:
        if cnt[(min(a, b), max(a, b))] == 1:
            nxt[a].append(b)
    loops, seen = [], set()
    for a in list(nxt):
        if a in seen:
            continue
        loop, cur = [a], a
        seen.add(a)
        while True:
            cand = [v for v in nxt[cur] if v not in seen]
            if not cand:
                break
            cur = cand[0]
            loop.append(cur)
            seen.add(cur)
        loops.append(loop)
    return loops


def laplacian(co, adj, iters=1, lam=0.5, fixed=None):
    co = np.array(co, float)
    nb = [np.fromiter(a, int) for a in adj]
    for _ in range(iters):
        avg = np.array([co[n].mean(0) if len(n) else co[i] for i, n in enumerate(nb)])
        new = co + lam * (avg - co)
        if fixed is not None:
            new[fixed] = co[fixed]
        co = new
    return co


def taubin(co, adj, iters=10, lam=0.5, mu=-0.53, weight=None):
    """Volume-preserving smoothing (lambda/mu). weight: per-vertex blend (0 = keep)."""
    co0 = np.array(co, float)
    co = co0.copy()
    nb = [np.fromiter(a, int) for a in adj]
    for _ in range(iters):
        for f in (lam, mu):
            avg = np.array([co[n].mean(0) if len(n) else co[i] for i, n in enumerate(nb)])
            co = co + f * (avg - co)
    if weight is not None:
        w = np.asarray(weight, float)[:, None]
        co = co0 + (co - co0) * w
    return co


def surface_where(part, pred):
    """Surface over the faces of a part whose centroid satisfies pred(centroid)."""
    faces = [f for f in part.faces if pred(part.co[list(f)].mean(0))]
    return Surface(part.co, faces)


def surface_of(*items):
    """Surface over several (co, faces) pairs or Parts (solidified Parts contribute only their outer layer, so
    clearance never pushes against an inward-facing lining)."""
    cos, fs, off = [], [], 0
    for it in items:
        if hasattr(it, 'co'):
            c, f = it.co, it.faces[:getattr(it, 'n_outer', len(it.faces))]
        else:
            c, f = it
        cos.append(np.asarray(c, float))
        fs += [tuple(v + off for v in ff) for ff in f]
        off += len(c)
    return Surface(np.concatenate(cos), fs)


def vertex_normals(co, faces):
    n = np.zeros_like(co)
    for f in faces:
        p = co[list(f)]
        fn = np.zeros(3)
        for k in range(len(f)):
            fn += np.cross(p[k], p[(k + 1) % len(f)])
        n[list(f)] += fn
    ln = np.linalg.norm(n, axis=1)
    ln[ln < 1e-12] = 1
    return n / ln[:, None]


# ---------------------------------------------------------------- shells

def shell(body_topo, body_co, vmask, name, paint, offset=0.006, loosen=None, smooth=0, min_gap=0.003,
          group='body', fmask=None, texel=1.0, clear=None, membrane=True, hard=None):
    """Copy the body faces whose vertices are all in vmask (or faces in fmask), push them out along normals.

    offset: scalar or per-body-vertex array (metres). loosen: optional per-body-vertex extra offset.
    smooth: Laplacian iterations removing anatomy (boundary kept), followed by a clearance push-out."""
    faces = body_topo.faces
    if fmask is None:
        fmask = [all(vmask[v] for v in f) for f in faces]
    fmask = fix_pinches(body_topo, fmask)
    keep = [i for i, m in enumerate(fmask) if m]
    used = sorted({v for i in keep for v in faces[i]})
    remap = {v: k for k, v in enumerate(used)}
    sf = [tuple(remap[v] for v in faces[i]) for i in keep]
    uv = np.concatenate([body_topo.uv[body_topo.starts[i]:body_topo.starts[i] + body_topo.sizes[i]] for i in keep])
    src = np.array(used)
    n = body_topo.vertex_normals(body_co)[src]
    off = offset[src] if np.ndim(offset) else np.full(len(src), offset)
    if loosen is not None:
        off = off + (loosen[src] if np.ndim(loosen) else loosen)
    co = body_co[src] + n * off[:, None]
    layers = _layers(clear if clear is not None else Surface(body_co, body_topo.faces))
    gap = np.maximum(off, min_gap) if membrane else np.full(len(co), min_gap)
    if smooth:
        # cloth tension: relax + clear, repeated -> the fabric tents over bumps instead of following valleys
        adj = adjacency(len(co), sf)
        for _ in range(smooth):
            co = laplacian(co, adj, 1, 0.5)
            co = clear_layers(co, layers, gap)
    else:
        co = clear_layers(co, layers, np.full(len(co), min_gap))
    if hard is not None:
        co = clear_layers(co, _layers(hard), np.full(len(co), min_gap), passes=2)
    p = Part(name, co, sf, paint, group, uv=uv, src=src, texel=texel)
    p.attrs['offset'] = off
    return p


def waist_loop(part, z=None):
    """The open ring around the torso (centred on the body axis), not a sleeve cuff that happens to hang lower."""
    loops = boundary_loops(part.faces)

    def score(L):
        c = part.co[L].mean(0)
        return abs(c[0]) * 4 + (abs(c[2] - z) if z is not None else 0.0) - 0.001 * len(L)
    return min(loops, key=score)


def fix_pinches(topo, fmask, max_iter=20):
    """Grow a face selection until every boundary vertex has exactly two boundary edges (no bowtie vertices,
    which would make boundary loops visit a vertex twice and hems/rims collapse)."""
    fmask = list(bool(m) for m in fmask)
    for _ in range(max_iter):
        bcount = {}
        for fi, f in enumerate(topo.faces):
            if not fmask[fi]:
                continue
            for k in range(len(f)):
                a, b = f[k], f[(k + 1) % len(f)]
                e = (min(a, b), max(a, b))
                sel = sum(1 for g in topo.edge_faces[e] if fmask[g])
                if sel == 1:
                    bcount[a] = bcount.get(a, 0) + 1
                    bcount[b] = bcount.get(b, 0) + 1
        pinch = [v for v, c in bcount.items() if c > 2]
        if not pinch:
            break
        for v in pinch:
            for fi in topo.vert_faces[v]:
                fmask[fi] = True
    return fmask


def layer_over(top, under, gap, rings=2):
    """Exact layering for shells cut from the same body: every `top` vertex sits at least `gap` above the `under`
    vertex made from the same body vertex (along that vertex's normal); the correction is feathered a few rings
    into the neighbours so it never creates a dent."""
    if top.src is None or under.src is None:
        return
    idx = {}
    for i, s in enumerate(under.src):
        if s >= 0:
            idx.setdefault(int(s), i)      # outer copy (solidify appends the inner copies after it)
    un = vertex_normals(under.co, under.faces[:getattr(under, 'n_outer', len(under.faces))])
    delta = np.zeros_like(top.co)
    for i, s in enumerate(top.src):
        j = idx.get(int(s)) if s >= 0 else None
        if j is None:
            continue
        n = un[j]
        d = (top.co[i] - under.co[j]) @ n
        if d < gap:
            delta[i] = n * (gap - d)
    adj = adjacency(top.nv, top.faces)
    moved = np.linalg.norm(delta, axis=1) > 0
    for _ in range(rings):
        avg = np.array([delta[list(a)].mean(0) if a else 0 for a in adj])
        delta = np.where(moved[:, None], delta, avg * 0.8)
    top.co = top.co + delta


def _layers(spec):
    """Surface | [Surface | (Surface, gap)] -> [(Surface, gap or None)]."""
    if isinstance(spec, (list, tuple)):
        return [x if isinstance(x, tuple) else (x, None) for x in spec]
    return [(spec, None)]


def clear_layers(co, layers, gap, passes=1):
    """Push points out of every layer in turn (each layer's own nearest surface -> no confusion between a
    smoothed body proxy and a garment that protrudes above it). gap: default per-point gap; a layer's own gap
    (if given) overrides it."""
    for _ in range(passes):
        for surf, g in layers:
            co = surf.push_out(co, gap if g is None else np.full(len(co), g))
    return co


def straighten(part, loop, plane_point, plane_normal, blend_rings=2):
    """Project a boundary loop onto a plane (clean hem/cuff line) and relax the next rings toward it."""
    n = np.asarray(plane_normal, float)
    n /= np.linalg.norm(n)
    c = np.asarray(plane_point, float)
    co = part.co
    adj = adjacency(part.nv, part.faces)
    ring = list(loop)
    seen = set(ring)
    w = 1.0
    for k in range(blend_rings + 1):
        for v in ring:
            d = (co[v] - c) @ n
            co[v] -= n * d * w
        nxt = set()
        for v in ring:
            nxt |= adj[v] - seen
        seen |= nxt
        ring = list(nxt)
        w *= 0.45
    part.co = co


def resample_loop(pts, n, closed=True):
    """Resample a polyline to n points evenly by arc length."""
    P = np.asarray(pts, float)
    if closed:
        P = np.vstack([P, P[:1]])
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    t = np.linspace(0, s[-1], n, endpoint=not closed)
    return np.array([np.interp(t, s, P[:, k]) for k in range(3)]).T


def extrude_rings(part, loop, rings, closed=True, pat_origin=0.0, uv_island=True):
    """Extrude boundary `loop` (vertex indices, ordered) through successive ring positions.

    rings: list of (len(loop), 3) arrays. New faces get their own parametric UV island (s along loop, d down)
    and pattern coords (metres). Returns list of new vertex index rings (including the original loop first)."""
    co = list(part.co)
    faces = list(part.faces)
    base = part.nv
    m = len(loop)
    all_rings = [list(loop)]
    for r in rings:
        idx = list(range(len(co), len(co) + m))
        co.extend(np.asarray(r, float))
        all_rings.append(idx)
    co = np.array(co)
    # arc-length param of each ring column (from the first ring) and cumulative distance down
    P0 = co[all_rings[0]]
    seg = np.linalg.norm(np.roll(P0, -1, 0) - P0, axis=1) if closed else np.r_[np.linalg.norm(np.diff(P0, axis=0), axis=1), 0]
    s = np.concatenate([[0], np.cumsum(seg)])[:m + (1 if closed else 0)]
    down = [np.zeros(m)]
    for k in range(1, len(all_rings)):
        down.append(down[-1] + np.linalg.norm(co[all_rings[k]] - co[all_rings[k - 1]], axis=1))
    new_faces, new_uv, new_pat = [], [], []
    cols = m if closed else m - 1
    for k in range(len(all_rings) - 1):
        A, B = all_rings[k], all_rings[k + 1]
        for j in range(cols):
            j2 = (j + 1) % m
            f = (A[j], B[j], B[j2], A[j2])
            sj, sj2 = s[j], s[j + 1] if j + 1 < len(s) else s[-1]
            uvs = [(sj, -down[k][j]), (sj, -down[k + 1][j]), (sj2, -down[k + 1][j2]), (sj2, -down[k][j2])]
            new_faces.append(f)
            new_uv.extend(uvs)
            new_pat.extend([(u, pat_origin - v) for u, v in uvs])
    # orientation: match the adjacent existing face winding (flip if needed)
    if part.faces:
        a, b = loop[0], loop[1]
        same_dir = any(_has_edge(f, a, b) for f in part.faces)
        if same_dir:
            new_faces = [tuple(reversed(f)) for f in new_faces]
            new_uv = _reverse_loops(new_uv, 4)
            new_pat = _reverse_loops(new_pat, 4)
    uv = np.concatenate([part.uv if part.uv is not None else np.zeros((sum(len(f) for f in faces), 2)), np.array(new_uv)])
    pat = np.concatenate([part.pat if part.pat is not None else np.zeros((sum(len(f) for f in faces), 2)), np.array(new_pat)])
    part.co = co
    part.faces = faces + new_faces
    part.uv = uv
    part.pat = pat
    nv_new = len(co) - base
    part.outline = np.concatenate([part.outline, np.full(nv_new, part.outline.mean() if len(part.outline) else 1.0)])
    for k, v in list(part.attrs.items()):
        # feature parameters ('*_t': position along a skirt/sleeve) are -1 where the feature is absent
        part.attrs[k] = np.concatenate([np.asarray(v), np.full(nv_new, -1.0 if k.endswith('_t') else 0.0)])
    if part.src is not None:
        part.src = np.concatenate([part.src, np.full(nv_new, -1)])
    return all_rings


def _has_edge(f, a, b):
    for k in range(len(f)):
        if f[k] == a and f[(k + 1) % len(f)] == b:
            return True
    return False


def _reverse_loops(lst, n):
    out = []
    for i in range(0, len(lst), n):
        out.extend(lst[i:i + n][::-1])
    return out


def split_column(part, rings, col, from_ring):
    """Cut a slit: duplicate the vertices of column `col` for rings >= from_ring so faces on either side separate."""
    co = list(part.co)
    dup = {}
    for k in range(from_ring, len(rings)):
        v = rings[k][col]
        dup[v] = len(co)
        co.append(part.co[v].copy())
    # faces whose column index (left edge) == col use the duplicate on their left side (A[j], B[j])
    newf = []
    for f in part.faces:
        newf.append(f)
    for fi, f in enumerate(part.faces):
        # a ring face (A[j], B[j], B[j2], A[j2]) or reversed; reassign verts of col for faces right of the slit.
        # The row just above the first duplicated ring is included so the slit closes at a single apex vertex.
        for k in range(max(0, from_ring - 1), len(rings) - 1):
            A, B = rings[k], rings[k + 1]
            m = len(A)
            j = col
            jr = (j + 1) % m
            quad = {A[j], B[j], A[jr], B[jr]}
            if set(f) == quad:
                newf[fi] = tuple(dup.get(v, v) if v in (A[j], B[j]) else v for v in f)
    nv_new = len(co) - part.nv
    part.co = np.array(co)
    part.faces = newf
    part.outline = np.concatenate([part.outline, part.outline[list(dup.keys())]])
    for k, v in list(part.attrs.items()):
        part.attrs[k] = np.concatenate([np.asarray(v), np.asarray(v)[list(dup.keys())]])
    if part.src is not None:
        part.src = np.concatenate([part.src, np.asarray(part.src)[list(dup.keys())]])
    return dup


# ---------------------------------------------------------------- bands & ribbons

def frame_along(path, up_hint):
    """Tangents + side vectors (perpendicular to tangent, as close to up_hint x tangent as possible)."""
    P = np.asarray(path, float)
    T = np.gradient(P, axis=0)
    T /= np.linalg.norm(T, axis=1)[:, None]
    hints = np.asarray(up_hint, float)
    if hints.ndim == 1:
        hints = np.tile(hints, (len(P), 1))
    Sd = np.cross(hints, T)
    Sd /= np.maximum(np.linalg.norm(Sd, axis=1), 1e-9)[:, None]
    Nm = np.cross(T, Sd)
    return T, Sd, Nm


def band(path, normals, width, thick, name, paint, group='body', w_profile=None, closed=False, rounded=0.35,
         segs_w=3, align=0.5):
    """Thick flat band along a path lying on a surface with given outward normals.

    Cross-section: rounded rectangle `width` x `thick` (segs_w quads across each face). align: 0 = band starts at
    the path and extends to one side, 0.5 = centred. Returns Part with UV (s, across) and pat (metres)."""
    P = np.asarray(path, float)
    N = np.asarray(normals, float)
    N /= np.linalg.norm(N, axis=1)[:, None]
    T = np.gradient(P, axis=0) if not closed else (np.roll(P, -1, 0) - np.roll(P, 1, 0))
    T /= np.linalg.norm(T, axis=1)[:, None]
    Sd = np.cross(N, T)
    Sd /= np.linalg.norm(Sd, axis=1)[:, None]
    n = len(P)
    wp = np.ones(n) if w_profile is None else np.asarray(w_profile, float)
    # cross-section ring (counter-clockwise in (side, normal) plane), outer surface first
    prof = []
    for k in range(segs_w + 1):          # top face, side -> other side
        u = k / segs_w
        prof.append((u, 1.0))
    prof.append((1.0 + rounded * 0.0, 0.5))
    for k in range(segs_w, -1, -1):      # bottom face back
        u = k / segs_w
        prof.append((u, 0.0))
    prof.append((0.0, 0.5))
    m = len(prof)
    co, faces, uv, pat = [], [], [], []
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
    for i in range(n):
        w = width * wp[i]
        for (u, h) in prof:
            side = (u - align) * w
            hh = (h - 0.5) * thick + thick * 0.5
            # round the outer corners slightly
            if h in (1.0, 0.0) and u in (0.0, 1.0):
                side *= (1 - rounded * 0.15)
            co.append(P[i] + Sd[i] * side + N[i] * hh)
    rings = n if closed else n - 1
    for i in range(rings):
        i2 = (i + 1) % n
        for k in range(m):
            k2 = (k + 1) % m
            faces.append((i * m + k, i2 * m + k, i2 * m + k2, i * m + k2))
            for (ii, kk) in ((i, k), (i2, k), (i2, k2), (i, k2)):
                si = s[ii] if not (closed and ii == 0 and i2 == 0) else s[ii]
                if closed and ii == 0 and i == n - 1:
                    si = s[-1] + np.linalg.norm(P[-1] - P[0])
                u, h = prof[kk]
                across = (u if h >= 0.5 else 2.0 - u) * width * 0.5
                uv.append((si, across))
                pat.append((si, (u - align) * width * wp[ii]))
    if not closed:
        # end caps (fan of quads around the ring as a triangle fan)
        for i, flip in ((0, True), (n - 1, False)):
            c = len(co)
            co.append(P[i] + N[i] * thick * 0.5)
            for k in range(m):
                k2 = (k + 1) % m
                f = (c, i * m + k2, i * m + k) if flip else (c, i * m + k, i * m + k2)
                faces.append(f)
                uv.extend([(s[i], 0), (s[i], 0.001), (s[i] + 0.001, 0)])
                pat.extend([(s[i], 0), (s[i], 0), (s[i], 0)])
    p = Part(name, co, faces, paint, group, uv=uv, pat=pat)
    return p


def tube(path, radii, name, paint, segs=10, group='body', closed=False, ref=None, caps=True, flat=None):
    """Swept tube with per-point radius (rx, ry) and UV (around, along)."""
    from .core import sweep
    P = [Vector(tuple(map(float, p))) for p in path]
    rr = [r if isinstance(r, (tuple, list)) else (r, r) for r in radii]
    verts, faces = sweep(P, rr, segs=segs, ref=Vector(ref) if ref is not None else None, cap0=caps, cap1=caps,
                         closed=closed)
    co = np.array([tuple(v) for v in verts])
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(np.array([tuple(p) for p in P]), axis=0), axis=1))])
    uv, pat = [], []
    n = len(P)
    for f in faces:
        for vi in f:
            if vi < n * segs:
                i, k = divmod(vi, segs)
                circ = 2 * math.pi * max(rr[i][0], rr[i][1])
                uv.append((s[i], k / segs * circ))
                pat.append((s[i], k / segs * circ))
            else:
                end = 0 if vi == n * segs else n - 1
                uv.append((s[end], 0.0))
                pat.append((s[end], 0.0))
    # fix seam wrap: faces crossing k=segs-1 -> 0 get u from the far side
    uv = np.array(uv)
    pat = np.array(pat)
    k = 0
    for f in faces:
        L = len(f)
        vals = uv[k:k + L, 1]
        if vals.max() - vals.min() > 0.5 * (vals.max() + 1e-9) and L == 4:
            circ_max = vals.max()
            for j in range(L):
                if vals[j] == 0.0 and f[j] < n * segs:
                    i_, kk = divmod(f[j], segs)
                    uv[k + j, 1] = 2 * math.pi * max(rr[i_][0], rr[i_][1])
                    pat[k + j, 1] = uv[k + j, 1]
        k += L
    return Part(name, co, faces, paint, group, uv=uv, pat=pat)


# ---------------------------------------------------------------- curves on surfaces

def catmull(pts, n, closed=False):
    """Centripetal-ish Catmull-Rom through pts, n samples (uniform param)."""
    P = [np.asarray(p, float) for p in pts]
    if closed:
        P = [P[-1]] + P + [P[0], P[1]]
    else:
        P = [P[0] * 2 - P[1]] + P + [P[-1] * 2 - P[-2]]
    segs = len(P) - 3
    out = []
    for i in range(n):
        u = i / (n - (0 if closed else 1)) * segs
        k = min(int(u), segs - 1)
        t = u - k
        p0, p1, p2, p3 = P[k], P[k + 1], P[k + 2], P[k + 3]
        t2, t3 = t * t, t * t * t
        out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    return np.array(out)


def project_path(surf, pts, lift=0.0):
    """Snap points to the nearest surface point (+ lift along its normal). Returns (points, normals)."""
    P, N = [], []
    for p in pts:
        loc, nrm, idx, d = surf.nearest(p)
        P.append(loc + nrm * lift)
        N.append(nrm)
    N = np.array(N)
    # one orientation along the path (a single folded face must not twist a band inside out): follow the
    # neighbour, then keep whichever orientation most raw normals agree with
    raw = N.copy()
    for i in range(1, len(N)):
        if N[i] @ N[i - 1] < 0:
            N[i] = -N[i]
    if (np.einsum('ij,ij->i', N, raw) < 0).sum() > len(N) / 2:
        N = -N
    # a corner can snap one point to a stray face: replace normals far off their neighbours' mean
    if len(N) > 4:
        E = np.pad(N, ((2, 2), (0, 0)), mode='edge')
        nb = (E[:-4] + E[1:-3] + E[3:-1] + E[4:]) / 4
        nb /= np.maximum(np.linalg.norm(nb, axis=1), 1e-9)[:, None]
        bad = np.einsum('ij,ij->i', N, nb) < 0.8
        N[bad] = nb[bad]
    # smooth normals along the path
    for _ in range(3):
        N[1:-1] = 0.5 * N[1:-1] + 0.25 * (N[:-2] + N[2:])
    N /= np.linalg.norm(N, axis=1)[:, None]
    return np.array(P), N


def ray_front(surf, x, z, from_back=False, y0=1.0):
    """Surface point hit by a ray along +/-Y at (x, z)."""
    o = np.array([x, y0 if from_back else -y0, z])
    d = np.array([0, -1.0 if from_back else 1.0, 0])
    hit = surf.raycast(o, d, 2 * y0)
    return None if hit is None else hit[0]


def ring_on(surf, center, z, n, lift=0.0, r0=0.5):
    """Closed ring around a vertical axis at height z, hugging the surface from outside."""
    pts, nrms = [], []
    for k in range(n):
        a = 2 * math.pi * k / n
        d = np.array([math.cos(a), math.sin(a), 0.0])
        o = np.array([center[0], center[1], z]) + d * r0
        hit = surf.raycast(o, -d, r0)
        if hit is None:
            loc, nrm, _, _ = surf.nearest(o)
        else:
            loc, nrm, _ = hit
        pts.append(loc + d * lift)
        nrms.append(d)
    return np.array(pts), np.array(nrms)


def lofted(sections, name, paint, group='body', closed_sections=True, cap0=True, cap1=True):
    """Loft through cross-section rings (list of (m,3) arrays). UV: (around, along) in metres."""
    S = [np.asarray(s, float) for s in sections]
    m = len(S[0])
    co = np.concatenate(S)
    faces, uv = [], []
    along = np.concatenate([[0], np.cumsum([np.linalg.norm(S[i + 1].mean(0) - S[i].mean(0)) for i in range(len(S) - 1)])])
    around = []
    for s_ in S:
        seg = np.linalg.norm(np.roll(s_, -1, 0) - s_, axis=1)
        around.append(np.concatenate([[0], np.cumsum(seg)]))
    cols = m if closed_sections else m - 1
    for i in range(len(S) - 1):
        for k in range(cols):
            k2 = (k + 1) % m
            faces.append((i * m + k, i * m + k2, (i + 1) * m + k2, (i + 1) * m + k))
            uv += [(around[i][k], along[i]), (around[i][k + 1], along[i]), (around[i + 1][k + 1], along[i + 1]),
                   (around[i + 1][k], along[i + 1])]
    co = list(co)
    for i, flip in ((0, False), (len(S) - 1, True)):
        if (i == 0 and not cap0) or (i > 0 and not cap1):
            continue
        c = len(co)
        co.append(S[i].mean(0))
        for k in range(cols):
            k2 = (k + 1) % m
            f = (c, i * m + k2, i * m + k) if not flip else (c, i * m + k, i * m + k2)
            faces.append(f)
            uv += [(0, along[i]), (0.001, along[i]), (0.002, along[i])]
    p = Part(name, np.array(co), faces, paint, group, uv=uv, pat=uv)
    return p


def orient_from(part, surf):
    """Consistent winding by walking the shared edges, then each connected piece's overall sign by an
    area-weighted vote of 'points away from the body' (robust where a hand hangs right next to a skirt)."""
    from collections import deque
    faces = [list(f) for f in part.faces]
    edge_faces = {}
    for fi, f in enumerate(faces):
        for k in range(len(f)):
            a, b = f[k], f[(k + 1) % len(f)]
            edge_faces.setdefault((min(a, b), max(a, b)), []).append(fi)
    flip = np.zeros(len(faces), bool)
    comp = np.full(len(faces), -1)

    def directed(fi):
        f = faces[fi][::-1] if flip[fi] else faces[fi]
        return {(f[k], f[(k + 1) % len(f)]) for k in range(len(f))}
    ncomp = 0
    for seed in range(len(faces)):
        if comp[seed] >= 0:
            continue
        comp[seed] = ncomp
        dq = deque([seed])
        while dq:
            fi = dq.popleft()
            dfi = directed(fi)
            f = faces[fi]
            for k in range(len(f)):
                a, b = f[k], f[(k + 1) % len(f)]
                for gj in edge_faces[(min(a, b), max(a, b))]:
                    if comp[gj] >= 0:
                        continue
                    comp[gj] = ncomp
                    dg = {(faces[gj][m], faces[gj][(m + 1) % len(faces[gj])]) for m in range(len(faces[gj]))}
                    # a consistent neighbour traverses the shared edge in the opposite direction
                    if (a, b) in dfi and (a, b) in dg or (b, a) in dfi and (b, a) in dg:
                        flip[gj] = True
                    dq.append(gj)
        ncomp += 1
    co = part.co
    vote = np.zeros(ncomp)
    for fi, f in enumerate(faces):
        g = f[::-1] if flip[fi] else f
        p = co[g]
        n = np.zeros(3)
        for k in range(len(g)):
            n += np.cross(p[k], p[(k + 1) % len(g)])
        c = p.mean(0)
        loc, nrm, _, _ = surf.nearest(c)
        out = c - loc
        if out @ out < 1e-12:
            out = nrm
        vote[comp[fi]] += np.sign(n @ out) * np.linalg.norm(n)
    final = flip ^ (vote[comp] < 0)
    if final.any() and (part.uv is not None or part.pat is not None):
        starts = np.concatenate([[0], np.cumsum([len(f) for f in faces])])
        for arr in ('uv', 'pat'):
            a = getattr(part, arr)
            if a is None:
                continue
            a = a.copy()
            for fi in np.where(final)[0]:
                s0, e0 = starts[fi], starts[fi + 1]
                a[s0:e0] = a[s0:e0][::-1]
            setattr(part, arr, a)
    part.faces = [tuple(f[::-1]) if final[fi] else tuple(f) for fi, f in enumerate(faces)]
    return part


def solidify(part, thick, inner_paint=None, rim_paint=None):
    """Give an open shell real thickness: inward copy (reversed, lining paint) + rim quads on every boundary."""
    co = part.co
    nv = part.nv
    part.n_outer = len(part.faces)
    n = vertex_normals(co, part.faces)
    inner = co - n * thick
    faces = list(part.faces)
    paints = list(part.face_paint) if part.face_paint is not None else [part.paint] * len(faces)
    nl = sum(len(f) for f in faces)
    uv = part.uv if part.uv is not None else np.zeros((nl, 2))
    pat = part.pat if part.pat is not None else np.zeros((nl, 2))
    in_faces = [tuple(v + nv for v in reversed(f)) for f in part.faces]
    in_uv, in_pat = [], []
    k = 0
    for f in part.faces:
        L = len(f)
        in_uv.extend(uv[k:k + L][::-1])
        in_pat.extend(pat[k:k + L][::-1])
        k += L
    rim_faces, rim_uv = [], []
    from collections import Counter
    cnt = Counter()
    for f in part.faces:
        for j in range(len(f)):
            a, b = f[j], f[(j + 1) % len(f)]
            cnt[(min(a, b), max(a, b))] += 1
    s = 0.0
    for f in part.faces:
        for j in range(len(f)):
            a, b = f[j], f[(j + 1) % len(f)]
            if cnt[(min(a, b), max(a, b))] != 1:
                continue
            ln = float(np.linalg.norm(co[b] - co[a]))
            rim_faces.append((b, a, a + nv, b + nv))
            rim_uv.extend([(s + ln, 0.0), (s, 0.0), (s, thick), (s + ln, thick)])
            s += ln + thick
    part.co = np.concatenate([co, inner])
    part.faces = faces + in_faces + rim_faces
    part.uv = np.concatenate([uv, np.array(in_uv), np.array(rim_uv) if rim_uv else np.zeros((0, 2))])
    part.pat = np.concatenate([pat, np.array(in_pat), np.array(rim_uv) if rim_uv else np.zeros((0, 2))])
    part.face_paint = paints + [inner_paint or part.paint] * len(in_faces) + [rim_paint or inner_paint or part.paint] * len(rim_faces)
    part.outline = np.concatenate([part.outline, part.outline])
    for key, v in list(part.attrs.items()):
        part.attrs[key] = np.concatenate([np.asarray(v), np.asarray(v)])
    if part.src is not None:
        part.src = np.concatenate([part.src, part.src])
    if part.weights is not None:
        part.weights = (part.weights[0], np.concatenate([part.weights[1], part.weights[1]]))
    for key, d in list(part.keys.items()):
        part.keys[key] = np.concatenate([d, d])
    return part
