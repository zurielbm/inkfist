"""CC0 base body (Blender Studio Human Base Meshes, realistic male/female — shared topology).

`hbm_base.npz` is produced by blender/base/extract_base.py. Coordinates: metres, Z up, facing -Y, character's left = +X.
"""
import heapq
import os
from collections import defaultdict

import bpy
import numpy as np
from mathutils import Vector

from .core import BLENDER_DIR

BASE_NPZ = os.path.join(BLENDER_DIR, 'base', 'hbm_base.npz')


class Topo:
    """Topology + geometry helpers for an indexed polygon mesh (numpy)."""

    def __init__(self, co, sizes, loops, uv=None):
        self.co = np.asarray(co, np.float64)
        self.sizes = np.asarray(sizes)
        self.loops = np.asarray(loops)
        self.uv = uv
        self.starts = np.concatenate([[0], np.cumsum(self.sizes)[:-1]])
        self.faces = [tuple(self.loops[s:s + n]) for s, n in zip(self.starts, self.sizes)]
        self.nv = len(self.co)
        adj = defaultdict(set)
        edge_faces = defaultdict(list)
        vert_faces = defaultdict(list)
        for fi, f in enumerate(self.faces):
            for k in range(len(f)):
                a, b = f[k], f[(k + 1) % len(f)]
                adj[a].add(b)
                adj[b].add(a)
                edge_faces[(min(a, b), max(a, b))].append(fi)
                vert_faces[a].append(fi)
        self.adj = adj
        self.edge_faces = edge_faces
        self.vert_faces = vert_faces

    # ---------------------------------------------------------------- queries
    def boundary_loops(self):
        bedges = [e for e, fs in self.edge_faces.items() if len(fs) == 1]
        nxt = defaultdict(list)
        for a, b in bedges:
            nxt[a].append(b)
            nxt[b].append(a)
        seen = set()
        loops = []
        for a, _ in bedges:
            if a in seen:
                continue
            loop = [a]
            seen.add(a)
            prev, cur = None, a
            while True:
                cand = [v for v in nxt[cur] if v != prev and v not in seen]
                if not cand:
                    break
                prev, cur = cur, cand[0]
                loop.append(cur)
                seen.add(cur)
            loops.append(loop)
        return loops

    def grow(self, seeds, rings, mask=None):
        """Vertex indices within `rings` edge hops of seeds."""
        cur = set(seeds)
        out = set(seeds)
        for _ in range(rings):
            nxt = set()
            for v in cur:
                for w in self.adj[v]:
                    if w not in out and (mask is None or mask[w]):
                        nxt.add(w)
            out |= nxt
            cur = nxt
        return out

    def geodesic(self, seeds, max_d=np.inf):
        """Dijkstra edge-length distance from seed vertices (dict seed->start dist or iterable)."""
        dist = np.full(self.nv, np.inf)
        h = []
        items = seeds.items() if isinstance(seeds, dict) else ((s, 0.0) for s in seeds)
        for s, d0 in items:
            dist[s] = d0
            h.append((d0, s))
        heapq.heapify(h)
        co = self.co
        while h:
            d, v = heapq.heappop(h)
            if d > dist[v] or d > max_d:
                continue
            for w in self.adj[v]:
                nd = d + float(np.linalg.norm(co[v] - co[w]))
                if nd < dist[w]:
                    dist[w] = nd
                    heapq.heappush(h, (nd, w))
        return dist

    def vertex_normals(self, co=None):
        co = self.co if co is None else co
        n = np.zeros_like(co)
        for f in self.faces:
            p = co[list(f)]
            fn = np.zeros(3)
            for k in range(len(f)):
                fn += np.cross(p[k], p[(k + 1) % len(f)])
            for v in f:
                n[v] += fn
        ln = np.linalg.norm(n, axis=1)
        ln[ln < 1e-12] = 1
        return n / ln[:, None]

    def laplacian_smooth(self, values, iters=1, lam=0.5, mask=None):
        """Smooth per-vertex values (N,) or (N,k) over the 1-ring."""
        vals = np.array(values, np.float64)
        nb = [list(self.adj[i]) for i in range(self.nv)]
        for _ in range(iters):
            avg = np.array([vals[n].mean(axis=0) if n else vals[i] for i, n in enumerate(nb)])
            upd = vals + lam * (avg - vals)
            if mask is not None:
                upd[~mask] = vals[~mask]
            vals = upd
        return vals


def load_base():
    d = np.load(BASE_NPZ)
    return {k: d[k] for k in d.files}


def base_topo(shape='male', blend=0.0, data=None):
    """Topo of the base body. blend in [0,1] mixes toward the other sex's shape (shared topology)."""
    d = data or load_base()
    other = 'female' if shape == 'male' else 'male'
    co = d[shape] * (1 - blend) + d[other] * blend
    return Topo(co, d['face_sizes'], d['face_loops'], d['uv'])


def to_blender(name, topo, co=None, link=True):
    """Create a Blender mesh object from a Topo (keeps UVs)."""
    co = topo.co if co is None else co
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(map(float, v)) for v in co], [], topo.faces)
    if topo.uv is not None:
        uvl = me.uv_layers.new(name='UVMap')
        uvl.data.foreach_set('uv', np.asarray(topo.uv, np.float32).ravel())
    me.update()
    obj = bpy.data.objects.new(name, me)
    if link:
        bpy.context.scene.collection.objects.link(obj)
    return obj
