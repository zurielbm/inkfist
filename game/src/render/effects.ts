import * as THREE from 'three';

export const BRUSH_FONT = '"Nanum Brush Script", "Noto Serif KR", serif';

interface Particle {
  obj: THREE.Object3D;
  mat: THREE.Material & { opacity: number };
  vel: THREE.Vector3;
  life: number;
  max: number;
  grow: number;
  baseScale: THREE.Vector3;
  gravity: number;
  spin: number;
  fadeIn: number;
  pop: number;
  floor: boolean;
  dispose: boolean;
  /** fraction of life after which the particle starts fading (default 0.55) */
  fadeAt?: number;
}

function canvasTex(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function proceduralSplat(seed: number): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  let r = seed * 9301 + 49297;
  const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(128, 128, 40 + rnd() * 20, 0, Math.PI * 2);
  g.fill();
  for (let i = 0; i < 18; i++) {
    const a = rnd() * Math.PI * 2;
    const d = 40 + rnd() * 80;
    g.beginPath();
    g.arc(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 3 + rnd() * 14, 0, Math.PI * 2);
    g.fill();
  }
  return canvasTex(c);
}

let dotTex: THREE.Texture | null = null;
function dot(): THREE.Texture {
  if (dotTex) return dotTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.7, 'rgba(255,255,255,0.9)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  dotTex = canvasTex(c);
  return dotTex;
}

export class Effects {
  group = new THREE.Group();
  parts: Particle[] = [];
  decals: { mesh: THREE.Mesh; age: number }[] = [];
  splats: THREE.Texture[];
  textCache = new Map<string, THREE.Texture>();
  rockGeo = new THREE.IcosahedronGeometry(0.06, 0);
  rockMat = new THREE.MeshBasicMaterial({ color: '#2a2824' });

  constructor(public tex: Record<string, THREE.Texture>) {
    this.splats = [0, 1, 2, 3].map((i) => tex[`splat_${i}`] ?? proceduralSplat(i + 1));
  }

  private add(obj: THREE.Object3D, mat: THREE.Material & { opacity: number }, o: Partial<Particle> & { life: number }): Particle {
    const p: Particle = {
      obj, mat, vel: o.vel ?? new THREE.Vector3(), life: o.life, max: o.life, grow: o.grow ?? 0,
      baseScale: obj.scale.clone(), gravity: o.gravity ?? 0, spin: o.spin ?? 0, fadeIn: o.fadeIn ?? 0, pop: o.pop ?? 0,
      floor: o.floor ?? false, dispose: o.dispose ?? false,
    };
    this.group.add(obj);
    this.parts.push(p);
    return p;
  }

  sprite(map: THREE.Texture, color: THREE.ColorRepresentation, size: number, pos: THREE.Vector3, opts: Partial<Particle> & { life: number; rot?: number; aspect?: number; onTop?: boolean }): Particle {
    const mat = new THREE.SpriteMaterial({ map, color, transparent: true, depthWrite: false, depthTest: !opts.onTop });
    mat.rotation = opts.rot ?? 0;
    const s = new THREE.Sprite(mat);
    s.position.copy(pos);
    s.scale.set(size * (opts.aspect ?? 1), size, 1);
    s.renderOrder = opts.onTop ? 50 : 10;
    return this.add(s, mat, { ...opts, dispose: true });
  }

  /** brush onomatopoeia */
  text(word: string, pos: THREE.Vector3, size: number, fill = '#1b1a17', rot = (Math.random() - 0.5) * 0.5): void {
    const key = word + fill;
    let t = this.textCache.get(key);
    if (!t) {
      const c = document.createElement('canvas');
      c.width = 768;
      c.height = 320;
      const g = c.getContext('2d')!;
      g.font = `220px ${BRUSH_FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.lineWidth = 26;
      g.strokeStyle = 'rgba(239,230,210,0.95)';
      g.strokeText(word, 384, 170);
      g.fillStyle = fill;
      g.fillText(word, 384, 170);
      t = canvasTex(c);
      this.textCache.set(key, t);
    }
    this.sprite(t, '#ffffff', size, pos, { life: 0.75, rot, aspect: 2.4, pop: 0.12, onTop: true, vel: new THREE.Vector3(0, 0.25, 0) });
  }

  hit(pos: THREE.Vector3, power: number, dir: number, crimson: boolean): void {
    const n = power >= 3 ? 3 : power >= 1 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const tex = this.splats[(Math.random() * this.splats.length) | 0];
      const size = (0.16 + power * 0.13 + Math.random() * 0.14) * (i === 0 ? 1.3 : 0.7);
      const p = pos.clone().add(new THREE.Vector3(dir * (0.1 + Math.random() * 0.35), (Math.random() - 0.4) * 0.4, 0.15));
      const col = crimson && i === 0 ? '#9c1f22' : '#1b1a17';
      this.sprite(tex, col, size, p, { life: 0.42 + power * 0.08, rot: Math.random() * 6.28, grow: 0.9, pop: 0.05 });
    }
    // droplets
    const drops = 3 + power * 5;
    for (let i = 0; i < drops; i++) {
      const v = new THREE.Vector3(dir * (1.5 + Math.random() * 4.5), Math.random() * 3.5 - 0.5, (Math.random() - 0.5) * 2);
      const col = crimson && Math.random() < 0.55 ? '#a3262a' : '#1b1a17';
      this.sprite(dot(), col, 0.03 + Math.random() * 0.06, pos.clone(), { life: 0.5 + Math.random() * 0.4, vel: v, gravity: 9 });
    }
  }

  ring(pos: THREE.Vector3, color: THREE.ColorRepresentation, size: number, life = 0.45): void {
    const t = this.tex.enso ?? this.splats[0];
    this.sprite(t, color, size * 0.4, pos, { life, grow: 4.5, rot: Math.random() * 6.28, onTop: false });
  }

  dust(pos: THREE.Vector3, amount = 1): void {
    const t = this.tex.mist ?? dot();
    for (let i = 0; i < 2 + amount * 2; i++) {
      const v = new THREE.Vector3((Math.random() - 0.5) * 2.2, 0.3 + Math.random() * 0.6, 0);
      this.sprite(t, '#cfc3a8', 0.5 + Math.random() * 0.6, pos.clone().add(new THREE.Vector3(0, 0.1, 0.2)), {
        life: 0.6 + Math.random() * 0.4, vel: v, grow: 1.2, aspect: 2.5,
      });
    }
  }

  streak(from: THREE.Vector3, dir: number, length = 1.6, color: THREE.ColorRepresentation = '#1b1a17'): void {
    const t = this.tex.brush_stroke ?? dot();
    const p = from.clone().add(new THREE.Vector3(-dir * length * 0.4, 0, -0.1));
    this.sprite(t, color, 0.32, p, { life: 0.35, aspect: (length / 0.32), rot: dir < 0 ? Math.PI : 0, grow: 0.2 });
  }

  debris(pos: THREE.Vector3, n: number): void {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(this.rockGeo, this.rockMat);
      const s = 0.5 + Math.random() * 1.2;
      m.scale.setScalar(s);
      m.position.copy(pos).add(new THREE.Vector3((Math.random() - 0.5) * 1.2, 0.05, (Math.random() - 0.5) * 0.6));
      m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      const v = new THREE.Vector3((Math.random() - 0.5) * 5, 2 + Math.random() * 5.5, -Math.random() * 1.6);
      const mat = this.rockMat as THREE.Material & { opacity: number };
      this.add(m, mat, { life: 1.1 + Math.random() * 0.6, vel: v, gravity: 14, spin: 8, floor: true });
    }
  }

  crater(x: number, big: boolean): void {
    const t = big ? this.tex.crater ?? this.tex.cracks : this.tex.cracks ?? this.tex.crater;
    if (!t) return;
    const size = big ? 3.4 : 2.2;
    const mat = new THREE.MeshBasicMaterial({ map: t, color: '#ffffff', transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    // the floor art is painted 3x stretched in depth to read correctly at the grazing camera angle; match it
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size * 2.8), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = Math.random() < 0.5 ? 0 : Math.PI;
    mesh.position.set(x, 0.012, 0.15);
    mesh.renderOrder = 2;
    this.group.add(mesh);
    this.decals.push({ mesh, age: 0 });
    if (this.decals.length > 8) {
      const d = this.decals.shift()!;
      this.group.remove(d.mesh);
      (d.mesh.material as THREE.Material).dispose();
      d.mesh.geometry.dispose();
    }
  }

  clear(): void {
    for (const p of this.parts) this.removePart(p);
    this.parts = [];
    for (const d of this.decals) {
      this.group.remove(d.mesh);
      (d.mesh.material as THREE.Material).dispose();
      d.mesh.geometry.dispose();
    }
    this.decals = [];
  }

  private removePart(p: Particle): void {
    this.group.remove(p.obj);
    if (p.dispose) p.mat.dispose();
  }

  update(dt: number): void {
    const keep: Particle[] = [];
    for (const p of this.parts) {
      p.life -= dt;
      if (p.life <= 0) {
        this.removePart(p);
        continue;
      }
      const age = p.max - p.life;
      p.vel.y -= p.gravity * dt;
      p.obj.position.addScaledVector(p.vel, dt);
      if (p.floor && p.obj.position.y < 0.03) {
        p.obj.position.y = 0.03;
        p.vel.y *= -0.3;
        p.vel.x *= 0.6;
      }
      if (p.spin) p.obj.rotation.x += p.spin * dt;
      let sc = 1 + p.grow * (age / p.max);
      if (p.pop > 0 && age < p.pop) sc *= 1 + 0.6 * (1 - age / p.pop);
      p.obj.scale.copy(p.baseScale).multiplyScalar(sc);
      const fadeStart = p.max * (p.fadeAt ?? 0.55);
      const a = p.life < p.max - fadeStart ? p.life / (p.max - fadeStart) : 1;
      if (p.dispose) p.mat.opacity = Math.max(0, Math.min(1, a));
      keep.push(p);
    }
    this.parts = keep;
    for (const d of this.decals) {
      d.age += dt;
      const m = d.mesh.material as THREE.MeshBasicMaterial;
      m.opacity = d.age < 7 ? Math.min(1, d.age * 12) : Math.max(0, 1 - (d.age - 7) / 3);
    }
  }
}
