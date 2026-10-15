import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CharAsset } from './assets';
import { InkUniforms, makeInkMaterial, makeOutlineMaterial } from './ink';
import { poseFor } from './animmap';
import { Capsule, SpringChain } from './chains';
import { Fighter, Match } from '../sim/sim';
import { ST, U } from '../sim/defs';

const YAW = Math.PI / 2 - 0.3;

let shadowTex: THREE.Texture | null = null;
function blobShadowTexture(): THREE.Texture {
  if (shadowTex) return shadowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grd.addColorStop(0, 'rgba(27,26,23,0.55)');
  grd.addColorStop(0.6, 'rgba(27,26,23,0.25)');
  grd.addColorStop(1, 'rgba(27,26,23,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  shadowTex = new THREE.CanvasTexture(c);
  shadowTex.colorSpace = THREE.SRGBColorSpace;
  return shadowTex;
}

export class FighterView {
  root = new THREE.Group();
  inner = new THREE.Group();
  model: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions = new Map<string, THREE.AnimationAction>();
  bones: Record<string, THREE.Bone> = {};
  chains: SpringChain[] = [];
  uni: InkUniforms;
  shadow: THREE.Mesh;
  cur: { name: string; action: THREE.AnimationAction } | null = null;
  prev: { name: string; action: THREE.AnimationAction } | null = null;
  switchFrame = 0;
  blendN = 0;
  flash = 0;
  flashColor = new THREE.Color(1, 1, 1);
  lastX = 0;
  lastY = 0;
  wind = 0;
  /** face meshes with expression morphs (+ their outline hulls, kept in sync) */
  faces: { mesh: THREE.Mesh; outline: THREE.Mesh }[] = [];
  expr: Record<string, number> = { blink: 0, glare: 0, pain: 0, shout: 0, smirk: 0 };
  blinkT = 90 + Math.random() * 120;
  /** body capsules the hair/cloth chains collide with (from meta.colliders) */
  capsules: { cap: Capsule; a: THREE.Bone; b: THREE.Bone | null; len: number }[] = [];

  constructor(public asset: CharAsset, outlinePx: { value: number }, res: { value: THREE.Vector2 }) {
    this.model = SkeletonUtils.clone(asset.gltf.scene);
    this.uni = {
      uFlash: { value: new THREE.Vector4(1, 1, 1, 0) },
      uRim: { value: 0.55 },
      uTint: { value: new THREE.Vector4(0.7, 0.05, 0.04, 0) },
    };
    const outlineMats = new Map<boolean, THREE.ShaderMaterial>();
    const outlineFor = (attr: boolean) => {
      let m = outlineMats.get(attr);
      if (!m) outlineMats.set(attr, (m = makeOutlineMaterial(outlinePx, res, undefined, attr)));
      return m;
    };
    const inkCache = new Map<THREE.Material, THREE.MeshToonMaterial>();
    const meshes: THREE.SkinnedMesh[] = [];
    this.model.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.bones[o.name] = o as THREE.Bone;
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh);
    });
    for (const mesh of meshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const ink = mats.map((m) => {
        let im = inkCache.get(m);
        if (!im) inkCache.set(m, (im = makeInkMaterial(m, this.uni)));
        return im;
      });
      mesh.material = Array.isArray(mesh.material) ? ink : ink[0];
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      const outline = new THREE.SkinnedMesh(mesh.geometry, outlineFor(!!mesh.geometry.attributes._outline));
      outline.bind(mesh.skeleton, mesh.bindMatrix);
      outline.frustumCulled = false;
      outline.renderOrder = -1;
      mesh.parent!.add(outline);
      if (mesh.morphTargetDictionary && 'blink' in mesh.morphTargetDictionary) this.faces.push({ mesh, outline });
    }
    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of asset.gltf.animations) {
      const a = this.mixer.clipAction(clip);
      a.setLoop(THREE.LoopRepeat, Infinity);
      a.clampWhenFinished = true;
      this.actions.set(clip.name, a);
    }
    this.inner.rotation.y = YAW;
    this.inner.add(this.model);
    this.root.add(this.inner);
    this.model.updateMatrixWorld(true);
    for (const cm of asset.meta.chains) this.chains.push(new SpringChain(cm, this.bones, this.root));
    for (const c of asset.meta.colliders ?? []) {
      const a = this.bones[c.bone];
      if (!a) continue;
      const b = c.to ? this.bones[c.to] ?? null : null;
      this.capsules.push({ cap: { a: new THREE.Vector3(), b: new THREE.Vector3(), r: c.radius }, a, b, len: c.length ?? 0.2 });
    }
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.3, 0.55),
      new THREE.MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 1;
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.root);
    scene.add(this.shadow);
  }

  removeFrom(scene: THREE.Scene): void {
    scene.remove(this.root);
    scene.remove(this.shadow);
  }

  resetChains(): void {
    for (const c of this.chains) c.reset();
  }

  hitFlash(color: THREE.ColorRepresentation, frames = 3): void {
    this.flashColor.set(color);
    this.flash = frames;
  }

  update(f: Fighter, s: Match, dt: number, simAdvanced: boolean): void {
    // transform
    let x = f.x / U;
    let y = f.y / U;
    if (f.hitstop > 0 && (f.st === ST.HITSTUN || f.st === ST.AIR_HIT || f.st === ST.GUARD_STUN || f.st === ST.CRUMPLE)) {
      x += (Math.random() - 0.5) * 0.05;
    }
    if (Math.abs(x - this.lastX) > 2.5) this.resetChains();
    this.lastX = x;
    this.lastY = y;
    this.root.position.set(x, y, 0);
    this.root.scale.x = f.facing;
    this.shadow.position.set(f.x / U, 0.006, 0.05);
    const sh = Math.max(0.35, 1 - y * 0.35);
    this.shadow.scale.set(sh, sh, sh);

    // animation
    const p = poseFor(f, s, this.asset.meta.clips);
    let name = p.clip;
    if (!this.actions.has(name)) name = this.actions.has('idle') ? 'idle' : [...this.actions.keys()][0];
    if (!this.cur || this.cur.name !== name) {
      if (this.prev) this.prev.action.stop();
      this.prev = this.cur;
      const action = this.actions.get(name)!;
      action.reset();
      action.play();
      this.cur = { name, action };
      this.switchFrame = s.frame;
      this.blendN = p.blend;
    }
    const dur = this.cur.action.getClip().duration;
    this.cur.action.time = Math.min(Math.max(0, p.t / 60), Math.max(0, dur - 1e-4));
    const elapsed = s.frame - this.switchFrame;
    if (this.prev && elapsed < this.blendN) {
      const w = (elapsed + 1) / (this.blendN + 1);
      this.cur.action.setEffectiveWeight(w);
      this.prev.action.setEffectiveWeight(1 - w);
    } else {
      if (this.prev) {
        this.prev.action.stop();
        this.prev = null;
      }
      this.cur.action.setEffectiveWeight(1);
    }
    this.mixer.update(0);

    // ink flashes / tints
    if (simAdvanced && this.flash > 0) this.flash--;
    const fl = this.uni.uFlash.value;
    fl.set(this.flashColor.r, this.flashColor.g, this.flashColor.b, this.flash > 0 ? 0.85 : 0);
    const tint = this.uni.uTint.value;
    if (f.st === ST.FOCUS_CHARGE) {
      const pulse = 0.35 + 0.25 * Math.sin(s.frame * 0.5);
      tint.set(0.75, 0.05, 0.04, pulse);
    } else if (f.st === ST.STAGGER || f.st === ST.CRUMPLE) {
      tint.set(0.5, 0.5, 0.55, 0.25);
    } else {
      tint.w = Math.max(0, tint.w - dt * 4);
    }

    this.updateExpression(f, dt);

    // secondary motion
    this.root.updateMatrixWorld(true);
    this.wind = 0.6 * Math.sin(performance.now() * 0.0011) + 0.3 * Math.sin(performance.now() * 0.0037);
    this.updateCapsules();
    const caps = this.capsules.map((c) => c.cap);
    for (const c of this.chains) c.update(dt, this.wind, caps);
  }

  /** Refresh body capsules from the posed skeleton (world space). */
  updateCapsules(): void {
    for (const c of this.capsules) {
      c.a.getWorldPosition(c.cap.a);
      if (c.b) c.b.getWorldPosition(c.cap.b);
      else c.cap.b.set(0, c.len, 0).applyMatrix4(c.a.matrixWorld);
    }
  }

  /** Facial expression from the fighter's state: kiai on attack startup, pain when hit, glare in guard/focus,
   * a smirk when winning, eyes shut when down, plus natural blinking. */
  private updateExpression(f: Fighter, dt: number): void {
    if (!this.faces.length) return;
    const tgt: Record<string, number> = { blink: 0, glare: 0.25, pain: 0, shout: 0, smirk: 0 };
    switch (f.st) {
      case ST.ATTACK:
      case ST.FOCUS_CHARGE:
      case ST.BURST:
        tgt.shout = 0.85;
        tgt.glare = 0.6;
        break;
      case ST.GUARD:
      case ST.GUARD_STUN:
      case ST.DEFLECT:
      case ST.DEFLECT_WHIFF:
      case ST.DASH_F:
      case ST.AIRDASH:
        tgt.glare = 1;
        break;
      case ST.HITSTUN:
      case ST.AIR_HIT:
      case ST.STAGGER:
      case ST.CRUMPLE:
      case ST.WALL:
      case ST.THROWN:
      case ST.CINE_VICTIM:
        tgt.pain = 1;
        tgt.glare = 0;
        break;
      case ST.KNOCKDOWN:
      case ST.DOWN:
      case ST.KO:
        tgt.pain = 0.35;
        tgt.blink = 1;
        tgt.glare = 0;
        break;
      case ST.WIN:
      case ST.INTRO:
        tgt.smirk = 1;
        tgt.glare = 0.3;
        break;
    }
    const k = Math.min(1, dt * 60);
    this.blinkT -= k;
    if (this.blinkT < 0) {
      if (this.blinkT < -7) this.blinkT = 100 + Math.random() * 160;
      else if (tgt.blink < 0.5 && tgt.pain < 0.5) tgt.blink = 1;
    }
    for (const key of Object.keys(this.expr)) {
      const rate = key === 'blink' ? 0.6 : key === 'shout' || key === 'pain' ? 0.35 : 0.15;
      this.expr[key] += (tgt[key] - this.expr[key]) * Math.min(1, rate * k);
    }
    for (const { mesh, outline } of this.faces) {
      const dict = mesh.morphTargetDictionary!;
      const infl = mesh.morphTargetInfluences!;
      for (const key of Object.keys(this.expr)) {
        const i = dict[key];
        if (i !== undefined) infl[i] = this.expr[key];
      }
      if (outline.morphTargetInfluences) outline.morphTargetInfluences.splice(0, infl.length, ...infl);
    }
  }

  /** world position of a bone (for effects) */
  bonePos(name: string, out: THREE.Vector3): THREE.Vector3 {
    const b = this.bones[name];
    if (!b) return out.copy(this.root.position).setY(this.root.position.y + 1.2);
    return b.getWorldPosition(out);
  }
}
