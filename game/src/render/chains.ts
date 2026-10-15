import * as THREE from 'three';
import { ChainMeta } from './assets';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const DOWN = new THREE.Vector3(0, -1, 0);
const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();

/** World-space body capsule that chains are kept out of (refreshed every frame from the posed skeleton). */
export interface Capsule {
  a: THREE.Vector3;
  b: THREE.Vector3;
  r: number;
}

/** Push p out of a capsule (segment a-b, radius r). */
function pushOut(p: THREE.Vector3, c: Capsule, margin: number): void {
  _ab.subVectors(c.b, c.a);
  const L2 = _ab.lengthSq();
  const t = L2 > 1e-10 ? Math.min(1, Math.max(0, _ap.subVectors(p, c.a).dot(_ab) / L2)) : 0;
  _ap.copy(c.a).addScaledVector(_ab, t);
  _v2.subVectors(p, _ap);
  const d = _v2.length();
  const r = c.r + margin;
  if (d < r && d > 1e-6) p.copy(_ap).addScaledVector(_v2, r / d);
}

interface Link {
  bone: THREE.Bone;
  restQuat: THREE.Quaternion;
  /** this joint's tail offset expressed in the bone's local space at rest */
  tailLocal: THREE.Vector3;
  len: number;
}

/** Verlet "jiggle" chain for hair / cloth / scarves / sleeves. Render-only (not deterministic). */
export class SpringChain {
  links: Link[] = [];
  pts: THREE.Vector3[] = [];
  prev: THREE.Vector3[] = [];
  target: THREE.Vector3[] = [];
  root: THREE.Vector3 = new THREE.Vector3();
  follow: THREE.Bone | null = null;
  followAmount = 0;
  initialised = false;

  constructor(public meta: ChainMeta, bones: Record<string, THREE.Bone>, public modelRoot: THREE.Object3D) {
    const n = meta.bones.length;
    for (let i = 0; i < n; i++) {
      const b = bones[meta.bones[i]];
      if (!b) continue;
      const tailRest = new THREE.Vector3(...meta.points[i + 1]);
      const headRest = new THREE.Vector3(...meta.points[i]);
      const nextBone = i + 1 < n ? bones[meta.bones[i + 1]] : null;
      const tailLocal = nextBone ? nextBone.position.clone() : this.restTailLocal(b, headRest, tailRest);
      this.links.push({ bone: b, restQuat: b.quaternion.clone(), tailLocal, len: tailLocal.length() || headRest.distanceTo(tailRest) });
    }
    for (let i = 0; i <= this.links.length; i++) {
      this.pts.push(new THREE.Vector3());
      this.prev.push(new THREE.Vector3());
      this.target.push(new THREE.Vector3());
    }
    if (meta.follow && bones[meta.follow]) {
      this.follow = bones[meta.follow];
      this.followAmount = meta.follow_amount ?? 0.5;
    }
  }

  private restTailLocal(b: THREE.Bone, head: THREE.Vector3, tail: THREE.Vector3): THREE.Vector3 {
    // glTF bones point along +Y in local space; length from rest points
    return new THREE.Vector3(0, head.distanceTo(tail), 0);
  }

  reset(): void {
    this.initialised = false;
  }

  /** Call after the skeleton has been posed by the animation (world matrices updated). */
  update(dt: number, wind: number, colliders: Capsule[] = []): void {
    const L = this.links;
    if (!L.length) return;
    // 1. rigid targets: reset chain to rest and read world joint positions
    for (const l of L) l.bone.quaternion.copy(l.restQuat);
    L[0].bone.updateMatrixWorld(true);
    for (let i = 0; i < L.length; i++) {
      L[i].bone.getWorldPosition(this.target[i]);
    }
    this.target[L.length].copy(L[L.length - 1].tailLocal).applyMatrix4(L[L.length - 1].bone.matrixWorld);
    // follow (cloth panels follow the thigh when kicking)
    if (this.follow && this.followAmount > 0) {
      const thigh = this.follow;
      const knee = thigh.children.find((c) => (c as THREE.Bone).isBone) as THREE.Bone | undefined;
      if (knee) {
        thigh.getWorldPosition(_v1);
        knee.getWorldPosition(_v2);
        const dirW = _v2.sub(_v1).normalize();
        // compare against model "down" in world
        _m.copy(this.modelRoot.matrixWorld);
        const downW = DOWN.clone().transformDirection(_m);
        _q.setFromUnitVectors(downW, dirW);
        _qi.identity().slerp(_q, this.followAmount);
        const base = this.target[0];
        for (let i = 1; i <= L.length; i++) this.target[i].sub(base).applyQuaternion(_qi).add(base);
      }
    }
    if (!this.initialised) {
      for (let i = 0; i <= L.length; i++) {
        this.pts[i].copy(this.target[i]);
        this.prev[i].copy(this.target[i]);
      }
      this.initialised = true;
    }
    const k = Math.min(2, dt * 60);
    const damping = Math.pow(this.meta.damping, k);
    const stiff = 1 - Math.pow(1 - this.meta.stiffness, k);
    const grav = this.meta.gravity * 0.0042 * k * k;
    this.pts[0].copy(this.target[0]);
    this.prev[0].copy(this.target[0]);
    for (let i = 1; i <= L.length; i++) {
      const p = this.pts[i];
      _v1.copy(p).sub(this.prev[i]).multiplyScalar(damping);
      this.prev[i].copy(p);
      p.add(_v1);
      p.y -= grav;
      p.x += wind * (this.meta.drag ?? 0.6) * 0.0015 * k * i;
      p.lerp(this.target[i], stiff);
    }
    // length constraints, then keep the chain outside the body (two passes settle both)
    for (let pass = 0; pass < (colliders.length ? 2 : 1); pass++) {
      for (let i = 1; i <= L.length; i++) {
        const a = this.pts[i - 1];
        const b = this.pts[i];
        _v1.copy(b).sub(a);
        const d = _v1.length() || 1e-6;
        b.copy(a).addScaledVector(_v1, L[i - 1].len / d);
        for (const c of colliders) pushOut(b, c, this.meta.margin ?? 0.015);
      }
    }
    // 2. apply rotations
    for (let i = 0; i < L.length; i++) {
      const l = L[i];
      const parent = l.bone.parent!;
      parent.updateMatrixWorld(false);
      _m.copy(parent.matrixWorld).invert();
      const desired = _v1.copy(this.pts[i + 1]).applyMatrix4(_m).sub(l.bone.position);
      const restDir = _v2.copy(l.tailLocal).applyQuaternion(l.restQuat);
      if (desired.lengthSq() < 1e-10 || restDir.lengthSq() < 1e-10) continue;
      _q.setFromUnitVectors(restDir.normalize(), desired.normalize());
      l.bone.quaternion.copy(_q).multiply(l.restQuat);
      l.bone.updateMatrixWorld(true);
    }
  }
}
