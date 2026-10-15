"""Skin weights: bone-heat on the body, smoothing, 4-influence limit, and transfer onto garments/hair."""
import bpy
import numpy as np
from mathutils.bvhtree import BVHTree


def heat_weights(mesh_obj, arm_obj, bones):
    """Bone-heat auto weights restricted to `bones`. Returns (names, W[nv, nb])."""
    data = arm_obj.data
    saved = {b.name: b.use_deform for b in data.bones}
    for b in data.bones:
        b.use_deform = b.name in bones
    bpy.ops.object.select_all(action='DESELECT')
    mesh_obj.select_set(True)
    arm_obj.select_set(True)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    for b in data.bones:
        b.use_deform = saved[b.name]
    names, W = read_weights(mesh_obj, bones)
    missing = np.where(W.sum(1) < 1e-6)[0]
    if len(missing):
        print(f'WARN heat weights: {len(missing)} unweighted verts on {mesh_obj.name}')
    return names, W


def read_weights(obj, bones):
    names = list(bones)
    idx = {n: i for i, n in enumerate(names)}
    gi = {g.index: idx[g.name] for g in obj.vertex_groups if g.name in idx}
    W = np.zeros((len(obj.data.vertices), len(names)))
    for v in obj.data.vertices:
        for g in v.groups:
            j = gi.get(g.group)
            if j is not None:
                W[v.index, j] = g.weight
    return names, W


def write_weights(obj, names, W, limit=4, eps=1e-3):
    """Replace all vertex groups with W (limited to `limit` influences, normalised)."""
    W = limit_normalise(W, limit, eps)
    obj.vertex_groups.clear()
    groups = [obj.vertex_groups.new(name=n) for n in names]
    for j, g in enumerate(groups):
        col = W[:, j]
        nz = np.where(col > 0)[0]
        # group by weight value for fewer API calls
        for vi in nz:
            g.add([int(vi)], float(col[vi]), 'REPLACE')
    return W


def limit_normalise(W, limit=4, eps=1e-3):
    W = np.array(W, float)
    if W.shape[1] > limit:
        order = np.argsort(-W, axis=1)
        drop = order[:, limit:]
        rows = np.arange(len(W))[:, None]
        W[rows, drop] = 0.0
    W[W < eps] = 0.0
    s = W.sum(1, keepdims=True)
    s[s < 1e-9] = 1.0
    return W / s


def smooth_weights(topo, W, iters=2, lam=0.5, mask=None):
    """Laplacian smoothing of weight rows over the mesh 1-ring (mask: vertices allowed to change)."""
    W = np.array(W, float)
    nb = [np.fromiter(topo.adj[i], int) for i in range(topo.nv)]
    for _ in range(iters):
        avg = np.array([W[n].mean(0) if len(n) else W[i] for i, n in enumerate(nb)])
        new = W + lam * (avg - W)
        if mask is not None:
            new[~mask] = W[~mask]
        W = new
    s = W.sum(1, keepdims=True)
    s[s < 1e-9] = 1.0
    return W / s


class SurfaceSampler:
    """Closest-point interpolation of per-vertex data from a source triangle mesh."""

    def __init__(self, co, tris):
        self.co = np.asarray(co, float)
        self.tris = np.asarray(tris, int)
        self.bvh = BVHTree.FromPolygons([tuple(map(float, v)) for v in self.co], [tuple(map(int, t)) for t in self.tris])

    def query(self, pts, max_dist=10.0):
        """-> (tri index, barycentric (3,), distance) per point."""
        out_t, out_b, out_d = [], [], []
        for p in pts:
            loc, nrm, ti, dist = self.bvh.find_nearest(tuple(map(float, p)), max_dist)
            if ti is None:
                out_t.append(-1)
                out_b.append((1.0, 0.0, 0.0))
                out_d.append(np.inf)
                continue
            a, b, c = self.co[self.tris[ti]]
            out_t.append(ti)
            out_b.append(_bary(np.array(loc), a, b, c))
            out_d.append(dist)
        return np.array(out_t), np.array(out_b), np.array(out_d)

    def interpolate(self, data, pts, max_dist=10.0):
        ti, bc, d = self.query(pts, max_dist)
        data = np.asarray(data)
        idx = self.tris[np.maximum(ti, 0)]
        res = (data[idx] * bc[:, :, None]).sum(1) if data.ndim == 2 else (data[idx] * bc).sum(1)
        return res, d


def _bary(p, a, b, c):
    v0, v1, v2 = b - a, c - a, p - a
    d00, d01, d11 = v0 @ v0, v0 @ v1, v1 @ v1
    d20, d21 = v2 @ v0, v2 @ v1
    den = d00 * d11 - d01 * d01
    if abs(den) < 1e-18:
        return np.array([1.0, 0.0, 0.0])
    v = (d11 * d20 - d01 * d21) / den
    w = (d00 * d21 - d01 * d20) / den
    bc = np.clip(np.array([1 - v - w, v, w]), 0, 1)
    return bc / bc.sum()


def triangulate(faces):
    tris = []
    for f in faces:
        for k in range(1, len(f) - 1):
            tris.append((f[0], f[k], f[k + 1]))
    return np.array(tris)


def chain_weights(co, points, bones, root=None, root_len=0.05, blend=0.35):
    """Weights for verts hanging along a bone chain: smooth blend between consecutive chain bones, and from
    `root` (the chain's parent) over the first `root_len` metres. Returns (names, W)."""
    co = np.asarray(co, float)
    pts = np.asarray(points, float)
    nb = len(bones)
    best_d = np.full(len(co), np.inf)
    best_s = np.zeros(len(co))  # continuous bone param: i + t
    for i in range(nb):
        a, b = pts[i], pts[i + 1]
        ab = b - a
        t = np.clip(((co - a) @ ab) / (ab @ ab), 0, 1)
        d = np.linalg.norm(co - (a + np.outer(t, ab)), axis=1)
        m = d < best_d
        best_d[m] = d[m]
        best_s[m] = i + t[m]
    names = list(bones) + ([root] if root else [])
    W = np.zeros((len(co), len(names)))
    for v, sp in enumerate(best_s):
        i = min(int(sp), nb - 1)
        t = sp - i
        # bone i owns its segment; blend half-way into the next bone near the joint
        if i + 1 < nb and t > 1 - blend:
            k = 0.5 * (t - (1 - blend)) / blend
            W[v, i] = 1 - k
            W[v, i + 1] = k
        elif i > 0 and t < blend:
            k = 0.5 * (blend - t) / blend
            W[v, i] = 1 - k
            W[v, i - 1] = k
        else:
            W[v, i] = 1.0
    if root:
        seg0 = np.linalg.norm(pts[1] - pts[0])
        dist = best_s * seg0  # approx metres from the chain start (first segment scale)
        r = np.clip(1 - dist / max(root_len, 1e-6), 0, 1)
        r = r * r * (3 - 2 * r)
        W[:, :nb] *= (1 - r)[:, None]
        W[:, nb] = r
    return names, W
