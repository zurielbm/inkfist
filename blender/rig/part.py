"""Character parts and their assembly into the exported skinned meshes.

A Part is plain numpy geometry plus everything the exporter needs:
  uv       per-loop atlas UVs (islands; packed later into one atlas for the whole character)
  pat      per-loop pattern coords in metres (texture recipes use them for hems, stripes, motifs)
  paint    texture recipe name (see paint.py)
  group    output mesh: 'body' | 'head' | 'hair'
  weights  (bone names, W[nv, nb]) — copied from the body for body-derived shells, else transferred
  attrs    extra per-vertex float attributes for paint recipes (e.g. 'hem' distance)
  outline  per-vertex outline width multiplier (0 = no ink line)
  keys     morph target deltas {name: (nv, 3)} (head group only)
  normal_proxy  optional (co, faces) smooth proxy whose normals replace the part's (clean toon shading)
"""
import numpy as np


class Part:
    def __init__(self, name, co, faces, paint, group='body', uv=None, pat=None, weights=None, attrs=None,
                 outline=1.0, texel=1.0, keys=None, src=None, smooth=True):
        self.name = name
        self.co = np.asarray(co, float)
        self.faces = [tuple(int(i) for i in f) for f in faces]
        self.paint = paint
        self.group = group
        nl = sum(len(f) for f in self.faces)
        self.uv = None if uv is None else np.asarray(uv, float).reshape(nl, 2)
        self.pat = None if pat is None else np.asarray(pat, float).reshape(nl, 2)
        self.weights = weights
        self.attrs = dict(attrs or {})
        nv = len(self.co)
        self.outline = np.full(nv, outline, float) if np.isscalar(outline) else np.asarray(outline, float)
        self.texel = texel          # relative texel density in the atlas
        self.keys = dict(keys or {})
        self.src = src              # body vertex index per vertex (body-derived shells), or None
        self.smooth = smooth
        self.normal_proxy = None
        self.normals = None         # explicit per-vertex normals (overrides shading normals)
        self.face_paint = None      # optional per-face paint names (else `paint` for every face)

    @property
    def nv(self):
        return len(self.co)

    def loops(self):
        return np.array([v for f in self.faces for v in f], int)

    def flip(self):
        self.faces = [tuple(reversed(f)) for f in self.faces]
        for arr in ('uv', 'pat'):
            a = getattr(self, arr)
            if a is not None:
                out, k = [], 0
                for f in self.faces:
                    n = len(f)
                    out.extend(a[k:k + n][::-1])
                    k += n
                setattr(self, arr, np.array(out))
        return self

    def subset(self, face_mask, name=None):
        """New Part with only the selected faces (unused vertices dropped)."""
        keep = [i for i, m in enumerate(face_mask) if m]
        used = sorted({v for i in keep for v in self.faces[i]})
        remap = {v: k for k, v in enumerate(used)}
        faces = [tuple(remap[v] for v in self.faces[i]) for i in keep]
        starts = np.concatenate([[0], np.cumsum([len(f) for f in self.faces])])

        def loop_sel(a):
            if a is None:
                return None
            return np.concatenate([a[starts[i]:starts[i + 1]] for i in keep]) if keep else np.zeros((0, 2))
        p = Part(name or self.name, self.co[used], faces, self.paint, self.group, loop_sel(self.uv),
                 loop_sel(self.pat), None, {k: np.asarray(v)[used] for k, v in self.attrs.items()},
                 self.outline[used], self.texel, {k: v[used] for k, v in self.keys.items()},
                 None if self.src is None else np.asarray(self.src)[used], self.smooth)
        if self.weights is not None:
            p.weights = (self.weights[0], self.weights[1][used])
        if self.normals is not None:
            p.normals = self.normals[used]
        p.normal_proxy = self.normal_proxy
        if self.face_paint is not None:
            p.face_paint = [self.face_paint[i] for i in keep]
        return p


def merge_parts(parts, name, paint=None, group=None):
    """Concatenate parts (same group) into one Part (keeps per-face paint in `face_paint`)."""
    co, faces, uv, pat, outline, face_paint, src = [], [], [], [], [], [], []
    attrs_names = set()
    for p in parts:
        attrs_names |= set(p.attrs)
    key_names = set()
    for p in parts:
        key_names |= set(p.keys)
    attrs = {k: [] for k in attrs_names}
    keys = {k: [] for k in key_names}
    normals = []
    off = 0
    for p in parts:
        co.append(p.co)
        faces += [tuple(v + off for v in f) for f in p.faces]
        nl = sum(len(f) for f in p.faces)
        uv.append(p.uv if p.uv is not None else np.zeros((nl, 2)))
        pat.append(p.pat if p.pat is not None else np.zeros((nl, 2)))
        outline.append(p.outline)
        face_paint += list(p.face_paint) if p.face_paint is not None else [p.paint] * len(p.faces)
        for k in attrs_names:
            attrs[k].append(np.asarray(p.attrs.get(k, np.zeros(p.nv))))
        for k in key_names:
            keys[k].append(p.keys.get(k, np.zeros((p.nv, 3))))
        normals.append(p.normals if p.normals is not None else np.full((p.nv, 3), np.nan))
        off += p.nv
    m = Part(name, np.concatenate(co), faces, paint or parts[0].paint, group or parts[0].group,
             np.concatenate(uv), np.concatenate(pat), None, {k: np.concatenate(v) for k, v in attrs.items()},
             np.concatenate(outline), 1.0, {k: np.concatenate(v) for k, v in keys.items()})
    m.face_paint = face_paint
    m.normals = np.concatenate(normals)
    if all(p.weights is not None for p in parts):
        m.weights = (parts[0].weights[0], np.concatenate([p.weights[1] for p in parts]))
    return m


def signed_volume(co, faces):
    v = 0.0
    for f in faces:
        a = co[f[0]]
        for k in range(1, len(f) - 1):
            v += np.dot(a, np.cross(co[f[k]], co[f[k + 1]]))
    return v / 6.0


def is_closed(faces):
    from collections import Counter
    c = Counter()
    for f in faces:
        for k in range(len(f)):
            a, b = f[k], f[(k + 1) % len(f)]
            c[(min(a, b), max(a, b))] += 1
    return all(n == 2 for n in c.values())


def orient_outward(part):
    """Flip closed parts whose faces point inward."""
    if part.faces and is_closed(part.faces) and signed_volume(part.co, part.faces) < 0:
        part.flip()
    return part
